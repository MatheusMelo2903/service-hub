// ============================================================
// FINANCEIRO, aba Conciliação (T35): usa o extrato que a equipe já importa no Superlógica.
// 1. Quadro da carteira: por condomínio e conta, último dia com extrato, dias sem extrato,
//    dias não conciliados, diferença de saldo e mês sem bloqueio.
// 2. No condomínio (aba Conciliação): itens do banco sem lançamento, lançamentos sem saída no
//    banco, valor no banco diferente do lançado, data real diferente da baixa, outras divergências,
//    regras automáticas sugeridas e comparação do arquivo OFX antes de importar (lido aqui na tela,
//    o arquivo não vai para o servidor).
// Rotas (só leitura): /api/financeiro/conciliacao/quadro, /condominio/:id, /condominio/:id/regras,
// /condominio/:id/conta/:conta/itens. Funções de casamento em public/conciliacao-casar.js.
// ============================================================
(function () {
  var C = window.ConciliacaoCasar;
  var est = { seqQ: 0, seqD: 0, seqR: 0, dados: null, cond: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function brl(v) { return v == null ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function brlC(c) { return brl(c / 100); }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function horaBR(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function mesISO(delta) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + delta); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function msg(el, texto, erro) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (el) el.innerHTML = texto ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : '';
  }
  // Cabecalho pode quebrar: com 8 colunas de rotulo comprido ("Maior atraso (dias úteis)") e sem
  // quebra, o quadro passava da largura do cartao e abria rolagem lateral mesmo com numeros curtos.
  var TH = 'style="text-align:left;padding:6px 8px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border2);white-space:normal"';
  var TD = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid var(--border);vertical-align:top"';
  // Celula de texto livre: quebra em ate 2 linhas (td-livre e td-2l no index.html) e o texto inteiro
  // fica no title. Sem isso descricao de lancamento ou de conta invadia a coluna vizinha.
  // texto e sub chegam crus (sem escape); sub vira uma segunda linha menor, tambem limitada.
  function tdL(texto, sub, extraHtml) {
    texto = texto == null ? '' : String(texto);
    return '<td ' + TD + ' class="td-livre" title="' + esc(texto + (sub ? '\n' + sub : '')) + '"><div class="td-2l">' + esc(texto) + (extraHtml || '') + '</div>'
      + (sub ? '<div class="td-2l" style="font-size:11px;color:var(--muted)">' + esc(sub) + '</div>' : '') + '</td>';
  }
  function cor(v, alerta, perigo) { return v >= perigo ? 'var(--danger)' : (v >= alerta ? 'var(--warning)' : 'var(--muted)'); }

  async function pegar(url, aoEsperar, chave, seq) {
    for (var t = 0; t < 45; t++) {
      var r = await apiAuthFetch(url);
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 202) {
        if (chave && seq !== est[chave]) throw new Error('cancelado');
        if (aoEsperar) aoEsperar(t);
        await new Promise(function (ok) { setTimeout(ok, 5000); });
        continue;
      }
      if (!r.ok) throw new Error(j.detalhe || (textoFalha(r.status)));
      return j;
    }
    throw new Error('A leitura está demorando mais que o normal. Tente de novo em alguns minutos.');
  }

  var SITUACAO = { ok: '', sem_extrato: 'Sem extrato importado no período', conta_caixa: 'Conta caixa (sem extrato de banco)', falha: 'Não foi possível ler agora', descartada: 'Leitura descartada (veio outra conta)' };
  function textoBloqueio(b) {
    if (!b) return '';
    if (!b.sem_bloqueio) return '<span style="color:var(--success)">até ' + esc(dataBR(b.bloqueado_ate)) + '</span>';
    return '<span style="color:var(--warning)">' + (b.bloqueado_ate ? 'só até ' + esc(dataBR(b.bloqueado_ate)) + ' (' + b.meses_abertos + ' mês(es) abertos)' : 'sem data de bloqueio') + '</span>';
  }
  function linhaConta(k) {
    var q = k.quadro || {};
    var dif = q.diferenca_saldo;
    return '<tr>' + tdL(k.descricao, (k.banco || '') + ' · ' + k.id, k.principal ? ' <span style="color:var(--muted);font-size:11px">principal</span>' : '')
      + (k.situacao === 'ok'
        ? '<td ' + TD + '>' + esc(dataBR(q.ultimo_extrato)) + '</td>'
          + '<td ' + TD + ' class="td-livre"><b style="color:' + (q.movimento_baixo && !k.principal ? 'var(--muted)' : cor(q.dias_sem_extrato || 0, 3, 6)) + '">' + (q.dias_sem_extrato == null ? '' : q.dias_sem_extrato) + '</b>' + (q.movimento_baixo && !k.principal ? '<br><span style="font-size:11px;color:var(--muted)">pouco movimento, pode não faltar extrato</span>' : '') + '</td>'
          + '<td ' + TD + '><b style="color:' + cor(q.dias_nao_conciliados || 0, 1, 3) + '">' + (q.dias_nao_conciliados || 0) + '</b></td>'
          + '<td ' + TD + ' class="td-livre">' + (dif ? '<span style="color:var(--danger)">' + brl(dif) + '</span><br><span style="color:var(--muted);font-size:11px">sistema ' + brl(q.saldo_sistema) + ', banco ' + brl(q.saldo_banco) + ' em ' + esc(dataBR(q.data_saldo)) + '</span>' : '<span style="color:var(--success)">sem diferença</span>') + '</td>'
        : '<td ' + TD + ' colspan="4"><span style="color:var(--muted)">' + esc(SITUACAO[k.situacao] || k.situacao) + '</span></td>')
      + '<td ' + TD + ' class="td-livre">' + (k.situacao === 'conta_caixa' ? '' : textoBloqueio(k.bloqueio)) + '</td></tr>';
  }
  function tabelaContas(contas) {
    return '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th ' + TH + '>Conta</th><th ' + TH + '>Último extrato</th><th ' + TH + '>Dias úteis sem extrato</th><th ' + TH + '>Dias não conciliados</th><th ' + TH + '>Diferença de saldo</th><th ' + TH + '>Bloqueio de lançamentos</th></tr></thead><tbody>'
      + contas.map(linhaConta).join('') + '</tbody></table></div>';
  }

  // ── 0. Tela própria (item Conciliação do menu, T37) ────────
  // Falha fechada: mesma regra do menu (index.html, podeAbrirPainel). O servidor confere de novo.
  var PAINEL = 'conciliacao';
  if (typeof PAGE_META !== 'undefined') PAGE_META[PAINEL] = { title: 'Conciliação', sub: 'extrato importado no Superlógica comparado com os lançamentos' };
  function podeVer() { return typeof window.podeAbrirPainel === 'function' && window.podeAbrirPainel(PAINEL); }
  var carteirasCarregadas = false;
  async function concAbrir() {
    if (!podeVer() || !window.AUTH_TOKEN || carteirasCarregadas) return;
    var sel = document.getElementById('conc-carteira');
    if (!sel) return;
    carteirasCarregadas = true;
    if (window.USER_ROLE !== 'GESTOR') return;
    try {
      var r = await apiAuthFetch('/api/carteiras');
      var g = await r.json().catch(function () { return []; });
      (Array.isArray(g) ? g : []).forEach(function (c) {
        if (!c || !c.id) return;
        var o = document.createElement('option');
        o.value = String(c.id);
        o.textContent = c.nome + ' (' + (c.quantidade || (c.condominios || []).length) + ')';
        sel.appendChild(o);
      });
    } catch (e) { carteirasCarregadas = false; }
  }
  function painelAtivo() { var p = document.getElementById('panel-' + PAINEL); return !!(p && p.classList.contains('active')); }
  if (typeof window.showPanel === 'function') {
    var origShow = window.showPanel;
    window.showPanel = function () {
      var r = origShow.apply(this, arguments);
      if (painelAtivo()) concAbrir();
      return r;
    };
  }
  document.addEventListener('auth:ready', function () { setTimeout(function () { if (painelAtivo()) concAbrir(); }, 0); });

  // Detalhe de um condomínio, no card de baixo da tela.
  function abrirCondominio(id, nome) {
    if (!podeVer() || !/^\d+$/.test(String(id || ''))) return;
    var card = document.getElementById('conc-detalhe');
    if (!card) return;
    card.style.display = '';
    card.innerHTML = '<div class="card-header"><span class="card-title">' + esc(nome || ('Código ' + id)) + ' <span style="color:var(--muted);font-family:var(--mono);font-size:12px">' + esc(id) + '</span></span></div><div id="conc-detalhe-corpo"></div>';
    window.finConcAba(document.getElementById('conc-detalhe-corpo'), { id: String(id), nome: nome || '' });
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  window.finConcAbrirAtivo = function () {
    var c = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
    var id = c ? String(c.id_superlogica || '') : '';
    if (!/^\d+$/.test(id)) { msg('fin-conc-q-info', 'Escolha o condomínio no topo primeiro.', true); return; }
    abrirCondominio(id, c.nome);
  };

  // ── 1. Quadro da carteira ──────────────────────────────────
  window.finConcQuadro = async function (forcar) {
    if (!podeVer()) return;
    await concAbrir();
    var sel = document.getElementById('conc-carteira');
    var carteira = sel ? sel.value : '';
    document.getElementById('fin-conc-q-lista').innerHTML = '';
    var seq = ++est.seqQ;
    msg('fin-conc-q-info', 'Lendo os extratos das contas...');
    try {
      var q = [];
      if (carteira) q.push('carteira=' + encodeURIComponent(carteira));
      if (forcar) q.push('forcar=1');
      var j = await pegar('/api/financeiro/conciliacao/quadro' + (q.length ? '?' + q.join('&') : ''), function (t) {
        if (seq === est.seqQ) msg('fin-conc-q-info', 'Lendo os extratos das contas (pode levar 1 ou 2 minutos)' + '.'.repeat(1 + (t % 3)));
      }, 'seqQ', seq);
      if (seq !== est.seqQ) return;
      renderQuadro(j);
    } catch (e) {
      if (seq === est.seqQ && e.message !== 'cancelado') msg('fin-conc-q-info', e.message, true);
    }
  };
  function renderQuadro(j) {
    var lista = j.condominios || [];
    msg('fin-conc-q-info', lista.length + ' condomínio(s)' + (j.fora_da_lista ? ' (' + j.fora_da_lista + ' inativo(s) ou fora do financeiro não aparecem)' : '') + '. Lido em ' + horaBR(j.gerado_em) + ', de ' + dataBR(j.periodo && j.periodo.inicio) + ' a ' + dataBR(j.periodo && j.periodo.fim) + '. Clique no condomínio para ver as contas.');
    var el = document.getElementById('fin-conc-q-lista');
    if (!lista.length) { el.innerHTML = '<div class="hint">Nenhum condomínio nesta carteira.</div>'; return; }
    var html = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th ' + TH + '>Condomínio</th><th ' + TH + '>Contas com extrato</th><th ' + TH + '>Maior atraso (dias úteis)</th><th ' + TH + '>Dias não conciliados</th><th ' + TH + '>Contas com diferença</th><th ' + TH + '>Contas sem extrato</th><th ' + TH + '>Contas sem bloqueio</th><th ' + TH + '></th></tr></thead><tbody>';
    lista.forEach(function (c, i) {
      html += '<tr data-conc-i="' + i + '" style="cursor:pointer" title="Ver as contas">'
        + '<td ' + TD + ' class="td-livre" title="' + esc(c.condominio || ('Código ' + c.id_condominio)) + '"><div class="td-2l"><b>' + esc(c.condominio || ('Código ' + c.id_condominio)) + '</b> <span style="color:var(--muted);font-family:var(--mono);font-size:11px">' + esc(c.id_condominio) + '</span></div>' + (c.falhas ? '<span style="color:var(--danger);font-size:11px">' + c.falhas + ' conta(s) não lidas</span>' : '') + '</td>'
        + '<td ' + TD + '>' + c.contas_com_extrato + '</td>'
        + '<td ' + TD + '><b style="color:' + cor(c.maior_atraso_extrato || 0, 3, 6) + '">' + (c.maior_atraso_extrato == null ? 'sem extrato' : c.maior_atraso_extrato) + '</b></td>'
        + '<td ' + TD + '><b style="color:' + cor(c.dias_nao_conciliados || 0, 1, 5) + '">' + c.dias_nao_conciliados + '</b></td>'
        + '<td ' + TD + '>' + (c.contas_com_diferenca ? '<b style="color:var(--danger)">' + c.contas_com_diferenca + '</b>' : '0') + '</td>'
        + '<td ' + TD + '>' + c.contas_sem_extrato + '</td>'
        + '<td ' + TD + '>' + (c.contas_sem_bloqueio ? '<span style="color:var(--warning)">' + c.contas_sem_bloqueio + '</span>' : '0') + '</td>'
        + '<td ' + TD + '><button class="btn btn-ghost" data-conc-abrir="' + i + '" style="font-size:11px;padding:4px 10px">Abrir</button></td></tr>'
        + '<tr data-conc-det="' + i + '" style="display:none"><td colspan="8" style="padding:4px 8px 12px 24px;border-bottom:1px solid var(--border)">' + tabelaContas(c.contas || []) + '</td></tr>';
    });
    el.innerHTML = html + '</tbody></table></div>';
    el.querySelectorAll('tr[data-conc-i]').forEach(function (tr) {
      tr.addEventListener('click', function (ev) {
        var i = tr.getAttribute('data-conc-i');
        if (ev.target && ev.target.getAttribute('data-conc-abrir') != null) {
          var c = lista[+i];
          abrirCondominio(c.id_condominio, c.condominio);
          return;
        }
        var det = el.querySelector('tr[data-conc-det="' + i + '"]');
        if (det) det.style.display = det.style.display === 'none' ? '' : 'none';
      });
    });
  }

  // ── 2. Aba Conciliação do condomínio ───────────────────────
  window.finConcAba = function (el, cond) {
    if (!el || !cond) return;
    if (!est.cond || est.cond.id !== cond.id) { est.dados = null; est.regras = null; }
    est.cond = { id: cond.id, nome: cond.nome };
    el.innerHTML = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">'
      + '<label style="font-size:12px">Mês <input type="month" id="fin-conc-mes" value="' + (est.dados ? est.dados.competencia : mesISO(-1)) + '" max="' + mesISO(0) + '" style="width:auto"></label>'
      + '<button class="btn btn-primary" id="fin-conc-conferir" style="font-size:12px;padding:6px 14px">Conferir extrato</button>'
      + '<button class="btn btn-ghost" id="fin-conc-atualizar" style="font-size:12px;padding:6px 12px" title="Lê de novo no Superlógica">Atualizar</button>'
      + '<button class="btn btn-ghost" id="fin-conc-regras" style="font-size:12px;padding:6px 12px">Sugerir regras automáticas</button></div>'
      + '<div class="hint" style="margin-bottom:8px">Compara o extrato importado no Superlógica com os lançamentos de cada conta. Rendimento e imposto da poupança são comparados pelo total do mês.</div>'
      + '<div id="fin-conc-info" class="ficha-sub" style="margin-bottom:8px"></div><div id="fin-conc-res"></div>'
      + '<div id="fin-conc-regras-res" style="margin-top:12px"></div>'
      + '<details style="border:1px solid var(--border2);border-radius:10px;padding:8px 12px;margin-top:12px"><summary style="cursor:pointer;font-size:13px"><b>Comparar um arquivo OFX antes de importar</b></summary>'
      + '<div class="hint" style="margin:6px 0">Escolha a conta e o arquivo OFX baixado do banco (até 62 dias). O arquivo é lido aqui na tela e não é enviado a lugar nenhum. Mostra o que já está importado, o que é novo e se o novo já tem lançamento.</div>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><select id="fin-conc-ofx-conta" style="width:auto;min-width:220px"><option value="">Conferir o extrato primeiro</option></select>'
      + '<input type="file" id="fin-conc-ofx-arq" accept=".ofx,.OFX,application/x-ofx" style="width:auto">'
      + '<button class="btn btn-primary" id="fin-conc-ofx-comparar" style="font-size:12px;padding:6px 14px">Comparar</button></div>'
      + '<div id="fin-conc-ofx-info" class="ficha-sub" style="margin:8px 0"></div><div id="fin-conc-ofx-res"></div></details>';
    document.getElementById('fin-conc-conferir').addEventListener('click', function () { conferir(false); });
    document.getElementById('fin-conc-atualizar').addEventListener('click', function () { conferir(true); });
    document.getElementById('fin-conc-regras').addEventListener('click', function () { regras(false); });
    document.getElementById('fin-conc-ofx-comparar').addEventListener('click', compararOfx);
    if (est.dados && est.dados.condominio === cond.id) renderCond(est.dados); else conferir(false);
    if (est.regras && est.regras.condominio === cond.id) renderRegras(est.regras);
  };

  async function conferir(forcar) {
    var c = est.cond;
    var mes = document.getElementById('fin-conc-mes').value;
    if (!/^\d{4}-\d{2}$/.test(mes)) { msg('fin-conc-info', 'Escolha o mês.', true); return; }
    var seq = ++est.seqD;
    document.getElementById('fin-conc-res').innerHTML = '';
    msg('fin-conc-info', 'Lendo o extrato e os lançamentos de cada conta...');
    try {
      var j = await pegar('/api/financeiro/conciliacao/condominio/' + encodeURIComponent(c.id) + '?competencia=' + encodeURIComponent(mes) + (forcar ? '&forcar=1' : ''), null, 'seqD', seq);
      if (seq !== est.seqD || !est.cond || est.cond.id !== c.id || !document.getElementById('fin-conc-res')) return;
      est.dados = j;
      renderCond(j);
    } catch (e) {
      if (seq === est.seqD && e.message !== 'cancelado') msg('fin-conc-info', e.message, true);
    }
  }

  var NOME_DIV = {
    rendimento_diferente: 'Rendimento do mês diferente', rendimento_sem_lancamento: 'Rendimento do mês sem lançamento',
    lancado_e_desconsiderado: 'Lançado no sistema e desconsiderado no extrato', tarifas_desconsideradas_lancadas_no_mes: 'Tarifas desconsideradas no extrato e lançadas juntas no mês',
  };
  function secao(titulo, n, corpo, aberta) {
    return '<details style="border:1px solid var(--border2);border-radius:10px;padding:8px 12px;margin-bottom:8px"' + (aberta && n ? ' open' : '') + '>'
      + '<summary style="cursor:pointer;font-size:13px"><b style="color:' + (n ? 'var(--danger)' : 'var(--success)') + '">' + n + '</b> ' + esc(titulo) + '</summary>'
      + (n ? '<div style="overflow-x:auto;margin-top:6px">' + corpo + '</div>' : '') + '</details>';
  }
  function tabela(cab, linhas) {
    return '<table style="width:100%;border-collapse:collapse"><thead><tr>' + cab.map(function (h) { return '<th ' + TH + '>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + linhas.join('') + '</tbody></table>';
  }
  function td(v) { return '<td ' + TD + '>' + v + '</td>'; }

  function renderCond(j) {
    var contas = j.contas || [];
    var mes = String(j.competencia || '').split('-').reverse().join('/');
    msg('fin-conc-info', contas.length + ' conta(s), ' + mes + ' (' + dataBR(j.inicio) + ' a ' + dataBR(j.fim) + '). Lido em ' + horaBR(j.gerado_em) + '.');
    var soB = [], soS = [], val = [], dat = [], div = [], aguardando = 0;
    contas.forEach(function (k) {
      var nome = tdL(k.descricao);
      (k.banco_sem_lancamento || []).forEach(function (x) { soB.push('<tr>' + nome + td(esc(dataBR(x.data))) + td(brl(x.valor)) + tdL(x.descricao) + tdL(x.categoria || '') + '</tr>'); });
      (k.lancamento_sem_banco || []).forEach(function (x) { soS.push('<tr>' + nome + td(esc(dataBR(x.data))) + td(brl(x.valor)) + tdL(x.descricao) + tdL(x.documento || '') + '</tr>'); });
      (k.valor_diferente || []).forEach(function (x) { val.push('<tr>' + nome + td(esc(dataBR(x.data_sistema)) + (x.data_banco !== x.data_sistema ? '<br><span style="font-size:11px;color:var(--muted)">banco ' + esc(dataBR(x.data_banco)) + '</span>' : '')) + td(brl(x.lancado)) + td(brl(x.no_banco)) + td('<b style="color:var(--danger)">' + brl(x.diferenca) + '</b>') + tdL(x.descricao, x.descricao_banco) + '</tr>'); });
      (k.data_diferente || []).forEach(function (x) { dat.push('<tr>' + nome + td(esc(dataBR(x.data_sistema))) + td(esc(dataBR(x.data_banco))) + td((x.dias > 0 ? '+' : '') + x.dias) + td(brl(x.valor)) + tdL(x.descricao, x.descricao_banco) + '</tr>'); });
      (k.divergencias || []).forEach(function (x) {
        var det = x.tipo === 'lancado_e_desconsiderado' ? esc(dataBR(x.data)) + ', ' + brl(x.valor) + ': ' + esc(x.descricao) + ' x ' + esc(x.descricao_banco)
          : 'Mês ' + esc(String(x.mes || '').split('-').reverse().join('/')) + ': banco ' + brl(x.banco) + ' (' + (x.itens_banco || 0) + ' itens), sistema ' + brl(x.sistema) + (x.diferenca ? ', diferença ' + brl(x.diferenca) : '') + (x.descricao_banco ? ' · ' + esc(x.descricao_banco) : '');
        // det ja chega escapado e sem tags, por isso pode ir direto no title
        div.push('<tr>' + nome + tdL(NOME_DIV[x.tipo] || x.tipo) + '<td ' + TD + ' class="td-livre" title="' + det + '"><div class="td-2l">' + det + '</div></td></tr>');
      });
      aguardando += (k.totais && k.totais.aguardando_extrato) || 0;
    });
    var html = tabelaContas(contas);
    html += '<div style="height:10px"></div>';
    html += secao('Itens do banco sem lançamento no sistema', soB.length, tabela(['Conta', 'Data', 'Valor', 'No extrato', 'Tipo'], soB), true);
    html += secao('Lançamentos sem saída ou entrada no banco', soS.length, tabela(['Conta', 'Data', 'Valor', 'Lançamento', 'Documento'], soS), true);
    html += secao('Valor no banco diferente do lançado (juros, multa ou desconto não registrados)', val.length, tabela(['Conta', 'Data', 'Lançado', 'No banco', 'Diferença', 'Lançamento e extrato'], val), true);
    html += secao('Data no banco diferente da baixa', dat.length, tabela(['Conta', 'Baixa no sistema', 'No banco', 'Dias', 'Valor', 'Lançamento e extrato'], dat), false);
    html += secao('Outras divergências', div.length, tabela(['Conta', 'Tipo', 'Detalhe'], div), false);
    if (aguardando) html += '<div class="hint">' + aguardando + ' lançamento(s) depois do último extrato importado ficam fora da conferência até o extrato chegar.</div>';
    document.getElementById('fin-conc-res').innerHTML = html;
    var sel = document.getElementById('fin-conc-ofx-conta');
    if (sel) {
      sel.innerHTML = contas.filter(function (k) { return k.situacao !== 'conta_caixa'; }).map(function (k) { return '<option value="' + esc(k.id) + '">' + esc(k.descricao) + ' (' + esc(k.banco || '') + ')</option>'; }).join('') || '<option value="">Nenhuma conta com extrato</option>';
    }
  }

  async function regras(forcar) {
    var c = est.cond;
    var el = document.getElementById('fin-conc-regras-res');
    var seq = ++est.seqR;
    msg(el, 'Lendo o histórico dos últimos 3 meses de todas as contas...');
    try {
      var j = await pegar('/api/financeiro/conciliacao/condominio/' + encodeURIComponent(c.id) + '/regras' + (forcar ? '?forcar=1' : ''), null, 'seqR', seq);
      if (seq !== est.seqR || !est.cond || est.cond.id !== c.id || !document.getElementById('fin-conc-regras-res')) return;
      est.regras = j;
      renderRegras(j);
    } catch (e) {
      if (seq === est.seqR && e.message !== 'cancelado') msg(el, e.message, true);
    }
  }
  function renderRegras(j) {
    var el = document.getElementById('fin-conc-regras-res');
    if (!el) return;
    var l = j.sugestoes || [];
    var cab = '<div class="card-title" style="font-size:14px;margin-bottom:6px">Regras automáticas sugeridas</div><div class="hint" style="margin-bottom:6px">Itens que se repetem no extrato de ' + dataBR(j.periodo.inicio) + ' a ' + dataBR(j.periodo.fim) + ' (' + j.itens_analisados + ' itens). Cadastre a regra na conciliação do Superlógica se fizer sentido.</div>';
    if (!l.length) { el.innerHTML = cab + '<div class="hint">Nenhum item recorrente que peça regra.</div>'; return; }
    el.innerHTML = cab + '<div style="overflow-x:auto">' + tabela(['No extrato', 'Tipo', 'Vezes', 'Valor', 'Hoje', 'Sugestão'], l.map(function (s) {
      var valor = s.valor_fixo ? brl(s.valor_tipico) : brl(s.valor_min) + ' a ' + brl(s.valor_max);
      var hoje = [s.situacao.com_lancamento ? s.situacao.com_lancamento + ' com lançamento' : '', s.situacao.sem_lancamento ? s.situacao.sem_lancamento + ' sem lançamento' : '', s.situacao.desconsiderado ? s.situacao.desconsiderado + ' desconsiderados' : ''].filter(Boolean).join(', ');
      return '<tr>' + td('<b>' + esc(s.exemplo) + '</b>' + (s.categoria ? '<br><span style="font-size:11px;color:var(--muted)">' + esc(s.categoria) + '</span>' : '')) + td(s.tipo === 'saida' ? 'Saída' : 'Entrada') + td(s.vezes + ' em ' + s.meses + ' meses') + td(valor) + td(esc(hoje)) + td(esc(s.sugestao)) + '</tr>';
    })) + '</div>';
  }

  // ── 3. OFX ──────────────────────────────────────────────────
  function lerArquivo(arq) {
    return new Promise(function (ok, falha) {
      var fr = new FileReader();
      fr.onerror = function () { falha(new Error('Não foi possível ler o arquivo.')); };
      fr.onload = function () {
        var buf = fr.result;
        var cab = new TextDecoder('windows-1252').decode(buf.slice(0, 600));
        var utf8 = /ENCODING:\s*UTF-?8|encoding="utf-?8"|CHARSET:\s*(UTF-?8|65001)/i.test(cab);
        try { ok(new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(buf)); } catch (e) { falha(new Error('Não foi possível ler o arquivo.')); }
      };
      fr.readAsArrayBuffer(arq);
    });
  }
  async function compararOfx() {
    var info = 'fin-conc-ofx-info';
    var res = document.getElementById('fin-conc-ofx-res');
    res.innerHTML = '';
    var conta = document.getElementById('fin-conc-ofx-conta').value;
    var arq = document.getElementById('fin-conc-ofx-arq').files[0];
    if (!conta) { msg(info, 'Confira o extrato do mês primeiro e escolha a conta.', true); return; }
    if (!arq) { msg(info, 'Escolha o arquivo OFX.', true); return; }
    if (arq.size > 5 * 1024 * 1024) { msg(info, 'O arquivo passa de 5 MB.', true); return; }
    var ofx;
    try { ofx = C.lerOfx(await lerArquivo(arq)); } catch (e) { msg(info, e.detalhe || e.message, true); return; }
    if (!ofx.itens.length) { msg(info, 'O arquivo não tem movimentos.', true); return; }
    var datas = ofx.itens.map(function (x) { return x.data; }).sort();
    var ini = datas[0], fim = datas[datas.length - 1];
    if (C.dias(ini, fim) > 62) { msg(info, 'O arquivo tem mais de 62 dias. Baixe um período menor.', true); return; }
    msg(info, 'Lendo o que já está importado nessa conta...');
    try {
      var j = await pegar('/api/financeiro/conciliacao/condominio/' + encodeURIComponent(est.cond.id) + '/conta/' + encodeURIComponent(conta) + '/itens?inicio=' + ini + '&fim=' + fim);
      var r = C.compararOfx(ofx, j.banco || [], j.sistema || []);
      msg(info, 'Arquivo de ' + dataBR(r.inicio) + ' a ' + dataBR(r.fim) + ', ' + r.total + ' movimento(s), conta ' + j.conta.descricao + '.');
      var lin = function (l, extra) { return l.map(function (x) { return '<tr>' + td(esc(dataBR(x.data))) + td(brlC(x.valor)) + td(esc(x.descricao || '')) + (extra ? td(esc(extra(x))) : '') + '</tr>'; }); };
      var html = '<div style="margin-bottom:8px;font-size:13px"><b>' + r.ja_importados.length + '</b> já importados · <b>' + r.novos_com_lancamento.length + '</b> novos com lançamento · <b style="color:' + (r.novos_sem_lancamento.length ? 'var(--danger)' : 'var(--success)') + '">' + r.novos_sem_lancamento.length + '</b> novos sem lançamento · <b style="color:' + (r.so_no_superlogica.length ? 'var(--warning)' : 'var(--success)') + '">' + r.so_no_superlogica.length + '</b> no Superlógica e fora do arquivo</div>';
      html += secao('Novos e sem lançamento no sistema', r.novos_sem_lancamento.length, tabela(['Data', 'Valor', 'No arquivo'], lin(r.novos_sem_lancamento)), true);
      html += secao('No Superlógica, mas fora do arquivo (possível importação repetida ou de outra conta)', r.so_no_superlogica.length, tabela(['Data', 'Valor', 'No extrato importado'], lin(r.so_no_superlogica)), true);
      html += secao('Repetidos dentro do arquivo', r.repetidos_no_arquivo.length, tabela(['Data', 'Valor', 'No arquivo'], lin(r.repetidos_no_arquivo)), true);
      html += secao('Novos que já têm lançamento', r.novos_com_lancamento.length, tabela(['Data', 'Valor', 'No arquivo', 'Lançamento'], lin(r.novos_com_lancamento, function (x) { return x.lancamento; })), false);
      res.innerHTML = html;
    } catch (e) { msg(info, e.message, true); }
  }
})();
