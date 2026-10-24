'use strict';
// ─────────────────────────────────────────────────────────────────────────
// Balancete digital e fechamento do mês feitos pelo sistema: rotas, documentos recebidos e o
// agendamento do próprio Hub. Lógica em financeiro/balancete-digital.js.
//
// Agendamento (BALANCETE_AGENDA: off | teste, padrão | todos): às 6h, 11h e 16h (Brasília) o Hub
// acompanha cada condomínio. Do dia 1 ao 15 trabalha o mês anterior: aprende o modelo (se não tem),
// junta os documentos, grava os comentários com anexo e etiqueta, gera o 900A depois do fechamento
// confirmado e confere o PDF. No último dia do mês aprende o modelo e acompanha o próprio mês.
// "teste" roda só nos condomínios de teste da política (ESCRITA_TESTE, padrão 167); "todos" roda
// na base inteira, e fora do teste a gravação continua esperando a confirmação de uma pessoa
// (política única, servico/escrita-superlogica.js). O fechamento e a publicação são sempre
// confirmados por uma pessoa.
//
// Rotas (/api/financeiro/balancete-digital):
//   GET  /painel?competencia=AAAA-MM[&carteira=]       o que trava cada condomínio, a causa e quem age
//   GET  /:id/situacao?competencia=AAAA-MM[&forcar=1]  travas, etapa, prazo, modelo e montagem
//   POST /:id/modelo/aprender { competencia }           lê os comentários dos últimos 3 meses (só leitura)
//   POST /:id/modelo { itens }                          a pessoa confere e confirma o modelo
//   POST /:id/documento { competencia, chave, nome, pdf_base64 }  documento que precisa chegar (extrato etc.)
//   POST /:id/montar { competencia }                    monta agora (mesma rotina do agendamento)
//   POST /:id/fechar-mes { competencia }                confirmação do fechamento (só com tudo verde)
//   POST /:id/reabrir-mes { competencia, motivo }       só gestor ou gerente, motivo obrigatório
//   GET  /:id/fechamentos                               quem fechou e reabriu, quando e por quê
// ─────────────────────────────────────────────────────────────────────────
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const D = require('./balancete-digital');
const B = require('./balancete');
const { criarBanco } = require('./banco');

const ID = /^[1-9][0-9]{0,8}$/;
const BUCKET = 'balancete-digital';
const ESPERA_ROTA = 25000;
const HORAS_AGENDA = [6, 11, 16];
const MESES_APRENDER = 3;
const QUEM_SISTEMA = 'Sistema (agendamento do Hub)';

function criarRotasBalanceteDigital(app, d) {
  const { requireAuth, express, dentroDoLimite, exigirFinanceiro, exigirModuloItem, exigirLeituraSuperlogica, exigirEscritaSuperlogica, exigirCarteira, carteiraEstrita,
    exigirEscopoFinanceiro, escopoFinanceiro, gruposCarteiras, clienteSL, credSL, politica, auditoria, fechamentoT38, painelFin, condominios, supabase } = d;
  const hoje = d.hoje || (() => D.hojeSP());
  const log = d.log || ((m) => console.warn(m));

  let _banco;
  function banco() {
    if (_banco !== undefined) return _banco;
    try { _banco = d.banco || criarBanco({ url: supabase.url, chave: supabase.chave }); } catch (e) { _banco = null; }
    return _banco;
  }
  const auditar = (req, acao, det, susp, motivo) => { try { auditoria.evento(req, acao, det, !!susp, motivo); } catch (e) { /* auditoria nunca derruba */ } };

  // ── documentos recebidos (Supabase Storage, bucket privado) ───────────
  const storage = d.storage || {
    enviar: (caminho, buf) => pedirStorage('POST', caminho, buf),
    baixar: (caminho) => pedirStorage('GET', caminho, null),
  };
  function pedirStorage(metodo, caminho, buf) {
    return new Promise((ok, falha) => {
      if (!supabase.url || !supabase.chave) return falha(new Error('supabase_nao_configurado'));
      const u = new URL(supabase.url.replace(/\/$/, '') + '/storage/v1/object/' + BUCKET + '/' + caminho);
      const r = https.request({ hostname: u.hostname, path: u.pathname, method: metodo, headers: Object.assign({ authorization: 'Bearer ' + supabase.chave, apikey: supabase.chave },
        buf ? { 'content-type': 'application/pdf', 'content-length': buf.length, 'x-upsert': 'true' } : {}) }, (resp) => {
        const p = []; let n = 0;
        resp.on('data', (c) => { n += c.length; if (n <= D.MAX_ARQUIVO + 1024) p.push(c); });
        resp.on('end', () => (resp.statusCode >= 200 && resp.statusCode < 300 ? ok(Buffer.concat(p)) : falha(new Error('storage_' + resp.statusCode))));
      });
      r.setTimeout(120000, () => r.destroy(new Error('storage_tempo')));
      r.on('error', falha);
      r.end(buf || undefined);
    });
  }

  // ── banco ─────────────────────────────────────────────────────────────
  async function lerModelo(id) {
    const b = banco(); if (!b) return null;
    const l = await b.ler('fin_balancete_modelo?select=*&id_superlogica=eq.' + id);
    return l && l[0] ? l[0] : null;
  }
  async function lerDocumentos(id, comp) {
    const b = banco(); if (!b) return new Map();
    const l = await b.ler('fin_balancete_documento?select=chave_item,sha256,caminho,nome,bytes,origem,enviado_por_email,recebido_em&id_superlogica=eq.' + id + '&competencia=eq.' + comp);
    // Vários PDFs no mesmo item: o 1º fica em "<chave>", os outros em "<chave>__2", "__3"... (sem mudar a tabela).
    const m = new Map();
    (l || []).sort((a, b) => String(a.recebido_em).localeCompare(String(b.recebido_em))).forEach((x) => { const k = String(x.chave_item).replace(/__\d+$/, ''); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
    return m;
  }
  async function lerMontagem(id, comp) {
    const b = banco(); if (!b) return {};
    const l = await b.ler('fin_balancete_montagem?select=*&id_superlogica=eq.' + id + '&competencia=eq.' + comp);
    const o = {}; (l || []).forEach((x) => { o[x.chave_item] = x; });
    return o;
  }
  async function gravarMontagem(id, comp, item, r, por) {
    const b = banco(); if (!b) return;
    const linha = { id_superlogica: Number(id), competencia: comp, chave_item: item.chave, titulo: item.titulo, conta: item.conta, etiqueta_id: item.etiqueta_id || null,
      fonte: item.fonte && item.fonte.tipo === 'relatorio' ? 'relatorio:' + item.fonte.codigo : (item.fonte && item.fonte.tipo) || '', estado: r.estado,
      id_arquivo: r.id_arquivo ? Number(r.id_arquivo) : null, id_comentario: r.id_comentario ? Number(r.id_comentario) : null,
      visibilidade: r.visibilidade == null ? null : Number(r.visibilidade), alerta: r.alerta || null, msg: String(r.msg || '').slice(0, 300), por, atualizado_em: new Date().toISOString() };
    await b.upsert('fin_balancete_montagem', [linha], 'id_superlogica,competencia,chave_item').catch((e) => log('[balancete-digital] montagem não registrada: ' + e.message));
  }

  // ── travas comuns das rotas ───────────────────────────────────────────
  function validar(req, res, exigeFim) {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!ID.test(id) || D.NAO_CONDOMINIOS.has(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código de condomínio inválido.' }); return null; }
    const c = D.competencia(String((req.query && req.query.competencia) || (req.body && req.body.competencia) || ''));
    if (!c) { res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe o mês no formato AAAA-MM.' }); return null; }
    if (c.inicio > hoje()) { res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Escolha um mês que já começou.' }); return null; }
    if (exigeFim && c.fim >= hoje()) { res.status(400).json({ erro: 'mes_aberto', detalhe: 'O mês ainda não terminou.' }); return null; }
    return { id, c };
  }
  async function podeVer(req, res, id) {
    if (!(await exigirFinanceiro(req, res, 'ver'))) return false;
    if (!(await exigirModuloItem(req, res, 'balancete', 'ver'))) return false;
    if (!(await exigirLeituraSuperlogica(req, res))) return false;
    if (id && !(await exigirCarteira(req, res, id))) return false;
    if (id && !(await exigirEscopoFinanceiro(req, res, id))) return false;
    return true;
  }
  async function podeGravar(req, res, id) {
    if (!(await podeVer(req, res, id))) return false;
    if (!(await exigirModuloItem(req, res, 'balancete', 'gerar'))) return false;
    if (!(await exigirFinanceiro(req, res, 'pre_balancete'))) return false;
    return carteiraEstrita(req, res, id);
  }
  const quemDe = (req) => (req.user && req.user.email) || (req.authMode === 'agendamento' ? QUEM_SISTEMA : 'interno');

  // Pedido "de sistema" para o agendamento: passa pela política (livre só no teste) e pela auditoria.
  function reqSistema() {
    return { authMode: 'agendamento', user: { sub: null, email: QUEM_SISTEMA }, method: 'AGENDA', originalUrl: '/agenda/balancete-digital', headers: { 'user-agent': 'agendamento do Hub' }, socket: { remoteAddress: 'agendamento' }, body: {} };
  }
  function resSilenciosa() {
    const r = { statusCode: 200, corpo: null, status(s) { r.statusCode = s; return r; }, json(j) { r.corpo = j; return r; }, set() { return r; } };
    return r;
  }

  // ── nome e plano de contas do condomínio ──────────────────────────────
  async function cadastro(id) {
    try { const l = await condominios(); const c = (l || []).find((x) => String(x.id) === String(id)); if (c) return c; } catch (e) { /* segue */ }
    return { id: String(id), nome: 'Condomínio ' + id, plano: '' };
  }

  // ── aprender o modelo (só leitura) ────────────────────────────────────
  async function aprender(id, comp) {
    const cli = clienteSL();
    const c = D.competencia(comp);
    const porMes = {};
    // Os meses ANTERIORES ao mês que vai ser montado (o próprio mês ainda não tem os comentários).
    for (let k = 1; k <= MESES_APRENDER; k++) {
      const m = D.somarMeses(c, -k).chave;
      // Primeiro o balão do Demonstrativo R&D (onde a equipe põe); só sem nada lá, as notas por conta.
      let l = [];
      try { l = await D.comentariosDoMes(cli, id, m, null); } catch (e) { l = []; }
      if (!l.length) {
        const cc = D.competencia(m);
        let contas = [];
        try {
          const j = await cli.get('balancetes/index', { idCondominio: id, dtInicio: String(cc.mes).padStart(2, '0') + '/01/' + cc.ano, dtFim: String(cc.mes).padStart(2, '0') + '/' + cc.ultimoDia + '/' + cc.ano });
          (Array.isArray(j) ? j : []).forEach((b) => ((b && b.itens) || []).forEach((g) => (g || []).forEach((x) => { const s = String((x && x.conta) || '').trim(); if (/^\d+(\.\d+){0,2}$/.test(s)) contas.push(s); })));
        } catch (e) { contas = []; }
        contas = [...new Set(contas)].slice(0, 60);
        for (const conta of contas) { try { l = l.concat(await D.comentariosDoMes(cli, id, m, conta)); } catch (e) { /* conta sem comentário */ } }
      }
      porMes[m] = l;
    }
    const cad = await cadastro(id);
    const modelo = D.aprenderModelo(porMes, { plano: cad.plano });
    if (!modelo.plano && cad.plano) modelo.plano = cad.plano;
    // Etiqueta pelo nome quando o comentário lido não trouxe o id.
    try {
      const etqs = await D.etiquetasDoSuperlogica(cli);
      modelo.itens.forEach((i) => { if (!i.etiqueta_id && i.etiqueta_nome) { const e = etqs.find((x) => x.nome.toLowerCase() === i.etiqueta_nome.toLowerCase()); if (e) i.etiqueta_id = e.id; } });
      modelo.etiquetas = etqs;
    } catch (e) { modelo.etiquetas = []; }
    return modelo;
  }
  async function salvarModelo(id, modelo, confirmadoPor) {
    const b = banco(); if (!b) throw new Error('banco_indisponivel');
    const linha = { id_superlogica: Number(id), id_planoconta: /^\d+$/.test(String(modelo.plano || '')) ? Number(modelo.plano) : null, itens: modelo.itens, as_vezes: modelo.as_vezes || [],
      meses_lidos: modelo.meses_lidos || [], avisos: modelo.avisos || [], origem: confirmadoPor ? 'confirmado' : 'aprendido', confirmado: !!confirmadoPor,
      confirmado_por_email: confirmadoPor || null, confirmado_em: confirmadoPor ? new Date().toISOString() : null, aprendido_em: modelo.aprendido_em || null, atualizado_em: new Date().toISOString() };
    await b.upsert('fin_balancete_modelo', [linha], 'id_superlogica');
    return linha;
  }
  function modeloDaLinha(l) { return l ? { plano: l.id_planoconta ? String(l.id_planoconta) : '', itens: l.itens || [], as_vezes: l.as_vezes || [], avisos: l.avisos || [], confirmado: !!l.confirmado, confirmado_por: l.confirmado_por_email || '', meses_lidos: l.meses_lidos || [] } : null; }

  // ── montagem ──────────────────────────────────────────────────────────
  const emMontagem = new Set();
  const pedidosRelatorio = new Map(); // id|comp|codigo -> horário do último pedido sem resposta
  async function obterDocumento(id, c, item, docs, nome) {
    if (item.fonte.tipo === 'capa') return { buffer: D.montarCapa(nome, c.chave), nome: 'Capa ' + c.rotulo.replace('/', '-') };
    if (item.fonte.tipo === 'relatorio') {
      const k = id + '|' + c.chave + '|' + item.fonte.codigo;
      if (Date.now() - (pedidosRelatorio.get(k) || 0) < 15 * 60000) return { aguardar: true };
      const r = await D.gerarRelatorio(credSL(), id, item.fonte.codigo, c.chave, { baixar: baixarImpressaoBuffer });
      if (r.aguardar) { pedidosRelatorio.set(k, Date.now()); return { aguardar: true }; }
      pedidosRelatorio.delete(k);
      return { buffer: r.buffer, nome: item.titulo };
    }
    const recebidos = docs.get(item.chave) || [];
    if (!recebidos.length) return { falta: true };
    const lista = [];
    // Extratos das poupanças: primeiro a movimentação de cada conta (018B), depois os PDFs do banco.
    if (item.fonte.movimentacao === '018B') {
      const k = id + '|' + c.chave + '|018B';
      if (Date.now() - (pedidosRelatorio.get(k) || 0) < 15 * 60000) return { aguardar: true };
      const mv = await D.gerarMovimentacoes(credSL(), clienteSL(), id, c.chave, { baixar: baixarImpressaoBuffer });
      if (mv.aguardar) { pedidosRelatorio.set(k, Date.now()); return { aguardar: true }; }
      pedidosRelatorio.delete(k);
      mv.documentos.forEach((d) => lista.push({ buffer: d.buffer, nome: d.nome }));
    }
    for (const doc of recebidos) {
      const buf = await storage.baixar(doc.caminho);
      if (crypto.createHash('sha256').update(buf).digest('hex') !== doc.sha256) throw Object.assign(new Error('documento_alterado'), { codigo: 'documento' });
      lista.push({ buffer: buf, nome: doc.nome || item.titulo });
    }
    return { lista };
  }
  async function baixarImpressaoBuffer(idImp) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bal-dig-'));
    try { const arq = path.join(tmp, 'r.pdf'); await B.baixarImpressao(credSL(), idImp, arq); return fs.readFileSync(arq); }
    finally { fs.rm(tmp, { recursive: true, force: true }, () => {}); }
  }

  // Monta o que falta de um condomínio e mês. aut: autorização da política (já concedida).
  async function montar(id, c, aut, por) {
    const chave = id + '|' + c.chave;
    if (emMontagem.has(chave)) return { ocupado: true };
    emMontagem.add(chave);
    const resumo = { gravados: 0, ja_existiam: 0, falhas: 0, incertos: 0, aguardando: 0, faltando: 0 };
    try {
      let linha = await lerModelo(id);
      if (!linha) { const mdl = await aprender(id, c.chave); if (mdl.itens.length) linha = await salvarModelo(id, mdl, null); }
      const modelo = modeloDaLinha(linha);
      if (!modelo || !modelo.itens.length) return Object.assign(resumo, { sem_modelo: true });
      const cad = await cadastro(id);
      const plano = modelo.plano || cad.plano;
      const [docs, feito] = await Promise.all([lerDocumentos(id, c.chave), lerMontagem(id, c.chave)]);
      const ctx = { cred: credSL(), cliente: clienteSL(), idCond: id, plano, comp: c.chave };
      for (const item of modelo.itens) {
        const ant = feito[item.chave];
        if (ant && (ant.estado === 'gravado' || ant.estado === 'ja_existia')) continue;
        let r;
        try {
          // Antes de juntar qualquer documento (o 74A e o 11A criam impressão no Superlógica), relê:
          // se o comentário já está no mês, não gera nada e não grava nada.
          const ja = await D.procurarComentario(ctx, item);
          if (ja && ja.arquivos.length) {
            resumo.ja_existiam++;
            await gravarMontagem(id, c.chave, item, { estado: 'ja_existia', id_comentario: ja.id, id_arquivo: ja.arquivos[0].id, visibilidade: ja.visibilidade, msg: 'O comentário já estava no Demonstrativo R&D.' }, por);
            continue;
          }
          const doc = await obterDocumento(id, c, item, docs, cad.nome);
          if (doc.falta) { resumo.faltando++; await gravarMontagem(id, c.chave, item, { estado: 'falta_documento', msg: item.fonte.descricao + ' não chegou.' }, por); continue; }
          if (doc.aguardar) { resumo.aguardando++; await gravarMontagem(id, c.chave, item, { estado: 'aguardar', msg: 'O Superlógica está gerando o relatório.' }, por); continue; }
          // Incerto de antes: no agendamento só relê (nunca repete a gravação sem prova); a pessoa pode mandar de novo.
          r = await D.gravarComentario(ctx, item, doc.lista || doc, { soReler: ant && ant.estado === 'incerto' && por === QUEM_SISTEMA });
        } catch (e) {
          if (e && e.codigo === 'trava_condominio') throw e;
          r = { estado: 'falhou', msg: e && e.codigo === 'documento' ? 'O documento recebido mudou depois de conferido. Envie de novo.' : 'Falha ao preparar o documento.' };
        }
        await gravarMontagem(id, c.chave, item, r, por);
        if (r.estado === 'gravado') resumo.gravados++; else if (r.estado === 'ja_existia') resumo.ja_existiam++; else if (r.estado === 'incerto') resumo.incertos++; else resumo.falhas++;
      }
      return resumo;
    } finally {
      emMontagem.delete(chave);
      if (aut) aut.concluir(Object.assign({ ok: resumo.falhas === 0 && resumo.incertos === 0, competencia: c.chave }, resumo));
    }
  }

  // ── situação (travas, etapa e prazo) ──────────────────────────────────
  const calculando = new Map();
  async function calcularSituacao(req, id, c, forcar, automatico) {
    const chave = id + '|' + c.chave;
    if (calculando.has(chave)) return calculando.get(chave);
    const p = (async () => {
      const cli = clienteSL();
      const erroLeitura = [];
      const tenta = async (fn, etapa, causa) => { try { return await fn(); } catch (e) { erroLeitura.push({ etapa, causa }); return null; } };
      const compT38 = { rotulo: c.chave, inicio: c.inicio, fim: c.fim };
      const [fech, pre, soma, linha, docs, mont, fech2, imps, ant] = await Promise.all([
        tenta(() => fechamentoT38.calcular(req, id, compT38, !!forcar), 'extrato', 'Não foi possível ler extratos e conciliação agora.'),
        tenta(() => painelFin.preBalancete(id, c.chave, false), 'comprovantes', 'Não foi possível montar o pré balancete agora.'),
        c.fim < hoje() ? tenta(() => D.conferirSoma(cli, id, c.chave), 'conciliacao', 'Não foi possível conferir a soma do demonstrativo com o caixa agora.') : Promise.resolve(null),
        tenta(() => lerModelo(id), 'montagem', 'Não foi possível ler o modelo do balancete.'),
        tenta(() => lerDocumentos(id, c.chave), 'montagem', 'Não foi possível ler os documentos recebidos.'),
        tenta(() => lerMontagem(id, c.chave), 'montagem', 'Não foi possível ler a montagem.'),
        tenta(() => D.dataFechamento(cli, id), 'conferencia', 'Não foi possível ler a data de fechamento.'),
        tenta(() => B.listarImpressoes(cli, id, c.chave), 'conferencia', 'Não foi possível ler os 900A do mês.'),
        tenta(() => (banco() ? banco().ler('fin_balancete_situacao?select=conferencia&id_superlogica=eq.' + id + '&competencia=eq.' + c.chave) : null), 'conferencia', 'Não foi possível ler a última situação.'),
      ]);
      // Conferência do 900A mais novo do mês: memória (6 horas) ou a última guardada no banco.
      const ultimo = (imps || []).filter((x) => x.da_competencia).sort((a, b) => Number(b.id) - Number(a.id))[0];
      let conferencia = null;
      if (ultimo) {
        const s = B.situacaoConferencia(id, c.chave, ultimo.id);
        if (s && s.estado === 'pronto') conferencia = { impressao: ultimo.id, ok: !!s.resultado.ok, problemas: s.resultado.problemas || 0 };
        else {
          const g = ant && ant[0] && ant[0].conferencia;
          if (g && String(g.impressao) === String(ultimo.id)) conferencia = g;
          else if (automatico && !ultimo.publicado && !s) B.iniciarConferencia({ cred: credSL(), cliente: cli, idCondominio: id, competencia: c.chave, idImpressao: ultimo.id, log });
        }
      }
      const sit = D.montarSituacao({
        comp: c.chave, hoje: hoje(), fechamento: fech, pre, soma, modelo: modeloDaLinha(linha), documentos: new Set(docs ? docs.keys() : []), montagem: mont || {},
        gravacao: politica.estado('balancete_montar', id).estado, fechadoAte: fech2 ? fech2.iso : null, impressoes: imps || [], conferencia, erroLeitura,
      });
      if (fech2 === null) sit.fechado = null;
      sit.condominio = id;
      sit.nome = (fech && fech.nome) || (fech2 && fech2.nome) || '';
      sit.fechado_ate = fech2 ? fech2.iso : null;
      sit.soma = soma;
      sit.modelo = modeloDaLinha(linha);
      sit.montagem = mont || {};
      sit.documentos = docs ? [].concat(...[...docs.entries()].map(([k, l]) => l.map((v) => ({ chave: k, nome: v.nome, bytes: v.bytes, recebido_em: v.recebido_em, por: v.enviado_por_email })))) : [];
      sit.ultimo_900a = ultimo || null;
      sit.conferencia = conferencia;
      sit.gravacao = politica.estado('balancete_montar', id).estado;
      sit.calculado_em = new Date().toISOString();
      const b = banco();
      if (b) b.upsert('fin_balancete_situacao', [{ id_superlogica: Number(id), competencia: c.chave, nome: sit.nome || null, etapa: sit.etapa, travas: sit.travas.slice(0, 80), prazo: sit.prazo,
        publicado: sit.publicado, fechado_ate: sit.fechado_ate, conferencia, calculado_em: sit.calculado_em }], 'id_superlogica,competencia').catch((e) => log('[balancete-digital] situação não gravada: ' + e.message));
      return sit;
    })().finally(() => calculando.delete(chave));
    calculando.set(chave, p);
    return p;
  }

  // ── rotina automática de um condomínio ────────────────────────────────
  // montarAgora: competência já terminou e é dia de montar. Grava só onde a política deixa sem
  // confirmação (condomínio de teste); fora dele deixa tudo preparado e a trava diz quem confirma.
  async function rotina(id, c, montarAgora) {
    const req = reqSistema();
    if (montarAgora && c.fim < hoje()) {
      if (politica.estado('balancete_montar', id).estado === 'livre') {
        const aut = await politica.autorizar(req, resSilenciosa(), { operacao: 'balancete_montar', id_condominio: id, conteudo: { competencia: c.chave, origem: 'agendamento' },
          resumo: { linhas: [{ rotulo: 'Mês', valor: c.rotulo }, { rotulo: 'Origem', valor: 'Agendamento do Hub' }] } });
        if (aut) await montar(id, c, aut, QUEM_SISTEMA);
      } else {
        // Só aprende o modelo e lê o que der: nada é gravado sem a confirmação de uma pessoa.
        if (!(await lerModelo(id).catch(() => null))) { const mdl = await aprender(id, c.chave); if (mdl.itens.length) await salvarModelo(id, mdl, null); }
      }
    } else if (!(await lerModelo(id).catch(() => null))) {
      const mdl = await aprender(id, c.chave).catch(() => null);
      if (mdl && mdl.itens.length) await salvarModelo(id, mdl, null);
    }
    const sit = await calcularSituacao(req, id, c, false, true);
    // 900A: depois do fechamento confirmado e da montagem completa, sem 900A no mês. Mesma política da T41.
    const montagemOk = sit.travas.every((t) => t.etapa !== 'montagem' && t.etapa !== 'extrato' && t.etapa !== 'conciliacao' && t.etapa !== 'comprovantes');
    // Só depois de a pessoa tornar públicos os comentários (o 900A só leva anexo de comentário público).
    if (montarAgora && sit.fechado && montagemOk && sit.montagem_completa && !sit.comentarios_privados && !sit.ultimo_900a && politica.estado('balancete_gerar', id).estado === 'livre') {
      const aut = await politica.autorizar(req, resSilenciosa(), { operacao: 'balancete_gerar', id_condominio: id, conteudo: { competencia: c.chave },
        resumo: { linhas: [{ rotulo: 'Mês', valor: c.rotulo }, { rotulo: 'Origem', valor: 'Agendamento do Hub' }] } });
      if (aut) {
        try { const r = await B.pedirGeracao(credSL(), id, c.chave, { cliente: clienteSL(), autorizado: true }); aut.concluir({ ok: true, competencia: c.chave, impressao: r.id_impressao || '' }); }
        catch (e) { aut.concluir({ ok: false, competencia: c.chave, erro: String((e && (e.codigo || e.message)) || 'falha').slice(0, 60) }); }
      }
    }
    return sit;
  }

  function condominiosDaAgenda() {
    const modo = String(process.env.BALANCETE_AGENDA || 'teste').trim().toLowerCase();
    if (modo === 'off') return Promise.resolve([]);
    if (modo === 'todos') return condominios().then((l) => (l || []).map((x) => String(x.id)).filter((x) => ID.test(x) && !D.NAO_CONDOMINIOS.has(x)));
    return Promise.resolve(politica.configuracao().teste.filter((x) => ID.test(x)));
  }
  let rodando = false;
  async function rodarAgenda(dia) {
    if (rodando) return { ocupado: true };
    rodando = true;
    const feito = [];
    try {
      const ids = await condominiosDaAgenda();
      for (const { comp, montar: m } of D.competenciasDoDia(dia || hoje())) {
        const c = D.competencia(comp);
        for (const id of ids) {
          try { const s = await rotina(id, c, m); feito.push({ id, comp, etapa: s.etapa, travas: s.travas.length }); }
          catch (e) { log('[balancete-digital] agenda ' + id + ' ' + comp + ' falhou: ' + (e && e.message)); feito.push({ id, comp, erro: true }); }
        }
      }
      if (feito.length) log('[balancete-digital] agenda: ' + feito.length + ' condomínio(s) acompanhados');
      return { feito };
    } finally { rodando = false; }
  }
  const marcadas = new Set();
  function agendar() {
    const t = setInterval(() => {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
      const h = Number(p.find((x) => x.type === 'hour').value);
      const k = hoje() + '|' + h;
      if (HORAS_AGENDA.includes(h) && !marcadas.has(k)) { marcadas.add(k); if (marcadas.size > 50) marcadas.delete(marcadas.values().next().value); rodarAgenda().catch(() => null); }
    }, 60000);
    if (typeof t.unref === 'function') t.unref();
    return t;
  }

  // ── rotas ─────────────────────────────────────────────────────────────
  const falha = (res, e, rotulo) => { log('[balancete-digital] ' + rotulo + ' falhou: ' + (e && e.message)); res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível concluir agora. Tente de novo em alguns minutos.' }); };
  const comTempo = (p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), ESPERA_ROTA))]);

  app.get('/api/financeiro/balancete-digital/painel', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const c = D.competencia(String(req.query.competencia || ''));
    if (!c) return res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe o mês no formato AAAA-MM.' });
    const carteira = String(req.query.carteira || '');
    if (carteira && !ID.test(carteira)) return res.status(400).json({ erro: 'carteira_invalida', detalhe: 'Carteira inválida.' });
    if (!(await podeVer(req, res, null))) return;
    let escopo;
    try { escopo = await escopoFinanceiro(req); } catch (e) { return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' }); }
    let grupos = [];
    try { grupos = await gruposCarteiras(); } catch (e) { grupos = []; }
    let ids = escopo;
    if (carteira) {
      const g = grupos.find((x) => String(x.id) === carteira);
      if (!g) return res.status(404).json({ erro: 'carteira_nao_encontrada', detalhe: 'Essa carteira não existe mais.' });
      const daCart = new Set(g.condominios.map(String));
      ids = escopo ? new Set([...daCart].filter((x) => escopo.has(x))) : daCart;
    }
    const b = banco();
    if (!b) return res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'O painel do balancete ainda não está disponível neste ambiente.' });
    try {
      const filtro = ids ? '&id_superlogica=in.(' + ([...ids].filter((x) => ID.test(x)).slice(0, 500).join(',') || '0') + ')' : '';
      const [linhas, reab] = await Promise.all([
        b.ler('fin_balancete_situacao?select=id_superlogica,nome,etapa,travas,prazo,publicado,fechado_ate,calculado_em&competencia=eq.' + c.chave + filtro + '&limit=1000'),
        b.ler('fin_balancete_fechamento_log?select=id_superlogica&acao=eq.reabrir&competencia=eq.' + c.chave + filtro + '&limit=2000'),
      ]);
      const reaberturas = {};
      (reab || []).forEach((r) => { reaberturas[r.id_superlogica] = (reaberturas[r.id_superlogica] || 0) + 1; });
      const responsavel = {};
      grupos.filter((g) => g.tipo === 'gerente').forEach((g) => g.condominios.forEach((id) => { if (!responsavel[id]) responsavel[id] = g.gerente || g.nome; }));
      const conds = (linhas || []).map((l) => ({
        id: String(l.id_superlogica), nome: l.nome || ('Condomínio ' + l.id_superlogica), etapa: l.etapa, etapa_nome: D.NOME_ETAPA[l.etapa] || l.etapa,
        prazo: D.prazo(c, hoje(), l.etapa), travas: (l.travas || []).slice(0, 15), total_travas: (l.travas || []).length, fechado_ate: l.fechado_ate,
        reaberturas: reaberturas[l.id_superlogica] || 0, carteira: responsavel[l.id_superlogica] || '', calculado_em: l.calculado_em,
      })).sort((x, y) => D.ETAPAS.indexOf(x.etapa) - D.ETAPAS.indexOf(y.etapa) || x.nome.localeCompare(y.nome, 'pt-BR'));
      // Quem precisa agir, somando TODAS as travas de cada condomínio (a parte antes dos dois pontos);
      // o corte de 15 vale só para a lista que vai para a tela.
      const porQuem = {};
      (linhas || []).forEach((x) => (x.travas || []).forEach((t) => { const q = String(t.quem || '').split(':')[0].trim() || 'Outros'; porQuem[q] = (porQuem[q] || 0) + 1; }));
      const porEtapa = {};
      conds.forEach((x) => { porEtapa[x.etapa] = (porEtapa[x.etapa] || 0) + 1; });
      let universo = ids ? [...ids] : null;
      if (!universo) { try { universo = (await condominios()).map((x) => String(x.id)).filter((x) => ID.test(x) && !D.NAO_CONDOMINIOS.has(x)); } catch (e) { universo = null; } }
      const semCalculo = universo ? universo.filter((x) => !conds.some((k) => k.id === x)).length : null;
      res.json({ competencia: c.chave, meta: { ideal: D.somarMeses(c, 1).inicio, maximo: D.somarMeses(c, 1).chave + '-05' }, condominios: conds, por_etapa: porEtapa, por_quem: porQuem, sem_calculo: semCalculo,
        calculo: calculoCarteira.rodando ? { rodando: true, feitos: calculoCarteira.feitos, total: calculoCarteira.total, competencia: calculoCarteira.competencia } : null,
        agenda: { modo: String(process.env.BALANCETE_AGENDA || 'teste').trim().toLowerCase(), horas: HORAS_AGENDA } });
    } catch (e) { falha(res, e, 'painel'); }
  });

  // POST /api/financeiro/balancete-digital/calcular { competencia, carteira? }: calcula agora a situação
  // de todos os condomínios que a pessoa vê (ou da carteira escolhida), 2 por vez, por trás. Só lê o
  // Superlógica (e guarda a situação no banco do Hub). Um cálculo de carteira por vez no servidor.
  const calculoCarteira = { rodando: false, feitos: 0, total: 0, competencia: '' };
  app.post('/api/financeiro/balancete-digital/calcular', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const c = D.competencia(String((req.body && req.body.competencia) || ''));
    if (!c) return res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe o mês no formato AAAA-MM.' });
    if (c.inicio > hoje()) return res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Escolha um mês que já começou.' });
    const carteira = String((req.body && req.body.carteira) || '');
    if (carteira && !ID.test(carteira)) return res.status(400).json({ erro: 'carteira_invalida', detalhe: 'Carteira inválida.' });
    if (!(await podeVer(req, res, null))) return;
    if (calculoCarteira.rodando) return res.status(409).json({ erro: 'em_andamento', detalhe: 'Já tem um cálculo de carteira rodando (' + calculoCarteira.feitos + ' de ' + calculoCarteira.total + '). Espere terminar.' });
    let escopo;
    try { escopo = await escopoFinanceiro(req); } catch (e) { return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' }); }
    let ids;
    try {
      if (carteira) {
        const g = (await gruposCarteiras()).find((x) => String(x.id) === carteira);
        if (!g) return res.status(404).json({ erro: 'carteira_nao_encontrada', detalhe: 'Essa carteira não existe mais.' });
        ids = g.condominios.map(String);
      } else ids = (await condominios()).map((x) => String(x.id));
    } catch (e) { return falha(res, e, 'calcular lista'); }
    ids = [...new Set(ids)].filter((x) => ID.test(x) && !D.NAO_CONDOMINIOS.has(x) && (!escopo || escopo.has(x))).slice(0, 200);
    if (!ids.length) return res.status(400).json({ erro: 'sem_condominios', detalhe: 'Nenhum condomínio para calcular.' });
    Object.assign(calculoCarteira, { rodando: true, feitos: 0, total: ids.length, competencia: c.chave });
    auditar(req, 'balancete_calcular_carteira', { competencia: c.chave, quantidade: ids.length, carteira: carteira || null });
    let i = 0;
    const trabalhador = async () => { while (i < ids.length) { const id = ids[i++]; try { await calcularSituacao(req, id, c, false, false); } catch (e) { log('[balancete-digital] calcular ' + id + ' falhou: ' + (e && e.message)); } calculoCarteira.feitos++; } };
    Promise.all([trabalhador(), trabalhador()]).finally(() => { calculoCarteira.rodando = false; });
    res.status(202).json({ iniciado: true, total: ids.length, detalhe: 'Calculando ' + ids.length + ' condomínio(s), 2 por vez. Só leitura. A tela atualiza sozinha.' });
  });

  app.get('/api/financeiro/balancete-digital/:idSuperlogica/situacao', requireAuth, async (req, res) => {
    const v = validar(req, res, false); if (!v) return;
    if (!(await podeVer(req, res, v.id))) return;
    try {
      const sit = await comTempo(calcularSituacao(req, v.id, v.c, req.query.forcar === '1', false));
      if (!sit) return res.status(202).json({ calculando: true, detalhe: 'Lendo extratos, conciliação, comprovantes e montagem. A tela tenta de novo sozinha.' });
      res.json(sit);
    } catch (e) { falha(res, e, 'situacao ' + v.id); }
  });

  app.post('/api/financeiro/balancete-digital/:idSuperlogica/modelo/aprender', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
    const v = validar(req, res, false); if (!v) return;
    if (!(await podeVer(req, res, v.id))) return;
    try {
      const m = await aprender(v.id, v.c.chave);
      const atual = modeloDaLinha(await lerModelo(v.id).catch(() => null));
      // Sem modelo salvo, o aprendido já fica valendo (o sistema trabalha com ele); confirmado só pela pessoa.
      if (!atual && m.itens.length) await salvarModelo(v.id, m, null).catch(() => null);
      res.json({ proposta: m, atual });
    } catch (e) { falha(res, e, 'aprender ' + v.id); }
  });

  app.post('/api/financeiro/balancete-digital/:idSuperlogica/modelo', requireAuth, express.json({ limit: '60kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!ID.test(id) || D.NAO_CONDOMINIOS.has(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código de condomínio inválido.' });
    const val = D.validarModelo(req.body && req.body.itens);
    if (val.erro) return res.status(400).json({ erro: 'modelo_invalido', detalhe: val.erro });
    if (!(await podeGravar(req, res, id))) return;
    try {
      const atual = await lerModelo(id).catch(() => null);
      const cad = await cadastro(id);
      const plano = (atual && atual.id_planoconta) || cad.plano || '';
      const linha = await salvarModelo(id, { plano: String(plano || ''), itens: val.itens, as_vezes: (atual && atual.as_vezes) || [], meses_lidos: (atual && atual.meses_lidos) || [], aprendido_em: atual && atual.aprendido_em }, quemDe(req));
      auditar(req, 'balancete_modelo_confirmado', { id_superlogica: id, itens: val.itens.length });
      res.json({ ok: true, modelo: modeloDaLinha(linha) });
    } catch (e) { falha(res, e, 'modelo ' + id); }
  });

  app.post('/api/financeiro/balancete-digital/:idSuperlogica/documento', requireAuth, express.json({ limit: '22mb' }), async (req, res) => {
    const v = validar(req, res, false); if (!v) return;
    const b0 = req.body || {};
    const chave = String(b0.chave || '');
    if (!/^[a-z0-9_]{1,60}$/.test(chave)) return res.status(400).json({ erro: 'item_invalido', detalhe: 'Escolha o item do modelo.' });
    if (typeof b0.pdf_base64 !== 'string' || b0.pdf_base64.length > Math.ceil(D.MAX_ARQUIVO / 3) * 4 + 8) return res.status(413).json({ erro: 'arquivo_grande', detalhe: 'O PDF passa de 15 MB, limite do Superlógica.' });
    if (!(await podeGravar(req, res, v.id))) return;
    // Até 30 envios por pessoa por hora (cada um pode ter 15 MB).
    if (dentroDoLimite && !dentroDoLimite(req, 'documento_upload', 30)) return res.status(429).json({ erro: 'limite', detalhe: 'Você enviou muitos documentos nesta hora. Tente de novo mais tarde.' });
    const buf = Buffer.from(b0.pdf_base64, 'base64');
    if (!D.ehPdf(buf) || buf.length > D.MAX_ARQUIVO) return res.status(400).json({ erro: 'nao_e_pdf', detalhe: 'O arquivo enviado não é um PDF de até 15 MB.' });
    const modelo = modeloDaLinha(await lerModelo(v.id).catch(() => null));
    const item = modelo && modelo.itens.find((i) => i.chave === chave);
    if (!item || item.fonte.tipo !== 'recebido') return res.status(400).json({ erro: 'item_invalido', detalhe: 'Esse item do modelo não recebe documento (o sistema gera sozinho).' });
    const b = banco();
    if (!b) return res.status(503).json({ erro: 'banco_indisponivel', detalhe: 'Envio de documentos indisponível neste ambiente.' });
    try {
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      // Vários PDFs no mesmo item (ex.: o extrato de cada poupança): o mesmo arquivo não entra duas vezes.
      const ja = (await lerDocumentos(v.id, v.c.chave)).get(chave) || [];
      if (ja.some((x) => x.sha256 === sha)) return res.json({ ok: true, chave, sha256: sha, bytes: buf.length, repetido: true, detalhe: 'Esse PDF já tinha sido enviado para este item.' });
      if (ja.length >= 30) return res.status(400).json({ erro: 'muitos_documentos', detalhe: 'Esse item já tem 30 PDFs.' });
      const chaveDoc = ja.length ? chave + '__' + (ja.length + 1) : chave;
      const caminho = v.id + '/' + v.c.chave + '/' + chave + '-' + sha.slice(0, 16) + '.pdf';
      await storage.enviar(caminho, buf);
      const nome = String(b0.nome || item.titulo).replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N} ._()$,]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || item.titulo;
      await b.upsert('fin_balancete_documento', [{ id_superlogica: Number(v.id), competencia: v.c.chave, chave_item: chaveDoc, nome, sha256: sha, bytes: buf.length, caminho,
        origem: 'tela', enviado_por_email: quemDe(req), recebido_em: new Date().toISOString() }], 'id_superlogica,competencia,chave_item');
      // Documento novo num item que falhou ou faltava: volta para pendente (o sistema grava na próxima rodada).
      const mont = await lerMontagem(v.id, v.c.chave);
      if (mont[chave] && !['gravado', 'ja_existia'].includes(mont[chave].estado)) await gravarMontagem(v.id, v.c.chave, item, { estado: 'pendente', msg: 'Documento recebido.' }, quemDe(req));
      auditar(req, 'balancete_documento_recebido', { id_superlogica: v.id, competencia: v.c.chave, item: chave, bytes: buf.length });
      res.json({ ok: true, chave, sha256: sha, bytes: buf.length, detalhe: mont[chave] && ['gravado', 'ja_existia'].includes(mont[chave].estado) ? 'Recebido. Esse comentário já estava gravado no Superlógica; o anexo de lá não muda.' : 'Recebido. O sistema grava na próxima rodada (ou em Montar agora).' });
    } catch (e) { falha(res, e, 'documento ' + v.id); }
  });

  app.post('/api/financeiro/balancete-digital/:idSuperlogica/montar', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    const v = validar(req, res, true); if (!v) return;
    if (!(await podeGravar(req, res, v.id))) return;
    if (politica.bloqueada(req, res, 'balancete_montar', v.id)) return;
    if (emMontagem.has(v.id + '|' + v.c.chave)) return res.status(409).json({ erro: 'em_andamento', detalhe: 'A montagem deste mês já está rodando.' });
    let plano;
    try {
      const modelo = modeloDaLinha(await lerModelo(v.id));
      if (!modelo || !modelo.itens.length) return res.status(409).json({ erro: 'sem_modelo', detalhe: 'O condomínio ainda não tem modelo do balancete. Clique em Aprender o modelo.' });
      const docs = await lerDocumentos(v.id, v.c.chave);
      plano = D.planoMontagem(modelo, await lerMontagem(v.id, v.c.chave), new Map([...docs.entries()].map(([k, l]) => [k, l.map((x) => x.sha256)])));
    } catch (e) { return falha(res, e, 'plano ' + v.id); }
    if (!plano.length) return res.status(409).json({ erro: 'nada_a_gravar', detalhe: 'Nada para gravar agora: os comentários já estão gravados ou os documentos ainda não chegaram.' });
    const aut = await politica.autorizar(req, res, { operacao: 'balancete_montar', id_condominio: v.id, conteudo: { competencia: v.c.chave, plano }, quantidade: plano.length,
      resumo: { linhas: [{ rotulo: 'Mês', valor: v.c.rotulo }, { rotulo: 'Comentários', valor: plano.map((p) => p.titulo).join('; ').slice(0, 600) },
        { rotulo: 'O que acontece', valor: 'Cada comentário entra no Demonstrativo R&D com o anexo e a etiqueta, invisível para o condômino e sem publicar' }] } });
    if (!aut) return;
    // A montagem roda por trás (relatórios levam minutos); a tela acompanha pela situação.
    montar(v.id, v.c, aut, quemDe(req)).then(() => calcularSituacao(req, v.id, v.c, false, false))
      .catch((e) => log('[balancete-digital] montagem ' + v.id + ' falhou: ' + (e && e.message)));
    res.status(202).json({ iniciado: true, itens: plano.length, detalhe: 'Montagem iniciada: ' + plano.length + ' comentário(s). A tela atualiza sozinha.' });
  });

  // POST /:id/tornar-publicos { competencia }: privado até publicar. Com a montagem completa, torna públicos
  // os comentários que o Hub gravou no mês (POST comentarios/post, VISIBILIDADE=1, relido um por um), pela
  // política com confirmação reforçada. Vem antes do 900A: o 061B só leva anexo de comentário público.
  app.post('/api/financeiro/balancete-digital/:idSuperlogica/tornar-publicos', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    const v = validar(req, res, true); if (!v) return;
    if (!(await podeGravar(req, res, v.id))) return;
    if (politica.bloqueada(req, res, 'balancete_tornar_publico', v.id)) return;
    let modelo, mont;
    try { modelo = modeloDaLinha(await lerModelo(v.id)); mont = await lerMontagem(v.id, v.c.chave); } catch (e) { return falha(res, e, 'tornar públicos ' + v.id); }
    if (!modelo || !modelo.itens.length) return res.status(409).json({ erro: 'sem_modelo', detalhe: 'O condomínio ainda não tem modelo do balancete.' });
    const faltam = modelo.itens.filter((i) => !mont[i.chave] || !['gravado', 'ja_existia'].includes(mont[i.chave].estado));
    if (faltam.length) return res.status(409).json({ erro: 'montagem_incompleta', detalhe: 'Termine a montagem antes: falta ' + faltam.map((i) => '"' + i.titulo + '"').join(', ') + '.' });
    const alvo = modelo.itens.filter((i) => Number(mont[i.chave].visibilidade) === 0 && mont[i.chave].id_comentario);
    if (!alvo.length) return res.status(409).json({ erro: 'nada_a_fazer', detalhe: 'Os comentários do balancete deste mês já estão públicos.' });
    const aut = await politica.autorizar(req, res, { operacao: 'balancete_tornar_publico', id_condominio: v.id, conteudo: { competencia: v.c.chave, comentarios: alvo.map((i) => String(mont[i.chave].id_comentario)) },
      resumo: { linhas: [{ rotulo: 'Mês', valor: v.c.rotulo }, { rotulo: 'Comentários', valor: alvo.map((i) => i.titulo).join('; ').slice(0, 600) },
        { rotulo: 'O que acontece', valor: 'Os comentários do Demonstrativo R&D ficam visíveis para os condôminos e passam a entrar no 900A. Nada é publicado agora.' }] } });
    if (!aut) return;
    const ctx = { cred: credSL(), cliente: clienteSL(), idCond: v.id, comp: v.c.chave };
    const out = { publicos: 0, falhas: [] };
    for (const i of alvo) {
      const l = mont[i.chave];
      let r;
      try { r = await D.tornarPublico(ctx, i, l.id_comentario); } catch (e) { r = { estado: 'falhou', msg: 'Falha ao tornar público.' }; }
      if (r.estado === 'publico') { out.publicos++; await gravarMontagem(v.id, v.c.chave, i, { estado: l.estado, id_comentario: l.id_comentario, id_arquivo: l.id_arquivo, visibilidade: 1, msg: r.msg }, quemDe(req)); }
      else out.falhas.push(i.titulo + ': ' + r.msg);
    }
    aut.concluir({ ok: !out.falhas.length, competencia: v.c.chave, publicos: out.publicos, falhas: out.falhas.length });
    auditar(req, 'balancete_comentarios_publicos', { id_superlogica: v.id, competencia: v.c.chave, publicos: out.publicos, falhas: out.falhas.length }, !!out.falhas.length);
    calcularSituacao(req, v.id, v.c, false, false).catch(() => null);
    if (out.falhas.length) return res.status(502).json({ erro: 'parcial', detalhe: out.publicos + ' tornado(s) público(s); não deu: ' + out.falhas.join(' | '), publicos: out.publicos });
    res.json({ ok: true, publicos: out.publicos, detalhe: out.publicos + ' comentário(s) tornado(s) público(s) e conferido(s). O sistema gera o 900A e confere; depois é só publicar.' });
  });

  // Fechamento: só com o checklist do mês todo verde e a soma do demonstrativo batendo com o caixa.
  app.post('/api/financeiro/balancete-digital/:idSuperlogica/fechar-mes', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    const v = validar(req, res, true); if (!v) return;
    if (!(await podeGravar(req, res, v.id))) return;
    if (politica.bloqueada(req, res, 'mes_fechar', v.id)) return;
    const cli = clienteSL();
    let antes, fech, soma;
    try {
      [antes, fech, soma] = await Promise.all([D.dataFechamento(cli, v.id), comTempo(fechamentoT38.calcular(req, v.id, { rotulo: v.c.chave, inicio: v.c.inicio, fim: v.c.fim }, false)), D.conferirSoma(cli, v.id, v.c.chave)]);
    } catch (e) { return falha(res, e, 'fechar leitura ' + v.id); }
    if (antes.iso && antes.iso >= v.c.fim) return res.status(409).json({ erro: 'ja_fechado', detalhe: 'O mês já está fechado (fechamento em ' + D.isoBR(antes.iso) + ').' });
    if (!fech) return res.status(202).json({ calculando: true, detalhe: 'Conferindo o mês antes de fechar. Tente de novo em instantes.' });
    if (!fech.pronto) return res.status(409).json({ erro: 'nao_pronto', detalhe: 'Ainda falta: ' + fech.falta.join('; ') + '.', falta: fech.falta });
    if (soma && soma.ok === false) return res.status(409).json({ erro: 'soma_nao_bate', detalhe: 'O demonstrativo não bate com o caixa (diferença de R$ ' + soma.diferenca.toFixed(2).replace('.', ',') + ').' });
    if (antes.iso && antes.iso < D.somarMeses(v.c, -1).fim) return res.status(409).json({ erro: 'mes_anterior_aberto', detalhe: 'O mês anterior ainda está aberto (fechamento em ' + (D.isoBR(antes.iso) || 'nunca') + '). Feche um mês por vez, do mais antigo para o mais novo.' });
    const aut = await politica.autorizar(req, res, { operacao: 'mes_fechar', id_condominio: v.id, conteudo: { competencia: v.c.chave, data: v.c.fim },
      resumo: { linhas: [{ rotulo: 'Mês', valor: v.c.rotulo }, { rotulo: 'Fechamento atual', valor: D.isoBR(antes.iso) || 'nunca fechado' }, { rotulo: 'Novo fechamento', valor: D.isoBR(v.c.fim) },
        { rotulo: 'O que acontece', valor: 'Ninguém consegue lançar, alterar ou excluir nada com data até ' + D.isoBR(v.c.fim) + ' sem reabrir o mês' }] } });
    if (!aut) return;
    const r = await D.gravarFechamento({ cred: credSL(), cliente: cli, idCond: v.id, nome: antes.nome }, v.c.fim);
    aut.concluir({ ok: r.ok, competencia: v.c.chave, data: v.c.fim, incerto: !!r.incerto });
    await registrarLog(req, v, 'fechar', antes.iso, r.ok ? v.c.fim : (r.data_lida || null), null, r);
    auditar(req, 'mes_fechado', { id_superlogica: v.id, competencia: v.c.chave, ok: r.ok, anterior: antes.iso || 'nunca' }, !r.ok);
    if (!r.ok) return res.status(502).json({ erro: r.incerto ? 'incerto' : 'falhou', detalhe: r.msg + ' Confira no Superlógica antes de tentar de novo.' });
    calcularSituacao(req, v.id, v.c, false, false).catch(() => null);
    res.json({ ok: true, fechado_ate: v.c.fim, detalhe: 'Mês fechado em ' + D.isoBR(v.c.fim) + ' e conferido no Superlógica.' });
  });

  app.post('/api/financeiro/balancete-digital/:idSuperlogica/reabrir-mes', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    const v = validar(req, res, false); if (!v) return;
    const motivo = String((req.body && req.body.motivo) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (motivo.length < 10 || motivo.length > 300) return res.status(400).json({ erro: 'motivo_obrigatorio', detalhe: 'Escreva o motivo da reabertura (de 10 a 300 letras).' });
    if (!(await podeGravar(req, res, v.id))) return;
    if (!(await exigirEscritaSuperlogica(req, res, 'Só gestor ou gerente pode fazer esta operação.'))) return; // só gestor ou gerente reabre
    if (politica.bloqueada(req, res, 'mes_reabrir', v.id)) return;
    const cli = clienteSL();
    let antes, ultimo;
    try {
      antes = await D.dataFechamento(cli, v.id);
      const b = banco();
      ultimo = b ? await b.ler('fin_balancete_fechamento_log?select=data_anterior&id_superlogica=eq.' + v.id + '&competencia=eq.' + v.c.chave + '&acao=eq.fechar&ok=eq.true&order=id.desc&limit=1') : [];
    } catch (e) { return falha(res, e, 'reabrir leitura ' + v.id); }
    if (!antes.iso || antes.iso < v.c.inicio) return res.status(409).json({ erro: 'ja_aberto', detalhe: 'O mês já está aberto (fechamento em ' + (D.isoBR(antes.iso) || 'nunca') + ').' });
    const nova = D.dataReabertura(v.c.chave, ultimo && ultimo[0] ? (ultimo[0].data_anterior || '') : undefined);
    const aut = await politica.autorizar(req, res, { operacao: 'mes_reabrir', id_condominio: v.id, conteudo: { competencia: v.c.chave, data: nova, motivo },
      resumo: { linhas: [{ rotulo: 'Mês', valor: v.c.rotulo }, { rotulo: 'Fechamento atual', valor: D.isoBR(antes.iso) }, { rotulo: 'Fica fechado até', valor: D.isoBR(nova) || 'nunca fechado' }, { rotulo: 'Motivo', valor: motivo },
        { rotulo: 'Atenção', valor: 'A reabertura fica registrada com o seu nome e o motivo; depois de corrigir, o mês precisa ser fechado de novo' }] } });
    if (!aut) return;
    const r = await D.gravarFechamento({ cred: credSL(), cliente: cli, idCond: v.id, nome: antes.nome }, nova);
    aut.concluir({ ok: r.ok, competencia: v.c.chave, data: nova || 'nunca', incerto: !!r.incerto });
    await registrarLog(req, v, 'reabrir', antes.iso, r.ok ? nova : (r.data_lida || null), motivo, r);
    auditar(req, 'mes_reaberto', { id_superlogica: v.id, competencia: v.c.chave, ok: r.ok, motivo: motivo.slice(0, 200) }, !r.ok);
    if (!r.ok) return res.status(502).json({ erro: r.incerto ? 'incerto' : 'falhou', detalhe: r.msg + ' Confira no Superlógica antes de tentar de novo.' });
    calcularSituacao(req, v.id, v.c, false, false).catch(() => null);
    res.json({ ok: true, fechado_ate: nova, detalhe: 'Mês reaberto. Fica fechado até ' + (D.isoBR(nova) || 'nunca') + '. Registrado com o motivo.' });
  });
  async function registrarLog(req, v, acao, anterior, nova, motivo, r) {
    const b = banco(); if (!b) return;
    await b.inserir('fin_balancete_fechamento_log', { id_superlogica: Number(v.id), competencia: v.c.chave, acao, data_anterior: anterior || '', data_nova: nova == null ? null : (nova || ''),
      motivo: motivo || null, ok: !!r.ok, incerto: !!r.incerto, msg: String(r.msg || '').slice(0, 300), por: (req.user && req.user.sub) || null, por_email: quemDe(req) }).catch(() => null);
  }

  // POST /:id/publicar { competencia, id_impressao, acao: publicar|despublicar, avisar }
  // Publica o 900A do mês para os condôminos pelo Hub (rotina única em superlogica/publicar-documento.js).
  // Publicar só com a etapa "Pronto para publicar": comentários públicos e a conferência do mesmo 900A ok.
  // Retirar a publicação (corrigir publicação errada) vale para qualquer 900A publicado do mês.
  app.post('/api/financeiro/balancete-digital/:idSuperlogica/publicar', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    const v = validar(req, res, true); if (!v) return;
    if (!(await podeGravar(req, res, v.id))) return;
    if (!d.publicador) return res.status(503).json({ erro: 'indisponivel', detalhe: 'Publicação pelo Hub indisponível neste ambiente.' });
    const b = req.body || {};
    const idImp = String(b.id_impressao || '');
    if (!/^[1-9]\d{0,9}$/.test(idImp)) return res.status(400).json({ erro: 'documento_invalido', detalhe: 'Informe o 900A a publicar.' });
    let validarItem;
    if (b.acao === 'publicar') {
      let sit;
      try { sit = await comTempo(calcularSituacao(req, v.id, v.c, false, false)); } catch (e) { return falha(res, e, 'publicar situação ' + v.id); }
      if (!sit) return res.status(202).json({ calculando: true, detalhe: 'Conferindo o balancete antes de publicar. Tente de novo em instantes.' });
      const ult = sit.ultimo_900a;
      const conf = sit.conferencia;
      if (sit.etapa !== 'pronto_publicar') return res.status(409).json({ erro: 'nao_pronto', detalhe: 'O balancete ainda não está "Pronto para publicar" (' + (sit.etapa_nome || sit.etapa) + '). Resolva o que está travando primeiro.' });
      if (sit.comentarios_privados) return res.status(409).json({ erro: 'comentarios_privados', detalhe: 'Antes, confirme "Tornar públicos os comentários do balancete".' });
      if (!ult || String(ult.id) !== idImp) return res.status(409).json({ erro: 'outro_900a', detalhe: 'Esse não é o 900A mais novo do mês. Calcule de novo e publique o que a tela mostrar.' });
      if (!conf || !conf.ok || String(conf.impressao) !== idImp) return res.status(409).json({ erro: 'conferencia_pendente', detalhe: 'A conferência deste 900A não está ok.' });
      validarItem = (it) => (/^900A\b/.test(it.titulo) ? null : 'Esse documento não é um 900A.');
    } else {
      validarItem = (it) => (/^900A\b/.test(it.titulo) && new RegExp('M[eê]s\\s+' + v.c.chave.slice(5) + '/' + v.c.chave.slice(0, 4)).test(it.descricao) ? null : 'Esse documento não é o 900A deste mês.');
    }
    try {
      const r = await d.publicador.executar(req, res, { idCond: v.id, alvo: { id: idImp }, acao: b.acao, avisar: b.avisar, documento: 'Balancete digital (900A)', competencia: v.c.rotulo, validarItem });
      if (r && r.estado === 'ok') calcularSituacao(req, v.id, v.c, false, false).catch(() => null);
    } catch (e) { falha(res, e, 'publicar ' + v.id); }
  });

  app.get('/api/financeiro/balancete-digital/:idSuperlogica/fechamentos', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!ID.test(id) || D.NAO_CONDOMINIOS.has(id)) return res.status(400).json({ erro: 'id_invalido', detalhe: 'Código de condomínio inválido.' });
    if (!(await podeVer(req, res, id))) return;
    const b = banco();
    if (!b) return res.json({ registros: [] });
    try { res.json({ registros: await b.ler('fin_balancete_fechamento_log?select=competencia,acao,data_anterior,data_nova,motivo,ok,incerto,por_email,em&id_superlogica=eq.' + id + '&order=id.desc&limit=50') }); }
    catch (e) { falha(res, e, 'fechamentos ' + id); }
  });

  return { agendar, rodarAgenda, rotina, montar, aprender, calcularSituacao };
}

module.exports = { criarRotasBalanceteDigital, BUCKET };
