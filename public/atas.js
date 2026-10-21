// ============================================================
// ATAS CONDOMINIAIS: extraído de public/index.html (T07, só movido, sem mudar
// comportamento). Script clássico: funções e variáveis seguem globais, no mesmo
// escopo do script inline do index.html. Inclui: áudio e transcrição, documentos
// da assembleia (T01), edital, geração, revisão, PDF e Word da ata.
// ============================================================

// ============================================================
// DRAG & DROP DE ÁUDIO NO BLOCO ①
// ============================================================
function audioDragOver(e) {
  e.preventDefault();
  const wrap = document.getElementById('audio-dropzone-wrap');
  wrap.style.borderColor = 'var(--gs-blue)';
  wrap.style.background = 'rgba(59,154,199,0.06)';
}

function audioDragLeave(e) {
  const wrap = document.getElementById('audio-dropzone-wrap');
  wrap.style.borderColor = '';
  wrap.style.background = 'var(--bg3)';
}

function audioDrop(e) {
  e.preventDefault();
  audioDragLeave(e);
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const allowed = ['audio/mpeg','audio/mp4','audio/m4a','audio/wav','audio/ogg','audio/webm','audio/flac','audio/aac','video/mp4'];
  const ext = file.name.split('.').pop().toLowerCase();
  const allowedExt = ['mp3','mp4','m4a','wav','ogg','webm','flac','aac'];
  if (!allowed.includes(file.type) && !allowedExt.includes(ext)) {
    toast('Formato não suportado. Use mp3, m4a, wav, etc.', 'err');
    return;
  }
  processarArquivoAudio(file);
}

// ============================================================
// TRANSCRIÇÃO VIA ASSEMBLYAI: qualquer tamanho, qualquer formato
// Upload direto → poll até concluir → retorna texto completo
// ============================================================
// URLs do proxy AssemblyAI servido pelo backend (a chave fica no env ASSEMBLYAI_KEY no Railway)
const AAI_UPLOAD_URL = '/api/assemblyai/upload';
const AAI_TRANSCRIPT_URL = '/api/assemblyai/transcript';
const AAI_POLL_BASE = '/api/assemblyai/transcript/';

let audioAbortController = null;
let pollTimer = null;

async function importarAudio(event) {
  const file = event.target.files[0];
  if (!file) return;
  processarArquivoAudio(file);
}

function cancelarAudio() {
  if (audioAbortController) { audioAbortController.abort(); audioAbortController = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  document.getElementById('audio-progress-wrap').style.display = 'none';
  document.getElementById('audio-file-nome').textContent = '';
  document.getElementById('btn-cancelar-audio').style.display = 'none';
  toast('Transcrição cancelada', 'warn');
}

function setAudioProgress(pct, label, log) {
  document.getElementById('audio-progress-bar').style.width = pct + '%';
  document.getElementById('audio-progress-pct').textContent = Math.round(pct) + '%';
  document.getElementById('audio-progress-label').textContent = label;
  if (log !== undefined) document.getElementById('audio-log').textContent = log;
}

// ─── Compressão condicional de áudio (ffmpeg.wasm) ─────────────────────────
// Áudio grande estoura o limite de ~5 min de upload do edge do Railway (502).
// Solução: ACIMA de 60 MB, comprime automático no navegador pra mono/16kHz/64kbps
// (setting TRAVADO, validado em 2026-07-07: preserva números, valores e decisões da
// transcrição) antes de subir. ABAIXO de 60 MB, sobe original sem nem carregar o
// ffmpeg.wasm (~30 MB). O usuário não escolhe nada; decide pelo tamanho.
const AUDIO_COMPRESS_THRESHOLD = 60 * 1024 * 1024; // 60 MB
let _ffmpeg = null;
let _ffmpegProgressCb = null;

function _injectScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[data-vendor="' + src + '"]')) return resolve();
    const s = document.createElement('script');
    s.src = src; s.dataset.vendor = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('falha ao carregar ' + src));
    document.head.appendChild(s);
  });
}

// Carrega o ffmpeg.wasm sob demanda (só quando precisa comprimir). Self-hosted em
// /vendor/ffmpeg (sem CDN, sem COOP/COEP: o core single-thread não usa SharedArrayBuffer).
async function carregarFfmpeg() {
  if (_ffmpeg) return _ffmpeg;
  await _injectScript('/vendor/ffmpeg/ffmpeg.js');
  await _injectScript('/vendor/ffmpeg/util.js');
  const ff = new window.FFmpegWASM.FFmpeg();
  ff.on('progress', ({ progress }) => { if (_ffmpegProgressCb) _ffmpegProgressCb(progress); });
  await ff.load({ coreURL: '/vendor/ffmpeg/ffmpeg-core.js', wasmURL: '/vendor/ffmpeg/ffmpeg-core.wasm' });
  _ffmpeg = ff;
  return ff;
}

// Comprime só se o arquivo for grande. Retorna { file, comprimido, origMB?, novoMB? }.
async function comprimirAudioSeGrande(file, sig) {
  if (file.size < AUDIO_COMPRESS_THRESHOLD) return { file, comprimido: false };
  const origMB = (file.size / 1048576).toFixed(1);
  setAudioProgress(2, 'Áudio grande (' + origMB + 'MB), otimizando para upload...', 'Carregando compressor (única vez)...');
  const ff = await carregarFfmpeg();
  _ffmpegProgressCb = (p) => {
    const pct = Math.max(2, Math.min(99, Math.round(p * 100)));
    setAudioProgress(pct, 'Áudio grande, otimizando para upload... ' + pct + '%', 'Comprimindo (mono 64k 16kHz)...');
  };
  try {
    const { fetchFile } = window.FFmpegUtil;
    await ff.writeFile('in', await fetchFile(file));
    // SETTING TRAVADO (aprovado 2026-07-07): mono, 16 kHz, 64 kbps mp3. Não expor ao usuário.
    await ff.exec(['-i', 'in', '-ac', '1', '-ar', '16000', '-b:a', '64k', '-f', 'mp3', 'out.mp3'], -1, sig ? { signal: sig } : undefined);
    const data = await ff.readFile('out.mp3');
    await ff.deleteFile('in').catch(() => {});
    await ff.deleteFile('out.mp3').catch(() => {});
    const nome = file.name.replace(/\.[^.]+$/, '') + '.mp3';
    const novo = new File([data], nome, { type: 'audio/mpeg' });
    const novoMB = (novo.size / 1048576).toFixed(1);
    setAudioProgress(15, 'Otimizado: ' + origMB + 'MB → ' + novoMB + 'MB', 'Compressão concluída ✓');
    return { file: novo, comprimido: true, origMB, novoMB };
  } catch (e) {
    _ffmpeg = null; // instância pode ter sido terminada; força reload limpo na próxima
    throw e;
  } finally { _ffmpegProgressCb = null; }
}

// fetch com timeout de etapa (via AbortController). Marca err.__timeout=true no estouro,
// pra o retry saber que NÃO deve re-tentar (não re-sobe um arquivo grande à toa).
async function fetchComTimeout(url, opts, ms, signalExterno) {
  const ac = new AbortController();
  let estourou = false;
  const timer = setTimeout(() => { estourou = true; ac.abort(); }, ms);
  const onAbort = () => ac.abort();
  if (signalExterno) signalExterno.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
  } catch (e) {
    if (estourou) { const err = new Error('esta etapa demorou demais (timeout)'); err.__timeout = true; throw err; }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signalExterno) signalExterno.removeEventListener('abort', onAbort);
  }
}

async function processarArquivoAudio(file) {
  audioAbortController = new AbortController();
  const sig = audioAbortController.signal;
  document.getElementById('audio-file-nome').textContent = file.name;
  document.getElementById('audio-progress-wrap').style.display = 'block';
  document.getElementById('btn-cancelar-audio').style.display = 'inline-flex';
  document.getElementById('audio-log').textContent = '';

  const authH = () => (window.AUTH_TOKEN ? { 'Authorization': 'Bearer ' + window.AUTH_TOKEN } : {});
  const pctAtual = () => parseInt(document.getElementById('audio-progress-bar').style.width) || 5;
  // Retry SÓ em falha rápida/transitória (rede, 5xx imediato). NUNCA em timeout de etapa
  // nem em cancelamento — re-subir cego um arquivo grande que estourou o tempo é o que
  // não pode acontecer. Upload e transcrição são grátis, então o retry ali é seguro.
  async function comRetry(fn, label) {
    let ultimo;
    for (let n = 1; n <= 3; n++) { // 1 tentativa + 2 retries
      if (sig.aborted) throw new Error('Cancelado');
      try { return await fn(); }
      catch (e) {
        if (e.message === 'Cancelado' || e.name === 'AbortError' || e.__timeout) throw e;
        ultimo = e;
        if (n < 3) { setAudioProgress(pctAtual(), label + ' falhou, tentando de novo (' + (n + 1) + '/3)...', String(e.message || e)); await new Promise(r => setTimeout(r, 1500 * n)); }
      }
    }
    throw ultimo;
  }

  try {
    // PASSO 0: comprime se for grande (senão sobe o original sem tocar)
    const comp = await comprimirAudioSeGrande(file, sig);
    const arquivo = comp.file;
    const tamMB = (arquivo.size / 1048576).toFixed(1);

    // PASSO 1: upload (retry só em falha rápida; timeout de etapa de 6 min)
    setAudioProgress(comp.comprimido ? 18 : 5, 'Enviando arquivo (' + tamMB + 'MB)...', comp.comprimido ? 'Enviando versão otimizada...' : 'Conectando ao AssemblyAI...');
    const upload_url = await comRetry(async () => {
      const r = await fetchComTimeout(AAI_UPLOAD_URL, { method: 'POST', headers: authH(), body: arquivo }, 6 * 60 * 1000, sig);
      if (!r.ok) throw new Error('Falha no upload: HTTP ' + r.status);
      const j = await r.json();
      if (!j.upload_url) throw new Error('upload não retornou URL');
      return j.upload_url;
    }, 'Upload');
    setAudioProgress(30, 'Arquivo enviado! Iniciando transcrição...', 'Upload concluído ✓');

    // PASSO 2: inicia transcrição (retry só em falha rápida; timeout 30s)
    const id = await comRetry(async () => {
      const r = await fetchComTimeout(AAI_TRANSCRIPT_URL, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, authH()),
        body: JSON.stringify({
          audio_url: upload_url,
          // universal-3-5-pro com fallback universal-2. keyterms_prompt e prompt são
          // mutuamente exclusivos; language_detection é exclusivo com language_code.
          speech_models: ['universal-3-5-pro', 'universal-2'],
          language_detection: true,
          speaker_labels: true,
          keyterms_prompt: [
            'síndico', 'subsíndico', 'conselho fiscal', 'quórum', 'fundo de reserva',
            'convenção', 'regimento interno', 'taxa condominial', 'rateio',
            'prestação de contas', 'inadimplência', 'assembleia geral ordinária',
            'assembleia geral extraordinária', 'previsão orçamentária', 'ata'
          ],
          punctuate: true, format_text: true, disfluencies: false
        })
      }, 30 * 1000, sig);
      if (!r.ok) throw new Error('Falha ao iniciar transcrição: HTTP ' + r.status);
      const j = await r.json();
      if (!j.id) throw new Error('transcrição não retornou ID');
      return j.id;
    }, 'Início da transcrição');
    setAudioProgress(35, 'Transcrevendo... (pode levar alguns minutos)', 'ID: ' + id);

    // PASSO 3: poll até concluir. Timeout global de 25 min; erros transitórios de poll
    // só re-consultam (não derrubam). Ao concluir/errar/estourar, para o intervalo.
    const prazo = Date.now() + 25 * 60 * 1000;
    let progresso = 35;
    const texto = await new Promise((resolve, reject) => {
      pollTimer = setInterval(async () => {
        if (sig.aborted) { clearInterval(pollTimer); pollTimer = null; reject(new Error('Cancelado')); return; }
        if (Date.now() > prazo) { clearInterval(pollTimer); pollTimer = null; const e = new Error('a transcrição excedeu 25 min'); e.__timeout = true; reject(e); return; }
        try {
          const r = await fetchComTimeout(AAI_POLL_BASE + id, { headers: authH() }, 20 * 1000, sig);
          const result = await r.json();
          if (result.status === 'completed') { clearInterval(pollTimer); pollTimer = null; resolve(result.text || ''); }
          else if (result.status === 'error') { clearInterval(pollTimer); pollTimer = null; reject(new Error(result.error || 'erro na transcrição')); }
          else { progresso = Math.min(progresso + 2, 92); setAudioProgress(progresso, 'Transcrevendo... (' + result.status + ')', 'Aguardando AssemblyAI...'); }
        } catch (e) { if (e.name !== 'AbortError' && !e.__timeout) console.warn('poll transitório, reconsulta:', e.message); }
      }, 3000);
    });

    setAudioProgress(100, 'Transcrição concluída!', texto.slice(0, 200) + '...');
    document.getElementById('ata-transcricao').value = texto;
    document.getElementById('btn-cancelar-audio').style.display = 'none';
    toast('Transcrição concluída! ' + texto.length + ' caracteres' + (comp.comprimido ? ' (áudio otimizado)' : ''), 'ok');

  } catch (e) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (e.name === 'AbortError' || e.message === 'Cancelado') return; // cancelamento: silencioso
    // Erro SEMPRE visível: mensagem clara na tela + toast, e o botão volta ao normal.
    const msg = e.__timeout ? 'Tempo esgotado nesta etapa. Tente novamente.' : (e.message || 'erro');
    setAudioProgress(0, 'Erro: ' + msg, '');
    document.getElementById('audio-log').innerHTML = '<span style="color:var(--danger)">' + msg + '</span>';
    document.getElementById('btn-cancelar-audio').style.display = 'none';
    toast('Erro na transcrição: ' + msg, 'err');
  }
}

function abrirPastaTranscricoes() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt';
  input.onchange = importarTranscricao;
  input.click();
}

function importarTranscricao(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('ata-transcricao').value = e.target.result;
    document.getElementById('ata-file-info').textContent = '✓ ' + file.name + ' (' + Math.round(file.size/1024) + ' KB)';
    toast('Transcrição importada: ' + file.name, 'ok');
  };
  reader.readAsText(file, 'UTF-8');
}

// ============================================================
// ATAS CONDOMINIAIS
// ============================================================
let pautaCount = 1;

function addPauta() {
  pautaCount++;
  const div = document.createElement('div');
  div.className = 'pauta-item';
  div.style.cssText = 'flex-wrap:wrap;gap:6px;align-items:flex-start';
  div.innerHTML = `<input type="text" placeholder="Item de pauta ${pautaCount}" autocomplete="off" name="pauta-${pautaCount}-titulo"
    style="flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px 14px;color:var(--text);font-family:var(--mono);font-size:13px;outline:none">
    <label style="display:inline-flex;align-items:center;gap:5px;padding:8px 11px;background:var(--bg3);border:1px dashed var(--border2);border-radius:8px;cursor:pointer;font-size:11px;font-family:var(--mono);color:var(--muted);white-space:nowrap;transition:all 0.15s" title="Anexar PDF">
      📎 PDF
      <input type="file" accept="application/pdf" style="display:none" onchange="anexarPdfPauta(this)">
    </label>
    <span class="pauta-pdf-nome" style="font-size:10px;font-family:var(--mono);color:var(--gs-blue);display:none;align-self:center"></span>
    <button class="pauta-remove" onclick="removePauta(this)">×</button>`;
  document.getElementById('pauta-list').appendChild(div);
}

function removePauta(btn) {
  const items = document.querySelectorAll('.pauta-item');
  if (items.length <= 1) { toast('Deve haver pelo menos um item de pauta', 'warn'); return; }
  btn.closest('.pauta-item').remove();
}

async function extrairTextoPdf(arrayBuffer) {
  // Reusa o loader unico de pdf.js (mesma versao e CDN), com dedupe de chamadas
  // concorrentes e limpeza em caso de falha.
  const pdfjsLib = await carregarPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let texto = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    texto += content.items.map(it => it.str).join(' ') + '\n';
  }
  return texto.trim();
}

function anexarPdfPauta(input) {
  const file = input.files[0];
  if (!file) return;
  const item = input.closest('.pauta-item');
  const nomeEl = item.querySelector('.pauta-pdf-nome');
  const label = input.closest('label');

  const reader = new FileReader();
  reader.onload = async function(e) {
    nomeEl.textContent = 'Lendo PDF...';
    nomeEl.style.display = 'inline';
    if (label) {
      label.style.borderColor = 'var(--gs-blue)';
      label.style.color = 'var(--gs-blue)';
    }
    try {
      // Extrai texto do PDF no browser com pdf.js: sem IA
      const textoPdf = await extrairTextoPdf(e.target.result);
      input.dataset.pdfTexto = textoPdf;
      nomeEl.textContent = '📎 ' + file.name;
      nomeEl.title = textoPdf.slice(0, 300);
      toast('PDF lido: ' + file.name + ' (' + textoPdf.length + ' caracteres)', 'ok');
    } catch(err) {
      input.dataset.pdfTexto = '[Falha ao ler PDF: ' + file.name + ']';
      nomeEl.textContent = '📎 ' + file.name;
      toast('PDF anexado (texto não extraído): ' + file.name, 'warn');
    }
  };
  reader.readAsArrayBuffer(file);
}

// ============================================================
// DOCUMENTOS DA ASSEMBLEIA (T01) — PDFs de apoio da ata
// ============================================================
// Cada PDF tem o texto extraído aqui no navegador (pdf.js, sem custo). PDF escaneado (sem
// camada de texto) vai em base64 e o servidor lê com o Claude. O servidor trata o texto destes
// documentos como fonte oficial prioritária de números, empresas e nomes (ver server.js,
// REGRAS_DOCUMENTOS_APOIO). Limites espelham os do servidor.
const ATA_DOCS_MAX = 6;
const ATA_DOCS_MAX_ESCANEADOS = 3;
const ATA_DOCS_MAX_BYTES_ESCANEADO = 8 * 1024 * 1024;
const ATA_DOCS_MAX_CHARS_DOC = 80000;          // igual ao servidor (DOCS_APOIO_MAX_CHARS_DOC)
const ATA_DOCS_MAX_CORPO = 34 * 1024 * 1024;   // abaixo do limite de 36mb da rota
let _ataDocsApoio = []; // { id, nome, texto, pdfBase64, paginas, status }
let _ataDocsSeq = 0;
let _ataDocsLendo = false; // uma leitura por vez: evita passar do limite de escaneados

// Lê um PDF: texto por página e número de páginas. Usa o mesmo loader do pdf.js.
async function _ataDocLerPdf(arrayBuffer) {
  const pdfjsLib = await carregarPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let texto = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    texto += '[página ' + i + '] ' + content.items.map(it => it.str).join(' ') + '\n';
  }
  return { texto: texto.trim(), paginas: pdf.numPages };
}

function _ataDocBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const v = String(r.result || ''); const i = v.indexOf(','); resolve(i >= 0 ? v.slice(i + 1) : v); };
    r.onerror = () => reject(new Error('falha ao ler arquivo'));
    r.readAsDataURL(file);
  });
}

async function anexarDocsAssembleia(event) {
  const input = event && event.target;
  const files = Array.from((input && input.files) || []);
  if (input) input.value = '';
  if (_ataDocsLendo) { toast('Aguarde terminar a leitura dos documentos anteriores', 'warn'); return; }
  _ataDocsLendo = true;
  try {
  for (const file of files) {
    if (_ataDocsApoio.length >= ATA_DOCS_MAX) { toast('No máximo ' + ATA_DOCS_MAX + ' documentos por ata', 'warn'); break; }
    const ehPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (!ehPdf) { toast(file.name + ': use PDF', 'err'); continue; }
    const doc = { id: ++_ataDocsSeq, nome: file.name, texto: '', pdfBase64: '', paginas: 0, status: 'lendo' };
    _ataDocsApoio.push(doc);
    renderAtaDocs();
    try {
      const lido = await _ataDocLerPdf(await file.arrayBuffer());
      doc.paginas = lido.paginas;
      const util = lido.texto.replace(/\[página \d+\]/g, '').replace(/\s+/g, '');
      // Escaneado: quase nenhum texto por página. Vai como PDF para o servidor ler.
      if (util.length < 80 * Math.max(1, lido.paginas)) {
        const escaneados = _ataDocsApoio.filter(d => d.pdfBase64).length;
        if (escaneados >= ATA_DOCS_MAX_ESCANEADOS) throw new Error('no máximo ' + ATA_DOCS_MAX_ESCANEADOS + ' PDFs escaneados por ata');
        if (file.size > ATA_DOCS_MAX_BYTES_ESCANEADO) throw new Error('PDF escaneado acima de 8MB');
        doc.pdfBase64 = await _ataDocBase64(file);
        doc.texto = '';
        doc.status = 'escaneado';
      } else {
        doc.texto = lido.texto.slice(0, ATA_DOCS_MAX_CHARS_DOC);
        doc.status = 'ok';
        if (lido.texto.length > ATA_DOCS_MAX_CHARS_DOC) toast(file.name + ': documento longo, só o início será usado', 'warn');
      }
    } catch (e) {
      _ataDocsApoio = _ataDocsApoio.filter(d => d.id !== doc.id);
      toast(file.name + ': ' + (e && e.message ? e.message : 'não foi possível ler o PDF'), 'err');
    }
    renderAtaDocs();
  }
  } finally { _ataDocsLendo = false; }
}

function removerDocAssembleia(id) {
  _ataDocsApoio = _ataDocsApoio.filter(d => d.id !== id);
  renderAtaDocs();
}

function renderAtaDocs() {
  const lista = document.getElementById('ata-docs-lista');
  if (!lista) return;
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  lista.innerHTML = _ataDocsApoio.map(d => {
    let info = 'lendo...';
    if (d.status === 'ok') info = d.paginas + ' pág. · ' + d.texto.length.toLocaleString('pt-BR') + ' caracteres';
    if (d.status === 'escaneado') info = d.paginas + ' pág. · escaneado, será lido no servidor ao gerar';
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px">' +
      '<span style="flex:1;font-size:12px;font-family:var(--mono);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📄 ' + esc(d.nome) + '</span>' +
      '<span style="font-size:11px;font-family:var(--mono);color:' + (d.status === 'escaneado' ? 'var(--warning)' : 'var(--muted)') + '">' + esc(info) + '</span>' +
      '<button class="pauta-remove" title="Remover" onclick="removerDocAssembleia(' + d.id + ')">×</button></div>';
  }).join('');
}

// ============================================================
// EDITAL AUTOPREENCHE — IA lê PDF/imagem e preenche os 5 campos
// ============================================================

const EDITAL_MAX_BYTES = 8 * 1024 * 1024; // 8MB — limite seguro para Anthropic
const EDITAL_SYSTEM_PROMPT = [
  'Voce e um extrator de dados de editais condominiais brasileiros.',
  'O usuario vai te entregar um edital de convocacao (PDF ou imagem).',
  'Sua tarefa: extrair os 5 campos da reuniao em JSON puro, sem markdown, sem cercas, sem comentarios.',
  '',
  'Estrutura EXATA do JSON:',
  '{',
  '  "condominio": string | null,',
  '  "data": string | null,',
  '  "tipo": "AGO" | "AGE" | "Reuniao de Diretoria" | "Reuniao de Moradores" | null,',
  '  "sindico": string | null,',
  '  "local": string | null',
  '}',
  '',
  'Regras invioláveis:',
  '- Use null se o campo nao aparecer claramente no edital. NUNCA invente.',
  '- AGO = Assembleia Geral Ordinaria; AGE = Assembleia Geral Extraordinaria.',
  '- Data sempre no formato DD/MM/AAAA. Use a data da REUNIAO (nao a data da convocacao).',
  '- Se a data estiver por extenso ("01 de abril de 2026"), converta pra 01/04/2026.',
  '- Sindico: extraia somente se mencionado explicitamente como sindico (nao confunda com presidente da mesa).',
  '- Local: extraia o local da reuniao como aparece (ex: "Salao de Festas", "presencial e remoto via Zoom").',
  '- Condominio: extraia o nome oficial como aparece (sem aspas).',
].join('\n');

// Texto do edital anexado pelo dropzone "autopreencher", extraído por pdf.js (client side,
// grátis). Alimenta o bloco EDITAIS ANEXADOS da geração (ver gerarAtaIA). Sem isso o edital do
// dropzone nunca chegava ao prompt e o cabeçalho saía [a confirmar] (bug de transporte H1).
let _editalDropzoneTexto = '';
let _editalDropzoneNome = '';

async function anexarEdital(event) {
  const file = (event && event.target && event.target.files && event.target.files[0]) || null;
  if (!file) return;
  await processarEditalFile(file);
  // Limpa o input pra permitir reanexar o mesmo arquivo
  event.target.value = '';
}

function editalDragOver(e) {
  e.preventDefault();
  e.currentTarget.style.borderColor = 'var(--gs-blue)';
  e.currentTarget.style.background = 'var(--gs-blue-light)';
}
function editalDragLeave(e) {
  e.currentTarget.style.borderColor = '';
  e.currentTarget.style.background = 'var(--bg3)';
}
async function editalDrop(e) {
  e.preventDefault();
  editalDragLeave(e);
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  await processarEditalFile(file);
}

async function processarEditalFile(file) {
  const status = document.getElementById('edital-status');
  const progressWrap = document.getElementById('edital-progress-wrap');
  const progressBar = document.getElementById('edital-progress-bar');

  // Zera SEMPRE no topo, antes de qualquer validação ou return cedo: isolamento entre
  // condomínios. Sem isso, se o Haiku falhar ao processar um edital novo, o texto do edital
  // ANTERIOR (de outro condomínio) sobrevivia nas globais e podia vazar para a ata deste. Uma
  // reanexação que falha perde de propósito o edital anterior, para nunca contaminar em silêncio.
  _editalDropzoneTexto = '';
  _editalDropzoneNome = '';

  // Validacoes basicas
  const accepted = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  if (!accepted.includes(file.type)) {
    status.textContent = 'Formato nao suportado. Use PDF, PNG, JPG ou WEBP.';
    status.style.color = 'var(--danger)';
    return;
  }
  if (file.size > EDITAL_MAX_BYTES) {
    status.textContent = `Arquivo muito grande (${(file.size/1024/1024).toFixed(1)}MB). Limite 8MB.`;
    status.style.color = 'var(--danger)';
    return;
  }

  status.textContent = `Lendo ${file.name}...`;
  status.style.color = 'var(--gs-blue)';
  progressWrap.style.display = 'block';
  progressBar.style.width = '20%';

  try {
    // Le como base64
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const result = r.result || '';
        const idx = result.indexOf(',');
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      r.onerror = () => reject(new Error('Falha ao ler arquivo'));
      r.readAsDataURL(file);
    });
    progressBar.style.width = '45%';
    status.textContent = 'Extraindo dados via IA...';

    // Monta content block conforme tipo
    const isPdf = file.type === 'application/pdf';
    const docBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image',    source: { type: 'base64', media_type: file.type, data: base64 } };

    const payload = {
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system: EDITAL_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          docBlock,
          { type: 'text', text: 'Extraia os 5 campos do edital acima em JSON puro, conforme as regras do sistema.' }
        ]
      }]
    };

    const resp = await apiAuthFetch('/api/claude/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    progressBar.style.width = '85%';

    if (!resp.ok) {
      const erro = await resp.text();
      throw new Error('IA retornou ' + resp.status + ': ' + erro.slice(0, 200));
    }
    const data = await resp.json();
    const texto = data.content && data.content[0] && data.content[0].text ? data.content[0].text : '';
    if (!texto) throw new Error('IA nao retornou texto');

    // Parse JSON (tolerar cercas ```json se modelo escapar a regra)
    let json;
    try {
      const limpo = texto.replace(/```(?:json)?\s*|\s*```/g, '').trim();
      json = JSON.parse(limpo);
    } catch (e) {
      throw new Error('IA nao retornou JSON valido. Texto: ' + texto.slice(0, 200));
    }

    aplicarCamposExtraidos(json);
    // TRANSPORTE (H1): além de autopreencher via Haiku, extrai o TEXTO do edital com pdf.js
    // (client side, zero API, zero latência de servidor) e guarda pra alimentar o bloco EDITAIS
    // ANEXADOS da geração. É o conserto do bug em que o edital do dropzone nunca chegava ao
    // prompt. Só PDF: imagem segue só no autopreencher (não há texto a extrair pra geração).
    if (isPdf) {
      try { _editalDropzoneTexto = await extrairTextoPdf(await file.arrayBuffer()); _editalDropzoneNome = file.name; }
      catch (ePdf) { _editalDropzoneTexto = ''; _editalDropzoneNome = ''; }
    } else { _editalDropzoneTexto = ''; _editalDropzoneNome = ''; }
    progressBar.style.width = '100%';
    const n = ['condominio','data','tipo','sindico','local'].filter(k => json[k]).length;
    // CORREÇÃO (2026-07-09): se for PDF e a extração de texto (pdf.js) falhou por dentro, o
    // autopreenchimento dos 5 campos ainda deu certo, mas o TEXTO que alimenta a geração da ata
    // ficou vazio. Sem este aviso a UI mostrava sucesso pleno e reintroduzia o bug H1 em silêncio
    // (cabeçalho da ata podendo sair incompleto sem nenhum sinal pro usuário). Imagem não avisa
    // porque não extrai texto para geração por desenho (não é falha, é o comportamento esperado).
    if (isPdf && !_editalDropzoneTexto) {
      status.textContent = `⚠ ${n}/5 campos preenchidos, mas o texto do edital não foi lido para a geração. O cabeçalho pode sair incompleto. Reanexe o PDF.`;
      status.style.color = 'var(--warning)';
      toast('Campos preenchidos, mas texto do edital não lido. Reanexe o PDF.', 'warn');
    } else {
      status.textContent = `✓ ${n}/5 campos preenchidos. Revise antes de prosseguir.`;
      status.style.color = 'var(--success)';
      toast(`Edital lido: ${n}/5 campos preenchidos`, 'ok');
    }
    setTimeout(() => { progressWrap.style.display = 'none'; }, 1500);
  } catch (e) {
    status.textContent = '✕ ' + (e.message || 'Falha ao processar edital');
    status.style.color = 'var(--danger)';
    progressWrap.style.display = 'none';
    toast('Falha ao ler edital', 'err');
  }
}

function aplicarCamposExtraidos(json) {
  // Sobrescreve campos com o que a IA achou. User edita se errar.
  const tipos = { 'AGO': 'AGO', 'AGE': 'AGE', 'Reuniao de Diretoria': 'Reunião de Diretoria', 'Reuniao de Moradores': 'Reunião de Moradores' };
  if (json.condominio) document.getElementById('ata-cond').value = String(json.condominio);
  if (json.data) document.getElementById('ata-data').value = String(json.data);
  if (json.tipo && tipos[json.tipo]) document.getElementById('ata-tipo').value = tipos[json.tipo];
  if (json.sindico) document.getElementById('ata-sindico').value = String(json.sindico);
  if (json.local) document.getElementById('ata-local').value = String(json.local);
}

function limparAta() {
  document.getElementById('ata-cond').value = '';
  document.getElementById('ata-data').value = '';
  document.getElementById('ata-sindico').value = '';
  document.getElementById('ata-local').value = '';
  document.getElementById('ata-transcricao').value = '';
  document.getElementById('ata-participantes').value = '';
  // Reset uploader edital
  _editalDropzoneTexto = ''; _editalDropzoneNome = '';
  // Reset documentos da assembleia (T01): nunca levar PDF de uma ata para outra.
  _ataDocsApoio = []; renderAtaDocs();
  const editalStatus = document.getElementById('edital-status');
  if (editalStatus) { editalStatus.textContent = ''; editalStatus.style.color = ''; }
  const editalProgress = document.getElementById('edital-progress-wrap');
  if (editalProgress) editalProgress.style.display = 'none';
  document.getElementById('pauta-list').innerHTML = `<div class="pauta-item" style="flex-wrap:wrap;gap:6px;align-items:flex-start">
    <input type="text" placeholder="ex: Aprovacao do balancete financeiro"
      style="flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px 14px;color:var(--text);font-family:var(--mono);font-size:13px;outline:none">
    <label style="display:inline-flex;align-items:center;gap:5px;padding:8px 11px;background:var(--bg3);border:1px dashed var(--border2);border-radius:8px;cursor:pointer;font-size:11px;font-family:var(--mono);color:var(--muted);white-space:nowrap">
      📎 PDF
      <input type="file" accept="application/pdf" style="display:none" onchange="anexarPdfPauta(this)">
    </label>
    <span class="pauta-pdf-nome" style="font-size:10px;font-family:var(--mono);color:var(--gs-blue);display:none;align-self:center"></span>
    <button class="pauta-remove" onclick="removePauta(this)">×</button>
  </div>`;
}

// ============================================================
// GERAR ATA IA — engine v2 no backend
// ============================================================
// Frontend só monta o userMessage (transcrição + dados + edital) e POSTa em
// /api/atas/gerar. Backend faz: SKILL.md integral + contexto Grupo Service +
// regras anti-erro + Sonnet 4.6 → fallback Opus 4.7 + validação pós-geração.
// Ver server.js (app.post('/api/atas/gerar', ...)) e skills-server/ata-condominial.md.

let _ataTextoGerado = '';

async function gerarAtaIA() {
  const cond    = document.getElementById('ata-cond').value.trim();
  const data    = document.getElementById('ata-data').value.trim();
  const tipo    = document.getElementById('ata-tipo').value;
  const sindico = document.getElementById('ata-sindico').value.trim();
  const local   = document.getElementById('ata-local').value.trim();
  const trans   = document.getElementById('ata-transcricao').value.trim();
  const partic  = document.getElementById('ata-participantes').value.trim();

  if (!trans) { toast('Cole ou importe a transcrição antes de gerar', 'err'); return; }
  if (!cond)  { toast('Informe o nome do condomínio', 'err'); return; }
  if (!data)  { toast('Informe a data da reunião', 'err'); return; }
  if (_ataDocsApoio.some(d => d.status === 'lendo')) { toast('Aguarde terminar a leitura dos documentos da assembleia', 'warn'); return; }

  // Coleta itens de pauta (mesma lógica do fallback copiarProClaude)
  const pautaItems = document.querySelectorAll('#pauta-list .pauta-item');
  const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  let dataExtenso = data;
  const mData = data.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mData) {
    const d = parseInt(mData[1], 10);
    const m = parseInt(mData[2], 10);
    const y = mData[3];
    if (m >= 1 && m <= 12) dataExtenso = `${String(d).padStart(2,'0')} de ${meses[m-1]} de ${y}`;
  }
  const pautasSemEdital = [];
  const editaisAnexos = [];
  Array.from(pautaItems).forEach((item, i) => {
    const texto = item.querySelector('input[type=text]')?.value?.trim() || '';
    const pdfInput = item.querySelector('input[type=file]');
    const pdfTexto = pdfInput?.dataset?.pdfTexto || '';
    const pdfNome = pdfInput?.files?.[0]?.name || '';
    if (!texto && !pdfTexto) return;
    if (pdfTexto) {
      editaisAnexos.push({ n: i+1, titulo: texto || '(sem título)', arquivo: pdfNome, texto: pdfTexto });
    } else {
      pautasSemEdital.push(`${i+1}. ${texto}`);
    }
  });
  // TRANSPORTE (H1): inclui na geração o edital anexado pelo dropzone "autopreencher". Antes só
  // itens de pauta alimentavam o prompt, então o edital do dropzone não chegava e o cabeçalho
  // saía [a confirmar]. Dedupe por texto pra não duplicar se o mesmo edital também virou item de pauta.
  if (_editalDropzoneTexto && !editaisAnexos.some(e => e.texto === _editalDropzoneTexto)) {
    editaisAnexos.push({ n: editaisAnexos.length + 1, titulo: '(edital de convocação)', arquivo: _editalDropzoneNome, texto: _editalDropzoneTexto });
  }
  let blocoEditais = '';
  if (editaisAnexos.length) {
    blocoEditais = '\n=== EDITAIS / DOCUMENTOS ANEXADOS ===\n' +
      '(Use o edital como fonte oficial dos pontos que DEVERIAM ser deliberados — a transcrição mostra o que DE FATO foi discutido. Cruze: edital + transcrição confirmando → registre com precisão; números/datas/valores do edital prevalecem como oficiais; transcrição contradiz edital → registre o efetivamente deliberado.)\n\n' +
      editaisAnexos.map(e => `--- ${e.n}. ${e.titulo}${e.arquivo ? ' [arquivo: ' + e.arquivo + ']' : ''} ---\n${e.texto}`).join('\n\n') + '\n';
  }

  const userMessage = [
    '=== DADOS DA REUNIÃO ===',
    `Condomínio: ${cond}`,
    `Tipo: ${tipo}`,
    `Data: ${data}${dataExtenso !== data ? ' (' + dataExtenso + ')' : ''}`,
    `Síndico: ${sindico || '[a confirmar]'}`,
    `Local: ${local || '[a confirmar]'}`,
    '',
    '=== ITENS DE PAUTA ===',
    pautasSemEdital.length ? pautasSemEdital.join('\n') : '(extrair da transcrição e/ou dos editais anexados abaixo)',
    blocoEditais,
    '=== PARTICIPANTES ===',
    partic || '(extrair da transcrição; se não identificáveis, use [a confirmar])',
    '',
    '=== TRANSCRIÇÃO COMPLETA DA REUNIÃO ===',
    trans,
    '',
    'Gere a ata completa seguindo todas as regras e estrutura do sistema. Use [a confirmar] em qualquer dado ausente.'
  ].join('\n');

  // UI: loading state com contador ao vivo. O botão mostra os segundos correndo
  // (ticker local de 1s) pra deixar claro que está gerando e não travou.
  const btn = document.getElementById('btn-gerar-ata');
  const btnTextoOriginal = btn.textContent;
  btn.disabled = true;
  const geracaoT0 = Date.now();
  btn.textContent = '⏳ Gerando ata... 0s';
  const progTimer = setInterval(() => {
    const seg = Math.round((Date.now() - geracaoT0) / 1000);
    btn.textContent = `⏳ Gerando ata... ${seg}s`;
  }, 1000);
  toast('Gerando ata... pode levar até 1 minuto', 'info');

  try {
    // Geração ASSÍNCRONA (job + polling). Antes era uma requisição longa única, mas
    // o edge do Railway bufferiza o corpo da resposta e o Safari derrubava a conexão
    // ociosa ("Load failed") antes de a ata ficar pronta. Agora: o POST dispara a
    // geração no servidor e volta na hora com um jobId; consultamos o status a cada
    // 4s até 'done'/'error'. Cada request é curto, imune a timeout de borda e a idle
    // do navegador. O backend monta o system prompt e faz retry Sonnet → Opus com
    // validação pós-geração; o payload final ({ ata, modelo_usado, ... }) é o mesmo.
    const corpoAta = JSON.stringify({
        userMessage,
        // T01: documentos da assembleia. Texto extraído aqui; escaneado vai como PDF (base64).
        documentos: _ataDocsApoio.filter(d => d.status === 'ok' || d.status === 'escaneado').map(d => (
          d.pdfBase64 ? { nome: d.nome, texto: '', pdf_base64: d.pdfBase64 } : { nome: d.nome, texto: d.texto }
        ))
      });
    if (corpoAta.length > ATA_DOCS_MAX_CORPO) throw new Error('os documentos anexados passam do limite de tamanho; remova algum PDF escaneado');
    const resp = await apiAuthFetch('/api/atas/gerar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: corpoAta
    });
    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      throw new Error(errJson.detalhe || errJson.erro || ('HTTP ' + resp.status));
    }
    const inicio = await resp.json().catch(() => ({}));
    const jobId = inicio.jobId;
    if (!jobId) throw new Error('servidor não retornou o identificador da geração');

    // Polling curto até concluir. Teto de 25min como salvaguarda (uma ata de reunião
    // de 3h leva ~9-15 min de geração no motor fracionado; 10 min não dava margem e o
    // front desistia enquanto o job do servidor ainda completava — a ata era gerada mas
    // não resgatada, "gastava token sem entregar"). O job é assíncrono e limitado pelo
    // teto de 7 chamadas (MAX_CHAMADAS_ANTHROPIC_POR_ATA), então o custo já está travado
    // no servidor; este teto só existe pra não pendurar o front se o servidor morrer.
    // Cada consulta usa cache: 'no-store' (o navegador não guarda nem revalida com
    // If-None-Match, então nunca recebe 304 — que antes travava a leitura do resultado).
    // AbortController de 15s por consulta pra um request pendurado não travar o laço.
    let payload = null;
    let errosSeguidos = 0;
    const prazoMax = Date.now() + (_ataDocsApoio.some(d => d.pdfBase64) ? 35 : 25) * 60 * 1000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 4000));
      if (Date.now() > prazoMax) throw new Error('tempo esgotado, tente novamente');
      let st;
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 15000);
        try {
          st = await apiAuthFetch('/api/atas/gerar/status/' + encodeURIComponent(jobId), { signal: ac.signal, cache: 'no-store' });
        } finally { clearTimeout(to); }
      } catch (_) { continue; } // rede caiu/abortou: tenta de novo no próximo ciclo
      // Trata status HTTP fora do contrato do job, pra não mascarar de "timeout".
      if (st.status === 304) continue;                 // não modificado (defensivo): reconsulta
      if (st.status === 404) continue;                 // job ainda não visível ou processo reiniciou
      if (st.status === 429) { await new Promise((r) => setTimeout(r, 6000)); continue; } // rate limit: espera mais
      if (st.status === 401 || st.status === 403) throw new Error('sessão expirada — entre novamente e refaça');
      if (!st.ok) {                                     // 5xx/inesperado: tolera transitório, desiste após 3
        if (++errosSeguidos >= 3) throw new Error('erro no servidor ao consultar o status (HTTP ' + st.status + ')');
        continue;
      }
      errosSeguidos = 0;
      const body = await st.json().catch(() => ({}));
      if (body.status === 'processing') continue;
      if (body.status === 'error') throw new Error(body.detalhe || body.erro || ('HTTP ' + body.status));
      if (body.status === 'done') { payload = body; break; }
    }
    if (!payload) throw new Error('resposta incompleta do servidor');
    const texto = (payload.ata || '').trim();
    if (!texto) throw new Error('engine retornou ata vazia');

    _ataTextoGerado = texto;
    const escHtml = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    document.getElementById('ata-gerada-conteudo').innerHTML = renderAtaBlocos(texto, escHtml);
    document.getElementById('ata-gerada-modal').style.display = 'flex';
    // avisos não bloqueantes da validação (ex.: revisar assinaturas). A ata foi entregue.
    const avisos = Array.isArray(payload.avisos) ? payload.avisos.slice() : [];
    // T01: divergências áudio x documento e trechos sem âncora marcados na ata.
    if (payload.conferencia && payload.conferencia.divergencias > 0) {
      avisos.push(payload.conferencia.divergencias + ' ponto(s) em que o áudio divergiu dos documentos, marcados com [conferir: ...]');
    }
    if (payload.conferencia && payload.conferencia.valores_so_documento > 0) {
      avisos.push(payload.conferencia.valores_so_documento + ' valor(es) da ata vieram dos documentos sem aparecer em número na transcrição; confira se foram apresentados na reunião');
    }
    if (Array.isArray(payload.documentos)) {
      payload.documentos.filter(d => d.falhou).forEach(d => avisos.push('o documento ' + d.nome + ' não pôde ser lido e ficou fora'));
      payload.documentos.filter(d => d.truncado).forEach(d => avisos.push('o documento ' + d.nome + ' é muito longo e foi usado só em parte'));
    }
    if (payload.gate && Array.isArray(payload.gate.flags) && payload.gate.flags.length) {
      avisos.push(payload.gate.flags.length + ' trecho(s) sem apoio na transcrição nem nos documentos, marcados na ata para conferir');
    }
    addHistorico('Ata gerada via IA: ' + cond + ' · ' + data + (avisos.length ? ' (com avisos)' : ''));
    if (avisos.length) toast('Ata gerada. Pontos para revisar: ' + avisos.join('; '), 'warn');
    else toast('Ata gerada. Revise antes de baixar.', 'ok');
  } catch (e) {
    toast('Falha ao gerar ata: ' + (e.message || 'erro'), 'err');
  } finally {
    clearInterval(progTimer);
    btn.disabled = false;
    btn.textContent = btnTextoOriginal;
  }
}

function fecharAtaGerada() {
  document.getElementById('ata-gerada-modal').style.display = 'none';
}

async function copiarAtaTexto() {
  if (!_ataTextoGerado) { toast('Nada pra copiar', 'err'); return; }
  try {
    await navigator.clipboard.writeText(_ataTextoGerado);
    toast('Texto copiado pra área de transferência', 'ok');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = _ataTextoGerado;
    ta.style.cssText = 'position:fixed;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Texto copiado', 'ok'); }
    finally { ta.remove(); }
  }
}

// Helper compartilhado entre preview do modal e popup do PDF: quebra o texto
// da ata em blocos com alinhamento por tipo, espelhando o gabarito Ata 1:
//   - cabeçalho do condomínio + título "ATA DA ASSEMBLEIA..."  → centro
//   - parágrafo de abertura em prosa                            → justify
//   - cada ITEM N)                                              → justify + page-break-inside:avoid
//   - parágrafo "ENCERRAMENTO..."                               → justify
//   - linha "Cidade/UF, data."                                  → centro
//   - bloco de assinaturas (a partir do primeiro underscore)    → left
// Se nenhum ITEM for detectado, devolve fallback single-block justify.
function renderAtaBlocos(texto, escFn) {
  const reItem      = /^ITEM\s+\d+\)/;
  const reEnc       = /^ENCERRAMENTO\b/i;
  const reTituloATA = /^ATA DA ASSEMBLEIA/i;
  const reLocalData = /^[^/\n]+\/[A-Z]{2},\s*\d+\s+de\s+\S+\s+de\s+\d{4}\.?\s*$/i;
  const reUnderline = /^_{10,}\s*$/;

  const linhas = texto.split('\n');
  const cabCentro = [];
  const cabJust   = [];
  const items     = [];
  const encJust   = [];
  let encLocalData = '';
  const encAssin  = [];

  let modo = 'cabCentro';
  let buf = null;

  for (const ln of linhas) {
    if (modo === 'cabCentro') {
      cabCentro.push(ln);
      if (reTituloATA.test(ln)) modo = 'cabJust';
      continue;
    }
    if (modo === 'cabJust') {
      if (reItem.test(ln)) { modo = 'item'; buf = [ln]; continue; }
      cabJust.push(ln);
      continue;
    }
    if (modo === 'item') {
      if (reItem.test(ln)) { if (buf) items.push(buf); buf = [ln]; continue; }
      if (reEnc.test(ln))  { if (buf) { items.push(buf); buf = null; } modo = 'encJust'; encJust.push(ln); continue; }
      buf.push(ln);
      continue;
    }
    if (modo === 'encJust') {
      if (reLocalData.test(ln.trim())) { encLocalData = ln; modo = 'encAssin'; continue; }
      if (reUnderline.test(ln.trim())) { modo = 'encAssin'; encAssin.push(ln); continue; }
      encJust.push(ln);
      continue;
    }
    encAssin.push(ln);
  }
  if (buf) items.push(buf);

  if (items.length === 0) return `<div class="ata-bloco">${escFn(texto)}</div>`;

  const parts = [];
  if (cabCentro.length)  parts.push(`<div class="ata-bloco centro">${escFn(cabCentro.join('\n'))}</div>`);
  if (cabJust.length)    parts.push(`<div class="ata-bloco">${escFn(cabJust.join('\n'))}</div>`);
  for (const it of items) {
    // Regra permanente: rótulo do item + título em caixa alta, até os dois pontos
    // (inclusive), saem em negrito. O texto corrido após os dois pontos volta ao
    // peso normal. Se não houver dois pontos, o negrito fica só na 1ª linha (ITEM n).
    const itemTexto = it.join('\n');
    const idxDoisPontos = itemTexto.indexOf(':');
    let interno;
    if (idxDoisPontos !== -1) {
      interno = `<strong>${escFn(itemTexto.slice(0, idxDoisPontos + 1))}</strong>${escFn(itemTexto.slice(idxDoisPontos + 1))}`;
    } else {
      const qNL = itemTexto.indexOf('\n');
      interno = qNL !== -1
        ? `<strong>${escFn(itemTexto.slice(0, qNL))}</strong>${escFn(itemTexto.slice(qNL))}`
        : `<strong>${escFn(itemTexto)}</strong>`;
    }
    parts.push(`<div class="ata-bloco item">${interno}</div>`);
  }
  if (encJust.length)    parts.push(`<div class="ata-bloco">${escFn(encJust.join('\n'))}</div>`);
  if (encLocalData)      parts.push(`<div class="ata-bloco centro">${escFn(encLocalData)}</div>`);
  if (encAssin.length)   parts.push(`<div class="ata-bloco assin">${escFn(encAssin.join('\n'))}</div>`);
  return parts.join('');
}

// Monta o PDF da ata por codigo (jsPDF), com texto REAL selecionavel. Como nao usa
// window.print(), nenhum navegador injeta cabecalho/rodape nativo: sai igual no
// Safari e no Chrome, sem data nem URL. Numeracao "Pagina X de Y", margens e negrito
// dos itens sao desenhados por nos. Fonte Arimo (=Liberation Sans, metricamente
// identica a Arial) TTF embutida (ata-fonte-arimo.js) com suporte pleno a UTF-8:
// acentos do portugues (física, órgão, três) sem corromper, diferente das fontes
// core do jsPDF que so cobrem WinAnsi.
function montarAtaPDF(jsPDF, texto) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  texto = String(texto).replace(/\r/g, '');

  const PW = doc.internal.pageSize.getWidth();   // ~595.28pt
  const PH = doc.internal.pageSize.getHeight();  // ~841.89pt
  const CM = 28.3465;                            // pt por cm
  const MARG_TOP = 2.54 * CM, MARG_BOT = 2.54 * CM, MARG_DIR = 2.54 * CM, MARG_ESQ = 3.17 * CM;
  const LARG = PW - MARG_ESQ - MARG_DIR;         // largura util do texto
  const LIMITE_Y = PH - MARG_BOT;                // conteudo nao passa daqui
  const FONTE = 'Arimo', TAM = 12, ALTURA_LINHA = TAM * 1.5;  // Arimo (=Liberation Sans, métrica de Arial) embutida em ata-fonte-arimo.js

  let y = MARG_TOP + TAM;                         // baseline da 1a linha

  function novaPaginaSeNecessario() {
    if (y > LIMITE_Y) { doc.addPage(); y = MARG_TOP + TAM; }
  }

  // Justifica uma linha distribuindo o espaco extra igualmente entre as palavras.
  function desenharJustificado(linha) {
    const palavras = linha.split(' ').filter(function (p) { return p.length; });
    if (palavras.length <= 1) { doc.text(linha, MARG_ESQ, y); return; }
    let larguraPalavras = 0;
    for (const p of palavras) larguraPalavras += doc.getTextWidth(p);
    const gap = (LARG - larguraPalavras) / (palavras.length - 1);
    let x = MARG_ESQ;
    for (let i = 0; i < palavras.length; i++) {
      doc.text(palavras[i], x, y);
      x += doc.getTextWidth(palavras[i]) + gap;
    }
  }

  // Escreve um paragrafo com quebra automatica de linha e de pagina.
  // align: 'left' | 'center' | 'justify' (justifica todas as linhas menos a ultima).
  function paragrafo(txt, align, bold) {
    doc.setFont(FONTE, bold ? 'bold' : 'normal');
    doc.setFontSize(TAM);
    // Cada quebra real (\n) é um parágrafo lógico próprio, então a ÚLTIMA linha de
    // cada parágrafo nunca é justificada (senão fica com espaços gigantes de borda
    // a borda). Só as linhas do meio de cada parágrafo são justificadas.
    const paragrafos = String(txt).split('\n');
    for (const par of paragrafos) {
      const linhas = doc.splitTextToSize(par, LARG);
      for (let i = 0; i < linhas.length; i++) {
        novaPaginaSeNecessario();
        const linha = linhas[i];
        const ultima = (i === linhas.length - 1);
        if (align === 'center') {
          doc.text(linha, MARG_ESQ + LARG / 2, y, { align: 'center' });
        } else if (align === 'justify' && !ultima && linha.indexOf(' ') !== -1) {
          desenharJustificado(linha);
        } else {
          doc.text(linha, MARG_ESQ, y);
        }
        y += ALTURA_LINHA;
      }
    }
  }

  // Segmentacao identica a do renderAtaBlocos (usado no preview): cabecalho
  // centralizado, abertura justificada, itens (titulo negrito + corpo normal),
  // encerramento justificado, local/data centralizado e assinaturas a esquerda.
  const reItem = /^ITEM\s+\d+\)/;
  const reEnc = /^ENCERRAMENTO\b/i;
  const reTituloATA = /^ATA DA ASSEMBLEIA/i;
  const reLocalData = /^[^/\n]+\/[A-Z]{2},\s*\d+\s+de\s+\S+\s+de\s+\d{4}\.?\s*$/i;
  const reUnderline = /^_{10,}\s*$/;

  const linhas = texto.split('\n');
  const cabCentro = [], cabJust = [], items = [], encJust = [], encAssin = [];
  let encLocalData = '', modo = 'cabCentro', buf = null;
  for (const ln of linhas) {
    if (modo === 'cabCentro') { cabCentro.push(ln); if (reTituloATA.test(ln)) modo = 'cabJust'; continue; }
    if (modo === 'cabJust') { if (reItem.test(ln)) { modo = 'item'; buf = [ln]; continue; } cabJust.push(ln); continue; }
    if (modo === 'item') {
      if (reItem.test(ln)) { if (buf) items.push(buf); buf = [ln]; continue; }
      if (reEnc.test(ln)) { if (buf) { items.push(buf); buf = null; } modo = 'encJust'; encJust.push(ln); continue; }
      buf.push(ln); continue;
    }
    if (modo === 'encJust') {
      if (reLocalData.test(ln.trim())) { encLocalData = ln; modo = 'encAssin'; continue; }
      if (reUnderline.test(ln.trim())) { modo = 'encAssin'; encAssin.push(ln); continue; }
      encJust.push(ln); continue;
    }
    encAssin.push(ln);
  }
  if (buf) items.push(buf);

  if (items.length === 0) {
    paragrafo(texto, 'justify', false);
  } else {
    if (cabCentro.length) paragrafo(cabCentro.join('\n'), 'center', false);
    if (cabJust.length) paragrafo(cabJust.join('\n'), 'justify', false);
    for (const it of items) {
      const itemTexto = it.join('\n');
      const idx = itemTexto.indexOf(':');
      if (idx !== -1) {
        paragrafo(itemTexto.slice(0, idx + 1), 'justify', true);           // rotulo + titulo: negrito
        const resto = itemTexto.slice(idx + 1).replace(/^\s+/, '');
        if (resto) paragrafo(resto, 'justify', false);                      // corpo: peso normal
      } else {
        paragrafo(itemTexto, 'justify', true);
      }
    }
    if (encJust.length) paragrafo(encJust.join('\n'), 'justify', false);
    if (encLocalData) paragrafo(encLocalData, 'center', false);
    if (encAssin.length) paragrafo(encAssin.join('\n'), 'left', false);
  }

  // Rodape "Pagina X de Y" no centro da margem inferior de todas as paginas.
  const total = doc.getNumberOfPages();
  doc.setFont(FONTE, 'normal');
  doc.setFontSize(10);
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.text('Página ' + i + ' de ' + total, PW / 2, PH - MARG_BOT / 2, { align: 'center' });
  }
  return doc;
}

function baixarAtaPDF() {
  if (!_ataTextoGerado) { toast('Nada pra baixar', 'err'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    toast('Biblioteca de PDF nao carregou (verifique a conexao). Tente de novo ou use Baixar Word.', 'err');
    return;
  }
  try {
    const doc = montarAtaPDF(window.jspdf.jsPDF, _ataTextoGerado);
    // Nome do arquivo a partir dos campos do formulario (fallback "ata.pdf").
    const slug = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const cond = (document.getElementById('ata-cond') || {}).value || '';
    const data = (document.getElementById('ata-data') || {}).value || '';
    let nome = [slug(cond), slug(data)].filter(Boolean).join('_');
    nome = (nome ? 'Ata_' + nome : 'ata') + '.pdf';
    doc.save(nome);
    toast('✓ PDF gerado: ' + nome, 'ok');
  } catch (e) {
    toast('Erro ao gerar PDF: ' + (e && e.message ? e.message : e), 'err');
  }
}

// Gera a MESMA ata em .docx editável, em paralelo ao PDF (não altera baixarAtaPDF
// nem renderAtaBlocos). Parser próprio replica a segmentação em blocos do PDF.
// Formatação equivalente: Arial 12pt, line-height 1.5, A4, margens 2.54/3.17cm,
// cabeçalho e local/data centralizados, corpo e itens justificados (ITEM não
// corta entre páginas via keepLines), assinaturas à esquerda. Título SEM negrito.
function baixarAtaWord() {
  if (!_ataTextoGerado) { toast('Nada pra baixar', 'err'); return; }
  if (!window.docx || !window.docx.Document) {
    toast('Biblioteca Word não carregou (verifique a conexão). Use Baixar PDF.', 'err');
    return;
  }

  // Mesma lógica de blocos do renderAtaBlocos(), replicada aqui para não tocar nele.
  const reItem      = /^ITEM\s+\d+\)/;
  const reEnc       = /^ENCERRAMENTO\b/i;
  const reTituloATA = /^ATA DA ASSEMBLEIA/i;
  const reLocalData = /^[^/\n]+\/[A-Z]{2},\s*\d+\s+de\s+\S+\s+de\s+\d{4}\.?\s*$/i;
  const reUnderline = /^_{10,}\s*$/;

  const linhas = _ataTextoGerado.split('\n');
  const cabCentro = [], cabJust = [], items = [], encJust = [], encAssin = [];
  let encLocalData = '';
  let modo = 'cabCentro', buf = null;

  for (const ln of linhas) {
    if (modo === 'cabCentro') { cabCentro.push(ln); if (reTituloATA.test(ln)) modo = 'cabJust'; continue; }
    if (modo === 'cabJust')   { if (reItem.test(ln)) { modo = 'item'; buf = [ln]; continue; } cabJust.push(ln); continue; }
    if (modo === 'item') {
      if (reItem.test(ln)) { if (buf) items.push(buf); buf = [ln]; continue; }
      if (reEnc.test(ln))  { if (buf) { items.push(buf); buf = null; } modo = 'encJust'; encJust.push(ln); continue; }
      buf.push(ln); continue;
    }
    if (modo === 'encJust') {
      if (reLocalData.test(ln.trim())) { encLocalData = ln; modo = 'encAssin'; continue; }
      if (reUnderline.test(ln.trim())) { modo = 'encAssin'; encAssin.push(ln); continue; }
      encJust.push(ln); continue;
    }
    encAssin.push(ln);
  }
  if (buf) items.push(buf);

  const D = window.docx;
  const ALIGN = D.AlignmentType;

  // Texto multilinha -> UM parágrafo com quebras de linha reais (texto editável).
  // Arial 12pt = size 24 (half-points); line-height 1.5 = spacing.line 360.
  function paragrafo(texto, align, keepLines) {
    const linhasP = String(texto).split('\n');
    const runs = linhasP.map((l, i) => new D.TextRun(
      i === 0 ? { text: l, font: 'Arial', size: 24 }
              : { text: l, font: 'Arial', size: 24, break: 1 }
    ));
    return new D.Paragraph({
      alignment: align,
      spacing: { line: 360 },
      keepLines: !!keepLines,
      children: runs,
    });
  }

  const children = [];
  if (items.length === 0) {
    // Mesmo fallback do renderAtaBlocos: texto inteiro como um bloco justificado.
    children.push(paragrafo(_ataTextoGerado, ALIGN.JUSTIFIED, false));
  } else {
    if (cabCentro.length) children.push(paragrafo(cabCentro.join('\n'), ALIGN.CENTER, false));
    if (cabJust.length)   children.push(paragrafo(cabJust.join('\n'), ALIGN.JUSTIFIED, false));
    for (const it of items) children.push(paragrafo(it.join('\n'), ALIGN.JUSTIFIED, true));
    if (encJust.length)   children.push(paragrafo(encJust.join('\n'), ALIGN.JUSTIFIED, false));
    if (encLocalData)     children.push(paragrafo(encLocalData, ALIGN.CENTER, false));
    if (encAssin.length)  children.push(paragrafo(encAssin.join('\n'), ALIGN.LEFT, false));
  }

  // A4 em twips (11906x16838). Margens: 2.54cm=1440, 3.17cm=1797 (igual ao @page do PDF).
  const doc = new D.Document({
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1797 },
        },
      },
      children,
    }],
  });

  // Nome do arquivo a partir dos campos do formulário (fallback "ata.docx").
  const slug = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const cond = (document.getElementById('ata-cond') || {}).value || '';
  const data = (document.getElementById('ata-data') || {}).value || '';
  let nome = [slug(cond), slug(data)].filter(Boolean).join('_');
  nome = (nome ? 'Ata_' + nome : 'ata') + '.docx';

  D.Packer.toBlob(doc).then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('✓ Word (.docx) gerado: ' + nome, 'ok');
  }).catch((e) => {
    toast('Erro ao gerar Word: ' + (e && e.message ? e.message : e), 'err');
  });
}

async function copiarProClaude() {
  const cond    = document.getElementById('ata-cond').value.trim();
  const data    = document.getElementById('ata-data').value.trim();
  const tipo    = document.getElementById('ata-tipo').value;
  const sindico = document.getElementById('ata-sindico').value.trim();
  const local   = document.getElementById('ata-local').value.trim();
  const trans   = document.getElementById('ata-transcricao').value.trim();
  const partic  = document.getElementById('ata-participantes').value.trim();

  if (!trans) { toast('Cole ou importe a transcrição antes de copiar', 'err'); return; }
  if (!cond)  { toast('Informe o nome do condomínio', 'err'); return; }
  if (!data)  { toast('Informe a data da reunião', 'err'); return; }

  // Coleta itens de pauta (sem edital e com edital tratados separadamente abaixo)
  const pautaItems = document.querySelectorAll('#pauta-list .pauta-item');

  // Data por extenso (ex: "01 de abril de 2026")
  const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  let dataExtenso = data;
  const mData = data.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mData) {
    const d = parseInt(mData[1], 10);
    const m = parseInt(mData[2], 10);
    const y = mData[3];
    if (m >= 1 && m <= 12) {
      dataExtenso = `${String(d).padStart(2,'0')} de ${meses[m-1]} de ${y}`;
    }
  }

  // Separa itens de pauta SEM edital e COM edital (PDF anexado)
  const pautasSemEdital = [];
  const editaisAnexos = [];
  Array.from(pautaItems).forEach((item, i) => {
    const texto = item.querySelector('input[type=text]')?.value?.trim() || '';
    const pdfInput = item.querySelector('input[type=file]');
    const pdfTexto = pdfInput?.dataset?.pdfTexto || '';
    const pdfNome = pdfInput?.files?.[0]?.name || '';
    if (!texto && !pdfTexto) return;
    if (pdfTexto) {
      editaisAnexos.push({ n: i+1, titulo: texto || '(sem título)', arquivo: pdfNome, texto: pdfTexto });
    } else {
      pautasSemEdital.push(`${i+1}. ${texto}`);
    }
  });

  // Bloco de editais formatado
  let blocoEditais = '';
  if (editaisAnexos.length) {
    blocoEditais = '\n=== EDITAIS / DOCUMENTOS ANEXADOS ===\n' +
      '(Estes documentos foram anexados pelo síndico como referência formal. Use o edital como fonte oficial dos pontos que DEVERIAM ser deliberados — a transcrição mostra o que DE FATO foi discutido. Cruze as duas coisas: se o edital prevê um item e a transcrição confirma, registre com precisão; se o edital traz números, datas ou valores, use os do edital como fonte oficial; se a transcrição contradiz o edital, registre o que foi efetivamente deliberado.)\n\n' +
      editaisAnexos.map(e => `--- ${e.n}. ${e.titulo}${e.arquivo ? ' [arquivo: ' + e.arquivo + ']' : ''} ---\n${e.texto}`).join('\n\n') + '\n';
  }

  // Monta texto pro Claude
  const bloco = `Use a skill ata-condominial para gerar a ata no padrão formal brasileiro consolidado (Grupo Service / Condomínio Service).

=== DADOS DA REUNIÃO ===
Condomínio: ${cond}
Tipo: ${tipo}
Data: ${data}${dataExtenso !== data ? ' (' + dataExtenso + ')' : ''}
Síndico: ${sindico || '(não informado)'}
Local: ${local || '(não informado)'}

=== ITENS DE PAUTA ===
${pautasSemEdital.length ? pautasSemEdital.join('\n') : '(pauta detalhada abaixo nos editais anexados; se vazio, extrair da transcrição)'}
${blocoEditais}
=== PARTICIPANTES ===
${partic || '(extrair da transcrição)'}

=== TRANSCRIÇÃO COMPLETA DA REUNIÃO ===
${trans}

=== INSTRUÇÕES FINAIS ===
1. Gere a ata em formato formal brasileiro conforme a skill ata-condominial.
2. Entregue como arquivo .docx pronto pra imprimir (use a skill docx).
3. Para cada item de pauta, registre o que foi deliberado cruzando edital (quando houver) com transcrição.
4. Preserve nomes, cargos e valores citados exatamente como aparecem.
5. Atenção: se houver mais de uma pessoa com o mesmo primeiro nome (ex: síndico Sr. Paulo e morador Sr. Paulo), diferencie sempre pelo papel para evitar confusão.
6. Encerre com espaços de assinatura: Síndico, Representante(s) da prestadora (quando aplicável), Conselho, Moradores presentes.`;

  try {
    await navigator.clipboard.writeText(bloco);
    toast('✓ Copiado! Cole no Service Hub IA pra gerar a ata em .docx', 'ok');
    addHistorico('Ata copiada pro Service Hub IA: ' + cond + ' · ' + data);
  } catch(e) {
    // Fallback: textarea temporário
    const ta = document.createElement('textarea');
    ta.value = bloco;
    ta.style.cssText = 'position:fixed;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('✓ Copiado! Cole no Service Hub IA pra gerar a ata em .docx', 'ok');
      addHistorico('Ata copiada pro Service Hub IA: ' + cond + ' · ' + data);
    } catch(err) {
      toast('Erro ao copiar: ' + err.message, 'err');
    }
    document.body.removeChild(ta);
  }
}
