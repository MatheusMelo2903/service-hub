// ============================================================
// REGRAS DO CONDOMÍNIO: importação do acervo exportado do CondGPT (só GESTOR).
// O arquivo (cerca de 44 MB) é lido aqui no navegador; o servidor recebe um condomínio por
// vez (e, se o condomínio for grande, em partes). Passos na tela: escolher o arquivo, conferir
// o mapa (condomínio do arquivo x condomínio do Superlógica pelo CNPJ, com campo para corrigir
// o código), importar com barra de progresso e acompanhar a cópia dos PDFs.
// Rotas: /api/regras/importar/mapa, /mapa/:slug, /condominio, /status, /retomar-pdfs.
// Monta dentro de #regras-importar quando a aba aparece (evento 'regras-aba', detail 'importar').
// ============================================================
(function () {
  var LIMITE_PARTE = 18 * 1024 * 1024; // abaixo do limite de 25 MB da rota, com folga
  var est = { montado: false, arquivo: null, conds: {}, mapa: [], importando: false, timer: null, resultados: [] };

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function el(id) { return document.getElementById(id); }
  function num(n) { return Number(n || 0).toLocaleString('pt-BR'); }
  function aviso(t, tipo) { if (typeof toast === 'function') toast(t, tipo || 'ok'); }
  async function api(url, opt) {
    var r = await apiAuthFetch(url, opt || {});
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.detalhe || (textoFalha(r.status))); e.status = r.status; throw e; }
    return j;
  }
  function postJson(url, corpo, metodo) {
    return api(url, { method: metodo || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  }
  var SITUACAO = {
    ok: ['badge-ok', 'Ligado pelo CNPJ'], manual: ['badge-ok', 'Código informado'],
    sem_correspondencia: ['badge-err', 'Sem correspondência'], ambiguo: ['badge-warn', 'Mais de um no Superlógica'],
    ignorado: ['badge-warn', 'Não importar'],
  };

  // 1. Estrutura da tela (uma vez).
  function montar() {
    var box = el('regras-importar');
    if (!box || est.montado) return;
    est.montado = true;
    box.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><span class="card-title">Importar acervo do sistema antigo</span></div>' +
        '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Escolha o arquivo de exportação (.json). Ele é lido aqui no navegador e cada condomínio é enviado separadamente. Pode importar de novo sem medo: o que já entrou não é duplicado.</div>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<input type="file" id="rimp-arquivo" accept=".json,application/json" style="font-size:12px">' +
          '<button class="btn btn-ghost" id="rimp-btn-mapa" disabled>Conferir no Superlógica de novo</button>' +
        '</div>' +
        '<div id="rimp-msg" style="margin-top:10px"></div>' +
      '</div>' +
      '<div class="card" id="rimp-card-mapa" style="display:none">' +
        '<div class="card-header"><span class="card-title">Condomínios do arquivo</span><span id="rimp-resumo-mapa" style="font-size:12px;font-family:var(--mono);color:var(--muted)"></span></div>' +
        '<div style="overflow-x:auto"><table class="data-table" style="width:100%;font-size:12px"><thead><tr>' +
          '<th>Condomínio no sistema antigo</th><th>CNPJ</th><th>Documentos</th><th>Notificações</th><th>Condomínio no Superlógica</th><th>Situação</th><th>Código</th>' +
        '</tr></thead><tbody id="rimp-tabela"></tbody></table></div>' +
        '<div style="display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap">' +
          '<button class="btn btn-primary" id="rimp-btn-importar">Importar</button>' +
          '<span id="rimp-andamento" style="font-size:12px;font-family:var(--mono);color:var(--muted)"></span>' +
        '</div>' +
        '<div class="progress-wrap" style="height:6px"><div class="progress-bar" id="rimp-barra" style="width:0%"></div></div>' +
        '<div id="rimp-final"></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><span class="card-title">Cópia dos PDFs</span>' +
          '<button class="btn btn-ghost" id="rimp-btn-retomar" title="Coloca de novo na fila os documentos importados que ainda estão sem PDF">Retomar PDFs que faltam</button></div>' +
        '<div class="progress-wrap" style="height:6px"><div class="progress-bar" id="rimp-barra-pdf" style="width:0%"></div></div>' +
        '<div id="rimp-pdf" style="font-size:12px;font-family:var(--mono);color:var(--muted)">Sem cópia em andamento.</div>' +
      '</div>';
    el('rimp-arquivo').addEventListener('change', lerArquivo);
    el('rimp-btn-mapa').addEventListener('click', function () { carregarMapa(true); });
    el('rimp-btn-importar').addEventListener('click', importarTudo);
    el('rimp-btn-retomar').addEventListener('click', retomarPdfs);
    el('rimp-tabela').addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button[data-slug]') : null;
      if (b) salvarCodigo(b.getAttribute('data-slug'));
    });
    atualizarPdf();
  }
  function msg(texto, erro) {
    var m = el('rimp-msg');
    if (m) m.innerHTML = texto ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : '';
  }

  // 2. Leitura do arquivo no navegador e montagem do mapa.
  function lerArquivo() {
    var f = this.files && this.files[0];
    if (!f) return;
    if (f.size > 300 * 1024 * 1024) { msg('Arquivo grande demais para este navegador.', true); return; }
    msg('Lendo o arquivo (' + num(Math.round(f.size / 1048576)) + ' MB)...');
    var rd = new FileReader();
    rd.onerror = function () { msg('Não foi possível ler o arquivo.', true); };
    rd.onload = function () {
      var j = null;
      try { j = JSON.parse(rd.result); } catch (e) { msg('O arquivo não é um JSON válido.', true); return; }
      if (!j || typeof j.condominios !== 'object' || Array.isArray(j.condominios)) { msg('Este arquivo não parece ser a exportação do sistema antigo.', true); return; }
      est.arquivo = { nome: f.name, exportado_em: j.exportado_em || '' };
      est.conds = j.condominios;
      est.resultados = [];
      el('rimp-btn-mapa').disabled = false;
      var n = Object.keys(est.conds).length;
      msg('Arquivo lido: ' + num(n) + ' condomínios' + (j.exportado_em ? ', exportado em ' + String(j.exportado_em).slice(0, 10).split('-').reverse().join('/') : '') + '. Conferindo no Superlógica...');
      carregarMapa(false);
    };
    rd.readAsText(f, 'utf-8');
  }
  function cnpjDe(c) { return String((c && c.dados && c.dados.inscricao) || '').replace(/\D/g, ''); }
  function fmtCnpj(d) { return d && d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4.$5') : (d || ''); }

  async function carregarMapa(atualizar) {
    var lista = Object.keys(est.conds).map(function (slug) {
      var c = est.conds[slug] || {};
      return { slug: slug, label: c.label || (c.dados && c.dados.nome) || slug, cnpj: cnpjDe(c) };
    });
    if (!lista.length) { msg('O arquivo não tem condomínios.', true); return; }
    try {
      var j = await postJson('/api/regras/importar/mapa', { condominios: lista, atualizar: !!atualizar });
      est.mapa = j.mapa || [];
      msg('');
      desenharMapa();
    } catch (e) { msg('Não foi possível montar o mapa: ' + e.message, true); }
  }

  // Linha da tabela: o campo de código fica sempre editável (menos nos que não importam).
  function desenharMapa() {
    el('rimp-card-mapa').style.display = '';
    var ok = 0, falta = 0;
    el('rimp-tabela').innerHTML = est.mapa.map(function (m) {
      var c = est.conds[m.slug] || {};
      var s = SITUACAO[m.situacao] || ['badge-warn', m.situacao];
      if (m.id_superlogica) ok++; else if (m.situacao !== 'ignorado') falta++;
      var res = est.resultados.filter(function (r) { return r.slug === m.slug; })[0];
      var codigo = m.situacao === 'ignorado' ? '<span style="color:var(--muted)">' + esc(m.observacao || '') + '</span>' :
        '<input type="text" inputmode="numeric" id="rimp-cod-' + esc(m.slug) + '" value="' + esc(m.id_superlogica || '') + '" style="width:80px;font-family:var(--mono);font-size:12px"> ' +
        '<button class="btn btn-ghost" style="padding:3px 8px;font-size:11px" data-slug="' + esc(m.slug) + '">Salvar</button>';
      // Nomes, observacao e erro da importacao sao textos livres: quebram na celula (td-livre no index.html)
      return '<tr>' +
        '<td class="td-livre" title="' + esc(m.nome || m.slug) + '"><div class="td-2l">' + esc(m.nome || m.slug) + '</div><div style="font-size:11px;color:var(--muted);font-family:var(--mono)">' + esc(m.slug) + '</div></td>' +
        '<td style="font-family:var(--mono)">' + esc(fmtCnpj(m.cnpj)) + '</td>' +
        '<td>' + num((c.docs || []).length) + '</td>' +
        '<td>' + num((c.notif || []).length) + '</td>' +
        '<td class="td-livre" title="' + esc(m.nome_superlogica || '') + '"><div class="td-2l">' + esc(m.nome_superlogica || '') + '</div></td>' +
        '<td class="td-livre"><span class="badge ' + s[0] + '">' + esc(s[1]) + '</span>' + (res ? '<div style="font-size:11px;margin-top:3px;color:' + (res.erro ? 'var(--danger)' : 'var(--success)') + '">' + esc(res.erro ? 'Falhou: ' + res.erro : 'Importado') + '</div>' : '') + '</td>' +
        '<td' + (m.situacao === 'ignorado' ? ' class="td-livre"' : '') + '>' + codigo + '</td>' +
      '</tr>';
    }).join('');
    el('rimp-resumo-mapa').textContent = num(ok) + ' ligados, ' + num(falta) + ' sem código';
  }

  async function salvarCodigo(slug) {
    var inp = el('rimp-cod-' + slug);
    var v = inp ? String(inp.value || '').trim() : '';
    if (v && !/^[1-9]\d{0,8}$/.test(v)) { aviso('Código do Superlógica inválido', 'err'); return; }
    try {
      var j = await postJson('/api/regras/importar/mapa/' + encodeURIComponent(slug), { id_superlogica: v || null }, 'PUT');
      est.mapa = est.mapa.map(function (m) { return m.slug === slug ? Object.assign({}, m, { id_superlogica: j.id_superlogica, nome_superlogica: j.nome_superlogica, situacao: j.situacao, observacao: j.observacao }) : m; });
      desenharMapa();
      aviso(j.id_superlogica ? 'Código salvo: ' + (j.nome_superlogica || j.id_superlogica) : 'Ligação retirada', 'ok');
    } catch (e) { aviso('Não foi possível salvar: ' + e.message, 'err'); }
  }

  // 3. Envio. Condomínio grande vai em partes: a primeira leva convenção, regimento,
  // notificações e comunicados; as atas em PDF seguem em partes; as atas geradas vão na última
  // (para o servidor já conhecer as datas das atas e não duplicar).
  function tamanho(o) { return JSON.stringify(o).length * 1.1; }
  function partesDe(c) {
    var docs = Array.isArray(c.docs) ? c.docs : [];
    var normas = docs.filter(function (d) { return !/^atas?$/i.test(String(d.tipo || '').trim()); });
    var atas = docs.filter(function (d) { return /^atas?$/i.test(String(d.tipo || '').trim()); });
    var primeira = { dados: c.dados, docs: normas, notif: c.notif || [], com: c.com || [], atas: [] };
    var completo = Object.assign({}, primeira, { docs: docs, atas: c.atas || [] });
    if (tamanho(completo) < LIMITE_PARTE) return [completo];
    var partes = [primeira];
    var atual = { dados: c.dados, docs: [] }, tam = 0;
    atas.forEach(function (d) {
      var t = tamanho(d);
      if (atual.docs.length && tam + t > LIMITE_PARTE) { partes.push(atual); atual = { dados: c.dados, docs: [] }; tam = 0; }
      atual.docs.push(d); tam += t;
    });
    if (atual.docs.length) partes.push(atual);
    var geradas = c.atas || [];
    var ultima = partes[partes.length - 1];
    if (partes.length > 1 && tamanho(ultima) + tamanho(geradas) < LIMITE_PARTE) ultima.atas = geradas;
    else partes.push({ dados: c.dados, docs: [], atas: geradas });
    return partes;
  }
  function somar(a, b) {
    ['novos', 'duplicados', 'erros'].forEach(function (k) { a[k] = (a[k] || 0) + ((b && b[k]) || 0); });
    return a;
  }

  // Um condomínio por vez; falha de um não para os outros.
  async function importarTudo() {
    if (est.importando) return;
    var fila = est.mapa.filter(function (m) { return m.id_superlogica && m.situacao !== 'ignorado' && est.conds[m.slug]; });
    if (!fila.length) { aviso('Nenhum condomínio ligado a um código do Superlógica', 'err'); return; }
    var pulados = est.mapa.filter(function (m) { return !m.id_superlogica && m.situacao !== 'ignorado'; });
    if (!confirm('Importar ' + fila.length + ' condomínios para o acervo do Hub?' + (pulados.length ? '\n' + pulados.length + ' ficam de fora por não terem código do Superlógica.' : ''))) return;
    est.importando = true; est.resultados = [];
    var bt = el('rimp-btn-importar'); bt.disabled = true;
    var tot = { documentos: {}, notificacoes: {}, comunicados: {}, atas_geradas: {}, pdfs: 0, erros: [] };
    el('rimp-final').innerHTML = '';
    for (var i = 0; i < fila.length; i++) {
      var m = fila[i];
      el('rimp-andamento').textContent = 'Importando ' + (i + 1) + ' de ' + fila.length + ': ' + (m.nome || m.slug);
      el('rimp-barra').style.width = Math.round(i / fila.length * 100) + '%';
      var partes = partesDe(est.conds[m.slug]);
      var erroCond = null;
      for (var p = 0; p < partes.length; p++) {
        try {
          var j = await postJson('/api/regras/importar/condominio', { slug: m.slug, bloco: partes[p] });
          ['documentos', 'notificacoes', 'comunicados', 'atas_geradas'].forEach(function (k) { somar(tot[k], j[k]); });
          tot.pdfs += j.pdfs_enfileirados || 0;
          (j.erros || []).forEach(function (e) { tot.erros.push((m.nome || m.slug) + ': ' + e); });
        } catch (e) { erroCond = e.message; tot.erros.push((m.nome || m.slug) + ': ' + e.message); break; }
      }
      est.resultados.push({ slug: m.slug, erro: erroCond });
      atualizarPdf();
    }
    el('rimp-barra').style.width = '100%';
    el('rimp-andamento').textContent = 'Concluído: ' + fila.length + ' condomínios.';
    est.importando = false; bt.disabled = false;
    desenharMapa();
    desenharResumo(tot, pulados);
    if (typeof addHistorico === 'function') addHistorico('Acervo do sistema antigo importado: ' + fila.length + ' condomínios');
  }
  function linhaResumo(rotulo, c) {
    return '<tr><td>' + esc(rotulo) + '</td><td>' + num(c.novos) + '</td><td>' + num(c.duplicados) + '</td><td>' + num(c.erros) + '</td></tr>';
  }
  function desenharResumo(tot, pulados) {
    el('rimp-final').innerHTML =
      '<table class="data-table" style="width:100%;font-size:12px;margin-top:8px"><thead><tr><th>Resumo</th><th>Novos</th><th>Já existiam</th><th>Com erro</th></tr></thead><tbody>' +
        linhaResumo('Documentos (convenção, regimento, atas)', tot.documentos) +
        linhaResumo('Notificações', tot.notificacoes) +
        linhaResumo('Comunicados', tot.comunicados) +
        linhaResumo('Atas geradas no sistema antigo', tot.atas_geradas) +
      '</tbody></table>' +
      '<div style="font-size:12px;font-family:var(--mono);color:var(--muted);margin-top:8px">' + num(tot.pdfs) + ' PDFs na fila de cópia.' +
        (pulados.length ? ' Sem código do Superlógica (não importados): ' + esc(pulados.map(function (m) { return m.nome || m.slug; }).join(', ')) + '.' : '') + '</div>' +
      (tot.erros.length ? '<details style="margin-top:8px;font-size:12px"><summary style="cursor:pointer;color:var(--danger)">' + num(tot.erros.length) + ' avisos de erro</summary><div style="font-family:var(--mono);font-size:11px;margin-top:6px">' +
        tot.erros.slice(0, 200).map(esc).join('<br>') + '</div></details>' : '');
  }

  // 4. Progresso da cópia dos PDFs (consulta a cada 5 segundos enquanto houver fila).
  async function atualizarPdf() {
    clearTimeout(est.timer);
    var box = el('rimp-pdf');
    if (!box) return;
    try {
      var s = await api('/api/regras/importar/status');
      var feitos = (s.copiados || 0) + (s.falhas || 0);
      el('rimp-barra-pdf').style.width = (s.total ? Math.round(feitos / s.total * 100) : 0) + '%';
      var ativo = s.em_andamento > 0 || s.pendentes > 0;
      box.innerHTML = !s.total ? 'Sem cópia em andamento.' :
        esc(num(s.copiados) + ' de ' + num(s.total) + ' copiados' + (s.falhas ? ', ' + num(s.falhas) + ' com falha' : '') + (ativo ? ', ' + num(s.em_andamento) + ' copiando agora' : '. Fila concluída.')) +
        (s.ultimas_falhas && s.ultimas_falhas.length ? '<div style="margin-top:6px;color:var(--danger)">' + s.ultimas_falhas.slice(0, 5).map(function (f) { return esc('Documento ' + f.documento_id + ': ' + f.motivo); }).join('<br>') + '</div>' : '');
      if (ativo || est.importando) est.timer = setTimeout(atualizarPdf, 5000);
    } catch (e) {
      box.textContent = 'Não foi possível ler o progresso agora.';
      if (est.importando) est.timer = setTimeout(atualizarPdf, 10000);
    }
  }
  async function retomarPdfs() {
    var bt = el('rimp-btn-retomar'); bt.disabled = true;
    try {
      var j = await postJson('/api/regras/importar/retomar-pdfs', {});
      aviso(j.pendentes ? num(j.enfileirados) + ' PDFs voltaram para a fila' : 'Nenhum PDF faltando', 'ok');
      atualizarPdf();
    } catch (e) { aviso('Não foi possível retomar: ' + e.message, 'err'); }
    finally { bt.disabled = false; }
  }

  window.addEventListener('regras-aba', function (e) { if (e && e.detail === 'importar') { montar(); atualizarPdf(); } });
  window.regrasImportarAbrir = function () { montar(); atualizarPdf(); };
})();
