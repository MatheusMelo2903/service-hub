// Teste da T51 (Central de alertas e "Meus alertas"): rotas com banco, carteira, painel do
// Financeiro e cálculo do Dashboard falsos, em memória. Sem rede e sem Superlógica.
// Confere: carteira e quem vê todos, filtro de carteira, áreas e contadores, alerta velho fora,
// silenciados, pausado, 403 sem permissão, origem financeira só com módulo, segurança só com
// auditoria, cálculo em segundo plano um por vez com teto, e a marcação usada pelas rotas antigas
// (Dashboard, Seu dia, painel Financeiro com valor_alta por tipo).
// Rodar: node scripts/teste-central-alertas.js
'use strict';
const express = require('express');
const http = require('http');
const C = require('../servico/central-alertas');
const Carteira = require('../superlogica/carteira');
const finPainel = require('../financeiro/painel');

let ok = 0, falha = 0;
const t = (nome, cond) => { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const U = (n) => n.repeat(8) + '-' + n.repeat(4) + '-4' + n.repeat(3) + '-8' + n.repeat(3) + '-' + n.repeat(12);
const GESTOR = U('1'), GERENTE = U('2'), OPER = U('3'), OCULTO = U('4'), AUDITOR = U('5'), SEMSL = U('6'), GER2 = U('7');
const PERFIS = {
  [GESTOR]: { id: GESTOR, role: 'GESTOR', permissoes: {} },
  [GERENTE]: { id: GERENTE, role: 'GERENTE', permissoes: { financeiro: { visivel: true, acoes: ['ver'] }, central_alertas: { visivel: true, acoes: ['ver', 'silenciar'] } } },
  [OPER]: { id: OPER, role: 'OPERACIONAL', permissoes: { ficha_condominio: { visivel: true, acoes: ['ver'] } } },
  [OCULTO]: { id: OCULTO, role: 'OPERACIONAL', permissoes: { central_alertas: { visivel: false, acoes: [] } } },
  [AUDITOR]: { id: AUDITOR, role: 'GERENTE', permissoes: { configuracoes: { visivel: true, acoes: ['ver', 'ver_auditoria'] } } },
  [SEMSL]: { id: SEMSL, role: 'OPERACIONAL', permissoes: {} },
  // Gerente com a ação silenciar mas com o módulo escondido: não silencia.
  [GER2]: { id: GER2, role: 'GERENTE', permissoes: { central_alertas: { visivel: false, acoes: ['ver', 'silenciar'] } } },
};
const CARTEIRAS = { [GERENTE]: [10], [OPER]: [10], [GER2]: [10] };
const GRUPOS = [{ id: 10, nome: 'CARTEIRA A', tipo: 'gerente', condominios: [2, 8] }, { id: 11, nome: 'CARTEIRA B', tipo: 'gerente', condominios: [136] }];
const carteira = Carteira.criarCarteira({
  lerPerfil: async (id) => PERFIS[id] || null,
  lerCarteirasPerfis: async (id) => ({ [id]: CARTEIRAS[id] || [] }),
  semColuna: () => false, gruposCarteiras: async () => GRUPOS, ativo: () => true, express,
});

// ── banco falso ──
const agoraISO = new Date().toISOString();
const COND = [{ id_superlogica: 2, nome: 'Arquipelago' }, { id_superlogica: 8, nome: 'Monte Verde' }, { id_superlogica: 136, nome: 'Vila de Itaunas' }, { id_superlogica: 143, nome: 'Empresa do grupo' }];
const ALERTAS = [
  { id: 'a1', id_superlogica: 2, chave: 'vencer:1', tipo: 'conta_a_vencer', titulo: 'Conta vence', detalhe: { fornecedor: 'EDP', valor: 120.5 }, status: 'novo', criado_em: agoraISO, atualizado_em: agoraISO },
  { id: 'a2', id_superlogica: 2, chave: 'velho:1', tipo: 'conta_a_vencer', titulo: 'Conta já paga', detalhe: {}, status: 'novo', criado_em: agoraISO, atualizado_em: agoraISO },
  { id: 'a3', id_superlogica: 8, chave: 'cert:1', tipo: 'certidao_vencida', titulo: 'Certidão FGTS vencida', detalhe: {}, status: 'visto', criado_em: agoraISO, atualizado_em: agoraISO },
  { id: 'a4', id_superlogica: 136, chave: 'manut:1', tipo: 'manutencao_atrasada', titulo: 'Extintores', detalhe: {}, status: 'novo', criado_em: agoraISO, atualizado_em: agoraISO },
  { id: 'a5', id_superlogica: 8, chave: 'mandato:sindico:2026-11-01:vencido', tipo: 'mandato_vencendo', titulo: 'Mandato vencido', detalhe: {}, status: 'resolvido', criado_em: agoraISO, atualizado_em: agoraISO },
  { id: 'a6', id_superlogica: 143, chave: 'x', tipo: 'saldo_baixo', titulo: 'Empresa', detalhe: {}, status: 'novo', criado_em: agoraISO, atualizado_em: agoraISO },
];
const PREFS = [];
let falharPrefs = false;
function filtrar(lista, qs) {
  const p = new URLSearchParams(qs);
  let l = lista.slice();
  for (const [k, v] of p) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    const i = v.indexOf('.'); const op = v.slice(0, i); const val = v.slice(i + 1);
    if (op === 'eq') l = l.filter((x) => String(x[k]) === val);
    else if (op === 'in') { const s = new Set(val.replace(/^\(|\)$/g, '').split(',')); l = l.filter((x) => s.has(String(x[k]))); }
    else if (op === 'gte') l = l.filter((x) => String(x[k]) >= val);
    else if (op === 'not' && val === 'is.null') l = l.filter((x) => x[k] != null);
  }
  return l;
}
const chamadasBanco = [];
async function banco(metodo, caminho, corpo) {
  chamadasBanco.push(metodo + ' ' + caminho);
  const [rota, qs] = caminho.split('?');
  if (rota === '/rest/v1/condominios') return { status: 200, body: filtrar(COND, qs) };
  if (rota === '/rest/v1/alertas') return { status: 200, body: filtrar(ALERTAS, qs) };
  if (rota === '/rest/v1/alertas_preferencias') {
    if (falharPrefs) return { status: 404, body: { message: 'relation alertas_preferencias does not exist' } };
    if (metodo === 'GET') return { status: 200, body: filtrar(PREFS, qs) };
    if (metodo === 'PATCH') { const a = filtrar(PREFS, qs); a.forEach((x) => Object.assign(x, corpo)); return { status: 200, body: a }; }
    if (metodo === 'POST') { PREFS.push(Object.assign({}, corpo)); return { status: 201, body: [corpo] }; }
  }
  return { status: 404, body: null };
}

// ── cálculo do Dashboard falso (fila em segundo plano) ──
const calculados = [];
let simultaneos = 0, maxSimultaneos = 0;
const TRAVA = new Set(); // condomínios cujo cálculo nunca termina (testa o teto)
const CHAVES_CALC = { 2: ['vencer:1'], 8: ['cert:1', 'mandato:sindico:2026-11-01:vencido'], 136: ['manut:1'] };
async function calcularEGravar(id) {
  calculados.push(String(id));
  // O travado nunca termina (a fila segue depois do teto): fica fora da conta de simultâneos.
  if (TRAVA.has(String(id))) return new Promise(() => {});
  simultaneos++; maxSimultaneos = Math.max(maxSimultaneos, simultaneos);
  try {
    await espera(5);
    return { calc: { alertas: (CHAVES_CALC[id] || []).map((chave) => ({ chave })), falhas: [] } };
  } finally { simultaneos--; }
}

// ── painel do Financeiro falso ──
const BASE = {
  gerado_em: agoraISO,
  condominios: new Map([['2', { nome: 'Arquipelago' }], ['136', { nome: 'Vila de Itaunas' }], ['999', { nome: 'So nas despesas' }]]),
  porCondominio: new Map([
    ['2', [{ regra: 'R6', tipo: 'R6_VENCIDA', descricao_tipo: 'Vencida sem baixa', gravidade: 'alta', valor: 300, fornecedor: 'Elevadores', dt_vencimento: '2026-10-01', id_parcela: '77', link: 'https://condominioes.superlogica.net/x' },
      { regra: 'R2', tipo: 'R2_CONDOMINIO_TROCADO', descricao_tipo: 'Condomínio trocado', gravidade: 'media', valor: 50, id_parcela: '78', relacionados: [{ condominio: 'Outro' }] }]],
    ['136', [{ regra: 'R5', tipo: 'R5_SEM_NOTA', descricao_tipo: 'Pago sem nota fiscal', gravidade: 'baixa', valor: 10, id_parcela: '79' }]],
    ['999', [{ regra: 'R9', tipo: 'R9_MEXIDA', descricao_tipo: 'Mexida suspeita', gravidade: 'alta', valor: 1, id_parcela: '80' }]],
  ]),
};
let baseLenta = false;
const restritos = [];
const painelFin = {
  obterBase: async () => (baseLenta ? new Promise((r) => setTimeout(() => r(BASE), 400)) : BASE),
  situacao: () => ({ calculando: false }),
  alertasDoCondominio(b, id, restrito) {
    restritos.push(restrito);
    let al = b.porCondominio.get(String(id)) || [];
    if (restrito) al = al.map(finPainel.semOutroCondominio);
    return { nome: (b.condominios.get(String(id)) || {}).nome || '', alertas: al };
  },
};

// ── app ──
const app = express();
const requireAuth = (req, res, next) => {
  const u = req.headers['x-user'];
  if (u === 'internal') { req.authMode = 'internal'; return next(); }
  req.user = { sub: u }; req.authMode = 'supabase'; next();
};
const perfilDe = async (req) => (req.authMode === 'internal' ? { role: 'GESTOR', permissoes: {} } : PERFIS[req.user.sub] || null);
const central = C.criarRotasCentral(app, {
  requireAuth, express, banco, perfilDe,
  escopo: (req) => carteira.escopo(req),
  gruposCarteiras: async () => GRUPOS,
  podeLerSuperlogica: async (req) => !(req.user && req.user.sub === SEMSL),
  podeCalcular: () => true,
  calcularEGravar,
  painelFin,
  temFinanceiro: finPainel.temFinanceiro,
  nivelAuditoria: async (req) => (req.authMode === 'internal' || (req.user && req.user.sub === GESTOR) ? 'dono' : (req.user && req.user.sub === AUDITOR ? 'auditor' : null)),
  alertasUso: async () => [{ tipo: 'fora_da_carteira', titulo: 'Tentou abrir condomínio fora da carteira', email: 'x@y.com', vezes: 3, ultima: agoraISO }],
  tetoMs: 60, esperaFinMs: 100, log: () => {},
});

const srv = http.createServer(app).listen(0, async () => {
  const porta = srv.address().port;
  const pedir = (metodo, caminho, user, corpo) => new Promise((resolve) => {
    const dados = corpo == null ? null : Buffer.from(JSON.stringify(corpo));
    const q = http.request({ port: porta, path: caminho, method: metodo, headers: { 'x-user': user, ...(dados ? { 'content-type': 'application/json', 'content-length': dados.length } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ st: res.statusCode, j }); });
    });
    if (dados) q.write(dados); q.end();
  });
  const area = (j, a) => (j.areas || []).find((x) => x.area === a) || {};
  try {
    // 1. GESTOR vê todos (menos as empresas) e dispara o cálculo em segundo plano.
    TRAVA.add('8');
    const g1 = await pedir('GET', '/api/central-alertas', GESTOR);
    t('gestor 200', g1.st === 200);
    t('gestor vê 2, 8 e 136 sem a empresa 143', JSON.stringify(g1.j.condominios.map((c) => c.id_superlogica)) === '[2,8,136]');
    t('empresa 143 fora dos alertas', !g1.j.alertas.some((a) => a.id_superlogica === 143));
    t('antes do cálculo o alerta velho ainda aparece', g1.j.alertas.some((a) => a.chave === 'velho:1'));
    t('resolvido fica fora sem pedir', !g1.j.alertas.some((a) => a.status === 'resolvido'));
    t('atualizando enquanto calcula', g1.j.atualizando === true);
    t('áreas com as quatro chaves para quem tem auditoria', JSON.stringify(g1.j.areas.map((a) => a.area)) === '["financeiro","operacional","documentos","seguranca"]');
    t('nome legível da área', area(g1.j, 'documentos').nome === 'Documentos e jurídico');
    t('origem financeira para o GESTOR', g1.j.alertas.some((a) => a.origem === 'financeiro' && a.tipo === 'fin_vencida' && a.tipo_original === 'R6_VENCIDA'));
    t('GESTOR recebe condomínio que só existe nas despesas', g1.j.alertas.some((a) => a.id_superlogica === 999));
    t('duplicidade agrupa o R2', g1.j.alertas.some((a) => a.tipo === 'fin_duplicidade'));
    t('link do Superlógica no financeiro', g1.j.alertas.find((a) => a.tipo === 'fin_vencida').link.startsWith('https://'));
    t('link de tela no Dashboard e na certidão', g1.j.alertas.find((a) => a.chave === 'vencer:1').link === 'dashboard' && g1.j.alertas.find((a) => a.chave === 'cert:1').link === 'prestacao');
    t('segurança para o dono', g1.j.alertas.some((a) => a.origem === 'seguranca' && a.gravidade === 'alta' && a.link === 'seguranca'));
    t('gravidade da certidão vencida alta', g1.j.alertas.find((a) => a.chave === 'cert:1').gravidade === 'alta');
    t('resumo do detalhe', /EDP/.test(g1.j.alertas.find((a) => a.chave === 'vencer:1').resumo) && /R\$ 120,50/.test(g1.j.alertas.find((a) => a.chave === 'vencer:1').resumo));
    const fin1 = area(g1.j, 'financeiro');
    t('contador financeiro', fin1.total === g1.j.alertas.filter((a) => a.area === 'financeiro').length && fin1.alta >= 2 && fin1.silenciados === 0);

    // 2. Fila: um por vez, teto no condomínio travado, os outros seguem.
    await espera(300);
    t('fila calculou os três', ['2', '8', '136'].every((x) => calculados.includes(x)));
    t('um por vez', maxSimultaneos === 1);
    t('travado marcado como falha pelo teto', central.fila.ultimo('8') && central.fila.ultimo('8').falhou === true);
    t('fila livre depois do teto', !central.fila.ocupada());
    const g2 = await pedir('GET', '/api/central-alertas', GESTOR);
    t('alerta velho some depois do cálculo', !g2.j.alertas.some((a) => a.chave === 'velho:1') && g2.j.alertas.some((a) => a.chave === 'vencer:1'));
    t('condomínio com teto estourado mostra o que tem na tabela', g2.j.alertas.some((a) => a.chave === 'cert:1'));
    const nAntes = calculados.length;
    await espera(50);
    t('não recalcula dentro de 6 horas', calculados.filter((x) => x !== '8').length === nAntes - calculados.filter((x) => x === '8').length && !calculados.slice(nAntes).some((x) => x === '2'));
    t('não atualizando quando nada falta', g2.j.atualizando === false);
    // Dashboard registra cálculo: a Central passa a usar.
    central.registrarCalculo('136', { alertas: [], falhas: [] });
    const g3 = await pedir('GET', '/api/central-alertas', GESTOR);
    t('cálculo registrado pelo Dashboard tira o que não vale mais', !g3.j.alertas.some((a) => a.chave === 'manut:1'));
    central.registrarCalculo('136', { alertas: [{ chave: 'manut:1' }], falhas: ['consumo'] });
    const g3b = await pedir('GET', '/api/central-alertas', GESTOR);
    t('cálculo parcial não esconde o que está na tabela', g3b.j.alertas.some((a) => a.chave === 'manut:1'));
    central.registrarCalculo('136', { alertas: [{ chave: 'manut:1' }], falhas: [] });
    // Fila com teto: criarFila direto, relógio falso para as 6 horas.
    let relogio = 0; const chamados = [];
    const f = C.criarFila({ calcular: async (id) => { chamados.push(id); return { alertas: [], falhas: [] }; }, agora: () => relogio, tetoMs: 50, log: () => {} });
    f.agendar(['5', '6']); await espera(30);
    t('fila própria calcula', chamados.join() === '5,6');
    f.agendar(['5', '6']); await espera(20);
    t('fila não repete antes de 6h', chamados.length === 2);
    relogio += 7 * 3600 * 1000;
    f.agendar(['5']); await espera(20);
    t('fila repete depois de 6h', chamados.length === 3);
    relogio += 20 * 60 * 1000;
    f.agendar(['5'], true); await espera(20);
    t('forcar recalcula depois de 15 min', chamados.length === 4);
    f.agendar(['5'], true); await espera(20);
    t('forcar não repete antes de 15 min', chamados.length === 4);

    // 3. Resolvidos só quando pedidos.
    const g4 = await pedir('GET', '/api/central-alertas?resolvidos=1', GESTOR);
    t('resolvido entra com o filtro', g4.j.alertas.some((a) => a.status === 'resolvido' && a.alerta_id === 'a5'));
    t('mandato vencido pesa alta', g4.j.alertas.find((a) => a.alerta_id === 'a5').gravidade === 'alta');
    t('resolvido não conta na área', area(g4.j, 'documentos').total === area(g2.j, 'documentos').total);

    // 4. Carteira.
    const c1 = await pedir('GET', '/api/central-alertas', GERENTE);
    t('carteira A só 2 e 8', JSON.stringify(c1.j.condominios.map((c) => c.id_superlogica)) === '[2,8]');
    t('carteira A sem alertas do 136', !c1.j.alertas.some((a) => a.id_superlogica === 136));
    t('carteira A não recebe condomínio só das despesas', !c1.j.alertas.some((a) => a.id_superlogica === 999));
    t('R2 sem dados do outro condomínio para quem tem carteira', c1.j.alertas.filter((a) => a.tipo_original === 'R2_CONDOMINIO_TROCADO').every((a) => !/Outro/.test(JSON.stringify(a))) && restritos.includes(true));
    t('sem área de segurança sem auditoria', !c1.j.areas.some((a) => a.area === 'seguranca') && !c1.j.alertas.some((a) => a.origem === 'seguranca'));
    const c2 = await pedir('GET', '/api/central-alertas?carteira=11', GESTOR);
    t('filtro por id da carteira', JSON.stringify(c2.j.condominios.map((c) => c.id_superlogica)) === '[136]' && c2.j.alertas.filter((a) => a.id_superlogica).every((a) => a.id_superlogica === 136));
    const c3 = await pedir('GET', '/api/central-alertas?carteira=CARTEIRA%20B', GERENTE);
    t('carteira de fora não abre nada para quem tem carteira', c3.st === 200 && c3.j.condominios.length === 0 && !c3.j.alertas.some((a) => a.id_superlogica));
    t('carteira inexistente 404', (await pedir('GET', '/api/central-alertas?carteira=77', GESTOR)).st === 404);
    t('carteira=meus vale o escopo', (await pedir('GET', '/api/central-alertas?carteira=meus', GERENTE)).j.condominios.length === 2);

    // 5. Origem financeira só com o módulo; segurança só com auditoria.
    const o1 = await pedir('GET', '/api/central-alertas', OPER);
    t('operacional sem módulo ainda vê a Central (padrão)', o1.st === 200);
    t('sem financeiro não recebe origem financeiro', !o1.j.alertas.some((a) => a.origem === 'financeiro'));
    t('operacional vê alertas do condomínio da carteira', o1.j.alertas.some((a) => a.origem === 'condominio' && a.id_superlogica === 2));
    const au = await pedir('GET', '/api/central-alertas', AUDITOR);
    t('auditor recebe segurança', au.j.alertas.some((a) => a.origem === 'seguranca') && au.j.areas.some((a) => a.area === 'seguranca'));
    t('auditor sem financeiro', !au.j.alertas.some((a) => a.origem === 'financeiro'));
    t('módulo escondido pelo dono: 403', (await pedir('GET', '/api/central-alertas', OCULTO)).st === 403);
    const sl = await pedir('GET', '/api/central-alertas', SEMSL);
    t('sem Superlógica não recebe alertas de condomínio', sl.st === 200 && !sl.j.alertas.some((a) => a.origem === 'condominio') && sl.j.falhas.length === 1);
    baseLenta = true;
    const lento = await pedir('GET', '/api/central-alertas', GESTOR);
    t('base do Financeiro demorando não trava a resposta', lento.st === 200 && lento.j.atualizando === true && !lento.j.alertas.some((a) => a.origem === 'financeiro'));
    baseLenta = false;
    await espera(400);

    // 6. Preferências e permissão de silenciar.
    const p0 = await pedir('GET', '/api/alertas/preferencias', OPER);
    t('operacional não pode silenciar', p0.j.pode_silenciar === false && p0.j.silenciados.length === 0);
    t('operacional não vê tipos financeiros nem de uso', !p0.j.tipos.some((x) => /^fin_|alerta_uso/.test(x.tipo)) && p0.j.tipos.some((x) => x.tipo === 'conta_a_vencer'));
    t('PUT sem a ação: 403', (await pedir('PUT', '/api/alertas/preferencias', OPER, { silenciados: ['conta_a_vencer'], pausado: false })).st === 403);
    t('ação com módulo escondido: 403', (await pedir('PUT', '/api/alertas/preferencias', GER2, { silenciados: [], pausado: false })).st === 403);
    t('acesso interno: 403', (await pedir('PUT', '/api/alertas/preferencias', 'internal', { silenciados: [], pausado: false })).st === 403);
    const pg = await pedir('GET', '/api/alertas/preferencias', GERENTE);
    t('gerente com a ação pode silenciar e vê tipos financeiros', pg.j.pode_silenciar === true && pg.j.tipos.some((x) => x.tipo === 'fin_vencida') && !pg.j.tipos.some((x) => x.tipo === 'alerta_uso'));
    t('tipo inválido 400', (await pedir('PUT', '/api/alertas/preferencias', GERENTE, { silenciados: ['nao_existe'] })).st === 400);
    t('pausado inválido 400', (await pedir('PUT', '/api/alertas/preferencias', GERENTE, { silenciados: [], pausado: 'sim' })).st === 400);
    const s1 = await pedir('PUT', '/api/alertas/preferencias', GERENTE, { silenciados: ['conta_a_vencer', 'fin_vencida', 'conta_a_vencer'], pausado: false });
    t('salva (cria)', s1.st === 200 && PREFS.length === 1 && PREFS[0].user_id === GERENTE && PREFS[0].silenciados.length === 2);
    const cs = await pedir('GET', '/api/central-alertas', GERENTE);
    const sil = cs.j.alertas.filter((a) => a.silenciado);
    t('silenciados marcados', sil.length > 0 && sil.every((a) => a.tipo === 'conta_a_vencer' || a.tipo === 'fin_vencida'));
    t('silenciado sai do total e entra no contador', area(cs.j, 'financeiro').silenciados === sil.filter((a) => a.area === 'financeiro').length && area(cs.j, 'financeiro').total === cs.j.alertas.filter((a) => a.area === 'financeiro' && !a.silenciado).length);
    t('silenciado continua na lista', cs.j.alertas.some((a) => a.chave === 'vencer:1' && a.silenciado === true));
    const s2 = await pedir('PUT', '/api/alertas/preferencias', GERENTE, { silenciados: ['conta_a_vencer'], pausado: true });
    t('atualiza (sem duplicar linha)', s2.st === 200 && PREFS.length === 1 && PREFS[0].pausado === true);
    const cp = await pedir('GET', '/api/central-alertas', GERENTE);
    t('pausado silencia tudo', cp.j.pausado === true && cp.j.alertas.every((a) => a.silenciado) && cp.j.areas.every((a) => a.total === 0));
    // Perdeu a ação: vê tudo de novo, mesmo com preferência guardada.
    PERFIS[GERENTE].permissoes.central_alertas.acoes = ['ver'];
    const sem = await pedir('GET', '/api/central-alertas', GERENTE);
    t('sem a ação, preferência guardada não vale', !sem.j.alertas.some((a) => a.silenciado) && sem.j.pode_silenciar === false);
    PERFIS[GERENTE].permissoes.central_alertas.acoes = ['ver', 'silenciar'];
    falharPrefs = true;
    const sf = await pedir('PUT', '/api/alertas/preferencias', GERENTE, { silenciados: [], pausado: false });
    t('banco sem tabela 503 com aviso', sf.st === 503 && /migration 023/.test(sf.j.detalhe));
    falharPrefs = false;

    // 7. Marcação das rotas antigas (Dashboard, Seu dia, painel Financeiro).
    const prefs = { silenciados: ['conta_a_vencer', 'fin_vencida', 'fin_duplicidade'], pausado: false };
    const dash = [{ tipo: 'conta_a_vencer', chave: 'a' }, { tipo: 'saldo_baixo', chave: 'b' }];
    const dm = C.aplicarPreferencias(dash, prefs);
    t('Dashboard: marca só o silenciado', dm[0].silenciado === true && dm[1].silenciado === undefined && dm.length === 2);
    t('Dashboard: não muda o original', dash[0].silenciado === undefined);
    t('sem preferência devolve igual', C.aplicarPreferencias(dash, null) === dash && C.aplicarPreferencias(dash, { silenciados: [], pausado: false }) === dash);
    const seuDia = [{ tipo: 'vencidas' }, { tipo: 'sem_extrato' }, { tipo: 'R6_VENCIDA' }, { tipo: 'R1_DOCUMENTO' }, { tipo: 'R5_SEM_NOTA' }];
    const sd = C.aplicarPreferencias(seuDia, prefs);
    t('Seu dia: vencidas e R6 e R1 marcados', sd[0].silenciado && sd[2].silenciado && sd[3].silenciado && !sd[1].silenciado && !sd[4].silenciado);
    t('pausado marca até tipo sem botão', C.aplicarPreferencias([{ tipo: 'sem_extrato' }], { silenciados: [], pausado: true })[0].silenciado === true);
    t('chave da preferência', C.chavePreferencia('R9_MEXIDA') === 'fin_mexida' && C.chavePreferencia('R4_ANEXO_REMOVIDO') === 'fin_mexida' && C.chavePreferencia('xyz') === null);
    // Painel Financeiro: resumo com valor_alta por tipo e silenciado sem descontar nada.
    const baseResumo = {
      condominios: new Map([['2', { nome: 'Arquipelago' }]]), analistas: new Map(),
      porCondominio: new Map([['2', [
        { tipo: 'R6_VENCIDA', descricao_tipo: 'Vencida', gravidade: 'alta', valor: 100.1 },
        { tipo: 'R6_VENCIDA', descricao_tipo: 'Vencida', gravidade: 'alta', valor: 50.2 },
        { tipo: 'R6_VENCIDA', descricao_tipo: 'Vencida', gravidade: 'media', valor: 999 },
        { tipo: 'R5_SEM_NOTA', descricao_tipo: 'Sem nota', gravidade: 'alta', valor: 10 },
      ]]]),
    };
    const linhas = finPainel.resumoDe(baseResumo, null);
    t('valor_alta por tipo', linhas[0].por_tipo.R6_VENCIDA.valor_alta === 150.3 && linhas[0].por_tipo.R5_SEM_NOTA.valor_alta === 10);
    const resumo = { condominios: linhas };
    C.marcarResumoFinanceiro(resumo, prefs);
    t('resumo: silenciado em por_tipo', resumo.condominios[0].por_tipo.R6_VENCIDA.silenciado === true && !resumo.condominios[0].por_tipo.R5_SEM_NOTA.silenciado);
    t('resumo: tipos_silenciados na raiz', JSON.stringify(resumo.tipos_silenciados) === '["R6_VENCIDA"]');
    t('resumo: nada descontado', resumo.condominios[0].total === 4 && resumo.condominios[0].por_gravidade.alta === 3 && resumo.condominios[0].valor_alta === 160.3);
    const r2 = C.marcarResumoFinanceiro({ condominios: finPainel.resumoDe(baseResumo, null) }, null);
    t('resumo sem preferência: lista vazia', Array.isArray(r2.tipos_silenciados) && !r2.tipos_silenciados.length);
    // preferenciasDoPedido: só para quem pode silenciar.
    const pp = await C.preferenciasDoPedido({ user: { sub: GERENTE } }, { banco, perfilDe: async () => PERFIS[GERENTE] });
    t('preferência do pedido para quem pode', pp && pp.pausado === true);
    t('preferência do pedido nula para operacional', (await C.preferenciasDoPedido({ user: { sub: OPER } }, { banco, perfilDe: async () => PERFIS[OPER] })) === null);
    t('preferência do pedido nula para interno', (await C.preferenciasDoPedido({ authMode: 'internal' }, { banco, perfilDe: async () => null })) === null);
    t('podeVerCentral sem módulo', C.podeVerCentral({ role: 'OPERACIONAL', permissoes: {} }) && !C.podeVerCentral(null));
  } catch (e) {
    falha++; console.log('ERRO: ' + (e && e.stack));
  }
  srv.close();
  console.log(ok + ' ok, ' + falha + ' falha(s)');
  process.exit(falha ? 1 : 0);
});
