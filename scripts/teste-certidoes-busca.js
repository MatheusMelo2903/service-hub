// Teste da T50 (busca automática de certidões): rede falsa, nenhum site real é chamado.
// As páginas abaixo são recortes do que a Prefeitura de Vitória devolveu em 22/10/2026,
// com ViewState, chave e CNPJ trocados por valores fictícios.
// Confere: links, tipos manuais (sem tocar na rede), leitura dos campos ocultos do ASP.NET,
// montagem de cada requisição, cookies, PDF oficial, desvio para verificação de robô e fila.
// T50: a Falência automática fica desligada por padrão (o TJES recusa o servidor em nuvem);
// o teste liga a variável antes de carregar o módulo para cobrir o fluxo inteiro.
process.env.CERTIDOES_TJES_AUTOMATICO = '1';
const busca = require('../servico/certidoes-busca');
const { _interno } = busca;

let ok = 0, falha = 0;
const t = (nome, cond) => { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } };

const CNPJ = '11.222.333/0001-81';
const CNPJ_LIMPO = '11222333000181';
const VIX = 'https://tributario.vitoria.es.gov.br/servicos/CertidaoNegativa/CertidaoNegativa.aspx';

// ── Páginas de exemplo (recortes) ─────────────────────────────────────────
const ocultos = (vs, ev) =>
  '<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />\n'
  + '<input type="hidden" name="__EVENTARGUMENT" id="__EVENTARGUMENT" value="" />\n'
  + '<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="' + vs + '" />\n'
  + '<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="04B519F7" />\n'
  + '<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="' + ev + '" />\n';

const PAGINA1 = '<form method="post" action="./CertidaoNegativa.aspx" id="aspnetForm">' + ocultos('VS1+abc/def==', 'EV1&amp;x')
  + '<input id="ctl00_conteudo_rblTipoDocumento_0" type="radio" name="ctl00$conteudo$rblTipoDocumento" value="Inscricao Fiscal" checked="checked" />'
  + '<input id="ctl00_conteudo_rblTipoDocumento_1" type="radio" name="ctl00$conteudo$rblTipoDocumento" value="CNPJ" onclick="javascript:setTimeout(&#39;__doPostBack(\\&#39;ctl00$conteudo$rblTipoDocumento$1\\&#39;,\\&#39;\\&#39;)&#39;, 0)" />'
  + '<input name="ctl00$conteudo$txtTermoBusca" type="text" id="ctl00_conteudo_txtTermoBusca" class="form-control" />'
  + '<input type="submit" name="ctl00$conteudo$btnEnviar" value="Continuar" id="ctl00_conteudo_btnEnviar" class="btn btn-primary" /></form>';

const PAGINA2 = '<form method="post" action="./CertidaoNegativa.aspx" id="aspnetForm">' + ocultos('VS2', 'EV2')
  + '<input id="ctl00_conteudo_rblTipoDocumento_1" type="radio" name="ctl00$conteudo$rblTipoDocumento" value="CNPJ" checked="checked" />'
  + '<input name="ctl00$conteudo$txtTermoBusca" type="text" maxlength="14" id="ctl00_conteudo_txtTermoBusca" class="form-control" />'
  + '<input type="submit" name="ctl00$conteudo$btnEnviar" value="Continuar" id="ctl00_conteudo_btnEnviar" class="btn btn-primary" /></form>';

const PDF_QS = 'ExibirRelatorioRetPDF.aspx?qs=AbC%2fdEf%2bGh%3d';
const PAGINA3_OK = '<form method="post" action="./CertidaoNegativa.aspx" id="aspnetForm">' + ocultos('VS3', 'EV3')
  + '<div id="ctl00_conteudo_pnlResultadoPesquisa"><h2><span id="ctl00_conteudo_lblTitulo">Certidão Negativa de Débitos</span></h2>'
  + '<div id="ctl00_conteudo_pnlRS"><span id="ctl00_conteudo_lblMensagemRS" style="color:Red;">Documento válido até o dia 21/12/2026 e abrange apenas a pessoa física ou jurídica identificada.<BR><BR>A emissão deste documento <B> NÃO PODERÁ SER COBRADA</B>.</span>'
  + '<div><input type="button" name="ctl00$conteudo$btnCancelar" value="Cancelar" onclick="javascript:__doPostBack(&#39;ctl00$conteudo$btnCancelar&#39;,&#39;&#39;)" id="ctl00_conteudo_btnCancelar" class="btn btn-default bt-log dir" />'
  + '<input type="submit" name="ctl00$conteudo$btnEmitir" value="Emitir" onclick="window.open(&#39;' + PDF_QS + '&#39;, &#39;_blank&#39;);" id="ctl00_conteudo_btnEmitir" class="btn btn-primary bt-log dir" />'
  + '</div></div></div></form>';

// Situação sem certidão liberada (texto ilustrativo no mesmo formato de spans do site).
const PAGINA3_SEM = '<form method="post" action="./CertidaoNegativa.aspx" id="aspnetForm">' + ocultos('VS3', 'EV3')
  + '<div id="ctl00_conteudo_pnlResultadoPesquisa"><h2><span id="ctl00_conteudo_lblTitulo">Certidão Positiva de Débitos</span></h2>'
  + '<span id="ctl00_conteudo_lblMensagem">Existem pendências para o contribuinte.</span></div></form>';

const PDF = Buffer.concat([Buffer.from('%PDF-1.3\n'), Buffer.alloc(500, 32), Buffer.from('\n%%EOF')]);

// ── TJES (recortes no formato da página real de 22/10/2026, dados fictícios) ──
const TJES_FORM = 'https://sistemas.tjes.jus.br/certidao-negativa/emitir';
const TJES_PAG_FORM = '<form id="v2Form" name="v2Form" method="post" action="/certidao-negativa/emitir" novalidate>'
  + '<div class="v2-aviso-erro" id="v2AvisoErro"></div>'
  + '<input type="radio" name="rbPessoa" id="rbPessoaF" value="F" checked><input type="radio" name="rbPessoa" id="rbPessoaJ" value="J">'
  + '<input type="text" id="edCnpj" name="edCnpj" class="v2-input" maxlength="18" value=""><div class="v2-msg-erro" id="erro_edCnpj"></div>'
  + '<input type="text" id="edRazaoSocial" name="edRazaoSocial" class="v2-input maiuscula" maxlength="250" value="">'
  + '<select id="cbInstancia" name="cbInstancia" class="v2-select"><option value="0" selected>-- Escolha --</option><option value="1">1ª Instância (Fóruns)</option></select>'
  + '<div id="rowNatureza1" style="display:none"><select id="cbNatureza1" class="v2-select"><option value="0" selected>-- Escolha --</option>'
  + '<option value="99" data-aux="Todas exceto família">Todas (exceto família)</option><option value="98" data-aux="Execuções Fiscais">Execuções Fiscais</option>'
  + '<option value="11" data-aux="Recuperação Judicial e Extrajudicial">Recuperação Judicial e Extrajudicial</option></select></div>'
  + '<input type="hidden" id="cbNatureza" name="cbNatureza" value="0"><input type="hidden" id="cbNaturezaAux" name="cbNaturezaAux" value="">'
  + '<button type="submit" name="btnAvancar" id="btnAvancar" class="v2-btn v2-btn-primario">Emitir Certidão</button></form>';

function tjesResultado({ titulo = 'CERTIDÃO NEGATIVA DE PRIMEIRA INSTÂNCIA', resultado = 'NADA CONSTA', texto = 'CERTIFICA que, consultando a base de dados (<strong>E-Jud, SIEP, PROJUDI e PJe-1G</strong>) até a presente data e hora, <strong>NADA CONSTA</strong> contra o solicitante.', extra = '', cnpj = CNPJ, validaAte = true } = {}) {
  return '<main class="v2-main"><div class="v2-card"><div class="v2-certidao-wrap" id="v2Certidao"><div class="v2-cert-topo"><table class="v2-cert-topo-tabela" role="presentation"><tr><td>'
    + '<div class="v2-cert-orgao-bloco"><div class="v2-cert-orgao">PODER JUDICIÁRIO</div><div class="v2-cert-orgao"><strong>TRIBUNAL DE JUSTIÇA DO ESTADO DO ESPÍRITO SANTO</strong></div>'
    + '<div class="v2-cert-orgao-end">Endereço do tribunal</div></div></td></tr></table>'
    + '<div class="v2-cert-titulo-bloco"><div class="v2-cert-titulo">' + titulo + '</div><div class="v2-cert-natureza">RECUPERAÇÃO JUDICIAL E EXTRAJUDICIAL (FALÊNCIA E CONCORDATA)</div></div></div>'
    + '<table class="v2-certidao-resultado" role="presentation"><tr><td class="v2-certidao-resultado-conteudo"><div class="v2-certidao-resultado-icone">&#10003;</div>'
    + '<div class="v2-certidao-resultado-titulo">' + resultado + '</div><div class="v2-certidao-resultado-texto">' + texto + '</div></td></tr></table>'
    + extra
    + '<div class="v2-certidao-secao"><div class="v2-certidao-secao-titulo">Dados da Certidão</div><table class="v2-certidao-tabela" cellpadding="0" cellspacing="0">'
    + '<tr><th>Razão Social</th><td colspan="3">CONDOMINIO RESIDENCIAL EXEMPLO</td></tr>'
    + '<tr><th>CNPJ</th><td>' + cnpj + '</td><th>Comarca</th><td>PRIMEIRA INSTÂNCIA</td></tr>'
    + '<tr><th class="v2-cert-col-fixa">Data de Expedição</th><td>05/01/2026 10:11:12</td><th>Validade</th><td>30 dias</td></tr>'
    + '<tr><th class="v2-cert-col-fixa">Nº da Certidão</th><td><strong>* 2026000001 *</strong></td>'
    + (validaAte ? '<th class="v2-cert-col-fixa">Válida até</th><td>04/02/2026</td>' : '') + '</tr></table></div>'
    + '<table class="v2-certidao-observacoes" role="presentation"><tr><td class="v2-certidao-secao-titulo">Observações</td></tr><tr><td><ol class="v2-cert-obs">'
    + '<li>Certidão expedida gratuitamente através da Internet;</li><li>O prazo de validade desta certidão é de 30 (trinta) dias;</li></ol></td></tr></table>'
    + '<div class="v2-certidao-rodape"><p><strong>*** VÁLIDA POR 30 (TRINTA) DIAS ***</strong></p>'
    + '<p>Para verificar a autenticidade desta certidão, acesse <a href="/certidao-negativa/autenticidade" target="_blank"><strong>/certidao-negativa/autenticidade</strong></a> e informe o número da certidão.</p></div></div>'
    + '<div class="v2-btn-row" id="v2BotoesCertidao"><button type="button" onclick="window.print()">Imprimir / Salvar PDF</button></div></div></main>';
}

// Lê o texto de um PDF com o mesmo pdfjs que o servidor usa (os avisos de "canvas" do pdfjs no Node são silenciados).
let pdfjs = null;
async function textoPdf(buf) {
  if (!pdfjs) {
    const aviso = console.warn, log = console.log;
    console.warn = () => {}; console.log = () => {};
    try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); } finally { console.warn = aviso; console.log = log; }
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableWorker: true, verbosity: 0 }).promise;
  const partes = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    partes.push(tc.items.map((i) => i.str).join('\n'));
  }
  return { paginas: doc.numPages, texto: partes.join('\n') };
}

// ── Rede falsa ───────────────────────────────────────────────────────────
// Cada chamada de fetch é registrada; as respostas saem de uma lista na ordem.
function redeFalsa(respostas) {
  const chamadas = [];
  let emAndamento = 0, maxSimultaneas = 0;
  const fetch = async (url, op) => {
    emAndamento++; maxSimultaneas = Math.max(maxSimultaneas, emAndamento);
    chamadas.push({ url, metodo: op.method, cabecalhos: op.headers, corpo: op.body ? new URLSearchParams(op.body) : null, temSinal: !!op.signal, redirect: op.redirect });
    await new Promise((r) => setTimeout(r, 5));
    emAndamento--;
    const prox = respostas.shift();
    if (!prox) throw new Error('requisição inesperada: ' + url);
    if (prox instanceof Error) throw prox;
    return prox;
  };
  return { fetch, chamadas, max: () => maxSimultaneas };
}
const html = (corpo, cookies = []) => new Response(corpo, { status: 200, headers: new Headers([['content-type', 'text/html; charset=utf-8'], ...cookies.map((c) => ['set-cookie', c])]) });
const pdf = (b) => new Response(b, { status: 200, headers: { 'content-type': 'application/pdf' } });
const fluxoOk = () => [
  html(PAGINA1, ['ASP.NET_SessionId=sessao1; path=/; HttpOnly', 'TS01=abc; Path=/']),
  html(PAGINA2),
  html(PAGINA3_OK),
  pdf(PDF),
];

async function esperaErro(promessa) { try { await promessa; return null; } catch (e) { return e; } }

(async () => {
  // ── Links ──
  t('link federal', busca.linkPreenchido('federal', CNPJ, 'Serra') === 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj');
  t('link estadual (endereço novo)', busca.linkPreenchido('estadual', CNPJ, 'Serra') === 'https://s1-internet.sefaz.es.gov.br/certidaonegativa/Gerar');
  t('link trabalhista', busca.linkPreenchido('trabalhista', CNPJ) === 'https://cndt-certidao.tst.jus.br/gerarCertidao');
  t('link fgts', busca.linkPreenchido('fgts', CNPJ).includes('consultaEmpregador.jsf'));
  t('link falencia', busca.linkPreenchido('falencia', CNPJ) === 'https://sistemas.tjes.jus.br/certidao-negativa/emitir');
  t('link municipal Vitória com acento', busca.linkPreenchido('municipal', CNPJ, 'Vitória') === VIX);
  t('link municipal VITORIA/ES', busca.linkPreenchido('municipal', CNPJ, 'VITORIA/ES') === VIX);
  t('link municipal Serra', busca.linkPreenchido('municipal', CNPJ, 'Serra - ES').includes('tributacao.serra.es.gov.br:8080/tbserra/'));
  t('link municipal Vila Velha', busca.linkPreenchido('municipal', CNPJ, 'vila velha').includes('tributacao.vilavelha.es.gov.br'));
  t('link municipal Cariacica', busca.linkPreenchido('municipal', CNPJ, 'CARIACICA').includes('sistemas.cariacica.es.gov.br'));
  t('link municipal cidade fora da lista = null', busca.linkPreenchido('municipal', CNPJ, 'Guarapari') === null);
  t('link tipo desconhecido = null', busca.linkPreenchido('xyz', CNPJ) === null);
  t('nenhum link leva o CNPJ', ['federal', 'estadual', 'trabalhista', 'fgts', 'falencia', 'municipal'].every((tp) => !busca.linkPreenchido(tp, CNPJ, 'Vitória').includes(CNPJ_LIMPO)));

  // ── Quais são automáticas ──
  t('TIPOS_AUTOMATICOS = municipal e falencia', busca.TIPOS_AUTOMATICOS instanceof Set && busca.TIPOS_AUTOMATICOS.size === 2 && busca.TIPOS_AUTOMATICOS.has('municipal') && busca.TIPOS_AUTOMATICOS.has('falencia'));
  t('ehAutomatica falencia em qualquer cidade', busca.ehAutomatica('falencia', 'Serra') && busca.ehAutomatica('falencia', 'Guarapari') && busca.ehAutomatica('falencia', ''));
  t('ehAutomatica Vitória', busca.ehAutomatica('municipal', 'Vitória'));
  t('ehAutomatica Serra não', !busca.ehAutomatica('municipal', 'Serra'));
  t('ehAutomatica fgts não', !busca.ehAutomatica('fgts', 'Vitória'));

  // ── Manuais: lançam 'manual' sem tocar na rede ──
  for (const [tipo, cidade] of [['federal', 'Serra'], ['estadual', 'Serra'], ['trabalhista', 'Serra'], ['fgts', 'Serra'],
    ['municipal', 'Serra'], ['municipal', 'Vila Velha'], ['municipal', 'Cariacica'], ['municipal', 'Guarapari'], ['municipal', ''], ['qualquer', 'Vitória']]) {
    const rede = redeFalsa([]);
    const e = await esperaErro(busca.buscar(tipo, { cnpj: CNPJ, nome: 'CONDOMINIO TESTE', cidade }, { fetch: rede.fetch }));
    t('manual ' + tipo + ' ' + cidade, e && e.codigo === 'manual' && e.message.length > 10 && rede.chamadas.length === 0);
  }

  // ── Campos ocultos ──
  const campos = _interno.camposOcultos(PAGINA1);
  t('lê __VIEWSTATE', campos.__VIEWSTATE === 'VS1+abc/def==');
  t('decodifica &amp; no valor', campos.__EVENTVALIDATION === 'EV1&x');
  t('lê gerador', campos.__VIEWSTATEGENERATOR === '04B519F7');
  t('não pega campo de texto', !('ctl00$conteudo$txtTermoBusca' in campos));
  t('link do PDF montado', _interno.linkPdfVitoria(PAGINA3_OK) === 'https://tributario.vitoria.es.gov.br/servicos/CertidaoNegativa/' + PDF_QS);
  t('sem botão Emitir = sem link', _interno.linkPdfVitoria(PAGINA3_SEM) === null);

  // ── Vitória: fluxo completo ──
  {
    const rede = redeFalsa(fluxoOk());
    const r = await busca.buscar('municipal', { cnpj: CNPJ, nome: 'CONDOMINIO TESTE', cidade: 'Vitória' }, { fetch: rede.fetch });
    const [c1, c2, c3, c4] = rede.chamadas;
    t('4 requisições', rede.chamadas.length === 4);
    t('1: GET da página', c1.metodo === 'GET' && c1.url === VIX);
    t('user agent do Hub', c1.cabecalhos['User-Agent'] === _interno.UA && /ServiceHub/.test(_interno.UA));
    t('tempo limite e redirect manual', rede.chamadas.every((c) => c.temSinal && c.redirect === 'manual'));
    t('2: postback do rádio CNPJ', c2.metodo === 'POST' && c2.corpo.get('__EVENTTARGET') === 'ctl00$conteudo$rblTipoDocumento$1' && c2.corpo.get('ctl00$conteudo$rblTipoDocumento') === 'CNPJ');
    t('2: devolve ViewState da página 1', c2.corpo.get('__VIEWSTATE') === 'VS1+abc/def==' && c2.corpo.get('__EVENTVALIDATION') === 'EV1&x');
    t('2: manda cookies da sessão', /ASP\.NET_SessionId=sessao1/.test(c2.cabecalhos.Cookie) && /TS01=abc/.test(c2.cabecalhos.Cookie));
    t('2: formulário url encoded', c2.cabecalhos['Content-Type'] === 'application/x-www-form-urlencoded');
    t('3: envia CNPJ só com dígitos e Continuar', c3.corpo.get('ctl00$conteudo$txtTermoBusca') === CNPJ_LIMPO && c3.corpo.get('ctl00$conteudo$btnEnviar') === 'Continuar' && c3.corpo.get('__EVENTTARGET') === '');
    t('3: devolve ViewState da página 2', c3.corpo.get('__VIEWSTATE') === 'VS2');
    t('4: GET do PDF com qs intacto', c4.metodo === 'GET' && c4.url === 'https://tributario.vitoria.es.gov.br/servicos/CertidaoNegativa/' + PDF_QS && !c4.corpo);
    t('PDF devolvido', Buffer.isBuffer(r.pdf) && r.pdf.subarray(0, 4).toString() === '%PDF');
    t('nome do arquivo sem hífen', r.nome_arquivo === 'Certidao_Municipal_Vitoria_' + CNPJ_LIMPO + '.pdf');
  }

  // ── Vitória: certidão não liberada ──
  {
    const rede = redeFalsa([html(PAGINA1), html(PAGINA2), html(PAGINA3_SEM)]);
    const e = await esperaErro(busca.buscar('municipal', { cnpj: CNPJ, cidade: 'Vitória' }, { fetch: rede.fetch }));
    t('sem certidão = falhou com texto do site', e && e.codigo === 'falhou' && /Positiva/.test(e.message) && /pendências/.test(e.message) && rede.chamadas.length === 3);
  }

  // ── Vitória: resposta não é PDF ──
  {
    const r = fluxoOk(); r[3] = html('<html>erro</html>');
    const rede = redeFalsa(r);
    const e = await esperaErro(busca.buscar('municipal', { cnpj: CNPJ, cidade: 'Vitória' }, { fetch: rede.fetch }));
    t('HTML no lugar do PDF = falhou', e && e.codigo === 'falhou');
  }

  // ── Verificação de robô no meio do caminho = manual, sem insistir ──
  {
    const rede = redeFalsa([html(PAGINA1), html('<html><script src="https://js.hcaptcha.com/1/api.js"></script></html>')]);
    const e = await esperaErro(busca.buscar('municipal', { cnpj: CNPJ, cidade: 'Vitória' }, { fetch: rede.fetch }));
    t('captcha na página = manual', e && e.codigo === 'manual' && rede.chamadas.length === 2);
  }
  {
    const desvio = new Response('', { status: 302, headers: { location: 'https://validate.perfdrive.com/abc/?ssa=1' } });
    const rede = redeFalsa([html(PAGINA1), desvio]);
    const e = await esperaErro(busca.buscar('municipal', { cnpj: CNPJ, cidade: 'Vitória' }, { fetch: rede.fetch }));
    t('desvio para outro site = manual', e && e.codigo === 'manual' && rede.chamadas.length === 2);
  }
  {
    // Redirecionamento dentro do próprio site é seguido normalmente.
    const volta = new Response('', { status: 302, headers: { location: '/servicos/CertidaoNegativa/CertidaoNegativa.aspx' } });
    const rede = redeFalsa([html(PAGINA1), volta, html(PAGINA2), html(PAGINA3_OK), pdf(PDF)]);
    const res = await busca.buscar('municipal', { cnpj: CNPJ, cidade: 'Vitória' }, { fetch: rede.fetch });
    t('redirecionamento no mesmo site seguido com GET', res.pdf.length === PDF.length && rede.chamadas[2].metodo === 'GET');
  }

  // ── Erros de entrada e de rede ──
  {
    const rede = redeFalsa([]);
    const e = await esperaErro(busca.buscar('municipal', { cnpj: '123', cidade: 'Vitória' }, { fetch: rede.fetch }));
    t('CNPJ inválido = falhou sem rede', e && e.codigo === 'falhou' && rede.chamadas.length === 0);
  }
  {
    const tempo = new Error('tempo'); tempo.name = 'TimeoutError';
    const rede = redeFalsa([tempo]);
    const e = await esperaErro(busca.buscar('municipal', { cnpj: CNPJ, cidade: 'Vitória' }, { fetch: rede.fetch }));
    t('tempo esgotado = falhou', e && e.codigo === 'falhou' && /30 segundos/.test(e.message));
  }
  {
    const rede = redeFalsa([html('<html>página nova sem formulário</html>')]);
    const e = await esperaErro(busca.buscar('municipal', { cnpj: CNPJ, cidade: 'Vitória' }, { fetch: rede.fetch }));
    t('página mudou de formato = falhou', e && e.codigo === 'falhou' && /mudou/.test(e.message));
  }
  {
    const rede = redeFalsa([new Response('erro', { status: 503 })]);
    const e = await esperaErro(busca.buscar('municipal', { cnpj: CNPJ, cidade: 'Vitória' }, { fetch: rede.fetch }));
    t('site fora do ar = falhou', e && e.codigo === 'falhou' && /503/.test(e.message));
  }

  // ── Gerador de PDF ──
  {
    const g = _interno.gerarPdf([
      { texto: 'TRIBUNAL DE JUSTIÇA DO ESTADO DO ESPÍRITO SANTO', negrito: true, centro: true },
      { texto: 'Ação (com parênteses) e barra \\ “aspas” – ÁÉÍÓÚ âêô ãõ ç ª º' },
    ], { rodape: 'Rodapé de teste' });
    const s = g.toString('latin1');
    t('gerador: começa com %PDF', s.startsWith('%PDF-1.4'));
    t('gerador: termina com %%EOF', s.trimEnd().endsWith('%%EOF'));
    t('gerador: WinAnsiEncoding e Helvetica', /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/.test(s) && /Helvetica-Bold/.test(s));
    // A tabela xref aponta para o início exato de cada objeto.
    const xref = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(s);
    const offs = xref[2].trim().split('\n').slice(1).map((l) => +l.slice(0, 10));
    t('gerador: xref confere', offs.length === +xref[1] - 1 && offs.every((o, i) => s.startsWith((i + 1) + ' 0 obj', o)));
    t('gerador: startxref confere', s.startsWith('xref', +/startxref\n(\d+)/.exec(s)[1]));
    const lido = await textoPdf(g);
    t('gerador: pdfjs lê o título com acentos', lido.texto.includes('TRIBUNAL DE JUSTIÇA DO ESTADO DO ESPÍRITO SANTO'));
    t('gerador: pdfjs lê acentos, parênteses, barra e aspas', lido.texto.includes('Ação (com parênteses) e barra \\ “aspas” – ÁÉÍÓÚ âêô ãõ ç ª º'));
    t('gerador: rodapé e número da página', lido.texto.includes('Rodapé de teste') && lido.texto.includes('Página 1 de 1'));
    const longo = _interno.gerarPdf(Array.from({ length: 150 }, (_, i) => ({ texto: 'Linha ' + i + ' com texto comprido o bastante para ocupar boa parte da largura útil da página.' })));
    const lidoLongo = await textoPdf(longo);
    t('gerador: várias páginas', lidoLongo.paginas > 1 && lidoLongo.texto.includes('Linha 149') && lidoLongo.texto.includes('Página 2 de ' + lidoLongo.paginas));
    const ql = _interno.quebrarLinhas('https://exemplo.gov.br/' + 'x'.repeat(300), 10, false, 483);
    t('gerador: palavra maior que a linha é cortada', ql.length > 1 && ql.join('') === 'https://exemplo.gov.br/' + 'x'.repeat(300));
  }

  // ── TJES: leitura da página e natureza ──
  {
    t('TJES: valor da natureza lido do formulário', _interno.valorNaturezaTjes(TJES_PAG_FORM) === '11');
    const c = _interno.lerCertidaoTjes(tjesResultado());
    t('TJES: título e natureza', c.titulo === 'CERTIDÃO NEGATIVA DE PRIMEIRA INSTÂNCIA' && /RECUPERAÇÃO JUDICIAL/.test(c.natureza));
    t('TJES: resultado sem o ícone', c.resultadoTitulo === 'NADA CONSTA' && /^CERTIFICA que/.test(c.resultadoTexto) && !c.resultadoTexto.includes('✓'));
    t('TJES: dados', c.razaoSocial === 'CONDOMINIO RESIDENCIAL EXEMPLO' && c.cnpj === CNPJ && c.numero === '2026000001' && c.expedicao === '05/01/2026 10:11:12' && c.validade === '30 dias' && c.validaAte === '04/02/2026');
    t('TJES: sem informações extras quando nada consta', c.outras === '');
    t('TJES: observações e autenticidade', c.observacoes.length === 2 && c.autenticidade === 'https://sistemas.tjes.jus.br/certidao-negativa/autenticidade' && /VÁLIDA POR 30/.test(c.avisoValidade));
    t('TJES: validade calculada quando falta "Válida até"', _interno.calcularValidade(_interno.lerCertidaoTjes(tjesResultado({ validaAte: false }))) === '04/02/2026');
    t('TJES: página sem certidão = null', _interno.lerCertidaoTjes(TJES_PAG_FORM) === null);
  }

  // ── TJES: fluxo completo ──
  const AGORA = new Date('2026-01-05T13:15:00Z'); // 10:15 em Brasília
  {
    const volta = new Response('', { status: 302, headers: { location: '/certidao-negativa/resultado', 'set-cookie': 'session=abc; HttpOnly; Path=/' } });
    const rede = redeFalsa([html(TJES_PAG_FORM, ['AWSALB=x1; Path=/']), volta, html(tjesResultado())]);
    const r = await busca.buscar('falencia', { cnpj: CNPJ, nome: '  CONDOMINIO   RESIDENCIAL EXEMPLO ', cidade: 'Serra' }, { fetch: rede.fetch, agora: AGORA });
    const [c1, c2, c3] = rede.chamadas;
    t('TJES: 3 requisições', rede.chamadas.length === 3);
    t('TJES: 1: GET do formulário', c1.metodo === 'GET' && c1.url === TJES_FORM);
    t('TJES: 2: POST com os campos do site', c2.metodo === 'POST' && c2.url === TJES_FORM && c2.corpo.get('rbPessoa') === 'J' && c2.corpo.get('edCnpj') === CNPJ
      && c2.corpo.get('edRazaoSocial') === 'CONDOMINIO RESIDENCIAL EXEMPLO' && c2.corpo.get('cbInstancia') === '1' && c2.corpo.get('cbNatureza') === '11'
      && c2.corpo.get('cbNaturezaAux') === 'Recuperação Judicial e Extrajudicial' && c2.corpo.has('btnAvancar') && c2.corpo.get('edCpf') === '');
    t('TJES: 2: cookie da sessão', /AWSALB=x1/.test(c2.cabecalhos.Cookie));
    t('TJES: 3: segue para /resultado com GET e cookie novo', c3.metodo === 'GET' && c3.url === 'https://sistemas.tjes.jus.br/certidao-negativa/resultado' && /session=abc/.test(c3.cabecalhos.Cookie));
    t('TJES: nome do arquivo', r.nome_arquivo === 'Certidao_Falencia_TJES_' + CNPJ_LIMPO + '.pdf');
    t('TJES: PDF começa com %PDF', r.pdf.subarray(0, 4).toString() === '%PDF');
    const { texto } = await textoPdf(r.pdf);
    for (const trecho of ['TRIBUNAL DE JUSTIÇA DO ESTADO DO ESPÍRITO SANTO', 'Recuperação Judicial', 'CNPJ: ' + CNPJ, 'Número da certidão: 2026000001',
      'Emitida em 05/01/2026', 'Válida até 04/02/2026', 'NADA CONSTA', 'https://sistemas.tjes.jus.br/certidao-negativa/autenticidade', 'CONDOMINIO RESIDENCIAL EXEMPLO']) {
      t('TJES: PDF contém "' + trecho + '"', texto.includes(trecho));
    }
    t('TJES: rodapé exato', texto.replace(/\n/g, ' ').includes('Documento montado pelo Service Hub a partir da página oficial do TJES em 05/01/2026 10:15. Confira a autenticidade no endereço acima.'));
  }
  {
    // Quando consta algo, o PDF sai igual, com o que consta.
    const extra = '<div class="v2-certidao-secao"><div class="v2-certidao-secao-titulo">Processos</div><ul><li>Processo 0000000 00.2026.8.08.0024, 1ª Vara Empresarial</li></ul></div>';
    const pag = tjesResultado({ titulo: 'CERTIDÃO POSITIVA DE PRIMEIRA INSTÂNCIA', resultado: 'CONSTA', texto: 'CERTIFICA que CONSTA o processo abaixo.', extra });
    const rede = redeFalsa([html(TJES_PAG_FORM), html(pag)]);
    const r = await busca.buscar('falencia', { cnpj: CNPJ, nome: 'CONDOMINIO RESIDENCIAL EXEMPLO' }, { fetch: rede.fetch, agora: AGORA });
    const { texto } = await textoPdf(r.pdf);
    t('TJES consta: PDF mostra o resultado', texto.includes('CERTIDÃO POSITIVA') && texto.includes('CONSTA o processo abaixo'));
    t('TJES consta: PDF mostra o processo', texto.includes('Processo 0000000 00.2026.8.08.0024') && texto.includes('Informações da certidão'));
  }
  {
    // Página não mostrou certidão (formulário voltou com aviso): falhou, sem PDF.
    const recusa = TJES_PAG_FORM.replace('<div class="v2-aviso-erro" id="v2AvisoErro"></div>', '<div class="v2-aviso-erro visivel" id="v2AvisoErro">Não foi possível emitir a certidão.</div>');
    const rede = redeFalsa([html(TJES_PAG_FORM), html(recusa)]);
    const e = await esperaErro(busca.buscar('falencia', { cnpj: CNPJ, nome: 'X' }, { fetch: rede.fetch }));
    t('TJES: sem certidão = falhou com aviso do site', e && e.codigo === 'falhou' && /Não foi possível emitir/.test(e.message));
  }
  {
    const rede = redeFalsa([html(TJES_PAG_FORM), html(tjesResultado({ cnpj: '99.888.777/0001-66' }))]);
    const e = await esperaErro(busca.buscar('falencia', { cnpj: CNPJ, nome: 'X' }, { fetch: rede.fetch }));
    t('TJES: certidão de outro CNPJ = falhou', e && e.codigo === 'falhou');
  }
  {
    const rede = redeFalsa([html(TJES_PAG_FORM.replace(/<option value="11"[^>]*>[^<]*<\/option>/, ''))]);
    const e = await esperaErro(busca.buscar('falencia', { cnpj: CNPJ, nome: 'X' }, { fetch: rede.fetch }));
    t('TJES: natureza sumiu do formulário = falhou sem enviar', e && e.codigo === 'falhou' && /mudou/.test(e.message) && rede.chamadas.length === 1);
  }
  {
    const rede = redeFalsa([html(TJES_PAG_FORM + '<div class="g-recaptcha" data-sitekey="x"></div><script src="https://www.google.com/recaptcha/api.js"></script>')]);
    const e = await esperaErro(busca.buscar('falencia', { cnpj: CNPJ, nome: 'X' }, { fetch: rede.fetch }));
    t('TJES: captcha no formulário = manual sem enviar', e && e.codigo === 'manual' && rede.chamadas.length === 1);
  }
  {
    const rede = redeFalsa([]);
    const e = await esperaErro(busca.buscar('falencia', { cnpj: CNPJ, nome: '  ' }, { fetch: rede.fetch }));
    t('TJES: sem razão social = falhou sem rede', e && e.codigo === 'falhou' && rede.chamadas.length === 0);
  }

  // ── Fila: duas buscas ao mesmo tempo não acessam o site em paralelo ──
  {
    const rede = redeFalsa([...fluxoOk(), ...fluxoOk()]);
    const [a, b] = await Promise.all([
      busca.buscar('municipal', { cnpj: CNPJ, cidade: 'Vitória' }, { fetch: rede.fetch }),
      busca.buscar('municipal', { cnpj: CNPJ, cidade: 'Vitória' }, { fetch: rede.fetch }),
    ]);
    t('fila: as duas terminam', a.pdf.length && b.pdf.length);
    t('fila: no máximo uma requisição por vez', rede.max() === 1 && rede.chamadas.length === 8);
  }

  console.log((falha ? 'FALHOU: ' : 'OK: ') + ok + ' certos, ' + falha + ' falhas');
  process.exit(falha ? 1 : 0);
})().catch((e) => { console.log('ERRO: ' + e.stack); process.exit(1); });
