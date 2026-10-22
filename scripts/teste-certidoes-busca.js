// Teste da T50 (busca automática de certidões): rede falsa, nenhum site real é chamado.
// As páginas abaixo são recortes do que a Prefeitura de Vitória devolveu em 22/10/2026,
// com ViewState, chave e CNPJ trocados por valores fictícios.
// Confere: links, tipos manuais (sem tocar na rede), leitura dos campos ocultos do ASP.NET,
// montagem de cada requisição, cookies, PDF oficial, desvio para verificação de robô e fila.
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
  t('TIPOS_AUTOMATICOS só municipal', busca.TIPOS_AUTOMATICOS instanceof Set && busca.TIPOS_AUTOMATICOS.size === 1 && busca.TIPOS_AUTOMATICOS.has('municipal'));
  t('ehAutomatica Vitória', busca.ehAutomatica('municipal', 'Vitória'));
  t('ehAutomatica Serra não', !busca.ehAutomatica('municipal', 'Serra'));
  t('ehAutomatica fgts não', !busca.ehAutomatica('fgts', 'Vitória'));

  // ── Manuais: lançam 'manual' sem tocar na rede ──
  for (const [tipo, cidade] of [['federal', 'Serra'], ['estadual', 'Serra'], ['trabalhista', 'Serra'], ['fgts', 'Serra'], ['falencia', 'Serra'],
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
