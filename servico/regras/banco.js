// Regras do condomínio: acesso ao banco (tabelas da migration 020). Só o servidor usa,
// pelo supabaseAdminRequest (service role). Todas as funções recebem `banco` (a função
// supabaseAdminRequest) como primeiro argumento para poderem ser testadas sem rede.

const crypto = require('crypto');
const { dividirEmTrechos } = require('./trechos');

const TIPOS = ['convencao', 'regimento', 'ata', 'regulamento', 'outro'];
const LOTE_TRECHOS = 200;
const enc = encodeURIComponent;

const hashTexto = (t) => crypto.createHash('sha256').update(String(t || '').replace(/\s+/g, ' ').trim()).digest('hex');

// Busca trechos no acervo (função regras_buscar). idSL null = todos os condomínios.
// opts: { tipos: ['regimento', ...], limite: 12, soVigentes: true }
async function buscarTrechos(banco, idSL, consulta, opts) {
  const o = opts || {};
  const r = await banco('POST', '/rest/v1/rpc/regras_buscar', {
    p_id: idSL == null ? null : Number(idSL),
    p_consulta: String(consulta || '').slice(0, 500),
    p_tipos: Array.isArray(o.tipos) && o.tipos.length ? o.tipos.filter((t) => TIPOS.includes(t)) : null,
    p_limite: Math.min(Math.max(Number(o.limite) || 12, 1), 60),
    p_so_vigentes: o.soVigentes !== false,
  });
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('busca_regras_falhou_' + r.status);
  return r.body;
}

// Várias buscas (uma por consulta) num conjunto só, sem trecho repetido, na ordem de relevância.
async function juntarTrechos(banco, idSL, consultas, opts) {
  const vistos = new Map();
  for (const c of consultas.filter(Boolean)) {
    const lista = await buscarTrechos(banco, idSL, c, opts);
    lista.forEach((t) => { if (!vistos.has(t.trecho_id)) vistos.set(t.trecho_id, t); });
  }
  const max = (opts && opts.maxTotal) || 25;
  return [...vistos.values()].sort((a, b) => (b.rank || 0) - (a.rank || 0)).slice(0, max);
}

// Documentos de um condomínio (sem o texto inteiro, que é grande).
async function listarDocumentos(banco, idSL) {
  const sel = 'id,id_superlogica,condgpt_slug,tipo,titulo,data_documento,vigente,origem,arquivo_path,arquivo_bytes,resumo,observacao,criado_em';
  const r = await banco('GET', '/rest/v1/regras_documentos?id_superlogica=eq.' + enc(idSL) + '&select=' + sel + '&order=tipo.asc,data_documento.desc.nullslast,id.desc');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('listar_documentos_falhou_' + r.status);
  return r.body;
}

// Grava um documento e os trechos dele. doc: { id_superlogica, tipo, titulo, data_documento,
// vigente, origem, arquivo_path, arquivo_bytes, texto, resumo, observacao, criado_por,
// condgpt_slug, cnpj }. Mesmo texto no mesmo condomínio e tipo não entra duas vezes
// (devolve { duplicado: true, id }). Se a gravação dos trechos falhar, apaga o documento
// para não ficar documento sem trecho.
async function inserirDocumento(banco, doc) {
  if (!TIPOS.includes(doc.tipo)) throw new Error('tipo_invalido');
  const texto = String(doc.texto || '');
  const hash = texto.trim() ? hashTexto(texto) : null;
  if (hash && doc.id_superlogica != null) {
    const ja = await banco('GET', '/rest/v1/regras_documentos?id_superlogica=eq.' + enc(doc.id_superlogica) + '&tipo=eq.' + enc(doc.tipo) + '&hash_texto=eq.' + hash + '&select=id&limit=1');
    if (ja.status === 200 && Array.isArray(ja.body) && ja.body[0]) return { duplicado: true, id: ja.body[0].id };
  }
  const linha = Object.assign({}, doc, { hash_texto: hash });
  const ins = await banco('POST', '/rest/v1/regras_documentos', linha);
  const criado = ins.status === 201 && Array.isArray(ins.body) ? ins.body[0] : null;
  if (!criado) throw new Error('inserir_documento_falhou_' + ins.status);
  const trechos = texto.trim() ? dividirEmTrechos(texto, doc.tipo) : [];
  for (let i = 0; i < trechos.length; i += LOTE_TRECHOS) {
    const lote = trechos.slice(i, i + LOTE_TRECHOS).map((t) => ({
      documento_id: criado.id, id_superlogica: doc.id_superlogica == null ? null : Number(doc.id_superlogica),
      ordem: t.ordem, rotulo: t.rotulo, titulo: t.titulo, texto: t.texto, pagina: t.pagina || null,
    }));
    const r = await banco('POST', '/rest/v1/regras_trechos', lote);
    if (r.status !== 201) {
      await banco('DELETE', '/rest/v1/regras_documentos?id=eq.' + criado.id);
      throw new Error('inserir_trechos_falhou_' + r.status);
    }
  }
  return { duplicado: false, id: criado.id, trechos: trechos.length };
}

// Marca um documento como a versão que vale e tira a marca dos outros do mesmo tipo
// (só para convenção e regimento; atas e regulamentos podem valer vários ao mesmo tempo).
async function marcarVigente(banco, idSL, documentoId) {
  const r = await banco('GET', '/rest/v1/regras_documentos?id=eq.' + enc(documentoId) + '&id_superlogica=eq.' + enc(idSL) + '&select=id,tipo');
  const d = r.status === 200 && Array.isArray(r.body) ? r.body[0] : null;
  if (!d) return { ok: false, motivo: 'nao_encontrado' };
  if (d.tipo === 'convencao' || d.tipo === 'regimento') {
    await banco('PATCH', '/rest/v1/regras_documentos?id_superlogica=eq.' + enc(idSL) + '&tipo=eq.' + d.tipo + '&id=neq.' + d.id, { vigente: false, atualizado_em: new Date().toISOString() });
  }
  await banco('PATCH', '/rest/v1/regras_documentos?id=eq.' + d.id, { vigente: true, atualizado_em: new Date().toISOString() });
  return { ok: true };
}

// Histórico de notificações de uma unidade (id da unidade no Superlógica ou texto da unidade
// para o histórico importado do CondGPT, que só tem o texto).
async function historicoUnidade(banco, idSL, { idUnidade, unidade }) {
  const filtros = [];
  if (idUnidade) filtros.push('id_unidade.eq.' + Number(idUnidade));
  if (unidade) filtros.push('unidade.ilike.' + enc(String(unidade).replace(/[,()*]/g, ' ').trim()));
  if (!filtros.length) return [];
  const sel = 'id,id_unidade,unidade,bloco,tipo,data_fato,ocorrencia,valor,prazo_regularizacao,status,origem,criado_em';
  const r = await banco('GET', '/rest/v1/regras_notificacoes?id_superlogica=eq.' + enc(idSL) + '&or=(' + filtros.join(',') + ')&select=' + sel + '&order=criado_em.desc&limit=50');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('historico_falhou_' + r.status);
  return r.body;
}

module.exports = { TIPOS, hashTexto, buscarTrechos, juntarTrechos, listarDocumentos, inserirDocumento, marcarVigente, historicoUnidade };
