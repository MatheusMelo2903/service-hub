// Auditor financeiro (T25): roda as regras R1, R2, R4, R5, R6, R8 e R9 sobre itens no formato da API do Superlógica.
// Funções puras: recebem listas e devolvem alertas; quem chama decide onde gravar (planilha T29, tabela fin_alertas da T24).
'use strict';
const U = require('./util');
const A = require('./alerta');
const dup = require('./duplicidade');
const doc = require('./documentos');
const aud = require('./auditoria');

// Junta alertas repetidos da mesma regra na mesma parcela (um item com vários pares na R1b, por exemplo).
function juntar(alertas) {
  const m = new Map();
  const out = [];
  for (const a of alertas) {
    if (a.regra === 'R9' || a.tipo === 'R4_ANEXO_REMOVIDO') { out.push(a); continue; }
    const k = a.tipo + '|' + (a.id_parcela || a.id_despesa);
    const ja = m.get(k);
    if (!ja) { m.set(k, a); out.push(a); continue; }
    ja.relacionados = [...new Set([...ja.relacionados, ...a.relacionados])];
    if (!ja.detalhe.includes(a.detalhe)) ja.detalhe += ' | ' + a.detalhe;
    const ord = { alta: 3, media: 2, baixa: 1 };
    if (ord[a.gravidade] > ord[ja.gravidade]) ja.gravidade = a.gravidade;
  }
  return out;
}

// dados: { despesas: [parcelas liquidadas e pendentes], auditoria: [linhas] }
// opcoes: { hoje: 'AAAA-MM-DD', listaBranca: [id_contato ou CNPJ], regras: ['R1', ...] }
function rodarRegras(dados, opcoes = {}) {
  const despesas = (dados && dados.despesas) || [];
  const linhas = (dados && dados.auditoria) || [];
  const analistas = aud.mapaAnalistas(linhas);
  const ctx = { analista: analistas.analista };
  const quer = (r) => !opcoes.regras || opcoes.regras.includes(r);
  let alertas = [];
  if (quer('R1')) alertas.push(...dup.r1Documento(despesas, ctx), ...dup.r1FornecedorValor(despesas, ctx, opcoes));
  if (quer('R2')) alertas.push(...dup.r2CondominioTrocado(despesas, ctx));
  if (quer('R4')) alertas.push(...doc.r4SemComprovante(despesas, ctx));
  if (quer('R5')) alertas.push(...doc.r5SemNota(despesas, ctx));
  if (quer('R6')) alertas.push(...doc.r6Vencida(despesas, ctx, opcoes));
  if (quer('R8')) alertas.push(...doc.r8Tardios(despesas, ctx));
  if ((quer('R4') || quer('R9')) && linhas.length) {
    alertas.push(...aud.r4r9(linhas, despesas, ctx).filter((a) => quer(a.regra)));
  }
  alertas = juntar(alertas).filter((a) => !U.IDS_EXCLUIDOS.has(String(a.id_condominio)) && String(a.id_condominio) !== U.ID_TESTE);
  return { alertas, analistasPorCondominio: analistas.porCondominio };
}

module.exports = { rodarRegras, TIPOS: A.TIPOS, util: U, duplicidade: dup, documentos: doc, auditoria: aud };
