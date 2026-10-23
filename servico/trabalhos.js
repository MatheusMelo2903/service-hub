// ─────────────────────────────────────────────────────────────────────────
// T49: trabalhos em andamento (pastinha "Em andamento").
// Ata gerada, prestação gerada e outros trabalhos longos ficam guardados por pessoa no banco
// do Hub até a pessoa clicar em Encerrar, ou por 7 dias sem mexer. Fechar a janela, trocar de
// aba, recarregar ou entrar por outro computador não perde o trabalho.
// Arquivos grandes (PDF e PowerPoint da prestação) vão para o bucket privado "trabalhos".
// Cada pessoa só lê, grava e apaga os próprios trabalhos (filtro por user_id no servidor;
// tabela sem acesso direto do navegador). Condomínio fora da carteira é recusado ao salvar.
// ─────────────────────────────────────────────────────────────────────────

const TIPOS = new Set(['ata', 'prestacao', 'previsao', 'unidades', 'apresentacao']);
const MAX_POR_PESSOA = 20;
const MAX_DADOS = 3 * 1024 * 1024; // texto da ata, transcrição, campos e prévia
const MAX_ARQUIVO = 40 * 1024 * 1024;
const MAX_ARQUIVOS = 20; // PDF e PowerPoint da prestação mais os outros documentos que vão junto (T50)
const DIAS = 7;
const BUCKET = 'trabalhos';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOME_ARQ = /^[A-Za-z0-9 _.()À-ÿ]{1,120}\.(pdf|pptx|docx|xlsx)$/;
const MIME = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function expiraEm() { return new Date(Date.now() + DIAS * 86400000).toISOString(); }
function caminhoArq(userId, id, nome) { return userId + '/' + id + '/' + encodeURIComponent(nome); }

function criarRotasTrabalhos(app, deps) {
  const { requireAuth, express, banco, exigirCarteira, storageUpload, storageSignedUrl, storageDelete } = deps;
  const dono = (req) => { const u = (req.user && req.user.sub) || ''; return UUID.test(u) ? u : ''; };

  async function lerDoDono(req, id, campos) {
    const r = await banco('GET', '/rest/v1/trabalhos_salvos?id=eq.' + id + '&user_id=eq.' + dono(req)
      + '&expira_em=gt.' + encodeURIComponent(new Date().toISOString()) + '&select=' + campos + '&limit=1');
    if (r.status >= 400) throw new Error('banco_' + r.status);
    return (r.body && r.body[0]) || null;
  }

  async function apagar(userId, linha) {
    for (const a of (linha.arquivos || [])) {
      try { await storageDelete(BUCKET, caminhoArq(userId, linha.id, a.nome)); } catch (e) { console.warn('[trabalhos] arquivo não apagado: ' + e.message); }
    }
    await banco('DELETE', '/rest/v1/trabalhos_salvos?id=eq.' + linha.id + '&user_id=eq.' + userId);
  }

  // Lista os trabalhos da pessoa (sem os dados pesados).
  app.get('/api/trabalhos', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.authMode === 'internal' || !dono(req)) return res.json({ itens: [] });
    const r = await banco('GET', '/rest/v1/trabalhos_salvos?user_id=eq.' + dono(req)
      + '&expira_em=gt.' + encodeURIComponent(new Date().toISOString())
      + '&select=id,tipo,id_superlogica,titulo,arquivos,atualizado_em,expira_em&order=atualizado_em.desc&limit=' + MAX_POR_PESSOA);
    if (r.status >= 400) return res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível ler os trabalhos em andamento agora.' });
    res.json({ itens: (r.body || []).map((t) => ({ ...t, arquivos: (t.arquivos || []).map((a) => a.nome) })) });
  });

  // Um trabalho completo, com link temporário dos arquivos.
  app.get('/api/trabalhos/:id', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!UUID.test(req.params.id) || !dono(req)) return res.status(400).json({ erro: 'id_invalido' });
    try {
      const t = await lerDoDono(req, req.params.id, 'id,tipo,id_superlogica,titulo,dados,arquivos,atualizado_em,expira_em');
      if (!t) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Esse trabalho já foi encerrado ou expirou.' });
      const arquivos = [];
      for (const a of (t.arquivos || [])) {
        try { arquivos.push({ nome: a.nome, url: await storageSignedUrl(BUCKET, caminhoArq(dono(req), t.id, a.nome), 600) }); } catch (e) { arquivos.push({ nome: a.nome, url: null }); }
      }
      res.json({ ...t, arquivos });
    } catch (e) {
      res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível abrir o trabalho agora.' });
    }
  });

  // Cria ou atualiza. Corpo: { id?, tipo, id_superlogica, titulo, dados }.
  app.put('/api/trabalhos', requireAuth, express.json({ limit: '4mb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.authMode === 'internal' || !dono(req)) return res.status(403).json({ erro: 'sem_usuario' });
    const b = req.body || {};
    const tipo = String(b.tipo || '');
    if (!TIPOS.has(tipo)) return res.status(400).json({ erro: 'tipo_invalido' });
    const idSL = b.id_superlogica == null || b.id_superlogica === '' ? null : String(b.id_superlogica);
    if (idSL !== null && !/^[1-9][0-9]{0,8}$/.test(idSL)) return res.status(400).json({ erro: 'id_invalido' });
    if (idSL !== null && !(await exigirCarteira(req, res, idSL))) return;
    const titulo = String(b.titulo || '').replace(/[<>]/g, '').trim().slice(0, 160);
    if (titulo.length < 3) return res.status(400).json({ erro: 'titulo_invalido' });
    if (!b.dados || typeof b.dados !== 'object') return res.status(400).json({ erro: 'dados_invalidos' });
    if (Buffer.byteLength(JSON.stringify(b.dados)) > MAX_DADOS) return res.status(413).json({ erro: 'grande_demais', detalhe: 'O trabalho passa do limite para guardar.' });
    const linha = { tipo, id_superlogica: idSL === null ? null : Number(idSL), titulo, dados: b.dados, atualizado_em: new Date().toISOString(), expira_em: expiraEm() };
    try {
      if (b.id) {
        if (!UUID.test(String(b.id))) return res.status(400).json({ erro: 'id_invalido' });
        const r = await banco('PATCH', '/rest/v1/trabalhos_salvos?id=eq.' + b.id + '&user_id=eq.' + dono(req), linha);
        if (r.status < 400 && r.body && r.body[0]) return res.json({ id: r.body[0].id });
        // Sumiu (encerrado em outra aba ou expirou): cria de novo.
      }
      const cont = await banco('GET', '/rest/v1/trabalhos_salvos?user_id=eq.' + dono(req) + '&select=id,arquivos,expira_em&order=atualizado_em.asc');
      const lista = (cont.body || []);
      // Passou do teto: apaga os mais antigos (nunca o que está sendo salvo).
      for (let i = 0; lista.length - i >= MAX_POR_PESSOA; i++) await apagar(dono(req), lista[i]);
      const r = await banco('POST', '/rest/v1/trabalhos_salvos', { ...linha, user_id: dono(req) });
      if (r.status >= 400 || !r.body || !r.body[0]) throw new Error('banco_' + r.status);
      res.json({ id: r.body[0].id });
    } catch (e) {
      console.warn('[trabalhos] salvar falhou: ' + e.message);
      res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível guardar o trabalho agora.' });
    }
  });

  // Anexa um arquivo gerado (PDF, PowerPoint) ao trabalho. Corpo cru, nome na query.
  app.post('/api/trabalhos/:id/arquivo', requireAuth, express.raw({ type: '*/*', limit: MAX_ARQUIVO }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!UUID.test(req.params.id) || !dono(req)) return res.status(400).json({ erro: 'id_invalido' });
    const nome = String(req.query.nome || '');
    if (!NOME_ARQ.test(nome)) return res.status(400).json({ erro: 'nome_invalido' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ erro: 'arquivo_vazio' });
    const ext = nome.split('.').pop().toLowerCase();
    // Confere a assinatura: PDF começa com %PDF; pptx, docx e xlsx são zip (PK).
    const ok = ext === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf[0] === 0x50 && buf[1] === 0x4b;
    if (!ok) return res.status(415).json({ erro: 'formato_invalido' });
    try {
      const t = await lerDoDono(req, req.params.id, 'id,arquivos');
      if (!t) return res.status(404).json({ erro: 'nao_encontrado' });
      const arquivos = (t.arquivos || []).filter((a) => a.nome !== nome);
      if (arquivos.length >= MAX_ARQUIVOS) return res.status(413).json({ erro: 'arquivos_demais' });
      await storageUpload(BUCKET, caminhoArq(dono(req), t.id, nome), buf, MIME[ext]);
      arquivos.push({ nome, bytes: buf.length });
      await banco('PATCH', '/rest/v1/trabalhos_salvos?id=eq.' + t.id + '&user_id=eq.' + dono(req), { arquivos, atualizado_em: new Date().toISOString(), expira_em: expiraEm() });
      res.json({ ok: true });
    } catch (e) {
      console.warn('[trabalhos] arquivo falhou: ' + e.message);
      res.status(503).json({ erro: 'storage', detalhe: 'Não foi possível guardar o arquivo agora.' });
    }
  });

  // Encerrar: apaga o trabalho e os arquivos.
  app.delete('/api/trabalhos/:id', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!UUID.test(req.params.id) || !dono(req)) return res.status(400).json({ erro: 'id_invalido' });
    try {
      const t = await lerDoDono(req, req.params.id, 'id,arquivos');
      if (t) await apagar(dono(req), t);
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível encerrar agora.' });
    }
  });

  // Limpeza dos expirados: ao ligar e a cada 6 horas.
  async function limparExpirados() {
    try {
      const r = await banco('GET', '/rest/v1/trabalhos_salvos?expira_em=lt.' + encodeURIComponent(new Date().toISOString()) + '&select=id,user_id,arquivos&limit=200');
      for (const t of (r.body || [])) await apagar(t.user_id, t);
      if ((r.body || []).length) console.log('[trabalhos] expirados apagados: ' + r.body.length);
    } catch (e) { console.warn('[trabalhos] limpeza falhou: ' + e.message); }
  }
  setTimeout(limparExpirados, 60 * 1000).unref();
  setInterval(limparExpirados, 6 * 3600 * 1000).unref();
  return { limparExpirados };
}

module.exports = { criarRotasTrabalhos, TIPOS, MAX_POR_PESSOA, DIAS };
