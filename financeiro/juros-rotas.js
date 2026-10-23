'use strict';
// Rotas de Juros e atrasos (dentro do item Financeiro). Travas de todas, conferidas no servidor e
// com falha fechada: módulo financeiro (ver), acesso ao Superlógica e carteira do condomínio
// (analista só vê os condomínios da carteira dele). Decidir quem paga e marcar o ressarcimento:
// só GESTOR e GERENTE. Superlógica só por GET (financeiro/juros-dados.js). As gravações são só nas
// tabelas fin_juros_* do Supabase (trava de banco conhecido em financeiro/banco.js).
//
// GET  /api/financeiro/juros/quadro?competencia=AAAA-MM[&carteira=<id do grupo>]
// GET  /api/financeiro/juros/condominio/:id?competencia=AAAA-MM[&forcar=1]       (202 enquanto lê)
// PUT  /api/financeiro/juros/condominio/:id/caso/:chave/registro   { competencia, enviado_assinatura_em, assinado_em, assinado_por }
// PUT  /api/financeiro/juros/condominio/:id/caso/:chave/decisao    { competencia, quem_paga, justificativa }
// POST /api/financeiro/juros/condominio/:id/caso/:chave/ressarcimento { observacao }
// POST /api/financeiro/juros/condominio/:id/retorno                 { texto } (arquivo de retorno CNAB 240)
const crypto = require('crypto');
const J = require('./juros');
const dados = require('./juros-dados');
const painel = require('./painel');
const cnab = require('./banco/cnab240');
const { criarBanco } = require('./banco');
const U = require('./regras/util');

const ID = /^[1-9][0-9]{0,8}$/;
const CHAVE = /^p[0-9]{1,15}$/;
const NAO_CONDOMINIOS = new Set(['143', '144', '145', '160', '162']);
const TTL = 10 * 60 * 1000;
const ESPERA = 20000;
const COLS_CASO = 'chave,id_superlogica,competencia,id_parcela,quem_paga,justificativa,decidido_por_email,decidido_em,enviado_assinatura_em,assinado_em,assinado_por,'
  + 'registrado_por_email,registrado_em,ressarcimento,ressarcimento_valor,ressarcido_em,ressarcido_por_email,ressarcido_obs,valor_encargos';

// d: { app, express, requireAuth, exigirFinanceiro, exigirLeituraSuperlogica, exigirCarteira, exigirEscopo, escopoFinanceiro,
//      lerPerfil, gruposCarteiras, clienteSL, obterBase, supabase: { url, chave } | banco, auditar, hoje?, log? }
function registrar(d) {
  const { app, requireAuth } = d;
  const hoje = d.hoje || U.hojeSP;
  const log = d.log || ((m) => console.warn(m));
  const fila = painel.criarFila(2);
  let _banco = d.banco;
  const banco = () => {
    if (_banco !== undefined) return _banco;
    try { _banco = criarBanco({ url: d.supabase && d.supabase.url, chave: d.supabase && d.supabase.chave }); } catch (e) { _banco = null; }
    return _banco;
  };
  const semBanco = (res) => res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'O registro dos casos não está disponível neste ambiente.' });
  const auditar = (req, acao, det) => { try { if (d.auditar) d.auditar(req, acao, det); } catch (e) { /* segue */ } };

  // ── leitura do Superlógica em segundo plano, com cache de 10 minutos ──
  const cache = new Map(); // id|competencia -> { promessa, resultado, erro, ate, criado }
  function obterBruto(id, comp, forcar, extras) {
    const k = id + '|' + comp;
    const c = cache.get(k);
    if (c && (c.resultado ? c.ate > Date.now() : !c.erro) && !(forcar && c.resultado && Date.now() - c.criado > 60000)) return c;
    const item = { criado: Date.now(), ate: Date.now() + TTL, resultado: null, erro: null };
    item.promessa = dados.carregar({ cliente: d.clienteSL(), fila, id, competencia: comp, hoje: hoje(), retornos: extras.retornos, entradas: extras.entradas })
      .then((r) => { item.resultado = r; item.ate = Date.now() + TTL; return r; })
      .catch((e) => { item.erro = e; if (cache.get(k) === item) cache.delete(k); throw e; });
    item.promessa.catch(() => {});
    cache.set(k, item);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return item;
  }
  const limparCond = (id) => { for (const k of cache.keys()) if (k.startsWith(id + '|')) cache.delete(k); };

  async function lerTabela(caminho) { const b = banco(); if (!b) return []; try { const r = await b.ler(caminho); return Array.isArray(r) ? r : []; } catch (e) { log('[juros] leitura ' + caminho.split('?')[0] + ' falhou'); return []; } }
  async function extrasDe(id) {
    const [entradas, retornosLinhas] = await Promise.all([
      lerTabela('fin_entrada?select=id_despesa,criado_em&id_superlogica=eq.' + id + '&status=eq.lancado&id_despesa=not.is.null&limit=5000'),
      lerTabela('fin_juros_banco?select=*&id_superlogica=eq.' + id + '&order=id.desc&limit=3000'),
    ]);
    return { entradas, retornos: retornosLinhas.map(pagamentoDeLinha) };
  }
  async function registrosDe(id) {
    const [linhas, historico] = await Promise.all([
      lerTabela('fin_juros_casos?select=' + COLS_CASO + '&id_superlogica=eq.' + id + '&limit=5000'),
      lerTabela('fin_juros_historico?select=chave,acao,antes,depois,por_email,em&id_superlogica=eq.' + id + '&order=em.desc&limit=3000'),
    ]);
    return { registros: new Map(linhas.map((l) => [l.chave, l])), linhas, historico };
  }
  function montar(bruto, extras, regs) {
    return J.montarCasos({ parcelas: bruto.parcelas, extrato: bruto.extrato, auditoria: bruto.auditoria, saldos: bruto.saldos,
      retornos: extras.retornos, entradas: extras.entradas, registros: regs.registros, historico: regs.historico }, { competencia: bruto.competencia, hoje: bruto.hoje });
  }

  // ── travas ──
  function validar(req, res) {
    const id = String(req.params.idSuperlogica || '');
    if (!ID.test(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
    if (NAO_CONDOMINIOS.has(id)) { res.status(400).json({ erro: 'nao_condominio', detalhe: 'Esse cadastro não é um condomínio.' }); return null; }
    const comp = J.competencia(String((req.query && req.query.competencia) || (req.body && req.body.competencia) || ''));
    if (!comp) { res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe o mês no formato AAAA-MM.' }); return null; }
    if (comp.inicio > hoje()) { res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Escolha um mês que já começou.' }); return null; }
    return { id, comp };
  }
  async function travas(req, res, id) {
    if (!(await d.exigirFinanceiro(req, res, 'ver'))) return null;
    if (!(await d.exigirLeituraSuperlogica(req, res))) return null;
    if (!(await d.exigirCarteira(req, res, id))) return null;
    return d.exigirEscopo(req, res, id);
  }
  async function quem(req, res) {
    if (req.authMode === 'internal') return { interno: true, id: null, email: 'interno', decide: true };
    let p = null;
    try { p = await d.lerPerfil(req.user && req.user.sub); } catch (e) {
      res.status(503).json({ erro: 'permissao_indisponivel', detalhe: 'Não foi possível conferir suas permissões agora.' });
      return null;
    }
    if (!p) { res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não tem acesso a esta tela.' }); return null; }
    return { interno: false, id: String(req.user.sub), email: String(p.email || '').slice(0, 120), decide: J.podeDecidir(p, false) };
  }
  // Lê o dossiê do condomínio (espera até 20 s; senão responde 202 e a tela tenta de novo).
  async function dossie(res, id, comp, forcar) {
    const extras = await extrasDe(id);
    const item = obterBruto(id, comp, forcar, extras);
    let bruto = item.resultado;
    if (!bruto) {
      const r = await Promise.race([item.promessa.then((x) => x, (e) => ({ _erro: e })), new Promise((ok) => setTimeout(() => ok(null), ESPERA))]);
      if (!r) { res.status(202).json({ calculando: true, detalhe: 'Lendo o Superlógica. A tela tenta de novo sozinha.' }); return null; }
      if (r._erro) {
        if (r._erro.status === 400) { res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Escolha um mês que já começou.' }); return null; }
        log('[juros] leitura ' + id + ' ' + comp + ' falhou: ' + (r._erro && r._erro.message));
        res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler os dados deste condomínio agora.' });
        return null;
      }
      bruto = r;
    }
    const regs = await registrosDe(id);
    return { bruto, extras, regs, r: montar(bruto, extras, regs) };
  }

  // ── quadro da carteira ──
  app.get('/api/financeiro/juros/quadro', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const comp = J.competencia(String(req.query.competencia || ''));
    if (!comp || comp.inicio > hoje()) return res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe um mês que já começou, no formato AAAA-MM.' });
    const carteira = String(req.query.carteira || '');
    if (carteira && !ID.test(carteira)) return res.status(400).json({ erro: 'carteira_invalida', detalhe: 'Carteira inválida.' });
    if (!(await d.exigirFinanceiro(req, res, 'ver'))) return;
    if (!(await d.exigirLeituraSuperlogica(req, res))) return;
    let escopo;
    try { escopo = await d.escopoFinanceiro(req); } catch (e) { return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' }); }
    let ids = escopo;
    if (carteira) {
      let grupo = null;
      try { grupo = (await d.gruposCarteiras()).find((g) => String(g.id) === carteira); } catch (e) { return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as carteiras agora.' }); }
      if (!grupo) return res.status(404).json({ erro: 'carteira_nao_encontrada', detalhe: 'Essa carteira não existe mais.' });
      const da = new Set((grupo.condominios || []).map(String));
      ids = escopo ? new Set([...da].filter((x) => escopo.has(x))) : da;
    }
    const q = await quem(req, res); if (!q) return;
    let base = null;
    try { base = await d.obterBase(); } catch (e) { return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler os dados agora. Tente de novo em alguns minutos.' }); }
    if (!base) return res.status(202).json({ calculando: true, detalhe: 'Os dados estão sendo calculados. A tela tenta de novo sozinha.' });
    const decididos = await lerTabela('fin_juros_casos?select=id_superlogica,quem_paga,valor_encargos&competencia=eq.' + comp.rotulo + '&quem_paga=not.is.null&limit=5000');
    const pend = await lerTabela('fin_juros_casos?select=chave,id_superlogica,competencia,ressarcimento_valor,decidido_em,decidido_por_email,fornecedor:snapshot->>fornecedor&ressarcimento=eq.pendente&order=decidido_em.desc&limit=500');
    const nomes = new Map([...(base.condominios || new Map()).entries()].map(([k, v]) => [String(k), v.nome]));
    const naBase = base.periodo && base.periodo.pagas_desde && comp.inicio >= base.periodo.pagas_desde;
    const linhas = J.quadro(naBase ? base.despesas || [] : [], comp.rotulo, base.hoje || hoje(), ids, decididos, nomes);
    linhas.forEach((l) => { if (base.analistas && base.analistas.get(l.id_condominio)) l.analista = base.analistas.get(l.id_condominio); });
    const ressarcir = pend.filter((r) => !ids || ids.has(String(r.id_superlogica))).map((r) => ({
      chave: r.chave, id_condominio: String(r.id_superlogica), condominio: nomes.get(String(r.id_superlogica)) || '', competencia: r.competencia,
      valor: Math.round(Number(r.ressarcimento_valor || 0) * 100), decidido_em: r.decidido_em, decidido_por: r.decidido_por_email || '', fornecedor: r.fornecedor || '' }));
    const tot = { casos: 0, encargos_lancados: 0, por_responsavel: {} };
    linhas.forEach((l) => { tot.casos += l.casos; tot.encargos_lancados += l.encargos_lancados; Object.keys(l.por_responsavel).forEach((k) => { tot.por_responsavel[k] = (tot.por_responsavel[k] || 0) + l.por_responsavel[k]; }); });
    res.json({ competencia: comp.rotulo, gerado_em: base.gerado_em, na_base: !!naBase, periodo: base.periodo, condominios: linhas, totais: tot, ressarcir, pode_decidir: q.decide,
      aviso: naBase ? '' : 'Mês fora da base do Financeiro (mês atual e os 2 anteriores): aparecem só os casos já decididos. Abra o condomínio para ver todos.' });
  });

  // ── dossiê do condomínio no mês ──
  app.get('/api/financeiro/juros/condominio/:idSuperlogica', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = validar(req, res); if (!v) return;
    const acesso = await travas(req, res, v.id); if (!acesso) return;
    const q = await quem(req, res); if (!q) return;
    try {
      const x = await dossie(res, v.id, v.comp.rotulo, req.query.forcar === '1');
      if (!x) return;
      const linkDe = (c) => painel.linkLancamento(c.id_despesa, c.id_condominio);
      res.json({ condominio: v.id, nome: x.bruto.nome, competencia: x.r.competencia, gerado_em: x.bruto.gerado_em, falhas: x.bruto.falhas, leitura: x.bruto.leitura,
        meta: x.r.meta, totais: x.r.totais, casos: x.r.casos.map((c) => Object.assign({}, c, { link: linkDe(c) })), exportacao: J.exportacao(x.r.casos),
        pode_decidir: q.decide, pode_registrar: !!banco(), quem_paga: J.QUEM_PAGA, retornos_guardados: x.extras.retornos.length });
    } catch (e) {
      log('[juros] dossiê ' + v.id + ' falhou: ' + (e && e.message));
      res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível montar os casos agora.' });
    }
  });

  // Acha o caso no dossiê atual (o caso tem de existir no mês e no condomínio pedidos).
  async function casoAtual(req, res, v) {
    const chave = String(req.params.chave || '');
    if (!CHAVE.test(chave)) { res.status(400).json({ erro: 'caso_invalido', detalhe: 'Caso inválido.' }); return null; }
    const x = await dossie(res, v.id, v.comp.rotulo, false);
    if (!x) return null;
    const caso = x.r.casos.find((c) => c.chave === chave);
    if (!caso) { res.status(404).json({ erro: 'caso_nao_encontrado', detalhe: 'Esse caso não aparece neste condomínio e mês.' }); return null; }
    return { caso, anterior: x.regs.registros.get(chave) || null };
  }
  async function gravar(res, linha, hist) {
    const b = banco();
    try {
      await b.upsert('fin_juros_casos', [linha], 'chave');
      await b.inserir('fin_juros_historico', hist);
      return true;
    } catch (e) {
      log('[juros] gravação falhou: ' + (e && e.message));
      res.status(502).json({ erro: 'falha_gravacao', detalhe: 'Não foi possível guardar agora. Tente de novo.' });
      return false;
    }
  }
  const base = (caso) => ({ chave: caso.chave, id_superlogica: Number(caso.id_condominio), competencia: caso.competencia, id_parcela: Number(caso.id_parcela),
    id_despesa: Number(caso.id_despesa) || null, situacao: caso.situacao, causa_sugerida: caso.causa.codigo, valor_encargos: Math.round(caso.valores.encargos) / 100 });

  // ── registro manual: envio para assinatura e assinatura do síndico ──
  app.put('/api/financeiro/juros/condominio/:idSuperlogica/caso/:chave/registro', requireAuth, d.express.json({ limit: '4kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = validar(req, res); if (!v) return;
    if (!(await travas(req, res, v.id))) return;
    const q = await quem(req, res); if (!q) return;
    if (!banco()) return semBanco(res);
    const val = J.validarRegistro(req.body || {}, hoje());
    if (val.erro) return res.status(400).json(val);
    const a = await casoAtual(req, res, v); if (!a) return;
    const agora = new Date().toISOString();
    const antes = a.anterior ? { enviado_assinatura_em: a.anterior.enviado_assinatura_em || null, assinado_em: a.anterior.assinado_em || null, assinado_por: a.anterior.assinado_por || null } : null;
    const linha = Object.assign(base(a.caso), val.ok, { registrado_por: q.id, registrado_por_email: q.email, registrado_em: agora, atualizado_em: agora });
    if (!(await gravar(res, linha, { chave: a.caso.chave, id_superlogica: Number(v.id), acao: 'registro', antes, depois: val.ok, por: q.id, por_email: q.email, em: agora }))) return;
    auditar(req, 'juros_registro', { condominio: v.id, caso: a.caso.chave, campos: Object.keys(val.ok) });
    res.json({ ok: true, registro: val.ok });
  });

  // ── decisão de quem paga (só GESTOR e GERENTE) ──
  app.put('/api/financeiro/juros/condominio/:idSuperlogica/caso/:chave/decisao', requireAuth, d.express.json({ limit: '8kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = validar(req, res); if (!v) return;
    if (!(await travas(req, res, v.id))) return;
    const q = await quem(req, res); if (!q) return;
    if (!q.decide) return res.status(403).json({ erro: 'sem_permissao_decidir', detalhe: 'Só gestor ou gerente decide quem paga.' });
    if (!banco()) return semBanco(res);
    const val = J.validarDecisao(req.body || {});
    if (val.erro) return res.status(400).json(val);
    const a = await casoAtual(req, res, v); if (!a) return;
    const agora = new Date().toISOString();
    const linha = J.linhaDecisao(a.caso, a.anterior, val.ok, q, agora);
    const antes = a.anterior && a.anterior.quem_paga ? { quem_paga: a.anterior.quem_paga, justificativa: a.anterior.justificativa, ressarcimento: a.anterior.ressarcimento || null } : null;
    const depois = { quem_paga: linha.quem_paga, justificativa: linha.justificativa, ressarcimento: linha.ressarcimento, causa_sugerida: linha.causa_sugerida, valor_encargos: linha.valor_encargos };
    if (!(await gravar(res, linha, { chave: a.caso.chave, id_superlogica: Number(v.id), acao: 'decisao', antes, depois, por: q.id, por_email: q.email, em: agora }))) return;
    auditar(req, 'juros_decisao', { condominio: v.id, caso: a.caso.chave, quem_paga: linha.quem_paga, valor: linha.valor_encargos });
    res.json({ ok: true, decisao: { quem_paga: linha.quem_paga, rotulo: J.QUEM_PAGA[linha.quem_paga], justificativa: linha.justificativa, decidido_em: agora, decidido_por: q.email },
      ressarcimento: linha.ressarcimento ? { status: linha.ressarcimento, valor: Math.round(linha.ressarcimento_valor * 100) } : null });
  });

  // ── ressarcimento feito (só GESTOR e GERENTE) ──
  app.post('/api/financeiro/juros/condominio/:idSuperlogica/caso/:chave/ressarcimento', requireAuth, d.express.json({ limit: '4kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    const chave = String(req.params.chave || '');
    if (!ID.test(id) || NAO_CONDOMINIOS.has(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
    if (!CHAVE.test(chave)) return res.status(400).json({ erro: 'caso_invalido', detalhe: 'Caso inválido.' });
    if (!(await travas(req, res, id))) return;
    const q = await quem(req, res); if (!q) return;
    if (!q.decide) return res.status(403).json({ erro: 'sem_permissao_decidir', detalhe: 'Só gestor ou gerente marca o ressarcimento.' });
    if (!banco()) return semBanco(res);
    const obs = String((req.body && req.body.observacao) || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const linhas = await lerTabela('fin_juros_casos?select=' + COLS_CASO + '&chave=eq.' + chave + '&id_superlogica=eq.' + id);
    const atual = linhas[0];
    if (!atual || atual.ressarcimento !== 'pendente') return res.status(409).json({ erro: 'sem_ressarcimento_pendente', detalhe: 'Esse caso não tem ressarcimento pendente.' });
    const agora = new Date().toISOString();
    const linha = { chave, id_superlogica: Number(id), competencia: atual.competencia, id_parcela: Number(atual.id_parcela), ressarcimento: 'feito', ressarcido_em: agora,
      ressarcido_por: q.id, ressarcido_por_email: q.email, ressarcido_obs: obs || null, atualizado_em: agora };
    if (!(await gravar(res, linha, { chave, id_superlogica: Number(id), acao: 'ressarcimento', antes: { ressarcimento: 'pendente' }, depois: { ressarcimento: 'feito', observacao: obs }, por: q.id, por_email: q.email, em: agora }))) return;
    auditar(req, 'juros_ressarcimento', { condominio: id, caso: chave });
    res.json({ ok: true });
  });

  // ── arquivo de retorno do banco (CNAB 240): guarda os pagamentos para a linha do tempo ──
  app.post('/api/financeiro/juros/condominio/:idSuperlogica/retorno', requireAuth, d.express.json({ limit: '3mb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!ID.test(id) || NAO_CONDOMINIOS.has(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' });
    if (!(await travas(req, res, id))) return;
    const q = await quem(req, res); if (!q) return;
    if (!banco()) return semBanco(res);
    const texto = String((req.body && req.body.texto) || '');
    if (!texto.trim() || texto.length > 2500000) return res.status(400).json({ erro: 'arquivo_invalido', detalhe: 'Envie o arquivo de retorno do banco (até 2 MB).' });
    const r = cnab.lerRetornoPagamento(texto);
    if (!r.arquivo) return res.status(400).json({ erro: 'arquivo_invalido', detalhe: 'O arquivo não parece um retorno CNAB 240.' });
    if (!r.arquivo.retorno) return res.status(400).json({ erro: 'arquivo_de_remessa', detalhe: 'Esse é o arquivo de remessa (enviado ao banco). Envie o arquivo de retorno.' });
    if (!r.pagamentos.length) return res.status(400).json({ erro: 'sem_pagamentos', detalhe: 'Nenhum pagamento no arquivo.' });
    const hash = crypto.createHash('sha256').update(texto).digest('hex');
    const agora = new Date().toISOString();
    const linhas = r.pagamentos.map((p) => ({
      id_superlogica: Number(id), arquivo_hash: hash, data_arquivo: r.arquivo.data_geracao || null, lote: String(p.lote || ''), seq: Number.isInteger(p.seq) ? p.seq : null,
      segmento: p.segmento || null, codigo_barras: p.codigo_barras || null, seu_numero: p.seu_numero || null, nosso_numero: p.nosso_numero || null,
      favorecido: String(p.favorecido || '').slice(0, 120) || null, vencimento: p.vencimento || null, data_pagamento: p.data_pagamento || null, data_real: p.data_real || null,
      valor_centavos: p.valor_centavos, valor_real_centavos: p.valor_real_centavos || null, valor_titulo_centavos: p.valor_titulo_centavos || null,
      ocorrencias: (p.ocorrencias || []).map((o) => ({ codigo: o.codigo, texto: o.texto })), enviado_por: q.id, enviado_por_email: q.email, enviado_em: agora,
    })).filter((l) => l.seq !== null);
    try { await banco().upsert('fin_juros_banco', linhas, 'arquivo_hash,lote,seq'); } catch (e) {
      log('[juros] retorno não gravou: ' + (e && e.message));
      return res.status(502).json({ erro: 'falha_gravacao', detalhe: 'Não foi possível guardar o arquivo agora.' });
    }
    limparCond(id);
    auditar(req, 'juros_retorno_banco', { condominio: id, pagamentos: linhas.length });
    res.json({ ok: true, pagamentos: linhas.length, efetivados: r.pagamentos.filter((p) => p.efetivado).length, avisos: r.avisos.slice(0, 10) });
  });

  return { cache, limparCond };
}

// Linha de fin_juros_banco de volta no formato do leitor CNAB (para conferir com as parcelas).
function pagamentoDeLinha(l) {
  const ocorrencias = Array.isArray(l.ocorrencias) ? l.ocorrencias : [];
  const cods = ocorrencias.map((o) => o.codigo);
  const efetivado = cods.includes('00');
  const agendado = !efetivado && cods.includes('BD');
  const valorReal = l.valor_real_centavos != null ? Number(l.valor_real_centavos) : null;
  return {
    lote: l.lote, seq: l.seq, linha: null, segmento: l.segmento, favorecido: l.favorecido, codigo_barras: l.codigo_barras, seu_numero: l.seu_numero, nosso_numero: l.nosso_numero,
    vencimento: l.vencimento, data_pagamento: l.data_pagamento, data_real: l.data_real, valor_centavos: l.valor_centavos != null ? Number(l.valor_centavos) : null,
    valor_titulo_centavos: l.valor_titulo_centavos != null ? Number(l.valor_titulo_centavos) : null, ocorrencias,
    efetivado, agendado, rejeitado: !efetivado && !agendado && cods.length > 0 && !cods.includes('PD') && !cods.includes('BS'),
    valor_pago_centavos: valorReal || (l.valor_centavos != null ? Number(l.valor_centavos) : null), data_efetiva: l.data_real || l.data_pagamento || null,
    linha_digitavel: null, data_arquivo: l.data_arquivo || null,
  };
}

module.exports = { registrar, pagamentoDeLinha };
