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
  document.getElementById('dash-modal-nome-cond').value = '';
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

