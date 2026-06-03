// ============================================================
// PREVISAO ORCAMENTARIA — Fase 2
// Frontend que recebe PDFs W011A/W045A, chama POST /api/previsao/extrair-pdfs
// via apiAuthFetch e renderiza a planilha de 8 grupos com drill-down,
// reajuste editavel por grupo e download em CSV.
//
// Backend: microservico FastAPI (services/previsao-api/) -> proxy server.js.
// Schema do response: PrevisaoResponse em services/previsao-api/app/schemas.py.
// ============================================================

// State global do modulo
var previsaoState = {
  arquivos: [],          // [{ file: File, tipo: 'w011a'|'w045a'|'desconhecido' }]
  resposta: null,        // PrevisaoResponse parseado
  reajustes: {},         // { [grupoId]: float decimal, ex: 0.05 = 5% }
  gruposExpandidos: {},
  fracoesVisiveis: false,
  ultimoHashSalvo: null,  // hash MD5 retornado pelo servidor no ultimo save bem-sucedido
  rascunhoId: null,       // UUID do rascunho persistido (null ate o primeiro save)
  salvandoRascunho: false, // mutex para evitar saves concorrentes
  gerandoArquivos: false,
  configRateio: { apartamentos: null, coberturas: 0, fator_cobertura: 1.5, fundo_reserva: 0, fundo_pct: 0.05 },
  ultimaGeracao: null
};

// === Ouvinte de troca de condominio (no topo, fora de funcao) ===
// O evento condominioAtivo:changed e disparado em window (index.html), nao em document.
window.addEventListener('condominioAtivo:changed', function() {
  previsaoOnCondominioChange();
});

// === Ouvinte de auth pronta ===
// O auth-bootstrap.js dispara auth:ready em document quando window.AUTH_TOKEN esta
// setado. Sem isso, a primeira chamada a previsaoCarregarRascunhos (via restorePanel
// no boot) sai sem Bearer e o /api/previsao/listar retorna 401, escondendo o card.
// Quando auth fica pronta, se o painel ativo for previsao, recarrega rascunhos.
document.addEventListener('auth:ready', function() {
  var painel = document.getElementById('panel-previsao');
  if (!painel || !painel.classList.contains('active')) return;
  var cond = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
  if (cond && cond.id) previsaoCarregarRascunhos(cond.id);
});

// Autosave ao fechar ou recarregar a aba. Nao bloqueia o unload (best-effort).
window.addEventListener('beforeunload', previsaoAutosaveAoSairDoPainel);

// Chamado pelo showPanel('previsao') a cada abertura do painel.
function previsaoInit() {
  if (typeof renderBannerCondAtivo === 'function') {
    renderBannerCondAtivo('previsao');
  }
  previsaoAtualizarFallback();
  previsaoAtualizarBotao();
  // Carrega rascunhos salvos do condominio ativo ao abrir o painel
  var cond = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
  if (cond && cond.id) previsaoCarregarRascunhos(cond.id);
  previsaoMostrarConfigRateio();
  previsaoAtualizarBotaoGerar();
  // Listener nos campos de config pra habilitar botao quando aptos preenchido
  var aptosInput = document.getElementById('prev-cfg-aptos');
  if (aptosInput && !aptosInput._previsaoListenerAdded) {
    aptosInput.addEventListener('input', previsaoAtualizarBotaoGerar);
    aptosInput._previsaoListenerAdded = true;
  }
}

function previsaoOnCondominioChange() {
  // Salva rascunho do condominio anterior antes de trocar
  previsaoAutosaveAoSairDoPainel();
  // Limpa state do condominio anterior (mantém apenas campos nao relacionados a dados)
  previsaoState.resposta = null;
  previsaoState.reajustes = {};
  previsaoState.gruposExpandidos = {};
  previsaoState.fracoesVisiveis = false;
  previsaoState.ultimoHashSalvo = null;
  previsaoState.rascunhoId = null;
  previsaoState.salvandoRascunho = false;
  // Oculta resultado anterior
  var box = document.getElementById('prev-resultado');
  if (box) box.style.display = 'none';
  // Banner e fallback sao atualizados pelo setCondominioAtivo e pelo evento.
  previsaoAtualizarFallback();
  // Carrega rascunhos do novo condominio
  var cond = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
  if (cond && cond.id) previsaoCarregarRascunhos(cond.id);
}

// Mostra/oculta o corpo do painel conforme ha condominio ativo.
function previsaoAtualizarFallback() {
  var cond = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
  var corpo = document.getElementById('prev-corpo');
  var fb = document.getElementById('prev-fallback-sem-cond');
  if (!corpo || !fb) return;
  if (cond) {
    corpo.style.display = '';
    fb.style.display = 'none';
  } else {
    corpo.style.display = 'none';
    fb.style.display = '';
  }
}

// === DnD ===
function previsaoOnDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('dragover');
}

function previsaoOnDragLeave(e) {
  if (typeof handleDragLeave === 'function') {
    handleDragLeave(e.currentTarget);
  } else {
    e.currentTarget.classList.remove('dragover');
  }
}

function previsaoOnDrop(e) {
  e.preventDefault();
  previsaoOnDragLeave(e);
  var arquivos = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
  previsaoAdicionarArquivos(arquivos);
}

function previsaoOnFileInput(e) {
  var arquivos = Array.from(e.target.files || []);
  previsaoAdicionarArquivos(arquivos);
  e.target.value = '';
}

// Adiciona arquivos validados ao state. Rejeita nao PDF com toast.
function previsaoAdicionarArquivos(arquivos) {
  var rejeitados = 0;
  arquivos.forEach(function(f) {
    var ok = (f.type === 'application/pdf') || /\.pdf$/i.test(f.name);
    if (!ok) { rejeitados++; return; }
    var tipo = previsaoClassificarArquivo(f);
    previsaoState.arquivos.push({ file: f, tipo: tipo });
  });
  if (rejeitados > 0 && typeof toast === 'function') {
    toast('Somente PDFs sao aceitos. ' + rejeitados + ' arquivo(s) ignorado(s).', 'warn');
  }
  // Se ha somente 1 arquivo no total e esta como desconhecido, assume w011a
  if (previsaoState.arquivos.length === 1 && previsaoState.arquivos[0].tipo === 'desconhecido') {
    previsaoState.arquivos[0].tipo = 'w011a';
  }
  previsaoRenderizarChips();
  previsaoAtualizarBotao();
}

// Heuristica por nome: W011/W045 -> tipo. Caso contrario desconhecido.
function previsaoClassificarArquivo(file) {
  var nome = (file.name || '').toUpperCase();
  if (nome.indexOf('W011') !== -1) return 'w011a';
  if (nome.indexOf('W045') !== -1) return 'w045a';
  return 'desconhecido';
}

// Renderiza chips de cada arquivo adicionado com nome, seletor de tipo e botao remover.
function previsaoRenderizarChips() {
  var box = document.getElementById('prev-chips');
  if (!box) return;
  if (!previsaoState.arquivos.length) { box.innerHTML = ''; return; }
  var esc = previsaoEsc;
  box.innerHTML = previsaoState.arquivos.map(function(item, i) {
    var nome = esc(item.file.name);
    var tamanho = previsaoFormatarTamanho(item.file.size);
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;font-size:12px;font-family:var(--mono)">'
      + '<span style="flex:1;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + nome + '</span>'
      + '<span style="color:var(--muted)">' + tamanho + '</span>'
      + '<select onchange="previsaoTrocarTipoChip(' + i + ', this.value)" '
      + 'style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;font-size:11px;font-family:var(--mono);border-radius:6px">'
      + '<option value="w011a"' + (item.tipo === 'w011a' ? ' selected' : '') + '>W011A</option>'
      + '<option value="w045a"' + (item.tipo === 'w045a' ? ' selected' : '') + '>W045A</option>'
      + '<option value="desconhecido"' + (item.tipo === 'desconhecido' ? ' selected' : '') + '>Identificar</option>'
      + '</select>'
      + '<button onclick="previsaoRemoverArquivo(' + i + ')" '
      + 'style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:2px 6px" title="Remover">x</button>'
      + '</div>';
  }).join('');
}

function previsaoTrocarTipoChip(idx, novoTipo) {
  if (idx < 0 || idx >= previsaoState.arquivos.length) return;
  // Se novoTipo e w011a, reverte qualquer outro arquivo que ja tinha w011a
  if (novoTipo === 'w011a') {
    previsaoState.arquivos.forEach(function(item, i) {
      if (i !== idx && item.tipo === 'w011a') item.tipo = 'desconhecido';
    });
  }
  if (novoTipo === 'w045a') {
    previsaoState.arquivos.forEach(function(item, i) {
      if (i !== idx && item.tipo === 'w045a') item.tipo = 'desconhecido';
    });
  }
  previsaoState.arquivos[idx].tipo = novoTipo;
  previsaoRenderizarChips();
  previsaoAtualizarBotao();
}

function previsaoRemoverArquivo(idx) {
  if (idx < 0 || idx >= previsaoState.arquivos.length) return;
  previsaoState.arquivos.splice(idx, 1);
  previsaoRenderizarChips();
  previsaoAtualizarBotao();
}

function previsaoAtualizarBotao() {
  var btn = document.getElementById('prev-btn-gerar');
  if (!btn) return;
  var temW011 = previsaoState.arquivos.some(function(a) { return a.tipo === 'w011a'; });
  btn.disabled = !temW011;
}

// === Chamada ao proxy ===

// Envia os PDFs selecionados para o microservico de extracao e renderiza a planilha com o resultado.
async function previsaoGerarPlanilha() {
  var arqW011 = previsaoState.arquivos.find(function(a) { return a.tipo === 'w011a'; });
  if (!arqW011) {
    if (typeof toast === 'function') toast('Selecione um arquivo W011A primeiro.', 'err');
    return;
  }
  var arqW045 = previsaoState.arquivos.find(function(a) { return a.tipo === 'w045a'; });

  // Validacao local de tamanho (avisa antes de subir)
  var MAX = 50 * 1024 * 1024;
  if (arqW011.file.size > MAX || (arqW045 && arqW045.file.size > MAX)) {
    if (typeof toast === 'function') toast('Arquivo muito grande. O limite e 50 MB por PDF.', 'err');
    return;
  }

  var btn = document.getElementById('prev-btn-gerar');
  var labelOriginal = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Processando...'; }

  try {
    var fd = new FormData();
    fd.append('w011a', arqW011.file, arqW011.file.name);
    if (arqW045) fd.append('w045a', arqW045.file, arqW045.file.name);

    var resp = await apiAuthFetch('/api/previsao/extrair-pdfs', { method: 'POST', body: fd });

    if (!resp.ok) {
      previsaoTratarErroHttp(resp.status);
      return;
    }
    var json = await resp.json();
    previsaoState.resposta = json;
    previsaoState.reajustes = {};
    previsaoState.gruposExpandidos = {};
    previsaoRenderizarPlanilha(json);
  } catch (err) {
    if (typeof toast === 'function') toast('Sem conexao com o servidor.', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = labelOriginal || 'Gerar Planilha'; }
    previsaoAtualizarBotao();
  }
}

function previsaoTratarErroHttp(status) {
  var msg;
  if (status === 401) msg = 'Sua sessao expirou. Faca login novamente.';
  else if (status === 413) msg = 'Arquivo muito grande. O limite e 50 MB por PDF.';
  else if (status === 422) msg = 'PDF inválido ou não reconhecido como W011A ou W045A do Superlógica.';
  else if (status === 503) msg = 'Servico de previsao temporariamente indisponivel. Tente em alguns minutos.';
  else if (status === 504) msg = 'Tempo esgotado. PDFs muito grandes podem precisar de processamento manual.';
  else msg = 'Erro inesperado (' + status + '). Tente novamente.';
  if (typeof toast === 'function') toast(msg, 'err');
}

// === Render ===

function previsaoRenderizarPlanilha(resp) {
  var box = document.getElementById('prev-resultado');
  if (box) box.style.display = '';
  previsaoRenderizarCabecalho(resp);
  previsaoRenderizarAvisos(resp.avisos || []);
  previsaoRenderizarTabelaGrupos(resp.grupos || []);
  previsaoRenderizarForaGrupo(resp.itens_fora_grupo || []);
  previsaoRenderizarFracoes(resp.fracoes || []);
}

// Preenche o bloco de cabecalho com condominio, periodo, total anual e mensal medio.
function previsaoRenderizarCabecalho(resp) {
  var box = document.getElementById('prev-cabecalho');
  if (!box) return;
  var esc = previsaoEsc;
  box.innerHTML =
    '<div><div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Condomínio</div>'
    + '<div style="font-size:14px;color:var(--text);font-weight:600">' + esc(resp.condominio || '') + '</div></div>'
    + '<div><div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Período</div>'
    + '<div style="font-size:14px;color:var(--text)">' + esc(resp.periodo || '') + '</div></div>'
    + '<div><div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Total anual base</div>'
    + '<div style="font-size:14px;color:var(--text);font-weight:600" id="prev-total-geral-base">' + previsaoFmtBRL(resp.total_geral) + '</div>'
    + '<div style="font-size:11px;color:var(--gs-blue);font-weight:600;margin-top:2px" id="prev-total-geral-novo"></div></div>'
    + '<div><div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Mensal médio</div>'
    + '<div style="font-size:14px;color:var(--text)" id="prev-mensal-medio-base">' + previsaoFmtBRL(resp.total_mensal_medio) + '</div>'
    + '<div style="font-size:11px;color:var(--gs-blue);margin-top:2px" id="prev-mensal-medio-novo"></div></div>';
}

function previsaoRenderizarAvisos(avisos) {
  var box = document.getElementById('prev-avisos');
  if (!box) return;
  if (!avisos.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  var esc = previsaoEsc;
  box.style.display = '';
  box.innerHTML = '<div class="card-header"><span class="card-title" style="color:rgb(214,158,46)">Avisos do parser</span></div>'
    + avisos.map(function(a) {
        return '<p style="font-size:12px;color:var(--text);margin:6px 0">Atenção: ' + esc(a) + '</p>';
      }).join('');
}

// Renderiza a tabela principal de grupos orcamentarios com campos de reajuste editaveis.
function previsaoRenderizarTabelaGrupos(grupos) {
  var tbl = document.getElementById('prev-tabela');
  if (!tbl) return;
  var esc = previsaoEsc;
  var html = '<thead><tr style="border-bottom:2px solid var(--border)">'
    + '<th style="text-align:left;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Grupo</th>'
    + '<th style="text-align:right;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Anual base</th>'
    + '<th style="text-align:center;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Reajuste %</th>'
    + '<th style="text-align:right;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Novo total</th>'
    + '<th style="text-align:right;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Peso</th>'
    + '</tr></thead><tbody>';
  grupos.forEach(function(g) {
    var vazio = !g.total_anual || g.total_anual === 0;
    html += '<tr class="prev-grupo-row" data-grupo-id="' + esc(g.id) + '" '
      + 'style="border-bottom:1px solid var(--border)' + (vazio ? ';opacity:.55' : '') + '">'
      + '<td style="padding:10px 6px;cursor:pointer" onclick="previsaoToggleGrupo(\'' + esc(g.id) + '\')">'
      + '<span class="prev-caret" id="prev-caret-' + esc(g.id) + '" style="display:inline-block;width:14px;color:var(--muted)">▶</span> '
      + '<span style="font-weight:600;color:var(--text)">' + esc(g.nome) + '</span>'
      + '<div style="font-size:10px;color:var(--muted);margin-top:2px;margin-left:18px">' + esc(g.descritivo || '') + '</div>'
      + '</td>'
      + '<td style="text-align:right;padding:10px 6px;font-family:var(--mono)">' + previsaoFmtBRL(g.total_anual) + '</td>'
      + '<td style="text-align:center;padding:10px 6px">'
      + '<span class="prev-reajuste-input" contenteditable="true" '
      + 'data-grupo-id="' + esc(g.id) + '" '
      + 'onblur="previsaoEditarReajuste(\'' + esc(g.id) + '\', this.textContent)" '
      + 'onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.blur();}" '
      + 'onfocus="if(window.getSelection){var r=document.createRange();r.selectNodeContents(this);var s=window.getSelection();s.removeAllRanges();s.addRange(r);}" '
      + 'style="display:inline-block;min-width:60px;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-family:var(--mono);font-size:12px;cursor:text">0,0%</span>'
      + '</td>'
      + '<td style="text-align:right;padding:10px 6px;font-family:var(--mono);color:var(--gs-blue);font-weight:600" id="prev-novo-' + esc(g.id) + '">' + previsaoFmtBRL(g.total_anual) + '</td>'
      + '<td style="text-align:right;padding:10px 6px;font-family:var(--mono);color:var(--muted)">' + previsaoFmtPct((g.peso_pct || 0) * 100, 1) + '</td>'
      + '</tr>';
  });
  html += '</tbody>';
  tbl.innerHTML = html;
}

// Expande ou colapsa as subcategorias de um grupo, inserindo linhas em ordem correta.
function previsaoToggleGrupo(grupoId) {
  if (!previsaoState.resposta) return;
  var expandido = !!previsaoState.gruposExpandidos[grupoId];
  previsaoState.gruposExpandidos[grupoId] = !expandido;
  var caret = document.getElementById('prev-caret-' + grupoId);
  if (caret) caret.textContent = expandido ? '▶' : '▼';

  // Limpa qualquer linha de subcategoria existente desse grupo
  var tbody = document.querySelector('#prev-tabela tbody');
  if (!tbody) return;
  tbody.querySelectorAll('tr.prev-subrow[data-grupo-id="' + grupoId + '"]').forEach(function(tr) { tr.remove(); });

  if (expandido) return; // estava aberto, agora fechou

  // Insere subcategorias logo abaixo da linha do grupo
  var grupo = previsaoState.resposta.grupos.find(function(g) { return g.id === grupoId; });
  if (!grupo || !grupo.subcategorias || !grupo.subcategorias.length) return;
  var grupoRow = tbody.querySelector('tr.prev-grupo-row[data-grupo-id="' + grupoId + '"]');
  if (!grupoRow) return;
  var esc = previsaoEsc;
  // referencia movente: garante que cada subcategoria e inserida APOS a anterior, mantendo a ordem correta
  var referencia = grupoRow;
  grupo.subcategorias.forEach(function(sub) {
    var rateioLabel = sub.rateio === 'uso-real' ? 'por uso' : 'por fração';
    var tr = document.createElement('tr');
    tr.className = 'prev-subrow';
    tr.setAttribute('data-grupo-id', grupoId);
    tr.style.background = 'var(--bg3)';
    tr.innerHTML =
      '<td style="padding:8px 6px 8px 28px">'
      + '<div style="font-size:12px;color:var(--text)">' + esc(sub.nome) + '</div>'
      + '<div style="font-size:10px;color:var(--muted);margin-top:2px">' + esc(sub.descritivo || '') + '</div></td>'
      + '<td style="text-align:right;padding:8px 6px;font-family:var(--mono);font-size:11px">' + previsaoFmtBRL(sub.total_anual) + '</td>'
      + '<td style="text-align:center;padding:8px 6px;font-size:10px;color:var(--muted);font-family:var(--mono)">' + rateioLabel + '</td>'
      + '<td></td><td></td>';
    referencia.parentNode.insertBefore(tr, referencia.nextSibling);
    referencia = tr;
  });
}

function previsaoEditarReajuste(grupoId, texto) {
  var val = previsaoNormalizarReajuste(texto);
  previsaoState.reajustes[grupoId] = val;
  var span = document.querySelector('.prev-reajuste-input[data-grupo-id="' + grupoId + '"]');
  if (span) span.textContent = previsaoFmtPct(val * 100, 1);
  previsaoRecalcular();
}

function previsaoNormalizarReajuste(str) {
  if (str == null) return 0;
  var s = String(str).trim().replace('%', '').replace(',', '.');
  var n = parseFloat(s);
  if (isNaN(n)) return 0;
  return n / 100;
}

function previsaoRecalcular() {
  if (!previsaoState.resposta) return;
  var totalNovo = 0;
  previsaoState.resposta.grupos.forEach(function(g) {
    var r = previsaoState.reajustes[g.id] || 0;
    var novo = (g.total_anual || 0) * (1 + r);
    totalNovo += novo;
    var cel = document.getElementById('prev-novo-' + g.id);
    if (cel) cel.textContent = previsaoFmtBRL(novo);
  });
  var base = previsaoState.resposta.total_geral || 0;
  var cabNovo = document.getElementById('prev-total-geral-novo');
  var mensalNovo = document.getElementById('prev-mensal-medio-novo');
  if (cabNovo) {
    if (Math.abs(totalNovo - base) < 0.01) cabNovo.textContent = '';
    else cabNovo.textContent = 'Ajustado: ' + previsaoFmtBRL(totalNovo);
  }
  if (mensalNovo) {
    if (Math.abs(totalNovo - base) < 0.01) mensalNovo.textContent = '';
    else mensalNovo.textContent = 'Ajustado: ' + previsaoFmtBRL(totalNovo / 12);
  }
}

// Renderiza a secao de itens que nao foram classificados em nenhum grupo orcamentario.
function previsaoRenderizarForaGrupo(itens) {
  var sec = document.getElementById('prev-secao-fora-grupo');
  var tbl = document.getElementById('prev-tabela-fora-grupo');
  if (!sec || !tbl) return;
  if (!itens.length) { sec.style.display = 'none'; tbl.innerHTML = ''; return; }
  sec.style.display = '';
  var esc = previsaoEsc;
  var motivoLabel = function(m) {
    if (m === 'divida-especifica') return 'Dívida específica';
    if (m === 'obra-extraordinaria') return 'Obra extraordinária';
    return 'Não classificado';
  };
  var html = '<thead><tr style="border-bottom:2px solid var(--border)">'
    + '<th style="text-align:left;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Data</th>'
    + '<th style="text-align:left;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Descrição</th>'
    + '<th style="text-align:right;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Valor</th>'
    + '<th style="text-align:left;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Motivo</th>'
    + '</tr></thead><tbody>';
  itens.forEach(function(it) {
    html += '<tr style="border-bottom:1px solid var(--border)">'
      + '<td style="padding:8px 6px;font-family:var(--mono);font-size:11px">' + esc(it.data) + '</td>'
      + '<td style="padding:8px 6px;font-size:12px">' + esc(it.descricao) + '</td>'
      + '<td style="padding:8px 6px;text-align:right;font-family:var(--mono);font-size:11px">' + previsaoFmtBRL(it.valor) + '</td>'
      + '<td style="padding:8px 6px;font-size:11px;color:var(--muted)">' + motivoLabel(it.motivo) + '</td>'
      + '</tr>';
  });
  html += '</tbody>';
  tbl.innerHTML = html;
}

// Renderiza o resumo e a lista detalhada de fracoes ideais das unidades do condominio.
function previsaoRenderizarFracoes(fracoes) {
  var resumo = document.getElementById('prev-fracoes-resumo');
  var lista = document.getElementById('prev-fracoes-lista');
  if (!resumo || !lista) return;
  var n = fracoes.length;
  var soma = fracoes.reduce(function(s, f) { return s + (f.fracao || 0); }, 0);
  resumo.textContent = n + ' unidades. Soma: ' + soma.toFixed(6).replace('.', ',');
  var esc = previsaoEsc;
  var html = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="border-bottom:1px solid var(--border)">'
    + '<th style="text-align:left;padding:6px;color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase">Unidade</th>'
    + '<th style="text-align:right;padding:6px;color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase">Fração</th></tr></thead><tbody>';
  fracoes.forEach(function(f) {
    html += '<tr style="border-bottom:1px solid var(--border)">'
      + '<td style="padding:6px;font-family:var(--mono);font-size:11px">' + esc(f.unidade) + '</td>'
      + '<td style="padding:6px;text-align:right;font-family:var(--mono);font-size:11px">' + (f.fracao || 0).toFixed(6).replace('.', ',') + '</td>'
      + '</tr>';
  });
  html += '</tbody></table>';
  lista.innerHTML = html;
}

function previsaoToggleFracoes() {
  previsaoState.fracoesVisiveis = !previsaoState.fracoesVisiveis;
  var lista = document.getElementById('prev-fracoes-lista');
  var btn = document.getElementById('prev-btn-toggle-fracoes');
  if (lista) lista.style.display = previsaoState.fracoesVisiveis ? '' : 'none';
  if (btn) btn.textContent = previsaoState.fracoesVisiveis ? 'Ocultar lista de frações' : 'Ver lista de frações';
}

// === Download CSV ===

// Protege campos do CSV contra injecao de formula no Excel.
// Se a string comeca com =, +, -, @, tab ou CR, prefixa com apostrofo
// para o Excel interpretar como texto literal.
function previsaoCsvSafe(s) {
  if (s == null) return '';
  var str = String(s);
  if (/^[=+\-@\t\r]/.test(str)) return "'" + str;
  return str;
}

// Gera e dispara o download de um arquivo CSV com BOM UTF-8 e CRLF (compativel com Excel BR).
function previsaoBaixarCSV() {
  if (!previsaoState.resposta) return;
  var r = previsaoState.resposta;
  var sep = ';';
  var linhas = [];
  linhas.push('Condomínio' + sep + previsaoCsvSafe(r.condominio));
  linhas.push('Período' + sep + previsaoCsvSafe(r.periodo));
  linhas.push('Total anual base' + sep + (r.total_geral || 0).toFixed(2).replace('.', ','));
  var totalNovo = (r.grupos || []).reduce(function(s, g) {
    var rj = previsaoState.reajustes[g.id] || 0;
    return s + (g.total_anual || 0) * (1 + rj);
  }, 0);
  linhas.push('Total anual ajustado' + sep + totalNovo.toFixed(2).replace('.', ','));
  linhas.push('Mensal médio base' + sep + (r.total_mensal_medio || 0).toFixed(2).replace('.', ','));
  linhas.push('');
  linhas.push(['Grupo', 'Total anual', 'Reajuste %', 'Novo total', 'Peso %'].join(sep));
  (r.grupos || []).forEach(function(g) {
    var rj = previsaoState.reajustes[g.id] || 0;
    var novo = (g.total_anual || 0) * (1 + rj);
    linhas.push([
      previsaoCsvSafe(g.nome),
      (g.total_anual || 0).toFixed(2).replace('.', ','),
      (rj * 100).toFixed(1).replace('.', ','),
      novo.toFixed(2).replace('.', ','),
      ((g.peso_pct || 0) * 100).toFixed(1).replace('.', ',')
    ].join(sep));
    (g.subcategorias || []).forEach(function(sub) {
      var rateioLabel = sub.rateio === 'uso-real' ? 'por uso' : 'por fração';
      linhas.push([
        '  ' + previsaoCsvSafe(sub.nome),
        (sub.total_anual || 0).toFixed(2).replace('.', ','),
        rateioLabel,
        '',
        ''
      ].join(sep));
    });
  });
  // BOM UTF-8 para Excel BR reconhecer acentuacao; CRLF para compatibilidade Windows/Excel
  var conteudo = '﻿' + linhas.join('\r\n');
  var nomeArq = 'previsao_' + (r.condominio || 'condominio').replace(/[^a-zA-Z0-9]+/g, '_') + '_'
    + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.csv';
  var blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = nomeArq;
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

// === Limpar ===
function previsaoLimpar() {
  previsaoState.arquivos = [];
  previsaoState.resposta = null;
  previsaoState.reajustes = {};
  previsaoState.gruposExpandidos = {};
  previsaoState.fracoesVisiveis = false;
  previsaoState.ultimoHashSalvo = null;
  previsaoState.rascunhoId = null;
  previsaoState.salvandoRascunho = false;
  var box = document.getElementById('prev-resultado');
  if (box) box.style.display = 'none';
  previsaoRenderizarChips();
  previsaoAtualizarBotao();
}

// === Helpers ===
function previsaoFormatarTamanho(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function previsaoFmtBRL(valor) {
  if (valor === null || valor === undefined || isNaN(valor)) return 'R$ 0,00';
  var s = Math.abs(Number(valor)).toFixed(2);
  var partes = s.split('.');
  var inteiros = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  var decimais = partes[1];
  var sinal = Number(valor) < 0 ? '-' : '';
  return sinal + 'R$ ' + inteiros + ',' + decimais;
}

function previsaoFmtPct(valor, casas) {
  if (valor === null || valor === undefined || isNaN(valor)) return '0,0%';
  var c = (casas === undefined) ? 1 : casas;
  return Number(valor).toFixed(c).replace('.', ',') + '%';
}

function previsaoEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// PERSISTENCIA — Fase 3: salvar/carregar/retomar rascunhos
// ============================================================

// Extrai o ano de referencia do campo periodo (ex: "Jan/2026 a Dez/2026" => 2026).
// Pega o ultimo grupo de 4 digitos na string. Fallback: ano corrente.
function previsaoExtrairAnoReferencia(periodo) {
  if (!periodo) return new Date().getFullYear();
  var m = String(periodo).match(/(\d{4})\s*$/);
  if (m) return parseInt(m[1], 10);
  // Tenta qualquer grupo de 4 digitos
  var qualquer = String(periodo).match(/\d{4}/g);
  if (qualquer && qualquer.length) return parseInt(qualquer[qualquer.length - 1], 10);
  return new Date().getFullYear();
}

// Monta o payload completo para salvar, incluindo reajustes_aplicados e config_rateio
// dentro do objeto. Ambos entram no JSON para que o hash reflita mudancas neles e
// para que o retomar restaure o estado completo (incluindo apartamentos do rateio).
function previsaoMontarPayloadParaSalvar() {
  if (!previsaoState.resposta) return null;
  // Le os inputs do form de rateio (se visiveis) antes de salvar, garantindo que o
  // payload reflita o estado atual da UI mesmo sem o usuario ter clicado em Gerar.
  if (document.getElementById('prev-cfg-aptos')) previsaoLerConfigRateio();
  return Object.assign({}, previsaoState.resposta, {
    reajustes_aplicados: Object.assign({}, previsaoState.reajustes),
    config_rateio: Object.assign({}, previsaoState.configRateio)
  });
}

// Salva o rascunho atual no servidor via POST /api/previsao/salvar-rascunho.
// Trata os tres estados possiveis: sem_alteracoes, atualizado, criado.
async function previsaoSalvarRascunho(silencioso) {
  var cond = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
  if (!cond || !cond.id) {
    if (typeof toast === 'function') toast('Selecione um condominio antes de salvar.', 'warn');
    return;
  }
  if (!previsaoState.resposta) {
    if (!silencioso && typeof toast === 'function') toast('Gere a planilha antes de salvar.', 'warn');
    return;
  }
  if (previsaoState.salvandoRascunho) return;
  previsaoState.salvandoRascunho = true;

  var payload = previsaoMontarPayloadParaSalvar();
  var periodo = (previsaoState.resposta && previsaoState.resposta.periodo) || '';
  var anoRef = previsaoExtrairAnoReferencia(periodo);

  var btn = document.getElementById('prev-btn-salvar');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

  try {
    var resp = await apiAuthFetch('/api/previsao/salvar-rascunho', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        condominio_id: cond.id,
        ano_referencia: anoRef,
        periodo: periodo,
        payload_json: payload
      })
    });
    if (!resp.ok) {
      if (!silencioso && typeof toast === 'function') toast('Erro ao salvar rascunho. Tente novamente.', 'err');
      return;
    }
    var data = await resp.json();
    previsaoState.ultimoHashSalvo = data.payload_hash || null;
    if (data.id) previsaoState.rascunhoId = data.id;
    // Exibe config de rateio e habilita botao de geracao apos primeiro save bem-sucedido
    previsaoMostrarConfigRateio();
    previsaoAtualizarBotaoGerar();
    if (data.status === 'sem_alteracoes') {
      if (!silencioso && typeof toast === 'function') toast('Sem alteracoes desde o ultimo salvamento.', 'info');
    } else if (data.status === 'atualizado') {
      if (!silencioso && typeof toast === 'function') toast('Rascunho atualizado.', 'ok');
    } else {
      if (!silencioso && typeof toast === 'function') toast('Rascunho salvo.', 'ok');
    }
  } catch (err) {
    if (!silencioso && typeof toast === 'function') toast('Sem conexao ao salvar.', 'err');
  } finally {
    previsaoState.salvandoRascunho = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Salvar Rascunho'; }
  }
}

// Busca lista de rascunhos do condominioId e renderiza um card de retomada destacado.
// Em caso de erro de rede ou 401 (token ainda nao pronto), loga no console mas nao
// quebra a UI; o listener de auth:ready re-chama essa funcao quando o token estiver pronto.
async function previsaoCarregarRascunhos(condominioId) {
  var secao = document.getElementById('prev-secao-rascunhos');
  if (!secao) return;
  try {
    var resp = await apiAuthFetch('/api/previsao/listar?condominio_id=' + encodeURIComponent(condominioId));
    if (!resp.ok) {
      console.warn('[previsao] /listar retornou HTTP', resp.status, '(token ainda nao pronto?)');
      secao.style.display = 'none';
      return;
    }
    var lista = await resp.json();
    console.log('[previsao] rascunhos encontrados:', Array.isArray(lista) ? lista.length : 0);
    if (!Array.isArray(lista) || !lista.length) {
      secao.style.display = 'none';
      secao.innerHTML = '';
      return;
    }
    var esc = previsaoEsc;
    // Card de destaque: usa o mais recente (lista vem ordenada desc por atualizado_em).
    var r = lista[0];
    var dataStr = '';
    if (r.atualizado_em) {
      var d = new Date(r.atualizado_em);
      dataStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
    }
    var periodoStr = r.periodo ? esc(r.periodo) : '';
    var html = ''
      + '<div style="background:var(--gs-blue-light);border:1px solid var(--gs-blue-mid);'
      + 'border-radius:12px;padding:16px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">'
      + '<div style="flex:1;min-width:220px">'
      + '<div style="font-size:11px;font-family:var(--mono);color:var(--gs-blue);'
      + 'text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Rascunho encontrado</div>'
      + '<div style="font-size:14px;font-weight:600;color:var(--text)">Previsao ' + esc(String(r.ano_referencia))
      + (periodoStr ? ' &middot; ' + periodoStr : '') + '</div>'
      + '<div style="font-size:11px;color:var(--muted);margin-top:2px">Salvo em ' + esc(dataStr) + '</div>'
      + '</div>'
      + '<div style="display:flex;gap:8px">'
      + '<button onclick="previsaoRetomarRascunho(\'' + esc(r.id) + '\')" '
      + 'style="padding:8px 18px;background:var(--gs-blue);color:#fff;border:none;'
      + 'border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">Retomar</button>'
      + '<button onclick="previsaoCriarNovo()" '
      + 'style="padding:8px 18px;background:transparent;color:var(--gs-blue);border:1px solid var(--gs-blue-mid);'
      + 'border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">Criar novo</button>'
      + '</div>'
      + '</div>';
    secao.style.display = '';
    secao.innerHTML = html;
  } catch (e) {
    console.error('[previsao] erro ao carregar rascunhos:', e);
    secao.style.display = 'none';
  }
}

// Fecha o card de rascunho e foca o dropzone de upload (criar previsao do zero).
function previsaoCriarNovo() {
  var secao = document.getElementById('prev-secao-rascunhos');
  if (secao) { secao.style.display = 'none'; secao.innerHTML = ''; }
  var dz = document.getElementById('prev-dropzone');
  if (dz && typeof dz.scrollIntoView === 'function') {
    dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Busca um rascunho pelo ID, hidrata o state e renderiza a tabela.
async function previsaoRetomarRascunho(id) {
  try {
    var resp = await apiAuthFetch('/api/previsao/rascunho/' + encodeURIComponent(id));
    if (!resp.ok) {
      if (typeof toast === 'function') toast('Rascunho nao encontrado ou sem acesso.', 'err');
      return;
    }
    var reg = await resp.json();
    if (!reg || !reg.payload_json) {
      if (typeof toast === 'function') toast('Rascunho sem dados.', 'warn');
      return;
    }
    var payload = reg.payload_json;
    // Extrai campos auxiliares (reajustes + config_rateio) do payload e separa do restante
    var reajustes = payload.reajustes_aplicados || {};
    var configSalvo = payload.config_rateio || null;
    // Remove os campos auxiliares antes de hidratar resposta (nao fazem parte do schema FastAPI)
    var resposta = Object.assign({}, payload);
    delete resposta.reajustes_aplicados;
    delete resposta.config_rateio;
    previsaoState.resposta = resposta;
    previsaoState.reajustes = reajustes;
    previsaoState.gruposExpandidos = {};
    previsaoState.fracoesVisiveis = false;
    previsaoState.ultimoHashSalvo = reg.payload_hash || null;
    previsaoState.rascunhoId = reg.id;
    previsaoState.salvandoRascunho = false;
    // Restaura config_rateio salvo (preserva defaults se vier vazio/parcial)
    if (configSalvo) {
      var c = previsaoState.configRateio;
      if (configSalvo.apartamentos != null) c.apartamentos = configSalvo.apartamentos;
      if (configSalvo.coberturas != null) c.coberturas = configSalvo.coberturas;
      if (configSalvo.fator_cobertura != null) c.fator_cobertura = configSalvo.fator_cobertura;
      if (configSalvo.fundo_reserva != null) c.fundo_reserva = configSalvo.fundo_reserva;
      if (configSalvo.fundo_pct != null) c.fundo_pct = configSalvo.fundo_pct;
    }
    // Renderiza a planilha com os dados do rascunho
    previsaoRenderizarPlanilha(resposta);
    // Reaplica os reajustes salvos nos inputs e recalcula totais
    previsaoReaplicarReajustesNaTela();
    // Mostra config de rateio (precisa estar visivel antes de popular inputs)
    previsaoMostrarConfigRateio();
    // Popula os 5 inputs do form de rateio com os valores restaurados do state
    previsaoPopularInputsConfigRateio();
    // Atualiza estado do botao de geracao (habilita se config_rateio veio com apartamentos salvos)
    previsaoAtualizarBotaoGerar();
    if (typeof toast === 'function') toast('Rascunho retomado.', 'ok');
  } catch (err) {
    if (typeof toast === 'function') toast('Erro ao retomar rascunho.', 'err');
  }
}

// Popula os campos de reajuste na tela com os valores do state.reajustes e dispara recalculo.
// Chamado apos previsaoRenderizarPlanilha quando vem de um rascunho salvo.
function previsaoReaplicarReajustesNaTela() {
  var inputs = document.querySelectorAll('.prev-reajuste-input[data-grupo-id]');
  inputs.forEach(function(el) {
    var grupoId = el.getAttribute('data-grupo-id');
    var val = previsaoState.reajustes[grupoId] || 0;
    el.textContent = previsaoFmtPct(val * 100, 1);
  });
  previsaoRecalcular();
}

// Dispara salvamento silencioso ao sair do painel ou fechar a aba.
// Nao exibe toast (o usuario esta saindo) e nao bloqueia o evento.
function previsaoAutosaveAoSairDoPainel() {
  if (!previsaoState.resposta || previsaoState.salvandoRascunho) return;
  // Verifica se ha condominio ativo antes de tentar salvar
  var cond = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
  if (!cond || !cond.id) return;
  previsaoSalvarRascunho(true);
}

// ============================================================
// GERACAO DE ARQUIVOS - Fase 4: PPTX + PDF via microservico
// ============================================================

// Atualiza state.configRateio lendo os inputs do formulario de rateio.
function previsaoLerConfigRateio() {
  var c = previsaoState.configRateio;
  c.apartamentos = parseInt(document.getElementById('prev-cfg-aptos').value, 10) || null;
  c.coberturas = parseInt(document.getElementById('prev-cfg-cob').value, 10) || 0;
  c.fator_cobertura = parseFloat(document.getElementById('prev-cfg-fator').value) || 1.5;
  c.fundo_reserva = parseFloat(document.getElementById('prev-cfg-fundo').value) || 0;
  c.fundo_pct = (parseFloat(document.getElementById('prev-cfg-fundo-pct').value) || 5) / 100;
}

// Popula os 5 inputs do form de rateio a partir do state.configRateio. Usado no retomar
// de rascunho para evitar que o usuario precise re-digitar apartamentos toda sessao.
function previsaoPopularInputsConfigRateio() {
  var c = previsaoState.configRateio;
  var aptos = document.getElementById('prev-cfg-aptos');
  var cob = document.getElementById('prev-cfg-cob');
  var fator = document.getElementById('prev-cfg-fator');
  var fundo = document.getElementById('prev-cfg-fundo');
  var fundoPct = document.getElementById('prev-cfg-fundo-pct');
  if (aptos && c.apartamentos != null) aptos.value = c.apartamentos;
  if (cob) cob.value = c.coberturas != null ? c.coberturas : 0;
  if (fator) fator.value = c.fator_cobertura != null ? c.fator_cobertura : 1.5;
  if (fundo) fundo.value = c.fundo_reserva != null ? c.fundo_reserva : 0;
  if (fundoPct) fundoPct.value = c.fundo_pct != null ? (c.fundo_pct * 100) : 5;
}

// Habilita/desabilita o botao Gerar Previsao conforme estado.
function previsaoAtualizarBotaoGerar() {
  var btn = document.getElementById('prev-btn-pdf');
  if (!btn) return;
  var temRascunho = !!previsaoState.rascunhoId;
  var aptos = parseInt(document.getElementById('prev-cfg-aptos') ? document.getElementById('prev-cfg-aptos').value : '', 10);
  var temAptos = !isNaN(aptos) && aptos >= 1;
  btn.disabled = !(temRascunho && temAptos && !previsaoState.gerandoArquivos);
}

// Mostra a area de config de rateio quando existe rascunho salvo.
function previsaoMostrarConfigRateio() {
  var box = document.getElementById('prev-config-rateio');
  if (box && previsaoState.rascunhoId) box.style.display = '';
}

// Gera PPTX + PDF via /api/previsao/gerar-pdf. Mostra status e renderiza arquivos.
async function previsaoGerarPdf() {
  if (!previsaoState.rascunhoId) {
    if (typeof toast === 'function') toast('Salve o rascunho antes de gerar.', 'warn');
    return;
  }
  previsaoLerConfigRateio();
  if (!previsaoState.configRateio.apartamentos || previsaoState.configRateio.apartamentos < 1) {
    if (typeof toast === 'function') toast('Informe o numero de apartamentos.', 'warn');
    return;
  }
  if (previsaoState.gerandoArquivos) return;

  previsaoState.gerandoArquivos = true;
  previsaoAtualizarBotaoGerar();
  var status = document.getElementById('prev-status-geracao');
  if (status) {
    status.style.display = '';
    status.textContent = 'Gerando apresentacao, pode levar ate 60s na primeira vez...';
  }

  try {
    var resp = await apiAuthFetch('/api/previsao/gerar-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previsao_id: previsaoState.rascunhoId,
        config_rateio: previsaoState.configRateio
      })
    });
    if (!resp.ok) {
      var msg = 'Erro ao gerar arquivos (' + resp.status + ').';
      if (resp.status === 503) msg = 'Servico de geracao indisponivel. Tente em alguns minutos.';
      if (resp.status === 504) msg = 'Tempo esgotado. Tente novamente.';
      if (resp.status === 422) msg = 'Dados invalidos para geracao.';
      if (typeof toast === 'function') toast(msg, 'err');
      return;
    }
    var data = await resp.json();
    previsaoState.ultimaGeracao = data;
    previsaoRenderizarArquivos(data);
    // Autosave silencioso: garante que o config_rateio que o usuario digitou fique
    // persistido no rascunho, evitando que ele precise re-digitar apartamentos ao
    // retomar de uma sessao futura. Idempotente: se nao mudou nada, servidor responde
    // 'sem_alteracoes' e o cache de geracao nao e invalidado.
    previsaoSalvarRascunho(true);
  } catch (e) {
    console.error('[previsao] erro ao gerar pdf:', e);
    if (typeof toast === 'function') toast('Sem conexao ao gerar.', 'err');
  } finally {
    previsaoState.gerandoArquivos = false;
    previsaoAtualizarBotaoGerar();
    var s = document.getElementById('prev-status-geracao');
    if (s) s.style.display = 'none';
  }
}

// Renderiza 2 cards lado a lado (PPTX + PDF) com links de download.
function previsaoRenderizarArquivos(data) {
  var area = document.getElementById('prev-area-arquivos');
  if (!area) return;
  var esc = previsaoEsc;
  var dataStr = '';
  if (data.gerado_em) {
    var d = new Date(data.gerado_em);
    dataStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  }
  var cacheBadge = data.cached
    ? '<span style="font-size:10px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:10px;color:var(--muted);margin-left:8px">cache</span>'
    : '';
  area.innerHTML = ''
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
    + '<a href="' + esc(data.pptx_url) + '" target="_blank" rel="noopener" '
    + 'style="display:block;padding:18px 20px;background:var(--gs-blue-light);border:1px solid var(--gs-blue-mid);border-radius:12px;text-decoration:none">'
    + '<div style="font-size:11px;font-family:var(--mono);color:var(--gs-blue);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Apresentação</div>'
    + '<div style="font-size:16px;font-weight:600;color:var(--text)">Baixar PPTX</div>'
    + '</a>'
    + '<a href="' + esc(data.pdf_url) + '" target="_blank" rel="noopener" '
    + 'style="display:block;padding:18px 20px;background:var(--gs-blue-light);border:1px solid var(--gs-blue-mid);border-radius:12px;text-decoration:none">'
    + '<div style="font-size:11px;font-family:var(--mono);color:var(--gs-blue);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">PDF</div>'
    + '<div style="font-size:16px;font-weight:600;color:var(--text)">Baixar PDF</div>'
    + '</a>'
    + '</div>'
    + '<div style="font-size:11px;color:var(--muted);margin-top:8px">Gerado em ' + esc(dataStr) + cacheBadge + '</div>';
  area.style.display = '';
}
