// ============================================================
// DASHBOARD E JANELA GERENCIAR CONDOMÍNIO: extraído de public/index.html (T02).
// Usa o seletor único (condominio-seletor.js). Script clássico: funções e variáveis seguem globais,
// no mesmo escopo do script inline do index.html.
// ============================================================

// Card "Condomínio ativo" do Dashboard: seletor único (troca vale para o sistema todo)
// e o botão para cadastrar um condomínio novo.
function atualizarDashCond() {
  if (window.CondSeletor && document.getElementById('dash-cond-seletor')) {
    CondSeletor.montar('dash-cond-seletor', { placeholder: 'Clique para ver todos ou digite o nome' });
  }
  var btnGer = document.getElementById('btn-gerenciar-cond');
  if (btnGer) btnGer.textContent = 'Cadastrar novo condomínio';
}

// Abre a janela Gerenciar Condomínio Ativo. aba: 'buscar' (padrão) ou 'cadastrar'.
function dashAbrirModalGerenciarCond(aba) {
  const m = document.getElementById('dash-modal-gerenciar-cond');
  if (!m) return;
  { const n = document.getElementById('dash-modal-nome-cond'); if (n) n.value = ''; }
  document.getElementById('dash-modal-id-superlogica').value = '';
  if (window.CondSeletor) {
    CondSeletor.montar('dash-modal-cond-seletor', {
      placeholder: 'Clique para ver todos ou digite o nome',
      aoEscolher: function (c) {
        dashFecharModalGerenciarCond();
        toast('Condomínio selecionado: ' + c.nome, 'ok');
      }
    });
  }
  // Sem aba pedida começa em Buscar, para evitar cadastro acidental
  dashModalSetTab(aba === 'cadastrar' ? 'cadastrar' : 'buscar');
  const hint = document.getElementById('dash-modal-cond-ativo-hint');
  if (hint) {
    const condAtual = getCondominioAtivo();
    hint.textContent = condAtual && condAtual.nome
      ? 'Ativo: ' + condAtual.nome + (condAtual.id_superlogica ? ' (código ' + condAtual.id_superlogica + ' no Superlógica)' : '')
      : 'Nenhum condomínio ativo no momento.';
  }
  m.style.display = 'flex';
}

function dashFecharModalGerenciarCond() {
  const m = document.getElementById('dash-modal-gerenciar-cond');
  if (m) m.style.display = 'none';
}

// Alterna entre as abas do modal (buscar/cadastrar) e ajusta visibilidade do botão Salvar.
function dashModalSetTab(aba) {
  const tabs = document.querySelectorAll('#dash-modal-gerenciar-cond .tab');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.aba === aba));
  document.getElementById('dash-modal-aba-buscar').style.display = aba === 'buscar' ? '' : 'none';
  document.getElementById('dash-modal-aba-cadastrar').style.display = aba === 'cadastrar' ? '' : 'none';
  document.getElementById('dash-modal-btn-salvar').style.display = aba === 'cadastrar' ? '' : 'none';
}

// Valida campos, faz POST no Supabase e auto seleciona o condominio recem cadastrado como ativo no Dashboard.
async function dashSalvarNovoCondominio() {
  const idSupRaw = (document.getElementById('dash-modal-id-superlogica').value || '').trim();
  if (!idSupRaw || !/^[0-9]+$/.test(idSupRaw) || parseInt(idSupRaw, 10) <= 0) {
    toast('ID Superlógica deve ser um número inteiro positivo.', 'err');
    return;
  }
  const idSuperlogica = parseInt(idSupRaw, 10);
  // T16: o cadastro passa pelo servidor, que confere o código no Superlógica e usa o nome de lá.
  const resp = await apiAuthFetch('/api/condominios/cadastrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_superlogica: idSuperlogica }) });
  const dados = await resp.json().catch(() => null);
  if (!resp.ok || !dados) {
    toast((dados && dados.detalhe) || ('Não foi possível cadastrar (' + resp.status + ').'), 'err');
    return;
  }
  const novo = Array.isArray(dados) ? dados[0] : dados;
  // Auto-selecionar como condomínio ativo usando setCondominioAtivo
  // para garantir sincronização com localStorage, state.config e banners
  const idSupFinal = novo.id_superlogica != null ? novo.id_superlogica : idSuperlogica;
  // A lista do seletor único passa a ter o novo condomínio
  if (window.CondSeletor) CondSeletor.recarregar();
  if (setCondominioAtivo({ id: novo.id, nome: novo.nome, id_superlogica: idSupFinal }) === false) {
    toast('Condomínio cadastrado: ' + novo.nome + '. Ele não foi ativado agora porque há um envio em andamento.', 'warn');
    return;
  }
  // Sincroniza o hidden do painel Configurações com o ID Superlógica (numérico),
  // não o UUID Supabase, para que saveConfig não regrave UUID como condId.
  const hiddenNew = document.getElementById('cfg-cond-id');
  if (hiddenNew) hiddenNew.value = idSupFinal || '';
  dashFecharModalGerenciarCond();
  toast('Condominio cadastrado e selecionado: ' + novo.nome, 'ok');
}


// ============================================================
// ALERTAS DO CONDOMÍNIO (T05): contas a pagar em 7 dias, saldo da conta principal
// abaixo do limite e despesas recorrentes não lançadas. Marcar visto ou resolvido
// fica guardado no servidor (tabela alertas). Rota: /api/condominio/:id/alertas.
// ============================================================
var alertasEstado = { seq: 0, idCarregado: null };
var ALERTA_ROTULO = { conta_a_vencer: 'A vencer', saldo_baixo: 'Saldo', recorrente_nao_lancada: 'Recorrente',
  sem_nota_fiscal: 'Sem nota', manutencao_atrasada: 'Manutenção', consumo_fora_padrao: 'Consumo' };

function alertasEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function alertasBRL(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function alertasPainelAberto() {
  var p = document.getElementById('panel-dashboard');
  return !!(p && p.classList.contains('active'));
}

async function alertasDashAbrir(forcar) {
  var lista = document.getElementById('alertas-lista');
  if (!lista || !window.AUTH_TOKEN) return;
  var cond = (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : null;
  if (!cond || !cond.id_superlogica) {
    lista.innerHTML = '<div style="font-size:12px;color:var(--muted);font-family:var(--mono)">Selecione um condomínio com código do Superlógica para ver os alertas.</div>';
    alertasEstado.idCarregado = null;
    return;
  }
  if (!forcar && alertasEstado.idCarregado === cond.id_superlogica) return;
  var seq = ++alertasEstado.seq;
  lista.innerHTML = '<div style="font-size:12px;color:var(--muted);font-family:var(--mono)">Buscando alertas no Superlógica...</div>';
  try {
    var todos = document.getElementById('alertas-ver-todos');
    var qs = [];
    if (todos && todos.checked) qs.push('todos=1');
    if (forcar === true) qs.push('forcar=1');
    var url = '/api/condominio/' + encodeURIComponent(cond.id_superlogica) + '/alertas' + (qs.length ? '?' + qs.join('&') : '');
    var r = await apiAuthFetch(url);
    var j = await r.json().catch(function () { return {}; });
    if (seq !== alertasEstado.seq) return; // trocou de condomínio no meio
    var card = document.getElementById('alertas-card');
    if (r.status === 403) { if (card) card.style.display = 'none'; return; } // sem acesso ao Superlógica
    if (card) card.style.display = '';
    if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
    alertasEstado.idCarregado = cond.id_superlogica;
    var inp = document.getElementById('alertas-saldo-min');
    if (inp && document.activeElement !== inp) inp.value = j.saldo_minimo ? String(j.saldo_minimo).replace('.', ',') : '';
    alertasRender(j);
  } catch (e) {
    if (seq !== alertasEstado.seq) return;
    lista.innerHTML = '<div style="font-size:12px;color:var(--danger);font-family:var(--mono)">' + alertasEsc(e.message || 'Falha ao buscar alertas') + '</div>';
  }
}

function alertasRender(j) {
  var lista = document.getElementById('alertas-lista');
  var itens = Array.isArray(j.alertas) ? j.alertas : [];
  var html = '';
  if (Array.isArray(j.falhas) && j.falhas.length) {
    html += '<div style="font-size:11px;color:var(--warning);font-family:var(--mono)">Não foi possível ler agora: ' + alertasEsc(j.falhas.join(', ')) + '.</div>';
  }
  if (!itens.length) {
    html += '<div style="font-size:12px;color:var(--success);font-family:var(--mono)">Nenhum alerta aberto para este condomínio.</div>';
    lista.innerHTML = html;
    return;
  }
  html += itens.map(function (a) {
    var d = a.detalhe || {};
    var extra = '';
    if (a.tipo === 'conta_a_vencer') extra = alertasBRL(d.valor) + (d.descricao ? ' · ' + d.descricao : '');
    if (a.tipo === 'saldo_baixo') extra = (d.conta || '') + ': ' + alertasBRL(d.saldo) + ' (limite ' + alertasBRL(d.limite) + ')';
    if (a.tipo === 'recorrente_nao_lancada') extra = 'último lançamento ' + (d.ultimo_vencimento || '') + ', ' + alertasBRL(d.valor_ultimo);
    // T08: o servidor manda o resumo pronto (nota fiscal, manutenção e consumo).
    if (!extra && d.resumo) extra = d.resumo;
    var cor = a.status === 'novo' ? 'var(--warning)' : a.status === 'visto' ? 'var(--muted)' : 'var(--success)';
    var botoes = '';
    if (a.id && a.status !== 'visto' && a.status !== 'resolvido') botoes += '<button class="btn btn-ghost" style="font-size:10px;padding:4px 8px" onclick="alertasMarcar(\'' + a.id + '\',\'visto\')">Visto</button>';
    if (a.id && a.status !== 'resolvido') botoes += '<button class="btn btn-ghost" style="font-size:10px;padding:4px 8px" onclick="alertasMarcar(\'' + a.id + '\',\'resolvido\')">Resolvido</button>';
    if (a.id && a.status === 'resolvido') botoes += '<button class="btn btn-ghost" style="font-size:10px;padding:4px 8px" onclick="alertasMarcar(\'' + a.id + '\',\'novo\')">Reabrir</button>';
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-left:3px solid ' + cor + ';border-radius:8px">' +
      '<span style="font-size:10px;font-family:var(--mono);color:' + cor + ';text-transform:uppercase;min-width:74px">' + alertasEsc(ALERTA_ROTULO[a.tipo] || a.tipo) + '</span>' +
      '<div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--text)">' + alertasEsc(a.titulo) + '</div>' +
      '<div style="font-size:11px;color:var(--muted);font-family:var(--mono)">' + alertasEsc(extra) + '</div></div>' +
      '<div style="display:flex;gap:6px">' + botoes + '</div></div>';
  }).join('');
  lista.innerHTML = html;
}

async function alertasMarcar(id, status) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return;
  try {
    var r = await apiAuthFetch('/api/alertas/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status }) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
    alertasDashAbrir('estado');
  } catch (e) { toast('Não foi possível atualizar o alerta: ' + e.message, 'err'); }
}

async function alertasSalvarSaldo() {
  var cond = (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : null;
  if (!cond || !cond.id_superlogica) { toast('Selecione um condomínio primeiro', 'err'); return; }
  var bruto = (document.getElementById('alertas-saldo-min').value || '').trim().replace(/\s+/g, '');
  // "5.000,50" ou "5000,50": vírgula é decimal e ponto é milhar. Sem vírgula, ponto é decimal ("5000.50").
  var v = bruto.indexOf(',') >= 0 ? bruto.replace(/\./g, '').replace(',', '.') : bruto;
  if (v && !/^\d+(\.\d{1,2})?$/.test(v)) { toast('Informe o valor só com números, por exemplo 5000,00', 'err'); return; }
  try {
    var r = await apiAuthFetch('/api/condominio/' + encodeURIComponent(cond.id_superlogica) + '/alertas/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ saldo_minimo: v ? Number(v) : null })
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
    toast(j.saldo_minimo ? 'Limite de saldo salvo: ' + alertasBRL(j.saldo_minimo) : 'Alerta de saldo desligado', 'ok');
    alertasDashAbrir(true);
  } catch (e) { toast('Não foi possível salvar o limite: ' + e.message, 'err'); }
}

// Trocou o condomínio: recarrega se o Dashboard estiver aberto, senão na próxima abertura.
window.addEventListener('condominioAtivo:trocou', function () {
  alertasEstado.seq++;
  alertasEstado.idCarregado = null;
  var inp = document.getElementById('alertas-saldo-min'); if (inp) inp.value = '';
  if (alertasPainelAberto()) alertasDashAbrir();
});
document.addEventListener('auth:ready', function () { if (alertasPainelAberto()) alertasDashAbrir(); });
setTimeout(function () { if (alertasPainelAberto() && window.AUTH_TOKEN) alertasDashAbrir(); }, 0);
