// ============================================================
// BALANCETE DIGITAL FEITO PELO SISTEMA, dentro da aba Financeiro (módulo balancete).
// 1. Painel "O que está travando": cada condomínio com a etapa, o prazo (meta dia 1, máximo dia 5),
//    a causa de cada trava e quem precisa agir.
// 2. Condomínio ativo no topo: travas, modelo do balancete (aprendido do R&D, a pessoa confere),
//    documentos que precisam chegar (extrato do banco e outros), comentários gravados pelo sistema,
//    confirmação do fechamento do mês e reabertura com motivo.
// O sistema monta sozinho no agendamento; aqui a pessoa confere o que ele marcou e confirma.
// Rotas: /api/financeiro/balancete-digital/... O servidor confere tudo de novo.
// ============================================================
(function () {
  var est = { seq: 0, sit: null, cond: null, mes: '', proposta: null };
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  // Mês no horário de Brasília (o fuso do navegador pode ser outro).
  function mesISO(delta) {
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    var ano = 0, mes = 0;
    p.forEach(function (x) { if (x.type === 'year') ano = Number(x.value); if (x.type === 'month') mes = Number(x.value); });
    var t = ano * 12 + (mes - 1) + delta;
    return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
  }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function temBal(acao) {
    if (window.USER_ROLE === 'GESTOR' && window.USER_PERMS) return true;
    var p = window.USER_PERMS && window.USER_PERMS.balancete;
    return !!(p && p.visivel === true && Array.isArray(p.acoes) && p.acoes.indexOf(acao) >= 0);
  }
  function pode() { return typeof window.podeAbrirPainel === 'function' && window.podeAbrirPainel('fincontrole') && temBal('ver'); }
  function condAtivo() {
    var c = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
    var id = c ? String(c.id_superlogica || '') : '';
    return /^\d+$/.test(id) ? { id: id, nome: c.nome || '' } : null;
  }
  function el(id) { return document.getElementById(id); }
  function info(alvo, texto, erro) { var e = el(alvo); if (e) e.innerHTML = texto ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : ''; }
  var COR_ETAPA = { extrato: 'var(--danger)', conciliacao: 'var(--danger)', comprovantes: 'var(--warning)', montagem: 'var(--warning)', conferencia: 'var(--warning)', pronto_publicar: 'var(--success, #2e7d32)', publicado: 'var(--success, #2e7d32)' };
  var COR_PRAZO = { em_dia: 'var(--muted)', passou_ideal: 'var(--warning)', atrasado: 'var(--danger)', publicado: 'var(--success, #2e7d32)' };
  function selo(texto, cor) { return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:' + cor + '">' + esc(texto) + '</span>'; }
  function listaTravas(travas) {
    if (!travas || !travas.length) return '<div class="hint">Nada travando.</div>';
    return '<ul style="margin:4px 0 0 18px;padding:0;font-size:12px">' + travas.map(function (t) {
      return '<li style="margin:3px 0"><b>' + esc(t.causa) + '</b><div class="hint" style="margin:0">Quem age: ' + esc(t.quem) + '</div></li>';
    }).join('') + '</ul>';
  }

  function montarCartao() {
    var painel = el('panel-fincontrole');
    if (!painel) return;
    var card = el('bd-card');
    if (!pode()) { if (card) card.style.display = 'none'; return; }
    if (card) { card.style.display = ''; return; }
    card = document.createElement('div');
    card.className = 'card';
    card.id = 'bd-card';
    card.innerHTML = '<div class="card-header"><span class="card-title">Balancete do mês: o que está travando</span></div>'
      + '<div class="hint" style="margin-bottom:8px">O sistema acompanha todo dia, monta o balancete no último dia do mês e no dia 1 (comentários com anexo e etiqueta no Demonstrativo R&D) e confere o 900A. Meta: tudo pronto no dia 1, prazo máximo dia 5. Aqui você confere o que ele marcou e confirma o fechamento.</div>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<label style="font-size:12px">Mês <input type="month" id="bd-mes" value="' + mesISO(-1) + '" max="' + mesISO(0) + '" style="width:auto"></label>'
      + '<button class="btn btn-primary" id="bd-painel-btn">Ver todos os condomínios</button>'
      + '<button class="btn btn-ghost" id="bd-cond-btn">Ver o condomínio ativo</button>'
      + '</div><div id="bd-info" style="margin:8px 0"></div><div id="bd-painel"></div><div id="bd-cond"></div>';
    var antes = el('bal-card');
    if (antes && antes.parentNode === painel) painel.insertBefore(card, antes.nextSibling); else painel.appendChild(card);
    el('bd-painel-btn').addEventListener('click', carregarPainel);
    el('bd-cond-btn').addEventListener('click', function () { carregarCond(false); });
  }

  // ── painel de todos os condomínios ──
  async function carregarPainel() {
    var mes = (el('bd-mes') || {}).value || '';
    if (!/^\d{4}-\d{2}$/.test(mes)) { info('bd-info', 'Escolha o mês.', true); return; }
    var seq = ++est.seq;
    el('bd-cond').innerHTML = '';
    info('bd-info', 'Lendo a situação dos condomínios...');
    try {
      var r = await apiAuthFetch('/api/financeiro/balancete-digital/painel?competencia=' + encodeURIComponent(mes));
      var j = await r.json().catch(function () { return {}; });
      if (seq !== est.seq) return;
      if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
      info('bd-info', '');
      desenharPainel(j);
      // Cálculo da carteira rodando: pergunta de novo em 10 segundos.
      if (j.calculo && j.calculo.rodando) setTimeout(function () { if (seq === est.seq) carregarPainel(); }, 10000);
    } catch (e) { if (seq === est.seq) { el('bd-painel').innerHTML = ''; info('bd-info', e.message, true); } }
  }
  async function calcularCarteira() {
    var mes = (el('bd-mes') || {}).value || '';
    var b = el('bd-calcular'); if (b) b.disabled = true;
    try {
      var r = await apiAuthFetch('/api/financeiro/balancete-digital/calcular', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ competencia: mes }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok && r.status !== 202) throw new Error(j.detalhe || ('Falha ' + r.status));
      info('bd-info', j.detalhe || 'Calculando.');
      setTimeout(carregarPainel, 8000);
    } catch (e) { info('bd-info', e.message, true); if (b) b.disabled = false; }
  }
  function desenharPainel(j) {
    var conds = j.condominios || [];
    var quem = Object.keys(j.por_quem || {}).sort(function (a, b) { return j.por_quem[b] - j.por_quem[a]; });
    var html = '<div style="font-size:13px;margin:6px 0">Meta: pronto em ' + esc(dataBR(j.meta && j.meta.ideal)) + '; prazo máximo ' + esc(dataBR(j.meta && j.meta.maximo)) + '. '
      + esc(conds.length) + ' condomínio(s) acompanhados' + (j.sem_calculo ? ', ' + esc(j.sem_calculo) + ' ainda sem cálculo' : '') + '.</div>';
    if (quem.length) html += '<div class="hint" style="margin-bottom:6px">Quem precisa agir: ' + quem.map(function (q) { return esc(q) + ' (' + esc(j.por_quem[q]) + ')'; }).join(', ') + '</div>';
    html += '<table class="tbl" style="width:100%;font-size:12px"><thead><tr><th>Condomínio</th><th>Etapa</th><th>Prazo</th><th>O que está travando e quem age</th></tr></thead><tbody>'
      + conds.map(function (c) {
        return '<tr><td class="td-livre"><b>' + esc(c.nome) + '</b>' + (c.carteira ? '<div class="hint" style="margin:0">' + esc(c.carteira) + '</div>' : '')
          + (c.reaberturas ? '<div class="hint" style="margin:0;color:var(--warning)">Reaberto ' + esc(c.reaberturas) + ' vez(es)</div>' : '') + '</td>'
          + '<td>' + selo(c.etapa_nome, COR_ETAPA[c.etapa] || 'var(--muted)') + '</td>'
          + '<td>' + selo(c.prazo && c.prazo.texto || '', COR_PRAZO[c.prazo && c.prazo.situacao] || 'var(--muted)') + '</td>'
          + '<td class="td-livre">' + listaTravas((c.travas || []).slice(0, 4)) + (c.total_travas > 4 ? '<div class="hint">Mais ' + esc(c.total_travas - 4) + ' trava(s).</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>';
    // Explica quando o cálculo automático roda e oferece calcular agora (só leitura, 2 por vez).
    var ag = j.agenda || {};
    var quando = ag.modo === 'off' ? 'O cálculo automático está desligado.'
      : 'O cálculo automático roda às ' + (ag.horas || [6, 11, 16]).map(function (h) { return h + 'h'; }).join(', ') + ' do dia 1 ao 15 e no último dia do mês' + (ag.modo === 'todos' ? '.' : ', por enquanto só nos condomínios de teste.');
    var calc = j.calculo && j.calculo.rodando ? '<div class="hint">Calculando a carteira: ' + esc(j.calculo.feitos) + ' de ' + esc(j.calculo.total) + '.</div>'
      : (j.sem_calculo ? '<div style="margin:6px 0"><button class="btn btn-ghost" id="bd-calcular" style="font-size:12px">Calcular a carteira agora</button> <span class="hint">' + esc(j.sem_calculo) + ' condomínio(s) sem cálculo neste mês. Só lê o Superlógica, 2 por vez.</span></div>' : '');
    if (!conds.length) html = '<div class="hint">Nenhum condomínio calculado neste mês ainda. ' + esc(quando) + '</div>';
    else html += '<div class="hint" style="margin-top:6px">' + esc(quando) + '</div>';
    el('bd-painel').innerHTML = html + calc;
    if (el('bd-calcular')) el('bd-calcular').addEventListener('click', calcularCarteira);
  }

  // ── condomínio ativo ──
  async function carregarCond(forcar) {
    var c = condAtivo();
    var mes = (el('bd-mes') || {}).value || '';
    if (!c) { info('bd-info', 'Escolha o condomínio no topo.', true); return; }
    if (!/^\d{4}-\d{2}$/.test(mes)) { info('bd-info', 'Escolha o mês.', true); return; }
    var seq = ++est.seq;
    est.cond = c; est.mes = mes;
    el('bd-painel').innerHTML = '';
    info('bd-info', 'Conferindo ' + c.nome + '...');
    var url = '/api/financeiro/balancete-digital/' + encodeURIComponent(c.id) + '/situacao?competencia=' + encodeURIComponent(mes) + (forcar ? '&forcar=1' : '');
    try {
      for (var t = 0; t < 40; t++) {
        var r = await apiAuthFetch(t ? url.replace('&forcar=1', '') : url);
        var j = await r.json().catch(function () { return {}; });
        if (seq !== est.seq) return;
        if (r.status === 202) { info('bd-info', (j.detalhe || 'Calculando...') + ' (' + (t * 6) + ' s)'); await new Promise(function (ok) { setTimeout(ok, 6000); }); continue; }
        if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
        info('bd-info', '');
        est.sit = j;
        desenharCond(j);
        return;
      }
      throw new Error('O cálculo está demorando mais que o normal. Tente de novo em alguns minutos.');
    } catch (e) {
      // Erro (ex.: mês que ainda não começou): limpa o que era de outro mês e mostra só a mensagem.
      if (seq === est.seq) { est.sit = null; el('bd-cond').innerHTML = ''; info('bd-info', e.message, true); }
    }
  }

  function nomeFonte(f) { return f ? (f.descricao || f.tipo) : ''; }
  var NOME_ESTADO = { gravado: 'Gravado', ja_existia: 'Já estava no R&D', incerto: 'Sem confirmação', falhou: 'Não gravou', falta_documento: 'Documento não chegou', aguardar: 'Gerando relatório', pendente: 'Pendente' };
  function desenharCond(s) {
    var gravar = temBal('gerar');
    var m = s.modelo;
    var html = '<div style="margin-top:10px;font-size:14px"><b>' + esc(s.nome || est.cond.nome) + '</b> ' + selo(s.etapa_nome, COR_ETAPA[s.etapa] || 'var(--muted)') + ' '
      + selo(s.prazo && s.prazo.texto || '', COR_PRAZO[s.prazo && s.prazo.situacao] || 'var(--muted)') + '</div>'
      + '<div class="hint">Fechado até: ' + esc(s.fechado_ate ? dataBR(s.fechado_ate) : (s.fechado_ate === '' ? 'nunca fechado' : 'não lido')) + '. Calculado em ' + esc(new Date(s.calculado_em).toLocaleString('pt-BR')) + '. <a href="#" id="bd-recalc">Calcular de novo</a></div>'
      + (s.gravacao && s.gravacao !== 'livre' ? '<div class="hint" style="color:var(--warning)">Neste condomínio a gravação no Superlógica pede a sua confirmação (o sistema prepara e você confirma em Montar agora).</div>' : '')
      + '<div style="margin-top:8px"><b style="font-size:13px">O que está travando</b>' + listaTravas(s.travas) + '</div>'
      + ((s.avisos || []).length ? '<div class="hint" style="margin-top:4px">Avisos que não seguram o balancete: ' + s.avisos.map(esc).join('<br>') + '</div>' : '');
    if (s.soma && s.soma.ok != null) html += '<div class="hint" style="margin-top:6px">Demonstrativo contra o caixa: ' + (s.soma.ok ? 'bate' : 'diferença de ' + esc(Number(s.soma.diferenca).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }))) + '.</div>';

    // Modelo e montagem
    html += '<div style="margin-top:12px"><b style="font-size:13px">Modelo do balancete</b> '
      + (m ? (m.confirmado ? '<span class="hint">conferido por ' + esc(m.confirmado_por) + '</span>' : '<span class="hint" style="color:var(--warning)">aprendido pelo sistema, ainda não conferido</span>') : '<span class="hint">não encontrado</span>')
      + (gravar ? ' <button class="btn btn-ghost" id="bd-aprender" style="font-size:11px;padding:3px 10px">Aprender de novo dos últimos meses</button>' : '') + '</div>';
    if (m && m.itens && m.itens.length) {
      var docs = {}; (s.documentos || []).forEach(function (d) { (docs[d.chave] = docs[d.chave] || []).push(d); });
      html += '<table class="tbl" style="width:100%;font-size:12px;margin-top:4px"><thead><tr><th>#</th><th>Comentário</th><th>Onde</th><th>Etiqueta</th><th>Documento</th><th>No Superlógica</th></tr></thead><tbody>'
        + m.itens.map(function (i) {
          var mo = (s.montagem || {})[i.chave] || {};
          var est2 = mo.estado || 'pendente';
          var doc = '';
          if (i.fonte && i.fonte.tipo === 'recebido') {
            var ds = docs[i.chave] || [];
            doc = (i.fonte.movimentacao === '018B' ? '<div class="hint" style="margin:0">Movimentação de cada poupança: o Hub gera.</div>' : '')
              + (ds.length ? 'Recebido' + (ds.length > 1 ? 's ' + esc(ds.length) + ' PDFs' : '') + ': ' + ds.map(function (d) { return esc(d.nome); }).join(', ') : '<span style="color:var(--danger)">Não chegou</span>');
            if (gravar && est2 !== 'gravado' && est2 !== 'ja_existia') doc += ' <label class="btn btn-ghost" style="font-size:11px;padding:2px 8px;cursor:pointer">Enviar PDF<input type="file" accept="application/pdf" data-bd-doc="' + esc(i.chave) + '" style="display:none"></label>';
          } else doc = esc(nomeFonte(i.fonte));
          return '<tr><td>' + esc(i.ordem) + '</td><td class="td-livre">' + esc(i.titulo) + '</td><td>' + esc(i.conta === 'DIAGNOSTICO' ? 'Balão do R&D' : i.conta) + '</td><td>' + esc(i.etiqueta_nome || i.etiqueta_id || 'sem etiqueta') + '</td>'
            + '<td class="td-livre">' + doc + '</td><td class="td-livre">' + esc(NOME_ESTADO[est2] || est2) + (mo.msg && est2 !== 'gravado' ? '<div class="hint" style="margin:0">' + esc(mo.msg) + '</div>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
      if ((m.avisos || []).length) html += '<div class="hint" style="margin-top:4px">' + m.avisos.map(esc).join('<br>') + '</div>';
      if (gravar && !m.confirmado) html += '<button class="btn btn-ghost" id="bd-confirmar-modelo" style="font-size:12px;margin-top:6px">Conferi: o modelo está certo</button>';
    }
    html += '<div id="bd-proposta"></div>';
    if (gravar) {
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
        + '<button class="btn btn-ghost" id="bd-montar">Montar agora</button>'
        + (s.montagem_completa && s.comentarios_privados ? '<button class="btn btn-primary" id="bd-publicos">Tornar públicos os comentários do balancete</button>' : '')
        + '<button class="btn btn-primary" id="bd-fechar"' + (s.fechado ? ' disabled title="' + esc('Mês já fechado em ' + dataBR(s.fechado_ate)) + '"' : '') + '>Confirmar o fechamento do mês</button>'
        + (s.fechado && (window.USER_ROLE === 'GESTOR' || window.USER_ROLE === 'GERENTE') ? '<button class="btn btn-ghost" id="bd-reabrir">Reabrir o mês</button>' : '')
        + '<button class="btn btn-ghost" id="bd-historico">Quem fechou e reabriu</button></div>'
        + '<div id="bd-reabrir-box"></div><div id="bd-acao-info" style="margin-top:6px"></div><div id="bd-hist"></div>';
    }
    html += '<div class="hint" style="margin-top:8px">Ordem: o sistema monta os comentários privados; você confirma o fechamento; depois confirma "Tornar públicos os comentários do balancete" (o 900A só leva os anexos dos comentários públicos, e eles passam a aparecer para os condôminos no Demonstrativo R&D); o sistema gera e confere o 900A; por fim você publica.</div>';
    el('bd-cond').innerHTML = html;
    el('bd-recalc').addEventListener('click', function (ev) { ev.preventDefault(); carregarCond(true); });
    if (el('bd-aprender')) el('bd-aprender').addEventListener('click', aprender);
    if (el('bd-confirmar-modelo')) el('bd-confirmar-modelo').addEventListener('click', function () { confirmarModelo(m.itens); });
    document.querySelectorAll('[data-bd-doc]').forEach(function (inp) { inp.addEventListener('change', function () { enviarDoc(inp.getAttribute('data-bd-doc'), inp.files && inp.files[0]); }); });
    if (el('bd-montar')) el('bd-montar').addEventListener('click', montarAgora);
    if (el('bd-publicos')) el('bd-publicos').addEventListener('click', tornarPublicos);
    if (el('bd-fechar')) el('bd-fechar').addEventListener('click', fecharMes);
    if (el('bd-reabrir')) el('bd-reabrir').addEventListener('click', abrirReabertura);
    if (el('bd-historico')) el('bd-historico').addEventListener('click', historico);
    desenharPublicacao(s, gravar);
  }

  async function aprender() {
    info('bd-acao-info', 'Lendo os comentários do Demonstrativo R&D dos últimos 3 meses...');
    try {
      var r = await apiAuthFetch('/api/financeiro/balancete-digital/' + encodeURIComponent(est.cond.id) + '/modelo/aprender', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ competencia: est.mes }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
      info('bd-acao-info', '');
      est.proposta = j.proposta;
      var p = j.proposta || { itens: [] };
      var h = '<div style="border:1px solid var(--border2);border-radius:10px;padding:10px;margin-top:8px"><b style="font-size:13px">Modelo lido de ' + esc((p.meses_lidos || []).join(', ')) + '</b>';
      if (!p.itens.length) h += '<div class="hint">Nenhum comentário com anexo se repetiu nesses meses.</div>';
      else h += '<table class="tbl" style="width:100%;font-size:12px"><thead><tr><th>Usar</th><th>Comentário</th><th>Conta</th><th>Etiqueta</th><th>Documento</th><th>Meses</th></tr></thead><tbody>'
        + p.itens.concat(p.as_vezes || []).map(function (i, k) {
          var etqs = (p.etiquetas || []).map(function (e) { return '<option value="' + esc(e.id) + '"' + (Number(e.id) === Number(i.etiqueta_id) ? ' selected' : '') + '>' + esc(e.nome) + '</option>'; }).join('');
          return '<tr><td><input type="checkbox" data-bd-usar="' + k + '"' + (k < p.itens.length ? ' checked' : '') + '></td><td class="td-livre">' + esc(i.titulo) + '</td>'
            + '<td><input type="text" data-bd-conta="' + k + '" value="' + esc(i.conta) + '" style="width:70px"></td>'
            + '<td>' + (etqs ? '<select data-bd-etq="' + k + '"><option value="">sem etiqueta</option>' + etqs + '</select>' : esc(i.etiqueta_nome || i.etiqueta_id || '')) + '</td>'
            + '<td class="td-livre">' + esc(nomeFonte(i.fonte)) + '</td><td>' + esc(i.meses) + '</td></tr>';
        }).join('') + '</tbody></table><button class="btn btn-primary" id="bd-salvar-proposta" style="font-size:12px;margin-top:6px">Conferi: usar este modelo</button>';
      if ((p.avisos || []).length) h += '<div class="hint">' + p.avisos.map(esc).join('<br>') + '</div>';
      el('bd-proposta').innerHTML = h + '</div>';
      if (el('bd-salvar-proposta')) el('bd-salvar-proposta').addEventListener('click', function () {
        var todos = p.itens.concat(p.as_vezes || []);
        var itens = [];
        todos.forEach(function (i, k) {
          var u = document.querySelector('[data-bd-usar="' + k + '"]');
          if (!u || !u.checked) return;
          var conta = document.querySelector('[data-bd-conta="' + k + '"]');
          var etq = document.querySelector('[data-bd-etq="' + k + '"]');
          var it = Object.assign({}, i, { conta: conta ? conta.value.trim() : i.conta });
          if (etq) { it.etiqueta_id = etq.value ? Number(etq.value) : null; it.etiqueta_nome = etq.value ? etq.options[etq.selectedIndex].text : ''; }
          itens.push(it);
        });
        confirmarModelo(itens);
      });
    } catch (e) { info('bd-acao-info', e.message, true); }
  }
  async function confirmarModelo(itens) {
    try {
      var r = await apiAuthFetch('/api/financeiro/balancete-digital/' + encodeURIComponent(est.cond.id) + '/modelo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itens: itens }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
      carregarCond(false);
    } catch (e) { info('bd-acao-info', e.message, true); }
  }
  function lerBase64(arq) {
    return new Promise(function (ok, falha) {
      var fr = new FileReader();
      fr.onload = function () { ok(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { falha(new Error('Não foi possível ler o arquivo.')); };
      fr.readAsDataURL(arq);
    });
  }
  async function enviarDoc(chave, arq) {
    if (!arq) return;
    if (arq.size > 15 * 1024 * 1024) { info('bd-acao-info', 'O PDF passa de 15 MB, limite do Superlógica.', true); return; }
    info('bd-acao-info', 'Enviando ' + arq.name + '...');
    try {
      var b64 = await lerBase64(arq);
      var r = await apiAuthFetch('/api/financeiro/balancete-digital/' + encodeURIComponent(est.cond.id) + '/documento', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ competencia: est.mes, chave: chave, nome: arq.name, pdf_base64: b64 }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
      info('bd-acao-info', j.detalhe || 'Recebido.');
      carregarCond(false);
    } catch (e) { info('bd-acao-info', e.message, true); }
  }
  async function gravar(caminho, corpo, aoTerminar) {
    var r = await (window.gravarNoSuperlogica || apiAuthFetch)('/api/financeiro/balancete-digital/' + encodeURIComponent(est.cond.id) + caminho, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    var j = await r.json().catch(function () { return {}; });
    if (r.status === 499) { info('bd-acao-info', j.detalhe || 'Cancelado.'); return; }
    if (!r.ok && r.status !== 202) throw new Error(j.detalhe || (textoFalha(r.status)));
    info('bd-acao-info', j.detalhe || 'Feito.');
    if (aoTerminar) aoTerminar(j);
  }
  async function tornarPublicos() {
    var b = el('bd-publicos'); b.disabled = true;
    try { await gravar('/tornar-publicos', { competencia: est.mes }, function () { carregarCond(false); }); }
    catch (e) { info('bd-acao-info', e.message, true); b.disabled = false; }
  }
  async function montarAgora() {
    var b = el('bd-montar'); b.disabled = true;
    try { await gravar('/montar', { competencia: est.mes }, function () { setTimeout(function () { carregarCond(false); }, 20000); }); }
    catch (e) { info('bd-acao-info', e.message, true); }
    setTimeout(function () { if (el('bd-montar')) el('bd-montar').disabled = false; }, 30000);
  }
  async function fecharMes() {
    var b = el('bd-fechar'); b.disabled = true;
    info('bd-acao-info', 'Conferindo o mês antes de fechar...');
    try { await gravar('/fechar-mes', { competencia: est.mes }, function () { carregarCond(false); }); }
    catch (e) { info('bd-acao-info', e.message, true); b.disabled = false; }
  }
  function abrirReabertura() {
    el('bd-reabrir-box').innerHTML = '<div style="margin-top:8px"><label style="font-size:12px;display:block">Motivo da reabertura (fica registrado com o seu nome)</label>'
      + '<textarea id="bd-motivo" rows="2" maxlength="300" style="width:100%"></textarea>'
      + '<button class="btn btn-ghost" id="bd-reabrir-ok" style="font-size:12px;margin-top:4px">Reabrir</button></div>';
    el('bd-reabrir-ok').addEventListener('click', async function () {
      var motivo = (el('bd-motivo').value || '').trim();
      if (motivo.length < 10) { info('bd-acao-info', 'Escreva o motivo (pelo menos 10 letras).', true); return; }
      try { await gravar('/reabrir-mes', { competencia: est.mes, motivo: motivo }, function () { carregarCond(false); }); }
      catch (e) { info('bd-acao-info', e.message, true); }
    });
  }
  async function historico() {
    try {
      var r = await apiAuthFetch('/api/financeiro/balancete-digital/' + encodeURIComponent(est.cond.id) + '/fechamentos');
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
      var l = j.registros || [];
      el('bd-hist').innerHTML = l.length ? '<table class="tbl" style="width:100%;font-size:12px;margin-top:6px"><thead><tr><th>Quando</th><th>Mês</th><th>O que</th><th>De</th><th>Para</th><th>Quem</th><th>Motivo</th></tr></thead><tbody>'
        + l.map(function (x) {
          return '<tr><td>' + esc(new Date(x.em).toLocaleString('pt-BR')) + '</td><td>' + esc(x.competencia) + '</td><td>' + (x.acao === 'fechar' ? 'Fechou' : 'Reabriu') + (x.ok ? '' : ' (não confirmado)') + '</td>'
            + '<td>' + esc(dataBR(x.data_anterior) || 'nunca') + '</td><td>' + esc(x.data_nova == null ? '?' : (dataBR(x.data_nova) || 'nunca')) + '</td><td>' + esc(x.por_email) + '</td><td class="td-livre">' + esc(x.motivo || '') + '</td></tr>';
        }).join('') + '</tbody></table>' : '<div class="hint">Nenhum fechamento registrado pelo Hub.</div>';
    } catch (e) { info('bd-acao-info', e.message, true); }
  }

  // Publicar o 900A pelo Hub: só em "Pronto para publicar" (comentários públicos e conferência ok);
  // publicado, oferece retirar a publicação. O servidor confere tudo de novo antes de gravar.
  function desenharPublicacao(s, podeGravar) {
    var ult = s.ultimo_900a;
    if (!podeGravar || !window.PublicarSL || !ult || !el('bd-cond')) return;
    var publicado = s.etapa === 'publicado' && !!ult.publicado;
    if (s.etapa !== 'pronto_publicar' && !publicado) return;
    el('bd-cond').insertAdjacentHTML('beforeend', '<div id="bd-publicar"></div>');
    PublicarSL.painel(el('bd-publicar'), {
      url: '/api/financeiro/balancete-digital/' + encodeURIComponent(est.cond.id) + '/publicar',
      corpo: { competencia: est.mes, id_impressao: ult.id }, publicado: publicado,
      idSuperlogica: est.cond.id, nomeCond: s.nome || est.cond.nome,
      aoTerminar: function () { setTimeout(function () { carregarCond(true); }, 1500); }
    });
  }

  if (typeof window.showPanel === 'function') {
    var orig = window.showPanel;
    window.showPanel = function () { var r = orig.apply(this, arguments); montarCartao(); return r; };
  }
  document.addEventListener('auth:ready', function () { setTimeout(montarCartao, 0); });
})();
