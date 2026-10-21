// T16: rotas da aba Segurança e dos controles de usuário (trocar senha, bloquear).
// Tudo registrado na auditoria. Senha NUNCA é guardada nem mostrada: o dono define
// uma nova quando precisar.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function criarRotasSeguranca(app, d) {
  const { requireAuth, express, banco, perfilDe, temAcao, auditoria, lerPerfil, esquecerPerfil, esquecerBloqueios, usoRecente } = d;

  async function exigirNivel(req, res) {
    const n = await auditoria.nivel(req);
    if (!n) { res.status(403).json({ erro: 'acesso_negado' }); return null; }
    return n;
  }
  // T21: mesma regra das permissões (servico/permissoes.js): dono em todos menos nele mesmo;
  // os outros só em quem eles podem editar (nunca GESTOR, dono, protegidos ou eles mesmos).
  const regras = require('./permissoes');
  // Revisão 2: trocar senha e bloquear ficam só com o dono (um gerente que troca a senha
  // de um operacional entraria como ele e usaria o que o dono deu a essa pessoa).
  async function podeControlar(req, alvo) {
    if (req.authMode === 'internal') return true;
    const p = await lerPerfil(req.user && req.user.sub);
    if (!regras.ehDono(p)) return false;
    return regras.podeEditarAlvo(p, alvo, false).ok;
  }

  // Login registrado (o navegador avisa uma vez por sessão aberta).
  app.post('/api/sessao/entrou', requireAuth, (req, res) => {
    auditoria.evento(req, 'entrou_no_sistema', null, auditoria.foraDoHorario(), auditoria.foraDoHorario() ? 'fora_do_horario' : null);
    res.json({ ok: true });
  });

  // Registro, com filtros simples.
  app.get('/api/seguranca/registro', requireAuth, async (req, res) => {
    const n = await exigirNivel(req, res); if (!n) return;
    const filtro = await auditoria.filtroVisivel(req, n);
    if (filtro === null) return res.status(500).json({ erro: 'falha_leitura' });
    let q = '/rest/v1/auditoria?select=id,criado_em,email,papel,acao,rota,metodo,status,id_superlogica,ip,detalhe,suspeito,motivo&order=criado_em.desc&limit=' + Math.max(1, Math.min(500, parseInt(req.query.limite, 10) || 200));
    if (req.query.pessoa && /^[^,()&]{1,120}$/.test(req.query.pessoa)) q += '&email=ilike.*' + encodeURIComponent(req.query.pessoa) + '*';
    if (req.query.suspeito === '1') q += '&suspeito=eq.true';
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.de || '')) q += '&criado_em=gte.' + req.query.de + 'T00:00:00-03:00';
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.ate || '')) q += '&criado_em=lte.' + req.query.ate + 'T23:59:59-03:00';
    if (/^\d{1,9}$/.test(req.query.cond || '')) q += '&id_superlogica=eq.' + req.query.cond;
    const r = await banco('GET', q + filtro);
    if (r.status !== 200) return res.status(500).json({ erro: 'falha_leitura' });
    res.set('Cache-Control', 'no-store').json({ itens: r.body });
  });

  // Transcrições (lista sem o texto).
  app.get('/api/seguranca/transcricoes', requireAuth, async (req, res) => {
    const n = await exigirNivel(req, res); if (!n) return;
    const filtro = await auditoria.filtroVisivel(req, n);
    if (filtro === null) return res.status(500).json({ erro: 'falha_leitura' });
    const r = await banco('GET', '/rest/v1/transcricoes?select=id,criado_em,email,id_superlogica,condominio_nome,origem,arquivo_nome,status,caracteres,duracao_seg,usada_em_ata,apagada_em&order=criado_em.desc&limit=300' + filtro);
    if (r.status !== 200) return res.status(500).json({ erro: 'falha_leitura' });
    res.set('Cache-Control', 'no-store').json({ itens: r.body });
  });

  async function transcricaoVisivel(req, n, id) {
    if (!UUID.test(String(id || ''))) return null;
    const filtro = await auditoria.filtroVisivel(req, n);
    if (filtro === null) return null;
    const r = await banco('GET', '/rest/v1/transcricoes?id=eq.' + id + '&select=id,email,user_id,condominio_nome,criado_em,texto,apagada_em' + filtro);
    return r.status === 200 && Array.isArray(r.body) ? r.body[0] || null : null;
  }

  app.get('/api/seguranca/transcricoes/:id', requireAuth, async (req, res) => {
    const n = await exigirNivel(req, res); if (!n) return;
    const t = await transcricaoVisivel(req, n, req.params.id);
    if (!t) return res.status(404).json({ erro: 'nao_encontrada' });
    // Revisão 2: o texto só para o dono ou para quem tem transcrição livre.
    if (n !== 'dono' && !temAcao(await perfilDe(req), 'atas', 'transcricao_livre')) {
      auditoria.evento(req, 'transcricao_texto_negado', { transcricao_id: t.id, de: t.email }, true, 'acesso_negado');
      return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não pode ler o texto das transcrições.' });
    }
    auditoria.evento(req, 'transcricao_lida_na_seguranca', { transcricao_id: t.id, de: t.email });
    res.set('Cache-Control', 'no-store').json({ id: t.id, email: t.email, condominio: t.condominio_nome, criado_em: t.criado_em, apagada: !!t.apagada_em, texto: t.apagada_em ? '' : (t.texto || '') });
  });

  // Apagar o texto (o registro de que existiu fica).
  app.delete('/api/seguranca/transcricoes/:id', requireAuth, async (req, res) => {
    const n = await exigirNivel(req, res); if (!n) return;
    if (n !== 'dono') return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Só o administrador principal apaga transcrições.' });
    const t = await transcricaoVisivel(req, n, req.params.id);
    if (!t) return res.status(404).json({ erro: 'nao_encontrada' });
    const r = await banco('PATCH', '/rest/v1/transcricoes?id=eq.' + t.id, { texto: null, apagada_em: new Date().toISOString(), apagada_por: (req.user && req.user.sub) || null });
    if (r.status >= 300) return res.status(500).json({ erro: 'falha_gravacao' });
    auditoria.evento(req, 'transcricao_apagada', { transcricao_id: t.id, de: t.email });
    res.json({ ok: true });
  });

  // Alertas de uso indevido (calculados na hora a partir do registro e das transcrições).
  app.get('/api/seguranca/alertas', requireAuth, async (req, res) => {
    const n = await exigirNivel(req, res); if (!n) return;
    const filtro = await auditoria.filtroVisivel(req, n);
    if (filtro === null) return res.status(500).json({ erro: 'falha_leitura' });
    const desde = new Date(Date.now() - 30 * 86400000).toISOString();
    const [sus, tr] = await Promise.all([
      banco('GET', '/rest/v1/auditoria?select=id,criado_em,email,acao,id_superlogica,detalhe,motivo&suspeito=eq.true&criado_em=gte.' + desde + '&order=criado_em.desc&limit=500' + filtro),
      banco('GET', '/rest/v1/transcricoes?select=id,criado_em,email,id_superlogica,condominio_nome,origem,usada_em_ata,caracteres&criado_em=gte.' + desde + '&apagada_em=is.null&order=criado_em.desc&limit=500' + filtro),
    ]);
    if (sus.status !== 200 || tr.status !== 200) return res.status(500).json({ erro: 'falha_leitura' });
    const alertas = [];
    const NOMES = {
      acesso_negado: 'Tentou abrir algo sem permissão', fora_do_horario: 'Uso fora do horário (antes das 7h, depois das 21h ou domingo)',
      condominio_fora_da_base: 'Tentou usar condomínio que não está na base', relatorio_de_outro_condominio: 'Anexou relatório de outro condomínio na prestação',
      tentou_liberar_acesso_restrito: 'Tentou dar ou tirar um acesso restrito', volume_alto: 'Volume de processamento acima do normal',
      acesso_liberado: 'Liberou ou tirou acesso de outra pessoa', liberou_transcricao_livre: 'Liberou a transcrição livre para outra pessoa',
      caminho_antigo_fechado: 'Tentou gerar prestação pelo caminho desativado', transcricao_de_outro_condominio: 'Tentou usar transcrição de outro condomínio',
      usuario_bloqueado: 'Usuário bloqueado tentou entrar', fora_da_carteira: 'Tentou abrir condomínio fora da carteira', modulo_sem_acesso: 'Tentou abrir módulo sem acesso', removeu_usuario: 'Removeu um usuário', convidou_usuario: 'Convidou um usuário',
    };
    const resumo = (s) => {
      const d = s.detalhe || {};
      if (!d.email_alvo) return '';
      const fmt = (l) => (Array.isArray(l) ? l : []).map((x) => String(x).replace('.ver', ' (ver)').replace(/_/g, ' ')).join(', ');
      return 'para ' + d.email_alvo + (d.adicionadas && d.adicionadas.length ? '; deu: ' + fmt(d.adicionadas) : '') + (d.removidas && d.removidas.length ? '; tirou: ' + fmt(d.removidas) : '');
    };
    const grupos = new Map();
    for (const s of sus.body) {
      const k = (s.email || '?') + '|' + (s.motivo || s.acao);
      const g = grupos.get(k) || { tipo: s.motivo || s.acao, titulo: NOMES[s.motivo] || s.acao, email: s.email, vezes: 0, ultima: s.criado_em, exemplos: [] };
      g.vezes++; if (g.exemplos.length < 5) g.exemplos.push({ em: s.criado_em, acao: s.acao, id_superlogica: s.id_superlogica, resumo: resumo(s).slice(0, 300) });
      grupos.set(k, g);
    }
    grupos.forEach((g) => alertas.push(g));
    const agora = Date.now();
    for (const t of tr.body) {
      if (!t.id_superlogica) alertas.push({ tipo: 'transcricao_sem_condominio', titulo: 'Transcrição sem condomínio da base', email: t.email, vezes: 1, ultima: t.criado_em, transcricao_id: t.id });
      else if (!t.usada_em_ata && agora - new Date(t.criado_em).getTime() > 48 * 3600000) alertas.push({ tipo: 'transcricao_sem_ata', titulo: 'Transcrição feita e nenhuma ata gerada em 48h', email: t.email, vezes: 1, ultima: t.criado_em, transcricao_id: t.id, condominio: t.condominio_nome });
    }
    alertas.sort((a, b) => String(b.ultima).localeCompare(String(a.ultima)));
    res.set('Cache-Control', 'no-store').json({ alertas });
  });

  // Uso de processamento por pessoa (desde que o servidor ligou).
  app.get('/api/seguranca/uso', requireAuth, async (req, res) => {
    const n = await exigirNivel(req, res); if (!n) return;
    const porPessoa = {};
    let esconder = new Set();
    if (n !== 'dono') {
      const r = await banco('GET', '/rest/v1/profiles?select=id,permissoes');
      (r.status === 200 && Array.isArray(r.body) ? r.body : []).forEach((x) => {
        const a = (x.permissoes && x.permissoes.configuracoes && x.permissoes.configuracoes.acoes) || [];
        if ((a.includes('ver_auditoria') || a.includes('auditoria_total')) && x.id !== (req.user && req.user.sub)) esconder.add(x.id);
      });
    }
    usoRecente().filter((u) => !esconder.has(u.usuario)).forEach((u) => {
      const k = u.usuario || '?';
      const g = porPessoa[k] || (porPessoa[k] = { chamadas: 0, entrada: 0, saida: 0, cache_lido: 0 });
      g.chamadas++; g.entrada += u.entrada; g.saida += u.saida; g.cache_lido += u.cache_lido;
    });
    res.json({ porPessoa });
  });

  // Trocar a senha de alguém (sem precisar da antiga).
  app.post('/api/admin/usuarios/:id/senha', requireAuth, express.json(), async (req, res) => {
    const id = String(req.params.id || '').toLowerCase();
    if (!UUID.test(id)) return res.status(400).json({ erro: 'id_invalido' });
    const senha = String((req.body && req.body.senha) || '');
    if (senha.length < 8 || senha.length > 72) return res.status(400).json({ erro: 'senha_invalida', detalhe: 'A senha precisa ter de 8 a 72 caracteres.' });
    const alvo = await lerPerfil(id);
    if (!alvo) return res.status(404).json({ erro: 'usuario_nao_encontrado' });
    if (!(await podeControlar(req, alvo))) { auditoria.evento(req, 'troca_senha_negada', { alvo: id }, true, 'tentou_liberar_acesso_restrito'); return res.status(403).json({ erro: 'acesso_negado' }); }
    const r = await banco('PUT', '/auth/v1/admin/users/' + id, { password: senha });
    if (r.status >= 300) return res.status(500).json({ erro: 'falha_gravacao', detalhe: 'Não foi possível trocar a senha.' });
    auditoria.evento(req, 'senha_trocada_pelo_admin', { alvo: id, email_alvo: alvo.email });
    res.json({ ok: true });
  });

  // Bloquear ou desbloquear (cai na hora e não entra mais).
  app.post('/api/admin/usuarios/:id/bloqueio', requireAuth, express.json(), async (req, res) => {
    const id = String(req.params.id || '').toLowerCase();
    if (!UUID.test(id)) return res.status(400).json({ erro: 'id_invalido' });
    if (req.user && req.user.sub === id) return res.status(400).json({ erro: 'auto_alteracao_proibida' });
    const bloquear = !!(req.body && req.body.bloquear);
    const alvo = await lerPerfil(id);
    if (!alvo) return res.status(404).json({ erro: 'usuario_nao_encontrado' });
    if (!(await podeControlar(req, alvo))) { auditoria.evento(req, 'bloqueio_negado', { alvo: id }, true, 'tentou_liberar_acesso_restrito'); return res.status(403).json({ erro: 'acesso_negado' }); }
    const p1 = await banco('PATCH', '/rest/v1/profiles?id=eq.' + id, { bloqueado: bloquear });
    if (p1.status >= 300) return res.status(500).json({ erro: 'falha_gravacao', detalhe: 'Não foi possível gravar o bloqueio.' });
    const p2 = await banco('PUT', '/auth/v1/admin/users/' + id, { ban_duration: bloquear ? '876000h' : 'none' });
    if (p2.status >= 300) console.error('[seguranca] ban no login falhou ' + p2.status);
    esquecerBloqueios(); esquecerPerfil(id);
    auditoria.evento(req, bloquear ? 'usuario_bloqueado' : 'usuario_desbloqueado', { alvo: id, email_alvo: alvo.email });
    res.json({ ok: true, bloqueado: bloquear });
  });
}

module.exports = { criarRotasSeguranca };
