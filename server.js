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
app.post('/api/assemblyai/upload', requireAuth, express.raw({type:'*/*', limit:'5gb'}), (req, res) => {
  const opts = { hostname:'api.assemblyai.com', path:'/v2/upload', method:'POST', headers:{'authorization':ASSEMBLYAI_KEY,'content-type':'application/octet-stream','content-length':req.body.length} };
  const pr = https.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res.json(JSON.parse(d))}catch(e){res.status(500).json({error:d})} }); });
  pr.on('error', e => res.status(500).json({error:e.message}));
  pr.write(req.body); pr.end();
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
// Engine de geração de ata — Sonnet 4.6 com fallback Opus 4.7
//
// Pipeline (até 3 tentativas):
//   1. Sonnet 4.6 + max_tokens 16000 → validarAta
//   2. Se inválida: Sonnet 4.6 + max_tokens 20000
//   3. Se inválida: Opus 4.7 + max_tokens 20000 (fallback)
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
const REGRAS_FIDELIDADE_TRANSCRICAO = `REGRAS DE FIDELIDADE FACTUAL À TRANSCRIÇÃO

Estas regras têm PRIORIDADE MÁXIMA sobre fluência e completude. A ata deve ser fiel ao que a transcrição sustenta, mesmo à custa de um documento com várias marcações [a confirmar]. Prefira a ata "incompleta mas correta" à ata "fluente mas inventada".

FID 1. NUNCA INVENTAR, COMPLETAR OU ADIVINHAR
Qualquer fato que não esteja explicitamente na transcrição (ou em outra fonte oficial anexada, como edital) precisa ir como [a confirmar] no lugar exato do dado. Isso inclui nomes próprios, sobrenomes, números de votos, valores em reais, datas, números de unidade, cargos, quantidades de parcelas, percentuais e qualquer outro dado pontual. É PROIBIDO substituir uma lacuna por palpite plausível, mesmo que pareça óbvio pelo contexto. Quando o contexto sugere algo mas a transcrição não confirma, registre [a confirmar] e nada além.

FID 2. NÚMEROS SÃO LITERAIS
Todo número (valor financeiro, quantidade de votos, percentual, número de parcelas, anos, datas) deve ser transcrito exatamente como aparece na transcrição. É PROIBIDO recalcular, arredondar, somar, inferir ou ajustar qualquer número. Se um número aparece de forma ambígua ou parcial, registrar o trecho disponível seguido de [a confirmar]. Se a transcrição não diz o número, escrever [valor a confirmar] ou [número a confirmar] e nada mais.

FID 3. NOMES PRÓPRIOS NÃO SÃO COMPLETADOS
Se a pessoa é citada apenas pelo primeiro nome, registrar apenas o primeiro nome seguido de [sobrenome a confirmar]. Se há dúvida entre nome civil e apelido (caso real: a transcrição menciona alguém ora como "Wellington", ora como "Eriton"), registrar AMBOS na forma "Wellington (Eriton)" sem escolher um. Nunca completar "Cris" para "Cristina" ou "Cristiano". Nunca substituir o apelido pelo suposto nome civil sem confirmação explícita.

FID 4. VARREDURA PRÉ FECHAMENTO
Antes de finalizar a ata, varrer a transcrição inteira item por item e garantir que nenhum fato relevante foi omitido. Atenção especial obrigatória a: composição da arrecadação (taxa de condomínio, fundo de reserva, multas, juros), valor total arrecadado no período, número de meses de superávit no exercício, renegociações com concessionárias (CESAN, EDP, Vivo, NET), impacto de obras específicas em meses específicos do período, parcelamentos de inadimplência, esclarecimentos técnicos ou jurídicos dados a condôminos. Se a transcrição menciona, a ata REGISTRA.

FID 5. SEM HÍFEN OU TRAVESSÃO NO CORPO DA ATA
Proibido usar hífen "-" ou travessão "–" no texto corrido dos itens da ata e na abertura. Use vírgula, ponto e vírgula ou frase nova no lugar. EXCEÇÕES EXPLÍCITAS desta regra, que permanecem regidas pela SKILL.md acima: (a) travessões do cabeçalho de endereço, formato "Logradouro – Bairro – Cidade/UF"; (b) travessões da linha de cargo das assinaturas, formato "Cargo – Tratamento Nome"; (c) travessão do título do anexo, formato "ANEXO I – TÍTULO". Nenhuma OUTRA ocorrência de hífen ou travessão é permitida.`;

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
(c) Se a transcrição NÃO sustenta o item, substitua o item pela marcação [a confirmar] entre colchetes, mantendo a estrutura da frase. Exemplos concretos:
    "Sr. Wellington (Eriton) Pabodo" vira "Sr. Wellington (Eriton) [sobrenome a confirmar]" se Pabodo não aparece na transcrição.
    "vinte e três (23) votos" vira "[número de votos a confirmar] votos" se a transcrição não confirma esse número exato.
    "R$ 762.000,00" vira "R$ [valor a confirmar]" se a transcrição não confirma esse valor.
(d) Se um fato relevante da transcrição foi OMITIDO na ata (composição da arrecadação, número de meses de superávit, renegociação com concessionária, impacto de obras em meses específicos), INCLUA o fato no item correspondente, sempre com base literal na transcrição.

REGRAS DE SAÍDA:
1. Devolva APENAS a ata corrigida, do cabeçalho até a última linha de assinatura. Nada antes, nada depois. Sem comentários, sem lista de mudanças, sem "Aqui está a ata auditada".
2. Mantenha exatamente a formatação do documento: prosa corrida, sem markdown, sem bullets, CAIXA ALTA para destaques, ITEM N) para itens, travessões "–" apenas onde a SKILL.md prescreve (endereço, linha de cargo das assinaturas, título de anexo).
3. Se você conferir que a ata está 100% fiel e nada precisa mudar, devolva a ata idêntica à entrada, sem modificar uma vírgula.`;

// Segundo passe: roda Sonnet 4.6 com a ata + transcrição original e devolve a ata
// corrigida. Sem fallback. Em caso de erro, retorna null e o caller usa a ata original.
async function auditarFidelidadeAta(ataGerada, userMessageOriginal) {
  const auditMessage = '=== ATA GERADA (a auditar) ===\n' + ataGerada +
    '\n\n=== TRANSCRIÇÃO ORIGINAL E DADOS DA REUNIÃO ===\n' + userMessageOriginal +
    '\n\nAudite a ata acima contra a transcrição e devolva a ata corrigida seguindo o procedimento e as regras de saída.';
  // max_tokens alinhado com a tentativa 1 do passe principal (regra reviewer.md: ≤16000).
  // Auditoria substitui trechos por [a confirmar] e adiciona fatos curtos — não expande conteúdo.
  const r = await chamarAnthropicAta('claude-sonnet-4-6', 16000, PROMPT_AUDITORIA, auditMessage);
  if (!r.ok || !r.texto) {
    console.warn('[engine-ata] Segundo passe de auditoria falhou (status ' + (r.status || 'sem_status') + '): ' + (r.erro || 'sem_texto'));
    return null;
  }
  return r.texto;
}

// Validação heurística pós-geração — detecta truncamento e formato quebrado.
// Critérios derivados das atas de referência do handoff:
//   - tem frase de encerramento padrão
//   - termina com ponto final (não foi cortada no meio)
//   - tem pelo menos 4 blocos de assinatura (Síndico, Presidente, Secretária, Administradora)
//   - tem tamanho mínimo plausível (atas reais têm 6000+ chars)
function validarAta(resposta) {
  if (!resposta || typeof resposta !== 'string') return { valido: false, motivo: 'resposta_vazia' };
  const temEncerramento = resposta.includes('Nada mais havendo a tratar');
  const blocosAssinatura = (resposta.match(/_{30,}/g) || []).length;
  const tamanhoOk = resposta.length > 6000;
  // Markdown count — qualquer marcador acima do limiar invalida (forçando retry/Opus)
  const headers = (resposta.match(/^#{1,6} /gm) || []).length;
  const negritos = (resposta.match(/\*\*[^*]+\*\*/g) || []).length;
  const tabelas = (resposta.match(/^\|/gm) || []).length;
  const separadores = (resposta.match(/^---+$/gm) || []).length;
  // Pré-análise: ata real começa com "ATA DA ASSEMBLEIA" ou nome do condomínio em CAIXA ALTA.
  // Se a resposta começa com "Vou processar", "Mapeamento", "##", etc → pré-conteúdo presente
  const inicio = resposta.trim().slice(0, 200).toLowerCase();
  const temPreAnalise = /vou (processar|analisar|redigir|mapear)|mapeamento|reconstituindo|aqui (est[aá]|vai)|^##|^---|^an[aá]lise/m.test(inicio);

  if (!temEncerramento) return { valido: false, motivo: 'sem_encerramento' };
  if (blocosAssinatura < 4) return { valido: false, motivo: 'assinaturas_insuficientes', encontradas: blocosAssinatura };
  if (!tamanhoOk) return { valido: false, motivo: 'muito_curta', tamanho: resposta.length };
  if (temPreAnalise) return { valido: false, motivo: 'pre_analise_presente', inicio: resposta.trim().slice(0, 100) };
  if (headers > 0) return { valido: false, motivo: 'markdown_headers', count: headers };
  if (negritos > 5) return { valido: false, motivo: 'markdown_negritos_excessivos', count: negritos };
  if (tabelas > 0) return { valido: false, motivo: 'markdown_tabelas', count: tabelas };
  if (separadores > 0) return { valido: false, motivo: 'markdown_separadores', count: separadores };
  return { valido: true };
}

// Wrapper Promise pra chamada Anthropic /v1/messages com timeout 120s.
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
      timeout: 120000
    };
    const r = https.request(opts, (resp) => {
      let d = '';
      resp.on('data', (c) => d += c);
      resp.on('end', () => {
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
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, status: 504, erro: 'timeout_120s' }); });
    r.write(body); r.end();
  });
}

app.post('/api/atas/gerar', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ erro: 'anthropic_key_ausente' });
  if (!ATA_SKILL_MD) return res.status(500).json({ erro: 'skill_md_nao_carregada', detalhe: 'skills-server/ata-condominial.md não encontrada no servidor' });

  const userMessage = (req.body && req.body.userMessage) || '';
  if (typeof userMessage !== 'string' || userMessage.length < 50) {
    return res.status(400).json({ erro: 'userMessage_invalido', detalhe: 'envie a transcrição + dados da reunião como string em userMessage (mín 50 chars)' });
  }

  const system = ATA_SKILL_MD + '\n\n---\n\n' + CONTEXTO_GRUPO_SERVICE + '\n\n---\n\n' + REGRAS_ANTI_ERRO + '\n\n---\n\n' + REGRAS_FIDELIDADE_TRANSCRICAO;
  const tentativas = [];

  // Helper local pra encadear segundo passe de auditoria e padronizar resposta.
  // Invariante: toda ata entregue ao frontend passou por validarAta.
  // Se a auditoria devolver texto que falha na validação heurística (markdown,
  // pré-análise, encerramento removido, assinaturas perdidas), descartamos a saída
  // do segundo passe e devolvemos a ata original validada.
  async function entregarAtaAuditada(texto, modelo_usado, tentativaIdx, extras) {
    const auditada = await auditarFidelidadeAta(texto, userMessage);
    let ataFinal = texto;
    let auditoriaStatus = 'falhou_usou_original';
    if (auditada) {
      const vAud = validarAta(auditada);
      if (vAud.valido) {
        ataFinal = auditada;
        auditoriaStatus = 'aplicada';
      } else {
        auditoriaStatus = 'rejeitada_validacao_usou_original';
        tentativas[tentativaIdx].auditoria_validacao = vAud;
        console.warn('[engine-ata] Segundo passe rejeitado pela validação heurística:', JSON.stringify(vAud));
      }
    }
    tentativas[tentativaIdx].auditoria = auditoriaStatus;
    return res.json(Object.assign({ ata: ataFinal, modelo_usado, tentativas, auditoria: auditoriaStatus }, extras || {}));
  }

  // Tentativa 1: Sonnet 4.6 + 16k
  let r = await chamarAnthropicAta('claude-sonnet-4-6', 16000, system, userMessage);
  tentativas.push({ modelo: 'claude-sonnet-4-6', max_tokens: 16000, status: r.status, erro: r.erro || null });
  if (r.ok) {
    const v = validarAta(r.texto);
    tentativas[0].validacao = v;
    if (v.valido) return entregarAtaAuditada(r.texto, 'claude-sonnet-4-6', 0);
  }

  // Tentativa 2: Sonnet 4.6 + 20k (max_tokens +25%)
  r = await chamarAnthropicAta('claude-sonnet-4-6', 20000, system, userMessage);
  tentativas.push({ modelo: 'claude-sonnet-4-6', max_tokens: 20000, status: r.status, erro: r.erro || null });
  if (r.ok) {
    const v = validarAta(r.texto);
    tentativas[1].validacao = v;
    if (v.valido) return entregarAtaAuditada(r.texto, 'claude-sonnet-4-6', 1);
  }

  // Tentativa 3: Opus 4.7 fallback. Logado pra acompanhar frequência em prod.
  console.warn('[engine-ata] Fallback Opus 4.7 acionado após 2 tentativas Sonnet inválidas. Tentativas:', JSON.stringify(tentativas));
  r = await chamarAnthropicAta('claude-opus-4-7', 20000, system, userMessage);
  tentativas.push({ modelo: 'claude-opus-4-7', max_tokens: 20000, status: r.status, erro: r.erro || null });
  if (r.ok) {
    const v = validarAta(r.texto);
    tentativas[2].validacao = v;
    if (v.valido) return entregarAtaAuditada(r.texto, 'claude-opus-4-7', 2, { fallback: true });
  }

  // 3 tentativas falharam — devolve erro estruturado pro frontend explicar o motivo
  return res.status(502).json({
    erro: 'engine_falhou_3x',
    detalhe: 'Nenhuma das 3 tentativas produziu ata válida',
    tentativas,
    ultima_resposta: r.texto ? r.texto.slice(0, 2000) + (r.texto.length > 2000 ? '...[truncado]' : '') : null
  });
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
    },
  };
  if (req.headers['content-length']) {
    opts.headers['Content-Length'] = req.headers['content-length'];
  }
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
      const status = e.code === 'ECONNREFUSED' ? 503 : 502;
      res.status(status).json({ erro: 'previsao_api_indisponivel', detalhe: e.message });
    }
  });
  req.pipe(upstream);
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

// Rota raiz: serve a landing page ServiceZone
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

// Rota do sistema principal, acessada a partir do botão Entrar na landing
app.get('/hub', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Qualquer rota desconhecida cai na landing, não no sistema
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.listen(PORT, () => console.log('Service Hub porta ' + PORT));
