// ============================================================
// SELETOR DE CONDOMÍNIO ÚNICO (T02)
// Um só componente para todas as abas: topo, janela Gerenciar Condomínio,
// Dashboard, Configurações, banners das abas e Prestação.
// Clique: lista completa. Digitação: filtra sem acento (primeiro quem tem
// palavra começando com o texto, depois quem contém; o código do Superlógica
// também acha). Setas, Enter e Esc. Código do Superlógica ao lado do nome.
// Escolher em qualquer lugar chama setCondominioAtivo (vale para o sistema
// todo) e todos os seletores se atualizam pelo evento condominioAtivo:changed.
//
// Uso: CondSeletor.montar(elementoOuId, {
//   placeholder, compacto, semInfo,
//   extras: [{ rotulo, acao() }],    // opções fixas no fim da lista
//   aoEscolher(c)                    // depois da troca (ex.: fechar janela)
// })
// ============================================================
(function () {
  var lista = null;        // [{ id, nome, id_superlogica }] (já filtrada pela carteira)
  var listaCompleta = null; // T09: lista sem o filtro da carteira
  var carteira = null;     // T09: { todas, carteiras, ids_superlogica, aviso } do usuário logado
  var promessa = null;
  var instancias = [];

  function semAcento(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ativo() {
    return (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : (window.condominioAtivo || null);
  }

  // Busca a lista no Supabase uma vez (depois da sessão pronta, senão a RLS devolve vazio).
  function carregar(forcar) {
    if (forcar) { lista = null; listaCompleta = null; promessa = null; carteiraPedida = false; }
    if (lista) return Promise.resolve(lista);
    if (listaCompleta) return Promise.resolve(lista);
    if (promessa) return promessa;
    if (!window.AUTH_TOKEN || typeof supaFetch !== 'function') return Promise.resolve(null);
    promessa = supaFetch('condominios?select=id,nome,id_superlogica&order=nome.asc')
      .then(function (r) {
        listaCompleta = (Array.isArray(r) && r.length) ? r : null;
        aplicarCarteira();
        promessa = null;
        // Completa o código do Superlógica do ativo salvo antes (migração antiga sem código).
        var a = ativo();
        if (listaCompleta && a && !a.id_superlogica) {
          var achado = listaCompleta.find(function (c) { return String(c.id) === String(a.id); });
          if (achado && achado.id_superlogica && typeof setCondominioAtivo === 'function') {
            setCondominioAtivo({ id: achado.id, nome: achado.nome, id_superlogica: achado.id_superlogica });
          }
        }
        carregarCarteira();
        return lista;
      })
      .catch(function () { promessa = null; return null; });
    return promessa;
  }

  // T09: a carteira do usuário (Carteira A, B...) limita a lista; GESTOR e quem não tem
  // carteira veem todos. A lista aparece na hora com todos e a carteira se aplica quando
  // chega (até 8 s; se falhar, fica com todos). É filtro de tela, não barreira de acesso.
  var carteiraPedida = false;
  function carregarCarteira() {
    if (carteiraPedida || typeof apiAuthFetch !== 'function') return;
    carteiraPedida = true;
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    apiAuthFetch('/api/carteiras/minha', ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.ok ? r.json() : { todas: true }; })
      .catch(function () { return { todas: true }; })
      .then(function (c) {
        if (t) clearTimeout(t);
        carteira = c || { todas: true };
        aplicarCarteira();
        try { window.dispatchEvent(new CustomEvent('carteira:carregada', { detail: carteira })); } catch (_) {}
        var a = ativo();
        if (carteira.todas === false && a && a.id_superlogica && !CondSeletorNaCarteira(a.id_superlogica) && typeof toast === 'function') {
          toast('O condomínio ativo (' + a.nome + ') não está na sua carteira. Escolha outro no seletor.', 'warn');
        }
      });
  }
  function CondSeletorNaCarteira(idSuperlogica) {
    if (!carteira || carteira.todas !== false) return true;
    return (carteira.ids_superlogica || []).some(function (x) { return String(x) === String(idSuperlogica); });
  }
  // lista = completa ou filtrada pela carteira. [] = carteira sem condomínio no Hub; null = não carregou.
  function aplicarCarteira() {
    if (!listaCompleta) { lista = null; }
    else if (carteira && carteira.todas === false && Array.isArray(carteira.ids_superlogica)) {
      lista = listaCompleta.filter(function (c) { return c && CondSeletorNaCarteira(c.id_superlogica); });
    } else lista = listaCompleta;
    instancias.forEach(function (i) { i.atualizar(); if (i.aberto()) i.filtrar(i.input.value === i.nomeAtual() ? '' : i.input.value); });
  }
  document.addEventListener('auth:ready', function () { carregar(); });

  function filtrarLista(query) {
    var base = Array.isArray(lista) ? lista : [];
    var q = semAcento((query || '').trim());
    if (!q) return base.slice();
    var comeca = [], contem = [];
    base.forEach(function (c) {
      var n = semAcento(c && c.nome);
      if (n.indexOf(q) === 0 || n.split(/\s+/).some(function (p) { return p.indexOf(q) === 0; })) comeca.push(c);
      else if (n.indexOf(q) !== -1 || String(c.id_superlogica || '') === q) contem.push(c);
    });
    return comeca.concat(contem);
  }

  // Troca o condomínio do sistema. Devolve false se a troca foi recusada.
  function definir(c) {
    if (!c || !c.id) return false;
    var a = ativo();
    if (a && String(a.id) === String(c.id)) return true;
    if (typeof setCondominioAtivo !== 'function') return false;
    return setCondominioAtivo({ id: c.id, nome: c.nome, id_superlogica: c.id_superlogica ? Number(c.id_superlogica) || c.id_superlogica : null }) !== false;
  }

  function montar(alvo, opcoes) {
    var host = typeof alvo === 'string' ? document.getElementById(alvo) : alvo;
    if (!host) return null;
    if (host._condSeletor) return host._condSeletor;
    opcoes = opcoes || {};
    host.classList.add('cs-host');
    if (opcoes.compacto) host.classList.add('cs-compacto');
    host.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'cs-wrap';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'cs-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = opcoes.placeholder || 'Clique para ver todos ou digite o nome';
    input.setAttribute('aria-label', 'Condomínio');
    var dd = document.createElement('div');
    dd.className = 'cond-dropdown cs-lista';
    wrap.appendChild(input);
    wrap.appendChild(dd);
    host.appendChild(wrap);
    var info = null;
    if (!opcoes.semInfo) {
      info = document.createElement('div');
      info.className = 'cs-info';
      host.appendChild(info);
    }

    var inst = { host: host, input: input, dd: dd, filtrados: [], marcado: -1 };
    inst.nomeAtual = function () { var a = ativo(); return a ? a.nome : ''; };
    inst.aberto = function () { return dd.classList.contains('open'); };
    inst.fechar = function () {
      dd.classList.remove('open');
      dd.innerHTML = '';
      input.value = inst.nomeAtual();
    };
    inst.atualizar = function () {
      var a = ativo();
      if (document.activeElement !== input || !inst.aberto()) input.value = a ? a.nome : '';
      var cod = a ? (a.id_superlogica || (lista || []).reduce(function (r, c) { return r || (String(c.id) === String(a.id) ? c.id_superlogica : null); }, null)) : null;
      input.title = a ? (a.nome + (cod ? ' · código ' + cod + ' no Superlógica' : '')) : '';
      if (info) {
        info.textContent = !a ? 'Nenhum condomínio selecionado.'
          : (cod ? 'Código ' + cod + ' no Superlógica' : 'Sem código do Superlógica no cadastro');
      }
      host.classList.toggle('cs-vazio', !a);
    };
    inst.filtrar = function (query) {
      if (lista === null) carregar();
      var filtrados = filtrarLista(query);
      inst.filtrados = filtrados;
      var q = (query || '').trim();
      inst.marcado = filtrados.length ? 0 : -1;
      var a = ativo();
      var html = '';
      if (carteira && carteira.todas === false && (carteira.carteiras || []).length) {
        html += '<div class="cond-loading cs-carteira">Sua carteira: ' + esc(carteira.carteiras.map(function (x) { return x.nome; }).join(', ')) + '</div>';
      }
      if (!Array.isArray(lista)) {
        html += '<div class="cond-loading">' + (window.AUTH_TOKEN ? 'Carregando condomínios...' : 'Entre no sistema para ver os condomínios.') + '</div>';
      } else if (!lista.length) {
        html += '<div class="cond-option cs-nada">Nenhum condomínio da sua carteira está cadastrado no Hub.</div>';
      } else if (!filtrados.length) {
        html += '<div class="cond-option cs-nada">Nenhum condomínio com "' + esc(q) + '"</div>';
      } else {
        html += filtrados.map(function (c, i) {
          var atual = a && String(c.id) === String(a.id);
          return '<div class="cond-option' + (i === 0 && q ? ' marcado' : '') + (atual ? ' atual' : '') + '" data-idx="' + i + '" role="option">'
            + '<span class="cond-name">' + esc(c.nome) + '</span>'
            + '<span class="cond-id">' + (c.id_superlogica ? 'código ' + esc(c.id_superlogica) : 'sem código') + '</span>'
            + '</div>';
        }).join('');
      }
      (opcoes.extras || []).forEach(function (x, k) {
        html += '<div class="cond-option cs-extra" data-extra="' + k + '"><span class="cond-name">' + esc(x.rotulo) + '</span></div>';
      });
      dd.innerHTML = html;
      dd.classList.add('open');
      if (!q && a) {
        var el = dd.querySelector('.cond-option.atual');
        if (el) el.scrollIntoView({ block: 'nearest' });
      }
    };
    inst.escolher = function (c) {
      var ok = definir(c);
      inst.fechar();
      input.blur();
      if (ok && typeof opcoes.aoEscolher === 'function') opcoes.aoEscolher(c);
    };

    input.addEventListener('focus', function () { input.select(); inst.filtrar(''); });
    input.addEventListener('click', function () { if (!inst.aberto()) inst.filtrar(input.value === inst.nomeAtual() ? '' : input.value); });
    input.addEventListener('input', function () { inst.filtrar(input.value); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { inst.fechar(); input.blur(); return; }
      if (!inst.aberto()) { if (ev.key === 'ArrowDown') inst.filtrar(''); return; }
      var n = inst.filtrados.length;
      if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && n) {
        ev.preventDefault();
        inst.marcado = ((inst.marcado < 0 ? 0 : inst.marcado) + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
        dd.querySelectorAll('.cond-option[data-idx]').forEach(function (el) {
          var on = parseInt(el.dataset.idx, 10) === inst.marcado;
          el.classList.toggle('marcado', on);
          if (on) el.scrollIntoView({ block: 'nearest' });
        });
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        var c = inst.filtrados[inst.marcado >= 0 ? inst.marcado : 0];
        if (c) inst.escolher(c);
      } else if (ev.key === 'Tab') {
        inst.fechar();
      }
    });
    // mousedown em vez de click: escolhe antes do blur do campo.
    // preventDefault sempre: arrastar a barra de rolagem da lista não tira o foco do campo.
    dd.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      var opt = ev.target.closest('.cond-option');
      if (!opt) return;
      if (opt.dataset.extra != null) {
        var x = (opcoes.extras || [])[parseInt(opt.dataset.extra, 10)];
        inst.fechar();
        input.blur();
        if (x && typeof x.acao === 'function') x.acao();
        return;
      }
      if (opt.dataset.idx == null) return;
      var c = inst.filtrados[parseInt(opt.dataset.idx, 10)];
      if (c) inst.escolher(c);
    });
    input.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== input && inst.aberto()) inst.fechar(); }, 120); });

    host._condSeletor = inst;
    instancias.push(inst);
    inst.atualizar();
    carregar();
    return inst;
  }

  window.addEventListener('condominioAtivo:changed', function () {
    instancias.forEach(function (i) { if (document.body.contains(i.host)) i.atualizar(); });
  });

  window.CondSeletor = {
    montar: montar,
    carregar: carregar,
    recarregar: function () { return carregar(true); },
    lista: function () { return lista; },
    // T09: carteira do usuário. naCarteira(codigo) diz se o condomínio entra nas listas.
    carteira: function () { return carteira; },
    naCarteira: function (idSuperlogica) { return CondSeletorNaCarteira(idSuperlogica); },
    buscarPorId: function (id) { return (lista || []).find(function (c) { return String(c.id) === String(id); }) || null; },
    definir: definir,
    semAcento: semAcento,
  };
})();
