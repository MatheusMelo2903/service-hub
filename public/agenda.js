// ─────────────────────────────────────────────────────────────────────────
// Agenda do mês (cronograma da empresa) e Painel da gestão.
// A equipe manda a agenda do mês (texto colado, planilha, PDF ou foto, ou item por item), o
// servidor organiza em assembleias e tarefas e monta o plano: prestação de contas, apresentação,
// dia das certidões, pedido de material ao síndico, previsão e ata, cada um com a data certa.
// A gestão aprova o plano (tudo ou item a item) e o sistema faz o trabalho nas datas, deixando o
// resultado na pasta Em andamento para conferir. Regras e rotas: servico/agenda.js e
// servico/rotas-agenda.js. O Painel da gestão (cronograma, pronto e travado, tendências) é uma
// tela à parte, só para o dono e para quem recebeu o módulo gestao_painel.
// Os itens de menu e as telas são criados aqui (index.html só carrega este arquivo).
// ─────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  var PAINEL = 'agenda';
  var PAINEL_G = 'gestao';
  if (typeof PAGE_META !== 'undefined') {
    PAGE_META[PAINEL] = { title: 'Agenda do mês', sub: 'assembleias do mês e o plano do que preparar' };
    PAGE_META[PAINEL_G] = { title: 'Painel da gestão', sub: 'cronograma, pendências e tendências dos meses' };
  }
  if (typeof MODULOS_CATALOGO !== 'undefined') {
    if (!MODULOS_CATALOGO.agenda) MODULOS_CATALOGO.agenda = { label: 'Agenda do mês', acoes: ['ver', 'cadastrar'] };
    if (!MODULOS_CATALOGO.gestao_painel && window.USER_ROLE !== 'GERENTE' && window.USER_ROLE !== 'OPERACIONAL') MODULOS_CATALOGO.gestao_painel = { label: 'Painel da gestão (só o gestor libera)', acoes: ['ver'] };
  }

  var ROT_STATUS = { agendada: 'Agendada', pendente_material: 'Pendente de material', rodando: 'Rodando', pronta_conferir: 'Pronta para conferir', conferida: 'Conferida', erro: 'Erro', manual: 'Com a equipe', cancelada: 'Cancelada' };
  var COR_STATUS = { agendada: '#5B8DEF', pendente_material: '#E0A100', rodando: '#7C5CFF', pronta_conferir: '#1BA672', conferida: '#0E7A50', erro: '#D64545', manual: '#8B95A8', cancelada: '#9AA0A6' };
  var ROT_TIPO = { prestacao_contas: 'Prestação de contas', apresentacao: 'Apresentação', certidoes: 'Dia das certidões', pedir_material: 'Pedir material ao síndico', previsao_orcamentaria: 'Previsão orçamentária', ata: 'Ata', outra: 'Tarefa' };
  var ROT_TRAB = { prestacao_contas: 'Prestação de contas', eleicao: 'Eleição', previsao_orcamentaria: 'Previsão', regimento: 'Regimento', obra_orcamentos: 'Obra e orçamentos', assuntos_gerais: 'Assuntos gerais', outro: 'Outro assunto' };
  var ROT_MOTIVO = { falta_edital: 'Falta o edital', falta_orcamentos: 'Faltam orçamentos ou fotos do síndico', condominio_nao_reconhecido: 'Condomínio não reconhecido', sem_data: 'Sem período', periodo_aberto: 'Período ainda não fechou', superlogica: 'O Superlógica não respondeu', geracao: 'A geração não terminou', sem_responsavel: 'Sem responsável', assembleia_passou: 'A assembleia já aconteceu', removida_do_plano: 'Saiu do plano' };
  var DIAS_SEM = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  var est = { mes: mesAtual(), dados: null, previa: null, naoEntendido: [], aba: 'texto', vista: 'lista', ocupado: false, pendente: false, pendenteG: false, gMes: mesAtual(), gDados: null };

  // ── utilidades ──
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function aviso(m, t) { if (typeof toast === 'function') toast(m, t || 'info'); }
  // Janela da própria tela no lugar das caixas do navegador (que o Hub não usa).
  // op: { titulo, texto?, campos?: [{ nome, rotulo, valor, tipo: text|date|time|textarea|select, opcoes?: [[valor, rótulo]], somenteLeitura? }],
  //       sim?: 'Confirmar', nao?: 'Cancelar' (null esconde) }. Resolve null no Cancelar ou Esc;
  // sem campos resolve true; com campos resolve { nome: valor }.
  function janela(op) {
    return new Promise(function (fim) {
      var fundo = document.createElement('div');
      fundo.className = 'modal-overlay open'; fundo.style.zIndex = '1000';
      fundo.setAttribute('role', 'dialog'); fundo.setAttribute('aria-modal', 'true');
      var campos = op.campos || [];
      var html = '<div class="modal" style="width:520px;max-width:95vw"><div class="modal-title">' + esc(op.titulo) + '</div>'
        + (op.texto ? '<p style="font-size:13px;margin:8px 0 0;white-space:pre-wrap">' + esc(op.texto) + '</p>' : '')
        + campos.map(function (c, i) {
          var id = 'ag-jan-' + i; var ro = c.somenteLeitura ? ' readonly' : '';
          var v = c.valor == null ? '' : String(c.valor);
          var ctrl = c.tipo === 'textarea' ? '<textarea id="' + id + '" rows="' + (c.linhas || 6) + '"' + ro + ' style="width:100%;box-sizing:border-box">' + esc(v) + '</textarea>'
            : c.tipo === 'select' ? '<select id="' + id + '" style="width:100%">' + (c.opcoes || []).map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === v ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'
              : '<input id="' + id + '" type="' + (c.tipo || 'text') + '" value="' + esc(v) + '"' + ro + ' autocomplete="off" style="width:100%;box-sizing:border-box;padding:6px 8px">';
          return '<label style="display:block;font-size:12px;margin-top:10px">' + esc(c.rotulo || '') + ctrl + '</label>';
        }).join('')
        + '<div class="modal-actions">' + (op.nao === null ? '' : '<button type="button" class="btn btn-ghost" data-jan="nao">' + esc(op.nao || 'Cancelar') + '</button>')
        + '<button type="button" class="btn btn-primary" data-jan="sim">' + esc(op.sim || 'Confirmar') + '</button></div></div>';
      fundo.innerHTML = html;
      document.body.appendChild(fundo);
      function fechar(ok) {
        if (!fundo.parentNode) return;
        var r = null;
        if (ok) {
          if (!campos.length) r = true;
          else { r = {}; campos.forEach(function (c, i) { r[c.nome] = fundo.querySelector('#ag-jan-' + i).value; }); }
        }
        fundo.remove(); document.removeEventListener('keydown', tecla, true); fim(r);
      }
      function tecla(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); fechar(op.nao === null); }
        else if (ev.key === 'Enter' && ev.target && ev.target.tagName !== 'TEXTAREA' && fundo.contains(ev.target)) { ev.preventDefault(); fechar(true); }
      }
      document.addEventListener('keydown', tecla, true);
      fundo.querySelector('[data-jan="sim"]').onclick = function () { fechar(true); };
      var bn = fundo.querySelector('[data-jan="nao"]'); if (bn) bn.onclick = function () { fechar(false); };
      setTimeout(function () { var f = fundo.querySelector('input:not([readonly]),textarea:not([readonly]),select') || fundo.querySelector('[data-jan="sim"]'); if (f) f.focus(); }, 0);
    });
  }
  function confirmar(titulo, texto, sim) { return janela({ titulo: titulo, texto: texto, sim: sim || 'Confirmar' }); }
  function mesAtual() { var d = new Date(Date.now() - 3 * 3600000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
  function dataBr(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] : ''; }
  function dataBrAno(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function mesRot(m) { var p = String(m || '').split('-'); return p.length === 2 ? MESES[Number(p[1]) - 1] + ' de ' + p[0] : ''; }
  function tipoAss(t) { return t === 'AGO_AGE' ? 'AGO e AGE' : (t || ''); }
  function usd(v) { return 'US$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function badge(status, aprovacao) {
    if (aprovacao === 'pendente' && status !== 'cancelada') return '<span class="ag-badge" style="background:#F2E6C9;color:#7A5A00">Aguardando aprovação</span>';
    return '<span class="ag-badge" style="background:' + (COR_STATUS[status] || '#888') + '22;color:' + (COR_STATUS[status] || '#888') + '">' + esc(ROT_STATUS[status] || status) + '</span>';
  }
  async function api(url, op) {
    var r = await window.apiAuthFetch(url, op || {});
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.detalhe || j.erro || textoFalha(r.status));
    return j;
  }
  function postJson(url, corpo, metodo) { return api(url, { method: metodo || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) }); }
  function arquivoB64(f) {
    return new Promise(function (ok, falha) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { falha(new Error('Não deu para ler o arquivo.')); };
      r.readAsDataURL(f);
    });
  }
  // Foto vira JPG de até 1920 px (a apresentação só aceita JPG e o envio fica leve).
  function fotoJpeg(f) {
    return new Promise(function (ok, falha) {
      var url = URL.createObjectURL(f); var img = new Image();
      img.onload = function () {
        var k = Math.min(1, 1920 / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? ok(b) : falha(new Error('Não deu para converter a foto.')); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); falha(new Error('Foto em formato que o navegador não abre.')); };
      img.src = url;
    });
  }

  // ── permissões (o servidor confere de novo em cada rota) ──
  function perm(m, a) { var p = window.USER_PERMS && window.USER_PERMS[m]; return !!(p && p.visivel === true && Array.isArray(p.acoes) && (!a || p.acoes.indexOf(a) >= 0)); }
  function podeVer() { if (!window.USER_PERMS) return false; return window.USER_ROLE === 'GESTOR' || window.USER_ROLE === 'GERENTE' || perm('agenda'); }
  function ehDono() { var c = window.USER_PERMS && window.USER_PERMS.configuracoes; return !!(c && Array.isArray(c.acoes) && c.acoes.indexOf('auditoria_total') >= 0); }
  function podeGestao() { if (!window.USER_PERMS) return false; return ehDono() || perm('gestao_painel', 'ver'); }

  // ── estilo ──
  (function estilo() {
    if (document.getElementById('agenda-estilo')) return;
    var st = document.createElement('style'); st.id = 'agenda-estilo';
    st.textContent = [
      '.ag-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap}',
      '.ag-abas{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.ag-abas button.on{background:var(--gs-blue);color:#fff}',
      '.ag-tab{width:100%;border-collapse:collapse;font-size:12px}.ag-tab th,.ag-tab td{border-top:1px solid var(--border);padding:6px;text-align:left;vertical-align:top}',
      '.ag-tab input,.ag-tab select,.ag-tab textarea{width:100%;font-size:12px;box-sizing:border-box}',
      '.ag-aviso{color:#B26A00;font-size:11px}.ag-erro{color:var(--danger,#D64545);font-size:11px}.ag-mut{color:var(--muted);font-size:11px}',
      '.ag-cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}.ag-cal .d{border:1px solid var(--border);border-radius:6px;min-height:78px;padding:4px;font-size:11px;overflow:hidden}',
      '.ag-cal .h{font-weight:700;text-align:center;font-size:11px;color:var(--muted)}.ag-cal .hoje{outline:2px solid var(--gs-blue)}',
      '.ag-chip{display:block;border-radius:4px;padding:1px 4px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ag-item{border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:10px}',
      '.ag-linha{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border);padding:6px 0}',
      '.ag-grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}',
      '.ag-barra{height:8px;border-radius:4px;background:var(--gs-blue)}',
      '@media (max-width:700px){.ag-cal{grid-template-columns:repeat(2,minmax(0,1fr))}.ag-cal .h{display:none}}'
    ].join('\n');
    document.head.appendChild(st);
  })();

  // ── menu e telas ──
  function criarMenu() {
    var ref = document.getElementById('nav-centralalertas');
    if (!ref) document.querySelectorAll('.nav-item').forEach(function (el) { if (!ref && (el.getAttribute('onclick') || '').indexOf("showPanel('dashboard')") >= 0) ref = el; });
    if (!ref) return;
    [[PAINEL_G, '◈', 'Painel da gestão'], [PAINEL, '▦', 'Agenda do mês']].forEach(function (x) {
      if (document.getElementById('nav-' + x[0])) return;
      var item = document.createElement('div');
      item.className = 'nav-item'; item.id = 'nav-' + x[0]; item.style.display = 'none';
      item.setAttribute('onclick', "showPanel('" + x[0] + "')");
      item.innerHTML = '<span class="nav-icon">' + x[1] + '</span> ' + x[2];
      ref.insertAdjacentElement('afterend', item);
    });
  }
  function criarPaineis() {
    var dash = document.getElementById('panel-dashboard');
    if (!dash) return;
    if (!document.getElementById('panel-' + PAINEL)) {
      var p = document.createElement('div'); p.className = 'panel'; p.id = 'panel-' + PAINEL;
      p.innerHTML = '<div class="card"><div class="card-header" style="flex-wrap:wrap;gap:10px"><span class="card-title">Agenda do mês</span>'
        + '<div style="display:flex;gap:6px;align-items:center"><input type="month" id="ag-mes" aria-label="Mês"><button class="btn btn-ghost" id="ag-atualizar" type="button">Atualizar</button></div></div>'
        + '<p class="hint" style="margin:0">A equipe manda a agenda do mês; o sistema monta o plano do que preparar para cada assembleia. Depois que a gestão aprova, tudo é feito nas datas e fica na pasta Em andamento para conferir. Nada é enviado a condômino.</p>'
        + '<div id="ag-avisos"></div></div>'
        + '<div class="card" id="ag-entrada"></div>'
        + '<div class="card" id="ag-previa" style="display:none"></div>'
        + '<div class="card" id="ag-plano"></div>'
        + '<div class="card" id="ag-painel"></div>'
        + '<div class="card" id="ag-config" style="display:none"></div>';
      dash.insertAdjacentElement('afterend', p);
    }
    if (!document.getElementById('panel-' + PAINEL_G)) {
      var g = document.createElement('div'); g.className = 'panel'; g.id = 'panel-' + PAINEL_G;
      g.innerHTML = '<div class="card"><div class="card-header" style="flex-wrap:wrap;gap:10px"><span class="card-title">Painel da gestão</span>'
        + '<div style="display:flex;gap:6px;align-items:center"><input type="month" id="ag-g-mes" aria-label="Mês"><button class="btn btn-ghost" id="ag-g-atualizar" type="button">Atualizar</button></div></div>'
        + '<p class="hint" style="margin:0">Visão da gestão: o cronograma do mês, o que está pronto, o que travou e por quê, e a comparação com os meses anteriores. Os documentos continuam na pasta Em andamento de quem cuida de cada condomínio.</p></div>'
        + '<div class="card" id="ag-g-resumo"></div><div class="card" id="ag-g-tend"></div><div class="card" id="ag-g-crono"></div>';
      dash.insertAdjacentElement('afterend', g);
    }
    var m = document.getElementById('ag-mes'); m.value = est.mes;
    m.onchange = function () { if (/^\d{4}-\d{2}$/.test(m.value)) { est.mes = m.value; est.previa = null; carregar(); } };
    document.getElementById('ag-atualizar').onclick = function () { carregar(); };
    var gm = document.getElementById('ag-g-mes'); gm.value = est.gMes;
    gm.onchange = function () { if (/^\d{4}-\d{2}$/.test(gm.value)) { est.gMes = gm.value; carregarGestao(); } };
    document.getElementById('ag-g-atualizar').onclick = function () { carregarGestao(); };
  }

  // ── carregar ──
  async function carregar() {
    if (!window.AUTH_TOKEN) return;
    // Lista de condomínios da carteira para corrigir a prévia (o seletor do Hub já carrega).
    try { if (window.CondSeletor && typeof CondSeletor.carregar === 'function') Promise.resolve(CondSeletor.carregar()).then(function () { if (est.previa) desenharPrevia(); }); } catch (e) { /* segue sem a lista */ }
    try { est.dados = await api('/api/agenda/mes/' + est.mes, { cache: 'no-store' }); }
    catch (e) { est.dados = null; document.getElementById('ag-plano').innerHTML = '<div class="ag-erro">' + esc(e.message) + '</div>'; return; }
    desenhar();
  }
  function desenhar() {
    desenharAvisos(); desenharEntrada(); desenharPrevia(); desenharPlano(); desenharPainel(); desenharConfig();
  }

  // ── avisos ──
  function desenharAvisos() {
    var box = document.getElementById('ag-avisos'); var d = est.dados;
    var l = (d && d.avisos) || [];
    if (!l.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div style="margin-top:10px;border:1px solid var(--border);border-radius:8px;padding:8px"><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:13px">Avisos (' + l.length + ')</b><button class="btn btn-ghost" id="ag-lidos" type="button" style="font-size:11px">Marcar como lidos</button></div>'
      + l.map(function (a, i) {
        return '<div class="ag-linha"><span style="flex:1;font-size:12px">' + esc(a.texto) + '</span>'
          + (a.mensagem ? '<button class="btn btn-ghost ag-copiar" data-i="' + i + '" type="button" style="font-size:11px">Copiar mensagem</button>' : '') + '</div>';
      }).join('') + '</div>';
    box.querySelectorAll('.ag-copiar').forEach(function (b) {
      b.onclick = function () {
        var a = l[Number(b.dataset.i)];
        // Sem acesso à área de transferência: mostra a mensagem para copiar à mão.
        var mostrar = function () { janela({ titulo: 'Copie a mensagem', campos: [{ nome: 'm', valor: a.mensagem, tipo: 'textarea', somenteLeitura: true }], sim: 'Fechar', nao: null }); };
        try { navigator.clipboard.writeText(a.mensagem).then(function () { aviso('Mensagem copiada.', 'ok'); }, mostrar); } catch (e) { mostrar(); }
      };
    });
    document.getElementById('ag-lidos').onclick = async function () {
      try { await postJson('/api/agenda/avisos/lidos', { ids: l.map(function (a) { return a.id; }) }); carregar(); } catch (e) { aviso(e.message, 'err'); }
    };
  }

  // ── entrada da agenda ──
  function desenharEntrada() {
    var box = document.getElementById('ag-entrada'); var d = est.dados;
    if (!d || !d.pode.cadastrar) { box.style.display = 'none'; return; }
    box.style.display = '';
    var abas = [['texto', 'Colar texto'], ['planilha', 'Planilha'], ['arquivo', 'PDF ou foto'], ['manual', 'Um por um']];
    var corpo = '';
    if (est.aba === 'texto') corpo = '<textarea id="ag-texto" rows="7" style="width:100%;box-sizing:border-box" placeholder="Cole aqui a agenda do mês como a equipe mandou (mensagem, e-mail ou lista)."></textarea>'
      + '<button class="btn btn-primary" id="ag-ler" type="button" style="margin-top:8px">Ler agenda</button>';
    if (est.aba === 'planilha') corpo = '<p class="hint" style="margin:0 0 6px">Colunas na primeira linha: Condomínio, Data, Hora, Tipo (AGO ou AGE), Pauta. Outras tarefas: coluna Tarefa.</p><input type="file" id="ag-plan" accept=".xlsx,.xls,.csv,.ods">';
    if (est.aba === 'arquivo') corpo = '<p class="hint" style="margin:0 0 6px">PDF da agenda ou foto da lista. O sistema lê e mostra para você conferir antes de salvar.</p><input type="file" id="ag-arq" accept="application/pdf,image/jpeg,image/png">';
    if (est.aba === 'manual') corpo = '<button class="btn btn-primary" id="ag-novo" type="button">Adicionar assembleia</button> <button class="btn btn-ghost" id="ag-nova-tarefa" type="button">Adicionar tarefa</button>';
    box.innerHTML = '<div class="card-header"><span class="card-title">Mandar a agenda de ' + esc(mesRot(est.mes)) + '</span></div>'
      + '<div class="ag-abas">' + abas.map(function (a) { return '<button type="button" class="btn btn-ghost ' + (est.aba === a[0] ? 'on' : '') + '" data-aba="' + a[0] + '">' + a[1] + '</button>'; }).join('') + '</div>'
      + corpo + '<div id="ag-entrada-msg" class="ag-mut" style="margin-top:6px"></div>';
    box.querySelectorAll('[data-aba]').forEach(function (b) { b.onclick = function () { est.aba = b.dataset.aba; desenharEntrada(); }; });
    var msg = function (t) { document.getElementById('ag-entrada-msg').textContent = t || ''; };
    var ler = async function (corpoReq) {
      if (est.ocupado) return; est.ocupado = true; msg('Lendo a agenda...');
      try { var r = await postJson('/api/agenda/ler', Object.assign({ mes: est.mes }, corpoReq)); est.previa = r.itens.map(function (x) { return Object.assign({ origem: corpoReq.modo }, x); }); est.naoEntendido = r.nao_entendido || []; msg(''); desenharPrevia(); }
      catch (e) { msg(e.message); } finally { est.ocupado = false; }
    };
    var bLer = document.getElementById('ag-ler');
    if (bLer) bLer.onclick = function () { ler({ modo: 'texto', texto: document.getElementById('ag-texto').value }); };
    var iPlan = document.getElementById('ag-plan');
    if (iPlan) iPlan.onchange = async function () {
      var f = iPlan.files[0]; if (!f) return;
      if (typeof XLSX === 'undefined') return msg('O leitor de planilhas não carregou. Recarregue a página.');
      try {
        var wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: false });
        var linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
        ler({ modo: 'planilha', linhas: linhas.slice(0, 400) });
      } catch (e) { msg('Não deu para abrir a planilha.'); }
    };
    var iArq = document.getElementById('ag-arq');
    if (iArq) iArq.onchange = async function () {
      var f = iArq.files[0]; if (!f) return;
      if (f.size > 25 * 1024 * 1024) return msg('Arquivo maior que 25 MB.');
      ler({ modo: 'arquivo', arquivo_b64: await arquivoB64(f) });
    };
    var novo = function (tipoItem) {
      est.previa = (est.previa || []).concat([{ tipo_item: tipoItem, condominio: '', id_superlogica: null, data: '', hora: '', tipo_assembleia: tipoItem === 'assembleia' ? 'AGE' : null, pauta: [], descricao: '', avisos: [], origem: 'manual' }]);
      desenharPrevia();
    };
    var bN = document.getElementById('ag-novo'); if (bN) bN.onclick = function () { novo('assembleia'); };
    var bT = document.getElementById('ag-nova-tarefa'); if (bT) bT.onclick = function () { novo('tarefa'); };
  }

  function opcoesCond(sel) {
    var l = (window.CondSeletor && CondSeletor.lista && CondSeletor.lista()) || [];
    return '<option value="">Escolha o condomínio</option>' + l.filter(function (c) { return c.id_superlogica; }).map(function (c) {
      return '<option value="' + esc(c.id_superlogica) + '"' + (String(sel) === String(c.id_superlogica) ? ' selected' : '') + '>' + esc(c.nome) + '</option>';
    }).join('');
  }
  function textoPauta(p) { return (p || []).map(function (x) { return typeof x === 'string' ? x : x.texto; }).join('\n'); }

  // ── prévia do que foi lido (a pessoa confere e corrige antes de salvar) ──
  function desenharPrevia() {
    var box = document.getElementById('ag-previa');
    var l = est.previa;
    if (!l || (!l.length && !est.naoEntendido.length)) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = '<div class="card-header"><span class="card-title">Confira antes de salvar (' + l.length + ')</span></div>'
      + (est.naoEntendido.length ? '<div class="ag-aviso" style="margin-bottom:8px"><b>Não reconhecido:</b><br>' + est.naoEntendido.map(esc).join('<br>') + '</div>' : '')
      + '<div style="overflow-x:auto"><table class="ag-tab"><thead><tr><th style="min-width:180px">Condomínio</th><th>Data</th><th>Hora</th><th>Tipo</th><th style="min-width:260px">Pauta (um item por linha) ou tarefa</th><th></th></tr></thead><tbody>'
      + l.map(function (it, i) {
        var lido = it.condominio && !it.id_superlogica ? '<div class="ag-mut">Lido: ' + esc(it.condominio) + '</div>' : '';
        return '<tr data-i="' + i + '"><td><select data-c="id_superlogica">' + opcoesCond(it.id_superlogica) + '</select>' + lido + '</td>'
          + '<td><input type="date" data-c="data" value="' + esc(it.data || '') + '"></td>'
          + '<td><input type="time" data-c="hora" value="' + esc(it.hora || '') + '"></td>'
          + '<td>' + (it.tipo_item === 'tarefa' ? 'Tarefa' : '<select data-c="tipo_assembleia"><option value="">?</option>' + ['AGO', 'AGE', 'AGO_AGE'].map(function (t) { return '<option value="' + t + '"' + (it.tipo_assembleia === t ? ' selected' : '') + '>' + tipoAss(t) + '</option>'; }).join('') + '</select>') + '</td>'
          + '<td>' + (it.tipo_item === 'tarefa' ? '<input data-c="descricao" value="' + esc(it.descricao || '') + '" placeholder="O que é a tarefa">' : '<textarea data-c="pauta" rows="3">' + esc(textoPauta(it.pauta)) + '</textarea>')
          + ((it.avisos || []).length ? '<div class="ag-aviso">' + it.avisos.map(esc).join('<br>') + '</div>' : '') + '</td>'
          + '<td><button class="btn btn-ghost ag-tirar" type="button" style="font-size:11px">Tirar</button></td></tr>';
      }).join('') + '</tbody></table></div>'
      + '<div style="margin-top:8px;display:flex;gap:8px"><button class="btn btn-primary" id="ag-salvar" type="button">Salvar na agenda</button><button class="btn btn-ghost" id="ag-descartar" type="button">Descartar</button><span id="ag-previa-msg" class="ag-mut"></span></div>';
    box.querySelectorAll('tr[data-i]').forEach(function (tr) {
      var it = l[Number(tr.dataset.i)];
      tr.querySelectorAll('[data-c]').forEach(function (inp) {
        inp.onchange = function () {
          var c = inp.dataset.c;
          if (c === 'pauta') it.pauta = inp.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
          else if (c === 'id_superlogica') { it.id_superlogica = inp.value ? Number(inp.value) : null; it.condominio = inp.options[inp.selectedIndex].text; }
          else it[c] = inp.value || null;
        };
      });
      tr.querySelector('.ag-tirar').onclick = function () { l.splice(Number(tr.dataset.i), 1); desenharPrevia(); };
    });
    document.getElementById('ag-descartar').onclick = function () { est.previa = null; est.naoEntendido = []; desenharPrevia(); };
    document.getElementById('ag-salvar').onclick = async function () {
      var faltam = l.filter(function (it) { return !it.id_superlogica || !it.data; }).length;
      if (faltam) return (document.getElementById('ag-previa-msg').textContent = faltam + ' item(ns) sem condomínio ou sem data. Corrija ou tire.');
      try {
        var r = await postJson('/api/agenda/itens', { mes: est.mes, itens: l.map(function (it) {
          return { tipo_item: it.tipo_item, id_superlogica: it.id_superlogica, condominio_nome: it.condominio, data: it.data, hora: it.hora, tipo_assembleia: it.tipo_assembleia, pauta: (it.pauta || []).map(function (p) { return typeof p === 'string' ? p : p.texto; }), descricao: it.descricao, origem: it.origem, avisos: it.avisos };
        }) });
        aviso(r.gravados + ' item(ns) salvos na agenda.' + (r.recusados.length ? ' ' + r.recusados.length + ' recusado(s): ' + r.recusados.map(function (x) { return x.motivo; }).join('; ') : ''), r.recusados.length ? 'warn' : 'ok');
        est.previa = null; est.naoEntendido = []; carregar();
      } catch (e) { document.getElementById('ag-previa-msg').textContent = e.message; }
    };
  }

  // ── plano do mês ──
  function tarefasDoItem(id) { return ((est.dados && est.dados.tarefas) || []).filter(function (t) { return t.item_id === id && t.status !== 'cancelada'; }); }
  function linhaTarefa(t, pode) {
    var r = t.resultado || {};
    var extra = '';
    if (t.motivo) extra += '<span class="' + (t.status === 'erro' ? 'ag-erro' : 'ag-aviso') + '">' + esc(ROT_MOTIVO[t.motivo] || t.motivo) + '</span> ';
    if (t.erro) extra += '<span class="ag-erro">' + esc(t.erro) + '</span> ';
    if (r.titulo && r.trabalho_id) extra += '<span class="ag-mut">Na pasta Em andamento: ' + esc(r.titulo) + '</span> ';
    if (r.faltando_certidoes && r.faltando_certidoes.length) extra += '<span class="ag-aviso">Faltam certidões: ' + esc(r.faltando_certidoes.join(', ')) + '</span> ';
    if (r.avisos_plano && r.avisos_plano.length) extra += '<span class="ag-aviso">' + esc(r.avisos_plano.join(' ')) + '</span> ';
    if (t.tipo === 'prestacao_contas' && t.parametros && t.parametros.inicio) extra += '<span class="ag-mut">Período ' + esc(mesRot(t.parametros.inicio)) + ' a ' + esc(mesRot(t.parametros.fim)) + '</span> ';
    var bot = '';
    if (pode.aprovar && t.aprovacao === 'pendente' && t.status !== 'cancelada') bot += '<button class="btn btn-ghost ag-acao" data-acao="aprovar" data-id="' + esc(t.id) + '" type="button" style="font-size:11px">Aprovar</button>';
    if (pode.cadastrar && (t.status === 'pronta_conferir' || t.status === 'manual')) bot += '<button class="btn btn-ghost ag-acao" data-acao="conferida" data-id="' + esc(t.id) + '" type="button" style="font-size:11px">Conferida</button>';
    if (r.trabalho_id && window.Trabalhos && typeof Trabalhos.abrir === 'function') bot += '<button class="btn btn-ghost ag-acao" data-acao="abrir" data-id="' + esc(r.trabalho_id) + '" type="button" style="font-size:11px">Abrir</button>';
    if (pode.aprovar && t.aprovacao === 'aprovada' && (t.status === 'agendada' || t.status === 'pendente_material' || (t.status === 'manual' && !r.avisado))) bot += '<button class="btn btn-ghost ag-acao" data-acao="rodar" data-id="' + esc(t.id) + '" type="button" style="font-size:11px">Rodar agora</button>';
    if (pode.aprovar && ['erro', 'pronta_conferir', 'pendente_material', 'conferida'].indexOf(t.status) >= 0 && ['prestacao_contas', 'apresentacao', 'certidoes', 'pedir_material'].indexOf(t.tipo) >= 0) bot += '<button class="btn btn-ghost ag-acao" data-acao="refazer" data-id="' + esc(t.id) + '" type="button" style="font-size:11px">Refazer</button>';
    return '<div class="ag-linha"><b style="min-width:150px;font-size:12px">' + esc(ROT_TIPO[t.tipo] || t.tipo) + '</b><span class="ag-mut" style="min-width:60px">' + esc(dataBr(t.data_execucao)) + '</span>' + badge(t.status, t.aprovacao)
      + '<span style="flex:1;min-width:200px;font-size:11px">' + extra + '</span>' + bot + '</div>';
  }
  function desenharPlano() {
    var box = document.getElementById('ag-plano'); var d = est.dados;
    if (!d) { box.innerHTML = ''; return; }
    var c = d.custo || {}; var pa = c.a_aprovar || {}; var pl = c.plano || {};
    var topo = '<div class="card-header" style="flex-wrap:wrap;gap:8px"><span class="card-title">Plano de ' + esc(d.rotulo) + '</span><div class="ag-abas" style="margin:0">'
      + '<button type="button" class="btn btn-ghost ' + (est.vista === 'lista' ? 'on' : '') + '" data-vista="lista">Por condomínio</button>'
      + '<button type="button" class="btn btn-ghost ' + (est.vista === 'calendario' ? 'on' : '') + '" data-vista="calendario">Calendário</button></div></div>'
      + '<div class="hint" style="margin:0 0 8px">O plano gera ' + (pl.prestacoes || 0) + ' prestação(ões) e ' + (pl.apresentacoes || 0) + ' apresentação(ões), cerca de ' + usd(pl.usd) + ' em créditos de processamento (estimativa). '
      + 'No máximo ' + esc(c.limite_hora) + ' gerações por hora' + (c.maior_dia ? '; o dia mais cheio tem ' + c.maior_dia + ' geração(ões)' : '') + '.</div>'
      + (d.pode.aprovar && d.painel.aguardando_aprovacao ? '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px"><button class="btn btn-primary" id="ag-aprovar-tudo" type="button">Aprovar tudo (' + d.painel.aguardando_aprovacao + ')</button><span class="ag-mut">Aprovar agora dispara ' + (pa.geracoes || 0) + ' geração(ões), cerca de ' + usd(pa.usd) + '.</span></div>' : '')
      + (!d.execucao.ligada ? '<div class="ag-aviso" style="margin-bottom:8px">A execução automática está desligada neste ambiente: o plano fica pronto e aprovado, mas nada roda sozinho até a gestão ligar.</div>' : '');
    var corpo = est.vista === 'calendario' ? calendario(d) : listaPorCondominio(d);
    box.innerHTML = topo + corpo;
    box.querySelectorAll('[data-vista]').forEach(function (b) { b.onclick = function () { est.vista = b.dataset.vista; desenharPlano(); }; });
    var at = document.getElementById('ag-aprovar-tudo');
    if (at) at.onclick = async function () {
      if (!(await confirmar('Aprovar o plano inteiro de ' + d.rotulo + '?', 'Aprovar dispara ' + (pa.geracoes || 0) + ' geração(ões) nas datas, cerca de ' + usd(pa.usd) + '.', 'Aprovar tudo'))) return;
      try { var r = await postJson('/api/agenda/mes/' + est.mes + '/aprovar', {}); aviso(r.aprovadas + ' tarefa(s) aprovadas.', 'ok'); carregar(); } catch (e) { aviso(e.message, 'err'); }
    };
    ligarAcoes(box);
  }
  function ligarAcoes(box) {
    box.querySelectorAll('.ag-acao').forEach(function (b) {
      b.onclick = async function () {
        var id = b.dataset.id; var a = b.dataset.acao;
        try {
          if (a === 'abrir') return Trabalhos.abrir(id);
          if (a === 'aprovar') await postJson('/api/agenda/mes/' + est.mes + '/aprovar', { ids: [id] });
          if (a === 'conferida') await postJson('/api/agenda/tarefas/' + id + '/conferida');
          if (a === 'refazer') { if (!(await confirmar('Fazer de novo?', 'Volta para a próxima rodada. Gera de novo e gasta créditos.', 'Refazer'))) return; await postJson('/api/agenda/tarefas/' + id + '/refazer'); }
          if (a === 'rodar') {
            var tr = ((est.dados && est.dados.tarefas) || []).find(function (x) { return x.id === id; }) || {};
            var gera = tr.tipo === 'prestacao_contas' || tr.tipo === 'apresentacao';
            if (!(await confirmar('Rodar agora?', (tr.titulo || 'Esta tarefa') + ' roda agora, sem esperar a data.' + (gera ? ' Gera o documento e gasta créditos, dentro do limite de gerações por hora.' : ''), 'Rodar agora'))) return;
            b.disabled = true;
            var rr = await postJson('/api/agenda/tarefas/' + id + '/rodar');
            aviso(rr.detalhe || 'Começou.', 'ok');
          }
          carregar();
        } catch (e) { aviso(e.message, 'err'); }
      };
    });
  }
  function calendario(d) {
    var p = d.mes.split('-').map(Number);
    var primeiro = new Date(Date.UTC(p[0], p[1] - 1, 1)).getUTCDay();
    var dias = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
    var porDia = {};
    d.itens.filter(function (i) { return !i.cancelado && i.data; }).forEach(function (i) { (porDia[i.data] = porDia[i.data] || []).push('<span class="ag-chip" style="background:var(--gs-blue);color:#fff" title="' + esc(i.condominio_nome) + '">' + esc((i.hora || '') + ' ' + (i.tipo_item === 'tarefa' ? 'Tarefa' : tipoAss(i.tipo_assembleia)) + ' ' + i.condominio_nome) + '</span>'); });
    d.tarefas.filter(function (t) { return t.status !== 'cancelada'; }).forEach(function (t) {
      var cor = t.aprovacao === 'pendente' ? '#B08900' : (COR_STATUS[t.status] || '#888');
      (porDia[t.data_execucao] = porDia[t.data_execucao] || []).push('<span class="ag-chip" style="background:' + cor + '22;color:' + cor + '" title="' + esc(t.titulo) + '">' + esc(t.titulo || ROT_TIPO[t.tipo]) + '</span>');
    });
    var h = '<div class="ag-cal">' + DIAS_SEM.map(function (x) { return '<div class="h">' + x + '</div>'; }).join('');
    for (var i = 0; i < primeiro; i++) h += '<div></div>';
    for (var dia = 1; dia <= dias; dia++) {
      var iso = d.mes + '-' + String(dia).padStart(2, '0');
      h += '<div class="d' + (iso === d.hoje ? ' hoje' : '') + '"><b>' + dia + '</b>' + (porDia[iso] || []).join('') + '</div>';
    }
    var fora = Object.keys(porDia).filter(function (k) { return k.slice(0, 7) !== d.mes; }).sort();
    h += '</div>';
    if (fora.length) h += '<div class="ag-mut" style="margin-top:6px">Fora do mês: ' + fora.map(function (k) { return dataBrAno(k) + ' (' + porDia[k].length + ')'; }).join(', ') + '</div>';
    return h;
  }
  function listaPorCondominio(d) {
    var itens = d.itens.filter(function (i) { return !i.cancelado; });
    if (!itens.length) return '<div class="ag-mut">Nenhuma assembleia na agenda deste mês ainda.</div>';
    var cert = d.tarefas.filter(function (t) { return t.tipo === 'certidoes' && t.status !== 'cancelada'; });
    return itens.map(function (it) {
      var mats = (d.materiais || []).filter(function (m) { return m.item_id === it.id; });
      var deps = (d.dependencias || {})[it.id] || [];
      var temDoc = mats.some(function (m) { return m.tipo === 'documento' || m.tipo === 'foto'; });
      var depHtml = deps.map(function (x) {
        var ok = x.chave === 'edital' ? !!it.edital_texto : x.chave === 'orcamentos' ? temDoc : x.chave === 'certidoes' ? null : temDoc;
        return '<span class="ag-badge" style="background:' + (ok === true ? '#1BA67222;color:#0E7A50' : ok === false && x.obrigatorio ? '#E0A10022;color:#7A5A00' : '#8B95A822;color:#555') + '">' + (ok === true ? '✓ ' : '') + esc(x.nome) + '</span>';
      }).join(' ');
      var pauta = (it.pauta || []).map(function (p, n) { return '<div style="font-size:12px">' + (n + 1) + '. ' + esc(p.texto) + ' ' + (p.trabalhos || []).map(function (x) { return '<span class="ag-badge" style="background:#5B8DEF18;color:#3B5DB8">' + esc(ROT_TRAB[x] || x) + '</span>'; }).join(' ') + '</div>'; }).join('');
      var pode = d.pode.cadastrar;
      return '<div class="ag-item" data-item="' + esc(it.id) + '">'
        + '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><div><b>' + esc(it.condominio_nome) + '</b> <span class="ag-mut">' + esc(dataBrAno(it.data)) + (it.hora ? ' às ' + esc(it.hora) : '') + ' · ' + (it.tipo_item === 'tarefa' ? 'Tarefa: ' + esc(it.descricao || '') : esc(tipoAss(it.tipo_assembleia) || 'tipo não informado')) + '</span></div>'
        + (pode ? '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-ghost ag-it" data-a="pauta" type="button" style="font-size:11px">Corrigir</button><button class="btn btn-ghost ag-it" data-a="assumir" type="button" style="font-size:11px">Eu cuido</button><button class="btn btn-ghost ag-it" data-a="tirar" type="button" style="font-size:11px">Tirar da agenda</button></div>' : '') + '</div>'
        + (pauta ? '<div style="margin:6px 0">' + pauta + '</div>' : (it.tipo_item === 'assembleia' ? '<div class="ag-aviso">Sem pauta: anexe o edital.</div>' : ''))
        + (deps.length && it.tipo_item === 'assembleia' ? '<div style="margin:4px 0">Precisa: ' + depHtml + '</div>' : '')
        + (it.tipo_item === 'assembleia' ? '<div class="ag-mut" style="margin:4px 0">Material: ' + (mats.length ? mats.map(function (m) { return esc((m.tipo === 'edital' ? 'Edital: ' : '') + m.nome) + (pode ? ' <a href="#" class="ag-mat-x" data-m="' + esc(m.id) + '" title="Tirar">✕</a>' : ''); }).join(', ') : 'nenhum ainda') + '</div>'
          + (pode ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0"><label class="btn btn-ghost" style="font-size:11px">Anexar edital (PDF)<input type="file" accept="application/pdf" data-tipo="edital" style="display:none"></label>'
            + '<label class="btn btn-ghost" style="font-size:11px">Orçamentos e documentos (PDF)<input type="file" accept="application/pdf" multiple data-tipo="documento" style="display:none"></label>'
            + '<label class="btn btn-ghost" style="font-size:11px">Fotos<input type="file" accept="image/*" multiple data-tipo="foto" style="display:none"></label>'
            + '<button class="btn btn-ghost ag-it" data-a="edital_texto" type="button" style="font-size:11px">Colar texto do edital</button></div>' : '') : '')
        + '<div style="margin-top:6px">' + tarefasDoItem(it.id).map(function (t) { return linhaTarefa(t, d.pode); }).join('') + '</div></div>';
    }).join('') + (cert.length ? '<div class="ag-item"><b>Dias das certidões</b>' + cert.map(function (t) { return linhaTarefa(t, d.pode); }).join('') + '</div>' : '');
  }

  // Ações de cada item (delegadas no card do plano).
  document.addEventListener('click', async function (ev) {
    var b = ev.target.closest && ev.target.closest('.ag-it, .ag-mat-x');
    if (!b) return;
    ev.preventDefault();
    if (b.classList.contains('ag-mat-x')) {
      if (!(await confirmar('Tirar este arquivo?', 'O arquivo sai do material da assembleia.', 'Tirar'))) return;
      try { await api('/api/agenda/materiais/' + b.dataset.m, { method: 'DELETE' }); carregar(); } catch (e) { aviso(e.message, 'err'); }
      return;
    }
    var card = b.closest('[data-item]'); if (!card) return;
    var id = card.dataset.item;
    var it = (est.dados.itens || []).find(function (x) { return x.id === id; }); if (!it) return;
    try {
      if (b.dataset.a === 'tirar') { if (!(await confirmar('Tirar da agenda?', 'Tirar ' + it.condominio_nome + ' de ' + dataBrAno(it.data) + ' da agenda? As tarefas dele saem do plano.', 'Tirar'))) return; await api('/api/agenda/itens/' + id, { method: 'DELETE' }); }
      if (b.dataset.a === 'assumir') { await postJson('/api/agenda/itens/' + id + '/assumir'); aviso('Os resultados deste item vão para a sua pasta Em andamento.', 'ok'); }
      if (b.dataset.a === 'edital_texto') {
        var ed = await janela({ titulo: 'Texto do edital', texto: 'Cole o texto do edital. A pauta é lida dele.', campos: [{ nome: 'texto', valor: it.edital_texto || '', tipo: 'textarea', linhas: 12 }], sim: 'Salvar' });
        if (ed == null) return;
        await postJson('/api/agenda/itens/' + id, { edital_texto: ed.texto, pauta: [] }, 'PUT');
      }
      if (b.dataset.a === 'pauta') {
        var ehTarefa = it.tipo_item === 'tarefa';
        var campos = [{ nome: 'data', rotulo: ehTarefa ? 'Data' : 'Data da assembleia', valor: it.data || '', tipo: 'date' }, { nome: 'hora', rotulo: 'Hora', valor: it.hora || '', tipo: 'time' }];
        if (!ehTarefa) campos.push({ nome: 'tipo', rotulo: 'Tipo', valor: it.tipo_assembleia || '', tipo: 'select', opcoes: [['', 'Não informado'], ['AGO', 'AGO'], ['AGE', 'AGE'], ['AGO_AGE', 'AGO e AGE']] },
          { nome: 'pauta', rotulo: 'Pauta (um item por linha)', valor: (it.pauta || []).map(function (p) { return p.texto; }).join('\n'), tipo: 'textarea', linhas: 8 });
        var f = await janela({ titulo: 'Corrigir ' + (it.condominio_nome || 'item'), campos: campos, sim: 'Salvar' });
        if (f == null) return;
        var corpo = { data: String(f.data || '').trim(), hora: String(f.hora || '').trim() || null };
        if (!ehTarefa) corpo.tipo_assembleia = f.tipo || null;
        if (!ehTarefa) corpo.pauta = String(f.pauta || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
        await postJson('/api/agenda/itens/' + id, corpo, 'PUT');
        aviso('Item corrigido. O que mudou no plano volta para aprovação.', 'ok');
      }
      carregar();
    } catch (e) { aviso(e.message, 'err'); }
  });
  // Material anexado no card do item.
  document.addEventListener('change', async function (ev) {
    var inp = ev.target;
    if (!inp || !inp.dataset || !inp.dataset.tipo || !inp.closest || !inp.closest('#ag-plano')) return;
    var card = inp.closest('[data-item]'); if (!card) return;
    var tipo = inp.dataset.tipo; var arquivos = Array.prototype.slice.call(inp.files || []); var ok = 0;
    for (var i = 0; i < arquivos.length; i++) {
      var f = arquivos[i];
      try {
        var corpo = tipo === 'foto' ? await fotoJpeg(f) : f;
        if (corpo.size > 25 * 1024 * 1024) throw new Error(f.name + ' passou de 25 MB.');
        var nome = tipo === 'foto' ? f.name.replace(/\.[^.]+$/, '') + '.jpg' : f.name;
        var r = await api('/api/agenda/itens/' + card.dataset.item + '/material?tipo=' + tipo + '&nome=' + encodeURIComponent(nome), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: corpo });
        if (r.aviso) aviso(r.aviso, 'warn');
        ok++;
      } catch (e) { aviso('Não foi possível anexar ' + f.name + ': ' + e.message, 'err'); }
    }
    if (ok) aviso(ok + ' arquivo(s) anexado(s).', 'ok');
    carregar();
  });

  // ── painel do mês ──
  function listaCurta(l, vazio) {
    if (!l.length) return '<div class="ag-mut">' + vazio + '</div>';
    return l.slice(0, 30).map(function (t) { return '<div style="font-size:12px;border-top:1px solid var(--border);padding:4px 0">' + esc(dataBr(t.data_execucao)) + ' · ' + esc(t.titulo) + ' ' + badge(t.status, t.aprovacao) + (t.motivo_texto ? ' <span class="ag-aviso">' + esc(t.motivo_texto) + '</span>' : '') + (t.erro ? ' <span class="ag-erro">' + esc(t.erro) + '</span>' : '') + '</div>'; }).join('');
  }
  function desenharPainel() {
    var box = document.getElementById('ag-painel'); var d = est.dados;
    if (!d) { box.innerHTML = ''; return; }
    var p = d.painel;
    var cert = (d.certidoes_dia || []).map(function (g) {
      return '<div style="margin-top:8px"><b style="font-size:12px">Dia das certidões ' + esc(dataBrAno(g.dia)) + '</b> ' + badge(g.status, g.aprovacao)
        + g.condominios.map(function (c) { return '<div style="font-size:12px;border-top:1px solid var(--border);padding:4px 0">' + esc(c.nome) + (c.assembleia ? ' <span class="ag-mut">(assembleia ' + esc(dataBr(c.assembleia)) + ')</span>' : '') + ': '
          + (c.faltando.length ? '<span class="ag-aviso">faltam ' + esc(c.faltando.join(', ')) + '</span>' : '<span style="color:#0E7A50">todas válidas</span>') + '</div>'; }).join('') + '</div>';
    }).join('');
    box.innerHTML = '<div class="card-header"><span class="card-title">Painel do mês</span></div><div class="ag-grid3">'
      + '<div><b style="font-size:13px">Pronto (' + p.prontas.length + ')</b>' + listaCurta(p.prontas, 'Nada pronto ainda.') + '</div>'
      + '<div><b style="font-size:13px">Travado (' + p.travadas.length + ')</b>' + listaCurta(p.travadas, 'Nada travado.') + '</div>'
      + '<div><b style="font-size:13px">Vence nesta semana (' + p.semana.length + ')</b>' + listaCurta(p.semana, 'Nada para esta semana.') + '</div></div>'
      + (cert || '');
  }

  // ── antecedências (só a gestão muda) ──
  function desenharConfig() {
    var box = document.getElementById('ag-config'); var d = est.dados;
    if (!d || !d.pode.aprovar) { box.style.display = 'none'; return; }
    box.style.display = '';
    var c = d.config; var lim = d.limites_config;
    var campos = [['prestacao_dias_antes', 'Prestação pronta quantos dias antes'], ['apresentacao_dias_antes', 'Apresentação pronta quantos dias antes'], ['pedir_material_dias_antes', 'Pedir material ao síndico quantos dias antes'], ['previsao_dias_antes', 'Previsão orçamentária quantos dias antes'], ['certidoes_dia_semana', 'Dia das certidões (1 segunda a 5 sexta, na semana anterior)'], ['ata_dias_depois', 'Ata quantos dias depois']];
    box.innerHTML = '<details><summary style="cursor:pointer;font-weight:600">Antecedências do plano</summary><div class="ag-grid3" style="margin-top:8px">'
      + campos.map(function (x) { return '<label style="font-size:12px">' + x[1] + '<br><input type="number" data-cfg="' + x[0] + '" min="' + lim[x[0]][0] + '" max="' + lim[x[0]][1] + '" value="' + esc(c[x[0]]) + '" style="width:90px"></label>'; }).join('')
      + '</div><button class="btn btn-primary" id="ag-cfg-salvar" type="button" style="margin-top:8px">Salvar antecedências</button> <span class="ag-mut">Mudar as datas faz o plano voltar para aprovação.</span></details>';
    document.getElementById('ag-cfg-salvar').onclick = async function () {
      var v = {}; box.querySelectorAll('[data-cfg]').forEach(function (i) { v[i.dataset.cfg] = Number(i.value); });
      try { await postJson('/api/agenda/config', { valores: v }, 'PUT'); aviso('Antecedências salvas.', 'ok'); carregar(); } catch (e) { aviso(e.message, 'err'); }
    };
  }

  // ── Painel da gestão ──
  async function carregarGestao() {
    if (!window.AUTH_TOKEN) return;
    try { est.gDados = await api('/api/agenda/gestao/' + est.gMes, { cache: 'no-store' }); }
    catch (e) { document.getElementById('ag-g-resumo').innerHTML = '<div class="ag-erro">' + esc(e.message) + '</div>'; return; }
    var d = est.gDados; var p = d.painel;
    var por = {}; d.tarefas.forEach(function (t) { if (t.status !== 'cancelada') por[t.status] = (por[t.status] || 0) + 1; });
    document.getElementById('ag-g-resumo').innerHTML = '<div class="card-header"><span class="card-title">' + esc(d.rotulo) + '</span>' + (d.execucao.ligada ? '<span class="ag-mut">Execução automática ligada</span>' : '<span class="ag-aviso">Execução automática desligada</span>') + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' + Object.keys(por).map(function (k) { return badge(k) + ' <b>' + por[k] + '</b>'; }).join(' &nbsp; ') + (p.aguardando_aprovacao ? ' &nbsp; ' + badge('agendada', 'pendente') + ' <b>' + p.aguardando_aprovacao + '</b>' : '') + '</div>'
      + '<div class="ag-grid3"><div><b style="font-size:13px">Pronto</b>' + listaCurta(p.prontas, 'Nada pronto ainda.') + '</div><div><b style="font-size:13px">Não pronto e por quê</b>' + listaCurta(p.travadas, 'Nada travado.') + '</div><div><b style="font-size:13px">Nesta semana</b>' + listaCurta(p.semana, 'Nada para esta semana.') + '</div></div>';
    var tend = d.tendencias || [];
    var maxAss = Math.max(1, Math.max.apply(null, tend.map(function (x) { return x.assembleias; })));
    document.getElementById('ag-g-tend').innerHTML = '<div class="card-header"><span class="card-title">Tendências dos últimos meses</span></div><div style="overflow-x:auto"><table class="ag-tab"><thead><tr><th>Mês</th><th>Assembleias</th><th>Prestações</th><th>Apresentações</th><th>Pronto no prazo</th><th>O que mais travou</th><th>Material até pronto</th><th>Gerações</th>' + (d.custo_visivel ? '<th>Créditos no mês</th>' : '') + '</tr></thead><tbody>'
      + tend.map(function (x) {
        return '<tr><td>' + esc(x.rotulo) + '</td><td><div style="display:flex;gap:6px;align-items:center"><div class="ag-barra" style="width:' + Math.round(x.assembleias / maxAss * 80) + 'px"></div>' + x.assembleias + '</div></td><td>' + x.prestacoes + '</td><td>' + x.apresentacoes + '</td>'
          + '<td>' + (x.nada_venceu ? '<span class="ag-mut">nada venceu ainda</span>' : x.pct_no_prazo == null ? '<span class="ag-mut">sem dados</span>' : x.no_prazo + ' (' + x.pct_no_prazo + '%)') + '</td>'
          + '<td>' + (x.mais_travou.length ? x.mais_travou.map(function (m) { return esc(ROT_MOTIVO[m.motivo] || m.texto) + ' (' + m.vezes + ')'; }).join('<br>') : '<span class="ag-mut">nada</span>') + '</td>'
          + '<td>' + (x.horas_material_ate_pronto == null ? '<span class="ag-mut">sem dados</span>' : (x.horas_material_ate_pronto >= 48 ? Math.round(x.horas_material_ate_pronto / 24 * 10) / 10 + ' dias' : x.horas_material_ate_pronto + ' h')) + '</td>'
          + '<td>' + x.geracoes + '</td>' + (d.custo_visivel ? '<td>' + (x.custo_usd == null ? '<span class="ag-mut">sem dados</span>' : usd(x.custo_usd)) + '</td>' : '') + '</tr>';
      }).join('') + '</tbody></table></div><div class="ag-mut" style="margin-top:6px">Créditos no mês: tudo o que as funções de prestação e apresentação gastaram, pela agenda ou pela tela.</div>';
    var tar = d.tarefas.filter(function (t) { return t.status !== 'cancelada'; }).sort(function (a, b) { return a.data_execucao < b.data_execucao ? -1 : 1; });
    var nome = {}; d.itens.forEach(function (i) { nome[i.id] = i; });
    document.getElementById('ag-g-crono').innerHTML = '<div class="card-header"><span class="card-title">Cronograma do mês</span></div><div style="overflow-x:auto"><table class="ag-tab"><thead><tr><th>Data</th><th>O quê</th><th>Assembleia</th><th>Situação</th></tr></thead><tbody>'
      + (tar.length ? tar.map(function (t) { var it = nome[t.item_id]; return '<tr><td>' + esc(dataBrAno(t.data_execucao)) + '</td><td>' + esc(t.titulo) + '</td><td>' + (it ? esc(dataBrAno(it.data)) + ' ' + esc(tipoAss(it.tipo_assembleia)) : '') + '</td><td>' + badge(t.status, t.aprovacao) + (t.motivo ? ' <span class="ag-aviso">' + esc(ROT_MOTIVO[t.motivo] || t.motivo) + '</span>' : '') + '</td></tr>'; }).join('') : '<tr><td colspan="4" class="ag-mut">Sem plano neste mês.</td></tr>')
      + '</tbody></table></div>';
  }

  // ── visibilidade e abertura ──
  function ativo(n) { var p = document.getElementById('panel-' + n); return !!(p && p.classList.contains('active')); }
  function aplicarVisibilidade() {
    var a = document.getElementById('nav-' + PAINEL); var g = document.getElementById('nav-' + PAINEL_G);
    if (a) a.style.display = podeVer() ? '' : 'none';
    if (g) g.style.display = podeGestao() ? '' : 'none';
    if (!window.USER_PERMS) return;
    if ((ativo(PAINEL) && !podeVer()) || (ativo(PAINEL_G) && !podeGestao())) window.showPanel('dashboard');
    if (est.pendente && podeVer()) { est.pendente = false; window.showPanel(PAINEL); }
    if (est.pendenteG && podeGestao()) { est.pendenteG = false; window.showPanel(PAINEL_G); }
  }

  criarMenu();
  criarPaineis();
  try { var salvo = localStorage.getItem('sh_active_panel'); est.pendente = salvo === PAINEL; est.pendenteG = salvo === PAINEL_G; } catch (e) { /* sem armazenamento */ }
  if (typeof window.showPanel === 'function') {
    var origShow = window.showPanel;
    window.showPanel = function (nome) {
      if ((nome === PAINEL && !podeVer()) || (nome === PAINEL_G && !podeGestao())) {
        if (!window.USER_PERMS) { if (nome === PAINEL) est.pendente = true; else est.pendenteG = true; }
        return origShow.call(this, 'dashboard');
      }
      var r = origShow.apply(this, arguments);
      if (nome === PAINEL) carregar();
      if (nome === PAINEL_G) carregarGestao();
      return r;
    };
  }
  if (typeof window.aplicarPermissoesSidebar === 'function') {
    var origPerm = window.aplicarPermissoesSidebar;
    window.aplicarPermissoesSidebar = function () { var r = origPerm.apply(this, arguments); aplicarVisibilidade(); return r; };
  }
  document.addEventListener('auth:ready', function () { setTimeout(aplicarVisibilidade, 0); });
  if (window.USER_PERMS) aplicarVisibilidade();
})();
