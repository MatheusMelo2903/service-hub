// ─────────────────────────────────────────────────────────────────────────
// HARNESS T01: documentos da assembleia na geração da ata.
// Gera a ata da fixture Casablanca (transcrição + edital, fora do repo) com e sem
// documentos de apoio e compara com o gabarito de valores e com o manifesto do gate.
// Dados de cliente NUNCA entram no repo: tudo é lido de ~/Downloads e a saída vai para
// /Users/matheusmelo/v8s/EXECUCAO/testes/T01.
//
// Rodar (o segredo é injetado pelo railway run, nunca impresso):
//   railway run --service service-hub --environment dev -- env BASE=http://localhost:3917 \
//     TAG=com-doc DOCS="/caminho/prestacao.pdf" node scripts/ata-harness/docs-apoio-harness.mjs
// Variáveis: BASE, TAG, DOCS (caminhos separados por ;), ESCANEADO=1 (manda PDF em base64),
// ERROS=1 (só roda os casos de erro de validação, sem gastar API).
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Tudo que identifica o cliente (nomes, datas, arquivos) vem de JSON fora do repo.
const OUT = process.env.OUT || '/Users/matheusmelo/v8s/EXECUCAO/testes/T01';
const CFG = JSON.parse(fs.readFileSync(path.join(OUT, 'fixture.json'), 'utf8'));
const GATE = CFG.gateManifesto;
const BASE = process.env.BASE || 'http://localhost:3917';
const SECRET = process.env.INTERNAL_API_SECRET || '';
const TAG = process.env.TAG || 'run';
const DOCS = (process.env.DOCS || '').split(';').map((s) => s.trim()).filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => { const l = '[' + new Date().toISOString() + '] ' + m; console.log(l); fs.appendFileSync(path.join(OUT, 'harness.log'), l + '\n'); };
const H = { Authorization: 'Bearer ' + SECRET, 'Content-Type': 'application/json' };

function userMessage() {
  const edital = fs.readFileSync(CFG.edital, 'utf8');
  const trans = fs.readFileSync(CFG.transcricao, 'utf8');
  return [
    '=== DADOS DA REUNIÃO ===',
    'Condomínio: ' + CFG.condominio,
    'Tipo: ' + CFG.tipo,
    'Data: ' + CFG.data,
    'Síndico: ' + CFG.sindico,
    'Local: ' + CFG.local,
    '',
    '=== ITENS DE PAUTA ===',
    '(extrair da transcrição e/ou dos editais anexados abaixo)',
    '\n=== EDITAIS / DOCUMENTOS ANEXADOS ===\n(Use o edital como fonte oficial dos pontos que DEVERIAM ser deliberados — a transcrição mostra o que DE FATO foi discutido. Cruze: edital + transcrição confirmando → registre com precisão; números/datas/valores do edital prevalecem como oficiais; transcrição contradiz edital → registre o efetivamente deliberado.)\n\n--- 1. (edital de convocação) [arquivo: ' + CFG.editalArquivo + '] ---\n' + edital + '\n',
    '=== PARTICIPANTES ===',
    '(extrair da transcrição; se não identificáveis, use [a confirmar])',
    '',
    '=== TRANSCRIÇÃO COMPLETA DA REUNIÃO ===',
    trans,
    '',
    'Gere a ata completa seguindo todas as regras e estrutura do sistema. Use [a confirmar] em qualquer dado ausente.'
  ].join('\n');
}

function documentos() {
  return DOCS.map((p) => {
    const nome = path.basename(p);
    if (process.env.ESCANEADO === '1') return { nome, texto: '', pdf_base64: fs.readFileSync(p).toString('base64') };
    const texto = execFileSync('pdftotext', ['-layout', p, '-'], { maxBuffer: 50 * 1024 * 1024 }).toString('utf8');
    return { nome, texto };
  });
}

async function post(body) {
  const r = await fetch(BASE + '/api/atas/gerar', { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function casosDeErro() {
  const um = userMessage();
  const casos = [
    ['documentos nao lista', { userMessage: um, documentos: 'x' }],
    ['7 documentos', { userMessage: um, documentos: Array.from({ length: 7 }, (_, i) => ({ nome: 'd' + i + '.pdf', texto: 'abc' })) }],
    ['base64 invalido', { userMessage: um, documentos: [{ nome: 'x.pdf', pdf_base64: '<<<nao base64>>>' }] }],
    ['4 escaneados', { userMessage: um, documentos: Array.from({ length: 4 }, (_, i) => ({ nome: 's' + i + '.pdf', pdf_base64: 'JVBERi0xLjQK' })) }]
  ];
  let ok = 0;
  for (const [nome, body] of casos) {
    const r = await post(body);
    const passou = r.status === 400 && r.json.erro === 'documentos_invalidos';
    if (passou) ok++;
    log('ERRO ' + nome + ': HTTP ' + r.status + ' ' + JSON.stringify(r.json) + (passou ? ' PASS' : ' FAIL'));
  }
  const semAuth = await fetch(BASE + '/api/atas/gerar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  log('ERRO sem auth: HTTP ' + semAuth.status + (semAuth.status === 401 ? ' PASS' : ' FAIL'));
  log('casos de erro: ' + ok + '/' + casos.length + ' + auth');
}

function canonSet(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/g)) {
    const n = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
    if (!isNaN(n) && n > 0) set.add(n.toFixed(2));
  }
  return set;
}

async function gerar() {
  const body = { userMessage: userMessage(), documentos: documentos() };
  log(TAG + ': docs=' + body.documentos.map((d) => d.nome + '(' + (d.texto || '').length + 'c' + (d.pdf_base64 ? ', escaneado' : '') + ')').join(', '));
  const r0 = await post(body);
  if (r0.status !== 202) throw new Error('POST ' + r0.status + ' ' + JSON.stringify(r0.json));
  const jobId = r0.json.jobId;
  const t0 = Date.now();
  let p;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await fetch(BASE + '/api/atas/gerar/status/' + jobId, { headers: H });
    p = await s.json().catch(() => ({}));
    if (p.status === 'done' || p.status === 'error') break;
    if (Date.now() - t0 > 30 * 60 * 1000) throw new Error('timeout 30min');
  }
  const seg = Math.round((Date.now() - t0) / 1000);
  if (p.status === 'error') { log(TAG + ': ERRO ' + JSON.stringify(p)); return; }
  fs.writeFileSync(path.join(OUT, TAG + '-ata.txt'), p.ata);
  const meta = Object.assign({}, p); delete meta.ata;
  fs.writeFileSync(path.join(OUT, TAG + '-payload.json'), JSON.stringify(meta, null, 2));
  // Comparação com gabarito de valores e manifesto do gate.
  // Gabarito de valores (fora do repo: dado financeiro de cliente).
  const GAB = JSON.parse(fs.readFileSync(path.join(OUT, 'gabarito-valores.json'), 'utf8'));
  const c = canonSet(p.ata);
  const faltam = GAB.filter((v) => !c.has(v));
  const extras = [...c].filter((v) => !GAB.includes(v));
  const gate = JSON.parse(fs.readFileSync(GATE, 'utf8'));
  const marcaConferir = (p.ata.match(/\[conferir:[^\]]*\]/g) || []);
  // Nomes que NÃO existem na fonte (lista da fixture, fora do repo).
  const fNomes = path.join(OUT, 'nomes-inventados.json');
  const nomesProibidos = fs.existsSync(fNomes) ? JSON.parse(fs.readFileSync(fNomes, 'utf8')) : gate.sinalizarNome;
  const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inventados = nomesProibidos.filter((n) => new RegExp('(?<![A-Za-zÀ-ÿ\\[\'])' + esc(n) + '(?![A-Za-zÀ-ÿ])').test(p.ata.replace(/\[[^\]]*\]/g, ' ')));
  log(TAG + ': ' + seg + 's, ' + p.ata.length + ' chars, auditoria=' + p.auditoria + ', modelo=' + p.modelo_usado);
  log(TAG + ': gabarito faltando=' + JSON.stringify(faltam) + ' | valores fora do gabarito=' + JSON.stringify(extras));
  log(TAG + ': 355.000 sem marca=' + /R\$\s*355\.000,00(?!\s*\])/.test(p.ata.replace(/\[[^\]]*\]/g, ' ')) + ' | nomes inventados fora de marcador=' + JSON.stringify(inventados) + ' | gate=' + (p.gate && p.gate.veredicto) + ' flags=' + (p.gate ? p.gate.flags.length : '?'));
  log(TAG + ': [conferir] x' + marcaConferir.length + ' ' + JSON.stringify(marcaConferir.slice(0, 15)));
  log(TAG + ': conferencia=' + JSON.stringify(p.conferencia) + ' documentos=' + JSON.stringify(p.documentos) + ' avisos=' + JSON.stringify(p.avisos));
  log(TAG + ': flags esperadas no manifesto=' + gate.flagsEsperadas);
}

if (process.env.ERROS === '1') await casosDeErro();
else await gerar();
