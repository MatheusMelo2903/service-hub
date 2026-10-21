'use strict';
// T38: rotas do Fechamento do mês e da conferência dos anexos (dentro do item Financeiro).
// Travas de todas (falha fechada, conferidas no servidor): módulo financeiro, acesso ao
// Superlógica, carteira e escopo do condomínio. Fechamento e marca exigem também a ação
// pre_balancete e os módulos dos itens que ele junta (boletos e conciliacao), porque mostra o
// resumo deles. Só GET no Superlógica. A única gravação é a marca manual de conferido e o
// status calculado, nas tabelas fin_* do Supabase de TESTE (trava em financeiro/banco.js).
const anexosConf = require('../financeiro/anexos-conferencia');
const fechamento = require('../financeiro/fechamento');
const { criarBanco } = require('../financeiro/banco');

const ESPERA_ROTA = 25000;
const NAO_CONDOMINIOS = anexosConf.NAO_CONDOMINIOS;
const hojeSP = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const ID = /^[1-9][0-9]{0,8}$/;
const MOTIVO_429 = {
  ocupado: 'Há muitas conferências de anexos rodando agora. Tente de novo em alguns minutos.',
  limite_usuario: 'Você pediu muitas conferências de anexos nesta hora. Tente mais tarde.',
};

function criarRotasFechamento(app, d) {
  const { requireAuth, express, exigirFinanceiro, exigirModuloItem, exigirLeituraSuperlogica, exigirCarteira, exigirEscopoFinanceiro, escopoFinanceiro,
    gruposCarteiras, clienteSL, credSL, painelFin, conciliacao, boletos, dentroDoLimite, auditoria, processar, linkDe, supabase } = d;
  const hoje = d.hoje || hojeSP;

  let _banco; // undefined = ainda não tentou; null = fora do teste ou sem chave
  function banco() {
    if (_banco !== undefined) return _banco;
    try { _banco = criarBanco({ url: supabase.url, chave: supabase.chave }); } catch (e) { _banco = null; }
    return _banco;
  }
  const anexos = anexosConf.criarConferenciaAnexos({ cliente: () => clienteSL(), cred: () => credSL(), banco, linkDe });
  const statusMem = new Map(); // id|competencia -> resumo do último fechamento calculado

  function ctxDe(req) {
    return {
      lerInterna: (arquivo) => processar.processarDocumentoFinanceiro({ arquivo }, req.user && req.user.sub),
      podeInterna: () => dentroDoLimite(req, 'anexo_interna', 120),
      // Conferência nova de anexos (lista de despesas e downloads): até 40 por usuário por hora.
      podeIniciar: () => {
        const ok = dentroDoLimite(req, 'anexos_conferir', 40);
        if (!ok) { try { auditoria.evento(req, 'limite_processamento', { tipo: 'anexos_conferir' }, true, 'volume_alto'); } catch (e) { /* segue */ } }
        return ok;
      },
      auditar: (acao, det, susp, motivo) => { try { auditoria.evento(req, acao, det, susp, motivo); } catch (e) { /* segue */ } },
    };
  }
  function validar(req, res) {
    const id = String(req.params.idSuperlogica || '');
    if (!ID.test(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
    if (NAO_CONDOMINIOS.has(id)) { res.status(400).json({ erro: 'nao_condominio', detalhe: 'Esse cadastro não é um condomínio.' }); return null; }
    const comp = anexosConf.competencia(String((req.query && req.query.competencia) || (req.body && req.body.competencia) || ''));
    if (!comp) { res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe o mês no formato AAAA-MM.' }); return null; }
    if (comp.inicio > hoje()) { res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Escolha um mês que já começou.' }); return null; }
    return { id, comp };
  }
  // Travas comuns. completo: fechamento e marca (pre_balancete, boletos e conciliacao).
  async function travas(req, res, id, completo) {
    if (!(await exigirFinanceiro(req, res, 'pre_balancete'))) return null;
    if (completo) {
      if (!(await exigirModuloItem(req, res, 'boletos'))) return null;
      if (!(await exigirModuloItem(req, res, 'conciliacao'))) return null;
    }
    if (!(await exigirLeituraSuperlogica(req, res))) return null;
    if (!(await exigirCarteira(req, res, id))) return null;
    return exigirEscopoFinanceiro(req, res, id);
  }

  // GET /api/financeiro/condominio/:id/anexos?competencia=AAAA-MM[&forcar=1]
  // Conferência dos anexos das despesas pagas no mês. 202 enquanto confere (a tela tenta de novo).
  app.get('/api/financeiro/condominio/:idSuperlogica/anexos', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = validar(req, res); if (!v) return;
    const acesso = await travas(req, res, v.id, false); if (!acesso) return;
    try {
      const s = anexos.estado(v.id, v.comp.rotulo, ctxDe(req), req.query.forcar === '1');
      if (s.calculando) return res.status(202).json({ calculando: true, feitos: s.feitos, total: s.total, desde: s.desde, detalhe: 'Conferindo os anexos. A tela tenta de novo sozinha.' });
      res.json(anexosConf.paraTela(s.resultado, acesso.escopo !== null));
    } catch (e) {
      if (e && e.status === 400) return res.status(400).json({ erro: 'competencia_invalida', detalhe: e.message === 'competencia_antiga' ? 'A conferência dos anexos vai até 24 meses para trás.' : 'Escolha um mês que já começou.' });
      if (e && e.status === 429) return res.status(429).json({ erro: 'limite', detalhe: MOTIVO_429[e.message] || MOTIVO_429.ocupado });
      console.warn('[anexos] ' + v.id + ' ' + v.comp.rotulo + ' falhou: ' + (e && e.message));
      res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível conferir os anexos agora. Tente de novo em alguns minutos.' });
    }
  });

  async function lerMarcas(id, comp) {
    const b = banco();
    if (!b) return { disponivel: false, marcas: {} };
    const linhas = await b.ler('fin_fechamento_marca?select=item,ativo,pendencias,chaves,observacao,marcado_por_email,marcado_em&id_superlogica=eq.' + id + '&competencia=eq.' + comp);
    const marcas = {};
    (linhas || []).forEach((l) => { if (l.ativo) marcas[l.item] = l; });
    return { disponivel: true, marcas };
  }
  const semErro = (p) => p.then((v) => v, (e) => ({ erro: (e && e.message) || 'falha' }));

  // Junta os cinco itens. Devolve null se ainda não terminou em ESPERA_ROTA (as leituras seguem
  // em segundo plano, nos caches de cada módulo, e a próxima chamada pega pronto).
  async function calcular(req, id, comp, forcar) {
    const ctx = ctxDe(req);
    const anx = (() => { try { return anexos.estado(id, comp.rotulo, ctx, forcar); } catch (e) { return { erro: e.message, motivo: MOTIVO_429[e.message] || (e.message === 'competencia_antiga' ? 'A conferência dos anexos vai até 24 meses para trás.' : '') }; } })();
    const todos = Promise.all([
      semErro(Promise.resolve().then(() => painelFin.preBalancete(id, comp.rotulo, forcar))),
      semErro(Promise.resolve().then(() => conciliacao.condominio(id, comp.rotulo, forcar))),
      semErro(Promise.resolve().then(() => boletos(id, comp.rotulo, forcar))),
      semErro(lerMarcas(id, comp.rotulo)),
    ]);
    const r = await Promise.race([todos, new Promise((ok) => setTimeout(() => ok(null), ESPERA_ROTA))]);
    if (!r) return null;
    const [pre, conc, bol, marcas] = r;
    // Anexos ainda conferindo: espera um pouco mais dentro do mesmo tempo da rota.
    const anx2 = anx.calculando ? await anexos.aguardar(id, comp.rotulo, ctx, 3000).catch((e) => ({ erro: e.message })) : anx;
    const f = fechamento.montarFechamento({ comp, hoje: hoje(), pre, conc, boletos: bol, anexos: anx2, marcas: marcas.erro ? {} : marcas.marcas });
    f.condominio = id;
    f.nome = (conc && conc.nome) || (pre && pre.nome) || '';
    f.marcas_disponiveis = !marcas.erro && marcas.disponivel;
    f.gerado_em = new Date().toISOString();
    return f;
  }
  function guardarStatus(f) {
    const resumo = { id_superlogica: Number(f.condominio), competencia: f.competencia, pronto: f.pronto, falta: f.falta,
      itens: f.itens.map((i) => ({ chave: i.chave, situacao: i.situacao })), calculado_em: f.gerado_em };
    statusMem.set(f.condominio + '|' + f.competencia, resumo);
    if (statusMem.size > 3000) statusMem.delete(statusMem.keys().next().value);
    const b = banco();
    if (b && !f.calculando) b.upsert('fin_fechamento_status', [resumo], 'id_superlogica,competencia').catch((e) => console.warn('[fechamento] status não gravado: ' + (e && e.message)));
  }

  // GET /api/financeiro/condominio/:id/fechamento?competencia=AAAA-MM[&forcar=1]
  // Checklist do fechamento: cada item com o que trava e onde resolver; status pronto ou falta X.
  app.get('/api/financeiro/condominio/:idSuperlogica/fechamento', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = validar(req, res); if (!v) return;
    if (!(await travas(req, res, v.id, true))) return;
    try {
      const f = await calcular(req, v.id, v.comp, req.query.forcar === '1');
      if (!f) return res.status(202).json({ calculando: true, detalhe: 'Lendo a conciliação, o pré balancete, os boletos e os anexos. A tela tenta de novo sozinha.' });
      guardarStatus(f);
      res.json(f);
    } catch (e) {
      console.warn('[fechamento] ' + v.id + ' ' + v.comp.rotulo + ' falhou: ' + (e && e.message));
      res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível montar o fechamento agora. Tente de novo em alguns minutos.' });
    }
  });

  // POST /api/financeiro/condominio/:id/fechamento/marcar { competencia, item, conferido, observacao }
  // Marca (ou desmarca) um item como conferido à mão. O servidor guarda quantas pendências havia
  // (lidas por ele, não pela tela): se aparecer pendência nova depois, a marca perde a validade.
  app.post('/api/financeiro/condominio/:idSuperlogica/fechamento/marcar', requireAuth, express.json({ limit: '5kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = validar(req, res); if (!v) return;
    const b0 = req.body || {};
    const itemNome = String(b0.item || '');
    if (!fechamento.ITENS_MARCAVEIS.includes(itemNome)) return res.status(400).json({ erro: 'item_invalido', detalhe: 'Esse item não aceita marca manual.' });
    if (typeof b0.conferido !== 'boolean') return res.status(400).json({ erro: 'conferido_invalido', detalhe: 'Informe se o item foi conferido.' });
    const obs = String(b0.observacao || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    if (!(await travas(req, res, v.id, true))) return;
    const b = banco();
    if (!b) return res.status(503).json({ erro: 'marca_indisponivel', detalhe: 'Marcar como conferido só está liberado no ambiente de teste por enquanto.' });
    // Pendências e chaves lidas pelo servidor (não pela tela): a marca só vale para elas.
    let pendencias = 0, chaves = null;
    try {
      if (itemNome === 'pre_balancete') {
        const pre = await painelFin.preBalancete(v.id, v.comp.rotulo, false);
        pendencias = pre.pendencias || 0; chaves = fechamento.chavesPendencias('pre_balancete', pre);
      } else if (itemNome === 'boletos') {
        const bol = await boletos(v.id, v.comp.rotulo, false);
        pendencias = (bol.resumo || {}).alertas || 0; chaves = bol.resumo && bol.resumo.boletos ? fechamento.chavesPendencias('boletos', bol) : [];
      } else {
        const s = anexos.estado(v.id, v.comp.rotulo, ctxDe(req), false);
        if (!s.pronto) return res.status(409).json({ erro: 'calculando', detalhe: 'Espere terminar a conferência dos anexos para marcar.' });
        const rs = s.resultado.resumo;
        if (rs.falhas) return res.status(409).json({ erro: 'falhas', detalhe: 'Há anexos que não deu para baixar ou ler. Atualize a conferência antes de marcar.' });
        pendencias = (rs.para_conferir || 0) + (rs.escaneados_nao_lidos || 0) + (s.resultado.sem_cnpj_cadastro ? 1 : 0);
        chaves = fechamento.chavesPendencias('anexos', s.resultado);
      }
    } catch (e) {
      if (e && e.status === 429) return res.status(429).json({ erro: 'limite', detalhe: MOTIVO_429[e.message] || MOTIVO_429.ocupado });
      return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível conferir o item agora. Tente de novo em instantes.' });
    }
    const linha = { id_superlogica: Number(v.id), competencia: v.comp.rotulo, item: itemNome, ativo: b0.conferido, pendencias, chaves, observacao: obs || null,
      marcado_por: (req.user && req.user.sub) || null, marcado_por_email: (req.user && req.user.email) || null, marcado_em: new Date().toISOString() };
    try { await b.upsert('fin_fechamento_marca', [linha], 'id_superlogica,competencia,item'); } catch (e) {
      console.warn('[fechamento] marca não gravada: ' + (e && e.message));
      return res.status(502).json({ erro: 'falha_banco', detalhe: 'Não foi possível gravar a marca agora.' });
    }
    auditoria.evento(req, b0.conferido ? 'fechamento_marcado' : 'fechamento_desmarcado', { id_superlogica: v.id, competencia: v.comp.rotulo, item: itemNome, pendencias });
    statusMem.delete(v.id + '|' + v.comp.rotulo);
    res.json({ ok: true, item: itemNome, conferido: b0.conferido, pendencias, marcado_em: linha.marcado_em });
  });

  // GET /api/financeiro/fechamento/quadro?competencia=AAAA-MM[&carteira=<id do grupo>]
  // Coluna Fechamento do quadro da carteira: último status calculado de cada condomínio (não lê
  // o Superlógica de novo; quem não foi calculado aparece sem status e a tela oferece calcular).
  app.get('/api/financeiro/fechamento/quadro', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const comp = anexosConf.competencia(String(req.query.competencia || ''));
    if (!comp) return res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe o mês no formato AAAA-MM.' });
    const carteira = String(req.query.carteira || '');
    if (carteira && !ID.test(carteira)) return res.status(400).json({ erro: 'carteira_invalida', detalhe: 'Carteira inválida.' });
    if (!(await exigirFinanceiro(req, res, 'ver'))) return;
    if (!(await exigirLeituraSuperlogica(req, res))) return;
    let escopo;
    try { escopo = await escopoFinanceiro(req); } catch (e) {
      return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' });
    }
    let ids = escopo;
    if (carteira) {
      let grupo = null;
      try { grupo = (await gruposCarteiras()).find((g) => String(g.id) === carteira); } catch (e) {
        return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as carteiras agora.' });
      }
      if (!grupo) return res.status(404).json({ erro: 'carteira_nao_encontrada', detalhe: 'Essa carteira não existe mais.' });
      const daCarteira = new Set((grupo.condominios || []).map(String));
      ids = escopo ? new Set([...daCarteira].filter((x) => escopo.has(x))) : daCarteira;
    }
    const out = {};
    const b = banco();
    if (b) {
      try {
        let filtro = '';
        if (ids) {
          const lista = [...ids].filter((x) => ID.test(x));
          if (!lista.length) return res.json({ competencia: comp.rotulo, condominios: {} });
          filtro = '&id_superlogica=in.(' + lista.slice(0, 500).join(',') + ')';
        }
        const linhas = await b.ler('fin_fechamento_status?select=id_superlogica,pronto,falta,calculado_em&competencia=eq.' + comp.rotulo + filtro + '&limit=1000');
        (linhas || []).forEach((l) => { out[String(l.id_superlogica)] = { pronto: l.pronto, falta: l.falta || [], calculado_em: l.calculado_em }; });
      } catch (e) { console.warn('[fechamento] quadro sem banco: ' + (e && e.message)); }
    }
    statusMem.forEach((s, k) => {
      const [id, c] = k.split('|');
      if (c !== comp.rotulo || (ids && !ids.has(id))) return;
      const atual = out[id];
      if (!atual || String(atual.calculado_em) < String(s.calculado_em)) out[id] = { pronto: s.pronto, falta: s.falta, calculado_em: s.calculado_em };
    });
    res.json({ competencia: comp.rotulo, condominios: out });
  });

  return { anexos };
}

module.exports = { criarRotasFechamento };
