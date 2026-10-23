// ============================================================
// FECHAMENTO DO MÊS (T38), dentro do item Financeiro:
// 1. Conferência dos anexos no pré balancete (comprovante bate valor e data, condomínio como
//    pagador ou tomador, CNPJ de outro condomínio, linha digitável, PDF de editor ou modificado;
//    escaneado lido com limite por hora ou só listado).
// 2. Aba "Fechamento do mês" no detalhe do condomínio: checklist com o que trava e onde resolver.
// 3. Coluna Fechamento no quadro da carteira.
// Rotas: /api/financeiro/condominio/:id/anexos, /api/financeiro/condominio/:id/fechamento,
// /api/financeiro/condominio/:id/fechamento/marcar, /api/financeiro/fechamento/quadro.
// O servidor confere módulo, carteira e escopo de novo: aqui é só o que aparece na tela.
// ============================================================
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function horaBR(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function mesISO(delta) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + delta); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function mesBR(c) { return String(c || '').split('-').reverse().join('/'); }
  function linkSeguro(u) { return /^https:\/\/[a-z0-9.-]+\.superlogica\.net\//i.test(String(u || '')) ? u : ''; }
  var COR = { alta: 'var(--danger)', media: 'var(--warning)', baixa: 'var(--muted)' };
  var NOME_GRAV = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
  function selo(g) {
    return '<span style="display:inline-block;min-width:52px;text-align:center;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:' + (COR[g] || 'var(--muted)') + '">' + esc(NOME_GRAV[g] || g) + '</span>';
  }
  var TD = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid var(--border);vertical-align:top"';
  function aviso(el, texto, erro) {
    if (el) el.innerHTML = texto ? '<div style="font-size:12px;font-family:var(--mono);color:' + (erro ? 'var(--danger)' : 'var(--muted)') + '">' + esc(texto) + '</div>' : '';
  }

  // Quem vê: módulo financeiro com pré balancete e os itens Boletos e Conciliação (o servidor exige o mesmo).
  function podeAbrir(nome) { return typeof window.podeAbrirPainel === 'function' && window.podeAbrirPainel(nome); }
  window.finFechamentoPode = function () {
    if (!podeAbrir('fincontrole')) return false;
    if (window.USER_ROLE === 'GESTOR') return true;
    var pre = typeof temPermissao === 'function' && !!window.USER_PERMS && temPermissao('financeiro', 'pre_balancete');
    return !!pre && podeAbrir('boletos') && podeAbrir('conciliacao');
  };
  function podeAnexos() {
    if (!podeAbrir('fincontrole')) return false;
    if (window.USER_ROLE === 'GESTOR') return true;
    return typeof temPermissao === 'function' && !!window.USER_PERMS && temPermissao('financeiro', 'pre_balancete');
  }

  // GET que espera o 202 (cálculo em segundo plano). vivo(): false cancela (a tela mudou).
  async function pegar(url, vivo, aoEsperar, tentativas) {
    for (var t = 0; t < (tentativas || 60); t++) {
      if (vivo && !vivo()) throw new Error('cancelado');
      var r = await apiAuthFetch(url);
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 202) {
        if (aoEsperar) aoEsperar(j, t);
        await new Promise(function (ok) { setTimeout(ok, 6000); });
        url = url.replace(/[?&]forcar=1/, '');
        continue;
      }
      if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
      return j;
    }
    throw new Error('A conferência está demorando mais que o normal. Tente de novo em alguns minutos.');
  }

  // 1. Conferência dos anexos dentro do pré balancete.
  var seqA = 0;
  window.finAnexosPre = function (el, cond, comp) {
    if (!el || !cond || !/^\d{4}-\d{2}$/.test(String(comp || '')) || !podeAnexos()) return;
    var box = document.createElement('div');
    box.id = 'fin-anexos-box';
    box.style.cssText = 'border:1px solid var(--border2);border-radius:10px;padding:10px 12px;margin-top:12px';
    box.innerHTML = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><b style="font-size:13px">Conferência dos anexos de ' + esc(mesBR(comp)) + '</b>'
      + '<button class="btn btn-ghost" id="fin-anexos-atualizar" style="font-size:12px;padding:4px 10px" title="Lê de novo a lista de despesas; arquivos já lidos não são lidos de novo">Atualizar</button></div>'
      + '<div class="hint" style="margin-bottom:6px">Confere cada anexo das despesas pagas no mês: comprovante com o valor e a data da baixa, condomínio como pagador ou tomador pelo CNPJ, CNPJ de outro condomínio, linha digitável e PDF gerado por editor ou modificado. Arquivo já lido não é lido de novo.</div>'
      + '<div id="fin-anexos-info" class="ficha-sub" style="margin-bottom:6px"></div><div id="fin-anexos-lista"></div>';
    el.appendChild(box);
    document.getElementById('fin-anexos-atualizar').addEventListener('click', function () { carregarAnexos(cond, comp, true); });
    carregarAnexos(cond, comp, false);
  };
  async function carregarAnexos(cond, comp, forcar) {
    var seq = ++seqA;
    var vivo = function () { return seq === seqA && !!document.getElementById('fin-anexos-box'); };
    aviso(document.getElementById('fin-anexos-info'), 'Conferindo os anexos...');
    try {
      var j = await pegar('/api/financeiro/condominio/' + encodeURIComponent(cond.id) + '/anexos?competencia=' + encodeURIComponent(comp) + (forcar ? '&forcar=1' : ''), vivo, function (p) {
        if (vivo()) aviso(document.getElementById('fin-anexos-info'), 'Conferindo os anexos' + (p && p.total ? ': ' + p.feitos + ' de ' + p.total + ' arquivos' : '') + '. Na primeira vez leva alguns minutos; depois fica guardado.');
      }, 100);
      if (!vivo()) return;
      renderAnexos(j);
    } catch (e) {
      if (e.message !== 'cancelado' && vivo()) aviso(document.getElementById('fin-anexos-info'), e.message, true);
    }
  }

  function renderAnexos(j) {
    var s = j.resumo || {};
    // || 0: resposta sem o resumo completo mostrava "undefined anexo(s)" na tela
    var info = (s.anexos || 0) + ' anexo(s) em ' + (s.despesas || 0) + ' despesa(s) paga(s): ' + (s.lidos_texto || 0) + ' lido(s) pelo texto, ' + (s.lidos_interna || 0) + ' escaneado(s) lido(s)'
      + (s.escaneados_nao_lidos ? ', ' + s.escaneados_nao_lidos + ' escaneado(s) só listado(s)' : '') + (s.outros_formatos ? ', ' + s.outros_formatos + ' em outro formato' : '')
      + (s.falhas ? ', ' + s.falhas + ' que não deu para baixar' : '') + '. ' + (s.sem_anexo ? s.sem_anexo + ' despesa(s) sem anexo (aparecem no pré balancete). ' : '')
      + 'Conferido em ' + horaBR(j.gerado_em) + '.'
      + (j.limite_interna ? ' O limite de leitura de escaneados por hora foi atingido; os restantes ficaram só listados.' : '')
      + (j.limite_downloads ? ' O limite de downloads por hora foi atingido; atualize mais tarde.' : '')
      + (j.sem_cnpj_cadastro ? ' O cadastro do condomínio no Superlógica está sem CNPJ: a conferência de pagador e tomador fica incompleta.' : '');
    aviso(document.getElementById('fin-anexos-info'), info);
    var el = document.getElementById('fin-anexos-lista');
    var cab = j.pode_fechar
      ? '<div style="padding:8px 12px;border-radius:8px;background:rgba(45,174,114,0.10);color:var(--success);font-weight:600;margin-bottom:8px">Nenhum anexo para conferir.' + (s.so_informativo ? ' ' + s.so_informativo + ' observação(ões) só informativa(s).' : '') + '</div>'
      : '<div style="padding:8px 12px;border-radius:8px;background:rgba(224,58,58,0.08);color:var(--danger);font-weight:600;margin-bottom:8px">' + (s.para_conferir || 0) + ' achado(s) para conferir em ' + (s.despesas_para_conferir || s.despesas_com_achado || 0) + ' despesa(s).' + (j.cortado ? ' O mês tem despesas demais: a conferência ficou incompleta.' : '') + '</div>';
    var html = cab;
    var lista = j.despesas || [];
    if (lista.length) {
      html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><tbody>';
      lista.slice(0, 300).forEach(function (d) {
        var link = linkSeguro(d.link);
        var achados = d.achados.map(function (a) {
          return '<div style="margin-bottom:4px">' + selo(a.gravidade) + ' <b>' + esc(a.titulo) + '</b>' + (a.arquivo ? ' <span style="color:var(--muted);font-size:11px">(' + esc(a.arquivo) + (a.leitura === 'interna' ? ', escaneado' : '') + ')</span>' : '')
            + '<br><span style="font-size:11px;color:var(--muted)">' + esc(a.motivo) + '</span></div>';
        }).join('');
        // Fornecedor quebra em ate 2 linhas e os achados quebram inteiros (td-livre no index.html):
        // antes o motivo de cada achado ficava numa linha so e abria rolagem lateral no cartao
        html += '<tr><td ' + TD + ' class="td-livre" title="' + esc(d.fornecedor) + '"><div class="td-2l">' + esc(d.fornecedor) + '</div>' + (d.documento ? '<span style="color:var(--muted);font-size:11px">doc. ' + esc(d.documento) + '</span>' : '') + '</td>'
          + '<td ' + TD + '>' + brl(d.valor) + '<br><span style="font-size:11px;color:var(--muted)">pago ' + esc(d.liquidacao.split(' ').map(function (x) { return x.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$2/$1/$3'); }).join(', ')) + '</span></td>'
          + '<td ' + TD + ' class="td-livre">' + achados + '</td>'
          + '<td ' + TD + '>' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer" style="font-size:12px;white-space:nowrap">Abrir no Superlógica</a>' : '') + '</td></tr>';
      });
      html += '</tbody></table></div>';
      if (lista.length > 300) html += '<div class="hint">Mostrando 300 de ' + lista.length + '.</div>';
    }
    var esc2 = j.escaneados || [];
    if (esc2.length) {
      html += '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px">' + esc2.length + ' escaneado(s) só listado(s), sem leitura</summary><ul style="font-size:12px;margin:6px 0 0 18px">'
        + esc2.map(function (x) { var l = linkSeguro(x.link); return '<li>' + esc(x.fornecedor) + ': ' + esc(x.arquivo) + (l ? ' <a href="' + esc(l) + '" target="_blank" rel="noopener noreferrer">abrir</a>' : '') + '</li>'; }).join('')
        + '</ul></details>';
    }
    el.innerHTML = html;
  }

  // 2. Aba Fechamento do mês.
  var seqF = 0;
  var fech = { cond: null, irPara: null, dados: null };
  window.finFechamentoAba = function (el, cond, irPara) {
    if (!el || !cond || !window.finFechamentoPode()) return;
    var mudou = !fech.cond || fech.cond.id !== cond.id;
    fech.cond = cond; fech.irPara = irPara;
    if (mudou) fech.dados = null;
    el.innerHTML = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">'
      + '<label style="font-size:12px">Mês <input type="month" id="fin-fech-mes" value="' + (fech.dados ? fech.dados.competencia : mesISO(-1)) + '" max="' + mesISO(0) + '" style="width:auto"></label>'
      + '<button class="btn btn-primary" id="fin-fech-conferir" style="font-size:12px;padding:6px 14px">Conferir fechamento</button>'
      + '<button class="btn btn-ghost" id="fin-fech-atualizar" style="font-size:12px;padding:6px 12px" title="Lê de novo no Superlógica">Atualizar</button></div>'
      + '<div class="hint" style="margin-bottom:8px">Antes de gerar o balancete: conciliação do mês com diferença zero, extrato importado até o último dia útil, pré balancete sem pendência, boletos do mês conferidos e anexos conferidos.</div>'
      + '<div id="fin-fech-info" class="ficha-sub" style="margin-bottom:8px"></div><div id="fin-fech-res"></div>';
    document.getElementById('fin-fech-conferir').addEventListener('click', function () { carregarFechamento(false); });
    document.getElementById('fin-fech-atualizar').addEventListener('click', function () { carregarFechamento(true); });
    if (fech.dados) renderFechamento(fech.dados);
  };
  async function carregarFechamento(forcar) {
    var c = fech.cond;
    var mes = (document.getElementById('fin-fech-mes') || {}).value;
    if (!/^\d{4}-\d{2}$/.test(String(mes || ''))) { aviso(document.getElementById('fin-fech-info'), 'Escolha o mês.', true); return; }
    var seq = ++seqF;
    var vivo = function () { return seq === seqF && !!document.getElementById('fin-fech-res') && fech.cond && fech.cond.id === c.id; };
    document.getElementById('fin-fech-res').innerHTML = '';
    aviso(document.getElementById('fin-fech-info'), 'Lendo a conciliação, o pré balancete, os boletos e os anexos (pode levar alguns minutos na primeira vez)...');
    var url = '/api/financeiro/condominio/' + encodeURIComponent(c.id) + '/fechamento?competencia=' + encodeURIComponent(mes) + (forcar ? '&forcar=1' : '');
    try {
      for (var volta = 0; volta < 60; volta++) {
        var j = await pegar(url, vivo, null, 40);
        if (!vivo()) return;
        fech.dados = j;
        renderFechamento(j);
        if (!j.calculando) return;
        // Só os anexos ainda estão sendo conferidos: mostra o que já tem e tenta de novo.
        url = url.replace(/[?&]forcar=1/, '');
        await new Promise(function (ok) { setTimeout(ok, 8000); });
      }
    } catch (e) {
      if (e.message !== 'cancelado' && vivo()) aviso(document.getElementById('fin-fech-info'), e.message, true);
    }
  }

  var ICONE = { ok: ['✓', 'var(--success)'], conferido: ['✓', 'var(--success)'], pendente: ['✗', 'var(--danger)'], falha: ['!', 'var(--warning)'], calculando: ['…', 'var(--muted)'] };
  function renderFechamento(j) {
    aviso(document.getElementById('fin-fech-info'), 'Mês ' + mesBR(j.competencia) + (j.ultimo_dia_util ? ', último dia útil ' + dataBR(j.ultimo_dia_util) : '') + '. Conferido em ' + horaBR(j.gerado_em) + '.'
      + (j.marcas_disponiveis ? '' : ' Marcar como conferido ainda não está liberado neste ambiente.'));
    var el = document.getElementById('fin-fech-res');
    var cab = j.pronto
      ? '<div style="padding:12px 14px;border-radius:10px;background:rgba(45,174,114,0.10);color:var(--success);font-weight:600;margin-bottom:10px">Pronto para gerar o balancete de ' + esc(mesBR(j.competencia)) + '.</div>'
      : '<div style="padding:12px 14px;border-radius:10px;background:' + (j.calculando && j.falta.length === 1 ? 'rgba(120,120,120,0.08);color:var(--muted)' : 'rgba(224,58,58,0.08);color:var(--danger)') + ';font-weight:600;margin-bottom:10px">' + esc(j.status) + '</div>';
    var html = cab;
    (j.itens || []).forEach(function (it) {
      var ic = ICONE[it.situacao] || ICONE.pendente;
      var r = it.resolver || {};
      var botoes = '';
      if (it.situacao !== 'ok' && (r.aba || r.painel) && podeIr(r)) botoes += '<button class="btn btn-ghost" data-fech-ir="' + esc(it.chave) + '" style="font-size:12px;padding:4px 10px">' + esc(r.rotulo || 'Resolver') + '</button>';
      if (it.pode_marcar && j.marcas_disponiveis && (it.situacao === 'pendente' || it.situacao === 'conferido')) {
        botoes += it.situacao === 'conferido' && it.marca && !it.marca.vencida
          ? '<button class="btn btn-ghost" data-fech-desmarcar="' + esc(it.chave) + '" style="font-size:12px;padding:4px 10px">Desfazer conferido</button>'
          : '<input type="text" maxlength="300" placeholder="Observação (opcional)" data-fech-obs="' + esc(it.chave) + '" style="width:220px;font-size:12px;padding:4px 8px"> <button class="btn btn-ghost" data-fech-marcar="' + esc(it.chave) + '" style="font-size:12px;padding:4px 10px">Marcar como conferido</button>';
      }
      var marca = it.marca ? '<div style="font-size:11px;color:var(--muted);margin-top:4px">Marcado como conferido por ' + esc(it.marca.por || 'usuário') + ' em ' + esc(horaBR(it.marca.em)) + (it.marca.observacao ? ': ' + esc(it.marca.observacao) : '') + (it.marca.vencida ? ' (perdeu a validade)' : '') + '</div>' : '';
      html += '<div style="display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border2);border-radius:10px;padding:10px 12px;margin-bottom:8px">'
        + '<div style="font-size:18px;font-weight:700;width:20px;text-align:center;color:' + ic[1] + '">' + ic[0] + '</div>'
        + '<div style="flex:1"><div style="font-size:13px;font-weight:600">' + esc(it.titulo) + (it.situacao === 'conferido' ? ' <span style="font-size:11px;color:var(--success)">(conferido à mão)</span>' : '') + '</div>'
        + (it.trava && it.situacao !== 'ok' && it.situacao !== 'conferido' ? '<div style="font-size:12px;color:' + (it.situacao === 'calculando' ? 'var(--muted)' : 'var(--danger)') + ';margin-top:2px">' + esc(it.trava) + '</div>' : '')
        + (it.detalhe ? '<div style="font-size:12px;color:var(--muted);margin-top:2px">' + esc(it.detalhe) + '</div>' : '')
        + (r.externo && it.situacao === 'pendente' ? '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + esc(r.externo) + ' e conferir de novo aqui.</div>' : '')
        + marca + (botoes ? '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">' + botoes + '</div>' : '') + '</div></div>';
    });
    el.innerHTML = html;
    el.querySelectorAll('[data-fech-ir]').forEach(function (b) { b.addEventListener('click', function () { irPara(b.getAttribute('data-fech-ir')); }); });
    el.querySelectorAll('[data-fech-marcar]').forEach(function (b) { b.addEventListener('click', function () { marcar(b.getAttribute('data-fech-marcar'), true, b); }); });
    el.querySelectorAll('[data-fech-desmarcar]').forEach(function (b) { b.addEventListener('click', function () { marcar(b.getAttribute('data-fech-desmarcar'), false, b); }); });
  }

  function podeIr(r) { return r.aba ? true : podeAbrir(r.painel); }
  // Resolver: o pré balancete e os anexos ficam neste mesmo detalhe; Boletos e Conciliação são itens
  // do menu que trabalham sobre o condomínio escolhido no topo.
  function irPara(chave) {
    var j = fech.dados;
    var it = j && (j.itens || []).filter(function (x) { return x.chave === chave; })[0];
    if (!it) return;
    var r = it.resolver || {};
    if (r.aba && fech.irPara) { fech.irPara(r.aba, j.competencia); return; }
    if (!r.painel || !podeAbrir(r.painel)) return;
    var ativo = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
    var mesmo = ativo && String(ativo.id_superlogica || '') === String(fech.cond.id);
    if (!mesmo) {
      aviso(document.getElementById('fin-fech-info'), 'A tela ' + (r.painel === 'boletos' ? 'Boletos' : 'Conciliação') + ' trabalha sobre o condomínio escolhido no topo. Escolha ' + (fech.cond.nome || 'o código ' + fech.cond.id) + ' no topo e abra de novo.', true);
      return;
    }
    if (r.painel === 'boletos') { var m = document.getElementById('fin-bol-mes'); if (m) m.value = j.competencia; }
    if (typeof showPanel === 'function') showPanel(r.painel);
  }
  async function marcar(chave, conferido, botao) {
    var j = fech.dados;
    if (!j || !fech.cond) return;
    var obs = '';
    var campo = document.querySelector('[data-fech-obs="' + chave + '"]');
    if (campo) obs = campo.value.slice(0, 300);
    if (botao) botao.disabled = true;
    try {
      var r = await apiAuthFetch('/api/financeiro/condominio/' + encodeURIComponent(fech.cond.id) + '/fechamento/marcar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competencia: j.competencia, item: chave, conferido: conferido, observacao: obs }),
      });
      var b = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(b.detalhe || ('Falha ' + r.status));
      carregarFechamento(false);
    } catch (e) {
      aviso(document.getElementById('fin-fech-info'), e.message, true);
      if (botao) botao.disabled = false;
    }
  }

  // 3. Coluna Fechamento no quadro da carteira: último status calculado; "Calcular" confere um a um.
  var seqQ = 0;
  window.finFechamentoQuadro = function (el, lista, carteira) {
    if (!el || !window.finFechamentoPode()) return;
    var barra = document.createElement('div');
    barra.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 8px';
    barra.innerHTML = '<label style="font-size:12px">Fechamento de <input type="month" id="fin-fq-mes" value="' + mesISO(-1) + '" max="' + mesISO(0) + '" style="width:auto"></label>'
      + '<button class="btn btn-ghost" id="fin-fq-calcular" style="font-size:12px;padding:4px 10px" title="Confere o fechamento de cada condomínio da lista, um de cada vez">Conferir o fechamento de todos</button>'
      + '<span id="fin-fq-info" style="font-size:11px;color:var(--muted)"></span>';
    el.insertBefore(barra, el.firstChild);
    var ids = (lista || []).map(function (c) { return String(c.id_condominio); }).filter(function (x) { return /^\d+$/.test(x); });
    document.getElementById('fin-fq-mes').addEventListener('change', function () { preencherQuadro(el, carteira); });
    document.getElementById('fin-fq-calcular').addEventListener('click', function () { calcularTodos(el, ids, carteira); });
    el.querySelectorAll('td[data-fin-fech]').forEach(function (td) {
      td.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var tr = td.closest('tr');
        if (typeof window.finAbrirCondominio === 'function') window.finAbrirCondominio(td.getAttribute('data-fin-fech'), tr ? tr.getAttribute('data-fin-nome') : '', 'fechamento');
      });
    });
    preencherQuadro(el, carteira);
  };
  function celula(el, id, s) {
    var td = el.querySelector('td[data-fin-fech="' + id + '"]');
    if (!td) return;
    if (!s) { td.innerHTML = '<span style="color:var(--muted);font-size:11px" title="Clique para conferir o fechamento">não conferido</span>'; return; }
    if (s.calculando) { td.innerHTML = '<span style="color:var(--muted);font-size:11px">conferindo...</span>'; return; }
    var falta = s.falta || [];
    td.innerHTML = s.pronto
      ? '<span style="color:var(--success);font-weight:600;font-size:12px" title="Conferido em ' + esc(horaBR(s.calculado_em)) + '">Pronto</span>'
      : '<span style="color:var(--danger);font-weight:600;font-size:12px" title="' + esc(falta.join('; ') + '. Conferido em ' + horaBR(s.calculado_em)) + '">Falta ' + falta.length + '</span>'
        + '<div style="font-size:10px;color:var(--muted);max-width:220px">' + esc(falta.join('; ')) + '</div>';
  }
  async function preencherQuadro(el, carteira) {
    var mes = (document.getElementById('fin-fq-mes') || {}).value;
    if (!/^\d{4}-\d{2}$/.test(String(mes || ''))) return;
    var seq = ++seqQ;
    try {
      var r = await apiAuthFetch('/api/financeiro/fechamento/quadro?competencia=' + encodeURIComponent(mes) + (carteira ? '&carteira=' + encodeURIComponent(carteira) : ''));
      var j = await r.json().catch(function () { return {}; });
      if (seq !== seqQ) return;
      if (!r.ok) { aviso(document.getElementById('fin-fq-info'), j.detalhe || 'Não foi possível ler o fechamento.', true); return; }
      el.querySelectorAll('td[data-fin-fech]').forEach(function (td) { var id = td.getAttribute('data-fin-fech'); celula(el, id, (j.condominios || {})[id]); });
    } catch (e) { if (seq === seqQ) aviso(document.getElementById('fin-fq-info'), e.message, true); }
  }

  // Um condomínio de cada vez (cada um lê conciliação, pré balancete, boletos e anexos).
  var calculandoTodos = false;
  async function calcularTodos(el, ids, carteira) {
    if (calculandoTodos) return;
    var mes = (document.getElementById('fin-fq-mes') || {}).value;
    if (!/^\d{4}-\d{2}$/.test(String(mes || ''))) return;
    calculandoTodos = true;
    var btn = document.getElementById('fin-fq-calcular');
    if (btn) btn.disabled = true;
    var seq = seqQ;
    try {
      for (var i = 0; i < ids.length; i++) {
        if (!document.getElementById('fin-fq-mes') || document.getElementById('fin-fq-mes').value !== mes) break;
        aviso(document.getElementById('fin-fq-info'), 'Conferindo ' + (i + 1) + ' de ' + ids.length + '...');
        celula(el, ids[i], { calculando: true });
        try {
          var url = '/api/financeiro/condominio/' + encodeURIComponent(ids[i]) + '/fechamento?competencia=' + encodeURIComponent(mes);
          var j = null;
          for (var v = 0; v < 40; v++) {
            j = await pegar(url, null, null, 40);
            if (!j.calculando) break;
            await new Promise(function (ok) { setTimeout(ok, 8000); });
          }
          celula(el, ids[i], j ? { pronto: j.pronto, falta: j.falta, calculado_em: j.gerado_em } : null);
        } catch (e) {
          var td = el.querySelector('td[data-fin-fech="' + ids[i] + '"]');
          if (td) td.innerHTML = '<span style="color:var(--warning);font-size:11px">' + esc(e.message) + '</span>';
        }
      }
      aviso(document.getElementById('fin-fq-info'), seq === seqQ ? 'Conferência terminada.' : '');
    } finally {
      calculandoTodos = false;
      if (document.getElementById('fin-fq-calcular')) document.getElementById('fin-fq-calcular').disabled = false;
    }
  }
})();
