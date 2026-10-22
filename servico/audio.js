// T16 e T17: áudio e transcrição SÓ pelo servidor.
// O navegador manda o arquivo e recebe um código nosso (nunca o endereço nem o código
// do serviço de transcrição). Toda transcrição fica guardada na tabela transcricoes,
// com quem fez e de qual condomínio. O texto só volta para quem tem a ação
// atas.transcricao_livre; os outros recebem só "pronta" e geram a ata pelo código.

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHAVE = () => process.env.ASSEMBLYAI_KEY || '';
const ARQUIVOS = new Map(); // arquivoId -> { url, dono, ate }
const PRAZO_ARQUIVO_MS = 6 * 60 * 60 * 1000;

const PALAVRAS_CHAVE = ['síndico', 'subsíndico', 'conselho fiscal', 'quórum', 'fundo de reserva',
  'convenção', 'regimento interno', 'taxa condominial', 'rateio', 'prestação de contas', 'inadimplência',
  'assembleia geral ordinária', 'assembleia geral extraordinária', 'previsão orçamentária', 'ata'];

function servico(method, caminho, corpo, extra) {
  return new Promise((resolve) => {
    const body = corpo ? JSON.stringify(corpo) : null;
    const headers = Object.assign({ authorization: CHAVE() }, body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {});
    const r = https.request({ hostname: 'api.assemblyai.com', path: caminho, method, headers, timeout: (extra && extra.timeout) || 30000 }, (resp) => {
      const partes = [];
      resp.on('data', (c) => partes.push(c));
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (e) { j = null; }
        resolve({ status: resp.statusCode, json: j });
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 504, json: null }); });
    r.on('error', () => resolve({ status: 502, json: null }));
    if (body) r.write(body);
    r.end();
  });
}

// T44: envio em partes. Áudio grande sobe em pedaços curtos (cada pedido termina bem antes
// do limite de tempo da borda do Railway, mesmo em internet lenta), fica guardado em pasta
// temporária e, no fim, vai inteiro ao serviço de transcrição numa só passada de servidor
// para servidor. Funciona igual em qualquer computador e navegador.
const PASTA_PARTES = path.join(os.tmpdir(), 'audio-partes');
const PARTE_MAX = 40 * 1024 * 1024;           // tamanho máximo de cada parte
const PARTES_MAX = 60;                         // até 2,4 GB por áudio
const SESSOES = new Map(); // sessaoId -> { dono, nome, total, recebidas:Set, bytes, ate }
const PRAZO_SESSAO_MS = 2 * 60 * 60 * 1000;
function caminhoParte(sessao, i) { return path.join(PASTA_PARTES, sessao + '.' + i); }
function apagarSessao(sessao) {
  const ss = SESSOES.get(sessao);
  SESSOES.delete(sessao);
  if (!ss) return;
  for (let i = 0; i < ss.total; i++) fs.unlink(caminhoParte(sessao, i), () => {});
}

function limparVencidos() {
  const agora = Date.now();
  for (const [k, v] of ARQUIVOS) if (v.ate < agora) ARQUIVOS.delete(k);
  for (const [k, v] of SESSOES) if (v.ate < agora) apagarSessao(k);
}

function quem(req) { return String((req.user && req.user.sub) || ''); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function criarRotasAudio(app, d) {
  const { requireAuth, express, banco, perfilDe, temAcao, condominioDaBase, auditar } = d;
  const livre = async (req) => req.authMode === 'internal' || temAcao(await perfilDe(req), 'atas', 'transcricao_livre');
  // Só quem tem o módulo de atas usa a transcrição, com teto por hora.
  const exigirAtas = async (req, res, next) => {
    let ok = false;
    try { ok = d.podeAtas ? await d.podeAtas(req) : false; } catch (e) { ok = false; }
    if (!ok) { auditar(req, 'transcricao_recusada', { motivo: 'sem_permissao' }, true); return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não tem acesso a esta função.' }); }
    next();
  };
  const limite = (tipo, max) => (req, res, next) => (!d.dentroDoLimite || d.dentroDoLimite(req, tipo, max)) ? next()
    : res.status(429).json({ erro: 'limite', detalhe: 'Muitos envios em pouco tempo. Tente de novo mais tarde.' });
  const nomeArquivo = (v) => { let s = String(v || ''); try { s = decodeURIComponent(s); } catch (e) { /* fica como veio */ } return s.replace(/[\u0000-\u001f]/g, '').slice(0, 200); };

  // Passo 1: recebe o áudio em fluxo e repassa ao serviço (sem guardar o arquivo aqui).
  app.post('/api/audio/enviar', requireAuth, exigirAtas, limite('audio_envio', 30), (req, res) => {
    if (!CHAVE()) return res.status(503).json({ erro: 'servico_indisponivel', detalhe: 'Transcrição indisponível no momento.' });
    const len = req.headers['content-length'];
    const pr = https.request({ hostname: 'api.assemblyai.com', path: '/v2/upload', method: 'POST', timeout: 300000,
      headers: Object.assign({ authorization: CHAVE(), 'content-type': 'application/octet-stream' }, len ? { 'content-length': len } : { 'transfer-encoding': 'chunked' }) }, (r) => {
      const partes = [];
      r.on('data', (c) => partes.push(c));
      r.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (e) { j = null; }
        if (!j || !j.upload_url) { console.error('[audio] envio falhou status ' + r.statusCode); return res.status(502).json({ erro: 'falha_envio', detalhe: 'Não foi possível enviar o áudio. Tente de novo.' }); }
        limparVencidos();
        const id = crypto.randomUUID();
        ARQUIVOS.set(id, { url: j.upload_url, dono: quem(req), ate: Date.now() + PRAZO_ARQUIVO_MS, nome: nomeArquivo(req.headers['x-nome-arquivo']) });
        res.json({ arquivo_id: id });
      });
    });
    pr.on('error', () => { if (!res.headersSent) res.status(502).json({ erro: 'falha_envio', detalhe: 'Não foi possível enviar o áudio. Tente de novo.' }); });
    pr.on('timeout', () => { pr.destroy(); if (!res.headersSent) res.status(504).json({ erro: 'tempo_esgotado', detalhe: 'O envio demorou demais. Tente de novo.' }); });
    req.on('aborted', () => pr.destroy());
    req.pipe(pr);
  });

  // T44: passo 1 em partes. (a) abre a sessão; (b) recebe cada parte; (c) finaliza e envia.
  app.post('/api/audio/partes/iniciar', requireAuth, exigirAtas, limite('audio_envio', 30), express.json(), (req, res) => {
    if (!CHAVE()) return res.status(503).json({ erro: 'servico_indisponivel', detalhe: 'Transcrição indisponível no momento.' });
    const total = Number((req.body || {}).total);
    if (!Number.isInteger(total) || total < 1 || total > PARTES_MAX) return res.status(400).json({ erro: 'partes_invalidas', detalhe: 'Arquivo grande demais para envio.' });
    limparVencidos();
    try { fs.mkdirSync(PASTA_PARTES, { recursive: true }); } catch (e) { return res.status(500).json({ erro: 'falha_envio', detalhe: 'Não foi possível preparar o envio.' }); }
    const id = crypto.randomUUID();
    SESSOES.set(id, { dono: quem(req), nome: nomeArquivo((req.body || {}).nome), total, recebidas: new Set(), bytes: 0, ate: Date.now() + PRAZO_SESSAO_MS });
    res.json({ sessao: id, parte_max: PARTE_MAX });
  });

  app.post('/api/audio/partes/:sessao/parte/:indice', requireAuth, exigirAtas, limite('audio_parte', 400), (req, res) => {
    const sessao = req.params.sessao;
    const ss = UUID.test(sessao) ? SESSOES.get(sessao) : null;
    const i = Number(req.params.indice);
    if (!ss || ss.dono !== quem(req)) return res.status(404).json({ erro: 'sessao_nao_encontrada', detalhe: 'O envio expirou. Envie o áudio de novo.' });
    if (!Number.isInteger(i) || i < 0 || i >= ss.total) return res.status(400).json({ erro: 'parte_invalida', detalhe: 'Parte inválida.' });
    const destino = caminhoParte(sessao, i);
    const tmp = destino + '.tmp';
    const out = fs.createWriteStream(tmp);
    let bytes = 0, estourou = false;
    req.on('data', (c) => { bytes += c.length; if (bytes > PARTE_MAX && !estourou) { estourou = true; req.unpipe(out); out.destroy(); fs.unlink(tmp, () => {}); res.status(413).json({ erro: 'parte_grande', detalhe: 'Parte acima do limite.' }); } });
    req.on('aborted', () => { out.destroy(); fs.unlink(tmp, () => {}); });
    out.on('error', () => { if (!res.headersSent) res.status(500).json({ erro: 'falha_envio', detalhe: 'Não foi possível gravar a parte.' }); });
    out.on('finish', () => {
      if (estourou || res.headersSent) return;
      fs.rename(tmp, destino, (err) => {
        if (err) return res.status(500).json({ erro: 'falha_envio', detalhe: 'Não foi possível gravar a parte.' });
        if (!ss.recebidas.has(i)) ss.recebidas.add(i);
        ss.ate = Date.now() + PRAZO_SESSAO_MS;
        res.json({ ok: true, recebidas: ss.recebidas.size, total: ss.total });
      });
    });
    req.pipe(out);
  });

  app.post('/api/audio/partes/:sessao/finalizar', requireAuth, exigirAtas, (req, res) => {
    const sessao = req.params.sessao;
    const ss = UUID.test(sessao) ? SESSOES.get(sessao) : null;
    if (!ss || ss.dono !== quem(req)) return res.status(404).json({ erro: 'sessao_nao_encontrada', detalhe: 'O envio expirou. Envie o áudio de novo.' });
    if (ss.recebidas.size !== ss.total) return res.status(400).json({ erro: 'partes_faltando', detalhe: 'Faltam partes do áudio. Envie de novo.' });
    let tamanho = 0;
    try { for (let i = 0; i < ss.total; i++) tamanho += fs.statSync(caminhoParte(sessao, i)).size; }
    catch (e) { apagarSessao(sessao); return res.status(400).json({ erro: 'partes_faltando', detalhe: 'Faltam partes do áudio. Envie de novo.' }); }
    const pr = https.request({ hostname: 'api.assemblyai.com', path: '/v2/upload', method: 'POST', timeout: 300000,
      headers: { authorization: CHAVE(), 'content-type': 'application/octet-stream', 'content-length': tamanho } }, (r) => {
      const partes = [];
      r.on('data', (c) => partes.push(c));
      r.on('end', () => {
        apagarSessao(sessao);
        let j = null; try { j = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (e) { j = null; }
        if (!j || !j.upload_url) { console.error('[audio] envio em partes falhou status ' + r.statusCode); if (!res.headersSent) res.status(502).json({ erro: 'falha_envio', detalhe: 'Não foi possível enviar o áudio. Tente de novo.' }); return; }
        const id = crypto.randomUUID();
        ARQUIVOS.set(id, { url: j.upload_url, dono: ss.dono, ate: Date.now() + PRAZO_ARQUIVO_MS, nome: ss.nome });
        if (!res.headersSent) res.json({ arquivo_id: id });
      });
    });
    pr.on('error', () => { apagarSessao(sessao); if (!res.headersSent) res.status(502).json({ erro: 'falha_envio', detalhe: 'Não foi possível enviar o áudio. Tente de novo.' }); });
    pr.on('timeout', () => { pr.destroy(); });
    // Junta as partes em ordem, uma de cada vez, direto no envio (sem carregar tudo na memória).
    let i = 0;
    const proxima = () => {
      if (i >= ss.total) return pr.end();
      const rs = fs.createReadStream(caminhoParte(sessao, i++));
      rs.on('error', () => pr.destroy(new Error('parte ilegível')));
      rs.on('end', proxima);
      rs.pipe(pr, { end: false });
    };
    proxima();
  });

  // Passo 2: começa a transcrição. Sem transcrição livre, o condomínio é obrigatório e tem de ser da base.
  app.post('/api/audio/transcrever', requireAuth, exigirAtas, limite('audio_transcrever', 30), express.json(), async (req, res) => {
    const b = req.body || {};
    const arq = ARQUIVOS.get(String(b.arquivo_id || ''));
    if (!arq || arq.dono !== quem(req)) return res.status(404).json({ erro: 'arquivo_nao_encontrado', detalhe: 'Envie o áudio de novo.' });
    const ehLivre = await livre(req);
    const idSL = b.id_superlogica != null && b.id_superlogica !== '' ? String(b.id_superlogica) : '';
    let cond = null;
    if (idSL) {
      cond = /^[1-9][0-9]{0,8}$/.test(idSL) ? await condominioDaBase(idSL) : null;
      if (!cond) { auditar(req, 'transcricao_recusada', { id_superlogica: idSL, motivo: 'condominio_fora_da_base' }, true); return res.status(403).json({ erro: 'condominio_fora_da_base', detalhe: 'Esse condomínio não está na base do sistema.' }); }
    } else if (!ehLivre) {
      return res.status(400).json({ erro: 'condominio_obrigatorio', detalhe: 'Escolha o condomínio antes de enviar o áudio.' });
    }
    const r = await servico('POST', '/v2/transcript', { audio_url: arq.url, speech_models: ['universal-3-5-pro', 'universal-2'], language_detection: true,
      speaker_labels: true, keyterms_prompt: PALAVRAS_CHAVE, punctuate: true, format_text: true, disfluencies: false });
    if (!r.json || !r.json.id) { console.error('[audio] início falhou status ' + r.status); return res.status(502).json({ erro: 'falha_transcricao', detalhe: 'Não foi possível começar a transcrição. Tente de novo.' }); }
    ARQUIVOS.delete(String(b.arquivo_id));
    const ins = await banco('POST', '/rest/v1/transcricoes', {
      user_id: quem(req) || null, email: (req.user && req.user.email) || null, id_superlogica: cond ? Number(idSL) : null,
      condominio_nome: cond ? cond.nome : null, origem: 'audio', arquivo_nome: arq.nome || null, servico_id: r.json.id, status: 'processando' });
    const row = ins.status === 201 && Array.isArray(ins.body) ? ins.body[0] : null;
    if (!row) { console.error('[audio] gravar transcrição falhou ' + ins.status); return res.status(500).json({ erro: 'falha_registro', detalhe: 'Não foi possível registrar a transcrição.' }); }
    auditar(req, 'transcricao_iniciada', { transcricao_id: row.id, id_superlogica: idSL || null, sem_condominio: !idSL }, !idSL && !(await perfilDono(req, d)));
    res.json({ transcricao_id: row.id });
  });

  // Passo 3: andamento. Quando fica pronta, o texto vai para o banco.
  app.get('/api/audio/status/:id', requireAuth, async (req, res) => {
    const id = String(req.params.id || '');
    if (!UUID.test(id)) return res.status(404).json({ status: 'nao_encontrada' });
    const q = await banco('GET', '/rest/v1/transcricoes?id=eq.' + id + '&select=id,user_id,status,servico_id,caracteres,texto,apagada_em');
    const row = q.status === 200 && Array.isArray(q.body) ? q.body[0] : null;
    if (!row || row.user_id !== quem(req) || row.apagada_em) return res.status(404).json({ status: 'nao_encontrada' });
    let atual = row;
    if (row.status === 'processando' && row.servico_id) {
      const r = await servico('GET', '/v2/transcript/' + encodeURIComponent(row.servico_id));
      const j = r.json || {};
      if (j.status === 'completed') {
        const texto = String(j.text || '');
        const up = await banco('PATCH', '/rest/v1/transcricoes?id=eq.' + id, { status: 'pronta', texto, caracteres: texto.length, duracao_seg: j.audio_duration || null });
        atual = Object.assign({}, row, { status: up.status < 300 ? 'pronta' : 'processando', texto, caracteres: texto.length });
      } else if (j.status === 'error') {
        console.error('[audio] transcrição com erro no serviço');
        await banco('PATCH', '/rest/v1/transcricoes?id=eq.' + id, { status: 'erro' });
        atual = Object.assign({}, row, { status: 'erro' });
      }
    }
    const resp = { status: atual.status, caracteres: atual.caracteres || 0 };
    if (atual.status === 'pronta' && await livre(req)) resp.texto = atual.texto || '';
    if (atual.status === 'erro') resp.detalhe = 'A transcrição falhou. Tente enviar o áudio de novo.';
    res.set('Cache-Control', 'no-store').json(resp);
  });

  // Transcrição em texto (arquivo .txt, ou texto colado ou corrigido por quem tem transcrição livre).
  app.post('/api/transcricoes/texto', requireAuth, exigirAtas, limite('transcricao_texto', 60), express.json({ limit: '5mb' }), async (req, res) => {
    const b = req.body || {};
    const texto = typeof b.texto === 'string' ? b.texto.trim() : '';
    if (texto.length < 50) return res.status(400).json({ erro: 'texto_curto', detalhe: 'A transcrição está vazia ou curta demais.' });
    const ehLivre = await livre(req);
    const origem = ['arquivo_txt', 'colada', 'editada'].includes(b.origem) ? b.origem : 'arquivo_txt';
    if (origem !== 'arquivo_txt' && !ehLivre) return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Envie a transcrição em arquivo .txt.' });
    const idSL = b.id_superlogica != null && b.id_superlogica !== '' ? String(b.id_superlogica) : '';
    let cond = null;
    if (idSL) {
      cond = /^[1-9][0-9]{0,8}$/.test(idSL) ? await condominioDaBase(idSL) : null;
      if (!cond) { auditar(req, 'transcricao_recusada', { id_superlogica: idSL, motivo: 'condominio_fora_da_base' }, true); return res.status(403).json({ erro: 'condominio_fora_da_base', detalhe: 'Esse condomínio não está na base do sistema.' }); }
    } else if (!ehLivre) {
      return res.status(400).json({ erro: 'condominio_obrigatorio', detalhe: 'Escolha o condomínio antes.' });
    }
    const ins = await banco('POST', '/rest/v1/transcricoes', {
      user_id: quem(req) || null, email: (req.user && req.user.email) || null, id_superlogica: cond ? Number(idSL) : null,
      condominio_nome: cond ? cond.nome : null, origem, arquivo_nome: String(b.nome || '').slice(0, 200) || null,
      status: 'pronta', texto, caracteres: texto.length });
    const row = ins.status === 201 && Array.isArray(ins.body) ? ins.body[0] : null;
    if (!row) return res.status(500).json({ erro: 'falha_registro', detalhe: 'Não foi possível registrar a transcrição.' });
    auditar(req, 'transcricao_texto', { transcricao_id: row.id, origem, id_superlogica: idSL || null }, false);
    res.json({ transcricao_id: row.id, caracteres: texto.length });
  });
}

async function perfilDono(req, d) {
  try { return d.temAcao(await d.perfilDe(req), 'configuracoes', 'auditoria_total'); } catch (e) { return false; }
}

// Lê uma transcrição pronta do próprio usuário (para gerar a ata).
async function lerTranscricaoDoUsuario(banco, id, userId) {
  if (!UUID.test(String(id || ''))) return null;
  const q = await banco('GET', '/rest/v1/transcricoes?id=eq.' + id + '&select=id,user_id,status,texto,id_superlogica,apagada_em');
  const row = q.status === 200 && Array.isArray(q.body) ? q.body[0] : null;
  if (!row || row.user_id !== userId || row.apagada_em || row.status !== 'pronta' || !row.texto) return null;
  return row;
}

module.exports = { criarRotasAudio, lerTranscricaoDoUsuario };
