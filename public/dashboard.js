// ============================================================
// DASHBOARD E JANELA GERENCIAR CONDOMÍNIO: extraído de public/index.html (T02, só movido, sem mudar
// comportamento). Script clássico: funções e variáveis seguem globais,
// no mesmo escopo do script inline do index.html.
// ============================================================

// Atualiza o card do Dashboard com o condomínio ativo e ajusta o estilo do botão
// de acordo com se há ou não condomínio selecionado.
// Atualiza o card de condomínio ativo no Dashboard.
// Lê de getCondominioAtivo() para garantir que qualquer ponto de
// seleção (Configurações, painel Condomínios, modal do Dashboard) reflita aqui.
function atualizarDashCond() {
  var cond = getCondominioAtivo();
  var nome = cond ? cond.nome : '—';
  // NUNCA mostrar UUID do Supabase quando há id_superlogica disponível
  var idText = '';
  if (cond) {
    idText = cond.id_superlogica
      ? 'ID Superlógica: ' + cond.id_superlogica
      : 'ID: ' + cond.id;
  }
  var nEl = document.getElementById('dash-cond-nome');
  var iEl = document.getElementById('dash-cond-id');
  if (nEl) nEl.textContent = nome;
  if (iEl) iEl.textContent = idText;
  // Ajusta botão: primário quando nenhum cond ativo, ghost quando já há seleção
  var btnGer = document.getElementById('btn-gerenciar-cond');
  if (btnGer) {
    if (cond) {
      btnGer.classList.remove('btn-primary');
      btnGer.classList.add('btn-ghost');
      btnGer.textContent = 'Trocar ou cadastrar';
    } else {
      btnGer.classList.remove('btn-ghost');
      btnGer.classList.add('btn-primary');
      btnGer.textContent = 'Selecionar ou cadastrar';
    }
  }
}

// Busca condominio no modal do Dashboard direto no Supabase via supaFetch.
// Nao chama Superlogica/proxy para nao expor tokens no frontend.
async function searchCondominioDash(query) {
  const dd = document.getElementById('dash-modal-cond-dropdown');
  if (!dd) return;
  const q = (query || '').trim();
  if (q.length < 2) {
    dd.classList.remove('open');
    dd.innerHTML = '';
    return;
  }
  // Escape local para atributos HTML e innerHTML: evita XSS via dados da planilha/API
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Busca direto no Supabase. Erro silencioso resulta em "Nenhum condominio encontrado" na UI.
  let resultados = [];
  try {
    const supaQ = encodeURIComponent('*' + q + '*');
    const r = await supaFetch('condominios?select=id,nome,id_superlogica&nome=ilike.' + supaQ + '&order=nome.asc&limit=15');
    if (Array.isArray(r)) resultados = r;
  } catch (e) {
  }

  if (resultados.length === 0) {
    dd.innerHTML = '<div class="cond-option" style="opacity:.7;cursor:default">Nenhum condomínio encontrado</div>';
    dd.classList.add('open');
    return;
  }

  dd.innerHTML = resultados.slice(0, 15).map(c => {
    const id = esc(c.id);
    const nome = esc(c.nome);
    const idSup = c.id_superlogica != null ? esc(c.id_superlogica) : '';
    return '<div class="cond-option" data-id="' + id + '" data-nome="' + nome + '" data-id-superlogica="' + idSup + '">'
      + '<span class="cond-name">' + nome + '</span>'
      + (idSup ? '<span class="cond-id">' + idSup + '</span>' : '')
      + '</div>';
  }).join('');
  dd.classList.add('open');

  // Event delegation: registra o listener uma única vez no pai para evitar duplicatas
  if (!dd._listenerAdded) {
    dd.addEventListener('click', function (ev) {
      const opt = ev.target.closest('.cond-option');
      if (!opt || !opt.dataset.id) return;
      selecionarCondominioDash(opt.dataset.id, opt.dataset.nome, opt.dataset.idSuperlogica || null);
    });
    dd._listenerAdded = true;
  }
}

// Seleciona condomínio via modal do Dashboard e fecha o modal em seguida.
// NÃO chama selecionarCondominio para não disparar efeitos colaterais
// do painel Configurações (cfg-cond-id, cond-search-input, cond-selected-wrap).
function selecionarCondominioDash(id, nome, idSup) {
  var dd = document.getElementById('dash-modal-cond-dropdown');
  if (dd) { dd.classList.remove('open'); dd.innerHTML = ''; }
  var inp = document.getElementById('dash-modal-cond-search');
  if (inp) inp.value = nome;
  // setCondominioAtivo sincroniza state.config, localStorage e banners.
  // Importante: state.config.condId recebe id_superlogica (numerico) dentro de setCondominioAtivo.
  setCondominioAtivo({ id: id, nome: nome, id_superlogica: idSup ? Number(idSup) : null });
  // Sincroniza o hidden do painel Configurações com o ID Superlógica (numérico),
  // não o UUID Supabase, para que saveConfig não regrave UUID como condId.
  var hiddenDash = document.getElementById('cfg-cond-id');
  if (hiddenDash) hiddenDash.value = idSup || '';
  dashFecharModalGerenciarCond();
  toast('Condominio selecionado: ' + nome, 'ok');
}

// Abre o modal unificado de gerenciamento de condomínio, sempre na aba Buscar.
function dashAbrirModalGerenciarCond() {
  const m = document.getElementById('dash-modal-gerenciar-cond');
  if (!m) return;
  document.getElementById('dash-modal-nome-cond').value = '';
  document.getElementById('dash-modal-id-superlogica').value = '';
  document.getElementById('dash-modal-cond-search').value = '';
  document.getElementById('dash-modal-cond-dropdown').innerHTML = '';
  document.getElementById('dash-modal-cond-dropdown').classList.remove('open');
  // Sempre começa na aba Buscar para evitar cadastro acidental
  dashModalSetTab('buscar');
  // Hint mostra condomínio atualmente ativo para o usuário saber o que está selecionado.
  // Usa getCondominioAtivo() para ter acesso ao id_superlogica real (não UUID).
  const hint = document.getElementById('dash-modal-cond-ativo-hint');
  if (hint) {
    const condAtual = getCondominioAtivo();
    if (condAtual && condAtual.nome) {
      const labelId = condAtual.id_superlogica
        ? ' (ID Superlógica: ' + condAtual.id_superlogica + ')'
        : '';
      hint.textContent = 'Ativo: ' + condAtual.nome + labelId;
    } else {
      hint.textContent = 'Nenhum condomínio ativo no momento.';
    }
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
  const nome = (document.getElementById('dash-modal-nome-cond').value || '').trim();
  const idSupRaw = (document.getElementById('dash-modal-id-superlogica').value || '').trim();
  if (!nome) { toast('Informe o nome do condomínio.', 'err'); return; }
  if (!idSupRaw || !/^[0-9]+$/.test(idSupRaw) || parseInt(idSupRaw, 10) <= 0) {
    toast('ID Superlógica deve ser um número inteiro positivo.', 'err');
    return;
  }
  const idSuperlogica = parseInt(idSupRaw, 10);
  // UUID gerado no cliente porque a coluna id é NOT NULL sem default no Supabase.
  // sindico: null evita violação NOT NULL caso a coluna seja NOT NULL sem default.
  // Fallback para browsers que não suportam crypto.randomUUID (ex: HTTP sem TLS)
  const novoId = (window.crypto && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : 'cond-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  const payload = { id: novoId, nome, sindico: null, id_superlogica: idSuperlogica, criado_em: new Date().toISOString() };
  // Usa supaFetchRich para expor o erro real ao usuário (RLS, schema, constraint, etc.)
  const ret = await supaFetchRich('condominios', { method: 'POST', body: JSON.stringify(payload) });
  if (!ret.ok) {
    console.error('[supabase] erro ao salvar condominio:', ret);
    toast('Erro Supabase ' + ret.status + ': ' + ret.detail, 'err');
    return;
  }
  const dados = ret.data;
  if (!dados || (Array.isArray(dados) && dados.length === 0)) {
    toast('Falha ao salvar condomínio.', 'err');
    return;
  }
  const novo = Array.isArray(dados) ? dados[0] : dados;
  // Auto-selecionar como condomínio ativo usando setCondominioAtivo
  // para garantir sincronização com localStorage, state.config e banners
  const idSupFinal = novo.id_superlogica != null ? novo.id_superlogica : idSuperlogica;
  setCondominioAtivo({ id: novo.id, nome: novo.nome, id_superlogica: idSupFinal });
  // Sincroniza o hidden do painel Configurações com o ID Superlógica (numérico),
  // não o UUID Supabase, para que saveConfig não regrave UUID como condId.
  const hiddenNew = document.getElementById('cfg-cond-id');
  if (hiddenNew) hiddenNew.value = idSupFinal || '';
  dashFecharModalGerenciarCond();
  toast('Condominio cadastrado e selecionado: ' + novo.nome, 'ok');
}

