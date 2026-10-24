// ============================================================
// BOLETOS DO MÊS, dentro do item Boletos: calendário de geração da carteira, preparação da
// composição do mês (gravada no Superlógica pela política de gravação), conferência antes de
// gerar, remessa (só o arquivo), régua de cobrança e trocas da forma de recebimento (PJBank).
// A geração do lote continua sendo o clique da pessoa no Superlógica. O servidor confere módulo,
// carteira, cargo e política de novo: aqui é só o que aparece na tela.
// Rotas: /api/financeiro/boletos-mes/... (financeiro/boletos-mes-rotas.js).
// ============================================================
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function brl(v) { return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function mesISO(delta) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + delta); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function linkSeguro(u) { return /^https:\/\/[a-z0-9.-]+\.superlogica\.(net|com)\//i.test(String(u || '')) ? u : ''; }
  var TH = 'style="text-align:left;padding:6px 8px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border2)"';
  var TD = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid var(--border);vertical-align:top"';
  var COR = { alta: 'var(--danger)', media: 'var(--warning)', baixa: 'var(--muted)', ok: 'var(--success, #3a8f5c)' };
  var ROTULO_CAL = { atrasado: 'Atrasado', vencido_sem_lote: 'Vencido sem lote', perto: 'Perto do limite', no_prazo: 'No prazo', gerado: 'Gerado', gerado_em_cima: 'Gerado em cima', gerado_tarde: 'Gerado tarde', sem_dia: 'Sem vencimento', sem_leitura: 'Sem leitura', sem_lote_mensal: 'Sem lote mensal' };
  function selo(texto, cor) { return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:' + cor + '">' + esc(texto) + '</span>'; }
  function msg(id, texto, erro) { var el = document.getElementById(id); if (el) el.innerHTML = texto ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : ''; }
  function pode() { return typeof window.podeAbrirPainel === 'function' && window.podeAbrirPainel('boletos'); }
  function cond() {
    var c = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
    var id = c ? String(c.id_superlogica || '') : '';
    return /^\d+$/.test(id) ? { id: id, nome: c.nome || ('Condomínio ' + id) } : null;
  }
  var est = { seq: 0, itens: [], comp: null, contas: [] };

  // GET que espera o 202 (leitura em segundo plano).
  async function pegar(url, aoEsperar) {
    for (var t = 0; t < 40; t++) {
      var r = await apiAuthFetch(url);
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 202) { if (aoEsperar) aoEsperar(j); await new Promise(function (ok) { setTimeout(ok, 5000); }); url = url.replace(/[?&]forcar=1/, ''); continue; }
      if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
      return j;
    }
    throw new Error('A leitura demorou demais. Tente de novo em alguns minutos.');
  }
  // POST que grava no Superlógica: passa pela janela de confirmação (confirmar-gravacao.js).
  async function gravar(url, corpo) {
    var f = typeof window.gravarNoSuperlogica === 'function' ? window.gravarNoSuperlogica : apiAuthFetch;
    var r = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    var j = await r.json().catch(function () { return {}; });
    if (r.status === 499) throw new Error(j.detalhe || 'Gravação cancelada. Nada foi gravado.');
    if (!r.ok && r.status !== 207) throw new Error(j.detalhe || ('Falha ' + r.status));
    return j;
  }
  async function enviar(url, corpo) {
    var r = await apiAuthFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
    return j;
  }
  function base(id) { return '/api/financeiro/boletos-mes/' + encodeURIComponent(id); }
  function semCond(id) { msg(id, 'Escolha o condomínio no topo.', true); }
  function textoGravacao(g) {
    if (!g || !g.liberada) return 'Gravação pelo Hub ainda não liberada para este condomínio (por enquanto só no condomínio de teste). Faça direto no Superlógica.';
    return g.confirmacao ? 'Grava no Superlógica depois da sua confirmação' + (g.confirmacao === 'reforcada' ? ' (digitando o nome do condomínio).' : '.') : 'Condomínio de teste: grava direto.';
  }
  function card(id, titulo, corpo) {
    var c = document.createElement('div');
    c.className = 'card'; c.id = id;
    c.innerHTML = '<div class="card-header"><span class="card-title">' + esc(titulo) + '</span></div>' + corpo;
    return c;
  }

  // ── montagem dos cards no painel Boletos ──
  function montar() {
    var painel = document.getElementById('panel-boletos');
    if (!painel || document.getElementById('bm-cal')) return;
    var t27 = document.getElementById('fin-bol-lista');
    var cardT27 = t27 ? t27.closest('.card') : null;
    var antes = [
      card('bm-cal', 'Calendário de geração', '<p class="hint" style="margin:0 0 10px">Para cada condomínio da sua carteira: vencimento, data limite para o lote estar pronto (10 dias antes; o boleto sai de 7 a 10 dias antes) e se o lote do mês já foi gerado.</p>'
        + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><label style="font-size:12px">Mês do vencimento <input type="month" id="bm-cal-mes" style="width:auto"></label>'
        + '<button class="btn btn-primary" id="bm-cal-ler" style="font-size:12px;padding:6px 14px">Carregar</button><button class="btn btn-ghost" id="bm-cal-forcar" style="font-size:12px">Atualizar</button>'
        + '<select id="bm-cal-filtro" style="width:auto"><option value="">Todos</option><option value="atencao">Atrasados e perto do limite</option><option value="gerados">Gerados</option></select></div>'
        + '<div class="hint" style="margin:6px 0">Sem mês escolhido, mostra o próximo vencimento de cada condomínio.</div><div id="bm-cal-info" class="ficha-sub" style="margin:8px 0"></div><div id="bm-cal-lista"></div>'),
      card('bm-prep', 'Preparar o boleto do mês', '<p class="hint" style="margin:0 0 10px">Taxas extras, parcelas aprovadas em assembleia e itens de uma unidade, gravados na composição do mês do condomínio ativo. O Hub não gera boletos: a geração continua com você no Superlógica, depois da conferência.</p>'
        + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><label style="font-size:12px">Mês do vencimento <input type="month" id="bm-mes" style="width:auto"></label>'
        + '<button class="btn btn-primary" id="bm-ler" style="font-size:12px;padding:6px 14px">Ler composição</button></div>'
        + '<div id="bm-prep-info" class="ficha-sub" style="margin:8px 0"></div><div id="bm-comp"></div><div id="bm-form"></div><div id="bm-novos"></div>'),
      card('bm-antes', 'Conferência antes de gerar', '<p class="hint" style="margin:0 0 10px">Lê a simulação do Superlógica (relatório 074A) e compara cada unidade com os 3 meses anteriores; confere leituras de água e gás, itens repetidos e taxa extra fora do período. Usa o mês escolhido acima.</p>'
        + '<button class="btn btn-primary" id="bm-antes-ler" style="font-size:12px;padding:6px 14px">Conferir antes de gerar</button> <button class="btn btn-ghost" id="bm-antes-forcar" style="font-size:12px">Ler de novo</button>'
        + '<div id="bm-antes-info" class="ficha-sub" style="margin:8px 0"></div><div id="bm-antes-lista"></div>'),
    ];
    var depois = [
      card('bm-rem', 'Depois de gerar: conferência e remessa', '<p class="hint" style="margin:0 0 10px">Depois de clicar em gerar no Superlógica: confira os boletos gerados no quadro acima (mesmo mês) e, nos condomínios com boleto do banco, gere aqui o arquivo de remessa. O Hub só gera o arquivo; subir no site do banco continua com você.</p>'
        + '<button class="btn btn-ghost" id="bm-pos" style="font-size:12px">Conferir os boletos gerados do mês</button> <button class="btn btn-primary" id="bm-rem-ler" style="font-size:12px;padding:6px 14px">Ver remessas pendentes</button>'
        + '<div id="bm-rem-info" class="ficha-sub" style="margin:8px 0"></div><div id="bm-rem-lista"></div>'),
      card('bm-regua', 'Régua de cobrança', '<p class="hint" style="margin:0 0 10px">Como o Superlógica envia os boletos por email neste condomínio, e o padrão da casa: envio 7 dias antes, lembrete no dia e aviso de atraso 3 dias depois (só com retorno automático, para não cobrar quem já pagou).</p>'
        + '<button class="btn btn-primary" id="bm-regua-ler" style="font-size:12px;padding:6px 14px">Ver régua</button><div id="bm-regua-info" class="ficha-sub" style="margin:8px 0"></div><div id="bm-regua-lista"></div>'),
      card('bm-pj', 'Trocas da forma de recebimento (PJBank)', '<p class="hint" style="margin:0 0 10px">Só leitura: quando a forma de recebimento foi trocada à mão (ativo, contingência, desativado), por quem e com que frequência, pela auditoria do Superlógica dos últimos 60 dias.</p>'
        + '<button class="btn btn-primary" id="bm-pj-ler" style="font-size:12px;padding:6px 14px">Ler trocas</button><div id="bm-pj-info" class="ficha-sub" style="margin:8px 0"></div><div id="bm-pj-lista"></div>'),
    ];
    antes.forEach(function (c) { if (cardT27) painel.insertBefore(c, cardT27); else painel.appendChild(c); });
    var ref = cardT27 ? cardT27.nextSibling : null;
    depois.forEach(function (c) { painel.insertBefore(c, ref); });
    document.getElementById('bm-mes').value = mesISO(1);
    document.getElementById('bm-cal-ler').addEventListener('click', function () { calendario(false); });
    document.getElementById('bm-cal-forcar').addEventListener('click', function () { calendario(true); });
    document.getElementById('bm-cal-filtro').addEventListener('change', function () { if (est.cal) renderCal(est.cal); });
    document.getElementById('bm-ler').addEventListener('click', lerComposicao);
    document.getElementById('bm-antes-ler').addEventListener('click', function () { conferirAntes(false); });
    document.getElementById('bm-antes-forcar').addEventListener('click', function () { conferirAntes(true); });
    document.getElementById('bm-pos').addEventListener('click', conferirDepois);
    document.getElementById('bm-rem-ler').addEventListener('click', remessa);
    document.getElementById('bm-regua-ler').addEventListener('click', regua);
    document.getElementById('bm-pj-ler').addEventListener('click', function () { pjbank(false); });
    window.addEventListener('condominioAtivo:trocou', limpar);
  }
  function limpar() {
    est.seq++; est.itens = []; est.comp = null;
    ['bm-prep-info', 'bm-comp', 'bm-form', 'bm-novos', 'bm-antes-info', 'bm-antes-lista', 'bm-rem-info', 'bm-rem-lista', 'bm-regua-info', 'bm-regua-lista', 'bm-pj-info', 'bm-pj-lista'].forEach(function (id) { var el = document.getElementById(id); if (el) el.innerHTML = ''; });
  }
  function mesEscolhido() { var v = (document.getElementById('bm-mes') || {}).value; return /^\d{4}-\d{2}$/.test(v) ? v : null; }

  // ── 1. calendário ──
  async function calendario(forcar) {
    if (!pode()) return;
    var mes = document.getElementById('bm-cal-mes').value;
    var q = [];
    if (/^\d{4}-\d{2}$/.test(mes)) q.push('competencia=' + mes);
    if (forcar) q.push('forcar=1');
    msg('bm-cal-info', 'Lendo o vencimento e o lote de cada condomínio...');
    try {
      est.cal = await pegar('/api/financeiro/boletos-mes/calendario' + (q.length ? '?' + q.join('&') : ''), function (j) { msg('bm-cal-info', j.detalhe || 'Lendo...'); });
      renderCal(est.cal);
    } catch (e) { msg('bm-cal-info', e.message, true); }
  }
  function renderCal(j) {
    var r = j.resumo || {};
    msg('bm-cal-info', r.condominios + ' condomínio(s): ' + r.atrasados + ' atrasado(s), ' + r.perto + ' perto do limite, ' + r.no_prazo + ' no prazo, ' + r.gerados + ' gerado(s)' + (r.gerados_em_cima ? ' (' + r.gerados_em_cima + ' em cima da hora)' : '') + '. ' + (j.regra || ''));
    var f = document.getElementById('bm-cal-filtro').value;
    var linhas = (j.linhas || []).filter(function (l) { return !f || (f === 'atencao' ? /^(atrasado|vencido_sem_lote|perto)$/.test(l.estado) : /^gerado/.test(l.estado)); });
    document.getElementById('bm-cal-lista').innerHTML = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><tr><th ' + TH + '>Condomínio</th><th ' + TH + '>Vencimento</th><th ' + TH + '>Lote pronto até</th><th ' + TH + '>Situação</th><th ' + TH + '></th></tr>'
      + linhas.map(function (l) {
        return '<tr><td ' + TD + '>' + esc(l.condominio) + (l.teste ? ' ' + selo('teste', 'var(--muted)') : '') + '</td><td ' + TD + '>' + esc(dataBR(l.vencimento) || '?') + (l.dia_vencimento ? ' <span class="hint">(dia ' + esc(l.dia_vencimento) + ')</span>' : '') + '</td><td ' + TD + '>' + esc(dataBR(l.limite)) + '</td><td ' + TD + '>'
          + selo(ROTULO_CAL[l.estado] || l.estado, COR[l.gravidade] || 'var(--muted)') + '</td><td ' + TD + '>' + esc(l.texto) + '</td></tr>';
      }).join('') + '</table></div>';
  }

  // ── 2. composição ──
  async function lerComposicao() {
    var c = cond(); if (!c) return semCond('bm-prep-info');
    var mes = mesEscolhido(); if (!mes) return msg('bm-prep-info', 'Escolha o mês do vencimento.', true);
    var seq = ++est.seq;
    msg('bm-prep-info', 'Lendo a composição de ' + c.nome + '...');
    try {
      var j = await pegar(base(c.id) + '/composicao?competencia=' + mes);
      if (seq !== est.seq) return;
      est.comp = { id: c.id, mes: mes, dados: j }; est.contas = j.contas || [];
      msg('bm-prep-info', (j.composicoes || []).length + ' item(ns) na composição de ' + mes.split('-').reverse().join('/') + '. ' + textoGravacao(j.gravacao) + ' ' + (j.aviso || ''));
      renderComposicao(j); renderForm(); renderNovos();
    } catch (e) { if (seq === est.seq) msg('bm-prep-info', e.message, true); }
  }
  function renderComposicao(j) {
    var hub = {}; (j.itens_do_hub || []).forEach(function (h) { hub[String(h.id_composicao)] = h; });
    var l = j.composicoes || [];
    document.getElementById('bm-comp').innerHTML = !l.length ? '<div class="hint">Nenhum item na composição deste mês.</div>' : '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><tr><th ' + TH + '>Item</th><th ' + TH + '>Conta</th><th ' + TH + '>Quem paga</th><th ' + TH + '>Valor</th><th ' + TH + '>Período</th><th ' + TH + '></th></tr>'
      + l.map(function (a) {
        var h = hub[a.id];
        return '<tr><td ' + TD + '>' + esc(a.nome) + (a.complemento ? ' <span class="hint">' + esc(a.complemento) + '</span>' : '') + (h ? ' ' + selo('criado pelo Hub', 'var(--accent)') : '') + '</td><td ' + TD + '>' + esc(a.conta) + '</td><td ' + TD + '>'
          + esc(a.quem === 'unidade' ? (a.unidade || 'uma unidade') : a.quem === 'grupo' ? 'um grupo' : 'todas') + '</td><td ' + TD + '>' + (a.fracao && !/nao usa|não usa/i.test(a.fracao) ? esc(a.fracao) : brl(a.valor)) + '</td><td ' + TD + '>'
          + esc(dataBR(a.inicio)) + (a.fim ? ' a ' + esc(dataBR(a.fim)) : ' em diante') + '</td><td ' + TD + '>' + (h && h.status !== 'excluido' ? '<button class="btn btn-ghost" data-excluir="' + esc(a.id) + '" style="font-size:11px">Excluir</button>' : '') + '</td></tr>';
      }).join('') + '</table></div>';
    document.querySelectorAll('#bm-comp [data-excluir]').forEach(function (b) { b.addEventListener('click', function () { excluir(b.getAttribute('data-excluir')); }); });
  }
  function renderForm() {
    var contas = est.contas.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.descricao) + '</option>'; }).join('');
    document.getElementById('bm-form').innerHTML = '<div style="border:1px solid var(--border);border-radius:var(--radius);padding:10px;margin:10px 0">'
      + '<div style="font-size:12px;font-weight:600;margin-bottom:6px">Novo item</div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">'
      + '<label style="font-size:12px">Tipo<br><select id="bm-f-tipo"><option value="taxa_extra">Taxa extra (todas as unidades)</option><option value="item_unidade">Item de uma unidade</option></select></label>'
      + '<label style="font-size:12px">Descrição<br><input id="bm-f-desc" maxlength="60" placeholder="Ex.: Pintura da fachada" style="width:200px"></label>'
      + '<label style="font-size:12px">Valor por mês<br><input id="bm-f-valor" inputmode="decimal" placeholder="0,00" style="width:100px"></label>'
      + '<label style="font-size:12px">Meses<br><input id="bm-f-meses" type="number" min="1" max="60" value="1" style="width:70px"></label>'
      + '<label style="font-size:12px">Conta de receita<br><input id="bm-f-conta" value="1.9" style="width:70px"></label>'
      + '<label style="font-size:12px">Conta bancária<br><select id="bm-f-cb">' + contas + '</select></label>'
      + '<label style="font-size:12px">Boleto<br><select id="bm-f-boleto"><option value="normal">Normal</option><option value="extra">Extra</option></select></label>'
      + '<label style="font-size:12px" id="bm-f-uni-l">Código da unidade<br><input id="bm-f-uni" inputmode="numeric" style="width:100px"></label>'
      + '<button class="btn btn-ghost" id="bm-f-add" style="font-size:12px">Incluir na lista</button></div>'
      + '<div class="hint" style="margin-top:6px">Meses acima de 1 viram parcelas (o boleto mostra a parcela). Rateio por fração ideal e mudança de valor da taxa continuam na tela do Superlógica.</div></div>';
    var tipo = document.getElementById('bm-f-tipo');
    var uni = function () { document.getElementById('bm-f-uni-l').style.display = tipo.value === 'item_unidade' ? '' : 'none'; };
    tipo.addEventListener('change', uni); uni();
    document.getElementById('bm-f-add').addEventListener('click', function () {
      var item = { tipo: tipo.value, complemento: document.getElementById('bm-f-desc').value.trim(), valor: document.getElementById('bm-f-valor').value.trim(), meses: Number(document.getElementById('bm-f-meses').value || 1),
        conta: document.getElementById('bm-f-conta').value.trim(), id_conta: document.getElementById('bm-f-cb').value, boleto: document.getElementById('bm-f-boleto').value };
      if (item.tipo === 'item_unidade') item.id_unidade = document.getElementById('bm-f-uni').value.trim();
      if (!item.complemento || !item.valor) return msg('bm-prep-info', 'Preencha a descrição e o valor.', true);
      est.itens.push(item); est.previa = null; renderNovos();
    });
  }
  function renderNovos() {
    var el = document.getElementById('bm-novos');
    if (!est.itens.length) { el.innerHTML = ''; return; }
    var p = est.previa;
    var avisos = p ? (p.avisos || []) : [];
    el.innerHTML = '<div style="font-size:12px;font-weight:600;margin:8px 0 4px">Itens para gravar (' + est.itens.length + ')</div><table style="width:100%;border-collapse:collapse">'
      + est.itens.map(function (i, k) {
        var av = avisos.filter(function (a) { return a.indice === k; });
        var txt = p && p.itens && p.itens[k] ? p.itens[k].texto : (i.complemento + ', ' + i.valor + (i.meses > 1 ? ', ' + i.meses + ' meses' : ''));
        return '<tr><td ' + TD + '>' + esc(txt) + av.map(function (a) { return '<div style="color:' + COR[a.gravidade] + ';font-size:11px">' + esc(a.texto) + '</div>'; }).join('') + '</td><td ' + TD + '><button class="btn btn-ghost" data-tirar="' + k + '" style="font-size:11px">Tirar</button></td></tr>';
      }).join('') + '</table><div style="margin-top:8px;display:flex;gap:8px"><button class="btn btn-ghost" id="bm-previa" style="font-size:12px">Conferir itens</button>'
      + '<button class="btn btn-primary" id="bm-gravar" style="font-size:12px"' + (p && p.pode_gravar ? '' : ' disabled') + '>Gravar na composição do Superlógica</button></div>'
      + '<div class="hint" style="margin-top:4px">' + (p ? (p.pode_gravar ? 'Conferido. ' + textoGravacao(p.gravacao) : 'Corrija os itens marcados antes de gravar.') : 'Confira os itens antes de gravar.') + '</div>';
    el.querySelectorAll('[data-tirar]').forEach(function (b) { b.addEventListener('click', function () { est.itens.splice(Number(b.getAttribute('data-tirar')), 1); est.previa = null; renderNovos(); }); });
    document.getElementById('bm-previa').addEventListener('click', previa);
    document.getElementById('bm-gravar').addEventListener('click', gravarItens);
  }
  async function previa() {
    if (!est.comp) return;
    try { est.previa = await enviar(base(est.comp.id) + '/composicao/previa', { competencia: est.comp.mes, itens: est.itens }); renderNovos(); }
    catch (e) { msg('bm-prep-info', e.message, true); }
  }
  async function gravarItens() {
    var c = cond(); if (!c || !est.comp || c.id !== est.comp.id) return msg('bm-prep-info', 'O condomínio do topo mudou. Leia a composição de novo.', true);
    var b = document.getElementById('bm-gravar'); b.disabled = true;
    try {
      var j = await gravar(base(c.id) + '/composicao/gravar', { competencia: est.comp.mes, itens: est.itens });
      var falhas = (j.resultados || []).filter(function (r) { return !r.ok || !r.conferido; });
      msg('bm-prep-info', j.detalhe + (falhas.length ? ' ' + falhas.map(function (r) { return r.texto + ': ' + (r.msg || (r.ok ? 'gravado sem prova' : 'não gravado')); }).join('; ') : ''), !j.ok);
      if (j.ok) { est.itens = []; est.previa = null; }
      await lerComposicao();
    } catch (e) { msg('bm-prep-info', e.message, true); b.disabled = false; }
  }
  async function excluir(idc) {
    var c = cond(); if (!c || !est.comp || c.id !== est.comp.id) return;
    try { var j = await gravar(base(c.id) + '/composicao/excluir', { competencia: est.comp.mes, id_composicao: idc }); msg('bm-prep-info', j.detalhe, !j.ok); await lerComposicao(); }
    catch (e) { msg('bm-prep-info', e.message, true); }
  }

  // ── 3. conferência antes de gerar ──
  var NOME_ALERTA = { prazo: 'Prazo', simulacao_vazia: 'Simulação vazia', valor_fora_padrao: 'Valor fora do padrão', valor_zerado: 'Valor zerado', sem_boleto: 'Unidade sem boleto', unidade_nova: 'Unidade nova', boleto_em_dobro: 'Boleto em dobro',
    leitura_faltando: 'Leitura faltando', leitura_zerada: 'Leitura zerada', consumo_fora: 'Consumo fora da composição', item_duplicado: 'Item duplicado', extra_fora_periodo: 'Taxa extra fora do período', extra_sem_fim: 'Taxa extra sem fim' };
  async function conferirAntes(forcar) {
    var c = cond(); if (!c) return semCond('bm-antes-info');
    var mes = mesEscolhido(); if (!mes) return msg('bm-antes-info', 'Escolha o mês do vencimento no card acima.', true);
    var seq = ++est.seq;
    msg('bm-antes-info', 'Conferindo ' + c.nome + '...'); document.getElementById('bm-antes-lista').innerHTML = '';
    try {
      var j = await pegar(base(c.id) + '/conferencia-antes?competencia=' + mes + (forcar ? '&forcar=1' : ''), function (x) { msg('bm-antes-info', x.detalhe || 'Lendo...'); });
      if (seq !== est.seq) return;
      var r = j.resumo || {};
      document.getElementById('bm-antes-info').innerHTML = (j.pode_gerar ? selo('Pode gerar', COR.ok) : selo('Não gere ainda', COR.alta)) + ' <span style="font-size:12px">' + esc(r.unidades_simuladas + ' unidade(s) simulada(s), total ' + brl(r.total_simulado) + '; ' + r.alertas + ' ponto(s), ' + r.graves + ' grave(s). Comparado com ' + (r.meses_comparados || []).join(', ') + (j.leitura_ref ? '; leituras de ' + j.leitura_ref : '') + '.') + '</span>';
      document.getElementById('bm-antes-lista').innerHTML = '<div style="font-size:12px;font-weight:600;margin:6px 0">O que conferir</div><ul style="margin:0 0 10px 18px;font-size:12px">' + (j.conferir || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
        + ((j.alertas || []).length ? '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><tr><th ' + TH + '>Unidade</th><th ' + TH + '>Ponto</th><th ' + TH + '>Detalhe</th></tr>' + j.alertas.map(function (a) {
          return '<tr><td ' + TD + '>' + esc(a.unidade) + '</td><td ' + TD + '>' + selo(NOME_ALERTA[a.tipo] || a.tipo, COR[a.gravidade] || COR.baixa) + '</td><td ' + TD + '>' + esc(a.texto) + '</td></tr>';
        }).join('') + '</table></div>' : '');
    } catch (e) { if (seq === est.seq) msg('bm-antes-info', e.message, true); }
  }

  // ── 4. depois de gerar ──
  function conferirDepois() {
    var mes = mesEscolhido(); var alvo = document.getElementById('fin-bol-mes');
    if (alvo && mes) alvo.value = mes;
    if (typeof window.finBoletosConferir === 'function') window.finBoletosConferir();
    var l = document.getElementById('fin-bol-lista'); if (l && l.scrollIntoView) l.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function remessa() {
    var c = cond(); if (!c) return semCond('bm-rem-info');
    msg('bm-rem-info', 'Lendo as remessas pendentes...');
    try {
      var j = await pegar(base(c.id) + '/remessa');
      msg('bm-rem-info', ((j.pendentes || []).length ? '' : 'Nenhum boleto marcado para remessa agora. ') + textoGravacao(j.gravacao) + ' ' + (j.aviso || ''));
      var contas = (j.pendentes || []).length ? j.pendentes : [];
      document.getElementById('bm-rem-lista').innerHTML = contas.map(function (p) {
        return '<div style="display:flex;gap:8px;align-items:center;margin:6px 0"><span style="font-size:12px">' + esc(p.conta || ('Conta ' + p.id_conta)) + ': ' + esc(p.quantidade) + ' boleto(s) marcado(s)</span>'
          + (j.gravacao && j.gravacao.liberada ? '<button class="btn btn-primary" data-conta="' + esc(p.id_conta) + '" style="font-size:11px">Gerar arquivo de remessa</button>' : '') + '</div>';
      }).join('');
      document.querySelectorAll('#bm-rem-lista [data-conta]').forEach(function (b) { b.addEventListener('click', function () { gerarRemessa(c, b.getAttribute('data-conta'), b); }); });
    } catch (e) { msg('bm-rem-info', e.message, true); }
  }
  async function gerarRemessa(c, conta, b) {
    b.disabled = true;
    try {
      var j = await gravar(base(c.id) + '/remessa/gerar', { id_conta: conta });
      if (j.arquivo) {
        var blob = new Blob([j.arquivo], { type: 'text/plain' });
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = j.nome || 'remessa.rem'; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      }
      var link = linkSeguro(j.link);
      document.getElementById('bm-rem-info').innerHTML = '<div style="font-size:12px">' + esc(j.detalhe || '') + (j.formato ? ' (' + esc(j.formato) + ', ' + esc(j.linhas) + ' linhas)' : '') + (link ? ' <a href="' + esc(link) + '" target="_blank" rel="noopener">Abrir no Superlógica</a>' : '') + '</div>';
    } catch (e) { msg('bm-rem-info', e.message, true); b.disabled = false; }
  }

  // ── 5. régua ──
  async function regua() {
    var c = cond(); if (!c) return semCond('bm-regua-info');
    msg('bm-regua-info', 'Lendo a régua de ' + c.nome + '...');
    try {
      var j = await pegar(base(c.id) + '/regua');
      var at = j.atual || {};
      document.getElementById('bm-regua-info').innerHTML = (at.desativada ? selo('Desativada', COR.alta) + ' <span style="font-size:12px">' + esc(at.causa) + '</span><br>' : '')
        + '<span style="font-size:12px">' + esc((j.retorno_automatico || {}).texto || '') + '</span>';
      document.getElementById('bm-regua-lista').innerHTML = '<table style="width:100%;border-collapse:collapse;margin:6px 0"><tr><th ' + TH + '>Envio</th><th ' + TH + '>Situação</th><th ' + TH + '>Quando</th></tr>'
        + (at.envios || []).map(function (e) { return '<tr><td ' + TD + '>' + esc(e.envio) + '</td><td ' + TD + '>' + (e.ligado ? selo('Ligado', COR.ok) : selo('Desligado', COR.baixa)) + '</td><td ' + TD + '>' + esc(e.ligado ? e.quando : '') + '</td></tr>'; }).join('') + '</table>'
        + '<div style="font-size:12px;margin:6px 0"><b>Padrão:</b> ' + esc((j.padrao || {}).texto || '') + '</div>'
        + ((j.padrao || {}).ja_no_padrao ? '<div class="hint">A régua já está no padrão.</div>'
          : '<div class="hint">' + esc(textoGravacao(j.gravacao)) + '</div>' + (j.gravacao && j.gravacao.liberada ? '<button class="btn btn-primary" id="bm-regua-aplicar" style="font-size:12px;margin-top:6px">Aplicar o padrão</button>' : ''));
      var b = document.getElementById('bm-regua-aplicar');
      if (b) b.addEventListener('click', async function () {
        b.disabled = true;
        try { var r = await gravar(base(c.id) + '/regua/aplicar', {}); msg('bm-regua-info', r.detalhe, !r.ok); await regua(); } catch (e) { msg('bm-regua-info', e.message, true); b.disabled = false; }
      });
    } catch (e) { msg('bm-regua-info', e.message, true); }
  }

  // ── 6. trocas da forma de recebimento ──
  async function pjbank(forcar) {
    var c = cond(); if (!c) return semCond('bm-pj-info');
    msg('bm-pj-info', 'Lendo a auditoria de ' + c.nome + '...'); document.getElementById('bm-pj-lista').innerHTML = '';
    try {
      var j = await pegar(base(c.id) + '/pjbank' + (forcar ? '?forcar=1' : ''), function (x) { msg('bm-pj-info', x.detalhe || 'Lendo...'); });
      document.getElementById('bm-pj-info').innerHTML = (j.todo_mes ? selo('Troca todo mês', COR.alta) + ' ' : j.trocas ? selo('Houve troca', COR.media) + ' ' : '') + '<span style="font-size:12px">' + esc(j.texto) + ((j.falhas || []).length ? ' Não deu para ler: ' + esc(j.falhas.join(', ')) + '.' : '') + '</span>';
      var ev = (j.eventos || []).filter(function (e) { return e.tipo === 'estado'; });
      document.getElementById('bm-pj-lista').innerHTML = ev.length ? '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><tr><th ' + TH + '>Quando</th><th ' + TH + '>Quem</th><th ' + TH + '>Forma</th><th ' + TH + '>De</th><th ' + TH + '>Para</th></tr>'
        + ev.map(function (e) { return '<tr><td ' + TD + '>' + esc(dataBR(e.quando) + ' ' + e.quando.slice(11)) + '</td><td ' + TD + '>' + esc(e.quem) + '</td><td ' + TD + '>' + esc(e.forma + ' ' + (e.descricao || '')) + (e.pjbank ? ' ' + selo('PJBank', 'var(--accent)') : '') + '</td><td ' + TD + '>' + esc(e.de) + '</td><td ' + TD + '>' + esc(e.para) + '</td></tr>'; }).join('') + '</table></div>' : '';
    } catch (e) { msg('bm-pj-info', e.message, true); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar); else montar();
})();
