// ============================================================
// CENTRAL DE ALERTAS (T51): todos os alertas da carteira numa tela só, separados por área
// (Financeiro, Operacional, Documentos e jurídico e, para quem já vê a Segurança, Segurança),
// com filtros, situação (visto, resolvido, reabrir) e a preferência "Meus alertas" de cada
// pessoa (desligar um tipo só esconde para ela; o alerta continua sendo gerado).
// Rotas: GET /api/central-alertas, GET e PUT /api/alertas/preferencias, PATCH /api/alertas/:id
// (só alertas de origem condomínio) e GET /api/carteiras (só GESTOR).
// O item do menu e a tela são criados aqui, no mesmo padrão do Financeiro, para não mexer no
// resto do index.html. O servidor confere tudo de novo: aqui é só o que aparece na tela.
// ============================================================
(function () {
  'use strict';
  var PAINEL = 'centralalertas';
  var MODULO = 'central_alertas';
  var MAX_LISTA = 500;

  // 1. Catálogo de permissões e título da aba (só se ninguém registrou antes).
  if (typeof MODULOS_CATALOGO !== 'undefined' && !MODULOS_CATALOGO[MODULO]) {
    MODULOS_CATALOGO[MODULO] = { label: 'Central de alertas', acoes: ['ver', 'silenciar'] };
  }
  if (typeof PAGE_META !== 'undefined') PAGE_META[PAINEL] = { title: 'Central de alertas', sub: 'alertas de toda a carteira em um só lugar' };

  // Falha fechada: sem permissões carregadas não mostra. GESTOR sempre vê. Para os outros,
  // o módulo vem liberado por padrão (como o Dashboard): só some se estiver desligado.
  function podeVer() {
    var p = window.USER_PERMS;
    if (!p || typeof p !== 'object') return false;
    if (window.USER_ROLE === 'GESTOR') return true;
    var x = p[MODULO];
    if (!x) return true;
    return x.visivel === true;
  }

  // 2. Utilitários.
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function semAcento(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function horaBR(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function linkSeguro(u) { return /^https:\/\/[a-z0-9.-]+\.superlogica\.net\//i.test(String(u || '')) ? String(u) : ''; }
  function avisar(msg, tipo) { if (typeof toast === 'function') toast(msg, tipo); }

  var COR = { alta: 'var(--danger)', media: 'var(--warning)', baixa: 'var(--muted)' };
  var NOME_GRAV = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
  var ORDEM_GRAV = { alta: 0, media: 1, baixa: 2 };
  var NOME_SIT = { novo: 'Novo', visto: 'Visto', resolvido: 'Resolvido' };
  var NOME_AREA = { financeiro: 'Financeiro', operacional: 'Operacional', documentos: 'Documentos e jurídico', juridico: 'Documentos e jurídico', documentos_juridico: 'Documentos e jurídico', seguranca: 'Segurança' };
  var ORDEM_AREA = ['financeiro', 'operacional', 'documentos', 'documentos_juridico', 'juridico', 'seguranca'];
  // Rótulo curto de cada tipo, caso o servidor não mande o rótulo.
  var ROTULO = {
    conta_a_vencer: 'A vencer', saldo_baixo: 'Saldo baixo', recorrente_nao_lancada: 'Recorrente', sem_nota_fiscal: 'Sem nota',
    manutencao_atrasada: 'Manutenção', consumo_fora_padrao: 'Consumo', certidao_vencendo: 'Certidão', certidao_vencida: 'Certidão vencida',
    mandato_vencendo: 'Mandato', advertencia_vencida: 'Advertência'
  };
  // Onde cada tipo de alerta de condomínio é tratado no Hub (quando o alerta não traz link).
  var DESTINO = {
    conta_a_vencer: 'dashboard', saldo_baixo: 'dashboard', recorrente_nao_lancada: 'dashboard', sem_nota_fiscal: 'dashboard',
    manutencao_atrasada: 'dashboard', consumo_fora_padrao: 'dashboard',
    certidao_vencendo: 'prestacao', certidao_vencida: 'prestacao',
    mandato_vencendo: 'regras', advertencia_vencida: 'regras'
  };
  var INDISPONIVEL = 'A Central de alertas ainda não está disponível neste ambiente. Tente de novo mais tarde.';

  function normGrav(g) { var s = semAcento(g); return s === 'alta' || s === 'media' || s === 'baixa' ? s : 'baixa'; }
  function normSit(s) { s = semAcento(s); return s === 'visto' || s === 'resolvido' ? s : 'novo'; }
  function nomeArea(k) {
    var d = est.dados;
    var a = d && (d.areas || []).find(function (x) { return x && x.area === k; });
    return (a && a.nome) || NOME_AREA[k] || k || 'Outros';
  }

  // 3. Estilo próprio da tela (prefixo ca, para não afetar o resto).
  function injetarEstilo() {
    if (document.getElementById('ca-estilo')) return;
    var st = document.createElement('style');
    st.id = 'ca-estilo';
    st.textContent = [
      '.ca-barra{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.ca-barra select{width:auto;min-width:220px}',
      '.ca-info{font-size:12px;color:var(--muted);margin:6px 0 2px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.ca-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:2px 10px;border-radius:100px;background:var(--gs-blue-light);color:var(--gs-blue)}',
      '.ca-pill i{width:6px;height:6px;border-radius:50%;background:var(--gs-blue);animation:caPulsa 1.2s ease-in-out infinite}',
      '@keyframes caPulsa{0%,100%{opacity:.3}50%{opacity:1}}',
      '.ca-aviso{font-size:12px;color:var(--warning)}',
      '.ca-areas{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin:14px 0}',
      '.ca-area{background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius);padding:12px 14px;cursor:pointer;text-align:left;font:inherit;color:var(--text);transition:border-color .15s,background .15s,box-shadow .15s}',
      '.ca-area:hover{border-color:var(--gs-blue)}',
      '.ca-area.sel{border-color:var(--gs-blue);background:var(--gs-blue-light);box-shadow:inset 0 0 0 1px var(--gs-blue)}',
      '.ca-area:focus-visible{outline:2px solid var(--gs-blue);outline-offset:2px}',
      '.ca-area-nome{font-size:12px;font-weight:600;color:var(--muted)}',
      '.ca-area.sel .ca-area-nome{color:var(--gs-blue)}',
      '.ca-area-total{font-size:26px;font-weight:700;line-height:1.15;margin:2px 0 6px}',
      '.ca-area-grav{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--muted)}',
      '.ca-area-sil{font-size:10px;color:var(--muted);margin-top:4px;font-family:var(--mono)}',
      '.ca-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle}',
      '.ca-filtros{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.ca-filtros select,.ca-filtros input{width:auto}',
      '.ca-filtros input{min-width:200px}',
      '.ca-sit{display:flex;gap:6px;flex-wrap:wrap}',
      '.ca-sit .chip{font-family:var(--mono);line-height:1.4}',
      '.ca-sit .chip:not(.active){background:transparent}',
      '.ca-silenc{margin-left:auto;font-size:12px;padding:6px 12px}',
      '.ca-grupo{margin-top:18px}',
      '.ca-grupo:first-child{margin-top:0}',
      '.ca-grupo-cab{display:flex;align-items:center;gap:8px;font-size:14px;margin-bottom:8px;flex-wrap:wrap}',
      '.ca-cont{font-size:11px;font-family:var(--mono);background:var(--bg3);color:var(--muted);padding:1px 8px;border-radius:10px}',
      '.ca-cont.alta{background:rgba(224,58,58,0.10);color:var(--danger)}',
      '.ca-item{padding:10px 12px;background:var(--bg2);border:1px solid var(--border);border-left:3px solid var(--muted);border-radius:8px;margin-bottom:6px}',
      '.ca-item.sil{opacity:.55}',
      '.ca-item-topo{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px}',
      '.ca-tag{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.03em;background:var(--bg3);color:var(--text);padding:2px 7px;border-radius:4px}',
      '.ca-grav{font-size:11px;font-weight:600}',
      '.ca-sit-tag{font-size:10px;font-family:var(--mono);color:var(--muted)}',
      '.ca-data{margin-left:auto;color:var(--muted);font-family:var(--mono);font-size:11px}',
      '.ca-titulo{font-size:13px;color:var(--text);margin-top:5px;font-weight:500;word-break:break-word}',
      '.ca-resumo{font-size:12px;color:var(--muted);margin-top:2px;word-break:break-word}',
      '.ca-acoes{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center}',
      '.ca-acoes .btn{font-size:11px;padding:4px 10px}',
      '.ca-vazio{font-size:13px;color:var(--muted);padding:18px 4px;text-align:center}',
      '.ca-vazio.ok{color:var(--success)}',
      '.ca-sw{position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0}',
      '.ca-sw input{position:absolute;opacity:0;width:0;height:0}',
      '.ca-sw span{position:absolute;inset:0;background:#C9CFD9;border-radius:20px;transition:background .15s;cursor:pointer}',
      '.ca-sw span:before{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;background:#fff;border-radius:50%;transition:transform .15s;box-shadow:var(--shadow-sm)}',
      '.ca-sw input:checked+span{background:var(--gs-blue)}',
      '.ca-sw input:checked+span:before{transform:translateX(16px)}',
      '.ca-sw input:disabled+span{opacity:.45;cursor:not-allowed}',
      '.ca-sw input:focus-visible+span{outline:2px solid var(--gs-blue);outline-offset:2px}',
      '.ca-pref-nota{font-size:12px;color:var(--muted);margin-bottom:12px}',
      '.ca-pref-geral{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:10px;background:var(--bg3);margin-bottom:12px;font-size:13px}',
      '.ca-pref-area{border:1px solid var(--border2);border-radius:10px;padding:8px 14px;margin-bottom:10px}',
      '.ca-pref-area.off{opacity:.55}',
      '.ca-pref-cab{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;font-size:13px;font-weight:600;border-bottom:1px solid var(--border)}',
      '.ca-pref-tipos{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));column-gap:28px}',
      '.ca-pref-linha{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;font-size:13px;color:var(--text)}',
      '.ca-pref-rodape{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}',
      '@media (max-width:640px){',
      '.ca-barra,.ca-barra select{width:100%}',
      '.ca-barra .btn{flex:1}',
      '.ca-areas{grid-template-columns:repeat(2,minmax(0,1fr))}',
      '.ca-area-total{font-size:22px}',
      '.ca-filtros select,.ca-filtros input{flex:1 1 100%;min-width:0}',
      '.ca-silenc{margin-left:0}',
      '.ca-data{margin-left:0;width:100%}',
      '}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // 4. Item no menu (logo abaixo do Dashboard) e a tela (depois do painel do Dashboard).
  function criarMenu() {
    if (document.getElementById('nav-' + PAINEL)) return;
    var ref = null;
    document.querySelectorAll('.nav-item').forEach(function (el) {
      if (!ref && (el.getAttribute('onclick') || '').indexOf("showPanel('dashboard')") >= 0) ref = el;
    });
    if (!ref) return;
    var item = document.createElement('div');
    item.className = 'nav-item';
    item.id = 'nav-' + PAINEL;
    item.style.display = 'none';
    item.setAttribute('onclick', "showPanel('" + PAINEL + "')");
    item.innerHTML = '<span class="nav-icon">◎</span> Central de alertas';
    ref.insertAdjacentElement('afterend', item);
  }

  function criarPainel() {
    if (document.getElementById('panel-' + PAINEL)) return;
    var dash = document.getElementById('panel-dashboard');
    if (!dash) return;
    var p = document.createElement('div');
    p.className = 'panel';
    p.id = 'panel-' + PAINEL;
    p.innerHTML = ''
      + '<div class="card">'
      +   '<div class="card-header" style="flex-wrap:wrap;gap:10px"><span class="card-title">Alertas da carteira</span>'
      +     '<div class="ca-barra">'
      +       '<select id="ca-carteira" aria-label="Carteira"><option value="meus">Meus condomínios</option></select>'
      +       '<button class="btn btn-ghost" id="ca-atualizar" type="button" title="Calcula de novo agora">Atualizar</button>'
      +       '<button class="btn btn-ghost" id="ca-meus" type="button" style="display:none">Meus alertas</button>'
      +     '</div></div>'
      +   '<div id="ca-info" class="ca-info"></div>'
      +   '<div id="ca-areas" class="ca-areas"></div>'
      +   '<div class="ca-filtros">'
      +     '<select id="ca-f-tipo" aria-label="Tipo"><option value="">Todos os tipos</option></select>'
      +     '<input type="search" id="ca-f-cond" placeholder="Buscar condomínio" list="ca-cond-lista" autocomplete="off" aria-label="Condomínio">'
      +     '<datalist id="ca-cond-lista"></datalist>'
      +     '<select id="ca-f-grav" aria-label="Gravidade"><option value="">Todas as gravidades</option><option value="alta">Alta</option><option value="media">Média</option><option value="baixa">Baixa</option></select>'
      +     '<div class="ca-sit" id="ca-f-sit" role="group" aria-label="Situação">'
      +       '<button type="button" class="chip" data-ca-sit="novo">Novo</button>'
      +       '<button type="button" class="chip" data-ca-sit="visto">Visto</button>'
      +       '<button type="button" class="chip" data-ca-sit="resolvido">Resolvido</button>'
      +     '</div>'
      +     '<button class="btn btn-ghost ca-silenc" id="ca-silenciados" type="button" style="display:none"></button>'
      +   '</div>'
      + '</div>'
      + '<div class="card" id="ca-pref" style="display:none"></div>'
      + '<div class="card"><div id="ca-lista"><div class="ca-vazio">Carregando...</div></div></div>';
    dash.insertAdjacentElement('afterend', p);
    ligarEventos();
    pintarSituacao();
  }

  // 5. Estado da tela.
  var est = {
    seq: 0, dados: null, alertas: [], carregando: false, erro: '', carteirasOk: false, auto: 0, timer: null,
    f: { area: '', tipo: '', grav: '', cond: '', sit: { novo: true, visto: true, resolvido: false } },
    verSil: false,
    pref: null, prefRasc: null, prefAberto: false, prefPedido: false
  };

  function ligarEventos() {
    var $ = function (id) { return document.getElementById(id); };
    $('ca-carteira').addEventListener('change', function () {
      try { localStorage.setItem('ca_carteira', this.value); } catch (e) { /* só conveniência */ }
      carregar(false);
    });
    $('ca-atualizar').addEventListener('click', function () { carregar(true); });
    $('ca-meus').addEventListener('click', function () { alternarPref(); });
    $('ca-f-tipo').addEventListener('change', function () { est.f.tipo = this.value; renderTudo(); });
    $('ca-f-grav').addEventListener('change', function () { est.f.grav = this.value; renderTudo(); });
    $('ca-f-cond').addEventListener('input', function () { est.f.cond = this.value; renderTudo(); });
    $('ca-f-sit').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-ca-sit]');
      if (!b) return;
      var k = b.getAttribute('data-ca-sit');
      var novo = !est.f.sit[k];
      // Pelo menos uma situação fica marcada, senão a lista ficaria sempre vazia.
      if (!novo && Object.keys(est.f.sit).filter(function (x) { return est.f.sit[x]; }).length <= 1) return;
      est.f.sit[k] = novo;
      pintarSituacao();
      renderTudo();
    });
    $('ca-silenciados').addEventListener('click', function () { est.verSil = !est.verSil; renderTudo(); });
    $('ca-areas').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-ca-area]');
      if (!b) return;
      var k = b.getAttribute('data-ca-area');
      est.f.area = est.f.area === k ? '' : k;
      renderTudo();
    });
    $('ca-lista').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-ca-acao]');
      if (!b) return;
      ev.preventDefault();
      var a = est.alertas[Number(b.getAttribute('data-ca-i'))];
      if (!a) return;
      var acao = b.getAttribute('data-ca-acao');
      if (acao === 'abrir') abrirAlerta(a); else marcar(a, acao, b);
    });
  }

  function pintarSituacao() {
    document.querySelectorAll('#ca-f-sit [data-ca-sit]').forEach(function (b) {
      var on = !!est.f.sit[b.getAttribute('data-ca-sit')];
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // 6. Carteiras (o GESTOR escolhe entre os grupos; os outros veem só os condomínios deles).
  async function carregarCarteiras() {
    var sel = document.getElementById('ca-carteira');
    if (!sel || est.carteirasOk) return;
    var lembrada = '';
    try { lembrada = localStorage.getItem('ca_carteira') || ''; } catch (e) { /* sem memória do navegador */ }
    if (window.USER_ROLE !== 'GESTOR') { est.carteirasOk = true; sel.style.display = 'none'; return; }
    try {
      var r = await apiAuthFetch('/api/carteiras');
      var g = await r.json().catch(function () { return []; });
      if (!r.ok) return;
      est.carteirasOk = true;
      (Array.isArray(g) ? g : []).forEach(function (c) {
        if (!c || !c.id) return;
        var o = document.createElement('option');
        o.value = String(c.id);
        o.textContent = c.nome + ' (' + (c.quantidade || (c.condominios || []).length) + ')';
        sel.appendChild(o);
      });
      if (lembrada && Array.prototype.some.call(sel.options, function (o) { return o.value === lembrada; })) sel.value = lembrada;
    } catch (e) { /* sem carteiras agora: fica só "Meus condomínios" e tenta de novo na próxima abertura */ }
  }

  // 7. Leitura dos alertas. A rota pode responder 202 enquanto calcula: espera e tenta de novo.
  async function pegar(url, seq) {
    for (var t = 0; t < 40; t++) {
      var r = await apiAuthFetch(url);
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 202) {
        if (seq !== est.seq) throw new Error('cancelado');
        info('Calculando os alertas da carteira (na primeira vez pode levar alguns minutos)' + '.'.repeat(1 + (t % 3)));
        await new Promise(function (ok) { setTimeout(ok, 6000); });
        if (seq !== est.seq) throw new Error('cancelado');
        continue;
      }
      if (r.status === 404) throw new Error(INDISPONIVEL);
      if (r.status === 403) throw new Error(j.detalhe || 'Você não tem acesso à Central de alertas.');
      if (!r.ok) throw new Error(j.detalhe || ('Não foi possível carregar os alertas agora (' + r.status + ').'));
      return j;
    }
    throw new Error('O cálculo está demorando mais que o normal. Tente de novo em alguns minutos.');
  }

  function info(texto) {
    var el = document.getElementById('ca-info');
    if (el) el.innerHTML = '<span>' + esc(texto) + '</span>';
  }

  async function carregar(forcar, silencioso) {
    if (!window.AUTH_TOKEN || !podeVer()) return;
    criarPainel();
    clearTimeout(est.timer);
    if (!silencioso) est.auto = 0;
    await carregarCarteiras();
    var sel = document.getElementById('ca-carteira');
    var carteira = sel && sel.value ? sel.value : 'meus';
    var seq = ++est.seq;
    est.carregando = true;
    if (!silencioso) {
      info('Carregando...');
      if (!est.dados) document.getElementById('ca-lista').innerHTML = '<div class="ca-vazio">Carregando...</div>';
    }
    var btn = document.getElementById('ca-atualizar');
    if (btn && !silencioso) btn.disabled = true;
    try {
      var j = await pegar('/api/central-alertas?carteira=' + encodeURIComponent(carteira) + '&forcar=' + (forcar ? '1' : '0'), seq);
      if (seq !== est.seq) return;
      est.erro = '';
      receber(j);
      // Enquanto o servidor ainda calcula em segundo plano, lê de novo sozinho de vez em quando.
      if (j.atualizando && est.auto < 10) {
        est.auto++;
        est.timer = setTimeout(function () { if (ativo() && seq === est.seq) carregar(false, true); }, 20000);
      }
    } catch (e) {
      if (seq !== est.seq || e.message === 'cancelado') return;
      if (silencioso && est.dados) return; // mantém o que já está na tela
      est.erro = e.message || 'Não foi possível carregar os alertas agora.';
      est.dados = null; est.alertas = [];
      info('');
      document.getElementById('ca-areas').innerHTML = '';
      document.getElementById('ca-lista').innerHTML = '<div class="ca-vazio">' + esc(est.erro) + '</div>';
      atualizarBotaoSil(0);
    } finally {
      if (seq === est.seq) { est.carregando = false; if (btn) btn.disabled = false; }
    }
  }

  // Normaliza o que veio do servidor uma vez, para os filtros ficarem simples.
  function receber(j) {
    est.dados = j || {};
    est.alertas = (Array.isArray(j.alertas) ? j.alertas : []).map(function (a) {
      a = a || {};
      return {
        origem: a.origem || 'condominio', area: a.area || 'outros', tipo: a.tipo || '', rotulo: a.rotulo || ROTULO[a.tipo] || a.tipo || 'Alerta',
        gravidade: normGrav(a.gravidade), id_superlogica: a.id_superlogica != null ? String(a.id_superlogica) : '',
        condominio: a.condominio || '', titulo: a.titulo || '', resumo: a.resumo || '',
        status: a.origem === 'condominio' || !a.origem ? normSit(a.status) : 'novo',
        alerta_id: a.alerta_id || '', link: a.link || '', data: a.data || '', silenciado: a.silenciado === true
      };
    });
    if (est.f.area && !areasPresentes().some(function (x) { return x === est.f.area; })) est.f.area = '';
    var dl = document.getElementById('ca-cond-lista');
    if (dl) {
      var nomes = {};
      (j.condominios || []).forEach(function (c) { if (c && c.nome) nomes[c.nome] = 1; });
      est.alertas.forEach(function (a) { if (a.condominio) nomes[a.condominio] = 1; });
      dl.innerHTML = Object.keys(nomes).sort(function (x, y) { return x.localeCompare(y, 'pt-BR'); }).map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
    }
    renderTudo();
  }

  function ativo() { var p = document.getElementById('panel-' + PAINEL); return !!(p && p.classList.contains('active')); }

  // 8. Filtros. "ignorar" deixa de lado um filtro (para os contadores das áreas e a lista de tipos).
  function passa(a, ignorar) {
    ignorar = ignorar || {};
    if (!ignorar.area && est.f.area && a.area !== est.f.area) return false;
    if (!ignorar.tipo && est.f.tipo && a.tipo !== est.f.tipo) return false;
    if (!ignorar.grav && est.f.grav && a.gravidade !== est.f.grav) return false;
    if (!ignorar.cond && est.f.cond && semAcento(a.condominio).indexOf(semAcento(est.f.cond.trim())) < 0) return false;
    if (!ignorar.sit && !est.f.sit[a.status]) return false;
    return true;
  }

  function areasPresentes() {
    var lista = [];
    ((est.dados && est.dados.areas) || []).forEach(function (x) { if (x && x.area && lista.indexOf(x.area) < 0) lista.push(x.area); });
    est.alertas.forEach(function (a) { if (lista.indexOf(a.area) < 0) lista.push(a.area); });
    // Áreas que o servidor não listou entram na ordem conhecida, as outras no fim.
    var doServidor = ((est.dados && est.dados.areas) || []).length;
    if (!doServidor) lista.sort(function (x, y) { return pos(x) - pos(y); });
    return lista;
  }
  function pos(k) { var i = ORDEM_AREA.indexOf(k); return i < 0 ? 99 : i; }

  function renderTudo() {
    if (!document.getElementById('ca-lista')) return;
    if (!est.dados) return;
    renderInfo();
    renderAreas();
    renderTipos();
    renderLista();
  }

  function renderInfo() {
    var j = est.dados;
    var el = document.getElementById('ca-info');
    if (!el) return;
    var partes = [];
    if (j.gerado_em) partes.push('<span>Calculado em ' + esc(horaBR(j.gerado_em)) + '.</span>');
    var n = (j.condominios || []).length;
    if (n) partes.push('<span>' + n + ' condomínio' + (n > 1 ? 's' : '') + ' na carteira.</span>');
    if (j.atualizando) partes.push('<span class="ca-pill"><i></i>Atualizando em segundo plano</span>');
    var f = Array.isArray(j.falhas) ? j.falhas : [];
    if (f.length) partes.push('<span class="ca-aviso">Atenção: ' + f.length + ' leitura' + (f.length > 1 ? 's falharam' : ' falhou') + '; os números podem estar incompletos.</span>');
    el.innerHTML = partes.join('');
  }

  function renderAreas() {
    var el = document.getElementById('ca-areas');
    var html = areasPresentes().map(function (k) {
      var c = { total: 0, alta: 0, media: 0, baixa: 0, sil: 0 };
      est.alertas.forEach(function (a) {
        if (a.area !== k || !passa(a, { area: 1, tipo: 1, grav: 1 })) return;
        if (a.silenciado) { c.sil++; return; }
        c.total++; c[a.gravidade]++;
      });
      var sel = est.f.area === k;
      return '<button type="button" class="ca-area' + (sel ? ' sel' : '') + '" data-ca-area="' + esc(k) + '" aria-pressed="' + sel + '" title="' + (sel ? 'Tirar o filtro' : 'Ver só esta área') + '">'
        + '<div class="ca-area-nome">' + esc(nomeArea(k)) + '</div>'
        + '<div class="ca-area-total">' + c.total + '</div>'
        + '<div class="ca-area-grav">'
        +   '<span><span class="ca-dot" style="background:' + COR.alta + '"></span>' + c.alta + ' alta</span>'
        +   '<span><span class="ca-dot" style="background:' + COR.media + '"></span>' + c.media + ' média</span>'
        +   '<span><span class="ca-dot" style="background:' + COR.baixa + '"></span>' + c.baixa + ' baixa</span>'
        + '</div>'
        + (c.sil ? '<div class="ca-area-sil">' + c.sil + ' silenciado' + (c.sil > 1 ? 's' : '') + '</div>' : '')
        + '</button>';
    }).join('');
    el.innerHTML = html;
  }

  function renderTipos() {
    var sel = document.getElementById('ca-f-tipo');
    var tipos = {};
    est.alertas.forEach(function (a) { if (a.tipo && (!est.f.area || a.area === est.f.area)) tipos[a.tipo] = a.rotulo; });
    if (est.f.tipo && !tipos[est.f.tipo]) est.f.tipo = '';
    sel.innerHTML = '<option value="">Todos os tipos</option>' + Object.keys(tipos)
      .sort(function (x, y) { return String(tipos[x]).localeCompare(String(tipos[y]), 'pt-BR'); })
      .map(function (k) { return '<option value="' + esc(k) + '"' + (k === est.f.tipo ? ' selected' : '') + '>' + esc(tipos[k]) + '</option>'; }).join('');
  }

  function atualizarBotaoSil(n) {
    var b = document.getElementById('ca-silenciados');
    if (!b) return;
    if (!n && !est.verSil) { b.style.display = 'none'; return; }
    b.style.display = '';
    b.textContent = est.verSil ? 'Esconder silenciados (' + n + ')' : 'Silenciados (' + n + ')';
    b.setAttribute('aria-pressed', est.verSil ? 'true' : 'false');
  }

  function renderLista() {
    var el = document.getElementById('ca-lista');
    var nSil = 0;
    var vis = [];
    est.alertas.forEach(function (a, i) {
      if (!passa(a)) return;
      if (a.silenciado) { nSil++; if (!est.verSil) return; }
      vis.push(i);
    });
    atualizarBotaoSil(nSil);
    if (!vis.length) {
      var s = est.f.sit;
      var filtrando = est.f.area || est.f.tipo || est.f.grav || est.f.cond.trim() || !(s.novo && s.visto && !s.resolvido);
      var algum = est.alertas.some(function (a) { return !a.silenciado && a.status !== 'resolvido'; });
      el.innerHTML = filtrando && algum
        ? '<div class="ca-vazio">Nenhum alerta com esses filtros.</div>'
        : '<div class="ca-vazio ok">Nenhum alerta aberto na carteira.</div>';
      return;
    }
    // Agrupa por condomínio; quem tem mais alertas de gravidade alta vem primeiro.
    var grupos = {};
    var ordem = [];
    vis.forEach(function (i) {
      var a = est.alertas[i];
      var k = a.id_superlogica || a.condominio || 'sem';
      if (!grupos[k]) { grupos[k] = { nome: a.condominio || (a.id_superlogica ? 'Código ' + a.id_superlogica : 'Sem condomínio'), itens: [], alta: 0 }; ordem.push(k); }
      grupos[k].itens.push(i);
      if (a.gravidade === 'alta' && !a.silenciado) grupos[k].alta++;
    });
    ordem.sort(function (x, y) {
      var gx = grupos[x], gy = grupos[y];
      return gy.alta - gx.alta || gy.itens.length - gx.itens.length || gx.nome.localeCompare(gy.nome, 'pt-BR');
    });
    var feitos = 0;
    var html = '';
    ordem.forEach(function (k) {
      if (feitos >= MAX_LISTA) return;
      var g = grupos[k];
      g.itens.sort(function (x, y) {
        var a = est.alertas[x], b = est.alertas[y];
        return (a.silenciado - b.silenciado) || (ORDEM_GRAV[a.gravidade] - ORDEM_GRAV[b.gravidade]) || String(b.data).localeCompare(String(a.data));
      });
      html += '<div class="ca-grupo"><div class="ca-grupo-cab"><b>' + esc(g.nome) + '</b>'
        + '<span class="ca-cont">' + g.itens.length + ' alerta' + (g.itens.length > 1 ? 's' : '') + '</span>'
        + (g.alta ? '<span class="ca-cont alta">' + g.alta + ' alta' + (g.alta > 1 ? 's' : '') + '</span>' : '') + '</div>';
      g.itens.forEach(function (i) {
        if (feitos >= MAX_LISTA) return;
        feitos++;
        html += itemHtml(est.alertas[i], i);
      });
      html += '</div>';
    });
    if (vis.length > MAX_LISTA) html += '<div class="hint" style="margin-top:8px">Mostrando ' + MAX_LISTA + ' de ' + vis.length + '. Use os filtros para ver os outros.</div>';
    el.innerHTML = html;
  }

  function itemHtml(a, i) {
    var cor = COR[a.gravidade] || 'var(--muted)';
    var temSituacao = a.origem === 'condominio' && /^[0-9a-f-]{36}$/i.test(String(a.alerta_id));
    var botoes = '';
    if (temSituacao) {
      if (a.status === 'novo') botoes += '<button type="button" class="btn btn-ghost" data-ca-acao="visto" data-ca-i="' + i + '">Visto</button>';
      if (a.status !== 'resolvido') botoes += '<button type="button" class="btn btn-ghost" data-ca-acao="resolvido" data-ca-i="' + i + '">Resolvido</button>';
      else botoes += '<button type="button" class="btn btn-ghost" data-ca-acao="novo" data-ca-i="' + i + '">Reabrir</button>';
    }
    botoes += '<button type="button" class="btn btn-primary" data-ca-acao="abrir" data-ca-i="' + i + '">Abrir</button>';
    return '<div class="ca-item' + (a.silenciado ? ' sil' : '') + '" style="border-left-color:' + cor + '">'
      + '<div class="ca-item-topo">'
      +   '<span class="ca-tag">' + esc(a.rotulo) + '</span>'
      +   '<span class="ca-grav" style="color:' + cor + '">' + esc(NOME_GRAV[a.gravidade]) + '</span>'
      +   (temSituacao ? '<span class="ca-sit-tag">· ' + esc(NOME_SIT[a.status]) + '</span>' : '')
      +   (a.silenciado ? '<span class="ca-sit-tag">· silenciado</span>' : '')
      +   (a.data ? '<span class="ca-data">' + esc(dataBR(a.data) || a.data) + '</span>' : '')
      + '</div>'
      + '<div class="ca-titulo">' + esc(a.titulo || a.rotulo) + '</div>'
      + (a.resumo ? '<div class="ca-resumo">' + esc(a.resumo) + '</div>' : '')
      + '<div class="ca-acoes">' + botoes + '</div>'
      + '</div>';
  }

  // 9. Situação (só alertas de origem condomínio, rota que o Dashboard já usa).
  async function marcar(a, status, btn) {
    if (['novo', 'visto', 'resolvido'].indexOf(status) < 0) return;
    if (!/^[0-9a-f-]{36}$/i.test(String(a.alerta_id))) return;
    if (btn) btn.disabled = true;
    try {
      var r = await apiAuthFetch('/api/alertas/' + a.alerta_id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
      a.status = normSit(j.status || status);
      renderTudo();
      avisar(status === 'novo' ? 'Alerta reaberto.' : status === 'visto' ? 'Alerta marcado como visto.' : 'Alerta marcado como resolvido.', 'ok');
    } catch (e) {
      if (btn) btn.disabled = false;
      avisar('Não foi possível atualizar o alerta: ' + e.message, 'err');
    }
  }

  // 10. Abrir: link do alerta ou o condomínio no topo e a tela onde o alerta é tratado.
  function destinoDe(a) {
    var l = String(a.link || '');
    var m = l.match(/^#?(?:painel[=:])?([a-z]+)$/i);
    if (m && typeof PAGE_META !== 'undefined' && PAGE_META[m[1]]) return m[1];
    if (a.origem === 'financeiro') return 'fincontrole';
    if (a.origem === 'seguranca') return 'seguranca';
    return DESTINO[a.tipo] || 'dashboard';
  }

  async function ativarCondominio(a) {
    var id = a.id_superlogica;
    if (!/^\d+$/.test(id)) return true;
    var atual = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
    if (atual && String(atual.id_superlogica || '') === id) return true;
    var lista = null;
    if (window.CondSeletor) {
      try { lista = await CondSeletor.carregar(); } catch (e) { lista = null; }
      lista = lista || CondSeletor.lista() || [];
    }
    var c = (lista || []).find(function (x) { return x && String(x.id_superlogica || '') === id; });
    if (!c) { avisar('Esse condomínio não está na sua lista do topo; abra por lá se precisar.', 'warn'); return true; }
    if (typeof setCondominioAtivo !== 'function') return true;
    return setCondominioAtivo({ id: c.id, nome: c.nome, id_superlogica: c.id_superlogica }) !== false;
  }

  async function abrirAlerta(a) {
    var ext = linkSeguro(a.link);
    if (ext) { window.open(ext, '_blank', 'noopener,noreferrer'); return; }
    var destino = destinoDe(a);
    if (destino !== 'seguranca' && !(await ativarCondominio(a))) return;
    if (typeof window.podeAbrirPainel === 'function' && !window.podeAbrirPainel(destino)) {
      avisar('Você não tem acesso à tela onde esse alerta é tratado.', 'warn');
      return;
    }
    showPanel(destino);
    if (destino === 'fincontrole' && typeof window.finAbrirCondominio === 'function' && /^\d+$/.test(a.id_superlogica)) {
      window.finAbrirCondominio(a.id_superlogica, a.condominio);
    }
  }

  // 11. Meus alertas: liga e desliga por tipo, por área e "Pausar todos". Só para quem pode silenciar.
  async function carregarPref() {
    est.prefPedido = true;
    var b = document.getElementById('ca-meus');
    try {
      var r = await apiAuthFetch('/api/alertas/preferencias');
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j || j.pode_silenciar !== true) { est.pref = null; if (b) b.style.display = 'none'; fecharPref(); return; }
      est.pref = {
        silenciados: Array.isArray(j.silenciados) ? j.silenciados.map(String) : [],
        pausado: j.pausado === true,
        tipos: (Array.isArray(j.tipos) ? j.tipos : []).filter(function (t) { return t && t.tipo; })
      };
      if (b) b.style.display = '';
    } catch (e) {
      est.prefPedido = false; // tenta de novo na próxima abertura
      if (b) b.style.display = 'none';
    }
  }

  function alternarPref() { if (est.prefAberto) fecharPref(); else abrirPref(); }
  function fecharPref() {
    est.prefAberto = false; est.prefRasc = null;
    var c = document.getElementById('ca-pref');
    if (c) { c.style.display = 'none'; c.innerHTML = ''; }
    var b = document.getElementById('ca-meus');
    if (b) { b.classList.remove('btn-primary'); b.classList.add('btn-ghost'); }
  }
  function abrirPref() {
    if (!est.pref) return;
    est.prefAberto = true;
    est.prefRasc = { sil: {}, pausado: est.pref.pausado };
    est.pref.silenciados.forEach(function (t) { est.prefRasc.sil[t] = true; });
    var b = document.getElementById('ca-meus');
    if (b) { b.classList.remove('btn-ghost'); b.classList.add('btn-primary'); }
    renderPref();
    var c = document.getElementById('ca-pref');
    if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function chave(attr, valor, ligado, desab, rotulo) {
    return '<label class="ca-sw" title="' + esc(rotulo) + '"><input type="checkbox" ' + attr + '="' + esc(valor) + '"' + (ligado ? ' checked' : '') + (desab ? ' disabled' : '')
      + ' aria-label="' + esc(rotulo) + '"><span></span></label>';
  }

  function renderPref() {
    var c = document.getElementById('ca-pref');
    if (!c || !est.prefRasc) return;
    var rs = est.prefRasc;
    var porArea = {};
    var areas = [];
    est.pref.tipos.forEach(function (t) {
      var k = t.area || 'outros';
      if (!porArea[k]) { porArea[k] = []; areas.push(k); }
      porArea[k].push(t);
    });
    areas.sort(function (x, y) { return pos(x) - pos(y); });
    var html = '<div class="card-header" style="flex-wrap:wrap;gap:8px"><span class="card-title">Meus alertas</span></div>'
      + '<div class="ca-pref-nota">Desligar só esconde para você. O alerta continua sendo gerado e aparece para a equipe. '
      + 'Os desligados somem do Dashboard, do painel Financeiro e da contagem desta tela, e ficam em "Silenciados".</div>'
      + '<div class="ca-pref-geral"><div><b>Pausar todos</b><div style="font-size:12px;color:var(--muted)">Esconde todos os alertas para você até ligar de novo.</div></div>'
      + chave('data-ca-pausa', '1', rs.pausado, false, 'Pausar todos') + '</div>';
    if (!areas.length) html += '<div class="ca-vazio">Nenhum tipo de alerta disponível.</div>';
    areas.forEach(function (k) {
      var tipos = porArea[k];
      var todosLigados = tipos.every(function (t) { return !rs.sil[t.tipo]; });
      html += '<div class="ca-pref-area' + (rs.pausado ? ' off' : '') + '"><div class="ca-pref-cab"><span>' + esc(NOME_AREA[k] || nomeArea(k)) + '</span>'
        + chave('data-ca-parea', k, todosLigados, rs.pausado, 'Área ' + (NOME_AREA[k] || nomeArea(k)) + ' inteira') + '</div><div class="ca-pref-tipos">';
      tipos.forEach(function (t) {
        var rot = t.rotulo || ROTULO[t.tipo] || t.tipo;
        html += '<div class="ca-pref-linha"><span>' + esc(rot) + '</span>' + chave('data-ca-ptipo', t.tipo, !rs.sil[t.tipo], rs.pausado, rot) + '</div>';
      });
      html += '</div></div>';
    });
    html += '<div class="ca-pref-rodape"><button type="button" class="btn btn-primary" id="ca-pref-salvar">Salvar</button>'
      + '<button type="button" class="btn btn-ghost" id="ca-pref-cancelar">Cancelar</button></div>';
    c.innerHTML = html;
    c.style.display = '';
    c.querySelectorAll('input[type=checkbox]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        if (inp.hasAttribute('data-ca-pausa')) rs.pausado = inp.checked;
        else if (inp.hasAttribute('data-ca-parea')) {
          var k = inp.getAttribute('data-ca-parea');
          (porArea[k] || []).forEach(function (t) { if (inp.checked) delete rs.sil[t.tipo]; else rs.sil[t.tipo] = true; });
        } else if (inp.hasAttribute('data-ca-ptipo')) {
          var tp = inp.getAttribute('data-ca-ptipo');
          if (inp.checked) delete rs.sil[tp]; else rs.sil[tp] = true;
        }
        renderPref();
      });
    });
    document.getElementById('ca-pref-salvar').addEventListener('click', salvarPref);
    document.getElementById('ca-pref-cancelar').addEventListener('click', fecharPref);
  }

  async function salvarPref() {
    var rs = est.prefRasc;
    if (!rs) return;
    var btn = document.getElementById('ca-pref-salvar');
    if (btn) btn.disabled = true;
    var corpo = { silenciados: Object.keys(rs.sil).filter(function (k) { return rs.sil[k]; }), pausado: !!rs.pausado };
    try {
      var r = await apiAuthFetch('/api/alertas/preferencias', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 403) throw new Error('você não tem permissão para silenciar alertas');
      if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
      est.pref.silenciados = Array.isArray(j.silenciados) ? j.silenciados.map(String) : corpo.silenciados;
      est.pref.pausado = typeof j.pausado === 'boolean' ? j.pausado : corpo.pausado;
      fecharPref();
      avisar('Preferências salvas.', 'ok');
      carregar(false);
    } catch (e) {
      if (btn) btn.disabled = false;
      avisar('Não foi possível salvar: ' + e.message, 'err');
    }
  }

  // 12. Abertura da tela e visibilidade do item no menu.
  function abrirTela() {
    if (!podeVer() || !window.AUTH_TOKEN) return;
    criarPainel();
    if (!est.prefPedido) carregarPref();
    carregar(false);
  }

  function aplicarVisibilidade() {
    var item = document.getElementById('nav-' + PAINEL);
    var pode = podeVer();
    if (item) item.style.display = pode ? '' : 'none';
    if (!window.USER_PERMS) return;
    if (!pode && ativo() && typeof window.showPanel === 'function') window.showPanel('dashboard');
    // Pedido guardado (recarregou a página nesta tela antes das permissões chegarem).
    if (est.pendente && pode) { est.pendente = false; window.showPanel(PAINEL); }
    else if (est.pendente && !pode) est.pendente = false;
  }

  injetarEstilo();
  criarMenu();
  criarPainel();
  try { est.pendente = localStorage.getItem('sh_active_panel') === PAINEL; } catch (e) { est.pendente = false; }

  if (typeof window.showPanel === 'function') {
    var origShow = window.showPanel;
    window.showPanel = function (nome) {
      // Sem permissão (ou antes de carregar as permissões) abre o Dashboard e guarda o pedido.
      if (nome === PAINEL && !podeVer()) {
        if (!window.USER_PERMS) est.pendente = true;
        return origShow.call(this, 'dashboard');
      }
      if (nome !== PAINEL && nome !== 'dashboard') est.pendente = false;
      var r = origShow.apply(this, arguments);
      if (ativo()) abrirTela(); else clearTimeout(est.timer);
      return r;
    };
  }
  if (typeof window.aplicarPermissoesSidebar === 'function') {
    var origPerm = window.aplicarPermissoesSidebar;
    window.aplicarPermissoesSidebar = function () {
      var r = origPerm.apply(this, arguments);
      aplicarVisibilidade();
      return r;
    };
  }
  document.addEventListener('auth:ready', function () { setTimeout(function () { aplicarVisibilidade(); if (ativo()) abrirTela(); }, 0); });
  if (window.USER_PERMS) aplicarVisibilidade();

  // 13. Acesso de fora (Dashboard, Seu dia e outros cartões podem chamar).
  window.CentralAlertas = {
    abrir: function () {
      if (!podeVer()) return false;
      if (!ativo()) window.showPanel(PAINEL); else abrirTela();
      return true;
    },
    atualizar: function () { if (podeVer()) carregar(true); }
  };
})();
