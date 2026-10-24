// ============================================================
// CONCILIAÇÃO DO DIA (dentro do item Conciliação): o resumo por condomínio e por analista, a entrada
// dos extratos OFX (várias contas de uma vez), a fila "para conferir" com aceitar, corrigir e
// ignorar, e o botão "Gravar no Superlógica" (pela política de gravação, confirmar-gravacao.js).
// O cartão é montado aqui mesmo, no topo do painel da Conciliação.
// Rotas em financeiro/conciliacao-auto-rotas.js.
// ============================================================
(function () {
  'use strict';
  var est = { resumo: null, cond: null, detalhe: null, seq: 0 };
  var API = '/api/financeiro/conciliacao-dia';

  // A ação "gravar" do módulo Conciliação aparece na tela de permissões.
  try { if (typeof MODULOS_CATALOGO !== 'undefined' && MODULOS_CATALOGO.conciliacao && MODULOS_CATALOGO.conciliacao.acoes.indexOf('gravar') < 0) MODULOS_CATALOGO.conciliacao.acoes.push('gravar'); } catch (e) { /* tela sem o catálogo */ }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function brlC(c) { return (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function horaBR(iso) { var d = new Date(iso); return iso && !isNaN(d) ? d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''; }
  var TH = 'style="text-align:left;padding:6px 8px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border2);white-space:normal"';
  var TD = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid var(--border);vertical-align:top"';
  function td(h) { return '<td ' + TD + '>' + h + '</td>'; }
  function tabela(cab, linhas) { return '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>' + cab.map(function (c) { return '<th ' + TH + '>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + linhas.join('') + '</tbody></table></div>'; }
  function msg(id, texto, erro) { var el = document.getElementById(id); if (el) el.innerHTML = texto ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : ''; }
  async function json(r) { return r.json().catch(function () { return {}; }); }
  function carteira() { var s = document.getElementById('conc-carteira'); return s ? s.value : ''; }

  function montar() {
    var painel = document.getElementById('panel-conciliacao');
    if (!painel || document.getElementById('cdia-card')) return;
    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'cdia-card';
    card.innerHTML = '<div class="card-header"><span class="card-title">Conciliação do dia</span></div>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<button class="btn btn-primary" id="cdia-carregar">Carregar</button>'
      + '<label class="btn btn-ghost" style="cursor:pointer">Escolher extratos OFX<input type="file" id="cdia-arquivos" accept=".ofx,.OFX" multiple style="display:none"></label>'
      + '<button class="btn btn-ghost" id="cdia-enviar">Enviar extratos</button>'
      + '<button class="btn btn-ghost" id="cdia-banco" style="display:none">Puxar do banco</button></div>'
      + '<div class="hint" style="margin:10px 0 8px">Mande os OFX de várias contas de uma vez: o Hub reconhece a conta pelo banco, agência e conta do arquivo e prepara só os dias que ainda não estão no Superlógica (nunca o dia de hoje, que ainda muda). Depois concilia por regras e deixa aqui só o que precisa de conferência. Usa a carteira escolhida logo abaixo, em Conciliação da carteira.</div>'
      + '<div id="cdia-info" class="ficha-sub" style="margin-bottom:8px"></div><div id="cdia-arq-res"></div>'
      + '<div id="cdia-analistas"></div><div id="cdia-lista"></div>';
    painel.insertBefore(card, painel.firstChild);
    var det = document.createElement('div');
    det.className = 'card';
    det.id = 'cdia-detalhe';
    det.style.display = 'none';
    painel.insertBefore(det, card.nextSibling);
    document.getElementById('cdia-carregar').addEventListener('click', function () { carregar(); });
    document.getElementById('cdia-enviar').addEventListener('click', enviarArquivos);
    document.getElementById('cdia-banco').addEventListener('click', puxarBanco);
    document.getElementById('cdia-arquivos').addEventListener('change', function (ev) { var n = ev.target.files.length; msg('cdia-info', n ? n + ' arquivo(s) escolhido(s). Clique em Enviar extratos.' : ''); });
  }

  // ── resumo ──────────────────────────────────────────────────
  async function carregar() {
    var seq = ++est.seq;
    msg('cdia-info', 'Carregando...');
    var r = await apiAuthFetch(API + '/resumo' + (carteira() ? '?carteira=' + encodeURIComponent(carteira()) : ''));
    var j = await json(r);
    if (seq !== est.seq) return;
    if (!r.ok) { msg('cdia-info', j.detalhe || 'Falha ' + r.status, true); return; }
    est.resumo = j;
    document.getElementById('cdia-banco').style.display = j.banco && j.banco.ligado && j.pode_gravar ? '' : 'none';
    msg('cdia-info', (j.condominios || []).length + ' condomínio(s).' + (j.dia_avisos ? ' Avisos de ' + dataBR(j.dia_avisos) + '.' : '') + (j.politica === 'teste' ? ' Por enquanto a gravação no Superlógica só vale nos condomínios de teste.' : ''));
    renderAnalistas(j.por_analista || []);
    renderLista(j);
  }
  function renderAnalistas(l) {
    var el = document.getElementById('cdia-analistas');
    if (!l.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="card-title" style="font-size:14px;margin:6px 0">Por analista</div>' + tabela(['Analista', 'Carteira', 'Condomínios com aviso', 'Contas sem extrato', 'Linhas sem conciliar', 'Sem confirmação'], l.map(function (a) {
      return '<tr>' + td('<b>' + esc(a.analista) + '</b>') + td(esc(a.carteira)) + td(a.condominios) + td(a.sem_extrato ? '<b style="color:var(--warning)">' + a.sem_extrato + '</b>' : '0') + td(a.linhas ? '<b style="color:var(--warning)">' + a.linhas + '</b>' : '0') + td(a.incertos ? '<b style="color:var(--danger)">' + a.incertos + '</b>' : '0') + '</tr>';
    }));
  }
  function textoExtrato(c) {
    var sem = (c.contas || []).filter(function (k) { return k.situacao !== 'ok' || (k.dias_sem_extrato || 0) >= 2; });
    if (!c.contas || !c.contas.length) return '<span style="color:var(--muted)">ainda não conciliado</span>';
    if (!sem.length) return '<span style="color:var(--success)">em dia</span>';
    return sem.slice(0, 3).map(function (k) { return esc(k.descricao) + ': ' + (k.ultimo_extrato ? 'desde ' + dataBR(k.ultimo_extrato) : 'sem extrato no período'); }).join('<br>') + (sem.length > 3 ? '<br>e mais ' + (sem.length - 3) : '');
  }
  function renderLista(j) {
    var el = document.getElementById('cdia-lista');
    var l = j.condominios || [];
    var avisos = {};
    (j.avisos || []).forEach(function (a) { (avisos[a.id_condominio] = avisos[a.id_condominio] || []).push(a); });
    if (!l.length) { el.innerHTML = '<div class="hint">Nenhum condomínio conciliado ainda nesta carteira. Envie os extratos ou abra um condomínio e clique em Conciliar agora.</div>'; return; }
    el.innerHTML = '<div class="card-title" style="font-size:14px;margin:10px 0 6px">Por condomínio</div>' + tabela(['Condomínio', 'Extrato importado', 'Pronto para gravar', 'Para conferir', 'Última conciliação', ''], l.map(function (c) {
      var pronto = (c.extratos_prontos ? c.extratos_prontos + ' extrato(s), ' + c.linhas_prontas + ' linha(s)' : '') + (c.lancamentos_prontos ? (c.extratos_prontos ? '<br>' : '') + c.lancamentos_prontos + ' lançamento(s), ' + brlC(c.valor_prontos) : '');
      var conf = (c.fila ? '<b style="color:var(--warning)">' + c.fila + '</b>' : '0') + (c.incertos ? '<br><span style="color:var(--danger)">' + c.incertos + ' sem confirmação</span>' : '');
      return '<tr>' + td('<b>' + esc(c.condominio || 'Condomínio ' + c.id_condominio) + '</b><br><span style="font-size:11px;color:var(--muted)">' + esc([c.id_condominio, c.analista].filter(Boolean).join(' · ')) + '</span>')
        + td(textoExtrato(c)) + td(pronto || '<span style="color:var(--muted)">nada</span>') + td(conf) + td(esc(horaBR(c.ultima_conciliacao)))
        + td('<button class="btn btn-ghost" style="font-size:12px;padding:4px 10px" data-abrir="' + esc(c.id_condominio) + '">Abrir</button>') + '</tr>';
    }));
    el.querySelectorAll('[data-abrir]').forEach(function (b) { b.addEventListener('click', function () { abrir(b.getAttribute('data-abrir')); }); });
  }

  // ── extratos ────────────────────────────────────────────────
  function lerArquivo(arq) {
    return new Promise(function (ok, falha) {
      var fr = new FileReader();
      fr.onerror = function () { falha(new Error('Não foi possível ler ' + arq.name + '.')); };
      fr.onload = function () {
        var buf = fr.result;
        var cab = new TextDecoder('windows-1252').decode(buf.slice(0, 600));
        var utf8 = /ENCODING:\s*UTF-?8|encoding="utf-?8"|CHARSET:\s*(UTF-?8|65001)/i.test(cab);
        ok(new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(buf));
      };
      fr.readAsArrayBuffer(arq);
    });
  }
  var SITUACAO_ARQ = {
    planejada: 'pronto para gravar', nada_novo: 'nada novo (o Superlógica já tem esses dias)', arquivo_invalido: 'arquivo inválido', vazio: 'sem movimentos',
    nao_encontrada: 'conta não reconhecida', ambigua: 'conta repetida na carteira', sem_conta_no_arquivo: 'arquivo sem o número da conta', periodo_grande: 'período grande demais', falha: 'falhou', leitura_descartada: 'leitura descartada',
  };
  async function enviarArquivos() {
    var inp = document.getElementById('cdia-arquivos');
    var l = Array.prototype.slice.call(inp.files || []);
    if (!l.length) { msg('cdia-info', 'Escolha os arquivos OFX primeiro.', true); return; }
    if (l.length > 20) { msg('cdia-info', 'Envie até 20 arquivos de uma vez.', true); return; }
    if (l.some(function (a) { return a.size > 5 * 1024 * 1024; })) { msg('cdia-info', 'Cada arquivo pode ter até 5 MB.', true); return; }
    msg('cdia-info', 'Lendo os arquivos e o que já está importado em cada conta...');
    var arquivos;
    try { arquivos = await Promise.all(l.map(async function (a) { return { nome: a.name, texto: await lerArquivo(a) }; })); } catch (e) { msg('cdia-info', e.message, true); return; }
    var r = await apiAuthFetch(API + '/extratos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arquivos: arquivos }) });
    var j = await json(r);
    if (!r.ok) { msg('cdia-info', j.detalhe || 'Falha ' + r.status, true); return; }
    inp.value = '';
    renderArquivos(j.arquivos || []);
    msg('cdia-info', 'Arquivos lidos. Abra o condomínio, clique em Conciliar agora e confira antes de gravar.');
    carregar();
  }
  function renderArquivos(l) {
    document.getElementById('cdia-arq-res').innerHTML = tabela(['Arquivo', 'Conta', 'Situação', 'Dias novos', 'Já estavam', 'Fora (dia já importado)', 'Hoje ou depois'], l.map(function (a) {
      var conta = a.conta ? esc(a.conta.descricao) + (a.conta.final ? ' final ' + esc(a.conta.final) : '') + '<br><span style="font-size:11px;color:var(--muted)">condomínio ' + esc(a.conta.id_condominio) + '</span>' : (a.final_arquivo ? 'final ' + esc(a.final_arquivo) : '');
      var cor = a.situacao === 'planejada' ? 'var(--success)' : (a.situacao === 'nada_novo' ? 'var(--muted)' : 'var(--danger)');
      return '<tr>' + td(esc(a.arquivo)) + td(conta) + td('<b style="color:' + cor + '">' + esc(SITUACAO_ARQ[a.situacao] || a.situacao) + '</b>' + (a.detalhe ? '<br><span style="font-size:11px;color:var(--muted)">' + esc(a.detalhe) + '</span>' : ''))
        + td(a.a_importar ? a.a_importar + ' linha(s), ' + dataBR(a.inicio) + ' a ' + dataBR(a.fim) : '0') + td(a.ja_importados || 0) + td(a.faltando_no_superlogica ? '<b style="color:var(--warning)">' + a.faltando_no_superlogica + '</b>' : '0') + td(a.dias_abertos || 0) + '</tr>';
    }));
  }
  async function puxarBanco() {
    if (!carteira()) { msg('cdia-info', 'Escolha uma carteira para puxar do banco.', true); return; }
    msg('cdia-info', 'Puxando os extratos no banco...');
    var r = await apiAuthFetch(API + '/banco', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ carteira: carteira() }) });
    var j = await json(r);
    if (!r.ok) { msg('cdia-info', j.detalhe || 'Falha ' + r.status, true); return; }
    if (!j.ligado) { msg('cdia-info', j.detalhe || 'O conector do banco está desligado.', true); return; }
    renderArquivos((j.contas || []).map(function (c) { return Object.assign({ arquivo: 'Banco' }, c); }));
    carregar();
  }

  // ── condomínio ──────────────────────────────────────────────
  async function abrir(id) {
    est.cond = id;
    var el = document.getElementById('cdia-detalhe');
    el.style.display = '';
    el.innerHTML = '<div class="hint">Carregando...</div>';
    var r = await apiAuthFetch(API + '/condominio/' + encodeURIComponent(id));
    var j = await json(r);
    if (est.cond !== id) return;
    if (!r.ok) { el.innerHTML = '<div class="hint" style="color:var(--danger)">' + esc(j.detalhe || 'Falha ' + r.status) + '</div>'; return; }
    est.detalhe = j;
    renderDetalhe(j);
    if (j.trabalho && j.trabalho.estado === 'rodando') acompanhar(j.trabalho.id);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  var ST = { planejada: 'pronto', planejado: 'pronto', gravando: 'gravando', gravada: 'gravado', gravado: 'gravado', incerta: 'sem confirmação', incerto: 'sem confirmação', recusada: 'recusado', recusado: 'recusado', falhou: 'não enviado', cancelada: 'substituído', cancelado: 'cancelado' };
  var TIPO_L = { despesa: 'Despesa já paga', transferencia: 'Transferência', movimentacao: 'Movimentação direta' };
  var REGRA = { tarifa: 'tarifa bancária', ir: 'IR de rendimento', rendimento: 'rendimento', cesan: 'CESAN', edp: 'EDP', transferencia: 'transferência entre contas', aprendida: 'regra ensinada', corrigido: 'corrigido na fila' };
  function corSt(s) { return /gravad/.test(s) ? 'var(--success)' : (/incert|recusad|falhou|gravando/.test(s) ? 'var(--danger)' : 'var(--text)'); }
  function renderDetalhe(j) {
    var el = document.getElementById('cdia-detalhe');
    var prontos = j.importacoes.filter(function (x) { return x.status === 'planejada'; }).length + j.lancamentos.filter(function (x) { return x.status === 'planejado'; }).length;
    var pol = j.gravacao_politica;
    var podeG = j.pode_gravar && pol !== 'bloqueado' && prontos > 0;
    var aviso = pol === 'bloqueado' ? 'Por enquanto o Hub só grava no Superlógica nos condomínios de teste. Neste, faça pelo Superlógica e marque como conferido.' : (pol === 'livre' ? 'Condomínio de teste: grava sem pedir confirmação.' : 'O Hub mostra o resumo e pede sua confirmação antes de gravar.');
    var fila = j.fila.filter(function (x) { return x.status === 'pendente'; });
    var h = '<div class="card-header"><span class="card-title">' + esc(j.condominio || 'Condomínio ' + j.id_condominio) + '</span></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">'
      + '<button class="btn btn-ghost" id="cdia-conciliar">Conciliar agora</button>'
      + '<button class="btn btn-primary" id="cdia-gravar"' + (podeG ? '' : ' disabled') + '>Gravar no Superlógica' + (prontos ? ' (' + prontos + ')' : '') + '</button>'
      + '<span class="hint">' + esc(aviso) + '</span></div><div id="cdia-det-info" class="ficha-sub" style="margin-bottom:8px">' + (j.estado && j.estado.ultima_conciliacao ? 'Última conciliação ' + esc(horaBR(j.estado.ultima_conciliacao)) + (j.estado.resumo ? ': ' + j.estado.resumo.conciliadas + ' linha(s) casadas com o que já estava lançado' + (j.estado.resumo.aguardando_fim_do_mes ? ', ' + j.estado.resumo.aguardando_fim_do_mes + ' de rendimento aguardando o fim do mês' : '') + '.' : '') : 'Ainda não conciliado. Clique em Conciliar agora.') + '</div>';
    if (j.estado && j.estado.resumo && j.estado.resumo.contas) {
      h += tabela(['Conta', 'Último extrato no Superlógica', 'Dias úteis sem extrato'], j.estado.resumo.contas.map(function (k) {
        return '<tr>' + td(esc(k.descricao)) + td(k.quadro && k.quadro.ultimo_extrato ? dataBR(k.quadro.ultimo_extrato) : '<span style="color:var(--warning)">sem extrato no período</span>') + td(k.quadro && k.quadro.dias_sem_extrato != null ? k.quadro.dias_sem_extrato : '') + '</tr>';
      }));
    }
    if (j.importacoes.length) {
      h += '<div class="card-title" style="font-size:14px;margin:12px 0 6px">Extratos</div>' + tabela(['Conta', 'Período', 'Linhas', 'Situação', 'Detalhe'], j.importacoes.map(function (x) {
        var r = x.detalhe && x.detalhe.resultado;
        return '<tr>' + td(esc(x.conta || x.id_conta)) + td(dataBR(x.inicio) + ' a ' + dataBR(x.fim)) + td(x.quantidade) + td('<b style="color:' + corSt(x.status) + '">' + esc(ST[x.status] || x.status) + '</b>') + td(esc((r && r.msg) || (x.detalhe && x.detalhe.arquivo) || '')) + '</tr>';
      }));
    }
    if (j.lancamentos.length) {
      h += '<div class="card-title" style="font-size:14px;margin:12px 0 6px">Lançamentos pelas regras</div>' + tabela(['Data', 'Tipo', 'Valor', 'Conta', 'Regra', 'Situação'], j.lancamentos.map(function (x) {
        var d = x.dados || {};
        var conta = esc(d.conta || d.id_conta) + (x.tipo === 'transferencia' ? ' para ' + esc(d.conta_destino || d.id_conta_destino) : '') + (d.conta_contabil ? '<br><span style="font-size:11px;color:var(--muted)">' + esc(d.conta_contabil + (d.fornecedor ? ' · ' + d.fornecedor : '')) + '</span>' : '');
        var r = x.resultado || {};
        return '<tr>' + td(dataBR(d.data)) + td(esc(TIPO_L[x.tipo] || x.tipo) + '<br><span style="font-size:11px;color:var(--muted)">' + esc(d.descricao || '') + '</span>') + td(brlC(x.valor_centavos)) + td(conta) + td(esc(REGRA[x.regra] || x.regra || ''))
          + td('<b style="color:' + corSt(x.status) + '">' + esc(ST[x.status] || x.status) + '</b>' + (r.msg && x.status !== 'gravado' ? '<br><span style="font-size:11px;color:var(--muted)">' + esc(r.msg) + '</span>' : '') + (x.status === 'gravado' && !r.conferido ? '<br><span style="font-size:11px;color:var(--warning)">gravado, releitura sem prova</span>' : '')) + '</tr>';
      }));
    }
    h += '<div class="card-title" style="font-size:14px;margin:12px 0 6px">Para conferir (' + fila.length + ')</div>';
    h += fila.length ? tabela(['Data', 'Conta', 'Valor', 'No banco', 'Motivo e sugestão', ''], fila.map(function (f) {
      var s = f.sugestao || {};
      var bts = (s.pode_aceitar && j.pode_gravar ? '<button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" data-aceitar="' + esc(f.chave) + '">' + (s.acao === 'conferir' ? 'Conferido' : 'Aceitar') + '</button> ' : '')
        + (s.corrigir && j.pode_gravar ? '<button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" data-corrigir="' + esc(f.chave) + '">Corrigir</button> ' : '')
        + (j.pode_gravar ? '<button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" data-ignorar="' + esc(f.chave) + '">Ignorar</button>' : '');
      return '<tr>' + td(dataBR(f.data)) + td(esc(f.conta || '')) + td('<span style="color:' + (f.valor_centavos < 0 ? 'var(--danger)' : 'var(--success)') + '">' + brlC(f.valor_centavos) + '</span>') + td(esc(f.descricao || ''))
        + td(esc(f.motivo || '') + (s.texto ? '<br><span style="font-size:11px;color:var(--muted)">' + esc(s.texto) + '</span>' : '')) + td('<div style="white-space:nowrap">' + bts + '</div><div id="cdia-f-' + esc(f.chave) + '"></div>') + '</tr>';
    })) : '<div class="hint">Nada para conferir.</div>';
    var decididos = j.fila.filter(function (x) { return x.status !== 'pendente'; });
    if (decididos.length) h += '<details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Decididos nos últimos 7 dias (' + decididos.length + ')</summary>' + tabela(['Data', 'Valor', 'No banco', 'Decisão', 'Quem'], decididos.map(function (f) {
      return '<tr>' + td(dataBR(f.data)) + td(brlC(f.valor_centavos)) + td(esc(f.descricao || '')) + td(esc({ conferido: 'conferido', corrigido: 'corrigido', ignorado: 'ignorado', resolvido: 'resolvido no Superlógica', aceito: 'aceito' }[f.status] || f.status)) + td(esc(f.decidido_por_email || '')) + '</tr>';
    })) + '</details>';
    h += '<div id="cdia-trab" style="margin-top:10px"></div>';
    el.innerHTML = h;
    el.querySelector('#cdia-conciliar').addEventListener('click', conciliar);
    el.querySelector('#cdia-gravar').addEventListener('click', gravar);
    el.querySelectorAll('[data-aceitar]').forEach(function (b) { b.addEventListener('click', function () { decidir(b.getAttribute('data-aceitar'), { acao: 'aceitar' }); }); });
    el.querySelectorAll('[data-ignorar]').forEach(function (b) { b.addEventListener('click', function () { formIgnorar(b.getAttribute('data-ignorar')); }); });
    el.querySelectorAll('[data-corrigir]').forEach(function (b) { b.addEventListener('click', function () { formCorrigir(b.getAttribute('data-corrigir')); }); });
  }
  function item(chave) { return (est.detalhe.fila || []).filter(function (x) { return x.chave === chave; })[0]; }
  function formIgnorar(chave) {
    var box = document.getElementById('cdia-f-' + chave);
    box.innerHTML = '<div style="margin-top:6px;display:grid;gap:4px"><input type="text" maxlength="200" placeholder="Motivo (opcional)" id="cdia-ign-m"><label style="font-size:11px"><input type="checkbox" id="cdia-ign-l"> ignorar sempre esse tipo de linha neste condomínio</label><button class="btn btn-ghost" style="font-size:11px" id="cdia-ign-ok">Confirmar ignorar</button></div>';
    box.querySelector('#cdia-ign-ok').addEventListener('click', function () { decidir(chave, { acao: 'ignorar', motivo: box.querySelector('#cdia-ign-m').value, lembrar: box.querySelector('#cdia-ign-l').checked }); });
  }
  function formCorrigir(chave) {
    var f = item(chave); if (!f) return;
    var s = f.sugestao || {};
    var box = document.getElementById('cdia-f-' + chave);
    if (s.corrigir === 'transferencia') {
      var opts = (s.contas || (est.detalhe.contas || []).filter(function (c) { return String(c.id) !== String(f.id_conta); })).map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.descricao) + '</option>'; }).join('');
      box.innerHTML = '<div style="margin-top:6px;display:grid;gap:4px"><label style="font-size:11px">' + (f.valor_centavos < 0 ? 'Saiu desta conta para' : 'Entrou nesta conta vindo de') + '</label><select id="cdia-c-dest">' + opts + '</select><button class="btn btn-ghost" style="font-size:11px" id="cdia-c-ok">Preparar transferência</button></div>';
      box.querySelector('#cdia-c-ok').addEventListener('click', function () { decidir(chave, { acao: 'corrigir', tipo: 'transferencia', id_conta_destino: box.querySelector('#cdia-c-dest').value }); });
      return;
    }
    box.innerHTML = '<div style="margin-top:6px;display:grid;gap:4px"><input type="text" placeholder="Conta contábil (ex.: 2.2.1)" id="cdia-c-conta"><input type="text" inputmode="numeric" placeholder="Código do fornecedor no Superlógica" id="cdia-c-forn"><label style="font-size:11px"><input type="checkbox" id="cdia-c-l" checked> usar nas próximas (o Hub lança sozinho essa linha nos próximos dias)</label><button class="btn btn-ghost" style="font-size:11px" id="cdia-c-ok">Preparar lançamento</button></div>';
    box.querySelector('#cdia-c-ok').addEventListener('click', function () { decidir(chave, { acao: 'corrigir', tipo: 'despesa', conta_contabil: box.querySelector('#cdia-c-conta').value.trim(), id_fornecedor: box.querySelector('#cdia-c-forn').value.trim(), lembrar: box.querySelector('#cdia-c-l').checked }); });
  }
  async function decidir(chave, corpo) {
    var id = est.cond;
    var r = await apiAuthFetch(API + '/condominio/' + encodeURIComponent(id) + '/fila/' + encodeURIComponent(chave), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    var j = await json(r);
    if (!r.ok) { var box = document.getElementById('cdia-f-' + chave); if (box) box.innerHTML = '<div style="font-size:11px;color:var(--danger)">' + esc(j.detalhe || 'Falha ' + r.status) + '</div>'; return; }
    abrir(id);
  }
  async function conciliar() {
    var id = est.cond;
    msg('cdia-det-info', 'Lendo os extratos e as despesas no Superlógica e aplicando as regras...');
    for (var t = 0; t < 40; t++) {
      var r = await apiAuthFetch(API + '/condominio/' + encodeURIComponent(id) + '/conciliar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      var j = await json(r);
      if (est.cond !== id) return;
      if (r.status === 202) { await new Promise(function (ok) { setTimeout(ok, 4000); }); continue; }
      if (!r.ok) { msg('cdia-det-info', j.detalhe || 'Falha ' + r.status, true); return; }
      abrir(id);
      return;
    }
    msg('cdia-det-info', 'A leitura está demorando. Tente de novo em alguns minutos.', true);
  }
  async function gravar() {
    var id = est.cond;
    var b = document.getElementById('cdia-gravar');
    b.disabled = true;
    var r = await window.gravarNoSuperlogica(API + '/condominio/' + encodeURIComponent(id) + '/gravar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    var j = await json(r);
    if (r.status === 499) { b.disabled = false; return; }
    if (!r.ok) { msg('cdia-det-info', j.detalhe || 'Falha ' + r.status, true); b.disabled = false; return; }
    if (j.nada) { msg('cdia-det-info', j.detalhe); return; }
    acompanhar(j.trabalho);
  }
  async function acompanhar(idT) {
    var id = est.cond;
    for (var t = 0; t < 300; t++) {
      var r = await apiAuthFetch(API + '/trabalho/' + encodeURIComponent(idT));
      var j = await json(r);
      if (est.cond !== id) return;
      var el = document.getElementById('cdia-trab');
      if (!r.ok) { if (el) el.innerHTML = '<div class="hint" style="color:var(--danger)">' + esc(j.detalhe || 'Falha ' + r.status) + '</div>'; return; }
      if (el) el.innerHTML = '<div class="hint">' + (j.estado === 'rodando' ? 'Gravando no Superlógica: ' + j.feitos + ' de ' + j.total + '...' : 'Gravação terminada: ' + (j.totais ? j.totais.gravados + ' gravado(s), ' + j.totais.incertos + ' sem confirmação, ' + (j.totais.recusados + j.totais.falhas) + ' não gravado(s).' : '')) + '</div>';
      if (j.estado !== 'rodando') { setTimeout(function () { if (est.cond === id) abrir(id); }, 1500); return; }
      await new Promise(function (ok) { setTimeout(ok, 3000); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar); else montar();
  window.ConciliacaoDia = { carregar: carregar, abrir: abrir };
})();
