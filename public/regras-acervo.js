// ============================================================
// REGRAS DO CONDOMÍNIO: DOCUMENTOS (frente D do acervo)
// Monta dentro de #regras-acervo (aba "Documentos" do painel Regras do Condomínio): convenção,
// regimento, regulamentos e atas por ano do condomínio ativo, com o selo "vale hoje", resumo
// da ata, abrir o PDF, ver os artigos, enviar documento novo, marcar a versão que vale,
// editar, apagar e as pendências (do condomínio e, para quem vê vários, de todos).
// Rotas: /api/regras/:id/documentos[...], /api/regras/:id/envios/:tarefa, /api/regras/pendencias.
// O servidor confere permissão e carteira em cada rota; aqui só decide o que mostrar.
// ============================================================
(function () {
  var RAIZ = 'regras-acervo';
  var MAX_MB = 50;
  var TIPOS = [
    { v: 'convencao', rotulo: 'Convenção' },
    { v: 'regimento', rotulo: 'Regimento interno' },
    { v: 'regulamento', rotulo: 'Regulamentos' },
    { v: 'ata', rotulo: 'Atas' },
    { v: 'outro', rotulo: 'Outros documentos' }
  ];
  var TIPO_UM = { convencao: 'Convenção', regimento: 'Regimento interno', regulamento: 'Regulamento', ata: 'Ata', outro: 'Outro' };
  var ORIGEM = { condgpt: 'importado do sistema antigo', upload: 'enviado pelo Hub', ata_hub: 'ata gerada no Hub' };
  var est = { idCarregado: null, seq: 0, docs: [], contagens: null, pendencias: [], abertos: {}, enviando: false, geral: null, geralSeq: 0, montado: false };

  // ---------- utilitários ----------
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function cond() { return typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null; }
  function el(id) { return document.getElementById(id); }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function avisar(msg, tipo) { if (typeof toast === 'function') toast(msg, tipo || 'ok'); }
  function raizVisivel() { var r = el(RAIZ); var p = el('panel-regras'); return !!(r && p && p.classList.contains('active') && r.style.display !== 'none'); }
  function pode(acao) {
    if (window.USER_ROLE === 'GESTOR') return true;
    var m = window.USER_PERMS && window.USER_PERMS.regras;
    return !!(m && m.visivel === true && Array.isArray(m.acoes) && m.acoes.indexOf(acao) >= 0);
  }
  // Quem vê mais de um condomínio (sem carteira ou carteira com vários) ganha a lista geral.
  function veVarios() {
    var c = window.CondSeletor && CondSeletor.carteira ? CondSeletor.carteira() : null;
    if (!c || c.todas !== false) return true;
    return (c.ids_superlogica || []).length > 1;
  }
  async function pedir(url, opcoes) {
    var r = await apiAuthFetch(url, opcoes || {});
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.detalhe || 'Não foi possível concluir agora.'); e.status = r.status; throw e; }
    j._status = r.status;
    return j;
  }
  function base(id) { return '/api/regras/' + encodeURIComponent(id) + '/documentos'; }

  // ---------- estrutura fixa da aba ----------
  // Cria os blocos uma vez: cabeçalho, pendências, envio, lista e pendências gerais.
  function montar() {
    var r = el(RAIZ);
    if (!r || est.montado) return !!r;
    est.montado = true;
    r.innerHTML =
      '<style>' +
      '#regras-acervo .ra-grupo{margin-bottom:18px}' +
      '#regras-acervo .ra-grupo h4{font-size:12px;font-family:var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px}' +
      '#regras-acervo .ra-doc{border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--bg3)}' +
      '#regras-acervo .ra-doc-topo{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}' +
      '#regras-acervo .ra-doc-tit{font-weight:600;font-size:13px;color:var(--text)}' +
      '#regras-acervo .ra-doc-sub{font-size:11px;font-family:var(--mono);color:var(--muted);margin-top:3px}' +
      '#regras-acervo .ra-acoes{display:flex;gap:6px;flex-wrap:wrap}' +
      '#regras-acervo .ra-acoes .btn{font-size:11px;padding:5px 10px}' +
      '#regras-acervo .ra-resumo{white-space:pre-wrap;font-size:12px;line-height:1.5;margin-top:8px;padding:8px 10px;border-left:2px solid var(--border2);color:var(--text)}' +
      '#regras-acervo .ra-extra{margin-top:10px}' +
      '#regras-acervo .ra-trecho{border-top:1px solid var(--border);padding:8px 0;font-size:12px;line-height:1.5}' +
      '#regras-acervo .ra-trecho b{font-family:var(--mono);font-size:11px;color:var(--gs-blue)}' +
      '#regras-acervo .ra-trecho div{white-space:pre-wrap;margin-top:3px}' +
      '#regras-acervo .ra-pend{font-size:12px;padding:6px 0;border-bottom:1px solid var(--border)}' +
      '#regras-acervo .ra-pend:last-child{border-bottom:none}' +
      '#regras-acervo .ra-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:end}' +
      '#regras-acervo .ra-form .form-group{margin:0}' +
      '#regras-acervo input[type=date],#regras-acervo input[type=file],#regras-acervo textarea{width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 10px;color:var(--text);font-family:var(--mono);font-size:12px}' +
      '#regras-acervo .ra-cont{display:flex;gap:8px;flex-wrap:wrap}' +
      '#regras-acervo .ra-msg{font-size:12px;font-family:var(--mono);margin-top:10px}' +
      '#regras-acervo .ra-vazio{font-size:12px;color:var(--muted);font-family:var(--mono)}' +
      '</style>' +
      '<div id="ra-aviso" class="card" style="display:none"></div>' +
      '<div id="ra-corpo" style="display:none">' +
        '<div class="card"><div class="card-header"><span class="card-title" id="ra-titulo">Documentos do condomínio</span>' +
          '<button class="btn btn-ghost" style="font-size:11px;padding:5px 10px" id="ra-recarregar">Atualizar</button></div>' +
          '<div id="ra-contagens" class="ra-cont"></div>' +
          '<div id="ra-pendencias" style="margin-top:12px"></div></div>' +
        '<div class="card" id="ra-envio" style="display:none"><div class="card-header"><span class="card-title">Enviar documento novo</span></div>' +
          '<div class="ra-form">' +
            '<div class="form-group"><label for="ra-tipo">Tipo</label><select id="ra-tipo">' + TIPOS.map(function (t) { return '<option value="' + t.v + '">' + esc(TIPO_UM[t.v]) + '</option>'; }).join('') + '</select></div>' +
            '<div class="form-group" style="grid-column:span 2"><label for="ra-titulo-doc">Título</label><input type="text" id="ra-titulo-doc" maxlength="200" autocomplete="off" placeholder="ex: Regimento interno aprovado em 2024"></div>' +
            '<div class="form-group"><label for="ra-data">Data do documento</label><input type="date" id="ra-data"></div>' +
            '<div class="form-group" style="grid-column:span 2"><label for="ra-arquivo">Arquivo PDF (até ' + MAX_MB + ' MB)</label><input type="file" id="ra-arquivo" accept="application/pdf,.pdf"></div>' +
            '<div class="form-group" id="ra-vigente-box"><label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:12px"><input type="checkbox" id="ra-vigente" checked> É a versão que vale hoje</label></div>' +
            '<div class="form-group"><button class="btn btn-primary" id="ra-enviar">Enviar documento</button></div>' +
          '</div>' +
          '<div id="ra-envio-msg" class="ra-msg"></div></div>' +
        '<div class="card"><div class="card-header"><span class="card-title">Acervo</span></div><div id="ra-lista"></div></div>' +
      '</div>' +
      '<div class="card" id="ra-geral" style="display:none"><div class="card-header"><span class="card-title">Pendências de todos os condomínios</span>' +
        '<button class="btn btn-ghost" style="font-size:11px;padding:5px 10px" id="ra-geral-carregar">Ver pendências</button></div>' +
        '<div id="ra-geral-lista" class="ra-vazio">Mostra os condomínios sem convenção, sem regimento, com versão duplicada ou com documento sem texto ou sem arquivo.</div></div>';
    el('ra-recarregar').addEventListener('click', function () { abrir(true); });
    el('ra-enviar').addEventListener('click', enviar);
    el('ra-tipo').addEventListener('change', ajustarVigente);
    el('ra-geral-carregar').addEventListener('click', carregarGeral);
    el('ra-lista').addEventListener('click', cliqueLista);
    el('ra-pendencias').addEventListener('click', cliqueLista);
    el('ra-geral-lista').addEventListener('click', cliqueGeral);
    ajustarVigente();
    return true;
  }
  // "Vale hoje" só faz sentido para convenção e regimento (atas e regulamentos valem juntos).
  function ajustarVigente() {
    var t = el('ra-tipo') ? el('ra-tipo').value : '';
    var box = el('ra-vigente-box');
    if (box) box.style.display = (t === 'convencao' || t === 'regimento') ? '' : 'none';
  }

  // ---------- carregar ----------
  // Chamada quando a aba aparece e quando o condomínio muda. forcar recarrega mesmo se já tiver.
  function abrir(forcar) {
    if (!montar()) return;
    var c = cond();
    var id = c && c.id_superlogica;
    el('ra-geral').style.display = veVarios() ? '' : 'none';
    var aviso = el('ra-aviso');
    if (!id) {
      el('ra-corpo').style.display = 'none';
      aviso.style.display = '';
      aviso.innerHTML = '<div class="ra-vazio">' + (c ? 'Este condomínio está sem o código do Superlógica no cadastro do Hub.' : 'Escolha um condomínio no seletor para ver os documentos.') + '</div>';
      est.idCarregado = null;
      return;
    }
    aviso.style.display = 'none';
    el('ra-corpo').style.display = '';
    el('ra-envio').style.display = pode('gerenciar') ? '' : 'none';
    el('ra-titulo').textContent = 'Documentos de ' + (c.nome || 'condomínio');
    if (!forcar && est.idCarregado === String(id)) return;
    carregar(id);
  }

  async function carregar(id) {
    var seq = ++est.seq;
    est.idCarregado = String(id);
    el('ra-lista').innerHTML = '<div class="ra-vazio">Carregando...</div>';
    el('ra-contagens').innerHTML = '';
    el('ra-pendencias').innerHTML = '';
    try {
      var j = await pedir(base(id));
      if (seq !== est.seq) return; // trocou de condomínio no meio
      est.docs = j.documentos || [];
      est.contagens = j.contagens || {};
      est.pendencias = j.pendencias || [];
      desenhar();
    } catch (e) {
      if (seq !== est.seq) return;
      est.idCarregado = null;
      el('ra-lista').innerHTML = '<div class="ra-vazio" style="color:var(--danger)">' + esc(e.message) + '</div>';
    }
  }

  // ---------- desenho ----------
  function desenhar() {
    var ct = est.contagens || {};
    el('ra-contagens').innerHTML = TIPOS.map(function (t) {
      var n = ct[t.v] || 0;
      return '<span class="badge ' + (n ? 'badge-ok' : (t.v === 'convencao' || t.v === 'regimento') ? 'badge-err' : 'badge-warn') + '">' + esc(t.rotulo) + ': ' + n + '</span>';
    }).join('');
    el('ra-pendencias').innerHTML = est.pendencias.length
      ? '<div style="font-size:12px;font-weight:600;color:var(--warning);margin-bottom:4px">Pendências</div>' + est.pendencias.map(function (p) {
          var docs = (p.documentos || []).map(function (d) { return '<a href="#" data-acao="ir" data-id="' + d.id + '" style="color:var(--gs-blue)">' + esc(d.titulo) + '</a>'; }).join(', ');
          return '<div class="ra-pend">' + esc(p.texto) + (docs ? '<div class="ra-doc-sub">' + docs + '</div>' : '') + '</div>';
        }).join('')
      : '<div class="ra-vazio" style="color:var(--success)">Nenhuma pendência no acervo deste condomínio.</div>';
    if (!est.docs.length) {
      el('ra-lista').innerHTML = '<div class="ra-vazio">Nenhum documento no acervo deste condomínio ainda.' + (pode('gerenciar') ? ' Envie a convenção e o regimento acima.' : '') + '</div>';
      return;
    }
    var html = '';
    TIPOS.forEach(function (t) {
      var lista = est.docs.filter(function (d) { return d.tipo === t.v; });
      if (!lista.length) return;
      if (t.v === 'ata') {
        // Atas agrupadas por ano (a mais recente primeiro); sem data ficam no fim.
        var anos = {};
        lista.forEach(function (d) { var a = (d.data_documento || '').slice(0, 4) || 'Sem data'; (anos[a] = anos[a] || []).push(d); });
        var chaves = Object.keys(anos).sort(function (a, b) { return a === 'Sem data' ? 1 : b === 'Sem data' ? -1 : b.localeCompare(a); });
        html += '<div class="ra-grupo"><h4>Atas (' + lista.length + ')</h4>' + chaves.map(function (a) {
          return '<div style="font-size:11px;font-family:var(--mono);color:var(--muted);margin:10px 0 6px">' + esc(a) + '</div>' + anos[a].map(cartao).join('');
        }).join('') + '</div>';
      } else {
        // Vigente primeiro; as versões antigas ficam como histórico logo abaixo.
        lista.sort(function (a, b) { return (b.vigente ? 1 : 0) - (a.vigente ? 1 : 0) || String(b.data_documento || '').localeCompare(String(a.data_documento || '')); });
        html += '<div class="ra-grupo"><h4>' + esc(t.rotulo) + ' (' + lista.length + ')</h4>' + lista.map(cartao).join('') + '</div>';
      }
    });
    el('ra-lista').innerHTML = html;
  }

  // Cartão de um documento com selo, dados, resumo (ata) e botões.
  function cartao(d) {
    var comVigente = d.tipo === 'convencao' || d.tipo === 'regimento';
    var selo = comVigente ? (d.vigente ? '<span class="badge badge-ok">vale hoje</span>' : '<span class="badge badge-warn">versão antiga</span>') : '';
    var sinais = (d.tem_texto === false ? ' <span class="badge badge-err">sem texto</span>' : '') + (!d.tem_arquivo ? ' <span class="badge badge-err">sem arquivo</span>' : '');
    var sub = [d.data_documento ? 'de ' + dataBR(d.data_documento) : 'sem data', ORIGEM[d.origem] || '', d.arquivo_bytes ? (d.arquivo_bytes / 1048576).toFixed(1).replace('.', ',') + ' MB' : ''].filter(Boolean).join(' · ');
    var g = pode('gerenciar');
    var aberto = est.abertos[d.id] || '';
    return '<div class="ra-doc" id="ra-doc-' + d.id + '">' +
      '<div class="ra-doc-topo"><div><div class="ra-doc-tit">' + esc(d.titulo) + ' ' + selo + sinais + '</div><div class="ra-doc-sub">' + esc(sub) + '</div>' +
        (d.observacao ? '<div class="ra-doc-sub" style="color:var(--text)">Observação: ' + esc(d.observacao) + '</div>' : '') + '</div>' +
      '<div class="ra-acoes">' +
        (d.tem_arquivo ? '<button class="btn btn-ghost" data-acao="abrir" data-id="' + d.id + '">Abrir documento</button>' : '') +
        '<button class="btn btn-ghost" data-acao="trechos" data-id="' + d.id + '">' + (aberto === 'trechos' ? 'Fechar' : d.tipo === 'ata' ? 'Ver trechos' : 'Ver artigos') + '</button>' +
        (g && comVigente && !d.vigente ? '<button class="btn btn-ghost" data-acao="vigente" data-id="' + d.id + '">Marcar como a que vale</button>' : '') +
        (g ? '<button class="btn btn-ghost" data-acao="editar" data-id="' + d.id + '">' + (aberto === 'editar' ? 'Fechar' : 'Editar') + '</button>' : '') +
        (g ? '<button class="btn btn-danger" style="font-size:11px;padding:5px 10px" data-acao="apagar" data-id="' + d.id + '">Apagar</button>' : '') +
      '</div></div>' +
      (d.tipo === 'ata' && d.resumo ? '<div class="ra-resumo">' + esc(d.resumo) + '</div>' : '') +
      '<div class="ra-extra" id="ra-extra-' + d.id + '"></div>' +
      '</div>';
  }

  function docPorId(id) { return est.docs.find(function (d) { return String(d.id) === String(id); }) || null; }

  // Botões dos cartões e links das pendências (um ouvinte só para a lista inteira).
  function cliqueLista(ev) {
    var b = ev.target.closest('[data-acao]');
    if (!b) return;
    ev.preventDefault();
    var id = b.getAttribute('data-id');
    var acao = b.getAttribute('data-acao');
    if (acao === 'ir') { var alvo = el('ra-doc-' + id); if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (acao === 'abrir') return abrirArquivo(id, b);
    if (acao === 'trechos') return alternarTrechos(id);
    if (acao === 'vigente') return marcarVigente(id, b);
    if (acao === 'editar') return alternarEdicao(id);
    if (acao === 'salvar') return salvarEdicao(id, b);
    if (acao === 'apagar') return apagar(id, b);
  }

  // ---------- ações ----------
  // O link vale 10 minutos; a janela abre antes da resposta para o navegador não bloquear.
  async function abrirArquivo(id, botao) {
    var c = cond(); if (!c || !c.id_superlogica) return;
    var janela = window.open('about:blank', '_blank');
    botao.disabled = true;
    try {
      var j = await pedir(base(c.id_superlogica) + '/' + encodeURIComponent(id) + '/arquivo');
      if (janela) { janela.opener = null; janela.location.href = j.url; } else window.location.href = j.url;
    } catch (e) {
      if (janela) janela.close();
      avisar(e.message, 'err');
    } finally { botao.disabled = false; }
  }

  async function alternarTrechos(id) {
    var c = cond(); if (!c || !c.id_superlogica) return;
    var box = el('ra-extra-' + id);
    if (est.abertos[id] === 'trechos') { est.abertos[id] = ''; box.innerHTML = ''; atualizarBotoes(id); return; }
    est.abertos[id] = 'trechos'; atualizarBotoes(id);
    box.innerHTML = '<div class="ra-vazio">Carregando...</div>';
    var seq = est.seq;
    try {
      var j = await pedir(base(c.id_superlogica) + '/' + encodeURIComponent(id));
      if (seq !== est.seq || est.abertos[id] !== 'trechos') return;
      var t = j.trechos || [];
      box.innerHTML = t.length ? '<div style="max-height:420px;overflow:auto">' + t.map(function (x) {
        var rot = [x.rotulo, x.titulo].filter(Boolean).join(' · ');
        return '<div class="ra-trecho"><b>' + esc(rot || 'Trecho ' + x.ordem) + (x.pagina ? ' · página ' + x.pagina : '') + '</b><div>' + esc(x.texto) + '</div></div>';
      }).join('') + '</div>' : '<div class="ra-vazio">Este documento está sem texto lido, então não aparece na consulta.</div>';
    } catch (e) { box.innerHTML = '<div class="ra-vazio" style="color:var(--danger)">' + esc(e.message) + '</div>'; }
  }

  // Troca o rótulo dos botões Ver e Editar do cartão sem redesenhar a lista toda.
  function atualizarBotoes(id) {
    var d = docPorId(id); var card = el('ra-doc-' + id); if (!d || !card) return;
    var bt = card.querySelector('[data-acao="trechos"]'); if (bt) bt.textContent = est.abertos[id] === 'trechos' ? 'Fechar' : d.tipo === 'ata' ? 'Ver trechos' : 'Ver artigos';
    var be = card.querySelector('[data-acao="editar"]'); if (be) be.textContent = est.abertos[id] === 'editar' ? 'Fechar' : 'Editar';
  }

  async function marcarVigente(id, botao) {
    var c = cond(); var d = docPorId(id); if (!c || !c.id_superlogica || !d) return;
    if (!confirm('Marcar "' + d.titulo + '" como a versão que vale hoje? A versão marcada antes passa a ser histórico.')) return;
    botao.disabled = true;
    try {
      await pedir(base(c.id_superlogica) + '/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vigente: true }) });
      avisar('Versão que vale hoje atualizada');
      carregar(c.id_superlogica);
    } catch (e) { avisar(e.message, 'err'); botao.disabled = false; }
  }

  function alternarEdicao(id) {
    var d = docPorId(id); var box = el('ra-extra-' + id); if (!d || !box) return;
    if (est.abertos[id] === 'editar') { est.abertos[id] = ''; box.innerHTML = ''; atualizarBotoes(id); return; }
    est.abertos[id] = 'editar'; atualizarBotoes(id);
    var comVigente = d.tipo === 'convencao' || d.tipo === 'regimento';
    box.innerHTML = '<div class="ra-form">' +
      '<div class="form-group"><label>Tipo</label><select id="ra-ed-tipo-' + id + '">' + TIPOS.map(function (t) { return '<option value="' + t.v + '"' + (t.v === d.tipo ? ' selected' : '') + '>' + esc(TIPO_UM[t.v]) + '</option>'; }).join('') + '</select></div>' +
      '<div class="form-group" style="grid-column:span 2"><label>Título</label><input type="text" maxlength="200" id="ra-ed-titulo-' + id + '" value="' + esc(d.titulo) + '"></div>' +
      '<div class="form-group"><label>Data</label><input type="date" id="ra-ed-data-' + id + '" value="' + esc(d.data_documento || '') + '"></div>' +
      '<div class="form-group" style="grid-column:1/-1"><label>Observação</label><textarea rows="2" maxlength="1000" id="ra-ed-obs-' + id + '">' + esc(d.observacao || '') + '</textarea></div>' +
      (comVigente ? '<div class="form-group"><label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:12px"><input type="checkbox" id="ra-ed-vig-' + id + '"' + (d.vigente ? ' checked' : '') + '> Vale hoje</label></div>' : '') +
      '<div class="form-group"><button class="btn btn-primary" style="font-size:12px;padding:7px 14px" data-acao="salvar" data-id="' + id + '">Salvar</button></div>' +
      '</div><div class="ra-doc-sub" style="margin-top:6px">Mudar o tipo refaz a divisão em artigos ou trechos.</div>';
  }

  async function salvarEdicao(id, botao) {
    var c = cond(); var d = docPorId(id); if (!c || !c.id_superlogica || !d) return;
    var corpo = {
      titulo: el('ra-ed-titulo-' + id).value,
      tipo: el('ra-ed-tipo-' + id).value,
      data_documento: el('ra-ed-data-' + id).value || null,
      observacao: el('ra-ed-obs-' + id).value
    };
    var vig = el('ra-ed-vig-' + id);
    if (vig && vig.checked !== !!d.vigente) {
      if (vig.checked && !confirm('Marcar este documento como a versão que vale hoje? A versão marcada antes passa a ser histórico.')) return;
      corpo.vigente = vig.checked;
    }
    botao.disabled = true;
    try {
      await pedir(base(c.id_superlogica) + '/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      est.abertos[id] = '';
      avisar('Documento atualizado');
      carregar(c.id_superlogica);
    } catch (e) { avisar(e.message, 'err'); botao.disabled = false; }
  }

  async function apagar(id, botao) {
    var c = cond(); var d = docPorId(id); if (!c || !c.id_superlogica || !d) return;
    var extra = d.vigente && (d.tipo === 'convencao' || d.tipo === 'regimento') ? ' Ele está marcado como a versão que vale hoje.' : '';
    if (!confirm('Apagar "' + d.titulo + '" do acervo de ' + (c.nome || 'este condomínio') + '?' + extra + ' O PDF e os artigos saem da consulta. Não dá para desfazer.')) return;
    botao.disabled = true;
    try {
      await pedir(base(c.id_superlogica) + '/' + encodeURIComponent(id), { method: 'DELETE' });
      avisar('Documento apagado');
      carregar(c.id_superlogica);
    } catch (e) { avisar(e.message, 'err'); botao.disabled = false; }
  }

  // ---------- envio ----------
  function msgEnvio(texto, cor) { var m = el('ra-envio-msg'); if (m) { m.style.color = cor || 'var(--muted)'; m.textContent = texto || ''; } }

  function lerArquivo(arquivo) {
    return new Promise(function (ok, falha) {
      var r = new FileReader();
      r.onload = function () { ok(r.result); };
      r.onerror = function () { falha(new Error('Não foi possível ler o arquivo no navegador.')); };
      r.readAsArrayBuffer(arquivo);
    });
  }
  // ArrayBuffer em base64 em pedaços (arquivo grande estoura a pilha numa chamada só).
  function paraBase64(buf) {
    if (window.ArquivarSL && ArquivarSL.paraBase64) return ArquivarSL.paraBase64(buf);
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Confere na tela (tipo, título, PDF de até 50 MB), manda em base64 e acompanha a leitura
  // do digitalizado (o servidor responde 202 e a tela pergunta a cada 5 segundos).
  async function enviar() {
    if (est.enviando) return;
    var c = cond(); if (!c || !c.id_superlogica) { avisar('Escolha um condomínio primeiro', 'err'); return; }
    var tipo = el('ra-tipo').value;
    var titulo = el('ra-titulo-doc').value.replace(/\s+/g, ' ').trim();
    var arq = el('ra-arquivo').files && el('ra-arquivo').files[0];
    if (titulo.length < 3) { msgEnvio('Escreva um título com pelo menos 3 letras.', 'var(--danger)'); return; }
    if (!arq) { msgEnvio('Escolha o arquivo PDF.', 'var(--danger)'); return; }
    if (!/\.pdf$/i.test(arq.name) && arq.type !== 'application/pdf') { msgEnvio('O arquivo precisa ser PDF.', 'var(--danger)'); return; }
    if (arq.size > MAX_MB * 1048576) { msgEnvio('O PDF passa de ' + MAX_MB + ' MB. Divida o arquivo em partes.', 'var(--danger)'); return; }
    var vigente = (tipo === 'convencao' || tipo === 'regimento') ? el('ra-vigente').checked : true;
    var idEnvio = c.id_superlogica;
    est.enviando = true; el('ra-enviar').disabled = true;
    msgEnvio('Enviando e lendo o documento...', 'var(--gs-blue)');
    try {
      var buf = await lerArquivo(arq);
      var cabeca = new Uint8Array(buf.slice(0, 1024)); var txt = '';
      for (var i = 0; i < cabeca.length; i++) txt += String.fromCharCode(cabeca[i]);
      if (txt.indexOf('%PDF-') < 0) throw new Error('O arquivo não é um PDF.');
      var j = await pedir(base(idEnvio), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: tipo, titulo: titulo, data_documento: el('ra-data').value || null, vigente: vigente, pdf_base64: paraBase64(buf) }) });
      if (j._status === 202 && j.tarefa) {
        msgEnvio('O PDF é digitalizado (' + j.paginas + ' páginas). A leitura leva alguns minutos; pode continuar usando o Hub, o documento aparece na lista quando terminar.', 'var(--warning)');
        j = await acompanhar(idEnvio, j.tarefa);
      }
      concluido(j, idEnvio);
    } catch (e) {
      msgEnvio(e.message, 'var(--danger)');
    } finally {
      est.enviando = false; el('ra-enviar').disabled = false;
    }
  }
  async function acompanhar(idEnvio, tarefa) {
    for (var n = 0; n < 360; n++) { // até 30 minutos
      await new Promise(function (ok) { setTimeout(ok, 5000); });
      var j = await pedir('/api/regras/' + encodeURIComponent(idEnvio) + '/envios/' + encodeURIComponent(tarefa));
      if (j.status === 'pronto') return j;
      if (j.status === 'erro') throw new Error(j.detalhe || 'Não foi possível concluir a leitura.');
    }
    throw new Error('A leitura está demorando mais que o normal. Confira a lista daqui a pouco.');
  }
  function concluido(j, idEnvio) {
    if (j.duplicado) { msgEnvio(j.detalhe || 'Este documento já estava no acervo.', 'var(--warning)'); return; }
    msgEnvio('Documento guardado: ' + (j.paginas || 0) + ' páginas, ' + (j.trechos || 0) + ' artigos ou trechos para consulta' + (j.escaneado ? ' (lido a partir do PDF digitalizado; confira os artigos).' : '.'), 'var(--success)');
    avisar('Documento guardado no acervo');
    el('ra-titulo-doc').value = ''; el('ra-arquivo').value = ''; el('ra-data').value = '';
    var c = cond();
    if (c && String(c.id_superlogica) === String(idEnvio)) carregar(idEnvio);
  }

  // ---------- pendências de todos ----------
  async function carregarGeral() {
    var box = el('ra-geral-lista');
    var seq = ++est.geralSeq;
    box.innerHTML = '<div class="ra-vazio">Carregando...</div>';
    try {
      var j = await pedir('/api/regras/pendencias');
      if (seq !== est.geralSeq) return;
      var com = (j.condominios || []).filter(function (x) { return x.pendencias.length; });
      box.innerHTML = '<div class="ra-doc-sub" style="margin-bottom:8px">' + (j.com_pendencia || 0) + ' de ' + (j.total || 0) + ' condomínios com pendência.</div>' +
        (com.length ? '<div class="table-wrap"><table><thead><tr><th>Condomínio</th><th>Documentos</th><th>Pendências</th></tr></thead><tbody>' + com.map(function (x) {
          var ct = x.contagens || {};
          return '<tr><td><a href="#" data-sl="' + esc(x.id_superlogica) + '" style="color:var(--gs-blue)">' + esc(x.nome || ('código ' + x.id_superlogica)) + '</a></td>' +
            '<td>' + (ct.convencao || 0) + ' conv. · ' + (ct.regimento || 0) + ' reg. · ' + (ct.ata || 0) + ' atas</td>' +
            '<td style="white-space:normal">' + x.pendencias.map(function (p) { return esc(p.texto); }).join('<br>') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="ra-vazio" style="color:var(--success)">Nenhum condomínio com pendência.</div>');
    } catch (e) { if (seq === est.geralSeq) box.innerHTML = '<div class="ra-vazio" style="color:var(--danger)">' + esc(e.message) + '</div>'; }
  }
  // Clique num condomínio da lista geral troca o condomínio ativo (a aba recarrega pelo evento).
  function cliqueGeral(ev) {
    var a = ev.target.closest('[data-sl]');
    if (!a) return;
    ev.preventDefault();
    var sl = a.getAttribute('data-sl');
    var lista = window.CondSeletor && CondSeletor.lista ? (CondSeletor.lista() || []) : [];
    var c = lista.find(function (x) { return String(x.id_superlogica) === String(sl); });
    if (c && CondSeletor.definir(c)) { var r = el(RAIZ); if (r) r.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else avisar('Não achei esse condomínio no seletor.', 'err');
  }

  // ---------- eventos ----------
  window.addEventListener('regras-aba', function (e) { if (e && e.detail === 'acervo' && pode('ver')) abrir(false); });
  // Trocou o condomínio: o que estava na tela era do anterior.
  window.addEventListener('condominioAtivo:trocou', function () {
    est.seq++; est.idCarregado = null; est.docs = []; est.abertos = {};
    if (el('ra-envio-msg') && !est.enviando) msgEnvio('');
    if (raizVisivel()) abrir(true);
  });
  document.addEventListener('auth:ready', function () { setTimeout(function () { if (raizVisivel() && pode('ver')) abrir(false); }, 0); });

  window.RegrasAcervo = { abrir: abrir };
})();
