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
t('comprovante com valor, data, cnpj de outro e editor', () => {
  const r = an.conferirAnexo({ anexo: { st_nomeabreviadoetiqueta_eti: 'Comprovante' },
    texto: 'Comprovante de pagamento ' + 'x'.repeat(40) + ' Valor R$ 1.071,23 Data 05/09/2026 Pagador CNPJ 11.222.333/0001-81',
    meta: { Producer: 'Microsoft® Word para Microsoft 365', CreationDate: '2026-09-04T10:00:00-03', ModDate: '2026-09-06T10:00:00-03' },
    parcelas: desp, cnpjCond: '33955806000192', outros });
  const tipos = r.achados.map((a) => a.tipo).sort();
  assert.deepStrictEqual(tipos, ['cnpj_outro_condominio', 'comprovante_data', 'comprovante_valor', 'pdf_editor', 'pdf_modificado']);
});
t('boleto com linha diferente', () => {
  const r = an.conferirAnexo({ anexo: { etiquetas: [{ st_nomeabreviadoetiqueta_eti: 'Doc. Pgto' }] },
    texto: 'Beneficiario ' + 'x'.repeat(40) + ` ${partes[0]}.${partes[1]} ${partes[2]}.${partes[3]} ${partes[4]}.${partes[5]} ${partes[6]} ${partes[7]}0000012346`,
    meta: {}, parcelas: desp, cnpjCond: '', outros });
  assert.deepStrictEqual(r.achados.map((a) => a.tipo), ['boleto_linha']);
});
t('escaneado nao e legivel', () => {
  const r = an.conferirAnexo({ anexo: {}, texto: '  \f ', meta: {}, parcelas: desp, cnpjCond: '', outros });
  assert.strictEqual(r.legivel, false);
});
console.log(ok, 'ok');
