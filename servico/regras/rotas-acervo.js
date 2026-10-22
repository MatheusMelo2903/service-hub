// Regras do condomínio, frente D: rotas do acervo (convenção, regimento, atas, regulamentos).
// Módulo "regras": ação "ver" para ler, "gerenciar" para enviar, editar e apagar. Toda rota com
// condomínio confere a carteira (além da guarda geral do app.param) e todo documento é
// conferido como sendo do condomínio da URL. Nada aqui grava no Superlógica.
// Textos de tela sem citar leitura automática nem fornecedor; detalhe técnico só no log.

const crypto = require('crypto');
const A = require('./acervo');
const B = require('./banco');
const { dividirEmTrechos } = require('./trechos');

const ID_DOC = /^[1-9][0-9]{0,14}$/;
const CAMPOS_DOC = 'id,id_superlogica,tipo,titulo,data_documento,vigente,origem,arquivo_path,arquivo_bytes,resumo,observacao,criado_em,atualizado_em,hash_texto';
const ENVIOS_POR_HORA = 40;
const TAREFA_VALIDADE_MS = 2 * 3600 * 1000;

// Documento como vai para a tela: sem caminho do arquivo nem hash, com os sinais que a tela usa.
function docParaTela(d) {
  return {
    id: d.id, tipo: d.tipo, titulo: d.titulo, data_documento: d.data_documento, vigente: d.vigente, origem: d.origem,
    tem_arquivo: !!d.arquivo_path, tem_texto: d.hash_texto === undefined ? undefined : !!d.hash_texto, arquivo_bytes: d.arquivo_bytes || null,
    resumo: d.resumo || null, observacao: d.observacao || null, criado_em: d.criado_em, atualizado_em: d.atualizado_em || null,
  };
}

function criarRotasAcervo(app, deps) {
  const { requireAuth, express, banco, perfilDe, podeModulo, exigirCarteira, carteiraT18, auditoria, dentroDoLimite, storageSignedUrl, storageDelete } = deps;
  // Leitura de digitalizado demora minutos: a rota responde na hora e a tela pergunta aqui.
  const tarefas = new Map(); // id -> { dono, idSL, status, resultado, erro, criado }

  async function exigir(req, res, acao) {
    if (req.authMode === 'internal') return true;
    let p = null;
    try { p = await perfilDe(req); } catch (e) { p = null; }
    if (podeModulo(p, 'regras', acao)) return true;
    res.status(403).json({ erro: 'acesso_negado', detalhe: acao === 'gerenciar' ? 'Seu usuário não pode mudar os documentos do condomínio.' : 'Seu usuário não tem acesso a esta aba.' });
    return false;
  }
  // Permissão do módulo e carteira do condomínio da URL.
  async function exigirCond(req, res, acao) {
    if (!(await exigir(req, res, acao))) return false;
    return exigirCarteira(req, res, String(req.params.idSuperlogica));
  }
  function erroInterno(res, onde, e) {
    if (e instanceof A.ErroAcervo) {
      if (!res.headersSent) res.status(e.status).json({ erro: e.codigo, detalhe: e.detalhe });
      return;
    }
    console.warn('[regras acervo ' + onde + '] ' + (e && e.message));
    if (!res.headersSent) res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível concluir agora. Tente de novo em instantes.' });
  }
  // Documento do condomínio da URL (null quando não existe ou é de outro condomínio).
  async function docDoCond(idSL, docId, campos) {
    if (!ID_DOC.test(String(docId))) return null;
    const r = await banco('GET', '/rest/v1/regras_documentos?id=eq.' + docId + '&id_superlogica=eq.' + Number(idSL) + '&select=' + (campos || CAMPOS_DOC) + '&limit=1');
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('documento_' + r.status);
    return r.body[0] || null;
  }
  const naoAchou = (res) => res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Documento não encontrado neste condomínio.' });
  const quem = (req) => (req.user && req.user.sub) || null;
  function limparTarefas() {
    const limite = Date.now() - TAREFA_VALIDADE_MS;
    for (const [k, t] of tarefas) if (t.criado < limite) tarefas.delete(k);
  }

  // GET /api/regras/pendencias: pendências de todos os condomínios da carteira de quem vê.
  // Fica antes das rotas com :idSuperlogica para "pendencias" não ser lido como código.
  app.get('/api/regras/pendencias', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await exigir(req, res, 'ver'))) return;
    let esc;
    try { esc = await carteiraT18.escopo(req); } catch (e) {
      return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' });
    }
    try {
      // Nomes e lista da base do Hub; quem tem carteira só vê os condomínios dela.
      const rc = await banco('GET', '/rest/v1/condominios?id_superlogica=not.is.null&select=nome,id_superlogica&order=nome.asc&limit=2000');
      const nomes = new Map();
      if (rc.status === 200 && Array.isArray(rc.body)) rc.body.forEach((c) => nomes.set(Number(c.id_superlogica), c.nome));
      const ids = esc.todas ? [...nomes.keys()] : [...(esc.ids || [])].map(Number);
      const lista = await A.pendencias(deps, ids);
      const permitido = esc.todas ? null : new Set(ids);
      const itens = lista.filter((c) => !permitido || permitido.has(c.id_superlogica))
        .map((c) => Object.assign({ nome: nomes.get(c.id_superlogica) || null }, c))
        .sort((a, b) => b.pendencias.length - a.pendencias.length || String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
      res.json({ condominios: itens, com_pendencia: itens.filter((c) => c.pendencias.length).length, total: itens.length });
    } catch (e) { erroInterno(res, 'pendencias', e); }
  });

  // GET /api/regras/:idSuperlogica/documentos: lista, contagens e pendências do condomínio.
  app.get('/api/regras/:idSuperlogica/documentos', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await exigirCond(req, res, 'ver'))) return;
    const idSL = Number(req.params.idSuperlogica);
    try {
      const r = await banco('GET', '/rest/v1/regras_documentos?id_superlogica=eq.' + idSL + '&select=' + CAMPOS_DOC + '&order=tipo.asc,data_documento.desc.nullslast,id.desc&limit=5000');
      if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('listar_' + r.status);
      const p = A.pendenciasDoCondominio(r.body);
      res.json({ id_superlogica: idSL, documentos: r.body.map(docParaTela), contagens: p.contagens, pendencias: p.pendencias });
    } catch (e) { erroInterno(res, 'listar', e); }
  });

  // GET /api/regras/:idSuperlogica/envios/:tarefa: andamento do envio de PDF digitalizado.
  app.get('/api/regras/:idSuperlogica/envios/:tarefa', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await exigirCond(req, res, 'gerenciar'))) return;
    limparTarefas();
    const t = tarefas.get(String(req.params.tarefa));
    if (!t || t.idSL !== Number(req.params.idSuperlogica) || (req.authMode !== 'internal' && t.dono !== quem(req))) {
      return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Envio não encontrado. Confira a lista de documentos.' });
    }
    if (t.status === 'lendo') return res.json({ status: 'lendo', paginas: t.paginas });
    if (t.status === 'erro') return res.json({ status: 'erro', detalhe: t.erro });
    res.json(Object.assign({ status: 'pronto' }, t.resultado));
  });

  // GET /api/regras/:idSuperlogica/documentos/:docId: dados, resumo e trechos (rótulo e página).
  app.get('/api/regras/:idSuperlogica/documentos/:docId', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await exigirCond(req, res, 'ver'))) return;
    try {
      const d = await docDoCond(req.params.idSuperlogica, req.params.docId);
      if (!d) return naoAchou(res);
      const r = await banco('GET', '/rest/v1/regras_trechos?documento_id=eq.' + d.id + '&select=id,ordem,rotulo,titulo,texto,pagina&order=ordem.asc&limit=3000');
      if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('trechos_' + r.status);
      res.json({ documento: docParaTela(d), trechos: r.body });
    } catch (e) { erroInterno(res, 'detalhe', e); }
  });

  // GET /api/regras/:idSuperlogica/documentos/:docId/arquivo: link do PDF válido por 10 minutos.
  // As outras partes (consulta, notificação, conferência da ata) usam no botão "Abrir documento".
  app.get('/api/regras/:idSuperlogica/documentos/:docId/arquivo', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await exigirCond(req, res, 'ver'))) return;
    try {
      const idSL = String(Number(req.params.idSuperlogica));
      const d = await docDoCond(idSL, req.params.docId, 'id,id_superlogica,arquivo_path');
      if (!d) return naoAchou(res);
      // O caminho tem de estar na pasta do próprio condomínio (defesa contra caminho gravado errado).
      const caminho = String(d.arquivo_path || '');
      if (!caminho || !caminho.startsWith(idSL + '/') || caminho.includes('..')) return res.status(404).json({ erro: 'sem_arquivo', detalhe: 'Este documento está sem o PDF guardado.' });
      const url = await storageSignedUrl(A.BUCKET, caminho, 600);
      res.json({ url, expira_em_segundos: 600 });
    } catch (e) { erroInterno(res, 'arquivo', e); }
  });

  // POST /api/regras/:idSuperlogica/documentos { tipo, titulo, data_documento, vigente, pdf_base64 }
  // PDF digitado: responde 201 com o documento gravado. PDF digitalizado: responde 202 com a
  // tarefa e a tela pergunta em /envios/:tarefa até ficar pronto (leitura leva minutos).
  app.post('/api/regras/:idSuperlogica/documentos', requireAuth, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { if (await exigirCond(req, res, 'gerenciar')) next(); } catch (e) { erroInterno(res, 'enviar', e); }
  }, express.json({ limit: '70mb' }), async (req, res) => {
    const idSL = Number(req.params.idSuperlogica);
    const b = req.body || {};
    if (!dentroDoLimite(req, 'regras_envio', ENVIOS_POR_HORA)) {
      auditoria.evento(req, 'limite_processamento', { tipo: 'regras_envio', id_superlogica: idSL }, true, 'volume_alto');
      return res.status(429).json({ erro: 'limite', detalhe: 'Muitos envios nesta hora. Tente mais tarde.' });
    }
    if (typeof b.pdf_base64 !== 'string' || !b.pdf_base64.length) return res.status(400).json({ erro: 'arquivo_ausente', detalhe: 'O PDF não veio.' });
    if (b.pdf_base64.length > Math.ceil(A.MAX_PDF_BYTES / 3) * 4 + 8) return res.status(413).json({ erro: 'arquivo_grande', detalhe: 'O PDF passa de 50 MB. Divida o arquivo em partes.' });
    const buf = Buffer.from(b.pdf_base64, 'base64');
    b.pdf_base64 = null; // libera a cópia em texto (até 70 MB) enquanto o PDF é lido
    let tarefa = null;
    const dados = {
      tipo: b.tipo, titulo: b.titulo, data_documento: b.data_documento, vigente: b.vigente !== false, pdfBuffer: buf, criado_por: quem(req),
      // Digitalizado: devolve a tarefa já e segue lendo sem segurar a conexão.
      aoDetectar: (info) => {
        if (!info.escaneado || res.headersSent) return;
        limparTarefas();
        tarefa = crypto.randomUUID();
        tarefas.set(tarefa, { dono: quem(req), idSL, status: 'lendo', paginas: info.paginas, criado: Date.now() });
        res.status(202).json({ processando: true, tarefa, paginas: info.paginas, detalhe: 'O PDF é digitalizado. A leitura das ' + info.paginas + ' páginas leva alguns minutos; pode continuar usando o Hub.' });
      },
    };
    try {
      const r = await A.enviarDocumento(deps, idSL, dados);
      const det = { id_superlogica: idSL, documento_id: r.id, tipo: b.tipo, duplicado: !!r.duplicado, escaneado: !!r.escaneado, paginas: r.paginas };
      auditoria.evento(req, 'regras_documento_enviado', det);
      const corpo = r.duplicado
        ? { ok: true, duplicado: true, id: r.id, detalhe: 'Este documento já está no acervo do condomínio (mesmo texto). Nada foi duplicado.' }
        : { ok: true, duplicado: false, id: r.id, trechos: r.trechos, paginas: r.paginas, escaneado: r.escaneado, resumo: r.resumo || null };
      if (tarefa) Object.assign(tarefas.get(tarefa) || {}, { status: 'pronto', resultado: corpo });
      else if (!res.headersSent) res.status(r.duplicado ? 200 : 201).json(corpo);
    } catch (e) {
      if (tarefa) {
        if (!(e instanceof A.ErroAcervo)) console.warn('[regras acervo envio] ' + (e && e.message));
        Object.assign(tarefas.get(tarefa) || {}, { status: 'erro', erro: e instanceof A.ErroAcervo ? e.detalhe : 'Não foi possível concluir a leitura. Tente de novo em instantes.' });
      } else erroInterno(res, 'enviar', e);
    }
  });

  // PATCH /api/regras/:idSuperlogica/documentos/:docId { titulo, tipo, data_documento, vigente, observacao }
  // Mudar o tipo refaz os trechos (convenção e regimento por artigo; ata por bloco).
  app.patch('/api/regras/:idSuperlogica/documentos/:docId', requireAuth, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { if (await exigirCond(req, res, 'gerenciar')) next(); } catch (e) { erroInterno(res, 'editar', e); }
  }, express.json({ limit: '20kb' }), async (req, res) => {
    const idSL = Number(req.params.idSuperlogica);
    const b = req.body || {};
    try {
      const d = await docDoCond(idSL, req.params.docId);
      if (!d) return naoAchou(res);
      const mudar = {};
      if (b.titulo !== undefined) {
        const t = A.textoLimpo(b.titulo, 200);
        if (t.length < 3) return res.status(400).json({ erro: 'titulo_invalido', detalhe: 'Escreva um título com pelo menos 3 letras.' });
        mudar.titulo = t;
      }
      if (b.data_documento !== undefined) {
        const dt = b.data_documento === null || b.data_documento === '' ? null : A.normalizarData(b.data_documento);
        if (b.data_documento && !dt) return res.status(400).json({ erro: 'data_invalida', detalhe: 'Data inválida. Use dia/mês/ano.' });
        mudar.data_documento = dt;
      }
      if (b.observacao !== undefined) mudar.observacao = A.textoLimpo(b.observacao, 1000) || null;
      let novoTipo = null;
      if (b.tipo !== undefined && b.tipo !== d.tipo) {
        if (!B.TIPOS.includes(b.tipo)) return res.status(400).json({ erro: 'tipo_invalido', detalhe: 'Tipo de documento inválido.' });
        novoTipo = b.tipo;
      }
      if (b.vigente !== undefined && typeof b.vigente !== 'boolean') return res.status(400).json({ erro: 'vigente_invalido', detalhe: 'Valor inválido para "vale hoje".' });
      if (!Object.keys(mudar).length && !novoTipo && b.vigente === undefined) return res.status(400).json({ erro: 'nada_a_mudar', detalhe: 'Nada para mudar.' });
      if (novoTipo) {
        // Mesmo texto já cadastrado com o tipo novo: não deixa duplicar (índice único do banco).
        if (d.hash_texto) {
          const ja = await banco('GET', '/rest/v1/regras_documentos?id_superlogica=eq.' + idSL + '&tipo=eq.' + novoTipo + '&hash_texto=eq.' + d.hash_texto + '&id=neq.' + d.id + '&select=id&limit=1');
          if (ja.status === 200 && Array.isArray(ja.body) && ja.body[0]) return res.status(409).json({ erro: 'duplicado', detalhe: 'Já existe um documento igual com esse tipo neste condomínio.' });
        }
        mudar.tipo = novoTipo;
        // Ata, regulamento e outro valem todos juntos: um antigo "versão antiga" que vira um
        // desses tipos volta a valer (senão some da consulta, que só busca o que vale).
        if (!A.TIPOS_COM_VIGENTE.includes(novoTipo)) mudar.vigente = true;
      }
      if (Object.keys(mudar).length) {
        mudar.atualizado_em = new Date().toISOString();
        const r = await banco('PATCH', '/rest/v1/regras_documentos?id=eq.' + d.id + '&id_superlogica=eq.' + idSL, mudar);
        if (r.status >= 300) throw new Error('editar_' + r.status);
      }
      if (novoTipo) await refazerTrechos(d.id, idSL, novoTipo);
      // "Vale hoje": convenção e regimento ficam com uma versão só (marcarVigente tira a dos outros).
      const tipoFinal = novoTipo || d.tipo;
      if (b.vigente === true || (novoTipo && A.TIPOS_COM_VIGENTE.includes(novoTipo) && d.vigente && b.vigente !== false)) {
        await B.marcarVigente(banco, idSL, d.id);
      } else if (b.vigente === false && A.TIPOS_COM_VIGENTE.includes(tipoFinal)) {
        const r = await banco('PATCH', '/rest/v1/regras_documentos?id=eq.' + d.id + '&id_superlogica=eq.' + idSL, { vigente: false, atualizado_em: new Date().toISOString() });
        if (r.status >= 300) throw new Error('vigente_' + r.status);
      }
      auditoria.evento(req, 'regras_documento_editado', { id_superlogica: idSL, documento_id: d.id, campos: Object.keys(mudar).filter((k) => k !== 'atualizado_em').concat(b.vigente !== undefined ? ['vigente'] : []), tipo: tipoFinal });
      const novo = await docDoCond(idSL, d.id);
      res.json({ ok: true, documento: novo ? docParaTela(novo) : null });
    } catch (e) { erroInterno(res, 'editar', e); }
  });

  // Tipo mudou: apaga os trechos e divide o texto de novo (artigo ou bloco, conforme o tipo).
  async function refazerTrechos(docId, idSL, tipo) {
    const r = await banco('GET', '/rest/v1/regras_documentos?id=eq.' + docId + '&select=texto');
    const texto = r.status === 200 && Array.isArray(r.body) && r.body[0] ? String(r.body[0].texto || '') : '';
    if (!texto.trim()) return;
    const novos = dividirEmTrechos(texto, tipo);
    const del = await banco('DELETE', '/rest/v1/regras_trechos?documento_id=eq.' + docId);
    if (del.status >= 300) throw new Error('apagar_trechos_' + del.status);
    for (let i = 0; i < novos.length; i += 200) {
      const lote = novos.slice(i, i + 200).map((t) => ({ documento_id: docId, id_superlogica: idSL, ordem: t.ordem, rotulo: t.rotulo, titulo: t.titulo, texto: t.texto, pagina: t.pagina || null }));
      const ins = await banco('POST', '/rest/v1/regras_trechos', lote);
      if (ins.status !== 201) throw new Error('inserir_trechos_' + ins.status);
    }
  }

  // DELETE /api/regras/:idSuperlogica/documentos/:docId: apaga documento, trechos (cascade) e o PDF.
  app.delete('/api/regras/:idSuperlogica/documentos/:docId', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await exigirCond(req, res, 'gerenciar'))) return;
    const idSL = Number(req.params.idSuperlogica);
    try {
      const d = await docDoCond(idSL, req.params.docId, 'id,id_superlogica,tipo,titulo,arquivo_path,vigente');
      if (!d) return naoAchou(res);
      const r = await banco('DELETE', '/rest/v1/regras_documentos?id=eq.' + d.id + '&id_superlogica=eq.' + idSL);
      if (r.status >= 300) throw new Error('apagar_' + r.status);
      // Arquivo que não apagar fica só no bucket privado (sem documento apontando): vai para o log.
      let arquivoApagado = !d.arquivo_path;
      if (d.arquivo_path && String(d.arquivo_path).startsWith(idSL + '/')) {
        try { await storageDelete(A.BUCKET, d.arquivo_path); arquivoApagado = true; } catch (e) { console.warn('[regras acervo apagar] arquivo do documento ' + d.id + ' ficou no bucket: ' + (e && e.message)); }
      }
      auditoria.evento(req, 'regras_documento_apagado', { id_superlogica: idSL, documento_id: d.id, tipo: d.tipo, titulo: d.titulo, vigente: d.vigente, arquivo_apagado: arquivoApagado });
      res.json({ ok: true });
    } catch (e) { erroInterno(res, 'apagar', e); }
  });
}

module.exports = { criarRotasAcervo, docParaTela };
