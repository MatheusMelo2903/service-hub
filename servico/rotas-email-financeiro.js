// Caixas de email do financeiro (documentos chegando por email): cadastro só para GESTOR.
// Rotas em /api/email-financeiro/*. A senha da caixa é cifrada aqui no servidor
// (financeiro/email-financeiro.js) e nunca volta para a tela: a resposta só diz "senha guardada".
// O leitor periódico (a cada 5 minutos) só roda com EMAIL_FINANCEIRO=on; "ler agora" obedece à
// mesma chave. "Testar conexão" só conecta, abre a pasta para leitura e sai.

const crypto = require('crypto');
const EF = require('../financeiro/email-financeiro');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function criarRotasEmailFinanceiro(app, d) {
  const { requireAuth, requireGestor, express, banco, leitor, auditoria, gruposCarteiras } = d;
  const env = () => d.env || process.env;
  const json = express.json({ limit: '20kb' });

  function falha(res, onde, e) {
    console.warn('[email-financeiro ' + onde + '] ' + EF.codigoErro(e));
    if (!res.headersSent) res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível concluir agora. Tente de novo em instantes.' });
  }
  async function lerCaixa(id) {
    const r = await banco('GET', '/rest/v1/fin_email_caixas?select=*&id=eq.' + id + '&limit=1');
    if (r.status !== 200) throw new Error('banco_' + r.status);
    return Array.isArray(r.body) && r.body[0] ? r.body[0] : null;
  }
  async function carregar(req, res) {
    if (!UUID.test(String(req.params.id || ''))) { res.status(400).json({ erro: 'id_invalido' }); return null; }
    let c;
    try { c = await lerCaixa(req.params.id); } catch (e) { falha(res, 'carregar', e); return null; }
    if (!c) { res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Caixa não encontrada.' }); return null; }
    return c;
  }
  // Analistas e carteiras para os campos de finalidade (só nome e código).
  async function opcoes() {
    const out = { analistas: [], carteiras: [] };
    try {
      const r = await banco('GET', '/rest/v1/profiles?select=id,nome,email,role&bloqueado=not.is.true&order=nome.asc&limit=500');
      if (r.status === 200 && Array.isArray(r.body)) out.analistas = r.body.map((p) => ({ id: p.id, nome: p.nome || p.email || p.id }));
    } catch (e) { /* lista vazia */ }
    try { out.carteiras = (await gruposCarteiras()).map((g) => ({ id: g.id, nome: g.nome })); } catch (e) { /* sem carteiras */ }
    return out;
  }
  function estado() {
    return { ligado: EF.ligado(env()), chave_configurada: !!EF.chaveDe(env()), servidores: EF.servidoresPermitidos(env()), lendo: leitor.emAndamento() };
  }

  // GET /api/email-financeiro/caixas
  app.get('/api/email-financeiro/caixas', requireAuth, requireGestor, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const r = await banco('GET', '/rest/v1/fin_email_caixas?select=*&order=criado_em.asc&limit=100');
      if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('banco_' + r.status);
      res.json(Object.assign(estado(), await opcoes(), { caixas: r.body.map(EF.caixaParaTela) }));
    } catch (e) { falha(res, 'listar', e); }
  });

  // GET /api/email-financeiro/caixas/:id/mensagens — os últimos emails lidos da caixa.
  app.get('/api/email-financeiro/caixas/:id/mensagens', requireAuth, requireGestor, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const c = await carregar(req, res); if (!c) return;
    try {
      const r = await banco('GET', '/rest/v1/fin_email_mensagens?select=uid,status,tentativas,remetente,assunto,recebido_em,criado_em,entradas,detalhe&caixa_id=eq.' + c.id + '&order=criado_em.desc&limit=30');
      if (r.status !== 200) throw new Error('banco_' + r.status);
      res.json({ mensagens: r.body || [] });
    } catch (e) { falha(res, 'mensagens', e); }
  });

  // Grava a caixa (nova ou editada). A senha só é trocada quando vem preenchida.
  async function salvar(req, res, atual) {
    const v = EF.validarCaixa(req.body, atual, env());
    if (!v.ok) return res.status(400).json({ erro: 'campo_invalido', detalhe: v.detalhe });
    const id = atual ? atual.id : crypto.randomUUID();
    const linha = Object.assign({}, v.dados, { atualizado_em: new Date().toISOString() });
    if (v.senha) {
      try { linha.senha_cifrada = EF.cifrar(v.senha, id, env()); } catch (e) {
        return res.status(503).json({ erro: 'sem_chave', detalhe: 'A chave de cifra das senhas (EMAIL_FINANCEIRO_CHAVE) não está configurada no servidor. Nada foi salvo.' });
      }
    }
    // Trocar servidor, usuário ou pasta recomeça a contagem de onde parou (a pasta é outra).
    if (atual && (atual.servidor !== linha.servidor || atual.usuario !== linha.usuario || String(atual.pasta).toLowerCase() !== String(linha.pasta).toLowerCase())) {
      Object.assign(linha, { uid_validity: null, ultimo_uid: null });
    }
    try {
      const r = atual
        ? await banco('PATCH', '/rest/v1/fin_email_caixas?id=eq.' + id + '&select=*', linha)
        : await banco('POST', '/rest/v1/fin_email_caixas?select=*', Object.assign({ id, criado_por: req.user ? req.user.sub : null }, linha));
      if (r.status === 409) return res.status(409).json({ erro: 'repetida', detalhe: 'Já existe uma caixa com esse endereço e essa pasta.' });
      if (!(r.status === 200 || r.status === 201) || !Array.isArray(r.body) || !r.body[0]) throw new Error('banco_' + r.status);
      auditoria.evento(req, atual ? 'email_caixa_editada' : 'email_caixa_criada', { caixa: id, endereco: linha.endereco, ativo: linha.ativo, senha_trocada: !!v.senha });
      res.json({ caixa: EF.caixaParaTela(r.body[0]) });
    } catch (e) { falha(res, 'salvar', e); }
  }
  app.post('/api/email-financeiro/caixas', requireAuth, requireGestor, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    await salvar(req, res, null);
  });
  app.put('/api/email-financeiro/caixas/:id', requireAuth, requireGestor, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const c = await carregar(req, res); if (!c) return;
    await salvar(req, res, c);
  });

  // POST /api/email-financeiro/caixas/:id/remover — tira a caixa do Hub (os emails no servidor
  // continuam lá; os documentos já lidos continuam na entrada).
  app.post('/api/email-financeiro/caixas/:id/remover', requireAuth, requireGestor, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.body || req.body.confirmacao !== 'REMOVER') return res.status(400).json({ erro: 'sem_confirmacao', detalhe: 'Confirme na tela.' });
    const c = await carregar(req, res); if (!c) return;
    try {
      const r = await banco('DELETE', '/rest/v1/fin_email_caixas?id=eq.' + c.id);
      if (!(r.status === 200 || r.status === 204)) throw new Error('banco_' + r.status);
      auditoria.evento(req, 'email_caixa_removida', { caixa: c.id, endereco: c.endereco });
      res.json({ ok: true });
    } catch (e) { falha(res, 'remover', e); }
  });

  // POST /api/email-financeiro/testar { id?, endereco, servidor, porta, usuario, senha?, pasta }
  // Testa o que está na tela; sem senha digitada, usa a guardada da caixa (id).
  app.post('/api/email-financeiro/testar', requireAuth, requireGestor, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    let atual = null;
    if (b.id != null) {
      if (!UUID.test(String(b.id))) return res.status(400).json({ erro: 'id_invalido' });
      try { atual = await lerCaixa(b.id); } catch (e) { return falha(res, 'testar', e); }
      if (!atual) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Caixa não encontrada.' });
    }
    // Finalidade não importa para o teste (só servidor, porta, usuário, senha e pasta).
    const v = EF.validarCaixa(Object.assign({}, b, { finalidade: 'geral', carteira: null, condominios: [] }), atual, env());
    if (!v.ok) return res.status(400).json({ erro: 'campo_invalido', detalhe: v.detalhe });
    let senha = v.senha;
    if (!senha && atual) {
      if (!EF.chaveDe(env())) return res.status(503).json({ erro: 'sem_chave', detalhe: EF.erroAmigavel({ code: 'sem_chave' }) });
      senha = atual.senha_cifrada ? EF.decifrar(atual.senha_cifrada, atual.id, env()) : null;
      if (senha == null) return res.json({ ok: false, detalhe: EF.erroAmigavel({ code: 'senha_ilegivel' }) });
    }
    const r = await leitor.testar(Object.assign({ id: atual ? atual.id : null }, v.dados), senha);
    senha = null;
    if (atual) await banco('PATCH', '/rest/v1/fin_email_caixas?id=eq.' + atual.id, { ultimo_teste: r }).catch(() => null);
    auditoria.evento(req, 'email_caixa_testada', { caixa: atual ? atual.id : null, ok: r.ok });
    res.json(r);
  });

  // POST /api/email-financeiro/caixas/:id/ler — lê agora (só com o leitor ligado). Responde logo;
  // a tela atualiza depois.
  app.post('/api/email-financeiro/caixas/:id/ler', requireAuth, requireGestor, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const c = await carregar(req, res); if (!c) return;
    if (!EF.ligado(env())) return res.status(423).json({ erro: 'desligado', detalhe: 'A leitura dos emails está desligada neste ambiente (EMAIL_FINANCEIRO).' });
    if (!c.ativo) return res.status(409).json({ erro: 'inativa', detalhe: 'Ative a caixa antes de ler.' });
    if (leitor.emAndamento()) return res.json({ em_andamento: true, detalhe: 'Já existe uma leitura em andamento. Atualize em instantes.' });
    auditoria.evento(req, 'email_caixa_ler_agora', { caixa: c.id });
    leitor.rodar(c.id).catch(() => null);
    res.json({ iniciado: true, detalhe: 'Leitura iniciada. Atualize em instantes.' });
  });
}

module.exports = { criarRotasEmailFinanceiro };
