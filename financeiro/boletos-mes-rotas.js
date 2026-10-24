'use strict';
// Rotas dos Boletos do mês (item Boletos do menu). Travas de todas, no servidor e com falha fechada:
// módulos financeiro e boletos (ver), acesso ao Superlógica, carteira e escopo do condomínio.
// Gravar no Superlógica (composição, remessa, régua): além das travas, GESTOR, GERENTE ou a ação
// boletos.preparar, e sempre pela política única (servico/escrita-superlogica.js): livre só no
// condomínio de teste; fora dele, confirmação da pessoa (reforçada na composição e na régua).
// Nunca chama arrecadacoes/processar: gerar o lote continua sendo o clique da pessoa no Superlógica.
//
// GET  /api/financeiro/boletos-mes/calendario[?competencia=AAAA-MM][&forcar=1]        202 enquanto lê
// GET  /api/financeiro/boletos-mes/:id/composicao?competencia=AAAA-MM
// POST /api/financeiro/boletos-mes/:id/composicao/previa   { competencia, itens }      (só confere)
// POST /api/financeiro/boletos-mes/:id/composicao/gravar   { competencia, itens, confirmacao_gravacao? }
// POST /api/financeiro/boletos-mes/:id/composicao/excluir  { competencia, id_composicao, confirmacao_gravacao? }
// GET  /api/financeiro/boletos-mes/:id/conferencia-antes?competencia=AAAA-MM[&forcar=1] 202 enquanto lê
// GET  /api/financeiro/boletos-mes/:id/remessa
// POST /api/financeiro/boletos-mes/:id/remessa/gerar       { id_conta, confirmacao_gravacao? }
// GET  /api/financeiro/boletos-mes/:id/regua
// POST /api/financeiro/boletos-mes/:id/regua/aplicar       { confirmacao_gravacao? }
// GET  /api/financeiro/boletos-mes/:id/pjbank[?dias=60][&forcar=1]                      202 enquanto lê
const https = require('https');
const M = require('./boletos-mes');
const { criarBanco } = require('./banco');

const ID = /^[1-9][0-9]{0,8}$/;
const TTL_CAL = 10 * 60 * 1000;
const TTL_CONF = 5 * 60 * 1000;
const TTL_PJ = 30 * 60 * 1000;
const ESPERA = 15000;
const SIMULTANEAS = 2;

// Pedido de gravação ao Superlógica com as chaves do servidor. Devolve { status, json, texto }.
function criarEnvio(cred) {
  return function enviar(metodo, caminho, query, corpo) {
    return new Promise((resolve) => {
      const c = cred();
      const url = new URL(c.base + '/v2/condor/' + caminho);
      Object.entries(query || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
      const dados = Buffer.from(corpo ? new URLSearchParams(Object.entries(corpo).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString() : '', 'utf8');
      const r = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: metodo,
        headers: { app_token: c.appToken, access_token: c.accessToken, accept: 'application/json, text/plain', 'content-type': 'application/x-www-form-urlencoded', 'content-length': dados.length } }, (resp) => {
        const partes = []; let tam = 0;
        resp.on('data', (b) => { tam += b.length; if (tam <= 5 * 1024 * 1024) partes.push(b); });
        resp.on('error', () => resolve({ status: 0, json: null, texto: '' }));
        resp.on('end', () => {
          const texto = Buffer.concat(partes).toString('latin1').replace(/^﻿/, '');
          let json = null;
          try { json = JSON.parse(Buffer.concat(partes).toString('utf8').replace(/^﻿/, '')); } catch (e) { json = null; }
          resolve({ status: resp.statusCode, json, texto: json ? '' : texto });
        });
      });
      r.setTimeout(60000, () => { r.destroy(); resolve({ status: 504, json: null, texto: '' }); });
      r.on('error', () => resolve({ status: 0, json: null, texto: '' }));
      r.end(dados);
    });
  };
}

// Fila: no máximo n leituras ao mesmo tempo no Superlógica.
function criarFila(n) {
  let ativos = 0; const espera = [];
  const proximo = () => { if (ativos >= n || !espera.length) return; ativos++; const [fn, ok, falha] = espera.shift(); fn().then(ok, falha).finally(() => { ativos--; proximo(); }); };
  return (fn) => new Promise((ok, falha) => { espera.push([fn, ok, falha]); proximo(); });
}

// d: { app, express, requireAuth, exigirFinanceiro, exigirModuloItem, exigirLeituraSuperlogica, exigirCarteira, exigirEscopo,
//      escopoFinanceiro, lerPerfil, clienteSL, cred, politica, supabase: { url, chave } | banco, auditar, hoje?, enviar?, log? }
function registrar(d) {
  const { app, express, requireAuth, politica } = d;
  const hoje = d.hoje || M.hojeSP;
  const log = d.log || ((m) => console.warn(m));
  const enviar = d.enviar || criarEnvio(d.cred);
  const fila = criarFila(SIMULTANEAS);
  const cliente = () => { const c = d.clienteSL(); return { get: (a, p) => fila(() => c.get(a, p)) }; };
  let _banco = d.banco;
  const banco = () => {
    if (_banco !== undefined) return _banco;
    try { _banco = criarBanco({ url: d.supabase && d.supabase.url, chave: d.supabase && d.supabase.chave }); } catch (e) { _banco = null; }
    return _banco;
  };
  const auditar = (req, acao, det) => { try { if (d.auditar) d.auditar(req, acao, det); } catch (e) { /* segue */ } };
  const falhaSL = (res, e, rotulo) => {
    log('[boletos-mes] ' + rotulo + ' falhou: ' + (e && (e.message || e.status)));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler o Superlógica agora. Tente de novo em alguns minutos.' });
  };

  // Travas de leitura comuns. Devolve { id } (ou {} na rota sem condomínio) ou null (já respondeu).
  async function travas(req, res, comCondominio) {
    res.set('Cache-Control', 'no-store');
    let id = null;
    if (comCondominio) {
      id = String(req.params.idSuperlogica || '');
      if (!ID.test(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
      if (M.NAO_CONDOMINIOS.has(id)) { res.status(400).json({ erro: 'nao_condominio', detalhe: 'Esse cadastro não é um condomínio.' }); return null; }
    }
    if (!(await d.exigirFinanceiro(req, res, 'ver'))) return null;
    if (!(await d.exigirModuloItem(req, res, 'boletos', 'ver'))) return null;
    if (!(await d.exigirLeituraSuperlogica(req, res))) return null;
    if (comCondominio) {
      if (!(await d.exigirCarteira(req, res, id))) return null;
      if (!(await d.exigirEscopo(req, res, id))) return null;
    }
    return { id };
  }
  function compDe(res, v, padrao) {
    const c = M.competencia(v || padrao);
    if (!c) { res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe o mês do vencimento no formato AAAA-MM.' }); return null; }
    return c;
  }
  // Quem pode gravar no Superlógica por esta tela. Devolve { id, email } ou null (já respondeu 403 ou 503).
  async function quemGrava(req, res) {
    if (req.authMode === 'internal') return { id: null, email: 'interno' };
    let p = null;
    try { p = await d.lerPerfil(req.user && req.user.sub); } catch (e) {
      res.status(503).json({ erro: 'permissao_indisponivel', detalhe: 'Não foi possível conferir suas permissões agora. Nada foi gravado.' }); return null;
    }
    const acao = p && p.permissoes && p.permissoes.boletos && Array.isArray(p.permissoes.boletos.acoes) && p.permissoes.boletos.acoes.includes('preparar');
    if (p && (p.role === 'GESTOR' || p.role === 'GERENTE' || acao)) return { id: String(req.user.sub), email: String(p.email || '').slice(0, 120) };
    res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não pode gravar no Superlógica por esta tela. Peça ao gestor.' });
    return null;
  }
  const estado = (op, id) => (politica ? politica.estado(op, id) : { estado: 'bloqueado' });
  const liberado = (op, id) => { const s = estado(op, id); return { liberada: s.estado !== 'bloqueado', confirmacao: s.estado === 'confirmacao' || s.estado === 'reforcada' ? s.estado : null }; };

  // Cálculo em segundo plano com cache: devolve o resultado ou null (a rota responde 202).
  function criarCache(ttl) {
    const m = new Map();
    return async function obter(chave, forcar, fn) {
      let c = m.get(chave);
      if (c && c.resultado && forcar && Date.now() - c.criado > 60000) c = null;
      if (c && c.resultado && c.ate < Date.now()) c = null;
      if (!c) {
        c = { criado: Date.now(), ate: Date.now() + ttl, resultado: null, erro: null };
        c.promessa = Promise.resolve().then(fn).then((r) => { c.resultado = r; c.ate = Date.now() + ttl; return r; }).catch((e) => { c.erro = e; if (m.get(chave) === c) m.delete(chave); throw e; });
        c.promessa.catch(() => {});
        m.set(chave, c);
        if (m.size > 300) m.delete(m.keys().next().value);
      }
      if (c.resultado) return c.resultado;
      const r = await Promise.race([c.promessa, new Promise((ok) => setTimeout(() => ok(null), ESPERA))]);
      return r;
    };
  }
  const cacheCal = criarCache(TTL_CAL);
  const cacheConf = criarCache(TTL_CONF);
  const cachePj = criarCache(TTL_PJ);
  const calculando = (res, txt) => res.status(202).json({ calculando: true, detalhe: txt || 'Lendo o Superlógica. A tela tenta de novo sozinha.' });

  // ── 1. Calendário ──
  app.get('/api/financeiro/boletos-mes/calendario', requireAuth, async (req, res) => {
    const t = await travas(req, res, false);
    if (!t) return;
    const comp = req.query.competencia ? compDe(res, req.query.competencia) : null;
    if (req.query.competencia && !comp) return;
    let escopo;
    try { escopo = await d.escopoFinanceiro(req); } catch (e) { return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' }); }
    const h = hoje();
    try {
      const base = await cacheCal('cal|' + (comp ? comp.chave : 'proximo') + '|' + h, req.query.forcar === '1', async () => {
        const cli = cliente();
        const conds = await M.lerCondominios(cli);
        const lotes = new Map();
        await Promise.all(conds.filter((c) => c.dia).map(async (c) => {
          const alvo = comp ? { comp } : M.proximoVencimento(c.dia, h);
          try {
            const lote = await M.loteDoMes(cli, c.id, alvo.comp);
            // Sem lote no mês: o mês anterior diz se o cadastro emite lote mensal pelo Superlógica.
            if (!lote.gerado) lote.anterior = (await M.loteDoMes(cli, c.id, M.somarMeses(alvo.comp, -1))).gerado;
            lotes.set(c.id, lote);
          } catch (e) { lotes.set(c.id, { erro: true }); }
        }));
        return { conds, lotes, gerado_em: new Date().toISOString() };
      });
      if (!base) return calculando(res, 'Lendo o vencimento e o lote de cada condomínio (leva cerca de 1 minuto). A tela tenta de novo sozinha.');
      const conds = escopo ? base.conds.filter((c) => escopo.has(c.id)) : base.conds;
      res.json(Object.assign(M.montarCalendario(conds, base.lotes, h, comp), { lido_em: base.gerado_em }));
    } catch (e) { falhaSL(res, e, 'calendario'); }
  });

  // ── 2. Composição ──
  async function itensDoHub(id, comp) {
    const b = banco();
    if (!b) return [];
    try { const r = await b.ler('fin_boletos_itens?select=id_composicao,competencia,descricao,valor,meses,status,criado_por_email,criado_em&id_superlogica=eq.' + id + '&competencia=eq.' + comp.chave + '&order=criado_em.desc&limit=200'); return Array.isArray(r) ? r : []; }
    catch (e) { log('[boletos-mes] leitura fin_boletos_itens falhou'); return []; }
  }
  app.get('/api/financeiro/boletos-mes/:idSuperlogica/composicao', requireAuth, async (req, res) => {
    const t = await travas(req, res, true);
    if (!t) return;
    const comp = compDe(res, req.query.competencia);
    if (!comp) return;
    try {
      const cli = cliente();
      const [composicoes, contas, hub] = await Promise.all([M.lerComposicoes(cli, t.id, comp), M.lerContas(cli, t.id), itensDoHub(t.id, comp)]);
      res.json({ competencia: comp.chave, composicoes, contas, itens_do_hub: hub, tipos: M.TIPOS_ITEM, gravacao: liberado('boleto_composicao', t.id),
        aviso: 'Rateio por fração ideal e mudança de valor da taxa continuam na tela do Superlógica.' });
    } catch (e) { falhaSL(res, e, 'composicao ' + t.id); }
  });

  // Confere os itens pedidos. Devolve { itens, avisos, atuais } ou null (já respondeu).
  async function conferirPedido(req, res, id, comp) {
    const lista = req.body && Array.isArray(req.body.itens) ? req.body.itens : null;
    if (!lista || !lista.length) { res.status(400).json({ erro: 'sem_itens', detalhe: 'Inclua pelo menos um item.' }); return null; }
    if (lista.length > M.MAX_ITENS) { res.status(400).json({ erro: 'itens_demais', detalhe: 'No máximo ' + M.MAX_ITENS + ' itens por vez.' }); return null; }
    const cli = cliente();
    let contas, atuais;
    try { [contas, atuais] = await Promise.all([M.lerContas(cli, id), M.lerComposicoes(cli, id, comp)]); } catch (e) { falhaSL(res, e, 'conferir itens ' + id); return null; }
    const itens = [];
    for (let k = 0; k < lista.length; k++) {
      const v = M.validarItem(lista[k], contas);
      if (v.erro) { res.status(400).json({ erro: 'item_invalido', indice: k, detalhe: 'Item ' + (k + 1) + ': ' + v.erro }); return null; }
      itens.push(v.item);
    }
    // Item de uma unidade: a unidade precisa ser deste condomínio.
    if (itens.some((i) => i.tipo === 'item_unidade')) {
      let unidades;
      try { unidades = await M.lerUnidades(cli, id); } catch (e) { falhaSL(res, e, 'unidades ' + id); return null; }
      const k = itens.findIndex((i) => i.tipo === 'item_unidade' && !unidades.has(i.id_unidade));
      if (k >= 0) { res.status(400).json({ erro: 'unidade_de_outro_condominio', indice: k, detalhe: 'Item ' + (k + 1) + ': essa unidade não é deste condomínio.' }); return null; }
    }
    return { itens, avisos: M.conferirItensNovos(itens, atuais), atuais };
  }
  app.post('/api/financeiro/boletos-mes/:idSuperlogica/composicao/previa', requireAuth, express.json({ limit: '32kb' }), async (req, res) => {
    const t = await travas(req, res, true);
    if (!t) return;
    const comp = compDe(res, req.body && req.body.competencia);
    if (!comp) return;
    const p = await conferirPedido(req, res, t.id, comp);
    if (!p) return;
    res.json({ competencia: comp.chave, itens: p.itens.map((i) => Object.assign({ texto: M.descreverItem(i, comp) }, i)), avisos: p.avisos, pode_gravar: !p.avisos.some((a) => a.gravidade === 'alta'), gravacao: liberado('boleto_composicao', t.id) });
  });

  app.post('/api/financeiro/boletos-mes/:idSuperlogica/composicao/gravar', requireAuth, express.json({ limit: '32kb' }), async (req, res) => {
    const t = await travas(req, res, true);
    if (!t) return;
    const comp = compDe(res, req.body && req.body.competencia);
    if (!comp) return;
    if (!politica) return res.status(503).json({ erro: 'politica_indisponivel', detalhe: 'A gravação no Superlógica está indisponível agora. Nada foi gravado.' });
    const qtd = Array.isArray(req.body && req.body.itens) ? req.body.itens.length : 0;
    if (politica.bloqueada(req, res, 'boleto_composicao', t.id, { quantidade: qtd })) return;
    const quem = await quemGrava(req, res);
    if (!quem) return;
    const b = banco();
    if (!b) return res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'O registro dos itens do Hub está indisponível neste ambiente. Nada foi gravado.' });
    const p = await conferirPedido(req, res, t.id, comp);
    if (!p) return;
    if (p.avisos.some((a) => a.gravidade === 'alta')) return res.status(409).json({ erro: 'conferencia_reprovada', detalhe: 'Há item repetido. Corrija a lista antes de gravar. Nada foi gravado.', avisos: p.avisos });
    const aut = await politica.autorizar(req, res, { operacao: 'boleto_composicao', id_condominio: t.id, quantidade: p.itens.length, sensivel: true,
      conteudo: { competencia: comp.chave, itens: p.itens },
      resumo: { linhas: [{ rotulo: 'Mês do vencimento', valor: comp.rotulo }].concat(p.itens.slice(0, 12).map((i, k) => ({ rotulo: 'Item ' + (k + 1), valor: M.descreverItem(i, comp) })))
        .concat(p.itens.length > 12 ? [{ rotulo: 'E mais', valor: (p.itens.length - 12) + ' itens' }] : [])
        .concat([{ rotulo: 'O que acontece', valor: 'Os itens entram na composição do mês no Superlógica. Nenhum boleto é gerado: a geração continua com você, depois da conferência.' }]) } });
    if (!aut) return;
    const resultados = [];
    for (const item of p.itens) {
      const r = await enviar('POST', 'arrecadacoes/put', null, M.corpoComposicao(t.id, comp, item));
      const c = M.corpoOk(r);
      const idc = c.ok && c.item && c.item.data && /^\d+$/.test(String(c.item.data.id_composicao_cot || '')) ? String(c.item.data.id_composicao_cot) : null;
      resultados.push({ item, id_composicao: idc, ok: !!idc, incerto: !idc && (r.status === 504 || r.status === 0), msg: c.msg });
      if (!idc && !(r.status === 504 || r.status === 0)) break; // erro de regra: para e não segue gravando
    }
    // Prova: relê a composição do mês e confere cada item criado.
    let relidos = null;
    try { relidos = await M.lerComposicoes(cliente(), t.id, comp); } catch (e) { relidos = null; }
    const agora = new Date().toISOString();
    const linhas = [];
    resultados.forEach((x) => {
      if (!x.id_composicao) return;
      const achou = relidos ? relidos.find((a) => a.id === x.id_composicao) : null;
      x.conferido = !!(achou && Math.abs(achou.valor - x.item.valor) < 0.005);
      linhas.push({ id_composicao: Number(x.id_composicao), id_superlogica: Number(t.id), competencia: comp.chave, tipo: x.item.tipo, conta: x.item.conta, descricao: x.item.complemento,
        valor: x.item.valor, meses: x.item.meses, boleto: x.item.boleto, id_unidade: x.item.id_unidade ? Number(x.item.id_unidade) : null, id_conta: Number(x.item.id_conta),
        status: x.conferido ? 'gravado' : 'incerto', criado_por: quem.id, criado_por_email: quem.email, criado_em: agora });
    });
    let registrado = true;
    if (linhas.length) { try { await b.upsert('fin_boletos_itens', linhas, 'id_composicao'); } catch (e) { registrado = false; log('[boletos-mes] registro dos itens falhou: ' + e.message); } }
    const okTodos = resultados.length === p.itens.length && resultados.every((x) => x.ok && x.conferido);
    aut.concluir({ ok: okTodos, competencia: comp.chave, itens: p.itens.length, gravados: resultados.filter((x) => x.ok).length, ids: resultados.map((x) => x.id_composicao).filter(Boolean).slice(0, 30) });
    auditar(req, 'boletos_composicao', { id_condominio: t.id, competencia: comp.chave, gravados: resultados.filter((x) => x.ok).length, pedidos: p.itens.length, confirmada: aut.confirmada });
    res.status(okTodos ? 200 : 207).json({ ok: okTodos, registrado,
      resultados: resultados.map((x) => ({ texto: M.descreverItem(x.item, comp), id_composicao: x.id_composicao, ok: x.ok, conferido: !!x.conferido, incerto: x.incerto, msg: x.ok ? '' : x.msg })),
      nao_enviados: p.itens.length - resultados.length,
      detalhe: okTodos ? 'Itens gravados e conferidos na composição do mês. Agora rode a conferência antes de gerar.'
        : 'Nem todos os itens foram gravados ou conferidos. Confira a composição antes de qualquer outra gravação.' + (registrado ? '' : ' O registro no Hub falhou: anote os números dos itens.') });
  });

  app.post('/api/financeiro/boletos-mes/:idSuperlogica/composicao/excluir', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    const t = await travas(req, res, true);
    if (!t) return;
    const comp = compDe(res, req.body && req.body.competencia);
    if (!comp) return;
    const idc = String((req.body && req.body.id_composicao) || '');
    if (!/^[1-9]\d{0,11}$/.test(idc)) return res.status(400).json({ erro: 'item_invalido', detalhe: 'Escolha o item.' });
    if (!politica) return res.status(503).json({ erro: 'politica_indisponivel', detalhe: 'A gravação no Superlógica está indisponível agora. Nada foi excluído.' });
    if (politica.bloqueada(req, res, 'boleto_composicao_excluir', t.id)) return;
    const quem = await quemGrava(req, res);
    if (!quem) return;
    const b = banco();
    if (!b) return res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'O registro dos itens do Hub está indisponível neste ambiente. Nada foi excluído.' });
    // Só exclui item que o próprio Hub criou neste condomínio (o post acha o item só pelo id).
    let reg = null;
    try { const r = await b.ler('fin_boletos_itens?select=*&id_composicao=eq.' + idc + '&id_superlogica=eq.' + t.id + '&limit=1'); reg = Array.isArray(r) ? r[0] : null; } catch (e) { return res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'Não foi possível conferir o item agora. Nada foi excluído.' }); }
    if (!reg || reg.status === 'excluido') return res.status(404).json({ erro: 'item_nao_e_do_hub', detalhe: 'Só dá para excluir por aqui um item criado pelo Hub neste condomínio. Os outros, exclua pela tela do Superlógica.' });
    const fimItem = M.somarMeses(M.competencia(reg.competencia), (Number(reg.meses) || 1) - 1);
    const aut = await politica.autorizar(req, res, { operacao: 'boleto_composicao_excluir', id_condominio: t.id, conteudo: { id_composicao: idc },
      resumo: { linhas: [{ rotulo: 'Item', valor: idc + ': ' + reg.descricao + ' ' + Number(reg.valor).toFixed(2).replace('.', ',') }, { rotulo: 'O que acontece', valor: 'O item sai da composição do Superlógica. Nenhum boleto é gerado ou alterado.' }] } });
    if (!aut) return;
    const r = await enviar('POST', 'arrecadacoes/post', null, { ID_CONDOMINIO_COND: t.id, ID_COMPOSICAO_COT: idc, INDICE_LINHA: 0, DT_FIM_COT: M.sl(M.fimMes(fimItem)), FL_EXCLUIR_ARRECADACAO: 1, salvar: 'Salvar' });
    const c = M.corpoOk(r);
    let some = null;
    try { const atuais = await M.lerComposicoes(cliente(), t.id, M.competencia(reg.competencia)); some = !atuais.some((a) => a.id === idc); } catch (e) { some = null; }
    const ok = c.ok && some === true;
    if (ok || some === true) { try { await b.upsert('fin_boletos_itens', [Object.assign({}, reg, { status: 'excluido', excluido_por: quem.id, excluido_por_email: quem.email, excluido_em: new Date().toISOString() })], 'id_composicao'); } catch (e) { log('[boletos-mes] registro da exclusão falhou'); } }
    aut.concluir({ ok, id_composicao: idc, msg: c.msg });
    res.status(ok ? 200 : 502).json({ ok, detalhe: ok ? 'Item excluído e conferido.' : (some === null ? 'Não deu para conferir a exclusão. Confira a composição no Superlógica.' : 'O Superlógica não excluiu o item: ' + c.msg) });
  });

  // ── 3. Conferência antes de gerar ──
  app.get('/api/financeiro/boletos-mes/:idSuperlogica/conferencia-antes', requireAuth, async (req, res) => {
    const t = await travas(req, res, true);
    if (!t) return;
    const comp = compDe(res, req.query.competencia);
    if (!comp) return;
    const h = hoje();
    try {
      const r = await cacheConf(t.id + '|' + comp.chave, req.query.forcar === '1', async () => {
        const cli = cliente();
        const cj = await cli.get('condominios/get', { id: t.id }).catch(() => null);
        const cr = Array.isArray(cj) ? cj.find((x) => x && String(x.id_condominio_cond) === t.id) : null;
        const cond = cr ? M.enxugarCondominio(cr) : null;
        const vencimento = cond && cond.dia ? M.vencimentoEm(comp, cond.dia) : '';
        const hist = [1, 2, 3].map((n) => M.somarMeses(comp, -n));
        const consumo = require('../superlogica/consumo-lote');
        const refLeitura = consumo.mesRef(M.somarMeses(comp, -1).chave);
        const leitura = async (tipo) => { if (!refLeitura) return null; try { return await consumo.unidadesConsumo(cli, t.id, tipo, refLeitura); } catch (e) { return null; } };
        const [simulacao, composicoes, historico, agua, gas] = await Promise.all([
          M.lerSimulacao(cli, t.id), M.lerComposicoes(cli, t.id, comp), Promise.all(hist.map((c) => M.puxarCobrancas(cli, t.id, c))), leitura(2), leitura(1)]);
        const out = M.conferirAntes({ comp, hoje: h, vencimento, simulacao, composicoes, historico, leituras: { agua, gas } });
        out.condominio = t.id; out.gerado_em = new Date().toISOString(); out.leitura_ref = refLeitura ? refLeitura.rotulo : '';
        const b = banco();
        if (b) b.inserir('fin_boletos_conferencias', { id_superlogica: Number(t.id), competencia: comp.chave, pode_gerar: out.pode_gerar, graves: out.resumo.graves, alertas: out.resumo.alertas,
          total_simulado: out.resumo.total_simulado, unidades_simuladas: out.resumo.unidades_simuladas, por_tipo: out.resumo.por_tipo }).catch(() => {});
        return out;
      });
      if (!r) return calculando(res, 'Lendo a simulação, a composição, as leituras e os 3 meses anteriores. A tela tenta de novo sozinha.');
      auditar(req, 'boletos_conferencia_antes', { id_condominio: t.id, competencia: comp.chave, pode_gerar: r.pode_gerar, graves: r.resumo.graves });
      res.json(r);
    } catch (e) { falhaSL(res, e, 'conferencia antes ' + t.id); }
  });

  // ── 4. Remessa ──
  app.get('/api/financeiro/boletos-mes/:idSuperlogica/remessa', requireAuth, async (req, res) => {
    const t = await travas(req, res, true);
    if (!t) return;
    try {
      const cli = cliente();
      const [pendentes, contas] = await Promise.all([M.lerRemessaPendente(cli, t.id), M.lerContas(cli, t.id)]);
      const nomes = new Map(contas.map((c) => [c.id, c.descricao]));
      res.json({ pendentes: pendentes.filter((p) => nomes.has(p.id_conta)).map((p) => Object.assign(p, { conta: p.conta || nomes.get(p.id_conta) })), contas, gravacao: liberado('remessa_gerar', t.id),
        aviso: 'O Hub só gera o arquivo. Subir no site do banco continua com você.' });
    } catch (e) { falhaSL(res, e, 'remessa ' + t.id); }
  });
  app.post('/api/financeiro/boletos-mes/:idSuperlogica/remessa/gerar', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    const t = await travas(req, res, true);
    if (!t) return;
    const conta = String((req.body && req.body.id_conta) || '');
    if (!/^[1-9]\d{0,9}$/.test(conta)) return res.status(400).json({ erro: 'conta_invalida', detalhe: 'Escolha a conta bancária.' });
    if (!politica) return res.status(503).json({ erro: 'politica_indisponivel', detalhe: 'A gravação no Superlógica está indisponível agora. Nada foi gerado.' });
    if (politica.bloqueada(req, res, 'remessa_gerar', t.id)) return;
    const quem = await quemGrava(req, res);
    if (!quem) return;
    let contas;
    try { contas = await M.lerContas(cliente(), t.id); } catch (e) { return falhaSL(res, e, 'contas ' + t.id); }
    const c = contas.find((x) => x.id === conta);
    if (!c) return res.status(400).json({ erro: 'conta_de_outro_condominio', detalhe: 'Essa conta não é deste condomínio. Nada foi gerado.' });
    const aut = await politica.autorizar(req, res, { operacao: 'remessa_gerar', id_condominio: t.id, conteudo: { id_conta: conta },
      resumo: { linhas: [{ rotulo: 'Conta', valor: c.descricao }, { rotulo: 'O que acontece', valor: 'O Superlógica gera o arquivo de remessa dos boletos marcados desta conta. Nada vai para o banco: você baixa o arquivo e sobe no site do banco.' }] } });
    if (!aut) return;
    const r = await enviar('POST', 'remessa/gerar', { ID_CONDOMINIO_COND: t.id, daConta: conta }, { ID_CONDOMINIO_COND: t.id });
    const x = M.lerRespostaRemessa(r);
    const nome = 'remessa_' + t.id + '_' + conta + '_' + hoje().replace(/-/g, '') + '.rem';
    const b = banco();
    if (b && (x.ok || x.nada)) b.inserir('fin_boletos_remessas', { id_superlogica: Number(t.id), id_conta: Number(conta), resultado: x.arquivo ? 'arquivo' : x.link ? 'link' : x.nada ? 'nada_a_gerar' : 'gerada',
      formato: x.formato || null, linhas: x.linhas || null, id_remessa: x.id_remessa ? Number(x.id_remessa) : null, gerado_por: quem.id, gerado_por_email: quem.email }).catch(() => {});
    aut.concluir({ ok: !!x.ok, id_conta: conta, resultado: x.arquivo ? 'arquivo' : x.link ? 'link' : x.nada ? 'nada_a_gerar' : 'sem_arquivo', linhas: x.linhas || 0 });
    if (x.nada) return res.status(200).json({ ok: false, nada: true, detalhe: 'Não há boletos marcados para remessa nesta conta. Nada foi gerado.' });
    if (!x.ok) return res.status(502).json({ ok: false, detalhe: 'O Superlógica não gerou a remessa: ' + (x.msg || 'sem resposta') + '.' });
    // O arquivo vai para a pessoa baixar; o servidor não guarda nem registra o conteúdo.
    res.json({ ok: true, nome: x.arquivo ? nome : null, arquivo: x.arquivo || null, formato: x.formato || null, linhas: x.linhas || 0, link: x.link || null,
      detalhe: x.arquivo ? 'Remessa gerada. Baixe o arquivo e suba no site do banco.' : x.link ? 'Remessa gerada. Abra o link para baixar o arquivo no Superlógica.'
        : 'O Superlógica respondeu que gerou a remessa, mas não devolveu o arquivo. Baixe em Receitas, Remessa, no Superlógica.' });
  });

  // ── 5. Régua ──
  async function lerReguaCompleta(id) {
    const cli = cliente();
    const [regua, ret] = await Promise.all([M.lerRegua(cli, id), M.lerRetornoAutomatico(cli, id, hoje())]);
    const corpo = M.corpoReguaPadrao(id, regua.campos, ret.ativo);
    return { regua, ret, corpo };
  }
  app.get('/api/financeiro/boletos-mes/:idSuperlogica/regua', requireAuth, async (req, res) => {
    const t = await travas(req, res, true);
    if (!t) return;
    try {
      const { regua, ret, corpo } = await lerReguaCompleta(t.id);
      const mud = M.diffRegua(regua.campos, corpo);
      res.json({ atual: M.descreverRegua(regua.campos), retorno_automatico: { ativo: ret.ativo, conhecido: ret.conhecido, texto: ret.texto, competencia: ret.competencia },
        padrao: { texto: 'Envio 7 dias antes, lembrete no dia do vencimento' + (ret.ativo ? ' e aviso de atraso 3 dias depois.' : '. Aviso de atraso desligado até o retorno ser automático.'), mudancas: mud, ja_no_padrao: mud.length === 0 },
        gravacao: liberado('regua_aplicar', t.id) });
    } catch (e) { falhaSL(res, e, 'regua ' + t.id); }
  });
  app.post('/api/financeiro/boletos-mes/:idSuperlogica/regua/aplicar', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    const t = await travas(req, res, true);
    if (!t) return;
    if (!politica) return res.status(503).json({ erro: 'politica_indisponivel', detalhe: 'A gravação no Superlógica está indisponível agora. Nada foi gravado.' });
    if (politica.bloqueada(req, res, 'regua_aplicar', t.id, { sensivel: true })) return;
    const quem = await quemGrava(req, res);
    if (!quem) return;
    let antes;
    try { antes = await lerReguaCompleta(t.id); } catch (e) { return falhaSL(res, e, 'regua ' + t.id); }
    const mud = M.diffRegua(antes.regua.campos, antes.corpo);
    if (!mud.length) return res.json({ ok: true, sem_mudanca: true, detalhe: 'A régua já está no padrão. Nada foi gravado.' });
    const desc = M.descreverRegua(M.esperadoRegua(antes.corpo)).envios.filter((e) => e.canal === 'email').map((e) => e.envio + ': ' + (e.ligado ? e.quando : 'desligado')).join('; ');
    const aut = await politica.autorizar(req, res, { operacao: 'regua_aplicar', id_condominio: t.id, sensivel: true, conteudo: { corpo: antes.corpo },
      resumo: { linhas: [{ rotulo: 'Régua nova', valor: desc }, { rotulo: 'Retorno', valor: antes.ret.texto },
        { rotulo: 'O que acontece', valor: 'A régua de email do condomínio passa a seguir o padrão. Os envios acontecem de madrugada pelo próprio Superlógica, para os boletos já gerados.' }],
      aviso: M.descreverRegua(antes.regua.campos).desativada ? 'A régua deste condomínio aparece como Desativada (implantação pendente): os prazos ficam gravados, mas o envio só começa quando a implantação terminar.' : undefined } });
    if (!aut) return;
    const r = await enviar('POST', 'notificacaoautomatica/putnotificacaoemail', null, antes.corpo);
    const c = M.corpoOk(r);
    let conf = null;
    try { const depois = await M.lerRegua(cliente(), t.id); conf = M.conferirRegua(antes.regua, depois, antes.corpo); } catch (e) { conf = null; }
    const ok = !!(conf && conf.ok);
    const b = banco();
    if (b) b.inserir('fin_boletos_regua', { id_superlogica: Number(t.id), antes: antes.regua.campos, depois: M.esperadoRegua(antes.corpo), retorno_automatico: !!antes.ret.ativo, ok,
      outras_chaves_mudaram: conf ? conf.outras_chaves_mudaram : null, por: quem.id, por_email: quem.email }).catch(() => {});
    aut.concluir({ ok, msg: c.msg, outras_chaves_mudaram: conf ? conf.outras_chaves_mudaram : null });
    res.status(ok ? 200 : 502).json({ ok, detalhe: ok ? 'Régua gravada e conferida.' + (conf.outras_chaves_mudaram ? ' Atenção: ' + conf.outras_chaves_mudaram + ' outra(s) configuração(ões) do condomínio mudaram junto; confira no Superlógica.' : '')
      : conf ? 'A régua não ficou como o esperado: confira no Superlógica.' : 'Não deu para conferir a régua depois de gravar: confira no Superlógica.' });
  });

  // ── 6. Trocas da forma de recebimento (só leitura) ──
  app.get('/api/financeiro/boletos-mes/:idSuperlogica/pjbank', requireAuth, async (req, res) => {
    const t = await travas(req, res, true);
    if (!t) return;
    const n = Math.min(120, Math.max(14, parseInt(req.query.dias, 10) || 60));
    const fim = hoje(), inicio = M.maisDias(fim, -(n - 1));
    try {
      const r = await cachePj(t.id + '|' + n + '|' + fim, req.query.forcar === '1', async () => {
        const x = await M.lerTrocasForma(cliente(), t.id, inicio, fim);
        return Object.assign(M.resumoTrocas(x.eventos, inicio, fim), { falhas: x.falhas, lido_em: new Date().toISOString() });
      });
      if (!r) return calculando(res, 'Lendo a auditoria do condomínio (leva até 1 minuto). A tela tenta de novo sozinha.');
      res.json(r);
    } catch (e) { falhaSL(res, e, 'pjbank ' + t.id); }
  });
}

module.exports = { registrar, criarEnvio };
