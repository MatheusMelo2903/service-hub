// Arquivar no Superlógica (T12): anexa a ata ou a prestação de contas gerada no Hub
// aos documentos do condomínio (a mesma lista onde ficam as atas e prestações hoje,
// impressoes/index). Envio: POST documentos?idEmpresa=<código do condomínio>&publicar=0
// com o PDF no campo "arquivo". publicar=0: fica só para a administradora; quem
// publica para os condôminos é a equipe, no Superlógica, depois de conferir.
// Esta é a única gravação deste módulo; o resto é leitura.

const https = require('https');
const crypto = require('crypto');

const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const chaveTitulo = (s) => semAcento(limpar(s)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MAX_BYTES = 15 * 1024 * 1024; // limite do Superlógica para arquivos

// Título do documento: letras, números e pontuação simples, até 120 caracteres.
function tituloSeguro(t) {
  return limpar(String(t || '').replace(/[^\p{L}\p{N} .,_()\/-]/gu, ' ')).slice(0, 120);
}

// Nome do arquivo derivado do título (o Superlógica mostra o nome do arquivo enviado).
function nomeArquivo(titulo) {
  const base = limpar(String(titulo).replace(/[\/\\:*?"<>|]/g, '-')).slice(0, 110) || 'documento';
  return base + '.pdf';
}

function ehPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.slice(0, 5).toString('latin1') === '%PDF-';
}

// Documentos já existentes com o mesmo título (nos últimos 400 dias): evita arquivar duas vezes.
async function procurarMesmoTitulo(cliente, id, titulo) {
  const fim = new Date();
  const ini = new Date(fim.getTime() - 400 * 24 * 3600 * 1000);
  const f = (d) => String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
  const alvo = chaveTitulo(titulo);
  const achados = [];
  let parcial = false;
  for (let pg = 1; pg <= 6; pg++) {
    const j = await cliente.get('impressoes/index', { idCondominio: id, dtInicio: f(ini), dtFim: f(fim), itensPorPagina: 50, pagina: pg });
    if (!Array.isArray(j)) throw new Error('resposta_inesperada');
    if (j[0] && j[0].status != null && String(j[0].status) !== '200' && !j[0].id_impressao_fimp) throw new Error('superlogica_' + j[0].status);
    const arr = j.filter((d) => d && String(d.id_empresa_emp) === String(id));
    if (pg === 6 && j.length === 50) parcial = true;
    arr.forEach((d) => {
      const t = chaveTitulo(d.st_titulo_fimp);
      if (t && (t === alvo || t === chaveTitulo(alvo + ' pdf') || chaveTitulo(String(d.st_titulo_fimp).replace(/\.pdf$/i, '')) === alvo)) {
        achados.push({ titulo: limpar(d.st_titulo_fimp), criado_em: limpar(d.dt_criacao_fimp) });
      }
    });
    if (j.length < 50) break;
  }
  achados.parcial = parcial;
  return achados;
}

// Envia o PDF. Devolve { ok, status, resposta } sem expor chaves.
function enviarDocumento({ base, appToken, accessToken }, id, titulo, buf) {
  return new Promise((resolve) => {
    const fronteira = '----hub' + crypto.randomBytes(12).toString('hex');
    const nome = nomeArquivo(titulo);
    const partes = [
      Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="ST_TITULO_FIMP"\r\n\r\n' + titulo + '\r\n', 'utf8'),
      Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="arquivo"; filename="' + semAcento(nome).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '') + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome) + '\r\nContent-Type: application/pdf\r\n\r\n', 'utf8'),
      buf,
      Buffer.from('\r\n--' + fronteira + '--\r\n', 'utf8'),
    ];
    const corpo = Buffer.concat(partes);
    const url = new URL(base + '/v2/condor/documentos');
    url.searchParams.set('idEmpresa', String(id));
    url.searchParams.set('publicar', '0');
    const r = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        app_token: appToken, access_token: accessToken, accept: 'application/json',
        'content-type': 'multipart/form-data; boundary=' + fronteira,
        'content-length': corpo.length,
      },
    }, (resp) => {
      const pedacos = [];
      resp.on('data', (c) => pedacos.push(c));
      resp.on('end', () => {
        const txt = Buffer.concat(pedacos).toString('utf8');
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { /* não JSON */ }
        const item = Array.isArray(json) ? json[0] : json;
        const st = item && item.status != null ? String(item.status) : '';
        const dados = item && item.data && typeof item.data === 'object' ? item.data : item;
        // Sucesso só com prova: status 200 no corpo ou um id do documento criado.
        const idDoc = dados && (dados.id_impressao_fimp || dados.id_arquivo_arq || dados.id || '');
        const ok = resp.statusCode === 200 && !!item && typeof item === 'object' && (st === '200' || (!st && !!idDoc));
        resolve({
          ok, status: resp.statusCode, id: idDoc ? String(idDoc) : '',
          publicado: dados && dados.fl_publicadopara_impr != null ? String(dados.fl_publicadopara_impr) : null,
          formato: item && typeof item === 'object' ? Object.keys(item).slice(0, 12).join(',') + (item.data && typeof item.data === 'object' ? ' data:' + Object.keys(item.data).slice(0, 12).join(',') : '') : typeof json,
          msg: item && (item.msg || item.message) ? limpar(item.msg || item.message).slice(0, 200) : '',
        });
      });
    });
    r.setTimeout(120000, () => { r.destroy(); resolve({ ok: false, status: 504, msg: 'tempo esgotado' }); });
    r.on('error', (e) => resolve({ ok: false, status: 0, msg: 'falha de rede' }));
    r.end(corpo);
  });
}

module.exports = { tituloSeguro, nomeArquivo, ehPdf, procurarMesmoTitulo, enviarDocumento, MAX_BYTES };
