// ============================================================
// PRESTAÇÃO DE CONTAS — extraído de public/index.html como
// refactor preparatório para a Tarefa prestacao-ondas-1-2-3.
// Carregado via <script src="/prestacao.js"></script> antes do
// </body> do index.html. Continua sendo script clássico (não
// module), então variáveis let/const seguem no mesmo escopo
// global do script inline. Não há mudança de comportamento.
// ============================================================

// ============================================================
// PRESTAÇÃO DE CONTAS
// Cache de condominios populado via supaFetch ao abrir o painel.
// Busca filtravel client side. Modo livre permite condominio nao cadastrado.
// ============================================================

let prestacaoState = {
  condominios: null,
  arquivos: [],
  condId: null,
  condNome: '',
  periodo: '',
  dataApresentacao: '',
  observacoes: ''
};

// Roda na primeira vez que o painel Prestacao de Contas e mostrado.
// Puxa lista de condominios do Supabase e seta data de hoje no campo de apresentacao.
async function prestacaoInit() {
  if (prestacaoState.condominios !== null) return;
  prestacaoState.condominios = [];
  try {
    const r = await supaFetch('condominios?select=id,nome,id_superlogica&order=nome.asc');
    if (Array.isArray(r)) prestacaoState.condominios = r;
  } catch (e) {
    // Informa o usuário que a lista não carregou para ele poder tentar recarregar,
    // em vez de deixar o campo de busca silenciosamente vazio.
    // prestacaoState.condominios já foi inicializado como [] antes do try.
    toast('Não foi possível carregar a lista de condomínios. Tente recarregar a página.', 'err');
  }
  var hoje = new Date();
  var iso = hoje.getFullYear() + '-' +
            String(hoje.getMonth() + 1).padStart(2, '0') + '-' +
            String(hoje.getDate()).padStart(2, '0');
  var dataInput = document.getElementById('prest-data-apresentacao');
  if (dataInput && !dataInput.value) {
    dataInput.value = iso;
    prestacaoState.dataApresentacao = iso;
  }
}

// Filtra a lista cached pelo texto digitado e re renderiza o dropdown.
// Sempre adiciona "Outro condominio nao cadastrado" como ultimo item.
function prestacaoFiltrarCondominios(query) {
  var dd = document.getElementById('prest-cond-dropdown');
  if (!dd) return;
  var lista = Array.isArray(prestacaoState.condominios) ? prestacaoState.condominios : [];
  var q = (query || '').trim().toLowerCase();
  var filtrados = q.length === 0
    ? lista.slice(0, 15)
    : lista.filter(function(c) { return c && c.nome && c.nome.toLowerCase().indexOf(q) !== -1; }).slice(0, 15);
  var esc = function(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var html = '';
  if (filtrados.length === 0) {
    html += '<div class="cond-option" style="opacity:.7;cursor:default">Nenhum condomínio encontrado</div>';
  } else {
    html += filtrados.map(function(c) {
      var id = esc(c.id);
      var nome = esc(c.nome);
      var idSup = c.id_superlogica != null ? esc(c.id_superlogica) : '';
      return '<div class="cond-option" data-id="' + id + '" data-nome="' + nome + '">'
        + '<span class="cond-name">' + nome + '</span>'
        + (idSup ? '<span class="cond-id">' + idSup + '</span>' : '')
        + '</div>';
    }).join('');
  }
  html += '<div class="cond-option" data-acao="outro" style="border-top:1px dashed var(--border2);font-style:italic">'
        + '<span class="cond-name">Outro condomínio não cadastrado</span></div>';
  dd.innerHTML = html;
  dd.classList.add('open');
  if (!dd._listenerAdded) {
    dd.addEventListener('click', function(ev) {
      var opt = ev.target.closest('.cond-option');
      if (!opt) return;
      if (opt.dataset.acao === 'outro') {
        prestacaoUsarOutro();
        return;
      }
      if (!opt.dataset.id) return;
      prestacaoSelecionarCondominio(opt.dataset.id, opt.dataset.nome);
    });
    dd._listenerAdded = true;
  }
}

// Seleciona um condominio do dropdown e fecha o popup.
function prestacaoSelecionarCondominio(id, nome) {
  var inp = document.getElementById('prest-cond-search');
  if (inp) inp.value = nome;
  var dd = document.getElementById('prest-cond-dropdown');
  if (dd) { dd.classList.remove('open'); dd.innerHTML = ''; }
  prestacaoState.condId = id;
  prestacaoState.condNome = nome;
  prestacaoAtualizarBotao();
}

// Troca a UI do Card 1 para o modo livre (condominio sem cadastro).
function prestacaoUsarOutro() {
  var dd = document.getElementById('prest-cond-dropdown');
  if (dd) { dd.classList.remove('open'); dd.innerHTML = ''; }
  document.getElementById('prest-modo-busca').style.display = 'none';
  document.getElementById('prest-modo-livre').style.display = 'block';
  prestacaoState.condId = null;
  prestacaoState.condNome = '';
  var nomeLivre = document.getElementById('prest-cond-nome-livre');
  if (nomeLivre) { nomeLivre.value = ''; nomeLivre.focus(); }
  prestacaoAtualizarBotao();
}

// Volta do modo livre para a busca normal.
function prestacaoVoltarLista() {
  document.getElementById('prest-modo-livre').style.display = 'none';
  document.getElementById('prest-modo-busca').style.display = 'block';
  prestacaoState.condId = null;
  prestacaoState.condNome = '';
  var inp = document.getElementById('prest-cond-search');
  if (inp) { inp.value = ''; inp.focus(); }
  prestacaoAtualizarBotao();
}

// Adiciona arquivos selecionados via input file.
function prestacaoAdicionarArquivos(event) {
  var arquivos = Array.from(event.target.files || []);
  arquivos.forEach(function(f) { prestacaoState.arquivos.push(f); });
  event.target.value = '';
  prestacaoRenderizarListaArquivos();
  prestacaoAtualizarBotao();
}

// Adiciona arquivos via drop na dropzone.
function prestacaoAdicionarArquivosDrop(event) {
  event.preventDefault();
  handleDragLeave(event.currentTarget);
  var arquivos = Array.from(event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : []);
  arquivos.forEach(function(f) { prestacaoState.arquivos.push(f); });
  prestacaoRenderizarListaArquivos();
  prestacaoAtualizarBotao();
}

// Remove um arquivo da lista pelo indice.
function prestacaoRemoverArquivo(idx) {
  if (idx < 0 || idx >= prestacaoState.arquivos.length) return;
  prestacaoState.arquivos.splice(idx, 1);
  prestacaoRenderizarListaArquivos();
  prestacaoAtualizarBotao();
}

// Renderiza a lista de arquivos anexados abaixo da dropzone.
function prestacaoRenderizarListaArquivos() {
  var box = document.getElementById('prest-files-list');
  if (!box) return;
  if (!prestacaoState.arquivos.length) {
    box.innerHTML = '';
    return;
  }
  var esc = function(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  box.innerHTML = prestacaoState.arquivos.map(function(f, i) {
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;font-size:12px;font-family:var(--mono)">'
      + '<span style="flex:1;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.name) + '</span>'
      + '<span style="color:var(--muted)">' + prestacaoFormatarTamanho(f.size) + '</span>'
      + '<button onclick="prestacaoRemoverArquivo(' + i + ')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:2px 6px" title="Remover">✕</button>'
      + '</div>';
  }).join('');
}

// Atualiza o campo de observacoes no state.
function prestacaoAtualizarObservacoes(valor) {
  prestacaoState.observacoes = valor || '';
}

// Habilita o botao Gerar quando ha condominio (cadastrado OU livre com nome) e pelo menos 1 arquivo.
function prestacaoAtualizarBotao() {
  var btn = document.getElementById('prest-btn-gerar');
  if (!btn) return;
  var temCond = !!(prestacaoState.condId || (prestacaoState.condNome && prestacaoState.condNome.trim().length > 0));
  var temArquivo = prestacaoState.arquivos.length > 0;
  btn.disabled = !(temCond && temArquivo);
}

// Limpa todos os campos do painel e reseta state (preserva o cache de condominios).
function prestacaoLimparTudo() {
  prestacaoState.arquivos = [];
  prestacaoState.condId = null;
  prestacaoState.condNome = '';
  prestacaoState.periodo = '';
  prestacaoState.dataApresentacao = '';
  prestacaoState.observacoes = '';
  document.getElementById('prest-modo-livre').style.display = 'none';
  document.getElementById('prest-modo-busca').style.display = 'block';
  var inp = document.getElementById('prest-cond-search');
  if (inp) inp.value = '';
  var nomeLivre = document.getElementById('prest-cond-nome-livre');
  if (nomeLivre) nomeLivre.value = '';
  var per = document.getElementById('prest-periodo');
  if (per) per.value = '';
  var dat = document.getElementById('prest-data-apresentacao');
  if (dat) dat.value = '';
  var obs = document.getElementById('prest-observacoes');
  if (obs) obs.value = '';
  prestacaoRenderizarListaArquivos();
  prestacaoAtualizarBotao();
  prestacaoInit();
}

// Helper de formatacao de tamanho de arquivo.
function prestacaoFormatarTamanho(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// Formata um numero como moeda brasileira (BRL) sem usar Intl, para evitar
// dependencias de locale do ambiente. Aceita valores nulos ou invalidos.
function prestacaoFmtBRL(valor) {
  if (valor === null || valor === undefined || isNaN(valor)) return 'R$ 0,00';
  const s = Math.abs(Number(valor)).toFixed(2);
  const partes = s.split('.');
  const inteiros = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimais = partes[1];
  const sinal = Number(valor) < 0 ? '-' : '';
  return sinal + 'R$ ' + inteiros + ',' + decimais;
}

// Formata um numero como percentual brasileiro com casas decimais configuraveis.
// Padrao 1 casa. Troca ponto por virgula no separador decimal.
function prestacaoFmtPct(valor, casas) {
  if (valor === null || valor === undefined || isNaN(valor)) return '0,0%';
  const c = (casas === undefined) ? 1 : casas;
  return Number(valor).toFixed(c).replace('.', ',') + '%';
}

// Valida a consistencia dos dados extraidos pela IA. Devolve um array de
// checagens com tipo, titulo, ok, esperado, recebido, diferenca e bloqueante.
// Tolerancia de 1 real cobre arredondamentos do Superlogica.
function prestacaoValidarConsistencia(dados) {
  const tolerancia = 1.00;
  const checks = [];

  if (!dados || !dados.saldo || !dados.receitas || !dados.despesas) {
    checks.push({
      tipo: 'estrutura',
      titulo: 'Estrutura do JSON incompleta',
      ok: false,
      esperado: 'Objeto com saldo, receitas e despesas',
      recebido: 'Faltam campos obrigatorios',
      diferenca: null,
      bloqueante: true
    });
    return checks;
  }

  const saldoIni = Number(dados.saldo.inicial) || 0;
  const saldoFim = Number(dados.saldo.final) || 0;
  const receitaTotal = Number(dados.receitas.total) || 0;
  const despesaTotal = Number(dados.despesas.total) || 0;

  const saldoCalculado = saldoIni + receitaTotal - despesaTotal;
  const difSaldo = saldoCalculado - saldoFim;
  checks.push({
    tipo: 'equacao',
    titulo: 'Equação do exercício',
    ok: Math.abs(difSaldo) <= tolerancia,
    esperado: 'Saldo inicial + Receitas - Despesas = Saldo final',
    calculo: prestacaoFmtBRL(saldoIni) + ' + ' + prestacaoFmtBRL(receitaTotal) + ' - ' + prestacaoFmtBRL(despesaTotal) + ' = ' + prestacaoFmtBRL(saldoCalculado),
    recebido: 'Saldo final no JSON: ' + prestacaoFmtBRL(saldoFim),
    diferenca: difSaldo,
    bloqueante: Math.abs(difSaldo) > tolerancia
  });

  if (Array.isArray(dados.receitas.porCategoria)) {
    const somaRec = dados.receitas.porCategoria.reduce(function(acc, cat) {
      return acc + (Number(cat.valor) || 0);
    }, 0);
    const difRec = somaRec - receitaTotal;
    checks.push({
      tipo: 'soma_receitas',
      titulo: 'Soma das categorias de receita',
      ok: Math.abs(difRec) <= tolerancia,
      esperado: 'Soma de todas as categorias = Receita total',
      calculo: 'Soma de ' + dados.receitas.porCategoria.length + ' categorias: ' + prestacaoFmtBRL(somaRec),
      recebido: 'Receita total declarada: ' + prestacaoFmtBRL(receitaTotal),
      diferenca: difRec,
      bloqueante: Math.abs(difRec) > tolerancia
    });
  }

  if (Array.isArray(dados.despesasPorCategoria)) {
    const somaDesp = dados.despesasPorCategoria.reduce(function(acc, cat) {
      return acc + (Number(cat.valor) || 0);
    }, 0);
    const difDesp = somaDesp - despesaTotal;
    checks.push({
      tipo: 'soma_despesas',
      titulo: 'Soma das categorias de despesa',
      ok: Math.abs(difDesp) <= tolerancia,
      esperado: 'Soma de todas as categorias = Despesa total',
      calculo: 'Soma de ' + dados.despesasPorCategoria.length + ' categorias: ' + prestacaoFmtBRL(somaDesp),
      recebido: 'Despesa total declarada: ' + prestacaoFmtBRL(despesaTotal),
      diferenca: difDesp,
      bloqueante: Math.abs(difDesp) > tolerancia
    });
  }

  return checks;
}

// Resume um array de checks devolvido por prestacaoValidarConsistencia,
// contando totais, bloqueantes, avisos e ok, e indicando se da pra gerar direto.
function prestacaoResumirValidacao(checks) {
  const total = checks.length;
  const bloqueantes = checks.filter(function(c) { return c.bloqueante; }).length;
  const avisos = checks.filter(function(c) { return !c.ok && !c.bloqueante; }).length;
  const ok = checks.filter(function(c) { return c.ok; }).length;
  return {
    total: total,
    bloqueantes: bloqueantes,
    avisos: avisos,
    ok: ok,
    podeGerarDireto: bloqueantes === 0,
    temAlertas: bloqueantes > 0 || avisos > 0
  };
}

// Faz uma copia profunda do objeto de dados extraidos para a modal de revisao
// poder editar sem mutar o original armazenado em prestacaoState.
function prestacaoCloneDados(dados) {
  return JSON.parse(JSON.stringify(dados));
}

// Abre a modal de revisao. Clona os dados extraidos para edicao isolada,
// popula formularios das 5 secoes e o JSON cru, roda validacao inicial e
// renderiza o preview dos slides na coluna direita.
function prestacaoAbrirModal() {
  if (!prestacaoState.dadosExtraidos) {
    toast('Nao ha dados extraidos. Gere primeiro.', 'err');
    return;
  }
  prestacaoState.dadosEditaveis = prestacaoCloneDados(prestacaoState.dadosExtraidos);
  prestacaoPopularFormularios(prestacaoState.dadosEditaveis);
  document.getElementById('prestacao-json-raw').value = JSON.stringify(prestacaoState.dadosEditaveis, null, 2);
  const checks = prestacaoValidarConsistencia(prestacaoState.dadosEditaveis);
  prestacaoRenderizarValidacao(checks);
  prestacaoRenderizarPreview(prestacaoState.dadosEditaveis);
  document.getElementById('prestacao-modal').style.display = 'block';
}

// Esconde a modal e descarta a copia de edicao para liberar memoria
// e evitar que dados editados vazem para a proxima abertura.
function prestacaoFecharModal() {
  const m = document.getElementById('prestacao-modal');
  if (m) m.style.display = 'none';
  delete prestacaoState.dadosEditaveis;
}

// Helper interno que cria um par label + input (ou textarea), com data-campo
// e data-idx para a leitura reversa em prestacaoAtualizarDadosEdicao.
function prestacaoCriarCampo(tipo, label, valor, dataCampo, dataIdx) {
  const wrap = document.createElement('div');
  if (label) {
    const lab = document.createElement('label');
    lab.textContent = label;
    wrap.appendChild(lab);
  }
  let inp;
  if (tipo === 'textarea') {
    inp = document.createElement('textarea');
    inp.rows = 4;
  } else {
    inp = document.createElement('input');
    inp.type = tipo;
    if (tipo === 'number') inp.step = '0.01';
  }
  if (valor !== null && valor !== undefined) inp.value = valor;
  inp.setAttribute('data-campo', dataCampo);
  if (dataIdx !== undefined) inp.setAttribute('data-idx', String(dataIdx));
  inp.oninput = prestacaoAtualizarDadosEdicao;
  wrap.appendChild(inp);
  return wrap;
}

// Monta os 5 formularios da coluna de edicao a partir do objeto dados.
// Cada categoria de receita ou despesa vira uma linha com nome e valor.
function prestacaoPopularFormularios(dados) {
  const fc = document.getElementById('prestacao-form-cabecalho');
  fc.innerHTML = '';
  const cab = dados.cabecalho || {};
  fc.appendChild(prestacaoCriarCampo('text', 'Condominio', cab.condominio || '', 'condominio'));
  fc.appendChild(prestacaoCriarCampo('text', 'Período', cab.periodo || '', 'periodo'));
  fc.appendChild(prestacaoCriarCampo('text', 'Data da apresentacao', cab.dataApresentacao || '', 'dataApresentacao'));

  const fs = document.getElementById('prestacao-form-saldo');
  fs.innerHTML = '';
  const sal = dados.saldo || {};
  fs.appendChild(prestacaoCriarCampo('number', 'Saldo inicial', sal.inicial != null ? sal.inicial : '', 'saldoInicial'));
  fs.appendChild(prestacaoCriarCampo('number', 'Saldo final', sal.final != null ? sal.final : '', 'saldoFinal'));

  const fr = document.getElementById('prestacao-form-receitas');
  fr.innerHTML = '';
  const rec = dados.receitas || {};
  fr.appendChild(prestacaoCriarCampo('number', 'Receita total', rec.total != null ? rec.total : '', 'receitaTotal'));
  const recCats = Array.isArray(rec.porCategoria) ? rec.porCategoria : [];
  for (let i = 0; i < recCats.length; i++) {
    const linha = document.createElement('div');
    linha.style.display = 'flex';
    linha.style.gap = '8px';
    linha.style.marginTop = '8px';
    const nomeWrap = prestacaoCriarCampo('text', 'Categoria ' + (i + 1), recCats[i].categoria || '', 'receitaCatNome', i);
    const valWrap = prestacaoCriarCampo('number', 'Valor', recCats[i].valor != null ? recCats[i].valor : '', 'receitaCatValor', i);
    nomeWrap.style.flex = '2';
    valWrap.style.flex = '1';
    linha.appendChild(nomeWrap);
    linha.appendChild(valWrap);
    fr.appendChild(linha);
  }

  const fd = document.getElementById('prestacao-form-despesas');
  fd.innerHTML = '';
  const desp = dados.despesas || {};
  fd.appendChild(prestacaoCriarCampo('number', 'Despesa total', desp.total != null ? desp.total : '', 'despesaTotal'));
  const despCats = Array.isArray(dados.despesasPorCategoria) ? dados.despesasPorCategoria : [];
  for (let i = 0; i < despCats.length; i++) {
    const linha = document.createElement('div');
    linha.style.display = 'flex';
    linha.style.gap = '8px';
    linha.style.marginTop = '8px';
    const nomeWrap = prestacaoCriarCampo('text', 'Categoria ' + (i + 1), despCats[i].categoria || '', 'despesaCatNome', i);
    const valWrap = prestacaoCriarCampo('number', 'Valor', despCats[i].valor != null ? despCats[i].valor : '', 'despesaCatValor', i);
    nomeWrap.style.flex = '2';
    valWrap.style.flex = '1';
    linha.appendChild(nomeWrap);
    linha.appendChild(valWrap);
    fd.appendChild(linha);
  }

  const fo = document.getElementById('prestacao-form-observacoes');
  fo.innerHTML = '';
  const obs = Array.isArray(dados.observacoes) ? dados.observacoes.join('\n') : (dados.observacoes || '');
  fo.appendChild(prestacaoCriarCampo('textarea', 'Observacoes (uma por linha)', obs, 'observacoes'));
}

// Le todos os inputs da modal, reconstroi o objeto dadosEditaveis a partir
// deles, atualiza o textarea de JSON, roda a validacao e re renderiza o preview.
function prestacaoAtualizarDadosEdicao() {
  const dados = prestacaoState.dadosEditaveis;
  if (!dados) return;
  const get = function(campo) {
    const el = document.querySelector('[data-campo="' + campo + '"]');
    return el ? el.value : '';
  };
  const num = function(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };

  if (!dados.cabecalho) dados.cabecalho = {};
  dados.cabecalho.condominio = get('condominio');
  dados.cabecalho.periodo = get('periodo');
  dados.cabecalho.dataApresentacao = get('dataApresentacao');

  if (!dados.saldo) dados.saldo = {};
  dados.saldo.inicial = num(get('saldoInicial'));
  dados.saldo.final = num(get('saldoFinal'));
  if (dados.saldo.inicial != null && dados.saldo.final != null) {
    dados.saldo.movimentacao = dados.saldo.final - dados.saldo.inicial;
  }

  if (!dados.receitas) dados.receitas = {};
  dados.receitas.total = num(get('receitaTotal'));
  if (Array.isArray(dados.receitas.porCategoria)) {
    const recNomes = document.querySelectorAll('[data-campo="receitaCatNome"]');
    const recVals = document.querySelectorAll('[data-campo="receitaCatValor"]');
    for (let i = 0; i < dados.receitas.porCategoria.length; i++) {
      if (recNomes[i]) dados.receitas.porCategoria[i].categoria = recNomes[i].value;
      if (recVals[i]) dados.receitas.porCategoria[i].valor = num(recVals[i].value);
    }
  }

  if (!dados.despesas) dados.despesas = {};
  dados.despesas.total = num(get('despesaTotal'));
  if (Array.isArray(dados.despesasPorCategoria)) {
    const dNomes = document.querySelectorAll('[data-campo="despesaCatNome"]');
    const dVals = document.querySelectorAll('[data-campo="despesaCatValor"]');
    for (let i = 0; i < dados.despesasPorCategoria.length; i++) {
      if (dNomes[i]) dados.despesasPorCategoria[i].categoria = dNomes[i].value;
      if (dVals[i]) dados.despesasPorCategoria[i].valor = num(dVals[i].value);
    }
  }

  const obsTxt = get('observacoes') || '';
  dados.observacoes = obsTxt.split('\n').filter(function(l) { return l.trim() !== ''; });

  document.getElementById('prestacao-json-raw').value = JSON.stringify(dados, null, 2);
  const checks = prestacaoValidarConsistencia(dados);
  prestacaoRenderizarValidacao(checks);
  prestacaoRenderizarPreview(dados);
}

// Renderiza um bloco por check no painel de validacao e controla a visibilidade
// dos botoes de gerar e gerar urgencia conforme houver bloqueantes ou nao.
function prestacaoRenderizarValidacao(checks) {
  const cont = document.getElementById('prestacao-modal-validacao');
  cont.innerHTML = '';
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    const cls = c.ok ? 'ok' : (c.bloqueante ? 'erro' : 'aviso');
    const div = document.createElement('div');
    div.className = 'prestacao-validacao-bloco ' + cls;
    const titulo = document.createElement('strong');
    titulo.textContent = c.titulo;
    div.appendChild(titulo);
    if (c.esperado) {
      const e = document.createElement('span');
      e.className = 'det';
      e.textContent = 'Esperado: ' + c.esperado;
      div.appendChild(e);
    }
    if (c.calculo) {
      const ca = document.createElement('span');
      ca.className = 'det';
      ca.textContent = 'Calculo: ' + c.calculo;
      div.appendChild(ca);
    }
    if (c.recebido) {
      const r = document.createElement('span');
      r.className = 'det';
      r.textContent = c.recebido;
      div.appendChild(r);
    }
    if (c.diferenca !== null && c.diferenca !== undefined) {
      const d = document.createElement('span');
      d.className = 'det';
      d.textContent = 'Diferença: ' + prestacaoFmtBRL(c.diferenca);
      div.appendChild(d);
    }
    cont.appendChild(div);
  }

  const resumo = prestacaoResumirValidacao(checks);
  const btnUrg = document.getElementById('prestacao-btn-urgencia');
  const btnGer = document.getElementById('prestacao-btn-gerar');
  if (resumo.bloqueantes > 0) {
    btnUrg.style.display = '';
    btnGer.style.display = 'none';
  } else {
    btnUrg.style.display = 'none';
    btnGer.style.display = '';
    btnGer.disabled = false;
  }
}

// Helper que cria a base de uma miniatura de slide (numero + titulo).
function prestacaoMiniSlide(numero, titulo, opts) {
  opts = opts || {};
  const card = document.createElement('div');
  card.className = 'prestacao-slide-mini' + (opts.dark ? ' dark' : '');
  const num = document.createElement('div');
  num.className = 'prestacao-slide-mini-numero';
  num.textContent = 'Slide ' + numero;
  card.appendChild(num);
  const tit = document.createElement('div');
  tit.className = 'prestacao-slide-mini-titulo';
  tit.textContent = titulo;
  card.appendChild(tit);
  return card;
}

// Helper que adiciona um paragrafo de corpo na miniatura.
function prestacaoMiniCorpo(card, texto) {
  const c = document.createElement('div');
  c.className = 'prestacao-slide-mini-corpo';
  c.textContent = texto;
  card.appendChild(c);
}

// Helper que adiciona uma faixa de KPIs coloridos na miniatura.
function prestacaoMiniKpis(card, kpis) {
  const w = document.createElement('div');
  w.className = 'prestacao-slide-mini-kpis';
  for (let i = 0; i < kpis.length; i++) {
    const k = document.createElement('div');
    k.className = 'prestacao-slide-mini-kpi';
    k.textContent = kpis[i].label;
    const b = document.createElement('b');
    b.textContent = kpis[i].valor;
    k.appendChild(b);
    w.appendChild(k);
  }
  card.appendChild(w);
}

// Helper que desenha um mini grafico de barras escalonado pelo maior valor.
function prestacaoMiniBars(card, valores) {
  const w = document.createElement('div');
  w.className = 'prestacao-slide-mini-bars';
  let max = 0;
  for (let i = 0; i < valores.length; i++) {
    const v = Math.abs(Number(valores[i]) || 0);
    if (v > max) max = v;
  }
  if (max === 0) max = 1;
  for (let i = 0; i < valores.length; i++) {
    const b = document.createElement('div');
    b.className = 'prestacao-slide-mini-bar';
    const v = Math.abs(Number(valores[i]) || 0);
    const h = Math.max(2, Math.round((v / max) * 100));
    b.style.height = h + '%';
    w.appendChild(b);
  }
  card.appendChild(w);
}

// Renderiza a lista de miniaturas de slides na coluna direita da modal.
// Ordem fixa: capa, visao geral, evolucao, patrimonio, superavit, origem,
// estrutura, detalhamento por categoria de receita, depois despesa, e encerramento.
function prestacaoRenderizarPreview(dados) {
  const lista = document.getElementById('prestacao-preview-lista');
  lista.innerHTML = '';
  let n = 1;
  const rec = (dados && dados.receitas) || {};
  const desp = (dados && dados.despesas) || {};
  const sal = (dados && dados.saldo) || {};
  const cab = (dados && dados.cabecalho) || {};

  const capa = prestacaoMiniSlide(n++, cab.condominio || 'Condominio', { dark: true });
  prestacaoMiniCorpo(capa, 'Período: ' + (cab.periodo || ''));
  lista.appendChild(capa);

  const recT = Number(rec.total) || 0;
  const despT = Number(desp.total) || 0;
  const sIni = Number(sal.inicial) || 0;
  const sFim = Number(sal.final) || 0;
  const sup = recT - despT;
  const visao = prestacaoMiniSlide(n++, 'Visão Geral');
  prestacaoMiniKpis(visao, [
    { label: 'Saldo inicial', valor: prestacaoFmtBRL(sIni) },
    { label: 'Receita', valor: prestacaoFmtBRL(recT) },
    { label: 'Despesa', valor: prestacaoFmtBRL(despT) },
    { label: 'Superávit', valor: prestacaoFmtBRL(sup) },
    { label: 'Saldo final', valor: prestacaoFmtBRL(sFim) }
  ]);
  lista.appendChild(visao);

  const evo = prestacaoMiniSlide(n++, 'Evolução Mensal');
  const recDist = Array.isArray(rec.distribuicaoTemporalTotal) ? rec.distribuicaoTemporalTotal : [];
  const despDist = Array.isArray(desp.distribuicaoTemporalTotal) ? desp.distribuicaoTemporalTotal : [];
  if (recDist.length || despDist.length) {
    if (recDist.length) prestacaoMiniBars(evo, recDist);
    if (despDist.length) prestacaoMiniBars(evo, despDist);
  } else {
    prestacaoMiniCorpo(evo, 'Sem distribuição temporal disponível');
  }
  lista.appendChild(evo);

  const patrim = prestacaoMiniSlide(n++, 'Patrimônio');
  let pct = 0;
  if (sIni !== 0) pct = ((sFim - sIni) / Math.abs(sIni)) * 100;
  prestacaoMiniCorpo(patrim, 'Variacao: ' + prestacaoFmtPct(pct, 1));
  const saldoMensal = Array.isArray(dados.saldoMensal) ? dados.saldoMensal : [];
  if (saldoMensal.length) prestacaoMiniBars(patrim, saldoMensal);
  lista.appendChild(patrim);

  const supSlide = prestacaoMiniSlide(n++, 'Superávit Mensal');
  if (recDist.length === despDist.length && recDist.length > 0) {
    const supArr = [];
    for (let i = 0; i < recDist.length; i++) {
      supArr.push((Number(recDist[i]) || 0) - (Number(despDist[i]) || 0));
    }
    prestacaoMiniBars(supSlide, supArr);
  } else {
    prestacaoMiniCorpo(supSlide, 'Sem dados temporais para superávit');
  }
  lista.appendChild(supSlide);

  const origem = prestacaoMiniSlide(n++, 'Origem da Receita');
  const recCats = Array.isArray(rec.porCategoria) ? rec.porCategoria : [];
  if (recCats.length) {
    const linhas = recCats.map(function(c) {
      return (c.categoria || 'Sem nome') + ': ' + prestacaoFmtBRL(c.valor);
    }).join(' | ');
    prestacaoMiniCorpo(origem, linhas);
  } else {
    prestacaoMiniCorpo(origem, 'Sem categorias');
  }
  lista.appendChild(origem);

  const estr = prestacaoMiniSlide(n++, 'Estrutura de Despesas');
  const despCats = Array.isArray(dados.despesasPorCategoria) ? dados.despesasPorCategoria : [];
  if (despCats.length) {
    const linhas = despCats.map(function(c) {
      return (c.categoria || 'Sem nome') + ': ' + prestacaoFmtBRL(c.valor);
    }).join(' | ');
    prestacaoMiniCorpo(estr, linhas);
  } else {
    prestacaoMiniCorpo(estr, 'Sem categorias');
  }
  lista.appendChild(estr);

  for (let i = 0; i < recCats.length; i++) {
    const c = recCats[i];
    const slide = prestacaoMiniSlide(n++, 'Receita: ' + (c.categoria || 'Sem nome'));
    const pctCat = recT > 0 ? (Number(c.valor) / recT) * 100 : 0;
    prestacaoMiniCorpo(slide, prestacaoFmtBRL(c.valor) + ' (' + prestacaoFmtPct(pctCat, 1) + ')');
    if (Array.isArray(c.distribuicaoTemporal) && c.granularidade === 'mensal') {
      prestacaoMiniBars(slide, c.distribuicaoTemporal);
    }
    lista.appendChild(slide);
  }

  for (let i = 0; i < despCats.length; i++) {
    const c = despCats[i];
    const slide = prestacaoMiniSlide(n++, 'Despesa: ' + (c.categoria || 'Sem nome'));
    const pctCat = despT > 0 ? (Number(c.valor) / despT) * 100 : 0;
    prestacaoMiniCorpo(slide, prestacaoFmtBRL(c.valor) + ' (' + prestacaoFmtPct(pctCat, 1) + ')');
    if (Array.isArray(c.distribuicaoTemporal) && c.granularidade === 'mensal') {
      prestacaoMiniBars(slide, c.distribuicaoTemporal);
    }
    lista.appendChild(slide);
  }

  const enc = prestacaoMiniSlide(n++, 'Encerramento', { dark: true });
  let pctEnc = 0;
  if (sIni !== 0) pctEnc = ((sFim - sIni) / Math.abs(sIni)) * 100;
  prestacaoMiniCorpo(enc, prestacaoFmtPct(pctEnc, 1) + ' no caixa | ' + prestacaoFmtBRL(sIni) + ' para ' + prestacaoFmtBRL(sFim));
  lista.appendChild(enc);
}

// Garante dados frescos, valida de novo e gera o pptx se nao houver
// bloqueantes. A geracao real e feita por prestacaoMontarPptx.
async function prestacaoConfirmarGeracao() {
  prestacaoAtualizarDadosEdicao();
  const dados = prestacaoState.dadosEditaveis;
  const checks = prestacaoValidarConsistencia(dados);
  const resumo = prestacaoResumirValidacao(checks);
  if (resumo.bloqueantes > 0) {
    toast('Existem inconsistencias bloqueantes. Corrija antes de gerar.', 'err');
    return;
  }
  try {
    toast('Gerando pptx...', 'info');
    await prestacaoMontarPptx(dados);
    toast('Pptx gerado e baixado.', 'ok');
    prestacaoFecharModal();
  } catch (err) {
    console.error('[prestacao] erro ao gerar pptx:', err);
    toast('Erro ao gerar pptx. Verifique o console.', 'err');
  }
}

// Caminho de excecao para o sindico forcar geracao mesmo com inconsistencias
// acima de R$ 1,00. Exige duas confirmacoes antes de prosseguir.
async function prestacaoGerarMesmoAssim() {
  const conf1 = window.confirm('Existem diferenças maiores que R$ 1,00 entre os valores. Gerar a apresentação mesmo assim pode levar a erros na assembleia. Tem certeza?');
  if (!conf1) return;
  const conf2 = window.confirm('Confirma definitivamente que quer gerar com inconsistencias acima de R$ 1,00?');
  if (!conf2) return;
  prestacaoAtualizarDadosEdicao();
  const dados = prestacaoState.dadosEditaveis;
  try {
    toast('Gerando pptx (modo urgencia)...', 'info');
    await prestacaoMontarPptx(dados);
    toast('Pptx gerado em modo urgencia.', 'ok');
    prestacaoFecharModal();
  } catch (err) {
    console.error('[prestacao] erro ao gerar pptx em urgencia:', err);
    toast('Erro ao gerar pptx. Verifique o console.', 'err');
  }
}

// Tema visual unico do pptx. Cores em hex sem cardinal (formato PptxGenJS).
const PRESTACAO_THEME = {
  bgDark: '0A1733',
  navy: '143A87',
  navyDeep: '0A2463',
  blue: '1E5AA8',
  blueMid: '2E7BC7',
  blueLight: '5299DC',
  bluePale: '7FB5E3',
  amber: 'E88B1A',
  amberLight: 'FDE9CC',
  positive: '228B54',
  negative: 'C03B3B',
  grayText: '3E5676',
  grayMuted: '8B9AB8',
  grayBg: 'F7F9FC',
  grayLine: 'E2E8F0',
  white: 'FFFFFF',
  catColors: ['1E734A', '359E66', '143A87', '1E5AA8', '2E7BC7', '5299DC', '5B6A88', '7F8FA8', 'A5B0C2']
};

const PRESTACAO_MESES_INICIAL = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const PRESTACAO_MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const PRESTACAO_MESES_COMPLETO = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// ============================================================
// ONDA 1 — Dicionários de nomes curados, reroteamento por grupo e
// descrições curatoriais. Reflete a skill ata-condominial e o
// template_prestacao.py (referência canônica das 9 categorias de
// despesa e 5 fontes de receita).
// ============================================================

// Nomes curados (Superlógica devolve CAPS bruto; aqui virar prosa formal).
const PRESTACAO_CATEGORY_NAMES = {
  'DESPESA COM PESSOAL': 'Despesas com pessoal',
  'DESPESAS COM PESSOAL': 'Despesas com pessoal',
  'DESPESAS COM CONSUMO': 'Despesas com consumo',
  'MANUTENÇÃO': 'Contratos de manutenção',
  'MANUTENCAO': 'Contratos de manutenção',
  'AQUISIÇÃO DE MATERIAIS': 'Aquisição de materiais',
  'RETENÇÕES - NOTAS FISCAIS': 'Retenções e tributos',
  'RETENÇÕES': 'Retenções e tributos',
  'DESPESA COM ADMINISTRATIVO': 'Despesas administrativas',
  'ADMINISTRATIVO': 'Despesas administrativas',
  'SERVIÇOS': 'Serviços contratados',
  'INVESTIMENTO - IMOBILIZADO': 'Investimento (imobilizado)',
  'INVESTIMENTO': 'Investimento (imobilizado)',
  'DESPESAS FINANCEIRAS': 'Despesas financeiras',
};
function prestacaoGetCategoryName(raw) {
  return PRESTACAO_CATEGORY_NAMES[(raw || '').toUpperCase().trim()] || (raw || '').trim();
}

// Roteamento de subcategoria para grupo canônico. Cobre os agrupamentos do
// template_prestacao.py (referência). Match por substring lower-case.
const PRESTACAO_SUBCATEGORY_TO_GROUP = {
  'Contrato Mão de Obra Terceirizada': 'Despesas com pessoal',
  'Salários': 'Despesas com pessoal',
  'Encargos': 'Despesas com pessoal',
  'INSS Patronal': 'Despesas com pessoal',
  'Cestas Básicas': 'Despesas com pessoal',
  'Vale Transporte': 'Despesas com pessoal',
  'Água e Esgoto': 'Despesas com consumo',
  'Energia Elétrica': 'Despesas com consumo',
  'Telefone': 'Despesas com consumo',
  'Internet': 'Despesas com consumo',
  'Gás': 'Despesas com consumo',
  'CFTV': 'Contratos de manutenção',
  'Elevador': 'Contratos de manutenção',
  'Bombas': 'Contratos de manutenção',
  'Piscina': 'Contratos de manutenção',
  'Jardinagem': 'Contratos de manutenção',
  'Desinsetização': 'Contratos de manutenção',
  'Material de Limpeza': 'Aquisição de materiais',
  'Material de Construção': 'Aquisição de materiais',
  'Material Elétrico': 'Aquisição de materiais',
  'Material de Obras': 'Aquisição de materiais',
  'DARF': 'Retenções e tributos',
  'ISS': 'Retenções e tributos',
  'IRRF': 'Retenções e tributos',
  'Honorários Síndico': 'Despesas administrativas',
  'Honorários Administrativos': 'Despesas administrativas',
  'Honorários Advocatícios': 'Despesas administrativas',
  'Comissão de Cobrança': 'Despesas administrativas',
  'Cartório': 'Despesas administrativas',
  'Seguro Condominial': 'Serviços contratados',
  'Sistema de Incêndio': 'Serviços contratados',
  'Obras e Melhorias': 'Serviços contratados',
  'Marcenaria': 'Investimento (imobilizado)',
  'Móveis': 'Investimento (imobilizado)',
  'Eletrodomésticos': 'Investimento (imobilizado)',
  'Tarifas Bancárias': 'Despesas financeiras',
  'IRRF Poupança': 'Despesas financeiras',
  'Reembolsos': 'Despesas financeiras',
};

// Ordem canônica dos 9 grupos no slide Estrutura de Despesas e nos
// 9 slides de detalhamento. Mantém alinhamento com PRESTACAO_THEME.catColors.
const PRESTACAO_GRUPOS_ORDEM = [
  'Despesas com pessoal',
  'Despesas com consumo',
  'Contratos de manutenção',
  'Aquisição de materiais',
  'Retenções e tributos',
  'Despesas administrativas',
  'Serviços contratados',
  'Investimento (imobilizado)',
  'Despesas financeiras',
];

// Roteamento de receita para fonte agrupada (slide Origem da Receita).
const PRESTACAO_RECEITA_TO_FONTE = {
  'Taxa de Condomínio': 'Taxa de Condomínio (Ordinária e Fundos)',
  'Fundo de Reserva': 'Taxa de Condomínio (Ordinária e Fundos)',
  'Fundo de Inadimplência': 'Taxa de Condomínio (Ordinária e Fundos)',
  'Água Individual': 'Água e Esgoto',
  'Parcela Fixa': 'Água e Esgoto',
  'Água Comum': 'Água e Esgoto',
  'Acordos': 'Acordos e Negociações',
  'Energia Comum': 'Energia Repassada',
  'Energia Bloco': 'Energia Repassada',
  'Taxa Extra': 'Taxa Extra',
  'Churrasqueira': 'Áreas Comuns',
  'Salão de Festas': 'Áreas Comuns',
};

function prestacaoGetGrupo(subcategoria) {
  const sub = String(subcategoria || '').toLowerCase();
  for (const key in PRESTACAO_SUBCATEGORY_TO_GROUP) {
    if (sub.indexOf(key.toLowerCase()) !== -1) return PRESTACAO_SUBCATEGORY_TO_GROUP[key];
  }
  // Fallback: usa o nome curado da categoria. Loga warn para telemetria de cobertura
  // do dicionário (cada warn em prod indica subcategoria nova do Superlógica a mapear).
  if (sub) console.warn('[prestacao] subcategoria não mapeada em PRESTACAO_SUBCATEGORY_TO_GROUP:', subcategoria);
  return prestacaoGetCategoryName(subcategoria);
}

function prestacaoGetFonte(receita) {
  const r = String(receita || '').toLowerCase();
  for (const key in PRESTACAO_RECEITA_TO_FONTE) {
    if (r.indexOf(key.toLowerCase()) !== -1) return PRESTACAO_RECEITA_TO_FONTE[key];
  }
  return 'Outras Receitas e Ajustes';
}

// Descrições curatoriais. Aparecem no card navy do detalhamento, substituindo
// os textos genéricos "Maior categoria do exercício" / "Categoria componente".
const PRESTACAO_DESCRICOES_GRUPO = {
  'Despesas com pessoal': 'Contrato mensal de mão de obra terceirizada (porteiros, zeladoria, limpeza). Inclui encargos sociais, INSS patronal, vale transporte e benefícios.',
  'Despesas com consumo': 'Despesas com concessionárias de serviços essenciais: água, esgoto, energia elétrica, telefone, internet e gás.',
  'Contratos de manutenção': 'Contratos mensais de manutenção preventiva e corretiva: elevadores, bombas, CFTV, piscina, reservatórios, jardinagem e áreas comuns.',
  'Aquisição de materiais': 'Materiais consumidos nas manutenções e operações do condomínio: limpeza, construção, elétrico, informática e obras.',
  'Retenções e tributos': 'Tributos retidos sobre notas fiscais de prestadores: INSS via DARF, ISS municipal e IRRF. Recolhimento obrigatório mensal.',
  'Despesas administrativas': 'Honorários de gestão, assessoria jurídica, cobrança e despesas operacionais da administração: cartório, combustível e material de expediente.',
  'Serviços contratados': 'Serviços pontuais e contratos de cobertura: seguro condominial, sistema de incêndio, reparos e serviços especializados.',
  'Investimento (imobilizado)': 'Aquisição de bens duráveis para o patrimônio do condomínio: móveis, eletrodomésticos, equipamentos e benfeitorias.',
  'Despesas financeiras': 'Tarifas bancárias, IOF, IRRF sobre rendimentos de poupança e eventuais ajustes financeiros do exercício.',
};
function prestacaoGetDescricao(grupo) {
  return PRESTACAO_DESCRICOES_GRUPO[grupo] || ('Despesas do grupo ' + grupo + ' no exercício.');
}

// Agrupa um array de categorias do JSON em buckets por grupo canônico.
// Cada bucket carrega o total somado, as subcategorias originais (para a tabela
// da direita) e a distribuição temporal agregada (para o mini gráfico do card).
// Retorna lista na ordem de PRESTACAO_GRUPOS_ORDEM, omitindo grupos com total 0.
function prestacaoAgruparDespesas(categorias) {
  const buckets = {};
  (categorias || []).forEach(function(cat) {
    if (!cat) return;
    const grupo = prestacaoGetGrupo(cat.categoria);
    if (!buckets[grupo]) {
      buckets[grupo] = {
        grupo: grupo,
        total: 0,
        subcategorias: [],
        distribuicaoTemporal: new Array(12).fill(0),
        granularidade: 'mensal'
      };
    }
    const v = Number(cat.valor) || 0;
    buckets[grupo].total += v;
    buckets[grupo].subcategorias.push({
      nome: prestacaoGetCategoryName(cat.categoria),
      valor: v,
      distribuicaoTemporal: Array.isArray(cat.distribuicaoTemporal) ? cat.distribuicaoTemporal : null
    });
    // Soma a distribuição mensal quando disponível.
    if (Array.isArray(cat.distribuicaoTemporal) && cat.granularidade === 'mensal') {
      for (let i = 0; i < Math.min(12, cat.distribuicaoTemporal.length); i++) {
        buckets[grupo].distribuicaoTemporal[i] += Number(cat.distribuicaoTemporal[i]) || 0;
      }
    }
  });
  // Devolve grupos na ordem canônica, depois grupos não previstos por valor desc.
  const ordenados = [];
  PRESTACAO_GRUPOS_ORDEM.forEach(function(g) {
    if (buckets[g] && buckets[g].total > 0) {
      ordenados.push(buckets[g]);
      delete buckets[g];
    }
  });
  Object.keys(buckets)
    .map(function(k) { return buckets[k]; })
    .filter(function(b) { return b.total > 0; })
    .sort(function(a, b) { return b.total - a.total; })
    .forEach(function(b) { ordenados.push(b); });
  return ordenados;
}

// Agrupa receitas em fontes (slide Origem da Receita). Devolve lista ordenada
// por valor desc, sem ordem canônica.
function prestacaoAgruparReceitas(categorias) {
  const buckets = {};
  (categorias || []).forEach(function(cat) {
    if (!cat) return;
    const fonte = prestacaoGetFonte(cat.categoria);
    if (!buckets[fonte]) buckets[fonte] = { fonte: fonte, total: 0, subcategorias: [] };
    const v = Number(cat.valor) || 0;
    buckets[fonte].total += v;
    buckets[fonte].subcategorias.push({ nome: prestacaoGetCategoryName(cat.categoria), valor: v });
  });
  return Object.keys(buckets)
    .map(function(k) { return buckets[k]; })
    .filter(function(b) { return b.total > 0; })
    .sort(function(a, b) { return b.total - a.total; });
}

// Consolida grupos em formato { categoria, valor } compatível com o slide
// Estrutura de Despesas (que originalmente esperava dados.despesasPorCategoria).
function prestacaoConsolidarDespesasPorGrupo(grupos) {
  return (grupos || []).map(function(g) {
    return { categoria: g.grupo, valor: g.total };
  });
}

// Consolida fontes em formato { categoria, valor } compatível com o slide
// Origem da Receita (que originalmente esperava dados.receitas.porCategoria).
function prestacaoConsolidarReceitasPorFonte(fontes) {
  return (fontes || []).map(function(f) {
    return { categoria: f.fonte, valor: f.total };
  });
}

// Calcula o superavit mes a mes a partir das duas distribuicoes temporais.
function prestacaoCalcularSuperavitMensal(receitas, despesas) {
  const r = Array.isArray(receitas) ? receitas : [];
  const d = Array.isArray(despesas) ? despesas : [];
  const len = Math.max(r.length, d.length, 12);
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push((Number(r[i]) || 0) - (Number(d[i]) || 0));
  }
  return out;
}

// Conta quantos meses do array tem valor estritamente maior que zero.
function prestacaoMesesPositivos(arr) {
  if (!Array.isArray(arr)) return 0;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (Number(arr[i]) > 0) count++;
  }
  return count;
}

// Retorna a variacao percentual entre inicial e final, tratando divisao por zero.
function prestacaoCrescimentoPercentual(inicial, final) {
  const ini = Number(inicial) || 0;
  const fim = Number(final) || 0;
  if (ini === 0) return fim === 0 ? 0 : null;
  return ((fim - ini) / Math.abs(ini)) * 100;
}

// Detecta se ha um mes outlier no array (acima de 150% da media dos meses
// com valor maior que zero) e devolve metadados para uma caixa de aviso.
function prestacaoDetectarOutlier(arr12) {
  const out = { temOutlier: false, indiceOutlier: -1, valorOutlier: 0, media: 0, descricao: '' };
  if (!Array.isArray(arr12) || arr12.length === 0) return out;
  const positivos = arr12.map(function(v) { return Math.abs(Number(v) || 0); }).filter(function(v) { return v > 0; });
  if (positivos.length === 0) return out;
  const media = positivos.reduce(function(a, b) { return a + b; }, 0) / positivos.length;
  out.media = media;
  let maiorIdx = -1;
  let maiorVal = 0;
  for (let i = 0; i < arr12.length; i++) {
    const v = Math.abs(Number(arr12[i]) || 0);
    if (v > maiorVal) { maiorVal = v; maiorIdx = i; }
  }
  if (maiorIdx >= 0 && maiorVal > media * 1.5) {
    out.temOutlier = true;
    out.indiceOutlier = maiorIdx;
    out.valorOutlier = maiorVal;
    const pctAcima = ((maiorVal - media) / media) * 100;
    const nome = PRESTACAO_MESES_CURTO[maiorIdx] || ('Mês ' + (maiorIdx + 1));
    out.descricao = 'Pico em ' + nome + ': ' + prestacaoFmtBRL(maiorVal) + ' (' + prestacaoFmtPct(pctAcima, 0) + ' acima da media mensal).';
  }
  return out;
}

// Formata um indice de mes (0 a 11) e ano numerico como "Janeiro/2025".
function prestacaoFmtMesAno(indiceMes, ano) {
  const idx = Number(indiceMes);
  if (isNaN(idx) || idx < 0 || idx > 11) return '';
  return PRESTACAO_MESES_COMPLETO[idx] + '/' + (ano || '');
}

// Tenta extrair um ano de 4 digitos de uma string como "Janeiro a Dezembro de 2025".
function prestacaoExtrairAno(periodo) {
  if (!periodo) return null;
  const m = String(periodo).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

// Cabecalho padrao usado nos slides internos (nao na capa nem no encerramento).
// Coloca eyebrow numero + secao, linha decorativa amber, titulo navy + accent
// blueMid, e subtitulo opcional em grayText.
function prestacaoSlideCabecalho(slide, numero, secao, tituloMain, tituloAccent, subtitulo) {
  slide.addText(numero + '   ' + secao, {
    x: 0.5, y: 0.4, w: 12.3, h: 0.3,
    fontSize: 11, bold: true, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'left', charSpacing: 4
  });
  slide.addShape('rect', {
    x: 0.5, y: 0.75, w: 0.8, h: 0.04,
    fill: { color: PRESTACAO_THEME.amber },
    line: { color: PRESTACAO_THEME.amber, width: 0 }
  });
  const partes = [];
  if (tituloMain) partes.push({ text: tituloMain, options: { color: PRESTACAO_THEME.navy, bold: true } });
  if (tituloMain && tituloAccent) partes.push({ text: ' ', options: { color: PRESTACAO_THEME.navy } });
  if (tituloAccent) partes.push({ text: tituloAccent, options: { color: PRESTACAO_THEME.blueMid, bold: true } });
  slide.addText(partes, {
    x: 0.5, y: 0.9, w: 12.3, h: 0.7,
    fontSize: 34, fontFace: 'Calibri', align: 'left'
  });
  if (subtitulo) {
    slide.addText(subtitulo, {
      x: 0.5, y: 1.62, w: 12.3, h: 0.4,
      fontSize: 14, color: PRESTACAO_THEME.grayText, fontFace: 'Calibri', align: 'left'
    });
  }
}

// Rodape institucional com entidade e exercicio. Usa caractere bullet como separador.
function prestacaoSlideRodape(slide, entidade, exercicio) {
  const sep = ' • ';
  const txt = String(entidade || '').toUpperCase() + sep + 'EXERCÍCIO ' + (exercicio || '');
  slide.addText(txt, {
    x: 0.5, y: 7.15, w: 12.3, h: 0.3,
    fontSize: 9, color: PRESTACAO_THEME.grayMuted, fontFace: 'Calibri', align: 'center', charSpacing: 3
  });
}

// Card retangular arredondado com label, valor grande e subtexto opcional.
function prestacaoSlideKpiCard(slide, x, y, w, h, label, valor, subtexto, corFundo, corTexto) {
  slide.addShape('roundRect', {
    x: x, y: y, w: w, h: h,
    fill: { color: corFundo },
    line: { color: corFundo, width: 0 },
    rectRadius: 0.08
  });
  slide.addText(String(label || '').toUpperCase(), {
    x: x + 0.18, y: y + 0.12, w: w - 0.36, h: 0.28,
    fontSize: 10, bold: true, color: corTexto, fontFace: 'Calibri', align: 'left', charSpacing: 3
  });
  const valY = y + 0.42;
  const valH = subtexto ? Math.max(0.3, h - 0.85) : Math.max(0.3, h - 0.5);
  slide.addText(String(valor || ''), {
    x: x, y: valY, w: w, h: valH,
    fontSize: 26, bold: true, color: corTexto, fontFace: 'Calibri', align: 'center', valign: 'middle'
  });
  if (subtexto) {
    slide.addText(subtexto, {
      x: x + 0.18, y: y + h - 0.4, w: w - 0.36, h: 0.3,
      fontSize: 11, color: corTexto, fontFace: 'Calibri', align: 'center'
    });
  }
}

// Mini grafico de barras desenhado manualmente com shapes. Para 12 valores
// adiciona iniciais de mes embaixo. Escala pelo maior valor absoluto.
function prestacaoSlideMiniBars(slide, x, y, w, h, valores, corBar, corLabel) {
  if (!Array.isArray(valores) || valores.length === 0) return;
  let max = 0;
  for (let i = 0; i < valores.length; i++) {
    const v = Math.abs(Number(valores[i]) || 0);
    if (v > max) max = v;
  }
  if (max === 0) max = 1;
  const labelH = (valores.length === 12) ? 0.18 : 0;
  const barAreaH = h - labelH;
  const gap = 0.04;
  const barW = (w - gap * (valores.length - 1)) / valores.length;
  for (let i = 0; i < valores.length; i++) {
    const v = Math.abs(Number(valores[i]) || 0);
    const ratio = v / max;
    const bH = Math.max(0.03, ratio * barAreaH);
    const bX = x + i * (barW + gap);
    const bY = y + (barAreaH - bH);
    slide.addShape('rect', {
      x: bX, y: bY, w: barW, h: bH,
      fill: { color: corBar },
      line: { color: corBar, width: 0 }
    });
    if (labelH > 0) {
      slide.addText(PRESTACAO_MESES_INICIAL[i] || '', {
        x: bX, y: y + barAreaH + 0.02, w: barW, h: labelH,
        fontSize: 7, color: corLabel, fontFace: 'Calibri', align: 'center'
      });
    }
  }
}

// Caixa amber light com borda amber e simbolo de aviso para destacar outliers.
function prestacaoSlideCaixaAviso(slide, x, y, w, texto) {
  const h = 0.4;
  slide.addShape('roundRect', {
    x: x, y: y, w: w, h: h,
    fill: { color: PRESTACAO_THEME.amberLight },
    line: { color: PRESTACAO_THEME.amber, width: 0.75 },
    rectRadius: 0.05
  });
  slide.addText('!  ' + (texto || ''), {
    x: x + 0.18, y: y, w: w - 0.36, h: h,
    fontSize: 10, color: '8B5A00', fontFace: 'Calibri', align: 'left', valign: 'middle'
  });
}

// Slide 1: capa do deck com fundo escuro, titulo grande e periodo.
function prestacaoSlideCapa(pptx, dados, ano, entidade, periodo) {
  const slide = pptx.addSlide();
  slide.background = { color: PRESTACAO_THEME.bgDark };
  slide.addText('PRESTAÇÃO DE CONTAS', {
    x: 0.7, y: 0.7, w: 12, h: 0.4,
    fontSize: 14, bold: true, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'left', charSpacing: 6
  });
  slide.addText(String(entidade || 'Condominio').toUpperCase(), {
    x: 0.7, y: 1.6, w: 12, h: 1.4,
    fontSize: 60, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left'
  });
  slide.addText('EXERCÍCIO ' + (ano || ''), {
    x: 0.7, y: 3.0, w: 12, h: 1.0,
    fontSize: 60, bold: true, color: PRESTACAO_THEME.blueLight, fontFace: 'Calibri', align: 'left'
  });
  slide.addShape('rect', {
    x: 0.7, y: 4.3, w: 1.5, h: 0.05,
    fill: { color: PRESTACAO_THEME.amber },
    line: { color: PRESTACAO_THEME.amber, width: 0 }
  });
  if (periodo) {
    slide.addText(String(periodo), {
      x: 0.7, y: 4.5, w: 12, h: 0.5,
      fontSize: 18, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'left'
    });
  }
  if (dados.cabecalho && dados.cabecalho.dataApresentacao) {
    slide.addText('Apresentado em ' + dados.cabecalho.dataApresentacao, {
      x: 0.7, y: 6.7, w: 12, h: 0.4,
      fontSize: 11, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'left'
    });
  }
}

// Slide 2: visao geral com 5 KPIs e faixa amber com 3 indicadores na base.
function prestacaoSlideVisaoGeral(pptx, dados, entidade, ano) {
  const slide = pptx.addSlide();
  prestacaoSlideCabecalho(slide, '01', 'VISÃO GERAL', 'Resultado consolidado do', 'exercício', 'Números principais do período apurado.');

  const sIni = Number(dados.saldo && dados.saldo.inicial) || 0;
  const sFim = Number(dados.saldo && dados.saldo.final) || 0;
  const recT = Number(dados.receitas && dados.receitas.total) || 0;
  const despT = Number(dados.despesas && dados.despesas.total) || 0;
  const sup = recT - despT;

  prestacaoSlideKpiCard(slide, 0.5, 2.2, 4.0, 1.4, 'Saldo Inicial', prestacaoFmtBRL(sIni), 'Caixa em ' + (ano - 1), PRESTACAO_THEME.blue, PRESTACAO_THEME.white);
  prestacaoSlideKpiCard(slide, 4.7, 2.2, 4.0, 1.4, 'Receita', prestacaoFmtBRL(recT), 'Total arrecadado', PRESTACAO_THEME.navyDeep, PRESTACAO_THEME.white);
  prestacaoSlideKpiCard(slide, 8.9, 2.2, 4.0, 1.4, 'Despesa', prestacaoFmtBRL(despT), 'Total pago', PRESTACAO_THEME.blueMid, PRESTACAO_THEME.white);

  const corSup = sup < 0 ? PRESTACAO_THEME.negative : PRESTACAO_THEME.positive;
  const labelSup = sup < 0 ? 'Déficit' : 'Superávit';
  prestacaoSlideKpiCard(slide, 0.5, 3.85, 6.1, 1.4, labelSup, prestacaoFmtBRL(sup), 'Receita menos despesa', corSup, PRESTACAO_THEME.white);
  prestacaoSlideKpiCard(slide, 6.8, 3.85, 6.1, 1.4, 'Saldo Final', prestacaoFmtBRL(sFim), 'Caixa em ' + ano, PRESTACAO_THEME.navy, PRESTACAO_THEME.white);

  slide.addShape('rect', {
    x: 0.5, y: 5.6, w: 12.3, h: 1.0,
    fill: { color: PRESTACAO_THEME.amberLight },
    line: { color: PRESTACAO_THEME.amberLight, width: 0 }
  });

  const cobertura = despT > 0 ? (recT / despT) * 100 : 0;
  const pctSuperavit = recT > 0 ? (sup / recT) * 100 : 0;
  const crescSaldo = prestacaoCrescimentoPercentual(sIni, sFim);

  let crescTxt = '0%';
  if (crescSaldo === null) crescTxt = 'NA';
  else if (crescSaldo >= 200) crescTxt = 'Quase triplicou';
  else if (crescSaldo >= 100) crescTxt = 'Quase dobrou';
  else crescTxt = (crescSaldo >= 0 ? '+' : '') + crescSaldo.toFixed(1) + '%';

  slide.addText('COBERTURA DA RECEITA', { x: 0.7, y: 5.7, w: 4.0, h: 0.28, fontSize: 9, bold: true, color: '8B5A00', fontFace: 'Calibri', align: 'center', charSpacing: 3 });
  slide.addText(prestacaoFmtPct(cobertura, 0), { x: 0.7, y: 5.95, w: 4.0, h: 0.55, fontSize: 24, bold: true, color: PRESTACAO_THEME.navy, fontFace: 'Calibri', align: 'center' });

  slide.addText('PERCENTUAL DE SUPERÁVIT', { x: 4.8, y: 5.7, w: 4.0, h: 0.28, fontSize: 9, bold: true, color: '8B5A00', fontFace: 'Calibri', align: 'center', charSpacing: 3 });
  slide.addText(prestacaoFmtPct(pctSuperavit, 1), { x: 4.8, y: 5.95, w: 4.0, h: 0.55, fontSize: 24, bold: true, color: PRESTACAO_THEME.navy, fontFace: 'Calibri', align: 'center' });

  slide.addText('CRESCIMENTO DO SALDO', { x: 8.9, y: 5.7, w: 4.0, h: 0.28, fontSize: 9, bold: true, color: '8B5A00', fontFace: 'Calibri', align: 'center', charSpacing: 3 });
  slide.addText(crescTxt, { x: 8.9, y: 5.95, w: 4.0, h: 0.55, fontSize: 24, bold: true, color: PRESTACAO_THEME.navy, fontFace: 'Calibri', align: 'center' });

  prestacaoSlideRodape(slide, entidade, ano);
}

// Slide 3: evolucao mensal com 3 linhas (Receitas, Despesas, Saldo Acumulado)
// e 3 cards de medias mensais na base.
function prestacaoSlideEvolucaoMensal(pptx, dados, distRec, distDesp, saldoMensal, entidade, ano) {
  const slide = pptx.addSlide();
  prestacaoSlideCabecalho(slide, '02', 'EVOLUÇÃO', 'Receita e despesa', 'mês a mês', 'Acompanhamento mensal do exercício.');

  const sIni = Number(dados.saldo && dados.saldo.inicial) || 0;
  let saldoAc = [];
  if (Array.isArray(saldoMensal) && saldoMensal.length === 13) {
    saldoAc = saldoMensal.slice(1);
  } else if (Array.isArray(saldoMensal) && saldoMensal.length === 12) {
    saldoAc = saldoMensal.slice();
  } else {
    let acc = sIni;
    for (let i = 0; i < 12; i++) {
      acc = acc + (Number(distRec[i]) || 0) - (Number(distDesp[i]) || 0);
      saldoAc.push(acc);
    }
  }

  const recArr = (distRec || []).slice(0, 12);
  const despArr = (distDesp || []).slice(0, 12);
  while (recArr.length < 12) recArr.push(0);
  while (despArr.length < 12) despArr.push(0);

  const chartData = [
    { name: 'Receitas', labels: PRESTACAO_MESES_CURTO, values: recArr },
    { name: 'Despesas', labels: PRESTACAO_MESES_CURTO, values: despArr },
    { name: 'Saldo Acumulado', labels: PRESTACAO_MESES_CURTO, values: saldoAc.slice(0, 12) }
  ];

  slide.addChart(pptx.ChartType.line, chartData, {
    x: 0.5, y: 2.15, w: 12.3, h: 3.6,
    chartColors: [PRESTACAO_THEME.positive, PRESTACAO_THEME.negative, PRESTACAO_THEME.blueMid],
    showLegend: true, legendPos: 'b', legendFontSize: 10,
    catAxisLabelFontSize: 9, valAxisLabelFontSize: 9,
    lineSize: 2, lineDataSymbolSize: 5
  });

  const medRec = recArr.reduce(function(a, b) { return a + (Number(b) || 0); }, 0) / 12;
  const medDesp = despArr.reduce(function(a, b) { return a + (Number(b) || 0); }, 0) / 12;
  const medEcon = medRec - medDesp;

  prestacaoSlideKpiCard(slide, 0.5, 5.95, 4.0, 0.95, 'Média Receita', prestacaoFmtBRL(medRec), null, PRESTACAO_THEME.positive, PRESTACAO_THEME.white);
  prestacaoSlideKpiCard(slide, 4.7, 5.95, 4.0, 0.95, 'Média Despesa', prestacaoFmtBRL(medDesp), null, PRESTACAO_THEME.negative, PRESTACAO_THEME.white);
  prestacaoSlideKpiCard(slide, 8.9, 5.95, 4.0, 0.95, 'Média Economia', prestacaoFmtBRL(medEcon), null, PRESTACAO_THEME.blueMid, PRESTACAO_THEME.white);

  prestacaoSlideRodape(slide, entidade, ano);
}

// Slide 4: patrimonio. Linha unica do saldoMensal e 4 cards a direita com
// crescimento, saldo inicial, saldo final e superavit do periodo.
function prestacaoSlidePatrimonio(pptx, dados, saldoMensal, entidade, ano) {
  const slide = pptx.addSlide();
  const sIni = Number(dados.saldo && dados.saldo.inicial) || 0;
  const sFim = Number(dados.saldo && dados.saldo.final) || 0;
  const cresc = prestacaoCrescimentoPercentual(sIni, sFim);
  let subDinamico = 'Como o caixa evoluiu durante o exercício.';
  if (cresc !== null) {
    if (cresc >= 100) subDinamico = 'O patrimônio mais que dobrou no exercício.';
    else if (cresc >= 50) subDinamico = 'Crescimento expressivo do patrimônio.';
    else if (cresc >= 10) subDinamico = 'Patrimônio em crescimento solido.';
    else if (cresc >= 0) subDinamico = 'Patrimônio mantido com leve evolução.';
    else subDinamico = 'Patrimônio em retração no exercício.';
  }
  prestacaoSlideCabecalho(slide, '03', 'PATRIMÔNIO', 'Evolução do', 'caixa', subDinamico);

  let serie = [];
  let labels = [];
  if (Array.isArray(saldoMensal) && saldoMensal.length === 13) {
    serie = saldoMensal;
    labels = ['Início'].concat(PRESTACAO_MESES_CURTO);
  } else if (Array.isArray(saldoMensal) && saldoMensal.length === 12) {
    serie = saldoMensal;
    labels = PRESTACAO_MESES_CURTO;
  } else if (Array.isArray(saldoMensal) && saldoMensal.length === 5) {
    serie = saldoMensal;
    labels = ['Início', 'T1', 'T2', 'T3', 'T4'];
  } else {
    serie = [sIni, sFim];
    labels = ['Início', 'Fim'];
  }

  slide.addChart(pptx.ChartType.line, [
    { name: 'Saldo', labels: labels, values: serie }
  ], {
    x: 0.5, y: 2.2, w: 7.5, h: 4.5,
    chartColors: [PRESTACAO_THEME.blueMid],
    showLegend: false,
    catAxisLabelFontSize: 9, valAxisLabelFontSize: 9,
    lineSize: 3, lineDataSymbolSize: 6
  });

  const corCresc = (cresc !== null && cresc < 0) ? PRESTACAO_THEME.negative : PRESTACAO_THEME.amber;
  const labelCresc = (cresc !== null && cresc < 0) ? 'Retração' : 'Crescimento';
  let crescStr = 'NA';
  if (cresc !== null) crescStr = (cresc >= 0 ? '+' : '') + cresc.toFixed(0) + '%';

  slide.addShape('roundRect', { x: 8.3, y: 2.2, w: 4.5, h: 1.15, fill: { color: corCresc }, line: { color: corCresc, width: 0 }, rectRadius: 0.08 });
  slide.addText(labelCresc.toUpperCase(), { x: 8.5, y: 2.3, w: 4.2, h: 0.25, fontSize: 9, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left', charSpacing: 3 });
  slide.addText(crescStr, { x: 8.3, y: 2.55, w: 4.5, h: 0.7, fontSize: 48, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'center', valign: 'middle' });

  prestacaoSlideKpiCard(slide, 8.3, 3.45, 4.5, 1.05, 'Saldo Inicial', prestacaoFmtBRL(sIni), null, PRESTACAO_THEME.bluePale, PRESTACAO_THEME.navy);
  prestacaoSlideKpiCard(slide, 8.3, 4.6, 4.5, 1.05, 'Saldo Final', prestacaoFmtBRL(sFim), null, PRESTACAO_THEME.blueMid, PRESTACAO_THEME.white);
  prestacaoSlideKpiCard(slide, 8.3, 5.75, 4.5, 1.05, 'Superávit do Período', prestacaoFmtBRL(sFim - sIni), null, PRESTACAO_THEME.positive, PRESTACAO_THEME.white);

  prestacaoSlideRodape(slide, entidade, ano);
}

// Slide 5: superavit mensal em barras. Card grande com X de 12 meses positivos.
function prestacaoSlideSuperavitMensal(pptx, dados, superavitMensal, entidade, ano) {
  const slide = pptx.addSlide();
  prestacaoSlideCabecalho(slide, '04', 'RESULTADO LÍQUIDO', 'Superávit', 'mensal', 'Diferença entre receitas e despesas mes a mes.');

  const valores = (superavitMensal && superavitMensal.length) ? superavitMensal.slice(0, 12) : new Array(12).fill(0);
  const positivos = prestacaoMesesPositivos(valores);
  const supAnual = valores.reduce(function(a, b) { return a + (Number(b) || 0); }, 0);

  slide.addChart(pptx.ChartType.bar, [
    { name: 'Superávit', labels: PRESTACAO_MESES_CURTO, values: valores }
  ], {
    x: 0.5, y: 2.2, w: 8.0, h: 4.5,
    chartColors: [PRESTACAO_THEME.positive],
    barDir: 'col', barGrouping: 'clustered',
    showLegend: false,
    catAxisLabelFontSize: 9, valAxisLabelFontSize: 9
  });

  slide.addShape('roundRect', { x: 8.8, y: 2.2, w: 4.0, h: 2.7, fill: { color: PRESTACAO_THEME.positive }, line: { color: PRESTACAO_THEME.positive, width: 0 }, rectRadius: 0.08 });
  slide.addText('MESES POSITIVOS', { x: 8.95, y: 2.32, w: 3.7, h: 0.3, fontSize: 11, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left', charSpacing: 3 });
  slide.addText(String(positivos) + ' / 12', { x: 8.8, y: 2.7, w: 4.0, h: 1.85, fontSize: 80, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'center', valign: 'middle' });

  prestacaoSlideKpiCard(slide, 8.8, 5.05, 4.0, 1.65, 'Superávit Anual', prestacaoFmtBRL(supAnual), null, PRESTACAO_THEME.navy, PRESTACAO_THEME.white);

  prestacaoSlideRodape(slide, entidade, ano);
}

// Slide 6: origem da receita. Total grande a esquerda, lista de categorias a
// direita ordenada decrescente, faixa amber com insight automatico na base.
function prestacaoSlideOrigemReceita(pptx, dados, entidade, ano) {
  const slide = pptx.addSlide();
  prestacaoSlideCabecalho(slide, '05', 'ORIGEM DA RECEITA', 'Como o caixa', 'foi alimentado', 'Receitas por categoria no período.');

  const recT = Number(dados.receitas && dados.receitas.total) || 0;
  const cats = (dados.receitas && Array.isArray(dados.receitas.porCategoria)) ? dados.receitas.porCategoria.slice() : [];
  cats.sort(function(a, b) { return (Number(b.valor) || 0) - (Number(a.valor) || 0); });

  slide.addText('TOTAL', { x: 0.5, y: 2.4, w: 5.5, h: 0.4, fontSize: 12, bold: true, color: PRESTACAO_THEME.grayMuted, fontFace: 'Calibri', align: 'left', charSpacing: 4 });
  slide.addText(prestacaoFmtBRL(recT), { x: 0.5, y: 2.85, w: 5.5, h: 1.2, fontSize: 60, bold: true, color: PRESTACAO_THEME.navy, fontFace: 'Calibri', align: 'left' });
  slide.addText('Receita total no exercício', { x: 0.5, y: 4.1, w: 5.5, h: 0.4, fontSize: 12, color: PRESTACAO_THEME.grayText, fontFace: 'Calibri', align: 'left' });

  const listaX = 6.2;
  const itemH = cats.length > 0 ? Math.min(0.5, 4.0 / cats.length) : 0.5;
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    const v = Number(c.valor) || 0;
    const pct = recT > 0 ? (v / recT) * 100 : 0;
    const cor = i === 0 ? PRESTACAO_THEME.positive : PRESTACAO_THEME.blue;
    const yI = 2.2 + i * itemH;
    slide.addText(String(c.categoria || 'Sem nome'), { x: listaX, y: yI, w: 3.5, h: itemH, fontSize: 12, bold: i === 0, color: cor, fontFace: 'Calibri', align: 'left', valign: 'middle' });
    slide.addText(prestacaoFmtBRL(v), { x: listaX + 3.5, y: yI, w: 1.7, h: itemH, fontSize: 12, color: PRESTACAO_THEME.grayText, fontFace: 'Calibri', align: 'right', valign: 'middle' });
    slide.addText(prestacaoFmtPct(pct, 1), { x: listaX + 5.2, y: yI, w: 1.5, h: itemH, fontSize: 12, bold: true, color: cor, fontFace: 'Calibri', align: 'right', valign: 'middle' });
  }

  if (cats.length > 0) {
    const principal = cats[0];
    const pctPrinc = recT > 0 ? ((Number(principal.valor) || 0) / recT) * 100 : 0;
    slide.addShape('rect', { x: 0.5, y: 6.4, w: 12.3, h: 0.5, fill: { color: PRESTACAO_THEME.amberLight }, line: { color: PRESTACAO_THEME.amberLight, width: 0 } });
    slide.addText(String(principal.categoria || 'Categoria principal') + ' representa ' + prestacaoFmtPct(pctPrinc, 1) + ' da receita do exercício.', {
      x: 0.7, y: 6.4, w: 11.9, h: 0.5,
      fontSize: 11, bold: true, color: '8B5A00', fontFace: 'Calibri', align: 'left', valign: 'middle'
    });
  }

  prestacaoSlideRodape(slide, entidade, ano);
}

// Slide 7: estrutura de despesas. Total grande a esquerda, lista de categorias
// a direita ordenada decrescente, com bullet colorido por catColors em ordem.
function prestacaoSlideEstruturaDespesas(pptx, dados, entidade, ano) {
  const slide = pptx.addSlide();
  prestacaoSlideCabecalho(slide, '06', 'ESTRUTURA DE DESPESAS', 'Para onde foi', 'o dinheiro', 'Despesas por categoria no período.');

  const despT = Number(dados.despesas && dados.despesas.total) || 0;
  const cats = Array.isArray(dados.despesasPorCategoria) ? dados.despesasPorCategoria.slice() : [];
  cats.sort(function(a, b) { return (Number(b.valor) || 0) - (Number(a.valor) || 0); });

  slide.addText('TOTAL', { x: 0.5, y: 2.4, w: 5.5, h: 0.4, fontSize: 12, bold: true, color: PRESTACAO_THEME.grayMuted, fontFace: 'Calibri', align: 'left', charSpacing: 4 });
  slide.addText(prestacaoFmtBRL(despT), { x: 0.5, y: 2.85, w: 5.5, h: 1.2, fontSize: 60, bold: true, color: PRESTACAO_THEME.navy, fontFace: 'Calibri', align: 'left' });
  slide.addText('Despesa total no exercício', { x: 0.5, y: 4.1, w: 5.5, h: 0.4, fontSize: 12, color: PRESTACAO_THEME.grayText, fontFace: 'Calibri', align: 'left' });

  const listaX = 6.2;
  const itemH = cats.length > 0 ? Math.min(0.45, 4.5 / cats.length) : 0.45;
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    const v = Number(c.valor) || 0;
    const pct = despT > 0 ? (v / despT) * 100 : 0;
    const corHex = PRESTACAO_THEME.catColors[i % PRESTACAO_THEME.catColors.length];
    const yI = 2.2 + i * itemH;
    slide.addShape('rect', { x: listaX, y: yI + itemH * 0.3, w: 0.15, h: itemH * 0.4, fill: { color: corHex }, line: { color: corHex, width: 0 } });
    slide.addText(String(c.categoria || 'Sem nome'), { x: listaX + 0.25, y: yI, w: 3.3, h: itemH, fontSize: 11, color: PRESTACAO_THEME.grayText, fontFace: 'Calibri', align: 'left', valign: 'middle' });
    slide.addText(prestacaoFmtBRL(v), { x: listaX + 3.55, y: yI, w: 1.7, h: itemH, fontSize: 11, color: PRESTACAO_THEME.grayText, fontFace: 'Calibri', align: 'right', valign: 'middle' });
    slide.addText(prestacaoFmtPct(pct, 1), { x: listaX + 5.25, y: yI, w: 1.5, h: itemH, fontSize: 11, bold: true, color: corHex, fontFace: 'Calibri', align: 'right', valign: 'middle' });
  }

  prestacaoSlideRodape(slide, entidade, ano);
}

// Slide de detalhamento de um GRUPO de despesa (Onda 1).
// Substitui o slide por categoria. O lado esquerdo carrega total do grupo,
// % do total de despesa e descrição curatorial. O lado direito lista as
// subcategorias do grupo com valor anual, em vez de quebra mensal.
function prestacaoSlideDetalhamentoGrupo(pptx, grupo, idx, entidade, ano, totalDespesas) {
  const slide = pptx.addSlide();
  const numero = idx + 8;
  const numStr = (numero < 10 ? '0' : '') + numero;
  // Cabeçalho: usa "Detalhamento" como seção e o nome do grupo como accent.
  // Quebra o nome em duas partes ("Despesas com" + "pessoal") quando possível
  // pra preservar a estética do template_prestacao.py.
  const partes = prestacaoQuebrarNomeGrupo(grupo.grupo);
  prestacaoSlideCabecalho(slide, numStr, 'DETALHAMENTO DE DESPESAS', partes.main, partes.accent, '');

  const valor = Number(grupo.total) || 0;
  const total = Number(totalDespesas) || 0;
  const pct = total > 0 ? (valor / total) * 100 : 0;

  slide.addShape('rect', { x: 0.5, y: 2.2, w: 5.2, h: 4.75, fill: { color: PRESTACAO_THEME.navy }, line: { color: PRESTACAO_THEME.navy, width: 0 } });
  slide.addShape('rect', { x: 0.7, y: 2.4, w: 0.3, h: 0.3, fill: { color: PRESTACAO_THEME.amber }, line: { color: PRESTACAO_THEME.amber, width: 0 } });
  slide.addText('TOTAL DO GRUPO', { x: 0.7, y: 2.8, w: 4.8, h: 0.3, fontSize: 11, bold: true, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'left', charSpacing: 3 });
  slide.addText(prestacaoFmtBRL(valor), { x: 0.7, y: 3.1, w: 4.8, h: 0.6, fontSize: 34, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left' });
  slide.addText(prestacaoFmtPct(pct, 1) + ' DA DESPESA ANUAL', { x: 0.7, y: 3.78, w: 4.8, h: 0.3, fontSize: 10, bold: true, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'left', charSpacing: 3 });
  slide.addShape('rect', { x: 0.7, y: 4.15, w: 1.0, h: 0.03, fill: { color: PRESTACAO_THEME.bluePale }, line: { color: PRESTACAO_THEME.bluePale, width: 0 } });

  // Descrição curatorial substitui "Maior categoria do exercício" genérico.
  const descricao = prestacaoGetDescricao(grupo.grupo);
  slide.addText(descricao, { x: 0.7, y: 4.3, w: 4.8, h: 0.85, fontSize: 11, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left' });
  slide.addText('DISTRIBUIÇÃO MENSAL', { x: 0.7, y: 5.25, w: 4.8, h: 0.3, fontSize: 10, bold: true, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'left', charSpacing: 3 });

  const distArr = Array.isArray(grupo.distribuicaoTemporal) ? grupo.distribuicaoTemporal : null;
  if (distArr && distArr.length === 12) {
    prestacaoSlideMiniBars(slide, 0.7, 5.6, 4.8, 1.2, distArr, PRESTACAO_THEME.white, PRESTACAO_THEME.bluePale);
  } else {
    slide.addText('Sem distribuição mensal disponível', { x: 0.7, y: 5.6, w: 4.8, h: 0.4, fontSize: 11, italic: true, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'left' });
  }

  // Lado direito: subcategorias com valor anual (em vez de quebra mensal).
  const subs = (grupo.subcategorias || []).slice().sort(function(a, b) { return (Number(b.valor) || 0) - (Number(a.valor) || 0); });
  const linhas = subs.length > 0
    ? subs.map(function(s) { return { rotulo: s.nome || 'Sem nome', valor: Number(s.valor) || 0 }; })
    : [{ rotulo: grupo.grupo, valor: valor }];

  const tabelaX = 6.0;
  const tabelaY = 2.2;
  const tabelaW = 6.8;
  const headerH = 0.4;
  const totalRowH = 0.5;
  const dispH = 4.75 - headerH - totalRowH;
  let fontHeader = 11;
  let fontRow = 10;
  if (linhas.length > 12 && linhas.length <= 16) { fontHeader = 10; fontRow = 9; }
  else if (linhas.length > 16) { fontHeader = 9; fontRow = 8; }
  const rowH = dispH / Math.max(linhas.length, 1);

  slide.addShape('rect', { x: tabelaX, y: tabelaY, w: tabelaW, h: headerH, fill: { color: PRESTACAO_THEME.navy }, line: { color: PRESTACAO_THEME.navy, width: 0 } });
  slide.addText('LANÇAMENTOS DO EXERCÍCIO', { x: tabelaX + 0.15, y: tabelaY, w: tabelaW * 0.6, h: headerH, fontSize: fontHeader, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left', valign: 'middle', charSpacing: 3 });
  slide.addText('VALOR', { x: tabelaX + tabelaW * 0.6, y: tabelaY, w: tabelaW * 0.4 - 0.15, h: headerH, fontSize: fontHeader, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'right', valign: 'middle', charSpacing: 3 });

  for (let i = 0; i < linhas.length; i++) {
    const yI = tabelaY + headerH + i * rowH;
    const fill = i % 2 === 0 ? PRESTACAO_THEME.white : PRESTACAO_THEME.grayBg;
    slide.addShape('rect', { x: tabelaX, y: yI, w: tabelaW, h: rowH, fill: { color: fill }, line: { color: PRESTACAO_THEME.grayLine, width: 0.25 } });
    slide.addText(String(linhas[i].rotulo), { x: tabelaX + 0.15, y: yI, w: tabelaW * 0.6, h: rowH, fontSize: fontRow, color: PRESTACAO_THEME.grayText, fontFace: 'Calibri', align: 'left', valign: 'middle' });
    slide.addText(prestacaoFmtBRL(linhas[i].valor), { x: tabelaX + tabelaW * 0.6, y: yI, w: tabelaW * 0.4 - 0.15, h: rowH, fontSize: fontRow, color: PRESTACAO_THEME.grayText, fontFace: 'Calibri', align: 'right', valign: 'middle' });
  }

  const totalY = tabelaY + headerH + linhas.length * rowH;
  slide.addShape('rect', { x: tabelaX, y: totalY, w: tabelaW, h: totalRowH, fill: { color: PRESTACAO_THEME.navy }, line: { color: PRESTACAO_THEME.navy, width: 0 } });
  slide.addText('TOTAL ' + (grupo.grupo || '').toUpperCase(), { x: tabelaX + 0.15, y: totalY, w: tabelaW * 0.6, h: totalRowH, fontSize: fontHeader, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left', valign: 'middle', charSpacing: 3 });
  slide.addText(prestacaoFmtBRL(valor), { x: tabelaX + tabelaW * 0.6, y: totalY, w: tabelaW * 0.4 - 0.15, h: totalRowH, fontSize: fontHeader, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'right', valign: 'middle' });

  prestacaoSlideRodape(slide, entidade, ano);
}

// Quebra "Despesas com pessoal" em ("Despesas com", "pessoal") para o cabeçalho
// bicromático (main em navy + accent em azul médio). Quando o nome não tem
// estrutura clara, devolve tudo em main e vazio em accent.
function prestacaoQuebrarNomeGrupo(nome) {
  const s = String(nome || '').trim();
  if (!s) return { main: 'Despesas', accent: '' };
  // Regras pré-definidas espelham o template_prestacao.py.
  const regras = [
    { test: /^Despesas com /i, main: 'Despesas com', accentFn: function(x) { return x.slice(13); } },
    { test: /^Despesas administrativas/i, main: 'Despesas', accentFn: function() { return 'administrativas'; } },
    { test: /^Despesas financeiras/i, main: 'Despesas', accentFn: function() { return 'financeiras'; } },
    { test: /^Contratos de manutenção/i, main: 'Contratos de', accentFn: function() { return 'manutenção'; } },
    { test: /^Aquisição de materiais/i, main: 'Aquisição de', accentFn: function() { return 'materiais'; } },
    { test: /^Retenções e tributos/i, main: 'Retenções e', accentFn: function() { return 'tributos'; } },
    { test: /^Serviços contratados/i, main: 'Serviços', accentFn: function() { return 'contratados'; } },
    { test: /^Investimento/i, main: 'Investimento', accentFn: function(x) { return x.slice(13).trim() || 'imobilizado'; } },
  ];
  for (const r of regras) {
    if (r.test.test(s)) return { main: r.main, accent: r.accentFn(s) };
  }
  // Fallback: usa a última palavra como accent.
  const partes = s.split(' ');
  if (partes.length >= 2) {
    return { main: partes.slice(0, -1).join(' '), accent: partes[partes.length - 1] };
  }
  return { main: s, accent: '' };
}

// Slide final: encerramento com fundo escuro, painel grande do saldoMensal a
// esquerda, mini barras inicio vs fim e cards de crescimento e cobertura a
// direita, e tira inferior com dois retangulos lado a lado.
function prestacaoSlideEncerramento(pptx, dados, saldoMensal, superavitMensal, entidade, ano) {
  const slide = pptx.addSlide();
  slide.background = { color: PRESTACAO_THEME.bgDark };

  const sIni = Number(dados.saldo && dados.saldo.inicial) || 0;
  const sFim = Number(dados.saldo && dados.saldo.final) || 0;
  const recT = Number(dados.receitas && dados.receitas.total) || 0;
  const despT = Number(dados.despesas && dados.despesas.total) || 0;
  const cresc = prestacaoCrescimentoPercentual(sIni, sFim);
  const cobertura = despT > 0 ? (recT / despT) * 100 : 0;
  const positivos = prestacaoMesesPositivos(superavitMensal);

  slide.addText('ENCERRAMENTO   BALANÇO DO EXERCÍCIO', {
    x: 0.5, y: 0.5, w: 12.3, h: 0.3,
    fontSize: 12, bold: true, color: PRESTACAO_THEME.amber, fontFace: 'Calibri', align: 'left', charSpacing: 5
  });

  slide.addText([
    { text: 'O ano em ', options: { color: PRESTACAO_THEME.white, bold: true } },
    { text: 'números', options: { color: PRESTACAO_THEME.amber, bold: true } }
  ], {
    x: 0.5, y: 0.9, w: 12.3, h: 0.85,
    fontSize: 44, fontFace: 'Calibri', align: 'left'
  });

  slide.addText('Como o patrimônio do condomínio evoluiu ao longo do exercício', {
    x: 0.5, y: 1.85, w: 12.3, h: 0.4,
    fontSize: 14, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'left'
  });

  slide.addShape('roundRect', {
    x: 0.5, y: 2.5, w: 7.6, h: 4.0,
    fill: { color: PRESTACAO_THEME.navyDeep },
    line: { color: PRESTACAO_THEME.navyDeep, width: 0 },
    rectRadius: 0.1
  });
  slide.addText('EVOLUÇÃO DO PATRIMÔNIO EM CAIXA', {
    x: 0.7, y: 2.65, w: 7.2, h: 0.3,
    fontSize: 11, bold: true, color: PRESTACAO_THEME.amber, fontFace: 'Calibri', align: 'left', charSpacing: 4
  });

  let serie = [];
  let labels = [];
  if (Array.isArray(saldoMensal) && saldoMensal.length === 13) {
    serie = saldoMensal;
    labels = ['Início'].concat(PRESTACAO_MESES_CURTO);
  } else if (Array.isArray(saldoMensal) && saldoMensal.length === 12) {
    serie = saldoMensal;
    labels = PRESTACAO_MESES_CURTO;
  } else if (Array.isArray(saldoMensal) && saldoMensal.length === 5) {
    serie = saldoMensal;
    labels = ['Início', 'T1', 'T2', 'T3', 'T4'];
  } else {
    serie = [sIni, sFim];
    labels = ['Início', 'Fim'];
  }
  const ref = serie.map(function() { return sIni; });

  slide.addChart(pptx.ChartType.line, [
    { name: 'Saldo', labels: labels, values: serie },
    { name: 'Referencia', labels: labels, values: ref }
  ], {
    x: 0.7, y: 3.0, w: 7.2, h: 3.3,
    chartColors: [PRESTACAO_THEME.amber, PRESTACAO_THEME.bluePale],
    showLegend: false,
    catAxisLabelFontSize: 9, catAxisLabelColor: PRESTACAO_THEME.bluePale,
    valAxisLabelFontSize: 9, valAxisLabelColor: PRESTACAO_THEME.bluePale,
    lineSize: 4, lineDataSymbolSize: 6
  });

  slide.addShape('roundRect', {
    x: 8.3, y: 2.5, w: 4.5, h: 1.8,
    fill: { color: '0F2342' },
    line: { color: '0F2342', width: 0 },
    rectRadius: 0.08
  });
  slide.addText('INÍCIO', { x: 8.5, y: 2.65, w: 1.8, h: 0.25, fontSize: 9, bold: true, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'center', charSpacing: 3 });
  slide.addText('FIM', { x: 10.6, y: 2.65, w: 1.8, h: 0.25, fontSize: 9, bold: true, color: PRESTACAO_THEME.amber, fontFace: 'Calibri', align: 'center', charSpacing: 3 });
  const maxV = Math.max(Math.abs(sIni), Math.abs(sFim), 1);
  const barAreaH = 1.0;
  const hIni = Math.max(0.1, (Math.abs(sIni) / maxV) * barAreaH);
  const hFim = Math.max(0.1, (Math.abs(sFim) / maxV) * barAreaH);
  slide.addShape('rect', { x: 9.0, y: 2.95 + (barAreaH - hIni), w: 1.2, h: hIni, fill: { color: PRESTACAO_THEME.blueMid }, line: { color: PRESTACAO_THEME.blueMid, width: 0 } });
  slide.addShape('rect', { x: 11.1, y: 2.95 + (barAreaH - hFim), w: 1.2, h: hFim, fill: { color: PRESTACAO_THEME.amber }, line: { color: PRESTACAO_THEME.amber, width: 0 } });
  slide.addText(prestacaoFmtBRL(sIni), { x: 8.5, y: 4.05, w: 1.8, h: 0.25, fontSize: 9, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'center' });
  slide.addText(prestacaoFmtBRL(sFim), { x: 10.6, y: 4.05, w: 1.8, h: 0.25, fontSize: 9, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'center' });

  const corCresc = (cresc !== null && cresc < 0) ? PRESTACAO_THEME.negative : PRESTACAO_THEME.amber;
  slide.addShape('roundRect', { x: 8.3, y: 4.4, w: 4.5, h: 1.05, fill: { color: corCresc }, line: { color: corCresc, width: 0 }, rectRadius: 0.08 });
  slide.addText('O CAIXA CRESCEU', { x: 8.45, y: 4.5, w: 4.2, h: 0.3, fontSize: 10, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left', charSpacing: 3 });
  let crescStr = 'NA';
  if (cresc !== null) crescStr = (cresc >= 0 ? '+' : '') + cresc.toFixed(0) + '%';
  slide.addText(crescStr, { x: 8.3, y: 4.78, w: 4.5, h: 0.6, fontSize: 38, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'center', valign: 'middle' });

  slide.addShape('roundRect', { x: 8.3, y: 5.55, w: 4.5, h: 0.95, fill: { color: PRESTACAO_THEME.positive }, line: { color: PRESTACAO_THEME.positive, width: 0 }, rectRadius: 0.08 });
  slide.addText('RECEITA COBRIU ' + prestacaoFmtPct(cobertura, 0) + ' DA DESPESA', { x: 8.45, y: 5.6, w: 4.2, h: 0.3, fontSize: 9, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left', charSpacing: 3 });
  slide.addText(positivos + ' meses com superávit', { x: 8.3, y: 5.9, w: 4.5, h: 0.5, fontSize: 14, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'center', valign: 'middle' });

  slide.addShape('rect', { x: 0.5, y: 6.7, w: 6.4, h: 0.7, fill: { color: PRESTACAO_THEME.navy }, line: { color: PRESTACAO_THEME.navy, width: 0 } });
  slide.addText('INÍCIO ANO', { x: 0.7, y: 6.75, w: 2.5, h: 0.25, fontSize: 9, bold: true, color: PRESTACAO_THEME.bluePale, fontFace: 'Calibri', align: 'left', charSpacing: 3 });
  slide.addText(prestacaoFmtBRL(sIni), { x: 0.7, y: 6.97, w: 6.0, h: 0.4, fontSize: 16, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left', valign: 'middle' });

  slide.addShape('rect', { x: 6.95, y: 6.7, w: 6.4, h: 0.7, fill: { color: PRESTACAO_THEME.amber }, line: { color: PRESTACAO_THEME.amber, width: 0 } });
  slide.addText('FIM ANO', { x: 7.15, y: 6.75, w: 2.5, h: 0.25, fontSize: 9, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left', charSpacing: 3 });
  slide.addText(prestacaoFmtBRL(sFim), { x: 7.15, y: 6.97, w: 6.0, h: 0.4, fontSize: 16, bold: true, color: PRESTACAO_THEME.white, fontFace: 'Calibri', align: 'left', valign: 'middle' });
}

// Funcao principal do B5: monta o pptx completo a partir do JSON em
// dadosEditaveis e dispara o download do arquivo no navegador.
async function prestacaoMontarPptx(dados) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'LAYOUT_WIDE', width: 13.333, height: 7.5 });
  pptx.layout = 'LAYOUT_WIDE';

  const ano = prestacaoExtrairAno(dados.cabecalho && dados.cabecalho.periodo) || new Date().getFullYear();
  const entidade = (dados.cabecalho && dados.cabecalho.condominio) || 'Condominio';
  const periodo = (dados.cabecalho && dados.cabecalho.periodo) || '';

  const distRec = (dados.receitas && Array.isArray(dados.receitas.distribuicaoTemporalTotal)) ? dados.receitas.distribuicaoTemporalTotal.slice() : new Array(12).fill(0);
  const distDesp = (dados.despesas && Array.isArray(dados.despesas.distribuicaoTemporalTotal)) ? dados.despesas.distribuicaoTemporalTotal.slice() : new Array(12).fill(0);
  while (distRec.length < 12) distRec.push(0);
  while (distDesp.length < 12) distDesp.push(0);
  const saldoMensal = Array.isArray(dados.saldoMensal) ? dados.saldoMensal : null;
  const superavitMensal = prestacaoCalcularSuperavitMensal(distRec, distDesp);

  // ONDA 1 — agrupamento: consolida subcategorias em até 9 grupos canônicos de
  // despesa e 5 a 7 fontes de receita. Sem isso, exercícios com Superlógica
  // detalhado em 30+ subcategorias geravam 49 slides.
  const gruposDespesa = prestacaoAgruparDespesas(dados.despesasPorCategoria);
  const fontesReceita = prestacaoAgruparReceitas(dados.receitas && dados.receitas.porCategoria);
  // Versões consolidadas servem aos slides Origem da Receita e Estrutura de Despesas.
  const dadosOrigem = Object.assign({}, dados, {
    receitas: Object.assign({}, dados.receitas || {}, { porCategoria: prestacaoConsolidarReceitasPorFonte(fontesReceita) })
  });
  const dadosEstrutura = Object.assign({}, dados, {
    despesasPorCategoria: prestacaoConsolidarDespesasPorGrupo(gruposDespesa)
  });

  prestacaoSlideCapa(pptx, dados, ano, entidade, periodo);
  prestacaoSlideVisaoGeral(pptx, dados, entidade, ano);
  prestacaoSlideEvolucaoMensal(pptx, dados, distRec, distDesp, saldoMensal, entidade, ano);
  prestacaoSlidePatrimonio(pptx, dados, saldoMensal, entidade, ano);
  prestacaoSlideSuperavitMensal(pptx, dados, superavitMensal, entidade, ano);
  prestacaoSlideOrigemReceita(pptx, dadosOrigem, entidade, ano);
  prestacaoSlideEstruturaDespesas(pptx, dadosEstrutura, entidade, ano);

  // Detalhamento agora é por GRUPO (até 9 slides), não por categoria.
  // Slides de detalhamento de receita foram removidos — a fonte agrupada já
  // aparece no slide Origem da Receita.
  const totalDesp = Number(dados.despesas && dados.despesas.total) || 0;
  gruposDespesa.forEach(function(grupo, idx) {
    prestacaoSlideDetalhamentoGrupo(pptx, grupo, idx, entidade, ano, totalDesp);
  });

  prestacaoSlideEncerramento(pptx, dados, saldoMensal, superavitMensal, entidade, ano);

  const slug = String(entidade).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const nomeArquivo = 'prestacao-contas-' + slug + '-' + ano + '.pptx';
  await pptx.writeFile({ fileName: nomeArquivo });
}

// Handler do botao Gerar pptx do Card de geracao. A partir do B5 prompt 2B
// abre a modal de revisao em vez de gerar direto. A geracao real entra no 2C.
function prestacaoGerarPptx() {
  if (!prestacaoState.dadosExtraidos) {
    toast('Nao ha dados extraidos. Gere primeiro.', 'err');
    return;
  }
  prestacaoAbrirModal();
}

// Le um arquivo do prestacaoState e devolve um content block do Anthropic.
// PDFs viram bloco document base64, imagens viram bloco image base64,
// qualquer outro tipo e lido como texto via FileReader.readAsText e enviado como bloco text.
function prestacaoArquivoParaBloco(file) {
  return new Promise(function(resolve, reject) {
    var nome = file && file.name ? file.name : 'sem_nome';
    var ehPdf = (file.type === 'application/pdf') || /\.pdf$/i.test(nome);
    var ehImagem = (file.type || '').indexOf('image/') === 0;
    var reader = new FileReader();
    reader.onerror = function() { reject(new Error('Falha ao ler ' + nome)); };
    if (ehPdf || ehImagem) {
      reader.onload = function() {
        var dataUrl = String(reader.result || '');
        var b64 = dataUrl.split(',')[1] || '';
        if (ehPdf) {
          resolve({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: b64 },
            title: nome
          });
        } else {
          var media = file.type || 'image/png';
          resolve({
            type: 'image',
            source: { type: 'base64', media_type: media, data: b64 }
          });
        }
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = function() {
        var texto = String(reader.result || '');
        resolve({
          type: 'text',
          text: 'Arquivo: ' + nome + '\n\n' + texto
        });
      };
      reader.readAsText(file);
    }
  });
}

// Handler principal do botao Gerar.
// Le todos os arquivos do prestacaoState, monta payload Anthropic com instrucoes
// para extrair a estrutura JSON da prestacao de contas e envia para o proxy
// ── Caminho padrao: microservico prestacao-pdf via /api/prestacao/gerar-deck ──
// Envia os W016A pro backend (parser deterministico + skill + auditoria) e
// recebe PPTX e PDF prontos. O PptxGenJS abaixo permanece como fallback
// OFFLINE: so e oferecido quando o servico esta indisponivel (503/504/rede).
// Erro 422 e degradacao graciosa: o relatorio precisa de revisao humana e o
// fallback NAO e oferecido, porque geraria o mesmo dado ruim com menos checagem.

// Decodifica base64 num object URL de download. Pode lancar em base64 invalido;
// separado do disparo para que a falha de decodificacao seja detectada de forma
// SINCRONA (antes de contar o arquivo como baixado). Usa Uint8Array.from com
// charCodeAt como callback para converter em O(n) sem loop explicito, evitando
// travar a thread em decks com muitas imagens ou slides.
function prestacaoPrepararDownload(b64, mime) {
  var bin = atob(b64);
  var bytes = Uint8Array.from(bin, function(c) { return c.charCodeAt(0); });
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

// Dispara o download de um object URL ja preparado (cria o link e clica).
function prestacaoDispararDownload(url, nomeArquivo) {
  var a = document.createElement('a');
  a.href = url; a.download = nomeArquivo;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 10000);
}

async function prestacaoGerarServico() {
  var btn = document.getElementById('prest-btn-gerar');
  if (!btn) return;
  var textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Gerando no servidor (pode levar até 2 minutos)...';
  try {
    if (!prestacaoState.arquivos || prestacaoState.arquivos.length === 0) {
      throw new Error('Nenhum arquivo carregado.');
    }
    var form = new FormData();
    for (var i = 0; i < prestacaoState.arquivos.length; i++) {
      form.append('arquivos', prestacaoState.arquivos[i]);
    }
    var resp = await apiAuthFetch('/api/prestacao/gerar-deck', { method: 'POST', body: form });

    if (resp.status === 422) {
      // Degradacao graciosa: relatorio invalido ou auditoria reprovada.
      // Nao entrega slide quebrado; sinaliza revisao humana com o motivo.
      var corpo422 = await resp.json().catch(function() { return {}; });
      var det = (corpo422.detail || corpo422);
      console.error('[prestacao] geracao retida para revisao humana:', det);
      toast('Geração retida para revisão humana: ' + (det.erro || 'relatório fora do padrão')
        + '. Detalhe no console. Confira o relatório no Superlógica antes de tentar de novo.', 'err');
      return;
    }
    if (!resp.ok) {
      // So indisponibilidade real abre a porta do fallback. 401/500 e afins
      // sao erro de configuracao ou bug: mostrar claro e parar.
      var ehIndisponivel = resp.status === 503 || resp.status === 504 || resp.status === 502;
      var corpoErr = await resp.json().catch(function() { return {}; });
      var naoConfigurada = (corpoErr.erro === 'prestacao_api_nao_configurada');
      throw Object.assign(new Error('Falha na geração (' + resp.status + (corpoErr.erro ? ': ' + corpoErr.erro : '') + ')'),
        { indisponivel: ehIndisponivel, naoConfigurada: naoConfigurada });
    }
    var dados = await resp.json();
    var base = 'Prestacao_' + (prestacaoState.condNome || 'Condominio').replace(/[^\w]+/g, '_');
    var algumBaixou = false;
    var baixados = [];

    // Formato escolhido pelo usuario: 'ambos' (padrao), 'pdf' ou 'pptx'. O servidor
    // sempre devolve os dois; aqui so decidimos o que baixar. Default seguro = ambos,
    // entao qualquer valor inesperado (ou ausencia do seletor) mantem o comportamento antigo.
    var fmtSel = document.querySelector('input[name="prest-formato"]:checked');
    var formato = fmtSel ? fmtSel.value : 'ambos';
    var querPdf = (formato === 'ambos' || formato === 'pdf');
    var querPptx = (formato === 'ambos' || formato === 'pptx');

    // Monta a lista de arquivos a baixar conforme o formato pedido. O servidor
    // sempre devolve os dois; aqui filtramos o que o usuario escolheu. Se um
    // formato pedido nao veio na resposta, avisa (nao sai em silencio).
    var pendentes = [];
    if (querPdf) {
      if (dados.pdf_b64 && typeof dados.pdf_b64 === 'string' && dados.pdf_b64.length > 0) {
        pendentes.push({ b64: dados.pdf_b64, mime: 'application/pdf',
                         nome: base + '.pdf', rotulo: 'PDF' });
      } else {
        toast('PDF não disponível na resposta do servidor.', 'warn');
      }
    }
    if (querPptx) {
      if (dados.pptx_b64 && typeof dados.pptx_b64 === 'string' && dados.pptx_b64.length > 0) {
        pendentes.push({ b64: dados.pptx_b64,
                         mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                         nome: base + '.pptx', rotulo: 'PPTX' });
      } else {
        toast('PPTX não disponível na resposta do servidor.', 'warn');
      }
    }

    // Decodifica cada arquivo de forma SINCRONA (atob pode falhar). So os que
    // decodificam entram na conta de baixados; falha avisa na hora, com o nome
    // do formato, e nao entra em silencio nem infla o toast de sucesso.
    var prontos = [];
    pendentes.forEach(function(p) {
      try {
        p.url = prestacaoPrepararDownload(p.b64, p.mime);
        prontos.push(p);
      } catch (err) {
        console.error('[prestacao] falha ao preparar ' + p.rotulo + ':', err);
        toast(p.rotulo + ' não pôde ser gerado para download. Tente novamente.', 'warn');
      }
    });

    // Dispara os cliques ESCALONADOS. Dois downloads no mesmo tique sao
    // colapsados pelo navegador num so (era por isso que "ambos" entregava so um
    // arquivo). Um atraso entre eles garante que os dois saiam. A decodificacao
    // ja passou, entao algumBaixou/baixados refletem o resultado real.
    prontos.forEach(function(p, i) {
      setTimeout(function() { prestacaoDispararDownload(p.url, p.nome); }, i * 600);
    });
    algumBaixou = prontos.length > 0;
    baixados = prontos.map(function(p) { return p.rotulo; });

    // Só reseta o estado (arquivos anexados e campos) se pelo menos um arquivo
    // decodificou com sucesso e foi disparado para download. Não há garantia de
    // que chegou ao disco (um bloqueador de download pode interceptar), mas é o
    // sinal mais confiável no browser. Se nenhum saiu, o usuário tenta de novo
    // sem precisar reanexar os PDFs.
    if (algumBaixou) {
      prestacaoState.arquivos = [];
      var filesList = document.getElementById('prest-files-list');
      if (filesList) filesList.innerHTML = '';
      var fileInput = document.getElementById('prest-file-input');
      if (fileInput) fileInput.value = '';
      prestacaoAtualizarBotao();

      // Monta resumo de fontes detectadas e série mensal para informar o usuário.
      // Usa somente campos que o servidor garante (sem inventar dado ausente).
      var partesStatus = [];
      if (dados.fontes_detectadas) {
        var fontesList = [];
        if (dados.fontes_detectadas.W011A) fontesList.push('W011A');
        if (dados.fontes_detectadas.W015A) fontesList.push('W015A');
        if (dados.fontes_detectadas.W016A) fontesList.push('W016A');
        if (fontesList.length > 0) {
          partesStatus.push('Fontes: ' + fontesList.join(', '));
        }
      }
      if (dados.serie_mensal_ativa) {
        partesStatus.push('Série mensal: ativa');
      }
      if (dados.avisos_reconciliacao && dados.avisos_reconciliacao.length > 0) {
        // Aviso de reconciliação: toast âmbar separado, sem bloquear o download.
        // Usa o resumo claro (qual fonte, qual período, qual base) quando o
        // servidor devolve; senão cai no texto genérico.
        var msgReconc = dados.reconciliacao_resumo
          ? dados.reconciliacao_resumo
          : 'Atenção: diferença entre fontes detectada. Confira os totais.';
        toast(msgReconc, 'warn');
        console.warn('[prestacao] reconciliação:', msgReconc, dados.avisos_reconciliacao);
      }

      var msgStatus = partesStatus.length > 0 ? ' ' + partesStatus.join('. ') + '.' : '';
      toast('Prestação gerada: ' + dados.blocos + ' bloco(s). ' + baixados.join(' e ') + ' baixado(s).' + msgStatus, 'ok');
    } else {
      toast('Nenhum arquivo foi baixado. Tente novamente ou contate o suporte.', 'err');
    }
  } catch (err) {
    console.error('[prestacao] erro no caminho padrao:', err);
    if (err && err.indisponivel) {
      // DECISAO DE PRODUTO (Matheus, 2026-06-09): o fallback offline usa
      // extracao por IA e relaxa deliberadamente a regra "numero nao passa
      // por LLM". So e oferecido com o servico indisponivel, exige
      // confirmacao e nao passa pela auditoria do servidor.
      var msgServico = err.naoConfigurada
        ? 'O serviço de geração ainda não está configurado neste ambiente.'
        : 'O serviço de geração está indisponível no momento.';
      var usarFallback = window.confirm(
        msgServico + ' Quer usar o gerador local (modo offline)? '
        + 'Ele usa extração por IA e não passa pela auditoria do servidor.');
      if (usarFallback) { prestacaoGerar(); return; }
    } else {
      toast('Erro: ' + (err && err.message ? err.message : String(err)), 'err');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal || 'Gerar prestação de contas';
  }
}

// ── Fallback offline (PptxGenJS no browser) ──
// /api/claude/messages. Em sucesso salva em prestacaoState.dadosExtraidos, loga
// no console e troca o botao para acionar prestacaoGerarPptx (B5). Em erro,
// restaura o botao original e mostra toast com a mensagem.
async function prestacaoGerar() {
  var btn = document.getElementById('prest-btn-gerar');
  if (!btn) return;
  var textoOriginal = btn.textContent;
  var onclickOriginal = btn.onclick;
  btn.disabled = true;
  btn.textContent = 'Lendo arquivos...';
  try {
    if (!prestacaoState.arquivos || prestacaoState.arquivos.length === 0) {
      throw new Error('Nenhum arquivo carregado.');
    }
    var blocos = [];
    for (var i = 0; i < prestacaoState.arquivos.length; i++) {
      btn.textContent = 'Lendo arquivo ' + (i + 1) + ' de ' + prestacaoState.arquivos.length + '...';
      var bloco = await prestacaoArquivoParaBloco(prestacaoState.arquivos[i]);
      blocos.push(bloco);
    }
    btn.textContent = 'Consultando IA...';

    // System prompt orienta o modelo a devolver JSON estruturado seguindo o
    // padrao da skill powerpoint prestacao contas, com base no relatorio
    // W016A do Superlogica (demonstrativo de receitas e despesas).
    var systemPrompt = [
      'Voce e um assistente especializado em montar prestacao de contas condominial em formato pptx.',
      'O usuario vai fornecer o relatorio W016A do Superlogica (demonstrativo de receitas e despesas).',
      'Sua tarefa e extrair os dados em JSON estruturado para alimentar a skill powerpoint prestacao contas.',
      'Devolva SEMPRE um unico bloco JSON valido, dentro de cercas tripla com a tag json (```json ... ```), sem texto antes nem depois.',
      'Estrutura obrigatoria do JSON:',
      '{',
      '  "cabecalho": { "condominio": string, "periodo": string, "dataApresentacao": string },',
      '  "blocosTemporais": [ { "rotulo": string, "inicio": string, "fim": string } ],',
      '  "despesasPorCategoria": [ { "categoria": string, "valor": number, "percentual": number, "granularidade": string, "distribuicaoTemporal": array ou null } ],',
      '  "despesas": { "total": number, "distribuicaoTemporalTotal": array ou null, "granularidade": string },',
      '  "receitas": { "total": number, "distribuicaoTemporalTotal": array ou null, "granularidade": string, "porCategoria": [ { "categoria": string, "valor": number, "granularidade": string, "distribuicaoTemporal": array ou null } ] },',
      '  "saldo": { "inicial": number, "final": number, "movimentacao": number },',
      '  "saldoMensal": array ou null,',
      '  "observacoes": [ string ],',
      '  "slidesSugeridos": [ { "titulo": string, "tipo": string, "conteudo": string } ]',
      '}',
      'Regras de granularidade e distribuicao temporal:',
      'O campo granularidade deve ser uma string com valor mensal, trimestral ou anual indicando o nivel de detalhe que foi possivel extrair do PDF para aquele bloco ou categoria.',
      'O campo distribuicaoTemporal de cada categoria deve ser array de 12 numeros (Jan a Dez) quando granularidade for mensal, array de 4 numeros (T1 a T4) quando trimestral, e null quando anual.',
      'O campo distribuicaoTemporalTotal de receitas e de despesas segue a mesma logica (12 numeros, 4 numeros ou null) e representa o total do bloco mes a mes ou trimestre a trimestre.',
      'O campo saldoMensal deve ser array de 13 numeros (saldo inicial seguido pelos 12 fechamentos mensais) quando possivel, array de 5 numeros (saldo inicial seguido pelos 4 fechamentos trimestrais) caso so haja dado trimestral, e null caso nao seja possivel nem mensal nem trimestral.',
      'Em blocosTemporais mantenha apenas rotulo, inicio e fim, sem campos adicionais.',
      'Prefira sempre a extracao mensal quando o PDF tiver os dados. Caia para trimestral somente se nao houver dado mensal, e use anual somente se nao houver nem mensal nem trimestral.',
      'Nunca invente valores. Se o PDF nao trouxer detalhamento mensal, devolva granularidade trimestral ou anual com distribuicaoTemporal preenchido conforme possivel ou null. Nunca divida o total por 12 e finja que e mensal.',
      'Use numeros decimais com ponto (nunca virgula) e datas em formato ISO 8601.',
      'Se algum campo nao puder ser extraido com seguranca, devolva null nele em vez de inventar.'
    ].join('\n');

    var contextoUsuario = [];
    contextoUsuario.push({
      type: 'text',
      text:
        'Condominio: ' + (prestacaoState.condNome || 'nao informado') + '\n' +
        'Período: ' + (prestacaoState.periodo || 'nao informado') + '\n' +
        'Data da apresentacao: ' + (prestacaoState.dataApresentacao || 'nao informada') + '\n' +
        'Observacoes adicionais: ' + (prestacaoState.observacoes || 'nenhuma') + '\n\n' +
        'A seguir vao os arquivos da prestacao de contas. Extraia o JSON conforme as instrucoes do system prompt.'
    });
    for (var j = 0; j < blocos.length; j++) contextoUsuario.push(blocos[j]);

    var payload = {
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: contextoUsuario }]
    };

    var resp = await apiAuthFetch('/api/claude/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      var erroTxt = await resp.text();
      throw new Error('Falha na API (' + resp.status + '): ' + erroTxt.slice(0, 200));
    }
    var data = await resp.json();
    var primeiroBloco = (data && Array.isArray(data.content))
      ? data.content.find(function(b) { return b && b.type === 'text'; })
      : null;
    var textoResposta = primeiroBloco && primeiroBloco.text ? primeiroBloco.text : '';
    if (!textoResposta) throw new Error('Resposta da IA sem bloco de texto.');

    // Extracao do JSON: tenta cercas ```json primeiro, depois cercas genericas, depois parse direto.
    var jsonStr = '';
    var matchJson = textoResposta.match(/```json\s*([\s\S]*?)```/i);
    if (matchJson && matchJson[1]) {
      jsonStr = matchJson[1].trim();
    } else {
      var matchGen = textoResposta.match(/```\s*([\s\S]*?)```/);
      jsonStr = matchGen && matchGen[1] ? matchGen[1].trim() : textoResposta.trim();
    }
    var dados;
    try {
      dados = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[prestacao] resposta bruta nao parseavel:', textoResposta);
      throw new Error('JSON invalido na resposta da IA.');
    }
    prestacaoState.dadosExtraidos = dados;
    console.log('[prestacao] dados extraidos:', dados);

    btn.disabled = false;
    btn.textContent = 'Dados extraídos. Gerar PPTX';
    btn.onclick = prestacaoGerarPptx;
    toast('Extração concluída. Veja prestacaoState.dadosExtraidos no console.', 'ok');
  } catch (err) {
    console.error('[prestacao] erro ao gerar:', err);
    btn.disabled = false;
    btn.textContent = textoOriginal || 'Gerar prestacao de contas';
    if (onclickOriginal) btn.onclick = onclickOriginal;
    toast('Erro: ' + (err && err.message ? err.message : String(err)), 'err');
  }
}

// Fecha o dropdown de condominios quando o usuario clica fora do Card 1.
document.addEventListener('click', function(ev) {
  var dd = document.getElementById('prest-cond-dropdown');
  if (!dd || !dd.classList.contains('open')) return;
  var inp = document.getElementById('prest-cond-search');
  if (ev.target === inp) return;
  if (dd.contains(ev.target)) return;
  dd.classList.remove('open');
});

