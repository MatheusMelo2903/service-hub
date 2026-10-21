// T38: texto e metadados de um anexo de despesa num PROCESSO separado (financeiro/anexos-conferencia.js).
// Mesmo desenho do worker da T33 (financeiro/entrada-pdf-worker.js): recebe o PDF pela entrada
// padrão e devolve { ok, texto, paginas, meta } em JSON. O pai mede a memória e mata se passar
// do teto ou do tempo. meta: Producer, Creator, CreationDate e ModDate em ISO (com fuso).
const partes = [];
process.stdin.on('data', (c) => partes.push(c));
function dataPdf(v) {
  // D:AAAAMMDDHHmmSS+HH'mm' (padrão do PDF) para AAAA-MM-DDTHH:mm:SS+HH:mm
  const m = String(v || '').match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/);
  if (!m) return '';
  const z = !m[7] || /z/i.test(m[7]) ? 'Z' : m[7] + (m[8] || '00') + ':' + (m[9] || '00');
  return m[1] + '-' + (m[2] || '01') + '-' + (m[3] || '01') + 'T' + (m[4] || '00') + ':' + (m[5] || '00') + ':' + (m[6] || '00') + z;
}
process.stdin.on('end', async () => {
  const maxPaginas = Math.max(1, Math.min(20, Number(process.argv[2]) || 6));
  let lib;
  const avisoOrig = console.warn, logOrig = console.log;
  console.warn = () => {}; console.log = () => {};
  try { lib = require('pdfjs-dist/legacy/build/pdf.js'); } catch (e) { lib = null; } finally { console.warn = avisoOrig; console.log = logOrig; }
  const sair = (o) => { process.stdout.write(JSON.stringify(o), () => process.exit(0)); };
  if (!lib) return sair({ ok: false });
  try {
    const doc = await lib.getDocument({ data: new Uint8Array(Buffer.concat(partes)), disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0, stopAtErrors: false }).promise;
    const meta = {};
    try {
      const md = await doc.getMetadata();
      const info = (md && md.info) || {};
      ['Producer', 'Creator'].forEach((k) => { if (info[k]) meta[k] = String(info[k]).slice(0, 200); });
      if (info.CreationDate) meta.CreationDate = dataPdf(info.CreationDate);
      if (info.ModDate) meta.ModDate = dataPdf(info.ModDate);
    } catch (e) { /* sem metadados */ }
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
    sair({ ok: true, texto: txt, paginas: doc.numPages, meta });
  } catch (e) {
    sair({ ok: false });
  }
});
