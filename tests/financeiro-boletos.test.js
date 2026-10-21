// Teste da conferência de boletos (T27) com dados fictícios. Rodar: node tests/financeiro-boletos.test.js
'use strict';
const assert = require('assert');
const B = require('../financeiro/boletos');

let seq = 1;
function cob(uni, venc, itens, extra) {
  return Object.assign({
    id_recebimento_recb: String(seq++), id_unidade_uni: uni, st_bloco_uni: 'A', st_unidade_uni: uni,
    dt_vencimento_recb: venc + ' 00:00:00', dt_competencia_recb: venc + ' 00:00:00', fl_status_recb: '0', st_label_recb: '',
    vl_emitido_recb: String(itens.reduce((s, i) => s + i[2], 0)),
    receita_apropriacao: itens.map(([conta, desc, valor, comp]) => ({ st_conta_cont: conta, st_descricao_cont: ' ' + desc, st_complemento_rec: comp || '', vl_valor_reca: String(valor) })),
  }, extra || {});
}
const taxa = ['1.1', 'Taxa de Condomínio', 300];
const agua = (v) => ['1.8', 'Água Individual', v];
const obra = (n) => ['1.131', 'Fundo de Obras', 50, '- Parc. ' + n + '/24'];
const mes = (m, lista) => ({ competencia: '2026-' + m, cobrancas: lista.map((x) => B.normalizar(x)) });

// Três meses anteriores iguais para as unidades 1 a 4.
const hist = ['09', '08', '07'].map((m, k) => mes(m, ['1', '2', '3', '4'].map((u) => cob(u, m + '/10/2026', [taxa, agua(40), obra(20 - k)]))));
const atual = mes('10', [
  cob('1', '10/10/2026', [taxa, agua(40), obra(21)]),            // normal
  cob('1', '10/15/2026', [taxa]),                                  // em dobro
  cob('2', '10/10/2026', [taxa, agua(0), obra(20)]),              // água zerada e parcela repetida
  cob('3', '10/10/2026', [['1.1', 'Taxa de Condomínio', 900], agua(40), obra(21)]), // valor alto
  // unidade 4 sem boleto
  cob('5', '10/10/2026', [['1.5', 'Acordos', 500]], { st_label_recb: 'ACORDO' }),   // acordo fica fora
]);
const r = B.conferir([atual, ...hist]);
const tipos = r.alertas.map((a) => a.tipo + ':' + a.unidade);
assert.ok(tipos.includes('boleto_em_dobro:A 1'), 'dobro');
assert.ok(tipos.includes('leitura_zerada:A 2'), 'zerada');
assert.ok(tipos.includes('parcela_repetida:A 2'), 'parcela');
assert.ok(tipos.includes('valor_fora_padrao:A 3'), 'valor');
assert.ok(tipos.includes('sem_boleto:A 4'), 'sem boleto');
assert.ok(!tipos.some((t) => t.endsWith('A 5')), 'acordo fora');
assert.strictEqual(r.resumo.acordos_fora, 1);

// Leitura e rateio somem do condomínio inteiro: um alerta geral, sem um por unidade.
const atual2 = mes('10', ['1', '2', '3', '4'].map((u) => cob(u, '10/10/2026', [taxa])));
const r2 = B.conferir([atual2, ...hist]);
const geral = r2.alertas.filter((a) => a.unidade === 'Todas').map((a) => a.tipo).sort();
assert.deepStrictEqual(geral, ['leitura_faltando', 'rateio_sumiu']);
assert.ok(!r2.alertas.some((a) => a.unidade !== 'Todas' && a.tipo === 'leitura_faltando'));

// Rateio novo.
const atual3 = mes('10', ['1', '2', '3', '4'].map((u) => cob(u, '10/10/2026', [taxa, agua(40), obra(21), ['1.300', 'Rateio Extra Portão', 80]])));
assert.ok(B.conferir([atual3, ...hist]).alertas.some((a) => a.tipo === 'rateio_apareceu' && a.unidade === 'Todas'));

// Competência e classificação.
assert.strictEqual(B.competenciaValida('2026-13'), null);
assert.deepStrictEqual(B.competenciaValida('2026-01'), { ano: 2026, mes: 1 });
assert.deepStrictEqual(B.mesesAnteriores({ ano: 2026, mes: 1 }, 2), [{ ano: 2025, mes: 12 }, { ano: 2025, mes: 11 }]);
assert.deepStrictEqual(B.janela({ ano: 2026, mes: 2 }), { dtInicio: '02/01/2026', dtFim: '02/28/2026' });
assert.strictEqual(B.tipoItem('Gás'), 'leitura');
assert.strictEqual(B.tipoItem('Água Comum'), 'base');
assert.strictEqual(B.tipoItem('Fundo de Reserva'), 'base');
// Nada de dado pessoal na cobrança normalizada.
const n = B.normalizar(cob('9', '10/10/2026', [taxa], { st_nome_con: 'FULANO', st_senha_site_uni: 'x', proprietario_cpf: '1' }));
assert.ok(!JSON.stringify(n).includes('FULANO') && !('st_senha_site_uni' in n));
console.log('ok financeiro-boletos', r.alertas.length, 'alertas no caso 1');
