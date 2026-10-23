// Copia o acervo de regras (vindo do CondGPT) do banco de teste para o de produção, uma vez só.
// Uso (no Mac, com o Railway ligado ao projeto):
//   railway run -e dev -s <service-hub> node scripts/copiar-acervo-producao.js exportar /tmp/acervo
//   railway run -e production -s <service-hub> node scripts/copiar-acervo-producao.js importar /tmp/acervo
// As chaves vêm do ambiente (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY); nada é impresso.
// Os ids dos documentos mudam na produção; trechos e mandatos são religados pelo id novo.
// Quem criou (criado_por) fica vazio: os usuários do teste não existem na produção.
const fs = require('fs');
const path = require('path');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const [, , modo, dir] = process.argv;
if (!['exportar', 'importar'].includes(modo) || !dir) { console.error('uso: exportar|importar <pasta>'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const TABELAS = ['regras_documentos', 'regras_trechos', 'regras_notificacoes', 'regras_mandatos', 'regras_mapa_condgpt', 'regras_faq', 'config_geral'];

async function lerTudo(t) {
  const linhas = [];
  for (let de = 0; ; de += 1000) {
    const r = await fetch(URL + '/rest/v1/' + t + '?select=*&order=' + (t === 'regras_mapa_condgpt' ? 'slug' : t === 'config_geral' ? 'chave' : 'id'), { headers: { ...H, Range: de + '-' + (de + 999) } });
    if (!r.ok) throw new Error(t + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const b = await r.json();
    linhas.push(...b);
    if (b.length < 1000) break;
  }
  return linhas;
}

async function exportar() {
  fs.mkdirSync(path.join(dir, 'arquivos'), { recursive: true });
  for (const t of TABELAS) {
    const l = await lerTudo(t);
    fs.writeFileSync(path.join(dir, t + '.json'), JSON.stringify(l));
    console.log(t + ': ' + l.length);
  }
  const docs = JSON.parse(fs.readFileSync(path.join(dir, 'regras_documentos.json')));
  const caminhos = [...new Set(docs.map((d) => d.arquivo_path).filter(Boolean))];
  let ok = 0, falha = 0;
  for (let i = 0; i < caminhos.length; i += 8) {
    await Promise.all(caminhos.slice(i, i + 8).map(async (c) => {
      const r = await fetch(URL + '/storage/v1/object/regras/' + c.split('/').map(encodeURIComponent).join('/'), { headers: H });
      if (!r.ok) { falha++; return; }
      const destino = path.join(dir, 'arquivos', c);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
      ok++;
    }));
  }
  console.log('arquivos baixados: ' + ok + ', falhas: ' + falha);
}

async function inserir(t, linhas, retorno) {
  const r = await fetch(URL + '/rest/v1/' + t, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Prefer: retorno ? 'return=representation' : 'return=minimal' }, body: JSON.stringify(linhas),
  });
  if (!r.ok) throw new Error(t + ' ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return retorno ? r.json() : null;
}

async function importar() {
  const ler = (t) => JSON.parse(fs.readFileSync(path.join(dir, t + '.json')));
  // Produção precisa estar vazia nessas tabelas (cópia única, sem duplicar).
  for (const t of ['regras_documentos', 'regras_notificacoes', 'regras_mapa_condgpt']) {
    const r = await fetch(URL + '/rest/v1/' + t + '?select=*&limit=1', { headers: H });
    if ((await r.json()).length) throw new Error(t + ' já tem dados na produção; nada foi copiado');
  }
  const docs = ler('regras_documentos');
  const mapa = new Map();
  for (const d of docs) {
    const { id, criado_por, ...resto } = d;
    const [novo] = await inserir('regras_documentos', [{ ...resto, criado_por: null }], true);
    mapa.set(String(id), novo.id);
  }
  console.log('documentos: ' + mapa.size);
  const trechos = ler('regras_trechos').map(({ id, tsv, documento_id, ...r }) => ({ ...r, documento_id: mapa.get(String(documento_id)) }));
  for (let i = 0; i < trechos.length; i += 500) await inserir('regras_trechos', trechos.slice(i, i + 500));
  console.log('trechos: ' + trechos.length);
  const notif = ler('regras_notificacoes').map(({ id, criado_por, ...r }) => ({ ...r, criado_por: null }));
  for (let i = 0; i < notif.length; i += 500) await inserir('regras_notificacoes', notif.slice(i, i + 500));
  console.log('notificacoes: ' + notif.length);
  const mand = ler('regras_mandatos').map(({ id, documento_id, ...r }) => ({ ...r, documento_id: documento_id == null ? null : (mapa.get(String(documento_id)) || null) }));
  if (mand.length) await inserir('regras_mandatos', mand);
  console.log('mandatos: ' + mand.length);
  const mapaCg = ler('regras_mapa_condgpt');
  if (mapaCg.length) await inserir('regras_mapa_condgpt', mapaCg);
  console.log('mapa condgpt: ' + mapaCg.length);
  const faq = ler('regras_faq').map(({ id, ...r }) => r);
  if (faq.length) await inserir('regras_faq', faq);
  const cfg = ler('config_geral').map((c) => ({ ...c, atualizado_por: null }));
  if (cfg.length) await fetch(URL + '/rest/v1/config_geral', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(cfg) });
  console.log('config_geral: ' + cfg.length);
  // Arquivos no bucket privado "regras", no mesmo caminho.
  const raiz = path.join(dir, 'arquivos');
  const todos = [];
  (function andar(p) { for (const n of fs.readdirSync(p)) { const c = path.join(p, n); if (fs.statSync(c).isDirectory()) andar(c); else todos.push(c); } })(raiz);
  let ok = 0, falha = 0;
  for (let i = 0; i < todos.length; i += 6) {
    await Promise.all(todos.slice(i, i + 6).map(async (f) => {
      const rel = path.relative(raiz, f).split(path.sep).map(encodeURIComponent).join('/');
      const r = await fetch(URL + '/storage/v1/object/regras/' + rel, { method: 'POST', headers: { ...H, 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: fs.readFileSync(f) });
      if (r.ok) ok++; else falha++;
    }));
  }
  console.log('arquivos enviados: ' + ok + ', falhas: ' + falha);
}

(modo === 'exportar' ? exportar() : importar()).catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
