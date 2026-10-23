// ============================================================
// MENU EM TÓPICOS (fluidez): o menu lateral passa a ter quatro tópicos recolhíveis
// (Principal, Financeiro, Condomínio e Administração) no lugar de uma lista longa.
// Não muda o visual dos itens nem as permissões: os itens continuam os mesmos elementos,
// com o mesmo onclick e o mesmo id; quem esconde ou mostra cada item continua sendo
// aplicarPermissoesSidebar e os outros scripts. Aqui só se move cada item para o tópico
// certo e se esconde o tópico que ficou sem nenhum item visível.
// Itens criados depois por outros scripts (Financeiro, Central de alertas, Custo) entram
// sozinhos no tópico certo, porque o menu é observado.
// ============================================================
(function () {
  'use strict';

  var TOPICOS = [
    { id: 'principal', nome: 'Principal', paineis: ['dashboard', 'centralalertas', 'tarefas'] },
    { id: 'financeiro', nome: 'Financeiro', icone: '$', paineis: ['fincontrole', 'boletos', 'conciliacao', 'entrada', 'cobranca', 'despesas'] },
    { id: 'condominio', nome: 'Condomínio', icone: '▦', paineis: ['condominio', 'prestacao', 'previsao', 'atas', 'comunicados', 'regras', 'comparativo', 'consumo', 'unidades'] },
    { id: 'administracao', nome: 'Administração', icone: '⚙', paineis: ['seguranca', 'custo'] },
    { id: 'outros', nome: 'Outros', icone: '…', paineis: [] }
  ];
  var CHAVE = 'sh_menu_topicos';

  var nav = document.querySelector('aside.sidebar nav.nav');
  if (!nav) return;

  // Estilo mínimo: o cabeçalho do tópico usa a mesma classe nav-section de antes;
  // só ganha o cursor de clique e a setinha.
  (function estilo() {
    if (document.getElementById('menu-topicos-estilo')) return;
    var st = document.createElement('style');
    st.id = 'menu-topicos-estilo';
    st.textContent = [
      '.nav-topico{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;background:none;border:0;width:100%;text-align:left}',
      '.nav-topico:hover{color:rgba(255,255,255,0.7) !important}',
      '.nav-topico:focus-visible,.nav-grupo:focus-visible{outline:2px solid var(--gs-blue);outline-offset:2px;border-radius:4px}',
      '.nav-topico .seta{display:inline-block;transition:transform .15s;font-size:9px}',
      '.nav-topico[aria-expanded="true"] .seta{transform:rotate(90deg)}',
      '.nav-topico .qtd{margin-left:auto;opacity:.7}',
      // Tópicos Financeiro, Condomínio e Administração com a mesma cara dos itens (Dashboard etc.).
      '.nav-grupo{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer;color:var(--muted);font-size:13px;font-weight:500;font-family:var(--sans);transition:all .15s;background:none;border:0;width:100%;text-align:left;margin-top:2px}',
      '.nav-grupo:hover{background:var(--bg3);color:var(--text)}',
      '.nav-grupo .seta{margin-left:auto;display:inline-block;transition:transform .15s;font-size:12px;opacity:.7}',
      '.nav-grupo[aria-expanded="true"] .seta{transform:rotate(90deg)}',
      '.nav-grupo[aria-expanded="true"]:not(:hover){color:rgba(255,255,255,0.92)}',
      // Itens de dentro do tópico um pouco recuados, para ver que são do tópico aberto.
      '.nav-topico-itens.sub .nav-item{padding-left:26px}',
      '@media (prefers-reduced-motion: reduce){.nav-topico .seta,.nav-grupo .seta{transition:none}}'
    ].join('\n');
    document.head.appendChild(st);
  })();

  // Sanfona: fora o Principal (curto), só um tópico fica aberto por vez, o da tela atual,
  // para o menu não voltar a ser a lista longa de antes. Nada é lembrado entre visitas.
  var aberto = {};
  try { localStorage.removeItem(CHAVE); } catch (e) { /* versão anterior guardava; limpa */ }
  function abrirSo(id) {
    TOPICOS.forEach(function (t) { if (t.id !== 'principal' && t.id !== id) aberto[t.id] = false; });
    aberto[id] = true;
  }

  function painelDo(el) {
    var m = (el.getAttribute('onclick') || '').match(/showPanel\('([^']+)'\)/);
    if (m) return m[1];
    var id = el.id || '';
    return id.indexOf('nav-') === 0 ? id.slice(4) : '';
  }
  function topicoDo(painel) {
    for (var i = 0; i < TOPICOS.length; i++) if (TOPICOS[i].paineis.indexOf(painel) >= 0) return TOPICOS[i].id;
    return 'outros';
  }

  // Monta a estrutura uma vez: cabeçalho e caixa de itens de cada tópico.
  var caixas = {}, cabecalhos = {};
  TOPICOS.forEach(function (t) {
    var cab = document.createElement('button');
    cab.type = 'button';
    cab.setAttribute('data-topico', t.id);
    var cx = document.createElement('div');
    if (t.id === 'principal') {
      // Principal continua como rótulo pequeno com os itens sempre à vista.
      cab.className = 'nav-section nav-topico';
      cab.innerHTML = '<span class="seta" aria-hidden="true">▶</span><span>' + t.nome + '</span><span class="qtd"></span>';
      cx.className = 'nav-topico-itens';
    } else {
      // Os outros tópicos parecem um item do menu (ícone e nome) e abrem os itens embaixo.
      cab.className = 'nav-grupo';
      cab.innerHTML = '<span class="nav-icon" aria-hidden="true">' + t.icone + '</span><span>' + t.nome + '</span><span class="seta" aria-hidden="true">›</span>';
      cx.className = 'nav-topico-itens sub';
    }
    cx.id = 'nav-topico-' + t.id;
    cab.setAttribute('aria-controls', cx.id);
    cab.addEventListener('click', function () {
      if (estaAberto(t.id)) aberto[t.id] = false;
      else if (t.id === 'principal') aberto[t.id] = true;
      else abrirSo(t.id);
      pintar();
    });
    caixas[t.id] = cx; cabecalhos[t.id] = cab;
  });

  function estaAberto(id) {
    if (Object.prototype.hasOwnProperty.call(aberto, id)) return !!aberto[id];
    // Sem escolha guardada: Principal aberto, os outros só se tiverem a tela aberta agora.
    return id === 'principal' || !!caixas[id].querySelector('.nav-item.active');
  }

  var observador = null;
  var organizando = false;

  // Move cada item solto (ou ainda fora do tópico certo) para a caixa do tópico dele,
  // na ordem da lista TOPICOS. Itens que não estão na lista vão para Outros.
  function organizar() {
    if (organizando) return;
    organizando = true;
    try {
      // Primeira vez: tira os cabeçalhos antigos (Principal, Superlógica, Gestão) e põe os novos.
      if (!nav.querySelector('[data-topico]')) {
        nav.querySelectorAll('.nav-section').forEach(function (s) { s.remove(); });
        TOPICOS.forEach(function (t) { nav.appendChild(cabecalhos[t.id]); nav.appendChild(caixas[t.id]); });
      }
      var itens = Array.prototype.slice.call(nav.querySelectorAll('.nav-item'));
      itens.forEach(function (el) {
        var t = topicoDo(painelDo(el));
        if (el.parentNode !== caixas[t]) caixas[t].appendChild(el);
      });
      // Ordem dentro do tópico segue a lista; os desconhecidos ficam no fim.
      TOPICOS.forEach(function (t) {
        var cx = caixas[t.id];
        var filhos = Array.prototype.slice.call(cx.children);
        var ordenados = filhos.slice().sort(function (a, b) {
          var ia = t.paineis.indexOf(painelDo(a)), ib = t.paineis.indexOf(painelDo(b));
          return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
        });
        var mudou = ordenados.some(function (el, i) { return el !== filhos[i]; });
        if (mudou) ordenados.forEach(function (el) { cx.appendChild(el); });
      });
      pintar();
    } finally {
      // As mudanças feitas aqui geram avisos do observador; descarta para não repetir à toa.
      if (observador) observador.takeRecords();
      organizando = false;
    }
  }

  // Esconde o tópico sem itens visíveis, mostra quantos itens tem e abre ou fecha a caixa.
  function pintar() {
    TOPICOS.forEach(function (t) {
      var cx = caixas[t.id], cab = cabecalhos[t.id];
      var visiveis = Array.prototype.filter.call(cx.querySelectorAll('.nav-item'), function (el) { return el.style.display !== 'none'; });
      var temAlgum = visiveis.length > 0;
      cab.style.display = temAlgum ? '' : 'none';
      var ab = temAlgum && estaAberto(t.id);
      cx.style.display = ab ? '' : 'none';
      cab.setAttribute('aria-expanded', ab ? 'true' : 'false');
      var qtd = cab.querySelector('.qtd');
      if (qtd) qtd.textContent = ab ? '' : String(visiveis.length);
    });
  }

  organizar();

  // Itens novos ou que mudaram de visível para escondido (permissões) refazem a conta.
  observador = new MutationObserver(function () { if (!organizando) organizar(); });
  observador.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });

  // Ao abrir uma tela (inclusive pelo botão Abrir da Central), o tópico dela abre junto.
  if (typeof window.showPanel === 'function') {
    var origShow = window.showPanel;
    window.showPanel = function (nome) {
      var r = origShow.apply(this, arguments);
      try {
        var t = topicoDo(nome);
        if (caixas[t] && t !== 'principal') abrirSo(t);
        pintar();
      } catch (e) { /* o menu nunca pode atrapalhar a troca de tela */ }
      return r;
    };
  }
})();
