// Juros e atrasos: testes com dados dublados (sem rede e sem banco de verdade).
// Uso: NODE_PATH=<service-hub>/node_modules node scripts/teste-juros-casos.js
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const J = require('../financeiro/juros');
const dados = require('../financeiro/juros-dados');
const rotasJuros = require('../financeiro/juros-rotas');

let ok = 0, falhou = 0;
const testes = [];
const t = (nome, fn) => testes.push([nome, fn]);

const HOJE = '2026-10-23';
const COMP = '2026-09';
const br = (iso) => (iso ? iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4) + ' 00:00:00' : '');
// Linha do despesas/index (formato do Superlógica) com os campos que o dossiê usa.
function linha(o) {
  return {
    id_parcela_pdes: String(o.id), id_despesa_des: String(o.desp || o.id + 1000), id_condominio_cond: o.cond || '50', st_fantasia_cond: o.cond === '167' ? 'Teste' : 'Cond A',
    st_nome_con: o.forn || 'Fornecedor ' + o.id, st_documento_des: 'NF ' + o.id, dt_geracao_des: br(o.lanc), dt_vencimento_pdes: br(o.venc),
    dt_liquidacao_pdes: br(o.liq), fl_liquidado_pdes: o.liq ? '1' : '0', vl_valor_pdes: String(o.valor || 500), vl_juros_pdes: String(o.juros || 0), vl_multa_pdes: String(o.multa || 0),
    id_forma_pag: o.forma || '1', id_contabanco_cb: o.conta === undefined ? '900' : o.conta, st_codigobarras_pdes: '', fl_remessastatus_pdes: '',
    arquivos: o.arquivos || [],
  };
}
const P = {
  A: linha({ id: 9001, venc: '2026-09-15', lanc: '2026-09-14', liq: '2026-09-17', juros: 5 }),                    // documento chegou tarde
  B: linha({ id: 9002, venc: '2026-09-10', lanc: '2026-09-09', liq: '2026-09-11', multa: 2 }),                    // lançado tarde
  C: linha({ id: 9003, venc: '2026-09-15', lanc: '2026-09-02', liq: '2026-09-17', juros: 3 }),                    // sem assinatura (registro manual)
  D: linha({ id: 9004, venc: '2026-09-22', lanc: '2026-09-02', liq: '2026-09-25', juros: 7 }),                    // sem saldo
  E: linha({ id: 9005, venc: '2026-09-18', lanc: '2026-09-21', liq: '2026-09-23', juros: 1 }),                    // dado incompleto
  F: linha({ id: 9006, venc: '2026-09-10', lanc: '2026-09-02', liq: '2026-09-10', valor: 1000 }),                 // juros não lançado (extrato)
  G: linha({ id: 9007, venc: '2026-09-25', lanc: '2026-09-02' }),                                                  // vencida sem pagamento
  H1: linha({ id: 9008, venc: '2026-09-10', lanc: '2026-09-02', liq: '2026-09-10' }),                             // em dia: não é caso
  H2: linha({ id: 9009, venc: '2026-09-10', lanc: '2026-09-02', liq: '2026-09-16', valor: 777.77 }),              // baixa tardia, extrato em dia
  I: linha({ id: 9010, venc: '2026-09-15', lanc: '2026-09-02', liq: '2026-09-18', juros: 4 }),                    // banco: pendente de assinatura
  J: linha({ id: 9011, cond: '167', venc: '2026-09-10', lanc: '2026-09-02', liq: '2026-09-20', juros: 9 }),       // condomínio de teste: fora
  K: linha({ id: 9012, venc: '2026-09-20', lanc: '2026-09-02', liq: '2026-09-21' }),                              // venceu domingo, pago segunda
  L: linha({ id: 9013, venc: '2026-09-15', lanc: '2026-09-02', liq: '2026-09-15', juros: 1.5 }),                  // no prazo com juros
  M: linha({ id: 9014, venc: '2026-09-04', lanc: '2026-09-04', liq: '2026-09-08', juros: 2,                        // anexo antes do prazo prova chegada
    arquivos: [{ st_nomeabreviadoetiqueta_eti: 'Doc. Pgto', dt_envio_arq: br('2026-08-28'), fl_excluido_arq: '' }] }),
};
const TODAS = Object.values(P);
const ENTRADAS = ['A:2026-09-14', 'B:2026-09-01', 'C:2026-09-01', 'D:2026-09-01', 'F:2026-09-01', 'G:2026-09-01', 'I:2026-09-01', 'L:2026-09-01']
  .map((s) => { const [k, d] = s.split(':'); return { id_despesa: P[k].id_despesa_des, criado_em: d + 'T10:00:00-03:00' }; });
const EXTRATO = [
  { id_conta: '900', data: '2026-09-14', centavos: -103000, descricao: 'PAGTO BOLETO' },
  { id_conta: '900', data: '2026-09-10', centavos: -77777, descricao: 'PAGTO BOLETO' },
];
const SALDOS = { '900|2026-09-15': 10000, '900|2026-09-22': 100, '900|2026-09-10': 20000, '900|2026-09-18': 9000, '900|2026-09-25': 8000, '900|2026-09-04': 5000 };
const AUD = [
  { id_auditoria_aud: '1', dt_data_aud: '09/09/2026 16:20:00', id_usuario_usu: '501', st_apelido_usu: 'MARIA', st_texto_aud: 'Despesa#' + P.B.id_despesa_des + ' criada' },
  { id_auditoria_aud: '2', dt_data_aud: '09/11/2026 09:00:00', id_usuario_usu: '502', st_apelido_usu: 'JOAO', st_texto_aud: 'Parcela#9002 da despesa#' + P.B.id_despesa_des + ' liquidada' },
];
const RETORNO_I = rotasJuros.pagamentoDeLinha({ lote: '0001', seq: 1, segmento: 'J', seu_numero: '9010', data_pagamento: '2026-09-15', valor_centavos: 50000,
  ocorrencias: [{ codigo: 'PD', texto: 'Pendente de assinatura' }], data_arquivo: '2026-09-15' });
const REG = new Map([
  ['p9003', { chave: 'p9003', assinado_em: '2026-09-17', assinado_por: 'síndico', enviado_assinatura_em: '2026-09-03' }],
  ['p9006', { chave: 'p9006', assinado_em: '2026-09-08' }],
]);
function montar(extra) {
  return J.montarCasos(Object.assign({ parcelas: TODAS, extrato: EXTRATO, entradas: ENTRADAS, saldos: SALDOS, auditoria: AUD, retornos: [RETORNO_I], registros: REG }, extra || {}),
    { competencia: COMP, hoje: HOJE });
}
const caso = (r, id) => r.casos.find((c) => c.id_parcela === String(id));

// ── causas ────────────────────────────────────────────────────────────────
t('detecta só os casos do mês, fora o condomínio de teste e os pagos em dia', () => {
  const r = montar();
  const ids = r.casos.map((c) => c.id_parcela).sort();
  assert.deepStrictEqual(ids, ['9001', '9002', '9003', '9004', '9005', '9006', '9007', '9010', '9013', '9014']);
  assert.strictEqual(r.meta.baixa_tardia_pagamento_em_dia, 1, 'baixa tardia com débito em dia no extrato não vira caso');
  assert.ok(!caso(r, 9012), 'vencimento no domingo pago na segunda não é atraso');
});
t('causa: documento chegou depois do prazo (a apurar)', () => {
  const c = caso(montar(), 9001);
  assert.strictEqual(c.causa.codigo, 'documento_tardio');
  assert.strictEqual(c.causa.responsavel_sugerido, 'a_apurar');
  assert.ok(/11\/09\/2026/.test(c.causa.regras.find((x) => x.codigo === 'documento_tardio').evidencia), 'mostra o prazo de 2 dias úteis');
  assert.strictEqual(c.causa.sugestao, true);
});
t('causa: chegou a tempo e foi lançado tarde (administradora), com quem lançou e quem baixou', () => {
  const c = caso(montar(), 9002);
  assert.strictEqual(c.causa.codigo, 'lancado_tarde');
  assert.strictEqual(c.causa.responsavel_sugerido, 'administradora');
  assert.strictEqual(c.quem_lancou, 'MARIA');
  assert.strictEqual(c.quem_baixou, 'JOAO');
  assert.ok(/MARIA/.test(c.causa.explicacao));
});
t('causa: lançado a tempo e assinado depois do vencimento (condomínio)', () => {
  const c = caso(montar(), 9003);
  assert.strictEqual(c.causa.codigo, 'sem_assinatura');
  assert.strictEqual(c.causa.responsavel_sugerido, 'condominio');
  const tipos = c.linha_do_tempo.map((e) => e.tipo);
  ['chegada', 'lancamento', 'envio_assinatura', 'vencimento', 'assinatura', 'pagamento', 'baixa'].forEach((k) => assert.ok(tipos.includes(k), 'linha do tempo com ' + k));
  for (let i = 1; i < c.linha_do_tempo.length; i++) assert.ok(c.linha_do_tempo[i - 1].data <= c.linha_do_tempo[i].data, 'em ordem de data');
});
t('causa: sem saldo na conta no vencimento (condomínio)', () => {
  const c = caso(montar(), 9004);
  assert.strictEqual(c.causa.codigo, 'sem_saldo');
  assert.strictEqual(c.causa.responsavel_sugerido, 'condominio');
  assert.strictEqual(c.saldo_vencimento.valor, 100);
});
t('causa: dado incompleto (a apurar) com o que falta', () => {
  const c = caso(montar(), 9005);
  assert.strictEqual(c.causa.codigo, 'dado_incompleto');
  assert.ok(c.causa.falta.includes('data de chegada do documento'));
  assert.ok(/Falta/.test(c.causa.explicacao));
});
t('juros pago e não lançado: achado pelo extrato (data real e valor maior)', () => {
  const c = caso(montar(), 9006);
  assert.strictEqual(c.situacao, 'pago_com_atraso', 'a baixa diz em dia, o extrato diz 14/09');
  assert.strictEqual(c.datas.pagamento, '2026-09-14');
  assert.strictEqual(c.datas.pagamento_fonte, 'Extrato do banco');
  assert.strictEqual(c.valores.juros_nao_lancado, 3000);
  assert.ok(c.sinais.some((s) => s.tipo === 'juros_nao_lancado'));
  assert.strictEqual(c.causa.codigo, 'sem_causa_clara', 'tudo a tempo e pago depois');
  // Sem extrato o mesmo caso some (baixa em dia, sem juros): é o extrato que acha.
  assert.ok(!caso(montar({ extrato: [] }), 9006));
});
t('extrato com dois débitos possíveis não inventa juros', () => {
  const ext = EXTRATO.concat([{ id_conta: '900', data: '2026-09-13', centavos: -102000, descricao: 'OUTRO' }]);
  const c = caso(montar({ extrato: ext }), 9006);
  assert.ok(!c, 'ambíguo: fica sem caso (a baixa está em dia)');
  assert.ok(montar({ extrato: ext }).meta.extrato_ambiguo >= 1);
});
t('vencida sem pagamento: dias de atraso até hoje e falta da assinatura', () => {
  const c = caso(montar(), 9007);
  assert.strictEqual(c.situacao, 'vencida_sem_pagamento');
  assert.strictEqual(c.dias_atraso, 28);
  assert.strictEqual(c.causa.codigo, 'dado_incompleto');
  assert.ok(c.causa.falta.includes('data da assinatura do síndico'));
  assert.strictEqual(c.linha_do_tempo[c.linha_do_tempo.length - 1].tipo, 'hoje');
});
t('retorno do banco pendente de assinatura vira evidência (condomínio)', () => {
  const c = caso(montar(), 9010);
  assert.strictEqual(c.causa.codigo, 'sem_assinatura');
  assert.ok(/assinatura/.test(c.causa.regras.find((x) => x.codigo === 'sem_assinatura').evidencia));
  assert.ok(c.linha_do_tempo.some((e) => e.tipo === 'banco'));
});
t('pago no prazo com juros lançado e anexo antes do prazo provando a chegada', () => {
  assert.strictEqual(caso(montar(), 9013).causa.codigo, 'pago_no_prazo_com_encargo');
  const m = caso(montar(), 9014);
  assert.strictEqual(m.datas.chegada_fonte, 'anexo');
  assert.strictEqual(m.causa.regras.find((x) => x.codigo === 'documento_tardio').resultado, 'nao');
  assert.strictEqual(m.causa.codigo, 'lancado_tarde', 'boleto anexado em 28/08 e lançado em 04/09 para vencer no mesmo dia');
});
t('valor da parcela que já soma os encargos não vira juros não lançado', () => {
  const p = Object.assign({}, P.F, { vl_valor_pdes: '1030', vl_valorbruto_pdes: '1000', vl_juros_pdes: '20', vl_multa_pdes: '10' });
  const c = caso(montar({ parcelas: [p] }), 9006);
  assert.strictEqual(c.valores.original, 100000);
  assert.strictEqual(c.valores.juros_nao_lancado, 0);
  assert.strictEqual(c.valores.encargos, 3000);
});
t('totais por responsável (decidido e a decidir) e exportação sem nome de funcionário', () => {
  const reg = new Map(REG);
  reg.set('p9002', { chave: 'p9002', quem_paga: 'administradora', justificativa: 'Lançou tarde', ressarcimento: 'pendente', ressarcimento_valor: 2 });
  const r = montar({ registros: reg });
  assert.strictEqual(r.totais.por_responsavel.administradora, 200);
  assert.strictEqual(r.totais.qtd_responsavel.administradora, 1);
  assert.strictEqual(r.totais.ressarcir_pendente, 200);
  assert.strictEqual(r.totais.por_responsavel.a_decidir, r.totais.encargos - 200);
  const ex = J.exportacao(r.casos);
  assert.strictEqual(ex.colunas.length, ex.linhas[0].length);
  assert.ok(!JSON.stringify(ex).includes('MARIA') && !JSON.stringify(ex).includes('JOAO'), 'exportação para o síndico sem nome de funcionário');
  assert.ok(!/[–—]/.test(JSON.stringify(ex)), 'sem travessão nos textos');
});
t('quadro da carteira pela base (sem extrato) e filtro de carteira', () => {
  const linhas = J.quadro(TODAS, COMP, HOJE, new Set(['50']), [{ id_superlogica: 50, quem_paga: 'condominio', valor_encargos: 3 }], new Map([['50', 'Cond A']]));
  assert.strictEqual(linhas.length, 1);
  assert.strictEqual(linhas[0].vencidas_sem_pagamento, 1);
  assert.strictEqual(linhas[0].por_responsavel.condominio, 300);
  assert.ok(linhas[0].casos >= 8);
  assert.strictEqual(J.quadro(TODAS, COMP, HOJE, new Set(['60']), [], null).length, 0, 'fora da carteira não aparece');
});
t('validações de registro e decisão', () => {
  assert.ok(J.validarDecisao({ quem_paga: 'x', justificativa: 'abcdef' }).erro);
  assert.ok(J.validarDecisao({ quem_paga: 'condominio', justificativa: 'ok' }).erro);
  assert.deepStrictEqual(J.validarDecisao({ quem_paga: 'fornecedor', justificativa: '  boleto  enviado tarde ' }).ok, { quem_paga: 'fornecedor', justificativa: 'boleto enviado tarde' });
  assert.ok(J.validarRegistro({ assinado_em: '2026-13-01' }, HOJE).erro);
  assert.ok(J.validarRegistro({ assinado_em: '2026-12-01' }, HOJE).erro, 'data futura');
  assert.ok(J.validarRegistro({ enviado_assinatura_em: '2026-09-10', assinado_em: '2026-09-05' }, HOJE).erro, 'assinou antes de enviar');
  assert.deepStrictEqual(J.validarRegistro({ assinado_em: '2026-09-05', assinado_por: 'sindico_subsindico' }, HOJE).ok, { assinado_em: '2026-09-05', assinado_por: 'síndico e subsíndico' });
  assert.ok(J.podeDecidir({ role: 'GESTOR' }) && J.podeDecidir({ role: 'GERENTE' }) && !J.podeDecidir({ role: 'OPERACIONAL' }) && !J.podeDecidir(null));
});

// ── leitura: só GET e só as ações de leitura ──────────────────────────────
function clienteFalso(registro) {
  const entre = (iso, p) => { const a = p.dtInicio.slice(6) + '-' + p.dtInicio.slice(0, 2) + '-' + p.dtInicio.slice(3, 5); const b = p.dtFim.slice(6) + '-' + p.dtFim.slice(0, 2) + '-' + p.dtFim.slice(3, 5); return iso && iso >= a && iso <= b; };
  const iso = (s) => (s ? s.slice(6, 10) + '-' + s.slice(0, 2) + '-' + s.slice(3, 5) : '');
  const proibido = (m) => () => { registro.escritas.push(m); throw new Error('escrita proibida: ' + m); };
  return {
    post: proibido('post'), put: proibido('put'), delete: proibido('delete'), patch: proibido('patch'),
    async get(acao, p) {
      registro.gets.push(acao);
      if (acao === 'despesas/index') {
        const doCond = TODAS.filter((d) => d.id_condominio_cond === String(p.idCondominio));
        if (p.comStatus === 'liquidadas') return doCond.filter((d) => d.fl_liquidado_pdes === '1' && entre(iso(d.dt_liquidacao_pdes), p));
        return doCond.filter((d) => d.fl_liquidado_pdes !== '1' && entre(iso(d.dt_vencimento_pdes), p));
      }
      if (acao === 'auditoria/index') return AUD.filter((r) => entre(iso(r.dt_data_aud), p));
      if (acao === 'conciliacao/index') {
        return { itens: EXTRATO.filter((x) => x.id_conta === String(p.idConta) && entre(x.data, p))
          .map((x) => ({ valor_banco: (x.centavos / 100).toFixed(2), data_banco: br(x.data), id_conta_banco: x.id_conta, descricao_banco: x.descricao })) };
      }
      if (acao === 'caixa/index') { const d = iso(p.dtInicio); const v = SALDOS[(p.idContaBancaria || 'total') + '|' + d]; return [{ saldoinicialconta: v === undefined ? 50000 : v }]; }
      return [];
    },
  };
}
t('leitura do Superlógica: só GET das ações de leitura, nada gravado', async () => {
  const reg = { gets: [], escritas: [] };
  const painel = require('../financeiro/painel');
  const b = await dados.carregar({ cliente: clienteFalso(reg), fila: painel.criarFila(2), id: '50', competencia: COMP, hoje: HOJE, retornos: [RETORNO_I], entradas: ENTRADAS });
  assert.strictEqual(reg.escritas.length, 0);
  assert.ok(reg.gets.length > 0 && reg.gets.every((a) => dados.ACOES_LIDAS.has(a)), JSON.stringify([...new Set(reg.gets)]));
  assert.ok(b.extrato.length >= 2, 'extrato lido pela conciliação');
  assert.strictEqual(b.saldos['900|2026-09-22'], 100);
  const r = J.montarCasos({ parcelas: b.parcelas, extrato: b.extrato, auditoria: b.auditoria, saldos: b.saldos, entradas: ENTRADAS, retornos: [RETORNO_I], registros: REG }, { competencia: COMP, hoje: HOJE });
  assert.strictEqual(caso(r, 9006).valores.juros_nao_lancado, 3000);
  assert.strictEqual(caso(r, 9004).causa.codigo, 'sem_saldo');
  assert.strictEqual(caso(r, 9002).quem_lancou, 'MARIA');
  await assert.rejects(dados.soLeitura(clienteFalso(reg)).get('despesas/put', {}), /acao_nao_permitida/);
  assert.strictEqual(reg.escritas.length, 0);
});

// ── rotas: permissões, histórico e aviso de ressarcir ─────────────────────
const uid = (fim) => ['0'.repeat(8), '0'.repeat(4), '4000', '8000', '0'.repeat(10) + fim].join('-');
const UID = { gestor: uid('0a'), gerente: uid('0b'), analista: uid('0c'), semfin: uid('0d') };
const FIN = { financeiro: { visivel: true, acoes: ['ver'] } };
const PERFIS = {
  [UID.gestor]: { id: UID.gestor, role: 'GESTOR', email: 'gestor@example.com', permissoes: {} },
  [UID.gerente]: { id: UID.gerente, role: 'GERENTE', email: 'gerente@example.com', permissoes: FIN },
  [UID.analista]: { id: UID.analista, role: 'OPERACIONAL', email: 'analista@example.com', permissoes: FIN },
  [UID.semfin]: { id: UID.semfin, role: 'OPERACIONAL', email: 'sem@example.com', permissoes: {} },
};
const CARTEIRA = { [UID.analista]: new Set(['50']), [UID.gerente]: new Set(['50', '60']) };
function bancoFalso() {
  const tab = { fin_juros_casos: [], fin_juros_historico: [], fin_juros_banco: [], fin_entrada: ENTRADAS.map((e) => Object.assign({ id_superlogica: 50, status: 'lancado' }, e)) };
  const filtrar = (linhas, params) => linhas.filter((l) => params.every(([k, v]) => {
    if (['select', 'order', 'limit'].includes(k)) return true;
    if (v === 'not.is.null') return l[k] !== null && l[k] !== undefined;
    const m = v.match(/^eq\.(.*)$/); return m ? String(l[k]) === decodeURIComponent(m[1]) : true;
  }));
  return {
    tab,
    async ler(caminho) {
      const [nome, q] = caminho.split('?');
      const params = (q || '').split('&').filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; });
      const sel = (params.find((p) => p[0] === 'select') || [])[1] || '';
      return filtrar(tab[nome] || [], params).map((l) => (/fornecedor:snapshot/.test(sel) ? Object.assign({}, l, { fornecedor: l.snapshot && l.snapshot.fornecedor }) : Object.assign({}, l)));
    },
    async upsert(nome, linhas, conflito) {
      const cols = conflito.split(',');
      for (const l of linhas) {
        const i = tab[nome].findIndex((x) => cols.every((c) => String(x[c]) === String(l[c])));
        if (i >= 0) tab[nome][i] = Object.assign({}, tab[nome][i], l); else tab[nome].push(Object.assign({}, l));
      }
      return linhas.length;
    },
    async inserir(nome, l) { tab[nome].push(Object.assign({}, l)); return true; },
  };
}
function montarApp(banco, reg) {
  const app = express();
  const requireAuth = (req, res, next) => { const u = req.get('x-u'); if (!u) return res.status(401).end(); req.user = { sub: u }; next(); };
  const escopo = async (req) => CARTEIRA[req.user.sub] || null;
  rotasJuros.registrar({
    app, express, requireAuth, banco, hoje: () => HOJE, log: () => {},
    exigirFinanceiro: async (req, res) => { const p = PERFIS[req.user.sub]; if (p && (p.role === 'GESTOR' || (p.permissoes.financeiro && p.permissoes.financeiro.visivel))) return true; res.status(403).json({ erro: 'modulo_sem_acesso' }); return false; },
    exigirLeituraSuperlogica: async () => true,
    exigirCarteira: async () => true,
    exigirEscopo: async (req, res, id) => { const e = await escopo(req); if (e && !e.has(String(id))) { res.status(403).json({ erro: 'fora_da_carteira' }); return null; } return { escopo: e }; },
    escopoFinanceiro: escopo,
    lerPerfil: async (id) => PERFIS[id] || null,
    gruposCarteiras: async () => [{ id: 7, condominios: ['50'] }],
    clienteSL: () => clienteFalso(reg),
    obterBase: async () => ({ despesas: TODAS, hoje: HOJE, gerado_em: '2026-10-23T10:00:00Z', periodo: { pagas_desde: '2026-08-01' }, condominios: new Map([['50', { nome: 'Cond A' }], ['60', { nome: 'Cond B' }]]), analistas: new Map([['50', 'MARIA']]) }),
    auditar: () => {},
  });
  return app;
}
t('rotas: analista só a carteira, só gestor e gerente decidem, histórico, ressarcimento e nada no Superlógica', async () => {
  const banco = bancoFalso();
  const reg = { gets: [], escritas: [] };
  const srv = http.createServer(montarApp(banco, reg));
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const pedir = async (u, metodo, caminho, corpo) => {
    const r = await fetch(base + caminho, { method: metodo, headers: Object.assign({ 'content-type': 'application/json' }, u ? { 'x-u': u } : {}), body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  const URL50 = '/api/financeiro/juros/condominio/50';
  try {
    assert.strictEqual((await pedir(null, 'GET', URL50 + '?competencia=' + COMP)).status, 401);
    assert.strictEqual((await pedir(UID.semfin, 'GET', URL50 + '?competencia=' + COMP)).status, 403, 'sem o módulo financeiro');
    assert.strictEqual((await pedir(UID.analista, 'GET', '/api/financeiro/juros/condominio/60?competencia=' + COMP)).status, 403, 'analista fora da carteira');
    assert.strictEqual((await pedir(UID.analista, 'GET', URL50 + '?competencia=2026-13')).status, 400);
    assert.strictEqual((await pedir(UID.analista, 'GET', URL50 + '?competencia=2026-12')).status, 400, 'mês que não começou');
    const a = await pedir(UID.analista, 'GET', URL50 + '?competencia=' + COMP);
    assert.strictEqual(a.status, 200, JSON.stringify(a.j));
    assert.strictEqual(a.j.pode_decidir, false);
    assert.ok(a.j.casos.length >= 8);
    assert.ok(a.j.exportacao && a.j.exportacao.linhas.length === a.j.casos.length);
    const q = await pedir(UID.analista, 'GET', '/api/financeiro/juros/quadro?competencia=' + COMP);
    assert.strictEqual(q.status, 200);
    assert.deepStrictEqual(q.j.condominios.map((c) => c.id_condominio), ['50'], 'quadro do analista só com a carteira');

    // Registro manual pelo analista (permitido) e decisão (recusada).
    const r1 = await pedir(UID.analista, 'PUT', URL50 + '/caso/p9007/registro', { competencia: COMP, assinado_em: '2026-09-24', assinado_por: 'sindico' });
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.j));
    assert.strictEqual((await pedir(UID.analista, 'PUT', URL50 + '/caso/p9002/decisao', { competencia: COMP, quem_paga: 'administradora', justificativa: 'Lançou tarde' })).status, 403);
    assert.strictEqual((await pedir(UID.gerente, 'PUT', URL50 + '/caso/p9999/decisao', { competencia: COMP, quem_paga: 'condominio', justificativa: 'Caso que não existe' })).status, 404);
    assert.strictEqual((await pedir(UID.gerente, 'PUT', URL50 + '/caso/p9002/decisao', { competencia: COMP, quem_paga: 'ninguem', justificativa: 'xxxxxxx' })).status, 400);
    // Gerente decide: administradora gera o aviso de ressarcir.
    const d1 = await pedir(UID.gerente, 'PUT', URL50 + '/caso/p9002/decisao', { competencia: COMP, quem_paga: 'administradora', justificativa: 'Documento chegou dia 01 e foi lançado dia 09' });
    assert.strictEqual(d1.status, 200, JSON.stringify(d1.j));
    assert.strictEqual(d1.j.ressarcimento.status, 'pendente');
    const linha = banco.tab.fin_juros_casos.find((x) => x.chave === 'p9002');
    assert.strictEqual(linha.decidido_por_email, 'gerente@example.com');
    assert.strictEqual(linha.snapshot.causa.codigo, 'lancado_tarde', 'dossiê guardado com a decisão');
    // O analista vê a decisão e o aviso no dossiê e no quadro.
    const a2 = await pedir(UID.analista, 'GET', URL50 + '?competencia=' + COMP);
    const c2 = a2.j.casos.find((c) => c.chave === 'p9002');
    assert.strictEqual(c2.decisao.quem_paga, 'administradora');
    assert.strictEqual(c2.ressarcimento.status, 'pendente');
    assert.strictEqual(a2.j.casos.find((c) => c.chave === 'p9007').registro.assinado_em, '2026-09-24');
    const q2 = await pedir(UID.gestor, 'GET', '/api/financeiro/juros/quadro?competencia=' + COMP);
    assert.strictEqual(q2.j.ressarcir.length, 1);
    assert.strictEqual(q2.j.condominios[0].por_responsavel.administradora, 200);
    // Gestor muda a decisão: histórico com antes e depois, aviso sai.
    const d2 = await pedir(UID.gestor, 'PUT', URL50 + '/caso/p9002/decisao', { competencia: COMP, quem_paga: 'condominio', justificativa: 'Síndico pediu para segurar o pagamento' });
    assert.strictEqual(d2.status, 200);
    assert.strictEqual(banco.tab.fin_juros_casos.find((x) => x.chave === 'p9002').ressarcimento, null);
    const hist = banco.tab.fin_juros_historico.filter((h) => h.chave === 'p9002');
    assert.strictEqual(hist.length, 2);
    assert.strictEqual(hist[1].antes.quem_paga, 'administradora');
    assert.strictEqual(hist[1].depois.quem_paga, 'condominio');
    const a3 = await pedir(UID.analista, 'GET', URL50 + '?competencia=' + COMP);
    assert.strictEqual(a3.j.casos.find((c) => c.chave === 'p9002').historico.length, 2, 'histórico aparece na ficha');
    // Ressarcimento: volta para administradora, analista não marca, gestor marca.
    await pedir(UID.gestor, 'PUT', URL50 + '/caso/p9002/decisao', { competencia: COMP, quem_paga: 'administradora', justificativa: 'Revisto: erro da equipe' });
    assert.strictEqual((await pedir(UID.analista, 'POST', URL50 + '/caso/p9002/ressarcimento', { observacao: 'feito' })).status, 403);
    assert.strictEqual((await pedir(UID.gestor, 'POST', URL50 + '/caso/p9002/ressarcimento', { observacao: 'Crédito na conta em 20/10' })).status, 200);
    assert.strictEqual((await pedir(UID.gestor, 'POST', URL50 + '/caso/p9002/ressarcimento', {})).status, 409, 'já feito');
    assert.strictEqual(banco.tab.fin_juros_historico.filter((h) => h.chave === 'p9002').length, 4);
    // Retorno do banco: arquivo de remessa recusado.
    assert.strictEqual((await pedir(UID.analista, 'POST', URL50 + '/retorno', { texto: 'x' })).status, 400);
    assert.strictEqual(reg.escritas.length, 0, 'nada gravado no Superlógica');
    assert.ok(reg.gets.every((x) => dados.ACOES_LIDAS.has(x)));
  } finally { srv.close(); }
});

(async () => {
  for (const [nome, fn] of testes) {
    try { await fn(); ok++; console.log('ok   ' + nome); } catch (e) { falhou++; console.log('FALHOU ' + nome + '\n   ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e)); }
  }
  console.log(ok + ' ok, ' + falhou + ' falha(s)');
  process.exit(falhou ? 1 : 0);
})();
