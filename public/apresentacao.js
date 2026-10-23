// ============================================================
// APRESENTAÇÃO DE ASSEMBLEIA: edital, documentos e fotos viram o PowerPoint e o PDF da
// assembleia. Tudo que dá para fazer de graça acontece aqui na tela:
//   . texto do edital e dos documentos (PDF pelo pdf.js; PowerPoint pelo mesmo leitor da ata,
//     ata-leitura-docs.js);
//   . imagens de cada página ou slide, com o tamanho e a área que ocupam; logos e ícones
//     (menos de 200px no maior lado ou menos de 4% da página) e repetidas ficam de fora;
//   . fotos reduzidas para 1600px (JPEG 0.85) e logo do cliente para 1200px;
//   . pauta encontrada no edital e resumo do que foi lido, antes de gastar qualquer coisa.
// O servidor (servico/apresentacao.js, rotas /api/apresentacao/*) confere de novo os limites
// e a permissão, confere as imagens que podem ter informação, monta o roteiro e pede os slides.
// Módulo "apresentacao" (ver, gerar) entra no catálogo de permissões aqui.
// ============================================================
(function () {
  var PAINEL = 'apresentacao';
  if (typeof MODULOS_CATALOGO !== 'undefined' && !MODULOS_CATALOGO.apresentacao) {
    MODULOS_CATALOGO.apresentacao = { label: 'Apresentação de assembleia', acoes: ['ver', 'gerar'] };
  }
  if (typeof PAGE_META !== 'undefined') PAGE_META[PAINEL] = { title: 'Apresentação de assembleia', sub: 'edital, documentos e fotos viram PowerPoint e PDF' };

  // Limites (iguais aos do servidor).
  var LIM = {
    DOCS: 30, DOC_BYTES: 25 * 1024 * 1024, ENVIO_BYTES: 150 * 1024 * 1024, FOTOS: 40, IMAGENS_DOCS: 120,
    DOC_CHARS: 15000, DOCS_TOTAL_CHARS: 90000, EDITAL_CHARS: 20000,
    FOTO_LADO: 1600, FOTO_QUALIDADE: 0.85, TRIAGEM_LADO: 1000, LOGO_LADO: 1200,
    LADO_MIN: 200, AREA_MIN: 0.04, AREA_CANDIDATA: 0.20, PAGINA_SEM_TEXTO: 30
  };
  var ETAPAS = ['lendo os documentos', 'conferindo as imagens dos documentos', 'montando o roteiro', 'desenhando os slides'];

  // Estado da tela.
  var est = {
    edital: { nome: '', texto: '' }, pauta: [], docs: [], fotos: [], logo: null,
    lendo: 0, gerando: false, seq: 0, resultado: null, trabalhoId: null
  };

  function podeVer() { return typeof window.podeAbrirPainel === 'function' && window.podeAbrirPainel(PAINEL); }
  function podeGerar() { return podeVer() && (window.USER_ROLE === 'GESTOR' || (typeof temPermissao === 'function' && !!window.USER_PERMS && temPermissao('apresentacao', 'gerar'))); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function aviso(m, t) { if (typeof toast === 'function') toast(m, t || 'info'); }
  function el(id) { return document.getElementById(id); }
  function mb(n) { return (n / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB'; }
  function cond() { try { return typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null; } catch (e) { return null; } }
  function idCond(c) { var id = c && (c.id_superlogica || c.idSuperlogica); return /^[1-9][0-9]{0,8}$/.test(String(id || '')) ? String(id) : ''; }

  // 1. Abertura da tela e condomínio ativo.
  function painelAtivo() { var p = el('panel-' + PAINEL); return !!(p && p.classList.contains('active')); }
  if (typeof window.showPanel === 'function') {
    var origShow = window.showPanel;
    window.showPanel = function () {
      var r = origShow.apply(this, arguments);
      if (painelAtivo() && podeVer()) aprAbrir();
      return r;
    };
  }
  document.addEventListener('auth:ready', function () { setTimeout(function () { if (painelAtivo() && podeVer()) aprAbrir(); }, 0); });
  window.addEventListener('condominioAtivo:changed', function () { if (painelAtivo()) mostrarCond(); });

  function aprAbrir() {
    mostrarCond();
    var b = el('apr-gerar');
    if (b) { b.disabled = !podeGerar() || est.gerando; b.title = podeGerar() ? '' : 'Seu usuário não pode gerar apresentações.'; }
    aprResumo();
  }
  function mostrarCond() {
    var c = cond();
    var alvo = el('apr-cond');
    if (alvo) alvo.innerHTML = c ? 'Condomínio: <b>' + esc(c.nome) + '</b>' : 'Nenhum condomínio escolhido no topo.';
    var av = el('apr-cond-aviso');
    if (av) av.textContent = c ? 'Para outro condomínio, troque no seletor do topo.' : 'Dá para gerar sem condomínio, mas o nome dele precisa estar no edital ou no pedido.';
  }

  // 2. Arquivos: escolher ou arrastar.
  window.aprEscolher = function (ev, tipo) {
    var arqs = [].slice.call((ev.target && ev.target.files) || []);
    ev.target.value = '';
    receber(arqs, tipo);
  };
  window.aprSoltar = function (ev, tipo) {
    ev.preventDefault();
    if (ev.currentTarget) ev.currentTarget.classList.remove('dragover');
    receber([].slice.call((ev.dataTransfer && ev.dataTransfer.files) || []), tipo);
  };
  function receber(arqs, tipo) {
    if (!arqs.length) return;
    if (tipo === 'edital') return lerEdital(arqs[0]);
    if (tipo === 'docs') return lerDocs(arqs);
    if (tipo === 'fotos') return lerFotos(arqs);
    if (tipo === 'logo') return lerLogo(arqs[0]);
  }

  // Lê um arquivo como base64 (sem o prefixo data:).
  function lerBase64(arq) {
    return new Promise(function (ok, erro) {
      var fr = new FileReader();
      fr.onload = function () { ok(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { erro(new Error('não deu para abrir o arquivo')); };
      fr.readAsDataURL(arq);
    });
  }
  // Desenha uma imagem (bitmap, canvas ou img) reduzida e devolve JPEG (ou PNG) em base64.
  function paraImagem(fonte, w, h, ladoMax, qualidade, png) {
    var k = Math.min(1, ladoMax / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    var ctx = cv.getContext('2d');
    if (!png) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch); }
    ctx.drawImage(fonte, 0, 0, cw, ch);
    var url = cv.toDataURL(png ? 'image/png' : 'image/jpeg', qualidade || LIM.FOTO_QUALIDADE);
    cv.width = 0; cv.height = 0;
    return url.slice(url.indexOf(',') + 1);
  }
  // Abre uma imagem do computador. HEIC só abre se o navegador souber ler (Safari lê).
  async function abrirImagem(arq) {
    try { var b = await createImageBitmap(arq); return { fonte: b, w: b.width, h: b.height }; } catch (e) { /* tenta por <img> */ }
    var url = URL.createObjectURL(arq);
    try {
      var img = await new Promise(function (ok, falha) { var im = new Image(); im.onload = function () { ok(im); }; im.onerror = falha; im.src = url; });
      return { fonte: img, w: img.naturalWidth, h: img.naturalHeight };
    } catch (e2) { return null; } finally { URL.revokeObjectURL(url); }
  }
  // Marca das imagens para achar repetidas: miniatura 16x16 em tons de cinza.
  function marcaImagem(fonte, w, h) {
    var cv = document.createElement('canvas'); cv.width = 16; cv.height = 16;
    var ctx = cv.getContext('2d');
    ctx.drawImage(fonte, 0, 0, w, h, 0, 0, 16, 16);
    var d = ctx.getImageData(0, 0, 16, 16).data;
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ Math.round(w / Math.max(1, h) * 10);
    for (var i = 0; i < d.length; i += 4) {
      var g = ((d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10) >> 4;
      h1 = Math.imul(h1 ^ g, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ (g + i), 2246822519) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }
  function letras(s) { return String(s || '').replace(/\s+/g, '').length; }

  // 3. Edital: texto do PDF (ou colado) e a pauta encontrada nele.
  async function lerEdital(arq) {
    var st = el('apr-edital-status');
    if (!/\.pdf$/i.test(arq.name) && arq.type !== 'application/pdf') { aviso('O edital precisa ser PDF.', 'err'); return; }
    if (st) st.textContent = 'Lendo o edital...';
    try {
      var pdfjsLib = await carregarPdfjs();
      var pdf = await pdfjsLib.getDocument({ data: await arq.arrayBuffer() }).promise;
      var texto = '';
      for (var i = 1; i <= pdf.numPages; i++) {
        var pg = await pdf.getPage(i);
        var tc = await pg.getTextContent();
        texto += tc.items.map(function (it) { return it.str + (it.hasEOL ? '\n' : ' '); }).join('') + '\n';
        pg.cleanup();
      }
      texto = texto.replace(/[ \t]+/g, ' ').trim();
      est.edital = { nome: arq.name, texto: texto };
      var ta = el('apr-edital-texto'); if (ta) ta.value = texto;
      if (st) st.textContent = letras(texto) < 50 ? arq.name + ': o PDF não tem texto (parece escaneado). Cole o texto do edital abaixo.' : arq.name + ': ' + pdf.numPages + ' página(s) lida(s).';
      await buscarPauta();
    } catch (e) {
      if (st) st.textContent = 'Não foi possível ler o edital: ' + (e.message || e) + '. Cole o texto abaixo.';
    }
  }
  var _timerEdital = null;
  window.aprEditalDigitado = function () {
    var ta = el('apr-edital-texto');
    est.edital = { nome: est.edital.nome || 'texto colado', texto: ta ? ta.value : '' };
    clearTimeout(_timerEdital);
    _timerEdital = setTimeout(buscarPauta, 700);
  };
  // A pauta sai do servidor por regras fixas (sem custo); a tela só mostra para conferir.
  async function buscarPauta() {
    var texto = String(est.edital.texto || '').slice(0, LIM.EDITAL_CHARS);
    est.pauta = [];
    if (letras(texto) >= 20) {
      try {
        var r = await apiAuthFetch('/api/apresentacao/pauta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edital_texto: texto }) });
        var j = await r.json().catch(function () { return {}; });
        if (r.ok && Array.isArray(j.itens)) est.pauta = j.itens;
      } catch (e) { /* sem a pauta, o roteiro tira do edital */ }
    }
    var alvo = el('apr-pauta');
    if (alvo) {
      alvo.innerHTML = !letras(texto) ? '' : est.pauta.length
        ? '<div class="hint" style="margin:0 0 4px">Pauta encontrada no edital:</div><ol style="margin:0;padding-left:20px;font-size:13px">' + est.pauta.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol>'
        : '<div class="hint" style="margin:0">Não achei a lista numerada da pauta no edital. O sistema monta a pauta lendo o edital inteiro.</div>';
    }
    aprResumo();
  }

  // 4. Documentos: texto e imagens de cada página (PDF) ou slide (PowerPoint).
  async function lerDocs(arqs) {
    var avisos = [];
    for (var i = 0; i < arqs.length; i++) {
      var a = arqs[i];
      var tipo = /\.pptx$/i.test(a.name) || a.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ? 'pptx'
        : (/\.pdf$/i.test(a.name) || a.type === 'application/pdf') ? 'pdf' : '';
      if (!tipo) { avisos.push(a.name + ': só PDF ou PowerPoint (.pptx)'); continue; }
      if (a.size > LIM.DOC_BYTES) { avisos.push(a.name + ': passou de 25 MB'); continue; }
      if (est.docs.length >= LIM.DOCS) { avisos.push('limite de ' + LIM.DOCS + ' documentos atingido; ' + a.name + ' ficou fora'); continue; }
      var doc = { chave: ++est.seq, nome: a.name, tipo: tipo, tamanho: a.size, status: 'lendo', texto: '', paginas: 0, pdf_b64: null, imagens: [], semTexto: [], progresso: '' };
      est.docs.push(doc);
      desenharDocs();
      lerUmDoc(doc, a);
    }
    if (avisos.length) aviso(avisos.join('. ') + '.', 'warn');
  }
  async function lerUmDoc(doc, arq) {
    est.lendo++;
    aprResumo();
    var aoProgresso = function (t) { doc.progresso = t; desenharDocs(); };
    try {
      if (doc.tipo === 'pdf') {
        var buf = await arq.arrayBuffer();
        doc.pdf_b64 = await lerBase64(arq);
        await lerPdf(doc, buf, aoProgresso);
      } else {
        await lerPptx(doc, arq, aoProgresso);
      }
      doc.status = 'ok';
    } catch (e) {
      doc.status = 'erro';
      doc.erro = e && e.message ? e.message : String(e);
    }
    doc.progresso = '';
    est.lendo--;
    limitarImagens();
    desenharDocs();
    desenharImagensDocs();
    aprResumo();
  }

  // PDF: texto por página e cada imagem desenhada na página, com a área que ocupa. A posição
  // vem da matriz de desenho da página (operator list do pdf.js); a imagem é recortada da
  // página desenhada, o que serve para JPEG, PNG, máscaras e páginas escaneadas.
  async function lerPdf(doc, buf, aoProgresso) {
    var pdfjsLib = await carregarPdfjs();
    var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    var OPS = pdfjsLib.OPS, Util = pdfjsLib.Util;
    var opsImg = [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintJpegXObject].filter(function (v) { return v != null; });
    doc.paginas = pdf.numPages;
    var texto = '';
    for (var n = 1; n <= pdf.numPages; n++) {
      aoProgresso('página ' + n + ' de ' + pdf.numPages);
      var page = await pdf.getPage(n);
      var tc = await page.getTextContent();
      var txt = tc.items.map(function (it) { return it.str; }).join(' ').replace(/\s+/g, ' ').trim();
      texto += '[página ' + n + '] ' + txt + '\n';
      var semTexto = letras(txt) < LIM.PAGINA_SEM_TEXTO;
      if (semTexto) doc.semTexto.push(n);
      var vp1 = page.getViewport({ scale: 1 });
      var escala = Math.min(2.5, LIM.FOTO_LADO / Math.max(vp1.width, vp1.height));
      var vp = page.getViewport({ scale: escala });
      var areaPag = vp.width * vp.height;
      // Onde cada imagem cai na página (retângulo em pixels da página desenhada).
      var caixas = [];
      try {
        var ops = await page.getOperatorList();
        var ctm = [1, 0, 0, 1, 0, 0], pilha = [];
        for (var i = 0; i < ops.fnArray.length; i++) {
          var fn = ops.fnArray[i], args = ops.argsArray[i];
          if (fn === OPS.save) pilha.push(ctm.slice());
          else if (fn === OPS.restore) ctm = pilha.pop() || [1, 0, 0, 1, 0, 0];
          else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
          else if (fn === OPS.paintFormXObjectBegin) { pilha.push(ctm.slice()); if (args && Array.isArray(args[0]) && args[0].length === 6) ctm = Util.transform(ctm, args[0]); }
          else if (fn === OPS.paintFormXObjectEnd) ctm = pilha.pop() || [1, 0, 0, 1, 0, 0];
          else if (opsImg.indexOf(fn) >= 0) {
            var m = Util.transform(vp.transform, ctm);
            var pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(function (p) { return Util.applyTransform(p, m); });
            var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
            var x0 = Math.max(0, Math.min.apply(null, xs)), y0 = Math.max(0, Math.min.apply(null, ys));
            var x1 = Math.min(vp.width, Math.max.apply(null, xs)), y1 = Math.min(vp.height, Math.max.apply(null, ys));
            if (x1 - x0 < 2 || y1 - y0 < 2) continue;
            var natW = args && typeof args[1] === 'number' ? args[1] : 0, natH = args && typeof args[2] === 'number' ? args[2] : 0;
            caixas.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, area: ((x1 - x0) * (y1 - y0)) / areaPag, lado: Math.max(natW, natH) || Math.max(x1 - x0, y1 - y0) });
          }
        }
      } catch (e) { caixas = []; }
      // Página sem texto e sem imagem (desenho vetorial ou escaneado esquisito): a página inteira.
      if (semTexto && !caixas.length) caixas.push({ x: 0, y: 0, w: vp.width, h: vp.height, area: 1, lado: Math.max(vp.width, vp.height) });
      var uteis = caixas.filter(function (c) { return c.lado >= LIM.LADO_MIN && c.area >= LIM.AREA_MIN; });
      if (uteis.length) {
        var cv = document.createElement('canvas');
        cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        uteis.forEach(function (c) {
          var rc = document.createElement('canvas');
          rc.width = Math.max(1, Math.round(c.w)); rc.height = Math.max(1, Math.round(c.h));
          rc.getContext('2d').drawImage(cv, c.x, c.y, c.w, c.h, 0, 0, rc.width, rc.height);
          guardarImagem(doc, n, rc, rc.width, rc.height, c.area, c.lado, semTexto);
          rc.width = 0; rc.height = 0;
        });
        cv.width = 0; cv.height = 0;
      }
      page.cleanup();
    }
    doc.texto = texto.trim();
  }

  // PowerPoint: o texto sai pelo leitor da ata (mesmo formato "[slide N]"), sem as imagens
  // (orçamento zerado); as imagens saem aqui, com a área que cada uma ocupa no slide.
  async function lerPptx(doc, arq, aoProgresso) {
    if (typeof ataLerPptx !== 'function' || !window.JSZip) throw new Error('leitor de PowerPoint não carregou, recarregue a página');
    var semImagens = { qtd: 1e9, bytes: 0, descartadas: 0 };
    var lido = await ataLerPptx(arq, semImagens, aoProgresso);
    doc.texto = lido.texto || '';
    doc.paginas = lido.paginas || 0;
    var porSlide = {};
    doc.texto.split(/(?=\[slide \d+\])/).forEach(function (t) { var m = t.match(/^\[slide (\d+)\]/); if (m) porSlide[m[1]] = t.slice(m[0].length); });
    var zip = await window.JSZip.loadAsync(await arq.arrayBuffer());
    var pres = ataXml(await zip.file('ppt/presentation.xml').async('string'));
    var relsPres = await ataLerRels(zip, 'ppt/presentation.xml');
    var sz = pres.getElementsByTagNameNS(NS_P, 'sldSz')[0];
    var areaSlide = sz ? Number(sz.getAttribute('cx')) * Number(sz.getAttribute('cy')) : 0;
    var caminhos = Array.from(pres.getElementsByTagNameNS(NS_P, 'sldId')).map(function (s) { return relsPres[s.getAttributeNS(NS_R, 'id')]; })
      .filter(function (r) { return r && r.alvo; }).map(function (r) { return r.alvo; });
    var vistas = {};
    for (var i = 0; i < caminhos.length; i++) {
      var numero = i + 1; // mesma numeração do leitor da ata (conta os ocultos)
      var arqSlide = zip.file(caminhos[i]);
      if (!arqSlide) continue;
      var slide = ataXml(await arqSlide.async('string'));
      if (slide.documentElement.getAttribute('show') === '0') continue;
      aoProgresso('imagens do slide ' + numero + ' de ' + caminhos.length);
      var semTexto = letras(porSlide[numero]) < LIM.PAGINA_SEM_TEXTO;
      if (semTexto) doc.semTexto.push(numero);
      var rels = await ataLerRels(zip, caminhos[i]);
      var blips = Array.from(slide.getElementsByTagNameNS(NS_A, 'blip'));
      for (var b = 0; b < blips.length; b++) {
        var rid = blips[b].getAttributeNS(NS_R, 'embed');
        var r = rid && rels[rid];
        if (!r || !r.alvo) continue;
        // A mesma mídia em vários slides (logo do rodapé) conta uma vez só.
        if (vistas[r.alvo]) continue;
        vistas[r.alvo] = true;
        var no = blips[b].parentNode;
        while (no && !(no.localName === 'pic' || no.localName === 'sp')) no = no.parentNode;
        var ext = no ? no.getElementsByTagNameNS(NS_A, 'ext')[0] : null;
        var area = ext && areaSlide ? (Number(ext.getAttribute('cx')) * Number(ext.getAttribute('cy'))) / areaSlide : 0;
        if (area < LIM.AREA_MIN) continue;
        var mime = ATA_MIME_POR_EXT[(r.alvo.split('.').pop() || '').toLowerCase()];
        var media = zip.file(r.alvo);
        if (!mime || !media) continue;
        var aberta = await ataAbrirImagem(new Blob([await media.async('arraybuffer')], { type: mime }));
        if (!aberta) continue;
        if (Math.max(aberta.w, aberta.h) >= LIM.LADO_MIN) guardarImagem(doc, numero, aberta.bitmap, aberta.w, aberta.h, Math.min(1, area), Math.max(aberta.w, aberta.h), semTexto);
        if (aberta.bitmap.close) aberta.bitmap.close();
      }
    }
  }

  // Guarda uma imagem de documento (sem repetir a mesma imagem em lugar nenhum da tela).
  function guardarImagem(doc, pagina, fonte, w, h, area, lado, paginaSemTexto) {
    var hash = marcaImagem(fonte, w, h);
    var repetida = est.docs.some(function (d) { return d.imagens.some(function (im) { return im.hash === hash; }); });
    if (repetida) return;
    var candidata = paginaSemTexto || area >= LIM.AREA_CANDIDATA;
    var legenda = doc.nome + ', ' + (doc.tipo === 'pptx' ? 'slide ' : 'página ') + pagina;
    doc.imagens.push({
      chave: ++est.seq, pagina: pagina, largura: Math.round(w), altura: Math.round(h), area: Math.round(area * 1000) / 1000, lado: lado, hash: hash,
      b64: paraImagem(fonte, w, h, LIM.FOTO_LADO, LIM.FOTO_QUALIDADE),
      b64_triagem: candidata ? paraImagem(fonte, w, h, LIM.TRIAGEM_LADO, 0.8) : null,
      legenda: legenda, legendaPadrao: legenda, legenda_editada: false, triagem: null
    });
  }
  // No máximo 120 imagens de documentos: ficam as maiores.
  function limitarImagens() {
    var todas = [];
    est.docs.forEach(function (d) { d.imagens.forEach(function (im) { todas.push({ d: d, im: im }); }); });
    if (todas.length <= LIM.IMAGENS_DOCS) return;
    todas.sort(function (a, b) { return b.im.area - a.im.area; });
    var fora = todas.slice(LIM.IMAGENS_DOCS);
    fora.forEach(function (x) { x.d.imagens = x.d.imagens.filter(function (im) { return im !== x.im; }); });
    aviso(fora.length + ' imagem(ns) menores dos documentos ficaram fora (limite de ' + LIM.IMAGENS_DOCS + ').', 'warn');
  }

  function desenharDocs() {
    var alvo = el('apr-docs-lista');
    if (!alvo) return;
    var restante = LIM.DOCS_TOTAL_CHARS;
    alvo.innerHTML = est.docs.map(function (d) {
      var info;
      if (d.status === 'lendo') info = 'lendo' + (d.progresso ? ' (' + esc(d.progresso) + ')' : '') + '...';
      else if (d.status === 'erro') info = '<span style="color:var(--danger)">não foi possível ler: ' + esc(d.erro) + '</span>';
      else {
        var n = d.texto.length, cabe = Math.min(LIM.DOC_CHARS, Math.max(0, restante));
        restante -= Math.min(n, cabe);
        var partes = [d.paginas + (d.tipo === 'pptx' ? ' slide(s)' : ' página(s)')];
        partes.push(letras(d.texto) >= 30 ? 'com texto' : '<span style="color:var(--warning)">sem texto</span>');
        if (d.semTexto.length && letras(d.texto) >= 30) partes.push(d.semTexto.length + ' sem texto');
        partes.push(d.imagens.length + ' imagem(ns)');
        if (n > cabe) partes.push('<span style="color:var(--warning)">texto longo: só o começo entra</span>');
        info = partes.join(', ');
      }
      return '<div style="display:flex;gap:8px;align-items:center;font-size:12px;font-family:var(--mono);border:1px solid var(--border);border-radius:8px;padding:6px 10px">'
        + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(d.nome) + '">' + esc(d.nome) + ' <span style="color:var(--muted)">(' + mb(d.tamanho) + ')</span></span>'
        + '<span style="color:var(--muted)">' + info + '</span>'
        + '<button class="btn btn-ghost" style="padding:2px 8px;font-size:11px" onclick="aprTirarDoc(' + d.chave + ')" title="Tirar da lista">✕</button></div>';
    }).join('');
  }
  window.aprTirarDoc = function (chave) {
    est.docs = est.docs.filter(function (d) { return d.chave !== chave; });
    desenharDocs(); desenharImagensDocs(); aprResumo();
  };

  // Miniaturas das imagens dos documentos, com a legenda editável.
  function miniatura(chaveFoto, b64, legenda, titulo, aoTirar, rotulo) {
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:4px">'
      + '<img src="data:image/jpeg;base64,' + b64 + '" alt="" style="width:100%;height:96px;object-fit:cover;border-radius:4px;background:var(--bg3)">'
      + '<div class="hint" style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(titulo) + '">' + esc(titulo) + '</div>'
      + '<input type="text" maxlength="160" value="' + esc(legenda) + '" placeholder="a que se refere" data-apr-legenda="' + chaveFoto + '" style="font-size:12px;padding:5px 8px" aria-label="' + esc(rotulo) + '">'
      + '<button class="btn btn-ghost" style="padding:2px 8px;font-size:11px" onclick="' + aoTirar + '">Tirar</button></div>';
  }
  function desenharImagensDocs() {
    var alvo = el('apr-docs-imagens');
    if (!alvo) return;
    var itens = [];
    est.docs.forEach(function (d) { d.imagens.forEach(function (im) { itens.push(im); }); });
    if (!itens.length) { alvo.innerHTML = ''; return; }
    alvo.innerHTML = '<details><summary class="hint" style="cursor:pointer;margin:0">Imagens tiradas dos documentos (' + itens.length + '). Confira ou mude a legenda; as que forem só enfeite o sistema deixa de fora.</summary>'
      + '<div style="margin-top:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">'
      + itens.map(function (im) {
        return miniatura('d' + im.chave, im.b64, im.legenda, im.legendaPadrao + (im.triagem && im.triagem.tipo === 'decorativa' ? ' (enfeite)' : ''), 'aprTirarImagem(' + im.chave + ')', 'Legenda da imagem');
      }).join('') + '</div></details>';
  }
  window.aprTirarImagem = function (chave) {
    est.docs.forEach(function (d) { d.imagens = d.imagens.filter(function (im) { return im.chave !== chave; }); });
    desenharImagensDocs(); aprResumo();
  };
  // Legenda digitada (fotos e imagens dos documentos).
  document.addEventListener('input', function (ev) {
    var k = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-apr-legenda');
    if (!k) return;
    var v = ev.target.value;
    if (k.charAt(0) === 'd') {
      est.docs.forEach(function (d) { d.imagens.forEach(function (im) { if ('d' + im.chave === k) { im.legenda = v; im.legenda_editada = true; } }); });
    } else {
      est.fotos.forEach(function (f) { if ('f' + f.chave === k) f.legenda = v; });
    }
  });

  // 5. Fotos: reduzidas para 1600px, JPEG 0.85.
  async function lerFotos(arqs) {
    var avisos = [];
    for (var i = 0; i < arqs.length; i++) {
      var a = arqs[i];
      if (est.fotos.length >= LIM.FOTOS) { avisos.push('limite de ' + LIM.FOTOS + ' fotos atingido'); break; }
      if (!/^image\//.test(a.type) && !/\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(a.name)) { avisos.push(a.name + ': não é imagem'); continue; }
      var ab = await abrirImagem(a);
      if (!ab || !ab.w) { avisos.push(a.name + ': este navegador não abre esse formato (no caso de HEIC, converta para JPG)'); continue; }
      est.fotos.push({ chave: ++est.seq, nome: a.name, legenda: '', b64: paraImagem(ab.fonte, ab.w, ab.h, LIM.FOTO_LADO, LIM.FOTO_QUALIDADE) });
      if (ab.fonte.close) ab.fonte.close();
    }
    if (avisos.length) aviso(avisos.join('. ') + '.', 'warn');
    desenharFotos(); aprResumo();
  }
  function desenharFotos() {
    var alvo = el('apr-fotos-lista');
    if (!alvo) return;
    alvo.innerHTML = est.fotos.map(function (f) { return miniatura('f' + f.chave, f.b64, f.legenda, f.nome, 'aprTirarFoto(' + f.chave + ')', 'Legenda da foto ' + f.nome); }).join('');
  }
  window.aprTirarFoto = function (chave) { est.fotos = est.fotos.filter(function (f) { return f.chave !== chave; }); desenharFotos(); aprResumo(); };

  // Logo do cliente: até 1200px; PNG continua PNG (mantém o fundo transparente).
  async function lerLogo(arq) {
    var st = el('apr-logo-status');
    var ab = await abrirImagem(arq);
    if (!ab || !ab.w) { est.logo = null; if (st) st.textContent = 'Não foi possível abrir a logo. Use JPG ou PNG.'; return; }
    var png = !/jpe?g/i.test(arq.type) && !/\.jpe?g$/i.test(arq.name);
    est.logo = paraImagem(ab.fonte, ab.w, ab.h, LIM.LOGO_LADO, 0.9, png);
    if (ab.fonte.close) ab.fonte.close();
    if (st) st.innerHTML = esc(arq.name) + ' <button class="btn btn-ghost" style="padding:2px 8px;font-size:11px" onclick="aprTirarLogo()">Tirar</button>';
  }
  window.aprTirarLogo = function () { est.logo = null; var st = el('apr-logo-status'); if (st) st.textContent = ''; };

  // 6. Resumo antes de gerar (sem custo) e itens da pauta sem material.
  var PALAVRAS_FORA = ['para', 'sobre', 'como', 'pela', 'pelo', 'pelos', 'pelas', 'com', 'dos', 'das', 'que', 'item', 'itens', 'aprovacao', 'deliberacao', 'apresentacao',
    'discussao', 'votacao', 'definicao', 'condominio', 'assembleia', 'referente', 'proposta', 'eventual', 'eventuais', 'entre', 'outros', 'outras', 'valor', 'valores'];
  function normal(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function palavras(s) { return normal(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function (p) { return p.length >= 4 && PALAVRAS_FORA.indexOf(p) < 0; }); }
  // Itens que não precisam de documento (assuntos gerais, eleição, leitura de ata).
  function itemSemMaterial(t) { return /assuntos gerais|elei[cç][aã]o|leitura (e aprova[cç][aã]o )?da ata|posse/i.test(normal(t)); }
  function itensSemMaterial() {
    var material = est.docs.map(function (d) { return d.nome + ' ' + d.texto.slice(0, 3000); })
      .concat(est.fotos.map(function (f) { return f.nome + ' ' + f.legenda; }))
      .concat([].concat.apply([], est.docs.map(function (d) { return d.imagens.map(function (im) { return im.legenda; }); })));
    var tudo = ' ' + normal(material.join(' ')).replace(/[^a-z0-9 ]/g, ' ') + ' ';
    var faltando = [];
    est.pauta.forEach(function (t, i) {
      if (itemSemMaterial(t)) return;
      var ps = palavras(t);
      if (!ps.length) return;
      var achou = ps.some(function (p) { return tudo.indexOf(' ' + p.slice(0, Math.max(4, p.length - 2))) >= 0; });
      if (!achou) faltando.push((i + 1) + '. ' + t);
    });
    return faltando;
  }
  function tamanhoEnvio() {
    var soma = 0;
    est.docs.forEach(function (d) { soma += (d.pdf_b64 || '').length; d.imagens.forEach(function (im) { soma += im.b64.length + (im.b64_triagem || '').length; }); });
    est.fotos.forEach(function (f) { soma += f.b64.length; });
    soma += (est.logo || '').length;
    return Math.round(soma * 3 / 4);
  }
  window.aprResumo = function () {
    var alvo = el('apr-resumo');
    if (!alvo) return;
    var docsOk = est.docs.filter(function (d) { return d.status === 'ok'; });
    var nImgs = 0, semTexto = 0;
    docsOk.forEach(function (d) { nImgs += d.imagens.length; semTexto += d.semTexto.length; });
    var linhas = [];
    linhas.push('Pauta: ' + (est.pauta.length ? est.pauta.length + ' item(ns) encontrados no edital' : (letras(est.edital.texto) ? 'lista numerada não encontrada, o sistema lê o edital inteiro' : 'sem edital')));
    linhas.push('Documentos: ' + docsOk.length + (est.lendo ? ' (lendo ' + est.lendo + ')' : '') + (semTexto ? ', ' + semTexto + ' página(s) sem texto' : '') + (nImgs ? ', ' + nImgs + ' imagem(ns) aproveitáveis' : ''));
    linhas.push('Fotos: ' + est.fotos.length + (est.fotos.length ? ', ' + est.fotos.filter(function (f) { return !f.legenda.trim(); }).length + ' sem legenda' : ''));
    var tam = tamanhoEnvio();
    linhas.push('Tamanho do envio: ' + mb(tam) + (tam > LIM.ENVIO_BYTES ? ' <span style="color:var(--danger)">passou de 150 MB, tire alguns arquivos</span>' : ''));
    var falta = itensSemMaterial();
    if (falta.length) linhas.push('<span style="color:var(--warning)">Itens da pauta sem documento ou foto que pareça ligado: ' + falta.map(esc).join('; ') + '</span>');
    alvo.innerHTML = linhas.join('<br>');
  };

  // 7. Gerar: envia, acompanha as etapas e baixa os arquivos.
  function desenharEtapas(atual, erro) {
    var alvo = el('apr-etapas');
    if (!alvo) return;
    if (atual == null) { alvo.innerHTML = ''; return; }
    var idx = ETAPAS.indexOf(atual);
    alvo.innerHTML = ETAPAS.map(function (e, i) {
      var feito = atual === 'pronto' || (idx >= 0 && i < idx);
      var agora = i === idx;
      var cor = feito ? 'var(--success)' : agora ? (erro ? 'var(--danger)' : 'var(--text)') : 'var(--muted)';
      return '<div style="font-size:12px;font-family:var(--mono);color:' + cor + '">' + (feito ? '✓ ' : agora ? '● ' : '○ ') + e.charAt(0).toUpperCase() + e.slice(1) + '</div>';
    }).join('');
  }
  function montarEnvio() {
    var c = cond();
    var docsOk = est.docs.filter(function (d) { return d.status === 'ok'; });
    var imagens = [];
    docsOk.forEach(function (d, i) {
      d.imagens.forEach(function (im) {
        imagens.push({
          doc: i, pagina: im.pagina, largura: im.largura, altura: im.altura, area: im.area, hash: im.hash, b64: im.b64, b64_triagem: im.b64_triagem,
          legenda: im.legenda, legenda_editada: im.legenda_editada, triagem: im.triagem, _im: im
        });
      });
    });
    return {
      corpo: {
        idSuperlogica: idCond(c) || undefined, condominio: c ? c.nome : undefined,
        pedido: (el('apr-pedido') || {}).value || '', edital_texto: String(est.edital.texto || '').slice(0, 400000),
        documentos: docsOk.map(function (d) { return { nome: d.nome, tipo: d.tipo, texto: d.texto, paginas: d.paginas, pdf_b64: d.tipo === 'pdf' ? d.pdf_b64 : null }; }),
        fotos: est.fotos.map(function (f) { return { nome: f.nome, legenda: f.legenda, b64: f.b64 }; }),
        imagens_documentos: imagens.map(function (x) { var o = Object.assign({}, x); delete o._im; return o; }),
        logo_cliente_b64: est.logo || undefined
      },
      imagens: imagens
    };
  }
  async function acompanhar(jobId) {
    var t0 = Date.now(), falhas = 0;
    while (true) {
      await new Promise(function (ok) { setTimeout(ok, 3000); });
      if (Date.now() - t0 > 20 * 60 * 1000) throw new Error('A geração passou de 20 minutos. Tente de novo.');
      var st = null;
      try { st = await apiAuthFetch('/api/apresentacao/status/' + encodeURIComponent(jobId), { cache: 'no-store' }); } catch (e) { st = null; }
      if (st && st.status === 404) throw new Error('A geração foi interrompida (o servidor reiniciou). Tente de novo.');
      if (st && st.status === 429) continue;
      if (!st || !st.ok) { if (++falhas > 10) throw new Error('Perdi o contato com o servidor durante a geração. Tente de novo.'); continue; }
      falhas = 0;
      var r = await st.json();
      if (r.status !== 'processing') return r;
      desenharEtapas(r.etapa);
      var b = el('apr-gerar');
      var s = r.esperando_s || 0;
      if (b) b.textContent = 'Gerando (' + Math.floor(s / 60) + 'min ' + String(s % 60).padStart(2, '0') + 's)';
    }
  }
  window.aprGerar = async function () {
    if (est.gerando) return;
    if (!podeGerar()) { aviso('Seu usuário não pode gerar apresentações.', 'err'); return; }
    if (est.lendo) { aviso('Espere terminar a leitura dos documentos.', 'warn'); return; }
    var pedido = ((el('apr-pedido') || {}).value || '').trim();
    var docsOk = est.docs.filter(function (d) { return d.status === 'ok'; });
    if (!pedido && !letras(est.edital.texto) && !docsOk.length) { aviso('Escreva o que você precisa ou anexe o edital.', 'err'); return; }
    if (tamanhoEnvio() > LIM.ENVIO_BYTES) { aviso('O envio passou de 150 MB. Tire alguns documentos ou fotos.', 'err'); return; }
    var c = cond();
    if (!c && !window.confirm('Nenhum condomínio escolhido no topo. Gerar mesmo assim?')) return;
    var semFoto = est.fotos.filter(function (f) { return !f.legenda.trim(); }).length;
    var falta = itensSemMaterial();
    if (falta.length && !window.confirm('Estes itens da pauta não têm documento nem foto que pareça ligado a eles:\n\n' + falta.join('\n')
      + '\n\nEles entram só com o slide de votação. Gerar mesmo assim?')) return;
    if (semFoto && !window.confirm(semFoto + ' foto(s) estão sem legenda. Sem legenda o sistema adivinha o item pelo nome do arquivo. Gerar mesmo assim?')) return;

    est.gerando = true;
    var btn = el('apr-gerar'), texto = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
    var res = el('apr-resultado'); if (res) { res.style.display = 'none'; res.innerHTML = ''; }
    desenharEtapas('lendo os documentos');
    var envio = montarEnvio();
    try {
      var r = await apiAuthFetch('/api/apresentacao/gerar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envio.corpo) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j.jobId) throw new Error(j.detalhe || (r.status === 413 ? 'O envio passou do tamanho aceito.' : 'Não foi possível começar a geração.'));
      var fim = await acompanhar(j.jobId);
      if (fim.status !== 'done') { desenharEtapas(null); throw new Error(fim.detalhe || 'A geração falhou. Tente de novo.'); }
      desenharEtapas('pronto');
      // Legendas e conferência das imagens voltam para a tela (gerar de novo não confere outra vez).
      (fim.imagens || []).forEach(function (x) {
        var alvoIm = envio.imagens[x.local] && envio.imagens[x.local]._im;
        if (!alvoIm) return;
        if (x.triagem) alvoIm.triagem = x.triagem;
        if (!alvoIm.legenda_editada && x.legenda) alvoIm.legenda = x.legenda;
      });
      desenharImagensDocs();
      est.resultado = fim;
      mostrarResultado(fim);
      baixar(fim);
      guardarNaPasta(fim, c);
    } catch (e) {
      aviso(e.message || String(e), 'err');
      var et = el('apr-etapas'); if (et) et.innerHTML += '<div style="font-size:12px;font-family:var(--mono);color:var(--danger);margin-top:6px">' + esc(e.message || String(e)) + '</div>';
    } finally {
      est.gerando = false;
      if (btn) { btn.disabled = !podeGerar(); btn.textContent = texto || 'Gerar apresentação'; }
    }
  };

  function nomeBase(r) { return String((r && r.titulo_arquivo) || 'Apresentação de assembleia').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Apresentação de assembleia'; }
  function urlDe(b64, mime) {
    if (typeof prestacaoPrepararDownload === 'function') return prestacaoPrepararDownload(b64, mime);
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }
  function dispararDownload(url, nome) {
    if (typeof prestacaoDispararDownload === 'function') return prestacaoDispararDownload(url, nome);
    var a = document.createElement('a'); a.href = url; a.download = nome; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }
  var MIME_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  // Escalonado: dois downloads no mesmo instante viram um só no navegador.
  function baixar(r, so) {
    var lista = [];
    if (r.pptx_b64 && (!so || so === 'pptx')) lista.push({ b64: r.pptx_b64, mime: MIME_PPTX, nome: nomeBase(r) + '.pptx' });
    if (r.pdf_b64 && (!so || so === 'pdf')) lista.push({ b64: r.pdf_b64, mime: 'application/pdf', nome: nomeBase(r) + '.pdf' });
    lista.forEach(function (x, i) { setTimeout(function () { dispararDownload(urlDe(x.b64, x.mime), x.nome); }, i * 600); });
  }
  window.aprBaixar = function (tipo) { if (est.resultado) baixar(est.resultado, tipo); };

  function mostrarResultado(r, arquivosGuardados) {
    var alvo = el('apr-resultado');
    if (!alvo) return;
    var avisos = Array.isArray(r.avisos) ? r.avisos : [];
    var botoes = arquivosGuardados
      ? arquivosGuardados.map(function (a, i) { return '<button class="btn btn-primary" onclick="aprBaixarGuardado(' + i + ')">Baixar ' + (/\.pdf$/i.test(a.nome) ? 'PDF' : 'PowerPoint') + '</button>'; }).join(' ')
      : (r.pptx_b64 ? '<button class="btn btn-primary" onclick="aprBaixar(\'pptx\')">Baixar PowerPoint</button> ' : '') + (r.pdf_b64 ? '<button class="btn btn-primary" onclick="aprBaixar(\'pdf\')">Baixar PDF</button>' : '');
    alvo.innerHTML = '<div class="card-header"><span class="card-title">Apresentação pronta</span>'
      + (r.slides ? '<span class="hint" style="margin:0">' + esc(r.slides) + ' slides</span>' : '') + '</div>'
      + '<div style="font-size:13px;margin-bottom:10px">' + esc(nomeBase(r)) + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">' + botoes + '</div>'
      + '<div style="margin-top:14px;font-size:13px;font-weight:600">O que conferir antes de apresentar</div>'
      + (avisos.length ? '<ul style="margin:6px 0 0;padding-left:20px;font-size:13px">' + avisos.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>'
        : '<div class="hint">Nada apontado. Mesmo assim, confira valores, nomes e datas.</div>');
    alvo.style.display = '';
    est._guardados = arquivosGuardados || null;
  }

  // 8. Pasta Em andamento: roteiro e os dois arquivos ficam guardados (prepara a edição de
  // um slide só no futuro). Falha aqui não atrapalha: os arquivos já foram baixados.
  function nomeGuardar(base, ext) { return (String(base).normalize('NFC').replace(/[^A-Za-z0-9 _.()À-ÿ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 110) || 'Apresentacao') + '.' + ext; }
  async function guardarNaPasta(r, c) {
    if (!window.Trabalhos || typeof Trabalhos.salvar !== 'function') return;
    var titulo = 'Apresentação ' + nomeBase(r);
    try {
      var id = await Trabalhos.salvar('apresentacao', {
        idSuperlogica: idCond(c) || null, titulo: titulo.slice(0, 160),
        dados: { versao: 1, roteiro: r.roteiro || null, avisos: r.avisos || [], pauta: r.pauta || [], titulo_arquivo: nomeBase(r), slides: r.slides || 0, geradoEm: new Date().toISOString(), condNome: c ? c.nome : '' }
      });
      est.trabalhoId = id;
      var arqs = [];
      if (r.pptx_b64) arqs.push({ nome: nomeGuardar(nomeBase(r), 'pptx'), b64: r.pptx_b64, mime: MIME_PPTX });
      if (r.pdf_b64) arqs.push({ nome: nomeGuardar(nomeBase(r), 'pdf'), b64: r.pdf_b64, mime: 'application/pdf' });
      for (var i = 0; i < arqs.length; i++) {
        var bin = atob(arqs[i].b64), bytes = new Uint8Array(bin.length);
        for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        await Trabalhos.anexar(id, arqs[i].nome, new Blob([bytes], { type: arqs[i].mime }));
      }
    } catch (e) {
      aviso('A apresentação foi gerada e baixada, mas não ficou guardada na pasta Em andamento.', 'warn');
    }
  }
  async function restaurar(t) {
    var d = t.dados || {};
    est.resultado = null;
    est.trabalhoId = t.id;
    mostrarResultado({ titulo_arquivo: d.titulo_arquivo, slides: d.slides, avisos: d.avisos }, (t.arquivos || []).map(function (a) { return { nome: a.nome, url: a.url }; }));
    var alvo = el('apr-resultado');
    if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  window.aprBaixarGuardado = async function (i) {
    var a = est._guardados && est._guardados[i];
    if (!a) return;
    try {
      var blob = await Trabalhos.baixarArquivo(a.url);
      dispararDownload(URL.createObjectURL(blob), a.nome);
    } catch (e) { aviso('Não foi possível baixar: o link expirou. Abra de novo pela pasta Em andamento.', 'err'); }
  };
  try { if (window.Trabalhos && typeof Trabalhos.registrar === 'function') Trabalhos.registrar('apresentacao', { nome: 'Apresentação de assembleia', painel: PAINEL, restaurar: restaurar }); }
  catch (e) { /* sem a pasta, a tela funciona igual */ }

  window.aprLimpar = function () {
    if (est.gerando) return;
    if ((est.docs.length || est.fotos.length) && !window.confirm('Limpar edital, documentos, fotos e pedido desta tela?')) return;
    est.edital = { nome: '', texto: '' }; est.pauta = []; est.docs = []; est.fotos = []; est.logo = null; est.resultado = null;
    ['apr-edital-texto', 'apr-pedido'].forEach(function (id) { var x = el(id); if (x) x.value = ''; });
    ['apr-edital-status', 'apr-pauta', 'apr-logo-status'].forEach(function (id) { var x = el(id); if (x) x.innerHTML = ''; });
    var res = el('apr-resultado'); if (res) { res.style.display = 'none'; res.innerHTML = ''; }
    desenharEtapas(null); desenharDocs(); desenharImagensDocs(); desenharFotos(); aprResumo();
  };
})();
