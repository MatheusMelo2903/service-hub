// T39: avisos do financeiro, tudo dentro do Hub. Nada sai para e-mail ou WhatsApp: o envio para fora
// é um ponto de extensão desligado (financeiro/avisos-envio.js) até o Matheus escolher o canal.
// 1. Conta sem extrato importado: para cada condomínio e conta ativa, dias úteis desde o último extrato
//    importado no Superlógica (mesma leitura e mesma regra do quadro da T35, financeiro/conciliacao.js),
//    com limite configurável (padrão 2 dias úteis).
// 2. Resumo da manhã por carteira: contas sem extrato, pendências do pré balancete do mês anterior,
//    conciliação com diferença, boletos com alerta e vencidas sem baixa, ordenado por gravidade.
// 3. Erros por analista: alertas das regras da T25 cruzados com o usuário do Superlógica que lançou a
//    despesa (auditoria, como na T29) ou que fez a mexida (R9 e anexo removido).
// Só GET no Superlógica, por um cliente com teto de chamadas e no máximo 2 ao mesmo tempo.
'use strict';
const crypto = require('crypto');
const finPainel = require('./painel');
const finConciliacao = require('./conciliacao');
const finBoletos = require('./boletos');
const regras = require('./regras');
const envio = require('./avisos-envio');
const U = regras.util;
const C = finConciliacao.C;

const LIMITE_DIAS_PADRAO = 2;
const DIAS_AUDITORIA_ERROS = 5;      // dias úteis de auditoria lidos para saber quem lançou
const MAX_CHAMADAS_PADRAO = 4000;    // teto de chamadas ao Superlógica por geração
const SIMULTANEAS = 2;
const BLOCO_QUADRO = 80;             // limite do quadro da T35 por chamada
const MAX_ITENS_CARTEIRA = 400;
const MAX_ERROS = 3000;
const MAX_ERROS_USUARIO = 150;
const MAX_FALHAS = 60;
const INTERROMPIDA_MS = 90 * 60 * 1000; // geração agendada em andamento há mais que isso foi interrompida
const FORA = new Set([...U.IDS_EXCLUIDOS, U.ID_TESTE]);
const PESO = { alta: 3, media: 2, baixa: 1 };
const ORDEM_TIPO = { sem_extrato: 1, conciliacao: 2, pre_balancete: 3, vencidas: 4, boletos: 5 };
const USUARIOS_SISTEMA = regras.auditoria.USUARIOS_SISTEMA;
const NOMES_BOLETO = {
  valor_fora_padrao: 'valor fora do padrão', sem_boleto: 'unidade sem boleto', boleto_em_dobro: 'boleto em dobro',
  leitura_faltando: 'leitura faltando', leitura_zerada: 'leitura zerada', rateio_sumiu: 'rateio que sumiu',
  rateio_apareceu: 'rateio novo', parcela_repetida: 'parcela repetida',
};

function limiteDias(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : LIMITE_DIAS_PADRAO;
}
const doisDig = (n) => String(n).padStart(2, '0');
function mesAnterior(hoje) {
  let a = +hoje.slice(0, 4), m = +hoje.slice(5, 7) - 1;
  if (!m) { m = 12; a--; }
  return a + '-' + doisDig(m);
}
// Boletos: a partir do dia 15 confere o mês seguinte (o que está sendo preparado para enviar).
function competenciaBoletos(hoje) {
  let a = +hoje.slice(0, 4), m = +hoje.slice(5, 7);
  if (+hoje.slice(8, 10) >= 15) { m++; if (m > 12) { m = 1; a++; } }
  return a + '-' + doisDig(m);
}
const rotuloMes = (c) => String(c || '').slice(5, 7) + '/' + String(c || '').slice(0, 4);
const dataTexto = (iso) => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '');
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 160);
const plural = (n, um, varios) => n + ' ' + (n === 1 ? um : varios);
const centavos = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Cliente do Superlógica só com GET, teto de chamadas e no máximo SIMULTANEAS ao mesmo tempo
// (vale para a geração inteira, somando as filas dos módulos da T31, T35 e T27).
function clienteLimitado(base, max) {
  let usadas = 0, ativos = 0, recusadas = 0;
  const espera = [];
  const entrar = () => new Promise((ok) => { if (ativos < SIMULTANEAS) { ativos++; ok(); } else espera.push(ok); });
  const sair = () => { const prox = espera.shift(); if (prox) prox(); else ativos--; };
  return {
    get(action, params) {
      if (usadas >= max) {
        recusadas++;
        const e = new Error('limite_chamadas'); e.motivo = 'limite de chamadas da geração';
        return Promise.reject(e);
      }
      usadas++;
      return entrar().then(() => Promise.resolve().then(() => base.get(action, params)).finally(sair));
    },
    usadas: () => usadas,
    recusadas: () => recusadas,
  };
}

async function emLotes(lista, n, fn) {
  let i = 0;
  const trab = async () => { while (i < lista.length) { const k = i++; await fn(lista[k]); } };
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, trab));
}

// ── 1. contas sem extrato (a partir das linhas do quadro da T35) ──────────
function contasSemExtrato(linhas, limite) {
  const contas = [], falhas = [];
  for (const l of linhas || []) {
    // Mesma regra do quadro da T35 (maior_atraso_extrato): conta de pouco movimento que não é a
    // principal não conta atraso, salvo quando o condomínio não tem nenhuma conta movimentada.
    const comExtrato = (l.contas || []).filter((k) => k.situacao === 'ok' && k.quadro);
    const temMovimentada = comExtrato.some((k) => k.principal || !k.quadro.movimento_baixo);
    for (const k of l.contas || []) {
      const base = { id_condominio: String(l.id_condominio), condominio: txt(l.condominio, 100), conta: String(k.id),
        descricao: txt(k.descricao, 80), banco: txt(k.banco, 60), principal: !!k.principal };
      if (k.situacao === 'falha' || k.situacao === 'descartada') { falhas.push(base); continue; }
      if (k.situacao === 'ok' && k.quadro) {
        // Decisão do Matheus (21/10 15h43): toda conta entra na rotina de importação e gera alerta quando
        // o extrato não é importado. Conta de pouco movimento que não é a principal continua aparecendo,
        // só sem subir para alta.
        const d = k.quadro.dias_sem_extrato;
        if (d == null || d < limite) continue;
        const poucoMov = temMovimentada && k.quadro.movimento_baixo && !k.principal;
        contas.push(Object.assign(base, { ultimo_extrato: k.quadro.ultimo_extrato, dias_uteis: d, gravidade: (!poucoMov && d >= 2 * limite) ? 'alta' : 'media' }));
      } else if (k.situacao === 'sem_extrato') {
        // Conta ativa sem nenhum extrato importado nos últimos 75 dias (a T35 conta todas): alta na principal;
        // nas outras (poupança e fundos) média: a equipe passa a importar todas (decisão do Matheus 21/10 15h43).
        contas.push(Object.assign(base, { ultimo_extrato: null, dias_uteis: null, gravidade: k.principal ? 'alta' : 'media' }));
      }
    }
  }
  const dias = (c) => (c.dias_uteis == null ? 9999 : c.dias_uteis);
  contas.sort((a, b) => PESO[b.gravidade] - PESO[a.gravidade] || dias(b) - dias(a) || a.condominio.localeCompare(b.condominio));
  return { contas, falhas };
}

// ── 2. itens do resumo da manhã (um condomínio) ───────────────────────────
function itemSemExtrato(c, limite) {
  return {
    tipo: 'sem_extrato', gravidade: c.gravidade, id_condominio: c.id_condominio, condominio: c.condominio, conta: c.conta, dias: c.dias_uteis,
    titulo: 'Conta sem extrato importado ' + (c.dias_uteis == null ? 'nos últimos 75 dias' : 'há ' + plural(c.dias_uteis, 'dia útil', 'dias úteis')),
    detalhe: [c.descricao, c.banco].filter(Boolean).join(', ') + (c.ultimo_extrato ? '. Último extrato em ' + dataTexto(c.ultimo_extrato) : '') + '. Limite: ' + plural(limite, 'dia útil', 'dias úteis') + '.',
  };
}
function itensConciliacao(l) {
  const out = [];
  const id = String(l.id_condominio), nome = txt(l.condominio, 100);
  const ok = (l.contas || []).filter((k) => k.situacao === 'ok' && k.quadro);
  const dif = ok.filter((k) => Number(k.quadro.diferenca_saldo));
  if (dif.length) {
    out.push({
      tipo: 'conciliacao', gravidade: 'alta', id_condominio: id, condominio: nome, quantidade: dif.length,
      valor: centavos(dif.reduce((s, k) => s + Math.abs(Number(k.quadro.diferenca_saldo) || 0), 0)),
      titulo: 'Conciliação com diferença de saldo em ' + plural(dif.length, 'conta', 'contas'),
      detalhe: dif.slice(0, 5).map((k) => txt(k.descricao, 60) + ': ' + U.moeda(k.quadro.diferenca_saldo) + (k.quadro.data_saldo ? ' em ' + dataTexto(k.quadro.data_saldo) : '')).join('; '),
    });
  }
  const dias = ok.reduce((s, k) => s + (Number(k.quadro.dias_nao_conciliados) || 0), 0);
  if (dias) {
    out.push({
      tipo: 'conciliacao', gravidade: 'media', id_condominio: id, condominio: nome, quantidade: dias, dias,
      titulo: plural(dias, 'dia', 'dias') + ' com itens não conciliados',
      detalhe: 'Item do banco sem lançamento, lançamento sem saída no banco ou valor diferente nos últimos 75 dias.',
    });
  }
  return out;
}
function itemPreBalancete(id, nome, r) {
  if (!r || !r.pendencias) return null;
  const grupos = (r.grupos || []).filter((g) => g.bloqueiam);
  const alta = grupos.some((g) => (g.itens || []).some((i) => i.gravidade === 'alta'));
  return {
    tipo: 'pre_balancete', gravidade: alta ? 'alta' : 'media', id_condominio: id, condominio: nome || txt(r.nome, 100),
    quantidade: r.pendencias, competencia: r.competencia,
    titulo: 'Pré balancete de ' + rotuloMes(r.competencia) + ': ' + plural(r.pendencias, 'pendência', 'pendências'),
    detalhe: grupos.map((g) => g.bloqueiam + ' em ' + String(g.titulo || '').toLowerCase()).join('; '),
  };
}
function itemBoletos(id, nome, r) {
  const al = (r && r.alertas) || [];
  if (!al.length) return null;
  const tem = (g) => al.some((a) => a.gravidade === g);
  const porTipo = (r.resumo && r.resumo.alertas_por_tipo) || {};
  return {
    tipo: 'boletos', gravidade: tem('alta') ? 'alta' : (tem('media') ? 'media' : 'baixa'), id_condominio: id, condominio: nome,
    quantidade: al.length, competencia: r.competencia,
    titulo: 'Boletos de ' + rotuloMes(r.competencia) + ': ' + plural(al.length, 'alerta', 'alertas'),
    detalhe: Object.keys(porTipo).map((t) => porTipo[t] + ' ' + (NOMES_BOLETO[t] || t)).join('; '),
  };
}
function itemVencidas(id, nome, alertas) {
  const v = (alertas || []).filter((a) => a.tipo === 'R6_VENCIDA');
  if (!v.length) return null;
  const tem = (g) => v.some((a) => a.gravidade === g);
  const valor = centavos(v.reduce((s, a) => s + (Number(a.valor) || 0), 0));
  const maior = v.reduce((m, a) => Math.max(m, Number(a.dias_atraso) || 0), 0);
  return {
    tipo: 'vencidas', gravidade: tem('alta') ? 'alta' : (tem('media') ? 'media' : 'baixa'), id_condominio: id, condominio: nome,
    quantidade: v.length, valor, dias: maior,
    titulo: plural(v.length, 'conta vencida', 'contas vencidas') + ' sem baixa',
    detalhe: 'Total ' + U.moeda(valor) + (maior ? '. A mais antiga venceu há ' + plural(maior, 'dia', 'dias') + '.' : '.'),
  };
}
// Conta sem nenhum extrato nos 75 dias (dias null) é o pior atraso.
const diasOrdem = (i) => (i.tipo === 'sem_extrato' && i.dias == null ? 9999 : (i.dias || 0));
function ordenarItens(l) {
  return l.sort((a, b) => PESO[b.gravidade] - PESO[a.gravidade] || (ORDEM_TIPO[a.tipo] || 9) - (ORDEM_TIPO[b.tipo] || 9)
    || diasOrdem(b) - diasOrdem(a) || (b.valor || 0) - (a.valor || 0) || String(a.condominio).localeCompare(String(b.condominio)));
}
function totais(itens) {
  const t = { itens: itens.length, alta: 0, media: 0, baixa: 0, por_tipo: {} };
  itens.forEach((i) => { t[i.gravidade] = (t[i.gravidade] || 0) + 1; t.por_tipo[i.tipo] = (t.por_tipo[i.tipo] || 0) + 1; });
  return t;
}

// ── 3. erros por analista ─────────────────────────────────────────────────
const RX_CRIADA = /^Despesa#(\d+) criada/;
// Quem lançou cada despesa na janela da auditoria e os usuários vistos (fora os do sistema).
function quemLancou(linhas) {
  const criadores = new Map(), usuarios = new Map();
  for (const r of linhas || []) {
    const id = String(r.id_usuario_usu || '');
    const nome = txt(r.st_apelido_usu, 80);
    const t = String(r.st_texto_aud || '');
    if (!/^\d{1,12}$/.test(id) || !nome || USUARIOS_SISTEMA.has(id) || /^\[SUDO\]/.test(t)) continue;
    if (!usuarios.has(id)) usuarios.set(id, { id_usuario_sl: id, usuario: nome, lancamentos: 0, eventos: 0 });
    const u = usuarios.get(id);
    u.eventos++;
    const m = t.match(RX_CRIADA);
    if (m) { u.lancamentos++; criadores.set(m[1], { id_usuario_sl: id, usuario: nome, quando: U.data(r.dt_data_aud) || '' }); }
  }
  return { criadores, usuarios };
}
// Alerta da R9 e do anexo removido: o autor é quem fez a mexida. Os outros (duplicidade, condomínio
// trocado, sem nota, sem comprovante, tardio): quem lançou a despesa. Vencida sem baixa não é erro de
// lançamento (vai no resumo da carteira).
function errosPorUsuario(listasAlertas, criadores, usuarios) {
  const porNome = new Map();
  for (const u of usuarios.values()) porNome.set(U.norm(u.usuario), u);
  const out = [], vistos = new Set();
  let semUsuario = 0;
  for (const lista of listasAlertas) {
    for (const a of lista || []) {
      if (a.tipo === 'R6_VENCIDA') continue;
      let autor = null, papel = '';
      if (a.regra === 'R9' || a.tipo === 'R4_ANEXO_REMOVIDO') {
        const u = a.usuario ? porNome.get(U.norm(a.usuario)) : null;
        if (u) { autor = { id_usuario_sl: u.id_usuario_sl, usuario: u.usuario, quando: String(a.quando || '').slice(0, 10) }; papel = 'mexeu'; }
      } else {
        const c = criadores.get(String(a.id_despesa || ''));
        if (c) { autor = c; papel = 'lancou'; }
      }
      if (!autor) { semUsuario++; continue; }
      const k = [autor.id_usuario_sl, a.tipo, a.id_parcela || a.id_despesa, a.quando || ''].join('|');
      if (vistos.has(k)) continue;
      vistos.add(k);
      out.push(Object.assign({}, a, { id_usuario_sl: autor.id_usuario_sl, autor: autor.usuario, papel, data_autor: autor.quando || '' }));
    }
  }
  out.sort((a, b) => PESO[b.gravidade] - PESO[a.gravidade] || (Number(b.valor) || 0) - (Number(a.valor) || 0));
  // Teto por usuário (os mais graves primeiro), para todo analista receber a lista dele.
  const porUsuario = new Map();
  const ficam = out.filter((e) => { const n = (porUsuario.get(e.id_usuario_sl) || 0) + 1; porUsuario.set(e.id_usuario_sl, n); return n <= MAX_ERROS_USUARIO; });
  return { erros: ficam.slice(0, MAX_ERROS), sem_usuario: semUsuario, cortados: out.length - Math.min(ficam.length, MAX_ERROS) };
}

// ── geração do resumo do dia ──────────────────────────────────────────────
// deps: { cliente: cliente do Superlógica (get), grupos: () => Promise<carteiras>, hoje: 'AAAA-MM-DD', log }
// opcoes: { carteiras: [ids] | null, limiteDias, maxChamadas, diasAuditoria }
async function gerarResumo(deps, opcoes) {
  opcoes = opcoes || {};
  const hoje = deps.hoje;
  const log = deps.log || (() => {});
  const inicio = Date.now();
  const limite = limiteDias(opcoes.limiteDias);
  const cli = clienteLimitado(deps.cliente, opcoes.maxChamadas || MAX_CHAMADAS_PADRAO);
  const falhas = [];
  const anotar = (parte, e) => falhas.push(parte + ': ' + ((e && (e.motivo || e.message)) || 'falha'));

  const filtro = Array.isArray(opcoes.carteiras) && opcoes.carteiras.length ? new Set(opcoes.carteiras.map(Number)) : null;
  const grupos = ((await deps.grupos()) || []).filter((g) => g && g.id && (!filtro || filtro.has(Number(g.id))));
  if (filtro && !grupos.length) { const e = new Error('carteira_nao_encontrada'); e.codigo = 'carteira'; throw e; }

  // Alertas das regras da T25 (mesma base da aba Financeiro): vencidas sem baixa e erros por analista.
  const painel = finPainel.criarPainel({ cliente: () => cli, hoje: () => hoje, log: () => {} });
  let base = null;
  try { base = await painel.recalcular(); } catch (e) { anotar('alertas das regras', e); }
  log('alertas prontos (' + cli.usadas() + ' chamadas)');

  // Quem lançou: auditoria dos últimos dias úteis e de hoje, um dia por chamada (como a base da T31).
  // Vem logo depois dos alertas para não ficar sem cota de chamadas no fim (revisão 1, M7).
  const dias = finPainel.ultimosDiasUteis(hoje, opcoes.diasAuditoria || DIAS_AUDITORIA_ERROS).concat([hoje]);
  const filaAud = finPainel.criarFila(SIMULTANEAS);
  const linhasAud = [];
  for (const d of dias) {
    const f = [];
    const l = await finPainel.janela(cli, filaAud, 'auditoria/index', { idCondominio: -1 }, d, d, f);
    if (f.length) anotar('auditoria de ' + dataTexto(d), { motivo: f[0] });
    linhasAud.push(...finPainel.enxugarAuditoria(l));
  }
  const quem = quemLancou(linhasAud);
  const erros = base ? errosPorUsuario(base.porCondominio.values(), quem.criadores, quem.usuarios) : { erros: [], sem_usuario: 0, cortados: 0 };
  log('auditoria pronta (' + cli.usadas() + ' chamadas)');

  // Condomínios: os das carteiras; sem filtro, também os que aparecem nas despesas.
  const ids = new Set();
  grupos.forEach((g) => (g.condominios || []).forEach((c) => ids.add(String(c))));
  if (!filtro && base) for (const id of base.condominios.keys()) ids.add(String(id));
  FORA.forEach((x) => ids.delete(x));
  let lista = [...ids].filter((x) => /^\d{1,9}$/.test(x)).sort((a, b) => a - b);
  const nomes = new Map();
  if (base) for (const [id, c] of base.condominios) if (c.nome) nomes.set(String(id), c.nome);

  // Quadro da conciliação (T35): dias úteis sem extrato e diferença de saldo, por conta ativa.
  const conc = finConciliacao.criarConciliacao({ cliente: () => cli, hoje: () => hoje });
  const linhasQuadro = [];
  let quadroFalhou = false;
  for (let i = 0; i < lista.length; i += BLOCO_QUADRO) {
    try { const r = await conc.quadro(lista.slice(i, i + BLOCO_QUADRO)); linhasQuadro.push(...(r.condominios || [])); } catch (e) { quadroFalhou = true; anotar('extratos', e); }
  }
  linhasQuadro.forEach((l) => { if (l.condominio) nomes.set(String(l.id_condominio), txt(l.condominio, 100)); });
  // O quadro já tira os inativos no Superlógica: se leu tudo, só eles seguem.
  if (!quadroFalhou) { const ativos = new Set(linhasQuadro.map((l) => String(l.id_condominio))); lista = lista.filter((x) => ativos.has(x)); }
  const semExtrato = contasSemExtrato(linhasQuadro, limite);
  log('extratos prontos (' + cli.usadas() + ' chamadas)');

  // Pré balancete do mês anterior, por condomínio (até 4 condomínios na fila; o cliente segura em 2 chamadas).
  const compPre = mesAnterior(hoje);
  const pre = new Map();
  await emLotes(lista, 4, async (id) => {
    try { pre.set(id, await painel.preBalancete(id, compPre)); } catch (e) { anotar('pré balancete ' + id, e); }
  });
  log('pré balancetes prontos (' + cli.usadas() + ' chamadas)');

  // Boletos (T27), um condomínio por vez.
  const compBol = competenciaBoletos(hoje);
  const bol = new Map();
  for (const id of lista) {
    try { bol.set(id, await finBoletos.conferirBoletos(cli, id, compBol)); } catch (e) { anotar('boletos ' + id, e); }
  }
  log('boletos prontos (' + cli.usadas() + ' chamadas)');


  // Itens por condomínio.
  const porCond = new Map();
  const add = (id, it) => { if (!it) return; if (!it.condominio) it.condominio = nomes.get(id) || ''; if (!porCond.has(id)) porCond.set(id, []); porCond.get(id).push(it); };
  const naLista = new Set(lista);
  semExtrato.contas.forEach((c) => { if (naLista.has(c.id_condominio)) add(c.id_condominio, itemSemExtrato(c, limite)); });
  linhasQuadro.forEach((l) => { if (naLista.has(String(l.id_condominio))) itensConciliacao(l).forEach((it) => add(String(l.id_condominio), it)); });
  for (const id of lista) {
    const nome = nomes.get(id) || '';
    add(id, itemPreBalancete(id, nome, pre.get(id)));
    add(id, itemBoletos(id, nome, bol.get(id)));
    add(id, itemVencidas(id, nome, base ? base.porCondominio.get(id) : null));
  }

  const montar = (extra, conds) => {
    const itens = ordenarItens([].concat(...conds.map((x) => porCond.get(x) || [])));
    return Object.assign(extra, { condominios: conds.length, totais: totais(itens), itens: itens.slice(0, MAX_ITENS_CARTEIRA), cortados: Math.max(0, itens.length - MAX_ITENS_CARTEIRA) });
  };
  const noGrupo = new Set();
  const carteiras = grupos.map((g) => {
    const conds = [...new Set((g.condominios || []).map(String))].filter((x) => naLista.has(x));
    conds.forEach((x) => noGrupo.add(x));
    return montar({ id: Number(g.id), nome: txt(g.nome, 80), tipo: txt(g.tipo, 20), gerente: txt(g.gerente, 80) }, conds);
  });
  const semCarteira = filtro ? null : montar({ nome: 'Condomínios fora de carteira' }, lista.filter((x) => !noGrupo.has(x)));

  const geral = {
    dia: hoje, gerado_em: new Date().toISOString(), limite_dias: limite, parcial: !!filtro,
    carteiras_pedidas: filtro ? [...filtro] : null,
    competencias: { pre_balancete: compPre, boletos: compBol }, auditoria_dias: dias,
    condominios: lista.length, contas_sem_extrato: semExtrato.contas.length, contas_com_falha: semExtrato.falhas.length,
    chamadas: cli.usadas(), chamadas_recusadas: cli.recusadas(), duracao_s: Math.round((Date.now() - inicio) / 1000),
    erros: erros.erros, erros_sem_usuario: erros.sem_usuario, erros_cortados: erros.cortados,
    usuarios: [...quem.usuarios.values()].sort((a, b) => b.lancamentos - a.lancamentos || b.eventos - a.eventos),
    alertas_base: base ? base.totais : null,
    falhas: falhas.slice(0, MAX_FALHAS), falhas_total: falhas.length,
  };
  return { geral, carteiras, sem_carteira: semCarteira };
}

// Linhas da tabela fin_avisos: "geral", uma por carteira e "sem_carteira" (só na geração completa).
function linhasParaGravar(r, origem) {
  const dia = r.geral.dia, gerado_em = r.geral.gerado_em;
  const linhas = [{ dia, chave: 'geral', origem, gerado_em, conteudo: r.geral }];
  r.carteiras.forEach((c) => linhas.push({ dia, chave: 'carteira:' + c.id, origem, gerado_em, conteudo: c }));
  if (r.sem_carteira) linhas.push({ dia, chave: 'sem_carteira', origem, gerado_em, conteudo: r.sem_carteira });
  return linhas;
}

// ── agendamento interno: uma vez por dia útil a partir das 7h (America/Sao_Paulo) ──
function agoraSP(d) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d || new Date()).forEach((x) => { p[x.type] = x.value; });
  return { dia: p.year + '-' + p.month + '-' + p.day, hora: Number(p.hour), minuto: Number(p.minute) };
}
// Se o servidor subir depois das 7h, ainda gera até o meio dia. A trava do dia fica também no banco
// (índice único da geração agendada), para um reinício não gerar duas vezes.
function criarAgendador(o) {
  const hora = o.hora == null ? 7 : o.hora, ate = o.ate == null ? 12 : o.ate;
  const agora = o.agora || agoraSP;
  const ehDiaUtil = o.diaUtil || C.diaUtil;
  let ultimo = null, timer = null;
  async function verificar() {
    const a = agora();
    if (a.hora < hora || a.hora >= ate || ultimo === a.dia) return false;
    ultimo = a.dia;
    if (!o.fimDeSemana && !ehDiaUtil(a.dia)) return false;
    try { await o.executar(a.dia); } catch (e) {
      // Outra geração rodando ou banco fora do ar: tenta de novo no minuto seguinte (revisão 1, M2 e M3).
      if (e && (e.codigo === 'andamento' || e.codigo === 'banco')) { ultimo = null; return false; }
      if (o.log) o.log('[avisos] geração agendada falhou: ' + (e && e.message));
    }
    return true;
  }
  return {
    verificar,
    iniciar(ms) {
      if (timer) return;
      timer = setInterval(() => { verificar().catch(() => {}); }, ms || 60000);
      if (timer.unref) timer.unref();
    },
    parar() { if (timer) clearInterval(timer); timer = null; },
    ultimo: () => ultimo,
  };
}

// ── serviço: uma geração por vez, grava no Supabase de teste ──────────────
// banco: financeiro/banco.js (recusa gravar fora do Supabase de teste). cliente: () => cliente do Superlógica.
function criarServico(o) {
  const log = o.log || ((m) => console.log(m));
  const hoje = o.hoje || U.hojeSP;
  const esperaSobDemanda = o.esperaSobDemanda == null ? 10 * 60 * 1000 : o.esperaSobDemanda;
  let rodando = null, ultimaSobDemanda = 0;
  const atualizar = (id, campos) => o.banco.upsert('fin_avisos_execucoes', [Object.assign({ id }, campos)], 'id')
    .catch((e) => log('[avisos] não registrou a execução ' + id + ': ' + (e && e.message)));

  // p: { origem: 'agendado' | 'sob_demanda' | 'teste', usuario, carteiras, limiteDias, dia }.
  // Devolve { execucao, promessa } ou null (geração agendada do dia já registrada).
  async function iniciar(p) {
    p = p || {};
    const origem = p.origem;
    if (rodando) { const e = new Error('geracao_em_andamento'); e.codigo = 'andamento'; throw e; }
    const falta = esperaSobDemanda - (Date.now() - ultimaSobDemanda);
    if (origem === 'sob_demanda' && falta > 0) { const e = new Error('aguarde'); e.codigo = 'aguarde'; e.espera_s = Math.ceil(falta / 1000); throw e; }
    const dia = p.dia || hoje();
    let id = crypto.randomUUID();
    rodando = { execucao: id, origem, dia, desde: new Date().toISOString() };
    const parametros = { carteiras: p.carteiras || null, limite_dias: limiteDias(p.limiteDias) };
    const registrar = () => o.banco.inserir('fin_avisos_execucoes', { id, dia, origem, status: 'andamento', usuario: p.usuario || null, parametros }).catch(() => false);
    let ok = await registrar();
    if (!ok && origem === 'agendado') {
      // O índice único do dia recusou (já registrada) ou o banco falhou: confere qual dos dois (revisão 1, M3 e M4).
      let atual = null;
      try {
        const l = await o.banco.ler('fin_avisos_execucoes?select=id,status,iniciado_em&origem=eq.agendado&dia=eq.' + dia + '&limit=1');
        atual = Array.isArray(l) ? (l[0] || false) : null;
      } catch (e) { atual = null; }
      if (atual && atual.status !== 'andamento') { rodando = null; log('[avisos] geração agendada de ' + dia + ' já registrada (' + atual.status + ')'); return null; }
      if (atual && Date.now() - Date.parse(atual.iniciado_em) > INTERROMPIDA_MS) {
        // Servidor reiniciou no meio da geração: esta retoma a mesma linha do dia (o índice único fica valendo).
        try {
          await o.banco.upsert('fin_avisos_execucoes', [{ id: atual.id, dia, origem, status: 'andamento', iniciado_em: new Date().toISOString(), parametros, resumo: { retomada: true } }], 'id');
          id = atual.id; rodando.execucao = id; ok = true;
        } catch (e) { ok = false; }
      } else if (atual) {
        rodando = null;
        const e = new Error('geracao_em_andamento'); e.codigo = 'andamento'; throw e;
      }
    }
    if (!ok) { rodando = null; const e = new Error('banco_indisponivel'); e.codigo = 'banco'; throw e; }
    if (origem === 'sob_demanda') ultimaSobDemanda = Date.now();
    const promessa = (async () => {
      try {
        const r = await gerarResumo({ cliente: o.cliente(), grupos: o.grupos, hoje: dia, log: (m) => log('[avisos] ' + m) },
          { carteiras: p.carteiras, limiteDias: p.limiteDias, maxChamadas: o.maxChamadas });
        let linhas = linhasParaGravar(r, origem);
        if (r.geral.parcial) linhas = await mesclarParcial(dia, linhas);
        await o.banco.upsert('fin_avisos', linhas, 'dia,chave');
        // Envio para fora: ponto de extensão desligado até o Matheus escolher o canal.
        const env = await envio.enviarResumo(r).catch(() => ({ enviado: false, motivo: 'falha' }));
        const g = r.geral;
        await atualizar(id, { dia, origem, status: 'ok', terminado_em: new Date().toISOString(), resumo: {
          condominios: g.condominios, carteiras: r.carteiras.length, contas_sem_extrato: g.contas_sem_extrato, erros: g.erros.length,
          chamadas: g.chamadas, chamadas_recusadas: g.chamadas_recusadas, duracao_s: g.duracao_s, falhas: g.falhas_total, envio: env } });
        return r;
      } catch (e) {
        await atualizar(id, { dia, origem, status: 'erro', terminado_em: new Date().toISOString(), resumo: { erro: String((e && (e.codigo || e.message)) || 'falha').slice(0, 120) } });
        throw e;
      } finally { rodando = null; }
    })();
    promessa.catch((e) => log('[avisos] geração ' + id + ' falhou: ' + (e && e.message)));
    return { execucao: id, promessa };
  }

  // Geração de só algumas carteiras não apaga a linha "geral" completa do dia (revisão 1, M5): mantém o
  // resumo dela e só troca os erros e os usuários (que valem para todos). Sem conseguir ler, não grava a geral.
  async function mesclarParcial(dia, linhas) {
    let atual = null;
    try { atual = (await lerDia(dia, ['geral']))[0] || false; } catch (e) { atual = null; }
    if (atual === null) return linhas.filter((l) => l.chave !== 'geral');
    if (!atual || !atual.conteudo || atual.conteudo.parcial) return linhas;
    return linhas.map((l) => {
      if (l.chave !== 'geral') return l;
      const g = l.conteudo;
      const conteudo = Object.assign({}, atual.conteudo, {
        erros: g.erros, erros_sem_usuario: g.erros_sem_usuario, erros_cortados: g.erros_cortados, usuarios: g.usuarios,
        ultima_parcial: { gerado_em: g.gerado_em, carteiras: g.carteiras_pedidas, condominios: g.condominios, chamadas: g.chamadas, falhas_total: g.falhas_total },
      });
      return { dia, chave: 'geral', origem: atual.origem || l.origem, gerado_em: atual.gerado_em || l.gerado_em, conteudo };
    });
  }

  const diaOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  async function ultimoDia() {
    const l = await o.banco.ler('fin_avisos?select=dia&chave=eq.geral&order=dia.desc&limit=1');
    return Array.isArray(l) && l[0] && diaOk(l[0].dia) ? l[0].dia : null;
  }
  // chaves: null = todas do dia; senão lista ('geral', 'carteira:12').
  async function lerDia(dia, chaves) {
    if (!diaOk(dia)) return [];
    let q = 'fin_avisos?select=chave,gerado_em,origem,conteudo&dia=eq.' + dia;
    if (chaves) {
      const ok = chaves.filter((c) => /^(geral|sem_carteira|carteira:[0-9]{1,9})$/.test(c));
      if (!ok.length) return [];
      q += '&chave=in.(' + ok.map((c) => encodeURIComponent('"' + c + '"')).join(',') + ')';
    }
    const l = await o.banco.ler(q);
    return Array.isArray(l) ? l : [];
  }
  // Última linha de cada chave nos últimos 7 dias: carteira que não entrou na geração de hoje mostra a
  // última que existir dela (revisão 1, M5). Primeiro lê só dia e chave; depois o conteúdo de cada dia.
  async function lerRecentes(chaves) {
    let q = 'fin_avisos?select=dia,chave&dia=gte.' + U.maisDias(hoje(), -7) + '&order=dia.desc&limit=500';
    if (chaves) {
      const okc = chaves.filter((c) => /^(geral|sem_carteira|carteira:[0-9]{1,9})$/.test(c));
      if (!okc.length) return [];
      q += '&chave=in.(' + okc.map((c) => encodeURIComponent('"' + c + '"')).join(',') + ')';
    }
    const l = await o.banco.ler(q);
    const porDia = new Map(), vistas = new Set();
    for (const x of Array.isArray(l) ? l : []) {
      if (!diaOk(x.dia) || vistas.has(x.chave)) continue;
      vistas.add(x.chave);
      if (!porDia.has(x.dia)) porDia.set(x.dia, []);
      porDia.get(x.dia).push(x.chave);
    }
    const out = [];
    for (const [dia, cs] of porDia) (await lerDia(dia, cs)).forEach((x) => out.push(Object.assign({ dia }, x)));
    return out;
  }
  const execucoes = () => o.banco.ler('fin_avisos_execucoes?select=id,dia,origem,status,iniciado_em,terminado_em,parametros,resumo&order=iniciado_em.desc&limit=10');
  const vinculos = () => o.banco.ler('fin_usuarios_superlogica?select=id_usuario_sl,apelido,profile_id,carteira,atualizado_em&order=apelido.asc&limit=1000');
  const vinculosDe = (profileId) => o.banco.ler('fin_usuarios_superlogica?select=id_usuario_sl,profile_id&profile_id=eq.' + encodeURIComponent(String(profileId || '')) + '&limit=100');
  const salvarVinculo = (v) => o.banco.upsert('fin_usuarios_superlogica', [v], 'id_usuario_sl');
  return { iniciar, situacao: () => (rodando ? Object.assign({}, rodando) : null), ultimoDia, lerDia, lerRecentes, execucoes, vinculos, vinculosDe, salvarVinculo };
}

// Para quem só vê a própria carteira: alerta de condomínio trocado (R2) sem os dados do outro condomínio.
const semOutroCondominio = finPainel.semOutroCondominio;

module.exports = {
  gerarResumo, criarServico, criarAgendador, linhasParaGravar, agoraSP, semOutroCondominio,
  limiteDias, mesAnterior, competenciaBoletos, LIMITE_DIAS_PADRAO, FORA,
  // para teste
  clienteLimitado, contasSemExtrato, itemSemExtrato, itensConciliacao, itemPreBalancete, itemBoletos, itemVencidas,
  ordenarItens, totais, quemLancou, errosPorUsuario,
};
