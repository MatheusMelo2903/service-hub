// ============================================================
// COMUNICADOS E MULTAS (T10)
// Comunicado: texto no padrão gerado a partir do assunto (rascunho), prévia, publicar no
// Superlógica só com confirmação na tela. Multa: ocorrência na unidade, carta e cobrança
// opcional, também só com confirmação. Só GESTOR e GERENTE (o servidor confere).
// Rotas: /api/comunicados/rascunho, /publicar, /disparar, /api/condominio/:id/multa-opcoes,
// /api/multas/registrar.
// ============================================================
var comEstado = { idOpcoes: null, opcoes: null, seq: 0 };

function comEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function comCond() { return (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : null; }
function comV(id) { var el = document.getElementById(id); return el ? el.value : ''; }
function comSet(id, v) { var el = document.getElementById(id); if (el) el.value = v; }
// DD/MM/AAAA -> MM/DD/AAAA (formato da API); vazio se inválida
function comDataApi(br) {
  var m = String(br || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  var d = +m[1], mm = +m[2];
  if (d < 1 || d > 31 || mm < 1 || mm > 12) return '';
  return String(mm).padStart(2, '0') + '/' + String(d).padStart(2, '0') + '/' + m[3];
}
// "1.234,56", "150,50" ou "150.50" -> número; formato ambíguo devolve null.
function comValor(t) {
  var s = String(t || '').trim();
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^\d+([.,]\d{1,2})?$/.test(s)) return Number(s.replace(',', '.'));
  return null;
}
function comBRL(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

async function comPost(url, corpo) {
  var r = await apiAuthFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) { var e = new Error(j.detalhe || ('Falha ' + r.status)); e.status = r.status; e.corpo = j; throw e; }
  j._status = r.status;
  return j;
}

// Prévia: o texto revisado em parágrafos (escapado; o servidor monta o HTML igual).
function comPrevia(prefixo) {
  var box = document.getElementById(prefixo + '-previa');
  if (!box) return;
  var titulo = comV(prefixo + '-titulo');
  var paras = comV(prefixo + '-texto').split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
  box.innerHTML = (titulo ? '<div style="font-weight:700;margin-bottom:8px">' + comEsc(titulo) + '</div>' : '') +
    paras.map(function (p) { return '<p style="margin:0 0 8px">' + comEsc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
}

// Qualquer mudança no formulário desmarca a confirmação (confirma o que está na tela agora).
function comDesmarcar(p) {
  var cb = document.getElementById(p + '-confirma'); if (cb) cb.checked = false;
  var bt = document.getElementById(p + '-btn-gravar'); if (bt) bt.disabled = true;
  comRotulo(p);
}
function comRotulo(p) {
  var cond = comCond();
  var nome = cond && cond.nome ? cond.nome + (cond.id_superlogica ? ' (código ' + cond.id_superlogica + ')' : '') : 'nenhum condomínio';
  var lab = document.getElementById(p + '-confirma-rotulo'); if (!lab) return;
  var txt = function (id) { var s = document.getElementById(id); return s && s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : ''; };
  if (p === 'com') {
    lab.textContent = 'Confirmo publicar no condomínio ' + nome + ', para ' + txt('com-destinatario').toLowerCase() + ', canal ' + txt('com-canal').toLowerCase() + (document.getElementById('com-notificar').checked ? ', marcado para notificar' : ', sem notificar');
  } else {
    var v = comValor(comV('mul-valor'));
    lab.textContent = 'Confirmo registrar no condomínio ' + nome + ', unidade ' + (txt('mul-unidade') || 'não escolhida') + ', notificar: ' + txt('mul-notificar').toLowerCase() +
      (document.getElementById('mul-email').checked ? ' (com email, sai na hora)' : '') +
      (document.getElementById('mul-cobrar').checked ? ', cobrança de ' + (v == null ? 'valor inválido' : comBRL(v)) + ' com vencimento ' + (comV('mul-venc') || 'não informado') : '');
  }
}
['input', 'change'].forEach(function (ev) {
  document.addEventListener(ev, function (e) {
    var t = e.target; if (!t || !t.id) return;
    if (/^com-/.test(t.id) && t.id !== 'com-confirma') comDesmarcar('com');
    if (/^mul-/.test(t.id) && t.id !== 'mul-confirma') comDesmarcar('mul');
  });
});

function comAtualizarConfirmacoes() {
  var cond = comCond();
  var nome = cond && cond.nome ? cond.nome : 'nenhum condomínio';
  ['com', 'mul'].forEach(function (p) {
    comRotulo(p);
    var cb = document.getElementById(p + '-confirma'); if (cb) cb.checked = false;
    var bt = document.getElementById(p + '-btn-gravar'); if (bt) bt.disabled = true;
  });
}

async function comGerarTexto(prefixo) {
  var cond = comCond();
  var tipo = prefixo === 'com' ? comV('com-tipo') : 'multa_unidade';
  var assunto = comV(prefixo + '-assunto').trim();
  if (!assunto) { toast('Escreva o assunto primeiro', 'err'); return; }
  var uniTxt = '';
  if (prefixo === 'mul') { var sel = document.getElementById('mul-unidade'); uniTxt = sel && sel.selectedIndex > 0 ? (sel.options[sel.selectedIndex].dataset.uni || '') : ''; }
  var bt = document.getElementById(prefixo + '-btn-gerar');
  bt.disabled = true; var txt0 = bt.textContent; bt.textContent = 'Gerando...';
  try {
    var j = await comPost('/api/comunicados/rascunho', { tipo: tipo, assunto: assunto, detalhes: comV(prefixo + '-detalhes'), condominio: cond ? cond.nome : '', unidade: uniTxt });
    comSet(prefixo + '-titulo', j.titulo); comSet(prefixo + '-texto', j.texto); comPrevia(prefixo);
    toast('Texto gerado. Revise antes de gravar; o que estiver como [a confirmar] precisa ser preenchido.', 'ok');
  } catch (e) { toast('Não foi possível gerar: ' + e.message, 'err'); }
  finally { bt.disabled = false; bt.textContent = txt0; }
}

async function comPublicar() {
  var cond = comCond();
  if (!cond || !cond.id_superlogica) { toast('Selecione um condomínio com código do Superlógica', 'err'); return; }
  if (!document.getElementById('com-confirma').checked) { toast('Marque a confirmação antes de publicar', 'err'); return; }
  if (/\[a confirmar\]/i.test(comV('com-texto') + comV('com-titulo'))) { toast('Ainda há [a confirmar] no texto. Preencha antes de publicar.', 'err'); return; }
  var bt = document.getElementById('com-btn-gravar'); bt.disabled = true;
  try {
    var j = await comPost('/api/comunicados/publicar', {
      id_superlogica: cond.id_superlogica, titulo: comV('com-titulo'), texto: comV('com-texto'),
      destinatario: Number(comV('com-destinatario')), canal: Number(comV('com-canal')),
      notificar: document.getElementById('com-notificar').checked, confirmacao: 'PUBLICAR',
    });
    document.getElementById('com-resultado').textContent = 'Publicado no Superlógica' + (j.id_comunicado ? ' (comunicado ' + j.id_comunicado + ')' : '') + '.' + (j.notificacao_pendente ? ' A notificação ficou na fila do Superlógica.' : '');
    addHistorico('Comunicado publicado: ' + comV('com-titulo') + ' · ' + cond.nome);
    toast('Comunicado publicado', 'ok');
    ['com-titulo', 'com-texto', 'com-assunto', 'com-detalhes'].forEach(function (k) { comSet(k, ''); });
    comPrevia('com');
    comAtualizarConfirmacoes();
  } catch (e) { toast('Não publicado: ' + e.message, 'err'); bt.disabled = false; }
}

async function comDisparar() {
  try { await comPost('/api/comunicados/disparar', { confirmacao: 'DISPARAR' }); toast('Notificações disparadas', 'ok'); }
  catch (e) { document.getElementById('com-resultado').textContent = e.message; toast(e.status === 423 ? 'Disparo travado pela administração' : 'Não disparou: ' + e.message, 'warn'); }
}

async function comCarregarOpcoes(forcar) {
  var cond = comCond();
  var sel = document.getElementById('mul-unidade'), sc = document.getElementById('mul-conta');
  if (!sel) return;
  if (!cond || !cond.id_superlogica) { sel.innerHTML = '<option value="">Selecione um condomínio</option>'; return; }
  if (!forcar && comEstado.idOpcoes === cond.id_superlogica) return;
  var seq = ++comEstado.seq;
  sel.innerHTML = '<option value="">Carregando unidades...</option>';
  try {
    var r = await apiAuthFetch('/api/condominio/' + encodeURIComponent(cond.id_superlogica) + '/multa-opcoes');
    var j = await r.json().catch(function () { return {}; });
    if (seq !== comEstado.seq) return;
    if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
    comEstado.idOpcoes = cond.id_superlogica; comEstado.opcoes = j;
    sel.innerHTML = '<option value="">Escolha a unidade</option>' + (j.unidades || []).map(function (u) {
      return '<option value="' + Number(u.id_unidade) + '" data-uni="' + comEsc(u.unidade + (u.bloco ? ' ' + u.bloco : '')) + '">' + comEsc(u.unidade + (u.bloco ? ' ' + u.bloco : '') + (u.proprietario ? ' · ' + u.proprietario : '')) + '</option>';
    }).join('');
    sc.innerHTML = (j.contas || []).map(function (c) { return '<option value="' + Number(c.id_conta) + '"' + (c.principal ? ' selected' : '') + '>' + comEsc(c.descricao) + '</option>'; }).join('');
  } catch (e) {
    if (seq !== comEstado.seq) return;
    sel.innerHTML = '<option value="">' + comEsc(e.message) + '</option>';
  }
}

function comMultaCobrancaToggle() {
  var on = document.getElementById('mul-cobrar').checked;
  document.getElementById('mul-cobranca-campos').style.display = on ? 'grid' : 'none';
}

async function comRegistrarMulta() {
  var cond = comCond();
  if (!cond || !cond.id_superlogica) { toast('Selecione um condomínio com código do Superlógica', 'err'); return; }
  if (!document.getElementById('mul-confirma').checked) { toast('Marque a confirmação antes de registrar', 'err'); return; }
  if (/\[a confirmar\]/i.test(comV('mul-texto') + comV('mul-titulo'))) { toast('Ainda há [a confirmar] no texto. Preencha antes de registrar.', 'err'); return; }
  var data = comDataApi(comV('mul-data'));
  if (!data) { toast('Data da ocorrência inválida (use DD/MM/AAAA)', 'err'); return; }
  var corpo = {
    id_superlogica: cond.id_superlogica, id_unidade: Number(comV('mul-unidade')), data: data, tipo: Number(comV('mul-tipo')),
    titulo: comV('mul-titulo'), texto: comV('mul-texto'), notificar: Number(comV('mul-notificar')),
    email: document.getElementById('mul-email').checked, carta: document.getElementById('mul-carta').checked, confirmacao: 'REGISTRAR',
  };
  if (document.getElementById('mul-cobrar').checked) {
    var venc = comDataApi(comV('mul-venc'));
    if (!venc) { toast('Vencimento da cobrança inválido (use DD/MM/AAAA)', 'err'); return; }
    var valor = comValor(comV('mul-valor'));
    if (valor == null) { toast('Valor inválido. Use por exemplo 150,50', 'err'); return; }
    corpo.cobranca = { valor: valor, vencimento: venc, conta_categoria: comV('mul-conta-cat').trim(), id_contabanco: Number(comV('mul-conta')), complemento: comV('mul-titulo') };
  }
  var bt = document.getElementById('mul-btn-gravar'); bt.disabled = true;
  var res = document.getElementById('mul-resultado');
  try {
    var j = await comPost('/api/multas/registrar', corpo);
    var partes = ['Ocorrência registrada' + (j.ocorrencia && j.ocorrencia.id ? ' (' + j.ocorrencia.id + ')' : '')];
    if (j.carta) partes.push(j.carta.ok ? 'carta gerada nas impressões do Superlógica' + (j.carta.id_impressao ? ' (' + j.carta.id_impressao + ')' : '') : 'carta não gerada: ' + j.carta.msg);
    if (j.cobranca) partes.push(j.cobranca.ok ? 'cobrança criada' + (j.cobranca.id ? ' (' + j.cobranca.id + ')' : '') : 'cobrança não criada: ' + j.cobranca.msg);
    res.textContent = partes.join('; ') + '.';
    addHistorico('Ocorrência registrada · ' + cond.nome);
    toast(j._status === 207 ? 'Ocorrência registrada, mas um passo falhou (veja abaixo). Não registre de novo.' : 'Registrado no Superlógica', j._status === 207 ? 'warn' : 'ok');
    // a ocorrência já existe: limpa o formulário para não gravar outra igual
    ['mul-titulo', 'mul-texto', 'mul-assunto', 'mul-detalhes', 'mul-valor', 'mul-venc'].forEach(function (k) { comSet(k, ''); });
    comPrevia('mul');
    comAtualizarConfirmacoes();
  } catch (e) {
    res.textContent = (e.status === 504 ? '' : 'Não registrado: ') + e.message;
    toast(e.status === 504 ? e.message : 'Não registrado: ' + e.message, 'err');
    if (e.status !== 504) bt.disabled = false;
  }
}

function comunicadosAbrir() {
  comAtualizarConfirmacoes();
  comCarregarOpcoes();
}

// Trocar de condomínio: o rascunho e a unidade eram do anterior.
window.addEventListener('condominioAtivo:trocou', function () {
  comEstado.idOpcoes = null; comEstado.seq++;
  ['com-titulo', 'com-texto', 'mul-titulo', 'mul-texto', 'mul-assunto', 'mul-detalhes', 'com-assunto', 'com-detalhes'].forEach(function (k) { comSet(k, ''); });
  ['com-previa', 'mul-previa', 'com-resultado', 'mul-resultado'].forEach(function (k) { var el = document.getElementById(k); if (el) el.textContent = ''; });
  comAtualizarConfirmacoes();
  var p = document.getElementById('panel-comunicados');
  if (p && p.classList.contains('active')) comCarregarOpcoes(true);
});
// Só gestor e gerente veem o item do menu (o servidor também confere).
document.addEventListener('auth:ready', function () {
  var nav = document.getElementById('nav-comunicados');
  if (nav) nav.style.display = (window.USER_ROLE === 'GESTOR' || window.USER_ROLE === 'GERENTE') ? '' : 'none';
});
