// ============================================================
// COBRANÇA (T11): inadimplência por carteira com o último contato do CRM de
// cobrança do Superlógica, simulação de acordo e link da 2ª via com texto
// pronto para WhatsApp. Leitura; a 2ª via só para gestor e gerente.
// Rotas: /api/cobranca/condominio/:id, .../simular, .../segunda-via, /api/carteiras.
// ============================================================

var cobEstado = { seq: 0, paineis: {}, carregado: false };

function cobEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function cobBRL(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function cobIsoDias(n) {
  var d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
async function cobJson(url, opts) {
  var r = await apiAuthFetch(url, opts);
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
  return j;
}

// Ao abrir a aba: monta a lista de carteiras (GESTOR vê todos os grupos do Superlógica).
async function cobrancaAbrir() {
  if (cobEstado.carregado || cobEstado.abrindo || !window.AUTH_TOKEN) return;
  var sel = document.getElementById('cob-carteira');
  if (!sel) return;
  cobEstado.abrindo = true;
  if (window.CondSeletor && CondSeletor.lista() === null) await CondSeletor.carregar();
  cobEstado.abrindo = false;
  if (!window.CondSeletor || !CondSeletor.lista()) return; // tenta de novo na próxima abertura
  cobEstado.carregado = true;
  sel.innerHTML = '<option value="meus">Meus condomínios</option><option value="ativo">Só o condomínio ativo</option>';
  if (window.USER_ROLE === 'GESTOR') {
    try {
      var g = await cobJson('/api/carteiras');
      cobEstado.carteirasOk = true;
      (Array.isArray(g) ? g : []).forEach(function (c) {
        if (!c || !c.id) return;
        var o = document.createElement('option');
        o.value = 'g' + c.id;
        o.textContent = c.nome + ' (' + (c.quantidade || (c.condominios || []).length) + ')';
        o.dataset.ids = (c.condominios || []).join(',');
        sel.appendChild(o);
      });
    } catch (e) { cobEstado.carregado = false; /* sem carteiras agora: tenta de novo na próxima abertura */ }
  }
}

function cobCondominiosEscolhidos() {
  var sel = document.getElementById('cob-carteira');
  var lista = (window.CondSeletor && CondSeletor.lista()) || [];
  var comCodigo = lista.filter(function (c) { return c.id_superlogica; });
  if (!sel || sel.value === 'meus') return comCodigo;
  if (sel.value === 'ativo') {
    var a = getCondominioAtivo();
    return a && a.id_superlogica ? [{ id: a.id, nome: a.nome, id_superlogica: a.id_superlogica }] : [];
  }
  var ids = (sel.options[sel.selectedIndex].dataset.ids || '').split(',');
  // Só os condomínios que existem no Hub (a carteira do Superlógica pode ter outros cadastros).
  return comCodigo.filter(function (c) { return ids.indexOf(String(c.id_superlogica)) >= 0; });
}

// Carrega condomínio por condomínio (3 de cada vez), enchendo a tabela aos poucos.
async function cobrancaCarregar(forcar) {
  var conds = cobCondominiosEscolhidos();
  // Muitos condomínios = muitas leituras no Superlógica: confirma antes (sem janela do navegador).
  var aviso = document.getElementById('cob-info');
  if (conds.length > 30 && !cobEstado.confirmouGrande) {
    cobEstado.confirmouGrande = true;
    aviso.textContent = 'São ' + conds.length + ' condomínios: a leitura pode levar vários minutos. Clique em Carregar de novo para confirmar, ou escolha uma carteira menor.';
    return;
  }
  cobEstado.confirmouGrande = false;
  var det = document.getElementById('cob-unidades');
  if (det) { det.style.display = 'none'; det.innerHTML = ''; }
  var seq = ++cobEstado.seq;
  var tab = document.getElementById('cob-tabela');
  var info = document.getElementById('cob-info');
  cobEstado.paineis = {};
  if (!conds.length) { tab.innerHTML = ''; info.textContent = 'Nenhum condomínio com código do Superlógica nessa escolha.'; return; }
  tab.innerHTML = '<table class="ficha-tab" id="cob-t"><tr><th>Condomínio</th><th class="n">Unidades em atraso</th><th class="n">Em aberto</th><th class="n">Corrigido</th><th class="n">Sem contato há 90 dias</th><th></th></tr></table>';
  var feitos = 0, totalC = 0, totalU = 0, i = 0;
  info.textContent = 'Lendo 0 de ' + conds.length + ' condomínios no Superlógica...';
  async function trab() {
    while (i < conds.length) {
      var c = conds[i++];
      var linha = document.createElement('tr');
      // Nome do condominio e mensagem de erro sao textos livres: quebram na celula (td-livre no index.html)
      linha.innerHTML = '<td class="td-livre" title="' + cobEsc(c.nome) + '"><div class="td-2l">' + cobEsc(c.nome) + '</div></td><td colspan="5" class="ficha-sub">carregando...</td>';
      document.getElementById('cob-t').appendChild(linha);
      try {
        var p = await cobJson('/api/cobranca/condominio/' + encodeURIComponent(c.id_superlogica) + (forcar ? '?forcar=1' : ''));
        if (seq !== cobEstado.seq) return;
        cobEstado.paineis[c.id_superlogica] = { cond: c, p: p };
        totalC += p.total_corrigido; totalU += p.quantidade_unidades;
        linha.innerHTML = '<td class="td-livre" title="' + cobEsc(c.nome) + '"><div class="td-2l">' + cobEsc(c.nome) + (p.cortado ? ' <span class="ficha-sub">(lista cortada)</span>' : '') + '</div></td>'
          + '<td class="n">' + p.quantidade_unidades + '</td><td class="n">' + cobBRL(p.total_original) + '</td><td class="n">' + cobBRL(p.total_corrigido) + '</td>'
          + '<td class="n">' + (p.sem_contato_90_dias == null ? '<span class="ficha-sub">sem dado</span>' : p.sem_contato_90_dias) + (p.crm_indisponivel ? ' <span class="ficha-sub">(CRM indisponível)</span>' : '') + '</td>'
          + '<td>' + (p.quantidade_unidades ? '<button class="btn btn-ghost cob-ver" data-id="' + cobEsc(c.id_superlogica) + '" style="font-size:11px;padding:4px 10px">Ver unidades</button>' : '') + '</td>';
        linha.dataset.total = p.total_corrigido;
      } catch (e) {
        if (seq !== cobEstado.seq) return;
        linha.innerHTML = '<td class="td-livre" title="' + cobEsc(c.nome) + '"><div class="td-2l">' + cobEsc(c.nome) + '</div></td><td colspan="5" class="ficha-erro td-livre">' + cobEsc(e.message) + '</td>';
      }
      feitos++;
      info.textContent = (feitos < conds.length ? 'Lendo ' + feitos + ' de ' + conds.length + ' condomínios. ' : conds.length + ' condomínios. ')
        + totalU + ' unidades em atraso, ' + cobBRL(totalC) + ' com juros e multa.';
    }
  }
  await Promise.all([trab(), trab(), trab()]);
  if (seq !== cobEstado.seq) return;
  // Ordena do maior para o menor valor corrigido.
  var t = document.getElementById('cob-t');
  var linhas = Array.prototype.slice.call(t.querySelectorAll('tr')).slice(1);
  linhas.sort(function (a, b) { return Number(b.dataset.total || 0) - Number(a.dataset.total || 0); });
  linhas.forEach(function (l) { t.appendChild(l); });
}

function cobVerUnidades(idSL) {
  var reg = cobEstado.paineis[idSL];
  var el = document.getElementById('cob-unidades');
  if (!reg || !el) return;
  var p = reg.p;
  // T18: 2ª via para o GESTOR ou quem tem a ação cobranca.segunda_via (public/carteira-modulos.js).
  var gerencia = typeof window.cobPodeSegundaVia === 'function' ? window.cobPodeSegundaVia() : window.USER_ROLE === 'GESTOR';
  var ate = cobIsoDias(3);
  el.innerHTML = '<div class="card-header"><span class="card-title">' + cobEsc(reg.cond.nome) + ': unidades em atraso</span></div>'
    + '<table class="ficha-tab"><tr><th>Unidade</th><th>Responsável</th><th class="n">Cobranças</th><th class="n">Corrigido</th><th>Último contato</th><th></th></tr>'
    + p.unidades.map(function (u, k) {
      var c = u.ultimo_contato;
      // A descricao do ultimo contato vem do CRM e pode ser um paragrafo: fica em ate 2 linhas, inteira no title
      var contato = c ? cobEsc(c.data) + ' · ' + cobEsc(c.canal) + (c.por ? ' · ' + cobEsc(c.por) : '') + '<div class="ficha-sub td-2l" title="' + cobEsc(c.descricao) + '">' + cobEsc(c.descricao) + '</div>'
        : (p.crm_indisponivel ? '<span class="ficha-sub">CRM indisponível agora</span>' : '<span class="ficha-erro" style="padding:0">sem contato registrado em 120 dias</span>');
      var semAcordo = u.recebimentos.filter(function (r) { return !r.acordo; });
      var opc = semAcordo.slice(-24).map(function (r) { return '<option value="' + cobEsc(r.id) + '">' + cobEsc(r.vencimento) + ' · ' + cobBRL(r.corrigido) + '</option>'; }).join('');
      return '<tr><td>' + cobEsc(u.unidade) + (u.juridico ? ' <span class="ficha-tag">jurídico</span>' : '') + '</td><td class="td-livre" title="' + cobEsc(u.responsavel) + '"><div class="td-2l">' + cobEsc(u.responsavel) + '</div></td>'
        + '<td class="n">' + u.cobrancas + '</td><td class="n">' + cobBRL(u.valor_corrigido) + '</td><td class="td-livre">' + contato + '</td>'
        + '<td style="white-space:nowrap">'
        + (semAcordo.length ? '<button class="btn btn-ghost cob-acao" data-acao="abrir" data-k="' + k + '" style="font-size:11px;padding:4px 8px">Simular acordo</button>' : '<span class="ficha-sub">em acordo</span>')
        + '</td></tr>'
        + '<tr class="cob-extra" id="cob-x-' + k + '" style="display:none"><td colspan="6">'
        + '<div class="cob-form">Parcelas <input type="number" min="1" max="60" value="6" class="cob-n" style="width:70px">'
        + ' Entrada R$ <input type="number" min="0" step="0.01" value="0" class="cob-e" style="width:110px">'
        + ' 1ª parcela <input type="date" class="cob-p" value="' + cobIsoDias(10) + '" style="width:150px">'
        + ' <button class="btn btn-primary cob-acao" data-acao="simular" data-k="' + k + '" style="font-size:11px;padding:5px 10px">Simular</button></div>'
        + (gerencia && semAcordo.length ? '<div class="cob-form">2ª via do boleto <select class="cob-r" style="width:auto">' + opc + '</select> pagar até <input type="date" class="cob-a" value="' + ate + '" style="width:150px">'
          + ' <button class="btn btn-ghost cob-acao" data-acao="via" data-k="' + k + '" style="font-size:11px;padding:5px 10px">Gerar link</button></div>' : '')
        + '<div class="cob-res"></div></td></tr>';
    }).join('') + '</table>';
  el.dataset.idsl = String(idSL);
  el.dataset.seq = String(cobEstado.seq);
  el.style.display = '';
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cobAbrirAcordo(idSL, k) {
  var tr = document.getElementById('cob-x-' + k);
  if (tr) tr.style.display = tr.style.display === 'none' ? '' : 'none';
}

function cobTextoArea(texto) {
  return '<textarea readonly rows="4" style="width:100%;margin-top:6px;font-family:var(--mono);font-size:12px">' + cobEsc(texto) + '</textarea>'
    + '<div><button class="btn btn-ghost cob-copiar" style="font-size:11px;padding:4px 10px;margin-top:4px">Copiar texto</button></div>';
}
function cobCopiar(btn) {
  var ta = btn.parentNode.previousElementSibling;
  if (!ta) return;
  ta.select();
  try { navigator.clipboard.writeText(ta.value).then(function () { toast('Texto copiado.', 'ok'); }, function () { document.execCommand('copy'); toast('Texto copiado.', 'ok'); }); }
  catch (e) { document.execCommand('copy'); toast('Texto copiado.', 'ok'); }
}

async function cobSimular(idSL, k) {
  var reg = cobEstado.paineis[idSL];
  var tr = document.getElementById('cob-x-' + k);
  if (!reg || !tr) return;
  var u = reg.p.unidades[k];
  var res = tr.querySelector('.cob-res');
  res.innerHTML = '<div class="cond-loading">Simulando no Superlógica...</div>';
  try {
    var s = await cobJson('/api/cobranca/condominio/' + encodeURIComponent(idSL) + '/simular', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_unidade: u.id_unidade, parcelas: tr.querySelector('.cob-n').value, entrada: tr.querySelector('.cob-e').value, primeira: tr.querySelector('.cob-p').value }),
    });
    var linhas = s.parcelas.map(function (p, i) { return (i + 1) + ') ' + p.vencimento + ': ' + cobBRL(p.valor); });
    // C06: plural certo e o principal com nome claro (o Superlógica chama a conta do principal de "Acordos").
    var nCob = Number(s.cobrancas) || 0;
    var texto = 'Proposta de acordo da unidade ' + s.unidade + ' (' + nCob + (nCob === 1 ? ' cobrança' : ' cobranças') + ' em aberto). Total atualizado: ' + cobBRL(s.total)
      + (s.entrada > 0 ? '. Entrada de ' + cobBRL(s.entrada) + ' hoje' : '') + '. Parcelas: ' + linhas.join('; ') + '. Simulação sujeita a confirmação da administradora.';
    var nomeConta = function (c) { return /^acordos?$/i.test(String(c || '').trim()) ? 'Valor principal' : c; };
    res.innerHTML = '<div class="ficha-sub" style="margin-top:6px">Composição: ' + s.composicao.map(function (c) { return cobEsc(nomeConta(c.conta)) + ' ' + cobBRL(c.valor); }).join(' · ')
      + ' · soma das parcelas ' + cobBRL(s.soma_parcelas) + '</div>' + cobTextoArea(texto);
  } catch (e) {
    res.innerHTML = '<div class="ficha-erro">' + cobEsc(e.message) + '</div>';
  }
}

async function cobSegundaVia(idSL, k, btn) {
  var reg = cobEstado.paineis[idSL];
  var tr = document.getElementById('cob-x-' + k);
  if (!reg || !tr || (btn && btn.disabled)) return;
  var u = reg.p.unidades[k];
  var res = tr.querySelector('.cob-res');
  // T48: pede ao Superlógica um boleto atualizado; confirma unidade e data antes.
  if (!confirm('Gerar a 2ª via no Superlógica para a unidade ' + u.unidade + ', para pagamento até ' + String(tr.querySelector('.cob-a').value || '').split('-').reverse().join('/') + '?')) return;
  if (btn) btn.disabled = true; // sem clique duplo: cada clique pode gerar um boleto atualizado
  setTimeout(function () { if (btn) btn.disabled = false; }, 15000);
  res.innerHTML = '<div class="cond-loading">Gerando o link no Superlógica...</div>';
  try {
    var r = await cobJson('/api/cobranca/condominio/' + encodeURIComponent(idSL) + '/segunda-via', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_unidade: u.id_unidade, id_recebimento: tr.querySelector('.cob-r').value, pagar_ate: tr.querySelector('.cob-a').value }),
    });
    res.innerHTML = cobTextoArea(r.texto);
  } catch (e) {
    res.innerHTML = '<div class="ficha-erro">' + cobEsc(e.message) + '</div>';
  }
}

document.addEventListener('click', function (ev) {
  var b = ev.target.closest && ev.target.closest('.cob-ver');
  if (b) { cobVerUnidades(b.dataset.id); return; }
  var cp = ev.target.closest && ev.target.closest('.cob-copiar');
  if (cp) { cobCopiar(cp); return; }
  var a = ev.target.closest && ev.target.closest('.cob-acao');
  if (!a) return;
  var det = document.getElementById('cob-unidades');
  // A lista de unidades é do carregamento em que foi aberta; recarregou, ela some.
  if (!det || det.dataset.seq !== String(cobEstado.seq)) return;
  var idSL = det.dataset.idsl, k = parseInt(a.dataset.k, 10);
  if (a.dataset.acao === 'abrir') cobAbrirAcordo(idSL, k);
  else if (a.dataset.acao === 'simular') cobSimular(idSL, k);
  else if (a.dataset.acao === 'via') cobSegundaVia(idSL, k, a);
});
document.addEventListener('auth:ready', function () {
  var p = document.getElementById('panel-cobranca');
  if (p && p.classList.contains('active')) cobrancaAbrir();
});
