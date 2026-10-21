// Prazos das manutenções periódicas (T18, completa a T08). Ficam no banco, na tabela
// config_geral (chave 'prazos_manutencao'), só o servidor lê e grava (service_role).
// Padrão = os prazos que o Matheus confirmou em 21/10/2026: dedetização 180 dias, recarga de
// extintores 365, limpeza de caixa d'água 180, manutenção de elevador 45. Sem a linha no banco
// (ou banco fora do ar) o cálculo usa o padrão. Só o GESTOR edita (tela em Configurações).

const CHAVE = 'prazos_manutencao';
const PADRAO = { dedetizacao: 180, extintores: 365, caixa_dagua: 180, elevador: 45 };
const NOMES = { dedetizacao: 'Dedetização', extintores: 'Recarga de extintores', caixa_dagua: "Limpeza de caixa d'água", elevador: 'Manutenção de elevador' };
const MIN_DIAS = 7, MAX_DIAS = 1825;
const TTL_MS = 60 * 1000;

let _cache = null; // { ate, v }

function normalizar(bruto) {
  const v = Object.assign({}, PADRAO);
  if (bruto && typeof bruto === 'object') {
    Object.keys(PADRAO).forEach((k) => {
      const n = Number(bruto[k]);
      if (Number.isInteger(n) && n >= MIN_DIAS && n <= MAX_DIAS) v[k] = n;
    });
  }
  return v;
}

// Valida o que veio da tela: todos os tipos, inteiro de 7 a 1825 dias.
function validar(corpo) {
  const p = corpo && corpo.prazos;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { erro: 'Envie os prazos.' };
  const out = {};
  for (const k of Object.keys(PADRAO)) {
    const n = Number(p[k]);
    if (!Number.isInteger(n) || n < MIN_DIAS || n > MAX_DIAS) return { erro: NOMES[k] + ': informe um número inteiro de dias entre ' + MIN_DIAS + ' e ' + MAX_DIAS + '.' };
    out[k] = n;
  }
  if (Object.keys(p).some((k) => !(k in PADRAO))) return { erro: 'Tipo de manutenção desconhecido.' };
  return { prazos: out };
}

async function ler(banco) {
  if (_cache && _cache.ate > Date.now()) return _cache.v;
  let v = Object.assign({}, PADRAO);
  let origem = 'padrao';
  try {
    const r = await banco('GET', '/rest/v1/config_geral?chave=eq.' + CHAVE + '&select=valor,atualizado_em');
    if (r.status === 200 && Array.isArray(r.body) && r.body[0]) { v = normalizar(r.body[0].valor); origem = 'banco'; }
  } catch (e) { /* fica o padrão */ }
  const res = { prazos: v, origem };
  // Só guarda no cache o que veio do banco (padrão por falha tenta de novo na próxima).
  if (origem === 'banco') _cache = { ate: Date.now() + TTL_MS, v: res };
  return res;
}

async function salvar(banco, prazos, usuarioId) {
  const corpo = { chave: CHAVE, valor: prazos, atualizado_em: new Date().toISOString(), atualizado_por: usuarioId || null };
  let r = await banco('PATCH', '/rest/v1/config_geral?chave=eq.' + CHAVE, { valor: corpo.valor, atualizado_em: corpo.atualizado_em, atualizado_por: corpo.atualizado_por });
  if (r.status === 200 && Array.isArray(r.body) && !r.body.length) r = await banco('POST', '/rest/v1/config_geral', corpo);
  if (r.status !== 200 && r.status !== 201) {
    const e = new Error('falha_salvar_' + r.status);
    e.semTabela = r.status === 404 || /config_geral/.test(JSON.stringify(r.body || ''));
    throw e;
  }
  _cache = null;
  return normalizar(prazos);
}

// Assinatura curta para chave de cache dos alertas (mudou o prazo, recalcula).
function assinatura(prazos) {
  return Object.keys(PADRAO).map((k) => prazos[k]).join('-');
}

// Rotas: GET (quem pode ver alertas lê os prazos) e PUT (só GESTOR).
function criarRotas(app, { requireAuth, requireGestor, express, banco, servidorPronto, usuarioId }) {
  app.get('/api/alertas/prazos-manutencao', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!servidorPronto()) return res.status(503).json({ erro: 'service_role_nao_configurada' });
    const r = await ler(banco);
    res.json({ prazos: r.prazos, padrao: PADRAO, nomes: NOMES, origem: r.origem, minimo: MIN_DIAS, maximo: MAX_DIAS });
  });
  app.put('/api/alertas/prazos-manutencao', requireAuth, requireGestor, express.json({ limit: '5kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!servidorPronto()) return res.status(503).json({ erro: 'service_role_nao_configurada' });
    const v = validar(req.body);
    if (v.erro) return res.status(400).json({ erro: 'prazos_invalidos', detalhe: v.erro });
    try {
      const prazos = await salvar(banco, v.prazos, usuarioId(req));
      console.log('[prazos-manutencao] salvos por ' + (usuarioId(req) || req.authMode) + ': ' + assinatura(prazos));
      res.json({ prazos });
    } catch (e) {
      res.status(e.semTabela ? 503 : 502).json({ erro: 'falha_salvar', detalhe: e.semTabela ? 'O banco deste ambiente ainda não tem a tabela de configuração (migration 010).' : 'Não foi possível salvar os prazos.' });
    }
  });
}

module.exports = { PADRAO, NOMES, ler, salvar, validar, normalizar, assinatura, criarRotas, MIN_DIAS, MAX_DIAS };
