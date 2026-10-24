// Agenda do mês: teste das regras (servico/agenda.js), da leitura (servico/agenda-leitura.js), das
// rotas (servico/rotas-agenda.js) e do agendador (servico/agenda-execucao.js), com banco em
// memória e as funções de geração dubladas (nada chama rede, Superlógica ou processamento).
// Uso: NODE_PATH=/home/claude/service-hub/node_modules node scripts/teste-agenda.js
'use strict';

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const agenda = require('../servico/agenda');
const leitura = require('../servico/agenda-leitura');
const execucao = require('../servico/agenda-execucao');
const { criarRotasAgenda } = require('../servico/rotas-agenda');
const P = require('../servico/permissoes');

let ok = 0; let falha = 0;
const t = (nome, cond) => { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } };

// ── Banco em memória com o pedaço do PostgREST que o módulo usa ──
function criarBanco() {
  const tabelas = { agenda_itens: [], agenda_tarefas: [], agenda_materiais: [], agenda_avisos: [], agenda_config: [], trabalhos_salvos: [], certidoes_condominio: [], condominios: [] };
  const UNICOS = { agenda_tarefas: ['mes', 'chave'] };
  const valor = (row, col) => { const m = col.match(/^(\w+)->>(\w+)$/); if (m) { const o = row[m[1]]; return o && o[m[2]] != null ? String(o[m[2]]) : null; } return row[col]; };
  function casa(row, col, expr) {
    const v = valor(row, col);
    const s = v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    let m;
    if (expr === 'is.null') return v == null;
    if (expr === 'not.is.null') return v != null;
    if ((m = expr.match(/^eq\.(.*)$/))) return s === m[1];
    if ((m = expr.match(/^neq\.(.*)$/))) return s !== m[1];
    if ((m = expr.match(/^(lt|lte|gt|gte)\.(.*)$/))) { if (s == null) return false; return m[1] === 'lt' ? s < m[2] : m[1] === 'lte' ? s <= m[2] : m[1] === 'gt' ? s > m[2] : s >= m[2]; }
    if ((m = expr.match(/^in\.\((.*)\)$/))) return m[1].split(',').map((x) => x.replace(/^"|"$/g, '')).includes(s);
    throw new Error('filtro não suportado: ' + col + '=' + expr);
  }
  function filtrar(lista, q) {
    return lista.filter((row) => q.filtros.every(([c, e]) => {
      if (c === 'or') return e.replace(/^\(|\)$/g, '').split(',').some((parte) => { const i = parte.indexOf('.'); return casa(row, parte.slice(0, i), parte.slice(i + 1)); });
      return casa(row, c, e);
    }));
  }
  function ler(caminho) {
    const [p, qs] = caminho.split('?');
    const tabela = p.replace('/rest/v1/', '');
    const q = { filtros: [], order: null, limit: null };
    (qs || '').split('&').filter(Boolean).forEach((par) => {
      const i = par.indexOf('='); const k = decodeURIComponent(par.slice(0, i)); const v = decodeURIComponent(par.slice(i + 1));
      if (k === 'select') return;
      if (k === 'order') q.order = v; else if (k === 'limit') q.limit = Number(v); else q.filtros.push([k, v]);
    });
    return { tabela, q };
  }
  const chamadas = [];
  async function banco(metodo, caminho, corpo) {
    chamadas.push(metodo + ' ' + caminho.split('?')[0]);
    if (caminho.startsWith('/rest/v1/rpc/')) return { status: 200, body: [] };
    const { tabela, q } = ler(caminho);
    const lista = tabelas[tabela];
    if (!lista) return { status: 404, body: { code: 'PGRST205' } };
    if (metodo === 'GET') {
      let r = filtrar(lista, q).map((x) => JSON.parse(JSON.stringify(x)));
      if (q.order) { const [c, dir] = q.order.split(',')[0].split('.'); r.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
      if (q.limit) r = r.slice(0, q.limit);
      return { status: 200, body: r };
    }
    if (metodo === 'POST') {
      const novos = (Array.isArray(corpo) ? corpo : [corpo]).map((x) => Object.assign({ id: crypto.randomUUID(), criado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() },
        tabela === 'agenda_tarefas' ? { versao: 1, tentativas: 0, travas: [], resultado: {}, motivo: null, erro: null, trava_ate: null, trava_dono: null } : {},
        tabela === 'agenda_itens' ? { cancelado: false } : {}, JSON.parse(JSON.stringify(x))));
      const u = UNICOS[tabela];
      if (u && novos.some((n) => lista.some((e) => u.every((c) => e[c] === n[c])))) return { status: 409, body: { code: '23505' } };
      lista.push(...novos);
      return { status: 201, body: novos.map((x) => JSON.parse(JSON.stringify(x))) };
    }
    if (metodo === 'PATCH') {
      const alvo = filtrar(lista, q);
      alvo.forEach((row) => Object.assign(row, JSON.parse(JSON.stringify(corpo))));
      return { status: 200, body: alvo.map((x) => JSON.parse(JSON.stringify(x))) };
    }
    if (metodo === 'DELETE') {
      const alvo = new Set(filtrar(lista, q));
      tabelas[tabela] = lista.filter((x) => !alvo.has(x));
      return { status: 200, body: [...alvo] };
    }
    return { status: 405, body: null };
  }
  return { banco, tabelas: () => tabelas, chamadas };
}

const BASE = [
  { id: 'c10', nome: 'Condomínio Residencial Bosque das Palmeiras', id_superlogica: 10 },
  { id: 'c11', nome: 'Edifício Mar Azul', id_superlogica: 11 },
  { id: 'c12', nome: 'Residencial Reserva Verde', id_superlogica: 12 },
  { id: 'c13', nome: 'Condomínio Villa Toscana', id_superlogica: 13 },
  { id: 'c14', nome: 'Spazio Vila Bella', id_superlogica: 14 },
];
// Agenda de exemplo com 5 assembleias (como a planilha da equipe chega).
const PLANILHA = [
  ['Condomínio', 'Data', 'Hora', 'Tipo', 'Pauta'],
  ['Bosque das Palmeiras', '12/11/2026', '19h30', 'AGO', '1) Prestação de contas do exercício; 2) Eleição de síndico e conselho fiscal; 3) Assuntos gerais'],
  ['Ed. Mar Azul', '10/11', '20:00', 'Extraordinária', '1) Aprovação de orçamentos para pintura da fachada; 2) Rateio da obra'],
  ['Reserva Verde', '16/11/2026', '19:00', 'AGE', '1) Prestação de contas de julho a setembro de 2026; 2) Previsão orçamentária 2027'],
  ['Villa Toscana', '2026-11-25', '19:30', 'AGO/AGE', '1) Alteração do regimento interno; 2) Assuntos gerais'],
  ['Vila Bella', '27 de novembro', '', 'AGE', 'Assuntos gerais'],
];

(async () => {
  // ── 1. Leitura ──
  const lp = agenda.lerPlanilha(PLANILHA, '2026-11');
  t('planilha: 5 assembleias', lp.itens.length === 5);
  t('planilha: datas lidas', lp.itens.map((i) => i.data).join(',') === '2026-11-12,2026-11-10,2026-11-16,2026-11-25,2026-11-27');
  t('planilha: hora 19h30', lp.itens[0].hora === '19:30' && lp.itens[1].hora === '20:00');
  t('planilha: tipos', lp.itens.map((i) => i.tipo_assembleia).join(',') === 'AGO,AGE,AGE,AGO_AGE,AGE');
  t('planilha: pauta quebrada', lp.itens[0].pauta.length === 3 && /Elei/.test(lp.itens[0].pauta[1]));
  const prep = agenda.prepararItens(lp.itens, BASE, '2026-11');
  t('condomínio reconhecido pelo nome (5 de 5)', prep.map((i) => i.id_superlogica).join(',') === '10,11,12,13,14');
  t('sem cabeçalho: não entende', agenda.lerPlanilha([['x', 'y'], ['1', '2']], '2026-11').nao_entendido.length === 1);
  const prepCarteira = agenda.prepararItens(lp.itens, BASE.filter((c) => c.id_superlogica === 10), '2026-11');
  t('fora da carteira: não reconhecido e avisado', prepCarteira.filter((i) => !i.id_superlogica).length === 4 && /não reconhecido/.test(prepCarteira[1].avisos[0]));
  t('nome desconhecido não casa', agenda.reconhecerCondominio('Condomínio Inexistente Qualquer', BASE) === null);

  // Leitura de texto livre com a chamada de processamento dublada (JSON validado em código).
  let pedidoVisto = null;
  const chamarDublado = async (o) => { pedidoVisto = o; return { ok: true, texto: '```json\n' + JSON.stringify({ itens: [
    { condominio: 'Bosque das Palmeiras', data: '2026-11-12', hora: '19:30', tipo: 'AGO', pauta: ['Prestação de contas', 'Eleição'], trecho: 'Bosque 12/11' },
    { condominio: 'Mar Azul', data: '10/11', hora: '20h', tipo: 'AGE', pauta: ['Orçamentos da pintura'] },
    { condominio: 'Reserva Verde', data: '2026-11-16', tipo: 'AGE', pauta: ['Prestação de contas de julho a setembro de 2026'] },
    { condominio: 'Villa Toscana', data: '2026-11-25', tipo: 'AGO_AGE', pauta: ['Regimento interno'] },
    { condominio: 'Vila Bella', data: '2026-11-27', tipo: 'AGE', pauta: ['Assuntos gerais'] },
    { condominio: '', data: 'qualquer coisa', tipo: 'xx', trecho: 'linha confusa' },
    { condominio: '<script>alert(1)</script> Mar Azul', data: '2026-11-31', tipo: 'AGE' },
  ], nao_entendido: ['texto sem sentido'] }) + '\n```' }; };
  const lt = await leitura.lerComModelo({ texto: 'agenda colada pela equipe com 5 assembleias' }, { chamarModelo: chamarDublado, extrairJson: require('../servico/modelo').extrairJson, modelos: require('../servico/modelos'), mes: '2026-11' });
  t('texto livre: 5 itens válidos e 1 recusado + data inválida sem data', lt.ok && lt.itens.length === 6 && lt.nao_entendido.length === 2);
  t('texto livre: tira < > do nome', !/[<>]/.test(lt.itens[5].condominio) && lt.itens[5].data === null);
  t('texto livre: usa o modelo barato', pedidoVisto && pedidoVisto.modelo === require('../servico/modelos').modelo('edital'));
  const lruim = await leitura.lerComModelo({ texto: 'x'.repeat(20) }, { chamarModelo: async () => ({ ok: true, texto: 'não é json' }), extrairJson: require('../servico/modelo').extrairJson, modelos: require('../servico/modelos'), mes: '2026-11' });
  t('texto livre: resposta fora do formato recusada', !lruim.ok && lruim.status === 422);

  // ── 2. Classificação ──
  const c = (s) => agenda.classificarItemPauta(s).join(',');
  t('classifica prestação', c('Prestação de contas do exercício 2025') === 'prestacao_contas');
  t('classifica eleição', c('Eleição de síndico e conselho fiscal') === 'eleicao');
  t('classifica previsão (não obra)', c('Aprovação do orçamento para 2027') === 'previsao_orcamentaria');
  t('classifica obra', c('Aprovação de orçamentos para pintura da fachada') === 'obra_orcamentos');
  t('classifica regimento', c('Alteração do regimento interno') === 'regimento');
  t('classifica assuntos gerais', c('Assuntos gerais') === 'assuntos_gerais');
  t('classifica outro', c('Ratificação de convênio com a prefeitura') === 'outro');
  const pt = agenda.periodoPrestacao('Prestação de contas de julho a setembro de 2026', 'AGE', '2026-11-16');
  t('período tirado do texto', pt.inicio === '2026-07' && pt.fim === '2026-09' && pt.fonte === 'texto');
  const pe = agenda.periodoPrestacao('Prestação de contas', 'AGO', '2026-11-12');
  t('AGO sem período usa o exercício (12 meses)', pe.inicio === '2025-11' && pe.fim === '2026-10' && pe.fonte === 'exercicio' && !/[–—]/.test(pe.aviso));
  const pa = agenda.periodoPrestacao('Prestação de contas', 'AGE', '2026-11-16');
  t('AGE sem período usa 3 meses', pa.inicio === '2026-08' && pa.fim === '2026-10');

  // ── 3. Datas do plano ──
  const itensPlano = prep.map((it, i) => Object.assign({ id: 'item' + i, mes: '2026-11', condominio_nome: it.condominio_base, cancelado: false }, it));
  const plano = agenda.gerarPlano(itensPlano, {});
  const de = (item, tipo) => plano.find((x) => x.item_id === item && x.tipo === tipo);
  t('Bosque (qui 12/11): prestação 7 dias antes = qui 05/11', de('item0', 'prestacao_contas').data_execucao === '2026-11-05');
  t('Bosque: apresentação 3 dias antes = seg 09/11', de('item0', 'apresentacao').data_execucao === '2026-11-09');
  t('Bosque: pedir material (eleição) 10 dias antes = seg 02/11', de('item0', 'pedir_material').data_execucao === '2026-11-02');
  t('Bosque: ata no dia seguinte = sex 13/11', de('item0', 'ata').data_execucao === '2026-11-13');
  t('Mar Azul (ter 10/11): apresentação cai no sábado e vai para sex 06/11', de('item1', 'apresentacao').data_execucao === '2026-11-06');
  t('Mar Azul: sem prestação na pauta, sem prestação no plano', !de('item1', 'prestacao_contas'));
  t('Reserva Verde: previsão no plano', !!de('item2', 'previsao_orcamentaria') && de('item2', 'prestacao_contas').parametros.inicio === '2026-07');
  t('Vila Bella: só assuntos gerais, sem apresentação', !de('item4', 'apresentacao') && !!de('item4', 'ata'));
  const certs = plano.filter((x) => x.tipo === 'certidoes');
  t('dia das certidões: um por semana (Bosque e Reserva Verde em semanas diferentes)', certs.length === 2);
  t('dia das certidões: segunda da semana anterior', certs.map((x) => x.data_execucao).join(',') === '2026-11-02,2026-11-09');
  t('dia das certidões junta os condomínios da semana', JSON.stringify(agenda.gerarPlano([itensPlano[0], Object.assign({}, itensPlano[2], { data: '2026-11-13' })], {}).filter((x) => x.tipo === 'certidoes').map((x) => x.parametros.condominios)) === '[[10,12]]');
  t('antecedência configurável', agenda.gerarPlano([itensPlano[0]], { prestacao_dias_antes: 10 }).find((x) => x.tipo === 'prestacao_contas').data_execucao === '2026-11-02');
  t('antecedência fora do limite fica no padrão', agenda.lerConfig({ prestacao_dias_antes: 999 }).prestacao_dias_antes === 7);
  t('nenhum título com travessão', plano.every((x) => !/[–—]/.test(x.titulo)));

  // ── 4. Aprovação obrigatória e mudança depois de aprovar ──
  const sinc = agenda.sincronizarPlano([], plano);
  t('tudo nasce aguardando aprovação', sinc.criar.length === plano.length && sinc.criar.every((x) => x.aprovacao === 'pendente'));
  const gravadas = sinc.criar.map((x, i) => Object.assign({ id: 'tar' + i, versao: 1 }, x, { aprovacao: 'aprovada' }));
  const outra = agenda.gerarPlano(itensPlano.map((x) => (x.id === 'item0' ? Object.assign({}, x, { data: '2026-11-19' }) : x)), {});
  const s2 = agenda.sincronizarPlano(gravadas, outra);
  t('mudou a data: as tarefas do item voltam para aprovação', s2.atualizar.length > 0 && s2.atualizar.every((u) => u.campos.aprovacao === 'pendente'));
  t('os outros itens continuam aprovados', s2.atualizar.every((u) => gravadas.find((g) => g.id === u.id).item_id === 'item0' || gravadas.find((g) => g.id === u.id).tipo === 'certidoes'));
  const prontaMudou = gravadas.map((g) => (g.tipo === 'prestacao_contas' && g.item_id === 'item2' ? Object.assign({}, g, { status: 'pronta_conferir' }) : g));
  const p3 = agenda.gerarPlano(itensPlano.map((x) => (x.id === 'item2' ? Object.assign({}, x, { pauta: agenda.classificarPauta(['Prestação de contas de agosto a outubro de 2026']) }) : x)), {});
  const u3 = agenda.sincronizarPlano(prontaMudou, p3).atualizar.find((u) => gravadas.find((g) => g.id === u.id).tipo === 'prestacao_contas');
  t('mudou o período de uma pronta: volta para agendada e para aprovação', u3 && u3.campos.status === 'agendada' && u3.campos.aprovacao === 'pendente');
  t('item tirado: tarefas canceladas', agenda.sincronizarPlano(gravadas, agenda.gerarPlano(itensPlano.slice(1), {})).cancelar.length > 0);
  t('aprovaveis: só pendentes', agenda.aprovaveis([{ id: 'a', aprovacao: 'pendente', status: 'agendada' }, { id: 'b', aprovacao: 'aprovada', status: 'agendada' }, { id: 'c', aprovacao: 'pendente', status: 'cancelada' }]).join() === 'a');
  const custo = agenda.estimarCusto(sinc.criar, { AGENDA_CUSTO_PRESTACAO_USD: '0.5', AGENDA_CUSTO_APRESENTACAO_USD: '0.25' }, 6);
  t('custo antes de aprovar: 2 prestações e 4 apresentações', custo.a_aprovar.prestacoes === 2 && custo.a_aprovar.apresentacoes === 4 && custo.a_aprovar.usd === 2);

  // ── 5. Permissões ──
  const dono = { id: 'd', role: 'GESTOR', permissoes: { configuracoes: { visivel: true, acoes: ['ver', 'auditoria_total'] } } };
  const gestor2 = { id: 'g2', role: 'GESTOR', permissoes: {} };
  const raiane = { id: 'r', role: 'GERENTE', pode_convidar: true, permissoes: { gestao_painel: { visivel: true, acoes: ['ver'] } }, concede: {} };
  const gerente = { id: 'ge', role: 'GERENTE', permissoes: {} };
  const analista = { id: 'a', role: 'OPERACIONAL', permissoes: { agenda: { visivel: true, acoes: ['ver', 'cadastrar'] } } };
  const semModulo = { id: 's', role: 'OPERACIONAL', permissoes: { atas: { visivel: true, acoes: ['ver'] } } };
  t('GESTOR e GERENTE aprovam', agenda.podeAprovar(dono) && agenda.podeAprovar(gerente));
  t('analista não aprova', !agenda.podeAprovar(analista));
  t('analista com o módulo vê e cadastra', agenda.podeVer(analista) && agenda.podeCadastrar(analista));
  t('sem o módulo não vê', !agenda.podeVer(semModulo));
  t('Painel da gestão: dono vê', agenda.podeVerGestao(dono));
  t('Painel da gestão: Raiane com o módulo vê', agenda.podeVerGestao(raiane));
  t('Painel da gestão: GERENTE sem o módulo não vê', !agenda.podeVerGestao(gerente));
  t('Painel da gestão: outro GESTOR sem o módulo não vê', !agenda.podeVerGestao(gestor2));
  t('Painel da gestão: analista não vê', !agenda.podeVerGestao(analista));
  const comPainel = (o) => Object.assign({}, o.permissoes, { gestao_painel: { visivel: true, acoes: ['ver'] } });
  t('dono libera o Painel da gestão para a Raiane', P.conferirMudanca(dono, {}, { gestao_painel: { visivel: true, acoes: ['ver'] } }).ok);
  t('Raiane não repassa o Painel da gestão', P.conferirMudanca(raiane, analista.permissoes, comPainel(analista)).motivo === 'so_gestor_concede');
  t('GERENTE não tira o Painel da gestão de ninguém', !P.conferirMudanca(raiane, comPainel(analista), analista.permissoes).ok);
  t('Painel da gestão nunca vai no concede', !P.concedeBemFormado({ gestao_painel: ['ver'] }));

  // ── 6. Rotas (banco em memória, login pelo cabeçalho de teste) ──
  const fb = criarBanco();
  fb.tabelas().condominios.push(...BASE);
  const perfis = { dono, raiane, gerente, analista, semModulo };
  const uid = {}; Object.keys(perfis).forEach((k) => { uid[k] = crypto.randomUUID(); perfis[uid[k]] = perfis[k]; });
  const carteira = { [uid.analista]: new Set([10]), [uid.raiane]: null };
  const eventos = [];
  const app = express();
  const AGORA = Date.parse('2026-10-23T15:00:00Z'); // 12h em Brasília
  criarRotasAgenda(app, {
    requireAuth: (req, res, next) => { const u = req.headers['x-teste']; if (!u) return res.status(401).end(); req.user = { sub: uid[u] }; req.authMode = 'supabase'; next(); },
    express, banco: fb.banco, perfilDe: async (req) => perfis[req.user.sub],
    auditoria: { evento: (req, acao, det) => eventos.push(acao) },
    escopo: async (req) => (carteira[req.user.sub] ? { todas: false, ids: carteira[req.user.sub] } : { todas: true }),
    condominioDaBase: async (id) => { const b = BASE.find((x) => x.id_superlogica === Number(id)); return b ? { nome: b.nome, id: b.id_superlogica } : null; },
    chamarModelo: chamarDublado, extrairPauta: require('../servico/apresentacao').extrairPauta,
    extrairTexto: async (buf) => ({ texto: buf.toString('utf8').replace(/^%PDF-1\.4\s*/, ''), paginas: 1 }),
    storageUpload: async () => ({}), storageSignedUrl: async () => 'http://x', storageDelete: async () => true,
    executores: {}, salvarTrabalho: async () => 'x', ligado: () => false, agora: () => AGORA, dentroDoLimite: () => true,
  });
  const srv = app.listen(0);
  const porta = srv.address().port;
  const pedir = (quem, metodo, caminho, corpo, bruto) => new Promise((ok2) => {
    const buf = bruto || (corpo ? Buffer.from(JSON.stringify(corpo)) : null);
    const r = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: Object.assign({ 'x-teste': quem }, buf ? { 'content-type': bruto ? 'application/octet-stream' : 'application/json', 'content-length': buf.length } : {}) }, (res) => {
      const p = []; res.on('data', (c2) => p.push(c2)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(p).toString()); } catch (e) { j = null; } ok2({ status: res.statusCode, j }); });
    });
    if (buf) r.write(buf); r.end();
  });
  try {
    const lerA = await pedir('analista', 'POST', '/api/agenda/ler', { mes: '2026-11', modo: 'planilha', linhas: PLANILHA });
    t('analista lê a planilha: só o condomínio da carteira é reconhecido', lerA.status === 200 && lerA.j.itens.filter((i) => i.id_superlogica).length === 1);
    const lerSem = await pedir('semModulo', 'POST', '/api/agenda/ler', { mes: '2026-11', modo: 'planilha', linhas: PLANILHA });
    t('sem o módulo não manda a agenda', lerSem.status === 403);
    const lerG = await pedir('gerente', 'POST', '/api/agenda/ler', { mes: '2026-11', modo: 'planilha', linhas: PLANILHA });
    t('gerente lê as 5', lerG.status === 200 && lerG.j.itens.filter((i) => i.id_superlogica).length === 5);
    const salvarFora = await pedir('analista', 'POST', '/api/agenda/itens', { mes: '2026-11', itens: lerG.j.itens.slice(1, 2) });
    t('analista não grava condomínio fora da carteira', salvarFora.status === 200 && salvarFora.j.gravados === 0 && /carteira/.test(salvarFora.j.recusados[0].motivo));
    const salvar = await pedir('gerente', 'POST', '/api/agenda/itens', { mes: '2026-11', itens: lerG.j.itens });
    t('gerente grava as 5 e o plano nasce', salvar.status === 200 && salvar.j.gravados === 5 && salvar.j.plano.criadas === plano.length);
    const dup = await pedir('gerente', 'POST', '/api/agenda/itens', { mes: '2026-11', itens: lerG.j.itens.slice(0, 1) });
    t('item repetido é recusado', dup.j.gravados === 0);
    const mesG = await pedir('gerente', 'GET', '/api/agenda/mes/2026-11');
    t('tela do mês: tudo aguardando aprovação', mesG.status === 200 && mesG.j.tarefas.every((x) => x.aprovacao === 'pendente') && mesG.j.painel.aguardando_aprovacao === plano.length);
    t('tela do mês: custo estimado mostrado', mesG.j.custo.a_aprovar.geracoes === 6);
    const mesA = await pedir('analista', 'GET', '/api/agenda/mes/2026-11');
    t('analista vê só a carteira (1 item)', mesA.status === 200 && mesA.j.itens.length === 1 && mesA.j.itens[0].id_superlogica === 10);
    t('analista vê só as tarefas da carteira', mesA.j.tarefas.every((x) => x.id_superlogica === 10 || (x.tipo === 'certidoes' && x.parametros.condominios.join() === '10')));
    t('analista não aprova', (await pedir('analista', 'POST', '/api/agenda/mes/2026-11/aprovar', {})).status === 403);
    t('analista não abre o Painel da gestão', (await pedir('analista', 'GET', '/api/agenda/gestao/2026-11')).status === 403);
    t('gerente sem o módulo não abre o Painel da gestão', (await pedir('gerente', 'GET', '/api/agenda/gestao/2026-11')).status === 403);
    const gR = await pedir('raiane', 'GET', '/api/agenda/gestao/2026-11');
    t("Raiane abre o Painel da gestão com tendências de 6 meses", gR.status === 200 && gR.j.tendencias.length === 6 && gR.j.tendencias[5].assembleias === 5);
    t('dono abre o Painel da gestão', (await pedir('dono', 'GET', '/api/agenda/gestao/2026-11')).status === 200);
    const item0 = mesG.j.itens.find((i) => i.id_superlogica === 10);
    const t0 = mesG.j.tarefas.find((x) => x.item_id === item0.id && x.tipo === 'apresentacao');
    const ap1 = await pedir('gerente', 'POST', '/api/agenda/mes/2026-11/aprovar', { ids: [t0.id] });
    t('aprovar item a item', ap1.status === 200 && ap1.j.aprovadas === 1);
    const ap2 = await pedir('gerente', 'POST', '/api/agenda/mes/2026-11/aprovar', {});
    t('aprovar tudo', ap2.j.aprovadas === plano.length - 1 && fb.tabelas().agenda_tarefas.every((x) => x.aprovacao === 'aprovada'));
    t('aprovação vai para a auditoria', eventos.includes('agenda_plano_aprovado'));
    const put = await pedir('gerente', 'PUT', '/api/agenda/itens/' + item0.id, { data: '2026-11-19' });
    const doItem = fb.tabelas().agenda_tarefas.filter((x) => x.item_id === item0.id && x.status !== 'cancelada');
    t('mudança depois de aprovar volta para aprovação', put.status === 200 && doItem.length && doItem.every((x) => x.aprovacao === 'pendente'));
    t('outros itens seguem aprovados', fb.tabelas().agenda_tarefas.filter((x) => x.item_id && x.item_id !== item0.id).every((x) => x.aprovacao === 'aprovada'));
    const edital = Buffer.from('%PDF-1.4 EDITAL DE CONVOCAÇÃO. Ordem do dia: 1) Prestação de contas de julho a setembro de 2026; 2) Eleição do síndico; 3) Assuntos gerais. Serra, 01 de novembro de 2026.');
    const up = await pedir('gerente', 'POST', '/api/agenda/itens/' + item0.id + '/material?tipo=edital&nome=edital.pdf', null, edital);
    t('edital anexado vira texto e pauta', up.status === 200 && up.j.pauta && up.j.pauta.length === 3 && fb.tabelas().agenda_itens.find((i) => i.id === item0.id).edital_texto.length > 20);
    const prest0 = fb.tabelas().agenda_tarefas.find((x) => x.item_id === item0.id && x.tipo === 'prestacao_contas');
    t('período novo do edital entra no plano', prest0.parametros.inicio === '2026-07' && prest0.parametros.fim === '2026-09');
    t('foto que não é JPG é recusada', (await pedir('gerente', 'POST', '/api/agenda/itens/' + item0.id + '/material?tipo=foto&nome=a.png', null, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]))).status === 415);
    t('analista não mexe em item fora da carteira', (await pedir('analista', 'PUT', '/api/agenda/itens/' + mesG.j.itens.find((i) => i.id_superlogica === 11).id, { hora: '10:00' })).status === 403);
  } finally { srv.close(); }

  // ── 7. Agendador ──
  const fb2 = criarBanco();
  fb2.tabelas().condominios.push(...BASE);
  const T = fb2.tabelas();
  const ITEM_SEM_EDITAL = crypto.randomUUID(); const ITEM_PREST = crypto.randomUUID(); const ITEM_NAO_APROV = crypto.randomUUID();
  const dono2 = crypto.randomUUID();
  T.agenda_itens.push(
    { id: ITEM_SEM_EDITAL, mes: '2026-11', tipo_item: 'assembleia', id_superlogica: 11, condominio_nome: 'Edifício Mar Azul', data: '2026-11-10', hora: '20:00', tipo_assembleia: 'AGE', pauta: agenda.classificarPauta(['Orçamentos da pintura']), edital_texto: null, cancelado: false, criado_por: dono2, responsavel: dono2 },
    { id: ITEM_PREST, mes: '2026-11', tipo_item: 'assembleia', id_superlogica: 10, condominio_nome: 'Bosque das Palmeiras', data: '2026-11-12', hora: '19:30', tipo_assembleia: 'AGO', pauta: agenda.classificarPauta(['Prestação de contas de julho a setembro de 2026']), edital_texto: 'edital', cancelado: false, criado_por: dono2, responsavel: dono2 },
    { id: ITEM_NAO_APROV, mes: '2026-11', tipo_item: 'assembleia', id_superlogica: 12, condominio_nome: 'Reserva Verde', data: '2026-11-12', tipo_assembleia: 'AGE', pauta: agenda.classificarPauta(['Prestação de contas de julho a setembro de 2026']), edital_texto: 'edital', cancelado: false, criado_por: dono2, responsavel: dono2 },
  );
  const tarefa = (o) => Object.assign({ id: crypto.randomUUID(), mes: '2026-11', versao: 1, tentativas: 0, travas: [], resultado: {}, parametros: {}, motivo: null, erro: null, trava_ate: null, trava_dono: null, status: 'agendada', aprovacao: 'aprovada', aprovada_por: dono2, criado_em: new Date().toISOString() }, o);
  const TA = tarefa({ chave: ITEM_SEM_EDITAL + ':apresentacao', tipo: 'apresentacao', item_id: ITEM_SEM_EDITAL, id_superlogica: 11, data_execucao: '2026-11-06', parametros: { trabalhos: ['obra_orcamentos'] }, titulo: 'Apresentação Mar Azul' });
  const TP = tarefa({ chave: ITEM_PREST + ':prestacao', tipo: 'prestacao_contas', item_id: ITEM_PREST, id_superlogica: 10, data_execucao: '2026-11-05', parametros: { inicio: '2026-07', fim: '2026-09' }, titulo: 'Prestação Bosque' });
  const TN = tarefa({ chave: ITEM_NAO_APROV + ':prestacao', tipo: 'prestacao_contas', item_id: ITEM_NAO_APROV, id_superlogica: 12, data_execucao: '2026-11-05', parametros: { inicio: '2026-07', fim: '2026-09' }, aprovacao: 'pendente', titulo: 'Prestação Reserva' });
  const TF = tarefa({ chave: 'futura', tipo: 'prestacao_contas', item_id: ITEM_PREST, id_superlogica: 10, data_execucao: '2026-11-30', parametros: { inicio: '2026-07', fim: '2026-09' }, titulo: 'futura' });
  T.agenda_tarefas.push(TA, TP, TN, TF);
  T.certidoes_condominio.push({ id_superlogica: 10, tipo: 'federal', validade: '2027-01-01', caminho: '10/federal.pdf', situacao: 'negativa' });
  const chamadasGer = []; const salvos = [];
  let ligadoAgora = false;
  const executores = {
    gerarPrestacao: async (p) => { chamadasGer.push(['prestacao', p.id_superlogica, p.inicio, p.fim]); await new Promise((x) => setTimeout(x, 20)); return { ok: true, payload: { pdf_b64: Buffer.from('%PDF-1.4 x').toString('base64'), pptx_b64: Buffer.from('PK..').toString('base64'), nome_arquivo: 'Prestação de Contas Bosque', modo: 'detalhado', avisos: [] } }; },
    gerarApresentacao: async (c2) => { chamadasGer.push(['apresentacao', c2.idSuperlogica, c2.documentos.length]); return { ok: true, payload: { pptx_b64: Buffer.from('PK..').toString('base64'), pdf_b64: Buffer.from('%PDF').toString('base64'), slides: 9, titulo_arquivo: 'Apresentação AGE Mar Azul', roteiro: {}, avisos: [], pauta: [] } }; },
    lerCertidoes: async () => null, buscarCertidao: async () => ({ ok: false }),
  };
  const AGORA2 = Date.parse('2026-11-06T13:00:00Z'); // sexta 10h em Brasília
  const novoAgendador = (extra) => execucao.criarAgendador(Object.assign({
    banco: fb2.banco, executores, salvarTrabalho: async (x) => { salvos.push(x); return crypto.randomUUID(); },
    baixarMaterial: async () => Buffer.from('%PDF-1.4 orc'), tiposCertidao: require('../servico/certidoes').TIPOS.map((x) => ({ tipo: x.tipo, nome: x.nome })),
    ligado: () => ligadoAgora, agora: () => AGORA2, maxHora: () => 6, horaInicio: () => 6,
  }, extra || {}));
  const ag = novoAgendador();
  const r0 = await ag.rodar();
  t('desligado: não roda', !r0.rodou && r0.motivo === 'desligado' && chamadasGer.length === 0);
  t('desligado é o padrão do ambiente', execucao.ligadoPorAmbiente() === (String(process.env.AGENDA_EXECUCAO || '').toLowerCase() === 'on'));
  ligadoAgora = true;
  const cedo = await novoAgendador({ agora: () => Date.parse('2026-11-06T07:00:00Z') }).rodar();
  t('antes da hora de início: não roda', !cedo.rodou && cedo.motivo === 'fora_do_horario');
  // Duas instâncias rodando ao mesmo tempo no mesmo banco: cada tarefa roda uma vez só.
  const ag2 = novoAgendador();
  const [ra, rb, rc] = await Promise.all([ag.rodar(), ag2.rodar(), ag.rodar()]);
  t('mesma instância: a segunda rodada espera', rc.motivo === 'em_andamento');
  t('duas instâncias: a prestação roda uma vez só', chamadasGer.filter((x) => x[0] === 'prestacao' && x[1] === 10).length === 1);
  t('sem aprovação: não roda', !chamadasGer.some((x) => x[1] === 12) && T.agenda_tarefas.find((x) => x.id === TN.id).status === 'agendada');
  t('data futura: não roda', T.agenda_tarefas.find((x) => x.id === TF.id).status === 'agendada');
  const tp = T.agenda_tarefas.find((x) => x.id === TP.id);
  t('prestação gerada com o período certo', chamadasGer[0] && chamadasGer.find((x) => x[0] === 'prestacao').join() === 'prestacao,10,2026-07,2026-09');
  t('prestação pronta para conferir e guardada na pasta', tp.status === 'pronta_conferir' && tp.resultado.trabalho_id && tp.tentativas === 1 && !!tp.pronta_em);
  const sp = salvos.find((x) => x.tipo === 'prestacao');
  t('pasta: dados no formato da tela, ligados à agenda, com as certidões marcadas', sp && sp.userId === dono2 && sp.dados.agenda.tarefa_id === TP.id && sp.dados.incluir_certidoes === true && sp.dados.condId === 'c10' && sp.arquivos.length === 2);
  t('pasta: faltam certidões no título', /\(aguardando certidões\)$/.test(sp.titulo) && tp.resultado.faltando_certidoes.length === 5);
  const ta = T.agenda_tarefas.find((x) => x.id === TA.id);
  t('falta de material: apresentação sem edital vira pendência', ta.status === 'pendente_material' && ta.motivo === 'falta_edital' && ta.travas.length === 1);
  const av = T.agenda_avisos.filter((x) => x.tarefa_id === TA.id);
  t('pendência avisa quem cuida, com a mensagem pronta e sem travessão', av.length === 1 && av[0].user_id === dono2 && /^Ei, tudo bem\?/.test(av[0].mensagem) && !/[–—]/.test(av[0].texto + av[0].mensagem));
  await ag.rodar();
  t('pendência não repete o aviso a cada rodada', T.agenda_avisos.filter((x) => x.tarefa_id === TA.id).length === 1);
  T.agenda_itens.find((x) => x.id === ITEM_SEM_EDITAL).edital_texto = 'EDITAL ... Ordem do dia: 1) Orçamentos da pintura';
  await ag.rodar();
  t('edital chegou, mas faltam orçamentos: pendência nova', T.agenda_tarefas.find((x) => x.id === TA.id).motivo === 'falta_orcamentos' && T.agenda_avisos.filter((x) => x.tarefa_id === TA.id).length === 2);
  T.agenda_materiais.push({ id: crypto.randomUUID(), item_id: ITEM_SEM_EDITAL, tipo: 'documento', nome: 'orcamento.pdf', caminho: 'x/1.pdf', mime: 'application/pdf', texto: 'R$ 10.000', criado_em: '2026-11-06T12:00:00Z' });
  await ag.rodar();
  const ta2 = T.agenda_tarefas.find((x) => x.id === TA.id);
  t('material chegou: apresentação gerada com o documento', ta2.status === 'pronta_conferir' && chamadasGer.some((x) => x[0] === 'apresentacao' && x[2] === 1) && ta2.resultado.material_em === '2026-11-06T12:00:00Z');
  const n1 = chamadasGer.length;
  await ag.rodar();
  t('o que ficou pronto não roda de novo', chamadasGer.length === n1);
  // Limite de gerações por hora.
  const fb3 = criarBanco(); const T3 = fb3.tabelas();
  T3.agenda_itens.push(Object.assign({}, T.agenda_itens.find((x) => x.id === ITEM_PREST)));
  T3.agenda_tarefas.push(tarefa({ chave: 'a', tipo: 'prestacao_contas', item_id: ITEM_PREST, id_superlogica: 10, data_execucao: '2026-11-05', parametros: { inicio: '2026-07', fim: '2026-09' } }),
    tarefa({ chave: 'b', tipo: 'prestacao_contas', item_id: ITEM_PREST, id_superlogica: 10, data_execucao: '2026-11-05', parametros: { inicio: '2026-06', fim: '2026-09' } }));
  const antes = chamadasGer.length;
  await execucao.criarAgendador({ banco: fb3.banco, executores, salvarTrabalho: async () => crypto.randomUUID(), baixarMaterial: async () => Buffer.alloc(0), tiposCertidao: [], ligado: () => true, agora: () => AGORA2, maxHora: () => 1, horaInicio: () => 6 }).rodar();
  t('limite por hora: uma geração e a outra fica agendada', chamadasGer.length - antes === 1 && T3.agenda_tarefas.filter((x) => x.status === 'agendada').length === 1);
  // Assembleia que já passou: o que era para antes dela não roda.
  const fb4 = criarBanco(); const T4 = fb4.tabelas();
  T4.agenda_itens.push(Object.assign({}, T.agenda_itens.find((x) => x.id === ITEM_PREST), { data: '2026-11-01' }));
  T4.agenda_tarefas.push(tarefa({ chave: 'p', tipo: 'prestacao_contas', item_id: ITEM_PREST, id_superlogica: 10, data_execucao: '2026-10-25', parametros: { inicio: '2026-07', fim: '2026-09' } }));
  const antes4 = chamadasGer.length;
  await execucao.criarAgendador({ banco: fb4.banco, executores, salvarTrabalho: async () => 'x', baixarMaterial: async () => Buffer.alloc(0), tiposCertidao: [], ligado: () => true, agora: () => AGORA2, horaInicio: () => 6 }).rodar();
  t('assembleia passada: tarefa descartada sem gerar', chamadasGer.length === antes4 && T4.agenda_tarefas[0].status === 'cancelada' && T4.agenda_tarefas[0].motivo === 'assembleia_passou');
  // Trava vencida (queda no meio): volta para agendada e roda.
  const fb5 = criarBanco(); const T5 = fb5.tabelas();
  T5.agenda_itens.push(Object.assign({}, T.agenda_itens.find((x) => x.id === ITEM_PREST)));
  T5.condominios.push(...BASE);
  T5.agenda_tarefas.push(tarefa({ chave: 'v', tipo: 'prestacao_contas', item_id: ITEM_PREST, id_superlogica: 10, data_execucao: '2026-11-05', parametros: { inicio: '2026-07', fim: '2026-09' }, status: 'rodando', trava_ate: '2026-11-06T12:00:00.000Z', trava_dono: 'outra' }));
  await execucao.criarAgendador({ banco: fb5.banco, executores, salvarTrabalho: async () => 'x', baixarMaterial: async () => Buffer.alloc(0), tiposCertidao: [], ligado: () => true, agora: () => AGORA2, horaInicio: () => 6 }).rodar();
  t('trava vencida volta e roda', T5.agenda_tarefas[0].status === 'pronta_conferir');
  // Tendências.
  const tend = agenda.tendencias(['2026-10', '2026-11'], [{ mes: '2026-11', tipo_item: 'assembleia' }, { mes: '2026-10', tipo_item: 'assembleia' }],
    [{ mes: '2026-11', tipo: 'prestacao_contas', status: 'pronta_conferir', prazo: '2026-11-05', pronta_em: '2026-11-05T13:00:00Z', tentativas: 1, travas: [{ motivo: 'falta_edital' }], resultado: { material_em: '2026-11-04T13:00:00Z' } },
      { mes: '2026-11', tipo: 'apresentacao', status: 'pendente_material', prazo: '2026-11-09', tentativas: 0, travas: [{ motivo: 'falta_edital' }, { motivo: 'falta_orcamentos' }] }],
    { '2026-11': { usd: 1.234, chamadas: 9 } });
  t('tendências: no prazo, o que mais travou, tempo do material e custo', tend[1].no_prazo === 1 && tend[1].pct_no_prazo === 50 && tend[1].mais_travou[0].motivo === 'falta_edital' && tend[1].horas_material_ate_pronto === 24 && tend[1].custo_usd === 1.23 && tend[0].pct_no_prazo === null);

  console.log(ok + ' ok, ' + falha + ' falha(s)');
  process.exit(falha ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
