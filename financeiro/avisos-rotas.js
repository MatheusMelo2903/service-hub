// T39: rotas dos avisos do financeiro (card "Seu dia", geração sob demanda e vínculos), todas dentro do Hub.
// GET  /api/avisos/meu-dia             quem tem carteira (com o módulo financeiro) ou vínculo; GESTOR vê tudo;
//                                      OPERACIONAL nunca vê (responde { mostrar: false }).
// POST /api/avisos/gerar               só GESTOR: gera o resumo de hoje agora (todas ou algumas carteiras).
// GET  /api/avisos/situacao            só GESTOR: geração em andamento, últimas execuções e o agendamento.
// GET  /api/avisos/vinculos            só GESTOR: usuários do Superlógica vistos na auditoria, analistas e carteiras.
// PUT  /api/avisos/vinculos/:idUsuario só GESTOR: liga o usuário do Superlógica a um analista e a uma carteira.
// O card só lê o que já foi gerado (tabela fin_avisos): abrir o Hub não chama o Superlógica.
// A geração roda sozinha às 7h dos dias úteis (America/Sao_Paulo) dentro do servidor; AVISOS_AGENDADOR=0 desliga.
'use strict';
const avisos = require('./avisos');
const envio = require('./avisos-envio');
const finBanco = require('./banco');
const finPainel = require('./painel');
const regras = require('./regras');
const U = regras.util;

const RX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RX_ID_SL = /^[0-9]{1,12}$/;
const USUARIOS_SISTEMA = regras.auditoria.USUARIOS_SISTEMA;
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 80);
const PESO = { alta: 3, media: 2, baixa: 1 };

// Itens da carteira só dos condomínios que a pessoa vê (defesa a mais: a carteira gravada já é a dela).
function filtrarCarteira(c, ids) {
  if (!ids) return c;
  const itens = (c.itens || []).filter((i) => ids.has(Number(i.id_condominio)));
  // Totais só mudam quando algum item saiu (senão valem os da carteira inteira, sem o corte de itens).
  return itens.length === (c.itens || []).length ? c : Object.assign({}, c, { itens, totais: avisos.totais(itens) });
}
const ordemCarteira = (a, b) => ((b.totais && b.totais.alta) || 0) - ((a.totais && a.totais.alta) || 0) || String(a.nome).localeCompare(String(b.nome));

// d: { app, express, requireAuth, requireGestor, lerPerfil, carteira (T18), gruposCarteiras, clienteSL,
//      superlogicaNativa, supabaseUrl, supabaseChave, supabaseAdminRequest, env, log }
function registrar(d) {
  const { app, requireAuth, requireGestor } = d;
  const env = d.env || {};
  const log = d.log || ((m) => console.log(m));
  let banco = null, motivo = '';
  try { banco = finBanco.criarBanco({ url: d.supabaseUrl, chave: d.supabaseChave }); } catch (e) { motivo = e.message; }
  const maxChamadas = Number(env.AVISOS_MAX_CHAMADAS) > 0 ? Math.min(Number(env.AVISOS_MAX_CHAMADAS), 20000) : undefined;
  const servico = banco ? avisos.criarServico({ banco, cliente: d.clienteSL, grupos: d.gruposCarteiras, log, maxChamadas, esperaSobDemanda: d.esperaSobDemanda }) : null;
  const semBanco = (res) => res.status(503).json({ erro: 'avisos_indisponiveis', detalhe: motivo === 'supabase_nao_permitido' ? 'Os avisos só estão liberados no ambiente de teste.' : 'Banco não configurado neste ambiente.' });

  // Agendamento interno: 7h dos dias úteis. Só liga com o banco de teste e o Superlógica configurados.
  let agendador = null;
  if (servico && env.AVISOS_AGENDADOR !== '0' && d.superlogicaNativa()) {
    agendador = avisos.criarAgendador({
      executar: (dia) => servico.iniciar({ origem: 'agendado', dia, limiteDias: env.AVISOS_DIAS_SEM_EXTRATO }).then((r) => r && r.promessa),
      log, fimDeSemana: env.AVISOS_FIM_DE_SEMANA === '1',
    });
    if (!d.semTimer) agendador.iniciar(60000);
  }
  const quem = (req) => (req.authMode === 'internal' ? 'interno' : String((req.user && req.user.sub) || ''));

  // ── card "Seu dia" ──────────────────────────────────────────────────────
  app.get('/api/avisos/meu-dia', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const nada = () => res.json({ mostrar: false });
    let perfil = null, gestor = req.authMode === 'internal';
    if (!gestor) {
      try { perfil = await d.lerPerfil(req.user && req.user.sub); } catch (e) {
        return res.status(503).json({ erro: 'permissao_indisponivel', detalhe: 'Não foi possível conferir suas permissões agora.' });
      }
      // OPERACIONAL não vê nada dos avisos; os outros precisam do módulo financeiro (GESTOR sempre tem).
      if (!perfil || perfil.role === 'OPERACIONAL') return nada();
      gestor = perfil.role === 'GESTOR';
      if (!gestor && !finPainel.temFinanceiro(perfil, 'ver')) return nada();
    }
    if (!servico) return gestor ? semBanco(res) : nada();
    let esc = null, meus = [];
    if (!gestor) {
      try {
        esc = await d.carteira.escopo(req);
        const vs = await servico.vinculosDe(perfil.id);
        meus = (Array.isArray(vs) ? vs : []).filter((v) => v.profile_id && v.profile_id === perfil.id).map((v) => String(v.id_usuario_sl));
      } catch (e) {
        return res.status(503).json({ erro: 'avisos_indisponiveis', detalhe: 'Não foi possível conferir sua carteira agora.' });
      }
    }
    const minhas = gestor ? null : (esc && !esc.todas ? (esc.carteiras || []).map((c) => Number(c.id)).filter(Boolean) : []);
    if (!gestor && !minhas.length && !meus.length) return nada();
    try {
      // Última versão de cada chave (até 7 dias): carteira fora da geração de hoje mostra a última dela.
      const linhas = await servico.lerRecentes(gestor ? null : ['geral'].concat(minhas.map((c) => 'carteira:' + c)));
      const lGeral = linhas.find((l) => l.chave === 'geral');
      const dia = lGeral ? lGeral.dia : (linhas[0] ? linhas[0].dia : null);
      const resp = { mostrar: true, gestor, hoje: U.hojeSP(), dia, carteiras: [], erros: [] };
      if (gestor) resp.gerando = servico.situacao();
      if (!linhas.length) return res.json(resp);
      const geral = (lGeral && lGeral.conteudo) || {};
      resp.gerado_em = geral.gerado_em || null;
      resp.limite_dias = geral.limite_dias || avisos.LIMITE_DIAS_PADRAO;
      resp.competencias = geral.competencias || null;
      let carteiras = linhas.filter((l) => /^carteira:/.test(l.chave) && l.conteudo).map((l) => Object.assign({}, l.conteudo, { dia: l.dia }));
      let erros = Array.isArray(geral.erros) ? geral.erros : [];
      if (gestor) {
        const sem = linhas.find((l) => l.chave === 'sem_carteira');
        resp.sem_carteira = sem && sem.conteudo ? Object.assign({}, sem.conteudo, { dia: sem.dia }) : null;
        resp.meta = { parcial: !!geral.parcial, condominios: geral.condominios, contas_sem_extrato: geral.contas_sem_extrato, chamadas: geral.chamadas,
          chamadas_recusadas: geral.chamadas_recusadas, duracao_s: geral.duracao_s, falhas_total: geral.falhas_total, falhas: geral.falhas || [],
          erros_sem_usuario: geral.erros_sem_usuario, erros_cortados: geral.erros_cortados, auditoria_dias: geral.auditoria_dias };
        resp.vinculos = await servico.vinculos().catch(() => []);
      } else {
        carteiras = carteiras.filter((c) => minhas.includes(Number(c.id))).map((c) => filtrarCarteira(c, esc && esc.ids ? esc.ids : null));
        // Só os erros dele e, quando tem carteira, só dos condomínios dela (revisão 1, M1: mesma regra da T18).
        const daCarteira = esc && !esc.todas && esc.ids ? esc.ids : null;
        erros = erros.filter((e) => meus.includes(String(e.id_usuario_sl)) && (!daCarteira || daCarteira.has(Number(e.id_condominio))))
          .map(avisos.semOutroCondominio);
      }
      resp.carteiras = carteiras.sort(ordemCarteira);
      resp.erros = erros.sort((a, b) => (PESO[b.gravidade] || 0) - (PESO[a.gravidade] || 0) || (Number(b.valor) || 0) - (Number(a.valor) || 0));
      res.json(resp);
    } catch (e) {
      log('[avisos] meu dia falhou: ' + (e && e.message));
      res.status(502).json({ erro: 'avisos_indisponiveis', detalhe: 'Não foi possível ler os avisos agora.' });
    }
  });

  // ── geração sob demanda (só GESTOR) ─────────────────────────────────────
  // Body: { carteiras?: [id do grupo], limite_dias?: 1 a 30 }. Uma geração por vez e no máximo uma a cada 10 minutos.
  app.post('/api/avisos/gerar', requireAuth, requireGestor, d.express.json({ limit: '2kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!servico) return semBanco(res);
    if (!d.superlogicaNativa()) return res.status(503).json({ erro: 'superlogica_nao_configurado', detalhe: 'As chaves do Superlógica não estão configuradas neste ambiente.' });
    const b = req.body || {};
    let carteiras = null;
    if (b.carteiras !== undefined && b.carteiras !== null) {
      if (!Array.isArray(b.carteiras) || !b.carteiras.length || b.carteiras.length > 20 || !b.carteiras.every((x) => Number.isInteger(x) && x > 0 && x < 1e9)) {
        return res.status(400).json({ erro: 'carteiras_invalidas', detalhe: 'Informe de 1 a 20 carteiras.' });
      }
      carteiras = [...new Set(b.carteiras)];
      let grupos;
      try { grupos = await d.gruposCarteiras(); } catch (e) { return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as carteiras agora.' }); }
      const existe = new Set((grupos || []).map((g) => Number(g.id)));
      if (!carteiras.every((c) => existe.has(c))) return res.status(404).json({ erro: 'carteira_nao_encontrada', detalhe: 'Alguma carteira pedida não existe mais.' });
    }
    let limite = env.AVISOS_DIAS_SEM_EXTRATO;
    if (b.limite_dias !== undefined) {
      if (!Number.isInteger(b.limite_dias) || b.limite_dias < 1 || b.limite_dias > 30) return res.status(400).json({ erro: 'limite_invalido', detalhe: 'O limite vai de 1 a 30 dias úteis.' });
      limite = b.limite_dias;
    }
    try {
      const usuario = req.authMode === 'internal' ? null : (RX_UUID.test(String(req.user && req.user.sub)) ? req.user.sub : null);
      const r = await servico.iniciar({ origem: 'sob_demanda', usuario, carteiras, limiteDias: limite });
      log('[avisos] geração sob demanda ' + r.execucao + ' por ' + quem(req) + (carteiras ? ' carteiras ' + carteiras.join(',') : ' (todas)'));
      res.status(202).json({ execucao: r.execucao, carteiras, limite_dias: avisos.limiteDias(limite) });
    } catch (e) {
      if (e && e.codigo === 'andamento') return res.status(409).json({ erro: 'geracao_em_andamento', detalhe: 'Já existe uma geração em andamento. Aguarde terminar.' });
      if (e && e.codigo === 'aguarde') return res.status(429).json({ erro: 'aguarde', detalhe: 'Gere de novo daqui a ' + Math.ceil(e.espera_s / 60) + ' minuto(s).', espera_s: e.espera_s });
      if (e && e.codigo === 'banco') return res.status(503).json({ erro: 'avisos_indisponiveis', detalhe: 'Não foi possível registrar a geração agora.' });
      log('[avisos] gerar falhou: ' + (e && e.message));
      res.status(500).json({ erro: 'falha_avisos', detalhe: 'Não foi possível iniciar a geração agora.' });
    }
  });

  // ── situação (só GESTOR) ────────────────────────────────────────────────
  app.get('/api/avisos/situacao', requireAuth, requireGestor, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!servico) return semBanco(res);
    try {
      res.json({
        gerando: servico.situacao(), execucoes: await servico.execucoes(),
        agendador: { ligado: !!agendador, hora: '07:00', fuso: 'America/Sao_Paulo', dias: env.AVISOS_FIM_DE_SEMANA === '1' ? 'todos' : 'úteis', ultimo_dia_visto: agendador ? agendador.ultimo() : null },
        limite_dias: avisos.limiteDias(env.AVISOS_DIAS_SEM_EXTRATO), envio_para_fora: envio.canalAtivo() ? 'ligado' : 'desligado',
      });
    } catch (e) {
      log('[avisos] situação falhou: ' + (e && e.message));
      res.status(502).json({ erro: 'avisos_indisponiveis', detalhe: 'Não foi possível ler a situação agora.' });
    }
  });

  // ── vínculos usuário do Superlógica x analista e carteira (só GESTOR) ────
  async function listarPerfis() {
    let r = await d.supabaseAdminRequest('GET', '/rest/v1/profiles?select=id,nome,email,role,carteiras&order=email.asc&limit=500');
    if (r.status === 400) r = await d.supabaseAdminRequest('GET', '/rest/v1/profiles?select=id,nome,email,role&order=email.asc&limit=500');
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('perfis_indisponiveis');
    return r.body.map((p) => ({ id: p.id, nome: txt(p.nome, 80), email: txt(p.email, 120), role: p.role, carteiras: Array.isArray(p.carteiras) ? p.carteiras.map(Number) : [] }));
  }
  async function usuariosVistos() {
    const l = await servico.lerRecentes(['geral']);
    return (l[0] && l[0].conteudo && Array.isArray(l[0].conteudo.usuarios)) ? l[0].conteudo.usuarios : [];
  }

  app.get('/api/avisos/vinculos', requireAuth, requireGestor, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!servico) return semBanco(res);
    try {
      const [vs, vistos, perfis, grupos] = await Promise.all([servico.vinculos(), usuariosVistos(), listarPerfis(), Promise.resolve(d.gruposCarteiras()).catch(() => [])]);
      const porId = new Map();
      (vistos || []).forEach((u) => porId.set(String(u.id_usuario_sl), { id_usuario_sl: String(u.id_usuario_sl), apelido: txt(u.usuario), lancamentos: u.lancamentos || 0, eventos: u.eventos || 0, profile_id: null, carteira: null }));
      (vs || []).forEach((v) => {
        const u = porId.get(String(v.id_usuario_sl)) || { id_usuario_sl: String(v.id_usuario_sl), apelido: txt(v.apelido), lancamentos: 0, eventos: 0 };
        porId.set(u.id_usuario_sl, Object.assign(u, { profile_id: v.profile_id || null, carteira: v.carteira || null, atualizado_em: v.atualizado_em }));
      });
      // Sugestão: carteira de gerente do Superlógica com o mesmo apelido do usuário.
      const gerentes = new Map();
      (grupos || []).forEach((g) => { if (g.tipo === 'gerente' && g.gerente) gerentes.set(U.norm(g.gerente), Number(g.id)); });
      const usuarios = [...porId.values()].map((u) => Object.assign(u, { sugestao_carteira: gerentes.get(U.norm(u.apelido)) || null }))
        .sort((a, b) => b.lancamentos - a.lancamentos || a.apelido.localeCompare(b.apelido));
      res.json({
        usuarios,
        // OPERACIONAL pode ser vinculado, mas não vê o card (a tela avisa).
        analistas: perfis,
        carteiras: (grupos || []).map((g) => ({ id: Number(g.id), nome: txt(g.nome), tipo: txt(g.tipo, 20), gerente: txt(g.gerente) })),
      });
    } catch (e) {
      log('[avisos] vínculos falhou: ' + (e && e.message));
      res.status(502).json({ erro: 'avisos_indisponiveis', detalhe: 'Não foi possível ler os vínculos agora.' });
    }
  });

  // Body: { profile_id: uuid | null, carteira: id do grupo | null }. null tira o vínculo (nada é apagado).
  app.put('/api/avisos/vinculos/:idUsuario', requireAuth, requireGestor, d.express.json({ limit: '2kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!servico) return semBanco(res);
    const id = String(req.params.idUsuario || '');
    if (!RX_ID_SL.test(id)) return res.status(400).json({ erro: 'usuario_invalido', detalhe: 'Usuário do Superlógica inválido.' });
    if (USUARIOS_SISTEMA.has(id)) return res.status(400).json({ erro: 'usuario_sistema', detalhe: 'Esse usuário é do próprio sistema e não lança despesas.' });
    const b = req.body || {};
    const vazio = (v) => v === undefined || v === null || v === '';
    if (!vazio(b.profile_id) && !RX_UUID.test(String(b.profile_id))) return res.status(400).json({ erro: 'analista_invalido', detalhe: 'Analista inválido.' });
    if (!vazio(b.carteira) && !(Number.isInteger(b.carteira) && b.carteira > 0 && b.carteira < 1e9)) return res.status(400).json({ erro: 'carteira_invalida', detalhe: 'Carteira inválida.' });
    const profileId = vazio(b.profile_id) ? null : String(b.profile_id).toLowerCase();
    const carteira = vazio(b.carteira) ? null : b.carteira;
    try {
      if (profileId) {
        const r = await d.supabaseAdminRequest('GET', '/rest/v1/profiles?select=id&id=eq.' + encodeURIComponent(profileId));
        if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('perfis_indisponiveis');
        if (!r.body.length) return res.status(400).json({ erro: 'analista_nao_encontrado', detalhe: 'Esse analista não existe no Hub.' });
      }
      if (carteira) {
        let grupos;
        try { grupos = await d.gruposCarteiras(); } catch (e) { return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as carteiras agora.' }); }
        if (!(grupos || []).some((g) => Number(g.id) === carteira)) return res.status(400).json({ erro: 'carteira_nao_encontrada', detalhe: 'Essa carteira não existe mais.' });
      }
      // Apelido vem do que o servidor já viu (auditoria ou vínculo anterior), nunca do navegador.
      const [vs, vistos] = await Promise.all([servico.vinculos(), usuariosVistos()]);
      const antes = (vs || []).find((v) => String(v.id_usuario_sl) === id);
      const visto = (vistos || []).find((u) => String(u.id_usuario_sl) === id);
      if (!antes && !visto) return res.status(404).json({ erro: 'usuario_nao_visto', detalhe: 'Esse usuário ainda não apareceu na auditoria do Superlógica.' });
      const vinculo = {
        id_usuario_sl: id, apelido: txt((visto && visto.usuario) || (antes && antes.apelido) || ''),
        profile_id: profileId, carteira, atualizado_em: new Date().toISOString(),
        atualizado_por: req.authMode === 'internal' ? null : (RX_UUID.test(String(req.user && req.user.sub)) ? req.user.sub : null),
      };
      await servico.salvarVinculo(vinculo);
      log('[avisos] vínculo ' + id + ' analista=' + (profileId || '-') + ' carteira=' + (carteira || '-') + ' por ' + quem(req));
      res.json({ ok: true, vinculo });
    } catch (e) {
      log('[avisos] salvar vínculo falhou: ' + (e && e.message));
      res.status(502).json({ erro: 'avisos_indisponiveis', detalhe: 'Não foi possível salvar o vínculo agora.' });
    }
  });

  return { servico, agendador };
}

module.exports = { registrar, filtrarCarteira };
