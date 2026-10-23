// ============================================================
// FINANCEIRO (T31): painel geral: quadro da carteira com os condomínios ordenados pela gravidade
// dos alertas, alertas de cada condomínio com link para o lançamento e pré balancete (o que
// impede fechar o mês). Só leitura. T37: a conferência dos boletos do mês fica no item Boletos
// do menu (tela panel-boletos, também neste arquivo); a Conciliação no item próprio.
// Rotas: /api/financeiro/resumo, /api/financeiro/condominio/:id/alertas,
// /api/financeiro/condominio/:id/pre-balancete, /api/financeiro/boletos/:id, /api/carteiras.
// Módulo "financeiro" (ver, pre_balancete) entra no catálogo de permissões aqui, sem mexer
// no catálogo original. O servidor confere tudo de novo: aqui é só o que aparece na tela.
// ============================================================
(function () {
  var PAINEL = 'fincontrole';

  // 1. Catálogo de permissões e título da aba.
  if (typeof MODULOS_CATALOGO !== 'undefined' && !MODULOS_CATALOGO.financeiro) {
    MODULOS_CATALOGO.financeiro = { label: 'Financeiro (painel, alertas e pré balancete)', acoes: ['ver', 'pre_balancete'] };
  }
  if (typeof PAGE_META !== 'undefined') PAGE_META[PAINEL] = { title: 'Financeiro', sub: 'painel da carteira: alertas e pré balancete' };

  // T37: falha fechada, mesma regra do menu (index.html, podeAbrirPainel).
  function podeAbrir(nome) { return typeof window.podeAbrirPainel === 'function' && window.podeAbrirPainel(nome); }
  function podeVer() { return podeAbrir(PAINEL); }
  function podePre() {
    if (!podeVer()) return false;
    if (window.USER_ROLE === 'GESTOR') return true;
    return typeof temPermissao === 'function' && !!window.USER_PERMS && temPermissao('financeiro', 'pre_balancete');
  }

  // 2. Item no menu, logo depois de Cobrança.
  function criarMenu() {
    if (document.getElementById('nav-fincontrole')) return;
    var ref = null;
    document.querySelectorAll('.nav-item').forEach(function (el) {
      if ((el.getAttribute('onclick') || '').indexOf("showPanel('cobranca')") >= 0) ref = el;
    });
    if (!ref) return;
    var item = document.createElement('div');
    item.className = 'nav-item';
    item.id = 'nav-fincontrole';
    item.style.display = 'none';
    item.setAttribute('onclick', "showPanel('" + PAINEL + "')");
    item.innerHTML = '<span class="nav-icon">◇</span> Financeiro';
    ref.insertAdjacentElement('afterend', item);
  }
  criarMenu();

  // Visibilidade do item: aplicarVisibilidadePaineisFinanceiros (index.html) cuida de todos.
  function aplicarVisibilidade() {
    if (typeof window.aplicarVisibilidadePaineisFinanceiros === 'function') window.aplicarVisibilidadePaineisFinanceiros();
  }
  function ativo(nome) { var p = document.getElementById('panel-' + nome); return !!(p && p.classList.contains('active')); }
  // Depois de abrir: o próprio showPanel do index.html já recusa sem permissão.
  function aoAbrir() {
    if (ativo(PAINEL) && podeVer()) { finAbrir().then(abrirComGuardado); atalhos(); }
    if (ativo('boletos') && podeAbrir('boletos')) boletosAbrir();
  }
  if (typeof window.showPanel === 'function') {
    var origShow = window.showPanel;
    window.showPanel = function () {
      var r = origShow.apply(this, arguments);
      aoAbrir();
      return r;
    };
  }
  document.addEventListener('auth:ready', function () {
    setTimeout(function () { aplicarVisibilidade(); aoAbrir(); }, 0);
  });

  // 3. Utilitários.
  var est = { aberto: false, seqQ: 0, seqD: 0, cond: null, alertas: null, aba: 'alertas', verSilDet: false };
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function horaBR(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function mesISO(delta) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + delta); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  var COR = { alta: 'var(--danger)', media: 'var(--warning)', baixa: 'var(--muted)' };
  var NOME_GRAV = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
  // Celula de texto livre: quebra em ate 2 linhas (td-livre e td-2l no index.html) e o texto inteiro
  // fica no title. Sem isso fornecedor ou detalhe longo invadia a coluna vizinha e abria rolagem lateral.
  // texto e sub chegam crus; sub vira uma segunda linha menor. estilo e o atributo style da celula.
  function tdL(estilo, texto, sub, extraHtml) {
    texto = texto == null ? '' : String(texto);
    return '<td ' + estilo + ' class="td-livre" title="' + esc(texto + (sub ? '\n' + sub : '')) + '"><div class="td-2l">' + esc(texto) + (extraHtml || '') + '</div>'
      + (sub ? '<div class="td-2l" style="color:var(--muted);font-size:11px">' + esc(sub) + '</div>' : '') + '</td>';
  }
  function selo(g) {
    return '<span style="display:inline-block;min-width:52px;text-align:center;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:' + (COR[g] || 'var(--muted)') + '">' + esc(NOME_GRAV[g] || g) + '</span>';
  }
  function msg(id, texto, erro) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = texto ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : '';
  }
  // GET com espera: a rota responde 202 enquanto a base da carteira está sendo calculada.
  async function pegar(url, aoEsperar, chave, seq) {
    for (var t = 0; t < 45; t++) {
      var r = await apiAuthFetch(url);
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 202) {
        if (chave && seq !== est[chave]) throw new Error('cancelado');
        if (aoEsperar) aoEsperar(t);
        await new Promise(function (ok) { setTimeout(ok, 6000); });
        continue;
      }
      if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
      return j;
    }
    throw new Error('O cálculo está demorando mais que o normal. Tente de novo em alguns minutos.');
  }
  function linkSeguro(u) { return /^https:\/\/[a-z0-9.-]+\.superlogica\.net\//i.test(String(u || '')) ? u : ''; }

  // 3a. Último resultado guardado na aba do navegador (sessionStorage). O cálculo da carteira
  // leva de segundos a minutos; guardando a última resposta, a tela abre na hora com ela e
  // atualiza por trás. Nunca mistura logins: guardamos só uma impressão curta do token (nunca o
  // token) e, se o token mudar (outro login, sair, renovação), apagamos tudo antes de ler.
  // Qualquer falha do navegador (modo privado, cota cheia, bloqueio) só desliga o atalho.
  var CACHE_PREFIXO = 'finTela:';
  var CACHE_MAX = 1500000; // resposta maior que isso não vale ocupar a cota da aba
  function impressaoLogin() {
    var s = String(window.AUTH_TOKEN || '');
    if (!s) return '';
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '.' + s.length.toString(36);
  }
  function cacheLimpar() {
    try {
      var apagar = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIXO) === 0) apagar.push(k);
      }
      apagar.forEach(function (k) { sessionStorage.removeItem(k); });
    } catch (e) { /* sem sessionStorage: nada a limpar */ }
  }
  // Confere se o que está guardado é deste login; se não for, apaga e assume o login atual.
  function cacheDoLogin() {
    try {
      var atual = impressaoLogin();
      if (sessionStorage.getItem(CACHE_PREFIXO + 'dono') !== atual) {
        cacheLimpar();
        if (atual) sessionStorage.setItem(CACHE_PREFIXO + 'dono', atual);
      }
      return !!atual;
    } catch (e) { return false; }
  }
  function cacheLer(chave) {
    try {
      if (!cacheDoLogin()) return null;
      var v = sessionStorage.getItem(CACHE_PREFIXO + chave);
      return v ? JSON.parse(v) : null;
    } catch (e) { return null; }
  }
  function cacheGravar(chave, dados) {
    try {
      if (!cacheDoLogin()) return;
      var v = JSON.stringify(dados);
      if (v.length > CACHE_MAX) return;
      sessionStorage.setItem(CACHE_PREFIXO + chave, v);
    } catch (e) { /* cota cheia ou bloqueado: segue sem guardar */ }
  }
  function chaveQuadro() { var sel = document.getElementById('fin-carteira'); return 'resumo:' + ((sel && sel.value) || 'meus'); }

  // 3b. Aviso de carregando no lugar do branco: faixas cinza claras (var(--bg3)) pulsando de leve.
  // O estilo entra uma vez só, aqui, para não mexer no index.html; quem pede menos movimento
  // no sistema (prefers-reduced-motion) recebe as faixas paradas.
  function estiloEsqueleto() {
    if (document.getElementById('tela-esqueleto-css')) return;
    var st = document.createElement('style');
    st.id = 'tela-esqueleto-css';
    st.textContent = '.tela-esqueleto{display:flex;flex-direction:column;gap:8px;padding:4px 0}'
      + '.tela-esqueleto span{display:block;height:14px;border-radius:8px;background:var(--bg3);animation:tela-esqueleto-pulso 1.2s ease-in-out infinite alternate}'
      + '@keyframes tela-esqueleto-pulso{from{opacity:1}to{opacity:.45}}'
      + '@media (prefers-reduced-motion: reduce){.tela-esqueleto span{animation:none}}';
    document.head.appendChild(st);
  }
  function esqueleto(id, linhas) {
    var el = document.getElementById(id);
    if (!el) return;
    estiloEsqueleto();
    var larg = [100, 92, 96, 88, 94, 90, 97, 86];
    var html = '';
    for (var i = 0; i < (linhas || 6); i++) html += '<span style="width:' + larg[i % larg.length] + '%"></span>';
    el.innerHTML = '<div class="tela-esqueleto" role="status" aria-label="Carregando">' + html + '</div>';
  }

  // 4. Abertura da aba: lista de carteiras (o GESTOR vê os grupos do Superlógica).
  async function finAbrir() {
    if (est.aberto || !window.AUTH_TOKEN) return;
    var sel = document.getElementById('fin-carteira');
    if (!sel) return;
    est.aberto = true;
    sel.innerHTML = '<option value="">Meus condomínios</option>';
    if (window.USER_ROLE === 'GESTOR') {
      try {
        var r = await apiAuthFetch('/api/carteiras');
        var g = await r.json().catch(function () { return []; });
        (Array.isArray(g) ? g : []).forEach(function (c) {
          if (!c || !c.id) return;
          var o = document.createElement('option');
          o.value = String(c.id);
          o.textContent = c.nome + ' (' + (c.quantidade || (c.condominios || []).length) + ')';
          sel.appendChild(o);
        });
      } catch (e) { /* sem carteiras agora: fica só "Meus condomínios" */ }
    }
    var pre = document.getElementById('fin-pre-acoes');
    if (pre) pre.style.display = podePre() ? '' : 'none';
  }
  window.finAbrir = finAbrir;

  // 4a. Resumo das outras telas financeiras (cada uma no seu item do menu, sem repetir aqui).
  // Só mostra o atalho de quem pode abrir; a Entrada mostra quantos rascunhos esperam.
  async function atalhos() {
    var el = document.getElementById('fin-atalhos');
    if (!el) return;
    var itens = [['boletos', 'Boletos', 'conferir os boletos do mês'], ['conciliacao', 'Conciliação', 'extrato x lançamentos'], ['entrada', 'Entrada de documentos', 'rascunhos para lançar']]
      .filter(function (x) { return podeAbrir(x[0]); });
    if (!itens.length) { el.innerHTML = ''; return; }
    el.innerHTML = 'Também no menu: ' + itens.map(function (x) {
      return '<a href="#" data-fin-ir="' + x[0] + '">' + esc(x[1]) + '</a> <span id="fin-atalho-' + x[0] + '">(' + esc(x[2]) + ')</span>';
    }).join(' · ');
    el.querySelectorAll('[data-fin-ir]').forEach(function (a) {
      a.addEventListener('click', function (ev) { ev.preventDefault(); showPanel(a.getAttribute('data-fin-ir')); });
    });
    if (!podeAbrir('entrada')) return;
    try {
      var r = await apiAuthFetch('/api/entrada/fila?status=rascunho');
      var j = await r.json().catch(function () { return {}; });
      var n = r.ok && Array.isArray(j.itens) ? j.itens.length : null;
      var s = document.getElementById('fin-atalho-entrada');
      if (s && n != null) s.textContent = '(' + (n ? n + ' rascunho(s) para conferir' : 'nenhum rascunho esperando') + ')';
    } catch (e) { /* sem a contagem agora: fica só o atalho */ }
  }

  // 5. Quadro da carteira.
  window.finCarregar = function (forcar) { return carregarQuadro(forcar, false); };

  // Carrega o quadro. Com resultado guardado desta carteira, ele aparece na hora com o aviso
  // "Atualizando" e a resposta nova substitui quando chegar; sem nada guardado, o esqueleto
  // ocupa o lugar do branco. silencioso: nova leitura de fundo enquanto o servidor recalcula
  // (não troca a tela por esqueleto nem mostra erro por cima do que já está certo).
  async function carregarQuadro(forcar, silencioso) {
    await finAbrir();
    var sel = document.getElementById('fin-carteira');
    var seq = ++est.seqQ;
    clearTimeout(est.timerQ);
    var chave = chaveQuadro();
    var q = [];
    if (sel && sel.value) q.push('carteira=' + encodeURIComponent(sel.value));
    if (forcar) q.push('forcar=1');
    var guardado = silencioso ? null : cacheLer(chave);
    if (guardado) renderQuadro(guardado, true);
    else if (!silencioso) { esqueleto('fin-quadro', 8); msg('fin-info', 'Carregando...'); }
    var mostrando = !!guardado || silencioso;
    try {
      var j = await pegar('/api/financeiro/resumo' + (q.length ? '?' + q.join('&') : ''), function (t) {
        if (seq === est.seqQ && !mostrando) msg('fin-info', 'Calculando os alertas de todos os condomínios (leva de 1 a 3 minutos na primeira vez)' + '.'.repeat(1 + (t % 3)));
      }, 'seqQ', seq);
      if (seq !== est.seqQ) return;
      // Releitura de fundo que trouxe o mesmo cálculo: não redesenha (manteria a tela piscando e
      // desfaria o que a pessoa abriu ou escolheu no quadro); só segue esperando o novo.
      if (!(silencioso && j.gerado_em === est.geradoQ && j.recalculando)) renderQuadro(j);
      est.geradoQ = j.gerado_em;
      cacheGravar(chave, j);
      agendarReleitura(j, seq, silencioso ? est.releiturasQ + 1 : 0);
    } catch (e) {
      if (seq !== est.seqQ || e.message === 'cancelado') return;
      if (silencioso) return;
      if (guardado) msg('fin-info', e.message + ' Mostrando o último resultado guardado.', true);
      else { document.getElementById('fin-quadro').innerHTML = ''; msg('fin-info', e.message, true); }
    }
  }
  // O servidor devolve a base anterior e recalcula por trás (recalculando:true): a tela relê
  // sozinha a cada 20 s, no máximo 9 vezes (3 minutos), enquanto a aba estiver aberta.
  function agendarReleitura(j, seq, n) {
    est.releiturasQ = n;
    if (!j || !j.recalculando || n >= 9) return;
    est.timerQ = setTimeout(function () {
      if (seq === est.seqQ && ativo(PAINEL)) carregarQuadro(false, true);
    }, 20000);
  }
  // Ao abrir a aba sem quadro na tela: se há resultado guardado desta carteira, mostra e atualiza.
  function abrirComGuardado() {
    var el = document.getElementById('fin-quadro');
    if (!el || el.innerHTML.trim() || !ativo(PAINEL) || !podeVer()) return;
    if (cacheLer(chaveQuadro())) carregarQuadro(false, false);
  }

  // T51: tipos que a pessoa silenciou em "Meus alertas". O resumo chega com os números de tudo;
  // o servidor marca o tipo em por_tipo[tipo].silenciado (ou manda a lista tipos_silenciados)
  // e aqui eles saem de Alta, Média, Baixa, Valor em alta e Principais.
  function semSilenciados(c, globais) {
    var g0 = c.por_gravidade || {};
    var g = { alta: g0.alta || 0, media: g0.media || 0, baixa: g0.baixa || 0 };
    var pt = c.por_tipo || {};
    var valor = Number(c.valor_alta) || 0, total = Number(c.total) || 0, sil = [], qtd = 0;
    Object.keys(pt).forEach(function (k) {
      var t = pt[k] || {};
      if (!(t.silenciado === true || globais.indexOf(k) >= 0)) return;
      sil.push(t);
      qtd += Number(t.total) || 0;
      ['alta', 'media', 'baixa'].forEach(function (n) { g[n] = Math.max(0, g[n] - (Number(t[n]) || 0)); });
      if (typeof t.valor_alta === 'number') valor -= t.valor_alta;
    });
    var tipos = Object.keys(pt).map(function (k) { return pt[k]; }).filter(function (t) { return sil.indexOf(t) < 0; });
    return Object.assign({}, c, { por_gravidade: g, valor_alta: Math.max(0, Math.round(valor * 100) / 100), total: Math.max(0, total - qtd), tiposVisiveis: tipos, tiposSil: sil, qtdSil: qtd });
  }
  function principais(tipos) {
    return tipos.slice().sort(function (a, b) { return b.alta - a.alta || b.total - a.total; }).slice(0, 3)
      .map(function (t) { return esc(t.descricao) + ' (' + t.total + ')'; }).join('; ');
  }

  // atualizando: é o resultado guardado na aba, mostrado enquanto a leitura nova não chega.
  function renderQuadro(j, atualizando) {
    var globais = Array.isArray(j.tipos_silenciados) ? j.tipos_silenciados.map(String) : [];
    var lista = (j.condominios || []).map(function (c) { return semSilenciados(c, globais); });
    var qtdSil = lista.reduce(function (s, c) { return s + c.qtdSil; }, 0);
    // Mesma ordem do servidor, refeita só quando algum silenciado mudou os números.
    if (qtdSil) lista.sort(function (a, b) { return b.por_gravidade.alta - a.por_gravidade.alta || b.por_gravidade.media - a.por_gravidade.media || b.total - a.total || String(a.condominio || '').localeCompare(String(b.condominio || '')); });
    var p = j.periodo || {};
    var info = 'Calculado em ' + horaBR(j.gerado_em) + '. Pagas desde ' + dataBR(p.pagas_desde) + ', pendentes até ' + dataBR(p.pendentes_ate)
      + ', mexidas dos dias ' + (p.auditoria_dias || []).map(dataBR).join(', ') + '.'
      + (atualizando ? ' Atualizando...' : (j.recalculando ? ' Atualizando em segundo plano.' : ''))
      + ((j.falhas || []).length ? ' Atenção: ' + j.falhas.length + ' leitura(s) falharam; os números podem estar incompletos.' : '');
    msg('fin-info', info);
    var el = document.getElementById('fin-quadro');
    if (!lista.length) { el.innerHTML = '<div class="hint">Nenhum condomínio com dados nesta carteira.</div>'; return; }
    var th = 'style="text-align:left;padding:6px 8px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border2)"';
    var td = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid var(--border)"';
    var html = (qtdSil ? '<div class="hint" style="margin-bottom:6px">' + qtdSil + (qtdSil === 1 ? ' alerta silenciado' : ' alertas silenciados') + ' por você · <a href="#" id="fin-quadro-sil">ver</a></div>' : '')
      + '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>'
      + '<th ' + th + '>Condomínio</th><th ' + th + '>Analista</th><th ' + th + '>Alta</th><th ' + th + '>Média</th><th ' + th + '>Baixa</th><th ' + th + '>Valor em alta</th><th ' + th + '>Principais</th>'
      + (fechamentoLigado() ? '<th ' + th + '>Fechamento</th>' : '') + '</tr></thead><tbody>';
    lista.forEach(function (c) {
      var tipos = principais(c.tiposVisiveis);
      if (c.tiposSil.length) tipos += '<span data-fin-sil style="display:none;opacity:0.5">' + (tipos ? '<br>' : '') + 'Silenciados: ' + principais(c.tiposSil) + '</span>';
      var g = c.por_gravidade || {};
      html += '<tr data-fin-cond="' + esc(c.id_condominio) + '" data-fin-nome="' + esc(c.condominio) + '" style="cursor:pointer" title="Abrir os alertas">'
        + '<td ' + td + ' class="td-livre" title="' + esc(c.condominio || ('Código ' + c.id_condominio)) + '"><div class="td-2l"><b>' + esc(c.condominio || ('Código ' + c.id_condominio)) + '</b> <span style="color:var(--muted);font-family:var(--mono);font-size:11px">' + esc(c.id_condominio) + '</span></div></td>'
        + tdL(td, c.analista || '')
        + '<td ' + td + '><b style="color:' + (g.alta ? 'var(--danger)' : 'var(--muted)') + '">' + (g.alta || 0) + '</b></td>'
        + '<td ' + td + '><span style="color:' + (g.media ? 'var(--warning)' : 'var(--muted)') + '">' + (g.media || 0) + '</span></td>'
        + '<td ' + td + '><span style="color:var(--muted)">' + (g.baixa || 0) + '</span></td>'
        + '<td ' + td + '>' + (c.valor_alta ? brl(c.valor_alta) : '') + '</td>'
        + '<td class="td-livre" style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px;color:var(--muted)">' + tipos + '</td>'
        + (fechamentoLigado() ? '<td ' + td + ' data-fin-fech="' + esc(c.id_condominio) + '"></td>' : '') + '</tr>';
    });
    el.innerHTML = html + '</tbody></table></div>';
    var linkSil = document.getElementById('fin-quadro-sil');
    if (linkSil) linkSil.addEventListener('click', function (ev) {
      ev.preventDefault();
      var abrir = linkSil.textContent === 'ver';
      linkSil.textContent = abrir ? 'esconder' : 'ver';
      el.querySelectorAll('[data-fin-sil]').forEach(function (sp) { sp.style.display = abrir ? '' : 'none'; });
    });
    el.querySelectorAll('tr[data-fin-cond]').forEach(function (tr) {
      tr.addEventListener('click', function () { finAbrirCondominio(tr.getAttribute('data-fin-cond'), tr.getAttribute('data-fin-nome')); });
    });
    // T38: coluna Fechamento (public/financeiro-fechamento.js preenche).
    if (fechamentoLigado()) window.finFechamentoQuadro(el, lista, document.getElementById('fin-carteira') ? document.getElementById('fin-carteira').value : '');
  }
  // T38: Fechamento do mês (public/financeiro-fechamento.js). Só para quem gera o pré balancete.
  function fechamentoLigado() { return podePre() && typeof window.finFechamentoQuadro === 'function' && typeof window.finFechamentoPode === 'function' && window.finFechamentoPode(); }

  // 6. Detalhe do condomínio: abas Alertas e Pré balancete.
  var TH = 'style="text-align:left;padding:6px 8px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border2)"';
  var TD = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid var(--border);vertical-align:top"';
  function botaoAba(chave, rotulo) {
    var ativo = est.aba === chave;
    return '<button class="btn ' + (ativo ? 'btn-primary' : 'btn-ghost') + '" data-fin-aba="' + chave + '" style="font-size:12px;padding:6px 12px">' + rotulo + '</button>';
  }
  function finAbrirCondominio(id, nome, aba) {
    if (!/^\d+$/.test(String(id || ''))) return;
    est.cond = { id: String(id), nome: nome || '' };
    est.alertas = null;
    est.aba = aba === 'pre' && podePre() ? 'pre' : (aba === 'fechamento' && fechamentoLigado() ? 'fechamento' : 'alertas');
    var card = document.getElementById('fin-detalhe');
    card.style.display = '';
    montarDetalhe();
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    carregarAlertas(false);
  }
  window.finAbrirCondominio = finAbrirCondominio;

  function montarDetalhe() {
    var card = document.getElementById('fin-detalhe');
    var c = est.cond;
    card.innerHTML = '<div class="card-header" style="flex-wrap:wrap;gap:8px"><span class="card-title">' + esc(c.nome || ('Código ' + c.id)) + ' <span style="color:var(--muted);font-family:var(--mono);font-size:12px">' + esc(c.id) + '</span></span>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap">' + botaoAba('alertas', 'Alertas') + (podePre() ? botaoAba('pre', 'Pré balancete') : '')
      + (fechamentoLigado() ? botaoAba('fechamento', 'Fechamento do mês') : '') + '</div></div>'
      + '<div id="fin-aba-conteudo"></div>';
    card.querySelectorAll('[data-fin-aba]').forEach(function (b) {
      b.addEventListener('click', function () { est.aba = b.getAttribute('data-fin-aba'); montarDetalhe(); });
    });
    // T37: Boletos do mês e Conciliação saíram daqui e ficam nos itens próprios do menu.
    if (est.aba === 'pre' && podePre()) abaPre();
    else if (est.aba === 'fechamento' && fechamentoLigado()) {
      window.finFechamentoAba(document.getElementById('fin-aba-conteudo'), est.cond, function (aba, mes) { est.aba = aba; est.mesPre = mes || null; montarDetalhe(); });
    } else { est.aba = 'alertas'; abaAlertas(); }
  }

  // 6a. Alertas.
  function abaAlertas() {
    var el = document.getElementById('fin-aba-conteudo');
    el.innerHTML = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">'
      + '<select id="fin-filtro-grav" style="width:auto"><option value="">Todas as gravidades</option><option value="alta">Alta</option><option value="media">Média</option><option value="baixa">Baixa</option></select>'
      + '<select id="fin-filtro-tipo" style="width:auto;min-width:220px"><option value="">Todos os tipos</option></select>'
      + '<button class="btn btn-ghost" id="fin-alertas-atualizar" style="font-size:12px;padding:6px 12px" title="Lê de novo no Superlógica">Atualizar</button></div>'
      + '<div id="fin-alertas-info" class="ficha-sub" style="margin-bottom:8px"></div><div id="fin-alertas-lista"></div>';
    document.getElementById('fin-filtro-grav').addEventListener('change', renderAlertas);
    document.getElementById('fin-filtro-tipo').addEventListener('change', renderAlertas);
    document.getElementById('fin-alertas-atualizar').addEventListener('click', function () { carregarAlertas(true); });
    if (est.alertas) renderAlertas(); else carregarAlertas(false);
  }
  // Com alertas na tela (ou guardados na aba para este condomínio), eles ficam visíveis com o
  // aviso "Atualizando" até a resposta nova chegar; sem nada, o esqueleto ocupa o lugar do branco.
  async function carregarAlertas(forcar) {
    var c = est.cond;
    var seq = ++est.seqD;
    var chave = 'alertas:' + c.id;
    if (!est.alertas) est.alertas = cacheLer(chave);
    est.alertasAtualizando = !!est.alertas;
    est.alertasSeq = seq;
    if (est.alertas) { if (est.aba === 'alertas') renderAlertas(); }
    else { esqueleto('fin-alertas-lista', 6); msg('fin-alertas-info', 'Carregando...'); }
    try {
      var j = await pegar('/api/financeiro/condominio/' + encodeURIComponent(c.id) + '/alertas' + (forcar ? '?forcar=1' : ''), function () {
        if (seq === est.seqD && !est.alertasAtualizando) msg('fin-alertas-info', 'Calculando os alertas (leva de 1 a 3 minutos na primeira vez)...');
      }, 'seqD', seq);
      // Atropelada por outra leitura (pré balancete usa a mesma sequência): solta o aviso
      // "Atualizando" se nenhuma leitura de alertas mais nova o assumiu.
      if (seq !== est.seqD || !est.cond || est.cond.id !== c.id) { if (est.alertasSeq === seq) est.alertasAtualizando = false; return; }
      est.alertas = j;
      est.alertasAtualizando = false;
      cacheGravar(chave, j);
      if (j.nome && !est.cond.nome) est.cond.nome = j.nome;
      if (est.aba === 'alertas') renderAlertas();
    } catch (e) {
      if (est.alertasSeq === seq) est.alertasAtualizando = false;
      if (seq !== est.seqD || e.message === 'cancelado') return;
      if (est.alertas && est.cond && est.cond.id === c.id) {
        if (est.aba === 'alertas') renderAlertas();
        msg('fin-alertas-info', e.message + ' Mostrando o último resultado.', true);
      } else {
        var l = document.getElementById('fin-alertas-lista');
        if (l) l.innerHTML = '';
        msg('fin-alertas-info', e.message, true);
      }
    }
  }

  function renderAlertas() {
    var j = est.alertas;
    var lista = document.getElementById('fin-alertas-lista');
    if (!j || !lista) return;
    var selTipo = document.getElementById('fin-filtro-tipo');
    var tipoAtual = selTipo.value;
    // T51: silenciados (silenciado:true do servidor) saem da lista, do filtro e da contagem.
    var todos = j.alertas || [];
    var base = todos.filter(function (a) { return !(a && a.silenciado === true); });
    var sil = todos.filter(function (a) { return a && a.silenciado === true; });
    var tipos = {};
    base.forEach(function (a) { tipos[a.tipo] = a.descricao_tipo || a.tipo; });
    selTipo.innerHTML = '<option value="">Todos os tipos</option>' + Object.keys(tipos).sort().map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === tipoAtual ? ' selected' : '') + '>' + esc(tipos[k]) + '</option>';
    }).join('');
    var g = document.getElementById('fin-filtro-grav').value;
    var t = selTipo.value;
    var vis = base.filter(function (a) { return (!g || a.gravidade === g) && (!t || a.tipo === t); });
    msg('fin-alertas-info', base.length + ' alerta(s), ' + vis.length + ' na lista. Calculado em ' + horaBR(j.gerado_em) + '.'
      + (j.analista ? ' Analista: ' + j.analista + '.' : '') + (est.alertasAtualizando ? ' Atualizando...' : (j.recalculando ? ' Atualizando em segundo plano.' : '')));
    var rodape = '';
    if (sil.length) {
      rodape = '<div class="hint" style="margin-top:8px">' + sil.length + (sil.length === 1 ? ' silenciado' : ' silenciados') + ' por você · <a href="#" id="fin-alertas-sil">' + (est.verSilDet ? 'esconder' : 'ver') + '</a></div>';
      if (est.verSilDet) rodape += '<div style="opacity:0.45">' + tabelaAlertas(sil.slice(0, 300)) + '</div>';
    }
    var MAX = 300;
    if (!vis.length) lista.innerHTML = '<div class="hint">Nenhum alerta com esse filtro.</div>' + rodape;
    else {
      var html = tabelaAlertas(vis.slice(0, MAX));
      if (vis.length > MAX) html += '<div class="hint" style="margin-top:6px">Mostrando os ' + MAX + ' mais graves de ' + vis.length + '. Use os filtros para ver os outros.</div>';
      lista.innerHTML = html + rodape;
    }
    var ls = document.getElementById('fin-alertas-sil');
    if (ls) ls.addEventListener('click', function (ev) { ev.preventDefault(); est.verSilDet = !est.verSilDet; renderAlertas(); });
  }
  // Tabela de alertas do condomínio (a mesma para os visíveis e para os silenciados).
  function tabelaAlertas(itens) {
    var html = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th ' + TH + '>Gravidade</th><th ' + TH + '>Tipo</th><th ' + TH + '>Fornecedor e documento</th><th ' + TH + '>Valor</th><th ' + TH + '>Datas</th><th ' + TH + '>O que houve</th><th ' + TH + '>Responsável</th><th ' + TH + '></th></tr></thead><tbody>';
    itens.forEach(function (a) {
      var datas = [a.dt_vencimento ? 'venc. ' + dataBR(a.dt_vencimento) : '', a.dt_liquidacao ? 'pago ' + dataBR(a.dt_liquidacao) : '', a.dt_lancamento ? 'lançado ' + dataBR(a.dt_lancamento) : ''].filter(Boolean).join('<br>');
      var link = linkSeguro(a.link);
      html += '<tr><td ' + TD + '>' + selo(a.gravidade) + '</td>'
        + tdL(TD, a.mexida || a.descricao_tipo || a.tipo)
        + tdL(TD, a.fornecedor || '', a.documento ? 'doc. ' + a.documento : '')
        + '<td ' + TD + ' >' + (a.valor ? brl(a.valor) : '') + '</td>'
        + '<td ' + TD + '><span style="font-size:11px">' + datas + '</span></td>'
        + tdL(TD, a.detalhe || '')
        + tdL(TD, a.usuario || a.analista || '')
        + '<td ' + TD + '>' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer" style="font-size:12px;white-space:nowrap">Abrir no Superlógica</a>' : '') + '</td></tr>';
    });
    return html + '</tbody></table></div>';
  }

  // 6b. Boletos do mês (conferência antes de enviar).
  var NOME_BOLETO = { valor_fora_padrao: 'Valor fora do padrão', sem_boleto: 'Unidade sem boleto', boleto_em_dobro: 'Boleto em dobro', leitura_faltando: 'Leitura faltando',
    leitura_zerada: 'Leitura zerada', rateio_sumiu: 'Rateio que sumiu', rateio_apareceu: 'Rateio novo', parcela_repetida: 'Parcela repetida' };
  // T37: tela própria (item Boletos do menu), sobre o condomínio ativo do topo.
  est.seqB = 0;
  function condBoletos() {
    var c = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
    var id = c ? String(c.id_superlogica || '') : '';
    return /^\d+$/.test(id) ? { id: id, nome: c.nome || '' } : null;
  }
  function boletosAbrir() {
    var mes = document.getElementById('fin-bol-mes');
    if (mes && !mes.value) mes.value = mesISO(0);
    if (!condBoletos()) msg('fin-bol-info', 'Escolha o condomínio no topo para conferir os boletos.');
  }
  function boletosLimpar() {
    est.seqB++;
    var l = document.getElementById('fin-bol-lista');
    if (l) l.innerHTML = '';
    msg('fin-bol-info', '');
    var b = document.getElementById('fin-bol-conferir');
    if (b) b.disabled = false;
  }
  window.addEventListener('condominioAtivo:trocou', boletosLimpar);
  window.finBoletosConferir = async function () {
    if (!podeAbrir('boletos')) return;
    var c = condBoletos();
    if (!c) { msg('fin-bol-info', 'Escolha o condomínio no topo para conferir os boletos.', true); return; }
    var mes = document.getElementById('fin-bol-mes').value;
    if (!/^\d{4}-\d{2}$/.test(mes)) { msg('fin-bol-info', 'Escolha o mês.', true); return; }
    var seq = ++est.seqB;
    var btn = document.getElementById('fin-bol-conferir');
    btn.disabled = true;
    esqueleto('fin-bol-lista', 6);
    msg('fin-bol-info', 'Lendo os boletos de ' + (c.nome || 'código ' + c.id) + ' no mês e nos 3 anteriores (pode levar até 1 minuto)...');
    try {
      var j = await pegar('/api/financeiro/boletos/' + encodeURIComponent(c.id) + '?competencia=' + encodeURIComponent(mes), null, 'seqB', seq);
      var agora = condBoletos();
      if (seq !== est.seqB || !agora || agora.id !== c.id) return;
      renderBoletos(j);
    } catch (e) {
      if (seq === est.seqB && e.message !== 'cancelado') { document.getElementById('fin-bol-lista').innerHTML = ''; msg('fin-bol-info', e.message, true); }
    } finally { if (seq === est.seqB && document.getElementById('fin-bol-conferir')) document.getElementById('fin-bol-conferir').disabled = false; }
  };
  function renderBoletos(j) {
    var r = j.resumo || {};
    msg('fin-bol-info', (r.boletos || 0) + ' boleto(s) em ' + (r.unidades_com_boleto || 0) + ' unidade(s), total ' + brl(r.valor_total) + '; comparado com ' + (j.meses_comparados || []).join(', ') + '. '
      + (r.alertas || 0) + ' ponto(s) para conferir.' + ((j.avisos || []).length ? ' ' + j.avisos.join(' ') : ''));
    var lista = j.alertas || [];
    var el = document.getElementById('fin-bol-lista');
    if (!lista.length) { el.innerHTML = '<div class="hint">Nada fora do padrão neste mês.</div>'; return; }
    var html = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th ' + TH + '>Gravidade</th><th ' + TH + '>Tipo</th><th ' + TH + '>Unidade</th><th ' + TH + '>O que houve</th></tr></thead><tbody>';
    lista.forEach(function (a) {
      html += '<tr><td ' + TD + '>' + selo(a.gravidade) + '</td><td ' + TD + '>' + esc(NOME_BOLETO[a.tipo] || a.tipo) + '</td><td ' + TD + '>' + esc(a.unidade || '') + '</td>'
        + '<td ' + TD + ' class="td-livre" title="' + esc((a.titulo || '') + '\n' + (a.detalhe || '')) + '"><div class="td-2l"><b>' + esc(a.titulo || '') + '</b></div><div class="td-2l">' + esc(a.detalhe || '') + '</div></td></tr>';
    });
    el.innerHTML = html + '</tbody></table></div>';
  }

  // 6c. Pré balancete: o que impede fechar o mês.
  function abaPre() {
    var el = document.getElementById('fin-aba-conteudo');
    el.innerHTML = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">'
      + '<label style="font-size:12px">Mês <input type="month" id="fin-pre-mes" value="' + (est.mesPre || mesISO(-1)) + '" max="' + mesISO(0) + '" style="width:auto"></label>'
      + '<button class="btn btn-primary" id="fin-pre-gerar" style="font-size:12px;padding:6px 14px">Pré balancete</button>'
      + '<button class="btn btn-ghost" id="fin-pre-atualizar" style="font-size:12px;padding:6px 12px" title="Lê de novo no Superlógica">Atualizar</button></div>'
      + '<div class="hint" style="margin-bottom:8px">Mostra o que impede fechar o mês: pagas sem comprovante ou sem nota, vencidas sem baixa, lançadas depois do vencimento e mexidas suspeitas. Itens de gravidade baixa ficam só para conferir.</div>'
      + '<div id="fin-pre-info" class="ficha-sub" style="margin-bottom:8px"></div><div id="fin-pre-lista"></div>';
    document.getElementById('fin-pre-gerar').addEventListener('click', function () { gerarPre(false); });
    document.getElementById('fin-pre-atualizar').addEventListener('click', function () { gerarPre(true); });
    // T38: vindo do Fechamento do mês, já abre o mês escolhido lá.
    var auto = est.mesPre;
    est.mesPre = null;
    if (auto) gerarPre(false);
  }
  async function gerarPre(forcar) {
    var c = est.cond;
    var mes = document.getElementById('fin-pre-mes').value;
    if (!/^\d{4}-\d{2}$/.test(mes)) { msg('fin-pre-info', 'Escolha o mês.', true); return; }
    var seq = ++est.seqD;
    esqueleto('fin-pre-lista', 6);
    msg('fin-pre-info', 'Lendo as despesas e as mexidas do mês (pode levar até 1 minuto)...');
    try {
      var j = await pegar('/api/financeiro/condominio/' + encodeURIComponent(c.id) + '/pre-balancete?competencia=' + encodeURIComponent(mes) + (forcar ? '&forcar=1' : ''), null, 'seqD', seq);
      if (seq !== est.seqD || !est.cond || est.cond.id !== c.id || est.aba !== 'pre') return;
      renderPre(j);
    } catch (e) {
      if (seq === est.seqD && e.message !== 'cancelado') {
        var l = document.getElementById('fin-pre-lista');
        if (l) l.innerHTML = '';
        msg('fin-pre-info', e.message, true);
      }
    }
  }
  function renderPre(j) {
    var el = document.getElementById('fin-pre-lista');
    var mes = String(j.competencia || '').split('-').reverse().join('/');
    var cab = j.pode_fechar
      ? '<div style="padding:12px 14px;border-radius:10px;background:rgba(45,174,114,0.10);color:var(--success);font-weight:600;margin-bottom:10px">Nada impede fechar ' + esc(mes) + '.' + (j.para_conferir ? ' ' + j.para_conferir + ' item(ns) de gravidade baixa para conferir.' : '') + '</div>'
      : '<div style="padding:12px 14px;border-radius:10px;background:rgba(224,58,58,0.08);color:var(--danger);font-weight:600;margin-bottom:10px">' + (j.pendencias || 0) + ' pendência(s) impedem fechar ' + esc(mes) + '.' + (j.para_conferir ? ' Mais ' + j.para_conferir + ' para conferir.' : '') + '</div>';
    msg('fin-pre-info', (j.parcelas_pagas || 0) + ' parcela(s) paga(s) no mês, ' + brl(j.valor_pago) + '. Gerado em ' + horaBR(j.gerado_em) + '.'
      + ((j.falhas || []).length ? ' Atenção: ' + j.falhas.length + ' leitura(s) falharam; o resultado pode estar incompleto.' : ''));
    var html = cab;
    (j.grupos || []).forEach(function (g) {
      var cor = g.bloqueiam ? 'var(--danger)' : (g.quantidade ? 'var(--warning)' : 'var(--success)');
      html += '<details style="border:1px solid var(--border2);border-radius:10px;padding:8px 12px;margin-bottom:8px"' + (g.bloqueiam ? ' open' : '') + '>'
        + '<summary style="cursor:pointer;font-size:13px"><b style="color:' + cor + '">' + g.bloqueiam + '</b> ' + esc(g.titulo)
        + (g.quantidade > g.bloqueiam ? ' <span style="color:var(--muted);font-size:11px">(+' + (g.quantidade - g.bloqueiam) + ' para conferir)</span>' : '')
        + (g.valor ? ' <span style="color:var(--muted);font-size:11px">' + brl(g.valor) + '</span>' : '') + '</summary>';
      if (g.itens && g.itens.length) {
        html += '<div style="overflow-x:auto;margin-top:6px"><table style="width:100%;border-collapse:collapse"><tbody>';
        g.itens.slice(0, 200).forEach(function (a) {
          var link = linkSeguro(a.link);
          html += '<tr><td ' + TD + '>' + selo(a.gravidade) + '</td>' + tdL(TD, a.fornecedor || '', a.documento ? 'doc. ' + a.documento : '')
            + '<td ' + TD + '>' + (a.valor ? brl(a.valor) : '') + '</td>' + tdL(TD, a.detalhe || '', a.usuario || '')
            + '<td ' + TD + '>' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer" style="font-size:12px;white-space:nowrap">Abrir no Superlógica</a>' : '') + '</td></tr>';
        });
        html += '</tbody></table></div>';
        if (g.itens.length > 200) html += '<div class="hint">Mostrando 200 de ' + g.itens.length + '.</div>';
      }
      html += '</details>';
    });
    el.innerHTML = html;
    // T38: conferência dos anexos do mês (public/financeiro-fechamento.js).
    if (typeof window.finAnexosPre === 'function') window.finAnexosPre(el, est.cond, j.competencia);
  }
})();
