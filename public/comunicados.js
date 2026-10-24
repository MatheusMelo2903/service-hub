// ============================================================
// COMUNICADOS E MULTAS (T10)
// Comunicado: texto no padrão gerado a partir do assunto (rascunho), prévia, publicar no
// Superlógica só com confirmação na tela. Só GESTOR e GERENTE (o servidor confere).
// O formulário agora fica na aba interna Comunicados do painel Comunicados e Multas (id regras,
// contêiner #regras-comunicados), com os mesmos ids de antes. A multa é feita só pela aba
// Notificações e multas (regras-notificacao.js); a multa simples antiga foi retirada daqui.
// Rotas: /api/comunicados/rascunho, /publicar e, com "Citar regimento e convenção",
// /api/regras/:id/comunicado/rascunho.
// ============================================================

// Quem usa a aba Comunicados: o mesmo cargo que o servidor aceita para publicar (GESTOR e GERENTE).
function comunicadosPode() { return window.USER_ROLE === 'GESTOR' || window.USER_ROLE === 'GERENTE'; }

function comEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function comCond() { return (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : null; }
function comV(id) { var el = document.getElementById(id); return el ? el.value : ''; }
function comSet(id, v) { var el = document.getElementById(id); if (el) el.value = v; }
// gravar: true quando a chamada grava no Superlógica (janela de confirmação em confirmar-gravacao.js).
async function comPost(url, corpo, gravar) {
  var r = await (gravar && window.gravarNoSuperlogica ? window.gravarNoSuperlogica : apiAuthFetch)(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) { var e = new Error(j.detalhe || (textoFalha(r.status))); e.status = r.status; e.corpo = j; throw e; }
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
  lab.textContent = 'Confirmo publicar no condomínio ' + nome + ', para ' + txt('com-destinatario').toLowerCase() + ', canal ' + txt('com-canal').toLowerCase() + (document.getElementById('com-notificar').checked ? ', marcado para notificar' : ', sem notificar');
}
['input', 'change'].forEach(function (ev) {
  document.addEventListener(ev, function (e) {
    var t = e.target; if (!t || !t.id) return;
    if (/^com-/.test(t.id) && t.id !== 'com-confirma') comDesmarcar('com');
  });
});

function comAtualizarConfirmacoes() {
  comRotulo('com');
  var cb = document.getElementById('com-confirma'); if (cb) cb.checked = false;
  var bt = document.getElementById('com-btn-gravar'); if (bt) bt.disabled = true;
}

async function comGerarTexto() {
  var cond = comCond();
  var assunto = comV('com-assunto').trim();
  if (!assunto) { toast('Escreva o assunto primeiro', 'err'); return; }
  var bt = document.getElementById('com-btn-gerar');
  // Com "Citar regimento e convenção" marcado usa a rota das regras do condomínio,
  // que devolve o mesmo { titulo, texto } mais os trechos conferidos no acervo.
  var citar = comCitarMarcado();
  if (citar && (!cond || !cond.id_superlogica)) { toast('Selecione um condomínio com código do Superlógica', 'err'); return; }
  bt.disabled = true; var txt0 = bt.textContent; bt.textContent = 'Gerando...';
  comMostrarFundamentos(null);
  try {
    var corpo = { tipo: comV('com-tipo'), assunto: assunto, detalhes: comV('com-detalhes'), condominio: cond ? cond.nome : '' };
    var j = citar
      ? await comPost('/api/regras/' + encodeURIComponent(cond.id_superlogica) + '/comunicado/rascunho', corpo)
      : await comPost('/api/comunicados/rascunho', Object.assign({ unidade: '' }, corpo));
    comSet('com-titulo', j.titulo); comSet('com-texto', j.texto); comPrevia('com');
    if (citar) comMostrarFundamentos(j.fundamentos || []);
    toast('Texto gerado. Revise antes de gravar; o que estiver como [a confirmar] precisa ser preenchido.', 'ok');
  } catch (e) { toast('Não foi possível gerar: ' + e.message, 'err'); }
  finally { bt.disabled = false; bt.textContent = txt0; }
}

// Opção "Citar regimento e convenção" (regras do condomínio). Criada aqui, ao lado do botão de
// gerar, para não depender de mudança no index.html. Os fundamentos aparecem abaixo do texto.
function comCitarMarcado() { var cb = document.getElementById('com-citar-regras'); return !!(cb && cb.checked); }
function comPrepararCitar() {
  var bt = document.getElementById('com-btn-gerar');
  if (!bt || document.getElementById('com-citar-regras')) return;
  var lab = document.createElement('label');
  lab.style.cssText = 'display:inline-flex;gap:8px;align-items:center;font-size:12px;margin-left:12px';
  var cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'com-citar-regras';
  lab.appendChild(cb); lab.appendChild(document.createTextNode(' Citar regimento e convenção'));
  bt.insertAdjacentElement('afterend', lab);
  var txt = document.getElementById('com-texto');
  if (txt && !document.getElementById('com-fundamentos')) {
    var box = document.createElement('div'); box.id = 'com-fundamentos'; box.style.cssText = 'font-size:12px;margin-top:6px';
    txt.insertAdjacentElement('afterend', box);
  }
}
// null limpa; lista vazia avisa que nada do acervo foi conferido para o assunto.
function comMostrarFundamentos(lista) {
  var box = document.getElementById('com-fundamentos'); if (!box) return;
  if (lista == null) { box.innerHTML = ''; return; }
  box.innerHTML = '<div style="font-size:11px;font-family:var(--mono);color:var(--muted);margin-bottom:4px">FUNDAMENTOS CONFERIDOS NO ACERVO</div>' + (lista.length ? lista.map(function (f) {
    return '<div style="padding:4px 0;border-bottom:1px solid var(--border)"><b>' + comEsc(f.rotulo || 'Trecho') + '</b> · ' + comEsc(f.documento || f.tipo || '') + '<div style="color:var(--muted)">"' + comEsc(f.citacao) + '"</div></div>';
  }).join('') : '<div style="color:var(--muted)">Nenhum trecho do regimento ou da convenção foi conferido para este assunto; o texto saiu sem citar regra.</div>');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', comPrepararCitar); else comPrepararCitar();

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
    }, true);
    document.getElementById('com-resultado').textContent = 'Publicado no Superlógica' + (j.id_comunicado ? ' (comunicado ' + j.id_comunicado + ')' : '') + '.' + (j.notificacao_pendente ? ' A notificação ficou na fila do Superlógica.' : '');
    addHistorico('Comunicado publicado: ' + comV('com-titulo') + ' · ' + cond.nome);
    toast('Comunicado publicado', 'ok');
    ['com-titulo', 'com-texto', 'com-assunto', 'com-detalhes'].forEach(function (k) { comSet(k, ''); });
    comPrevia('com'); comMostrarFundamentos(null);
    comAtualizarConfirmacoes();
  } catch (e) { toast('Não publicado: ' + e.message, 'err'); bt.disabled = false; }
}

function comunicadosAbrir() {
  comPrepararCitar();
  comAtualizarConfirmacoes();
}

// Trocar de condomínio: o rascunho e a unidade eram do anterior.
window.addEventListener('condominioAtivo:trocou', function () {
  ['com-titulo', 'com-texto', 'com-assunto', 'com-detalhes'].forEach(function (k) { comSet(k, ''); });
  comMostrarFundamentos(null);
  ['com-previa', 'com-resultado'].forEach(function (k) { var el = document.getElementById(k); if (el) el.textContent = ''; });
  comAtualizarConfirmacoes();
});
// A aba Comunicados do painel unificado prepara o formulário quando aparece. O item de menu
// agora é um só (nav-regras) e quem decide se aparece é podeAbrirPainel no index.html.
window.addEventListener('regras-aba', function (e) { if (e && e.detail === 'comunicados') comunicadosAbrir(); });
