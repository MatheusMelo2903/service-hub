// ============================================================
// PROCESSAR DOCUMENTO (aba Unidades): documento qualquer vira planilha de 26 colunas
// do Superlógica. Aceita PDF (com texto ou escaneado), planilha, Word, texto e imagem.
// O navegador só separa o conteúdo em partes; o processamento é feito no servidor.
// ============================================================

const NORMALIZAR_MAX_BYTES = 8 * 1024 * 1024;        // planilha, docx, texto
const NORMALIZAR_MAX_BYTES_BINARIO = 7 * 1024 * 1024; // PDF e imagem viram base64 (limite de 10 MB do servidor)
const NORMALIZAR_PARTE_MAX_CHARS = 8000;   // cada parte de texto enviada à IA
const NORMALIZAR_PARTE_MAX_LINHAS = 60;
const NORMALIZAR_PDF_TEXTO_DIRETO = 12000; // PDF com texto maior que isso vai em partes de texto
const NORMALIZAR_PARALELO = 4;

// Cabeçalhos exatos das 26 colunas (formato unificado Superlógica)
const NORMALIZAR_HEADERS = ['Tipo','Unidade','Bloco','Fração','Metragem','Nome','CPF','CNPJ','RG','Data Nascimento','Gênero','Email','DDI','Telefone','Tipo Telefone','CEP','Endereço','Número','Complemento','Bairro','Cidade','Estado','Data Entrada','Data Saída','Recebe Cobrança','Observação'];

// Chaves do resultado, na ordem das 26 colunas (o servidor devolve só as que têm valor).
const NORMALIZAR_CHAVES = ['tipo','unidade','bloco','fracao','metragem','nome','cpf','cnpj','rg','nascimento','genero','email','ddi','telefone','tipo_telefone','cep','endereco','numero','complemento','bairro','cidade','estado','entrada','saida','recebe_cobranca','observacao'];


let _normalizarRows = null;       // linhas de 26 colunas (editáveis na prévia)
let _normalizarMeta = [];         // por linha: { duvidas: [motivos da IA], conf: resultado da conferência }
let _normalizarSourceName = '';
let _normalizarAvisos = [];       // avisos gerais (parte cortada, conferência indisponível...)
let _normalizarConfInfo = null;   // { idSuperlogica, nome, total, truncado } ou { erro }
let _normalizarFiltro = 'todas';
let _normalizarGeracao = 0;       // descarta resposta de processamento antigo

async function anexarDocNormalizar(event) {
  const file = (event && event.target && event.target.files && event.target.files[0]) || null;
  if (!file) return;
  await processarDocNormalizar(file);
  event.target.value = '';
}

function normalizarDragOver(e) {
  e.preventDefault();
  e.currentTarget.style.borderColor = 'var(--gs-blue)';
  e.currentTarget.style.background = 'var(--gs-blue-light)';
}
function normalizarDragLeave(e) {
  e.currentTarget.style.borderColor = '';
  e.currentTarget.style.background = 'var(--bg3)';
}
async function normalizarDrop(e) {
  e.preventDefault();
  normalizarDragLeave(e);
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  await processarDocNormalizar(file);
}

function _normEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _normSemAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Descobre o tipo do arquivo pela extensão e pelo MIME.
function tipoArquivoNormalizar(file) {
  const nome = String(file.name || '').toLowerCase();
  const mime = String(file.type || '').toLowerCase();
  if (mime === 'application/pdf' || /\.pdf$/.test(nome)) return 'pdf';
  if (/\.(xlsx|xlsm|xls|ods)$/.test(nome)) return 'planilha';
  if (/\.docx$/.test(nome)) return 'docx';
  if (/\.doc$/.test(nome)) return 'doc';
  if (/\.(csv|txt|tsv)$/.test(nome) || mime === 'text/plain' || mime === 'text/csv') return 'texto';
  if (/^image\/(png|jpeg|webp|gif)$/.test(mime) || /\.(png|jpe?g|webp|gif)$/.test(nome)) return 'imagem';
  if (/\.(heic|heif)$/.test(nome) || /heic|heif/.test(mime)) return 'heic';
  return '';
}

// ---------- Word (.docx): é um zip; lê word/document.xml sem biblioteca externa ----------
async function _zipLerArquivo(buf, alvo) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Arquivo Word inválido ou corrompido.');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const metodo = dv.getUint16(p + 10, true);
    const tamComp = dv.getUint32(p + 20, true);
    const lenNome = dv.getUint16(p + 28, true);
    const lenExtra = dv.getUint16(p + 30, true);
    const lenCom = dv.getUint16(p + 32, true);
    const offLocal = dv.getUint32(p + 42, true);
    const nome = dec.decode(new Uint8Array(buf, p + 46, lenNome));
    if (nome === alvo) {
      const ini = offLocal + 30 + dv.getUint16(offLocal + 26, true) + dv.getUint16(offLocal + 28, true);
      const dados = new Uint8Array(buf, ini, tamComp);
      if (metodo === 0) return dec.decode(dados);
      if (metodo !== 8) throw new Error('Compressão do Word não suportada.');
      if (typeof DecompressionStream === 'undefined') throw new Error('Este navegador não abre Word aqui. Salve o arquivo como PDF ou use o Chrome atualizado.');
      const ds = new DecompressionStream('deflate-raw');
      const txt = await new Response(new Blob([dados]).stream().pipeThrough(ds)).arrayBuffer();
      return dec.decode(txt);
    }
    p += 46 + lenNome + lenExtra + lenCom;
  }
  return null;
}

// Texto do Word mantendo parágrafos e tabelas (células separadas por " | ").
async function lerTextoDocx(file) {
  const xml = await _zipLerArquivo(await file.arrayBuffer(), 'word/document.xml');
  if (!xml) throw new Error('Não achei o conteúdo do Word. Salve como .docx de novo ou como PDF.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Não consegui ler o conteúdo do Word.');
  const textoDe = (el) => {
    let s = '';
    const andar = (n) => {
      for (const f of Array.from(n.childNodes)) {
        if (f.nodeType !== 1) continue;
        const ln = f.localName;
        if (ln === 't') s += f.textContent;
        else if (ln === 'tab') s += ' ';
        else if (ln === 'br' || ln === 'cr') s += ' ';
        else if (ln === 'p') { andar(f); s += ' '; } // vários parágrafos na mesma célula
        else andar(f);
      }
    };
    andar(el);
    return s.replace(/\s+/g, ' ').trim();
  };
  const linhas = [];
  const percorrer = (n) => {
    for (const f of Array.from(n.childNodes)) {
      if (f.nodeType !== 1) continue;
      if (f.localName === 'p') { const t = textoDe(f); if (t) linhas.push(t); }
      else if (f.localName === 'tbl') {
        for (const tr of Array.from(f.childNodes)) {
          if (tr.nodeType !== 1 || tr.localName !== 'tr') continue;
          const cels = Array.from(tr.childNodes).filter((c) => c.nodeType === 1 && c.localName === 'tc').map(textoDe);
          if (cels.some(Boolean)) linhas.push(cels.join(' | '));
        }
      } else percorrer(f);
    }
  };
  const body = doc.getElementsByTagNameNS('*', 'body')[0] || doc.documentElement;
  percorrer(body);
  return linhas.join('\n');
}

// Texto do PDF por página, com quebra de linha onde o PDF tem quebra (tabelas ficam legíveis).
async function lerPaginasPdfTexto(buf) {
  const pdfjsLib = await carregarPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const paginas = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    let s = '';
    c.items.forEach((it) => { s += it.str + (it.hasEOL ? '\n' : ' '); });
    paginas.push(s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim());
  }
  return { numPaginas: pdf.numPages, paginas };
}

// Quebra linhas de texto em partes que a IA devolve inteiras. O cabeçalho (se houver)
// vai repetido em cada parte para a IA saber o que é cada coluna.
function partesDeLinhas(linhas, cabecalho) {
  const partes = [];
  let atual = [], tam = 0;
  linhas.forEach((l) => {
    if (atual.length && (atual.length >= NORMALIZAR_PARTE_MAX_LINHAS || tam + l.length > NORMALIZAR_PARTE_MAX_CHARS)) {
      partes.push(atual); atual = []; tam = 0;
    }
    atual.push(l); tam += l.length + 1;
  });
  if (atual.length) partes.push(atual);
  return partes.map((p) => (cabecalho ? [cabecalho].concat(p) : p).join('\n'));
}

// Separa o documento em partes: { partes: [ {parte} ou {arquivo} ], avisos: [...] }.
async function montarPartesNormalizar(file, tipo) {
  const avisos = [];
  // Texto grande vai em partes. Da parte 2 em diante vai junto o começo do documento
  // (títulos e cabeçalho da tabela) para saber o que é cada coluna.
  const textoEmPartes = (rotulo, linhas) => {
    const blocos = partesDeLinhas(linhas, '');
    const contexto = linhas.slice(0, 6).join('\n').slice(0, 1500);
    return blocos.map((t, i) => ({ parte: { rotulo, texto: t, contexto, indice: i, total: blocos.length } }));
  };

  const mb = (file.size / 1024 / 1024).toFixed(1);
  const cabeBinario = () => file.size <= NORMALIZAR_MAX_BYTES_BINARIO;
  const limiteBinario = () => {
    if (!cabeBinario()) throw new Error('Arquivo muito grande (' + mb + ' MB). PDF escaneado e imagem são processados inteiros: o limite é 7 MB. Divida o arquivo ou reduza a resolução.');
  };
  if (tipo === 'pdf' ? file.size > 3 * NORMALIZAR_MAX_BYTES : file.size > NORMALIZAR_MAX_BYTES) {
    throw new Error('Arquivo muito grande (' + mb + ' MB). Limite ' + (tipo === 'pdf' ? '24' : '8') + ' MB.');
  }
  const documentoInteiro = async () => [{ arquivo: { mime: 'application/pdf', base64: await fileToBase64(file) } }];

  if (tipo === 'imagem') {
    limiteBinario();
    const mt = file.type || (/\.png$/i.test(file.name) ? 'image/png' : /\.webp$/i.test(file.name) ? 'image/webp' : /\.gif$/i.test(file.name) ? 'image/gif' : 'image/jpeg');
    return { partes: [{ arquivo: { mime: mt, base64: await fileToBase64(file) } }], avisos };
  }
  if (tipo === 'pdf') {
    // Todas as páginas com texto: vai como texto (em partes se for grande; a resposta não corta).
    // Alguma página escaneada (quase sem texto): vai inteiro como documento (a IA lê a imagem).
    let info = null;
    try { info = await lerPaginasPdfTexto(await file.arrayBuffer()); } catch (_) { info = null; }
    const totalTexto = info ? info.paginas.reduce((s, p) => s + p.length, 0) : 0;
    const escaneadas = info ? info.paginas.map((p, i) => (p.length < 50 ? i + 1 : 0)).filter(Boolean) : [];
    const linhasTexto = () => info.paginas.join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
    if (info && totalTexto > 0 && !escaneadas.length && (totalTexto > NORMALIZAR_PDF_TEXTO_DIRETO || !cabeBinario())) {
      return { partes: textoEmPartes('Documento PDF (texto extraido)', linhasTexto()), avisos };
    }
    if (info && info.numPaginas > 100) throw new Error('PDF escaneado com mais de 100 páginas. Divida em partes menores.');
    if (!cabeBinario() && info && totalTexto > 0) {
      avisos.push('O PDF tem página(s) sem texto (escaneada): ' + escaneadas.join(', ') + '. Como o arquivo passa de 7 MB, essas páginas NÃO foram lidas. Divida o PDF para lê-las.');
      return { partes: textoEmPartes('Documento PDF (texto extraido)', linhasTexto()), avisos };
    }
    limiteBinario();
    return { partes: await documentoInteiro(), avisos };
  }
  if (tipo === 'planilha') {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const partes = [];
    wb.SheetNames.forEach((nomeAba) => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[nomeAba], { FS: ';', blankrows: false });
      const linhas = csv.split(/\r?\n/).filter((l) => l.replace(/;/g, '').trim());
      if (!linhas.length) return;
      const rot = 'Planilha original' + (wb.SheetNames.length > 1 ? ', aba "' + nomeAba + '"' : '') + ' (CSV bruto fora do padrao)';
      textoEmPartes(rot, linhas).forEach((p) => partes.push(p));
    });
    if (!partes.length) throw new Error('A planilha está vazia.');
    return { partes, avisos };
  }
  if (tipo === 'docx' || tipo === 'texto') {
    const texto = tipo === 'docx' ? await lerTextoDocx(file) : await file.text();
    const linhas = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!linhas.length) throw new Error('O documento não tem texto.');
    return { partes: textoEmPartes(tipo === 'docx' ? 'Documento Word (texto extraido; celulas de tabela separadas por |)' : 'Documento original', linhas), avisos };
  }
  if (tipo === 'doc') throw new Error('Word antigo (.doc) não é lido aqui. Abra no Word e salve como .docx ou PDF.');
  if (tipo === 'heic') throw new Error('Foto em HEIC não é lida aqui. Exporte como JPG ou PNG.');
  throw new Error('Formato não suportado. Use PDF, Word (.docx), planilha (.xlsx, .xls, .ods, .csv), texto ou imagem (JPG, PNG, WEBP).');
}

// Resultado do servidor (uma pessoa por objeto) vira linhas de 26 colunas + dúvidas.
function linhasDeItens(lista) {
  const itens = [];
  (Array.isArray(lista) ? lista : []).forEach((o) => {
    if (!o || typeof o !== 'object') return;
    const row = NORMALIZAR_CHAVES.map((k) => (o[k] == null ? '' : String(o[k]).replace(/\s+/g, ' ').trim()));
    const duvidas = (Array.isArray(o.duvidas) ? o.duvidas : []).map((d) => String(d).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8);
    // Linha só com dúvida (pessoa ilegível) fica: aparece como "falta dado" na prévia.
    if (!row.some(Boolean) && !duvidas.length) return;
    itens.push({ row, duvidas });
  });
  return itens;
}

// Um pedido ao servidor por parte.
async function chamarIaNormalizar(parte) {
  const resp = await apiAuthFetch('/api/processar/unidades', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parte)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 413) throw new Error('Arquivo grande demais para enviar. Divida em partes menores.');
    throw new Error(data.detalhe || ('Não foi possível processar (' + resp.status + ').'));
  }
  return { itens: linhasDeItens(data.itens), invalidas: data.invalidas || 0, cortado: !!data.cortado };
}

// Roda as partes com no máximo NORMALIZAR_PARALELO ao mesmo tempo, mantendo a ordem.
async function rodarPartesNormalizar(partes, aoAvancar) {
  const res = new Array(partes.length);
  let prox = 0, feitas = 0;
  async function trabalhador() {
    while (prox < partes.length) {
      const i = prox++;
      try { res[i] = await chamarIaNormalizar(partes[i]); }
      catch (e) { res[i] = { erro: e.message || String(e) }; }
      feitas++;
      if (aoAvancar) aoAvancar(feitas, partes.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(NORMALIZAR_PARALELO, partes.length) }, trabalhador));
  return res;
}

// Tira as marcas [duvida: ...] da Observação e guarda à parte (não vão para o Superlógica).
function separarDuvidasIA(row) {
  const duvidas = [];
  row[25] = String(row[25] || '').replace(/\[\s*d[uú]vida\s*:\s*([^\]]*)\]/gi, (_, m) => { if (m.trim()) duvidas.push(m.trim()); return ''; })
    .replace(/\s+/g, ' ').trim();
  return duvidas;
}

// ---------- Conferência das linhas (sem IA, só regras) ----------
function _cpfValido(c) {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === +c[9] && dv(10) === +c[10];
}
function _cnpjValido(c) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (n) => { const p = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2]; let s = 0; for (let i = 0; i < n; i++) s += +c[i] * p[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === +c[12] && dv(13) === +c[13];
}
function _dataValida(v) {
  const m = String(v).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return false;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return d.getFullYear() === +m[3] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[1] && +m[3] >= 1900;
}
const _UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

// Recalcula a situação de todas as linhas: erro (falta obrigatório), dúvida, já existe.
function validarNormalizado() {
  const rows = _normalizarRows || [];
  const chaveUni = (r) => _normSemAcento(r[1]).toLowerCase().replace(/\s+/g, '') + '|' + _normSemAcento(r[2]).toLowerCase().replace(/\s+/g, '');
  const grupos = {};
  rows.forEach((r, i) => { const k = chaveUni(r); (grupos[k] = grupos[k] || []).push(i); });
  const vistos = {};
  rows.forEach((r, i) => {
    const m = _normalizarMeta[i] || (_normalizarMeta[i] = { duvidas: [], conf: null });
    const erros = [], avisos = [];
    const tipo = _normSemAcento(r[0]).toLowerCase();
    if (!r[0]) erros.push('falta o tipo (Proprietário, Inquilino ou Dependente)');
    else if (!/^(proprietario|inquilino|dependente)$/.test(tipo)) erros.push('tipo "' + r[0] + '" não é Proprietário, Inquilino nem Dependente');
    if (!r[1]) erros.push('falta a unidade');
    if (!r[5]) erros.push('falta o nome');
    const cpf = String(r[6]).replace(/\D/g, ''), cnpj = String(r[7]).replace(/\D/g, '');
    if (r[6] && !_cpfValido(cpf)) avisos.push('CPF inválido');
    if (r[7] && !_cnpjValido(cnpj)) avisos.push('CNPJ inválido');
    if (r[11] && !/^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/.test(r[11])) avisos.push('email com formato estranho');
    const tel = String(r[13]).replace(/\D/g, '');
    if (r[13] && !(tel.length === 10 || tel.length === 11)) avisos.push('telefone sem DDD ou com dígitos a mais');
    if (r[12] && !/^\d{1,3}$/.test(r[12])) avisos.push('DDI estranho');
    [[9, 'data de nascimento'], [22, 'data de entrada'], [23, 'data de saída']].forEach(([c, n]) => { if (r[c] && !_dataValida(r[c])) avisos.push(n + ' inválida'); });
    if (r[15] && String(r[15]).replace(/\D/g, '').length !== 8) avisos.push('CEP inválido');
    if (r[21] && _UFS.indexOf(String(r[21]).toUpperCase()) === -1) avisos.push('estado não é uma sigla válida');
    if (r[1]) {
      const g = grupos[chaveUni(r)] || [];
      const props = g.filter((j) => /^proprietario$/.test(_normSemAcento(rows[j][0]).toLowerCase())).length;
      if (!props) avisos.push('unidade sem proprietário no documento');
      else if (props > 1 && tipo === 'proprietario') avisos.push('unidade com mais de um proprietário');
    }
    const kp = chaveUni(r) + '|' + (cpf || cnpj || _normSemAcento(r[5]).toLowerCase().replace(/\s+/g, ' '));
    if (r[5] && vistos[kp] !== undefined) avisos.push('pessoa repetida (igual à linha ' + (vistos[kp] + 1) + ')');
    else vistos[kp] = i;
    // "Já existe" = a unidade já está no Superlógica (importar criaria outra igual).
    // CPF que já está em OUTRA unidade pode ser o mesmo dono de duas unidades: só avisa.
    m.existe = !!(m.conf && m.conf.unidade_existe);
    if (m.conf && m.conf.pessoa_existe && !m.conf.unidade_existe) avisos.push('CPF/CNPJ já cadastrado na unidade ' + m.conf.pessoa_onde + ' do Superlógica; confira se é o mesmo dono');
    m.erros = erros;
    m.avisos = avisos;
    m.nivel = erros.length ? 'erro' : (m.duvidas.length || avisos.length) ? 'duvida' : 'ok';
  });
}

function motivosLinhaNormalizada(m) {
  const out = [];
  (m.erros || []).forEach((t) => out.push(t));
  (m.duvidas || []).forEach((t) => out.push('Dúvida: ' + t));
  (m.avisos || []).forEach((t) => out.push(t));
  if (m.conf && m.conf.unidade_existe) {
    out.push('unidade já existe no Superlógica (' + m.conf.unidade_rotulo + '); importar criaria outra igual');
    if (m.conf.pessoa_existe) out.push(m.conf.pessoa_por === 'cpf' ? 'CPF/CNPJ já cadastrado no Superlógica (unidade ' + m.conf.pessoa_onde + ')' : 'pessoa já cadastrada nesta unidade no Superlógica');
  }
  return out;
}

async function processarDocNormalizar(file) {
  const status = document.getElementById('normalizar-status');
  const progressWrap = document.getElementById('normalizar-progress-wrap');
  const progressBar = document.getElementById('normalizar-progress-bar');
  const geracao = ++_normalizarGeracao;
  const tipo = tipoArquivoNormalizar(file);

  status.textContent = 'Lendo ' + file.name + '...';
  status.style.color = 'var(--gs-blue)';
  progressWrap.style.display = 'block';
  progressBar.style.width = '10%';

  try {
    const montado = await montarPartesNormalizar(file, tipo);
    const partes = montado.partes;
    if (geracao !== _normalizarGeracao) return;
    progressBar.style.width = '25%';
    status.textContent = partes.length > 1 ? 'Processando o documento (' + partes.length + ' partes)...' : 'Processando o documento...';
    const res = await rodarPartesNormalizar(partes, (f, t) => {
      if (geracao !== _normalizarGeracao) return;
      progressBar.style.width = (25 + Math.round(60 * f / t)) + '%';
      if (t > 1) status.textContent = 'Processando: ' + f + ' de ' + t + ' partes prontas...';
    });
    if (geracao !== _normalizarGeracao) return;

    const avisos = montado.avisos.slice();
    const itens = [];
    res.forEach((r, i) => {
      const rot = partes.length > 1 ? 'Parte ' + (i + 1) + ' de ' + partes.length : 'O documento';
      if (r.erro) { avisos.push(rot + ' falhou (' + r.erro + '). As linhas dela não estão na prévia; tente de novo.'); return; }
      if (r.cortado) avisos.push(rot + ' era grande demais para uma resposta: as últimas pessoas podem ter ficado de fora. Confira o fim da lista ou divida o arquivo.');
      if (r.invalidas) avisos.push(rot + ': ' + r.invalidas + ' linha(s) do resultado vieram ilegíveis e ficaram de fora.');
      r.itens.forEach((x) => itens.push(x));
    });
    if (!itens.length) throw new Error(avisos[0] || 'Não foram encontradas unidades nem pessoas no documento.');
    const rows = itens.map((x) => x.row);

    _normalizarSourceName = file.name;
    _normalizarRows = rows;
    // Dúvidas da IA vêm à parte; marca [duvida: ...] na observação também conta.
    _normalizarMeta = itens.map((x) => ({ duvidas: x.duvidas.concat(separarDuvidasIA(x.row)), conf: null }));
    _normalizarAvisos = avisos;
    _normalizarConfInfo = null;
    _normalizarFiltro = 'todas';
    validarNormalizado();
    renderPreviewNormalizado();
    progressBar.style.width = '100%';
    status.textContent = '✓ ' + rows.length + ' linhas geradas. Revise abaixo.';
    status.style.color = avisos.length ? 'var(--warn,#e0a82e)' : 'var(--success)';
    toast('Normalizado: ' + rows.length + ' linhas' + (avisos.length ? ' (com avisos)' : ''), avisos.length ? 'warn' : 'ok');
    setTimeout(() => { progressWrap.style.display = 'none'; }, 1500);
    conferirNormalizadoSuperlogica();
  } catch (e) {
    if (geracao !== _normalizarGeracao) return;
    status.textContent = '✕ ' + (e.message || 'Falha ao normalizar');
    status.style.color = 'var(--danger)';
    progressWrap.style.display = 'none';
    toast('Falha ao normalizar', 'err');
  }
}

// Cruza a prévia com as unidades do condomínio ativo no Superlógica.
async function conferirNormalizadoSuperlogica(fresco) {
  if (!_normalizarRows || !_normalizarRows.length) return;
  const cond = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
  if (!cond || !cond.id_superlogica) {
    _normalizarConfInfo = { erro: 'Escolha o condomínio (com código do Superlógica) para conferir se as unidades já existem.' };
    renderPreviewNormalizado();
    return;
  }
  const idSL = String(cond.id_superlogica);
  const rowsRef = _normalizarRows;
  _normalizarConfInfo = { carregando: true, idSuperlogica: idSL, nome: cond.nome || '' };
  renderPreviewNormalizado();
  try {
    const linhas = rowsRef.map((r) => ({ unidade: r[1], bloco: r[2], nome: r[5], cpf: r[6], cnpj: r[7] }));
    const chaveConf = (r) => [r[1], r[2], r[5], r[6], r[7]].join('\u0001');
    const chavesEnviadas = rowsRef.map(chaveConf);
    const resp = await apiAuthFetch('/api/condominio/' + encodeURIComponent(idSL) + '/unidades/conferir' + (fresco ? '?fresco=1' : ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linhas })
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.detalhe || ('erro ' + resp.status));
    // A prévia mudou (linha removida, outro arquivo ou outro condomínio) enquanto conferia: ignora.
    if (rowsRef !== _normalizarRows) {
      if (_normalizarRows && _normalizarConfInfo && _normalizarConfInfo.carregando) {
        _normalizarConfInfo = { erro: 'A prévia mudou durante a conferência. Clique em "Conferir de novo".' };
        renderPreviewNormalizado();
      }
      return;
    }
    const atual = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
    if (!atual || String(atual.id_superlogica) !== idSL) return;
    // Linha editada enquanto conferia: o resultado é dos dados antigos; fica desatualizada.
    (j.resultado || []).forEach((c, i) => {
      const m = _normalizarMeta[i];
      if (!m || !_normalizarRows[i]) return;
      if (chaveConf(_normalizarRows[i]) === chavesEnviadas[i]) { m.conf = c; m.confDesatualizada = false; }
      else { m.conf = null; m.confDesatualizada = true; }
    });
    _normalizarConfInfo = { idSuperlogica: idSL, nome: cond.nome || '', total: j.total_existentes || 0, truncado: !!j.truncado, linhasConferidas: linhas.length };
  } catch (e) {
    if (rowsRef !== _normalizarRows) return;
    _normalizarConfInfo = { erro: 'Não consegui conferir no Superlógica se as unidades já existem (' + (e.message || e) + '). Use "Conferir de novo".' };
  }
  validarNormalizado();
  renderPreviewNormalizado();
}

const _NORM_COR = { erro: 'var(--danger)', duvida: 'var(--warn,#e0a82e)', existe: '#7c5cff', ok: 'var(--success)' };
function _normNivelVisual(m) { return m.nivel === 'erro' ? 'erro' : m.existe ? 'existe' : m.nivel; }

// Prévia editável: clique na célula para corrigir; a linha é conferida de novo ao sair dela.
function renderPreviewNormalizado() {
  const previewBox = document.getElementById('normalizar-preview');
  const table = document.getElementById('normalizar-table');
  const resumo = document.getElementById('normalizar-resumo');
  const rows = _normalizarRows || [];
  if (!rows.length) { previewBox.style.display = 'none'; return; }

  let nErro = 0, nDuv = 0, nEx = 0, nOk = 0;
  rows.forEach((r, i) => {
    const m = _normalizarMeta[i] || {};
    if (m.nivel === 'erro') nErro++; else if (m.nivel === 'duvida') nDuv++; else nOk++;
    if (m.existe) nEx++;
  });
  const proprietarios = rows.filter((r) => /propriet/i.test(r[0])).length;
  const inquilinos = rows.filter((r) => /inquilino/i.test(r[0])).length;
  const dependentes = rows.filter((r) => /dependente/i.test(r[0])).length;
  const unidades = new Set(rows.map((r) => r[1] + '|' + r[2])).size;
  resumo.textContent = rows.length + ' linhas · ' + unidades + ' unidades · ' + proprietarios + ' proprietários · ' + inquilinos + ' inquilinos · ' + dependentes + ' dependentes';

  // Avisos gerais + resultado da conferência no Superlógica
  let caixa = document.getElementById('normalizar-avisos');
  if (!caixa) {
    caixa = document.createElement('div');
    caixa.id = 'normalizar-avisos';
    caixa.style.cssText = 'font-size:11px;font-family:var(--mono);margin-bottom:10px;line-height:1.6';
    const wrap = table.closest('.table-wrap');
    wrap.parentNode.insertBefore(caixa, wrap);
  }
  const ci = _normalizarConfInfo;
  let confHtml = '';
  if (ci && ci.carregando) confHtml = '<div style="color:var(--gs-blue)">Conferindo no Superlógica se as unidades já existem...</div>';
  else if (ci && ci.erro) confHtml = '<div style="color:var(--warn,#e0a82e)">⚠ ' + _normEsc(ci.erro) + '</div>';
  else if (ci) confHtml = '<div style="color:var(--muted)">Conferido com ' + _normEsc(ci.nome || ('código ' + ci.idSuperlogica)) + ' no Superlógica (' + ci.total + ' unidades cadastradas' + (ci.truncado ? ', lista incompleta' : '') + '): ' +
    (nEx ? '<b style="color:' + _NORM_COR.existe + '">' + nEx + ' linhas já existem</b>' : 'nenhuma linha já existe') + '.</div>';
  const desatualizadas = (_normalizarMeta || []).some((m) => m && m.confDesatualizada);
  caixa.innerHTML = _normalizarAvisos.map((a) => '<div style="color:var(--warn,#e0a82e)">⚠ ' + _normEsc(a) + '</div>').join('') + confHtml +
    (desatualizadas ? '<div style="color:var(--muted)">Você editou unidade, nome ou documento: clique em "Conferir de novo" para atualizar a conferência.</div>' : '') +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center">' +
    [['todas', 'Todas (' + rows.length + ')'], ['problema', 'Faltando obrigatório (' + nErro + ')'], ['duvida', 'Com dúvida (' + nDuv + ')'], ['existe', 'Já existem (' + nEx + ')'], ['ok', 'Sem pendência (' + nOk + ')']]
      .map(([v, l]) => '<div class="chip' + (_normalizarFiltro === v ? ' active' : '') + '" onclick="filtrarNormalizado(\'' + v + '\')">' + l + '</div>').join('') +
    '<button class="btn btn-ghost" onclick="conferirNormalizadoSuperlogica(true)" style="font-size:11px;padding:4px 10px">↻ Conferir de novo</button>' +
    (nEx ? '<button class="btn btn-ghost" onclick="removerExistentesNormalizado()" style="font-size:11px;padding:4px 10px">Remover as que já existem</button>' : '') +
    '</div>';

  const passa = (m) => _normalizarFiltro === 'todas' ? true
    : _normalizarFiltro === 'problema' ? m.nivel === 'erro'
    : _normalizarFiltro === 'duvida' ? m.nivel === 'duvida'
    : _normalizarFiltro === 'existe' ? m.existe
    : m.nivel === 'ok' && !m.existe;
  const th = (h) => '<th style="padding:6px 8px;background:var(--bg3);font-size:10px;font-family:var(--mono);text-transform:uppercase;color:var(--muted);position:sticky;top:0;border-bottom:1px solid var(--border2);white-space:nowrap;text-align:left">' + h + '</th>';
  const obrig = { 0: 1, 1: 1, 5: 1 };
  const head = '<thead><tr>' + th('') + th('Situação') + NORMALIZAR_HEADERS.map((h, c) => th(_normEsc(h) + (obrig[c] ? ' *' : ''))).join('') + '</tr></thead>';
  const linhasHtml = [];
  rows.forEach((r, i) => {
    const m = _normalizarMeta[i] || {};
    if (!passa(m)) return;
    linhasHtml.push(linhaHtmlNormalizado(r, i, m));
  });
  const vazio = '<tr><td colspan="28" style="padding:14px 8px;font-size:11px;font-family:var(--mono);color:var(--muted);text-align:center">Nenhuma linha nesta situação</td></tr>';
  table.innerHTML = head + '<tbody>' + (linhasHtml.join('') || vazio) + '</tbody>';
  if (!table._normEventos) {
    table._normEventos = true;
    table.addEventListener('focusout', aoEditarCelulaNormalizada);
    table.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && e.target.dataset && e.target.dataset.c != null) { e.preventDefault(); e.target.blur(); } });
  }
  previewBox.style.display = 'block';
}

function linhaHtmlNormalizado(r, i, m) {
  const nv = _normNivelVisual(m);
  const motivos = motivosLinhaNormalizada(m);
  const rotulo = nv === 'erro' ? 'Falta dado' : nv === 'existe' ? 'Já existe' : nv === 'duvida' ? 'Dúvida' : 'OK';
  const campoRuim = {};
  (m.erros || []).forEach((t) => { if (/tipo/.test(t)) campoRuim[0] = 1; if (/unidade/.test(t)) campoRuim[1] = 1; if (/nome/.test(t)) campoRuim[5] = 1; });
  const td = 'padding:5px 8px;font-size:11px;font-family:var(--mono);border-bottom:1px solid var(--border);white-space:nowrap;';
  return '<tr data-i="' + i + '" style="border-left:3px solid ' + _NORM_COR[nv] + '">' +
    '<td style="' + td + '"><button onclick="removerLinhaNormalizada(' + i + ')" title="Remover esta linha" style="border:none;background:none;color:var(--muted);cursor:pointer;font-size:13px">✕</button></td>' +
    '<td style="' + td + 'max-width:260px;overflow:hidden;text-overflow:ellipsis;color:' + _NORM_COR[nv] + '" title="' + _normEsc(motivos.join('\n')) + '"><b>' + rotulo + '</b>' + (motivos.length ? ' · ' + _normEsc(motivos.join('; ')) : '') + '</td>' +
    r.map((c, k) => '<td contenteditable="plaintext-only" spellcheck="false" data-c="' + k + '" style="' + td + 'min-width:40px;max-width:200px;overflow:hidden;text-overflow:ellipsis;outline:none' +
      (campoRuim[k] ? ';background:rgba(220,60,60,0.12)' : '') + '" title="' + _normEsc(c) + '">' + _normEsc(c) + '</td>').join('') +
    '</tr>';
}

// Célula editada: grava, confere a linha de novo e redesenha só ela (o resto da tabela fica).
function aoEditarCelulaNormalizada(e) {
  const cel = e.target;
  if (!cel || !cel.dataset || cel.dataset.c == null || !_normalizarRows) return;
  const tr = cel.closest('tr');
  const i = Number(tr && tr.dataset.i), c = Number(cel.dataset.c);
  const row = _normalizarRows[i];
  if (!row) return;
  const novo = String(cel.textContent || '').replace(/\s+/g, ' ').trim();
  if (novo === row[c]) return;
  row[c] = novo;
  const m = _normalizarMeta[i];
  if (c === 25) separarDuvidasIA(row);
  // Mexeu no que a conferência usa: o resultado antigo não vale mais para esta linha.
  if ([1, 2, 5, 6, 7].indexOf(c) !== -1 && m && m.conf) { m.conf = null; m.confDesatualizada = true; }
  validarNormalizado();
  // Redesenha depois do clique terminar (senão o clique em ✕, filtro ou botão se perde)
  // e devolve o foco para a célula para onde a pessoa foi (Tab ou clique).
  const destino = e.relatedTarget && e.relatedTarget.dataset && e.relatedTarget.dataset.c != null
    ? { i: e.relatedTarget.closest('tr') && e.relatedTarget.closest('tr').dataset.i, c: e.relatedTarget.dataset.c } : null;
  setTimeout(() => {
    renderPreviewNormalizado();
    if (destino) {
      const alvo = document.querySelector('#normalizar-table tr[data-i="' + destino.i + '"] td[data-c="' + destino.c + '"]');
      if (alvo) alvo.focus();
    }
  }, 150);
}

function removerLinhaNormalizada(i) {
  if (!_normalizarRows || !_normalizarRows[i]) return;
  // Lista nova (não splice): uma conferência em andamento percebe a mudança e se descarta.
  _normalizarRows = _normalizarRows.filter((_, k) => k !== i);
  _normalizarMeta = _normalizarMeta.filter((_, k) => k !== i);
  if (!_normalizarRows.length) { descartarNormalizado(); return; }
  validarNormalizado();
  renderPreviewNormalizado();
}

function removerExistentesNormalizado() {
  if (!_normalizarRows) return;
  const manter = _normalizarRows.map((_, i) => !(_normalizarMeta[i] && _normalizarMeta[i].existe));
  const n = manter.filter((x) => !x).length;
  if (!n || !confirm('Remover da prévia as ' + n + ' linhas que já existem no Superlógica?')) return;
  _normalizarRows = _normalizarRows.filter((_, i) => manter[i]);
  _normalizarMeta = _normalizarMeta.filter((_, i) => manter[i]);
  if (!_normalizarRows.length) { descartarNormalizado(); return; }
  validarNormalizado();
  renderPreviewNormalizado();
  toast(n + ' linhas removidas', 'ok');
}

function filtrarNormalizado(v) {
  _normalizarFiltro = v;
  renderPreviewNormalizado();
}

// Para a tela de revisão (unidades.js): situação de cada linha da prévia, na mesma ordem.
// Para a revisão saber se a checagem de duplicadas valeu: 'ok', 'carregando', 'falhou', 'desatualizada'.
function estadoConferenciaNormalizado() {
  const ci = _normalizarConfInfo;
  if (ci && ci.carregando) return 'carregando';
  if (!ci || ci.erro) return 'falhou';
  if ((_normalizarMeta || []).some((m) => m && m.confDesatualizada)) return 'desatualizada';
  return 'ok';
}

function situacaoLinhasNormalizado() {
  return (_normalizarRows || []).map((_, i) => {
    const m = _normalizarMeta[i] || {};
    return { nivel: m.nivel || 'ok', existe: !!m.existe, motivos: motivosLinhaNormalizada(m), erros: m.erros || [], conf: m.conf || null };
  });
}

function descartarNormalizado() {
  _normalizarGeracao++;
  _normalizarRows = null;
  _normalizarMeta = [];
  _normalizarAvisos = [];
  _normalizarConfInfo = null;
  _normalizarSourceName = '';
  document.getElementById('normalizar-preview').style.display = 'none';
  document.getElementById('normalizar-status').textContent = '';
  document.getElementById('normalizar-status').style.color = '';
  toast('Descartado', 'ok');
}

function baixarPlanilhaNormalizada() {
  if (!_normalizarRows || !_normalizarRows.length) { toast('Nada pra baixar', 'err'); return; }
  const aoa = [NORMALIZAR_HEADERS.slice(), ..._normalizarRows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Unidades');
  const baseName = (_normalizarSourceName || 'unidades').replace(/\.[^.]+$/, '');
  XLSX.writeFile(wb, `${baseName}_normalizado.xlsx`);
  toast('Planilha baixada', 'ok');
}

// Trocou de condomínio: a conferência era do anterior (unidades.js já limpa a prévia).
window.addEventListener('condominioAtivo:trocou', function() {
  _normalizarGeracao++;
  const pw = document.getElementById('normalizar-progress-wrap');
  if (pw) pw.style.display = 'none';
  _normalizarMeta = [];
  _normalizarAvisos = [];
  _normalizarConfInfo = null;
});

// Baixa a planilha 26 colunas com os contatos ativos da tela de revisao
// (mesmos que seriam enviados por confirmarRevisao). Disponivel pras 4
// familias, nao so pro Normalizador IA: qualquer origem que passe pela tela
// de revisao ganha o mesmo botao de baixar antes de importar.
function baixarRevisaoXLSX() {
  var cont = _revisaoContatos || [];
  var ativos = cont.filter(function(c) { return c.papel !== 'descartar' && c._valido !== false; });
  if (!ativos.length) { toast('Nada pra baixar', 'err'); return; }
  var aoa = [NORMALIZAR_HEADERS.slice()].concat(ativos.map(contatoParaLinha26));
  var ws = XLSX.utils.aoa_to_sheet(aoa);
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Unidades');
  var baseName = (_revisaoSource || 'unidades').replace(/\.[^.]+$/, '');
  XLSX.writeFile(wb, baseName + '_revisado.xlsx');
  toast('Planilha baixada', 'ok');
}
