// T17: chamada ao serviço de processamento de texto, SÓ no servidor.
// O navegador nunca vê instrução, nome de modelo, fornecedor nem resposta bruta:
// as rotas devolvem só o resultado já tratado. Erros saem genéricos para o usuário;
// o detalhe técnico fica só no log do servidor.

const https = require('https');

const CHAVE = () => process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '';

// Uso de tokens por pessoa (para a auditoria e para medir o cache). Memória do processo.
const _uso = [];
function registrarUso(info) {
  _uso.push(Object.assign({ em: Date.now() }, info));
  if (_uso.length > 5000) _uso.splice(0, _uso.length - 5000);
}
function usoRecente() { return _uso.slice(); }

// system: string; content: string ou lista de blocos; cache: marca o system para reaproveitar.
function chamarModelo({ modelo, maxTokens, system, content, cache, timeoutMs, rotulo, usuario }) {
  return new Promise((resolve) => {
    if (!CHAVE()) return resolve({ ok: false, status: 503, erro: 'servico_indisponivel' });
    const corpo = { model: modelo, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
    if (system) corpo.system = cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
    const body = JSON.stringify(corpo);
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': CHAVE(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs || 300000,
    }, (resp) => {
      const partes = [];
      resp.on('data', (c) => partes.push(c));
      resp.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (e) { j = null; }
        if (!j) { console.error('[processamento] ' + (rotulo || '') + ' resposta ilegível, status ' + resp.statusCode); return resolve({ ok: false, status: 502, erro: 'resposta_invalida' }); }
        if (j.usage) registrarUso({ rotulo, usuario, entrada: j.usage.input_tokens || 0, saida: j.usage.output_tokens || 0, cache_lido: j.usage.cache_read_input_tokens || 0, cache_criado: j.usage.cache_creation_input_tokens || 0 });
        if (resp.statusCode !== 200) {
          console.error('[processamento] ' + (rotulo || '') + ' status ' + resp.statusCode + ' ' + (j.error && j.error.type || ''));
          return resolve({ ok: false, status: resp.statusCode, erro: 'falha_processamento' });
        }
        const texto = (Array.isArray(j.content) ? j.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
        resolve({ ok: !!texto, status: 200, texto, cortado: j.stop_reason === 'max_tokens' });
      });
    });
    req.on('timeout', () => { req.destroy(); console.error('[processamento] ' + (rotulo || '') + ' timeout'); resolve({ ok: false, status: 504, erro: 'tempo_esgotado' }); });
    req.on('error', (e) => { console.error('[processamento] ' + (rotulo || '') + ' rede: ' + e.message); resolve({ ok: false, status: 502, erro: 'falha_processamento' }); });
    req.write(body); req.end();
  });
}

// Tira cercas de bloco de código e devolve o JSON (objeto) ou null.
function extrairJson(texto) {
  const t = String(texto || '');
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = (m ? m[1] : t).trim();
  try { return JSON.parse(s); } catch (e) { /* tenta achar o primeiro objeto */ }
  const i = s.indexOf('{'); const f = s.lastIndexOf('}');
  if (i >= 0 && f > i) { try { return JSON.parse(s.slice(i, f + 1)); } catch (e) { return null; } }
  return null;
}

module.exports = { chamarModelo, extrairJson, usoRecente };
