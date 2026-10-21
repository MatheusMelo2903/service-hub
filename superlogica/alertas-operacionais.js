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

// Contas de água e luz (T18): a própria conta da concessionária é o documento fiscal, então
// não entram no alerta de "pagamento sem nota fiscal". Critério (sem acento, minúsculas):
//  a) fornecedor é concessionária conhecida de água ou energia (CESAN, EDP, ESCELSA e as
//     principais do país) ou tem "distribuição de energia" / "companhia ... de saneamento" /
//     "serviço autônomo de água" no nome; OU
//  b) TODAS as contas do plano de contas da despesa são de consumo puro de água, esgoto ou
//     energia ("Energia", "Esgoto", "Água-Esgoto", "Água e Esgoto", "Energia Elétrica", "Luz").
// A conta tem que ser exatamente de consumo: "Energia Solar" (financiamento), "Contrato
// Manutenção e Análise de Água-Poço", "Material de Bomba de Água", "Serviço Elétrico" e
// "Manutenção de Caixa d'água" continuam no alerta. Gás (ex.: Supergasbras) continua, porque
// o pedido foi só água e luz. "Saneamento" sozinho no fornecedor não vale (há empresas de
// "saneamento ambiental" que prestam serviço e emitem nota).
const RE_FORNECEDOR_CONCESSIONARIA = /\b(cesan|edp|escelsa|sabesp|copasa|cedae|embasa|sanepar|compesa|cagece|caesb|casan|corsan|saae|cemig|copel|celesc|coelba|cosern|celpe|energisa|neoenergia|enel)\b|distribuicao de energia|companhia [a-z ]*de saneamento|servico autonomo de agua/;
const RE_CONTA_CONSUMO = /^(conta (de )?)?(agua|esgoto|agua e esgoto|agua esgoto|saneamento|energia|energia eletrica|luz|energia e luz)( (comum|predial|condominio|do condominio|area comum|geral))?$/;
const normConta = (s) => semAcento(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function ehContaConcessionaria(d) {
  if (RE_FORNECEDOR_CONCESSIONARIA.test(normConta(d.st_nome_con))) return true;
  const contas = (Array.isArray(d.contas) ? d.contas : []).map(normConta).filter(Boolean);
  return contas.length > 0 && contas.every((c) => RE_CONTA_CONSUMO.test(c));
}

// Manutenções periódicas. prazo_dias: prazo padrão (confirmado pelo Matheus em 21/10/2026).
// O prazo usado no cálculo vem do banco (T18, superlogica/prazos-manutencao.js); este é só o
// padrão quando o banco não tem valor. A periodicidade real depende do contrato e da
// legislação municipal, por isso o texto do alerta pede para conferir o contrato.
const MANUTENCOES = [
  { tipo: 'dedetizacao', nome: 'Dedetização', re: /(dedetiz|desinsetiz|descupiniz|desratiz|controle de pragas)/, prazo_dias: 180 },
  { tipo: 'extintores', nome: 'Recarga de extintores', re: /extintor/, prazo_dias: 365 },
  { tipo: 'caixa_dagua', nome: "Limpeza de caixa d'água", re: /((limpeza|higieniz|lavagem|manutencao)[^,]{0,30}(caixa d(e |.)?agua|reservatorio)|(caixa d(e |.)?agua|reservatorio)[^,]{0,30}(limpeza|higieniz|lavagem))/, prazo_dias: 180 },
  { tipo: 'elevador', nome: 'Manutenção de elevador', re: /(manutencao|contrato|conservacao)[^,]{0,30}elevador/, prazo_dias: 45 },
];
const TOLERANCIA_DIAS = 15;

// Consumo: alta forte = variação de 50% ou mais e pelo menos 1 unidade acima da média;
// queda forte = variação de 80% ou mais para baixo com média de pelo menos 1 (medidor parado
// ou leitura errada). O tipo de leitura vem do Superlógica (1 e 2); o nome (Água, Gás...) é
// descoberto por condomínio em nomeTipoLeitura (T18).
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
      contas: apro.map((a) => limpar(a.st_descricao_cont)).filter(Boolean),
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
    if (SEM_NF.test(semAcento(d.conta)) || d.nf || ehContaConcessionaria(d)) return;
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

function alertasManutencao(pagas, h, prazos) {
  const out = [];
  MANUTENCOES.forEach((m0) => {
    const p = prazos && Number(prazos[m0.tipo]);
    const m = Object.assign({}, m0, { prazo_dias: Number.isInteger(p) && p > 0 ? p : m0.prazo_dias });
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

// Nome do tipo de leitura (T18). O consumo/index não traz o nome do tipo (só id_tipo_rec), mas
// cada leitura cobrada aponta para a receita lançada no boleto (leituras.mes_atual/mes_anterior
// .receita[].id_receita_rec e o recebimento em receita_apropriacao[].id_recebimento_recb). A
// conta do plano de contas dessa receita (cobranca/index com comDadosDasContasEReceitas) diz o
// que é: "Gás", "Água Individual", "Energia"... Conferido em 21/10/2026 em 3 condomínios
// (Aldeia Manguinhos 2, 8 e 10): tipo 1 = conta 1.6 Gás, tipo 2 = conta 1.8 Água Individual.
// Não há número fixo no código: cada condomínio é lido. Sem receita para conferir, o nome fica
// "consumo (tipo N)". Cache de 24 h por condomínio e tipo.
const _cacheNomeTipo = new Map(); // id:tipo -> { ate, nome }
function nomeDaConta(desc) {
  const s = semAcento(desc);
  if (/\bgas\b/.test(s)) return 'Gás';
  if (/agua|esgoto/.test(s)) return 'Água';
  if (/energia|\bluz\b/.test(s)) return 'Energia';
  return limpar(desc) || null;
}
function receitaDaLeitura(unidades) {
  for (const u of unidades) {
    const lt = (u && u.leituras) || {};
    for (const mes of [lt.mes_atual, lt.mes_anterior]) {
      for (const r of ((mes && mes.receita) || [])) {
        const ap = Array.isArray(r.receita_apropriacao) ? r.receita_apropriacao : [];
        const recb = ap.map((a) => a && a.id_recebimento_recb).find((x) => /^\d+$/.test(String(x || '')));
        if (recb && /^\d+$/.test(String(r.id_receita_rec || ''))) return { recb: String(recb), receita: String(r.id_receita_rec) };
      }
    }
  }
  return null;
}
function acharConta(o, idReceita, prof) {
  if (!o || typeof o !== 'object' || prof > 8) return null;
  if (String(o.id_receita_rec) === idReceita && o.st_descricao_cont) return String(o.st_descricao_cont);
  for (const v of Object.values(o)) { const r = acharConta(v, idReceita, prof + 1); if (r) return r; }
  return null;
}
async function nomeTipoLeitura(cliente, id, tipo, unidades) {
  const chave = id + ':' + tipo;
  const c = _cacheNomeTipo.get(chave);
  if (c && c.ate > Date.now()) return c.nome;
  let nome = null;
  const ref = receitaDaLeitura(unidades);
  if (ref) {
    try {
      const j = await cliente.get('cobranca/index', { idCondominio: id, id: ref.recb, comDadosDasApropriacoes: 1, comDadosDasContasEReceitas: 1 });
      const desc = acharConta(j, ref.receita, 0);
      nome = desc ? nomeDaConta(desc) : null;
    } catch (e) { nome = null; }
  }
  // Só guarda o que achou (falha de leitura tenta de novo na próxima).
  if (nome) {
    _cacheNomeTipo.set(chave, { ate: Date.now() + 24 * 3600 * 1000, nome });
    if (_cacheNomeTipo.size > 1000) _cacheNomeTipo.delete(_cacheNomeTipo.keys().next().value);
  }
  return nome;
}

async function alertasConsumo(cliente, id, h) {
  const out = [];
  for (const tipo of [1, 2]) {
    // consumo/index devolve todas as unidades de uma vez (medido: 765 unidades sem paginação).
    // Erro 4xx = condomínio sem esse tipo de leitura: não é falha.
    let j = [];
    try { j = await cliente.get('consumo/index', { tipoLeitura: tipo, idCondominio: id, posicaoEm: dataSL(h) }); }
    catch (e) { if (e && e.status >= 400 && e.status < 500) j = []; else throw e; }
    const doTipo = [];
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
      doTipo.push({
        chave: 'consumo:' + tipo + ':' + u.id_unidade_uni + ':' + ref,
        tipo: 'consumo_fora_padrao',
        _alta: alta, _uni: uni,
        detalhe: {
          unidade: uni, tipo_leitura: tipo, mes: MESES[+ref.slice(4) - 1] + '/' + ref.slice(0, 4),
          consumo: atual, media: Math.round(media * 1000) / 1000, variacao_pct: varp, meses_media: num(c.meses),
          resumo: 'mês ' + fmt(atual) + ' contra média de ' + fmt(media) + ' (' + (varp > 0 ? 'alta' : 'queda') + ' de ' + String(Math.abs(varp)).replace('.', ',') + '%)'
            + (alta ? '; possível vazamento ou leitura errada' : '; possível medidor parado ou leitura errada'),
        },
      });
    });
    if (!doTipo.length) continue;
    // Nome só é procurado quando há alerta desse tipo (uma leitura a mais, com cache).
    const nome = await nomeTipoLeitura(cliente, id, tipo, j);
    const rotulo = nome || ('consumo (tipo ' + tipo + ')');
    doTipo.forEach((a) => {
      const alta = a._alta, uni = a._uni;
      delete a._alta; delete a._uni;
      a.titulo = (nome ? 'Consumo de ' + nome.toLowerCase() : 'Consumo') + ' ' + (alta ? 'muito acima' : 'muito abaixo')
        + ' da média na unidade ' + uni + (nome ? '' : ' (tipo ' + tipo + ')');
      a.detalhe.leitura = rotulo;
      out.push(a);
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
async function calcularOperacionais(cliente, id, hoje, { forcar = false, tetoMs = 25000, prazos = null } = {}) {
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
  const alertas = [].concat(ok ? alertasNotaFiscal(pagas, h) : [], ok ? alertasManutencao(pagas, h, prazos) : [], Array.isArray(consumo) ? consumo : []);
  return { alertas, falhas };
}

module.exports = { calcularOperacionais, alertasNotaFiscal, alertasManutencao, alertasConsumo, temNotaFiscal, ehContaConcessionaria, nomeDaConta, SEM_NF, MANUTENCOES };
