// ─────────────────────────────────────────────────────────────────────────
// Agenda do mês: execução agendada no servidor.
//
// Um agendador interno olha a cada 10 minutos (a partir das 6h de Brasília) as tarefas
// APROVADAS cuja data chegou e dispara a função que o Hub já tem:
//   . prestação de contas pelo Superlógica (POST /api/prestacao/v13/superlogica + status);
//   . apresentação da assembleia com o edital e o material anexado (POST /api/apresentacao/gerar);
//   . dia das certidões: busca sozinho as certidões automáticas que faltam (POST
//     /api/certidoes/:id/buscar) e monta a lista do que a equipe ainda precisa emitir;
//   . pedido de material ao síndico: aviso para quem cuida do condomínio, com a mensagem pronta.
//   Previsão orçamentária, ata e tarefas soltas são da equipe: no dia viram aviso.
// As funções são chamadas pelo próprio servidor (endereço local, chave interna que nunca sai do
// processo nem vai para log), então seguem as mesmas regras, limites e conferências de quando a
// pessoa clica na tela. O resultado vai para a pasta Em andamento de quem cuida do item, ligado à
// tarefa da agenda, e fica "pronta para conferir". Nada é publicado nem enviado a condômino, e
// nada grava no Superlógica (as funções chamadas só leem).
//
// Travas contra rodar duas vezes:
//   1. no processo, uma rodada por vez (emAndamento);
//   2. no banco, cada tarefa é "pega" com um PATCH condicional (status, aprovação e versão iguais
//      ao que foi lido): se outra instância pegou antes, o PATCH volta vazio e esta pula;
//   3. trava com prazo: tarefa que ficou "rodando" depois de queda volta para agendada no prazo.
// Desligado por padrão: só roda com AGENDA_EXECUCAO=on (o Matheus liga quando quiser).
// Outras variáveis: AGENDA_HORA_INICIO (padrão 6), AGENDA_MAX_GERACOES_HORA (padrão 6).
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const crypto = require('crypto');
const agenda = require('./agenda');

const INTERVALO_MS = 10 * 60 * 1000;
const TRAVA_MS = 45 * 60 * 1000;
const POR_RODADA = 30;
const SUFIXO_AGUARDANDO = ' (aguardando certidões)';
const ANTES_DA_ASSEMBLEIA = new Set(['prestacao_contas', 'apresentacao', 'pedir_material', 'previsao_orcamentaria']);
const MIME_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const enc = encodeURIComponent;
const iso = (ms) => new Date(ms).toISOString();
const uuidOk = (v) => agenda.UUID.test(String(v || ''));

function ligadoPorAmbiente() { return String(process.env.AGENDA_EXECUCAO || 'off').trim().toLowerCase() === 'on'; }
function numeroAmbiente(nome, padrao, min, max) { const n = Number(process.env[nome]); return Number.isInteger(n) && n >= min && n <= max ? n : padrao; }

// Nome aceito pela pasta Em andamento (sem acento estranho, termina na extensão).
function nomeGuardado(base, ext) {
  let s = String(base || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 _.()]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!s) s = 'Documento';
  return s.slice(0, 110).trim() + '.' + ext;
}

// ── Chamadas às funções que já existem, pelo endereço local do próprio servidor ──
// Volta { status, json }. A chave interna vai só no cabeçalho, nunca em log.
function criarExecutoresInternos({ porta, segredo, host, intervaloMs, limiteMs }) {
  const H = host || '127.0.0.1';
  const espera = intervaloMs || 8000;
  const teto = limiteMs || 30 * 60 * 1000;
  function pedir(metodo, caminho, corpo, timeoutMs) {
    return new Promise((ok) => {
      if (!segredo || !porta) return ok({ status: 503, json: { erro: 'indisponivel' } });
      const buf = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
      const headers = { authorization: 'Bearer ' + segredo };
      if (buf) { headers['content-type'] = 'application/json'; headers['content-length'] = buf.length; }
      const req = http.request({ host: H, port: porta, path: caminho, method: metodo, headers, timeout: timeoutMs || 120000 }, (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (e) { j = null; } ok({ status: res.statusCode, json: j || {} }); });
        res.on('error', () => ok({ status: 502, json: {} }));
      });
      req.on('timeout', () => { req.destroy(); ok({ status: 504, json: {} }); });
      req.on('error', () => ok({ status: 502, json: {} }));
      if (buf) req.write(buf);
      req.end();
    });
  }
  // Abre o job e consulta o status até terminar (mesmo caminho da tela).
  async function gerarJob(rota, rotaStatus, corpo) {
    const r = await pedir('POST', rota, corpo, 300000);
    if (r.status === 429) return { ok: false, ocupado: true };
    if (r.status !== 202 || !r.json.jobId) {
      return { ok: false, motivo: /superlogica/.test(String(r.json.erro || '')) ? 'superlogica' : 'geracao', detalhe: String(r.json.detalhe || 'A geração não começou (código ' + r.status + ').').slice(0, 300) };
    }
    const fim = Date.now() + teto;
    while (Date.now() < fim) {
      await new Promise((x) => setTimeout(x, espera));
      const s = await pedir('GET', rotaStatus + enc(r.json.jobId), null, 120000);
      const j = s.json || {};
      if (j.status === 'done') return { ok: true, payload: j };
      if (j.status === 'error') return { ok: false, motivo: /superlogica/.test(String(j.erro || '')) ? 'superlogica' : 'geracao', detalhe: String(j.detalhe || 'A geração não terminou.').slice(0, 300) };
      if (j.status === 'not_found') return { ok: false, motivo: 'geracao', detalhe: 'A geração se perdeu no servidor (reinício). Vai ser feita de novo na próxima rodada.' };
    }
    return { ok: false, motivo: 'geracao', detalhe: 'A geração passou de 30 minutos.' };
  }
  return {
    gerarPrestacao: (p) => gerarJob('/api/prestacao/v13/superlogica', '/api/prestacao/v13/status/', p),
    gerarApresentacao: (c) => gerarJob('/api/apresentacao/gerar', '/api/apresentacao/status/', c),
    lerCertidoes: async (id) => { const r = await pedir('GET', '/api/certidoes/' + enc(id)); return r.status === 200 ? r.json : null; },
    buscarCertidao: async (id, tipo) => { const r = await pedir('POST', '/api/certidoes/' + enc(id) + '/buscar', { tipo }, 180000); return { ok: r.status === 200, status: r.status, detalhe: r.json && r.json.detalhe }; },
  };
}

// ── Pasta Em andamento: grava o trabalho direto para a pessoa (mesma tabela e bucket de
// servico/trabalhos.js). expira: a data da assembleia mais 3 dias, nunca menos de 7 dias.
function criarSalvarTrabalho({ banco, storageUpload }) {
  return async function salvarTrabalho({ userId, tipo, idSuperlogica, titulo, dados, arquivos, expiraEm }) {
    const linha = { user_id: userId, tipo, id_superlogica: idSuperlogica || null, titulo: String(titulo).slice(0, 160), dados, arquivos: [], atualizado_em: new Date().toISOString(), expira_em: expiraEm };
    const r = await banco('POST', '/rest/v1/trabalhos_salvos', linha);
    if (r.status >= 400 || !Array.isArray(r.body) || !r.body[0]) throw new Error('banco_' + r.status);
    const id = r.body[0].id;
    const guardados = [];
    for (const a of arquivos || []) {
      await storageUpload('trabalhos', userId + '/' + id + '/' + enc(a.nome), a.buf, a.mime);
      guardados.push({ nome: a.nome, bytes: a.buf.length });
    }
    if (guardados.length) await banco('PATCH', '/rest/v1/trabalhos_salvos?id=eq.' + id + '&user_id=eq.' + userId, { arquivos: guardados });
    return id;
  };
}

// deps: { banco, executores, salvarTrabalho, baixarMaterial(caminho) -> Buffer, ligado(), agora(),
//   maxHora(), horaInicio(), auditar(acao, detalhe), passouLimiteMensal?() -> bool, instancia? }
function criarAgendador(deps) {
  const { banco } = deps;
  const agora = deps.agora || Date.now;
  const ligado = deps.ligado || ligadoPorAmbiente;
  const maxHora = deps.maxHora || (() => numeroAmbiente('AGENDA_MAX_GERACOES_HORA', 6, 1, 20));
  const horaInicio = deps.horaInicio || (() => numeroAmbiente('AGENDA_HORA_INICIO', 6, 0, 23));
  const instancia = deps.instancia || ('agenda-' + crypto.randomBytes(6).toString('hex'));
  const auditar = (acao, det) => { try { if (deps.auditar) deps.auditar(acao, det); } catch (e) { /* registro nunca derruba */ } };
  let emAndamento = false;
  const usoHora = []; // início de cada geração (prestação ou apresentação) na última hora
  let timer = null;
  const ultima = { em: null, resultado: null };

  const cabeNaHora = () => { const corte = agora() - 3600000; while (usoHora.length && usoHora[0] < corte) usoHora.shift(); return usoHora.length < maxHora(); };

  async function lerUm(tabela, id) {
    const r = await banco('GET', '/rest/v1/' + tabela + '?id=eq.' + id + '&limit=1');
    return r.status === 200 && Array.isArray(r.body) ? r.body[0] || null : null;
  }
  async function avisar(linha) {
    try { await banco('POST', '/rest/v1/agenda_avisos', Object.assign({ lido: false }, linha)); } catch (e) { console.warn('[agenda] aviso não gravado'); }
  }
  const responsavel = (item, t) => [item && item.responsavel, item && item.criado_por, t.aprovada_por].find(uuidOk) || null;
  function expiraEm(dataAss) {
    const minimo = agora() + 7 * 86400000;
    const pelaAssembleia = agenda.dataValida(dataAss) ? Date.parse(agenda.somarDias(dataAss, 3) + 'T23:00:00Z') : 0;
    return iso(Math.max(minimo, pelaAssembleia));
  }
  async function ultimaChegadaMaterial(itemId) {
    const r = await banco('GET', '/rest/v1/agenda_materiais?item_id=eq.' + itemId + '&select=criado_em&order=criado_em.desc&limit=1');
    return r.status === 200 && Array.isArray(r.body) && r.body[0] ? r.body[0].criado_em : null;
  }
  const pendente = (motivo, extra) => Object.assign({ status: 'pendente_material', motivo, trava: motivo }, extra || {});
  const falha = (motivo, erro) => ({ status: 'erro', motivo, erro: agenda.semTraco(erro || agenda.MOTIVOS[motivo] || 'Falhou.').slice(0, 300), trava: motivo });

  // ── Prestação de contas ──
  async function fazerPrestacao(t, item) {
    if (!t.id_superlogica) return pendente('condominio_nao_reconhecido');
    const p = t.parametros || {};
    if (!p.inicio || !p.fim) return falha('sem_data', 'A tarefa não tem o período da prestação. Corrija a pauta na agenda.');
    const hoje = agenda.hojeBrasilia(agora());
    const ultimoFechado = agenda.mesAnterior(hoje.slice(0, 7), 1);
    if (p.inicio > ultimoFechado) return pendente('periodo_aberto');
    const fim = p.fim > ultimoFechado ? ultimoFechado : p.fim;
    const para = responsavel(item, t);
    if (!para) return falha('sem_responsavel');
    if (!cabeNaHora()) return { adiar: true };
    usoHora.push(agora());
    const r = await deps.executores.gerarPrestacao({ id_superlogica: t.id_superlogica, inicio: p.inicio, fim,
      obs: ('Assembleia ' + (item.tipo_assembleia || '').replace('_', ' e ') + ' de ' + agenda.dataBr(item.data)).trim() });
    if (r.ocupado) { usoHora.pop(); return { adiar: true }; }
    if (!r.ok) return Object.assign(falha(r.motivo || 'geracao', r.detalhe), { contou: true });
    const pl = r.payload || {};
    // Certidões: a prestação vai com a caixa "Incluir certidões" marcada; as válidas entram pela
    // tela de certidões (Baixar tudo). Falta alguma: título " (aguardando certidões)", como na tela.
    const cert = await situacaoCertidoes(t.id_superlogica, item.data);
    const cond = await linhaCondominio(t.id_superlogica);
    const nome = (cond && cond.nome) || item.condominio_nome || '';
    const rot = agenda.mesRotulo(p.inicio) + ' a ' + agenda.mesRotulo(fim);
    const titulo = ('Prestação ' + nome + ' ' + rot).replace(/\s+/g, ' ').trim() + (cert.faltando.length ? SUFIXO_AGUARDANDO : '');
    const base = pl.nome_arquivo || ('Prestação de Contas ' + nome);
    const arquivos = [];
    if (pl.pdf_b64) arquivos.push({ tipo: 'pdf', rotulo: 'PDF', nome: nomeGuardado(base, 'pdf'), nomeBaixar: base + '.pdf', buf: Buffer.from(pl.pdf_b64, 'base64'), mime: 'application/pdf' });
    if (pl.pptx_b64) arquivos.push({ tipo: 'pptx', rotulo: 'PowerPoint', nome: nomeGuardado(base, 'pptx'), nomeBaixar: base + '.pptx', buf: Buffer.from(pl.pptx_b64, 'base64'), mime: MIME_PPTX });
    if (!arquivos.length) return Object.assign(falha('geracao', 'A prestação voltou sem arquivo.'), { contou: true });
    const dados = {
      versao: 1, origem: 'superlogica', condId: cond ? cond.id : null, condNome: nome, idSuperlogica: t.id_superlogica, modoLivre: false,
      mesInicio: p.inicio, mesFim: fim, periodo: rot, observacoes: '', formato: 'ambos', modo: pl.modo || null, geradoEm: new Date(agora()).toISOString(),
      arquivos: arquivos.map((a) => ({ tipo: a.tipo, rotulo: a.rotulo, nome: a.nome, nomeBaixar: a.nomeBaixar })),
      arquivar: { tipo: 'prestacao', titulo: 'Prestação de contas ' + rot, idSuperlogica: t.id_superlogica, nomeCond: nome }, ajuste: null,
      incluir_certidoes: true, certidoes: cert.lista, outros_docs: [],
      agenda: { tarefa_id: t.id, item_id: item.id },
    };
    const trabalhoId = await deps.salvarTrabalho({ userId: para, tipo: 'prestacao', idSuperlogica: t.id_superlogica, titulo, dados, arquivos, expiraEm: expiraEm(item.data) });
    const avisos = (Array.isArray(pl.avisos) ? pl.avisos : []).map((a) => agenda.semTraco(String(a)).slice(0, 300)).slice(0, 10);
    if (fim !== p.fim) avisos.push('O mês de ' + agenda.mesRotulo(p.fim) + ' ainda não fechou; a prestação vai até ' + agenda.mesRotulo(fim) + '.');
    return {
      status: 'pronta_conferir', contou: true,
      resultado: { trabalho_id: trabalhoId, titulo, para, arquivos: arquivos.map((a) => a.nome), avisos, periodo: { inicio: p.inicio, fim }, faltando_certidoes: cert.faltando, material_em: null },
      aviso: { user_id: para, tipo: 'pronta', texto: 'Prestação de contas de ' + nome + ' pronta para conferir na pasta Em andamento.' + (cert.faltando.length ? ' Faltam certidões: ' + cert.faltando.join(', ') + '.' : '') },
    };
  }

  async function linhaCondominio(id) {
    const r = await banco('GET', '/rest/v1/condominios?id_superlogica=eq.' + Number(id) + '&select=id,nome,id_superlogica&limit=1');
    return r.status === 200 && Array.isArray(r.body) ? r.body[0] || null : null;
  }
  // Situação das certidões guardadas, no formato que a tela de certidões guarda no trabalho.
  async function situacaoCertidoes(id, ate) {
    const tipos = deps.tiposCertidao || [];
    const r = await banco('GET', '/rest/v1/certidoes_condominio?id_superlogica=eq.' + Number(id) + '&select=tipo,situacao,validade,caminho&limit=20');
    const linhas = r.status === 200 && Array.isArray(r.body) ? r.body : [];
    const faltando = agenda.certidoesFaltando(linhas, tipos, ate || agenda.hojeBrasilia(agora()));
    const por = new Map(linhas.map((l) => [l.tipo, l]));
    const lista = tipos.map((tp) => {
      const l = por.get(tp.tipo);
      const estado = !l ? 'faltando' : (l.validade && l.validade < agenda.hojeBrasilia(agora()) ? 'vencida' : l.validade ? 'valida' : 'sem_validade');
      return { tipo: tp.tipo, nome: tp.nome, estado, validade: (l && l.validade) || null, situacao: (l && l.situacao) || null, tem: !!l };
    });
    return { faltando, lista };
  }

  // ── Apresentação da assembleia ──
  async function fazerApresentacao(t, item) {
    const mats = await banco('GET', '/rest/v1/agenda_materiais?item_id=eq.' + item.id + '&select=id,tipo,nome,caminho,mime,paginas,texto,criado_em&order=criado_em.asc&limit=60');
    const lista = mats.status === 200 && Array.isArray(mats.body) ? mats.body : [];
    if (!String(item.edital_texto || '').trim()) return pendente('falta_edital', { mensagem: true });
    const docs = lista.filter((m) => m.tipo === 'documento');
    const fotos = lista.filter((m) => m.tipo === 'foto' && m.mime === 'image/jpeg');
    if (((t.parametros && t.parametros.trabalhos) || []).includes('obra_orcamentos') && !docs.length && !fotos.length) return pendente('falta_orcamentos', { mensagem: true });
    const para = responsavel(item, t);
    if (!para) return falha('sem_responsavel');
    if (!cabeNaHora()) return { adiar: true };
    const corpo = {
      idSuperlogica: t.id_superlogica || undefined, condominio: item.condominio_nome || '', edital_texto: item.edital_texto,
      pedido: 'Apresentação da assembleia ' + (item.tipo_assembleia || '').replace('_', ' e ') + ' de ' + agenda.dataBr(item.data) + (item.hora ? ' às ' + item.hora : '') + '.',
      documentos: [], fotos: [],
    };
    for (const d of docs.slice(0, 30)) {
      const buf = await deps.baixarMaterial(d.caminho);
      corpo.documentos.push({ nome: d.nome, tipo: 'pdf', paginas: d.paginas || undefined, texto: d.texto || '', pdf_b64: buf.toString('base64') });
    }
    for (const f of fotos.slice(0, 40)) {
      const buf = await deps.baixarMaterial(f.caminho);
      corpo.fotos.push({ nome: f.nome, b64: buf.toString('base64') });
    }
    usoHora.push(agora());
    const r = await deps.executores.gerarApresentacao(corpo);
    if (r.ocupado) { usoHora.pop(); return { adiar: true }; }
    if (!r.ok) return Object.assign(falha(r.motivo || 'geracao', r.detalhe), { contou: true });
    const pl = r.payload || {};
    const base = String(pl.titulo_arquivo || ('Apresentação ' + (item.condominio_nome || ''))).slice(0, 110);
    const arquivos = [];
    if (pl.pptx_b64) arquivos.push({ nome: nomeGuardado(base, 'pptx'), buf: Buffer.from(pl.pptx_b64, 'base64'), mime: MIME_PPTX });
    if (pl.pdf_b64) arquivos.push({ nome: nomeGuardado(base, 'pdf'), buf: Buffer.from(pl.pdf_b64, 'base64'), mime: 'application/pdf' });
    if (!arquivos.length) return Object.assign(falha('geracao', 'A apresentação voltou sem arquivo.'), { contou: true });
    const titulo = ('Apresentação ' + base).replace(/^Apresentação Apresentação/, 'Apresentação').slice(0, 160);
    const dados = { versao: 2, roteiro: pl.roteiro || null, avisos: pl.avisos || [], pauta: pl.pauta || [], inseridos: [], titulo_arquivo: base, slides: pl.slides || 0,
      geradoEm: new Date(agora()).toISOString(), condNome: item.condominio_nome || '', agenda: { tarefa_id: t.id, item_id: item.id } };
    const trabalhoId = await deps.salvarTrabalho({ userId: para, tipo: 'apresentacao', idSuperlogica: t.id_superlogica, titulo, dados, arquivos, expiraEm: expiraEm(item.data) });
    const materialEm = lista.length ? lista[lista.length - 1].criado_em : null;
    return {
      status: 'pronta_conferir', contou: true,
      resultado: { trabalho_id: trabalhoId, titulo, para, arquivos: arquivos.map((a) => a.nome), slides: pl.slides || 0,
        avisos: (Array.isArray(pl.avisos) ? pl.avisos : []).map((a) => agenda.semTraco(String(a)).slice(0, 300)).slice(0, 15), material_em: materialEm },
      aviso: { user_id: para, tipo: 'pronta', texto: 'Apresentação da assembleia de ' + (item.condominio_nome || '') + ' pronta para conferir na pasta Em andamento.' },
    };
  }

  // ── Dia das certidões: busca as automáticas e lista o que falta, condomínio por condomínio ──
  async function fazerCertidoes(t) {
    const p = t.parametros || {};
    const hoje = agenda.hojeBrasilia(agora());
    const datas = new Map(); // condomínio -> data da assembleia (a mais próxima que ainda vai acontecer)
    for (const itemId of p.itens || []) {
      const it = await lerUm('agenda_itens', itemId);
      if (it && it.id_superlogica && !it.cancelado && it.data >= hoje) { const k = Number(it.id_superlogica); if (!datas.has(k) || it.data < datas.get(k)) datas.set(k, it.data); }
    }
    const ids = (p.condominios || []).filter((x) => datas.has(Number(x)));
    if (!ids.length) return { status: 'cancelada', motivo: 'assembleia_passou' };
    const saida = [];
    for (const id of ids) {
      const linha = { id_superlogica: Number(id), nome: '', buscadas: [], faltando: [], erro: null };
      const tela = await deps.executores.lerCertidoes(id);
      if (!tela) { linha.erro = 'Não foi possível ler o cadastro agora; confira na tela de certidões.'; saida.push(linha); continue; }
      linha.nome = tela.nome || '';
      const ate = datas.get(Number(id)) || agenda.hojeBrasilia(agora());
      const faltaAntes = agenda.certidoesFaltando((tela.certidoes || []).map((c) => Object.assign({ caminho: c.arquivo_nome || c.url ? 'ok' : null }, c)), tela.tipos || [], ate);
      for (const tp of (tela.tipos || []).filter((x) => x.automatica && faltaAntes.includes(x.nome))) {
        const b = await deps.executores.buscarCertidao(id, tp.tipo);
        linha.buscadas.push({ nome: tp.nome, ok: !!(b && b.ok) });
      }
      const r = await banco('GET', '/rest/v1/certidoes_condominio?id_superlogica=eq.' + Number(id) + '&select=tipo,situacao,validade,caminho&limit=20');
      linha.faltando = agenda.certidoesFaltando(r.status === 200 && Array.isArray(r.body) ? r.body : [], tela.tipos || [], ate);
      saida.push(linha);
    }
    const total = saida.reduce((s, l) => s + l.faltando.length, 0);
    return {
      status: 'pronta_conferir', resultado: { condominios: saida, faltando_total: total },
      aviso: { user_id: null, tipo: 'certidoes_dia', texto: 'Dia das certidões: ' + saida.length + ' condomínio(s), ' + total + ' certidão(ões) para emitir. A lista está na Agenda do mês.' },
    };
  }

  // ── Pedido de material ao síndico: aviso com a mensagem pronta (nada é enviado sozinho) ──
  async function fazerPedirMaterial(t, item) {
    const p = t.parametros || {};
    const para = responsavel(item, t);
    const nome = item.condominio_nome || 'condomínio';
    const lista = (p.precisa || []).join('; ');
    const mensagem = 'Ei, tudo bem? Para a assembleia do ' + nome + ' no dia ' + agenda.dataBr(item.data) + ', preciso que você me mande até ' + agenda.dataBr(p.ate || item.data) + ': ' + lista + '. Pode mandar por aqui mesmo.';
    return {
      status: 'pronta_conferir', resultado: { mensagem, para },
      aviso: { user_id: para, tipo: 'pedir_material', texto: 'Pedir ao síndico do ' + nome + ' o material da assembleia de ' + agenda.dataBr(item.data) + '.', mensagem },
    };
  }

  // Executa uma tarefa já pega. Devolve o que gravar.
  async function executar(t) {
    const item = t.item_id ? await lerUm('agenda_itens', t.item_id) : null;
    if (t.item_id && (!item || item.cancelado)) return { status: 'cancelada', motivo: 'removida_do_plano' };
    // O que é para antes da assembleia não roda depois que ela já aconteceu.
    if (item && ANTES_DA_ASSEMBLEIA.has(t.tipo) && agenda.dataValida(item.data) && item.data < agenda.hojeBrasilia(agora())) return { status: 'cancelada', motivo: 'assembleia_passou' };
    if (t.tipo === 'prestacao_contas') return fazerPrestacao(t, item);
    if (t.tipo === 'apresentacao') return fazerApresentacao(t, item);
    if (t.tipo === 'certidoes') return fazerCertidoes(t);
    if (t.tipo === 'pedir_material') return fazerPedirMaterial(t, item);
    // Da equipe: no dia vira aviso e continua com a equipe até alguém marcar como conferida.
    const nome = (item && item.condominio_nome) || '';
    const textos = {
      previsao_orcamentaria: 'Preparar a previsão orçamentária de ' + nome + ' no módulo Previsão Orçamentária (assembleia em ' + agenda.dataBr(item && item.data) + ').',
      ata: 'Ata da assembleia de ' + nome + ': assim que o áudio chegar, gere no módulo de Atas.',
      outra: 'Tarefa do dia: ' + (t.titulo || ''),
    };
    return { status: 'manual', resultado: { avisado: agenda.hojeBrasilia(agora()) }, aviso: { user_id: responsavel(item, t), tipo: 'equipe', texto: textos[t.tipo] || textos.outra } };
  }

  async function candidatas(hoje) {
    const base = '/rest/v1/agenda_tarefas?aprovacao=eq.aprovada&data_execucao=lte.' + hoje + '&order=data_execucao.asc,criado_em.asc&limit=' + POR_RODADA;
    const a = await banco('GET', base + '&status=in.(agendada,pendente_material)');
    const b = await banco('GET', base + '&status=eq.manual&resultado->>avisado=is.null');
    const lista = [].concat(a.status === 200 && Array.isArray(a.body) ? a.body : [], b.status === 200 && Array.isArray(b.body) ? b.body : []);
    return lista.filter((t) => t.aprovacao === 'aprovada' && t.data_execucao <= hoje); // conferência em código também
  }

  // Trava no banco: PATCH condicional (status, aprovação e versão iguais ao que foi lido).
  // Volta true só quando esta instância pegou a tarefa.
  async function pegar(t) {
    const pega = await banco('PATCH', '/rest/v1/agenda_tarefas?id=eq.' + t.id + '&status=eq.' + t.status + '&aprovacao=eq.aprovada&versao=eq.' + (t.versao || 1),
      { status: 'rodando', trava_ate: iso(agora() + TRAVA_MS), trava_dono: instancia, atualizado_em: iso(agora()) });
    return !!(pega.status < 300 && Array.isArray(pega.body) && pega.body[0]);
  }

  // Executa uma tarefa já pega e grava o resultado, o aviso e o registro. Devolve
  // { id, tipo, status, motivo } ou null quando foi adiada (volta ao status de antes).
  async function processar(t) {
    let res;
    try { res = await executar(t); } catch (e) {
      console.warn('[agenda] tarefa ' + t.tipo + ' falhou: ' + (e && e.message));
      res = falha('geracao', 'Erro inesperado ao executar. Use Refazer.');
    }
    if (res.adiar) {
      await banco('PATCH', '/rest/v1/agenda_tarefas?id=eq.' + t.id + '&trava_dono=eq.' + instancia, { status: t.status, trava_ate: null, trava_dono: null });
      return null;
    }
    const campos = {
      status: res.status, motivo: res.motivo || null, erro: res.erro || null, trava_ate: null, trava_dono: null,
      resultado: Object.assign({}, t.resultado || {}, res.resultado || {}), executada_em: iso(agora()), atualizado_em: iso(agora()),
      tentativas: (Number(t.tentativas) || 0) + (res.contou ? 1 : 0),
    };
    if (res.status === 'pronta_conferir') campos.pronta_em = iso(agora());
    if (res.status === 'pronta_conferir' && t.tipo === 'apresentacao' && campos.resultado.material_em == null) campos.resultado.material_em = await ultimaChegadaMaterial(t.item_id);
    const motivoNovo = res.trava && res.trava !== t.motivo;
    if (motivoNovo) campos.travas = (Array.isArray(t.travas) ? t.travas : []).concat([{ motivo: res.trava, em: iso(agora()) }]).slice(-20);
    await banco('PATCH', '/rest/v1/agenda_tarefas?id=eq.' + t.id + '&trava_dono=eq.' + instancia, campos);
    // Pendência e erro avisam uma vez por motivo; pronta e lembretes avisam sempre.
    let aviso = res.aviso;
    if (!aviso && motivoNovo) {
      const item = t.item_id ? await lerUm('agenda_itens', t.item_id) : null;
      const nome = (item && item.condominio_nome) || '';
      const texto = (res.status === 'erro' ? 'Erro em ' : 'Pendente: ') + (agenda.ROTULO_TIPO[t.tipo] || t.tipo).toLowerCase() + ' de ' + nome + '. ' + (agenda.MOTIVOS[res.motivo] || res.erro || '') + '.';
      const mensagem = res.mensagem && item ? 'Ei, tudo bem? Para a assembleia do ' + nome + ' no dia ' + agenda.dataBr(item.data) + ', preciso que você me mande ' + (res.motivo === 'falta_edital' ? 'o edital' : 'os orçamentos e as fotos') + ' o quanto antes. Pode mandar por aqui mesmo.' : null;
      aviso = { user_id: responsavel(item, t), tipo: res.status === 'erro' ? 'erro' : 'pendente_material', texto: agenda.semTraco(texto).replace(/\.\./g, '.'), mensagem };
    }
    if (aviso) await avisar(Object.assign({ tarefa_id: t.id, item_id: t.item_id || null, id_superlogica: t.id_superlogica || null }, aviso));
    auditar('agenda_tarefa_executada', { tarefa: t.id, tipo: t.tipo, status: res.status, motivo: res.motivo || null, id_superlogica: t.id_superlogica || null, manual: !!t._manual });
    return { id: t.id, tipo: t.tipo, status: res.status, motivo: res.motivo || null };
  }

  // Rodar agora (botão da gestão): a mesma execução da rodada, para uma tarefa só, sem esperar a
  // data. Vale com AGENDA_EXECUCAO desligado e fora do horário, porque é ação de uma pessoa. As
  // travas continuam: só tarefa aprovada, pega no banco com o PATCH condicional e o limite de
  // gerações por hora (e o limite de gasto do mês). Devolve { iniciada, motivo?, fim? }: fim é a
  // promessa da execução, que segue em segundo plano (a prestação pode levar vários minutos).
  async function rodarUma(id) {
    if (!uuidOk(id)) return { iniciada: false, motivo: 'id_invalido' };
    const agoraMs = agora();
    await banco('PATCH', '/rest/v1/agenda_tarefas?id=eq.' + id + '&status=eq.rodando&trava_ate=lt.' + enc(iso(agoraMs)), { status: 'agendada', trava_ate: null, trava_dono: null });
    const t = await lerUm('agenda_tarefas', id);
    if (!t) return { iniciada: false, motivo: 'nao_encontrada' };
    if (t.aprovacao !== 'aprovada') return { iniciada: false, motivo: 'nao_aprovada' };
    if (t.status === 'rodando') return { iniciada: false, motivo: 'rodando' };
    const podeRodar = t.status === 'agendada' || t.status === 'pendente_material' || (t.status === 'manual' && !(t.resultado && t.resultado.avisado));
    if (!podeRodar) return { iniciada: false, motivo: 'status' };
    if (agenda.GERACOES.has(t.tipo)) {
      let semGeracao = false;
      if (deps.passouLimiteMensal) { try { semGeracao = !!(await deps.passouLimiteMensal()); } catch (e) { semGeracao = false; } }
      if (semGeracao) return { iniciada: false, motivo: 'limite_mes' };
      if (!cabeNaHora()) return { iniciada: false, motivo: 'limite_hora' };
    }
    if (!(await pegar(t))) return { iniciada: false, motivo: 'pega_por_outra' };
    const fim = processar(Object.assign({}, t, { _manual: true })).catch((e) => {
      console.warn('[agenda] rodar agora falhou: ' + (e && e.message));
      return null;
    });
    return { iniciada: true, fim };
  }

  // Uma rodada. Devolve { rodou, motivo?, executadas: [{ id, tipo, status }] }.
  async function rodar() {
    if (!ligado()) return { rodou: false, motivo: 'desligado', executadas: [] };
    if (emAndamento) return { rodou: false, motivo: 'em_andamento', executadas: [] };
    const agoraMs = agora();
    if (agenda.horaBrasilia(agoraMs) < horaInicio()) return { rodou: false, motivo: 'fora_do_horario', executadas: [] };
    emAndamento = true;
    const executadas = [];
    try {
      await banco('PATCH', '/rest/v1/agenda_tarefas?status=eq.rodando&trava_ate=lt.' + enc(iso(agoraMs)), { status: 'agendada', trava_ate: null, trava_dono: null });
      const hoje = agenda.hojeBrasilia(agoraMs);
      let semGeracao = false;
      if (deps.passouLimiteMensal) { try { semGeracao = !!(await deps.passouLimiteMensal()); } catch (e) { semGeracao = false; } }
      for (const t of await candidatas(hoje)) {
        if (agenda.GERACOES.has(t.tipo) && (semGeracao || !cabeNaHora())) continue;
        if (!(await pegar(t))) continue; // outra instância pegou
        const feito = await processar(t);
        if (feito) executadas.push(feito);
      }
      return { rodou: true, executadas };
    } finally {
      emAndamento = false;
      ultima.em = iso(agora()); ultima.resultado = executadas.length;
    }
  }

  function ligar() {
    if (timer || !ligado()) return false;
    const rodada = () => rodar().catch((e) => console.warn('[agenda] rodada falhou: ' + (e && e.message)));
    timer = setInterval(rodada, INTERVALO_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const t0 = setTimeout(rodada, 2 * 60 * 1000);
    if (typeof t0.unref === 'function') t0.unref();
    console.log('[agenda] execução agendada ligada');
    return true;
  }
  function estado() { return { ligada: ligado(), rodando: emAndamento, ultima_rodada: ultima.em, geracoes_na_hora: usoHora.length, limite_hora: maxHora(), hora_inicio: horaInicio() }; }
  return { rodar, rodarUma, ligar, estado, instancia };
}

module.exports = { criarAgendador, criarExecutoresInternos, criarSalvarTrabalho, nomeGuardado, ligadoPorAmbiente, numeroAmbiente, INTERVALO_MS };
