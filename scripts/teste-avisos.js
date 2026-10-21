// T39: testes dos avisos do financeiro (sem rede e sem banco de verdade).
// Uso: NODE_PATH=/Users/matheusmelo/v8s/service-hub/node_modules node scripts/teste-avisos.js
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const finBanco = require('../financeiro/banco');
const A = require('../financeiro/avisos');
const envio = require('../financeiro/avisos-envio');

let ok = 0, falhou = 0;
const testes = [];
const t = (nome, fn) => testes.push([nome, fn]);

// ── contas sem extrato ────────────────────────────────────────────────────
const quadro = [
  { id_condominio: '10', condominio: 'Cond A', contas: [
    { id: '1', descricao: 'Conta movimento', banco: 'Sicoob', principal: true, situacao: 'ok', quadro: { ultimo_extrato: '2026-10-15', dias_sem_extrato: 4, movimento_baixo: false, diferenca_saldo: 12.5, data_saldo: '2026-10-15', dias_nao_conciliados: 3 } },
    { id: '2', descricao: 'Poupança', principal: false, situacao: 'ok', quadro: { ultimo_extrato: '2026-09-01', dias_sem_extrato: 35, movimento_baixo: true } },
    { id: '3', descricao: 'Fundo', principal: false, situacao: 'ok', quadro: { ultimo_extrato: '2026-10-19', dias_sem_extrato: 1, movimento_baixo: false } },
    { id: '4', descricao: 'Caixa', situacao: 'conta_caixa' },
  ] },
  { id_condominio: '11', condominio: 'Cond B', contas: [
    { id: '5', descricao: 'Principal', principal: true, situacao: 'sem_extrato' },
    { id: '6', descricao: 'Outra', principal: false, situacao: 'sem_extrato' },
    { id: '7', descricao: 'Falhou', principal: false, situacao: 'falha' },
    { id: '8', descricao: 'Limite', principal: false, situacao: 'ok', quadro: { ultimo_extrato: '2026-10-16', dias_sem_extrato: 2, movimento_baixo: false } },
  ] },
];
t('contas sem extrato: limite, pouco movimento, principal sem extrato e falha', () => {
  const r = A.contasSemExtrato(quadro, 2);
  const ids = r.contas.map((c) => c.conta);
  assert.deepStrictEqual(ids.sort(), ['1', '5', '8']);
  assert.strictEqual(r.contas[0].conta, '5', 'principal sem extrato vem primeiro');
  assert.strictEqual(r.contas.find((c) => c.conta === '1').gravidade, 'alta'); // 4 >= 2x2
  assert.strictEqual(r.contas.find((c) => c.conta === '8').gravidade, 'media');
  assert.strictEqual(r.falhas.length, 1);
  assert.deepStrictEqual(A.contasSemExtrato(quadro, 5).contas.map((c) => c.conta), ['5']);
});
t('limite configurável fica entre 1 e 30, padrão 2', () => {
  assert.strictEqual(A.limiteDias(undefined), 2);
  assert.strictEqual(A.limiteDias('3'), 3);
  assert.strictEqual(A.limiteDias(0), 2);
  assert.strictEqual(A.limiteDias(31), 2);
  assert.strictEqual(A.limiteDias(2.5), 2);
});
t('competências: pré balancete do mês anterior e boletos do mês seguinte a partir do dia 15', () => {
  assert.strictEqual(A.mesAnterior('2026-01-10'), '2025-12');
  assert.strictEqual(A.competenciaBoletos('2026-10-21'), '2026-11');
  assert.strictEqual(A.competenciaBoletos('2026-12-20'), '2027-01');
  assert.strictEqual(A.competenciaBoletos('2026-10-05'), '2026-10');
});
t('itens da carteira ordenados por gravidade', () => {
  const sem = A.contasSemExtrato(quadro, 2).contas.map((c) => A.itemSemExtrato(c, 2));
  const conc = A.itensConciliacao(quadro[0]);
  assert.strictEqual(conc.length, 2);
  assert.strictEqual(conc[0].gravidade, 'alta');
  assert.ok(/diferença de saldo/.test(conc[0].titulo));
  const pre = A.itemPreBalancete('10', 'Cond A', { competencia: '2026-09', pendencias: 3, grupos: [{ titulo: 'Pagas sem nota fiscal', bloqueiam: 3, itens: [{ gravidade: 'media' }] }] });
  assert.strictEqual(pre.gravidade, 'media');
  assert.ok(/09\/2026/.test(pre.titulo));
  assert.strictEqual(A.itemPreBalancete('10', 'x', { pendencias: 0 }), null);
  const bol = A.itemBoletos('10', 'Cond A', { competencia: '2026-11', alertas: [{ gravidade: 'alta' }, { gravidade: 'media' }], resumo: { alertas_por_tipo: { boleto_em_dobro: 1, sem_boleto: 1 } } });
  assert.strictEqual(bol.gravidade, 'alta');
  assert.ok(/boleto em dobro/.test(bol.detalhe));
  const venc = A.itemVencidas('10', 'Cond A', [{ tipo: 'R6_VENCIDA', gravidade: 'media', valor: 100, dias_atraso: 12 }, { tipo: 'R5_SEM_NOTA', gravidade: 'alta' }]);
  assert.strictEqual(venc.quantidade, 1);
  assert.ok(/12 dias/.test(venc.detalhe));
  const todos = A.ordenarItens([venc, bol, pre].concat(sem, conc));
  for (let i = 1; i < todos.length; i++) assert.ok({ alta: 3, media: 2, baixa: 1 }[todos[i - 1].gravidade] >= { alta: 3, media: 2, baixa: 1 }[todos[i].gravidade]);
  assert.strictEqual(todos[0].tipo, 'sem_extrato');
  assert.strictEqual(A.totais(todos).itens, todos.length);
});

// ── erros por analista ────────────────────────────────────────────────────
const aud = [
  { id_usuario_usu: '501', st_apelido_usu: 'ANA', st_texto_aud: 'Despesa#9001 criada. Valor R$ 100,00', dt_data_aud: '10/20/2026 09:00:00' },
  { id_usuario_usu: '502', st_apelido_usu: 'BRUNO', st_texto_aud: 'Despesa#9002 criada.', dt_data_aud: '10/19/2026 10:00:00' },
  { id_usuario_usu: '502', st_apelido_usu: 'BRUNO', st_texto_aud: 'Parcela#1 da despesa#9003 alterada. Valor: de R$ 10,00 para R$ 900,00', dt_data_aud: '10/20/2026 11:00:00' },
  { id_usuario_usu: '999999', st_apelido_usu: 'SISTEMA', st_texto_aud: 'Despesa#9004 criada.', dt_data_aud: '10/20/2026 11:00:00' },
  { id_usuario_usu: '503', st_apelido_usu: 'CARLA', st_texto_aud: '[SUDO] Despesa#9005 criada.', dt_data_aud: '10/20/2026 11:00:00' },
];
t('quem lançou: ignora usuário do sistema e SUDO', () => {
  const q = A.quemLancou(aud);
  assert.deepStrictEqual([...q.criadores.keys()].sort(), ['9001', '9002']);
  assert.strictEqual(q.criadores.get('9001').id_usuario_sl, '501');
  assert.strictEqual(q.criadores.get('9001').quando, '2026-10-20');
  assert.ok(!q.usuarios.has('999999') && !q.usuarios.has('503'));
  assert.strictEqual(q.usuarios.get('502').lancamentos, 1);
});
t('erros por usuário: lançou, mexeu, vencida fica fora, sem autor conta à parte', () => {
  const q = A.quemLancou(aud);
  const alertas = [[
    { regra: 'R1', tipo: 'R1_DOCUMENTO', gravidade: 'alta', id_despesa: '9001', id_parcela: '1', valor: 100, id_condominio: '10' },
    { regra: 'R2', tipo: 'R2_CONDOMINIO_TROCADO', gravidade: 'alta', id_despesa: '9002', id_parcela: '2', valor: 50, id_condominio: '10' },
    { regra: 'R6', tipo: 'R6_VENCIDA', gravidade: 'media', id_despesa: '9001', id_parcela: '1' },
    { regra: 'R9', tipo: 'R9_MEXIDA', gravidade: 'alta', id_despesa: '9003', usuario: 'BRUNO', quando: '2026-10-20 11:00:00', valor: 900 },
    { regra: 'R5', tipo: 'R5_SEM_NOTA', gravidade: 'media', id_despesa: '7777', id_parcela: '9' },
  ]];
  const r = A.errosPorUsuario(alertas, q.criadores, q.usuarios);
  assert.strictEqual(r.erros.length, 3);
  assert.strictEqual(r.sem_usuario, 1);
  assert.strictEqual(r.erros.find((e) => e.id_despesa === '9001').papel, 'lancou');
  const mex = r.erros.find((e) => e.id_despesa === '9003');
  assert.strictEqual(mex.papel, 'mexeu');
  assert.strictEqual(mex.id_usuario_sl, '502');
  assert.ok(!r.erros.some((e) => e.tipo === 'R6_VENCIDA'));
});

// ── cliente limitado, agendamento e envio desligado ───────────────────────
t('cliente: no máximo 2 chamadas ao mesmo tempo, teto de chamadas e só get', async () => {
  let ativos = 0, pico = 0;
  const base = { get: () => new Promise((ok) => { ativos++; pico = Math.max(pico, ativos); setTimeout(() => { ativos--; ok([]); }, 10); }), post: () => { throw new Error('não pode'); } };
  const c = A.clienteLimitado(base, 5);
  assert.strictEqual(c.post, undefined);
  const r = await Promise.allSettled(Array.from({ length: 8 }, () => c.get('x', {})));
  assert.strictEqual(pico, 2);
  assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 5);
  assert.strictEqual(c.recusadas(), 3);
  assert.strictEqual(r.find((x) => x.status === 'rejected').reason.message, 'limite_chamadas');
});
t('agendador: só a partir das 7h, uma vez por dia, pula fim de semana', async () => {
  let agora = { dia: '2026-10-21', hora: 6, minuto: 59 };
  const feitos = [];
  const ag = A.criarAgendador({ agora: () => agora, executar: async (d) => { feitos.push(d); } });
  assert.strictEqual(await ag.verificar(), false);
  agora = { dia: '2026-10-21', hora: 7, minuto: 0 };
  assert.strictEqual(await ag.verificar(), true);
  assert.strictEqual(await ag.verificar(), false);
  agora = { dia: '2026-10-24', hora: 8, minuto: 0 }; // sábado
  assert.strictEqual(await ag.verificar(), false);
  agora = { dia: '2026-10-26', hora: 12, minuto: 0 }; // segunda, depois do meio dia
  assert.strictEqual(await ag.verificar(), false);
  agora = { dia: '2026-10-27', hora: 11, minuto: 59 };
  assert.strictEqual(await ag.verificar(), true);
  assert.deepStrictEqual(feitos, ['2026-10-21', '2026-10-27']);
  const hora = A.agoraSP(new Date('2026-10-21T10:00:00Z'));
  assert.deepStrictEqual(hora, { dia: '2026-10-21', hora: 7, minuto: 0 });
});
t('envio para fora desligado', async () => {
  assert.strictEqual(envio.canalAtivo(), null);
  assert.deepStrictEqual(await envio.enviarResumo({}), { enviado: false, motivo: 'canal_nao_escolhido' });
});

// ── geração com Superlógica simulado ──────────────────────────────────────
function clienteFalso(chamadas) {
  return {
    get: async (action, p) => {
      chamadas.push([action, Object.assign({}, p)]);
      if (action === 'condominios/get') return [{ id_condominio_cond: '10', st_fantasia_cond: 'Cond A' }, { id_condominio_cond: '20', st_fantasia_cond: 'Cond Z' }];
      if (action === 'contabancos/index') return [{ id_contabanco_cb: '1', id_condominio_cond: '10', st_descricao_cb: 'Movimento', fl_principal_cb: '1', id_tipocontabanco_tcb: '1' }];
      if (action === 'conciliacao/index') return { itens: [] };
      if (action === 'auditoria/index') return [{ id_usuario_usu: '501', st_apelido_usu: 'ANA', st_texto_aud: 'Despesa#9001 criada.', dt_data_aud: '10/20/2026 09:00:00', st_sql_aud: '10' }];
      return [];
    },
  };
}
const grupos = async () => [
  { id: 1, nome: 'Carteira A', tipo: 'gerente', gerente: 'ANA', condominios: [10, 143, 167] },
  { id: 2, nome: 'Carteira B', tipo: 'grupo', gerente: '', condominios: [20] },
];
t('gerar resumo: carteira pedida, ids excluídos fora e só GET', async () => {
  const chamadas = [];
  const r = await A.gerarResumo({ cliente: clienteFalso(chamadas), grupos, hoje: '2026-10-21' }, { carteiras: [1], limiteDias: 2 });
  assert.strictEqual(r.carteiras.length, 1);
  assert.strictEqual(r.carteiras[0].id, 1);
  assert.strictEqual(r.geral.parcial, true);
  assert.strictEqual(r.sem_carteira, null);
  const it = r.carteiras[0].itens;
  assert.ok(it.some((i) => i.tipo === 'sem_extrato' && i.id_condominio === '10' && i.gravidade === 'alta'), JSON.stringify(it));
  for (const [, p] of chamadas) assert.ok(!['143', '144', '145', '160', '162', '167'].includes(String(p.idCondominio)), 'chamou condomínio excluído');
  assert.strictEqual(r.geral.chamadas, chamadas.length);
  assert.ok(r.geral.usuarios.some((u) => u.id_usuario_sl === '501'));
  const linhas = A.linhasParaGravar(r, 'teste');
  assert.deepStrictEqual(linhas.map((l) => l.chave), ['geral', 'carteira:1']);
});
t('gerar resumo: carteira que não existe recusa', async () => {
  await assert.rejects(A.gerarResumo({ cliente: clienteFalso([]), grupos, hoje: '2026-10-21' }, { carteiras: [99] }), /carteira_nao_encontrada/);
});
t('gerar resumo: teto de chamadas estourado vira falha anotada, sem quebrar', async () => {
  const r = await A.gerarResumo({ cliente: clienteFalso([]), grupos, hoje: '2026-10-21' }, { maxChamadas: 3 });
  assert.ok(r.geral.chamadas_recusadas > 0);
  assert.ok(r.geral.falhas_total > 0);
  assert.ok(r.sem_carteira);
});

// ── rotas com banco em memória e perfis simulados ─────────────────────────
function bancoFalso() {
  const tab = { fin_avisos: [], fin_avisos_execucoes: [], fin_usuarios_superlogica: [] };
  return {
    tab,
    async inserir(t, l) {
      if (t === 'fin_avisos_execucoes' && l.origem === 'agendado' && tab[t].some((x) => x.origem === 'agendado' && x.dia === l.dia)) return false;
      tab[t].push(Object.assign({}, l)); return true;
    },
    async upsert(t, linhas, conflito) {
      const cols = conflito.split(',');
      linhas.forEach((l) => {
        const i = tab[t].findIndex((x) => cols.every((c) => String(x[c]) === String(l[c])));
        if (i >= 0) tab[t][i] = Object.assign({}, tab[t][i], l); else tab[t].push(Object.assign({}, l));
      });
      return linhas.length;
    },
    async ler(q) {
      const [t, qs] = q.split('?');
      const p = new URLSearchParams(qs);
      let l = tab[t].slice();
      if (p.get('chave') === 'eq.geral') l = l.filter((x) => x.chave === 'geral');
      if (p.get('dia')) l = l.filter((x) => x.dia === p.get('dia').slice(3));
      const inn = p.get('chave') && p.get('chave').startsWith('in.(') ? p.get('chave').slice(4, -1).split(',').map((s) => s.replace(/"/g, '')) : null;
      if (inn) l = l.filter((x) => inn.includes(x.chave));
      if (t === 'fin_avisos' && /order=dia.desc/.test(q)) l.sort((a, b) => (a.dia < b.dia ? 1 : -1));
      return l;
    },
  };
}
// Identificadores fictícios montados na hora (formato de uuid, sem valor real).
const uid = (fim) => ['0'.repeat(8), '0'.repeat(4), '4000', '8000', '0'.repeat(10) + fim].join('-');
const UID = { g: uid('0a'), a: uid('0b'), b: uid('0c'), r: uid('0d'), s: uid('0e') };
const FIN = { financeiro: { visivel: true, acoes: ['ver'] } };
const PERFIS = {
  [UID.g]: { id: UID.g, role: 'GESTOR', email: 'gestor@example.com', permissoes: {} },
  [UID.a]: { id: UID.a, role: 'GERENTE', email: 'ana@example.com', permissoes: FIN },
  [UID.b]: { id: UID.b, role: 'GERENTE', email: 'bia@example.com', permissoes: {} },
  [UID.r]: { id: UID.r, role: 'OPERACIONAL', email: 'op@example.com', permissoes: FIN },
  [UID.s]: { id: UID.s, role: 'GERENTE', email: 'sem@example.com', permissoes: FIN },
};
const ESCOPO = { [UID.a]: 1, [UID.b]: 1, [UID.r]: 1 };
function montarApp(banco, chamadas) {
  const app = express();
  const original = finBanco.criarBanco;
  finBanco.criarBanco = () => banco;
  const requireAuth = (req, res, next) => { const u = req.get('x-u'); if (!u) return res.status(401).end(); req.user = { sub: u }; next(); };
  const requireGestor = (req, res, next) => ((PERFIS[req.user.sub] || {}).role === 'GESTOR' ? next() : res.status(403).json({ erro: 'acesso_negado' }));
  const r = require('../financeiro/avisos-rotas').registrar({
    app, express, requireAuth, requireGestor,
    lerPerfil: async (id) => PERFIS[id] || null,
    carteira: { escopo: async (req) => (ESCOPO[req.user.sub] ? { todas: false, carteiras: [{ id: 1, nome: 'Carteira A' }], ids: new Set([10]) } : { todas: true }) },
    gruposCarteiras: grupos, clienteSL: () => clienteFalso(chamadas), superlogicaNativa: () => true,
    supabaseUrl: 'https://x.supabase.co', supabaseChave: 'x',
    supabaseAdminRequest: async () => ({ status: 200, body: Object.values(PERFIS) }),
    env: { AVISOS_AGENDADOR: '0' }, log: () => {},
  });
  finBanco.criarBanco = original;
  return { app, rotas: r };
}

t('rotas: quem vê o quê, geração só GESTOR e vínculos validados', async () => {
  const banco = bancoFalso();
  const DIA = '2026-01-05';
  banco.tab.fin_avisos.push(
    { dia: DIA, chave: 'geral', conteudo: { gerado_em: '2026-01-05T10:00:00Z', limite_dias: 2, usuarios: [{ id_usuario_sl: '501', usuario: 'ANA', lancamentos: 3 }, { id_usuario_sl: '502', usuario: 'BRUNO', lancamentos: 1 }],
      erros: [{ id_usuario_sl: '501', regra: 'R2', tipo: 'R2_CONDOMINIO_TROCADO', gravidade: 'alta', relacionados: ['outro 77'], detalhe: 'segredo do outro', id_condominio: '10' },
        { id_usuario_sl: '502', regra: 'R1', tipo: 'R1_DOCUMENTO', gravidade: 'media', id_condominio: '20' }] } },
    { dia: DIA, chave: 'carteira:1', conteudo: { id: 1, nome: 'Carteira A', itens: [{ tipo: 'sem_extrato', gravidade: 'alta', id_condominio: '10' }, { tipo: 'vencidas', gravidade: 'media', id_condominio: '99' }], totais: {} } },
    { dia: DIA, chave: 'carteira:2', conteudo: { id: 2, nome: 'Carteira B', itens: [{ tipo: 'boletos', gravidade: 'media', id_condominio: '20' }], totais: {} } });
  banco.tab.fin_usuarios_superlogica.push({ id_usuario_sl: '501', apelido: 'ANA', profile_id: UID.a, carteira: 1 });
  const chamadas = [];
  const { app, rotas } = montarApp(banco, chamadas);
  const srv = http.createServer(app);
  await new Promise((ok) => srv.listen(0, ok));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const pedir = async (u, metodo, caminho, corpo) => {
    const r = await fetch(base + caminho, { method: metodo || 'GET', headers: Object.assign({ 'content-type': 'application/json' }, u ? { 'x-u': u } : {}), body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  try {
    assert.strictEqual((await pedir(null, 'GET', '/api/avisos/meu-dia')).status, 401);
    assert.deepStrictEqual((await pedir(UID.r, 'GET', '/api/avisos/meu-dia')).j, { mostrar: false }, 'OPERACIONAL não vê');
    assert.deepStrictEqual((await pedir(UID.b, 'GET', '/api/avisos/meu-dia')).j, { mostrar: false }, 'sem módulo financeiro não vê');
    assert.deepStrictEqual((await pedir(UID.s, 'GET', '/api/avisos/meu-dia')).j, { mostrar: false }, 'sem carteira e sem vínculo não vê');
    const a = (await pedir(UID.a, 'GET', '/api/avisos/meu-dia')).j;
    assert.strictEqual(a.mostrar, true);
    assert.deepStrictEqual(a.carteiras.map((c) => c.id), [1]);
    assert.deepStrictEqual(a.carteiras[0].itens.map((i) => i.id_condominio), ['10'], 'só condomínios da carteira');
    assert.deepStrictEqual(a.erros.map((e) => e.id_usuario_sl), ['501'], 'só os erros dele');
    assert.ok(!a.erros[0].relacionados && !/segredo/.test(a.erros[0].detalhe), 'R2 sem dados do outro condomínio');
    assert.strictEqual(a.vinculos, undefined);
    assert.strictEqual(a.sem_carteira, undefined);
    const g = (await pedir(UID.g, 'GET', '/api/avisos/meu-dia')).j;
    assert.strictEqual(g.gestor, true);
    assert.strictEqual(g.carteiras.length, 2);
    assert.strictEqual(g.erros.length, 2);
    assert.ok(Array.isArray(g.vinculos));

    // Geração sob demanda.
    assert.strictEqual((await pedir(UID.a, 'POST', '/api/avisos/gerar', {})).status, 403);
    assert.strictEqual((await pedir(UID.r, 'POST', '/api/avisos/gerar', {})).status, 403);
    assert.strictEqual((await pedir(UID.g, 'POST', '/api/avisos/gerar', { carteiras: 'x' })).status, 400);
    assert.strictEqual((await pedir(UID.g, 'POST', '/api/avisos/gerar', { limite_dias: 0 })).status, 400);
    assert.strictEqual((await pedir(UID.g, 'POST', '/api/avisos/gerar', { carteiras: [99] })).status, 404);
    const ger = await pedir(UID.g, 'POST', '/api/avisos/gerar', { carteiras: [1], limite_dias: 3 });
    assert.strictEqual(ger.status, 202, JSON.stringify(ger.j));
    assert.ok([409, 429].includes((await pedir(UID.g, 'POST', '/api/avisos/gerar', {})).status), 'uma por vez e espera entre gerações');
    for (let i = 0; i < 100 && rotas.servico.situacao(); i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.strictEqual(rotas.servico.situacao(), null);
    const exec = banco.tab.fin_avisos_execucoes.find((x) => x.id === ger.j.execucao);
    assert.strictEqual(exec.status, 'ok', JSON.stringify(exec));
    assert.strictEqual(exec.resumo.envio.enviado, false);
    assert.ok(banco.tab.fin_avisos.some((x) => x.chave === 'carteira:1' && x.origem === 'sob_demanda'));
    assert.strictEqual((await pedir(UID.g, 'POST', '/api/avisos/gerar', {})).status, 429, 'espera entre gerações');
    const sit = (await pedir(UID.g, 'GET', '/api/avisos/situacao')).j;
    assert.strictEqual(sit.envio_para_fora, 'desligado');
    assert.strictEqual(sit.agendador.ligado, false);
    assert.strictEqual((await pedir(UID.a, 'GET', '/api/avisos/situacao')).status, 403);

    // Vínculos.
    assert.strictEqual((await pedir(UID.a, 'GET', '/api/avisos/vinculos')).status, 403);
    assert.strictEqual((await pedir(UID.a, 'PUT', '/api/avisos/vinculos/502', { profile_id: UID.a })).status, 403);
    assert.strictEqual((await pedir(UID.g, 'PUT', '/api/avisos/vinculos/abc', {})).status, 400);
    assert.strictEqual((await pedir(UID.g, 'PUT', '/api/avisos/vinculos/999999', {})).status, 400);
    assert.strictEqual((await pedir(UID.g, 'PUT', '/api/avisos/vinculos/501', { profile_id: uid('ff') })).status, 400);
    assert.strictEqual((await pedir(UID.g, 'PUT', '/api/avisos/vinculos/501', { carteira: 99 })).status, 400);
    assert.strictEqual((await pedir(UID.g, 'PUT', '/api/avisos/vinculos/888', { profile_id: UID.b })).status, 404);
    const v = await pedir(UID.g, 'PUT', '/api/avisos/vinculos/501', { profile_id: UID.b, carteira: 2, apelido: '<b>falso</b>' });
    assert.strictEqual(v.status, 200, JSON.stringify(v.j));
    assert.strictEqual(v.j.vinculo.apelido, 'ANA', 'apelido vem do servidor');
    const lv = (await pedir(UID.g, 'GET', '/api/avisos/vinculos')).j;
    assert.ok(lv.usuarios.find((u) => u.id_usuario_sl === '501').profile_id === UID.b);
    assert.strictEqual(lv.usuarios.find((u) => u.id_usuario_sl === '501').sugestao_carteira, 1, 'sugestão pela carteira de gerente');
    // Depois de trocar o vínculo, a Ana não vê mais os erros do 501.
    const a2 = (await pedir(UID.a, 'GET', '/api/avisos/meu-dia')).j;
    assert.ok(a2.mostrar && !a2.erros.length);
  } finally { srv.close(); }
});

t('serviço: uma geração por vez e a agendada só uma vez por dia', async () => {
  const banco = bancoFalso();
  let soltar;
  const trava = new Promise((ok) => { soltar = ok; });
  const lento = { get: async (a, p) => { await trava; return clienteFalso([]).get(a, p); } };
  const s = A.criarServico({ banco, cliente: () => lento, grupos, log: () => {}, hoje: () => '2026-10-21', esperaSobDemanda: 0 });
  const r1 = await s.iniciar({ origem: 'agendado' });
  await assert.rejects(s.iniciar({ origem: 'sob_demanda' }), /geracao_em_andamento/);
  soltar();
  await r1.promessa;
  assert.strictEqual(await s.iniciar({ origem: 'agendado' }), null, 'agendada repetida no mesmo dia não roda');
  assert.strictEqual(banco.tab.fin_avisos_execucoes.filter((x) => x.origem === 'agendado').length, 1);
  assert.ok(banco.tab.fin_avisos.some((x) => x.chave === 'sem_carteira'));
});
t('banco dos avisos recusa o Supabase de produção', () => {
  assert.throws(() => finBanco.criarBanco({ url: 'https://mtucxdfepkwsfnqpfydb.supabase.co', chave: 'x' }), /supabase_nao_permitido/);
});

(async () => {
  for (const [nome, fn] of testes) {
    try { await fn(); ok++; console.log('ok   ' + nome); } catch (e) { falhou++; console.log('FALHA ' + nome + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)); }
  }
  console.log('\n' + ok + ' ok, ' + falhou + ' falha(s)');
  process.exit(falhou ? 1 : 0);
})();
