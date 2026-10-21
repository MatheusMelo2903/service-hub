'use strict';
// Cliente da API do Sicoob (T36), preparado e DESLIGADO até existirem as três variáveis:
//   SICOOB_CLIENT_ID, SICOOB_CERT_PFX_BASE64, SICOOB_CERT_SENHA
// Regras: credencial só por variável de ambiente; nunca vai para log, erro, resposta ou arquivo;
// só GET na API (o único POST é o do token); só os hosts oficiais abaixo.
// Caminhos e escopos vêm da documentação pública (testes/T36/documentacao.md); os marcados
// [a confirmar] ficam todos nesta tabela para trocar num lugar só quando o portal for aberto com login.

const https = require('https');
const tls = require('tls');
const { soDigitos } = require('./comum');

const HOST_AUTH = 'auth.sicoob.com.br';
const HOST_API = 'api.sicoob.com.br';
const HOSTS_PERMITIDOS = [HOST_AUTH, HOST_API];
const CAMINHO_TOKEN = '/auth/realms/cooperado/protocol/openid-connect/token';
const VARIAVEIS = ['SICOOB_CLIENT_ID', 'SICOOB_CERT_PFX_BASE64', 'SICOOB_CERT_SENHA'];

const ROTAS = {
  // [a confirmar] nomes exatos dos parâmetros no portal
  extrato: { escopos: ['openid', 'cco_extrato'], caminho: (p) => `/conta-corrente/v4/extrato/${p.mes}/${p.ano}`, query: (p) => ({ diaInicial: p.diaInicial, diaFinal: p.diaFinal, agruparCNAB: 'false', numeroContaCorrente: p.conta }) },
  saldo: { escopos: ['openid', 'cco_saldo'], caminho: () => '/conta-corrente/v4/saldo', query: (p) => ({ numeroContaCorrente: p.conta }) },
  poupancaExtrato: { escopos: ['openid', 'poupanca_extrato'], caminho: (p) => `/poupanca/v3/extrato/${p.mes}/${p.ano}`, query: (p) => ({ numeroContaPoupanca: p.conta }) },
  poupancaSaldo: { escopos: ['openid', 'poupanca_saldo'], caminho: () => '/poupanca/v3/saldo', query: (p) => ({ numeroContaPoupanca: p.conta }) },
  dda: { escopos: ['openid', 'pagamentos_consulta'], caminho: () => '/pagamentos/v3/boletos', query: (p) => ({ dataInicial: p.dataInicial, dataFinal: p.dataFinal }) },
};

class ErroBanco extends Error {
  constructor(codigo, status) { super(codigo); this.codigo = codigo; if (status) this.status = status; }
}

// Lê as variáveis sem nunca devolver o conteúdo delas.
function lerConfig(env) {
  const e = env || process.env;
  const faltando = VARIAVEIS.filter((n) => !String(e[n] || '').trim());
  if (faltando.length) return { ligado: false, faltando };
  let pfx;
  try { pfx = Buffer.from(String(e.SICOOB_CERT_PFX_BASE64).replace(/\s+/g, ''), 'base64'); } catch (_) { pfx = null; }
  if (!pfx || pfx.length < 100) return { ligado: false, faltando: [], problema: 'certificado_ilegivel' };
  const cfg = { ligado: true, faltando: [] };
  // Segredos ficam fora da enumeração para não sair num JSON.stringify ou console.log por engano.
  Object.defineProperty(cfg, 'segredo', { enumerable: false, value: Object.freeze({ clientId: String(e.SICOOB_CLIENT_ID).trim(), pfx, senha: String(e.SICOOB_CERT_SENHA) }) });
  return cfg;
}

// Confere, sem rede, se o certificado abre com a senha. Nunca devolve detalhe do erro.
function certificadoAbre(cfg) {
  if (!cfg || !cfg.ligado) return false;
  try { tls.createSecureContext({ pfx: cfg.segredo.pfx, passphrase: cfg.segredo.senha }); return true; } catch (_) { return false; }
}

function status(env) {
  const cfg = lerConfig(env);
  const r = { ligado: cfg.ligado, variaveis_faltando: cfg.faltando };
  if (cfg.problema) r.problema = cfg.problema;
  if (cfg.ligado) {
    r.certificado_abre = certificadoAbre(cfg);
    if (!r.certificado_abre) { r.ligado = false; r.problema = 'certificado_ou_senha_invalidos'; }
  }
  r.mensagem = r.ligado ? 'Conector do banco configurado.' : 'Conector do banco desligado: falta a liberação do banco (ver o que o banco precisa liberar).';
  return r;
}

// Transporte padrão: HTTPS com o certificado do cliente (mTLS). Responde { status, corpo }.
function transporteHttps({ host, metodo, caminho, cabecalhos, corpo, pfx, senha, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: host, port: 443, path: caminho, method: metodo, headers: cabecalhos, pfx, passphrase: senha, timeout: timeoutMs || 20000, minVersion: 'TLSv1.2' }, (res) => {
      const partes = []; let tam = 0;
      res.on('data', (c) => { tam += c.length; if (tam > 20 * 1024 * 1024) { r.destroy(); return; } partes.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(partes).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new ErroBanco('banco_tempo_esgotado')));
    r.on('error', (e) => reject(e instanceof ErroBanco ? e : new ErroBanco('banco_sem_conexao')));
    if (corpo) r.write(corpo);
    r.end();
  });
}

function montarQuery(q) {
  const p = new URLSearchParams();
  Object.entries(q || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); });
  const s = p.toString();
  return s ? '?' + s : '';
}

function validarConta(conta) {
  // Só dígitos e com o dígito verificador (com hífen o banco devolve 404; sem o DV, 400).
  const d = soDigitos(conta);
  if (d.length < 2 || d.length > 20) throw new ErroBanco('conta_invalida');
  return d;
}

function inteiro(v, min, max, codigo) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErroBanco(codigo);
  return n;
}

// criarClienteSicoob({ env, transporte, agora, log })
//   transporte: injetável nos testes; log recebe só mensagens sem dado sensível.
function criarClienteSicoob(opcoes) {
  const o = opcoes || {};
  const cfg = lerConfig(o.env);
  const transporte = o.transporte || transporteHttps;
  const agora = o.agora || (() => Date.now());
  const log = typeof o.log === 'function' ? o.log : () => {};
  const tokens = new Map(); // escopos -> { valor, expira }

  function exigirLigado() { if (!cfg.ligado) throw new ErroBanco('banco_desligado'); }

  async function chamar(host, metodo, caminho, cabecalhos, corpo) {
    if (!HOSTS_PERMITIDOS.includes(host)) throw new ErroBanco('host_nao_permitido');
    if (metodo !== 'GET' && !(metodo === 'POST' && host === HOST_AUTH && caminho === CAMINHO_TOKEN)) throw new ErroBanco('metodo_nao_permitido');
    const s = cfg.segredo;
    return transporte({ host, metodo, caminho, cabecalhos, corpo, pfx: s.pfx, senha: s.senha });
  }

  async function token(escopos) {
    exigirLigado();
    const chave = escopos.slice().sort().join(' ');
    const t = tokens.get(chave);
    if (t && t.expira > agora() + 30000) return t.valor;
    const corpo = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.segredo.clientId, scope: chave }).toString();
    let r;
    try {
      r = await chamar(HOST_AUTH, 'POST', CAMINHO_TOKEN, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(corpo), Accept: 'application/json' }, corpo);
    } catch (e) { throw e instanceof ErroBanco ? e : new ErroBanco('banco_sem_conexao'); }
    if (r.status !== 200) { log('token recusado pelo banco (status ' + r.status + ')'); throw new ErroBanco('token_recusado', r.status); }
    let j; try { j = JSON.parse(r.corpo); } catch (_) { throw new ErroBanco('token_resposta_invalida'); }
    if (!j || typeof j.access_token !== 'string' || !j.access_token) throw new ErroBanco('token_resposta_invalida');
    const segundos = Number(j.expires_in) > 0 ? Number(j.expires_in) : 300;
    tokens.set(chave, { valor: j.access_token, expira: agora() + segundos * 1000 });
    return j.access_token;
  }

  async function consultar(nomeRota, params) {
    exigirLigado();
    const rota = ROTAS[nomeRota];
    const tok = await token(rota.escopos);
    const caminho = rota.caminho(params) + montarQuery(rota.query(params));
    let r;
    try {
      r = await chamar(HOST_API, 'GET', caminho, { Authorization: 'Bearer ' + tok, client_id: cfg.segredo.clientId, Accept: 'application/json' });
    } catch (e) { throw e instanceof ErroBanco ? e : new ErroBanco('banco_sem_conexao'); }
    if (r.status === 401 || r.status === 403) { tokens.clear(); throw new ErroBanco('banco_acesso_negado', r.status); }
    if (r.status === 404) throw new ErroBanco('banco_nao_encontrado', 404);
    if (r.status === 429) throw new ErroBanco('banco_limite', 429);
    if (r.status < 200 || r.status >= 300) { log(nomeRota + ': banco respondeu ' + r.status); throw new ErroBanco('banco_erro', r.status); }
    if (r.status === 204 || !r.corpo) return null;
    try { return JSON.parse(r.corpo); } catch (_) { throw new ErroBanco('banco_resposta_invalida'); }
  }

  function periodoMes(p) {
    const mes = inteiro(p.mes, 1, 12, 'mes_invalido');
    const ano = inteiro(p.ano, 2020, 2100, 'ano_invalido');
    const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    const diaInicial = inteiro(p.diaInicial === undefined ? 1 : p.diaInicial, 1, ultimo, 'dia_invalido');
    const diaFinal = inteiro(p.diaFinal === undefined ? ultimo : p.diaFinal, diaInicial, ultimo, 'dia_invalido');
    return { mes, ano, diaInicial, diaFinal };
  }

  return {
    get ligado() { return cfg.ligado; },
    status: () => status(o.env),
    extrato: async (p) => consultar('extrato', { ...periodoMes(p || {}), conta: validarConta((p || {}).conta) }),
    saldo: async (p) => consultar('saldo', { conta: validarConta((p || {}).conta) }),
    poupancaExtrato: async (p) => consultar('poupancaExtrato', { ...periodoMes(p || {}), conta: validarConta((p || {}).conta) }),
    poupancaSaldo: async (p) => consultar('poupancaSaldo', { conta: validarConta((p || {}).conta) }),
    dda: async (p) => {
      const di = String((p || {}).dataInicial || ''); const df = String((p || {}).dataFinal || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(di) || !/^\d{4}-\d{2}-\d{2}$/.test(df) || di > df) throw new ErroBanco('periodo_invalido');
      return consultar('dda', { dataInicial: di, dataFinal: df });
    },
    toJSON: () => ({ ligado: cfg.ligado }),
  };
}

module.exports = { criarClienteSicoob, lerConfig, status, certificadoAbre, ErroBanco, VARIAVEIS, ROTAS, HOSTS_PERMITIDOS, CAMINHO_TOKEN };
