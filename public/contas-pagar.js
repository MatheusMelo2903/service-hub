// ============================================================
// CONTAS A PAGAR, dentro do item Financeiro: o que o Hub faz sozinho para pagar em dia e o que
// ficou para a pessoa. Quadro da carteira (contas que ainda não chegaram, parcelas vencendo sem
// envio para a assinatura do síndico, baixas para conferir), ficha do condomínio, lançamento
// completo de um rascunho da entrada (parcelas, rateio, Pix, remessa), fornecedor novo e a lista
// do que ficou para conferir por analista. Rotas: /api/pagar/* (o servidor confere tudo de novo;
// a gravação no Superlógica passa pela janela de confirmação de confirmar-gravacao.js).
// ============================================================
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function brlC(c) { return brl(Number(c || 0) / 100); }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function horaBR(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  var TH = 'style="text-align:left;padding:6px 8px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border2)"';
  var TD = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid var(--border);vertical-align:top"';
  var COR = { vencida: 'var(--danger)', urgente: 'var(--danger)', atencao: 'var(--warning)' };
  var SIT = { pronta: ['Pronta para baixar', 'var(--accent)'], conferir: ['Para conferir', 'var(--warning)'], incerto: ['Sem confirmação', 'var(--danger)'], gravando: ['Gravando', 'var(--muted)'],
    baixada: ['Baixada', 'var(--success, #3a8f5c)'], recusada: ['Recusada', 'var(--danger)'] };
  var FORMAS = [[0, 'Boleto'], [12, 'Pix'], [14, 'Pix Copia e Cola'], [7, 'Débito automático'], [8, 'Transferência'], [9, 'Doc/Ted'], [13, 'DCTFWeb']];
  var NOME_FORMA = { 0: 'Boleto', 7: 'Débito automático', 8: 'Transferência', 9: 'Doc/Ted', 12: 'Pix', 13: 'DCTFWeb', 14: 'Pix Copia e Cola' };
  function selo(t, cor) { return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:' + cor + '">' + esc(t) + '</span>'; }
  function msg(el, t, erro) { if (el) el.innerHTML = t ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(t) + '</div>' : ''; }
  function pode() { return typeof window.podeAbrirPainel === 'function' && window.podeAbrirPainel('fincontrole'); }
  function tabela(cab, linhas) { return '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>' + cab.map(function (c) { return '<th ' + TH + '>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + linhas.join('') + '</tbody></table></div>'; }
  function secao(titulo, dica, corpo) { return '<div style="margin-top:16px"><div style="font-weight:700;font-size:14px;margin-bottom:4px">' + esc(titulo) + '</div>' + (dica ? '<p class="hint" style="margin:0 0 8px">' + esc(dica) + '</p>' : '') + corpo + '</div>'; }

  var est = { montado: false, seq: 0, cond: null, dados: null, rascunho: null, contas: [] };

  async function pegar(url, vivo, aoEsperar) {
    for (var t = 0; t < 40; t++) {
      if (vivo && !vivo()) throw new Error('cancelado');
      var r = await apiAuthFetch(url);
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 202) { if (aoEsperar) aoEsperar(j); await new Promise(function (ok) { setTimeout(ok, 5000); }); url = url.replace(/[?&]forcar=1/, ''); continue; }
      if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
      return j;
    }
    throw new Error('A leitura demorou demais. Tente de novo em alguns minutos.');
  }
  // gravar: true quando a chamada grava no Superlógica (janela de confirmação da política).
  async function enviar(metodo, url, corpo, gravar) {
    var op = { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) };
    var r = gravar && window.gravarNoSuperlogica ? await window.gravarNoSuperlogica(url, op) : await apiAuthFetch(url, op);
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.detalhe || ('Falha ' + r.status)); e.status = r.status; e.j = j; throw e; }
    return j;
  }

  // 1. Card dentro do painel Financeiro.
  function montar() {
    if (est.montado) return;
    var painel = document.getElementById('panel-fincontrole');
    if (!painel) return;
    var card = document.createElement('div');
    card.className = 'card'; card.id = 'cp-card';
    card.innerHTML = '<div class="card-header"><span class="card-title">Contas a pagar</span></div>'
      + '<p class="hint" style="margin:0 0 10px">O Hub aprende quem cobra todo mês e avisa quando a conta não chegou, mostra o que vai vencer sem estar lançado ou sem ir para a assinatura do síndico (prazo: 2 dias úteis), e dá a baixa sozinho quando o retorno do banco ou o extrato mostra o pagamento, com o comprovante do banco anexado. Remessa e assinatura no banco continuam com as pessoas.</p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn btn-primary" id="cp-quadro-btn">Carregar carteira</button>'
      + '<button class="btn btn-ghost" id="cp-analistas-btn">Para conferir por analista</button><button class="btn btn-ghost" id="cp-forn-btn">Fornecedores novos</button>'
      + '<input id="cp-id" placeholder="Código do condomínio" style="width:170px"><button class="btn btn-ghost" id="cp-abrir-btn">Abrir</button></div>'
      + '<div id="cp-info" style="margin:10px 0"></div><div id="cp-quadro"></div>';
    var det = document.createElement('div');
    det.className = 'card'; det.id = 'cp-detalhe'; det.style.display = 'none';
    var ref = document.getElementById('jur-detalhe');
    if (ref && ref.parentNode === painel) { painel.insertBefore(card, ref.nextSibling); painel.insertBefore(det, card.nextSibling); }
    else { painel.appendChild(card); painel.appendChild(det); }
    document.getElementById('cp-quadro-btn').addEventListener('click', carregarQuadro);
    document.getElementById('cp-analistas-btn').addEventListener('click', carregarAnalistas);
    document.getElementById('cp-forn-btn').addEventListener('click', carregarFornecedores);
    document.getElementById('cp-abrir-btn').addEventListener('click', function () { var v = document.getElementById('cp-id').value.trim(); if (/^\d+$/.test(v)) abrirCondominio(v); });
    det.addEventListener('click', cliqueDetalhe);
    est.montado = true;
  }
  function aplicar() {
    var c = document.getElementById('cp-card');
    if (!pode()) { if (c) c.style.display = 'none'; var d = document.getElementById('cp-detalhe'); if (d) d.style.display = 'none'; return; }
    montar();
    c = document.getElementById('cp-card'); if (c) c.style.display = '';
  }
  if (typeof window.showPanel === 'function') {
    var orig = window.showPanel;
    window.showPanel = function () { var r = orig.apply(this, arguments); var p = document.getElementById('panel-fincontrole'); if (p && p.classList.contains('active')) aplicar(); return r; };
  }
  document.addEventListener('auth:ready', function () { setTimeout(aplicar, 0); });

  // 2. Quadro da carteira.
  async function carregarQuadro() {
    var seq = ++est.seq;
    var info = document.getElementById('cp-info');
    var sel = document.getElementById('fin-carteira');
    msg(info, 'Carregando...');
    try {
      var j = await pegar('/api/pagar/quadro' + (sel && sel.value ? '?carteira=' + encodeURIComponent(sel.value) : ''), function () { return seq === est.seq; });
      var l = (j.condominios || []).slice().sort(function (a, b) { return (b.urgentes || 0) - (a.urgentes || 0) || (b.baixas_conferir || 0) - (a.baixas_conferir || 0); });
      msg(info, l.length + ' condomínio(s).' + (j.calculando ? ' Lendo ' + j.calculando + ' no Superlógica; carregue de novo em alguns minutos.' : ''));
      document.getElementById('cp-quadro').innerHTML = tabela(['Condomínio', 'Analista', 'Urgentes', 'Contas que não chegaram', 'Sem envio para assinatura', 'Vencidas em aberto', 'Baixas prontas', 'Para conferir'],
        l.map(function (c) {
          return '<tr data-cp-ir="' + esc(c.id_condominio) + '" style="cursor:pointer"><td ' + TD + '><b>' + esc(c.condominio || c.id_condominio) + '</b></td><td ' + TD + '>' + esc(c.analista) + '</td>'
            + (c.calculando ? '<td ' + TD + ' colspan="4"><span class="hint">lendo...</span></td>' : '<td ' + TD + '>' + (c.urgentes ? selo(c.urgentes, 'var(--danger)') : '0') + '</td><td ' + TD + '>' + c.contas_nao_chegaram + '</td><td ' + TD + '>' + c.sem_envio + '</td><td ' + TD + '>' + c.vencidas + '</td>')
            + '<td ' + TD + '>' + c.baixas_prontas + '</td><td ' + TD + '>' + c.baixas_conferir + '</td></tr>';
        }));
      document.querySelectorAll('#cp-quadro [data-cp-ir]').forEach(function (tr) { tr.addEventListener('click', function () { abrirCondominio(tr.getAttribute('data-cp-ir')); }); });
    } catch (e) { if (e.message !== 'cancelado') msg(info, e.message, true); }
  }

  // 3. Ficha do condomínio.
  async function abrirCondominio(id, forcar) {
    var seq = ++est.seq;
    var det = document.getElementById('cp-detalhe');
    det.style.display = '';
    det.innerHTML = '<div class="hint">Lendo as despesas do condomínio...</div>';
    try {
      var j = await pegar('/api/pagar/condominio/' + encodeURIComponent(id) + (forcar ? '?forcar=1' : ''), function () { return seq === est.seq; });
      est.cond = id; est.dados = j;
      renderCondominio();
      det.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { if (e.message !== 'cancelado') det.innerHTML = '<div style="color:var(--danger);font-size:13px">' + esc(e.message) + '</div>'; }
  }
  function textoGravacao(g) {
    if (g === 'livre') return 'Condomínio de teste: o Hub grava no Superlógica sem pedir confirmação e dá a baixa sozinho.';
    if (g === 'confirmacao' || g === 'reforcada') return 'Gravação no Superlógica com confirmação: as baixas ficam prontas e alguém confirma com um clique.';
    return 'Gravação no Superlógica travada neste condomínio por enquanto: o Hub avisa e prepara, a baixa é feita no Superlógica.';
  }
  function renderCondominio() {
    var j = est.dados, det = document.getElementById('cp-detalhe');
    var faltam = (j.faltam || []).filter(function (a) { return a.codigo === 'conta_nao_chegou'; });
    var foraNormal = (j.faltam || []).filter(function (a) { return a.codigo === 'valor_fora_do_normal'; });
    var sem = (j.prazos || []).filter(function (a) { return a.codigo === 'sem_envio_assinatura'; });
    var vencidas = (j.prazos || []).filter(function (a) { return a.codigo === 'vencida_em_aberto'; });
    var h = '<div class="card-header"><span class="card-title">' + esc(j.nome) + '</span><button class="btn btn-ghost" data-cp="atualizar">Atualizar</button></div>'
      + '<div class="ficha-sub">Lido do Superlógica em ' + esc(horaBR(j.lido_em)) + '. ' + esc(textoGravacao(j.gravacao)) + '</div>';
    h += secao('Contas que ainda não chegaram', 'Quem cobra todo mês neste condomínio (aprendido dos últimos 6 meses) e ainda não tem a conta lançada. Lance com pelo menos 2 dias úteis antes do vencimento.',
      faltam.length ? tabela(['', 'Conta', 'Tipo', 'Vencimento esperado', 'Costuma ser', 'Lançar até', ''], faltam.map(function (a) {
        return '<tr><td ' + TD + '>' + selo(a.nivel === 'vencida' ? 'Venceu' : a.nivel === 'urgente' ? 'Urgente' : 'Atenção', COR[a.nivel]) + '</td><td ' + TD + '>' + esc(a.texto) + '</td><td ' + TD + '>' + esc(a.tipo) + '</td><td ' + TD + '>' + esc(dataBR(a.vencimento)) + '</td><td ' + TD + '>' + (a.valor_mediano ? brlC(a.valor_mediano) : '') + '</td><td ' + TD + '>' + esc(dataBR(a.limite_lancar)) + '</td>'
          + '<td ' + TD + '>' + (j.pode_gravar ? '<button class="btn btn-ghost" data-cp="ignorar" data-chave="' + esc(a.chave) + '">Não esperar mais</button>' : '') + '</td></tr>';
      })) : '<div class="hint">Nenhuma conta esperada faltando nos próximos 10 dias.</div>');
    if (foraNormal.length) h += secao('Contas com valor fora do normal', '', tabela(['Conta', 'Vencimento'], foraNormal.map(function (a) { return '<tr><td ' + TD + '>' + esc(a.texto) + '</td><td ' + TD + '>' + esc(dataBR(a.vencimento)) + '</td></tr>'; })));
    h += secao('Vencendo sem envio para a assinatura', 'Parcelas em aberto que vencem nos próximos 5 dias úteis e ainda não foram marcadas para a remessa nem enviadas para o síndico assinar. Débito automático não aparece aqui.',
      sem.length ? tabela(['', 'Fornecedor', 'Vencimento', 'Dias úteis', 'Valor', 'Forma', ''], sem.map(function (a) {
        var podeRem = j.pode_gravar && j.gravacao !== 'bloqueado' && (a.tem_codigo || a.tem_pix);
        return '<tr><td ' + TD + '>' + selo(a.nivel === 'urgente' ? 'Urgente' : 'Atenção', COR[a.nivel]) + '</td><td ' + TD + '>' + esc(a.fornecedor) + '</td><td ' + TD + '>' + esc(dataBR(a.vencimento)) + '</td><td ' + TD + '>' + a.dias_uteis + '</td><td ' + TD + '>' + brlC(a.valor) + '</td><td ' + TD + '>' + esc(NOME_FORMA[a.forma] || '') + '</td>'
          + '<td ' + TD + '>' + (j.pode_gravar ? '<select data-cp-para="' + esc(a.id_parcela) + '" style="width:auto"><option value="síndico">Síndico</option><option value="síndico e subsíndico">Síndico e subsíndico</option></select> <button class="btn btn-ghost" data-cp="envio" data-parcela="' + esc(a.id_parcela) + '">Registrei o envio</button>' : '')
          + (podeRem ? ' <button class="btn btn-ghost" data-cp="remessa" data-parcela="' + esc(a.id_parcela) + '">Marcar para a remessa</button>' : '') + '</td></tr>';
      })) : '<div class="hint">Nada vencendo sem envio.</div>');
    if (vencidas.length) h += secao('Vencidas em aberto', 'Se foram pagas, a baixa entra pelo retorno do banco ou pelo extrato. Juros, quando houver, ficam em Juros e atrasos.', tabela(['Fornecedor', 'Vencimento', 'Valor'], vencidas.map(function (a) { return '<tr><td ' + TD + '>' + esc(a.fornecedor) + '</td><td ' + TD + '>' + esc(dataBR(a.vencimento)) + '</td><td ' + TD + '>' + brlC(a.valor) + '</td></tr>'; })));
    var bx = j.baixas || [];
    var prontas = bx.filter(function (b) { return b.situacao === 'pronta'; });
    h += secao('Baixas', 'Pagamentos achados no retorno do banco (o arquivo enviado em Juros e atrasos) e no extrato importado. Quem lançou a despesa não confirma a baixa dela.',
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' + (j.pode_gravar ? '<button class="btn btn-ghost" data-cp="procurar">Procurar pagamentos agora</button>' : '')
      + (j.pode_gravar && prontas.length && j.gravacao !== 'bloqueado' ? '<button class="btn btn-primary" data-cp="baixar">Baixar as marcadas</button>' : '') + '</div><div id="cp-bx-msg"></div>'
      + (bx.length ? tabela(['', 'Situação', 'Fornecedor', 'Pago em', 'Lançado', 'Pago', 'Juros', 'Multa', 'Por quê', ''], bx.map(function (b) {
        var s = SIT[b.situacao] || [b.situacao, 'var(--muted)'];
        var marca = b.situacao === 'pronta' && !b.eu_lancei ? '<input type="checkbox" data-cp-bx="' + b.id + '" checked>' : '';
        var acoes = '';
        if (j.pode_gravar && (b.situacao === 'conferir' || b.situacao === 'incerto') && b.id_parcela && !b.eu_lancei && j.gravacao !== 'bloqueado') acoes += '<button class="btn btn-ghost" data-cp="conferir" data-id="' + b.id + '">' + (b.situacao === 'incerto' ? 'Reler e baixar' : 'Conferir e baixar') + '</button> ';
        if (j.pode_gravar && ['pronta', 'conferir', 'incerto'].indexOf(b.situacao) >= 0) acoes += '<button class="btn btn-ghost" data-cp="descartar" data-id="' + b.id + '">Não é este pagamento</button>';
        if (b.eu_lancei && b.situacao !== 'baixada') acoes += '<span class="hint">Você lançou esta despesa: outra pessoa confirma.</span>';
        var jm = b.situacao === 'conferir' || b.situacao === 'incerto' ? '<input data-cp-juros="' + b.id + '" value="' + esc(String(b.juros || 0).replace('.', ',')) + '" style="width:70px">' : brl(b.juros);
        var mm = b.situacao === 'conferir' || b.situacao === 'incerto' ? '<input data-cp-multa="' + b.id + '" value="' + esc(String(b.multa || 0).replace('.', ',')) + '" style="width:70px">' : brl(b.multa);
        return '<tr><td ' + TD + '>' + marca + '</td><td ' + TD + '>' + selo(s[0], s[1]) + (b.baixado_por ? '<div class="hint" style="margin:2px 0 0">' + esc(b.baixado_por === 'sistema' ? 'pelo sistema' : b.baixado_por) + ' ' + esc(horaBR(b.baixado_em)) + '</div>' : '') + '</td>'
          + '<td ' + TD + '>' + esc(b.fornecedor || '') + '<div class="hint" style="margin:0">' + esc(b.origem === 'retorno' ? 'retorno do banco' : 'extrato') + '</div></td><td ' + TD + '>' + esc(dataBR(b.data_pagamento)) + '</td><td ' + TD + '>' + (b.valor_parcela != null ? brl(b.valor_parcela) : '') + '</td><td ' + TD + '>' + (b.valor_pago != null ? brl(b.valor_pago) : '') + '</td>'
          + '<td ' + TD + '>' + jm + '</td><td ' + TD + '>' + mm + '</td><td ' + TD + '>' + esc(b.motivo || '') + '</td><td ' + TD + '>' + acoes + '</td></tr>';
      })) : '<div class="hint">Nenhum pagamento achado ainda. Envie o arquivo de retorno do banco em Juros e atrasos ou importe o extrato no Superlógica.</div>'));
    var emCima = j.lancadas_em_cima_do_prazo || [];
    if (emCima.length) h += secao('Lançadas sem os 2 dias úteis de antecedência (este mês)', '', tabela(['Fornecedor', 'Lançada', 'Vencimento'], emCima.map(function (a) { return '<tr><td ' + TD + '>' + esc(a.fornecedor) + '</td><td ' + TD + '>' + esc(dataBR(a.lancada)) + '</td><td ' + TD + '>' + esc(dataBR(a.vencimento)) + '</td></tr>'; })));
    h += '<details style="margin-top:16px"><summary style="cursor:pointer;font-weight:700;font-size:14px">Contas que costumam vir todo mês (' + (j.esperadas || []).length + ')</summary>'
      + tabela(['Fornecedor', 'Tipo', 'Contas por mês', 'Dia do vencimento', 'Valor', 'Meses vistos', ''], (j.esperadas || []).map(function (e) {
        return '<tr><td ' + TD + '>' + esc(e.fornecedor) + '</td><td ' + TD + '>' + esc(e.tipo) + '</td><td ' + TD + '>' + e.quantidade + '</td><td ' + TD + '>' + esc((e.dias || []).join(', ')) + '</td><td ' + TD + '>' + (e.valor_min != null ? brlC(e.valor_min) + ' a ' + brlC(e.valor_max) : '') + '</td><td ' + TD + '>' + e.meses + ' de 6</td>'
          + '<td ' + TD + '>' + (e.ignorada ? '<span class="hint">não esperada</span> ' + (j.pode_gravar ? '<button class="btn btn-ghost" data-cp="voltar" data-chave="' + esc(e.chave) + '">Voltar a esperar</button>' : '') : '') + '</td></tr>';
      })) + '</details>';
    h += secao('Lançamento completo de um documento', 'Escolha um rascunho da entrada de documentos deste condomínio para lançar com parcelas, rateio por categoria, chave Pix e marcação para a remessa.',
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost" data-cp="rascunhos">Ver rascunhos</button></div><div id="cp-rasc"></div>');
    det.innerHTML = h;
  }

  async function cliqueDetalhe(ev) {
    var b = ev.target.closest('[data-cp]');
    if (!b) return;
    var acao = b.getAttribute('data-cp'), id = est.cond;
    var aviso = document.getElementById('cp-bx-msg');
    try {
      if (acao === 'atualizar') return abrirCondominio(id, true);
      if (acao === 'ignorar' || acao === 'voltar') {
        var motivo = acao === 'ignorar' ? window.prompt('Por que esta conta não é mais esperada? (contrato encerrado, por exemplo)') : '';
        if (acao === 'ignorar' && !motivo) return;
        await enviar('PUT', '/api/pagar/condominio/' + id + '/esperadas/' + b.getAttribute('data-chave'), { ignorar: acao === 'ignorar', motivo: motivo });
        return abrirCondominio(id);
      }
      if (acao === 'envio') {
        var p = b.getAttribute('data-parcela');
        var para = (document.querySelector('[data-cp-para="' + p + '"]') || {}).value || 'síndico';
        await enviar('POST', '/api/pagar/condominio/' + id + '/envio', { id_parcela: p, para: para });
        return abrirCondominio(id);
      }
      if (acao === 'remessa') {
        b.disabled = true;
        await enviar('POST', '/api/pagar/condominio/' + id + '/remessa', { id_parcela: b.getAttribute('data-parcela') }, true);
        return abrirCondominio(id, true);
      }
      if (acao === 'procurar') {
        b.disabled = true; msg(aviso, 'Procurando no retorno do banco e no extrato...');
        var r = await enviar('POST', '/api/pagar/condominio/' + id + '/procurar', {});
        msg(aviso, r.novas + ' pagamento(s) novo(s): ' + r.prontas + ' pronto(s) para baixar, ' + r.conferir + ' para conferir.');
        return setTimeout(function () { abrirCondominio(id); }, 800);
      }
      if (acao === 'baixar') {
        var ids = Array.prototype.map.call(document.querySelectorAll('[data-cp-bx]:checked'), function (x) { return Number(x.getAttribute('data-cp-bx')); });
        if (!ids.length) return msg(aviso, 'Marque as baixas.', true);
        b.disabled = true; msg(aviso, 'Gravando as baixas...');
        var rb = await enviar('POST', '/api/pagar/condominio/' + id + '/baixar', { ids: ids }, true);
        var ok = (rb.resultados || []).filter(function (x) { return x.ok; }).length;
        msg(aviso, ok + ' de ' + (rb.resultados || []).length + ' baixada(s).' + ((rb.puladas_por_ter_lancado || []).length ? ' ' + rb.puladas_por_ter_lancado.length + ' pulada(s): você lançou a despesa.' : ''));
        return setTimeout(function () { abrirCondominio(id); }, 1200);
      }
      if (acao === 'conferir') {
        var idb = b.getAttribute('data-id');
        b.disabled = true;
        await enviar('POST', '/api/pagar/baixas/' + idb + '/conferir', { juros: (document.querySelector('[data-cp-juros="' + idb + '"]') || {}).value, multa: (document.querySelector('[data-cp-multa="' + idb + '"]') || {}).value }, true);
        return abrirCondominio(id);
      }
      if (acao === 'descartar') {
        var mot = window.prompt('Por que este pagamento não é desta despesa?');
        if (!mot) return;
        await enviar('POST', '/api/pagar/baixas/' + b.getAttribute('data-id') + '/descartar', { motivo: mot });
        return abrirCondominio(id);
      }
      if (acao === 'rascunhos') return listarRascunhos();
      if (acao === 'abrir-rasc') return abrirRascunho(b.getAttribute('data-id'));
      if (acao === 'mais-parcela') { est.rascunho.parcelas.push({ vencimento: '', valor: '', linha: '' }); return editorRascunho(); }
      if (acao === 'menos-parcela') { lerEditor(); est.rascunho.parcelas.splice(Number(b.getAttribute('data-i')), 1); return editorRascunho(); }
      if (acao === 'dividir') return dividir();
      if (acao === 'mais-rateio') { lerEditor(); est.rascunho.rateio.push({ conta: '', valor: '', complemento: '' }); return editorRascunho(); }
      if (acao === 'menos-rateio') { lerEditor(); est.rascunho.rateio.splice(Number(b.getAttribute('data-i')), 1); return editorRascunho(); }
      if (acao === 'guardar') return guardarPacote();
      if (acao === 'lancar') return lancarRascunho(b);
      if (acao === 'pedir-forn') return pedirFornecedor(b);
    } catch (e) {
      b.disabled = false;
      var alvo = aviso || document.getElementById('cp-rasc-msg');
      if (e.status === 499) return msg(alvo, 'Cancelado. Nada foi gravado.');
      msg(alvo || document.getElementById('cp-detalhe'), e.message, true);
      if (!alvo) window.alert(e.message);
    }
  }

  // 4. Lançamento completo de um rascunho.
  async function listarRascunhos() {
    var el = document.getElementById('cp-rasc');
    msg(el, 'Carregando...');
    var j = await pegar('/api/entrada/fila?status=rascunho');
    var l = (j.itens || []).filter(function (x) { return String(x.id_superlogica) === String(est.cond); });
    el.innerHTML = l.length ? tabela(['Arquivo', 'Fornecedor', 'Valor', 'Vencimento', ''], l.map(function (x) {
      var d = x.dados || {};
      return '<tr><td ' + TD + '>' + esc(x.nome_arquivo) + '</td><td ' + TD + '>' + esc(d.nome_fornecedor || ('não cadastrado ' + (d.cnpj_fornecedor || ''))) + '</td><td ' + TD + '>' + (d.valor ? brl(d.valor) : '') + '</td><td ' + TD + '>' + esc(dataBR(d.vencimento)) + '</td>'
        + '<td ' + TD + '><button class="btn btn-ghost" data-cp="abrir-rasc" data-id="' + esc(x.id) + '">Abrir</button></td></tr>';
    })) : '<div class="hint">Nenhum rascunho deste condomínio na entrada de documentos.</div>';
  }
  async function abrirRascunho(idr) {
    var j = await pegar('/api/entrada/' + encodeURIComponent(idr));
    var x = j.item, d = x.dados || {}, pg = d.pagar || {};
    if (!est.contas.length || est.contasDe !== est.cond) { var c = await pegar('/api/entrada/contas/' + encodeURIComponent(est.cond)); est.contas = c.contas || []; est.contasDe = est.cond; }
    est.rascunho = { id: x.id, item: x, forma: Number(d.forma_pag || 0),
      parcelas: (pg.parcelas || [{ vencimento: d.vencimento, valor_centavos: Math.round(Number(d.valor || 0) * 100), linha: d.linha }]).map(function (p) { return { vencimento: p.vencimento || '', valor: p.valor_centavos != null ? (p.valor_centavos / 100).toFixed(2).replace('.', ',') : '', linha: p.linha || '' }; }),
      rateio: (pg.rateio || (d.conta ? [{ conta: d.conta, valor_centavos: Math.round(Number(d.valor || 0) * 100), complemento: d.complemento }] : [{ conta: '', valor_centavos: Math.round(Number(d.valor || 0) * 100) }])).map(function (r) { return { conta: r.conta || '', valor: r.valor_centavos != null ? (r.valor_centavos / 100).toFixed(2).replace('.', ',') : '', complemento: r.complemento || '' }; }),
      pix: pg.pix ? pg.pix.chave : '', pix_tipo: pg.pix ? pg.pix.tipo : '', copia_cola: pg.copia_cola || '', remessa: !!pg.remessa };
    editorRascunho();
  }
  function lerEditor() {
    var r = est.rascunho; if (!r) return;
    r.forma = Number((document.getElementById('cp-forma') || {}).value || r.forma);
    r.parcelas = r.parcelas.map(function (p, i) { return { vencimento: (document.getElementById('cp-pv-' + i) || {}).value || '', valor: (document.getElementById('cp-pval-' + i) || {}).value || '', linha: (document.getElementById('cp-pl-' + i) || {}).value || '' }; });
    r.rateio = r.rateio.map(function (x, i) { return { conta: (document.getElementById('cp-rc-' + i) || {}).value || '', valor: (document.getElementById('cp-rv-' + i) || {}).value || '', complemento: (document.getElementById('cp-rx-' + i) || {}).value || '' }; });
    r.pix = (document.getElementById('cp-pix') || {}).value || '';
    r.pix_tipo = (document.getElementById('cp-pix-tipo') || {}).value || '';
    r.copia_cola = (document.getElementById('cp-cc') || {}).value || '';
    r.remessa = !!(document.getElementById('cp-rem') || {}).checked;
  }
  function editorRascunho() {
    var r = est.rascunho, x = r.item, d = x.dados || {};
    var opContas = function (sel) { return '<option value="">Escolha</option>' + est.contas.map(function (c) { return '<option value="' + esc(c.conta) + '"' + (c.conta === sel ? ' selected' : '') + '>' + esc(c.conta + ' ' + c.nome) + '</option>'; }).join(''); };
    var alertas = (x.alertas || []).filter(function (a) { return a && a.nivel === 'grave'; });
    var h = '<div style="border:1px solid var(--border2);border-radius:8px;padding:12px;margin-top:10px">'
      + '<div style="font-weight:700">' + esc(x.nome_arquivo) + '</div><div class="hint" style="margin:2px 0 8px">Valor do documento ' + brl(d.valor) + '. Fornecedor: ' + esc(d.nome_fornecedor || 'não cadastrado no Superlógica') + '.</div>';
    if (!d.id_fornecedor) {
      h += '<div style="border:1px dashed var(--warning);border-radius:8px;padding:10px;margin-bottom:10px"><b style="font-size:13px">Fornecedor novo</b><p class="hint" style="margin:2px 0 8px">O pedido vai para um gestor ou gerente aprovar. Chave Pix ou conta precisam ser confirmadas com o fornecedor por telefone antes.</p>'
        + '<input id="cp-fn-cnpj" placeholder="CNPJ ou CPF" value="' + esc(d.cnpj_fornecedor || '') + '" style="width:190px"> <input id="cp-fn-nome" placeholder="Razão social" style="width:260px"> '
        + '<select id="cp-fn-pixtipo" style="width:auto"><option value="">Tipo da chave Pix</option><option value="cnpj">CNPJ</option><option value="cpf">CPF</option><option value="email">Email</option><option value="telefone">Telefone</option><option value="aleatoria">Aleatória</option></select> <input id="cp-fn-pix" placeholder="Chave Pix (opcional)" style="width:220px"> '
        + '<button class="btn btn-ghost" data-cp="pedir-forn">Pedir cadastro</button></div>';
    }
    h += '<label style="font-size:12px">Forma de pagamento <select id="cp-forma" style="width:auto">' + FORMAS.map(function (f) { return '<option value="' + f[0] + '"' + (r.forma === f[0] ? ' selected' : '') + '>' + f[1] + '</option>'; }).join('') + '</select></label>'
      + '<div style="font-weight:600;font-size:13px;margin:10px 0 4px">Parcelas</div>'
      + r.parcelas.map(function (p, i) {
        return '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px"><input type="date" id="cp-pv-' + i + '" value="' + esc(p.vencimento) + '" style="width:auto"><input id="cp-pval-' + i + '" value="' + esc(p.valor) + '" placeholder="Valor" style="width:110px">'
          + '<input id="cp-pl-' + i + '" value="' + esc(p.linha) + '" placeholder="Código de barras da parcela" style="flex:1;min-width:240px;font-family:var(--mono);font-size:11px">' + (r.parcelas.length > 1 ? '<button class="btn btn-ghost" data-cp="menos-parcela" data-i="' + i + '">Tirar</button>' : '') + '</div>';
      }).join('')
      + '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-ghost" data-cp="mais-parcela">Mais uma parcela</button><input id="cp-ndiv" type="number" min="2" max="24" placeholder="Nº" style="width:70px"><button class="btn btn-ghost" data-cp="dividir">Dividir em parcelas mensais iguais</button></div>'
      + '<div style="font-weight:600;font-size:13px;margin:10px 0 4px">Rateio por categoria</div>'
      + r.rateio.map(function (x2, i) {
        return '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px"><select id="cp-rc-' + i + '" style="max-width:320px">' + opContas(x2.conta) + '</select><input id="cp-rv-' + i + '" value="' + esc(x2.valor) + '" placeholder="Valor" style="width:110px"><input id="cp-rx-' + i + '" value="' + esc(x2.complemento) + '" placeholder="Complemento" style="flex:1;min-width:160px">'
          + (r.rateio.length > 1 ? '<button class="btn btn-ghost" data-cp="menos-rateio" data-i="' + i + '">Tirar</button>' : '') + '</div>';
      }).join('') + '<button class="btn btn-ghost" data-cp="mais-rateio">Mais uma categoria</button>'
      + '<div style="font-weight:600;font-size:13px;margin:10px 0 4px">Pix</div><div style="display:flex;gap:6px;flex-wrap:wrap"><select id="cp-pix-tipo" style="width:auto"><option value="">Tipo da chave (opcional)</option>'
      + ['cnpj', 'cpf', 'email', 'telefone', 'aleatoria'].map(function (t) { return '<option value="' + t + '"' + (r.pix_tipo === t ? ' selected' : '') + '>' + { cnpj: 'CNPJ', cpf: 'CPF', email: 'Email', telefone: 'Telefone', aleatoria: 'Aleatória' }[t] + '</option>'; }).join('')
      + '</select><input id="cp-pix" value="' + esc(r.pix) + '" placeholder="Chave Pix" style="width:240px"><input id="cp-cc" value="' + esc(r.copia_cola) + '" placeholder="Ou cole o Pix copia e cola" style="flex:1;min-width:240px;font-family:var(--mono);font-size:11px"></div>'
      + '<label style="display:block;font-size:13px;margin-top:10px"><input type="checkbox" id="cp-rem"' + (r.remessa ? ' checked' : '') + '> Marcar para a remessa de pagamento depois de lançar (o arquivo e a assinatura continuam com as pessoas)</label>'
      + (alertas.length ? '<div style="margin-top:10px;font-size:12px"><b>Alertas para aceitar antes de lançar:</b>' + alertas.map(function (a) { return '<label style="display:block"><input type="checkbox" data-cp-aceito="' + esc(a.codigo) + '"> ' + esc(a.texto) + '</label>'; }).join('') + '</div>' : '')
      + '<div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-ghost" data-cp="guardar">Guardar</button><button class="btn btn-primary" data-cp="lancar">Guardar e lançar no Superlógica</button></div><div id="cp-rasc-msg" style="margin-top:8px"></div></div>';
    document.getElementById('cp-rasc').innerHTML = h;
  }
  function dividir() {
    lerEditor();
    var n = Number((document.getElementById('cp-ndiv') || {}).value);
    var r = est.rascunho, d = r.item.dados || {};
    if (!(n >= 2 && n <= 24)) return msg(document.getElementById('cp-rasc-msg'), 'Escolha de 2 a 24 parcelas.', true);
    var total = Math.round(Number(d.valor || 0) * 100), base = Math.floor(total / n), resto = total - base * n;
    var v0 = r.parcelas[0] && r.parcelas[0].vencimento || d.vencimento || '';
    r.parcelas = [];
    for (var i = 0; i < n; i++) {
      var dt = '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(v0)) {
        var a = Number(v0.slice(0, 4)), m = Number(v0.slice(5, 7)) - 1 + i, dia = Number(v0.slice(8, 10));
        var alvo = new Date(Date.UTC(a, m, 1)), fim = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
        dt = alvo.getUTCFullYear() + '-' + String(alvo.getUTCMonth() + 1).padStart(2, '0') + '-' + String(Math.min(dia, fim)).padStart(2, '0');
      }
      r.parcelas.push({ vencimento: dt, valor: ((base + (i === 0 ? resto : 0)) / 100).toFixed(2).replace('.', ','), linha: '' });
    }
    editorRascunho();
  }
  function pacote() {
    lerEditor();
    var r = est.rascunho;
    var num = function (v) { return Number(String(v || '').replace(/\./g, '').replace(',', '.')); };
    return {
      forma_pag: r.forma,
      parcelas: r.parcelas.map(function (p) { return { vencimento: p.vencimento, valor: num(p.valor), linha: p.linha.replace(/\D/g, '') || null }; }),
      rateio: r.rateio.map(function (x) { return { conta: x.conta, valor: num(x.valor), complemento: x.complemento || null }; }),
      pix: r.pix ? { chave: r.pix, tipo: r.pix_tipo || null } : null, copia_cola: r.copia_cola || null, remessa: r.remessa,
    };
  }
  async function guardarPacote() {
    var el = document.getElementById('cp-rasc-msg');
    var j = await enviar('PUT', '/api/pagar/entrada/' + est.rascunho.id + '/completo', pacote());
    msg(el, 'Guardado: ' + j.pagar.parcelas.length + ' parcela(s), ' + j.pagar.rateio.length + ' categoria(s)' + (j.pagar.pix ? ', Pix' : '') + (j.pagar.remessa ? ', remessa' : '') + '.');
    return j;
  }
  async function lancarRascunho(b) {
    var el = document.getElementById('cp-rasc-msg');
    b.disabled = true;
    await guardarPacote();
    var aceitos = Array.prototype.map.call(document.querySelectorAll('[data-cp-aceito]:checked'), function (x) { return x.getAttribute('data-cp-aceito'); });
    msg(el, 'Lançando no Superlógica...');
    var j = await enviar('POST', '/api/entrada/' + est.rascunho.id + '/lancar', { confirmacao: 'LANCAR', aceitar_alertas: aceitos }, true);
    msg(el, 'Lançada: despesa ' + j.id_despesa + (j.conferido ? ', conferida relendo o Superlógica' : ', confira no Superlógica (a releitura não confirmou tudo)') + '.');
    est.rascunho = null;
    setTimeout(function () { abrirCondominio(est.cond, true); }, 1500);
  }
  async function pedirFornecedor(b) {
    var el = document.getElementById('cp-rasc-msg');
    var corpo = { id_superlogica: est.cond, entrada: est.rascunho.id, cnpj: document.getElementById('cp-fn-cnpj').value, nome: document.getElementById('cp-fn-nome').value };
    var chave = document.getElementById('cp-fn-pix').value;
    if (chave) corpo.pix = { chave: chave, tipo: document.getElementById('cp-fn-pixtipo').value || null };
    b.disabled = true;
    await enviar('POST', '/api/pagar/fornecedores', corpo);
    msg(el, 'Pedido de cadastro enviado. Um gestor ou gerente aprova em Fornecedores novos.');
  }

  // 5. Para conferir, por analista.
  async function carregarAnalistas() {
    var el = document.getElementById('cp-quadro');
    msg(document.getElementById('cp-info'), 'Carregando...');
    try {
      var j = await pegar('/api/pagar/analistas');
      msg(document.getElementById('cp-info'), 'Baixas que ficaram para conferir e o que foi baixado nos últimos 7 dias, por analista da carteira.');
      el.innerHTML = (j.analistas || []).map(function (g) {
        return '<div style="margin:12px 0"><b>' + esc(g.analista) + '</b> <span class="hint">' + g.conferir.length + ' para conferir; baixadas em 7 dias: ' + g.baixadas_sistema_7d + ' pelo sistema, ' + g.baixadas_pessoa_7d + ' por pessoas</span>'
          + (g.conferir.length ? tabela(['Condomínio', 'Situação', 'Fornecedor', 'Pago em', 'Valor', 'Por quê'], g.conferir.map(function (b) {
            var s = SIT[b.situacao] || [b.situacao, 'var(--muted)'];
            return '<tr data-cp-ir="' + esc(b.id_condominio) + '" style="cursor:pointer"><td ' + TD + '>' + esc(b.condominio) + '</td><td ' + TD + '>' + selo(s[0], s[1]) + '</td><td ' + TD + '>' + esc(b.fornecedor || '') + '</td><td ' + TD + '>' + esc(dataBR(b.data_pagamento)) + '</td><td ' + TD + '>' + (b.valor_pago != null ? brl(b.valor_pago) : '') + '</td><td ' + TD + '>' + esc(b.motivo || '') + '</td></tr>';
          })) : '') + '</div>';
      }).join('') || '<div class="hint">Nada para conferir.</div>';
      document.querySelectorAll('#cp-quadro [data-cp-ir]').forEach(function (tr) { tr.addEventListener('click', function () { abrirCondominio(tr.getAttribute('data-cp-ir')); }); });
    } catch (e) { msg(document.getElementById('cp-info'), e.message, true); }
  }

  // 6. Fornecedores novos (aprovação de gestor ou gerente, nunca de quem pediu).
  async function carregarFornecedores() {
    var el = document.getElementById('cp-quadro'), info = document.getElementById('cp-info');
    msg(info, 'Carregando...');
    try {
      var j = await pegar('/api/pagar/fornecedores');
      msg(info, 'Pedidos de cadastro de fornecedor. O cadastro vale para todos os condomínios do Superlógica.');
      el.innerHTML = (j.itens || []).length ? tabela(['Fornecedor', 'CNPJ', 'Pix', 'Situação', 'Pedido', ''], j.itens.map(function (x) {
        var acoes = x.situacao === 'pendente' ? ((j.pode_aprovar && !x.eu_pedi ? '<button class="btn btn-primary" data-cpf="aprovar" data-id="' + esc(x.id) + '" data-pix="' + (x.pix || x.banco ? '1' : '') + '">Aprovar e cadastrar</button> ' : '') + '<button class="btn btn-ghost" data-cpf="cancelar" data-id="' + esc(x.id) + '">Cancelar</button>') : esc(x.motivo || '');
        return '<tr><td ' + TD + '>' + esc(x.nome) + '</td><td ' + TD + '>' + esc(x.cnpj) + '</td><td ' + TD + '>' + (x.pix ? esc(x.pix.tipo + ' ' + x.pix.chave) : '') + '</td><td ' + TD + '>' + esc(x.situacao) + (x.id_contato ? ' (código ' + esc(x.id_contato) + ')' : '') + '</td>'
          + '<td ' + TD + '>' + esc(x.pedido_por || '') + ' ' + esc(horaBR(x.pedido_em)) + '</td><td ' + TD + '>' + acoes + '</td></tr>';
      })) : '<div class="hint">Nenhum pedido.</div>';
      el.querySelectorAll('[data-cpf]').forEach(function (b) {
        b.addEventListener('click', async function () {
          try {
            if (b.getAttribute('data-cpf') === 'cancelar') { await enviar('POST', '/api/pagar/fornecedores/' + b.getAttribute('data-id') + '/cancelar', {}); return carregarFornecedores(); }
            var como = b.getAttribute('data-pix') ? window.prompt('Como a chave Pix ou a conta foi confirmada com o fornecedor? (telefone, com quem falou)') : '';
            if (b.getAttribute('data-pix') && !como) return;
            b.disabled = true;
            await enviar('POST', '/api/pagar/fornecedores/' + b.getAttribute('data-id') + '/aprovar', { confirmado_como: como }, true);
            carregarFornecedores();
          } catch (e) { b.disabled = false; if (e.status !== 499) window.alert(e.message); }
        });
      });
    } catch (e) { msg(info, e.message, true); }
  }
})();
