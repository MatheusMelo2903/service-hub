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
// Auth middleware — aceita Bearer JWT Supabase OU Bearer INTERNAL_API_SECRET
// JWT validation usa HMAC SHA256 nativo (sem dep externa).
// Sem SUPABASE_JWT_SECRET: só aceita INTERNAL_API_SECRET.
// Sem INTERNAL_API_SECRET nem SUPABASE_JWT_SECRET: rejeita tudo (fail-safe).
// ─────────────────────────────────────────────────────────────────────────
function base64UrlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function verifySupabaseJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header64, payload64, sig64] = parts;
  const signingInput = `${header64}.${payload64}`;
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
  const actual = base64UrlDecode(sig64);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(payload64).toString('utf8'));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function requireAuth(req, res, next) {
  if (!INTERNAL_API_SECRET && !SUPABASE_JWT_SECRET) {
    res.status(503).json({ erro: 'auth_nao_configurada', detalhe: 'INTERNAL_API_SECRET ou SUPABASE_JWT_SECRET ausente no servidor' });
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
  // 2. Tentar como Supabase JWT
  if (SUPABASE_JWT_SECRET) {
    const payload = verifySupabaseJwt(token, SUPABASE_JWT_SECRET);
    if (payload) { req.user = payload; req.authMode = 'supabase'; return next(); }
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
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
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
