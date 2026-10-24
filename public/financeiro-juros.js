// ============================================================
// JUROS E ATRASOS, dentro do item Financeiro: quadro da carteira por mês, casos do condomínio
// e a ficha de cada caso (linha do tempo, evidências, causa provável como sugestão, registro da
// assinatura, decisão de quem paga e histórico). Exporta planilha ou PDF do mês para o síndico.
// Rotas: /api/financeiro/juros/quadro, /api/financeiro/juros/condominio/:id e as de registro,
// decisão, ressarcimento e retorno do banco. O servidor confere módulo, carteira e cargo de novo:
// aqui é só o que aparece na tela.
// ============================================================
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function brlC(c) { return (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function horaBR(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function mesISO(delta) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + delta); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function mesBR(c) { return String(c || '').split('-').reverse().join('/'); }
  function linkSeguro(u) { return /^https:\/\/[a-z0-9.-]+\.superlogica\.net\//i.test(String(u || '')) ? u : ''; }
  var TH = 'style="text-align:left;padding:6px 8px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border2)"';
  var TD_BASE = 'padding:6px 8px;font-size:12px;border-bottom:1px solid var(--border);vertical-align:top';
  var TD = 'style="' + TD_BASE + '"';
  function tdS(extra) { return 'style="' + TD_BASE + ';' + extra + '"'; }
  var SITUACAO = { pago_com_atraso: 'Pago com atraso', pago_no_prazo_com_encargo: 'Pago no prazo com encargo', vencida_sem_pagamento: 'Vencida sem pagamento' };
  var QUEM = { condominio: 'Condomínio', administradora: 'Administradora', fornecedor: 'Fornecedor (estorno)', a_apurar: 'A apurar', a_decidir: 'A decidir' };
  var RES = { sim: ['Sim', 'var(--danger)'], nao: ['Não', 'var(--success, #3a8f5c)'], sem_dado: ['Sem dado', 'var(--muted)'] };
  function selo(texto, cor) {
    return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:' + cor + '">' + esc(texto) + '</span>';
  }
  function msg(el, texto, erro) {
    if (el) el.innerHTML = texto ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : '';
  }
  function pode() { return typeof window.podeAbrirPainel === 'function' && window.podeAbrirPainel('fincontrole'); }

  var est = { montado: false, seq: 0, quadro: null, cond: null, dados: null, aberto: null, filtros: { situacao: '', causa: '', quem: '' } };

  // GET que espera o 202 (leitura em segundo plano). vivo(): false cancela.
  async function pegar(url, vivo, aoEsperar) {
    for (var t = 0; t < 40; t++) {
      if (vivo && !vivo()) throw new Error('cancelado');
      var r = await apiAuthFetch(url);
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 202) {
        if (aoEsperar) aoEsperar(j, t);
        await new Promise(function (ok) { setTimeout(ok, 5000); });
        url = url.replace(/[?&]forcar=1/, '');
        continue;
      }
      if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
      return j;
    }
    throw new Error('A leitura demorou demais. Tente de novo em alguns minutos.');
  }
  async function enviar(metodo, url, corpo) {
    var r = await apiAuthFetch(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
    return j;
  }

  // 1. Card dentro do painel Financeiro (logo depois do quadro de alertas).
  function montar() {
    if (est.montado) return;
    var painel = document.getElementById('panel-fincontrole');
    if (!painel) return;
    var ref = document.getElementById('fin-detalhe');
    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'jur-card';
    card.innerHTML = '<div class="card-header"><span class="card-title">Juros e atrasos</span></div>'
      + '<p class="hint" style="margin:0 0 10px">Parcelas pagas depois do vencimento, juros ou multa lançados, encargo cobrado pelo banco e não lançado, e vencidas sem pagamento. Cada caso traz o que aconteceu, a causa provável (sugestão) e quem paga (decisão do gestor ou do gerente).</p>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<input type="month" id="jur-mes" style="width:auto" value="' + mesISO(-1) + '">'
      + '<button class="btn btn-primary" id="jur-carregar">Carregar</button>'
      + '<span class="hint" style="margin:0">Usa a carteira escolhida no quadro acima.</span></div>'
      + '<div id="jur-info" class="ficha-sub" style="margin:10px 0"></div><div id="jur-ressarcir"></div><div id="jur-quadro"></div>';
    var det = document.createElement('div');
    det.className = 'card';
    det.id = 'jur-detalhe';
    det.style.display = 'none';
    if (ref && ref.parentNode === painel) { painel.insertBefore(card, ref.nextSibling); painel.insertBefore(det, card.nextSibling); }
    else { painel.appendChild(card); painel.appendChild(det); }
    document.getElementById('jur-carregar').addEventListener('click', function () { carregarQuadro(); });
    est.montado = true;
  }
  function aplicar() {
    var c = document.getElementById('jur-card');
    if (!pode()) { if (c) c.style.display = 'none'; var d = document.getElementById('jur-detalhe'); if (d) d.style.display = 'none'; return; }
    montar();
    c = document.getElementById('jur-card');
    if (c) c.style.display = '';
  }
  if (typeof window.showPanel === 'function') {
    var orig = window.showPanel;
    window.showPanel = function () { var r = orig.apply(this, arguments); var p = document.getElementById('panel-fincontrole'); if (p && p.classList.contains('active')) aplicar(); return r; };
  }
  document.addEventListener('auth:ready', function () { setTimeout(aplicar, 0); });

  // 2. Quadro da carteira no mês.
  async function carregarQuadro() {
    var seq = ++est.seq;
    var mes = document.getElementById('jur-mes').value;
    var info = document.getElementById('jur-info');
    if (!/^\d{4}-\d{2}$/.test(mes)) return msg(info, 'Escolha o mês.', true);
    var sel = document.getElementById('fin-carteira');
    var q = ['competencia=' + mes];
    if (sel && sel.value) q.push('carteira=' + encodeURIComponent(sel.value));
    msg(info, 'Carregando...');
    try {
      var j = await pegar('/api/financeiro/juros/quadro?' + q.join('&'), function () { return seq === est.seq; }, function () { msg(info, 'Calculando os dados do Financeiro...'); });
      est.quadro = j;
      renderQuadro(j);
    } catch (e) { if (e.message !== 'cancelado') msg(info, e.message, true); }
  }
  function porResp(pr) {
    return Object.keys(pr || {}).filter(function (k) { return pr[k]; }).map(function (k) { return esc(QUEM[k] || k) + ' ' + brlC(pr[k]); }).join('<br>');
  }
  function renderQuadro(j) {
    var t = j.totais || {};
    msg(document.getElementById('jur-info'), 'Mês ' + mesBR(j.competencia) + '. Dados de ' + horaBR(j.gerado_em) + '. ' + (t.casos || 0) + ' caso(s), encargos lançados ' + brlC(t.encargos_lancados)
      + '. O encargo não lançado aparece ao abrir o condomínio (precisa do extrato).' + (j.aviso ? ' ' + j.aviso : ''));
    var r = document.getElementById('jur-ressarcir');
    if ((j.ressarcir || []).length) {
      r.innerHTML = '<div style="margin:6px 0 12px;padding:10px;border:1px solid var(--warning);border-radius:8px"><b style="font-size:13px">Ressarcir o condomínio</b>'
        + '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;margin-top:6px"><thead><tr><th ' + TH + '>Condomínio</th><th ' + TH + '>Mês</th><th ' + TH + '>Fornecedor</th><th ' + TH + '>Valor</th><th ' + TH + '>Decidido</th></tr></thead><tbody>'
        + j.ressarcir.map(function (x) {
          return '<tr data-jur-ir="' + esc(x.id_condominio) + '" data-jur-mes="' + esc(x.competencia) + '" data-jur-caso="' + esc(x.chave) + '" style="cursor:pointer"><td ' + TD + '>' + esc(x.condominio || x.id_condominio) + '</td><td ' + TD + '>' + esc(mesBR(x.competencia)) + '</td><td ' + TD + '>' + esc(x.fornecedor) + '</td><td ' + TD + '>' + brlC(x.valor) + '</td><td ' + TD + '>' + esc(horaBR(x.decidido_em)) + ' ' + esc(x.decidido_por) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    } else r.innerHTML = '';
    var el = document.getElementById('jur-quadro');
    var lista = j.condominios || [];
    if (!lista.length) { el.innerHTML = '<div class="hint">Nenhum caso neste mês nos condomínios que você vê.</div>'; }
    else {
      el.innerHTML = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th ' + TH + '>Condomínio</th><th ' + TH + '>Analista</th><th ' + TH + '>Casos</th><th ' + TH + '>Pagos com atraso</th><th ' + TH + '>Vencidas</th><th ' + TH + '>Encargos lançados</th><th ' + TH + '>Decidido</th></tr></thead><tbody>'
        + lista.map(function (c) {
          return '<tr data-jur-ir="' + esc(c.id_condominio) + '" data-jur-mes="' + esc(j.competencia) + '" style="cursor:pointer" title="Abrir os casos"><td ' + TD + '><b>' + esc(c.condominio || ('Código ' + c.id_condominio)) + '</b> <span style="color:var(--muted);font-family:var(--mono);font-size:11px">' + esc(c.id_condominio) + '</span></td>'
            + '<td ' + TD + '>' + esc(c.analista || '') + '</td><td ' + TD + '>' + c.casos + '</td><td ' + TD + '>' + c.pagos_com_atraso + '</td><td ' + TD + '>' + c.vencidas_sem_pagamento + '</td>'
            + '<td ' + TD + '>' + (c.encargos_lancados ? brlC(c.encargos_lancados) : '') + '</td><td ' + tdS('font-size:11px') + '>' + porResp(c.por_responsavel) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    document.querySelectorAll('#jur-card [data-jur-ir]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var nome = (lista.find(function (x) { return x.id_condominio === tr.getAttribute('data-jur-ir'); }) || {}).condominio || '';
        abrirCondominio(tr.getAttribute('data-jur-ir'), nome, tr.getAttribute('data-jur-mes'), tr.getAttribute('data-jur-caso'));
      });
    });
  }

  // 3. Casos de um condomínio no mês.
  function abrirCondominio(id, nome, mes, caso) {
    if (!/^\d+$/.test(String(id || '')) || !/^\d{4}-\d{2}$/.test(String(mes || ''))) return;
    est.cond = { id: String(id), nome: nome || '', mes: mes };
    est.dados = null; est.aberto = caso || null;
    var card = document.getElementById('jur-detalhe');
    card.style.display = '';
    card.innerHTML = '<div class="card-header" style="flex-wrap:wrap;gap:8px"><span class="card-title" id="jur-titulo">' + esc(nome || ('Código ' + id)) + ' · ' + esc(mesBR(mes)) + '</span>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-ghost" id="jur-atualizar" style="font-size:12px;padding:6px 12px" title="Lê de novo no Superlógica">Atualizar</button>'
      + '<button class="btn btn-ghost" id="jur-planilha" style="font-size:12px;padding:6px 12px">Planilha do mês</button>'
      + '<button class="btn btn-ghost" id="jur-pdf" style="font-size:12px;padding:6px 12px">PDF do mês</button>'
      + '<label class="btn btn-ghost" style="font-size:12px;padding:6px 12px;cursor:pointer" title="Arquivo de retorno de pagamentos do banco (CNAB 240)">Enviar retorno do banco<input type="file" id="jur-retorno" accept=".ret,.txt,.rem,.cnab,text/plain" style="display:none"></label></div></div>'
      + '<div id="jur-det-info" class="ficha-sub" style="margin-bottom:8px"></div><div id="jur-totais"></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0"><select id="jur-f-situacao" style="width:auto"><option value="">Todas as situações</option>'
      + Object.keys(SITUACAO).map(function (k) { return '<option value="' + k + '">' + SITUACAO[k] + '</option>'; }).join('') + '</select>'
      + '<select id="jur-f-causa" style="width:auto"><option value="">Todas as causas</option></select>'
      + '<select id="jur-f-quem" style="width:auto"><option value="">Quem paga: todos</option>' + Object.keys(QUEM).map(function (k) { return '<option value="' + k + '">' + QUEM[k] + '</option>'; }).join('') + '</select></div>'
      + '<div id="jur-lista"></div><div id="jur-ficha"></div>';
    document.getElementById('jur-atualizar').addEventListener('click', function () { carregarCond(true); });
    document.getElementById('jur-planilha').addEventListener('click', exportarPlanilha);
    document.getElementById('jur-pdf').addEventListener('click', exportarPdf);
    document.getElementById('jur-retorno').addEventListener('change', enviarRetorno);
    ['situacao', 'causa', 'quem'].forEach(function (k) {
      var s = document.getElementById('jur-f-' + k);
      s.value = est.filtros[k] || '';
      s.addEventListener('change', function () { est.filtros[k] = s.value; renderLista(); });
    });
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    carregarCond(false);
  }
  async function carregarCond(forcar) {
    var c = est.cond; var seq = ++est.seq;
    var info = document.getElementById('jur-det-info');
    msg(info, 'Lendo os dados do condomínio...');
    try {
      var j = await pegar('/api/financeiro/juros/condominio/' + encodeURIComponent(c.id) + '?competencia=' + encodeURIComponent(c.mes) + (forcar ? '&forcar=1' : ''),
        function () { return seq === est.seq; }, function () { msg(info, 'Lendo despesas, extrato, auditoria e saldos. Pode levar até um minuto.'); });
      est.dados = j;
      if (j.nome && !c.nome) { c.nome = j.nome; document.getElementById('jur-titulo').textContent = j.nome + ' · ' + mesBR(c.mes); }
      renderCond();
    } catch (e) { if (e.message !== 'cancelado') msg(info, e.message, true); }
  }
  function renderCond() {
    var j = est.dados, l = j.leitura || {}, t = j.totais || {};
    msg(document.getElementById('jur-det-info'), 'Lido em ' + horaBR(j.gerado_em) + '. ' + (j.meta ? j.meta.pagas_no_mes + ' parcela(s) pagas no mês, ' + j.meta.conferidas_no_extrato + ' conferidas no extrato' : '')
      + (l.contas_sem_extrato ? '; ' + l.contas_sem_extrato + ' conta(s) sem extrato importado' : '') + (j.retornos_guardados ? '; ' + j.retornos_guardados + ' pagamento(s) de retorno do banco guardados' : '')
      + ((j.falhas || []).length ? '. Atenção: ' + j.falhas.length + ' leitura(s) falharam; pode faltar dado.' : '.'));
    var pr = t.por_responsavel || {};
    document.getElementById('jur-totais').innerHTML = '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;margin:4px 0 6px">'
      + '<span><b>' + (t.casos || 0) + '</b> caso(s)</span><span>Encargos <b>' + brlC(t.encargos) + '</b></span>'
      + (t.juros_nao_lancado ? '<span style="color:var(--danger)">Não lançado <b>' + brlC(t.juros_nao_lancado) + '</b></span>' : '')
      + Object.keys(QUEM).map(function (k) { return pr[k] ? '<span>' + esc(QUEM[k]) + ' <b>' + brlC(pr[k]) + '</b></span>' : ''; }).join('')
      + (t.ressarcir_pendente ? '<span style="color:var(--warning)">Ressarcir <b>' + brlC(t.ressarcir_pendente) + '</b></span>' : '') + '</div>';
    var sc = document.getElementById('jur-f-causa');
    var causas = {};
    (j.casos || []).forEach(function (c) { causas[c.causa.codigo] = c.causa.rotulo; });
    sc.innerHTML = '<option value="">Todas as causas</option>' + Object.keys(causas).map(function (k) { return '<option value="' + esc(k) + '">' + esc(causas[k]) + '</option>'; }).join('');
    sc.value = causas[est.filtros.causa] ? est.filtros.causa : '';
    renderLista();
  }
  function filtrados() {
    var f = est.filtros;
    return (est.dados.casos || []).filter(function (c) {
      if (f.situacao && c.situacao !== f.situacao) return false;
      if (f.causa && c.causa.codigo !== f.causa) return false;
      if (f.quem && (c.decisao ? c.decisao.quem_paga : 'a_decidir') !== f.quem) return false;
      return true;
    });
  }
  function renderLista() {
    var el = document.getElementById('jur-lista');
    var lista = filtrados();
    if (!lista.length) { el.innerHTML = '<div class="hint">Nenhum caso com esses filtros.</div>'; document.getElementById('jur-ficha').innerHTML = ''; return; }
    el.innerHTML = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th ' + TH + '>Fornecedor</th><th ' + TH + '>Situação</th><th ' + TH + '>Vencimento</th><th ' + TH + '>Pagamento</th><th ' + TH + '>Atraso</th><th ' + TH + '>Encargos</th><th ' + TH + '>Causa provável</th><th ' + TH + '>Quem paga</th></tr></thead><tbody>'
      + lista.map(function (c) {
        var ab = est.aberto === c.chave;
        return '<tr data-jur-caso="' + esc(c.chave) + '" style="cursor:pointer;' + (ab ? 'background:var(--bg3)' : '') + '"><td ' + TD + '><b>' + esc(c.fornecedor || '') + '</b><div style="color:var(--muted);font-size:11px">' + esc(c.documento || '') + '</div></td>'
          + '<td ' + TD + '>' + esc(SITUACAO[c.situacao]) + '</td><td ' + TD + '>' + dataBR(c.datas.vencimento) + '</td><td ' + TD + '>' + dataBR(c.datas.pagamento) + '</td><td ' + TD + '>' + (c.dias_atraso ? c.dias_atraso + ' dia(s)' : '') + '</td>'
          + '<td ' + TD + '>' + (c.valores.encargos ? brlC(c.valores.encargos) : '') + (c.valores.juros_nao_lancado ? '<div style="color:var(--danger);font-size:11px">' + brlC(c.valores.juros_nao_lancado) + ' não lançado</div>' : '') + '</td>'
          + '<td ' + TD + '>' + esc(c.causa.rotulo) + '<div style="color:var(--muted);font-size:11px">sugestão: ' + esc(c.causa.responsavel_sugerido_rotulo) + '</div></td>'
          + '<td ' + TD + '>' + (c.decisao ? '<b>' + esc(c.decisao.rotulo) + '</b>' : '<span style="color:var(--muted)">A decidir</span>') + (c.ressarcimento && c.ressarcimento.status === 'pendente' ? '<div style="color:var(--warning);font-size:11px">ressarcir</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    el.querySelectorAll('tr[data-jur-caso]').forEach(function (tr) {
      tr.addEventListener('click', function () { est.aberto = est.aberto === tr.getAttribute('data-jur-caso') ? null : tr.getAttribute('data-jur-caso'); renderLista(); });
    });
    renderFicha();
  }

  // 4. Ficha do caso.
  function renderFicha() {
    var el = document.getElementById('jur-ficha');
    var c = est.aberto && (est.dados.casos || []).find(function (x) { return x.chave === est.aberto; });
    if (!c) { el.innerHTML = ''; return; }
    var j = est.dados;
    var link = linkSeguro(c.link);
    var h = '<div style="margin-top:14px;padding:12px;border:1px solid var(--border2);border-radius:10px">'
      + '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b style="font-size:14px">' + esc(c.fornecedor || '') + ' · ' + esc(c.documento || '') + '</b>'
      + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener" style="font-size:12px">Abrir a despesa no Superlógica</a>' : '') + '</div>'
      + '<div style="font-size:12px;margin:6px 0">' + (c.sinais || []).map(function (s) { return '<div>• ' + esc(s.texto) + '</div>'; }).join('') + '</div>'
      + '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;margin:6px 0 10px"><span>Valor ' + brlC(c.valores.original) + '</span><span>Juros ' + brlC(c.valores.juros) + '</span><span>Multa ' + brlC(c.valores.multa) + '</span>'
      + (c.valores.juros_nao_lancado ? '<span style="color:var(--danger)">Não lançado ' + brlC(c.valores.juros_nao_lancado) + '</span>' : '') + (c.valores.pago != null ? '<span>Pago ' + brlC(c.valores.pago) + '</span>' : '') + '</div>';
    h += '<div style="font-size:12px;font-weight:600;margin:8px 0 4px">Linha do tempo</div><table style="width:100%;border-collapse:collapse"><tbody>'
      + (c.linha_do_tempo || []).map(function (e) {
        return '<tr><td ' + tdS('white-space:nowrap') + '>' + dataBR(e.data) + (e.hora ? ' ' + esc(e.hora) : '') + '</td><td ' + TD + '><b>' + esc(e.titulo) + '</b>' + (e.detalhe ? '<div style="color:var(--muted);font-size:11px">' + esc(e.detalhe) + '</div>' : '') + '</td><td ' + tdS('color:var(--muted);font-size:11px') + '>' + esc(e.fonte || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
    h += '<div style="font-size:12px;font-weight:600;margin:12px 0 4px">Causa provável (sugestão, não é decisão): ' + esc(c.causa.rotulo) + ' · ' + esc(c.causa.responsavel_sugerido_rotulo) + '</div>'
      + '<div class="hint" style="margin:0 0 6px">' + esc(c.causa.explicacao) + '</div><table style="width:100%;border-collapse:collapse"><tbody>'
      + (c.causa.regras || []).map(function (r) {
        var x = RES[r.resultado] || [r.resultado, 'var(--muted)'];
        return '<tr><td ' + tdS('width:80px') + '>' + selo(x[0], x[1]) + '</td><td ' + TD + '><b>' + esc(r.rotulo) + '</b><div style="color:var(--muted);font-size:11px">' + esc(r.evidencia) + '</div></td></tr>';
      }).join('') + '</tbody></table>';
    var rg = c.registro || {};
    if (j.pode_registrar) {
      h += '<div style="font-size:12px;font-weight:600;margin:12px 0 4px">Assinatura do síndico (registro manual)</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12px">Enviado para assinatura em <input type="date" id="jur-env" value="' + esc(rg.enviado_assinatura_em || '') + '" style="width:auto">'
        + ' Assinado em <input type="date" id="jur-ass" value="' + esc(rg.assinado_em || '') + '" style="width:auto">'
        + ' <select id="jur-ass-por" style="width:auto"><option value="">Quem assinou</option><option value="sindico"' + (rg.assinado_por === 'síndico' ? ' selected' : '') + '>Síndico</option><option value="sindico_subsindico"' + (rg.assinado_por === 'síndico e subsíndico' ? ' selected' : '') + '>Síndico e subsíndico</option></select>'
        + ' <button class="btn btn-ghost" id="jur-salvar-reg" style="font-size:12px;padding:6px 12px">Salvar</button></div>'
        + (rg.registrado_em ? '<div class="hint" style="margin:4px 0 0">Registrado por ' + esc(rg.registrado_por || '') + ' em ' + esc(horaBR(rg.registrado_em)) + '</div>' : '');
    }
    h += '<div style="font-size:12px;font-weight:600;margin:12px 0 4px">Quem paga</div>';
    if (c.decisao) h += '<div style="font-size:12px"><b>' + esc(c.decisao.rotulo) + '</b>: ' + esc(c.decisao.justificativa) + '<div class="hint" style="margin:2px 0 0">Decidido por ' + esc(c.decisao.decidido_por || '') + ' em ' + esc(horaBR(c.decisao.decidido_em)) + '</div></div>';
    if (c.ressarcimento) {
      h += '<div style="font-size:12px;margin-top:6px;color:' + (c.ressarcimento.status === 'pendente' ? 'var(--warning)' : 'var(--muted)') + '">'
        + (c.ressarcimento.status === 'pendente' ? 'Ressarcir o condomínio: ' + brlC(c.ressarcimento.valor) : 'Ressarcido em ' + esc(horaBR(c.ressarcimento.feito_em)) + ' por ' + esc(c.ressarcimento.feito_por || '') + (c.ressarcimento.observacao ? ' (' + esc(c.ressarcimento.observacao) + ')' : '')) + '</div>';
    }
    if (j.pode_decidir && j.pode_registrar) {
      h += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;margin-top:6px"><select id="jur-quem" style="width:auto"><option value="">Escolha quem paga</option>'
        + ['condominio', 'administradora', 'fornecedor', 'a_apurar'].map(function (k) { return '<option value="' + k + '"' + (c.decisao && c.decisao.quem_paga === k ? ' selected' : '') + '>' + QUEM[k] + '</option>'; }).join('') + '</select>'
        + '<textarea id="jur-just" rows="2" maxlength="1000" placeholder="Justificativa (o que aconteceu e por que)" style="flex:1;min-width:240px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:6px 10px;color:var(--text);font-size:12px">' + esc(c.decisao ? c.decisao.justificativa : '') + '</textarea>'
        + '<button class="btn btn-primary" id="jur-decidir" style="font-size:12px;padding:6px 12px">Salvar decisão</button>'
        + (c.ressarcimento && c.ressarcimento.status === 'pendente' ? '<input type="text" id="jur-ress-obs" maxlength="500" placeholder="Como foi ressarcido (opcional)" style="width:auto;min-width:200px"><button class="btn btn-ghost" id="jur-ressarcido" style="font-size:12px;padding:6px 12px">Marcar como ressarcido</button>' : '') + '</div>';
    } else if (!c.decisao) h += '<div class="hint" style="margin:0">Ainda sem decisão. Quem decide é o gestor ou o gerente.</div>';
    if ((c.historico || []).length) {
      h += '<div style="font-size:12px;font-weight:600;margin:12px 0 4px">Histórico</div>' + c.historico.map(function (x) {
        var dep = x.depois || {};
        var o = x.acao === 'decisao' ? 'Decisão: ' + (QUEM[dep.quem_paga] || dep.quem_paga || '') + (x.antes && x.antes.quem_paga ? ' (antes: ' + (QUEM[x.antes.quem_paga] || x.antes.quem_paga) + ')' : '') + (dep.justificativa ? '. ' + dep.justificativa : '')
          : x.acao === 'ressarcimento' ? 'Ressarcimento marcado como feito' + (dep.observacao ? '. ' + dep.observacao : '')
            : 'Registro: ' + Object.keys(dep).map(function (k) { return ({ enviado_assinatura_em: 'envio ', assinado_em: 'assinatura ', assinado_por: 'por ' })[k] + (/_em$/.test(k) ? dataBR(dep[k]) || 'apagada' : (dep[k] || '')); }).join(', ');
        return '<div style="font-size:11px;color:var(--muted);margin:2px 0">' + esc(horaBR(x.em)) + ' · ' + esc(x.por || '') + ' · ' + esc(o) + '</div>';
      }).join('');
    }
    h += '<div id="jur-ficha-msg" style="margin-top:8px"></div></div>';
    el.innerHTML = h;
    var b;
    if ((b = document.getElementById('jur-salvar-reg'))) b.addEventListener('click', function () { salvarRegistro(c); });
    if ((b = document.getElementById('jur-decidir'))) b.addEventListener('click', function () { salvarDecisao(c); });
    if ((b = document.getElementById('jur-ressarcido'))) b.addEventListener('click', function () { marcarRessarcido(c); });
  }
  function urlCaso(c, fim) { return '/api/financeiro/juros/condominio/' + encodeURIComponent(est.cond.id) + '/caso/' + encodeURIComponent(c.chave) + '/' + fim; }
  async function salvarRegistro(c) {
    var m = document.getElementById('jur-ficha-msg');
    try {
      await enviar('PUT', urlCaso(c, 'registro'), { competencia: est.cond.mes, enviado_assinatura_em: document.getElementById('jur-env').value || null, assinado_em: document.getElementById('jur-ass').value || null, assinado_por: document.getElementById('jur-ass-por').value || '' });
      msg(m, 'Registro salvo.'); await carregarCond(false);
    } catch (e) { msg(m, e.message, true); }
  }
  async function salvarDecisao(c) {
    var m = document.getElementById('jur-ficha-msg');
    var quem = document.getElementById('jur-quem').value;
    if (!quem) return msg(m, 'Escolha quem paga.', true);
    try {
      await enviar('PUT', urlCaso(c, 'decisao'), { competencia: est.cond.mes, quem_paga: quem, justificativa: document.getElementById('jur-just').value });
      msg(m, 'Decisão salva.'); await carregarCond(false);
    } catch (e) { msg(m, e.message, true); }
  }
  async function marcarRessarcido(c) {
    var m = document.getElementById('jur-ficha-msg');
    var campo = document.getElementById('jur-ress-obs');
    var obs = campo ? campo.value : '';
    try { await enviar('POST', urlCaso(c, 'ressarcimento'), { observacao: obs }); msg(m, 'Ressarcimento registrado.'); await carregarCond(false); } catch (e) { msg(m, e.message, true); }
  }
  async function enviarRetorno(ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    var info = document.getElementById('jur-det-info');
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) return msg(info, 'Arquivo maior que 2 MB.', true);
    try {
      var texto = await f.text();
      var j = await enviar('POST', '/api/financeiro/juros/condominio/' + encodeURIComponent(est.cond.id) + '/retorno', { texto: texto });
      msg(info, 'Retorno guardado: ' + j.pagamentos + ' pagamento(s), ' + j.efetivados + ' efetivado(s). Lendo de novo...');
      await carregarCond(false);
    } catch (e) { msg(info, e.message, true); }
  }

  // 5. Exportação do mês (sem nome de funcionário).
  function nomeArquivo(ext) {
    var n = String(est.cond.nome || ('condominio ' + est.cond.id)).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_');
    return 'juros_e_atrasos_' + n + '_' + est.cond.mes + '.' + ext;
  }
  function exportarPlanilha() {
    var j = est.dados;
    if (!j || !j.exportacao) return;
    if (typeof XLSX === 'undefined') return msg(document.getElementById('jur-det-info'), 'A planilha não carregou neste navegador. Recarregue a página.', true);
    var ws = XLSX.utils.aoa_to_sheet([j.exportacao.colunas].concat(j.exportacao.linhas));
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Juros e atrasos');
    XLSX.writeFile(wb, nomeArquivo('xlsx'));
  }
  function exportarPdf() {
    var j = est.dados;
    if (!j || !j.exportacao) return;
    var JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDF) return msg(document.getElementById('jur-det-info'), 'O PDF não carregou neste navegador. Recarregue a página.', true);
    var doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    var y = 14, W = 297, M = 12;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text('Juros e atrasos · ' + (est.cond.nome || ('Condomínio ' + est.cond.id)) + ' · ' + mesBR(est.cond.mes), M, y); y += 6;
    var t = j.totais || {};
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(t.casos + ' caso(s). Encargos: ' + brlC(t.encargos) + '. Por quem paga: ' + Object.keys(QUEM).filter(function (k) { return (t.por_responsavel || {})[k]; }).map(function (k) { return QUEM[k] + ' ' + brlC(t.por_responsavel[k]); }).join(', ') + '.', M, y); y += 7;
    var cols = [0, 2, 3, 4, 5, 6, 10, 14, 15, 16]; // fornecedor, situação, datas, atraso, valor, encargos, causa, quem paga, justificativa
    var larg = [42, 30, 20, 20, 13, 20, 20, 50, 26, 32];
    var cab = j.exportacao.colunas;
    function linhaTabela(vals, negrito) {
      doc.setFont('helvetica', negrito ? 'bold' : 'normal'); doc.setFontSize(7.5);
      var x = M, alt = 4;
      var partes = vals.map(function (v, i) { return doc.splitTextToSize(String(v == null ? '' : v), larg[i] - 2); });
      partes.forEach(function (p) { alt = Math.max(alt, p.length * 3.4 + 1); });
      if (y + alt > 200) { doc.addPage(); y = 14; }
      partes.forEach(function (p, i) { doc.text(p, x, y); x += larg[i]; });
      y += alt;
      doc.setDrawColor(210); doc.line(M, y - 2.5, W - M, y - 2.5);
    }
    linhaTabela(cols.map(function (i) { return cab[i]; }), true);
    j.exportacao.linhas.forEach(function (l) {
      linhaTabela(cols.map(function (i) { var v = l[i]; return typeof v === 'number' && [6, 10].indexOf(i) >= 0 ? brlC(Math.round(v * 100)) : v; }), false);
    });
    y += 4; if (y > 196) { doc.addPage(); y = 14; }
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
    doc.text('A causa provável é uma sugestão pela linha do tempo de cada caso. Quem paga é decisão da administração, com a justificativa.', M, y);
    doc.save(nomeArquivo('pdf'));
  }

  window.jurAbrirCondominio = abrirCondominio;
})();
