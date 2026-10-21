'use strict';
// Testes locais do conector do banco (T36), sem rede: node scripts/teste-financeiro-banco.js
// Arquivos de exemplo montados a partir do layout FEBRABAN e dos guias do Sicoob (testes/T36/documentacao.md).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const raiz = path.join(__dirname, '..');
const C = require(path.join(raiz, 'financeiro', 'banco', 'comum'));
const S = require(path.join(raiz, 'financeiro', 'banco', 'sicoob'));
const E = require(path.join(raiz, 'financeiro', 'banco', 'extrato'));
const R = require(path.join(raiz, 'financeiro', 'banco', 'cnab240'));
const D = require(path.join(raiz, 'financeiro', 'banco', 'dda'));
const B = require(path.join(raiz, 'financeiro', 'banco', 'index'));

let n = 0;
const ok = (nome, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('ok ' + nome); });

// Monta um registro de 240 posições: pares [inicio, texto] nas posições do manual (1 a 240).
function reg(pares) {
  const a = Array(240).fill(' ');
  pares.forEach(([ini, v]) => { String(v).split('').forEach((ch, i) => { a[ini - 1 + i] = ch; }); });
  return a.join('');
}
const z = (v, t) => String(v).padStart(t, '0');
const b = (v, t) => String(v).padEnd(t, ' ').slice(0, t);

// Código de barras de boleto válido: banco, moeda 9, fator, valor (centavos), campo livre.
function boleto(banco, fator, centavos, livre) {
  const sem = banco + '9' + z(fator, 4) + z(centavos, 10) + z(livre, 25);
  const dv = C.mod11Boleto(sem);
  return sem.slice(0, 4) + dv + sem.slice(4);
}
// Arrecadação (concessionária) com valor real (terceiro dígito 6, módulo 10).
function arrecadacao(seg, centavos, resto) {
  const sem = '8' + seg + '6' + z(centavos, 11) + z(resto, 29);
  return sem.slice(0, 3) + C.mod10(sem) + sem.slice(3);
}

const CB1 = boleto('341', 1234, 150000, '1234567890123456789012345'); // R$ 1.500,00
const CB2 = boleto('237', 1250, 9999, '9999999990000000000000001');   // R$ 99,99
const CB3 = arrecadacao('2', 23456, '00000000000000000000000000123'); // CESAN R$ 234,56
const CB4 = boleto('001', 1300, 50000, '5555555555555555555555555');  // R$ 500,00 sem despesa

function montarRetorno() {
  const L = [];
  L.push(reg([[1, '756'], [4, '0000'], [8, '0'], [18, '2'], [19, '33955806000192'], [33, b('CONV123', 20)], [53, '03007'], [59, z('374075', 12)], [71, '5'], [73, b('RESIDENCIAL TESTE', 30)], [103, b('SICOOB', 30)], [143, '2'], [144, '21102026'], [152, '101500'], [158, z(77, 6)], [164, '087']]));
  // Lote 1: títulos (J + J52)
  L.push(reg([[1, '756'], [4, '0001'], [8, '1'], [9, 'C'], [10, '20'], [12, '31'], [14, '040']]));
  L.push(reg([[1, '756'], [4, '0001'], [8, '3'], [9, z(1, 5)], [14, 'J'], [15, '0'], [16, '00'], [18, CB1], [62, b('ELEVADORES SA', 30)], [92, '10102026'], [100, z(150000, 15)], [115, z(0, 15)], [130, z(3000, 15)], [145, '13102026'], [153, z(153000, 15)], [183, b('', 20)], [231, '00']]));
  L.push(reg([[1, '756'], [4, '0001'], [8, '3'], [9, z(2, 5)], [14, 'J'], [15, '0'], [16, '00'], [18, '52'], [20, '2'], [21, z('33955806000192', 15)], [36, b('RESIDENCIAL TESTE', 40)], [76, '2'], [77, z('07707650000110', 15)], [92, b('ELEVADORES SA', 40)]]));
  L.push(reg([[1, '756'], [4, '0001'], [8, '3'], [9, z(3, 5)], [14, 'J'], [15, '0'], [16, '00'], [18, CB2], [62, b('LIMPEZA LTDA', 30)], [92, '15102026'], [100, z(9999, 15)], [145, '15102026'], [153, z(9999, 15)], [231, '01']]));
  L.push(reg([[1, '756'], [4, '0001'], [8, '3'], [9, z(4, 5)], [14, 'J'], [15, '0'], [16, '00'], [18, CB4], [62, b('FORNECEDOR X', 30)], [92, '16102026'], [100, z(50000, 15)], [145, '16102026'], [153, z(50000, 15)], [231, '00']]));
  L.push(reg([[1, '756'], [4, '0001'], [8, '5'], [18, z(6, 6)], [24, z(153000 + 9999 + 50000, 18)]]));
  // Lote 2: TED (A) com data e valor reais
  L.push(reg([[1, '756'], [4, '0002'], [8, '1'], [9, 'C'], [10, '20'], [12, '41'], [14, '045']]));
  L.push(reg([[1, '756'], [4, '0002'], [8, '3'], [9, z(1, 5)], [14, 'A'], [15, '0'], [16, '00'], [21, '104'], [24, '01234'], [30, z('99887766', 12)], [44, b('JOAO DIARISTA', 30)], [74, b('88001', 20)], [94, '14102026'], [102, 'BRL'], [120, z(32000, 15)], [155, '14102026'], [163, z(32000, 15)], [231, '00']]));
  L.push(reg([[1, '756'], [4, '0002'], [8, '5'], [18, z(3, 6)], [24, z(32000, 18)]]));
  // Lote 3: concessionária (O)
  L.push(reg([[1, '756'], [4, '0003'], [8, '1'], [9, 'C'], [10, '20'], [12, '11'], [14, '012']]));
  L.push(reg([[1, '756'], [4, '0003'], [8, '3'], [9, z(1, 5)], [14, 'O'], [15, '0'], [16, '00'], [18, CB3], [62, b('CESAN', 30)], [92, '20102026'], [100, '20102026'], [108, z(23456, 15)], [231, '00']]));
  L.push(reg([[1, '756'], [4, '0003'], [8, '5'], [18, z(3, 6)], [24, z(23456, 18)]]));
  L.push(reg([[1, '756'], [4, '9999'], [8, '9'], [18, z(3, 6)], [24, z(L.length + 1, 6)]]));
  return L.join('\r\n') + '\r\n';
}

// Despesas no formato bruto do Superlógica (datas MM/DD/AAAA).
const DESPESAS = [
  { id_despesa_des: '501', id_parcela_pdes: '9001', id_condominio_cond: '167', st_nome_con: 'ELEVADORES SA', st_cpf_con: '07707650000110', vl_valor_pdes: '1500.00', dt_vencimento_pdes: '10/10/2026', dt_liquidacao_pdes: '10/10/2026', st_codigobarras_pdes: C.linhaDigitavel(CB1), fl_liquidado_pdes: '1' },
  { id_despesa_des: '502', id_parcela_pdes: '9002', id_condominio_cond: '167', st_nome_con: 'LIMPEZA LTDA', vl_valor_pdes: '99.99', dt_vencimento_pdes: '10/15/2026', dt_liquidacao_pdes: '10/15/2026', st_codigobarras_pdes: CB2, fl_liquidado_pdes: '1' },
  { id_despesa_des: '503', id_parcela_pdes: '88001', id_condominio_cond: '167', st_nome_con: 'JOAO DIARISTA', vl_valor_pdes: '320.00', dt_vencimento_pdes: '10/14/2026', dt_liquidacao_pdes: '', st_codigobarras_pdes: '', fl_liquidado_pdes: '0' },
  { id_despesa_des: '504', id_parcela_pdes: '9004', id_condominio_cond: '167', st_nome_con: 'CESAN', vl_valor_pdes: '234.56', dt_vencimento_pdes: '10/20/2026', dt_liquidacao_pdes: '10/20/2026', st_codigobarras_pdes: C.linhaDigitavel(CB3), fl_liquidado_pdes: '1' },
  { id_despesa_des: '505', id_parcela_pdes: '9005', id_condominio_cond: '167', st_nome_con: 'OUTRA', vl_valor_pdes: '10.00', dt_vencimento_pdes: '10/01/2026', dt_liquidacao_pdes: '10/01/2026', st_codigobarras_pdes: '', fl_liquidado_pdes: '1' },
];

(async () => {
  await ok('centavos sem erro de ponto flutuante', () => {
    assert.strictEqual(C.centavos('1.234,56'), 123456);
    assert.strictEqual(C.centavos('1234.56'), 123456);
    assert.strictEqual(C.centavos(0.1 + 0.2), 30);
    assert.strictEqual(C.centavos('-10,00'), -1000);
    assert.strictEqual(C.centavos('abc'), null);
    assert.strictEqual(C.centavosCnab('000000000153000'), 153000);
    assert.strictEqual(C.dataCnab('31022026'), null);
    assert.strictEqual(C.dataCnab('00000000'), null);
    assert.strictEqual(C.fmtBRL(123456), 'R$ 1.234,56');
  });
  await ok('codigo de barras e linha digitavel ida e volta', () => {
    [CB1, CB2, CB3, CB4].forEach((cb) => {
      assert(C.codigoBarrasValido(cb), 'dv ' + cb);
      const ld = C.linhaDigitavel(cb);
      assert.strictEqual(ld.length, cb[0] === '8' ? 48 : 47);
      assert.strictEqual(C.codigoBarras(ld), cb);
      assert.strictEqual(C.codigoBarras(ld.replace(/(\d{5})(\d{5})/, '$1.$2 ')), cb);
    });
    const errado = CB1.slice(0, 20) + (CB1[20] === '1' ? '2' : '1') + CB1.slice(21);
    assert(!C.codigoBarrasValido(errado));
    assert.strictEqual(C.valorDoCodigo(CB1), 150000);
    assert.strictEqual(C.valorDoCodigo(CB3), 23456);
    assert.strictEqual(C.vencimentoDoCodigo(boleto('756', 1000, 1, '0'), '2025-03-01'), '2025-02-22');
    assert.strictEqual(C.vencimentoDoCodigo(boleto('756', 9999, 1, '0'), '2025-02-01'), '2025-02-21');
    assert.strictEqual(C.finalConta('000000374075'), '***4075');
  });

  // ── Sicoob: desligado, sem vazamento ──
  await ok('sicoob desligado sem variaveis e sem erro', async () => {
    const st = S.status({});
    assert.strictEqual(st.ligado, false);
    assert.deepStrictEqual(st.variaveis_faltando, S.VARIAVEIS);
    const cli = S.criarClienteSicoob({ env: {}, transporte: () => { throw new Error('não deveria chamar'); } });
    assert.strictEqual(cli.ligado, false);
    await assert.rejects(cli.extrato({ mes: 10, ano: 2026, conta: '86584' }), (e) => e.codigo === 'banco_desligado');
    await assert.rejects(cli.saldo({ conta: '1' }), (e) => e.codigo === 'banco_desligado' || e.codigo === 'conta_invalida');
  });

  const SEGREDO_ID = 'cid-SEGREDO-123';
  const SENHA = 'senha-SEGREDO-456';
  const PFX_FALSO = Buffer.alloc(300, 7).toString('base64');
  const envFalso = { SICOOB_CLIENT_ID: SEGREDO_ID, SICOOB_CERT_PFX_BASE64: PFX_FALSO, SICOOB_CERT_SENHA: SENHA };
  const TOKEN = 'tok-SEGREDO-789';
  const vazou = (s) => [SEGREDO_ID, SENHA, TOKEN, PFX_FALSO.slice(0, 40)].some((t) => String(s).includes(t));

  await ok('sicoob config nao expoe segredo', () => {
    const cfg = S.lerConfig(envFalso);
    assert.strictEqual(cfg.ligado, true);
    assert(!vazou(JSON.stringify(cfg)));
    assert(!vazou(require('util').inspect(cfg)));
    const st = S.status(envFalso); // pfx falso não abre
    assert.strictEqual(st.ligado, false);
    assert.strictEqual(st.problema, 'certificado_ou_senha_invalidos');
    assert(!vazou(JSON.stringify(st)));
    assert.strictEqual(S.lerConfig({ ...envFalso, SICOOB_CERT_PFX_BASE64: 'abc' }).problema, 'certificado_ilegivel');
  });

  await ok('sicoob token, extrato, cache, conta sem hifen, sem vazamento em erro e log', async () => {
    const chamadas = []; const logs = [];
    let t = 1000000;
    const transporte = async (req) => {
      chamadas.push(req);
      if (req.host === 'auth.sicoob.com.br') return { status: 200, corpo: JSON.stringify({ access_token: TOKEN, expires_in: 300 }) };
      if (req.caminho.startsWith('/conta-corrente/v4/extrato/10/2026')) return { status: 200, corpo: JSON.stringify({ resultado: { saldoAnterior: '100.00', saldoAtual: '150.00', transacoes: [{ tipo: 'CREDITO', valor: '80.00', data: '2026-10-02T00:00:00', descricao: 'PIX RECEBIDO', numeroDocumento: '123' }, { tipo: 'DEBITO', valor: '-30.00', data: '2026-10-03T00:00:00', descricao: 'TARIFA' }] } }) };
      if (req.caminho.startsWith('/conta-corrente/v4/saldo')) return { status: 500, corpo: 'erro interno ' + req.cabecalhos.Authorization };
      return { status: 404, corpo: '' };
    };
    const cli = S.criarClienteSicoob({ env: envFalso, transporte, agora: () => t, log: (m) => logs.push(m) });
    assert(!vazou(JSON.stringify(cli)));
    const ext = await cli.extrato({ mes: 10, ano: 2026, conta: '8658-4' });
    assert.strictEqual(chamadas[0].metodo, 'POST');
    assert.strictEqual(chamadas[0].caminho, S.CAMINHO_TOKEN);
    assert(/grant_type=client_credentials/.test(chamadas[0].corpo));
    assert(/scope=cco_extrato\+openid|scope=cco_extrato%20openid/.test(chamadas[0].corpo));
    assert.strictEqual(chamadas[1].metodo, 'GET');
    assert(chamadas[1].caminho.includes('numeroContaCorrente=86584'));
    assert(chamadas[1].caminho.includes('diaInicial=1') && chamadas[1].caminho.includes('diaFinal=31'));
    assert.strictEqual(chamadas[1].cabecalhos.Authorization, 'Bearer ' + TOKEN);
    await cli.extrato({ mes: 10, ano: 2026, conta: '86584', diaInicial: 5, diaFinal: 6 });
    assert.strictEqual(chamadas.filter((c) => c.host === 'auth.sicoob.com.br').length, 1, 'token em cache');
    t += 290 * 1000; // faltando menos de 30 s para vencer: renova
    await cli.extrato({ mes: 10, ano: 2026, conta: '86584' });
    assert.strictEqual(chamadas.filter((c) => c.host === 'auth.sicoob.com.br').length, 2, 'token renovado');
    const n1 = E.normalizarExtratoSicoob(ext);
    assert.strictEqual(n1.conferencia.fecha, true);
    let erro;
    try { await cli.saldo({ conta: '86584' }); } catch (e) { erro = e; }
    assert.strictEqual(erro.codigo, 'banco_erro');
    assert(!vazou(erro.message) && !vazou(JSON.stringify(erro)) && !vazou(require('util').inspect(erro)));
    assert(!logs.some(vazou), 'log sem segredo');
    await assert.rejects(cli.extrato({ mes: 13, ano: 2026, conta: '1' }), (e) => e.codigo === 'mes_invalido');
    await assert.rejects(cli.extrato({ mes: 2, ano: 2026, diaFinal: 30, conta: '12' }), (e) => e.codigo === 'dia_invalido');
    await assert.rejects(cli.dda({ dataInicial: '2026-10-10', dataFinal: '2026-10-01' }), (e) => e.codigo === 'periodo_invalido');
  });

  await ok('sicoob token recusado e queda de conexao sem detalhe', async () => {
    const cli = S.criarClienteSicoob({ env: envFalso, transporte: async () => ({ status: 401, corpo: '{"error":"invalid_client","client_id":"' + SEGREDO_ID + '"}' }) });
    await assert.rejects(cli.saldo({ conta: '86584' }), (e) => e.codigo === 'token_recusado' && !vazou(e.message) && !vazou(JSON.stringify(e)));
    const cli2 = S.criarClienteSicoob({ env: envFalso, transporte: async () => { throw new Error('socket hang up ' + SENHA); } });
    await assert.rejects(cli2.saldo({ conta: '86584' }), (e) => e.codigo === 'banco_sem_conexao' && !vazou(e.message) && !vazou(e.stack));
  });

  await ok('sicoob certificado real de teste abre (openssl, fora do git)', () => {
    let tmp;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't36-'));
      const k = path.join(tmp, 'k.pem'); const c = path.join(tmp, 'c.pem'); const p = path.join(tmp, 'c.pfx');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', k, '-out', c, '-days', '1', '-subj', '/CN=teste-hub'], { stdio: 'ignore' });
      execFileSync('openssl', ['pkcs12', '-export', '-inkey', k, '-in', c, '-out', p, '-passout', 'pass:teste123'], { stdio: 'ignore' });
      const env = { SICOOB_CLIENT_ID: 'x', SICOOB_CERT_PFX_BASE64: fs.readFileSync(p).toString('base64'), SICOOB_CERT_SENHA: 'teste123' };
      const st = S.status(env);
      assert.strictEqual(st.ligado, true);
      assert.strictEqual(st.certificado_abre, true);
      assert.strictEqual(S.status({ ...env, SICOOB_CERT_SENHA: 'errada' }).ligado, false);
    } catch (e) {
      if (e && e.code === 'ENOENT') { console.log('   (openssl ausente, pulado)'); return; }
      throw e;
    } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await ok('sicoob so hosts oficiais e so GET na API', () => {
    assert.deepStrictEqual(S.HOSTS_PERMITIDOS, ['auth.sicoob.com.br', 'api.sicoob.com.br']);
    const fonte = fs.readFileSync(path.join(raiz, 'financeiro', 'banco', 'sicoob.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert(!/console\.(log|warn|error)/.test(fonte), 'sicoob.js não usa console');
    assert(!/process\.env\.SICOOB_\w+/.test(fonte), 'lê só por lerConfig');
  });

  // ── Extrato ──
  const RESP = { resultado: { saldoAnterior: 1000.5, saldoAtual: '1.100,50', transacoes: [
    { tipo: 'CREDITO', valor: '200,00', dataLancamento: '01/10/2026', descricao: 'TAXA CONDOMINIO', descInfComplementar: 'PJBANK', numeroDocumento: '555' },
    { tipo: 'DEBITO', valor: '80,10', dataLancamento: '02/10/2026', descricao: 'CESAN AGUA' },
    { tipo: 'DEBITO', valor: '80,10', dataLancamento: '02/10/2026', descricao: 'CESAN AGUA' },
    { tipo: 'CREDITO', valor: '60,20', dataLancamento: '05/10/2026', descricao: 'RENDIMENTO POUPANCA' },
    { valor: null, dataLancamento: '05/10/2026' },
  ] } };
  await ok('extrato sicoob normaliza e confere saldo', () => {
    const ext = E.normalizarExtratoSicoob(RESP);
    assert.strictEqual(ext.itens.length, 4);
    assert.strictEqual(ext.avisos.length, 1);
    assert.strictEqual(ext.conferencia.creditos_centavos, 26020);
    assert.strictEqual(ext.conferencia.debitos_centavos, 16020);
    assert.strictEqual(ext.conferencia.fecha, true);
    assert.notStrictEqual(ext.itens[1].id, ext.itens[2].id, 'lançamentos iguais com ids diferentes');
    assert.strictEqual(E.normalizarExtratoSicoob(RESP).itens[2].id, ext.itens[2].id, 'id estável');
    const ruim = E.normalizarExtratoSicoob({ saldoAnterior: '0', saldoAtual: '10', transacoes: [{ tipo: 'C', valor: '9.99', data: '2026-10-01' }] });
    assert.strictEqual(ruim.conferencia.fecha, false);
    assert.strictEqual(ruim.conferencia.diferenca_centavos, -1);
  });
  await ok('extrato para conciliacao e para OFX ida e volta', () => {
    const ext = E.normalizarExtratoSicoob(RESP);
    const conc = E.paraConciliacao(ext, { idCondominio: 167, idConta: 823, origem: 'sicoob_api' });
    assert.deepStrictEqual(Object.keys(conc[0]), E.FORMATO_ITEM);
    assert.strictEqual(conc[1].valor, -80.1);
    assert.strictEqual(conc[1].valor_centavos, -8010);
    assert.strictEqual(conc.reduce((s, i) => s + i.valor_centavos, 0), 10000);
    const ofx = E.paraOFX(ext, { agencia: '3007', conta: '374075', geradoEm: '2026-10-21' });
    assert(ofx.startsWith('OFXHEADER:100'));
    assert(/<BANKID>756/.test(ofx) && /<TRNAMT>-80.10/.test(ofx) && /<BALAMT>1100.50/.test(ofx));
    assert(!/[^\x00-\x7F]/.test(ofx), 'OFX só ASCII');
    const lido = E.lerOFX(ofx);
    assert.strictEqual(lido.itens.length, 4);
    assert.deepStrictEqual(lido.itens.map((i) => [i.data, i.tipo, i.centavos]), ext.itens.map((i) => [i.data, i.tipo, i.centavos]));
    assert.deepStrictEqual(lido.itens.map((i) => i.id), ext.itens.map((i) => i.id));
    assert.strictEqual(lido.saldoAtualCentavos, 110050);
    assert.strictEqual(lido.conta_final, '***4075');
    assert.throws(() => E.paraOFX({ itens: [] }), /extrato_vazio/);
  });
  await ok('extrato CNAB 240 segmento E', () => {
    const L = [
      reg([[1, '756'], [4, '0000'], [8, '0'], [143, '2'], [164, '087']]),
      reg([[1, '756'], [4, '0001'], [8, '1'], [9, 'E'], [10, '04'], [12, '40'], [14, '033'], [59, z('374075', 12)], [143, '30092026'], [151, z(100000, 18)], [169, 'C'], [170, 'F'], [171, 'BRL']]),
      reg([[1, '756'], [4, '0001'], [8, '3'], [9, z(1, 5)], [14, 'E'], [135, '01102026'], [143, '01102026'], [151, z(25000, 18)], [169, 'C'], [170, '201'], [173, '0001'], [177, b('DEPOSITO', 25)], [202, b('000123', 39)]]),
      reg([[1, '756'], [4, '0001'], [8, '3'], [9, z(2, 5)], [14, 'E'], [135, '02102026'], [143, '02102026'], [151, z(5000, 18)], [169, 'D'], [170, '105'], [173, '0002'], [177, b('TARIFA', 25)]]),
      reg([[1, '756'], [4, '0001'], [8, '5'], [143, '02102026'], [151, z(120000, 18)], [169, 'C'], [171, z(4, 6)], [177, z(5000, 18)], [195, z(25000, 18)]]),
      reg([[1, '756'], [4, '9999'], [8, '9'], [18, z(1, 6)], [24, z(6, 6)]]),
    ].join('\n');
    const r = E.lerExtratoCnab240(L);
    assert.strictEqual(r.avisos.length, 0);
    assert.strictEqual(r.contas.length, 1);
    const c = r.contas[0];
    assert.strictEqual(c.conta_final, '***4075');
    assert.strictEqual(c.itens.length, 2);
    assert.strictEqual(c.conferencia.fecha, true);
    assert.strictEqual(E.paraConciliacao(c, { origem: 'cnab240' })[1].valor, -50);
  });

  // ── Retorno de pagamento ──
  const TXT = montarRetorno();
  const ret = R.lerRetornoPagamento(TXT);
  await ok('retorno CNAB 240 lido com segmentos J, J52, A e O', () => {
    assert.deepStrictEqual(ret.erros, []);
    assert.deepStrictEqual(ret.avisos, []);
    assert.strictEqual(ret.arquivo.retorno, true);
    assert.strictEqual(ret.arquivo.banco, '756');
    assert.strictEqual(ret.arquivo.conta_final, '***4075');
    assert(!JSON.stringify(ret).includes('374075'), 'conta inteira não aparece');
    assert.strictEqual(ret.arquivo.data_geracao, '2026-10-21');
    assert.strictEqual(ret.lotes.length, 3);
    assert.strictEqual(ret.pagamentos.length, 5);
    const [j1, j2, j3, a1, o1] = ret.pagamentos;
    assert.strictEqual(j1.codigo_barras, CB1);
    assert.strictEqual(j1.valor_centavos, 153000);
    assert.strictEqual(j1.valor_titulo_centavos, 150000);
    assert.strictEqual(j1.acrescimo_centavos, 3000);
    assert.strictEqual(j1.data_efetiva, '2026-10-13');
    assert.strictEqual(j1.efetivado, true);
    assert.strictEqual(j1.beneficiario_doc, '07707650000110', 'CNPJ começando com zero preservado');
    assert.strictEqual(j1.pagador_doc, '33955806000192');
    assert.strictEqual(j1.linha_digitavel, C.linhaDigitavel(CB1));
    assert.strictEqual(j2.efetivado, false);
    assert.strictEqual(j2.rejeitado, true);
    assert.strictEqual(j2.ocorrencias[0].texto, 'Saldo insuficiente');
    assert.strictEqual(a1.segmento, 'A');
    assert.strictEqual(a1.valor_pago_centavos, 32000);
    assert.strictEqual(a1.conta_favorecido_final, '***7766');
    assert.strictEqual(o1.segmento, 'O');
    assert.strictEqual(o1.valor_centavos, 23456);
    assert.strictEqual(o1.data_efetiva, '2026-10-20');
    assert(o1.codigo_barras_valido);
  });
  await ok('retorno com problemas vira aviso e nao quebra', () => {
    const quebrado = TXT.replace(z(153000 + 9999 + 50000, 18), z(1, 18));
    const r = R.lerRetornoPagamento(quebrado);
    assert(r.avisos.some((a) => /soma do trailer/.test(a)));
    const remessa = TXT.replace(/^(.{142})2/, '$11');
    const r2 = R.lerRetornoPagamento(remessa);
    assert.strictEqual(r2.arquivo.retorno, false);
    assert(r2.avisos.some((a) => /remessa/.test(a)));
    assert(R.lerRetornoPagamento('').erros.length);
    assert(R.lerRetornoPagamento('isso nao e cnab').erros.length);
  });
  await ok('conferencia pagamento x despesa', () => {
    const c = R.conferirPagamentos(ret, DESPESAS, { cnpjCondominio: '33.955.806/0001-92' });
    const por = (seg, cb) => c.resultados.find((r) => r.segmento === seg && (!cb || r.linha_digitavel === C.linhaDigitavel(cb)));
    const r1 = por('J', CB1);
    assert.strictEqual(r1.situacao, 'divergente');
    assert.strictEqual(r1.casou_por, 'codigo_barras');
    assert.strictEqual(r1.despesa.id_parcela, 9001);
    const maior = r1.achados.find((x) => x.tipo === 'pago_a_maior');
    assert.strictEqual(maior.diferenca_centavos, 3000);
    assert(r1.achados.find((x) => x.tipo === 'data_baixa_diferente').dias === -3);
    const r2 = por('J', CB2);
    assert.strictEqual(r2.situacao, 'rejeitado');
    assert.strictEqual(r2.achados[0].tipo, 'baixa_sem_pagamento');
    assert.strictEqual(r2.gravidade, 'alta');
    const r4 = por('J', CB4);
    assert.strictEqual(r4.situacao, 'pago_sem_despesa');
    const ra = por('A');
    assert.strictEqual(ra.casou_por, 'seu_numero');
    assert.strictEqual(ra.achados[0].tipo, 'sem_baixa');
    const ro = por('O');
    assert.strictEqual(ro.situacao, 'confere');
    assert.strictEqual(c.resumo.pagamentos, 5);
    assert.strictEqual(c.resumo.efetivados, 4);
    assert.strictEqual(c.resumo.total_pago_centavos, 153000 + 50000 + 32000 + 23456);
    assert.strictEqual(c.resumo.despesas_sem_pagamento_no_arquivo, 1);
  });
  await ok('conferencia: beneficiario e pagador diferentes, codigo trocado e ambiguo', () => {
    const p = ret.pagamentos[0];
    const desp = [{ ...DESPESAS[0], st_cpf_con: '11111111000111' }];
    const c1 = R.conferirPagamentos([p], desp, { cnpjCondominio: '00000000000191' });
    const t = c1.resultados[0].achados.map((x) => x.tipo);
    assert(t.includes('beneficiario_diferente') && t.includes('pagador_diferente'));
    assert.strictEqual(c1.resultados[0].gravidade, 'alta');
    // Mesmo valor e data, código de barras de outro boleto: casa fraco e acusa troca.
    const outro = { ...DESPESAS[0], st_codigobarras_pdes: CB4, vl_valor_pdes: '1530.00', dt_liquidacao_pdes: '10/13/2026' };
    const c2 = R.conferirPagamentos([p], [outro]);
    assert.strictEqual(c2.resultados[0].casou_por, 'valor_e_data');
    assert(c2.resultados[0].achados.some((x) => x.tipo === 'codigo_barras_diferente'));
    // Dois candidatos iguais por valor e data: não escolhe sozinho.
    const semCb = { ...p, codigo_barras: null, seu_numero: null };
    const dup = [{ ...outro, st_codigobarras_pdes: '', id_parcela_pdes: '1' }, { ...outro, st_codigobarras_pdes: '', id_parcela_pdes: '2' }];
    const c3 = R.conferirPagamentos([semCb], dup);
    assert.strictEqual(c3.resultados[0].situacao, 'ambiguo');
    // Formato fin_parcelas também serve.
    const fin = [{ id_parcela: 9001, id_despesa: 501, id_condominio: 167, valor: 1530, dt_vencimento: '2026-10-10', dt_liquidacao: '2026-10-13', liquidada: true, codigo_barras: CB1 }];
    assert.strictEqual(R.conferirPagamentos([p], fin).resultados[0].situacao, 'confere');
  });

  // ── DDA ──
  await ok('DDA interface: formato a definir, json funciona e cruza', () => {
    assert.throws(() => D.lerDDA('[]', {}), (e) => e.message === 'formato_dda_nao_definido' && e.formatos.includes('json'));
    const bols = D.lerDDA(JSON.stringify([
      { linhaDigitavel: C.linhaDigitavel(CB1), beneficiario: 'ELEVADORES SA', cpfCnpjBeneficiario: '07707650000110', dataVencimento: '2026-10-10', valor: 1500 },
      { codigoBarras: CB4, dataVencimento: '16/10/2026', cpfCnpjPagador: '99999999000199' },
      { valor: 320, dataVencimento: '2026-10-14' },
      { lixo: true },
    ]), { formato: 'json' });
    assert.strictEqual(bols.length, 3);
    assert.strictEqual(bols[1].valor_centavos, 50000, 'valor tirado do código');
    const c = D.cruzarDDA(bols, DESPESAS, { cnpjCondominio: '33955806000192' });
    assert.strictEqual(c.resultados[0].situacao, 'lancado');
    assert.strictEqual(c.resultados[1].situacao, 'sem_despesa');
    assert(c.resultados[1].achados.some((x) => x.tipo === 'pagador_diferente'));
    assert.strictEqual(c.resultados[2].situacao, 'lancado', 'casou por valor e vencimento no mesmo dia');
    assert.strictEqual(c.resultados[2].casou_por, 'valor_e_vencimento');
    const dif = D.cruzarDDA([{ ...bols[0], valor_centavos: 160000 }], DESPESAS);
    assert.strictEqual(dif.resultados[0].situacao, 'valor_diferente');
    assert.strictEqual(dif.resultados[0].achados[0].diferenca_centavos, -10000);
  });

  // ── Rota de status ──
  await ok('status do conector e rota so GESTOR', () => {
    const st = B.statusConector({});
    assert.strictEqual(st.sicoob.ligado, false);
    assert(!vazou(JSON.stringify(B.statusConector(envFalso))));
    const srv = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
    const m = srv.match(/app\.get\('\/api\/financeiro\/banco\/status',([^)]*)\)/);
    assert(m && /requireAuth/.test(m[1]) && /requireGestor/.test(m[1]), 'rota com requireAuth e requireGestor');
    assert(!/app\.(post|put|delete|patch)\('\/api\/financeiro\/banco/.test(srv), 'sem rota de escrita do banco');
  });

  console.log('\n' + n + ' testes ok');
})().catch((e) => { console.error('FALHOU:', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e); process.exit(1); });
