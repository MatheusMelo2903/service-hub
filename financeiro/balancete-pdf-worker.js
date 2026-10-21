// T41: leitura do PDF do 900A num PROCESSO separado (financeiro/balancete.js, lerPdf).
// Recebe o caminho do arquivo (argv[2]) e o tamanho máximo em bytes (argv[3]) e devolve pela saída padrão um JSON por linha:
// { pagina, texto, imagens, desenhos } e no fim { fim: true, paginas }.
// O processo pai limita memória (--max-old-space-size) e tempo e mata se passar.
// imagens: quantas imagens a página pinta; desenhos: quantos comandos de texto, linha ou
// preenchimento. Página sem texto útil, sem imagem e sem desenho é página em branco.
'use strict';
const fs = require('fs');
const caminho = process.argv[2];
const maxBytes = Number(process.argv[3]) || 400 * 1024 * 1024;
const maxPaginas = 3000;
const escreve = (o) => new Promise((ok) => { if (!process.stdout.write(JSON.stringify(o) + '\n')) process.stdout.once('drain', ok); else ok(); });
(async () => {
  let lib;
  const avisoOrig = console.warn, logOrig = console.log;
  console.warn = () => {}; console.log = () => {};
  try { lib = require('pdfjs-dist/legacy/build/pdf.js'); } catch (e) { lib = null; } finally { console.warn = avisoOrig; console.log = logOrig; }
  if (!lib) { await escreve({ erro: 'leitor_indisponivel' }); process.exit(0); }
  const OPS = lib.OPS;
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup].filter((x) => x !== undefined));
  const DESENHO = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText, OPS.fill, OPS.eoFill, OPS.stroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.constructPath].filter((x) => x !== undefined));
  let doc;
  try {
    // Confere o tamanho antes de ler e não copia o arquivo (o pai mede a memória e mata se passar).
    if (fs.statSync(caminho).size > maxBytes) { await escreve({ erro: 'pdf_grande_demais' }); process.exit(0); }
    const buf = fs.readFileSync(caminho);
    const dados = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    doc = await lib.getDocument({ data: dados, disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0, stopAtErrors: false }).promise;
  } catch (e) { await escreve({ erro: 'pdf_ilegivel' }); process.exit(0); }
  const n = Math.min(doc.numPages, maxPaginas);
  for (let i = 1; i <= n; i++) {
    let texto = '', imagens = 0, desenhos = 0, erro = false;
    try {
      const p = await doc.getPage(i);
      const c = await p.getTextContent();
      let ultY = null;
      for (const it of c.items) {
        const y = it.transform ? it.transform[5] : 0;
        if (ultY !== null) texto += Math.abs(y - ultY) > 2 ? '\n' : ' ';
        texto += it.str || '';
        ultY = y;
      }
      // Lista de operadores sem decodificar imagens: só conta o que a página pinta.
      const ops = await p.getOperatorList({ intent: 'display' });
      for (const f of ops.fnArray) { if (IMG.has(f)) imagens++; else if (DESENHO.has(f)) desenhos++; }
      p.cleanup();
    } catch (e) { erro = true; }
    await escreve({ pagina: i, texto: texto.slice(0, 20000), imagens, desenhos, erro });
  }
  await escreve({ fim: true, paginas: doc.numPages, lidas: n });
  process.exit(0);
})();
