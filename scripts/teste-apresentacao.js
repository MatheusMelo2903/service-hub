// Teste da Apresentação de assembleia (servico/apresentacao.js), sem chamada real de
// processamento e sem o motor real: express com dublês, o motor é um servidor local falso.
// Cobre: permissão negada, limites, ids de documentos e fotos, descarte de logo repetido e
// imagem pequena, conferência das imagens só nas candidatas (no máximo 30, cada uma uma vez),
// texto das imagens no documento, conteúdo da chamada principal só com texto, pauta tirada do
// edital, conferência do roteiro em código, repetição quando o JSON vem quebrado, repasse ao
// motor (com a logo) e status do job só para o dono. Também a visibilidade do item no menu.
// Uso: node scripts/teste-apresentacao.js
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const A = require('../servico/apresentacao');
const { extrairJson } = require('../servico/modelo');
const modelos = require('../servico/modelos');
const custo = require('../servico/custo');

let ok = 0, falha = 0;
const escrever = console.log; // os registros do servidor são capturados durante as rotas
const t = (nome, cond) => { if (cond) ok++; else { falha++; escrever('FALHOU: ' + nome); } };

// Imagens de mentira: começo de JPEG e de PDF válidos em base64 (o conteúdo não importa aqui).
const jpeg = (s) => '/9j/' + Buffer.from('foto ' + s + ' '.repeat(40)).toString('base64').replace(/=+$/, '').slice(0, 60) + 'AAAA';
const pdf = (s) => Buffer.from('%PDF-1.4 ' + s + '      ').toString('base64');
const png = 'iVBORw0KGgo' + 'A'.repeat(21);

// ── 1. Pauta tirada do edital (sem chamada) ──
const EDITAL = 'EDITAL DE CONVOCAÇÃO ASSEMBLEIA GERAL EXTRAORDINÁRIA. Ficam convocados os condôminos do Residencial Buritis para a AGE do dia 16/10/2024, às 19h30, no salão de festas, para deliberar sobre a seguinte ORDEM DO DIA: 1) Apresentação e aprovação dos orçamentos para reforma do playground; 2) Aprovação de taxa extra para custeio da obra; 3) Assuntos gerais. Serra/ES, 01 de outubro de 2024. A Síndica';
t('pauta: três itens em ordem', JSON.stringify(A.extrairPauta(EDITAL)) === JSON.stringify(['Apresentação e aprovação dos orçamentos para reforma do playground', 'Aprovação de taxa extra para custeio da obra', 'Assuntos gerais']));
const p2 = A.extrairPauta('PAUTA:\n1. Prestação de contas do exercício 2023;\n2. Eleição de síndico para o mandato 2024/2025.\n\nObservação: procurações com firma reconhecida.');
t('pauta: bloco PAUTA com quebra de linha e observação fora', p2.length === 2 && p2[1] === 'Eleição de síndico para o mandato 2024/2025');
const p3 = A.extrairPauta('Pauta: 01 - Leitura da ata anterior; 02 - Obras na fachada no valor de R$ 150.000,00 em 10 parcelas. Atenciosamente, Administração');
t('pauta: numeração 01, 02 com hífen e valor com ponto', p3.length === 2 && p3[1] === 'Obras na fachada no valor de R$ 150.000,00 em 10 parcelas');
t('pauta: sem lista numerada devolve vazio', A.extrairPauta('Convocamos para a assembleia, sem lista.').length === 0);
t('pauta: números soltos antes do item 1 não contam', A.extrairPauta('Assembleia do dia 16, às 19h30. Ordem do dia: 1. Pintura da fachada; 2. Assuntos gerais.').length === 2);

// ── 2. Conferência do roteiro em código ──
const fotosOk = ['f1', 'f2', 'f3'];
const docsOk = [{ id: 'd1', pdf: true, paginas: 3 }, { id: 'd2', pdf: false, paginas: 5 }];
const rot = {
  titulo_arquivo: 'AGE 16.10.2024 Buritis', avisos: ['algo'],
  slides: [
    { tipo: 'capa', assembleia: 'Assembleia Geral Extraordinária', condominio: 'Buritis', data: '16 de outubro de 2024' },
    { tipo: 'pauta', itens: [{ titulo: 'Reforma do playground' }, { titulo: 'Taxa extra' }, 'Pintura da fachada'] },
    { tipo: 'item', numero: 1, titulo: 'Reforma do playground' },
    { tipo: 'fotos', numero: 1, titulo: 'Situação atual — playground', fotos: [{ id: 'f1' }, { id: 'f9' }] },
    { tipo: 'fotos', numero: 1, titulo: 'Fantasma', fotos: [{ id: 'f8' }] },
    { tipo: 'documento', numero: 1, titulo: 'Projeto', documento: 'd2', paginas: [1] },
    { tipo: 'documento', numero: 1, titulo: 'Planta', documento: 'd1', paginas: [7] },
    { tipo: 'comparativo', numero: 1, titulo: 'Comparativo', opcoes: [{ nome: 'A', valor: '27.750,00' }, { nome: 'B', valor: 21000 }, { nome: 'C', valor: 'consultar' }] },
    { tipo: 'comparativo', numero: 1, titulo: 'Sem valores', opcoes: [{ nome: 'X', valor: 'a combinar' }, { nome: 'Y' }] },
    { tipo: 'foto_texto', numero: 1, titulo: 'Brinquedo', foto: 'f7', topicos: ['Gira gira'], valor: 'R$ 4.615,60' },
    { tipo: 'item', numero: 2, titulo: 'Taxa extra' },
    { tipo: 'custeio', numero: 2, titulo: 'Forma de custeio', valor_total: 'R$ 30.000,00', unidades: '120', opcoes: [{ nome: 'Opção 1', parcelas: 3 }, { nome: 'Ruim', parcelas: 0 }] },
    { tipo: 'item', numero: 3, titulo: 'Pintura da fachada' },
    { tipo: 'encerramento' },
  ],
};
const v = A.validarRoteiro(rot, { fotos: fotosOk, documentos: docsOk, pauta: ['a', 'b', 'c', 'd'] });
const S = v.roteiro.slides;
t('roteiro: foto inexistente sai do slide', S[3].fotos.length === 1 && S[3].fotos[0].id === 'f1');
t('roteiro: slide sem nenhuma foto válida sai', !S.some((s) => s.titulo === 'Fantasma'));
t('roteiro: documento que não é PDF sai', !S.some((s) => s.titulo === 'Projeto'));
t('roteiro: página inexistente vira página 1', S.find((s) => s.titulo === 'Planta').paginas[0] === 1);
const comp = S.find((s) => s.titulo === 'Comparativo');
t('roteiro: comparativo com valores em número', comp.tipo === 'comparativo' && comp.opcoes.length === 2 && comp.opcoes[0].valor === 27750 && comp.opcoes[1].valor === 21000);
t('roteiro: comparativo sem valores vira lista', S.find((s) => s.titulo === 'Sem valores').tipo === 'topicos');
t('roteiro: foto_texto sem foto vira lista com o valor', S.find((s) => s.titulo === 'Brinquedo').tipo === 'topicos' && S.find((s) => s.titulo === 'Brinquedo').topicos.includes('Valor: R$ 4.615,60'));
const cus = S.find((s) => s.tipo === 'custeio');
t('roteiro: custeio com número e parcela inválida tirada', cus && cus.valor_total === 30000 && cus.unidades === 120 && cus.opcoes.length === 1);
t('roteiro: travessão trocado por vírgula', S[3].titulo === 'Situação atual, playground');
t('roteiro: avisos tirados do roteiro enviado ao motor', !('avisos' in v.roteiro));
t('roteiro: item 3 sem conteúdo vira aviso', v.avisos.some((a) => /item 3 da pauta/.test(a)));
{
  const r2 = A.validarRoteiro({ slides: [
    { tipo: 'pauta', itens: [{ titulo: 'Obra', etiqueta: 'VOTAÇÃO' }, { titulo: 'Assuntos gerais', etiqueta: 'ABERTO' }] },
    { tipo: 'item', numero: 1, titulo: 'Obra' }, { tipo: 'votacao', numero: 1, titulo: 'Obra', pergunta: 'Aprova a obra?' },
    { tipo: 'item', numero: 2, titulo: 'Assuntos gerais' }, { tipo: 'votacao', numero: 2, titulo: 'Assuntos gerais', pergunta: 'Assuntos gerais' },
  ] }, { fotos: [], documentos: [], pauta: ['Obra', 'Assuntos gerais'] });
  t('roteiro: assuntos gerais sem slide de votação', r2.roteiro.slides.filter((s) => s.tipo === 'votacao').length === 1 && r2.roteiro.slides.some((s) => s.tipo === 'votacao' && s.numero === 1));
  t('roteiro: assuntos gerais sem material não vira aviso', !r2.avisos.some((a) => /item 2 da pauta/.test(a)));
}
t('roteiro: itens 1 e 2 com conteúdo não viram aviso', !v.avisos.some((a) => /item [12] da pauta/.test(a)));
t('roteiro: pauta do edital diferente vira aviso', v.avisos.some((a) => /4 itens na pauta/.test(a)));
t('roteiro: avisos sem travessão', v.avisos.every((a) => !/[–—]/.test(a)));
t('semTraco: hífen dentro da palavra fica', A.semTraco('mão-de-obra 2024-2025') === 'mão-de-obra 2024-2025');
t('numero: formatos', A.numero('R$ 1.234,56') === 1234.56 && A.numero('27750.5') === 27750.5 && isNaN(A.numero('abc')));
t('nome do arquivo limpo', A.nomeArquivo('AGE 16/10/2024: Buritis*') === 'AGE 16 10 2024 Buritis' && A.nomeArquivo('') === 'Apresentação de assembleia');

// ── 3. Registro nas listas de modelos e custo ──
t('modelo da apresentação', modelos.PADRAO.apresentacao === 'claude-sonnet-5-5' && modelos.esforco('apresentacao') === 'low');
t('modelo da conferência das imagens', modelos.PADRAO.apresentacao_imagens === 'claude-haiku-5-5');
t('custo conhece as duas funções', custo.FUNCOES.includes('apresentacao') && custo.FUNCOES.includes('apresentacao_imagens'));

// ── 4. Menu: item aparece só com o módulo (GESTOR sempre) ──
(function () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ini = html.indexOf('var PAINEL_MODULOS'); const fim = html.indexOf('function aplicarVisibilidadePaineisFinanceiros');
  const codigo = html.slice(ini, fim);
  const pode = (role, perms) => { const ctx = { window: { USER_ROLE: role, USER_PERMS: perms } }; vm.createContext(ctx); vm.runInContext(codigo + '\nthis.r = podeAbrirPainel("apresentacao");', ctx); return ctx.r; };
  t('menu: GESTOR vê', pode('GESTOR', {}) === true);
  t('menu: sem módulo não vê', pode('OPERACIONAL', { atas: { visivel: true, acoes: ['ver'] } }) === false);
  t('menu: com módulo vê', pode('OPERACIONAL', { apresentacao: { visivel: true, acoes: ['ver'] } }) === true);
  t('menu: sem perfil não vê', pode('OPERACIONAL', null) === false);
  t('menu: item e tela no index', html.includes("showPanel('apresentacao')") && html.includes('id="panel-apresentacao"') && html.includes('<script src="/apresentacao.js"></script>'));
  t('menu: tópico Condomínio', fs.readFileSync(path.join(__dirname, '..', 'public', 'menu-grupos.js'), 'utf8').includes("'atas', 'apresentacao'"));
})();

// ── 5. Rotas com dublês ──
const guia = path.join(os.tmpdir(), 'guia-apresentacao-teste.md');
fs.writeFileSync(guia, 'GUIA DE TESTE');
const chamadas = [];   // tudo que foi para o serviço de processamento
let respostasRoteiro = [];
let demora = 0;
const chamarModelo = async (o) => {
  chamadas.push(o);
  if (demora) await new Promise((ok) => setTimeout(ok, demora));
  if (o.funcao === 'apresentacao_imagens') {
    const qtd = o.content.filter((b) => b.type === 'image').length;
    const imagens = [];
    for (let k = 1; k <= qtd; k++) {
      const ctx = o.content.filter((b) => b.type === 'text')[k - 1].text;
      if (/LOGO_TESTE/.test(ctx)) imagens.push({ k, tipo: 'decorativa', legenda: 'logo', texto_extra: 'não deve entrar' });
      else if (/não tem texto extraído/.test(ctx)) imagens.push({ k, tipo: 'informacao', legenda: 'orçamento escaneado', texto_extra: 'Total R$ 9.999,00' });
      else imagens.push({ k, tipo: 'foto', legenda: 'playground atual', texto_extra: 'Medida 12 m x 8 m' });
    }
    return { ok: true, texto: JSON.stringify({ imagens }) };
  }
  const r = respostasRoteiro.shift();
  return r || { ok: false, erro: 'falha' };
};
let motorRecebeu = null; let motorStatus = 200;
const motor = http.createServer((req, res) => {
  let s = ''; req.on('data', (c) => { s += c; });
  req.on('end', () => {
    motorRecebeu = { caminho: req.url, segredo: req.headers['x-internal-secret'], corpo: JSON.parse(s) };
    res.writeHead(motorStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(motorStatus === 200 ? { pptx_b64: 'UEsDBA==', pdf_b64: 'JVBERi0=', slides: 9, avisos: ['Slide 4: texto longo foi reduzido'] } : { detail: { detalhe: 'Roteiro inválido no motor.' } }));
  });
});

const USUARIO = '11111111-1111-4111-8111-111111111111';
const OUTRO = '22222222-2222-4222-8222-222222222222';
const perfis = { [USUARIO]: { role: 'OPERACIONAL', permissoes: { apresentacao: { visivel: true, acoes: ['ver', 'gerar'] } } }, [OUTRO]: { role: 'OPERACIONAL', permissoes: { apresentacao: { visivel: true, acoes: ['ver'] } } } };
const eventos = [];
const app = express();
const requireAuth = (req, res, next) => { req.user = { sub: req.headers['x-usuario'] || USUARIO }; next(); };

motor.listen(0, () => {
  A.criarRotasApresentacao(app, {
    requireAuth, express, extrairJson, modelos, chamarModelo,
    perfilDe: async (req) => perfis[req.user.sub] || null,
    podeModulo: (p, m, a) => !!p && (p.role === 'GESTOR' || !!(p.permissoes[m] && p.permissoes[m].visivel && (!a || p.permissoes[m].acoes.includes(a)))),
    auditoria: { evento: (req, acao, det) => eventos.push({ acao, det }) },
    dentroDoLimite: () => true,
    condominioDaBase: async (id) => (id === '136' ? { nome: 'Residencial Buritis', id: 136 } : null),
    exigirCarteira: async (req, res, id) => { if (id === '999') { res.status(403).json({ erro: 'fora_da_carteira' }); return false; } return true; },
    prestacaoPdf: { url: 'http://127.0.0.1:' + motor.address().port, segredo: 'segredo-teste' },
    caminhoGuia: guia,
    agora: () => Date.parse('2026-10-23T15:00:00Z'),
  });
  const logs = [];
  const logOrig = console.log; const warnOrig = console.warn;
  console.log = (s) => logs.push(String(s)); console.warn = () => {};
  const srv = http.createServer(app).listen(0, async () => {
    const porta = srv.address().port;
    const pedir = (metodo, caminho, corpo, usuario) => new Promise((resolve) => {
      const dados = corpo == null ? null : Buffer.from(JSON.stringify(corpo));
      const h = { 'x-usuario': usuario || USUARIO };
      if (dados) Object.assign(h, { 'content-type': 'application/json', 'content-length': dados.length });
      const q = http.request({ port: porta, path: caminho, method: metodo, headers: h }, (res) => {
        let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ st: res.statusCode, j }); });
      });
      if (dados) q.write(dados); q.end();
    });
    const esperar = async (jobId, usuario) => {
      for (let i = 0; i < 200; i++) {
        const r = await pedir('GET', '/api/apresentacao/status/' + jobId, null, usuario);
        if (r.j && r.j.status !== 'processing') return r;
        await new Promise((ok) => setTimeout(ok, 15));
      }
      return null;
    };
    const ROTEIRO_BOM = JSON.stringify({
      titulo_arquivo: 'AGE 16.10.2024 Buritis', avisos: ['Valor do item 2 confere com o edital?'],
      slides: [
        { tipo: 'capa', assembleia: 'Assembleia Geral Extraordinária', condominio: 'Buritis', data: '16 de outubro de 2024' },
        { tipo: 'pauta', itens: ['Reforma do playground', 'Taxa extra', 'Pintura da fachada'] },
        { tipo: 'item', numero: 1, titulo: 'Reforma do playground' },
        { tipo: 'fotos', numero: 1, titulo: 'Situação atual', fotos: [{ id: 'f1' }, { id: 'f3' }, { id: 'f40' }] },
        { tipo: 'documento', numero: 1, titulo: 'Orçamento', documento: 'd1', paginas: [1] },
        { tipo: 'item', numero: 2, titulo: 'Taxa extra' },
        { tipo: 'votacao', numero: 2, titulo: 'Votação', pergunta: 'Aprova?', opcoes: ['Sim', 'Não'] },
        { tipo: 'item', numero: 3, titulo: 'Pintura da fachada' },
        { tipo: 'encerramento' },
      ],
    });
    // Corpo base: 2 documentos (PDF com páginas com e sem texto; PowerPoint), 2 fotos e imagens dos documentos.
    const base = () => ({
      idSuperlogica: '136', condominio: 'nome da tela', pedido: 'Monte a AGE do dia 16/10 com os orçamentos do parquinho', edital_texto: EDITAL,
      documentos: [
        { nome: 'Orçamentos.pdf', tipo: 'pdf', paginas: 3, texto: '[página 1] Orçamento Empresa A playground R$ 27.750,00 itens e garantia\n[página 2] \n[página 3] LOGO_TESTE Rodapé com bastante texto escrito aqui para ter letras', pdf_b64: pdf('a') },
        { nome: 'Projeto.pptx', tipo: 'pptx', paginas: 2, texto: '[slide 1] Projeto do novo playground com brinquedos\n[slide 2] Layout proposto', pdf_b64: null },
      ],
      fotos: [{ nome: 'IMG_1.jpg', legenda: 'situação atual do playground', b64: jpeg('1') }, { nome: 'IMG_2.jpg', legenda: '', b64: jpeg('2') }],
      imagens_documentos: [
        { doc: 0, pagina: 1, largura: 1200, altura: 900, area: 0.5, hash: 'aaaa0000aaaa0000', b64: jpeg('p1'), b64_triagem: jpeg('p1t') },      // grande: candidata
        { doc: 0, pagina: 2, largura: 1600, altura: 2200, area: 1, hash: 'bbbb0000bbbb0000', b64: jpeg('p2'), b64_triagem: jpeg('p2t') },       // página sem texto: candidata
        { doc: 0, pagina: 3, largura: 300, altura: 300, area: 0.05, hash: 'cccc0000cccc0000', b64: jpeg('logo'), b64_triagem: null },            // pequena na página com texto: não confere
        { doc: 1, pagina: 1, largura: 300, altura: 300, area: 0.05, hash: 'cccc0000cccc0000', b64: jpeg('logo2'), b64_triagem: null },           // mesmo logo repetido: descarta
        { doc: 1, pagina: 2, largura: 150, altura: 120, area: 0.3, hash: 'dddd0000dddd0000', b64: jpeg('icone'), b64_triagem: jpeg('ic') },      // menos de 200px: descarta
        { doc: 1, pagina: 2, largura: 900, altura: 900, area: 0.02, hash: 'eeee0000eeee0000', b64: jpeg('mini'), b64_triagem: jpeg('mi') },      // menos de 4% da página: descarta
        { doc: 1, pagina: 2, largura: 1400, altura: 900, area: 0.6, hash: 'ffff0000ffff0000', b64: jpeg('lay'), b64_triagem: jpeg('layt'), legenda: 'layout escolhido pela comissão', legenda_editada: true },
      ],
      logo_cliente_b64: png,
    });
    try {
      // Permissão
      const neg = await pedir('POST', '/api/apresentacao/gerar', base(), OUTRO);
      t('sem a ação gerar: 403', neg.st === 403 && /não pode gerar/.test(neg.j.detalhe));
      t('pauta da prévia exige o módulo', (await pedir('POST', '/api/apresentacao/pauta', { edital_texto: EDITAL }, '33333333-3333-4333-8333-333333333333')).st === 403);
      const pv = await pedir('POST', '/api/apresentacao/pauta', { edital_texto: EDITAL });
      t('prévia da pauta', pv.st === 200 && pv.j.itens.length === 3);

      // Limites
      const muitos = base(); muitos.documentos = Array.from({ length: 31 }, (_, i) => ({ nome: 'd' + i + '.pdf', texto: 'x' })); muitos.imagens_documentos = [];
      t('31 documentos: 413', (await pedir('POST', '/api/apresentacao/gerar', muitos)).st === 413);
      const fotos = base(); fotos.fotos = Array.from({ length: 41 }, () => ({ nome: 'a.jpg', b64: jpeg('x') }));
      t('41 fotos: 413', (await pedir('POST', '/api/apresentacao/gerar', fotos)).st === 413);
      const ruim = base(); ruim.fotos[0].b64 = 'nao e imagem';
      t('foto que não é imagem: 400', (await pedir('POST', '/api/apresentacao/gerar', ruim)).st === 400);
      const docRuim = base(); docRuim.documentos[0].pdf_b64 = jpeg('x');
      t('PDF falso: 400', (await pedir('POST', '/api/apresentacao/gerar', docRuim)).st === 400);
      const vazio = { pedido: '', edital_texto: '', documentos: [], fotos: [] };
      t('sem nada: 400', (await pedir('POST', '/api/apresentacao/gerar', vazio)).st === 400);
      const fora = base(); fora.idSuperlogica = '555';
      t('condomínio fora da base: 403', (await pedir('POST', '/api/apresentacao/gerar', fora)).st === 403);
      const cart = base(); cart.idSuperlogica = '999';
      t('condomínio fora da carteira: 403', (await pedir('POST', '/api/apresentacao/gerar', cart)).st === 403);
      const grande = A.validarPedido({ pedido: 'x', documentos: [{ nome: 'g.pdf', pdf_b64: 'JVBERi' + 'A'.repeat(36 * 1024 * 1024 - 6) }] });
      t('PDF de mais de 25 MB: 413', grande.erro && grande.erro.status === 413);
      const total = A.validarPedido({ pedido: 'x', documentos: Array.from({ length: 7 }, () => ({ nome: 'g.pdf', pdf_b64: 'JVBERi' + 'A'.repeat(30 * 1024 * 1024 - 6) })) });
      t('envio de mais de 150 MB: 413', total.erro && total.erro.status === 413 && /150 MB/.test(total.erro.corpo.detalhe));

      // Ids
      const vp = A.validarPedido(base());
      t('ids dos documentos d1 e d2', vp.dados.documentos.map((d) => d.id).join() === 'd1,d2');
      t('fotos enviadas primeiro, depois as imagens dos documentos', vp.dados.fotos.map((f) => f.id + ':' + f.origem).join() === 'f1:enviada,f2:enviada,f3:documento,f4:documento,f5:documento,f6:documento');
      t('logo repetido, ícone pequeno e imagem minúscula descartados', vp.dados.descartadas === 3);
      t('legenda automática "documento, página N"', vp.dados.fotos[2].legenda === 'Orçamentos.pdf, página 1');
      t('legenda editada pela pessoa fica', vp.dados.fotos[5].legenda === 'layout escolhido pela comissão');
      t('pauta extraída no pedido', vp.dados.pauta.length === 3);
      t('logo do cliente aceita', vp.dados.logo === png);

      // Candidatas da conferência
      const cand = A.candidatasTriagem(vp.dados.fotos);
      t('candidatas: página sem texto e imagens grandes, maiores primeiro', cand.escolhidas.map((f) => f.id).join() === 'f4,f6,f3');
      t('candidatas: imagem pequena em página com texto fica fora', !cand.escolhidas.some((f) => f.id === 'f5'));
      const muitas = Array.from({ length: 35 }, (_, i) => ({ origem: 'documento', doc: { id: 'd1', texto: '[página 1] ' + 'texto '.repeat(20) }, pagina: 1, area: 0.2 + i / 100, largura: 800, altura: 600 }));
      const c35 = A.candidatasTriagem(muitas);
      t('candidatas: no máximo 30, as maiores', c35.escolhidas.length === 30 && c35.fora === 5 && c35.escolhidas[0].area > c35.escolhidas[29].area);

      // Geração completa
      chamadas.length = 0;
      respostasRoteiro = [{ ok: true, texto: 'isto não é json' }, { ok: true, texto: '```json\n' + ROTEIRO_BOM + '\n```' }];
      const g = await pedir('POST', '/api/apresentacao/gerar', base());
      t('gerar: 202 com jobId', g.st === 202 && /^[0-9a-f-]{36}$/.test(g.j.jobId));
      const outro = await pedir('GET', '/api/apresentacao/status/' + g.j.jobId, null, OUTRO);
      t('status: outra pessoa não vê o job', outro.st === 404);
      const fim = await esperar(g.j.jobId);
      t('job terminou', fim && fim.j.status === 'done');
      const tri = chamadas.filter((c) => c.funcao === 'apresentacao_imagens');
      const pri = chamadas.filter((c) => c.funcao === 'apresentacao');
      const imgsTri = tri.flatMap((c) => c.content.filter((b) => b.type === 'image').map((b) => b.source.data));
      t('conferência: uma chamada com as 3 candidatas', tri.length === 1 && imgsTri.length === 3);
      t('conferência: usa a versão reduzida', imgsTri.includes(jpeg('p1t')) && !imgsTri.includes(jpeg('p1')));
      t('conferência: cada imagem uma vez só', new Set(imgsTri).size === imgsTri.length);
      t('conferência: modelo barato', tri[0].modelo === 'claude-haiku-5-5');
      t('conferência: contexto da página junto da imagem', tri[0].content.some((b) => b.type === 'text' && b.text.includes('Texto já extraído desta página') && b.text.includes('Orçamento Empresa A')));
      t('chamada principal: repetiu uma vez depois do JSON quebrado', pri.length === 2 && JSON.stringify(pri[1].content).includes('não veio no formato pedido'));
      t('chamada principal: guia do disco com cache, 8000, esforço baixo', pri[0].system === 'GUIA DE TESTE' && pri[0].cache === true && pri[0].maxTokens === 8000 && pri[0].esforco === 'low' && pri[0].modelo === 'claude-sonnet-5-5');
      const conteudo = pri[0].content;
      t('chamada principal: só texto (nenhuma imagem)', typeof conteudo === 'string' && !conteudo.includes('/9j/') && !conteudo.includes('JVBERi') && !pri[1].content.some((b) => b.type !== 'text'));
      t('chamada principal: dados do condomínio da base e data', conteudo.includes('Residencial Buritis (código 136)') && conteudo.includes('23 de outubro de 2026'));
      t('chamada principal: edital e pauta extraída', conteudo.includes('<edital>') && conteudo.includes('PAUTA EXTRAÍDA DO EDITAL') && conteudo.includes('2. Aprovação de taxa extra'));
      t('chamada principal: documento com id, nome e páginas', conteudo.includes('<documento id="d1" nome="Orçamentos.pdf" tipo="pdf" paginas="3">') && conteudo.includes('id="d2"'));
      t('chamada principal: texto da imagem na página certa', /\[página 2\][^\n]*\n\[da imagem da página 2\] Total R\$ 9\.999,00/.test(conteudo));
      t('chamada principal: texto extra da imagem grande', conteudo.includes('[da imagem da página 1] Medida 12 m x 8 m'));
      t('chamada principal: lista de fotos com id e legenda', conteudo.includes('f1: arquivo IMG_1.jpg | legenda: situação atual do playground') && conteudo.includes('f2: arquivo IMG_2.jpg | sem legenda'));
      t('chamada principal: legenda da conferência na foto do documento', conteudo.includes('f3: imagem do documento d1, página 1 | legenda: playground atual'));
      t('chamada principal: legenda editada vence a da conferência', conteudo.includes('f6: imagem do documento d2, slide 2 | legenda: layout escolhido pela comissão'));
      t('chamada principal: pedido', conteudo.includes('<pedido>\nMonte a AGE'));
      // Motor
      t('motor: rota e segredo', motorRecebeu.caminho === '/v13/apresentacao' && motorRecebeu.segredo === 'segredo-teste');
      t('motor: só as fotos citadas que existem', motorRecebeu.corpo.fotos.map((f) => f.id).join() === 'f1,f3');
      t('motor: PDF citado vai', motorRecebeu.corpo.documentos.length === 1 && motorRecebeu.corpo.documentos[0].id === 'd1');
      t('motor: logo do cliente vai', motorRecebeu.corpo.logo_cliente_b64 === png);
      t('motor: roteiro conferido (foto inexistente tirada, sem avisos)', motorRecebeu.corpo.roteiro.slides[3].fotos.length === 2 && !('avisos' in motorRecebeu.corpo.roteiro));
      // Resultado
      const r = fim.j;
      t('resultado: arquivos, slides e nome', r.pptx_b64 === 'UEsDBA==' && r.pdf_b64 === 'JVBERi0=' && r.slides === 9 && r.titulo_arquivo === 'AGE 16.10.2024 Buritis');
      t('resultado: avisos do roteiro, da conferência e do motor juntos', r.avisos.includes('Valor do item 2 confere com o edital?') && r.avisos.some((a) => /foto que não existe/.test(a)) && r.avisos.includes('Slide 4: texto longo foi reduzido') && r.avisos.some((a) => /item 3 da pauta/.test(a)));
      t('resultado: roteiro guardado', r.roteiro && Array.isArray(r.roteiro.slides));
      t('resultado: conferência das imagens volta para a tela', r.imagens.length === 4 && r.imagens.find((x) => x.local === 1).triagem.tipo === 'informacao');
      t('log no padrão', logs.some((l) => /^\[apresentacao\] gerada cond=136 slides=9 fotos=\d+ docs=2 imagens_triadas=3 avisos=\d+ ms=\d+ usuario=11111111/.test(l)));
      t('log sem texto do pedido', !logs.some((l) => /parquinho/.test(l)));
      t('auditoria do evento', eventos.some((e) => e.acao === 'apresentacao_gerada' && e.det.id_superlogica === 136));

      // Decorativa sai das fotos e o texto dela não entra
      chamadas.length = 0;
      const deco = base();
      deco.documentos[0].texto = '[página 1] LOGO_TESTE capa com texto suficiente para não ser escaneada';
      deco.imagens_documentos = [{ doc: 0, pagina: 1, largura: 800, altura: 800, area: 0.3, hash: '1234123412341234', b64: jpeg('deco'), b64_triagem: jpeg('decot') }];
      respostasRoteiro = [{ ok: true, texto: ROTEIRO_BOM }];
      const g2 = await pedir('POST', '/api/apresentacao/gerar', deco);
      const f2 = await esperar(g2.j.jobId);
      const p2c = chamadas.find((c) => c.funcao === 'apresentacao').content;
      t('decorativa: não vira foto disponível', f2.j.status === 'done' && !p2c.includes('imagem do documento d1'));
      t('decorativa: texto dela não entra', !p2c.includes('não deve entrar'));

      // Conferência já feita antes não é paga de novo
      chamadas.length = 0;
      const rep = base();
      rep.imagens_documentos = rep.imagens_documentos.map((im, i) => Object.assign(im, { triagem: { tipo: 'foto', legenda: 'já conferida ' + i, texto_extra: 'extra guardado ' + i } }));
      respostasRoteiro = [{ ok: true, texto: ROTEIRO_BOM }];
      const g3 = await pedir('POST', '/api/apresentacao/gerar', rep);
      await esperar(g3.j.jobId);
      t('gerar de novo: não confere outra vez', !chamadas.some((c) => c.funcao === 'apresentacao_imagens'));
      t('gerar de novo: usa o texto guardado', chamadas.find((c) => c.funcao === 'apresentacao').content.includes('extra guardado 0'));

      // Corte de texto: 15 mil por documento e aviso
      chamadas.length = 0;
      const longo = base(); longo.imagens_documentos = [];
      longo.documentos[0].texto = '[página 1] ' + 'palavra '.repeat(3000);
      respostasRoteiro = [{ ok: true, texto: ROTEIRO_BOM }];
      const g4 = await pedir('POST', '/api/apresentacao/gerar', longo);
      const f4 = await esperar(g4.j.jobId);
      const doc1 = chamadas.find((c) => c.funcao === 'apresentacao').content.match(/<documento id="d1"[^>]*>\n([\s\S]*?)\n<\/documento>/)[1];
      t('corte: 15 mil caracteres por documento', doc1.length === 15000);
      t('corte: aviso na tela', f4.j.avisos.some((a) => /Orçamentos\.pdf" passou do limite/.test(a)));
      const docsLongos = Array.from({ length: 8 }, (_, i) => ({ id: 'd' + (i + 1), nome: 'n' + i, texto: 'x'.repeat(20000) }));
      A.textoFinalDocumentos(docsLongos, []);
      t('corte: 90 mil no total', docsLongos.reduce((s, d) => s + d.textoFinal.length, 0) === 90000);

      // JSON quebrado duas vezes
      respostasRoteiro = [{ ok: true, texto: 'nada' }, { ok: true, texto: '{"slides": []}' }];
      const g5 = await pedir('POST', '/api/apresentacao/gerar', base());
      const f5 = await esperar(g5.j.jobId);
      t('roteiro inválido duas vezes: erro em português sem detalhe interno', f5.j.status === 'error' && /não conseguiu montar o roteiro/.test(f5.j.detalhe) && !/json|slides/i.test(f5.j.detalhe));

      // Motor recusa
      motorStatus = 422;
      respostasRoteiro = [{ ok: true, texto: ROTEIRO_BOM }];
      const g6 = await pedir('POST', '/api/apresentacao/gerar', base());
      const f6 = await esperar(g6.j.jobId);
      t('motor recusou: mensagem do motor', f6.j.status === 'error' && f6.j.detalhe === 'Roteiro inválido no motor.');
      motorStatus = 200;

      // Uma geração por vez por pessoa
      respostasRoteiro = [];
      demora = 300;
      const gA = await pedir('POST', '/api/apresentacao/gerar', base());
      const gB = await pedir('POST', '/api/apresentacao/gerar', base());
      t('segunda geração ao mesmo tempo: 429', gA.st === 202 && gB.st === 429);
      await esperar(gA.j.jobId);
      demora = 0;
      t('job inexistente: 404', (await pedir('GET', '/api/apresentacao/status/nao-existe')).st === 404);
    } catch (e) {
      falha++; escrever('ERRO: ' + (e && e.stack));
    } finally {
      console.log = logOrig; console.warn = warnOrig;
      srv.close(); motor.close();
      try { fs.unlinkSync(guia); } catch (e) { /* nada */ }
      console.log(ok + ' ok, ' + falha + ' falha(s)');
      process.exit(falha ? 1 : 0);
    }
  });
});
