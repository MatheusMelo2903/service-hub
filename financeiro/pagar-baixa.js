'use strict';
// Contas a pagar, parte de baixa (pura, sem rede): acha no retorno do banco (CNAB 240 já guardado
// em fin_juros_banco) e no extrato importado no Superlógica o pagamento de cada parcela em aberto e
// decide se o Hub baixa sozinho ou se fica para uma pessoa conferir.
// Regras (financeiro/pagar.js, decidirBaixa): só baixa com o banco dizendo "pagamento efetivado"
// (ocorrência 00) ou com a saída no extrato; agendado ou pendente de assinatura nunca baixa; pago a
// menor, boleto de outro beneficiário ou pagador, ou mais de uma despesa possível vai para conferir.
// Extrato: só débito automático baixa sozinho (valor exato e uma parcela só); o resto, conferir.

const crypto = require('crypto');
const cnab = require('./banco/cnab240');
const C = require('./banco/comum');
const P = require('./pagar');
const { pagamentoDeLinha } = require('./juros-rotas');

const E = require('./entrada');
const centavos = (v) => C.centavos(v);

// Linhas do retorno guardadas (fin_juros_banco) -> propostas de baixa, uma por pagamento.
// parcelas: despesas/index (comStatus=todas) do condomínio no período dos pagamentos.
function propostasRetorno(linhas, parcelas, cnpjCond) {
  const pags = (linhas || []).map(pagamentoDeLinha);
  const conf = cnab.conferirPagamentos(pags, parcelas || [], { cnpjCondominio: cnpjCond || null });
  const brutoPorParcela = new Map((parcelas || []).map((p) => [String(p.id_parcela_pdes), p]));
  return conf.resultados.map((r, i) => {
    const l = linhas[i];
    const dec = P.decidirBaixa(r);
    const d = r.despesa || null;
    const bruto = d && d.id_parcela ? brutoPorParcela.get(String(d.id_parcela)) : null;
    return {
      origem: 'retorno', origem_ref: 'b' + l.id, linha_banco: l,
      id_parcela: d && d.id_parcela ? String(d.id_parcela) : null, id_despesa: d && d.id_despesa ? String(d.id_despesa) : null,
      vencimento: d ? d.vencimento : (l.vencimento || null), fornecedor: (d && d.fornecedor) || r.favorecido || null,
      data: r.data_efetiva, valor_pago_centavos: r.valor_pago_centavos, valor_parcela_centavos: d ? d.valor_centavos : null,
      juros_centavos: dec.juros_centavos || 0, multa_centavos: dec.multa_centavos || 0,
      acao: dec.acao, motivo: dec.motivo, situacao_banco: r.situacao, achados: (r.achados || []).map((a) => a.tipo),
      forma: bruto ? String(bruto.id_forma_pag || '') : null,
    };
  }).filter((x) => x.acao !== 'nada' || x.situacao_banco === 'confere');
}

// Itens do extrato (conciliacao.itensConta: banco[] com data, valor em centavos, descricao, fitid)
// -> propostas de baixa das parcelas de débito automático em aberto.
function chaveExtrato(idConta, x) {
  const base = x.fitid ? x.fitid : x.data + '|' + x.valor + '|' + x.descricao + '|' + (x.numero || '');
  return 'x' + idConta + ':' + crypto.createHash('sha256').update(String(base)).digest('hex').slice(0, 32);
}
const palavras = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !/^(LTDA|S\/A|SA|DE|DA|DO|DOS|DAS|CIA|COMPANHIA|EIRELI|ME|EPP)$/.test(w));
function nomeBate(fornecedor, descricao) {
  const d = new Set(palavras(descricao));
  return palavras(fornecedor).slice(0, 3).some((w) => d.has(w));
}
function propostasExtrato(idConta, itensBanco, parcelas, hoje) {
  const abertas = (parcelas || []).filter((p) => String(p.id_contabanco_cb) === String(idConta) && !P.liquidada(p) && Number(p.id_forma_pag) === P.FORMA.debito_automatico)
    .map((p) => ({ p, v: E.slParaIso(p.dt_vencimento_pdes), valor: centavos(p.vl_valor_pdes) })).filter((x) => x.v && x.valor > 0);
  const debitos = (itensBanco || []).filter((x) => !x.desconsiderado && Number(x.valor) < 0 && x.data && x.data <= hoje);
  const usadosDeb = new Set();
  const out = [];
  for (const a of abertas) {
    const perto = debitos.filter((x) => !usadosDeb.has(x) && Math.abs(C.diasEntre(a.v, x.data)) <= 5);
    const exatos = perto.filter((x) => -Number(x.valor) === a.valor);
    // O mesmo débito não pode servir para duas parcelas: confere se outra parcela também casa com ele.
    const unicoDoOutroLado = (x) => abertas.filter((b) => b !== a && Math.abs(C.diasEntre(b.v, x.data)) <= 5 && -Number(x.valor) === b.valor).length === 0;
    if (exatos.length === 1 && unicoDoOutroLado(exatos[0])) {
      const x = exatos[0];
      usadosDeb.add(x);
      out.push({ origem: 'extrato', origem_ref: chaveExtrato(idConta, x), item_extrato: x, id_conta: String(idConta), id_parcela: String(a.p.id_parcela_pdes), id_despesa: String(a.p.id_despesa_des),
        vencimento: a.v, fornecedor: String(a.p.st_nome_con || '').trim(), data: x.data, valor_pago_centavos: a.valor, valor_parcela_centavos: a.valor, juros_centavos: 0, multa_centavos: 0,
        acao: 'baixar', motivo: 'Débito automático no extrato com o mesmo valor' + (nomeBate(a.p.st_nome_con, x.descricao) ? ' e o nome do fornecedor.' : '.'), forma: '7' });
      continue;
    }
    // Valor diferente (fatura de valor variável lançada com outro valor) ou mais de um débito igual: conferir.
    const comNome = perto.filter((x) => nomeBate(a.p.st_nome_con, x.descricao));
    const cand = exatos.length > 1 ? exatos : comNome.length === 1 ? comNome : [];
    if (cand.length) {
      const x = cand[0];
      out.push({ origem: 'extrato', origem_ref: chaveExtrato(idConta, x), item_extrato: x, id_conta: String(idConta), id_parcela: String(a.p.id_parcela_pdes), id_despesa: String(a.p.id_despesa_des),
        vencimento: a.v, fornecedor: String(a.p.st_nome_con || '').trim(), data: x.data, valor_pago_centavos: -Number(x.valor), valor_parcela_centavos: a.valor,
        juros_centavos: Math.max(0, -Number(x.valor) - a.valor), multa_centavos: 0, acao: 'conferir',
        motivo: exatos.length > 1 ? 'Mais de um débito igual no extrato perto do vencimento.' : 'Débito do fornecedor no extrato com valor diferente do lançado (' + C.fmtBRL(-Number(x.valor)) + ').', forma: '7' });
    }
  }
  return out;
}

module.exports = { propostasRetorno, propostasExtrato, chaveExtrato, nomeBate, palavras };
