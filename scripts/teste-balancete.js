// T41: testes do balancete digital (conferência do 900A e rotas), sem Superlógica e sem banco.
// Uso: NODE_PATH=... node scripts/teste-balancete.js [pasta com <id>.jsonl lidos de PDFs reais, opcional]
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const B = require('../financeiro/balancete');
let ok = 0, falha = 0;
const t = (nome, cond) => { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } };
const pend = [];
const P = (p) => pend.push(p.catch((e) => t('promessa sem exceção: ' + e.message, false)));

// ── 1. funções puras ──
t('competencia válida', B.competencia('2026-09').rotulo === 'Set/2026');
t('competencia inválida', !B.competencia('2026-13') && !B.competencia('09/2026') && !B.competencia(''));
t('somar meses', B.somarMeses(B.competencia('2026-09'), -11).chave === '2025-10');
t('meses citados', JSON.stringify(B.mesesCitados('Set/2026 (01/09/2026 até 30/09/2026)')) === JSON.stringify(['2026-09', '2026-09', '2026-09']));
t('mês por extenso', B.mesesCitados('Balancete: Setembro de 2026')[0] === '2026-09');
t('competência do boleto ignorada', B.mesesCitados('Posição em 30/09/2026; Com competência em Out/2026;').every((m) => m === '2026-09'));

const pg = (n, linhas, extra) => Object.assign({ pagina: n, texto: linhas.join('\n'), imagens: 1, desenhos: 20 }, extra || {});
const cab = (cod, titulo, filtro, n, corpo) => pg(n, ['W' + cod + ' TESTE (94)', titulo, filtro].concat(corpo || ['linha de conteúdo do relatório']).concat([n + ' de 99']));
const capa = (titulo, n, mes) => pg(n, ['TESTE', titulo, (mes || 'Set/2026') + ' (01/09/2026 até 30/09/2026)']);
const paginas = [
  cab('035F', 'Prestação de contas', 'Carta de prestação de contas', 1, ['Atenciosamente,', 'Administradora Teste']),
  capa('BALANCETE RESUMIDO', 2),
  cab('011A', 'Demonstrativo', 'Comparativo de Out/2025 com os próximos 11 meses', 3),
  cab('037F', 'Distribuição das Receitas', 'Posição em Out/2026', 4),
  cab('015G', 'Receitas x despesas', 'Com posição final em Set/2026; Listando 12 meses', 5),
  capa('DESPESAS', 6),
  cab('061A', 'Comprovantes de despesas', 'Credt. em Set/2026;Parcela 111', 7, ['Condomínio: TESTE', 'Fornecedor X 100,00']),
  pg(8, ['W061A TESTE (94)', 'Comprovantes de despesas', 'Credt. em Set/2026;Parcela 111', '8 de 99'], { imagens: 0, desenhos: 13 }),
  cab('061A', 'Comprovantes de despesas', 'Credt. em Set/2026;Parcela 222', 9),
  cab('061A', 'Comprovantes de despesas', 'Credt. em Set/2026;Parcela 111', 10),
  pg(11, ['texto %administradora.nome% solto']),
];
const esperados = [{ codigo: '035F' }, { codigo: '035C', titulo: 'BALANCETE RESUMIDO' }, { codigo: '011A' }, { codigo: '037F' }, { codigo: '037E', rotulo: '037E faltando' }, { codigo: '061A' }];
const despesas = [{ id_parcela: '111', fornecedor: 'X', valor: 100 }, { id_parcela: '333', fornecedor: 'Y', valor: 50, arquivos: 1 }];
const r = B.conferir(paginas, { competencia: '2026-09', esperados, despesas });
t('037F fora do mês', r.mes_fora.length === 1 && r.mes_fora[0].codigo === '037F' && r.mes_fora[0].achado === 'Out/2026');
t('011A certo não acusa', !r.mes_fora.some((m) => m.codigo === '011A'));
t('item faltando', r.itens.faltando.length === 1 && r.itens.faltando[0] === '037E faltando');
t('paga sem comprovante', r.comprovantes.sem_comprovante_no_pdf.length === 1 && r.comprovantes.sem_comprovante_no_pdf[0].parcela === '333');
t('no PDF sem pagamento no mês', r.comprovantes.no_pdf_sem_liquidacao_no_mes.length === 1 && r.comprovantes.no_pdf_sem_liquidacao_no_mes[0].parcela === '222');
t('parcela repetida', r.comprovantes.parcela_repetida.length === 1 && r.comprovantes.parcela_repetida[0].parcela === '111');
t('anexo sem imagem', r.paginas_em_branco.some((p) => p.pagina === 8));
t('campo não preenchido', r.campos_nao_preenchidos.length === 1 && r.campos_nao_preenchidos[0].pagina === 11);
t('não está ok', r.ok === false && r.problemas >= 7);
const r011 = B.conferir([cab('011A', 'Demonstrativo', 'Comparativo de Set/2026 com os próximos 11 meses', 1)], { competencia: '2026-09', esperados: [] });
t('011A para frente acusa', r011.mes_fora.length === 1 && r011.mes_fora[0].esperado === 'Out/2025 a Set/2026');
const rCapa = B.conferir([capa('GRÃ•FICOS', 1)], { competencia: '2026-09', esperados: [{ codigo: '035C', titulo: 'GRÁFICOS' }] });
t('capa com acento quebrado casa', rCapa.itens.faltando.length === 0);
const rLimpo = B.conferir([cab('037E', 'D', 'Posição em Set/2026', 1)], { competencia: '2026-09', esperados: [{ codigo: '037E' }] });
t('tudo certo fica ok', rLimpo.ok === true && rLimpo.problemas === 0);
const dup = 'x'.repeat(400);
const rDup = B.conferir([pg(1, [dup, '1 de 2']), pg(2, [dup, '2 de 2'])], { competencia: '2026-09', esperados: [] });
t('página repetida', rDup.paginas_repetidas.length === 1 && rDup.paginas_repetidas[0].igual_a === 1);

// ── 1b. caminho C: mês da seleção NOVA ──
const S = require('../financeiro/balancete-selecao');
const H = 'https://x.superlogica.net/clients/condor/relatorios/id/';
const U = {
  f: H + '037F?PERIODO=0&PERIODO_INICIO=&PERIODO_FIM=&ORIENTACAO=0&salvar=Salvar',
  b: H + '061B?MES=0&MES_INICIO=&MES_FIM=&DOCUMENTOS%5B0%5D%5BETIQUETA%5D=Extrato&COM_CAPA=0',
  a: H + '061A?PERIODO=0&PERIODO_INICIO=&PERIODO_FIM=&CAPAS%5B0%5D%5BID_MODELO_MOH%5D=90',
  o: H + '011A?REALIZADO=0&REALIZADO_INICIO=&REALIZADO_FIM=&COMPARAR_COM_OUTROMES=1&COMPARARCOMOUTROMES=diversosmeses&COMPARARCOMOUTROMES_INICIO=&COMPARARCOMOUTROMES_QDT_MESES_ACOMPARAR=11&COM_PORCENTAGEM=1',
  c: H + '035C?PERIODO=0&TITULO=EXTRATO',
  p: H + '003A?POSICAOEM=4&POSICAOEM_DATA=&VENCIMENTO=0&VENCIMENTO_INICIO=',
};
const dec = (u) => decodeURIComponent(u);
const m9 = { ano: 2026, mes: 9 }, m1 = { ano: 2027, mes: 1 };
t('037F vai para o mês', dec(S.urlParaMes(U.f, m9)).includes('PERIODO=selecionar&PERIODO_INICIO=09/01/2026&PERIODO_FIM=&ORIENTACAO=0'));
t('061B vai para o mês', dec(S.urlParaMes(U.b, m9)).includes('MES=selecionar&MES_INICIO=09/01/2026&MES_FIM=&DOCUMENTOS[0][ETIQUETA]=Extrato'));
t('061A do dia 1 ao último', dec(S.urlParaMes(U.a, { ano: 2026, mes: 2 })).includes('PERIODO_INICIO=02/01/2026&PERIODO_FIM=02/28/2026'));
t('011A 11 meses antes', dec(S.urlParaMes(U.o, m9)).includes('REALIZADO=selecionar&REALIZADO_INICIO=10/01/2025') && dec(S.urlParaMes(U.o, m1)).includes('REALIZADO_INICIO=02/01/2026'));
t('003A posição no último dia', dec(S.urlParaMes(U.p, m9)).includes('POSICAOEM=selecionar&POSICAOEM_DATA=09/30/2026&VENCIMENTO=0'));
t('capa não muda', S.urlParaMes(U.c, m9) === U.c);
t('idempotente', S.urlParaMes(S.urlParaMes(U.f, m9), m9) === S.urlParaMes(U.f, m9));
let semParam = false; try { S.urlParaMes(H + '037F?ORIENTACAO=0', m9); } catch (e) { semParam = e.codigo === 'item_inesperado'; }
t('item sem o parâmetro recusa', semParam);
function selFalsa(titulo, urls) { return [{ id_relatorioselecao_rlsu: '1', id_usuario_usu: '89', st_tituloselecao_rlsu: titulo, items: urls.map((u, i) => ({ id_relatoriousuarioselecao_rlsui: String(i + 1), nm_ordenacao_rlsui: String(i), st_url_rlsui: u, st_texto_rlsui: i === 0 ? '<p>carta</p>' : '', st_titulotexto_rlsui: 'T' + i })) }]; }
function clienteFalso(titulo, gravar) {
  let atual = selFalsa(titulo, [U.c, U.f, U.b, U.a, U.o]);
  return { get: async () => atual, gravou: () => atual, postar: async (cred, cam, corpo) => {
    const p = new URLSearchParams(corpo); const n = atual[0].items.map((it, i) => Object.assign({}, it, { st_url_rlsui: gravar === 'errado' && i === 0 ? it.st_url_rlsui + '&X=1' : p.get('RELATORIO_SELECAO[' + i + '][ST_URL_RLSUI]') }));
    atual = [Object.assign({}, atual[0], { items: n })]; return { http: 200, json: { status: '200', data: { selecao: '1' } } }; } };
}
const cf = clienteFalso('Prestação de contas na Web NOVA teste Hub');
P(S.ajustarSelecaoParaMes({ cred: {}, cliente: cf, idUsuario: 89, idSelecao: 1, competencia: '2026-09', postarFn: cf.postar }).then((r) => {
  t('ajuste grava 4 itens', r.mudou && r.itens_alterados === 4);
  t('ajuste mantém textos e capa', cf.gravou()[0].items[0].st_url_rlsui === U.c && cf.gravou()[0].items[0].st_texto_rlsui === '<p>carta</p>');
  return S.ajustarSelecaoParaMes({ cred: {}, cliente: cf, idUsuario: 89, idSelecao: 1, competencia: '2026-09', postarFn: async () => { throw new Error('não devia gravar'); } });
}).then((r) => t('no mesmo mês não grava de novo', r.mudou === false)));
const cw = clienteFalso('Prestação de contas na Web');
P(S.ajustarSelecaoParaMes({ cred: {}, cliente: cw, idUsuario: 89, idSelecao: 1, competencia: '2026-09', postarFn: cw.postar }).then(() => t('seleção da equipe recusa', false), (e) => t('seleção da equipe recusa', e.message === 'selecao_nao_permitida')));
const ce = clienteFalso('NOVA teste Hub', 'errado');
P(S.ajustarSelecaoParaMes({ cred: {}, cliente: ce, idUsuario: 89, idSelecao: 1, competencia: '2026-09', postarFn: ce.postar }).then(() => t('gravação diferente acusa', false), (e) => t('gravação diferente acusa', e.codigo === 'gravacao_diferente')));

// ── 2. liberação da geração ──
delete process.env.BALANCETE_GERACAO_LIBERADA;
t('padrão só 94 e 167', [...B.liberadosGeracao()].sort().join(',') === '167,94');
process.env.BALANCETE_GERACAO_LIBERADA = '94, 160 ,abc,136';
t('lista com excluído e lixo', [...B.liberadosGeracao()].sort().join(',') === '136,94');
process.env.BALANCETE_GERACAO_LIBERADA = '';
t('vazio volta ao padrão', B.liberadosGeracao().has('94') && B.liberadosGeracao().size === 2);
delete process.env.BALANCETE_GERACAO_LIBERADA;
t('seleção padrão é a NOVA', B.selecaoGeracao().ID_RELATORIOSELECAO_RLSU === '1');
process.env.BALANCETE_SELECAO = 'condominio:4';
t('seleção do condomínio', B.selecaoGeracao().ID_SELECAO_RLS === '4' && !B.selecaoGeracao().ID_RELATORIOSELECAO_RLSU);
process.env.BALANCETE_SELECAO = 'qualquer coisa';
t('seleção inválida volta à NOVA', B.selecaoGeracao().ID_RELATORIOSELECAO_RLSU === '1');
delete process.env.BALANCETE_SELECAO;
P(B.pedirGeracao({ base: 'https://api.superlogica.net', appToken: 'x', accessToken: 'y' }, '136', '2026-09').then(() => t('não liberado recusa', false), (e) => t('não liberado recusa', e.codigo === 'nao_liberado')));
P(B.pedirGeracao({ base: 'https://api.superlogica.net', appToken: 'x', accessToken: 'y' }, '94', B.mesAtualBrasilia()).then(() => t('mês aberto recusa', false), (e) => t('mês aberto recusa', e.codigo === 'mes_aberto')));
t('palavras que não são mês', B.mesesCitados('mais de 2026; setor de 2025; outros/2024').length === 0);
t('ano antigo não quebra', B.conferir([pg(1, ['W011A T (1)', 'D', 'Comparativo de Mar/2014 com os próximos 11 meses', 'x'])], { competencia: '2015-03', esperados: [] }).mes_fora.length === 1);
t('página não lida acusa', B.conferir([pg(1, ['W037E T (1)', 'D', 'Posição em Set/2026', 'x'], { erro: true })], { competencia: '2026-09', esperados: [] }).paginas_em_branco.length === 1);
t('sem seleção conhecida não confere itens', B.conferir([], { competencia: '2026-09' }).itens.nao_conferido !== undefined);
P(B.baixarImpressao({ base: 'https://example.com', appToken: 'x', accessToken: 'y' }, '1', '/tmp/nao-usar.pdf').then(() => t('download só no Superlógica', false), (e) => t('download só no Superlógica', e.message === 'destino_nao_permitido')));
P(B.baixarImpressao({ base: 'https://api.superlogica.net', appToken: 'x', accessToken: 'y' }, '1;2', '/tmp/nao-usar.pdf').then(() => t('download id inválido', false), (e) => t('download id inválido', e.codigo === 'id')));
const quebrado = path.join(require('os').tmpdir(), 'balancete-teste-quebrado.pdf');
fs.writeFileSync(quebrado, '%PDF-1.3 isto não é um pdf');
P(B.lerPdf(quebrado).then(() => t('PDF quebrado recusa', false), (e) => t('PDF quebrado recusa', e.codigo === 'leitura')).finally(() => fs.unlinkSync(quebrado)));
const clienteSel = { get: async (c, q) => (c === 'relatoriosselecao/index' && q.ID_SELECAO_RLS === '4' ? [{ nm_ordenacao_rls: '1', st_url_rls: 'https://x.superlogica.net/clients/condor/relatorios/id/035C?TITULO=EXTRATO&MODELO=1' }, { nm_ordenacao_rls: '0', st_url_rls: 'https://x.superlogica.net/clients/condor/relatorios/id/035F?POSICAOEM=0' }] : []) };
P(B.itensEsperados(clienteSel, '94', '900A - Prestação de contas na Web').then((l) => t('itens da seleção do condomínio', l && l.length === 2 && l[0].codigo === '035F' && l[1].titulo === 'EXTRATO')));
P(B.itensEsperados(clienteSel, '94', '900A - Prestação de contas na Web NOVA teste Hub').then((l) => t('itens da seleção NOVA', l === B.ITENS_NOVA)));
P(B.itensEsperados(clienteSel, '94', '900A - Outra seleção qualquer').then((l) => t('seleção desconhecida', l === null)));
t('nunca publica: sem impressoes/post nem email no módulo', !/impressoes\/post|impressoes\/email|FL_COMPARTILHAR/.test(fs.readFileSync(path.join(__dirname, '..', 'financeiro', 'balancete.js'), 'utf8').replace(/\/\/.*$/gm, '')));

// ── 3. rotas com dublês (sem Superlógica) ──
const express = require('express');
const { criarRotasBalancete } = require('../financeiro/balancete-rotas');
const app = express();
let papel = 'GESTOR', financeiro = true, escrita = true, chamadasGerar = 0, iniciou = 0;
const requireAuth = (req, res, next) => { req.user = { sub: 'u1', app_metadata: { role: papel } }; next(); };
const requireGestor = (req, res, next) => (papel === 'GESTOR' ? next() : res.status(403).json({ erro: 'acesso_negado' }));
const eventos = [];
B.listarImpressoes = async () => [{ id: '647731', titulo: '900A', da_competencia: true }];
B.pedirGeracao = async () => { chamadasGerar++; return { pedido: true, http: 504, id_impressao: '', aguardar: true }; };
const estados = new Map();
B.situacaoConferencia = (c, m, id) => estados.get(c + '|' + m + '|' + id) || null;
B.iniciarConferencia = (o) => { iniciou++; const s = { estado: 'rodando', inicio: Date.now() }; estados.set(o.idCondominio + '|' + o.competencia + '|' + o.idImpressao, s); return s; };
criarRotasBalancete(app, {
  requireAuth, requireGestor, express, idValido: (v) => /^[1-9][0-9]{0,8}$/.test(String(v || '')),
  exigirFinanceiro: async (req, res) => { if (financeiro) return true; res.status(403).json({ erro: 'modulo_sem_acesso' }); return false; },
  exigirLeituraSuperlogica: async () => true, exigirEscritaSuperlogica: async (req, res) => { if (escrita) return true; res.status(403).json({ erro: 'acesso_negado' }); return false; }, cred: () => ({}), cliente: () => ({}), auditar: (req, acao) => eventos.push(acao),
});
const srv = app.listen(0, async () => {
  const porta = srv.address().port;
  const pedir = (metodo, url, corpo) => new Promise((ok) => {
    const req = http.request({ hostname: '127.0.0.1', port: porta, path: url, method: metodo, headers: { 'content-type': 'application/json' } }, (res) => {
      const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(p).toString()); } catch (e) { /* vazio */ } ok({ st: res.statusCode, j }); });
    });
    req.end(corpo ? JSON.stringify(corpo) : undefined);
  });
  try {
    t('lista ok', (await pedir('GET', '/api/financeiro/balancete/94/impressoes?competencia=2026-09')).st === 200);
    t('lista diz liberado', (await pedir('GET', '/api/financeiro/balancete/94/impressoes?competencia=2026-09')).j.geracao_liberada === true);
    t('id inválido 400', (await pedir('GET', '/api/financeiro/balancete/abc/impressoes?competencia=2026-09')).st === 400);
    t('id excluído 400', (await pedir('GET', '/api/financeiro/balancete/160/impressoes?competencia=2026-09')).st === 400);
    t('mês futuro 400', (await pedir('GET', '/api/financeiro/balancete/94/impressoes?competencia=2099-01')).st === 400);
    t('mês ruim 400', (await pedir('GET', '/api/financeiro/balancete/94/impressoes?competencia=09-2026')).st === 400);
    papel = 'OPERACIONAL';
    t('não GESTOR 403 lista', (await pedir('GET', '/api/financeiro/balancete/94/impressoes?competencia=2026-09')).st === 403);
    t('não GESTOR 403 gerar', (await pedir('POST', '/api/financeiro/balancete/94/gerar', { competencia: '2026-09' })).st === 403);
    papel = 'GESTOR'; financeiro = false;
    t('sem módulo financeiro 403', (await pedir('GET', '/api/financeiro/balancete/94/conferencia?competencia=2026-09&impressao=647731')).st === 403);
    financeiro = true;
    t('impressão inválida 400', (await pedir('GET', '/api/financeiro/balancete/94/conferencia?competencia=2026-09&impressao=1;2')).st === 400);
    const c1 = await pedir('GET', '/api/financeiro/balancete/94/conferencia?competencia=2026-09&impressao=647731');
    t('conferência começa 202', c1.st === 202 && iniciou === 1 && eventos.includes('balancete_conferencia'));
    t('conferência não duplica', (await pedir('GET', '/api/financeiro/balancete/94/conferencia?competencia=2026-09&impressao=647731')).st === 202 && iniciou === 1);
    const e94 = estados.get('94|2026-09|647731');
    e94.estado = 'pronto'; e94.fim = Date.now(); e94.resultado = { ok: true };
    const outro = await pedir('GET', '/api/financeiro/balancete/167/conferencia?competencia=2026-09&impressao=647731');
    t('outro condomínio não recebe o resultado', outro.st === 202 && !outro.j.resultado && iniciou === 2);
    const c2 = await pedir('GET', '/api/financeiro/balancete/94/conferencia?competencia=2026-09&impressao=647731');
    t('conferência pronta 200', c2.st === 200 && c2.j.resultado.ok === true);
    t('gerar não liberado 403', (await pedir('POST', '/api/financeiro/balancete/136/gerar', { competencia: '2026-09' })).st === 403 && chamadasGerar === 0);
    escrita = false;
    t('gerar sem escrita 403', (await pedir('POST', '/api/financeiro/balancete/94/gerar', { competencia: '2026-09' })).st === 403 && chamadasGerar === 0);
    escrita = true;
    const g = await pedir('POST', '/api/financeiro/balancete/94/gerar', { competencia: '2026-09' });
    t('gerar liberado 202 e audita', g.st === 202 && chamadasGerar === 1 && eventos.includes('balancete_gerar'));
    t('gerar com mês ruim 400', (await pedir('POST', '/api/financeiro/balancete/94/gerar', { competencia: 'x' })).st === 400 && chamadasGerar === 1);
    t('GET em gerar não existe', (await pedir('GET', '/api/financeiro/balancete/94/gerar')).st === 404);
  } catch (e) { t('rotas sem exceção: ' + e.message, false); }
  srv.close();
  // ── 4. PDFs reais já lidos (opcional) ──
  const pasta = process.argv[2];
  if (pasta && fs.existsSync(path.join(pasta, '647731.jsonl'))) {
    const real = require('../financeiro/balancete.js');
    const ler = (f) => fs.readFileSync(path.join(pasta, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.pagina);
    const novo = real.conferir(ler('647731.jsonl'), { competencia: '2026-09' });
    t('PDF corrigido: mês certo e 35 itens', novo.mes_fora.length === 0 && novo.itens.faltando.length === 0 && novo.comprovantes.parcelas_no_pdf === 90);
    if (fs.existsSync(path.join(pasta, '647500.jsonl'))) {
      const velho = real.conferir(ler('647500.jsonl'), { competencia: '2026-09' });
      t('PDF da T28: acusa 011A, 037F, 037E e 061B', ['011A', '037F', '037E', '061B'].every((c) => velho.mes_fora.some((m) => m.codigo === c)));
    }
  }
  await Promise.all(pend);
  console.log((falha ? 'FALHOU' : 'OK') + ': ' + ok + ' certos, ' + falha + ' falhas');
  process.exit(falha ? 1 : 0);
});
