#!/usr/bin/env node
/*
 * Extrai os blocos de <script> DE APLICACAO do previsao-modulo.html e escreve
 * motor-extraido.js. O porque: o harness precisa rodar a funcao parsePlanilhaPronta
 * REAL (nunca uma reimplementacao), e o HTML continua sendo a unica fonte de verdade.
 * Rodar este script de novo sempre que o motor de calculo mudar no HTML.
 *
 * Como distinguir bloco de aplicacao de biblioteca minificada: os 4 blocos de
 * aplicacao usam a tag "<script>" pura, sozinha na linha. Ja os blocos de lib
 * (SheetJS/pdf.js/PptxGenJS/jsPDF) e o glue do worker do pdf.js tem atributo
 * (id="pdfworker") ou codigo colado na mesma linha da tag (marcador /*__LIB_*​/),
 * entao nunca batem com esse padrao.
 */
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', '..', 'public', 'previsao-modulo.html');
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

if (blocos.length !== 4) {
  console.error(
    `[extrai-motor] Esperado 4 blocos de aplicacao (<script> puro) e encontrado ${blocos.length}. ` +
    `A estrutura do previsao-modulo.html mudou — confira as tags <script> antes de confiar no motor-extraido.js.`
  );
  process.exit(1);
}

const cabecalho =
  '/* ARQUIVO GERADO AUTOMATICAMENTE — NAO EDITAR A MAO.\n' +
  ' * Gerado por scripts/previsao-harness/extrai-motor.js a partir de public/previsao-modulo.html.\n' +
  ' * Fonte de verdade e o HTML. Se o motor de calculo mudar la, rode `node extrai-motor.js` de novo.\n' +
  ' */\n';

const saida = cabecalho + blocos
  .map(b => `/* ---- bloco original: previsao-modulo.html linhas ${b.deLinha}-${b.ateLinha} ---- */\n${b.codigo}`)
  .join('\n\n');

fs.writeFileSync(OUT_PATH, saida, 'utf8');
console.log(
  `[extrai-motor] motor-extraido.js gerado (${blocos.length} blocos; linhas: ` +
  blocos.map(b => `${b.deLinha}-${b.ateLinha}`).join(', ') + ')'
);
