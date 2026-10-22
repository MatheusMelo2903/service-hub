// Regras do condomínio, frente A: importação do acervo exportado do CondGPT (sistema que a
// administradora vai deixar de pagar). O arquivo é lido no navegador e chega aqui um
// condomínio por vez. Aqui ficam:
//  1. conversões puras (tipo, data, carta HTML em texto, unidade e bloco), testáveis sem rede;
//  2. o mapa slug do CondGPT -> código do Superlógica pelo CNPJ;
//  3. a gravação de um condomínio (documentos, notificações, comunicados, atas geradas), que
//     não duplica nada se rodar duas vezes;
//  4. a fila em memória que copia os PDFs do CondGPT para o bucket "regras".
// Tudo recebe `banco` (supabaseAdminRequest) por parâmetro para o teste usar um banco falso.

const https = require('https');
const { inserirDocumento, listarDocumentos, marcarVigente } = require('./banco');

const enc = encodeURIComponent;
const ORIGEM = 'condgpt';
const HOST_CONDGPT = 'condominio.condgpt.app';
// O CondGPT responde 302 para um link temporário do S3. Só seguimos para esses destinos,
// para a cópia nunca virar um jeito de o servidor buscar endereço qualquer.
const HOSTS_REDIRECIONAMENTO = [/\.amazonaws\.com$/i, /(^|\.)condgpt\.app$/i];
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECIONAMENTOS = 4;
const TEMPO_DOWNLOAD_MS = 120000;
// Slugs que não entram (duplicata errada com o CNPJ da própria administradora).
const SLUGS_IGNORADOS = { viladeitaunas: 'duplicata errada com o CNPJ da administradora; o certo é spazioviladeitaunas' };
const CNPJ_ADMINISTRADORA = '24902992000100';
const OBS_DUAS_VERSOES = 'duas versões no sistema antigo, conferir qual vale';
const OBS_ATA_GERADA = 'ata gerada no sistema antigo';
const RE_SLUG = /^[a-z0-9_-]{1,80}$/i;
const RE_PATH_PDF = /^([a-z0-9_-]{1,80})\/[A-Za-z0-9_.-]{1,120}\.pdf$/i;

const MESES = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
const RE_MES = '(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)';

const digitos = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
// O Postgres recusa \u0000 e o JSON não aceita surrogate solto: textos lidos de PDF trazem os dois.
const textoSeguro = (s) => String(s == null ? '' : s)
  .replace(/\u0000/g, '')
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

// ─── 1. Conversões puras ───────────────────────────────────────────────

// 'Atas' -> 'ata', 'Convenção' -> 'convencao', 'Regimento interno' -> 'regimento'; outro -> null.
function mapearTipo(tipo) {
  const t = semAcento(tipo).toLowerCase().trim();
  if (/^atas?$/.test(t)) return 'ata';
  if (/^convencao/.test(t)) return 'convencao';
  if (/^regimento/.test(t)) return 'regimento';
  return null;
}

// Data válida de verdade (recusa 31/02) num intervalo razoável; devolve AAAA-MM-DD ou null.
function dataIso(ano, mes, dia) {
  const a = Number(ano), m = Number(mes), d = Number(dia);
  if (!a || !m || !d || a < 1950 || a > new Date().getUTCFullYear() + 1) return null;
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return a + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// "2024-11-27 (AGO)" ou "2024-11-27 (AGO) (2)" -> '2024-11-27'.
function dataDoNome(nome) {
  const m = String(nome || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})\b/);
  return m ? dataIso(m[1], m[2], m[3]) : null;
}

// Todas as datas escritas num pedaço de texto ("27 de novembro de 2024", "27/11/2024",
// "aos 27 dias do mês de novembro de 2024"). Devolve as datas na ordem em que aparecem.
function datasNoTexto(texto) {
  const s = semAcento(String(texto || '')).toLowerCase();
  const achadas = [];
  const reExtenso = new RegExp('(\\d{1,2})\\s*(?:o|º|°)?\\s+(?:dias?\\s+)?(?:do\\s+mes\\s+)?de\\s+' + semAcento(RE_MES).replace('[cc]', 'c') + '\\s+(?:do\\s+ano\\s+)?de\\s+(\\d{4})', 'g');
  let m;
  while ((m = reExtenso.exec(s))) {
    const d = dataIso(m[3], MESES[m[2]], m[1]);
    if (d) achadas.push({ pos: m.index, data: d });
  }
  const reNum = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  while ((m = reNum.exec(s))) {
    const d = dataIso(m[3], m[2], m[1]);
    if (d) achadas.push({ pos: m.index, data: d });
  }
  return achadas.sort((a, b) => a.pos - b.pos).map((x) => x.data);
}

// Convenção e regimento: data só quando o texto deixa claro. Procura "aprovad..." seguido de
// uma data no começo ou no fim do documento; vale só se houver UMA data assim (duas datas
// diferentes = não está claro, fica sem data).
function dataDaNorma(texto) {
  const t = String(texto || '');
  if (!t.trim()) return null;
  const pedacos = [t.slice(0, 3000), t.length > 3000 ? t.slice(-5000) : ''];
  const datas = new Set();
  pedacos.forEach((p) => {
    const s = semAcento(p).toLowerCase();
    const re = /aprovad[oa]s?\b([\s\S]{0,220})/g;
    let m;
    while ((m = re.exec(s))) {
      // Só até o próximo "aprovad": cada aprovação conta a própria data.
      const primeira = datasNoTexto(m[1].split(/aprovad/)[0])[0];
      if (primeira) datas.add(primeira);
      re.lastIndex = m.index + 8;
    }
  });
  return datas.size === 1 ? [...datas][0] : null;
}

// Ata gerada no CondGPT: data pelo nome; se não tiver, a primeira data do começo da ata
// ("Aos 27 dias do mês de novembro de 2024").
function dataAtaGerada(ata) {
  return dataDoNome(ata && ata.nome) || datasNoTexto(String((ata && ata.texto_final) || '').slice(0, 900))[0] || null;
}

const dataBR = (iso) => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '';

// Título do documento como aparece no acervo. Ata "2024-11-27 (AGO) (2)" -> "Ata AGO de 27/11/2024 (2)".
function tituloDocumento(tipo, nome) {
  const n = limpar(nome);
  if (tipo === 'convencao') return n && !/^conven[cç][aã]o$/i.test(n) ? n : 'Convenção';
  if (tipo === 'regimento') return n && !/^regimento interno$/i.test(n) ? n : 'Regimento interno';
  const m = n.match(/^(\d{4})-(\d{2})-(\d{2})\s*(?:\(([^)]*)\))?\s*(?:\((\d+)\))?\s*$/);
  if (!m) return n ? 'Ata ' + n : 'Ata';
  let sigla = limpar(m[4]);
  let copia = m[5];
  if (/^\d+$/.test(sigla) && !copia) { copia = sigla; sigla = ''; }
  return 'Ata ' + (sigla ? sigla + ' ' : '') + 'de ' + m[3] + '/' + m[2] + '/' + m[1] + (copia ? ' (' + copia + ')' : '');
}

const ENTIDADES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ordm: 'º', ordf: 'ª', deg: '°', sect: '§',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', eacute: 'é', ecirc: 'ê', iacute: 'í', oacute: 'ó',
  ocirc: 'ô', otilde: 'õ', uacute: 'ú', uuml: 'ü', ccedil: 'ç', Aacute: 'Á', Agrave: 'À', Acirc: 'Â',
  Atilde: 'Ã', Eacute: 'É', Ecirc: 'Ê', Iacute: 'Í', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Uacute: 'Ú',
  Ccedil: 'Ç', hellip: '…', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  ndash: '–', mdash: '—', bull: '•', middot: '·',
};
function decodificarEntidades(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (inteiro, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; } catch (er) { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(ENTIDADES, e) ? ENTIDADES[e] : inteiro;
  });
}

// Carta e comunicado do CondGPT vêm em HTML. Vira texto simples com parágrafos (quebra em
// <br>, fim de parágrafo, item de lista e linha de tabela), sem tag e com acento decodificado.
function htmlParaTexto(html) {
  let s = textoSeguro(html);
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|h[1-6]|tr|table|ul|ol|blockquote)\s*>/gi, '\n')
    .replace(/<(p|div|h[1-6]|tr|table|ul|ol|blockquote)(\s[^>]*)?>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  s = decodificarEntidades(s);
  return s.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Unidade do CondGPT é texto livre: "602", "206 1", "603 potira", "1104 1", "Apto 101 Bloco B".
// Separa unidade e bloco quando dá; quando não dá, a unidade fica com o texto original.
function separarUnidade(texto) {
  const original = limpar(texto).slice(0, 60);
  let t = original.replace(/^(apartamento|apto|apt|ap|unidade|und|un|casa|sala|lote)\.?\s*/i, '');
  let m = t.match(/^(\d{1,6}[A-Za-z]?)$/);
  if (m) return { unidade: m[1], bloco: null, original };
  m = t.match(/^(\d{1,6}[A-Za-z]?)\s*(?:[,/]\s*|\s+)(?:(?:bloco|bl|torre|tr|edif[ií]cio|ed)\.?\s*)?([0-9A-Za-zÀ-ÿ][0-9A-Za-zÀ-ÿ ]{0,29})$/);
  if (m) return { unidade: m[1], bloco: m[2].trim(), original };
  m = t.match(/^(?:bloco|bl|torre|tr)\.?\s*([0-9A-Za-z]{1,10})\s*[,/]?\s*(?:apartamento|apto|apt|ap|unidade)?\.?\s*(\d{1,6}[A-Za-z]?)$/i);
  if (m) return { unidade: m[2], bloco: m[1], original };
  return { unidade: original || null, bloco: null, original };
}

// "Advertência" -> 'advertencia', "Multa" -> 'multa'; outro -> null.
function tipoNotificacao(t) {
  const s = semAcento(t).toLowerCase();
  if (/multa/.test(s)) return 'multa';
  if (/advert/.test(s)) return 'advertencia';
  return null;
}

// Data e hora do CondGPT em ISO (aceita "2024-11-27 10:00:00" e "2024-11-27T10:00:00Z").
function instanteIso(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(s.length > 10 ? s.replace(' ', 'T') : s + 'T12:00:00Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const ehRascunho = (v) => v === 1 || v === true || String(v).trim() === '1' || String(v).toLowerCase() === 'true';

// Notificação do CondGPT -> linha de regras_notificacoes. Devolve null se o tipo não for
// advertência nem multa. rascunho 0 = registrada; 1 = rascunho (no CondGPT todas são 1).
function converterNotificacao(n, slug, idSL, criadoPor) {
  const tipo = tipoNotificacao(n && n.tipo_formatted);
  if (!tipo || n.id == null) return null;
  const u = separarUnidade(n.unidade);
  const linha = {
    id_superlogica: Number(idSL), unidade: u.unidade, bloco: u.bloco, tipo,
    ocorrencia: htmlParaTexto(n.ocorrencia).slice(0, 20000) || null,
    texto: htmlParaTexto(n.texto).slice(0, 60000) || null,
    status: ehRascunho(n.rascunho) ? 'rascunho' : 'registrada',
    origem: ORIGEM, origem_id: 'condgpt:' + slug + ':' + String(n.id),
    criado_por: criadoPor || null,
    // Todas as linhas com as mesmas chaves: no envio em lote o PostgREST usa as chaves da primeira.
    criado_em: instanteIso(n.created_at) || new Date().toISOString(),
  };
  return linha;
}

// Caminho do PDF no CondGPT ("<slug>/<uuid>.pdf"), tirado de url_download ou arquivo_pdf.
// Só aceita caminho do próprio condomínio e com nome simples.
function caminhoPdf(doc, slug) {
  const cands = [];
  const url = String((doc && doc.url_download) || '');
  try { if (url) cands.push(new URL(url).searchParams.get('path') || ''); } catch (e) { /* url inválida */ }
  const ap = String((doc && doc.arquivo_pdf) || '');
  if (ap) {
    try { cands.push(/^https?:/i.test(ap) ? (new URL(ap).searchParams.get('path') || '') : ap); } catch (e) { /* ignora */ }
  }
  for (const c of cands) {
    const p = String(c).replace(/^\/+/, '');
    const m = p.match(RE_PATH_PDF);
    if (m && m[1].toLowerCase() === String(slug).toLowerCase()) return p;
  }
  return null;
}
const pathDaObservacao = (obs) => { const m = String(obs || '').match(/condgpt_pdf:(\S+)/); return m ? m[1] : null; };
const urlDownload = (path) => 'https://' + HOST_CONDGPT + '/arquivos?path=' + enc(path);
const juntarObs = (...p) => p.filter(Boolean).join(' | ') || null;

// ─── 2. Mapa slug -> código do Superlógica ─────────────────────────────

// condominios: [{ slug, label, cnpj }] do arquivo. listaSL: condominios/get do Superlógica.
// existentes: linhas atuais de regras_mapa_condgpt. Mesmo CNPJ em mais de um cadastro: fica o ativo. Código informado à mão pelo GESTOR
// (observação "informado manualmente") é mantido. Devolve as linhas do mapa com a situação:
// ok, manual, sem_correspondencia, ambiguo ou ignorado.
function montarMapa(condominios, listaSL, existentes) {
  const porCnpj = new Map();
  const porId = new Map();
  (listaSL || []).forEach((c) => {
    const id = Number(c.id_condominio_cond);
    if (!id) return;
    const nome = limpar(c.st_fantasia_cond) || limpar(c.st_nome_cond);
    porId.set(id, nome);
    const doc = digitos(c.st_cnpj_cond) || digitos(c.st_cpf_cond);
    if (!doc) return;
    if (!porCnpj.has(doc)) porCnpj.set(doc, []);
    porCnpj.get(doc).push({ id, nome, ativo: String(c.fl_ativo_cond == null ? '1' : c.fl_ativo_cond) !== '0' });
  });
  const antes = new Map((existentes || []).map((e) => [e.slug, e]));
  return (condominios || []).filter((c) => c && RE_SLUG.test(String(c.slug || ''))).map((c) => {
    const slug = String(c.slug);
    const cnpj = digitos(c.cnpj);
    const base = { slug, nome: limpar(c.label).slice(0, 200) || slug, cnpj: cnpj || null };
    if (SLUGS_IGNORADOS[slug] || cnpj === CNPJ_ADMINISTRADORA) {
      return Object.assign(base, { id_superlogica: null, nome_superlogica: null, situacao: 'ignorado', observacao: SLUGS_IGNORADOS[slug] || 'CNPJ da administradora; não importar' });
    }
    const ant = antes.get(slug);
    if (ant && ant.id_superlogica && /informado manualmente/i.test(ant.observacao || '')) {
      return Object.assign(base, { id_superlogica: Number(ant.id_superlogica), nome_superlogica: porId.get(Number(ant.id_superlogica)) || null, situacao: 'manual', observacao: ant.observacao });
    }
    // O mesmo CNPJ pode estar num cadastro antigo inativo e no atual: o ativo vale.
    let achados = cnpj ? (porCnpj.get(cnpj) || []) : [];
    if (achados.length > 1 && achados.some((a) => a.ativo)) achados = achados.filter((a) => a.ativo);
    if (achados.length === 1) return Object.assign(base, { id_superlogica: achados[0].id, nome_superlogica: achados[0].nome, situacao: 'ok', observacao: 'pelo CNPJ' });
    if (achados.length > 1) return Object.assign(base, { id_superlogica: null, nome_superlogica: achados.map((a) => a.nome + ' (' + a.id + ')').join(', '), situacao: 'ambiguo', observacao: 'mais de um condomínio com este CNPJ no Superlógica' });
    return Object.assign(base, { id_superlogica: null, nome_superlogica: null, situacao: 'sem_correspondencia', observacao: cnpj ? 'CNPJ não encontrado no Superlógica' : 'sem CNPJ no sistema antigo' });
  });
}

// Grava o mapa (sem upsert no supabaseAdminRequest: lê o que existe, cria as novas e
// atualiza as que mudaram).
async function gravarMapa(banco, linhas, existentes) {
  const antes = new Map((existentes || []).map((e) => [e.slug, e]));
  const novas = [];
  for (const l of linhas) {
    const row = { slug: l.slug, nome: l.nome, cnpj: l.cnpj, id_superlogica: l.id_superlogica, observacao: l.observacao };
    const a = antes.get(l.slug);
    if (!a) { novas.push(row); continue; }
    if (a.nome !== row.nome || a.cnpj !== row.cnpj || Number(a.id_superlogica || 0) !== Number(row.id_superlogica || 0) || a.observacao !== row.observacao) {
      const r = await banco('PATCH', '/rest/v1/regras_mapa_condgpt?slug=eq.' + enc(l.slug), row);
      if (!(r.status >= 200 && r.status < 300)) throw new Error('mapa_atualizar_falhou_' + r.status);
    }
  }
  if (novas.length) {
    const r = await banco('POST', '/rest/v1/regras_mapa_condgpt', novas);
    if (!(r.status >= 200 && r.status < 300)) throw new Error('mapa_inserir_falhou_' + r.status);
  }
}

async function lerMapa(banco) {
  const r = await banco('GET', '/rest/v1/regras_mapa_condgpt?select=slug,nome,cnpj,id_superlogica,observacao&order=slug.asc&limit=1000');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('mapa_ler_falhou_' + r.status);
  return r.body;
}

// ─── 3. Importação de um condomínio ────────────────────────────────────

const contagem = () => ({ novos: 0, duplicados: 0, erros: 0 });

// Convenção e regimento do bloco: quem fica vigente. A versão mais recente (created_at maior)
// de cada tipo vale; as outras ficam como histórico com a observação de conferir. Se o
// condomínio já tem uma versão vigente enviada pelo Hub, nenhuma do CondGPT passa por cima.
function decidirVigentes(docs, existentes) {
  const decisao = new Map(); // id do CondGPT -> { vigente, obs }
  ['convencao', 'regimento'].forEach((tipo) => {
    const lista = docs.filter((d) => mapearTipo(d.tipo) === tipo);
    if (!lista.length) return;
    const jaTemDoHub = (existentes || []).some((e) => e.tipo === tipo && e.vigente && e.origem !== ORIGEM);
    const ordenada = lista.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    ordenada.forEach((d, i) => decisao.set(String(d.id), {
      vigente: !jaTemDoHub && i === 0,
      obs: juntarObs(lista.length > 1 ? OBS_DUAS_VERSOES : null, jaTemDoHub ? 'já havia versão vigente enviada no Hub' : null),
    }));
  });
  return decisao;
}

// Grava os documentos do bloco. Não duplica: documento com PDF já importado (mesmo caminho do
// CondGPT na observação) é pulado; mesmo texto é pulado pelo inserirDocumento (hash).
// Devolve a contagem e a lista de PDFs para copiar.
async function importarDocumentos(banco, ctx, docs, existentes, datasAta) {
  const c = contagem();
  const pdfs = [];
  const erros = [];
  const porPath = new Map();
  existentes.forEach((e) => { const p = pathDaObservacao(e.observacao); if (p) porPath.set(p, e); });
  const vig = decidirVigentes(docs, existentes);
  for (const d of docs) {
    const tipo = mapearTipo(d && d.tipo);
    const path = caminhoPdf(d, ctx.slug);
    if (!tipo) { c.erros++; erros.push('Documento ' + limpar(d && d.nome).slice(0, 60) + ': tipo desconhecido'); continue; }
    if (path && porPath.has(path)) {
      c.duplicados++;
      const e = porPath.get(path);
      if (!e.arquivo_path) pdfs.push({ documento_id: e.id, id_superlogica: ctx.idSL, path });
      continue;
    }
    const texto = textoSeguro(d.texto);
    if (!texto.trim() && !path) { c.erros++; erros.push('Documento ' + limpar(d.nome).slice(0, 60) + ': sem texto e sem PDF'); continue; }
    const data = tipo === 'ata' ? dataDoNome(d.nome) : dataDaNorma(texto);
    const v = vig.get(String(d.id)) || { vigente: true, obs: null };
    try {
      const r = await inserirDocumento(banco, {
        id_superlogica: ctx.idSL, condgpt_slug: ctx.slug, cnpj: ctx.cnpj || null, tipo,
        titulo: tituloDocumento(tipo, d.nome).slice(0, 300), data_documento: data, vigente: tipo === 'ata' ? true : v.vigente,
        origem: ORIGEM, texto, resumo: textoSeguro(d.resumo).trim() || null,
        observacao: juntarObs(path ? 'condgpt_pdf:' + path : null, v.obs, texto.trim() ? null : 'sem texto no sistema antigo'),
        criado_por: ctx.criadoPor || null,
      });
      if (r.duplicado) c.duplicados++;
      else {
        c.novos++;
        if (path) { pdfs.push({ documento_id: r.id, id_superlogica: ctx.idSL, path }); porPath.set(path, { id: r.id }); }
        // Versão nova vinda numa exportação posterior: a antiga do CondGPT deixa de valer.
        if (tipo !== 'ata' && v.vigente && existentes.some((e) => e.tipo === tipo && e.vigente)) await marcarVigente(banco, ctx.idSL, r.id);
      }
      if (tipo === 'ata' && data) datasAta.add(data);
    } catch (e) {
      c.erros++; erros.push('Documento ' + limpar(d.nome).slice(0, 60) + ': ' + String(e && e.message).slice(0, 80));
    }
  }
  return { c, pdfs, erros };
}

// Grava as notificações que ainda não existem (origem_id já gravado é pulado). Lote de 200;
// se o lote for recusado, tenta uma por uma para um registro ruim não derrubar os outros.
async function importarNotificacoes(banco, ctx, notif) {
  const c = contagem();
  const erros = [];
  // O Supabase devolve no máximo 1000 linhas por leitura: lê em páginas.
  const ja = new Set();
  for (let pagina = 0; pagina < 50; pagina++) {
    const r0 = await banco('GET', '/rest/v1/regras_notificacoes?origem=eq.' + ORIGEM + '&origem_id=like.' + enc('condgpt:' + ctx.slug + ':*') + '&select=origem_id&order=id.asc&limit=1000&offset=' + pagina * 1000);
    if (r0.status !== 200 || !Array.isArray(r0.body)) throw new Error('notificacoes_ler_falhou_' + r0.status);
    r0.body.forEach((x) => ja.add(x.origem_id));
    if (r0.body.length < 1000) break;
  }
  const novas = [];
  (notif || []).forEach((n) => {
    const l = converterNotificacao(n, ctx.slug, ctx.idSL, ctx.criadoPor);
    if (!l) { c.erros++; erros.push('Notificação ' + String(n && n.id) + ': tipo desconhecido'); return; }
    if (ja.has(l.origem_id)) { c.duplicados++; return; }
    ja.add(l.origem_id);
    novas.push(l);
  });
  for (let i = 0; i < novas.length; i += 200) {
    const lote = novas.slice(i, i + 200);
    const r = await banco('POST', '/rest/v1/regras_notificacoes', lote);
    if (r.status >= 200 && r.status < 300) { c.novos += lote.length; continue; }
    for (const l of lote) {
      const r1 = await banco('POST', '/rest/v1/regras_notificacoes', l);
      if (r1.status >= 200 && r1.status < 300) c.novos++;
      else if (r1.status === 409) c.duplicados++;
      else { c.erros++; erros.push('Notificação ' + l.origem_id.split(':').pop() + ': recusada (' + r1.status + ')'); }
    }
  }
  return { c, erros };
}

// Comunicados viram documento tipo "outro" com título "Comunicado: ...".
async function importarComunicados(banco, ctx, com) {
  const c = contagem();
  const erros = [];
  for (const m of com || []) {
    const texto = htmlParaTexto(m && m.texto);
    if (!texto) { c.erros++; erros.push('Comunicado ' + limpar(m && m.titulo).slice(0, 60) + ': sem texto'); continue; }
    try {
      const quando = instanteIso(m.created_at);
      const r = await inserirDocumento(banco, {
        id_superlogica: ctx.idSL, condgpt_slug: ctx.slug, cnpj: ctx.cnpj || null, tipo: 'outro',
        titulo: ('Comunicado: ' + (limpar(htmlParaTexto(m.titulo)) || 'sem título')).slice(0, 300),
        data_documento: quando ? quando.slice(0, 10) : null, vigente: true, origem: ORIGEM, texto,
        observacao: 'comunicado do sistema antigo', criado_por: ctx.criadoPor || null,
      });
      if (r.duplicado) c.duplicados++; else c.novos++;
    } catch (e) { c.erros++; erros.push('Comunicado: ' + String(e && e.message).slice(0, 80)); }
  }
  return { c, erros };
}

// Atas geradas pelo CondGPT a partir de gravação: entram só se tiverem texto final e se o
// condomínio não tiver já uma ata com a mesma data (a ata assinada em PDF é a que vale).
async function importarAtasGeradas(banco, ctx, atas, datasAta) {
  const c = Object.assign(contagem(), { mesma_data: 0, sem_texto: 0 });
  const erros = [];
  for (const a of atas || []) {
    const texto = textoSeguro(a && a.texto_final);
    if (!texto.trim()) { c.sem_texto++; continue; }
    const data = dataAtaGerada(a);
    if (data && datasAta.has(data)) { c.mesma_data++; continue; }
    try {
      const r = await inserirDocumento(banco, {
        id_superlogica: ctx.idSL, condgpt_slug: ctx.slug, cnpj: ctx.cnpj || null, tipo: 'ata',
        titulo: (data ? 'Ata de ' + dataBR(data) : 'Ata ' + (limpar(a.nome) || 'sem data')).slice(0, 300),
        data_documento: data, vigente: true, origem: ORIGEM, texto,
        observacao: juntarObs(OBS_ATA_GERADA, data ? null : 'sem data identificada'), criado_por: ctx.criadoPor || null,
      });
      if (r.duplicado) c.duplicados++; else c.novos++;
      if (data) datasAta.add(data);
    } catch (e) { c.erros++; erros.push('Ata gerada: ' + String(e && e.message).slice(0, 80)); }
  }
  return { c, erros };
}

// Importa o bloco de um condomínio do arquivo do CondGPT. ctx: { slug, idSL, cnpj, criadoPor }.
// O bloco pode vir em partes (arquivo grande): cada parte é importada do mesmo jeito e o que
// já entrou é reconhecido. Devolve contagens, PDFs para a fila e até 30 mensagens de erro.
async function importarCondominio(banco, ctx, bloco) {
  const b = bloco && typeof bloco === 'object' ? bloco : {};
  const existentes = await listarDocumentos(banco, ctx.idSL);
  const datasAta = new Set(existentes.filter((e) => e.tipo === 'ata' && e.data_documento).map((e) => String(e.data_documento).slice(0, 10)));
  const docs = Array.isArray(b.docs) ? b.docs : [];
  const D = await importarDocumentos(banco, ctx, docs, existentes, datasAta);
  const N = await importarNotificacoes(banco, ctx, Array.isArray(b.notif) ? b.notif : []);
  const C = await importarComunicados(banco, ctx, Array.isArray(b.com) ? b.com : []);
  const A = await importarAtasGeradas(banco, ctx, Array.isArray(b.atas) ? b.atas : [], datasAta);
  return {
    documentos: D.c, notificacoes: N.c, comunicados: C.c, atas_geradas: A.c,
    pdfs: D.pdfs, erros: [].concat(D.erros, N.erros, C.erros, A.erros).slice(0, 30),
  };
}

// ─── 4. Cópia dos PDFs ─────────────────────────────────────────────────

// Começa com %PDF e cabe no limite do bucket.
function conferirPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return { ok: false, motivo: 'arquivo vazio' };
  if (buf.length > MAX_PDF_BYTES) return { ok: false, motivo: 'maior que 50 MB' };
  if (buf.slice(0, 4).toString('latin1') !== '%PDF') return { ok: false, motivo: 'o conteúdo não é PDF' };
  return { ok: true };
}

const hostPermitido = (h) => HOSTS_REDIRECIONAMENTO.some((re) => re.test(h)) || h === HOST_CONDGPT;

// Baixa o PDF do CondGPT seguindo o redirecionamento para o S3 (https nativo, sem biblioteca).
// Corta no meio se passar de 50 MB. Só segue https para os hosts permitidos.
function baixarUrl(url, saltos) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('endereço inválido')); }
    if (u.protocol !== 'https:' || !hostPermitido(u.hostname)) return reject(new Error('destino não permitido'));
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { accept: 'application/pdf,*/*' } }, (resp) => {
      const st = resp.statusCode;
      if (st >= 300 && st < 400 && resp.headers.location) {
        resp.resume();
        if ((saltos || 0) >= MAX_REDIRECIONAMENTOS) return reject(new Error('redirecionamentos demais'));
        let prox;
        try { prox = new URL(resp.headers.location, u).toString(); } catch (e) { return reject(new Error('redirecionamento inválido')); }
        return baixarUrl(prox, (saltos || 0) + 1).then(resolve, reject);
      }
      if (st !== 200) { resp.resume(); return reject(new Error('resposta ' + st)); }
      const tam = Number(resp.headers['content-length'] || 0);
      if (tam > MAX_PDF_BYTES) { resp.destroy(); return reject(new Error('maior que 50 MB')); }
      const partes = [];
      let total = 0;
      resp.on('data', (c) => {
        total += c.length;
        if (total > MAX_PDF_BYTES) { resp.destroy(); reject(new Error('maior que 50 MB')); return; }
        partes.push(c);
      });
      resp.on('end', () => resolve(Buffer.concat(partes)));
      resp.on('error', (e) => reject(e));
      resp.on('aborted', () => reject(new Error('download interrompido')));
    });
    req.setTimeout(TEMPO_DOWNLOAD_MS, () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
  });
}
const baixarPdfCondgpt = (path) => baixarUrl(urlDownload(path), 0);

// Fila em memória do processo (o Railway pode reiniciar; por isso existe o "retomar").
// opts: { banco, storageUpload, baixar (path -> Buffer), simultaneos (2), tentativas (3),
// esperaMs (entre tentativas) }. Cada item: { documento_id, id_superlogica, path }.
function criarFilaPdf(opts) {
  const o = Object.assign({ simultaneos: 2, tentativas: 3, esperaMs: 4000, baixar: baixarPdfCondgpt }, opts || {});
  const fila = [];
  const conhecidos = new Set(); // documento_id na fila ou copiando agora
  const est = { total: 0, copiados: 0, falhas: 0, em_andamento: 0, ultimas_falhas: [] };
  let ativos = 0;
  let ociosoResolver = [];

  function enfileirar(itens) {
    let n = 0;
    (itens || []).forEach((it) => {
      if (!it || !it.documento_id || !it.path || !RE_PATH_PDF.test(it.path) || conhecidos.has(it.documento_id)) return;
      conhecidos.add(it.documento_id);
      fila.push(Object.assign({}, it));
      est.total++; n++;
    });
    puxar();
    return n;
  }
  function puxar() {
    while (ativos < o.simultaneos && fila.length) {
      const it = fila.shift();
      ativos++; est.em_andamento = ativos;
      copiar(it).finally(() => {
        ativos--; est.em_andamento = ativos;
        conhecidos.delete(it.documento_id);
        if (fila.length) puxar();
        else if (!ativos) { const r = ociosoResolver; ociosoResolver = []; r.forEach((f) => f()); }
      });
    }
  }
  // Uma cópia: baixa, confere que é PDF, envia ao bucket e grava o caminho no documento.
  async function copiar(it) {
    let ultimo = '';
    for (let t = 1; t <= o.tentativas; t++) {
      try {
        const buf = await o.baixar(it.path);
        const c = conferirPdf(buf);
        if (!c.ok) throw new Error(c.motivo);
        const destino = Number(it.id_superlogica) + '/' + Number(it.documento_id) + '.pdf';
        await o.storageUpload('regras', destino, buf, 'application/pdf');
        const r = await o.banco('PATCH', '/rest/v1/regras_documentos?id=eq.' + Number(it.documento_id), { arquivo_path: destino, arquivo_bytes: buf.length, atualizado_em: new Date().toISOString() });
        if (!(r.status >= 200 && r.status < 300)) throw new Error('gravar no documento falhou (' + r.status + ')');
        est.copiados++;
        return;
      } catch (e) {
        ultimo = String((e && e.message) || e).slice(0, 120);
        if (t < o.tentativas && o.esperaMs) await new Promise((ok) => setTimeout(ok, o.esperaMs * t));
      }
    }
    est.falhas++;
    est.ultimas_falhas.unshift({ documento_id: it.documento_id, id_superlogica: it.id_superlogica, motivo: ultimo, em: new Date().toISOString() });
    est.ultimas_falhas.length = Math.min(est.ultimas_falhas.length, 50);
    console.warn('[regras importar] PDF do documento ' + it.documento_id + ' não copiado: ' + ultimo);
  }
  function status() {
    return { total: est.total, copiados: est.copiados, falhas: est.falhas, em_andamento: est.em_andamento, pendentes: fila.length, ultimas_falhas: est.ultimas_falhas.slice(0, 20) };
  }
  // Para o teste: resolve quando a fila esvaziar.
  function ocioso() { return !ativos && !fila.length ? Promise.resolve() : new Promise((ok) => ociosoResolver.push(ok)); }
  return { enfileirar, status, ocioso };
}

// Documentos do CondGPT ainda sem PDF no bucket (para retomar depois de reinício). Página de 1000.
async function pendentesPdf(banco) {
  const out = [];
  for (let pagina = 0; pagina < 20; pagina++) {
    const r = await banco('GET', '/rest/v1/regras_documentos?origem=eq.' + ORIGEM + '&arquivo_path=is.null&observacao=like.' + enc('*condgpt_pdf:*') + '&select=id,id_superlogica,observacao&order=id.asc&limit=1000&offset=' + pagina * 1000);
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('pendentes_ler_falhou_' + r.status);
    r.body.forEach((d) => { const p = pathDaObservacao(d.observacao); if (p && d.id_superlogica) out.push({ documento_id: d.id, id_superlogica: d.id_superlogica, path: p }); });
    if (r.body.length < 1000) break;
  }
  return out;
}

module.exports = {
  ORIGEM, SLUGS_IGNORADOS, CNPJ_ADMINISTRADORA, RE_SLUG, MAX_PDF_BYTES,
  mapearTipo, dataDoNome, datasNoTexto, dataDaNorma, dataAtaGerada, tituloDocumento,
  htmlParaTexto, separarUnidade, tipoNotificacao, converterNotificacao, caminhoPdf, pathDaObservacao, textoSeguro,
  montarMapa, gravarMapa, lerMapa, decidirVigentes, importarCondominio,
  conferirPdf, baixarUrl, baixarPdfCondgpt, criarFilaPdf, pendentesPdf,
};
