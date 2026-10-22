// Regras do condomínio, frente B: rotas da consulta, da comparação e das perguntas frequentes.
// Módulo "regras": ver (FAQ), consultar (perguntar e comparar), gerenciar (gerar o FAQ).
// Condomínio sempre conferido na carteira de quem pergunta. Resposta sem nome de modelo, sem
// instrução e sem texto bruto do processamento; erro genérico para o usuário, detalhe só no log.

const consulta = require('./consulta');
const faq = require('./faq');

const ID_SL = /^[1-9][0-9]{0,8}$/;
const MAX_PERGUNTA = 500;
const LIMITE_HORA = { perguntar: 60, comparar: 10, faq: 6 };

function criarRotasConsulta(app, deps) {
  const { requireAuth, express, banco, perfilDe, podeModulo, exigirCarteira, carteiraT18, dentroDoLimite, auditoria, chamarModelo, modelos } = deps;
  const json = express.json({ limit: '20kb' });
  const gerandoFaq = new Set(); // condomínio com FAQ em geração (evita dois cliques gastando em dobro)

  // Confere o módulo e a ação. Interno (segredo do servidor) passa como gestor.
  async function exigir(req, res, acao) {
    if (req.authMode === 'internal') return true;
    let p = null;
    try { p = await perfilDe(req); } catch (e) { p = null; }
    if (podeModulo(p, 'regras', acao)) return true;
    res.status(403).json({ erro: 'acesso_negado', detalhe: acao === 'gerenciar' ? 'Seu usuário não pode atualizar as perguntas frequentes.' : 'Seu usuário não tem acesso a esta aba.' });
    return false;
  }
  async function pode(req, acao) {
    if (req.authMode === 'internal') return true;
    try { return podeModulo(await perfilDe(req), 'regras', acao); } catch (e) { return false; }
  }
  function limite(req, res, tipo) {
    if (dentroDoLimite(req, 'regras_' + tipo, LIMITE_HORA[tipo])) return true;
    auditoria.evento(req, 'limite_processamento', { tipo: 'regras_' + tipo }, true, 'volume_alto');
    res.status(429).json({ erro: 'limite', detalhe: 'Muitas consultas nesta hora. Tente mais tarde.' });
    return false;
  }
  const depsModelo = (req) => ({ banco, chamarModelo, modelos, usuario: req.user && req.user.sub });
  function erroInterno(res, onde, e) {
    console.warn('[regras ' + onde + '] ' + (e && e.message));
    if (!res.headersSent) res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível responder agora. Tente de novo em instantes.' });
  }
  function lerPergunta(req, res) {
    const p = String((req.body && req.body.pergunta) || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim();
    if (p.length < 3) { res.status(400).json({ erro: 'pergunta_invalida', detalhe: 'Escreva a pergunta.' }); return null; }
    if (p.length > MAX_PERGUNTA) { res.status(400).json({ erro: 'pergunta_invalida', detalhe: 'A pergunta pode ter até ' + MAX_PERGUNTA + ' caracteres.' }); return null; }
    return p;
  }

  // Nomes dos condomínios da base (para a tabela de comparação). Falha vira lista sem nome.
  async function nomesDe(ids) {
    const m = new Map();
    if (!ids.length) return m;
    try {
      const r = await banco('GET', '/rest/v1/condominios?id_superlogica=in.(' + ids.map(Number).join(',') + ')&select=id_superlogica,nome');
      if (r.status === 200 && Array.isArray(r.body)) r.body.forEach((c) => m.set(String(c.id_superlogica), c.nome));
    } catch (e) { console.warn('[regras comparar nomes] ' + (e && e.message)); }
    return m;
  }
  // Condomínios que têm documento no acervo (lista curta de ids distintos).
  async function comAcervo() {
    const r = await banco('GET', '/rest/v1/regras_documentos?id_superlogica=not.is.null&select=id_superlogica&order=id_superlogica.asc&limit=10000');
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('acervo_falhou_' + r.status);
    return [...new Set(r.body.map((d) => String(d.id_superlogica)))];
  }

  // Lista da comparação: os ids pedidos (só os da carteira) ou, sem ids, a carteira inteira;
  // quem vê todas as carteiras fica com os condomínios que têm acervo. Condomínio com acervo
  // vem primeiro e a lista para em 40. Devolve { ids, fora, total } ou null (já respondeu).
  async function idsDaComparacao(req, res) {
    let esc;
    try { esc = await carteiraT18.escopo(req); } catch (e) {
      res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' });
      return null;
    }
    const pedidos = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
    if (pedidos && pedidos.some((x) => !ID_SL.test(String(x)))) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
    const acervo = await comAcervo();
    const temAcervo = new Set(acervo);
    let base;
    let fora = 0;
    if (pedidos && pedidos.length) {
      const unicos = [...new Set(pedidos.map(String))];
      base = esc.todas ? unicos : unicos.filter((id) => esc.ids.has(Number(id)));
      fora = unicos.length - base.length;
    } else {
      base = esc.todas ? acervo : [...esc.ids].map(String);
    }
    base.sort((a, b) => (temAcervo.has(b) ? 1 : 0) - (temAcervo.has(a) ? 1 : 0));
    return { ids: base.slice(0, consulta.MAX_COMPARAR), fora, total: base.length };
  }

  // POST /api/regras/:idSuperlogica/perguntar { pergunta }
  app.post('/api/regras/:idSuperlogica/perguntar', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!(await exigir(req, res, 'consultar'))) return;
    if (!(await exigirCarteira(req, res, id))) return;
    const pergunta = lerPergunta(req, res); if (!pergunta) return;
    if (!limite(req, res, 'perguntar')) return;
    try {
      const r = await consulta.responder(depsModelo(req), Number(id), pergunta);
      auditoria.evento(req, 'regras_pergunta', { id_superlogica: id, pergunta: pergunta.slice(0, 300), achou: !r.nao_encontrado, fundamentos: r.fundamentos.length, recusados: r.recusados_qtd });
      res.json(r);
    } catch (e) { erroInterno(res, 'perguntar ' + id, e); }
  });

  // POST /api/regras/comparar { pergunta, ids? }
  app.post('/api/regras/comparar', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await exigir(req, res, 'consultar'))) return;
    const pergunta = lerPergunta(req, res); if (!pergunta) return;
    try {
      const L = await idsDaComparacao(req, res); if (!L) return;
      if (!L.ids.length) return res.json({ linhas: [], total: 0, comparados: 0, fora_da_carteira: L.fora });
      if (!limite(req, res, 'comparar')) return;
      const nomes = await nomesDe(L.ids);
      const r = await consulta.comparar(depsModelo(req), L.ids, pergunta, { nomes });
      auditoria.evento(req, 'regras_comparacao', { pergunta: pergunta.slice(0, 300), condominios: L.ids.length, recusados: r.recusados_qtd });
      res.json({ linhas: r.linhas, total: L.total, comparados: L.ids.length, fora_da_carteira: L.fora, recusados_qtd: r.recusados_qtd });
    } catch (e) { erroInterno(res, 'comparar', e); }
  });

  // GET /api/regras/:idSuperlogica/faq
  app.get('/api/regras/:idSuperlogica/faq', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!(await exigir(req, res, 'ver'))) return;
    if (!(await exigirCarteira(req, res, id))) return;
    try {
      const itens = await faq.listarFaq({ banco }, Number(id));
      res.json({ itens, pode_gerar: await pode(req, 'gerenciar'), gerando: gerandoFaq.has(id) });
    } catch (e) { erroInterno(res, 'faq ' + id, e); }
  });

  // POST /api/regras/:idSuperlogica/faq/gerar
  app.post('/api/regras/:idSuperlogica/faq/gerar', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!(await exigir(req, res, 'gerenciar'))) return;
    if (!(await exigirCarteira(req, res, id))) return;
    if (gerandoFaq.has(id)) return res.status(409).json({ erro: 'em_andamento', detalhe: 'As perguntas frequentes deste condomínio já estão sendo atualizadas.' });
    if (!limite(req, res, 'faq')) return;
    gerandoFaq.add(id);
    try {
      const r = await faq.gerarFaq(depsModelo(req), Number(id));
      auditoria.evento(req, 'regras_faq_gerado', { id_superlogica: id, gravados: r.gravados, sem_fundamento: r.sem_fundamento.length, falhas: r.falhas.length });
      const itens = await faq.listarFaq({ banco }, Number(id));
      res.json({ gravados: r.gravados, sem_fundamento: r.sem_fundamento, falhas: r.falhas.length, itens });
    } catch (e) { erroInterno(res, 'faq gerar ' + id, e); } finally { gerandoFaq.delete(id); }
  });
}

module.exports = { criarRotasConsulta };
