'use strict';
// Rotas da execução da cobrança (acordo à vista, CRM, status financeiro, cadastro, relatório de
// inadimplência e política de acordo). Lógica em superlogica/cobranca-execucao.js.
// Travas de todas, no servidor e com falha fechada: chaves do Superlógica, carteira do condomínio
// (o guarda das rotas /api/cobranca/condominio/:id já exige o módulo cobranca) e a ação do módulo
// para cada gravação. Toda gravação no Superlógica passa pela política única
// (servico/escrita-superlogica.js: por padrão só o 167; nos outros, com confirmação).
// Histórico de tudo o que o Hub grava fica em cob_historico (migration 033), com CPF, email e
// telefone mascarados. Nada aqui manda mensagem a condômino.
//
// GET  /api/cobranca/condominio/:id/politica
// PUT  /api/cobranca/condominio/:id/politica                         (GESTOR, GERENTE ou ação politica_acordo)
// POST /api/cobranca/condominio/:id/acordo/preparar   { id_unidade, vencimento AAAA-MM-DD }
// POST /api/cobranca/condominio/:id/acordo/emitir     { id_unidade, vencimento, confirmacao_gravacao? }   (ação acordo)
// GET  /api/cobranca/condominio/:id/acordos?id_unidade=
// POST /api/cobranca/condominio/:id/acordo/desfazer   { id_unidade, id_acordo, confirmacao_gravacao? }    (ação acordo)
// POST /api/cobranca/condominio/:id/contato           { id_unidade, canal, resultado, motivo, tipo, descricao } (ação contato_crm)
// GET  /api/cobranca/condominio/:id/status-financeiro
// POST /api/cobranca/condominio/:id/status-financeiro/previa  { itens:[{ id_unidade, de, para }] }  (ação status_financeiro)
// POST /api/cobranca/condominio/:id/status-financeiro/gravar  { id_unidade, de, para, confirmacao_gravacao? }
// GET  /api/cobranca/condominio/:id/unidades
// GET  /api/cobranca/condominio/:id/cadastro/:idUnidade
// POST /api/cobranca/condominio/:id/cadastro/:idUnidade/conferir { tipo, dados }                       (ação cadastro)
// POST /api/cobranca/condominio/:id/cadastro/:idUnidade/gravar   { tipo, dados, confirmacao_gravacao? }
// GET  /api/cobranca/condominio/:id/relatorio-inadimplencia?destino=sindico|escritorio

const crypto = require('crypto');
const X = require('../superlogica/cobranca-execucao');
const W = require('./escrita-superlogica');
const C = require('../superlogica/carteira');
const { enviar } = require('../superlogica/comunicados');
const { criarBanco } = require('../financeiro/banco');

// Operações desta frente na política única (registradas aqui para não mexer no arquivo da política).
const OPERACOES_COBRANCA = {
  acordo_emitir: { rotulo: 'Emissão de acordo à vista no Superlógica' },
  acordo_desfazer: { rotulo: 'Desfazer acordo no Superlógica' },
  crm_contato: { rotulo: 'Registro de contato de cobrança no CRM do Superlógica' },
  status_financeiro: { rotulo: 'Correção do status financeiro da unidade (régua)', porItem: true },
  cadastro_unidade: { rotulo: 'Atualização cadastral da unidade no Superlógica' },
};
Object.entries(OPERACOES_COBRANCA).forEach(([k, v]) => { if (!W.OPERACOES[k]) W.OPERACOES[k] = v; });

const ID = /^[1-9][0-9]{0,8}$/;
const TRAVA_MS = 2 * 60 * 1000;
const TRAVA_INCERTO_MS = 10 * 60 * 1000;
const BASE_MS = 3 * 60 * 1000;

// Hoje e agora no horário de Brasília, com os campos locais certos em qualquer fuso do servidor.
function agoraBrasilia() {
  const b = new Date(Date.now() - 3 * 3600 * 1000);
  return new Date(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), b.getUTCHours(), b.getUTCMinutes());
}
function hojeBrasilia() { const a = agoraBrasilia(); return new Date(a.getFullYear(), a.getMonth(), a.getDate()); }
function dataISO(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
}
const hash = (v) => crypto.createHash('sha256').update(String(v == null ? '' : v)).digest('hex');

// d: { app, express, requireAuth, lerPerfil, exigirLeituraSuperlogica, exigirCarteira, politica,
//      clienteSL(), credSL(), supabase: { url, chave } | banco, auditar?, limparPainel?(id),
//      nomeCondominio?(id), hoje?(), agora?(), gravador?(cred, metodo, rota, campos) }
function registrar(d) {
  const { app, requireAuth, express } = d;
  const politica = d.politica;
  const hoje = d.hoje || hojeBrasilia;
  const agora = d.agora || agoraBrasilia;
  const log = d.log || ((m) => console.warn(m));
  const json = express.json({ limit: '20kb' });
  let _banco = d.banco;
  const banco = () => {
    if (_banco !== undefined) return _banco;
    try { _banco = criarBanco({ url: d.supabase && d.supabase.url, chave: d.supabase && d.supabase.chave }); } catch (e) { _banco = null; }
    return _banco;
  };
  // Leitura com repetição pelo cliente do Hub; gravação com uma tentativa só (nunca repete).
  const sl = () => {
    const cli = d.clienteSL();
    return { ler: (rota, p) => cli.get(rota, p), gravar: (metodo, rota, campos) => (d.gravador || enviar)(d.credSL(), metodo, rota, campos) };
  };

  // ── travas comuns ──
  async function inicio(req, res) {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!ID.test(id) || W.NUNCA.has(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
    if (!(await d.exigirLeituraSuperlogica(req, res))) return null;
    if (!(await d.exigirCarteira(req, res, id))) return null;
    return id;
  }
  async function perfil(req) {
    if (req.authMode === 'internal') return { role: 'GESTOR', interno: true, email: 'interno' };
    return d.lerPerfil(req.user && req.user.sub);
  }
  // Ação do módulo cobranca (GESTOR sempre). Falha fechada se o perfil não puder ser lido.
  async function exigirAcao(req, res, acao, gestao) {
    let p = null;
    try { p = await perfil(req); } catch (e) { res.status(503).json({ erro: 'permissao_indisponivel', detalhe: 'Não foi possível conferir suas permissões agora.' }); return null; }
    if (p && (C.temModulo(p, 'cobranca', acao) || (gestao && p.role === 'GERENTE'))) return p;
    res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não pode fazer isso na cobrança.' });
    return null;
  }
  const idUnidadeDe = (v) => { const s = String(v == null ? '' : v); return ID.test(s) ? s : null; };

  // Uma operação por unidade de cada vez (clique duplo, duas abas). Resultado incerto trava mais.
  const travas = new Map();
  function travar(res, chave) {
    const t = travas.get(chave);
    if (t && t > Date.now()) { res.status(409).json({ erro: 'em_andamento', detalhe: 'Já existe uma gravação desta unidade em andamento ou com resultado a conferir. Aguarde alguns minutos e confira no Superlógica.' }); return false; }
    travas.set(chave, Date.now() + TRAVA_MS);
    if (travas.size > 2000) for (const [k, v] of travas) if (v < Date.now()) travas.delete(k);
    return true;
  }
  const soltar = (chave, incerto) => { if (incerto) travas.set(chave, Date.now() + TRAVA_INCERTO_MS); else travas.delete(chave); };

  async function historico(req, p, reg) {
    const b = banco();
    if (!b) return;
    try {
      await b.inserir('cob_historico', Object.assign({ por: req.authMode === 'internal' ? null : (req.user && req.user.sub) || null, por_email: (p && p.email) || null }, reg));
    } catch (e) { log('[cobranca-exec] histórico não gravado: ' + (e && e.message)); }
  }
  async function lerHistorico(caminho) {
    const b = banco();
    if (!b) return [];
    try { const r = await b.ler(caminho); return Array.isArray(r) ? r : []; } catch (e) { return []; }
  }
  async function lerPolitica(id) {
    const b = banco();
    if (!b) return null;
    const r = await b.ler('cob_politica_acordo?id_superlogica=eq.' + id + '&select=*&limit=1');
    return Array.isArray(r) && r[0] ? r[0] : null;
  }
  const auditar = (req, acao, det) => { try { if (d.auditar) d.auditar(req, acao, det); } catch (e) { /* segue */ } };
  const limparPainel = (id) => { try { if (d.limparPainel) d.limparPainel(id); } catch (e) { /* segue */ } };
  function falha(res, e, onde) {
    log('[cobranca-exec] ' + onde + ' falhou: ' + (e && e.message));
    if (e && e.message === 'sem_conta') return res.status(422).json({ erro: 'sem_conta', detalhe: 'O condomínio não tem conta bancária ativa no Superlógica.' });
    if (e && /^supabase/.test(String(e.message))) return res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'O banco do Hub não respondeu agora. Nada foi gravado.' });
    return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler o Superlógica agora. Nada foi gravado. Tente de novo em alguns minutos.' });
  }

  // ── Política de acordo ─────────────────────────────────────────────────────────────────
  app.get('/api/cobranca/condominio/:idSuperlogica/politica', requireAuth, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    try {
      const [pol, config] = await Promise.all([banco() ? lerPolitica(id) : null, X.lerConfig(sl(), id)]);
      res.json({
        politica: pol, banco_disponivel: !!banco(),
        superlogica: { juros: config.juros, multa: config.multa, juros_acordo: config.juros_acordo, multa_acordo: config.multa_acordo, honorarios_pct: config.honorarios_pct, instrucao_acordo: config.instrucao_acordo },
        aviso_nao_receber: X.avisoNaoReceber(config.instrucao_acordo),
      });
    } catch (e) { falha(res, e, 'politica ' + id); }
  });
  app.put('/api/cobranca/condominio/:idSuperlogica/politica', requireAuth, json, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const p = await exigirAcao(req, res, 'politica_acordo', true); if (!p) return;
    const b = banco();
    if (!b) return res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'O cadastro da política não está disponível neste ambiente.' });
    const v = X.validarPolitica(req.body);
    if (v.erros.length) return res.status(400).json({ erro: 'politica_invalida', detalhe: v.erros.join(' ') });
    try {
      const antes = await lerPolitica(id);
      const linha = Object.assign({ id_superlogica: Number(id) }, v.politica, { atualizado_por: req.authMode === 'internal' ? null : (req.user && req.user.sub) || null, atualizado_por_email: p.email || null, atualizado_em: new Date().toISOString() });
      await b.upsert('cob_politica_acordo', [linha], 'id_superlogica');
      await historico(req, p, { id_superlogica: Number(id), id_unidade: null, tipo: 'politica', ok: true, antes, depois: v.politica });
      auditar(req, 'cobranca_politica_acordo', { id_superlogica: id });
      res.json({ ok: true, politica: linha });
    } catch (e) { falha(res, e, 'politica gravar ' + id); }
  });

  // ── Acordo à vista ─────────────────────────────────────────────────────────────────────
  // Resumo da janela de confirmação a partir do plano conferido.
  function resumoAcordo(prep) {
    const pl = prep.plano;
    return {
      linhas: [
        { rotulo: 'Unidade', valor: pl.unidade }, { rotulo: 'Responsável', valor: pl.responsavel },
        { rotulo: 'Cobranças', valor: pl.origem.length + ' (' + pl.origem.map((r) => r.vencimento.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$2/$1/$3')).join(', ') + ')' },
        { rotulo: 'Débito atualizado', valor: X.brl(pl.debito) },
        { rotulo: 'Honorários', valor: pl.honorarios ? X.brl(pl.honorarios) + ' (' + pl.honorarios_pct + '%)' : 'sem honorários' },
        { rotulo: 'Total do acordo', valor: X.brl(pl.total) + ' à vista' },
        { rotulo: 'Vencimento', valor: pl.parcela.vencimento.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$2/$1/$3') },
      ],
      aviso: prep.avisos.filter((a) => a.grave).map((a) => a.texto).join(' ') || undefined,
    };
  }
  async function prepararDoPedido(req, res, id) {
    const idU = idUnidadeDe(req.body && req.body.id_unidade);
    const venc = dataISO(req.body && req.body.vencimento);
    if (!idU) { res.status(400).json({ erro: 'unidade_invalida', detalhe: 'Escolha a unidade.' }); return null; }
    if (!venc) { res.status(400).json({ erro: 'data_invalida', detalhe: 'Informe o vencimento do acordo.' }); return null; }
    if (!banco()) { res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'A política de acordo não está disponível neste ambiente.' }); return null; }
    const pol = await lerPolitica(id);
    const prep = await X.prepararAcordo(sl(), { id, idUnidade: idU, vencimento: venc, hoje: hoje(), politica: pol });
    return { idU, prep, pol };
  }
  // Para a tela: o plano sem dados pessoais além do nome do responsável.
  const planoTela = (prep) => ({ ok: prep.ok, bloqueios: prep.bloqueios, avisos: prep.avisos, sensivel: !!prep.sensivel, unidade: prep.unidade,
    plano: prep.plano ? { unidade: prep.plano.unidade, responsavel: prep.plano.responsavel, total: prep.plano.total, debito: prep.plano.debito, honorarios: prep.plano.honorarios, honorarios_pct: prep.plano.honorarios_pct,
      vencimento: prep.plano.parcela.vencimento.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$2/$1/$3'), cobrancas: prep.plano.origem.map((r) => ({ vencimento: r.vencimento.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$2/$1/$3'), valor: r.valor, atualizado: r.corrigido })),
      composicao: prep.plano.apropriacoes.map((a) => ({ conta: a.descricao || a.conta, valor: a.valor })) } : null });

  app.post('/api/cobranca/condominio/:idSuperlogica/acordo/preparar', requireAuth, json, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    try {
      const r = await prepararDoPedido(req, res, id); if (!r) return;
      res.json(planoTela(r.prep));
    } catch (e) { falha(res, e, 'acordo preparar ' + id); }
  });

  app.post('/api/cobranca/condominio/:idSuperlogica/acordo/emitir', requireAuth, json, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const p = await exigirAcao(req, res, 'acordo'); if (!p) return;
    if (politica.bloqueada(req, res, 'acordo_emitir', id)) return;
    const chave = 'acordo:' + id + ':' + String((req.body && req.body.id_unidade) || '');
    let r = null; let aut = null; let incerto = false; let travado = false;
    try {
      r = await prepararDoPedido(req, res, id); if (!r) return;
      if (!r.prep.ok) return res.status(422).json(Object.assign({ erro: 'conferencia_reprovada', detalhe: r.prep.bloqueios.map((b) => b.texto).join(' ') }, planoTela(r.prep)));
      const pl = r.prep.plano;
      aut = await politica.autorizar(req, res, { operacao: 'acordo_emitir', id_condominio: id, sensivel: !!r.prep.sensivel,
        conteudo: { id_unidade: r.idU, vencimento: pl.parcela.vencimento, origem: pl.origem.map((x) => x.id).sort(), total: pl.total },
        resumo: resumoAcordo(r.prep) });
      if (!aut) return;
      if (!travar(res, chave)) { aut.concluir({ ok: false, erro: 'em_andamento' }); return; }
      travado = true;
      const g = await X.emitirAcordo(sl(), id, pl, hoje());
      incerto = !!g.incerto;
      aut.concluir({ ok: g.ok, incerto, id_unidade: r.idU, id_acordo: g.id_acordo || null, total: pl.total, aviso_nao_receber: pl.aviso_nao_receber, conferido: !!g.conferido });
      await historico(req, p, { id_superlogica: Number(id), id_unidade: r.idU, tipo: 'acordo_emitir', ok: !!g.ok, incerto, registro: g.id_acordo || null,
        depois: { total: pl.total, vencimento: pl.parcela.vencimento, cobrancas: pl.origem.map((x) => x.id), honorarios: pl.honorarios }, avisos: r.prep.avisos, detalhe: { conferido: !!g.conferido, divergencias: g.divergencias || [], msg: g.msg } });
      if (g.ok) limparPainel(id);
      if (!g.ok) return res.status(incerto ? 504 : 502).json({ erro: incerto ? 'resultado_incerto' : 'superlogica_recusou', detalhe: g.msg });
      res.json({ ok: true, id_acordo: g.id_acordo, conferido: !!g.conferido, divergencias: g.divergencias || [], parcela: g.parcela || null, avisos: r.prep.avisos });
    } catch (e) {
      if (aut) aut.concluir({ ok: false, erro: 'falha' });
      falha(res, e, 'acordo emitir ' + id);
    } finally { if (travado) soltar(chave, incerto); }
  });

  app.get('/api/cobranca/condominio/:idSuperlogica/acordos', requireAuth, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const idU = idUnidadeDe(req.query.id_unidade);
    if (!idU) return res.status(400).json({ erro: 'unidade_invalida', detalhe: 'Escolha a unidade.' });
    try {
      const lista = await X.acordosDaUnidade(sl(), id, idU, hoje());
      res.json({ acordos: lista.slice(0, 50).map((a) => ({ id: a.id, data: X.dataBR(a.data), desfeito: X.dataBR(a.desfeito), aberto: X.acordoAberto(a), escritorio: a.escritorio,
        cobrancas_origem: a.origem.length, parcelas: a.parcelas.map((x) => ({ vencimento: X.dataBR(x.vencimento), valor: x.valor, paga: x.paga })) })) });
    } catch (e) { falha(res, e, 'acordos ' + id); }
  });

  app.post('/api/cobranca/condominio/:idSuperlogica/acordo/desfazer', requireAuth, json, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const p = await exigirAcao(req, res, 'acordo'); if (!p) return;
    if (politica.bloqueada(req, res, 'acordo_desfazer', id)) return;
    const idU = idUnidadeDe(req.body && req.body.id_unidade);
    const idA = idUnidadeDe(req.body && req.body.id_acordo);
    if (!idU || !idA) return res.status(400).json({ erro: 'pedido_invalido', detalhe: 'Escolha a unidade e o acordo.' });
    const chave = 'acordo:' + id + ':' + idU;
    let aut = null; let incerto = false; let travado = false;
    try {
      const prep = await X.prepararDesfazer(sl(), { id, idUnidade: idU, idAcordo: idA, hoje: hoje() });
      if (!prep.ok) return res.status(422).json({ erro: 'conferencia_reprovada', detalhe: prep.bloqueios.map((b) => b.texto).join(' '), bloqueios: prep.bloqueios });
      const a = prep.acordo;
      aut = await politica.autorizar(req, res, { operacao: 'acordo_desfazer', id_condominio: id, conteudo: { id_unidade: idU, id_acordo: a.id },
        resumo: { linhas: [{ rotulo: 'Acordo', valor: a.id + ' de ' + a.data }, { rotulo: 'Parcelas', valor: a.parcelas + ' (' + X.brl(a.total) + '), nenhuma paga' }, { rotulo: 'Cobranças que voltam', valor: String(a.origem.length) }],
          aviso: a.escritorio ? 'Este acordo foi feito pelo escritório de cobrança. Combine com o escritório antes de desfazer.' : undefined } });
      if (!aut) return;
      if (!travar(res, chave)) { aut.concluir({ ok: false, erro: 'em_andamento' }); return; }
      travado = true;
      const g = await X.desfazerAcordo(sl(), id, idU, a, hoje());
      incerto = !!g.incerto;
      aut.concluir({ ok: g.ok, incerto, id_unidade: idU, id_acordo: a.id, conferido: !!g.conferido });
      await historico(req, p, { id_superlogica: Number(id), id_unidade: idU, tipo: 'acordo_desfazer', ok: !!g.ok, incerto, registro: a.id, antes: { parcelas: a.parcelas, total: a.total }, detalhe: { divergencias: g.divergencias || [], msg: g.msg } });
      if (g.ok) limparPainel(id);
      if (!g.ok) return res.status(incerto ? 504 : 502).json({ erro: incerto ? 'resultado_incerto' : 'superlogica_recusou', detalhe: g.msg });
      res.json({ ok: true, conferido: g.conferido, divergencias: g.divergencias });
    } catch (e) {
      if (aut) aut.concluir({ ok: false, erro: 'falha' });
      falha(res, e, 'acordo desfazer ' + id);
    } finally { if (travado) soltar(chave, incerto); }
  });

  // ── Contato de cobrança no CRM ─────────────────────────────────────────────────────────
  app.post('/api/cobranca/condominio/:idSuperlogica/contato', requireAuth, json, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const p = await exigirAcao(req, res, 'contato_crm'); if (!p) return;
    if (politica.bloqueada(req, res, 'crm_contato', id)) return;
    const idU = idUnidadeDe(req.body && req.body.id_unidade);
    if (!idU) return res.status(400).json({ erro: 'unidade_invalida', detalhe: 'Escolha a unidade.' });
    const v = X.validarContato(req.body);
    if (v.erros.length) return res.status(400).json({ erro: 'contato_invalido', detalhe: v.erros.join(' ') });
    const c = v.contato;
    let aut = null;
    try {
      const u = await X.unidadeDoCondominio(sl(), id, idU);
      if (!u) return res.status(404).json({ erro: 'unidade_nao_encontrada', detalhe: 'Essa unidade não é deste condomínio.' });
      const nomeU = String(u.st_unidade_uni || '') + (String(u.st_bloco_uni || '').trim() ? ' ' + String(u.st_bloco_uni).trim() : '');
      aut = await politica.autorizar(req, res, { operacao: 'crm_contato', id_condominio: id, conteudo: { id_unidade: idU, canal: c.canal, resultado: c.resultado, motivo: c.motivo, tipo: c.tipo, descricao: hash(c.descricao) },
        resumo: { linhas: [{ rotulo: 'Unidade', valor: nomeU }, { rotulo: 'Canal', valor: X.CANAIS[c.canal] }, { rotulo: 'Resultado', valor: X.RESULTADOS[c.resultado] },
          { rotulo: 'Atendimento', valor: c.tipo === 1 ? 'ativo (a administradora procurou)' : 'passivo (o morador procurou)' }, { rotulo: 'Descrição', valor: c.descricao }] } });
      if (!aut) return;
      const g = await X.registrarContato(sl(), id, idU, c, agora());
      aut.concluir({ ok: g.ok, incerto: !!g.incerto, id_unidade: idU, id_historico: g.id_historico || null, conferido: !!g.conferido });
      await historico(req, p, { id_superlogica: Number(id), id_unidade: idU, tipo: 'crm_contato', ok: !!g.ok, incerto: !!g.incerto, registro: g.id_historico || g.identificador || null,
        depois: { canal: c.canal, resultado: c.resultado, motivo: c.motivo, tipo: c.tipo, descricao: c.descricao }, detalhe: { conferido: !!g.conferido, msg: g.msg } });
      if (!g.ok) return res.status(g.incerto ? 504 : 502).json({ erro: g.incerto ? 'resultado_incerto' : 'superlogica_recusou', detalhe: g.msg });
      res.json({ ok: true, id_historico: g.id_historico, conferido: g.conferido });
    } catch (e) {
      if (aut) aut.concluir({ ok: false, erro: 'falha' });
      falha(res, e, 'contato ' + id);
    }
  });

  // ── Status financeiro ──────────────────────────────────────────────────────────────────
  // Inadimplência e configuração do condomínio guardadas por 3 minutos para o lote não reler tudo
  // a cada unidade (o status da própria unidade é lido na hora de gravar).
  const bases = new Map();
  function baseStatus(id) {
    const c = bases.get(id);
    if (c && c.ate > Date.now()) return c.p;
    const s = sl(); const h = hoje();
    const pr = Promise.all([X.inadimplencia(s, id, h), X.lerConfig(s, id)]).then(([inad, config]) => ({ inad, config }));
    pr.catch(() => bases.delete(id));
    bases.set(id, { p: pr, ate: Date.now() + BASE_MS });
    if (bases.size > 200) bases.delete(bases.keys().next().value);
    return pr;
  }
  const itemStatus = (x) => ({ id_unidade: idUnidadeDe(x && x.id_unidade), de: String(x && x.de), para: String(x && x.para) });
  const statusOk = (s) => Object.prototype.hasOwnProperty.call(X.STATUS_FIN, s) && s !== '10';

  app.get('/api/cobranca/condominio/:idSuperlogica/status-financeiro', requireAuth, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    try {
      bases.delete(id);
      const r = await X.analisarStatus(sl(), id, hoje());
      res.json(Object.assign(r, { gravacao: politica.estado('status_financeiro', id) }));
    } catch (e) { falha(res, e, 'status ' + id); }
  });
  app.post('/api/cobranca/condominio/:idSuperlogica/status-financeiro/previa', requireAuth, json, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const p = await exigirAcao(req, res, 'status_financeiro'); if (!p) return;
    const itens = (Array.isArray(req.body && req.body.itens) ? req.body.itens : []).map(itemStatus);
    if (!itens.length || itens.length > 500 || itens.some((x) => !x.id_unidade || !statusOk(x.de) || !statusOk(x.para) || x.de === x.para)) return res.status(400).json({ erro: 'itens_invalidos', detalhe: 'Lista de correções inválida.' });
    if (new Set(itens.map((x) => x.id_unidade)).size !== itens.length) return res.status(400).json({ erro: 'itens_repetidos', detalhe: 'A mesma unidade aparece duas vezes.' });
    const sobe = itens.some((x) => Number(x.para) > Number(x.de));
    if (politica.bloqueada(req, res, 'status_financeiro', id, { quantidade: itens.length, sensivel: sobe })) return;
    try {
      // Só correções que a análise de agora também propõe.
      const r = await X.analisarStatus(sl(), id, hoje());
      const prop = new Map(r.divergencias.map((x) => [x.id_unidade, x]));
      const fora = itens.filter((x) => { const q = prop.get(x.id_unidade); return !q || q.de !== x.de || q.para !== x.para; });
      if (fora.length) return res.status(409).json({ erro: 'analise_mudou', detalhe: fora.length + ' correção(ões) não batem com a análise de agora. Analise de novo.' });
      const baixar = itens.filter((x) => Number(x.para) < Number(x.de)).length;
      await politica.previaLote(req, res, { operacao: 'status_financeiro', id_condominio: id, sensivel: sobe, cabecalho: { tipo: 'status_financeiro' }, itens,
        resumo: { linhas: [{ rotulo: 'Unidades', valor: String(itens.length) }, { rotulo: 'Baixar o status', valor: String(baixar) }, { rotulo: 'Subir o status', valor: String(itens.length - baixar) }],
          aviso: sobe ? 'Subir o status pode fazer a régua mandar carta de cobrança. Confira cada unidade.' : undefined } });
    } catch (e) { falha(res, e, 'status previa ' + id); }
  });
  app.post('/api/cobranca/condominio/:idSuperlogica/status-financeiro/gravar', requireAuth, json, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const p = await exigirAcao(req, res, 'status_financeiro'); if (!p) return;
    const item = itemStatus(req.body);
    if (!item.id_unidade || !statusOk(item.de) || !statusOk(item.para) || item.de === item.para) return res.status(400).json({ erro: 'item_invalido', detalhe: 'Correção inválida.' });
    const sobe = Number(item.para) > Number(item.de);
    if (politica.bloqueada(req, res, 'status_financeiro', id, { sensivel: sobe })) return;
    const chave = 'status:' + id + ':' + item.id_unidade;
    let aut = null; let incerto = false; let travado = false;
    try {
      const conf = await X.conferirCorrecaoStatus(sl(), id, item, hoje(), await baseStatus(id));
      if (!conf.ok) return res.status(409).json({ erro: conf.codigo, detalhe: conf.texto });
      aut = await politica.autorizarItem(req, res, { operacao: 'status_financeiro', id_condominio: id, sensivel: sobe, cabecalho: { tipo: 'status_financeiro' }, item,
        resumo: { linhas: [{ rotulo: 'Unidade', valor: conf.unidade }, { rotulo: 'De', valor: X.rotuloStatus(item.de) }, { rotulo: 'Para', valor: X.rotuloStatus(item.para) }, { rotulo: 'Motivo', valor: conf.motivo }] } });
      if (!aut) return;
      if (!travar(res, chave)) { aut.concluir({ ok: false, erro: 'em_andamento' }); return; }
      travado = true;
      const g = await X.gravarStatus(sl(), id, item);
      incerto = !!g.incerto;
      aut.concluir({ ok: g.ok, incerto, id_unidade: item.id_unidade, de: item.de, para: item.para, conferido: !!g.conferido });
      await historico(req, p, { id_superlogica: Number(id), id_unidade: item.id_unidade, tipo: 'status_financeiro', ok: !!g.ok, incerto, antes: { status: item.de }, depois: { status: item.para }, detalhe: { motivo: conf.motivo, conferido: !!g.conferido, lido: g.lido, msg: g.msg } });
      if (!g.ok) return res.status(incerto ? 504 : 502).json({ erro: incerto ? 'resultado_incerto' : 'superlogica_recusou', detalhe: g.msg });
      res.json({ ok: true, conferido: g.conferido });
    } catch (e) {
      if (aut) aut.concluir({ ok: false, erro: 'falha' });
      falha(res, e, 'status gravar ' + id);
    } finally { if (travado) soltar(chave, incerto); }
  });

  // ── Cadastro da unidade ────────────────────────────────────────────────────────────────
  // Lista das unidades para escolher na tela (só código, unidade e status; nenhum dado pessoal).
  app.get('/api/cobranca/condominio/:idSuperlogica/unidades', requireAuth, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    try {
      const r = await X.lerUnidades(sl(), id);
      res.json({ unidades: r.unidades.map((u) => ({ id_unidade: u.id_unidade, unidade: u.unidade, status: X.rotuloStatus(u.status_fin) }))
        .sort((a, b) => a.unidade.localeCompare(b.unidade, 'pt-BR', { numeric: true })), cortado: r.cortado });
    } catch (e) { falha(res, e, 'unidades ' + id); }
  });
  async function unidadeOu404(res, id, idU) {
    const u = await X.unidadeDoCondominio(sl(), id, idU);
    if (!u) res.status(404).json({ erro: 'unidade_nao_encontrada', detalhe: 'Essa unidade não é deste condomínio.' });
    return u;
  }
  const historicoCadastro = (id, idU) => lerHistorico('cob_historico?select=tipo,ok,antes,depois,por_email,em&id_superlogica=eq.' + id + '&id_unidade=eq.' + idU + '&order=em.desc&limit=30');
  const pedidoCadastro = (b) => ({ tipo: String((b && b.tipo) || ''), dados: (b && typeof b.dados === 'object' && b.dados) || {} });
  // Conteúdo da confirmação: o pedido com CPF, email e telefone trocados pelo hash.
  const conteudoCadastro = (idU, ped) => ({ id_unidade: idU, tipo: ped.tipo, dados: Object.fromEntries(Object.entries(ped.dados).map(([k, v]) => [k, /cpf|email|telefone/i.test(k) ? hash(v) : (typeof v === 'object' ? null : String(v))])) });

  app.get('/api/cobranca/condominio/:idSuperlogica/cadastro/:idUnidade', requireAuth, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const idU = idUnidadeDe(req.params.idUnidade);
    if (!idU) return res.status(400).json({ erro: 'unidade_invalida', detalhe: 'Unidade inválida.' });
    try {
      const u = await unidadeOu404(res, id, idU); if (!u) return;
      const hist = await historicoCadastro(id, idU);
      res.json({ ficha: X.fichaUnidade(u), historico: hist.filter((h) => X.TIPOS_CADASTRO.includes(h.tipo)).slice(0, 20), gravacao: politica.estado('cadastro_unidade', id) });
    } catch (e) { falha(res, e, 'cadastro ' + id); }
  });
  app.post('/api/cobranca/condominio/:idSuperlogica/cadastro/:idUnidade/conferir', requireAuth, json, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const p = await exigirAcao(req, res, 'cadastro'); if (!p) return;
    const idU = idUnidadeDe(req.params.idUnidade);
    if (!idU) return res.status(400).json({ erro: 'unidade_invalida', detalhe: 'Unidade inválida.' });
    try {
      const u = await unidadeOu404(res, id, idU); if (!u) return;
      const c = X.conferirCadastro(u, pedidoCadastro(req.body), { hoje: hoje(), historico: await historicoCadastro(id, idU) });
      res.json({ ok: c.ok, erros: c.erros, avisos: c.avisos, sensivel: c.sensivel, antes: c.antes, depois: c.depois, passos: c.passos.length });
    } catch (e) { falha(res, e, 'cadastro conferir ' + id); }
  });
  app.post('/api/cobranca/condominio/:idSuperlogica/cadastro/:idUnidade/gravar', requireAuth, json, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const p = await exigirAcao(req, res, 'cadastro'); if (!p) return;
    const idU = idUnidadeDe(req.params.idUnidade);
    if (!idU) return res.status(400).json({ erro: 'unidade_invalida', detalhe: 'Unidade inválida.' });
    if (politica.bloqueada(req, res, 'cadastro_unidade', id)) return;
    const ped = pedidoCadastro(req.body);
    const chave = 'cadastro:' + id + ':' + idU;
    let aut = null; let incerto = false; let travado = false;
    try {
      const u = await unidadeOu404(res, id, idU); if (!u) return;
      const c = X.conferirCadastro(u, ped, { hoje: hoje(), historico: await historicoCadastro(id, idU) });
      if (!c.ok) return res.status(422).json({ erro: 'conferencia_reprovada', detalhe: c.erros.join(' '), erros: c.erros });
      const linhas = [{ rotulo: 'Unidade', valor: X.fichaUnidade(u).unidade }, { rotulo: 'Alteração', valor: ped.tipo.replace(/_/g, ' ') }];
      Object.entries(c.antes || {}).forEach(([k, v]) => { if (v !== undefined) linhas.push({ rotulo: 'Antes: ' + k.replace(/_/g, ' '), valor: String(v) }); });
      Object.entries(c.depois || {}).forEach(([k, v]) => { if (v !== undefined) linhas.push({ rotulo: 'Depois: ' + k.replace(/_/g, ' '), valor: String(v) }); });
      aut = await politica.autorizar(req, res, { operacao: 'cadastro_unidade', id_condominio: id, sensivel: c.sensivel, conteudo: conteudoCadastro(idU, ped),
        resumo: { linhas, aviso: c.avisos.map((a) => a.texto).join(' ') || undefined } });
      if (!aut) return;
      if (!travar(res, chave)) { aut.concluir({ ok: false, erro: 'em_andamento' }); return; }
      travado = true;
      const g = await X.gravarCadastro(sl(), id, idU, c.passos);
      incerto = !!g.incerto;
      aut.concluir({ ok: g.ok, incerto, parcial: !!g.parcial, id_unidade: idU, tipo: ped.tipo, conferido: !!g.conferido });
      await historico(req, p, { id_superlogica: Number(id), id_unidade: idU, tipo: ped.tipo, ok: !!g.ok, incerto, antes: c.antes, depois: c.depois, avisos: c.avisos, detalhe: { feitos: g.feitos, parcial: !!g.parcial, conferido: !!g.conferido, divergencias: g.divergencias || [], msg: g.msg } });
      if (!g.ok) return res.status(incerto ? 504 : 502).json({ erro: incerto ? 'resultado_incerto' : 'superlogica_recusou', detalhe: (g.parcial ? 'Parte foi gravada (' + g.feitos.join(', ') + '). ' : '') + g.msg });
      res.json({ ok: true, conferido: g.conferido, divergencias: g.divergencias });
    } catch (e) {
      if (aut) aut.concluir({ ok: false, erro: 'falha' });
      falha(res, e, 'cadastro gravar ' + id);
    } finally { if (travado) soltar(chave, incerto); }
  });

  // ── Relatório de inadimplência ─────────────────────────────────────────────────────────
  app.get('/api/cobranca/condominio/:idSuperlogica/relatorio-inadimplencia', requireAuth, async (req, res) => {
    const id = await inicio(req, res); if (!id) return;
    const destino = req.query.destino === 'escritorio' ? 'escritorio' : 'sindico';
    // A versão do escritório traz o nome do responsável: só com a ação própria.
    if (destino === 'escritorio' && !(await exigirAcao(req, res, 'relatorio_escritorio', true))) return;
    try {
      const h = hoje();
      const [inad, nome] = await Promise.all([X.inadimplencia(sl(), id, h), d.nomeCondominio ? d.nomeCondominio(id).catch(() => '') : '']);
      auditar(req, 'cobranca_relatorio_inadimplencia', { id_superlogica: id, destino });
      res.json(X.montarRelatorio(inad, { hoje: h, destino, nome }));
    } catch (e) { falha(res, e, 'relatorio ' + id); }
  });

  return { OPERACOES_COBRANCA, _travas: travas };
}

module.exports = { registrar, OPERACOES_COBRANCA, agoraBrasilia, hojeBrasilia };
