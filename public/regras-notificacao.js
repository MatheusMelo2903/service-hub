// ============================================================
// REGRAS DO CONDOMÍNIO: NOTIFICAÇÃO E MULTA (frente C)
// Monta dentro de #regras-notificacao (aba Regras do condomínio). A unidade, o proprietário,
// o inquilino e a taxa do mês anterior vêm do Superlógica; o histórico da unidade (inclusive o
// importado do sistema anterior) fica guardado; a carta cita só o que foi conferido no acervo.
// Registrar no Superlógica usa a rota que já existe (/api/multas/registrar) e só com a
// confirmação marcada na tela; depois marca a notificação como registrada.
// Rotas: /api/regras/:id/unidades, /unidade/:idUnidade, /notificacao/rascunho, /notificacao,
// /notificacoes, PATCH /api/regras/notificacao/:id, /api/condominio/:id/multa-opcoes.
// ============================================================
(function () {
  var RN = {
    montado: false, idCond: null, unidades: [], unidade: null, rascunho: null, salva: null,
    cabecalho: null, opcoes: null, seq: 0, lista: [],
    // Passo a passo: modo (guiado ou manual), passo atual e o mais longe já alcançado, se os
    // dados mudaram depois da análise, unidades possíveis achadas no texto e se a unidade foi
    // escolhida pela pessoa no seletor.
    modo: 'guiado', passo: 1, maxPasso: 1, mudou: false, candidatos: null, unidadeConfirmada: false,
    promUnidades: null, analisando: false, analise: null, assinatura: '',
  };
  var NOME_TIPO = { advertencia: 'Advertência', multa: 'Multa' };
  var NOME_STATUS = { rascunho: 'Rascunho', registrada: 'Registrada', regularizada: 'Regularizada', convertida_multa: 'Convertida em multa', cancelada: 'Cancelada' };
  var COR_STATUS = { rascunho: 'badge-send', registrada: 'badge-warn', regularizada: 'badge-ok', convertida_multa: 'badge-err', cancelada: '' };
  var ESTILO_CAMPO = 'background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px 12px;color:var(--text);font-family:var(--mono);font-size:13px;width:100%;box-sizing:border-box';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(id) { return document.getElementById(id); }
  function val(id) { var el = $(id); return el ? el.value : ''; }
  function setVal(id, v) { var el = $(id); if (el) el.value = v == null ? '' : v; }
  function cond() { return (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : null; }
  function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function brDeIso(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  // DD/MM/AAAA para MM/DD/AAAA (formato do Superlógica); vazio se inválida.
  function dataApi(br) {
    var m = String(br || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return '';
    var d = +m[1], mm = +m[2];
    if (d < 1 || d > 31 || mm < 1 || mm > 12) return '';
    return String(mm).padStart(2, '0') + '/' + String(d).padStart(2, '0') + '/' + m[3];
  }
  function hojeBR() { var d = new Date(); return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear(); }
  // "1.234,56", "150,50" ou "150.50" para número; formato ambíguo devolve null.
  function numBR(t) {
    var s = String(t || '').trim();
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
    if (/^\d+([.,]\d{1,2})?$/.test(s)) return Number(s.replace(',', '.'));
    return null;
  }

  // Chamada com o login; erro vira exceção com a mensagem do servidor.
  // gravar: true quando a chamada grava no Superlógica (janela de confirmação em confirmar-gravacao.js).
  async function api(url, metodo, corpo, gravar) {
    var op = { method: metodo || 'GET' };
    if (corpo !== undefined) { op.headers = { 'Content-Type': 'application/json' }; op.body = JSON.stringify(corpo); }
    var r = await (gravar && window.gravarNoSuperlogica ? window.gravarNoSuperlogica : apiAuthFetch)(url, op);
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.detalhe || ('Falha ' + r.status)); e.status = r.status; e.corpo = j; throw e; }
    j._status = r.status;
    return j;
  }
  function base() { return '/api/regras/' + encodeURIComponent(RN.idCond); }

  // Estrutura da tela (uma vez). Tudo dentro de #regras-notificacao.
  // No topo fica o passo a passo (1 Conte o caso, 2 Análise, 3 Notificação). Os campos da unidade
  // e do fato existem uma vez só e mudam de lugar conforme o passo (moverBlocos): assim as funções
  // de hoje (gerar, salvar, registrar) continuam lendo os mesmos campos, no modo guiado e no manual.
  function montar(box) {
    box.innerHTML =
      '<div class="card" id="rn-cartao">' +
        '<div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><span class="card-title">Notificação ou multa para unidade</span>' +
          '<a href="#" id="rn-modo" style="font-size:12px;color:var(--accent)">preencher manualmente</a></div>' +
        '<div class="tabs" id="rn-passos" style="margin-bottom:14px">' +
          '<div class="tab active" data-rn-passo="1">1 Conte o caso</div>' +
          '<div class="tab" data-rn-passo="2">2 Análise</div>' +
          '<div class="tab" data-rn-passo="3">3 Notificação</div>' +
        '</div>' +
        '<div id="rn-p1">' +
          '<div class="form-group" style="margin:0"><label>Conte o caso</label><textarea id="rn-caso" rows="4" style="' + ESTILO_CAMPO + '" placeholder="Descreva o que aconteceu, como contaria para alguém. Ex.: o morador do 302 bloco D fez barulho alto depois das 22h no sábado, 18/10."></textarea></div>' +
          '<div id="rn-p1-aviso" style="font-size:13px;margin-top:8px"></div>' +
          '<div id="rn-p1-vaga"></div>' +
          '<button class="btn btn-primary" id="rn-analisar" style="margin-top:10px">Analisar o caso</button>' +
        '</div>' +
        '<div id="rn-p2" style="display:none;border-top:1px solid var(--border);margin-top:16px;padding-top:14px">' +
          '<div style="font-weight:600;font-size:13px;margin-bottom:10px">Análise</div>' +
          '<div id="rn-analise" style="font-size:13px"></div>' +
          '<div id="rn-p2-corrigir" style="margin-top:14px"><div style="font-size:11px;font-family:var(--mono);color:var(--muted);margin-bottom:6px">CORRIJA SE PRECISAR</div><div id="rn-p2-vaga"></div></div>' +
          '<div id="rn-p2-acoes" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">' +
            '<button class="btn btn-primary" id="rn-confirmar">Está certo, montar a notificação</button>' +
            '<button class="btn btn-ghost" id="rn-reanalisar">Analisar de novo</button>' +
          '</div>' +
          '<div id="rn-p2-mudou" style="font-size:12px;color:var(--warning);margin-top:6px"></div>' +
        '</div>' +
        '<div id="rn-p3" style="display:none;border-top:1px solid var(--border);margin-top:16px;padding-top:14px">' +
          '<div style="font-weight:600;font-size:13px;margin-bottom:10px">Notificação</div>' +
          '<div id="rn-p3-vaga"></div>' +
          '<button class="btn btn-primary" id="rn-gerar" style="margin-top:10px">Gerar notificação</button>' +
          '<div id="rn-resultado" style="display:none;margin-top:16px">' +
            '<div id="rn-sugestao" style="padding:10px 12px;border:1px solid var(--border2);border-radius:8px;font-size:13px;margin-bottom:12px"></div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">' +
              '<div>' +
                '<div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">' +
                  '<div class="form-group" style="margin:0"><label>Título</label><input type="text" id="rn-titulo" autocomplete="off"></div>' +
                  '<div class="form-group" style="margin:0"><label>Vai como</label><select id="rn-tipo"><option value="advertencia">Advertência</option><option value="multa">Multa</option></select></div>' +
                '</div>' +
                '<div class="form-group" style="margin-top:10px"><label>Carta (revise aqui)</label><textarea id="rn-texto" rows="18" style="' + ESTILO_CAMPO + '"></textarea></div>' +
              '</div>' +
              '<div>' +
                '<div id="rn-valor" style="font-size:13px;margin-bottom:10px"></div>' +
                '<div id="rn-prazo" style="font-size:13px;margin-bottom:10px"></div>' +
                '<div id="rn-pendencias" style="font-size:12px;color:var(--warning);margin-bottom:10px"></div>' +
                '<label style="font-size:11px;font-family:var(--mono);color:var(--muted)">FUNDAMENTOS CONFERIDOS NO ACERVO</label>' +
                '<div id="rn-fundamentos" style="font-size:12px;margin-top:6px"></div>' +
              '</div>' +
            '</div>' +
            '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">' +
              '<button class="btn btn-ghost" id="rn-salvar">Salvar rascunho</button>' +
              '<button class="btn btn-ghost" id="rn-pdf">Baixar carta em PDF</button>' +
              '<button class="btn btn-ghost" id="rn-regularizada">Marcar regularizada</button>' +
            '</div>' +
            '<div id="rn-salvo" style="font-size:12px;font-family:var(--mono);color:var(--muted);margin-top:8px"></div>' +
            '<div style="border-top:1px solid var(--border);margin-top:14px;padding-top:12px">' +
              '<div style="font-weight:600;font-size:13px;margin-bottom:8px">Registrar no Superlógica</div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
                '<div class="form-group" style="margin:0"><label>Notificar</label><select id="rn-notificar"><option value="1">Não notificar</option><option value="3">Proprietário</option><option value="2">Inquilino</option></select></div>' +
                '<label style="display:flex;gap:8px;align-items:center;font-size:12px"><input type="checkbox" id="rn-email"> Avisar por email</label>' +
                '<label style="display:flex;gap:8px;align-items:center;font-size:12px"><input type="checkbox" id="rn-carta"> Gerar carta no Superlógica</label>' +
              '</div>' +
              '<label style="display:flex;gap:8px;align-items:center;font-size:12px;margin-top:10px"><input type="checkbox" id="rn-cobrar"> Lançar a cobrança da multa (se estiver travada pela administração, registra só a ocorrência)</label>' +
              '<div id="rn-cobranca" style="display:none;grid-template-columns:1fr 1fr 1fr 2fr;gap:12px;margin-top:8px">' +
                '<div class="form-group" style="margin:0"><label>Valor R$</label><input type="text" id="rn-cob-valor" inputmode="decimal" autocomplete="off"></div>' +
                '<div class="form-group" style="margin:0"><label>Vencimento</label><input type="text" id="rn-cob-venc" placeholder="DD/MM/AAAA" autocomplete="off"></div>' +
                '<div class="form-group" style="margin:0"><label>Conta categoria</label><input type="text" id="rn-cob-cat" placeholder="ex: 1.9" autocomplete="off"></div>' +
                '<div class="form-group" style="margin:0"><label>Conta bancária</label><select id="rn-cob-conta"><option value="">Carregando...</option></select></div>' +
              '</div>' +
              '<label style="display:flex;gap:8px;align-items:center;font-size:12px;margin-top:10px;color:var(--warning)"><input type="checkbox" id="rn-confirma"> <span id="rn-confirma-rotulo">Confirmo registrar</span></label>' +
              '<div style="margin-top:10px"><button class="btn btn-primary" id="rn-registrar" disabled>Registrar no Superlógica</button></div>' +
              '<div id="rn-registro" style="font-size:12px;font-family:var(--mono);color:var(--muted);margin-top:8px"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // Guarda dos blocos de campos enquanto o passo atual não usa nenhum deles.
        '<div id="rn-guarda" style="display:none">' +
          '<div id="rn-bloco-unidade">' +
            '<div style="display:grid;grid-template-columns:1fr 2fr;gap:12px">' +
              '<div class="form-group" style="margin:0"><label>Buscar unidade</label><input type="text" id="rn-busca" autocomplete="off" placeholder="número, bloco ou nome"></div>' +
              '<div class="form-group" style="margin:0"><label>Unidade</label><select id="rn-unidade"><option value="">Carregando unidades...</option></select></div>' +
            '</div>' +
            '<div id="rn-ficha" style="margin-top:12px;font-size:13px"></div>' +
          '</div>' +
          '<div id="rn-bloco-fato" style="display:grid;grid-template-columns:3fr 1fr 1fr;gap:12px;margin-top:12px">' +
            '<div class="form-group" style="margin:0"><label>O que aconteceu</label><textarea id="rn-relato" rows="4" style="' + ESTILO_CAMPO + '" placeholder="ex: barulho alto após as 22h, relatado pela portaria e por dois vizinhos"></textarea></div>' +
            '<div class="form-group" style="margin:0"><label id="rn-data-rotulo">Data do fato</label><input type="text" id="rn-data" placeholder="DD/MM/AAAA" autocomplete="off"><div id="rn-data-aviso" style="font-size:11px;color:var(--warning);margin-top:4px"></div></div>' +
            '<div class="form-group" style="margin:0"><label>Tipo</label><select id="rn-tipo-pedido"><option value="">Sugerir pela regra</option><option value="advertencia">Advertência</option><option value="multa">Multa</option></select></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><span class="card-title">Notificações do condomínio</span></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:12px;align-items:end">' +
          '<div class="form-group" style="margin:0"><label>Tipo</label><select id="rn-f-tipo"><option value="">Todos</option><option value="advertencia">Advertência</option><option value="multa">Multa</option></select></div>' +
          '<div class="form-group" style="margin:0"><label>Situação</label><select id="rn-f-status"><option value="">Todas</option><option value="rascunho">Rascunho</option><option value="registrada">Registrada</option><option value="regularizada">Regularizada</option><option value="convertida_multa">Convertida em multa</option><option value="cancelada">Cancelada</option></select></div>' +
          '<div class="form-group" style="margin:0"><label>Unidade</label><input type="text" id="rn-f-unidade" autocomplete="off" placeholder="ex: 101"></div>' +
          '<button class="btn btn-ghost" id="rn-f-aplicar">Filtrar</button>' +
        '</div>' +
        '<div id="rn-lista" style="margin-top:12px;font-size:13px"></div>' +
      '</div>';
    ligarEventos(box);
    RN.montado = true;
    aplicarModo();
  }

  // Eventos por delegação: a tela é montada uma vez e reaproveitada ao trocar de condomínio.
  function ligarEventos(box) {
    box.addEventListener('click', function (e) {
      var t = e.target; if (!t) return;
      if (t.id === 'rn-modo') { e.preventDefault(); RN.modo = RN.modo === 'manual' ? 'guiado' : 'manual'; aplicarModo(); }
      else if (t.id === 'rn-analisar') analisar();
      else if (t.id === 'rn-reanalisar') pedirAnalise();
      else if (t.id === 'rn-confirmar') montarNotificacao();
      else if (t.dataset && t.dataset.rnPasso) irPasso(Number(t.dataset.rnPasso));
      else if (t.dataset && t.dataset.rnDoc) abrirDocumento(t.dataset.rnDoc, t.dataset.rnPag);
      else if (t.id === 'rn-gerar') gerar();
      else if (t.id === 'rn-salvar') salvar();
      else if (t.id === 'rn-pdf') baixarPdf();
      else if (t.id === 'rn-regularizada') { if (RN.salva) mudarStatus(RN.salva.id, 'regularizada'); else toast('Salve a notificação primeiro', 'err'); }
      else if (t.id === 'rn-registrar') registrar();
      else if (t.id === 'rn-f-aplicar') carregarLista();
      else if (t.dataset && t.dataset.rnAbrir) abrirDaLista(Number(t.dataset.rnAbrir));
      else if (t.dataset && t.dataset.rnStatus) {
        var p = t.dataset.rnStatus.split('|');
        if (p[1] === 'cancelada' && !confirm('Cancelar esta notificação? Ela continua no histórico como cancelada.')) return;
        mudarStatus(Number(p[0]), p[1]);
      }
    });
    box.addEventListener('input', function (e) {
      var t = e.target; if (!t || !t.id) return;
      if (t.id === 'rn-busca') filtrarUnidades();
      if (t.id === 'rn-data') marcarData(false);
      if (t.id === 'rn-relato' || t.id === 'rn-data') marcarMudou();
      if (/^rn-(titulo|texto|tipo|notificar|email|carta|cobrar|cob-)/.test(t.id)) desmarcar();
    });
    box.addEventListener('change', function (e) {
      var t = e.target; if (!t || !t.id) return;
      // Escolha feita pela pessoa vale mais que a unidade achada no texto (ver analisar).
      if (t.id === 'rn-unidade') { RN.unidadeConfirmada = !!val('rn-unidade'); marcarMudou(); escolherUnidade(); }
      if (t.id === 'rn-tipo-pedido') marcarMudou();
      if (t.id === 'rn-cobrar') { $('rn-cobranca').style.display = t.checked ? 'grid' : 'none'; if (t.checked) carregarOpcoes(); }
      if (t.id === 'rn-confirma') { $('rn-registrar').disabled = !t.checked; }
      else if (/^rn-(tipo|notificar|email|carta|cobrar|cob-)/.test(t.id)) desmarcar();
    });
  }

  // Qualquer mudança desmarca a confirmação: confirma o que está na tela agora.
  function desmarcar() {
    var cb = $('rn-confirma'); if (cb) cb.checked = false;
    var bt = $('rn-registrar'); if (bt) bt.disabled = true;
    rotuloConfirma();
  }
  function textoOpcao(id) { var s = $(id); return s && s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : ''; }
  function rotuloConfirma() {
    var lab = $('rn-confirma-rotulo'); if (!lab) return;
    var c = cond();
    var nome = c && c.nome ? c.nome + (c.id_superlogica ? ' (código ' + c.id_superlogica + ')' : '') : 'nenhum condomínio';
    var u = RN.unidade;
    var v = numBR(val('rn-cob-valor'));
    lab.textContent = 'Confirmo registrar ' + (val('rn-tipo') === 'multa' ? 'infração com multa' : 'advertência') + ' no condomínio ' + nome +
      ', unidade ' + (u ? u.rotulo : 'não escolhida') + ', notificar: ' + textoOpcao('rn-notificar').toLowerCase() +
      ($('rn-email') && $('rn-email').checked ? ' (com email, sai na hora)' : '') +
      ($('rn-cobrar') && $('rn-cobrar').checked ? ', cobrança de ' + (v == null ? 'valor inválido' : brl(v)) + ' com vencimento ' + (val('rn-cob-venc') || 'não informado') : '');
  }

  // ─── Unidades ───
  function carregarUnidades() {
    RN.promUnidades = lerUnidades();
    return RN.promUnidades;
  }
  async function lerUnidades() {
    var sel = $('rn-unidade'); if (!sel) return;
    var seq = ++RN.seq;
    sel.innerHTML = '<option value="">Carregando unidades...</option>';
    try {
      var j = await api(base() + '/unidades');
      if (seq !== RN.seq) return;
      RN.unidades = j.unidades || [];
      filtrarUnidades();
      if (j.cortado) toast('O condomínio tem muitas unidades; a lista pode estar incompleta.', 'warn');
    } catch (e) {
      if (seq !== RN.seq) return;
      sel.innerHTML = '<option value="">' + esc(e.message) + '</option>';
    }
  }
  function filtrarUnidades() {
    var sel = $('rn-unidade'); if (!sel) return;
    var q = val('rn-busca').trim().toLowerCase();
    var atual = sel.value;
    // Sem busca digitada e com unidades possíveis achadas no texto, a lista mostra só elas.
    var cand = !q && RN.candidatos && RN.candidatos.length ? RN.candidatos : null;
    var lista = RN.unidades.filter(function (u) {
      if (cand) return cand.indexOf(u.id_unidade) >= 0;
      if (!q) return true;
      return (u.rotulo + ' ' + (u.proprietario || '') + ' ' + (u.inquilino || '')).toLowerCase().indexOf(q) !== -1;
    });
    var mostrar = lista.slice(0, 400);
    // A unidade já escolhida continua na lista mesmo além do corte de 400 (senão o seletor a perde).
    if (atual && !mostrar.some(function (u) { return String(u.id_unidade) === atual; })) {
      var ja = lista.find(function (u) { return String(u.id_unidade) === atual; });
      if (ja) mostrar.push(ja);
    }
    sel.innerHTML = '<option value="">' + (lista.length ? 'Escolha a unidade (' + lista.length + ')' : 'Nenhuma unidade encontrada') + '</option>' + mostrar.map(function (u) {
      return '<option value="' + Number(u.id_unidade) + '"' + (String(u.id_unidade) === atual ? ' selected' : '') + '>' + esc(u.rotulo + (u.proprietario ? ' · ' + u.proprietario : '') + (u.inquilino ? ' · inquilino ' + u.inquilino : '')) + '</option>';
    }).join('');
  }

  // Ficha da unidade: proprietário, inquilino, taxa do mês anterior e histórico.
  async function escolherUnidade() {
    var id = Number(val('rn-unidade'));
    var ficha = $('rn-ficha');
    RN.unidade = null; limparResultado();
    if (!id) { ficha.innerHTML = ''; return; }
    ficha.innerHTML = '<span style="color:var(--muted)">Lendo a unidade...</span>';
    var seq = ++RN.seq;
    try {
      var j = await api(base() + '/unidade/' + id);
      if (seq !== RN.seq) return;
      RN.unidade = j.unidade;
      ficha.innerHTML = htmlFicha(j.unidade, j.historico || [], j.aviso_reincidencia);
      rotuloConfirma();
    } catch (e) {
      if (seq !== RN.seq) return;
      ficha.innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>';
    }
  }
  function htmlFicha(u, hist, aviso) {
    var tx = u.taxa || {};
    var taxa = tx.valor != null ? brl(tx.valor) + ' (vencimento em ' + esc(tx.competencia) + ')' : '<span style="color:var(--warning)">não calculada: ' + esc(tx.motivo || 'sem leitura') + '</span>';
    var h = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">' +
      '<div><div style="font-size:11px;color:var(--muted)">PROPRIETÁRIO</div>' + esc(u.proprietario || 'não cadastrado') + (u.email_proprietario ? '<div style="font-size:11px;color:var(--muted)">' + esc(u.email_proprietario) + '</div>' : '') + '</div>' +
      '<div><div style="font-size:11px;color:var(--muted)">INQUILINO</div>' + esc(u.inquilino || 'nenhum') + (u.email_inquilino ? '<div style="font-size:11px;color:var(--muted)">' + esc(u.email_inquilino) + '</div>' : '') + '</div>' +
      '<div><div style="font-size:11px;color:var(--muted)">TAXA ORDINÁRIA DO MÊS ANTERIOR</div>' + taxa + '</div>' +
      '</div>';
    h += '<div style="margin-top:10px"><div style="font-size:11px;color:var(--muted)">HISTÓRICO DA UNIDADE</div>';
    if (aviso) h += '<div style="color:var(--warning);margin:4px 0">' + esc(aviso) + '</div>';
    h += hist.length ? hist.map(function (x) {
      return '<div style="padding:4px 0;border-bottom:1px solid var(--border)">' + esc(x.data || 'sem data') + ' · ' + esc(NOME_TIPO[x.tipo] || x.tipo) + ' · ' + esc(NOME_STATUS[x.status] || x.status) +
        (x.origem === 'condgpt' ? ' · importada' : '') + (x.valor != null ? ' · ' + brl(x.valor) : '') + (x.ocorrencia ? '<div style="color:var(--muted);font-size:12px">' + esc(x.ocorrencia) + '</div>' : '') + '</div>';
    }).join('') : '<div style="color:var(--muted)">Nenhuma notificação anterior.</div>';
    return h + '</div>';
  }

  function limparResultado() {
    RN.rascunho = null; RN.salva = null;
    var r = $('rn-resultado'); if (r) r.style.display = 'none';
    ['rn-titulo', 'rn-texto', 'rn-cob-valor', 'rn-cob-venc'].forEach(function (k) { setVal(k, ''); });
    ['rn-salvo', 'rn-registro', 'rn-fundamentos', 'rn-valor', 'rn-prazo', 'rn-pendencias', 'rn-sugestao'].forEach(function (k) { var el = $(k); if (el) el.textContent = ''; });
    desmarcar();
  }

  // ─── Gerar ───
  async function gerar() {
    if (!RN.unidade) { toast('Escolha a unidade primeiro', 'err'); return; }
    var relato = val('rn-relato').trim();
    if (relato.length < 10) { toast('Conte o que aconteceu', 'err'); return; }
    var data = val('rn-data').trim();
    if (data && !dataApi(data)) { toast('Data do fato inválida (use DD/MM/AAAA)', 'err'); return; }
    var bt = $('rn-gerar'); bt.disabled = true; var t0 = bt.textContent; bt.textContent = 'Gerando...';
    try {
      var r = await api(base() + '/notificacao/rascunho', 'POST', { id_unidade: RN.unidade.id_unidade, relato: relato, data_fato: data || null, tipo_pedido: val('rn-tipo-pedido') || undefined });
      RN.rascunho = r; RN.salva = null; RN.cabecalho = r.cabecalho || RN.cabecalho;
      mostrarRascunho(r);
      // No passo a passo a análise acima acompanha a carta gerada de novo.
      if (RN.modo === 'guiado') { RN.analise = r; RN.assinatura = assinaturaAtual(); mostrarAnalise(r); RN.mudou = false; }
      toast('Notificação gerada. Revise antes de salvar ou registrar; o que estiver como [a confirmar] precisa ser preenchido.', 'ok');
    } catch (e) { toast('Não foi possível gerar: ' + e.message, 'err'); }
    finally { bt.disabled = false; bt.textContent = t0; }
  }

  function mostrarRascunho(r) {
    $('rn-resultado').style.display = '';
    $('rn-sugestao').innerHTML = '<b>Sugestão: ' + esc(NOME_TIPO[r.tipo_sugerido] || '') + '.</b> ' + esc(r.motivo_sugestao || '') +
      (r.aviso_reincidencia ? '<div style="color:var(--warning);margin-top:4px">' + esc(r.aviso_reincidencia) + '</div>' : '');
    setVal('rn-titulo', r.titulo); setVal('rn-texto', r.texto); setVal('rn-tipo', r.tipo);
    var v = r.valor || {};
    $('rn-valor').innerHTML = r.tipo === 'multa' || v.valor != null
      ? '<div style="font-size:11px;color:var(--muted)">VALOR DA MULTA</div>' + (v.valor != null ? '<b>' + brl(v.valor) + '</b><div style="font-size:12px;color:var(--muted)">' + esc(v.conta || '') + '</div>' : '<span style="color:var(--warning)">' + esc(v.motivo || '[a confirmar]') + '</span>') +
        (v.reincidencia && !v.reincidencia.aplicada ? '<div style="font-size:12px;color:var(--muted)">Reincidência: ' + esc(v.reincidencia.motivo) + '</div>' : '')
      : '';
    var p = r.prazo || {};
    $('rn-prazo').innerHTML = '<div style="font-size:11px;color:var(--muted)">PRAZO PARA REGULARIZAR</div>' + (p.dias ? p.dias + ' dias' + (p.data_estimada ? ' (até cerca de ' + esc(brDeIso(p.data_estimada)) + ')' : '') : '<span style="color:var(--warning)">[a confirmar]</span>');
    $('rn-pendencias').innerHTML = (r.a_confirmar || []).length ? 'A confirmar: ' + r.a_confirmar.map(esc).join('; ') + '.' : '';
    mostrarFundamentos(r.fundamentos || [], r.recusados);
    if (v.valor != null) setVal('rn-cob-valor', String(v.valor.toFixed(2)).replace('.', ','));
    $('rn-salvo').textContent = '';
    $('rn-registro').textContent = '';
    if (RN.unidade && RN.unidade.inquilino) $('rn-notificar').value = '2'; else $('rn-notificar').value = '3';
    desmarcar();
  }
  function mostrarFundamentos(fund, recusados) {
    var box = $('rn-fundamentos'); if (!box) return;
    box.innerHTML = fund.length ? fund.map(function (f) {
      return '<div style="padding:6px 0;border-bottom:1px solid var(--border)"><b>' + esc(f.rotulo || 'Trecho') + '</b> · ' + esc(f.documento || f.tipo || '') + '<div style="color:var(--muted)">"' + esc(f.citacao) + '"</div></div>';
    }).join('') : '<div style="color:var(--warning)">Nenhum trecho do acervo foi conferido para esta notificação.</div>';
    if (recusados) box.innerHTML += '<div style="color:var(--muted);margin-top:4px">' + recusados + ' citação' + (recusados === 1 ? '' : 'ões') + ' sem apoio no acervo ficou de fora.</div>';
  }

  // ─── Leitura do caso contado (funções puras, testadas em scripts/teste-regras-caso.js) ───
  // O navegador tenta achar a unidade e a data no texto livre antes de chamar o servidor. O que
  // não der para achar com segurança fica para a pessoa escolher: nunca chuta entre duas unidades.
  var RC = (function () {
    var MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    var SEMANA = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    var PALAVRA_UNIDADE = /(?:^|[^A-Za-z])(?:apto|apartamento|apart|ap|apt|unidade|unid|casa|lote|sala|loja|cobertura|cob|numero|n|do|da|no|na)\.?\s*(?:n?[oº°]\.?\s*)?[:#]?\s*(?:[A-Za-z]\s*[\/-]?\s*)?$/i;
    var PALAVRA_BLOCO = /\b(bloco|bl|torre|tr|edificio|ed|predio|quadra|qd)\b\.?\s*([A-Za-z0-9]{1,12})\b/gi;
    var NAO_BLOCO = /^(de|do|da|dos|das|e|o|a|os|as|no|na|que|em|ao)$/i;

    function semAcento(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, ''); }
    function semZero(s) { return String(s).replace(/^0+(?=\d)/, ''); }
    function branco(m) { return m.replace(/[^\n]/g, ' '); }
    function dd(n) { return String(n).padStart(2, '0'); }
    function br(d) { return dd(d.getDate()) + '/' + dd(d.getMonth() + 1) + '/' + d.getFullYear(); }

    // Número da unidade como chave de comparação: "Apto 0302" vira "302", "Casa 15A" vira "15a".
    function chaveNumero(unidade) {
      var s = semAcento(unidade).toLowerCase().replace(/\b(apto|apartamento|apart|ap|apt|unidade|unid|casa|lote|sala|loja|cobertura|cob)\b\.?/g, ' ').replace(/[\s\/._-]+/g, '');
      return /\d/.test(s) ? semZero(s) : '';
    }
    // Bloco como chave: "Bloco D" vira "d", "Torre 02" vira "2".
    function chaveBloco(bloco) {
      return semZero(semAcento(bloco).toLowerCase().replace(/^\s*(bloco|bl|torre|tr|edificio|ed|predio|quadra|qd)\b\.?\s*/, '').replace(/\s+/g, ' ').trim());
    }

    // Apaga (com espaços, para manter as posições) o que tem número mas não é unidade: datas,
    // horas, dinheiro, quantidades e andares. Assim "22h" e "18/10" não viram unidade.
    function limparNumeros(s) {
      var meses = MESES.join('|');
      return s
        .replace(/\b\d{1,2}\s*\/\s*\d{1,2}(?:\s*\/\s*\d{2,4})?(?![\d\/])/g, branco)
        .replace(/\b\d{1,2}\s*(?:h|hs|hrs?|horas?)(?:\s*\d{1,2}(?:\s*min(?:utos)?)?)?\b/gi, branco)
        .replace(/\b\d{1,2}:\d{2}\b/g, branco)
        .replace(/r\$\s*[\d.,]+/gi, branco)
        .replace(/\b[\d.,]+\s*reais\b/gi, branco)
        .replace(/\bdia\s+\d{1,2}\b/gi, branco)
        .replace(new RegExp('\\b\\d{1,2}\\s*(?:º\\s*)?de\\s+(?:' + meses + ')(?:\\s+de\\s+\\d{4})?\\b', 'gi'), branco)
        .replace(/\b\d+\s*(?:dias?|vezes|pessoas|vizinhos|moradores|anos|meses|semanas|minutos|min|horas|cachorros?|caes|gatos?|animais|carros?|veiculos|motos?|vagas?|metros|m2|kg|andares)\b/gi, branco)
        .replace(/\d+\s*%/g, branco)
        .replace(/\b\d+\s*(?:[º°ª]|o\b)\s*(?:andar|pavimento)?/gi, branco);
    }

    // Letra colada ao número ("302D", "D302", "302/D") ou maiúscula com espaço ("302 D") pode
    // ser bloco. Minúscula solta só se não for palavra comum ("302 e 303" não tem bloco E).
    function letraValida(letra, sep) {
      if (!letra) return false;
      if (/[\/-]/.test(sep) || sep === '') return true;
      if (letra === letra.toUpperCase()) return true;
      return 'aeon'.indexOf(letra) < 0;
    }

    // Unidades do condomínio citadas no texto. lista: [{ id_unidade, unidade, bloco, rotulo }].
    // Devolve as unidades possíveis (zero, uma ou várias), sem repetir.
    function acharUnidades(texto, lista) {
      var unidades = (lista || []).map(function (u) { return { u: u, num: chaveNumero(u.unidade), bloco: chaveBloco(u.bloco) }; }).filter(function (x) { return x.num; });
      if (!unidades.length) return [];
      var porNum = {};
      unidades.forEach(function (x) { (porNum[x.num] = porNum[x.num] || []).push(x); });
      var s = limparNumeros(semAcento(texto));
      // Menções de bloco ("bloco D", "torre 2"); o número do bloco não conta como unidade.
      var blocos = [];
      s = s.replace(PALAVRA_BLOCO, function (m, _p, v, pos) {
        // Letra sozinha depois de bloco ou torre é o bloco ("bloco A"), mesmo sendo artigo em outras frases.
        if (v.length === 1 || !NAO_BLOCO.test(v)) blocos.push({ ini: pos, fim: pos + m.length, chave: semZero(v.toLowerCase()) });
        return branco(m);
      });
      var fortes = [], fracas = [];
      var re = /(^|[^\d])(\d{1,6})(?!\d)/g, m;
      while ((m = re.exec(s))) {
        var dig = m[2];
        if (dig.length > 5) continue;
        var ini = m.index + m[1].length, fim = ini + dig.length;
        var numero = semZero(dig);
        if (numero === '0') continue;
        var antes = s.slice(Math.max(0, ini - 30), ini), depois = s.slice(fim, fim + 30);
        var dicas = [];
        var letras = [];
        var pre = antes.match(/(?:^|[^A-Za-z0-9])([A-Za-z])(\s*[\/-]?\s*)$/);
        if (pre && letraValida(pre[1], pre[2])) letras.push(pre[1].toLowerCase());
        var suf = depois.match(/^(\s*[\/-]?\s*)([A-Za-z])(?![A-Za-z0-9])/);
        if (suf && letraValida(suf[2], suf[1])) letras.push(suf[2].toLowerCase());
        dicas = letras.slice();
        // Bloco citado por extenso mais perto deste número (até 60 caracteres de distância).
        var perto = null, dist = 61;
        blocos.forEach(function (b) {
          var d = b.fim <= ini ? ini - b.fim : (b.ini >= fim ? b.ini - fim : 0);
          if (d < dist) { dist = d; perto = b; }
        });
        if (perto) dicas.push(perto.chave);
        var achadas = [];
        // A letra pode ser parte do número da unidade ("15A") e não bloco.
        letras.forEach(function (l) { [numero + l, l + numero].forEach(function (k) { (porNum[k] || []).forEach(function (x) { achadas.push(x); }); }); });
        var base = porNum[numero] || [];
        var temBloco = base.some(function (x) { return x.bloco; });
        var filtradas = base;
        if (temBloco && dicas.length) {
          filtradas = base.filter(function (x) { return dicas.indexOf(x.bloco) >= 0; });
          // Letra que não é bloco nenhum: só fica tudo se ela também não for parte do número.
          if (!filtradas.length) filtradas = achadas.length ? [] : base;
        } else if (achadas.length) {
          // "15A" existe como unidade: a letra é do número, não sobra a "15" sem letra.
          filtradas = [];
        }
        achadas = achadas.concat(filtradas);
        if (!achadas.length) continue;
        var forte = PALAVRA_UNIDADE.test(antes) || dicas.length > 0 || dig.length >= 3;
        (forte ? fortes : fracas).push.apply(forte ? fortes : fracas, achadas);
      }
      var escolhidas = fortes.length ? fortes : fracas;
      var vistos = {};
      return escolhidas.filter(function (x) { var k = String(x.u.id_unidade); if (vistos[k]) return false; vistos[k] = true; return true; }).map(function (x) { return x.u; });
    }

    function dataValida(a, m, d) {
      var dt = new Date(a, m - 1, d);
      return dt.getFullYear() === a && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
    }

    // Data do fato no texto: dd/mm, dd/mm/aaaa, "18 de outubro", "dia 18", "hoje", "ontem",
    // "anteontem" e dia da semana recente. hoje: Date de referência. Devolve { data: 'DD/MM/AAAA'
    // ou null, confirmar, motivo }. Data escrita vale mais que palavra; duas datas diferentes ou
    // nenhuma deixam vazio para a pessoa confirmar.
    function acharData(texto, hoje) {
      var h = hoje instanceof Date ? hoje : new Date();
      var base = new Date(h.getFullYear(), h.getMonth(), h.getDate());
      var t = semAcento(texto).toLowerCase();
      var escritas = [];
      var m, re;
      // Sem ano: o fato já aconteceu, então data depois de hoje é do ano passado.
      function semAno(d, mes) {
        var dt = dataValida(base.getFullYear(), mes, d);
        if (dt && dt > base) dt = dataValida(base.getFullYear() - 1, mes, d);
        return dt;
      }
      re = /(^|[^\d\/])(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{4}|\d{2}))?(?![\d\/])/g;
      while ((m = re.exec(t))) {
        var d1 = +m[2], m1 = +m[3];
        var dt1 = m[4] ? dataValida(m[4].length === 2 ? 2000 + +m[4] : +m[4], m1, d1) : semAno(d1, m1);
        if (dt1) escritas.push(dt1);
      }
      re = new RegExp('\\b(\\d{1,2})\\s*(?:º\\s*)?de\\s+(' + MESES.join('|') + ')(?:\\s+de\\s+(\\d{4}))?\\b', 'g');
      while ((m = re.exec(t))) {
        var mes2 = MESES.indexOf(m[2]) + 1;
        var dt2 = m[3] ? dataValida(+m[3], mes2, +m[1]) : semAno(+m[1], mes2);
        if (dt2) escritas.push(dt2);
      }
      re = /\bdia\s+(\d{1,2})\b(?!\s*(?:\/|de\s))/g;
      while ((m = re.exec(t))) {
        var dt3 = dataValida(base.getFullYear(), base.getMonth() + 1, +m[1]);
        if (dt3 && dt3 > base) dt3 = dataValida(base.getMonth() === 0 ? base.getFullYear() - 1 : base.getFullYear(), base.getMonth() === 0 ? 12 : base.getMonth(), +m[1]);
        if (dt3) escritas.push(dt3);
      }
      // Dia da semana: "segunda" só vale como dia ("na segunda", "segunda feira"), não "a segunda vez".
      var sem = t.match(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:\s*-?\s*feira)?\b(?!\s+(?:vez|vezes|advertencia|multa|notificacao|ocorrencia|reclamacao|infracao|unidade|andar|parte))/);
      var idxSem = sem ? SEMANA.indexOf(sem[1]) : -1;
      var distintas = escritas.filter(function (d, i) { return escritas.findIndex(function (x) { return x.getTime() === d.getTime(); }) === i; });
      if (distintas.length > 1) return { data: null, confirmar: true, motivo: 'O texto tem mais de uma data. Confirme a data do fato.' };
      if (distintas.length === 1) {
        var dx = distintas[0];
        if (dx > base) return { data: br(dx), confirmar: true, motivo: 'A data ficou no futuro. Confirme a data do fato.' };
        if (idxSem >= 0 && dx.getDay() !== idxSem) return { data: br(dx), confirmar: true, motivo: 'A data e o dia da semana do texto não batem. Confirme a data do fato.' };
        return { data: br(dx), confirmar: false, motivo: null };
      }
      var rel = null;
      if (/\banteontem\b/.test(t)) rel = -2;
      else if (/\bontem\b/.test(t)) rel = -1;
      else if (/\bhoje\b/.test(t)) rel = 0;
      if (rel !== null) {
        var dr = new Date(base.getFullYear(), base.getMonth(), base.getDate() + rel);
        if (idxSem >= 0 && dr.getDay() !== idxSem) return { data: br(dr), confirmar: true, motivo: 'A data e o dia da semana do texto não batem. Confirme a data do fato.' };
        return { data: br(dr), confirmar: false, motivo: null };
      }
      if (idxSem >= 0) {
        // Dia da semana sozinho é o mais recente que já passou; se for o de hoje, a semana passada.
        var dif = (base.getDay() - idxSem + 7) % 7;
        var ds = new Date(base.getFullYear(), base.getMonth(), base.getDate() - (dif || 7));
        return dif ? { data: br(ds), confirmar: false, motivo: null } : { data: br(ds), confirmar: true, motivo: 'Considerei o dia da semana passada. Confirme a data do fato.' };
      }
      return { data: null, confirmar: true, motivo: 'Não achei a data no texto. Confirme a data do fato.' };
    }

    return { acharUnidades: acharUnidades, acharData: acharData, chaveNumero: chaveNumero, chaveBloco: chaveBloco };
  })();

  // ─── Passo a passo (1 Conte o caso, 2 Análise, 3 Notificação) ───
  // Coloca os blocos de campos (unidade e fato) dentro da vaga do passo que os usa.
  function moverBlocos(vagaUnidade, vagaFato) {
    var bu = $('rn-bloco-unidade'), bf = $('rn-bloco-fato'), guarda = $('rn-guarda');
    if (!bu || !bf || !guarda) return;
    var vu = vagaUnidade ? $(vagaUnidade) : guarda;
    var vf = vagaFato ? $(vagaFato) : guarda;
    if (bu.parentNode !== vu) vu.appendChild(bu);
    if (bf.parentNode !== vf) vf.appendChild(bf);
  }
  function mostrar(id, sim) { var el = $(id); if (el) el.style.display = sim ? '' : 'none'; }
  function rolarAte(id) { var el = $(id); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  // Indicador: o passo atual fica ativo; passo ainda não alcançado fica apagado e não abre.
  function marcarPasso(n) {
    RN.passo = n; if (n > RN.maxPasso) RN.maxPasso = n;
    document.querySelectorAll('#rn-passos [data-rn-passo]').forEach(function (el) {
      var p = Number(el.getAttribute('data-rn-passo'));
      el.classList.toggle('active', p === n);
      el.style.opacity = p <= RN.maxPasso ? '' : '0.5';
      el.style.cursor = p <= RN.maxPasso ? 'pointer' : 'default';
    });
  }

  // Modo guiado (passo a passo) ou manual (o formulário direto, como era antes).
  function aplicarModo() {
    var manual = RN.modo === 'manual';
    var link = $('rn-modo'); if (link) link.textContent = manual ? 'voltar ao passo a passo' : 'preencher manualmente';
    mostrar('rn-passos', !manual);
    mostrar('rn-p1', !manual);
    if (manual) {
      mostrar('rn-p2', false);
      mostrarFormulario(false);
      return;
    }
    // De volta ao guiado: se já havia análise, retoma nela; senão começa do passo 1.
    if (RN.analise) voltarAnalise(false); else reiniciarPassos();
  }

  // Começo do passo a passo (condomínio trocado ou tela nova). Não apaga o texto já contado.
  function reiniciarPassos() {
    RN.analise = null; RN.mudou = false; RN.candidatos = null; RN.maxPasso = 1;
    var a = $('rn-analise'); if (a) a.innerHTML = '';
    var av = $('rn-p1-aviso'); if (av) av.innerHTML = '';
    marcarData(false);
    if (RN.modo === 'manual') { mostrarFormulario(false); return; }
    mostrar('rn-p2', false); mostrar('rn-p3', false);
    moverBlocos(null, null);
    marcarPasso(1);
  }

  function irPasso(n) {
    if (RN.modo !== 'guiado' || n > RN.maxPasso) return;
    if (n === 1) { marcarPasso(1); rolarAte('rn-p1'); }
    else if (n === 2 && RN.analise) voltarAnalise(true);
    else if (n === 3) { if (RN.passo === 3) rolarAte('rn-p3'); else montarNotificacao(); }
  }

  // Destaca a data quando ela não foi achada ou precisa ser conferida.
  function marcarData(destacar, motivo) {
    var inp = $('rn-data'), rot = $('rn-data-rotulo'), av = $('rn-data-aviso');
    if (inp) inp.style.borderColor = destacar ? 'var(--warning)' : '';
    if (rot) rot.textContent = destacar ? 'Data do fato (confirme a data)' : 'Data do fato';
    if (av) av.textContent = destacar ? (motivo || '') : '';
  }

  // Algo mudou depois da análise: a carta guardada não vale mais até analisar de novo.
  function marcarMudou() {
    if (RN.modo !== 'guiado' || RN.passo !== 2 || !RN.analise) return;
    RN.mudou = true;
    var b = $('rn-confirmar'); if (b) b.disabled = true;
    var r = $('rn-reanalisar'); if (r) r.className = 'btn btn-primary';
    var aviso = $('rn-p2-mudou'); if (aviso) aviso.textContent = 'Você mudou os dados. Clique em Analisar de novo para a análise e a carta acompanharem.';
  }
  function limparMudou() {
    RN.mudou = false;
    var b = $('rn-confirmar'); if (b) b.disabled = false;
    var r = $('rn-reanalisar'); if (r) r.className = 'btn btn-ghost';
    var aviso = $('rn-p2-mudou'); if (aviso) aviso.textContent = '';
  }

  // Põe a unidade no seletor (limpando a busca) e lê a ficha dela, se ainda não for a atual.
  async function selecionarUnidade(id) {
    setVal('rn-busca', '');
    filtrarUnidades();
    var sel = $('rn-unidade');
    if (sel && !Array.prototype.some.call(sel.options, function (o) { return o.value === String(id); })) {
      var u = RN.unidades.find(function (x) { return x.id_unidade === id; });
      if (u) sel.insertAdjacentHTML('beforeend', '<option value="' + Number(id) + '">' + esc(u.rotulo) + '</option>');
    }
    setVal('rn-unidade', String(id));
    if (RN.unidade && RN.unidade.id_unidade === id) return;
    await escolherUnidade();
  }

  // Nenhuma ou várias unidades no texto: mostra o seletor de unidade no passo 1.
  function pedirUnidade(achadas) {
    RN.candidatos = achadas.length > 1 ? achadas.map(function (u) { return u.id_unidade; }) : null;
    moverBlocos('rn-p1-vaga', null);
    setVal('rn-busca', '');
    if (!RN.unidadeConfirmada) { setVal('rn-unidade', ''); if (RN.unidade) escolherUnidade(); }
    filtrarUnidades();
    var av = $('rn-p1-aviso');
    if (av) {
      av.innerHTML = achadas.length > 1
        ? '<span style="color:var(--warning)">Achei mais de uma unidade possível no texto (' + achadas.map(function (u) { return esc(u.rotulo); }).join(', ') + '). Escolha a certa abaixo e clique em Analisar o caso.</span>'
        : '<span style="color:var(--warning)">Não achei a unidade no texto. Escolha abaixo (pode buscar pelo número, bloco ou nome) e clique em Analisar o caso.</span>';
    }
    var sel = $('rn-unidade'); if (sel && sel.focus) sel.focus();
  }

  // Passo 1: lê unidade e data no texto e pede a análise ao servidor.
  async function analisar() {
    if (RN.analisando) return;
    var texto = val('rn-caso').trim();
    if (texto.length < 10) { toast('Conte o caso com pelo menos uma frase', 'err'); return; }
    if (!RN.promUnidades && !RN.unidades.length) carregarUnidades();
    if (RN.promUnidades) await RN.promUnidades;
    var achadas = RC.acharUnidades(texto, RN.unidades);
    var id = null;
    if (achadas.length === 1) { id = achadas[0].id_unidade; RN.unidadeConfirmada = false; }
    else if (RN.unidadeConfirmada && Number(val('rn-unidade'))) id = Number(val('rn-unidade'));
    if (!id) { pedirUnidade(achadas); return; }
    RN.candidatos = null;
    var av = $('rn-p1-aviso'); if (av) av.innerHTML = '';
    var d = RC.acharData(texto, new Date());
    setVal('rn-relato', texto);
    setVal('rn-data', d.data || '');
    marcarData(!d.data || d.confirmar, d.motivo);
    await selecionarUnidade(id);
    if (!RN.unidade) { toast('Não foi possível ler a unidade escolhida. Tente de novo.', 'err'); return; }
    await pedirAnalise();
  }

  // Chama a mesma rota do rascunho (devolve análise e carta juntas) com os campos como estão.
  async function pedirAnalise() {
    if (RN.analisando) return;
    if (!RN.unidade) { toast('Escolha a unidade primeiro', 'err'); return; }
    var relato = val('rn-relato').trim();
    if (relato.length < 10) { toast('Conte o que aconteceu', 'err'); return; }
    var data = val('rn-data').trim();
    if (data && !dataApi(data)) { toast('Data do fato inválida (use DD/MM/AAAA)', 'err'); return; }
    setVal('rn-caso', relato);
    RN.analisando = true;
    var botoes = ['rn-analisar', 'rn-reanalisar'].map($).filter(Boolean);
    var textos = botoes.map(function (b) { var t0 = b.textContent; b.disabled = true; b.textContent = 'Analisando...'; return t0; });
    try {
      var r = await api(base() + '/notificacao/rascunho', 'POST', { id_unidade: RN.unidade.id_unidade, relato: relato, data_fato: data || null, tipo_pedido: val('rn-tipo-pedido') || undefined });
      // Guarda a resposta inteira: a carta dela abre no passo 3 sem chamar o servidor de novo.
      // A carta anterior (de outra análise) sai da tela antes de guardar a nova.
      limparResultado();
      RN.rascunho = r; RN.analise = r; RN.salva = null; RN.cabecalho = r.cabecalho || RN.cabecalho;
      RN.assinatura = assinaturaAtual();
      mostrarAnalise(r);
      voltarAnalise(true);
    } catch (e) { toast('Não foi possível analisar: ' + e.message, 'err'); }
    finally {
      RN.analisando = false;
      botoes.forEach(function (b, i) { b.disabled = false; b.textContent = textos[i]; });
      if (RN.mudou) { var c = $('rn-confirmar'); if (c) c.disabled = true; }
    }
  }

  // Mostra o passo 2 com os campos para corrigir. A carta do passo 3 fica guardada (escondida)
  // e volta como estava ao confirmar, se nada mudou.
  function voltarAnalise(rolar) {
    mostrar('rn-p2', true);
    mostrar('rn-p2-corrigir', true); mostrar('rn-p2-acoes', true);
    mostrar('rn-p3', false);
    moverBlocos('rn-p2-vaga', 'rn-p2-vaga');
    var av = $('rn-p1-aviso'); if (av) av.innerHTML = '';
    limparMudou();
    marcarPasso(2);
    if (rolar) rolarAte('rn-p2');
  }

  // Unidade, texto, data e tipo como estão na tela: compara com os da última análise para saber
  // se a carta guardada ainda corresponde ao que a pessoa vê.
  function assinaturaAtual() {
    return [RN.unidade ? RN.unidade.id_unidade : '', val('rn-relato').trim(), val('rn-data').trim(), val('rn-tipo-pedido')].join('|');
  }

  // Passo 3: o formulário de hoje já preenchido e a carta da análise para revisar.
  function montarNotificacao() {
    var r = RN.analise;
    if (!r || !r.texto) { toast('Analise o caso primeiro', 'err'); return; }
    if (RN.mudou || assinaturaAtual() !== RN.assinatura) {
      if (RN.passo !== 2) voltarAnalise(true);
      marcarMudou();
      toast('Os dados mudaram depois da análise. Clique em Analisar de novo antes de montar a notificação.', 'err');
      return;
    }
    if (RN.rascunho !== r) { RN.rascunho = r; RN.salva = null; }
    mostrarFormulario(true);
    if ($('rn-resultado').style.display === 'none' || !val('rn-texto')) mostrarRascunho(r);
    rolarAte('rn-p3');
  }

  // Abre a área do formulário (passo 3 no guiado, a tela toda no manual) com os campos dentro.
  function mostrarFormulario(guiado) {
    mostrar('rn-p3', true);
    moverBlocos('rn-p3-vaga', 'rn-p3-vaga');
    var g = $('rn-gerar'); if (g) g.textContent = RN.modo === 'guiado' && guiado ? 'Gerar a carta de novo' : 'Gerar notificação';
    if (RN.modo === 'guiado') {
      if (guiado) { mostrar('rn-p2-corrigir', false); mostrar('rn-p2-acoes', false); RN.mudou = false; }
      else { mostrar('rn-p2', false); }
      marcarPasso(3);
    }
  }

  var DOC_TELA = { convencao: 'Convenção', regimento: 'Regimento interno', regulamento: 'Regulamento', ata: 'Ata', outro: 'Documento' };
  var VEREDITO = {
    cabe_penalidade: { texto: 'Cabe penalidade', cor: 'badge-err' },
    sem_regra: { texto: 'Não encontrei regra que cubra esse caso', cor: 'badge-send' },
    a_confirmar: { texto: 'A confirmar', cor: 'badge-warn' },
  };
  // Resposta antiga do servidor (sem veredito): sem trecho conferido não há regra; multa sem
  // valor fica a confirmar; o resto cabe penalidade.
  function vereditoDe(r) {
    if (r.veredito && VEREDITO[r.veredito.situacao]) return r.veredito;
    if (!(r.fundamentos || []).length) return { situacao: 'sem_regra', motivo: 'Nenhum trecho da convenção ou do regimento conferido no acervo trata deste caso.' };
    if (r.tipo === 'multa' && !(r.valor && r.valor.valor != null)) return { situacao: 'a_confirmar', motivo: 'Há regra conferida, mas o valor da multa não pôde ser calculado.' };
    return { situacao: 'cabe_penalidade', motivo: 'Há regra conferida no acervo que trata deste fato.' };
  }
  function rotuloSecao(t) { return '<div style="font-size:11px;font-family:var(--mono);color:var(--muted);margin:14px 0 6px">' + t + '</div>'; }

  // Cartão da análise, nesta ordem: veredito, artigos com trecho literal, histórico, sugestão,
  // valor (quando multa) e o que falta confirmar. Tudo que vem do servidor passa por esc.
  function mostrarAnalise(r) {
    var box = $('rn-analise'); if (!box) return;
    var v = vereditoDe(r);
    var vv = VEREDITO[v.situacao];
    var u = r.unidade || RN.unidade || {};
    var h = '<div style="padding:12px 14px;border:1px solid var(--border2);border-radius:8px">';
    h += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="badge ' + vv.cor + '" style="font-size:12px;padding:4px 10px">' + esc(vv.texto) + '</span>' +
      '<span style="color:var(--muted);font-size:12px">Unidade ' + esc(u.rotulo || '') + (u.proprietario ? ' · ' + esc(u.proprietario) : '') + ' · ' + (r.data_fato ? 'fato em ' + esc(brDeIso(r.data_fato)) : '<span style="color:var(--warning)">confirme a data</span>') + '</span></div>';
    if (v.motivo) h += '<div style="margin-top:6px">' + esc(v.motivo) + '</div>';

    var fund = r.fundamentos || [];
    h += rotuloSecao('ARTIGOS ENCONTRADOS NO ACERVO');
    h += fund.length ? fund.map(function (f) {
      var cab = ['<b>' + esc(f.rotulo || 'Trecho') + '</b>', esc(DOC_TELA[f.tipo] || 'Documento')];
      if (f.documento && String(f.documento).toLowerCase() !== String(DOC_TELA[f.tipo] || '').toLowerCase()) cab.push(esc(f.documento));
      if (f.data_documento) cab.push(esc(brDeIso(f.data_documento)));
      if (f.pagina) cab.push('página ' + esc(f.pagina));
      var botao = f.documento_id ? ' <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" data-rn-doc="' + esc(f.documento_id) + '" data-rn-pag="' + esc(f.pagina || '') + '">Abrir documento</button>' : '';
      return '<div style="padding:6px 0;border-bottom:1px solid var(--border)">' + cab.join(' · ') + botao + '<div style="color:var(--muted);margin-top:2px">“' + esc(f.citacao) + '”</div></div>';
    }).join('') : '<div style="color:var(--warning)">Nenhum trecho da convenção ou do regimento foi conferido para este caso.</div>';
    if (r.recusados) h += '<div style="color:var(--muted);margin-top:4px;font-size:12px">' + Number(r.recusados) + ' citação' + (r.recusados === 1 ? '' : 'ões') + ' sem apoio no acervo ficou de fora.</div>';

    var hist = r.historico || [];
    h += rotuloSecao('HISTÓRICO DA UNIDADE');
    if (!hist.length) h += '<div>Nenhuma notificação anterior. Não é reincidente.</div>';
    else {
      h += '<div><b>Reincidente:</b> sim, a unidade já tem ' + hist.length + (hist.length === 1 ? ' notificação anterior' : ' notificações anteriores') + '. Confira se é do mesmo assunto.</div>';
      h += hist.slice(0, 3).map(function (x) {
        return '<div style="color:var(--muted);font-size:12px;padding:2px 0">' + esc(x.data || 'sem data') + ' · ' + esc(NOME_TIPO[x.tipo] || x.tipo) + ' · ' + esc(NOME_STATUS[x.status] || x.status) + (x.ocorrencia ? ' · ' + esc(String(x.ocorrencia).slice(0, 120)) : '') + '</div>';
      }).join('');
      if (hist.length > 3) h += '<div style="color:var(--muted);font-size:12px">e mais ' + (hist.length - 3) + '.</div>';
    }

    h += rotuloSecao('SUGESTÃO');
    h += '<div><b>' + esc(NOME_TIPO[r.tipo_sugerido] || 'Advertência') + '.</b> ' + esc(r.motivo_sugestao || '') + '</div>';
    if (r.tipo && r.tipo !== r.tipo_sugerido) h += '<div style="color:var(--muted);font-size:12px;margin-top:2px">Vai como ' + esc((NOME_TIPO[r.tipo] || '').toLowerCase()) + ', como foi escolhido no tipo.</div>';

    if (r.tipo === 'multa') {
      var val0 = r.valor || {};
      h += rotuloSecao('VALOR DA MULTA');
      h += val0.valor != null
        ? '<div><b>' + brl(val0.valor) + '</b></div><div style="color:var(--muted);font-size:12px">' + esc(val0.conta || '') + '</div>'
        : '<div style="color:var(--warning)">' + esc(val0.motivo || '[a confirmar]') + '</div>';
      if (val0.reincidencia && !val0.reincidencia.aplicada) h += '<div style="color:var(--muted);font-size:12px">Reincidência: ' + esc(val0.reincidencia.motivo) + '</div>';
    }

    var pend = r.a_confirmar || [];
    if (pend.length) {
      h += rotuloSecao('A CONFIRMAR');
      h += pend.map(function (p) { return '<div style="color:var(--warning)">[a confirmar] ' + esc(p) + '</div>'; }).join('');
    }
    box.innerHTML = h + '</div>';
  }

  // Abre o arquivo do documento numa aba nova (mesma rota da tela de consulta). A aba abre já no
  // clique porque o navegador bloqueia aba aberta depois de esperar a resposta.
  async function abrirDocumento(docId, pagina) {
    if (!RN.idCond || !docId) return;
    var w = window.open('about:blank', '_blank');
    try {
      var j = await api(base() + '/documentos/' + encodeURIComponent(docId) + '/arquivo');
      if (!j.url) throw new Error('Documento sem arquivo guardado.');
      var url = j.url + (pagina ? '#page=' + encodeURIComponent(pagina) : '');
      if (w) { w.opener = null; w.location.href = url; } else window.open(url, '_blank', 'noopener');
    } catch (e) {
      if (w) w.close();
      toast('Não foi possível abrir o documento: ' + e.message, 'err');
    }
  }

  // ─── Salvar e status ───
  // Salva (ou atualiza o rascunho já salvo) com o texto como está na tela.
  async function salvar(silencioso) {
    if (!RN.unidade) { toast('Escolha a unidade', 'err'); return null; }
    if (!val('rn-texto').trim()) { toast('A carta está vazia', 'err'); return null; }
    var r = RN.rascunho || {};
    var v = r.valor || {};
    var corpo = {
      id: RN.salva && RN.salva.status === 'rascunho' ? RN.salva.id : undefined,
      id_unidade: RN.unidade.id_unidade, tipo: val('rn-tipo'), data_fato: val('rn-data').trim() || null,
      ocorrencia: val('rn-relato').trim(), texto: val('rn-texto'), fundamentos: r.fundamentos || (RN.salva && RN.salva.fundamentos) || [],
      valor: val('rn-tipo') === 'multa' && v.valor != null ? v.valor : null,
      regra_valor: v.valor != null ? (v.rotulo ? v.rotulo + ': ' : '') + (v.conta || '') : null,
      prazo_regularizacao: r.prazo && r.prazo.data_estimada ? r.prazo.data_estimada : null,
    };
    try {
      var j = await api(base() + '/notificacao', 'POST', corpo);
      RN.salva = j.notificacao;
      $('rn-salvo').textContent = 'Salva como rascunho (número ' + j.notificacao.id + ').';
      if (!silencioso) toast('Rascunho salvo', 'ok');
      carregarLista();
      return RN.salva;
    } catch (e) { toast('Não salvou: ' + e.message, 'err'); return null; }
  }

  async function mudarStatus(id, status, extra) {
    try {
      var j = await api('/api/regras/notificacao/' + id, 'PATCH', Object.assign({ status: status }, extra || {}));
      if (RN.salva && RN.salva.id === id) RN.salva = j.notificacao;
      toast('Notificação ' + (NOME_STATUS[status] || status).toLowerCase(), 'ok');
      carregarLista();
      return j.notificacao;
    } catch (e) { toast('Não mudou: ' + e.message, 'err'); return null; }
  }

  // ─── Registrar no Superlógica (rota que já existe) ───
  async function carregarOpcoes() {
    var sc = $('rn-cob-conta');
    if (RN.opcoes && RN.opcoes.id === RN.idCond) return;
    sc.innerHTML = '<option value="">Carregando...</option>';
    try {
      var j = await api('/api/condominio/' + encodeURIComponent(RN.idCond) + '/multa-opcoes');
      RN.opcoes = { id: RN.idCond, contas: j.contas || [] };
      sc.innerHTML = RN.opcoes.contas.map(function (c) { return '<option value="' + Number(c.id_conta) + '"' + (c.principal ? ' selected' : '') + '>' + esc(c.descricao) + '</option>'; }).join('') || '<option value="">Nenhuma conta ativa</option>';
    } catch (e) { sc.innerHTML = '<option value="">' + esc(e.message) + '</option>'; }
  }

  // Grava a ocorrência (e a cobrança, se pedida e liberada) e marca a notificação como registrada.
  async function registrar() {
    if (!$('rn-confirma').checked) { toast('Marque a confirmação antes de registrar', 'err'); return; }
    if (!RN.unidade) { toast('Escolha a unidade', 'err'); return; }
    if (/\[a confirmar[^\]]*\]/i.test(val('rn-texto') + val('rn-titulo'))) { toast('Ainda há [a confirmar] na carta. Preencha antes de registrar.', 'err'); return; }
    var data = dataApi(val('rn-data').trim() || hojeBR());
    if (!data) { toast('Data do fato inválida (use DD/MM/AAAA)', 'err'); return; }
    var corpo = {
      id_superlogica: RN.idCond, id_unidade: RN.unidade.id_unidade, data: data, tipo: val('rn-tipo') === 'multa' ? 3 : 1,
      titulo: val('rn-titulo'), texto: val('rn-texto'), notificar: Number(val('rn-notificar')),
      email: $('rn-email').checked, carta: $('rn-carta').checked, confirmacao: 'REGISTRAR',
    };
    if ($('rn-cobrar').checked) {
      var venc = dataApi(val('rn-cob-venc'));
      if (!venc) { toast('Vencimento da cobrança inválido (use DD/MM/AAAA)', 'err'); return; }
      var valor = numBR(val('rn-cob-valor'));
      if (valor == null) { toast('Valor inválido. Use por exemplo 150,50', 'err'); return; }
      corpo.cobranca = { valor: valor, vencimento: venc, conta_categoria: val('rn-cob-cat').trim(), id_contabanco: Number(val('rn-cob-conta')), complemento: val('rn-titulo') };
    }
    var bt = $('rn-registrar'); bt.disabled = true;
    var res = $('rn-registro');
    // Salva antes (o texto que vai para o Superlógica é o mesmo guardado no histórico).
    if (RN.salva && RN.salva.status !== 'rascunho') { toast('Esta notificação já está ' + (NOME_STATUS[RN.salva.status] || '').toLowerCase() + '.', 'err'); return; }
    var n = await salvar(true);
    if (!n) { bt.disabled = false; return; }
    var travada = false;
    var j;
    try {
      try { j = await api('/api/multas/registrar', 'POST', corpo, true); } catch (e) {
        // Cobrança travada: o servidor recusa ANTES de gravar; registra só a ocorrência (dito na confirmação).
        if (e.status !== 423 || !corpo.cobranca || !e.corpo || e.corpo.erro !== 'cobranca_travada') throw e;
        travada = true; delete corpo.cobranca;
        j = await api('/api/multas/registrar', 'POST', corpo, true);
      }
    } catch (e) {
      res.textContent = (e.status === 504 ? '' : 'Não registrado: ') + e.message;
      toast(e.status === 504 ? e.message : 'Não registrado: ' + e.message, 'err');
      if (e.status !== 504) bt.disabled = false;
      return;
    }
    var partes = ['Ocorrência registrada' + (j.ocorrencia && j.ocorrencia.id ? ' (' + j.ocorrencia.id + ')' : '')];
    if (j.carta) partes.push(j.carta.ok ? 'carta gerada nas impressões do Superlógica' : 'carta não gerada: ' + j.carta.msg);
    if (j.cobranca) partes.push(j.cobranca.ok ? 'cobrança criada' + (j.cobranca.id ? ' (' + j.cobranca.id + ')' : '') : 'cobrança não criada: ' + j.cobranca.msg);
    if (travada) partes.push('a cobrança está travada pela administração e não foi lançada');
    res.textContent = partes.join('; ') + '.';
    if (typeof addHistorico === 'function') addHistorico('Notificação registrada · ' + esc(RN.unidade.rotulo));
    toast(j._status === 207 || travada ? 'Ocorrência registrada, mas um passo não foi feito (veja abaixo). Não registre de novo.' : 'Registrado no Superlógica', j._status === 207 || travada ? 'warn' : 'ok');
    await mudarStatus(n.id, 'registrada', { id_ocorrencia_sl: j.ocorrencia && j.ocorrencia.id || '', id_cobranca_sl: j.cobranca && j.cobranca.ok && j.cobranca.id || '' });
    desmarcar();
  }

  // ─── PDF da carta ───
  async function garantirCabecalho() {
    if (RN.cabecalho && RN.cabecalho.nome) return RN.cabecalho;
    try {
      var c = await api('/api/condominio/' + encodeURIComponent(RN.idCond) + '/cadastro');
      RN.cabecalho = { nome: c.nome_fantasia || c.nome, cnpj: c.cnpj, endereco: c.endereco && c.endereco.completo };
    } catch (e) { var a = cond(); RN.cabecalho = { nome: a && a.nome || '', cnpj: '', endereco: '' }; }
    return RN.cabecalho;
  }

  // Carta em A4 com o cabeçalho do condomínio (nome, CNPJ, endereço), a unidade e o texto
  // revisado. Fonte Arimo (registrada por ata-fonte-arimo.js) para os acentos saírem certos.
  async function baixarPdf() {
    if (!val('rn-texto').trim()) { toast('Nada para baixar', 'err'); return; }
    if (!window.jspdf || !window.jspdf.jsPDF) { toast('Biblioteca de PDF não carregou. Recarregue a página.', 'err'); return; }
    var cab = await garantirCabecalho();
    try {
      var doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
      var fonte = (doc.getFontList && doc.getFontList().Arimo) ? 'Arimo' : 'helvetica';
      var PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight();
      var M = 2.5 * 28.3465, LARG = PW - 2 * M, y = M;
      var linha = function (txt, tam, negrito, centro) {
        doc.setFont(fonte, negrito ? 'bold' : 'normal'); doc.setFontSize(tam);
        doc.splitTextToSize(String(txt), LARG).forEach(function (l) {
          if (y > PH - M) { doc.addPage(); y = M; }
          doc.text(l, centro ? PW / 2 : M, y, centro ? { align: 'center' } : undefined);
          y += tam * 1.45;
        });
      };
      linha(cab.nome || '', 14, true, true);
      if (cab.cnpj) linha('CNPJ ' + cab.cnpj, 10, false, true);
      if (cab.endereco) linha(cab.endereco, 10, false, true);
      y += 4; doc.setLineWidth(0.6); doc.line(M, y, PW - M, y); y += 22;
      linha(val('rn-titulo') || NOME_TIPO[val('rn-tipo')] || 'Notificação', 12, true, true);
      y += 6;
      var u = RN.unidade || {};
      linha('Unidade: ' + (u.rotulo || ''), 11);
      if (u.proprietario) linha('Proprietário(a): ' + u.proprietario, 11);
      if (u.inquilino) linha('Inquilino(a): ' + u.inquilino, 11);
      linha('Data: ' + hojeBR(), 11);
      y += 10;
      val('rn-texto').replace(/\r/g, '').split(/\n{2,}/).forEach(function (p) {
        var negrito = /^Fundamentação:?$/.test(p.trim());
        linha(p.trim(), 11, negrito); y += 6;
      });
      var total = doc.getNumberOfPages();
      doc.setFont(fonte, 'normal'); doc.setFontSize(9);
      for (var i = 1; i <= total; i++) { doc.setPage(i); doc.text('Página ' + i + ' de ' + total, PW / 2, PH - M / 2, { align: 'center' }); }
      var slug = function (s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); };
      doc.save([NOME_TIPO[val('rn-tipo')] || 'Notificacao', slug(cab.nome), slug(u.rotulo)].filter(Boolean).join('_') + '.pdf');
    } catch (e) { toast('Erro ao gerar o PDF: ' + (e && e.message ? e.message : e), 'err'); }
  }

  // ─── Lista ───
  async function carregarLista() {
    var box = $('rn-lista'); if (!box || !RN.idCond) return;
    var q = [];
    if (val('rn-f-tipo')) q.push('tipo=' + encodeURIComponent(val('rn-f-tipo')));
    if (val('rn-f-status')) q.push('status=' + encodeURIComponent(val('rn-f-status')));
    if (val('rn-f-unidade').trim()) q.push('unidade=' + encodeURIComponent(val('rn-f-unidade').trim()));
    box.innerHTML = '<span style="color:var(--muted)">Carregando...</span>';
    try {
      var j = await api(base() + '/notificacoes' + (q.length ? '?' + q.join('&') : ''));
      RN.lista = j.notificacoes || [];
      box.innerHTML = RN.lista.length ? '<table style="width:100%;border-collapse:collapse;table-layout:auto"><thead><tr style="text-align:left;color:var(--muted);font-size:11px">' +
        '<th>DATA</th><th>UNIDADE</th><th>TIPO</th><th>SITUAÇÃO</th><th>VALOR</th><th>OCORRÊNCIA</th><th></th></tr></thead><tbody>' +
        RN.lista.map(linhaLista).join('') + '</tbody></table>' : '<span style="color:var(--muted)">Nenhuma notificação com esse filtro.</span>';
    } catch (e) { box.innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>'; }
  }
  function linhaLista(n) {
    var acoes = ['<button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" data-rn-abrir="' + n.id + '">Abrir</button>'];
    var vai = { rascunho: ['cancelada'], registrada: ['regularizada', 'convertida_multa', 'cancelada'], convertida_multa: ['regularizada', 'cancelada'] }[n.status] || [];
    vai.forEach(function (s) {
      acoes.push('<button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" data-rn-status="' + n.id + '|' + s + '">' + (s === 'regularizada' ? 'Regularizada' : s === 'convertida_multa' ? 'Virou multa' : 'Cancelar') + '</button>');
    });
    return '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:6px 4px">' + esc(brDeIso(n.data_fato) || brDeIso(n.criado_em)) + '</td>' +
      '<td>' + esc(n.unidade + (n.bloco ? ' ' + n.bloco : '')) + '</td>' +
      '<td>' + esc(NOME_TIPO[n.tipo] || n.tipo) + (n.origem === 'condgpt' ? ' <span style="color:var(--muted);font-size:11px">importada</span>' : '') + '</td>' +
      '<td><span class="badge ' + (COR_STATUS[n.status] || '') + '">' + esc(NOME_STATUS[n.status] || n.status) + '</span></td>' +
      '<td>' + (n.valor != null ? brl(n.valor) : '') + '</td>' +
      // O td do Hub não quebra linha (white-space:nowrap global); aqui a ocorrência quebra em até
      // 2 linhas e o texto inteiro aparece ao passar o mouse, sem invadir a coluna dos botões.
      '<td style="white-space:normal;max-width:360px;min-width:180px;color:var(--muted);font-size:12px" title="' + esc(String(n.ocorrencia || '')) + '"><div style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word">' + esc(String(n.ocorrencia || '')) + '</div></td>' +
      '<td style="white-space:nowrap;text-align:right">' + acoes.join(' ') + '</td></tr>';
  }

  // Abre uma notificação salva no editor (rascunho pode ser alterado; as outras só leitura e PDF).
  async function abrirDaLista(id) {
    var n = RN.lista.find(function (x) { return x.id === id; });
    if (!n) return;
    if (n.id_unidade) {
      setVal('rn-busca', ''); filtrarUnidades(); setVal('rn-unidade', String(n.id_unidade));
      await escolherUnidade();
    } else {
      RN.unidade = { id_unidade: null, rotulo: n.unidade + (n.bloco ? ' ' + n.bloco : '') };
    }
    RN.rascunho = { fundamentos: n.fundamentos || [], valor: { valor: n.valor != null ? Number(n.valor) : null, conta: n.regra_valor }, prazo: { data_estimada: n.prazo_regularizacao } };
    RN.salva = n;
    // Notificação salva não tem análise na tela: abre direto no formulário.
    RN.analise = null; RN.maxPasso = 1;
    mostrarFormulario(false);
    $('rn-resultado').style.display = '';
    $('rn-sugestao').textContent = 'Notificação número ' + n.id + ' · ' + (NOME_STATUS[n.status] || n.status) + (n.id_ocorrencia_sl ? ' · ocorrência ' + n.id_ocorrencia_sl : '') + (n.id_cobranca_sl ? ' · cobrança ' + n.id_cobranca_sl : '');
    setVal('rn-titulo', (NOME_TIPO[n.tipo] || 'Notificação') + ' · unidade ' + RN.unidade.rotulo);
    setVal('rn-texto', n.texto || ''); setVal('rn-tipo', n.tipo); setVal('rn-relato', n.ocorrencia || ''); setVal('rn-data', brDeIso(n.data_fato));
    $('rn-valor').innerHTML = n.valor != null ? '<div style="font-size:11px;color:var(--muted)">VALOR DA MULTA</div><b>' + brl(n.valor) + '</b><div style="font-size:12px;color:var(--muted)">' + esc(n.regra_valor || '') + '</div>' : '';
    $('rn-prazo').innerHTML = n.prazo_regularizacao ? '<div style="font-size:11px;color:var(--muted)">PRAZO PARA REGULARIZAR</div>até ' + esc(brDeIso(n.prazo_regularizacao)) : '';
    $('rn-pendencias').textContent = '';
    mostrarFundamentos(n.fundamentos || [], 0);
    $('rn-salvo').textContent = n.status === 'rascunho' ? 'Rascunho número ' + n.id + '.' : 'Já ' + (NOME_STATUS[n.status] || '').toLowerCase() + '; alterações na carta servem só para o PDF.';
    desmarcar();
    $('rn-resultado').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Abre a aba: monta uma vez e (re)carrega o condomínio ativo.
  function abrir() {
    var box = $('regras-notificacao'); if (!box) return;
    var c = cond();
    if (!c || !c.id_superlogica) { box.innerHTML = '<div class="card"><span style="color:var(--muted)">Selecione um condomínio com código do Superlógica.</span></div>'; RN.montado = false; RN.idCond = null; return; }
    if (!RN.montado) montar(box);
    if (RN.idCond === String(c.id_superlogica)) return;
    RN.idCond = String(c.id_superlogica);
    RN.unidades = []; RN.unidade = null; RN.cabecalho = null; RN.opcoes = null;
    setVal('rn-busca', ''); setVal('rn-relato', ''); setVal('rn-data', '');
    var f = $('rn-ficha'); if (f) f.innerHTML = '';
    limparResultado();
    reiniciarPassos();
    carregarUnidades();
    carregarLista();
  }

  window.addEventListener('regras-aba', function (e) { if (e && e.detail === 'notificacao') abrir(); });
  // Trocar de condomínio: tudo que estava na tela era do anterior.
  window.addEventListener('condominioAtivo:trocou', function () {
    RN.seq++; RN.idCond = null; RN.unidadeConfirmada = false; RN.candidatos = null;
    var box = $('regras-notificacao');
    if (box && box.offsetParent !== null) abrir(); else { RN.montado = RN.montado && !!$('rn-unidade'); }
  });
  window.regrasNotificacaoAbrir = abrir;
  // Funções puras da leitura do caso, expostas para o teste (scripts/teste-regras-caso.js).
  window.regrasCaso = RC;
})();
