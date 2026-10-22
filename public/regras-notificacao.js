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
  async function api(url, metodo, corpo) {
    var op = { method: metodo || 'GET' };
    if (corpo !== undefined) { op.headers = { 'Content-Type': 'application/json' }; op.body = JSON.stringify(corpo); }
    var r = await apiAuthFetch(url, op);
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.detalhe || ('Falha ' + r.status)); e.status = r.status; e.corpo = j; throw e; }
    j._status = r.status;
    return j;
  }
  function base() { return '/api/regras/' + encodeURIComponent(RN.idCond); }

  // Estrutura da tela (uma vez). Tudo dentro de #regras-notificacao.
  function montar(box) {
    box.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><span class="card-title">Notificação ou multa para unidade</span></div>' +
        '<div style="display:grid;grid-template-columns:1fr 2fr;gap:12px">' +
          '<div class="form-group" style="margin:0"><label>Buscar unidade</label><input type="text" id="rn-busca" autocomplete="off" placeholder="número, bloco ou nome"></div>' +
          '<div class="form-group" style="margin:0"><label>Unidade</label><select id="rn-unidade"><option value="">Carregando unidades...</option></select></div>' +
        '</div>' +
        '<div id="rn-ficha" style="margin-top:12px;font-size:13px"></div>' +
        '<div style="display:grid;grid-template-columns:3fr 1fr 1fr;gap:12px;margin-top:12px">' +
          '<div class="form-group" style="margin:0"><label>O que aconteceu</label><textarea id="rn-relato" rows="4" style="' + ESTILO_CAMPO + '" placeholder="ex: barulho alto após as 22h, relatado pela portaria e por dois vizinhos"></textarea></div>' +
          '<div class="form-group" style="margin:0"><label>Data do fato</label><input type="text" id="rn-data" placeholder="DD/MM/AAAA" autocomplete="off"></div>' +
          '<div class="form-group" style="margin:0"><label>Tipo</label><select id="rn-tipo-pedido"><option value="">Sugerir pela regra</option><option value="advertencia">Advertência</option><option value="multa">Multa</option></select></div>' +
        '</div>' +
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
  }

  // Eventos por delegação: a tela é montada uma vez e reaproveitada ao trocar de condomínio.
  function ligarEventos(box) {
    box.addEventListener('click', function (e) {
      var t = e.target; if (!t) return;
      if (t.id === 'rn-gerar') gerar();
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
      if (/^rn-(titulo|texto|tipo|notificar|email|carta|cobrar|cob-)/.test(t.id)) desmarcar();
    });
    box.addEventListener('change', function (e) {
      var t = e.target; if (!t || !t.id) return;
      if (t.id === 'rn-unidade') escolherUnidade();
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
  async function carregarUnidades() {
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
    var lista = RN.unidades.filter(function (u) {
      if (!q) return true;
      return (u.rotulo + ' ' + (u.proprietario || '') + ' ' + (u.inquilino || '')).toLowerCase().indexOf(q) !== -1;
    });
    sel.innerHTML = '<option value="">' + (lista.length ? 'Escolha a unidade (' + lista.length + ')' : 'Nenhuma unidade encontrada') + '</option>' + lista.slice(0, 400).map(function (u) {
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
      try { j = await api('/api/multas/registrar', 'POST', corpo); } catch (e) {
        // Cobrança travada: o servidor recusa ANTES de gravar; registra só a ocorrência (dito na confirmação).
        if (e.status !== 423 || !corpo.cobranca) throw e;
        travada = true; delete corpo.cobranca;
        j = await api('/api/multas/registrar', 'POST', corpo);
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
      box.innerHTML = RN.lista.length ? '<table style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left;color:var(--muted);font-size:11px">' +
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
      '<td style="max-width:280px;color:var(--muted);font-size:12px">' + esc(String(n.ocorrencia || '').slice(0, 140)) + '</td>' +
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
    carregarUnidades();
    carregarLista();
  }

  window.addEventListener('regras-aba', function (e) { if (e && e.detail === 'notificacao') abrir(); });
  // Trocar de condomínio: tudo que estava na tela era do anterior.
  window.addEventListener('condominioAtivo:trocou', function () {
    RN.seq++; RN.idCond = null;
    var box = $('regras-notificacao');
    if (box && box.offsetParent !== null) abrir(); else { RN.montado = RN.montado && !!$('rn-unidade'); }
  });
  window.regrasNotificacaoAbrir = abrir;
})();
