// Formato único do alerta devolvido por todas as regras.
'use strict';
const U = require('./util');

const TIPOS = {
  R1_DOCUMENTO: 'Duplicidade: mesmo documento ou código de barras no condomínio',
  R1_FORNECEDOR_VALOR: 'Duplicidade suspeita: mesmo fornecedor e valor em até 10 dias',
  R2_CONDOMINIO_TROCADO: 'Condomínio trocado: mesmo código de barras ou nota em dois condomínios',
  R4_SEM_COMPROVANTE: 'Pago sem comprovante',
  R4_ANEXO_REMOVIDO: 'Anexo removido depois do pagamento',
  R5_SEM_NOTA: 'Pago sem nota fiscal',
  R6_VENCIDA: 'Vencida sem baixa',
  R8_LANCAMENTO_TARDIO: 'Lançada depois do vencimento',
  R8_ANEXO_TARDIO: 'Anexo mais de 30 dias depois do pagamento',
  R8_PAGO_ATRASO: 'Paga depois do vencimento sem juros registrado',
  R9_MEXIDA: 'Mexida suspeita por usuário',
};

// ctx.analista(idDespesa, idCondominio) devolve { nome, origem } ou null.
function deItem(regra, tipo, gravidade, item, ctx, extra) {
  const idD = String(item.id_despesa_des || '');
  const idC = String(item.id_condominio_cond || '');
  const an = ctx && ctx.analista ? ctx.analista(idD, idC) : null;
  return {
    regra, tipo, descricao_tipo: TIPOS[tipo] || tipo, gravidade,
    id_condominio: idC, condominio: String(item.st_fantasia_cond || '').trim(),
    analista: an ? an.nome : '', analista_origem: an ? an.origem : '',
    fornecedor: U.fornecedorNome(item), documento: String(item.st_documento_des || '').trim(),
    codigo_barras: String(item.st_codigobarras_pdes || '').trim(),
    valor: U.valor(item.vl_valor_pdes),
    id_despesa: idD, id_parcela: String(item.id_parcela_pdes || ''),
    dt_lancamento: U.data(item.dt_geracao_des), dt_vencimento: U.data(item.dt_vencimento_pdes),
    dt_liquidacao: U.data(item.dt_liquidacao_pdes), forma_pagamento: String(item.id_forma_pag || ''),
    detalhe: '', relacionados: [],
    ...(extra || {}),
  };
}

module.exports = { TIPOS, deItem };
