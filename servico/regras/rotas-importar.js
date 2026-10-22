// Regras do condomínio, frente A: rotas da importação do acervo do CondGPT. Só GESTOR.
// O arquivo exportado (cerca de 44 MB) é lido no navegador e chega um condomínio por vez:
//   POST /api/regras/importar/mapa            liga cada slug ao código do Superlógica pelo CNPJ
//   PUT  /api/regras/importar/mapa/:slug      GESTOR informa o código à mão
//   POST /api/regras/importar/condominio      grava textos, resumos, notificações e comunicados
//   GET  /api/regras/importar/status          progresso da cópia dos PDFs
//   POST /api/regras/importar/retomar-pdfs    reenfileira os PDFs que faltam (depois de reinício)
// Nada é gravado no Superlógica: só leitura da lista de condomínios para casar o CNPJ.

const I = require('./importar-condgpt');
const slDados = require('../../superlogica-dados');

const TTL_LISTA_MS = 10 * 60 * 1000;
const RE_ID = /^[1-9][0-9]{0,8}$/;
const digitos = (v) => String(v == null ? '' : v).replace(/\D/g, '');

function criarRotasImportar(app, d) {
  const { requireAuth, express, banco, perfilDe, exigirCarteira, exigirLeituraSuperlogica, clienteSL, auditoria, storageUpload } = d;
  // baixarPdf só existe no teste (sem rede); no servidor vale o download do CondGPT.
  const fila = I.criarFilaPdf(Object.assign({ banco, storageUpload }, d.baixarPdf ? { baixar: d.baixarPdf } : {}));
  const emCurso = new Set();
  let cacheLista = { ate: 0, lista: null };

  // Só GESTOR (o acesso interno por segredo do servidor também passa, como no resto do Hub).
  async function exigirGestor(req, res) {
    let p = null;
    try { p = await perfilDe(req); } catch (e) { p = null; }
    if (p && p.role === 'GESTOR') return true;
    res.status(403).json({ erro: 'acesso_negado', detalhe: 'Só o gestor pode importar o acervo.' });
    return false;
  }
  const quem = (req) => (req.user && (req.user.sub || null)) || null;
  const quemTexto = (req) => (req.user && (req.user.email || req.user.sub)) || 'interno';
  function falha(res, onde, e) {
    console.warn('[regras importar ' + onde + '] ' + (e && e.message));
    if (!res.headersSent) res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível concluir agora. Tente de novo em instantes.' });
  }
  // Lista de condomínios do Superlógica (com CNPJ), guardada por 10 minutos.
  async function listaSL(forcar) {
    if (!forcar && cacheLista.lista && cacheLista.ate > Date.now()) return cacheLista.lista;
    const lista = await slDados.listarCondominiosSuperlogica(clienteSL());
    cacheLista = { ate: Date.now() + TTL_LISTA_MS, lista };
    return lista;
  }
  // Conferências antes de qualquer rota: login, GESTOR e chaves do Superlógica no servidor.
  const guarda = (comSL) => async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!(await exigirGestor(req, res))) return;
      if (comSL && !(await exigirLeituraSuperlogica(req, res))) return;
      next();
    } catch (e) { falha(res, 'guarda', e); }
  };

  // POST /api/regras/importar/mapa { condominios: [{ slug, label, cnpj }] }
  app.post('/api/regras/importar/mapa', requireAuth, guarda(true), express.json({ limit: '300kb' }), async (req, res) => {
    const conds = Array.isArray(req.body && req.body.condominios) ? req.body.condominios.slice(0, 500) : null;
    if (!conds || !conds.length) return res.status(400).json({ erro: 'sem_condominios', detalhe: 'O arquivo não trouxe condomínios.' });
    try {
      const [lista, existentes] = await Promise.all([listaSL(!!(req.body && req.body.atualizar)), I.lerMapa(banco)]);
      const linhas = I.montarMapa(conds, lista, existentes);
      await I.gravarMapa(banco, linhas, existentes);
      auditoria.evento(req, 'regras_importar_mapa', { condominios: linhas.length, sem_correspondencia: linhas.filter((l) => l.situacao === 'sem_correspondencia').length });
      res.json({ mapa: linhas });
    } catch (e) { falha(res, 'mapa', e); }
  });

  // PUT /api/regras/importar/mapa/:slug { id_superlogica } (null ou vazio tira a ligação)
  app.put('/api/regras/importar/mapa/:slug', requireAuth, guarda(true), express.json({ limit: '5kb' }), async (req, res) => {
    const slug = String(req.params.slug || '');
    if (!I.RE_SLUG.test(slug)) return res.status(400).json({ erro: 'slug_invalido', detalhe: 'Condomínio do arquivo inválido.' });
    if (I.SLUGS_IGNORADOS[slug]) return res.status(400).json({ erro: 'ignorado', detalhe: 'Este condomínio do arquivo é uma duplicata e não é importado.' });
    const bruto = req.body && req.body.id_superlogica;
    const limpar = bruto === null || bruto === undefined || String(bruto).trim() === '';
    if (!limpar && !RE_ID.test(String(bruto).trim())) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
    try {
      const atual = (await I.lerMapa(banco)).find((m) => m.slug === slug);
      if (!atual) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Carregue o arquivo de novo para montar o mapa.' });
      let nomeSL = null;
      const id = limpar ? null : Number(String(bruto).trim());
      if (id) {
        if (!(await exigirCarteira(req, res, String(id)))) return;
        const c = (await listaSL(false)).find((x) => Number(x.id_condominio_cond) === id) || (await listaSL(true)).find((x) => Number(x.id_condominio_cond) === id);
        if (!c) return res.status(400).json({ erro: 'nao_existe', detalhe: 'Esse código não existe entre os condomínios ativos do Superlógica.' });
        nomeSL = String(c.st_fantasia_cond || c.st_nome_cond || '').trim() || null;
      }
      const obs = id ? 'informado manualmente por ' + quemTexto(req) : 'ligação retirada por ' + quemTexto(req);
      const r = await banco('PATCH', '/rest/v1/regras_mapa_condgpt?slug=eq.' + encodeURIComponent(slug), { id_superlogica: id, observacao: obs.slice(0, 300) });
      if (!(r.status >= 200 && r.status < 300)) throw new Error('mapa_gravar_' + r.status);
      auditoria.evento(req, 'regras_importar_mapa_manual', { slug, id_superlogica: id, cnpj_condgpt: atual.cnpj || null });
      res.json({ slug, id_superlogica: id, nome_superlogica: nomeSL, situacao: id ? 'manual' : 'sem_correspondencia', observacao: obs });
    } catch (e) { falha(res, 'mapa manual', e); }
  });

  // POST /api/regras/importar/condominio { slug, bloco } (bloco pode vir em partes)
  app.post('/api/regras/importar/condominio', requireAuth, guarda(false), express.json({ limit: '25mb' }), async (req, res) => {
    const slug = String((req.body && req.body.slug) || '');
    const bloco = req.body && req.body.bloco;
    if (!I.RE_SLUG.test(slug)) return res.status(400).json({ erro: 'slug_invalido', detalhe: 'Condomínio do arquivo inválido.' });
    if (!bloco || typeof bloco !== 'object' || Array.isArray(bloco)) return res.status(400).json({ erro: 'bloco_invalido', detalhe: 'Dados do condomínio inválidos.' });
    if (I.SLUGS_IGNORADOS[slug]) return res.status(400).json({ erro: 'ignorado', detalhe: 'Este condomínio do arquivo é uma duplicata e não é importado.' });
    if (emCurso.has(slug)) return res.status(409).json({ erro: 'em_andamento', detalhe: 'Este condomínio já está sendo importado.' });
    emCurso.add(slug);
    try {
      const m = (await I.lerMapa(banco)).find((x) => x.slug === slug);
      if (!m || !m.id_superlogica) return res.status(400).json({ erro: 'sem_codigo', detalhe: 'Este condomínio não está ligado a um código do Superlógica.' });
      // O CNPJ do bloco tem de ser o do mapa: evita gravar o acervo de um condomínio em outro.
      const cnpjBloco = digitos(bloco.dados && bloco.dados.inscricao);
      if (cnpjBloco && m.cnpj && cnpjBloco !== digitos(m.cnpj)) return res.status(400).json({ erro: 'cnpj_diferente', detalhe: 'O CNPJ deste bloco não é o do mapa. Carregue o arquivo de novo.' });
      if (cnpjBloco === I.CNPJ_ADMINISTRADORA) return res.status(400).json({ erro: 'ignorado', detalhe: 'CNPJ da administradora: não importado.' });
      if (!(await exigirCarteira(req, res, String(m.id_superlogica)))) return;
      const r = await I.importarCondominio(banco, { slug, idSL: Number(m.id_superlogica), cnpj: m.cnpj || cnpjBloco || null, criadoPor: quem(req) }, bloco);
      const enfileirados = fila.enfileirar(r.pdfs);
      const resumo = { documentos: r.documentos, notificacoes: r.notificacoes, comunicados: r.comunicados, atas_geradas: r.atas_geradas, pdfs_enfileirados: enfileirados };
      auditoria.evento(req, 'regras_importar_condgpt', Object.assign({ id_superlogica: Number(m.id_superlogica), slug }, resumo, { erros: r.erros.length }));
      res.json(Object.assign({ slug, id_superlogica: Number(m.id_superlogica) }, resumo, { erros: r.erros }));
    } catch (e) { falha(res, 'condominio', e); } finally { emCurso.delete(slug); }
  });

  // GET /api/regras/importar/status
  app.get('/api/regras/importar/status', requireAuth, guarda(false), (req, res) => {
    res.json(fila.status());
  });

  // POST /api/regras/importar/retomar-pdfs
  app.post('/api/regras/importar/retomar-pdfs', requireAuth, guarda(false), async (req, res) => {
    try {
      const pend = await I.pendentesPdf(banco);
      const n = fila.enfileirar(pend);
      auditoria.evento(req, 'regras_importar_retomar_pdfs', { pendentes: pend.length, enfileirados: n });
      res.json({ pendentes: pend.length, enfileirados: n, status: fila.status() });
    } catch (e) { falha(res, 'retomar', e); }
  });

  return { fila };
}

module.exports = { criarRotasImportar };
