/*
 * Prova pontual (read only): pega linhas reais do Villaggio (W045A) com
 * Telefone vazio, roda a pre-correcao de deslocamento + parseW045AContatos, e
 * mostra se UNIDADE, NOME e DOCUMENTO (CPF/CNPJ) caem no lugar certo.
 * CEP fora de escopo (nao entra no import).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const XLSX = require('xlsx');
const { criarContexto } = require('./shims');

const MOTOR = path.join(__dirname, 'motor-extraido.js');
const DIR = process.env.IMPORT_UNIDADES_FIXTURES_DIR || path.join(os.homedir(), 'Downloads');
const ARQ = process.argv[2] || 'Cadastro das unidades - COMERCIAL (4).xlsx';

const ctx = criarContexto();
new vm.Script(fs.readFileSync(MOTOR, 'utf8'), { filename: 'motor-extraido.js' }).runInContext(ctx);

const wb = XLSX.readFile(path.join(DIR, ARQ), { cellDates: true });
const ws = wb.Sheets[wb.SheetNames[0]];
const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'DD/MM/YYYY' });

const headerIdx = ctx.detectarLinhaCabecalho(allRows);
const headers = (allRows[headerIdx] || []).map((s) => String(s || '').trim());
const rows = allRows.slice(headerIdx + 1);

const h = headers.map((s) => s.toLowerCase());
const idxOf = (preds) => { for (let i = 0; i < h.length; i++) for (const p of preds) if (h[i].indexOf(p) !== -1) return i; return -1; };
const iUni = idxOf(['unidade']);
const iNome = idxOf(['nome']);
const iTel = idxOf(['telefone']);
const iDoc = idxOf(['cpf', 'cnpj']);

const digs = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const docStatus = (v) => { const d = digs(v); if (d.length === 11) return 'CPF valido'; if (d.length === 14) return 'CNPJ valido'; return d ? ('INVALIDO (' + d.length + ' digitos)') : 'vazio'; };

const corr = ctx.corrigirDeslocamentoW045A(headers, rows);
let mudou = 0;
for (let i = 0; i < rows.length; i++) if (JSON.stringify(rows[i]) !== JSON.stringify(corr[i])) mudou++;

console.log('Arquivo:', ARQ);
console.log('Cabecalho na linha (0-based):', headerIdx, '| colunas: unidade=' + iUni, 'nome=' + iNome, 'telefone=' + iTel, 'doc=' + iDoc);
console.log('Linhas que a pre-correcao efetivamente reordenou:', mudou, 'de', rows.length);
console.log('');

// Escolhe 3 linhas reais com Telefone vazio E que tenham unidade propria (nao herdada), pra prova limpa.
const alvos = [];
for (let i = 0; i < rows.length && alvos.length < 3; i++) {
  const r = rows[i] || [];
  const telVazio = !String(r[iTel] == null ? '' : r[iTel]).trim();
  const temUni = String(r[iUni] == null ? '' : r[iUni]).trim();
  const temNome = String(r[iNome] == null ? '' : r[iNome]).trim();
  if (telVazio && temUni && temNome) alvos.push(i);
}

alvos.forEach((i, n) => {
  const r = rows[i] || [];
  const c = corr[i] || [];
  console.log('--- Linha real ' + (n + 1) + ' (indice de dados ' + i + ', Telefone vazio) ---');
  console.log('  ANTES  unidade="' + (r[iUni] || '') + '"  nome="' + (r[iNome] || '') + '"  doc="' + (r[iDoc] || '') + '" -> ' + docStatus(r[iDoc]));
  console.log('  DEPOIS unidade="' + (c[iUni] || '') + '"  nome="' + (c[iNome] || '') + '"  doc="' + (c[iDoc] || '') + '" -> ' + docStatus(c[iDoc]));
});

// Passa pelo parser final e mostra o objeto que desagua no funil, para as 3 linhas alvo.
const contatos = ctx.parseW045AContatos(headers, corr);
console.log('\n=== Saida final do parser (o que vai pro funil) para as 3 unidades alvo ===');
alvos.forEach((i, n) => {
  const c = contatos[i] || {};
  const doc = c.prop_cnpj || c.prop_cpf || '';
  console.log('  ' + (n + 1) + ') unidade="' + (c._unidadeRaw || c.ST_UNIDADE_UNI || '') + '"  nome="' + (c.prop_nome || '') + '"  cpf="' + (c.prop_cpf || '') + '"  cnpj="' + (c.prop_cnpj || '') + '" -> ' + docStatus(doc));
});
