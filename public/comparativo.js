// ============================================================
// COMPARATIVO ENTRE CONDOMÍNIOS (T14): custo por unidade por mês (total, pessoal,
// água, energia, gás) nos últimos 12 meses fechados e preço pago por fornecedor
// em comum. Só leitura. Rotas: /api/comparativo/condominio/:id[/fornecedores].
// ============================================================

var cmpEstado = { seq: 0, custos: {}, carregado: false, abrindo: false };

function cmpEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function cmpBRL(v) { return v == null ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
async function cmpJson(url) {
  var r = await apiAuthFetch(url);
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
  return j;
}

async function comparativoAbrir() {
  if (cmpEstado.carregado || cmpEstado.abrindo || !window.AUTH_TOKEN) return;
  var sel = document.getElementById('cmp-carteira');
  if (!sel) return;
  cmpEstado.abrindo = true;
  if (window.CondSeletor && CondSeletor.lista() === null) await CondSeletor.carregar();
  cmpEstado.abrindo = false;
  if (!window.CondSeletor || !CondSeletor.lista()) return;
  cmpEstado.carregado = true;
  sel.innerHTML = '<option value="meus">Meus condomínios</option>';
  if (window.USER_ROLE === 'GESTOR') {
    try {
      var g = await cmpJson('/api/carteiras');
      (Array.isArray(g) ? g : []).forEach(function (c) {
        if (!c || !c.id) return;
        var o = document.createElement('option');
        o.value = 'g' + c.id;
        o.textContent = c.nome + ' (' + (c.quantidade || (c.condominios || []).length) + ')';
        o.dataset.ids = (c.condominios || []).join(',');
        sel.appendChild(o);
      });
    } catch (e) { cmpEstado.carregado = false; }
  }
}

function cmpEscolhidos() {
  var sel = document.getElementById('cmp-carteira');
  var lista = ((window.CondSeletor && CondSeletor.lista()) || []).filter(function (c) { return c.id_superlogica; });
  if (!sel || sel.value === 'meus') return lista;
  var ids = (sel.options[sel.selectedIndex].dataset.ids || '').split(',');
  return lista.filter(function (c) { return ids.indexOf(String(c.id_superlogica)) >= 0; });
}

var CMP_COLS = [['total', 'Despesa total'], ['pessoal', 'Pessoal'], ['agua', 'Água e esgoto'], ['energia', 'Energia'], ['gas', 'Gás']];

async function comparativoCarregar() {
  var conds = cmpEscolhidos();
  var info = document.getElementById('cmp-info');
  var escolha = document.getElementById('cmp-carteira').value;
  if (conds.length > 30 && cmpEstado.confirmouGrande !== escolha) {
    cmpEstado.confirmouGrande = escolha;
    info.textContent = 'São ' + conds.length + ' condomínios: a leitura pode levar alguns minutos. Clique em Carregar de novo para confirmar, ou escolha uma carteira menor.';
    return;
  }
  cmpEstado.confirmouGrande = null;
  var seq = ++cmpEstado.seq;
  cmpEstado.custos = {};
  document.getElementById('cmp-forn').innerHTML = '';
  var el = document.getElementById('cmp-tabela');
  if (!conds.length) { el.innerHTML = ''; info.textContent = 'Nenhum condomínio com código do Superlógica nessa escolha.'; return; }
  info.textContent = 'Lendo 0 de ' + conds.length + ' condomínios...';
  var i = 0, feitos = 0, periodo = '';
  async function trab() {
    while (i < conds.length) {
      var c = conds[i++];
      try {
        var r = await cmpJson('/api/comparativo/condominio/' + encodeURIComponent(c.id_superlogica));
        if (seq !== cmpEstado.seq) return;
        cmpEstado.custos[c.id_superlogica] = { cond: c, r: r };
        periodo = r.periodo;
      } catch (e) {
        if (seq !== cmpEstado.seq) return;
        cmpEstado.custos[c.id_superlogica] = { cond: c, erro: e.message };
      }
      feitos++;
      info.textContent = 'Lendo ' + feitos + ' de ' + conds.length + ' condomínios...';
      cmpRender();
    }
  }
  await Promise.all([trab(), trab(), trab()]);
  if (seq !== cmpEstado.seq) return;
  info.textContent = conds.length + ' condomínios · ' + (periodo || '') + ' · valores por unidade por mês. Em vermelho, os 25% mais caros da coluna; em verde, os 25% mais baratos.';
  cmpRender();
}

function cmpQuartis(vals) {
  var v = vals.filter(function (x) { return x != null && x > 0; }).sort(function (a, b) { return a - b; });
  if (v.length < 4) return null;
  return { q1: v[Math.floor((v.length - 1) * 0.25)], q3: v[Math.ceil((v.length - 1) * 0.75)] };
}

function cmpRender() {
  var regs = Object.keys(cmpEstado.custos).map(function (k) { return cmpEstado.custos[k]; });
  var ok = regs.filter(function (x) { return x.r; });
  ok.sort(function (a, b) { return (b.r.por_unidade_mes.total || 0) - (a.r.por_unidade_mes.total || 0); });
  var q = {};
  CMP_COLS.forEach(function (c) { q[c[0]] = cmpQuartis(ok.map(function (x) { return x.r.por_unidade_mes[c[0]]; })); });
  var cor = function (k, v) {
    if (!q[k] || v == null || !(v > 0)) return '';
    return v >= q[k].q3 ? ' style="color:var(--danger)"' : (v <= q[k].q1 ? ' style="color:var(--success)"' : '');
  };
  var html = '<table class="ficha-tab"><tr><th>Condomínio</th><th class="n">Unidades</th>'
    + CMP_COLS.map(function (c) { return '<th class="n">' + c[1] + '</th>'; }).join('') + '<th class="n">Total no período</th></tr>';
  html += ok.map(function (x) {
    var r = x.r;
    // Nome do condominio quebra em ate 2 linhas (td-livre no index.html) para nao alargar a tabela
    return '<tr><td class="td-livre" title="' + cmpEsc(x.cond.nome) + '"><div class="td-2l">' + cmpEsc(x.cond.nome) + '</div></td><td class="n">' + r.unidades + '</td>'
      + CMP_COLS.map(function (c) {
        var v = r.por_unidade_mes[c[0]];
        // Plano de contas não reconhecido é diferente de não ter gasto.
        var naoId = (c[0] === 'pessoal' && r.sem_categoria_pessoal) || (['agua', 'energia', 'gas'].indexOf(c[0]) >= 0 && r.sem_categoria_consumo);
        var vazio = naoId ? '<span class="ficha-sub" title="O plano de contas desse condomínio não tem essa categoria com o nome esperado.">não identificado</span>' : '<span class="ficha-sub">sem</span>';
        return '<td class="n"' + cor(c[0], v) + '>' + (v ? cmpBRL(v) : vazio) + '</td>';
      }).join('')
      + '<td class="n">' + cmpBRL(r.totais.total) + '</td></tr>';
  }).join('');
  html += regs.filter(function (x) { return x.erro; }).map(function (x) {
    return '<tr><td class="td-livre" title="' + cmpEsc(x.cond.nome) + '"><div class="td-2l">' + cmpEsc(x.cond.nome) + '</div></td><td colspan="' + (CMP_COLS.length + 2) + '" class="ficha-erro td-livre">' + cmpEsc(x.erro) + '</td></tr>';
  }).join('');
  html += '</table>';
  document.getElementById('cmp-tabela').innerHTML = '<div style="overflow-x:auto">' + html + '</div>';
}

// Fornecedores em comum: o mesmo fornecedor (CNPJ, ou o nome quando não há CNPJ) pago
// em dois ou mais condomínios, com a média por mês e por unidade em cada um.
async function comparativoFornecedores() {
  var regs = Object.keys(cmpEstado.custos).map(function (k) { return cmpEstado.custos[k]; }).filter(function (x) { return x.r; });
  var el = document.getElementById('cmp-forn');
  if (regs.length < 2) { el.innerHTML = '<div class="ficha-erro">Carregue pelo menos dois condomínios primeiro.</div>'; return; }
  if (regs.length > 20) { el.innerHTML = '<div class="ficha-erro">Para comparar fornecedores escolha uma carteira com até 20 condomínios.</div>'; return; }
  if (cmpEstado.fornAndamento) return;
  cmpEstado.fornAndamento = true;
  var seq = cmpEstado.seq;
  el.innerHTML = '<div class="cond-loading">Lendo os pagamentos de cada condomínio...</div>';
  var mapa = {}, i = 0, falhas = [], parciais = [];
  async function trab() {
    while (i < regs.length) {
      var x = regs[i++];
      try {
        var f = await cmpJson('/api/comparativo/condominio/' + encodeURIComponent(x.cond.id_superlogica) + '/fornecedores');
        if (f.cortado) parciais.push(x.cond.nome);
        f.fornecedores.forEach(function (fo) {
          var m = mapa[fo.chave] || (mapa[fo.chave] = { nome: fo.nome, cnpj: fo.cnpj, contas: {}, por: [] });
          fo.contas.forEach(function (c) { m.contas[c] = 1; });
          m.por.push({ cond: x.cond.nome, media_mes: fo.media_mes, por_unidade: x.r.unidades ? fo.media_mes / x.r.unidades : null });
        });
      } catch (e) { falhas.push(x.cond.nome); }
    }
  }
  await Promise.all([trab(), trab()]);
  cmpEstado.fornAndamento = false;
  if (seq !== cmpEstado.seq) return;
  var comuns = Object.keys(mapa).map(function (k) { return mapa[k]; }).filter(function (m) { return m.por.length >= 2; });
  comuns.sort(function (a, b) { return b.por.length - a.por.length || b.por.reduce(function (s, p) { return s + p.media_mes; }, 0) - a.por.reduce(function (s, p) { return s + p.media_mes; }, 0); });
  if (!comuns.length) { el.innerHTML = '<div class="ficha-sub">Nenhum fornecedor pago em dois ou mais desses condomínios.</div>'; return; }
  el.innerHTML = (falhas.length ? '<div class="ficha-erro">Não foi possível ler: ' + cmpEsc(falhas.join(', ')) + '</div>' : '')
    + (parciais.length ? '<div class="ficha-sub">Leitura parcial (pagamentos demais no período): ' + cmpEsc(parciais.join(', ')) + '</div>' : '')
    + '<div class="ficha-sub">Ficam de fora pessoa física, folha de pagamento e tributos.</div>'
    + '<div style="overflow-x:auto"><table class="ficha-tab"><tr><th>Fornecedor</th><th>Contas</th><th>Condomínio</th><th class="n">Média por mês</th><th class="n">Por unidade por mês</th></tr>'
    + comuns.slice(0, 80).map(function (m) {
      m.por.sort(function (a, b) { return (b.por_unidade || 0) - (a.por_unidade || 0); });
      return m.por.map(function (p, k) {
        // Fornecedor, contas e condominio sao textos livres: quebram em ate 2 linhas, inteiros no title
        var contas = Object.keys(m.contas).slice(0, 3).join(', ');
        return '<tr>' + (k === 0 ? '<td rowspan="' + m.por.length + '" class="td-livre" title="' + cmpEsc(m.nome) + '"><div class="td-2l">' + cmpEsc(m.nome) + '</div></td><td rowspan="' + m.por.length + '" class="ficha-sub td-livre" title="' + cmpEsc(contas) + '"><div class="td-2l">' + cmpEsc(contas) + '</div></td>' : '')
          + '<td class="td-livre" title="' + cmpEsc(p.cond) + '"><div class="td-2l">' + cmpEsc(p.cond) + '</div></td><td class="n">' + cmpBRL(p.media_mes) + '</td><td class="n">' + (p.por_unidade != null ? cmpBRL(Math.round(p.por_unidade * 100) / 100) : '') + '</td></tr>';
      }).join('');
    }).join('') + '</table></div>';
}

document.addEventListener('auth:ready', function () {
  var p = document.getElementById('panel-comparativo');
  if (p && p.classList.contains('active')) comparativoAbrir();
});
