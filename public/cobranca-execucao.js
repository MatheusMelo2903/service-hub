// ============================================================
// EXECUÇÃO DA COBRANÇA (dentro da aba Cobrança): acordo à vista e desfazer acordo, contato no
// CRM do Superlógica, correção do status financeiro (régua), atualização cadastral, relatório de
// inadimplência para o síndico e para o escritório, e a política de acordo de cada condomínio.
// O servidor confere tudo de novo (servico/rotas-cobranca-execucao.js); toda gravação no
// Superlógica passa pela janela de confirmação (confirmar-gravacao.js). Nenhuma mensagem sai
// daqui para condôminos.
// ============================================================
(function () {
  'use strict';
  var E = { aba: 'acordo', id: null, unidades: [], seqUni: 0 };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function isoDias(n) { var d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function pode(acao) { return window.USER_ROLE === 'GESTOR' || (typeof temPermissao === 'function' && !!window.USER_PERMS && temPermissao('cobranca', acao)); }
  function podeGestao(acao) { return pode(acao) || window.USER_ROLE === 'GERENTE'; }
  var base = function () { return '/api/cobranca/condominio/' + encodeURIComponent(E.id); };
  // gravar: true quando a chamada grava no Superlógica (janela de confirmação).
  async function chamar(url, opts, gravar) {
    var f = gravar && window.gravarNoSuperlogica ? window.gravarNoSuperlogica : apiAuthFetch;
    var r = await f(url, opts);
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.detalhe || (textoFalha(r.status))); e.status = r.status; e.corpo = j; throw e; }
    return j;
  }
  var post = function (corpo) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }; };
  function caixa(tipo, texto) { return '<div class="' + (tipo === 'erro' ? 'ficha-erro' : 'ficha-sub') + '" style="margin:6px 0;' + (tipo === 'aviso' ? 'color:var(--warning);font-weight:600' : '') + '">' + esc(texto) + '</div>'; }

  // Ações novas do módulo Cobrança no catálogo de permissões (o servidor confere de novo).
  function catalogo() {
    if (typeof MODULOS_CATALOGO === 'undefined' || !MODULOS_CATALOGO.cobranca) return;
    ['acordo', 'contato_crm', 'status_financeiro', 'cadastro', 'relatorio_escritorio', 'politica_acordo'].forEach(function (a) {
      if (MODULOS_CATALOGO.cobranca.acoes.indexOf(a) < 0) MODULOS_CATALOGO.cobranca.acoes.push(a);
    });
  }

  // Monta o cartão no fim da aba Cobrança (uma vez).
  function montar() {
    var painel = document.getElementById('panel-cobranca');
    if (!painel || document.getElementById('cx-cartao')) return;
    var d = document.createElement('div');
    d.className = 'card'; d.id = 'cx-cartao'; d.style.marginTop = '16px';
    var abas = [['acordo', 'Acordo à vista'], ['contato', 'Contato no CRM'], ['status', 'Status financeiro'], ['cadastro', 'Cadastro'], ['relatorio', 'Relatório de inadimplência'], ['politica', 'Política de acordo']];
    d.innerHTML = '<div class="card-header"><span class="card-title">Execução da cobrança</span></div>'
      + '<div class="cob-form">Condomínio <select id="cx-cond" style="min-width:260px"></select> <button class="btn btn-ghost" id="cx-recarregar" style="font-size:11px;padding:4px 10px">Carregar unidades</button> <span class="ficha-sub" id="cx-info"></span></div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0">' + abas.map(function (a) { return '<button class="btn btn-ghost cx-aba" data-aba="' + a[0] + '" style="font-size:12px;padding:5px 10px">' + esc(a[1]) + '</button>'; }).join('') + '</div>'
      + '<div id="cx-corpo"></div>';
    painel.appendChild(d);
    preencherCondominios();
  }
  function preencherCondominios() {
    var sel = document.getElementById('cx-cond');
    if (!sel) return;
    var lista = ((window.CondSeletor && CondSeletor.lista()) || []).filter(function (c) { return c.id_superlogica; });
    var ativo = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
    sel.innerHTML = lista.map(function (c) { return '<option value="' + esc(c.id_superlogica) + '">' + esc(c.nome) + '</option>'; }).join('');
    if (ativo && ativo.id_superlogica) sel.value = String(ativo.id_superlogica);
    E.id = sel.value || null;
  }
  async function carregarUnidades() {
    E.id = document.getElementById('cx-cond').value || null;
    E.unidades = [];
    var info = document.getElementById('cx-info');
    if (!E.id) { info.textContent = 'Escolha o condomínio.'; return; }
    var seq = ++E.seqUni;
    info.textContent = 'Lendo as unidades no Superlógica...';
    try {
      var j = await chamar(base() + '/unidades');
      if (seq !== E.seqUni) return;
      E.unidades = j.unidades || [];
      info.textContent = E.unidades.length + ' unidades' + (j.cortado ? ' (lista cortada)' : '') + '.';
    } catch (e) { info.textContent = e.message; }
    abrirAba(E.aba);
  }
  function opcoesUnidade() {
    return '<option value="">Escolha a unidade</option>' + E.unidades.map(function (u) { return '<option value="' + esc(u.id_unidade) + '">' + esc(u.unidade) + '</option>'; }).join('');
  }
  function abrirAba(aba) {
    E.aba = aba;
    document.querySelectorAll('.cx-aba').forEach(function (b) { b.classList.toggle('btn-primary', b.dataset.aba === aba); b.classList.toggle('btn-ghost', b.dataset.aba !== aba); });
    var c = document.getElementById('cx-corpo');
    if (!c) return;
    if (!E.id) { c.innerHTML = caixa('info', 'Escolha o condomínio e clique em Carregar unidades.'); return; }
    ({ acordo: telaAcordo, contato: telaContato, status: telaStatus, cadastro: telaCadastro, relatorio: telaRelatorio, politica: telaPolitica })[aba](c);
  }

  // ── Acordo à vista ──
  function telaAcordo(c) {
    c.innerHTML = '<div class="cob-form">Unidade <select id="cx-a-uni">' + opcoesUnidade() + '</select> Vencimento <input type="date" id="cx-a-venc" value="' + isoDias(3) + '" style="width:150px">'
      + ' <button class="btn btn-primary" id="cx-a-conferir" style="font-size:12px;padding:5px 10px">Conferir acordo</button> <button class="btn btn-ghost" id="cx-a-lista" style="font-size:12px;padding:5px 10px">Acordos da unidade</button></div>'
      + '<div class="ficha-sub">Acordo à vista, em parcela única, pela política do condomínio. Parcelado e com desconto continuam no Superlógica.</div><div id="cx-a-res"></div>';
  }
  async function conferirAcordo() {
    var res = document.getElementById('cx-a-res');
    var uni = document.getElementById('cx-a-uni').value;
    if (!uni) { res.innerHTML = caixa('erro', 'Escolha a unidade.'); return; }
    res.innerHTML = '<div class="cond-loading">Conferindo no Superlógica...</div>';
    try {
      var j = await chamar(base() + '/acordo/preparar', post({ id_unidade: uni, vencimento: document.getElementById('cx-a-venc').value }));
      var h = '';
      (j.bloqueios || []).forEach(function (b) { h += caixa('erro', b.texto); });
      (j.avisos || []).forEach(function (a) { h += caixa(a.grave ? 'aviso' : 'info', a.texto); });
      if (j.plano) {
        var p = j.plano;
        h += '<table class="ficha-tab" style="margin-top:6px"><tr><th>Cobrança vencida em</th><th class="n">Valor</th><th class="n">Atualizado</th></tr>'
          + p.cobrancas.map(function (x) { return '<tr><td>' + esc(x.vencimento) + '</td><td class="n">' + brl(x.valor) + '</td><td class="n">' + brl(x.atualizado) + '</td></tr>'; }).join('') + '</table>'
          + '<div class="ficha-sub" style="margin-top:6px">Composição: ' + p.composicao.map(function (x) { return esc(x.conta) + ' ' + brl(x.valor); }).join(' · ') + '</div>'
          + '<div style="margin:8px 0;font-size:14px"><b>' + esc(p.unidade) + '</b> · ' + esc(p.responsavel) + ' · total ' + '<b>' + brl(p.total) + '</b> à vista, vencimento ' + esc(p.vencimento)
          + (p.honorarios ? ' · honorários ' + brl(p.honorarios) + ' (' + esc(p.honorarios_pct) + '%)' : ' · sem honorários') + '</div>';
        if (j.ok && pode('acordo')) h += '<button class="btn btn-primary" id="cx-a-emitir" style="font-size:12px;padding:6px 12px">Emitir acordo no Superlógica</button>';
        else if (j.ok) h += caixa('info', 'Seu usuário não pode emitir acordo.');
      }
      res.innerHTML = h || caixa('info', 'Nada a mostrar.');
    } catch (e) { res.innerHTML = caixa('erro', e.message); }
  }
  async function emitirAcordo(btn) {
    if (btn.disabled) return;
    btn.disabled = true; // sem clique duplo: o servidor também trava a unidade
    var res = document.getElementById('cx-a-res');
    try {
      var j = await chamar(base() + '/acordo/emitir', post({ id_unidade: document.getElementById('cx-a-uni').value, vencimento: document.getElementById('cx-a-venc').value }), true);
      res.innerHTML = caixa('info', 'Acordo ' + (j.id_acordo || '') + ' gravado no Superlógica' + (j.conferido ? ' e conferido na releitura.' : '. A releitura não foi possível agora: confira no Superlógica.'))
        + (j.divergencias || []).map(function (x) { return caixa('erro', x); }).join('')
        + (j.parcela ? caixa('info', 'Boleto do acordo: ' + brl(j.parcela.valor) + ' com vencimento em ' + j.parcela.vencimento + '. Envie pelo canal de sempre ou pela 2ª via.') : '');
      toast('Acordo gravado no Superlógica.', 'ok');
    } catch (e) {
      // Resultado incerto (504): o botão fica travado; confira no Superlógica antes de tentar de novo.
      btn.disabled = e.status === 504;
      res.insertAdjacentHTML('beforeend', caixa('erro', e.message));
    }
  }
  async function listarAcordos() {
    var res = document.getElementById('cx-a-res');
    var uni = document.getElementById('cx-a-uni').value;
    if (!uni) { res.innerHTML = caixa('erro', 'Escolha a unidade.'); return; }
    res.innerHTML = '<div class="cond-loading">Lendo os acordos da unidade...</div>';
    try {
      var j = await chamar(base() + '/acordos?id_unidade=' + encodeURIComponent(uni));
      if (!j.acordos.length) { res.innerHTML = caixa('info', 'Nenhum acordo desta unidade nos últimos 5 anos.'); return; }
      res.innerHTML = '<table class="ficha-tab"><tr><th>Acordo</th><th>Feito em</th><th>Situação</th><th>Parcelas</th><th></th></tr>' + j.acordos.map(function (a) {
        var parc = a.parcelas.map(function (p) { return p.vencimento + ' ' + brl(p.valor) + (p.paga ? ' (paga)' : ''); }).join('; ');
        var pago = a.parcelas.some(function (p) { return p.paga; });
        return '<tr><td>' + esc(a.id) + (a.escritorio ? ' <span class="ficha-tag">escritório</span>' : '') + '</td><td>' + esc(a.data) + '</td><td>' + (a.desfeito ? 'desfeito em ' + esc(a.desfeito) : a.aberto ? 'em andamento' : 'quitado') + '</td>'
          + '<td class="td-livre">' + esc(parc) + '</td><td>' + (!a.desfeito && a.aberto && !pago && pode('acordo') ? '<button class="btn btn-ghost cx-desfazer" data-id="' + esc(a.id) + '" style="font-size:11px;padding:4px 8px">Desfazer</button>' : '') + '</td></tr>';
      }).join('') + '</table>';
    } catch (e) { res.innerHTML = caixa('erro', e.message); }
  }
  async function desfazer(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      var j = await chamar(base() + '/acordo/desfazer', post({ id_unidade: document.getElementById('cx-a-uni').value, id_acordo: btn.dataset.id }), true);
      toast('Acordo desfeito no Superlógica.', 'ok');
      btn.closest('td').innerHTML = j.conferido ? 'desfeito e conferido' : 'desfeito, confira no Superlógica';
      (j.divergencias || []).forEach(function (x) { document.getElementById('cx-a-res').insertAdjacentHTML('beforeend', caixa('erro', x)); });
    } catch (e) { btn.disabled = false; document.getElementById('cx-a-res').insertAdjacentHTML('beforeend', caixa('erro', e.message)); }
  }

  // ── Contato no CRM ──
  var CANAIS = [[1, 'Telefone'], [6, 'Aplicativo de mensagem'], [2, 'Email'], [5, 'Presencial'], [4, 'Carta'], [3, 'SMS'], [7, 'Outros']];
  var RESULTADOS = [[4, 'Promessa de pagamento'], [2, 'Acordo'], [3, 'Pago'], [1, 'Efetivo'], [7, 'Retornar contato'], [10, 'Não atende'], [8, 'Sem contato'], [9, 'Telefone errado'], [11, 'Ocupado'], [5, 'Não efetivo'], [6, 'Não concorda'], [12, 'Outros']];
  var MOTIVOS = [['', 'Sem motivo informado'], [1, 'Problema financeiro'], [2, 'Não recebeu cobrança'], [3, 'Não concorda com cobrança'], [10, 'Outros']];
  var opc = function (l) { return l.map(function (x) { return '<option value="' + x[0] + '">' + esc(x[1]) + '</option>'; }).join(''); };
  function telaContato(c) {
    c.innerHTML = '<div class="ficha-sub">Registra o contato de cobrança no CRM do Superlógica (em vez de chamado). Não use para mandar mensagem: o Hub não envia nada ao morador.</div>'
      + '<div class="cob-form">Unidade <select id="cx-c-uni">' + opcoesUnidade() + '</select> Canal <select id="cx-c-canal">' + opc(CANAIS) + '</select> Resultado <select id="cx-c-res">' + opc(RESULTADOS) + '</select></div>'
      + '<div class="cob-form">Motivo <select id="cx-c-mot">' + opc(MOTIVOS) + '</select> Quem procurou <select id="cx-c-tipo"><option value="2">O morador</option><option value="1">A administradora</option></select></div>'
      + '<textarea id="cx-c-desc" rows="3" maxlength="500" style="width:100%" placeholder="O que foi conversado (sem CPF, telefone ou email)"></textarea>'
      + '<div><button class="btn btn-primary" id="cx-c-gravar" style="font-size:12px;padding:5px 10px;margin-top:6px"' + (pode('contato_crm') ? '' : ' disabled title="Seu usuário não pode registrar contato"') + '>Registrar no CRM</button></div><div id="cx-c-res-txt"></div>';
  }
  async function gravarContato(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    var res = document.getElementById('cx-c-res-txt');
    try {
      var j = await chamar(base() + '/contato', post({ id_unidade: document.getElementById('cx-c-uni').value, canal: document.getElementById('cx-c-canal').value, resultado: document.getElementById('cx-c-res').value,
        motivo: document.getElementById('cx-c-mot').value, tipo: document.getElementById('cx-c-tipo').value, descricao: document.getElementById('cx-c-desc').value }), true);
      res.innerHTML = caixa('info', 'Contato registrado no CRM' + (j.conferido ? ' e conferido.' : '. Não foi possível conferir agora.'));
      document.getElementById('cx-c-desc').value = '';
    } catch (e) { res.innerHTML = caixa('erro', e.message); }
    btn.disabled = false;
  }

  // ── Status financeiro ──
  function telaStatus(c) {
    c.innerHTML = '<div class="ficha-sub">Compara o status financeiro de cada unidade (o que guia a régua de cobrança) com o atraso de hoje e propõe a correção. Jurídico e processo não mudam por aqui.</div>'
      + '<div><button class="btn btn-primary" id="cx-s-analisar" style="font-size:12px;padding:5px 10px;margin-top:6px">Analisar</button></div><div id="cx-s-res"></div>';
  }
  async function analisarStatus() {
    var res = document.getElementById('cx-s-res');
    res.innerHTML = '<div class="cond-loading">Lendo unidades e inadimplência no Superlógica...</div>';
    try {
      var j = await chamar(base() + '/status-financeiro');
      E.divergencias = j.divergencias;
      var h = (j.regua_por_status ? '' : caixa('aviso', 'A régua deste condomínio não é guiada pelo status financeiro; a correção tem pouco efeito.'))
        + caixa('info', j.quantidade_unidades + ' unidades lidas. Régua: primeira carta aos ' + j.regua.dias_carta1 + ' dias, segunda aos ' + j.regua.dias_carta2 + ', aviso judicial aos ' + j.regua.dias_judicial + '.');
      if (!j.divergencias.length) { res.innerHTML = h + caixa('info', 'Nenhuma divergência.'); return; }
      h += '<table class="ficha-tab"><tr><th></th><th>Unidade</th><th>Hoje</th><th>Deveria</th><th>Motivo</th></tr>' + j.divergencias.map(function (x, k) {
        return '<tr><td><input type="checkbox" class="cx-s-item" data-k="' + k + '"' + (x.direcao === 'baixar' ? ' checked' : '') + '></td><td>' + esc(x.unidade) + '</td><td>' + esc(x.de_rotulo) + '</td><td>' + esc(x.para_rotulo)
          + (x.direcao === 'subir' ? ' <span class="ficha-tag">confira</span>' : '') + '</td><td class="td-livre">' + esc(x.motivo) + '</td></tr>';
      }).join('') + '</table>'
        + (pode('status_financeiro') ? '<button class="btn btn-primary" id="cx-s-gravar" style="font-size:12px;padding:5px 10px;margin-top:6px">Corrigir as marcadas no Superlógica</button>' : caixa('info', 'Seu usuário não pode corrigir o status.'))
        + '<div id="cx-s-prog"></div>';
      res.innerHTML = h;
    } catch (e) { res.innerHTML = caixa('erro', e.message); }
  }
  async function gravarStatus(btn) {
    if (btn.disabled) return;
    var itens = Array.prototype.slice.call(document.querySelectorAll('.cx-s-item:checked')).map(function (el) { var x = E.divergencias[+el.dataset.k]; return { id_unidade: x.id_unidade, de: x.de, para: x.para }; });
    var prog = document.getElementById('cx-s-prog');
    if (!itens.length) { prog.innerHTML = caixa('erro', 'Marque pelo menos uma unidade.'); return; }
    btn.disabled = true;
    try {
      // Confirma a lista inteira uma vez; cada unidade grava uma vez com essa confirmação.
      var pv = await chamar(base() + '/status-financeiro/previa', post({ itens: itens }), true);
      var conf = pv.confirmado && pv.confirmacao ? { id_condominio: pv.confirmacao.id_condominio, token: pv.confirmacao.token } : undefined;
      var feitos = 0, erros = 0;
      for (var i = 0; i < itens.length; i++) {
        prog.innerHTML = '<div class="cond-loading">Gravando ' + (i + 1) + ' de ' + itens.length + '...</div>';
        try { await chamar(base() + '/status-financeiro/gravar', post(Object.assign({}, itens[i], { confirmacao_gravacao: conf })), !conf); feitos++; }
        catch (e) { erros++; prog.insertAdjacentHTML('afterend', caixa('erro', itens[i].id_unidade + ': ' + e.message)); }
      }
      prog.innerHTML = caixa('info', feitos + ' corrigidas' + (erros ? ', ' + erros + ' com erro.' : '.'));
    } catch (e) { prog.innerHTML = caixa('erro', e.message); }
    btn.disabled = false;
  }

  // ── Cadastro ──
  var TIPOS = [['contato_atualizar', 'Atualizar email ou telefone'], ['contato_incluir', 'Incluir inquilino, dependente ou responsável financeiro'], ['contato_sair', 'Saída de inquilino ou dependente'], ['segundo_sacado', 'Segundo sacado do boleto'], ['troca_proprietario', 'Troca de proprietário']];
  function telaCadastro(c) {
    c.innerHTML = '<div class="cob-form">Unidade <select id="cx-k-uni">' + opcoesUnidade() + '</select> <button class="btn btn-ghost" id="cx-k-ver" style="font-size:12px;padding:5px 10px">Ver cadastro</button></div><div id="cx-k-ficha"></div>';
  }
  async function verCadastro() {
    var el = document.getElementById('cx-k-ficha');
    var uni = document.getElementById('cx-k-uni').value;
    if (!uni) { el.innerHTML = caixa('erro', 'Escolha a unidade.'); return; }
    el.innerHTML = '<div class="cond-loading">Lendo a unidade...</div>';
    try {
      var j = await chamar(base() + '/cadastro/' + encodeURIComponent(uni));
      var f = j.ficha; E.ficha = f;
      el.innerHTML = '<div class="ficha-sub">Sacado: ' + esc(f.sacado) + ' · Segundo sacado: ' + esc(f.segundo_sacado || 'nenhum') + ' · Status financeiro: ' + esc(f.status_fin) + '</div>'
        + '<table class="ficha-tab"><tr><th>Nome</th><th>Papel</th><th>CPF</th><th>Email</th><th>Telefone</th><th>Entrada</th></tr>' + f.contatos.map(function (x) {
          return '<tr><td>' + esc(x.nome) + '</td><td>' + esc(x.papel) + '</td><td>' + esc(x.cpf) + '</td><td>' + esc(x.email) + '</td><td>' + esc(x.telefone) + '</td><td>' + esc(x.entrada) + '</td></tr>';
        }).join('') + '</table>'
        + '<div class="cob-form" style="margin-top:8px">Alteração <select id="cx-k-tipo">' + opc(TIPOS) + '</select></div><div id="cx-k-form"></div><div id="cx-k-res"></div>'
        + (j.historico && j.historico.length ? '<div class="ficha-sub" style="margin-top:8px">Últimas alterações pelo Hub: ' + j.historico.slice(0, 5).map(function (h) { return esc(new Date(h.em).toLocaleDateString('pt-BR')) + ' ' + esc(h.tipo.replace(/_/g, ' ')) + (h.ok ? '' : ' (falhou)'); }).join(' · ') + '</div>' : '');
      formCadastro();
    } catch (e) { el.innerHTML = caixa('erro', e.message); }
  }
  function opcContatos(filtro) { return (E.ficha.contatos || []).filter(filtro).map(function (x) { return '<option value="' + esc(x.id_contato) + '">' + esc(x.nome + ' (' + x.papel + ')') + '</option>'; }).join(''); }
  function formCadastro() {
    var t = document.getElementById('cx-k-tipo').value;
    var pessoa = 'Nome <input id="cx-k-nome" style="width:240px"> CPF ou CNPJ <input id="cx-k-cpf" style="width:150px"> Email <input id="cx-k-email" style="width:200px"> Telefone <input id="cx-k-tel" style="width:130px"> Entrada <input type="date" id="cx-k-ent" value="' + isoDias(0) + '" style="width:150px">';
    var h = '';
    if (t === 'contato_atualizar') h = 'Contato <select id="cx-k-cont">' + opcContatos(function () { return true; }) + '</select> Email novo <input id="cx-k-email" style="width:200px"> Telefone novo <input id="cx-k-tel" style="width:130px">';
    else if (t === 'contato_incluir') h = 'Papel <select id="cx-k-papel"><option value="inquilino">Inquilino (não recebe cobrança)</option><option value="responsavel_financeiro">Responsável financeiro (inquilino que paga a cobrança normal)</option><option value="dependente">Dependente</option></select> ' + pessoa;
    else if (t === 'contato_sair') h = 'Contato <select id="cx-k-cont">' + opcContatos(function (x) { return !x.proprietario; }) + '</select>';
    else if (t === 'segundo_sacado') h = 'Nome no boleto <input id="cx-k-nome" style="width:260px" placeholder="vazio para tirar">';
    else if (t === 'troca_proprietario') h = 'Sai <select id="cx-k-cont">' + opcContatos(function (x) { return x.proprietario; }) + '</select><br>Entra: ' + pessoa + ' <label><input type="checkbox" id="cx-k-doc"> escritura ou contrato conferido</label>';
    document.getElementById('cx-k-form').innerHTML = '<div class="cob-form">' + h + '</div><button class="btn btn-ghost" id="cx-k-conferir" style="font-size:12px;padding:5px 10px">Conferir</button>'
      + (pode('cadastro') ? ' <button class="btn btn-primary" id="cx-k-gravar" style="font-size:12px;padding:5px 10px" disabled>Gravar no Superlógica</button>' : '');
    document.getElementById('cx-k-res').innerHTML = '';
  }
  function pedidoCadastro() {
    var v = function (id) { var el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
    var t = v('cx-k-tipo');
    var d = { id_contato: t === 'troca_proprietario' ? undefined : v('cx-k-cont'), id_contato_antigo: t === 'troca_proprietario' ? v('cx-k-cont') : undefined, papel: v('cx-k-papel'), nome: v('cx-k-nome'),
      cpf: v('cx-k-cpf'), email: v('cx-k-email'), telefone: v('cx-k-tel'), entrada: v('cx-k-ent'), documento_conferido: v('cx-k-doc') === true };
    Object.keys(d).forEach(function (k) { if (d[k] === undefined || d[k] === '') delete d[k]; });
    if (t === 'segundo_sacado') d.nome = v('cx-k-nome') || '';
    return { tipo: t, dados: d };
  }
  function linhasAntesDepois(j) {
    // caixa() já escapa o texto.
    var l = function (o) { return Object.keys(o || {}).filter(function (k) { return o[k] !== undefined && o[k] !== null; }).map(function (k) { return k.replace(/_/g, ' ') + ': ' + o[k]; }).join(' · '); };
    return (j.antes ? caixa('info', 'Antes: ' + l(j.antes)) : '') + (j.depois ? caixa('info', 'Depois: ' + l(j.depois)) : '');
  }
  async function conferirCadastro() {
    var res = document.getElementById('cx-k-res');
    var g = document.getElementById('cx-k-gravar');
    if (g) g.disabled = true;
    try {
      var j = await chamar(base() + '/cadastro/' + encodeURIComponent(document.getElementById('cx-k-uni').value) + '/conferir', post(pedidoCadastro()));
      res.innerHTML = (j.erros || []).map(function (x) { return caixa('erro', x); }).join('') + (j.avisos || []).map(function (a) { return caixa('aviso', a.texto); }).join('') + linhasAntesDepois(j)
        + (j.ok && j.sensivel ? caixa('aviso', 'Alteração sensível: a gravação pede para digitar o nome do condomínio.') : '');
      if (g) g.disabled = !j.ok;
    } catch (e) { res.innerHTML = caixa('erro', e.message); }
  }
  async function gravarCadastro(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    var res = document.getElementById('cx-k-res');
    try {
      var j = await chamar(base() + '/cadastro/' + encodeURIComponent(document.getElementById('cx-k-uni').value) + '/gravar', post(pedidoCadastro()), true);
      res.innerHTML = caixa('info', 'Gravado no Superlógica' + (j.conferido ? ' e conferido na releitura.' : '. Confira a unidade no Superlógica.')) + (j.divergencias || []).map(function (x) { return caixa('erro', x); }).join('');
      toast('Cadastro gravado no Superlógica.', 'ok');
    } catch (e) { res.insertAdjacentHTML('beforeend', caixa('erro', e.message)); btn.disabled = false; }
  }

  // ── Relatório de inadimplência ──
  function telaRelatorio(c) {
    c.innerHTML = '<div class="cob-form">Para <select id="cx-r-dest"><option value="sindico">Síndico (sem nomes)</option>' + (podeGestao('relatorio_escritorio') ? '<option value="escritorio">Escritório de cobrança (com o nome do responsável)</option>' : '') + '</select>'
      + ' <button class="btn btn-primary" id="cx-r-gerar" style="font-size:12px;padding:5px 10px">Gerar</button></div><div id="cx-r-res"></div>';
  }
  function tabelaRel(g, comNome) {
    if (!g.linhas.length) return caixa('info', 'Nenhuma unidade.');
    return '<table class="ficha-tab"><tr><th>Unidade</th>' + (comNome ? '<th>Responsável</th>' : '') + '<th class="n">Cobranças</th><th>Mais antiga</th><th>Faixa</th><th>Situação</th><th class="n">Original</th><th class="n">Atualizado</th></tr>'
      + g.linhas.map(function (l) { return '<tr><td>' + esc(l.unidade) + '</td>' + (comNome ? '<td>' + esc(l.responsavel) + '</td>' : '') + '<td class="n">' + l.cobrancas + '</td><td>' + esc(l.mais_antiga) + '</td><td>' + esc(l.faixa) + '</td><td>' + esc(l.situacao) + '</td><td class="n">' + brl(l.valor_original) + '</td><td class="n">' + brl(l.valor_atualizado) + '</td></tr>'; }).join('')
      + '<tr><td><b>Total</b></td>' + (comNome ? '<td></td>' : '') + '<td class="n"><b>' + g.cobrancas + '</b></td><td></td><td></td><td></td><td class="n"><b>' + brl(g.valor_original) + '</b></td><td class="n"><b>' + brl(g.valor_atualizado) + '</b></td></tr></table>';
  }
  function htmlRelatorio(j) {
    var comNome = j.destino === 'escritorio';
    return '<h3 style="margin:8px 0">Inadimplência ' + esc(j.condominio) + ' em ' + esc(j.posicao_em) + '</h3>'
      + '<p>' + j.total.unidades + ' unidades, ' + brl(j.total.valor_atualizado) + ' atualizado (' + brl(j.total.valor_original) + ' original). Recente: até ' + j.corte_recente_dias + ' dias de atraso; antiga: mais de ' + j.corte_recente_dias + ' dias.</p>'
      + '<h4>Recente: ' + j.recente.unidades + ' unidades, ' + brl(j.recente.valor_atualizado) + '</h4>' + tabelaRel(j.recente, comNome)
      + '<h4>Antiga: ' + j.antiga.unidades + ' unidades, ' + brl(j.antiga.valor_atualizado) + '</h4>' + tabelaRel(j.antiga, comNome)
      + (j.cortado ? '<p>Lista cortada: o condomínio tem unidades demais para uma leitura só.</p>' : '');
  }
  async function gerarRelatorio() {
    var res = document.getElementById('cx-r-res');
    res.innerHTML = '<div class="cond-loading">Lendo a inadimplência no Superlógica...</div>';
    try {
      var j = await chamar(base() + '/relatorio-inadimplencia?destino=' + encodeURIComponent(document.getElementById('cx-r-dest').value));
      E.relatorio = j;
      res.innerHTML = '<div style="margin:6px 0"><button class="btn btn-ghost" id="cx-r-imprimir" style="font-size:11px;padding:4px 10px">Imprimir ou salvar PDF</button> <button class="btn btn-ghost" id="cx-r-csv" style="font-size:11px;padding:4px 10px">Baixar planilha</button></div>' + htmlRelatorio(j);
    } catch (e) { res.innerHTML = caixa('erro', e.message); }
  }
  function imprimirRelatorio() {
    var w = window.open('', '_blank');
    if (!w) { toast('Libere as janelas do navegador para imprimir.', 'warn'); return; }
    w.document.write('<!doctype html><meta charset="utf-8"><title>Inadimplência</title><style>body{font-family:Arial,sans-serif;font-size:12px;margin:24px}table{border-collapse:collapse;width:100%;margin-bottom:14px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}.n{text-align:right}</style>' + htmlRelatorio(E.relatorio));
    w.document.close(); w.focus(); w.print();
  }
  function baixarCsv() {
    var j = E.relatorio; if (!j) return;
    var comNome = j.destino === 'escritorio';
    var cab = ['Grupo', 'Unidade'].concat(comNome ? ['Responsável'] : []).concat(['Cobranças', 'Mais antiga', 'Dias', 'Faixa', 'Situação', 'Original', 'Atualizado']);
    var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var linhas = [cab.map(q).join(';')];
    [['recente', j.recente], ['antiga', j.antiga]].forEach(function (g) { g[1].linhas.forEach(function (l) { linhas.push([g[0], l.unidade].concat(comNome ? [l.responsavel] : []).concat([l.cobrancas, l.mais_antiga, l.dias, l.faixa, l.situacao, String(l.valor_original).replace('.', ','), String(l.valor_atualizado).replace('.', ',')]).map(q).join(';')); }); });
    var blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'inadimplencia_' + E.id + '_' + j.destino + '.csv'; document.body.appendChild(a); a.click(); a.remove();
  }

  // ── Política de acordo ──
  async function telaPolitica(c) {
    c.innerHTML = '<div class="cond-loading">Lendo a política...</div>';
    try {
      var j = await chamar(base() + '/politica');
      var p = j.politica || {}; var s = j.superlogica || {};
      var campo = function (id, rot, v, extra) { return rot + ' <input id="' + id + '" type="number" step="0.01" min="0" value="' + esc(v == null ? '' : v) + '" style="width:90px"' + (extra || '') + '> '; };
      var edita = podeGestao('politica_acordo');
      c.innerHTML = (j.politica ? caixa('info', 'Atualizada em ' + new Date(p.atualizado_em).toLocaleString('pt-BR') + (p.atualizado_por_email ? ' por ' + p.atualizado_por_email : '') + '.') : caixa('aviso', 'Sem política cadastrada: o Hub não monta acordo neste condomínio.'))
        + caixa('info', 'No Superlógica: juros ' + (s.juros_acordo != null ? s.juros_acordo : s.juros) + '%, multa ' + (s.multa_acordo != null ? s.multa_acordo : s.multa) + '%, honorários ' + (s.honorarios_pct != null ? s.honorarios_pct + '%' : 'não informado') + '. Instrução do boleto de acordo: ' + (s.instrucao_acordo || 'nenhuma') + '.')
        + (j.aviso_nao_receber ? caixa('aviso', j.aviso_nao_receber.texto) : '')
        + '<div class="cob-form">' + campo('cx-p-juros', 'Juros % ao mês', p.juros_pct != null ? p.juros_pct : s.juros_acordo) + campo('cx-p-multa', 'Multa %', p.multa_pct != null ? p.multa_pct : s.multa_acordo) + campo('cx-p-hon', 'Honorários %', p.honorarios_pct != null ? p.honorarios_pct : s.honorarios_pct) + '</div>'
        + '<div class="cob-form">' + campo('cx-p-desc', 'Desconto máximo % dos juros e multa', p.desconto_max_pct || 0) + campo('cx-p-teto', 'Acima de R$ pede confirmação reforçada (0 sem teto)', p.teto_automatico || 0) + '</div>'
        + '<div class="cob-form">' + campo('cx-p-prazo', 'Prazo máximo para pagar (dias)', p.prazo_max_dias || 10, ' step="1"') + campo('cx-p-parc', 'Parcelas máximas', p.parcelas_max || 1, ' step="1"') + ' <label><input type="checkbox" id="cx-p-sind"' + (p.aprovada_sindico ? ' checked' : '') + '> aprovada pelo síndico</label></div>'
        + '<textarea id="cx-p-obs" rows="2" maxlength="500" style="width:100%" placeholder="Observação">' + esc(p.observacao || '') + '</textarea>'
        + (edita ? '<div><button class="btn btn-primary" id="cx-p-salvar" style="font-size:12px;padding:5px 10px;margin-top:6px">Salvar política</button>'
          + (j.politica && podeRemoverPolitica() ? ' <button class="btn btn-ghost" id="cx-p-remover" style="font-size:12px;padding:5px 10px;margin-top:6px;color:var(--danger)">Remover política</button>' : '') + '</div>' : caixa('info', 'Só a gestão altera a política.')) + '<div id="cx-p-res"></div>';
    } catch (e) { c.innerHTML = caixa('erro', e.message); }
  }
  async function salvarPolitica(btn) {
    btn.disabled = true;
    var v = function (id) { return document.getElementById(id).value; };
    try {
      await chamar(base() + '/politica', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ juros_pct: v('cx-p-juros'), multa_pct: v('cx-p-multa'), honorarios_pct: v('cx-p-hon'), desconto_max_pct: v('cx-p-desc'),
        teto_automatico: v('cx-p-teto'), prazo_max_dias: v('cx-p-prazo'), parcelas_max: v('cx-p-parc'), aprovada_sindico: document.getElementById('cx-p-sind').checked, observacao: v('cx-p-obs') }) });
      toast('Política salva.', 'ok');
      telaPolitica(document.getElementById('cx-corpo'));
    } catch (e) { document.getElementById('cx-p-res').innerHTML = caixa('erro', e.message); btn.disabled = false; }
  }

  // Remover a política é só do gestor e do gerente pelo cargo (o servidor confere de novo).
  function podeRemoverPolitica() { return window.USER_ROLE === 'GESTOR' || window.USER_ROLE === 'GERENTE'; }
  // Primeiro clique pede a confirmação na própria tela; o segundo remove.
  function pedirRemocaoPolitica() {
    var res = document.getElementById('cx-p-res'); if (!res) return;
    res.innerHTML = caixa('aviso', 'Remover a política deste condomínio? Sem política o Hub deixa de montar acordo aqui até alguém cadastrar de novo.')
      + '<div><button class="btn btn-primary" id="cx-p-remover-sim" style="font-size:12px;padding:5px 10px">Remover</button> <button class="btn btn-ghost" id="cx-p-remover-nao" style="font-size:12px;padding:5px 10px">Cancelar</button></div>';
  }
  async function removerPolitica(btn) {
    btn.disabled = true;
    try {
      await chamar(base() + '/politica', { method: 'DELETE' });
      toast('Política removida.', 'ok');
      telaPolitica(document.getElementById('cx-corpo'));
    } catch (e) { document.getElementById('cx-p-res').innerHTML = caixa('erro', e.message); }
  }

  // ── eventos ──
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest && ev.target.closest('#cx-cartao button, #cx-cartao .cx-aba');
    if (!el) return;
    if (el.classList.contains('cx-aba')) return abrirAba(el.dataset.aba);
    if (el.classList.contains('cx-desfazer')) return desfazer(el);
    var acoes = { 'cx-recarregar': carregarUnidades, 'cx-a-conferir': conferirAcordo, 'cx-a-emitir': function () { emitirAcordo(el); }, 'cx-a-lista': listarAcordos, 'cx-c-gravar': function () { gravarContato(el); },
      'cx-s-analisar': analisarStatus, 'cx-s-gravar': function () { gravarStatus(el); }, 'cx-k-ver': verCadastro, 'cx-k-conferir': conferirCadastro, 'cx-k-gravar': function () { gravarCadastro(el); },
      'cx-r-gerar': gerarRelatorio, 'cx-r-imprimir': imprimirRelatorio, 'cx-r-csv': baixarCsv, 'cx-p-salvar': function () { salvarPolitica(el); },
      'cx-p-remover': pedirRemocaoPolitica, 'cx-p-remover-sim': function () { removerPolitica(el); }, 'cx-p-remover-nao': function () { document.getElementById('cx-p-res').innerHTML = ''; } };
    if (acoes[el.id]) acoes[el.id]();
  });
  document.addEventListener('change', function (ev) {
    if (ev.target && ev.target.id === 'cx-k-tipo') formCadastro();
    if (ev.target && ev.target.id === 'cx-cond') { E.id = ev.target.value; E.unidades = []; document.getElementById('cx-info').textContent = 'Clique em Carregar unidades.'; abrirAba(E.aba); }
    if (ev.target && ev.target.closest && ev.target.closest('#cx-k-form')) { var g = document.getElementById('cx-k-gravar'); if (g) g.disabled = true; }
  });
  document.addEventListener('input', function (ev) { if (ev.target && ev.target.closest && ev.target.closest('#cx-k-form')) { var g = document.getElementById('cx-k-gravar'); if (g) g.disabled = true; } });
  // Abre junto com a aba Cobrança.
  async function aoAbrir() {
    catalogo(); montar();
    if (window.CondSeletor && CondSeletor.lista() === null) { await CondSeletor.carregar(); preencherCondominios(); }
    if (document.getElementById('cx-cond') && !document.getElementById('cx-cond').options.length) preencherCondominios();
    abrirAba(E.aba);
  }
  catalogo();
  if (typeof window.cobrancaAbrir === 'function') {
    var orig = window.cobrancaAbrir;
    window.cobrancaAbrir = function () { var r = orig.apply(this, arguments); aoAbrir(); return r; };
  }
  document.addEventListener('auth:ready', function () { catalogo(); var p = document.getElementById('panel-cobranca'); if (p && p.classList.contains('active')) aoAbrir(); });
})();
