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
// T17: não anunciar a tecnologia do servidor nas respostas.
app.disable('x-powered-by');

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
// Conexao nativa com o Superlogica: as chaves ficam SO no servidor (ENV do Railway) e todo
// usuario logado usa a rota /api/superlogica/*, sem colar token nem proxy no navegador.
// Sem as duas ENVs, o Hub volta ao modo antigo (tokens e proxy por navegador).
const SUPERLOGICA_APP_TOKEN = process.env.SUPERLOGICA_APP_TOKEN || '';
const SUPERLOGICA_ACCESS_TOKEN = process.env.SUPERLOGICA_ACCESS_TOKEN || '';
const SUPERLOGICA_API_BASE = (process.env.SUPERLOGICA_API_BASE || 'https://api.superlogica.net').replace(/\/+$/, '');
function superlogicaNativa() { return !!(SUPERLOGICA_APP_TOKEN && SUPERLOGICA_ACCESS_TOKEN); }

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
const RATE_LIMIT_MAX_GERAL = parseInt(process.env.RATE_LIMIT_MAX || '60', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const rateBuckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (bucket.resetAt < now) rateBuckets.delete(ip);
  }
}, 5 * 60 * 1000).unref();

const RATE_LIMIT_SUPERLOGICA_MAX = parseInt(process.env.RATE_LIMIT_SUPERLOGICA_MAX || '600', 10);

function rateLimit(req, res, next) {
  const ehSuperlogica = req.path.startsWith('/superlogica/');
  const ip = (req.ip || 'unknown') + (ehSuperlogica ? '|sl' : '');
  const RATE_LIMIT_MAX = ehSuperlogica ? RATE_LIMIT_SUPERLOGICA_MAX : RATE_LIMIT_MAX_GERAL;
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

// T16: lista de bloqueados lida do banco a cada 20s (sem coluna ainda: ninguém bloqueado).
let _bloqueados = new Set();
let _bloqueadosAte = 0;
let _bloqueadosLendo = null;
async function usuarioBloqueado(id) {
  if (Date.now() > _bloqueadosAte && SUPABASE_SERVICE_ROLE_KEY && !_bloqueadosLendo) {
    _bloqueadosAte = Date.now() + 20000;
    _bloqueadosLendo = supabaseAdminRequest('GET', '/rest/v1/profiles?bloqueado=eq.true&select=id').then((r) => {
      if (r.status === 200 && Array.isArray(r.body)) _bloqueados = new Set(r.body.map((x) => x.id));
    }).catch(() => {}).finally(() => { _bloqueadosLendo = null; });
  }
  if (_bloqueadosLendo) await _bloqueadosLendo;
  return _bloqueados.has(id);
}
function esquecerBloqueios() { _bloqueadosAte = 0; }

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
    verifySupabaseJwt(token).then(async (payload) => {
      if (!payload) return res.status(401).json({ erro: 'token_invalido' });
      // T16: usuário bloqueado pelo dono cai na hora, mesmo com sessão aberta.
      if (await usuarioBloqueado(payload.sub)) {
        try { req.user = payload; req.authMode = 'supabase'; auditoria.evento(req, 'bloqueado_tentou_usar', null, true, 'usuario_bloqueado'); } catch (e) { /* segue */ }
        req.user = undefined;
        return res.status(401).json({ erro: 'usuario_bloqueado', detalhe: 'Seu acesso foi bloqueado. Fale com a administração.' });
      }
      req.user = payload; req.authMode = 'supabase'; return next();
    }).catch(() => res.status(401).json({ erro: 'token_invalido' }));
    return;
  }
  res.status(401).json({ erro: 'token_invalido' });
}

// index: false impede que o express.static sirva index.html automaticamente para "/"
// assim as rotas explícitas abaixo controlam o que aparece em cada caminho
// T17: arquivos do sistema entregues sem comentários e compactados (preparados ao ligar).
const ofuscar = require('./servico/ofuscar');
ofuscar.registrar(path.join(__dirname, 'public'));
app.use(ofuscar.middleware);
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Aplica rate-limit + auth em todos os /api/* (exceto /api/config que é público)
app.use('/api', rateLimit);

// ─────────────────────────────────────────────────────────────────────────
// T16 e T17: perfil com cache curto, condomínios da base, auditoria e processamento.
// ─────────────────────────────────────────────────────────────────────────
const _perfilCache = new Map(); // userId -> { p, ate }
async function perfilDe(req) {
  if (req.authMode === 'internal') return { role: 'GESTOR', permissoes: {} };
  const id = req.user && req.user.sub;
  if (!id) return null;
  const c = _perfilCache.get(id);
  if (c && c.ate > Date.now()) return c.p;
  const p = await lerPerfil(id).catch(() => null);
  if (p) _perfilCache.set(id, { p, ate: Date.now() + 30000 }); // falha passageira não fica guardada
  return p;
}
function esquecerPerfil(id) {
  _perfilCache.delete(id);
  if (typeof _cachePerfilSL !== 'undefined') _cachePerfilSL.delete(id);
  try { carteiraT18.esquecer(id); } catch (e) { /* carteira ainda não criada no boot */ }
}
// Ação marcada explicitamente (as restritas e as que não vêm com o cargo).
function temAcao(p, modulo, acao) {
  const m = p && p.permissoes && p.permissoes[modulo];
  return !!(m && Array.isArray(m.acoes) && m.acoes.includes(acao));
}
// Módulo liberado (o GESTOR tem todos os módulos comuns).
function podeModulo(p, modulo, acao) {
  if (!p) return false;
  if (p.role === 'GESTOR') return true;
  const m = p.permissoes && p.permissoes[modulo];
  return !!(m && m.visivel === true && (!acao || (Array.isArray(m.acoes) && m.acoes.includes(acao))));
}
// Condomínio está na base do sistema (lista sincronizada do Superlógica)?
const _condBase = new Map(); // id -> { c, ate }
async function condominioDaBase(id) {
  const k = String(id);
  const c = _condBase.get(k);
  if (c && c.ate > Date.now()) return c.c;
  const r = await supabaseAdminRequest('GET', '/rest/v1/condominios?id_superlogica=eq.' + encodeURIComponent(k) + '&select=nome,id_superlogica&limit=1');
  let v = r.status === 200 && Array.isArray(r.body) && r.body[0] ? { nome: r.body[0].nome, id: r.body[0].id_superlogica } : null;
  // Também tem de existir no Superlógica da empresa (linha antiga ou manual na tabela não basta).
  // Se o Superlógica estiver fora do ar, vale a tabela (que só o servidor grava).
  if (v && superlogicaNativa()) {
    try {
      const cli = require('./superlogica-dados').criarCliente({ base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN });
      const j = await cli.get('condominios/get', { id: k, somenteCondominiosAtivos: 0 });
      const c0 = Array.isArray(j) ? j[0] : j;
      if (!c0 || String(c0.id_condominio_cond) !== k) v = null;
    } catch (e) {
      if (e && e.status && e.status < 500 && e.status !== 429) v = null;
      else console.warn('[base] Superlógica sem resposta ao conferir ' + k + '; usando a tabela');
    }
  }
  _condBase.set(k, { c: v, ate: Date.now() + (v ? 6 * 3600 * 1000 : 5 * 60 * 1000) });
  return v;
}
const auditoria = require('./servico/auditoria').criarAuditoria({ banco: supabaseAdminRequest, perfilDe, temAcao });
app.use('/api', auditoria.middleware);
const processar = require('./servico/processar');
// T42: nome dos modelos num lugar só (servico/modelos.js) e custo de cada chamada (servico/custo.js).
const modelos = require('./servico/modelos');
const custo = require('./servico/custo');
// Marcador do modelo da ata dentro do motor: vira modelos.modelo('ata') (ou o modelo de teste
// interno) na hora da chamada. Antes da T42 o motor usava o nome antigo como marcador.
const MODELO_DA_ATA = 'modelo_da_ata';
const audioMod = require('./servico/audio');
const ataMensagem = require('./servico/ata-mensagem');
const permRegras = require('./servico/permissoes');

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
    ambiente: isSupabaseDev() ? 'dev' : 'producao',
    // true quando as chaves do Superlogica estao no servidor (o valor nunca sai daqui)
    superlogicaNativa: superlogicaNativa()
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/superlogica/v2/condor/* — ponte autenticada com a API do Superlogica.
// O navegador chama esta rota com o JWT do usuario; o servidor injeta app_token e
// access_token das ENVs e repassa pra api.superlogica.net. O token nunca vai pro front.
// Liberado pra GESTOR e pra quem tem pelo menos um modulo alem do Dashboard (perfil
// lido do banco, cache curto pra nao pesar em importacao em lote).
// ─────────────────────────────────────────────────────────────────────────
const _cachePerfilSL = new Map(); // userId -> { ok, chaves, ate }
async function acessoSuperlogica(userId) {
  const c = _cachePerfilSL.get(userId);
  if (c && c.ate > Date.now()) return c;
  const p = await lerPerfil(userId);
  const ok = !!(p && (p.role === 'GESTOR' || Object.entries(p.permissoes || {}).some(([m, v]) => m !== 'dashboard' && v && v.visivel === true)));
  const v = { ok, chaves: temVerChaves(p), ate: Date.now() + 60 * 1000 };
  _cachePerfilSL.set(userId, v);
  return v;
}
async function podeUsarSuperlogica(userId) {
  return (await acessoSuperlogica(userId)).ok;
}

// Chaves internas do Superlógica (tokens de cobrança, credenciais e chaves PJ, senhas) que
// alguns endpoints devolvem, como o condominios/get. Só quem tem a ação
// configuracoes.ver_chaves recebe o valor; para os outros o proxy troca por asteriscos.
// A ação não vem com o cargo: é dada a uma pessoa e só quem já tem pode liberar para outra.
function temVerChaves(perfil) {
  const c = perfil && perfil.permissoes && perfil.permissoes.configuracoes;
  return !!(c && c.visivel === true && Array.isArray(c.acoes) && c.acoes.includes('ver_chaves'));
}
// Para dar ou tirar a ação vale a presença na lista, mesmo com o módulo escondido.
function listaTemVerChaves(permissoes) {
  const c = permissoes && permissoes.configuracoes;
  return !!(c && Array.isArray(c.acoes) && c.acoes.includes('ver_chaves'));
}
// Palavra forte em qualquer ponto do nome; palavra curta só no começo de um pedaço do nome.
const RE_CONTEM_SENSIVEL = /(token|credencial|senha|password|passwd|secret|segredo|accesskey|apikey|privatekey)/i;
const RE_SEG_SENSIVEL = /^(chave|key|certificado|private|hash)/i;
function campoSensivel(k) {
  const s = String(k);
  if (RE_CONTEM_SENSIVEL.test(s.replace(/[_.\-\s]/g, ''))) return true;
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_.\-\s]+/).some((p) => RE_SEG_SENSIVEL.test(p));
}
function mascararSensiveis(v, prof) {
  prof = prof || 0;
  if (v == null || typeof v !== 'object') return v;
  if (prof > 20) return null; // nada da API tem essa profundidade; na dúvida, não repassa
  if (Array.isArray(v)) return v.map((x) => mascararSensiveis(x, prof + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    if (campoSensivel(k)) o[k] = (x == null || x === '') ? x : '********';
    else o[k] = mascararSensiveis(x, prof + 1);
  }
  return o;
}

// ─────────────────────────────────────────────────────────────────────────
// T18: carteira com bloqueio de verdade no servidor e módulos das abas Ficha do Condomínio,
// Cobrança e Comparativo. Regras e explicação em superlogica/carteira.js. Vem antes do proxy
// e das rotas: condomínio fora da carteira de quem chama recebe 403.
// ─────────────────────────────────────────────────────────────────────────
const carteiraT18 = require('./superlogica/carteira').criarCarteira({
  lerPerfil: (id) => lerPerfil(id),
  lerCarteirasPerfis: (id) => lerCarteirasPerfis(id),
  semColuna: () => lerCarteirasPerfis.semColuna === true,
  gruposCarteiras: () => gruposCarteiras(),
  ativo: () => !!(SUPABASE_SERVICE_ROLE_KEY && SUPABASE_URL && superlogicaNativa()),
  express,
  // Recusa da carteira vira registro suspeito com o motivo (o middleware da auditoria grava).
  aoNegar: (req, motivo) => { req._motivoNegado = motivo; },
});
app.use('/api/superlogica', requireAuth, carteiraT18.guardaProxy);
app.use('/api', carteiraT18.guardaRotas(requireAuth));
// Defesa em profundidade (revisão 1 da T18): toda rota com :idSuperlogica confere de novo,
// já com o parâmetro decodificado pelo Express e sem depender de maiúscula no caminho.
app.param('idSuperlogica', (req, res, next, valor) => {
  if (!/^[1-9][0-9]{0,8}$/.test(String(valor))) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  requireAuth(req, res, () => {
    carteiraT18.exigir(req, res, String(valor)).then((ok) => { if (ok) next(); }, next);
  });
});

app.use('/api/superlogica', requireAuth, async (req, res) => {
  if (!superlogicaNativa()) return res.status(503).json({ erro: 'superlogica_nao_configurado', detalhe: 'Chaves do Superlógica não configuradas no servidor.' });
  if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ erro: 'service_role_nao_configurada' });
  let verChaves = req.authMode === 'internal';
  if (req.authMode !== 'internal') {
    let ac = null;
    try { ac = await acessoSuperlogica(req.user && req.user.sub); } catch (e) { ac = null; }
    if (!ac || !ac.ok) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não tem acesso aos módulos do Superlógica.' });
    verChaves = ac.chaves === true;
  }
  // So repassa a API condor (nada de outros caminhos do host)
  if (!/^\/v2\/condor\/[A-Za-z0-9_\/.-]*(\?.*)?$/.test(req.url) || req.url.includes('..')) {
    return res.status(400).json({ erro: 'caminho_invalido' });
  }
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return res.status(405).json({ erro: 'metodo_nao_permitido' });
  const alvo = new URL(SUPERLOGICA_API_BASE + req.url);
  const headers = { app_token: SUPERLOGICA_APP_TOKEN, access_token: SUPERLOGICA_ACCESS_TOKEN };
  // GET e DELETE saem sem corpo (ver o fim desta rota): sem content-length nem content-type,
  // senão o Superlógica espera um corpo que nunca chega e o pedido fica pendurado.
  const semCorpo = req.method === 'GET' || req.method === 'DELETE';
  if (!semCorpo && req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (!semCorpo && req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  const pr = https.request({ hostname: alvo.hostname, path: alvo.pathname + alvo.search, method: req.method, headers, timeout: 120000 }, (r) => {
    const ct = String(r.headers['content-type'] || '');
    const status = r.statusCode || 502;
    const bloquear = (erro, detalhe) => {
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Disposition');
      res.status(erro === 'download_bloqueado' ? 403 : 502).json({ erro, detalhe });
    };
    // Quem vê as chaves, e PDF ou imagem para qualquer um, passa direto.
    if (verChaves || /^application\/pdf|^image\//i.test(ct)) {
      res.status(status);
      if (ct) res.setHeader('Content-Type', ct);
      if (r.headers['content-disposition']) res.setHeader('Content-Disposition', r.headers['content-disposition']);
      r.on('error', () => res.end());
      return r.pipe(res);
    }
    // O resto é lido inteiro para trocar as chaves internas por asteriscos.
    const partes = [];
    r.on('data', (c) => partes.push(c));
    r.on('error', () => { if (!res.headersSent) res.status(502).json({ erro: 'falha_superlogica' }); else res.end(); });
    r.on('end', () => {
      const bruto = Buffer.concat(partes);
      const txt = bruto.toString('utf8').replace(/^\uFEFF/, '');
      let json;
      if (/^\s*[{\[]/.test(txt)) { try { json = JSON.parse(txt); } catch (e) { json = undefined; } }
      if (json !== undefined) {
        res.status(status);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify(mascararSensiveis(json)));
      }
      // Arquivo que não é PDF nem imagem (planilha, zip): não dá para conferir por dentro.
      if (/zip|vnd\.|octet-stream|excel|spreadsheet/i.test(ct) || bruto.includes(0)) {
        return bloquear('download_bloqueado', 'Esse tipo de arquivo do Superlógica só sai para quem vê as chaves.');
      }
      // Texto: só repassa se não houver nome de campo sensível com valor.
      if (/(token|credencial|chave|accesskey|senha|password|secret|apikey)\w*\s*["']?\s*[:=]/i.test(txt)) {
        return bloquear('resposta_bloqueada', 'A resposta do Superlógica tinha dados internos e foi bloqueada.');
      }
      res.status(status);
      if (ct) res.setHeader('Content-Type', ct);
      res.end(bruto);
    });
  });
  pr.on('timeout', () => { pr.destroy(); if (!res.headersSent) res.status(504).json({ erro: 'timeout_superlogica' }); });
  pr.on('error', (e) => { if (!res.headersSent) res.status(502).json({ erro: 'falha_superlogica', detalhe: e.message }); });
  req.on('aborted', () => pr.destroy());
  if (semCorpo) pr.end(); else req.pipe(pr);
});

// ─────────────────────────────────────────────────────────────────────────
// T17: processamento de documentos e áudio SÓ pelo servidor. As antigas pontes
// abertas (que deixavam o navegador mandar qualquer pedido ao serviço de texto ou de
// transcrição) foram removidas. Cada rota tem pedido fixo, permissão e limite por hora.
// ─────────────────────────────────────────────────────────────────────────
const _limiteProc = new Map(); // user|tipo -> { n, ate }
function dentroDoLimite(req, tipo, maxHora) {
  if (req.authMode === 'internal') return true;
  const k = ((req.user && req.user.sub) || '?') + '|' + tipo;
  const agora = Date.now();
  let b = _limiteProc.get(k);
  if (!b || b.ate < agora) { b = { n: 0, ate: agora + 3600000 }; _limiteProc.set(k, b); }
  b.n++;
  return b.n <= maxHora;
}
function rotaProcessar(caminho, tipo, modulo, acao, maxHora, fn) {
  app.post(caminho, requireAuth, express.json({ limit: '12mb' }), async (req, res) => {
    const p = await perfilDe(req);
    if (req.authMode !== 'internal' && !podeModulo(p, modulo, acao)) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não tem acesso a essa função.' });
    if (!dentroDoLimite(req, tipo, maxHora)) {
      auditoria.evento(req, 'limite_processamento', { tipo }, true, 'volume_alto');
      return res.status(429).json({ erro: 'limite', detalhe: 'Muitos processamentos nesta hora. Tente mais tarde.' });
    }
    try {
      const r = await fn(req.body || {}, req.user && req.user.sub);
      res.status(r.status).json(r.corpo);
    } catch (e) {
      console.error('[processar ' + tipo + ']', e && e.message);
      res.status(500).json({ erro: 'falha_processamento', detalhe: 'Não foi possível processar agora. Tente de novo.' });
    }
  });
}
rotaProcessar('/api/processar/edital', 'edital', 'atas', null, 60, processar.processarEdital);
rotaProcessar('/api/processar/medidor', 'medidor', 'leitura_consumo', null, 600, processar.processarMedidor);
rotaProcessar('/api/processar/unidades', 'unidades', 'importar_unidades', 'normalizar', 300, processar.processarUnidades);

audioMod.criarRotasAudio(app, { requireAuth, express, banco: supabaseAdminRequest, perfilDe, temAcao, condominioDaBase,
  podeAtas: async (req) => req.authMode === 'internal' || podeModulo(await perfilDe(req), 'atas'),
  dentroDoLimite,
  auditar: (req, acao, det, susp) => auditoria.evento(req, acao, det, susp) });
require('./servico/rotas-seguranca').criarRotasSeguranca(app, { requireAuth, express, banco: supabaseAdminRequest, perfilDe, temAcao, auditoria,
  lerPerfil, esquecerPerfil, esquecerBloqueios, usoRecente: require('./servico/modelo').usoRecente });
// T42: registro do custo de cada chamada (tabela api_uso, só com o banco configurado) e o painel do dono.
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) custo.configurar({ banco: supabaseAdminRequest });
require('./servico/rotas-custo').criarRotasCusto(app, { requireAuth, banco: supabaseAdminRequest, auditoria });

// ─────────────────────────────────────────────────────────────────────────
// Engine de geração de ata — Sonnet 4.6 primário + Opus 4.7 último recurso CONDICIONAL.
//
// Pipeline (teto HARD de 7 chamadas Anthropic por geração, ver MAX_CHAMADAS_ANTHROPIC_POR_ATA):
//   1. Sonnet 4.6 + max_tokens 32000 → se retornou texto, ENTREGA (validação é só aviso).
//   2. Só se a API NÃO retornou texto (rede/timeout): 1 retry Sonnet 4.6 + 32000.
//   3. Auditoria de COMPLETUDE FRACIONADA: transcrição em 1-3 blocos (por tamanho), cada bloco
//      auditado (Sonnet) por lacunas + garantia determinística de todo valor monetário da fala.
//   4. Inserção CIRÚRGICA das lacunas (Sonnet), sem reescrever/condensar (guarda de tamanho).
//   5. OPUS só se a inserção Sonnet QUEBRAR (nunca por validação nem por valor individual).
// Validação nunca dispara retry (ver REGRA DE OURO). Anti-invenção/FID/DET preservados.
//
// System prompt = SKILL.md + contexto Grupo Service + anti-erro + detalhamento + fidelidade.
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

// [removido 2026-07-08] auditarFidelidadeAta (passe único de fidelidade) foi substituído
// pela auditoria de COMPLETUDE FRACIONADA (ver entregarAta). PROMPT_AUDITORIA acima ficou
// só como referência histórica do critério de fidelidade, não é mais chamado no pipeline.

// ─── Auditoria de COMPLETUDE FRACIONADA (2026-07-07) ───────────────────────
// Em atas longas (reunião de 3h) a auditoria única sobre ~36k tokens dilui a atenção
// e o Sonnet deixa passar valores (Enseada perdeu R$ 2.071,00 e R$ 2.500,00). Solução:
// dividir a transcrição em blocos e auditar cada um COM FOCO (menos volume por passada
// = mais exaustividade), consolidar lacunas, inserir CIRURGICAMENTE o que faltou (sem
// reescrever/condensar). Opus entra SÓ se a inserção Sonnet QUEBRAR (a guarda de
// tamanho/pareceAta rejeitar o resultado), nunca por validação nem por valor individual.
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

// ─── DOCUMENTOS DA ASSEMBLEIA (T01, 2026-10-20) ─────────────────────────────
// Apresentação, prestação de contas, orçamentos, propostas: PDFs anexados na aba Atas.
// São TEXTO ESCRITO, então valem como fonte oficial prioritária para números, nomes de
// empresas e nomes próprios (a transcrição é áudio e erra exatamente nesses três pontos,
// ver evidência congelada da fixture Casablanca). O front extrai o texto com pdf.js; PDF
// escaneado (sem camada de texto) vem em base64 e é lido aqui por uma chamada ao Claude
// com o PDF como documento. Tudo opcional: sem documento, o motor roda exatamente como antes.
const DOCS_APOIO_MAX = 6;                         // documentos por geração
const DOCS_APOIO_MAX_ESCANEADOS = 3;              // PDFs escaneados lidos pela IA por geração
const DOCS_APOIO_MAX_PDF_B64 = 11 * 1024 * 1024;  // ~8MB de PDF em base64
const DOCS_APOIO_MAX_CHARS_DOC = 80000;           // texto por documento (corta e avisa)
const DOCS_APOIO_MAX_CHARS_TOTAL = 150000;        // texto somado dos documentos
// Teto SEPARADO de chamadas de apoio (leitura de escaneado + conferência). Não mexe no teto
// do motor (MAX_CHAMADAS_ANTHROPIC_POR_ATA) para não roubar orçamento da auditoria.
// Pior caso: 3 leituras de escaneado + 1 conferência = 4.
const MAX_CHAMADAS_APOIO_POR_ATA = 4;

const REGRAS_DOCUMENTOS_APOIO = `REGRAS DOS DOCUMENTOS DA ASSEMBLEIA (APRESENTAÇÃO, PRESTAÇÃO DE CONTAS, ORÇAMENTOS, PROPOSTAS)

Junto com a transcrição podem vir DOCUMENTOS DA ASSEMBLEIA, que são texto ESCRITO e oficial (o que foi mostrado na tela, os orçamentos, a prestação de contas). Eles são a FONTE OFICIAL PRIORITÁRIA para três tipos de dado: (a) números (valores em reais, totais, saldos, percentuais, quantidades, datas de período); (b) nomes de empresas, fornecedores e prestadores; (c) nomes próprios de pessoas que constem por escrito.

DOC 1. PAPEL DE CADA FONTE. A transcrição diz o que foi FALADO e DELIBERADO (quem falou, o que foi votado, o resultado, as justificativas). O documento diz COMO SE ESCREVE o dado (o número exato, a grafia correta da empresa). Edital segue valendo para convocação, data, local, CNPJ e pauta.

DOC 2. DIVERGÊNCIA ENTRE ÁUDIO E DOCUMENTO. Quando a transcrição cita um valor, empresa ou nome que corresponde claramente a um dado do documento, mas com forma diferente (número próximo, empresa ouvida errado), USE A FORMA DO DOCUMENTO e coloque logo depois o marcador [conferir: transcrição dizia X], onde X é o que a transcrição trouxe. Exemplo: o documento traz "R$ 355.200,00" e a fala diz "355 mil", escreva "R$ 355.200,00 [conferir: transcrição dizia 355 mil]". Este marcador é a ÚNICA exceção autorizada à FID 6: é curto, cita só o que a transcrição trouxe, sem explicar motivo. Só use o marcador quando houver divergência real entre a FALA e o DOCUMENTO, e só quando a forma que você escreve estiver LITERALMENTE no documento. Variação de um nome dentro da própria transcrição (a fala chamou a mesma empresa de dois jeitos) NÃO é caso deste marcador: segue as regras de nome próprio (FID 3). Se a fala bate com o documento, escreva só o dado, sem marcador.

DOC 3. O DOCUMENTO NÃO CRIA FATO DA ASSEMBLEIA. Nunca registrar como aprovado, votado, decidido, APRESENTADO, LIDO ou EXPLICADO algo que só aparece no documento. O que aconteceu na reunião (quem apresentou o quê, votos, placar, aprovação, desfecho) vem SÓ da transcrição. Ter o documento anexado NÃO prova que ele foi apresentado: se a transcrição não mostra alguém apresentando aquele assunto nesta reunião, a ata não diz que ele foi apresentado. Exemplo do que é PROIBIDO: anexaram a prestação de contas, a fala não apresentou a prestação, e a ata escreve "a representante apresentou a prestação de contas, com saldo inicial de R$ X". Isso é invenção.

DOC 4. DETALHAMENTO PELO DOCUMENTO, SÓ ONDE A FALA TRATOU. Só quando a TRANSCRIÇÃO mostra que um assunto foi apresentado nesta reunião (alguém falando dele) e o documento detalha esse mesmo assunto, a ata pode trazer os números e nomes do documento para ele, na forma literal do documento. Nunca acrescentar número, saldo, total ou rubrica do documento em item onde a fala não tratou daquele assunto. Na dúvida, não use o documento para acrescentar: use só para corrigir a forma do que a fala citou (DOC 2).

DOC 5. ANTI-INVENÇÃO CONTINUA ABSOLUTA. Dado que não está nem na transcrição nem nos documentos nem no edital vira [a confirmar]. Nunca recalcular, somar ou arredondar número do documento.`;

// Prompt da leitura de PDF escaneado (sem camada de texto). Só transcreve, não interpreta.
const PROMPT_LEITURA_DOC_ESCANEADO = `Você recebe um PDF escaneado (imagem) de um documento apresentado numa assembleia de condomínio: apresentação, prestação de contas, orçamento ou proposta.

Tarefa: transcrever o TEXTO do documento, página por página, de forma fiel. Números exatamente como impressos (R$ 1.234,56), nomes de empresas e pessoas exatamente como escritos. Tabelas viram linhas de texto com as colunas separadas por " | ". Comece cada página com "PÁGINA N".

NUNCA invente, complete ou corrija dado. Trecho ilegível vira [ilegível]. Não resuma, não comente, não explique. Devolva só o texto transcrito.`;

// Prompt da conferência pré geração: transcrição x documentos. Lista só divergências.
const PROMPT_CONFERENCIA_DOCS = `Você confere a TRANSCRIÇÃO de uma assembleia de condomínio contra os DOCUMENTOS ESCRITOS apresentados nela (apresentação, prestação de contas, orçamentos, propostas).

Tarefa: listar cada VALOR em reais, NOME DE EMPRESA ou NOME PRÓPRIO citado na transcrição que corresponde claramente a um dado do documento, mas aparece na fala de forma DIFERENTE do documento (número próximo porém diferente, empresa ou pessoa com grafia ou nome ouvido errado).

REGRAS:
CONF 1. Uma divergência por linha, no formato exato:
DIVERGENCIA | transcrição: <como a fala trouxe> | documento: <como o documento escreve> | assunto: <item ou contexto em poucas palavras>
CONF 2. Só aponte quando a correspondência é clara pelo contexto (mesmo item de pauta, mesmo orçamento, mesma rubrica). Na dúvida se é o mesmo dado, NÃO aponte.
CONF 3. Fala arredondada ou informal que bate com o documento ("355 mil" para R$ 355.200,00) É divergência de forma: aponte, porque a ata vai usar o número exato do documento.
CONF 4. Não aponte o que é igual. Não aponte dado que só existe num dos lados.
CONF 5. Não invente. Não comente. Sem texto fora das linhas.
CONF 6. Se não houver nenhuma divergência, responda exatamente: NENHUMA DIVERGENCIA`;

// Valida e normaliza a lista de documentos que veio do front. Nunca lança: devolve
// { docs, erro }. Nome do arquivo é saneado (só exibição/prompt), texto é cortado no teto.
function normalizarDocumentosApoio(lista) {
  if (lista == null) return { docs: [] };
  if (!Array.isArray(lista)) return { docs: [], erro: 'documentos deve ser uma lista' };
  if (lista.length > DOCS_APOIO_MAX) return { docs: [], erro: 'no máximo ' + DOCS_APOIO_MAX + ' documentos por ata' };
  const docs = [];
  let escaneados = 0;
  for (const d of lista) {
    if (!d || typeof d !== 'object') continue;
    const nome = String(d.nome || 'documento.pdf').replace(/[\u0000-\u001f\u007f\[\]]/g, ' ').trim().slice(0, 120) || 'documento.pdf';
    const texto = typeof d.texto === 'string' ? d.texto : '';
    const b64 = typeof d.pdf_base64 === 'string' ? d.pdf_base64 : '';
    if (b64) {
      if (b64.length > DOCS_APOIO_MAX_PDF_B64) return { docs: [], erro: 'o documento ' + nome + ' passa de 8MB' };
      if (!/^[A-Za-z0-9+/=\s]+$/.test(b64.slice(0, 2000)) || !/^JVBER/.test(b64.replace(/\s+/g, '').slice(0, 8))) return { docs: [], erro: 'o documento ' + nome + ' não é um PDF válido' };
      if (++escaneados > DOCS_APOIO_MAX_ESCANEADOS) return { docs: [], erro: 'no máximo ' + DOCS_APOIO_MAX_ESCANEADOS + ' PDFs escaneados por ata' };
    }
    if (!texto.trim() && !b64) continue;
    docs.push({ nome, texto: texto.slice(0, DOCS_APOIO_MAX_CHARS_DOC), truncado: texto.length > DOCS_APOIO_MAX_CHARS_DOC, pdfBase64: b64 || null, origem: b64 ? 'leitura_ia' : 'texto' });
  }
  return { docs };
}

// Lê um PDF escaneado mandando o PDF como documento ao Claude. Devolve o texto ou ''.
async function lerDocumentoEscaneado(doc, chamarApoio) {
  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.pdfBase64.replace(/\s+/g, '') } },
    { type: 'text', text: 'Transcreva o texto deste documento conforme as regras.' }
  ];
  const r = await chamarApoio(MODELO_DA_ATA, 16000, PROMPT_LEITURA_DOC_ESCANEADO, content);
  if (r && r.raw && r.raw.stop_reason === 'max_tokens') doc.truncado = true; // leitura cortada: avisa
  return (r && r.ok && r.texto) ? r.texto.trim() : '';
}

// Bloco de texto com todos os documentos, respeitando o teto total de caracteres.
// Devolve { bloco, textoIncluido }: textoIncluido é SÓ o que o modelo vai ver (respeita o teto),
// e é ele que alimenta o grounding do gate e da consolidação de nomes.
function montarBlocoDocumentos(docs) {
  let restante = DOCS_APOIO_MAX_CHARS_TOTAL;
  const partes = [];
  const incluidos = [];
  docs.forEach((d, i) => {
    if (!d.texto) return;
    if (restante <= 0) { d.truncado = true; return; }
    const t = d.texto.slice(0, restante);
    restante -= t.length;
    if (t.length < d.texto.length) d.truncado = true;
    incluidos.push(t);
    partes.push('=== DOCUMENTO ' + (i + 1) + ': ' + d.nome + ' ===\n' + t);
  });
  if (!partes.length) return { bloco: '', textoIncluido: '' };
  return {
    bloco: '=== DOCUMENTOS DA ASSEMBLEIA (FONTE OFICIAL PRIORITÁRIA PARA NÚMEROS, EMPRESAS E NOMES) ===\n' + partes.join('\n\n'),
    textoIncluido: incluidos.join('\n')
  };
}

// Conferência pré geração: uma chamada Sonnet que lista as divergências transcrição x
// documento. Falha aberta: qualquer erro devolve '' e a geração segue sem a lista.
async function conferirTranscricaoComDocumentos(transcricao, blocoDocs, chamarApoio) {
  const msg = blocoDocs + '\n\n=== TRANSCRIÇÃO DA ASSEMBLEIA ===\n' + transcricao + '\n\nListe as divergências conforme as regras.';
  const r = await chamarApoio(MODELO_DA_ATA, 4000, PROMPT_CONFERENCIA_DOCS, msg);
  if (!r || !r.ok || !r.texto) return '';
  const linhas = r.texto.split('\n').map((l) => l.trim()).filter((l) => /^DIVERGENCIA\s*\|/i.test(l));
  return linhas.slice(0, 80).join('\n');
}

// Troca na fala as menções monetárias cujo valor canônico está em `canons` por um rótulo neutro,
// para a correção cirúrgica não usá-las como candidato. Só usada com documentos (T01).
function _ocultarValoresFala(txt, canons) {
  const s = String(txt);
  const cortes = [];
  const add = (m, canon) => { if (canons.has(canon)) cortes.push([m.index, m.index + m[0].length]); };
  for (const m of s.matchAll(/R\$\s*\d[\d.]*(?:,\d{2})?(?:\s*mil)?/gi)) {
    const mm = m[0].match(/(\d[\d.]*(?:,\d{2})?)(\s*mil)?/i);
    add(m, _numPtBr(mm[1], mm[2] ? 1000 : 1));
  }
  for (const m of s.matchAll(/(?<![\d$]\s?)\b(\d+(?:[.,]\d+)?)\s*mil\b/gi)) add(m, _numPtBr(m[1], 1000));
  cortes.sort((a, b) => b[0] - a[0]);
  let out = s, lim = Infinity;
  for (const [a, b] of cortes) { if (b > lim) continue; out = out.slice(0, a) + '[valor divergente do documento]' + out.slice(b); lim = a; }
  return out;
}

// VALIDADOR DETERMINÍSTICO dos marcadores [conferir: ...] (T01, anti invenção).
// O marcador afirma "o dado escrito antes veio do DOCUMENTO e a fala disse outra coisa". Na ata
// real o modelo também usou o marcador só para normalizar fala informal ("107 mil" virou
// R$ 107.000,00 [conferir: ...]) sem o valor existir no documento, e colocou explicação dentro.
// Regra: o marcador só fica se o dado IMEDIATAMENTE antes dele (valor R$ ou nome capitalizado)
// existir no texto dos documentos; senão o marcador sai e o dado fica para o gate julgar contra
// as fontes. O conteúdo é limpo para a forma curta "[conferir: transcrição dizia X]".
function validarMarcadoresConferir(ataTxt, textoDocs) {
  const s = String(ataTxt);
  const canonDocs = valoresCanonicos(textoDocs || '');
  const reMk = /\s*\[conferir:\s*([^\]]*)\]/g;
  const trocas = [];
  let m, mantidos = 0, removidos = 0;
  while ((m = reMk.exec(s))) {
    const antes = s.slice(Math.max(0, m.index - 120), m.index);
    let ancorado = false;
    const mv = antes.match(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s*$/);
    if (mv) {
      const c = [...valoresCanonicos(mv[0])];
      ancorado = c.length === 1 && canonDocs.has(c[0]);
    } else {
      const mn = antes.match(/((?:[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.&]*\s*){1,4})$/);
      const palavras = mn ? mn[1].trim().split(/\s+/).map((w) => w.replace(/[.,;:]+$/, '')).filter((w) => w.length >= 3 && !_SUFIXOS_NORM.has(_normLoose(w))) : [];
      ancorado = palavras.length > 0 && palavras.every((w) => existeLiteral(w, textoDocs || ''));
    }
    let novo = '';
    if (ancorado) {
      // forma curta: só o que a transcrição dizia (corta explicação depois de ; ou de "o documento")
      const dizia = m[1].replace(/^transcri[çc][ãa]o dizia\s*/i, '').split(/;|\bo documento\b/i)[0].trim().replace(/[,.]+$/, '');
      novo = dizia ? ' [conferir: transcrição dizia ' + dizia + ']' : '';
      mantidos++;
    } else removidos++;
    trocas.push([m.index, m.index + m[0].length, novo]);
  }
  let out = s;
  for (let i = trocas.length - 1; i >= 0; i--) out = out.slice(0, trocas[i][0]) + trocas[i][2] + out.slice(trocas[i][1]);
  return { ata: out, mantidos, removidos };
}

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

// Canoniza um número escrito pt-BR ('21.000,00', '21', '1,5') pra Number (em reais).
function _numPtBr(str, mult) {
  const n = parseFloat(String(str).trim().replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : Math.round(n * (mult || 1) * 100) / 100;
}

// Palavras de contexto que sinalizam DINHEIRO perto do número. Sem sinal de dinheiro, um
// número no formato X,XX NÃO é tratado como valor (era o bug: "2,00%", "56,32 m²" viravam moeda).
const _CTX_MONETARIO = /(r\$|reais|real|valor|custo|despes|saldo|montante|arrecad|receit|pagament|pre[çc]o|or[çc]ament|verba|fundo|d[ée]bito|d[ií]vida|reembols|honor[áa]ri|rateio|aquisi[çc]|contrato|proposta|taxa|multa|parcela|caixa|invest|totaliz|som(a|ou|aram)|import[âa]ncia|quantia|gast|or[çc]ad)/i;
// Unidade NÃO monetária logo após o número: desqualifica (percentual, medida).
const _POS_NAO_MONETARIO = /^\s*(%|por\s*cento|m²|m2\b|metros?\b|km\b|kg\b|litros?\b)/i;

// Decide se um número casado é MONETÁRIO: não pode ser seguido de unidade não monetária E
// precisa ter sinal de dinheiro (R$ imediatamente antes, 'reais'/'real' logo depois, ou
// palavra de contexto monetário perto). temMoedaNoMatch=true quando o próprio casamento já
// traz o sinal (R$, 'reais', 'conto', 'mil reais').
function _ehMonetario(s, idx, matchLen, temMoedaNoMatch) {
  const depois = s.slice(idx + matchLen, idx + matchLen + 16);
  if (_POS_NAO_MONETARIO.test(depois)) return false;         // 2,00% / 56,32 m² -> NÃO é dinheiro
  if (temMoedaNoMatch) return true;
  if (/r\$\s*$/i.test(s.slice(Math.max(0, idx - 6), idx))) return true;   // R$ imediatamente antes
  if (/^\s*(reais|real\b)/i.test(depois)) return true;                     // 'reais'/'real' logo depois
  return _CTX_MONETARIO.test(s.slice(Math.max(0, idx - 40), idx));         // contexto monetário perto
}

// Extrai as menções MONETÁRIAS de um texto (formal R$ X.XXX,XX, 'X mil'/'X mil reais',
// 'X reais'/'X conto', 'R$ X' sem centavos), cada uma com valor canônico e o trecho ao redor.
// SÓ conta o que tem sinal de dinheiro: número seguido de %, m², metros etc. NUNCA vira valor.
// (Por extenso, ex. 'dois mil e quinhentos', fica com o LLM, que normaliza pra R$ X.XXX,XX.)
function extrairMencoesMonetarias(txt) {
  const s = String(txt);
  const out = [];
  const add = (idx, len, canon) => {
    if (!canon) return;
    out.push({ canon, trecho: s.slice(Math.max(0, idx - 70), Math.min(s.length, idx + len + 70)).replace(/\s+/g, ' ').trim() });
  };
  for (const m of s.matchAll(/\d[\d.]*,\d{2}/g)) {
    if (_ehMonetario(s, m.index, m[0].length, false)) add(m.index, m[0].length, _numPtBr(m[0]));
  }
  for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s*mil(\s*reais)?\b/gi)) {
    if (_ehMonetario(s, m.index, m[0].length, !!m[2])) add(m.index, m[0].length, _numPtBr(m[1], 1000));
  }
  for (const m of s.matchAll(/(\d[\d.]*)\s*(?:reais|conto)/gi)) {
    if (_ehMonetario(s, m.index, m[0].length, true)) add(m.index, m[0].length, _numPtBr(m[1]));
  }
  for (const m of s.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})*)(?!\s*mil)(?!\d)(?![.,]\d)/gi)) {
    if (_ehMonetario(s, m.index, m[0].length, true)) add(m.index, m[0].length, _numPtBr(m[1]));
  }
  return out;
}

// Conjunto de valores monetários CANÔNICOS (Number em reais). Deriva de extrairMencoesMonetarias,
// então herda o filtro de sinal de dinheiro (não pega percentual nem medida).
function valoresCanonicos(txt) {
  return new Set(extrairMencoesMonetarias(txt).map((m) => m.canon));
}

// Menções monetárias COM o trecho ao redor (contexto), pra alimentar a inserção de forma
// determinística (todo valor dito que falte na ata entra na lista, mesmo que a auditoria de
// bloco/LLM tenha deixado passar).
function mencoesMonetarias(txt) {
  return extrairMencoesMonetarias(txt);
}

// ─────────────────────────────────────────────────────────────────────────
// CORREÇÃO CIRÚRGICA DETERMINÍSTICA de valor de deliberação.
//
// O motor não PERDE valor às cegas: quando o Sonnet fica em dúvida sobre um valor
// de deliberação falado, ele escreve "[valor a confirmar]" (ou quebra o formato, ex.
// "R$ 3.519, R$ 159", e ainda marca o total como [valor a confirmar]). Isso é
// não-determinístico (um run preenche, outro não). AQUI o código preenche esses
// placeholders SEM depender do LLM. Para um valor da fala virar candidato de um
// placeholder ele precisa: (1) estar em CONTEXTO DE DELIBERAÇÃO REAL na fala
// (voto/aprovação/contratação), descartando ocorrência logo após condicional como
// "caso aprovem" (hipotético) — ver _temDeliberacaoReal; (2) não estar já escrito de
// forma FIRME na ata (mas valor que só aparece em HEDGE, "mencionado como R$ X",
// volta a ser candidato — ver _valoresHedgeOnly). A força da âncora depende do sinal:
//   - com GATILHO FORTE (voto contado + aprovação efetivada agregados em TODAS as
//     ocorrências do valor na fala), QUALQUER palavra de conteúdo em comum serve,
//     mesmo entidade recorrente tipo "Gilvânia" (df alto) — ver FIX 1/FIX 2;
//   - sem gatilho forte, ainda exige âncora RARA (palavra em <=2 frases da ata).
// Se EXATAMENTE UM valor casa → preenche (e apaga "R$ X" errado colado antes do
// placeholder, ver _VALOR_COLADO_ANTES/FIX 3); se zero ou vários → mantém
// [a confirmar] (NUNCA chuta) e reporta como ambíguo.
// Refinamento futuro: cruzar com itens de pauta do edital nos casos ambíguos.
// ─────────────────────────────────────────────────────────────────────────
// Contexto de deliberação: voto/aprovação/ratificação/contratação. NÃO inclui
// "orçamento"/"valor de"/"proposta" (largos demais: pegam opção só apresentada).
const _CTX_DELIBERACAO = /(a favor\b|levanta.{0,8}plaquinha|plaquinha|aprova|aprovem|aprovad|vot(o|os|ar|ei|ou|amos|a[çc][aã]o|ada|ado)|delibera|delibere|decis[aã]o|decidi|decidiu|ratifica|contrata[çc]|homologa|escolh(er|eu|ido)|venc(eu|edor))/i;
const _PLACEHOLDER_VALOR = /\[valor(?:\s+total)?\s+a\s+(?:confirmar|definir)\]/gi;
// Gatilho forte (FIX 2): contagem de voto explícita ("17 votos", "maioria", "unanimidade").
// Isolado de _CTX_DELIBERACAO porque aqui queremos algo BEM mais específico que "a favor".
const _CTX_VOTO_FORTE = /\d+\s*votos?\b|\bmaioria\b|\bunanimidade\b/i;
// Gatilho forte (FIX 2): palavra de aprovação/ratificação/homologação já EFETIVADA (global,
// pra varrer todas as ocorrências no trecho e checar cada uma contra o marcador condicional).
const _APROVACAO_FORTE = /aprovad[oa]s?|aprovaram|ratificad[oa]s?|homologad[oa]s?/gi;
// Marcador condicional que, logo ANTES de uma palavra de aprovação, indica proposta ainda
// hipotética ("caso vocês aprovem", "se aprovado", "seria aprovado") — não é votação de fato.
const _COND_ANTES_APROVACAO = /\b(caso|se|quando|desde\s+que|seria)\b/i;
function _normLoose(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
const _STOP_ANC = new Set('para pela pelo pelos como esse essa esta este isso aqui onde quem porque entao tambem tem uma uns umas dos das com sem por que nos nas ate vai ser foi sao mais mas ele ela isso esse valor valores reais real mil total conta contas sobre aos vao seria fica ficar deve pode todo toda todos todas cada qual quando muito pouco entre depois antes assim custo somente incluindo opcao opcoes confirmar razao social completa nome numero sobrenome mesmo mesma'.split(' '));
// Âncoras de um trecho: palavras de conteúdo (>=5 letras), descartando o 1º e o último
// token (o trecho corta a ±70 chars no meio de palavra, gerando fragmentos).
function _ancorasCtx(trecho) {
  const toks = _normLoose(trecho).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return [...new Set(toks.slice(1, -1).filter((w) => w.length >= 5 && !_STOP_ANC.has(w) && !/^\d+$/.test(w)))];
}
// Valor "R$ X" colado (ignorando espaço) imediatamente ANTES do placeholder (FIX 3): quando o
// LLM escreveu um número errado seguido do placeholder ("R$ 3.519,00 [valor a confirmar]"),
// tem que apagar os dois juntos — senão o preenchimento gruda dois valores diferentes.
const _VALOR_COLADO_ANTES = /R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s*$/;
// Verifica se HÁ, no trecho, alguma aprovação/ratificação/homologação que NÃO esteja logo
// após um marcador condicional (~25 chars antes). Precisa varrer TODAS as ocorrências da
// palavra no trecho porque pode haver uma hipotética ("caso aprovem") e outra real depois.
function _temAprovacaoForte(trecho) {
  _APROVACAO_FORTE.lastIndex = 0;
  let m;
  while ((m = _APROVACAO_FORTE.exec(trecho))) {
    const antes = trecho.slice(Math.max(0, m.index - 25), m.index);
    if (!_COND_ANTES_APROVACAO.test(antes)) return true;
  }
  return false;
}
// FIX 4 (questao a): versao GLOBAL de _CTX_DELIBERACAO, pra varrer TODAS as ocorrencias de
// palavra de deliberacao num trecho (nao so a primeira que o regex sem 'g' acha).
const _CTX_DELIBERACAO_G = /(a favor\b|levanta.{0,8}plaquinha|plaquinha|aprova|aprovem|aprovad|vot(o|os|ar|ei|ou|amos|a[çc][aã]o|ada|ado)|delibera|delibere|decis[aã]o|decidi|decidiu|ratifica|contrata[çc]|homologa|escolh(er|eu|ido)|venc(eu|edor))/gi;
// Generaliza _temAprovacaoForte pra TODO o vocabulario de _CTX_DELIBERACAO (nao so
// aprovacao): verifica se HA, no trecho, alguma palavra de deliberacao que NAO esteja logo
// apos um marcador condicional (~25 chars antes). Fecha o vazamento onde "aprovem" dentro de
// "caso voces aprovem" (hipotetico) casava _CTX_DELIBERACAO.test(trecho) puro e virava
// candidato so por casar o regex, mesmo sendo so uma proposta ainda nao votada.
// Se a ocorrencia estiver perto demais do INICIO do trecho (m.index < 25), a janela de ±70
// chars do extrairMencoesMonetarias pode ja ter cortado fora o marcador condicional (ex.:
// "Caso voces aprovem..." vira so "oces aprovem..." quando o valor falado esta loge na
// frase) — nesse caso NAO da pra garantir que nao e condicional, entao trata como incerto e
// NAO conta essa ocorrencia como deliberacao real (nunca chuta, por seguranca).
function _temDeliberacaoReal(trecho) {
  _CTX_DELIBERACAO_G.lastIndex = 0;
  let m;
  while ((m = _CTX_DELIBERACAO_G.exec(trecho))) {
    if (m.index < 25) continue; // contexto insuficiente pra descartar condicional -> nao conta
    const antes = trecho.slice(m.index - 25, m.index);
    if (!_COND_ANTES_APROVACAO.test(antes)) return true;
  }
  return false;
}
// FIX 4 (questao a): verbo de HEDGE (mencionado/indicado/citado/referido/falado/dito) seguido
// de "como" em ate ~15 chars: sinaliza que o valor foi so ANOTADO como alternativa/duvida na
// ata, nunca AFIRMADO de forma firme. Funciona com ou sem parenteses ao redor (o sinal e o par
// verbo+"como", nao a pontuacao) — cobre tanto "(mencionado como R$ X em determinado momento)"
// quanto "indicado como R$ X e mencionado tambem como R$ Y" sem parenteses.
const _HEDGE_COMO = /(?:mencionad[oa]s?|indicad[oa]s?|citad[oa]s?|referid[oa]s?|fal(?:ou|ado)|dit[oa])[^.]{0,15}?\bcomo\b/i;
// Monta o conjunto de valores canonicos que aparecem na ata SOMENTE em anotacoes de HEDGE, e
// NUNCA de forma firme. Precisa TODAS as ocorrencias do valor na ata serem hedge: uma unica
// ocorrencia firme em qualquer ponto mantem o valor bloqueado (guarda de regressao — valor
// firme na ata jamais pode ser reaberto pra preenchimento).
function _valoresHedgeOnly(ataTxt) {
  const todasHedgePorCanon = new Map();
  for (const m of extrairMencoesMonetarias(ataTxt)) {
    const hedge = _HEDGE_COMO.test(m.trecho);
    const atual = todasHedgePorCanon.has(m.canon) ? todasHedgePorCanon.get(m.canon) : true;
    todasHedgePorCanon.set(m.canon, atual && hedge);
  }
  const out = new Set();
  for (const [canon, todasHedge] of todasHedgePorCanon) if (todasHedge) out.add(canon);
  return out;
}
// Preenche [valor a confirmar] com o valor de deliberação falado (1-para-1). Retorna
// { ata, preenchidos:[{canon}], ambiguos:[{candidatos}] }.
function corrigirPlaceholdersDeliberacao(ataTxt, transcricao) {
  const canonAta = valoresCanonicos(ataTxt);
  // FIX 4 (questao a): valores que so aparecem em anotacao de HEDGE na ata (nunca de forma
  // firme) voltam a ser candidatos — o bloqueio original ("ja esta na ata, nao mexe") era
  // largo demais e travava a linha de DELIBERACAO quando o LLM so anotou o valor como duvida
  // (ex. "(mencionado como R$ 4.100,00 em determinado momento)"). Valor FIRME continua
  // bloqueado (guarda de regressao obrigatoria).
  const hedgeOnlyAta = _valoresHedgeOnly(ataTxt);
  // FIX 1: agrupa por valor CANÔNICO juntando TODAS as ocorrências na fala (não só a
  // primeira) — a confirmação de votação forte de um valor às vezes está numa ocorrência
  // diferente da primeira menção (ex.: 1ª ocorrência só apresenta o valor, a 3ª confirma o
  // voto). Sem isso a âncora e o gatilho forte ficavam presos ao trecho mais fraco.
  const porCanon = new Map();
  for (const m of mencoesMonetarias(transcricao)) {
    if (canonAta.has(m.canon) && !hedgeOnlyAta.has(m.canon)) continue; // firme na ata -> bloqueado; so-hedge -> libera candidatura
    if (!porCanon.has(m.canon)) porCanon.set(m.canon, { anc: new Set(), entrouDeliberacao: false, votoForte: false, aprovacaoForte: false });
    const g = porCanon.get(m.canon);
    // FIX 4 (questao b): usa _temDeliberacaoReal (varre TODAS as ocorrencias e descarta as
    // que vem logo apos condicional) em vez do _CTX_DELIBERACAO.test puro, que casava
    // "aprovem" dentro de "caso voces aprovem" (hipotetico) e deixava vazar candidato ruido.
    if (_temDeliberacaoReal(m.trecho)) g.entrouDeliberacao = true;
    for (const a of _ancorasCtx(m.trecho)) g.anc.add(a);
    if (_CTX_VOTO_FORTE.test(m.trecho)) g.votoForte = true;
    if (_temAprovacaoForte(m.trecho)) g.aprovacaoForte = true;
  }
  const candidatos = [];
  for (const [canon, g] of porCanon) {
    if (!g.entrouDeliberacao) continue; // só deliberação, nunca ruído (em NENHUMA ocorrência)
    // Gatilho forte: voto contado E aprovação de fato, juntos no contexto agregado do valor.
    candidatos.push({ canon, anc: [...g.anc], gatilhoForte: g.votoForte && g.aprovacaoForte });
  }
  // docFreq por frase: quantas frases da ata contêm cada palavra (mede raridade).
  const dfFrases = new Map();
  for (const fr of ataTxt.split(/[.\n]/)) {
    for (const w of new Set(_normLoose(fr).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((x) => x.length >= 5))) {
      dfFrases.set(w, (dfFrases.get(w) || 0) + 1);
    }
  }
  const preenchidos = [], ambiguos = [];
  let out = '', last = 0;
  for (const pm of ataTxt.matchAll(_PLACEHOLDER_VALOR)) {
    const idx = pm.index;
    const ctxNorm = _normLoose(ataTxt.slice(Math.max(0, idx - 190), idx + 45));
    // valores cujo trecho compartilha âncora com o contexto do placeholder. Se o valor tem
    // GATILHO FORTE (voto + aprovação reais, agregados), dispensa a raridade da âncora
    // (FIX 2); senão, exige âncora rara (<=2 frases na ata) como hoje.
    const casaram = candidatos.filter((c) => c.anc.some((a) => ctxNorm.includes(a) && (c.gatilhoForte || (dfFrases.get(a) || 9) <= 2)));
    if (casaram.length === 1) {
      // FIX 3: se o texto imediatamente antes do placeholder já for um "R$ X" (valor errado
      // colado pelo LLM), apaga os dois juntos pra não grudar dois valores diferentes.
      const inicioJanela = Math.max(0, idx - 40);
      const mColado = _VALOR_COLADO_ANTES.exec(ataTxt.slice(inicioJanela, idx));
      const inicioCorte = mColado ? inicioJanela + mColado.index : idx;
      out += ataTxt.slice(last, inicioCorte);
      out += 'R$ ' + casaram[0].canon.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      preenchidos.push({ canon: casaram[0].canon });
    } else {
      out += ataTxt.slice(last, idx);
      out += pm[0];
      if (casaram.length > 1) ambiguos.push({ candidatos: casaram.map((c) => c.canon) });
    }
    last = idx + pm[0].length;
  }
  out += ataTxt.slice(last);
  return { ata: out, preenchidos, ambiguos };
}

// ─────────────────────────────────────────────────────────────────────────
// PASSE DE CONSOLIDAÇÃO DE NOME PRÓPRIO (2026-07-09). Etapas 1, 2 e 4 são código puro; a
// etapa 3 é uma chamada de LLM de insumo mínimo, disparada SÓ quando sobra mais de uma forma
// grounded.
//
// O motor FRACIONADO degrada nome próprio no corpo da ata (regressão registrada em
// tarefas/em-andamento/fast-follow-fidelidade-nome-motor-fracionado.md): às vezes marca
// "[nome a confirmar: Bit Engenharia / MIT Engenharia / Adite Engenharia]" quando a fala
// tem só UM nome correto, ou pior, inventa alternativa que nunca foi dita (fabricação).
//
// Este passe roda em 4 etapas, TODAS implementadas e wiradas em entregarAta (o passe roda
// depois de inserirLacunasNaAta e antes de corrigirPlaceholdersDeliberacao):
//   ETAPA 1 (extrairNomesCandidatos): acha candidato a nome próprio na ata (marcador
//     "[nome a confirmar: ...]" ou nome firme escrito com gatilho de pessoa/empresa).
//   ETAPA 2 (reunirEvidencia): GROUNDING por PALAVRA INTEIRA. Só sobrevive alternativa que
//     existe como palavra na transcrição normalizada (via existeLiteral). Também busca ÂNCORA
//     POR VALOR: nomes próprios ditos perto do MESMO valor em R$ do candidato, mesmo que a ata
//     não tenha listado essa forma.
//   decidirPorCodigo: se sobrar EXATAMENTE uma forma grounded, resolve por CÓDIGO
//     (confianca='alta_codigo'), sem LLM. Se sobrar mais de uma, marca precisaLLM=true e a
//     ETAPA 3 (consolidarNomesProprios, chamada claude-sonnet-4-6) decide. Se sobrar zero,
//     nunca piora.
//   ETAPA 4 (aplicarConsolidacao): find and replace determinístico, só com confiança ALTA,
//     com DUPLA checagem de grounding (forma_canonica fabricada nunca sobrevive) e guarda de
//     tamanho (nunca reescreve a ata pra menos de 95% do tamanho de entrada).
//
// REGRA DE OURO: grounding é item de primeira classe e exige PALAVRA INTEIRA. Nenhuma forma
// sobrevive se não existir como palavra na fala. Foi assim que "Habit"/"ABM Montas"/"ADM Manta"
// (fabricações) morrem, e é assim que "Cato" (substring de "Cator") e "Cerval" (substring de
// "Cervalp") passaram a morrer depois do conserto de 2026-07-09 no existeLiteral.
// ─────────────────────────────────────────────────────────────────────────

// Escapa caractere especial de regex antes de montar um padrão a partir de texto livre
// (nome vindo da ata/transcrição). Extraída porque a mesma expressão vivia duplicada em 3
// pontos do passe (_expandirNomeCompleto, existeLiteral, aplicarConsolidacao) — desduplicação
// pura, sem mudança de comportamento.
function _escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Conectores minúsculos aceitos NO MEIO de um nome próprio composto (ex.: "João da Silva").
// Nunca no início nem no fim da captura — só entre dois tokens capitalizados.
const _CONECTORES_NOME = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

// Gatilhos de PESSOA ou EMPRESA que antecedem um nome próprio candidato. "empresa" sozinho
// já cobre "a empresa"/"aprovada a empresa" (todos terminam na palavra "empresa").
const _GATILHOS_NOME = /(Sr\.|Sra\.|Dr\.|Dra\.|síndic[oa]|conselheiro|presidente da mesa|empresa)/gi;

// Captura o(s) token(s) capitalizado(s) logo após uma posição do texto (usada depois de um
// gatilho de pessoa/empresa). Aceita conector minúsculo NO MEIO (da/de/do/das/dos/e), nunca
// isolado. Para no primeiro token que não é capitalizado nem conector válido — isso também
// exclui pontuação e "R$ 13.000" (o "R" sozinho falha por não vir seguido de espaço/fim).
function _capturarNomeApos(txt, pos) {
  const resto = txt.slice(pos);
  const inicioEspaco = resto.match(/^\s+/);
  let i = inicioEspaco ? inicioEspaco[0].length : 0;
  const tokens = [];
  while (tokens.length < 6) {
    const rem = resto.slice(i);
    // [a-zà-ÿA-ZÀ-Ý]* (nao só minúscula) pra aceitar token CamelCase sem espaço interno
    // (ex.: "TesteCorp"), que senão quebrava no meio por achar a 2ª maiúscula.
    const capM = rem.match(/^([A-ZÀ-Ý][a-zà-ÿA-ZÀ-Ý]*)(\s+|$)/);
    if (capM) { tokens.push(capM[1]); i += capM[0].length; continue; }
    const conM = rem.match(/^([a-zà-ÿ]+)(\s+)/);
    if (conM && tokens.length > 0 && _CONECTORES_NOME.has(conM[1])) {
      const proximo = rem.slice(conM[0].length).match(/^[A-ZÀ-Ý][a-zà-ÿA-ZÀ-Ý]*(\s+|$)/);
      if (proximo) { tokens.push(conM[1]); i += conM[0].length; continue; }
    }
    break;
  }
  return tokens.length ? tokens.join(' ') : null;
}

// Palavra de aprovação/ratificação/homologação EFETIVADA, usada aqui só pra marcar um
// candidato como "confirmado" quando aparece bem colada no gatilho (ver _candidatosGatilho).
const _APROVACAO_PERTO_GATILHO = /aprovad[oa]s?|aprovaram|ratificad[oa]s?|homologad[oa]s?/i;

// Varre um texto por gatilhos de pessoa/empresa e devolve os nomes capturados logo depois,
// com a posição (idx) do início do nome e um sinal `confirmado`: TRUE quando uma palavra de
// aprovação efetivada aparece colada bem antes do próprio gatilho (~30 chars), como em
// "Ok, então aprovada a empresa Bit" — isso distingue o VENCEDOR de uma proposta que só foi
// apresentada/votada sem confirmação (ex.: "A favor da empresa Adite Engenharia, R$13 mil"
// não tem aprovação colada no gatilho, mesmo que a palavra "aprovado" apareça mais adiante
// na mesma frase perguntando sobre unanimidade). Reaproveitada tanto no canal FIRME da ata
// (etapa 1, onde o sinal não é usado) quanto na busca de âncora por valor (etapa 2, onde é
// o que resolve empate entre propostas concorrentes pelo MESMO valor).
function _candidatosGatilho(txt) {
  const out = [];
  _GATILHOS_NOME.lastIndex = 0;
  let g;
  while ((g = _GATILHOS_NOME.exec(txt))) {
    const posNome = g.index + g[0].length;
    const nome = _capturarNomeApos(txt, posNome);
    if (!nome) continue;
    const idxNome = txt.indexOf(nome, posNome);
    const antesGatilho = txt.slice(Math.max(0, g.index - 30), g.index);
    const confirmado = _APROVACAO_PERTO_GATILHO.test(antesGatilho);
    out.push({ nome, idx: idxNome >= 0 ? idxNome : posNome, confirmado });
  }
  return out;
}

// Expande um nome CURTO (1 palavra, ex. "Bit") pra sua forma mais completa (ex. "Bit
// Engenharia"), SE essa forma maior existir LITERALMENTE em outro ponto da transcrição
// inteira. Nunca inventa: só expande se a forma maior existir de fato no texto. Cobre o
// caso em que a fala confirma o vencedor só pelo apelido curto ("aprovada a empresa Bit")
// mas o nome completo foi dito por extenso em outro momento da mesma reunião.
function _expandirNomeCompleto(nome, transcricaoTxt) {
  if (!nome || nome.trim().includes(' ')) return nome;
  const re = new RegExp('\\b' + _escapeRegex(nome) + '\\s+([A-ZÀ-Ý][a-zà-ÿ]*)');
  const m = re.exec(transcricaoTxt);
  return m ? (nome + ' ' + m[1]) : nome;
}

// Acha o valor monetário MAIS PRÓXIMO de uma posição, numa janela ao redor (usado tanto pro
// marcador "[nome a confirmar]" quanto pro nome firme, pra guardar a âncora de valor de cada
// candidato). Só serve pra ORIENTAR a busca de âncora na transcrição depois (reunirEvidencia)
// — nunca decide nome sozinho.
function _valorProximo(txt, idx, raio) {
  const ini = Math.max(0, idx - raio);
  const fim = Math.min(txt.length, idx + raio);
  const janela = txt.slice(ini, fim);
  const centro = idx - ini;
  const janelaColapsada = janela.replace(/\s+/g, ' ');
  const mencoes = extrairMencoesMonetarias(janela);
  if (!mencoes.length) return null;
  let melhor = mencoes[0].canon, melhorDist = Infinity;
  for (const m of mencoes) {
    const pos = janelaColapsada.indexOf(m.trecho);
    const dist = pos < 0 ? Infinity : Math.abs(pos - centro);
    if (dist < melhorDist) { melhorDist = dist; melhor = m.canon; }
  }
  return melhor;
}

// ETAPA 1 (código puro): extrai candidatos a nome próprio da ata, por dois canais.
//   MARCADOR: "[nome a confirmar: A / B / C]" (ou vazio). "[sobrenome a confirmar]" é OUTRO
//     marcador e nunca conta aqui (não é candidato de consolidação de nome).
//   FIRME: nome escrito sem marcador, logo após um gatilho de pessoa ("Sr.", "síndico"...)
//     ou de empresa ("empresa"). Exclusões obrigatórias: (a) bate com termo do glossário
//     (comparação por _normLoose); (b) sequência inteiramente em CAIXA ALTA (título de
//     cabeçalho, nunca nome de gente); (c) só entra se repetir pelo menos DUAS vezes no
//     corpo (mesma grafia, via _normLoose) — decisão do Matheus: candidato único nunca entra
//     sozinho no canal firme.
function extrairNomesCandidatos(ataTxt, glossarioTxt) {
  const ata = String(ataTxt);
  const glossarioNorm = _normLoose(String(glossarioTxt || ''));
  const candidatos = [];

  // --- canal MARCADOR ---
  const reMarcador = /\[(nome|sobrenome)\s+a\s+confirmar(?:\s*:\s*([^\]]*))?\]/gi;
  let m;
  while ((m = reMarcador.exec(ata))) {
    if (m[1].toLowerCase() !== 'nome') continue; // "[sobrenome a confirmar]" é outro marcador
    const conteudo = (m[2] || '').trim();
    const alternativas = conteudo ? conteudo.split(/\s*\/\s*|\s*,\s*/).map((s) => s.trim()).filter(Boolean) : [];
    candidatos.push({
      tipo: 'marcador',
      textoOriginal: m[0],
      alternativas,
      valorAncora: _valorProximo(ata, m.index, 200),
      idx: m.index
    });
  }

  // --- canal FIRME ---
  const brutos = _candidatosGatilho(ata);
  const vistos = new Map(); // dedupe por _normLoose, guarda a 1ª grafia encontrada
  for (const b of brutos) {
    const chave = _normLoose(b.nome);
    if (glossarioNorm.includes(chave)) continue;        // (a) termo do glossário
    if (!/[a-zà-ÿ]/.test(b.nome)) continue;              // (b) tudo em CAIXA ALTA, sem minúscula nenhuma
    if (!vistos.has(chave)) vistos.set(chave, { nome: b.nome, idx: b.idx, count: 0 });
    vistos.get(chave).count++;
  }
  for (const v of vistos.values()) {
    if (v.count < 2) continue; // (c) repetição mínima = 2
    candidatos.push({
      tipo: 'firme',
      textoOriginal: v.nome,
      alternativas: [v.nome],
      valorAncora: _valorProximo(ata, v.idx, 120),
      idx: v.idx
    });
  }

  return candidatos;
}

// Busca âncora por VALOR na transcrição: acha TODOS os trechos onde o MESMO valor canônico
// foi falado e extrai nome próprio próximo de cada um (via _candidatosGatilho). Numa disputa
// entre propostas concorrentes pelo MESMO valor (ex.: Bit x MIT x Adite, todas ~R$13.000),
// prioriza SÓ os candidatos marcados `confirmado` (aprovação colada no gatilho, ex. "aprovada
// a empresa Bit") — descarta as propostas que só foram apresentadas/votadas sem confirmação
// colada. Sem nenhum candidato confirmado, usa todos (nunca fica pior que antes).
// RESSALVA (2026-07-09): esse desempate por "aprovação colada no gatilho" é uma HEURÍSTICA,
// não verdade objetiva. Funcionou no Casablanca (Bit), mas em outra ata pode escolher errado.
// A rede de segurança é a confiança alta + o grounding (a forma escolhida tem que existir na
// fala), que seguram o pior caso. É o ponto do desenho que mais merece olho em produção.
function _buscarAncoraPorValor(valorAncora, transcricaoTxt) {
  if (valorAncora == null) return [];
  const trechos = extrairMencoesMonetarias(transcricaoTxt).filter((mn) => mn.canon === valorAncora);
  if (!trechos.length) return [];
  const todos = [];
  for (const t of trechos) {
    for (const cand of _candidatosGatilho(t.trecho)) {
      todos.push({ nome: _expandirNomeCompleto(cand.nome, transcricaoTxt), confirmado: cand.confirmado });
    }
  }
  const confirmados = todos.filter((c) => c.confirmado);
  const alvo = confirmados.length ? confirmados : todos;
  const nomes = new Map();
  for (const c of alvo) {
    const chave = _normLoose(c.nome);
    if (!nomes.has(chave)) nomes.set(chave, c.nome);
  }
  return [...nomes.values()];
}

// ETAPA 2 (código puro): reúne evidência de cada candidato contra a transcrição.
//   groundedAlternativas = alternativas do candidato que existem LITERALMENTE na fala
//     (normalizado por _normLoose, sem depender de acento/caixa/espaço duplo). O que não
//     existe é DESCARTADO aqui — é onde fabricação (Habit, ABM Montas, ADM Manta) morre.
//   ancoraNomes = nomes que a transcrição associa ao MESMO valor em R$ do candidato, mesmo
//     que a ata não tenha listado essa forma (ex.: "Cervalp Manutenção" quando a ata só
//     tinha "Ceval").
//   formasGrounded = união das duas, sem duplicar (por _normLoose).
// existeLiteral: um alvo está "grounded" se aparece como PALAVRA INTEIRA na transcrição
// normalizada. CORREÇÃO 2026-07-09: a checagem antiga era transcricaoNorm.includes(alvo), que
// casava SUBSTRING e aprovava forma degradada como grounded — "Cato" passava por existir dentro
// de "Cator", "Cerval" dentro de "Cervalp", "Marcel" dentro de "Marcelo". O passe então aplicava
// a forma degradada como forma_canonica. Agora exige fronteira de palavra, com o MESMO lookaround
// de letra (inclusive acento) do replace da etapa 4 (server.js, aplicarConsolidacao). Nome
// composto ("Marcelo Soares") casa o espaço interno literal; a fronteira vai só nas pontas, então
// não quebra. A transcrição é normalizada por _normLoose (acento removido, minúscula), então o
// alvo também é — a comparação é acento-insensível como antes, só que por palavra. CORREÇÃO
// 2026-07-09 (2): a fronteira bloqueava só letra, então "Bit" ainda casava como substring dentro
// de "Bit2024" ou "Bit-Tech" (dígito e hífen colados não contavam como parte da palavra). Agora a
// classe negada também bloqueia dígito (0-9), hífen (-) e apóstrofo (') nas duas pontas.
function existeLiteral(alvoRaw, transcricaoTxt) {
  const transcricaoNorm = _normLoose(String(transcricaoTxt || '')).replace(/\s+/g, ' ');
  const alvo = _normLoose(String(alvoRaw || '')).replace(/\s+/g, ' ').trim();
  if (!alvo) return false;
  const esc = _escapeRegex(alvo);
  const re = new RegExp('(?<![A-Za-zÀ-ÿ0-9\'-])' + esc + '(?![A-Za-zÀ-ÿ0-9\'-])');
  return re.test(transcricaoNorm);
}

function reunirEvidencia(candidatos, transcricaoTxt) {
  const transcricao = String(transcricaoTxt || '');
  return (candidatos || []).map((c) => {
    const groundedAlternativas = (c.alternativas || []).filter((alt) => existeLiteral(alt, transcricao));
    const ancoraNomes = _buscarAncoraPorValor(c.valorAncora, transcricao);
    const unificado = new Map();
    for (const f of [...groundedAlternativas, ...ancoraNomes]) {
      const chave = _normLoose(f);
      if (!unificado.has(chave)) unificado.set(chave, f);
    }
    return { ...c, groundedAlternativas, ancoraNomes, formasGrounded: [...unificado.values()] };
  });
}

// Decisão POR CÓDIGO (sem LLM): olha formasGrounded de cada candidato já enriquecido pela
// etapa 2. EXATAMENTE uma forma grounded -> resolve aqui mesmo (confianca='alta_codigo'),
// sem precisar da etapa 3 (LLM, fora de escopo deste passe). Mais de uma -> marca
// precisaLLM=true (fica pendente, a etapa 3 decide). Zero -> não entra em lista nenhuma,
// nunca piora o que já está na ata.
function decidirPorCodigo(candidatosEnriquecidos) {
  const decisoesCodigo = [];
  const pendentesLLM = [];
  for (const c of (candidatosEnriquecidos || [])) {
    const formas = c.formasGrounded || [];
    if (formas.length === 1) {
      const formaCanonica = formas[0];
      const variantes = (c.alternativas || []).filter((a) => _normLoose(a) !== _normLoose(formaCanonica));
      decisoesCodigo.push({ textoOriginal: c.textoOriginal, forma_canonica: formaCanonica, variantes, confianca: 'alta_codigo' });
    } else if (formas.length >= 2) {
      pendentesLLM.push({ ...c, precisaLLM: true });
    }
    // formas.length === 0: nunca piora, não entra em decisão nem em pendência.
  }
  return { decisoesCodigo, pendentesLLM };
}

// Dupla checagem de grounding usada na ETAPA 4: mesmo que a decisão já tenha passado pela
// etapa 2 (ou venha mockada/da etapa 3, fora de escopo aqui), uma forma_canonica fabricada
// nunca pode ser aplicada. Se `transcricaoTxt` não for informado, confia que quem chamou já
// validou (uso interno/teste); quando informado, reconfere a existência literal.
function _formaGrounded(forma, transcricaoTxt) {
  if (!transcricaoTxt) return true;
  return existeLiteral(forma, transcricaoTxt);
}

// ETAPA 4 (código puro): aplica find and replace DETERMINÍSTICO das decisões de
// consolidação de nome próprio. Só aceita confiança ALTA ('alta' ou 'alta_codigo' — decisão
// do Matheus: a etapa 3/LLM nunca decide sozinha com 'media'/'baixa'). DUPLA checagem de
// grounding (forma_canonica fabricada é rejeitada mesmo vindo de decisão mockada). GUARDA DE
// TAMANHO: rejeita a decisão inteira se o resultado ficar abaixo de 95% do tamanho de
// entrada (nunca reescreve a ata fora dos nomes). Sem log de nome nem valor (telemetria sem
// conteúdo, exigência do Matheus).
function aplicarConsolidacao(ataTxt, decisoes, transcricaoTxt) {
  const entrada = String(ataTxt);
  let ata = entrada;
  const aplicados = [];
  const pulados = [];
  for (const d of (decisoes || [])) {
    if (d.confianca !== 'alta' && d.confianca !== 'alta_codigo') {
      pulados.push({ motivo: 'confianca_insuficiente' });
      continue;
    }
    if (!_formaGrounded(d.forma_canonica, transcricaoTxt)) {
      pulados.push({ motivo: 'forma_nao_grounded' });
      continue;
    }
    const alvos = [d.textoOriginal, ...(d.variantes || [])].filter((a) => a && a !== d.forma_canonica);
    let tentativa = ata;
    let trocou = false;
    for (const alvo of alvos) {
      const antes = tentativa;
      if (alvo.includes('[')) {
        // marcador "[nome a confirmar: ...]": string única e literal, substituição direta segura.
        tentativa = tentativa.split(alvo).join(d.forma_canonica);
      } else {
        // nome: substitui SÓ como palavra inteira, com a MESMA fronteira do grounding em
        // existeLiteral (letra com acento, dígito, hífen e apóstrofo bloqueados nas pontas), pra
        // não corromper um nome maior que o contenha (ex.: "Marcel" dentro de "Marcelo Soares")
        // nem casar "Bit" dentro de "Bit2024"/"Bit-Tech". Coerência entre grounding e replace.
        const re = new RegExp('(?<![A-Za-zÀ-ÿ0-9\'-])' + _escapeRegex(alvo) + '(?![A-Za-zÀ-ÿ0-9\'-])', 'g');
        tentativa = tentativa.replace(re, d.forma_canonica);
      }
      if (tentativa !== antes) trocou = true;
    }
    if (!trocou) { pulados.push({ motivo: 'alvo_nao_encontrado' }); continue; }
    if (tentativa.length < entrada.length * 0.95) { pulados.push({ motivo: 'guarda_tamanho' }); continue; }
    ata = tentativa;
    aplicados.push({ forma_canonica: d.forma_canonica });
  }
  return { ata, aplicados, pulados };
}

// Monta as evidências MÍNIMAS dos candidatos pendentes para a ETAPA 3 (LLM): só a lista de
// nomes com trechos curtos da transcrição onde cada forma grounded aparece. NUNCA manda a ata
// nem a transcrição inteira. Cada evidência é uma janela de ~110 chars ao redor da ocorrência.
function _evidenciasParaLLM(pendentes, transcricaoTxt) {
  const t = String(transcricaoTxt || '');
  const tn = _normLoose(t);
  return pendentes.map((p, i) => {
    const evidencias = [];
    for (const forma of (p.formasGrounded || [])) {
      const alvo = _normLoose(forma);
      let from = 0, achados = 0;
      while (achados < 2 && alvo) {
        const pos = tn.indexOf(alvo, from);
        if (pos < 0) break;
        evidencias.push(t.slice(Math.max(0, pos - 55), pos + alvo.length + 55).replace(/\s+/g, ' ').trim());
        from = pos + alvo.length;
        achados++;
      }
    }
    return { id: i, formas: p.formasGrounded, evidencias };
  });
}

// ETAPA 3: prompt MÍNIMO pra decidir a forma canônica entre formas já grounded. Recebe só a
// lista de nomes + evidências, nunca a ata nem a transcrição inteira.
const PROMPT_CONSOLIDACAO_NOME = `Você recebe uma lista de nomes próprios (pessoas ou empresas) que apareceram de forma DIVERGENTE numa ata condominial. Para cada item vêm as FORMAS que existem na transcrição da assembleia e TRECHOS de evidência.
Sua tarefa: para cada item, decidir a FORMA CANÔNICA única (a grafia correta e mais completa da MESMA entidade) e listar as formas que devem ser substituídas por ela.
REGRAS:
- A forma_canonica TEM que ser uma das formas apresentadas. NUNCA invente grafia nova nem corrija ortografia por conta própria.
- Se as formas são claramente a MESMA entidade (ex.: um apelido e o nome completo dito na sequência), unifique na mais completa.
- Se a evidência não deixa claro que são a mesma entidade, ou se há qualquer dúvida, use confianca "baixa".
- confianca "alta" só quando a evidência sustenta com clareza.
Devolva SOMENTE um array JSON, sem nenhum texto fora dele:
[{"id": <numero>, "forma_canonica": "...", "variantes": ["..."], "confianca": "alta"|"media"|"baixa"}]`;

// ORQUESTRADOR do passe de consolidação de nome próprio. Etapa 1 (extrair) + etapa 2 (grounding
// e âncora) + decisão por código + etapa 3 (LLM, SÓ quando sobra mais de uma forma grounded) +
// etapa 4 (aplicar). FALHA ABERTO: qualquer erro (teto de chamadas, rede, JSON malformado, bug
// interno) entrega a ata COMO ESTÁ, sem retry, sem quebrar a geração. Só aplica confiança ALTA.
// Telemetria só com CONTAGEM (nunca nome, nunca valor).
async function consolidarNomesProprios(ataTxt, transcricao, chamar) {
  const base = { ata: String(ataTxt), telemetria: { candidatos: 0, decididos_codigo: 0, decididos_llm: 0, pendentes_llm: 0, aplicados: 0, pulados: 0, etapa3: 'sem_pendentes' }, avisoSkip: null };
  try {
    const candidatos = extrairNomesCandidatos(ataTxt, GLOSSARIO_MD);
    base.telemetria.candidatos = candidatos.length;
    if (!candidatos.length) return base;
    const enriquecidos = reunirEvidencia(candidatos, transcricao);
    const { decisoesCodigo, pendentesLLM } = decidirPorCodigo(enriquecidos);
    base.telemetria.decididos_codigo = decisoesCodigo.length;
    base.telemetria.pendentes_llm = pendentesLLM.length;

    const decisoesLLM = [];
    if (pendentesLLM.length) {
      try {
        const payload = _evidenciasParaLLM(pendentesLLM, transcricao);
        const r = await chamar(MODELO_DA_ATA, 1500, PROMPT_CONSOLIDACAO_NOME, JSON.stringify(payload));
        const arr = JSON.parse(String((r && r.texto) || '').replace(/```(?:json)?\s*|\s*```/g, '').trim());
        for (const dec of (Array.isArray(arr) ? arr : [])) {
          const p = pendentesLLM[dec.id];
          if (!p || dec.confianca !== 'alta') continue; // ALTA APENAS (decisão do Matheus)
          decisoesLLM.push({ textoOriginal: p.textoOriginal, forma_canonica: dec.forma_canonica, variantes: (p.formasGrounded || []).concat(dec.variantes || []), confianca: 'alta' });
        }
        base.telemetria.etapa3 = 'rodou';
      } catch (eLLM) {
        base.telemetria.etapa3 = /TETO_CHAMADAS/.test(String(eLLM && eLLM.message)) ? 'pulada_teto' : 'pulada_erro';
        base.avisoSkip = 'A consolidação automática de nomes próprios não rodou completa nesta geração. Confira os nomes de pessoas e empresas com atenção extra.';
      }
    }
    base.telemetria.decididos_llm = decisoesLLM.length;

    const res = aplicarConsolidacao(ataTxt, [...decisoesCodigo, ...decisoesLLM], transcricao);
    base.ata = res.ata;
    base.telemetria.aplicados = res.aplicados.length;
    base.telemetria.pulados = res.pulados.length;
    return base;
  } catch (e) {
    base.ata = String(ataTxt); // falha aberto total: ata intacta
    return base;
  }
}

// Auditoria de completude de UM bloco: devolve a lista de lacunas (texto) ou '' se nada.
// extraSys (opcional, T01): regras + texto dos DOCUMENTOS DA ASSEMBLEIA, anexados no FIM do
// system (sem reordenar o que já existia). Sem documento, o system fica idêntico ao de antes.
async function auditarBlocoCompletude(ata, bloco, i, n, chamar, extraSys) {
  // Cache só quando há mais de um bloco (o system se repete entre eles).
  const sys = PROMPT_AUDITORIA_BLOCO + '\n\n---\n\n' + REGRAS_ANTI_ERRO + '\n\n---\n\n' + REGRAS_FIDELIDADE_TRANSCRICAO + (GLOSSARIO_MD ? '\n\n---\n\n' + GLOSSARIO_MD : '') + (extraSys ? '\n\n---\n\n' + extraSys : '');
  const msg = '=== ATA GERADA (completa) ===\n' + ata + '\n\n=== TRECHO ' + i + ' DE ' + n + ' DA TRANSCRIÇÃO ===\n' + bloco + '\n\nListe as lacunas DESTE trecho conforme as regras.';
  const r = await chamar(MODELO_DA_ATA, 8000, sys, msg, n > 1);
  return (r.ok && r.texto) ? r.texto.trim() : '';
}

// Inserção cirúrgica das lacunas (modelo = sonnet ou opus). Devolve a ata ou null.
async function inserirLacunasNaAta(ata, listaLacunas, modelo, chamar, extraSys) {
  const sys = PROMPT_INSERCAO_LACUNAS + '\n\n---\n\n' + REGRAS_ANTI_ERRO + '\n\n---\n\n' + REGRAS_FIDELIDADE_TRANSCRICAO + (GLOSSARIO_MD ? '\n\n---\n\n' + GLOSSARIO_MD : '') + (extraSys ? '\n\n---\n\n' + extraSys : '');
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
// ─────────────────────────────────────────────────────────────────────────
// GATE DE SAÍDA DETERMINÍSTICO (anti invenção de fato).
//
// Última passada de entregarAta. Função PURA de (ata, transcrição): sem LLM, sem Date,
// sem random, sem rede. Não repara, JULGA cada afirmação verificável da ata contra o TEXTO
// FONTE. NÃO é blacklist de palavra suspeita: a decisão é sempre "esse termo existe
// literalmente na fonte" (existeLiteral / valoresCanonicos). Um nome que EXISTE na transcrição
// passa; um nome fabricado (zero ocorrências) é sinalizado.
//
// Diferença do passe de consolidação: aquele é REPARADOR (precisa de 2+ candidatos pra
// escolher a forma certa; decidirPorCodigo formas.length>=2). Por isso deixou passar um nome
// fabricado fundido numa string sem segundo candidato. O gate é JUIZ: testa unidade a unidade
// a RAIZ DISTINTIVA de cada nome (token que não é sufixo genérico de SUFIXOS_NAO_DISTINTIVOS),
// então isola a raiz fabricada de "Raiz Engenharia" e a reprova sozinha.
//
// TRAVA 1 (Matheus): marcação e flag nascem JUNTAS. Um gate que calcula flag e não marca é
// pior que não ter gate. As flags derivam da MESMA lista de marcações aplicadas; se qualquer
// marcação não aparecer no texto final, marcacaoFalhou=true e o veredicto NUNCA é 'limpo'.
//
// Saída: { ata: <texto com trechos sem âncora marcados>, gate: { flags, veredicto, marcacaoFalhou } }
//   veredicto = 'limpo' | 'suspeito' | 'critico'

// Sufixos corporativos NÃO distintivos: palavras comuns do setor que não identificam ninguém.
// O gate ancora a RAIZ distintiva do nome, nunca o sufixo. Editar SÓ aqui; cresce com o tempo.
const SUFIXOS_NAO_DISTINTIVOS = [
  'Engenharia', 'Construtora', 'Manutencao', 'Mantas', 'Ltda', 'ME', 'Servicos',
  'Administracao', 'Administradora', 'Condominio', 'Reformas', 'Pinturas', 'Serralheria',
  'Eletrica', 'Hidraulica', 'Jardinagem', 'Limpeza', 'Seguranca', 'Tecnologia', 'Sistemas',
  'Comercio', 'Materiais', 'EIRELI', 'S/A', 'S.A', 'Incorporadora'
];
const _SUFIXOS_NORM = new Set(SUFIXOS_NAO_DISTINTIVOS.map((s) => _normLoose(s)));

// ABERTURAS gramaticais: advérbios, conjunções, verbos e pronomes formais que a ata usa para
// ABRIR frase/oração (capitalizados por posição, não por serem nome próprio). NÃO é blacklist de
// nome suspeito (a decisão de âncora continua sendo "existe na fonte"): é a mesma categoria do
// skip de conectivos abaixo, só que para o começo de frase. Existe porque nem toda abertura formal
// ("Considerando", "Outrossim") aparece literal no áudio, então sem isto viraria falso positivo em
// item de lista após ':'. CRESCE com o tempo, editar aqui. Um nome próprio real quase nunca colide.
const _GATE_ABERTURAS = new Set([
  'apos', 'antes', 'ademais', 'assim', 'ato', 'aberta', 'aberto', 'aprovada', 'aprovado',
  'colocada', 'colocado', 'conforme', 'considerada', 'considerado', 'considerando', 'constatada',
  'constatado', 'contudo', 'debatida', 'debatido', 'deliberada', 'deliberado', 'diante', 'dito',
  'durante', 'efetuada', 'encerrada', 'encerrado', 'enquanto', 'entretanto', 'feita', 'feitas',
  'feito', 'feitos', 'finalizada', 'finalmente', 'havendo', 'igualmente', 'inicialmente', 'isto',
  'mediante', 'nada', 'naquela', 'naquele', 'nesta', 'neste', 'nessa', 'nesse', 'ocorrida',
  'outrossim', 'passada', 'passado', 'passou', 'portanto', 'posta', 'posteriormente',
  'primeiramente', 'procedida', 'procedido', 'procedeu', 'prosseguindo', 'prosseguiu', 'quanto',
  'realizada', 'realizado', 'registrada', 'registrado', 'registrou', 'ressaltada', 'ressaltado',
  'ressaltou', 'sendo', 'sobre', 'submetida', 'submetido', 'tendo', 'todavia', 'uma', 'verificada',
  'verificado',
  // T01 (ata real Casablanca, 20/10/2026): verbos de relato e particípios que abriram frase
  // e viraram falso positivo.
  'citou', 'concluida', 'concluido', 'declarou', 'destacou', 'encerrados', 'esclareceu',
  'explicou', 'informou', 'apresentou', 'lembrou', 'mencionou', 'observou', 'relatou',
  'solicitou', 'sugeriu', 'propos', 'questionou', 'respondeu', 'submetidas', 'submetidos',
  'apurou', 'apurados', 'concluidos', 'concluidas', 'colocou', 'aprovou', 'votou'
].map((s) => _normLoose(s)));

// T01: TRATAMENTOS e CARGOS não são nome próprio (aparecem capitalizados na ata mas nunca são
// ditos assim no áudio: "Sra.", "Mesa Diretora", "Secretária da Ata"). Sem isto a ata real saía
// com dezenas de marcas espúrias ("[nome sem âncora na fonte: 'Sra']"). Não é blacklist de nome
// suspeito: são palavras que NUNCA identificam uma pessoa ou empresa.
const _GATE_NAO_NOME = new Set([
  'sr', 'sra', 'srta', 'srs', 'sras', 'dr', 'dra', 'exmo', 'exma', 'dona',
  'secretaria', 'secretario', 'diretora', 'diretor', 'diretoria', 'presidente', 'mesa',
  'sindica', 'sindico', 'subsindica', 'subsindico', 'conselheira', 'conselheiro', 'conselho',
  'fiscal', 'consultivo', 'condomina', 'condomino', 'condominos', 'tesoureira', 'tesoureiro',
  'assembleia', 'ata', 'edital', 'item', 'pauta', 'torre', 'bloco', 'unidade', 'advogado',
  'advogada', 'representante', 'gerente', 'zelador', 'zeladora', 'porteiro', 'administradora',
  // substantivos comuns que a ata capitaliza (achado da 2a rodada real, T01)
  'presidencia', 'regiao', 'banco', 'prefeitura', 'cartorio', 'justica', 'tribunal', 'estado',
  'municipio', 'governo', 'receita', 'federal', 'previdencia', 'codigo', 'civil', 'convencao',
  'regimento', 'interno', 'artigo', 'lei', 'processo',
  // tipo de assembleia (o usuário informa só a sigla AGO/AGE; a ata escreve por extenso)
  'geral', 'ordinaria', 'extraordinaria', 'reuniao', 'diretoria', 'moradores'
].map((s) => _normLoose(s)));

// Prefixos dos marcadores que o PRÓPRIO gate cria. Detectados na re-execução (idempotência):
// são reconhecidos e re-emitidos como flag, sem re-marcar o texto → Gate(Gate(ata)) estável.
const _GATE_PREFIXOS = {
  'nome sem âncora na fonte': { tipo: 'nome', severidade: 'suspeito' },
  'valor sem âncora': { tipo: 'valor', severidade: 'suspeito' },
  'voto atribuído a nome sem âncora': { tipo: 'placar', severidade: 'critico' }
};

// Mascara todo [ ... ] com espaços do MESMO tamanho (idx preservado). Serve para dois fins:
// (a) o gate NUNCA julga conteúdo já entre marcador honesto ([valor a confirmar], [nome a
// confirmar: '...']) — é incerteza declarada, não afirmação; (b) na re-execução, os próprios
// marcadores do gate (também [ ... ]) ficam invisíveis à extração, então nada é remarcado.
function _gateMascararColchetes(txt) {
  return String(txt).replace(/\[[^\]]*\]/g, (m) => ' '.repeat(m.length));
}

// Detecta marcadores que o próprio gate já colocou (re-execução). Devolve uma flag por
// marcador, com a MESMA severidade, para o conjunto de flags ser estável em Gate(Gate(ata)).
function _gateFlagsProprias(txt) {
  const s = String(txt);
  const out = [];
  const re = /\[(nome sem âncora na fonte|valor sem âncora|voto atribuído a nome sem âncora):\s*([^\]]*)\]/g;
  let m;
  while ((m = re.exec(s))) {
    const meta = _GATE_PREFIXOS[m[1]];
    out.push({ tipo: meta.tipo, severidade: meta.severidade, trecho: m[2].replace(/^'|'$/g, '').trim(), idx: m.index, motivo: 'ja sinalizado em passada anterior', reemitida: true });
  }
  return out;
}

// Extrai a RAIZ (tokens distintivos) de um run de nome, com idx absoluto de cada token. Token
// distintivo = tem minúscula (exclui CAIXA ALTA de cabeçalho: ITEM, ATA, CNPJ), >=3 chars, e
// não é sufixo genérico. Ex.: "Xurupita Engenharia" -> [Xurupita] (Engenharia é sufixo).
function _gateRaizesDistintivas(run, baseIdx) {
  const raizes = [];
  const reTok = /[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ.\/]*/g;
  let t;
  while ((t = reTok.exec(run))) {
    const tok = t[0].replace(/[.\/]+$/, '');
    if (tok.length < 3) continue;
    if (!/[a-zà-öø-ÿ]/.test(tok)) continue;               // sem minúscula = cabeçalho, ignora
    if (/^(d[aeo]s?|e|no|na|nos|nas|ao|aos|com|para|por)$/i.test(tok)) continue; // conectivo
    if (_SUFIXOS_NORM.has(_normLoose(tok))) continue;     // sufixo genérico, não é raiz
    if (_GATE_NAO_NOME.has(_normLoose(tok))) continue;    // T01: tratamento ou cargo, não é nome
    // ATENÇÃO: o filtro de _GATE_ABERTURAS NÃO fica aqui de propósito. Esta função alimenta OS
    // DOIS pools (afirmação isolada E objeto de voto). Filtrar abertura aqui tirava um nome
    // fabricado que colide com palavra gramatical (ex.: empresa "Assim") do pool de VOTO também,
    // e ele escapava recebendo votos, veredicto 'limpo' (achado do revisor). O filtro de abertura
    // agora vive em _gateAfirmacoesNome, condicionado a NÃO haver gatilho antes.
    raizes.push({ raiz: tok, idx: baseIdx + t.index, len: tok.length });
  }
  return raizes;
}

// Âncora de NOME para o gate. Passa se a raiz existe como palavra inteira na fonte
// (existeLiteral) OU se aparece como COMPONENTE separado por hífen (ex.: uma raiz "Alfa" dentro
// de um nome composto "Alfa-Beta" que a transcrição traz hifenizado). NÃO relaxa o existeLiteral
// compartilhado (aquele bloqueia hífen de propósito, pra o passe de consolidação não aplicar
// forma degradada); aqui a pergunta é outra, "esse nome está na fonte?", e um componente
// hifenizado ESTÁ. Ainda bloqueia letra/dígito/apóstrofo colados, então não vira substring solto.
function _gateAncorado(raiz, transcricaoTxt) {
  if (existeLiteral(raiz, transcricaoTxt)) return true;
  const norm = _normLoose(String(transcricaoTxt || '')).replace(/\s+/g, ' ');
  const alvo = _normLoose(String(raiz || '')).replace(/\s+/g, ' ').trim();
  if (!alvo) return false;
  const re = new RegExp("(?<![A-Za-zÀ-ÿ0-9'])" + _escapeRegex(alvo) + "(?![A-Za-zÀ-ÿ0-9'])");
  return re.test(norm);
}

// Palavras que, imediatamente antes de um nome, forçam sua inclusão mesmo em início de frase.
// T01: fronteira de palavra antes do gatilho. Sem ela "eficácia. Citou" casava "cia." (companhia)
// e a abertura de frase virava nome com gatilho.
const _GATE_GATILHO_NOME = /(?:^|[^A-Za-zÀ-ÿ])(empresa|firma|prestador|prestadora|construtora|fornecedor|fornecedora|vencedor|vencedora|loja|companhia|cia\.?|tinta|marca|condom[íi]nio|contrato|s[íi]ndic[oa]|sr\.?|sra\.?|dr\.?)\s*$/i;
// Gatilho no INÍCIO do próprio run (não só antes dele). Quando a frase abre com o gatilho
// capitalizado ("Empresa Xurupita apresentou..."), a palavra vira o 1o token do run e some do
// r.antes; sem isto o run inteiro caía no descarte de início-de-frase e o nome escapava (achado
// do revisor: nome fabricado com gatilho maiúsculo abrindo frase saía 'limpo').
const _GATE_GATILHO_INICIO = /^(empresa|firma|prestador|prestadora|construtora|fornecedor|fornecedora|loja|companhia|cia|s[íi]ndic[oa]|contrato|condom[íi]nio)\s+[A-ZÀ-ÖØ-Þ]/i;

// Todos os RUNS de nome próprio (capitalizado com minúscula) da ata, com idx e o texto anterior.
// Base comum de dois consumidores: o extrator de afirmação (filtra por início de frase) e o pool
// de candidatos a OBJETO DE VOTO (não filtra). Separar os dois fecha o achado do revisor: um nome
// que abre frase sem gatilho não é afirmação isolada, mas PODE ser o objeto de um placar.
function _gateRunsNome(masked) {
  const s = String(masked);
  const out = [];
  const reRun = /[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ]{2,}(?:\s+(?:d[aeo]s?|e)\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ]{2,}|\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ]{2,})*/g;
  let m;
  while ((m = reRun.exec(s))) {
    out.push({ run: m[0], idx: m.index, antes: s.slice(Math.max(0, m.index - 30), m.index) });
  }
  return out;
}

// EXTRATOR NOME (afirmação isolada, pra flag 'suspeito'). Só MEIO de frase (início de frase é
// gramática, não nome próprio), salvo quando precedido de gatilho ("empresa X"). Início de frase =
// . ! ? APENAS. ':' NÃO conta como início de frase: abre item de lista ("Fornecedores consultados:
// Xurupita...") onde um nome fabricado pode aparecer sem gatilho, e isentá-lo deixava a fabricação
// escapar (achado do revisor). O falso positivo em cabeçalho ("ITEM N) TÍTULO: Após...") é evitado
// por _GATE_ABERTURAS (abertura gramatical não vira raiz), não por tratar ':' como fim de frase.
// ';' também NÃO conta. Devolve uma afirmação por RAIZ distintiva.
function _gateAfirmacoesNome(masked) {
  const out = [];
  for (const r of _gateRunsNome(masked)) {
    const charAntes = (r.antes.match(/(\S)\s*$/) || [])[1] || '';
    const inicioFrase = charAntes === '' || /[.!?]/.test(charAntes);
    // Gatilho pode estar ANTES do run ("a empresa X") ou ser o 1o token do run ("Empresa X").
    const temGatilho = _GATE_GATILHO_NOME.test(r.antes) || _GATE_GATILHO_INICIO.test(r.run);
    if (inicioFrase && !temGatilho) continue;             // início de frase sem gatilho: gramática
    for (const raiz of _gateRaizesDistintivas(r.run, r.idx)) {
      // Abertura gramatical SÓ é descartada quando NÃO há gatilho antes. "Considerando a urgência"
      // (sem gatilho) é gramática; "empresa Assim" (com gatilho) é nome real e continua checado.
      if (!temGatilho && _GATE_ABERTURAS.has(_normLoose(raiz.raiz))) continue;
      out.push({ tipo: 'nome', raiz: raiz.raiz, formaNaAta: r.run.trim(), idx: raiz.idx, len: raiz.len });
    }
  }
  return out;
}

// POOL de candidatos a OBJETO DE VOTO: TODAS as raízes de nome, SEM o filtro de início de frase.
// Um nome que recebe votos é afirmação de fato mesmo abrindo frase (achado do revisor: o formato
// "[Nome], com (N) votos", prescrito no prompt do motor pra eleição de síndico, tem o nome no
// início da frase e escapava por completo — nem 'nome' nem 'placar', veredicto saía 'limpo').
function _gateRootsTodos(masked) {
  const out = [];
  for (const r of _gateRunsNome(masked)) {
    for (const raiz of _gateRaizesDistintivas(r.run, r.idx)) out.push(raiz);
  }
  return out;
}

// Limites da FRASE que contém idx (fronteiras . ! ? ou quebra de linha). O objeto de um placar é
// o nome na MESMA frase do "(N) votos"; ligar por frase, não por distância cega de caractere,
// impede que um nome ancorado de outra frase "roube" o vínculo (achado 2 do revisor). Um '.' só é
// fim de frase se vier SEGUIDO DE ESPAÇO ou fim de texto: assim o ponto de milhar de "R$ 10.900,00"
// (seguido de dígito) NÃO parte a frase e o objeto do voto continua na mesma frase da contagem.
function _sentencaAoRedor(s, idx) {
  const ehFim = (i) => {
    const c = s[i];
    if (c === '\n') return true;
    if (c === '.' || c === '!' || c === '?') {
      const nxt = s[i + 1];
      if (nxt === undefined) return true;
      if (!/\s/.test(nxt)) return false;              // "S.A" ou "10.900": sem espaço, não é fim
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      // Fim de frase REAL começa com maiúscula. "Ltda. obteve" / "S.A. venceu" (minúscula depois)
      // são abreviação, não ponto final: não partem a frase e o objeto do voto continua junto.
      return j >= s.length || /[A-ZÀ-ÖØ-Þ]/.test(s[j]);
    }
    return false;
  };
  let ini = 0;
  for (let i = idx; i >= 0; i--) { if (ehFim(i)) { ini = i + 1; break; } }
  let fim = s.length;
  for (let i = idx; i < s.length; i++) { if (ehFim(i)) { fim = i; break; } }
  return { ini, fim };
}

// EXTRATOR VALOR. Scan próprio de "R$ X.XXX,XX" (preciso do idx pra marcar no lugar, o que
// mencoesMonetarias não dá). Canoniza com _numPtBr (centavos), a MESMA escala de valoresCanonicos.
function _gateAfirmacoesValor(masked) {
  const s = String(masked);
  const out = [];
  const re = /R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}/g;
  let m;
  while ((m = re.exec(s))) {
    const literal = m[0];
    const canon = _numPtBr(literal.replace(/^R\$\s*/, ''));
    if (canon == null) continue;
    out.push({ tipo: 'valor', canon, formaNaAta: literal, idx: m.index, len: literal.length });
  }
  return out;
}

// EXTRATOR PLACAR. Acha cada "(N) votos" e devolve sua posição. Quem liga o voto ao OBJETO é o
// juiz, pelo nome MAIS PRÓXIMO na MESMA frase (ver _sentencaAoRedor e gateDeSaida). Não há regex
// própria de objeto aqui: a versão antiga usava /empresa .../gi, e o flag `i` tornava [A-Z]
// case-insensitive (casava minúscula), alargando o objeto por palavras comuns depois do nome;
// além de só reconhecer a palavra literal "empresa", perdendo "prestadora X"/"firma X". Ligar
// pelo pool completo de nomes na mesma frase fecha esses buracos.
function _gateAfirmacoesPlacar(masked) {
  const s = String(masked);
  const out = [];
  const re = /\((\d{1,3})\)\s*votos?/gi;
  let m;
  while ((m = re.exec(s))) {
    out.push({ tipo: 'placar', nVotos: Number(m[1]), votosIdx: m.index });
  }
  return out;
}

// O JUIZ. Reúne as afirmações, testa âncora contra a fonte, e para cada sem âncora cria uma
// MARCAÇÃO (idx, len, substituto). Aplica direita->esquerda (preserva offsets) e deriva as
// flags da MESMA lista aplicada (TRAVA 1). Verifica que toda marcação entrou no texto; se
// alguma falhou, veredicto nunca é 'limpo'.
function gateDeSaida(ataTxt, transcricaoTxt) {
  const original = String(ataTxt);
  const transcricao = String(transcricaoTxt || '');
  const masked = _gateMascararColchetes(original);

  const flagsExistentes = _gateFlagsProprias(original); // idempotência: re-emite sem remarcar
  const nomes = _gateAfirmacoesNome(masked);            // afirmação isolada (suspeito)
  const rootsTodos = _gateRootsTodos(masked);           // pool completo, pra objeto de voto
  const placares = _gateAfirmacoesPlacar(masked);
  const canonTrans = valoresCanonicos(transcricao);

  // OBJETO DE VOTO: o nome MAIS PRÓXIMO do "(N) votos" DENTRO DA MESMA FRASE. Pool completo, não
  // só as afirmações filtradas: um objeto de voto que abre frase ("Maria Souza, com (8) votos")
  // também tem que ser pego. Ligar por frase, não por distância cega, evita nome de outra frase
  // roubar o vínculo. LIMITAÇÃO REGISTRADA: referência anafórica cruzando frase ("a proposta ...
  // obteve N votos", proposta = empresa citada 2 frases antes) não é resolvível deterministicamente;
  // nesse caso o nome, se fabricado, ainda cai como 'suspeito' pelo laço de nome abaixo, só não vira
  // 'critico'. Marca sempre; a severidade é o que degrada, não a marcação.
  // Spans dos marcadores que o próprio gate já colocou (2a passada). Contam como "objeto já
  // sinalizado" no vínculo de placar: sem isto, quando o objeto real vira marcador e some do pool,
  // o voto re-ligava ao token seguinte (ex.: o verbo que abre a frase) e nascia flag nova — quebra
  // de idempotência. As posições batem com `masked` porque a máscara preserva o comprimento.
  const marcadorSpans = [];
  { const reMk = /\[(?:nome sem âncora na fonte|valor sem âncora|voto atribuído a nome sem âncora):[^\]]*\]/g; let mm; while ((mm = reMk.exec(original))) marcadorSpans.push({ ini: mm.index, fim: mm.index + mm[0].length }); }

  const objetoVotoIdx = new Set();
  for (const p of placares) {
    const sent = _sentencaAoRedor(masked, p.votosIdx);
    // PREFERE o nome imediatamente ANTES da contagem ("empresa X: N votos", "[Nome], com N votos"
    // — o formato dominante da ata tem o objeto ANTES). Só se não houver nenhum antes na frase é
    // que cai pro nome DEPOIS ("N votos para a empresa X"). Distância absoluta pegava o objeto do
    // item SEGUINTE ("(ii) empresa Bit") quando ele ficava mais perto que o objeto real do item.
    let antesMelhor = null, depoisMelhor = null;
    for (const c of rootsTodos) {
      if (c.idx < sent.ini || c.idx >= sent.fim) continue;
      // T01: abertura gramatical que é a PRIMEIRA palavra da frase ("Submetida a votação...",
      // "Procedeu-se...") não é objeto de voto; o objeto é o nome real da frase. Uma entidade
      // fabricada com o mesmo nome continua sendo pega quando vem com gatilho ("empresa Assim"),
      // porque aí não é a primeira palavra da frase. E só pula quando a frase TEM outro nome
      // candidato: "Assim venceu com (10) votos" (sem outro nome) continua ligando o voto a "Assim".
      // Abertura VERBAL (particípio ou pretérito: "Submetida", "Procedeu", "Apurou") abrindo a
      // frase nunca é objeto de voto, mesmo sem outro nome na frase ("Submetida a votação a
      // escolha entre os sistemas, um (1) voto..."). Advérbio/conector ("Assim") só é pulado
      // quando há outro nome (R4-A: "Assim venceu com (10) votos" continua crítico).
      const _abNorm = _normLoose(c.raiz);
      if (_GATE_ABERTURAS.has(_abNorm) && !masked.slice(sent.ini, c.idx).trim() &&
          (/(ad[ao]s?|id[ao]s?|ou|eu|iu)$/.test(_abNorm) ||
           rootsTodos.some((o) => o !== c && o.idx >= sent.ini && o.idx < sent.fim))) continue;
      if (c.idx < p.votosIdx) { if (!antesMelhor || c.idx > antesMelhor.idx) antesMelhor = c; }
      else if (!depoisMelhor || c.idx < depoisMelhor.idx) depoisMelhor = c;
    }
    // Objeto já sinalizado por passada anterior (marcador entre o candidato e a contagem, na frase)?
    // Então o placar está resolvido; _gateFlagsProprias re-emite a flag. Não re-liga a outro token.
    const objetoJaMarcado = marcadorSpans.some((sp) => sp.ini >= sent.ini && sp.fim <= p.votosIdx && (!antesMelhor || sp.ini > antesMelhor.idx));
    if (objetoJaMarcado) continue;
    const melhor = antesMelhor || depoisMelhor;
    if (melhor) objetoVotoIdx.add(melhor.idx);
  }
  const marcacoes = [];
  const marcadoIdx = new Set(); // evita marcar o mesmo token duas vezes (objeto de voto + nome)

  // 1) OBJETOS DE VOTO sem âncora -> CRÍTICO. Vêm do pool completo, então pegam também o nome que
  // abre frase (que o filtro de afirmação isolada descartaria). tipo 'placar' bate com _GATE_PREFIXOS
  // (idempotência da re-emissão na 2a passada).
  for (const c of rootsTodos) {
    if (!objetoVotoIdx.has(c.idx)) continue;
    if (_gateAncorado(c.raiz, transcricao)) continue;     // objeto de voto ancorado na fonte: ok
    marcacoes.push({
      idx: c.idx, len: c.len, tipo: 'placar', severidade: 'critico', trecho: c.raiz,
      substituto: "[voto atribuído a nome sem âncora: '" + c.raiz + "']",
      motivo: 'nome recebe votos sem existir na transcrição'
    });
    marcadoIdx.add(c.idx);
  }
  // 2) NOME (afirmação isolada) sem âncora -> SUSPEITO, se não já marcado como objeto de voto.
  for (const n of nomes) {
    if (marcadoIdx.has(n.idx)) continue;
    if (_gateAncorado(n.raiz, transcricao)) continue;     // tem âncora, passa (nome que existe na fonte)
    marcacoes.push({
      idx: n.idx, len: n.len, tipo: 'nome', severidade: 'suspeito', trecho: n.raiz,
      substituto: "[nome sem âncora na fonte: '" + n.raiz + "']",
      motivo: 'nome não existe na transcrição'
    });
    marcadoIdx.add(n.idx);
  }
  // 3) VALOR: canônico ausente da fala.
  for (const v of _gateAfirmacoesValor(masked)) {
    if (canonTrans.has(v.canon)) continue;                // valor dito, passa
    marcacoes.push({
      idx: v.idx, len: v.len, tipo: 'valor', severidade: 'suspeito', trecho: v.formaNaAta,
      substituto: '[valor sem âncora: ' + v.formaNaAta + ']',
      motivo: 'valor não dito na transcrição'
    });
  }

  // Aplica direita->esquerda, pulando sobreposição (nunca corrompe span já escrito).
  marcacoes.sort((a, b) => b.idx - a.idx);
  let ata = original;
  const aplicadas = [];
  let limiteEsq = Infinity;
  for (const mc of marcacoes) {
    if (mc.idx + mc.len > limiteEsq) continue;            // sobrepõe marcação já aplicada
    ata = ata.slice(0, mc.idx) + mc.substituto + ata.slice(mc.idx + mc.len);
    aplicadas.push(mc);
    limiteEsq = mc.idx;
  }

  // TRAVA 1: flags derivam da MESMA lista aplicada, mais as re-emitidas. Verifica aplicação.
  const marcacaoFalhou = aplicadas.some((mc) => ata.indexOf(mc.substituto) === -1);
  const flags = flagsExistentes.concat(aplicadas.map((mc) => ({
    tipo: mc.tipo, severidade: mc.severidade, trecho: mc.trecho, motivo: mc.motivo, idx: mc.idx
  })));
  // Ordem de LEITURA do documento (aplicadas vinham de trás pra frente). Pro revisor/UI ver as
  // flags na ordem em que aparecem na ata.
  flags.sort((a, b) => a.idx - b.idx);

  let veredicto;
  if (marcacaoFalhou) veredicto = 'critico';               // nunca 'limpo' com marcação não aplicada
  else if (flags.some((f) => f.severidade === 'critico')) veredicto = 'critico';
  else if (flags.length) veredicto = 'suspeito';
  else veredicto = 'limpo';

  return { ata, gate: { flags, veredicto, marcacaoFalhou } };
}

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
// cacheSystem (T01, revisão): cache_control só onde o MESMO system se repete na geração (as
// auditorias de bloco 2 e 3). Gravar cache custa 1,25x o input; em chamada de prefixo único é
// prejuízo, então ali o system segue como string simples, igual ao de antes.
// ctxCusto (T42, opcional): { funcao, usuario, condominio } para o registro de custo, que nunca
// atrasa nem derruba a chamada (custo.registrar volta na hora e não lança erro).
function chamarAnthropicAta(modeloPedido, maxTokens, system, userMessage, cacheSystem, ctxCusto) {
  // Marcador que escapou do motor da ata vira o modelo da ata (nunca vai para a API como nome).
  const modelo = modeloPedido === MODELO_DA_ATA ? modelos.modelo('ata') : modeloPedido;
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: modelo,
      max_tokens: maxTokens,
      // SEM temperature explicito: usa o default da API. Manter o estilo da ata que o
      // Matheus ja validou pela interface. A consistencia de VALOR nao vem de temperature
      // baixa (o reteste mostrou Enseada variando 14/13/12 mesmo com temperature 0), e sim
      // da correcao cirurgica deterministica (corrigirPlaceholdersDeliberacao) + auditoria
      // fracionada. Ver RÉGUA REALISTA no roadmap: alvo consertado por codigo, conflito real
      // marcado [a confirmar], ruido fora. Reversao do temperature 0 autorizada em 2026-07-08.
      //
      // PROMPT CACHING (mesma forma do wip feat/prompt-cache-anthropic, só a parte da ata): o
      // system (SKILL + regras + glossário, e na T01 os documentos da assembleia anexados no FIM)
      // é idêntico entre as chamadas de mesmo tipo de uma geração (ex.: as até 3 auditorias de
      // bloco). Só marcamos o fim desse prefixo com cache_control, SEM reordenar nada. O
      // userMessage (variável) continua depois, fora do cache. userMessage pode ser string ou
      // lista de blocos (a leitura de PDF escaneado manda o PDF como bloco document).
      system: cacheSystem ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system,
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
          // T42: custo da chamada (volta na hora; falha vira só log).
          if (j && j.usage) custo.registrar({ funcao: (ctxCusto && ctxCusto.funcao) || 'atas', modelo, usage: j.usage, usuario: ctxCusto && ctxCusto.usuario, condominio: ctxCusto && ctxCusto.condominio, ok: resp.statusCode === 200, status: resp.statusCode });
          // Telemetria de cache (só contagem de token, nunca conteúdo).
          if (j && j.usage) {
            console.log('[ATA cache] modelo=' + modelo +
              ' cache_creation=' + (j.usage.cache_creation_input_tokens || 0) +
              ' cache_read=' + (j.usage.cache_read_input_tokens || 0) +
              ' input=' + (j.usage.input_tokens || 0));
          }
          // Modelos novos podem devolver outros blocos antes do texto: junta só os de texto.
          const texto = (Array.isArray(j.content) ? j.content : []).filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
          if (!texto) console.warn('[ATA] sem texto: status=' + resp.statusCode + ' stop=' + (j && j.stop_reason) + ' blocos=' + (Array.isArray(j && j.content) ? j.content.map((b) => b && b.type).join(',') : '-') + ' erro=' + (j && j.error && j.error.type || '-'));
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
// ATUALIZAÇÃO (2026-07-09): a etapa 3 do passe de consolidação de nome próprio
// (consolidarNomesProprios) pode somar mais 1 chamada quando sobra candidato ambíguo, então
// o pior caso real pode chegar a 8. O teto abaixo continua sendo o corte HARD de verdade —
// se a 8ª chamada estourar o teto, a etapa 3 falha ABERTA (try/catch próprio, telemetria
// 'pulada_teto') e a ata segue sem a consolidação daquele passe, nunca aborta a geração inteira.
const MAX_CHAMADAS_ANTHROPIC_POR_ATA = 7;

// Motor de geração — roda em background, sem prender a requisição HTTP. Entrega a
// PRIMEIRA passada Sonnet que retornar texto; a validação é só aviso, nunca bloqueia
// nem dispara retry. Retry (1x, Sonnet) só se a API não retornar texto. Sem Opus.
// Modelo da ata: ATA_MODELO no ambiente (padrão claude-sonnet-5-5, decisão 21/10 03h05; 4.6 só para teste interno). Teste comparativo pode trocar por
// geração (só pela chave interna). O uso de tokens de cada geração fica em uso_tokens.
// T42: padrão em servico/modelos.js (função ata; ATA_MODELO continua valendo), lido a cada geração.
const ATA_MODELOS_PERMITIDOS = ['claude-sonnet-4-6', 'claude-sonnet-5-5'];
async function gerarAtaJob(jobId, userMessage, documentosEntrada, idConferencia, opcoes) {
  const modeloSonnet = (opcoes && ATA_MODELOS_PERMITIDOS.includes(opcoes.modelo)) ? opcoes.modelo : modelos.modelo('ata');
  // T42: quem gerou e de qual condomínio, só para o registro de custo.
  const ctxCusto = { funcao: 'atas', usuario: opcoes && opcoes.usuario, condominio: opcoes && opcoes.condominio };
  const usoTokens = { entrada: 0, saida: 0, cache_lido: 0, cache_criado: 0, por_modelo: {} };
  const trocaModelo = (m) => (m === MODELO_DA_ATA ? modeloSonnet : m);
  const somarUso = (m, r) => {
    const u = r && r.raw && r.raw.usage;
    if (!u) return r;
    usoTokens.entrada += u.input_tokens || 0; usoTokens.saida += u.output_tokens || 0;
    usoTokens.cache_lido += u.cache_read_input_tokens || 0; usoTokens.cache_criado += u.cache_creation_input_tokens || 0;
    const pm = usoTokens.por_modelo[m] || (usoTokens.por_modelo[m] = { entrada: 0, saida: 0, cache_lido: 0, cache_criado: 0, chamadas: 0 });
    pm.entrada += u.input_tokens || 0; pm.saida += u.output_tokens || 0; pm.cache_lido += u.cache_read_input_tokens || 0; pm.cache_criado += u.cache_creation_input_tokens || 0; pm.chamadas++;
    return r;
  };
  const documentos = Array.isArray(documentosEntrada) ? documentosEntrada : [];
  let system = ATA_SKILL_MD + '\n\n---\n\n' + CONTEXTO_GRUPO_SERVICE + '\n\n---\n\n' + REGRAS_ANTI_ERRO + '\n\n---\n\n' + REGRAS_DETALHAMENTO_MAXIMO + '\n\n---\n\n' + REGRAS_FIDELIDADE_TRANSCRICAO + (GLOSSARIO_MD ? '\n\n---\n\n' + GLOSSARIO_MD : '');
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
  // MAX = 7 = pior caso legítimo (1 geração + 1 retry + até 3 auditorias de bloco +
  // 1 inserção Sonnet + 1 inserção Opus). Típico: 2 a 5, sem Opus. A etapa 3 do passe de
  // consolidação de nome próprio pode somar mais 1 (pior caso real = 8); se estourar o teto
  // aqui, ela falha ABERTA sozinha (ver consolidarNomesProprios), não aborta a geração.
  let _chamadas = 0;
  const chamar = (modelo, maxTokens, sys, msg, cacheSystem) => {
    if (++_chamadas > MAX_CHAMADAS_ANTHROPIC_POR_ATA) {
      throw new Error('TETO_CHAMADAS: teto de ' + MAX_CHAMADAS_ANTHROPIC_POR_ATA + ' chamadas à API por geração atingido; abortado para não gerar custo');
    }
    const m = trocaModelo(modelo);
    return chamarAnthropicAta(m, maxTokens, sys, msg, cacheSystem, ctxCusto).then((r) => somarUso(m, r));
  };

  // ─── DOCUMENTOS DA ASSEMBLEIA (T01) ───────────────────────────────────────
  // Estado da geração com documentos. Sem documento tudo fica neutro e o motor roda igual.
  let mensagemGeracao = userMessage;   // o que vai para a geração (userMessage + documentos)
  let extraSysDocs = '';                // regras + texto dos documentos para auditoria e inserção
  let textoDocs = '';                   // texto puro somado dos documentos (grounding)
  let canonConferencia = new Set();     // valores já apontados como divergentes pela conferência
  let docsInfo = [];
  const transcricaoBase = extrairTranscricao(userMessage);
  let fonteNomes = transcricaoBase;
  // Fonte do gate = tudo que é fonte OFICIAL entregue ao modelo: a mensagem do usuário (dados da
  // reunião, edital anexado, participantes, transcrição) e o contexto fixo da administradora.
  // Medido na ata real Casablanca (T01, 20/10/2026): só com a transcrição o gate marcava o nome
  // da síndica, o endereço e a administradora, que vêm do edital e do contexto, em TODA ata.
  // Limite conhecido e aceito: nome que só existe no edital passa como ancorado (edital é fonte
  // oficial, não é invenção). Com documentos, o texto deles entra também (prepararDocumentos).
  const fonteGateBase = userMessage + '\n' + CONTEXTO_GRUPO_SERVICE;
  let fonteGate = fonteGateBase;
  let _chamadasApoio = 0;
  const chamarApoio = (modelo, maxTokens, sys, msg) => {
    if (++_chamadasApoio > MAX_CHAMADAS_APOIO_POR_ATA) {
      throw new Error('TETO_APOIO: teto de ' + MAX_CHAMADAS_APOIO_POR_ATA + ' chamadas de apoio por geração atingido');
    }
    const m = trocaModelo(modelo);
    return chamarAnthropicAta(m, maxTokens, sys, msg, false, ctxCusto).then((r) => somarUso(m, r));
  };
  async function prepararDocumentos() {
    if (!documentos.length) return;
    const systemAntes = system;
    try {
      // 1) PDFs escaneados lidos em PARALELO (cada um conta no teto de apoio). Falhou: segue sem ele.
      await Promise.all(documentos.filter((d) => d.pdfBase64).map(async (d) => {
        try {
          const lido = await lerDocumentoEscaneado(d, chamarApoio);
          if (lido) d.texto = (d.texto ? d.texto + '\n' : '') + lido.slice(0, DOCS_APOIO_MAX_CHARS_DOC);
          else d.falhou = true;
        } catch (e) { d.falhou = true; }
        d.pdfBase64 = null; // libera memória: o PDF não é mais necessário
      }));
      const { bloco, textoIncluido } = montarBlocoDocumentos(documentos);
      docsInfo = documentos.map((d) => ({ nome: d.nome, origem: d.origem, caracteres: (d.texto || '').length, truncado: !!d.truncado, falhou: !!d.falhou }));
      if (!bloco) return;
      textoDocs = textoIncluido;
      fonteNomes = transcricaoBase + '\n' + textoDocs;
      fonteGate = fonteGateBase + '\n' + textoDocs;
      // 2) Conferência transcrição x documento (1 chamada). Falha aberta.
      let conferencia = '';
      try { conferencia = await conferirTranscricaoComDocumentos(transcricaoBase, bloco, chamarApoio); }
      catch (e) { conferencia = ''; }
      // ÂNCORA da conferência (anti invenção): a linha só segue para a geração se o lado
      // "documento:" estiver de fato no texto do documento (valor canônico, ou todas as palavras
      // distintivas do nome). Na ata real a conferência listou variações da PRÓPRIA fala
      // ("DM Mantas" x "ADN Mantas") como se fossem do documento; isso agora é descartado.
      const canonDocsConf = valoresCanonicos(textoDocs);
      conferencia = (conferencia ? conferencia.split('\n') : []).filter((l) => {
        const ld = ((l.match(/documento:\s*([^|]*)/i) || [])[1] || '').replace(/["“”']/g, '').trim();
        if (!ld) return false;
        const vd = [...valoresCanonicos('valor ' + ld)];
        if (vd.length) return vd.every((v) => canonDocsConf.has(v));
        const palavras = ld.split(/\s+/).filter((w) => w.length >= 3 && /[A-Za-zÀ-ÿ]/.test(w));
        return palavras.length > 0 && palavras.every((w) => existeLiteral(w.replace(/[.,;:()]+/g, ''), textoDocs));
      }).join('\n');
      // Valor do lado da TRANSCRIÇÃO só entra no filtro quando a linha é VERIFICÁVEL: o valor do
      // lado "documento:" existe de fato no texto do documento e o da transcrição existe de fato
      // na fala. Linha inventada pela conferência não suprime lacuna nenhuma.
      const canonDocs = valoresCanonicos(textoDocs);
      const canonFala = valoresCanonicos(transcricaoBase);
      canonConferencia = new Set();
      for (const l of (conferencia ? conferencia.split('\n') : [])) {
        const lt = (l.match(/transcri[çc][ãa]o:\s*([^|]*)/i) || [])[1] || '';
        const ld = (l.match(/documento:\s*([^|]*)/i) || [])[1] || '';
        const vt = [...valoresCanonicos('valor ' + lt)];
        const vd = [...valoresCanonicos('valor ' + ld)];
        if (vt.length === 1 && vd.length === 1 && vt[0] !== vd[0] && canonDocs.has(vd[0]) && canonFala.has(vt[0])) canonConferencia.add(vt[0]);
      }
      // 3) Regras no FIM do system (anexo, sem reordenar) e documentos + conferência no FIM da mensagem.
      system += '\n\n---\n\n' + REGRAS_DOCUMENTOS_APOIO;
      extraSysDocs = REGRAS_DOCUMENTOS_APOIO + '\n\nATENÇÃO NESTA AUDITORIA: esta assembleia tem os DOCUMENTOS OFICIAIS abaixo. A ata pode trazer valores, empresas e nomes na forma do DOCUMENTO, seguidos de [conferir: transcrição dizia X]. Isso é CORRETO. Não aponte como lacuna nem como divergência um dado da ata que bate com o documento, nunca troque esse dado pela forma da transcrição nem o rebaixe para [a confirmar], e preserve todo marcador [conferir: ...].\n\n' + bloco;
      mensagemGeracao = userMessage + '\n\n' + bloco +
        (conferencia ? '\n\n=== CONFERÊNCIA PRÉVIA: TRANSCRIÇÃO x DOCUMENTOS ===\nNestes pontos a fala diverge do documento. Use a forma do DOCUMENTO e marque logo depois [conferir: transcrição dizia X] (regra DOC 2).\n' + conferencia : '') +
        '\n\nLembrete: os DOCUMENTOS DA ASSEMBLEIA acima são a fonte oficial prioritária para números, empresas e nomes (regras DOC). Votos e deliberações vêm só da transcrição.';
    } catch (e) {
      // Falha aberta: qualquer erro inesperado aqui volta ao estado NEUTRO (ata sem documentos).
      console.error('[engine-ata] preparo dos documentos falhou, seguindo sem eles:', e && e.message);
      system = systemAntes; mensagemGeracao = userMessage; extraSysDocs = ''; textoDocs = '';
      fonteNomes = transcricaoBase; fonteGate = fonteGateBase; canonConferencia = new Set();
      docsInfo = documentos.map((d) => ({ nome: d.nome, origem: d.origem, caracteres: 0, truncado: false, falhou: true }));
    }
  }

  // Entrega a ata com AUDITORIA DE COMPLETUDE FRACIONADA:
  //  1) a ata já veio gerada (texto);
  //  2) divide a transcrição em N blocos (1..3 por tamanho) e audita cada bloco (Sonnet)
  //     buscando fatos/valores daquele trecho ausentes na ata;
  //  3) havendo lacunas, insere CIRURGICAMENTE (Sonnet), sem reescrever/condensar;
  //  4) OPUS só se a inserção Sonnet QUEBRAR (guarda de tamanho/pareceAta rejeitar).
  async function entregarAta(texto, modelo_usado, tentativaIdx) {
    const transcricao = extrairTranscricao(userMessage);
    const fmtBRL = (c) => 'R$ ' + c.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const canonAtaBase = valoresCanonicos(texto);
    // GUARDA DE CONDENSAÇÃO (crítico 2): a inserção só pode ACRESCENTAR. Se a saída ficar
    // menor que a ata base (encurtou/condensou), REJEITA e mantém a ata rica original.
    const aceitaInsercao = (res) => !!(res && validarAta(res).pareceAta && res.length >= texto.length * 0.95);

    let ataFinal = texto;
    let etapa = 'sem_lacuna';
    let usouOpus = false;
    let cortadoPorTeto = false;
    let numBlocos = 0;
    let numGapsDet = 0;
    // Moderado 6: TODO o fluxo de auditoria/inserção sob try. Se o teto de chamadas estourar
    // no meio (loop de blocos ou inserção), entrega a MELHOR ata que já temos, em vez de
    // descartar a ata gerada com sucesso.
    try {
      const blocos = dividirEmBlocos(transcricao, numBlocosAuditoria(transcricao));
      numBlocos = blocos.length;
      let lacunas = '';
      for (let i = 0; i < blocos.length; i++) {
        const res = await auditarBlocoCompletude(texto, blocos[i], i + 1, blocos.length, chamar, extraSysDocs);
        if (res && /LACUNA/i.test(res) && !/^NENHUMA LACUNA\s*$/i.test(res)) lacunas += res + '\n';
      }
      lacunas = lacunas.trim();
      // GARANTIA DETERMINÍSTICA de valor: toda menção monetária da FALA (formal/informal) ausente
      // da ata base vira lacuna COM contexto, mesmo que a auditoria de bloco (LLM) tenha deixado
      // passar. Fecha a variância (ex.: 2.071 no Enseada).
      const jaFlag = valoresCanonicos(lacunas);
      const vistos = new Set();
      const gapsDet = [];
      for (const mnc of mencoesMonetarias(transcricao)) {
        if (canonAtaBase.has(mnc.canon) || jaFlag.has(mnc.canon) || vistos.has(mnc.canon)) continue;
        // T01: valor da fala que a conferência já apontou como divergente do documento NÃO volta
        // como lacuna (a ata usa a forma do documento + [conferir: transcrição dizia X]).
        if (canonConferencia.has(mnc.canon)) continue;
        vistos.add(mnc.canon);
        gapsDet.push('LACUNA (' + fmtBRL(mnc.canon) + '): valor dito na assembleia, confira se entra em algum item — "' + mnc.trecho + '"');
      }
      numGapsDet = gapsDet.length;
      const gapList = [lacunas, gapsDet.join('\n')].filter(Boolean).join('\n').trim();
      if (gapList.length > 0) {
        const inserida = await inserirLacunasNaAta(texto, gapList, MODELO_DA_ATA, chamar, extraSysDocs);
        if (aceitaInsercao(inserida)) { ataFinal = inserida; etapa = 'insercao_sonnet'; }
        else {
          // inserção Sonnet quebrou OU tentou condensar → mantém original e tenta OPUS (último recurso).
          etapa = inserida ? 'insercao_sonnet_condensou_usou_original' : 'insercao_sonnet_quebrou_usou_original';
          const opus = await inserirLacunasNaAta(texto, gapList, modelos.modelo('ata_ultimo_recurso'), chamar, extraSysDocs);
          if (aceitaInsercao(opus)) { ataFinal = opus; etapa = 'insercao_opus'; usouOpus = true; }
        }
      }
    } catch (e) {
      if (/TETO_CHAMADAS/.test(String(e && e.message))) { cortadoPorTeto = true; if (etapa === 'sem_lacuna') etapa = 'teto_cortou_entregou_base'; }
      else { throw e; }
    }

    // PASSE DE CONSOLIDAÇÃO DE NOME PRÓPRIO (aditivo): depois da auditoria/inserção, ANTES da
    // cirúrgica. Falha aberto (nunca quebra a entrega). Ver consolidarNomesProprios.
    // T01: com documentos, o grounding de nome aceita também o texto ESCRITO dos documentos
    // (nome de empresa que só aparece certo no orçamento passa a ser forma válida). Sem documento,
    // fonteNomes === transcricao e o passe é idêntico ao de antes.
    const consol = await consolidarNomesProprios(ataFinal, fonteNomes, chamar);
    ataFinal = consol.ata;

    // CORREÇÃO CIRÚRGICA DETERMINÍSTICA (por código, NÃO pelo LLM): preenche
    // [valor a confirmar] com o valor de deliberação falado quando o casamento é
    // 1-para-1. Fecha a variância do Sonnet (que ora preenche, ora deixa placeholder)
    // sem forçar valor de ruído. Roda sobre a MELHOR ata que temos (mesmo se cortou por teto).
    // T01: com documentos, a cirúrgica NÃO pode preencher placeholder com o valor da fala que a
    // conferência provou divergente do documento (ex.: o arredondado no lugar do exato). Esses
    // valores são removidos da fala que ela enxerga. Sem documento, canonConferencia é vazio.
    const cir = corrigirPlaceholdersDeliberacao(ataFinal, canonConferencia.size ? _ocultarValoresFala(transcricao, canonConferencia) : transcricao);
    ataFinal = cir.ata;

    // ►► GATE DE SAÍDA (determinístico). Última passada, sobre a ata já reparada. Código puro,
    // ZERO chamada Anthropic. Marca o que não tem âncora na fonte e devolve veredicto. A marcação
    // envelopa o trecho sem apagar o número (o diagnóstico de valor abaixo segue são; provado por
    // harness). Ver gateDeSaida.
    // FALHA ABERTO (regra de ouro do projeto): se o gate lançar por bug futuro, NUNCA descartar
    // a ata já gerada e paga. Entrega a ata sem marca e sinaliza a falha do próprio gate.
    // T01: valores da ata que existem SÓ no documento (nem na fala, nem no edital/dados) viram
    // aviso para o revisor conferir se foram de fato apresentados na reunião (regra DOC 3/4).
    let valoresSoDocumento = [];
    if (textoDocs) {
      try {
        const cFonte = valoresCanonicos(fonteGateBase);
        const cDocs = valoresCanonicos(textoDocs);
        valoresSoDocumento = [...valoresCanonicos(ataFinal.replace(/\[conferir:[^\]]*\]/g, ' '))].filter((v) => cDocs.has(v) && !cFonte.has(v));
      } catch (eSo) { valoresSoDocumento = []; }
    }

    // T01: marcador [conferir: ...] só sobrevive se o dado antes dele estiver no documento.
    let conferirTel = { mantidos: 0, removidos: 0 };
    try {
      const vc = validarMarcadoresConferir(ataFinal, textoDocs);
      ataFinal = vc.ata; conferirTel = { mantidos: vc.mantidos, removidos: vc.removidos };
    } catch (eVc) { console.error('[engine-ata] validador de [conferir] falhou (segue sem):', eVc && eVc.message); }

    let g;
    try {
      // T01: fonte do gate = fontes oficiais (ver fonteGateBase) + texto dos documentos que o
      // modelo viu. O que não estiver sustentado por nenhuma delas continua marcado.
      g = gateDeSaida(ataFinal, fonteGate);
      ataFinal = g.ata;
    } catch (eGate) {
      // Mensagem crua da exceção fica SÓ no log do servidor (pode conter trecho de ata/transcrição
      // se um throw futuro interpolar conteúdo). Ao cliente vai só um rótulo fixo.
      console.error('[engine-ata] gate de saída falhou (entrega sem marca):', eGate && eGate.message);
      g = { gate: { flags: [], veredicto: 'erro_gate', marcacaoFalhou: false, erro: 'falha_interna_no_gate' } };
    }

    // T07: confere nome e unidade dos participantes citados contra o cadastro do Superlógica
    // (só leitura, só quando a tela mandou o código e o usuário tem acesso). Não altera a ata:
    // devolve a lista para a tela mostrar quem não bateu. Falha aberta, com teto de tempo.
    let participantes = null;
    if (idConferencia) {
      try {
        const pessoasMod = require('./superlogica/pessoas');
        const cli = require('./superlogica').cliente({ base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN });
        const pessoas = await Promise.race([
          pessoasMod.carregarPessoas(cli, idConferencia),
          new Promise((_, rej) => setTimeout(() => rej(new Error('tempo_esgotado')), 40000)),
        ]);
        const conf = pessoasMod.conferirParticipantes(ataFinal, pessoas);
        participantes = { conferidos: conf.itens.length, divergentes: conf.divergentes, parcial: conf.parcial, sindico: pessoasMod.conferirSindico(ataFinal, pessoas) };
      } catch (eP) {
        console.warn('[engine-ata] conferência de participantes falhou (segue sem):', eP && eP.message);
        participantes = { erro: 'Não foi possível conferir os participantes no cadastro do Superlógica agora.' };
      }
    }

    const vFinal = validarAta(ataFinal);
    const canonFinal = valoresCanonicos(ataFinal);
    // diagnóstico determinístico: valores da fala fora da ata final.
    const falaFaltandoFinal = [...new Set(mencoesMonetarias(transcricao).map((m) => m.canon))].filter((c) => !canonFinal.has(c));
    tentativas[tentativaIdx].auditoria_fracionada = {
      blocos: numBlocos, etapa, usouOpus, cortadoPorTeto, chamadas: _chamadas, gaps_deterministicos: numGapsDet,
      placeholders_preenchidos: cir.preenchidos.map((p) => fmtBRL(p.canon)),
      placeholders_ambiguos: cir.ambiguos.length,
      valores_fala_faltando_final: falaFaltandoFinal.map(fmtBRL),
      consolidacao_nome: consol.telemetria
    };
    return concluir({
      ata: ataFinal,
      modelo_usado: (usouOpus ? modelo_usado + ' + opus (inserção)' : modelo_usado).replace(MODELO_DA_ATA, modeloSonnet),
      uso_tokens: usoTokens,
      tentativas, auditoria: etapa, avisos: consol.avisoSkip ? vFinal.avisos.concat([consol.avisoSkip]) : vFinal.avisos,
      gate: g.gate,
      documentos: docsInfo,
      participantes,
      conferencia: { divergencias: (ataFinal.match(/\[conferir:/g) || []).length, marcadores_removidos: conferirTel.removidos, valores_so_documento: valoresSoDocumento.length, chamadas_apoio: _chamadasApoio }
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
    // T01: prepara os documentos da assembleia ANTES da geração (leitura de escaneado e
    // conferência transcrição x documento). Falha aberta: problema aqui nunca impede a ata.
    await prepararDocumentos();
    let r = await chamar(MODELO_DA_ATA, 32000, system, mensagemGeracao);
    tentativas.push({ modelo: MODELO_DA_ATA, max_tokens: 32000, status: r.status, erro: r.erro || null });
    if (r.ok && r.texto && r.texto.trim()) {
      tentativas[0].validacao = validarAta(r.texto);
      return await entregarAta(r.texto, MODELO_DA_ATA, 0);
    }

    // Só chega aqui se a API NÃO retornou texto na 1a. UM único retry Sonnet.
    console.warn('[engine-ata] Tentativa 1 sem texto (' + (r.erro || 'status ' + r.status) + '). Fazendo 1 retry Sonnet (SEM Opus).');
    r = await chamar(MODELO_DA_ATA, 32000, system, mensagemGeracao);
    tentativas.push({ modelo: MODELO_DA_ATA, max_tokens: 32000, status: r.status, erro: r.erro || null });
    if (r.ok && r.texto && r.texto.trim()) {
      tentativas[1].validacao = validarAta(r.texto);
      return await entregarAta(r.texto, MODELO_DA_ATA, 1);
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
// limit 36mb (T01): até 3 PDFs escaneados de 8MB em base64 (~11MB cada) mais a transcrição.
app.post('/api/atas/gerar', requireAuth, express.json({ limit: '36mb' }), async (req, res) => {
  if (!ANTHROPIC_KEY || !ATA_SKILL_MD) { console.error('[ata] gerador sem configuração'); return res.status(503).json({ erro: 'indisponivel', detalhe: 'A geração de atas está indisponível no momento.' }); }
  const b = req.body || {};
  const p = await perfilDe(req);
  if (req.authMode !== 'internal' && !podeModulo(p, 'atas', 'gerar')) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não pode gerar atas.' });

  // T16: ata só de condomínio que está na base do sistema (vale para todos).
  const idSL = b.id_superlogica != null ? String(b.id_superlogica) : '';
  if (!/^[1-9][0-9]{0,8}$/.test(idSL)) return res.status(400).json({ erro: 'condominio_obrigatorio', detalhe: 'Escolha o condomínio da ata.' });
  if (!(await _exigirCarteira(req, res, idSL))) return; // T18: só condomínio da carteira
  const cond = await condominioDaBase(idSL);
  if (!cond && req.authMode !== 'internal') {
    auditoria.evento(req, 'ata_recusada', { id_superlogica: idSL, motivo: 'condominio_fora_da_base' }, true, 'condominio_fora_da_base');
    return res.status(403).json({ erro: 'condominio_fora_da_base', detalhe: 'Esse condomínio não está na base do sistema.' });
  }

  // T16: a transcrição vem do banco (pelo código). Texto solto só para quem tem transcrição livre,
  // e ainda assim fica guardado.
  const userId = (req.user && req.user.sub) || null;
  let transc = null;
  if (b.transcricao_id) transc = await audioMod.lerTranscricaoDoUsuario(supabaseAdminRequest, b.transcricao_id, userId);
  if (!transc && typeof b.transcricao_texto === 'string' && b.transcricao_texto.trim().length >= 50) {
    if (req.authMode !== 'internal' && !temAcao(p, 'atas', 'transcricao_livre')) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Envie o áudio ou o arquivo .txt da reunião.' });
    const texto = b.transcricao_texto.trim().slice(0, 2000000);
    const ins = await supabaseAdminRequest('POST', '/rest/v1/transcricoes', { user_id: userId, email: (req.user && req.user.email) || null,
      id_superlogica: Number(idSL), condominio_nome: cond ? cond.nome : null, origem: 'editada', status: 'pronta', texto, caracteres: texto.length });
    const row = ins.status === 201 && Array.isArray(ins.body) ? ins.body[0] : null;
    if (!row) return res.status(500).json({ erro: 'falha_registro', detalhe: 'Não foi possível registrar a transcrição.' });
    transc = row;
  }
  if (!transc) return res.status(400).json({ erro: 'transcricao_obrigatoria', detalhe: 'Envie o áudio ou o arquivo da transcrição antes de gerar.' });
  // Transcrição feita para um condomínio não vira ata de outro (salvo quem tem transcrição livre).
  if (transc.id_superlogica && String(transc.id_superlogica) !== idSL && req.authMode !== 'internal' && !temAcao(p, 'atas', 'transcricao_livre')) {
    auditoria.evento(req, 'ata_recusada', { id_superlogica: idSL, transcricao_id: transc.id, condominio_da_transcricao: transc.id_superlogica }, true, 'transcricao_de_outro_condominio');
    return res.status(400).json({ erro: 'transcricao_de_outro_condominio', detalhe: 'Essa transcrição foi feita para outro condomínio. Envie o áudio desta reunião.' });
  }

  // T01: documentos da assembleia (opcional). Lista inválida recusa antes de gastar API.
  const docsNorm = normalizarDocumentosApoio(b.documentos);
  if (docsNorm.erro) return res.status(400).json({ erro: 'documentos_invalidos', detalhe: docsNorm.erro });

  // Nome, CNPJ e endereço do cabeçalho vêm do cadastro lido aqui no servidor, nunca da tela
  // (senão daria para escolher um condomínio da base e escrever o de outro).
  const dados = Object.assign({}, b.dados || {});
  if (req.authMode !== 'internal' || !dados.condominio) {
    let cad = null;
    if (superlogicaNativa()) {
      try { cad = await slModulo.buscarCadastro(slModulo.cliente({ base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN }), idSL); }
      catch (e) { cad = null; }
    }
    dados.condominio = (cad && (cad.nome || cad.nome_fantasia)) || (cond && cond.nome) || '';
    dados.cnpj = (cad && cad.cnpj) || '';
    dados.endereco = (cad && cad.endereco && cad.endereco.completo) || '';
    dados.cadastro_oficial = !!cad;
  }
  const userMessage = ataMensagem.montarMensagemAta(dados, transc.texto);

  supabaseAdminRequest('PATCH', '/rest/v1/transcricoes?id=eq.' + transc.id, { usada_em_ata: new Date().toISOString(), id_superlogica: Number(idSL), condominio_nome: cond ? cond.nome : null }).catch(() => {});
  auditoria.evento(req, 'ata_gerada', { id_superlogica: idSL, transcricao_id: transc.id, condominio: cond ? cond.nome : null });

  const jobId = crypto.randomUUID();
  atasJobs.set(jobId, { status: 'processing', criadoEm: Date.now(), dono: req.authMode === 'internal' ? 'internal' : String(userId || '') });
  // fire-and-forget: não aguarda. gerarAtaJob já trata tudo internamente; o .catch
  // é rede de segurança caso algo escape do try interno.
  // Só confere quem tem acesso aos dados do Superlógica (a checagem é feita aqui, antes do job).
  const podeConferir = async () => {
    if (!superlogicaNativa()) return null;
    if (req.authMode === 'internal') return idSL;
    if (!SUPABASE_SERVICE_ROLE_KEY) return null;
    try { return (await podeUsarSuperlogica(userId)) ? idSL : null; } catch (e) { return null; }
  };
  podeConferir().then((idConf) => gerarAtaJob(jobId, userMessage, docsNorm.docs, idConf, { modelo: req.authMode === 'internal' ? b.modelo_teste : undefined, usuario: userId, condominio: idSL })).catch((e) => {
    console.error('[ata] erro fora do job:', e && e.message);
    const j = atasJobs.get(jobId);
    if (j && j.status === 'processing') { j.status = 'error'; j.erro = { httpStatus: 500, erro: 'erro_inesperado' }; }
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
  // T07: só quem criou a geração lê o resultado (o resultado pode trazer nomes de moradores).
  if (j && j.dono) {
    const quem = req.authMode === 'internal' ? 'internal' : String((req.user && req.user.sub) || '');
    if (quem !== j.dono) return enviar(404, { status: 'not_found' });
  }
  if (!j) return enviar(404, { status: 'not_found' });
  // T17: só o que a tela usa; nada de modelo, tentativas ou erro técnico do serviço.
  if (j.status === 'done') return enviar(200, Object.assign({ status: 'done' }, req.authMode === 'internal' ? j.payload : ataMensagem.limparResultadoAta(j.payload)));
  if (j.status === 'error') return enviar(200, Object.assign({ status: 'error' }, ataMensagem.limparErroAta(j.erro)));
  return enviar(200, { status: 'processing', esperando_s: Math.round((Date.now() - j.criadoEm) / 1000) });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/admin/usuarios/* — gestão de usuários (GESTOR, ou GERENTE com pode_convidar só sobre OPERACIONAL)
//
// Usa SUPABASE_SERVICE_ROLE_KEY pra falar com GoTrue admin (criar/deletar/listar
// usuários em auth.users) e PostgREST (CRUD em public.profiles). Sem essa env,
// devolve 503.
//
// Cadeia: requireAuth → requireServiceRoleKey → requireGestaoUsuarios (trocar cargo segue só GESTOR).
// ─────────────────────────────────────────────────────────────────────────
function requireServiceRoleKey(req, res, next) {
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) {
    return res.status(503).json({ erro: 'service_role_nao_configurada', detalhe: 'SUPABASE_SERVICE_ROLE_KEY ausente' });
  }
  next();
}

// Le um profile direto do banco (fonte de verdade de role, pode_convidar e permissoes).
// Nao confia no JWT pra isso: o role do JWT so atualiza no proximo refresh de sessao.
async function lerPerfil(id) {
  if (!id) return null;
  let r = await supabaseAdminRequest('GET',
    `/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=id,email,role,pode_convidar,permissoes,concede`);
  // Reserva: sem a coluna concede (migration 013 ainda não aplicada) lê sem ela, concede vazio.
  if (r.status === 400) {
    r = await supabaseAdminRequest('GET',
      `/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=id,email,role,pode_convidar,permissoes`);
    if (r.status === 200 && Array.isArray(r.body) && r.body[0]) r.body[0].concede = {};
  }
  return (r.status === 200 && Array.isArray(r.body) && r.body[0]) ? r.body[0] : null;
}

// Middleware: libera a gestao de usuarios pra GESTOR e pra GERENTE com pode_convidar.
// Aplicar depois de requireAuth e requireServiceRoleKey. Fail closed: sem perfil, nega.
// Deixa em req.gestor o perfil de quem chama, usado pelas travas de cada rota.
function requireGestaoUsuarios(req, res, next) {
  if (req.authMode === 'internal') { req.gestor = { role: 'GESTOR', interno: true }; return next(); }
  lerPerfil(req.user && req.user.sub).then((perfil) => {
    const pode = perfil && (perfil.role === 'GESTOR' || (perfil.role === 'GERENTE' && perfil.pode_convidar === true));
    if (!pode) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuario nao tem permissao para gerenciar usuarios.' });
    req.gestor = perfil;
    next();
  }).catch(() => res.status(500).json({ erro: 'falha_validar_permissao' }));
}

// Um GERENTE so pode conceder o que ele mesmo tem (modulo visivel e cada acao). O que o
// alvo ja tinha (liberado antes pelo GESTOR) pode ser mantido, so nao pode ser ampliado.
function permissoesDentroDoLimite(novas, minhas, atuaisDoAlvo) {
  const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k)) ? o[k] : null;
  for (const [modulo, p] of Object.entries(novas || {})) {
    const meu = own(minhas, modulo);
    const dele = own(atuaisDoAlvo, modulo);
    const tenho = !!(meu && meu.visivel === true);
    const eleTinha = !!(dele && dele.visivel === true);
    if (p.visivel && !tenho && !eleTinha) return false;
    for (const a of p.acoes) {
      const euTenho = tenho && Array.isArray(meu.acoes) && meu.acoes.includes(a);
      const eleTinhaAcao = eleTinha && Array.isArray(dele.acoes) && dele.acoes.includes(a);
      if (!euTenho && !eleTinhaAcao) return false;
    }
  }
  return true;
}

// Origens fixas onde o Hub roda. O link do convite so aponta pra uma delas (nunca pra
// uma origem qualquer vinda do header, que o cliente controla). Fora da lista, usa o
// Site URL do Supabase e a landing encaminha pro /hub.
const ORIGENS_HUB = [
  'https://servicezone.com.br',
  'https://www.servicezone.com.br',
  'https://service-hub-production.up.railway.app',
  'https://service-hub-dev.up.railway.app',
  'http://localhost:3000'
].concat(CORS_ORIGINS);
function urlRetornoAuth(req) {
  const o = String(req.headers.origin || '');
  return ORIGENS_HUB.includes(o) ? o + '/hub' : '';
}

// Id de usuario: UUID estrito, normalizado em minusculo (evita driblar a checagem de
// "e voce mesmo" com maiuscula ou formato alternativo aceito pelo GoTrue).
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function validarIdUsuario(req, res, next) {
  const id = String(req.params.id || '').toLowerCase();
  if (!RE_UUID.test(id)) return res.status(400).json({ erro: 'id_invalido' });
  req.params.id = id;
  next();
}

// Formato do blob de permissoes: objeto simples { modulo: { visivel: bool, acoes: [string] } }.
function permissoesBemFormadas(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  for (const [modulo, v] of Object.entries(p)) {
    if (!/^[a-z_]{1,40}$/.test(modulo)) return false;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (typeof v.visivel !== 'boolean') return false;
    if (!Array.isArray(v.acoes) || !v.acoes.every((a) => typeof a === 'string' && /^[a-z_]{1,40}$/.test(a))) return false;
  }
  return true;
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
      // Buffer inteiro e UTF-8 uma vez só: juntar como texto por pedaço corrompe acento
      // quando o corte cai no meio de um caractere (transcrições longas).
      const partes = [];
      resp.on('data', (c) => partes.push(c));
      resp.on('end', () => {
        const d = Buffer.concat(partes).toString('utf8');
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

// Apaga um objeto do Storage (acervo de regras: documento apagado pela tela). 404 conta como apagado.
async function supabaseStorageDelete(bucket, objectPath) {
  const r = await supabaseAdminRequest('DELETE', `/storage/v1/object/${bucket}/${objectPath}`);
  if (r.status >= 400 && r.status !== 404) throw new Error('storage_delete_status_' + r.status);
  return true;
}

// POST /api/admin/usuarios/convidar
// Body: { email, role: 'GERENTE'|'OPERACIONAL', nome? }
// Envia magic link de convite via GoTrue. O profile é criado automaticamente pelo
// trigger handle_new_user com role default OPERACIONAL — depois ajustamos via PATCH
// se role pedido for diferente.
app.post('/api/admin/usuarios/convidar',
  requireAuth, requireServiceRoleKey, requireGestaoUsuarios, express.json(),
  async (req, res) => {
    const { email, role, nome } = req.body || {};
    if (!email || !role) return res.status(400).json({ erro: 'email_e_role_obrigatorios' });
    if (!['GERENTE', 'OPERACIONAL'].includes(role)) {
      return res.status(400).json({ erro: 'role_invalido', detalhe: 'Convite só permite GERENTE ou OPERACIONAL. GESTOR é imutável.' });
    }
    if (role !== 'OPERACIONAL' && req.authMode !== 'internal' && !permRegras.ehDono(req.gestor)) {
      return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Só o administrador principal convida GERENTE.' });
    }
    // GoTrue invite — POST /auth/v1/invite envia magic link e cria user em auth.users
    // (status: invited). NÃO usar /auth/v1/admin/invite (404 em GoTrue moderno).
    // redirect_to leva o link pra tela de criar senha do Hub (se a URL estiver na lista
    // de Redirect URLs do Supabase; senão o GoTrue usa o Site URL e a landing encaminha).
    const retorno = urlRetornoAuth(req);
    const inv = await supabaseAdminRequest('POST', '/auth/v1/invite' + (retorno ? '?redirect_to=' + encodeURIComponent(retorno) : ''), {
      email,
      data: { nome: nome || email } // vai pra raw_user_meta_data
    });
    if (inv.status >= 400) return res.status(inv.status).json({ erro: 'falha_convite', detalhe: inv.body });
    // Atualiza role no profile recém-criado (trigger criou com OPERACIONAL default)
    if (role !== 'OPERACIONAL' && inv.body?.id) {
      await supabaseAdminRequest('PATCH', `/rest/v1/profiles?id=eq.${inv.body.id}`, { role });
    }
    const convidouDono = req.authMode === 'internal' || permRegras.ehDono(req.gestor);
    auditoria.evento(req, 'usuario_convidado', { alvo: inv.body?.id || null, email_alvo: String(email).slice(0, 120), role }, !convidouDono, convidouDono ? null : 'convidou_usuario');
    res.status(201).json({ ok: true, user: { id: inv.body?.id, email: inv.body?.email, role } });
  });

// GET /api/admin/usuarios — lista todos os perfis (com email/role/permissões)
// Lê direto da tabela profiles via PostgREST. RLS é bypassada pelo service_role,
// mas a rota só está acessível pra GESTOR via requireGestor.
app.get('/api/admin/usuarios',
  requireAuth, requireServiceRoleKey, requireGestaoUsuarios,
  async (req, res) => {
    let r = await supabaseAdminRequest('GET',
      '/rest/v1/profiles?select=id,email,nome,role,pode_convidar,permissoes,bloqueado,concede,criado_em,atualizado_em&order=criado_em.asc');
    // Reserva: banco ainda sem a coluna concede (migration 013) lista sem ela.
    if (r.status === 400) r = await supabaseAdminRequest('GET',
      '/rest/v1/profiles?select=id,email,nome,role,pode_convidar,permissoes,bloqueado,criado_em,atualizado_em&order=criado_em.asc');
    if (r.status !== 200 || !Array.isArray(r.body)) return res.status(r.status).json(r.body);
    // T16: ações restritas só aparecem para quem também as tem (ninguém descobre quem audita).
    const minhas = (req.gestor && req.gestor.permissoes && req.gestor.permissoes.configuracoes && req.gestor.permissoes.configuracoes.acoes) || [];
    const souDono = req.authMode === 'internal' || minhas.includes('auditoria_total');
    const ocultar = ['auditoria_total', 'ver_auditoria', 'ver_chaves'].filter((a) => !souDono && !minhas.includes(a));
    const lista = r.body.map((u0) => {
      const u = souDono ? u0 : Object.assign({}, u0, { concede: undefined });
      if (!ocultar.length || !u.permissoes || !u.permissoes.configuracoes) return u;
      const cfg = Object.assign({}, u.permissoes.configuracoes, { acoes: (u.permissoes.configuracoes.acoes || []).filter((a) => !ocultar.includes(a)) });
      return Object.assign({}, u, { permissoes: Object.assign({}, u.permissoes, { configuracoes: cfg }) });
    });
    // GERENTE so enxerga (e administra) os OPERACIONAIS.
    if (req.gestor.role === 'GERENTE') return res.status(200).json(lista.filter((u) => u.role === 'OPERACIONAL'));
    res.status(200).json(lista);
  });

// PUT /api/admin/usuarios/:id/role
// Body: { role: 'GERENTE'|'OPERACIONAL' }  (GESTOR não pode ser atribuído via API)
app.put('/api/admin/usuarios/:id/role',
  requireAuth, requireGestor, requireServiceRoleKey, validarIdUsuario, express.json(),
  async (req, res) => {
    const { role } = req.body || {};
    if (!['GERENTE', 'OPERACIONAL'].includes(role)) {
      return res.status(400).json({ erro: 'role_invalido', detalhe: 'Use GERENTE ou OPERACIONAL. GESTOR só via banco.' });
    }
    if (req.user && String(req.user.sub).toLowerCase() === req.params.id) {
      return res.status(400).json({ erro: 'auto_alteracao_proibida', detalhe: 'Você não pode mudar o próprio cargo.' });
    }
    const alvo = await lerPerfil(req.params.id);
    if (!alvo) return res.status(404).json({ erro: 'usuario_nao_encontrado' });
    if (alvo.role === 'GESTOR') return res.status(400).json({ erro: 'gestor_imutavel', detalhe: 'O cargo do GESTOR não muda pelo sistema.' });
    // T21: só o dono muda cargo.
    if (req.authMode !== 'internal' && !permRegras.ehDono(await lerPerfil(req.user && req.user.sub))) {
      auditoria.evento(req, 'cargo_negado', { alvo: req.params.id, role }, true, 'tentou_liberar_acesso_restrito');
      return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Só o administrador principal muda cargo.' });
    }
    // Rebaixar pra OPERACIONAL tira junto o direito de convidar.
    const patch = role === 'OPERACIONAL' ? { role, pode_convidar: false } : { role };
    esquecerPerfil(req.params.id);
    const r = await supabaseAdminRequest('PATCH',
      `/rest/v1/profiles?id=eq.${encodeURIComponent(req.params.id)}`,
      patch);
    esquecerPerfil(req.params.id); // de novo depois de gravar (fecha a janela de cache antigo)
    res.status(r.status).json(r.body);
  });

// PUT /api/admin/usuarios/:id/permissoes
// Body: { permissoes: {...}, pode_convidar?: bool }
// O GESTOR é recusado aqui (o trigger de banco só reage a mudança de role, não de permissões).
app.put('/api/admin/usuarios/:id/permissoes',
  requireAuth, requireServiceRoleKey, requireGestaoUsuarios, validarIdUsuario, express.json(),
  async (req, res) => {
    const { permissoes, pode_convidar } = req.body || {};
    if (!permissoesBemFormadas(permissoes)) {
      return res.status(400).json({ erro: 'permissoes_invalidas', detalhe: 'Formato de permissões inválido.' });
    }
    if (req.user && String(req.user.sub).toLowerCase() === req.params.id) {
      return res.status(400).json({ erro: 'auto_alteracao_proibida', detalhe: 'Você não pode editar as próprias permissões.' });
    }
    const alvo = await lerPerfil(req.params.id);
    if (!alvo) return res.status(404).json({ erro: 'usuario_nao_encontrado' });
    if (alvo.role === 'GESTOR') return res.status(400).json({ erro: 'gestor_imutavel', detalhe: 'As permissões do GESTOR não mudam pelo sistema.' });
    // T21: quem pode mexer em quem e o quê (servico/permissoes.js).
    const interno = req.authMode === 'internal';
    const editor = interno ? null : await lerPerfil(req.user && req.user.sub);
    const pode = permRegras.podeEditarAlvo(editor, alvo, interno);
    if (!pode.ok) {
      auditoria.evento(req, 'permissao_negada', { alvo: req.params.id, email_alvo: alvo.email, motivo: pode.motivo }, true, 'tentou_liberar_acesso_restrito');
      return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Você não pode alterar esse usuário.' });
    }
    // Quem não é dono não vê as ações restritas do alvo; elas ficam como estavam.
    const novas = JSON.parse(JSON.stringify(permissoes));
    if (!interno && !permRegras.ehDono(editor)) {
      Object.keys(alvo.permissoes || {}).forEach((m) => {
        const antes = (alvo.permissoes[m] && alvo.permissoes[m].acoes) || [];
        permRegras.RESTRITAS.filter((a) => antes.includes(a)).forEach((a) => {
          if (!novas[m]) novas[m] = { visivel: !!alvo.permissoes[m].visivel, acoes: [] };
          if (!novas[m].acoes.includes(a)) novas[m].acoes.push(a);
        });
      });
    }
    const conf = permRegras.conferirMudanca(editor, alvo.permissoes || {}, novas, interno);
    if (!conf.ok) {
      auditoria.evento(req, 'permissao_negada', { alvo: req.params.id, email_alvo: alvo.email, motivo: conf.motivo, fora: conf.fora || null }, true, 'tentou_liberar_acesso_restrito');
      const det = conf.motivo === 'fora_do_que_pode_liberar' ? 'Você não pode liberar ou tirar: ' + (conf.fora || []).join(', ') + '.' : 'Esse acesso não pode ser alterado por você.';
      return res.status(403).json({ erro: 'acima_do_limite', detalhe: det });
    }
    const patch = { permissoes: novas };
    // Só o dono decide quem pode gerenciar usuários.
    if (typeof pode_convidar === 'boolean' && alvo.role === 'GERENTE' && (interno || permRegras.ehDono(editor)) && pode_convidar !== !!alvo.pode_convidar) {
      patch.pode_convidar = pode_convidar;
      if (pode_convidar) {
        const cfg = novas.configuracoes || { visivel: false, acoes: [] };
        patch.permissoes = Object.assign({}, novas, { configuracoes: { visivel: true, acoes: Array.from(new Set(['ver'].concat(cfg.acoes || []))) } });
      }
    }
    const filtroExtra = (editor && editor.role === 'GERENTE') ? '&role=eq.OPERACIONAL' : '';
    _cachePerfilSL.delete(req.params.id);
    esquecerPerfil(req.params.id);
    const r = await supabaseAdminRequest('PATCH',
      `/rest/v1/profiles?id=eq.${encodeURIComponent(req.params.id)}${filtroExtra}`,
      patch);
    esquecerPerfil(req.params.id); // de novo depois de gravar
    if (filtroExtra && r.status === 200 && Array.isArray(r.body) && r.body.length === 0) {
      return res.status(409).json({ erro: 'cargo_mudou', detalhe: 'O cargo desse usuário mudou. Atualize a lista e tente de novo.' });
    }
    if (r.status < 300) {
      // Quem não é o dono liberou ou tirou acesso: vira alerta para o dono.
      const naoDono = !interno && !permRegras.ehDono(editor);
      const livre = conf.adicionadas.includes('atas.transcricao_livre');
      auditoria.evento(req, 'permissoes_alteradas', { alvo: req.params.id, email_alvo: alvo.email, adicionadas: conf.adicionadas, removidas: conf.removidas },
        naoDono && (conf.adicionadas.length || conf.removidas.length), naoDono ? (livre ? 'liberou_transcricao_livre' : 'acesso_liberado') : null);
    }
    res.status(r.status).json(r.body);
  });

// T21: o dono define o que cada pessoa pode liberar para os outros.
app.put('/api/admin/usuarios/:id/concede',
  requireAuth, requireServiceRoleKey, validarIdUsuario, express.json(),
  async (req, res) => {
    const interno = req.authMode === 'internal';
    const editor = interno ? null : await lerPerfil(req.user && req.user.sub);
    if (!interno && !permRegras.ehDono(editor)) return res.status(403).json({ erro: 'acesso_negado' });
    const concede = (req.body && req.body.concede) || {};
    if (!permRegras.concedeBemFormado(concede)) return res.status(400).json({ erro: 'formato_invalido' });
    const alvo = await lerPerfil(req.params.id);
    if (!alvo) return res.status(404).json({ erro: 'usuario_nao_encontrado' });
    if (permRegras.ehDono(alvo)) return res.status(400).json({ erro: 'alvo_dono' });
    const r = await supabaseAdminRequest('PATCH', `/rest/v1/profiles?id=eq.${encodeURIComponent(req.params.id)}`, { concede });
    if (r.status >= 300) return res.status(500).json({ erro: 'falha_gravacao' });
    esquecerPerfil(req.params.id);
    auditoria.evento(req, 'concede_alterado', { alvo: req.params.id, email_alvo: alvo.email, concede });
    res.json({ ok: true });
  });

// DELETE /api/admin/usuarios/:id
// Remove de auth.users — cascateia via FK pro profiles (ON DELETE CASCADE).
app.delete('/api/admin/usuarios/:id',
  requireAuth, requireServiceRoleKey, requireGestaoUsuarios, validarIdUsuario,
  async (req, res) => {
    const id = req.params.id;
    // Safety: bloqueia auto-delete de quem está fazendo a chamada
    if (String(req.user?.sub || '').toLowerCase() === id) {
      return res.status(400).json({ erro: 'auto_delete_proibido' });
    }
    // Fail closed: sem conseguir ler o perfil, nao apaga ninguem.
    const alvo = await lerPerfil(id);
    if (!alvo) return res.status(404).json({ erro: 'usuario_nao_encontrado' });
    if (alvo.role === 'GESTOR') return res.status(400).json({ erro: 'gestor_imutavel', detalhe: 'O GESTOR não pode ser removido pelo sistema.' });
    const podeExcluir = permRegras.podeEditarAlvo(req.gestor && req.gestor.interno ? null : req.gestor, alvo, req.authMode === 'internal');
    if (!podeExcluir.ok) {
      auditoria.evento(req, 'exclusao_negada', { alvo: id, email_alvo: alvo.email }, true, 'tentou_liberar_acesso_restrito');
      return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Você não pode remover esse usuário.' });
    }
    const exclusorDono = req.authMode === 'internal' || permRegras.ehDono(req.gestor);
    auditoria.evento(req, 'usuario_excluido', { alvo: id, email_alvo: alvo.email }, !exclusorDono, exclusorDono ? null : 'removeu_usuario');
    const r = await supabaseAdminRequest('DELETE', `/auth/v1/admin/users/${encodeURIComponent(id)}`);
    esquecerPerfil(id);
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
      if (!['connection', 'transfer-encoding', 'server', 'x-powered-by', 'via'].includes(k.toLowerCase())) {
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

app.post('/api/prestacao/gerar-deck', requireAuth, async (req, res) => {
  // T16: o caminho antigo não confere de qual condomínio é o relatório, então
  // fica fechado para usuários. A geração passa só pelo motor novo (v13).
  if (req.authMode !== 'internal') {
    auditoria.evento(req, 'prestacao_recusada', { id_superlogica: parseInt(req.query.cond, 10) || null }, true, 'caminho_antigo_fechado');
    return res.status(410).json({ erro: 'caminho_desativado', detalhe: 'Esta forma de gerar foi desativada. Atualize a página e gere de novo.' });
  }
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
      if (!['connection', 'transfer-encoding', 'server', 'x-powered-by', 'via'].includes(k.toLowerCase())) {
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

// Prestação v13 (mesmo motor da skill, curadoria de texto pelo Claude, job + polling).
// Rotas e explicação completa em prestacao-v13.js.
require('./prestacao-v13')(app, {
  requireAuth, ANTHROPIC_KEY, INTERNAL_API_SECRET, PRESTACAO_PDF_API_URL,
  exigirCarteira: (req, res, id) => carteiraT18.exigir(req, res, id),
  condominioDaBase: SUPABASE_SERVICE_ROLE_KEY ? condominioDaBase : null,
  auditar: (req, acao, det, susp, motivo) => auditoria.evento(req, acao, det, susp, motivo),
  superlogica: superlogicaNativa()
    ? { base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN }
    : null,
  podeUsarSuperlogica: SUPABASE_SERVICE_ROLE_KEY ? podeUsarSuperlogica : null,
  // "Ajustar estrutura" da prestação: GESTOR ou quem tem a ação prestacao_contas.ajustar_estrutura
  podeAjustarEstrutura: SUPABASE_SERVICE_ROLE_KEY ? async (userId) => {
    const p = await lerPerfil(userId);
    if (!p) return false;
    if (p.role === 'GESTOR') return true;
    const m = (p.permissoes || {}).prestacao_contas;
    return !!(m && m.visivel === true && Array.isArray(m.acoes) && m.acoes.includes('ajustar_estrutura'));
  } : null,
});

// ─────────────────────────────────────────────────────────────────────────
// Condomínios do Superlógica no Hub: cria os que faltam (nunca altera nem apaga
// os que já existem). Roda ao subir o servidor, todo dia às 6h (Brasília) e pelo
// botão "Atualizar agora" em Configurações. Detalhes em superlogica-dados.js.
// ─────────────────────────────────────────────────────────────────────────
const slDados = require('./superlogica-dados');
const _syncCond = { rodando: false, ultima: null };
async function sincronizarCondominiosSL(origem) {
  if (!superlogicaNativa() || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) return { ok: false, motivo: 'nao_configurado' };
  if (_syncCond.rodando) return { ok: false, motivo: 'em_andamento' };
  _syncCond.rodando = true;
  try {
    const cli = slDados.criarCliente({ base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN });
    const r = await slDados.sincronizarCondominios(cli, supabaseAdminRequest);
    _syncCond.ultima = { em: new Date().toISOString(), origem, criados: r.criados.length, total: r.total_superlogica };
    console.log('[condominios-sync] ' + origem + ' total=' + r.total_superlogica + ' criados=' + r.criados.length
      + (r.sem_codigo.length ? ' sem_codigo=' + r.sem_codigo.map((x) => x.id_superlogica).join(',') : ''));
    return Object.assign({ ok: true }, r);
  } catch (e) {
    console.warn('[condominios-sync] ' + origem + ' falhou: ' + (e && e.message));
    return { ok: false, motivo: 'falha' };
  } finally {
    _syncCond.rodando = false;
  }
}

app.post('/api/condominios/sincronizar-superlogica', requireAuth, async (req, res) => {
  if (req.authMode !== 'internal') {
    let ok = false;
    try { ok = await podeUsarSuperlogica(req.user && req.user.sub); } catch (e) { ok = false; }
    if (!ok) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não tem acesso aos dados do Superlógica.' });
  }
  const r = await sincronizarCondominiosSL('botao');
  if (r.ok) return res.json(r);
  if (r.motivo === 'em_andamento') return res.status(409).json({ erro: 'em_andamento', detalhe: 'A atualização já está rodando. Aguarde alguns segundos.' });
  if (r.motivo === 'nao_configurado') return res.status(503).json({ erro: 'superlogica_nao_configurado', detalhe: 'As chaves do Superlógica não estão configuradas neste ambiente.' });
  return res.status(502).json({ erro: 'falha_sincronizar', detalhe: 'O Superlógica não respondeu. Tente de novo em alguns minutos.' });
});

// T16: cadastro manual de um condomínio na base. Só GESTOR, e só se o código existir no
// Superlógica (o nome vem de lá). Antes o navegador gravava direto no banco qualquer nome.
app.post('/api/condominios/cadastrar', requireAuth, requireGestor, express.json(), async (req, res) => {
  const id = parseInt(req.body && req.body.id_superlogica, 10);
  if (!(id > 0)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Informe o código do Superlógica.' });
  if (!superlogicaNativa()) return res.status(503).json({ erro: 'superlogica_nao_configurado' });
  const ja = await condominioDaBase(id);
  if (ja) return res.status(409).json({ erro: 'ja_existe', detalhe: 'Esse condomínio já está na base: ' + ja.nome + '.' });
  let c = null;
  try {
    const cli = slDados.criarCliente({ base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN });
    const j = await cli.get('condominios/get', { id, somenteCondominiosAtivos: 0 });
    c = Array.isArray(j) ? j[0] : j;
  } catch (e) { c = null; }
  if (!c || String(c.id_condominio_cond) !== String(id)) {
    auditoria.evento(req, 'cadastro_condominio_recusado', { id_superlogica: id }, true, 'condominio_fora_da_base');
    return res.status(404).json({ erro: 'nao_existe_no_superlogica', detalhe: 'Esse código não existe no Superlógica.' });
  }
  const nome = slDados.nomeAmigavel ? slDados.nomeAmigavel(c) : (c.st_fantasia_cond || c.st_nome_cond);
  const r = await supabaseAdminRequest('POST', '/rest/v1/condominios', { id: crypto.randomUUID(), nome, sindico: null, id_superlogica: id, criado_em: new Date().toISOString() });
  if (r.status !== 201) return res.status(500).json({ erro: 'falha_gravacao', detalhe: 'Não foi possível cadastrar.' });
  _condBase.delete(String(id));
  auditoria.evento(req, 'condominio_cadastrado', { id_superlogica: id, nome });
  res.json(Array.isArray(r.body) ? r.body[0] : r.body);
});

app.get('/api/condominios/sincronizar-superlogica', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ultima: _syncCond.ultima, rodando: _syncCond.rodando });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/condominio/:idSuperlogica/cadastro — nome, CNPJ, endereço, síndico
// atual e conselho, lidos do Superlógica (só leitura, cache de 10 min por
// condomínio). Devolve só campos escolhidos; nada de chaves internas. Detalhes
// em superlogica/cadastro.js.
// ─────────────────────────────────────────────────────────────────────────
const slModulo = require('./superlogica');
app.get('/api/condominio/:idSuperlogica/cadastro', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (!superlogicaNativa()) return res.status(503).json({ erro: 'superlogica_nao_configurado', detalhe: 'As chaves do Superlógica não estão configuradas neste ambiente.' });
  if (req.authMode !== 'internal') {
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ erro: 'service_role_nao_configurada' });
    let ok = false;
    try { ok = await podeUsarSuperlogica(req.user && req.user.sub); } catch (e) { ok = false; }
    if (!ok) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não tem acesso aos dados do Superlógica.' });
  }
  try {
    const cli = slModulo.cliente({ base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN });
    const dados = await slModulo.buscarCadastro(cli, id);
    return res.json(dados);
  } catch (e) {
    if (e && e.status === 404) return res.status(404).json({ erro: 'condominio_nao_encontrado', detalhe: 'Esse código não existe no Superlógica.' });
    console.warn('[cadastro-condominio] ' + id + ' falhou: ' + (e && e.message));
    // Código inexistente também cai aqui: o Superlógica responde erro 500 nesse caso.
    return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler o cadastro desse código no Superlógica. Confira o código ou tente de novo em alguns minutos.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Aba Condomínio (T04): ficha, auditoria cadastral e busca global de unidades.
// Só leitura no Superlógica, mesma regra de acesso das rotas acima. Detalhes em
// superlogica/consulta.js. Cache curto para não repetir chamadas a cada clique.
// ─────────────────────────────────────────────────────────────────────────
const _cacheFicha = slModulo.consulta.criarCache(5 * 60 * 1000, 300);
const _cacheAuditoria = slModulo.consulta.criarCache(10 * 60 * 1000, 100, 90 * 1000);
const _cacheBusca = slModulo.consulta.criarCache(2 * 60 * 1000, 200);

async function exigirLeituraSuperlogica(req, res) {
  if (!superlogicaNativa()) { res.status(503).json({ erro: 'superlogica_nao_configurado', detalhe: 'As chaves do Superlógica não estão configuradas neste ambiente.' }); return false; }
  if (req.authMode === 'internal') return true;
  if (!SUPABASE_SERVICE_ROLE_KEY) { res.status(503).json({ erro: 'service_role_nao_configurada' }); return false; }
  let ok = false;
  try { ok = await podeUsarSuperlogica(req.user && req.user.sub); } catch (e) { ok = false; }
  if (!ok) res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não tem acesso aos dados do Superlógica.' });
  return ok;
}
function clienteSL() {
  return slModulo.cliente({ base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN });
}
// Cada parte da ficha falha sozinha: a tela mostra o que veio e avisa o que não veio.
async function parteFicha(chave, fn) {
  try { return { ok: true, dados: await _cacheFicha.pegar(chave, fn) }; } catch (e) {
    console.warn('[ficha] ' + chave + ' falhou: ' + (e && e.message));
    return { ok: false, erro: 'Não foi possível ler esta parte no Superlógica agora.' };
  }
}

// GET /api/condominio/:id/ficha?mes=AAAA-MM (mes das despesas pagas; padrão: mês atual)
app.get('/api/condominio/:idSuperlogica/ficha', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  const agora = new Date(Date.now() - 3 * 3600 * 1000); // Brasília
  let ano = agora.getUTCFullYear(), mes = agora.getUTCMonth() + 1;
  const m = String(req.query.mes || '').match(/^(\d{4})-(\d{2})$/);
  if (req.query.mes && !m) return res.status(400).json({ erro: 'mes_invalido', detalhe: 'Mês inválido.' });
  if (m) {
    ano = +m[1]; mes = +m[2];
    if (mes < 1 || mes > 12 || ano < 2000 || ano > agora.getUTCFullYear() + 1) return res.status(400).json({ erro: 'mes_invalido', detalhe: 'Mês fora do intervalo.' });
  }
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  const cli = clienteSL();
  const C = slModulo.consulta;
  const hoje = new Date(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate());
  const dia = hoje.toISOString().slice(0, 10);
  const [cadastro, contas, despesas, pendentes, inad] = await Promise.all([
    (async () => { try { return { ok: true, dados: await slModulo.buscarCadastro(cli, id) }; } catch (e) { return { ok: false, erro: 'Não foi possível ler o cadastro no Superlógica agora.' }; } })(),
    parteFicha('contas:' + id, () => C.contas(cli, id)),
    parteFicha('desp:' + id + ':' + ano + '-' + mes, () => C.despesasMes(cli, id, ano, mes)),
    parteFicha('pend:' + id + ':' + dia, () => C.contasPendentes(cli, id, hoje)),
    parteFicha('inad:' + id + ':' + dia, () => C.inadimplencia(cli, id, hoje)),
  ]);
  res.json({ id_superlogica: Number(id), gerado_em: new Date().toISOString(), cadastro, contas, despesas_mes: despesas, pendentes, inadimplencia: inad });
});

// GET /api/condominio/:id/auditoria — cadastro das unidades (CPF, email, telefone, fração ideal)
app.get('/api/condominio/:idSuperlogica/auditoria', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  try {
    const dados = await _cacheAuditoria.pegar('aud:' + id, () => slModulo.consulta.auditoria(clienteSL(), id));
    res.json(dados);
  } catch (e) {
    console.warn('[auditoria] ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as unidades no Superlógica agora. Tente de novo em alguns minutos.' });
  }
});

// GET /api/unidades/busca?q=... — em todos os condomínios (nome, CPF/CNPJ ou número da unidade)
app.get('/api/unidades/busca', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const q = String(req.query.q || '').replace(/\s+/g, ' ').trim();
  if (q.length < 3 || q.length > 60) return res.status(400).json({ erro: 'termo_invalido', detalhe: 'Digite de 3 a 60 caracteres.' });
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  try {
    const dados = await _cacheBusca.pegar('busca:' + q.toLowerCase(), () => slModulo.consulta.buscarUnidades(clienteSL(), q));
    res.json(dados);
  } catch (e) {
    console.warn('[busca-unidades] falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'O Superlógica não respondeu à busca. Tente de novo em alguns minutos.' });
  }
});


// ─────────────────────────────────────────────────────────────────────────
// Despesas e alertas (T05). Leitura no Superlógica com a mesma regra de acesso das rotas
// acima; estado dos alertas (visto, resolvido) e o limite de saldo ficam nas tabelas
// alertas e alertas_config (Supabase, só via service_role). Detalhes em superlogica/alertas.js.
// ─────────────────────────────────────────────────────────────────────────
const slAlertas = require('./superlogica/alertas');
const slAlertasOper = require('./superlogica/alertas-operacionais');
// Alertas da T05 (contas a vencer, saldo, recorrentes) mais os operacionais da T08
// (pagamento sem nota fiscal, manutenção periódica atrasada, consumo fora do padrão).
// T18: prazos das manutenções periódicas guardados no banco (config_geral), editáveis pelo
// GESTOR em Configurações. Detalhes em superlogica/prazos-manutencao.js.
const slPrazos = require('./superlogica/prazos-manutencao');
slPrazos.criarRotas(app, {
  requireAuth, requireGestor, express, banco: (m, p, b) => supabaseAdminRequest(m, p, b),
  servidorPronto: () => !!(SUPABASE_SERVICE_ROLE_KEY && SUPABASE_URL), usuarioId: (req) => _usuarioId(req),
});
async function calcularTodosAlertas(id, hoje, cfg, forcar) {
  const cli = clienteSL();
  const prazos = cfg && cfg.prazos ? cfg.prazos : (await slPrazos.ler(supabaseAdminRequest)).prazos;
  const [a, o] = await Promise.all([
    slAlertas.calcularAlertas(cli, id, hoje, cfg),
    slAlertasOper.calcularOperacionais(cli, id, hoje, { forcar: !!forcar, prazos }).catch(() => ({ alertas: [], falhas: ['alertas operacionais'] })),
  ]);
  return { alertas: a.alertas.concat(o.alertas), falhas: a.falhas.concat(o.falhas), saldo_minimo: a.saldo_minimo };
}
const _cacheAlertas = slModulo.consulta.criarCache(5 * 60 * 1000, 300, 60 * 1000);
const _verificandoCond = new Set();

// Mudar estado de alerta ou o limite de saldo: só GESTOR e GERENTE (ver alertas segue a regra
// de leitura do Superlógica).
async function exigirGestaoAlertas(req, res) {
  if (req.authMode === 'internal') return true;
  let p = null;
  try { p = await lerPerfil(req.user && req.user.sub); } catch (e) { p = null; }
  if (p && (p.role === 'GESTOR' || p.role === 'GERENTE')) return true;
  res.status(403).json({ erro: 'acesso_negado', detalhe: 'Só gestor ou gerente pode alterar alertas.' });
  return false;
}
// Lê o estado guardado SÓ das chaves calculadas agora (a tabela cresce com o tempo).
async function _lerEstadoAlertas(id, chaves) {
  const mapa = new Map();
  for (let i = 0; i < chaves.length; i += 80) {
    const lote = chaves.slice(i, i + 80).map((c) => '"' + c.replace(/["\\]/g, '') + '"').join(',');
    const r = await supabaseAdminRequest('GET', '/rest/v1/alertas?id_superlogica=eq.' + id + '&chave=in.(' + encodeURIComponent(lote) + ')&select=id,chave,status');
    if (r.status !== 200) throw new Error('alertas_' + r.status);
    (r.body || []).forEach((a) => mapa.set(a.chave, a));
  }
  return mapa;
}

function _hojeBrasilia() {
  const agora = new Date(Date.now() - 3 * 3600 * 1000);
  return new Date(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate());
}
function _usuarioId(req) {
  const u = req.user && req.user.sub;
  return /^[0-9a-f-]{36}$/i.test(String(u || '')) ? u : null;
}

// POST /api/despesas/verificar { id_superlogica, linhas: [{ linha, fornecedor_id, vencimento MM/DD/AAAA, valor, documento }] }
// Antes de enviar a planilha: duplicata no Superlógica (ou dentro da planilha) e fornecedor inexistente.
app.post('/api/despesas/verificar', requireAuth, express.json({ limit: '1mb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String((req.body && req.body.id_superlogica) || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (!(await _exigirCarteira(req, res, id))) return;
  const norm = slAlertas.normalizarLinhas(req.body && req.body.linhas);
  if (norm.erro) return res.status(400).json({ erro: 'linhas_invalidas', detalhe: norm.erro });
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  // Uma verificação por condomínio de cada vez (cada uma pode fazer dezenas de leituras).
  if (_verificandoCond.has(id)) return res.status(429).json({ erro: 'em_andamento', detalhe: 'Já existe uma conferência deste condomínio em andamento. Aguarde alguns segundos.' });
  _verificandoCond.add(id);
  try {
    const r = await slAlertas.verificarImportacao(clienteSL(), id, norm.linhas);
    res.json(r);
  } catch (e) {
    if (e && e.cortada) return res.status(422).json({ erro: 'muitas_despesas_no_dia', detalhe: 'Há despesas demais num mesmo vencimento para conferir com segurança. Nada foi enviado; lance esse dia direto no Superlógica.' });
    console.warn('[despesas-verificar] ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível conferir as despesas no Superlógica agora. Nada foi enviado. Tente de novo em alguns minutos.' });
  } finally { _verificandoCond.delete(id); }
});

async function _lerConfigAlertas(id) {
  const r = await supabaseAdminRequest('GET', '/rest/v1/alertas_config?id_superlogica=eq.' + id + '&select=saldo_minimo');
  if (r.status !== 200) throw new Error('config_' + r.status);
  return (Array.isArray(r.body) && r.body[0]) || { saldo_minimo: null };
}

// GET /api/condominio/:id/alertas[?todos=1] — calcula no Superlógica, registra os novos e devolve
// com o estado de cada um. Sem todos=1, os resolvidos ficam de fora.
app.get('/api/condominio/:idSuperlogica/alertas', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) return res.status(503).json({ erro: 'service_role_nao_configurada' });
  try {
    const cfg = Object.assign({}, await _lerConfigAlertas(id), { prazos: (await slPrazos.ler(supabaseAdminRequest)).prazos });
    const hoje = _hojeBrasilia();
    // forcar=1 (botão Atualizar) recalcula sem cache; resultado com falha de leitura não fica em cache.
    const chaveCache = 'alertas:' + id + ':' + hoje.toISOString().slice(0, 10) + ':' + cfg.saldo_minimo + ':' + slPrazos.assinatura(cfg.prazos);
    let calc;
    if (req.query.forcar === '1') calc = await calcularTodosAlertas(id, hoje, cfg, true);
    else {
      calc = await _cacheAlertas.pegar(chaveCache, async () => {
        const c = await calcularTodosAlertas(id, hoje, cfg);
        if (c.falhas.length) { const e = new Error('parcial'); e.parcial = c; throw e; }
        return c;
      }).catch((e) => { if (e && e.parcial) return e.parcial; throw e; });
    }
    const chaves = calc.alertas.map((a) => a.chave);
    const porChave = chaves.length ? await _lerEstadoAlertas(id, chaves) : new Map();
    const novos = calc.alertas.filter((a) => !porChave.has(a.chave));
    if (novos.length) {
      const linha = (a) => ({ id_superlogica: Number(id), chave: a.chave, tipo: a.tipo, titulo: a.titulo.slice(0, 300), detalhe: a.detalhe });
      const ins = await supabaseAdminRequest('POST', '/rest/v1/alertas', novos.map(linha));
      if (ins.status === 201 && Array.isArray(ins.body)) ins.body.forEach((a) => porChave.set(a.chave, a));
      else if (ins.status === 409) {
        // corrida com outra aba: um por um, ignorando o que já existe, e relê
        for (const a of novos) { await supabaseAdminRequest('POST', '/rest/v1/alertas', [linha(a)]); }
        const de2 = await _lerEstadoAlertas(id, novos.map((a) => a.chave));
        de2.forEach((v, k) => porChave.set(k, v));
      } else throw new Error('insert_' + ins.status);
    }
    const todos = req.query.todos === '1';
    const lista = calc.alertas.map((a) => {
      const g = porChave.get(a.chave) || {};
      return { id: g.id || null, chave: a.chave, tipo: a.tipo, titulo: a.titulo, detalhe: a.detalhe, status: g.status || 'novo' };
    }).filter((a) => todos || a.status !== 'resolvido');
    const ordem = { novo: 0, visto: 1, resolvido: 2 };
    lista.sort((a, b) => (ordem[a.status] - ordem[b.status]) || a.tipo.localeCompare(b.tipo));
    res.json({ id_superlogica: Number(id), gerado_em: new Date().toISOString(), saldo_minimo: calc.saldo_minimo, falhas: calc.falhas, alertas: lista });
  } catch (e) {
    console.warn('[alertas] ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_alertas', detalhe: 'Não foi possível montar os alertas agora. Tente de novo em alguns minutos.' });
  }
});

// PATCH /api/alertas/:alertaId { status: 'novo'|'visto'|'resolvido' }
app.patch('/api/alertas/:alertaId', requireAuth, express.json({ limit: '10kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const aid = String(req.params.alertaId || '');
  if (!/^[0-9a-f-]{36}$/i.test(aid)) return res.status(400).json({ erro: 'id_invalido' });
  const status = String((req.body && req.body.status) || '');
  if (!['novo', 'visto', 'resolvido'].includes(status)) return res.status(400).json({ erro: 'status_invalido', detalhe: 'Use novo, visto ou resolvido.' });
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) return res.status(503).json({ erro: 'service_role_nao_configurada' });
  if (!(await exigirGestaoAlertas(req, res))) return;
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) return res.status(503).json({ erro: 'service_role_nao_configurada' });
  // T18: o alerta é de um condomínio; quem tem carteira só mexe nos da carteira.
  const dono = await supabaseAdminRequest('GET', '/rest/v1/alertas?id=eq.' + aid + '&select=id_superlogica');
  if (dono.status !== 200 || !Array.isArray(dono.body)) return res.status(502).json({ erro: 'falha_atualizar', detalhe: 'Não foi possível atualizar o alerta.' });
  if (!dono.body.length) return res.status(404).json({ erro: 'falha_atualizar', detalhe: 'Não foi possível atualizar o alerta.' });
  if (!(await _exigirCarteira(req, res, dono.body[0].id_superlogica))) return;
  const r = await supabaseAdminRequest('PATCH', '/rest/v1/alertas?id=eq.' + aid, { status, atualizado_em: new Date().toISOString(), atualizado_por: _usuarioId(req) });
  if (r.status !== 200 || !Array.isArray(r.body) || !r.body.length) return res.status(r.status === 200 ? 404 : 502).json({ erro: 'falha_atualizar', detalhe: 'Não foi possível atualizar o alerta.' });
  res.json({ id: aid, status: r.body[0].status });
});

// PUT /api/condominio/:id/alertas/config { saldo_minimo } — null ou 0 desliga o alerta de saldo.
app.put('/api/condominio/:idSuperlogica/alertas/config', requireAuth, express.json({ limit: '10kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  const bruto = req.body ? req.body.saldo_minimo : null;
  let saldo = null;
  if (bruto !== null && bruto !== undefined && bruto !== '') {
    saldo = Number(String(bruto).replace(',', '.'));
    if (!isFinite(saldo) || saldo < 0 || saldo > 1e9) return res.status(400).json({ erro: 'valor_invalido', detalhe: 'Informe um valor entre 0 e 1 bilhão.' });
    saldo = Math.round(saldo * 100) / 100;
    if (saldo === 0) saldo = null;
  }
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) return res.status(503).json({ erro: 'service_role_nao_configurada' });
  if (!(await exigirGestaoAlertas(req, res))) return;
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) return res.status(503).json({ erro: 'service_role_nao_configurada' });
  const corpo = { saldo_minimo: saldo, atualizado_em: new Date().toISOString(), atualizado_por: _usuarioId(req) };
  let r = await supabaseAdminRequest('PATCH', '/rest/v1/alertas_config?id_superlogica=eq.' + id, corpo);
  if (r.status === 200 && Array.isArray(r.body) && !r.body.length) {
    r = await supabaseAdminRequest('POST', '/rest/v1/alertas_config', Object.assign({ id_superlogica: Number(id) }, corpo));
  }
  if (r.status !== 200 && r.status !== 201) return res.status(502).json({ erro: 'falha_salvar', detalhe: 'Não foi possível salvar o limite.' });
  res.json({ id_superlogica: Number(id), saldo_minimo: saldo });
});

// POST /api/condominio/:id/unidades/conferir — Normalizar via IA (T06): marca na prévia
// as linhas cuja unidade ou pessoa já existe no Superlógica. Só leitura. Recebe só
// unidade, bloco, nome e documento de cada linha; devolve sim/não por linha (os dados
// dos cadastros existentes não saem do servidor). Cache curto: logo após uma importação
// a conferência pode levar até 2 minutos para enxergar o que acabou de entrar.
const _cacheConferencia = slModulo.consulta.criarCache(2 * 60 * 1000, 50, 90 * 1000);
app.post('/api/condominio/:idSuperlogica/unidades/conferir', requireAuth, express.json({ limit: '2mb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  const linhas = req.body && Array.isArray(req.body.linhas) ? req.body.linhas : null;
  if (!linhas || linhas.length > 5000) return res.status(400).json({ erro: 'linhas_invalidas', detalhe: 'Envie de 0 a 5000 linhas.' });
  const txt = (v) => String(v == null ? '' : v).slice(0, 200);
  const limpas = linhas.map((l) => ({ unidade: txt(l && l.unidade), bloco: txt(l && l.bloco), nome: txt(l && l.nome), cpf: txt(l && l.cpf), cnpj: txt(l && l.cnpj) }));
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  // "Conferir de novo" pede leitura nova (ex.: logo depois de importar unidades).
  if (req.query.fresco === '1') _cacheConferencia.limpar('conf:' + id);
  try {
    const ex = await _cacheConferencia.pegar('conf:' + id, () => slModulo.conferencia.lerUnidades(clienteSL(), id));
    res.json({ total_existentes: ex.itens.length, truncado: ex.truncado, resultado: slModulo.conferencia.conferir(ex.itens, limpas) });
  } catch (e) {
    console.warn('[conferir-unidades] ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as unidades no Superlógica agora. Tente de novo em alguns minutos.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Carteiras (T09): grupos de condomínios do Superlógica (Carteira A, Carteira B...).
// O GESTOR vincula cada usuário a uma ou mais carteiras (profiles.carteiras). Quem tem
// carteira vê no seletor e nas listas só os condomínios dela; GESTOR e quem não tem
// carteira veem todos. Desde a T18 também é bloqueio no servidor (superlogica/carteira.js).
// ─────────────────────────────────────────────────────────────────────────
const _cacheCarteiras = slModulo.consulta.criarCache(10 * 60 * 1000, 2, 15 * 1000);
function gruposCarteiras() {
  return _cacheCarteiras.pegar('grupos', () => slModulo.carteiras.lerGrupos(clienteSL()));
}
// Carteiras de um ou de todos os perfis. Tolerante à coluna ainda não existir no banco
// (migration 008 só no Supabase de teste): nesse caso todo mundo fica sem carteira.
async function lerCarteirasPerfis(id) {
  const filtro = id ? '&id=eq.' + encodeURIComponent(id) : '';
  const r = await supabaseAdminRequest('GET', '/rest/v1/profiles?select=id,carteiras' + filtro);
  if (r.status !== 200 || !Array.isArray(r.body)) {
    lerCarteirasPerfis.semColuna = r.status === 400 && /carteiras/.test(JSON.stringify(r.body || ''));
    return null;
  }
  lerCarteirasPerfis.semColuna = false;
  const m = {};
  r.body.forEach((p) => { m[p.id] = Array.isArray(p.carteiras) ? p.carteiras.map(Number).filter(Boolean) : []; });
  return m;
}

// ─────────────────────────────────────────────────────────────────────────
// Painel de cobrança (T11). Leitura no Superlógica com a regra de acesso de sempre;
// a 2ª via só para GESTOR e GERENTE. Detalhes em superlogica/cobranca.js.
// O navegador nunca escolhe o recebimento livremente: unidade e cobrança são
// conferidas contra o painel lido aqui no servidor.
// ─────────────────────────────────────────────────────────────────────────
const slCobranca = require('./superlogica/cobranca');
const _cachePainelCob = slModulo.consulta.criarCache(15 * 60 * 1000, 300, 120 * 1000);
const _forcarCob = new Map(); // id -> último Atualizar (no máximo um por minuto por condomínio)
function _painelCobranca(id, forcar) {
  const hoje = _hojeBrasilia();
  const chave = 'cob:' + id + ':' + hoje.toISOString().slice(0, 10);
  if (forcar && Date.now() - (_forcarCob.get(id) || 0) > 60000) {
    _forcarCob.set(id, Date.now());
    _cachePainelCob.limpar(chave);
  }
  return _cachePainelCob.pegar(chave, () => slCobranca.painelCondominio(clienteSL(), id, hoje));
}
// Carteira no servidor (T18: bloqueio de verdade, regras em superlogica/carteira.js). Quem
// tem carteira só usa os condomínios dela; erro ao conferir a carteira recusa (não libera).
async function _dentroDaCarteira(req, id) {
  return carteiraT18.dentroDaCarteira(req, id);
}
async function _exigirCarteira(req, res, id) {
  return carteiraT18.exigir(req, res, id);
}
function _dataISOparaDate(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return (d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1) ? d : null;
}

// GET /api/financeiro/boletos/:id?competencia=AAAA-MM[&forcar=1]  (T27, só leitura)
// Conferência dos boletos do mês contra os 3 meses anteriores, antes de enviar.
const finBoletos = require('./financeiro/boletos');
const _cacheBoletos = slModulo.consulta.criarCache(5 * 60 * 1000, 50, 120000);
app.get('/api/financeiro/boletos/:idSuperlogica', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (finBoletos.NAO_CONDOMINIOS.has(id)) return res.status(400).json({ erro: 'nao_condominio', detalhe: 'Esse cadastro não é um condomínio.' });
  const competencia = String(req.query.competencia || '');
  if (!finBoletos.competenciaValida(competencia)) return res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe a competência no formato AAAA-MM.' });
  if (!(await _exigirFinanceiro(req, res, 'ver'))) return;
  if (!(await _exigirModuloItem(req, res, 'boletos'))) return;
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  if (!(await _exigirCarteira(req, res, id))) return;
  if (!(await _exigirEscopoFinanceiro(req, res, id))) return;
  const chave = id + '|' + competencia;
  if (req.query.forcar === '1') _cacheBoletos.limpar(chave);
  try {
    res.json(await _cacheBoletos.pegar(chave, () => finBoletos.conferirBoletos(clienteSL(), id, competencia)));
  } catch (e) {
    console.warn('[boletos] ' + id + ' ' + competencia + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler os boletos deste condomínio agora.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Aba Financeiro (T31). Só leitura (GET) no Superlógica, sem banco e sem gravação.
// Módulo "financeiro" (ações ver e pre_balancete) conferido aqui no servidor; carteira
// conferida como nas outras rotas. Regras em financeiro/regras (T25), dados em financeiro/painel.js.
// ─────────────────────────────────────────────────────────────────────────
const finPainel = require('./financeiro/painel');
const _painelFin = finPainel.criarPainel({ cliente: () => clienteSL() });
async function _exigirFinanceiro(req, res, acao) {
  if (req.authMode === 'internal') return true;
  if (!SUPABASE_SERVICE_ROLE_KEY) { res.status(503).json({ erro: 'service_role_nao_configurada' }); return false; }
  let perfil = null;
  try { perfil = await lerPerfil(req.user && req.user.sub); } catch (e) {
    res.status(503).json({ erro: 'permissao_indisponivel', detalhe: 'Não foi possível conferir suas permissões agora.' });
    return false;
  }
  if (finPainel.temFinanceiro(perfil, acao)) return true;
  res.status(403).json({ erro: 'modulo_sem_acesso', detalhe: acao === 'pre_balancete' ? 'Seu usuário não pode gerar o pré balancete.' : 'Seu usuário não tem acesso a esta aba.' });
  return false;
}
// T37: Boletos e Conciliação ganharam item próprio no menu. Além do módulo financeiro, a rota
// exige o módulo do item (boletos ou conciliacao, ação ver). Falha fechada: perfil ilegível recusa.
async function _exigirModuloItem(req, res, modulo) {
  if (req.authMode === 'internal') return true;
  if (!SUPABASE_SERVICE_ROLE_KEY) { res.status(503).json({ erro: 'service_role_nao_configurada' }); return false; }
  let perfil = null;
  try { perfil = await lerPerfil(req.user && req.user.sub); } catch (e) {
    res.status(503).json({ erro: 'permissao_indisponivel', detalhe: 'Não foi possível conferir suas permissões agora.' });
    return false;
  }
  if (podeModulo(perfil, modulo, 'ver')) return true;
  res.status(403).json({ erro: 'modulo_sem_acesso', detalhe: 'Seu usuário não tem acesso a esta tela.' });
  return false;
}
// Condomínios que quem chama pode ver: null = todos (GESTOR, acesso interno, sem carteira).
// Erro ao ler a carteira recusa (não libera tudo).
// Mesma regra da carteira do servidor (T18): GESTOR e todas_carteiras veem todos.
async function _escopoFinanceiro(req) {
  const esc = await carteiraT18.escopo(req);
  if (esc.todas) return null;
  return new Set((esc.ids_superlogica || []).map(String));
}
// Carteira nas rotas de um condomínio, com falha fechada (erro ao ler a carteira recusa).
// Devolve { escopo } (null = vê todos) ou null se já respondeu 403 ou 503.
async function _exigirEscopoFinanceiro(req, res, id) {
  let escopo;
  try { escopo = await _escopoFinanceiro(req); } catch (e) {
    res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' });
    return null;
  }
  if (escopo && !escopo.has(String(id))) {
    res.status(403).json({ erro: 'fora_da_carteira', detalhe: 'Esse condomínio não está na sua carteira.' });
    return null;
  }
  return { escopo };
}
function _respostaCalculando(res) {
  return res.status(202).json(Object.assign({ calculando: true, detalhe: 'Os alertas estão sendo calculados. A tela tenta de novo sozinha.' }, _painelFin.situacao()));
}

// GET /api/financeiro/resumo[?carteira=<id do grupo>][&forcar=1]
// Quadro da carteira: por condomínio, contagem de alertas por tipo e por gravidade.
app.get('/api/financeiro/resumo', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const carteira = String(req.query.carteira || '');
  if (carteira && !/^[1-9][0-9]{0,8}$/.test(carteira)) return res.status(400).json({ erro: 'carteira_invalida', detalhe: 'Carteira inválida.' });
  if (!(await _exigirFinanceiro(req, res, 'ver'))) return;
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  let escopo;
  try { escopo = await _escopoFinanceiro(req); } catch (e) {
    return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' });
  }
  let ids = escopo;
  if (carteira) {
    let grupo = null;
    try { grupo = (await gruposCarteiras()).find((g) => String(g.id) === carteira); } catch (e) {
      return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as carteiras agora.' });
    }
    if (!grupo) return res.status(404).json({ erro: 'carteira_nao_encontrada', detalhe: 'Essa carteira não existe mais.' });
    const daCarteira = new Set((grupo.condominios || []).map(String));
    ids = escopo ? new Set([...daCarteira].filter((x) => escopo.has(x))) : daCarteira;
  }
  try {
    const base = await _painelFin.obterBase(req.query.forcar === '1');
    if (!base) return _respostaCalculando(res);
    res.json(Object.assign(_painelFin.resumo(base, ids, escopo === null), { recalculando: _painelFin.situacao().calculando }));
  } catch (e) {
    console.warn('[financeiro] resumo falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível calcular os alertas agora. Tente de novo em alguns minutos.' });
  }
});

// GET /api/financeiro/condominio/:id/alertas[?forcar=1]
app.get('/api/financeiro/condominio/:idSuperlogica/alertas', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (finBoletos.NAO_CONDOMINIOS.has(id)) return res.status(400).json({ erro: 'nao_condominio', detalhe: 'Esse cadastro não é um condomínio.' });
  if (!(await _exigirFinanceiro(req, res, 'ver'))) return;
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  if (!(await _exigirCarteira(req, res, id))) return;
  const acesso = await _exigirEscopoFinanceiro(req, res, id);
  if (!acesso) return;
  try {
    const base = await _painelFin.obterBase(req.query.forcar === '1');
    if (!base) return _respostaCalculando(res);
    res.json(Object.assign(_painelFin.alertasDoCondominio(base, id, acesso.escopo !== null), { recalculando: _painelFin.situacao().calculando }));
  } catch (e) {
    console.warn('[financeiro] alertas ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível calcular os alertas agora. Tente de novo em alguns minutos.' });
  }
});

// GET /api/financeiro/condominio/:id/pre-balancete?competencia=AAAA-MM[&forcar=1]
// O que impede fechar o mês: sem comprovante, sem nota, vencida sem baixa, lançamento tardio, mexida suspeita.
app.get('/api/financeiro/condominio/:idSuperlogica/pre-balancete', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (finBoletos.NAO_CONDOMINIOS.has(id)) return res.status(400).json({ erro: 'nao_condominio', detalhe: 'Esse cadastro não é um condomínio.' });
  const competencia = String(req.query.competencia || '');
  const comp = finPainel.competencia(competencia);
  if (!comp) return res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe o mês no formato AAAA-MM.' });
  if (!(await _exigirFinanceiro(req, res, 'pre_balancete'))) return;
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  if (!(await _exigirCarteira(req, res, id))) return;
  if (!(await _exigirEscopoFinanceiro(req, res, id))) return;
  try {
    res.json(await _painelFin.preBalancete(id, competencia, req.query.forcar === '1'));
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Escolha um mês que já começou.' });
    console.warn('[financeiro] pre balancete ' + id + ' ' + competencia + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível montar o pré balancete agora.' });
  }
});

// T41 Balancete digital: lista dos 900A do mês, conferência automática do PDF (só leitura) e
// geração sem publicar para condomínio liberado (BALANCETE_GERACAO_LIBERADA). Rotas em financeiro/balancete-rotas.js.
require('./financeiro/balancete-rotas').criarRotasBalancete(app, {
  requireAuth, requireGestor, express, exigirFinanceiro: _exigirFinanceiro, exigirLeituraSuperlogica, exigirEscritaSuperlogica, idValido: slModulo.idValido,
  cred: () => ({ base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN }),
  cliente: () => clienteSL(), auditar: (req, acao, det, susp) => auditoria.evento(req, acao, det, susp),
});

// ─────────────────────────────────────────────────────────────────────────
// Conciliação (T35), item próprio do menu desde a T37 (módulos financeiro e conciliacao). Só GET no Superlógica (extrato já importado
// pela equipe: conciliacao/index por condomínio e conta, e contabancos/index), no máximo
// 2 chamadas ao mesmo tempo, cache de 10 min. Mesmas travas das rotas do Financeiro:
// módulo financeiro (ver), acesso ao Superlógica e carteira (falha fechada).
// O arquivo OFX é lido e comparado na própria tela; o servidor só entrega os itens da conta.
// ─────────────────────────────────────────────────────────────────────────
const finConciliacao = require('./financeiro/conciliacao');
const _conciliacao = finConciliacao.criarConciliacao({ cliente: () => clienteSL() });
async function _travasConciliacao(req, res, id) {
  if (!slModulo.idValido(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return false; }
  if (finConciliacao.NAO_CONDOMINIOS.has(id)) { res.status(400).json({ erro: 'nao_condominio', detalhe: 'Esse cadastro não é um condomínio.' }); return false; }
  if (!(await _exigirFinanceiro(req, res, 'ver'))) return false;
  if (!(await _exigirModuloItem(req, res, 'conciliacao'))) return false;
  if (!(await exigirLeituraSuperlogica(req, res))) return false;
  if (!(await _exigirCarteira(req, res, id))) return false;
  if (!(await _exigirEscopoFinanceiro(req, res, id))) return false;
  return true;
}
function _erroConciliacao(res, e, rotulo) {
  // Só os erros do próprio módulo (e.codigo) viram 400 ou 404; erro do Superlógica (e.status) é 502.
  if (e && e.codigo === 'competencia') return res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Escolha um mês que já começou.' });
  if (e && e.codigo === 'muitos_condominios') return res.status(400).json({ erro: 'muitos_condominios', detalhe: 'Escolha uma carteira menor.' });
  if (e && e.codigo === 'conta_nao_encontrada') return res.status(404).json({ erro: 'conta_nao_encontrada', detalhe: 'Essa conta não é deste condomínio.' });
  console.warn('[conciliacao] ' + rotulo + ' falhou: ' + (e && e.message));
  return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler o extrato no Superlógica agora. Tente de novo em alguns minutos.' });
}

// GET /api/financeiro/conciliacao/quadro?carteira=<id do grupo>[&forcar=1]
// Por condomínio e conta: último dia com extrato, dias sem extrato, dias não conciliados, mês sem bloqueio.
app.get('/api/financeiro/conciliacao/quadro', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const carteira = String(req.query.carteira || '');
  if (carteira && !/^[1-9][0-9]{0,8}$/.test(carteira)) return res.status(400).json({ erro: 'carteira_invalida', detalhe: 'Carteira inválida.' });
  if (!(await _exigirFinanceiro(req, res, 'ver'))) return;
  if (!(await _exigirModuloItem(req, res, 'conciliacao'))) return;
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  let escopo;
  try { escopo = await _escopoFinanceiro(req); } catch (e) {
    return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' });
  }
  let ids = escopo;
  if (carteira) {
    let grupo = null;
    try { grupo = (await gruposCarteiras()).find((g) => String(g.id) === carteira); } catch (e) {
      return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as carteiras agora.' });
    }
    if (!grupo) return res.status(404).json({ erro: 'carteira_nao_encontrada', detalhe: 'Essa carteira não existe mais.' });
    const daCarteira = new Set((grupo.condominios || []).map(String));
    ids = escopo ? new Set([...daCarteira].filter((x) => escopo.has(x))) : daCarteira;
  }
  if (!ids) return res.status(400).json({ erro: 'escolha_carteira', detalhe: 'Escolha uma carteira para ver o quadro de conciliação.' });
  if (ids.size > finConciliacao.MAX_CONDOMINIOS_QUADRO) return res.status(400).json({ erro: 'muitos_condominios', detalhe: 'Escolha uma carteira menor (até ' + finConciliacao.MAX_CONDOMINIOS_QUADRO + ' condomínios).' });
  try {
    const r = await _conciliacao.quadroComEspera([...ids], req.query.forcar === '1');
    if (!r) return res.status(202).json({ calculando: true, detalhe: 'Lendo os extratos das contas. A tela tenta de novo sozinha.' });
    res.json(r);
  } catch (e) { _erroConciliacao(res, e, 'quadro'); }
});

// GET /api/financeiro/conciliacao/condominio/:id?competencia=AAAA-MM[&forcar=1]
// Todas as contas do condomínio no mês: quadro, itens do banco sem lançamento, lançamentos sem saída
// no banco, valor no banco diferente do lançado, data real diferente da baixa e divergências.
app.get('/api/financeiro/conciliacao/condominio/:idSuperlogica', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  const competencia = String(req.query.competencia || '');
  if (!finConciliacao.competencia(competencia)) return res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe o mês no formato AAAA-MM.' });
  if (!(await _travasConciliacao(req, res, id))) return;
  try { res.json(await _conciliacao.condominio(id, competencia, req.query.forcar === '1')); } catch (e) { _erroConciliacao(res, e, 'condominio ' + id); }
});

// GET /api/financeiro/conciliacao/condominio/:id/conta/:conta/itens?inicio=AAAA-MM-DD&fim=AAAA-MM-DD
// Extrato importado e lançamentos de uma conta (até 62 dias), para comparar o arquivo OFX na tela.
app.get('/api/financeiro/conciliacao/condominio/:idSuperlogica/conta/:conta/itens', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  const conta = String(req.params.conta || '');
  const ini = String(req.query.inicio || ''), fim = String(req.query.fim || '');
  const C = finConciliacao.C;
  if (!/^[1-9][0-9]{0,8}$/.test(conta)) return res.status(400).json({ erro: 'conta_invalida', detalhe: 'Conta inválida.' });
  // Revisão 2, G1: data impossível (mês 13) não pode chegar ao toISOString, que lança erro.
  const dataReal = (d) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const t = Date.parse(d + 'T12:00:00Z');
    return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  };
  if (!dataReal(ini) || !dataReal(fim) || fim < ini || C.dias(ini, fim) > 62 || ini < '2020-01-01') {
    return res.status(400).json({ erro: 'periodo_invalido', detalhe: 'O período do arquivo precisa ter até 62 dias.' });
  }
  if (!(await _travasConciliacao(req, res, id))) return;
  try { res.json(await _conciliacao.itensConta(id, conta, ini, fim)); } catch (e) { _erroConciliacao(res, e, 'itens ' + id + ' ' + conta); }
});

// GET /api/financeiro/conciliacao/condominio/:id/regras[?forcar=1]
// Regras automáticas sugeridas pelo histórico dos 3 meses fechados anteriores.
app.get('/api/financeiro/conciliacao/condominio/:idSuperlogica/regras', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!(await _travasConciliacao(req, res, id))) return;
  try { res.json(await _conciliacao.regras(id, req.query.forcar === '1')); } catch (e) { _erroConciliacao(res, e, 'regras ' + id); }
});

// GET /api/cobranca/condominio/:id[?forcar=1]
app.get('/api/cobranca/condominio/:idSuperlogica', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  if (!(await _exigirCarteira(req, res, id))) return;
  try {
    res.json(await _painelCobranca(id, req.query.forcar === '1'));
  } catch (e) {
    console.warn('[cobranca] ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler a inadimplência deste condomínio agora.' });
  }
});

// POST /api/cobranca/condominio/:id/simular { id_unidade, parcelas, entrada, primeira: AAAA-MM-DD }
// Só simula (acordos/simularparcelas); nenhum acordo é criado.
app.post('/api/cobranca/condominio/:idSuperlogica/simular', requireAuth, express.json({ limit: '5kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  const b = req.body || {};
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  const parcelas = parseInt(b.parcelas, 10);
  const entrada = Number(b.entrada || 0);
  const primeira = _dataISOparaDate(b.primeira);
  const hoje = _hojeBrasilia();
  if (!(parcelas >= 1 && parcelas <= 60)) return res.status(400).json({ erro: 'parcelas_invalidas', detalhe: 'Parcelas de 1 a 60.' });
  if (!(entrada >= 0) || !isFinite(entrada)) return res.status(400).json({ erro: 'entrada_invalida', detalhe: 'Entrada inválida.' });
  if (!primeira || primeira < hoje || (primeira - hoje) > 180 * 86400000) return res.status(400).json({ erro: 'data_invalida', detalhe: 'A primeira parcela deve ser entre hoje e 180 dias.' });
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  if (!(await _exigirCarteira(req, res, id))) return;
  try {
    const painel = await _painelCobranca(id, false);
    const u = painel.unidades.find((x) => x.id_unidade === String(b.id_unidade || ''));
    if (!u) return res.status(404).json({ erro: 'unidade_sem_atraso', detalhe: 'Essa unidade não está em atraso neste condomínio.' });
    if (u.recebimentos_cortados) return res.status(422).json({ erro: 'cobrancas_demais', detalhe: 'Essa unidade tem cobranças demais para simular por aqui. Simule no Superlógica.' });
    const recs = u.recebimentos.filter((r) => !r.acordo).map((r) => r.id);
    if (!recs.length) return res.status(422).json({ erro: 'ja_em_acordo', detalhe: 'As cobranças dessa unidade já estão em acordo.' });
    const sim = await slCobranca.simularAcordo(clienteSL(), id, u.id_unidade, recs, { parcelas, entrada, primeira }, hoje);
    res.json(Object.assign({ unidade: u.unidade, responsavel: u.responsavel, cobrancas: recs.length }, sim));
  } catch (e) {
    console.warn('[cobranca-simular] ' + id + ' falhou: ' + (e && e.message));
    if (e && e.message === 'entrada_maior_que_total') return res.status(400).json({ erro: e.message, detalhe: 'A entrada precisa ser menor que o total atualizado.' });
    if (e && e.status === 422) return res.status(422).json({ erro: e.message, detalhe: 'O Superlógica não montou a simulação para essa unidade. Confira no Superlógica.' });
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível simular agora. Tente de novo em alguns minutos.' });
  }
});

// POST /api/cobranca/condominio/:id/segunda-via { id_unidade, id_recebimento, pagar_ate: AAAA-MM-DD }
// Gera o link da 2ª via no Superlógica e devolve o texto pronto para WhatsApp. GESTOR ou quem tem
// a ação cobranca.segunda_via (T18; antes era GESTOR e GERENTE pelo cargo).
app.post('/api/cobranca/condominio/:idSuperlogica/segunda-via', requireAuth, express.json({ limit: '5kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  const b = req.body || {};
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  const hoje = _hojeBrasilia();
  const pagarAte = _dataISOparaDate(b.pagar_ate);
  if (!pagarAte || pagarAte < hoje || (pagarAte - hoje) > 30 * 86400000) return res.status(400).json({ erro: 'data_invalida', detalhe: 'A data de pagamento deve ser entre hoje e 30 dias.' });
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  if (req.authMode !== 'internal') {
    let p = null;
    try { p = await lerPerfil(req.user && req.user.sub); } catch (e) { p = null; }
    if (!require('./superlogica/carteira').temModulo(p, 'cobranca', 'segunda_via')) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não pode gerar a 2ª via.' });
  }
  if (!(await _exigirCarteira(req, res, id))) return;
  try {
    const painel = await _painelCobranca(id, false);
    const u = painel.unidades.find((x) => x.id_unidade === String(b.id_unidade || ''));
    const r = u && u.recebimentos.find((x) => x.id === String(b.id_recebimento || '') && !x.acordo);
    if (!r) return res.status(404).json({ erro: 'cobranca_nao_encontrada', detalhe: 'Essa cobrança não está em aberto para a unidade.' });
    const m = r.vencimento.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return res.status(422).json({ erro: 'sem_vencimento', detalhe: 'Essa cobrança está sem data de vencimento no Superlógica.' });
    const link = await slCobranca.linkSegundaVia(clienteSL(), id, r, m[2] + '/' + m[1] + '/' + m[3], pagarAte);
    const cad = await slModulo.buscarCadastro(clienteSL(), id).catch(() => null);
    const nomeCond = cad ? (cad.nome_fantasia || cad.nome) : '';
    const primeiroNome = (u.responsavel.split(' ')[0] || '').toLowerCase().replace(/^./, (c) => c.toUpperCase());
    const ate = String(pagarAte.getDate()).padStart(2, '0') + '/' + String(pagarAte.getMonth() + 1).padStart(2, '0') + '/' + pagarAte.getFullYear();
    const texto = 'Olá' + (primeiroNome ? ', ' + primeiroNome : '') + '. Segue o link da 2ª via do boleto'
      + (nomeCond ? ' do ' + nomeCond : '') + ', unidade ' + u.unidade + ', com vencimento original em ' + r.vencimento
      + ', atualizado para pagamento até ' + ate + ': ' + link;
    console.log('[cobranca-2via] cond=' + id + ' unidade=' + u.id_unidade + ' recebimento=' + r.id + ' por=' + ((req.user && req.user.sub) || req.authMode));
    res.json({ link, texto });
  } catch (e) {
    console.warn('[cobranca-2via] ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'O Superlógica não gerou o link agora. Confira se a 2ª via está liberada para esse boleto.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Comparativo entre condomínios (T14). Só leitura; mesma regra de acesso e de carteira
// da cobrança. Últimos 12 meses fechados. Detalhes em superlogica/comparativo.js.
// ─────────────────────────────────────────────────────────────────────────
const slComparativo = require('./superlogica/comparativo');
const _cacheComparativo = slModulo.consulta.criarCache(6 * 3600 * 1000, 600, 120 * 1000);
// Fornecedores lê até 40 páginas seguidas: teto maior para não estourar em condomínio grande.
const _cacheComparativoForn = slModulo.consulta.criarCache(6 * 3600 * 1000, 300, 300 * 1000);
async function _rotaComparativo(req, res, tipo) {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  if (!(await _exigirCarteira(req, res, id))) return;
  const hoje = _hojeBrasilia();
  const chave = tipo + ':' + id + ':' + hoje.getFullYear() + '-' + (hoje.getMonth() + 1);
  try {
    const fn = tipo === 'custos' ? slComparativo.custosCondominio : slComparativo.fornecedoresCondominio;
    const cache = tipo === 'custos' ? _cacheComparativo : _cacheComparativoForn;
    res.json(await cache.pegar(chave, () => fn(clienteSL(), id, hoje, 12)));
  } catch (e) {
    console.warn('[comparativo-' + tipo + '] ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler esse condomínio no Superlógica agora.' });
  }
}
// GET /api/comparativo/condominio/:id — custos por unidade por mês (total, pessoal, água, energia, gás)
app.get('/api/comparativo/condominio/:idSuperlogica', requireAuth, (req, res) => _rotaComparativo(req, res, 'custos'));
// GET /api/comparativo/condominio/:id/fornecedores — total pago por fornecedor no período
app.get('/api/comparativo/condominio/:idSuperlogica/fornecedores', requireAuth, (req, res) => _rotaComparativo(req, res, 'fornecedores'));

// ── Financeiro (T24): cópia do Superlógica para as tabelas fin_* ─────────
// Só GESTOR. Só GET no Superlógica; grava só no Supabase de teste (trava em financeiro/banco.js).
// A carga longa (meses) roda pelo script scripts/fin-sync.js; a rota aceita até 31 dias.
const financeiro = require('./financeiro');
function _credFin() {
  return { base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN, supabaseUrl: SUPABASE_URL, supabaseChave: SUPABASE_SERVICE_ROLE_KEY };
}
const _FIN_ERROS = {
  supabase_nao_permitido: [403, 'A cópia do financeiro só está liberada no ambiente de teste.'],
  supabase_nao_configurado: [503, 'Banco não configurado neste ambiente.'],
  sincronizacao_em_andamento: [409, 'Já existe uma sincronização em andamento. Aguarde terminar.'],
};
function _finErro(res, e) {
  const m = _FIN_ERROS[e && e.message];
  if (m) return res.status(m[0]).json({ erro: e.message, detalhe: m[1], execucao: e.execucao });
  console.warn('[financeiro] falhou: ' + (e && e.message));
  return res.status(500).json({ erro: 'falha_financeiro', detalhe: 'Não foi possível concluir agora.' });
}

// POST /api/financeiro/sincronizar { inicio?, fim?, tipos?, idCondominio? } -> 202 { execucao }
app.post('/api/financeiro/sincronizar', requireAuth, requireGestor, express.json({ limit: '5kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!superlogicaNativa()) return res.status(503).json({ erro: 'superlogica_nao_configurado', detalhe: 'As chaves do Superlógica não estão configuradas neste ambiente.' });
  const U = financeiro.util;
  const b = req.body || {};
  const fim = b.fim === undefined ? U.hojeBR() : b.fim;
  const inicio = b.inicio === undefined ? U.somaDias(U.hojeBR(), -6) : b.inicio;
  if (!U.ehISO(inicio) || !U.ehISO(fim) || inicio > fim || fim > U.hojeBR()) return res.status(400).json({ erro: 'periodo_invalido', detalhe: 'Datas no formato AAAA-MM-DD, início antes do fim e fim até hoje.' });
  if (U.diasEntre(inicio, fim) > 30) return res.status(400).json({ erro: 'periodo_longo', detalhe: 'Pela tela, no máximo 31 dias por vez.' });
  let tipos = null;
  if (b.tipos !== undefined) {
    if (!Array.isArray(b.tipos) || !b.tipos.length || b.tipos.length > 10 || !b.tipos.every((t) => financeiro.TIPOS.includes(t))) return res.status(400).json({ erro: 'tipos_invalidos', permitidos: financeiro.TIPOS });
    tipos = [...new Set(b.tipos)];
  }
  let idCondominio = null;
  if (b.idCondominio !== undefined && b.idCondominio !== null && b.idCondominio !== '') {
    if (!/^[1-9][0-9]{0,8}$/.test(String(b.idCondominio))) return res.status(400).json({ erro: 'condominio_invalido' });
    idCondominio = Number(b.idCondominio);
    if (U.excluido(idCondominio)) return res.status(400).json({ erro: 'condominio_excluido', detalhe: 'Este cadastro não é condomínio e fica fora do financeiro.' });
  }
  try {
    const usuario = req.authMode === 'internal' ? null : (req.user && req.user.sub) || null;
    const { execucao, promessa } = await financeiro.sincronizar(_credFin(), { inicio, fim, tipos, idCondominio }, {
      origem: 'rota', usuario, log: (m) => { if (/^(ERRO|fim|execucao)/.test(m)) console.log('[financeiro] ' + m.slice(0, 500)); },
    });
    promessa.catch((e) => console.warn('[financeiro] execução ' + execucao + ' falhou: ' + (e && e.message)));
    res.status(202).json({ execucao, inicio, fim, tipos: tipos || financeiro.TIPOS, idCondominio });
  } catch (e) { _finErro(res, e); }
});

// GET /api/financeiro/sincronizacao — em andamento, últimas execuções e data por condomínio.
app.get('/api/financeiro/sincronizacao', requireAuth, requireGestor, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await financeiro.painel(_credFin())); } catch (e) { _finErro(res, e); }
});

// GET /api/financeiro/banco/status (T36) — só GESTOR. Diz se o conector do banco está ligado e o
// nome das variáveis que faltam; nunca devolve valor de credencial e não chama o banco.
const finBancoConector = require('./financeiro/banco/index');
app.get('/api/financeiro/banco/status', requireAuth, requireGestor, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(finBancoConector.statusConector(process.env)); } catch (e) {
    console.warn('[financeiro] status do banco falhou');
    res.status(500).json({ erro: 'falha_status_banco' });
  }
});

// Avisos do financeiro (T39): card "Seu dia", resumo da manhã às 7h e vínculos. Rotas em financeiro/avisos-rotas.js.
require('./financeiro/avisos-rotas').registrar({
  app, express, requireAuth, requireGestor, lerPerfil, carteira: carteiraT18, gruposCarteiras, clienteSL, superlogicaNativa,
  supabaseUrl: SUPABASE_URL, supabaseChave: SUPABASE_SERVICE_ROLE_KEY, supabaseAdminRequest, env: process.env,
});

// GET /api/carteiras — todos os grupos (para o GESTOR escolher na tela de usuários).
app.get('/api/carteiras', requireAuth, requireGestor, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!superlogicaNativa()) return res.status(503).json({ erro: 'superlogica_nao_configurado', detalhe: 'As chaves do Superlógica não estão configuradas neste ambiente.' });
  try {
    const g = await gruposCarteiras();
    // condominios: códigos de cada carteira (usado no painel de cobrança, T11)
    res.json(g.map((x) => ({ id: x.id, nome: x.nome, tipo: x.tipo, gerente: x.gerente, quantidade: x.quantidade, condominios: x.condominios })));
  } catch (e) {
    console.warn('[carteiras] falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as carteiras no Superlógica agora.' });
  }
});

// GET /api/carteiras/minha — o que o usuário logado deve ver no seletor e nas listas.
// { todas: true } para GESTOR, acesso interno, quem não tem carteira e quem tem a ação
// configuracoes.todas_carteiras (T18). É a mesma regra que o servidor usa para bloquear.
app.get('/api/carteiras/minha', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const esc = await carteiraT18.escopo(req);
    if (esc.todas) return res.json({ todas: true });
    res.json({ todas: false, carteiras: esc.carteiras, ids_superlogica: esc.ids_superlogica, aviso: esc.aviso || undefined });
  } catch (e) {
    console.warn('[carteiras/minha] falhou: ' + (e && e.message));
    res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível ler sua carteira agora.' });
  }
});

// GET /api/admin/usuarios/carteiras — carteiras de cada usuário (para a tela de usuários).
app.get('/api/admin/usuarios/carteiras', requireAuth, requireGestor, requireServiceRoleKey, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const m = await lerCarteirasPerfis(null);
  if (!m) return res.json({ disponivel: false, motivo: lerCarteirasPerfis.semColuna ? 'sem_coluna' : 'falha', carteiras: {} });
  res.json({ disponivel: true, carteiras: m });
});

// PUT /api/admin/usuarios/:id/carteiras  Body: { carteiras: [id_grupo, ...] } (vazio = vê todos)
app.put('/api/admin/usuarios/:id/carteiras',
  requireAuth, requireGestor, requireServiceRoleKey, validarIdUsuario, express.json({ limit: '10kb' }),
  async (req, res) => {
    const lista = req.body && req.body.carteiras;
    if (!Array.isArray(lista) || lista.length > 20 || !lista.every((x) => Number.isInteger(x) && x > 0 && x < 1e9)) {
      return res.status(400).json({ erro: 'carteiras_invalidas', detalhe: 'Envie uma lista de códigos de carteira (até 20).' });
    }
    const alvo = await lerPerfil(req.params.id);
    if (!alvo) return res.status(404).json({ erro: 'usuario_nao_encontrado' });
    if (alvo.role === 'GESTOR') return res.status(400).json({ erro: 'gestor_ve_tudo', detalhe: 'O GESTOR vê todos os condomínios; não tem carteira.' });
    // Revisão 3: carteira (lista vazia = vê todos) só o dono muda, nas mesmas regras da T21.
    if (req.authMode !== 'internal') {
      const editor = await lerPerfil(req.user && req.user.sub);
      if (!permRegras.ehDono(editor) || !permRegras.podeEditarAlvo(editor, alvo, false).ok) {
        auditoria.evento(req, 'carteira_negada', { alvo: req.params.id, email_alvo: alvo.email }, true, 'tentou_liberar_acesso_restrito');
        return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Só o administrador principal muda a carteira das pessoas.' });
      }
    }
    const unicas = Array.from(new Set(lista));
    if (unicas.length) {
      if (!superlogicaNativa()) return res.status(503).json({ erro: 'superlogica_nao_configurado' });
      let grupos;
      try {
        grupos = await gruposCarteiras();
        // Carteira criada no Superlógica depois do cache: lê de novo uma vez.
        if (!unicas.every((x) => grupos.some((g) => g.id === x))) { _cacheCarteiras.limpar('grupos'); grupos = await gruposCarteiras(); }
      } catch (e) {
        return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível conferir as carteiras no Superlógica agora.' });
      }
      const validos = new Set(grupos.map((g) => g.id));
      if (!unicas.every((x) => validos.has(x))) return res.status(400).json({ erro: 'carteira_inexistente', detalhe: 'Alguma carteira escolhida não existe no Superlógica.' });
    }
    const r = await supabaseAdminRequest('PATCH', `/rest/v1/profiles?id=eq.${encodeURIComponent(req.params.id)}`, { carteiras: unicas });
    esquecerPerfil(req.params.id);
    if (r.status === 200) auditoria.evento(req, 'carteira_alterada', { alvo: req.params.id, email_alvo: alvo.email, carteiras: unicas });
    if (r.status !== 200) {
      const semColuna = r.body && /carteiras/.test(JSON.stringify(r.body));
      return res.status(semColuna ? 503 : 502).json({ erro: semColuna ? 'carteiras_nao_instaladas' : 'falha_salvar', detalhe: semColuna ? 'O banco deste ambiente ainda não tem o campo de carteira (migration 008).' : 'Não foi possível salvar.' });
    }
    res.json({ id: req.params.id, carteiras: unicas });
  });


// ─────────────────────────────────────────────────────────────────────────
// Comunicados e multas (T10). Texto no padrão gerado pela IA (só rascunho, o usuário revisa),
// publicação e multa gravadas no Superlógica pelo servidor SÓ com confirmação explícita
// (campo confirmacao) e SÓ por GESTOR ou GERENTE. Regras de segurança em superlogica/comunicados.js.
// ─────────────────────────────────────────────────────────────────────────
const slComunicados = require('./superlogica/comunicados');
function _credSL() { return { base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN }; }
async function exigirEscritaSuperlogica(req, res) {
  if (!(await exigirLeituraSuperlogica(req, res))) return false;
  if (req.authMode === 'internal') return true;
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) { res.status(503).json({ erro: 'service_role_nao_configurada' }); return false; }
  let p = null;
  try { p = await lerPerfil(req.user && req.user.sub); } catch (e) { p = null; }
  if (p && (p.role === 'GESTOR' || p.role === 'GERENTE')) return true;
  res.status(403).json({ erro: 'acesso_negado', detalhe: 'Só gestor ou gerente pode publicar comunicados e registrar multas.' });
  return false;
}
// Mesma publicação (condomínio, título e texto) não repete em 10 minutos (duplo clique, reenvio).
const _publicadosRecentes = new Map();
function _jaPublicado(chave) {
  const agora = Date.now();
  for (const [k, t] of _publicadosRecentes) if (agora - t > 10 * 60 * 1000) _publicadosRecentes.delete(k);
  if (_publicadosRecentes.has(chave)) return true;
  _publicadosRecentes.set(chave, agora);
  return false;
}
// Texto simples (como o usuário revisou) vira HTML mínimo e escapado para o Superlógica.
function _textoParaHtml(t) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(t || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
}
const _logEscrita = (oque, req, id, ok, extra) => console.log('[escrita-superlogica] ' + oque + ' cond=' + id + ' ok=' + ok + ' por=' + (req.authMode === 'internal' ? 'internal' : (req.user && req.user.sub)) + (extra ? ' ' + extra : ''));

const PROMPT_COMUNICADO = `Você redige comunicados e notificações de condomínio da administradora Condomínio Service (Grupo Service), em português formal e cordial.

Devolva SÓ um JSON, sem texto fora dele: {"titulo": "...", "texto": "..."}.
REGRAS:
R1. O texto é prosa simples em parágrafos separados por linha em branco. Sem markdown, sem HTML, sem listas com hífen.
R2. Nunca use hífen ou travessão no texto. Use vírgula, ponto e vírgula ou frase nova.
R3. Nunca invente dado: data, valor, prazo, nome, unidade, artigo da convenção ou número que não esteja no pedido vira [a confirmar].
R4. Comece com "Prezados condôminos," (comunicado geral) ou "Prezado(a) responsável pela unidade [unidade]," (notificação a uma unidade) e termine com "Atenciosamente," e "A Administração do [nome do condomínio]".
R5. Título curto (até 80 caracteres), sem ponto final.
R6. Tipos: "comunicado" (aviso geral aos moradores); "multa_unidade" (notificação de multa a uma unidade: descreva a infração e o valor só se informados, cite que cabe recurso conforme a convenção sem inventar prazo); "multa_condominio" (aviso aos moradores de que o CONDOMÍNIO recebeu uma multa de órgão ou concessionária: explique o motivo e o valor informados e o que será feito, sem culpar ninguém sem informação).`;

// POST /api/comunicados/rascunho { tipo, assunto, detalhes, condominio, unidade }
app.post('/api/comunicados/rascunho', requireAuth, express.json({ limit: '50kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const b = req.body || {};
  const tipo = ['comunicado', 'multa_unidade', 'multa_condominio'].includes(b.tipo) ? b.tipo : null;
  const assunto = String(b.assunto || '').trim().slice(0, 300);
  const detalhes = String(b.detalhes || '').trim().slice(0, 4000);
  if (!tipo || !assunto) return res.status(400).json({ erro: 'dados_invalidos', detalhe: 'Informe o tipo e o assunto.' });
  if (!ANTHROPIC_KEY) return res.status(503).json({ erro: 'indisponivel', detalhe: 'Função indisponível no momento.' });
  if (!(await exigirEscritaSuperlogica(req, res))) return;
  const msg = 'Tipo: ' + tipo + '\nCondomínio: ' + String(b.condominio || '[a confirmar]').slice(0, 150) +
    (b.unidade ? '\nUnidade: ' + String(b.unidade).slice(0, 60) : '') + '\nAssunto: ' + assunto + '\nDetalhes informados: ' + (detalhes || '(nenhum)');
  const r = await chamarAnthropicAta(modelos.modelo('comunicado'), 2000, PROMPT_COMUNICADO, msg, false, { funcao: 'comunicados', usuario: req.user && req.user.sub, condominio: b.id_superlogica });
  if (!r.ok) return res.status(502).json({ erro: 'falha_processamento', detalhe: 'Não foi possível gerar o texto agora.' });
  let j = null;
  try { j = JSON.parse(String(r.texto).replace(/```(?:json)?\s*|\s*```/g, '').trim()); } catch (e) { j = null; }
  if (!j || !j.titulo || !j.texto) return res.status(502).json({ erro: 'falha_processamento', detalhe: 'O texto não saiu no formato esperado. Tente de novo.' });
  // regra da casa: sem hífen nem travessão no texto gerado
  const semTraco = (s) => String(s).replace(/^\s*[–—-]\s*/gm, '').replace(/\s+[–—-]\s+/g, ', ').replace(/[–—]/g, ', ').replace(/[<>]/g, '');
  res.json({ titulo: semTraco(j.titulo).slice(0, 150), texto: semTraco(j.texto).slice(0, 20000) });
});

// POST /api/comunicados/publicar { id_superlogica, titulo, texto, destinatario, canal, notificar, confirmacao:'PUBLICAR' }
app.post('/api/comunicados/publicar', requireAuth, express.json({ limit: '100kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const b = req.body || {};
  const id = String(b.id_superlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (!(await _exigirCarteira(req, res, id))) return;
  if (b.confirmacao !== 'PUBLICAR') return res.status(400).json({ erro: 'sem_confirmacao', detalhe: 'Confirme a publicação na tela.' });
  const c = slComunicados.validarComunicado(b);
  if (c.erro) return res.status(400).json({ erro: 'dados_invalidos', detalhe: c.erro });
  if (!(await exigirEscritaSuperlogica(req, res))) return;
  const chaveDup = id + '|' + crypto.createHash('sha256').update(c.titulo + '\n' + c.texto).digest('hex');
  if (_jaPublicado(chaveDup)) return res.status(409).json({ erro: 'repetido', detalhe: 'Este mesmo comunicado acabou de ser publicado neste condomínio.' });
  c.texto = _textoParaHtml(c.texto);
  const r = await slComunicados.publicarComunicado(_credSL(), id, c);
  _logEscrita('comunicado', req, id, r.ok, 'notificar=' + c.notificar);
  if (!r.ok) {
    if (/^HTTP 504|sem resposta/.test(r.msg)) return res.status(504).json({ erro: 'incerto', detalhe: 'O Superlógica não respondeu; o comunicado pode ter sido criado. Confira no Superlógica antes de tentar de novo.' });
    _publicadosRecentes.delete(chaveDup);
    return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'O Superlógica recusou: ' + r.msg });
  }
  res.json({ ok: true, id_comunicado: r.data && (r.data.id_comunicado_com || r.data.ID_COMUNICADO_COM) || null, notificacao_pendente: c.notificar });
});

// POST /api/comunicados/disparar — TRAVADO: o notificarcomunicado da API dispara os pendentes de
// TODOS os condomínios da licença. Só libera com COMUNICADOS_DISPARO_LIBERADO=1 (decisão do Matheus).
app.post('/api/comunicados/disparar', requireAuth, express.json({ limit: '10kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!(await exigirEscritaSuperlogica(req, res))) return;
  if (process.env.COMUNICADOS_DISPARO_LIBERADO !== '1') {
    return res.status(423).json({ erro: 'disparo_travado', detalhe: 'O disparo pela API envia os comunicados pendentes de TODOS os condomínios de uma vez. Está travado até a administração liberar. O comunicado publicado com "notificar" fica na fila do Superlógica e pode ser disparado por lá.' });
  }
  if ((req.body || {}).confirmacao !== 'DISPARAR') return res.status(400).json({ erro: 'sem_confirmacao', detalhe: 'Confirme o disparo na tela.' });
  const r = slComunicados.resultado(await slComunicados.enviar(_credSL(), 'POST', 'comunicados/notificarcomunicado', {}));
  _logEscrita('disparo', req, '-', r.ok);
  if (!r.ok) return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'O Superlógica recusou: ' + r.msg });
  res.json({ ok: true });
});

// GET /api/condominio/:id/multa-opcoes — unidades e contas bancárias para a tela de multa
app.get('/api/condominio/:idSuperlogica/multa-opcoes', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (!(await exigirEscritaSuperlogica(req, res))) return;
  try {
    const cli = clienteSL();
    const [unidades, contas] = await Promise.all([slComunicados.listarUnidades(cli, id), slComunicados.listarContas(cli, id)]);
    res.json({ unidades, contas });
  } catch (e) {
    console.warn('[multa-opcoes] ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as unidades agora.' });
  }
});

// POST /api/multas/registrar { id_superlogica, id_unidade, data MM/DD/AAAA, tipo, titulo, texto, notificar, email, carta, cobranca?, confirmacao:'REGISTRAR' }
app.post('/api/multas/registrar', requireAuth, express.json({ limit: '100kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const b = req.body || {};
  const id = String(b.id_superlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  if (!(await _exigirCarteira(req, res, id))) return;
  if (b.confirmacao !== 'REGISTRAR') return res.status(400).json({ erro: 'sem_confirmacao', detalhe: 'Confirme o registro na tela.' });
  const m = slComunicados.validarMulta(b);
  if (m.erro) return res.status(400).json({ erro: 'dados_invalidos', detalhe: m.erro });
  // Cobrança da multa ainda não validada de ponta a ponta (condomínio de teste sem CNPJ): travada
  // até liberar (MULTA_COBRANCA_LIBERADA=1). Recusa ANTES de gravar qualquer coisa.
  if (m.cobranca && process.env.MULTA_COBRANCA_LIBERADA !== '1') return res.status(423).json({ erro: 'cobranca_travada', detalhe: 'O lançamento da cobrança da multa ainda está travado pela administração. Registre a ocorrência sem a cobrança.' });
  if (!(await exigirEscritaSuperlogica(req, res))) return;
  m.texto = _textoParaHtml(m.texto);
  try {
    const r = await slComunicados.registrarMulta(_credSL(), clienteSL(), id, m);
    _logEscrita('multa', req, id, r.ok, 'unidade=' + m.idUni + ' carta=' + !!m.carta + ' cobranca=' + !!m.cobranca);
    if (r.incerto) return res.status(504).json({ erro: 'incerto', detalhe: r.msg, resultado: r });
    if (r.parcial) return res.status(207).json(r); // ocorrência criada, algum passo opcional falhou
    if (!r.ok) return res.status(r.etapa === 'unidade' || r.etapa === 'conta' ? 400 : 502).json({ erro: 'falha_' + (r.etapa || 'superlogica'), detalhe: r.msg, resultado: r });
    res.json(r);
  } catch (e) {
    console.warn('[multa] ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível registrar agora.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Regras do condomínio (substitui o CondGPT): acervo de convenção, regimento e atas, consulta
// com citação conferida, notificação e multa com histórico, conferência da ata (só aviso),
// mandatos e importação do acervo antigo. Rotas em servico/regras/rotas-*.js, contrato em
// tarefas/em-andamento/regras-condominio.md. Todas as dependências passam por aqui.
// ─────────────────────────────────────────────────────────────────────────
const depsRegras = {
  requireAuth, express, banco: supabaseAdminRequest, perfilDe, podeModulo, temAcao, exigirCarteira: _exigirCarteira,
  carteiraT18, exigirLeituraSuperlogica, exigirEscritaSuperlogica, superlogicaNativa, clienteSL, credSL: _credSL, auditoria,
  dentroDoLimite, chamarModelo: require('./servico/modelo').chamarModelo, modelos,
  storageUpload: supabaseStorageUpload, storageSignedUrl: supabaseStorageSignedUrl, storageDelete: supabaseStorageDelete,
  slComunicados, slModulo, buscarCadastro: (id) => slModulo.buscarCadastro(clienteSL(), id),
};
// REGRAS_ROTAS (o orquestrador liga cada frente aqui)
require('./servico/regras/rotas-consulta').criarRotasConsulta(app, depsRegras);
require('./servico/regras/rotas-importar').criarRotasImportar(app, depsRegras);

// ─────────────────────────────────────────────────────────────────────────
// POST /api/condominio/:id/documentos (T12) — arquiva no Superlógica a ata ou a
// prestação de contas gerada no Hub (documentos do condomínio, sem publicar para os
// condôminos). Body JSON: { tipo: 'ata'|'prestacao', titulo, pdf_base64, forcar? }.
// Precisa do módulo (Atas ou Prestação de Contas) com a ação "gerar", ou ser GESTOR.
// Se já existe documento com o mesmo título, responde 409 (a tela pergunta e reenvia
// com forcar=true). Só PDF, até 15 MB.
// ─────────────────────────────────────────────────────────────────────────
app.post('/api/condominio/:idSuperlogica/documentos', requireAuth, express.json({ limit: '22mb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  const b = req.body || {};
  const modulo = b.tipo === 'ata' ? 'atas' : b.tipo === 'prestacao' ? 'prestacao_contas' : null;
  if (!modulo) return res.status(400).json({ erro: 'tipo_invalido', detalhe: 'Tipo deve ser ata ou prestacao.' });
  if (!superlogicaNativa()) return res.status(503).json({ erro: 'superlogica_nao_configurado', detalhe: 'As chaves do Superlógica não estão configuradas neste ambiente.' });
  // Permissão antes de decodificar o arquivo: módulo com "gerar" (ou GESTOR) e, para quem
  // tem carteira (T09), só condomínios da carteira. Esta rota grava no Superlógica.
  if (req.authMode !== 'internal') {
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ erro: 'service_role_nao_configurada' });
    let perfil = null;
    try { perfil = await lerPerfil(req.user && req.user.sub); } catch (e) { perfil = null; }
    const p = perfil && perfil.permissoes && perfil.permissoes[modulo];
    const pode = perfil && (perfil.role === 'GESTOR' || (p && p.visivel === true && Array.isArray(p.acoes) && p.acoes.includes('gerar')));
    if (!pode) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não pode arquivar este documento no Superlógica.' });
    // Carteira (T18): mesma regra de todas as rotas (inclui a ação "ver todas as carteiras").
    if (!(await _exigirCarteira(req, res, id))) return;
  }
  const D = slModulo.documentos;
  const titulo = D.tituloSeguro(b.titulo);
  if (titulo.length < 5) return res.status(400).json({ erro: 'titulo_invalido', detalhe: 'Informe um título com pelo menos 5 letras.' });
  if (typeof b.pdf_base64 !== 'string' || !b.pdf_base64.length) return res.status(400).json({ erro: 'arquivo_ausente', detalhe: 'O PDF não veio.' });
  if (b.pdf_base64.length > Math.ceil(D.MAX_BYTES / 3) * 4 + 8) return res.status(413).json({ erro: 'arquivo_grande', detalhe: 'O PDF passa de 15 MB, limite do Superlógica.' });
  const buf = Buffer.from(b.pdf_base64, 'base64');
  if (!D.ehPdf(buf)) return res.status(400).json({ erro: 'nao_e_pdf', detalhe: 'O arquivo enviado não é um PDF.' });
  if (buf.length > D.MAX_BYTES) return res.status(413).json({ erro: 'arquivo_grande', detalhe: 'O PDF passa de 15 MB, limite do Superlógica.' });
  const cli = clienteSL();
  if (b.forcar !== true) {
    try {
      const iguais = await D.procurarMesmoTitulo(cli, id, titulo);
      if (iguais.length) return res.status(409).json({ erro: 'ja_existe', detalhe: 'Já existe documento com esse título no Superlógica.', existentes: iguais.slice(0, 3) });
    } catch (e) {
      console.warn('[documentos] conferência de título falhou: ' + (e && e.message));
      return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível conferir os documentos do condomínio no Superlógica agora.' });
    }
  }
  const r = await D.enviarDocumento({ base: SUPERLOGICA_API_BASE, appToken: SUPERLOGICA_APP_TOKEN, accessToken: SUPERLOGICA_ACCESS_TOKEN }, id, titulo, buf);
  console.log('[documentos] ' + (req.user && req.user.email ? req.user.email : req.authMode) + ' arquivou ' + b.tipo + ' no condomínio ' + id + ': ' + (r.ok ? 'ok id ' + r.id : 'falhou ' + r.status + ' formato ' + r.formato));
  if (!r.ok) return res.status(502).json({ erro: 'falha_envio', detalhe: 'O Superlógica não confirmou o recebimento do documento' + (r.msg ? ': ' + r.msg : '.') + ' Confira nos documentos do condomínio antes de tentar de novo.' });
  res.json({ ok: true, titulo, id_superlogica: Number(id), id_documento: r.id || null, publicado: r.publicado == null ? null : !['', '0'].includes(r.publicado) });
});

// ─────────────────────────────────────────────────────────────────────────
// Leitura de medidores em lote (T20). A foto passa por /api/processar/medidor (leitura, unidade
// e bloco); aqui ficam a lista de unidades com a última leitura, a conferência (casamento com a
// unidade e suspeitas) e o lançamento no Superlógica (consumo/put), uma unidade por chamada,
// com a foto guardada como arquivo de medição quando o Superlógica aceitar.
// Lançamento só nos condomínios de CONSUMO_LANCAMENTO_LIBERADO (padrão: só o 167, de teste).
// ─────────────────────────────────────────────────────────────────────────
const slConsumo = require('./superlogica/consumo-lote');
const _cacheConsumo = slModulo.consulta.criarCache(2 * 60 * 1000, 200, 90 * 1000);
const _consumoEmCurso = new Set(); // um lançamento por condomínio de cada vez
function _consumoLiberados() {
  return String(process.env.CONSUMO_LANCAMENTO_LIBERADO || '167').split(/[\s,;]+/).filter((x) => slModulo.idValido(x));
}
// Permissão, chaves do Superlógica e carteira. acao 'ler' para lançar.
async function _exigirConsumo(req, res, id, acao) {
  if (req.authMode !== 'internal') {
    const p = await perfilDe(req);
    if (!podeModulo(p, 'leitura_consumo', acao)) { res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não tem acesso a essa função.' }); return false; }
  }
  if (!(await exigirLeituraSuperlogica(req, res))) return false;
  if (acao === 'ler') return _carteiraEstrita(req, res, id);
  return _exigirCarteira(req, res, id);
}
// Para gravar: carteira conferida sem folga (erro ao ler a carteira recusa, como no arquivar).
async function _carteiraEstrita(req, res, id) {
  if (req.authMode === 'internal') return true;
  if (!SUPABASE_SERVICE_ROLE_KEY) { res.status(503).json({ erro: 'service_role_nao_configurada' }); return false; }
  try {
    const perfil = await lerPerfil(req.user && req.user.sub);
    if (!perfil) { res.status(403).json({ erro: 'acesso_negado' }); return false; }
    if (perfil.role === 'GESTOR') return true;
    const mapa = await lerCarteirasPerfis(perfil.id);
    const minhas = (mapa && mapa[perfil.id]) || [];
    if (!minhas.length) return true;
    const r = slModulo.carteiras.condominiosDasCarteiras(await gruposCarteiras(), minhas);
    if (r.ids_superlogica.includes(Number(id))) return true;
    res.status(403).json({ erro: 'fora_da_carteira', detalhe: 'Esse condomínio não está na sua carteira.' });
    return false;
  } catch (e) {
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível conferir sua carteira no Superlógica agora.' });
    return false;
  }
}
function _consumoParams(req, res, fonte) {
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
  const tipo = Number(fonte.tipo);
  if (!slConsumo.TIPOS[tipo]) { res.status(400).json({ erro: 'tipo_invalido', detalhe: 'Escolha Água ou Gás.' }); return null; }
  const ref = slConsumo.mesRef(fonte.mes);
  if (!ref) { res.status(400).json({ erro: 'mes_invalido', detalhe: 'Escolha o mês atual ou um dos dois anteriores.' }); return null; }
  return { id, tipo, ref };
}
function _unidadesConsumoCache(id, tipo, ref) {
  return _cacheConsumo.pegar(id + ':' + tipo + ':' + ref.ano + '-' + ref.mes, () => slConsumo.unidadesConsumo(clienteSL(), id, tipo, ref));
}
function _erroConsumo(res, e, onde) {
  if (e && e.semLeitura) return res.status(404).json({ erro: 'tipo_sem_leitura', detalhe: 'Este condomínio não tem esse tipo de leitura no Superlógica.' });
  console.warn('[consumo-' + onde + '] falhou: ' + (e && e.message));
  return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as leituras no Superlógica agora.' });
}

// GET /api/consumo/:id/unidades?tipo=2&mes=AAAA-MM — unidades com a última leitura e a média
app.get('/api/consumo/:idSuperlogica/unidades', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const P = _consumoParams(req, res, req.query || {});
  if (!P) return;
  if (!(await _exigirConsumo(req, res, P.id))) return;
  try {
    const unidades = await _unidadesConsumoCache(P.id, P.tipo, P.ref);
    res.json({ tipo: P.tipo, nome_tipo: slConsumo.TIPOS[P.tipo], mes: P.ref.rotulo, ultimo_dia: P.ref.ultimoDia, corrente: P.ref.corrente,
      lancamento_liberado: _consumoLiberados().includes(P.id), unidades });
  } catch (e) { _erroConsumo(res, e, 'unidades'); }
});

// POST /api/consumo/:id/conferir { tipo, mes, itens:[{ chave, unidade, bloco, id_unidade?, leitura, varios_medidores? }] }
app.post('/api/consumo/:idSuperlogica/conferir', requireAuth, express.json({ limit: '300kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const b = req.body || {};
  const P = _consumoParams(req, res, b);
  if (!P) return;
  if (!Array.isArray(b.itens) || b.itens.length > 500) return res.status(400).json({ erro: 'itens_invalidos', detalhe: 'Envie de 1 a 500 leituras.' });
  if (!(await _exigirConsumo(req, res, P.id))) return;
  try {
    const lista = await _unidadesConsumoCache(P.id, P.tipo, P.ref);
    res.json({ itens: slConsumo.conferirLote(lista, b.itens) });
  } catch (e) { _erroConsumo(res, e, 'conferir'); }
});

// POST /api/consumo/:id/lancar { tipo, mes, dia, id_unidade, leitura, foto?:{ mime, base64 },
//   substituir?, aceitar_suspeitas?:[códigos], confirmacao:'LANCAR' } — grava UMA leitura no Superlógica.
app.post('/api/consumo/:idSuperlogica/lancar', requireAuth, express.json({ limit: '22mb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const b = req.body || {};
  const P = _consumoParams(req, res, b);
  if (!P) return;
  if (b.confirmacao !== 'LANCAR') return res.status(400).json({ erro: 'sem_confirmacao', detalhe: 'Confirme o lançamento na tela.' });
  // Trava antes de tudo: só condomínios liberados (padrão: só o de teste).
  if (!_consumoLiberados().includes(P.id)) {
    auditoria.evento(req, 'consumo_recusado', { id_superlogica: P.id, motivo: 'lancamento_travado' }, true, 'condominio_nao_liberado');
    return res.status(423).json({ erro: 'lancamento_travado', detalhe: 'O lançamento de leituras ainda está travado para este condomínio pela administração. A conferência funciona normalmente.' });
  }
  if (!(await _exigirConsumo(req, res, P.id, 'ler'))) return;
  if (!superlogicaNativa()) return res.status(503).json({ erro: 'superlogica_nao_configurado' });
  const idUni = Number(b.id_unidade);
  if (!Number.isInteger(idUni) || idUni <= 0) return res.status(400).json({ erro: 'unidade_invalida', detalhe: 'Escolha a unidade.' });
  const valor = slConsumo.lerValor(b.leitura);
  if (valor == null) return res.status(400).json({ erro: 'leitura_invalida', detalhe: 'Leitura inválida: use só números, com vírgula para a parte decimal.' });
  const hoje = P.ref.corrente ? new Date(Date.now() - 3 * 3600 * 1000).getUTCDate() : P.ref.ultimoDia;
  const dia = Number(b.dia == null || b.dia === '' ? hoje : b.dia);
  if (!Number.isInteger(dia) || dia < 1 || dia > hoje) return res.status(400).json({ erro: 'dia_invalido', detalhe: 'Dia da leitura inválido para o mês escolhido.' });
  let foto = null;
  if (b.foto != null) {
    const f = b.foto;
    if (!f || typeof f.base64 !== 'string' || f.base64.length > Math.ceil(slConsumo.MAX_FOTO_BYTES / 3) * 4 + 8) return res.status(400).json({ erro: 'foto_invalida', detalhe: 'Foto inválida ou maior que 15 MB.' });
    foto = Buffer.from(f.base64, 'base64');
    if (!slConsumo.tipoImagem(foto)) return res.status(400).json({ erro: 'foto_invalida', detalhe: 'A foto precisa ser JPG, PNG ou WEBP.' });
  }
  if (!dentroDoLimite(req, 'consumo_lancar', 600)) {
    auditoria.evento(req, 'limite_processamento', { tipo: 'consumo_lancar', id_superlogica: P.id }, true, 'volume_alto');
    return res.status(429).json({ erro: 'limite', detalhe: 'Muitos lançamentos nesta hora. Tente mais tarde.' });
  }
  if (_consumoEmCurso.has(P.id)) return res.status(409).json({ erro: 'em_andamento', detalhe: 'Já há um lançamento em andamento neste condomínio. Aguarde.' });
  _consumoEmCurso.add(P.id);
  const chaveCache = P.id + ':' + P.tipo + ':' + P.ref.ano + '-' + P.ref.mes;
  try {
    // Lista lida agora (não do cache): a unidade tem de ser do condomínio e a conferência é refeita aqui.
    let lista;
    try { lista = await slConsumo.unidadesConsumo(clienteSL(), P.id, P.tipo, P.ref); } catch (e) { return _erroConsumo(res, e, 'lancar'); }
    const u = lista.find((x) => x.id_unidade === idUni);
    if (!u) {
      auditoria.evento(req, 'consumo_recusado', { id_superlogica: P.id, id_unidade: idUni, motivo: 'unidade_fora' }, true, 'unidade_de_outro_condominio');
      return res.status(400).json({ erro: 'unidade_fora', detalhe: 'Essa unidade não é deste condomínio.' });
    }
    const conf = slConsumo.conferirLote(lista, [{ id_unidade: idUni, leitura: valor }])[0];
    const cods = conf.suspeitas.map((s) => s.codigo);
    const recusar = (erro, detalhe) => {
      auditoria.evento(req, 'consumo_recusado', { id_superlogica: P.id, id_unidade: idUni, motivo: erro, suspeitas: cods }, false);
      return res.status(409).json({ erro, detalhe, suspeitas: conf.suspeitas });
    };
    if (cods.includes('mes_seguinte_lancado')) return recusar('mes_seguinte_lancado', 'O mês seguinte já tem leitura nesta unidade. Lance pelo Superlógica se for mesmo preciso.');
    if (cods.includes('ja_lancada') && b.substituir !== true) return recusar('ja_lancada', 'Já existe leitura neste mês para esta unidade. Marque substituir para trocar.');
    // Cada suspeita grave tem de ter sido vista e aceita na tela (lista de códigos).
    const aceitas = Array.isArray(b.aceitar_suspeitas) ? b.aceitar_suspeitas.map(String) : [];
    const naoAceitas = cods.filter((c) => slConsumo.SUSPEITAS_GRAVES.includes(c) && !aceitas.includes(c));
    if (naoAceitas.length) return recusar('suspeita', 'Leitura suspeita: confira e marque que conferiu antes de lançar.');
    const r = await slConsumo.lancarLeitura(_credSL(), clienteSL(), { id: P.id, tipo: P.tipo, ref: P.ref, dia, u, valor, foto });
    _cacheConsumo.limpar(chaveCache);
    if (r.lista) _cacheConsumo.pegar(chaveCache, () => r.lista).catch(() => {});
    auditoria.evento(req, 'consumo_lancado', { id_superlogica: P.id, id_unidade: idUni, tipo: P.tipo, mes: P.ref.rotulo, valor,
      anterior: u.anterior, substituiu: u.atual, suspeitas: cods, ok: r.ok, incerto: !!r.incerto, foto: r.foto }, !r.ok);
    console.log('[consumo] ' + (req.user && req.user.email ? req.user.email : req.authMode) + ' lançou ' + slConsumo.TIPOS[P.tipo] + ' ' + P.ref.rotulo + ' unidade ' + idUni + ' no condomínio ' + P.id + ': ' + (r.ok ? 'ok' : r.incerto ? 'incerto' : 'falhou') + ' foto ' + r.foto);
    if (r.ok) return res.json({ ok: true, foto: r.foto, id_arquivo: r.id_arquivo, valor, consumo: u.anterior != null ? Math.round((valor - u.anterior) * 10000) / 10000 : null });
    if (r.incerto) return res.status(504).json({ erro: 'incerto', detalhe: 'O Superlógica não confirmou a leitura. Confira no Superlógica antes de lançar de novo.', foto: r.foto });
    return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'O Superlógica recusou: ' + r.msg, foto: r.foto });
  } catch (e) {
    console.warn('[consumo-lancar] ' + P.id + ' falhou: ' + (e && e.message));
    return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível lançar agora. Confira no Superlógica antes de tentar de novo.' });
  } finally {
    _consumoEmCurso.delete(P.id);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Entrada de documentos (T33, substitui o Paybox): rotas em servico/rotas-entrada.js, leitura
// e lançamento em financeiro/entrada.js. Lançamento só nos condomínios de
// ENTRADA_LANCAMENTO_LIBERADO (T40; padrão: só o 167, de teste).
// ─────────────────────────────────────────────────────────────────────────
require('./servico/rotas-entrada').criarRotasEntrada(app, {
  requireAuth, express, banco: supabaseAdminRequest, perfilDe, podeModulo, carteiraT18, exigirLeituraSuperlogica, superlogicaNativa,
  clienteSL, credSL: _credSL, dentroDoLimite, auditoria, processar, carteiraEstrita: _carteiraEstrita,
});

// ─────────────────────────────────────────────────────────────────────────
// Fechamento do mês e conferência dos anexos (T38), dentro do item Financeiro: rotas em
// servico/rotas-fechamento.js. Só GET no Superlógica; marca de conferido só no banco de teste.
// ─────────────────────────────────────────────────────────────────────────
const _forcarBolFech = new Map();
require('./servico/rotas-fechamento').criarRotasFechamento(app, {
  requireAuth, express, exigirFinanceiro: _exigirFinanceiro, exigirModuloItem: _exigirModuloItem, exigirLeituraSuperlogica,
  exigirCarteira: _exigirCarteira, exigirEscopoFinanceiro: _exigirEscopoFinanceiro, escopoFinanceiro: _escopoFinanceiro, gruposCarteiras,
  clienteSL, credSL: _credSL, painelFin: _painelFin, conciliacao: _conciliacao,
  boletos: (id, comp, forcar) => {
    const chave = id + '|' + comp;
    // Atualizar relê os boletos no máximo uma vez por minuto para o mesmo condomínio e mês.
    if (forcar && Date.now() - (_forcarBolFech.get(chave) || 0) > 60000) { _forcarBolFech.set(chave, Date.now()); _cacheBoletos.limpar(chave); }
    if (_forcarBolFech.size > 500) _forcarBolFech.delete(_forcarBolFech.keys().next().value);
    return _cacheBoletos.pegar(chave, () => finBoletos.conferirBoletos(clienteSL(), id, comp));
  },
  dentroDoLimite, auditoria, processar, linkDe: finPainel.linkLancamento,
  supabase: { url: SUPABASE_URL, chave: SUPABASE_SERVICE_ROLE_KEY },
});

// ─────────────────────────────────────────────────────────────────────────
// Relatório mensal do síndico (T13). GET /api/condominio/:id/relatorio-mensal?mes=AAAA-MM
// (padrão: mês anterior, o último fechado). Só leitura no Superlógica; o PDF é montado no
// navegador. Detalhes em superlogica/relatorio.js.
// ─────────────────────────────────────────────────────────────────────────
const slRelatorio = require('./superlogica/relatorio');
const _cacheRelatorio = slModulo.consulta.criarCache(10 * 60 * 1000, 100, 90 * 1000);
const _relatorioEmCurso = new Set(); // um relatório por condomínio de cada vez (cada um faz dezenas de leituras)
app.get('/api/condominio/:idSuperlogica/relatorio-mensal', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.params.idSuperlogica || '');
  if (!slModulo.idValido(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
  const hoje = _hojeBrasilia();
  let ano = hoje.getFullYear(), mes = hoje.getMonth(); // mês anterior
  if (mes === 0) { ano--; mes = 12; }
  const m = String(req.query.mes || '').match(/^(\d{4})-(\d{2})$/);
  if (req.query.mes && !m) return res.status(400).json({ erro: 'mes_invalido', detalhe: 'Mês inválido.' });
  if (m) {
    ano = +m[1]; mes = +m[2];
    const alvo = new Date(ano, mes - 1, 1);
    if (mes < 1 || mes > 12 || ano < 2000 || alvo > hoje) return res.status(400).json({ erro: 'mes_invalido', detalhe: 'Escolha um mês que já começou.' });
  }
  if (!(await exigirLeituraSuperlogica(req, res))) return;
  try {
    let cfg = { saldo_minimo: null };
    try { if (SUPABASE_SERVICE_ROLE_KEY && SUPABASE_URL) cfg = await _lerConfigAlertas(id); } catch (e) { cfg = { saldo_minimo: null }; }
    const cli = clienteSL();
    const chave = 'rel:' + id + ':' + ano + '-' + mes + ':' + hoje.toISOString().slice(0, 10) + ':' + cfg.saldo_minimo;
    if (_relatorioEmCurso.has(id)) return res.status(429).json({ erro: 'em_andamento', detalhe: 'Já existe um relatório deste condomínio sendo montado. Aguarde alguns segundos.' });
    _relatorioEmCurso.add(id);
    let dados, cadastro;
    try {
      [dados, cadastro] = await Promise.all([
        // resultado com parte faltando não fica em cache (o próximo clique tenta de novo)
        _cacheRelatorio.pegar(chave, async () => {
          const d0 = await slRelatorio.montarRelatorio(cli, id, { ano, mes }, hoje, cfg);
          if (d0.falhas.length) { const e = new Error('parcial'); e.parcial = d0; throw e; }
          return d0;
        }).catch((e) => { if (e && e.parcial) return e.parcial; throw e; }),
        slModulo.buscarCadastro(cli, id).catch(() => null),
      ]);
    } finally { _relatorioEmCurso.delete(id); }
    // Alertas marcados como resolvidos não entram no relatório.
    let alertasAbertos = dados.alertas;
    if (Array.isArray(alertasAbertos) && alertasAbertos.length && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_URL) {
      try {
        const est = await _lerEstadoAlertas(id, alertasAbertos.map((a) => a.chave));
        alertasAbertos = alertasAbertos.filter((a) => !(est.get(a.chave) && est.get(a.chave).status === 'resolvido'));
      } catch (e) { /* sem estado: mostra todos */ }
    }
    res.json(Object.assign({}, dados, {
      alertas: alertasAbertos ? alertasAbertos.map((a) => ({ tipo: a.tipo, titulo: a.titulo })) : null,
      condominio: cadastro ? { nome: cadastro.nome, cnpj: cadastro.cnpj, endereco: cadastro.endereco && cadastro.endereco.completo, sindico: cadastro.sindico && cadastro.sindico.nome } : { nome: '', cnpj: '', endereco: '', sindico: '' },
      id_superlogica: Number(id), gerado_em: new Date().toISOString(),
    }));
  } catch (e) {
    console.warn('[relatorio-mensal] ' + id + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível montar o relatório agora. Tente de novo em alguns minutos.' });
  }
});

// Agenda: 1 minuto depois de subir e depois todo dia às 6h de Brasília (9h UTC).
function _agendarSyncDiario() {
  const agora = new Date();
  const alvo = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 9, 0, 0));
  if (alvo <= agora) alvo.setUTCDate(alvo.getUTCDate() + 1);
  const t = setTimeout(() => { sincronizarCondominiosSL('diaria').finally(_agendarSyncDiario); }, alvo - agora);
  if (typeof t.unref === 'function') t.unref();
}
if (superlogicaNativa() && SUPABASE_SERVICE_ROLE_KEY && process.env.SYNC_CONDOMINIOS !== 'off') {
  const t0 = setTimeout(() => sincronizarCondominiosSL('inicio'), 60 * 1000);
  if (typeof t0.unref === 'function') t0.unref();
  _agendarSyncDiario();
}

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
function enviarPagina(res, nome) {
  semCacheHtml(res);
  const pronta = ofuscar.pagina(nome);
  if (pronta) { res.type('html'); return res.end(pronta); }
  if (ofuscar.aguardando('/' + nome)) { res.set('Retry-After', '5'); return res.status(503).type('html').end('<p>Sistema iniciando. Recarregue em alguns segundos.</p>'); }
  res.sendFile(path.join(__dirname, 'public', nome));
}
app.get('/', (req, res) => enviarPagina(res, 'landing.html'));

// Rota do sistema principal, acessada a partir do botão Entrar na landing
app.get('/hub', (req, res) => enviarPagina(res, 'index.html'));

// Qualquer rota desconhecida cai na landing, não no sistema
app.get('*', (req, res) => enviarPagina(res, 'landing.html'));

// Só sobe o listener quando executado direto (node server.js). Quando o arquivo é
// requerido por um teste (require), NÃO abre porta — deixa as funções determinísticas
// testáveis isoladas. Em produção o Railway roda `node server.js` direto, então
// require.main === module é verdadeiro e o servidor sobe normal.
if (require.main === module) {
  ofuscar.preparar(path.join(__dirname, 'public')).catch((e) => console.warn('[ofuscar] falhou: ' + e.message))
    .finally(() => app.listen(PORT, () => console.log('Service Hub porta ' + PORT)));
}

// Export só para teste determinístico da correção cirúrgica e do passe de consolidação de
// nome próprio (inerte em produção — nenhuma das funções abaixo está no wiring de entregarAta).
module.exports = {
  corrigirPlaceholdersDeliberacao, valoresCanonicos, mencoesMonetarias,
  extrairNomesCandidatos, reunirEvidencia, decidirPorCodigo, aplicarConsolidacao, existeLiteral,
  gateDeSaida, validarMarcadoresConferir,
  chamarAnthropicAta, // T42: teste de que o registro de custo não derruba a chamada
  inserirLacunasNaAta, validarAta, // T42: teste do modelo da inserção de último recurso
};
