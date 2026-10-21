// ============================================================
// IMPORTAR UNIDADES: extraído de public/index.html (T02, só movido, sem mudar
// comportamento). Script clássico: funções e variáveis seguem globais,
// no mesmo escopo do script inline do index.html.
// ============================================================

// ============================================================
// PROCESSAMENTO DE UNIDADES: COLUNAS FIXAS
// Mapeia pela posição exata da planilha do Superlogica, não por nome de header.
// Compatível com renderPreviewUnidades e enviarUnidades (mesmos nomes de campo).
// ============================================================
function processUnidadesData(headers, rows) {
  // Remove valores inválidos conhecidos, retorna string vazia se inválido
  const cleanVal = function(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).trim();
    if (!s) return '';
    var lower = s.toLowerCase();
    if (['nan', '0', '0.0', 'cep inválido', 'cep invalido', 'inválido', 'invalido'].indexOf(lower) !== -1) return '';
    return s;
  };

  // Mantém apenas dígitos (para CPF, CEP, telefone)
  const cleanDigits = function(v) { return cleanVal(v).replace(/\D/g, ''); };

  // Normaliza fracao ideal: aceita "0,135753" ou "0.135753" ou numero, devolve string com ponto
  // ou string vazia se invalido/zero. Superlogica espera ponto decimal no campo NM_FRACAO_UNI.
  const cleanFracao = function(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).trim().replace(',', '.');
    if (!s) return '';
    var n = parseFloat(s);
    if (!isFinite(n) || n <= 0) return '';
    return String(n);
  };

  // Separa "A 0201" em bloco "A" e numero "0201". Se não há espaço, numero = valor todo.
  const splitUnidade = function(raw) {
    var v = cleanVal(raw);
    if (!v) return { numero: '', bloco: '' };
    if (v.indexOf(' ') !== -1) {
      var parts = v.split(/\s+/);
      return { bloco: parts[0], numero: parts.slice(1).join(' ') };
    }
    return { numero: v, bloco: '' };
  };

  // Separa "Vitória ES" em cidade e sigla de estado.
  // Se a última palavra for 2 letras maiúsculas, é a UF.
  const splitCidadeEstado = function(raw) {
    var v = cleanVal(raw);
    if (!v) return { cidade: '', estado: '' };
    var tokens = v.split(/\s+/);
    if (tokens.length >= 2) {
      var ult = tokens[tokens.length - 1].toUpperCase();
      if (ult.length === 2 && /^[A-Z]{2}$/.test(ult)) {
        return { cidade: tokens.slice(0, -1).join(' '), estado: ult };
      }
    }
    return { cidade: v, estado: '' };
  };

  var out = [];
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    if (!row || row.length === 0) continue;
    var u0 = cleanVal(row[0]);
    if (!u0) continue;

    var splitUni = splitUnidade(row[0]);
    // Coluna 1 é Grupo/Bloco: tem precedência sobre o bloco extraído da coluna 0
    var grupoBloco = cleanVal(row[1]) || splitUni.bloco;

    // Telefone: preferir coluna 6 (Fone 1); fallback coluna 7 (Fone 2)
    var fone1 = cleanDigits(row[6]);
    var fone2 = cleanDigits(row[7]);
    var telefone = fone1 || fone2;

    var cid = splitCidadeEstado(row[29]);

    out.push({
      _linha: ri + 2,
      _unidadeRaw: u0,
      // Campos usados pelo POST/PUT do Superlogica
      ST_UNIDADE_UNI: splitUni.numero,
      ST_BLOCO_UNI: grupoBloco,
      // Campos do proprietário (renderPreviewUnidades e enviarUnidades consomem esses nomes)
      prop_nome:        cleanVal(row[2]),
      prop_cpf:         cleanVal(row[3]),
      prop_rg:          cleanVal(row[4]),
      prop_email:       cleanVal(row[5]),
      prop_fone:        telefone,  // enviarUnidades lê prop_fone quando prop_cel está vazio
      prop_cel:         '',        // mantido para compatibilidade com renderPreviewUnidades
      prop_cep:         cleanDigits(row[24]),
      prop_endereco:    cleanVal(row[25]),
      prop_numero:      cleanVal(row[26]),
      prop_bairro:      cleanVal(row[27]),
      prop_complemento: cleanVal(row[28]),
      prop_cidade:      cid.cidade,
      prop_estado:      cid.estado,
      prop_fracao:      cleanFracao(row[20]),
      inq_nome:         cleanVal(row[9]),
    });
  }
  return out;
}

// Renderiza preview de até 8 linhas da planilha de unidades.
// Todos os campos de dados da planilha são escapados para evitar XSS via innerHTML.
function renderPreviewUnidades(processed, filename) {
  const preview = document.getElementById('preview-unidades');
  const info = document.getElementById('unidades-info');
  const table = document.getElementById('unidades-table');
  // Escape de dados externos (planilha do usuário) antes de interpolar em innerHTML
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  preview.style.display = 'block';
  info.textContent = filename + ' · ' + processed.length + ' unidades · normalizadas e prontas para envio';
  const previewRows = processed.slice(0, 8);
  let html = '<tr><th>Unidade</th><th>Bloco</th><th>Proprietário</th><th>CPF/CNPJ</th><th>Celular</th><th>Email</th><th>Cidade</th><th>Fração</th></tr>';
  previewRows.forEach(function(r) {
    html += '<tr>' +
      '<td><b>' + esc(r.ST_UNIDADE_UNI) + '</b></td>' +
      '<td>' + (r.ST_BLOCO_UNI ? esc(r.ST_BLOCO_UNI) : '&mdash;') + '</td>' +
      '<td>' + (r.prop_nome ? esc(r.prop_nome) : '<span style="color:var(--muted)">&mdash;</span>') + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (r.prop_cpf ? esc(r.prop_cpf) : '&mdash;') + '</td>' +
      '<td>' + (r.prop_cel || r.prop_fone ? esc(r.prop_cel || r.prop_fone) : '&mdash;') + '</td>' +
      '<td style="font-size:11px">' + (r.prop_email ? esc(r.prop_email) : '&mdash;') + '</td>' +
      '<td>' + (r.prop_cidade ? esc(r.prop_cidade) : '&mdash;') + '</td>' +
      '<td style="font-family:var(--mono);font-size:11px">' + (r.prop_fracao ? esc(r.prop_fracao) : '&mdash;') + '</td>' +
      '</tr>';
  });
  if (processed.length > 8) {
    html += '<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:12px">... mais ' + (processed.length - 8) + ' unidades</td></tr>';
  }
  table.innerHTML = html;
}

// ============================================================
// PARSER W045A "CONTATOS DAS UNIDADES" (FAMILIA A2) + INFERENCIA DE PAPEL
// ------------------------------------------------------------
// Familia A2: relatorio W045A "Contatos das unidades" em planilha tabular
// (ex: Villaggio Laranjeiras). Colunas tipicas:
//   Unidade | Nome | Tipo | Telefone | Celular | Endereco | Complemento |
//   Bairro | Cidade | Estado | CEP | CPF/CNPJ | E-mail | Fracao
// A coluna Unidade so aparece na primeira linha de cada unidade; as demais
// pessoas da unidade herdam (forward fill). A coluna Tipo traz valores
// ambiguos (Residente, Visitante, Imobiliaria) que o motor de inferencia
// resolve em Proprietario, Inquilino ou Dependente, com nivel de confianca.
// Tudo passa pela tela de revisao editavel antes de qualquer envio.
// ============================================================

// Estado da tela de revisao: lista plana de contatos + nome do arquivo de origem.
let _revisaoContatos = null;
let _revisaoSource = '';
// Filtro por status (confianca) da tela de revisao: todos, alta, media, incerta ou erro.
let _revisaoFiltro = 'todos';
// Quantidade de linhas lidas na planilha de origem, pro resumo fixo do funil
// "X linhas na origem -> Y unidades -> Z pessoas".
let _revisaoLinhasOrigem = 0;

// Roteador de estrutura da planilha de unidades. Classifica os cabecalhos
// numa das 5 familias conhecidas e devolve o identificador que processFile usa
// pra escolher o parser certo, do mais estrito pro mais generico. Nunca chuta:
// se nada bater, devolve null e o operador cai no fallback de Normalizar via
// IA (nunca processa uma estrutura desconhecida em silencio).
//   'unificado'      -> planilha 26 colunas A-Z, formato interno alvo
//   'w045a-contatos' -> familia 3, W045A "Contatos das unidades" tabular
//   'quattro'        -> familia 4, planilha larga do Superlogica (proprietario + inquilino em blocos de coluna)
//   'proponentes'    -> familia 2, cabecalhos repetidos "1o/2o/3o Proponente"
//   'plana'          -> familia 1, 1 linha = 1 unidade = 1 pessoa
function detectarFamiliaPlanilha(headers) {
  if (!headers || headers.length < 3) return null;
  var h = headers.map(function(s) { return String(s || '').trim().toLowerCase(); });
  var hNorm = h.map(function(s) { return s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); });

  // 1. Unificado (26 colunas A-Z): ja e o formato interno alvo, plenamente
  // especificado. Testado primeiro por ser o mais estrito dos 5.
  if (detectarFormatoPlanilhaUnificada(headers) === 'unificado') return 'unificado';

  // 2. Familia 3 (W045A "Contatos das unidades" tabular): coluna 0 fala de
  // unidade, existe coluna Nome e coluna Tipo logo no inicio, e ha coluna
  // Celular, o que distingue esta familia do formato unificado de 26 colunas.
  var idxNome = h.indexOf('nome');
  var idxTipo = h.indexOf('tipo');
  var temUnidade = h[0].indexOf('unidade') !== -1;
  var temNome = idxNome !== -1 && idxNome <= 2;
  var temTipo = idxTipo !== -1 && idxTipo <= 3;
  var temCelular = h.some(function(s) { return s.indexOf('celular') !== -1; });
  if (temUnidade && temNome && temTipo && temCelular) return 'w045a-contatos';

  // 3. Familia 4 (Quattro, formato largo do Superlogica): muitas colunas
  // (28 ou mais no formato original) mais rotulos caracteristicos de bloco,
  // endereco, fracao e inquilino que nao aparecem nas familias mais simples.
  var temBloco = hNorm.some(function(s) { return s.indexOf('bloco') !== -1 || s.indexOf('grupo') !== -1; });
  var temEndereco = hNorm.some(function(s) { return s.indexOf('endereco') !== -1; });
  var temFracao = hNorm.some(function(s) { return s.indexOf('fracao') !== -1; });
  var temInquilino = hNorm.some(function(s) { return s.indexOf('inquilino') !== -1; });
  if (headers.length >= 28 && temBloco && temEndereco && temFracao && temInquilino) return 'quattro';

  // 4. Familia 2 (larga por proponentes): cabecalhos repetidos com sufixo
  // ordinal ("1o Proponente", "2o Proponente", "3o Proponente"; tolera "1o",
  // "1º" e "1 " como variacao do ordinal). 2 ou mais colunas de Proponente
  // significa varias pessoas descritas na mesma linha.
  var reProponente = /^\d+\s*o?\s*proponente$/;
  var nProponentes = hNorm.filter(function(s) { return reProponente.test(s.replace(/\s+/g, ' ').trim()); }).length;
  if (nProponentes >= 2) return 'proponentes';

  // 5. Familia 1 (plana): assinatura minima Unidade + Nome + CPF ou CNPJ +
  // Telefone + Email, sem repeticao de Proponente nem 28 ou mais colunas (o
  // que caracterizaria a familia 4). E o formato mais generico, testado por ultimo.
  var temDoc = hNorm.some(function(s) { return s.indexOf('cpf') !== -1 || s.indexOf('cnpj') !== -1; });
  var temTelefone = hNorm.some(function(s) { return s.indexOf('telefone') !== -1 || s.indexOf('celular') !== -1 || s.indexOf('fone') !== -1; });
  var temEmail = hNorm.some(function(s) { return s.indexOf('mail') !== -1; });
  if (temUnidade && idxNome !== -1 && temDoc && temTelefone && temEmail && headers.length < 28) return 'plana';

  return null;
}

// Valida cada unidade agrupada (shape processUnidadesDataUnificada/processUnidadesData:
// prop_* no nivel raiz + contatos_extras[]) e marca _erros/_valido em cada
// item, sem alterar os parsers que a chamam. Reaproveitada pelas familias
// Quattro, Proponentes e Plana pra que a mesma regra de erro (proprietario
// ausente, documento invalido, unidade duplicada, coluna nao identificada)
// valha nas 3 sem duplicar logica em cada parser. Erros excluem a unidade do
// envio (ver confirmarRevisao) mas NUNCA some em silencio: fica visivel no
// chip "Com erro" da tela de revisao.
// B4 (vale pras 4 familias): a regra de documento e "e CPF VALIDO (11) OU
// CNPJ VALIDO (14)", NUNCA "e CPF senao exclui". Proprietario pessoa juridica
// (imobiliaria, SPE, construtora) e legitimo e nao pode ser reprovado.
// processUnidadesData (Quattro) poe o documento em prop_cpf seja CPF ou CNPJ
// (nao tem campo prop_cnpj proprio), entao o documento bruto e lido de
// QUALQUER um dos dois campos antes de isCPF/isCNPJ decidirem pelo tamanho,
// nunca amarrado a qual campo o parser usou pra guardar o valor.
// M5: a mesma regra CPF-ou-CNPJ tambem valida o FORMATO do documento de cada
// contato extra (dependente/inquilino) quando ha documento informado; nao
// exige presenca (a maioria nao tem documento), so reprova formato invalido.
function validarUnidadesAgrupadas(unidades, colunaDocAusente) {
  var vistos = {};
  var avisos = [];
  if (colunaDocAusente) avisos.push('Coluna de CPF/CNPJ nao identificada na planilha, revise os documentos manualmente');
  unidades.forEach(function(u) {
    var erros = [];
    var chave = (u.ST_UNIDADE_UNI || '') + '|' + (u.ST_BLOCO_UNI || '');
    if (!u.prop_nome) erros.push('Unidade sem proprietario');
    var docProprietario = u.prop_cpf || u.prop_cnpj || '';
    if (colunaDocAusente) {
      erros.push('Coluna de CPF/CNPJ nao identificada');
    } else if (!docProprietario) {
      erros.push('CPF/CNPJ ausente');
    } else if (!isCPF(docProprietario) && !isCNPJ(docProprietario)) {
      erros.push('CPF/CNPJ invalido');
    }
    (u.contatos_extras || []).forEach(function(c) {
      var docExtra = (c && (c.cpf || c.cnpj)) || '';
      if (docExtra && !isCPF(docExtra) && !isCNPJ(docExtra)) {
        erros.push('CPF/CNPJ invalido em contato extra: ' + (c.nome || 'sem nome'));
      }
    });
    if (vistos[chave]) erros.push('Unidade duplicada');
    vistos[chave] = true;
    u._erros = erros;
    u._valido = erros.length === 0;
  });
  unidades.avisos = avisos;
  return unidades;
}

// Converte a saida agrupada por unidade (prop_* + contatos_extras[], mesmo
// shape de processUnidadesDataUnificada) numa lista plana de contatos: o
// mesmo formato que abrirRevisao/renderRevisao ja sabem desenhar (usado hoje
// por W045A, PDF e Normalizador IA). Isso permite que as familias novas
// (Plana, Proponentes) e a Quattro reaproveitada passem pela MESMA tela de
// revisao sem duplicar a logica de exibicao. O erro de validacao da unidade
// (_erros/_valido) e herdado por todas as pessoas dela, ja que um erro como
// "unidade duplicada" e do agrupamento, nao de uma pessoa isolada.
function unidadesAgrupadasParaContatos(unidades, origemLabel) {
  var contatos = [];
  var seq = 0;
  (unidades || []).forEach(function(u) {
    var erros = u._erros || [];
    var motivo = erros.length ? erros.join('; ') : ('Formato ' + origemLabel + ': dado estruturado, sem inferencia');
    var confianca = erros.length ? 'incerta' : 'alta';
    seq += 1;
    contatos.push({
      id: seq, unidade: u.ST_UNIDADE_UNI || '', bloco: u.ST_BLOCO_UNI || '',
      nome: u.prop_nome || '', tipoOriginal: 'Proprietario',
      papel: 'proprietario', confianca: confianca, motivo: motivo,
      cpf: u.prop_cpf || '', cnpj: u.prop_cnpj || '', rg: u.prop_rg || '',
      dtNasc: '', genero: '', email: u.prop_email || '',
      ddi: (u.prop_fone || u.prop_cel) ? '55' : '', telefone: u.prop_cel || u.prop_fone || '', tipoTel: '',
      cep: u.prop_cep || '', endereco: u.prop_endereco || '', numero: u.prop_numero || '',
      complemento: u.prop_complemento || '', bairro: u.prop_bairro || '',
      cidade: u.prop_cidade || '', estado: u.prop_estado || '', fracao: u.prop_fracao || '',
      dtEntrada: '', dtSaida: '', recebeCobranca: '', obs: '',
      _erros: erros, _valido: u._valido !== false
    });
    (u.contatos_extras || []).forEach(function(c) {
      seq += 1;
      contatos.push({
        id: seq, unidade: u.ST_UNIDADE_UNI || '', bloco: u.ST_BLOCO_UNI || '',
        nome: c.nome || '', tipoOriginal: c.tipo === 'inquilino' ? 'Inquilino' : 'Dependente',
        papel: c.tipo === 'inquilino' ? 'inquilino' : 'dependente', confianca: confianca, motivo: motivo,
        cpf: c.cpf || '', cnpj: c.cnpj || '', rg: c.rg || '',
        dtNasc: c.dtNasc || '', genero: c.genero || '', email: c.email || '',
        ddi: c.ddi || '', telefone: c.telefone || '', tipoTel: c.tipoTel || '',
        cep: c.cep || '', endereco: c.endereco || '', numero: c.numero || '',
        complemento: c.complemento || '', bairro: c.bairro || '',
        cidade: c.cidade || '', estado: c.estado || '', fracao: '',
        dtEntrada: c.dtEntrada || '', dtSaida: '', recebeCobranca: c.recebeCobranca || '', obs: '',
        _erros: erros, _valido: u._valido !== false
      });
    });
  });
  return contatos;
}

// Familia 1 (Plana): 1 linha = 1 unidade = 1 pessoa (proprietario). Cabecalho
// tipico "Unidade | Pavimento | Nome | CPF/CNPJ | Telefone | E-mail" na linha
// 0. Localiza colunas por nome (tolerante a variacao), separa CPF de CNPJ
// pela REGRA DURA de tamanho (limparDocumento, 11 digitos = CPF, 14 = CNPJ) e
// valida cada unidade via validarUnidadesAgrupadas antes de devolver.
function processFamiliaPlana(headers, rows) {
  var hNorm = headers.map(function(s) {
    return String(s || '').trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  });
  var acharCol = function(preds) {
    for (var i = 0; i < hNorm.length; i++) {
      for (var p = 0; p < preds.length; p++) { if (hNorm[i].indexOf(preds[p]) !== -1) return i; }
    }
    return -1;
  };
  var iUnidade = acharCol(['unidade']);
  var iBloco   = acharCol(['bloco', 'grupo']);
  var iNome    = acharCol(['nome']);
  var iDoc     = acharCol(['cpf/cnpj', 'cpf', 'cnpj']);
  var iTel     = acharCol(['telefone', 'celular', 'fone']);
  var iEmail   = acharCol(['mail']);
  // B1: confirma por CONTEUDO que a coluna encontrada pelo nome do cabecalho
  // realmente guarda CPF/CNPJ; senao trata como coluna ausente.
  iDoc = confirmarColunaPorConteudo(rows, iDoc, function(v) {
    var d = limparDocumento(v);
    return !!(d.cpf || d.cnpj);
  });
  var colunaDocAusente = (iDoc === -1);

  var cleanVal = function(v) { return v === null || v === undefined ? '' : String(v).trim(); };
  var cleanDigits = function(v) { return cleanVal(v).replace(/\D/g, ''); };

  var out = [];
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    if (!row || !row.length) continue;
    var unidadeRaw = iUnidade >= 0 ? cleanVal(row[iUnidade]) : '';
    if (!unidadeRaw) continue;
    var doc = limparDocumento(iDoc >= 0 ? cleanVal(row[iDoc]) : '');
    out.push({
      _linha: ri + 2,
      _unidadeRaw: unidadeRaw,
      ST_UNIDADE_UNI: unidadeRaw,
      ST_BLOCO_UNI: iBloco >= 0 ? cleanVal(row[iBloco]) : '',
      prop_nome:  iNome >= 0 ? cleanVal(row[iNome]) : '',
      prop_cpf:   doc.cpf,
      prop_cnpj:  doc.cnpj,
      prop_rg:    '',
      prop_email: iEmail >= 0 ? cleanVal(row[iEmail]) : '',
      prop_fone:  iTel >= 0 ? cleanDigits(row[iTel]) : '',
      prop_cel:   '',
      contatos_extras: []
    });
  }
  return validarUnidadesAgrupadas(out, colunaDocAusente);
}

// Familia 2 (larga por proponentes): varias pessoas nas colunas 1o/2o/3o
// Proponente na mesma linha (ex CADASTRO 2 ETAPA). Localiza o bloco de
// colunas de cada proponente pela coluna "N Proponente" (nome) e busca
// documento/RG/email/telefone dentro do intervalo ate o proximo bloco.
// REGRA GERAL DO MOTOR (decisao 2): o 1o Proponente vira proprietario titular
// da unidade; 2o, 3o e qualquer extra viram contatos_extras com tipo
// dependente, nome puro, sem marca nenhuma.
function processFamiliaProponentes(headers, rows) {
  var hNorm = headers.map(function(s) {
    return String(s || '').trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  });
  var reProponente = /^\d+\s*o?\s*proponente$/;
  var blocosNome = [];
  hNorm.forEach(function(h, i) {
    var m = reProponente.test(h.replace(/\s+/g, ' ').trim());
    if (m) blocosNome.push({ ordinal: parseInt(h, 10) || (blocosNome.length + 1), idx: i });
  });
  blocosNome.sort(function(a, b) { return a.idx - b.idx; });

  var iUnidade = hNorm.indexOf('unidade');
  // B3: localiza Bloco/Grupo/Empreendimento/Torre por nome, igual
  // processFamiliaPlana faz com iBloco. Sem isso ST_BLOCO_UNI fica sempre
  // vazio e unidades de blocos diferentes colidem na chave unidade+bloco,
  // virando falso "duplicada". Testa cada coluna da esquerda pra direita,
  // devolvendo a primeira que bater qualquer um dos rotulos.
  var iBloco = -1;
  var rotulosBloco = ['bloco', 'grupo', 'empreendimento', 'torre'];
  for (var ib = 0; ib < hNorm.length && iBloco === -1; ib++) {
    for (var rb = 0; rb < rotulosBloco.length; rb++) {
      if (hNorm[ib].indexOf(rotulosBloco[rb]) !== -1) { iBloco = ib; break; }
    }
  }

  var acharColNoIntervalo = function(preds, ini, fim) {
    for (var i = ini; i < fim; i++) {
      for (var p = 0; p < preds.length; p++) { if (hNorm[i].indexOf(preds[p]) !== -1) return i; }
    }
    return -1;
  };

  // Monta o mapa de colunas de cada proponente: o bloco vai da coluna "N
  // Proponente" ate a proxima coluna "N Proponente" (ou o fim da planilha).
  var blocos = blocosNome.map(function(b, i) {
    var fim = (i + 1 < blocosNome.length) ? blocosNome[i + 1].idx : hNorm.length;
    return {
      iNome:  b.idx,
      iDoc:   acharColNoIntervalo(['cpf', 'cnpj'], b.idx, fim),
      iRg:    acharColNoIntervalo(['rg'], b.idx, fim),
      iEmail: acharColNoIntervalo(['mail'], b.idx, fim),
      iTel1:  acharColNoIntervalo(['telefone 1', 'telefone1', 'telefone'], b.idx, fim),
      iTel2:  acharColNoIntervalo(['telefone 2', 'telefone2'], b.idx, fim)
    };
  });

  var cleanVal = function(v) { return v === null || v === undefined ? '' : String(v).trim(); };
  var cleanDigits = function(v) { return cleanVal(v).replace(/\D/g, ''); };
  var colunaDocAusente = !blocos.length || blocos[0].iDoc === -1;
  // B1: confirma por CONTEUDO que a coluna de documento do 1o Proponente
  // realmente guarda CPF/CNPJ antes de confiar no nome do cabecalho.
  if (!colunaDocAusente) {
    var docConfirmado = confirmarColunaPorConteudo(rows, blocos[0].iDoc, function(v) {
      var d = limparDocumento(v);
      return !!(d.cpf || d.cnpj);
    });
    colunaDocAusente = (docConfirmado === -1);
  }

  var out = [];
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    if (!row || !row.length) continue;
    var unidadeRaw = iUnidade >= 0 ? cleanVal(row[iUnidade]) : '';
    if (!unidadeRaw) continue;

    var pessoas = blocos.map(function(b) {
      var nome = cleanVal(row[b.iNome]);
      if (!nome) return null;
      var doc = limparDocumento(b.iDoc >= 0 ? cleanVal(row[b.iDoc]) : '');
      var tel1 = b.iTel1 >= 0 ? cleanDigits(row[b.iTel1]) : '';
      var tel2 = b.iTel2 >= 0 ? cleanDigits(row[b.iTel2]) : '';
      return {
        nome: nome, cpf: doc.cpf, cnpj: doc.cnpj,
        rg: b.iRg >= 0 ? cleanVal(row[b.iRg]) : '',
        email: b.iEmail >= 0 ? cleanVal(row[b.iEmail]) : '',
        telefone: tel1 || tel2
      };
    }).filter(Boolean);

    // B2: mesmo sem NENHUM proponente com nome, a unidade tem que entrar
    // como item COM ERRO "Unidade sem proprietario" (validarUnidadesAgrupadas
    // cuida disso via prop_nome vazio), nunca sumir em silencio. Espelha
    // processFamiliaPlana, que sempre empurra a linha independente do nome.
    var titular = pessoas[0] || { nome: '', cpf: '', cnpj: '', rg: '', email: '', telefone: '' };
    var extras = pessoas.length > 1 ? pessoas.slice(1) : [];

    out.push({
      _linha: ri + 2,
      _unidadeRaw: unidadeRaw,
      ST_UNIDADE_UNI: unidadeRaw,
      ST_BLOCO_UNI: iBloco >= 0 ? cleanVal(row[iBloco]) : '',
      prop_nome:  titular.nome,
      prop_cpf:   titular.cpf,
      prop_cnpj:  titular.cnpj,
      prop_rg:    titular.rg,
      prop_email: titular.email,
      prop_fone:  titular.telefone,
      prop_cel:   '',
      contatos_extras: extras.map(function(p) {
        return {
          tipo: 'dependente', tipoResp: '4', nome: p.nome, cpf: p.cpf, cnpj: p.cnpj,
          rg: p.rg, email: p.email, telefone: p.telefone, ddi: p.telefone ? '55' : '',
          dtEntrada: '', recebeCobranca: ''
        };
      })
    });
  }
  return validarUnidadesAgrupadas(out, colunaDocAusente);
}

// Separa o texto da unidade em numero e bloco. No W045A o numero vem primeiro
// e o bloco depois: "LJ17 B8" vira numero "LJ17" bloco "B8"; "0101 A2" vira
// "0101"/"A2"; "101 A" vira "101"/"A"; "001" vira "001"/"".
function splitUnidadeNumeroBloco(raw) {
  var v = String(raw == null ? '' : raw).trim();
  if (!v) return { numero: '', bloco: '' };
  var partes = v.split(/\s+/);
  if (partes.length >= 2) return { numero: partes[0], bloco: partes.slice(1).join(' ') };
  return { numero: v, bloco: '' };
}

// Extrai telefones validos de uma celula suja. As planilhas trazem ruido como
// "(27)992388313Larissa" ou "irmao Aleandro tel 3752-1255". Pega cada sequencia
// de digitos com 8 a 13 numeros, remove o codigo de pais 55 quando presente, e
// devolve so os numeros validos. Nunca inventa: o que nao for digito e descartado.
function extrairTelefonesValidos(str) {
  if (!str) return [];
  // Charset intencionalmente SEM ponto: telefones nas planilhas usam espaco,
  // parenteses, + e hifen como separador, enquanto datas usam ponto (15.05.2024).
  // Excluir o ponto evita capturar datas como se fossem numeros de telefone.
  var bruto = String(str).match(/\d[\d\s()+-]{6,}\d/g) || [];
  var out = [];
  bruto.forEach(function(m) {
    var d = m.replace(/\D/g, '');
    // Remove codigo de pais 55 quando o numero fica com 12 ou 13 digitos
    if ((d.length === 12 || d.length === 13) && d.indexOf('55') === 0) d = d.slice(2);
    if (d.length >= 8 && d.length <= 11 && out.indexOf(d) === -1) out.push(d);
  });
  return out;
}

// Classifica o documento por quantidade de digitos: 14 e CNPJ, 11 e CPF.
// Valores fora desses tamanhos ficam vazios para nao gerar documento invalido.
function limparDocumento(str) {
  var d = String(str == null ? '' : str).replace(/\D/g, '');
  if (d.length === 14) return { cpf: '', cnpj: d };
  if (d.length === 11) return { cpf: d, cnpj: '' };
  return { cpf: '', cnpj: '' };
}

// Acrescenta um trecho a observacao sem perder o que ja estava la.
function anexarObs(obsAtual, trecho) {
  if (!trecho) return obsAtual || '';
  return obsAtual ? (obsAtual + ' | ' + trecho) : trecho;
}

// B1 (pre-correcao NAO destrutiva, autorizada pelo Matheus): confirma, linha
// a linha, que Telefone/Celular/Endereco/.../Fracao estao na posicao
// esperada usando a camada de assinatura de conteudo (CPF/CNPJ, email, UF,
// CEP, fracao). Quando o encaixe da linha original bate PIOR que o encaixe
// com os campos de Celular em diante deslocados uma posicao a direita
// (sintoma classico de Telefone vazio empurrando o resto da linha pra
// esquerda), corrige SO aquela linha antes de chamar parseW045AContatos, que
// continua intocado e recebe dado ja limpo, aplicando a mesma logica de
// papel/agrupamento de sempre. Localiza colunas do mesmo jeito tolerante que
// parseW045AContatos (este e um passo anterior e independente do parser).
function corrigirDeslocamentoW045A(headers, rawRows) {
  var h = headers.map(function(s) { return String(s || '').trim().toLowerCase(); });
  var acharCol = function(preds) {
    for (var i = 0; i < h.length; i++) {
      for (var p = 0; p < preds.length; p++) { if (h[i].indexOf(preds[p]) !== -1) return i; }
    }
    return -1;
  };
  var iTel    = acharCol(['telefone']);
  var iEstado = acharCol(['estado', 'uf']);
  var iCep    = acharCol(['cep']);
  var iDoc    = acharCol(['cpf', 'cnpj']);
  var iEmail  = acharCol(['mail']);
  var iFracao = acharCol(['fração', 'fracao']);
  // So corrige quando ha um bloco continuo Telefone..Fracao pra deslocar;
  // senao nao ha o que comparar e as linhas voltam intactas.
  if (iTel < 0 || iFracao < 0 || iFracao <= iTel) return rawRows;

  var colMap = { cpf: iDoc, cnpj: iDoc, email: iEmail, estado: iEstado, cep: iCep, fracao: iFracao };
  return rawRows.map(function(row) {
    if (!row || !row.length) return row;
    var scoreOriginal = assinarLinha(row, colMap);
    // Candidato: Celular em diante desloca uma posicao a direita (Telefone
    // "recebe" uma celula vazia de volta), recuperando o valor real que teria
    // ficado deslocado por causa de um Telefone vazio na planilha de origem.
    var candidato = row.slice();
    for (var i = iFracao; i > iTel; i--) candidato[i] = row[i - 1];
    candidato[iTel] = '';
    var scoreCandidato = assinarLinha(candidato, colMap);
    // So troca quando o encaixe deslocado bate ESTRITAMENTE melhor: nunca
    // reordena uma linha que ja esta correta.
    return scoreCandidato > scoreOriginal ? candidato : row;
  });
}

// Le a planilha A2 (linhas a partir do cabecalho, SEM filtrar as linhas de
// unidade em branco, pois elas herdam a unidade de cima) e devolve uma lista
// plana de contatos. Cada contato carrega tipoOriginal (valor cru da coluna
// Tipo) para o motor de inferencia decidir o papel depois.
function parseW045AContatos(headers, rawRows) {
  var h = headers.map(function(s) { return String(s || '').trim().toLowerCase(); });
  // Localiza indices de coluna de forma flexivel (tolera variacao de nome)
  var acharCol = function(preds) {
    for (var i = 0; i < h.length; i++) {
      for (var p = 0; p < preds.length; p++) { if (h[i].indexOf(preds[p]) !== -1) return i; }
    }
    return -1;
  };
  var iUnidade = 0;
  var iNome    = h.indexOf('nome');
  var iTipo    = h.indexOf('tipo');
  var iTel     = acharCol(['telefone']);
  var iCel     = acharCol(['celular']);
  var iEnd     = acharCol(['endereço', 'endereco']);
  var iCompl   = acharCol(['complemento']);
  var iBairro  = acharCol(['bairro']);
  var iCidade  = acharCol(['cidade']);
  var iEstado  = acharCol(['estado', 'uf']);
  var iCep     = acharCol(['cep']);
  var iDoc     = acharCol(['cpf', 'cnpj']);
  var iEmail   = acharCol(['mail']);
  var iFracao  = acharCol(['fração', 'fracao']);

  var clean = function(row, idx) {
    if (idx < 0) return '';
    var v = row[idx];
    if (v === null || v === undefined) return '';
    var s = String(v).trim();
    var lower = s.toLowerCase();
    if (['nan', 'cep inválido', 'cep invalido', 'inválido', 'invalido'].indexOf(lower) !== -1) return '';
    return s;
  };

  var contatos = [];
  var ultimaUnidade = '';
  var seq = 0;

  rawRows.forEach(function(row) {
    if (!row || row.length === 0) return;
    var unidadeCel = clean(row, iUnidade);
    if (unidadeCel) ultimaUnidade = unidadeCel;
    var nome = clean(row, iNome);
    var tipoOriginal = clean(row, iTipo);
    // Linha sem nome e sem tipo nao representa pessoa (cabecalho repetido, rodape)
    if (!nome && !tipoOriginal) return;
    if (!ultimaUnidade) return;

    var split = splitUnidadeNumeroBloco(ultimaUnidade);
    var doc = limparDocumento(clean(row, iDoc));

    // Telefones: junta as duas colunas, separa validos, primeiro vira o campo,
    // o resto vai pra observacao para nao se perder.
    var tels = extrairTelefonesValidos(clean(row, iTel) + ' ; ' + clean(row, iCel));
    var telefone = tels.length ? tels[0] : '';
    var telExtras = tels.slice(1);

    // Emails: o primeiro vai pro campo, demais pra observacao.
    var emailsBrutos = clean(row, iEmail).split(/[;,]/).map(function(s) { return s.trim(); }).filter(Boolean);
    var email = emailsBrutos.length ? emailsBrutos[0] : '';
    var emailExtras = emailsBrutos.slice(1);

    var obs = '';
    if (telExtras.length)  obs = anexarObs(obs, 'Telefones extras: ' + telExtras.join(', '));
    if (emailExtras.length) obs = anexarObs(obs, 'Emails extras: ' + emailExtras.join(', '));

    seq += 1;
    contatos.push({
      id: seq,
      unidade: split.numero,
      bloco: split.bloco,
      nome: nome,
      tipoOriginal: tipoOriginal,
      papel: '',
      confianca: '',
      motivo: '',
      cpf: doc.cpf,
      cnpj: doc.cnpj,
      rg: '',
      dtNasc: '',
      genero: '',
      email: email,
      ddi: telefone ? '55' : '',
      telefone: telefone,
      tipoTel: '',
      cep: clean(row, iCep).replace(/\D/g, ''),
      endereco: clean(row, iEnd),
      numero: '',
      complemento: clean(row, iCompl),
      bairro: clean(row, iBairro),
      cidade: clean(row, iCidade),
      estado: clean(row, iEstado),
      fracao: clean(row, iFracao),
      dtEntrada: '',
      dtSaida: '',
      recebeCobranca: '',
      obs: obs
    });
  });

  return contatos;
}

// Compara sobrenomes para o sinal fraco de parentesco. Considera parentes se
// o ultimo sobrenome coincide ou se ha qualquer token de sobrenome em comum.
function mesmoSobrenome(a, b) {
  var sa = String(a || '').trim().toUpperCase().split(/\s+/).filter(function(t) { return t.length > 2; });
  var sb = String(b || '').trim().toUpperCase().split(/\s+/).filter(function(t) { return t.length > 2; });
  if (!sa.length || !sb.length) return false;
  if (sa[sa.length - 1] === sb[sb.length - 1]) return true;
  return sa.some(function(t) { return sb.indexOf(t) !== -1; });
}

// Detecta a marcacao textual de inquilino escrita DENTRO do nome do contato
// (alguns condominios nao usam a coluna Tipo para inquilino). Regra geral, nao
// lista fixa de condominio. Devolve:
//   'titular' quando a palavra inquilino/inquilina qualifica a propria pessoa
//             (ex "Inquilino - JONAS", "LUANNA - INQUILINA", "Inquilino-LUCAS");
//   'parente' quando inquilino vem numa construcao de parentesco (ex "cunhada do
//             inquilino", "sogra inquilino"), entao a pessoa e parente, nao o titular;
//   null      quando nao ha mencao a inquilino no nome.
// Cobre variacoes de grafia: hifen, sem espaco, maiusculo/minusculo, antes ou
// depois do nome, com e sem acento.
// Graus de parentesco reconhecidos (acento ja removido pelo normalize, entao
// "irma", "irma", "irmao", "irmao" caem todos aqui). A deteccao de parentesco
// NAO depende do acento: depende da LIGACAO com um titular (ver abaixo).
var _PARENTESCO = 'cunhad[oa]|sogr[oa]|genro|nora|filh[oa]|entead[oa]|padrasto|madrasta|pai|mae|irma|irmao|esposo|esposa|marido|mulher|companheir[oa]|tio|tia|sobrinh[oa]|prim[oa]|avo|avos|net[oa]|namorad[oa]|conjuge|parente|agregad[oa]';
// Parentesco LIGADO a "inquilino": grau de parentesco seguido (so por espacos,
// NUNCA por hifen) de um "do/da" opcional e da palavra inquilino. O \\s+ sem hifen
// e proposital: protege "IRMA - INQUILINA" (nome + qualificador, a propria pessoa
// e a inquilina) de virar parente, ja que ali ha hifen entre o nome e inquilina.
var _PARENTESCO_LIGADO_INQ_RE = new RegExp('\\b(' + _PARENTESCO + ')\\s+(d[oa]\\s+)?inquilin');
// Mesmo para "proprietario/proprietaria": parente do dono (ex "irmao da
// proprietaria", "namorado proprietaria") vira Dependente, sem confundir com a
// propria dona ("MAYARA - PROPRIETARIA"), que nao tem grau de parentesco antes.
var _PARENTESCO_LIGADO_PROP_RE = new RegExp('\\b(' + _PARENTESCO + ')\\s+(d[oa]\\s+)?proprietari');
// Campo cujo conteudo INTEIRO e um unico grau de parentesco (compilado uma vez).
var _SO_PARENTESCO_RE = new RegExp('^(' + _PARENTESCO + ')$');

// Titular declarado pela COLUNA Tipo (nao por marcacao no nome): Proprietario,
// Inquilino ou Locatario. Esses sao a evidencia mais forte do documento e nao
// devem ser rebaixados nem virar incertos pelas regras de parentesco no nome
// (mesma protecao que evita deixar a unidade sem dono).
function ehTitularDeclarado(tipoOriginal) {
  return /^(propriet[aá]ri[oa]|inquilino|locat[aá]ri[oa])$/i.test(String(tipoOriginal || '').trim());
}

// Detecta a marcacao textual de inquilino DENTRO do nome do contato (condominios
// que nao usam a coluna Tipo para inquilino). O que decide nao e o acento, e a
// LIGACAO com o titular. Devolve:
//   'titular' -> inquilino qualifica a propria pessoa ("Inquilino - JONAS",
//                "LUANNA - INQUILINA"); a pessoa e o inquilino;
//   'parente' -> grau de parentesco ligado a inquilino ("cunhada do inquilino",
//                "irma do inquilino" mesmo sem acento, "cunhada inquilino");
//   null      -> nao ha mencao a inquilino no nome.
// Protecao contra nome proprio: "Irma Souza Costa" (sem inquilino no campo) -> null;
// "Inquilino - Irma" -> titular (inquilino vem antes do nome, nao ha parentesco
// ligando Irma a outro titular).
function marcacaoInquilino(nome) {
  var t = String(nome || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!/inquilin[oa]/.test(t)) return null;
  if (/\bd[oa]\s+inquilin/.test(t)) return 'parente';   // X do/da inquilino
  if (_PARENTESCO_LIGADO_INQ_RE.test(t)) return 'parente';  // parentesco ligado a inquilino
  return 'titular';
}

// Parente do PROPRIETARIO ligado no nome (ex "irmao da proprietaria"): a pessoa e
// dependente do dono, nao o dono. So dispara com grau de parentesco antes de
// "proprietario", entao "MAYARA - PROPRIETARIA" (a propria dona) nao casa.
function parenteDeProprietario(nome) {
  var t = String(nome || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Possessivo "X do/da proprietario" (qualquer X) OU grau de parentesco adjacente.
  return /\bd[oa]\s+proprietari/.test(t) || _PARENTESCO_LIGADO_PROP_RE.test(t);
}

// Caso duvidoso: o campo so tem grau(s) de parentesco, sem nome de pessoa e sem
// ligacao a titular (ex o campo inteiro e "irmao" ou "irma"). Cadastro incompleto:
// cai como incerto para o operador decidir, nunca chuta.
function nomeSoParentesco(nome) {
  var t = String(nome || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, ' ').trim();
  if (/inquilin|proprietari/.test(t)) return false; // tem ligacao a titular: nao e o caso duvidoso
  var toks = t.split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  var filler = /^(do|da|de|e)$/;
  var temParente = false, temOutro = false;
  toks.forEach(function(tk) { if (_SO_PARENTESCO_RE.test(tk)) temParente = true; else if (!filler.test(tk)) temOutro = true; });
  return temParente && !temOutro;
}
// Le o qualificador entre parenteses no nome e classifica o papel na familia do
// inquilino. Usado para desempatar quando ha varios "Inquilino -" na unidade.
//   'titular'    -> (Marido), (Esposa), (Titular), (Companheiro) etc;
//   'dependente' -> (Filho), (Filha), (Dependente) ou parentesco claro;
//   null         -> sem parenteses, ou conteudo que nao deixa claro o papel.
// Varre TODOS os pares de parenteses e devolve o primeiro que classificar, para
// nao falhar quando o nome traz outro parentese antes (ex "(APT 302) (Esposa)").
function qualificadorPapel(nome) {
  var t = String(nome || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  var re = /\(([^)]*)\)/g, m;
  while ((m = re.exec(t)) !== null) {
    var q = m[1].trim();
    if (/\b(marido|esposo|esposa|titular|companheir[oa]|conjuge)\b/.test(q)) return 'titular';
    if (/\b(filh[oa]|dependente|net[oa]|entead[oa]|sobrinh[oa]|irma|irmao|prim[oa]|cunhad[oa]|sogr[oa]|genro|nora|menor|crianc[ao])\b/.test(q)) return 'dependente';
  }
  return null;
}

// Motor de inferencia de papel. Recebe a lista plana de contatos, agrupa por
// unidade+bloco e define papel (proprietario|inquilino|dependente|descartar),
// confianca (alta|media|incerta) e motivo de cada um, seguindo os sinais
// aprovados. Mutaciona e devolve a propria lista.
function inferirPapeis(contatos) {
  var PROP = ['proprietário', 'proprietario'];
  var INQ  = ['inquilino', 'locatário', 'locatario'];
  var IMOB = ['imobiliária', 'imobiliaria'];

  // Agrupa preservando a ordem de aparicao
  var grupos = {};
  var ordem = [];
  contatos.forEach(function(c) {
    var chave = c.unidade + '|' + c.bloco;
    if (!grupos[chave]) { grupos[chave] = []; ordem.push(chave); }
    grupos[chave].push(c);
  });

  ordem.forEach(function(chave) {
    var grupo = grupos[chave];

    // Passo 1: classificacao base pelo tipo declarado
    grupo.forEach(function(c) {
      var t = String(c.tipoOriginal || '').trim().toLowerCase();
      c._cls = '';
      if (PROP.indexOf(t) !== -1) {
        c._cls = 'prop';
      } else if (INQ.indexOf(t) !== -1) {
        c.papel = 'inquilino'; c.confianca = 'alta'; c.motivo = 'Tipo declarado: Inquilino';
      } else if (t === 'dependente') {
        c.papel = 'dependente'; c.confianca = 'alta'; c.motivo = 'Tipo declarado: Dependente';
      } else if (IMOB.indexOf(t) !== -1) {
        c.papel = 'descartar'; c.confianca = 'media'; c._imob = true;
        c.motivo = 'Imobiliaria administra a unidade, nao e morador; contato guardado na Observacao';
      } else if (t === 'visitante') {
        c.papel = 'descartar'; c.confianca = 'media';
        c.motivo = 'Visitante nao e morador fixo; revise se deve entrar no cadastro';
      } else if (t === 'residente') {
        c._residente = true;
      } else {
        c._semTipo = true;
      }
    });

    var owners = grupo.filter(function(c) { return c._cls === 'prop'; });
    var ownerHumano = owners.filter(function(c) { return !c.cnpj; })[0] || null;
    var temCnpjOwner = owners.some(function(c) { return c.cnpj; });

    // Passo 2: titularidade
    if (owners.length === 1) {
      owners[0].papel = 'proprietario'; owners[0].confianca = 'alta';
      owners[0].motivo = 'Tipo declarado: Proprietario';
    } else if (owners.length > 1) {
      owners.forEach(function(o) {
        o.papel = 'proprietario'; o.confianca = 'incerta';
        o.motivo = 'Unidade com mais de um Proprietario declarado, confirme o titular de cobranca';
      });
    }

    // Passo 3: resolucao de Residente
    grupo.filter(function(c) { return c._residente; }).forEach(function(r) {
      if (temCnpjOwner) {
        r.papel = 'inquilino'; r.confianca = 'media';
        r.motivo = 'Proprietario e empresa (CNPJ); residente tratado como inquilino';
      } else if (ownerHumano) {
        if (mesmoSobrenome(r.nome, ownerHumano.nome)) {
          r.papel = 'dependente'; r.confianca = 'media';
          r.motivo = 'Residente com sobrenome do titular, provavel familiar';
        } else {
          r.papel = 'inquilino'; r.confianca = 'media';
          r.motivo = 'Residente sem parentesco aparente em unidade com proprietario, provavel inquilino';
        }
      } else {
        // Sem proprietario na unidade: o primeiro residente vira o melhor palpite
        // de titular; os demais ficam como dependente incerto para nao gerar dois
        // proprietarios na mesma unidade. A decisao final e do operador na revisao.
        var jaHaProp = grupo.some(function(x) { return x.papel === 'proprietario'; });
        if (jaHaProp) {
          r.papel = 'dependente'; r.confianca = 'incerta';
          r.motivo = 'Residente adicional em unidade sem proprietario declarado, confirme se e dependente ou inquilino';
        } else {
          r.papel = 'proprietario'; r.confianca = 'incerta';
          r.motivo = 'Residente isolado sem proprietario declarado, melhor palpite a confirmar';
        }
      }
    });

    // Passo 4: pessoas sem tipo viram dependente por padrao
    grupo.filter(function(c) { return c._semTipo; }).forEach(function(c) {
      c.papel = 'dependente'; c.confianca = 'media';
      c.motivo = 'Tipo nao informado no documento, classificado como dependente';
    });

    // Passo 5: eleicao de titular quando a unidade nao tem nenhum proprietario
    if (owners.length === 0) {
      var candidatos = grupo.filter(function(c) { return c.papel !== 'descartar'; });
      var jaTemProp = candidatos.some(function(c) { return c.papel === 'proprietario'; });
      if (candidatos.length && !jaTemProp) {
        // Melhor palpite: prioriza CNPJ, depois quem tem CPF e telefone, senao o primeiro
        var eleito = candidatos.filter(function(c) { return c.cnpj; })[0] ||
                     candidatos.filter(function(c) { return c.cpf && c.telefone; })[0] ||
                     candidatos.filter(function(c) { return c.cpf; })[0] ||
                     candidatos[0];
        eleito.papel = 'proprietario'; eleito.confianca = 'incerta';
        eleito.motivo = 'Unidade sem Proprietario declarado, eleito como melhor palpite, confirme';
      }
    }

    // Passo 6: guarda o contato da imobiliaria na observacao de um contato mantido
    var imobs = grupo.filter(function(c) { return c._imob; });
    if (imobs.length) {
      var alvo = grupo.filter(function(c) { return c.papel === 'proprietario'; })[0] ||
                 grupo.filter(function(c) { return c.papel !== 'descartar'; })[0] || null;
      if (alvo) {
        imobs.forEach(function(im) {
          var info = 'Imobiliaria: ' + (im.nome || '') +
                     (im.telefone ? ' tel ' + im.telefone : '') +
                     (im.email ? ' ' + im.email : '');
          alvo.obs = anexarObs(alvo.obs, info.trim());
        });
      }
    }

    // Passo 7: marcacao textual de inquilino no nome SOBREPOE a inferencia.
    // So age quando ha marcacao no nome; condominios que usam a coluna Tipo para
    // inquilino normalmente nao tem marcacao e seguem intactos (regra 4).
    grupo.forEach(function(c) { c._marc = marcacaoInquilino(c.nome); });
    var titulares = grupo.filter(function(c) { return c._marc === 'titular'; });
    var parentes = grupo.filter(function(c) { return c._marc === 'parente'; });
    // Rebaixa inquilinos vindos da INFERENCIA (nao da coluna Tipo nem de marcacao)
    // quando a unidade tem marcacao textual: so pode haver um inquilino por unidade.
    var rebaixarInferidos = function(conf, motivo) {
      grupo.forEach(function(c) {
        // So rebaixa inquilino vindo da INFERENCIA. Preserva o que veio da coluna
        // Tipo (Inquilino ou Locatario) e o que veio da marcacao textual (_marc).
        if (c.papel === 'inquilino' && c._marc == null &&
            !/^(inquilino|locat[aá]ri[oa])$/i.test(String(c.tipoOriginal || '').trim())) {
          c.papel = 'dependente'; c.confianca = conf; c.motivo = motivo;
        }
      });
    };
    if (titulares.length === 1) {
      titulares[0].papel = 'inquilino'; titulares[0].confianca = 'media';
      titulares[0].motivo = 'Inquilino identificado pela marcacao no nome do contato';
      parentes.forEach(function(p) { p.papel = 'dependente'; p.confianca = 'media'; p.motivo = 'Parente do inquilino, marcado no nome'; });
      rebaixarInferidos('media', 'Inquilino titular definido por marcacao textual; este passa a dependente');
    } else if (titulares.length > 1) {
      // Varios "Inquilino -" na unidade. Tenta resolver pelos qualificadores entre
      // parenteses, mas SO em caso 100% claro: exatamente um titular (Marido/Esposa/
      // Titular) e todos os demais com qualificador de dependente. Qualquer ausencia
      // ou ambiguidade cai incerta (nunca chuta o titular).
      var quals = titulares.map(function(t) { return qualificadorPapel(t.nome); });
      var nTitular = quals.filter(function(q) { return q === 'titular'; }).length;
      var todosClassificados = quals.every(function(q) { return q != null; });
      if (nTitular === 1 && todosClassificados) {
        titulares.forEach(function(t, i) {
          if (quals[i] === 'titular') { t.papel = 'inquilino'; t.confianca = 'media'; t.motivo = 'Inquilino titular pelo qualificador no nome (ex Marido/Titular)'; }
          else { t.papel = 'dependente'; t.confianca = 'media'; t.motivo = 'Dependente do inquilino pelo qualificador no nome (ex Filho/Filha)'; }
        });
        parentes.forEach(function(p) { p.papel = 'dependente'; p.confianca = 'media'; p.motivo = 'Parente do inquilino, marcado no nome'; });
        rebaixarInferidos('media', 'Inquilino titular definido por qualificador; este passa a dependente');
      } else {
        titulares.forEach(function(t) { t.papel = 'inquilino'; t.confianca = 'incerta'; t.motivo = 'Mais de um candidato a inquilino sem qualificador claro de titular, defina o titular'; });
        parentes.forEach(function(p) { p.papel = 'dependente'; p.confianca = 'incerta'; p.motivo = 'Parente de inquilino em unidade com titular indefinido'; });
        rebaixarInferidos('incerta', 'Unidade com mais de um candidato a inquilino, defina o titular');
      }
    } else if (parentes.length) {
      // Ha parentes de inquilino mas nenhum titular claro: unidade incerta
      parentes.forEach(function(p) { p.papel = 'dependente'; p.confianca = 'incerta'; p.motivo = 'Parente de inquilino sem titular claro na unidade, defina o inquilino titular'; });
      rebaixarInferidos('incerta', 'Unidade tem parente de inquilino mas titular indefinido, defina o titular');
    }

    // Passo 8: parentesco ligado ao PROPRIETARIO no nome (ex "irmao da
    // proprietaria") e dependente do dono. So rebaixa quem nao veio da coluna Tipo
    // nem da marcacao textual de inquilino, para nao mexer em titular declarado.
    grupo.forEach(function(c) {
      if (c.papel !== 'dependente' && c.papel !== 'descartar' && c._marc == null &&
          !/^(proprietario|propriet[aá]ri[oa]|inquilino|locat[aá]ri[oa])$/i.test(String(c.tipoOriginal || '').trim()) &&
          parenteDeProprietario(c.nome)) {
        c.papel = 'dependente'; c.confianca = 'media'; c.motivo = 'Parente do proprietario, ligado no nome do contato';
      }
    });

    // Passo 9: campo so com grau de parentesco, sem nome nem ligacao a titular,
    // cai incerto para decisao manual (cadastro incompleto). Nunca chuta. Nao
    // mexe em titular declarado pela coluna Tipo (ex proprietario chamado "Irma").
    grupo.forEach(function(c) {
      if (c.papel !== 'descartar' && c.papel !== 'proprietario' &&
          !ehTitularDeclarado(c.tipoOriginal) && nomeSoParentesco(c.nome)) {
        c.confianca = 'incerta';
        c.motivo = 'Campo so traz grau de parentesco, sem nome nem titular ligado; defina manualmente';
      }
    });

    // Passo 10: regra especial SO para "irma"/"irmao" (decisao do Matheus 2026-06-30):
    // a palavra (com/sem acento, normalizada) e SEMPRE parentesco -> Dependente,
    // sem exigir ligacao com titular. Campo literalmente so "irma"/"irmao" sem nome
    // cai incerto. NAO demove titular declarado pela coluna Tipo (proprietario,
    // inquilino ou locatario chamado "Irma"), para nao deixar a unidade sem titular;
    // mas a marcacao textual "Inquilino - Irma" no nome vira dependente (a palavra
    // irma vence, decisao consciente do Matheus). "irma|irmao" sao seguros nessa
    // ordem: o \b nas duas pontas impede "irma" de casar dentro de "irmao".
    grupo.forEach(function(c) {
      if (c.papel === 'descartar' || c.papel === 'proprietario' || ehTitularDeclarado(c.tipoOriginal)) return;
      var t = String(c.nome || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (!/\b(irma|irmao)\b/.test(t)) return;
      var soPalavra = /^(irma|irmao)$/.test(t.replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim());
      if (soPalavra) {
        c.papel = 'dependente'; c.confianca = 'incerta';
        c.motivo = 'Campo so com "irma/irmao" sem nome de pessoa; defina manualmente';
      } else if (c.papel !== 'dependente') {
        c.papel = 'dependente'; c.confianca = 'media';
        c.motivo = 'Contato com "irma/irmao" tratado sempre como parente (dependente)';
      }
    });

    // Limpeza dos marcadores temporarios
    grupo.forEach(function(c) {
      delete c._cls; delete c._residente; delete c._semTipo; delete c._imob; delete c._marc;
      if (!c.papel) { c.papel = 'dependente'; c.confianca = 'media'; c.motivo = 'Sem classificacao, dependente por seguranca'; }
    });
  });

  return contatos;
}

// C2: valida documento (CPF/CNPJ) por contato no caminho W045A, com a MESMA
// regra do B4 ("e CPF valido de 11 digitos OU CNPJ valido de 14, nunca so
// CPF"). parseW045AContatos + inferirPapeis produzem uma lista PLANA de
// contatos (nao o shape agrupado de validarUnidadesAgrupadas), entao valida
// direto sobre essa lista, sem forcar o shape agrupado nem reescrever os dois
// parsers. Semantica igual ao resto do fluxo: proprietario sem documento
// valido = erro; dependente/inquilino so reprovam quando HA documento e o
// formato e invalido (M5), documento ausente neles nao e erro. Unidade que
// nao elegeu nenhum proprietario (ex todos os contatos foram descartados)
// marca "Unidade sem proprietario" em quem sobrou. Marca _erros/_valido em
// cada contato pra cair no chip "Com erro" da tela de revisao (decisao 3:
// nunca em silencio).
function validarDocumentosW045A(contatos) {
  var temProprietario = {};
  (contatos || []).forEach(function(c) {
    if (c.papel === 'proprietario') temProprietario[c.unidade + '|' + c.bloco] = true;
  });
  (contatos || []).forEach(function(c) {
    var erros = [];
    var doc = c.cpf || c.cnpj || '';
    if (c.papel === 'proprietario') {
      if (!doc) erros.push('CPF/CNPJ ausente');
      else if (!isCPF(doc) && !isCNPJ(doc)) erros.push('CPF/CNPJ invalido');
    } else if (c.papel !== 'descartar' && doc && !isCPF(doc) && !isCNPJ(doc)) {
      erros.push('CPF/CNPJ invalido');
    }
    if (c.papel !== 'descartar' && !temProprietario[c.unidade + '|' + c.bloco]) {
      erros.push('Unidade sem proprietario');
    }
    c._erros = erros;
    c._valido = erros.length === 0;
  });
  return contatos;
}

// Converte um contato revisado numa linha de 26 colunas no formato unificado,
// para reaproveitar processUnidadesDataUnificada (logica de agrupamento e envio
// ja testada) sem reimplementar a montagem do payload do Superlogica.
function contatoParaLinha26(c) {
  var papelToTipo = { proprietario: 'Proprietario', inquilino: 'Inquilino', dependente: 'Dependente' };
  return [
    papelToTipo[c.papel] || 'Dependente', // A Tipo
    c.unidade || '',                       // B Unidade
    c.bloco || '',                         // C Bloco
    c.fracao || '',                        // D Fracao
    '',                                    // E Metragem
    c.nome || '',                          // F Nome
    c.cpf || '',                           // G CPF
    c.cnpj || '',                          // H CNPJ
    c.rg || '',                            // I RG
    c.dtNasc || '',                        // J Data Nascimento
    c.genero || '',                        // K Genero
    c.email || '',                         // L Email
    c.ddi || '',                           // M DDI
    c.telefone || '',                      // N Telefone
    c.tipoTel || '',                       // O Tipo Telefone
    c.cep || '',                           // P CEP
    c.endereco || '',                      // Q Endereco
    c.numero || '',                        // R Numero
    c.complemento || '',                   // S Complemento
    c.bairro || '',                        // T Bairro
    c.cidade || '',                        // U Cidade
    c.estado || '',                        // V Estado
    c.dtEntrada || '',                     // W Data Entrada
    c.dtSaida || '',                       // X Data Saida
    c.recebeCobranca || '',                // Y Recebe Cobranca
    c.obs || ''                            // Z Observacao
  ];
}

// ============================================================
// EXTRACAO DE PDF POR CODIGO (familia A1, W045A posicional)
// ------------------------------------------------------------
// Estrategia hibrida: documentos de padrao conhecido (W045A, planilhas A2 e A3)
// sao processados 100% por codigo, sem IA e sem token. A IA so entra como
// fallback consciente quando nenhum reconhecedor bate. pdfjs-dist roda no
// proprio navegador (CDN oficial Cloudflare), entao os dados dos condominos
// nao saem da maquina. Arquitetura extensivel: cada layout de administradora
// vira um objeto em RECONHECEDORES_PDF, sem reescrever o resto.
// ============================================================

// Carrega o pdfjs-dist sob demanda do CDN. Resolve com a lib ja pronta e o
// worker configurado. Reusa a mesma promessa em chamadas seguintes.
var PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
var PDFJS_WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
var _pdfjsPromise = null;
function carregarPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = new Promise(function(resolve, reject) {
    // Em qualquer falha limpa a promessa cacheada para permitir nova tentativa
    // (senao um CDN momentaneamente fora travaria o recurso ate recarregar a pagina).
    var falhar = function(msg) { _pdfjsPromise = null; reject(new Error(msg)); };
    var s = document.createElement('script');
    s.src = PDFJS_CDN;
    s.onload = function() {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
        resolve(window.pdfjsLib);
      } else { falhar('pdfjs nao inicializou'); }
    };
    s.onerror = function() { falhar('falha ao baixar pdfjs do CDN'); };
    document.head.appendChild(s);
  });
  return _pdfjsPromise;
}

// Le o PDF e devolve uma lista de paginas, cada uma com seus itens de texto
// posicionados: { x, y, w, str }. Base para os reconhecedores posicionais.
async function extrairItensPdf(file) {
  var pdfjsLib = await carregarPdfjs();
  var buf = await file.arrayBuffer();
  var doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  var paginas = [];
  for (var p = 1; p <= doc.numPages; p++) {
    var pg = await doc.getPage(p);
    var tc = await pg.getTextContent();
    paginas.push({ items: tc.items.map(function(it) {
      return { x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), w: Math.round(it.width), str: it.str };
    }).filter(function(it) { return it.str.trim() !== ''; }) });
  }
  return paginas;
}

// Tipos validos da coluna Tipo do W045A (define o que e uma linha de pessoa).
var TIPOS_W045A = ['proprietário','proprietario','dependente','residente','visitante','inquilino','imobiliária','imobiliaria','locatário','locatario'];
// Distancia vertical maxima (px) para considerar uma linha como continuacao
// (telefone, 2a linha de endereco) da pessoa acima.
var GAP_CONTINUACAO_W045A = 40;
// Margem horizontal (px) alem da primeira e da ultima ancora: itens fora dessa
// faixa (ex numero de pagina a direita) nao pertencem a nenhuma coluna da tabela.
var MARGEM_COLUNA_W045A = 110;

// Acha as ancoras de coluna LENDO O CABECALHO POR ROTULO (nao por X fixo), para
// cobrir variacoes do template W045A entre administradoras. Devolve o X de cada
// coluna conhecida, ou null se a pagina nao for um W045A.
function acharAncorasW045A(itens) {
  var porY = {};
  itens.forEach(function(it) { var k = Math.round(it.y); (porY[k] = porY[k] || []).push(it); });
  var ys = Object.keys(porY).map(Number).sort(function(a, b) { return b - a; });
  for (var i = 0; i < ys.length; i++) {
    var linha = porY[ys[i]];
    var txt = linha.map(function(it) { return it.str.toLowerCase(); }).join(' | ');
    if (/unidade/.test(txt) && /tipo/.test(txt) && /nome/.test(txt) && (/cpf|cnpj/.test(txt) || /mail/.test(txt))) {
      var a = {};
      linha.forEach(function(it) {
        var s = it.str.toLowerCase();
        if (/unidade/.test(s) && a.unidade == null) a.unidade = it.x;
        else if (/nome/.test(s) && a.nome == null) a.nome = it.x;
        else if (/^tipo/.test(s) && a.tipo == null) a.tipo = it.x;
        else if (/endere/.test(s) && a.endereco == null) a.endereco = it.x;
        else if (/(cpf|cnpj)/.test(s) && a.doc == null) a.doc = it.x;
        else if (/mail/.test(s) && a.email == null) a.email = it.x;
        else if (/fra[çc]/.test(s) && a.fracao == null) a.fracao = it.x;
      });
      if (a.unidade != null && a.nome != null && a.tipo != null) return a;
    }
  }
  return null;
}

// Atribui um item de texto a coluna cuja ancora esta mais proxima no eixo X.
// Rejeita (retorna null) itens muito a esquerda da primeira coluna ou a direita
// da ultima: sao ruido fora da tabela (ex numero de pagina), nao dado de coluna.
// O limite e so nas bordas para nao descartar tokens longos de nome/endereco
// que comecam dentro da faixa das colunas.
function colDeX(x, a) {
  var xs = [];
  for (var kk in a) xs.push(a[kk]);
  var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  if (x < minX - MARGEM_COLUNA_W045A || x > maxX + MARGEM_COLUNA_W045A) return null;
  var best = null, bd = 1e9;
  for (var k in a) { var d = Math.abs(x - a[k]); if (d < bd) { bd = d; best = k; } }
  return best;
}

// Telefones do W045A: junta fragmentos (numero pode quebrar entre linhas),
// separa por ; e remove o prefixo de pais "+55 " quando presente, devolvendo so
// digitos validos. Nunca inventa numero.
function parseTelefonesW045A(frag) {
  var j = frag.join('');
  return j.split(';').map(function(t) {
    // Remove o prefixo de pais no inicio do numero, com ou sem espaco ("+55 " ou
    // "+5527..."). Ancorado no inicio para nao mexer num DDD 55 no meio.
    return t.replace(/^\s*\+?55\s*/, '').replace(/\D/g, '');
  }).filter(function(d) { return d.length >= 8 && d.length <= 11; });
}

// Endereco do W045A: acha a linha de localidade pelo padrao "- UF - CEP" (o CEP
// pode estar nela ou na linha seguinte). O que vem antes e rua e complemento.
// Degradacao graciosa: se nao casar o padrao, joga tudo no campo Endereco.
function parseEnderecoW045A(lines) {
  var o = { endereco: '', numero: '', complemento: '', bairro: '', cidade: '', estado: '', cep: '' };
  if (!lines.length) return o;
  var locIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (/\s-\s/.test(lines[i]) && /-\s*[A-Za-z]{2}\s*-?\s*(\d{5}-?\d{3}|\d{8})?\s*$/.test(lines[i])) locIdx = i;
  }
  if (locIdx >= 0) {
    var L = lines[locIdx];
    var cepM = L.match(/(\d{5}-?\d{3}|\d{8})\s*$/);
    if (cepM) { o.cep = cepM[1].replace(/\D/g, ''); L = L.replace(/\s*-?\s*(\d{5}-?\d{3}|\d{8})\s*$/, ''); }
    else if (lines[locIdx + 1]) { var cm = lines[locIdx + 1].match(/(\d{5}-?\d{3}|\d{8})/); if (cm) o.cep = cm[1].replace(/\D/g, ''); }
    L = L.replace(/\s*-\s*$/, '');
    var ufM = L.match(/^(.*?)\s*-\s*([A-Za-z]{2})\s*$/);
    if (ufM) {
      o.estado = ufM[2].toUpperCase();
      var bc = ufM[1].split(' - ');
      o.cidade = bc.length > 1 ? bc[bc.length - 1].trim() : '';
      o.bairro = (bc.length > 1 ? bc.slice(0, -1).join(' - ') : bc[0]).trim();
    } else { o.bairro = L.trim(); }
    var street = lines.slice(0, locIdx).join(' ').trim();
    var sp = street.split(' - ');
    o.endereco = sp[0].trim();
    if (sp.length > 1) o.complemento = sp.slice(1).join(' - ').trim();
  } else {
    o.endereco = lines.join(' ').trim();
    var cm2 = o.endereco.match(/(\d{5}-?\d{3}|\d{8})/);
    if (cm2) o.cep = cm2[1].replace(/\D/g, '');
  }
  return o;
}

// Detecta se uma linha pertence ao rodape da pagina (numero de pagina, bloco do
// condominio com "CEP." ou "Nº", ou o proprio nome do condominio). Usada para
// parar a leitura antes do rodape e nao poluir o ultimo contato.
function ehLinhaRodapeW045A(txt, condoNome) {
  var t = txt.toLowerCase().trim();
  // condoNome so conta quando a linha COMECA com o nome do condominio (bloco de
  // rodape), nao quando o nome aparece embutido num endereco de morador.
  return /^\d+\s+de\s+\d+$/.test(txt.trim()) || /cep\.\s*\d/.test(t) ||
    /\bn[º°o]\s*\d/i.test(txt) || (condoNome && t.indexOf(condoNome) === 0);
}

// Extrai a lista plana de contatos de um W045A posicional. Reconstroi as colunas
// pelas ancoras, faz forward fill da unidade, junta telefone/email/endereco que
// quebram em varias linhas e corta o rodape de cada pagina. Reusa limparDocumento,
// anexarObs e splitUnidadeNumeroBloco ja definidos para a familia A2.
function extrairContatosW045APdf(paginas, anchors, condoNome) {
  var contatos = [], seq = 0, ultimaUnidade = '', pessoa = null;
  function finalizar() {
    if (!pessoa) return;
    var tels = parseTelefonesW045A(pessoa.tel);
    var telefone = tels[0] || '', telExtras = tels.slice(1);
    var emails = pessoa.email.join('').split(/[;,]/).map(function(s) { return s.trim(); }).filter(Boolean);
    var email = emails[0] || '', emailExtras = emails.slice(1);
    var end = parseEnderecoW045A(pessoa.end);
    var doc = limparDocumento(pessoa.doc);
    var obs = '';
    if (telExtras.length) obs = anexarObs(obs, 'Telefones extras: ' + telExtras.join(', '));
    if (emailExtras.length) obs = anexarObs(obs, 'Emails extras: ' + emailExtras.join(', '));
    var sp = splitUnidadeNumeroBloco(pessoa.unidade);
    // Remove o complemento quando ele so repete a referencia da unidade
    if (end.complemento && (end.complemento === sp.numero + ' ' + sp.bloco || end.complemento === sp.numero)) end.complemento = '';
    var nomeCompleto = pessoa.nomeCont.length ? (pessoa.nome + ' ' + pessoa.nomeCont.join(' ')).trim() : pessoa.nome;
    seq++;
    contatos.push({
      id: seq, unidade: sp.numero, bloco: sp.bloco, nome: nomeCompleto, tipoOriginal: pessoa.tipo,
      papel: '', confianca: '', motivo: '', cpf: doc.cpf, cnpj: doc.cnpj, rg: '', dtNasc: '', genero: '',
      email: email, ddi: telefone ? '55' : '', telefone: telefone, tipoTel: '', cep: end.cep,
      endereco: end.endereco, numero: end.numero, complemento: end.complemento, bairro: end.bairro,
      cidade: end.cidade, estado: end.estado, fracao: pessoa.fracao || '', dtEntrada: '', dtSaida: '',
      recebeCobranca: '', obs: obs
    });
    pessoa = null;
  }
  paginas.forEach(function(pg) {
    var porY = {};
    pg.items.forEach(function(it) { var k = Math.round(it.y); (porY[k] = porY[k] || []).push(it); });
    var ys = Object.keys(porY).map(Number).sort(function(x, y) { return y - x; });
    var emRodape = false, viuPessoa = false;
    ys.forEach(function(y) {
      if (emRodape) return;
      var linhaItens = porY[y];
      var cel = {};
      linhaItens.forEach(function(it) { var c = colDeX(it.x, anchors); if (c) cel[c] = (cel[c] ? cel[c] + ' ' : '') + it.str; });
      var txtLinha = linhaItens.map(function(it) { return it.str; }).join(' ');
      // So corta no rodape depois que a primeira pessoa da pagina apareceu, para
      // nao confundir o titulo (que contem o nome do condominio) com rodape.
      if (viuPessoa && ehLinhaRodapeW045A(txtLinha, condoNome)) { emRodape = true; return; }
      var tipoCel = (cel.tipo || '').trim().toLowerCase();
      if (TIPOS_W045A.indexOf(tipoCel) !== -1) {
        viuPessoa = true;
        finalizar();
        if (cel.unidade && cel.unidade.trim()) ultimaUnidade = cel.unidade.trim();
        pessoa = { unidade: ultimaUnidade, nome: (cel.nome || '').trim(), tipo: (cel.tipo || '').trim(),
                   tel: [], email: [], end: [], nomeCont: [], doc: (cel.doc || '').trim(), fracao: (cel.fracao || '').trim(), lastY: y };
        if (cel.endereco) pessoa.end.push(cel.endereco.trim());
        if (cel.email) pessoa.email.push(cel.email.trim());
      } else if (pessoa && (pessoa.lastY - y) <= GAP_CONTINUACAO_W045A) {
        // Na coluna do nome, fragmento com digito e telefone; fragmento so de
        // texto e o nome que quebrou em outra linha (ex o qualificador "INQUILINO"
        // que continua abaixo do nome). Capturado para a deteccao textual de papel.
        if (cel.nome) {
          if (/\d/.test(cel.nome)) pessoa.tel.push(cel.nome.trim());
          else pessoa.nomeCont.push(cel.nome.trim());
        }
        if (cel.endereco) pessoa.end.push(cel.endereco.trim());
        if (cel.email) pessoa.email.push(cel.email.trim());
        pessoa.lastY = y;
      }
    });
    finalizar(); // fecha a ultima pessoa da pagina
  });
  return contatos;
}

// Extrai o nome do condominio do titulo da pagina 1 (remove o prefixo W045A e o
// sufixo "(NN)"), usado para reconhecer o bloco de rodape de cada pagina.
function condoNomeDoTitulo(paginas) {
  if (!paginas.length || !paginas[0].items.length) return '';
  // O titulo pode vir quebrado em varios itens no mesmo Y (ex "W045A" e o nome
  // em spans separados). Junta todos os itens da linha mais alta, em ordem de X.
  var topo = Math.max.apply(null, paginas[0].items.map(function(it) { return it.y; }));
  var tituloStr = paginas[0].items.filter(function(it) { return it.y === topo; })
    .sort(function(a, b) { return a.x - b.x; })
    .map(function(it) { return it.str; }).join(' ');
  return tituloStr.replace(/^W045A\s*/i, '').replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase();
}

// Registro extensivel de reconhecedores de PDF. Para suportar um layout novo de
// administradora, adicione aqui um objeto { nome, detectar, extrair } sem mexer
// no resto. O despachante tenta cada um na ordem e usa o primeiro que casar.
// Cada reconhecedor: preparar(paginas) devolve um contexto (ex ancoras) ou null
// se o layout nao bate; extrair(paginas, ctx) usa esse contexto. Calcular o
// contexto uma so vez evita refazer a deteccao na extracao.
var RECONHECEDORES_PDF = [
  {
    nome: 'W045A Contatos das unidades (Superlogica)',
    preparar: function(paginas) { return paginas.length ? acharAncorasW045A(paginas[0].items) : null; },
    extrair: function(paginas, anchors) { return extrairContatosW045APdf(paginas, anchors, condoNomeDoTitulo(paginas)); }
  }
];

// Oferta de fallback de IA com aviso explicito do custo. So dispara com o ok do
// usuario (confirm), nunca automatico.
function fallbackIaPdf(file, motivo) {
  if (confirm(motivo + ' Posso processar o documento pelo modo avançado, que é mais lento. Continuar?')) {
    processarDocNormalizar(file);
  }
}

// Despachante de PDF: tenta os reconhecedores por codigo; se nenhum casar (ou a
// extracao falhar/vir vazia), avisa e oferece o fallback de IA. Caso reconheca,
// abre direto a tela de revisao. Todo o caminho e protegido por try/catch para
// nunca deixar o operador sem diagnostico nem sem rota de recuperacao.
async function processarPdfUnidades(file) {
  toast('Lendo PDF por codigo...', 'info');
  var paginas;
  try {
    paginas = await extrairItensPdf(file);
  } catch (e) {
    fallbackIaPdf(file, 'Nao consegui abrir este PDF por codigo.');
    return;
  }
  for (var i = 0; i < RECONHECEDORES_PDF.length; i++) {
    var r = RECONHECEDORES_PDF[i];
    var ctx;
    try { ctx = r.preparar(paginas); } catch (_) { ctx = null; }
    if (!ctx) continue;
    var contatos;
    try {
      contatos = inferirPapeis(r.extrair(paginas, ctx));
    } catch (e2) {
      fallbackIaPdf(file, 'Reconheci o layout (' + r.nome + ') mas a leitura por codigo falhou.');
      return;
    }
    if (!contatos.length) {
      fallbackIaPdf(file, 'Reconheci o layout (' + r.nome + ') mas nao extrai nenhum contato.');
      return;
    }
    abrirRevisao(contatos, file.name);
    toast(contatos.length + ' contatos lidos por codigo (' + r.nome + '). Revise os papeis antes de importar.', 'ok');
    return;
  }
  fallbackIaPdf(file, 'Nao reconheci o layout deste PDF por codigo.');
}

// Converte uma linha de 26 colunas (saida do Normalizador IA) num contato, para
// que o resultado da IA tambem passe pela mesma tela de revisao de papel.
function linha26ParaContato(row, idx) {
  var g = function(i) { return row[i] == null ? '' : String(row[i]).trim(); };
  return {
    id: idx + 1,
    unidade: g(1), bloco: g(2), nome: g(5),
    tipoOriginal: g(0),
    papel: '', confianca: '', motivo: '',
    cpf: g(6).replace(/\D/g, ''), cnpj: g(7).replace(/\D/g, ''), rg: g(8),
    dtNasc: g(9), genero: g(10), email: g(11),
    ddi: g(12), telefone: g(13).replace(/\D/g, ''), tipoTel: g(14),
    cep: g(15).replace(/\D/g, ''), endereco: g(16), numero: g(17), complemento: g(18),
    bairro: g(19), cidade: g(20), estado: g(21), fracao: g(3),
    dtEntrada: g(22), dtSaida: g(23), recebeCobranca: g(24), obs: g(25)
  };
}

// ============================================================
// TELA DE REVISAO DE PAPEIS
// Recebe os contatos ja inferidos, mostra cada um com cor por confianca e um
// dropdown editavel de papel. Ao confirmar, emite linhas de 26 colunas e passa
// pelo processUnidadesDataUnificada (logica de envio ja testada).
// ============================================================
var REVISAO_PAPEL_OPCOES = [
  { v: 'proprietario', label: 'Proprietário' },
  { v: 'inquilino',    label: 'Inquilino' },
  { v: 'dependente',   label: 'Dependente' },
  { v: 'descartar',    label: 'Descartar' }
];

// Abre a tela de revisao com a lista plana de contatos ja classificada. O 3o
// parametro (linhasOrigem) alimenta o resumo fixo do funil "X linhas na
// origem -> Y unidades -> Z pessoas"; quando quem chama nao sabe o numero
// exato de linhas lidas (PDF, IA), usa a quantidade de contatos como proxy.
function abrirRevisao(contatos, sourceName, linhasOrigem) {
  _revisaoContatos = contatos;
  _revisaoSource = sourceName || '';
  _revisaoFiltro = 'todos';
  _revisaoLinhasOrigem = (typeof linhasOrigem === 'number') ? linhasOrigem : (contatos ? contatos.length : 0);
  renderRevisao();
  var card = document.getElementById('revisao-unidades');
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Abre a revisao a partir do resultado do Normalizador IA (familia B).
function abrirRevisaoFromNormalizado() {
  if (!_normalizarRows || !_normalizarRows.length) { toast('Nada para revisar', 'err'); return; }
  // Situação de cada linha da prévia (T06): falta obrigatório e "já existe no Superlógica"
  // entram na revisão como Descartar (dá para mudar lá); dúvida entra como Incerto.
  var estConf = typeof estadoConferenciaNormalizado === 'function' ? estadoConferenciaNormalizado() : 'ok';
  if (estConf === 'carregando') { toast('Aguarde terminar a conferência no Superlógica', 'warn'); return; }
  if (estConf !== 'ok' && !confirm(estConf === 'desatualizada'
      ? 'Você editou linhas depois da conferência: elas NÃO foram conferidas no Superlógica (podem duplicar unidades). Clique em Cancelar e depois em "Conferir de novo", ou OK para seguir assim.'
      : 'As duplicadas NÃO foram conferidas no Superlógica (sem condomínio escolhido ou a conferência falhou). Importar pode criar unidades repetidas. Continuar mesmo assim?')) return;
  var sit = typeof situacaoLinhasNormalizado === 'function' ? situacaoLinhasNormalizado() : [];
  var nErro = sit.filter(function(s) { return s.nivel === 'erro'; }).length;
  var nEx = sit.filter(function(s) { return s.existe && s.nivel !== 'erro'; }).length;
  if ((nErro || nEx) && !confirm(
    (nErro ? nErro + ' linha(s) sem campo obrigatório (tipo, unidade ou nome)' : '') +
    (nErro && nEx ? ' e ' : '') +
    (nEx ? nEx + ' linha(s) que já existem no Superlógica' : '') +
    ' vão para a revisão marcadas como Descartar. Você pode corrigir antes na prévia ou mudar o papel na revisão. Continuar?')) return;
  var contatos = inferirPapeis(_normalizarRows.map(linha26ParaContato));
  contatos.forEach(function(c) {
    var s = sit[c.id - 1];
    if (!s) return;
    if (s.nivel === 'erro') {
      c.papel = 'descartar'; c.confianca = 'incerta';
      c.motivo = 'Falta dado: ' + s.erros.join('; ');
    } else if (s.existe) {
      c.papel = 'descartar'; c.confianca = 'incerta';
      c.motivo = s.motivos.filter(function(t) { return /Superlógica/.test(t); }).join('; ') + '. Mude o papel só se tiver certeza.';
    } else if (s.nivel === 'duvida') {
      c.confianca = 'incerta';
      c.motivo = 'Conferir: ' + s.motivos.join('; ') + (c.motivo ? ' · ' + c.motivo : '');
    }
  });
  abrirRevisao(contatos, _normalizarSourceName || 'normalizado', _normalizarRows.length);
}

// Cor de borda por nivel de confianca: alta verde, media amarelo, incerta vermelho.
function corConfianca(conf) {
  if (conf === 'alta') return 'var(--success)';
  if (conf === 'incerta') return 'var(--danger)';
  return 'var(--warn,#e0a82e)';
}

// Desenha a tabela de revisao: resumo no topo (contagem por papel e quantos
// incertos) e uma linha por contato com borda colorida pela confianca e um
// dropdown editavel de papel. Todo dado externo passa por esc() antes do DOM.
function renderRevisao() {
  var table = document.getElementById('revisao-table');
  var resumo = document.getElementById('revisao-resumo');
  var funil = document.getElementById('revisao-funil');
  var esc = function(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var cont = _revisaoContatos || [];
  var nProp = 0, nInq = 0, nDep = 0, nDesc = 0, nIncerto = 0, nAlta = 0, nMedia = 0, nErro = 0;
  cont.forEach(function(c) {
    if (c.papel === 'proprietario') nProp++;
    else if (c.papel === 'inquilino') nInq++;
    else if (c.papel === 'dependente') nDep++;
    else if (c.papel === 'descartar') nDesc++;
    if (c.confianca === 'incerta') nIncerto++;
    else if (c.confianca === 'alta') nAlta++;
    else if (c.confianca === 'media') nMedia++;
    if (c._valido === false) nErro++;
  });
  var unidades = {};
  cont.forEach(function(c) { if (c.papel !== 'descartar') unidades[c.unidade + '|' + c.bloco] = 1; });
  var unidadesTotal = {};
  cont.forEach(function(c) { unidadesTotal[c.unidade + '|' + c.bloco] = 1; });

  // Linha de resumo fixa do funil (sempre visivel, nunca filtravel): mostra o
  // caminho completo dos dados, da linha crua da planilha ate a pessoa
  // identificada, pra deixar claro quando a contagem nao bate 1 pra 1.
  if (funil) {
    funil.innerHTML = _revisaoLinhasOrigem + ' linhas na origem &rarr; ' +
      Object.keys(unidadesTotal).length + ' unidades &rarr; ' + cont.length + ' pessoas';
  }

  // Resumo do topo sempre reflete a lista inteira, independente do filtro de status escolhido abaixo.
  resumo.innerHTML = Object.keys(unidades).length + ' unidades · ' + nProp + ' proprietários · ' +
    nInq + ' inquilinos · ' + nDep + ' dependentes · ' + nDesc + ' descartados' +
    (nIncerto ? ' · <b style="color:var(--danger)">' + nIncerto + ' incertos para decidir</b>' : '') +
    (nErro ? ' · <b style="color:var(--danger)">' + nErro + ' com erro, excluidos do envio</b>' : '');

  // Chips de filtro por status (confianca): selecao unica, contagem ao lado de cada rotulo.
  var chipsEl = document.getElementById('revisao-filtro-chips');
  if (chipsEl) {
    var chipsDef = [
      { v: 'todos', label: 'Todos (' + cont.length + ')' },
      { v: 'alta', label: 'Confirmado (' + nAlta + ')' },
      { v: 'media', label: 'Inferido (' + nMedia + ')' },
      { v: 'incerta', label: 'Incerto (' + nIncerto + ')' },
      { v: 'erro', label: 'Com erro (' + nErro + ')' }
    ];
    chipsEl.innerHTML = chipsDef.map(function(ch) {
      var ativo = ch.v === _revisaoFiltro ? ' active' : '';
      return '<div class="chip' + ativo + '" onclick="filtrarRevisao(\'' + ch.v + '\')">' + ch.label + '</div>';
    }).join('');
  }

  // Tabela exibe so a lista filtrada pelo status escolhido; o resumo acima nunca filtra.
  var contFiltrado = _revisaoFiltro === 'todos' ? cont
    : _revisaoFiltro === 'erro' ? cont.filter(function(c) { return c._valido === false; })
    : cont.filter(function(c) { return c.confianca === _revisaoFiltro; });

  var head = '<thead><tr>' +
    ['Unidade', 'Papel', 'Nome', 'Documento', 'Telefone', 'Email', 'Tipo no doc', 'Por quê']
      .map(function(h) { return '<th style="padding:6px 8px;background:var(--bg3);font-size:10px;font-family:var(--mono);text-transform:uppercase;color:var(--muted);position:sticky;top:0;border-bottom:1px solid var(--border2);white-space:nowrap;text-align:left">' + h + '</th>'; })
      .join('') + '</tr></thead>';

  var body = !contFiltrado.length
    ? '<tr><td colspan="8" style="padding:14px 8px;font-size:11px;font-family:var(--mono);color:var(--muted);text-align:center">Nenhum contato com este status</td></tr>'
    : contFiltrado.map(function(c) {
      var cor = corConfianca(c.confianca);
      var doc = c.cnpj ? (c.cnpj + ' (CNPJ)') : (c.cpf || '');
      var sel = '<select onchange="mudarPapelRevisao(' + c.id + ', this.value)" style="font-size:11px;font-family:var(--mono);padding:3px 4px;border-radius:5px;border:1px solid var(--border2);background:var(--bg3);color:var(--text)">' +
        REVISAO_PAPEL_OPCOES.map(function(o) {
          return '<option value="' + o.v + '"' + (o.v === c.papel ? ' selected' : '') + '>' + o.label + '</option>';
        }).join('') + '</select>';
      var td = function(v, extra) { return '<td style="padding:5px 8px;font-size:11px;font-family:var(--mono);border-bottom:1px solid var(--border);' + (extra || '') + '">' + v + '</td>'; };
      return '<tr style="border-left:3px solid ' + cor + '">' +
        td('<b>' + esc(c.unidade) + (c.bloco ? ' ' + esc(c.bloco) : '') + '</b>') +
        td(sel) +
        td(esc(c.nome), 'max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis') +
        td(esc(doc)) +
        td(esc(c.telefone)) +
        td(esc(c.email), 'max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis') +
        td(esc(c.tipoOriginal) || '<span style="color:var(--muted)">—</span>') +
        td('<span style="color:var(--muted)" title="' + esc(c.motivo) + '">' + esc(c.motivo) + '</span>', 'max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis') +
        '</tr>';
    }).join('');

  table.innerHTML = head + '<tbody>' + body + '</tbody>';
}

// Troca o filtro de status da tela de revisao e redesenha (chips de selecao unica).
function filtrarRevisao(valor) {
  _revisaoFiltro = valor;
  renderRevisao();
}

// Ajuste manual do papel: vira confianca alta (decidido pelo humano) e redesenha a tela.
function mudarPapelRevisao(id, papel) {
  if (!_revisaoContatos) return;
  var c = _revisaoContatos.filter(function(x) { return x.id === id; })[0];
  if (!c) return;
  c.papel = papel;
  c.confianca = 'alta';
  c.motivo = 'Ajustado manualmente';
  renderRevisao();
}

function descartarRevisao() {
  _revisaoContatos = null;
  _revisaoSource = '';
  _revisaoFiltro = 'todos';
  document.getElementById('revisao-unidades').style.display = 'none';
  toast('Revisão descartada', 'ok');
}

// Confirma a revisao: emite linhas de 26 colunas dos contatos mantidos, monta o
// modelo de import via processUnidadesDataUnificada e mostra a previa de import.
// Nada e enviado aqui; o envio continua no botao Enviar unidades. Exclui do
// envio tanto quem foi marcado Descartar quanto quem ficou invalido na
// validacao (_valido === false); a linha invalida continua visivel no chip
// "Com erro" da tela de revisao (decisao 3), nunca some em silencio.
function confirmarRevisao() {
  var cont = _revisaoContatos || [];
  var ativos = cont.filter(function(c) { return c.papel !== 'descartar' && c._valido !== false; });
  if (!ativos.length) { toast('Nada para importar: tudo descartado ou com erro', 'err'); return; }

  var rows = ativos.map(contatoParaLinha26);
  var processed = processUnidadesDataUnificada(NORMALIZAR_HEADERS, rows);

  var avisos = (processed.avisos || []).slice();
  // Alerta sobre proprietarios CNPJ: o cadastro do proprietario nao envia o documento da empresa
  var propsCnpj = ativos.filter(function(c) { return c.papel === 'proprietario' && c.cnpj && !c.cpf; }).length;
  if (propsCnpj) avisos.push(propsCnpj + ' proprietario(s) sao empresa (CNPJ); o documento da empresa nao vai no cadastro do proprietario');

  state.unidades.headers = NORMALIZAR_HEADERS;
  state.unidades.raw = rows;
  state.unidades.processed = processed;
  renderPreviewUnidades(processed, _revisaoSource || 'revisão');

  document.getElementById('revisao-unidades').style.display = 'none';
  if (avisos.length) toast(avisos.join(' | '), 'warn');
  toast(processed.length + ' unidades prontas. Confira a pré-visualização e clique em Enviar unidades.', 'ok');
  var prev = document.getElementById('preview-unidades');
  if (prev) prev.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function enviarUnidades() {
  if (!apiPronta()) { toast('Configure os tokens da API primeiro', 'err'); return; }
  // Proxy obrigatório para não tentar chamada CORS direta a api.superlogica.net
  if (!getProxy()) { toast('Configure o proxy nas Configuracoes', 'err'); return; }
  // Lê o condomínio ativo via getCondominioAtivo para garantir que id_superlogica (numérico)
  // seja usado como ID_CONDOMINIO_COND, nunca o UUID Supabase.
  const condAtivo = getCondominioAtivo();
  const condId = condAtivo ? (condAtivo.id_superlogica || condAtivo.id) : null;
  if (!condAtivo || !condAtivo.id_superlogica) {
    toast('Selecione um condomínio com ID Superlógica antes de enviar', 'err');
    return;
  }

  const processed = state.unidades.processed;
  if (!processed || !processed.length) { toast('Carregue uma planilha primeiro', 'err'); return; }

  state.unidades.importing = true;
  state.unidades.shouldStop = false;

  const progressWrap    = document.getElementById('uni-progress-wrap');
  const progressBar     = document.getElementById('uni-progress');
  const progressTexto   = document.getElementById('uni-progresso-texto');
  const logDiv          = document.getElementById('uni-log');
  const statusFinal     = document.getElementById('uni-status-final');
  const btnEnviar       = document.querySelector('[onclick="enviarUnidades()"]');
  const btnParar        = document.getElementById('btn-parar-uni');

  progressWrap.style.display = 'block';
  if (progressTexto) { progressTexto.style.display = 'block'; progressTexto.textContent = '0 de ' + processed.length + ' unidades importadas'; }
  logDiv.style.display = 'block';
  logDiv.innerHTML = '';
  statusFinal.style.display = 'none';
  if (btnEnviar) btnEnviar.disabled = true;
  if (btnParar) btnParar.style.display = 'inline-flex';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'padding:8px 0;color:var(--gs-blue);font-weight:600;border-bottom:1px solid var(--border);margin-bottom:6px;font-family:var(--mono);font-size:12px';
  hdr.textContent = '▶ Iniciando importação paralela de ' + processed.length + ' unidades (10 simultâneas)...';
  logDiv.appendChild(hdr);

  let postOk = 0, postFail = 0, putOk = 0, putFail = 0, done = 0;
  let inqOk = 0, inqFail = 0, depOk = 0, depFail = 0;
  const erros = [];
  const BATCH = 10; // 10 unidades simultâneas

  async function enviarUmaUnidade(u, idx, total) {
  const idxPad = String(idx).padStart(4, '0');
  const totalPad = String(total).padStart(4, '0');
  // Escape para dados de planilha que vão para addLog: previne XSS via innerHTML do log
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  if (state.unidades.shouldStop) throw new Error('parou');

  // PASSO 1 POST: cria unidade vazia. ID_TIPOCONTATO_TCON e FL_FORMADERECEBIMENTO_UNI obrigatorios no nivel raiz.
  const p1 = new URLSearchParams();
  p1.set('ID_CONDOMINIO_COND',        condId);
  p1.set('ST_UNIDADE_UNI',            u.ST_UNIDADE_UNI);
  p1.set('ST_BLOCO_UNI',              u.ST_BLOCO_UNI || '');
  p1.set('ID_TIPOCONTATO_TCON',       '3');
  p1.set('FL_FORMADERECEBIMENTO_UNI', '1');

  let d1;
  try {
    const r1 = await apiPost('/unidades/post', p1.toString());
    d1 = await r1.json();
  } catch (e) {
    addLog(logDiv, '[POST ' + idxPad + '/' + totalPad + '] FAIL ' + esc(u._unidadeRaw) + ' rede ' + esc(e.message), 'err');
    throw new Error('POST falhou: ' + e.message);
  }

  const item = Array.isArray(d1) ? d1[0] : d1;
  // Guard reforcado pre-PUT: rejeita array vazio, status 500, id_unidade_uni ausente, id_contato_con ausente
  if (!item || item.status === '500' || item.status === 500 || !item.id_unidade_uni || !item.id_contato_con) {
    const msg = item ? (item.msg || JSON.stringify(item).slice(0, 200)) : 'sem corpo';
    addLog(logDiv, '[POST ' + idxPad + '/' + totalPad + '] FAIL ' + esc(u._unidadeRaw) + ' ' + esc(msg), 'err');
    throw new Error('POST falhou: ' + msg);
  }

  const idUnidade = item.id_unidade_uni;
  const idContato = item.id_contato_con;
  addLog(logDiv, '[POST ' + idxPad + '/' + totalPad + '] OK ' + esc(u._unidadeRaw) + ' id_unidade=' + idUnidade + ' id_contato=' + idContato, 'ok');

  // PASSO 2 PUT: popula nome, CPF, RG, email, telefones e endereco do proprietario.
  const p2 = new URLSearchParams();
  p2.set('ID_CONDOMINIO_COND',              condId);
  p2.set('ID_UNIDADE_UNI',                  idUnidade);
  // Fracao ideal: campo da unidade (nivel raiz, fora de contatos[0]). So envia se houver valor.
  if (u.prop_fracao) p2.set('NM_FRACAO_UNI', u.prop_fracao);
  p2.set('contatos[0][ID_CONTATO_CON]',     idContato);
  p2.set('contatos[0][FL_PROPRIETARIO_CON]','1');
  if (u.prop_nome)     p2.set('contatos[0][ST_NOME_CON]',     u.prop_nome);
  if (u.prop_cpf)      p2.set('contatos[0][ST_CPF_CON]',      u.prop_cpf);
  if (u.prop_rg)       p2.set('contatos[0][ST_RG_CON]',       u.prop_rg);
  if (u.prop_email)    p2.set('contatos[0][ST_EMAIL_CON]',     u.prop_email);
  // Telefone: so digitos, sem formatacao
  const fmtTel = t => t ? t.replace(/\D/g, '') : '';
  const cel = fmtTel(u.prop_cel || u.prop_fone);
  const fix = u.prop_cel ? fmtTel(u.prop_fone) : '';
  if (cel) p2.set('contatos[0][ST_TELEFONE_CON]', cel);
  if (fix) p2.set('contatos[0][ST_TELEFONE_CON2]', fix);
  // Endereco do proprietario
  if (u.prop_cep)         p2.set('contatos[0][ST_CEP_CON]',         u.prop_cep);
  if (u.prop_endereco)    p2.set('contatos[0][ST_ENDERECO_CON]',    u.prop_endereco);
  if (u.prop_numero)      p2.set('contatos[0][ST_NUMERO_CON]',      u.prop_numero);
  if (u.prop_bairro)      p2.set('contatos[0][ST_BAIRRO_CON]',      u.prop_bairro);
  if (u.prop_complemento) p2.set('contatos[0][ST_COMPLEMENTO_CON]', u.prop_complemento);
  if (u.prop_cidade)      p2.set('contatos[0][ST_CIDADE_CON]',      u.prop_cidade);

  const urlPut = getProxy() + '/v2/condor/unidades/post';
  let r2;
  try {
    r2 = await fetch(urlPut, {
      method: 'PUT',
      headers: getHeaders(),
      body: p2.toString()
    });
  } catch (e) {
    addLog(logDiv, '[PUT  ' + idxPad + '/' + totalPad + '] FAIL ' + esc(u._unidadeRaw) + ' rede ' + esc(e.message), 'err');
    throw new Error('PUT falhou: ' + e.message);
  }

  if (!r2.ok) {
    const txt = await r2.text().catch(() => '');
    addLog(logDiv, '[PUT  ' + idxPad + '/' + totalPad + '] FAIL ' + esc(u._unidadeRaw) + ' HTTP ' + r2.status + ' ' + esc(txt.slice(0, 200)), 'err');
    throw new Error('PUT falhou: HTTP ' + r2.status);
  }

  let d2 = null;
  try { d2 = await r2.json(); } catch (_) {}
  // CAUSA RAIZ CORRIGIDA: API retorna array; sucesso e data[0].status === '200'
  const statusItem = Array.isArray(d2) ? (d2[0] && d2[0].status) : (d2 && d2.status);
  if (String(statusItem) !== '200' && statusItem !== 200) {
    const msgErr = (d2 ? JSON.stringify(d2) : '').slice(0, 200);
    addLog(logDiv, '[PUT  ' + idxPad + '/' + totalPad + '] FAIL ' + esc(u._unidadeRaw) + ' ' + esc(msgErr), 'err');
    throw new Error('PUT falhou: ' + msgErr);
  }

  addLog(logDiv, '[PUT  ' + idxPad + '/' + totalPad + '] OK ' + esc(u._unidadeRaw) + (u.prop_nome ? ' — ' + esc(u.prop_nome) : ''), 'ok');

  // PASSO 3: envia inquilinos e dependentes desta unidade sequencialmente.
  // Só executa se a planilha unificada tiver contatos_extras populados.
  let localInqOk = 0, localInqFail = 0, localDepOk = 0, localDepFail = 0;
  if (Array.isArray(u.contatos_extras) && u.contatos_extras.length > 0) {
    for (const contato of u.contatos_extras) {
      const res = await enviarContatoExtra(condId, idUnidade, contato, logDiv, idxPad + '/' + totalPad);
      const tipoLabel = contato.tipo === 'inquilino' ? 'INQ' : 'DEP';
      const nomeLabel = contato.nome ? ' ' + esc(contato.nome) : '';
      if (res.ok) {
        addLog(logDiv, '[' + tipoLabel + '  ' + idxPad + '/' + totalPad + '] OK ' + esc(u._unidadeRaw) + nomeLabel + ' ' + esc(res.msg), 'ok');
        if (contato.tipo === 'inquilino') localInqOk++; else localDepOk++;
      } else {
        addLog(logDiv, '[' + tipoLabel + '  ' + idxPad + '/' + totalPad + '] FAIL ' + esc(u._unidadeRaw) + nomeLabel + ' ' + esc(res.msg), 'err');
        if (contato.tipo === 'inquilino') localInqFail++; else localDepFail++;
      }
    }
    // Resumo por unidade para facilitar leitura do log
    addLog(logDiv, '[RES  ' + idxPad + '/' + totalPad + '] ' + esc(u._unidadeRaw) + ' inq ok ' + localInqOk + ' fail ' + localInqFail + ' dep ok ' + localDepOk + ' fail ' + localDepFail, 'info');
  }

  return { idUnidade, idContato, inqOk: localInqOk, inqFail: localInqFail, depOk: localDepOk, depFail: localDepFail };
  }


  // Processar em lotes paralelos
  let parou = false;
  for (let i = 0; i < processed.length; i += BATCH) {
    if (state.unidades.shouldStop) { parou = true; break; }

    const lote = processed.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      lote.map((u, k) => enviarUmaUnidade(u, i + k + 1, processed.length))
    );

    settled.forEach((s, k) => {
      const u = lote[k];
      // Sinal de stop precoce: nao conta como done nem como erro
      if (s.status === 'rejected' && s.reason && s.reason.message === 'parou') return;
      done++;
      if (s.status === 'fulfilled') {
        postOk++;
        putOk++;
        // Acumula contadores de inquilinos e dependentes retornados pela unidade
        if (s.value) {
          inqOk  += s.value.inqOk  || 0;
          inqFail += s.value.inqFail || 0;
          depOk  += s.value.depOk  || 0;
          depFail += s.value.depFail || 0;
        }
        return;
      }
      const msg = (s.reason && s.reason.message) ? s.reason.message : String(s.reason);
      if (msg.startsWith('POST falhou')) {
        postFail++;
        erros.push({ unidade: u._unidadeRaw, fase: 'POST', mensagem: msg });
      } else if (msg.startsWith('PUT falhou')) {
        postOk++;
        putFail++;
        erros.push({ unidade: u._unidadeRaw, fase: 'PUT', mensagem: msg });
      } else {
        postFail++;
        erros.push({ unidade: u._unidadeRaw, fase: 'desconhecida', mensagem: msg });
      }
    });

    // Atualizar barra e texto de progresso em tempo real
    const pct = Math.round((done / processed.length) * 100);
    progressBar.style.width = pct + '%';
    if (progressTexto) {
      progressTexto.textContent = 'POST ' + postOk + '/' + done + ' ok ' + postFail + ' fail · PUT ' + putOk + '/' + done + ' ok ' + putFail + ' fail · Inq ' + inqOk + ' ok ' + inqFail + ' fail · Dep ' + depOk + ' ok ' + depFail + ' fail · total ' + done + '/' + processed.length;
    }

    // Pausa minima entre lotes para nao sobrecarregar
    if (i + BATCH < processed.length && !state.unidades.shouldStop) {
      await sleep(100);
    }
  }

  // Finalizar
  state.unidades.importing = false;
  if (btnEnviar) btnEnviar.disabled = false;
  if (btnParar) btnParar.style.display = 'none';
  progressBar.style.width = '100%';
  if (progressTexto) progressTexto.textContent = 'POST ' + postOk + '/' + done + ' ok ' + postFail + ' fail · PUT ' + putOk + '/' + done + ' ok ' + putFail + ' fail · Inq ' + inqOk + ' ok ' + inqFail + ' fail · Dep ' + depOk + ' ok ' + depFail + ' fail · total ' + done + '/' + processed.length;

  const totalErr = postFail + putFail;
  const totalInqDep = inqOk + inqFail + depOk + depFail;

  // Status final permanente com contadores de Inq/Dep quando houver
  statusFinal.style.display = 'block';
  var inqDepResumo = totalInqDep > 0 ? (' Inq ok ' + inqOk + ' fail ' + inqFail + ', Dep ok ' + depOk + ' fail ' + depFail + '.') : '';
  if (parou) {
    statusFinal.className = 'uni-status warn';
    statusFinal.innerHTML = '<span>⏹</span><div><strong>Importação interrompida</strong><br>POST ok ' + postOk + ', POST fail ' + postFail + ', PUT ok ' + putOk + ', PUT fail ' + putFail + '.' + inqDepResumo + '</div>';
  } else if (totalErr === 0) {
    statusFinal.className = 'uni-status success';
    statusFinal.innerHTML = '<span>✓</span><div><strong>' + putOk + ' unidades importadas com sucesso!</strong><br>POST ok ' + postOk + ', PUT ok ' + putOk + '.' + inqDepResumo + ' Todos os dados foram enviados para o Superlógica.</div>';
  } else {
    statusFinal.className = 'uni-status error';
    statusFinal.innerHTML = '<span>⚠</span><div><strong>' + putOk + ' criadas, ' + totalErr + ' com erro</strong><br>POST ok ' + postOk + ', POST fail ' + postFail + ', PUT ok ' + putOk + ', PUT fail ' + putFail + '.' + inqDepResumo + ' Veja a tabela e o log para detalhes.</div>';
  }

  // Tabela de erros (DOM API, sem innerHTML em dado de planilha; preserva o padrao XSS-safe do pacote anterior)
  // So aparece se houver erros. Inserida logo apos o statusFinal.
  const wrapErros = statusFinal.parentNode.querySelector('.uni-erros-tabela');
  if (wrapErros) wrapErros.remove(); // limpa tabela anterior em caso de re-execucao
  if (erros.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'uni-erros-tabela';
    wrap.style.cssText = 'margin-top:12px;font-family:var(--mono);font-size:12px;max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:6px';
    const tbl = document.createElement('table');
    tbl.style.cssText = 'width:100%;border-collapse:collapse';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['Unidade', 'Fase', 'Mensagem'].forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      th.style.cssText = 'text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);background:var(--bg-card);position:sticky;top:0';
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    erros.forEach(e => {
      const tr = document.createElement('tr');
      [e.unidade || '', e.fase || '', e.mensagem || ''].forEach(c => {
        const td = document.createElement('td');
        td.textContent = String(c);
        td.style.cssText = 'padding:6px 10px;border-bottom:1px solid var(--border);vertical-align:top';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    statusFinal.parentNode.insertBefore(wrap, statusFinal.nextSibling);
  }

  state.stats.imports++;
  state.stats.records += putOk;
  state.stats.errors += totalErr;
  document.getElementById('stat-imports').textContent = state.stats.imports;
  document.getElementById('stat-records').textContent = state.stats.records;
  document.getElementById('stat-errors').textContent = state.stats.errors;
  addHistorico('Unidades: ' + putOk + ' criadas' + (totalErr ? ', ' + totalErr + ' erros' : ' ✓'));

  if (!parou) {
    if (totalErr === 0) toast(putOk + ' unidades criadas com sucesso! ✓', 'ok');
    else toast(putOk + ' criadas, ' + totalErr + ' com erro', 'warn');
  }
}
function pararImportacaoUnidades() {
  state.unidades.shouldStop = true;
  toast('Parando após a unidade atual...', 'warn');
}

// ============================================================
// BUILDERS E SENDER DE CONTATO EXTRA (Inquilino e Dependente)
// Bloco 2: funções que montam e enviam o payload POST para criar
// inquilinos e dependentes em uma unidade já existente no Superlógica.
// ============================================================

// Monta URLSearchParams completo para criação de um contato extra (inquilino ou dependente).
// O payload segue exatamente a estrutura validada em produção em 2026-04-30.
// Campos opcionais sem valor são filtrados por omitirVazios para manter o payload enxuto.
// Campos "vazio mas presente" (exigidos pela API mesmo sem valor) são inseridos diretamente
// no URLSearchParams após a filtragem, nunca passando por omitirVazios.
function buildPayloadContatoExtra(idUnidade, condId, dados, tipo) {
  // tipo: 'inquilino' significa tipoResp '7', 'dependente' significa tipoResp '4'
  var tipoResp = dados.tipoResp || (tipo === 'inquilino' ? '7' : '4');

  // Data de entrada: formato m/d/Y + " 00:00:00". Default hoje se Inquilino.
  var dtEntrada = dataBRtoUSComHora(dados.dtEntrada);
  if (!dtEntrada && tipo === 'inquilino') {
    var hj = new Date();
    dtEntrada = (hj.getMonth() + 1) + '/' + hj.getDate() + '/' + hj.getFullYear() + ' 00:00:00';
  }

  // Telefone: DDI e tipo somente quando há número, para evitar campos semi-preenchidos.
  var tel = dados.telefone ? String(dados.telefone).replace(/\D/g, '') : '';
  var ddi = tel ? (dados.ddi || '55') : '';
  var tipoTel = tel ? (dados.tipoTel || '2') : '';

  // Campos opcionais: construídos como objeto e filtrados por omitirVazios.
  // Campos com valor real chegam no URLSearchParams; campos sem valor são omitidos.
  var opcionais = omitirVazios({
    'contatos[0][FL_ENTREGACOBRANCA_RESP]': dados.recebeCobranca || '',
    'contatos[0][FL_SEXO_CON]':            dados.genero || '0',
    'contatos[0][TELEFONES][0][DDI]':      ddi,
    'contatos[0][TELEFONES][0][NUMERO]':   tel,
    'contatos[0][TELEFONES][0][TIPO_TELEFONE]': tipoTel,
    'contatos[0][ST_NOME_CON]':            dados.nome || '',
    'contatos[0][ST_EMAIL_CON]':           dados.email || '',
    'contatos[0][ST_BAIRRO_CON]':          dados.bairro || '',
    'contatos[0][ST_CEP_CON]':             dados.cep || '',
    'contatos[0][ST_CIDADE_CON]':          dados.cidade || '',
    'contatos[0][ST_COMPLEMENTO_CON]':     dados.complemento || '',
    'contatos[0][ST_CPF_CON]':             dados.cpf || '',
    'contatos[0][ST_ENDERECO_CON]':        dados.endereco || '',
    'contatos[0][ST_NUMERO_CON]':          dados.numero || '',
    'contatos[0][ST_ESTADO_CON]':          dados.estado || '',
    'contatos[0][ST_CGC_CON]':             dados.cnpj || '',
  });

  // Monta URLSearchParams a partir dos campos opcionais filtrados
  var p = new URLSearchParams(opcionais);

  // Campos obrigatórios raiz
  p.set('ID_UNIDADE_UNI', idUnidade);
  p.set('ID_CONDOMINIO_COND', condId);
  p.set('contatos[0][ID_UNIDADE_UNI]', idUnidade);
  p.set('contatos[0][ID_TIPORESP_TRES]', tipoResp);
  p.set('contatos[0][ID_LABEL_TRES]', tipoResp);
  p.set('contatos[0][ID_CODIGO_TFOR]', '1');
  p.set('contatos[0][ID_TIPOCONTATO_TCON]', '1');     // 1 = morador (nao proprietario)

  // Campos "vazio mas presente": a API exige a chave mesmo sem valor
  p.set('contatos[0][ID_CONTATO_CON]', '');           // vazio = criar novo
  p.set('contatos[0][ID_CONDOMINIO_COND]', '');       // vazio mas presente
  p.set('contatos[0][DT_ENTRADA_RES]', dtEntrada);
  p.set('contatos[0][DT_NASCIMENTO_CON]', dataBRtoUS(dados.dtNasc) || '');
  p.set('contatos[0][ST_TELEFONE_CON]', tel);         // vazio mas presente
  p.set('contatos[0][ST_FAX_CON]', '');               // vazio mas presente
  p.set('contatos[0][TELEFONES][0][ST_CODIGO_TDDI]', '');

  return p;
}

// Envia um contato extra (inquilino ou dependente) para uma unidade já criada.
// Usa fetch direto pois apiPost não aceita query string no endpoint.
// Retorna objeto { ok: bool, msg: string } para acumulação de contadores.
async function enviarContatoExtra(condId, idUnidade, contato, logDiv, contexto) {
  const proxy = getProxy();
  if (!proxy) {
    return { ok: false, msg: 'Proxy nao configurado' };
  }
  const url = proxy + '/v2/condor/unidades/post?ID_CONDOMINIO_COND=' + encodeURIComponent(condId);
  const payload = buildPayloadContatoExtra(idUnidade, condId, contato, contato.tipo);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: payload.toString()
    });
  } catch (e) {
    return { ok: false, msg: 'rede ' + e.message };
  }
  let dados = null;
  try { dados = await resp.json(); } catch (_) {}
  // API responde array; sucesso quando data[0].status === '200' (mesmo padrão do PUT)
  const statusItem = Array.isArray(dados) ? (dados[0] && dados[0].status) : (dados && dados.status);
  if (String(statusItem) === '200' || statusItem === 200) {
    const msgOk = (Array.isArray(dados) && dados[0] && dados[0].msg) ? dados[0].msg : 'ok';
    return { ok: true, msg: msgOk };
  }
  const msgErr = dados ? JSON.stringify(dados).slice(0, 200) : ('HTTP ' + (resp && resp.status));
  return { ok: false, msg: msgErr };
}

// Trocou de condomínio (T02): planilha, revisão e prévia eram do anterior. Descarta tudo.
// (A troca fica travada enquanto a importação roda: ver condTrocaBloqueada.)
window.addEventListener('condominioAtivo:trocou', function() {
  var u = state.unidades;
  var tinha = (u.raw && u.raw.length) || (u.processed && u.processed.length) || _revisaoContatos
    || (typeof _normalizarRows !== 'undefined' && _normalizarRows);
  u.raw = []; u.headers = []; u.processed = []; u.shouldStop = false;
  _revisaoContatos = null; _revisaoSource = ''; _revisaoFiltro = 'todos';
  var ids = { 'preview-unidades': 'none', 'revisao-unidades': 'none', 'normalizar-preview': 'none',
              'uni-log': 'none', 'uni-status-final': 'none', 'uni-progress-wrap': 'none', 'uni-progresso-texto': 'none' };
  Object.keys(ids).forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = ids[id]; });
  ['unidades-table', 'revisao-table', 'normalizar-table', 'uni-log'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.innerHTML = '';
  });
  if (typeof _normalizarRows !== 'undefined') { _normalizarRows = null; _normalizarSourceName = ''; }
  var st = document.getElementById('normalizar-status');
  if (st) { st.textContent = ''; st.style.color = ''; }
  if (tinha) toast('Unidades carregadas descartadas: o condomínio mudou.', 'info');
});
