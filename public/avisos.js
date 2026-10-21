// ============================================================
// AVISOS (T39): card "Seu dia" no Dashboard. Mostra o resumo da manhã da carteira (contas sem extrato,
// pré balancete, conciliação, vencidas e boletos, por gravidade) e os erros que o analista lançou.
// O GESTOR vê todas as carteiras, gera o resumo na hora e liga cada usuário do Superlógica a um analista.
// Rotas: /api/avisos/meu-dia, /api/avisos/gerar, /api/avisos/situacao, /api/avisos/vinculos.
// O servidor decide quem vê (OPERACIONAL não vê nada); aqui é só a tela. Nada é enviado para fora do Hub.
// ============================================================
(function () {
  var est = { dados: null, sel: '', mostrarTudo: {}, ultimaCarga: 0, carregando: false, vigia: null };
  var GRAV = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
  var COR = { alta: 'var(--danger, #e05050)', media: '#d99a2b', baixa: 'var(--muted, #888)' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function horaBR(ts) {
    try { return new Date(ts).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function moeda(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function linkSeguro(u) { return /^https:\/\/[a-z0-9.-]+\.superlogica\.net\//i.test(String(u || '')) ? u : ''; }
  function ehGestor() { return !!(est.dados && est.dados.gestor); }
  function selo(g) {
    return '<span style="display:inline-block;min-width:44px;text-align:center;font-size:10px;font-family:var(--mono);padding:2px 6px;border-radius:4px;border:1px solid ' +
      COR[g] + ';color:' + COR[g] + '">' + esc(GRAV[g] || g) + '</span>';
  }

  // 1. Card no Dashboard, logo depois do card "Condomínio ativo".
  function garantirCard() {
    var painel = document.getElementById('panel-dashboard');
    if (!painel) return null;
    var c = document.getElementById('avisos-seu-dia');
    if (c) return c;
    c = document.createElement('div');
    c.className = 'card';
    c.id = 'avisos-seu-dia';
    c.style.marginBottom = '20px';
    c.style.display = 'none';
    var primeiro = painel.querySelector('.card');
    if (primeiro) primeiro.insertAdjacentElement('afterend', c); else painel.insertBefore(c, painel.firstChild);
    c.addEventListener('click', aoClicar);
    c.addEventListener('change', aoMudar);
    return c;
  }

  async function carregar(forcar) {
    if (est.carregando || !window.AUTH_TOKEN || typeof apiAuthFetch !== 'function') return;
    var card = garantirCard();
    if (!card) return;
    // Outro login na mesma aba: some com o card do anterior e carrega de novo na hora.
    if (est.token !== window.AUTH_TOKEN) { est.token = window.AUTH_TOKEN; est.dados = null; card.style.display = 'none'; forcar = true; }
    if (!forcar && Date.now() - est.ultimaCarga < 60000) return;
    est.carregando = true;
    try {
      var r = await apiAuthFetch('/api/avisos/meu-dia');
      var j = await r.json().catch(function () { return {}; });
      est.ultimaCarga = Date.now();
      if (!r.ok || !j.mostrar) { card.style.display = 'none'; est.dados = null; return; }
      est.dados = j;
      card.style.display = '';
      desenhar();
    } catch (e) { /* sem rede: o card some até a próxima tentativa */ } finally { est.carregando = false; }
  }

  // 2. Desenho do card.
  function cabecalho(d) {
    var sub;
    if (!d.dia) sub = 'O resumo ainda não foi gerado. Ele sai sozinho às 7h dos dias úteis.';
    else if (d.dia !== d.hoje) sub = 'O resumo de hoje ainda não saiu. Mostrando o de ' + dataBR(d.dia) + '.';
    else sub = 'Resumo de hoje, gerado às ' + horaBR(d.gerado_em) + '. Conta sem extrato a partir de ' + (d.limite_dias || 2) + ' dias úteis.';
    var h = '<div class="card-header" style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
      '<div style="flex:1 1 260px"><span class="card-title">Seu dia</span><div class="hint" style="margin-top:4px">' + esc(sub) + '</div></div>';
    if (d.gestor) {
      h += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + seletorCarteira(d) +
        '<button class="btn btn-ghost" data-acao="gerar" title="Lê agora no Superlógica e grava o resumo de hoje">Gerar agora</button>' +
        '<button class="btn btn-ghost" data-acao="vinculos">Vínculos dos usuários</button></div>';
    }
    h += '</div><div id="avisos-msg" class="hint" style="margin:6px 0">' +
      (d.gestor && d.gerando ? 'Gerando o resumo desde ' + esc(horaBR(d.gerando.desde)) + '. A tela atualiza sozinha.' : '') + '</div>';
    return h;
  }
  function seletorCarteira(d) {
    var o = '<select id="avisos-carteira" style="width:auto;min-width:220px"><option value="">Todas as carteiras</option>';
    (d.carteiras || []).forEach(function (c) {
      o += '<option value="' + esc(c.id) + '"' + (String(c.id) === est.sel ? ' selected' : '') + '>' + esc(c.nome) + ' (' + ((c.totais && c.totais.itens) || 0) + ')</option>';
    });
    if (d.sem_carteira && d.sem_carteira.itens && d.sem_carteira.itens.length) {
      o += '<option value="sem"' + (est.sel === 'sem' ? ' selected' : '') + '>Fora de carteira (' + d.sem_carteira.itens.length + ')</option>';
    }
    return o + '</select>';
  }
  var LINHA = 'display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid rgba(127,127,127,0.15)';
  function maisBotao(chave, total, vis) {
    return total > vis ? '<button class="btn btn-ghost" data-acao="tudo" data-chave="' + esc(chave) + '" style="margin-top:6px">Mostrar todos (' + total + ')</button>' : '';
  }
  function listaItens(chave, itens, limite) {
    if (!itens.length) return '<div class="hint">Nada pendente.</div>';
    var vis = est.mostrarTudo[chave] ? itens : itens.slice(0, limite || 12);
    var h = '';
    vis.forEach(function (i) {
      h += '<div style="' + LINHA + '">' + selo(i.gravidade) + '<div style="flex:1"><div style="font-size:13px"><b>' +
        esc(i.condominio || ('Condomínio ' + i.id_condominio)) + '</b>: ' + esc(i.titulo) + '</div>' +
        (i.detalhe ? '<div class="hint">' + esc(i.detalhe) + '</div>' : '') + '</div></div>';
    });
    return h + maisBotao(chave, itens.length, vis.length);
  }
  function contagem(t) {
    t = t || {};
    return (t.alta || 0) + ' alta, ' + (t.media || 0) + ' média, ' + (t.baixa || 0) + ' baixa';
  }
  function blocoCarteira(c, chave) {
    var antigo = c.dia && est.dados && c.dia !== est.dados.hoje ? ', resumo de ' + dataBR(c.dia) : '';
    return '<div style="margin:14px 0 6px;font-size:13px;font-weight:600">' + esc(c.nome) + ' <span class="hint">(' + contagem(c.totais) + esc(antigo) + ')</span></div>' +
      listaItens(chave || ('c' + c.id), c.itens || []);
  }
  function quadroCarteiras(d) {
    var h = '<div style="margin:10px 0 4px;font-size:13px;font-weight:600">Carteiras</div>';
    (d.carteiras || []).forEach(function (c) {
      h += '<div style="' + LINHA + ';cursor:pointer" data-acao="escolher" data-id="' + esc(c.id) + '"><div style="flex:1;font-size:13px">' + esc(c.nome) +
        (c.gerente ? ' <span class="hint">' + esc(c.gerente) + '</span>' : '') + '</div><div class="hint">' + (c.condominios || 0) + ' condomínios, ' + contagem(c.totais) + '</div></div>';
    });
    return h;
  }

  // 3. Erros nos lançamentos (o analista vê os dele; o GESTOR vê por usuário do Superlógica).
  function linhaErro(e, gestor) {
    var link = linkSeguro(e.link);
    var quem = e.papel === 'mexeu' ? (gestor ? e.autor + ' alterou' : 'Você alterou') : (gestor ? e.autor + ' lançou' : 'Você lançou');
    if (e.data_autor) quem += ' em ' + dataBR(e.data_autor);
    var partes = [e.fornecedor, e.valor ? moeda(e.valor) : '', e.detalhe].filter(Boolean).join('. ');
    return '<div style="' + LINHA + '">' + selo(e.gravidade) + '<div style="flex:1"><div style="font-size:13px"><b>' + esc(e.condominio || '') + '</b>: ' +
      esc(e.descricao_tipo || e.tipo) + '</div><div class="hint">' + esc(partes) + '</div><div class="hint">' + esc(quem) +
      (link ? ' <a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Abrir o lançamento</a>' : '') + '</div></div></div>';
  }
  function listaErros(chave, erros, gestor, limite) {
    var vis = est.mostrarTudo[chave] ? erros : erros.slice(0, limite || 10);
    return vis.map(function (e) { return linhaErro(e, gestor); }).join('') + maisBotao(chave, erros.length, vis.length);
  }
  function blocoErros(d) {
    var erros = d.erros || [];
    var h = '<div style="margin:18px 0 6px;font-size:13px;font-weight:600">' + (d.gestor ? 'Erros por analista' : 'Erros nos seus lançamentos') + '</div>';
    if (!d.gestor) return h + (erros.length ? listaErros('meus', erros, false) : '<div class="hint">Nenhum erro nos seus lançamentos dos últimos dias.</div>');
    if (!erros.length) return h + '<div class="hint">Nenhum erro ligado a um usuário do Superlógica.</div>';
    var vinc = {};
    (d.vinculos || []).forEach(function (v) { vinc[String(v.id_usuario_sl)] = v; });
    var grupos = {}, ordem = [];
    erros.forEach(function (e) { var k = String(e.id_usuario_sl); if (!grupos[k]) { grupos[k] = []; ordem.push(k); } grupos[k].push(e); });
    ordem.sort(function (a, b) { return grupos[b].length - grupos[a].length; });
    ordem.forEach(function (k) {
      var v = vinc[k];
      var situacao = v && v.profile_id ? 'com analista no Hub' : 'sem analista vinculado';
      h += '<div style="margin:10px 0 2px;font-size:13px"><b>' + esc(grupos[k][0].autor) + '</b> <span class="hint">(' + grupos[k].length + (grupos[k].length === 1 ? ' erro, ' : ' erros, ') + situacao + ')</span></div>' +
        listaErros('u' + k, grupos[k], true, 3);
    });
    return h;
  }

  function desenhar() {
    var d = est.dados, card = garantirCard();
    if (!d || !card) return;
    var h = cabecalho(d);
    if (d.dia) {
      if (d.gestor) {
        if (est.sel === 'sem' && d.sem_carteira) h += blocoCarteira(d.sem_carteira, 'sem');
        else {
          var c = (d.carteiras || []).filter(function (x) { return String(x.id) === est.sel; })[0];
          h += c ? blocoCarteira(c) : quadroCarteiras(d);
        }
        if (d.meta && d.meta.parcial) h += '<div class="hint" style="margin-top:6px">Este resumo foi gerado só para algumas carteiras.</div>';
        if (d.meta && d.meta.falhas_total) h += '<div class="hint" style="margin-top:6px">' + d.meta.falhas_total + ' leituras do Superlógica falharam nesta geração; o que veio está acima.</div>';
      } else {
        (d.carteiras || []).forEach(function (c) { h += blocoCarteira(c); });
      }
      h += blocoErros(d);
    }
    card.innerHTML = h;
  }
  function msg(t) { var el = document.getElementById('avisos-msg'); if (el) el.textContent = t || ''; }

  function aoMudar(ev) {
    if (ev.target && ev.target.id === 'avisos-carteira') { est.sel = ev.target.value; desenhar(); }
  }
  function aoClicar(ev) {
    var alvo = ev.target.closest ? ev.target.closest('[data-acao]') : null;
    if (!alvo) return;
    var a = alvo.getAttribute('data-acao');
    if (a === 'tudo') { est.mostrarTudo[alvo.getAttribute('data-chave')] = true; desenhar(); }
    else if (a === 'escolher') { est.sel = alvo.getAttribute('data-id') || ''; desenhar(); }
    else if (a === 'gerar') gerar();
    else if (a === 'vinculos') abrirVinculos();
  }

  // 4. Gerar agora (GESTOR): a carteira escolhida ou todas. Acompanha até terminar.
  async function gerar() {
    if (!ehGestor()) return;
    var corpo = {};
    if (est.sel && est.sel !== 'sem') corpo.carteiras = [Number(est.sel)];
    msg('Pedindo a geração...');
    try {
      var r = await apiAuthFetch('/api/avisos/gerar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) { msg(j.detalhe || ('Falha ' + r.status)); return; }
      msg('Gerando o resumo' + (corpo.carteiras ? ' da carteira escolhida' : ' de todas as carteiras') + '. Pode levar alguns minutos; a tela atualiza sozinha.');
      acompanhar();
    } catch (e) { msg('Não foi possível pedir a geração agora.'); }
  }
  function acompanhar() {
    if (est.vigia) return;
    var voltas = 0;
    est.vigia = setInterval(async function () {
      voltas++;
      try {
        var r = await apiAuthFetch('/api/avisos/situacao');
        var j = await r.json().catch(function () { return {}; });
        if (r.ok && !j.gerando) { clearInterval(est.vigia); est.vigia = null; await carregar(true); return; }
      } catch (e) { /* tenta na próxima volta */ }
      if (voltas > 160) { clearInterval(est.vigia); est.vigia = null; msg('A geração está demorando. Atualize a página depois.'); }
    }, 15000);
  }

  // 5. Vínculos (GESTOR): usuário do Superlógica que lança despesas x analista do Hub e carteira.
  function fecharVinculos() { var m = document.getElementById('avisos-vinculos'); if (m) m.remove(); }
  async function abrirVinculos() {
    if (!ehGestor()) return;
    fecharVinculos();
    var m = document.createElement('div');
    m.id = 'avisos-vinculos';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto';
    m.innerHTML = '<div class="card" style="max-width:920px;width:100%"><div class="card-header" style="display:flex;align-items:center">' +
      '<span class="card-title" style="flex:1">Vínculos dos usuários do Superlógica</span><button class="btn btn-ghost" data-v="fechar">Fechar</button></div>' +
      '<div class="hint" style="margin-bottom:8px">Ligue cada usuário que lança despesas no Superlógica ao analista do Hub. O analista passa a ver no card os erros dos lançamentos dele. ' +
      'A carteira fica registrada para a sua referência. Os usuários aparecem aqui depois da primeira geração do resumo; só entram os erros das despesas lançadas nos últimos 5 dias úteis.</div>' +
      '<div id="avisos-vinc-corpo" class="hint">Carregando...</div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (ev) {
      if (ev.target === m || (ev.target.getAttribute && ev.target.getAttribute('data-v') === 'fechar')) fecharVinculos();
      var b = ev.target.closest ? ev.target.closest('[data-v="salvar"]') : null;
      if (b) salvarVinculo(b.getAttribute('data-id'));
    });
    try {
      var r = await apiAuthFetch('/api/avisos/vinculos');
      var j = await r.json().catch(function () { return {}; });
      var corpo = document.getElementById('avisos-vinc-corpo');
      if (!corpo) return;
      if (!r.ok) { corpo.textContent = j.detalhe || ('Falha ' + r.status); return; }
      corpo.innerHTML = tabelaVinculos(j);
    } catch (e) { var c2 = document.getElementById('avisos-vinc-corpo'); if (c2) c2.textContent = 'Não foi possível carregar agora.'; }
  }
  function tabelaVinculos(j) {
    var us = j.usuarios || [];
    if (!us.length) return 'Nenhum usuário do Superlógica apareceu ainda. Gere o resumo primeiro.';
    var opAnalista = function (sel) {
      var o = '<option value="">Nenhum</option>';
      (j.analistas || []).forEach(function (p) {
        var nome = (p.nome || p.email || p.id) + (p.role === 'OPERACIONAL' ? ' (não vê o card)' : '');
        o += '<option value="' + esc(p.id) + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(nome) + '</option>';
      });
      return o;
    };
    var opCarteira = function (sel) {
      var o = '<option value="">Nenhuma</option>';
      (j.carteiras || []).forEach(function (c) { o += '<option value="' + esc(c.id) + '"' + (Number(c.id) === Number(sel) ? ' selected' : '') + '>' + esc(c.nome) + '</option>'; });
      return o;
    };
    var nomeCarteira = function (id) { var c = (j.carteiras || []).filter(function (x) { return Number(x.id) === Number(id); })[0]; return c ? c.nome : ''; };
    var h = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse"><tr style="text-align:left">' +
      '<th style="padding:4px">Usuário no Superlógica</th><th style="padding:4px">Lançamentos</th><th style="padding:4px">Analista no Hub</th><th style="padding:4px">Carteira</th><th></th></tr>';
    us.forEach(function (u) {
      var sug = !u.carteira && u.sugestao_carteira ? '<div class="hint">Sugestão: ' + esc(nomeCarteira(u.sugestao_carteira)) + '</div>' : '';
      h += '<tr style="border-top:1px solid rgba(127,127,127,0.15)"><td style="padding:4px">' + esc(u.apelido) + ' <span class="hint">#' + esc(u.id_usuario_sl) + '</span></td>' +
        '<td style="padding:4px">' + (u.lancamentos || 0) + '</td>' +
        '<td style="padding:4px"><select id="av-p-' + esc(u.id_usuario_sl) + '" style="width:auto;max-width:240px">' + opAnalista(u.profile_id) + '</select></td>' +
        '<td style="padding:4px"><select id="av-c-' + esc(u.id_usuario_sl) + '" style="width:auto;max-width:200px">' + opCarteira(u.carteira || u.sugestao_carteira) + '</select>' + sug + '</td>' +
        '<td style="padding:4px"><button class="btn btn-ghost" data-v="salvar" data-id="' + esc(u.id_usuario_sl) + '">Salvar</button></td></tr>';
    });
    return h + '</table></div><div id="avisos-vinc-msg" class="hint" style="margin-top:8px"></div>';
  }
  async function salvarVinculo(id) {
    if (!/^\d{1,12}$/.test(String(id || ''))) return;
    var p = document.getElementById('av-p-' + id), c = document.getElementById('av-c-' + id), out = document.getElementById('avisos-vinc-msg');
    var corpo = { profile_id: p && p.value ? p.value : null, carteira: c && c.value ? Number(c.value) : null };
    try {
      var r = await apiAuthFetch('/api/avisos/vinculos/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      var j = await r.json().catch(function () { return {}; });
      if (out) out.textContent = r.ok ? 'Vínculo salvo.' : (j.detalhe || ('Falha ' + r.status));
      if (r.ok) carregar(true);
    } catch (e) { if (out) out.textContent = 'Não foi possível salvar agora.'; }
  }

  // 6. Início: espera o login e carrega; volta a carregar ao abrir o Dashboard (no máximo 1 vez por minuto).
  var tentativas = 0;
  var espera = setInterval(function () {
    tentativas++;
    if (window.AUTH_TOKEN && typeof apiAuthFetch === 'function') { clearInterval(espera); carregar(true); }
    else if (tentativas > 240) clearInterval(espera);
  }, 1500);
  if (typeof window.showPanel === 'function') {
    var origShow = window.showPanel;
    window.showPanel = function (nome) {
      var r = origShow.apply(this, arguments);
      if (nome === 'dashboard') carregar(false);
      return r;
    };
  }
})();
