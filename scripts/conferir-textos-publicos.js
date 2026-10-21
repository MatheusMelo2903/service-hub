// T17: confere o que o navegador recebe (já compactado, sem comentários) e acusa
// qualquer pista de fornecedor, modelo ou de que há IA no sistema.
// Uso: NODE_PATH=... node scripts/conferir-textos-publicos.js   (sai com 1 se achar algo)
const fs = require('fs');
const path = require('path');
const { compactarJs, compactarHtml } = require('../servico/ofuscar');

const PROIBIDO = /(anthropic|claude|assembly ?ai|sonnet|\bopus\b|haiku|openai|chatgpt|whisper|gemini|deepgram|\bgpt\b|\bllm\b|intelig[eê]ncia artificial|prompt|max_tokens|machine learning|\bIA\b|\bI\.A\.)/g;
const PROIBIDO_I = /(anthropic|claude|assembly ?ai|sonnet|\bopus\b|haiku|openai|chatgpt|whisper|gemini|deepgram|\bgpt\b|\bllm\b|intelig[eê]ncia artificial|prompt|max_tokens|machine learning)/i;
const PERMITIDO = [/access_token/i, /refresh_token/i, /AUTH_TOKEN/, /accessToken/, /autoRefreshToken/];

(async () => {
  const pasta = path.join(__dirname, '..', 'public');
  let achados = 0;
  for (const n of fs.readdirSync(pasta).filter((x) => /\.(js|html)$/i.test(x))) {
    const bruto = fs.readFileSync(path.join(pasta, n), 'utf8');
    let saida;
    try { saida = /\.js$/i.test(n) ? await compactarJs(bruto, false) : await compactarHtml(bruto); }
    catch (e) { console.log('NAO COMPACTOU ' + n + ': ' + e.message); achados++; continue; }
    let m;
    // "IA" só em maiúsculas; nomes de fornecedor em qualquer caixa.
    const re = new RegExp(PROIBIDO_I.source + '|\\bIA\\b|\\bI\\.A\\.', 'gi');
    while ((m = re.exec(saida))) {
      if (/^ia$/i.test(m[0]) && m[0] !== 'IA') continue;
      // "prompt" da biblioteca de planilhas embutida e da caixa de pergunta do navegador não conta.
      if (/^prompt$/i.test(m[0]) && (n === 'previsao-modulo.html' || /=prompt\(/.test(saida.slice(m.index - 1, m.index + 7)))) continue;
      const trecho = saida.slice(Math.max(0, m.index - 50), m.index + 50).replace(/\s+/g, ' ');
      if (PERMITIDO.some((re) => re.test(trecho))) continue;
      console.log(n + ': ...' + trecho + '...');
      achados++;
    }
  }
  console.log(achados ? achados + ' achado(s)' : 'limpo');
  process.exit(achados ? 1 : 0);
})();
