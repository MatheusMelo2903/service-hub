// Regras do condomínio, frente C: rotas da notificação (advertência ou multa) e do comunicado
// citando o regimento. Módulo "regras" com a ação "notificar"; condomínio sempre conferido na
// carteira; limite por hora nas rotas que geram texto; auditoria nas gravações.
// Nenhuma rota daqui grava no Superlógica: o registro da ocorrência e da cobrança continua pela
// rota /api/multas/registrar (com a confirmação explícita da tela e só GESTOR ou GERENTE), e
// depois a tela marca a notificação como registrada pelo PATCH com os números devolvidos.

const N = require('./notificacao');

const ID_SL = /^[1-9][0-9]{0,8}$/;
const ID_NUM = /^[1-9][0-9]{0,11}$/;

function criarRotasNotificacao(app, deps) {
  const { requireAuth, express, perfilDe, podeModulo, exigirCarteira, exigirLeituraSuperlogica, dentroDoLimite, auditoria } = deps;
  const usuario = (req) => (req.user && req.user.sub) || null;

  // Permissão do módulo (regras, notificar) e leitura do Superlógica liberada para a pessoa.
  async function exigirModulo(req, res) {
    if (req.authMode !== 'internal') {
      let p = null;
      try { p = await perfilDe(req); } catch (e) { p = null; }
      if (!podeModulo(p, 'regras', 'notificar')) {
        res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não pode gerar notificações por aqui.' });
        return false;
      }
    }
    return exigirLeituraSuperlogica(req, res);
  }
  // Código do condomínio válido, módulo liberado e condomínio da carteira de quem pede.
  async function conferir(req, res) {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!ID_SL.test(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
    if (!(await exigirModulo(req, res))) return null;
    if (!(await exigirCarteira(req, res, id))) return null;
    return id;
  }
  function limite(req, res, tipo, max) {
    if (dentroDoLimite(req, tipo, max)) return true;
    try { auditoria.evento(req, 'limite_processamento', { tipo }, true, 'volume_alto'); } catch (e) { /* segue */ }
    res.status(429).json({ erro: 'limite', detalhe: 'Muitos pedidos nesta hora. Tente mais tarde.' });
    return false;
  }
  // Erro conhecido (status e detalhe) vai para a tela; o resto fica no log e sai genérico.
  function falha(res, onde, e) {
    if (res.headersSent) return;
    if (e && e.status && e.detalhe) return res.status(e.status).json({ erro: e.codigo || 'falha', detalhe: e.detalhe });
    console.warn('[regras ' + onde + '] ' + (e && e.message));
    res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível concluir agora. Tente de novo em instantes.' });
  }

  // GET /api/regras/:idSuperlogica/unidades: unidades com proprietário e inquilino (sem e-mail).
  app.get('/api/regras/:idSuperlogica/unidades', requireAuth, async (req, res) => {
    const id = await conferir(req, res); if (!id) return;
    try {
      const r = await N.unidadesComPessoas(deps, id);
      res.json({ unidades: r.unidades.map(N.paraLista), cortado: !!r.cortado });
    } catch (e) { falha(res, 'unidades', e); }
  });

  // GET /api/regras/:idSuperlogica/unidade/:idUnidade: dados, taxa do mês anterior e histórico.
  app.get('/api/regras/:idSuperlogica/unidade/:idUnidade', requireAuth, async (req, res) => {
    const id = await conferir(req, res); if (!id) return;
    if (!ID_NUM.test(String(req.params.idUnidade || ''))) return res.status(400).json({ erro: 'dados_invalidos', detalhe: 'Unidade inválida.' });
    try {
      const u = await N.dadosUnidade(deps, id, Number(req.params.idUnidade));
      const hist = N.resumirHistorico(await N.historicoCompleto(deps, id, u));
      res.json({ unidade: u, historico: hist.itens, aviso_reincidencia: hist.aviso });
    } catch (e) { falha(res, 'unidade', e); }
  });

  // POST /api/regras/:idSuperlogica/notificacao/rascunho { id_unidade, relato, data_fato, tipo_pedido? }
  app.post('/api/regras/:idSuperlogica/notificacao/rascunho', requireAuth, express.json({ limit: '50kb' }), async (req, res) => {
    const id = await conferir(req, res); if (!id) return;
    const b = req.body || {};
    if (!ID_NUM.test(String(b.id_unidade || ''))) return res.status(400).json({ erro: 'dados_invalidos', detalhe: 'Escolha a unidade.' });
    if (!limite(req, res, 'regras_notificacao', 60)) return;
    try {
      const r = await N.rascunho(deps, id, { idUnidade: Number(b.id_unidade), relato: b.relato, data_fato: b.data_fato, tipo_pedido: b.tipo_pedido }, usuario(req));
      res.json(r);
    } catch (e) { falha(res, 'rascunho', e); }
  });

  // POST /api/regras/:idSuperlogica/notificacao: salva o rascunho (novo ou, com id, atualiza).
  app.post('/api/regras/:idSuperlogica/notificacao', requireAuth, express.json({ limit: '100kb' }), async (req, res) => {
    const id = await conferir(req, res); if (!id) return;
    try {
      const n = await N.salvar(deps, id, req.body || {}, usuario(req));
      auditoria.evento(req, 'regras_notificacao_salva', { id_superlogica: Number(id), notificacao: n.id, tipo: n.tipo, unidade: n.unidade });
      res.json({ notificacao: n });
    } catch (e) { falha(res, 'salvar', e); }
  });

  // GET /api/regras/:idSuperlogica/notificacoes?tipo=&status=&id_unidade=&unidade=
  app.get('/api/regras/:idSuperlogica/notificacoes', requireAuth, async (req, res) => {
    const id = await conferir(req, res); if (!id) return;
    try {
      const q = req.query || {};
      res.json({ notificacoes: await N.listar(deps, id, { tipo: q.tipo, status: q.status, id_unidade: q.id_unidade, unidade: q.unidade }) });
    } catch (e) { falha(res, 'listar', e); }
  });

  // PATCH /api/regras/notificacao/:id { status, id_ocorrencia_sl?, id_cobranca_sl? }
  // A notificação tem de ser de condomínio da carteira de quem pede.
  app.patch('/api/regras/notificacao/:id', requireAuth, express.json({ limit: '5kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!ID_NUM.test(String(req.params.id || ''))) return res.status(400).json({ erro: 'dados_invalidos', detalhe: 'Notificação inválida.' });
    if (!(await exigirModulo(req, res))) return;
    try {
      const atual = await N.lerNotificacao(deps, req.params.id);
      if (!atual) return res.status(404).json({ erro: 'nao_encontrada', detalhe: 'Notificação não encontrada.' });
      if (!(await exigirCarteira(req, res, String(atual.id_superlogica)))) return;
      const n = await N.mudarStatus(deps, atual, req.body || {});
      auditoria.evento(req, 'regras_notificacao_status', { id_superlogica: atual.id_superlogica, notificacao: n.id, de: atual.status, para: n.status, id_ocorrencia_sl: n.id_ocorrencia_sl || null, id_cobranca_sl: n.id_cobranca_sl || null });
      res.json({ notificacao: n });
    } catch (e) { falha(res, 'status', e); }
  });

  // POST /api/regras/:idSuperlogica/comunicado/rascunho { tipo, assunto, detalhes, condominio }
  // Mesmo formato do /api/comunicados/rascunho ({ titulo, texto }) mais os fundamentos conferidos.
  app.post('/api/regras/:idSuperlogica/comunicado/rascunho', requireAuth, express.json({ limit: '50kb' }), async (req, res) => {
    const id = await conferir(req, res); if (!id) return;
    if (!limite(req, res, 'regras_comunicado', 60)) return;
    try {
      res.json(await N.comunicadoComRegras(deps, id, req.body || {}, usuario(req)));
    } catch (e) { falha(res, 'comunicado', e); }
  });
}

module.exports = { criarRotasNotificacao };
