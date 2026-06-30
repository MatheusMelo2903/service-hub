#!/usr/bin/env node
/*
 * Regressao do parser W045A (familia A1, PDF posicional) + inferencia de papel.
 *
 * Extrai as funcoes reais de public/index.html (nao duplica logica) e roda contra
 * o PDF real do Recreio das Palmeiras, conferindo as 7 unidades de teste e os
 * casos-limite da regra textual de inquilino.
 *
 * Como rodar:
 *   1. npm i pdfjs-dist@3.11.174   (mesma versao usada no front, via CDN)
 *   2. node tests/regressao-w045a-recreio.js "/caminho/Cadastro das unidades (4).pdf"
 *
 * O PDF NAO fica no repo (dado de condomino). Sem o PDF, o teste pula a parte do
 * PDF e roda so os casos-limite sinteticos. Sai com codigo !=0 se algo falhar.
 *
 * Contexto: ver docs/REGRESSAO-W045A-RECREIO.md e CHANGELOG (2026-06-30).
 */
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'public', 'index.html');
const PDF = process.argv[2] || process.env.RECREIO_PDF || '';

// Extrai uma funcao por nome balanceando chaves
function extrairFn(src, nome) {
  const idx = src.indexOf('function ' + nome + '(');
  if (idx < 0) throw new Error('funcao nao encontrada: ' + nome);
  let i = src.indexOf('{', idx), depth = 0, j = i;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(idx, j);
}

function carregarFuncoes() {
  const html = fs.readFileSync(HTML, 'utf8');
  const vars = [
    html.match(/var TIPOS_W045A = \[[^\]]*\];/)[0],
    html.match(/var GAP_CONTINUACAO_W045A = \d+;/)[0],
    html.match(/var MARGEM_COLUNA_W045A = \d+;/)[0],
    html.match(/var _PARENTESCO_DIRETO_RE = [^\n]+/)[0],
  ].join('\n');
  const fns = ['limparDocumento', 'anexarObs', 'splitUnidadeNumeroBloco', 'acharAncorasW045A',
    'colDeX', 'parseTelefonesW045A', 'parseEnderecoW045A', 'ehLinhaRodapeW045A',
    'extrairContatosW045APdf', 'condoNomeDoTitulo', 'mesmoSobrenome', 'marcacaoInquilino',
    'qualificadorPapel', 'inferirPapeis'];
  const vm = require('vm');
  const ctx = { String, Array, Math, Object, console, RegExp };
  vm.createContext(ctx);
  vm.runInContext(vars + '\n' + fns.map(function(n) { return extrairFn(html, n); }).join('\n\n'), ctx);
  return ctx;
}

let falhas = 0;
function check(nome, cond, detalhe) {
  if (cond) { console.log('  ok   ' + nome); }
  else { console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); falhas++; }
}

function testarCasosLimite(ctx) {
  console.log('\n== Casos-limite da regra textual de inquilino ==');
  check('Irma como nome vira titular', ctx.marcacaoInquilino('IRMA INQUILINO') === 'titular');
  check('Inquilino - IRMA SOUZA vira titular', ctx.marcacaoInquilino('Inquilino - IRMA SOUZA') === 'titular');
  check('cunhada inquilino vira parente', ctx.marcacaoInquilino('RAIANE - CUNHADA INQUILINO') === 'parente');
  check('sogra inquilino vira parente', ctx.marcacaoInquilino('EDILUCIA sogra inquilino') === 'parente');
  check('filha do inquilino vira parente', ctx.marcacaoInquilino('ANA filha do inquilino') === 'parente');
  check('tia do inquilino vira parente (possessivo)', ctx.marcacaoInquilino('JOANA tia do inquilino') === 'parente');
  check('nome sem mencao a inquilino vira null', ctx.marcacaoInquilino('JOSE DA SILVA') === null);
  check('qualificador apos outro parentese', ctx.qualificadorPapel('JOSE (APT 302) (Esposa)') === 'titular');

  // Locatario na coluna Tipo nao e rebaixado por causa de um parente
  var mk = function(id, nome, tipo) { return { id: id, unidade: '70', bloco: 'Z', nome: nome, tipoOriginal: tipo, papel: '', confianca: '', motivo: '', cpf: '', cnpj: '', telefone: '', obs: '' }; };
  var g = [mk(1, 'DONO', 'Proprietário'), mk(2, 'CARLOS LOCATARIO', 'Locatário'), mk(3, 'MARIA sogra do inquilino', 'Dependente')];
  ctx.inferirPapeis(g);
  check('Locatario (coluna Tipo) permanece inquilino', g[1].papel === 'inquilino' && g[1].confianca === 'alta', g[1].papel + '/' + g[1].confianca);

  // Caso limpo: 1 Marido + 2 Filhos (todos qualificados) resolve sozinho
  var limpo = [mk(1, 'OWNER', 'Proprietário'), mk(2, 'Inquilino - JOAO (Marido)', 'Dependente'), mk(3, 'Inquilino - PEDRO (Filho)', 'Dependente'), mk(4, 'Inquilino - ANA (Filha)', 'Dependente')];
  ctx.inferirPapeis(limpo);
  var inqLimpo = limpo.filter(function(x) { return x.papel === 'inquilino'; });
  check('Familia com 1 Marido + Filhos resolve (1 inquilino, sem incerto)',
    inqLimpo.length === 1 && inqLimpo[0].nome.indexOf('Marido') !== -1 && limpo.every(function(x) { return x.confianca !== 'incerta'; }));

  // Caso ambiguo: Marido + Esposa cai incerto
  var amb = [mk(1, 'OWNER', 'Proprietário'), mk(2, 'Inquilino - JOAO (Marido)', 'Dependente'), mk(3, 'Inquilino - MARIA (Esposa)', 'Dependente')];
  ctx.inferirPapeis(amb);
  check('Marido + Esposa cai incerto', amb.filter(function(x) { return x.confianca === 'incerta'; }).length === 2);
}

async function testarPdf(ctx) {
  let pdfjs;
  try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); }
  catch (e) { console.log('\n[pular PDF] pdfjs-dist nao instalado (npm i pdfjs-dist@3.11.174)'); return; }
  if (!PDF || !fs.existsSync(PDF)) { console.log('\n[pular PDF] informe o caminho do PDF do Recreio como argumento'); return; }

  const data = new Uint8Array(fs.readFileSync(PDF));
  const doc = await pdfjs.getDocument({ data: data, useSystemFonts: true }).promise;
  const paginas = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const tc = await pg.getTextContent();
    paginas.push({ items: tc.items.map(function(it) { return { x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), w: Math.round(it.width), str: it.str }; }).filter(function(it) { return it.str.trim() !== ''; }) });
  }
  const c = ctx.extrairContatosW045APdf(paginas, ctx.acharAncorasW045A(paginas[0].items), ctx.condoNomeDoTitulo(paginas));
  ctx.inferirPapeis(c);

  console.log('\n== Agregado do PDF Recreio ==');
  check('1257 contatos', c.length === 1257, String(c.length));
  check('577 unidades', new Set(c.map(function(x) { return x.unidade + '|' + x.bloco; })).size === 577);
  check('0 contatos sem nome', c.filter(function(x) { return !x.nome.trim(); }).length === 0);
  const propPorUni = {};
  c.filter(function(x) { return x.papel === 'proprietario'; }).forEach(function(x) { var k = x.unidade + '|' + x.bloco; propPorUni[k] = (propPorUni[k] || 0) + 1; });
  check('0 unidades com 2+ proprietarios', Object.values(propPorUni).filter(function(v) { return v > 1; }).length === 0);

  console.log('\n== 7 unidades de regressao ==');
  // [unidade, bloco, inquilinos esperados, deve cair incerta?]
  const esperado = [
    ['208', 'A', 3, true], ['401', 'B', 0, true], ['804', 'B', 3, true],
    ['806', 'D', 1, false], ['404', 'F', 1, false], ['406', 'H', 2, true], ['503', 'H', 2, true],
  ];
  esperado.forEach(function(e) {
    const ls = c.filter(function(x) { return x.unidade === e[0] && x.bloco === e[1]; });
    const inq = ls.filter(function(x) { return x.papel === 'inquilino'; }).length;
    const incerta = ls.some(function(x) { return x.confianca === 'incerta'; });
    check(e[0] + ' ' + e[1] + ': ' + e[2] + ' inquilino(s), incerta=' + e[3],
      inq === e[2] && incerta === e[3], inq + ' inquilino, incerta=' + incerta);
  });
}

(async function() {
  const ctx = carregarFuncoes();
  testarCasosLimite(ctx);
  await testarPdf(ctx);
  console.log('\n' + (falhas === 0 ? 'TUDO OK' : falhas + ' FALHA(S)'));
  process.exit(falhas === 0 ? 0 : 1);
})().catch(function(e) { console.error('ERRO:', e.message); process.exit(2); });
