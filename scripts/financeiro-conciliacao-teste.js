// Testes da conciliação (T35): casamento sistema x banco, quadro, bloqueio, regras, OFX e a leitura
// do conciliacao/index (conta trocada é descartada). Sem rede. node scripts/financeiro-conciliacao-teste.js
'use strict';
const assert = require('assert');
const C = require('../public/conciliacao-casar.js');
const M = require('../financeiro/conciliacao.js');

let ok = 0;
function t(nome, fn) {
  try { fn(); ok++; } catch (e) { console.error('FALHOU: ' + nome + '\n  ' + (e && e.message)); process.exitCode = 1; }
}
const s = (data, v, descricao, extra) => Object.assign({ data, valor: C.centavos(v), descricao: descricao || 'x' }, extra || {});
const b = (data, v, descricao, extra) => Object.assign({ data, valor: C.centavos(v), descricao: descricao || 'y', desconsiderado: false }, extra || {});

t('centavos e datas', () => {
  assert.strictEqual(C.centavos('692.90000000005'), 69290);
  assert.strictEqual(C.centavos('-1.234,56'), -123456);
  assert.strictEqual(C.dataISO('09/30/2026'), '2026-09-30');
  assert.strictEqual(C.dataISO('20260930120000[-3:BRT]'), '2026-09-30');
  assert.strictEqual(C.dataISO('2026-09-30 00:00:00'), '2026-09-30');
  assert.strictEqual(C.diasUteisEntre('2026-10-16', '2026-10-20'), 2); // sábado e domingo fora
});
t('exato no mesmo dia', () => {
  const r = C.casar([s('2026-09-01', -100)], [b('2026-09-01', -100)]);
  assert.strictEqual(r.pares[0].tipo, 'exato');
  assert.strictEqual(r.soBanco.length + r.soSistema.length, 0);
});
t('grupo: um lançamento e vários itens do banco (folha em dois débitos)', () => {
  const r = C.casar([s('2026-09-04', -12073.02, 'FOLHA')], [b('2026-09-04', -10188), b('2026-09-04', -1885.02)]);
  assert.strictEqual(r.pares[0].tipo, 'grupo');
  assert.strictEqual(r.soBanco.length, 0);
});
t('grupo: dia inteiro com composição positiva e negativa', () => {
  const sis = [s('2026-09-14', 1000, 'Recebido'), s('2026-09-14', -4, 'Tarifa'), s('2026-09-14', 30, 'Fundo')];
  const r = C.casar(sis, [b('2026-09-14', 500), b('2026-09-14', 526)]);
  assert.strictEqual(r.soSistema.length, 0);
  assert.strictEqual(r.soBanco.length, 0);
});
t('rendimento: diário no banco contra mensal no sistema', () => {
  const ban = [b('2026-09-01', 37.89, 'CORREÇÃO MONETÁRIA - SELIC'), b('2026-09-01', 112.08, 'JUROS  - SELIC'), b('2026-09-01', -33.74, 'I.R.R.F APL. FIN - SELIC')];
  const sis = [s('2026-09-30', 149.97, 'Rendimentos Poupança', { origem: '3' }), s('2026-09-30', -33.74, 'IRRF Poupança', { origem: '3' })];
  const r = C.casar(sis, ban);
  assert.ok(r.pares.some((p) => p.tipo === 'rendimento'));
  const r2 = C.casar([s('2026-09-30', 100, 'Rendimentos Poupança', { origem: '3' })], ban);
  assert.strictEqual(r2.divergencias[0].tipo, 'rendimento_diferente');
  const r3 = C.casar([], ban, { mesFechado: () => false });
  assert.strictEqual(r3.soBanco.length, 3); // mês aberto: não acusa
});
t('data diferente da baixa e valor diferente', () => {
  const r = C.casar([s('2026-09-10', -500, 'Fornecedor A'), s('2026-09-12', -1000, 'Fornecedor B')], [b('2026-09-13', -500), b('2026-09-12', -1012.5)]);
  const d = r.pares.find((p) => p.tipo === 'data');
  assert.strictEqual(d.dias, 3);
  const v = r.pares.find((p) => p.tipo === 'valor');
  assert.strictEqual(v.diferenca, 1250);
});
t('valor muito diferente não vira par', () => {
  const r = C.casar([s('2026-09-12', -1000)], [b('2026-09-12', -2000)]);
  assert.strictEqual(r.soBanco.length, 1);
  assert.strictEqual(r.soSistema.length, 1);
});
t('estorno no banco anula', () => {
  const r = C.casar([], [b('2026-09-29', -215.91, 'PIX EMITIDO'), b('2026-09-29', 215.91, 'ESTORNO PIX EMITIDO')]);
  assert.strictEqual(r.soBanco.length, 0);
});
t('revisão 1 M1: PIX enviado e recebido de mesmo valor sem estorno na descrição não somem', () => {
  const r = C.casar([], [b('2026-09-10', -500, 'PIX EMITIDO OUTRA IF'), b('2026-09-11', 500, 'PIX RECEBIDO - OUTRA IF')]);
  assert.strictEqual(r.soBanco.length, 2);
  const r2 = C.casar([s('2026-09-08', -1000, 'Aplicação'), s('2026-09-09', 1000, 'Resgate')], [b('2026-09-10', -1000, 'APLICACAO'), b('2026-09-11', 1000, 'RESGATE')]);
  assert.strictEqual(r2.soSistema.length + r2.soBanco.length, 0);
});
t('revisão 1 M3: conta de pouco movimento marcada', () => {
  assert.strictEqual(C.quadroConta([], [b('2026-09-01', 1)], '2026-10-21').movimento_baixo, true);
});
t('lançado e desconsiderado; tarifas desconsideradas lançadas no mês', () => {
  const r = C.casar([s('2026-09-30', -30.85, 'SICOOB')], [b('2026-09-10', -30.85, 'DÉBITO PACOTE SERVIÇOS', { desconsiderado: true })]);
  assert.strictEqual(r.divergencias[0].tipo, 'lancado_e_desconsiderado');
  const r2 = C.casar([s('2026-09-30', -50, 'SICOOB')], [b('2026-09-01', -20, 'TARIFA COBRANÇA', { desconsiderado: true }), b('2026-09-02', -30, 'TARIFA COBRANÇA', { desconsiderado: true })]);
  assert.strictEqual(r2.divergencias[0].tipo, 'tarifas_desconsideradas_lancadas_no_mes');
  assert.strictEqual(r2.soSistema.length, 0);
});
t('quadro da conta: atraso, diferença e poupança no fim do mês', () => {
  const saldos = [{ data: '2026-09-28', sistema: 100000, banco: 100500 }, { data: '2026-09-30', sistema: 100500, banco: 100500 }];
  const q = C.quadroConta(saldos, [b('2026-09-28', 1)], '2026-10-21', [s('2026-09-30', 5, 'Rendimentos Poupança', { origem: '3' })]);
  assert.strictEqual(q.ultimo_extrato, '2026-09-28');
  assert.strictEqual(q.diferenca_saldo, 0);
  assert.strictEqual(q.dias_sem_extrato, 16);
  const q2 = C.quadroConta(saldos, [b('2026-09-28', 1)], '2026-10-21', [s('2026-09-29', -5, 'Fornecedor')]);
  assert.strictEqual(q2.diferenca_saldo, -500);
});
t('bloqueio de lançamentos', () => {
  assert.strictEqual(C.bloqueio('', '2026-10-21').sem_bloqueio, true);
  assert.strictEqual(C.bloqueio('09/30/2026 00:00:00', '2026-10-21').sem_bloqueio, false);
  assert.strictEqual(C.bloqueio('07/31/2026 00:00:00', '2026-10-21').meses_abertos, 2);
  assert.strictEqual(C.bloqueio('09/30/2024 00:00:00', '2026-10-21').meses_abertos, 24);
});
t('regras sugeridas', () => {
  const h = [];
  ['2026-07-10', '2026-08-10', '2026-09-10'].forEach((d) => {
    h.push({ descricao: 'TARIFA COBRANÇA', valor: -350, data: d, situacao: 'desconsiderado' });
    h.push({ descricao: 'DÉB.CONV.EN.ELÉTRICA E GÁS', valor: -14000, data: d, situacao: 'com_lancamento', descricao_sistema: 'EDP (123)' });
    h.push({ descricao: 'PIX EMITIDO OUTRA IF', valor: -1000, data: d, situacao: 'com_lancamento', descricao_sistema: 'Fornecedor ' + d });
    h.push({ descricao: 'TARIFA PAGAMENTO SALARIO', valor: -400, data: d, situacao: 'sem_lancamento' });
  });
  const r = C.sugerirRegras(h);
  const por = (p) => r.find((x) => x.padrao === C.normDesc(p));
  assert.strictEqual(por('TARIFA COBRANÇA').acao, 'desconsiderar');
  assert.strictEqual(por('DÉB.CONV.EN.ELÉTRICA E GÁS').acao, 'lancar');
  assert.ok(/EDP/.test(por('DÉB.CONV.EN.ELÉTRICA E GÁS').sugestao));
  assert.strictEqual(por('PIX EMITIDO OUTRA IF'), undefined); // genérico, cada vez um fornecedor
  assert.strictEqual(por('TARIFA PAGAMENTO SALARIO').acao, 'criar');
});
t('OFX: leitura e comparação', () => {
  const ofx = C.lerOfx('OFXHEADER:100\nCHARSET:1252\n<OFX><BANKACCTFROM><BANKID>756<ACCTID>123</BANKACCTFROM><BANKTRANLIST><DTSTART>20260901<DTEND>20260930'
    + '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260901120000[-3:BRT]<TRNAMT>-100.00<FITID>A1<MEMO>PIX EMITIDO</STMTTRN>'
    + '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260902<TRNAMT>-50,00<FITID>A2<MEMO>TARIFA</STMTTRN>'
    + '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260903<TRNAMT>300.00<FITID>A3<MEMO>PIX RECEBIDO</STMTTRN></BANKTRANLIST></OFX>');
  assert.strictEqual(ofx.itens.length, 3);
  assert.strictEqual(ofx.itens[1].valor, -5000);
  const imp = [b('2026-09-01', -100, 'PIX EMITIDO', { fitid: 'A1' }), b('2026-09-05', 77, 'OUTRO')];
  const sis = [s('2026-09-01', -100, 'Fornecedor'), s('2026-09-03', 300, 'Recebido')];
  const r = C.compararOfx(ofx, imp, sis);
  assert.strictEqual(r.ja_importados.length, 1);
  assert.strictEqual(r.novos_com_lancamento.length, 1);
  assert.strictEqual(r.novos_sem_lancamento.length, 1);
  assert.strictEqual(r.so_no_superlogica.length, 0); // 05/09 fica fora do período do arquivo (01 a 03)
  assert.throws(() => C.lerOfx('nada aqui'));
});
t('leitura do conciliacao/index: conta trocada é descartada; linha de saldo do extrato fica fora', () => {
  const j = { itens: [
    { data: '09/01/2026', fl_saldo: '1', saldo_anterior_software: '10.00', saldo_anterior_banco: '10.00' },
    { data_banco: '09/01/2026', valor_banco: '-5.00', descricao_banco: 'X', id_conta_banco: '635', desconsiderar_lancamento_banco: '0', data_software: '09/01/2026', valor_software: '-5.00', descricao_software: 'Y', id_conta_software: '635' },
    { data_banco: '09/01/2026', valor_banco: '42974.90', descricao_banco: 'SALDO ANTERIOR', id_conta_banco: '635' },
  ] };
  const d = M.normalizarConciliacao(j, '635', '2026-09-01', '2026-09-30');
  assert.strictEqual(d.descartada, false);
  assert.strictEqual(d.banco.length, 1);
  assert.strictEqual(d.sistema.length, 1);
  const e = M.normalizarConciliacao(j, '636', '2026-09-01', '2026-09-30');
  assert.strictEqual(e.descartada, true);
  assert.throws(() => M.normalizarConciliacao(null, '635', '2026-09-01', '2026-09-30'));
  assert.strictEqual(M.normalizarConciliacao([], '635', '2026-09-01', '2026-09-30').banco.length, 0);
});
t('conta só com campos seguros', () => {
  const k = M.enxugarConta({ id_contabanco_cb: '1', id_condominio_cond: '2', st_descricao_cb: 'Conta', st_token_cb: 'segredo', st_chavepjbank_cb: 'x', st_secret_cb: 'y', id_tipocontabanco_tcb: '3' });
  assert.ok(!JSON.stringify(k).includes('segredo'));
  assert.strictEqual(k.sem_extrato_esperado, true);
});
t('leitura por mês do calendário', () => {
  assert.deepStrictEqual(M.mesesDoPeriodo('2026-08-27', '2026-10-05'), ['2026-08', '2026-09', '2026-10']);
  assert.deepStrictEqual(M.mesesDoPeriodo('2025-12-30', '2026-01-02'), ['2025-12', '2026-01']);
  const p = M.juntarMeses([{ saldos: [], banco: [{ data: '2026-08-26' }, { data: '2026-08-28' }], sistema: [] }, { saldos: [], banco: [{ data: '2026-09-02' }], sistema: [] }], '2026-08-27', '2026-09-30');
  assert.strictEqual(p.banco.length, 2);
  assert.strictEqual(M.juntarMeses([{ descartada: true }, { saldos: [], banco: [], sistema: [] }], '2026-08-27', '2026-09-30').descartada, true);
});
t('meses anteriores e competência', () => {
  const m = M.mesesAnteriores('2026-01-15', 3);
  assert.deepStrictEqual(m.map((x) => x.rotulo), ['2025-10', '2025-11', '2025-12']);
  assert.strictEqual(M.competencia('2026-13'), null);
});

// Serviço com cliente falso: só GET, no máximo 2 chamadas ao mesmo tempo, conta errada descartada.
(async () => {
  let ativos = 0, pico = 0;
  const chamadas = [];
  const cliente = { get: async (action, p) => {
    chamadas.push(action);
    ativos++; pico = Math.max(pico, ativos);
    await new Promise((r) => setTimeout(r, 5));
    ativos--;
    if (action === 'contabancos/index') return [1, 2, 3, 4].map((i) => ({ id_contabanco_cb: String(i), id_condominio_cond: '10', st_descricao_cb: 'Conta ' + i, id_tipocontabanco_tcb: i === 4 ? '3' : '1' }));
    if (action === 'condominios/get') return [{ id_condominio_cond: '10', st_fantasia_cond: 'Teste' }];
    if (action === 'conciliacao/index') {
      const conta = p.idConta === '3' ? '99' : p.idConta; // a conta 3 volta com linhas de outra conta
      return { itens: [{ data_banco: '09/02/2026', valor_banco: '-10.00', descricao_banco: 'TARIFA', id_conta_banco: conta, desconsiderar_lancamento_banco: '0' }] };
    }
    return [];
  } };
  const svc = M.criarConciliacao({ cliente: () => cliente, hoje: () => '2026-10-21' });
  const r = await svc.condominio('10', '2026-09');
  const sit = Object.fromEntries(r.contas.map((k) => [k.id, k.situacao]));
  t('serviço: situações das contas', () => {
    assert.strictEqual(sit['1'], 'ok');
    assert.strictEqual(sit['3'], 'descartada');
    assert.strictEqual(sit['4'], 'conta_caixa');
    assert.strictEqual(r.contas[0].banco_sem_lancamento.length, 1);
  });
  t('serviço: no máximo 2 chamadas ao mesmo tempo e só leitura', () => {
    assert.ok(pico <= 2, 'pico ' + pico);
    assert.ok(chamadas.every((a) => /\/(index|get)$/.test(a)));
  });
  const n = chamadas.length;
  await svc.condominio('10', '2026-09');
  t('serviço: cache de 10 minutos', () => assert.strictEqual(chamadas.length, n));
  const q = await svc.quadro(['10', '143']);
  t('serviço: quadro sem os cadastros que não são condomínio', () => {
    assert.strictEqual(q.condominios.length, 1);
    assert.strictEqual(q.condominios[0].contas_com_extrato, 2);
  });
  let erro = null;
  try { await svc.quadro(Array.from({ length: 81 }, (_, i) => String(i + 1))); } catch (e) { erro = e; }
  t('serviço: limite de condomínios no quadro', () => assert.strictEqual(erro && erro.codigo, 'muitos_condominios'));
  // M2: erro do Superlógica não vira mensagem de mês ou de conta
  const ruim = M.criarConciliacao({ cliente: () => ({ get: async () => { const e = new Error('superlogica_404'); e.status = 404; throw e; } }), hoje: () => '2026-10-21' });
  let e2 = null;
  try { await ruim.itensConta('10', '1', '2026-09-01', '2026-09-30'); } catch (e) { e2 = e; }
  t('revisão 1 M2: erro do Superlógica sem código do módulo', () => { assert.ok(e2); assert.strictEqual(e2.codigo, undefined); });
  // Revisão 2 M1: leitura do quadro ainda na fila baixa é promovida
  const f2 = M._criarFila(1);
  const ordem2 = [];
  const q1 = f2(() => new Promise((r) => setTimeout(r, 10)).then(() => ordem2.push('a')), true);
  const q2 = f2(async () => ordem2.push('b'), true);
  const q3 = f2(async () => ordem2.push('c'), true);
  q3.promover();
  await Promise.all([q1, q2, q3]);
  t('revisão 2: promover passa na frente', () => assert.deepStrictEqual(ordem2, ['a', 'c', 'b']));
  t('revisão 2: transferência genérica sem estorno não some', () => {
    const r = C.casar([], [b('2026-09-10', -500, 'TRANSF ENTRE CONTAS'), b('2026-09-10', 500, 'TRANSF ENTRE CONTAS')]);
    assert.strictEqual(r.soBanco.length, 2);
  });
  // M4: leitura de condomínio passa na frente do quadro
  const fila = M._criarFila ? M._criarFila(1) : null;
  if (fila) {
    const ordem = [];
    const p1 = fila(() => new Promise((r) => setTimeout(r, 10)).then(() => ordem.push('primeira')), true);
    const p2 = fila(async () => ordem.push('quadro'), true);
    const p3 = fila(async () => ordem.push('condominio'));
    await Promise.all([p1, p2, p3]);
    t('revisão 1 M4: prioridade da leitura do condomínio', () => assert.deepStrictEqual(ordem, ['primeira', 'condominio', 'quadro']));
  }
  console.log(ok + ' testes ok' + (process.exitCode ? ' (com falhas)' : ''));
})();
