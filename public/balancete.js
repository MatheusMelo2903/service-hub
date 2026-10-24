// ============================================================
// BALANCETE DIGITAL (T41): cartão dentro da aba Financeiro. Desde 23/10/2026 é o módulo
// balancete (ver = conferir, gerar = pedir o 900A), liberável por pessoa; o GESTOR vê sempre. Lista os 900A do mês
// do condomínio ativo no topo, confere o PDF (mês em todas as capas e relatórios, itens da seleção,
// comprovantes contra as despesas pagas no mês, páginas em branco ou repetidas) e, onde a geração
// estiver liberada, pede o 900A ao Superlógica SEM publicar. Publicar para os condôminos continua
// no Superlógica, com clique humano. Rotas: /api/financeiro/balancete/:id/(impressoes|conferencia|gerar).
// O servidor confere tudo de novo: aqui é só o que aparece na tela.
// ============================================================
(function () {
  // Módulo no catálogo de permissões, para aparecer na tela de editar permissões.
  if (typeof MODULOS_CATALOGO !== 'undefined' && !MODULOS_CATALOGO.balancete) {
    MODULOS_CATALOGO.balancete = { label: 'Balancete digital (precisa também do Financeiro)', acoes: ['ver', 'gerar'] };
  }
  var est = { seq: 0, cond: null, mes: '', lista: [] };
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function mesISO(delta) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + delta); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  // Mesma regra do servidor: Financeiro aberto e o módulo balancete (o GESTOR passa sozinho).
  function temBal(acao) {
    if (window.USER_ROLE === 'GESTOR' && window.USER_PERMS) return true;
    var p = window.USER_PERMS && window.USER_PERMS.balancete;
    return !!(p && p.visivel === true && Array.isArray(p.acoes) && p.acoes.indexOf(acao) >= 0);
  }
  function pode() {
    return typeof window.podeAbrirPainel === 'function' && window.podeAbrirPainel('fincontrole') && temBal('ver');
  }
  function condAtivo() {
    var c = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
    var id = c ? String(c.id_superlogica || '') : '';
    return /^\d+$/.test(id) ? { id: id, nome: c.nome || '' } : null;
  }
  function info(texto, erro) {
    var el = document.getElementById('bal-info');
    if (el) el.innerHTML = texto ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : '';
  }

  function montarCartao() {
    var painel = document.getElementById('panel-fincontrole');
    if (!painel) return;
    var card = document.getElementById('bal-card');
    if (!pode()) { if (card) card.style.display = 'none'; return; }
    if (card) { card.style.display = ''; return; }
    card = document.createElement('div');
    card.className = 'card';
    card.id = 'bal-card';
    card.innerHTML = '<div class="card-header"><span class="card-title">Balancete digital (900A)</span></div>'
      + '<div class="hint" style="margin-bottom:8px">Condomínio ativo no topo. O Hub confere o PDF do 900A gerado no Superlógica. A publicação para os condôminos é feita no Balancete do mês, depois da conferência. Ao gerar, o Hub troca o mês da seleção NOVA no Superlógica, que fica no último mês gerado.</div>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<label style="font-size:12px">Mês da prestação <input type="month" id="bal-mes" value="' + mesISO(-1) + '" max="' + mesISO(0) + '" style="width:auto"></label>'
      + '<button class="btn btn-primary" id="bal-listar">Listar 900A do mês</button>'
      + '<button class="btn btn-ghost" id="bal-gerar" style="display:none" title="Pede ao Superlógica o 900A deste mês sem publicar">Gerar balancete (sem publicar)</button>'
      + '</div><div id="bal-info" style="margin:8px 0"></div><div id="bal-lista"></div><div id="bal-resultado"></div>';
    painel.appendChild(card);
    document.getElementById('bal-listar').addEventListener('click', listar);
    document.getElementById('bal-gerar').addEventListener('click', gerar);
  }

  async function listar() {
    var c = condAtivo();
    var mes = (document.getElementById('bal-mes') || {}).value || '';
    document.getElementById('bal-resultado').innerHTML = '';
    if (!c) { info('Escolha o condomínio no topo.', true); return; }
    if (!/^\d{4}-\d{2}$/.test(mes)) { info('Escolha o mês.', true); return; }
    var seq = ++est.seq;
    est.cond = c; est.mes = mes;
    document.getElementById('bal-gerar').style.display = 'none';
    info('Buscando os 900A de ' + c.nome + '...');
    try {
      var r = await apiAuthFetch('/api/financeiro/balancete/' + encodeURIComponent(c.id) + '/impressoes?competencia=' + encodeURIComponent(mes));
      var j = await r.json().catch(function () { return {}; });
      if (seq !== est.seq) return;
      if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
      est.lista = j.impressoes || [];
      document.getElementById('bal-gerar').style.display = (j.geracao_liberada && temBal('gerar')) ? '' : 'none';
      // null no condomínio de teste (a tela confirma); 'reforcada' fora dele (a janela da política confirma).
      est.geracaoConfirmacao = j.geracao_confirmacao || null;
      est.gerarArmado = false;
      desenharLista();
      info(est.lista.length ? '' : 'Nenhum 900A gerado para este mês ainda.');
    } catch (e) { if (seq === est.seq) info(e.message, true); }
  }
  function desenharLista() {
    var l = document.getElementById('bal-lista');
    if (!est.lista.length) { l.innerHTML = ''; return; }
    l.innerHTML = '<table class="tbl" style="width:100%;font-size:12px"><thead><tr><th>Impressão</th><th>Gerado em</th><th>Título</th><th>Mês</th><th>Situação</th><th></th></tr></thead><tbody>'
      + est.lista.map(function (x) {
        // Titulo da impressao e texto livre do Superlogica: quebra em ate 2 linhas para nao alargar a tabela
        return '<tr><td>' + esc(x.id) + '</td><td>' + esc(x.criado_em) + '</td><td class="td-livre" title="' + esc(x.titulo) + '"><div class="td-2l">' + esc(x.titulo) + '</div></td><td>' + esc(x.descricao) + (x.da_competencia ? '' : ' (outro mês)')
          + '</td><td>' + (x.publicado ? 'Publicado' : 'Só administração') + '</td><td><button class="btn btn-ghost" style="font-size:11px;padding:4px 10px" data-bal-conferir="' + esc(x.id) + '"'
          + (x.da_competencia ? '' : ' disabled') + '>' + (x.conferencia === 'pronto' ? 'Ver conferência' : 'Conferir') + '</button></td></tr>';
      }).join('') + '</tbody></table>';
    l.querySelectorAll('[data-bal-conferir]').forEach(function (b) {
      b.addEventListener('click', function () { conferir(b.getAttribute('data-bal-conferir'), false); });
    });
  }

  async function conferir(idImp, repetir) {
    if (!est.cond || !/^\d+$/.test(String(idImp))) return;
    var seq = ++est.seq;
    var alvo = document.getElementById('bal-resultado');
    alvo.innerHTML = '';
    var url = '/api/financeiro/balancete/' + encodeURIComponent(est.cond.id) + '/conferencia?competencia=' + encodeURIComponent(est.mes) + '&impressao=' + encodeURIComponent(idImp) + (repetir ? '&repetir=1' : '');
    try {
      for (var t = 0; t < 60; t++) {
        var r = await apiAuthFetch(t ? url.replace('&repetir=1', '') : url);
        var j = await r.json().catch(function () { return {}; });
        if (seq !== est.seq) return;
        if (r.status === 202 || r.status === 429) { info((j.detalhe || 'Conferindo...') + ' (' + (t * 5) + ' s)'); await new Promise(function (ok) { setTimeout(ok, 5000); }); continue; }
        if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
        info('');
        desenharResultado(idImp, j.resultado || {}, j.concluido_em);
        return;
      }
      throw new Error('A conferência está demorando mais que o normal. Tente de novo em alguns minutos.');
    } catch (e) {
      if (seq !== est.seq) return;
      info(e.message, true);
      alvo.innerHTML = '<button class="btn btn-ghost" id="bal-repetir" style="font-size:12px">Conferir de novo</button>';
      document.getElementById('bal-repetir').addEventListener('click', function () { conferir(idImp, true); });
    }
  }

  function linha(ok, titulo, detalhe) {
    return '<div style="padding:6px 0;border-bottom:1px solid var(--border)"><span style="font-weight:600;color:' + (ok ? 'var(--success, #2e7d32)' : 'var(--danger)') + '">'
      + (ok ? 'OK' : 'Ver') + '</span> ' + esc(titulo) + (detalhe ? '<div class="hint" style="margin:4px 0 0 28px">' + detalhe + '</div>' : '') + '</div>';
  }
  function desenharResultado(idImp, r, quando) {
    var c = r.comprovantes || {};
    var it = r.itens || { presentes: [], faltando: [] };
    var mesFora = r.mes_fora || [], branco = r.paginas_em_branco || [], rep = r.paginas_repetidas || [], campos = r.campos_nao_preenchidos || [];
    var semComp = c.sem_comprovante_no_pdf || [], extra = c.no_pdf_sem_liquidacao_no_mes || [], parcRep = c.parcela_repetida || [];
    var semItens = !!it.nao_conferido;
    var html = '<div style="margin-top:10px;font-size:13px"><b>Impressão ' + esc(idImp) + '</b>: ' + esc(r.total_paginas) + ' páginas, mês ' + esc(r.mes)
      + (r.ok && !semItens ? '. Tudo conferido, pode seguir para publicar no Superlógica.' : r.ok ? '. Sem problemas no que foi conferido, mas os itens da seleção não foram conferidos.' : '. ' + esc(r.problemas) + ' ponto(s) para olhar antes de publicar.') + '</div>';
    if (r.aviso) html += '<div class="hint" style="color:var(--danger)">' + esc(r.aviso) + '</div>';
    html += linha(!mesFora.length, 'Mês em todas as capas e relatórios', mesFora.map(function (m) {
      return esc(m.codigo + ' ' + m.titulo + ' (pág. ' + m.paginas + '): esperado ' + m.esperado + ', saiu ' + m.achado);
    }).join('<br>'));
    html += semItens ? linha(false, 'Itens da seleção não conferidos', esc(it.nao_conferido))
      : linha(!it.faltando.length, 'Itens da seleção: ' + it.presentes.length + ' de ' + it.esperados, it.faltando.length ? 'Faltando: ' + esc(it.faltando.join(', ')) : '');
    html += linha(!semComp.length && !extra.length && !parcRep.length, 'Comprovantes: ' + (c.parcelas_no_pdf || 0) + ' parcelas no PDF (' + (c.paginas || 0) + ' páginas) para ' + (c.despesas_liquidadas || 0) + ' despesas pagas no mês'
      + (c.movimentacoes_diretas ? ', mais ' + c.movimentacoes_diretas + ' movimentações diretas' : ''),
      semComp.map(function (d) { return 'Paga sem comprovante no PDF: parcela ' + esc(d.parcela) + ' ' + esc(d.fornecedor) + ' ' + esc(brl(d.valor)) + ' (' + esc(d.liquidacao) + ', ' + esc(d.anexos) + ' anexo(s))'; })
        .concat(extra.map(function (d) { return 'No PDF sem pagamento no mês: parcela ' + esc(d.parcela) + ' (pág. ' + esc(d.paginas) + ')'; }))
        .concat(parcRep.map(function (d) { return 'Parcela repetida ' + esc(d.parcela) + ' (pág. ' + esc(d.paginas) + ')'; })).join('<br>'));
    html += linha(!branco.length && !rep.length, 'Páginas em branco ou repetidas', branco.map(function (p) { return 'Pág. ' + esc(p.pagina) + ': ' + esc(p.motivo); })
      .concat(rep.map(function (p) { return 'Pág. ' + esc(p.pagina) + ' igual à pág. ' + esc(p.igual_a); })).join('<br>'));
    html += linha(!campos.length, 'Textos do modelo preenchidos', campos.map(function (p) { return 'Pág. ' + esc(p.pagina) + ': ' + esc(p.campos); }).join('<br>'));
    if ((r.avisos || []).length) html += '<div class="hint" style="margin-top:6px">Aviso: ' + r.avisos.map(esc).join('<br>') + '</div>';
    html += '<div class="hint" style="margin-top:6px">Conferido em ' + esc(quando ? new Date(quando).toLocaleString('pt-BR') : '') + '. <a href="#" id="bal-repetir">Conferir de novo</a></div>';
    document.getElementById('bal-resultado').innerHTML = html;
    document.getElementById('bal-repetir').addEventListener('click', function (ev) { ev.preventDefault(); conferir(idImp, true); });
  }

  async function gerar() {
    var c = condAtivo();
    var mes = (document.getElementById('bal-mes') || {}).value || '';
    // O botão vale para o condomínio e o mês da última lista: se mudou, lista de novo antes.
    if (!est.cond || !c || c.id !== est.cond.id || mes !== est.mes) { document.getElementById('bal-gerar').style.display = 'none'; info('O condomínio ou o mês mudou. Clique em Listar 900A do mês de novo.', true); return; }
    var b = document.getElementById('bal-gerar');
    var mesTela = est.mes.slice(5) + '/' + est.mes.slice(0, 4);
    // No condomínio de teste a política não pede confirmação: a própria tela pede o segundo clique.
    // Fora dele, quem confirma é a janela da política (confirmar-gravacao.js), sem pergunta extra aqui.
    if (!est.geracaoConfirmacao && !est.gerarArmado) {
      est.gerarArmado = true;
      b.textContent = 'Confirmar: gerar o 900A de ' + mesTela;
      info('Clique de novo para pedir ao Superlógica o 900A de ' + mesTela + ' de ' + est.cond.nome + '. Ele fica só para a administração, sem publicar e sem envio por email.');
      return;
    }
    est.gerarArmado = false;
    b.textContent = 'Gerar balancete (sem publicar)';
    b.disabled = true;
    try {
      // Fora do condomínio de teste o servidor pede a confirmação reforçada (confirmar-gravacao.js).
      var r = await (window.gravarNoSuperlogica || apiAuthFetch)('/api/financeiro/balancete/' + encodeURIComponent(est.cond.id) + '/gerar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ competencia: est.mes }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
      info(j.detalhe || 'Pedido enviado.');
      setTimeout(function () { b.disabled = false; }, 60000); // pedido feito: segura um minuto contra clique repetido
    } catch (e) { info(e.message, true); b.disabled = false; }
  }

  if (typeof window.showPanel === 'function') {
    var orig = window.showPanel;
    window.showPanel = function () { var r = orig.apply(this, arguments); montarCartao(); return r; };
  }
  document.addEventListener('auth:ready', function () { setTimeout(montarCartao, 0); });
})();
