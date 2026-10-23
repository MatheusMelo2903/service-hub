// Regras do Condomínio, frente E: (a) cartão "Conferência com a convenção" na revisão da ata e
// (b) a parte Mandatos da aba Regras (#regras-mandatos).
// (a) A tela de Atas chama window.regrasConferirAta quando a ata fica pronta. A conferência roda
// em segundo plano e mostra um cartão à parte, acima do texto da ata e fora dele: o texto da ata,
// o PDF, o Word e o copiar não mudam. Qualquer erro aqui fica só no cartão.
// (b) Lista os mandatos tirados das atas, com fim e situação; botão para ler as atas do acervo,
// marcar como conferido e corrigir nome ou fim. O servidor confere permissão e carteira.

var regrasAtaSeq = 0;
var regrasMandEstado = { idCarregado: null, seq: 0, lista: [], editando: null };
var REGRAS_ASSUNTO = { convocacao: 'Convocação', quorum: 'Quórum', votacao: 'Votação', eleicao: 'Eleição', mandato: 'Mandato', competencia: 'Competência', outro: 'Outro' };
var REGRAS_CARGO = { sindico: 'Síndico', subsindico: 'Subsíndico', conselho_fiscal: 'Conselho fiscal', conselho_consultivo: 'Conselho consultivo', conselho: 'Conselho' };

function regrasAtaEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function regrasAtaBR(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
}

// Cartão da conferência: criado uma vez, logo antes do texto da ata (irmão, nunca dentro dele).
function regrasAtaCartao() {
  var conteudo = document.getElementById('ata-gerada-conteudo');
  if (!conteudo || !conteudo.parentNode) return null;
  var c = document.getElementById('regras-conf-ata');
  if (!c) {
    c = document.createElement('div');
    c.id = 'regras-conf-ata';
    c.style.cssText = 'max-height:34vh;overflow:auto;padding:12px 22px;border-bottom:1px solid var(--border);background:var(--bg2);font-size:12px;color:var(--text)';
    conteudo.parentNode.insertBefore(c, conteudo);
  }
  return c;
}
function regrasAtaTitulo(extra) {
  return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">'
    + '<span style="font-weight:700">Conferência com a convenção <span style="font-weight:400;color:var(--muted)">(não altera a ata)</span></span>'
    + (extra || '') + '</div>';
}

// Chamada pela tela de Atas. opts: { idSuperlogica, textoAta, editalTexto, transcricaoId }.
// Nunca lança erro para quem chama e nunca mexe no texto recebido.
function regrasConferirAta(opts) {
  try {
    var o = opts || {};
    var c = regrasAtaCartao();
    if (!c) return;
    var seq = ++regrasAtaSeq;
    if (!o.idSuperlogica || !o.textoAta) { c.style.display = 'none'; return; }
    c.style.display = '';
    c.innerHTML = regrasAtaTitulo() + '<div style="color:var(--muted);font-family:var(--mono)">Conferindo com a convenção e o regimento do condomínio...</div>';
    regrasAtaBuscar(o, seq, c);
  } catch (e) { /* a ata já está na tela; a conferência é só um extra */ }
}

async function regrasAtaBuscar(o, seq, c) {
  try {
    var r = await apiAuthFetch('/api/regras/' + encodeURIComponent(o.idSuperlogica) + '/conferir-ata', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // edital cortado no limite do servidor (só serve de apoio; a ata vai inteira)
      body: JSON.stringify({ texto_ata: o.textoAta, edital_texto: String(o.editalTexto || '').slice(0, 100000), transcricao_id: o.transcricaoId || undefined })
    });
    var j = await r.json().catch(function () { return {}; });
    if (seq !== regrasAtaSeq) return; // outra ata foi gerada no meio
    if (r.status === 403) { c.style.display = 'none'; return; } // sem acesso: não mostra nada
    if (!r.ok) throw new Error(j.detalhe || 'não foi possível conferir agora');
    regrasAtaRender(c, j, o.idSuperlogica);
  } catch (e) {
    if (seq !== regrasAtaSeq) return;
    c.innerHTML = regrasAtaTitulo() + '<div style="color:var(--muted);font-family:var(--mono)">Conferência indisponível agora (' + regrasAtaEsc(e.message || 'erro') + '). A ata não foi afetada.</div>';
  }
}

// Monta a lista de pontos: assunto, gravidade, descrição, trecho da ata e artigo citado literal.
function regrasAtaRender(c, j, idSL) {
  if (j.sem_regras) {
    c.innerHTML = regrasAtaTitulo() + '<div style="color:var(--muted)">' + regrasAtaEsc(j.aviso || 'Sem convenção e regimento cadastrados.') + ' Envie os documentos em Comunicados e Multas, aba Documentos, para conferir as próximas atas.</div>';
    return;
  }
  var itens = Array.isArray(j.itens) ? j.itens : [];
  if (!itens.length) {
    c.innerHTML = regrasAtaTitulo() + '<div style="color:var(--success)">Nada a apontar.</div>';
    return;
  }
  var html = regrasAtaTitulo('<span style="color:var(--muted);font-family:var(--mono)">' + regrasAtaEsc(j.resumo || '') + '</span>');
  html += itens.map(function (it) {
    var grave = it.gravidade === 'possivel_irregularidade';
    var cor = grave ? 'var(--danger)' : 'var(--warning)';
    var fund = (it.fundamentos || []).map(function (f) {
      var botao = f.documento_id ? ' <button class="btn btn-ghost" style="font-size:10px;padding:2px 8px" onclick="regrasAtaAbrirDoc(' + Number(idSL) + ',' + Number(f.documento_id) + ')">Abrir documento</button>' : '';
      return '<div style="margin-top:4px;padding-left:8px;border-left:2px solid var(--border2)">'
        + '<span style="color:var(--muted)">' + regrasAtaEsc([f.fonte, f.rotulo].filter(Boolean).join(', ')) + (f.pagina ? ', página ' + Number(f.pagina) : '') + ':</span> '
        + '<em>"' + regrasAtaEsc(f.citacao) + '"</em>' + botao + '</div>';
    }).join('');
    return '<div style="margin:8px 0;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-left:3px solid ' + cor + ';border-radius:8px">'
      + '<div><span style="font-size:10px;font-family:var(--mono);text-transform:uppercase;color:' + cor + '">' + regrasAtaEsc(REGRAS_ASSUNTO[it.assunto] || 'Outro') + (grave ? ' · possível irregularidade' : ' · atenção') + '</span></div>'
      + '<div style="margin-top:2px">' + regrasAtaEsc(it.descricao) + '</div>'
      + '<div style="margin-top:4px;color:var(--muted)">' + (it.trecho_origem === 'edital' ? 'No edital' : 'Na ata') + ': <em>"' + regrasAtaEsc(it.trecho_ata) + '"</em></div>'
      + fund + '</div>';
  }).join('');
  c.innerHTML = html;
}

// Abre o PDF do documento do acervo (link temporário do servidor).
async function regrasAtaAbrirDoc(idSL, docId) {
  var janela = window.open('about:blank', '_blank'); // abre já no clique para o navegador não bloquear
  if (janela) janela.opener = null;
  try {
    var r = await apiAuthFetch('/api/regras/' + encodeURIComponent(idSL) + '/documentos/' + encodeURIComponent(docId) + '/arquivo');
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.url) throw new Error(j.detalhe || 'documento sem arquivo');
    if (janela) janela.location = j.url; else window.location.href = j.url;
  } catch (e) {
    if (janela) janela.close();
    if (typeof toast === 'function') toast('Não foi possível abrir o documento: ' + (e.message || 'erro'), 'err');
  }
}

// ============================================================
// MANDATOS (aba Regras do Condomínio)
// ============================================================
function regrasMandPode(acao) {
  return typeof regrasPode === 'function' ? regrasPode(acao) : window.USER_ROLE === 'GESTOR';
}
function regrasMandHojeIso() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Situação do mandato pela data de fim (mesma janela de 60 dias do alerta).
function regrasMandSituacao(m) {
  if (!m.fim) return { txt: 'sem data de fim', cor: 'var(--muted)' };
  var dias = Math.round((Date.parse(m.fim + 'T00:00:00Z') - Date.parse(regrasMandHojeIso() + 'T00:00:00Z')) / 86400000);
  if (dias < 0) return { txt: 'vencido há ' + Math.abs(dias) + ' dia' + (Math.abs(dias) === 1 ? '' : 's'), cor: 'var(--danger)' };
  if (dias <= 60) return { txt: 'vence em ' + dias + ' dia' + (dias === 1 ? '' : 's'), cor: 'var(--warning)' };
  return { txt: 'em dia', cor: 'var(--success)' };
}

function regrasMandMontar() {
  var box = document.getElementById('regras-mandatos');
  if (!box) return null;
  if (!document.getElementById('regras-mand-lista')) {
    box.innerHTML = '<div class="card">'
      + '<div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="card-title">Mandatos de síndico e conselho</span>'
      + '<div style="display:flex;gap:6px">'
      + '<button class="btn btn-ghost" id="regras-mand-extrair" style="font-size:12px;padding:6px 12px;display:none" onclick="regrasMandExtrair()">Ler as atas do acervo</button>'
      + '<button class="btn btn-ghost" style="font-size:12px;padding:6px 12px" onclick="regrasMandCarregar(true)">Atualizar</button></div></div>'
      + '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-bottom:10px">Tirados das atas do acervo. A data de fim só é calculada quando a duração do mandato está escrita na ata ou na convenção; confira e corrija quando precisar. Mandato vencido ou vencendo em 60 dias aparece nos alertas do condomínio.</div>'
      + '<div id="regras-mand-status" style="font-size:12px;color:var(--muted);font-family:var(--mono);margin-bottom:8px"></div>'
      + '<div id="regras-mand-lista"></div></div>';
  }
  var bt = document.getElementById('regras-mand-extrair');
  if (bt) bt.style.display = regrasMandPode('gerenciar') ? '' : 'none';
  return box;
}

async function regrasMandCarregar(forcar) {
  if (!regrasMandMontar() || !window.AUTH_TOKEN) return;
  var lista = document.getElementById('regras-mand-lista');
  var st = document.getElementById('regras-mand-status');
  var cond = (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : null;
  if (!cond || !cond.id_superlogica) {
    regrasMandEstado.idCarregado = null;
    lista.innerHTML = '';
    st.textContent = 'Selecione um condomínio com código do Superlógica.';
    return;
  }
  if (!forcar && regrasMandEstado.idCarregado === cond.id_superlogica) return;
  var seq = ++regrasMandEstado.seq;
  st.textContent = 'Carregando mandatos...';
  try {
    var r = await apiAuthFetch('/api/regras/' + encodeURIComponent(cond.id_superlogica) + '/mandatos');
    var j = await r.json().catch(function () { return {}; });
    if (seq !== regrasMandEstado.seq) return;
    if (!r.ok) throw new Error(j.detalhe || 'falha ao carregar');
    regrasMandEstado.idCarregado = cond.id_superlogica;
    regrasMandEstado.lista = Array.isArray(j.mandatos) ? j.mandatos : [];
    regrasMandEstado.editando = null;
    st.textContent = '';
    regrasMandRender();
  } catch (e) {
    if (seq !== regrasMandEstado.seq) return;
    st.textContent = 'Não foi possível carregar: ' + (e.message || 'erro');
  }
}

// Tabela dos mandatos: atuais primeiro, depois o histórico. Linha em edição vira campos.
function regrasMandRender() {
  var lista = document.getElementById('regras-mand-lista');
  if (!lista) return;
  var ms = regrasMandEstado.lista.slice().sort(function (a, b) { return (b.atual ? 1 : 0) - (a.atual ? 1 : 0) || String(b.inicio || '').localeCompare(String(a.inicio || '')); });
  if (!ms.length) {
    lista.innerHTML = '<div style="font-size:12px;color:var(--muted)">Nenhum mandato registrado.' + (regrasMandPode('gerenciar') ? ' Use "Ler as atas do acervo" para buscar nas atas de eleição.' : '') + '</div>';
    return;
  }
  var gerencia = regrasMandPode('gerenciar');
  lista.innerHTML = ms.map(function (m) {
    var sit = m.atual ? regrasMandSituacao(m) : { txt: 'mandato anterior', cor: 'var(--muted)' };
    var ed = regrasMandEstado.editando === m.id;
    var nome = ed ? '<input type="text" id="regras-mand-nome-' + m.id + '" value="' + regrasAtaEsc(m.nome) + '" style="width:100%">' : regrasAtaEsc(m.nome || '');
    var fim = ed ? '<input type="text" id="regras-mand-fim-' + m.id + '" value="' + regrasAtaEsc(regrasAtaBR(m.fim)) + '" placeholder="DD/MM/AAAA" style="width:110px">' : (regrasAtaBR(m.fim) || 'sem data');
    var botoes = '';
    if (gerencia && ed) {
      botoes = '<button class="btn btn-primary" style="font-size:10px;padding:4px 8px" onclick="regrasMandSalvar(' + m.id + ')">Salvar</button>'
        + '<button class="btn btn-ghost" style="font-size:10px;padding:4px 8px" onclick="regrasMandEditar(null)">Cancelar</button>';
    } else if (gerencia) {
      botoes = (m.conferido ? '' : '<button class="btn btn-ghost" style="font-size:10px;padding:4px 8px" onclick="regrasMandConferir(' + m.id + ',true)">Conferido</button>')
        + '<button class="btn btn-ghost" style="font-size:10px;padding:4px 8px" onclick="regrasMandEditar(' + m.id + ')">Corrigir</button>';
    }
    return '<div style="padding:8px 12px;margin-bottom:6px;background:var(--bg3);border:1px solid var(--border);border-left:3px solid ' + sit.cor + ';border-radius:8px">'
      + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
      + '<span style="font-size:10px;font-family:var(--mono);text-transform:uppercase;min-width:110px;color:' + sit.cor + '">' + regrasAtaEsc(REGRAS_CARGO[m.cargo] || m.cargo) + '</span>'
      + '<div style="flex:1;min-width:160px;font-size:13px">' + nome + '</div>'
      + '<div style="font-size:11px;font-family:var(--mono);color:var(--muted)">início ' + (regrasAtaBR(m.inicio) || 'sem data') + ' · fim ' + fim + '</div>'
      + '<span style="font-size:11px;font-family:var(--mono);color:' + sit.cor + '">' + regrasAtaEsc(sit.txt) + '</span>'
      + '<span style="font-size:10px;font-family:var(--mono);color:' + (m.conferido ? 'var(--success)' : 'var(--muted)') + '">' + (m.conferido ? 'conferido' : 'a conferir') + '</span>'
      + '<div style="display:flex;gap:6px">' + botoes + '</div></div>'
      + (m.trecho ? '<details style="margin-top:4px"><summary style="font-size:11px;color:var(--muted);cursor:pointer">Trecho da ata</summary><div style="font-size:12px;margin-top:4px"><em>"' + regrasAtaEsc(m.trecho) + '"</em>'
        + (m.documento_id ? ' <button class="btn btn-ghost" style="font-size:10px;padding:2px 8px" onclick="regrasAtaAbrirDoc(' + Number(m.id_superlogica) + ',' + Number(m.documento_id) + ')">Abrir documento</button>' : '')
        + '</div></details>' : '')
      + '</div>';
  }).join('');
}

function regrasMandEditar(id) {
  regrasMandEstado.editando = id;
  regrasMandRender();
}

async function regrasMandPatch(id, corpo) {
  var r = await apiAuthFetch('/api/regras/mandatos/' + encodeURIComponent(id), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo)
  });
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok || !j.mandato) throw new Error(j.detalhe || 'não foi possível salvar');
  regrasMandEstado.lista = regrasMandEstado.lista.map(function (m) { return m.id === id ? Object.assign({}, m, j.mandato) : m; });
}

async function regrasMandConferir(id, valor) {
  try { await regrasMandPatch(id, { conferido: valor }); regrasMandRender(); }
  catch (e) { if (typeof toast === 'function') toast(e.message || 'Falha ao salvar', 'err'); }
}

// Corrigir: nome e fim digitados; salvar também marca como conferido (a pessoa olhou).
async function regrasMandSalvar(id) {
  var nome = (document.getElementById('regras-mand-nome-' + id) || {}).value || '';
  var fim = ((document.getElementById('regras-mand-fim-' + id) || {}).value || '').trim();
  try {
    await regrasMandPatch(id, { nome: nome.trim(), fim: fim || null, conferido: true });
    regrasMandEstado.editando = null;
    regrasMandRender();
    if (typeof toast === 'function') toast('Mandato corrigido', 'ok');
  } catch (e) { if (typeof toast === 'function') toast(e.message || 'Falha ao salvar', 'err'); }
}

async function regrasMandExtrair() {
  var cond = (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : null;
  if (!cond || !cond.id_superlogica) return;
  var bt = document.getElementById('regras-mand-extrair');
  var st = document.getElementById('regras-mand-status');
  if (bt) bt.disabled = true;
  st.textContent = 'Lendo as atas de eleição do acervo (pode levar alguns minutos)...';
  try {
    var r = await apiAuthFetch('/api/regras/' + encodeURIComponent(cond.id_superlogica) + '/mandatos/extrair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.detalhe || 'falha na leitura');
    regrasMandEstado.lista = Array.isArray(j.mandatos) ? j.mandatos : [];
    regrasMandEstado.idCarregado = cond.id_superlogica;
    var partes = [(j.atas_lidas || 0) + ' ata(s) lida(s)'];
    if (j.encontrou && !j.encontrou.sindico) partes.push('mandato de síndico não encontrado');
    if (j.encontrou && !j.encontrou.conselho) partes.push('mandato de conselho não encontrado');
    if (Array.isArray(j.falhas) && j.falhas.length) partes.push('não foi possível ler: ' + j.falhas.join(', '));
    st.textContent = partes.join('; ') + '.';
    regrasMandRender();
  } catch (e) {
    st.textContent = 'Não foi possível ler as atas: ' + (e.message || 'erro');
  } finally { if (bt) bt.disabled = false; }
}

window.addEventListener('regras-aba', function (e) { if (e && e.detail === 'mandatos') regrasMandCarregar(false); });
window.addEventListener('condominioAtivo:changed', function () {
  regrasMandEstado.idCarregado = null;
  var parte = document.getElementById('regras-mandatos');
  if (parte && parte.style.display !== 'none' && parte.offsetParent) regrasMandCarregar(true);
});
window.regrasConferirAta = regrasConferirAta;
