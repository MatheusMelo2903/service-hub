'use strict';
// Conciliação automática (funções puras, sem rede e sem banco). Usada pelo serviço do dia
// (financeiro/conciliacao-dia.js) e pelos testes.
// 1. Reconhecer a conta do condomínio pelo banco, agência e conta do arquivo OFX.
// 2. Planejar a importação sem sobreposição: só entram os dias depois do último dia que já está no
//    Superlógica (ou que o Hub já gravou) e só dias fechados (antes de hoje). O extrato de hoje ainda
//    muda até a noite; importar o dia pela metade era o que obrigava a apagar e importar de novo.
// 3. Montar o OFX só com as linhas novas (o mesmo formato que o banco entrega).
// 4. Conciliar por regras: casar cada linha com o que já está lançado (valor, data, favorecido,
//    código de barras, documento), lançar sozinho o que é regra fixa (tarifa, rendimento e IR de
//    poupança, transferência entre contas do mesmo condomínio, CESAN e EDP com regra aprendida) e
//    deixar na fila "para conferir" só o que não casar, com a sugestão e o motivo.
// Valores em centavos (inteiros) e datas AAAA-MM-DD.
const crypto = require('crypto');
const C = require('../public/conciliacao-casar.js');
const extrato = require('./banco/extrato');

const NAO_CONDOMINIOS = new Set(['143', '144', '145', '160', '162']);
const digitos = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const semZeros = (s) => digitos(s).replace(/^0+/, '');
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 160);
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// ── 1. conta do arquivo ───────────────────────────────────────────────────
// Código do banco pelo nome cadastrado no Superlógica (a leitura das contas não traz o código).
const CODIGOS_BANCO = [
  [/SICOOB|BANCOOB/, '756'], [/BANESTES/, '21'], [/SICREDI/, '748'], [/ITAU/, '341'],
  [/CAIXA ECON|\bCEF\b|^CAIXA$/, '104'], [/BANCO DO BRASIL|^BB\b/, '1'], [/BRADESCO/, '237'],
  [/SANTANDER/, '33'], [/\bINTER\b/, '77'], [/MERCADO ?PAGO/, '323'], [/NU ?PAGAMENTOS|NUBANK/, '260'],
];
function codigoBanco(conta) {
  for (const k of ['st_numero_banc', 'st_codigo_banc', 'nm_codigo_banc', 'st_febraban_banc', 'codigo_banco']) {
    const d = semZeros(conta && conta[k]);
    if (d && d.length <= 3) return d;
  }
  const nome = semAcento(conta && (conta.st_nome_banc || conta.banco));
  for (const [rx, cod] of CODIGOS_BANCO) if (rx.test(nome)) return cod;
  return '';
}
// Conta do Superlógica no formato interno. Número e agência só ficam na memória do servidor:
// não vão para a tela, para o banco do Hub nem para log.
function contaInterna(c) {
  return {
    id: txt(c.id_contabanco_cb, 12), id_condominio: txt(c.id_condominio_cond, 12),
    descricao: txt(c.st_descricao_cb, 80), banco: txt(c.st_nome_banc, 60), tipo: txt(c.id_tipocontabanco_tcb, 3),
    principal: String(c.fl_principal_cb) === '1',
    numero: digitos(c.st_conta_cb), agencia: digitos(c.st_numero_agb), codigo: codigoBanco(c),
  };
}
// Final da conta para mostrar na tela (nunca o número inteiro).
const finalConta = (n) => { const d = semZeros(n); return d ? d.slice(-4) : ''; };

// Mesmo número: igual sem zeros à esquerda, ou um dos lados sem o dígito verificador.
function numerosConferem(a, b) {
  const za = semZeros(a), zb = semZeros(b);
  if (!za || !zb) return '';
  if (za === zb) return 'exata';
  if (za.length >= 4 && zb.length >= 4 && (za.slice(0, -1) === zb || zb.slice(0, -1) === za)) return 'sem_dv';
  return '';
}
// Alguns bancos põem agência e conta juntas no ACCTID.
function contaComAgencia(alvo, c) {
  const za = semZeros(alvo), zc = semZeros(c.numero), ag = semZeros(c.agencia);
  if (!ag || zc.length < 5 || za.length <= zc.length) return '';
  const resto = za.slice(0, za.length - zc.length).replace(/^0+/, '');
  return za.endsWith(zc) && (resto === ag || resto === ag.slice(0, -1)) ? 'com_agencia' : '';
}

// Reconhece a conta do arquivo entre as contas que a pessoa pode ver.
// ofx: { banco, agencia, conta } (lerOfx). contas: lista de contaInterna.
// Devolve { situacao: identificada | nao_encontrada | ambigua | sem_conta_no_arquivo, conta?, candidatos }.
function identificarConta(ofx, contas) {
  const alvo = digitos(ofx && ofx.conta);
  if (!alvo) return { situacao: 'sem_conta_no_arquivo', candidatos: 0 };
  const codOfx = semZeros(ofx.banco);
  let cands = (contas || []).filter((c) => c && c.numero).map((c) => ({ c, grau: numerosConferem(alvo, c.numero) || contaComAgencia(alvo, c) })).filter((x) => x.grau);
  // Banco do arquivo diferente do banco da conta: não é ela.
  if (codOfx) cands = cands.filter((x) => !x.c.codigo || x.c.codigo === codOfx);
  const agOfx = digitos(ofx.agencia);
  if (cands.length > 1 && agOfx) {
    const comAg = cands.filter((x) => numerosConferem(agOfx, x.c.agencia));
    if (comAg.length) cands = comAg;
  }
  if (cands.length > 1) {
    const exatas = cands.filter((x) => x.grau === 'exata');
    if (exatas.length) cands = exatas;
  }
  if (cands.length === 1) return { situacao: 'identificada', conta: cands[0].c, grau: cands[0].grau, candidatos: 1 };
  return { situacao: cands.length ? 'ambigua' : 'nao_encontrada', candidatos: cands.length };
}

// ── 2. plano de importação ────────────────────────────────────────────────
// FITID que vai para o Superlógica: o do banco quando é seguro, senão um código estável da linha.
function fitidSeguro(x, idConta, i) {
  const f = String(x.fitid || '');
  if (/^[A-Za-z0-9._:\/-]{1,60}$/.test(f)) return f;
  return 'HUB' + sha([idConta, x.data, x.valor, txt(x.descricao, 80), x.numero || '', i].join('|')).slice(0, 24).toUpperCase();
}
// itens: linhas do arquivo { data, valor (centavos), fitid, descricao, numero }.
// importados: linhas do extrato que já estão no Superlógica nessa conta (janela que cobre o arquivo).
// ultimoHub: maior "fim" das importações que o Hub já gravou (ou deixou incertas) nessa conta.
// Devolve as linhas a importar e o que ficou de fora, com o motivo.
function planejarImportacao({ itens, importados, ultimoHub, hoje, idConta }) {
  const ultimoSL = (importados || []).reduce((m, x) => (x.data > m ? x.data : m), '');
  const corte = [ultimoSL, ultimoHub || ''].sort().pop() || '';
  const livres = (importados || []).map((x) => Object.assign({ _usado: false }, x));
  const vistos = new Set();
  const out = { corte: corte || null, ultimo_superlogica: ultimoSL || null, ultimo_hub: ultimoHub || null, importar: [], ja_importados: [], faltando_no_superlogica: [], dias_abertos: [], repetidos: [] };
  (itens || []).forEach((x, i) => {
    const chaveRep = x.fitid ? 'f:' + x.fitid : null;
    if (chaveRep && vistos.has(chaveRep)) { out.repetidos.push(x); return; }
    if (chaveRep) vistos.add(chaveRep);
    if (x.data >= hoje) { out.dias_abertos.push(x); return; }
    if (corte && x.data <= corte) {
      const m = (x.fitid && livres.find((l) => !l._usado && l.fitid && l.fitid === x.fitid)) || livres.find((l) => !l._usado && l.data === x.data && l.valor === x.valor);
      if (m) { m._usado = true; out.ja_importados.push(x); } else out.faltando_no_superlogica.push(x);
      return;
    }
    out.importar.push(Object.assign({}, x, { fitid: fitidSeguro(x, idConta, i) }));
  });
  out.importar.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  out.inicio = out.importar.length ? out.importar[0].data : null;
  out.fim = out.importar.length ? out.importar[out.importar.length - 1].data : null;
  return out;
}

// ── 3. OFX só com as linhas novas ─────────────────────────────────────────
// conta: contaInterna (número e agência só aqui, dentro do arquivo que vai para o Superlógica).
function montarOfx(conta, itens, geradoEm) {
  const ext = {
    saldoAnteriorCentavos: null, saldoAtualCentavos: null,
    itens: itens.map((x) => ({ data: x.data, tipo: x.valor < 0 ? 'D' : 'C', centavos: Math.abs(x.valor), descricao: x.descricao || '', documento: x.numero || '', id: x.fitid })),
  };
  return extrato.paraOFX(ext, { banco: conta.codigo || '0', agencia: conta.agencia, conta: conta.numero, tipoConta: conta.tipo === '8' ? 'SAVINGS' : 'CHECKING', geradoEm, permitirSemFechar: true });
}
// Releitura: cada linha planejada está no extrato lido de novo (pelo FITID ou por data e valor)?
// No teste de verdade no 167 (23/10/2026) o Superlógica guardou um código próprio no lugar do FITID
// do arquivo: na prática a prova é por data e valor, linha a linha.
function faltandoNaReleitura(planejados, lidos) {
  const livres = (lidos || []).map((x) => Object.assign({ _usado: false }, x));
  const faltam = [];
  for (const p of planejados || []) {
    const m = (p.fitid && livres.find((l) => !l._usado && l.fitid && l.fitid === p.fitid)) || livres.find((l) => !l._usado && l.data === p.data && l.valor === p.valor);
    if (m) m._usado = true; else faltam.push(p);
  }
  return faltam;
}

// ── 4. regras ─────────────────────────────────────────────────────────────
const CAT = {
  tarifa: 'Tarifa bancária', ir: 'Imposto de renda sobre rendimento', rendimento: 'Rendimento de aplicação ou poupança',
  cesan: 'Água (CESAN)', edp: 'Energia (EDP)', pjbank: 'Repasse PJBank', boletos: 'Recebimento de boletos',
  transferencia: 'Transferência entre contas do condomínio (fundo, poupança, aplicação)',
};
const RX_CREDITO_CONDOMINOS = /RECEBIDO DE CONDOMINOS|PJ ?BANK|REPASSE/;
function categoriaLinha(desc) {
  const c = C.categoria(desc);
  for (const k of Object.keys(CAT)) if (CAT[k] === c) return k;
  if (RX_CREDITO_CONDOMINOS.test(semAcento(desc))) return 'pjbank';
  return '';
}
// Categoria de uma despesa já lançada (para aprender fornecedor e conta contábil de cada regra).
function categoriaDespesa(d) {
  const nome = semAcento(d.st_nome_con || d.fornecedor);
  const a = (Array.isArray(d.apropriacao) && d.apropriacao[0]) || {};
  const conta = semAcento(a.st_descricao_cont || '');
  if (/CESAN|SANEAMENTO/.test(nome)) return 'cesan';
  if (/\bEDP\b|ESCELSA|CENTRAIS ELETRICAS/.test(nome)) return 'edp';
  if (/I\.?R\.?R\.?F|IMPOSTO DE RENDA/.test(conta)) return 'ir';
  if (/TARIFA/.test(conta)) return 'tarifa';
  return '';
}
const RX_FORNECEDOR = { cesan: /CESAN|SANEAMENTO/, edp: /\bEDP\b|ESCELSA|CENTRAIS ELETRICAS/ };

const dataDe = (v) => C.dataISO(v) || '';
const centDe = (v) => C.centavos(v);

// Regra aprendida no histórico de despesas pagas: fornecedor e conta contábil que mais se repetem
// por categoria. Só vale com pelo menos 2 vezes em 2 meses diferentes e 60% dos casos.
function aprenderRegras(despesas) {
  const g = {};
  for (const d of despesas || []) {
    if (!d || !dataDe(d.dt_liquidacao_pdes)) continue;
    const cat = categoriaDespesa(d);
    if (!cat) continue;
    const a = (Array.isArray(d.apropriacao) && d.apropriacao[0]) || {};
    const f = digitos(d.id_contato_con), conta = txt(a.st_conta_cont, 30);
    if (!f || !/^\d+(\.\d+)*$/.test(conta)) continue;
    g[cat] = g[cat] || { total: 0, por: new Map() };
    g[cat].total++;
    const k = f + '|' + conta;
    if (!g[cat].por.has(k)) g[cat].por.set(k, { id_fornecedor: f, fornecedor: txt(d.st_nome_con, 80), conta_contabil: conta, descricao_conta: txt(a.st_descricao_cont, 80), vezes: 0, meses: new Set(), formas: new Map() });
    const r = g[cat].por.get(k);
    r.vezes++;
    r.meses.add(dataDe(d.dt_liquidacao_pdes).slice(0, 7));
    const fp = digitos(d.id_forma_pag);
    if (fp) r.formas.set(fp, (r.formas.get(fp) || 0) + 1);
  }
  const out = {};
  for (const cat of Object.keys(g)) {
    const melhor = [...g[cat].por.values()].sort((a, b) => b.vezes - a.vezes)[0];
    if (!melhor || melhor.vezes < 2 || melhor.meses.size < 2 || melhor.vezes / g[cat].total < 0.6) continue;
    const forma = [...melhor.formas.entries()].sort((a, b) => b[1] - a[1])[0];
    out[cat] = { categoria: cat, id_fornecedor: melhor.id_fornecedor, fornecedor: melhor.fornecedor, conta_contabil: melhor.conta_contabil, descricao_conta: melhor.descricao_conta,
      vezes: melhor.vezes, meses: melhor.meses.size, forma_pag: forma ? forma[0] : '7' };
  }
  return out;
}

// Chave estável de uma linha do extrato (a mesma linha dá a mesma chave todo dia).
function chaveLinha(idCond, idConta, x) {
  return 'l' + sha([idCond, idConta, x.data, x.valor, x.fitid || (C.normDesc(x.descricao) + '|' + (x.numero || ''))].join('|')).slice(0, 30);
}
const reais = (c) => (Math.abs(c) / 100).toFixed(2);
const brl = (c) => 'R$ ' + (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBR = (iso) => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '');

// Despesa do Superlógica no formato do casamento por favorecido, código de barras e documento.
function despesaInterna(d) {
  const a = (Array.isArray(d.apropriacao) && d.apropriacao[0]) || {};
  return {
    id_despesa: digitos(d.id_despesa_des), id_parcela: digitos(d.id_parcela_pdes), id_fornecedor: digitos(d.id_contato_con),
    fornecedor: txt(d.st_nome_con, 80), valor: -Math.abs(centDe(d.vl_valor_pdes)), vencimento: dataDe(d.dt_vencimento_pdes),
    liquidacao: dataDe(d.dt_liquidacao_pdes), id_conta: digitos(d.id_contabanco_cb), documento: txt(d.st_documento_des, 30),
    barras: digitos(d.st_codigobarras_pdes), conta_contabil: txt(a.st_conta_cont, 30),
  };
}
// Evidência de que a linha do banco é daquela despesa: documento, código de barras ou nome do favorecido.
function evidencia(linha, d) {
  const desc = semAcento(linha.descricao) + ' ' + digitos(linha.numero);
  const dd = digitos(desc);
  if (d.documento && d.documento.length >= 4 && (desc.includes(semAcento(d.documento)) || (digitos(d.documento).length >= 4 && dd.includes(digitos(d.documento))))) return 'documento';
  if (d.barras && d.barras.length >= 20 && dd && (d.barras.includes(dd) && dd.length >= 10)) return 'codigo de barras';
  const palavras = semAcento(d.fornecedor).split(/[^A-Z0-9]+/).filter((p) => p.length >= 4 && !/^(LTDA|CONDOMINIO|COMPANHIA|SERVICOS|SERVICO|COMERCIO|BRASIL)$/.test(p));
  if (palavras.some((p) => semAcento(linha.descricao).includes(p))) return 'favorecido';
  return '';
}

// entrada: {
//   id_condominio, hoje, inicio (primeiro dia que entra na fila), opcoes: { movimentacaoDireta },
//   contas: [{ id, descricao, tipo, banco: [linha], sistema: [lancamento] }]   (linhas no formato da T35)
//   despesas: despesas cruas do Superlógica na janela (abertas e pagas), regras: aprenderRegras(...),
//   regrasHub: [{ padrao, sinal, acao: 'despesa'|'ignorar', conta_contabil, id_fornecedor, forma_pag }]
// }
// Devolve { conciliadas, automaticas, fila, aguardando, por_conta }.
function conciliarCondominio(e) {
  const idCond = String(e.id_condominio);
  const hoje = e.hoje, mesHoje = hoje.slice(0, 7), inicio = e.inicio;
  const op = e.opcoes || {};
  const regras = e.regras || {};
  const regrasHub = e.regrasHub || [];
  const despesas = (e.despesas || []).map(despesaInterna).filter((d) => d.id_despesa && d.valor);
  const auto = [], fila = [];
  let conciliadas = 0, aguardando = 0;
  const porConta = {};
  const livres = [];
  const noPeriodo = (d) => d >= inicio && d < hoje;
  const descConta = {};
  (e.contas || []).forEach((k) => { descConta[k.id] = k.descricao; });

  const addFila = (tipo, linha, motivo, sugestao, extra) => {
    const chave = linha && linha.chave ? linha.chave : 'f' + sha([idCond, tipo, JSON.stringify(extra || {})].join('|')).slice(0, 30);
    fila.push(Object.assign({ chave, id_condominio: idCond, id_conta: linha ? linha.id_conta : (extra && extra.id_conta) || null, conta: linha ? descConta[linha.id_conta] || '' : '',
      data: linha ? linha.data : (extra && extra.data) || null, valor: linha ? linha.valor : (extra && extra.valor) || 0, descricao: linha ? txt(linha.descricao, 120) : (extra && extra.descricao) || '',
      tipo, motivo, sugestao: sugestao || null, pode_aceitar: !!(sugestao && sugestao.pode_aceitar) }, extra && extra.campos ? extra.campos : {}));
  };
  const addAuto = (a) => { auto.push(Object.assign({ id_condominio: idCond }, a)); };
  const despesaAuto = (linha, regra, rotulo) => addAuto({
    chave: 'd' + linha.chave.slice(1), tipo: 'despesa', regra: rotulo, data: linha.data, valor: Math.abs(linha.valor), id_conta: linha.id_conta,
    conta_contabil: regra.conta_contabil, id_fornecedor: regra.id_fornecedor, fornecedor: regra.fornecedor || '', forma_pag: regra.forma_pag || '7',
    complemento: txt(linha.descricao, 60), linhas: [linha.chave], descricao: txt(linha.descricao, 120),
  });

  // 1. casamento de cada conta com o que já está lançado (mesma função da T35)
  for (const k of e.contas || []) {
    const banco = (k.banco || []).filter((b) => b.data < hoje);
    const r = C.casar(k.sistema || [], banco, { mesFechado: (mes) => mes < mesHoje });
    const pc = { conciliadas: 0, livres: 0 };
    r.pares.forEach((p) => { if (noPeriodo((p.banco[0] || p.sistema[0]).data)) { conciliadas += p.banco.length; pc.conciliadas += p.banco.length; } });
    const ultimoBanco = banco.reduce((m, b) => (b.data > m ? b.data : m), '');
    for (const p of r.pares.filter((x) => x.tipo === 'valor' && noPeriodo(x.banco[0].data))) {
      const b = Object.assign({}, p.banco[0], { id_conta: k.id }); b.chave = chaveLinha(idCond, k.id, b);
      addFila('valor_diferente', b, 'Valor no banco diferente do lançado: lançado ' + brl(p.sistema[0].valor) + ', no banco ' + brl(b.valor) + ' (diferença ' + brl(Math.abs(p.diferenca)) + '). Juros, multa ou desconto que não foram lançados.',
        { acao: 'conferir', texto: 'Ajustar o lançamento "' + txt(p.sistema[0].descricao, 60) + '" no Superlógica e marcar como conferido.', pode_aceitar: true });
    }
    for (const d of r.divergencias) {
      if (d.tipo === 'rendimento_sem_lancamento' && d.mes >= inicio.slice(0, 7)) {
        // Mês fechado e o sistema não lançou o rendimento: soma separada do rendimento e do IR.
        const doMes = banco.filter((b) => !b.desconsiderado && b.data.slice(0, 7) === d.mes);
        const rend = doMes.filter((b) => categoriaLinha(b.descricao) === 'rendimento').reduce((s, b) => s + b.valor, 0);
        const ir = doMes.filter((b) => categoriaLinha(b.descricao) === 'ir').reduce((s, b) => s + b.valor, 0);
        const fimMes = new Date(Date.UTC(+d.mes.slice(0, 4), +d.mes.slice(5, 7), 0)).toISOString().slice(0, 10);
        const base = { id_conta: k.id, data: fimMes };
        if (rend > 0) {
          const ch = 'm' + sha([idCond, k.id, d.mes, 'rend'].join('|')).slice(0, 30);
          if (op.movimentacaoDireta && op.contaRendimento) addAuto({ chave: ch, tipo: 'movimentacao', regra: 'rendimento', data: fimMes, valor: rend, sinal: 1, id_conta: k.id, conta_contabil: op.contaRendimento, complemento: 'Rendimento ' + d.mes.slice(5, 7) + '/' + d.mes.slice(0, 4), linhas: [], descricao: 'Rendimento do mês' });
          else addFila('rendimento_mes', Object.assign({ chave: 'f' + ch.slice(1), descricao: 'Rendimento do mês ' + d.mes.slice(5, 7) + '/' + d.mes.slice(0, 4), valor: rend }, base),
            'O banco lançou ' + brl(rend) + ' de rendimento no mês e o sistema não tem o lançamento do mês.', { acao: 'conferir', texto: 'Lançar o rendimento do mês (' + brl(rend) + ') no Superlógica, com data de ' + dataBR(fimMes) + ', e marcar como conferido.', pode_aceitar: true });
        }
        if (ir < 0) {
          const ch = 'i' + sha([idCond, k.id, d.mes, 'ir'].join('|')).slice(0, 30);
          const linhaIr = Object.assign({ chave: 'f' + ch.slice(1), descricao: 'IR sobre rendimento ' + d.mes.slice(5, 7) + '/' + d.mes.slice(0, 4), valor: ir }, base);
          if (regras.ir) despesaAuto(Object.assign({}, linhaIr, { chave: 'x' + ch.slice(1) }), regras.ir, 'ir');
          else addFila('ir_mes', linhaIr, 'O banco descontou ' + brl(ir) + ' de IR no mês e o sistema não tem o lançamento.', { acao: 'conferir', texto: 'Lançar o IR do mês no Superlógica e marcar como conferido, ou corrigir com a conta contábil e o fornecedor para o Hub lançar.', pode_aceitar: true, corrigir: 'despesa' });
        }
      } else if (d.tipo === 'rendimento_diferente' && d.mes >= inicio.slice(0, 7)) {
        addFila('rendimento_diferente', null, 'Rendimento e IR do mês no banco somam ' + brl(d.banco) + ' e no sistema ' + brl(d.sistema) + '.',
          { acao: 'conferir', texto: 'Conferir o lançamento de rendimento do mês ' + d.mes.slice(5, 7) + '/' + d.mes.slice(0, 4) + ' e marcar como conferido.', pode_aceitar: true },
          { id_conta: k.id, data: d.mes + '-01', valor: d.banco - d.sistema, descricao: 'Rendimento ' + d.mes.slice(5, 7) + '/' + d.mes.slice(0, 4), campos: { conta: k.descricao } });
      } else if ((d.tipo === 'lancado_e_desconsiderado' || d.tipo === 'tarifas_desconsideradas_lancadas_no_mes') && d.data && noPeriodo(d.data)) {
        addFila(d.tipo, null, d.tipo === 'lancado_e_desconsiderado' ? 'Lançado no sistema, mas a linha do extrato foi marcada para desconsiderar.' : 'Tarifas desconsideradas no extrato e lançadas de uma vez no mês.',
          { acao: 'conferir', texto: 'Conferir no Superlógica e marcar como conferido.', pode_aceitar: true },
          { id_conta: k.id, data: d.data, valor: d.valor, descricao: txt((d.banco && d.banco.descricao) || d.descricao_banco || '', 120), campos: { conta: k.descricao } });
      }
    }
    // Rendimento e IR do mês aberto: o sistema lança uma vez no fim do mês. Não é pendência ainda.
    for (const b of r.soBanco) {
      if (!noPeriodo(b.data)) continue;
      const cat = categoriaLinha(b.descricao);
      if ((cat === 'rendimento' || cat === 'ir') && b.data.slice(0, 7) === mesHoje) { aguardando++; continue; }
      const l = Object.assign({}, b, { id_conta: k.id, categoria: cat });
      l.chave = chaveLinha(idCond, k.id, l);
      livres.push(l);
      pc.livres++;
    }
    for (const s of r.soSistema) {
      if (!noPeriodo(s.data) || !ultimoBanco || s.data > ultimoBanco) continue;
      addFila('lancamento_sem_banco', null, 'Lançado no sistema e não aparece no extrato do banco.', { acao: 'conferir', texto: 'Conferir se o lançamento existe no banco (ou foi em outra conta) e marcar como conferido.', pode_aceitar: true },
        { id_conta: k.id, data: s.data, valor: s.valor, descricao: txt(s.descricao, 120), campos: { conta: k.descricao, chave: 's' + sha([idCond, k.id, s.data, s.valor, C.normDesc(s.descricao), s.documento || ''].join('|')).slice(0, 30) } });
    }
    porConta[k.id] = pc;
  }

  // 2. transferência entre contas do mesmo condomínio: saída numa conta e entrada igual na outra,
  //    no mesmo dia (ou no dia seguinte), com um par só de cada lado.
  const usado = new Set();
  const NAO_TRANSF = new Set(['pjbank', 'boletos', 'tarifa', 'cesan', 'edp', 'rendimento', 'ir']);
  const debitos = livres.filter((l) => l.valor < 0 && !NAO_TRANSF.has(l.categoria));
  const creditos = livres.filter((l) => l.valor > 0 && !NAO_TRANSF.has(l.categoria));
  const parDe = (x, lista) => lista.filter((y) => y.id_conta !== x.id_conta && y.valor === -x.valor && Math.abs(C.dias(x.data, y.data)) <= 1);
  for (const d of debitos) {
    const ks = parDe(d, creditos);
    if (ks.length !== 1) continue;
    const k = ks[0];
    if (parDe(k, debitos).length !== 1 || usado.has(k.chave)) continue;
    usado.add(d.chave); usado.add(k.chave);
    addAuto({ chave: 't' + sha(d.chave + '|' + k.chave).slice(0, 30), tipo: 'transferencia', regra: 'transferencia', data: d.data, valor: Math.abs(d.valor), id_conta: d.id_conta, id_conta_destino: k.id_conta,
      complemento: 'Transferência entre contas', linhas: [d.chave, k.chave], descricao: txt(d.descricao, 120) });
  }

  // 3. o resto, linha a linha
  for (const l of livres) {
    if (usado.has(l.chave)) continue;
    const sinal = l.valor < 0 ? -1 : 1;
    const padrao = C.normDesc(l.descricao);
    const rh = regrasHub.find((r) => r.padrao === padrao && Number(r.sinal) === sinal);
    if (rh && rh.acao === 'ignorar') continue;
    if (rh && rh.acao === 'despesa' && sinal < 0) { despesaAuto(l, rh, 'aprendida'); continue; }
    // Casamento com despesa já lançada (aberta ou paga): valor igual em até 10 dias, com evidência
    // (documento, código de barras ou favorecido) ou candidata única.
    if (sinal < 0) {
      const cands = despesas.filter((d) => d.valor === l.valor && Math.abs(C.dias(l.data, d.liquidacao || d.vencimento)) <= 10);
      const comEv = cands.map((d) => ({ d, ev: evidencia(l, d) })).filter((x) => x.ev);
      const escolhida = comEv.length === 1 ? comEv[0] : (cands.length === 1 ? { d: cands[0], ev: 'valor e data' } : null);
      if (escolhida) {
        const d = escolhida.d;
        if (d.liquidacao) {
          addFila(d.id_conta && d.id_conta !== l.id_conta ? 'paga_em_outra_conta' : 'data_diferente', l,
            'Já está lançada e paga (' + (d.fornecedor || 'despesa ' + d.id_despesa) + ', baixa em ' + dataBR(d.liquidacao) + (d.id_conta && d.id_conta !== l.id_conta ? ', em outra conta' : '') + '). Casou por ' + escolhida.ev + '.',
            { acao: 'conferir', texto: 'Ajustar a data ou a conta da baixa no Superlógica e marcar como conferido.', id_despesa: d.id_despesa, pode_aceitar: true });
        } else {
          addFila('baixar_despesa', l, 'Despesa lançada e ainda em aberto: ' + (d.fornecedor || 'despesa ' + d.id_despesa) + ', vencimento ' + dataBR(d.vencimento) + '. Casou por ' + escolhida.ev + '.',
            { acao: 'conferir', texto: 'Dar baixa nessa despesa no Superlógica com a data ' + dataBR(l.data) + ' e marcar como conferido.', id_despesa: d.id_despesa, id_parcela: d.id_parcela, pode_aceitar: true });
        }
        continue;
      }
      if (cands.length > 1) {
        addFila('varias_despesas', l, cands.length + ' despesas lançadas com o mesmo valor perto dessa data; não deu para saber qual é.', { acao: 'conferir', texto: 'Dar baixa na despesa certa no Superlógica e marcar como conferido.', pode_aceitar: true });
        continue;
      }
    }
    const cat = l.categoria;
    if (sinal < 0 && (cat === 'tarifa' || cat === 'cesan' || cat === 'edp' || cat === 'ir')) {
      // CESAN e EDP: nunca lança se já existe despesa desse fornecedor com o mesmo valor em 35 dias.
      const rx = RX_FORNECEDOR[cat];
      const parecida = rx && despesas.find((d) => d.valor === l.valor && rx.test(semAcento(d.fornecedor)) && Math.abs(C.dias(l.data, d.liquidacao || d.vencimento)) <= 35);
      if (parecida) {
        addFila('possivel_duplicidade', l, 'Já existe despesa de ' + parecida.fornecedor + ' com esse valor (vencimento ' + dataBR(parecida.vencimento) + '). O Hub não lançou para não duplicar.',
          { acao: 'conferir', texto: 'Conferir no Superlógica e marcar como conferido.', id_despesa: parecida.id_despesa, pode_aceitar: true });
        continue;
      }
      if (regras[cat]) { despesaAuto(l, regras[cat], cat); continue; }
      addFila('sem_regra', l, 'É ' + CAT[cat].toLowerCase() + ', mas o Hub ainda não sabe a conta contábil e o fornecedor deste condomínio (não achou pelo menos 2 lançamentos iguais nos últimos meses).',
        { acao: 'despesa', texto: 'Corrigir informando a conta contábil e o código do fornecedor. Marque "usar nas próximas" para o Hub lançar sozinho.', categoria: cat, corrigir: 'despesa', pode_aceitar: false });
      continue;
    }
    if (cat === 'transferencia' || (cat === '' && /TRANSF|TED|APLICAC|RESGATE/.test(semAcento(l.descricao)))) {
      const outras = (e.contas || []).filter((k) => k.id !== l.id_conta).map((k) => ({ id: k.id, descricao: k.descricao }));
      if (outras.length) {
        addFila('transferencia_sem_par', l, 'Parece transferência entre contas, mas a outra ponta não está no extrato de nenhuma conta do condomínio.',
          { acao: 'transferencia', texto: 'Corrigir escolhendo a outra conta para o Hub lançar a transferência, ou conferir no Superlógica.', contas: outras, corrigir: 'transferencia', pode_aceitar: false });
        continue;
      }
    }
    if (sinal > 0 && (cat === 'pjbank' || cat === 'boletos')) {
      addFila('credito_sem_baixa', l, 'Crédito de cobrança no banco sem a baixa das cobranças no sistema nessa data.',
        { acao: 'conferir', texto: 'Conferir o retorno do banco e as baixas do dia no Superlógica e marcar como conferido.', pode_aceitar: true });
      continue;
    }
    addFila('sem_lancamento', l, 'Nenhum lançamento com o mesmo valor perto dessa data' + (cat ? ' (' + CAT[cat].toLowerCase() + ')' : '') + '.',
      { acao: sinal < 0 ? 'despesa' : 'conferir', texto: sinal < 0 ? 'Corrigir informando a conta contábil e o código do fornecedor para o Hub lançar, ou lançar no Superlógica e marcar como conferido.' : 'Lançar a receita no Superlógica e marcar como conferido.',
        corrigir: sinal < 0 ? 'despesa' : undefined, pode_aceitar: sinal > 0 });
  }
  // Chave única na fila (a mesma linha não entra duas vezes).
  const vistos = new Set();
  const filaUnica = fila.filter((f) => (vistos.has(f.chave) ? false : vistos.add(f.chave)));
  return { conciliadas, automaticas: auto, fila: filaUnica, aguardando, por_conta: porConta };
}

// Resumo do que vai ser gravado, para a janela de confirmação.
function resumoGravacao(importacoes, lancamentos) {
  const linhas = [];
  if (importacoes.length) {
    const q = importacoes.reduce((s, x) => s + (Number(x.quantidade) || 0), 0);
    linhas.push({ rotulo: 'Extratos', valor: importacoes.length + ' importação(ões), ' + q + ' linha(s) do banco: ' + importacoes.map((x) => (x.conta || 'conta ' + x.id_conta) + ' de ' + dataBR(x.inicio) + ' a ' + dataBR(x.fim)).join('; ') });
  }
  const tipos = { despesa: 'Despesas já pagas', transferencia: 'Transferências entre contas', movimentacao: 'Movimentações diretas' };
  for (const t of Object.keys(tipos)) {
    const l = lancamentos.filter((x) => x.tipo === t);
    if (l.length) linhas.push({ rotulo: tipos[t], valor: l.length + ' no total de ' + brl(l.reduce((s, x) => s + Math.abs(Number(x.valor_centavos != null ? x.valor_centavos : x.valor) || 0), 0)) });
  }
  linhas.push({ rotulo: 'O que acontece', valor: 'O Hub importa só os dias novos do extrato e lança o que casou com as regras. Nada é pago, agendado ou enviado ao banco.' });
  return { linhas, quantidade: importacoes.length + lancamentos.length };
}

module.exports = {
  NAO_CONDOMINIOS, CAT, digitos, semZeros, codigoBanco, contaInterna, finalConta, numerosConferem, identificarConta,
  planejarImportacao, fitidSeguro, montarOfx, faltandoNaReleitura, categoriaLinha, categoriaDespesa, aprenderRegras,
  chaveLinha, despesaInterna, evidencia, conciliarCondominio, resumoGravacao, reais, brl, dataBR, C,
};
