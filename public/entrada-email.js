// ============================================================
// CAIXAS DE EMAIL DO FINANCEIRO (documentos chegando por email): cartão no topo da Entrada de
// documentos, só para GESTOR. Cadastra as caixas (servidor, usuário, senha, finalidade, pasta),
// testa a conexão, lê agora e mostra o último aviso de cada caixa. A senha vai para o servidor ao
// salvar e nunca volta: a tela só sabe se há senha guardada.
// Rotas: /api/email-financeiro/*. O servidor confere tudo de novo.
// ============================================================
(function () {
  var est = { dados: null, editando: null, conds: null, removendo: null, carregando: false };
  function gestor() { return window.USER_ROLE === 'GESTOR'; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function dataHoraBR(iso) { var d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''; }
  async function api(url, opt) {
    var r = await apiAuthFetch(url, opt || {});
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.detalhe || ('Falha ' + r.status)); e.status = r.status; e.corpo = j; throw e; }
    return j;
  }
  function postar(url, corpo, metodo) { return api(url, { method: metodo || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) }); }
  var FINALIDADE = { geral: 'Geral', carteira: 'Por carteira ou analista', condominio: 'Por condomínio' };

  // 1. Abre junto com o painel da Entrada de documentos.
  function painelAtivo() { var p = document.getElementById('panel-entrada'); return !!(p && p.classList.contains('active')); }
  if (typeof window.showPanel === 'function') {
    var origShow = window.showPanel;
    window.showPanel = function () {
      var r = origShow.apply(this, arguments);
      if (painelAtivo() && gestor()) abrir();
      return r;
    };
  }
  document.addEventListener('auth:ready', function () { setTimeout(function () { if (painelAtivo() && gestor()) abrir(); }, 0); });

  function cartao() {
    var c = document.getElementById('ent-caixas');
    if (c) return c;
    var painel = document.getElementById('panel-entrada');
    if (!painel) return null;
    c = document.createElement('div');
    c.className = 'card';
    c.id = 'ent-caixas';
    painel.insertBefore(c, painel.firstChild);
    return c;
  }
  async function abrir() {
    if (!window.AUTH_TOKEN || !gestor()) return;
    var c = cartao();
    if (!c) return;
    if (!est.conds) { try { est.conds = (window.CondSeletor && await window.CondSeletor.carregar()) || []; } catch (e) { est.conds = []; } }
    carregar();
  }
  window.efAbrir = abrir;

  // 2. Lista das caixas.
  async function carregar() {
    var c = cartao();
    if (!c || est.carregando) return;
    est.carregando = true;
    try { est.dados = await api('/api/email-financeiro/caixas'); }
    catch (e) { est.carregando = false; c.innerHTML = cabecalho() + '<div style="font-size:12px;color:var(--danger)">' + esc(e.message) + '</div>'; return; }
    est.carregando = false;
    desenhar();
  }
  window.efCarregar = carregar;
  function cabecalho() {
    return '<div class="card-header"><span class="card-title">Caixas de email do financeiro</span><span style="display:flex;gap:6px">' +
      '<button class="btn btn-ghost" onclick="efNova()">Nova caixa</button><button class="btn btn-ghost" onclick="efCarregar()">Atualizar</button></span></div>';
  }
  function situacao(cx) {
    if (!cx.ativo) return '<span style="color:var(--muted)">Desativada</span>';
    if (cx.lendo) return '<span style="color:var(--muted)">Lendo agora</span>';
    if (cx.ultimo_erro) return '<span style="color:var(--danger)">' + esc(cx.ultimo_erro) + (cx.ultimo_erro_em ? ' (' + esc(dataHoraBR(cx.ultimo_erro_em)) + ')' : '') + '</span>';
    if (cx.ultimo_sucesso) return '<span style="color:var(--success)">Lida em ' + esc(dataHoraBR(cx.ultimo_sucesso)) + '</span>';
    return '<span style="color:var(--muted)">Ainda não lida</span>';
  }
  function nomeFinalidade(cx) {
    var d = est.dados || {};
    if (cx.finalidade === 'carteira') {
      var g = (d.carteiras || []).filter(function (x) { return String(x.id) === String(cx.carteira); })[0];
      return 'Carteira ' + (g ? g.nome : cx.carteira || '');
    }
    if (cx.finalidade === 'condominio') return (cx.condominios || []).length + ' condomínio(s)';
    return 'Geral';
  }
  function desenhar() {
    var c = cartao(), d = est.dados || {};
    var caixas = d.caixas || [];
    var aviso = '';
    if (!d.ligado) aviso += '<div style="font-size:12px;color:var(--warning);margin-bottom:6px">A leitura automática está desligada neste ambiente. Dá para cadastrar e testar as caixas; a leitura começa quando for ligada.</div>';
    else aviso += '<div style="font-size:12px;color:var(--muted);margin-bottom:6px">Leitura automática ligada: as caixas ativas são lidas a cada 5 minutos. Cada anexo vira um item na fila abaixo.</div>';
    if (!d.chave_configurada) aviso += '<div style="font-size:12px;color:var(--danger);margin-bottom:6px">Falta configurar no servidor a chave que protege as senhas. Sem ela nenhuma senha é salva.</div>';
    var tabela = caixas.length ? '<table class="data-table" style="width:100%;font-size:12px"><thead><tr><th>Caixa</th><th>Finalidade</th><th>Pasta</th><th>Situação</th><th>Emails lidos</th><th></th></tr></thead><tbody>' +
      caixas.map(function (cx) {
        var teste = cx.ultimo_teste ? '<div style="font-size:11px;color:' + (cx.ultimo_teste.ok ? 'var(--success)' : 'var(--danger)') + '">Teste ' + esc(dataHoraBR(cx.ultimo_teste.em)) + ': ' + esc(cx.ultimo_teste.detalhe || '') + '</div>' : '';
        return '<tr><td class="td-livre">' + esc(cx.endereco) + '<div style="font-size:11px;color:var(--muted)">' + esc(cx.servidor + ':' + cx.porta) + (cx.senha_guardada ? ' · senha guardada' : ' · sem senha') + '</div></td>' +
          '<td>' + esc(nomeFinalidade(cx)) + '</td><td>' + esc(cx.pasta) + (cx.marcar_lido ? '<div style="font-size:11px;color:var(--muted)">marca como lido</div>' : '') + '</td>' +
          '<td class="td-livre">' + situacao(cx) + teste + '</td><td>' + esc(cx.lidos_total || 0) + '</td>' +
          '<td style="white-space:nowrap"><button class="btn btn-ghost" onclick="efEditar(\'' + esc(cx.id) + '\')">Editar</button> ' +
          '<button class="btn btn-ghost" onclick="efTestar(\'' + esc(cx.id) + '\')">Testar conexão</button> ' +
          (d.ligado && cx.ativo ? '<button class="btn btn-ghost" onclick="efLer(\'' + esc(cx.id) + '\')">Ler agora</button> ' : '') +
          '<button class="btn btn-ghost" onclick="efMensagens(\'' + esc(cx.id) + '\')">Emails lidos</button></td></tr>';
      }).join('') + '</tbody></table>' : '<div style="font-size:12px;color:var(--muted)">Nenhuma caixa cadastrada.</div>';
    c.innerHTML = cabecalho() + aviso + '<div style="overflow-x:auto">' + tabela + '</div><div id="ef-form"></div><div id="ef-info" style="margin-top:6px"></div><div id="ef-msgs"></div>';
    if (est.editando) formulario();
  }
  function info(texto, erro) { var el = document.getElementById('ef-info'); if (el) el.innerHTML = texto ? '<div style="font-size:12px;color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : ''; }

  // 3. Formulário (nova caixa ou edição).
  window.efNova = function () { est.editando = { novo: true, servidor: 'imap.kinghost.net', porta: 993, pasta: 'INBOX', finalidade: 'geral', condominios: [], ativo: false, marcar_lido: false }; est.removendo = null; desenhar(); };
  window.efEditar = function (id) { var cx = ((est.dados || {}).caixas || []).filter(function (x) { return x.id === id; })[0]; if (!cx) return; est.editando = Object.assign({}, cx); est.removendo = null; desenhar(); };
  window.efCancelar = function () { est.editando = null; est.removendo = null; desenhar(); };
  function formulario() {
    var f = document.getElementById('ef-form'), cx = est.editando, d = est.dados || {};
    if (!f || !cx) return;
    var campo = function (rot, html) { return '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px">' + esc(rot) + html + '</label>'; };
    var opt = function (v, t, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(t) + '</option>'; };
    var conds = (est.conds || []).filter(function (c) { return c.id_superlogica; });
    var marcados = (cx.condominios || []).map(String);
    f.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:10px;display:flex;flex-direction:column;gap:10px">' +
      '<div style="font-size:12px;font-weight:600">' + (cx.novo ? 'Nova caixa' : 'Editar ' + esc(cx.endereco)) + '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">' +
      campo('Endereço de email', '<input id="ef-endereco" value="' + esc(cx.endereco || '') + '" placeholder="financeiro@condominioservice.com.br">') +
      campo('Servidor IMAP', '<select id="ef-servidor">' + (d.servidores || ['imap.kinghost.net']).map(function (s) { return opt(s, s, s === cx.servidor); }).join('') + '</select>') +
      campo('Porta', '<select id="ef-porta">' + opt(993, '993 (SSL)', Number(cx.porta) !== 143) + opt(143, '143 (STARTTLS)', Number(cx.porta) === 143) + '</select>') +
      campo('Usuário', '<input id="ef-usuario" value="' + esc(cx.usuario || '') + '" placeholder="o próprio endereço de email">') +
      campo('Senha', '<input id="ef-senha" type="password" autocomplete="new-password" placeholder="' + (cx.senha_guardada ? 'senha guardada (deixe em branco para manter)' : 'senha da caixa') + '">') +
      campo('Pasta a ler', '<input id="ef-pasta" value="' + esc(cx.pasta || 'INBOX') + '">') +
      campo('Ler emails a partir de', '<input id="ef-desde" type="date" value="' + esc(cx.ler_desde || '') + '">') +
      campo('Finalidade', '<select id="ef-finalidade" onchange="efFinalidade()">' + Object.keys(FINALIDADE).map(function (k) { return opt(k, FINALIDADE[k], cx.finalidade === k); }).join('') + '</select>') +
      '<div id="ef-carteira-box">' + campo('Carteira', '<select id="ef-carteira">' + opt('', 'Nenhuma', !cx.carteira) + (d.carteiras || []).map(function (g) { return opt(g.id, g.nome, String(g.id) === String(cx.carteira)); }).join('') + '</select>') + '</div>' +
      campo('Analista responsável', '<select id="ef-analista">' + opt('', 'Nenhum', !cx.analista) + (d.analistas || []).map(function (a) { return opt(a.id, a.nome, a.id === cx.analista); }).join('') + '</select>') +
      '</div>' +
      '<div id="ef-conds-box">' + campo('Condomínios desta caixa (segure Ctrl ou Cmd para escolher vários)', '<select id="ef-conds" multiple size="6">' + conds.map(function (c) { return opt(c.id_superlogica, c.nome + ' (' + c.id_superlogica + ')', marcados.indexOf(String(c.id_superlogica)) >= 0); }).join('') + '</select>') + '</div>' +
      '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px">' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ef-ativo"' + (cx.ativo ? ' checked' : '') + '> Caixa ativa (entra na leitura automática)</label>' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ef-lido"' + (cx.marcar_lido ? ' checked' : '') + '> Marcar como lido depois de ler</label></div>' +
      '<div style="font-size:11px;color:var(--muted)">O Hub nunca apaga emails da caixa. Sem condomínio pelo CNPJ do documento, ele tenta pelo nome citado no email, pelo remetente e pela caixa, e pede conferência na tela.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary" id="ef-salvar" onclick="efSalvar()">Salvar</button>' +
      '<button class="btn btn-ghost" onclick="efTestarForm()">Testar conexão</button>' +
      (cx.novo ? '' : '<button class="btn btn-ghost" id="ef-remover" onclick="efRemover()">' + (est.removendo === cx.id ? 'Clique de novo para remover' : 'Remover caixa') + '</button>') +
      '<button class="btn btn-ghost" onclick="efCancelar()">Cancelar</button></div><div id="ef-form-info"></div></div>';
    window.efFinalidade();
  }
  window.efFinalidade = function () {
    var v = (document.getElementById('ef-finalidade') || {}).value;
    var cb = document.getElementById('ef-conds-box'), kb = document.getElementById('ef-carteira-box');
    if (cb) cb.style.display = v === 'condominio' ? '' : 'none';
    if (kb) kb.style.display = v === 'carteira' ? '' : 'none';
  };
  function valor(id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
  function formInfo(texto, erro) { var el = document.getElementById('ef-form-info'); if (el) el.innerHTML = texto ? '<div style="font-size:12px;color:' + (erro ? 'var(--danger)' : 'var(--success)') + '">' + esc(texto) + '</div>' : ''; }
  function camposForm() {
    var sel = document.getElementById('ef-conds');
    var conds = sel ? [].slice.call(sel.selectedOptions || []).map(function (o) { return o.value; }) : [];
    var fin = valor('ef-finalidade');
    var o = {
      endereco: valor('ef-endereco'), servidor: valor('ef-servidor'), porta: Number(valor('ef-porta') || 993), usuario: valor('ef-usuario') || valor('ef-endereco'),
      pasta: valor('ef-pasta') || 'INBOX', ler_desde: valor('ef-desde') || null, finalidade: fin,
      carteira: fin === 'carteira' ? (valor('ef-carteira') || null) : null, analista: valor('ef-analista') || null,
      condominios: fin === 'condominio' ? conds : [], ativo: !!(document.getElementById('ef-ativo') || {}).checked, marcar_lido: !!(document.getElementById('ef-lido') || {}).checked,
    };
    var senha = (document.getElementById('ef-senha') || {}).value || '';
    if (senha) o.senha = senha;
    return o;
  }
  function limparSenha() { var el = document.getElementById('ef-senha'); if (el) el.value = ''; }
  window.efSalvar = async function () {
    var cx = est.editando;
    if (!cx) return;
    var b = document.getElementById('ef-salvar');
    if (b) b.disabled = true;
    var corpo = camposForm();
    try {
      var j = cx.novo ? await postar('/api/email-financeiro/caixas', corpo) : await postar('/api/email-financeiro/caixas/' + encodeURIComponent(cx.id), corpo, 'PUT');
      corpo = null; limparSenha();
      toast('Caixa salva.', 'ok');
      est.editando = null;
      await carregar();
      if (j && j.caixa) info('Caixa ' + j.caixa.endereco + ' salva. Use "Testar conexão" para conferir usuário, senha e pasta.');
    } catch (e) { formInfo(e.message, true); if (b) b.disabled = false; }
  };
  // Testa o que está no formulário (sem senha digitada, usa a guardada).
  window.efTestarForm = async function () {
    var cx = est.editando;
    if (!cx) return;
    var corpo = camposForm();
    if (!cx.novo) corpo.id = cx.id;
    formInfo('Conectando...');
    var el = document.getElementById('ef-form-info');
    try {
      var r = await postar('/api/email-financeiro/testar', corpo);
      corpo = null;
      if (el) el.innerHTML = '<div style="font-size:12px;color:' + (r.ok ? 'var(--success)' : 'var(--danger)') + '">' + esc(r.detalhe || (r.ok ? 'Conectou.' : 'Não conectou.')) + '</div>';
    } catch (e) { formInfo(e.message, true); }
  };
  window.efTestar = async function (id) {
    info('Conectando...');
    try {
      var r = await postar('/api/email-financeiro/testar', { id: id });
      toast(r.detalhe || (r.ok ? 'Conectou.' : 'Não conectou.'), r.ok ? 'ok' : 'err');
      await carregar();
    } catch (e) { info(e.message, true); }
  };
  window.efLer = async function (id) {
    try {
      var r = await postar('/api/email-financeiro/caixas/' + encodeURIComponent(id) + '/ler', {});
      toast(r.detalhe || 'Leitura iniciada.', 'ok');
      setTimeout(function () { carregar(); if (typeof window.entCarregar === 'function') window.entCarregar(); }, 15000);
    } catch (e) { info(e.message, true); }
  };
  window.efRemover = async function () {
    var cx = est.editando;
    if (!cx || cx.novo) return;
    if (est.removendo !== cx.id) { est.removendo = cx.id; formulario(); return; }
    try {
      await postar('/api/email-financeiro/caixas/' + encodeURIComponent(cx.id) + '/remover', { confirmacao: 'REMOVER' });
      toast('Caixa removida do Hub. Os emails continuam na caixa.', 'ok');
      est.editando = null; est.removendo = null;
      carregar();
    } catch (e) { formInfo(e.message, true); }
  };
  var NOME_STATUS = { ok: 'lido', sem_anexo: 'sem documento', erro: 'vai tentar de novo', falhou: 'não deu para ler', ignorado: 'pulado' };
  window.efMensagens = async function (id) {
    var alvo = document.getElementById('ef-msgs');
    if (!alvo) return;
    alvo.innerHTML = '<div style="font-size:12px;color:var(--muted)">Carregando...</div>';
    try {
      var j = await api('/api/email-financeiro/caixas/' + encodeURIComponent(id) + '/mensagens');
      var l = j.mensagens || [];
      alvo.innerHTML = l.length ? '<table class="data-table" style="width:100%;font-size:12px;margin-top:8px"><thead><tr><th>Recebido</th><th>Remetente</th><th>Assunto</th><th>Situação</th><th>Itens</th></tr></thead><tbody>' +
        l.map(function (m) {
          return '<tr><td>' + esc(dataHoraBR(m.recebido_em || m.criado_em)) + '</td><td class="td-livre">' + esc(m.remetente || '') + '</td><td class="td-livre">' + esc(m.assunto || '') + '</td><td>' + esc(NOME_STATUS[m.status] || m.status) + '</td><td>' + esc((m.entradas || []).length) + '</td></tr>';
        }).join('') + '</tbody></table>' : '<div style="font-size:12px;color:var(--muted);margin-top:8px">Nenhum email lido ainda nesta caixa.</div>';
    } catch (e) { alvo.innerHTML = '<div style="font-size:12px;color:var(--danger)">' + esc(e.message) + '</div>'; }
  };
})();
