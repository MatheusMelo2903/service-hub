// Regras do condomínio: quebra o texto de convenção, regimento ou ata em trechos citáveis.
// Convenção e regimento: um trecho por artigo (com o capítulo em que está). Artigo longo
// vira mais de um trecho com o mesmo rótulo, cortado em parágrafo. Ata ou texto sem artigos:
// blocos de parágrafos de até ~1.500 caracteres. Página: quebra de página (\f) do PDF.
// Função pura, sem banco e sem rede, para o importador e para o envio de documento novo.

const MAX_TRECHO = 3500;
const ALVO_BLOCO = 1500;

const limparLinha = (s) => String(s || '').replace(/[ \t ]+/g, ' ').trim();

// "Art. 44", "Artigo 44º", "ART 12-A", "Art 3°" no começo da linha.
const RE_ARTIGO = /^\s*(?:art(?:igo)?\.?)\s*(\d{1,4})(?:\s*[-–]\s*([A-Z])(?=[\s.,:;)]|$)|([A-Z])(?=[\s.,:;)]|$))?\s*(?:º|°|o\b|ª)?/i;
// Cabeçalhos de capítulo ou seção, guardados como contexto do artigo.
const RE_CAPITULO = /^\s*(cap[ií]tulo|se[cç][aã]o|t[ií]tulo|subse[cç][aã]o)\s+([IVXLC\d]+|[úu]nic[oa])\b/i;

// Normaliza quebras de linha e marca de página. Devolve [{ linha, pagina }].
function linhasComPagina(texto) {
  const paginas = String(texto || '').replace(/\r\n?/g, '\n').split('\f');
  const out = [];
  paginas.forEach((pg, i) => pg.split('\n').forEach((l) => out.push({ linha: l, pagina: i + 1 })));
  return out;
}

// Corta um texto grande em pedaços de até max caracteres, preferindo fim de parágrafo e frase.
function cortar(texto, max) {
  const partes = [];
  let resto = String(texto || '').trim();
  while (resto.length > max) {
    let corte = resto.lastIndexOf('\n', max);
    if (corte < max * 0.5) corte = resto.lastIndexOf('. ', max);
    if (corte < max * 0.5) corte = resto.lastIndexOf(' ', max);
    if (corte <= 0) corte = max;
    partes.push(resto.slice(0, corte + 1).trim());
    resto = resto.slice(corte + 1).trim();
  }
  if (resto) partes.push(resto);
  return partes;
}

// Texto com artigos (convenção, regimento, regulamento).
function porArtigo(linhas) {
  const trechos = [];
  let capitulo = '';
  let atual = null;
  let preambulo = { texto: [], pagina: 1 };
  const fechar = () => {
    if (!atual) return;
    const corpo = atual.linhas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    cortar(corpo, MAX_TRECHO).forEach((pedaco, i) => trechos.push({
      rotulo: atual.rotulo + (i > 0 ? ' (continuação)' : ''), titulo: atual.capitulo || null, texto: pedaco, pagina: atual.pagina,
    }));
    atual = null;
  };
  linhas.forEach(({ linha, pagina }) => {
    const l = limparLinha(linha);
    const cap = l.match(RE_CAPITULO);
    if (cap && l.length < 160) { fechar(); capitulo = l; return; }
    const art = l.match(RE_ARTIGO);
    if (art) {
      fechar();
      const letra = art[2] || art[3];
      atual = { rotulo: 'Art. ' + art[1] + (letra ? '-' + letra.toUpperCase() : ''), capitulo, pagina, linhas: [l] };
      return;
    }
    if (atual) atual.linhas.push(l);
    else if (l) { if (!preambulo.texto.length) preambulo.pagina = pagina; preambulo.texto.push(l); }
  });
  fechar();
  const pre = preambulo.texto.join('\n').trim();
  if (pre.length > 80) cortar(pre, MAX_TRECHO).forEach((p) => trechos.unshift({ rotulo: 'Preâmbulo', titulo: null, texto: p, pagina: preambulo.pagina }));
  return trechos;
}

// Texto sem artigos (ata, comunicado antigo): blocos de parágrafos.
function porBloco(linhas) {
  const trechos = [];
  let buf = [];
  let tam = 0;
  let pagina = 1;
  const fechar = () => {
    const t = buf.join('\n').trim();
    if (t) cortar(t, MAX_TRECHO).forEach((p) => trechos.push({ rotulo: null, titulo: null, texto: p, pagina }));
    buf = []; tam = 0;
  };
  linhas.forEach(({ linha, pagina: pg }) => {
    const l = limparLinha(linha);
    if (!buf.length) pagina = pg;
    buf.push(l);
    tam += l.length + 1;
    if (!l && tam >= ALVO_BLOCO) fechar();
    else if (tam >= ALVO_BLOCO * 1.6) fechar();
  });
  fechar();
  return trechos;
}

// tipo: convencao, regimento, regulamento, ata ou outro. Devolve [{ ordem, rotulo, titulo, texto, pagina }].
function dividirEmTrechos(texto, tipo) {
  const linhas = linhasComPagina(texto);
  const artigos = linhas.filter(({ linha }) => RE_ARTIGO.test(linha)).length;
  const usarArtigos = tipo !== 'ata' && artigos >= 3;
  const lista = (usarArtigos ? porArtigo(linhas) : porBloco(linhas)).filter((t) => t.texto && t.texto.replace(/\s/g, '').length >= 8);
  // Sem quebra de página no texto (texto vindo de outro sistema), a página não é conhecida.
  const temPaginas = String(texto || '').includes('\f');
  return lista.map((t, i) => Object.assign({ ordem: i + 1 }, t, { rotulo: t.rotulo || (tipo === 'ata' ? 'Trecho ' + (i + 1) : null), pagina: temPaginas ? t.pagina : null }));
}

module.exports = { dividirEmTrechos, cortar, RE_ARTIGO };
