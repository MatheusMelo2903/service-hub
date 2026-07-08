#!/usr/bin/env node
/*
 * Extrai o bloco <script> DE APLICACAO do public/index.html e escreve
 * motor-extraido.js. O porque: o harness precisa rodar o roteador e os
 * parsers REAIS do painel Importar Unidades (detectarFamiliaPlanilha,
 * processFamiliaPlana, processFamiliaProponentes, processUnidadesData,
 * parseW045AContatos, inferirPapeis etc), nunca uma reimplementacao, e o
 * public/index.html continua sendo a unica fonte de verdade. Rodar este
 * script de novo sempre que o roteador ou os parsers mudarem no HTML.
 *
 * Como distinguir o bloco de aplicacao dos <script src="..."> de biblioteca
 * (SheetJS, PptxGenJS, docx, jsPDF, Supabase, auth-bootstrap, prestacao.js,
 * previsao-embed.js): o bloco de aplicacao usa a tag "<script>" pura, sozinha
 * na linha, sem atributo "src". Os demais sempre tem "src=" na mesma linha.
 */
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', '..', 'public', 'index.html');
const OUT_PATH = path.join(__dirname, 'motor-extraido.js');

// Varre linha a linha e devolve os blocos delimitados por "<script>"/"</script>" puros.
function extrairBlocosDeAplicacao(html) {
  const linhas = html.split('\n');
  const blocos = [];
  let inicio = -1;
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i].trim();
    if (l === '<script>' && inicio === -1) { inicio = i; continue; }
    if (l === '</script>' && inicio !== -1) {
      blocos.push({ deLinha: inicio + 1, ateLinha: i + 1, codigo: linhas.slice(inicio + 1, i).join('\n') });
      inicio = -1;
    }
  }
  return blocos;
}

const html = fs.readFileSync(HTML_PATH, 'utf8');
const blocos = extrairBlocosDeAplicacao(html);

if (blocos.length !== 1) {
  console.error(
    `[extrai-motor] Esperado 1 bloco de aplicacao (<script> puro) e encontrado ${blocos.length}. ` +
    `A estrutura do public/index.html mudou — confira as tags <script> antes de confiar no motor-extraido.js.`
  );
  process.exit(1);
}

const cabecalho =
  '/* ARQUIVO GERADO AUTOMATICAMENTE — NAO EDITAR A MAO.\n' +
  ' * Gerado por scripts/import-unidades-harness/extrai-motor.js a partir de public/index.html.\n' +
  ' * Fonte de verdade e o HTML. Se o roteador ou os parsers mudarem la, rode `node extrai-motor.js` de novo.\n' +
  ' */\n';

const saida = cabecalho + blocos
  .map(b => `/* ---- bloco original: public/index.html linhas ${b.deLinha}-${b.ateLinha} ---- */\n${b.codigo}`)
  .join('\n\n');

fs.writeFileSync(OUT_PATH, saida, 'utf8');
console.log(
  `[extrai-motor] motor-extraido.js gerado (${blocos.length} bloco; linhas: ` +
  blocos.map(b => `${b.deLinha}-${b.ateLinha}`).join(', ') + ')'
);
