'use strict';
// Gravação nas tabelas fin_* pelo PostgREST com service_role (só no servidor).
// Trava: só grava no Supabase de TESTE enquanto a produção não for autorizada.
const https = require('https');

const REFS_PERMITIDAS = ['ledgyprytkuvgtbunsck'];
const LOTE = 500;

function criarBanco({ url, chave }) {
  if (!url || !chave) throw new Error('supabase_nao_configurado');
  const ref = (String(url).match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/) || [])[1];
  if (!ref || !REFS_PERMITIDAS.includes(ref)) throw new Error('supabase_nao_permitido');

  function req(method, caminho, corpo, prefer) {
    const u = new URL(url.replace(/\/$/, '') + caminho);
    const payload = corpo === undefined ? null : JSON.stringify(corpo);
    return new Promise((resolve) => {
      const r = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method,
        headers: {
          apikey: chave, authorization: 'Bearer ' + chave, 'content-type': 'application/json',
          ...(prefer ? { prefer } : {}),
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, (resp) => {
        const partes = [];
        resp.on('data', (c) => partes.push(c));
        resp.on('end', () => {
          const s = Buffer.concat(partes).toString('utf8');
          let json = null;
          try { json = s ? JSON.parse(s) : null; } catch (e) { json = { raw: s.slice(0, 300) }; }
          resolve({ status: resp.statusCode, body: json });
        });
        resp.on('error', () => resolve({ status: 0, body: null }));
      });
      r.setTimeout(120000, () => { r.destroy(); resolve({ status: 504, body: null }); });
      r.on('error', () => resolve({ status: 0, body: null }));
      if (payload) r.write(payload);
      r.end();
    });
  }

  // Upsert em lotes; repete o lote em falha de rede ou 5xx. Devolve quantas linhas gravou.
  // Linhas repetidas pela chave viram uma só (a última), senão o Postgres recusa o lote.
  async function upsert(tabela, linhasBrutas, conflito) {
    const cols = conflito.split(',');
    const unicas = new Map();
    linhasBrutas.forEach((l) => unicas.set(cols.map((c) => l[c]).join('|'), l));
    const linhas = [...unicas.values()];
    let gravados = 0;
    for (let i = 0; i < linhas.length; i += LOTE) {
      const lote = linhas.slice(i, i + LOTE);
      let r = null;
      for (let t = 0; t < 4; t++) {
        r = await req('POST', '/rest/v1/' + tabela + '?on_conflict=' + conflito, lote, 'resolution=merge-duplicates,return=minimal');
        if (r.status >= 200 && r.status < 300) break;
        if (r.status && r.status < 500 && r.status !== 429) break;
        await new Promise((ok) => setTimeout(ok, 2000 * (t + 1)));
      }
      if (!(r.status >= 200 && r.status < 300)) {
        const e = new Error('supabase_upsert_' + tabela + '_' + r.status);
        e.detalhe = r.body && (r.body.message || r.body.raw || r.body.hint);
        throw e;
      }
      gravados += lote.length;
    }
    return gravados;
  }

  async function inserir(tabela, linha) {
    const r = await req('POST', '/rest/v1/' + tabela, linha, 'return=minimal');
    return r.status >= 200 && r.status < 300;
  }

  async function ler(caminho) {
    const r = await req('GET', '/rest/v1/' + caminho);
    if (r.status !== 200) throw new Error('supabase_ler_' + r.status);
    return r.body;
  }

  return { upsert, inserir, ler };
}

module.exports = { criarBanco, REFS_PERMITIDAS };
