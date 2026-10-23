// ============================================================
// CUSTO DE PROCESSAMENTO (T42): só para o administrador principal (o servidor confere).
// Custo do mês por função, por dia, projeção do mês e aviso perto do limite.
// O item do menu e a tela são criados aqui, para não mexer no resto do index.html.
// ============================================================

const CUSTO_NOMES = {
  atas: 'Atas', comunicados: 'Comunicados e multas', edital: 'Leitura do edital',
  medidores: 'Leitura de medidores', unidades: 'Normalização de unidades',
  prestacao: 'Prestação de contas', entrada_documentos: 'Entrada de documentos', regras: 'Regras do condomínio',
  apresentacao: 'Apresentação de assembleia', apresentacao_imagens: 'Apresentação de assembleia', outros: 'Outros',
};
// Junta as linhas que caem no mesmo nome de tela (função sem nome próprio vira Outros numa linha só).
function _custoJuntarPorNome(fs) {
  const m = new Map();
  fs.forEach((f) => {
    const nome = CUSTO_NOMES[f.funcao] || CUSTO_NOMES.outros;
    const g = m.get(nome) || { nome, custo_usd: 0, chamadas: 0 };
    g.custo_usd += Number(f.custo_usd) || 0; g.chamadas += Number(f.chamadas) || 0;
    m.set(nome, g);
  });
  return [...m.values()].sort((x, y) => y.custo_usd - x.custo_usd);
}
const _custoEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const _custoUsd = (v) => 'US$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function custoPodeVer() {
  const a = (window.USER_PERMS && window.USER_PERMS.configuracoes && window.USER_PERMS.configuracoes.acoes) || [];
  return a.includes('auditoria_total');
}

function custoMontar() {
  if (document.getElementById('panel-custo')) return;
  const seg = document.getElementById('nav-seguranca');
  const segPainel = document.getElementById('panel-seguranca');
  if (!seg || !segPainel) return;
  const nav = document.createElement('div');
  nav.className = 'nav-item'; nav.id = 'nav-custo'; nav.style.display = 'none';
  nav.innerHTML = '<span class="nav-icon">$</span> Custo de processamento <span id="custo-nav-alerta" style="display:none;color:var(--warning)">!</span>';
  nav.onclick = () => { showPanel('custo'); custoAbrir(); };
  seg.parentNode.insertBefore(nav, seg.nextSibling);
  const p = document.createElement('div');
  p.className = 'panel'; p.id = 'panel-custo';
  p.innerHTML = `
    <div class="card">
      <div class="card-header"><span class="card-title">Custo do mês</span>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="month" id="custo-mes" onchange="custoCarregar()">
          <button class="btn btn-ghost" style="font-size:11px" onclick="custoCarregar()">Atualizar</button>
        </div></div>
      <div id="custo-resumo"><div class="hint">Carregando...</div></div>
    </div>
    <div class="card"><div class="card-header"><span class="card-title">Por função</span></div><div id="custo-funcoes"></div></div>
    <div class="card"><div class="card-header"><span class="card-title">Por dia</span></div><div id="custo-dias" style="overflow-x:auto"></div></div>`;
  segPainel.parentNode.insertBefore(p, segPainel.nextSibling);
  try { if (typeof PAGE_META === 'object' && PAGE_META) PAGE_META.custo = { title: 'Custo de processamento', sub: 'gasto do mês por função' }; } catch (e) { /* sem título */ }
}

let _custoAlertaVisto = false;
function custoAtualizarMenu() {
  custoMontar();
  const n = document.getElementById('nav-custo');
  const pode = custoPodeVer();
  if (n) n.style.display = pode ? '' : 'none';
  if (!pode) {
    const p = document.getElementById('panel-custo');
    if (p && p.classList.contains('active') && typeof showPanel === 'function') showPanel('dashboard');
    return;
  }
  // Aviso no menu quando o mês passa de 75% do limite (uma consulta por carga de página).
  if (_custoAlertaVisto) return;
  _custoAlertaVisto = true;
  apiAuthFetch('/api/custo/resumo').then((r) => (r.ok ? r.json() : null)).then((j) => {
    const a = document.getElementById('custo-nav-alerta');
    if (a && j && j.alerta) a.style.display = '';
  }).catch(() => {});
}

function custoAbrir() {
  if (!custoPodeVer()) return;
  const el = document.getElementById('custo-mes');
  if (el && !el.value) {
    const br = new Date(Date.now() - 3 * 3600000);
    el.value = br.getUTCFullYear() + '-' + String(br.getUTCMonth() + 1).padStart(2, '0');
  }
  custoCarregar();
}

async function custoCarregar() {
  const box = document.getElementById('custo-resumo');
  const fun = document.getElementById('custo-funcoes');
  const dias = document.getElementById('custo-dias');
  if (!box) return;
  box.innerHTML = '<div class="hint">Carregando...</div>'; fun.innerHTML = ''; dias.innerHTML = '';
  const mes = (document.getElementById('custo-mes') || {}).value || '';
  try {
    const r = await apiAuthFetch('/api/custo/resumo' + (mes ? '?mes=' + encodeURIComponent(mes) : ''));
    const j = await r.json();
    if (!r.ok) throw new Error(j.detalhe || 'Não foi possível carregar.');
    custoDesenhar(j);
  } catch (e) {
    box.innerHTML = '<div class="hint">' + _custoEsc(e.message || 'Não foi possível carregar.') + '</div>';
  }
}

function custoDesenhar(j) {
  const cor = j.percentual_limite >= 100 ? 'var(--danger)' : j.alerta ? 'var(--warning)' : 'var(--success)';
  const caixa = (titulo, valor, extra) => `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 14px;min-width:160px">
      <div style="font-size:11px;color:var(--muted)">${titulo}</div><div style="font-size:18px;font-weight:600;color:var(--text)">${valor}</div>${extra ? '<div style="font-size:11px;color:var(--muted)">' + extra + '</div>' : ''}</div>`;
  const avisos = (j.avisos || []).map((a) => `<div style="border-left:3px solid ${cor};background:var(--bg3);padding:8px 12px;border-radius:6px;margin-top:8px;font-size:13px;color:var(--text)">${_custoEsc(a)}</div>`).join('');
  document.getElementById('custo-resumo').innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap">
      ${caixa('Gasto no mês', _custoUsd(j.total_usd), j.chamadas + ' processamentos')}
      ${caixa(j.corrente ? 'Projeção do mês' : 'Total do mês', _custoUsd(j.projecao_usd), j.corrente ? 'no ritmo atual' : '')}
      ${caixa('Limite do mês', _custoUsd(j.limite_usd), '<span style="color:' + cor + '">' + String(j.percentual_limite).replace('.', ',') + '% usado</span>')}
    </div>
    <div style="height:8px;background:var(--bg3);border-radius:4px;margin-top:10px;overflow:hidden"><div style="height:100%;width:${Math.min(100, j.percentual_limite)}%;background:${cor}"></div></div>${avisos}`;
  const fs = _custoJuntarPorNome(j.por_funcao || []);
  document.getElementById('custo-funcoes').innerHTML = fs.length ? '<table class="table" style="width:100%"><thead><tr><th style="text-align:left">Função</th><th style="text-align:right">Processamentos</th><th style="text-align:right">Custo</th><th style="text-align:right">Parte do mês</th></tr></thead><tbody>' +
    fs.map((f) => `<tr><td>${_custoEsc(f.nome)}</td><td style="text-align:right">${f.chamadas}</td><td style="text-align:right">${_custoUsd(f.custo_usd)}</td><td style="text-align:right">${j.total_usd > 0 ? Math.round(f.custo_usd / j.total_usd * 100) : 0}%</td></tr>`).join('') +
    '</tbody></table>' : '<div class="hint">Nenhum processamento neste mês.</div>';
  const ds = j.por_dia || [];
  const max = Math.max(0.01, ...ds.map((d) => d.custo_usd));
  document.getElementById('custo-dias').innerHTML = ds.length ? ds.map((d) => `<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin:3px 0">
      <span style="width:46px;color:var(--muted)">${_custoEsc(d.dia.slice(8, 10) + '/' + d.dia.slice(5, 7))}</span>
      <div style="flex:1;background:var(--bg3);border-radius:3px;height:12px"><div style="height:100%;width:${Math.round(d.custo_usd / max * 100)}%;background:var(--accent, #4f8cff);border-radius:3px"></div></div>
      <span style="width:90px;text-align:right">${_custoUsd(d.custo_usd)}</span><span style="width:50px;text-align:right;color:var(--muted)">${d.chamadas}</span></div>`).join('') : '<div class="hint">Nenhum processamento neste mês.</div>';
}

// Liga no mesmo ponto em que o menu da Segurança é atualizado (depois de carregar as permissões).
(function () {
  const ligar = () => {
    custoMontar();
    const orig = window.segAtualizarMenu;
    if (typeof orig === 'function' && !orig._custo) {
      const novo = function () { try { orig.apply(this, arguments); } finally { custoAtualizarMenu(); } };
      novo._custo = true;
      window.segAtualizarMenu = novo;
    }
    if (window.USER_PERMS) custoAtualizarMenu();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligar); else ligar();
})();
