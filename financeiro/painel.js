// T31: dados da aba Financeiro. Só leitura no Superlógica (GET), sem banco e sem gravação.
// 1. Base da carteira inteira (idCondominio=-1): despesas pagas dos últimos meses, pendentes e
//    a auditoria dos últimos dias úteis, com as regras da T25 rodando por cima. Fica em memória
//    por 10 minutos e é a fonte dos alertas por condomínio e do resumo por carteira.
//    (Quando as tabelas fin_* da T24 entrarem, a base passa a vir delas.)
// 2. Pré balancete de um condomínio num mês: chamadas só daquele condomínio e daquele mês,
//    com as regras que impedem fechar (sem comprovante, sem nota, vencida sem baixa,
//    lançamento tardio, mexida suspeita).
// Carga no Superlógica: no máximo 2 chamadas ao mesmo tempo (fila única deste módulo);
// resposta que não é JSON (estouro de memória vem com HTTP 200 e HTML) quebra a janela ao meio.
'use strict';
const regras = require('./regras');
const U = regras.util;

const SIMULTANEAS = 2;
const TTL_BASE = 10 * 60 * 1000;
const MESES_PAGAS = 2;          // mês atual mais os 2 anteriores
const DIAS_AUDITORIA = 3;       // últimos dias úteis lidos da auditoria na base
const ESPERA_ROTA = 20000;      // a rota espera a base até 20 s; depois responde "calculando"
const ESPERA_APOS_ERRO = 120000; // C05: depois de um cálculo que falhou, 2 min sem tentar de novo
const WEB_BASE = (process.env.SUPERLOGICA_WEB_BASE || 'https://condominioes.superlogica.net/clients/condor').replace(/\/+$/, '');

// ── fila de chamadas ao Superlógica ───────────────────────────────────────
function criarFila(n) {
  let ativos = 0;
  const espera = [];
  const proximo = () => {
    if (ativos >= n || !espera.length) return;
    ativos++;
    const { fn, ok, falha } = espera.shift();
    Promise.resolve().then(fn).then(ok, falha).finally(() => { ativos--; proximo(); });
  };
  return (fn) => new Promise((ok, falha) => { espera.push({ fn, ok, falha }); proximo(); });
}

// ── datas ─────────────────────────────────────────────────────────────────
const sl = (s) => s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(0, 4); // AAAA-MM-DD para MM/DD/AAAA
const fimDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
function competencia(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const ano = +m[1], mes = +m[2];
  if (mes < 1 || mes > 12 || ano < 2020 || ano > 2100) return null;
  return { ano, mes, inicio: m[1] + '-' + m[2] + '-01', fim: fimDoMes(ano, mes), rotulo: m[1] + '-' + m[2] };
}
function inicioMesesAtras(hoje, n) {
  const d = new Date(hoje + 'T12:00:00Z');
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}
function quinzenas(ini, fim) {
  const out = [];
  let d = ini;
  while (d <= fim) {
    const dia = Number(d.slice(8, 10));
    let f = dia <= 15 ? d.slice(0, 8) + '15' : fimDoMes(Number(d.slice(0, 4)), Number(d.slice(5, 7)));
    if (f > fim) f = fim;
    out.push([d, f]);
    d = U.maisDias(f, 1);
  }
  return out;
}
function ultimosDiasUteis(hoje, n) {
  const out = [];
  let d = U.maisDias(hoje, -1);
  while (out.length < n) {
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
    d = U.maisDias(d, -1);
  }
  return out.reverse();
}

// ── leitura enxuta (só os campos que as regras usam; nada de chave Pix, conta ou senha) ──
const texto = (v, n) => String(v == null ? '' : v).slice(0, n || 200);
function enxugarDespesa(d) {
  return {
    id_despesa_des: texto(d.id_despesa_des, 20), id_parcela_pdes: texto(d.id_parcela_pdes, 20),
    id_condominio_cond: texto(d.id_condominio_cond, 12), st_fantasia_cond: texto(d.st_fantasia_cond),
    id_contato_con: texto(d.id_contato_con, 20), st_nome_con: texto(d.st_nome_con), st_fantasia_con: texto(d.st_fantasia_con),
    st_cpf_con: texto(d.st_cpf_con, 30), st_documento_des: texto(d.st_documento_des, 60),
    dt_geracao_des: texto(d.dt_geracao_des, 30), dt_vencimento_pdes: texto(d.dt_vencimento_pdes, 30),
    dt_liquidacao_pdes: texto(d.dt_liquidacao_pdes, 30), fl_liquidado_pdes: texto(d.fl_liquidado_pdes, 3),
    vl_valor_pdes: texto(d.vl_valor_pdes, 30), vl_juros_pdes: texto(d.vl_juros_pdes, 30), vl_multa_pdes: texto(d.vl_multa_pdes, 30),
    st_codigobarras_pdes: texto(d.st_codigobarras_pdes, 80), id_forma_pag: texto(d.id_forma_pag, 4),
    arquivos: (Array.isArray(d.arquivos) ? d.arquivos : []).filter(Boolean).map((a) => ({
      st_nomeabreviadoetiqueta_eti: texto(a.st_nomeabreviadoetiqueta_eti, 40), fl_excluido_arq: texto(a.fl_excluido_arq, 3), dt_envio_arq: texto(a.dt_envio_arq, 30),
    })),
    documentos_pendentes: (Array.isArray(d.documentos_pendentes) ? d.documentos_pendentes : []).filter(Boolean).map((p) => ({ descricao: texto(p.descricao, 80) })),
    apropriacao: (Array.isArray(d.apropriacao) ? d.apropriacao : []).filter(Boolean).map((a) => ({ st_descricao_cont: texto(a.st_descricao_cont, 80) })),
  };
}
// Da auditoria só interessam as linhas de despesa e de arquivo (as regras R4b e R9 e o analista).
const RX_AUD_UTIL = /despesa\s?#|Arquivo#/i;
function enxugarAuditoria(lista) {
  const out = [];
  for (const r of lista) {
    if (!r || !RX_AUD_UTIL.test(String(r.st_texto_aud || ''))) continue;
    out.push({
      id_auditoria_aud: texto(r.id_auditoria_aud, 20), dt_data_aud: texto(r.dt_data_aud, 30), id_usuario_usu: texto(r.id_usuario_usu, 12),
      st_apelido_usu: texto(r.st_apelido_usu, 80), st_texto_aud: texto(r.st_texto_aud, 600), st_sql_aud: texto(r.st_sql_aud, 12),
      st_fantasia_cond: texto(r.st_fantasia_cond),
    });
  }
  return out;
}

// GET de uma lista. null = corpo que não é JSON (estouro de memória do Superlógica vem como HTML
// com HTTP 200: o cliente devolve null). JSON que não é lista (mensagem de erro) é falha, sem quebrar.
const MAX_QUEBRAS = 40; // teto de quebras de janela por cálculo (protege o Superlógica)
async function getLista(cliente, fila, action, params) {
  const j = await fila(() => cliente.get(action, params));
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.data)) return j.data;
  if (j === null || j === undefined) return null;
  const e = new Error('resposta_sem_lista'); e.motivo = 'resposta sem lista'; throw e;
}
// Lê uma janela de datas; se o Superlógica estourar, quebra ao meio até 1 dia (no máximo MAX_QUEBRAS por cálculo).
async function janela(cliente, fila, action, base, ini, fim, falhas) {
  let lista = null;
  try { lista = await getLista(cliente, fila, action, Object.assign({}, base, { dtInicio: sl(ini), dtFim: sl(fim) })); } catch (e) {
    falhas.push(action + ' ' + ini + ' a ' + fim + ' (' + (e && e.motivo ? e.motivo : (e && e.status ? 'http ' + e.status : 'sem resposta')) + ')');
    return [];
  }
  if (lista) return lista;
  falhas.quebras = (falhas.quebras || 0) + 1;
  if (ini >= fim || falhas.quebras > MAX_QUEBRAS) { falhas.push(action + ' ' + ini + ' a ' + fim + ' (resposta inválida)'); return []; }
  const meio = U.maisDias(ini, Math.floor(U.dias(ini, fim) / 2));
  const a = await janela(cliente, fila, action, base, ini, meio, falhas);
  const b = await janela(cliente, fila, action, base, U.maisDias(meio, 1), fim, falhas);
  return a.concat(b);
}

const LIQ = { status: 'liquidadas', comStatus: 'liquidadas', filtrarpor: 'liquidacao' };
const PEND = { comStatus: 'pendentes' };

// ── alertas para a tela ───────────────────────────────────────────────────
function linkLancamento(idDespesa, idCondominio) {
  if (!/^\d+$/.test(String(idDespesa || '')) || !/^\d+$/.test(String(idCondominio || ''))) return '';
  return WEB_BASE + '/despesas/id/' + idDespesa + '?idCondominio=' + idCondominio;
}
const CAMPOS_ALERTA = ['regra', 'tipo', 'descricao_tipo', 'gravidade', 'id_condominio', 'condominio', 'analista', 'analista_origem', 'fornecedor', 'documento',
  'valor', 'id_despesa', 'id_parcela', 'dt_lancamento', 'dt_vencimento', 'dt_liquidacao', 'dias_atraso', 'detalhe', 'mexida', 'usuario', 'quando', 'relacionados'];
function paraTela(a) {
  const o = {};
  for (const k of CAMPOS_ALERTA) if (a[k] !== undefined && a[k] !== '') o[k] = a[k];
  o.link = linkLancamento(a.id_despesa, a.id_condominio);
  return o;
}
const PESO = { alta: 3, media: 2, baixa: 1 };
const ordenarAlertas = (lista) => lista.sort((a, b) => (PESO[b.gravidade] || 0) - (PESO[a.gravidade] || 0) || (Number(b.valor) || 0) - (Number(a.valor) || 0));

// ── base da carteira inteira ──────────────────────────────────────────────
async function montarBase(cliente, fila, hoje) {
  const falhas = [];
  const iniPagas = inicioMesesAtras(hoje, MESES_PAGAS);
  const iniPend = inicioMesesAtras(hoje, 6);
  // C05: cada janela principal anota as próprias falhas (o teto de quebras continua comum a todas)
  // para contar quantas janelas principais falharam, e não quantos pedaços.
  let quebras = 0;
  let janelasFalhas = 0;
  const principal = (action, params, a, b) => {
    const f = [];
    Object.defineProperty(f, 'quebras', { get: () => quebras, set: (v) => { quebras = v; } });
    return janela(cliente, fila, action, params, a, b, f).then((l) => { if (f.length) { janelasFalhas++; falhas.push(...f); } return l; });
  };
  const tarefas = quinzenas(iniPagas, hoje).map(([a, b]) => principal('despesas/index', Object.assign({ idCondominio: -1 }, LIQ), a, b));
  tarefas.push(principal('despesas/index', Object.assign({ idCondominio: -1 }, PEND), '2025-01-01', U.maisDias(iniPend, -1)));
  tarefas.push(principal('despesas/index', Object.assign({ idCondominio: -1 }, PEND), iniPend, U.maisDias(hoje, 60)));
  const dias = ultimosDiasUteis(hoje, DIAS_AUDITORIA);
  const tAud = dias.map((d) => principal('auditoria/index', { idCondominio: -1 }, d, d).then(enxugarAuditoria));
  const despesas = [].concat(...(await Promise.all(tarefas))).map(enxugarDespesa);
  const auditoria = [].concat(...(await Promise.all(tAud)));
  const r = regras.rodarRegras({ despesas, auditoria }, { hoje });
  const condominios = new Map();
  const nomeCond = (id, nome) => { if (!id) return; const c = condominios.get(id); if (!c) condominios.set(id, { nome: nome || '' }); else if (!c.nome && nome) c.nome = nome; };
  for (const d of despesas) nomeCond(d.id_condominio_cond, String(d.st_fantasia_cond || '').trim());
  const porCondominio = new Map();
  for (const a of r.alertas) {
    if (!a.id_condominio) continue;
    nomeCond(a.id_condominio, a.condominio);
    if (!porCondominio.has(a.id_condominio)) porCondominio.set(a.id_condominio, []);
    porCondominio.get(a.id_condominio).push(paraTela(a));
  }
  for (const l of porCondominio.values()) ordenarAlertas(l);
  return {
    gerado_em: new Date().toISOString(), hoje,
    periodo: { pagas_desde: iniPagas, pendentes_ate: U.maisDias(hoje, 60), auditoria_dias: dias },
    totais: { parcelas: despesas.length, linhas_auditoria: auditoria.length, alertas: r.alertas.length },
    condominios, porCondominio, analistas: r.analistasPorCondominio, falhas,
    // Juros e atrasos (financeiro/juros.js) monta o quadro da carteira com as mesmas parcelas.
    despesas,
    janelas_pedidas: tarefas.length + tAud.length, janelas_falhas: janelasFalhas,
  };
}

function resumoDe(base, ids) {
  const linhas = [];
  for (const [id, c] of base.condominios) {
    if (U.IDS_EXCLUIDOS.has(id) || id === U.ID_TESTE) continue;
    if (ids && !ids.has(id)) continue;
    const al = base.porCondominio.get(id) || [];
    const porGravidade = { alta: 0, media: 0, baixa: 0 };
    const porTipo = {};
    let valorAlta = 0;
    for (const a of al) {
      porGravidade[a.gravidade] = (porGravidade[a.gravidade] || 0) + 1;
      // T51: valor_alta também por tipo, para a tela descontar o tipo silenciado do valor do condomínio.
      const t = porTipo[a.tipo] || (porTipo[a.tipo] = { descricao: a.descricao_tipo, total: 0, alta: 0, media: 0, baixa: 0, valor_alta: 0 });
      t.total++; t[a.gravidade]++;
      if (a.gravidade === 'alta') { valorAlta += Number(a.valor) || 0; t.valor_alta = Math.round((t.valor_alta + (Number(a.valor) || 0)) * 100) / 100; }
    }
    linhas.push({ id_condominio: id, condominio: c.nome, analista: (base.analistas && base.analistas.get(id)) || '', total: al.length, por_gravidade: porGravidade, por_tipo: porTipo, valor_alta: Math.round(valorAlta * 100) / 100 });
  }
  linhas.sort((a, b) => b.por_gravidade.alta - a.por_gravidade.alta || b.por_gravidade.media - a.por_gravidade.media || b.total - a.total || a.condominio.localeCompare(b.condominio));
  return linhas;
}

// ── pré balancete ─────────────────────────────────────────────────────────
const GRUPOS_PRE = [
  { chave: 'sem_comprovante', titulo: 'Pagas sem comprovante', tipos: ['R4_SEM_COMPROVANTE'] },
  { chave: 'sem_nota', titulo: 'Pagas sem nota fiscal', tipos: ['R5_SEM_NOTA'] },
  { chave: 'vencida', titulo: 'Vencidas sem baixa', tipos: ['R6_VENCIDA'] },
  { chave: 'lancamento_tardio', titulo: 'Lançadas depois do vencimento', tipos: ['R8_LANCAMENTO_TARDIO'] },
  { chave: 'mexida', titulo: 'Mexidas suspeitas (valor, vencimento, anexo removido, exclusão)', tipos: ['R9_MEXIDA', 'R4_ANEXO_REMOVIDO'] },
];
const noMes = (iso, c) => !!iso && iso >= c.inicio && iso <= c.fim;

function montarPreBalancete(c, hoje, despesas, auditoria, idCondominio) {
  const ref = hoje < U.maisDias(c.fim, 1) ? hoje : U.maisDias(c.fim, 1);
  const r = regras.rodarRegras({ despesas, auditoria }, { hoje: ref, regras: ['R4', 'R5', 'R6', 'R8', 'R9'] });
  const grupos = GRUPOS_PRE.map((g) => ({ chave: g.chave, titulo: g.titulo, quantidade: 0, bloqueiam: 0, valor: 0, itens: [] }));
  for (const a of r.alertas) {
    const gi = GRUPOS_PRE.findIndex((g) => g.tipos.includes(a.tipo));
    if (gi < 0) continue;
    if (idCondominio && a.id_condominio !== idCondominio) continue;
    // Lançamento tardio só conta para as parcelas deste mês (vencimento ou pagamento no mês).
    if (a.tipo === 'R8_LANCAMENTO_TARDIO' && !noMes(a.dt_vencimento, c) && !noMes(a.dt_liquidacao, c)) continue;
    const g = grupos[gi];
    g.quantidade++;
    if (a.gravidade !== 'baixa') g.bloqueiam++;
    g.valor = Math.round((g.valor + (Number(a.valor) || 0)) * 100) / 100;
    g.itens.push(paraTela(a));
  }
  grupos.forEach((g) => ordenarAlertas(g.itens));
  const pagas = despesas.filter((d) => noMes(U.data(d.dt_liquidacao_pdes), c));
  const ids = new Set();
  const pagasUnicas = pagas.filter((d) => { const k = d.id_parcela_pdes; if (ids.has(k)) return false; ids.add(k); return true; });
  return {
    competencia: c.rotulo, referencia: ref,
    pode_fechar: grupos.every((g) => g.bloqueiam === 0),
    pendencias: grupos.reduce((s, g) => s + g.bloqueiam, 0),
    para_conferir: grupos.reduce((s, g) => s + g.quantidade - g.bloqueiam, 0),
    parcelas_pagas: pagasUnicas.length,
    valor_pago: Math.round(pagasUnicas.reduce((s, d) => s + U.valor(d.vl_valor_pdes), 0) * 100) / 100,
    grupos,
  };
}

async function preBalancete(cliente, fila, idCondominio, comp, hoje) {
  const c = competencia(comp);
  if (!c) { const e = new Error('competencia_invalida'); e.status = 400; throw e; }
  if (c.inicio > hoje) { const e = new Error('competencia_futura'); e.status = 400; throw e; }
  const falhas = [];
  const fimAud = c.fim < hoje ? c.fim : hoje;
  const [pagas, pend, aud] = await Promise.all([
    janela(cliente, fila, 'despesas/index', Object.assign({ idCondominio }, LIQ), c.inicio, c.fim, falhas),
    janela(cliente, fila, 'despesas/index', Object.assign({ idCondominio }, PEND), '2025-01-01', c.fim, falhas),
    janela(cliente, fila, 'auditoria/index', { idCondominio }, c.inicio, fimAud, falhas),
  ]);
  // Garante que só entra o condomínio pedido (a API costuma respeitar, mas não confiamos).
  const doCond = (d) => String(d.id_condominio_cond || '') === String(idCondominio);
  const despesas = pagas.concat(pend).filter(doCond).map(enxugarDespesa);
  // A auditoria lida por condomínio traz linhas de arquivo com condomínio -1 de outros condomínios:
  // não atribuímos ao condomínio pedido. As regras acham o condomínio pela despesa (puxada ou citada
  // em outra linha) e o que não for deste condomínio sai no filtro do montarPreBalancete.
  const r = montarPreBalancete(c, hoje, despesas, enxugarAuditoria(aud), String(idCondominio));
  r.condominio = String(idCondominio);
  r.nome = (despesas.find((d) => d.st_fantasia_cond) || {}).st_fantasia_cond || '';
  r.falhas = falhas;
  r.gerado_em = new Date().toISOString();
  return r;
}

// Alerta R2 cita a despesa do outro condomínio (nome, número, valor): para quem tem carteira,
// fica só o aviso, sem os dados de fora. Os outros alertas só citam o próprio condomínio.
function semOutroCondominio(a) {
  if (a.regra !== 'R2') return a;
  const o = Object.assign({}, a);
  delete o.relacionados;
  o.detalhe = 'O mesmo código de barras ou nota aparece em outro condomínio. Peça ao gestor para conferir o outro lançamento.';
  return o;
}

// ── estado do servidor ────────────────────────────────────────────────────
// opcoes: { cliente: () => cliente do Superlógica, hoje: () => 'AAAA-MM-DD', log }
function criarPainel(opcoes) {
  const fila = criarFila(SIMULTANEAS);
  const hoje = opcoes.hoje || U.hojeSP;
  const log = opcoes.log || ((m) => console.warn(m));
  let base = null;          // última base pronta
  let andamento = null;     // Promise da base em cálculo
  let iniciado = null;
  let ultimoErro = null;
  let forcadoEm = 0;

  function recalcular() {
    if (andamento) return andamento;
    iniciado = new Date().toISOString();
    const dia = hoje();
    andamento = montarBase(opcoes.cliente(), fila, dia)
      .then((b) => {
        // Superlógica fora do ar: cálculo sem nenhuma parcela e com falhas não substitui a base boa.
        if (b.falhas.length && !b.totais.parcelas) { const e = new Error('base_vazia_com_falhas'); throw e; }
        // C05: a janela engole o erro e só anota em falhas; metade ou mais das leituras falhando
        // também não substitui a base boa (menor 2 da revisão 2 da T31).
        if (b.janelas_pedidas && (b.janelas_falhas || 0) * 2 >= b.janelas_pedidas) { const e = new Error('base_com_muitas_falhas'); throw e; }
        base = b; ultimoErro = null; return b;
      })
      .catch((e) => { ultimoErro = new Date().toISOString(); log('[financeiro] base falhou: ' + (e && e.message)); throw e; })
      .finally(() => { andamento = null; });
    andamento.catch(() => {});
    return andamento;
  }
  const vencida = (b) => !b || Date.now() - Date.parse(b.gerado_em) > TTL_BASE || b.hoje !== hoje();
  // Devolve a base pronta ou null (ainda calculando). forcar: recalcula em segundo plano, no máximo
  // uma vez a cada 5 minutos, sem apagar a base atual (ninguém fica sem tela enquanto recalcula).
  const doDia = () => (base && base.hoje === hoje() ? base : null);
  async function obterBase(forcar) {
    if (forcar && !andamento && base && Date.now() - forcadoEm > 300000 && Date.now() - Date.parse(base.gerado_em) > 60000) {
      forcadoEm = Date.now();
      recalcular();
      // C05: na virada do dia a base de ontem não aparece; sem base do dia segue o caminho normal.
      if (doDia()) return doDia();
    }
    if (!vencida(base)) return base;
    // Base passou dos 10 minutos mas é do mesmo dia: devolve na hora e recalcula por trás, em vez
    // de segurar a rota até 20 s. A tela mostra a hora do cálculo e o aviso de atualizando
    // (recalculando:true) e relê sozinha. Só a primeira base do dia (servidor recém ligado ou
    // virada do dia) ainda faz esperar. A base é a mesma para todos; o filtro por carteira e
    // permissão continua na rota, depois daqui.
    if (doDia()) {
      const emEsperaAposErro = ultimoErro && Date.now() - Date.parse(ultimoErro) < ESPERA_APOS_ERRO;
      if (!andamento && !emEsperaAposErro) recalcular();
      return doDia();
    }
    // C05: depois de uma falha, espera 2 minutos antes de tentar de novo (não dispara um recálculo por requisição).
    if (!andamento && ultimoErro && Date.now() - Date.parse(ultimoErro) < ESPERA_APOS_ERRO) {
      if (doDia()) return doDia();
      const e = new Error('falha_superlogica'); e.status = 502; throw e;
    }
    const p = recalcular();
    const tempo = new Promise((ok) => setTimeout(() => ok(null), ESPERA_ROTA));
    const r = await Promise.race([p.catch(() => 'erro'), tempo]);
    if (r === 'erro') {
      if (doDia()) return doDia(); // falhou o recálculo: fica a base anterior do mesmo dia
      const e = new Error('falha_superlogica'); e.status = 502; throw e;
    }
    if (r) return r;
    // Enquanto recalcula, a base anterior do mesmo dia continua valendo (a tela avisa a hora).
    return doDia();
  }
  const situacao = () => ({ calculando: !!andamento, desde: andamento ? iniciado : null, ultimo_erro: ultimoErro });

  const cachePre = new Map(); // id|competencia -> { ate, promessa }
  function preBalanceteCache(id, comp, forcar) {
    const k = id + '|' + comp;
    const c = cachePre.get(k);
    // Atualizar (forcar) relê no máximo uma vez por minuto o mesmo condomínio e mês.
    if (c && c.ate > Date.now() && (!forcar || Date.now() - c.criado < 60000)) return c.promessa;
    const promessa = preBalancete(opcoes.cliente(), fila, id, comp, hoje());
    cachePre.set(k, { ate: Date.now() + TTL_BASE, criado: Date.now(), promessa });
    promessa.catch(() => cachePre.delete(k));
    if (cachePre.size > 200) cachePre.delete(cachePre.keys().next().value);
    return promessa;
  }

  return {
    obterBase, situacao, recalcular,
    // restrito: quem só vê a própria carteira não recebe dados do outro condomínio do alerta R2.
    alertasDoCondominio(b, id, restrito) {
      const c = b.condominios.get(String(id));
      let alertas = b.porCondominio.get(String(id)) || [];
      if (restrito) alertas = alertas.map(semOutroCondominio);
      return { condominio: String(id), nome: c ? c.nome : '', analista: (b.analistas && b.analistas.get(String(id))) || '',
        gerado_em: b.gerado_em, periodo: b.periodo, alertas, falhas: b.falhas };
    },
    // ids null = todos (GESTOR): só então vão os totais da base inteira.
    resumo(b, ids, completo) { return { gerado_em: b.gerado_em, periodo: b.periodo, totais: completo ? b.totais : undefined, falhas: b.falhas, condominios: resumoDe(b, ids) }; },
    preBalancete: preBalanceteCache,
  };
}

// Módulo "financeiro" nas permissões: GESTOR sempre; os outros com o módulo visível e a ação.
function temFinanceiro(perfil, acao) {
  if (!perfil) return false;
  if (perfil.role === 'GESTOR') return true;
  const m = perfil.permissoes && perfil.permissoes.financeiro;
  if (!m || m.visivel !== true) return false;
  return Array.isArray(m.acoes) && m.acoes.includes(acao || 'ver');
}

module.exports = {
  criarPainel, temFinanceiro, competencia, linkLancamento, semOutroCondominio,
  // para teste
  enxugarDespesa, enxugarAuditoria, resumoDe, montarPreBalancete, quinzenas, ultimosDiasUteis, inicioMesesAtras, criarFila, janela,
};
