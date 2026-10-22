// Regras do condomínio, frente E: rotas da conferência da ata (só aviso) e dos mandatos.
// A conferência é chamada pela tela de Atas DEPOIS que a ata fica pronta; a ata não depende
// dela e nada daqui muda o texto da ata. Permissões conferidas no servidor (falha fechada):
//  POST /api/regras/:id/conferir-ata        módulo atas, ação gerar (quem gera a ata)
//  GET  /api/regras/:id/conferencias-ata    módulo atas (gerar) ou regras (ver)
//  POST /api/regras/:id/mandatos/extrair    módulo regras, ação gerenciar
//  GET  /api/regras/:id/mandatos            módulo regras, ação ver
//  PATCH /api/regras/mandatos/:mandatoId    módulo regras, ação gerenciar
// Condomínio sempre conferido na carteira (exigirCarteira).

const { conferirAta, listarConferencias } = require('./conferencia-ata');
const { extrairMandatos, extrairDoAcervo, listarMandatos, dataIso } = require('./mandatos');

const ID_SL = /^[1-9][0-9]{0,8}$/;
const MAX_ATA_CHARS = 400000;
const MAX_EDITAL_CHARS = 120000;

function criarRotasAta(app, d) {
  const { requireAuth, express, banco, perfilDe, podeModulo, exigirCarteira, dentroDoLimite, auditoria, chamarModelo, modelos } = d;
  const depsServico = { banco, chamarModelo, modelos };
  const usuarioDe = (req) => (req.user && /^[0-9a-f-]{36}$/i.test(String(req.user.sub || '')) ? req.user.sub : null);

  // Confere o módulo e a ação. regras: lista de [modulo, acao]; basta uma valer.
  async function exigirModulo(req, res, regras, detalhe) {
    if (req.authMode === 'internal') return true;
    let p = null;
    try { p = await perfilDe(req); } catch (e) { p = null; }
    if (regras.some(([m, a]) => podeModulo(p, m, a))) return true;
    res.status(403).json({ erro: 'acesso_negado', detalhe: detalhe || 'Seu usuário não tem acesso a esta função.' });
    return false;
  }
  // Id do condomínio no caminho, carteira e módulo, nessa ordem. Devolve o id ou null.
  async function preparar(req, res, regras, detalhe) {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!ID_SL.test(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
    if (!(await exigirModulo(req, res, regras, detalhe))) return null;
    if (!(await exigirCarteira(req, res, id))) return null;
    return id;
  }
  function falha(res, onde, e) {
    console.warn('[regras ' + onde + '] ' + (e && e.message));
    if (!res.headersSent) res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível concluir agora. Tente de novo em instantes.' });
  }
  const textoErro = (erro) => (erro === 'ata_vazia' ? 'A ata está vazia.' : 'Não foi possível conferir agora. Tente de novo em instantes.');

  // POST /api/regras/:id/conferir-ata { texto_ata, edital_texto, transcricao_id }
  app.post('/api/regras/:idSuperlogica/conferir-ata', requireAuth, express.json({ limit: '3mb' }), async (req, res) => {
    const id = await preparar(req, res, [['atas', 'gerar']], 'Seu usuário não pode gerar atas.');
    if (!id) return;
    const b = req.body || {};
    if (typeof b.texto_ata !== 'string' || !b.texto_ata.trim() || b.texto_ata.length > MAX_ATA_CHARS) {
      return res.status(400).json({ erro: 'ata_invalida', detalhe: 'Envie o texto da ata gerada.' });
    }
    if (b.edital_texto != null && (typeof b.edital_texto !== 'string' || b.edital_texto.length > MAX_EDITAL_CHARS)) {
      return res.status(400).json({ erro: 'edital_invalido', detalhe: 'Texto do edital inválido.' });
    }
    if (!dentroDoLimite(req, 'regras_conferir_ata', 40)) {
      auditoria.evento(req, 'limite_processamento', { tipo: 'regras_conferir_ata', id_superlogica: id }, true, 'volume_alto');
      return res.status(429).json({ erro: 'limite', detalhe: 'Muitas conferências nesta hora. Tente mais tarde.' });
    }
    try {
      const r = await conferirAta(depsServico, id, {
        texto_ata: b.texto_ata, edital_texto: b.edital_texto || '',
        transcricao_id: b.transcricao_id != null ? String(b.transcricao_id).slice(0, 80) : null, usuario: usuarioDe(req),
      });
      auditoria.evento(req, 'regras_conferencia_ata', { id_superlogica: id, itens: r.itens ? r.itens.length : 0, sem_regras: !!r.sem_regras, ok: !!r.ok });
      if (!r.ok) return res.status(502).json({ erro: 'falha_conferencia', detalhe: textoErro(r.erro) });
      res.json({ id: r.id || null, itens: r.itens, resumo: r.resumo, aviso: r.aviso || null, sem_regras: !!r.sem_regras, ata_hash: r.ata_hash });
    } catch (e) { falha(res, 'conferir-ata', e); }
  });

  // GET /api/regras/:id/conferencias-ata?limite=10
  app.get('/api/regras/:idSuperlogica/conferencias-ata', requireAuth, async (req, res) => {
    const id = await preparar(req, res, [['atas', 'gerar'], ['regras', 'ver']]);
    if (!id) return;
    try { res.json({ conferencias: await listarConferencias(banco, id, req.query.limite) }); } catch (e) { falha(res, 'conferencias-ata', e); }
  });

  // POST /api/regras/:id/mandatos/extrair { documento_id? } — sem documento: lê as atas do acervo.
  app.post('/api/regras/:idSuperlogica/mandatos/extrair', requireAuth, express.json({ limit: '10kb' }), async (req, res) => {
    const id = await preparar(req, res, [['regras', 'gerenciar']], 'Seu usuário não pode gerenciar as regras do condomínio.');
    if (!id) return;
    if (!dentroDoLimite(req, 'regras_mandatos', 20)) {
      auditoria.evento(req, 'limite_processamento', { tipo: 'regras_mandatos', id_superlogica: id }, true, 'volume_alto');
      return res.status(429).json({ erro: 'limite', detalhe: 'Muitas leituras nesta hora. Tente mais tarde.' });
    }
    const docId = req.body && req.body.documento_id != null ? Number(req.body.documento_id) : null;
    if (docId != null && !(Number.isInteger(docId) && docId > 0)) return res.status(400).json({ erro: 'documento_invalido', detalhe: 'Documento inválido.' });
    try {
      let r;
      if (docId) {
        // Documento tem de ser ata deste condomínio (o filtro por condomínio impede ler o de outro).
        const q = await banco('GET', '/rest/v1/regras_documentos?id=eq.' + docId + '&id_superlogica=eq.' + id + '&tipo=eq.ata&select=id,texto,data_documento&limit=1');
        const doc = q.status === 200 && Array.isArray(q.body) ? q.body[0] : null;
        if (!doc || !doc.texto) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Ata não encontrada no acervo deste condomínio.' });
        r = await extrairMandatos(depsServico, id, { texto: doc.texto, data_ata: doc.data_documento, documento_id: doc.id, usuario: usuarioDe(req) });
        if (!r.ok) return res.status(502).json({ erro: 'falha_extracao', detalhe: 'Não foi possível ler os mandatos agora.' });
      } else {
        r = await extrairDoAcervo(depsServico, id, { usuario: usuarioDe(req) });
      }
      auditoria.evento(req, 'regras_mandatos_extraidos', { id_superlogica: id, documento_id: docId, mandatos: r.mandatos.length });
      res.json(Object.assign({}, r, { mandatos: await listarMandatos(banco, id) }));
    } catch (e) { falha(res, 'mandatos-extrair', e); }
  });

  // GET /api/regras/:id/mandatos
  app.get('/api/regras/:idSuperlogica/mandatos', requireAuth, async (req, res) => {
    const id = await preparar(req, res, [['regras', 'ver']]);
    if (!id) return;
    try { res.json({ mandatos: await listarMandatos(banco, id) }); } catch (e) { falha(res, 'mandatos', e); }
  });

  // PATCH /api/regras/mandatos/:mandatoId { conferido?, fim?, nome? }
  app.patch('/api/regras/mandatos/:mandatoId', requireAuth, express.json({ limit: '10kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const mid = Number(req.params.mandatoId);
    if (!Number.isInteger(mid) || mid <= 0) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Mandato inválido.' });
    if (!(await exigirModulo(req, res, [['regras', 'gerenciar']], 'Seu usuário não pode gerenciar as regras do condomínio.'))) return;
    const b = req.body || {};
    const mud = {};
    if (b.conferido !== undefined) {
      if (typeof b.conferido !== 'boolean') return res.status(400).json({ erro: 'valor_invalido', detalhe: 'Conferido deve ser sim ou não.' });
      mud.conferido = b.conferido;
    }
    if (b.fim !== undefined) {
      if (b.fim === null || b.fim === '') mud.fim = null;
      else { const f = dataIso(b.fim); if (!f) return res.status(400).json({ erro: 'data_invalida', detalhe: 'Informe a data de fim no formato DD/MM/AAAA.' }); mud.fim = f; }
    }
    if (b.nome !== undefined) {
      const n = String(b.nome || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (n.length < 3 || n.length > 200) return res.status(400).json({ erro: 'nome_invalido', detalhe: 'Informe o nome (3 a 200 caracteres).' });
      mud.nome = n;
    }
    if (!Object.keys(mud).length) return res.status(400).json({ erro: 'nada_para_mudar', detalhe: 'Nada para alterar.' });
    try {
      // O mandato é de um condomínio: quem tem carteira só mexe nos da carteira.
      const dono = await banco('GET', '/rest/v1/regras_mandatos?id=eq.' + mid + '&select=id,id_superlogica,inicio');
      if (dono.status !== 200 || !Array.isArray(dono.body)) throw new Error('ler_' + dono.status);
      if (!dono.body.length) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Mandato não encontrado.' });
      if (!(await exigirCarteira(req, res, String(dono.body[0].id_superlogica)))) return;
      if (mud.fim && dono.body[0].inicio && mud.fim <= dono.body[0].inicio) return res.status(400).json({ erro: 'data_invalida', detalhe: 'O fim precisa ser depois do início.' });
      const r = await banco('PATCH', '/rest/v1/regras_mandatos?id=eq.' + mid, mud);
      if (r.status !== 200 || !Array.isArray(r.body) || !r.body[0]) throw new Error('patch_' + r.status);
      auditoria.evento(req, 'regras_mandato_alterado', { id_superlogica: dono.body[0].id_superlogica, mandato_id: mid, campos: Object.keys(mud) });
      res.json({ mandato: r.body[0] });
    } catch (e) { falha(res, 'mandato-patch', e); }
  });
}

module.exports = { criarRotasAta };
