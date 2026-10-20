/**
 * auth-bootstrap.js — Login gate para o Hub principal.
 *
 * Bloqueia acesso ao index.html até o usuário fazer login via Supabase Auth.
 * Após login:
 *   - window.__SUPABASE__   = client Supabase autenticado (singleton)
 *   - window.AUTH_TOKEN     = access_token JWT (usar como Bearer em /api/*)
 *   - window.AUTH_USER      = { id, email, user_metadata }
 *   - window.AUTH_LEVEL     = 'total' ou 'restrito' (lido de user_metadata.access_level)
 *
 * Dispara evento "auth:ready" quando sessão é confirmada (logado ou anônimo
 * decidido). Outros scripts podem aguardar:
 *
 *   document.addEventListener('auth:ready', () => initApp());
 *
 * Carrega config via GET /api/config (SUPABASE_URL + SUPABASE_ANON_KEY).
 * Requer <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 * carregado antes deste arquivo.
 */
(function () {
  'use strict';

  if (!window.supabase || !window.supabase.createClient) {
    console.error('[auth] @supabase/supabase-js v2 não carregado antes de auth-bootstrap.js');
    return;
  }

  // ── 1. Injetar gate HTML + CSS ──────────────────────────────────────────
  const GATE_HTML = `
    <div id="auth-gate" style="position:fixed;inset:0;z-index:99999;background:#F4F6F9;display:flex;align-items:center;justify-content:center;font-family:'Plus Jakarta Sans',-apple-system,sans-serif;">
      <div style="background:#fff;border:1px solid rgba(58,58,58,0.08);border-radius:16px;padding:36px 32px;width:100%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.06);">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="font-size:22px;font-weight:800;color:#1E2533;letter-spacing:-0.01em;">Service Hub</div>
          <div style="font-size:13px;color:#8892A4;margin-top:4px;">Acesso restrito</div>
        </div>
        <form id="auth-form" style="display:flex;flex-direction:column;gap:12px;">
          <input id="auth-email" type="email" placeholder="email" required autocomplete="username"
            style="padding:11px 14px;border:1px solid rgba(58,58,58,0.14);border-radius:10px;font-size:14px;font-family:inherit;outline:none;">
          <input id="auth-password" type="password" placeholder="senha" required autocomplete="current-password"
            style="padding:11px 14px;border:1px solid rgba(58,58,58,0.14);border-radius:10px;font-size:14px;font-family:inherit;outline:none;">
          <button id="auth-submit" type="submit"
            style="padding:11px;background:#3B9AC7;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;margin-top:4px;">
            Entrar
          </button>
          <div id="auth-error" style="font-size:12px;color:#E03A3A;text-align:center;min-height:16px;"></div>
          <button id="auth-esqueci" type="button"
            style="background:none !important;border:none;color:#3B9AC7;font-size:12px;cursor:pointer;font-family:inherit;padding:0;">
            Esqueci minha senha
          </button>
        </form>
      </div>
    </div>
    <style>
      #auth-gate input:focus { border-color: #3B9AC7; }
      #auth-gate button:hover { background: #2D7FA8; }
      #auth-gate button:disabled { opacity: .5; cursor: not-allowed; }
      body.auth-pending > *:not(#auth-gate):not(#auth-senha) { display: none !important; }
    </style>
  `;

  function showGate() {
    if (document.getElementById('auth-gate')) return;
    document.body.insertAdjacentHTML('afterbegin', GATE_HTML);
    document.body.classList.add('auth-pending');
    const form = document.getElementById('auth-form');
    const errEl = document.getElementById('auth-error');
    const btn = document.getElementById('auth-submit');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      btn.disabled = true; btn.textContent = 'Entrando...';
      const email = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('auth-password').value;
      const { data, error } = await window.__SUPABASE__.auth.signInWithPassword({ email, password });
      if (error) {
        errEl.textContent = error.message === 'Invalid login credentials'
          ? 'Email ou senha incorretos.'
          : (error.message || 'Falha no login.');
        btn.disabled = false; btn.textContent = 'Entrar';
        return;
      }
      hideGate(data.session, data.user);
    });
    document.getElementById('auth-esqueci').addEventListener('click', async () => {
      const email = document.getElementById('auth-email').value.trim();
      errEl.style.color = '#E03A3A';
      if (!email) { errEl.textContent = 'Digite seu email acima e clique de novo em Esqueci minha senha.'; return; }
      const { error } = await window.__SUPABASE__.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/hub' });
      if (error) { errEl.textContent = error.message || 'Falha ao enviar o email.'; return; }
      errEl.style.color = '#2E9E6A';
      errEl.textContent = 'Se esse email estiver cadastrado, chega um link para criar uma nova senha.';
    });
  }

  // Tela de criar ou trocar senha. Usada no link do convite, no link de recuperacao
  // e no botao Trocar senha (logado). Grava via auth.updateUser na sessao atual.
  function mostrarCriarSenha(opts) {
    if (document.getElementById('auth-senha')) return;
    const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = `
      <div id="auth-senha" style="position:fixed;inset:0;z-index:100000;background:rgba(244,246,249,0.98);display:flex;align-items:center;justify-content:center;font-family:'Plus Jakarta Sans',-apple-system,sans-serif;">
        <div style="background:#fff;border:1px solid rgba(58,58,58,0.08);border-radius:16px;padding:36px 32px;width:100%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.06);">
          <div style="text-align:center;margin-bottom:20px;">
            <div style="font-size:20px;font-weight:800;color:#1E2533;">${esc(opts.titulo)}</div>
            <div style="font-size:13px;color:#8892A4;margin-top:4px;">${esc(opts.sub)}</div>
          </div>
          <form id="auth-senha-form" style="display:flex;flex-direction:column;gap:12px;">
            <input id="auth-senha-1" type="password" placeholder="nova senha (mínimo 8 caracteres)" required autocomplete="new-password"
              style="padding:11px 14px;border:1px solid rgba(58,58,58,0.14);border-radius:10px;font-size:14px;font-family:inherit;outline:none;">
            <input id="auth-senha-2" type="password" placeholder="repita a nova senha" required autocomplete="new-password"
              style="padding:11px 14px;border:1px solid rgba(58,58,58,0.14);border-radius:10px;font-size:14px;font-family:inherit;outline:none;">
            <button id="auth-senha-ok" type="submit"
              style="padding:11px;background:#3B9AC7;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;margin-top:4px;">
              Salvar senha
            </button>
            ${opts.cancelavel ? '<button id="auth-senha-cancelar" type="button" style="background:none;border:none;color:#8892A4;font-size:12px;cursor:pointer;font-family:inherit;">Cancelar</button>' : ''}
            <div id="auth-senha-erro" style="font-size:12px;color:#E03A3A;text-align:center;min-height:16px;"></div>
          </form>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const box = document.getElementById('auth-senha');
    const err = document.getElementById('auth-senha-erro');
    const ok = document.getElementById('auth-senha-ok');
    const cancelar = document.getElementById('auth-senha-cancelar');
    if (cancelar) cancelar.addEventListener('click', () => box.remove());
    document.getElementById('auth-senha-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const s1 = document.getElementById('auth-senha-1').value;
      const s2 = document.getElementById('auth-senha-2').value;
      if (s1.length < 8) { err.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; return; }
      if (s1 !== s2) { err.textContent = 'As duas senhas não estão iguais.'; return; }
      ok.disabled = true; ok.textContent = 'Salvando...';
      const { error } = await window.__SUPABASE__.auth.updateUser({ password: s1 });
      if (error) {
        err.textContent = error.message || 'Falha ao salvar a senha.';
        ok.disabled = false; ok.textContent = 'Salvar senha';
        return;
      }
      try { sessionStorage.removeItem('authPrecisaSenha'); } catch (e) {}
      box.remove();
      if (typeof opts.aoConcluir === 'function') opts.aoConcluir();
    });
  }

  // Botao Trocar senha (usuario logado)
  window.authTrocarSenha = function () {
    if (!window.__SUPABASE__ || !window.AUTH_USER) return;
    mostrarCriarSenha({
      titulo: 'Trocar senha',
      sub: window.AUTH_USER.email,
      cancelavel: true,
      aoConcluir: () => { if (typeof window.toast === 'function') window.toast('✓ Senha alterada', 'ok'); else alert('Senha alterada.'); }
    });
  };

  // Link do email (convite ou recuperacao) chega com os tokens no hash da URL:
  // #access_token=...&refresh_token=...&type=invite|recovery, ou #error=...&error_code=...
  // Abre a sessao e, se for convite ou recuperacao, pede a nova senha antes de entrar.
  // Devolve true quando tratou a URL (o bootstrap nao segue o fluxo normal).
  async function tratarLinkDoEmail() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (!h.get('access_token') && !h.get('error_code') && !h.get('error')) return false;
    history.replaceState(null, '', location.pathname + location.search);
    const tipo = h.get('type');
    // So abre sessao vinda de link de email do proprio fluxo (convite ou recuperacao).
    // Qualquer outro hash com token e ignorado e segue o login normal.
    if (h.get('access_token') && tipo !== 'invite' && tipo !== 'recovery') return false;
    if (h.get('error_code') || h.get('error')) {
      showGate();
      const errEl = document.getElementById('auth-error');
      if (errEl) errEl.textContent = 'Esse link expirou ou já foi usado. Digite seu email e clique em Esqueci minha senha para receber outro.';
      return true;
    }
    const { data, error } = await window.__SUPABASE__.auth.setSession({
      access_token: h.get('access_token'), refresh_token: h.get('refresh_token') || ''
    });
    if (error || !data || !data.session) {
      showGate();
      const errEl = document.getElementById('auth-error');
      if (errEl) errEl.textContent = 'Não foi possível validar o link. Peça um novo em Esqueci minha senha.';
      return true;
    }
    try { sessionStorage.setItem('authPrecisaSenha', tipo); } catch (e) {}
    {
      mostrarCriarSenha({
        titulo: tipo === 'invite' ? 'Crie sua senha' : 'Criar nova senha',
        sub: data.session.user.email,
        aoConcluir: () => hideGate(data.session, data.session.user)
      });
    }
    return true;
  }

  function hideGate(session, user) {
    const gate = document.getElementById('auth-gate');
    if (gate) gate.remove();
    document.body.classList.remove('auth-pending');
    setSessionGlobals(session, user);
    document.dispatchEvent(new CustomEvent('auth:ready', { detail: { session, user } }));
  }

  // Decodifica payload de um JWT (apenas decode, sem verificação de assinatura —
  // a verificação real é feita no backend em verifySupabaseJwt). Usado pra ler
  // app_metadata.role e mostrar/esconder UI de admin no frontend.
  function decodeJwtPayload(token) {
    try {
      const p64 = token.split('.')[1];
      const json = atob(p64.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decodeURIComponent(escape(json)));
    } catch (e) { return null; }
  }

  function setSessionGlobals(session, user) {
    window.AUTH_TOKEN = session ? session.access_token : null;
    window.AUTH_USER = user ? { id: user.id, email: user.email, user_metadata: user.user_metadata || {} } : null;
    window.AUTH_LEVEL = (user && user.user_metadata && user.user_metadata.access_level) || 'total';
    // USER_ROLE vem do JWT (app_metadata.role injetado pelo trigger sync_role_to_metadata).
    // Fallback OPERACIONAL se o trigger ainda não rodou pra esse user.
    const payload = session ? decodeJwtPayload(session.access_token) : null;
    window.USER_ROLE = (payload && payload.app_metadata && payload.app_metadata.role) || 'OPERACIONAL';
    // Atualiza label do botão Sair com email do user (se o botão existir)
    if (user && user.email) {
      const lbl = document.getElementById('logout-label');
      if (lbl) lbl.textContent = 'Sair · ' + user.email.split('@')[0];
    }
  }

  // ── 2. Bootstrap async ──────────────────────────────────────────────────
  async function bootstrap() {
    document.body.classList.add('auth-pending');
    let config;
    try {
      const res = await fetch('/api/config');
      config = await res.json();
    } catch (e) {
      console.error('[auth] falha ao carregar /api/config', e);
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#E03A3A;">Falha ao carregar configuração do servidor. Atualize a página.</div>';
      return;
    }
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      console.error('[auth] /api/config retornou vazio. Setar SUPABASE_URL e SUPABASE_ANON_KEY no Railway.');
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#E03A3A;">Configuração ausente no servidor. Contate o administrador.</div>';
      return;
    }
    window.__APP_CONFIG__ = config;
    window.__SUPABASE__ = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });

    const tratouLink = await tratarLinkDoEmail();
    if (!tratouLink) {
      const { data: { session } } = await window.__SUPABASE__.auth.getSession();
      let pendente = null;
      try { pendente = sessionStorage.getItem('authPrecisaSenha'); } catch (e) {}
      if (session && session.user && pendente) {
        // Recarregou no meio do convite ou da recuperacao: pede a senha de novo antes de entrar.
        mostrarCriarSenha({
          titulo: pendente === 'invite' ? 'Crie sua senha' : 'Criar nova senha',
          sub: session.user.email,
          aoConcluir: () => hideGate(session, session.user)
        });
      } else if (session && session.user) {
        hideGate(session, session.user);
      } else {
        showGate();
      }
    }

    // Reagir a logout/refresh em outras abas
    window.__SUPABASE__.auth.onAuthStateChange((event, newSession) => {
      if (event === 'SIGNED_OUT') {
        setSessionGlobals(null, null);
        location.reload();
      } else if (newSession) {
        setSessionGlobals(newSession, newSession.user);
      }
    });
  }

  // Helper público pra logout
  window.authLogout = async function () {
    if (window.__SUPABASE__) await window.__SUPABASE__.auth.signOut();
    location.reload();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
