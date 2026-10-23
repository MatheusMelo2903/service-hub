// ============================================================
// ENTRADA DE DOCUMENTOS (T33, substitui o Paybox): o analista sobe boletos, notas e guias em
// PDF; o servidor lê os dados, acha o condomínio pelo CNPJ do pagador ou tomador e o fornecedor
// pelo CNPJ, confere duplicidade e boleto de outro condomínio no Superlógica e guarda um
// rascunho. Na tela o rascunho é conferido, corrigido e lançado (despesa com o PDF anexado).
// Rotas: /api/entrada/*. Módulo "entrada_documentos" (ver, lancar) entra no catálogo aqui.
// O servidor confere tudo de novo: aqui é só o que aparece na tela.
// ============================================================
(function () {
  var PAINEL = 'entrada';
  if (typeof MODULOS_CATALOGO !== 'undefined' && !MODULOS_CATALOGO.entrada_documentos) {
    MODULOS_CATALOGO.entrada_documentos = { label: 'Entrada de documentos', acoes: ['ver', 'lancar'] };
  }
  if (typeof PAGE_META !== 'undefined') PAGE_META[PAINEL] = { title: 'Entrada de documentos', sub: 'boletos, notas e guias para lançar' };

  // T37: falha fechada, mesma regra do menu (index.html, podeAbrirPainel).
  function podeVer() { return typeof window.podeAbrirPainel === 'function' && window.podeAbrirPainel(PAINEL); }
  function podeLancar() { return podeVer() && (window.USER_ROLE === 'GESTOR' || (typeof temPermissao === 'function' && !!window.USER_PERMS && temPermissao('entrada_documentos', 'lancar'))); }

  // 1. O item do menu é o antigo Notas Fiscais (index.html, nav-entrada); a visibilidade fica com
  // aplicarVisibilidadePaineisFinanceiros e o showPanel do index.html recusa sem permissão.
  function painelAtivo() { var p = document.getElementById('panel-' + PAINEL); return !!(p && p.classList.contains('active')); }
  if (typeof window.showPanel === 'function') {
    var origShow = window.showPanel;
    window.showPanel = function () {
      var r = origShow.apply(this, arguments);
      if (painelAtivo() && podeVer()) entAbrir();
      return r;
    };
  }
  document.addEventListener('auth:ready', function () {
    setTimeout(function () { if (painelAtivo() && podeVer()) entAbrir(); }, 0);
  });

  // 2. Utilitários.
  var est = { aberto: false, filtro: 'rascunho', itens: [], atual: null, pdfUrl: null, contas: {}, conds: null, enviando: false, loteConfirmar: false, lotando: false };
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function brl(v) { return v == null ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function msg(id, texto, erro) { var el = document.getElementById(id); if (el) el.innerHTML = texto ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : ''; }
  async function api(url, opt) {
    var r = await apiAuthFetch(url, opt || {});
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.detalhe || ('Falha ' + r.status)); e.status = r.status; e.corpo = j; throw e; }
    return j;
  }
  var NOME_TIPO = { boleto: 'Boleto', nota: 'Nota fiscal', guia: 'Guia', fatura: 'Fatura', comprovante: 'Comprovante', outro: 'Outro' };
  var FORMAS = [[0, 'Boleto'], [12, 'Pix'], [14, 'Pix Copia e Cola'], [7, 'Débito automático'], [8, 'Transferência'], [9, 'Doc/Ted'], [13, 'DCTFWeb'], [1, 'Cheque'], [2, 'Dinheiro'], [10, 'Outros']];
  var COR = { grave: 'var(--danger)', impede: 'var(--warning)', aviso: 'var(--muted)' };

  // 3. Abertura, envio dos PDFs e fila.
  async function entAbrir() {
    if (!window.AUTH_TOKEN) return;
    if (!est.aberto) {
      est.aberto = true;
      try { est.conds = (window.CondSeletor && await window.CondSeletor.carregar()) || []; } catch (e) { est.conds = []; }
    }
    entCarregar();
  }
  window.entAbrir = entAbrir;
  window.entFiltro = function (f) { est.filtro = f; entCarregar(); };

  function lerBase64(arq) {
    return new Promise(function (ok, erro) {
      var fr = new FileReader();
      fr.onload = function () { ok(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { erro(new Error('Não deu para abrir o arquivo.')); };
      fr.readAsDataURL(arq);
    });
  }
  window.entEnviar = async function () {
    var inp = document.getElementById('ent-arquivos');
    var arqs = inp ? [].slice.call(inp.files || []) : [];
    if (!arqs.length) { toast('Escolha um ou mais PDFs.', 'err'); return; }
    if (est.enviando) return;
    est.enviando = true;
    var btn = document.getElementById('ent-enviar');
    if (btn) btn.disabled = true;
    var log = document.getElementById('ent-log');
    log.innerHTML = '';
    var linha = function (nome, texto, cor) {
      var d = document.createElement('div');
      d.style.cssText = 'font-size:12px;font-family:var(--mono);color:' + (cor || 'var(--text)');
      d.textContent = nome + ': ' + texto;
      log.appendChild(d);
    };
    var fila = arqs.slice(), ok = 0, falha = 0;
    async function trabalhar() {
      while (fila.length) {
        var a = fila.shift();
        if (!/\.pdf$/i.test(a.name) && a.type !== 'application/pdf') { linha(a.name, 'não é PDF, ignorado', 'var(--warning)'); falha++; continue; }
        if (a.size > 10 * 1024 * 1024) { linha(a.name, 'maior que 10 MB, ignorado', 'var(--warning)'); falha++; continue; }
        try {
          var b64 = await lerBase64(a);
          var j = await api('/api/entrada/ler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arquivo: { nome: a.name, base64: b64 } }) });
          var it = j.item || {}, d = it.dados || {};
          linha(a.name, (j.repetido ? 'já estava na fila; ' : 'lido; ') + (NOME_TIPO[d.tipo] || 'documento') + (d.valor ? ' ' + brl(d.valor) : '') + (d.nome_condominio ? ' ' + d.nome_condominio : ' sem condomínio'), 'var(--success)');
          ok++;
        } catch (e) { linha(a.name, e.message, 'var(--danger)'); falha++; }
      }
    }
    await Promise.all([trabalhar(), trabalhar()]);
    est.enviando = false;
    if (btn) btn.disabled = false;
    if (inp) inp.value = '';
    toast(ok + ' documento(s) lido(s)' + (falha ? ', ' + falha + ' com problema' : ''), falha ? 'warn' : 'ok');
    est.filtro = 'rascunho';
    entCarregar();
  };

  // T40: fila com seleção para o lote (só rascunho pronto e de condomínio liberado).
  var SELO = { alta: ['lido da linha digitável', 'var(--success)'], confirmado: ['conferido na tela', 'var(--success)'], baixa: ['conferir no documento', 'var(--warning)'] };
  function situacao(it) {
    var d = it.dados || {};
    if (it.status === 'lancado') return 'Lançado' + (it.id_despesa ? ' (despesa ' + it.id_despesa + ')' : '') + (it.resultado && it.resultado.lancado_por_email ? ' por ' + it.resultado.lancado_por_email : '');
    if (it.status === 'incerto') return 'Sem confirmação';
    if (it.pronto_para_lote) return it.liberado ? 'Pronto para lançar' : (d.pronto ? 'Rascunho conferido' : 'Pronto para gerar rascunho');
    return 'Falta conferir';
  }
  async function entCarregar() {
    var alvo = document.getElementById('ent-fila');
    if (!alvo) return;
    ['rascunho', 'lancado'].forEach(function (f) { var b = document.getElementById('ent-f-' + f); if (b) b.className = 'btn ' + (est.filtro === f ? 'btn-primary' : 'btn-ghost'); });
    msg('ent-info', 'Carregando...');
    est.loteConfirmar = false;
    try {
      var j = await api('/api/entrada/fila?status=' + est.filtro);
      est.itens = j.itens || [];
      msg('ent-info', est.itens.length ? '' : (est.filtro === 'rascunho' ? 'Nenhum rascunho na fila.' : 'Nada lançado ainda.'));
      var aviso = document.getElementById('ent-trava');
      if (aviso) {
        aviso.textContent = 'Por enquanto o lançamento direto só está liberado no condomínio de teste. Nos outros, o botão gera o rascunho conferido para lançar no Superlógica.';
        aviso.style.display = j.so_teste ? '' : 'none';
      }
      var lote = est.filtro === 'rascunho' && podeLancar() && est.itens.some(function (it) { return it.pronto_para_lote && it.liberado; });
      alvo.innerHTML = est.itens.length ? (lote ? '<div style="display:flex;gap:8px;align-items:center;margin:6px 0"><button class="btn btn-primary" id="ent-lote" onclick="entLancarLote()" disabled>Lançar selecionados</button><span id="ent-lote-info" style="font-size:12px;color:var(--muted);font-family:var(--mono)">Marque os documentos prontos para lançar de uma vez.</span></div>' : '') +
        '<table class="data-table" style="width:100%;font-size:12px"><thead><tr>' + (lote ? '<th></th>' : '') + '<th>Arquivo</th><th>Tipo</th><th>Condomínio</th><th>Fornecedor</th><th>Categoria</th><th>Valor</th><th>Vencimento</th><th>Alertas</th><th>Situação</th></tr></thead><tbody>' +
        est.itens.map(function (it) {
          var d = it.dados || {};
          var al = (it.alertas || []);
          var graves = al.filter(function (a) { return a.nivel !== 'aviso'; }).length;
          var marca = lote ? '<td onclick="event.stopPropagation()">' + (it.pronto_para_lote && it.liberado ? '<input type="checkbox" class="ent-sel" value="' + esc(it.id) + '" onchange="entSelecao()">' : '') + '</td>' : '';
          // Arquivo, condominio, fornecedor e categoria sao textos livres: quebram em ate 2 linhas
          // (td-livre no index.html) com o texto inteiro no title, para nao empurrar Valor e Vencimento
          var tdL = function (t) { return '<td class="td-livre" title="' + esc(t) + '"><div class="td-2l">' + esc(t) + '</div></td>'; };
          return '<tr style="cursor:pointer" onclick="entAbrirItem(\'' + esc(it.id) + '\')">' + marca + tdL(it.nome_arquivo) + '<td>' + esc(NOME_TIPO[d.tipo] || '') + '</td>' + tdL(d.nome_condominio || 'a definir') +
            tdL(d.nome_fornecedor || 'a definir') + tdL(d.conta ? d.conta + (d.nome_conta ? ' ' + d.nome_conta : '') : 'a definir') + '<td>' + esc(brl(d.valor)) + '</td><td>' + esc(dataBR(d.vencimento)) + '</td><td class="td-livre" style="color:' + (graves ? 'var(--danger)' : 'var(--muted)') + '">' + (al.length ? al.length + (graves ? ' (' + graves + ' para resolver)' : '') : '') +
            '</td><td class="td-livre">' + esc(situacao(it)) + '</td></tr>';
        }).join('') + '</tbody></table>' : '';
    } catch (e) { msg('ent-info', e.message, true); alvo.innerHTML = ''; }
  }
  window.entCarregar = entCarregar;
  function selecionados() {
    var ids = [].slice.call(document.querySelectorAll('.ent-sel:checked')).map(function (x) { return x.value; });
    return est.itens.filter(function (it) { return ids.indexOf(it.id) >= 0; });
  }
  window.entSelecao = function () {
    var s = selecionados(), b = document.getElementById('ent-lote');
    est.loteConfirmar = false;
    var total = s.reduce(function (a, it) { return a + (Number((it.dados || {}).valor) || 0); }, 0);
    if (b) { b.disabled = !s.length || s.length > 20; b.textContent = s.length ? 'Lançar ' + s.length + ' selecionado(s)' : 'Lançar selecionados'; }
    msg('ent-lote-info', s.length > 20 ? 'No máximo 20 de cada vez.' : s.length ? s.length + ' documento(s), total ' + brl(total) : 'Marque os documentos prontos para lançar de uma vez.');
  };
  // Primeiro clique mostra o total e pede o segundo; o segundo lança, um de cada vez no servidor.
  window.entLancarLote = async function () {
    var s = selecionados(), b = document.getElementById('ent-lote');
    if (!s.length || s.length > 20 || est.lotando) return;
    var total = s.reduce(function (a, it) { return a + (Number((it.dados || {}).valor) || 0); }, 0);
    if (!est.loteConfirmar) {
      est.loteConfirmar = true;
      if (b) b.textContent = 'Confirmar: lançar ' + s.length + ' documento(s), ' + brl(total);
      msg('ent-lote-info', 'Clique de novo para confirmar. Cada documento é conferido outra vez no Superlógica antes de gravar.');
      return;
    }
    est.lotando = true;
    if (b) b.disabled = true;
    msg('ent-lote-info', 'Lançando no Superlógica...');
    try {
      var j = await api('/api/entrada/lancar-lote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmacao: 'LANCAR_LOTE', itens: s.map(function (it) { return { id: it.id, valor: (it.dados || {}).valor, vencimento: (it.dados || {}).vencimento }; }) }) });
      var res = j.resultados || [];
      var ok = res.filter(function (r) { return r.ok; }).length;
      var log = document.getElementById('ent-log');
      if (log) log.innerHTML = res.map(function (r) {
        var it = s.filter(function (x) { return x.id === r.id; })[0] || {};
        return '<div style="font-size:12px;font-family:var(--mono);color:' + (r.ok ? 'var(--success)' : 'var(--danger)') + '">' + esc((it.nome_arquivo || r.id) + ': ' + (r.ok ? 'despesa ' + r.id_despesa + (r.anexado ? ' com o documento anexado' : ', documento não anexou') + (r.conferido ? '' : ', confira no Superlógica') : r.detalhe || r.erro)) + '</div>';
      }).join('') + (res.length < s.length ? '<div style="font-size:12px;color:var(--warning)">O lote parou antes do fim; os outros continuam na fila.</div>' : '');
      toast(ok + ' de ' + s.length + ' lançado(s)', ok === s.length ? 'ok' : 'warn');
    } catch (e) { toast(e.message, 'err'); }
    est.lotando = false;
    entCarregar();
  };

  // 4. Conferência de um documento: resumo da despesa pronta, botão e edição rápida ao lado do PDF.
  window.entAbrirItem = async function (id) {
    var card = document.getElementById('ent-detalhe');
    card.style.display = '';
    card.innerHTML = '<div style="font-size:12px;color:var(--muted);font-family:var(--mono)">Carregando...</div>';
    try {
      var j = await api('/api/entrada/' + encodeURIComponent(id));
      est.atual = j.item;
      if (est.pdfUrl) { URL.revokeObjectURL(est.pdfUrl); est.pdfUrl = null; }
      var r = await apiAuthFetch('/api/entrada/' + encodeURIComponent(id) + '/pdf');
      if (r.ok) est.pdfUrl = URL.createObjectURL(await r.blob());
      desenhar();
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { card.innerHTML = '<div style="color:var(--danger);font-size:12px">' + esc(e.message) + '</div>'; }
  };
  async function contasDe(idSL) {
    if (!idSL) return [];
    if (est.contas[idSL]) return est.contas[idSL];
    try { var j = await api('/api/entrada/contas/' + encodeURIComponent(idSL)); est.contas[idSL] = j.contas || []; } catch (e) { est.contas[idSL] = []; }
    return est.contas[idSL];
  }
  function selo(nivel) { var s = SELO[nivel] || SELO.baixa; return '<span style="font-size:10px;font-family:var(--mono);color:' + s[1] + '">' + esc(s[0]) + '</span>'; }
  async function desenhar() {
    var it = est.atual, d = it.dados || {};
    var card = document.getElementById('ent-detalhe');
    var editavel = it.status === 'rascunho';
    var dis = editavel ? '' : ' disabled';
    var cf = it.confianca || {};
    var contas = await contasDe(d.id_superlogica);
    var conds = (est.conds || []).filter(function (c) { return c.id_superlogica; });
    var optsCond = '<option value="">Escolha o condomínio</option>' + conds.map(function (c) {
      return '<option value="' + esc(c.id_superlogica) + '"' + (String(c.id_superlogica) === String(d.id_superlogica) ? ' selected' : '') + '>' + esc(c.nome) + ' (' + esc(c.id_superlogica) + ')</option>';
    }).join('');
    if (d.id_superlogica && !conds.some(function (c) { return String(c.id_superlogica) === String(d.id_superlogica); })) optsCond += '<option value="' + esc(d.id_superlogica) + '" selected>' + esc(d.nome_condominio || d.id_superlogica) + '</option>';
    var campo = function (rot, html) { return '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px">' + esc(rot) + html + '</label>'; };
    var al = it.alertas || [];
    var alertas = al.map(function (a) {
      var itens = (a.itens || []).map(function (x) {
        return '<div style="font-size:11px;color:var(--muted);margin-left:18px">' + esc([x.condominio, x.fornecedor, x.documento ? 'doc ' + x.documento : '', brl(x.valor), dataBR(x.vencimento), x.id_despesa ? 'despesa ' + x.id_despesa : '', x.liquidada ? 'paga' : '', x.nome_arquivo || ''].filter(Boolean).join(' · ')) + '</div>';
      }).join('');
      var marca = a.nivel === 'grave' && editavel ? '<input type="checkbox" class="ent-aceite" value="' + esc(a.codigo) + '" style="margin-right:6px">' : '';
      return '<div style="margin:4px 0"><label style="font-size:12px;color:' + (COR[a.nivel] || 'var(--text)') + '">' + marca + esc(a.texto) + (a.quantidade ? ' (' + esc(a.quantidade) + ')' : '') + (marca ? ' (marque se conferiu)' : '') + '</label>' + itens + '</div>';
    }).join('');
    // Valor ou vencimento a conferir não trava o botão: o "conferi" vai junto ao salvar antes de lançar.
    var impede = al.some(function (a) { return a.nivel === 'impede' && a.codigo !== 'confirmar_valor' && a.codigo !== 'confirmar_vencimento'; });
    var aConferir = al.some(function (a) { return a.codigo === 'confirmar_valor' || a.codigo === 'confirmar_vencimento'; });
    var cnpjs = (d.cnpjs || []).map(function (c) { return esc(c.cnpj) + ' (' + esc(c.papel === 'pagador' ? 'pagador ou tomador' : c.papel === 'beneficiario' ? 'beneficiário ou emitente' : 'sem rótulo') + (c.condominio ? ', condomínio' : '') + ')'; }).join('<br>');
    var res = it.resultado || {};
    var linhaRes = function (rot, val) { return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border)"><span style="color:var(--muted)">' + esc(rot) + '</span><span style="text-align:right">' + val + '</span></div>'; };
    var resumo = '<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px">' +
      '<div style="font-size:12px;font-weight:600;margin-bottom:4px">' + (editavel ? 'Despesa pronta para lançar' : 'Despesa') + '</div>' +
      linhaRes('Condomínio', esc(d.nome_condominio ? d.nome_condominio + ' (' + d.id_superlogica + ')' : 'a definir')) +
      linhaRes('Fornecedor', esc(d.nome_fornecedor ? d.nome_fornecedor + ' (' + d.id_fornecedor + ')' : 'a definir')) +
      linhaRes('Categoria', esc(d.conta ? d.conta + ' ' + (d.nome_conta || '') : 'a definir') + (d.conta_sugerida ? '<br><span style="font-size:10px;color:var(--muted)">sugerida pelo histórico deste fornecedor no condomínio' + (d.conta_sugerida_vezes ? ' (' + esc(d.conta_sugerida_vezes) + ')' : '') + '</span>' : '')) +
      linhaRes('Valor', '<b>' + esc(brl(d.valor) || 'a definir') + '</b>' + (d.valor ? '<br>' + selo(cf.valor) : '')) +
      linhaRes('Vencimento', esc(dataBR(d.vencimento) || 'a definir') + (d.vencimento ? '<br>' + selo(cf.vencimento) : '')) +
      linhaRes('Conta bancária', esc(d.nome_contabanco || 'principal do condomínio')) +
      linhaRes('Anexo', esc(it.nome_arquivo) + (it.status === 'lancado' ? (res.anexado === false ? ' (não anexou: anexe no Superlógica)' : ' (anexado)') : ' (vai anexado)')) +
      (d.pronto ? linhaRes('Rascunho conferido', esc((d.pronto.por || '') + ' ' + dataBR(d.pronto.em))) : '') +
      (it.status === 'lancado' ? linhaRes('Lançado', esc('despesa ' + (it.id_despesa || '') + (res.lancado_por_email ? ' por ' + res.lancado_por_email : '') + ' ' + dataBR(it.lancado_em)) + (res.conferido === false ? '<br><span style="color:var(--warning)">a releitura não bateu: confira no Superlógica</span>' : '')) : '') +
      '</div>';
    var botao = '';
    if (editavel) {
      if (it.liberado && podeLancar()) botao = '<button class="btn btn-primary" id="ent-lancar" onclick="entLancar()"' + (impede ? ' disabled title="Resolva os itens em amarelo"' : '') + '>Lançar ' + esc(brl(d.valor) || '') + '</button>';
      else botao = '<button class="btn btn-primary" id="ent-pronto" onclick="entPronto()"' + (impede ? ' disabled title="Resolva os itens em amarelo"' : '') + '>Gerar rascunho</button>' +
        '<span style="font-size:11px;color:var(--muted)">' + (it.liberado ? 'Seu usuário não lança por aqui.' : 'Lançamento direto não liberado para este condomínio: o rascunho fica conferido para lançar no Superlógica.') + '</span>';
    }
    var conferi = function (id, nivel) { return editavel && nivel === 'baixa' ? '<label style="font-size:11px;display:flex;gap:4px;align-items:center;color:var(--warning)"><input type="checkbox" id="' + id + '"> conferi no documento</label>' : ''; };
    card.innerHTML = '<div class="card-header"><span class="card-title">' + esc(it.nome_arquivo) + '</span>' +
      '<span style="font-size:11px;color:var(--muted);font-family:var(--mono)">' + esc(situacao(it)) + '</span></div>' +
      '<div style="display:grid;grid-template-columns:minmax(280px,1fr) minmax(300px,1fr);gap:16px">' +
      '<div>' + (est.pdfUrl ? '<iframe src="' + esc(est.pdfUrl) + '" style="width:100%;height:640px;border:1px solid var(--border);border-radius:6px" title="Documento"></iframe>' : '<div style="font-size:12px;color:var(--muted)">Não deu para mostrar o PDF.</div>') + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px">' + resumo +
      (alertas ? '<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px">' + alertas + '</div>' : '') +
      (botao ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + botao + '</div>' : '') +
      '<div id="ent-det-info"></div>' +
      '<details' + (editavel && (impede || aConferir) ? ' open' : '') + ' style="border:1px solid var(--border);border-radius:6px;padding:8px 10px"><summary style="font-size:12px;cursor:pointer">' + (editavel ? 'Editar' : 'Detalhes') + '</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">' +
      campo('Condomínio', '<select id="ent-cond"' + dis + '>' + optsCond + '</select>') +
      campo('Fornecedor (código do Superlógica)', '<span style="display:flex;gap:8px;align-items:center"><input id="ent-forn" style="width:120px" value="' + esc(d.id_fornecedor || '') + '"' + dis + '><span style="font-size:12px">' + esc(d.nome_fornecedor || (d.cnpj_fornecedor ? 'CNPJ ' + d.cnpj_fornecedor + ' não cadastrado' : 'não encontrado')) + '</span></span>') +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      campo('Tipo', '<select id="ent-tipo"' + dis + '>' + Object.keys(NOME_TIPO).map(function (k) { return '<option value="' + k + '"' + (d.tipo === k ? ' selected' : '') + '>' + NOME_TIPO[k] + '</option>'; }).join('') + '</select>') +
      campo('Forma de pagamento', '<select id="ent-forma"' + dis + '>' + FORMAS.map(function (f) { return '<option value="' + f[0] + '"' + (Number(d.forma_pag) === f[0] ? ' selected' : '') + '>' + f[1] + '</option>'; }).join('') + '</select>') +
      campo('Valor (R$)', '<input id="ent-valor" inputmode="decimal" value="' + esc(d.valor != null ? String(d.valor.toFixed ? d.valor.toFixed(2) : d.valor).replace('.', ',') : '') + '"' + dis + '>' + conferi('ent-conf-valor', cf.valor)) +
      campo('Vencimento', '<input id="ent-venc" type="date" value="' + esc(d.vencimento || '') + '"' + dis + '>' + conferi('ent-conf-venc', cf.vencimento)) +
      campo('Número do documento', '<input id="ent-doc" maxlength="25" value="' + esc(d.documento || '') + '"' + dis + '>') +
      campo('Emissão', '<input id="ent-emissao" type="date" value="' + esc(d.emissao || '') + '"' + dis + '>') +
      '</div>' +
      campo('Linha digitável', '<input id="ent-linha" value="' + esc(d.linha || '') + '"' + dis + ' style="font-family:var(--mono)">') +
      campo('Categoria (conta)', '<input id="ent-conta" list="ent-contas" value="' + esc(d.conta || '') + '"' + dis + '><datalist id="ent-contas">' + contas.map(function (c) { return '<option value="' + esc(c.conta) + '">' + esc(c.conta + ' ' + c.nome) + '</option>'; }).join('') + '</datalist>' + (d.nome_conta ? '<span style="font-size:11px;color:var(--muted)">' + esc(d.nome_conta) + '</span>' : '')) +
      campo('Complemento', '<input id="ent-compl" maxlength="200" value="' + esc(d.complemento || '') + '"' + dis + '>') +
      '<div style="font-size:11px;color:var(--muted)">CNPJs no documento:<br>' + (cnpjs || 'nenhum') + '</div>' +
      (editavel ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<button class="btn btn-ghost" onclick="entSalvar()">Salvar e conferir</button>' +
        '<button class="btn btn-ghost" onclick="entDescartar()">Descartar</button></div>' : '') +
      '</div></details></div></div>';
  }

  // 5. Salvar, descartar, gerar rascunho e lançar.
  function valorCampo(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function marcado(id) { var el = document.getElementById(id); return !!(el && el.checked); }
  function camposTela() {
    // O valor vai como foi digitado; o servidor só aceita o formato brasileiro (1.234,56).
    var v = valorCampo('ent-valor').replace(/\s|R\$/g, '');
    return {
      id_superlogica: valorCampo('ent-cond') || null, id_fornecedor: valorCampo('ent-forn') || null, tipo: valorCampo('ent-tipo'),
      forma_pag: Number(valorCampo('ent-forma')), valor: v || null, vencimento: valorCampo('ent-venc') || null,
      documento: valorCampo('ent-doc') || null, emissao: valorCampo('ent-emissao') || null, linha: valorCampo('ent-linha') || null,
      conta: valorCampo('ent-conta') || null, complemento: valorCampo('ent-compl') || null,
      confirmar_valor: marcado('ent-conf-valor'), confirmar_vencimento: marcado('ent-conf-venc'),
    };
  }
  window.entSalvar = async function (silencioso) {
    if (!est.atual) return false;
    var antes = (est.atual.dados || {}).id_superlogica;
    var c = camposTela();
    if (String(c.id_superlogica || '') !== String(antes || '')) c.conta = c.conta && est.contas[c.id_superlogica] && est.contas[c.id_superlogica].some(function (x) { return x.conta === c.conta; }) ? c.conta : null;
    msg('ent-det-info', 'Conferindo no Superlógica...');
    try {
      var j = await api('/api/entrada/' + encodeURIComponent(est.atual.id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
      est.atual = j.item;
      await desenhar();
      if (!silencioso) toast('Rascunho salvo e conferido.', 'ok');
      entCarregar();
      return true;
    } catch (e) { msg('ent-det-info', e.message, true); return false; }
  };
  window.entDescartar = async function () {
    if (!est.atual) return;
    // T48: tira o documento da fila; confirma antes.
    if (!confirm('Descartar este documento da fila? Ele não será lançado.')) return;
    try {
      await api('/api/entrada/' + encodeURIComponent(est.atual.id) + '/descartar', { method: 'POST' });
      toast('Documento descartado.', 'ok');
      document.getElementById('ent-detalhe').style.display = 'none';
      est.atual = null;
      entCarregar();
    } catch (e) { msg('ent-det-info', e.message, true); }
  };
  // Condomínio fora da lista de lançamento direto: confere e marca o rascunho (nada vai ao Superlógica).
  window.entPronto = async function () {
    if (!est.atual) return;
    var btn = document.getElementById('ent-pronto');
    if (btn) btn.disabled = true;
    // Marcas lidas antes de salvar (salvar redesenha a tela).
    var marcados = [].slice.call(document.querySelectorAll('.ent-aceite:checked')).map(function (x) { return x.value; });
    if (!(await window.entSalvar(true))) { if (btn) btn.disabled = false; return; }
    var aceitos = marcados.filter(function (c) { return (est.atual.alertas || []).some(function (a) { return a.codigo === c; }); });
    try {
      var j = await api('/api/entrada/' + encodeURIComponent(est.atual.id) + '/pronto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aceitar_alertas: aceitos }) });
      est.atual = j.item;
      await desenhar();
      toast('Rascunho conferido. Lance no Superlógica com estes dados.', 'ok');
      entCarregar();
    } catch (e) {
      if (e.corpo && e.corpo.item) { est.atual = e.corpo.item; await desenhar(); }
      msg('ent-det-info', e.message, true);
    }
  };
  window.entLancar = async function () {
    if (!est.atual) return;
    var aceitos = [].slice.call(document.querySelectorAll('.ent-aceite:checked')).map(function (x) { return x.value; });
    var btn = document.getElementById('ent-lancar');
    if (btn) btn.disabled = true;
    // Salva o que está na tela antes (a conferência roda de novo no servidor ao lançar). Se o
    // valor, o vencimento ou o condomínio mudou, o botão mostrava outra coisa: confere e clica de novo.
    var visto = { valor: (est.atual.dados || {}).valor, venc: (est.atual.dados || {}).vencimento, cond: (est.atual.dados || {}).id_superlogica };
    if (!(await window.entSalvar(true))) { if (btn) btn.disabled = false; return; }
    var dn = est.atual.dados || {};
    if (String(dn.valor) !== String(visto.valor) || String(dn.vencimento) !== String(visto.venc) || String(dn.id_superlogica) !== String(visto.cond)) {
      msg('ent-det-info', 'Os dados mudaram. Confira o resumo e clique em Lançar de novo.', true);
      return;
    }
    var aceitosAgora = aceitos.filter(function (c) { return (est.atual.alertas || []).some(function (a) { return a.codigo === c; }); });
    msg('ent-det-info', 'Lançando no Superlógica...');
    try {
      var j = await api('/api/entrada/' + encodeURIComponent(est.atual.id) + '/lancar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmacao: 'LANCAR', aceitar_alertas: aceitosAgora }) });
      var tudo = j.anexado && j.conferido;
      toast('Despesa ' + j.id_despesa + ' lançada' + (j.anexado ? ' com o documento anexado' : '; o documento não anexou: anexe no Superlógica') + (j.conferido ? '.' : '; a releitura não bateu: confira no Superlógica.'), tudo ? 'ok' : 'warn');
      window.entAbrirItem(est.atual.id);
      entCarregar();
    } catch (e) {
      if (e.corpo && Array.isArray(e.corpo.alertas)) { est.atual.alertas = e.corpo.alertas; await desenhar(); }
      msg('ent-det-info', e.message, true);
      var b2 = document.getElementById('ent-lancar');
      if (b2) b2.disabled = false;
    }
  };
})();
