// Alertas operacionais (T08), somados aos alertas da T05 na mesma tabela e no mesmo painel.
// Tudo GET no Superlógica:
//  1. Pagamentos sem nota fiscal: despesas pagas nos últimos 60 dias sem arquivo com a
//     etiqueta "Doc. Fiscal" (um alerta por mês de pagamento, com a lista).
//  2. Manutenção periódica atrasada: último pagamento de dedetização, extintores, limpeza de
//     caixa d'água e manutenção de elevador no histórico de 19 meses; alerta quando passou do
//     prazo de referência. Sem nenhum pagamento no histórico não há alerta (não dá para afirmar).
//  3. Consumo fora do padrão: consumo/index (o Superlógica já calcula consumo do mês, média
//     dos meses anteriores e variação); alerta de alta forte e de queda forte por unidade.
// Cada alerta tem chave estável e detalhe.resumo (texto pronto para a tela).

const crypto = require('crypto');
const POR_PAGINA = 50;
const doisDig = (n) => String(n).padStart(2, '0');
const dataSL = (d) => doisDig(d.getMonth() + 1) + '/' + doisDig(d.getDate()) + '/' + d.getFullYear();
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const cent = (v) => Math.round(v * 100) / 100;
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const brl = (v) => 'R$ ' + cent(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
function dataDe(v) { // "MM/DD/AAAA ..." -> Date local
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null;
}
const br = (d) => d ? doisDig(d.getDate()) + '/' + doisDig(d.getMonth() + 1) + '/' + d.getFullYear() : '';
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// Pagamentos que normalmente não têm nota fiscal (folha, encargos, impostos, tarifas):
// ficam fora do alerta de nota fiscal. Comparação sem acento na descrição da conta.
const SEM_NF = /(salari|ferias|13o|13º|decimo|adiantamento|inss|fgts|darf|irrf|\biss\b|\bpis\b|cofins|csll|rescis|vale.?transporte|vale.?alimenta|vale.?refeic|cesta basica|tarifa|juros|multa|imposto|iof|pro.?labore|contribuicao (sindical|assistencial|confederativa)|encargos sociais|gratificac|hora extra|\bgps\b|esocial|pensao|seguro|taxa de lixo|iptu|devolu|reembolso|transferencia|aplicacao financeira|resgate)/;

// Manutenções periódicas. prazo_dias: prazo de referência (usual de mercado; a periodicidade
// real depende do contrato e da legislação municipal, por isso aparece no texto do alerta).
const MANUTENCOES = [
  { tipo: 'dedetizacao', nome: 'Dedetização', re: /(dedetiz|desinsetiz|descupiniz|desratiz|controle de pragas)/, prazo_dias: 180 },
  { tipo: 'extintores', nome: 'Recarga de extintores', re: /extintor/, prazo_dias: 365 },
  { tipo: 'caixa_dagua', nome: "Limpeza de caixa d'água", re: /((limpeza|higieniz|lavagem|manutencao)[^,]{0,30}(caixa d(e |.)?agua|reservatorio)|(caixa d(e |.)?agua|reservatorio)[^,]{0,30}(limpeza|higieniz|lavagem))/, prazo_dias: 180 },
  { tipo: 'elevador', nome: 'Manutenção de elevador', re: /(manutencao|contrato|conservacao)[^,]{0,30}elevador/, prazo_dias: 45 },
];
const TOLERANCIA_DIAS = 15;

// Consumo: alta forte = variação de 50% ou mais e pelo menos 1 unidade acima da média;
// queda forte = variação de 80% ou mais para baixo com média de pelo menos 1 (medidor parado
// ou leitura errada). O tipo de leitura vem do Superlógica (1 e 2); o nome fica "tipo N".
const CONSUMO_ALTA_PCT = 50, CONSUMO_ALTA_MIN = 1, CONSUMO_QUEDA_PCT = -80, CONSUMO_QUEDA_MEDIA_MIN = 1;

async function paginas(cliente, rota, params, max) {
  const out = [];
  for (let pg = 1; pg <= max; pg++) {
    const j = await cliente.get(rota, Object.assign({}, params, { itensPorPagina: POR_PAGINA, pagina: pg }));
    if (!Array.isArray(j) || !j.length) break;
    j.forEach((x) => out.push(x));
    if (j.length < POR_PAGINA) break;
    if (pg === max) out.cortado = true; // há mais páginas: quem chamou avisa em falhas
  }
  return out;
}
async function emParalelo(itens, n, fn) {
  const res = new Array(itens.length); let i = 0;
  async function trab() { while (i < itens.length) { const k = i++; res[k] = await fn(itens[k]); } }
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trab));
  return res;
}

// Despesas pagas mês a mês (filtro pela data do pagamento), 19 meses até hoje (extintor é anual:
// precisa enxergar além de 12 meses para dizer que atrasou).
async function pagasUltimosMeses(cliente, id, h) {
  const meses = [];
  for (let k = 18; k >= 0; k--) meses.push(new Date(h.getFullYear(), h.getMonth() - k, 1));
  const res = await emParalelo(meses, 2, (ini) => {
    const fim = new Date(ini.getFullYear(), ini.getMonth() + 1, 0);
    return paginas(cliente, 'despesas/index', { idCondominio: id, comStatus: 'liquidadas', filtrarpor: 'liquidacao', dtInicio: dataSL(ini), dtFim: dataSL(fim > h ? h : fim) }, 12);
  });
  const cortado = res.some((r) => r.cortado);
  // Guarda só o que as regras usam (o histórico inteiro pesaria na memória do servidor).
  const enxuto = [].concat(...res).filter((d) => String(d.fl_liquidado_pdes) === '1').map((d) => {
    const apro = Array.isArray(d.apropriacao) ? d.apropriacao : [];
    return {
      id: String(d.id_parcela_pdes || d.id_despesa_des || ''),
      dt_liquidacao_pdes: d.dt_liquidacao_pdes, vl_valor_pdes: d.vl_valor_pdes, st_nome_con: limpar(d.st_nome_con),
      conta: apro.map((a) => limpar(a.st_descricao_cont)).filter(Boolean).join(', '),
      texto: textoDespesa(d), nf: temNotaFiscal(d),
    };
  });
  enxuto.cortado = cortado;
  return enxuto;
}

function textoDespesa(d) {
  const apro = Array.isArray(d.apropriacao) ? d.apropriacao : [];
  // Só a conta e os complementos: o nome do fornecedor engana (empresa de dedetização que
  // também presta outro serviço contaria como dedetização).
  return semAcento([apro.map((a) => a.st_descricao_cont).join(' '), d.st_complemento_pdes, apro.map((a) => a.st_complemento_apro).join(' ')].join(' '));
}
function temNotaFiscal(d) {
  return (Array.isArray(d.arquivos) ? d.arquivos : []).some((a) =>
    String(a.fl_excluido_arq) !== '1' && (
      /doc\.?\s*fiscal/i.test(a.st_nomeabreviadoetiqueta_eti || '') ||
      (Array.isArray(a.etiquetas) ? a.etiquetas : []).some((e) => /doc\.?\s*fiscal/i.test(e.st_nomeabreviadoetiqueta_eti || ''))));
}

// Pagamentos do mês atual e dos dois meses anteriores (meses inteiros: o número de um mês não
// muda com o passar dos dias). A chave leva um resumo das parcelas: entrou pagamento novo sem
// nota no mesmo mês, o alerta volta mesmo que o anterior tenha sido marcado resolvido.
function alertasNotaFiscal(pagas, h) {
  const desde = new Date(h.getFullYear(), h.getMonth() - 2, 1);
  const porMes = new Map();
  pagas.forEach((d) => {
    const dl = dataDe(d.dt_liquidacao_pdes);
    if (!dl || dl < desde || dl > h) return;
    if (SEM_NF.test(semAcento(d.conta)) || d.nf) return;
    const k = dl.getFullYear() + doisDig(dl.getMonth() + 1);
    if (!porMes.has(k)) porMes.set(k, []);
    porMes.get(k).push({ id: d.id, fornecedor: d.st_nome_con || 'fornecedor', pago_em: br(dl), valor: cent(num(d.vl_valor_pdes)), descricao: d.conta });
  });
  return [...porMes].map(([k, itens]) => {
    itens.sort((a, b) => b.valor - a.valor);
    const total = cent(itens.reduce((s, x) => s + x.valor, 0));
    const mes = MESES[+k.slice(4) - 1] + '/' + k.slice(0, 4);
    const assinatura = crypto.createHash('sha1').update(itens.map((x) => x.id).sort().join(',')).digest('hex').slice(0, 10);
    return {
      chave: 'semnf:' + k + ':' + assinatura,
      tipo: 'sem_nota_fiscal',
      titulo: itens.length + ' pagamento' + (itens.length > 1 ? 's' : '') + ' de ' + mes + ' sem nota fiscal anexada',
      detalhe: {
        mes, quantidade: itens.length, total, itens: itens.slice(0, 30).map((x) => ({ fornecedor: x.fornecedor, pago_em: x.pago_em, valor: x.valor, descricao: x.descricao })),
        resumo: brl(total) + ' · ' + itens.slice(0, 3).map((x) => x.fornecedor + ' ' + brl(x.valor)).join(' · ') + (itens.length > 3 ? ' · e mais ' + (itens.length - 3) : ''),
      },
    };
  });
}

function alertasManutencao(pagas, h) {
  const out = [];
  MANUTENCOES.forEach((m) => {
    let ultima = null, ultimaD = null;
    pagas.forEach((d) => {
      if (!m.re.test(d.texto)) return;
      const dl = dataDe(d.dt_liquidacao_pdes);
      if (dl && (!ultima || dl > ultima)) { ultima = dl; ultimaD = d; }
    });
    if (!ultima) return; // sem histórico: não afirma nada
    const dias = Math.floor((h - ultima) / 86400000);
    if (dias <= m.prazo_dias + TOLERANCIA_DIAS) return;
    const meses = Math.round(m.prazo_dias / 30);
    out.push({
      chave: 'manut:' + m.tipo + ':' + ultima.getFullYear() + doisDig(ultima.getMonth() + 1) + doisDig(ultima.getDate()),
      tipo: 'manutencao_atrasada',
      titulo: m.nome + ' sem pagamento há ' + dias + ' dias',
      detalhe: {
        manutencao: m.nome, ultimo_pagamento: br(ultima), dias, prazo_referencia_dias: m.prazo_dias,
        fornecedor: ultimaD.st_nome_con, valor: cent(num(ultimaD.vl_valor_pdes)),
        resumo: 'último pagamento ' + br(ultima) + (ultimaD.st_nome_con ? ' (' + ultimaD.st_nome_con + ')' : '')
          + '; referência: a cada ' + (meses >= 2 ? meses + ' meses' : m.prazo_dias + ' dias') + ', conferir o contrato',
      },
    });
  });
  return out;
}

async function alertasConsumo(cliente, id, h) {
  const out = [];
  for (const tipo of [1, 2]) {
    // consumo/index devolve todas as unidades de uma vez (medido: 765 unidades sem paginação).
    // Erro 4xx = condomínio sem esse tipo de leitura: não é falha.
    let j = [];
    try { j = await cliente.get('consumo/index', { tipoLeitura: tipo, idCondominio: id, posicaoEm: dataSL(h) }); }
    catch (e) { if (e && e.status >= 400 && e.status < 500) j = []; else throw e; }
    (Array.isArray(j) ? j : []).forEach((u) => {
      if (!u || !u.id_unidade_uni) return;
      const lt = u.leituras || {};
      const c = lt.consumo || {};
      if (String(c.status) === '-1' || c.consumo_atual === undefined) return;
      const atual = num(c.consumo_atual), media = num(c.media), varp = num(c.variacao);
      const alta = varp >= CONSUMO_ALTA_PCT && atual - media >= CONSUMO_ALTA_MIN;
      const queda = varp <= CONSUMO_QUEDA_PCT && media >= CONSUMO_QUEDA_MEDIA_MIN;
      if (!alta && !queda) return;
      const ma = lt.mes_atual || {};
      const ref = (ma.nm_ano_rsp || h.getFullYear()) + doisDig(ma.nm_mes_rsp || (h.getMonth() + 1));
      const uni = limpar(u.st_unidade_uni) + (limpar(u.st_bloco_uni) ? ' ' + limpar(u.st_bloco_uni) : '');
      const fmt = (v) => String(Math.round(v * 100) / 100).replace('.', ',');
      out.push({
        chave: 'consumo:' + tipo + ':' + u.id_unidade_uni + ':' + ref,
        tipo: 'consumo_fora_padrao',
        titulo: 'Consumo ' + (alta ? 'muito acima' : 'muito abaixo') + ' da média na unidade ' + uni + ' (leitura tipo ' + tipo + ')',
        detalhe: {
          unidade: uni, tipo_leitura: tipo, mes: MESES[+ref.slice(4) - 1] + '/' + ref.slice(0, 4),
          consumo: atual, media: Math.round(media * 1000) / 1000, variacao_pct: varp, meses_media: num(c.meses),
          resumo: 'mês ' + fmt(atual) + ' contra média de ' + fmt(media) + ' (' + (varp > 0 ? 'alta' : 'queda') + ' de ' + String(Math.abs(varp)).replace('.', ',') + '%)'
            + (alta ? '; possível vazamento ou leitura errada' : '; possível medidor parado ou leitura errada'),
        },
      });
    });
  }
  return out;
}

// Cache do histórico de 19 meses por condomínio (muda pouco no dia). Guarda a leitura em
// andamento: duas abas abertas não leem o histórico duas vezes.
const _cacheHist = new Map(); // chave -> { ate, p }
function historico(cliente, id, h, forcar) {
  const chave = id + ':' + dataSL(h);
  const c = _cacheHist.get(chave);
  if (c && (c.ate > Date.now() || c.andamento) && !(forcar && !c.andamento)) return c.p;
  const p = pagasUltimosMeses(cliente, id, h);
  const reg = { ate: 0, p, andamento: true };
  _cacheHist.set(chave, reg);
  p.then(() => { reg.andamento = false; reg.ate = Date.now() + 3 * 3600 * 1000; },
         () => { if (_cacheHist.get(chave) === reg) _cacheHist.delete(chave); });
  if (_cacheHist.size > 200) _cacheHist.delete(_cacheHist.keys().next().value);
  return p;
}

// tetoMs: passado o tempo, devolve o que tiver (o histórico continua lendo em segundo plano e
// fica no cache para a próxima abertura); os alertas da T05 não esperam por ele.
async function calcularOperacionais(cliente, id, hoje, { forcar = false, tetoMs = 25000 } = {}) {
  const h = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const falhas = [];
  const ESGOTOU = {};
  let timer;
  const teto = new Promise((ok) => { timer = setTimeout(() => ok(ESGOTOU), tetoMs); });
  const [pagas, consumo] = await Promise.all([
    Promise.race([historico(cliente, id, h, forcar).catch(() => null), teto]),
    Promise.race([alertasConsumo(cliente, id, h).catch(() => null), teto]),
  ]);
  clearTimeout(timer);
  if (pagas === ESGOTOU) falhas.push('histórico de pagamentos ainda carregando (nota fiscal e manutenções); atualize em instantes');
  else if (pagas === null) falhas.push('histórico de pagamentos (nota fiscal e manutenções)');
  else if (pagas.cortado) falhas.push('histórico de pagamentos cortado (mês com despesas demais)');
  if (consumo === ESGOTOU || consumo === null) falhas.push('consumo');
  const ok = Array.isArray(pagas);
  const alertas = [].concat(ok ? alertasNotaFiscal(pagas, h) : [], ok ? alertasManutencao(pagas, h) : [], Array.isArray(consumo) ? consumo : []);
  return { alertas, falhas };
}

module.exports = { calcularOperacionais, alertasNotaFiscal, alertasManutencao, temNotaFiscal, SEM_NF, MANUTENCOES };
