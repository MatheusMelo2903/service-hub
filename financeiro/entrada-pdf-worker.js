// T33: extração do texto do PDF num PROCESSO separado (financeiro/entrada.js, extrairTexto).
// Recebe o PDF pela entrada padrão e devolve { ok, texto, paginas } em JSON pela saída padrão.
// O processo pai mede a memória deste processo e o mata se passar do teto ou do tempo: PDF
// malicioso (fluxo que expande para gigabytes) não derruba o servidor.
const partes = [];
process.stdin.on('data', (c) => partes.push(c));
process.stdin.on('end', async () => {
  const maxPaginas = Math.max(1, Math.min(20, Number(process.argv[2]) || 6));
  let lib;
  const avisoOrig = console.warn, logOrig = console.log;
  console.warn = () => {}; console.log = () => {};
  try { lib = require('pdfjs-dist/legacy/build/pdf.js'); } catch (e) { lib = null; } finally { console.warn = avisoOrig; console.log = logOrig; }
  const sair = (o) => { process.stdout.write(JSON.stringify(o), () => process.exit(0)); };
  if (!lib) return sair({ ok: false });
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(Buffer.concat(partes)), disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0, stopAtErrors: false }).promise;
    let txt = '';
    const n = Math.min(doc.numPages, maxPaginas);
    for (let i = 1; i <= n; i++) {
      const p = await doc.getPage(i);
      const c = await p.getTextContent();
      let ultY = null;
      for (const it of c.items) {
        const y = it.transform ? it.transform[5] : 0;
        if (ultY !== null) txt += Math.abs(y - ultY) > 2 ? '\n' : ' ';
        txt += it.str || '';
        ultY = y;
      }
      txt += '\n';
      if (txt.length > 200000) break;
    }
    sair({ ok: true, texto: txt, paginas: doc.numPages });
  } catch (e) {
    sair({ ok: false });
  }
});
