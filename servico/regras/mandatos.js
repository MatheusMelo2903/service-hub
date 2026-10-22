// Regras do condomínio: mandatos (síndico, subsíndico e conselho) tirados das atas do acervo.
// Base do alerta de vencimento (servico/regras/alertas-regras.js).
// Regra anti invenção: o mandato só entra se o trecho citado existir literalmente na ata e o
// nome e o cargo estiverem dentro desse trecho. A data de fim só é calculada quando a duração
// do mandato está escrita no trecho da ata ou num artigo conferido da convenção ou do regimento;
// sem isso o fim fica vazio (a tela mostra "sem data de fim" e a pessoa corrige à mão).

const { buscarTrechos, juntarTrechos } = require('./banco');
const { normalizar, pedacos, citacaoExiste, conferirFundamentos, trechosParaPrompt } = require('./citacao');
const { extrairJson } = require('../modelo');

const enc = encodeURIComponent;
const MAX_TEXTO = 120000;
const MAX_ATAS_ACERVO = 6;
const CARGOS = ['sindico', 'subsindico', 'conselho_fiscal', 'conselho_consultivo', 'conselho'];
// Raiz que precisa aparecer no trecho para o cargo valer (evita cargo inventado).
const RAIZ_CARGO = { sindico: 'sindic', subsindico: 'sindic', conselho_fiscal: 'conselh', conselho_consultivo: 'conselh', conselho: 'conselh' };
const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const NUM_EXTENSO = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, doze: 12, dezoito: 18, vinte: 20 };

const SYSTEM = [
  'Você lê uma ata de assembleia de condomínio e lista quem foi eleito ou reconduzido para síndico, subsíndico e conselho (fiscal ou consultivo).',
  'Regras:',
  '1. Só liste eleição registrada na ata. Não presuma.',
  '2. trecho: copie LITERALMENTE a frase da ata que registra a eleição daquela pessoa, contendo o nome e o cargo.',
  '3. cargo: um destes: sindico, subsindico, conselho_fiscal, conselho_consultivo, conselho (quando a ata não diz qual conselho).',
  '4. inicio e fim: datas no formato AAAA-MM-DD SOMENTE se estiverem escritas no trecho; senão deixe null.',
  '5. duracao: se a duração do mandato estiver escrita na ata ou num <trecho> da convenção ou do regimento, informe { "trecho_id": id do trecho ou null quando vier da ata, "citacao": palavras EXATAS que dizem a duração }; senão null.',
  'Responda SÓ com JSON: {"mandatos":[{"cargo":"sindico","nome":"...","inicio":null,"fim":null,"trecho":"...","duracao":null}]}',
].join('\n');

const pad = (n) => String(n).padStart(2, '0');
const isoDe = (a, m, d) => {
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? a + '-' + pad(m) + '-' + pad(d) : null;
};

// 'AAAA-MM-DD', 'DD/MM/AAAA' ou 'DD.MM.AAAA' -> 'AAAA-MM-DD' (ou null).
function dataIso(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return isoDe(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) return isoDe(+m[3], +m[2], +m[1]);
  return null;
}

// Todas as datas escritas num texto ("15/03/2025", "15.03.2025", "15 de março de 2025", "1º de abril de 2026").
function datasNoTexto(texto) {
  const out = new Set();
  const s = String(texto || '');
  for (const m of s.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g)) { const d = isoDe(+m[3], +m[2], +m[1]); if (d) out.add(d); }
  const n = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const m of n.matchAll(/\b(\d{1,2})\s*(?:o|º|°)?\s+de\s+([a-z]+)\s+de\s+(\d{4})\b/g)) {
    const mes = MESES.indexOf(m[2]);
    if (mes >= 0) { const d = isoDe(+m[3], mes + 1, +m[1]); if (d) out.add(d); }
  }
  return out;
}

// Duração do mandato em meses lida da PRÓPRIA citação (nunca do número que o modelo informa).
// Exige uma palavra de mandato na citação, para não pegar "há 2 anos" solto.
function mesesDaCitacao(citacao) {
  // Só dentro de um pedaço contínuo (sem juntar "mandato ... 4 ... anos").
  for (const p of pedacos(citacao)) { const m = mesesDoPedaco(p); if (m) return m; }
  return null;
}
function mesesDoPedaco(citacao) {
  const n = normalizar(citacao);
  if (!/(mandato|bienio|trienio|gestao|prazo)/.test(n)) return null;
  if (/\bbienio\b/.test(n)) return 24;
  if (/\btrienio\b/.test(n)) return 36;
  const m = n.match(/\b(\d{1,2}|um|uma|dois|duas|tres|quatro|cinco|seis|doze|dezoito|vinte e quatro)\s+(?:(?:um|uma|dois|duas|tres|quatro|cinco|seis|doze|dezoito|vinte e quatro)\s+)?(anos?|mes|meses)\b/);
  if (!m) return null;
  const q = m[1] === 'vinte e quatro' ? 24 : (NUM_EXTENSO[m[1]] || Number(m[1]));
  const meses = m[2].startsWith('ano') ? q * 12 : q;
  return meses >= 6 && meses <= 60 ? meses : null;
}

// Soma meses mantendo o dia (31/01 + 1 mês vira o último dia de fevereiro).
function somarMeses(iso, meses) {
  const [a, m, d] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  return alvo.getUTCFullYear() + '-' + pad(alvo.getUTCMonth() + 1) + '-' + pad(Math.min(d, ultimo));
}

// Normaliza o cargo do modelo para um dos CARGOS (ou null).
function cargoDe(v) {
  const n = normalizar(v).replace(/\s+/g, '_');
  if (CARGOS.includes(n)) return n;
  if (/^sub_?sindic/.test(n)) return 'subsindico';
  if (/^sindic/.test(n)) return 'sindico';
  if (/conselh.*fiscal/.test(n)) return 'conselho_fiscal';
  if (/conselh.*consult/.test(n)) return 'conselho_consultivo';
  if (/conselh/.test(n)) return 'conselho';
  return null;
}

// Confere um mandato do modelo contra a ata e os trechos da convenção. Devolve a linha pronta
// para gravar ou null quando falta base (trecho inexistente, nome ou cargo fora do trecho).
function conferirMandato(m, texto, dataAta, trechosPorId) {
  if (!m || typeof m !== 'object') return null;
  const trecho = String(m.trecho || '').trim().slice(0, 1500);
  const nome = String(m.nome || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const cargo = cargoDe(m.cargo);
  if (!cargo || nome.length < 3 || normalizar(trecho).length < 10) return null;
  if (!citacaoExiste(trecho, texto)) return null;
  const nTrecho = normalizar(trecho);
  if (!nTrecho.includes(normalizar(nome)) || !nTrecho.includes(RAIZ_CARGO[cargo])) return null;

  const datas = datasNoTexto(trecho);
  const ini = dataIso(m.inicio);
  let inicio = ini && (datas.has(ini) || ini === dataAta) ? ini : (dataAta || null);
  const f = dataIso(m.fim);
  let fim = f && datas.has(f) ? f : null;
  let duracao = null;
  if (!fim && inicio && m.duracao && typeof m.duracao === 'object') {
    const citacao = String(m.duracao.citacao || '').trim().slice(0, 600);
    let base = null;
    if (m.duracao.trecho_id != null && m.duracao.trecho_id !== '') {
      const { aprovados } = conferirFundamentos([{ trecho_id: m.duracao.trecho_id, citacao }], trechosPorId);
      if (aprovados.length) base = Object.assign({ origem: 'regra' }, aprovados[0]);
    } else if (citacaoExiste(citacao, texto)) base = { origem: 'ata', citacao };
    const meses = base ? mesesDaCitacao(citacao) : null;
    if (meses) { fim = somarMeses(inicio, meses); duracao = Object.assign({ meses }, base); }
  }
  if (fim && inicio && fim <= inicio) fim = null;
  return { cargo, nome, inicio, fim, trecho, duracao };
}

// Grava sem duplicar (mesmo condomínio, cargo, nome e início). Devolve { linha, novo }.
async function gravarMandato(banco, idSL, documentoId, m) {
  const filtro = '/rest/v1/regras_mandatos?id_superlogica=eq.' + enc(idSL) + '&cargo=eq.' + enc(m.cargo)
    + '&nome=eq.' + enc(m.nome) + '&inicio=' + (m.inicio ? 'eq.' + m.inicio : 'is.null') + '&select=*&limit=1';
  const ja = await banco('GET', filtro);
  if (ja.status === 200 && Array.isArray(ja.body) && ja.body[0]) return { linha: ja.body[0], novo: false };
  const ins = await banco('POST', '/rest/v1/regras_mandatos', {
    id_superlogica: Number(idSL), cargo: m.cargo, nome: m.nome, inicio: m.inicio, fim: m.fim,
    documento_id: documentoId || null, trecho: m.trecho, conferido: false,
  });
  if (ins.status !== 201 || !Array.isArray(ins.body) || !ins.body[0]) throw new Error('gravar_mandato_falhou_' + ins.status);
  return { linha: ins.body[0], novo: true };
}

// deps: { banco, chamarModelo, modelos }. opts: { texto, data_ata, documento_id, usuario }.
// Lê uma ata, confere cada eleição e grava. Devolve { ok, mandatos, novos, descartados }.
async function extrairMandatos(deps, idSL, opts) {
  const { banco, chamarModelo, modelos } = deps;
  const o = opts || {};
  const texto = String(o.texto || '');
  if (!texto.trim()) return { ok: false, erro: 'ata_vazia' };
  const dataAta = dataIso(o.data_ata);
  const regras = await juntarTrechos(banco, idSL, ['mandato síndico duração anos', 'mandato conselho fiscal consultivo duração'],
    { tipos: ['convencao', 'regimento'], limite: 4, maxTotal: 8 }).catch(() => []);
  const trechosPorId = new Map(regras.map((t) => [Number(t.trecho_id), t]));
  const content = (regras.length ? 'TRECHOS DA CONVENÇÃO E DO REGIMENTO:\n\n' + trechosParaPrompt(regras) + '\n\n' : '')
    + (dataAta ? 'Data da assembleia: ' + dataAta + '\n\n' : '') + '<ata>\n' + texto.slice(0, MAX_TEXTO) + '\n</ata>';
  const r = await chamarModelo({
    // Esforço baixo e folga de saída: com orçamento curto o modelo gastava tudo pensando e voltava vazio.
    modelo: modelos.modelo('regras_extracao'), maxTokens: 6000, esforco: 'low', system: SYSTEM, content, timeoutMs: 120000,
    rotulo: 'regras_mandatos', usuario: o.usuario || null, condominio: String(idSL), funcao: 'regras',
  });
  if (!r || !r.ok) return { ok: false, erro: (r && r.erro) || 'falha_processamento' };
  const j = extrairJson(r.texto);
  if (!j || !Array.isArray(j.mandatos)) return { ok: false, erro: 'resposta_invalida' };
  const mandatos = [];
  let novos = 0;
  let descartados = 0;
  for (const bruto of j.mandatos.slice(0, 30)) {
    const m = conferirMandato(bruto, texto, dataAta, trechosPorId);
    if (!m) { descartados++; continue; }
    const g = await gravarMandato(banco, idSL, o.documento_id, m);
    if (g.novo) novos++;
    mandatos.push(Object.assign({}, g.linha, { duracao: m.duracao }));
  }
  return { ok: true, mandatos, novos, descartados };
}

const ehConselho = (c) => /^conselho/.test(String(c || ''));

// Lê as atas do acervo que falam de eleição, da mais recente para a mais antiga, até achar o
// mandato atual de síndico e de conselho (no máximo 6 atas, para não gastar à toa).
async function extrairDoAcervo(deps, idSL, opts) {
  const { banco } = deps;
  const achados = await buscarTrechos(banco, idSL, 'eleição eleito eleita mandato síndico conselho', { tipos: ['ata'], limite: 60 });
  const porDoc = new Map();
  achados.forEach((t) => { if (!porDoc.has(t.documento_id)) porDoc.set(t.documento_id, t.data_documento || ''); });
  const docs = [...porDoc].sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, MAX_ATAS_ACERVO);
  const todos = [];
  const falhas = [];
  let lidas = 0;
  let achouSindico = false;
  let achouConselho = false;
  for (const [docId] of docs) {
    if (achouSindico && achouConselho) break;
    const r = await banco('GET', '/rest/v1/regras_documentos?id=eq.' + enc(docId) + '&id_superlogica=eq.' + enc(idSL) + '&tipo=eq.ata&select=id,titulo,texto,data_documento&limit=1');
    const d = r.status === 200 && Array.isArray(r.body) ? r.body[0] : null;
    if (!d || !d.texto) continue;
    lidas++;
    const x = await extrairMandatos(deps, idSL, { texto: d.texto, data_ata: d.data_documento, documento_id: d.id, usuario: opts && opts.usuario });
    if (!x.ok) { falhas.push(d.titulo || ('documento ' + d.id)); continue; }
    x.mandatos.forEach((m) => {
      todos.push(m);
      if (m.cargo === 'sindico') achouSindico = true;
      if (ehConselho(m.cargo)) achouConselho = true;
    });
  }
  return { ok: true, atas_lidas: lidas, atas_com_eleicao: docs.length, mandatos: todos, encontrou: { sindico: achouSindico, conselho: achouConselho }, falhas };
}

// Mandatos do condomínio, com a marca de "atual" (o de início mais recente de cada cargo).
async function listarMandatos(banco, idSL) {
  const r = await banco('GET', '/rest/v1/regras_mandatos?id_superlogica=eq.' + enc(idSL) + '&select=*&order=inicio.desc.nullslast,id.desc&limit=200');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('listar_mandatos_falhou_' + r.status);
  const maisRecente = new Map();
  r.body.forEach((m) => { const k = m.cargo; if (m.inicio && (!maisRecente.has(k) || m.inicio > maisRecente.get(k))) maisRecente.set(k, m.inicio); });
  return r.body.map((m) => Object.assign({}, m, { atual: !maisRecente.has(m.cargo) || m.inicio === maisRecente.get(m.cargo) }));
}

module.exports = { extrairMandatos, extrairDoAcervo, listarMandatos, conferirMandato, mesesDaCitacao, datasNoTexto, dataIso, somarMeses, cargoDe, CARGOS };
