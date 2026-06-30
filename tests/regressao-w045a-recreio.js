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
    html.match(/var _PARENTESCO = '[^']*';/)[0],
    html.match(/var _PARENTESCO_LIGADO_INQ_RE = [^\n]+/)[0],
    html.match(/var _PARENTESCO_LIGADO_PROP_RE = [^\n]+/)[0],
    html.match(/var _SO_PARENTESCO_RE = [^\n]+/)[0],
  ].join('\n');
  const fns = ['limparDocumento', 'anexarObs', 'splitUnidadeNumeroBloco', 'acharAncorasW045A',
    'colDeX', 'parseTelefonesW045A', 'parseEnderecoW045A', 'ehLinhaRodapeW045A',
    'extrairContatosW045APdf', 'condoNomeDoTitulo', 'mesmoSobrenome', 'ehTitularDeclarado',
    'marcacaoInquilino', 'parenteDeProprietario', 'nomeSoParentesco', 'qualificadorPapel', 'inferirPapeis'];
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
  check('IRMA INQUILINO (adjacente, sem separador) vira parente por ligacao', ctx.marcacaoInquilino('IRMA INQUILINO') === 'parente');
  check('Inquilino - IRMA SOUZA vira titular (prefixo protege o nome)', ctx.marcacaoInquilino('Inquilino - IRMA SOUZA') === 'titular');
  check('cunhada inquilino vira parente', ctx.marcacaoInquilino('RAIANE - CUNHADA INQUILINO') === 'parente');
  check('sogra inquilino vira parente', ctx.marcacaoInquilino('EDILUCIA sogra inquilino') === 'parente');
  check('filha do inquilino vira parente', ctx.marcacaoInquilino('ANA filha do inquilino') === 'parente');
  check('tia do inquilino vira parente (possessivo)', ctx.marcacaoInquilino('JOANA tia do inquilino') === 'parente');
  check('nome sem mencao a inquilino vira null', ctx.marcacaoInquilino('JOSE DA SILVA') === null);
  check('qualificador apos outro parentese', ctx.qualificadorPapel('JOSE (APT 302) (Esposa)') === 'titular');

  // Refino baseado em ligacao ao titular (nao no acento)
  console.log('  -- ligacao vs nome proprio (com e sem acento) --');
  check('CASO 1: "irma do inquilino" sem acento vira parente', ctx.marcacaoInquilino('PAULA irma do inquilino') === 'parente');
  check('CASO 1b: "irma do inquilino" com acento vira parente', ctx.marcacaoInquilino('PAULA irmã do inquilino') === 'parente');
  check('CASO 1c: "irmao da proprietaria" e parente do dono', ctx.parenteDeProprietario('LEANDRO irmao da proprietaria') === true);
  check('possessivo nao-parentesco "amiga do inquilino" vira parente', ctx.marcacaoInquilino('CLARA amiga do inquilino') === 'parente');
  check('CASO 2: "Irma Souza Costa" solta continua nome (null)', ctx.marcacaoInquilino('Irma Souza Costa') === null);
  check('CASO 2b: dona "MAYARA - PROPRIETARIA" nao e parente do dono', ctx.parenteDeProprietario('MAYARA GARBINI - PROPRIETARIA') === false);
  check('CASO 2c: "Inquilino - IRMA" e a inquilina (titular)', ctx.marcacaoInquilino('Inquilino - IRMA SOUZA') === 'titular');
  check('CASO 2d: "IRMA - INQUILINA" e a inquilina (titular, hifen protege)', ctx.marcacaoInquilino('IRMA SOUZA - INQUILINA') === 'titular');
  check('CASO 3: campo so "irmao" cai como bare-parentesco', ctx.nomeSoParentesco('irmao') === true);
  check('CASO 3b: "Maria Soraia (irma)" tem nome, nao e bare', ctx.nomeSoParentesco('Maria Soraia de Moraes (irma)') === false);

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

  console.log('  -- Passo 10: irma/irmao SEMPRE dependente (inferencia completa) --');
  var i1 = [mk(1, 'DONO', 'Proprietário'), mk(2, 'Maria irma', 'Residente')];
  ctx.inferirPapeis(i1);
  check('"Maria irma" (residente) vira dependente', i1[1].papel === 'dependente');
  var i2 = [mk(1, 'DONO', 'Proprietário'), mk(2, 'Inquilino - IRMA SOUZA', 'Dependente')];
  ctx.inferirPapeis(i2);
  check('"Inquilino - IRMA" vira dependente (irma sempre parentesco)', i2[1].papel === 'dependente');
  var i3 = [mk(1, 'DONO', 'Proprietário'), mk(2, 'irmao', 'Dependente')];
  ctx.inferirPapeis(i3);
  check('campo so "irmao" cai incerto', i3[1].papel === 'dependente' && i3[1].confianca === 'incerta');
  var i4 = [mk(1, 'IRMA DONA SOUZA', 'Proprietário'), mk(2, 'FULANO', 'Dependente')];
  ctx.inferirPapeis(i4);
  check('proprietario chamado "IRMA" nao e demovido (mantem dono da unidade)', i4[0].papel === 'proprietario');
  var i5 = [mk(1, 'DONO', 'Proprietário'), mk(2, 'Irma Santos', 'Inquilino')];
  ctx.inferirPapeis(i5);
  check('inquilino DECLARADO pela coluna Tipo chamado "Irma" e protegido', i5[1].papel === 'inquilino');
  var i6 = [mk(1, 'Irma', 'Proprietário'), mk(2, 'FULANO', 'Dependente')];
  ctx.inferirPapeis(i6);
  check('proprietario declarado de nome unico "Irma" nao vira incerto', i6[0].papel === 'proprietario' && i6[0].confianca === 'alta');
  check('qualificadorPapel "(Irmã)" vira dependente', ctx.qualificadorPapel('JOAO (Irmã)') === 'dependente');
  var i7 = [mk(1, 'OWNER', 'Proprietário'), mk(2, 'Inquilino - JOSE (Marido)', 'Dependente'), mk(3, 'Inquilino - ANA (Irmã)', 'Dependente')];
  ctx.inferirPapeis(i7);
  var inq7 = i7.filter(function(x) { return x.papel === 'inquilino'; });
  check('familia (Marido)+(Irma) resolve com 1 inquilino', inq7.length === 1 && inq7[0].nome.indexOf('JOSE') !== -1);
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
