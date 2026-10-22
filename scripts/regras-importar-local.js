// Importa o acervo exportado do sistema antigo direto no banco, sem passar pelo navegador
// (o arquivo tem ~44 MB). Usa as mesmas funções da rota /api/regras/importar/*.
// Uso (no Mac, com as variáveis do ambiente de teste):
//   railway run --service service-hub --environment dev -- node scripts/regras-importar-local.js <arquivo.json> [--sem-pdf]
// Pode rodar de novo: documentos e notificações já importados não se repetem.

const fs = require('fs');
const https = require('https');
const I = require('../servico/regras/importar-condgpt');
const slDados = require('../superlogica-dados');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const CHAVE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SL = {
  base: (process.env.SUPERLOGICA_API_BASE || 'https://api.superlogica.net').replace(/\/+$/, ''),
  appToken: process.env.SUPERLOGICA_APP_TOKEN || '',
  accessToken: process.env.SUPERLOGICA_ACCESS_TOKEN || '',
};

// Mesmo formato do supabaseAdminRequest do servidor: { status, body }.
function banco(method, caminho, body) {
  const url = new URL(SUPABASE_URL + caminho);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const r = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method,
      headers: Object.assign({ apikey: CHAVE, authorization: 'Bearer ' + CHAVE, 'content-type': 'application/json' },
        payload ? { 'content-length': Buffer.byteLength(payload) } : {},
        ['PATCH', 'POST', 'DELETE'].includes(method) ? { prefer: 'return=representation' } : {}),
    }, (resp) => {
      const partes = [];
      resp.on('data', (c) => partes.push(c));
      resp.on('end', () => {
        const d = Buffer.concat(partes).toString('utf8');
        let json = null; try { json = d ? JSON.parse(d) : null; } catch (e) { json = { raw: d.slice(0, 300) }; }
        resolve({ status: resp.statusCode, body: json });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: { erro: e.message } }));
    if (payload) r.write(payload);
    r.end();
  });
}

// Envio de PDF ao bucket (mesmo comportamento do supabaseStorageUpload do servidor).
function storageUpload(bucket, caminho, buffer, tipo) {
  const url = new URL(SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + caminho);
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { authorization: 'Bearer ' + CHAVE, apikey: CHAVE, 'content-type': tipo, 'content-length': buffer.length, 'x-upsert': 'true' },
    }, (resp) => {
      let b = '';
      resp.on('data', (c) => { b += c; });
      resp.on('end', () => (resp.statusCode >= 200 && resp.statusCode < 300 ? resolve({}) : reject(new Error('storage ' + resp.statusCode))));
    });
    r.on('error', reject);
    r.write(buffer); r.end();
  });
}

async function principal() {
  const arquivo = process.argv[2];
  const semPdf = process.argv.includes('--sem-pdf');
  const soPdf = process.argv.includes('--so-pdf'); // só copia os PDFs que faltam (textos já importados)
  if (!arquivo || !SUPABASE_URL || !CHAVE || !SL.appToken) { console.error('Uso: railway run ... node scripts/regras-importar-local.js <arquivo.json> (faltam variáveis ou arquivo)'); process.exit(1); }
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const blocos = dados.condominios || {};
  const conds = Object.entries(blocos).map(([slug, b]) => ({ slug, label: b.label, cnpj: (b.dados && b.dados.inscricao) || '' }));

  // 1. Mapa pelo CNPJ.
  const cliente = slDados.criarCliente(SL);
  const [lista, existentes] = await Promise.all([slDados.listarCondominiosSuperlogica(cliente), I.lerMapa(banco)]);
  const linhas = I.montarMapa(conds, lista, existentes);
  await I.gravarMapa(banco, linhas, existentes);
  const porSituacao = {};
  linhas.forEach((l) => { porSituacao[l.situacao] = (porSituacao[l.situacao] || 0) + 1; });
  console.log('MAPA', JSON.stringify(porSituacao));
  linhas.filter((l) => !l.id_superlogica).forEach((l) => console.log('  sem código:', l.slug, l.situacao, l.observacao || ''));

  // 2. Importa cada condomínio ligado.
  const tot = { erros: 0, pdfs: [] };
  const somar = (alvo, obj) => Object.entries(obj || {}).forEach(([k, v]) => { if (typeof v === 'number') alvo[k] = (alvo[k] || 0) + v; });
  const soma = { documentos: {}, notificacoes: {}, comunicados: {}, atas_geradas: {} };
  for (const l of linhas) {
    if (soPdf) break;
    if (!l.id_superlogica || I.SLUGS_IGNORADOS[l.slug]) continue;
    try {
      const r = await I.importarCondominio(banco, { slug: l.slug, idSL: Number(l.id_superlogica), cnpj: l.cnpj || null, criadoPor: null }, blocos[l.slug]);
      Object.keys(soma).forEach((k) => somar(soma[k], r[k]));
      tot.erros += (r.erros || []).length;
      tot.pdfs.push(...(r.pdfs || []));
      console.log('OK', l.slug, '->', l.id_superlogica, JSON.stringify({ documentos: r.documentos, notificacoes: r.notificacoes, erros: (r.erros || []).length }));
      (r.erros || []).slice(0, 3).forEach((e) => console.log('   erro:', JSON.stringify(e).slice(0, 200)));
    } catch (e) {
      tot.erros++;
      console.log('FALHOU', l.slug, e && e.message);
    }
  }
  Object.assign(tot, soma);
  console.log('TOTAL', JSON.stringify(Object.assign({}, tot, { pdfs: tot.pdfs.length })));
  if (semPdf) return;

  // 3. Copia os PDFs (e os que ficaram de rodadas anteriores).
  const pend = await I.pendentesPdf(banco);
  const fila = I.criarFilaPdf({ banco, storageUpload, simultaneos: 4 });
  fila.enfileirar(tot.pdfs.concat(pend));
  const t0 = Date.now();
  const relogio = setInterval(() => {
    const s = fila.status();
    console.log('PDF', s.copiados + '/' + s.total, 'falhas', s.falhas, Math.round((Date.now() - t0) / 1000) + 's');
  }, 30000);
  await fila.ocioso();
  clearInterval(relogio);
  const s = fila.status();
  console.log('PDF FIM', JSON.stringify({ total: s.total, copiados: s.copiados, falhas: s.falhas }));
  (s.ultimas_falhas || []).slice(0, 10).forEach((f) => console.log('  falha', f.documento_id, f.motivo));
}

principal().catch((e) => { console.error('ERRO', e && e.message); process.exit(1); });
