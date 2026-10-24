// Conta do Superlógica de cada pessoa do Hub e o botão "Abrir no Superlógica".
//
// Para que serve: publicar a prestação de contas e o balancete SEM avisar os moradores exige,
// no Superlógica, que uma pessoa resolva a verificação "Não sou um robô". O Hub deixa o documento
// pronto lá e o botão leva a pessoa direto à tela de publicação. O Hub nunca resolve nem contorna
// essa verificação.
//
// Caminho usado hoje (investigação de 24/10/2026): C. O login fica em outro endereço
// (login.superlogica.net), que redireciona na hora quando já existe sessão e não pode ser lido
// enquanto a pessoa está conectada; o mesmo sistema traz o módulo de reCAPTCHA do Google V2 nos
// formulários; e a documentação pública só oferece login por token para a Área do condômino
// (morador), não para quem administra. Sem ver o formulário de login não dá para mandar email e
// senha por ele com segurança. Então o botão abre a tela certa e, se o Superlógica pedir login,
// a pessoa entra uma vez com a própria conta (o navegador guarda a sessão).
// O link do botão já é de uso único, vale 60 segundos e fica amarrado a quem pediu: se um dia o
// login direto for confirmado (caminho A), a troca fica só na página de passagem.
//
// Regras deste arquivo:
// - A senha fica CIFRADA no banco (AES 256 GCM, chave SUPERLOGICA_CRED_CHAVE do ambiente, com o
//   id da pessoa como dado autenticado: a senha de uma pessoa não abre com o id de outra).
// - Só a própria pessoa grava, troca ou apaga. Ninguém lê a senha, nem o gestor: a tela só
//   recebe "senha guardada". A senha nunca vai para resposta, log ou auditoria.
// Testes em scripts/teste-superlogica-conta.js.

const crypto = require('crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>"']{1,100}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const LINK_VALIDADE_MS = 60 * 1000;
const LINKS_MAX = 5000;
const MODO = 'C';
const TELA_BASE_PADRAO = 'https://condominioes.superlogica.net';

// Telas do Superlógica que o botão pode abrir (o navegador não escolhe endereço livre).
// documentos: Área do condômino > Documentos, onde a prestação (900A) e o balancete ficam
// prontos e cada linha tem o botão de publicar.
const DESTINOS = {
  documentos: { caminho: '/clients/condor/impressoes/index', nome: 'Documentos do condomínio' },
};

// ---------- senha cifrada ----------
// A chave vem do ambiente (pelo menos 32 caracteres; gerar com "openssl rand -base64 48").
function chaveDe(env) {
  const s = String((env || process.env).SUPERLOGICA_CRED_CHAVE || '');
  if (s.length < 32) return null;
  return crypto.createHash('sha256').update('hub-superlogica-conta:' + s).digest();
}
function cifrar(texto, idUsuario, env) {
  const k = chaveDe(env);
  if (!k) { const e = new Error('sem_chave'); e.code = 'sem_chave'; throw e; }
  if (!UUID.test(String(idUsuario || ''))) { const e = new Error('usuario_invalido'); e.code = 'usuario_invalido'; throw e; }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from('usuario:' + idUsuario, 'utf8'));
  const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return 'v1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + ct.toString('base64');
}
// Devolve a senha aberta ou null (chave errada, outro usuário ou valor estragado).
function decifrar(valor, idUsuario, env) {
  const k = chaveDe(env);
  const p = String(valor || '').split(':');
  if (!k || p.length !== 4 || p[0] !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(p[1], 'base64'));
    d.setAAD(Buffer.from('usuario:' + idUsuario, 'utf8'));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

// ---------- cadastro ----------
// Confere o que veio da tela. atual: a conta já gravada ou null.
// Devolve { ok: true, email, senha } (senha só quando foi digitada) ou { ok: false, detalhe }.
function validar(b, atual) {
  const x = b || {};
  const email = String(x.email == null ? (atual ? atual.email : '') : x.email).replace(/\s+/g, '').toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) return { ok: false, detalhe: 'Email inválido.' };
  let senha = null;
  if (typeof x.senha === 'string' && x.senha !== '') {
    if (x.senha.length > 200 || /[\r\n]/.test(x.senha)) return { ok: false, detalhe: 'Senha inválida.' };
    senha = x.senha;
  }
  if (!atual && !senha) return { ok: false, detalhe: 'Informe a senha do Superlógica.' };
  return { ok: true, email, senha };
}
// O que a tela vê: nunca a senha (nem cifrada).
function contaParaTela(c) {
  if (!c) return null;
  return { email: c.email || '', senha_guardada: !!c.senha_cifrada, atualizado_em: c.atualizado_em || null };
}

// ---------- destino ----------
// Endereço do Superlógica (só https em superlogica.net; o padrão é a licença da empresa).
function telaBase(env) {
  const v = String((env || process.env).SUPERLOGICA_TELA_BASE || TELA_BASE_PADRAO).trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9-]+\.superlogica\.net$/i.test(v) ? v : TELA_BASE_PADRAO;
}
function montarDestino(destino, env) {
  const k = String(destino || '');
  if (!Object.prototype.hasOwnProperty.call(DESTINOS, k)) return null;
  const d = DESTINOS[k];
  return { url: telaBase(env) + d.caminho, nome: d.nome };
}

// ---------- link de uso único ----------
// Guardado só na memória do servidor: vale 60 segundos, uma vez, para quem pediu.
function criarLinks(opcoes) {
  const agora = (opcoes && opcoes.agora) || (() => Date.now());
  const mapa = new Map();
  function limparVencidos() {
    const t = agora();
    for (const [k, v] of mapa) if (v.expira <= t) mapa.delete(k);
  }
  function emitir(idUsuario, url) {
    limparVencidos();
    if (mapa.size >= LINKS_MAX) mapa.delete(mapa.keys().next().value);
    const token = crypto.randomBytes(32).toString('base64url');
    mapa.set(token, { usuario: String(idUsuario), url, expira: agora() + LINK_VALIDADE_MS });
    return token;
  }
  // Qualquer tentativa gasta o link, inclusive a de outra pessoa (quem copiou não tenta de novo).
  function consumir(token, idUsuario) {
    const k = String(token || '');
    const v = k.length >= 40 && k.length <= 60 ? mapa.get(k) : undefined;
    if (!v) return { ok: false, motivo: 'nao_existe' };
    mapa.delete(k);
    if (v.expira <= agora()) return { ok: false, motivo: 'vencido' };
    if (v.usuario !== String(idUsuario || '')) return { ok: false, motivo: 'outro_usuario' };
    return { ok: true, url: v.url };
  }
  return { emitir, consumir, tamanho: () => mapa.size };
}

// ---------- páginas da aba nova ----------
function cabecalhosPassagem(res) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
}
// Página curta para quando o link não vale mais (texto fixo, sem dado de quem pediu).
function paginaAviso(texto) {
  const t = String(texto).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Abrir no Superlógica</title></head>'
    + '<body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f4f6f9;color:#1e2533;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">'
    + '<div style="background:#fff;border:1px solid #dde2ea;border-radius:12px;padding:24px 28px;max-width:420px;font-size:14px;line-height:1.5">' + t + '</div></body></html>';
}
const MOTIVO_TEXTO = {
  nao_existe: 'Este link já foi usado ou não existe. Volte ao Hub e clique de novo em Abrir no Superlógica.',
  vencido: 'Este link venceu (vale 60 segundos). Volte ao Hub e clique de novo em Abrir no Superlógica.',
  outro_usuario: 'Este link foi pedido por outra pessoa e não vale para você. Volte ao Hub e clique em Abrir no Superlógica.',
  sem_login: 'Sua sessão no Hub acabou. Entre no Hub de novo e clique em Abrir no Superlógica.',
};

// ---------- rotas ----------
// /api/conta-superlogica (GET, PUT, DELETE): a conta da própria pessoa, nunca de outra.
// /api/conta-superlogica/abrir (POST): devolve o link de uso único para a tela pedida.
// /api/conta-superlogica/ir (POST de formulário, na aba nova): gasta o link e leva ao Superlógica.
// d: { requireAuth, express, banco, auditoria, verificarUsuario(jwt) -> payload ou null, env?, links? }
function criarRotasContaSuperlogica(app, d) {
  const { requireAuth, express, banco, auditoria } = d;
  const env = () => d.env || process.env;
  const links = d.links || criarLinks();
  const json = express.json({ limit: '4kb' });
  const formulario = express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 5 });
  const tabela = '/rest/v1/superlogica_contas';

  // Só gente logada de verdade (a chave interna dos scripts não tem conta própria).
  function dono(req, res) {
    const id = req.authMode === 'supabase' && req.user ? String(req.user.sub || '') : '';
    if (!UUID.test(id)) { res.status(403).json({ erro: 'so_a_propria_pessoa', detalhe: 'Só a própria pessoa, logada no Hub, mexe na conta do Superlógica dela.' }); return null; }
    return id;
  }
  function falha(res, onde, e) {
    console.warn('[conta-superlogica ' + onde + '] ' + String((e && (e.code || e.message)) || 'erro').slice(0, 80));
    if (!res.headersSent) res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível concluir agora. Tente de novo em instantes.' });
  }
  async function ler(id) {
    const r = await banco('GET', tabela + '?select=user_id,email,senha_cifrada,atualizado_em&user_id=eq.' + id + '&limit=1');
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('banco_' + r.status);
    return r.body[0] || null;
  }

  app.get('/api/conta-superlogica', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = dono(req, res); if (!id) return;
    try { res.json({ conta: contaParaTela(await ler(id)), chave_configurada: !!chaveDe(env()), modo: MODO }); } catch (e) { falha(res, 'ler', e); }
  });

  // Grava ou troca. A senha só muda quando vem preenchida; o id é sempre o de quem está logado.
  app.put('/api/conta-superlogica', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = dono(req, res); if (!id) return;
    let atual;
    try { atual = await ler(id); } catch (e) { return falha(res, 'ler', e); }
    const v = validar(req.body, atual);
    if (!v.ok) return res.status(400).json({ erro: 'campo_invalido', detalhe: v.detalhe });
    const linha = { email: v.email, atualizado_em: new Date().toISOString() };
    if (v.senha) {
      try { linha.senha_cifrada = cifrar(v.senha, id, env()); } catch (e) {
        return res.status(503).json({ erro: 'sem_chave', detalhe: 'A chave de cifra (SUPERLOGICA_CRED_CHAVE) não está configurada no servidor. Nada foi salvo.' });
      }
    }
    try {
      const r = atual
        ? await banco('PATCH', tabela + '?user_id=eq.' + id + '&select=user_id,email,senha_cifrada,atualizado_em', linha)
        : await banco('POST', tabela + '?select=user_id,email,senha_cifrada,atualizado_em', Object.assign({ user_id: id }, linha));
      if (!(r.status === 200 || r.status === 201) || !Array.isArray(r.body) || !r.body[0]) throw new Error('banco_' + r.status);
      auditoria.evento(req, atual ? 'superlogica_conta_trocada' : 'superlogica_conta_gravada', { senha_trocada: !!v.senha, email_trocado: !atual || atual.email !== v.email });
      res.json({ conta: contaParaTela(r.body[0]) });
    } catch (e) { falha(res, 'salvar', e); }
  });

  app.delete('/api/conta-superlogica', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = dono(req, res); if (!id) return;
    try {
      const r = await banco('DELETE', tabela + '?user_id=eq.' + id);
      if (!(r.status === 200 || r.status === 204)) throw new Error('banco_' + r.status);
      auditoria.evento(req, 'superlogica_conta_apagada', { tinha_conta: Array.isArray(r.body) ? r.body.length > 0 : null });
      res.json({ ok: true });
    } catch (e) { falha(res, 'apagar', e); }
  });

  // Pede o link de uso único. Só a tela da lista DESTINOS; o condomínio vai para a dica da tela.
  app.post('/api/conta-superlogica/abrir', requireAuth, json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = dono(req, res); if (!id) return;
    const b = req.body || {};
    const alvo = montarDestino(b.destino, env());
    if (!alvo) return res.status(400).json({ erro: 'destino_invalido', detalhe: 'Tela do Superlógica desconhecida.' });
    if (b.id_superlogica != null && b.id_superlogica !== '' && !/^[1-9]\d{0,8}$/.test(String(b.id_superlogica))) return res.status(400).json({ erro: 'condominio_invalido', detalhe: 'Condomínio inválido.' });
    let conta = null;
    try { conta = await ler(id); } catch (e) { /* sem a conta a dica sai sem o email */ }
    const token = links.emitir(id, alvo.url);
    auditoria.evento(req, 'superlogica_abrir', { destino: String(b.destino), id_superlogica: b.id_superlogica ? Number(b.id_superlogica) : null, modo: MODO });
    res.json({ token, validade_segundos: LINK_VALIDADE_MS / 1000, modo: MODO, tela: alvo.nome, email: conta ? conta.email : null, conta_guardada: !!(conta && conta.senha_cifrada) });
  });

  // A aba nova chega aqui por formulário (token e sessão do Hub no corpo, nunca na URL).
  app.post('/api/conta-superlogica/ir', formulario, async (req, res) => {
    cabecalhosPassagem(res);
    const b = req.body || {};
    let payload = null;
    try { payload = await d.verificarUsuario(String(b.acesso || '')); } catch (e) { payload = null; }
    if (!payload || !UUID.test(String(payload.sub || ''))) return res.status(401).type('html').send(paginaAviso(MOTIVO_TEXTO.sem_login));
    req.user = payload; req.authMode = 'supabase';
    const r = links.consumir(b.token, payload.sub);
    if (!r.ok) {
      auditoria.evento(req, 'superlogica_link_recusado', { motivo: r.motivo }, r.motivo === 'outro_usuario', r.motivo === 'outro_usuario' ? 'link_de_outra_pessoa' : null);
      return res.status(r.motivo === 'outro_usuario' ? 403 : 410).type('html').send(paginaAviso(MOTIVO_TEXTO[r.motivo] || MOTIVO_TEXTO.nao_existe));
    }
    // Caminho C: leva direto à tela. A senha não é aberta aqui.
    res.redirect(303, r.url);
  });

  return { links };
}

module.exports = {
  chaveDe, cifrar, decifrar, validar, contaParaTela, telaBase, montarDestino, criarLinks, paginaAviso,
  criarRotasContaSuperlogica, DESTINOS, MODO, LINK_VALIDADE_MS,
};
