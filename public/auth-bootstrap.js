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
        </form>
      </div>
    </div>
    <style>
      #auth-gate input:focus { border-color: #3B9AC7; }
      #auth-gate button:hover { background: #2D7FA8; }
      #auth-gate button:disabled { opacity: .5; cursor: not-allowed; }
      body.auth-pending > *:not(#auth-gate) { display: none !important; }
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
  }

  function hideGate(session, user) {
    const gate = document.getElementById('auth-gate');
    if (gate) gate.remove();
    document.body.classList.remove('auth-pending');
    setSessionGlobals(session, user);
    document.dispatchEvent(new CustomEvent('auth:ready', { detail: { session, user } }));
  }

  function setSessionGlobals(session, user) {
    window.AUTH_TOKEN = session ? session.access_token : null;
    window.AUTH_USER = user ? { id: user.id, email: user.email, user_metadata: user.user_metadata || {} } : null;
    window.AUTH_LEVEL = (user && user.user_metadata && user.user_metadata.access_level) || 'total';
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

    const { data: { session } } = await window.__SUPABASE__.auth.getSession();
    if (session && session.user) {
      hideGate(session, session.user);
    } else {
      showGate();
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
