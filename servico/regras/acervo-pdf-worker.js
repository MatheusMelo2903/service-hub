// Regras do condomínio: texto de cada página do PDF do acervo num PROCESSO separado
// (servico/regras/acervo.js, extrairPaginas). Mesmo padrão de financeiro/entrada-pdf-worker.js,
// mas lê o documento inteiro (convenção passa de 60 páginas) e devolve as páginas separadas,
// para o acervo marcar a página de cada artigo e saber se o PDF é digitalizado.
// Recebe o PDF pela entrada padrão e devolve { ok, paginas, textos: [texto da página 1, ...] }.
// O pai mede a memória e o tempo deste processo e mata se passar: PDF malicioso não derruba o servidor.
const partes = [];
process.stdin.on('data', (c) => partes.push(c));
process.stdin.on('end', async () => {
  const maxPaginas = Math.max(1, Math.min(1000, Number(process.argv[2]) || 600));
  let lib;
  const avisoOrig = console.warn, logOrig = console.log;
  console.warn = () => {}; console.log = () => {};
  try { lib = require('pdfjs-dist/legacy/build/pdf.js'); } catch (e) { lib = null; } finally { console.warn = avisoOrig; console.log = logOrig; }
  const sair = (o) => { process.stdout.write(JSON.stringify(o), () => process.exit(0)); };
  if (!lib) return sair({ ok: false, motivo: 'sem_leitor' });
  try {
    const doc = await lib.getDocument({ data: new Uint8Array(Buffer.concat(partes)), disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0, stopAtErrors: false }).promise;
    const textos = [];
    let total = 0;
    const n = Math.min(doc.numPages, maxPaginas);
    for (let i = 1; i <= n; i++) {
      const p = await doc.getPage(i);
      const c = await p.getTextContent();
      // Quebra de linha quando muda a altura do texto (mesma regra da entrada de documentos).
      let txt = '';
      let ultY = null;
      for (const it of c.items) {
        const y = it.transform ? it.transform[5] : 0;
        if (ultY !== null) txt += Math.abs(y - ultY) > 2 ? '\n' : ' ';
        txt += it.str || '';
        ultY = y;
      }
      textos.push(txt);
      total += txt.length;
      if (total > 4000000) break; // 4 milhões de caracteres: nenhum regimento chega perto
    }
    sair({ ok: true, paginas: doc.numPages, textos });
  } catch (e) {
    sair({ ok: false, motivo: 'pdf_ilegivel' });
  }
});
