// ─────────────────────────────────────────────────────────────────────────
// Agenda do mês: rotas. Regras em servico/agenda.js, leitura em servico/agenda-leitura.js,
// execução em servico/agenda-execucao.js, tela em public/agenda.js, banco na migration 034.
//
// Quem faz o quê:
//   . ver a agenda e o plano: GESTOR e GERENTE pelo cargo, os outros com o módulo agenda;
//     cada um só vê os condomínios da própria carteira (mesma regra do resto do Hub);
//   . mandar a agenda, corrigir item, anexar edital e material: quem pode cadastrar;
//   . aprovar o plano, refazer tarefa e mudar as antecedências: só GESTOR ou GERENTE;
//   . Painel da gestão (cronograma, pronto e travado, tendências): o dono e quem recebeu o
//     módulo gestao_painel (só um GESTOR concede; servico/permissoes.js).
// Rotas:
//   GET  /api/agenda/mes/:mes                      agenda, plano, painel, custo e avisos do mês
//   POST /api/agenda/ler                           { mes, modo: texto|planilha|arquivo, ... } prévia, não grava
//   POST /api/agenda/itens                         { mes, itens: [...] } grava e refaz o plano
//   PUT  /api/agenda/itens/:id                     corrige um item (o que muda volta para aprovação)
//   DELETE /api/agenda/itens/:id                   tira da agenda (as tarefas saem do plano)
//   POST /api/agenda/itens/:id/assumir             a pessoa passa a receber os resultados do item
//   POST /api/agenda/itens/:id/material?tipo=&nome= corpo cru (edital PDF, documento PDF, foto JPEG)
//   DELETE /api/agenda/materiais/:id
//   GET  /api/agenda/materiais/:id/link            link temporário do arquivo
//   POST /api/agenda/mes/:mes/aprovar              { ids? } aprova tudo ou só os ids
//   POST /api/agenda/tarefas/:id/conferida         POST /api/agenda/tarefas/:id/refazer
//   PUT  /api/agenda/config                        { valores } antecedências
//   POST /api/agenda/avisos/lidos                  { ids }
//   GET  /api/agenda/gestao/:mes                   Painel da gestão
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');
const agenda = require('./agenda');
const leitura = require('./agenda-leitura');
const execucao = require('./agenda-execucao');

const BUCKET = 'agenda';
const MAX_ARQUIVO = 25 * 1024 * 1024;
const MAX_DOCS = 30;
const MAX_FOTOS = 40;
const MAX_ITENS_LOTE = 80;
const LEITURAS_POR_HORA = 30;
const EDITAL_CHARS = 20000;
const TEXTO_DOC_CHARS = 200000;
const CACHE_BASE_MS = 10 * 60 * 1000;
const FUNCOES_CUSTO = ['prestacao', 'apresentacao', 'apresentacao_imagens'];

function criarRotasAgenda(app, deps) {
  const { requireAuth, express, banco, perfilDe, auditoria } = deps;
  const chamarModelo = deps.chamarModelo || require('./modelo').chamarModelo;
  const extrairJson = deps.extrairJson || require('./modelo').extrairJson;
  const modelos = deps.modelos || require('./modelos');
  const extrairPauta = deps.extrairPauta || require('./apresentacao').extrairPauta;
  const extrairTexto = deps.extrairTexto || (async (buf, n) => { const r = await require('../financeiro/entrada').extrairTexto(buf, n); return r || null; });
  const tiposCertidao = (deps.tiposCertidao || require('./certidoes').TIPOS).map((t) => ({ tipo: t.tipo, nome: t.nome }));
  const agora = deps.agora || Date.now;
  const eu = (req) => { const u = req.user && req.user.sub; return agenda.UUID.test(String(u || '')) ? u : null; };
  const auditar = (req, acao, det) => { try { if (auditoria) auditoria.evento(req, acao, det || null); } catch (e) { /* registro nunca derruba */ } };

  // ── Agendador (desligado por padrão: AGENDA_EXECUCAO=on liga) ──
  const baixarMaterial = deps.baixarMaterial || (async (caminho) => {
    const url = await deps.storageSignedUrl(BUCKET, caminho, 120);
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('material_' + r.status);
    return Buffer.from(await r.arrayBuffer());
  });
  const agendador = execucao.criarAgendador({
    banco,
    executores: deps.executores || execucao.criarExecutoresInternos({ porta: deps.porta, segredo: deps.segredo }),
    salvarTrabalho: deps.salvarTrabalho || execucao.criarSalvarTrabalho({ banco, storageUpload: deps.storageUpload }),
    baixarMaterial, tiposCertidao, agora, ligado: deps.ligado,
    passouLimiteMensal: deps.passouLimiteMensal || passouLimiteMensal,
    auditar: (acao, det) => {
      // Evento do sistema: fica no nome de quem aprovou (sem rota de navegador).
      try { if (auditoria) auditoria.evento({ authMode: 'agenda', user: null, headers: {}, socket: {}, method: 'AGENDA', originalUrl: '/agenda/execucao', params: {}, query: {}, body: {} }, acao, det); } catch (e) { /* nada */ }
    },
  });

  // Gasto do mês nas funções de processamento passou do limite: segura as gerações.
  async function passouLimiteMensal() {
    const lim = Number(process.env.CUSTO_LIMITE_MENSAL_USD);
    if (!(lim > 0)) return false;
    const mes = agenda.hojeBrasilia(agora()).slice(0, 7);
    const tot = await custoDosMeses([mes]);
    return ((tot[mes] && tot[mes].usd) || 0) >= lim;
  }
  // { 'AAAA-MM': { usd, chamadas } } das funções de prestação e apresentação (todas as origens).
  async function custoDosMeses(meses) {
    const out = {};
    for (const m of meses) {
      const [a, mm] = m.split('-').map(Number);
      const ultimo = new Date(Date.UTC(a, mm, 0)).getUTCDate();
      let r = null;
      try { r = await banco('POST', '/rest/v1/rpc/api_uso_resumo', { de: m + '-01', ate: m + '-' + String(ultimo).padStart(2, '0') }); } catch (e) { r = null; }
      if (!r || r.status !== 200 || !Array.isArray(r.body)) continue;
      const linhas = r.body.filter((l) => FUNCOES_CUSTO.includes(l.funcao));
      out[m] = { usd: linhas.reduce((s, l) => s + (Number(l.custo_usd) || 0), 0), chamadas: linhas.reduce((s, l) => s + (Number(l.chamadas) || 0), 0) };
    }
    return out;
  }

  // ── Permissão e carteira ──
  async function perfil(req) {
    if (req.authMode === 'internal') return { role: 'GESTOR', permissoes: {} };
    try { return await perfilDe(req); } catch (e) { return null; }
  }
  // nivel: ver, cadastrar, aprovar, gestao. Responde 403 e devolve null quando não pode.
  async function liberar(req, res, nivel) {
    const p = await perfil(req);
    const interno = req.authMode === 'internal';
    const ok = { ver: agenda.podeVer, cadastrar: agenda.podeCadastrar, aprovar: agenda.podeAprovar, gestao: agenda.podeVerGestao }[nivel](p, interno);
    if (!ok) {
      if (nivel === 'gestao' || nivel === 'aprovar') auditar(req, 'agenda_negado', { nivel });
      res.status(403).json({ erro: 'acesso_negado', detalhe: nivel === 'aprovar' ? 'Só a gestão aprova o plano.' : 'Seu usuário não tem acesso a esta parte da Agenda.' });
      return null;
    }
    return { p, interno, podeCadastrar: agenda.podeCadastrar(p, interno), podeAprovar: agenda.podeAprovar(p, interno), podeGestao: agenda.podeVerGestao(p, interno) };
  }
  async function escopoDe(req, res) {
    if (!deps.escopo) return { todas: true };
    try { return await deps.escopo(req); } catch (e) {
      res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora. Tente de novo em instantes.' });
      return null;
    }
  }
  const dentro = (esc, id) => esc.todas || (id != null && esc.ids && esc.ids.has(Number(id)));
  const itemVisivel = (esc, it, req) => (it.id_superlogica ? dentro(esc, it.id_superlogica) : (esc.todas || it.criado_por === eu(req)));
  // Dia das certidões é de vários condomínios: quem tem carteira vê só os dela.
  function tarefaVisivel(esc, t, itensVis) {
    if (t.item_id) return itensVis.has(t.item_id);
    if (esc.todas) return t;
    const p = t.parametros || {};
    const conds = (p.condominios || []).filter((id) => dentro(esc, id));
    if (!conds.length) return null;
    const r = t.resultado && Array.isArray(t.resultado.condominios) ? Object.assign({}, t.resultado, { condominios: t.resultado.condominios.filter((c) => dentro(esc, c.id_superlogica)) }) : t.resultado;
    return Object.assign({}, t, { parametros: Object.assign({}, p, { condominios: conds }), resultado: r });
  }

  // Condomínios da base (para reconhecer o nome), com cache curto.
  let baseCache = null; let baseAte = 0;
  async function baseCondominios() {
    if (baseCache && baseAte > Date.now()) return baseCache;
    const r = await banco('GET', '/rest/v1/condominios?select=id,nome,id_superlogica&id_superlogica=not.is.null&limit=2000');
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('base_' + r.status);
    baseCache = r.body.filter((c) => c && c.nome && Number(c.id_superlogica) > 0);
    baseAte = Date.now() + CACHE_BASE_MS;
    return baseCache;
  }

  async function lerConfig() {
    const r = await banco('GET', '/rest/v1/agenda_config?chave=eq.padrao&select=valores&limit=1');
    return agenda.lerConfig(r.status === 200 && Array.isArray(r.body) && r.body[0] ? r.body[0].valores : null);
  }

  // ── Plano: uma regeração por vez no processo (duas abas salvando ao mesmo tempo) ──
  let fila = Promise.resolve();
  function regenerar(mes) {
    const p = fila.then(() => regenerarAgora(mes));
    fila = p.catch(() => {});
    return p;
  }
  async function regenerarAgora(mes) {
    const [ri, rt] = await Promise.all([
      banco('GET', '/rest/v1/agenda_itens?mes=eq.' + mes + '&limit=500'),
      banco('GET', '/rest/v1/agenda_tarefas?mes=eq.' + mes + '&limit=2000'),
    ]);
    if (ri.status !== 200 || rt.status !== 200) throw new Error('banco_plano');
    const plano = agenda.gerarPlano(ri.body || [], await lerConfig());
    const s = agenda.sincronizarPlano(rt.body || [], plano);
    const agoraIso = new Date(agora()).toISOString();
    if (s.criar.length) {
      const linhas = s.criar.map((t) => ({ mes, chave: t.chave, item_id: t.item_id, id_superlogica: t.id_superlogica, tipo: t.tipo, titulo: t.titulo,
        data_execucao: t.data_execucao, prazo: t.prazo, parametros: t.parametros, assinatura: t.assinatura, status: t.status, aprovacao: 'pendente',
        resultado: t.avisos && t.avisos.length ? { avisos_plano: t.avisos } : {} }));
      const r = await banco('POST', '/rest/v1/agenda_tarefas', linhas);
      if (r.status >= 400 && r.status !== 409) throw new Error('banco_criar_' + r.status);
    }
    for (const u of s.atualizar) await banco('PATCH', '/rest/v1/agenda_tarefas?id=eq.' + u.id + '&status=neq.rodando', Object.assign({ atualizado_em: agoraIso }, u.campos));
    if (s.cancelar.length) await banco('PATCH', '/rest/v1/agenda_tarefas?id=in.(' + s.cancelar.join(',') + ')&status=neq.rodando', { status: 'cancelada', motivo: 'removida_do_plano', atualizado_em: agoraIso });
    return { criadas: s.criar.length, mudadas: s.atualizar.length, canceladas: s.cancelar.length };
  }

  // Monta o que a tela do mês precisa, já filtrado pela carteira.
  async function dadosDoMes(req, mes, esc) {
    const [ri, rt] = await Promise.all([
      banco('GET', '/rest/v1/agenda_itens?mes=eq.' + mes + '&order=data.asc,hora.asc&limit=500'),
      banco('GET', '/rest/v1/agenda_tarefas?mes=eq.' + mes + '&order=data_execucao.asc&limit=2000'),
    ]);
    if (ri.status !== 200 || rt.status !== 200) throw new Error('banco_mes');
    const itens = (ri.body || []).filter((it) => itemVisivel(esc, it, req));
    const vis = new Set(itens.map((i) => i.id));
    const tarefas = [];
    for (const t of rt.body || []) { const v = tarefaVisivel(esc, t, vis); if (v) tarefas.push(v === true ? t : v); }
    let materiais = [];
    if (itens.length) {
      const rm = await banco('GET', '/rest/v1/agenda_materiais?item_id=in.(' + itens.map((i) => i.id).join(',') + ')&select=id,item_id,tipo,nome,bytes,criado_em&order=criado_em.asc&limit=3000');
      materiais = rm.status === 200 && Array.isArray(rm.body) ? rm.body : [];
    }
    return { itens, tarefas, materiais };
  }

  // Lista viva do dia das certidões: o que falta em cada condomínio (certidões guardadas agora).
  async function certidoesDoDia(tarefas, itens) {
    const grupos = tarefas.filter((t) => t.tipo === 'certidoes' && t.status !== 'cancelada');
    const ids = [...new Set(grupos.flatMap((g) => (g.parametros && g.parametros.condominios) || []))];
    if (!ids.length) return [];
    const r = await banco('GET', '/rest/v1/certidoes_condominio?id_superlogica=in.(' + ids.map(Number).join(',') + ')&select=id_superlogica,tipo,situacao,validade,caminho&limit=5000');
    const linhas = r.status === 200 && Array.isArray(r.body) ? r.body : [];
    const porCond = new Map();
    linhas.forEach((l) => { const k = Number(l.id_superlogica); if (!porCond.has(k)) porCond.set(k, []); porCond.get(k).push(l); });
    const dataDe = new Map(); const nomeDe = new Map();
    itens.forEach((i) => { if (i.id_superlogica && !i.cancelado) { const k = Number(i.id_superlogica); nomeDe.set(k, i.condominio_nome); if (!dataDe.has(k) || i.data < dataDe.get(k)) dataDe.set(k, i.data); } });
    return grupos.map((g) => ({
      tarefa_id: g.id, dia: g.data_execucao, status: g.status, aprovacao: g.aprovacao,
      condominios: ((g.parametros && g.parametros.condominios) || []).map((id) => ({
        id_superlogica: Number(id), nome: nomeDe.get(Number(id)) || String(id), assembleia: dataDe.get(Number(id)) || null,
        faltando: agenda.certidoesFaltando(porCond.get(Number(id)) || [], tiposCertidao, dataDe.get(Number(id)) || g.data_execucao),
      })),
    }));
  }

  async function avisosDe(req, gestao) {
    const me = eu(req);
    const filtro = me ? (gestao ? '&or=(user_id.eq.' + me + ',user_id.is.null)' : '&user_id=eq.' + me) : '&user_id=is.null';
    const r = await banco('GET', '/rest/v1/agenda_avisos?lido=eq.false' + filtro + '&order=criado_em.desc&limit=50');
    return r.status === 200 && Array.isArray(r.body) ? r.body : [];
  }

  const maxHora = () => execucao.numeroAmbiente('AGENDA_MAX_GERACOES_HORA', 6, 1, 20);
  const RE_MES = agenda.RE_MES;

  // ── Tela do mês ──
  app.get('/api/agenda/mes/:mes', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const mes = String(req.params.mes);
    if (!RE_MES.test(mes)) return res.status(400).json({ erro: 'mes_invalido', detalhe: 'Mês inválido.' });
    const lib = await liberar(req, res, 'ver'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    try {
      const d = await dadosDoMes(req, mes, esc);
      const hoje = agenda.hojeBrasilia(agora());
      res.json({
        mes, rotulo: agenda.mesRotulo(mes), hoje, itens: d.itens, tarefas: d.tarefas, materiais: d.materiais,
        painel: agenda.painelDoMes(d.tarefas, d.itens, hoje),
        custo: agenda.estimarCusto(d.tarefas, process.env, maxHora()),
        certidoes_dia: await certidoesDoDia(d.tarefas, d.itens),
        avisos: await avisosDe(req, lib.podeAprovar),
        config: await lerConfig(), limites_config: agenda.LIMITES_CONFIG,
        dependencias: Object.fromEntries(d.itens.map((i) => [i.id, agenda.dependencias(i)])),
        pode: { cadastrar: lib.podeCadastrar, aprovar: lib.podeAprovar, gestao: lib.podeGestao },
        execucao: agendador.estado(),
      });
    } catch (e) {
      console.warn('[agenda] mês: ' + e.message);
      res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível abrir a agenda agora.' });
    }
  });

  // ── Leitura da agenda (prévia, não grava) ──
  app.post('/api/agenda/ler', requireAuth, express.json({ limit: '36mb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    const mes = String(b.mes || '');
    if (!RE_MES.test(mes)) return res.status(400).json({ erro: 'mes_invalido', detalhe: 'Escolha o mês da agenda.' });
    const lib = await liberar(req, res, 'cadastrar'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    let lidos;
    try {
      if (b.modo === 'planilha') {
        lidos = agenda.lerPlanilha(b.linhas, mes);
      } else {
        if (deps.dentroDoLimite && !deps.dentroDoLimite(req, 'agenda_leitura', LEITURAS_POR_HORA)) {
          auditar(req, 'limite_processamento', { tipo: 'agenda_leitura' });
          return res.status(429).json({ erro: 'limite', detalhe: 'Muitas leituras nesta hora. Tente mais tarde ou use a planilha.' });
        }
        let entrada = null;
        if (b.modo === 'texto') {
          const texto = typeof b.texto === 'string' ? b.texto.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim() : '';
          if (texto.length < 10) return res.status(400).json({ erro: 'sem_texto', detalhe: 'Cole o texto da agenda.' });
          entrada = { texto };
        } else if (b.modo === 'arquivo') {
          const b64 = typeof b.arquivo_b64 === 'string' ? b.arquivo_b64 : '';
          if (!b64 || b64.length > Math.ceil(MAX_ARQUIVO / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return res.status(400).json({ erro: 'arquivo_invalido', detalhe: 'Arquivo inválido ou maior que 25 MB.' });
          const buf = Buffer.from(b64, 'base64');
          if (buf.slice(0, 4).toString('latin1') === '%PDF') {
            const t = await extrairTexto(buf, 20).catch(() => null);
            entrada = t && String(t.texto || '').replace(/\s+/g, '').length > 200 ? { texto: t.texto } : { pdf: { b64 } };
          } else if (buf[0] === 0xff && buf[1] === 0xd8) entrada = { imagem: { b64, mime: 'image/jpeg' } };
          else if (buf.slice(0, 4).toString('hex') === '89504e47') entrada = { imagem: { b64, mime: 'image/png' } };
          else return res.status(415).json({ erro: 'formato_invalido', detalhe: 'Envie PDF, foto JPG ou PNG.' });
        } else return res.status(400).json({ erro: 'modo_invalido', detalhe: 'Escolha como a agenda vai entrar.' });
        const r = await leitura.lerComModelo(entrada, { chamarModelo, extrairJson, modelos, mes, usuario: eu(req) });
        if (!r.ok) return res.status(r.status).json({ erro: 'leitura', detalhe: r.detalhe });
        lidos = r;
      }
      const base = (await baseCondominios()).filter((c) => dentro(esc, c.id_superlogica));
      const itens = agenda.prepararItens(lidos.itens, base, mes);
      auditar(req, 'agenda_lida', { mes, modo: b.modo, itens: itens.length, nao_entendido: lidos.nao_entendido.length });
      res.json({ itens, nao_entendido: lidos.nao_entendido });
    } catch (e) {
      console.warn('[agenda] leitura: ' + e.message);
      res.status(503).json({ erro: 'falha', detalhe: 'Não foi possível ler a agenda agora. Tente de novo.' });
    }
  });

  // Confere um item vindo da tela. Devolve { linha } ou { erro }.
  async function conferirItem(req, esc, it, mes) {
    if (!it || typeof it !== 'object') return { erro: 'Item inválido.' };
    const tipoItem = it.tipo_item === 'tarefa' ? 'tarefa' : 'assembleia';
    let id = null; let nome = agenda.limpar(it.condominio_nome || it.condominio, 120);
    if (it.id_superlogica != null && it.id_superlogica !== '') {
      if (!/^[1-9][0-9]{0,8}$/.test(String(it.id_superlogica))) return { erro: 'Código do condomínio inválido.' };
      id = Number(it.id_superlogica);
      if (!dentro(esc, id)) return { erro: 'Condomínio fora da sua carteira.', fora: true };
      const c = deps.condominioDaBase ? await deps.condominioDaBase(id).catch(() => null) : { nome };
      if (!c) return { erro: 'Condomínio fora da base do sistema.' };
      nome = c.nome || nome;
    }
    if (!nome) return { erro: 'Falta o condomínio.' };
    const data = it.data ? String(it.data) : null;
    if (data && !agenda.dataValida(data)) return { erro: 'Data inválida.' };
    const hora = it.hora && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(it.hora)) ? String(it.hora) : null;
    const tipoAss = ['AGO', 'AGE', 'AGO_AGE'].includes(it.tipo_assembleia) ? it.tipo_assembleia : null;
    let edital = typeof it.edital_texto === 'string' ? it.edital_texto.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim().slice(0, EDITAL_CHARS) : null;
    let pauta = agenda.classificarPauta(it.pauta);
    let fonte = pauta.length ? 'agenda' : null;
    if (edital && !pauta.length) { const p = extrairPauta(edital); if (p.length) { pauta = agenda.classificarPauta(p); fonte = 'edital'; } }
    const linha = { mes, tipo_item: tipoItem, id_superlogica: id, condominio_nome: nome, data, hora, tipo_assembleia: tipoItem === 'assembleia' ? tipoAss : null,
      descricao: agenda.limpar(it.descricao, 300) || null, pauta, pauta_fonte: fonte, origem: ['texto', 'planilha', 'arquivo', 'manual'].includes(it.origem) ? it.origem : 'manual',
      avisos_leitura: Array.isArray(it.avisos) ? it.avisos.slice(0, 10).map((a) => agenda.limpar(a, 200)) : [] };
    if (edital) linha.edital_texto = edital;
    return { linha };
  }

  app.post('/api/agenda/itens', requireAuth, express.json({ limit: '2mb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    const mes = String(b.mes || '');
    if (!RE_MES.test(mes)) return res.status(400).json({ erro: 'mes_invalido', detalhe: 'Mês inválido.' });
    if (!Array.isArray(b.itens) || !b.itens.length || b.itens.length > MAX_ITENS_LOTE) return res.status(400).json({ erro: 'itens_invalidos', detalhe: 'Mande de 1 a ' + MAX_ITENS_LOTE + ' itens.' });
    const lib = await liberar(req, res, 'cadastrar'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    try {
      const atuais = await banco('GET', '/rest/v1/agenda_itens?mes=eq.' + mes + '&cancelado=eq.false&select=id_superlogica,data,tipo_item&limit=500');
      const ja = new Set((atuais.body || []).map((x) => [x.id_superlogica, x.data, x.tipo_item].join('|')));
      const linhas = []; const recusados = [];
      for (let i = 0; i < b.itens.length; i++) {
        const c = await conferirItem(req, esc, b.itens[i], mes);
        if (c.erro) { recusados.push({ posicao: i + 1, motivo: c.erro }); continue; }
        const k = [c.linha.id_superlogica, c.linha.data, c.linha.tipo_item].join('|');
        if (c.linha.id_superlogica && ja.has(k)) { recusados.push({ posicao: i + 1, motivo: 'Já estava na agenda.' }); continue; }
        ja.add(k);
        linhas.push(Object.assign(c.linha, { criado_por: eu(req), responsavel: eu(req) }));
      }
      if (linhas.length) {
        const r = await banco('POST', '/rest/v1/agenda_itens', linhas);
        if (r.status >= 400) throw new Error('banco_' + r.status);
      }
      const plano = linhas.length ? await regenerar(mes) : null;
      auditar(req, 'agenda_itens_criados', { mes, gravados: linhas.length, recusados: recusados.length });
      res.json({ gravados: linhas.length, recusados, plano });
    } catch (e) {
      console.warn('[agenda] gravar itens: ' + e.message);
      res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível gravar a agenda agora.' });
    }
  });

  // Item da agenda que a pessoa pode mexer (carteira). Responde e devolve null quando não pode.
  async function itemDe(req, res, esc, id) {
    if (!agenda.UUID.test(String(id))) { res.status(400).json({ erro: 'id_invalido' }); return null; }
    const r = await banco('GET', '/rest/v1/agenda_itens?id=eq.' + id + '&limit=1');
    const it = r.status === 200 && Array.isArray(r.body) ? r.body[0] : null;
    if (!it) { res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Esse item não está mais na agenda.' }); return null; }
    if (!itemVisivel(esc, it, req)) { auditar(req, 'agenda_fora_da_carteira', { id_superlogica: it.id_superlogica }); res.status(403).json({ erro: 'fora_da_carteira', detalhe: 'Esse condomínio não está na sua carteira.' }); return null; }
    return it;
  }

  app.put('/api/agenda/itens/:id', requireAuth, express.json({ limit: '1mb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const lib = await liberar(req, res, 'cadastrar'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    const it = await itemDe(req, res, esc, req.params.id); if (!it) return;
    const b = req.body || {};
    const junto = Object.assign({}, it, b, { pauta: b.pauta !== undefined ? b.pauta : it.pauta, edital_texto: b.edital_texto !== undefined ? b.edital_texto : undefined });
    const c = await conferirItem(req, esc, junto, it.mes);
    if (c.erro) return res.status(c.fora ? 403 : 400).json({ erro: 'item_invalido', detalhe: c.erro });
    const campos = Object.assign(c.linha, { atualizado_em: new Date(agora()).toISOString() });
    delete campos.mes; delete campos.origem; delete campos.avisos_leitura;
    if (b.pauta === undefined) { delete campos.pauta; delete campos.pauta_fonte; }
    else if (Array.isArray(b.pauta) && b.pauta.length) campos.pauta_fonte = 'manual';
    try {
      await banco('PATCH', '/rest/v1/agenda_itens?id=eq.' + it.id, campos);
      const plano = await regenerar(it.mes);
      auditar(req, 'agenda_item_alterado', { id_superlogica: campos.id_superlogica || it.id_superlogica, item: it.id });
      res.json({ ok: true, plano });
    } catch (e) { res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível salvar agora.' }); }
  });

  app.delete('/api/agenda/itens/:id', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const lib = await liberar(req, res, 'cadastrar'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    const it = await itemDe(req, res, esc, req.params.id); if (!it) return;
    try {
      await banco('PATCH', '/rest/v1/agenda_itens?id=eq.' + it.id, { cancelado: true, atualizado_em: new Date(agora()).toISOString() });
      const plano = await regenerar(it.mes);
      auditar(req, 'agenda_item_cancelado', { id_superlogica: it.id_superlogica, item: it.id });
      res.json({ ok: true, plano });
    } catch (e) { res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível tirar agora.' }); }
  });

  app.post('/api/agenda/itens/:id/assumir', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const lib = await liberar(req, res, 'cadastrar'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    const it = await itemDe(req, res, esc, req.params.id); if (!it) return;
    if (!eu(req)) return res.status(400).json({ erro: 'sem_usuario' });
    await banco('PATCH', '/rest/v1/agenda_itens?id=eq.' + it.id, { responsavel: eu(req), atualizado_em: new Date(agora()).toISOString() });
    auditar(req, 'agenda_item_assumido', { id_superlogica: it.id_superlogica, item: it.id });
    res.json({ ok: true });
  });

  // Material da assembleia: edital (PDF, vira texto e pauta), documento (PDF) e foto (JPEG).
  app.post('/api/agenda/itens/:id/material', requireAuth, express.raw({ type: '*/*', limit: MAX_ARQUIVO }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const tipo = String(req.query.tipo || '');
    if (!['edital', 'documento', 'foto'].includes(tipo)) return res.status(400).json({ erro: 'tipo_invalido', detalhe: 'Tipo de material inválido.' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ erro: 'arquivo_vazio', detalhe: 'Arquivo vazio.' });
    const ehPdf = buf.slice(0, 4).toString('latin1') === '%PDF';
    const ehJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if ((tipo === 'foto' && !ehJpeg) || (tipo !== 'foto' && !ehPdf)) return res.status(415).json({ erro: 'formato_invalido', detalhe: tipo === 'foto' ? 'A foto precisa ser JPG.' : 'Envie em PDF.' });
    const lib = await liberar(req, res, 'cadastrar'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    const it = await itemDe(req, res, esc, req.params.id); if (!it) return;
    const nome = agenda.limpar(String(req.query.nome || '').split(/[\\/]/).pop(), 120) || (tipo === 'foto' ? 'foto.jpg' : tipo + '.pdf');
    try {
      const cont = await banco('GET', '/rest/v1/agenda_materiais?item_id=eq.' + it.id + '&tipo=eq.' + tipo + '&select=id,caminho');
      const n = (cont.body || []).length;
      if ((tipo === 'documento' && n >= MAX_DOCS) || (tipo === 'foto' && n >= MAX_FOTOS)) return res.status(413).json({ erro: 'material_demais', detalhe: 'Esse item já tem o máximo de ' + (tipo === 'foto' ? MAX_FOTOS + ' fotos' : MAX_DOCS + ' documentos') + '.' });
      let texto = null; let paginas = null;
      if (ehPdf) {
        const t = await extrairTexto(buf, 40).catch(() => null);
        texto = t && t.texto ? String(t.texto).slice(0, TEXTO_DOC_CHARS) : null;
        paginas = t && Number.isInteger(t.paginas) ? t.paginas : null;
        if (tipo === 'edital' && !(texto && texto.replace(/\s+/g, '').length > 80)) return res.status(422).json({ erro: 'edital_sem_texto', detalhe: 'Não deu para ler o texto desse edital (parece escaneado). Cole o texto do edital no item.' });
      }
      const caminho = it.id + '/' + crypto.randomUUID() + (ehPdf ? '.pdf' : '.jpg');
      await deps.storageUpload(BUCKET, caminho, buf, ehPdf ? 'application/pdf' : 'image/jpeg');
      // Edital novo substitui o anterior.
      if (tipo === 'edital') for (const m of cont.body || []) { try { await deps.storageDelete(BUCKET, m.caminho); } catch (e) { /* some depois */ } await banco('DELETE', '/rest/v1/agenda_materiais?id=eq.' + m.id); }
      const r = await banco('POST', '/rest/v1/agenda_materiais', { item_id: it.id, tipo, nome, caminho, mime: ehPdf ? 'application/pdf' : 'image/jpeg', bytes: buf.length, paginas, texto: tipo === 'foto' ? null : texto, enviado_por: eu(req) });
      if (r.status >= 400) throw new Error('banco_' + r.status);
      let plano = null; let pauta = null;
      if (tipo === 'edital') {
        const campos = { edital_texto: texto.slice(0, EDITAL_CHARS), edital_nome: nome, atualizado_em: new Date(agora()).toISOString() };
        const p = extrairPauta(texto);
        // A pauta do edital vale mais que a da agenda, menos quando a pessoa corrigiu à mão.
        if (p.length && it.pauta_fonte !== 'manual') { campos.pauta = agenda.classificarPauta(p); campos.pauta_fonte = 'edital'; pauta = campos.pauta; }
        await banco('PATCH', '/rest/v1/agenda_itens?id=eq.' + it.id, campos);
        plano = await regenerar(it.mes);
      }
      auditar(req, 'agenda_material', { id_superlogica: it.id_superlogica, item: it.id, tipo, bytes: buf.length });
      res.json({ ok: true, pauta, plano, aviso: tipo === 'edital' && !pauta ? 'Não achei a lista numerada da pauta no edital; a pauta da agenda continua valendo.' : null });
    } catch (e) {
      console.warn('[agenda] material: ' + e.message);
      res.status(503).json({ erro: 'storage', detalhe: 'Não foi possível guardar o arquivo agora.' });
    }
  });

  async function materialDe(req, res, esc, id) {
    if (!agenda.UUID.test(String(id))) { res.status(400).json({ erro: 'id_invalido' }); return null; }
    const r = await banco('GET', '/rest/v1/agenda_materiais?id=eq.' + id + '&select=id,item_id,tipo,caminho&limit=1');
    const m = r.status === 200 && Array.isArray(r.body) ? r.body[0] : null;
    if (!m) { res.status(404).json({ erro: 'nao_encontrado' }); return null; }
    const it = await itemDe(req, res, esc, m.item_id); if (!it) return null;
    return { m, it };
  }
  app.delete('/api/agenda/materiais/:id', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const lib = await liberar(req, res, 'cadastrar'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    const x = await materialDe(req, res, esc, req.params.id); if (!x) return;
    try { await deps.storageDelete(BUCKET, x.m.caminho); } catch (e) { console.warn('[agenda] arquivo não apagado'); }
    await banco('DELETE', '/rest/v1/agenda_materiais?id=eq.' + x.m.id);
    if (x.m.tipo === 'edital') { await banco('PATCH', '/rest/v1/agenda_itens?id=eq.' + x.it.id, { edital_texto: null, edital_nome: null }); await regenerar(x.it.mes); }
    auditar(req, 'agenda_material_apagado', { id_superlogica: x.it.id_superlogica, item: x.it.id });
    res.json({ ok: true });
  });
  app.get('/api/agenda/materiais/:id/link', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const lib = await liberar(req, res, 'ver'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    const x = await materialDe(req, res, esc, req.params.id); if (!x) return;
    try { res.json({ url: await deps.storageSignedUrl(BUCKET, x.m.caminho, 300) }); } catch (e) { res.status(503).json({ erro: 'storage' }); }
  });

  // ── Aprovação ──
  app.post('/api/agenda/mes/:mes/aprovar', requireAuth, express.json({ limit: '200kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const mes = String(req.params.mes);
    if (!RE_MES.test(mes)) return res.status(400).json({ erro: 'mes_invalido' });
    const lib = await liberar(req, res, 'aprovar'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.filter((x) => agenda.UUID.test(String(x))).slice(0, 2000) : null;
    try {
      const d = await dadosDoMes(req, mes, esc);
      // Dia das certidões de vários condomínios: quem tem carteira só aprova se todos forem dela.
      const proprias = d.tarefas.filter((t) => t.item_id || esc.todas || ((t.parametros || {}).condominios || []).every((c) => dentro(esc, c)));
      const aprovar = agenda.aprovaveis(proprias, ids);
      if (!aprovar.length) return res.json({ aprovadas: 0 });
      const custo = agenda.estimarCusto(d.tarefas.filter((t) => aprovar.includes(t.id)), process.env, maxHora());
      const r = await banco('PATCH', '/rest/v1/agenda_tarefas?id=in.(' + aprovar.join(',') + ')&aprovacao=eq.pendente',
        { aprovacao: 'aprovada', aprovada_por: eu(req), aprovada_em: new Date(agora()).toISOString() });
      if (r.status >= 400) throw new Error('banco_' + r.status);
      const n = Array.isArray(r.body) ? r.body.length : aprovar.length;
      auditar(req, 'agenda_plano_aprovado', { mes, aprovadas: n, geracoes: custo.plano.geracoes, custo_estimado_usd: custo.plano.usd, item_a_item: !!ids });
      res.json({ aprovadas: n, custo });
    } catch (e) {
      console.warn('[agenda] aprovar: ' + e.message);
      res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível aprovar agora.' });
    }
  });

  async function tarefaDe(req, res, esc, id) {
    if (!agenda.UUID.test(String(id))) { res.status(400).json({ erro: 'id_invalido' }); return null; }
    const r = await banco('GET', '/rest/v1/agenda_tarefas?id=eq.' + id + '&limit=1');
    const t = r.status === 200 && Array.isArray(r.body) ? r.body[0] : null;
    if (!t) { res.status(404).json({ erro: 'nao_encontrado' }); return null; }
    if (t.item_id) { const it = await itemDe(req, res, esc, t.item_id); if (!it) return null; }
    else if (!esc.todas && !((t.parametros || {}).condominios || []).some((c) => dentro(esc, c))) { res.status(403).json({ erro: 'fora_da_carteira' }); return null; }
    return t;
  }
  app.post('/api/agenda/tarefas/:id/conferida', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const lib = await liberar(req, res, 'cadastrar'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    const t = await tarefaDe(req, res, esc, req.params.id); if (!t) return;
    if (!['pronta_conferir', 'manual'].includes(t.status)) return res.status(409).json({ erro: 'status', detalhe: 'Só marca como conferida o que está pronto para conferir ou com a equipe.' });
    const agoraIso = new Date(agora()).toISOString();
    await banco('PATCH', '/rest/v1/agenda_tarefas?id=eq.' + t.id + '&status=eq.' + t.status, Object.assign({ status: 'conferida', conferida_por: eu(req), conferida_em: agoraIso, atualizado_em: agoraIso }, t.pronta_em ? {} : { pronta_em: agoraIso }));
    auditar(req, 'agenda_tarefa_conferida', { id_superlogica: t.id_superlogica, tarefa: t.id, tipo: t.tipo });
    res.json({ ok: true });
  });
  app.post('/api/agenda/tarefas/:id/refazer', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const lib = await liberar(req, res, 'aprovar'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    const t = await tarefaDe(req, res, esc, req.params.id); if (!t) return;
    if (!agenda.AUTOMATICAS.has(t.tipo) || !['erro', 'pronta_conferir', 'pendente_material', 'conferida'].includes(t.status)) return res.status(409).json({ erro: 'status', detalhe: 'Essa tarefa não pode ser refeita agora.' });
    await banco('PATCH', '/rest/v1/agenda_tarefas?id=eq.' + t.id + '&status=eq.' + t.status, { status: 'agendada', motivo: null, erro: null, atualizado_em: new Date(agora()).toISOString() });
    auditar(req, 'agenda_tarefa_refazer', { id_superlogica: t.id_superlogica, tarefa: t.id, tipo: t.tipo });
    res.json({ ok: true });
  });

  app.put('/api/agenda/config', requireAuth, express.json({ limit: '10kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const lib = await liberar(req, res, 'aprovar'); if (!lib) return;
    const valores = agenda.lerConfig((req.body || {}).valores || {});
    try {
      let r = await banco('PATCH', '/rest/v1/agenda_config?chave=eq.padrao', { valores, atualizado_por: eu(req), atualizado_em: new Date(agora()).toISOString() });
      if (r.status < 400 && (!Array.isArray(r.body) || !r.body.length)) r = await banco('POST', '/rest/v1/agenda_config', { chave: 'padrao', valores, atualizado_por: eu(req) });
      if (r.status >= 400) throw new Error('banco_' + r.status);
      const mes = agenda.hojeBrasilia(agora()).slice(0, 7);
      const proximo = agenda.mesAnterior(mes, -1);
      await regenerar(mes); await regenerar(proximo);
      auditar(req, 'agenda_config', valores);
      res.json({ ok: true, valores });
    } catch (e) { res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível salvar agora.' }); }
  });

  app.post('/api/agenda/avisos/lidos', requireAuth, express.json({ limit: '50kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const lib = await liberar(req, res, 'ver'); if (!lib) return;
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.filter((x) => agenda.UUID.test(String(x))).slice(0, 200) : [];
    if (!ids.length) return res.json({ ok: true });
    const me = eu(req);
    const quem = me ? (lib.podeAprovar ? '&or=(user_id.eq.' + me + ',user_id.is.null)' : '&user_id=eq.' + me) : '&user_id=is.null';
    await banco('PATCH', '/rest/v1/agenda_avisos?id=in.(' + ids.join(',') + ')' + quem, { lido: true });
    res.json({ ok: true });
  });

  // ── Painel da gestão: cronograma, pronto e travado, e tendências dos meses anteriores ──
  app.get('/api/agenda/gestao/:mes', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const mes = String(req.params.mes);
    if (!RE_MES.test(mes)) return res.status(400).json({ erro: 'mes_invalido' });
    const lib = await liberar(req, res, 'gestao'); if (!lib) return;
    const esc = await escopoDe(req, res); if (!esc) return;
    try {
      const meses = [5, 4, 3, 2, 1, 0].map((n) => agenda.mesAnterior(mes, n));
      const lista = '(' + meses.map((m) => '"' + m + '"').join(',') + ')';
      const [ri, rt] = await Promise.all([
        banco('GET', '/rest/v1/agenda_itens?mes=in.' + lista + '&select=id,mes,tipo_item,id_superlogica,condominio_nome,data,hora,tipo_assembleia,cancelado,criado_por&limit=3000'),
        banco('GET', '/rest/v1/agenda_tarefas?mes=in.' + lista + '&select=id,mes,item_id,id_superlogica,tipo,titulo,data_execucao,prazo,status,aprovacao,motivo,erro,travas,tentativas,pronta_em,resultado,parametros&limit=10000'),
      ]);
      if (ri.status !== 200 || rt.status !== 200) throw new Error('banco_gestao');
      const itens = (ri.body || []).filter((it) => itemVisivel(esc, it, req));
      const vis = new Set(itens.map((i) => i.id));
      const tarefas = (rt.body || []).filter((t) => (t.item_id ? vis.has(t.item_id) : esc.todas || ((t.parametros || {}).condominios || []).some((c) => dentro(esc, c))));
      const doMes = (x) => x.mes === mes;
      const hoje = agenda.hojeBrasilia(agora());
      auditar(req, 'agenda_gestao_aberta', { mes });
      res.json({
        mes, rotulo: agenda.mesRotulo(mes), hoje,
        itens: itens.filter(doMes), tarefas: tarefas.filter(doMes).map((t) => Object.assign({}, t, { resultado: { trabalho_id: (t.resultado || {}).trabalho_id || null, titulo: (t.resultado || {}).titulo || null } })),
        painel: agenda.painelDoMes(tarefas.filter(doMes), itens.filter(doMes), hoje),
        tendencias: agenda.tendencias(meses, itens, tarefas, esc.todas ? await custoDosMeses(meses) : {}),
        custo_visivel: !!esc.todas, execucao: agendador.estado(),
      });
    } catch (e) {
      console.warn('[agenda] gestão: ' + e.message);
      res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível abrir o painel agora.' });
    }
  });

  agendador.ligar();
  return { agendador, regenerar, regenerarAgora };
}

module.exports = { criarRotasAgenda, BUCKET };
