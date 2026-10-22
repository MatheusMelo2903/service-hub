// ============================================================
// REGRAS DO CONDOMÍNIO: consulta, comparação e perguntas frequentes (frente B).
// Monta dentro de #regras-consulta (aba Regras). Toda resposta mostra o artigo e o trecho
// literal conferido no acervo; quando não acha, diz que não achou.
// Rotas: POST /api/regras/:id/perguntar, POST /api/regras/comparar, GET /api/regras/:id/faq,
// POST /api/regras/:id/faq/gerar, GET /api/regras/:id/documentos/:doc/arquivo (frente D).
// ============================================================
(function () {
  var estado = { montado: false, idFaq: null, seqPerg: 0, seqComp: 0, seqFaq: 0 };
  var TIPOS = { convencao: 'Convenção', regimento: 'Regimento interno', ata: 'Ata', regulamento: 'Regulamento', outro: 'Documento' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(id) { return document.getElementById(id); }
  function cond() { return (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : null; }
  function idAtivo() { var c = cond(); return c && c.id_superlogica ? String(c.id_superlogica) : null; }
  function dataBR(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }
  function paragrafos(t) {
    return String(t || '').split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean)
      .map(function (p) { return '<p style="margin:0 0 8px">' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }
  async function chamar(url, corpo) {
    var op = corpo ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) } : {};
    var r = await apiAuthFetch(url, op);
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.detalhe || ('Falha ' + r.status)); e.status = r.status; throw e; }
    return j;
  }

  // Estilo próprio da frente, só com as variáveis do tema (visual igual ao das outras abas).
  function estilo() {
    if ($('rc-estilo')) return;
    var s = document.createElement('style');
    s.id = 'rc-estilo';
    s.textContent = [
      '.rc-caixa{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px 12px;color:var(--text);font-family:var(--sans);font-size:13px;width:100%;box-sizing:border-box;resize:vertical}',
      '.rc-resposta{font-size:13px;line-height:1.55;color:var(--text);margin-top:14px}',
      '.rc-nao{color:var(--muted);font-style:italic}',
      '.rc-conflito{border:1px solid var(--warning);background:rgba(224,154,32,0.08);color:var(--text);border-radius:8px;padding:10px 12px;font-size:12px;margin-top:12px}',
      '.rc-conflito strong{color:var(--warning)}',
      '.rc-fund{border:1px solid var(--border);border-left:3px solid var(--gs-blue);border-radius:8px;padding:10px 12px;margin-top:10px;background:var(--bg2)}',
      '.rc-fund-cab{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:11px;font-family:var(--mono);color:var(--muted)}',
      '.rc-fund-cab b{color:var(--text);font-weight:700}',
      '.rc-cit{font-size:12.5px;line-height:1.5;color:var(--text);margin:8px 0 0;white-space:pre-wrap}',
      '.rc-btn-doc{margin-left:auto;padding:4px 10px;font-size:11px}',
      '.rc-tabela td{white-space:normal;vertical-align:top}',
      '.rc-faq-item{border-bottom:1px solid var(--border);padding:12px 0}',
      '.rc-faq-item:last-child{border-bottom:none}',
      '.rc-faq-tema{font-size:11px;font-family:var(--mono);color:var(--gs-blue);text-transform:uppercase;letter-spacing:0.05em}',
      '.rc-faq-perg{font-weight:600;font-size:13px;margin:4px 0 6px;cursor:pointer}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // Estrutura da aba (uma vez só). Três cartões: perguntar, comparar e perguntas frequentes.
  function montar() {
    var box = $('regras-consulta');
    if (!box || estado.montado) return !!box;
    estilo();
    box.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><span class="card-title">Perguntar sobre as regras</span><span class="ficha-sub" id="rc-cond-nome"></span></div>' +
        '<textarea id="rc-pergunta" class="rc-caixa" rows="3" maxlength="500" placeholder="ex: pode ter cachorro? qual o horário de obras?"></textarea>' +
        '<div style="display:flex;gap:10px;align-items:center;margin-top:10px">' +
          '<button class="btn btn-primary" id="rc-btn-perguntar">Consultar</button>' +
          '<span class="hint" style="margin:0">A resposta usa só a convenção, o regimento, os regulamentos e as atas cadastradas.</span>' +
        '</div>' +
        '<div id="rc-resultado"></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><span class="card-title">Comparar condomínios</span></div>' +
        '<div style="display:flex;gap:10px;align-items:flex-start">' +
          '<input type="text" id="rc-comp-pergunta" maxlength="500" autocomplete="off" placeholder="ex: qual o horário de silêncio?" style="flex:1">' +
          '<button class="btn btn-ghost" id="rc-btn-comparar">Comparar</button>' +
        '</div>' +
        '<div class="hint">Compara os condomínios da sua carteira (até 40 por vez).</div>' +
        '<div id="rc-comp-resultado" style="margin-top:12px"></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><span class="card-title">Perguntas frequentes</span>' +
          '<button class="btn btn-ghost" id="rc-btn-faq" style="display:none">Atualizar perguntas frequentes</button></div>' +
        '<div id="rc-faq"></div>' +
      '</div>';
    $('rc-btn-perguntar').addEventListener('click', perguntar);
    $('rc-pergunta').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) perguntar(); });
    $('rc-btn-comparar').addEventListener('click', compararCond);
    $('rc-comp-pergunta').addEventListener('keydown', function (e) { if (e.key === 'Enter') compararCond(); });
    $('rc-btn-faq').addEventListener('click', gerarFaq);
    // Botão "Abrir documento" de qualquer cartão de fundamento (delegação: os cartões mudam).
    box.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-rc-doc]') : null;
      if (b) abrirDocumento(b.getAttribute('data-rc-cond'), b.getAttribute('data-rc-doc'), b.getAttribute('data-rc-pag'));
    });
    estado.montado = true;
    return true;
  }

  // Cartão de um fundamento: tipo, artigo, data, trecho literal e o botão do documento.
  function cartaoFundamento(f, idCond) {
    var cab = [];
    cab.push('<b>' + esc(TIPOS[f.tipo] || 'Documento') + '</b>');
    if (f.rotulo) cab.push('<b>' + esc(f.rotulo) + '</b>');
    if (f.documento) cab.push(esc(f.documento));
    if (f.data) cab.push(esc(dataBR(f.data)));
    if (f.pagina) cab.push('página ' + esc(f.pagina));
    var botao = f.documento_id ? '<button class="btn btn-ghost rc-btn-doc" data-rc-cond="' + esc(idCond) + '" data-rc-doc="' + esc(f.documento_id) + '" data-rc-pag="' + esc(f.pagina || '') + '">Abrir documento</button>' : '';
    return '<div class="rc-fund"><div class="rc-fund-cab">' + cab.join('<span>·</span>') + botao + '</div>' +
      '<p class="rc-cit">“' + esc(f.citacao) + '”</p></div>';
  }
  function avisoConflito(t) {
    return t ? '<div class="rc-conflito"><strong>Atenção:</strong> ' + esc(t) + '</div>' : '';
  }

  // Abre o PDF do acervo numa aba nova. A aba abre já no clique (o navegador bloqueia aba
  // aberta depois de esperar a resposta) e recebe o endereço assinado quando ele chega.
  async function abrirDocumento(idCond, docId, pagina) {
    if (!idCond || !docId) return;
    var w = window.open('about:blank', '_blank');
    try {
      var j = await chamar('/api/regras/' + encodeURIComponent(idCond) + '/documentos/' + encodeURIComponent(docId) + '/arquivo');
      if (!j.url) throw new Error('Documento sem arquivo guardado.');
      var url = j.url + (pagina ? '#page=' + encodeURIComponent(pagina) : '');
      if (w) { w.opener = null; w.location.href = url; } else window.open(url, '_blank', 'noopener');
    } catch (e) {
      if (w) w.close();
      toast('Não foi possível abrir o documento: ' + e.message, 'err');
    }
  }

  async function perguntar() {
    var id = idAtivo();
    var out = $('rc-resultado');
    if (!id) { toast('Selecione um condomínio com código do Superlógica', 'err'); return; }
    var p = $('rc-pergunta').value.trim();
    if (p.length < 3) { toast('Escreva a pergunta', 'err'); return; }
    var seq = ++estado.seqPerg;
    var bt = $('rc-btn-perguntar'); bt.disabled = true; bt.textContent = 'Consultando...';
    out.innerHTML = '<div class="cond-loading">Procurando na convenção, no regimento e nas atas...</div>';
    try {
      var j = await chamar('/api/regras/' + encodeURIComponent(id) + '/perguntar', { pergunta: p });
      if (seq !== estado.seqPerg) return;
      var html = avisoConflito(j.conflito);
      html += '<div class="rc-resposta' + (j.nao_encontrado ? ' rc-nao' : '') + '">' + paragrafos(j.resposta) + '</div>';
      (j.fundamentos || []).forEach(function (f) { html += cartaoFundamento(f, id); });
      out.innerHTML = html;
    } catch (e) {
      if (seq !== estado.seqPerg) return;
      out.innerHTML = '<div class="ficha-erro">' + esc(e.message) + '</div>';
    } finally {
      if (seq === estado.seqPerg) { bt.disabled = false; bt.textContent = 'Consultar'; }
    }
  }

  // Tabela condomínio x resumo x fundamento. Linha sem fundamento conferido: "não encontrado".
  function tabelaComparacao(j) {
    var linhas = j.linhas || [];
    if (!linhas.length) return '<div class="ficha-sub">Nenhum condomínio da sua carteira tem documentos cadastrados.</div>';
    var nota = j.total > j.comparados ? '<div class="hint" style="margin:0 0 8px">Comparados ' + j.comparados + ' de ' + j.total + ' condomínios.</div>' : '';
    var corpo = linhas.map(function (l) {
      var fund = (l.fundamentos || []).map(function (f) { return cartaoFundamento(f, l.id_superlogica); }).join('');
      return '<tr><td style="min-width:140px"><b>' + esc(l.nome || ('Código ' + l.id_superlogica)) + '</b></td>' +
        '<td style="min-width:200px"' + (l.nao_encontrado ? ' class="rc-nao"' : '') + '>' + esc(l.resumo) + '</td>' +
        '<td style="min-width:260px">' + (fund || '<span class="ficha-sub">sem trecho</span>') + '</td></tr>';
    }).join('');
    return nota + '<div class="table-wrap"><table class="rc-tabela"><thead><tr><th>Condomínio</th><th>O que a regra diz</th><th>Fundamento</th></tr></thead><tbody>' + corpo + '</tbody></table></div>';
  }

  async function compararCond() {
    var p = $('rc-comp-pergunta').value.trim();
    var out = $('rc-comp-resultado');
    if (p.length < 3) { toast('Escreva a pergunta da comparação', 'err'); return; }
    var seq = ++estado.seqComp;
    var bt = $('rc-btn-comparar'); bt.disabled = true; bt.textContent = 'Comparando...';
    out.innerHTML = '<div class="cond-loading">Comparando os condomínios. Pode levar até um minuto.</div>';
    try {
      var j = await chamar('/api/regras/comparar', { pergunta: p });
      if (seq !== estado.seqComp) return;
      out.innerHTML = tabelaComparacao(j);
    } catch (e) {
      if (seq !== estado.seqComp) return;
      out.innerHTML = '<div class="ficha-erro">' + esc(e.message) + '</div>';
    } finally {
      if (seq === estado.seqComp) { bt.disabled = false; bt.textContent = 'Comparar'; }
    }
  }

  // Lista do FAQ por tema; cada resposta abre e fecha ao clicar na pergunta.
  function renderFaq(j, id) {
    var out = $('rc-faq');
    var bt = $('rc-btn-faq');
    bt.style.display = j.pode_gerar ? '' : 'none';
    bt.textContent = (j.itens && j.itens.length) ? 'Atualizar perguntas frequentes' : 'Gerar perguntas frequentes';
    if (!j.itens || !j.itens.length) {
      out.innerHTML = '<div class="ficha-sub">Ainda não há perguntas frequentes para este condomínio.' + (j.pode_gerar ? ' Use o botão acima para gerar a partir do acervo.' : '') + '</div>';
      return;
    }
    out.innerHTML = j.itens.map(function (it, i) {
      var fund = (it.fundamentos || []).map(function (f) { return cartaoFundamento(f, id); }).join('');
      return '<div class="rc-faq-item"><div class="rc-faq-tema">' + esc(it.tema || '') + '</div>' +
        '<div class="rc-faq-perg" data-rc-faq="' + i + '">' + esc(it.pergunta) + '</div>' +
        '<div id="rc-faq-corpo-' + i + '" style="display:none">' + avisoConflito(it.conflito) + '<div class="rc-resposta" style="margin-top:6px">' + paragrafos(it.resposta) + '</div>' + fund + '</div></div>';
    }).join('') + (j.itens[0] && j.itens[0].atualizado_em ? '<div class="hint">Atualizado em ' + esc(new Date(j.itens[0].atualizado_em).toLocaleDateString('pt-BR')) + '</div>' : '');
    Array.prototype.forEach.call(out.querySelectorAll('[data-rc-faq]'), function (el) {
      el.addEventListener('click', function () {
        var c = $('rc-faq-corpo-' + el.getAttribute('data-rc-faq'));
        if (c) c.style.display = c.style.display === 'none' ? '' : 'none';
      });
    });
  }

  async function carregarFaq(forcar) {
    var id = idAtivo();
    var out = $('rc-faq');
    if (!out) return;
    if (!id) { out.innerHTML = '<div class="ficha-sub">Escolha um condomínio no seletor acima.</div>'; $('rc-btn-faq').style.display = 'none'; estado.idFaq = null; return; }
    if (!forcar && estado.idFaq === id) return;
    var seq = ++estado.seqFaq;
    estado.idFaq = id;
    out.innerHTML = '<div class="cond-loading">Carregando...</div>';
    try {
      var j = await chamar('/api/regras/' + encodeURIComponent(id) + '/faq');
      if (seq !== estado.seqFaq) return;
      renderFaq(j, id);
    } catch (e) {
      if (seq !== estado.seqFaq) return;
      estado.idFaq = null;
      out.innerHTML = '<div class="ficha-erro">' + esc(e.message) + '</div>';
    }
  }

  async function gerarFaq() {
    var id = idAtivo();
    if (!id) return;
    var bt = $('rc-btn-faq'); bt.disabled = true; var t0 = bt.textContent; bt.textContent = 'Atualizando...';
    var seq = ++estado.seqFaq;
    $('rc-faq').innerHTML = '<div class="cond-loading">Lendo o acervo tema por tema. Pode levar alguns minutos.</div>';
    try {
      var j = await chamar('/api/regras/' + encodeURIComponent(id) + '/faq/gerar', {});
      if (seq !== estado.seqFaq || idAtivo() !== id) return;
      renderFaq({ itens: j.itens, pode_gerar: true }, id);
      var sem = (j.sem_fundamento || []).length;
      toast(j.gravados ? 'Perguntas frequentes atualizadas (' + j.gravados + ' temas' + (sem ? ', ' + sem + ' sem regra no acervo' : '') + ')' : 'Nenhum tema encontrado no acervo deste condomínio', j.gravados ? 'ok' : 'warn');
    } catch (e) {
      if (seq !== estado.seqFaq) return;
      toast('Não foi possível atualizar: ' + e.message, 'err');
      estado.idFaq = null; carregarFaq(true);
    } finally { bt.disabled = false; bt.textContent = t0; }
  }

  function nomeCond() {
    var el = $('rc-cond-nome'); if (!el) return;
    var c = cond();
    el.textContent = c && c.nome ? c.nome : 'nenhum condomínio selecionado';
  }

  function abrir() {
    if (!montar()) return;
    nomeCond();
    carregarFaq(false);
  }

  window.regrasConsultaAbrir = abrir;
  window.addEventListener('regras-aba', function (e) { if (!e || !e.detail || e.detail === 'consulta') abrir(); });
  // Trocar de condomínio: a resposta e o FAQ eram do anterior. A comparação é da carteira, fica.
  window.addEventListener('condominioAtivo:trocou', function () {
    if (!estado.montado) return;
    estado.seqPerg++; estado.seqFaq++; estado.idFaq = null;
    $('rc-resultado').innerHTML = '';
    var bt = $('rc-btn-perguntar'); bt.disabled = false; bt.textContent = 'Consultar';
    nomeCond();
    var box = $('regras-consulta');
    if (box && box.offsetParent !== null) carregarFaq(true);
    else $('rc-faq').innerHTML = '';
  });
})();
