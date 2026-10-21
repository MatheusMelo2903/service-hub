// T33: entrada de documentos (substitui o Paybox). O analista sobe boletos, notas e guias em
// PDF; aqui ficam a extração do texto, a leitura dos campos (tipo, CNPJs, valor, vencimento,
// linha digitável, número do documento), a conferência no Superlógica (só GET: condomínio pelo
// CNPJ do pagador ou tomador, fornecedor pelo CNPJ, duplicidade e boleto de outro condomínio)
// e o lançamento da despesa com o PDF anexado (só pelo server.js, com a trava do condomínio).
// Funções de leitura são puras e testadas em scripts/teste-entrada.js.

const crypto = require('crypto');
const https = require('https');

const POR_PAGINA = 50;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const NAO_CONDOMINIOS = new Set(['143', '144', '145', '160', '162']);
const TIPOS_DOC_SL = { nota: 1, guia: 2, fatura: 3, boleto: 6, outro: 6 }; // ID_TIPO_DOC do Superlógica
const ETIQUETA = { nota: 2, boleto: 1, fatura: 1, guia: 1 }; // 2 Doc. Fiscal, 1 Doc. Pgto

const doisDig = (n) => String(n).padStart(2, '0');
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const cent = (v) => Math.round(v * 100) / 100;

// ---------- datas ----------
function isoDe(d) { return d.getUTCFullYear() + '-' + doisDig(d.getUTCMonth() + 1) + '-' + doisDig(d.getUTCDate()); }
function dataValida(dd, mm, aaaa) {
  const d = new Date(Date.UTC(+aaaa, +mm - 1, +dd));
  return d.getUTCFullYear() === +aaaa && d.getUTCMonth() === +mm - 1 && d.getUTCDate() === +dd && +aaaa >= 2000 && +aaaa <= 2100 ? d : null;
}
// "DD/MM/AAAA" -> "AAAA-MM-DD" ou null
function brParaIso(s) {
  const m = String(s || '').match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  const d = m && dataValida(m[1], m[2], m[3]);
  return d ? isoDe(d) : null;
}
// "AAAA-MM-DD" -> "MM/DD/AAAA" (formato do Superlógica)
function isoParaSL(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[2] + '/' + m[3] + '/' + m[1] : ''; }
// "MM/DD/AAAA ..." (Superlógica) -> "AAAA-MM-DD"
function slParaIso(v) { const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? m[3] + '-' + doisDig(m[1]) + '-' + doisDig(m[2]) : null; }
function diasEntre(a, b) { return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000); }
function somarDias(iso, n) { const d = new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000); return isoDe(d); }

// ---------- dinheiro ----------
// "1.234,56" -> 1234.56 ; aceita "1234,56" e "1,234.56" não
function lerDinheiro(s) {
  const t = String(s || '').replace(/[R$\s]/g, '');
  if (!/^\d{1,3}(\.\d{3})*,\d{2}$|^\d+,\d{2}$/.test(t)) return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 && n < 1e9 ? cent(n) : null;
}

// ---------- CNPJ ----------
function cnpjValido(c) {
  c = soDig(c);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = (base) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = base.split('').reduce((a, d, i) => a + Number(d) * pesos[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(c.slice(0, 12));
  return d1 === Number(c[12]) && dv(c.slice(0, 12) + d1) === Number(c[13]);
}
function formatarCnpj(c) { c = soDig(c); return c.length === 14 ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : c; }

const ROT_PAGADOR = /(pagador|sacado|tomador|cliente|destinat[aá]rio|contribuinte|adquirente|devedor|condom[ií]nio)/ig;
const ROT_BENEF = /(benefici[aá]rio|cedente|prestador|emitente|emissor|favorecido|fornecedor|raz[aã]o social do emitente|credor)/ig;
// Todos os CNPJs válidos do texto, na ordem, com o papel pelo rótulo mais próximo antes dele.
function cnpjsDoTexto(texto) {
  const t = String(texto || '');
  const vistos = new Map();
  const re = /(?<!\d)(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})(?!\d)/g;
  let m;
  while ((m = re.exec(t))) {
    const c = soDig(m[1]);
    if (!cnpjValido(c)) continue;
    const antes = t.slice(Math.max(0, m.index - 220), m.index);
    let ultP = -1, ultB = -1, x;
    ROT_PAGADOR.lastIndex = 0; while ((x = ROT_PAGADOR.exec(antes))) ultP = x.index;
    ROT_BENEF.lastIndex = 0; while ((x = ROT_BENEF.exec(antes))) ultB = x.index;
    const papel = ultP < 0 && ultB < 0 ? 'indefinido' : ultP > ultB ? 'pagador' : 'beneficiario';
    if (!vistos.has(c)) vistos.set(c, { cnpj: c, papel, ordem: vistos.size });
    else if (vistos.get(c).papel === 'indefinido') vistos.get(c).papel = papel;
  }
  return [...vistos.values()];
}

// ---------- linha digitável ----------
function mod10(s) {
  let soma = 0, peso = 2;
  for (let i = s.length - 1; i >= 0; i--) { let p = Number(s[i]) * peso; if (p > 9) p = Math.floor(p / 10) + (p % 10); soma += p; peso = peso === 2 ? 1 : 2; }
  const r = soma % 10;
  return r === 0 ? 0 : 10 - r;
}
function mod11Arrec(s) {
  let soma = 0, peso = 2;
  for (let i = s.length - 1; i >= 0; i--) { soma += Number(s[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11;
  return r === 0 || r === 1 ? 0 : 11 - r;
}
// Boleto bancário (47 dígitos): confere os três campos.
// O dígito geral (posição 33) cobre o fator de vencimento e o valor, que os campos não cobrem.
function linhaBoletoValida(l) {
  if (!(l.length === 47 && mod10(l.slice(0, 9)) === +l[9] && mod10(l.slice(10, 20)) === +l[20] && mod10(l.slice(21, 31)) === +l[31])) return false;
  const b = barrasDaLinha(l);
  const sem = b.slice(0, 4) + b.slice(5);
  let soma = 0, peso = 2;
  for (let i = sem.length - 1; i >= 0; i--) { soma += Number(sem[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = 11 - (soma % 11);
  return (r === 0 || r === 10 || r === 11 ? 1 : r) === Number(b[4]);
}
// Arrecadação (48 dígitos, concessionária e guia): confere cada bloco de 11 + dígito.
function linhaArrecValida(l) {
  if (l.length !== 48 || l[0] !== '8') return false;
  const ref = l[2];
  const f = ref === '6' || ref === '7' ? mod10 : ref === '8' || ref === '9' ? mod11Arrec : null;
  if (!f) return false;
  for (let i = 0; i < 4; i++) { const b = l.slice(i * 12, i * 12 + 11); if (f(b) !== +l[i * 12 + 11]) return false; }
  return true;
}
function barrasDaLinha(l) {
  if (l.length === 47) return l.slice(0, 4) + l[32] + l.slice(33, 47) + l.slice(4, 9) + l.slice(10, 20) + l.slice(21, 31);
  if (l.length === 48) return l.slice(0, 11) + l.slice(12, 23) + l.slice(24, 35) + l.slice(36, 47);
  return '';
}
// Fator de vencimento: a contagem recomeçou em 22/02/2025 (fator 1000). Fica com a data mais perto de hoje.
function vencimentoDoFator(fator, hojeIso) {
  if (!fator || fator < 1000) return null;
  const c1 = somarDias('1997-10-07', fator);
  const c2 = somarDias('2025-02-22', fator - 1000);
  const h = hojeIso || isoDe(new Date());
  const v = Math.abs(diasEntre(c1, h)) <= Math.abs(diasEntre(c2, h)) ? c1 : c2;
  return Math.abs(diasEntre(v, h)) <= 730 ? v : null; // longe demais: não confia
}
// Procura a linha digitável (ou o código de barras de 44 dígitos) no texto.
function acharLinha(texto, hojeIso) {
  const t = String(texto || '');
  const candidatos = [];
  const re47 = /(?<!\d)(\d{5}[.\s]?\d{5}\s*\d{5}[.\s]?\d{6}\s*\d{5}[.\s]?\d{6}\s*\d\s*\d{14})(?!\d)/g;
  const re48 = /(?<!\d)(8\d{10}[-\s]?\d\s*\d{11}[-\s]?\d\s*\d{11}[-\s]?\d\s*\d{11}[-\s]?\d)(?!\d)/g;
  let m;
  while ((m = re47.exec(t))) candidatos.push(soDig(m[1]));
  while ((m = re48.exec(t))) candidatos.push(soDig(m[1]));
  for (const l of candidatos) {
    if (l.length === 47 && linhaBoletoValida(l)) {
      const valor = Number(l.slice(37)) / 100;
      return { linha: l, barras: barrasDaLinha(l), especie: 'boleto', valor: valor > 0 ? cent(valor) : null, vencimento: vencimentoDoFator(Number(l.slice(33, 37)), hojeIso) };
    }
    if (l.length === 48 && linhaArrecValida(l)) {
      const b = barrasDaLinha(l);
      const valor = (l[2] === '6' || l[2] === '8') ? Number(b.slice(4, 15)) / 100 : 0;
      return { linha: l, barras: b, especie: 'arrecadacao', valor: valor > 0 ? cent(valor) : null, vencimento: null, segmento: l[1] };
    }
  }
  return null;
}

// ---------- campos do texto ----------
const DINHEIRO = '(?:R\\$\\s*)?(\\d{1,3}(?:\\.\\d{3})*,\\d{2}|\\d+,\\d{2})(?!\\d)';
const DATA = '(\\d{2}[\\/.]\\d{2}[\\/.]\\d{4})';
// Primeiro valor depois de um rótulo (até 80 caracteres sem outro número no meio).
function valorDepois(t, rotulo) {
  const re = new RegExp(rotulo + '[^\\d\\n]{0,40}(?:\\n[^\\d\\n]{0,40})?' + DINHEIRO, 'i');
  const m = t.match(re);
  return m ? lerDinheiro(m[m.length - 1]) : null;
}
function dataDepois(t, rotulo) {
  const re = new RegExp(rotulo + '[^\\d\\n]{0,40}(?:\\n[^\\d\\n]{0,40})?' + DATA, 'i');
  const m = t.match(re);
  if (!m) return null;
  return brParaIso(m[m.length - 1].replace(/\./g, '/'));
}
function classificar(t, linha) {
  const comprovante = /comprovante\s+(de\s+)?(pagamento|transa[cç][aã]o|transfer[eê]ncia|pix|agendamento)/i.test(t) ||
    (/comprovante/i.test(t) && /(autentica[cç][aã]o|efetivad|realizad[oa]\s+em|pagamento\s+realizado|transa[cç][aã]o\s+efetuada)/i.test(t));
  if (comprovante) return 'comprovante';
  const guia = /(documento\s+de\s+arrecada[cç][aã]o|\bDARF\b|\bDAE\b|\bDARE\b|\bGRU\b|guia\s+(de\s+)?(recolhimento|previd[eê]ncia|do\s+fgts|de\s+arrecada)|\bGRF\b|\bDCTFWeb\b|\bDAM\b)/i.test(t);
  const nota = /(NFS-?e|nota\s+fiscal|DANFE|DANFSE|nota\s+de\s+servi[cç]o|tomador\s+d[oe]s?\s+servi[cç]o)/i.test(t);
  if (guia && (!nota || /^[\s\S]{0,300}(documento\s+de\s+arrecada|DARF|guia)/i.test(t)) && (!linha || linha.especie === 'arrecadacao')) return 'guia';
  // Linha digitável que confere manda: o documento é para pagar (boleto ou fatura), mesmo
  // citando a nota fiscal. Nota com boleto no mesmo arquivo também entra como boleto.
  if (linha && linha.especie === 'boleto') return 'boleto';
  if (linha && linha.especie === 'arrecadacao') return 'fatura';
  if (nota) return 'nota';
  if (linha || /(benefici[aá]rio|cedente)[\s\S]{0,400}(nosso\s+n[uú]mero|local\s+de\s+pagamento)/i.test(t)) return 'boleto';
  if (/(fatura|conta\s+de\s+(energia|[aá]gua|g[aá]s))/i.test(t)) return 'fatura';
  return 'outro';
}
function acharDocumento(t, tipo) {
  const pad = tipo === 'nota'
    ? [/n[uú]mero\s+da\s+(?:nfs-?e|nota(?:\s+fiscal)?)\s*[:\s]*(\d[\d.\/-]{0,20})/i, /(?:nfs-?e|nota\s+fiscal(?:\s+eletr[oô]nica)?(?:\s+de\s+servi[cç]os?)?)\s*(?:n[º°o]\.?|n[uú]mero)\s*[:\s]*(\d[\d.\/-]{0,20})/i,
      /\bn[º°o]\.?\s*(\d{3}\.\d{3}\.\d{3})\b/i, /n[uú]mero\s*(?:da\s+nota)?\s*[:\n]\s*(\d{1,12})\b/i]
    : [/n[uú]mero\s+do\s+documento\s*[:\s]*([A-Za-z0-9][A-Za-z0-9.\/-]{0,24})/i, /(?:n[º°o]\.?|nr\.?|num\.?)\s*(?:do\s+)?documento\s*[:\s]*([A-Za-z0-9][A-Za-z0-9.\/-]{0,24})/i,
      /n[uú]mero\s+da\s+fatura\s*[:\s]*([A-Za-z0-9][A-Za-z0-9.\/-]{0,24})/i];
  for (const re of pad) {
    const m = t.match(re);
    if (m && m[1] && /\d/.test(m[1]) && !/^(data|valor|vencimento|esp[eé]cie)/i.test(m[1])) return m[1].replace(/[.\/-]+$/, '').slice(0, 25);
  }
  return null;
}
// Chave de acesso: NFS-e nacional (50 dígitos: município 7, ambiente 1, tipo 1, inscrição 14,
// número 13, AAMM 4, código 9, DV 1) ou NF-e (44 dígitos: UF 2, AAMM 4, CNPJ 14, modelo 2,
// série 3, número 9, ...). Só depois do rótulo "chave".
function chaveNota(t) {
  const m50 = t.match(/chave[^\d]{0,60}((?:\d\s?){50})(?!\d)/i);
  if (m50) {
    const c = soDig(m50[1]);
    if (c.length === 50) return { numero: String(Number(c.slice(23, 36))), emitente: c.slice(9, 23) };
  }
  const m44 = t.match(/chave[^\d]{0,60}((?:\d{4}\s?){11})(?!\d)/i);
  if (m44) {
    const c = soDig(m44[1]);
    if (c.length === 44 && /^(55|65)$/.test(c.slice(20, 22))) return { numero: String(Number(c.slice(25, 34))), emitente: c.slice(6, 20) };
  }
  return null;
}
// Lê os campos do texto do PDF. Nada é inventado: o que não aparece fica null.
function lerCampos(texto, hojeIso) {
  const t = String(texto || '').replace(/\r/g, '').replace(/[ \t ]+/g, ' ');
  const linha = acharLinha(t, hojeIso);
  const tipo = classificar(t, linha);
  let valor = null, origemValor = null;
  if (linha && linha.valor) { valor = linha.valor; origemValor = 'linha'; }
  if (valor == null) {
    const rotulos = tipo === 'nota'
      ? ['valor\\s+l[ií]quido(?:\\s+da\\s+nota|\\s+da\\s+nfs-?e)?', 'valor\\s+total\\s+da\\s+nota', 'valor\\s+total\\s+(?:dos\\s+)?servi[cç]os?', 'valor\\s+(?:do\\s+)?servi[cç]o', 'valor\\s+(?:da\\s+)?nota', 'valor\\s+total']
      : ['valor\\s+(?:do\\s+)?documento', 'valor\\s+cobrado', 'total\\s+a\\s+pagar', 'valor\\s+a\\s+pagar', 'valor\\s+total', 'valor\\s+principal', '\\(=\\)\\s*valor'];
    for (const r of rotulos) { valor = valorDepois(t, r); if (valor != null) { origemValor = 'texto'; break; } }
  }
  let vencimento = linha && linha.vencimento ? linha.vencimento : null;
  if (!vencimento) vencimento = dataDepois(t, '(?:data\\s+de\\s+)?vencimento') || dataDepois(t, 'vence\\s+em') || dataDepois(t, 'pagar\\s+at[eé]');
  const emissao = dataDepois(t, '(?:data\\s+(?:e\\s+hora\\s+)?(?:de\\s+|da\\s+)?emiss[aã]o|emitid[ao]\\s+em|data\\s+do\\s+documento|compet[eê]ncia)');
  const cnpjs = cnpjsDoTexto(t);
  let documento = acharDocumento(t, tipo);
  // Chave de acesso da nota: número da nota e CNPJ do emitente vêm dentro dela.
  const ch = tipo === 'nota' ? chaveNota(t) : null;
  if (ch) {
    if (!documento) documento = ch.numero;
    const e = cnpjs.find((c) => c.cnpj === ch.emitente);
    if (e) e.papel = 'beneficiario';
    else if (cnpjValido(ch.emitente)) cnpjs.push({ cnpj: ch.emitente, papel: 'beneficiario', ordem: cnpjs.length });
  }
  return { tipo, valor, origem_valor: origemValor, vencimento, emissao, documento,
    linha: linha ? linha.linha : null, barras: linha ? linha.barras : null, especie_linha: linha ? linha.especie : null, cnpjs };
}
// Resultado da leitura interna (escaneado) no mesmo formato de lerCampos. A linha digitável e os
// CNPJs só valem se os dígitos conferem; valor e vencimento da linha têm prioridade.
function camposDaLeitura(j, hojeIso) {
  const r = j || {};
  const linha = r.linha_digitavel ? acharLinha(soDig(r.linha_digitavel).replace(/^(\d{5})(\d{5})(\d{5})(\d{6})(\d{5})(\d{6})(\d)(\d{14})$/, '$1$2 $3$4 $5$6 $7 $8'), hojeIso) : null;
  const cnpjs = [];
  const addC = (v, papel) => { const c = soDig(v); if (cnpjValido(c) && !cnpjs.some((x) => x.cnpj === c)) cnpjs.push({ cnpj: c, papel, ordem: cnpjs.length }); };
  addC(r.cnpj_pagador, 'pagador'); addC(r.cnpj_beneficiario, 'beneficiario');
  const tipos = ['boleto', 'nota', 'guia', 'fatura', 'comprovante', 'outro'];
  const valorLido = lerDinheiro(r.valor);
  return {
    tipo: tipos.includes(r.tipo) ? r.tipo : 'outro',
    valor: linha && linha.valor ? linha.valor : valorLido, origem_valor: linha && linha.valor ? 'linha' : valorLido ? 'leitura' : null,
    vencimento: (linha && linha.vencimento) || brParaIso(r.vencimento), emissao: brParaIso(r.emissao),
    documento: r.numero_documento ? limpar(r.numero_documento).slice(0, 25) : null,
    linha: linha ? linha.linha : null, barras: linha ? linha.barras : null, especie_linha: linha ? linha.especie : null, cnpjs,
  };
}
// A leitura pelo texto ficou faltando o essencial (valor ou CNPJ de condomínio)? Então vale a
// leitura interna (PDF escaneado com texto ruim, tabela de nota com valores longe dos rótulos).
function faltaEssencial(campos, mapa) {
  if (!campos) return true;
  if (!(campos.valor > 0)) return true;
  return !!mapa && !campos.cnpjs.some((c) => mapa.has(c.cnpj));
}
// Junta a leitura do texto com a interna: o que conferiu pelo texto (linha digitável, CNPJ)
// fica; o que faltou vem da interna.
// preferirInterna: o texto nem trazia o CNPJ do condomínio (texto de digitalização ruim); aí
// vale a interna e do texto só fica o que conferiu pelos dígitos (linha digitável).
function juntarLeituras(texto, interna, preferirInterna) {
  if (!texto) return interna;
  if (!interna) return texto;
  if (preferirInterna) {
    const o = Object.assign({}, interna);
    if (texto.linha && !o.linha) { o.linha = texto.linha; o.barras = texto.barras; o.especie_linha = texto.especie_linha; }
    const cn = interna.cnpjs.slice();
    texto.cnpjs.forEach((c) => { if (!cn.some((x) => x.cnpj === c.cnpj)) cn.push(Object.assign({}, c, { ordem: cn.length })); });
    o.cnpjs = cn;
    return o;
  }
  const out = Object.assign({}, texto);
  ['valor', 'vencimento', 'emissao', 'documento', 'linha', 'barras', 'especie_linha'].forEach((k) => { if (out[k] == null && interna[k] != null) out[k] = interna[k]; });
  if (texto.valor == null && interna.valor != null) out.origem_valor = interna.origem_valor;
  if ((texto.tipo === 'outro' || !texto.tipo) && interna.tipo) out.tipo = interna.tipo;
  const cn = texto.cnpjs.slice();
  interna.cnpjs.forEach((c) => { const j = cn.find((x) => x.cnpj === c.cnpj); if (!j) cn.push(Object.assign({}, c, { ordem: cn.length })); else if (j.papel === 'indefinido') j.papel = c.papel; });
  out.cnpjs = cn;
  return out;
}
// Texto com conteúdo de verdade? (PDF escaneado vem vazio ou só com lixo)
function textoUtil(texto) { return (String(texto || '').match(/[A-Za-zÀ-ú]{3,}/g) || []).length >= 15; }

// ---------- PDF ----------
function ehPdf(buf) { return Buffer.isBuffer(buf) && buf.length > 100 && buf.slice(0, 1024).toString('latin1').includes('%PDF-'); }
function hashDe(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
let _pdfjs;
function pdfjs() {
  if (_pdfjs === undefined) {
    try {
      // Sem canvas no servidor: só o texto interessa (os avisos de desenho são esperados).
      const avisoOrig = console.warn, logOrig = console.log; console.warn = () => {}; console.log = () => {};
      try { _pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); } finally { console.warn = avisoOrig; console.log = logOrig; }
    } catch (e) { _pdfjs = null; }
  }
  return _pdfjs;
}
// Texto das primeiras páginas, em ordem de leitura (quebra de linha quando muda a altura).
// Devolve null se não deu para abrir (aí a leitura interna decide).
async function extrairTexto(buf, maxPaginas) {
  const lib = pdfjs();
  if (!lib) return null;
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(buf), disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0, stopAtErrors: false }).promise;
  } catch (e) { return null; }
  try {
    let txt = '';
    const n = Math.min(doc.numPages, maxPaginas || 6);
    for (let i = 1; i <= n; i++) {
      const p = await doc.getPage(i);
      const c = await p.getTextContent();
      let ultY = null;
      for (const it of c.items) {
        const y = it.transform ? it.transform[5] : 0;
        if (ultY !== null) txt += Math.abs(y - ultY) > 2 ? '\n' : ' ';
        txt += it.str || '';
        ultY = y;
      }
      txt += '\n';
      if (txt.length > 200000) break;
    }
    return { texto: txt, paginas: doc.numPages };
  } catch (e) { return null; } finally { try { doc.destroy(); } catch (e) { /* nada */ } }
}

// ---------- Superlógica (só GET) ----------
const _cache = new Map(); // chave -> { ate, v }
async function comCache(chave, ms, fn) {
  const c = _cache.get(chave);
  if (c && c.ate > Date.now()) return c.v;
  const v = await fn();
  _cache.set(chave, { ate: Date.now() + ms, v });
  if (_cache.size > 500) _cache.delete(_cache.keys().next().value);
  return v;
}
function limparCache() { _cache.clear(); }
// estrito: página cheia no teto lança erro (conferência de duplicidade não pode ficar cortada).
async function paginas(cliente, rota, params, max, estrito) {
  const out = [];
  for (let pg = 1; pg <= max; pg++) {
    const j = await cliente.get(rota, Object.assign({}, params, { itensPorPagina: POR_PAGINA, pagina: pg }));
    if (!Array.isArray(j) || !j.length) break;
    j.forEach((x) => out.push(x));
    if (j.length < POR_PAGINA) break;
    if (pg === max && estrito) { const e = new Error('leitura_cortada'); e.cortada = true; throw e; }
  }
  return out;
}
// Todos os condomínios ativos (cache de 1 hora): por código e por CNPJ.
async function cadastroCondominios(cliente) {
  return comCache('conds', 3600000, async () => {
    const lista = await paginas(cliente, 'condominios/get', { id: -1, somenteCondominiosAtivos: 1, ignorarCondominioModelo: 1, apenasColunasPrincipais: 1 }, 20);
    const porId = new Map(), porCnpj = new Map();
    lista.forEach((c) => {
      const id = String(c.id_condominio_cond || '');
      if (!id || NAO_CONDOMINIOS.has(id)) return;
      const doc = soDig(c.st_cnpj_cond) || soDig(c.st_cpf_cond);
      const item = { id, nome: limpar(c.st_fantasia_cond) || limpar(c.st_nome_cond), plano: String(c.id_planoconta_plc || ''), cnpj: doc.length === 14 ? doc : null };
      porId.set(id, item);
      if (item.cnpj) { if (!porCnpj.has(doc)) porCnpj.set(doc, []); porCnpj.get(doc).push(item); }
    });
    return { porId, porCnpj };
  });
}
// CNPJ -> condomínio. CNPJ que aparece em mais de um cadastro fica de fora (não dá para saber
// qual é; nunca escolher um deles por conta própria).
async function mapaCondominios(cliente) {
  const { porCnpj } = await cadastroCondominios(cliente);
  const m = new Map();
  porCnpj.forEach((l, cnpj) => { if (l.length === 1) m.set(cnpj, l[0]); });
  return m;
}
async function cnpjsRepetidos(cliente) {
  const { porCnpj } = await cadastroCondominios(cliente);
  return new Set([...porCnpj].filter(([, l]) => l.length > 1).map(([c]) => c));
}
async function condominioPorId(cliente, id) {
  const { porId } = await cadastroCondominios(cliente);
  return porId.get(String(id)) || null;
}
// Fornecedor pelo CNPJ (pesquisa do Superlógica; confere o CNPJ devolvido).
async function fornecedorPorCnpj(cliente, cnpj) {
  return comCache('forn:' + cnpj, 600000, async () => {
    const r = await cliente.get('fornecedores/index', { contatosDoTipo: 'fornecedores', pesquisa: cnpj, itensPorPagina: 10, pagina: 1 });
    const achou = (Array.isArray(r) ? r : []).find((f) => soDig(f.st_cpf_con) === cnpj || soDig(f.st_cgc_con) === cnpj);
    return achou ? { id: String(achou.id_contato_con), nome: limpar(achou.st_nome_con) || limpar(achou.st_fantasia_con), cnpj } : null;
  });
}
async function fornecedorPorId(cliente, id) {
  if (!/^[1-9]\d{0,9}$/.test(String(id || ''))) return null;
  return comCache('fornid:' + id, 600000, async () => {
    let r;
    try { r = await cliente.get('fornecedores/index', { contatosDoTipo: 'fornecedores', id, itensPorPagina: 5, pagina: 1 }); } catch (e) {
      if (/404/.test(String(e && e.message))) return null; // código que não existe
      throw e;
    }
    const achou = (Array.isArray(r) ? r : []).find((f) => String(f.id_contato_con) === String(id));
    return achou ? { id: String(achou.id_contato_con), nome: limpar(achou.st_nome_con) || limpar(achou.st_fantasia_con), cnpj: soDig(achou.st_cpf_con) || null } : null;
  });
}
// Contas (categorias) de despesa do plano do condomínio.
async function contasDoPlano(cliente, plano) {
  if (!/^\d{1,6}$/.test(String(plano || ''))) return [];
  return comCache('plano:' + plano, 3600000, async () => {
    const r = await cliente.get('planocontas', { id: plano });
    return (Array.isArray(r) ? r : []).filter((c) => /^2\./.test(String(c.st_conta_cont || '')))
      .map((c) => ({ conta: String(c.st_conta_cont), nome: limpar(c.st_descricao_cont) }));
  });
}
async function contaPrincipal(cliente, id) {
  return comCache('cb:' + id, 600000, async () => {
    const r = await cliente.get('contabancos/index', { idCondominio: id, exibirContasAtivas: 1 });
    const l = (Array.isArray(r) ? r : []).filter((c) => String(c.id_condominio_cond) === String(id));
    const p = l.find((c) => String(c.fl_principal_cb) === '1') || l[0];
    return p ? String(p.id_contabanco_cb) : null;
  });
}

// Condomínio pelo CNPJ do pagador ou tomador e fornecedor pelo CNPJ do beneficiário ou emitente.
// escopo: Set de ids que o usuário pode ver, ou null (todos). Condomínio fora da carteira não
// tem o nome mostrado.
async function identificar(cliente, campos, escopo) {
  const mapa = await mapaCondominios(cliente);
  const repetidos = await cnpjsRepetidos(cliente);
  const conds = campos.cnpjs.filter((c) => mapa.has(c.cnpj));
  let escolhido = null, motivo = null;
  const distintos = [...new Set(conds.map((c) => mapa.get(c.cnpj).id))];
  if (distintos.length === 1) escolhido = conds[0];
  else if (distintos.length > 1) {
    const pag = conds.filter((c) => c.papel === 'pagador');
    if (new Set(pag.map((c) => mapa.get(c.cnpj).id)).size === 1) escolhido = pag[0];
    else motivo = 'mais_de_um_condominio';
  } else motivo = campos.cnpjs.some((c) => repetidos.has(c.cnpj)) ? 'cnpj_em_mais_de_um_cadastro' : 'cnpj_condominio_nao_achado';
  let condominio = null;
  if (escolhido) {
    const c = mapa.get(escolhido.cnpj);
    if (escopo && !escopo.has(c.id)) { motivo = 'fora_da_carteira'; }
    else condominio = { id: c.id, nome: c.nome, cnpj: escolhido.cnpj, papel: escolhido.papel };
  }
  // Fornecedor: CNPJs que não são de condomínio, beneficiário primeiro, depois a ordem do texto.
  const outros = campos.cnpjs.filter((c) => !mapa.has(c.cnpj) && !repetidos.has(c.cnpj))
    .sort((a, b) => (a.papel === 'beneficiario' ? 0 : a.papel === 'indefinido' ? 1 : 2) - (b.papel === 'beneficiario' ? 0 : b.papel === 'indefinido' ? 1 : 2) || a.ordem - b.ordem);
  let fornecedor = null;
  for (const c of outros.slice(0, 3)) {
    try { fornecedor = await fornecedorPorCnpj(cliente, c.cnpj); } catch (e) { fornecedor = null; }
    if (fornecedor) break;
  }
  const cnpjFornecedor = fornecedor ? fornecedor.cnpj : (outros[0] ? outros[0].cnpj : null);
  return { condominio, motivo_condominio: motivo, fornecedor, cnpj_fornecedor: cnpjFornecedor };
}

// Despesas do condomínio com vencimento perto do documento (todas as situações).
async function despesasPerto(cliente, id, vencIso) {
  const base = vencIso || isoDe(new Date());
  const ini = somarDias(base, -45), fim = somarDias(base, 45);
  return comCache('desp:' + id + ':' + ini, 120000, () =>
    paginas(cliente, 'despesas/index', { idCondominio: id, comStatus: 'todas', dtInicio: isoParaSL(ini), dtFim: isoParaSL(fim) }, 20, true));
}
// Parcelas de todos os condomínios com vencimento a 3 dias do documento (boleto já lançado em outro).
async function despesasTodosPerto(cliente, vencIso) {
  // ±1 dia: a carteira inteira tem cerca de 800 parcelas em 3 dias (16 páginas, 12 s).
  const ini = somarDias(vencIso, -1), fim = somarDias(vencIso, 1);
  return comCache('desptodos:' + ini, 600000, () =>
    paginas(cliente, 'despesas/index', { idCondominio: -1, comStatus: 'todas', dtInicio: isoParaSL(ini), dtFim: isoParaSL(fim) }, 30, true));
}
const docNorm = (v) => limpar(v).toLowerCase().replace(/[\s.\/-]+/g, '').replace(/^0+(?=\d)/, '');
function mesmaLinha(p, d) {
  const cb = soDig(p.st_codigobarras_pdes);
  if (!cb || !(d.linha || d.barras)) return false;
  return cb === d.linha || cb === d.barras || (cb.length >= 44 && (barrasDaLinha(cb) === d.barras));
}
function resumoParcela(p) {
  return { id_despesa: String(p.id_despesa_des), id_parcela: String(p.id_parcela_pdes || ''), fornecedor: limpar(p.st_nome_con), documento: limpar(p.st_documento_des),
    valor: cent(Number(p.vl_valor_pdes) || 0), vencimento: slParaIso(p.dt_vencimento_pdes), liquidada: !!slParaIso(p.dt_liquidacao_pdes) };
}
// Duplicidade no condomínio: mesmo documento do mesmo fornecedor, mesma linha digitável, ou
// mesmo fornecedor e valor com vencimento a até 10 dias.
function acharDuplicidades(parcelas, d) {
  const out = [];
  const doc = docNorm(d.documento);
  for (const p of parcelas) {
    const mesmoForn = d.id_fornecedor && String(p.id_contato_con) === String(d.id_fornecedor);
    const motivos = [];
    if (mesmaLinha(p, d)) motivos.push('mesma_linha');
    if (doc && mesmoForn && docNorm(p.st_documento_des) === doc) motivos.push('mesmo_documento');
    const pv = slParaIso(p.dt_vencimento_pdes);
    if (mesmoForn && d.valor && Math.abs((Number(p.vl_valor_pdes) || 0) - d.valor) < 0.005 && pv && d.vencimento && Math.abs(diasEntre(pv, d.vencimento)) <= 10) motivos.push('mesmo_fornecedor_valor_10_dias');
    if (motivos.length) out.push(Object.assign(resumoParcela(p), { motivos }));
  }
  return out.slice(0, 10);
}
// Categoria sugerida: a da última despesa do mesmo fornecedor no condomínio.
function contaSugerida(parcelas, idFornecedor) {
  if (!idFornecedor) return null;
  const l = parcelas.filter((p) => String(p.id_contato_con) === String(idFornecedor) && Array.isArray(p.apropriacao) && p.apropriacao[0])
    .sort((a, b) => String(slParaIso(b.dt_vencimento_pdes)).localeCompare(String(slParaIso(a.dt_vencimento_pdes))));
  return l.length ? { conta: String(l[0].apropriacao[0].st_conta_cont), nome: limpar(l[0].apropriacao[0].st_descricao_cont) } : null;
}

// Alertas do rascunho. GRAVES precisam ser vistos e aceitos na tela antes de lançar;
// IMPEDE não deixa lançar de jeito nenhum.
const GRAVES = ['duplicidade', 'outro_condominio', 'condominio_diferente_do_documento', 'na_fila'];
const IMPEDE = ['sem_condominio', 'sem_fornecedor', 'sem_valor', 'sem_vencimento', 'sem_conta', 'conferencia_incompleta', 'fora_da_carteira'];
// d: { id_superlogica, id_fornecedor, valor, vencimento, documento, linha, barras, conta, tipo, cond_documento }
// outrosNaFila: rascunhos ou lançados do Hub com a mesma linha ou o mesmo arquivo.
async function conferir(cliente, d, opts) {
  const o = opts || {};
  const alertas = [];
  const add = (codigo, texto, extra) => alertas.push(Object.assign({ codigo, texto, nivel: GRAVES.includes(codigo) ? 'grave' : IMPEDE.includes(codigo) ? 'impede' : 'aviso' }, extra || {}));
  if (!d.id_superlogica) add('sem_condominio', 'Escolha o condomínio (o CNPJ do pagador ou tomador não foi encontrado).');
  else if (o.escopo && !o.escopo.has(String(d.id_superlogica))) add('fora_da_carteira', 'Esse condomínio não está na sua carteira.');
  if (!d.id_fornecedor) add('sem_fornecedor', 'Fornecedor não encontrado no Superlógica pelo CNPJ: informe o código do fornecedor.');
  if (!(d.valor > 0)) add('sem_valor', 'Informe o valor.');
  if (!d.vencimento) add('sem_vencimento', 'Informe o vencimento.');
  if (!d.conta) add('sem_conta', 'Escolha a categoria (conta) da despesa.');
  if (d.tipo === 'comprovante') add('comprovante', 'Parece um comprovante de pagamento, não um boleto ou nota.');
  const hoje = o.hojeIso || isoDe(new Date(Date.now() - 3 * 3600000));
  if (d.vencimento && d.vencimento < hoje) add('vencido', 'Vencimento já passou (' + d.vencimento.split('-').reverse().join('/') + ').');
  if (d.valor_linha && d.valor && Math.abs(d.valor_linha - d.valor) >= 0.01) add('valor_diferente_linha', 'O valor informado é diferente do valor da linha digitável (R$ ' + d.valor_linha.toFixed(2).replace('.', ',') + ').');
  if (d.cond_documento && d.id_superlogica && String(d.cond_documento) !== String(d.id_superlogica)) add('condominio_diferente_do_documento', 'O CNPJ do pagador ou tomador no documento é de outro condomínio.');
  if (Array.isArray(o.naFila) && o.naFila.length) add('na_fila', 'O mesmo documento já está na fila do Hub.', { itens: o.naFila.slice(0, 5) });
  let sugestao = null, duplicidades = [];
  if (d.id_superlogica && !(o.escopo && !o.escopo.has(String(d.id_superlogica)))) {
    try {
      const parcelas = await despesasPerto(cliente, d.id_superlogica, d.vencimento);
      duplicidades = acharDuplicidades(parcelas, d);
      sugestao = contaSugerida(parcelas, d.id_fornecedor);
      if (duplicidades.length) add('duplicidade', 'Já existe despesa parecida neste condomínio no Superlógica.', { itens: duplicidades });
    } catch (e) { add('conferencia_incompleta', 'Não deu para conferir duplicidade no Superlógica agora. Tente de novo.'); }
  }
  if ((d.linha || d.barras) && d.vencimento) {
    try {
      const todos = await despesasTodosPerto(cliente, d.vencimento);
      const fora = todos.filter((p) => String(p.id_condominio_cond) !== String(d.id_superlogica) && mesmaLinha(p, d));
      if (fora.length) add('outro_condominio', 'Este boleto já está lançado em outro condomínio.', { itens: fora.slice(0, 5).map((p) => {
        const vis = !o.escopo || o.escopo.has(String(p.id_condominio_cond));
        return Object.assign(resumoParcela(p), { condominio: vis ? limpar(p.st_fantasia_cond) : 'outro condomínio', id_superlogica: vis ? String(p.id_condominio_cond) : null });
      }) });
    } catch (e) { add('conferencia_incompleta', 'Não deu para conferir se o boleto está em outro condomínio. Tente de novo.'); }
  }
  return { alertas, sugestao_conta: sugestao };
}
function podeLancar(alertas, aceitos) {
  const ac = new Set((aceitos || []).map(String));
  const imp = alertas.filter((a) => a.nivel === 'impede');
  if (imp.length) return { ok: false, motivo: 'impede', alertas: imp };
  const faltam = alertas.filter((a) => a.nivel === 'grave' && !ac.has(a.codigo));
  if (faltam.length) return { ok: false, motivo: 'grave_nao_aceito', alertas: faltam };
  return { ok: true };
}

// ---------- gravação (só chamada pelo server.js depois da trava do condomínio) ----------
// Trava: sem a variável ENTRADA_LIBERADA só o condomínio de teste 167 recebe lançamento.
// ENTRADA_LIBERADA=todos libera todos; uma lista de códigos libera só esses (e o 167).
function lancamentoLiberado(id, env) {
  const v = String((env || process.env).ENTRADA_LIBERADA || '').trim();
  if (String(id) === '167') return true;
  if (!v) return false;
  if (/^todos$/i.test(v)) return true;
  return v.split(/[\s,;]+/).includes(String(id));
}
function pedir({ base, appToken, accessToken }, metodo, caminho, query, corpo, tipoCorpo) {
  return new Promise((resolve) => {
    const url = new URL(base + '/v2/condor/' + caminho);
    Object.entries(query || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
    const dados = corpo || Buffer.alloc(0);
    const r = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: metodo,
      headers: { app_token: appToken, access_token: accessToken, accept: 'application/json', 'content-type': tipoCorpo || 'application/x-www-form-urlencoded', 'content-length': dados.length },
    }, (resp) => {
      const partes = [];
      resp.on('data', (c) => partes.push(c));
      resp.on('error', () => resolve({ status: 0, json: null }));
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(partes).toString('utf8').replace(/^﻿/, '')); } catch (e) { json = null; }
        resolve({ status: resp.statusCode, json });
      });
    });
    r.setTimeout(60000, () => { r.destroy(); resolve({ status: 504, json: null }); });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.end(dados);
  });
}
function corpoOk(r) {
  const item = Array.isArray(r.json) ? r.json[0] : r.json;
  const ok = r.status >= 200 && r.status < 300 && !!item && typeof item === 'object' && String(item.status) === '200';
  return { ok, item, msg: item && item.msg ? limpar(item.msg).replace(/<[^>]*>/g, '').slice(0, 200) : (r.status ? 'HTTP ' + r.status : 'sem resposta') };
}
const nomeArquivoSeguro = (n) => (limpar(n).replace(/[^A-Za-z0-9 ._()-]/g, '_').replace(/\.pdf$/i, '').slice(0, 80) || 'documento') + '.pdf';
async function enviarArquivo(cred, idFornecedor, buf, nome) {
  const fronteira = '----hub' + crypto.randomBytes(12).toString('hex');
  const campo = (n, v) => Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="' + n + '"\r\n\r\n' + v + '\r\n', 'utf8');
  const corpo = Buffer.concat([
    campo('ID_RESPONSAVEL_ARQ', String(idFornecedor)), campo('FL_TIPO_ARQ', '9'),
    Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="ARQUIVO"; filename="' + nomeArquivoSeguro(nome) + '"\r\nContent-Type: application/pdf\r\n\r\n', 'utf8'),
    buf, Buffer.from('\r\n--' + fronteira + '--\r\n', 'utf8'),
  ]);
  const c = corpoOk(await pedir(cred, 'POST', 'arquivos/', null, corpo, 'multipart/form-data; boundary=' + fronteira));
  const d = c.item && c.item.data && typeof c.item.data === 'object' ? c.item.data : null;
  const id = d && /^\d+$/.test(String(d.id_arquivo_arq || '')) ? String(d.id_arquivo_arq) : null;
  return { id: c.ok ? id : null, msg: c.msg };
}
// Corpo do POST despesas/ (formato da documentação, o mesmo que a T05 usa).
function corpoDespesa(d) {
  const p = new URLSearchParams();
  p.set('ID_CONDOMINIO_COND', String(d.id_superlogica));
  p.set('ID_CONTATO_CON', String(d.id_fornecedor));
  if (d.nome_fornecedor) p.set('ST_NOME_CON', d.nome_fornecedor);
  p.set('DT_VENCIMENTOPRIMEIRAPARCELA', isoParaSL(d.vencimento));
  p.set('ID_FORMA_PAG', String(d.forma_pag == null ? 0 : d.forma_pag));
  if (TIPOS_DOC_SL[d.tipo]) p.set('ID_TIPO_DOC', String(TIPOS_DOC_SL[d.tipo]));
  if (d.documento) p.set('ST_DOCUMENTO_DES', String(d.documento).slice(0, 25));
  if (d.emissao) p.set('DT_DESPESA_DES', isoParaSL(d.emissao));
  p.set('APROPRIACAO[0][ST_CONTA_CONT]', d.conta);
  p.set('APROPRIACAO[0][VL_VALOR_PDES]', d.valor.toFixed(2));
  if (d.complemento) p.set('APROPRIACAO[0][ST_COMPLEMENTO_APRO]', String(d.complemento).slice(0, 200));
  if (d.id_contabanco) p.set('ID_CONTABANCO_CB', String(d.id_contabanco));
  if (d.linha || d.barras) p.set('ST_CODIGOBARRAS_PDES', d.linha || d.barras);
  if (d.id_arquivo) p.set('ARQUIVOS[0][ID_ARQUIVO_ARQ]', String(d.id_arquivo));
  p.set('FL_ACAO_IMPRESSAO', '1');
  return p.toString();
}
// Lança a despesa com o PDF: envia o arquivo, cria a despesa já com o arquivo, anexa de novo se
// não ficou, põe a etiqueta e prova relendo. Devolve { ok, incerto, msg, id_despesa, id_parcela, id_arquivo, conferido }.
async function lancar(cred, cliente, d, pdf, nome) {
  const arq = await enviarArquivo(cred, d.id_fornecedor, pdf, nome);
  if (!arq.id) return { ok: false, incerto: false, msg: 'O Superlógica recusou o arquivo: ' + arq.msg };
  const r = await pedir(cred, 'POST', 'despesas/', null, Buffer.from(corpoDespesa(Object.assign({}, d, { id_arquivo: arq.id })), 'utf8'));
  const c = corpoOk(r);
  const dd = c.item && c.item.data && typeof c.item.data === 'object' ? c.item.data : {};
  const idDespesa = /^\d+$/.test(String(dd.id_despesa_des || '')) ? String(dd.id_despesa_des) : null;
  if (!c.ok || !idDespesa) {
    const incerto = r.status === 504 || r.status === 0;
    return { ok: false, incerto, msg: incerto ? 'O Superlógica não respondeu.' : 'O Superlógica recusou a despesa: ' + c.msg, id_arquivo: arq.id };
  }
  // Prova: relê a despesa pelo vencimento e confere valor, fornecedor e arquivo.
  let parc = null;
  const ler = async () => {
    const l = await paginas(cliente, 'despesas/index', { idCondominio: d.id_superlogica, comStatus: 'todas', dtInicio: isoParaSL(d.vencimento), dtFim: isoParaSL(d.vencimento) }, 10);
    return l.find((p) => String(p.id_despesa_des) === idDespesa) || null;
  };
  try { parc = await ler(); } catch (e) { parc = null; }
  let anexado = !!(parc && Array.isArray(parc.arquivos) && parc.arquivos.some((a) => String(a.id_arquivo_arq) === arq.id));
  if (parc && !anexado) {
    const ra = corpoOk(await pedir(cred, 'POST', 'despesas/anexar', { ID_DESPESA_DES: idDespesa, ID_PARCELA_PDES: parc.id_parcela_pdes, 'ARQUIVOS[0][ID_ARQUIVO_ARQ]': arq.id }, null));
    if (ra.ok) { try { parc = (await ler()) || parc; } catch (e) { /* fica a leitura anterior */ } }
    anexado = !!(parc && Array.isArray(parc.arquivos) && parc.arquivos.some((a) => String(a.id_arquivo_arq) === arq.id));
  }
  let etiqueta = null;
  if (anexado && ETIQUETA[d.tipo]) {
    const re = corpoOk(await pedir(cred, 'PUT', 'arquivos/adicionaretiqueta', null, Buffer.from(new URLSearchParams({ idDocumento: arq.id, idEtiqueta: String(ETIQUETA[d.tipo]) }).toString(), 'utf8')));
    etiqueta = re.ok;
  }
  const conferido = !!parc && Math.abs((Number(parc.vl_valor_pdes) || 0) - d.valor) < 0.005 && String(parc.id_contato_con) === String(d.id_fornecedor);
  return { ok: true, conferido, anexado, etiqueta, id_despesa: idDespesa, id_parcela: parc ? String(parc.id_parcela_pdes) : null, id_arquivo: arq.id,
    codigo_barras_gravado: parc ? !!soDig(parc.st_codigobarras_pdes) : null, msg: c.msg };
}

module.exports = {
  MAX_PDF_BYTES, NAO_CONDOMINIOS, TIPOS_DOC_SL, GRAVES, IMPEDE,
  cnpjValido, formatarCnpj, cnpjsDoTexto, linhaBoletoValida, linhaArrecValida, barrasDaLinha, vencimentoDoFator, acharLinha,
  lerDinheiro, brParaIso, isoParaSL, slParaIso, lerCampos, camposDaLeitura, chaveNota, faltaEssencial, juntarLeituras, classificar, acharDocumento, textoUtil, ehPdf, hashDe, extrairTexto,
  mapaCondominios, cadastroCondominios, cnpjsRepetidos, condominioPorId, fornecedorPorCnpj, fornecedorPorId, contasDoPlano, contaPrincipal, identificar,
  acharDuplicidades, contaSugerida, conferir, podeLancar, lancamentoLiberado, corpoDespesa, lancar, limparCache, nomeArquivoSeguro,
};
