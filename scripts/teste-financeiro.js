'use strict';
// Testes locais do conector financeiro (sem rede): node scripts/teste-financeiro.js
const assert = require('assert');
const path = require('path');
const U = require(path.join(__dirname, '..', 'financeiro', 'util'));
const M = require(path.join(__dirname, '..', 'financeiro', 'mapear'));
const { criarSync } = require(path.join(__dirname, '..', 'financeiro', 'sync'));
const { criarBanco } = require(path.join(__dirname, '..', 'financeiro', 'banco'));
let n = 0;
const ok = (nome, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('ok ' + nome); });

(async () => {
  await ok('datas', () => {
    assert.strictEqual(U.dataISO('10/01/2026 00:00:00'), '2026-10-01');
    assert.strictEqual(U.dataISO('2026-10-09 00:00:00'), '2026-10-09');
    assert.strictEqual(U.dataISO('02/30/2026'), null);
    assert.strictEqual(U.dataISO(''), null);
    assert.strictEqual(U.dataHoraISO('10/20/2026 17:52:25'), '2026-10-20T17:52:25-03:00');
    assert.strictEqual(U.dataSL('2026-04-01'), '04/01/2026');
    assert.strictEqual(U.ehISO('2026-13-01'), false);
  });
  await ok('janelas', () => {
    assert.deepStrictEqual(U.janelasQuinzena('2026-04-01', '2026-05-03'), [['2026-04-01', '2026-04-15'], ['2026-04-16', '2026-04-30'], ['2026-05-01', '2026-05-03']]);
    assert.deepStrictEqual(U.janelasMes('2026-02-10', '2026-03-05'), [['2026-02-10', '2026-02-28'], ['2026-03-01', '2026-03-05']]);
    assert.strictEqual(U.janelasDias('2026-04-01', '2026-10-21', 1).length, 204);
  });
  await ok('conta sem segredo nem numero', () => {
    const c = M.conta({ id_contabanco_cb: '635', id_condominio_cond: '136', st_conta_cb: '000037407-5', st_numero_agb: '3007-4', st_token_cb: 'X', st_secret_cb: 'Y', fl_principal_cb: '1', vl_saldo_cb: '6685.32' });
    const s = JSON.stringify(c);
    ['000037407', '3007-4', '"X"', '"Y"'].forEach((t) => assert(!s.includes(t), t));
    assert.strictEqual(c.principal, true);
    assert.strictEqual(c.saldo, 6685.32);
  });
  await ok('fornecedor CPF fora, CNPJ fica', () => {
    assert.strictEqual(M.despesa({ id_despesa_des: '1', st_cpf_con: '123.456.789-01' }).fornecedor_cnpj, null);
    assert.strictEqual(M.despesa({ id_despesa_des: '1', st_cpf_con: '07707650000110' }).fornecedor_cnpj, '07707650000110');
  });
  await ok('cobranca sem nome do morador', () => {
    const c = M.cobranca({ id_recebimento_recb: '9', st_nome_con: 'FULANO 204', id_condominio_cond: '136' });
    assert(!JSON.stringify(c).includes('FULANO'));
  });
  await ok('movimentos: saldo sai e chave estavel', () => {
    const l = [{ saldoinicialconta: '1', dt_data_mov: '10/01/2026' },
      { id_contabanco_cb: '635', id_contabanco_mov: '', dt_data_mov: '2026-10-01 00:00:00', fl_dc_mov: 'C', vl_valor_mov: '5', st_descricao_mov: '12' },
      { id_contabanco_cb: '635', id_contabanco_mov: '', dt_data_mov: '2026-10-01 00:00:00', fl_dc_mov: 'C', vl_valor_mov: '5', st_descricao_mov: '12' },
      { id_contabanco_cb: '635', id_contabanco_mov: '77', dt_data_mov: '2026-10-01 00:00:00', vl_valor_mov: '-2' }];
    const r = M.movimentos(l, new Map([[635, 136]]));
    assert.strictEqual(r.length, 3);
    assert.notStrictEqual(r[0].chave, r[1].chave);
    assert.strictEqual(r[2].chave, 'm:77');
    assert.deepStrictEqual(M.movimentos(l, new Map()).map((x) => x.chave), r.map((x) => x.chave));
  });
  await ok('auditoria: filtro e ids do texto', () => {
    assert(M.auditoriaRelevante({ st_texto_aud: 'Arquivo#656612 "x" removido do responsável fornecedor#94786' }));
    assert(M.auditoriaRelevante({ st_texto_aud: 'Parcela#331232 da despesa#302692 liquidada.' }));
    assert(!M.auditoriaRelevante({ st_texto_aud: 'Nova receita 1 no valor R$ 2,00 para cobrança 3' }));
    assert(!M.auditoriaRelevante({ st_texto_aud: '[SUDO] Arquivo(1_2_3.RET) processado com sucesso' }));
    assert(!M.auditoriaRelevante({ st_texto_aud: 'Despesa#5 criada.' }));
    assert(!M.auditoriaRelevante({ st_texto_aud: 'Adicionado extrato#9. Conta bancária Conta Principal (1-2),  em 10/20/2026' }));
    assert(M.auditoriaRelevante({ st_texto_aud: 'Excluído extrato#9. Conta bancária Conta Principal (1-2),  em 10/20/2026' }));
    assert(!M.auditoriaRelevante({ st_texto_aud: 'Importante: Conta bancária Conta Principal 635 alterada. ST_PROXIMONN_CB de 1 para 2' }));
    assert(M.auditoriaRelevante({ st_texto_aud: 'Importante: Conta bancária Conta Principal 635 alterada. ST_TOKEN_CB de 1 para 2' }));
    assert(M.auditoriaRelevante({ st_texto_aud: 'Arquivo#1 removido da despesa#2.' }));
    const a = M.auditoria({ id_auditoria_aud: '5', dt_data_aud: '10/20/2026 17:52:25', st_texto_aud: 'Parcela#331232 da despesa#302692 liquidada.', st_fantasia_cond: ' CASA  BLANCA ' }, new Map([['CASA BLANCA', 136]]));
    assert.strictEqual(a.id_parcela, 331232);
    assert.strictEqual(a.id_despesa, 302692);
    assert.strictEqual(a.id_condominio, 136);
  });
  await ok('auditoria: texto mascarado', () => {
    const m = M.mascararTexto;
    assert.strictEqual(m('Importante: Conta bancária Conta Principal 635 alterada. ST_TOKEN_CB de abc123 para xyz789'), 'Importante: Conta bancária Conta Principal 635 alterada. Campos: ST_TOKEN_CB');
    assert.strictEqual(m('Adicionado extrato#9. Conta bancária Conta Principal (3007-4 - 000037407-5),  em 10/20/2026'), 'Adicionado extrato#9. Conta bancária Conta Principal (...),  em 10/20/2026');
    assert(!m('fornecedor CPF 123.456.789-01 e CNPJ 07.707.650/0001-10 conta 0000374075').match(/\d{8}|\d{3}\.\d{3}/));
    assert.strictEqual(m('Parcela#331232 da despesa#302692 liquidada. Valor R$ 1.234,56 venc. 10/01/2026'), 'Parcela#331232 da despesa#302692 liquidada. Valor R$ 1.234,56 venc. 10/01/2026');
    const a = M.auditoria({ id_auditoria_aud: '1', dt_data_aud: '10/20/2026 10:00:00', st_texto_aud: 'Arquivo#12345678 vinculado a despesa#87654321.' }, new Map());
    assert.strictEqual(a.id_arquivo, 12345678);
    assert.strictEqual(a.id_despesa, 87654321);
  });
  await ok('banco recusa projeto que nao e o de teste', () => {
    assert.throws(() => criarBanco({ url: 'https://mtucxdfepkwsfnqpfydb.supabase.co', chave: 'k' }), /supabase_nao_permitido/);
    assert.throws(() => criarBanco({ url: 'https://ledgyprytkuvgtbunsck.supabase.co.evil.com', chave: 'k' }), /supabase_nao_permitido/);
    assert.doesNotThrow(() => criarBanco({ url: 'https://ledgyprytkuvgtbunsck.supabase.co', chave: 'k' }));
  });

  // Sync com cliente e banco falsos: excluídos fora, janela que estoura é dividida, só GET.
  await ok('sync completo com falsos', async () => {
    const chamadas = [];
    const desp = (id, cond, liq) => ({ id_despesa_des: String(id), id_parcela_pdes: String(id * 10), id_condominio_cond: String(cond), dt_liquidacao_pdes: liq, arquivos: [{ id_arquivo_arq: String(id * 100), st_hash_arq: 'h' }] });
    const cliente = {
      async get(caminho, p) {
        chamadas.push([caminho, p]);
        if (caminho === 'contabancos/index') return [{ id_contabanco_cb: '1', id_condominio_cond: '136' }, { id_contabanco_cb: '2', id_condominio_cond: '143' }];
        if (caminho === 'despesas/index') {
          // a quinzena inteira "estoura" (HTML com 200 vira null); meia quinzena responde
          if (p.dtInicio === '04/01/2026' && p.dtFim === '04/02/2026') return null;
          return p.comStatus === 'liquidadas' ? [desp(Number(p.dtInicio.slice(3, 5)), 136, p.dtInicio), desp(999, 143, p.dtInicio)] : [];
        }
        if (caminho === 'caixa/index') return [{ id_contabanco_cb: '1', id_contabanco_mov: '5', dt_data_mov: '04/02/2026', vl_valor_mov: '1' }, { id_contabanco_cb: '2', id_contabanco_mov: '6', dt_data_mov: '04/02/2026', vl_valor_mov: '1' }];
        if (caminho === 'cobranca/index') return p.pagina === 1 ? [{ id_recebimento_recb: String(p.status === 'pendentes' ? 1 : 2), id_condominio_cond: String(p.idCondominio) }] : [];
        if (caminho === 'auditoria/index') return [{ id_auditoria_aud: '1', dt_data_aud: '04/02/2026 10:00:00', st_texto_aud: 'Despesa#1 criada.', st_fantasia_cond: 'X' }, { id_auditoria_aud: '2', dt_data_aud: '04/02/2026 10:00:00', st_texto_aud: 'Despesa#2 criada.', st_fantasia_cond: 'EMPRESA' }];
        throw new Error('inesperado ' + caminho);
      },
    };
    const gravado = {};
    const banco = {
      async upsert(t, l) { (gravado[t] = gravado[t] || []).push(...l); return l.length; },
      async inserir(t, l) { (gravado[t] = gravado[t] || []).push(l); return true; },
      async ler() { return []; },
    };
    const listar = async () => [{ id_condominio_cond: '136', st_fantasia_cond: 'X' }, { id_condominio_cond: '143', st_fantasia_cond: 'EMPRESA' }, { id_condominio_cond: '200', st_nome_cond: 'VIRTUAL SERVICE LTDA' }];
    const s = criarSync({ cliente, banco });
    const r = await s.rodar({ inicio: '2026-04-01', fim: '2026-04-02', listarCondominios: listar });
    assert.strictEqual(r.janelas_erro, 0, JSON.stringify(r.erros));
    ['fin_despesas', 'fin_parcelas', 'fin_anexos', 'fin_movimentos', 'fin_cobrancas', 'fin_auditoria_sl', 'fin_contas'].forEach((t) => {
      assert((gravado[t] || []).length > 0, 'vazio ' + t);
      assert(!(gravado[t] || []).some((x) => [143, 200].includes(x.id_condominio)), 'excluido em ' + t);
    });
    assert(!gravado.fin_movimentos.some((x) => x.id_conta === 2), 'conta de excluido');
    assert.deepStrictEqual(gravado.fin_condominios.map((c) => c.id_condominio), [136]);
    assert(gravado.fin_condominios[0].ultima_sincronizacao && gravado.fin_condominios[0].sincronizado_ate === '2026-04-02');
    assert(chamadas.some(([c, p]) => c === 'despesas/index' && p.dtInicio === '04/01/2026' && p.dtFim === '04/01/2026'), 'nao dividiu a janela');
    assert(!chamadas.some(([c, p]) => c === 'cobranca/index' && String(p.idCondominio) === '-1'), 'cobranca no -1');
  });
  await ok('periodo invalido e excluido recusados', async () => {
    const s = criarSync({ cliente: {}, banco: { inserir: async () => true } });
    await assert.rejects(s.rodar({ inicio: '2026-05-01', fim: '2026-04-01' }), /periodo_invalido/);
    await assert.rejects(s.rodar({ inicio: '2026-04-01', fim: '2026-04-02', idCondominio: 160 }), /condominio_excluido/);
  });
  console.log(n + ' testes ok');
})().catch((e) => { console.error('FALHOU', e); process.exit(1); });
