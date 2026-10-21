'use strict';
// Testes dos leitores de financeiro/anexos.js (sem rede e sem arquivo). node scripts/financeiro-anexos-teste.js
const assert = require('assert');
const an = require('../financeiro/anexos.js');
let ok = 0;
function t(nome, f) { f(); ok++; console.log('ok', nome); }

// Linha fictícia montada em partes (campo1, campo2, campo3, DV geral, fator e valor).
const partes = ['00190', '00009', '01234', '567890', '12345', '678901', '2', '1000', '0000012345'];
const linha47 = partes.join('');
t('linha digitavel 47 vira codigo de barras 44', () => {
  const c = an.codigoBarras44(linha47);
  assert.strictEqual(c.length, 44);
  assert.strictEqual(c.slice(0, 4), '0019');
  assert.strictEqual(c.slice(4, 5), '2');
  assert.strictEqual(c.slice(9, 19), '0000012345');
  assert.strictEqual(an.codigoBarras44(c), c);
});
t('linha digitavel formatada no texto', () => {
  const txt = `Linha: ${partes[0]}.${partes[1]} ${partes[2]}.${partes[3]} ${partes[4]}.${partes[5]} ${partes[6]} ${partes[7]}${partes[8]} fim`;
  assert.deepStrictEqual(an.linhasNoTexto(txt), [an.codigoBarras44(linha47)]);
});
t('arrecadacao 48 tira o DV dos blocos', () => {
  const d = '836200000005' + '667801380009' + '737150200014' + '210120260917';
  assert.strictEqual(an.codigoBarras44(d), '83620000000' + '66780138000' + '73715020001' + '21012026091');
});
t('valores', () => {
  assert.deepStrictEqual(an.valoresNoTexto('R$ 1.017,23 e 79,99 e 2025').sort(), [1017.23, 79.99].sort());
});
t('datas', () => {
  assert.deepStrictEqual(an.datasNoTexto('Pago em 04/09/2026 vence 05.09.26').sort(), ['2026-09-04', '2026-09-05']);
});
t('data em milissegundos no fuso de Brasilia', () => {
  assert.deepStrictEqual(an.datasNoTexto('efetivação do débito: ' + String(Date.UTC(2026, 8, 24, 3, 0, 0))), ['2026-09-24']);
});
t('cnpj mascarado do pagador conta como o do condominio', () => {
  const r = an.conferirAnexo({ anexo: { st_nomeabreviadoetiqueta_eti: 'Comprovante' },
    texto: 'Comprovante ' + 'x'.repeat(40) + ' Pagador CPF/CNPJ: **.955.806/0001-** Recebedor CNPJ 11.222.333/0001-81 Valor R$ 1.017,23',
    meta: {}, parcelas: [{ vl_valor_pdes: '1017.23', dt_liquidacao_pdes: '09/04/2026 00:00:00' }], cnpjCond: '33955806000192', outros: new Map() });
  assert.strictEqual(r.temCond, true);
  assert.deepStrictEqual(r.achados, []);
  const r2 = an.conferirAnexo({ anexo: { st_nomeabreviadoetiqueta_eti: 'Doc. Fiscal' },
    texto: 'Fatura ' + 'x'.repeat(40) + ' Emitente CNPJ: 11.222.333/0001-81 Usuario CPF/CNPJ: 33.***.***/0001-92',
    meta: {}, parcelas: [], cnpjCond: '33955806000192', outros: new Map() });
  assert.strictEqual(r2.temCond, true);
});
t('cnpj valido e invalido', () => {
  assert.ok(an.cnpjValido('11.222.333/0001-81'));
  assert.ok(!an.cnpjValido('11.222.333/0001-82'));
  assert.deepStrictEqual(an.cnpjsNoTexto('CNPJ 11.222.333/0001-81 e CNPJ: 11222333000181 e 11.222.333/0001-82'), ['11222333000181']);
});
const desp = [{ vl_valor_pdes: '1017.23', dt_liquidacao_pdes: '09/04/2026 00:00:00', st_codigobarras_pdes: linha47 }];
const outros = new Map([['11222333000181', 'OUTRO CONDOMINIO']]);
t('comprovante certo nao gera achado', () => {
  const r = an.conferirAnexo({ anexo: { st_nomeabreviadoetiqueta_eti: 'Comprovante' },
    texto: 'Comprovante de pagamento ' + 'x'.repeat(40) + ' Valor R$ 1.017,23 Data 04/09/2026 Pagador CNPJ 33.955.806/0001-92',
    meta: { Producer: 'iText', CreationDate: '2026-09-04T10:00:00-03', ModDate: '2026-09-04T10:00:00-03' },
    parcelas: desp, cnpjCond: '33955806000192', outros });
  assert.deepStrictEqual(r.achados, []);
});
t('comprovante com cnpj de outro, editor e modificado (sinais do anexo)', () => {
  const r = an.conferirAnexo({ anexo: { st_nomeabreviadoetiqueta_eti: 'Comprovante' },
    texto: 'Comprovante de pagamento ' + 'x'.repeat(40) + ' Beneficiario CNPJ 05.644.910/0001-20 Valor R$ 1.071,23 Data 05/09/2026 Pagador CNPJ 11.222.333/0001-81',
    meta: { Producer: 'Microsoft® Word para Microsoft 365', CreationDate: '2026-09-04T10:00:00-03', ModDate: '2026-09-06T10:00:00-03' },
    parcelas: desp, cnpjCond: '33955806000192', outros });
  assert.deepStrictEqual(r.achados.map((a) => a.tipo).sort(), ['cnpj_outro_condominio', 'pdf_editor', 'pdf_modificado']);
  assert.strictEqual(r.valorBate, false);
});
t('ilovepdf vira pdf_compactado e nao pdf_editor', () => {
  const r = an.conferirAnexo({ anexo: {}, texto: '', meta: { Producer: 'iLovePDF' }, parcelas: desp, cnpjCond: '', outros });
  assert.deepStrictEqual(r.achados.map((a) => a.tipo), ['pdf_compactado']);
});
const comp = (texto) => an.conferirAnexo({ anexo: { st_nomeabreviadoetiqueta_eti: 'Comprovante' }, texto: 'Comprovante ' + 'x'.repeat(40) + texto, meta: {}, parcelas: desp, cnpjCond: '', outros });
t('despesa parcelada: comprovante de outra parcela nao acusa se um bate', () => {
  assert.deepStrictEqual(an.conferirDespesa(desp, [comp(' R$ 999,00 em 04/06/2026'), comp(' R$ 1.017,23 em 04/09/2026')]), []);
});
t('despesa: nenhum comprovante com o valor', () => {
  assert.deepStrictEqual(an.conferirDespesa(desp, [comp(' R$ 999,00 em 04/09/2026')]).map((a) => a.tipo), ['comprovante_valor']);
});
t('despesa: valor bate e data diferente', () => {
  assert.deepStrictEqual(an.conferirDespesa(desp, [comp(' R$ 1.017,23 em 10/09/2026')]).map((a) => a.tipo), ['comprovante_data']);
});
t('despesa: boleto com linha diferente', () => {
  const b = an.conferirAnexo({ anexo: { etiquetas: [{ st_nomeabreviadoetiqueta_eti: 'Doc. Pgto' }] },
    texto: 'Beneficiario ' + 'x'.repeat(40) + ` ${partes[0]}.${partes[1]} ${partes[2]}.${partes[3]} ${partes[4]}.${partes[5]} ${partes[6]} ${partes[7]}0000012346`,
    meta: {}, parcelas: desp, cnpjCond: '', outros });
  assert.deepStrictEqual(an.conferirDespesa(desp, [b]).map((a) => a.tipo), ['boleto_linha']);
});
t('cnpj de outro condominio como emitente nao acusa', () => {
  const r = an.conferirAnexo({ anexo: { st_nomeabreviadoetiqueta_eti: 'Doc. Fiscal' }, texto: 'Nota fiscal ' + 'x'.repeat(40) + ' Prestador CNPJ 11.222.333/0001-81',
    meta: {}, parcelas: desp, cnpjCond: '33955806000192', outros });
  assert.ok(!r.achados.some((a) => a.tipo === 'cnpj_outro_condominio'));
});
t('escaneado nao e legivel', () => {
  const r = an.conferirAnexo({ anexo: {}, texto: '  \f ', meta: {}, parcelas: desp, cnpjCond: '', outros });
  assert.strictEqual(r.legivel, false);
});
console.log(ok, 'ok');
