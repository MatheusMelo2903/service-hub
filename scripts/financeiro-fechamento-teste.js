'use strict';
// T38: testes do Fechamento do mês e da conferência dos anexos (sem rede, sem banco).
// Uso: NODE_PATH=<repo>/node_modules node scripts/financeiro-fechamento-teste.js
const assert = require('assert');
const F = require('../financeiro/fechamento');
const A = require('../financeiro/anexos-conferencia');

let ok = 0;
const testes = [];
const t = (nome, fn) => testes.push([nome, fn]);

// ── último dia útil ───────────────────────────────────────────────────────
const comp = (r) => A.competencia(r);
t('último dia útil de setembro de 2026', () => assert.strictEqual(F.ultimoDiaUtil(comp('2026-09'), '2026-10-21'), '2026-09-30'));
t('mês corrente: dia útil antes de hoje', () => assert.strictEqual(F.ultimoDiaUtil(comp('2026-10'), '2026-10-21'), '2026-10-20'));
t('mês corrente numa segunda: sexta anterior', () => assert.strictEqual(F.ultimoDiaUtil(comp('2026-10'), '2026-10-19'), '2026-10-16'));
t('mês que termina no domingo', () => assert.strictEqual(F.ultimoDiaUtil(comp('2026-05'), '2026-10-21'), '2026-05-29'));
t('primeiro dia do mês corrente sem dia útil completo', () => assert.strictEqual(F.ultimoDiaUtil(comp('2026-11'), '2026-11-01'), null));
t('competência inválida', () => { assert.strictEqual(A.competencia('2026-13'), null); assert.strictEqual(A.competencia('abc'), null); });

// ── checklist ─────────────────────────────────────────────────────────────
const contaOk = (o) => Object.assign({ id: '1', descricao: 'Sicoob principal', principal: true, situacao: 'ok',
  quadro: { ultimo_extrato: '2026-09-30', diferenca_saldo: 0, data_saldo: '2026-09-30', movimento_baixo: false }, totais: { banco_sem_lancamento: 0, lancamento_sem_banco: 0, valor_diferente: 0 } }, o || {});
const base = () => ({
  comp: comp('2026-09'), hoje: '2026-10-21',
  conc: { nome: 'Teste', contas: [contaOk(), { id: '9', descricao: 'Caixa', situacao: 'conta_caixa' }] },
  pre: { pode_fechar: true, pendencias: 0, para_conferir: 1, parcelas_pagas: 10, grupos: [], falhas: [] },
  boletos: { resumo: { boletos: 100, unidades_com_boleto: 100, alertas: 0, valor_total: 50000, alertas_por_tipo: {} } },
  anexos: { pronto: true, resultado: { pode_fechar: true, resumo: { anexos: 30, despesas: 10, para_conferir: 0, falhas: 0, lidos_texto: 28, lidos_interna: 2 } } },
  marcas: {},
});
const itemDe = (f, k) => f.itens.find((i) => i.chave === k);
t('tudo certo: pronto para gerar o balancete', () => {
  const f = F.montarFechamento(base());
  assert.strictEqual(f.pronto, true); assert.strictEqual(f.status, 'Pronto para gerar o balancete'); assert.strictEqual(f.itens.length, 5);
});
t('diferença na conciliação trava', () => {
  const e = base(); e.conc.contas[0].quadro.diferenca_saldo = -680.25;
  const f = F.montarFechamento(e);
  assert.strictEqual(f.pronto, false); assert.strictEqual(itemDe(f, 'conciliacao').situacao, 'pendente');
  assert.ok(/680,25/.test(itemDe(f, 'conciliacao').trava)); assert.strictEqual(itemDe(f, 'conciliacao').pode_marcar, false);
});
t('extrato da conta principal atrasado trava', () => {
  const e = base(); e.conc.contas[0].quadro.ultimo_extrato = '2026-09-25';
  const it = itemDe(F.montarFechamento(e), 'extrato');
  assert.strictEqual(it.situacao, 'pendente'); assert.ok(/25\/09\/2026/.test(it.trava));
});
t('conta de pouco movimento atrasada só avisa', () => {
  const e = base(); e.conc.contas.push(contaOk({ id: '2', descricao: 'Poupança', principal: false, quadro: { ultimo_extrato: '2026-08-10', diferenca_saldo: 0, movimento_baixo: true } }));
  const it = itemDe(F.montarFechamento(e), 'extrato');
  assert.strictEqual(it.situacao, 'ok'); assert.ok(/pouco movimento/.test(it.detalhe));
});
t('conta principal sem extrato no mês trava', () => {
  const e = base(); e.conc.contas[0] = { id: '1', descricao: 'Sicoob', principal: true, situacao: 'sem_extrato' };
  assert.strictEqual(itemDe(F.montarFechamento(e), 'extrato').situacao, 'pendente');
});
t('pré balancete com pendência e marca manual que cobre', () => {
  const e = base(); e.pre = { pode_fechar: false, pendencias: 3, grupos: [{ titulo: 'Pagas sem comprovante', bloqueiam: 3 }], falhas: [] };
  let it = itemDe(F.montarFechamento(e), 'pre_balancete');
  assert.strictEqual(it.situacao, 'pendente'); assert.ok(/3 pagas sem comprovante/.test(it.trava));
  e.marcas = { pre_balancete: { ativo: true, pendencias: 3, marcado_por_email: 'a@b.c', marcado_em: '2026-10-21T15:00:00Z' } };
  const f = F.montarFechamento(e);
  it = itemDe(f, 'pre_balancete');
  assert.strictEqual(it.situacao, 'conferido'); assert.strictEqual(f.pronto, true);
});
t('marca perde a validade com pendência nova', () => {
  const e = base(); e.pre = { pode_fechar: false, pendencias: 4, grupos: [{ titulo: 'Pagas sem nota', bloqueiam: 4 }], falhas: [] };
  e.marcas = { pre_balancete: { ativo: true, pendencias: 3, marcado_por_email: 'a@b.c' } };
  const it = itemDe(F.montarFechamento(e), 'pre_balancete');
  assert.strictEqual(it.situacao, 'pendente'); assert.strictEqual(it.marca.vencida, true);
});
t('marca não vale para conciliação', () => {
  const e = base(); e.conc.contas[0].quadro.diferenca_saldo = 10; e.marcas = { conciliacao: { ativo: true, pendencias: 99 } };
  assert.strictEqual(itemDe(F.montarFechamento(e), 'conciliacao').situacao, 'pendente');
});
t('boletos com alertas e sem boleto', () => {
  const e = base(); e.boletos.resumo.alertas = 2; e.boletos.resumo.alertas_por_tipo = { sem_boleto: 2 };
  assert.ok(/2 ponto/.test(itemDe(F.montarFechamento(e), 'boletos').trava));
  e.boletos.resumo = { boletos: 0 };
  assert.strictEqual(itemDe(F.montarFechamento(e), 'boletos').situacao, 'pendente');
});
t('anexos conferindo e falha de leitura', () => {
  const e = base(); e.anexos = { calculando: true, feitos: 3, total: 10 };
  let f = F.montarFechamento(e);
  assert.strictEqual(itemDe(f, 'anexos').situacao, 'calculando'); assert.strictEqual(f.calculando, true); assert.strictEqual(f.status, 'Conferindo os anexos');
  e.anexos = { erro: 'x' }; e.conc = { erro: 'y' };
  f = F.montarFechamento(e);
  assert.strictEqual(itemDe(f, 'anexos').situacao, 'falha'); assert.strictEqual(itemDe(f, 'conciliacao').situacao, 'falha'); assert.strictEqual(itemDe(f, 'extrato').situacao, 'falha');
  assert.strictEqual(f.pronto, false);
});
t('pré balancete sem pendência mas com leitura falha não fica pronto', () => {
  const e = base(); e.pre.falhas = ['despesas/index'];
  assert.strictEqual(itemDe(F.montarFechamento(e), 'pre_balancete').situacao, 'pendente');
});

// ── conferência dos anexos (CNPJs fictícios com dígitos válidos) ───────────
function cnpj(b12) {
  const d = String(b12).split('').map(Number);
  const dv = (n) => { const p = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = p.reduce((a, x, i) => a + x * d[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  d.push(dv(12)); d.push(dv(13));
  return d.join('');
}
const fmt = (c) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const C_COND = cnpj('111111110001'), C_FORN = cnpj('222222220001'), C_OUTRO = cnpj('333333330001');
const parcela = (id, valor, liq) => ({ id_despesa_des: id, id_parcela_pdes: id + '1', id_condominio_cond: '900', st_nome_con: 'FORNECEDOR ' + id, vl_valor_pdes: valor, dt_liquidacao_pdes: liq + ' 00:00:00', dt_vencimento_pdes: liq + ' 00:00:00' });
const anexo = (id, etiqueta, nome) => ({ id_arquivo_arq: id, st_hash_arq: 'h' + id, st_nome_arq: nome || ('arq' + id + '.pdf'), st_extensao_arq: 'pdf', st_nomeabreviadoetiqueta_eti: etiqueta });
function resultado(itens, despesas) {
  return A.montarResultado({ idCond: '900', comp: comp('2026-09'), itens, despesas, cnpjCond: C_COND, outros: new Map([[C_OUTRO, 'CONDOMINIO VIZINHO']]), linkDe: (d) => 'https://x.superlogica.net/clients/condor/despesas/id/' + d });
}
t('comprovante certo não gera achado', () => {
  const d = [parcela('10', '1500.00', '09/15/2026')];
  const r = resultado([{ idDesp: '10', anexo: anexo(1, 'Comprovante'), reg: { leitura: 'texto', texto: 'Comprovante de pagamento\nFavorecido CNPJ ' + fmt(C_FORN) + '\nPagador CNPJ ' + fmt(C_COND) + '\nValor R$ 1.500,00\nData 15/09/2026', meta: { Producer: 'Sicoob' } } }], d);
  assert.strictEqual(r.resumo.para_conferir, 0); assert.strictEqual(r.pode_fechar, true); assert.strictEqual(r.resumo.lidos_texto, 1);
});
t('comprovante com valor e data diferentes', () => {
  const d = [parcela('11', '1500.00', '09/15/2026')];
  const r = resultado([{ idDesp: '11', anexo: anexo(2, 'Comprovante'), reg: { leitura: 'texto', texto: 'Comprovante de pagamento\nPagador ' + fmt(C_COND) + '\nValor R$ 1.450,00\nData 14/09/2026', meta: {} } }], d);
  assert.ok(r.despesas[0].achados.some((a) => a.tipo === 'comprovante_valor')); assert.strictEqual(r.pode_fechar, false);
});
t('CNPJ de outro condomínio e máscara para quem tem carteira', () => {
  const d = [parcela('12', '800.00', '09/10/2026')];
  const r = resultado([{ idDesp: '12', anexo: anexo(3, 'Doc. Fiscal'), reg: { leitura: 'texto', texto: 'Nota fiscal de serviço\nPrestador ' + fmt(C_FORN) + '\nTomador ' + fmt(C_OUTRO) + '\nValor 800,00', meta: {} } }], d);
  const a = r.despesas[0].achados.find((x) => x.tipo === 'cnpj_outro_condominio');
  assert.ok(a && /VIZINHO/.test(a.motivo)); assert.strictEqual(a.gravidade, 'alta');
  const restrito = A.paraTela(r, true);
  assert.ok(!/VIZINHO/.test(JSON.stringify(restrito)));
  assert.ok(/VIZINHO/.test(JSON.stringify(A.paraTela(r, false))));
});
t('PDF de editor e modificado', () => {
  const d = [parcela('13', '99.90', '09/05/2026')];
  const r = resultado([{ idDesp: '13', anexo: anexo(4, 'Pgto'), reg: { leitura: 'escaneado', texto: '', meta: { Producer: 'Microsoft Excel', CreationDate: '2026-09-01T10:00:00-03:00', ModDate: '2026-09-03T10:00:00-03:00' } } }], d);
  const tipos = r.despesas[0].achados.map((x) => x.tipo);
  assert.ok(tipos.includes('pdf_editor') && tipos.includes('pdf_modificado'));
  assert.strictEqual(r.resumo.escaneados_nao_lidos, 1); assert.strictEqual(r.escaneados.length, 1);
});
t('falha de download impede fechar; sem anexo só conta', () => {
  const d = [parcela('14', '10.00', '09/05/2026'), parcela('15', '20.00', '09/06/2026')];
  const r = resultado([{ idDesp: '14', anexo: anexo(5, 'Comprovante'), reg: { leitura: 'falha', temporario: true } }], d);
  assert.strictEqual(r.resumo.falhas, 1); assert.strictEqual(r.resumo.sem_anexo, 1); assert.strictEqual(r.pode_fechar, false);
});
t('leitura interna vira texto que as regras entendem', () => {
  const txt = A.textoDaInterna({ tipo: 'comprovante', valor: '1.500,00', vencimento: '15/09/2026', cnpj_pagador: C_COND, cnpj_beneficiario: C_FORN });
  const d = [parcela('16', '1500.00', '09/15/2026')];
  const r = resultado([{ idDesp: '16', anexo: anexo(6, 'Comprovante'), reg: { leitura: 'interna', texto: txt, meta: {} } }], d);
  assert.strictEqual(r.resumo.lidos_interna, 1); assert.strictEqual(r.resumo.para_conferir, 0);
  assert.strictEqual(A.textoDaInterna(null), '');
});
t('contador por hora para no teto', () => {
  const c = A.criarContadorHora(() => 2);
  assert.strictEqual(c(), true); assert.strictEqual(c(), true); assert.strictEqual(c(), false);
});
t('estado recusa cadastro que não é condomínio e mês inválido', () => {
  const s = A.criarConferenciaAnexos({ cliente: () => ({ get: async () => [] }), cred: () => ({}) });
  assert.throws(() => s.estado('143', '2026-09', {}), /nao_condominio/);
  assert.throws(() => s.estado('136', '2026-13', {}), /competencia_invalida/);
});

// ── rotas: permissão, carteira e falha fechada (servidor de mentira, sem Superlógica) ──
const express = require('express');
const finPainel = require('../financeiro/painel');
const PERFIS = {
  gestor: { role: 'GESTOR' },
  raiane: { role: 'OPERACIONAL', permissoes: { cobranca: { visivel: true, acoes: ['ver'] } }, carteira: ['136'] },
  so_ver: { role: 'GERENTE', permissoes: { financeiro: { visivel: true, acoes: ['ver'] }, boletos: { visivel: true, acoes: ['ver'] }, conciliacao: { visivel: true, acoes: ['ver'] } }, carteira: ['136'] },
  sem_conc: { role: 'GERENTE', permissoes: { financeiro: { visivel: true, acoes: ['ver', 'pre_balancete'] }, boletos: { visivel: true, acoes: ['ver'] } }, carteira: ['136'] },
  completo: { role: 'GERENTE', permissoes: { financeiro: { visivel: true, acoes: ['ver', 'pre_balancete'] }, boletos: { visivel: true, acoes: ['ver'] }, conciliacao: { visivel: true, acoes: ['ver'] } }, carteira: ['136'] },
};
const podeModulo = (p, m, a) => !!p && (p.role === 'GESTOR' || !!(p.permissoes && p.permissoes[m] && p.permissoes[m].visivel && (!a || p.permissoes[m].acoes.includes(a))));
const auditados = [];
function montarApp() {
  const app = express();
  const perfil = (req) => { const k = req.headers['x-perfil']; if (k === 'quebrado') throw new Error('perfil'); return PERFIS[k] || null; };
  app.use((req, res, next) => { req.user = { sub: 'u-' + req.headers['x-perfil'], email: req.headers['x-perfil'] + '@example.com' }; req.authMode = 'supabase'; next(); });
  const deny = (res, s, e) => { res.status(s).json({ erro: e }); return false; };
  require('../servico/rotas-fechamento').criarRotasFechamento(app, {
    requireAuth: (req, res, next) => next(), express,
    exigirFinanceiro: async (req, res, acao) => { let p; try { p = perfil(req); } catch (e) { return deny(res, 503, 'permissao_indisponivel'); } return finPainel.temFinanceiro(p, acao) || deny(res, 403, 'modulo_sem_acesso'); },
    exigirModuloItem: async (req, res, m) => { let p; try { p = perfil(req); } catch (e) { return deny(res, 503, 'permissao_indisponivel'); } return podeModulo(p, m, 'ver') || deny(res, 403, 'modulo_sem_acesso'); },
    exigirLeituraSuperlogica: async () => true,
    exigirCarteira: async (req, res, id) => { const p = perfil(req); return !p.carteira || p.carteira.includes(String(id)) || deny(res, 403, 'fora_da_carteira'); },
    exigirEscopoFinanceiro: async (req, res, id) => { const p = perfil(req); if (p.carteira && !p.carteira.includes(String(id))) { deny(res, 403, 'fora_da_carteira'); return null; } return { escopo: p.carteira ? new Set(p.carteira) : null }; },
    escopoFinanceiro: async (req) => { const p = perfil(req); return p.carteira ? new Set(p.carteira) : null; },
    gruposCarteiras: async () => [{ id: 5, condominios: ['136', '2'] }],
    clienteSL: () => ({ get: async (acao) => (acao === 'condominios/get' ? [{ id_condominio_cond: '136', st_cpf_cond: C_COND, st_fantasia_cond: 'CASA' }] : []) }),
    credSL: () => ({}),
    painelFin: { preBalancete: async () => ({ pode_fechar: true, pendencias: 0, grupos: [], falhas: [], nome: 'CASA' }) },
    conciliacao: { condominio: async () => ({ nome: 'CASA', contas: [contaOk()] }) },
    boletos: async () => ({ resumo: { boletos: 5, alertas: 0, alertas_por_tipo: {} } }),
    dentroDoLimite: () => true, auditoria: { evento: (req, acao) => auditados.push(acao) },
    processar: { processarDocumentoFinanceiro: async () => ({ status: 500 }) },
    linkDe: () => '', supabase: { url: '', chave: '' }, hoje: () => '2026-10-21',
  });
  return app;
}

async function rotas() {
  const srv = montarApp().listen(0);
  const porta = srv.address().port;
  const req = async (perfil, caminho, corpo) => {
    const r = await fetch('http://127.0.0.1:' + porta + caminho, { method: corpo ? 'POST' : 'GET', headers: Object.assign({ 'x-perfil': perfil }, corpo ? { 'content-type': 'application/json' } : {}), body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  const casos = [
    ['raiane não vê o fechamento', 'raiane', '/api/financeiro/condominio/136/fechamento?competencia=2026-09', null, 403],
    ['raiane não vê os anexos', 'raiane', '/api/financeiro/condominio/136/anexos?competencia=2026-09', null, 403],
    ['raiane não vê o quadro', 'raiane', '/api/financeiro/fechamento/quadro?competencia=2026-09', null, 403],
    ['raiane não marca', 'raiane', '/api/financeiro/condominio/136/fechamento/marcar', { competencia: '2026-09', item: 'boletos', conferido: true }, 403],
    ['só ver não abre o fechamento', 'so_ver', '/api/financeiro/condominio/136/fechamento?competencia=2026-09', null, 403],
    ['só ver não confere anexos', 'so_ver', '/api/financeiro/condominio/136/anexos?competencia=2026-09', null, 403],
    ['sem conciliação não abre o fechamento', 'sem_conc', '/api/financeiro/condominio/136/fechamento?competencia=2026-09', null, 403],
    ['perfil ilegível recusa (falha fechada)', 'quebrado', '/api/financeiro/condominio/136/fechamento?competencia=2026-09', null, 503],
    ['fora da carteira', 'completo', '/api/financeiro/condominio/2/fechamento?competencia=2026-09', null, 403],
    ['anexos fora da carteira', 'completo', '/api/financeiro/condominio/2/anexos?competencia=2026-09', null, 403],
    ['cadastro que não é condomínio', 'gestor', '/api/financeiro/condominio/143/fechamento?competencia=2026-09', null, 400],
    ['mês futuro', 'gestor', '/api/financeiro/condominio/136/fechamento?competencia=2027-01', null, 400],
    ['id inválido', 'gestor', '/api/financeiro/condominio/abc/fechamento?competencia=2026-09', null, 400],
    ['item que não aceita marca', 'gestor', '/api/financeiro/condominio/136/fechamento/marcar', { competencia: '2026-09', item: 'conciliacao', conferido: true }, 400],
    ['marca sem banco de teste', 'gestor', '/api/financeiro/condominio/136/fechamento/marcar', { competencia: '2026-09', item: 'boletos', conferido: true }, 503],
    ['marca fora da carteira', 'completo', '/api/financeiro/condominio/2/fechamento/marcar', { competencia: '2026-09', item: 'boletos', conferido: true }, 403],
  ];
  for (const [nome, perfil, caminho, corpo, esperado] of casos) {
    const r = await req(perfil, caminho, corpo);
    try { assert.strictEqual(r.status, esperado, nome + ': ' + r.status + ' ' + JSON.stringify(r.j)); ok++; console.log('ok ' + nome); }
    catch (e) { console.log('FALHOU ' + e.message); process.exitCode = 1; }
  }
  // Com acesso: fechamento completo (anexos sem despesas: pronto na segunda volta).
  let r = await req('completo', '/api/financeiro/condominio/136/fechamento?competencia=2026-09');
  for (let i = 0; i < 10 && r.status === 200 && r.j.calculando; i++) { await new Promise((ok2) => setTimeout(ok2, 200)); r = await req('completo', '/api/financeiro/condominio/136/fechamento?competencia=2026-09'); }
  try { assert.strictEqual(r.status, 200); assert.strictEqual(r.j.pronto, true, JSON.stringify(r.j.falta)); assert.strictEqual(r.j.marcas_disponiveis, false); ok++; console.log('ok fechamento com acesso fica pronto'); }
  catch (e) { console.log('FALHOU fechamento com acesso: ' + e.message); process.exitCode = 1; }
  r = await req('completo', '/api/financeiro/fechamento/quadro?competencia=2026-09&carteira=5');
  try { assert.strictEqual(r.status, 200); assert.deepStrictEqual(Object.keys(r.j.condominios), ['136']); ok++; console.log('ok quadro só com a carteira de quem vê'); }
  catch (e) { console.log('FALHOU quadro: ' + e.message + ' ' + JSON.stringify(r.j)); process.exitCode = 1; }
  srv.close();
}

(async () => {
  for (const [nome, fn] of testes) {
    try { await fn(); ok++; console.log('ok ' + nome); } catch (e) { console.log('FALHOU ' + nome + ': ' + e.message); process.exitCode = 1; }
  }
  await rotas();
  console.log((process.exitCode ? 'COM FALHAS' : 'TUDO OK') + ': ' + ok + ' testes ok');
  process.exit(process.exitCode || 0);
})();
