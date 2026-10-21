// T18: testes das regras de carteira (bloqueio no servidor, ação todas_carteiras, módulos) e dos
// filtros de alertas (água e luz fora do alerta de nota, prazos do banco, nome do tipo de leitura).
// Sem rede e sem banco: tudo com dados de mentira. Rodar:
//   NODE_PATH=/Users/matheusmelo/v8s/service-hub/node_modules node scripts/teste-carteira-alertas.js
const http = require('http');
const express = require('express');
const C = require('../superlogica/carteira');
const A = require('../superlogica/alertas-operacionais');
const P = require('../superlogica/prazos-manutencao');

let ok = 0, falha = 0;
const pendentes = [];
function t(nome, cond) { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } }

// ── Perfis de mentira ──
const perm = (extra) => Object.assign({ dashboard: { visivel: true, acoes: ['ver'] } }, extra || {});
const PERFIS = {
  gestor: { id: 'gestor', role: 'GESTOR', permissoes: perm() },
  semcart: { id: 'semcart', role: 'OPERACIONAL', permissoes: perm({ ficha_condominio: { visivel: true, acoes: ['ver'] } }) },
  cartA: { id: 'cartA', role: 'GERENTE', permissoes: perm({ ficha_condominio: { visivel: true, acoes: ['ver'] }, cobranca: { visivel: true, acoes: ['ver'] }, comparativo: { visivel: false, acoes: [] } }) },
  todas: { id: 'todas', role: 'OPERACIONAL', permissoes: perm({ configuracoes: { visivel: true, acoes: ['ver', 'todas_carteiras'] }, cobranca: { visivel: true, acoes: ['ver', 'segunda_via'] } }) },
  todasEscondido: { id: 'todasEscondido', role: 'OPERACIONAL', permissoes: perm({ configuracoes: { visivel: false, acoes: ['todas_carteiras'] } }) },
  apagada: { id: 'apagada', role: 'OPERACIONAL', permissoes: perm({ ficha_condominio: { visivel: true, acoes: ['ver'] } }) },
  falhaCart: { id: 'falhaCart', role: 'OPERACIONAL', permissoes: perm() },
};
const CARTEIRAS = { gestor: [], semcart: [], cartA: [10], todas: [10], todasEscondido: [10], apagada: [99], falhaCart: [10] };
const GRUPOS = [{ id: 10, nome: 'CARTEIRA A', tipo: 'gerente', condominios: [2, 8] }, { id: 11, nome: 'CARTEIRA B', tipo: 'gerente', condominios: [136] }];
const carteira = C.criarCarteira({
  lerPerfil: async (id) => PERFIS[id] || null,
  lerCarteirasPerfis: async (id) => (id === 'falhaCart' ? null : { [id]: CARTEIRAS[id] || [] }),
  semColuna: () => false,
  gruposCarteiras: async () => GRUPOS,
  ativo: () => true,
  express,
});

// ── App de teste: auth de mentira pelo cabeçalho x-user, rotas que só ecoam ──
const app = express();
const requireAuth = (req, res, next) => {
  const u = req.headers['x-user'];
  if (u === 'internal') { req.authMode = 'internal'; return next(); }
  if (!u) return res.status(401).json({ erro: 'auth_obrigatoria' });
  req.user = { sub: u }; req.authMode = 'supabase'; next();
};
app.use('/api/superlogica', requireAuth, carteira.guardaProxy);
app.use('/api', carteira.guardaRotas(requireAuth));
app.use('/api/superlogica', (req, res) => {
  // Proxy de mentira: devolve lista com condomínios 2, 8 e 136, e o corpo recebido.
  const partes = [];
  function fim() {
    if (/pdf/.test(req.url)) { res.setHeader('Content-Type', 'application/pdf'); return res.end(Buffer.from('%PDF-1.4 x')); }
    res.json({ lista: [{ id_condominio_cond: '2', n: 'a' }, { id_condominio_cond: '8', n: 'b' }, { id_condominio_cond: '136', n: 'c' }, { sem: 'cond' }], corpo: Buffer.concat(partes).toString() });
  }
  if (req.method === 'GET') return fim();
  // Corpo já lido pela guarda (pipe trocado) ou ainda no fluxo (quem vê todas).
  if (Object.prototype.hasOwnProperty.call(req, 'pipe')) return req.pipe({ end: (b) => { if (b) partes.push(b); fim(); } });
  req.on('data', (b) => partes.push(b));
  req.on('end', fim);
});
app.get('/api/condominio/:id/ficha', (req, res) => res.json({ ok: true, id: req.params.id }));
app.get('/api/condominio/:id/cadastro', (req, res) => res.json({ ok: true }));
app.post('/api/condominio/:id/documentos', express.json(), (req, res) => res.json({ ok: true, corpo: req.body }));
app.get('/api/cobranca/condominio/:id', (req, res) => res.json({ ok: true }));
app.post('/api/cobranca/condominio/:id/segunda-via', express.json(), (req, res) => res.json({ ok: true }));
app.get('/api/comparativo/condominio/:id', (req, res) => res.json({ ok: true }));
app.get('/api/unidades/busca', (req, res) => res.json({ termo: 'x', itens: [{ id_superlogica: 2 }, { id_superlogica: 136 }], quantidade: 2 }));
app.post('/api/despesas/verificar', express.json({ limit: '1mb' }), (req, res) => res.json({ ok: true, recebido: req.body }));
app.post('/api/atas/gerar', express.json({ limit: '36mb' }), (req, res) => res.json({ ok: true, recebido: !!req.body.userMessage }));
app.post('/api/prestacao/v13/superlogica', express.json({ limit: '20kb' }), (req, res) => res.json({ ok: true, id: req.body.id_superlogica }));

function chamar(porta, metodo, caminho, user, corpo, tipo) {
  return new Promise((ok) => {
    const dados = corpo == null ? null : Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const h = {};
    if (user) h['x-user'] = user;
    if (dados) { h['content-type'] = tipo || 'application/json'; h['content-length'] = dados.length; }
    const r = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: h }, (resp) => {
      const p = []; resp.on('data', (c) => p.push(c));
      resp.on('end', () => { const s = Buffer.concat(p).toString(); let j = null; try { j = JSON.parse(s); } catch (e) { /* texto */ } ok({ status: resp.statusCode, j, s, ct: resp.headers['content-type'] }); });
    });
    if (dados) r.write(dados);
    r.end();
  });
}

async function testesCarteira() {
  const srv = app.listen(0);
  const porta = srv.address().port;
  const c = (...a) => chamar(porta, ...a);
  try {
    // Rotas com condomínio no caminho
    t('gestor vê fora de carteira', (await c('GET', '/api/condominio/136/ficha', 'gestor')).status === 200);
    t('sem carteira vê todos', (await c('GET', '/api/condominio/136/ficha', 'semcart')).status === 200);
    t('carteira A vê o 2', (await c('GET', '/api/condominio/2/ficha', 'cartA')).status === 200);
    const fora = await c('GET', '/api/condominio/136/ficha', 'cartA');
    t('carteira A não vê o 136 (403 fora_da_carteira)', fora.status === 403 && fora.j.erro === 'fora_da_carteira');
    t('cadastro fora da carteira 403', (await c('GET', '/api/condominio/136/cadastro', 'cartA')).status === 403);
    t('todas_carteiras vê o 136 (cadastro, sem módulo de ficha)', (await c('GET', '/api/condominio/136/cadastro', 'todas')).status === 200);
    t('todas_carteiras com Configurações escondido não vale', (await c('GET', '/api/condominio/136/cadastro', 'todasEscondido')).status === 403);
    t('carteira apagada no Superlógica: fechado', (await c('GET', '/api/condominio/2/ficha', 'apagada')).status === 403);
    t('falha ao ler carteira: 503 (não libera)', (await c('GET', '/api/condominio/2/cadastro', 'falhaCart')).status === 503);
    t('interno vê tudo', (await c('GET', '/api/condominio/136/ficha', 'internal')).status === 200);
    t('sem login 401', (await c('GET', '/api/condominio/2/ficha', null)).status === 401);
    t('id inválido no caminho 400 na guarda', (await c('GET', '/api/condominio/abc/ficha', 'cartA')).status === 400);
    // Revisão 1, item 1: maiúscula e caminho codificado
    for (const cam of ['/api/Condominio/136/ficha', '/api/condominio/%31%33%36/ficha', '/api/condominio/136/FICHA', '/API/condominio/136/cadastro',
      '/api/%63ondominio/136/ficha', '/api/Cobranca/Condominio/136', '/api/COMPARATIVO/condominio/136']) {
      const r = await c('GET', cam, 'cartA');
      t('bypass ' + cam + ' recusado (' + r.status + ')', r.status === 403 || r.status === 400 || r.status === 404);
    }
    t('caminho %2F recusado 400', (await c('GET', '/api/condominio/2%2F136/ficha', 'cartA')).status === 400);
    t('caminho com codificação inválida 400', (await c('GET', '/api/condominio/%E0%A4%A/ficha', 'cartA')).status === 400);
    for (const cam of ['/api/Atas/gerar', '/api/Despesas/verificar', '/api/PRESTACAO/v13/superlogica']) {
      t('corpo ' + cam + ' fora 403', (await c('POST', cam, 'cartA', { userMessage: 'x', id_superlogica: 136, linhas: [] })).status === 403);
    }
    t('busca com maiúscula exige módulo', (await c('GET', '/api/Unidades/Busca?q=abc', 'todas')).status === 403);
    const bm = await c('GET', '/api/UNIDADES/busca?q=abc', 'cartA');
    t('busca com maiúscula filtra', bm.status === 200 && bm.j.itens.length === 1);
    // Revisão 1, item 2: id presente e inválido no corpo
    for (const v of ['136abc', ' 136', '136 ', ['136'], { a: 136 }, 136.5, '0x88', -1, true]) {
      const r = await c('POST', '/api/prestacao/v13/superlogica', 'cartA', { id_superlogica: v });
      t('prestação id ' + JSON.stringify(v) + ' 400', r.status === 400);
    }
    t('prestação id 2 passa', (await c('POST', '/api/prestacao/v13/superlogica', 'cartA', { id_superlogica: 2 })).status === 200);
    t('prestação id "2" passa', (await c('POST', '/api/prestacao/v13/superlogica', 'cartA', { id_superlogica: '2' })).status === 200);
    // Módulos
    const semMod = await c('GET', '/api/condominio/2/ficha', 'todas');
    t('ficha sem módulo 403 modulo_sem_acesso', semMod.status === 403 && semMod.j.erro === 'modulo_sem_acesso');
    t('comparativo desligado 403', (await c('GET', '/api/comparativo/condominio/2', 'cartA')).status === 403);
    t('comparativo GESTOR 200', (await c('GET', '/api/comparativo/condominio/136', 'gestor')).status === 200);
    t('cobrança com módulo e carteira 200', (await c('GET', '/api/cobranca/condominio/8', 'cartA')).status === 200);
    t('2ª via sem ação 403', (await c('POST', '/api/cobranca/condominio/8/segunda-via', 'cartA', { a: 1 })).status === 403);
    t('2ª via com ação 200', (await c('POST', '/api/cobranca/condominio/136/segunda-via', 'todas', { a: 1 })).status === 200);
    // Corpo JSON
    t('despesas/verificar fora 403', (await c('POST', '/api/despesas/verificar', 'cartA', { id_superlogica: 136, linhas: [] })).status === 403);
    const dv = await c('POST', '/api/despesas/verificar', 'cartA', { id_superlogica: 2, linhas: [1] });
    t('despesas/verificar dentro passa com o corpo inteiro', dv.status === 200 && dv.j.recebido.linhas[0] === 1);
    t('ata sem código passa (a rota decide)', (await c('POST', '/api/atas/gerar', 'cartA', { userMessage: 'x' })).j.recebido === true);
    t('ata de condomínio fora 403', (await c('POST', '/api/atas/gerar', 'cartA', { userMessage: 'x', id_superlogica: '136' })).status === 403);
    t('documentos fora 403', (await c('POST', '/api/condominio/136/documentos', 'cartA', { tipo: 'ata' })).status === 403);
    t('documentos dentro passa corpo', (await c('POST', '/api/condominio/2/documentos', 'cartA', { tipo: 'ata' })).j.corpo.tipo === 'ata');
    // Busca filtrada
    const b = await c('GET', '/api/unidades/busca?q=abc', 'cartA');
    t('busca filtra fora da carteira', b.status === 200 && b.j.itens.length === 1 && b.j.itens[0].id_superlogica === 2 && b.j.quantidade === 1 && b.j.foraCarteira === 1);
    t('busca do GESTOR sem filtro', (await c('GET', '/api/unidades/busca?q=abc', 'gestor')).j.itens.length === 2);
    // Proxy
    const lg = await c('GET', '/api/superlogica/v2/condor/condominios/get?id=-1', 'cartA');
    t('proxy lista geral filtrada (fechada: sem o 136 e sem item sem condomínio)', lg.status === 200 && lg.j.lista.length === 2 && !lg.j.lista.some((x) => x.id_condominio_cond === '136'));
    t('proxy lista geral GESTOR inteira', (await c('GET', '/api/superlogica/v2/condor/condominios/get?id=-1', 'gestor')).j.lista.length === 4);
    t('proxy condominios/get id fora 403', (await c('GET', '/api/superlogica/v2/condor/condominios/get?id=136', 'cartA')).status === 403);
    t('proxy idCondominio fora 403', (await c('GET', '/api/superlogica/v2/condor/despesas/index?idCondominio=136', 'cartA')).status === 403);
    t('proxy idCondominio dentro 200', (await c('GET', '/api/superlogica/v2/condor/despesas/index?idCondominio=8', 'cartA')).status === 200);
    t('proxy ID_CONDOMINIO_COND query fora 403', (await c('POST', '/api/superlogica/v2/condor/unidades/post?ID_CONDOMINIO_COND=136', 'cartA', 'A=1', 'application/x-www-form-urlencoded')).status === 403);
    t('proxy POST corpo fora 403', (await c('POST', '/api/superlogica/v2/condor/despesas/', 'cartA', 'ID_CONDOMINIO_COND=136&X=1', 'application/x-www-form-urlencoded')).status === 403);
    t('proxy POST colchetes fora 403', (await c('POST', '/api/superlogica/v2/condor/processos/', 'cartA', 'ID_CONDOMINIO_COND=2&COBRANCAS%5B0%5D%5BID_CONDOMINIO_COND%5D=136', 'application/x-www-form-urlencoded')).status === 403);
    const pd = await c('POST', '/api/superlogica/v2/condor/despesas/', 'cartA', 'ID_CONDOMINIO_COND=2&X=1', 'application/x-www-form-urlencoded');
    t('proxy POST dentro passa e o corpo chega igual', pd.status === 200 && pd.j.corpo === 'ID_CONDOMINIO_COND=2&X=1');
    t('proxy POST sem condomínio 403', (await c('PUT', '/api/superlogica/v2/condor/despesas/delete', 'cartA', 'ID_PARCELA_PDES=5', 'application/x-www-form-urlencoded')).status === 403);
    t('proxy POST JSON 415', (await c('POST', '/api/superlogica/v2/condor/comunicados/', 'cartA', { ID_CONDOMINIO_COND: 2 })).status === 415);
    // Revisão 1, itens 3, 4 e 7: nomes do PHP, tipo do corpo, caminho
    const form = 'application/x-www-form-urlencoded';
    for (const q of ['ID.CONDOMINIO.COND=136', 'ID%20CONDOMINIO%20COND=136', 'ID%5BCONDOMINIO_COND=136', 'idCondominio%5B%5D=136', 'idCondominio%5B0%5D=136',
      'idCondominio=136abc', 'idCondominio=%20136', 'idCondominio=0x88', 'idCondominios=136', 'CONDOMINIOS%5B0%5D=136', 'idCondominio=2,136', '%20idCondominio=136', 'idCondominio%00x=136']) {
      const r = await c('GET', '/api/superlogica/v2/condor/despesas/index?idCondominio=2&' + q, 'cartA');
      t('proxy GET ' + q + ' recusado (' + r.status + ')', r.status === 403 || r.status === 400);
      const w = await c('POST', '/api/superlogica/v2/condor/despesas/?idCondominio=2', 'cartA', q, form);
      t('proxy POST corpo ' + q + ' recusado (' + w.status + ')', w.status === 403 || w.status === 400);
    }
    t('proxy POST com -1 recusado', (await c('POST', '/api/superlogica/v2/condor/despesas/?idCondominio=2', 'cartA', 'ID_CONDOMINIO_COND=-1', form)).status === 403);
    t('proxy GET -1 fora da lista geral 403', (await c('GET', '/api/superlogica/v2/condor/despesas/index?idCondominio=-1', 'cartA')).status === 403);
    t('proxy GET sem condomínio fora da lista geral 403', (await c('GET', '/api/superlogica/v2/condor/cobranca/index', 'cartA')).status === 403);
    t('proxy GET 2 e -1 juntos 403', (await c('GET', '/api/superlogica/v2/condor/despesas/index?idCondominio=2&id_condominio=-1', 'cartA')).status === 403);
    for (const tipo of ['application/x-www-form-urlencoded; x=json', 'application/x-www-form-urlencoded; charset=UTF-8']) {
      const r = await c('POST', '/api/superlogica/v2/condor/despesas/?idCondominio=2', 'cartA', 'ID_CONDOMINIO_COND=136', tipo);
      t('proxy tipo "' + tipo + '" lido como formulário (403)', r.status === 403);
    }
    for (const tipo of ['multipart/form-data; boundary=B', 'text/plain', 'application/json', 'application/x-www-form-urlencodedx']) {
      t('proxy tipo ' + tipo + ' 415', (await c('POST', '/api/superlogica/v2/condor/despesas/?idCondominio=2', 'cartA', 'a=1', tipo)).status === 415);
    }
    for (const cam of ['/v2/condor//condominios/get?id=136', '/v2/condor/condominios/get/id/136', '/v2/condor/unidades/index.php?idCondominio=2', '/v2/condor/%75nidades/index?idCondominio=2', '/v2/condor/./unidades/index?idCondominio=2', '/v2/condor/a/b/c?idCondominio=2']) {
      const r = await c('GET', '/api/superlogica' + cam, 'cartA');
      t('proxy caminho ' + cam + ' 400', r.status === 400);
    }
    t('proxy caminho com maiúscula aceito', (await c('GET', '/api/superlogica/v2/condor/Despesas/Index?idCondominio=8', 'cartA')).status === 200);
    t('proxy GESTOR caminho livre', (await c('GET', '/api/superlogica/v2/condor/condominios/get/id/136', 'gestor')).status === 200);
    const cont = await c('POST', '/api/superlogica/v2/condor/unidades/post', 'cartA', 'ID_CONDOMINIO_COND=2&contatos%5B0%5D%5BID_CONDOMINIO_COND%5D=', form);
    t('proxy contatos[0][ID_CONDOMINIO_COND] vazio aceito', cont.status === 200);
    t('proxy GESTOR POST fora passa', (await c('POST', '/api/superlogica/v2/condor/despesas/', 'gestor', 'ID_CONDOMINIO_COND=136', 'application/x-www-form-urlencoded')).status === 200);
    t('proxy todas_carteiras passa', (await c('GET', '/api/superlogica/v2/condor/despesas/index?idCondominio=136', 'todas')).status === 200);
    t('proxy PDF sem condomínio bloqueado', (await c('GET', '/api/superlogica/v2/condor/arquivos/pdf', 'cartA')).status === 403);
    const pdf = await c('GET', '/api/superlogica/v2/condor/arquivos/pdf?idCondominio=2', 'cartA');
    t('proxy PDF de condomínio da carteira passa', pdf.status === 200 && /pdf/.test(pdf.ct) && pdf.s.startsWith('%PDF'));
    t('proxy falha de carteira 503', (await c('GET', '/api/superlogica/v2/condor/despesas/index?idCondominio=2', 'falhaCart')).status === 503);
    // /api/carteiras/minha usa o mesmo escopo
    const em = await carteira.escopo({ authMode: 'supabase', user: { sub: 'todas' } });
    t('escopo todas_carteiras = todas', em.todas === true && em.motivo === 'todas_carteiras');
    const ea = await carteira.escopo({ authMode: 'supabase', user: { sub: 'cartA' } });
    t('escopo carteira A = 2 e 8', !ea.todas && ea.ids_superlogica.join(',') === '2,8');
  } finally { srv.close(); }
}

function testesUnitarios() {
  t('idsCondominio colchetes', C.idsCondominio('processos', [['COBRANCAS[0][ID_CONDOMINIO_COND]', '7']]).explicitos[0] === 7);
  t('idsCondominio -1 = todos', C.idsCondominio('unidades/index', [['idCondominio', '-1']]).todos === true);
  t('idsCondominio id só em condominios/', C.idsCondominio('cobranca/index', [['id', '5']]).explicitos.length === 0 && C.idsCondominio('condominios/get', [['id', '5']]).explicitos[0] === 5);
  // Menor 1 da revisão 2: bandeira com "condominio" no nome e valor 0 ou 1 não é código de condomínio.
  const vazioIds = (r) => r.explicitos.length === 0 && r.todos === false && r.invalidos.length === 0;
  t('bandeira somenteCondominiosAtivos=1 ignorada', vazioIds(C.idsCondominio('unidades/index', [['somenteCondominiosAtivos', '1']])));
  t('bandeira somenteCondominiosAtivos=0 não vira todos', vazioIds(C.idsCondominio('unidades/index', [['somenteCondominiosAtivos', '0']])));
  t('bandeiras exibir, com, apenas, mostrar, incluir, fl_ e flag ignoradas', ['exibirCondominiosInativos', 'comCondominio', 'apenasCondominioAtual', 'MOSTRARCONDOMINIOS', 'incluirCondominios', 'FL_CONDOMINIO_ATIVO', 'flagCondominio', 'somente.condominios']
    .every((n) => vazioIds(C.idsCondominio('unidades/index', [[n, '1']])) && vazioIds(C.idsCondominio('unidades/index', [[n, '0']]))));
  t('bandeira com outro valor recusa', ['2', '136', '-1', '', ' 1', '1 ', '01', 'true', '1abc'].every((v) => {
    const r = C.idsCondominio('unidades/index', [['somenteCondominiosAtivos', v]]);
    return r.invalidos.length === 1 && r.explicitos.length === 0 && r.todos === false;
  }));
  t('bandeira com colchetes não é bandeira', C.idsCondominio('unidades/index', [['somente[ID_CONDOMINIO_COND]', '1']]).explicitos[0] === 1
    && C.idsCondominio('unidades/index', [['somenteCondominios[0]', '1']]).invalidos.length === 1
    && C.idsCondominio('unidades/index', [['contatos[0][somenteCondominios]', '1']]).explicitos[0] === 1);
  t('nome sem prefixo de bandeira continua contando', C.idsCondominio('unidades/index', [['idCondominio', '1']]).explicitos[0] === 1
    && C.idsCondominio('unidades/index', [['ID_CONDOMINIO_COND', '0']]).todos === true
    && C.idsCondominio('unidades/index', [['condominioSomente', '1']]).explicitos[0] === 1);
  t('bandeira junto com código conta só o código', (() => {
    const r = C.idsCondominio('unidades/index', [['somenteCondominiosAtivos', '1'], ['idCondominio', '7']]);
    return r.explicitos.length === 1 && r.explicitos[0] === 7 && r.invalidos.length === 0;
  })());
  t('camposDoCorpo multipart', C.camposDoCorpo(Buffer.from('--x\r\nContent-Disposition: form-data; name="ID_CONDOMINIO_COND"\r\n\r\n42\r\n--x--'), 'multipart/form-data; boundary=x')[0][1] === '42');
  t('temModulo GESTOR', C.temModulo({ role: 'GESTOR' }, 'comparativo'));
  t('temModulo sem chave', !C.temModulo({ role: 'GERENTE', permissoes: {} }, 'comparativo'));
  t('temModulo ação', C.temModulo({ role: 'X', permissoes: { cobranca: { visivel: true, acoes: ['ver', 'segunda_via'] } } }, 'cobranca', 'segunda_via'));
  const f = C.filtrarJson({ a: [{ id_condominio_cond: '1' }, { id_condominio_cond: '2' }] }, new Set([2]));
  t('filtrarJson remove fora', f.valor.a.length === 1 && f.removidos === 1);
  t('filtrarJson objeto único fora bloqueia', C.filtrarJson({ id_condominio_cond: '9' }, new Set([2])).bloqueado === true);
  // Revisão 1, item 6: falha fechada e sem campos irmãos
  const an = C.filtrarJson([{ unidade: { id_condominio_cond: 136 }, nome: 'vaza' }, { unidade: { id_condominio_cond: 2 }, nome: 'fica' }], new Set([2]));
  t('filtrarJson aninhado fora tira o item inteiro', an.valor.length === 1 && an.valor[0].nome === 'fica');
  t('filtrarJson valor estranho conta como fora', C.filtrarJson([{ ID_CONDOMINIO_COND: '136abc' }, { Id_Condominio_Cond: '2' }], new Set([2])).valor.length === 1);
  t('filtrarJson estrito tira item sem condomínio', C.filtrarJson([{ x: 1 }, { id_condominio_cond: '2' }], new Set([2]), { estrito: true }).valor.length === 1);
  t('filtrarJson não estrito mantém item sem condomínio', C.filtrarJson([{ x: 1 }, { id_condominio_cond: '2' }], new Set([2])).valor.length === 2);
  t('filtrarJson objeto com filho fora bloqueia', C.filtrarJson({ a: { id_condominio_cond: 9 }, b: 1 }, new Set([2])).bloqueado === true);
  t('partesPhp ponto e espaço', C.partesPhp('ID.CONDOMINIO COND').join('|') === 'id_condominio_cond');
  t('partesPhp colchete aberto', C.partesPhp('ID[CONDOMINIO_COND').join('|') === 'id_condominio_cond');
  t('partesPhp colchetes', C.partesPhp('contatos[0][ID_X]').join('|') === 'contatos|0|id_x');
  t('caminhoDecodificado', C.caminhoDecodificado('/condominio/%31%33%36/ficha') === '/condominio/136/ficha' && C.caminhoDecodificado('/a/%2F') === null);
  t('rotaDoProxy', C.rotaDoProxy('/v2/condor/despesas/') === 'despesas' && C.rotaDoProxy('/v2/condor//x') === null);
  // aoNegar e esquecer
  const negados = [];
  const cn = C.criarCarteira({ lerPerfil: async (id) => PERFIS[id] || null, lerCarteirasPerfis: async (id) => ({ [id]: CARTEIRAS[id] || [] }),
    semColuna: () => false, gruposCarteiras: async () => GRUPOS, ativo: () => true, express, aoNegar: (req, motivo, id) => negados.push(motivo + ':' + id) });
  const resFalso = () => ({ status() { return this; }, json() { return this; } });
  pendentes.push(cn.exigir({ authMode: 'supabase', user: { sub: 'cartA' } }, resFalso(), '136').then((r) => {
    t('exigir fora devolve false e chama aoNegar', r === false && negados[0] === 'fora_da_carteira:136');
    t('esquecer e definirAoNegar existem', typeof cn.esquecer === 'function' && typeof cn.definirAoNegar === 'function');
  }));
  t('regraDa relatorio = ficha', C.regraDa('GET', '/condominio/5/relatorio-mensal').regra.modulo === 'ficha_condominio');
  t('regraDa alertas sem módulo', !C.regraDa('GET', '/condominio/5/alertas').regra.modulo);
  t('regraDa 2ª via ação', C.regraDa('POST', '/cobranca/condominio/5/segunda-via').regra.acao === 'segunda_via');

  // Água e luz fora do alerta de nota fiscal
  const conc = (nome, ...contas) => A.ehContaConcessionaria({ st_nome_con: nome, contas });
  t('ESCELSA energia fora', conc('ESCELSA', 'Energia'));
  t('EDP fora', conc('EDP ESPIRITO SANTO DISTRIBUICAO DE ENERGIA S.A.', 'Energia'));
  t('CESAN fora', conc('COMPANHIA ESPIRITO SANTENSE DE SANEAMENTO CESAN', 'Água-Esgoto'));
  t('conta Esgoto com fornecedor qualquer fora', conc('PREFEITURA X', 'Esgoto'));
  t('Energia Solar (financiamento) continua', !conc('AYMORE CREDITO, FINANCIAMENTO E INVESTIMENTO S.A.', 'Energia Solar'));
  t('Manutenção Água-Poço continua', !conc('B E FILHOS MANUTENÇÕES LTDA', 'Contrato Manutenção e Análise de Água-Poço'));
  t('Material de Bomba de Água continua', !conc('HIDTEC', 'Material de Bomba de Água'));
  t('Serviço Elétrico continua', !conc('SUERNAN FRANCISCO DA SILVA', 'Serviço Elétrico'));
  t('Caixa d água continua', !conc('HABIT', "Serviço Manutenção de Caixa d água"));
  t('Gás continua', !conc('SUPERGASBRAS ENERGIA LTDA', 'Gás'));
  t('saneamento ambiental continua', !conc('XYZ SANEAMENTO AMBIENTAL LTDA', 'Serviço de Desentupimento'));
  t('conta mista continua', !conc('FORNECEDOR', 'Energia', 'Material Elétrico'));
  const h = new Date(2026, 9, 21);
  const pagas = [
    { id: '1', dt_liquidacao_pdes: '10/05/2026', vl_valor_pdes: '500', st_nome_con: 'ESCELSA', conta: 'Energia', contas: ['Energia'], nf: false },
    { id: '2', dt_liquidacao_pdes: '10/06/2026', vl_valor_pdes: '300', st_nome_con: 'COMPANHIA ESPIRITO SANTENSE DE SANEAMENTO CESAN', conta: 'Água-Esgoto', contas: ['Água-Esgoto'], nf: false },
    { id: '3', dt_liquidacao_pdes: '10/07/2026', vl_valor_pdes: '200', st_nome_con: 'HIDTEC', conta: 'Material de Bomba de Água', contas: ['Material de Bomba de Água'], nf: false },
  ];
  const nf = A.alertasNotaFiscal(pagas, h);
  t('nota fiscal: só a Hidtec fica', nf.length === 1 && nf[0].detalhe.quantidade === 1 && nf[0].detalhe.itens[0].fornecedor === 'HIDTEC');

  // Prazos do banco no cálculo das manutenções
  const hist = [{ id: '9', dt_liquidacao_pdes: '06/01/2026', vl_valor_pdes: '100', st_nome_con: 'DEDETIZA', texto: 'dedetizacao', contas: [] }];
  t('dedetização 142 dias: sem alerta com 180', A.alertasManutencao(hist, h, P.PADRAO).length === 0);
  const m = A.alertasManutencao(hist, h, Object.assign({}, P.PADRAO, { dedetizacao: 90 }));
  t('dedetização 142 dias: alerta com prazo 90 do banco', m.length === 1 && m[0].detalhe.prazo_referencia_dias === 90);
  t('sem prazos usa o padrão do código', A.alertasManutencao(hist, h).length === 0);
  t('validar prazos ok', !P.validar({ prazos: { dedetizacao: 180, extintores: 365, caixa_dagua: 180, elevador: 45 } }).erro);
  t('validar prazos fora do limite', !!P.validar({ prazos: { dedetizacao: 3, extintores: 365, caixa_dagua: 180, elevador: 45 } }).erro);
  t('validar prazos faltando', !!P.validar({ prazos: { dedetizacao: 180 } }).erro);
  t('validar tipo desconhecido', !!P.validar({ prazos: { dedetizacao: 180, extintores: 365, caixa_dagua: 180, elevador: 45, outro: 30 } }).erro);
  t('normalizar ignora inválido', P.normalizar({ elevador: 'x', extintores: 300 }).elevador === 45 && P.normalizar({ extintores: 300 }).extintores === 300);

  // Nome do tipo de leitura
  t('nomeDaConta Gás', A.nomeDaConta(' Gás') === 'Gás');
  t('nomeDaConta Água Individual', A.nomeDaConta(' Água Individual') === 'Água');
  t('nomeDaConta Energia', A.nomeDaConta('Energia Individual') === 'Energia');
}

async function testeConsumo() {
  const un = (tipo, recb, rec, varp) => ({ id_unidade_uni: '4', st_unidade_uni: '001', st_bloco_uni: ' ',
    leituras: { mes_atual: { nm_ano_rsp: '2026', nm_mes_rsp: '10', receita: rec ? [{ id_receita_rec: rec, receita_apropriacao: recb ? [{ id_recebimento_recb: recb }] : [] }] : [] },
      consumo: { consumo_atual: '9', media: '2', variacao: String(varp), meses: '3', status: '1' } } });
  let chamadasCob = 0;
  const cli = { get: async (rota, p) => {
    if (rota === 'consumo/index') return p.tipoLeitura === 1 ? [un(1, '100', '501', 350)] : [un(2, null, '502', 350)];
    if (rota === 'cobranca/index') { chamadasCob++; return [{ receitas: [{ id_receita_rec: '501', st_descricao_cont: ' Gás' }] }]; }
    return [];
  } };
  const out = await A.alertasConsumo(cli, 77, new Date(2026, 9, 21));
  const g = out.find((a) => a.detalhe.tipo_leitura === 1), w = out.find((a) => a.detalhe.tipo_leitura === 2);
  t('consumo tipo 1 vira Gás', g && g.titulo === 'Consumo de gás muito acima da média na unidade 001' && g.detalhe.leitura === 'Gás');
  t('consumo sem receita para conferir fica "consumo (tipo 2)"', w && w.detalhe.leitura === 'consumo (tipo 2)' && /\(tipo 2\)$/.test(w.titulo));
  t('chave do alerta não mudou', g && g.chave === 'consumo:1:4:202610');
  await A.alertasConsumo(cli, 77, new Date(2026, 9, 21));
  t('nome em cache (uma leitura só)', chamadasCob === 1);
}

(async () => {
  testesUnitarios();
  await Promise.all(pendentes);
  await testesCarteira();
  await testeConsumo();
  console.log(ok + ' ok, ' + falha + ' falha(s)');
  process.exit(falha ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
