// ============================================================
// AVISOS (T39): card "Seu dia" no Dashboard. Mostra o resumo da manhã da carteira (contas sem extrato,
// pré balancete, conciliação, vencidas e boletos, por gravidade) e os erros que o analista lançou.
// O GESTOR vê todas as carteiras, gera o resumo na hora e liga cada usuário do Superlógica a um analista.
// Rotas: /api/avisos/meu-dia, /api/avisos/gerar, /api/avisos/situacao, /api/avisos/vinculos.
// O servidor decide quem vê (OPERACIONAL não vê nada); aqui é só a tela. Nada é enviado para fora do Hub.
// ============================================================
(function () {
  // mostrar: quantos itens cada lista exibe (cresce a cada "Ver mais"); abertos: linhas recolhidas que a pessoa abriu ou fechou.
  var est = { dados: null, sel: '', mostrar: {}, abertos: {}, verSil: {}, ultimaCarga: 0, carregando: false, vigia: null };
  var CACHE = 'avisos_cache';
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

  // Cache da última resposta na aba (sessionStorage) para o card aparecer na hora ao recarregar a página.
  // Guarda só uma impressão curta do login (não o token) para não mostrar o resumo de um login a outro.
  function impressao(t) {
    var s = String(t || ''), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '.' + s.length;
  }
  function apagarCache() { try { sessionStorage.removeItem(CACHE); } catch (e) { /* armazenamento bloqueado: segue sem cache */ } }
  function lerCache() {
    try {
      var x = JSON.parse(sessionStorage.getItem(CACHE) || 'null');
      if (x && x.dono === impressao(window.AUTH_TOKEN) && x.dados && x.dados.mostrar) return x.dados;
      if (x) apagarCache();
    } catch (e) { apagarCache(); }
    return null;
  }
  function gravarCache(j) {
    try { sessionStorage.setItem(CACHE, JSON.stringify({ dono: impressao(est.token), dados: j })); } catch (e) { /* cheio ou bloqueado: segue sem cache */ }
  }

  async function carregar(forcar) {
    if (est.carregando || !window.AUTH_TOKEN || typeof apiAuthFetch !== 'function') return;
    var card = garantirCard();
    if (!card) return;
    // Outro login na mesma aba: some com o card do anterior e carrega de novo na hora.
    // Na primeira carga da página desenha o cache (se for deste login) enquanto busca o resumo novo.
    if (est.token !== window.AUTH_TOKEN) {
      var trocouLogin = est.token != null;
      est.token = window.AUTH_TOKEN; est.dados = null; card.style.display = 'none'; forcar = true;
      if (trocouLogin) apagarCache();
      else {
        var cache = lerCache();
        if (cache) { est.dados = cache; card.style.display = ''; desenhar(); }
      }
    }
    if (!forcar && Date.now() - est.ultimaCarga < 60000) return;
    est.carregando = true;
    try {
      var r = await apiAuthFetch('/api/avisos/meu-dia');
      var j = await r.json().catch(function () { return {}; });
      est.ultimaCarga = Date.now();
      if (!r.ok || !j.mostrar) { card.style.display = 'none'; est.dados = null; apagarCache(); return; }
      est.dados = j;
      gravarCache(j);
      card.style.display = '';
      desenhar();
    } catch (e) { /* sem rede: fica o que já estava na tela até a próxima tentativa */ } finally { est.carregando = false; }
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
      o += '<option value="' + esc(c.id) + '"' + (String(c.id) === est.sel ? ' selected' : '') + '>' + esc(c.nome) + ' (' + (totaisVisiveis(c).itens || 0) + ')</option>';
    });
    if (d.sem_carteira && d.sem_carteira.itens && d.sem_carteira.itens.length) {
      o += '<option value="sem"' + (est.sel === 'sem' ? ' selected' : '') + '>Fora de carteira (' + naoSilenciados(d.sem_carteira.itens).length + ')</option>';
    }
    return o + '</select>';
  }
  var LINHA = 'display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid rgba(127,127,127,0.15)';
  // Listas longas abrem aos poucos: começam no valor base e cada "Ver mais" soma um passo.
  function quantos(chave, base) { var n = Number(est.mostrar[chave]); return n > 0 ? n : base; }
  // nomes: [singular, plural] quando o botão diz o que vai aparecer ("Ver mais 8 analistas").
  function maisBotao(chave, total, vis, passo, nomes) {
    if (total <= vis) return '';
    var falta = total - vis, prox = Math.min(passo, falta), txt;
    if (nomes) txt = 'Ver mais ' + prox + ' ' + (prox === 1 ? nomes[0] : nomes[1]) + (falta > prox ? ' (faltam ' + falta + ')' : '');
    else txt = 'Ver mais (' + falta + (falta === 1 ? ' restante)' : ' restantes)');
    return '<button type="button" class="btn btn-ghost" data-acao="mais" data-chave="' + esc(chave) + '" data-vis="' + vis + '" data-passo="' + passo + '" style="margin-top:6px">' + esc(txt) + '</button>';
  }
  // Linha recolhida: botão de verdade (teclado e leitor de tela) no mesmo desenho das linhas da lista.
  function aberto(chave, padrao) { return Object.prototype.hasOwnProperty.call(est.abertos, chave) ? !!est.abertos[chave] : !!padrao; }
  function botaoAbrir(chave, padrao, conteudo) {
    var a = aberto(chave, padrao);
    return '<button type="button" data-acao="abrir" data-chave="' + esc(chave) + '" aria-expanded="' + (a ? 'true' : 'false') + '" style="background:none;border:0;' + LINHA +
      ';width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;align-items:center"><span class="hint" aria-hidden="true" style="width:12px">' + (a ? '▾' : '▸') + '</span>' + conteudo + '</button>';
  }
  var DENTRO = '<div style="margin-left:22px">';
  // Agrupa mantendo a ordem de chegada; quem chama ordena os grupos como quiser (o sort do JS é estável).
  function agrupar(lista, chaveDe) {
    var mapa = Object.create(null), grupos = [];
    (lista || []).forEach(function (x) {
      var k = String(chaveDe(x));
      if (!mapa[k]) { mapa[k] = { chave: k, itens: [] }; grupos.push(mapa[k]); }
      mapa[k].itens.push(x);
    });
    return grupos;
  }
  function porGravidade(lista) {
    var t = { alta: 0, media: 0, baixa: 0 };
    (lista || []).forEach(function (i) { if (t[i.gravidade] != null) t[i.gravidade]++; });
    return t;
  }
  // Só as gravidades que existem, para a linha recolhida ficar curta.
  function contagemCurta(t) {
    return ['alta', 'media', 'baixa'].filter(function (g) { return t[g]; }).map(function (g) { return t[g] + ' ' + GRAV[g].toLowerCase(); }).join(', ');
  }
  function piorGravidade(t) { return t.alta ? 'alta' : t.media ? 'media' : 'baixa'; }
  // T51: o servidor marca silenciado:true no que a pessoa desligou em "Meus alertas".
  // Some da lista e dos contadores; a linha "N silenciados por você · ver" mostra apagados.
  function silenciado(i) { return !!(i && i.silenciado === true); }
  function naoSilenciados(lista) { return (lista || []).filter(function (i) { return !silenciado(i); }); }
  function linhaSilenciados(chave, sil, desenhaUm) {
    if (!sil.length) return '';
    var aberto = !!est.verSil[chave];
    var h = '<div class="hint" style="margin-top:6px">' + sil.length + (sil.length === 1 ? ' silenciado' : ' silenciados') + ' por você · ' +
      '<a href="#" data-acao="sil" data-chave="' + esc(chave) + '">' + (aberto ? 'esconder' : 'ver') + '</a></div>';
    if (aberto) h += '<div style="opacity:0.45">' + sil.map(desenhaUm).join('') + '</div>';
    return h;
  }
  function linhaItem(i) {
    return '<div style="' + LINHA + '">' + selo(i.gravidade) + '<div style="flex:1"><div style="font-size:13px"><b>' +
      esc(i.condominio || ('Condomínio ' + i.id_condominio)) + '</b>: ' + esc(i.titulo) + '</div>' +
      (i.detalhe ? '<div class="hint">' + esc(i.detalhe) + '</div>' : '') + '</div></div>';
  }
  // Itens da carteira agrupados por condomínio: cada condomínio é uma linha recolhida com a contagem por
  // gravidade (os mais graves primeiro). Abrindo, mostra 10 itens e "Ver mais"; a lista mostra 10 condomínios por vez.
  function listaItens(chave, todos) {
    var itens = naoSilenciados(todos);
    var sil = (todos || []).filter(silenciado);
    if (!itens.length) return '<div class="hint">Nada pendente.</div>' + linhaSilenciados(chave, sil, linhaItem);
    var grupos = agrupar(itens, function (i) { return i.id_condominio != null ? i.id_condominio : i.condominio; });
    grupos.forEach(function (g) { g.t = porGravidade(g.itens); });
    grupos.sort(function (a, b) { return (b.t.alta - a.t.alta) || (b.t.media - a.t.media) || (b.itens.length - a.itens.length); });
    var nC = Math.min(grupos.length, quantos(chave + '|conds', 10));
    var h = grupos.slice(0, nC).map(function (g) {
      var ch = chave + '|c|' + g.chave;
      var nome = g.itens[0].condominio || ('Condomínio ' + g.itens[0].id_condominio);
      var r = botaoAbrir(ch, false, selo(piorGravidade(g.t)) + '<span style="flex:1;font-size:13px"><b>' + esc(nome) + '</b> <span class="hint">(' +
        g.itens.length + (g.itens.length === 1 ? ' item: ' : ' itens: ') + esc(contagemCurta(g.t)) + ')</span></span>');
      if (aberto(ch, false)) {
        var n = Math.min(g.itens.length, quantos(ch, 10));
        r += DENTRO + g.itens.slice(0, n).map(linhaItem).join('') + maisBotao(ch, g.itens.length, n, 10) + '</div>';
      }
      return r;
    }).join('');
    return h + maisBotao(chave + '|conds', grupos.length, nC, 10, ['condomínio', 'condomínios']) + linhaSilenciados(chave, sil, linhaItem);
  }
  function contagem(t) {
    t = t || {};
    return (t.alta || 0) + ' alta, ' + (t.media || 0) + ' média, ' + (t.baixa || 0) + ' baixa';
  }
  // Totais da carteira sem os silenciados (o servidor manda os totais com tudo).
  function totaisVisiveis(c) {
    var t = {}, k;
    var base = (c && c.totais) || {};
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) t[k] = base[k];
    (c && c.itens || []).forEach(function (i) {
      if (!silenciado(i)) return;
      if (t.itens) t.itens--;
      if (t[i.gravidade]) t[i.gravidade]--;
    });
    return t;
  }
  // recolhivel: quem não é GESTOR vê as carteiras em sequência, então cada uma vira uma linha que abre e fecha
  // (padraoAberto diz se começa aberta). O GESTOR vê uma carteira por vez, sempre aberta.
  function blocoCarteira(c, chave, recolhivel, padraoAberto) {
    var antigo = c.dia && est.dados && c.dia !== est.dados.hoje ? ', resumo de ' + dataBR(c.dia) : '';
    var ch = chave || ('c' + c.id);
    var resumo = esc(c.nome) + ' <span class="hint">(' + contagem(totaisVisiveis(c)) + esc(antigo) + ')</span>';
    if (!recolhivel) return '<div style="margin:14px 0 6px;font-size:13px;font-weight:600">' + resumo + '</div>' + listaItens(ch, c.itens || []);
    var chC = ch + '|cart';
    var h = '<div style="margin-top:14px">' + botaoAbrir(chC, padraoAberto, '<span style="flex:1;font-size:13px;font-weight:600">' + resumo + '</span>') + '</div>';
    return h + (aberto(chC, padraoAberto) ? '<div style="margin-top:6px">' + listaItens(ch, c.itens || []) + '</div>' : '');
  }
  function quadroCarteiras(d) {
    var h = '<div style="margin:10px 0 4px;font-size:13px;font-weight:600">Carteiras</div>';
    (d.carteiras || []).forEach(function (c) {
      h += '<div style="' + LINHA + ';cursor:pointer" data-acao="escolher" data-id="' + esc(c.id) + '"><div style="flex:1;font-size:13px">' + esc(c.nome) +
        (c.gerente ? ' <span class="hint">' + esc(c.gerente) + '</span>' : '') + '</div><div class="hint">' + (c.condominios || 0) + ' condomínios, ' + contagem(totaisVisiveis(c)) + '</div></div>';
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
  // Erros agrupados por tipo (os tipos com mais erros primeiro). Cada tipo mostra 5 e abre de 10 em 10.
  function tipoErro(e) { return e.descricao_tipo || e.tipo || 'Outros'; }
  function blocoTipos(prefixo, erros, gestor) {
    var grupos = agrupar(erros, tipoErro).sort(function (a, b) { return b.itens.length - a.itens.length; });
    return grupos.map(function (g) {
      var ch = prefixo + '|t|' + g.chave;
      var n = Math.min(g.itens.length, quantos(ch, 5));
      return '<div style="margin:8px 0 2px;font-size:12px;font-weight:600">' + esc(g.chave) + ' <span class="hint">(' + g.itens.length + ')</span></div>' +
        g.itens.slice(0, n).map(function (e) { return linhaErro(e, gestor); }).join('') + maisBotao(ch, g.itens.length, n, 10);
    }).join('');
  }
  function qtdErros(n) { return n + (n === 1 ? ' erro' : ' erros'); }
  function blocoErros(d) {
    var erros = naoSilenciados(d.erros);
    var silE = (d.erros || []).filter(silenciado);
    var rodape = linhaSilenciados('erros', silE, function (e) { return linhaErro(e, !!d.gestor); });
    var h = '<div style="margin:18px 0 6px;font-size:13px;font-weight:600">' + (d.gestor ? 'Erros por analista' : 'Erros nos seus lançamentos') + '</div>';
    if (!d.gestor) {
      if (!erros.length) return h + '<div class="hint">Nenhum erro nos seus lançamentos dos últimos dias.</div>' + rodape;
      // Até 10 erros aparecem direto; acima disso a lista começa recolhida para não empurrar o resto da tela.
      if (erros.length <= 10) return h + blocoTipos('meus', erros, false) + rodape;
      h += botaoAbrir('meus', false, '<span style="flex:1;font-size:13px">' + qtdErros(erros.length) + ' <span class="hint">(' + porGravidade(erros).alta + ' de alta)</span></span>');
      if (aberto('meus', false)) h += DENTRO + blocoTipos('meus', erros, false) + '</div>';
      return h + rodape;
    }
    if (!erros.length) return h + '<div class="hint">Nenhum erro ligado a um usuário do Superlógica.</div>' + rodape;
    var vinc = {};
    (d.vinculos || []).forEach(function (v) { vinc[String(v.id_usuario_sl)] = v; });
    // Um analista por linha recolhida (quem tem mais erros primeiro); abrindo, os erros dele por tipo.
    var ordem = agrupar(erros, function (e) { return e.id_usuario_sl; }).sort(function (a, b) { return b.itens.length - a.itens.length; });
    var nA = Math.min(ordem.length, quantos('analistas', 8));
    ordem.slice(0, nA).forEach(function (g) {
      var v = vinc[g.chave];
      var situacao = v && v.profile_id ? 'com analista no Hub' : 'sem analista vinculado';
      var ch = 'u' + g.chave;
      h += botaoAbrir(ch, false, '<span style="flex:1;font-size:13px"><b>' + esc(g.itens[0].autor) + '</b> <span class="hint">(' + qtdErros(g.itens.length) + ', ' +
        porGravidade(g.itens).alta + ' de alta, ' + situacao + ')</span></span>');
      if (aberto(ch, false)) h += DENTRO + blocoTipos(ch, g.itens, true) + '</div>';
    });
    return h + maisBotao('analistas', ordem.length, nA, 8, ['analista', 'analistas']) + rodape;
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
        // Várias carteiras em sequência: só a primeira começa aberta.
        (d.carteiras || []).forEach(function (c, i) { h += blocoCarteira(c, null, true, i === 0); });
      }
      h += blocoErros(d);
    }
    card.innerHTML = h;
  }
  function msg(t) { var el = document.getElementById('avisos-msg'); if (el) el.textContent = t || ''; }
  // O card é redesenhado inteiro; devolve o foco ao botão que abriu ou fechou para quem usa teclado.
  function focarAbrir(chave) {
    var card = document.getElementById('avisos-seu-dia');
    if (!card || !card.querySelectorAll) return;
    var bs = card.querySelectorAll('[data-acao="abrir"]');
    for (var i = 0; i < bs.length; i++) if (bs[i].getAttribute('data-chave') === chave) { try { bs[i].focus(); } catch (e) { /* sem foco: segue */ } return; }
  }

  function aoMudar(ev) {
    if (ev.target && ev.target.id === 'avisos-carteira') { est.sel = ev.target.value; desenhar(); }
  }
  function aoClicar(ev) {
    var alvo = ev.target.closest ? ev.target.closest('[data-acao]') : null;
    if (!alvo) return;
    var a = alvo.getAttribute('data-acao');
    if (a === 'mais') {
      var vis = Number(alvo.getAttribute('data-vis')), passo = Number(alvo.getAttribute('data-passo'));
      if (vis >= 0 && passo > 0) { est.mostrar[alvo.getAttribute('data-chave')] = vis + passo; desenhar(); }
    } else if (a === 'abrir') {
      var chA = alvo.getAttribute('data-chave');
      est.abertos[chA] = alvo.getAttribute('aria-expanded') !== 'true';
      desenhar();
      focarAbrir(chA);
    }
    else if (a === 'sil') { ev.preventDefault(); var ch = alvo.getAttribute('data-chave'); est.verSil[ch] = !est.verSil[ch]; desenhar(); }
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
