'use strict';
// Rotas da Conciliação do dia (dentro do item Conciliação). Travas como as da T35: módulo financeiro
// (ver), módulo conciliacao, acesso ao Superlógica e carteira (falha fechada). Decidir na fila e gravar
// no Superlógica exigem a ação "gravar" do módulo conciliacao (o GESTOR tem sempre).
//   GET  /api/financeiro/conciliacao-dia/resumo?carteira=<id>     resumo por condomínio, analista e avisos (só banco do Hub)
//   POST /api/financeiro/conciliacao-dia/extratos { arquivos:[{nome,texto}] }  reconhece a conta e planeja (não grava no Superlógica)
//   POST /api/financeiro/conciliacao-dia/banco { carteira? }       puxa do Sicoob, quando o conector estiver ligado
//   POST /api/financeiro/conciliacao-dia/condominio/:id/conciliar  roda as regras agora (lê o Superlógica)
//   GET  /api/financeiro/conciliacao-dia/condominio/:id            extratos e lançamentos prontos e a fila
//   POST /api/financeiro/conciliacao-dia/condominio/:id/fila/:chave { acao: aceitar|corrigir|ignorar, ... }
//   POST /api/financeiro/conciliacao-dia/condominio/:id/gravar { confirmacao_gravacao? }  pela política única de gravação
//   GET  /api/financeiro/conciliacao-dia/trabalho/:id              andamento da gravação
//   POST /api/financeiro/conciliacao-dia/avisos/gerar              só GESTOR: gera os avisos de hoje agora
// A rotina do dia roda sozinha às 7h40 dos dias úteis (CONC_AGENDADOR=0 desliga).
const D = require('./conciliacao-dia');
const ARM = require('./conciliacao-armazem');
const entrada = require('./entrada');
const { NAO_CONDOMINIOS } = require('./conciliacao-auto');

const ERROS = {
  sem_arquivo: [400, 'Escolha pelo menos um arquivo OFX.'],
  muitos_arquivos: [400, 'Envie até 20 arquivos de uma vez.'],
  nao_condominio: [400, 'Esse cadastro não é um condomínio.'],
  item_nao_encontrado: [404, 'Esse item não está mais na fila.'],
  ja_decidido: [409, 'Esse item já foi decidido por alguém. Atualize a tela.'],
  precisa_corrigir: [400, 'Esse item precisa da conta contábil e do fornecedor: use Corrigir.'],
  acao_invalida: [400, 'Ação inválida.'],
  nao_corrigivel: [400, 'Esse item não pode virar lançamento pelo Hub. Resolva no Superlógica e marque como conferido.'],
  conta_contabil_invalida: [400, 'Conta contábil inválida (exemplo: 2.2.1).'],
  fornecedor_invalido: [400, 'Código do fornecedor inválido.'],
  fornecedor_nao_encontrado: [400, 'Esse fornecedor não existe no Superlógica.'],
  conta_destino_invalida: [400, 'Escolha outra conta deste condomínio.'],
  gravacao_em_andamento: [409, 'Já tem uma gravação rodando neste condomínio. Aguarde terminar.'],
};

function registrar(d) {
  const { app, express, requireAuth } = d;
  const env = d.env || {};
  // armazem, gravador e hoje só chegam prontos nos testes.
  let arm = d.armazem || null;
  if (!arm && d.supabase && d.temBanco) arm = ARM.criarArmazemSupabase(d.supabase);
  const servico = arm ? D.criarConciliacaoDia({
    cliente: d.cliente, cred: d.cred, armazem: arm, politica: d.politica, auditar: d.auditar, grupos: d.gruposCarteiras, env, log: d.log || ((m) => console.log(m)),
    gravador: d.gravador, hoje: d.hoje, sicoob: d.sicoob,
  }) : null;
  if (servico && env.CONC_AGENDADOR !== '0' && d.superlogicaNativa && d.superlogicaNativa() && !d.semTimer) {
    D.criarAgendador({ executar: () => servico.rodarDia(), log: (m) => console.log(m) }).iniciar(60000);
  }

  const quem = (req) => (req.authMode === 'internal' ? { id: null, email: 'interno' } : { id: (req.user && req.user.sub) || null, email: (req.user && req.user.email) || null });
  const falhar = (res, e, rotulo) => {
    const x = e && ERROS[e.codigo];
    if (x) return res.status(x[0]).json({ erro: e.codigo, detalhe: x[1] });
    console.warn('[conciliacao-dia] ' + rotulo + ' falhou: ' + (e && (e.codigo || e.message)));
    return res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível concluir agora. Tente de novo em alguns minutos.' });
  };
  async function base(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!servico) { res.status(503).json({ erro: 'indisponivel', detalhe: 'A conciliação do dia não está disponível neste ambiente.' }); return false; }
    if (!(await d.exigirFinanceiro(req, res, 'ver'))) return false;
    if (!(await d.exigirModuloItem(req, res, 'conciliacao'))) return false;
    if (!(await d.exigirLeituraSuperlogica(req, res))) return false;
    return true;
  }
  async function doCondominio(req, res, gravar) {
    if (!(await base(req, res))) return null;
    const id = String(req.params.idSuperlogica || '');
    if (!d.idValido(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
    if (NAO_CONDOMINIOS.has(id)) { res.status(400).json({ erro: 'nao_condominio', detalhe: 'Esse cadastro não é um condomínio.' }); return null; }
    if (!(await d.exigirCarteira(req, res, id))) return null;
    if (!(await d.exigirEscopo(req, res, id))) return null;
    if (gravar && !(await d.exigirModuloItem(req, res, 'conciliacao', 'gravar'))) return null;
    return id;
  }
  async function podeGravar(req) {
    if (req.authMode === 'internal') return true;
    try { const p = await d.lerPerfil(req.user && req.user.sub); return !!d.podeModulo(p, 'conciliacao', 'gravar'); } catch (e) { return false; }
  }
  // Condomínios da pessoa (escopo) dentro da carteira escolhida. null = todos.
  async function idsDaTela(req, res) {
    let escopo;
    try { escopo = await d.escopoFinanceiro(req); } catch (e) { res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' }); return undefined; }
    const carteira = String(req.query.carteira || (req.body && req.body.carteira) || '');
    if (!carteira) return escopo;
    if (!/^[1-9][0-9]{0,8}$/.test(carteira)) { res.status(400).json({ erro: 'carteira_invalida', detalhe: 'Carteira inválida.' }); return undefined; }
    let g;
    try { g = (await d.gruposCarteiras()).find((x) => String(x.id) === carteira); } catch (e) { res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as carteiras agora.' }); return undefined; }
    if (!g) { res.status(404).json({ erro: 'carteira_nao_encontrada', detalhe: 'Essa carteira não existe mais.' }); return undefined; }
    const da = new Set((g.condominios || []).map(String));
    return escopo ? new Set([...da].filter((x) => escopo.has(x))) : da;
  }

  // ── resumo da tela (só o banco do Hub; não chama o Superlógica) ──────────
  app.get('/api/financeiro/conciliacao-dia/resumo', requireAuth, async (req, res) => {
    if (!(await base(req, res))) return;
    const ids = await idsDaTela(req, res);
    if (ids === undefined) return;
    try {
      const lista = ids ? [...ids] : null;
      const [estados, imps, lancs, fila] = await Promise.all([
        arm.estado.listar(lista), arm.importacoes.listar({ id_condominio: lista || undefined, status: ['planejada', 'incerta', 'gravando'] }),
        arm.lancamentos.listar({ id_condominio: lista || undefined, status: ['planejado', 'incerto', 'gravando'] }), arm.fila.listar({ id_condominio: lista || undefined, status: ['pendente'] }),
      ]);
      const dentro = (x) => !ids || ids.has(String(x.id_condominio));
      const dia = await arm.avisos.ultimoDia();
      const avisos = dia ? (await arm.avisos.listar(dia, lista)) : [];
      const g = await servico.gruposDe().catch(() => ({ porCond: new Map() }));
      const conds = new Map();
      const pegar = (idc) => {
        const k = String(idc);
        if (!conds.has(k)) {
          const dono = g.porCond.get(k) || [];
          conds.set(k, { id_condominio: k, condominio: '', carteira: [...new Set(dono.map((x) => x.carteira))].join(', '), analista: [...new Set(dono.map((x) => x.analista).filter(Boolean))].join(', '),
            ultima_conciliacao: null, ultima_gravacao: null, contas: [], extratos_prontos: 0, linhas_prontas: 0, lancamentos_prontos: 0, valor_prontos: 0, fila: 0, incertos: 0, conciliadas: 0, gravacao: null });
        }
        return conds.get(k);
      };
      estados.filter(dentro).forEach((e) => {
        const c = pegar(e.id_condominio);
        c.condominio = e.condominio || '';
        c.ultima_conciliacao = e.ultima_conciliacao; c.ultima_gravacao = e.ultima_gravacao;
        c.conciliadas = (e.resumo && e.resumo.conciliadas) || 0;
        c.contas = ((e.resumo && e.resumo.contas) || []).map((k) => ({ id: k.id, descricao: k.descricao, situacao: k.situacao, ultimo_extrato: k.quadro ? k.quadro.ultimo_extrato : null, dias_sem_extrato: k.quadro ? k.quadro.dias_sem_extrato : null }));
        c.gravacao = e.gravacao || null;
      });
      imps.filter(dentro).forEach((x) => { const c = pegar(x.id_condominio); if (x.status === 'planejada') { c.extratos_prontos++; c.linhas_prontas += x.quantidade || 0; } else c.incertos++; });
      lancs.forEach((x) => { const c = pegar(x.id_condominio); if (x.status === 'planejado') { c.lancamentos_prontos++; c.valor_prontos += Number(x.valor_centavos) || 0; } else c.incertos++; });
      fila.forEach((x) => { pegar(x.id_condominio).fila++; });
      // Todos os condomínios de quem abre entram na lista, mesmo os que ainda não foram conciliados
      // (assim a pessoa abre e clica em Conciliar agora). Sem carteira: os que têm conta no Superlógica.
      let todos = lista;
      if (!todos) { try { todos = [...new Set((await servico.contasTodas()).map((k) => k.id_condominio))]; } catch (e) { todos = []; } }
      const novos = new Set();
      for (const idc of todos) {
        const k = String(idc);
        if (!/^[1-9][0-9]{0,8}$/.test(k) || NAO_CONDOMINIOS.has(k) || conds.has(k)) continue;
        pegar(k);
        novos.add(k);
      }
      const linhas = [];
      for (const c of conds.values()) {
        if (!c.condominio) c.condominio = await servico.nomeDe(c.id_condominio);
        // Sem nome na lista de ativos e sem nada no Hub: condomínio inativo, fica fora.
        if (novos.has(c.id_condominio) && !c.condominio) continue;
        c.conciliado = !!c.ultima_conciliacao;
        linhas.push(c);
        const s = d.politica ? d.politica.estado('conciliacao_gravar', c.id_condominio) : { estado: 'bloqueado' };
        c.gravacao_politica = s.estado;
      }
      // Primeiro o que tem pendência, depois os conciliados e por fim os que ainda não foram, por nome.
      linhas.sort((a, b) => (b.fila + b.incertos) - (a.fila + a.incertos) || (b.conciliado - a.conciliado) || a.condominio.localeCompare(b.condominio));
      const porAnalista = new Map();
      avisos.forEach((a) => {
        const k = a.analista || 'Sem analista';
        if (!porAnalista.has(k)) porAnalista.set(k, { analista: k, carteira: a.carteira || '', condominios: new Set(), sem_extrato: 0, sem_conciliar: 0, linhas: 0, incertos: 0 });
        const p = porAnalista.get(k);
        p.condominios.add(a.id_condominio);
        if (a.tipo === 'sem_extrato') p.sem_extrato++;
        if (a.tipo === 'sem_conciliar') { p.sem_conciliar++; p.linhas += a.quantidade || 0; }
        if (a.tipo === 'gravacao_incerta') p.incertos += a.quantidade || 0;
      });
      res.json({ dia_avisos: dia, condominios: linhas, avisos, por_analista: [...porAnalista.values()].map((p) => Object.assign(p, { condominios: p.condominios.size })),
        banco: servico.statusBanco(), pode_gravar: await podeGravar(req), politica: d.politica ? d.politica.configuracao().modo : 'off' });
    } catch (e) { falhar(res, e, 'resumo'); }
  });

  // ── extratos OFX enviados na tela ───────────────────────────────────────
  app.post('/api/financeiro/conciliacao-dia/extratos', requireAuth, express.json({ limit: '12mb' }), async (req, res) => {
    if (!(await base(req, res))) return;
    if (!(await d.exigirModuloItem(req, res, 'conciliacao', 'gravar'))) return;
    let escopo;
    try { escopo = await d.escopoFinanceiro(req); } catch (e) { return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' }); }
    const arquivos = Array.isArray(req.body && req.body.arquivos) ? req.body.arquivos.filter((a) => a && typeof a.texto === 'string' && a.texto.length <= 5 * 1024 * 1024) : [];
    try {
      const r = await servico.receberOfx(arquivos, escopo, quem(req));
      if (d.auditar) d.auditar(req, 'conciliacao_extratos', { arquivos: r.length, planejados: r.filter((x) => x.situacao === 'planejada').length }, false);
      res.json({ arquivos: r });
    } catch (e) { falhar(res, e, 'extratos'); }
  });

  // ── extrato pelo conector do banco ──────────────────────────────────────
  app.post('/api/financeiro/conciliacao-dia/banco', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
    if (!(await base(req, res))) return;
    if (!(await d.exigirModuloItem(req, res, 'conciliacao', 'gravar'))) return;
    if (!servico.statusBanco().ligado) return res.json({ ligado: false, contas: [], detalhe: 'O conector do banco ainda está desligado (falta a credencial do Sicoob). Envie o OFX pela tela.' });
    const ids = await idsDaTela(req, res);
    if (ids === undefined) return;
    if (!ids) return res.status(400).json({ erro: 'escolha_carteira', detalhe: 'Escolha uma carteira.' });
    try { res.json(await servico.puxarBanco([...ids], quem(req))); } catch (e) { falhar(res, e, 'banco'); }
  });

  // ── conciliar um condomínio agora ───────────────────────────────────────
  const conciliando = new Map();
  app.post('/api/financeiro/conciliacao-dia/condominio/:idSuperlogica/conciliar', requireAuth, express.json({ limit: '1kb' }), async (req, res) => {
    const id = await doCondominio(req, res, false);
    if (!id) return;
    // A leitura pode passar de 1 minuto: responde 202 e a tela pergunta de novo.
    let t = conciliando.get(id);
    if (!t || (t.fim && Date.now() - t.fim > 60000)) {
      t = { fim: 0, valor: null, erro: null };
      t.p = servico.conciliar(id, quem(req)).then((v) => { t.valor = v; t.fim = Date.now(); }, (e) => { t.erro = e; t.fim = Date.now(); });
      conciliando.set(id, t);
    }
    await Promise.race([t.p, new Promise((ok) => setTimeout(ok, 20000))]);
    if (t.erro) { conciliando.delete(id); return falhar(res, t.erro, 'conciliar ' + id); }
    if (!t.valor) return res.status(202).json({ calculando: true, detalhe: 'Lendo os extratos e as despesas. A tela pergunta de novo sozinha.' });
    res.json(t.valor);
  });

  // ── detalhe de um condomínio ────────────────────────────────────────────
  app.get('/api/financeiro/conciliacao-dia/condominio/:idSuperlogica', requireAuth, async (req, res) => {
    const id = await doCondominio(req, res, false);
    if (!id) return;
    try {
      const desde = new Date(Date.now() - 7 * 86400000).toISOString();
      const [imps, lancs, fila, estado, contas] = await Promise.all([
        arm.importacoes.listar({ id_condominio: id }), arm.lancamentos.listar({ id_condominio: id }), arm.fila.listar({ id_condominio: id }), arm.estado.listar([id]), servico.contasDe(id).catch(() => []),
      ]);
      const recente = (x) => ['planejada', 'planejado', 'gravando', 'incerta', 'incerto', 'pendente'].includes(x.status) || (x.atualizado_em || x.criado_em || '') >= desde;
      const nomeConta = new Map(contas.map((c) => [c.id, c.descricao]));
      res.json({
        id_condominio: id, condominio: (estado[0] && estado[0].condominio) || await servico.nomeDe(id), estado: estado[0] || null,
        contas: contas.map(servico.contaTela),
        importacoes: imps.filter(recente).map((x) => ({ id: x.id, id_conta: String(x.id_conta), conta: nomeConta.get(String(x.id_conta)) || '', inicio: x.inicio, fim: x.fim, quantidade: x.quantidade, status: x.status, origem: x.origem, detalhe: x.detalhe || {}, criado_em: x.criado_em })),
        lancamentos: lancs.filter(recente).map((x) => ({ chave: x.chave, tipo: x.tipo, origem: x.origem, regra: x.regra, valor_centavos: Number(x.valor_centavos), status: x.status, dados: Object.assign({}, x.dados, { conta: nomeConta.get(String(x.dados && x.dados.id_conta)) || '', conta_destino: nomeConta.get(String(x.dados && x.dados.id_conta_destino)) || '' }), resultado: x.resultado || null, atualizado_em: x.atualizado_em })),
        fila: fila.filter(recente).map((x) => ({ chave: x.chave, id_conta: x.id_conta, conta: x.conta, data: x.data, valor_centavos: Number(x.valor_centavos), descricao: x.descricao, tipo: x.tipo, motivo: x.motivo, sugestao: x.sugestao, status: x.status, decidido_por_email: x.decidido_por_email, decidido_em: x.decidido_em })),
        gravacao_politica: d.politica ? d.politica.estado('conciliacao_gravar', id).estado : 'bloqueado', pode_gravar: await podeGravar(req),
        trabalho: servico.travas.has(id) ? servico.trabalho(servico.travas.get(id).id) : null,
      });
    } catch (e) { falhar(res, e, 'detalhe ' + id); }
  });

  // ── fila: aceitar, corrigir, ignorar ────────────────────────────────────
  app.post('/api/financeiro/conciliacao-dia/condominio/:idSuperlogica/fila/:chave', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    const id = await doCondominio(req, res, true);
    if (!id) return;
    const chave = String(req.params.chave || '');
    if (!/^[a-z][0-9a-f]{20,40}$/.test(chave)) return res.status(400).json({ erro: 'item_invalido', detalhe: 'Item inválido.' });
    try {
      const item = await arm.fila.pegar(chave);
      if (!item || String(item.id_condominio) !== id) return res.status(404).json({ erro: 'item_nao_encontrado', detalhe: 'Esse item não está mais na fila.' });
      const b = req.body || {};
      const r = await servico.decidir(chave, { acao: b.acao, tipo: b.tipo, conta_contabil: b.conta_contabil, id_fornecedor: b.id_fornecedor, id_conta_destino: b.id_conta_destino, lembrar: b.lembrar === true, motivo: b.motivo }, quem(req),
        (f) => entrada.fornecedorPorId({ get: (a, p) => d.cliente().get(a, p) }, f));
      if (d.auditar) d.auditar(req, 'conciliacao_fila', { id_superlogica: id, chave, acao: String(b.acao || '').slice(0, 20), status: r.status }, false);
      res.json(r);
    } catch (e) { falhar(res, e, 'fila ' + id); }
  });

  // ── gravar no Superlógica (política única) ──────────────────────────────
  app.post('/api/financeiro/conciliacao-dia/condominio/:idSuperlogica/gravar', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
    const id = await doCondominio(req, res, true);
    if (!id) return;
    if (!d.politica) return res.status(503).json({ erro: 'politica_indisponivel', detalhe: 'A gravação no Superlógica está indisponível agora. Nada foi gravado.' });
    if (d.politica.bloqueada(req, res, 'conciliacao_gravar', id)) return;
    if (servico.travas.has(id)) return res.status(409).json({ erro: 'gravacao_em_andamento', detalhe: ERROS.gravacao_em_andamento[1], trabalho: servico.travas.get(id).id });
    let prep;
    try { prep = await servico.prepararGravacao(id); } catch (e) { return falhar(res, e, 'preparar ' + id); }
    if (!prep.importacoes.length && !prep.lancamentos.length) return res.json({ nada: true, detalhe: 'Nada pronto para gravar neste condomínio.' });
    const aut = await d.politica.autorizar(req, res, { operacao: 'conciliacao_gravar', id_condominio: id, conteudo: prep.conteudo, resumo: prep.resumo, quantidade: prep.resumo.quantidade });
    if (!aut) return;
    try {
      const t = await servico.executarGravacao(prep, aut, { usuario: quem(req), origem: 'tela',
        auditarItem: (item) => d.auditar && d.auditar(req, 'conciliacao_gravacao_item', Object.assign({ id_superlogica: id }, item), item.status !== 'gravado' && item.status !== 'pulado') });
      res.status(202).json({ trabalho: t.id, total: t.total, detalhe: 'Gravando no Superlógica. Extratos primeiro, depois os lançamentos.' });
    } catch (e) {
      aut.concluir({ ok: false, erro: String((e && e.codigo) || 'falha').slice(0, 40) });
      falhar(res, e, 'gravar ' + id);
    }
  });

  app.get('/api/financeiro/conciliacao-dia/trabalho/:id', requireAuth, async (req, res) => {
    if (!(await base(req, res))) return;
    const t = servico.trabalho(req.params.id);
    if (!t) return res.status(404).json({ erro: 'trabalho_nao_encontrado', detalhe: 'Essa gravação não está mais na memória do servidor. Atualize a tela.' });
    const u = quem(req);
    if (t.usuario && u.id !== t.usuario && !(await podeGravar(req))) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Essa gravação é de outra pessoa.' });
    if (!(await d.exigirCarteira(req, res, t.id_condominio))) return;
    res.json(t);
  });

  app.post('/api/financeiro/conciliacao-dia/avisos/gerar', requireAuth, d.requireGestor, express.json({ limit: '1kb' }), async (req, res) => {
    if (!(await base(req, res))) return;
    try { res.json(await servico.gerarAvisos(null)); } catch (e) { falhar(res, e, 'avisos'); }
  });

  return { servico };
}

module.exports = { registrar };
