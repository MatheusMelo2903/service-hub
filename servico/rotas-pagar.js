'use strict';
// Rotas de Contas a pagar (dentro do item Financeiro). Travas de todas, conferidas no servidor e com
// falha fechada: módulo financeiro (ver), acesso ao Superlógica e carteira do condomínio. Gravar no
// Superlógica (baixa, remessa, fornecedor) passa pela política única (servico/escrita-superlogica.js):
// livre no condomínio de teste; nos outros, só com a confirmação da pessoa naquela operação.
// Quem pode dar baixa, marcar remessa e registrar envio: quem pode lançar na entrada de documentos.
// Quem lançou a despesa não confirma a baixa dela (separação de quem lança e de quem dá baixa).
// Fornecedor novo: quem aprova é gestor ou gerente, e nunca quem pediu.
// Nada vai ao banco: remessa e assinatura continuam com pessoas.
//
// GET  /api/pagar/quadro[?carteira=<id>]                       resumo da carteira (202 enquanto lê)
// GET  /api/pagar/condominio/:id[?forcar=1]                    contas esperadas, prazos e baixas (202 enquanto lê)
// GET  /api/pagar/analistas                                    o que ficou para conferir, por analista
// POST /api/pagar/condominio/:id/procurar                      procura pagamentos no retorno e no extrato agora
// POST /api/pagar/condominio/:id/baixar   { ids: [..] }        baixa as prontas (com a confirmação da política)
// POST /api/pagar/baixas/:id/conferir     { juros, multa }     baixa uma que ficou para conferir
// POST /api/pagar/baixas/:id/descartar    { motivo }           não é este pagamento
// POST /api/pagar/condominio/:id/envio    { id_parcela, para } registra o envio para a assinatura
// POST /api/pagar/condominio/:id/remessa  { id_parcela }       marca a parcela para a remessa
// PUT  /api/pagar/condominio/:id/esperadas/:chave { ignorar, motivo }
// PUT  /api/pagar/entrada/:id/completo    { parcelas, rateio, pix, copia_cola, remessa }
// GET  /api/pagar/fornecedores; POST /api/pagar/fornecedores; POST /api/pagar/fornecedores/:id/aprovar

const E = require('../financeiro/entrada');
const P = require('../financeiro/pagar');
const Z = require('../financeiro/pagar-prazos');
const B = require('../financeiro/pagar-baixa');
const C = require('../financeiro/banco/comum');
const { nomeCurto } = require('./escrita-superlogica');

const ID = /^[1-9][0-9]{0,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAO_CONDOMINIOS = new Set(['143', '144', '145', '160', '162']);
const TTL = 60 * 60 * 1000;
const ESPERA = 20000;
const REQ_SISTEMA = { authMode: 'sistema', user: { sub: null, email: null }, headers: {}, socket: {}, method: 'SISTEMA', originalUrl: '/sistema/contas-a-pagar' };
const ATIVAS = ['pronta', 'gravando', 'baixada', 'incerto'];
const COLS_BAIXA = 'id,id_superlogica,origem,origem_ref,id_parcela,id_despesa,situacao,motivo,fornecedor,vencimento,data_pagamento,valor_parcela,valor_pago,juros,multa,id_arquivo,analista,lancado_por,lancado_por_email,baixado_por,baixado_em,descartado_por_email,detalhe,criado_em,atualizado_em';

const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const reais = (c) => Math.round(Number(c || 0)) / 100;
const centDe = (v) => Math.round(Number(v || 0) * 100);
const limpar = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 300);

function criarFila(n) {
  let ativos = 0; const espera = [];
  const prox = () => { if (ativos >= n || !espera.length) return; ativos++; const { fn, ok, falha } = espera.shift(); Promise.resolve().then(fn).then(ok, falha).finally(() => { ativos--; prox(); }); };
  return (fn) => new Promise((ok, falha) => { espera.push({ fn, ok, falha }); prox(); });
}

// d: { app, express, requireAuth, banco(m, caminho, corpo), exigirFinanceiro, exigirLeituraSuperlogica, exigirCarteira,
//      exigirEscopo, escopoFinanceiro, lerPerfil, podeModulo, gruposCarteiras, clienteSL, credSL, politica, auditoria,
//      conciliacao, obterBase, dentroDoLimite, hoje? }
function registrar(d) {
  const { app, requireAuth } = d;
  const hoje = d.hoje || hojeSP;
  const json = d.express.json({ limit: '30kb' });
  const fila = criarFila(2);
  const cache = new Map(); // id -> { promessa, resultado, erro, ate }
  const emCurso = new Set(); // baixas sendo gravadas agora (id da linha)
  const auditar = (req, acao, det, susp) => { try { d.auditoria.evento(req, acao, det, !!susp); } catch (e) { /* segue */ } };
  const quemEmail = (req) => (req.user && (req.user.email || req.user.sub)) || 'sistema';

  async function lerTabela(caminho) {
    const r = await d.banco('GET', '/rest/v1/' + caminho);
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('banco_' + r.status);
    return r.body;
  }
  const lerTabelaOuVazio = (caminho) => lerTabela(caminho).catch(() => []);

  // ── travas ──
  function idDe(req, res) {
    const id = String(req.params.idSuperlogica || '');
    if (!ID.test(id) || NAO_CONDOMINIOS.has(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
    return id;
  }
  async function travas(req, res, id) {
    if (!(await d.exigirFinanceiro(req, res, 'ver'))) return false;
    if (!(await d.exigirLeituraSuperlogica(req, res))) return false;
    if (!(await d.exigirCarteira(req, res, id))) return false;
    return !!(await d.exigirEscopo(req, res, id));
  }
  // Perfil de quem chama: { id, email, lanca, gestor }.
  async function quem(req, res) {
    if (req.authMode === 'internal') return { id: null, email: 'interno', lanca: true, gestor: true };
    let p = null;
    try { p = await d.lerPerfil(req.user && req.user.sub); } catch (e) {
      res.status(503).json({ erro: 'permissao_indisponivel', detalhe: 'Não foi possível conferir suas permissões agora.' });
      return null;
    }
    if (!p) { res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não tem acesso a esta tela.' }); return null; }
    return { id: String(req.user.sub), email: String(p.email || req.user.email || '').slice(0, 120), lanca: !!d.podeModulo(p, 'entrada_documentos', 'lancar'), gestor: p.role === 'GESTOR' || p.role === 'GERENTE' };
  }
  async function exigirLanca(req, res) {
    const q = await quem(req, res); if (!q) return null;
    if (!q.lanca) { res.status(403).json({ erro: 'sem_permissao', detalhe: 'Seu usuário não pode gravar contas a pagar.' }); return null; }
    return q;
  }
  // Para chamar a política e responder com o que ela respondeu.
  function resFalso() {
    const o = { headersSent: false, st: 200, j: null };
    o.status = (s) => { o.st = s; return o; };
    o.json = (j) => { o.j = j; o.headersSent = true; return o; };
    o.set = () => o;
    return o;
  }

  // ── leitura do Superlógica (cache de 1 hora, em segundo plano) ──
  async function lerCondominio(id) {
    const cli = d.clienteSL();
    const h = hoje();
    const cond = await E.condominioPorId(cli, id);
    if (!cond) { const e = new Error('nao_encontrado'); e.status = 404; throw e; }
    // 6 meses fechados para aprender, mais o mês de hoje e o seguinte para conferir.
    const ini = Z.mesesAntes(h.slice(0, 7), 6) + '-01';
    const fim = Z.dataNoMes(Z.mesesAntes(h.slice(0, 7), -1), 31);
    const parcelas = await fila(() => E.paginas(cli, 'despesas/index', { idCondominio: id, comStatus: 'todas', dtInicio: E.isoParaSL(ini), dtFim: E.isoParaSL(fim) }, 60));
    return { id, nome: cond.nome, cnpj: cond.cnpj, plano: cond.plano, parcelas, lido_em: new Date().toISOString(), hoje: h };
  }
  function obter(id, forcar) {
    const c = cache.get(id);
    if (c && !forcar && (c.resultado ? c.ate > Date.now() : !c.erro)) return c;
    if (c && forcar && c.resultado && Date.now() - (c.ate - TTL) < 60000) return c; // no máximo uma releitura por minuto
    const item = { resultado: null, erro: null, ate: Date.now() + TTL };
    item.promessa = lerCondominio(id).then((r) => { item.resultado = r; item.ate = Date.now() + TTL; return r; })
      .catch((e) => { item.erro = e; if (cache.get(id) === item) cache.delete(id); throw e; });
    item.promessa.catch(() => {});
    cache.set(id, item);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return item;
  }
  async function esperar(res, id, forcar) {
    const item = obter(id, forcar);
    if (item.resultado) return item.resultado;
    const r = await Promise.race([item.promessa.then((x) => x, (e) => ({ _erro: e })), new Promise((ok) => setTimeout(() => ok(null), ESPERA))]);
    if (!r) { res.status(202).json({ calculando: true, detalhe: 'Lendo o Superlógica. A tela tenta de novo sozinha.' }); return null; }
    if (r._erro) {
      if (r._erro.status === 404) { res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Condomínio não encontrado no Superlógica.' }); return null; }
      console.warn('[pagar] leitura ' + id + ' falhou: ' + (r._erro && r._erro.message));
      res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as despesas deste condomínio agora.' });
      return null;
    }
    return r;
  }

  // Monta o que a tela mostra de um condomínio (avisos de prazo e contas esperadas).
  async function montar(lido) {
    const [envios, ignor] = await Promise.all([
      lerTabelaOuVazio('fin_pagar_envios?select=*&id_superlogica=eq.' + lido.id + '&limit=2000'),
      lerTabelaOuVazio('fin_pagar_esperadas?select=chave,ignorada,motivo,por_email,em&id_superlogica=eq.' + lido.id + '&limit=500'),
    ]);
    const ignoradas = new Set(ignor.filter((x) => x.ignorada).map((x) => x.chave));
    const esperadas = Z.aprender(lido.parcelas, lido.hoje);
    const curto = nomeCurto(lido.nome); // "Buritis" no lugar de "Condomínio Residencial Buritis"
    const faltam = Z.contasQueFaltam(esperadas, lido.parcelas, lido.hoje, curto, ignoradas);
    const prazos = Z.prazos(lido.parcelas, lido.hoje, new Map(envios.map((e) => [String(e.id_parcela), e])), curto);
    const emCima = Z.lancadasEmCimaDoPrazo(lido.parcelas, lido.hoje);
    return { esperadas: esperadas.map((e) => Object.assign({}, e, { ignorada: ignoradas.has(e.chave) })), faltam, prazos, lancadas_em_cima_do_prazo: emCima };
  }
  async function analistasPorCondominio() {
    try { const b = d.obterBase ? await d.obterBase() : null; return (b && b.analistas) || new Map(); } catch (e) { return new Map(); }
  }

  // ── baixas: procurar pagamentos e gravar ──
  // Quem lançou cada despesa pelo Hub (fin_entrada): separação de quem lança e de quem dá baixa.
  async function lancadores(id, idsDespesa) {
    const ids = [...new Set(idsDespesa.filter((x) => /^\d+$/.test(String(x || ''))))].slice(0, 200);
    if (!ids.length) return new Map();
    const l = await lerTabelaOuVazio('fin_entrada?select=id_despesa,lancado_por,criado_por,resultado&id_superlogica=eq.' + id + '&id_despesa=in.(' + ids.join(',') + ')&limit=500');
    return new Map(l.map((x) => [String(x.id_despesa), { id: x.lancado_por || x.criado_por || null, email: (x.resultado && x.resultado.lancado_por_email) || null }]));
  }
  // Procura pagamentos de um condomínio no retorno guardado e (quando pedido) no extrato, e grava as
  // propostas em fin_pagar_baixas. Devolve { novas, prontas, conferir }.
  async function procurar(id, opcoes) {
    const o = opcoes || {};
    const cli = d.clienteSL();
    const h = hoje();
    const feitas = new Set((await lerTabela('fin_pagar_baixas?select=origem_ref&id_superlogica=eq.' + id + '&limit=20000')).map((x) => x.origem_ref));
    const linhas = (await lerTabela('fin_juros_banco?select=*&id_superlogica=eq.' + id + '&order=id.desc&limit=1000')).filter((l) => !feitas.has('b' + l.id));
    const cond = await E.condominioPorId(cli, id);
    const propostas = [];
    let parcelas = null;
    const lerParcelas = async (ini, fim) => fila(() => E.paginas(cli, 'despesas/index', { idCondominio: id, comStatus: 'todas', dtInicio: E.isoParaSL(ini), dtFim: E.isoParaSL(fim) }, 60));
    if (linhas.length) {
      // Janela das parcelas: datas do pagamento e vencimentos (do registro ou do próprio código de barras).
      const datas = [].concat(...linhas.map((l) => [l.data_real || l.data_pagamento, l.vencimento, l.codigo_barras ? C.vencimentoDoCodigo(l.codigo_barras, l.data_pagamento || h) : null]))
        .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || ''))).sort();
      const ini = U_mais(datas[0] || h, -75), fim = U_mais(datas[datas.length - 1] > h ? datas[datas.length - 1] : h, 35);
      parcelas = await lerParcelas(ini, fim);
      propostas.push(...B.propostasRetorno(linhas, parcelas, cond && cond.cnpj));
    }
    if (o.extrato && d.conciliacao) {
      const janela = await lerParcelas(U_mais(h, -25), U_mais(h, 5));
      const debitos = janela.filter((p) => Number(p.id_forma_pag) === 7 && !P.liquidada(p));
      const contas = [...new Set(debitos.map((p) => String(p.id_contabanco_cb || '')).filter(Boolean))];
      for (const conta of contas) {
        try {
          const it = await d.conciliacao.itensConta(id, conta, U_mais(h, -25), h);
          propostas.push(...B.propostasExtrato(conta, it.banco || [], janela, h).filter((x) => !feitas.has(x.origem_ref)).map((x) => Object.assign(x, { nome_conta: it.conta && it.conta.descricao })));
        } catch (e) { /* conta sem extrato importado: segue */ }
      }
    }
    if (!propostas.length) return { novas: 0, prontas: 0, conferir: 0 };
    const analistas = await analistasPorCondominio();
    const quemLancou = await lancadores(id, propostas.map((x) => x.id_despesa));
    let novas = 0, prontas = 0, conferir = 0;
    for (const x of propostas) {
      const l = quemLancou.get(String(x.id_despesa)) || {};
      const situacao = x.acao === 'baixar' && x.id_parcela ? 'pronta' : x.acao === 'conferir' ? 'conferir' : 'descartada';
      const linha = {
        id_superlogica: Number(id), origem: x.origem, origem_ref: x.origem_ref, id_parcela: x.id_parcela ? Number(x.id_parcela) : null, id_despesa: x.id_despesa ? Number(x.id_despesa) : null,
        situacao, motivo: limpar(x.motivo, 500) || null, fornecedor: limpar(x.fornecedor, 120) || null, vencimento: x.vencimento || null, data_pagamento: x.data || null,
        valor_parcela: x.valor_parcela_centavos != null ? reais(x.valor_parcela_centavos) : null, valor_pago: x.valor_pago_centavos != null ? reais(x.valor_pago_centavos) : null,
        juros: reais(x.juros_centavos), multa: reais(x.multa_centavos), analista: analistas.get(String(id)) || null, lancado_por: l.id || null, lancado_por_email: l.email || null,
        detalhe: { achados: x.achados || [], situacao_banco: x.situacao_banco || null, linha_banco: x.linha_banco ? semQuemEnviou(x.linha_banco) : null, item_extrato: x.item_extrato || null,
          id_conta: x.id_conta || null, nome_conta: x.nome_conta || null, forma: x.forma || null },
      };
      let r = await d.banco('POST', '/rest/v1/fin_pagar_baixas?select=id', linha);
      // Já existe baixa ativa para a parcela (índice único): fica para conferir, nunca baixa duas vezes.
      if (r.status === 409 && situacao === 'pronta') {
        r = await d.banco('POST', '/rest/v1/fin_pagar_baixas?select=id', Object.assign({}, linha, { situacao: 'conferir', motivo: 'Já existe outra baixa do Hub para esta parcela. Confira antes.' }));
        if (r.status === 201) { novas++; conferir++; }
        continue;
      }
      if (r.status !== 201) continue; // repetida (mesma origem) ou falha: a próxima rodada tenta de novo
      novas++;
      if (situacao === 'pronta') prontas++;
      if (situacao === 'conferir') conferir++;
    }
    return { novas, prontas, conferir };
  }
  const semQuemEnviou = (l) => { const o = Object.assign({}, l); delete o.enviado_por; delete o.enviado_por_email; return o; };
  const U_mais = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

  // Grava uma baixa (linha de fin_pagar_baixas). Marca "gravando" antes (ninguém grava duas vezes),
  // gera o comprovante do banco, chama P.darBaixa e guarda o resultado. ajuste: { juros, multa } da pessoa.
  async function executarBaixa(req, linha, aut, quemFaz, ajuste) {
    if (emCurso.has(linha.id)) return { ok: false, erro: 'em_andamento', detalhe: 'Esta baixa já está sendo gravada.' };
    emCurso.add(linha.id);
    try {
      const trava = await d.banco('PATCH', '/rest/v1/fin_pagar_baixas?id=eq.' + linha.id + '&situacao=in.(pronta,conferir,incerto)&select=id', { situacao: 'gravando', atualizado_em: new Date().toISOString() });
      if (trava.status !== 200 || !Array.isArray(trava.body) || !trava.body[0]) { if (aut) aut.concluir({ ok: false, baixa: linha.id, erro: 'mudou' }); return { ok: false, erro: 'mudou', detalhe: 'Esta baixa mudou de situação. Atualize a tela.' }; }
      const cli = d.clienteSL();
      const id = String(linha.id_superlogica);
      const cond = await E.condominioPorId(cli, id).catch(() => null);
      const det = linha.detalhe || {};
      const comprovante = linha.origem === 'retorno' && det.linha_banco ? P.comprovanteRetorno(cond ? cond.nome : id, det.linha_banco)
        : det.item_extrato ? P.comprovanteExtrato(cond ? cond.nome : id, det.nome_conta || det.id_conta, det.item_extrato) : null;
      const juros = ajuste ? centDe(ajuste.juros) : centDe(linha.juros);
      const multa = ajuste ? centDe(ajuste.multa) : centDe(linha.multa);
      let r;
      if (!comprovante) r = { ok: false, incerto: false, msg: 'Sem o registro do banco para o comprovante. Nada foi gravado.' };
      else {
        let bloqueio = null;
        try { bloqueio = (await E.contasBanco(cli, id, true)).bloqueio; } catch (e) { bloqueio = null; }
        r = await P.darBaixa(d.credSL(), cli, { id_condominio: id, id_parcela: String(linha.id_parcela), vencimento: linha.vencimento, data: linha.data_pagamento, hoje: hoje(),
          valor_pago_centavos: centDe(linha.valor_pago), juros_centavos: juros, multa_centavos: multa, comprovante, nome_comprovante: 'comprovante-banco-' + linha.id_parcela + '.pdf', bloqueio });
      }
      const agora = new Date().toISOString();
      const fim = { atualizado_em: agora, detalhe: Object.assign({}, det, { resultado: { ok: !!r.ok, incerto: !!r.incerto, msg: r.msg || null, prova: r.prova || null, etiqueta: r.etiqueta == null ? null : !!r.etiqueta } }) };
      if (r.ok) Object.assign(fim, { situacao: 'baixada', baixado_por: quemFaz.email, baixado_por_id: quemFaz.id || null, baixado_em: agora, id_arquivo: r.id_arquivo ? Number(r.id_arquivo) : null, juros: reais(juros), multa: reais(multa) });
      else if (r.ja_baixada) Object.assign(fim, { situacao: 'descartada', motivo: limpar(r.msg, 500) });
      else if (r.incerto) Object.assign(fim, { situacao: 'incerto', motivo: limpar(r.msg, 500), id_arquivo: r.id_arquivo ? Number(r.id_arquivo) : null });
      else Object.assign(fim, { situacao: 'conferir', motivo: limpar(r.msg, 500) });
      await d.banco('PATCH', '/rest/v1/fin_pagar_baixas?id=eq.' + linha.id, fim);
      if (aut) aut.concluir({ ok: !!r.ok, incerto: !!r.incerto, baixa: linha.id, id_parcela: String(linha.id_parcela), valor: Number(linha.valor_pago), juros: reais(juros), multa: reais(multa) });
      auditar(req, 'pagar_baixa', { id_superlogica: id, baixa: linha.id, id_parcela: String(linha.id_parcela), ok: !!r.ok, incerto: !!r.incerto, origem: linha.origem, por: quemFaz.email }, !r.ok && !r.ja_baixada);
      return r.ok ? { ok: true, conferido: !!r.conferido } : { ok: false, erro: r.incerto ? 'incerto' : r.ja_baixada ? 'ja_baixada' : 'recusado', detalhe: r.msg };
    } catch (e) {
      console.warn('[pagar baixa] ' + (e && e.message));
      await d.banco('PATCH', '/rest/v1/fin_pagar_baixas?id=eq.' + linha.id + '&situacao=eq.gravando', { situacao: 'incerto', motivo: 'Erro no meio da gravação: confira no Superlógica.', atualizado_em: new Date().toISOString() }).catch(() => {});
      if (aut) aut.concluir({ ok: false, incerto: true, baixa: linha.id });
      return { ok: false, erro: 'incerto', detalhe: 'A baixa não foi confirmada. Confira no Superlógica antes de tentar de novo.' };
    } finally { emCurso.delete(linha.id); }
  }

  // Rotina do sistema: procura pagamentos novos e baixa sozinho onde a política deixa gravar sem
  // confirmação (hoje, só o condomínio de teste). Nos outros, a baixa fica "pronta" para uma pessoa confirmar.
  async function rodarRotina() {
    if (!d.politica) return { condominios: 0 };
    const feitas = new Set((await lerTabelaOuVazio('fin_pagar_baixas?select=origem_ref&origem=eq.retorno&limit=50000')).map((x) => x.origem_ref));
    const linhas = await lerTabelaOuVazio('fin_juros_banco?select=id,id_superlogica&order=id.desc&limit=5000');
    const conds = new Set(linhas.filter((l) => !feitas.has('b' + l.id)).map((l) => String(l.id_superlogica)));
    const cfg = d.politica.configuracao();
    (cfg.teste || []).forEach((x) => conds.add(String(x))); // no teste também confere o extrato
    let n = 0;
    for (const id of conds) {
      if (!ID.test(id) || NAO_CONDOMINIOS.has(id)) continue;
      const livre = d.politica.estado('pagar_baixa', id).estado === 'livre';
      try {
        await procurar(id, { extrato: livre });
        if (livre) {
          const prontas = await lerTabelaOuVazio('fin_pagar_baixas?select=' + COLS_BAIXA + '&id_superlogica=eq.' + id + '&situacao=eq.pronta&limit=50');
          for (const l of prontas) {
            const aut = await d.politica.autorizar(REQ_SISTEMA, resFalso(), { operacao: 'pagar_baixa', id_condominio: id, conteudo: { baixa: l.id }, resumo: { linhas: [{ rotulo: 'Baixa automática', valor: (l.fornecedor || '') + ' ' + l.valor_pago }] } });
            if (aut && aut.livre) await executarBaixa(REQ_SISTEMA, l, aut, { email: 'sistema', id: null });
          }
        }
        n++;
      } catch (e) { console.warn('[pagar rotina] ' + id + ': ' + (e && e.message)); }
    }
    return { condominios: n };
  }

  // ── rotas ──
  // Resumo da carteira: o que já foi lido (cache) e o que está sendo lido.
  app.get('/api/pagar/quadro', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await d.exigirFinanceiro(req, res, 'ver'))) return;
    if (!(await d.exigirLeituraSuperlogica(req, res))) return;
    let escopo;
    try { escopo = await d.escopoFinanceiro(req); } catch (e) { return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' }); }
    const carteira = String(req.query.carteira || '');
    if (carteira && !ID.test(carteira)) return res.status(400).json({ erro: 'carteira_invalida', detalhe: 'Carteira inválida.' });
    try {
      const todos = [...(await E.cadastroCondominios(d.clienteSL())).porId.values()];
      let ids = todos.map((c) => c.id).filter((x) => !escopo || escopo.has(x));
      if (carteira) {
        const g = (await d.gruposCarteiras()).find((x) => String(x.id) === carteira);
        if (!g) return res.status(404).json({ erro: 'carteira_nao_encontrada', detalhe: 'Essa carteira não existe mais.' });
        const da = new Set((g.condominios || []).map(String));
        ids = ids.filter((x) => da.has(x));
      }
      const nomes = new Map(todos.map((c) => [c.id, c.nome]));
      const analistas = await analistasPorCondominio();
      const baixas = await lerTabelaOuVazio('fin_pagar_baixas?select=id_superlogica,situacao&situacao=in.(pronta,conferir,incerto)&limit=20000');
      const porCond = new Map();
      baixas.forEach((b) => { const k = String(b.id_superlogica); if (!porCond.has(k)) porCond.set(k, { pronta: 0, conferir: 0, incerto: 0 }); porCond.get(k)[b.situacao]++; });
      let calculando = 0;
      const linhas = [];
      for (const id of ids) {
        const item = obter(id, false);
        const pend = porCond.get(id) || { pronta: 0, conferir: 0, incerto: 0 };
        const base = { id_condominio: id, condominio: nomes.get(id) || '', analista: analistas.get(id) || '', baixas_prontas: pend.pronta, baixas_conferir: pend.conferir + pend.incerto };
        if (!item.resultado) { calculando++; linhas.push(Object.assign(base, { calculando: true })); continue; }
        const m = await montar(item.resultado);
        linhas.push(Object.assign(base, {
          contas_nao_chegaram: m.faltam.filter((a) => a.codigo === 'conta_nao_chegou').length,
          urgentes: m.faltam.filter((a) => a.nivel === 'urgente' || a.nivel === 'vencida').length + m.prazos.filter((a) => a.nivel === 'urgente').length,
          sem_envio: m.prazos.filter((a) => a.codigo === 'sem_envio_assinatura').length, vencidas: m.prazos.filter((a) => a.codigo === 'vencida_em_aberto').length,
        }));
      }
      res.json({ hoje: hoje(), condominios: linhas, calculando });
    } catch (e) {
      console.warn('[pagar quadro] ' + (e && e.message));
      res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível montar o quadro agora.' });
    }
  });

  app.get('/api/pagar/condominio/:idSuperlogica', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = idDe(req, res); if (!id) return;
    if (!(await travas(req, res, id))) return;
    const q = await quem(req, res); if (!q) return;
    try {
      const lido = await esperar(res, id, req.query.forcar === '1');
      if (!lido) return;
      const m = await montar(lido);
      const baixas = await lerTabelaOuVazio('fin_pagar_baixas?select=' + COLS_BAIXA + '&id_superlogica=eq.' + id + '&situacao=neq.descartada&order=criado_em.desc&limit=300');
      const sit = d.politica ? d.politica.estado('pagar_baixa', id) : { estado: 'bloqueado' };
      res.json(Object.assign({ condominio: id, nome: lido.nome, hoje: lido.hoje, lido_em: lido.lido_em, pode_gravar: q.lanca, eu: q.id,
        gravacao: sit.estado, baixas: baixas.map((b) => paraTela(b, q)) }, m));
    } catch (e) {
      console.warn('[pagar condominio] ' + id + ': ' + (e && e.message));
      if (!res.headersSent) res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível montar os dados agora.' });
    }
  });
  function paraTela(b, q) {
    const det = b.detalhe || {};
    return { id: b.id, origem: b.origem, id_parcela: b.id_parcela, id_despesa: b.id_despesa, situacao: b.situacao, motivo: b.motivo, fornecedor: b.fornecedor, vencimento: b.vencimento,
      data_pagamento: b.data_pagamento, valor_parcela: b.valor_parcela, valor_pago: b.valor_pago, juros: b.juros, multa: b.multa, analista: b.analista, lancado_por_email: b.lancado_por_email,
      baixado_por: b.baixado_por, baixado_em: b.baixado_em, criado_em: b.criado_em, achados: det.achados || [], resultado: det.resultado || null,
      eu_lancei: !!(q && q.id && b.lancado_por && String(b.lancado_por) === String(q.id)) };
  }

  // O que ficou para conferir, por analista (carteira de quem vê).
  app.get('/api/pagar/analistas', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await d.exigirFinanceiro(req, res, 'ver'))) return;
    let escopo;
    try { escopo = await d.escopoFinanceiro(req); } catch (e) { return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' }); }
    const q = await quem(req, res); if (!q) return;
    try {
      const l = await lerTabela('fin_pagar_baixas?select=' + COLS_BAIXA + '&situacao=in.(pronta,conferir,incerto,baixada)&order=criado_em.desc&limit=5000');
      const nomes = new Map([...(await E.cadastroCondominios(d.clienteSL())).porId.values()].map((c) => [c.id, c.nome]));
      const desde = new Date(Date.now() - 7 * 86400000).toISOString();
      const grupos = new Map();
      for (const b of l) {
        const idc = String(b.id_superlogica);
        if (escopo && !escopo.has(idc)) continue;
        const k = b.analista || 'Sem analista na carteira';
        if (!grupos.has(k)) grupos.set(k, { analista: k, conferir: [], baixadas_sistema_7d: 0, baixadas_pessoa_7d: 0 });
        const g = grupos.get(k);
        if (b.situacao === 'baixada') { if (b.baixado_em > desde) { if (b.baixado_por === 'sistema') g.baixadas_sistema_7d++; else g.baixadas_pessoa_7d++; } continue; }
        g.conferir.push(Object.assign(paraTela(b, q), { condominio: nomes.get(idc) || idc, id_condominio: idc }));
      }
      res.json({ analistas: [...grupos.values()].sort((a, b) => b.conferir.length - a.conferir.length) });
    } catch (e) {
      console.warn('[pagar analistas] ' + (e && e.message));
      res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível montar a lista agora.' });
    }
  });

  app.post('/api/pagar/condominio/:idSuperlogica/procurar', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = idDe(req, res); if (!id) return;
    if (!(await travas(req, res, id))) return;
    const q = await exigirLanca(req, res); if (!q) return;
    if (d.dentroDoLimite && !d.dentroDoLimite(req, 'pagar_procurar', 60)) return res.status(429).json({ erro: 'limite', detalhe: 'Muitas buscas nesta hora. Tente mais tarde.' });
    try {
      const r = await procurar(id, { extrato: true });
      auditar(req, 'pagar_procurar', { id_superlogica: id, novas: r.novas, prontas: r.prontas, conferir: r.conferir });
      res.json(r);
    } catch (e) {
      console.warn('[pagar procurar] ' + id + ': ' + (e && e.message));
      res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível procurar os pagamentos agora.' });
    }
  });

  // Baixa as prontas que a pessoa escolheu (a política pede a confirmação fora do condomínio de teste).
  app.post('/api/pagar/condominio/:idSuperlogica/baixar', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = idDe(req, res); if (!id) return;
    const pedidos = Array.isArray(req.body && req.body.ids) ? [...new Set(req.body.ids.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : [];
    if (!pedidos.length || pedidos.length > 50) return res.status(400).json({ erro: 'lote_invalido', detalhe: 'Escolha de 1 a 50 baixas.' });
    if (!(await travas(req, res, id))) return;
    const q = await exigirLanca(req, res); if (!q) return;
    if (!d.politica) return res.status(423).json({ erro: 'gravacao_bloqueada', detalhe: 'A gravação no Superlógica está desligada.' });
    if (d.politica.bloqueada(req, res, 'pagar_baixa', id, { quantidade: pedidos.length })) return;
    let linhas;
    try { linhas = await lerTabela('fin_pagar_baixas?select=' + COLS_BAIXA + '&id_superlogica=eq.' + id + '&situacao=eq.pronta&id=in.(' + pedidos.join(',') + ')'); } catch (e) {
      return res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'Não foi possível ler as baixas agora.' });
    }
    // Separação: quem lançou a despesa não confirma a baixa dela.
    const minhas = linhas.filter((l) => q.id && l.lancado_por && String(l.lancado_por) === q.id);
    const vale = linhas.filter((l) => !minhas.includes(l)).sort((a, b) => a.id - b.id);
    if (!vale.length) return res.status(409).json({ erro: 'nada_para_baixar', detalhe: minhas.length ? 'Quem lançou a despesa não dá a baixa dela. Peça para outra pessoa confirmar.' : 'Nenhuma dessas baixas está pronta. Atualize a tela.' });
    const total = vale.reduce((s, l) => s + Number(l.valor_pago || 0), 0);
    const aut = await d.politica.autorizar(req, res, { operacao: 'pagar_baixa', id_condominio: id, quantidade: vale.length,
      conteudo: { baixas: vale.map((l) => ({ id: l.id, parcela: String(l.id_parcela), data: l.data_pagamento, valor: Number(l.valor_pago), juros: Number(l.juros), multa: Number(l.multa) })) },
      resumo: { linhas: [{ rotulo: 'Baixas', valor: String(vale.length) }, { rotulo: 'Total pago', valor: 'R$ ' + total.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) }]
        .concat(vale.slice(0, 10).map((l) => ({ rotulo: l.fornecedor || 'Parcela ' + l.id_parcela, valor: 'R$ ' + Number(l.valor_pago).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + ' em ' + String(l.data_pagamento || '').split('-').reverse().join('/') + (Number(l.juros) ? ', juros R$ ' + Number(l.juros).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '') }))),
        aviso: 'Cada baixa leva o comprovante gerado do registro do banco e entra com a data e o valor que o banco mostrou.' } });
    if (!aut) return;
    const resultados = [];
    const inicio = Date.now();
    let feitas = 0;
    for (const l of vale) {
      if (Date.now() - inicio > 90000) { resultados.push({ id: l.id, ok: false, erro: 'nao_tentado', detalhe: 'O lote passou do tempo; esta continua pronta.' }); continue; }
      const r = await executarBaixa(req, l, null, q);
      if (r.ok) feitas++;
      resultados.push(Object.assign({ id: l.id }, r));
    }
    aut.concluir({ ok: feitas > 0, pedidos: pedidos.length, baixadas: feitas });
    res.json({ resultados, puladas_por_ter_lancado: minhas.map((l) => l.id) });
  });

  // Baixa uma que ficou para conferir: a pessoa confere o valor e pode separar juros de multa.
  // Também serve para a que ficou sem confirmação: P.darBaixa relê antes e, se o Superlógica já
  // tiver baixado, não grava de novo (a linha vira descartada com o aviso).
  app.post('/api/pagar/baixas/:id/conferir', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const idb = Number(req.params.id);
    if (!Number.isInteger(idb) || idb <= 0) return res.status(400).json({ erro: 'id_invalido' });
    let l;
    try { l = (await lerTabela('fin_pagar_baixas?select=' + COLS_BAIXA + '&id=eq.' + idb))[0]; } catch (e) { return res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'Não foi possível ler a baixa agora.' }); }
    if (!l) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Baixa não encontrada.' });
    const id = String(l.id_superlogica);
    if (!(await travas(req, res, id))) return;
    const q = await exigirLanca(req, res); if (!q) return;
    if (!['conferir', 'pronta', 'incerto'].includes(l.situacao) || !l.id_parcela) return res.status(409).json({ erro: 'nao_editavel', detalhe: l.id_parcela ? 'Esta baixa não está para conferir.' : 'Pagamento sem parcela no Superlógica: lance a despesa antes.' });
    if (q.id && l.lancado_por && String(l.lancado_por) === q.id) return res.status(403).json({ erro: 'quem_lancou', detalhe: 'Quem lançou a despesa não dá a baixa dela. Peça para outra pessoa conferir.' });
    const b = req.body || {};
    const juros = Number(String(b.juros == null ? l.juros : b.juros).replace(',', '.'));
    const multa = Number(String(b.multa == null ? l.multa : b.multa).replace(',', '.'));
    if (!(juros >= 0 && multa >= 0 && juros < 1e7 && multa < 1e7)) return res.status(400).json({ erro: 'campo_invalido', detalhe: 'Juros e multa precisam ser valores de zero para cima.' });
    const pago = centDe(l.valor_pago), parcela = centDe(l.valor_parcela);
    if (centDe(juros) + centDe(multa) !== pago - parcela) return res.status(400).json({ erro: 'campo_invalido', detalhe: 'Juros mais multa precisam dar a diferença entre o valor pago e o lançado (R$ ' + ((pago - parcela) / 100).toFixed(2).replace('.', ',') + '). Pago a menor ou diferente: corrija a despesa no Superlógica.' });
    if (d.politica.bloqueada(req, res, 'pagar_baixa', id)) return;
    const aut = await d.politica.autorizar(req, res, { operacao: 'pagar_baixa', id_condominio: id,
      conteudo: { baixa: l.id, parcela: String(l.id_parcela), data: l.data_pagamento, valor: Number(l.valor_pago), juros, multa },
      resumo: { linhas: [{ rotulo: 'Fornecedor', valor: l.fornecedor || '' }, { rotulo: 'Pago em', valor: String(l.data_pagamento || '').split('-').reverse().join('/') },
        { rotulo: 'Valor pago', valor: 'R$ ' + Number(l.valor_pago).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) }, { rotulo: 'Juros', valor: 'R$ ' + juros.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) },
        { rotulo: 'Multa', valor: 'R$ ' + multa.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) }, { rotulo: 'Por que ficou para conferir', valor: l.motivo || '' }] } });
    if (!aut) return;
    const r = await executarBaixa(req, l, aut, q, { juros, multa });
    res.status(r.ok ? 200 : r.erro === 'incerto' ? 504 : 409).json(r);
  });

  app.post('/api/pagar/baixas/:id/descartar', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const idb = Number(req.params.id);
    if (!Number.isInteger(idb) || idb <= 0) return res.status(400).json({ erro: 'id_invalido' });
    const motivo = limpar(req.body && req.body.motivo, 300);
    if (motivo.length < 5) return res.status(400).json({ erro: 'sem_motivo', detalhe: 'Diga por que este pagamento não é desta despesa.' });
    let l;
    try { l = (await lerTabela('fin_pagar_baixas?select=id,id_superlogica,situacao&id=eq.' + idb))[0]; } catch (e) { return res.status(503).json({ erro: 'banco_indisponivel' }); }
    if (!l) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Baixa não encontrada.' });
    if (!(await travas(req, res, String(l.id_superlogica)))) return;
    const q = await exigirLanca(req, res); if (!q) return;
    const up = await d.banco('PATCH', '/rest/v1/fin_pagar_baixas?id=eq.' + idb + '&situacao=in.(pronta,conferir,incerto)&select=id', { situacao: 'descartada', motivo, descartado_por_email: q.email, atualizado_em: new Date().toISOString() });
    if (up.status !== 200 || !Array.isArray(up.body) || !up.body[0]) return res.status(409).json({ erro: 'nao_editavel', detalhe: 'Esta baixa já mudou. Atualize a tela.' });
    auditar(req, 'pagar_baixa_descartada', { id_superlogica: String(l.id_superlogica), baixa: idb, motivo });
    res.json({ ok: true });
  });

  // Registro manual do envio para a assinatura (quem assina no banco é o síndico, às vezes com o subsíndico).
  app.post('/api/pagar/condominio/:idSuperlogica/envio', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = idDe(req, res); if (!id) return;
    const b = req.body || {};
    const idp = String(b.id_parcela || '');
    if (!/^[1-9]\d{0,14}$/.test(idp)) return res.status(400).json({ erro: 'parcela_invalida', detalhe: 'Parcela inválida.' });
    if (!['síndico', 'síndico e subsíndico'].includes(b.para)) return res.status(400).json({ erro: 'campo_invalido', detalhe: 'Escolha quem assina: síndico, ou síndico e subsíndico.' });
    if (!(await travas(req, res, id))) return;
    const q = await exigirLanca(req, res); if (!q) return;
    const lido = cache.get(id) && cache.get(id).resultado;
    const parc = lido ? lido.parcelas.find((p) => String(p.id_parcela_pdes) === idp) : null;
    if (!parc) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Parcela não encontrada neste condomínio. Atualize a tela.' });
    const linha = { id_parcela: Number(idp), id_superlogica: Number(id), id_despesa: Number(parc.id_despesa_des) || null, para: b.para, observacao: limpar(b.observacao, 300) || null,
      enviado_em: new Date().toISOString(), enviado_por: q.id, enviado_por_email: q.email };
    const r = await d.banco('POST', '/rest/v1/fin_pagar_envios?select=id_parcela', linha);
    if (r.status === 409) return res.status(409).json({ erro: 'ja_registrado', detalhe: 'O envio desta parcela já foi registrado.' });
    if (r.status !== 201) return res.status(502).json({ erro: 'falha_gravacao', detalhe: 'Não foi possível registrar agora.' });
    auditar(req, 'pagar_envio_assinatura', { id_superlogica: id, id_parcela: idp, para: b.para });
    res.json({ ok: true });
  });

  // Marca uma parcela já lançada para a remessa de pagamento (o arquivo e a assinatura continuam com pessoas).
  app.post('/api/pagar/condominio/:idSuperlogica/remessa', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = idDe(req, res); if (!id) return;
    const idp = String((req.body && req.body.id_parcela) || '');
    if (!/^[1-9]\d{0,14}$/.test(idp)) return res.status(400).json({ erro: 'parcela_invalida', detalhe: 'Parcela inválida.' });
    if (!(await travas(req, res, id))) return;
    const q = await exigirLanca(req, res); if (!q) return;
    if (!d.politica || d.politica.bloqueada(req, res, 'pagar_remessa', id)) { if (!res.headersSent) res.status(423).json({ erro: 'gravacao_bloqueada' }); return; }
    const lido = cache.get(id) && cache.get(id).resultado;
    const antiga = lido ? lido.parcelas.find((p) => String(p.id_parcela_pdes) === idp) : null;
    if (!antiga) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Parcela não encontrada neste condomínio. Atualize a tela.' });
    let parc = null;
    try { parc = await P.parcelaAtual(d.clienteSL(), id, idp, E.slParaIso(antiga.dt_vencimento_pdes)); } catch (e) { parc = null; }
    const motivo = P.motivoSemRemessa(parc, hoje());
    if (motivo) return res.status(409).json({ erro: 'sem_remessa', detalhe: motivo });
    const aut = await d.politica.autorizar(req, res, { operacao: 'pagar_remessa', id_condominio: id, conteudo: { parcela: idp, valor: parc.vl_valor_pdes, vencimento: E.slParaIso(parc.dt_vencimento_pdes) },
      resumo: { linhas: [{ rotulo: 'Fornecedor', valor: String(parc.st_nome_con || '') }, { rotulo: 'Valor', valor: 'R$ ' + Number(parc.vl_valor_pdes).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) },
        { rotulo: 'Vencimento', valor: String(E.slParaIso(parc.dt_vencimento_pdes) || '').split('-').reverse().join('/') }, { rotulo: 'Forma', valor: P.NOME_FORMA[Number(parc.id_forma_pag)] || '' }],
        aviso: 'Só marca a parcela. Gerar o arquivo, enviar ao banco e assinar continuam com as pessoas.' } });
    if (!aut) return;
    const r = await P.marcarRemessa(d.credSL(), d.clienteSL(), parc, hoje());
    aut.concluir({ ok: !!r.ok, incerto: !!r.incerto, id_parcela: idp });
    if (cache.get(id)) cache.get(id).ate = 0; // relê na próxima vez
    res.status(r.ok ? 200 : r.incerto ? 504 : 409).json(r.ok ? { ok: true } : { erro: r.incerto ? 'incerto' : 'recusado', detalhe: r.msg });
  });

  app.put('/api/pagar/condominio/:idSuperlogica/esperadas/:chave', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = idDe(req, res); if (!id) return;
    const chave = String(req.params.chave || '');
    if (!/^f[0-9]{1,15}$/.test(chave)) return res.status(400).json({ erro: 'chave_invalida' });
    if (!(await travas(req, res, id))) return;
    const q = await exigirLanca(req, res); if (!q) return;
    const ignorar = !!(req.body && req.body.ignorar);
    const motivo = limpar(req.body && req.body.motivo, 300) || null;
    if (ignorar && !motivo) return res.status(400).json({ erro: 'sem_motivo', detalhe: 'Diga por que esta conta não é mais esperada (contrato encerrado, por exemplo).' });
    const r = await d.banco('POST', '/rest/v1/fin_pagar_esperadas?on_conflict=id_superlogica,chave&select=chave', { id_superlogica: Number(id), chave, ignorada: ignorar, motivo, por: q.id, por_email: q.email, em: new Date().toISOString() });
    if (!(r.status >= 200 && r.status < 300)) {
      const up = await d.banco('PATCH', '/rest/v1/fin_pagar_esperadas?id_superlogica=eq.' + id + '&chave=eq.' + chave + '&select=chave', { ignorada: ignorar, motivo, por: q.id, por_email: q.email, em: new Date().toISOString() });
      if (up.status !== 200) return res.status(502).json({ erro: 'falha_gravacao', detalhe: 'Não foi possível guardar agora.' });
    }
    auditar(req, 'pagar_esperada', { id_superlogica: id, chave, ignorada: ignorar });
    res.json({ ok: true });
  });

  // Pacote do lançamento completo (parcelas, rateio, Pix, remessa) guardado no rascunho da entrada.
  // Quem lança é a própria entrada de documentos (POST /api/entrada/:id/lancar), que usa o pacote.
  app.put('/api/pagar/entrada/:id/completo', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const idE = String(req.params.id || '');
    if (!UUID.test(idE)) return res.status(400).json({ erro: 'id_invalido' });
    let L;
    try { L = (await lerTabela('fin_entrada?select=id,status,id_superlogica,dados,criado_por&id=eq.' + idE))[0]; } catch (e) { return res.status(503).json({ erro: 'banco_indisponivel' }); }
    if (!L || !L.id_superlogica) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Rascunho não encontrado ou sem condomínio.' });
    const id = String(L.id_superlogica);
    if (!(await travas(req, res, id))) return;
    const q = await exigirLanca(req, res); if (!q) return;
    if (L.status !== 'rascunho') return res.status(409).json({ erro: 'nao_editavel', detalhe: 'Só rascunho pode ser editado.' });
    const b = req.body || {};
    const dados = Object.assign({}, L.dados);
    if (b.limpar === true) { delete dados.pagar; }
    else {
      const cli = d.clienteSL();
      const cond = await E.condominioPorId(cli, id);
      const contas = cond ? await E.contasDoPlano(cli, cond.plano) : [];
      if (b.forma_pag !== undefined) { const fp = Number(b.forma_pag); if (![0, 7, 8, 9, 12, 13, 14].includes(fp)) return res.status(400).json({ erro: 'campo_invalido', detalhe: 'Forma de pagamento inválida.' }); dados.forma_pag = fp; }
      const pacote = { parcelas: Array.isArray(b.parcelas) ? b.parcelas.slice(0, 30) : null, rateio: Array.isArray(b.rateio) ? b.rateio.slice(0, 30) : null,
        pix: b.pix && typeof b.pix === 'object' ? { chave: limpar(b.pix.chave, 80), tipo: b.pix.tipo ? String(b.pix.tipo) : null } : null, copia_cola: b.copia_cola ? String(b.copia_cola).slice(0, 600) : null, remessa: b.remessa === true };
      const c = P.conferirPacote(dados, pacote, contas, hoje());
      if (c.erro) return res.status(400).json({ erro: 'pacote_invalido', detalhe: c.erro });
      dados.forma_pag = c.ok.forma;
      dados.pagar = { parcelas: c.ok.parcelas, rateio: c.ok.rateio.map((r) => ({ conta: r.conta, valor_centavos: r.valor_centavos, complemento: r.complemento })), pix: c.ok.pix ? { tipo: c.ok.pix.tipo, chave: c.ok.pix.chave } : null,
        copia_cola: c.ok.copia_cola, remessa: c.ok.remessa, por: q.email, em: new Date().toISOString() };
      if (c.ok.rateio[0]) { dados.conta = c.ok.rateio[0].conta; dados.nome_conta = c.ok.rateio[0].nome; dados.conta_sugerida = false; }
    }
    dados.pronto = null;
    const up = await d.banco('PATCH', '/rest/v1/fin_entrada?id=eq.' + idE + '&status=eq.rascunho&select=id,dados', { dados, atualizado_em: new Date().toISOString() });
    if (up.status !== 200 || !Array.isArray(up.body) || !up.body[0]) return res.status(409).json({ erro: 'nao_editavel', detalhe: 'O rascunho mudou. Abra de novo.' });
    auditar(req, 'pagar_pacote', { id_superlogica: id, entrada: idE, parcelas: dados.pagar ? dados.pagar.parcelas.length : 0, rateio: dados.pagar ? dados.pagar.rateio.length : 0, pix: !!(dados.pagar && dados.pagar.pix), remessa: !!(dados.pagar && dados.pagar.remessa) });
    res.json({ ok: true, pagar: dados.pagar || null, forma_pag: dados.forma_pag });
  });

  // ── fornecedor novo ──
  app.get('/api/pagar/fornecedores', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await d.exigirFinanceiro(req, res, 'ver'))) return;
    let escopo;
    try { escopo = await d.escopoFinanceiro(req); } catch (e) { return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' }); }
    const q = await quem(req, res); if (!q) return;
    try {
      const l = await lerTabela('fin_pagar_fornecedores?select=*&order=pedido_em.desc&limit=200');
      res.json({ pode_aprovar: q.gestor, itens: l.filter((x) => !escopo || escopo.has(String(x.id_superlogica))).map((x) => ({ id: x.id, id_superlogica: x.id_superlogica, entrada: x.entrada, cnpj: E.formatarCnpj(x.cnpj),
        nome: x.dados && x.dados.nome, pix: x.dados && x.dados.pix ? { tipo: P.NOME_TIPO_PIX[x.dados.pix.tipo] || x.dados.pix.tipo, chave: x.dados.pix.chave } : null,
        banco: x.dados && x.dados.banco ? { banco: x.dados.banco.banco, agencia: x.dados.banco.agencia, conta_final: '***' + String(x.dados.banco.conta).slice(-4) } : null,
        situacao: x.situacao, motivo: x.motivo, pedido_por: x.pedido_por_email, pedido_em: x.pedido_em, aprovado_por: x.aprovado_por_email, aprovado_em: x.aprovado_em, id_contato: x.id_contato,
        eu_pedi: !!(q.id && x.pedido_por && String(x.pedido_por) === q.id) })) });
    } catch (e) { res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'Não foi possível ler os pedidos agora.' }); }
  });

  // Pedido de fornecedor novo (a partir do rascunho da entrada, que traz o CNPJ do documento).
  app.post('/api/pagar/fornecedores', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    const id = String(b.id_superlogica || '');
    if (!ID.test(id) || NAO_CONDOMINIOS.has(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Escolha o condomínio.' });
    if (b.entrada && !UUID.test(String(b.entrada))) return res.status(400).json({ erro: 'id_invalido' });
    if (!(await travas(req, res, id))) return;
    const q = await exigirLanca(req, res); if (!q) return;
    const f = P.conferirFornecedor(b);
    if (f.erro) return res.status(400).json({ erro: 'campo_invalido', detalhe: f.erro });
    try {
      const ja = await E.fornecedorPorCnpj(d.clienteSL(), f.ok.cnpj);
      if (ja) return res.status(409).json({ erro: 'ja_existe', detalhe: 'Esse fornecedor já está cadastrado no Superlógica (código ' + ja.id + ').', id_contato: ja.id });
    } catch (e) { return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível conferir o CNPJ no Superlógica agora.' }); }
    const r = await d.banco('POST', '/rest/v1/fin_pagar_fornecedores?select=id', { id_superlogica: Number(id), entrada: b.entrada || null, cnpj: f.ok.cnpj, dados: f.ok, situacao: 'pendente',
      pedido_por: q.id, pedido_por_email: q.email, pedido_em: new Date().toISOString() });
    if (r.status === 409) return res.status(409).json({ erro: 'ja_pedido', detalhe: 'Já existe um pedido aberto para esse CNPJ.' });
    if (r.status !== 201) return res.status(502).json({ erro: 'falha_gravacao', detalhe: 'Não foi possível guardar o pedido agora.' });
    auditar(req, 'pagar_fornecedor_pedido', { id_superlogica: id, cnpj_final: f.ok.cnpj.slice(-4), pix: !!f.ok.pix, banco: !!f.ok.banco });
    res.json({ ok: true, id: r.body && r.body[0] && r.body[0].id });
  });

  // Aprovação (gestor ou gerente, nunca quem pediu) e gravação no Superlógica pela política.
  // Com chave Pix ou conta, a pessoa diz como confirmou com o fornecedor (telefone, por exemplo).
  app.post('/api/pagar/fornecedores/:id/aprovar', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const idf = String(req.params.id || '');
    if (!UUID.test(idf)) return res.status(400).json({ erro: 'id_invalido' });
    let x;
    try { x = (await lerTabela('fin_pagar_fornecedores?select=*&id=eq.' + idf))[0]; } catch (e) { return res.status(503).json({ erro: 'banco_indisponivel' }); }
    if (!x) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Pedido não encontrado.' });
    const id = String(x.id_superlogica);
    if (!(await travas(req, res, id))) return;
    const q = await quem(req, res); if (!q) return;
    if (!q.gestor) return res.status(403).json({ erro: 'sem_permissao', detalhe: 'Só gestor ou gerente aprova fornecedor novo.' });
    if (q.id && x.pedido_por && String(x.pedido_por) === q.id) return res.status(403).json({ erro: 'quem_pediu', detalhe: 'Quem pediu o cadastro não aprova. Peça para outro gestor ou gerente.' });
    if (x.situacao !== 'pendente') return res.status(409).json({ erro: 'nao_editavel', detalhe: 'Este pedido não está pendente.' });
    const f = x.dados || {};
    const como = limpar(req.body && req.body.confirmado_como, 300);
    if ((f.pix || f.banco) && como.length < 8) return res.status(400).json({ erro: 'sem_confirmacao_pagamento', detalhe: 'Diga como a chave Pix ou a conta foi confirmada com o fornecedor (por exemplo: ligação para o telefone da nota, com quem falou).' });
    if (d.politica.bloqueada(req, res, 'pagar_fornecedor', id)) return;
    const aut = await d.politica.autorizar(req, res, { operacao: 'pagar_fornecedor', id_condominio: id, conteudo: { pedido: idf, cnpj: x.cnpj, nome: f.nome, pix: f.pix || null, banco: f.banco || null },
      resumo: { linhas: [{ rotulo: 'Fornecedor', valor: f.nome }, { rotulo: 'CNPJ ou CPF', valor: E.formatarCnpj(x.cnpj) },
        { rotulo: 'Chave Pix', valor: f.pix ? (P.NOME_TIPO_PIX[f.pix.tipo] || '') + ' ' + f.pix.chave : 'nenhuma' }, { rotulo: 'Conta', valor: f.banco ? 'banco ' + f.banco.banco + ', agência ' + f.banco.agencia + ', conta ***' + String(f.banco.conta).slice(-4) : 'nenhuma' },
        { rotulo: 'Confirmado com o fornecedor', valor: como || 'sem dados de pagamento' }, { rotulo: 'Pedido por', valor: x.pedido_por_email || '' }],
        aviso: 'O cadastro de fornecedor vale para todos os condomínios do Superlógica.' } });
    if (!aut) return;
    const trava = await d.banco('PATCH', '/rest/v1/fin_pagar_fornecedores?id=eq.' + idf + '&situacao=eq.pendente&select=id', { situacao: 'gravando', aprovado_por: q.id, aprovado_por_email: q.email, aprovado_em: new Date().toISOString(), pagamento_confirmado_como: como || null, atualizado_em: new Date().toISOString() });
    if (trava.status !== 200 || !Array.isArray(trava.body) || !trava.body[0]) { aut.concluir({ ok: false, pedido: idf, erro: 'mudou' }); return res.status(409).json({ erro: 'nao_editavel', detalhe: 'O pedido mudou. Atualize a tela.' }); }
    let r;
    try { r = await P.cadastrarFornecedor(d.credSL(), d.clienteSL(), id, Object.assign({}, f, { forma: f.pix ? P.FORMA.pix : undefined })); } catch (e) { r = { ok: false, incerto: true, msg: 'Erro no meio do cadastro. Confira no Superlógica pelo CNPJ.' }; }
    const fim = r.ok ? { situacao: 'gravado', id_contato: Number(r.id), motivo: r.ja_existia ? 'Já existia no Superlógica.' : (f.pix && r.pix_gravado === false ? 'Cadastrado, mas a chave Pix não apareceu no cadastro: confira no Superlógica.' : null) }
      : r.incerto ? { situacao: 'incerto', motivo: limpar(r.msg, 500) } : { situacao: 'recusado', motivo: limpar(r.msg, 500) };
    await d.banco('PATCH', '/rest/v1/fin_pagar_fornecedores?id=eq.' + idf, Object.assign(fim, { atualizado_em: new Date().toISOString() }));
    aut.concluir({ ok: !!r.ok, incerto: !!r.incerto, pedido: idf, id_contato: r.id || null });
    // O rascunho que pediu o fornecedor passa a ter o código dele (só se ainda for rascunho).
    if (r.ok && x.entrada) {
      try {
        const L = (await lerTabela('fin_entrada?select=id,status,dados&id=eq.' + x.entrada))[0];
        if (L && L.status === 'rascunho') await d.banco('PATCH', '/rest/v1/fin_entrada?id=eq.' + x.entrada + '&status=eq.rascunho', { dados: Object.assign({}, L.dados, { id_fornecedor: String(r.id), nome_fornecedor: r.nome || f.nome }), atualizado_em: new Date().toISOString() });
      } catch (e) { /* a pessoa escolhe o fornecedor no rascunho */ }
    }
    E.limparCache(['forn:' + x.cnpj]);
    auditar(req, 'pagar_fornecedor_aprovado', { id_superlogica: id, pedido: idf, ok: !!r.ok, incerto: !!r.incerto }, !r.ok);
    res.status(r.ok ? 200 : r.incerto ? 504 : 409).json(r.ok ? { ok: true, id_contato: r.id, ja_existia: !!r.ja_existia } : { erro: r.incerto ? 'incerto' : 'recusado', detalhe: r.msg });
  });

  app.post('/api/pagar/fornecedores/:id/cancelar', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const idf = String(req.params.id || '');
    if (!UUID.test(idf)) return res.status(400).json({ erro: 'id_invalido' });
    let x;
    try { x = (await lerTabela('fin_pagar_fornecedores?select=id,id_superlogica,situacao&id=eq.' + idf))[0]; } catch (e) { return res.status(503).json({ erro: 'banco_indisponivel' }); }
    if (!x) return res.status(404).json({ erro: 'nao_encontrado' });
    if (!(await travas(req, res, String(x.id_superlogica)))) return;
    const q = await exigirLanca(req, res); if (!q) return;
    const up = await d.banco('PATCH', '/rest/v1/fin_pagar_fornecedores?id=eq.' + idf + '&situacao=eq.pendente&select=id', { situacao: 'cancelado', motivo: limpar(req.body && req.body.motivo, 300) || 'Cancelado por ' + q.email, atualizado_em: new Date().toISOString() });
    if (up.status !== 200 || !Array.isArray(up.body) || !up.body[0]) return res.status(409).json({ erro: 'nao_editavel', detalhe: 'Este pedido não está pendente.' });
    res.json({ ok: true });
  });

  // Rotina agendada: de 30 em 30 minutos nos dias úteis, das 7h às 20h (horário de Brasília).
  function agendar() {
    let rodando = false;
    const t = setInterval(async () => {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
      if (['Sat', 'Sun'].includes(p.weekday) || Number(p.hour) < 7 || Number(p.hour) >= 20 || rodando) return;
      rodando = true;
      try { const r = await rodarRotina(); if (r.condominios) console.log('[pagar] rotina: ' + r.condominios + ' condomínio(s) conferido(s)'); } catch (e) { console.warn('[pagar] rotina falhou: ' + (e && e.message)); }
      rodando = false;
    }, 30 * 60 * 1000);
    if (typeof t.unref === 'function') t.unref();
    return t;
  }

  return { procurar, rodarRotina, executarBaixa, agendar, cache, montar };
}

module.exports = { registrar, REQ_SISTEMA };
