// T29: puxa do Superlógica (SÓ GET) os dados para as regras do auditor financeiro.
// Uso: cd service-hub && railway run --service service-hub --environment dev -- node <este arquivo> <pasta_saida> [AAAA-MM-DD inicio] [AAAA-MM-DD fim]
// Nunca imprime credenciais. Máximo 3 chamadas simultâneas; pausa de 2 s em 429, erro de servidor ou queda.
// Resposta que não é JSON (estouro de memória do Superlógica vem com HTTP 200 e HTML) quebra a janela ao meio.
'use strict';
const fs = require('fs');
const path = require('path');
const { criarCliente } = require('../superlogica-dados');

const SAIDA = process.argv[2];
if (!SAIDA) { console.log('informe a pasta de saída'); process.exit(2); }
const INICIO = process.argv[3] || '2026-04-01';
const FIM = process.argv[4] || new Date().toISOString().slice(0, 10);
const APP = process.env.SUPERLOGICA_APP_TOKEN;
const ACC = process.env.SUPERLOGICA_ACCESS_TOKEN;
if (!APP || !ACC) { console.log('credenciais ausentes no ambiente'); process.exit(2); }
const BASE = (process.env.SUPERLOGICA_API_BASE || 'https://api.superlogica.net').replace(/\/+$/, '');
const cli = criarCliente({ base: BASE, appToken: APP, accessToken: ACC });
fs.mkdirSync(SAIDA, { recursive: true });

const SIMULTANEAS = 3;
const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
const log = (m) => console.log(new Date().toISOString().slice(11, 19) + ' ' + m);
const iso = (d) => d.toISOString().slice(0, 10);
const sl = (s) => s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(0, 4); // AAAA-MM-DD para MM/DD/AAAA
const maisDias = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);

// GET com até 5 tentativas; devolve a lista ou null (corpo não JSON ou erro definitivo).
async function getLista(action, params) {
  for (let t = 0; t < 5; t++) {
    try {
      const j = await cli.getUmaVez(action, params);
      if (Array.isArray(j)) return j;
      if (j && Array.isArray(j.data)) return j.data;
      return null; // 200 sem JSON de lista: estouro do Superlógica
    } catch (e) {
      const st = e.status || 0;
      if (st && st < 500 && st !== 429) { log('erro definitivo ' + action + ' http ' + st); return null; }
      log('repetindo ' + action + ' (http ' + st + ') em 2 s');
      await dorme(2000);
    }
  }
  return null;
}

async function emParalelo(tarefas, n) {
  const res = new Array(tarefas.length);
  let i = 0;
  async function trab() { while (i < tarefas.length) { const k = i++; res[k] = await tarefas[k](); } }
  await Promise.all(Array.from({ length: Math.min(n, tarefas.length) }, trab));
  return res;
}

// Puxa uma janela; se estourar, quebra ao meio até 1 dia.
async function janela(rotulo, action, base, ini, fim) {
  const arq = path.join(SAIDA, rotulo + '_' + ini + '_' + fim + '.json');
  if (fs.existsSync(arq)) { log('já existe ' + path.basename(arq)); return JSON.parse(fs.readFileSync(arq, 'utf8')).length; }
  const t0 = Date.now();
  const lista = await getLista(action, { ...base, dtInicio: sl(ini), dtFim: sl(fim) });
  if (lista) {
    fs.writeFileSync(arq, JSON.stringify(lista));
    log(rotulo + ' ' + ini + ' a ' + fim + ': ' + lista.length + ' itens em ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    return lista.length;
  }
  if (ini === fim) { log('FALHA ' + rotulo + ' ' + ini + ' (1 dia, sem resposta válida)'); fs.appendFileSync(path.join(SAIDA, 'falhas.txt'), rotulo + ' ' + ini + '\n'); return 0; }
  const meio = maisDias(ini, Math.floor(diasEntre(ini, fim) / 2));
  log('quebrando ' + rotulo + ' ' + ini + ' a ' + fim + ' em ' + meio);
  const a = await janela(rotulo, action, base, ini, meio);
  const b = await janela(rotulo, action, base, maisDias(meio, 1), fim);
  return a + b;
}

function quinzenas(ini, fim) {
  const out = [];
  let d = ini;
  while (d <= fim) {
    const dia = Number(d.slice(8, 10));
    let f;
    if (dia <= 15) f = d.slice(0, 8) + '15';
    else { const n = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)); f = iso(n); }
    if (f > fim) f = fim;
    out.push([d, f]);
    d = maisDias(f, 1);
  }
  return out;
}

function ultimosDiasUteis(fim, n) {
  const out = [];
  let d = maisDias(fim, -1);
  while (out.length < n) {
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
    d = maisDias(d, -1);
  }
  return out.reverse();
}

(async () => {
  try { fs.unlinkSync(path.join(SAIDA, 'FIM.txt')); } catch (e) { /* não existia */ }
  log('início ' + INICIO + ' a ' + FIM + ', saída ' + SAIDA);
  const LIQ = { status: 'liquidadas', comStatus: 'liquidadas', filtrarpor: 'liquidacao', idCondominio: -1 };
  const PEND = { comStatus: 'pendentes', idCondominio: -1 };
  const tarefas = [];
  for (const [a, b] of quinzenas(INICIO, FIM)) tarefas.push(() => janela('liq', 'despesas/index', LIQ, a, b));
  tarefas.push(() => janela('pend', 'despesas/index', PEND, INICIO, FIM));
  // Pendentes a vencer nos próximos 60 dias (R1 e R2 pegam a duplicidade antes de pagar)
  // e vencidas desde 01/01/2025 (R6 mais antigas).
  tarefas.push(() => janela('pend', 'despesas/index', PEND, maisDias(FIM, 1), maisDias(FIM, 60)));
  tarefas.push(() => janela('pend', 'despesas/index', PEND, '2025-01-01', maisDias(INICIO, -1)));
  const nLiq = await emParalelo(tarefas, SIMULTANEAS);
  log('despesas: ' + nLiq.reduce((s, x) => s + x, 0) + ' itens');
  const dias = ultimosDiasUteis(FIM, 10);
  const tAud = dias.map((d) => () => janela('aud', 'auditoria/index', { idCondominio: -1 }, d, d));
  const nAud = await emParalelo(tAud, SIMULTANEAS);
  log('auditoria: ' + nAud.reduce((s, x) => s + x, 0) + ' linhas em ' + dias.length + ' dias');
  fs.writeFileSync(path.join(SAIDA, 'FIM.txt'), new Date().toISOString() + '\n');
  log('FIM');
})().catch((e) => { log('erro geral ' + (e && e.message)); process.exit(1); });
