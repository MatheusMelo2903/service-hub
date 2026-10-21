// T18: módulos das abas Ficha do Condomínio, Cobrança e Comparativo nas permissões, ação
// "ver todas as carteiras" e o card "Prazos das manutenções periódicas" em Configurações.
// Fica em arquivo próprio (carregado depois do script principal do index.html) para mexer o
// mínimo no index. O servidor confere tudo de novo: aqui é só o que aparece na tela.
(function () {
  if (typeof MODULOS_CATALOGO === 'undefined' || typeof PANEL_TO_MODULO === 'undefined') return;

  // 1. Catálogo de permissões (espelha o trigger set_gestor_permissoes_totais da migration 010).
  MODULOS_CATALOGO.ficha_condominio = { label: 'Ficha do Condomínio', acoes: ['ver'] };
  MODULOS_CATALOGO.cobranca = { label: 'Cobrança', acoes: ['ver', 'segunda_via'] };
  MODULOS_CATALOGO.comparativo = { label: 'Comparativo', acoes: ['ver'] };
  if (MODULOS_CATALOGO.configuracoes && MODULOS_CATALOGO.configuracoes.acoes.indexOf('todas_carteiras') < 0) {
    MODULOS_CATALOGO.configuracoes.acoes.push('todas_carteiras');
  }
  PANEL_TO_MODULO.condominio = 'ficha_condominio';
  PANEL_TO_MODULO.cobranca = 'cobranca';
  PANEL_TO_MODULO.comparativo = 'comparativo';
  var ABAS_T18 = { condominio: 'ficha_condominio', cobranca: 'cobranca', comparativo: 'comparativo' };

  // 2. Menu: some a aba de quem não tem o módulo. O GESTOR sempre vê (mesmo num banco ainda
  //    sem a migration 010). Se a aba aberta (ou a lembrada do último acesso) não é permitida,
  //    volta para o Dashboard.
  function podeAba(nome) {
    var m = ABAS_T18[nome];
    if (!m) return true;
    if (window.USER_ROLE === 'GESTOR') return true;
    return typeof temPermissao === 'function' ? temPermissao(m) : true;
  }
  if (typeof window.aplicarPermissoesSidebar === 'function') {
    var orig = window.aplicarPermissoesSidebar;
    window.aplicarPermissoesSidebar = function () {
      orig.apply(this, arguments);
      if (!window.USER_PERMS) return;
      document.querySelectorAll('.nav-item').forEach(function (el) {
        var h = el.getAttribute('onclick') || '';
        var m = h.match(/showPanel\('([^']+)'\)/);
        if (m && ABAS_T18[m[1]]) el.style.display = podeAba(m[1]) ? '' : 'none';
      });
      Object.keys(ABAS_T18).forEach(function (nome) {
        var p = document.getElementById('panel-' + nome);
        if (p && p.classList.contains('active') && !podeAba(nome) && typeof showPanel === 'function') showPanel('dashboard');
      });
      cartPrazosAtualizarCard();
    };
  }

  // 3. Cobrança: o botão da 2ª via aparece para o GESTOR ou para quem tem a ação segunda_via.
  window.cobPodeSegundaVia = function () {
    return window.USER_ROLE === 'GESTOR' || (typeof temPermissao === 'function' && !!window.USER_PERMS && temPermissao('cobranca', 'segunda_via'));
  };

  // 4. Card de prazos das manutenções (só GESTOR). Os valores vêm do servidor.
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  var prazosEstado = { carregado: false, dados: null };
  function cartPrazosAtualizarCard() {
    var painel = document.getElementById('panel-configuracoes');
    if (!painel) return;
    var card = document.getElementById('card-prazos-manutencao');
    if (window.USER_ROLE !== 'GESTOR') { if (card) card.style.display = 'none'; return; }
    if (!card) {
      card = document.createElement('div');
      card.className = 'card';
      card.id = 'card-prazos-manutencao';
      card.innerHTML = '<div class="card-header"><span class="card-title">Prazos das manutenções periódicas</span></div>'
        + '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Dias sem pagamento de cada manutenção até aparecer o alerta no Dashboard (vale para todos os condomínios; o alerta só aparece passados mais 15 dias de tolerância).</div>'
        + '<div id="prazos-campos" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px"><div style="font-size:12px;color:var(--muted);font-family:var(--mono)">Carregando...</div></div>'
        + '<div style="margin-top:14px;display:flex;align-items:center;gap:10px"><button class="btn btn-primary" id="prazos-salvar" onclick="cartPrazosSalvar()" style="font-size:12px;padding:6px 14px">Salvar prazos</button>'
        + '<button class="btn btn-ghost" onclick="cartPrazosPadrao()" style="font-size:12px;padding:6px 12px">Voltar ao padrão</button>'
        + '<span id="prazos-info" style="font-size:12px;color:var(--muted)"></span></div>';
      var ref = document.getElementById('card-usuarios-admin');
      if (ref && ref.parentNode === painel) ref.insertAdjacentElement('afterend', card); else painel.insertBefore(card, painel.firstChild);
    }
    card.style.display = '';
    if (!prazosEstado.carregado && window.AUTH_TOKEN) cartPrazosCarregar();
  }
  function render(prazos) {
    var d = prazosEstado.dados;
    var el = document.getElementById('prazos-campos');
    if (!el || !d) return;
    el.innerHTML = Object.keys(d.nomes).map(function (k) {
      return '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text)">' + esc(d.nomes[k])
        + '<span style="display:flex;align-items:center;gap:6px"><input type="number" min="' + d.minimo + '" max="' + d.maximo + '" step="1" data-prazo="' + esc(k) + '" value="' + esc(prazos[k]) + '" style="width:100px"> dias'
        + '<span style="font-size:10px;color:var(--muted);font-family:var(--mono)">padrão ' + esc(d.padrao[k]) + '</span></span></label>';
    }).join('');
  }
  async function cartPrazosCarregar() {
    prazosEstado.carregado = true;
    try {
      var r = await apiAuthFetch('/api/alertas/prazos-manutencao');
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
      prazosEstado.dados = j;
      render(j.prazos);
      var info = document.getElementById('prazos-info');
      if (info) info.textContent = j.origem === 'banco' ? '' : 'Usando o padrão (o banco ainda não tem os prazos).';
    } catch (e) {
      prazosEstado.carregado = false;
      var el = document.getElementById('prazos-campos');
      if (el) el.innerHTML = '<div style="font-size:12px;color:var(--danger);font-family:var(--mono)">' + esc(e.message || 'Falha ao carregar') + '</div>';
    }
  }
  window.cartPrazosPadrao = function () { if (prazosEstado.dados) render(prazosEstado.dados.padrao); };
  window.cartPrazosSalvar = async function () {
    var d = prazosEstado.dados;
    if (!d) return;
    var prazos = {};
    var erro = '';
    document.querySelectorAll('[data-prazo]').forEach(function (inp) {
      var n = Number(inp.value);
      if (!Number.isInteger(n) || n < d.minimo || n > d.maximo) erro = erro || (d.nomes[inp.dataset.prazo] + ': use um número inteiro de ' + d.minimo + ' a ' + d.maximo + ' dias.');
      prazos[inp.dataset.prazo] = n;
    });
    if (erro) { toast(erro, 'err'); return; }
    var btn = document.getElementById('prazos-salvar');
    btn.disabled = true;
    try {
      var r = await apiAuthFetch('/api/alertas/prazos-manutencao', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prazos: prazos }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
      render(j.prazos);
      var info = document.getElementById('prazos-info');
      if (info) info.textContent = '';
      toast('Prazos salvos. Os alertas do Dashboard já usam os novos valores.', 'ok');
    } catch (e) {
      toast('Não foi possível salvar os prazos: ' + e.message, 'err');
    } finally { btn.disabled = false; }
  };
  document.addEventListener('auth:ready', function () { setTimeout(cartPrazosAtualizarCard, 0); });
})();
