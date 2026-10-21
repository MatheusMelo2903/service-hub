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
    MODULOS_CATALOGO.entrada_documentos = { label: 'Entrada de Documentos', acoes: ['ver', 'lancar'] };
  }
  if (typeof PAGE_META !== 'undefined') PAGE_META[PAINEL] = { title: 'Entrada de Documentos', sub: 'boletos, notas e guias para lançar' };

  function podeVer() { return window.USER_ROLE === 'GESTOR' || (typeof temPermissao === 'function' ? temPermissao('entrada_documentos') : true); }
  function podeLancar() { return window.USER_ROLE === 'GESTOR' || (typeof temPermissao === 'function' && !!window.USER_PERMS && temPermissao('entrada_documentos', 'lancar')); }

  // 1. Menu (logo depois do Financeiro, ou de Cobrança) e visibilidade.
  function criarMenu() {
    if (document.getElementById('nav-entrada')) return;
    var ref = document.getElementById('nav-fincontrole');
    if (!ref) document.querySelectorAll('.nav-item').forEach(function (el) { if ((el.getAttribute('onclick') || '').indexOf("showPanel('cobranca')") >= 0) ref = el; });
    if (!ref) return;
    var item = document.createElement('div');
    item.className = 'nav-item';
    item.id = 'nav-entrada';
    item.setAttribute('onclick', "showPanel('" + PAINEL + "')");
    item.innerHTML = '<span class="nav-icon">⇣</span> Entrada de Documentos';
    ref.insertAdjacentElement('afterend', item);
  }
  criarMenu();
  function aplicarVisibilidade() {
    var item = document.getElementById('nav-entrada');
    if (item) item.style.display = podeVer() ? '' : 'none';
    var p = document.getElementById('panel-' + PAINEL);
    if (p && p.classList.contains('active') && !podeVer() && typeof showPanel === 'function') showPanel('dashboard');
  }
  if (typeof window.aplicarPermissoesSidebar === 'function') {
    var origPerm = window.aplicarPermissoesSidebar;
    window.aplicarPermissoesSidebar = function () { origPerm.apply(this, arguments); if (window.USER_PERMS) aplicarVisibilidade(); };
  }
  if (typeof window.showPanel === 'function') {
    var origShow = window.showPanel;
    window.showPanel = function (nome) {
      if (nome === PAINEL && window.USER_PERMS && !podeVer()) nome = 'dashboard';
      var r = origShow.apply(this, [nome].concat([].slice.call(arguments, 1)));
      if (nome === PAINEL) entAbrir();
      return r;
    };
  }
  document.addEventListener('auth:ready', function () {
    setTimeout(function () {
      aplicarVisibilidade();
      var p = document.getElementById('panel-' + PAINEL);
      if (p && p.classList.contains('active')) entAbrir();
    }, 0);
  });

  // 2. Utilitários.
  var est = { aberto: false, filtro: 'rascunho', itens: [], atual: null, pdfUrl: null, contas: {}, conds: null, enviando: false };
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

  async function entCarregar() {
    var alvo = document.getElementById('ent-fila');
    if (!alvo) return;
    ['rascunho', 'lancado'].forEach(function (f) { var b = document.getElementById('ent-f-' + f); if (b) b.className = 'btn ' + (est.filtro === f ? 'btn-primary' : 'btn-ghost'); });
    msg('ent-info', 'Carregando...');
    try {
      var j = await api('/api/entrada/fila?status=' + est.filtro);
      est.itens = j.itens || [];
      msg('ent-info', est.itens.length ? '' : (est.filtro === 'rascunho' ? 'Nenhum rascunho na fila.' : 'Nada lançado ainda.'));
      var aviso = document.getElementById('ent-trava');
      if (aviso) aviso.style.display = j.lancamento_liberado ? 'none' : '';
      alvo.innerHTML = est.itens.length ? '<table class="data-table" style="width:100%;font-size:12px"><thead><tr><th>Arquivo</th><th>Tipo</th><th>Condomínio</th><th>Fornecedor</th><th>Valor</th><th>Vencimento</th><th>Alertas</th><th>Situação</th></tr></thead><tbody>' +
        est.itens.map(function (it) {
          var d = it.dados || {};
          var al = (it.alertas || []);
          var graves = al.filter(function (a) { return a.nivel !== 'aviso'; }).length;
          return '<tr style="cursor:pointer" onclick="entAbrirItem(\'' + esc(it.id) + '\')"><td>' + esc(it.nome_arquivo) + '</td><td>' + esc(NOME_TIPO[d.tipo] || '') + '</td><td>' + esc(d.nome_condominio || 'a definir') +
            '</td><td>' + esc(d.nome_fornecedor || 'a definir') + '</td><td>' + esc(brl(d.valor)) + '</td><td>' + esc(dataBR(d.vencimento)) + '</td><td style="color:' + (graves ? 'var(--danger)' : 'var(--muted)') + '">' + (al.length ? al.length + (graves ? ' (' + graves + ' para resolver)' : '') : '') +
            '</td><td>' + esc(it.status === 'lancado' ? 'Lançado' + (it.id_despesa ? ' (despesa ' + it.id_despesa + ')' : '') : it.status === 'incerto' ? 'Sem confirmação' : 'Rascunho') + '</td></tr>';
        }).join('') + '</tbody></table>' : '';
    } catch (e) { msg('ent-info', e.message, true); alvo.innerHTML = ''; }
  }
  window.entCarregar = entCarregar;

  // 4. Conferência de um documento: PDF ao lado dos campos editáveis.
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
  async function desenhar() {
    var it = est.atual, d = it.dados || {};
    var card = document.getElementById('ent-detalhe');
    var editavel = it.status === 'rascunho';
    var dis = editavel ? '' : ' disabled';
    var contas = await contasDe(d.id_superlogica);
    var conds = (est.conds || []).filter(function (c) { return c.id_superlogica; });
    var optsCond = '<option value="">Escolha o condomínio</option>' + conds.map(function (c) {
      return '<option value="' + esc(c.id_superlogica) + '"' + (String(c.id_superlogica) === String(d.id_superlogica) ? ' selected' : '') + '>' + esc(c.nome) + ' (' + esc(c.id_superlogica) + ')</option>';
    }).join('');
    if (d.id_superlogica && !conds.some(function (c) { return String(c.id_superlogica) === String(d.id_superlogica); })) optsCond += '<option value="' + esc(d.id_superlogica) + '" selected>' + esc(d.nome_condominio || d.id_superlogica) + '</option>';
    var campo = function (rot, html) { return '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px">' + esc(rot) + html + '</label>'; };
    var alertas = (it.alertas || []).map(function (a) {
      var itens = (a.itens || []).map(function (x) {
        return '<div style="font-size:11px;color:var(--muted);margin-left:18px">' + esc([x.condominio, x.fornecedor, x.documento ? 'doc ' + x.documento : '', brl(x.valor), dataBR(x.vencimento), x.id_despesa ? 'despesa ' + x.id_despesa : '', x.liquidada ? 'paga' : '', x.nome_arquivo || ''].filter(Boolean).join(' · ')) + '</div>';
      }).join('');
      var marca = a.nivel === 'grave' && editavel ? '<input type="checkbox" class="ent-aceite" value="' + esc(a.codigo) + '" style="margin-right:6px">' : '';
      return '<div style="margin:4px 0"><label style="font-size:12px;color:' + (COR[a.nivel] || 'var(--text)') + '">' + marca + esc(a.texto) + (a.nivel === 'grave' && editavel ? ' (marque se conferiu)' : '') + '</label>' + itens + '</div>';
    }).join('');
    var cnpjs = (d.cnpjs || []).map(function (c) { return esc(c.cnpj) + ' (' + esc(c.papel === 'pagador' ? 'pagador ou tomador' : c.papel === 'beneficiario' ? 'beneficiário ou emitente' : 'sem rótulo') + (c.condominio ? ', condomínio' : '') + ')'; }).join('<br>');
    var res = it.resultado || {};
    card.innerHTML = '<div class="card-header"><span class="card-title">' + esc(it.nome_arquivo) + '</span>' +
      '<span style="font-size:11px;color:var(--muted);font-family:var(--mono)">' + esc(it.status === 'lancado' ? 'Lançado: despesa ' + (it.id_despesa || '') + (res.anexado === false ? ' (arquivo não anexou: anexe no Superlógica)' : '') : it.status === 'incerto' ? 'Sem confirmação do Superlógica: confira lá' : 'Rascunho') + '</span></div>' +
      '<div style="display:grid;grid-template-columns:minmax(280px,1fr) minmax(300px,1fr);gap:16px">' +
      '<div>' + (est.pdfUrl ? '<iframe src="' + esc(est.pdfUrl) + '" style="width:100%;height:640px;border:1px solid var(--border);border-radius:6px" title="Documento"></iframe>' : '<div style="font-size:12px;color:var(--muted)">Não deu para mostrar o PDF.</div>') + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px">' +
      (alertas ? '<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px">' + alertas + '</div>' : '') +
      campo('Condomínio', '<select id="ent-cond"' + dis + '>' + optsCond + '</select>') +
      campo('Fornecedor (código do Superlógica)', '<span style="display:flex;gap:8px;align-items:center"><input id="ent-forn" style="width:120px" value="' + esc(d.id_fornecedor || '') + '"' + dis + '><span style="font-size:12px">' + esc(d.nome_fornecedor || (d.cnpj_fornecedor ? 'CNPJ ' + d.cnpj_fornecedor + ' não cadastrado' : 'não encontrado')) + '</span></span>') +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      campo('Tipo', '<select id="ent-tipo"' + dis + '>' + Object.keys(NOME_TIPO).map(function (k) { return '<option value="' + k + '"' + (d.tipo === k ? ' selected' : '') + '>' + NOME_TIPO[k] + '</option>'; }).join('') + '</select>') +
      campo('Forma de pagamento', '<select id="ent-forma"' + dis + '>' + FORMAS.map(function (f) { return '<option value="' + f[0] + '"' + (Number(d.forma_pag) === f[0] ? ' selected' : '') + '>' + f[1] + '</option>'; }).join('') + '</select>') +
      campo('Valor (R$)', '<input id="ent-valor" inputmode="decimal" value="' + esc(d.valor != null ? String(d.valor.toFixed ? d.valor.toFixed(2) : d.valor).replace('.', ',') : '') + '"' + dis + '>') +
      campo('Vencimento', '<input id="ent-venc" type="date" value="' + esc(d.vencimento || '') + '"' + dis + '>') +
      campo('Número do documento', '<input id="ent-doc" maxlength="25" value="' + esc(d.documento || '') + '"' + dis + '>') +
      campo('Emissão', '<input id="ent-emissao" type="date" value="' + esc(d.emissao || '') + '"' + dis + '>') +
      '</div>' +
      campo('Linha digitável', '<input id="ent-linha" value="' + esc(d.linha || '') + '"' + dis + ' style="font-family:var(--mono)">') +
      campo('Categoria (conta)' + (d.conta_sugerida ? ' sugerida pelo último lançamento deste fornecedor' : ''), '<input id="ent-conta" list="ent-contas" value="' + esc(d.conta || '') + '"' + dis + '><datalist id="ent-contas">' + contas.map(function (c) { return '<option value="' + esc(c.conta) + '">' + esc(c.conta + ' ' + c.nome) + '</option>'; }).join('') + '</datalist>' + (d.nome_conta ? '<span style="font-size:11px;color:var(--muted)">' + esc(d.nome_conta) + '</span>' : '')) +
      campo('Complemento', '<input id="ent-compl" maxlength="200" value="' + esc(d.complemento || '') + '"' + dis + '>') +
      '<div style="font-size:11px;color:var(--muted)">CNPJs no documento:<br>' + (cnpjs || 'nenhum') + '</div>' +
      (editavel ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<button class="btn btn-ghost" onclick="entSalvar()">Salvar e conferir</button>' +
        '<button class="btn btn-ghost" onclick="entDescartar()">Descartar</button>' +
        (podeLancar() ? '<label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" id="ent-confirmo"> Confirmo lançar ' + esc(brl(d.valor) || 'sem valor') + ' no condomínio ' + esc(d.nome_condominio || 'a definir') + ' no Superlógica</label><button class="btn btn-primary" id="ent-lancar" onclick="entLancar()">Lançar</button>' : '') +
        '</div>' : '') +
      '<div id="ent-det-info"></div></div></div>';
  }

  // 5. Salvar, descartar e lançar.
  function valorCampo(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function camposTela() {
    // O valor vai como foi digitado; o servidor só aceita o formato brasileiro (1.234,56).
    var v = valorCampo('ent-valor').replace(/\s|R\$/g, '');
    return {
      id_superlogica: valorCampo('ent-cond') || null, id_fornecedor: valorCampo('ent-forn') || null, tipo: valorCampo('ent-tipo'),
      forma_pag: Number(valorCampo('ent-forma')), valor: v || null, vencimento: valorCampo('ent-venc') || null,
      documento: valorCampo('ent-doc') || null, emissao: valorCampo('ent-emissao') || null, linha: valorCampo('ent-linha') || null,
      conta: valorCampo('ent-conta') || null, complemento: valorCampo('ent-compl') || null,
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
    try {
      await api('/api/entrada/' + encodeURIComponent(est.atual.id) + '/descartar', { method: 'POST' });
      toast('Documento descartado.', 'ok');
      document.getElementById('ent-detalhe').style.display = 'none';
      est.atual = null;
      entCarregar();
    } catch (e) { msg('ent-det-info', e.message, true); }
  };
  window.entLancar = async function () {
    if (!est.atual) return;
    var conf = document.getElementById('ent-confirmo');
    if (!conf || !conf.checked) { toast('Marque a confirmação antes de lançar.', 'err'); return; }
    var aceitos = [].slice.call(document.querySelectorAll('.ent-aceite:checked')).map(function (x) { return x.value; });
    var btn = document.getElementById('ent-lancar');
    if (btn) btn.disabled = true;
    // Salva o que está na tela antes (a conferência roda de novo no servidor ao lançar). Se o
    // valor ou o condomínio mudou, a confirmação não vale: confere e marca de novo.
    var confirmado = { valor: (est.atual.dados || {}).valor, cond: (est.atual.dados || {}).id_superlogica };
    if (!(await window.entSalvar(true))) { if (btn) btn.disabled = false; return; }
    if (String((est.atual.dados || {}).valor) !== String(confirmado.valor) || String((est.atual.dados || {}).id_superlogica) !== String(confirmado.cond)) {
      msg('ent-det-info', 'O valor ou o condomínio mudou. Confira e marque a confirmação de novo.', true);
      return;
    }
    var aceitosAgora = aceitos.filter(function (c) { return (est.atual.alertas || []).some(function (a) { return a.codigo === c; }); });
    msg('ent-det-info', 'Lançando no Superlógica...');
    try {
      var j = await api('/api/entrada/' + encodeURIComponent(est.atual.id) + '/lancar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmacao: 'LANCAR', aceitar_alertas: aceitosAgora }) });
      toast('Despesa ' + j.id_despesa + ' lançada' + (j.anexado ? ' com o documento anexado.' : '. O documento não anexou: anexe no Superlógica.'), j.anexado ? 'ok' : 'warn');
      window.entAbrirItem(est.atual.id);
      entCarregar();
    } catch (e) {
      if (e.corpo && Array.isArray(e.corpo.alertas)) { est.atual.alertas = e.corpo.alertas; await desenhar(); }
      msg('ent-det-info', e.message, true);
      if (btn) btn.disabled = false;
    }
  };
})();
