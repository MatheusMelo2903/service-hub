// T17: o navegador recebe os arquivos do sistema sem comentários e compactados.
// Os comentários do código explicam como o sistema funciona por dentro; eles ficam só
// no repositório. Feito uma vez quando o servidor liga, em memória. Se algum arquivo
// não puder ser compactado, ele é servido como está (e o motivo vai para o log).

const fs = require('fs');
const path = require('path');

let terser = null;
try { terser = require('terser'); } catch (e) { terser = null; }

const OPCOES = (modulo) => ({ module: !!modulo, compress: false, mangle: false, format: { comments: false } });
const prontos = new Map(); // '/arquivo.js' -> { tipo, corpo }

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

async function preparar(pastaPublic) {
  if (!terser) { console.warn('[ofuscar] compactador não instalado; arquivos servidos como estão'); return; }
  const nomes = fs.readdirSync(pastaPublic).filter((n) => /\.(js|html)$/i.test(n));
  const t0 = Date.now();
  for (const n of nomes) {
    const bruto = fs.readFileSync(path.join(pastaPublic, n), 'utf8');
    try {
      const corpo = /\.js$/i.test(n) ? await compactarJs(bruto, false) : await compactarHtml(bruto);
      prontos.set('/' + n, { tipo: /\.js$/i.test(n) ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8', corpo: Buffer.from(corpo, 'utf8') });
    } catch (e) {
      console.warn('[ofuscar] ' + n + ' mantido como está: ' + e.message);
    }
  }
  console.log('[ofuscar] ' + prontos.size + ' arquivos prontos em ' + (Date.now() - t0) + 'ms');
}

function middleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const a = prontos.get(req.path);
  if (!a) return next();
  res.setHeader('Content-Type', a.tipo);
  res.setHeader('Cache-Control', 'no-cache');
  res.end(req.method === 'HEAD' ? undefined : a.corpo);
}

// Para as rotas que entregam páginas (/ e /hub).
function pagina(nome) { const a = prontos.get('/' + nome); return a ? a.corpo : null; }

module.exports = { preparar, middleware, pagina, compactarHtml, compactarJs };
