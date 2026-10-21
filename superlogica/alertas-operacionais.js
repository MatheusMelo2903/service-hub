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
const SEM_NF = /(salari|ferias|13o|13º|decimo|adiantamento|inss|fgts|darf|irrf|\biss\b|\bpis\b|cofins|csll|rescis|vale.?transporte|vale.?alimenta|cesta basica|tarifa|juros|multa|imposto|iof|pro.?labore|contribuicao sindical|seguro|taxa de lixo|iptu|devolu|reembolso|transferencia|aplicacao|resgate)/;

// Manutenções periódicas. prazo_dias: prazo de referência (usual de mercado; a periodicidade
// real depende do contrato e da legislação municipal, por isso aparece no texto do alerta).
const MANUTENCOES = [
  { tipo: 'dedetizacao', nome: 'Dedetização', re: /(dedetiz|desinsetiz|descupiniz|desratiz|controle de pragas)/, prazo_dias: 180 },
  { tipo: 'extintores', nome: 'Recarga de extintores', re: /extintor/, prazo_dias: 365 },
  { tipo: 'caixa_dagua', nome: "Limpeza de caixa d'água", re: /(caixa d.?agua|reservatorio)/, prazo_dias: 180 },
  { tipo: 'elevador', nome: 'Manutenção de elevador', re: /elevador/, prazo_dias: 45 },
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
  const res = await emParalelo(meses, 4, (ini) => {
    const fim = new Date(ini.getFullYear(), ini.getMonth() + 1, 0);
    return paginas(cliente, 'despesas/index', { idCondominio: id, comStatus: 'liquidadas', filtrarpor: 'liquidacao', dtInicio: dataSL(ini), dtFim: dataSL(fim > h ? h : fim) }, 12);
  });
  return [].concat(...res).filter((d) => String(d.fl_liquidado_pdes) === '1');
}

function textoDespesa(d) {
  const apro = Array.isArray(d.apropriacao) ? d.apropriacao : [];
  // Só a conta e os complementos: o nome do fornecedor engana (empresa de dedetização que
  // também presta outro serviço contaria como dedetização).
  return semAcento([apro.map((a) => a.st_descricao_cont).join(' '), d.st_complemento_pdes, apro.map((a) => a.st_complemento_apro).join(' ')].join(' '));
}
function temNotaFiscal(d) {
  return (Array.isArray(d.arquivos) ? d.arquivos : []).some((a) =>
    !limpar(a.fl_excluido_arq) && (
      /doc\.?\s*fiscal/i.test(a.st_nomeabreviadoetiqueta_eti || '') ||
      (Array.isArray(a.etiquetas) ? a.etiquetas : []).some((e) => /doc\.?\s*fiscal/i.test(e.st_nomeabreviadoetiqueta_eti || ''))));
}

function alertasNotaFiscal(pagas, h) {
  const desde = new Date(h); desde.setDate(h.getDate() - 60);
  const porMes = new Map();
  pagas.forEach((d) => {
    const dl = dataDe(d.dt_liquidacao_pdes);
    if (!dl || dl < desde || dl > h) return;
    const apro = Array.isArray(d.apropriacao) ? d.apropriacao : [];
    const descConta = semAcento(apro.map((a) => a.st_descricao_cont).join(' '));
    if (SEM_NF.test(descConta) || temNotaFiscal(d)) return;
    const k = dl.getFullYear() + doisDig(dl.getMonth() + 1);
    if (!porMes.has(k)) porMes.set(k, []);
    porMes.get(k).push({
      fornecedor: limpar(d.st_nome_con) || 'fornecedor', pago_em: br(dl), valor: cent(num(d.vl_valor_pdes)),
      descricao: apro.map((a) => limpar(a.st_descricao_cont)).filter(Boolean).join(', '),
    });
  });
  return [...porMes].map(([k, itens]) => {
    itens.sort((a, b) => b.valor - a.valor);
    const total = cent(itens.reduce((s, x) => s + x.valor, 0));
    const mes = MESES[+k.slice(4) - 1] + '/' + k.slice(0, 4);
    return {
      chave: 'semnf:' + k,
      tipo: 'sem_nota_fiscal',
      titulo: itens.length + ' pagamento' + (itens.length > 1 ? 's' : '') + ' de ' + mes + ' sem nota fiscal anexada',
      detalhe: {
        mes, quantidade: itens.length, total, itens: itens.slice(0, 30),
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
      if (!m.re.test(textoDespesa(d))) return;
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
        fornecedor: limpar(ultimaD.st_nome_con), valor: cent(num(ultimaD.vl_valor_pdes)),
        resumo: 'último pagamento ' + br(ultima) + (limpar(ultimaD.st_nome_con) ? ' (' + limpar(ultimaD.st_nome_con) + ')' : '')
          + '; referência: a cada ' + (meses >= 2 ? meses + ' meses' : m.prazo_dias + ' dias') + ', conferir o contrato',
      },
    });
  });
  return out;
}

async function alertasConsumo(cliente, id, h) {
  const out = [];
  for (const tipo of [1, 2]) {
    const j = await cliente.get('consumo/index', { tipoLeitura: tipo, idCondominio: id, posicaoEm: dataSL(h) });
    (Array.isArray(j) ? j : []).forEach((u) => {
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
          resumo: 'mês ' + fmt(atual) + ' contra média de ' + fmt(media) + ' (' + (varp > 0 ? '+' : '') + String(varp).replace('.', ',') + '%)'
            + (alta ? '; possível vazamento ou leitura errada' : '; possível medidor parado ou leitura errada'),
        },
      });
    });
  }
  return out;
}

// Cache do histórico de 19 meses por condomínio (muda pouco no dia).
const _cacheHist = new Map();
async function calcularOperacionais(cliente, id, hoje) {
  const h = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const falhas = [];
  const chave = id + ':' + dataSL(h);
  let pagas = null;
  const c = _cacheHist.get(chave);
  if (c && c.ate > Date.now()) pagas = c.v;
  else {
    try {
      pagas = await pagasUltimosMeses(cliente, id, h);
      _cacheHist.set(chave, { ate: Date.now() + 3 * 3600 * 1000, v: pagas });
      if (_cacheHist.size > 200) _cacheHist.delete(_cacheHist.keys().next().value);
    } catch (e) { falhas.push('histórico de pagamentos (nota fiscal e manutenções)'); }
  }
  let consumo = [];
  try { consumo = await alertasConsumo(cliente, id, h); } catch (e) { falhas.push('consumo'); }
  const alertas = [].concat(pagas ? alertasNotaFiscal(pagas, h) : [], pagas ? alertasManutencao(pagas, h) : [], consumo);
  return { alertas, falhas };
}

module.exports = { calcularOperacionais, alertasNotaFiscal, alertasManutencao, temNotaFiscal, SEM_NF, MANUTENCOES };
