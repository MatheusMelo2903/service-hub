// ============================================================
// MINHA CONTA DO SUPERLÓGICA e botão ABRIR NO SUPERLÓGICA
// 1. window.authContaSuperlogica(): janela onde a própria pessoa grava, troca ou apaga o email e a
//    senha do Superlógica dela. A senha vai para o servidor, que guarda cifrada; a tela só fica
//    sabendo "senha guardada". Ninguém mais vê, nem o gestor.
// 2. window.AbrirSuperlogica.botao(host, opcoes) e .abrir(opcoes, host): leva a pessoa à tela certa
//    do Superlógica em outra aba (link de uso único, 60 segundos, só para quem pediu). Publicar sem
//    avisar os moradores pede a verificação "Não sou um robô": quem resolve e confirma é a pessoa.
// Rotas: /api/conta-superlogica, /api/conta-superlogica/abrir e /api/conta-superlogica/ir.
// ============================================================
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function aviso(msg, tipo) { if (typeof window.toast === 'function') window.toast(msg, tipo || 'ok'); }
  async function chamar(url, opcoes) {
    var r = await apiAuthFetch(url, opcoes || {});
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
    return j;
  }

  // ── janela da conta ──
  // Monta a janela, lê se já existe conta guardada e liga os botões salvar e apagar.
  async function abrirConta() {
    if (!window.AUTH_TOKEN || document.getElementById('sl-conta')) return;
    var html = '<div id="sl-conta" style="position:fixed;inset:0;z-index:100000;background:rgba(20,24,32,0.55);display:flex;align-items:center;justify-content:center;font-family:var(--mono,inherit)">'
      + '<div role="dialog" aria-modal="true" aria-labelledby="sl-conta-titulo" style="background:var(--bg2,#fff);color:var(--text,#1e2533);border:1px solid var(--border,#dde2ea);border-radius:12px;padding:22px 24px;width:100%;max-width:420px;font-size:13px">'
      + '<div id="sl-conta-titulo" style="font-size:16px;font-weight:700;margin-bottom:4px">Minha conta do Superlógica</div>'
      + '<div style="color:var(--muted,#8892a4);margin-bottom:12px">Seu email e sua senha do Superlógica. Só você grava, troca e apaga. A senha fica guardada cifrada e não aparece para ninguém, nem para o gestor.</div>'
      + '<div id="sl-conta-estado" style="margin-bottom:10px;color:var(--muted,#8892a4)">Lendo...</div>'
      + '<form id="sl-conta-form" style="display:flex;flex-direction:column;gap:8px" autocomplete="on">'
      + '<input id="sl-conta-email" type="email" maxlength="200" placeholder="email do Superlógica" autocomplete="username" aria-label="Email do Superlógica" style="padding:9px 12px;border:1px solid var(--border2,#cfd6e0);border-radius:8px;background:var(--bg,#fff);color:var(--text,#1e2533);font-family:inherit;font-size:13px">'
      + '<input id="sl-conta-senha" type="password" maxlength="200" placeholder="senha do Superlógica" autocomplete="new-password" aria-label="Senha do Superlógica" style="padding:9px 12px;border:1px solid var(--border2,#cfd6e0);border-radius:8px;background:var(--bg,#fff);color:var(--text,#1e2533);font-family:inherit;font-size:13px">'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">'
      + '<button type="submit" class="btn btn-primary" id="sl-conta-salvar" style="font-size:12px">Salvar</button>'
      + '<button type="button" class="btn btn-ghost" id="sl-conta-apagar" style="font-size:12px;display:none">Apagar a conta guardada</button>'
      + '<button type="button" class="btn btn-ghost" id="sl-conta-fechar" style="font-size:12px;margin-left:auto">Fechar</button>'
      + '</div>'
      + '<div id="sl-conta-msg" style="min-height:16px;font-size:12px"></div>'
      + '</form>'
      + '<div style="margin-top:10px;font-size:11px;color:var(--muted,#8892a4)">A senha fica guardada cifrada e por enquanto só será usada quando o login direto estiver pronto. Hoje o botão Abrir no Superlógica leva você direto à tela certa; se o Superlógica pedir login, entre uma vez com esta conta e o navegador guarda a sessão.</div>'
      + '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
    var caixa = document.getElementById('sl-conta');
    var msg = document.getElementById('sl-conta-msg');
    var estado = document.getElementById('sl-conta-estado');
    var email = document.getElementById('sl-conta-email');
    var senha = document.getElementById('sl-conta-senha');
    var apagar = document.getElementById('sl-conta-apagar');
    var salvar = document.getElementById('sl-conta-salvar');
    var temConta = false, confirmarApagar = false;
    function fechar() { caixa.remove(); document.removeEventListener('keydown', tecla); }
    function tecla(e) { if (e.key === 'Escape') fechar(); }
    function falar(texto, erro) { msg.style.color = erro ? 'var(--danger,#e03a3a)' : 'var(--success,#2e9e6a)'; msg.textContent = texto || ''; }
    function mostrar(conta, chave) {
      temConta = !!conta;
      confirmarApagar = false;
      apagar.textContent = 'Apagar a conta guardada';
      apagar.style.display = temConta ? '' : 'none';
      if (conta) email.value = conta.email || '';
      senha.value = '';
      senha.placeholder = temConta ? 'nova senha (em branco mantém a guardada)' : 'senha do Superlógica';
      estado.innerHTML = (temConta ? '<b>' + esc(conta.email) + '</b>: ' + (conta.senha_guardada ? 'senha guardada.' : 'sem senha.') : 'Nenhuma conta guardada.')
        + (chave === false ? '<div style="color:var(--danger,#e03a3a);margin-top:4px">O servidor ainda não está pronto para guardar senhas. Fale com a administração do Hub.</div>' : '');
    }
    document.getElementById('sl-conta-fechar').addEventListener('click', fechar);
    document.addEventListener('keydown', tecla);
    caixa.addEventListener('click', function (e) { if (e.target === caixa) fechar(); });
    try { var j = await chamar('/api/conta-superlogica'); mostrar(j.conta, j.chave_configurada); }
    catch (e) { estado.textContent = e.message; }
    email.focus();

    document.getElementById('sl-conta-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      falar('');
      var corpo = { email: email.value.trim() };
      if (senha.value) corpo.senha = senha.value;
      if (!temConta && !corpo.senha) { falar('Digite a senha do Superlógica.', true); return; }
      salvar.disabled = true;
      try {
        var j = await chamar('/api/conta-superlogica', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        corpo = null;
        mostrar(j.conta, true);
        falar('Conta do Superlógica guardada.');
        aviso('Conta do Superlógica guardada');
      } catch (er) { falar(er.message, true); }
      finally { senha.value = ''; salvar.disabled = false; }
    });

    // Apagar pede um segundo clique (sem caixa de confirmação do navegador).
    apagar.addEventListener('click', async function () {
      if (!confirmarApagar) { confirmarApagar = true; apagar.textContent = 'Clique de novo para apagar'; return; }
      apagar.disabled = true;
      try {
        await chamar('/api/conta-superlogica', { method: 'DELETE' });
        email.value = '';
        mostrar(null, true);
        falar('Conta do Superlógica apagada do Hub.');
      } catch (er) { falar(er.message, true); }
      finally { apagar.disabled = false; }
    });
  }

  // ── botão Abrir no Superlógica ──
  // Abre a aba já no clique (o navegador só deixa abrir aba no clique), pede o link de uso único
  // e manda a aba para o Hub por formulário, que leva ao Superlógica.
  async function abrir(o, host) {
    var st = host ? host.querySelector('.sl-abrir-status') : null;
    function falar(html, cor) { if (st) { st.style.color = cor || 'var(--muted)'; st.innerHTML = html; } }
    if (!window.AUTH_TOKEN) { falar('Entre no Hub de novo para usar este botão.', 'var(--danger)'); return; }
    var nome = 'sl_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    var aba = window.open('', nome);
    if (!aba) { falar('O navegador bloqueou a aba nova. Libere as janelas deste site e clique de novo.', 'var(--danger)'); return; }
    try { aba.document.title = 'Abrindo o Superlógica'; aba.document.body.textContent = 'Abrindo o Superlógica...'; } catch (e) { /* aba já mudou */ }
    falar('Abrindo o Superlógica...');
    try {
      var j = await chamar('/api/conta-superlogica/abrir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destino: o.destino || 'documentos', id_superlogica: o.idSuperlogica || null })
      });
      var f = document.createElement('form');
      f.method = 'POST'; f.action = '/api/conta-superlogica/ir'; f.target = nome; f.style.display = 'none';
      [['token', j.token], ['acesso', window.AUTH_TOKEN]].forEach(function (p) {
        var i = document.createElement('input'); i.type = 'hidden'; i.name = p[0]; i.value = p[1]; f.appendChild(i);
      });
      document.body.appendChild(f);
      f.submit();
      f.remove();
      var cond = o.nomeCond ? esc(o.nomeCond) + (o.idSuperlogica ? ' (código ' + esc(o.idSuperlogica) + ')' : '') : '';
      falar('Abrimos a tela ' + esc(j.tela || 'do Superlógica') + ' em outra aba. Se pedir login, entre com a sua conta do Superlógica'
        + (j.email ? ' (' + esc(j.email) + ')' : '') + '.'
        + (o.passos ? '<ol style="margin:6px 0 0 18px;padding:0">' + o.passos.map(function (p) { return '<li>' + esc(p).replace(/\{cond\}/g, cond || 'o condomínio certo') + '</li>'; }).join('') + '</ol>' : ''));
    } catch (e) {
      try { aba.close(); } catch (e2) { /* aba já fechada */ }
      falar(esc(e.message), 'var(--danger)');
    }
  }

  // Passos de publicar sem avisar os moradores (o texto da pergunta é o do próprio Superlógica).
  var PASSOS_PUBLICAR = [
    'Confira no topo do Superlógica se o condomínio é {cond}.',
    'Na linha do documento, clique em publicar.',
    'Quando perguntar se deseja notificar os condôminos, responda Não.',
    'Marque a verificação Não sou um robô e confirme.'
  ];

  // Desenha o botão e a área de instruções dentro de host.
  function botao(host, o) {
    if (!host) return;
    o = o || {};
    host.innerHTML = '<div class="sl-abrir" style="margin-top:8px">'
      + '<button type="button" class="btn btn-ghost sl-abrir-btn" style="font-size:12px;padding:6px 12px">' + esc(o.rotulo || 'Publicar sem avisar os moradores (confirmar no Superlógica)') + '</button>'
      + '<div class="sl-abrir-status hint" style="margin-top:6px;font-size:12px"></div></div>';
    host.querySelector('.sl-abrir-btn').addEventListener('click', function () { abrir(o, host); });
  }

  window.authContaSuperlogica = abrirConta;
  window.AbrirSuperlogica = { abrir: abrir, botao: botao, PASSOS_PUBLICAR: PASSOS_PUBLICAR };
})();
