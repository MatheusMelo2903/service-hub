// ============================================================
// LEITURA DE APRESENTAÇÃO E DOCUMENTOS DA ASSEMBLEIA (T43, 2026-10-22)
// ============================================================
// Lê no navegador o que foi anexado em "Apresentação e documentos da assembleia":
//   PowerPoint (.pptx): o texto sai direto do arquivo (slides, tabelas, gráficos, SmartArt e
//     anotações), sem conversão para PDF. Converter num servidor nunca fica 100% igual ao
//     PowerPoint; ler o arquivo direto é exato e mais rápido. As imagens que o slide mostra
//     (prints, fotos, orçamentos colados) vão para leitura visual no servidor, com o texto do
//     slide junto como contexto.
//   PDF: o texto de cada página sai da camada de texto (pdf.js). Toda página que desenha uma
//     imagem vira uma foto da página inteira e vai para leitura visual. PDF escaneado entra
//     no mesmo fluxo (todas as páginas têm imagem).
// Nada aqui chama serviço externo: só prepara texto e imagens. A leitura visual acontece no
// servidor ao gerar a ata (server.js, lerImagensDocumento).
// JSZip já vem global pelo pptxgen.bundle.js carregado no index.html (sem biblioteca nova).

const ATA_IMG_LADO_MAX = 1568;            // lado maior da imagem enviada (limite útil da leitura)
const ATA_IMG_LADO_ECONOMICO = 1280;      // usado quando o orçamento de tamanho aperta
const ATA_IMG_MIN_PX = 120;               // imagem menor que isso é ícone, ignora
const ATA_IMG_AREA_MIN_SLIDE = 0.02;      // imagem que ocupa menos de 2% do slide é ícone, ignora
const ATA_IMG_MAX_POR_DOC = 90;           // teto de imagens por documento
const ATA_IMG_MAX_TOTAL = 160;            // teto de imagens somando todos os documentos
const ATA_IMG_ORCAMENTO_B64 = 46 * 1024 * 1024; // soma do base64 das imagens (rota aceita 64mb)
const ATA_PDF_MIN_FORMAS = 8;            // página de PDF com tantas formas desenhadas (gráfico, tabela desenhada) vai para leitura visual

// Namespaces do Office Open XML usados no .pptx
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

// Soma o base64 de imagens já preparadas em todos os documentos (para o orçamento global).
function ataImgTotais(docs) {
  let qtd = 0, bytes = 0;
  (docs || []).forEach(d => (d.imagens || []).forEach(im => { qtd++; bytes += im.base64.length; }));
  return { qtd, bytes };
}

// Desenha uma imagem (ImageBitmap ou canvas) num canvas reduzido e devolve JPEG em base64.
// Fundo branco para PNG transparente não virar preto. Quando o orçamento aperta, reduz lado e
// qualidade em vez de descartar a imagem.
function ataImgParaJpeg(fonte, largura, altura, economico) {
  const ladoMax = economico ? ATA_IMG_LADO_ECONOMICO : ATA_IMG_LADO_MAX;
  const escala = Math.min(1, ladoMax / Math.max(largura, altura));
  const w = Math.max(1, Math.round(largura * escala));
  const h = Math.max(1, Math.round(altura * escala));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(fonte, 0, 0, w, h);
  const dataUrl = cv.toDataURL('image/jpeg', economico ? 0.7 : 0.82);
  cv.width = 0; cv.height = 0; // libera memória do canvas
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

// Controle de orçamento compartilhado entre os documentos de uma ata.
function ataNovoOrcamento(docsExistentes) {
  const t = ataImgTotais(docsExistentes);
  return { qtd: t.qtd, bytes: t.bytes, descartadas: 0 };
}
function ataOrcamentoCabe(orc, imagensDoDoc) {
  return orc.qtd < ATA_IMG_MAX_TOTAL && imagensDoDoc < ATA_IMG_MAX_POR_DOC && orc.bytes < ATA_IMG_ORCAMENTO_B64;
}
function ataOrcamentoEconomico(orc) { return orc.bytes > ATA_IMG_ORCAMENTO_B64 * 0.55; }

// ------------------------------------------------------------
// PDF
// ------------------------------------------------------------

// Lê um PDF: texto por página e foto das páginas que desenham imagem.
// Devolve { texto, paginas, imagens: [{ ref, base64, mime }], semTexto, descartadas }.
async function ataLerPdfCompleto(arrayBuffer, orc, aoProgresso) {
  const pdfjsLib = await carregarPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const OPS = pdfjsLib.OPS;
  const opsImagem = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintJpegXObject].filter(v => v != null));
  let texto = '';
  const imagens = [];
  let letras = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    if (aoProgresso) aoProgresso('página ' + i + ' de ' + pdf.numPages);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const txt = content.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    letras += txt.replace(/\s+/g, '').length;
    texto += '[página ' + i + '] ' + txt + '\n';
    // Página com imagem ou desenho vira foto da página inteira (texto e imagem juntos dão
    // contexto à leitura visual). Desenho conta porque gráfico exportado do PowerPoint vira
    // formas no PDF e o valor de cada barra não aparece na camada de texto. Página só de
    // texto não precisa: o texto já veio exato.
    let temImagem = false;
    try {
      const ops = await page.getOperatorList();
      let formas = 0;
      for (const fn of ops.fnArray) {
        if (opsImagem.has(fn)) { temImagem = true; break; }
        if (fn === OPS.constructPath) formas++;
      }
      if (formas >= ATA_PDF_MIN_FORMAS) temImagem = true;
    } catch (e) { temImagem = !txt; }
    if (!temImagem && txt.length < 30) temImagem = true; // página quase sem texto: lê a imagem
    if (temImagem) {
      if (!ataOrcamentoCabe(orc, imagens.length)) { orc.descartadas++; page.cleanup(); continue; }
      const vp1 = page.getViewport({ scale: 1 });
      const ladoMax = ataOrcamentoEconomico(orc) ? ATA_IMG_LADO_ECONOMICO : ATA_IMG_LADO_MAX;
      const escala = Math.min(2.5, ladoMax / Math.max(vp1.width, vp1.height));
      const vp = page.getViewport({ scale: escala });
      const cv = document.createElement('canvas');
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const b64 = ataImgParaJpeg(cv, cv.width, cv.height, ataOrcamentoEconomico(orc));
      cv.width = 0; cv.height = 0;
      imagens.push({ ref: 'página ' + i, mime: 'image/jpeg', base64: b64 });
      orc.qtd++; orc.bytes += b64.length;
    }
    page.cleanup();
  }
  return { texto: texto.trim(), paginas: pdf.numPages, imagens, semTexto: letras < 30 * Math.max(1, pdf.numPages) };
}

// ------------------------------------------------------------
// POWERPOINT (.pptx)
// ------------------------------------------------------------

function ataXml(str) { return new DOMParser().parseFromString(str, 'application/xml'); }

// Resolve "../media/image1.png" relativo à pasta do arquivo de origem.
function ataResolverCaminho(pastaBase, alvo) {
  if (alvo.startsWith('/')) return alvo.slice(1);
  const partes = pastaBase.split('/').filter(Boolean);
  alvo.split('/').forEach(p => { if (p === '..') partes.pop(); else if (p && p !== '.') partes.push(p); });
  return partes.join('/');
}

// Lê o arquivo de relações (.rels) de uma parte do pacote: { id: { tipo, alvo } }.
async function ataLerRels(zip, caminhoParte) {
  const i = caminhoParte.lastIndexOf('/');
  const pasta = caminhoParte.slice(0, i);
  const arq = zip.file(pasta + '/_rels/' + caminhoParte.slice(i + 1) + '.rels');
  const mapa = {};
  if (!arq) return mapa;
  const doc = ataXml(await arq.async('string'));
  Array.from(doc.getElementsByTagNameNS(NS_PKG_REL, 'Relationship')).forEach(r => {
    const externo = r.getAttribute('TargetMode') === 'External';
    mapa[r.getAttribute('Id')] = { tipo: r.getAttribute('Type') || '', alvo: externo ? null : ataResolverCaminho(pasta, r.getAttribute('Target') || '') };
  });
  return mapa;
}

// Texto de um parágrafo de DrawingML (a:p): junta a:t, quebras e campos.
function ataTextoParagrafo(p) {
  let s = '';
  const andar = (n) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType !== 1) continue;
      if (c.namespaceURI === NS_A && c.localName === 't') s += c.textContent;
      else if (c.namespaceURI === NS_A && c.localName === 'br') s += ' ';
      else andar(c);
    }
  };
  andar(p);
  return s.replace(/\s+/g, ' ').trim();
}

// Percorre a árvore de um slide em ordem e devolve as linhas de texto. Tabela vira linhas com
// colunas separadas por " | ", para os números ficarem na linha certa.
function ataLinhasDeTexto(raiz) {
  const linhas = [];
  const andar = (n) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType !== 1) continue;
      if (c.namespaceURI === NS_A && c.localName === 'tbl') {
        Array.from(c.getElementsByTagNameNS(NS_A, 'tr')).forEach(tr => {
          const cels = Array.from(tr.childNodes).filter(x => x.nodeType === 1 && x.localName === 'tc')
            .map(tc => Array.from(tc.getElementsByTagNameNS(NS_A, 'p')).map(ataTextoParagrafo).filter(Boolean).join(' '));
          if (cels.some(Boolean)) linhas.push(cels.join(' | '));
        });
      } else if (c.namespaceURI === NS_A && c.localName === 'p') {
        const t = ataTextoParagrafo(c);
        if (t) linhas.push(t);
      } else andar(c);
    }
  };
  andar(raiz);
  return linhas;
}

// Posição de uma forma do slide (EMU). Placeholder sem posição própria herda do layout.
function ataXfrmDe(el) {
  const ns = el.localName === 'graphicFrame' ? NS_P : NS_A;
  let x = null;
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType !== 1) continue;
    if (el.localName === 'graphicFrame' && c.localName === 'xfrm') { x = c; break; }
    if (c.localName === 'spPr' || c.localName === 'grpSpPr') { x = Array.from(c.childNodes).find(k => k.nodeType === 1 && k.localName === 'xfrm' && k.namespaceURI === ns) || null; break; }
  }
  if (!x) return null;
  const off = Array.from(x.childNodes).find(k => k.nodeType === 1 && k.localName === 'off');
  const ext = Array.from(x.childNodes).find(k => k.nodeType === 1 && k.localName === 'ext');
  if (!off || !ext) return null;
  return { x: Number(off.getAttribute('x')) || 0, y: Number(off.getAttribute('y')) || 0, w: Number(ext.getAttribute('cx')) || 0, h: Number(ext.getAttribute('cy')) || 0 };
}
function ataChavePlaceholder(el) {
  const ph = el.getElementsByTagNameNS(NS_P, 'ph')[0];
  if (!ph) return null;
  return (ph.getAttribute('type') || 'body') + ':' + (ph.getAttribute('idx') || '0');
}
// Mapa chave do placeholder -> posição, lido do layout e do mestre (layout vence).
async function ataPosicoesHerdadas(zip, rels, cache) {
  const relLayout = Object.values(rels).find(r => /\/slideLayout$/.test(r.tipo) && r.alvo);
  if (!relLayout) return {};
  if (cache[relLayout.alvo]) return cache[relLayout.alvo];
  const mapa = {};
  const lerParte = async (caminho) => {
    const a = zip.file(caminho);
    if (!a) return;
    const d = ataXml(await a.async('string'));
    Array.from(d.getElementsByTagNameNS(NS_P, 'sp')).forEach(sp => {
      const k = ataChavePlaceholder(sp); const pos = ataXfrmDe(sp);
      if (!k || !pos) return;
      mapa[k] = pos; mapa['tipo:' + k.split(':')[0]] = mapa['tipo:' + k.split(':')[0]] || pos;
    });
  };
  const relsLayout = await ataLerRels(zip, relLayout.alvo);
  const relMestre = Object.values(relsLayout).find(r => /\/slideMaster$/.test(r.tipo) && r.alvo);
  if (relMestre) await lerParte(relMestre.alvo);
  await lerParte(relLayout.alvo); // layout sobrescreve o mestre
  cache[relLayout.alvo] = mapa;
  return mapa;
}

// Ordem de leitura que segue o layout do slide (corte XY recursivo): primeiro separa faixas
// horizontais que nenhuma forma atravessa; dentro de uma faixa, separa colunas; sem corte
// possível, lê por linha e da esquerda para a direita. Formas sem texto (painéis, cartões)
// entram no cálculo porque são elas que mostram o que está agrupado: dois cartões lado a lado
// viram duas colunas lidas inteiras, e rótulo e valor na mesma linha ficam juntos.
function ataOrdemDeLeitura(blocos, tolY, tolX) {
  if (blocos.length <= 1) return blocos;
  const cortar = (eixo, tam, tol) => {
    const ord = blocos.slice().sort((a, b) => a[eixo] - b[eixo]);
    const grupos = [[ord[0]]];
    let fim = ord[0][eixo] + ord[0][tam];
    for (let i = 1; i < ord.length; i++) {
      if (ord[i][eixo] >= fim - tol) grupos.push([ord[i]]); else grupos[grupos.length - 1].push(ord[i]);
      fim = Math.max(fim, ord[i][eixo] + ord[i][tam]);
    }
    return grupos;
  };
  let g = cortar('y', 'h', tolY);
  if (g.length > 1) return [].concat(...g.map(x => ataOrdemDeLeitura(x, tolY, tolX)));
  g = cortar('x', 'w', tolX);
  if (g.length > 1) return [].concat(...g.map(x => ataOrdemDeLeitura(x, tolY, tolX)));
  // Sem corte: se há moldura (forma sem texto que contém outras), tira a moldura e tenta de novo.
  const contem = (m, b) => m !== b && b.x >= m.x - tolX && b.y >= m.y - tolY && b.x + b.w <= m.x + m.w + tolX && b.y + b.h <= m.y + m.h + tolY;
  const semMoldura = blocos.filter(m => m.linhas.length || !blocos.some(b => contem(m, b)));
  if (semMoldura.length && semMoldura.length < blocos.length) return ataOrdemDeLeitura(semMoldura, tolY, tolX);
  // Caixas de texto sobrepostas: lê pelo centro de cada caixa, linha por linha.
  const cy = (b) => b.y + b.h / 2;
  return blocos.slice().sort((a, b) => (Math.round(cy(a) / (tolY * 4)) - Math.round(cy(b) / (tolY * 4))) || (a.x - b.x));
}

// Linhas de texto do slide na ordem visual. Forma sem posição conhecida vai para o topo.
async function ataLinhasDoSlide(zip, slide, rels, areaSlide, cacheLayouts, ladoX, ladoY) {
  const arvore = slide.getElementsByTagNameNS(NS_P, 'spTree')[0];
  if (!arvore) return ataLinhasDeTexto(slide.documentElement);
  const herdadas = await ataPosicoesHerdadas(zip, rels, cacheLayouts);
  const blocos = [];
  let ordemDoc = 0;
  for (const el of Array.from(arvore.childNodes)) {
    if (el.nodeType !== 1 || !/^(sp|grpSp|graphicFrame|pic|cxnSp)$/.test(el.localName)) continue;
    ordemDoc++;
    let pos = ataXfrmDe(el);
    if (!pos) { const k = ataChavePlaceholder(el); if (k) pos = herdadas[k] || herdadas['tipo:' + k.split(':')[0]] || null; }
    const linhas = el.localName === 'pic' || el.localName === 'cxnSp' ? [] : ataLinhasDeTexto(el);
    if (!pos) pos = { x: 0, y: -1 - (1000 - ordemDoc), w: ladoX || 1, h: 0 };
    // Fundo que cobre quase o slide inteiro não agrupa nada: fica fora do cálculo.
    if (!linhas.length && areaSlide && (pos.w * pos.h) / areaSlide > 0.85) continue;
    blocos.push(Object.assign({ linhas }, pos));
  }
  const ordem = ataOrdemDeLeitura(blocos, (ladoY || 6858000) * 0.006, (ladoX || 12192000) * 0.006);
  return [].concat(...ordem.map(b => b.linhas));
}

// Gráfico nativo do PowerPoint: título, séries, categorias e valores exatamente como guardados.
function ataTextoGrafico(doc) {
  const linhas = [];
  const titulo = Array.from(doc.getElementsByTagNameNS(NS_C, 'title')).map(t => ataLinhasDeTexto(t).join(' ')).filter(Boolean)[0];
  if (titulo) linhas.push('Gráfico: ' + titulo);
  const pontos = (no) => {
    if (!no) return [];
    const out = [];
    Array.from(no.getElementsByTagNameNS(NS_C, 'pt')).forEach(pt => {
      const v = pt.getElementsByTagNameNS(NS_C, 'v')[0];
      out[Number(pt.getAttribute('idx')) || out.length] = v ? v.textContent : '';
    });
    return out;
  };
  Array.from(doc.getElementsByTagNameNS(NS_C, 'ser')).forEach(ser => {
    const filho = (nome) => Array.from(ser.childNodes).find(x => x.nodeType === 1 && x.localName === nome);
    const tx = filho('tx');
    const nome = tx ? Array.from(tx.getElementsByTagNameNS(NS_C, 'v')).map(v => v.textContent).join(' ') : '';
    const cats = pontos(filho('cat') || filho('xVal'));
    const vals = pontos(filho('val') || filho('yVal'));
    const pares = vals.map((v, i) => (cats[i] != null && cats[i] !== '' ? cats[i] + ': ' : '') + v).filter(Boolean);
    if (pares.length) linhas.push('Série ' + (nome || '') + ' | ' + pares.join(' | '));
  });
  return linhas;
}

// Decodifica uma imagem do pacote e devolve { bitmap, w, h } ou null se o navegador não abre
// (EMF, WMF e TIFF não abrem no navegador).
async function ataAbrirImagem(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    return { bitmap: bmp, w: bmp.width, h: bmp.height };
  } catch (e) {
    // SVG às vezes não abre por createImageBitmap: tenta por <img>.
    if (!/svg/i.test(blob.type)) return null;
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((ok, falha) => { const im = new Image(); im.onload = () => ok(im); im.onerror = falha; im.src = url; });
      return { bitmap: img, w: img.naturalWidth || 1200, h: img.naturalHeight || 800 };
    } catch (e2) { return null; } finally { URL.revokeObjectURL(url); }
  }
}

const ATA_MIME_POR_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

// Lê um .pptx: texto de cada slide (com tabelas, gráficos, SmartArt e anotações) e as imagens
// que cada slide mostra. Slides ocultos ficam de fora (não foram exibidos na assembleia).
// Devolve { texto, paginas, imagens, ocultos, naoSuportadas }.
async function ataLerPptx(file, orc, aoProgresso) {
  if (!window.JSZip) throw new Error('leitor de PowerPoint não carregou, recarregue a página');
  let zip;
  try { zip = await window.JSZip.loadAsync(await file.arrayBuffer()); }
  catch (e) { throw new Error('arquivo PowerPoint inválido ou corrompido'); }
  const presArq = zip.file('ppt/presentation.xml');
  if (!presArq) throw new Error('não é um PowerPoint .pptx válido');
  const pres = ataXml(await presArq.async('string'));
  const relsPres = await ataLerRels(zip, 'ppt/presentation.xml');
  const sldSz = pres.getElementsByTagNameNS(NS_P, 'sldSz')[0];
  const ladoX = sldSz ? Number(sldSz.getAttribute('cx')) : 0;
  const ladoY = sldSz ? Number(sldSz.getAttribute('cy')) : 0;
  const areaSlide = ladoX * ladoY;
  const cacheLayouts = {};
  const ids = Array.from(pres.getElementsByTagNameNS(NS_P, 'sldId'));
  const caminhos = ids.map(s => relsPres[s.getAttributeNS(NS_R, 'id')]).filter(r => r && r.alvo).map(r => r.alvo);

  let texto = '';
  const imagens = [];
  const jaLidas = {};   // mesma mídia em vários slides é lida uma vez só
  let ocultos = 0, naoSuportadas = 0, numero = 0;

  for (const caminho of caminhos) {
    numero++;
    if (aoProgresso) aoProgresso('slide ' + numero + ' de ' + caminhos.length);
    const arq = zip.file(caminho);
    if (!arq) continue;
    const slide = ataXml(await arq.async('string'));
    const raizSld = slide.documentElement;
    if (raizSld.getAttribute('show') === '0') { ocultos++; continue; }
    const rels = await ataLerRels(zip, caminho);
    const linhas = await ataLinhasDoSlide(zip, slide, rels, areaSlide, cacheLayouts, ladoX, ladoY);

    // Gráficos e SmartArt referenciados pelo slide.
    for (const rid of Object.keys(rels)) {
      const r = rels[rid];
      if (!r.alvo) continue;
      if (/\/chart$/.test(r.tipo)) {
        const ca = zip.file(r.alvo);
        if (ca) linhas.push(...ataTextoGrafico(ataXml(await ca.async('string'))));
      } else if (/\/diagramData$/.test(r.tipo)) {
        const da = zip.file(r.alvo);
        if (da) { const t = ataLinhasDeTexto(ataXml(await da.async('string')).documentElement); if (t.length) linhas.push('Diagrama: ' + t.join(' | ')); }
      }
    }
    // Anotações do apresentador (sem o número do slide).
    const relNotas = Object.values(rels).find(r => /\/notesSlide$/.test(r.tipo) && r.alvo);
    if (relNotas && zip.file(relNotas.alvo)) {
      const notas = ataXml(await zip.file(relNotas.alvo).async('string'));
      const corpo = Array.from(notas.getElementsByTagNameNS(NS_P, 'sp')).filter(sp => {
        const ph = sp.getElementsByTagNameNS(NS_P, 'ph')[0];
        return ph && ph.getAttribute('type') === 'body';
      }).map(sp => ataLinhasDeTexto(sp).join(' ')).join(' ').trim();
      if (corpo) linhas.push('Anotações do apresentador: ' + corpo);
    }
    texto += '[slide ' + numero + '] ' + linhas.join('\n') + '\n';

    // Imagens que o slide mostra (a:blip r:embed). Logos do mestre e do layout não entram.
    const blips = Array.from(slide.getElementsByTagNameNS(NS_A, 'blip'));
    for (const blip of blips) {
      const rid = blip.getAttributeNS(NS_R, 'embed');
      const r = rid && rels[rid];
      if (!r || !r.alvo) continue;
      // Tamanho exibido no slide: ícone pequeno não vale leitura.
      let el = blip.parentNode;
      while (el && !(el.localName === 'pic' || el.localName === 'sp')) el = el.parentNode;
      const ext = el ? el.getElementsByTagNameNS(NS_A, 'ext')[0] : null;
      if (ext && areaSlide) {
        const area = Number(ext.getAttribute('cx')) * Number(ext.getAttribute('cy'));
        if (area > 0 && area / areaSlide < ATA_IMG_AREA_MIN_SLIDE) continue;
      }
      if (jaLidas[r.alvo]) { if (!jaLidas[r.alvo].refs.includes(numero)) jaLidas[r.alvo].refs.push(numero); continue; }
      const extArq = (r.alvo.split('.').pop() || '').toLowerCase();
      const mime = ATA_MIME_POR_EXT[extArq];
      const media = zip.file(r.alvo);
      if (!media) continue;
      if (!mime) { naoSuportadas++; jaLidas[r.alvo] = { refs: [numero] }; continue; }
      if (!ataOrcamentoCabe(orc, imagens.length)) { orc.descartadas++; continue; }
      const aberta = await ataAbrirImagem(new Blob([await media.async('arraybuffer')], { type: mime }));
      if (!aberta) { naoSuportadas++; jaLidas[r.alvo] = { refs: [numero] }; continue; }
      if (aberta.w < ATA_IMG_MIN_PX || aberta.h < ATA_IMG_MIN_PX) { if (aberta.bitmap.close) aberta.bitmap.close(); jaLidas[r.alvo] = { refs: [numero] }; continue; }
      const b64 = ataImgParaJpeg(aberta.bitmap, aberta.w, aberta.h, ataOrcamentoEconomico(orc));
      if (aberta.bitmap.close) aberta.bitmap.close();
      const item = { refs: [numero], mime: 'image/jpeg', base64: b64 };
      jaLidas[r.alvo] = item;
      imagens.push(item);
      orc.qtd++; orc.bytes += b64.length;
    }
  }
  // Referência final de cada imagem: "slide 3" ou "slides 3, 7" quando repete.
  imagens.forEach(im => { im.ref = (im.refs.length > 1 ? 'slides ' : 'slide ') + im.refs.join(', '); delete im.refs; });
  return { texto: texto.trim(), paginas: numero - ocultos, imagens, ocultos, naoSuportadas };
}
