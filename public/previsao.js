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
  fracoesVisiveis: false
};

// === Ouvinte de troca de condominio (no topo, fora de funcao) ===
document.addEventListener('condominioAtivo:changed', function() {
  previsaoOnCondominioChange();
});

// Chamado pelo showPanel('previsao') a cada abertura do painel.
function previsaoInit() {
  if (typeof renderBannerCondAtivo === 'function') {
    renderBannerCondAtivo('previsao');
  }
  previsaoAtualizarFallback();
  previsaoAtualizarBotao();
}

function previsaoOnCondominioChange() {
  // Banner e fallback sao atualizados pelo setCondominioAtivo e pelo evento.
  previsaoAtualizarFallback();
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

// Renderiza chips com nome, seletor de tipo e botao remover.
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
  else if (status === 422) msg = 'PDF invalido ou nao reconhecido como W011A ou W045A do Superlogica.';
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

function previsaoRenderizarCabecalho(resp) {
  var box = document.getElementById('prev-cabecalho');
  if (!box) return;
  var esc = previsaoEsc;
  box.innerHTML =
    '<div><div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Condominio</div>'
    + '<div style="font-size:14px;color:var(--text);font-weight:600">' + esc(resp.condominio || '') + '</div></div>'
    + '<div><div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Periodo</div>'
    + '<div style="font-size:14px;color:var(--text)">' + esc(resp.periodo || '') + '</div></div>'
    + '<div><div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Total anual base</div>'
    + '<div style="font-size:14px;color:var(--text);font-weight:600" id="prev-total-geral-base">' + previsaoFmtBRL(resp.total_geral) + '</div>'
    + '<div style="font-size:11px;color:var(--gs-blue);font-weight:600;margin-top:2px" id="prev-total-geral-novo"></div></div>'
    + '<div><div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Mensal medio</div>'
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
        return '<p style="font-size:12px;color:var(--text);margin:6px 0">Atencao: ' + esc(a) + '</p>';
      }).join('');
}

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
  grupo.subcategorias.forEach(function(sub) {
    var rateioLabel = sub.rateio === 'uso-real' ? 'por uso' : 'por fracao';
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
    grupoRow.parentNode.insertBefore(tr, grupoRow.nextSibling);
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

function previsaoRenderizarForaGrupo(itens) {
  var sec = document.getElementById('prev-secao-fora-grupo');
  var tbl = document.getElementById('prev-tabela-fora-grupo');
  if (!sec || !tbl) return;
  if (!itens.length) { sec.style.display = 'none'; tbl.innerHTML = ''; return; }
  sec.style.display = '';
  var esc = previsaoEsc;
  var motivoLabel = function(m) {
    if (m === 'divida-especifica') return 'Divida especifica';
    if (m === 'obra-extraordinaria') return 'Obra extraordinaria';
    return 'Nao classificado';
  };
  var html = '<thead><tr style="border-bottom:2px solid var(--border)">'
    + '<th style="text-align:left;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Data</th>'
    + '<th style="text-align:left;padding:8px 6px;font-size:11px;color:var(--muted);font-family:var(--mono);text-transform:uppercase">Descricao</th>'
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
    + '<th style="text-align:right;padding:6px;color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase">Fracao</th></tr></thead><tbody>';
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
  if (btn) btn.textContent = previsaoState.fracoesVisiveis ? 'Ocultar lista de fracoes' : 'Ver lista de fracoes';
}

// === Download CSV ===
function previsaoBaixarCSV() {
  if (!previsaoState.resposta) return;
  var r = previsaoState.resposta;
  var sep = ';';
  var linhas = [];
  linhas.push('Condominio' + sep + (r.condominio || ''));
  linhas.push('Periodo' + sep + (r.periodo || ''));
  linhas.push('Total anual base' + sep + (r.total_geral || 0).toFixed(2).replace('.', ','));
  var totalNovo = (r.grupos || []).reduce(function(s, g) {
    var rj = previsaoState.reajustes[g.id] || 0;
    return s + (g.total_anual || 0) * (1 + rj);
  }, 0);
  linhas.push('Total anual ajustado' + sep + totalNovo.toFixed(2).replace('.', ','));
  linhas.push('Mensal medio base' + sep + (r.total_mensal_medio || 0).toFixed(2).replace('.', ','));
  linhas.push('');
  linhas.push(['Grupo', 'Total anual', 'Reajuste %', 'Novo total', 'Peso %'].join(sep));
  (r.grupos || []).forEach(function(g) {
    var rj = previsaoState.reajustes[g.id] || 0;
    var novo = (g.total_anual || 0) * (1 + rj);
    linhas.push([
      g.nome,
      (g.total_anual || 0).toFixed(2).replace('.', ','),
      (rj * 100).toFixed(1).replace('.', ','),
      novo.toFixed(2).replace('.', ','),
      ((g.peso_pct || 0) * 100).toFixed(1).replace('.', ',')
    ].join(sep));
    (g.subcategorias || []).forEach(function(sub) {
      var rateioLabel = sub.rateio === 'uso-real' ? 'por uso' : 'por fracao';
      linhas.push([
        '  ' + sub.nome,
        (sub.total_anual || 0).toFixed(2).replace('.', ','),
        rateioLabel,
        '',
        ''
      ].join(sep));
    });
  });
  // BOM UTF-8 para Excel BR reconhecer acentuacao
  var conteudo = '﻿' + linhas.join('\n');
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
