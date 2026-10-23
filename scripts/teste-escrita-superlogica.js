// Testes da política única de gravação no Superlógica (servico/escrita-superlogica.js), sem rede:
// NODE_PATH=<repo>/node_modules node scripts/teste-escrita-superlogica.js
// Cobre: 167 grava direto; outro condomínio sem token dá 428 com resumo; token de outro usuário,
// de outro condomínio, com conteúdo alterado ou vencido é recusado; token usado duas vezes é recusado;
// sensível exige o nome digitado; interruptor off bloqueia tudo; lista antiga; lote item a item; auditoria.
const W = require('../servico/escrita-superlogica');

let ok = 0, falhou = 0;
function t(nome, cond) { if (cond) ok++; else { falhou++; console.log('FALHOU: ' + nome); } }

let env = {};
let relogio = Date.parse('2026-10-23T12:00:00Z');
const eventos = [];
const BASE = { 167: 'Residencial Teste', 136: 'Condomínio Casablanca', 94: 'Condomínio Victoria Bay Club & Residence', 140: 'Residencial Reserva dos Camarás' };
const P = W.criarPoliticaEscrita({
  env: () => env, agora: () => relogio,
  auditar: (req, acao, det, susp, motivo) => eventos.push({ acao, det, susp, motivo, usuario: req.user && req.user.sub }),
  condominioDaBase: async (id) => (BASE[id] ? { nome: BASE[id] } : null),
});
const req = (sub, corpo) => ({ user: { sub }, authMode: 'supabase', body: corpo || {} });
const res = () => { const o = { st: 200, j: null }; o.status = (s) => { o.st = s; return o; }; o.json = (j) => { o.j = j; return o; }; return o; };
const pedido = (id, conteudo, extra) => Object.assign({ operacao: 'segunda_via', id_condominio: id, conteudo: conteudo || { id_unidade: '1', id_recebimento: '9', pagar_ate: '2026-10-30' },
  resumo: { linhas: [{ rotulo: 'Unidade', valor: '101' }, { rotulo: 'Pagamento até', valor: '30/10/2026' }] } }, extra || {});
const ultimo = (acao) => eventos.filter((e) => e.acao === acao).slice(-1)[0];

(async () => {
  // ---------- 1. situação e interruptor ----------
  t('padrão é teste', W.modo({}) === 'teste' && W.modo({ ESCRITA_SUPERLOGICA: 'qualquer' }) === 'teste' && W.modo({ ESCRITA_SUPERLOGICA: ' CONFIRMACAO ' }) === 'confirmacao');
  t('teste padrão só 167', [...W.condominiosTeste({})].join() === '167' && [...W.condominiosTeste({ ESCRITA_TESTE: '167, 136; abc 143' })].join() === '167,136');
  t('167 livre', W.situacao('segunda_via', '167', null, {}).estado === 'livre');
  t('outro bloqueado no modo teste', W.situacao('segunda_via', '136', null, {}).estado === 'bloqueado' && W.situacao('segunda_via', '136', null, {}).motivo === 'so_teste');
  t('outro com confirmação no modo confirmacao', W.situacao('segunda_via', '136', null, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'confirmacao');
  t('sensível reforçada', W.situacao('balancete_gerar', '136', null, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'reforcada');
  t('sensível livre no 167', W.situacao('balancete_gerar', '167', null, {}).estado === 'livre');
  t('lote acima de 20 reforçado', W.situacao('consumo_lote', '136', { quantidade: 21 }, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'reforcada'
    && W.situacao('consumo_lote', '136', { quantidade: 20 }, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'confirmacao');
  t('lista antiga vale com confirmação', W.situacao('entrada_lancar', '136', null, { ENTRADA_LANCAMENTO_LIBERADO: '136' }).estado === 'confirmacao'
    && W.situacao('balancete_gerar', '94', null, { BALANCETE_GERACAO_LIBERADA: '94' }).estado === 'reforcada'
    && W.situacao('consumo_lote', '136', null, { ENTRADA_LANCAMENTO_LIBERADO: '136' }).estado === 'bloqueado');
  t('lista antiga vazia não libera nada', W.situacao('segunda_via', '136', null, { COBRANCA_SEGUNDA_VIA_LIBERADA: '  ' }).estado === 'bloqueado');
  t('administração nunca', ['143', '144', '145', '160', '162'].every((id) => W.situacao('segunda_via', id, null, { ESCRITA_SUPERLOGICA: 'confirmacao', ESCRITA_TESTE: id, COBRANCA_SEGUNDA_VIA_LIBERADA: id }).estado === 'bloqueado'));
  t('id inválido nunca', W.situacao('segunda_via', '0', null, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'bloqueado' && W.situacao('segunda_via', '1;2', null, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'bloqueado');
  t('off bloqueia o 167', W.situacao('segunda_via', '167', null, { ESCRITA_SUPERLOGICA: 'off' }).motivo === 'escrita_desligada');
  t('disparo só com a chave antiga', W.situacao('comunicado_disparar', null, null, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'bloqueado'
    && W.situacao('comunicado_disparar', null, null, { COMUNICADOS_DISPARO_LIBERADO: '1' }).estado === 'reforcada');
  t('nome curto', W.nomeCurto('Residencial Teste') === 'Teste' && W.nomeCurto('Condomínio Victoria Bay Club & Residence') === 'Victoria Bay'
    && W.nomeCurto('Residencial Reserva dos Camarás') === 'Reserva dos Camarás' && W.nomeCurto('Edifício') === 'Edifício');
  t('normalizar', W.normalizar(' Reserva  dos CAMARAS ') === W.normalizar('reserva dos camarás'));
  t('hash estável', W.hashDe({ b: 1, a: [1, { d: 2, c: 3 }] }) === W.hashDe({ a: [1, { c: 3, d: 2 }], b: 1 }));

  // ---------- 2. 167 grava direto ----------
  let r = res();
  let a = await P.autorizar(req('u1'), r, pedido('167'));
  t('167 grava direto sem token', a && a.livre === true && a.confirmada === false && r.j === null);
  a.concluir({ ok: true });
  let ev = ultimo('gravacao_superlogica');
  t('auditoria da gravação livre', ev && ev.det.operacao === 'segunda_via' && ev.det.id_superlogica === '167' && ev.det.livre === true && ev.det.confirmada === false && ev.det.ok === true
    && ev.det.resumo.linhas.length === 2 && ev.usuario === 'u1');
  a.concluir({ ok: false });
  t('concluir registra uma vez só', eventos.filter((e) => e.acao === 'gravacao_superlogica').length === 1);

  // ---------- 3. interruptor off ----------
  env = { ESCRITA_SUPERLOGICA: 'off' };
  r = res();
  t('off: 167 recusa 423', (await P.autorizar(req('u1'), r, pedido('167'))) === false && r.st === 423 && r.j.motivo === 'escrita_desligada');
  t('off: recusa auditada', ultimo('gravacao_recusada').det.motivo === 'escrita_desligada');
  r = res();
  t('off: bloqueada() responde 423', P.bloqueada(req('u1'), r, 'entrada_lancar', '136') === true && r.st === 423);
  r = res();
  t('off: lote recusa', (await P.previaLote(req('u1'), r, { operacao: 'consumo_lote', id_condominio: '167', cabecalho: {}, itens: [{ id_unidade: 1 }] })) === false && r.st === 423);

  // ---------- 4. modo teste: outro condomínio bloqueado ----------
  env = {};
  r = res();
  t('teste: 136 recusa 423 so_teste', (await P.autorizar(req('u1'), r, pedido('136'))) === false && r.st === 423 && r.j.erro === 'gravacao_bloqueada' && r.j.motivo === 'so_teste' && !/[–—]/.test(r.j.detalhe));

  // ---------- 5. modo confirmacao ----------
  env = { ESCRITA_SUPERLOGICA: 'confirmacao' };
  r = res();
  t('fora da base recusa', (await P.autorizar(req('u1'), r, pedido('999'))) === false && r.st === 423 && r.j.motivo === 'fora_da_base');
  r = res();
  a = await P.autorizar(req('u1'), r, pedido('136'));
  t('136 sem token: 428 com resumo', a === false && r.st === 428 && r.j.erro === 'confirmacao_necessaria' && r.j.resumo.condominio === 'Condomínio Casablanca'
    && r.j.resumo.operacao === 'Geração da 2ª via do boleto' && r.j.resumo.linhas[0].valor === '101' && r.j.confirmacao.id_condominio === '136'
    && /^[0-9a-f]{48}$/.test(r.j.confirmacao.token) && r.j.confirmacao.reforcada === false);
  t('token não vai para a auditoria', !JSON.stringify(eventos).includes(r.j.confirmacao.token));
  const tok = r.j.confirmacao.token;
  const comToken = (token, extra) => Object.assign({ confirmacao_gravacao: Object.assign({ id_condominio: '136', token }, extra || {}) });

  r = res();
  t('token de outro usuário recusado (403)', (await P.autorizar(req('u2', comToken(tok)), r, pedido('136'))) === false && r.st === 403 && r.j.erro === 'confirmacao_invalida');
  ev = ultimo('gravacao_recusada');
  t('recusa de outro usuário auditada como suspeita', ev.det.motivo === 'token_de_outro_usuario' && ev.susp === true && ev.usuario === 'u2');
  r = res();
  t('depois da tentativa o token some', (await P.autorizar(req('u1', comToken(tok)), r, pedido('136'))) === false && r.st === 428 && r.j.motivo === 'token_vencido');

  // token novo para os próximos casos
  const novo = async (id, extraPedido) => { const x = res(); await P.autorizar(req('u1'), x, pedido(id, null, extraPedido)); return x.j.confirmacao.token; };
  let tk = await novo('136');
  r = res();
  t('token de outro condomínio recusado (403)', (await P.autorizar(req('u1', { confirmacao_gravacao: { id_condominio: '140', token: tk } }), r, pedido('140'))) === false && r.st === 403 && ultimo('gravacao_recusada').det.motivo === 'token_de_outro_condominio');
  tk = await novo('136');
  r = res();
  t('id_condominio do pedido diferente do token recusado', (await P.autorizar(req('u1', { confirmacao_gravacao: { id_condominio: '140', token: tk } }), r, pedido('136'))) === false && r.st === 403);
  tk = await novo('136');
  r = res();
  t('token de outra operação recusado', (await P.autorizar(req('u1', comToken(tk)), r, Object.assign(pedido('136'), { operacao: 'multa_registrar' }))) === false && r.st === 403 && ultimo('gravacao_recusada').det.motivo === 'token_de_outra_operacao');
  tk = await novo('136');
  r = res();
  t('conteúdo alterado recusado e pede de novo', (await P.autorizar(req('u1', comToken(tk)), r, pedido('136', { id_unidade: '2', id_recebimento: '9', pagar_ate: '2026-10-30' }))) === false
    && r.st === 428 && r.j.motivo === 'conteudo_alterado' && r.j.confirmacao.token !== tk && ultimo('gravacao_recusada').det.motivo === 'conteudo_alterado');
  tk = await novo('136');
  relogio += 10 * 60 * 1000 + 1;
  r = res();
  t('token vencido (10 minutos) recusado', (await P.autorizar(req('u1', comToken(tk)), r, pedido('136'))) === false && r.st === 428 && r.j.motivo === 'token_vencido');
  tk = await novo('136');
  relogio += 9 * 60 * 1000;
  r = res();
  a = await P.autorizar(req('u1', comToken(tk)), r, pedido('136'));
  t('token válido dentro dos 10 minutos grava', a && a.confirmada === true && a.livre === false && r.j === null);
  a.concluir({ ok: true });
  ev = ultimo('gravacao_superlogica');
  t('auditoria da gravação confirmada', ev.det.confirmada === true && ev.det.id_superlogica === '136' && ev.det.resumo.linhas[1].valor === '30/10/2026' && ev.susp === false);
  r = res();
  t('token usado duas vezes recusado (409)', (await P.autorizar(req('u1', comToken(tk)), r, pedido('136'))) === false && r.st === 409 && r.j.erro === 'confirmacao_ja_usada'
    && ultimo('gravacao_recusada').det.motivo === 'token_usado');
  r = res();
  t('token com formato errado vira pedido de confirmação', (await P.autorizar(req('u1', comToken('abc')), r, pedido('136'))) === false && r.st === 428 && !r.j.motivo);

  // ---------- 6. sensível: nome digitado ----------
  const bal = (id) => ({ operacao: 'balancete_gerar', id_condominio: id, conteudo: { competencia: '2026-09' }, resumo: { linhas: [{ rotulo: 'Mês', valor: '09/2026' }] } });
  r = res();
  await P.autorizar(req('u1'), r, bal('94'));
  t('sensível: 428 reforçado com o nome curto', r.st === 428 && r.j.confirmacao.reforcada === true && r.j.confirmacao.nome_curto === 'Victoria Bay' && r.j.resumo.sensivel === true);
  tk = r.j.confirmacao.token;
  const comNome = (nome) => ({ confirmacao_gravacao: { id_condominio: '94', token: tk, nome_digitado: nome } });
  r = res();
  t('sensível sem nome recusa', (await P.autorizar(req('u1', comNome(undefined)), r, bal('94'))) === false && r.st === 428 && r.j.motivo === 'nome_nao_confere' && r.j.confirmacao.token === tk);
  r = res();
  t('sensível com nome errado recusa', (await P.autorizar(req('u1', comNome('Victoria')), r, bal('94'))) === false && r.st === 428 && r.j.motivo === 'nome_nao_confere');
  r = res();
  a = await P.autorizar(req('u1', comNome('  VICTÓRIA bay ')), r, bal('94'));
  t('sensível com o nome certo (sem acento e caixa) grava', a && a.confirmada === true);
  r = res();
  await P.autorizar(req('u1'), r, bal('94'));
  tk = r.j.confirmacao.token;
  for (let i = 0; i < 3; i++) { r = res(); await P.autorizar(req('u1', comNome('x')), r, bal('94')); }
  t('três nomes errados: token novo', r.st === 428 && r.j.confirmacao.token !== tk);
  r = res();
  t('sensível livre no 167', (await P.autorizar(req('u1'), r, bal('167'))).livre === true);
  r = res();
  await P.autorizar(req('u1'), r, { operacao: 'multa_registrar', id_condominio: '136', sensivel: true, conteudo: { x: 1 }, resumo: async () => ({ linhas: [{ rotulo: 'Unidade', valor: 'A 101' }] }) });
  t('multa com cobrança: reforçada e resumo calculado na hora', r.st === 428 && r.j.confirmacao.reforcada === true && r.j.resumo.linhas[0].valor === 'A 101');

  // ---------- 7. disparo global ----------
  const disp = { operacao: 'comunicado_disparar', id_condominio: 'todos', conteudo: { disparo: 'pendentes' }, resumo: { linhas: [] } };
  r = res();
  t('disparo sem a chave antiga recusa', (await P.autorizar(req('u1'), r, disp)) === false && r.st === 423 && r.j.motivo === 'operacao_travada');
  env = { ESCRITA_SUPERLOGICA: 'confirmacao', COMUNICADOS_DISPARO_LIBERADO: '1' };
  r = res();
  await P.autorizar(req('u1'), r, disp);
  t('disparo: 428 com TODOS', r.st === 428 && r.j.confirmacao.nome_curto === 'TODOS' && r.j.confirmacao.id_condominio === 'todos' && /Todos os condomínios/.test(r.j.resumo.condominio));
  tk = r.j.confirmacao.token;
  r = res();
  a = await P.autorizar(req('u1', { confirmacao_gravacao: { id_condominio: 'todos', token: tk, nome_digitado: 'todos' } }), r, disp);
  t('disparo confirmado com TODOS', a && a.confirmada === true);

  // ---------- 8. lote item a item ----------
  env = { ESCRITA_SUPERLOGICA: 'confirmacao' };
  const cab = { tipo: 2, mes: '10/2026', dia: 23 };
  const itens = [{ id_unidade: 1, valor: 10.5, substituir: false }, { id_unidade: 2, valor: 20, substituir: true }];
  const lote = (corpo, its) => P.previaLote(req('u1', corpo), r, { operacao: 'consumo_lote', id_condominio: '136', cabecalho: cab, itens: its || itens, resumo: { linhas: [{ rotulo: 'Leituras', valor: '2' }] } });
  r = res(); await lote();
  t('prévia do lote: 428', r.st === 428 && r.j.resumo.quantidade === 2 && r.j.confirmacao.reforcada === false);
  const tl = r.j.confirmacao.token;
  const umItem = (it, token, sub) => { const x = res(); return P.autorizarItem(req(sub || 'u1', token ? { confirmacao_gravacao: { id_condominio: '136', token } } : {}), x, { operacao: 'consumo_lote', id_condominio: '136', cabecalho: cab, item: it, resumo: { linhas: [] } }).then((v) => ({ v, x })); };
  let u = await umItem(itens[0], tl);
  t('item antes de confirmar o lote: recusa', u.v === false && u.x.st === 428 && u.x.j.motivo === 'conteudo_alterado');
  r = res(); await lote();
  const tl2 = r.j.confirmacao.token;
  r = res(); await lote({ confirmacao_gravacao: { id_condominio: '136', token: tl2 } });
  t('lote confirmado: 200 com o token', r.st === 200 && r.j.confirmado === true && r.j.confirmacao.token === tl2);
  t('auditoria da confirmação do lote', ultimo('gravacao_lote_confirmado').det.quantidade === 2);
  u = await umItem(itens[0], tl2);
  t('item 1 do lote grava', u.v && u.v.confirmada === true);
  u = await umItem(itens[0], tl2);
  t('item 1 de novo recusa (409)', u.v === false && u.x.st === 409 && u.x.j.erro === 'confirmacao_ja_usada');
  u = await umItem({ id_unidade: 3, valor: 30, substituir: false }, tl2);
  t('item fora da lista recusa (409)', u.v === false && u.x.st === 409 && u.x.j.erro === 'item_fora_do_lote' && ultimo('gravacao_recusada').susp === true);
  u = await umItem({ id_unidade: 2, valor: 21, substituir: true }, tl2);
  t('item com valor alterado recusa', u.v === false && u.x.j.erro === 'item_fora_do_lote');
  u = await umItem(itens[1], tl2, 'u2');
  t('item com token de outro usuário recusa', u.v === false && u.x.st === 403);
  r = res(); await lote(); const tl3 = r.j.confirmacao.token;
  r = res(); await lote({ confirmacao_gravacao: { id_condominio: '136', token: tl3 } });
  u = await umItem(itens[1], tl3);
  t('item 2 grava com o lote', u.v && u.v.confirmada === true);
  u = await umItem(itens[0], tl3);
  t('último item fecha o lote', u.v && P._tokens.get(tl3).usado === true);
  u = await umItem(itens[0], tl3);
  t('lote todo usado: recusa', u.v === false && u.x.st === 409);
  u = await umItem(itens[0]);
  t('item sem token: 428 de um item só', u.v === false && u.x.st === 428 && u.x.j.confirmacao.token);
  const t1 = u.x.j.confirmacao.token;
  u = await umItem(itens[0], t1);
  t('item sozinho confirmado grava', u.v && u.v.confirmada === true);
  u = await umItem(itens[0], t1);
  t('item sozinho de novo recusa', u.v === false && u.x.st === 409);
  const grande = Array.from({ length: 21 }, (_, i) => ({ id_unidade: 100 + i, valor: i, substituir: false }));
  r = res(); await lote(undefined, grande);
  t('lote de 21: reforçado', r.st === 428 && r.j.confirmacao.reforcada === true && r.j.confirmacao.nome_curto === 'Casablanca');
  const tg = r.j.confirmacao.token;
  r = res(); await lote({ confirmacao_gravacao: { id_condominio: '136', token: tg } }, grande);
  t('lote de 21 sem nome: recusa', r.st === 428 && r.j.motivo === 'nome_nao_confere');
  env = {};
  r = res(); await lote();
  t('lote no modo teste para 136: 423', r.st === 423);
  r = res(); await P.previaLote(req('u1'), r, { operacao: 'consumo_lote', id_condominio: '167', cabecalho: cab, itens });
  t('lote no 167: livre', r.st === 200 && r.j.livre === true);
  u = await (async () => { const x = res(); const v = await P.autorizarItem(req('u1'), x, { operacao: 'consumo_lote', id_condominio: '167', cabecalho: cab, item: itens[0] }); return { v, x }; })();
  t('item no 167: livre', u.v && u.v.livre === true);

  // ---------- 9. vários condomínios num pedido (lote da entrada) ----------
  env = { ESCRITA_SUPERLOGICA: 'confirmacao' };
  r = res();
  await P.autorizar(req('u1'), r, { operacao: 'entrada_lote', id_condominio: ['140', '136'], conteudo: { itens: [1, 2] }, quantidade: 2, resumo: { linhas: [] } });
  t('lote de dois condomínios: alvo ordenado e nomes', r.st === 428 && r.j.confirmacao.id_condominio === '136,140' && r.j.resumo.condominio === 'Condomínio Casablanca, Residencial Reserva dos Camarás');
  const tm = r.j.confirmacao.token;
  r = res();
  a = await P.autorizar(req('u1', { confirmacao_gravacao: { id_condominio: '136,140', token: tm } }), r, { operacao: 'entrada_lote', id_condominio: ['136', '140'], conteudo: { itens: [1, 2] }, quantidade: 2, resumo: { linhas: [] } });
  t('lote de dois condomínios confirmado', a && a.confirmada === true);
  r = res();
  t('estado e configuração para a tela', P.estado('entrada_lancar', '136').estado === 'confirmacao' && P.configuracao().modo === 'confirmacao' && P.configuracao().teste.join() === '167');

  // ---------- 10. base fora do ar ----------
  const P2 = W.criarPoliticaEscrita({ env: () => ({ ESCRITA_SUPERLOGICA: 'confirmacao' }), auditar: () => {}, condominioDaBase: async () => { throw new Error('caiu'); } });
  r = res();
  t('base fora do ar: 503 e nada gravado', (await P2.autorizar(req('u1'), r, pedido('136'))) === false && r.st === 503);
  const P3 = W.criarPoliticaEscrita({ env: () => ({}), condominioDaBase: async () => null });
  r = res();
  t('167 grava mesmo sem estar na tabela da base', (await P3.autorizar(req('u1'), r, pedido('167'))).livre === true);

  // ---------- 11. textos de tela sem hífen nem travessão ----------
  const fonte = require('fs').readFileSync(require('path').join(__dirname, '..', 'servico', 'escrita-superlogica.js'), 'utf8');
  const textos = (fonte.match(/'[^'\n]*[A-Za-zÀ-ú][^'\n]*'/g) || []).filter((s) => / /.test(s));
  t('textos sem travessão', !textos.some((s) => /[–—]/.test(s)));
  t('textos sem hífen entre palavras', !textos.some((s) => /[A-Za-zÀ-ú] - [A-Za-zÀ-ú]/.test(s)));

  console.log('escrita no Superlógica: ' + ok + ' ok, ' + falhou + ' falhou');
  process.exit(falhou ? 1 : 0);
})().catch((e) => { console.log('FALHOU com exceção: ' + (e && e.stack)); process.exit(1); });
