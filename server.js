const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const app = express();

// Railway opera atrás de proxy reverso. trust proxy faz Express respeitar
// X-Forwarded-For e devolver o IP real do cliente em req.ip
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
// Auth dos endpoints /api/* — pelo menos UM destes precisa estar configurado
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
// URL do microserviço de Previsão Orçamentária (FastAPI). Em prod, setar via
// Railway ENV apontando para a URL interna do serviço previsao-api.
const PREVISAO_API_URL = process.env.PREVISAO_API_URL || 'http://localhost:8000';
// URL do microservico de geracao de PPTX/PDF (previsao-pdf FastAPI). Em prod, setar via
// Railway ENV apontando para a URL interna do servico. Opcional: sem ela o endpoint /gerar-pdf retorna 503.
const PREVISAO_PDF_API_URL = process.env.PREVISAO_PDF_API_URL || '';
// URL do microservico de prestacao de contas (prestacao-pdf FastAPI). Opcional:
// sem ela o endpoint /api/prestacao/gerar-deck retorna 503 e o Hub usa o
// fallback offline (PptxGenJS no browser).
const PRESTACAO_PDF_API_URL = process.env.PRESTACAO_PDF_API_URL || '';
// Origens permitidas (separadas por vírgula). Se vazio, qualquer origem passa
// (dev mode). Em prod, setar pra "https://service-hub-production.up.railway.app"
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────
// CORS — restringe quem pode chamar /api/*
// ─────────────────────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

// ─────────────────────────────────────────────────────────────────────────
// Rate-limit em memória — 60 req/min por IP nos endpoints /api/*
// Implementação minimalista sem dependências externas. Map<ip, {count, resetAt}>.
// Cleanup a cada 5min remove buckets expirados.
// ─────────────────────────────────────────────────────────────────────────
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '60', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const rateBuckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (bucket.resetAt < now) rateBuckets.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX - bucket.count)));
  res.setHeader('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));
  if (bucket.count > RATE_LIMIT_MAX) {
    res.status(429).json({ erro: 'rate_limit_exceeded', retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) });
    return;
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────
// Auth middleware — aceita Bearer JWT Supabase (ES256/JWKS) OU Bearer INTERNAL_API_SECRET
//
// JWT do Supabase é ES256 (ECDSA P-256, signing key assimétrica).
// Public key vem do JWKS público em /auth/v1/.well-known/jwks.json (cache 1h,
// refresh on miss pra suportar key rotation). crypto.verify nativo + dsaEncoding
// 'ieee-p1363' aceita raw r||s do JWT direto, zero deps externas.
//
// SUPABASE_JWT_SECRET (HS256 legacy) NÃO é mais usado — a ENV pode ficar setada
// no Railway, é simplesmente ignorada agora. Remover em sessão futura.
//
// Sem INTERNAL_API_SECRET nem SUPABASE_URL: rejeita tudo (fail-safe).
// ─────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
// Service role key: necessária pras rotas /api/admin/usuarios/*. Sem ela essas
// rotas devolvem 503. Setar via `railway variables --set SUPABASE_SERVICE_ROLE_KEY=$VAR`
// (NUNCA expor no frontend nem em commit — guarda valores em ENV apenas).
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
// Whitelist de project refs Supabase considerados ambiente dev (usado pra liberar
// /api/admin/seed-dev e expor `ambiente: 'dev'` em /api/config). Adicionar refs de
// staging aqui se aparecerem.
const DEV_SUPABASE_REFS = ['ledgyprytkuvgtbunsck'];
function isSupabaseDev() {
  return DEV_SUPABASE_REFS.some(ref => SUPABASE_URL.includes(ref));
}

let JWKS_CACHE = { keys: [], fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

function base64UrlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function fetchJwks() {
  return new Promise((resolve) => {
    if (!SUPABASE_URL) return resolve([]);
    const url = new URL(SUPABASE_URL + '/auth/v1/.well-known/jwks.json');
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {}
    };
    const r = https.request(opts, (resp) => {
      let d = '';
      resp.on('data', (c) => d += c);
      resp.on('end', () => {
        try { resolve((JSON.parse(d).keys) || []); }
        catch { resolve([]); }
      });
    });
    r.on('error', () => resolve([]));
    r.end();
  });
}

async function getJwk(kid) {
  const fresh = Date.now() - JWKS_CACHE.fetchedAt < JWKS_TTL_MS;
  let key = fresh ? JWKS_CACHE.keys.find(k => k.kid === kid) : null;
  if (key) return key;
  // Refresh on cache miss/expiry — suporta key rotation
  const keys = await fetchJwks();
  if (keys.length) JWKS_CACHE = { keys, fetchedAt: Date.now() };
  return JWKS_CACHE.keys.find(k => k.kid === kid) || null;
}

async function verifySupabaseJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h64, p64, s64] = parts;

  let header, payload;
  try {
    header = JSON.parse(base64UrlDecode(h64).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(p64).toString('utf8'));
  } catch { return null; }

  if (header.alg !== 'ES256') return null;
  if (!header.kid) return null;

  const jwk = await getJwk(header.kid);
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;

  let pubKey;
  try {
    pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch { return null; }

  // 'ieee-p1363' aceita o raw r||s do JWT direto, sem precisar converter pra DER.
  // Suportado desde Node 16.
  const ok = crypto.verify(
    'SHA256',
    Buffer.from(`${h64}.${p64}`),
    { key: pubKey, dsaEncoding: 'ieee-p1363' },
    base64UrlDecode(s64)
  );
  if (!ok) return null;

  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (payload.role !== 'authenticated') return null;

  return payload;
}

// Extrai role do payload JWT (app_metadata.role injetado pelo trigger sync_role_to_metadata).
// Fallback OPERACIONAL pra users sem profile (não deveria acontecer em prod por causa do
// handle_new_user, mas é safety net).
function getRoleFromPayload(payload) {
  return payload?.app_metadata?.role || 'OPERACIONAL';
}

// Middleware: 403 se user não for GESTOR. Aplicar SEMPRE depois de requireAuth.
function requireGestor(req, res, next) {
  // INTERNAL_API_SECRET é tratado como acesso total (uso interno/scripts), bypassa role check
  if (req.authMode === 'internal') return next();
  if (getRoleFromPayload(req.user) !== 'GESTOR') {
    return res.status(403).json({ erro: 'acesso_negado', role_necessario: 'GESTOR' });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!INTERNAL_API_SECRET && !SUPABASE_URL) {
    res.status(503).json({ erro: 'auth_nao_configurada', detalhe: 'INTERNAL_API_SECRET ou SUPABASE_URL ausente no servidor' });
    return;
  }
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ erro: 'auth_obrigatoria' });
    return;
  }
  const token = auth.slice(7).trim();
  // 1. Tentar como INTERNAL_API_SECRET (comparação timing-safe)
  if (INTERNAL_API_SECRET && token.length === INTERNAL_API_SECRET.length) {
    const a = Buffer.from(token);
    const b = Buffer.from(INTERNAL_API_SECRET);
    if (crypto.timingSafeEqual(a, b)) { req.authMode = 'internal'; return next(); }
  }
  // 2. Tentar como Supabase JWT ES256 (async — usa JWKS)
  if (SUPABASE_URL) {
    verifySupabaseJwt(token).then((payload) => {
      if (payload) { req.user = payload; req.authMode = 'supabase'; return next(); }
      res.status(401).json({ erro: 'token_invalido' });
    }).catch(() => res.status(401).json({ erro: 'token_invalido' }));
    return;
  }
  res.status(401).json({ erro: 'token_invalido' });
}

// index: false impede que o express.static sirva index.html automaticamente para "/"
// assim as rotas explícitas abaixo controlam o que aparece em cada caminho
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Aplica rate-limit + auth em todos os /api/* (exceto /api/config que é público)
app.use('/api', rateLimit);

// ─────────────────────────────────────────────────────────────────────────
// /api/config — público (não precisa auth). Devolve ENVs públicas pro frontend.
// Frontend usa pra inicializar o client Supabase sem hardcodar a key no HTML.
// ─────────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    // 'dev' habilita botão "Reset dados de teste" no frontend (visível só pra GESTOR).
    // Em prod, fica 'producao' e o botão não é renderizado.
    ambiente: isSupabaseDev() ? 'dev' : 'producao'
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Proxies AssemblyAI — protegidos por requireAuth
// ─────────────────────────────────────────────────────────────────────────
// Upload de áudio em STREAMING (sem express.raw). Encaminha os bytes direto pro
// AssemblyAI conforme chegam do navegador, SEM carregar o arquivo na RAM. Antes,
// express.raw bufferizava o arquivo inteiro e pr.write(req.body) copiava de novo
// (~2x o tamanho na memória): um m4a de 187MB dava ~375MB de pico, estourava a RAM
// do container (OOM), o container caía e o navegador via 502. Com req.pipe o uso de
// memória é constante, independente do tamanho do arquivo. Content-Length repassado
// do request original; timeout explícito + erro claro no lugar do 502 mudo.
app.post('/api/assemblyai/upload', requireAuth, (req, res) => {
  const len = req.headers['content-length'];
  const opts = {
    hostname: 'api.assemblyai.com', path: '/v2/upload', method: 'POST',
    headers: Object.assign(
      { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream' },
      len ? { 'content-length': len } : { 'transfer-encoding': 'chunked' }
    ),
    timeout: 300000 // 5min: uploads grandes precisam de folga
  };
  const pr = https.request(opts, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      const d = Buffer.concat(chunks).toString('utf8');
      try { res.json(JSON.parse(d)); }
      catch (e) { if (!res.headersSent) res.status(502).json({ error: 'resposta inválida do AssemblyAI no upload', detalhe: d.slice(0, 300) }); }
    });
  });
  pr.on('error', (e) => { if (!res.headersSent) res.status(502).json({ error: 'falha ao enviar o áudio ao AssemblyAI', detalhe: e.message }); });
  pr.on('timeout', () => { pr.destroy(); if (!res.headersSent) res.status(504).json({ error: 'timeout no upload ao AssemblyAI (5 min)' }); });
  req.on('aborted', () => pr.destroy()); // cliente cancelou: corta o envio ao AssemblyAI
  req.pipe(pr);
});

app.post('/api/assemblyai/transcript', requireAuth, express.json(), (req, res) => {
  const body = JSON.stringify(req.body);
  const opts = { hostname:'api.assemblyai.com', path:'/v2/transcript', method:'POST', headers:{'authorization':ASSEMBLYAI_KEY,'content-type':'application/json','content-length':Buffer.byteLength(body)} };
  const pr = https.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res.json(JSON.parse(d))}catch(e){res.status(500).json({error:d})} }); });
  pr.on('error', e => res.status(500).json({error:e.message}));
  pr.write(body); pr.end();
});

app.get('/api/assemblyai/transcript/:id', requireAuth, (req, res) => {
  const opts = { hostname:'api.assemblyai.com', path:'/v2/transcript/'+req.params.id, method:'GET', headers:{'authorization':ASSEMBLYAI_KEY} };
  const pr = https.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res.json(JSON.parse(d))}catch(e){res.status(500).json({error:d})} }); });
  pr.on('error', e => res.status(500).json({error:e.message}));
  pr.end();
});

// ─────────────────────────────────────────────────────────────────────────
// Proxy Anthropic — protegido por requireAuth
// ─────────────────────────────────────────────────────────────────────────
app.post('/api/claude/messages', requireAuth, express.json({limit:'10mb'}), (req, res) => {
  if (!ANTHROPIC_KEY) { res.status(500).json({error:'ANTHROPIC_KEY ausente no servidor'}); return; }
  const body = JSON.stringify(req.body);
  const opts = { hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', headers:{'x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','content-type':'application/json','content-length':Buffer.byteLength(body)} };
  const pr = https.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res.status(r.statusCode).json(JSON.parse(d))}catch(e){res.status(500).json({error:d})} }); });
  pr.on('error', e => res.status(500).json({error:e.message}));
  pr.write(body); pr.end();
});

// ─────────────────────────────────────────────────────────────────────────
// Engine de geração de ata — SÓ Sonnet 4.6 (sem Opus, sem cascata por validação)
//
// Pipeline (teto HARD de 3 chamadas Anthropic por geração, ver MAX_CHAMADAS_ANTHROPIC_POR_ATA):
//   1. Sonnet 4.6 + max_tokens 16000 → se retornou texto, ENTREGA (validação é só aviso)
//   2. Só se a API NÃO retornou texto (rede/timeout): 1 retry Sonnet 4.6 + 20000
//   3. Auditoria de fidelidade (Sonnet 4.6) na ata entregue
// NUNCA há fallback Opus. Validação nunca dispara retry (ver REGRA DE OURO no motor).
//
// System prompt = SKILL.md integral + contexto fixo Grupo Service + regras anti-erro.
// SKILL.md carregada no boot e mantida em memória.
//
// Refs: CORRECAO_SERVICE_HUB_ATAS.md (handoff Matheus)
// ─────────────────────────────────────────────────────────────────────────
let ATA_SKILL_MD = '';
try {
  ATA_SKILL_MD = fs.readFileSync(path.join(__dirname, 'skills-server', 'ata-condominial.md'), 'utf8');
  console.log('SKILL ata-condominial carregada (' + ATA_SKILL_MD.length + ' chars)');
} catch (e) {
  console.warn('SKILL ata-condominial NÃO carregada: ' + e.message);
}

// Glossario de dominio condominial: corrige erros foneticos da transcricao (Whisper
// erra termos tecnicos). Entra no system prompt junto com a skill. So padroniza
// grafia de termo ouvido errado; NUNCA autoriza inventar conteudo (anti-invencao).
let GLOSSARIO_MD = '';
try {
  GLOSSARIO_MD = fs.readFileSync(path.join(__dirname, 'skills-server', 'glossario-condominial.md'), 'utf8');
  console.log('Glossario condominial carregado (' + GLOSSARIO_MD.length + ' chars)');
} catch (e) {
  console.warn('Glossario condominial NÃO carregado: ' + e.message);
}

const CONTEXTO_GRUPO_SERVICE = `CONTEXTO FIXO DO GRUPO SERVICE

Administradora: Condomínio Service

Cidades onde a administradora atua:
Vitória/ES, Serra/ES, Vila Velha/ES, Cariacica/ES, Viana/ES, Guarapari/ES

Mapeamento bairro para cidade (quando o condomínio não declara cidade):
- Manguinhos, Jacaraípe, Nova Almeida, Carapina, Laranjeiras: Serra/ES
- Praia do Canto, Jardim Camburi, Mata da Praia, Jardim da Penha, Enseada do Suá: Vitória/ES
- Praia da Costa, Itapuã, Itaparica, Coqueiral: Vila Velha/ES

Quando o bairro for identificável pela lista, preencher cidade/UF automaticamente.
Não usar [a confirmar] nesses casos.

Tratamento padrão: Sr. ou Sra. + primeiro nome conhecido.
Se faltar sobrenome: usar [sobrenome a confirmar].`;

const REGRAS_ANTI_ERRO = `REGRAS ANTI-ERRO NA REDAÇÃO DA ATA

1. CORREÇÕES VERBAIS DA TRANSCRIÇÃO
Quando há correção em voz alta ("desculpa, é X", "na verdade Y", "errei, são Z votos"),
PREVALECE o valor corrigido, NUNCA o primeiro.

2. FIDELIDADE AO EDITAL
Datas, valores, prazos e nomes do edital são LITERAIS. Nunca ajustar mesmo que
pareçam inconsistentes. Se o edital diz mandato de 1º/jul/2026 a 30/jul/2027,
registrar exatamente assim, mesmo que não feche 12 meses redondos.

3. NOMES PRÓPRIOS
NUNCA expandir apelidos em nomes completos.
- Dani NÃO É Daniel
- Cris NÃO É Cristina nem Cristiano
- Bel NÃO É Isabel
Preservar o nome exatamente como aparece na transcrição.

4. GÊNERO
NUNCA atribuir Sr. ou Sra. por palpite linguístico.
Aplicação consistente em TODAS as menções (corpo do texto E bloco de assinaturas):

(a) Gênero explícito na transcrição (presença de pronomes/artigos diretos sem
    ambiguidade, ex: "ela", "a candidata") → usar Sr. ou Sra.
(b) Apenas contexto fraco (nome aparentemente feminino/masculino, sem confirmação
    explícita) → usar "[Sra. a confirmar]" ou "[Sr. a confirmar]" + Nome
(c) Sem nenhuma pista → usar "[Sr./Sra. a confirmar]" + Nome

Exemplo real Happy Days: Dari e Dani não têm gênero confirmado por pronome explícito
na transcrição. Mesmo que o nome "pareça" feminino, escrever:
- No corpo: "[Sra. a confirmar] Dari recebeu dezenove (19) votos"
- Na assinatura: "Conselheira titular da Torre 1 – [Sra. a confirmar] Dari [sobrenome a confirmar]"

NÃO escrever "Sra. Dari" como se fosse fato confirmado. NÃO omitir o tratamento. A
marca "[Sra./Sr. a confirmar]" sinaliza ao usuário que o gênero precisa ser validado.

5. ANTI-INVENÇÃO
Não inventar fatos para preencher lacunas. Se a transcrição não confirma um evento
(ex: "a primeira convocação não atingiu quórum"), NÃO escrever esse evento.
Usar [a confirmar] ou simplesmente omitir.

6. BLOCO DE ASSINATURAS
Uma linha INDIVIDUAL para cada assinante.
Formato: Cargo – Tratamento Nome
NUNCA agrupar dois assinantes na mesma linha.
O bloco precisa estar COMPLETO até o fim do documento (sem truncar).

7. SAÍDA PURA — NENHUMA PALAVRA FORA DA ATA
A resposta deve começar IMEDIATAMENTE com o cabeçalho da ata (nome do condomínio em
CAIXA ALTA, seguido de CNPJ e endereço). Não escrever "Aqui está a ata", "Vou processar",
"Mapeamento", "Análise", "Reconstituindo", tabelas de dados extraídos, observações
finais nem qualquer comentário do modelo. Também NÃO usar separadores horizontais
(---, ___, ===) em hipótese alguma. Saída = APENAS o documento final, do cabeçalho à
última assinatura. Se precisar pensar, faça internamente sem materializar.

8. SEM MARKDOWN — DOCUMENTO É PROSA PURA
PROIBIDO **negrito**, *itálico*, # headers, > blockquote, \`código\`, listas com -, *, +,
tabelas com | colunas |, ou QUALQUER sintaxe de markdown. O documento será renderizado
como PDF a partir de texto plano. CAIXA ALTA substitui negrito quando precisar destacar
(ex: "ATA DA ASSEMBLEIA GERAL ORDINÁRIA", "ITEM  1)  TÍTULO:"). Subitens internos
usam (i), (ii), (iii) dentro da prosa.

9. REGISTRO DE VOTAÇÕES INDIVIDUAIS
Quando a transcrição contém contagem de votos por candidato, REGISTRAR cada candidato
com seu número de votos exato.
- Não omitir nomes que receberam votos mesmo que não tenham sido eleitos
- Não arredondar nem agrupar contagens
- Formato em prosa formal: "[Nome], com [N por extenso] ([N]) votos"
- Aplica-se a eleições de síndico, subsíndico, conselheiros e qualquer outra votação
  nominal individual da assembleia

ATENÇÃO À CORREÇÃO DE ATRIBUIÇÃO DE NOMES NA APURAÇÃO:
Quando o speaker conta votos, atribui ao nome errado, percebe o engano, corrige a
atribuição e em seguida recomeça uma NOVA contagem para o outro candidato — isso
é DUAS contagens distintas para DUAS pessoas diferentes, NÃO uma contagem única.

Exemplo real desta administradora (Happy Days 18/05/2026):
Transcrição: "1, 2, ... 19 pra Dani. É Dari, desculpa. 1, 2, ... 21 para Dani."

Leitura correta:
(a) "19 pra Dani" — o contador atribuiu 19 votos a "Dani" por engano.
(b) "É Dari, desculpa" — correção da ATRIBUIÇÃO: esses 19 votos eram da Dari, não da
    Dani.
(c) "1, 2, ... 21 para Dani" — NOVA contagem, agora corretamente para Dani, totalizando
    21 votos.

Resultado: Dari = 19 votos, Dani = 21 votos. São DUAS pessoas distintas (Dari é
candidata da Torre 1, Dani da Torre 2 — confirmação adiante na transcrição:
"Torre 1 — Dari. Dani Torre 2, Presidente.").

Regra de ouro: a frase "é X, desculpa" corrige a ATRIBUIÇÃO do número anterior (esse
número vai para X), e a contagem subsequente é uma NOVA apuração para o nome
mencionado em seguida. Preservar AMBOS os candidatos com seus respectivos números.

10. NÃO REPLICAR NÚMEROS DE VOTOS ENTRE CANDIDATOS
Quando a transcrição confirma EXPLICITAMENTE o número de votos de UM candidato, NÃO
usar o mesmo número para outro candidato sem confirmação explícita na transcrição.

Regra de ouro: se um número está explícito apenas para o candidato X, atribuir esse
mesmo número também ao candidato Y é INVENTAR — viola a regra 5 (anti-invenção).
Quando não houver número explícito para um candidato, registrar APENAS a eleição e
marcar "[número de votos a confirmar]" — nunca repetir o número de outro candidato
como chute. Por outro lado, quando a transcrição confirma números DIFERENTES para
candidatos diferentes (ex: Dari 19 e Dani 21), registrar AMBOS literalmente.`;

// Regras de fidelidade factual à transcrição (Tarefa ata-fidelidade-v3).
// Vêm DEPOIS das regras anti-erro no system prompt para ganhar precedência por ordem.
// Alvo: corrigir invenção de números, completamento por palpite e fatos omitidos
// identificados nos testes Happy Days Manguinhos e Lara Hoffman.
// Detalhamento máximo obrigatório (opção "a", 2026-07-07). Força a ata a reproduzir a
// decomposição item a item que a fala trouxe, em QUALQUER item, em vez de condensar em
// prosa resumida. Vem ANTES das regras de fidelidade de propósito: FID fica por último
// e mantém a palavra final (anti-invenção), e a DET 3 abaixo defere explicitamente a FID.
const REGRAS_DETALHAMENTO_MAXIMO = `DETALHAMENTO MÁXIMO OBRIGATÓRIO

Esta ata é documento formal. A prioridade absoluta é COMPLETUDE e RIQUEZA FACTUAL, não concisão. NÃO resumir, NÃO sintetizar, NÃO condensar, NÃO omitir nenhum detalhe presente na fonte (transcrição e edital). Vale para QUALQUER item de QUALQUER ata, não só prestação de contas.

DET 1. DECOMPOSIÇÃO ITEM A ITEM OBRIGATÓRIA. Todo item de pauta que contenha enumeração de despesas, receitas, categorias de custo, rubricas, propostas, orçamentos, candidatos, chapas ou votações deve ser DECOMPOSTO item a item, no formato (i), (ii), (iii)... dentro da prosa corrida, com: (a) cada categoria ou rubrica nomeada explicitamente; (b) TODOS os valores monetários no padrão R$ X.XXX,XX; (c) TODAS as justificativas, esclarecimentos e observações ditos, registrados. Se a fala detalhou N categorias, a ata registra as N categorias, uma a uma. Exemplo: numa prestação de contas cuja fala discrimina mão de obra, consumo, despesas financeiras, materiais, serviços, despesas administrativas, manutenção e investimento, a ata registra cada uma dessas rubricas com o respectivo valor, JAMAIS um total condensado ou uma frase-resumo.

DET 2. NUNCA CONDENSAR O QUE FOI DETALHADO NA FALA. Se a transcrição traz a decomposição (categoria por categoria, valor por valor, nome por nome), a ata reproduz a decomposição COMPLETA. É PROIBIDO substituir uma lista detalhada por uma frase-resumo do tipo "as despesas do período foram apresentadas por categoria" ou "foram detalhados os valores". Reproduza a lista.

DET 3. DETALHAR NÃO É INVENTAR. Detalhamento máximo significa NÃO DESCARTAR o que existe na fonte; NUNCA significa criar dado que a fonte não traz. As REGRAS DE FIDELIDADE abaixo (FID) e a anti-invenção continuam ABSOLUTAS e têm precedência: o que não estiver claro na transcrição vira [a confirmar]. A ordem é: detalhar por completo o que existe na fonte, e marcar com [a confirmar] só o que falta ou está incerto.

DET 4. ITEM DA PAUTA SEM CONTEÚDO NA FALA: REGISTRO SECO, SEM COMENTAR A GRAVAÇÃO. Se um item constava do edital mas a transcrição NÃO traz apresentação nem debate sobre ele, registrar de forma SECA e curta, por exemplo "Item não deliberado nesta assembleia." ou os dados do item como [a confirmar]. É TERMINANTEMENTE PROIBIDO, aqui como em qualquer item, escrever no corpo da ata comentário sobre a transcrição, a gravação ou o processo de redação (ex.: "não houve registro na transcrição", "o tema não foi tratado no áudio", "a informação pode ter sido prestada antes do início da gravação"). Isso repete e reforça a FID 6 abaixo: o detalhamento máximo vale SOMENTE para os itens que TÊM conteúdo na fonte; para item sem conteúdo, registro seco e limpo, nunca uma explicação sobre o que faltou na gravação.`;

const REGRAS_FIDELIDADE_TRANSCRICAO = `REGRAS DE FIDELIDADE FACTUAL À TRANSCRIÇÃO

Estas regras têm PRIORIDADE MÁXIMA sobre fluência e completude. A ata deve ser fiel ao que a transcrição sustenta, mesmo à custa de um documento com várias marcações [a confirmar]. Prefira a ata "incompleta mas correta" à ata "fluente mas inventada".

FID 1. NUNCA INVENTAR, COMPLETAR OU ADIVINHAR
Qualquer fato que não esteja explicitamente na transcrição (ou em outra fonte oficial anexada, como edital) precisa ir como [a confirmar] no lugar exato do dado. Isso inclui nomes próprios, sobrenomes, números de votos, valores em reais, datas, números de unidade, cargos, quantidades de parcelas, percentuais e qualquer outro dado pontual. É PROIBIDO substituir uma lacuna por palpite plausível, mesmo que pareça óbvio pelo contexto. Quando o contexto sugere algo mas a transcrição não confirma, registre [a confirmar] e nada além.

FID 2. NÚMEROS SÃO LITERAIS
Todo número (valor financeiro, quantidade de votos, percentual, número de parcelas, anos, datas) deve ser transcrito exatamente como aparece na transcrição. É PROIBIDO recalcular, arredondar, somar, inferir ou ajustar qualquer número. Se um número aparece de forma ambígua, conflitante ou parcial na transcrição, NÃO registrar as versões conflitantes nem explicar a divergência dentro da ata: escrever apenas o marcador limpo [valor a confirmar] (ou [número a confirmar]) no lugar do dado. Se a transcrição não diz o número, escrever [valor a confirmar] e nada mais.

FID 3. NOMES PRÓPRIOS NÃO SÃO COMPLETADOS
Se a pessoa é citada apenas pelo primeiro nome, registrar apenas o primeiro nome seguido de [sobrenome a confirmar]. Se há dúvida entre nome civil e apelido (caso real: a transcrição menciona alguém ora como "Wellington", ora como "Eriton"), registrar AMBOS na forma "Wellington (Eriton)" sem escolher um. Nunca completar "Cris" para "Cristina" ou "Cristiano". Nunca substituir o apelido pelo suposto nome civil sem confirmação explícita.

FID 4. VARREDURA PRÉ FECHAMENTO
Antes de finalizar a ata, varrer a transcrição inteira item por item e garantir que nenhum fato relevante foi omitido. Atenção especial obrigatória a: composição da arrecadação (taxa de condomínio, fundo de reserva, multas, juros), valor total arrecadado no período, número de meses de superávit no exercício, renegociações com concessionárias (CESAN, EDP, Vivo, NET), impacto de obras específicas em meses específicos do período, parcelamentos de inadimplência, esclarecimentos técnicos ou jurídicos dados a condôminos. Se a transcrição menciona, a ata REGISTRA.

FID 5. SEM HÍFEN OU TRAVESSÃO NO CORPO DA ATA
Proibido usar hífen "-" ou travessão "–" no texto corrido dos itens da ata e na abertura. Use vírgula, ponto e vírgula ou frase nova no lugar. EXCEÇÕES EXPLÍCITAS desta regra, que permanecem regidas pela SKILL.md acima: (a) travessões do cabeçalho de endereço, formato "Logradouro – Bairro – Cidade/UF"; (b) travessões da linha de cargo das assinaturas, formato "Cargo – Tratamento Nome"; (c) travessão do título do anexo, formato "ANEXO I – TÍTULO". Nenhuma OUTRA ocorrência de hífen ou travessão é permitida.

FID 6. NENHUM COMENTÁRIO SOBRE A TRANSCRIÇÃO DENTRO DA ATA
A ata é documento formal de cartório. É PROIBIDO escrever no texto qualquer comentário meta sobre a transcrição, dúvida de leitura, raciocínio interno, justificativa de incerteza ou observação do tipo "tendo em vista que a transcrição menciona", "a gravação está inaudível", "não ficou claro se". Quando um dado for ambíguo ou faltar, usar SOMENTE o marcador limpo entre colchetes ([valor a confirmar], [nome a confirmar], [data a confirmar], [sobrenome a confirmar]) no lugar do dado, sem NENHUMA explicação ao lado e sem citar a transcrição. O marcador nunca contém frases, motivos ou referências à gravação. ERRADO: "R$ 24.030,47 [valor a confirmar, tendo em vista que a transcrição menciona 'R$ 24.000' e 'R$ 24.000, R$ 30,47' em momentos distintos]". CERTO: "[valor a confirmar]". Isso vale para QUALQUER dado, INCLUSIVE CONTAGEM DE VOTOS: se a apuração foi confusa, reiniciada ou ficou incerta, NÃO descrever o que aconteceu na contagem dentro da ata. Registrar apenas o número seguido de [a confirmar] limpo, ou [a confirmar] no lugar do número, sem explicar o motivo. ERRADO: "sete (7) votos [a confirmar, tendo em vista que durante a apuração o contador reiniciou a contagem]". CERTO: "sete (7) votos [a confirmar]", ou, se o próprio número for incerto, "[a confirmar] votos". Nunca escrever na ata frases sobre a contagem, a gravação, o áudio ou o raciocínio da redação.

FID 7. PALAVRA SUSPEITA DE ERRO DE TRANSCRIÇÃO: SINALIZAR, NUNCA CHUTAR
Se aparecer uma palavra que não é português válido, ou que não faz sentido no contexto condominial (provável erro da transcrição automática de áudio), e não houver correspondência clara no GLOSSÁRIO DE TERMOS CONDOMINIAIS anexado abaixo, é PROIBIDO copiar a palavra cega e é PROIBIDO adivinhar qual seria a palavra certa. Marcar exatamente como [termo a confirmar: 'texto original da transcrição'], preservando entre aspas o que a transcrição trouxe. Sinalizar apenas; nunca inventar a correção. A marcação de termo é SEMPRE completa, com o trecho original entre aspas simples dentro dos colchetes. É PROIBIDO escrever [termo a confirmar] seco, sem o texto original: sem o trecho entre aspas, o revisor perde a pista do que foi dito. Exemplo: o serviço de insuflamento, transcrito como "insufuco com varita", se não puder ser corrigido com segurança pelo glossário, vira [termo a confirmar: 'insufuco com varita'], NUNCA [termo a confirmar] sozinho. Toda marcação de termo a confirmar sem o trecho original entre aspas deve ser tratada como ERRO de redação. Se o trecho estiver realmente ininteligível e não houver texto original citável, escrever [trecho ininteligível a confirmar]; JAMAIS deixar o colchete sem conteúdo. Esta regra também cobre PALAVRA ESTRANGEIRA ou rótulo/nome sem significado claro no contexto condominial: é PROIBIDO reproduzir a palavra crua (mesmo entre aspas) como se fosse um rótulo real da assembleia. Exemplo real: a transcrição trouxe "house" no meio da descrição de mão de obra; o certo é [termo a confirmar: 'house'], nunca apresentar 'house' como se fosse um dado válido da reunião. Termo sem sentido nunca vira informação da ata: ou corrige pelo glossário, ou marca com o original entre aspas.

FID 8. GLOSSÁRIO DE DOMÍNIO CORRIGE GRAFIA DE TERMO OUVIDO ERRADO
Está anexado abaixo um GLOSSÁRIO DE TERMOS CONDOMINIAIS. Quando a transcrição trouxer uma palavra foneticamente próxima de um termo do glossário, mas grafada de forma errada ou sem sentido no contexto, corrigir para o termo correto do glossário (ex.: "dancaria" no contexto de área comum e máquinas de lavar corrige para lavanderia; "insufuco" corrige para insuflamento; atenção ao par corrediço x basculante, corrigindo só quando o contexto tornar inequívoco qual é). Sem correspondência clara no glossário, aplicar a FID 7 (marcar como [termo a confirmar: '...']). O glossário SÓ padroniza a grafia de termo reconhecível ouvido errado: NUNCA autoriza inventar conteúdo, mudar valores, preencher lacunas (quórum, votos, presença, datas, desfechos) nem alterar o que foi dito. A anti-invenção continua absoluta. CASO MAPEADO tem correção OBRIGATÓRIA e EXATA: quando o glossário lista o erro (seção 11, ex.: "dancaria" no contexto de área comum/máquinas de lavar corrige para LAVANDERIA), usar EXATAMENTE o termo do glossário. É PROIBIDO substituir por uma terceira palavra só por ser foneticamente parecida: "dancaria" NUNCA vira "danceteria", vira lavanderia. Se ficar em dúvida entre a correção do glossário e outra palavra, aplicar a FID 7 e marcar [termo a confirmar: 'texto original'], nunca escolher uma palavra fora do glossário.

FID 9. FIDELIDADE AO QUE FOI DITO: NÃO REORGANIZAR ENTRE ITENS
A IA NÃO deve mover, antecipar, repetir nem realocar conteúdo entre os itens de pauta por conta própria para "organizar" a ata. O critério é fidelidade absoluta ao que foi realmente dito na assembleia: se um assunto foi de fato mencionado em mais de um momento da reunião, a ata registra em cada momento onde ele foi dito, mantendo a repetição real. PROIBIDO mover uma menção de um item para outro, duplicar uma menção que ocorreu só uma vez, ou inventar menção que não ocorreu. Exemplo do que é ERRADO: deslocar a frase sobre vagas remanescentes do conselho (dita no Item 4) para dentro do Item 2. Cada fato fica no item em que foi efetivamente tratado.

FID 10. NUNCA OMITIR ITEM, SERVIÇO OU INFORMAÇÃO DA TRANSCRIÇÃO
É PROIBIDO deixar de fora da ata qualquer item, serviço, valor ou informação que estava na transcrição só porque a palavra veio grafada errada, sem sentido ou difícil de entender. Omitir é violação grave de fidelidade. O procedimento correto quando o termo veio errado: (1) se houver caso mapeado ou correspondência clara no glossário, corrigir para o termo do glossário (FID 8); (2) se NÃO conseguir corrigir com segurança, MANTER o item na lista e marcar o trecho problemático como [termo a confirmar: 'texto original da transcrição'] (FID 7). Em nenhuma hipótese o item some. Exemplo real: "insufuco com varita" (provável insuflamento) deve aparecer na lista de serviços como insuflamento (se o contexto confirmar) ou como [termo a confirmar: 'insufuco com varita']; jamais ser simplesmente removido da ata.`;

// Prompt do segundo passe (auditoria de fidelidade).
// Roda Sonnet 4.6 sem fallback Opus — auditoria deve ser leve. Se falhar, devolvemos
// a ata original e logamos warning, sem quebrar a geração.
const PROMPT_AUDITORIA = `Você é o auditor de fidelidade factual de uma ata condominial já redigida.

Você recebe DOIS blocos:
1. ATA GERADA (versão atual da ata, ainda não revisada)
2. TRANSCRIÇÃO ORIGINAL E DADOS DA REUNIÃO (incluindo edital, participantes e demais dados que o usuário enviou)

Sua tarefa é ESTRITAMENTE de auditoria. Não reformule estilo, não melhore redação, não adicione conteúdo novo. SOMENTE corrija o que a transcrição não sustenta e inclua fatos relevantes da transcrição que foram omitidos.

PROCEDIMENTO:
(a) Liste mentalmente cada número (valor em reais, quantidade de votos, percentual, parcelas, datas), cada nome próprio (incluindo sobrenomes) e cada fato pontual que aparece na ata.
(b) Para cada item da lista, verifique se a transcrição sustenta literalmente esse item.
(c) Se a transcrição NÃO sustenta o item, substitua o dado pela marcação limpa entre colchetes, mantendo a estrutura da frase e SEM explicar o motivo. Exemplos concretos:
    "Sr. Wellington (Eriton) Pabodo" vira "Sr. Wellington (Eriton) [sobrenome a confirmar]" se Pabodo não aparece na transcrição.
    "vinte e três (23) votos" vira "[número de votos a confirmar] votos" se a transcrição não confirma esse número exato.
    "R$ 762.000,00" vira "R$ [valor a confirmar]" se a transcrição não confirma esse valor.
(c.1) ATENÇÃO, esta é a distinção que a auditoria vinha errando: os passos (b) e (c) valem SOMENTE para NÚMEROS, NOMES PRÓPRIOS e FATOS PONTUAIS (datas, votos, valores, quórum, presença, desfecho). NÃO valem para VOCABULÁRIO. Termo técnico que o passe anterior corrigiu de um erro de transcrição (por exemplo insuflamento, corrediço, síndico, subsíndico, assembleia, conselho consultivo, regimento interno, lavanderia, conforme o GLOSSÁRIO DE TERMOS CONDOMINIAIS anexado abaixo) é correção LEGÍTIMA e deve ser PRESERVADA. É PROIBIDO rebaixar esse termo para [a confirmar] só porque a palavra corrigida não aparece literal na transcrição bruta, já que a transcrição automática erra vocabulário. Só marque um termo quando ele não tiver correspondência no glossário nem sentido claro no contexto condominial.
(d) Se um fato relevante da transcrição foi OMITIDO na ata (composição da arrecadação, número de meses de superávit, renegociação com concessionária, impacto de obras em meses específicos), INCLUA o fato no item correspondente, sempre com base literal na transcrição.

REGRAS DE SAÍDA:
1. Devolva APENAS a ata corrigida, do cabeçalho até a última linha de assinatura. Nada antes, nada depois. Sem comentários, sem lista de mudanças, sem "Aqui está a ata auditada".
2. Mantenha exatamente a formatação do documento: prosa corrida, sem markdown, sem bullets, CAIXA ALTA para destaques, ITEM N) para itens, travessões "–" apenas onde a SKILL.md prescreve (endereço, linha de cargo das assinaturas, título de anexo).
3. Se você conferir que a ata está 100% fiel e nada precisa mudar, devolva a ata idêntica à entrada, sem modificar uma vírgula.
4. Marcação de TERMO (palavra técnica ouvida errada que não dá pra corrigir com segurança pelo glossário) é SEMPRE completa: [termo a confirmar: 'texto original da transcrição'], com o trecho original entre aspas simples dentro dos colchetes. Se o trecho estiver ininteligível e não houver texto citável, usar [trecho ininteligível a confirmar]. É PROIBIDO [termo a confirmar] seco, sem o texto original.
5. NUNCA OMITIR item, serviço, valor ou informação que já estava na ata ou na transcrição. Se um termo veio errado e você não consegue corrigir com segurança pelo glossário, MANTENHA o item e marque o trecho pela regra 4 (com o original entre aspas). Omitir é violação grave.
6. PRESERVE os marcadores [termo a confirmar: '...'] que já vierem na ata de entrada. Não apague, não esvazie e não rebaixe para [a confirmar] seco.
7. NUNCA escreva no corpo da ata comentário, justificativa, dúvida ou observação sobre a transcrição, a contagem de votos, o áudio ou o próprio processo de redação. Dado incerto vira apenas o marcador limpo, sem explicar o motivo.
8. NUNCA ENCURTAR, RESUMIR OU CONDENSAR. Preserve integralmente a extensão e o detalhamento da ata de entrada. Se a ata de entrada decompõe despesas, receitas, propostas, candidatos ou votações item a item no formato (i), (ii), (iii) com valores e categorias nomeadas, a saída MANTÉM essa decomposição COMPLETA, item a item. Sua função é SOMENTE marcar incertezas com [a confirmar] e incluir fatos omitidos da transcrição; JAMAIS remover, agrupar, sintetizar ou trocar por frase-resumo qualquer detalhe que já esteja na ata. A ata auditada tem, no mínimo, o mesmo detalhamento e a mesma extensão da ata de entrada.`;

// Segundo passe: roda Sonnet 4.6 com a ata + transcrição original e devolve a ata
// corrigida. Sem fallback. Em caso de erro, retorna null e o caller usa a ata original.
async function auditarFidelidadeAta(ataGerada, userMessageOriginal, callFn) {
  // callFn: função de chamada COM teto hard (passada por gerarAtaJob). Assim a chamada
  // da auditoria também conta no teto de 3 por geração. Fallback pra chamada direta
  // se invocada fora do motor (mantém compatibilidade).
  const chamar = callFn || chamarAnthropicAta;
  const auditMessage = '=== ATA GERADA (a auditar) ===\n' + ataGerada +
    '\n\n=== TRANSCRIÇÃO ORIGINAL E DADOS DA REUNIÃO ===\n' + userMessageOriginal +
    '\n\nAudite a ata acima contra a transcrição e devolva a ata corrigida seguindo o procedimento e as regras de saída.';
  // max_tokens subido de 16k p/ 32k (opção "a", 2026-07-07): alinhado com a geração.
  // CRÍTICO: a auditoria REESCREVE a ata inteira; com teto de 16k ela truncava/condensava
  // uma ata rica (>16k tokens) ao devolvê-la, e a versão truncada podia substituir a
  // original. Com 32k a auditoria reproduz a ata longa por completo. A regra 8 do
  // PROMPT_AUDITORIA proíbe encurtar: ela só marca [a confirmar] e inclui fatos omitidos.
  // Glossário anexado também aqui: sem ele, a auditoria não reconhece correções de
  // vocabulário legítimas do passe principal e as rebaixava para [a confirmar].
  const systemAuditoria = PROMPT_AUDITORIA + (GLOSSARIO_MD ? '\n\n---\n\n' + GLOSSARIO_MD : '');
  const r = await chamar('claude-sonnet-4-6', 32000, systemAuditoria, auditMessage);
  if (!r.ok || !r.texto) {
    console.warn('[engine-ata] Segundo passe de auditoria falhou (status ' + (r.status || 'sem_status') + '): ' + (r.erro || 'sem_texto'));
    return null;
  }
  return r.texto;
}

// ─── Auditoria de COMPLETUDE FRACIONADA (2026-07-07) ───────────────────────
// Em atas longas (reunião de 3h) a auditoria única sobre ~36k tokens dilui a atenção
// e o Sonnet deixa passar valores (Enseada perdeu R$ 2.071,00 e R$ 2.500,00). Solução:
// dividir a transcrição em blocos e auditar cada um COM FOCO (menos volume por passada
// = mais exaustividade), consolidar lacunas, inserir CIRURGICAMENTE o que faltou (sem
// reescrever/condensar). Opus entra SÓ se, após a inserção Sonnet, um valor REAL da
// transcrição ainda faltar (gatilho determinístico; quase nunca dispara).
const PROMPT_AUDITORIA_BLOCO = `Você é auditor de COMPLETUDE de uma ata condominial. Recebe a ATA completa e UM TRECHO da transcrição da mesma assembleia.

Sua ÚNICA tarefa: listar os fatos concretos ditos NESTE TRECHO da transcrição que estão FALTANDO na ata, ou que aparecem na ata de forma DIVERGENTE do trecho. Foque em: valores monetários (R$), itens de pauta, serviços, deliberações, resultados de votação, percentuais, prazos, nomes próprios e quantidades ditos neste trecho.

REGRAS DE SAÍDA:
- NÃO reescreva a ata, NÃO devolva a ata. Devolva SÓ a lista de lacunas.
- ANTI-INVENÇÃO: aponte apenas o que ESTE trecho realmente sustenta. Nunca peça pra ata registrar o que o trecho não diz.
- Uma lacuna por linha, começando com "LACUNA: ".
- Se a lacuna envolve valor monetário, comece pelo valor JÁ NORMALIZADO no formato R$ X.XXX,XX: "LACUNA (R$ X.XXX,XX): <o que é e em qual item entra>".
- RECONHEÇA valores ditos de forma INFORMAL na fala e normalize para R$ X.XXX,XX na lacuna: "X mil" / "X mil reais" (ex.: "21 mil" vira R$ 21.000,00), "X reais" / "X conto" (ex.: "quinhentos reais" vira R$ 500,00), valor por extenso ("dois mil e quinhentos" vira R$ 2.500,00, "quatrocentos" vira R$ 400,00), e "R$" antes de informal ("R$ 21 mil" vira R$ 21.000,00). Um valor dito informalmente na fala e AUSENTE da ata É uma lacuna, tanto quanto um valor formal.
- CUIDADO pra não confundir com NÃO valores: ano ("dois mil e vinte e seis"), quantidade de pessoas, votos, unidades ou parcelas não são valores monetários. Só trate como valor o que a fala apresenta como quantia em dinheiro (reais).
- Ignore diferenças de estilo, ordem ou redação; aponte só FATO faltando ou número/nome divergente.
- Se ESTE trecho já está integralmente refletido na ata, responda EXATAMENTE: NENHUMA LACUNA`;

const PROMPT_INSERCAO_LACUNAS = `Você recebe uma ATA condominial já redigida e uma LISTA DE LACUNAS (fatos ditos na assembleia que faltaram na ata).

Tarefa: INSERIR CIRURGICAMENTE cada lacuna no item correto da ata, preservando INTEGRALMENTE todo o texto e o detalhamento que já existem. Você ADICIONA o que falta; NUNCA reescreve, resume, condensa ou remove o que já está na ata.

REGRAS:
- A ata de saída tem, no mínimo, tudo o que a de entrada tinha, MAIS as lacunas inseridas. Nunca encurte.
- Insira cada fato no item de pauta correto, no mesmo estilo (prosa corrida, subitens (i)(ii)(iii), valores no padrão R$ X.XXX,XX).
- NORMALIZE valores informais para o padrão formal ao inserir: "21 mil" vira "R$ 21.000,00", "quinhentos reais" vira "R$ 500,00", "dois mil e quinhentos" vira "R$ 2.500,00". A ata é documento formal; nunca deixe o valor em forma coloquial.
- Se uma lacuna aponta um valor ou nome NA ata DIVERGENTE da transcrição, ajuste para o que a transcrição sustenta, ou marque [a confirmar] se ambíguo.
- ANTI-INVENÇÃO ABSOLUTA: insira só o que a lacuna afirma. Se estiver incerto, insira com [a confirmar]. Nunca invente.
- Fidelidade: sem hífen ou travessão no corpo (exceto endereço, linha de assinatura, título de anexo). NUNCA comente a transcrição, a gravação ou o processo de redação dentro da ata.
- Se uma "lacuna" já estiver na ata, ignore (não duplique).
- Devolva APENAS a ata completa corrigida, do cabeçalho até a última linha de assinatura. Nada antes, nada depois, sem comentários.`;

// Extrai só a transcrição de dentro do userMessage (pra auditar em blocos).
function extrairTranscricao(um) {
  const partes = String(um).split(/=== TRANSCRIÇÃO COMPLETA DA REUNIÃO ===/);
  if (partes.length < 2) return String(um);
  return partes[1].replace(/\n\s*Gere a ata completa[\s\S]*$/i, '').trim();
}

// Número de blocos pela carga da transcrição (1 a 3). Fracionar só ajuda em ata longa.
function numBlocosAuditoria(transcricao) {
  const c = transcricao.length;
  if (c < 40000) return 1;
  if (c < 90000) return 2;
  return 3;
}

// Divide em n blocos cortando SEMPRE em fim de frase (nunca no meio), com sobreposição
// (overlap) pra não perder contexto na emenda entre blocos.
function dividirEmBlocos(txt, n) {
  if (n <= 1 || txt.length < 3000) return [txt];
  const cortes = [0];
  for (let k = 1; k < n; k++) {
    let alvo = Math.round(txt.length * k / n);
    const janela = txt.slice(alvo, Math.min(txt.length, alvo + 600));
    const m = janela.search(/[.!?]\s/);
    if (m >= 0) alvo = alvo + m + 1;
    cortes.push(alvo);
  }
  cortes.push(txt.length);
  const overlap = 800;
  const blocos = [];
  for (let k = 0; k < n; k++) {
    const ini = k === 0 ? cortes[k] : Math.max(0, cortes[k] - overlap);
    blocos.push(txt.slice(ini, cortes[k + 1]).trim());
  }
  return blocos.filter((b) => b.length > 0);
}

// Valores monetários distintos (R$ X.XXX,XX) num texto.
function valoresMonetarios(txt) {
  return [...new Set((String(txt).match(/\d[\d.]*,\d{2}/g) || []))];
}

// Canoniza um número escrito pt-BR ('21.000,00', '21', '1,5') pra Number (em reais).
function _numPtBr(str, mult) {
  const n = parseFloat(String(str).trim().replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : Math.round(n * (mult || 1) * 100) / 100;
}

// Conjunto de valores monetários CANÔNICOS (Number em reais) de um texto, cobrindo:
// formal (R$ 21.000,00), 'X mil'/'R$ X mil' (21 mil = 21000), 'X reais'/'X conto'
// (500 reais = 500). Valores por extenso ('dois mil e quinhentos') ficam com o LLM
// (auditoria de bloco normaliza pra R$ X.XXX,XX, que este extrator então pega).
// Usado só pra COMPARAR (o que a fala tem vs o que a ata tem) e armar o Opus.
function valoresCanonicos(txt) {
  const s = String(txt);
  const set = new Set();
  for (const m of s.matchAll(/\d[\d.]*,\d{2}/g)) { const c = _numPtBr(m[0]); if (c) set.add(c); }
  for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s*mil\b/gi)) { const c = _numPtBr(m[1], 1000); if (c) set.add(c); }
  for (const m of s.matchAll(/(\d[\d.]*)\s*(?:reais|conto)/gi)) { const c = _numPtBr(m[1]); if (c) set.add(c); }
  // 'R$ X' / 'R$ X.XXX' sem centavos (ex.: 'R$2.071', 'R$ 450'); exclui 'R$ X mil' e 'R$ X,XX'
  for (const m of s.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})*)(?!\s*mil)(?!\d)(?![.,]\d)/gi)) { const c = _numPtBr(m[1]); if (c) set.add(c); }
  return set;
}

// Menções monetárias da fala COM o trecho ao redor (contexto), pra alimentar a inserção
// de forma determinística: garante que todo valor dito (formal/informal) que falte na ata
// entre na lista de lacunas mesmo que a auditoria de bloco (LLM) tenha deixado passar.
function mencoesMonetarias(txt) {
  const s = String(txt);
  const out = [];
  const push = (idx, len, canon) => {
    if (!canon) return;
    const trecho = s.slice(Math.max(0, idx - 70), Math.min(s.length, idx + len + 70)).replace(/\s+/g, ' ').trim();
    out.push({ canon, trecho });
  };
  for (const m of s.matchAll(/\d[\d.]*,\d{2}/g)) push(m.index, m[0].length, _numPtBr(m[0]));
  for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s*mil\b/gi)) push(m.index, m[0].length, _numPtBr(m[1], 1000));
  for (const m of s.matchAll(/(\d[\d.]*)\s*(?:reais|conto)/gi)) push(m.index, m[0].length, _numPtBr(m[1]));
  for (const m of s.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})*)(?!\s*mil)(?!\d)(?![.,]\d)/gi)) push(m.index, m[0].length, _numPtBr(m[1]));
  return out;
}

// Auditoria de completude de UM bloco: devolve a lista de lacunas (texto) ou '' se nada.
async function auditarBlocoCompletude(ata, bloco, i, n, chamar) {
  const sys = PROMPT_AUDITORIA_BLOCO + (GLOSSARIO_MD ? '\n\n---\n\n' + GLOSSARIO_MD : '');
  const msg = '=== ATA GERADA (completa) ===\n' + ata + '\n\n=== TRECHO ' + i + ' DE ' + n + ' DA TRANSCRIÇÃO ===\n' + bloco + '\n\nListe as lacunas DESTE trecho conforme as regras.';
  const r = await chamar('claude-sonnet-4-6', 8000, sys, msg);
  return (r.ok && r.texto) ? r.texto.trim() : '';
}

// Inserção cirúrgica das lacunas (modelo = sonnet ou opus). Devolve a ata ou null.
async function inserirLacunasNaAta(ata, listaLacunas, modelo, chamar) {
  const sys = PROMPT_INSERCAO_LACUNAS + (GLOSSARIO_MD ? '\n\n---\n\n' + GLOSSARIO_MD : '');
  const msg = '=== ATA ATUAL ===\n' + ata + '\n\n=== LACUNAS A INSERIR (fatos da transcrição que faltaram) ===\n' + listaLacunas + '\n\nInsira cirurgicamente cada lacuna no item correto e devolva a ATA COMPLETA corrigida.';
  const r = await chamar(modelo, 32000, sys, msg);
  return (r.ok && r.texto && r.texto.trim()) ? r.texto.trim() : null;
}

// Validação heurística pós-geração — detecta truncamento e formato quebrado.
// Critérios derivados das atas de referência do handoff:
//   - tem frase de encerramento padrão
//   - termina com ponto final (não foi cortada no meio)
//   - tem pelo menos 4 blocos de assinatura (ex.: Síndico, Subsíndico, Conselho, Presidente, Secretária; a administradora nunca assina)
//   - tem tamanho mínimo plausível (atas reais têm 6000+ chars)
// REGRA DE OURO (2026-07-07): a validação NUNCA bloqueia a entrega nem dispara
// retry caro. Melhor entregar a ata com um aviso do que falhar, demorar e queimar
// crédito. Esta função só APONTA avisos (não bloqueantes) pro usuário revisar.
//
// Em especial, a composição de ASSINATURAS é adaptável: varia por tipo de assembleia
// (uma AGE de destituição tem composição diferente de uma AGO; nem toda ata tem
// conselho fiscal). NÃO existe número fixo obrigatório. Só marcamos aviso se não
// houver praticamente nenhuma linha de assinatura (sinal de truncamento), nunca por
// "faltar" pra chegar a um número arbitrário.
//
// 'pareceAta' distingue texto de ata real de uma recusa/erro do modelo — usado APENAS
// pra decidir se a saída da auditoria pode substituir o original, nunca pra retry.
function validarAta(resposta) {
  if (!resposta || typeof resposta !== 'string' || !resposta.trim()) {
    return { pareceAta: false, avisos: ['a geração veio vazia'], blocosAssinatura: 0 };
  }
  const temEncerramento = resposta.includes('Nada mais havendo a tratar');
  const blocosAssinatura = (resposta.match(/_{30,}/g) || []).length;
  const tamanhoOk = resposta.length > 6000;
  const headers = (resposta.match(/^#{1,6} /gm) || []).length;
  const negritos = (resposta.match(/\*\*[^*]+\*\*/g) || []).length;
  const tabelas = (resposta.match(/^\|/gm) || []).length;
  const separadores = (resposta.match(/^---+$/gm) || []).length;
  // Pré-análise: se a resposta começa com "Vou processar", "Mapeamento", "##", etc.
  const inicio = resposta.trim().slice(0, 200).toLowerCase();
  const temPreAnalise = /vou (processar|analisar|redigir|mapear)|mapeamento|reconstituindo|aqui (est[aá]|vai)|^##|^---|^an[aá]lise/m.test(inicio);

  // Avisos NÃO bloqueantes — a ata é entregue de qualquer forma.
  const avisos = [];
  if (!temEncerramento) avisos.push('não encontrei a frase de encerramento padrão; a ata pode estar truncada');
  if (!tamanhoOk) avisos.push('ata curta (' + resposta.length + ' caracteres); confirme se está completa');
  if (blocosAssinatura < 2) avisos.push('poucas linhas de assinatura (' + blocosAssinatura + '); revise o bloco de assinaturas');
  if (temPreAnalise) avisos.push('o início parece conter texto de análise antes da ata; revise as primeiras linhas');
  if (headers > 0 || tabelas > 0 || separadores > 0 || negritos > 5) avisos.push('detectei formatação markdown (títulos/tabelas/negritos); revise a formatação');

  // "Parece ata": tem encerramento OU é longa o suficiente, e não abre com pré-análise.
  // Só serve pra não deixar a auditoria trocar uma ata boa por uma saída quebrada.
  const pareceAta = (temEncerramento || tamanhoOk) && !temPreAnalise;
  return { pareceAta, avisos, blocosAssinatura };
}

// Wrapper Promise pra chamada Anthropic /v1/messages com timeout 600s (10min).
// Subido de 120s p/ 600s (2026-07-07): a chamada é NÃO streaming (Anthropic só
// envia bytes quando termina de gerar), então o timeout tem que cobrir a geração
// inteira. Uma ata de reunião de 3h passava de 120s e a chamada morria (timeout_120s,
// engine_falhou). 600s dá folga pra atas longas. Roda em background (job), sem prender
// requisição HTTP do cliente.
// Retorna { ok, status, texto, raw, erro }.
function chamarAnthropicAta(modelo, maxTokens, system, userMessage) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: modelo,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMessage }]
    });
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      },
      timeout: 600000
    };
    const r = https.request(opts, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        // Acumula os chunks como Buffer e decodifica UTF-8 UMA vez no fim. Concatenar
        // como string por chunk (d += c) corrompia acento quando o corte de chunk caía
        // no meio de um caractere multibyte (ex: "Síndico" virava "S□ndico").
        const d = Buffer.concat(chunks).toString('utf8');
        try {
          const j = JSON.parse(d);
          const texto = (j.content && j.content[0] && j.content[0].text || '').trim();
          resolve({ ok: resp.statusCode === 200 && !!texto, status: resp.statusCode, texto, raw: j });
        } catch (e) {
          resolve({ ok: false, status: resp.statusCode || 500, erro: 'parse_falhou', raw: d.slice(0, 500) });
        }
      });
    });
    r.on('error', (e) => resolve({ ok: false, status: 500, erro: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, status: 504, erro: 'timeout_600s' }); });
    r.write(body); r.end();
  });
}

// ─── Geração de ata ASSÍNCRONA (job + polling) ──────────────────────────────
// Por que não streaming: o edge do Railway bufferiza o CORPO da resposta após o
// primeiro byte — keepalive/heartbeat no meio do caminho NÃO chega ao navegador e
// o Safari derruba a conexão ociosa ("Load failed"). Medido em 07/07/2026: nem
// text/event-stream nem padding de 4KB por ping atravessam o buffer do edge (só o
// primeiro chunk sai; o resto fica preso até a resposta acabar, ~80s de silêncio).
// Solução: a geração roda em BACKGROUND no servidor e o frontend faz polling curto.
// Cada request HTTP dura <1s — imune a timeout de borda e a idle do navegador. A
// geração roda UMA vez e fica guardada no job: conexão que cai não vira retry que
// cobra a API de novo (ataca o custo das tentativas falhas).
// Assunção: instância única (Cenário A, uso interno). Se um dia escalar réplicas,
// migrar este store em memória para Redis/DB (o polling pode cair em outra réplica).
const atasJobs = new Map(); // jobId -> { status:'processing'|'done'|'error', criadoEm, payload?, erro? }

// Remove o job 10min após concluir — evita vazamento de memória sem cortar polling
// em andamento. unref pra não segurar o processo vivo por causa do timer.
function agendarLimpezaJob(jobId) {
  const tmr = setTimeout(() => atasJobs.delete(jobId), 10 * 60 * 1000);
  if (typeof tmr.unref === 'function') tmr.unref();
}

// Teto HARD absoluto de chamadas à API Anthropic por geração de ata. Pior caso
// legítimo = 7 com a auditoria fracionada: 1 geração + 1 retry(falha de API) +
// até 3 auditorias de bloco + 1 inserção Sonnet + 1 inserção Opus (último recurso).
// Típico: 2 a 5 (sem Opus). Qualquer chamada além do teto é abortada (ver 'chamar').
const MAX_CHAMADAS_ANTHROPIC_POR_ATA = 7;

// Motor de geração — roda em background, sem prender a requisição HTTP. Entrega a
// PRIMEIRA passada Sonnet que retornar texto; a validação é só aviso, nunca bloqueia
// nem dispara retry. Retry (1x, Sonnet) só se a API não retornar texto. Sem Opus.
async function gerarAtaJob(jobId, userMessage) {
  const system = ATA_SKILL_MD + '\n\n---\n\n' + CONTEXTO_GRUPO_SERVICE + '\n\n---\n\n' + REGRAS_ANTI_ERRO + '\n\n---\n\n' + REGRAS_DETALHAMENTO_MAXIMO + '\n\n---\n\n' + REGRAS_FIDELIDADE_TRANSCRICAO + (GLOSSARIO_MD ? '\n\n---\n\n' + GLOSSARIO_MD : '');
  const tentativas = [];
  const concluir = (payload) => { const j = atasJobs.get(jobId); if (j) { j.status = 'done'; j.payload = payload; } agendarLimpezaJob(jobId); };
  // httpStatus (não 'status') pra NÃO colidir com o campo status do job. A rota /status
  // faz Object.assign({ status:'error' }, j.erro); se o erro trouxesse 'status', ele
  // sobrescreveria 'error' e o front ficava em polling infinito sem ver a falha.
  const falhar = (httpStatus, obj) => { const j = atasJobs.get(jobId); if (j) { j.status = 'error'; j.erro = Object.assign({ httpStatus }, obj); } agendarLimpezaJob(jobId); };

  // ─── TETO HARD DE CHAMADAS À API (proteção de custo) ───────────────────────
  // Contador que CORTA de vez: toda chamada Anthropic desta geração passa por 'chamar',
  // que aborta ao tentar a (MAX+1)-ésima. Cobre as tentativas E a auditoria. Se um bug
  // futuro introduzir qualquer loop ou nova cascata, isto barra antes de gastar mais.
  // MAX = 3 = pior caso legítimo (1 geração + 1 retry + 1 auditoria). Tudo Sonnet.
  let _chamadas = 0;
  const chamar = (modelo, maxTokens, sys, msg) => {
    if (++_chamadas > MAX_CHAMADAS_ANTHROPIC_POR_ATA) {
      throw new Error('TETO_CHAMADAS: teto de ' + MAX_CHAMADAS_ANTHROPIC_POR_ATA + ' chamadas à API por geração atingido; abortado para não gerar custo');
    }
    return chamarAnthropicAta(modelo, maxTokens, sys, msg);
  };

  // Entrega a ata com AUDITORIA DE COMPLETUDE FRACIONADA:
  //  1) a ata já veio gerada (texto);
  //  2) divide a transcrição em N blocos (1..3 por tamanho) e audita cada bloco (Sonnet)
  //     buscando fatos/valores daquele trecho ausentes na ata;
  //  3) havendo lacunas, insere CIRURGICAMENTE (Sonnet), sem reescrever/condensar;
  //  4) OPUS só se, após a inserção Sonnet, um valor REAL da transcrição ainda faltar.
  async function entregarAta(texto, modelo_usado, tentativaIdx) {
    const transcricao = extrairTranscricao(userMessage);
    const blocos = dividirEmBlocos(transcricao, numBlocosAuditoria(transcricao));
    let lacunas = '';
    for (let i = 0; i < blocos.length; i++) {
      const res = await auditarBlocoCompletude(texto, blocos[i], i + 1, blocos.length, chamar);
      if (res && /LACUNA/i.test(res) && !/^NENHUMA LACUNA\s*$/i.test(res)) lacunas += res + '\n';
    }
    lacunas = lacunas.trim();
    const fmtBRL = (c) => 'R$ ' + c.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const canonTransc = valoresCanonicos(transcricao);
    const canonAtaBase = valoresCanonicos(texto);
    // GARANTIA DETERMINÍSTICA de valor: toda menção monetária da FALA (formal/informal) ausente
    // da ata base vira lacuna COM o trecho da fala como contexto, mesmo que a auditoria de bloco
    // (LLM, não determinística) tenha deixado passar. Fecha a variância (ex.: 2.071 no Enseada).
    const jaFlag = valoresCanonicos(lacunas);
    const vistos = new Set();
    const gapsDet = [];
    for (const mnc of mencoesMonetarias(transcricao)) {
      if (canonAtaBase.has(mnc.canon) || jaFlag.has(mnc.canon) || vistos.has(mnc.canon)) continue;
      vistos.add(mnc.canon);
      gapsDet.push('LACUNA (' + fmtBRL(mnc.canon) + '): valor dito na assembleia, confira se entra em algum item — "' + mnc.trecho + '"');
    }
    const gapList = [lacunas, gapsDet.join('\n')].filter(Boolean).join('\n').trim();
    // Gatilho do Opus CONSERVADOR: só valores que o LLM flagou como lacuna real (relevância já
    // julgada), pra não disparar Opus por um valor da fala que legitimamente não vai pra ata.
    const valsFaltandoLLM = [...jaFlag].filter((c) => canonTransc.has(c) && !canonAtaBase.has(c));

    let ataFinal = texto;
    let etapa = 'sem_lacuna';
    let usouOpus = false;
    let insercaoQuebrou = false;
    if (gapList.length > 0) {
      const inserida = await inserirLacunasNaAta(texto, gapList, 'claude-sonnet-4-6', chamar);
      if (inserida && validarAta(inserida).pareceAta) { ataFinal = inserida; etapa = 'insercao_sonnet'; }
      else { etapa = 'insercao_sonnet_rejeitada_usou_original'; insercaoQuebrou = true; }
      // OPUS último recurso CONSERVADOR: só entra se a inserção Sonnet QUEBROU (saída não
      // pareceu ata). NÃO dispara por valor individual: a inserção recebeu todos os valores
      // da fala (com contexto) e já julgou relevância; sobrescrever por um valor de discussão
      // que o Sonnet corretamente não pôs seria Opus (~US$2) à toa. valsFaltandoLLM fica só
      // como diagnóstico. Assim Opus praticamente nunca aciona, e quando aciona é falha real.
      if (insercaoQuebrou) {
        try {
          const opus = await inserirLacunasNaAta(texto, gapList, 'claude-opus-4-7', chamar);
          if (opus && validarAta(opus).pareceAta) { ataFinal = opus; etapa = 'insercao_opus'; usouOpus = true; }
        } catch (e) {
          if (!/TETO_CHAMADAS/.test(String(e && e.message))) throw e; // teto: fica com a versão anterior
        }
      }
    }
    void valsFaltandoLLM;
    const vFinal = validarAta(ataFinal);
    const canonFinal = valoresCanonicos(ataFinal);
    // valores_fala_faltando = diagnóstico determinístico: valores da fala fora da ata final.
    const falaFaltandoFinal = [...new Set(mencoesMonetarias(transcricao).map((m) => m.canon))].filter((c) => !canonFinal.has(c));
    tentativas[tentativaIdx].auditoria_fracionada = {
      blocos: blocos.length, etapa, usouOpus, chamadas: _chamadas, gaps_deterministicos: gapsDet.length,
      valores_fala_faltando_final: falaFaltandoFinal.map(fmtBRL)
    };
    return concluir({
      ata: ataFinal,
      modelo_usado: usouOpus ? modelo_usado + ' + opus (inserção)' : modelo_usado,
      tentativas, auditoria: etapa, avisos: vFinal.avisos
    });
  }

  // REGRA DE OURO: nenhuma geração custa mais que uma passada normal por causa de
  // validação. Se a API devolveu TEXTO, entregamos (a validação vira aviso, nunca
  // rejeita). Só há retry se a API NÃO devolveu texto (rede/timeout/erro real), e
  // no MÁXIMO 1 retry. NUNCA cai pro Opus automaticamente. Custo teto: 2 chamadas
  // Sonnet de geração (só se a 1a falhar de verdade) + 1 de auditoria.
  try {
    // Tentativa 1: Sonnet 4.6 + 32k. max_tokens subido de 16k p/ 32k (opção "a",
    // 2026-07-07): atas ricas (decomposição por categoria) passavam de 16k tokens e
    // eram truncadas/condensadas; 32k dá folga pra sair completa.
    let r = await chamar('claude-sonnet-4-6', 32000, system, userMessage);
    tentativas.push({ modelo: 'claude-sonnet-4-6', max_tokens: 32000, status: r.status, erro: r.erro || null });
    if (r.ok && r.texto && r.texto.trim()) {
      tentativas[0].validacao = validarAta(r.texto);
      return await entregarAta(r.texto, 'claude-sonnet-4-6', 0);
    }

    // Só chega aqui se a API NÃO retornou texto na 1a. UM único retry Sonnet.
    console.warn('[engine-ata] Tentativa 1 sem texto (' + (r.erro || 'status ' + r.status) + '). Fazendo 1 retry Sonnet (SEM Opus).');
    r = await chamar('claude-sonnet-4-6', 32000, system, userMessage);
    tentativas.push({ modelo: 'claude-sonnet-4-6', max_tokens: 32000, status: r.status, erro: r.erro || null });
    if (r.ok && r.texto && r.texto.trim()) {
      tentativas[1].validacao = validarAta(r.texto);
      return await entregarAta(r.texto, 'claude-sonnet-4-6', 1);
    }

    // 2 falhas REAIS de geração (API sem texto). Sem cascata Opus. Devolve erro.
    console.error('[engine-ata] Geração sem texto em 2 tentativas Sonnet. Sem Opus. Tentativas:', JSON.stringify(tentativas));
    return falhar(502, {
      erro: 'geracao_sem_texto',
      detalhe: 'O gerador não retornou texto em 2 tentativas. Tente novamente em instantes.',
      tentativas
    });
  } catch (e) {
    // Corte do teto hard de chamadas → erro dedicado (nunca deixa gastar além do teto).
    if (e && typeof e.message === 'string' && e.message.startsWith('TETO_CHAMADAS')) {
      console.error('[engine-ata] ' + e.message + ' (chamadas=' + _chamadas + ')');
      return falhar(500, { erro: 'teto_chamadas_atingido', detalhe: 'Geração abortada pelo teto de segurança de chamadas à API. Nenhuma chamada extra foi feita.', tentativas });
    }
    console.error('[engine-ata] Erro inesperado na geração:', e && e.message);
    return falhar(500, { erro: 'erro_inesperado', detalhe: e && e.message ? e.message : 'erro' });
  }
}

// POST dispara a geração em background e responde JÁ com o jobId (request curto).
app.post('/api/atas/gerar', requireAuth, express.json({ limit: '10mb' }), (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ erro: 'anthropic_key_ausente' });
  if (!ATA_SKILL_MD) return res.status(500).json({ erro: 'skill_md_nao_carregada', detalhe: 'skills-server/ata-condominial.md não encontrada no servidor' });

  const userMessage = (req.body && req.body.userMessage) || '';
  if (typeof userMessage !== 'string' || userMessage.length < 50) {
    return res.status(400).json({ erro: 'userMessage_invalido', detalhe: 'envie a transcrição + dados da reunião como string em userMessage (mín 50 chars)' });
  }

  const jobId = crypto.randomUUID();
  atasJobs.set(jobId, { status: 'processing', criadoEm: Date.now() });
  // fire-and-forget: não aguarda. gerarAtaJob já trata tudo internamente; o .catch
  // é rede de segurança caso algo escape do try interno.
  gerarAtaJob(jobId, userMessage).catch((e) => {
    const j = atasJobs.get(jobId);
    if (j && j.status === 'processing') { j.status = 'error'; j.erro = { httpStatus: 500, erro: 'erro_inesperado', detalhe: e && e.message ? e.message : 'erro' }; }
  });
  return res.status(202).json({ jobId });
});

// GET faz o polling do status. Rápido — devolve o estado atual do job. Quando
// 'done', o corpo traz o payload completo ({ ata, modelo_usado, ... }); quando
// 'error', traz o detalhe. HTTP 200 nos dois pra o frontend ler o corpo.
//
// Cache DESLIGADO nesta rota: o Express põe ETag automático em res.json, e o
// navegador passava a revalidar com If-None-Match recebendo 304 (sem corpo) —
// aí o frontend nunca lia o estado final do job e o polling não terminava. Com
// no-store + ETag removido, toda consulta volta 200 com o corpo real.
app.get('/api/atas/gerar/status/:jobId', requireAuth, (req, res) => {
  // Sem cache E sem ETag nesta rota. O Express põe ETag automático em res.json/res.send,
  // e o navegador passava a revalidar com If-None-Match recebendo 304 (sem corpo) — aí o
  // polling nunca lia o resultado final. Aqui: Cache-Control no-store + envio via res.end
  // (que NÃO passa pela geração de ETag do Express), então nenhuma consulta pode virar 304.
  const enviar = (status, obj) => {
    res.status(status).set('Cache-Control', 'no-store').type('application/json').end(JSON.stringify(obj));
  };
  const j = atasJobs.get(req.params.jobId);
  if (!j) return enviar(404, { status: 'not_found' });
  if (j.status === 'done') return enviar(200, Object.assign({ status: 'done' }, j.payload));
  if (j.status === 'error') return enviar(200, Object.assign({ status: 'error' }, j.erro));
  return enviar(200, { status: 'processing', esperando_s: Math.round((Date.now() - j.criadoEm) / 1000) });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/admin/usuarios/* — gestão de usuários (GESTOR only)
//
// Usa SUPABASE_SERVICE_ROLE_KEY pra falar com GoTrue admin (criar/deletar/listar
// usuários em auth.users) e PostgREST (CRUD em public.profiles). Sem essa env,
// devolve 503.
//
// Sempre: requireAuth → requireGestor (cadeia obrigatória).
// ─────────────────────────────────────────────────────────────────────────
function requireServiceRoleKey(req, res, next) {
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) {
    return res.status(503).json({ erro: 'service_role_nao_configurada', detalhe: 'SUPABASE_SERVICE_ROLE_KEY ausente' });
  }
  next();
}

// Helper: chamada HTTP ao Supabase (GoTrue admin ou REST PostgREST) com service_role
async function supabaseAdminRequest(method, pathStr, body) {
  const url = new URL(SUPABASE_URL + pathStr);
  const payload = body ? JSON.stringify(body) : null;
  const opts = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method,
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'content-type': 'application/json',
      ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      // Pra UPDATEs em PostgREST retornarem o registro afetado
      ...(method === 'PATCH' || method === 'POST' || method === 'DELETE'
          ? { 'prefer': 'return=representation' } : {})
    }
  };
  return new Promise((resolve) => {
    const r = https.request(opts, (resp) => {
      let d = '';
      resp.on('data', (c) => d += c);
      resp.on('end', () => {
        let json = null;
        try { json = d ? JSON.parse(d) : null; } catch { json = { raw: d }; }
        resolve({ status: resp.statusCode, body: json });
      });
    });
    r.on('error', (e) => resolve({ status: 500, body: { erro: e.message } }));
    if (payload) r.write(payload);
    r.end();
  });
}

// Upload binario para Supabase Storage via REST com service_role.
// Diferente de supabaseAdminRequest (que serializa JSON), este envia o Buffer
// cru com Content-Type apropriado. Path no bucket: <previsao_id>/<hash>.<ext>.
async function supabaseStorageUpload(bucket, objectPath, buffer, contentType) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('supabase_nao_configurado');
  }
  const url = new URL(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`);
  const cliente = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'x-upsert': 'true',
      },
    };
    const reqUp = cliente.request(opts, r => {
      let body = '';
      r.on('data', c => { body += c; });
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch { resolve({}); }
        } else {
          reject(new Error(`storage_upload_status_${r.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    reqUp.on('error', reject);
    reqUp.write(buffer);
    reqUp.end();
  });
}

// Gera signed URL para um objeto privado do Storage (expira em N segundos).
async function supabaseStorageSignedUrl(bucket, objectPath, expiresIn = 600) {
  const r = await supabaseAdminRequest(
    'POST',
    `/storage/v1/object/sign/${bucket}/${objectPath}`,
    { expiresIn }
  );
  if (r.status >= 400 || !r.body || !r.body.signedURL) {
    throw new Error('signed_url_falhou');
  }
  // O retorno e relativo: { signedURL: "/object/sign/..." } - precisa prefixar com SUPABASE_URL.
  const rel = r.body.signedURL.startsWith('/') ? r.body.signedURL : '/' + r.body.signedURL;
  return SUPABASE_URL.replace(/\/$/, '') + '/storage/v1' + rel;
}

// POST /api/admin/usuarios/convidar
// Body: { email, role: 'GERENTE'|'OPERACIONAL', nome? }
// Envia magic link de convite via GoTrue. O profile é criado automaticamente pelo
// trigger handle_new_user com role default OPERACIONAL — depois ajustamos via PATCH
// se role pedido for diferente.
app.post('/api/admin/usuarios/convidar',
  requireAuth, requireGestor, requireServiceRoleKey, express.json(),
  async (req, res) => {
    const { email, role, nome } = req.body || {};
    if (!email || !role) return res.status(400).json({ erro: 'email_e_role_obrigatorios' });
    if (!['GERENTE', 'OPERACIONAL'].includes(role)) {
      return res.status(400).json({ erro: 'role_invalido', detalhe: 'Convite só permite GERENTE ou OPERACIONAL. GESTOR é imutável.' });
    }
    // GoTrue invite — POST /auth/v1/invite envia magic link e cria user em auth.users
    // (status: invited). NÃO usar /auth/v1/admin/invite (404 em GoTrue moderno).
    const inv = await supabaseAdminRequest('POST', '/auth/v1/invite', {
      email,
      data: { nome: nome || email } // vai pra raw_user_meta_data
    });
    if (inv.status >= 400) return res.status(inv.status).json({ erro: 'falha_convite', detalhe: inv.body });
    // Atualiza role no profile recém-criado (trigger criou com OPERACIONAL default)
    if (role !== 'OPERACIONAL' && inv.body?.id) {
      await supabaseAdminRequest('PATCH', `/rest/v1/profiles?id=eq.${inv.body.id}`, { role });
    }
    res.status(201).json({ ok: true, user: { id: inv.body?.id, email: inv.body?.email, role } });
  });

// GET /api/admin/usuarios — lista todos os perfis (com email/role/permissões)
// Lê direto da tabela profiles via PostgREST. RLS é bypassada pelo service_role,
// mas a rota só está acessível pra GESTOR via requireGestor.
app.get('/api/admin/usuarios',
  requireAuth, requireGestor, requireServiceRoleKey,
  async (req, res) => {
    const r = await supabaseAdminRequest('GET',
      '/rest/v1/profiles?select=id,email,nome,role,pode_convidar,permissoes,criado_em,atualizado_em&order=criado_em.asc');
    res.status(r.status).json(r.body);
  });

// PUT /api/admin/usuarios/:id/role
// Body: { role: 'GERENTE'|'OPERACIONAL' }  (GESTOR não pode ser atribuído via API)
app.put('/api/admin/usuarios/:id/role',
  requireAuth, requireGestor, requireServiceRoleKey, express.json(),
  async (req, res) => {
    const { role } = req.body || {};
    if (!['GERENTE', 'OPERACIONAL'].includes(role)) {
      return res.status(400).json({ erro: 'role_invalido', detalhe: 'Use GERENTE ou OPERACIONAL. GESTOR só via banco.' });
    }
    const r = await supabaseAdminRequest('PATCH',
      `/rest/v1/profiles?id=eq.${encodeURIComponent(req.params.id)}`,
      { role });
    res.status(r.status).json(r.body);
  });

// PUT /api/admin/usuarios/:id/permissoes
// Body: { permissoes: {...}, pode_convidar?: bool }
// Trigger de banco ignora updates em GESTOR (sempre força permissões totais).
app.put('/api/admin/usuarios/:id/permissoes',
  requireAuth, requireGestor, requireServiceRoleKey, express.json(),
  async (req, res) => {
    const { permissoes, pode_convidar } = req.body || {};
    if (!permissoes || typeof permissoes !== 'object') {
      return res.status(400).json({ erro: 'permissoes_obrigatorias' });
    }
    const patch = { permissoes };
    if (typeof pode_convidar === 'boolean') patch.pode_convidar = pode_convidar;
    const r = await supabaseAdminRequest('PATCH',
      `/rest/v1/profiles?id=eq.${encodeURIComponent(req.params.id)}`,
      patch);
    res.status(r.status).json(r.body);
  });

// DELETE /api/admin/usuarios/:id
// Remove de auth.users — cascateia via FK pro profiles (ON DELETE CASCADE).
app.delete('/api/admin/usuarios/:id',
  requireAuth, requireGestor, requireServiceRoleKey,
  async (req, res) => {
    const id = req.params.id;
    // Safety: bloqueia auto-delete do GESTOR que está fazendo a chamada
    if (req.user?.sub === id) {
      return res.status(400).json({ erro: 'auto_delete_proibido' });
    }
    const r = await supabaseAdminRequest('DELETE', `/auth/v1/admin/users/${encodeURIComponent(id)}`);
    res.status(r.status).json(r.body || { ok: true });
  });

// ─────────────────────────────────────────────────────────────────────────
// POST /api/admin/seed-dev — popula 5 condomínios mockup + dados relacionados
//
// DUPLA proteção:
//   1. requireGestor (role no JWT precisa ser GESTOR)
//   2. SUPABASE_URL precisa apontar pra um project ref de dev (whitelist)
//
// Se SUPABASE_URL apontar pro projeto prod, devolve 403 antes de fazer qualquer
// coisa. Backend rejeita mesmo se alguém forjar JWT/roles — defense in depth.
//
// O trabalho real é feito pela RPC public.seed_dev() (PL/pgSQL SECURITY DEFINER).
// ─────────────────────────────────────────────────────────────────────────
app.post('/api/admin/seed-dev',
  requireAuth, requireGestor, requireServiceRoleKey,
  async (req, res) => {
    if (!isSupabaseDev()) {
      return res.status(403).json({
        erro: 'seed_nao_permitido_em_producao',
        detalhe: 'SUPABASE_URL não está em DEV_SUPABASE_REFS — rota bloqueada por segurança'
      });
    }
    const r = await supabaseAdminRequest('POST', '/rest/v1/rpc/seed_dev', {});
    res.status(r.status).json(r.body);
  });

// ─────────────────────────────────────────────────────────────────────────
// Helpers de cache hash para o módulo Previsão Orçamentária.
// Calculam MD5 deterministico do payload com keys ordenadas recursivamente.
// Evitam escrita no banco quando o usuário salva sem ter alterado nada.
// ─────────────────────────────────────────────────────────────────────────

// Serializa objeto com chaves ordenadas recursivamente em todos os niveis.
// Garante que o hash do payload seja deterministico independente da ordem
// em que JavaScript construiu o objeto. Usado apenas para detectar mudanca
// de conteudo, nao para seguranca.
function previsaoSerializarOrdenado(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(previsaoSerializarOrdenado).join(',') + ']';
  var chaves = Object.keys(obj).sort();
  return '{' + chaves.map(function(k) {
    return JSON.stringify(k) + ':' + previsaoSerializarOrdenado(obj[k]);
  }).join(',') + '}';
}

// MD5 hex do payload serializado com keys ordenadas.
function previsaoMd5Deterministico(obj) {
  return crypto.createHash('md5').update(previsaoSerializarOrdenado(obj)).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────
// Módulo: Previsão Orçamentária
// Proxy autenticado para o microserviço FastAPI previsao-api.
// O body multipart vai puro pelo pipe — NÃO passar por express.json().
// Timeout: 120s (PDFs grandes podem demorar na extração pdfplumber).
// ─────────────────────────────────────────────────────────────────────────

// Retorna http ou https baseado no protocolo da URL alvo.
// Necessário porque o microserviço local roda em HTTP, não HTTPS.
function clienteHttpDe(protocolo) {
  return protocolo === 'https:' ? https : http;
}

app.post('/api/previsao/extrair-pdfs', requireAuth, (req, res) => {
  if (!INTERNAL_API_SECRET) {
    res.status(503).json({ erro: 'previsao_api_nao_configurada' });
    return;
  }

  // Limite de 50MB: PDFs do Superlógica raramente passam de 5MB.
  // Validado após requireAuth e ANTES de abrir a conexão com o upstream —
  // abrir o socket antes deixava conexão TCP pendurada a cada request
  // rejeitado (achado da revisão da prestação, mesmo padrão aqui).
  const TAMANHO_MAX_UPLOAD = 50 * 1024 * 1024;
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (!contentLength) {
    res.status(411).json({ erro: 'content_length_obrigatorio' });
    return;
  }
  if (contentLength > TAMANHO_MAX_UPLOAD) {
    res.status(413).json({ erro: 'upload_muito_grande', detalhe: 'PDFs do Superlógica raramente passam de 5MB. Limite: 50MB.' });
    return;
  }

  const target = new URL('/extrair-pdfs', PREVISAO_API_URL);
  const cliente = clienteHttpDe(target.protocol);
  const opts = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname,
    method: 'POST',
    headers: {
      'X-Internal-Secret': INTERNAL_API_SECRET,
      'Content-Type': req.headers['content-type'] || 'application/octet-stream',
      'Content-Length': req.headers['content-length'],
    },
  };
  const upstream = cliente.request(opts, r => {
    res.status(r.statusCode);
    Object.entries(r.headers).forEach(([k, v]) => {
      if (!['connection', 'transfer-encoding'].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    });
    r.pipe(res);
  });
  upstream.setTimeout(120000, () => {
    upstream.destroy();
    if (!res.headersSent) res.status(504).json({ erro: 'timeout_extracao' });
  });
  upstream.on('error', e => {
    if (!res.headersSent) {
      // Serviço inacessível (recusa, timeout de rede, DNS) → 503.
      // Erros de protocolo/resposta inválida → 502.
      const indisponivel = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH'].includes(e.code);
      const statusCode = indisponivel ? 503 : 502;
      // Expor apenas o código Node (sem IP/hostname) para não vazar topologia interna.
      res.status(statusCode).json({ erro: 'previsao_api_indisponivel', detalhe: e.code || 'erro_desconhecido' });
    }
  });

  req.pipe(upstream);
});

// ─────────────────────────────────────────────────────────────────────────
// Módulo: Prestação de Contas
// Proxy autenticado para o microserviço prestacao-pdf (FastAPI).
// O Hub envia os W016A (multipart) e recebe { pptx_b64, pdf_b64, blocos }.
// O body multipart vai puro pelo pipe — NÃO passar por express.json().
// Timeout 240s: parse + render + LibreOffice frio chegam a 90s no primeiro
// request do dia. Erros 422 do microserviço passam direto pro Hub com o
// motivo estruturado (degradação graciosa: revisão humana, nunca slide
// quebrado).
// ─────────────────────────────────────────────────────────────────────────

app.post('/api/prestacao/gerar-deck', requireAuth, (req, res) => {
  if (!INTERNAL_API_SECRET || !PRESTACAO_PDF_API_URL) {
    // Sem microserviço configurado o Hub cai no fallback offline (PptxGenJS).
    res.status(503).json({ erro: 'prestacao_api_nao_configurada' });
    return;
  }

  // Validação de tamanho ANTES de abrir a conexão com o upstream — abrir o
  // socket antes deixaria uma conexão TCP pendurada por até 240s a cada
  // request rejeitado (achado da revisão). Sem Content-Length: 411 explícito
  // (fetch com FormData sempre envia o header; a ausência indica cliente
  // fora do fluxo normal, não upload grande).
  const TAMANHO_MAX_PRESTACAO = 50 * 1024 * 1024;
  const tamanho = parseInt(req.headers['content-length'] || '0', 10);
  if (!tamanho) {
    res.status(411).json({ erro: 'content_length_obrigatorio' });
    return;
  }
  if (tamanho > TAMANHO_MAX_PRESTACAO) {
    res.status(413).json({ erro: 'upload_muito_grande', detalhe: 'Limite: 50MB.' });
    return;
  }

  const target = new URL('/gerar', PRESTACAO_PDF_API_URL);
  const cliente = clienteHttpDe(target.protocol);
  const opts = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname,
    method: 'POST',
    headers: {
      'X-Internal-Secret': INTERNAL_API_SECRET,
      'Content-Type': req.headers['content-type'] || 'application/octet-stream',
      'Content-Length': req.headers['content-length'],
    },
  };
  const upstream = cliente.request(opts, r => {
    res.status(r.statusCode);
    Object.entries(r.headers).forEach(([k, v]) => {
      if (!['connection', 'transfer-encoding'].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    });
    r.pipe(res);
  });
  upstream.setTimeout(240000, () => {
    upstream.destroy();
    if (!res.headersSent) res.status(504).json({ erro: 'timeout_geracao' });
  });
  upstream.on('error', e => {
    if (!res.headersSent) {
      const indisponivel = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH'].includes(e.code);
      res.status(indisponivel ? 503 : 502).json({ erro: 'prestacao_api_indisponivel', detalhe: e.code || 'erro_desconhecido' });
    }
  });

  req.pipe(upstream);
});

// ─────────────────────────────────────────────────────────────────────────
// Módulo: Previsão Orçamentária — Persistência Supabase (Fase 3)
//
// Três rotas de rascunho com cache hash MD5:
//   POST /api/previsao/salvar-rascunho  — upsert com detecção de mudança
//   GET  /api/previsao/listar           — lista rascunhos do condomínio
//   GET  /api/previsao/rascunho/:id     — carrega rascunho individual
//
// Todas exigem auth Supabase (JWT). authMode 'internal' é bloqueado porque
// rascunhos precisam de um usuario real (criado_por = auth.uid()).
// service_role bypassa RLS, portanto o filtro por criado_por é replicado
// no Express para respeitar a Opção C de visibilidade por role.
// ─────────────────────────────────────────────────────────────────────────

// POST /api/previsao/salvar-rascunho
// Upsert de rascunho com detecção de mudança via hash MD5. Se o hash armazenado
// for igual ao calculado, retorna sem_alteracoes sem escrever no banco.
// Body: { condominio_id, ano_referencia, periodo, payload_json }
app.post('/api/previsao/salvar-rascunho',
  requireAuth, requireServiceRoleKey, express.json({ limit: '10mb' }),
  async (req, res) => {
    // authMode internal não tem usuario real; criado_por seria null
    if (req.authMode === 'internal') {
      return res.status(400).json({ erro: 'usuario_obrigatorio', detalhe: 'Esta rota exige autenticação Supabase (JWT de usuário real).' });
    }
    const { condominio_id, ano_referencia, periodo, payload_json } = req.body || {};
    if (!condominio_id || typeof condominio_id !== 'string') {
      return res.status(400).json({ erro: 'condominio_id_obrigatorio' });
    }
    if (typeof ano_referencia !== 'number' || ano_referencia < 2000 || ano_referencia > 2100) {
      return res.status(400).json({ erro: 'ano_referencia_invalido', detalhe: 'Deve ser número entre 2000 e 2100.' });
    }
    if (!periodo || typeof periodo !== 'string') {
      return res.status(400).json({ erro: 'periodo_obrigatorio' });
    }
    if (!payload_json || typeof payload_json !== 'object' || Array.isArray(payload_json)) {
      return res.status(400).json({ erro: 'payload_json_obrigatorio', detalhe: 'Deve ser um objeto JSON.' });
    }

    const userId = req.user.sub;
    // Reajustes entram no hash para que mudanças só neles também disparem escrita
    const hashCalculado = previsaoMd5Deterministico(payload_json);

    // Busca rascunho existente para o condomínio + ano
    const busca = await supabaseAdminRequest('GET',
      `/rest/v1/previsoes_orcamentarias?condominio_id=eq.${encodeURIComponent(condominio_id)}&ano_referencia=eq.${encodeURIComponent(ano_referencia)}&status=eq.rascunho&select=id,payload_hash,criado_por&limit=1`);

    if (busca.status >= 400) {
      console.error('[previsao] erro busca rascunho:', JSON.stringify(busca.body));
      return res.status(502).json({ erro: 'erro_busca_rascunho' });
    }

    const existentes = Array.isArray(busca.body) ? busca.body : [];
    const existente = existentes[0] || null;

    // Controle de acesso: OPERACIONAL só pode atualizar o próprio rascunho
    const role = getRoleFromPayload(req.user);
    if (existente && !['GESTOR', 'GERENTE'].includes(role) && existente.criado_por !== userId) {
      return res.status(404).json({ erro: 'rascunho_nao_encontrado' });
    }

    // Cache hit: payload não mudou, sem escrita
    if (existente && existente.payload_hash === hashCalculado) {
      return res.status(200).json({ status: 'sem_alteracoes', id: existente.id, payload_hash: hashCalculado });
    }

    if (existente) {
      // Atualiza registro existente
      const upd = await supabaseAdminRequest('PATCH',
        `/rest/v1/previsoes_orcamentarias?id=eq.${encodeURIComponent(existente.id)}`,
        { periodo, payload_json, payload_hash: hashCalculado });
      if (upd.status >= 400) {
        console.error('[previsao] erro patch rascunho:', JSON.stringify(upd.body));
        return res.status(502).json({ erro: 'erro_atualizar_rascunho' });
      }
      const registro = Array.isArray(upd.body) ? upd.body[0] : upd.body;
      return res.status(200).json({ status: 'atualizado', id: registro?.id || existente.id, payload_hash: hashCalculado });
    }

    // Insere novo rascunho
    const ins = await supabaseAdminRequest('POST',
      '/rest/v1/previsoes_orcamentarias',
      { condominio_id, ano_referencia, periodo, status: 'rascunho', payload_json, payload_hash: hashCalculado, criado_por: userId });
    if (ins.status >= 400) {
      console.error('[previsao] erro insert rascunho:', JSON.stringify(ins.body));
      return res.status(502).json({ erro: 'erro_inserir_rascunho' });
    }
    const novo = Array.isArray(ins.body) ? ins.body[0] : ins.body;
    return res.status(201).json({ status: 'criado', id: novo?.id, payload_hash: hashCalculado });
  });

// GET /api/previsao/listar?condominio_id=<uuid>
// Lista rascunhos do condomínio ativo. GESTOR/GERENTE veem todos;
// OPERACIONAL vê apenas os próprios (filtro explícito no Express, pois
// service_role bypassa RLS).
app.get('/api/previsao/listar',
  requireAuth, requireServiceRoleKey,
  async (req, res) => {
    if (req.authMode === 'internal') {
      return res.status(400).json({ erro: 'usuario_obrigatorio' });
    }
    const condominioId = req.query.condominio_id;
    if (!condominioId || typeof condominioId !== 'string') {
      return res.status(400).json({ erro: 'condominio_id_obrigatorio' });
    }

    const role = getRoleFromPayload(req.user);
    const userId = req.user.sub;
    const limite = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    let filtro = `/rest/v1/previsoes_orcamentarias?condominio_id=eq.${encodeURIComponent(condominioId)}&status=eq.rascunho&select=id,ano_referencia,periodo,payload_hash,atualizado_em&order=atualizado_em.desc&limit=${limite}`;
    // OPERACIONAL: aplica filtro adicional pelo proprio userId
    if (!['GESTOR', 'GERENTE'].includes(role)) {
      filtro += `&criado_por=eq.${encodeURIComponent(userId)}`;
    }

    const r = await supabaseAdminRequest('GET', filtro);
    if (r.status >= 400) {
      console.error('[previsao] erro listar rascunhos:', JSON.stringify(r.body));
      return res.status(502).json({ erro: 'erro_listar_rascunhos' });
    }
    return res.status(200).json(Array.isArray(r.body) ? r.body : []);
  });

// GET /api/previsao/rascunho/:id
// Carrega um rascunho individual pelo UUID. OPERACIONAL recebe 404 se não
// for o dono (evita vazar que o registro existe).
app.get('/api/previsao/rascunho/:id',
  requireAuth, requireServiceRoleKey,
  async (req, res) => {
    if (req.authMode === 'internal') {
      return res.status(400).json({ erro: 'usuario_obrigatorio' });
    }
    const id = req.params.id;
    const r = await supabaseAdminRequest('GET',
      `/rest/v1/previsoes_orcamentarias?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    if (r.status >= 400) {
      console.error('[previsao] erro get rascunho:', JSON.stringify(r.body));
      return res.status(502).json({ erro: 'erro_buscar_rascunho' });
    }
    const registros = Array.isArray(r.body) ? r.body : [];
    if (!registros.length) {
      return res.status(404).json({ erro: 'rascunho_nao_encontrado' });
    }
    const registro = registros[0];
    // Controle de visibilidade: OPERACIONAL só vê o próprio
    const role = getRoleFromPayload(req.user);
    const userId = req.user.sub;
    if (!['GESTOR', 'GERENTE'].includes(role) && registro.criado_por !== userId) {
      return res.status(404).json({ erro: 'rascunho_nao_encontrado' });
    }
    return res.status(200).json(registro);
  });

// ─────────────────────────────────────────────────────────────────────────
// POST /api/previsao/gerar-pdf
//
// Orquestrador de geracao de PPTX + PDF:
//   1. Valida auth (apenas Supabase JWT - sem internal)
//   2. Busca previsao no banco (controle de visibilidade por role)
//   3. Checa cache em previsoes_geracoes por (previsao_id, payload_hash)
//   4. Cache hit: regenera signed URLs (10min) e retorna cached: true
//   5. Cache miss: chama microservico previsao-pdf com timeout 180s
//   6. Upload PPTX + PDF para Storage privado (bucket previsao-arquivos)
//   7. INSERT em previsoes_geracoes
//   8. Retorna { pptx_url, pdf_url, gerado_em, cached, duracao_ms }
// ─────────────────────────────────────────────────────────────────────────
app.post('/api/previsao/gerar-pdf',
  requireAuth, requireServiceRoleKey, express.json({ limit: '2mb' }),
  async (req, res) => {
  // Bloqueia authMode internal - precisa de usuario real para gerado_por
  if (req.authMode === 'internal') {
    return res.status(400).json({ erro: 'usuario_obrigatorio', detalhe: 'gerar-pdf requer autenticacao Supabase' });
  }

  if (!PREVISAO_PDF_API_URL) {
    return res.status(503).json({ erro: 'previsao_pdf_nao_configurado' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ erro: 'storage_nao_configurado' });
  }

  const { previsao_id, config_rateio } = req.body || {};

  // Validacao basica
  if (!previsao_id || typeof previsao_id !== 'string' || !/^[0-9a-f-]{36}$/.test(previsao_id)) {
    return res.status(400).json({ erro: 'previsao_id_invalido' });
  }
  if (!config_rateio || typeof config_rateio.apartamentos !== 'number' || config_rateio.apartamentos < 1) {
    return res.status(400).json({ erro: 'config_rateio_invalido', detalhe: 'apartamentos obrigatorio e >= 1' });
  }

  const userId = req.user.sub;
  const role = getRoleFromPayload(req.user);

  try {
    // 1) Busca previsao no banco
    const buscaPrev = await supabaseAdminRequest('GET',
      `/rest/v1/previsoes_orcamentarias?id=eq.${encodeURIComponent(previsao_id)}&select=id,payload_json,payload_hash,criado_por`
    );
    if (buscaPrev.status >= 400 || !Array.isArray(buscaPrev.body) || !buscaPrev.body.length) {
      return res.status(404).json({ erro: 'previsao_nao_encontrada' });
    }
    const previsao = buscaPrev.body[0];

    // Controle de visibilidade: OPERACIONAL so ve o proprio
    if (!['GESTOR', 'GERENTE'].includes(role) && previsao.criado_por !== userId) {
      return res.status(404).json({ erro: 'previsao_nao_encontrada' });
    }

    const payloadHash = previsao.payload_hash;
    const payloadJson = previsao.payload_json;

    // Monta config completa com defaults
    const configCompleto = {
      apartamentos: config_rateio.apartamentos,
      coberturas: config_rateio.coberturas != null ? config_rateio.coberturas : 0,
      fator_cobertura: config_rateio.fator_cobertura != null ? config_rateio.fator_cobertura : 1.5,
      fundo_reserva: config_rateio.fundo_reserva != null ? config_rateio.fundo_reserva : 0.0,
      fundo_pct: config_rateio.fundo_pct != null ? config_rateio.fundo_pct : 0.05,
    };

    // 2) Checa cache em previsoes_geracoes
    const cacheKey = payloadHash + ':' + JSON.stringify(configCompleto);
    const hashCache = require('crypto').createHash('md5').update(cacheKey).digest('hex');
    const buscaCache = await supabaseAdminRequest('GET',
      `/rest/v1/previsoes_geracoes?previsao_id=eq.${encodeURIComponent(previsao_id)}&payload_hash=eq.${encodeURIComponent(hashCache)}&order=gerado_em.desc&limit=1&select=id,pptx_url,pdf_url,gerado_em,duracao_ms`
    );
    if (buscaCache.status < 400 && Array.isArray(buscaCache.body) && buscaCache.body.length) {
      const cached = buscaCache.body[0];
      // Extrai objectPath do pptx_url original (armazenado como path, nao como signed URL)
      // Formato armazenado: "previsao_id/hashCache.pptx" e "previsao_id/hashCache.pdf"
      const pptxPath = `${previsao_id}/${hashCache}.pptx`;
      const pdfPath = `${previsao_id}/${hashCache}.pdf`;
      try {
        const pptxUrl = await supabaseStorageSignedUrl('previsao-arquivos', pptxPath, 600);
        const pdfUrl = await supabaseStorageSignedUrl('previsao-arquivos', pdfPath, 600);
        return res.status(200).json({
          pptx_url: pptxUrl,
          pdf_url: pdfUrl,
          gerado_em: cached.gerado_em,
          cached: true,
          duracao_ms: cached.duracao_ms,
        });
      } catch (signErr) {
        console.warn('[previsao/gerar-pdf] signed url cache falhou, regenerando:', signErr.message);
        // Continua para regenerar
      }
    }

    // 3) Cache miss: chama microservico
    const microPayload = JSON.stringify({
      previsao_id,
      payload_json: payloadJson,
      payload_hash: payloadHash,
      config_rateio: configCompleto,
    });

    const microUrl = new URL('/gerar', PREVISAO_PDF_API_URL);
    const microCliente = microUrl.protocol === 'https:' ? https : http;

    const microResp = await new Promise((resolve, reject) => {
      const opts = {
        hostname: microUrl.hostname,
        port: microUrl.port || (microUrl.protocol === 'https:' ? 443 : 80),
        path: microUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(microPayload),
          'X-Internal-Secret': INTERNAL_API_SECRET,
        },
      };
      const timer = setTimeout(() => reject(new Error('timeout_microservico')), 180000);
      const mReq = microCliente.request(opts, r => {
        let d = '';
        r.on('data', c => { d += c; });
        r.on('end', () => {
          clearTimeout(timer);
          let body = null;
          try { body = JSON.parse(d); } catch { body = { raw: d.slice(0, 200) }; }
          resolve({ status: r.statusCode, body });
        });
      });
      mReq.on('error', e => { clearTimeout(timer); reject(e); });
      mReq.write(microPayload);
      mReq.end();
    });

    if (microResp.status === 422) {
      return res.status(422).json({ erro: 'payload_invalido_para_geracao' });
    }
    if (microResp.status !== 200 || !microResp.body || !microResp.body.pptx_b64 || !microResp.body.pdf_b64) {
      console.error('[previsao/gerar-pdf] microservico retornou erro:', microResp.status);
      return res.status(503).json({ erro: 'geracao_falhou' });
    }

    const pptxBuffer = Buffer.from(microResp.body.pptx_b64, 'base64');
    const pdfBuffer = Buffer.from(microResp.body.pdf_b64, 'base64');
    const duracaoMs = microResp.body.duracao_ms || 0;

    // 4) Upload pro Storage
    const pptxPath = `${previsao_id}/${hashCache}.pptx`;
    const pdfPath = `${previsao_id}/${hashCache}.pdf`;
    const MIME_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

    await Promise.all([
      supabaseStorageUpload('previsao-arquivos', pptxPath, pptxBuffer, MIME_PPTX),
      supabaseStorageUpload('previsao-arquivos', pdfPath, pdfBuffer, 'application/pdf'),
    ]);

    // 5) INSERT em previsoes_geracoes
    const geradoEm = new Date().toISOString();
    const ins = await supabaseAdminRequest('POST', '/rest/v1/previsoes_geracoes', {
      previsao_id,
      payload_hash: hashCache,
      pptx_url: pptxPath,
      pdf_url: pdfPath,
      gerado_por: userId,
      gerado_em: geradoEm,
      duracao_ms: duracaoMs,
    });
    if (ins.status >= 400) {
      console.error('[previsao/gerar-pdf] erro insert geracao:', ins.status);
      // Nao aborta: arquivos ja foram salvos, erro na auditoria nao deve bloquear usuario
    }

    // 6) Gera signed URLs (10min)
    const [pptxUrl, pdfUrl] = await Promise.all([
      supabaseStorageSignedUrl('previsao-arquivos', pptxPath, 600),
      supabaseStorageSignedUrl('previsao-arquivos', pdfPath, 600),
    ]);

    return res.status(200).json({
      pptx_url: pptxUrl,
      pdf_url: pdfUrl,
      gerado_em: geradoEm,
      cached: false,
      duracao_ms: duracaoMs,
    });
  } catch (e) {
    if (e.message === 'timeout_microservico') {
      return res.status(504).json({ erro: 'timeout_geracao' });
    }
    console.error('[previsao/gerar-pdf] erro inesperado:', e.message);
    return res.status(500).json({ erro: 'erro_interno' });
  }
});

// Middleware 404 para rotas /api/* desconhecidas.
// Posicionado depois de todas as rotas reais de /api e antes do catch-all geral.
// Retorna JSON estruturado e loga via console.warn (404 é erro de cliente, não falha de servidor).
app.use('/api', (req, res) => {
  console.warn(JSON.stringify({
    evento: 'api_404',
    metodo: req.method,
    caminho: req.baseUrl + req.path,
    ip: req.ip,
    timestamp: new Date().toISOString()
  }));
  res.status(404).json({
    erro: 'rota não encontrada',
    metodo: req.method,
    caminho: req.baseUrl + req.path
  });
});

// Impede o navegador de servir uma versão antiga do HTML em cache. É o que garante
// que o usuário sempre pegue o index.html mais novo (evita gerar a ata pela versão
// antiga, que usava window.print e injetava data/URL). Só afeta o HTML; os assets
// (jsPDF, fonte) continuam cacheáveis normalmente.
function semCacheHtml(res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

// Rota raiz: serve a landing page ServiceZone
app.get('/', (req, res) => { semCacheHtml(res); res.sendFile(path.join(__dirname, 'public', 'landing.html')); });

// Rota do sistema principal, acessada a partir do botão Entrar na landing
app.get('/hub', (req, res) => { semCacheHtml(res); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// Qualquer rota desconhecida cai na landing, não no sistema
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.listen(PORT, () => console.log('Service Hub porta ' + PORT));
