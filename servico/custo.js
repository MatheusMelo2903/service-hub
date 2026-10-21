// T42: registro do custo de cada chamada de processamento (tabela api_uso, migration 019).
// Regra de ouro: o registro NUNCA derruba nem atrasa a chamada principal. registrar() volta
// na hora (não é async), não lança erro e grava depois, em segundo plano; falha vira só log.
//
// Preço por milhão de unidades (US$): [entrada, saída, cache lido, cache criado].
// Fonte: tabela oficial usada nas medições da T19 e da T20 (EXECUCAO/testes/T19 e T20).
// Cache lido = 10% da entrada; cache criado (5 min) = 125% da entrada.
// Trocar sem mexer no código: CUSTO_PRECOS='{"nome-do-modelo":[2,10,0.2,2.5]}' (soma ao padrão).

const PRECOS_PADRAO = {
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
  'claude-opus-5-5': [4, 20, 0.4, 5],
  'claude-opus-4-7': [5, 25, 0.5, 6.25], // [a confirmar] na tabela oficial
};

const FUNCOES = ['atas', 'comunicados', 'edital', 'medidores', 'unidades', 'prestacao', 'entrada_documentos', 'outros'];
const LIMITE_PADRAO_USD = 200;
const MAX_PENDENTES = 100;      // gravações em voo; acima disso descarta com log (nunca acumula memória)
const PRAZO_GRAVACAO_MS = 8000;

let _banco = null;
let _pendentes = 0;
let _precosCache = null;
let _precosTexto = null;

function configurar({ banco }) { _banco = typeof banco === 'function' ? banco : null; }

function precos() {
  const txt = process.env.CUSTO_PRECOS || '';
  if (_precosCache && _precosTexto === txt) return _precosCache;
  const tabela = Object.assign({}, PRECOS_PADRAO);
  if (txt) {
    try {
      const extra = JSON.parse(txt);
      Object.entries(extra || {}).forEach(([k, v]) => {
        if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && n >= 0 && n < 1000)) tabela[k] = v;
      });
    } catch (e) { console.warn('[custo] CUSTO_PRECOS inválido, usando a tabela padrão'); }
  }
  _precosCache = tabela; _precosTexto = txt;
  return tabela;
}

function limiteMensal() {
  const n = Number(process.env.CUSTO_LIMITE_MENSAL_USD);
  return isFinite(n) && n > 0 ? n : LIMITE_PADRAO_USD;
}

const inteiro = (v) => { const n = Math.round(Number(v)); return isFinite(n) && n > 0 ? Math.min(n, 2e9) : 0; };

// usage no formato da resposta da API (input_tokens, output_tokens, cache_*).
function calcular(modelo, usage) {
  const u = usage || {};
  const q = { entrada: inteiro(u.input_tokens), saida: inteiro(u.output_tokens), cache_lido: inteiro(u.cache_read_input_tokens), cache_criado: inteiro(u.cache_creation_input_tokens) };
  const p = precos()[modelo];
  const custo = p ? (q.entrada * p[0] + q.saida * p[1] + q.cache_lido * p[2] + q.cache_criado * p[3]) / 1e6 : null;
  return Object.assign(q, { custo_usd: custo == null ? null : Math.round(custo * 1e6) / 1e6 });
}

// { funcao, modelo, usage, usuario, condominio, ok, status }. Volta na hora; nunca lança.
function registrar(info) {
  try {
    if (!info || !info.usage) return false;
    const funcao = FUNCOES.includes(info.funcao) ? info.funcao : 'outros';
    const c = calcular(String(info.modelo || ''), info.usage);
    if (c.custo_usd == null) console.warn('[custo] sem preço para o modelo da função ' + funcao);
    const cond = /^[1-9][0-9]{0,8}$/.test(String(info.condominio == null ? '' : info.condominio)) ? Number(info.condominio) : null;
    const usuario = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(info.usuario || '')) ? String(info.usuario) : null;
    const linha = Object.assign({ funcao, modelo: String(info.modelo || '').slice(0, 60), user_id: usuario, id_superlogica: cond,
      ok: info.ok !== false, status: inteiro(info.status) || null }, c);
    if (!_banco) return false;
    if (_pendentes >= MAX_PENDENTES) { console.warn('[custo] fila cheia, registro descartado (' + funcao + ')'); return false; }
    _pendentes++;
    const banco = _banco;
    setImmediate(() => {
      let fim = false;
      const acabar = () => { if (!fim) { fim = true; _pendentes = Math.max(0, _pendentes - 1); } };
      const prazo = setTimeout(() => { if (!fim) console.warn('[custo] gravação demorou demais (' + funcao + ')'); acabar(); }, PRAZO_GRAVACAO_MS);
      if (typeof prazo.unref === 'function') prazo.unref();
      let p;
      try { p = Promise.resolve(banco('POST', '/rest/v1/api_uso', linha)); } catch (e) { p = Promise.reject(e); }
      p.then((r) => { if (!r || r.status >= 300) console.warn('[custo] gravação recusada status ' + (r && r.status) + ' (' + funcao + ')'); })
        .catch((e) => console.warn('[custo] gravação falhou (' + funcao + '): ' + (e && e.message)))
        .finally(() => { clearTimeout(prazo); acabar(); });
    });
    return true;
  } catch (e) {
    try { console.warn('[custo] registro falhou: ' + (e && e.message)); } catch (e2) { /* nada */ }
    return false;
  }
}

// Linhas da visão api_uso_dia ({ dia, funcao, chamadas, custo_usd }) viram o resumo do mês.
// mes: 'AAAA-MM'; agora: Date (para a projeção do mês corrente, no fuso de Brasília).
function resumirMes(linhas, mes, agora, limite) {
  const [a, m] = mes.split('-').map(Number);
  const diasNoMes = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const porFuncao = {}; const porDia = {};
  let total = 0; let chamadas = 0;
  (Array.isArray(linhas) ? linhas : []).forEach((l) => {
    if (!l || typeof l.dia !== 'string' || l.dia.slice(0, 7) !== mes) return;
    const v = Number(l.custo_usd) || 0; const n = Number(l.chamadas) || 0;
    const f = FUNCOES.includes(l.funcao) ? l.funcao : 'outros';
    const g = porFuncao[f] || (porFuncao[f] = { custo_usd: 0, chamadas: 0 });
    g.custo_usd += v; g.chamadas += n;
    const d = porDia[l.dia] || (porDia[l.dia] = { custo_usd: 0, chamadas: 0 });
    d.custo_usd += v; d.chamadas += n;
    total += v; chamadas += n;
  });
  // Hora de Brasília (UTC-3, sem horário de verão desde 2019).
  const br = new Date(agora.getTime() - 3 * 3600000);
  const mesAgora = br.getUTCFullYear() + '-' + String(br.getUTCMonth() + 1).padStart(2, '0');
  let projecao = total; let corrente = false;
  if (mesAgora === mes) {
    corrente = true;
    const decorrido = (br.getUTCDate() - 1) + (br.getUTCHours() + br.getUTCMinutes() / 60) / 24;
    projecao = decorrido >= 0.25 ? total / decorrido * diasNoMes : total;
  } else if (mesAgora < mes) { projecao = 0; }
  const arred = (x) => Math.round(x * 100) / 100;
  const lim = limite > 0 ? limite : LIMITE_PADRAO_USD;
  const pct = total / lim;
  const avisos = [];
  if (pct >= 1) avisos.push('O gasto do mês passou do limite.');
  else if (pct >= 0.75) avisos.push('O gasto do mês passou de 75% do limite.');
  if (corrente && projecao > lim && pct < 1) avisos.push('No ritmo atual o mês fecha acima do limite.');
  return {
    mes, corrente, limite_usd: lim, total_usd: arred(total), chamadas, projecao_usd: arred(projecao),
    percentual_limite: Math.round(pct * 1000) / 10, alerta: pct >= 0.75, avisos,
    por_funcao: Object.entries(porFuncao).map(([funcao, g]) => ({ funcao, custo_usd: arred(g.custo_usd), chamadas: g.chamadas })).sort((x, y) => y.custo_usd - x.custo_usd),
    por_dia: Object.keys(porDia).sort().map((dia) => ({ dia, custo_usd: arred(porDia[dia].custo_usd), chamadas: porDia[dia].chamadas })),
  };
}

function _pendentesAgora() { return _pendentes; }
// Só para teste: esquece as gravações em voo (as antigas, se terminarem, não deixam o contador negativo).
function _zerarParaTeste() { _pendentes = 0; }

module.exports = { configurar, registrar, calcular, precos, limiteMensal, resumirMes, FUNCOES, PRECOS_PADRAO, _pendentesAgora, _zerarParaTeste };
