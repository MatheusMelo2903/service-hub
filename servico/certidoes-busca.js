// ─────────────────────────────────────────────────────────────────────────
// T50: busca automática de certidões negativas nos sites oficiais.
//
// Regra absoluta: nunca contornar captcha, reCAPTCHA, hCaptcha, Turnstile, imagem de
// verificação ou gerenciador de robô. Se um site pede verificação em qualquer etapa,
// o tipo é 'manual' e a pessoa emite no navegador (botão "Emitir" da tela).
// Também só aceitamos o PDF oficial que o próprio site entrega: página HTML impressa
// pelo navegador não conta como certidão para o Hub.
//
// O que foi conferido em 22/10/2026 (requisições reais, user agent do Hub):
//   municipal Vitória: sem verificação, devolve PDF oficial  => automático
//   falencia (TJES): sem verificação, mas a certidão sai só como página HTML
//     (o botão "Imprimir / Salvar PDF" é o imprimir do navegador)            => manual
//   fgts (Caixa): o primeiro acesso abre, mas o "Consultar" feito por programa é
//     desviado para o ShieldSquare (validate.perfdrive.com) com hCaptcha     => manual
//   estadual (SEFAZ ES): página nova em s1-internet com Cloudflare Turnstile => manual
//   municipal Serra: sistema tbserra com imagem de verificação (getCaptcha)  => manual
//   federal (hCaptcha), trabalhista (imagem), Vila Velha (imagem) e Cariacica
//     (reCAPTCHA): verificação confirmada no navegador                      => manual
// Nenhum dos sites aceita o CNPJ no endereço, então linkPreenchido devolve o link normal.
// ─────────────────────────────────────────────────────────────────────────

const UA = 'ServiceHub/1.0 (certidoes; contato Virtual Service)'; // o mesmo usado nos testes reais
const TEMPO_LIMITE = 30000; // por requisição
const MAX_PDF = 10 * 1024 * 1024; // mesmo teto do envio manual
const MAX_REDIRECIONAMENTOS = 3;

// Tipos com pelo menos um caminho automático de verdade. 'municipal' só é automático
// para Vitória; use ehAutomatica(tipo, cidade) quando a cidade importar.
const TIPOS_AUTOMATICOS = new Set(['municipal']);
const CIDADES_AUTOMATICAS = new Set(['vitoria']);

const LINKS = {
  federal: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj',
  // O link antigo (s2-internet.../certidao/cnd) não responde mais; o portal da SEFAZ aponta para este.
  estadual: 'https://s1-internet.sefaz.es.gov.br/certidaonegativa/Gerar',
  trabalhista: 'https://cndt-certidao.tst.jus.br/gerarCertidao',
  fgts: 'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf',
  falencia: 'https://sistemas.tjes.jus.br/certidao-negativa/emitir',
};
const LINKS_MUNICIPAIS = {
  serra: 'https://tributacao.serra.es.gov.br:8080/tbserra/loginWeb.jsp?execobj=ServicosWebSite&tab=tabCertNegCont',
  vitoria: 'https://tributario.vitoria.es.gov.br/servicos/CertidaoNegativa/CertidaoNegativa.aspx',
  'vila velha': 'https://tributacao.vilavelha.es.gov.br/tbw/loginWeb.jsp?execobj=ServicosWebSite&tab=tabCertNegCont',
  cariacica: 'https://sistemas.cariacica.es.gov.br/tbw/loginWeb.jsp?execobj=ServicosWebSite',
};

// Motivo mostrado quando o tipo não é automático (vai no detalhe do erro 'manual').
const MOTIVO_MANUAL = {
  federal: 'O site da Receita Federal pede verificação de robô (hCaptcha).',
  estadual: 'O site da SEFAZ ES pede verificação de robô (Cloudflare Turnstile).',
  trabalhista: 'O site do TST pede a digitação de uma imagem de verificação.',
  fgts: 'O site da Caixa desvia a consulta automática para uma verificação de robô (hCaptcha).',
  falencia: 'O TJES entrega a certidão só como página para imprimir, sem PDF oficial para baixar.',
  serra: 'O site da Prefeitura da Serra pede a digitação de uma imagem de verificação.',
  'vila velha': 'O site da Prefeitura de Vila Velha pede a digitação de uma imagem de verificação.',
  cariacica: 'O site da Prefeitura de Cariacica pede verificação de robô (reCAPTCHA).',
};

// Sinais de página de verificação de robô. Se aparecerem, paramos na hora (nunca tentamos resolver).
const SINAIS_VERIFICACAO = /captcha|hcaptcha|recaptcha|turnstile|perfdrive|shieldsquare|cf-challenge|challenge-platform/i;

function erro(codigo, mensagem) {
  const e = new Error(mensagem);
  e.codigo = codigo;
  return e;
}

// "Vitória", "VITORIA/ES", " vitória - es " viram "vitoria"; serve para casar a cidade do cadastro.
function normalizarCidade(cidade) {
  return String(cidade || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s*[\/,(-]\s*es\)?\s*$/, '')
    .replace(/\s+es\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Só dígitos (e letras, por causa do CNPJ alfanumérico que a Receita começou a emitir em 2026).
function limparCnpj(cnpj) {
  return String(cnpj || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function ehAutomatica(tipo, cidade) {
  if (tipo !== 'municipal') return false;
  return CIDADES_AUTOMATICAS.has(normalizarCidade(cidade));
}

// Link do site oficial. Nenhum site conferido aceita o CNPJ no endereço (testado em
// 22/10/2026 em TJES, SEFAZ ES e Receita; os demais são formulários de sessão), então
// o CNPJ fica só para a tela copiar. Devolve null para tipo ou cidade desconhecidos.
function linkPreenchido(tipo, cnpj, cidade) {
  if (tipo === 'municipal') return LINKS_MUNICIPAIS[normalizarCidade(cidade)] || null;
  return LINKS[tipo] || null;
}

// Decodifica as entidades que aparecem em valores de campos ocultos e em atributos onclick.
function decodificarEntidades(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Lê os campos ocultos de um formulário ASP.NET ou JSF (ViewState, EventValidation etc.).
// O site exige que eles voltem exatamente como vieram, senão recusa o envio.
function camposOcultos(html) {
  const campos = {};
  for (const m of String(html).matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type\s*=\s*["']hidden["']/i.test(tag)) continue;
    const nome = /name\s*=\s*"([^"]+)"|name\s*=\s*'([^']+)'/i.exec(tag);
    if (!nome) continue;
    const valor = /value\s*=\s*"([^"]*)"|value\s*=\s*'([^']*)'/i.exec(tag);
    campos[decodificarEntidades(nome[1] || nome[2])] = valor ? decodificarEntidades(valor[1] ?? valor[2] ?? '') : '';
  }
  return campos;
}

function textoSemTags(html) {
  return decodificarEntidades(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Sessão HTTP simples: guarda cookies entre as etapas (o ASP.NET e o JSF amarram o formulário
// à sessão), aplica tempo limite, identifica o Hub no user agent e para em qualquer desvio
// para outro endereço, que nesses sites costuma ser página de verificação de robô.
function criarSessao(fetchImpl) {
  const cookies = new Map();

  function guardarCookies(resp) {
    const lista = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
    for (const c of lista) {
      const par = c.split(';')[0];
      const i = par.indexOf('=');
      if (i > 0) cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
  }

  async function pedir(url, { formulario, referer } = {}) {
    let atual = url;
    let metodo = formulario ? 'POST' : 'GET';
    let corpo = formulario ? new URLSearchParams(formulario).toString() : undefined;
    for (let salto = 0; salto <= MAX_REDIRECIONAMENTOS; salto++) {
      const cabecalhos = { 'User-Agent': UA, Accept: 'text/html,application/pdf;q=0.9,*/*;q=0.8' };
      if (cookies.size) cabecalhos.Cookie = [...cookies].map(([k, v]) => k + '=' + v).join('; ');
      if (corpo) cabecalhos['Content-Type'] = 'application/x-www-form-urlencoded';
      if (referer) cabecalhos.Referer = referer;
      let resp;
      try {
        resp = await fetchImpl(atual, { method: metodo, headers: cabecalhos, body: corpo, redirect: 'manual', signal: AbortSignal.timeout(TEMPO_LIMITE) });
      } catch (e) {
        const motivo = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'o site demorou mais de 30 segundos para responder' : 'não foi possível conectar ao site';
        throw erro('falhou', 'Busca não concluída: ' + motivo + '.');
      }
      guardarCookies(resp);
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
        const destino = new URL(resp.headers.get('location'), atual);
        if (destino.host !== new URL(atual).host) {
          throw erro('manual', 'O site desviou a consulta automática para outro endereço (verificação de robô). Emita pelo navegador.');
        }
        atual = destino.href; metodo = 'GET'; corpo = undefined;
        continue;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_PDF) throw erro('falhou', 'O site devolveu um arquivo maior que 10 MB.');
      return { status: resp.status, tipo: resp.headers.get('content-type') || '', buf, url: atual };
    }
    throw erro('falhou', 'O site redirecionou vezes demais.');
  }

  return { pedir };
}

function exigirPaginaOk(resp, etapa) {
  if (resp.status !== 200) throw erro('falhou', 'O site respondeu com erro ' + resp.status + ' na etapa ' + etapa + '.');
  const html = resp.buf.toString('utf8');
  if (SINAIS_VERIFICACAO.test(html)) throw erro('manual', 'O site pediu verificação de robô na etapa ' + etapa + '. Emita pelo navegador.');
  return html;
}

// ── Vitória (ASP.NET WebForms) ───────────────────────────────────────────
// Fluxo igual ao do navegador: abre a página, marca "CNPJ" (o rádio faz postback e troca o
// campo), envia a inscrição com "Continuar" e, se a certidão estiver liberada, a página
// traz o botão "Emitir" com o endereço ExibirRelatorioRetPDF.aspx?qs=..., que devolve o PDF.
const VIX_BASE = LINKS_MUNICIPAIS.vitoria;
const VIX_RADIO = 'ctl00$conteudo$rblTipoDocumento';
const VIX_CAMPO = 'ctl00$conteudo$txtTermoBusca';
const VIX_BOTAO = 'ctl00$conteudo$btnEnviar';

function linkPdfVitoria(html) {
  const botao = /<input\b[^>]*name="ctl00\$conteudo\$btnEmitir"[^>]*>/i.exec(html);
  if (!botao) return null;
  const onclick = /onclick="([^"]*)"/i.exec(botao[0]);
  if (!onclick) return null;
  const m = /window\.open\('([^']*ExibirRelatorio[^']*)'/i.exec(decodificarEntidades(onclick[1]));
  return m ? new URL(m[1], VIX_BASE).href : null;
}

// Junta o título e as mensagens do resultado para explicar por que não veio certidão
// (débito em aberto, cadastro incompleto etc.). O texto é do próprio site.
function mensagemVitoria(html) {
  const partes = [];
  for (const m of html.matchAll(/<span\b[^>]*id="ctl00_conteudo_(lblTitulo|lblMensagem[A-Za-z]*)"[^>]*>([\s\S]*?)<\/span>/gi)) {
    const t = textoSemTags(m[2]);
    if (t) partes.push(t);
  }
  return partes.join(' ').slice(0, 400);
}

async function buscarVitoria(sessao, cnpj) {
  let html = exigirPaginaOk(await sessao.pedir(VIX_BASE), 'abertura');
  if (!/__VIEWSTATE/.test(html) || !html.includes(VIX_CAMPO)) throw erro('falhou', 'A página da Prefeitura de Vitória mudou de formato.');

  html = exigirPaginaOk(await sessao.pedir(VIX_BASE, {
    referer: VIX_BASE,
    formulario: { ...camposOcultos(html), __EVENTTARGET: VIX_RADIO + '$1', __EVENTARGUMENT: '', [VIX_RADIO]: 'CNPJ', [VIX_CAMPO]: '' },
  }), 'escolha do CNPJ');

  html = exigirPaginaOk(await sessao.pedir(VIX_BASE, {
    referer: VIX_BASE,
    formulario: { ...camposOcultos(html), __EVENTTARGET: '', __EVENTARGUMENT: '', [VIX_RADIO]: 'CNPJ', [VIX_CAMPO]: cnpj, [VIX_BOTAO]: 'Continuar' },
  }), 'consulta');

  const link = linkPdfVitoria(html);
  if (!link) {
    const msg = mensagemVitoria(html);
    throw erro('falhou', 'A Prefeitura de Vitória não liberou a certidão' + (msg ? ': ' + msg : '.'));
  }
  if (new URL(link).host !== new URL(VIX_BASE).host) throw erro('falhou', 'Endereço do PDF fora do site da Prefeitura de Vitória.');

  const pdf = await sessao.pedir(link, { referer: VIX_BASE });
  if (pdf.status !== 200 || pdf.buf.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw erro('falhou', 'A Prefeitura de Vitória não devolveu o PDF da certidão.');
  }
  return { pdf: pdf.buf, nome_arquivo: 'Certidao_Municipal_Vitoria_' + cnpj + '.pdf' };
}

// ── Fila ─────────────────────────────────────────────────────────────────
// Uma busca por vez no servidor inteiro: respeita os sites (sem rajada de acessos do mesmo
// endereço do Railway) e reduz o risco de o servidor ser bloqueado.
let fila = Promise.resolve();
function naFila(tarefa) {
  const p = fila.then(tarefa, tarefa);
  fila = p.catch(() => {});
  return p;
}

// Busca a certidão do tipo pedido. Devolve { pdf, nome_arquivo } com o PDF oficial
// (sempre começa com %PDF). Lança Error com .codigo 'manual' (precisa do navegador)
// ou 'falhou' (tentou e não deu). opcoes.fetch existe só para o teste trocar a rede.
async function buscar(tipo, { cnpj, nome, cidade } = {}, opcoes = {}) {
  const cidadeNorm = normalizarCidade(cidade);
  if (tipo === 'municipal') {
    if (!LINKS_MUNICIPAIS[cidadeNorm]) throw erro('manual', 'Cidade do condomínio sem busca configurada: ' + (cidade || 'não informada') + '.');
    if (!CIDADES_AUTOMATICAS.has(cidadeNorm)) throw erro('manual', MOTIVO_MANUAL[cidadeNorm]);
  } else if (!LINKS[tipo]) {
    throw erro('manual', 'Tipo de certidão desconhecido: ' + tipo + '.');
  } else {
    throw erro('manual', MOTIVO_MANUAL[tipo]);
  }

  const doc = limparCnpj(cnpj);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(doc)) throw erro('falhou', 'CNPJ do condomínio ausente ou inválido no cadastro.');
  const fetchImpl = opcoes.fetch || globalThis.fetch;
  return naFila(() => buscarVitoria(criarSessao(fetchImpl), doc));
}

module.exports = {
  TIPOS_AUTOMATICOS,
  buscar,
  linkPreenchido,
  ehAutomatica,
  // expostos para o teste
  _interno: { normalizarCidade, limparCnpj, camposOcultos, linkPdfVitoria, mensagemVitoria, decodificarEntidades, UA },
};
