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
// ultimoChave: condomínio e modo (com ou sem resolvidos) do que está em "ultimo"; abertos: grupos expandidos por tipo;
// grupos: os grupos do último desenho (os botões apontam para eles pela posição); aviso: linha de estado no topo.
var alertasEstado = { seq: 0, idCarregado: null, verSilenciados: false, ultimo: null, ultimoChave: null, abertos: {}, grupos: [], aviso: '', marcando: false };
var ALERTA_UUID = /^[0-9a-f-]{36}$/i;
// Nome do grupo quando um tipo junta 3 ou mais alertas ("28 despesas recorrentes não lançadas").
var ALERTA_PLURAL = { mandato_vencendo: 'mandatos vencendo', advertencia_vencida: 'advertências vencidas', conta_a_vencer: 'contas a vencer',
  saldo_baixo: 'alertas de saldo baixo', recorrente_nao_lancada: 'despesas recorrentes não lançadas', sem_nota_fiscal: 'despesas sem nota fiscal',
  manutencao_atrasada: 'manutenções atrasadas', consumo_fora_padrao: 'consumos fora do padrão', certidao_vencendo: 'certidões vencendo', certidao_vencida: 'certidões vencidas' };
var ALERTA_LINHA_ESTADO = 'font-size:11px;color:var(--muted);font-family:var(--mono)';
var ALERTA_ROTULO = { mandato_vencendo: 'Mandato', advertencia_vencida: 'Advertência', conta_a_vencer: 'A vencer', saldo_baixo: 'Saldo', recorrente_nao_lancada: 'Recorrente',
  sem_nota_fiscal: 'Sem nota', manutencao_atrasada: 'Manutenção', consumo_fora_padrao: 'Consumo', certidao_vencendo: 'Certidão', certidao_vencida: 'Certidão' };

function alertasEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function alertasBRL(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function alertasPainelAberto() {
  var p = document.getElementById('panel-dashboard');
  return !!(p && p.classList.contains('active'));
}

// Cache por condomínio na aba (sessionStorage): ao trocar de condomínio a lista aparece na hora e é
// atualizada em seguida. Guarda uma impressão curta do login (não o token) para não servir a outro login.
function alertasImpressao(t) {
  var s = String(t || ''), h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '.' + s.length;
}
function alertasCacheApagar(id) { try { sessionStorage.removeItem('alertas_cache_' + id); } catch (e) { /* armazenamento bloqueado */ } }
function alertasCacheLer(id, todos) {
  try {
    var x = JSON.parse(sessionStorage.getItem('alertas_cache_' + id) || 'null');
    if (x && x.dono === alertasImpressao(window.AUTH_TOKEN) && x.todos === todos && x.dados) return x.dados;
  } catch (e) { alertasCacheApagar(id); }
  return null;
}
function alertasCacheGravar(id, todos, j) {
  try { sessionStorage.setItem('alertas_cache_' + id, JSON.stringify({ dono: alertasImpressao(window.AUTH_TOKEN), todos: todos, dados: j })); } catch (e) { /* cheio ou bloqueado */ }
}
function alertasSaldoNoCampo(j) {
  var inp = document.getElementById('alertas-saldo-min');
  if (inp && document.activeElement !== inp) inp.value = j.saldo_minimo ? String(j.saldo_minimo).replace('.', ',') : '';
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
  var chk = document.getElementById('alertas-ver-todos');
  var verTodos = !!(chk && chk.checked);
  var chave = cond.id_superlogica + '|' + (verTodos ? 1 : 0);
  // Já tem algo deste condomínio (na tela ou no cache): mostra na hora com "atualizando..." e busca por trás.
  var base = alertasEstado.ultimo && alertasEstado.ultimoChave === chave ? alertasEstado.ultimo : alertasCacheLer(cond.id_superlogica, verTodos);
  if (base) {
    alertasEstado.ultimo = base;
    alertasEstado.ultimoChave = chave;
    alertasEstado.aviso = '<div style="' + ALERTA_LINHA_ESTADO + '">atualizando...</div>';
    alertasSaldoNoCampo(base);
    alertasRender(base);
  } else {
    alertasEstado.aviso = '';
    lista.innerHTML = '<div style="font-size:12px;color:var(--muted);font-family:var(--mono)">Buscando alertas no Superlógica...</div>';
  }
  try {
    var qs = [];
    if (verTodos) qs.push('todos=1');
    if (forcar === true) qs.push('forcar=1');
    var url = '/api/condominio/' + encodeURIComponent(cond.id_superlogica) + '/alertas' + (qs.length ? '?' + qs.join('&') : '');
    var r = await apiAuthFetch(url);
    var j = await r.json().catch(function () { return {}; });
    if (seq !== alertasEstado.seq) return; // trocou de condomínio no meio
    var card = document.getElementById('alertas-card');
    if (r.status === 403) { alertasCacheApagar(cond.id_superlogica); if (card) card.style.display = 'none'; return; } // sem acesso ao Superlógica
    if (card) card.style.display = '';
    if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
    alertasEstado.idCarregado = cond.id_superlogica;
    alertasSaldoNoCampo(j);
    alertasEstado.ultimo = j;
    alertasEstado.ultimoChave = chave;
    alertasEstado.aviso = '';
    alertasCacheGravar(cond.id_superlogica, verTodos, j);
    alertasRender(j); // os grupos abertos ficam em alertasEstado.abertos e sobrevivem ao redesenho
  } catch (e) {
    if (seq !== alertasEstado.seq) return;
    var erro = '<div style="font-size:12px;color:var(--danger);font-family:var(--mono)">' + alertasEsc(e.message || 'Falha ao buscar alertas') + '</div>';
    // Com algo já na tela, mantém a lista e avisa que não atualizou; sem nada, mostra só o erro como antes.
    if (base) { alertasEstado.aviso = erro; alertasRender(base); } else lista.innerHTML = erro;
  }
}

// T51: link "Central de alertas" no cabeçalho do cartão. A função vem de outro arquivo;
// enquanto ela não existir o link fica escondido.
function alertasLinkCentral() {
  var card = document.getElementById('alertas-card');
  var cab = card ? card.querySelector('.card-header') : null;
  if (!cab) return;
  var tem = !!(window.CentralAlertas && typeof window.CentralAlertas.abrir === 'function');
  var link = document.getElementById('alertas-link-central');
  if (!link && tem) {
    link = document.createElement('a');
    link.id = 'alertas-link-central';
    link.href = '#';
    link.textContent = 'Central de alertas';
    link.style.cssText = 'font-size:11px;font-family:var(--mono);margin-left:10px';
    link.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (window.CentralAlertas && typeof window.CentralAlertas.abrir === 'function') window.CentralAlertas.abrir();
    });
    var titulo = cab.querySelector('.card-title');
    if (titulo) titulo.insertAdjacentElement('afterend', link); else cab.appendChild(link);
  }
  if (link) link.style.display = tem ? '' : 'none';
}

function alertasVerSilenciados() {
  alertasEstado.verSilenciados = !alertasEstado.verSilenciados;
  if (alertasEstado.ultimo) alertasRender(alertasEstado.ultimo);
}

function alertasRender(j) {
  alertasLinkCentral();
  var lista = document.getElementById('alertas-lista');
  var todosItens = Array.isArray(j.alertas) ? j.alertas : [];
  // T51: o servidor marca silenciado:true no que a pessoa desligou em "Meus alertas".
  // Esses saem da lista e só aparecem, apagados, quando ela pede para ver.
  var itens = todosItens.filter(function (a) { return !(a && a.silenciado === true); });
  var silenciados = todosItens.filter(function (a) { return a && a.silenciado === true; });
  var html = alertasEstado.aviso || '';
  if (Array.isArray(j.falhas) && j.falhas.length) {
    html += '<div style="font-size:11px;color:var(--warning);font-family:var(--mono)">Não foi possível ler agora: ' + alertasEsc(j.falhas.join(', ')) + '.</div>';
  }
  var linhaSil = '';
  if (silenciados.length) {
    linhaSil = '<div style="font-size:11px;color:var(--muted);font-family:var(--mono)">' + silenciados.length + (silenciados.length === 1 ? ' silenciado' : ' silenciados') + ' por você · ' +
      '<a href="#" onclick="alertasVerSilenciados();return false">' + (alertasEstado.verSilenciados ? 'esconder' : 'ver') + '</a></div>';
    if (alertasEstado.verSilenciados) {
      linhaSil += '<div style="display:flex;flex-direction:column;gap:6px;opacity:0.45">' + silenciados.map(alertasLinha).join('') + '</div>';
    }
  }
  alertasEstado.grupos = alertasAgrupar(itens);
  if (!itens.length) {
    html += '<div style="font-size:12px;color:var(--success);font-family:var(--mono)">Nenhum alerta aberto para este condomínio.</div>';
    lista.innerHTML = html + linhaSil;
    return;
  }
  // Tipo com 1 ou 2 alertas mostra as linhas; com 3 ou mais vira uma linha resumo que abre os itens.
  alertasEstado.grupos.forEach(function (g, i) {
    if (g.itens.length < 3) { html += g.itens.map(alertasLinha).join(''); return; }
    html += alertasLinhaGrupo(g, i);
    if (alertasEstado.abertos[g.tipo]) html += '<div style="display:flex;flex-direction:column;gap:6px;padding-left:12px">' + g.itens.map(alertasLinha).join('') + '</div>';
  });
  lista.innerHTML = html + linhaSil;
}

// Agrupa os alertas por tipo na ordem em que o primeiro de cada tipo aparece.
function alertasAgrupar(itens) {
  var mapa = Object.create(null), grupos = [];
  (itens || []).forEach(function (a) {
    var t = String(a && a.tipo || '');
    if (!mapa[t]) { mapa[t] = { tipo: t, itens: [] }; grupos.push(mapa[t]); }
    mapa[t].itens.push(a);
  });
  return grupos;
}

// Texto da linha resumo: título com a contagem e, no detalhe, os nomes distintos e o total quando faz sentido.
function alertasResumoGrupo(g) {
  var n = g.itens.length, tipo = g.tipo;
  var titulo = n + ' ' + (ALERTA_PLURAL[tipo] || ('alertas de ' + String(ALERTA_ROTULO[tipo] || tipo).toLowerCase()));
  var porFornecedor = tipo === 'recorrente_nao_lancada' || tipo === 'conta_a_vencer';
  var nomes = [], vistos = Object.create(null), total = 0;
  g.itens.forEach(function (a) {
    var d = a.detalhe || {};
    var nome = String((porFornecedor && d.fornecedor) || a.titulo || '').trim();
    if (nome && !vistos[nome]) { vistos[nome] = true; nomes.push(nome); }
    if (tipo === 'recorrente_nao_lancada') total += Number(d.valor_ultimo) || 0;
    if (tipo === 'conta_a_vencer') total += Number(d.valor) || 0;
  });
  var mostrados = nomes.slice(0, 3);
  var extra = mostrados.join(', ') + (n > mostrados.length ? ' e mais ' + (n - mostrados.length) : '');
  if (tipo === 'recorrente_nao_lancada') extra += ' · total do último lançamento ' + alertasBRL(total);
  if (tipo === 'conta_a_vencer') extra += ' · total ' + alertasBRL(total);
  return { titulo: titulo, extra: extra };
}

function alertasCor(status) { return status === 'novo' ? 'var(--warning)' : status === 'visto' ? 'var(--muted)' : 'var(--success)'; }
var ALERTA_BOTAO = 'class="btn btn-ghost" style="font-size:10px;padding:4px 8px"';

// Caixa de um alerta (rótulo, título, detalhe e botões). A linha comum e a linha resumo usam o mesmo desenho.
function alertasCaixa(cor, rotulo, titulo, extra, botoes) {
  return '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-left:3px solid ' + cor + ';border-radius:8px">' +
    '<span style="font-size:10px;font-family:var(--mono);color:' + cor + ';text-transform:uppercase;min-width:74px">' + alertasEsc(rotulo) + '</span>' +
    '<div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--text)">' + alertasEsc(titulo) + '</div>' +
    '<div style="font-size:11px;color:var(--muted);font-family:var(--mono)">' + alertasEsc(extra) + '</div></div>' +
    '<div style="display:flex;gap:6px">' + botoes + '</div></div>';
}

// Ids do grupo que ainda podem ser marcados como vistos (os mesmos que teriam o botão Visto).
function alertasPendentesGrupo(g) {
  return g.itens.filter(function (a) { return a.id && ALERTA_UUID.test(String(a.id)) && a.status !== 'visto' && a.status !== 'resolvido'; }).map(function (a) { return a.id; });
}

// Linha resumo de um tipo com 3 ou mais alertas. A cor segue o mais urgente do grupo (novo, depois visto).
function alertasLinhaGrupo(g, i) {
  var r = alertasResumoGrupo(g);
  var status = g.itens.some(function (a) { return a.status === 'novo'; }) ? 'novo' : g.itens.some(function (a) { return a.status === 'visto'; }) ? 'visto' : 'resolvido';
  var aberto = !!alertasEstado.abertos[g.tipo];
  var botoes = '<button type="button" id="alertas-grupo-' + i + '" ' + ALERTA_BOTAO + ' aria-expanded="' + (aberto ? 'true' : 'false') + '" onclick="alertasGrupoAlternar(' + i + ')">' + (aberto ? 'Esconder itens' : 'Ver itens') + '</button>';
  if (alertasPendentesGrupo(g).length) botoes += '<button type="button" ' + ALERTA_BOTAO + ' onclick="alertasGrupoMarcarVistos(' + i + ')">Marcar todos como vistos</button>';
  return alertasCaixa(alertasCor(status), ALERTA_ROTULO[g.tipo] || g.tipo, r.titulo, r.extra, botoes);
}

function alertasGrupoAlternar(i) {
  var g = alertasEstado.grupos[i];
  if (!g || !alertasEstado.ultimo) return;
  alertasEstado.abertos[g.tipo] = !alertasEstado.abertos[g.tipo];
  alertasRender(alertasEstado.ultimo);
  // A lista é redesenhada inteira; devolve o foco ao botão para quem usa teclado.
  var b = document.getElementById('alertas-grupo-' + i);
  if (b && b.focus) b.focus();
}

// Marca como vistos todos os alertas do grupo, um por vez na mesma rota do botão Visto, e recarrega no fim.
async function alertasGrupoMarcarVistos(i) {
  var g = alertasEstado.grupos[i];
  if (!g || alertasEstado.marcando) return;
  var ids = alertasPendentesGrupo(g);
  if (!ids.length) return;
  var r0 = alertasResumoGrupo(g);
  if (!confirm('Marcar como vistos os ' + ids.length + ' alertas de "' + r0.titulo + '"?')) return;
  alertasEstado.marcando = true;
  var falhas = 0;
  try {
    for (var k = 0; k < ids.length; k++) {
      try {
        var r = await apiAuthFetch('/api/alertas/' + ids[k], { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'visto' }) });
        if (!r.ok) falhas++;
      } catch (e) { falhas++; }
    }
  } finally { alertasEstado.marcando = false; }
  if (falhas) toast('Não foi possível marcar ' + falhas + ' de ' + ids.length + ' alertas.', 'err');
  else toast(ids.length + ' alertas marcados como vistos', 'ok');
  alertasDashAbrir('estado');
}

// Uma linha de alerta do cartão (mesmo desenho de antes, agora reaproveitado para os silenciados).
function alertasLinha(a) {
  var d = a.detalhe || {};
  var extra = '';
  if (a.tipo === 'conta_a_vencer') extra = alertasBRL(d.valor) + (d.descricao ? ' · ' + d.descricao : '');
  if (a.tipo === 'saldo_baixo') extra = (d.conta || '') + ': ' + alertasBRL(d.saldo) + ' (limite ' + alertasBRL(d.limite) + ')';
  if (a.tipo === 'recorrente_nao_lancada') extra = 'último lançamento ' + (d.ultimo_vencimento || '') + ', ' + alertasBRL(d.valor_ultimo);
  // T08: o servidor manda o resumo pronto (nota fiscal, manutenção e consumo).
  if (!extra && d.resumo) extra = d.resumo;
  var cor = alertasCor(a.status);
  var botoes = '';
  // O id só entra no onclick se for um UUID (evita injetar texto vindo do servidor no atributo).
  var idOk = a.id && ALERTA_UUID.test(String(a.id));
  if (idOk && a.status !== 'visto' && a.status !== 'resolvido') botoes += '<button ' + ALERTA_BOTAO + ' onclick="alertasMarcar(\'' + a.id + '\',\'visto\')">Visto</button>';
  if (idOk && a.status !== 'resolvido') botoes += '<button ' + ALERTA_BOTAO + ' onclick="alertasMarcar(\'' + a.id + '\',\'resolvido\')">Resolvido</button>';
  if (idOk && a.status === 'resolvido') botoes += '<button ' + ALERTA_BOTAO + ' onclick="alertasMarcar(\'' + a.id + '\',\'novo\')">Reabrir</button>';
  return alertasCaixa(cor, ALERTA_ROTULO[a.tipo] || a.tipo, a.titulo, extra, botoes);
}

async function alertasMarcar(id, status) {
  if (!ALERTA_UUID.test(String(id))) return;
  try {
    var r = await apiAuthFetch('/api/alertas/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status }) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
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
    if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
    toast(j.saldo_minimo ? 'Limite de saldo salvo: ' + alertasBRL(j.saldo_minimo) : 'Alerta de saldo desligado', 'ok');
    alertasDashAbrir(true);
  } catch (e) { toast('Não foi possível salvar o limite: ' + e.message, 'err'); }
}

// Trocou o condomínio: recarrega se o Dashboard estiver aberto, senão na próxima abertura.
window.addEventListener('condominioAtivo:trocou', function () {
  alertasEstado.seq++;
  alertasEstado.idCarregado = null;
  alertasEstado.ultimo = null;
  alertasEstado.ultimoChave = null;
  alertasEstado.abertos = {};
  alertasEstado.grupos = [];
  alertasEstado.aviso = '';
  var inp = document.getElementById('alertas-saldo-min'); if (inp) inp.value = '';
  if (alertasPainelAberto()) alertasDashAbrir();
});
document.addEventListener('auth:ready', function () { alertasLinkCentral(); if (alertasPainelAberto()) alertasDashAbrir(); });
setTimeout(function () { alertasLinkCentral(); if (alertasPainelAberto() && window.AUTH_TOKEN) alertasDashAbrir(); }, 0);
