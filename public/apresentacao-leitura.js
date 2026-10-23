// ============================================================
// APRESENTAÇÃO DE ASSEMBLEIA: imagens EMF e WMF dos PowerPoints (23/10/2026).
// O navegador não abre esses formatos (tabela do Excel ou print colado no PowerPoint) e até
// aqui eles eram descartados. Agora os bytes vão crus para o servidor, que devolve a imagem
// convertida e a conferência dela (servico/apresentacao-leitura.js). No máximo 20 por envio
// e 10 MB cada. Usado por public/apresentacao.js (carregado antes dele).
// ============================================================
(function () {
  var LIM_VET = { QTD: 20, BYTES: 10 * 1024 * 1024 };
  var foraAvisado = false;

  function ehVetorial(caminho) { return /\.(emf|wmf)$/i.test(String(caminho || '')); }

  // Bytes para base64 em pedaços (evita estourar a pilha com arquivos grandes).
  function paraBase64(bytes) {
    var partes = [];
    for (var i = 0; i < bytes.length; i += 0x8000) partes.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    return btoa(partes.join(''));
  }
  // Marca do arquivo para não mandar o mesmo EMF duas vezes (documentos diferentes).
  function marca(bytes) {
    var h = 0x811c9dc5, passo = Math.max(1, Math.floor(bytes.length / 4096));
    for (var i = 0; i < bytes.length; i += passo) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
    return bytes.length + ':' + h.toString(16);
  }

  // Guarda uma imagem EMF ou WMF de um slide em doc.vetores. Devolve true se guardou.
  async function guardarVetorial(est, doc, pagina, media, caminho, area) {
    var total = 0;
    est.docs.forEach(function (d) { total += (d.vetores || []).length; });
    if (total >= LIM_VET.QTD) {
      if (!foraAvisado && typeof toast === 'function') toast('Mais de ' + LIM_VET.QTD + ' imagens em formato do Windows (EMF ou WMF): as demais ficaram de fora.', 'warn');
      foraAvisado = true;
      return false;
    }
    var bytes = await media.async('uint8array');
    if (!bytes || !bytes.length || bytes.length > LIM_VET.BYTES) return false;
    var m = marca(bytes);
    var repetida = est.docs.some(function (d) { return (d.vetores || []).some(function (v) { return v.marca === m; }); });
    if (repetida) return false;
    doc.vetores = doc.vetores || [];
    doc.vetores.push({
      chave: ++est.seq, pagina: pagina, formato: /\.wmf$/i.test(caminho) ? 'wmf' : 'emf', b64: paraBase64(bytes),
      area: Math.round(Math.min(1, area) * 1000) / 1000, marca: m, triagem: null
    });
    return true;
  }

  // Lista para o envio (campo imagens_vetoriais) e as referências para devolver a conferência.
  function vetoresDoEnvio(docsOk) {
    var lista = [], refs = [];
    docsOk.forEach(function (d, i) {
      (d.vetores || []).forEach(function (v) {
        lista.push({ doc: i, pagina: v.pagina, formato: v.formato, b64: v.b64, area: v.area, triagem: v.triagem || undefined });
        refs.push(v);
      });
    });
    return { lista: lista, refs: refs };
  }

  // A conferência feita no servidor fica guardada (gerar de novo não paga outra vez).
  function aplicarResultado(imagens, refs) {
    (imagens || []).forEach(function (x) {
      if (x && typeof x.vetor === 'number' && refs[x.vetor] && x.triagem) refs[x.vetor].triagem = x.triagem;
    });
  }

  function tamanho(docs) {
    var soma = 0;
    (docs || []).forEach(function (d) { (d.vetores || []).forEach(function (v) { soma += v.b64.length; }); });
    return soma;
  }

  window.AprLeitura = { LIM_VET: LIM_VET, ehVetorial: ehVetorial, guardarVetorial: guardarVetorial, vetoresDoEnvio: vetoresDoEnvio, aplicarResultado: aplicarResultado, tamanho: tamanho };
})();
