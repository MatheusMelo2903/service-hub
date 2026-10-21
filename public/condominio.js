// ============================================================
// FICHA DO CONDOMÍNIO (T04): consulta só de leitura no Superlógica.
// Ficha do condomínio ativo (cadastro, saldos, despesas pagas no mês, contas
// vencidas e a vencer, inadimplência), auditoria cadastral das unidades e
// busca de unidades em todos os condomínios.
// Rotas: /api/condominio/:id/ficha, /api/condominio/:id/auditoria, /api/unidades/busca.
// ============================================================

var fichaEstado = { idCarregado: null, mes: '', carregando: false, seq: 0 };

function fichaEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fichaBRL(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fichaPainelAberto() {
  var p = document.getElementById('panel-condominio');
  return !!(p && p.classList.contains('active'));
}
async function fichaGet(url) {
  var r = await apiAuthFetch(url);
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
  return j;
}

// Mês das despesas pagas: começa no mês atual.
function fichaPreencherMeses() {
  var sel = document.getElementById('ficha-mes');
  if (!sel || sel.options.length) return;
  var nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  var d = new Date();
  for (var i = 0; i < 24; i++) {
    var y = d.getFullYear(), m = d.getMonth() + 1;
    var o = document.createElement('option');
    o.value = y + '-' + String(m).padStart(2, '0');
    o.textContent = nomes[m - 1] + '/' + y;
    sel.appendChild(o);
    d.setMonth(d.getMonth() - 1);
  }
  fichaEstado.mes = sel.value;
}

// Chamada ao abrir a aba e a cada troca de condomínio.
function condominioFichaAbrir(forcar) {
  fichaPreencherMeses();
  var cond = getCondominioAtivo();
  var id = cond && cond.id_superlogica;
  var corpo = document.getElementById('ficha-corpo');
  var aviso = document.getElementById('ficha-aviso');
  if (!corpo) return;
  if (!cond || !id) {
    corpo.style.display = 'none';
    aviso.style.display = '';
    aviso.textContent = cond ? 'Esse condomínio está sem o código do Superlógica no cadastro, então não há ficha para mostrar.'
                             : 'Escolha um condomínio no seletor acima para ver a ficha.';
    fichaEstado.idCarregado = null;
    return;
  }
  aviso.style.display = 'none';
  corpo.style.display = '';
  if (!forcar && fichaEstado.idCarregado === String(id) + '|' + fichaEstado.mes) return;
  fichaCarregar(id);
}

async function fichaCarregar(id) {
  var seq = ++fichaEstado.seq;
  fichaEstado.idCarregado = String(id) + '|' + fichaEstado.mes;
  ['ficha-cadastro', 'ficha-contas', 'ficha-despesas', 'ficha-pendentes', 'ficha-inad'].forEach(function (k) {
    var el = document.getElementById(k);
    if (el) el.innerHTML = '<div class="cond-loading">Carregando do Superlógica...</div>';
  });
  var aud = document.getElementById('ficha-auditoria');
  if (aud) aud.innerHTML = '<div class="ficha-sub">Confere CPF/CNPJ, email e telefone do proprietário de cada unidade e a soma da fração ideal. Pode levar alguns segundos.</div>';
  try {
    var d = await fichaGet('/api/condominio/' + encodeURIComponent(id) + '/ficha?mes=' + encodeURIComponent(fichaEstado.mes));
    if (seq !== fichaEstado.seq) return; // trocou de condomínio no meio
    fichaRenderCadastro(d.cadastro);
    fichaRenderContas(d.contas);
    fichaRenderDespesas(d.despesas_mes);
    fichaRenderPendentes(d.pendentes);
    fichaRenderInad(d.inadimplencia);
    var at = document.getElementById('ficha-atualizado');
    if (at) at.textContent = 'Atualizado às ' + new Date(d.gerado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    if (seq !== fichaEstado.seq) return;
    fichaEstado.idCarregado = null;
    ['ficha-cadastro', 'ficha-contas', 'ficha-despesas', 'ficha-pendentes', 'ficha-inad'].forEach(function (k) {
      var el = document.getElementById(k);
      if (el) el.innerHTML = '<div class="ficha-erro">' + fichaEsc(e.message) + '</div>';
    });
  }
}

function fichaParteErro(el, parte) {
  if (parte && parte.ok) return false;
  el.innerHTML = '<div class="ficha-erro">' + fichaEsc((parte && parte.erro) || 'Sem dados.') + '</div>';
  return true;
}

function fichaRenderCadastro(p) {
  var el = document.getElementById('ficha-cadastro');
  if (!el || fichaParteErro(el, p)) return;
  var c = p.dados;
  var linha = function (rot, val) { return '<div class="ficha-kv"><span>' + rot + '</span><strong>' + (val ? fichaEsc(val) : '<em>não informado</em>') + '</strong></div>'; };
  var sind = c.sindico ? c.sindico.nome + ' (' + c.sindico.cargo + (c.sindico.mandato_fim ? ', mandato até ' + c.sindico.mandato_fim : '') + ')' : '';
  var html = linha('Nome no Superlógica', c.nome)
    + (c.nome_fantasia && c.nome_fantasia !== c.nome ? linha('Nome fantasia', c.nome_fantasia) : '')
    + linha('CNPJ', c.cnpj)
    + linha('Endereço', c.endereco && c.endereco.completo)
    + linha('Síndico', sind);
  if (c.subsindicos && c.subsindicos.length) html += linha('Subsíndico', c.subsindicos.map(function (s) { return s.nome; }).join('; '));
  html += linha('Conselho', (c.conselho || []).map(function (s) { return s.nome; }).join('; '));
  el.innerHTML = html;
}

function fichaRenderContas(p) {
  var el = document.getElementById('ficha-contas');
  if (!el || fichaParteErro(el, p)) return;
  var d = p.dados;
  if (!d.contas.length) { el.innerHTML = '<div class="ficha-sub">Nenhuma conta ativa.</div>'; return; }
  el.innerHTML = '<table class="ficha-tab"><tr><th>Conta</th><th>Banco</th><th class="n">Saldo</th></tr>'
    + d.contas.map(function (c) {
      return '<tr><td>' + fichaEsc(c.descricao) + (c.principal ? ' <span class="ficha-tag">principal</span>' : '') + '</td><td>' + fichaEsc(c.banco) + (c.conta ? ' · ' + fichaEsc(c.conta) : '') + '</td><td class="n' + (c.saldo < 0 ? ' neg' : '') + '">' + fichaBRL(c.saldo) + '</td></tr>';
    }).join('')
    + '<tr class="tot"><td colspan="2">Total</td><td class="n">' + fichaBRL(d.total) + '</td></tr></table>';
}

function fichaTabelaDespesas(lista, colData) {
  if (!lista.itens.length) return '<div class="ficha-sub">Nenhuma.</div>';
  return '<table class="ficha-tab"><tr><th>' + colData + '</th><th>Fornecedor</th><th>Descrição</th><th class="n">Valor</th></tr>'
    + lista.itens.map(function (x) {
      var dt = colData === 'Pago em' ? x.liquidacao : x.vencimento;
      return '<tr><td>' + fichaEsc(dt) + '</td><td>' + fichaEsc(x.fornecedor) + '</td><td>' + fichaEsc(x.descricao) + (x.complemento && x.complemento !== x.descricao ? ' <span class="ficha-sub">' + fichaEsc(x.complemento) + '</span>' : '') + '</td><td class="n">' + fichaBRL(x.valor) + '</td></tr>';
    }).join('')
    + '<tr class="tot"><td colspan="3">Total (' + lista.quantidade + ')</td><td class="n">' + fichaBRL(lista.total) + '</td></tr></table>'
    + (lista.truncado ? '<div class="ficha-sub">Lista cortada: há mais itens no Superlógica.</div>' : '');
}

function fichaRenderDespesas(p) {
  var el = document.getElementById('ficha-despesas');
  if (!el || fichaParteErro(el, p)) return;
  el.innerHTML = fichaTabelaDespesas(p.dados, 'Pago em');
}

function fichaRenderPendentes(p) {
  var el = document.getElementById('ficha-pendentes');
  if (!el || fichaParteErro(el, p)) return;
  var d = p.dados;
  el.innerHTML = '<div class="ficha-subtitulo">Vencidas e não pagas (últimos 12 meses)</div>' + fichaTabelaDespesas(d.vencidas, 'Venceu em')
    + '<div class="ficha-subtitulo" style="margin-top:14px">A vencer nos próximos 30 dias</div>' + fichaTabelaDespesas(d.a_vencer_30_dias, 'Vence em');
}

function fichaRenderInad(p) {
  var el = document.getElementById('ficha-inad');
  if (!el || fichaParteErro(el, p)) return;
  var d = p.dados;
  if (!d.unidades.length) { el.innerHTML = '<div class="ficha-sub">Nenhuma unidade em atraso hoje.</div>'; return; }
  el.innerHTML = '<div class="ficha-resumo">' + d.quantidade_unidades + ' unidade' + (d.quantidade_unidades > 1 ? 's' : '') + ' em atraso · '
    + fichaBRL(d.total_original) + ' em aberto · ' + fichaBRL(d.total_corrigido) + ' com juros e multa</div>'
    + '<table class="ficha-tab"><tr><th>Unidade</th><th>Responsável</th><th class="n">Cobranças</th><th>Mais antiga</th><th class="n">Em aberto</th><th class="n">Corrigido</th></tr>'
    + d.unidades.map(function (u) {
      return '<tr><td>' + fichaEsc(u.unidade + (u.bloco ? ' ' + u.bloco : '')) + (u.juridico ? ' <span class="ficha-tag">jurídico</span>' : '') + '</td><td>' + fichaEsc(u.responsavel) + '</td><td class="n">' + u.cobrancas + '</td><td>' + fichaEsc(u.vencimento_mais_antigo) + '</td><td class="n">' + fichaBRL(u.valor_original) + '</td><td class="n">' + fichaBRL(u.valor_corrigido) + '</td></tr>';
    }).join('') + '</table>'
    + (d.truncado ? '<div class="ficha-sub">Lista cortada: há mais unidades no Superlógica.</div>' : '');
}

async function fichaRodarAuditoria() {
  var cond = getCondominioAtivo();
  var id = cond && cond.id_superlogica;
  var el = document.getElementById('ficha-auditoria');
  var btn = document.getElementById('ficha-btn-auditoria');
  if (!id || !el) return;
  var seq = fichaEstado.seq;
  btn.disabled = true;
  el.innerHTML = '<div class="cond-loading">Lendo as unidades no Superlógica...</div>';
  try {
    var a = await fichaGet('/api/condominio/' + encodeURIComponent(id) + '/auditoria');
    if (seq !== fichaEstado.seq) return;
    var f = a.fracao;
    var html = '<div class="ficha-resumo">' + a.total_unidades + ' unidades · sem CPF/CNPJ: ' + a.sem_cpf + ' · sem email: ' + a.sem_email + ' · sem telefone: ' + a.sem_telefone + '</div>'
      + '<div class="' + (f.ok ? 'ficha-ok' : 'ficha-erro') + '">Soma da fração ideal: ' + String(f.soma_percentual).replace('.', ',') + '%'
      + (f.ok ? ' (fecha 100%)' : ' (não fecha 100%: conferir o cadastro)')
      + (f.unidades_sem_fracao.length ? '. Sem fração: ' + fichaEsc(f.unidades_sem_fracao.join(', ')) : '') + '</div>';
    if (a.pendencias.length) {
      html += '<table class="ficha-tab"><tr><th>Unidade</th><th>Proprietário</th><th>Falta</th></tr>'
        + a.pendencias.map(function (p) { return '<tr><td>' + fichaEsc(p.unidade) + '</td><td>' + fichaEsc(p.proprietario) + '</td><td>' + fichaEsc(p.falta.join(', ')) + '</td></tr>'; }).join('')
        + '</table>';
    }
    if (a.truncado) html += '<div class="ficha-sub">Lista cortada: o condomínio tem mais unidades do que o limite da consulta.</div>';
    el.innerHTML = html;
  } catch (e) {
    if (seq === fichaEstado.seq) el.innerHTML = '<div class="ficha-erro">' + fichaEsc(e.message) + '</div>';
  } finally {
    btn.disabled = false;
  }
}

// Busca de unidades em todos os condomínios.
async function fichaBuscar(ev) {
  if (ev) ev.preventDefault();
  var inp = document.getElementById('ficha-busca');
  var el = document.getElementById('ficha-busca-res');
  var q = (inp.value || '').replace(/\s+/g, ' ').trim();
  if (q.length < 3) { el.innerHTML = '<div class="ficha-erro">Digite pelo menos 3 caracteres.</div>'; return; }
  el.innerHTML = '<div class="cond-loading">Buscando em todos os condomínios...</div>';
  try {
    var r = await fichaGet('/api/unidades/busca?q=' + encodeURIComponent(q));
    if (!r.itens.length) { el.innerHTML = '<div class="ficha-sub">Nada encontrado para "' + fichaEsc(q) + '".</div>'; return; }
    el.innerHTML = '<div class="ficha-sub">' + r.quantidade + ' resultado' + (r.quantidade > 1 ? 's' : '') + (r.truncado ? ' (mostrando os primeiros)' : '') + '</div>'
      + '<table class="ficha-tab"><tr><th>Condomínio</th><th>Unidade</th><th>Proprietário</th><th>Contatos</th><th></th></tr>'
      + r.itens.map(function (u, i) {
        var hub = u.id_superlogica && window.CondSeletor ? (CondSeletor.lista() || []).find(function (c) { return String(c.id_superlogica) === String(u.id_superlogica); }) : null;
        return '<tr><td>' + fichaEsc(u.condominio) + ' <span class="ficha-sub">código ' + fichaEsc(u.id_superlogica) + '</span></td><td>' + fichaEsc(u.unidade + (u.bloco ? ' ' + u.bloco : '')) + '</td><td>' + fichaEsc(u.proprietario) + '</td><td>'
          + u.contatos.map(function (c) { return fichaEsc(c.nome) + (c.papel ? ' <span class="ficha-sub">(' + fichaEsc(c.papel) + ')</span>' : ''); }).join('<br>')
          + '</td><td>' + (hub ? '<button class="btn btn-ghost ficha-abrir" data-hub="' + fichaEsc(hub.id) + '" style="font-size:11px;padding:4px 10px">Abrir ficha</button>' : '') + '</td></tr>';
      }).join('') + '</table>';
  } catch (e) {
    el.innerHTML = '<div class="ficha-erro">' + fichaEsc(e.message) + '</div>';
  }
}

// "Abrir ficha" num resultado da busca: vira o condomínio ativo do sistema.
document.addEventListener('click', function (ev) {
  var b = ev.target.closest && ev.target.closest('.ficha-abrir');
  if (!b || !window.CondSeletor) return;
  var c = CondSeletor.buscarPorId(b.dataset.hub);
  if (c && CondSeletor.definir(c)) {
    var topo = document.getElementById('panel-condominio');
    if (topo) topo.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

function fichaMudarMes(v) {
  fichaEstado.mes = v;
  condominioFichaAbrir();
}

// Trocou o condomínio: recarrega se a aba estiver aberta, senão na próxima abertura.
window.addEventListener('condominioAtivo:trocou', function () {
  fichaEstado.seq++;
  fichaEstado.idCarregado = null;
  if (fichaPainelAberto()) condominioFichaAbrir();
});
document.addEventListener('auth:ready', function () { if (fichaPainelAberto()) condominioFichaAbrir(); });
setTimeout(function () { if (fichaPainelAberto() && window.AUTH_TOKEN) condominioFichaAbrir(); }, 0);
