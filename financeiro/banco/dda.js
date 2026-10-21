'use strict';
// DDA (boletos emitidos contra o CNPJ do condomínio), T36. O formato de entrada ainda não está
// definido (API de Pagamentos v3 do Sicoob ou arquivo, ver testes/T36/documentacao.md), então
// este módulo deixa a interface pronta: cada formato vira um leitor em LEITORES que devolve
// boletos no formato único abaixo, e o cruzamento com as despesas já funciona com ele.
//
// Boleto DDA único: { codigo_barras (44), linha_digitavel, beneficiario_nome, beneficiario_doc,
//   pagador_doc, vencimento (AAAA-MM-DD), valor_centavos, id_externo }

const C = require('./comum');
const { despesaParaConferir } = require('./cnab240');

function boletoDDA(o) {
  const cb = C.codigoBarras(o.codigoBarras || o.codigo_barras || o.linhaDigitavel || o.linha_digitavel);
  const valor = C.centavos(o.valor !== undefined ? o.valor : o.valorNominal !== undefined ? o.valorNominal : o.valor_centavos !== undefined ? o.valor_centavos / 100 : undefined);
  return {
    codigo_barras: cb,
    linha_digitavel: cb ? C.linhaDigitavel(cb) : null,
    beneficiario_nome: String(o.beneficiario || o.nomeBeneficiario || o.beneficiario_nome || '').replace(/\s+/g, ' ').trim() || null,
    beneficiario_doc: C.soDigitos(o.cpfCnpjBeneficiario || o.beneficiario_doc) || null,
    pagador_doc: C.soDigitos(o.cpfCnpjPagador || o.pagador_doc) || null,
    vencimento: C.dataQualquer(o.dataVencimento || o.vencimento, { formatoBR: true }),
    valor_centavos: valor !== null ? valor : (cb ? C.valorDoCodigo(cb) : null),
    id_externo: o.id || o.identificador || o.id_externo || null,
  };
}

// Leitores por formato. 'json' aceita uma lista já no formato acima ou com os nomes prováveis da API.
const LEITORES = {
  json: (conteudo) => {
    const j = typeof conteudo === 'string' ? JSON.parse(conteudo) : conteudo;
    const lista = Array.isArray(j) ? j : (j && (j.resultado || j.boletos || j.itens)) || [];
    return lista.map(boletoDDA);
  },
  // 'sicoob_api': ligar aqui quando o formato da API de Pagamentos v3 for confirmado.
  // 'arquivo': ligar aqui quando a cooperativa informar o layout do arquivo de DDA.
};

function lerDDA(conteudo, { formato } = {}) {
  const f = LEITORES[formato];
  if (!f) { const e = new Error('formato_dda_nao_definido'); e.formatos = Object.keys(LEITORES); throw e; }
  return f(conteudo).filter((b) => b.codigo_barras || (b.valor_centavos !== null && b.vencimento));
}

// Cruza boletos do DDA com as despesas do condomínio:
//   sem_despesa: boleto apareceu no DDA e ninguém lançou (risco de esquecer ou de cobrança indevida)
//   valor_diferente: lançado com valor diferente do boleto
//   lancado: confere
//   pagador_diferente: boleto emitido contra outro CNPJ (quando cnpjCondominio for informado)
const dentro = (dias, tol) => dias !== null && Math.abs(dias) <= tol;

function cruzarDDA(boletos, despesas, { cnpjCondominio, toleranciaDias = 3 } = {}) {
  const desp = (despesas || []).map(despesaParaConferir);
  const usadas = new Set();
  const cond = C.soDigitos(cnpjCondominio) || null;
  const out = [];
  for (const b of boletos || []) {
    let idx = -1; let como = null;
    if (b.codigo_barras) { idx = desp.findIndex((d, i) => !usadas.has(i) && d.codigo_barras === b.codigo_barras); if (idx >= 0) como = 'codigo_barras'; }
    if (idx < 0 && b.valor_centavos !== null && b.vencimento) {
      const cands = desp.map((d, i) => [d, i]).filter(([d, i]) => !usadas.has(i) && !d.codigo_barras && d.valor_centavos === b.valor_centavos && dentro(C.diasEntre(d.vencimento, b.vencimento), toleranciaDias) && (!b.beneficiario_doc || !d.fornecedor_doc || d.fornecedor_doc === b.beneficiario_doc));
      if (cands.length === 1) { idx = cands[0][1]; como = 'valor_e_vencimento'; }
    }
    const item = { boleto: b, situacao: 'sem_despesa', casou_por: como, despesa: null, achados: [] };
    if (cond && b.pagador_doc && b.pagador_doc !== cond) item.achados.push({ tipo: 'pagador_diferente', detalhe: 'Boleto emitido contra outro CNPJ.' });
    if (idx >= 0) {
      usadas.add(idx);
      const d = desp[idx];
      item.despesa = d;
      item.situacao = 'lancado';
      if (d.valor_centavos !== null && b.valor_centavos !== null && d.valor_centavos !== b.valor_centavos) {
        item.situacao = 'valor_diferente';
        item.achados.push({ tipo: 'valor_diferente', diferenca_centavos: d.valor_centavos - b.valor_centavos, detalhe: 'Lançado ' + C.fmtBRL(d.valor_centavos) + ', boleto ' + C.fmtBRL(b.valor_centavos) + '.' });
      }
    }
    out.push(item);
  }
  const resumo = { boletos: out.length, lancado: 0, valor_diferente: 0, sem_despesa: 0 };
  out.forEach((r) => { resumo[r.situacao]++; });
  return { resumo, resultados: out };
}

module.exports = { lerDDA, cruzarDDA, boletoDDA, LEITORES };
