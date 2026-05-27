const express = require('express');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
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
    // GoTrue invite — envia magic link e cria user em auth.users (status: invited)
    const inv = await supabaseAdminRequest('POST', '/auth/v1/admin/invite', {
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
