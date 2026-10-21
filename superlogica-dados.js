'use strict';
// ─────────────────────────────────────────────────────────────────────────
// Dados do Superlógica puxados pelo servidor (chaves nas ENVs, nunca no navegador).
//
// 1. Prestação de contas sem PDF: para o condomínio e o período escolhidos, busca
//    mês a mês o balancete do plano de contas, o saldo do caixa no início e no fim
//    e as despesas liquidadas (com a descrição de cada lançamento). O microserviço
//    prestacao-pdf (/v13/de-superlogica) transforma isso no mesmo dados.json que a
//    skill tira do W011A detalhado. Conferido em 20/10/2026 contra os PDFs de três
//    condomínios: saldos, receitas e despesas mês a mês idênticos.
//
// 2. Sincronização dos condomínios: cria no Hub os condomínios ativos do
//    Superlógica que ainda não existem (pelo id_superlogica). Nunca altera nem
//    apaga os que já existem (nome e dados ajustados à mão ficam como estão).
//    Roda ao subir o servidor, todo dia às 6h e pelo botão "Atualizar agora".
//
// Só leitura no Superlógica: todas as chamadas são GET.
// ─────────────────────────────────────────────────────────────────────────
const https = require('https');
const crypto = require('crypto');

const SIMULTANEAS = 6;          // chamadas em paralelo ao Superlógica
const POR_PAGINA = 50;          // despesas/index devolve no máximo 50 por página
const MAX_PAGINAS_MES = 60;     // trava de segurança (3.000 despesas num mês)
const MAX_MESES = 24;

function criarCliente({ base, appToken, accessToken }) {
  function getUmaVez(caminho, params) {
    return new Promise((resolve) => {
      const url = new URL(base + '/v2/condor/' + caminho);
      Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
      const r = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { app_token: appToken, access_token: accessToken, accept: 'application/json' },
      }, (resp) => {
        const partes = [];
        resp.on('data', (c) => partes.push(c));
        resp.on('error', () => resolve({ status: 0 }));
        resp.on('aborted', () => resolve({ status: 0 }));
        resp.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (e) { /* não JSON */ }
          resolve({ status: resp.statusCode, json });
        });
      });
      r.setTimeout(90000, () => { r.destroy(); resolve({ status: 504 }); });
      r.on('error', () => resolve({ status: 0 }));
      r.end();
    });
  }
  // Repete em limite de requisição, erro de servidor ou queda de rede.
  async function get(caminho, params) {
    let ultima = null;
    for (let t = 0; t < 4; t++) {
      const r = await getUmaVez(caminho, params);
      if (r.status === 200) return r.json;
      ultima = r;
      if (r.status && r.status < 500 && r.status !== 429) break;
      await new Promise((ok) => setTimeout(ok, 1500 * (t + 1)));
    }
    const e = new Error('superlogica_' + (ultima && ultima.status));
    e.status = ultima && ultima.status;
    e.corpo = ultima && ultima.json;
    throw e;
  }
  // Uma tentativa só, sem retry (para chamadas que não podem repetir). Mesmo formato do get.
  async function getUmaVez1(caminho, params) {
    const r = await getUmaVez(caminho, params);
    if (r.status === 200) return r.json;
    const e = new Error('superlogica_' + r.status);
    e.status = r.status;
    e.corpo = r.json;
    throw e;
  }
  return { get, getUmaVez: getUmaVez1 };
}

// Executa tarefas assíncronas com no máximo n ao mesmo tempo.
async function emParalelo(tarefas, n) {
  const res = new Array(tarefas.length);
  let i = 0;
  async function trab() { while (i < tarefas.length) { const k = i++; res[k] = await tarefas[k](); } }
  await Promise.all(Array.from({ length: Math.min(n, tarefas.length) }, trab));
  return res;
}

const doisDig = (n) => String(n).padStart(2, '0');
const dataSL = (y, m, d) => doisDig(m) + '/' + doisDig(d) + '/' + y; // a API usa MM/DD/AAAA

function mesesEntre(inicio, fim) {
  let [y, m] = inicio.split('-').map(Number);
  const [y2, m2] = fim.split('-').map(Number);
  const out = [];
  while (y < y2 || (y === y2 && m <= m2)) {
    out.push([y, m]);
    m++; if (m === 13) { y++; m = 1; }
  }
  return out;
}

// Só os campos que o conversor usa: menos tráfego e nenhum dado de fornecedor
// (CPF, conta bancária, endereço) sai do servidor do Hub.
function enxugarBalancete(bruto) {
  return (Array.isArray(bruto) ? bruto : []).map((bloco) => ({
    itens: ((bloco && bloco.itens) || []).map((grupo) => (grupo || []).map((l) => {
      const o = { conta: l.conta, descricao: l.descricao, valor: l.valor };
      if (l.itens !== undefined && l.itens !== null) o.itens = l.itens;
      return o;
    })),
  }));
}

function enxugarDespesa(d) {
  return {
    id_parcela_pdes: d.id_parcela_pdes,
    id_despesa_des: d.id_despesa_des,
    fl_liquidado_pdes: d.fl_liquidado_pdes,
    dt_liquidacao_pdes: d.dt_liquidacao_pdes,
    vl_valor_pdes: d.vl_valor_pdes,
    st_complemento_pdes: d.st_complemento_pdes,
    apropriacao: (Array.isArray(d.apropriacao) ? d.apropriacao : []).map((a) => ({
      st_conta_cont: a.st_conta_cont,
      st_descricao_cont: a.st_descricao_cont,
      st_complemento_apro: a.st_complemento_apro,
      vl_valor_apro: a.vl_valor_apro,
    })),
  };
}

async function puxarDadosPrestacao(cliente, { idCondominio, inicio, fim, nome, fantasia }) {
  const meses = mesesEntre(inicio, fim);
  if (!meses.length || meses.length > MAX_MESES) throw new Error('periodo_invalido');
  const cid = String(idCondominio);

  const balancete = ([y, m]) => async () => {
    const ult = new Date(y, m, 0).getDate();
    const j = await cliente.get('balancetes/index', { idCondominio: cid, dtInicio: dataSL(y, m, 1), dtFim: dataSL(y, m, ult) });
    return [y + '-' + doisDig(m), enxugarBalancete(j)];
  };
  const despesas = ([y, m]) => async () => {
    const ult = new Date(y, m, 0).getDate();
    const out = [];
    for (let pg = 1; pg <= MAX_PAGINAS_MES; pg++) {
      const j = await cliente.get('despesas/index', {
        idCondominio: cid, dtInicio: dataSL(y, m, 1), dtFim: dataSL(y, m, ult),
        comStatus: 'liquidadas', itensPorPagina: POR_PAGINA, pagina: pg,
      });
      if (!Array.isArray(j)) break;
      j.forEach((d) => out.push(enxugarDespesa(d)));
      if (j.length < POR_PAGINA) break;
    }
    return out;
  };
  // Saldo do caixa na abertura de um dia (todas as contas do condomínio).
  const saldoEm = (y, m, d) => async () => {
    const j = await cliente.get('caixa/index', { idCondominio: cid, dtInicio: dataSL(y, m, d), dtFim: dataSL(y, m, d) });
    const linha = Array.isArray(j) ? j.find((x) => x && x.saldoinicialconta !== undefined) : null;
    return linha ? Number(linha.saldoinicialconta) : null;
  };

  const [y0, m0] = meses[0];
  const [yf, mf] = meses[meses.length - 1];
  const prox = mf === 12 ? [yf + 1, 1] : [yf, mf + 1];
  const hoje = new Date();
  const fimNoPassado = new Date(prox[0], prox[1] - 1, 1) <= hoje;

  const tarefas = [
    saldoEm(y0, m0, 1),
    fimNoPassado ? saldoEm(prox[0], prox[1], 1) : async () => null,
    ...meses.map(balancete),
    ...meses.map(despesas),
  ];
  const r = await emParalelo(tarefas, SIMULTANEAS);
  const n = meses.length;
  if (r[0] === null) throw new Error('saldo_indisponivel');
  return {
    condominio: { id: cid, nome: nome || '', fantasia: fantasia || '' },
    inicio, fim,
    saldo_inicial: r[0],
    saldo_final_ref: r[1],
    balancetes: Object.fromEntries(r.slice(2, 2 + n)),
    despesas: [].concat(...r.slice(2 + n)),
  };
}

// ── Condomínios ──────────────────────────────────────────────────────────
const PREFIXOS = /^(condom[ií]nio|cond\.?)\s+(do\s+|da\s+)?(edif[ií]cio\s+|residencial\s+)?/i;
const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'd']);

// "CONDOMINIO DO EDIFICIO LARA HOFFMAN" / "LARA HOFFMAN" -> "Lara Hoffman".
function nomeAmigavel(c) {
  let s = String(c.st_fantasia_cond || '').trim();
  if (!s || s.length > 45) s = String(c.st_nome_cond || s).trim();
  // C07: fantasia que é só uma palavra genérica ("Residencial") não identifica; usa o nome.
  if (/^(residencial|condom[ií]nio|edif[ií]cio|cond\.?)$/i.test(s) && String(c.st_nome_cond || '').trim()) s = String(c.st_nome_cond).trim();
  // Empresa (LTDA) mantém o nome inteiro: "Condomínio Service" é razão social, não prefixo.
  if (!/\bLTDA\b/i.test(s)) s = s.replace(PREFIXOS, '');
  s = s.replace(/\s+/g, ' ').trim() || String(c.st_nome_cond || '').trim();
  return s.toLowerCase().split(' ').map((p, i) => {
    if (i && MINUSCULAS.has(p)) return p;
    if (/^(i{1,3}|iv|v|vi{0,3})$/i.test(p)) return p.toUpperCase();
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join(' ');
}

async function listarCondominiosSuperlogica(cliente) {
  const todos = [];
  for (let pg = 1; pg <= 20; pg++) {
    const j = await cliente.get('condominios/get', { id: -1, somenteCondominiosAtivos: 1, itensPorPagina: 500, pagina: pg });
    if (!Array.isArray(j) || !j.length) break;
    j.forEach((c) => todos.push(c));
    if (j.length < 500) break;
  }
  return todos;
}

// Entram todos os cadastros ativos do Superlógica (condomínios, associações,
// lojas maçônicas e empresas clientes), por decisão do Matheus em 20/10/2026.
// Fica fora só a Virtual Service, que nunca pode aparecer ligada ao Grupo
// Service, e os códigos listados em SYNC_CONDOMINIOS_IGNORAR (ex.: "73,160").
const NAO_CONDOMINIO = /\bVIRTUAL SERVICE\b/i;
function ignorado(c) {
  const extra = String(process.env.SYNC_CONDOMINIOS_IGNORAR || '').split(/[,\s]+/).map(Number).filter((n) => n > 0);
  return extra.includes(Number(c.id_condominio_cond))
    || NAO_CONDOMINIO.test(String(c.st_nome_cond || '')) || NAO_CONDOMINIO.test(String(c.st_fantasia_cond || ''));
}

// Chave de comparação de nome: sem acento, sem prefixo, minúsculo, só letras e números.
function chaveNome(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(PREFIXOS, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Só cria linhas novas; nunca altera as que existem. Quando o Hub já tem uma linha
// SEM o código do Superlógica com o mesmo nome (cadastro feito à mão), não cria
// duplicata: devolve em "sem_codigo" para alguém preencher o código no cadastro.
// dryRun: só calcula o que faria, sem gravar nada.
async function sincronizarCondominios(cliente, supabaseAdminRequest, { dryRun = false } = {}) {
  const lista = (await listarCondominiosSuperlogica(cliente))
    .filter((c) => String(c.fl_ativo_cond || '1') !== '0' && Number(c.id_condominio_cond) > 0 && !ignorado(c));
  const ex = await supabaseAdminRequest('GET', '/rest/v1/condominios?select=nome,id_superlogica');
  if (ex.status !== 200 || !Array.isArray(ex.body)) throw new Error('supabase_' + ex.status);
  const jaTem = new Set(ex.body.map((c) => Number(c.id_superlogica)).filter((n) => n > 0));
  const nomesSemCodigo = new Map();
  ex.body.filter((c) => !(Number(c.id_superlogica) > 0)).forEach((c) => {
    const k = chaveNome(c.nome);
    if (k) nomesSemCodigo.set(k, c.nome);
  });

  const novos = [];
  const semCodigo = [];
  lista.filter((c) => !jaTem.has(Number(c.id_condominio_cond))).forEach((c) => {
    const id = Number(c.id_condominio_cond);
    const chaves = [c.st_fantasia_cond, c.st_nome_cond, nomeAmigavel(c)].map(chaveNome).filter(Boolean);
    const existente = chaves.map((k) => nomesSemCodigo.get(k)).find(Boolean);
    if (existente) semCodigo.push({ nome_hub: existente, id_superlogica: id });
    else novos.push({ id: crypto.randomUUID(), nome: nomeAmigavel(c), id_superlogica: id });
  });

  if (!dryRun && novos.length) {
    const ins = await supabaseAdminRequest('POST', '/rest/v1/condominios', novos);
    if (ins.status < 200 || ins.status >= 300) throw new Error('supabase_insert_' + ins.status);
  }
  return {
    total_superlogica: lista.length,
    ja_existiam: lista.length - novos.length - semCodigo.length,
    criados: novos.map((c) => c.nome),
    sem_codigo: semCodigo,
  };
}

module.exports = { criarCliente, puxarDadosPrestacao, sincronizarCondominios, listarCondominiosSuperlogica, nomeAmigavel, mesesEntre, MAX_MESES };
