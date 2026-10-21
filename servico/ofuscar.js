// T17: o navegador recebe os arquivos do sistema sem comentários e compactados.
// Os comentários do código explicam como o sistema funciona por dentro; eles ficam só
// no repositório. Feito uma vez quando o servidor liga, em memória.
// Revisão 2 (falha fechada): enquanto não termina, .js e .html da pasta pública respondem 503;
// sem o compactador, ou se um arquivo falhar nele, vai a limpeza simples (tira linhas de
// comentário e blocos /* */ que começam a linha), nunca o arquivo cru.

const fs = require('fs');
const path = require('path');

let terser = null;
try { terser = require('terser'); } catch (e) { terser = null; }

const OPCOES = (modulo) => ({ module: !!modulo, compress: false, mangle: false, format: { comments: false } });
const prontos = new Map(); // '/arquivo.js' -> { tipo, corpo }
const esperados = new Set(); // '/arquivo.js' que ainda não ficaram prontos
let terminou = false;

// Reserva sem compactador: só tira o que com certeza é comentário (linha inteira).
function limparJsSimples(codigo) {
  return codigo
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}
function limparHtmlSimples(html) {
  const partes = []; const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let ultimo = 0; let m;
  while ((m = re.exec(html))) {
    partes.push(limparForaDeScript(html.slice(ultimo, m.index)));
    partes.push('<script' + (m[1] || '') + '>' + limparJsSimples(m[2]) + '</script>');
    ultimo = re.lastIndex;
  }
  partes.push(limparForaDeScript(html.slice(ultimo)));
  return partes.join('');
}

async function compactarJs(codigo, modulo) {
  const r = await terser.minify(codigo, OPCOES(modulo));
  if (!r || typeof r.code !== 'string') throw new Error('sem saída');
  return r.code;
}

// Fora dos scripts: tira comentários de HTML e de CSS.
function limparForaDeScript(trecho) {
  return trecho.replace(/<!--(?!\[if)[\s\S]*?-->/g, '')
    .replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) => '<style' + attrs + '>' + css.replace(/\/\*[\s\S]*?\*\//g, '') + '</style>');
}

async function compactarHtml(html) {
  const saida = html;
  const partes = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let ultimo = 0; let m;
  while ((m = re.exec(saida))) {
    const attrs = m[1] || '';
    partes.push(limparForaDeScript(saida.slice(ultimo, m.index)));
    const tipo = (attrs.match(/type\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '';
    const ehJs = !/\ssrc\s*=/i.test(attrs) && (!tipo || /javascript|module/i.test(tipo)) && m[2].trim();
    if (ehJs) {
      try { partes.push('<script' + attrs + '>' + (await compactarJs(m[2], /module/i.test(tipo))) + '</script>'); }
      catch (e) { console.warn('[ofuscar] script embutido mantido como está: ' + e.message); partes.push(m[0]); }
    } else partes.push(m[0]);
    ultimo = re.lastIndex;
  }
  partes.push(limparForaDeScript(saida.slice(ultimo)));
  return partes.join('');
}

function listar(pastaPublic) {
  return fs.readdirSync(pastaPublic).filter((n) => /\.(js|html)$/i.test(n));
}
// Chamar logo no boot (síncrono): a partir daqui os arquivos só saem limpos.
function registrar(pastaPublic) {
  try { listar(pastaPublic).forEach((n) => esperados.add('/' + n)); } catch (e) { console.error('[ofuscar] não listou a pasta: ' + e.message); }
}

async function preparar(pastaPublic) {
  registrar(pastaPublic);
  if (!terser) console.error('[ofuscar] compactador não instalado; usando a limpeza simples');
  const nomes = listar(pastaPublic);
  const t0 = Date.now();
  let simples = 0;
  for (const n of nomes) {
    const bruto = fs.readFileSync(path.join(pastaPublic, n), 'utf8');
    const ehJs = /\.js$/i.test(n);
    let corpo;
    try {
      if (!terser) throw new Error('sem compactador');
      corpo = ehJs ? await compactarJs(bruto, false) : await compactarHtml(bruto);
    } catch (e) {
      if (terser) console.error('[ofuscar] ' + n + ' com limpeza simples: ' + e.message);
      corpo = ehJs ? limparJsSimples(bruto) : limparHtmlSimples(bruto);
      simples++;
    }
    prontos.set('/' + n, { tipo: ehJs ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8', corpo: Buffer.from(corpo, 'utf8') });
  }
  terminou = true;
  console.log('[ofuscar] ' + prontos.size + ' arquivos prontos (' + simples + ' com limpeza simples) em ' + (Date.now() - t0) + 'ms');
}

function middleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const a = prontos.get(req.path);
  if (!a) {
    if (!terminou && esperados.has(req.path)) { res.setHeader('Retry-After', '5'); return res.status(503).end('Sistema iniciando. Tente de novo em alguns segundos.'); }
    return next();
  }
  res.setHeader('Content-Type', a.tipo);
  res.setHeader('Cache-Control', 'no-cache');
  res.end(req.method === 'HEAD' ? undefined : a.corpo);
}

// Para as rotas que entregam páginas (/ e /hub).
function aguardando(caminho) { return !terminou && esperados.has(caminho); }
function pagina(nome) { const a = prontos.get('/' + nome); return a ? a.corpo : null; }

module.exports = { preparar, registrar, aguardando, middleware, pagina, compactarHtml, compactarJs, limparJsSimples, limparHtmlSimples };
