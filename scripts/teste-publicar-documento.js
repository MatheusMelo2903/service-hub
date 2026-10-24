// Testes da publicação pelo Hub (superlogica/publicar-documento.js) com a política única de gravação
// (servico/escrita-superlogica.js), sem rede: Superlógica simulado em memória (impressoes/index e
// impressoes/post), login pelo cabeçalho de teste. Nenhuma publicação de verdade.
// Uso: NODE_PATH=<repo>/node_modules node scripts/teste-publicar-documento.js
process.env.NODE_ENV = 'test';
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const BD = require('../financeiro/balancete-digital');
const PD = require('../superlogica/publicar-documento');
const { criarPoliticaEscrita } = require('../servico/escrita-superlogica');

let ok = 0, falhou = 0;
function t(nome, cond) { if (cond) ok++; else { falhou++; console.log('FALHOU: ' + nome); } }

// ── Superlógica simulado ──
const docs = [
  { id_impressao_fimp: '700001', id_empresa_emp: '167', st_titulo_fimp: 'Prestação de contas Setembro 2026', st_descricao_fimp: 'Mês 09/2026', dt_criacao_fimp: '10/20/2026', fl_publicadopara_impr: '' },
  { id_impressao_fimp: '700002', id_empresa_emp: '167', st_titulo_fimp: '900A Prestação de contas', st_descricao_fimp: 'Mês 09/2026', dt_criacao_fimp: '10/21/2026', fl_publicadopara_impr: '0' },
  { id_impressao_fimp: '700003', id_empresa_emp: '136', st_titulo_fimp: 'Prestação de outro condomínio', st_descricao_fimp: 'Mês 09/2026', dt_criacao_fimp: '10/21/2026', fl_publicadopara_impr: '' },
  { id_impressao_fimp: '700004', id_empresa_emp: '80', st_titulo_fimp: 'Prestação de contas Setembro 2026', st_descricao_fimp: 'Mês 09/2026', dt_criacao_fimp: '10/21/2026', fl_publicadopara_impr: '' },
];
const envios = [];
let modoResposta = 'normal'; // normal | sem_resposta | recusa | diz_ok_sem_mudar
BD.pedir = async (cred, metodo, caminho, query, corpo) => {
  const campos = Object.fromEntries(new URLSearchParams(corpo.toString('utf8')));
  envios.push({ metodo, caminho, query, campos });
  if (caminho !== 'impressoes/post') return { status: 404, json: null };
  if (modoResposta === 'sem_resposta') return { status: 504, json: null };
  if (modoResposta === 'recusa') return { status: 200, json: [{ status: '500', msg: 'Documento inválido' }] };
  if (modoResposta === 'diz_ok_sem_mudar') return { status: 200, json: [{ status: '200', msg: 'ok' }] };
  const d = docs.find((x) => x.id_impressao_fimp === campos.ID_IMPRESSAO_FIMP);
  if (d) d.fl_publicadopara_impr = campos.FL_PUBLICADOPARA_IMPR;
  return { status: 200, json: [{ status: '200', msg: 'Sucesso' }] };
};
const cliente = { get: async (caminho, p) => (caminho === 'impressoes/index' ? docs.filter((d) => d.id_empresa_emp === String(p.idCondominio)).map((d) => Object.assign({}, d)) : []) };
const doc = (id) => docs.find((x) => x.id_impressao_fimp === id);

(async () => {
  t('situação 1 é condôminos', PD.situacaoPublicacao('1') === 'condominos' && PD.situacaoPublicacao('') === 'nao' && PD.situacaoPublicacao('0') === 'nao' && PD.situacaoPublicacao('2') === 'responsaveis');
  t('localiza pelo id no condomínio', (await PD.localizar(cliente, '167', { id: '700001' })).titulo === 'Prestação de contas Setembro 2026');
  t('não acha documento de outro condomínio', (await PD.localizar(cliente, '167', { id: '700003' })) === null);
  t('acha pelo título', (await PD.localizar(cliente, '167', { titulo: 'prestação de contas setembro 2026' })).id === '700001');

  // ── rotas com a política ──
  const env = { ESCRITA_SUPERLOGICA: 'confirmacao', ESCRITA_TESTE: '167' };
  const eventos = [];
  const auditoria = { evento: (req, acao, det, susp) => eventos.push({ acao, det, susp }) };
  const politica = criarPoliticaEscrita({ env: () => env, auditar: (req, acao, det, s) => eventos.push({ acao, det, susp: s }), condominioDaBase: async (id) => (id === '80' ? { nome: 'Condomínio Residencial Buritis' } : null) });
  const USUARIO = crypto.randomUUID();
  const agendados = [];
  const pub = PD.criarPublicador({ cred: () => ({}), cliente: () => cliente, politica, auditoria, esperar: async () => {}, agendar: (fn) => agendados.push(fn) });
  const app = express();
  app.post('/pub/:id', (req, res, next) => { req.user = { sub: USUARIO, email: 'teste@exemplo.com' }; req.authMode = 'supabase'; next(); }, express.json(), async (req, res) => {
    const b = req.body || {};
    await pub.executar(req, res, { idCond: req.params.id, alvo: { id: b.id_documento, titulo: b.titulo }, acao: b.acao, avisar: b.avisar, documento: 'Prestação de contas',
      validarItem: (it) => (/^900A\b/.test(it.titulo) ? 'É o 900A.' : null) });
  });
  const srv = app.listen(0);
  const porta = srv.address().port;
  const pedir = (id, corpo) => new Promise((fim) => {
    const buf = Buffer.from(JSON.stringify(corpo));
    const r = http.request({ host: '127.0.0.1', port: porta, path: '/pub/' + id, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': buf.length } }, (res) => {
      const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(p).toString()); } catch (e) { j = null; } fim({ status: res.statusCode, j }); });
    });
    r.end(buf);
  });

  // Sem escolha de aviso: recusa.
  let r = await pedir('167', { id_documento: '700001', acao: 'publicar' });
  t('sem escolher o aviso recusa', r.status === 400 && envios.length === 0);
  r = await pedir('167', { id_documento: '700001', acao: 'apagar', avisar: false });
  t('ação desconhecida recusa', r.status === 400 && envios.length === 0);

  // 167 (teste): publica sem aviso, livre.
  r = await pedir('167', { id_documento: '700001', acao: 'publicar', avisar: false });
  const e1 = envios[envios.length - 1];
  t('publica sem aviso', r.status === 200 && r.j.ok && r.j.avisou === false && doc('700001').fl_publicadopara_impr === '1');
  t('campos do envio sem aviso', e1 && e1.campos.FL_PUBLICADOPARA_IMPR === '1' && e1.campos.FL_NOTIFICAR_IMPRESSAO === '0' && e1.campos.FL_COMPARTILHAR === '0' && e1.campos.ID_IMPRESSAO_FIMP === '700001' && e1.query.FL_NOTIFICAR_IMPRESSAO === '0');
  t('auditoria de quem publicou, sem aviso e o id', eventos.some((e) => e.acao === 'documento_publicado' && e.det.id_documento === '700001' && e.det.avisar === false && e.det.por === 'teste@exemplo.com'));
  t('política registrou a gravação', eventos.some((e) => e.acao === 'gravacao_superlogica' && e.det.operacao === 'documento_publicar'));

  // Já publicado: não grava de novo.
  const n1 = envios.length;
  r = await pedir('167', { id_documento: '700001', acao: 'publicar', avisar: false });
  t('já publicado não grava', r.status === 200 && r.j.ja_estava === true && envios.length === n1);

  // Despublicar.
  r = await pedir('167', { id_documento: '700001', acao: 'despublicar' });
  const e2 = envios[envios.length - 1];
  t('retira a publicação', r.status === 200 && doc('700001').fl_publicadopara_impr === '0' && e2.campos.FL_PUBLICADOPARA_IMPR === '0' && e2.campos.FL_NOTIFICAR_IMPRESSAO === '0');
  t('auditoria da retirada', eventos.some((e) => e.acao === 'documento_despublicado' && e.det.id_documento === '700001'));

  // Com aviso (só no simulado).
  r = await pedir('167', { id_documento: '700001', acao: 'publicar', avisar: true });
  t('publica com aviso', r.status === 200 && r.j.avisou === true && envios[envios.length - 1].campos.FL_NOTIFICAR_IMPRESSAO === '1');
  await pedir('167', { id_documento: '700001', acao: 'despublicar' });

  // Documento de outro condomínio, 900A pela rota errada.
  let n = envios.length;
  r = await pedir('167', { id_documento: '700003', acao: 'publicar', avisar: false });
  t('documento de outro condomínio não acha', r.status === 404 && envios.length === n);
  r = await pedir('167', { id_documento: '700002', acao: 'publicar', avisar: false });
  t('900A pela rota da prestação recusa', r.status === 409 && envios.length === n);

  // Recusa do Superlógica.
  modoResposta = 'recusa';
  r = await pedir('167', { id_documento: '700001', acao: 'publicar', avisar: false });
  t('recusa do Superlógica vira falhou', r.status === 502 && doc('700001').fl_publicadopara_impr === '0');

  // Sem resposta: sem confirmação, não repete, relê depois.
  modoResposta = 'sem_resposta';
  n = envios.length;
  r = await pedir('167', { id_documento: '700001', acao: 'publicar', avisar: false });
  t('sem resposta vira sem confirmação', r.status === 202 && r.j.sem_confirmacao === true && envios.length === n + 1);
  modoResposta = 'normal';
  r = await pedir('167', { id_documento: '700001', acao: 'publicar', avisar: false });
  t('não repete enquanto relê', r.status === 409 && r.j.erro === 'sem_confirmacao_aguardando' && envios.length === n + 1);
  t('releitura agendada', agendados.length === 1);
  await agendados[0]();
  t('releitura registrada na auditoria', eventos.some((e) => e.acao === 'documento_publicacao_relida' && e.det.id_documento === '700001' && e.det.confirmou === false));
  // Gravou de verdade depois (o Superlógica processou atrasado): a próxima chamada vê e não grava.
  doc('700001').fl_publicadopara_impr = '1';
  r = await pedir('167', { id_documento: '700001', acao: 'publicar', avisar: false });
  t('depois da releitura, já publicado não grava', r.status === 200 && r.j.ja_estava === true && envios.length === n + 1);
  doc('700001').fl_publicadopara_impr = '0';

  // Diz que gravou mas a releitura não mostra: sem confirmação.
  modoResposta = 'diz_ok_sem_mudar';
  r = await pedir('167', { id_documento: '700001', acao: 'despublicar' });
  t('já não publicado: nada a fazer', r.status === 200 && r.j.ja_estava === true);
  r = await pedir('167', { id_documento: '700001', acao: 'publicar', avisar: false });
  t('ok sem mudança vira sem confirmação', r.status === 202);
  modoResposta = 'normal';
  pub._pendentes.clear();

  // Fora do teste (80): confirmação reforçada com o aviso em destaque.
  n = envios.length;
  r = await pedir('80', { id_documento: '700004', acao: 'publicar', avisar: false });
  t('fora do teste pede confirmação', r.status === 428 && r.j.confirmacao.reforcada === true && r.j.confirmacao.nome_curto === 'Buritis' && envios.length === n);
  t('resumo com SEM aviso em destaque', r.j.resumo.destaque === 'SEM aviso aos moradores' && r.j.resumo.linhas.some((l) => l.rotulo === 'Para quem' && l.valor === 'Para os condôminos') && r.j.resumo.linhas.some((l) => l.rotulo === 'Competência' && l.valor === 'Mês 09/2026'));
  const tok = r.j.confirmacao.token;
  r = await pedir('80', { id_documento: '700004', acao: 'publicar', avisar: true, confirmacao_gravacao: { id_condominio: '80', token: tok, nome_digitado: 'Buritis' } });
  t('trocar para com aviso depois de confirmar sem aviso pede de novo', r.status === 428 && r.j.motivo === 'conteudo_alterado' && r.j.resumo.destaque === 'COM aviso aos moradores' && envios.length === n);
  const tok2 = r.j.confirmacao.token;
  r = await pedir('80', { id_documento: '700004', acao: 'publicar', avisar: true, confirmacao_gravacao: { id_condominio: '80', token: tok2, nome_digitado: 'Outro' } });
  t('nome errado não grava', r.status === 428 && envios.length === n);
  r = await pedir('80', { id_documento: '700004', acao: 'publicar', avisar: false });
  const tok3 = r.j.confirmacao.token;
  r = await pedir('80', { id_documento: '700004', acao: 'publicar', avisar: false, confirmacao_gravacao: { id_condominio: '80', token: tok3, nome_digitado: 'buritis' } });
  t('confirmado com o nome grava', r.status === 200 && doc('700004').fl_publicadopara_impr === '1' && envios.length === n + 1);
  r = await pedir('80', { id_documento: '700004', acao: 'despublicar' });
  t('retirar fora do teste também pede confirmação reforçada', r.status === 428 && r.j.confirmacao.reforcada === true && /Retirar/.test(r.j.resumo.destaque));

  // Escrita desligada: nada grava.
  env.ESCRITA_SUPERLOGICA = 'off';
  n = envios.length;
  r = await pedir('167', { id_documento: '700001', acao: 'publicar', avisar: false });
  t('escrita desligada recusa', r.status === 423 && envios.length === n);
  env.ESCRITA_SUPERLOGICA = 'confirmacao';

  t('aplicar recusa id inválido', (await PD.aplicar({ cred: {}, cliente, idCond: '167', esperar: async () => {} }, { id: 'x', publicar: true })).estado === 'falhou');

  // ── rota do balancete: só publica em "Pronto para publicar" ──
  const appB = express();
  const passa = async () => true;
  const bancoFalso = { ler: async () => [], upsert: async () => [], inserir: async () => [] };
  require('../financeiro/balancete-digital-rotas').criarRotasBalanceteDigital(appB, {
    dentroDoLimite: () => true,
    requireAuth: (req, res, next) => { req.user = { sub: USUARIO, email: 'teste@exemplo.com' }; req.authMode = 'supabase'; next(); },
    express, exigirFinanceiro: passa, exigirModuloItem: passa, exigirLeituraSuperlogica: passa, exigirCarteira: passa, carteiraEstrita: passa, exigirEscritaSuperlogica: passa,
    exigirEscopoFinanceiro: async () => ({ escopo: null }), escopoFinanceiro: async () => null, gruposCarteiras: async () => [],
    clienteSL: () => cliente, credSL: () => ({}), politica, auditoria,
    fechamentoT38: { calcular: async () => null }, painelFin: { preBalancete: async () => null }, condominios: async () => [{ id: '167', nome: 'Residencial Teste', plano: '17' }],
    supabase: { url: '', chave: '' }, banco: bancoFalso, storage: { enviar: async () => {}, baixar: async () => null }, hoje: () => '2026-10-24', log: () => {}, publicador: pub,
  });
  const srvB = appB.listen(0);
  const portaB = srvB.address().port;
  const pedirB = (corpo) => new Promise((fim) => {
    const buf = Buffer.from(JSON.stringify(corpo));
    const q = http.request({ host: '127.0.0.1', port: portaB, path: '/api/financeiro/balancete-digital/167/publicar', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': buf.length } }, (res) => {
      const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(p).toString()); } catch (e) { j = null; } fim({ status: res.statusCode, j }); });
    });
    q.end(buf);
  });
  n = envios.length;
  r = await pedirB({ competencia: '2026-09', id_impressao: '700002', acao: 'publicar', avisar: false });
  t('balancete fora de Pronto para publicar recusa', r.status === 409 && r.j.erro === 'nao_pronto' && envios.length === n);
  r = await pedirB({ competencia: '2026-09', id_impressao: '700001', acao: 'despublicar' });
  t('balancete não retira documento que não é 900A', r.status === 409 && envios.length === n);
  doc('700002').fl_publicadopara_impr = '1';
  r = await pedirB({ competencia: '2026-09', id_impressao: '700002', acao: 'despublicar' });
  t('balancete retira o 900A do mês publicado', r.status === 200 && doc('700002').fl_publicadopara_impr === '0' && envios.length === n + 1);
  r = await pedirB({ competencia: '2026-08', id_impressao: '700002', acao: 'despublicar' });
  t('balancete não mexe em 900A de outro mês', r.status === 409);
  srvB.close();

  srv.close();
  console.log((falhou ? 'FALHOU ' : 'OK ') + ok + ' de ' + (ok + falhou));
  process.exit(falhou ? 1 : 0);
})();
