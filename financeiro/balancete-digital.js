'use strict';
// ─────────────────────────────────────────────────────────────────────────
// Balancete digital e fechamento do mês feitos pelo SISTEMA (decisão do Matheus, 23/10/2026):
// o Hub aprende o modelo de cada condomínio, junta os documentos, grava os comentários com anexo
// e etiqueta no Demonstrativo R&D, confere e deixa pronto. A pessoa só confere o que o sistema
// marcou e confirma o fechamento e a publicação (a publicação é de outra frente).
//
// Este arquivo tem a lógica (funções puras) e as chamadas ao Superlógica pela chave da API do Hub.
// Toda gravação passa antes pela política única (servico/escrita-superlogica.js): quem chama
// estas funções de gravação já tem a autorização. Rotas testadas no 167 (rotas_tela_167.md):
//   arquivos/put (multipart, ID_RESPONSAVEL_ARQ obrigatório), arquivos/adicionaretiqueta,
//   comentarios/putarquivos, comentarios/put (VISIBILIDADE=0 explícito), comentarios/index,
//   comentarios/delete, arquivos/delete, condominios/fecharmes (DT_FECHAMENTO; reabrir é mandar
//   uma data antiga, 01/01/1899 = nunca fechado; campo vazio dá erro), condominios/get com
//   comDataFechamento=1 para reler.
// Armadilhas: data sempre MM/DD/AAAA; erro vem com HTTP 200 e o campo status; o gateway corta em
// 60 s; sem resposta nunca se repete a gravação sem reler antes.
// ─────────────────────────────────────────────────────────────────────────
const https = require('https');
const crypto = require('crypto');

const NAO_CONDOMINIOS = new Set(['143', '144', '145', '160', '162']);
const ID = /^[1-9]\d{0,8}$/;
const MAX_ARQUIVO = 15 * 1024 * 1024; // limite do Superlógica
const NUNCA_FECHADO = '01/01/1899';
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const dois = (n) => String(n).padStart(2, '0');
const cent = (v) => Math.round(Number(v || 0) * 100) / 100;
const brl = (v) => 'R$ ' + cent(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── datas ───────────────────────────────────────────────────────────────
// 'AAAA-MM' -> { ano, mes, chave, inicio, fim (ISO), rotulo 'MM/AAAA' }
function competencia(v) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(v || ''));
  if (!m) return null;
  const ano = +m[1], mes = +m[2];
  if (mes < 1 || mes > 12 || ano < 2020 || ano > 2100) return null;
  const ult = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return { ano, mes, chave: m[1] + '-' + m[2], inicio: m[1] + '-' + m[2] + '-01', fim: m[1] + '-' + m[2] + '-' + dois(ult), rotulo: m[2] + '/' + m[1], ultimoDia: ult };
}
function somarMeses(c, n) {
  const t = c.ano * 12 + (c.mes - 1) + n;
  return competencia(Math.floor(t / 12) + '-' + dois((t % 12) + 1));
}
const isoParaSL = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? m[2] + '/' + m[3] + '/' + m[1] : ''; };
// O Superlógica devolve datas MM/DD/AAAA (às vezes com hora) ou AAAA-MM-DD. Devolve ISO ou ''.
function slParaIso(v) {
  const s = limpar(v);
  let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return m[3] + '-' + m[1] + '-' + m[2];
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}
const isoBR = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; };
// Data de hoje em Brasília (ISO).
function hojeSP(agora) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(agora || new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}

// ── modelo do balancete ────────────────────────────────────────────────
// Etiquetas conhecidas do Superlógica (arquivos/etiquetas). O id certo é lido do próprio
// Superlógica; esta lista só serve de reserva quando a leitura falha (8 = Extrato, testado no 167).
const ETIQUETAS_RESERVA = { extrato: 8 };

// Título do comentário sem mês, ano e números: "Extrato conta corrente 09/2026" -> "extrato conta corrente".
const MESES_NOMES = /\b(jan(eiro)?|fev(ereiro)?|mar(co)?|abr(il)?|mai(o)?|jun(ho)?|jul(ho)?|ago(sto)?|set(embro)?|out(ubro)?|nov(embro)?|dez(embro)?)\b/g;
function chaveTitulo(t) {
  return semAcento(String(t || '')).toLowerCase()
    .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, ' ').replace(/\d{1,2}\/\d{4}/g, ' ').replace(MESES_NOMES, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(de|da|do|das|dos|e|ref|referente|mes|competencia)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// De onde vem o documento de cada comentário. relatorio: o Hub gera no Superlógica pela API (fica
// só para a administração). capa: o Hub monta o PDF. recebido: precisa chegar ao Hub (extrato do
// banco, garantidora, francesinha, certidões): enquanto não chega, vira trava com quem precisa agir.
function classificarDocumento(titulo) {
  const t = semAcento(String(titulo || '')).toLowerCase();
  const tem = (re) => re.test(t);
  if (tem(/\bcapa\b/)) return { tipo: 'capa', descricao: 'Capa do balancete (o Hub monta)', confianca: 'alta' };
  if (tem(/simula|\b0?74a\b|arrecada/)) return { tipo: 'relatorio', codigo: '074A', descricao: 'Simulação das arrecadações (74A, o Hub gera)', confianca: 'alta' };
  if (tem(/\b0?11a\b|anual|12 meses|doze meses|comparativ/)) return { tipo: 'relatorio', codigo: '011A', descricao: 'Demonstrativo anual de 12 meses (11A, o Hub gera)', confianca: 'alta' };
  if (tem(/pjbank|pj bank|boletos? pagos|liquidos|liquidados/)) return { tipo: 'relatorio', codigo: '006C', descricao: 'Receitas liquidadas por condômino (006C, o Hub gera)', confianca: 'media' };
  if (tem(/inadimpl/)) return { tipo: 'relatorio', codigo: '003A', descricao: 'Inadimplência do mês (003A, o Hub gera)', confianca: 'media' };
  if (tem(/extrato/) && tem(/poupan|aplica|fundo|rdc|cdb|invest/)) return { tipo: 'recebido', grupo: 'extrato_poupanca', descricao: 'Extrato da poupança ou aplicação, do banco', quem: 'Financeiro: baixar o PDF no banco e enviar no Hub', confianca: 'alta' };
  if (tem(/mercado ?pago/)) return { tipo: 'recebido', grupo: 'extrato_externo', descricao: 'Extrato do Mercado Pago', quem: 'Financeiro: baixar o PDF no Mercado Pago e enviar no Hub', confianca: 'alta' };
  if (tem(/extrato/)) return { tipo: 'recebido', grupo: 'extrato_conta', descricao: 'Extrato da conta corrente, do banco', quem: 'Financeiro: baixar o PDF no banco e enviar no Hub', confianca: 'alta' };
  if (tem(/garantidora/)) return { tipo: 'recebido', grupo: 'garantidora', descricao: 'Relatório da garantidora', quem: 'Garantidora: mandar o relatório do mês; financeiro envia no Hub', confianca: 'alta' };
  if (tem(/francesinha/)) return { tipo: 'recebido', grupo: 'francesinha', descricao: 'Francesinha do banco', quem: 'Financeiro: baixar a francesinha no banco e enviar no Hub', confianca: 'alta' };
  if (tem(/certid/)) return { tipo: 'recebido', grupo: 'certidoes', descricao: 'Certidões do condomínio', quem: 'Financeiro: emitir as certidões e enviar no Hub', confianca: 'alta' };
  return { tipo: 'recebido', grupo: 'outro', descricao: 'Documento do condomínio', quem: 'Financeiro: enviar o documento no Hub', confianca: 'baixa' };
}

// Um comentário lido do Superlógica, em formato do Hub. Formato conferido no 167 (23/10/2026):
// id_comentarioconteudo_comc, st_texto_comc (o "nome" do comentário: o TITULO enviado não é
// guardado), fl_visibilidade_comc, st_identificadororigem_como "<cond>_<plano>_<conta>/AAAAMM" e
// arquivos[] com st_nomeetiqueta_eti e etiquetas[{ id_etiqueta_eti }].
function lerComentario(c) {
  if (!c || typeof c !== 'object') return null;
  const pega = (re) => { for (const k of Object.keys(c)) if (re.test(k) && c[k] != null && typeof c[k] !== 'object' && String(c[k]) !== '') return String(c[k]); return ''; };
  const id = pega(/^id_comentarioconteudo_comc$/i) || pega(/^id_comentario/i);
  const texto = limpar(pega(/^st_texto|^texto$|^tx_/i)).slice(0, 300);
  const titulo = limpar(pega(/^st_titulo|^titulo$/i)) || texto.slice(0, 120);
  let conta = pega(/^id_objeto|^st_objeto/i);
  let plano = '', ref = '';
  for (const k of Object.keys(c)) {
    const m = /^(\d+)_(\d+)_([\d.]+)\/(\d{6})$/.exec(String(c[k] || ''));
    if (m) { plano = m[2]; if (!conta) conta = m[3]; ref = m[4].slice(0, 4) + '-' + m[4].slice(4); break; }
  }
  if (!ref) { const iso = slParaIso(pega(/^dt_referencia/i)); if (iso) ref = iso.slice(0, 7); }
  const vis = pega(/visibilidade/i);
  const arquivos = (Array.isArray(c.arquivos) ? c.arquivos : []).map((a) => {
    if (!a || typeof a !== 'object') return null;
    let etiquetaId = '', etiquetaNome = '';
    const etq = Array.isArray(a.etiquetas) ? a.etiquetas[0] : null;
    if (etq && typeof etq === 'object') { etiquetaId = String(etq.id_etiqueta_eti || etq.id || ''); etiquetaNome = limpar(etq.st_nome_eti || etq.st_etiqueta_eti || etq.nome || ''); }
    if (!etiquetaId) etiquetaId = String(a.id_etiqueta_eti || '');
    if (!etiquetaNome) etiquetaNome = limpar(a.st_nomeetiqueta_eti || a.st_nome_eti || a.st_etiqueta_eti || '');
    return { id: String(a.id_arquivo_arq || ''), nome: limpar(a.st_nome_arq), extensao: limpar(a.st_extensao_arq), etiqueta_id: /^\d+$/.test(etiquetaId) ? Number(etiquetaId) : null, etiqueta_nome: etiquetaNome };
  }).filter((a) => a && /^\d+$/.test(a.id));
  return { id: /^\d+$/.test(id) ? id : '', titulo, texto, conta: limpar(conta), plano, referencia: ref, visibilidade: vis === '' ? null : Number(vis), arquivos };
}

// Aprende o modelo a partir dos comentários dos últimos meses (um array por mês, na ordem em que
// o Superlógica devolveu). Item que aparece em pelo menos metade dos meses entra no modelo; o resto
// fica como "às vezes", para a pessoa decidir. A ordem é a média da posição de cada item.
function aprenderModelo(porMes, opcoes) {
  const meses = Object.keys(porMes || {}).sort();
  const grupos = new Map();
  let plano = '';
  for (const mes of meses) {
    const lista = (porMes[mes] || []).map(lerComentario).filter((c) => c && c.titulo);
    lista.forEach((c, pos) => {
      if (c.plano && !plano) plano = c.plano;
      const chave = chaveTitulo(c.titulo);
      if (!chave) return;
      const g = grupos.get(chave) || { chave, titulos: new Map(), contas: new Map(), etiquetas: new Map(), meses: new Set(), posicoes: [], anexos: 0 };
      g.titulos.set(c.titulo, (g.titulos.get(c.titulo) || 0) + 1);
      if (c.conta) g.contas.set(c.conta, (g.contas.get(c.conta) || 0) + 1);
      c.arquivos.forEach((a) => { if (a.etiqueta_id) { const k = a.etiqueta_id + '|' + a.etiqueta_nome; g.etiquetas.set(k, (g.etiquetas.get(k) || 0) + 1); } });
      if (c.arquivos.length) g.anexos++;
      g.meses.add(mes);
      g.posicoes.push(lista.length > 1 ? pos / (lista.length - 1) : 0);
      grupos.set(chave, g);
    });
  }
  const maisComum = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  const minimo = Math.max(1, Math.ceil(meses.length / 2));
  const itens = [...grupos.values()].map((g) => {
    const titulo = maisComum(g.titulos)[0];
    const conta = g.contas.size ? maisComum(g.contas)[0] : '';
    const etq = g.etiquetas.size ? maisComum(g.etiquetas)[0].split('|') : null;
    const doc = classificarDocumento(titulo);
    return {
      chave: g.chave.replace(/\s+/g, '_').slice(0, 60), titulo: titulo.replace(/\s*\b\d{1,2}\/\d{4}\b/g, '').trim() || titulo, conta,
      etiqueta_id: etq ? Number(etq[0]) : null, etiqueta_nome: etq ? etq[1] : '',
      fonte: doc, meses: g.meses.size, frequente: g.meses.size >= minimo, com_anexo: g.anexos > 0,
      ordem_media: g.posicoes.reduce((s, x) => s + x, 0) / g.posicoes.length,
    };
  }).sort((a, b) => a.ordem_media - b.ordem_media);
  const usar = itens.filter((i) => i.frequente && i.com_anexo);
  usar.forEach((i, k) => { i.ordem = k + 1; delete i.ordem_media; });
  const asVezes = itens.filter((i) => !(i.frequente && i.com_anexo)).map((i) => { delete i.ordem_media; return i; });
  const avisos = [];
  usar.forEach((i) => {
    if (!i.conta) avisos.push('"' + i.titulo + '": não foi possível saber em que conta do R&D o comentário fica.');
    if (!i.etiqueta_id) avisos.push('"' + i.titulo + '": anexo sem etiqueta nos meses lidos.');
    if (i.fonte.confianca !== 'alta') avisos.push('"' + i.titulo + '": o sistema não tem certeza de onde vem o documento (' + i.fonte.descricao + ').');
  });
  return { meses_lidos: meses, plano: plano || (opcoes && opcoes.plano) || '', itens: usar, as_vezes: asVezes, avisos, aprendido_em: new Date().toISOString() };
}

// Confere um modelo salvo ou editado pela pessoa. Devolve { itens } normalizados ou { erro }.
function validarModelo(itens) {
  if (!Array.isArray(itens) || !itens.length || itens.length > 40) return { erro: 'O modelo precisa ter de 1 a 40 comentários.' };
  const out = [];
  const chaves = new Set();
  for (const [k, i] of itens.entries()) {
    if (!i || typeof i !== 'object') return { erro: 'Item ' + (k + 1) + ' inválido.' };
    const titulo = limpar(i.titulo).replace(/[^\p{L}\p{N} .,_()\/&+-]/gu, ' ').slice(0, 120).trim();
    if (titulo.length < 3) return { erro: 'Item ' + (k + 1) + ': título muito curto.' };
    const conta = limpar(i.conta);
    if (!/^\d+(\.\d+){0,4}$/.test(conta)) return { erro: '"' + titulo + '": conta do R&D inválida (ex.: 1.1).' };
    const etq = i.etiqueta_id == null || i.etiqueta_id === '' ? null : Number(i.etiqueta_id);
    if (etq !== null && !(Number.isInteger(etq) && etq > 0 && etq < 100000)) return { erro: '"' + titulo + '": etiqueta inválida.' };
    const chave = limpar(i.chave || chaveTitulo(titulo).replace(/\s+/g, '_')).replace(/[^a-z0-9_]/g, '').slice(0, 60);
    if (!chave || chaves.has(chave)) return { erro: '"' + titulo + '": item repetido.' };
    chaves.add(chave);
    const f = i.fonte && typeof i.fonte === 'object' ? i.fonte : classificarDocumento(titulo);
    let fonte;
    if (f.tipo === 'relatorio' && /^\d{3}[A-Z]$/.test(String(f.codigo || ''))) fonte = { tipo: 'relatorio', codigo: f.codigo, descricao: limpar(f.descricao).slice(0, 120) };
    else if (f.tipo === 'capa') fonte = { tipo: 'capa', descricao: 'Capa do balancete (o Hub monta)' };
    else fonte = { tipo: 'recebido', grupo: limpar(f.grupo || 'outro').slice(0, 30), descricao: limpar(f.descricao || 'Documento do condomínio').slice(0, 120), quem: limpar(f.quem || 'Financeiro: enviar o documento no Hub').slice(0, 160) };
    out.push({ chave, ordem: out.length + 1, titulo, conta, etiqueta_id: etq, etiqueta_nome: limpar(i.etiqueta_nome).slice(0, 40), fonte });
  }
  return { itens: out };
}

// ── cliente de gravação (chave da API do Hub) ─────────────────────────
// Pedido ao Superlógica. Devolve { status, json }. Nunca registra chave nem corpo.
function pedir({ base, appToken, accessToken }, metodo, caminho, query, corpo, tipoCorpo) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(base + '/v2/condor/' + caminho); } catch (e) { return resolve({ status: 0, json: null }); }
    Object.entries(query || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
    const dados = corpo || Buffer.alloc(0);
    const r = https.request({
      hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: metodo,
      headers: { app_token: appToken, access_token: accessToken, accept: 'application/json', 'content-type': tipoCorpo || 'application/x-www-form-urlencoded', 'content-length': dados.length },
    }, (resp) => {
      const partes = [];
      resp.on('data', (c) => { if (partes.length < 400) partes.push(c); });
      resp.on('error', () => resolve({ status: 0, json: null }));
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(partes).toString('utf8').replace(/^﻿/, '')); } catch (e) { json = null; }
        resolve({ status: resp.statusCode, json });
      });
    });
    r.setTimeout(65000, () => { r.destroy(); resolve({ status: 504, json: null }); });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.end(dados);
  });
}
// O Superlógica responde erro com HTTP 200 ou 206: o que vale é o status do corpo.
// Formato de tela: { status, data:[{ status, msg, data }] }; formato da API: [{ status, msg, data }].
function corpoOk(r) {
  const j = r && r.json;
  let item = Array.isArray(j) ? j[0] : j;
  if (item && Array.isArray(item.data) && item.data[0] && item.data[0].status != null) item = item.data[0];
  const ok = !!r && r.status >= 200 && r.status < 300 && !!item && typeof item === 'object' && String(item.status) === '200';
  const semResposta = !r || r.status === 0 || r.status === 504 || (r.status >= 500 && !item);
  return { ok, semResposta, item, msg: item && item.msg ? limpar(item.msg).slice(0, 200) : (r && r.status ? 'HTTP ' + r.status : 'sem resposta') };
}
const formulario = (campos) => Buffer.from(new URLSearchParams(Object.entries(campos).map(([k, v]) => [k, String(v)])).toString(), 'utf8');

// Trava de condomínio: todo campo de condomínio no pedido tem que ser o condomínio autorizado.
// fecharmes aceita lote de condomínios e grupos: um campo errado fecharia outro condomínio.
function conferirCampos(idCond, campos) {
  const id = String(idCond);
  for (const [k, v] of Object.entries(campos || {})) {
    if (/ID_CONDOMINIO|idCondominio|ID_RESPONSAVEL_ARQ|ID_EMPRESA|ID_GRUPO/i.test(k) && String(v) !== id) throw Object.assign(new Error('campo_de_outro_condominio'), { codigo: 'trava_condominio', campo: k });
  }
  return true;
}

// ── leituras ────────────────────────────────────────────────────────────
const lista = (j) => (Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []));
async function etiquetasDoSuperlogica(cliente) {
  const j = await cliente.get('arquivos/etiquetas', {});
  // Campo do nome conferido no 167 em 23/10/2026: st_nomeetiqueta_eti (8 = Extrato).
  return lista(j).map((e) => ({ id: Number(e.id_etiqueta_eti || e.id), nome: limpar(e.st_nomeetiqueta_eti || e.st_nome_eti || e.st_etiqueta_eti || e.nome) })).filter((e) => Number.isInteger(e.id) && e.id > 0 && e.nome);
}
// Comentários de uma conta do R&D num mês. Conferido no 167 (23/10/2026): a conta (ID_OBJETO) é
// obrigatória ("Identificador de objeto não informado.") e a resposta vem embrulhada em
// [{ status:'200', data:[...] }]. Erro de regra vem com status diferente de 200: lança.
async function comentariosDoMes(cliente, idCond, comp, conta) {
  const c = competencia(comp);
  if (!conta) throw Object.assign(new Error('conta_obrigatoria'), { codigo: 'leitura' });
  const j = await cliente.get('comentarios/index', { ID_CONDOMINIO: idCond, TIPO_OBJETO: 'CONTACATEGORIA', ID_OBJETO: conta, DT_REFERENCIA: dois(c.mes) + '/01/' + c.ano });
  const arr = Array.isArray(j) ? j : (j ? [j] : []);
  const emb = arr.length === 1 && arr[0] && typeof arr[0] === 'object' && 'status' in arr[0] && !Object.keys(arr[0]).some((k) => /_comc$/i.test(k)) ? arr[0] : null;
  if (emb && String(emb.status) !== '200') throw Object.assign(new Error('comentarios_' + emb.status + ': ' + limpar(emb.msg).slice(0, 80)), { codigo: 'leitura' });
  const itens = emb ? (Array.isArray(emb.data) ? emb.data : (emb.data && typeof emb.data === 'object' ? Object.values(emb.data) : [])) : arr;
  return itens.filter((x) => x && typeof x === 'object');
}
// Data de fechamento do condomínio (ISO; '' = nunca fechado).
async function dataFechamento(cliente, idCond) {
  const j = await cliente.get('condominios/get', { id: idCond, comDataFechamento: 1 });
  const c = lista(j).find((x) => x && String(x.id_condominio_cond) === String(idCond)) || (j && !Array.isArray(j) && String(j.id_condominio_cond) === String(idCond) ? j : null);
  if (!c) throw Object.assign(new Error('condominio_nao_lido'), { codigo: 'leitura' });
  const iso = slParaIso(c.dt_fechamento_cond);
  return { iso: iso && iso > '1900-01-01' ? iso : '', bruto: limpar(c.dt_fechamento_cond), nome: limpar(c.st_fantasia_cond || c.st_nome_cond) };
}
// Data de fechamento de todos os condomínios numa leitura só (painel).
async function datasFechamento(cliente) {
  const j = await cliente.get('condominios/get', { id: -1, comDataFechamento: 1 });
  const out = new Map();
  lista(j).forEach((c) => { if (c && c.id_condominio_cond) { const iso = slParaIso(c.dt_fechamento_cond); out.set(String(c.id_condominio_cond), iso && iso > '1900-01-01' ? iso : ''); } });
  return out;
}
// Soma do demonstrativo (o mesmo do 015E do 900A) contra o caixa: saldo do dia 1 + receitas
// menos despesas tem que dar o saldo do dia 1 do mês seguinte (caixa/index, todas as contas).
async function conferirSoma(cliente, idCond, comp) {
  const c = competencia(comp);
  const prox = somarMeses(c, 1);
  const saldo = async (cc) => {
    const j = await cliente.get('caixa/index', { idCondominio: idCond, dtInicio: dois(cc.mes) + '/01/' + cc.ano, dtFim: dois(cc.mes) + '/01/' + cc.ano });
    const l = lista(j).find((x) => x && x.saldoinicialconta !== undefined);
    return l ? cent(Number(l.saldoinicialconta)) : null;
  };
  const j = await cliente.get('balancetes/index', { idCondominio: idCond, dtInicio: dois(c.mes) + '/01/' + c.ano, dtFim: dois(c.mes) + '/' + dois(c.ultimoDia) + '/' + c.ano });
  const linhas = [];
  lista(j).forEach((b) => ((b && b.itens) || []).forEach((g) => (g || []).forEach((l) => linhas.push(l))));
  const total = (cod) => { const l = linhas.find((x) => limpar(x.conta) === cod); return l ? cent(Number(String(l.valor).replace(',', '.'))) : null; };
  const [ini, fim] = [await saldo(c), await saldo(prox)];
  return montarSoma({ saldo_inicial: ini, receitas: total('1'), despesas: total('2'), saldo_final_caixa: fim });
}
function montarSoma(s) {
  if ([s.saldo_inicial, s.saldo_final_caixa].some((v) => v == null)) return Object.assign({ ok: null, motivo: 'Saldo do caixa não lido.' }, s);
  const rec = s.receitas || 0, desp = Math.abs(s.despesas || 0);
  const calculado = cent(s.saldo_inicial + rec - desp);
  const diferenca = cent(s.saldo_final_caixa - calculado);
  return Object.assign({}, s, { calculado, diferenca, ok: Math.abs(diferenca) < 0.05 });
}

// ── geração de relatório e capa ────────────────────────────────────────
// Pede um relatório ao Superlógica (cria a impressão só para a administração, sem publicar,
// como o 900A da T41) e baixa o PDF. Sem id da impressão (gateway cortou): volta 'aguardar' e o
// agendamento tenta de novo mais tarde, sem repetir o pedido em menos de 15 minutos.
async function gerarRelatorio(cred, idCond, codigo, comp, { baixar }) {
  const c = competencia(comp);
  if (!/^\d{3}[A-Z]$/.test(String(codigo))) throw Object.assign(new Error('relatorio_invalido'), { codigo: 'relatorio' });
  const q = { ID_CONDOMINIO_COND: idCond, DT_PADRAO_REL: dois(c.mes) + '/01/' + c.ano, render: 'pdf', getId: '1' };
  conferirCampos(idCond, q);
  const r = await pedir(cred, 'GET', 'relatorios/id/' + codigo, q, null);
  const it = Array.isArray(r.json) ? r.json[0] : r.json;
  const idImp = String((it && (it.id_impressao || (it.data && it.data.id_impressao))) || '');
  if (!/^\d+$/.test(idImp)) return { aguardar: true, http: r.status };
  let buf;
  try { buf = await baixar(idImp); } finally {
    // A impressão criada pelo Hub só serve para virar anexo: apaga (só a que ele mesmo criou, pelo id;
    // impressoes/delete testado no 167). Falha ao apagar não impede o anexo.
    await pedir(cred, 'POST', 'impressoes/delete', { ID_IMPRESSAO_FIMP: idImp }, null).catch(() => null);
  }
  if (!ehPdf(buf) || buf.length > MAX_ARQUIVO) throw Object.assign(new Error('relatorio_nao_e_pdf'), { codigo: 'relatorio' });
  return { buffer: buf, id_impressao: idImp };
}
function ehPdf(buf) { return Buffer.isBuffer(buf) && buf.length > 8 && buf.slice(0, 5).toString('latin1') === '%PDF-'; }

// Capa simples em PDF (uma página A4, Helvetica). Montada à mão: o Hub não tem biblioteca de PDF.
function montarCapa(nomeCondominio, comp) {
  const c = competencia(comp);
  const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const txt = (s) => Buffer.from(String(s).replace(/[\\()]/g, (x) => '\\' + x), 'latin1').toString('latin1');
  const linhas = [
    ['/F2 26', 297, 520, String(nomeCondominio || '').toUpperCase().slice(0, 45)],
    ['/F1 18', 297, 470, 'Prestação de contas'],
    ['/F1 16', 297, 440, MESES[c.mes - 1] + ' de ' + c.ano],
    ['/F1 11', 297, 410, 'Período de 01/' + dois(c.mes) + '/' + c.ano + ' a ' + dois(c.ultimoDia) + '/' + dois(c.mes) + '/' + c.ano],
  ];
  // Centraliza pela largura aproximada (Helvetica: 0,5 do tamanho por letra).
  const conteudo = linhas.map(([f, cx, y, s]) => { const tam = Number(f.split(' ')[1]); const x = Math.max(40, cx - (s.length * tam * 0.5) / 2); return 'BT ' + f + ' Tf ' + x.toFixed(1) + ' ' + y + ' Td (' + txt(s) + ') Tj ET'; }).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Length ' + Buffer.byteLength(conteudo, 'latin1') + ' >>\nstream\n' + conteudo + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const pos = [];
  objs.forEach((o, i) => { pos.push(Buffer.byteLength(pdf, 'latin1')); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + pos.map((p) => String(p).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}

// ── gravação de um comentário com anexo ───────────────────────────────
// Sequência testada com a chave no 167: arquivos/put -> adicionaretiqueta -> comentarios/putarquivos
// -> comentarios/put (VISIBILIDADE=0) -> releitura. Antes de gravar, relê: se o comentário já
// existe no mês e na conta (mesmo título, com anexo), não grava de novo. Se uma etapa falha depois
// do arquivo subir, apaga o arquivo (não deixa sobra). Sem resposta: 'incerto', e a próxima rodada
// relê antes de qualquer tentativa.
// item: { chave, titulo, conta, etiqueta_id }; doc: { buffer, nome }; ctx: { cred, cliente, idCond, plano, comp }
async function gravarComentario(ctx, item, doc, opcoes) {
  const { cred, cliente, idCond, plano, comp } = ctx;
  const id = String(idCond);
  if (!ID.test(id) || NAO_CONDOMINIOS.has(id)) throw Object.assign(new Error('nao_condominio'), { codigo: 'trava_condominio' });
  if (!/^\d+$/.test(String(plano || ''))) return { estado: 'falhou', msg: 'Plano de contas do condomínio não encontrado.' };
  const c = competencia(comp);
  const alvoChave = chaveTitulo(item.titulo);
  const procurar = async () => (await comentariosDoMes(cliente, id, comp, item.conta)).map(lerComentario).find((x) => x && chaveTitulo(x.titulo) === alvoChave && (!x.referencia || x.referencia === c.chave));
  let existente;
  try { existente = await procurar(); } catch (e) { return { estado: 'incerto', msg: 'Não foi possível reler os comentários antes de gravar. Nada foi gravado.' }; }
  if (existente && existente.arquivos.length) return { estado: 'ja_existia', id_comentario: existente.id, id_arquivo: existente.arquivos[0].id, visibilidade: existente.visibilidade, msg: 'O comentário já estava no Demonstrativo R&D.' };
  // Resultado incerto de antes: o agendamento só relê. Gravar de novo sem prova pode duplicar o comentário.
  if (opcoes && opcoes.soReler) return { estado: 'incerto', msg: 'Gravação anterior sem confirmação e a releitura não achou o comentário. Confira no Demonstrativo R&D; o sistema não grava de novo sozinho.' };
  if (!ehPdf(doc.buffer) || doc.buffer.length > MAX_ARQUIVO) return { estado: 'falhou', msg: 'O documento não é um PDF de até 15 MB.' };

  // 1. arquivo
  const fronteira = '----hub' + crypto.randomBytes(12).toString('hex');
  const campos = { MAX_FILE_SIZE: String(MAX_ARQUIVO), FL_TIPO_ARQ: '15', ID_FERRAMENTA_ARF: '7', ID_RESPONSAVEL_ARQ: id, ID_CONDOMINIO_COND: id };
  if (item.etiqueta_id) campos.ID_ETIQUETA_ETI = String(item.etiqueta_id);
  conferirCampos(id, campos);
  const nome = (semAcento(doc.nome || item.titulo).replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, '_').slice(0, 80) || 'documento') + (/\.pdf$/i.test(doc.nome || '') ? '' : '.pdf');
  const corpo = Buffer.concat(Object.entries(campos).map(([k, v]) => Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n', 'utf8'))
    .concat([Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="ARQUIVO[]"; filename="' + nome + '"\r\nContent-Type: application/pdf\r\n\r\n', 'utf8'), doc.buffer, Buffer.from('\r\n--' + fronteira + '--\r\n', 'utf8')]));
  const ra = corpoOk(await pedir(cred, 'POST', 'arquivos/put', null, corpo, 'multipart/form-data; boundary=' + fronteira));
  const da = ra.item && ra.item.data && typeof ra.item.data === 'object' ? (Array.isArray(ra.item.data) ? ra.item.data[0] : ra.item.data) : null;
  const idArq = da && /^\d+$/.test(String(da.id_arquivo_arq || da.id || '')) ? String(da.id_arquivo_arq || da.id) : '';
  if (!ra.ok || !idArq) return { estado: ra.semResposta ? 'incerto' : 'falhou', msg: 'Anexo não subiu: ' + ra.msg };
  const hashArq = limpar(da.st_hash_arq || da.hash || '');
  const desfazerArquivo = async () => { const r = corpoOk(await pedir(cred, 'POST', 'arquivos/delete', { ID_ARQUIVO_ARQ: idArq }, null)); return r.ok; };

  // 2. etiqueta (o anexo cai na posição certa do livro pela etiqueta)
  if (item.etiqueta_id) {
    const re = corpoOk(await pedir(cred, 'PUT', 'arquivos/adicionaretiqueta', { idEtiqueta: item.etiqueta_id, idDocumento: idArq }, formulario({ idDocumento: idArq, idEtiqueta: item.etiqueta_id })));
    // Mandar ID_ETIQUETA_ETI no upload já aplica a etiqueta: a resposta "já está adicionada" é sucesso (167, 23/10/2026).
    if (!re.ok && !/sucesso|j[aá] est[aá] adicionada/i.test(re.msg)) { const apagou = await desfazerArquivo(); return { estado: 'falhou', msg: 'Etiqueta não gravou: ' + re.msg + (apagou ? ' (anexo apagado)' : ' (anexo ' + idArq + ' ficou sem uso)'), id_arquivo: apagou ? null : idArq }; }
  }
  // 3. vincular o arquivo ao comentário que ainda não existe (-1)
  const ext = 'pdf';
  const rv = corpoOk(await pedir(cred, 'POST', 'comentarios/putarquivos', null, formulario({
    ID_COMENTARIOCONTEUDO_COMC: '-1', 'ARQUIVOS[0][ID_ARQUIVO_ARQ]': idArq, 'ARQUIVOS[0][ST_NOME_ARQ]': nome.replace(/\.pdf$/i, ''),
    'ARQUIVOS[0][ST_EXTENSAO_ARQ]': ext, 'ARQUIVOS[0][ST_HASH_ARQ]': hashArq, 'ARQUIVOS[0][ID_FERRAMENTA_ARF]': '7',
  })));
  if (!rv.ok) { const apagou = await desfazerArquivo(); return { estado: rv.semResposta ? 'incerto' : 'falhou', msg: 'Vínculo do anexo não gravou: ' + rv.msg + (apagou ? ' (anexo apagado)' : ''), id_arquivo: apagou ? null : idArq }; }

  // 4. comentário, sempre invisível para o condômino (a tela do Superlógica vem marcada por padrão)
  const camposC = {
    COMENTARIOS: '[]', ID_CONDOMINIO: id, ID_PLANOCONTA: String(plano), DT_REFERENCIA: dois(c.mes) + '/01/' + c.ano, TIPO_OBJETO: 'CONTACATEGORIA',
    ID_OBJETO: item.conta, TEXTO: item.titulo + ' ' + c.rotulo, VISIBILIDADE: '0', TITULO: item.titulo, CONTINUAR_CADASTRANDO_APOS_SALVAR: '0', 'ARQUIVOS[0][ID_ARQUIVO_ARQ]': idArq,
  };
  conferirCampos(id, camposC);
  const rc = corpoOk(await pedir(cred, 'POST', 'comentarios/put', null, formulario(camposC)));
  if (!rc.ok && !rc.semResposta) { const apagou = await desfazerArquivo(); return { estado: 'falhou', msg: 'Comentário não gravou: ' + rc.msg + (apagou ? ' (anexo apagado)' : ''), id_arquivo: apagou ? null : idArq }; }

  // 5. prova: relê e confere título, anexo e visibilidade
  let lido = null;
  try { lido = await procurar(); } catch (e) { lido = null; }
  if (lido && lido.arquivos.some((a) => a.id === idArq)) {
    if (lido.visibilidade === 1) return { estado: 'gravado', alerta: 'visivel', id_comentario: lido.id, id_arquivo: idArq, visibilidade: 1, msg: 'Gravado, mas o Superlógica deixou visível para o condômino. Confira.' };
    return { estado: 'gravado', id_comentario: lido.id, id_arquivo: idArq, visibilidade: lido.visibilidade, msg: 'Gravado e conferido.' };
  }
  return { estado: 'incerto', id_arquivo: idArq, msg: rc.ok ? 'O Superlógica disse que gravou, mas a releitura não achou o comentário.' : 'Sem resposta do Superlógica ao gravar o comentário.' };
}

// ── fechamento do mês ─────────────────────────────────────────────────
// Fecha (data = último dia do mês) ou reabre (data = a de antes). Um condomínio só, sempre:
// CONDOMINIOS_E_GRUPOS leva só o próprio condomínio e a trava confere todos os campos.
async function gravarFechamento(ctx, novaIso) {
  const { cred, cliente, idCond, nome } = ctx;
  const id = String(idCond);
  if (!ID.test(id) || NAO_CONDOMINIOS.has(id)) throw Object.assign(new Error('nao_condominio'), { codigo: 'trava_condominio' });
  const nova = novaIso === '' ? NUNCA_FECHADO : isoParaSL(novaIso);
  if (!nova) throw Object.assign(new Error('data_invalida'), { codigo: 'data' });
  const campos = { ID_CONDOMINIO_COND: id, DT_FECHAMENTO: nova, 'CONDOMINIOS_E_GRUPOS[0][ID_CONDOMINIO_COND]': id, 'CONDOMINIOS_E_GRUPOS[0][ST_FANTASIA_COND]': limpar(nome).slice(0, 120) };
  conferirCampos(id, campos);
  const r = corpoOk(await pedir(cred, 'POST', 'condominios/fecharmes', null, formulario(campos)));
  let depois = null;
  try { depois = await dataFechamento(cliente, id); } catch (e) { depois = null; }
  const confere = depois && depois.iso === novaIso;
  if (confere) return { ok: true, data: novaIso, msg: r.msg };
  return { ok: false, incerto: !depois || r.semResposta || r.ok, data_lida: depois ? depois.iso : null, msg: depois ? 'A releitura mostra fechamento em ' + (isoBR(depois.iso) || 'nunca fechado') + '. ' + r.msg : 'Não foi possível reler a data de fechamento. ' + r.msg };
}
// Data para reabrir o mês: a data que o condomínio tinha antes do Hub fechar (se for anterior ao
// mês) ou o último dia do mês anterior. Nunca vazia. '' quer dizer "nunca fechado" (01/01/1899).
function dataReabertura(comp, anteriorAoFechar) {
  const c = competencia(comp);
  const fimAnterior = somarMeses(c, -1).fim;
  if (anteriorAoFechar !== undefined && anteriorAoFechar !== null && (anteriorAoFechar === '' || anteriorAoFechar < c.inicio)) return anteriorAoFechar;
  return fimAnterior;
}

// ── travas, causas e etapa ────────────────────────────────────────────
// Cada trava diz a causa (o que está travando), quem precisa agir e em que etapa ela segura.
const ETAPAS = ['extrato', 'conciliacao', 'comprovantes', 'montagem', 'conferencia', 'pronto_publicar', 'publicado'];
const NOME_ETAPA = { extrato: 'Extrato', conciliacao: 'Conciliação', comprovantes: 'Comprovantes', montagem: 'Montagem', conferencia: 'Conferência', pronto_publicar: 'Pronto para publicar', publicado: 'Publicado' };
const NOME_GRUPO_PRE = {
  sem_comprovante: (a) => ({ causa: 'Pagamento sem comprovante: ' + desc(a), quem: 'Quem lançou a despesa: anexar o comprovante no Superlógica' }),
  sem_nota: (a) => ({ causa: 'Pagamento sem nota fiscal: ' + desc(a), quem: 'Quem lançou a despesa: pedir a nota ao fornecedor e anexar' }),
  vencida: (a) => ({ causa: 'Conta vencida sem baixa: ' + desc(a), quem: 'Síndico: autorizar o pagamento; financeiro: dar a baixa' }),
  lancamento_tardio: (a) => ({ causa: 'Despesa lançada depois do vencimento: ' + desc(a), quem: 'Financeiro: conferir o lançamento' }),
  mexida: (a) => ({ causa: 'Alteração suspeita na despesa: ' + desc(a), quem: 'Gerente: conferir quem mexeu e por quê' }),
};
function desc(a) {
  const forn = limpar(a.fornecedor || a.st_nome_con || a.favorecido || a.descricao || '');
  const v = Number(a.valor);
  return (forn || 'despesa') + (Number.isFinite(v) && v ? ' ' + brl(v) : '') + (a.vencimento || a.dt_vencimento ? ' (venc. ' + (a.vencimento || isoBR(a.dt_vencimento) || a.dt_vencimento) + ')' : '');
}

// e: { comp, hoje, fechamento (T38 ou null), pre (painel T31, opcional; se faltar usa o T38),
//      soma, modelo, documentos: Set(chave), montagem: { chave: linha }, gravacao: estado da
//      política, fechadoAte (ISO ou ''), impressoes (900A do mês), conferencia (resultado ou null),
//      erroLeitura: [] }
function montarSituacao(e) {
  const travas = [];
  const add = (etapa, causa, quem, extra) => travas.push(Object.assign({ etapa, causa, quem }, extra || {}));
  const c = competencia(e.comp);
  const f = e.fechamento;
  const itemF = (k) => f && Array.isArray(f.itens) ? f.itens.find((i) => i.chave === k) : null;
  const pendenteF = (i) => i && i.situacao !== 'ok' && i.situacao !== 'conferido';
  (e.erroLeitura || []).forEach((x) => add(x.etapa || 'extrato', x.causa, 'Sistema: tenta de novo sozinho na próxima rodada'));

  if (!f) add('extrato', 'Conferência do mês ainda não calculada (extratos, conciliação e comprovantes).', 'Sistema: calcula na próxima rodada');
  else {
    const ex = itemF('extrato');
    if (pendenteF(ex)) splitTrava(ex.trava).forEach((t) => add('extrato', 'Extrato não chegou: ' + t, 'Financeiro: baixar no banco e importar no Superlógica'));
    const co = itemF('conciliacao');
    if (pendenteF(co)) splitTrava(co.trava).forEach((t) => add('conciliacao', 'Conciliação: ' + t, 'Financeiro: conciliar no Superlógica'));
    // Comprovantes: cada pendência do pré balancete vira uma linha com quem age.
    const pre = e.pre;
    const ip = itemF('pre_balancete');
    if (pre && Array.isArray(pre.grupos) && pendenteF(ip)) {
      let n = 0;
      pre.grupos.forEach((g) => (g.itens || []).forEach((a) => {
        if (a.gravidade === 'baixa' || n >= 30) return;
        const fn = NOME_GRUPO_PRE[g.chave];
        if (!fn) return;
        const t = fn(a); n++;
        add('comprovantes', t.causa, t.quem, { grupo: g.chave });
      }));
      const resto = (pre.pendencias || 0) - n;
      if (resto > 0) add('comprovantes', 'Mais ' + resto + ' pendência(s) de despesas no pré balancete.', 'Financeiro: abrir o pré balancete');
    } else if (pendenteF(ip)) add('comprovantes', 'Pré balancete: ' + (ip.trava || 'pendências'), 'Financeiro: abrir o pré balancete');
    const an = itemF('anexos');
    if (pendenteF(an)) add('comprovantes', an.situacao === 'calculando' ? 'Conferência dos anexos ainda rodando.' : 'Anexos das despesas: ' + (an.trava || 'pendências'), an.situacao === 'calculando' ? 'Sistema: termina sozinho' : 'Pessoa: conferir o que o sistema marcou nos anexos');
    const bo = itemF('boletos');
    if (pendenteF(bo)) add('comprovantes', 'Boletos do mês: ' + (bo.trava || 'pendências'), 'Cobrança: conferir os boletos marcados');
  }
  if (e.soma && e.soma.ok === false) add('conciliacao', 'O demonstrativo não bate com o caixa: saldo inicial ' + brl(e.soma.saldo_inicial) + ' + receitas ' + brl(e.soma.receitas) + ' menos despesas ' + brl(Math.abs(e.soma.despesas || 0)) + ' dá ' + brl(e.soma.calculado) + ', e o caixa do dia 1 seguinte tem ' + brl(e.soma.saldo_final_caixa) + ' (diferença de ' + brl(e.soma.diferenca) + ').', 'Financeiro: falta lançamento ou conciliação no mês');
  else if (e.soma && e.soma.ok === null) add('conciliacao', 'Soma do demonstrativo contra o caixa não conferida: ' + (e.soma.motivo || ''), 'Sistema: tenta de novo sozinho');

  // Montagem: modelo, documentos e comentários.
  const m = e.modelo;
  if (!m || !Array.isArray(m.itens) || !m.itens.length) add('montagem', 'Modelo do balancete não encontrado: nenhum comentário com anexo no Demonstrativo R&D dos últimos meses.', 'Gerente: cadastrar o modelo do condomínio no Hub');
  else {
    if (!m.plano) add('montagem', 'Plano de contas do condomínio não encontrado no Superlógica.', 'Gerente: conferir o cadastro do condomínio');
    m.itens.forEach((i) => {
      const linha = (e.montagem || {})[i.chave];
      const est = linha ? linha.estado : 'pendente';
      if (est === 'gravado' || est === 'ja_existia') { if (linha.alerta === 'visivel') add('conferencia', '"' + i.titulo + '" ficou visível para o condômino no Superlógica.', 'Pessoa: desmarcar "visível" no comentário'); return; }
      if (i.fonte.tipo === 'recebido' && !(e.documentos && e.documentos.has(i.chave))) { add('montagem', i.fonte.descricao + ' não chegou ("' + i.titulo + '").', i.fonte.quem || 'Financeiro: enviar o documento no Hub', { item: i.chave }); return; }
      if (est === 'falhou') add('montagem', '"' + i.titulo + '" não gravou: ' + (linha.msg || ''), 'Sistema: tenta de novo; se repetir, avisar o suporte do Hub', { item: i.chave });
      else if (est === 'incerto') add('montagem', '"' + i.titulo + '" ficou sem confirmação do Superlógica: ' + (linha.msg || ''), 'Sistema: relê antes de tentar de novo', { item: i.chave });
      else if (est === 'aguardar') add('montagem', '"' + i.titulo + '": o Superlógica ainda está gerando o relatório.', 'Sistema: busca de novo na próxima rodada', { item: i.chave });
      else add('montagem', '"' + i.titulo + '" ainda não gravado.', e.gravacao && e.gravacao !== 'livre' ? 'Pessoa com permissão: confirmar a gravação no Superlógica (fora do condomínio de teste)' : 'Sistema: grava na próxima rodada', { item: i.chave });
    });
  }
  // Fechamento: o sistema deixa pronto; a pessoa confirma.
  const fechado = !!(e.fechadoAte && e.fechadoAte >= c.fim);
  if (!fechado && e.fechadoAte !== null) add('conferencia', 'Fechamento do mês não confirmado' + (e.fechadoAte ? ' (fechado até ' + isoBR(e.fechadoAte) + ')' : ' (nunca fechado)') + '.', 'Pessoa: confirmar o fechamento no Hub');
  // 900A e conferência final.
  const imps = (e.impressoes || []).filter((x) => x.da_competencia);
  const publicado = imps.some((x) => x.publicado);
  if (!publicado) {
    if (!imps.length) add('conferencia', '900A do mês ainda não gerado.', fechado ? 'Sistema: gera depois da montagem' : 'Sistema: gera depois do fechamento');
    else if (!e.conferencia) add('conferencia', 'Conferência final do 900A pendente.', 'Sistema: confere o PDF sozinho');
    else if (!e.conferencia.ok) add('conferencia', 'Conferência final: ' + (e.conferencia.problemas || 0) + ' ponto(s) marcados no 900A.', 'Pessoa: conferir o que o sistema marcou');
  }
  let etapa;
  if (publicado) etapa = 'publicado';
  else {
    const idx = travas.reduce((mn, t) => Math.min(mn, ETAPAS.indexOf(t.etapa)), ETAPAS.indexOf('pronto_publicar'));
    etapa = ETAPAS[idx];
  }
  return { competencia: c.chave, etapa, etapa_nome: NOME_ETAPA[etapa], travas, publicado, fechado, prazo: prazo(c, e.hoje, etapa) };
}
function splitTrava(t) { return String(t || '').replace(/\.$/, '').split(/;\s*/).map((x) => x.trim()).filter(Boolean).slice(0, 10); }

// Meta: tudo pronto (publicado) no dia 1 do mês seguinte; prazo máximo dia 5.
function prazo(c, hoje, etapa) {
  const prox = somarMeses(c, 1);
  const ideal = prox.inicio, maximo = prox.chave + '-05';
  const dia = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
  if (etapa === 'publicado') return { situacao: 'publicado', ideal, maximo, texto: 'Publicado' };
  if (!hoje || hoje < ideal) return { situacao: 'em_dia', ideal, maximo, dias: dia(hoje || ideal, ideal), texto: 'Meta: pronto em ' + isoBR(ideal) };
  if (hoje <= maximo) return { situacao: 'passou_ideal', ideal, maximo, dias: dia(hoje, maximo), texto: 'Passou do dia 1; prazo máximo ' + isoBR(maximo) };
  return { situacao: 'atrasado', ideal, maximo, dias: -dia(maximo, hoje), texto: 'Atrasado ' + dia(maximo, hoje) + ' dia(s) (prazo era ' + isoBR(maximo) + ')' };
}

// Plano da montagem: itens do modelo que ainda precisam gravar e o documento de cada um.
function planoMontagem(modelo, montagem, documentos) {
  return (modelo && modelo.itens ? modelo.itens : []).filter((i) => {
    const l = (montagem || {})[i.chave];
    return !l || !['gravado', 'ja_existia'].includes(l.estado);
  }).map((i) => ({ chave: i.chave, titulo: i.titulo, conta: i.conta, etiqueta_id: i.etiqueta_id || null, fonte: i.fonte.tipo === 'relatorio' ? 'relatorio:' + i.fonte.codigo : i.fonte.tipo,
    sha256: i.fonte.tipo === 'recebido' ? ((documentos && documentos.get && documentos.get(i.chave)) || null) : undefined }))
    .filter((p) => p.fonte !== 'recebido' || p.sha256);
}

// Qual competência o agendamento trabalha hoje: no último dia do mês, o próprio mês (aprende o
// modelo e acompanha); do dia 1 ao 15, o mês anterior (monta tudo e repete o que faltou).
function competenciasDoDia(hojeIso) {
  const [a, m, d] = hojeIso.split('-').map(Number);
  const atual = competencia(a + '-' + dois(m));
  const out = [];
  if (d <= 15) out.push({ comp: somarMeses(atual, -1).chave, montar: true });
  if (d === atual.ultimoDia) out.push({ comp: atual.chave, montar: false });
  return out;
}

module.exports = {
  NAO_CONDOMINIOS, NUNCA_FECHADO, ETAPAS, NOME_ETAPA, ETIQUETAS_RESERVA, MAX_ARQUIVO,
  competencia, somarMeses, isoParaSL, slParaIso, isoBR, hojeSP, chaveTitulo, classificarDocumento, lerComentario, aprenderModelo, validarModelo,
  pedir, corpoOk, conferirCampos, etiquetasDoSuperlogica, comentariosDoMes, dataFechamento, datasFechamento, conferirSoma, montarSoma,
  gerarRelatorio, ehPdf, montarCapa, gravarComentario, gravarFechamento, dataReabertura, montarSituacao, prazo, planoMontagem, competenciasDoDia,
};
