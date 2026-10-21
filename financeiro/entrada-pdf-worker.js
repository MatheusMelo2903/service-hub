// T33: extração do texto do PDF numa thread separada, com memória limitada e tempo máximo
// (financeiro/entrada.js, extrairTexto). PDF malicioso não trava nem derruba o servidor.
const { parentPort, workerData } = require('worker_threads');

(async () => {
  let lib;
  const avisoOrig = console.warn, logOrig = console.log;
  console.warn = () => {}; console.log = () => {};
  try { lib = require('pdfjs-dist/legacy/build/pdf.js'); } catch (e) { lib = null; } finally { console.warn = avisoOrig; console.log = logOrig; }
  if (!lib) return parentPort.postMessage({ ok: false });
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(workerData.buf), disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0, stopAtErrors: false }).promise;
    let txt = '';
    const n = Math.min(doc.numPages, workerData.maxPaginas || 6);
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
    parentPort.postMessage({ ok: true, texto: txt, paginas: doc.numPages });
  } catch (e) {
    parentPort.postMessage({ ok: false });
  } finally { try { if (doc) doc.destroy(); } catch (e) { /* nada */ } }
})();
