// Regras do condomínio, frente D: acervo de convenção, regimento, atas e regulamentos.
// Lê o texto do PDF (num processo separado, como a entrada de documentos), manda o PDF
// digitalizado para leitura página a página, grava o documento e os trechos (banco.js),
// guarda o PDF no bucket privado "regras" e aponta as pendências de cada condomínio.
// Todas as funções recebem `deps` (as mesmas dependências das rotas) para rodar no teste
// sem rede: deps.banco, deps.storageUpload, deps.chamarModelo, deps.modelos.

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const B = require('./banco');

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const BUCKET = 'regras';
// Leitura de digitalizado: limite de páginas por envio, de tamanho por chamada e faixa de
// páginas pedida em cada chamada (uma resposta com o texto de 6 páginas cabe com folga).
const MAX_PAGINAS_ESCANEADO = 100;
const MAX_BYTES_ESCANEADO = 22 * 1024 * 1024; // em base64 passa de 29 MB, perto do teto de uma chamada
const FAIXA_PAGINAS = 6;
const LEITURAS_SIMULTANEAS = 3; // faixas lidas ao mesmo tempo dentro de um documento
const MAX_ESCANEADOS_EM_CURSO = 2; // documentos digitalizados sendo lidos no servidor inteiro
const TIPOS_COM_VIGENTE = ['convencao', 'regimento'];
const ROTULO_TIPO = { convencao: 'convenção', regimento: 'regimento interno', ata: 'ata', regulamento: 'regulamento', outro: 'documento' };

// Erro com mensagem que pode ir para a tela (sem detalhe técnico) e o status da resposta.
class ErroAcervo extends Error {
  constructor(codigo, detalhe, status) { super(codigo); this.codigo = codigo; this.detalhe = detalhe; this.status = status || 400; }
}

const ehPdf = (buf) => Buffer.isBuffer(buf) && buf.length > 100 && buf.slice(0, 1024).toString('latin1').includes('%PDF-');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOuNulo = (v) => (typeof v === 'string' && UUID.test(v) ? v : null);

// Texto de tela e título: sem caracteres de controle, espaços colapsados, tamanho limitado.
function textoLimpo(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
// Data aceita em AAAA-MM-DD ou DD/MM/AAAA; devolve AAAA-MM-DD válida ou null.
function normalizarData(v) {
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let a, mes, d;
  if (m) { a = +m[1]; mes = +m[2]; d = +m[3]; } else {
    m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
    if (!m) return null;
    d = +m[1]; mes = +m[2]; a = +m[3];
  }
  const dt = new Date(Date.UTC(a, mes - 1, d));
  if (a < 1900 || a > 2100 || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== d) return null;
  return a + '-' + String(mes).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// ---------- Leitura do PDF ----------

// Memória residente do processo filho, em bytes (Linux pelo /proc; outros sistemas pelo ps).
function memoriaDe(pid) {
  return new Promise((ok) => {
    fs.readFile('/proc/' + pid + '/statm', 'utf8', (e, t) => {
      if (!e) return ok(Number(String(t).split(' ')[1]) * 4096 || 0);
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 }, (e2, out) => ok(e2 ? 0 : (Number(String(out).trim()) || 0) * 1024));
    });
  });
}

// Texto de cada página, lido em processo separado (acervo-pdf-worker.js) para o PDF malicioso
// ou enorme não travar nem derrubar o servidor: o pai mata o filho se passar de 600 MB ou de
// 90 s. No máximo 2 leituras de cada vez; as outras esperam a vez (até 2 minutos).
// Devolve { paginas, textos } ou null quando o PDF não abre (protegido por senha, corrompido).
const PDF_TEMPO_MS = 90000;
const PDF_MEMORIA_BYTES = 600 * 1024 * 1024;
let _pdfEmCurso = 0;
async function extrairPaginas(buf) {
  for (let t = 0; _pdfEmCurso >= 2; t++) {
    if (t > 600) return null;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  _pdfEmCurso++;
  return new Promise((resolve) => {
    let fim = false, filho = null, relogio = null, vigia = null, tamanho = 0;
    const partes = [];
    const acabar = (v) => {
      if (fim) return;
      fim = true; _pdfEmCurso--;
      clearTimeout(relogio); clearInterval(vigia);
      try { if (filho && filho.exitCode === null) filho.kill('SIGKILL'); } catch (e) { /* já saiu */ }
      resolve(v);
    };
    try {
      // Sem os segredos do servidor no ambiente do filho.
      filho = spawn(process.execPath, [path.join(__dirname, 'acervo-pdf-worker.js'), '600'], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH || '', NODE_PATH: process.env.NODE_PATH || '', NODE_ENV: process.env.NODE_ENV || '' } });
    } catch (e) { fim = true; _pdfEmCurso--; return resolve(null); }
    relogio = setTimeout(() => acabar(null), PDF_TEMPO_MS);
    let medindo = false;
    vigia = setInterval(async () => {
      if (medindo || fim) return;
      medindo = true;
      const m = await memoriaDe(filho.pid);
      medindo = false;
      if (m > PDF_MEMORIA_BYTES) acabar(null);
    }, 150);
    filho.stdout.on('data', (c) => { tamanho += c.length; if (tamanho > 12 * 1024 * 1024) return acabar(null); partes.push(c); });
    filho.on('error', () => acabar(null));
    filho.on('close', () => {
      let m = null;
      try { m = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (e) { m = null; }
      acabar(m && m.ok && Array.isArray(m.textos) ? { paginas: Number(m.paginas) || m.textos.length, textos: m.textos.map(String) } : null);
    });
    filho.stdin.on('error', () => acabar(null));
    filho.stdin.end(buf);
  });
}

// PDF digitalizado: metade ou mais das páginas sem texto de verdade (menos de 60 letras).
// Página de assinatura ou em branco num documento digitado não faz o PDF inteiro ser relido.
function ehEscaneado(textos) {
  if (!textos.length) return true;
  const vazias = textos.filter((t) => (String(t).match(/[A-Za-zÀ-ú]/g) || []).length < 60).length;
  return vazias >= Math.ceil(textos.length / 2);
}

const SYSTEM_LEITURA = [
  'Você transcreve documentos de condomínio digitalizados (convenção, regimento interno, ata, regulamento).',
  'Transcreva o texto EXATAMENTE como está no documento, palavra por palavra, só das páginas pedidas.',
  'Regras:',
  '1. Não resuma, não corrija ortografia nem concordância, não atualize grafia antiga, não complete frases, não acrescente nada.',
  '2. Mantenha numeração de artigos, parágrafos, incisos e alíneas como estão (Art. 12, § 1º, I, a).',
  '3. Mantenha uma linha para cada parágrafo do documento. Tabelas: uma linha por linha da tabela, colunas separadas por " | ".',
  '4. Palavra ou trecho que não dá para ler: escreva [ilegível]. Nunca adivinhe.',
  '5. Carimbos, assinaturas e rubricas: escreva [assinatura] ou [carimbo] sem tentar ler o nome, a não ser que esteja impresso em letra legível.',
  '6. Antes do texto de cada página escreva uma linha só com === PÁGINA N === (N é o número da página no arquivo, contando a partir de 1). Página sem texto: só a linha do marcador.',
  '7. Responda só com a transcrição, sem comentário antes ou depois.',
].join('\n');

// Separa a resposta da leitura nas páginas marcadas (=== PÁGINA N ===). Map numero -> texto.
function separarPaginasLidas(texto) {
  const out = new Map();
  const re = /^\s*=+\s*P[ÁA]GINA\s+(\d{1,4})\s*=+\s*$/gim;
  const marcas = [];
  let m;
  while ((m = re.exec(texto))) marcas.push({ n: Number(m[1]), ini: m.index, fimMarca: re.lastIndex });
  marcas.forEach((mk, i) => {
    const corpo = texto.slice(mk.fimMarca, i + 1 < marcas.length ? marcas[i + 1].ini : texto.length).replace(/^\n+|\s+$/g, '');
    out.set(mk.n, (out.has(mk.n) ? out.get(mk.n) + '\n' : '') + corpo);
  });
  return out;
}

// Lê uma faixa de páginas do PDF digitalizado. Resposta cortada no tamanho máximo divide a
// faixa ao meio e lê cada metade (o texto de uma página nunca fica pela metade sem aviso).
// O PDF vai com marca de reaproveitamento: as faixas seguintes do mesmo arquivo saem mais baratas.
async function lerFaixa(deps, base64, ini, fim, ctx) {
  const r = await deps.chamarModelo({
    modelo: deps.modelos.modelo('regras_leitura'), maxTokens: 16000, system: SYSTEM_LEITURA,
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 }, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Transcreva as páginas ' + ini + ' a ' + fim + ' deste arquivo (contando a partir de 1), seguindo as regras.' },
    ],
    timeoutMs: 240000, rotulo: 'regras_leitura', usuario: ctx.usuario || null, condominio: ctx.idSL || null, funcao: 'regras',
  });
  if (!r || !r.ok) throw new ErroAcervo('leitura_falhou', 'Não foi possível ler o documento digitalizado agora. Tente de novo em alguns minutos.', r && r.status === 504 ? 504 : 502);
  if (r.cortado && fim > ini) {
    const meio = Math.floor((ini + fim) / 2);
    const a = await lerFaixa(deps, base64, ini, meio, ctx);
    const b = await lerFaixa(deps, base64, meio + 1, fim, ctx);
    return new Map([...a, ...b]);
  }
  const lidas = separarPaginasLidas(r.texto || '');
  // Resposta sem marcador numa faixa de uma página só: o texto todo é daquela página.
  if (!lidas.size && ini === fim) lidas.set(ini, String(r.texto || '').trim());
  const out = new Map();
  for (let p = ini; p <= fim; p++) out.set(p, lidas.get(p) || '');
  return out;
}

let _escaneadosEmCurso = 0;

// Texto do PDF com as páginas separadas por \f. PDF digitado: só o leitor local, sem custo.
// PDF digitalizado: leitura fiel página a página, em faixas de 6 páginas, até 100 páginas.
// opts: { idSL, usuario, aoDetectar(info) }. aoDetectar é chamado depois de abrir o PDF
// ({ paginas, escaneado }), antes da leitura demorada (a rota responde "processando" ali).
// opts.extrair troca o leitor local (só no teste). Devolve { texto, paginas, escaneado }.
async function lerTextoPdf(deps, buffer, opts) {
  const o = opts || {};
  if (!ehPdf(buffer)) throw new ErroAcervo('nao_e_pdf', 'O arquivo enviado não é um PDF.', 400);
  const lido = await (o.extrair || extrairPaginas)(buffer);
  if (!lido) throw new ErroAcervo('pdf_ilegivel', 'Não foi possível abrir este PDF. Confira se ele não está protegido por senha ou corrompido.', 400);
  const escaneado = ehEscaneado(lido.textos);
  if (!escaneado) {
    if (typeof o.aoDetectar === 'function') await o.aoDetectar({ paginas: lido.paginas, escaneado: false });
    return { texto: lido.textos.join('\f'), paginas: lido.paginas, escaneado: false };
  }
  if (lido.paginas > MAX_PAGINAS_ESCANEADO) {
    throw new ErroAcervo('escaneado_grande', 'Este PDF é digitalizado e tem ' + lido.paginas + ' páginas. O limite para documento digitalizado é ' + MAX_PAGINAS_ESCANEADO + ' páginas: divida o arquivo em partes e envie cada parte.', 413);
  }
  if (buffer.length > MAX_BYTES_ESCANEADO) {
    throw new ErroAcervo('escaneado_pesado', 'Este PDF é digitalizado e passa de 22 MB. Diminua a resolução da digitalização ou divida o arquivo em partes.', 413);
  }
  if (_escaneadosEmCurso >= MAX_ESCANEADOS_EM_CURSO) {
    throw new ErroAcervo('fila_cheia', 'Outros documentos digitalizados estão sendo lidos agora. Tente de novo em alguns minutos.', 429);
  }
  _escaneadosEmCurso++;
  try {
    if (typeof o.aoDetectar === 'function') await o.aoDetectar({ paginas: lido.paginas, escaneado: true });
    const base64 = buffer.toString('base64');
    const faixas = [];
    for (let p = 1; p <= lido.paginas; p += FAIXA_PAGINAS) faixas.push([p, Math.min(lido.paginas, p + FAIXA_PAGINAS - 1)]);
    const paginas = new Map();
    // Algumas faixas ao mesmo tempo, na ordem; a primeira falha interrompe as que ainda não começaram.
    let proxima = 0;
    let erro = null;
    const trabalhador = async () => {
      while (!erro && proxima < faixas.length) {
        const [ini, fim] = faixas[proxima++];
        try { (await lerFaixa(deps, base64, ini, fim, { idSL: o.idSL, usuario: o.usuario })).forEach((t, n) => paginas.set(n, t)); } catch (e) { erro = erro || e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LEITURAS_SIMULTANEAS, faixas.length) }, trabalhador));
    if (erro) throw erro;
    const textos = [];
    for (let p = 1; p <= lido.paginas; p++) textos.push(paginas.get(p) || '');
    return { texto: textos.join('\f'), paginas: lido.paginas, escaneado: true };
  } finally {
    _escaneadosEmCurso--;
  }
}

// ---------- Resumo da ata ----------

const SYSTEM_RESUMO_ATA = [
  'Você recebe o texto de uma ata de assembleia de condomínio e escreve um resumo curto em português.',
  'Use só o que está escrito na ata. Não invente, não deduza e não complete nada.',
  'Formato: uma informação por linha, só as linhas que a ata sustentar, nesta ordem:',
  'Assembleia: tipo (ordinária ou extraordinária), data e horário de início',
  'Presidente: nome',
  'Secretário: nome',
  'Pauta:',
  '1. assunto do item: resultado (aprovado, reprovado, adiado ou só discutido; números da votação quando a ata trouxer)',
  'Eleição: cargo e nome de cada eleito',
  'Mandato: período do mandato como escrito na ata',
  'Não use hífen nem travessão. Sem título, sem comentário e sem markdown.',
].join('\n');

// Resumo curto da ata (resultado de cada item, presidente, secretário, horário, eleição e
// mandato). Falha não impede o documento de entrar no acervo: devolve null.
async function resumirAta(deps, texto, ctx) {
  const t = String(texto || '').replace(/\f/g, '\n').trim();
  if (t.length < 80) return null;
  try {
    const r = await deps.chamarModelo({
      modelo: deps.modelos.modelo('regras_extracao'), maxTokens: 4000, esforco: 'low', system: SYSTEM_RESUMO_ATA,
      content: '=== ATA ===\n' + t.slice(0, 80000) + '\n=== FIM DA ATA ===\n\nEscreva o resumo seguindo o formato.',
      timeoutMs: 120000, rotulo: 'regras_resumo_ata', usuario: (ctx && ctx.usuario) || null, condominio: (ctx && ctx.idSL) || null, funcao: 'regras',
    });
    if (!r || !r.ok || !r.texto) return null;
    // Travessão e hífen solto viram vírgula (regra de texto de tela); markdown sai.
    const limpo = String(r.texto).replace(/[*#`]/g, '').replace(/\s[–—-]\s/g, ', ').replace(/[–—]/g, ', ').replace(/\n{3,}/g, '\n\n').trim();
    return limpo ? limpo.slice(0, 4000) : null;
  } catch (e) {
    console.warn('[regras acervo] resumo da ata falhou: ' + (e && e.message));
    return null;
  }
}

// ---------- Gravação ----------

// Guarda o PDF no bucket e grava o caminho no documento. Se o arquivo não subir, apaga o
// documento (os trechos vão junto pelo cascade): documento novo sem PDF não fica no acervo.
async function guardarArquivo(deps, idSL, docId, buf) {
  const caminho = String(idSL) + '/' + docId + '.pdf';
  try {
    await deps.storageUpload(BUCKET, caminho, buf, 'application/pdf');
  } catch (e) {
    console.warn('[regras acervo] arquivo do documento ' + docId + ' não subiu: ' + (e && e.message));
    await deps.banco('DELETE', '/rest/v1/regras_documentos?id=eq.' + Number(docId)).catch(() => null);
    throw new ErroAcervo('arquivo_falhou', 'Não foi possível guardar o arquivo agora. Tente de novo em instantes.', 502);
  }
  const r = await deps.banco('PATCH', '/rest/v1/regras_documentos?id=eq.' + Number(docId), { arquivo_path: caminho, arquivo_bytes: buf.length, atualizado_em: new Date().toISOString() });
  if (r.status >= 300) console.warn('[regras acervo] caminho do arquivo do documento ' + docId + ' não gravou: ' + r.status);
  return caminho;
}

// Confere os dados do envio e devolve o que vai para o banco (ou lança ErroAcervo).
function validarEnvio(idSL, d) {
  if (!/^[1-9][0-9]{0,8}$/.test(String(idSL))) throw new ErroAcervo('id_invalido', 'Código do Superlógica inválido.', 400);
  if (!B.TIPOS.includes(d.tipo)) throw new ErroAcervo('tipo_invalido', 'Escolha o tipo do documento.', 400);
  const titulo = textoLimpo(d.titulo, 200);
  if (titulo.length < 3) throw new ErroAcervo('titulo_invalido', 'Escreva um título com pelo menos 3 letras.', 400);
  if (!Buffer.isBuffer(d.pdfBuffer) || !d.pdfBuffer.length) throw new ErroAcervo('arquivo_ausente', 'O PDF não veio.', 400);
  if (d.pdfBuffer.length > MAX_PDF_BYTES) throw new ErroAcervo('arquivo_grande', 'O PDF passa de 50 MB. Divida o arquivo em partes.', 413);
  if (!ehPdf(d.pdfBuffer)) throw new ErroAcervo('nao_e_pdf', 'O arquivo enviado não é um PDF.', 400);
  return { titulo, data_documento: normalizarData(d.data_documento) };
}

// Envio de documento novo pela tela: confere, lê o texto, grava documento e trechos, guarda o
// PDF em '<id_superlogica>/<documento_id>.pdf', faz o resumo da ata e, se for convenção ou
// regimento marcado como vigente, tira a marca do anterior.
// d: { tipo, titulo, data_documento, pdfBuffer, vigente, criado_por, aoDetectar }.
// Devolve { id, duplicado, trechos, paginas, escaneado, resumo }.
async function enviarDocumento(deps, idSL, d) {
  const dados = d || {};
  const ok = validarEnvio(idSL, dados);
  const criadoPor = uuidOuNulo(dados.criado_por);
  const lido = await lerTextoPdf(deps, dados.pdfBuffer, { idSL: Number(idSL), usuario: criadoPor, aoDetectar: dados.aoDetectar, extrair: dados.extrair });
  const vigente = dados.vigente !== false;
  const ins = await B.inserirDocumento(deps.banco, {
    id_superlogica: Number(idSL), tipo: dados.tipo, titulo: ok.titulo, data_documento: ok.data_documento,
    vigente: TIPOS_COM_VIGENTE.includes(dados.tipo) ? vigente : true, origem: 'upload',
    arquivo_bytes: dados.pdfBuffer.length, texto: lido.texto, criado_por: criadoPor,
  });
  if (ins.duplicado) return { id: ins.id, duplicado: true, paginas: lido.paginas, escaneado: lido.escaneado };
  await guardarArquivo(deps, idSL, ins.id, dados.pdfBuffer);
  if (TIPOS_COM_VIGENTE.includes(dados.tipo) && vigente) await B.marcarVigente(deps.banco, Number(idSL), ins.id);
  let resumo = null;
  if (dados.tipo === 'ata') {
    resumo = await resumirAta(deps, lido.texto, { idSL: Number(idSL), usuario: criadoPor });
    if (resumo) await deps.banco('PATCH', '/rest/v1/regras_documentos?id=eq.' + ins.id, { resumo }).catch(() => null);
  }
  return { id: ins.id, duplicado: false, trechos: ins.trechos, paginas: lido.paginas, escaneado: lido.escaneado, resumo };
}

// Ata gerada no Hub e arquivada no Superlógica entra também no acervo (origem 'ata_hub'),
// com o texto que o Hub já tem (não relê o PDF). Chamada depois da resposta da rota de
// arquivar, sem segurar a tela: nunca lança erro, devolve { ok, id, duplicado } ou { ok: false }.
async function arquivarAtaNoAcervo(deps, a) {
  const o = a || {};
  try {
    const idSL = String(o.idSL || '');
    if (!/^[1-9][0-9]{0,8}$/.test(idSL)) return { ok: false, erro: 'id_invalido' };
    const texto = String(o.texto || '').trim();
    if (texto.length < 80) return { ok: false, erro: 'sem_texto' };
    const titulo = textoLimpo(o.titulo, 200) || 'Ata de assembleia';
    const buf = Buffer.isBuffer(o.pdfBuffer) && ehPdf(o.pdfBuffer) && o.pdfBuffer.length <= MAX_PDF_BYTES ? o.pdfBuffer : null;
    const criadoPor = uuidOuNulo(o.criado_por);
    const ins = await B.inserirDocumento(deps.banco, {
      id_superlogica: Number(idSL), tipo: 'ata', titulo, data_documento: normalizarData(o.data_documento), vigente: true,
      origem: 'ata_hub', arquivo_bytes: buf ? buf.length : null, texto, criado_por: criadoPor,
    });
    if (ins.duplicado) return { ok: true, id: ins.id, duplicado: true };
    // PDF que não subir não apaga a ata do acervo: o texto já vale para a consulta, e a
    // pendência "sem arquivo" mostra o que faltou.
    if (buf) {
      const caminho = idSL + '/' + ins.id + '.pdf';
      try {
        await deps.storageUpload(BUCKET, caminho, buf, 'application/pdf');
        await deps.banco('PATCH', '/rest/v1/regras_documentos?id=eq.' + ins.id, { arquivo_path: caminho, atualizado_em: new Date().toISOString() });
      } catch (e) { console.warn('[regras acervo] PDF da ata ' + ins.id + ' não subiu: ' + (e && e.message)); }
    }
    const resumo = await resumirAta(deps, texto, { idSL: Number(idSL), usuario: criadoPor });
    if (resumo) await deps.banco('PATCH', '/rest/v1/regras_documentos?id=eq.' + ins.id, { resumo }).catch(() => null);
    return { ok: true, id: ins.id, duplicado: false };
  } catch (e) {
    console.warn('[regras acervo] ata do Hub não entrou no acervo: ' + (e && e.message));
    return { ok: false, erro: 'falha' };
  }
}

// ---------- Pendências ----------

const CAMPOS_PENDENCIA = 'id,id_superlogica,tipo,titulo,vigente,arquivo_path,hash_texto';

// Documentos de vários condomínios (ids null = todos), só os campos das pendências, em
// páginas de 1000 (o banco devolve no máximo 1000 linhas por vez).
async function documentosParaPendencias(banco, ids) {
  const filtro = ids == null ? 'id_superlogica=not.is.null' : 'id_superlogica=in.(' + ids.map(Number).filter((n) => n > 0).join(',') + ')';
  const todos = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const r = await banco('GET', '/rest/v1/regras_documentos?' + filtro + '&select=' + CAMPOS_PENDENCIA + '&order=id.asc&limit=1000&offset=' + offset);
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('pendencias_falhou_' + r.status);
    todos.push(...r.body);
    if (r.body.length < 1000) break;
  }
  return todos;
}

// Pendências de um condomínio a partir dos documentos dele (função pura, usada no teste).
// Devolve { contagens: { convencao, regimento, ata, regulamento, outro }, pendencias: [{ codigo, texto, documentos }] }.
function pendenciasDoCondominio(docs) {
  const contagens = { convencao: 0, regimento: 0, ata: 0, regulamento: 0, outro: 0 };
  docs.forEach((d) => { if (Object.prototype.hasOwnProperty.call(contagens, d.tipo)) contagens[d.tipo]++; });
  const pend = [];
  const ref = (lista) => lista.slice(0, 20).map((d) => ({ id: d.id, titulo: d.titulo, tipo: d.tipo }));
  TIPOS_COM_VIGENTE.forEach((tipo) => {
    const nome = tipo === 'convencao' ? 'convenção' : 'regimento interno';
    const doTipo = docs.filter((d) => d.tipo === tipo);
    const vigentes = doTipo.filter((d) => d.vigente);
    if (!doTipo.length) pend.push({ codigo: 'sem_' + tipo, texto: 'Sem ' + nome + ' no acervo.', documentos: [] });
    else if (!vigentes.length) pend.push({ codigo: tipo + '_sem_vigente', texto: 'Nenhuma ' + (tipo === 'convencao' ? 'convenção' : 'versão do regimento') + ' marcada como a que vale hoje.', documentos: ref(doTipo) });
    else if (vigentes.length > 1) pend.push({ codigo: tipo + '_duplicado', texto: 'Mais de ' + (tipo === 'convencao' ? 'uma convenção marcada' : 'um regimento marcado') + ' como o que vale hoje (' + vigentes.length + ').', documentos: ref(vigentes) });
  });
  const semTexto = docs.filter((d) => !d.hash_texto);
  if (semTexto.length) pend.push({ codigo: 'sem_texto', texto: semTexto.length + (semTexto.length === 1 ? ' documento sem texto lido (não aparece na consulta).' : ' documentos sem texto lido (não aparecem na consulta).'), documentos: ref(semTexto) });
  const semArquivo = docs.filter((d) => !d.arquivo_path);
  if (semArquivo.length) pend.push({ codigo: 'sem_arquivo', texto: semArquivo.length + (semArquivo.length === 1 ? ' documento sem o PDF guardado.' : ' documentos sem o PDF guardado.'), documentos: ref(semArquivo) });
  return { contagens, pendencias: pend };
}

// Pendências por condomínio. ids: lista de códigos do Superlógica (ou null = todos os que têm
// documento). Condomínio da lista sem documento nenhum também aparece (sem convenção, sem regimento).
// Devolve [{ id_superlogica, total, contagens, pendencias }] na ordem dos ids.
async function pendencias(deps, ids) {
  const lista = ids == null ? null : [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (lista && !lista.length) return [];
  const docs = [];
  // Carteira grande vira várias consultas para o endereço não ficar comprido demais.
  if (lista) { for (let i = 0; i < lista.length; i += 150) docs.push(...await documentosParaPendencias(deps.banco, lista.slice(i, i + 150))); } else docs.push(...await documentosParaPendencias(deps.banco, null));
  const porCond = new Map();
  (lista || []).forEach((id) => porCond.set(id, []));
  docs.forEach((d) => { const k = Number(d.id_superlogica); if (!porCond.has(k)) porCond.set(k, []); porCond.get(k).push(d); });
  return [...porCond.entries()].map(([id, ds]) => Object.assign({ id_superlogica: id, total: ds.length }, pendenciasDoCondominio(ds)));
}

module.exports = {
  lerTextoPdf, enviarDocumento, arquivarAtaNoAcervo, pendencias, pendenciasDoCondominio,
  ErroAcervo, ehPdf, ehEscaneado, separarPaginasLidas, normalizarData, textoLimpo, resumirAta, extrairPaginas,
  MAX_PDF_BYTES, BUCKET, TIPOS_COM_VIGENTE, ROTULO_TIPO, MAX_PAGINAS_ESCANEADO,
};
