// ─────────────────────────────────────────────────────────────────────────
// T50: busca automática de certidões negativas nos sites oficiais.
//
// Regra absoluta: nunca contornar captcha, reCAPTCHA, hCaptcha, Turnstile, imagem de
// verificação ou gerenciador de robô. Se um site pede verificação em qualquer etapa,
// o tipo é 'manual' e a pessoa emite no navegador (botão "Emitir" da tela).
// Quando o site entrega PDF, usamos o PDF oficial. O TJES só mostra a certidão como página
// HTML; nesse caso (aprovado pelo Matheus em 22/10/2026) o Hub monta um PDF simples com o
// texto lido da página oficial e o endereço de autenticidade, sem nenhuma biblioteca nova.
//
// O que foi conferido em 22/10/2026 (requisições reais, user agent do Hub):
//   municipal Vitória: sem verificação, devolve PDF oficial  => automático
//   falencia (TJES): sem verificação, certidão em página HTML (o "Imprimir / Salvar PDF"
//     é o imprimir do navegador); o Hub monta o PDF a partir dela             => automático
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
// 'falencia' vale para qualquer cidade (o TJES atende o estado todo).
const TIPOS_AUTOMATICOS = new Set(['municipal', 'falencia']);
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
  if (tipo === 'falencia') return true;
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

// ── Gerador mínimo de PDF ───────────────────────────────────────────────
// PDF 1.4 em JS puro, só texto: páginas A4, Helvetica e Helvetica Bold (fontes padrão de todo
// leitor de PDF, nada embutido) com WinAnsiEncoding para os acentos do português. O texto
// fica extraível (o servidor lê com pdfjs para conferir CNPJ, tipo e validade).
const A4 = { larg: 595.28, alt: 841.89 };
const MARGEM = 56;
// Larguras da Helvetica (unidades de 1/1000 do tamanho) para os caracteres 32 a 126.
const LARG_HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
// Caracteres do WinAnsi que não coincidem com o Latin1 (aspas curvas, travessões etc.).
const WINANSI_EXTRA = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };

function codigoWinAnsi(ch) {
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  if (WINANSI_EXTRA[ch]) return WINANSI_EXTRA[ch];
  return 63; // "?" para o que a fonte padrão não tem (o ícone de visto do TJES, por exemplo)
}

function larguraTexto(texto, tamanho, negrito) {
  let soma = 0;
  for (const ch of texto) {
    let c = ch.codePointAt(0);
    if (c > 126) c = ch.normalize('NFD').codePointAt(0); // letra acentuada mede como a letra base
    soma += (c >= 32 && c <= 126) ? LARG_HELV[c - 32] : 556;
  }
  return soma * tamanho / 1000 * (negrito ? 1.08 : 1);
}

// Quebra por palavra para caber na largura; palavra maior que a linha (um link longo) é cortada.
function quebrarLinhas(texto, tamanho, negrito, largura) {
  const linhas = [];
  let atual = '';
  for (const palavra of String(texto).split(/\s+/).filter(Boolean)) {
    const tentativa = atual ? atual + ' ' + palavra : palavra;
    if (larguraTexto(tentativa, tamanho, negrito) <= largura) { atual = tentativa; continue; }
    if (atual) linhas.push(atual);
    atual = palavra;
    while (larguraTexto(atual, tamanho, negrito) > largura) {
      let i = atual.length - 1;
      while (i > 1 && larguraTexto(atual.slice(0, i), tamanho, negrito) > largura) i--;
      linhas.push(atual.slice(0, i));
      atual = atual.slice(i);
    }
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [''];
}

// Texto como string literal do PDF, só com bytes ASCII (o resto vira escape octal).
function stringPdf(texto) {
  let s = '(';
  for (const ch of String(texto)) {
    const b = codigoWinAnsi(ch);
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + ch;
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
}

// blocos: [{ texto, tamanho = 10, negrito = false, centro = false, antes = 0 }]
// rodape: texto repetido no pé de cada página, junto com "Página x de n".
function gerarPdf(blocos, { rodape = '', titulo = '' } = {}) {
  const largUtil = A4.larg - 2 * MARGEM;
  const limiteInferior = MARGEM + 34; // espaço reservado ao rodapé
  const paginas = [[]];
  let y = A4.alt - MARGEM;
  for (const b of blocos) {
    const tam = b.tamanho || 10;
    const alturaLinha = tam * 1.35;
    y -= b.antes || 0;
    for (const linha of quebrarLinhas(b.texto, tam, b.negrito, largUtil)) {
      if (y - alturaLinha < limiteInferior) { paginas.push([]); y = A4.alt - MARGEM; }
      y -= alturaLinha;
      const x = b.centro ? (A4.larg - larguraTexto(linha, tam, b.negrito)) / 2 : MARGEM;
      paginas[paginas.length - 1].push('BT /' + (b.negrito ? 'F2' : 'F1') + ' ' + tam + ' Tf ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' Td ' + stringPdf(linha) + ' Tj ET');
    }
  }

  const objetos = []; // texto de cada objeto, na ordem dos números 1, 2, 3...
  const total = paginas.length;
  const idsPaginas = paginas.map((_, i) => 6 + i * 2);
  objetos[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objetos[1] = '<< /Type /Pages /Kids [' + idsPaginas.map((id) => id + ' 0 R').join(' ') + '] /Count ' + total + ' >>';
  objetos[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objetos[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objetos[4] = '<< /Producer (Service Hub)' + (titulo ? ' /Title ' + stringPdf(titulo) : '') + ' >>';
  paginas.forEach((cmds, i) => {
    const pe = [];
    // Escrito de cima para baixo, para o texto extraído sair na ordem de leitura.
    const linhasPe = (rodape ? quebrarLinhas(rodape, 8, false, largUtil) : []).concat(['Página ' + (i + 1) + ' de ' + total]);
    let yr = MARGEM + 12 + 10 * (linhasPe.length - 1);
    linhasPe.forEach((l) => {
      pe.push('BT /F1 8 Tf ' + MARGEM + ' ' + yr.toFixed(2) + ' Td ' + stringPdf(l) + ' Tj ET');
      yr -= 10;
    });
    const conteudo = cmds.concat(pe).join('\n');
    objetos[5 + i * 2] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + A4.larg + ' ' + A4.alt + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (idsPaginas[i] + 1) + ' 0 R >>';
    objetos[6 + i * 2] = '<< /Length ' + Buffer.byteLength(conteudo, 'latin1') + ' >>\nstream\n' + conteudo + '\nendstream';
  });

  // Tudo é ASCII puro, então posição em caracteres = posição em bytes na tabela xref.
  let saida = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const posicoes = [];
  objetos.forEach((obj, i) => {
    posicoes.push(Buffer.byteLength(saida, 'latin1'));
    saida += (i + 1) + ' 0 obj\n' + obj + '\nendobj\n';
  });
  const inicioXref = Buffer.byteLength(saida, 'latin1');
  saida += 'xref\n0 ' + (objetos.length + 1) + '\n0000000000 65535 f \n'
    + posicoes.map((p) => String(p).padStart(10, '0') + ' 00000 n \n').join('')
    + 'trailer\n<< /Size ' + (objetos.length + 1) + ' /Root 1 0 R /Info 5 0 R >>\nstartxref\n' + inicioXref + '\n%%EOF\n';
  return Buffer.from(saida, 'latin1');
}

// ── TJES: certidão de falência e recuperação judicial ─────────────────────
// Fluxo igual ao do navegador: abre o formulário, envia Pessoa Jurídica com CNPJ, razão
// social, 1ª Instância e natureza "Recuperação Judicial e Extrajudicial"; o site redireciona
// para /resultado, que mostra a certidão em HTML. Lemos a página e montamos o PDF.
const TJES_FORM = LINKS.falencia;
const TJES_AUTENTICIDADE = 'https://sistemas.tjes.jus.br/certidao-negativa/autenticidade';
const TJES_NATUREZA = 'Recuperação Judicial e Extrajudicial';

function formatarCnpj(doc) {
  return doc.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5');
}

function semAcento(s) {
  return String(s).normalize('NFD').replace(/[^\x20-\x7e]/g, '').toLowerCase().trim();
}

function dataBr(d) {
  return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
}

// Data e hora de Brasília para o rodapé.
function agoraBrasilia(agora) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(agora).map((x) => [x.type, x.value]));
  return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute;
}

// Valor do <option> da natureza "Recuperação Judicial" na 1ª Instância, lido da própria página
// (se o TJES renumerar as opções, seguimos certo; se a opção sumir, paramos).
function valorNaturezaTjes(html) {
  const sel = /<select[^>]*id="cbNatureza1"[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (!sel) return null;
  for (const m of sel[1].matchAll(/<option\b[^>]*value="(\d+)"[^>]*>([\s\S]*?)<\/option>/gi)) {
    if (/recuperacao judicial/.test(semAcento(textoSemTags(m[2])))) return m[1];
  }
  return null;
}

function divTexto(html, classe) {
  const m = new RegExp('<div class="' + classe + '"[^>]*>([\\s\\S]*?)</div>', 'i').exec(html);
  return m ? textoSemTags(m[1]) : '';
}

// Lê a certidão da página de resultado. Devolve null se a página não mostrou uma certidão.
function lerCertidaoTjes(html) {
  const ini = html.indexOf('id="v2Certidao"');
  if (ini < 0) return null;
  const pag = html.slice(ini);
  const orgao = [...pag.matchAll(/<div class="v2-cert-orgao">([\s\S]*?)<\/div>/gi)].map((m) => textoSemTags(m[1])).filter(Boolean);
  const endereco = [...pag.matchAll(/<div class="v2-cert-orgao-end">([\s\S]*?)<\/div>/gi)].map((m) => textoSemTags(m[1])).filter(Boolean);

  // Resultado inteiro (NADA CONSTA ou o que constar), sem o ícone de visto.
  const blocoRes = /<table class="v2-certidao-resultado"[\s\S]*?<\/table>/i.exec(pag);
  const resultadoTitulo = blocoRes ? divTexto(blocoRes[0], 'v2-certidao-resultado-titulo') : '';
  const resultadoTexto = blocoRes ? textoSemTags(blocoRes[0]
    .replace(/<div class="v2-certidao-resultado-icone"[^>]*>[\s\S]*?<\/div>/i, '')
    .replace(/<div class="v2-certidao-resultado-titulo"[^>]*>[\s\S]*?<\/div>/i, '')) : '';

  // Entre o resultado e as observações: a tabela "Dados da Certidão" e, se houver, outras
  // informações (processos encontrados, por exemplo). Nada disso é descartado.
  const fimRes = blocoRes ? pag.indexOf(blocoRes[0]) + blocoRes[0].length : 0;
  const iniObs = pag.search(/<table class="v2-certidao-observacoes"/i);
  const meio = pag.slice(fimRes, iniObs > fimRes ? iniObs : undefined);
  const tabela = /<table class="v2-certidao-tabela"[\s\S]*?<\/table>/i.exec(meio);
  const dados = {};
  if (tabela) {
    for (const m of tabela[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
      dados[semAcento(textoSemTags(m[1]))] = textoSemTags(m[2]);
    }
  }
  const outras = textoSemTags((tabela ? meio.replace(tabela[0], '') : meio)
    .replace(/<div class="v2-certidao-secao-titulo"[^>]*>\s*Dados da Certid[\s\S]*?<\/div>/i, '')
    .replace(/<table class="v2-certidao-observacoes"[\s\S]*$/i, ''));

  const campo = (re) => { const k = Object.keys(dados).find((x) => re.test(x)); return k ? dados[k] : ''; };
  const observacoes = iniObs >= 0
    ? [...pag.slice(iniObs).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => textoSemTags(m[1])).filter(Boolean)
    : [];
  const rodape = /<div class="v2-certidao-rodape"[^>]*>([\s\S]*?)<div class="v2-btn-row"/i.exec(pag);
  const avisoValidade = rodape ? (/<p>\s*<strong>([^<]*V[ÁA]LIDA POR[^<]*)<\/strong>/i.exec(rodape[1]) || [])[1] || '' : '';
  const linkAut = rodape ? /<a\b[^>]*href="([^"]*autenticidade[^"]*)"/i.exec(rodape[1]) : null;

  return {
    orgao, endereco,
    titulo: divTexto(pag, 'v2-cert-titulo'),
    natureza: divTexto(pag, 'v2-cert-natureza'),
    resultadoTitulo, resultadoTexto, outras,
    razaoSocial: campo(/^razao social/),
    cnpj: campo(/^cnpj/),
    comarca: campo(/^comarca/),
    expedicao: campo(/expedicao/),
    validade: campo(/^validade/),
    validaAte: campo(/^valida ate/),
    numero: campo(/^n.*certidao/).replace(/\D/g, ''),
    observacoes,
    avisoValidade: textoSemTags(avisoValidade),
    autenticidade: linkAut ? new URL(decodificarEntidades(linkAut[1]), TJES_FORM).href : TJES_AUTENTICIDADE,
  };
}

// Mensagens de erro que o formulário do TJES mostra quando recusa o envio.
function avisoTjes(html) {
  const textos = [];
  for (const m of html.matchAll(/<div class="v2-(?:aviso-erro|msg-erro)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) {
    const t = textoSemTags(m[1]);
    if (t) textos.push(t);
  }
  return textos.join(' ').slice(0, 400);
}

// "Válida até" vem da página; se faltar, soma a validade em dias à data de expedição.
function calcularValidade(c) {
  const ate = /(\d{2})\/(\d{2})\/(\d{4})/.exec(c.validaAte || '');
  if (ate) return ate[0];
  const exp = /(\d{2})\/(\d{2})\/(\d{4})/.exec(c.expedicao || '');
  const dias = /(\d+)\s*dias?/i.exec(c.validade || '') || /(\d+)\s*\(/.exec(c.avisoValidade || '');
  if (!exp || !dias) return '';
  return dataBr(new Date(Date.UTC(+exp[3], +exp[2] - 1, +exp[1] + Number(dias[1]))));
}

function montarPdfTjes(c, doc, agora) {
  const emitida = (/(\d{2}\/\d{2}\/\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?/.exec(c.expedicao) || []);
  const validaAte = calcularValidade(c);
  const blocos = [];
  c.orgao.forEach((t, i) => blocos.push({ texto: t, tamanho: i === c.orgao.length - 1 ? 13 : 11, negrito: true, centro: true }));
  c.endereco.forEach((t) => blocos.push({ texto: t, tamanho: 8, centro: true }));
  blocos.push({ texto: c.titulo, tamanho: 12, negrito: true, centro: true, antes: 14 });
  if (c.natureza) blocos.push({ texto: c.natureza, tamanho: 10, negrito: true, centro: true });
  blocos.push({ texto: 'Natureza consultada: ' + TJES_NATUREZA + ' (1ª Instância)', tamanho: 9, centro: true, antes: 2 });
  blocos.push({ texto: c.resultadoTitulo || 'Resultado', tamanho: 14, negrito: true, centro: true, antes: 14 });
  if (c.resultadoTexto) blocos.push({ texto: c.resultadoTexto, tamanho: 10, antes: 4 });
  if (c.outras) {
    blocos.push({ texto: 'Informações da certidão', tamanho: 11, negrito: true, antes: 12 });
    blocos.push({ texto: c.outras, tamanho: 9 });
  }
  blocos.push({ texto: 'Dados da Certidão', tamanho: 11, negrito: true, antes: 12 });
  blocos.push({ texto: 'Razão social: ' + c.razaoSocial, antes: 2 });
  blocos.push({ texto: 'CNPJ: ' + formatarCnpj(doc) });
  if (c.comarca) blocos.push({ texto: 'Comarca: ' + c.comarca });
  blocos.push({ texto: 'Número da certidão: ' + c.numero });
  blocos.push({ texto: 'Emitida em ' + emitida[1] + (emitida[2] ? ' às ' + emitida[2] : '') });
  if (validaAte) blocos.push({ texto: 'Válida até ' + validaAte + (c.validade ? ' (validade de ' + c.validade + ')' : '') });
  blocos.push({ texto: 'Verificação de autenticidade', tamanho: 11, negrito: true, antes: 12 });
  blocos.push({ texto: c.autenticidade, antes: 2 });
  blocos.push({ texto: 'Informe o número ' + c.numero + ' no endereço acima para confirmar a certidão no site do TJES.', tamanho: 9 });
  if (c.observacoes.length) {
    blocos.push({ texto: 'Observações', tamanho: 10, negrito: true, antes: 12 });
    c.observacoes.forEach((t, i) => blocos.push({ texto: (i + 1) + '. ' + t, tamanho: 8, antes: 1 }));
  }
  if (c.avisoValidade) blocos.push({ texto: c.avisoValidade, tamanho: 10, negrito: true, centro: true, antes: 12 });
  const rodape = 'Documento montado pelo Service Hub a partir da página oficial do TJES em ' + agoraBrasilia(agora) + '. Confira a autenticidade no endereço acima.';
  return gerarPdf(blocos, { rodape, titulo: 'Certidão TJES ' + c.numero });
}

async function buscarTjes(sessao, doc, nome, agora) {
  const html = exigirPaginaOk(await sessao.pedir(TJES_FORM), 'abertura');
  const natureza = valorNaturezaTjes(html);
  if (!/id="v2Form"/.test(html) || !/name="edCnpj"/.test(html) || !/name="edRazaoSocial"/.test(html) || !natureza) {
    throw erro('falhou', 'O formulário do TJES mudou de formato.');
  }

  // O POST devolve redirecionamento para /resultado (mesmo site), que a sessão segue com GET.
  const res = exigirPaginaOk(await sessao.pedir(TJES_FORM, {
    referer: TJES_FORM,
    formulario: {
      rbPessoa: 'J', edCpf: '', edCnpj: formatarCnpj(doc), edPrimeiroNome: '', edRazaoSocial: nome,
      edMae: '', edPai: '', cbInstancia: '1', cbNatureza: natureza, cbNaturezaAux: TJES_NATUREZA, btnAvancar: '',
    },
  }), 'consulta');

  const c = lerCertidaoTjes(res);
  // Só aceita página que de fato mostrou a certidão do condomínio pedido.
  if (!c || !c.numero || !/\d{2}\/\d{2}\/\d{4}/.test(c.expedicao) || limparCnpj(c.cnpj) !== doc) {
    const aviso = avisoTjes(res);
    throw erro('falhou', 'O TJES não mostrou a certidão' + (aviso ? ': ' + aviso : '.'));
  }
  return { pdf: montarPdfTjes(c, doc, agora), nome_arquivo: 'Certidao_Falencia_TJES_' + doc + '.pdf' };
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

// Busca a certidão do tipo pedido. Devolve { pdf, nome_arquivo } (sempre começa com %PDF):
// o PDF oficial quando o site entrega um, ou o PDF montado da página oficial (TJES).
// Lança Error com .codigo 'manual' (precisa do navegador) ou 'falhou' (tentou e não deu).
// opcoes.fetch e opcoes.agora existem só para o teste trocar a rede e o relógio.
async function buscar(tipo, { cnpj, nome, cidade } = {}, opcoes = {}) {
  const cidadeNorm = normalizarCidade(cidade);
  if (tipo === 'municipal') {
    if (!LINKS_MUNICIPAIS[cidadeNorm]) throw erro('manual', 'Cidade do condomínio sem busca configurada: ' + (cidade || 'não informada') + '.');
    if (!CIDADES_AUTOMATICAS.has(cidadeNorm)) throw erro('manual', MOTIVO_MANUAL[cidadeNorm]);
  } else if (!LINKS[tipo]) {
    throw erro('manual', 'Tipo de certidão desconhecido: ' + tipo + '.');
  } else if (tipo !== 'falencia') {
    throw erro('manual', MOTIVO_MANUAL[tipo]);
  }

  const doc = limparCnpj(cnpj);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(doc)) throw erro('falhou', 'CNPJ do condomínio ausente ou inválido no cadastro.');
  const fetchImpl = opcoes.fetch || globalThis.fetch;
  if (tipo === 'falencia') {
    const razao = String(nome || '').replace(/\s+/g, ' ').trim();
    if (!razao) throw erro('falhou', 'Razão social do condomínio ausente no cadastro.');
    return naFila(() => buscarTjes(criarSessao(fetchImpl), doc, razao, opcoes.agora || new Date()));
  }
  return naFila(() => buscarVitoria(criarSessao(fetchImpl), doc));
}

module.exports = {
  TIPOS_AUTOMATICOS,
  buscar,
  linkPreenchido,
  ehAutomatica,
  // expostos para o teste
  _interno: { normalizarCidade, limparCnpj, camposOcultos, linkPdfVitoria, mensagemVitoria, decodificarEntidades, UA,
    gerarPdf, lerCertidaoTjes, valorNaturezaTjes, calcularValidade, formatarCnpj, quebrarLinhas },
};
