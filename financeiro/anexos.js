'use strict';
// ─────────────────────────────────────────────────────────────────────────
// Leitura dos anexos das despesas (T32).
//
// Para cada despesa paga, baixa os anexos (comprovante, boleto, nota) pela API
// do Superlógica, extrai o texto do PDF com pdftotext e os metadados com
// pdfinfo, e confere contra o lançamento:
//   1. valor e data do comprovante contra vl_valor_pdes e dt_liquidacao_pdes;
//   2. linha digitável do boleto contra st_codigobarras_pdes;
//   3. CNPJ do pagador (comprovante) e do tomador (nota) contra o CNPJ do
//      condomínio; CNPJ de outro condomínio da carteira no documento;
//   4. metadados: PDF produzido por editor (Word, Photoshop, ilovepdf...) e
//      data de modificação depois da criação.
// PDF sem texto (escaneado) só é listado: não há leitura por imagem.
//
// Só leitura no Superlógica: todas as chamadas são GET. Sem rota e sem banco.
// Download: publico/downloadarquivo/?id=<id_arquivo_arq>&hash=<st_hash_arq>.
// ─────────────────────────────────────────────────────────────────────────
const https = require('https');
const { execFile } = require('child_process');

// Programas de edição ou conversão (sinal de documento montado ou alterado).
const EDITORES = /(microsoft[\s®:]*(word|excel|powerpoint|office)|\bword\b|photoshop|illustrator|indesign|\bgimp\b|ilovepdf|smallpdf|sejda|canva|pdfescape|pdf-?xchange|foxit\s*(phantom|editor|pdf editor)|nitro|wondershare|pdfelement|libreoffice|openoffice|google docs|pdf24|pdfcandy|soda pdf|acrobat (pro|dc|standard)|inkscape|pixelmator|affinity|pdf editor|camscanner)/i;
const MODIFICACAO_TOLERANCIA_S = 60;

// ── Download ───────────────────────────────────────────────────────────────
function baixarAnexo({ base, appToken, accessToken }, anexo) {
  return new Promise((resolve) => {
    const url = new URL(String(base).replace(/\/+$/, '') + '/v2/condor/publico/downloadarquivo/');
    url.searchParams.set('id', String(anexo.id_arquivo_arq));
    url.searchParams.set('hash', String(anexo.st_hash_arq || ''));
    const r = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
      headers: { app_token: appToken, access_token: accessToken } }, (resp) => {
      const partes = [];
      resp.on('data', (c) => partes.push(c));
      resp.on('error', () => resolve({ status: 0, corpo: Buffer.alloc(0), tipo: '' }));
      resp.on('aborted', () => resolve({ status: 0, corpo: Buffer.alloc(0), tipo: '' }));
      resp.on('end', () => resolve({ status: resp.statusCode, corpo: Buffer.concat(partes), tipo: resp.headers['content-type'] || '' }));
    });
    r.setTimeout(90000, () => { r.destroy(); resolve({ status: 504, corpo: Buffer.alloc(0), tipo: '' }); });
    r.on('error', () => resolve({ status: 0, corpo: Buffer.alloc(0), tipo: '' }));
    r.end();
  });
}

// O corpo é mesmo o arquivo? (erro vem como JSON ou HTML com HTTP 200)
function corpoValido(corpo, extensao) {
  if (!corpo || corpo.length < 8) return false;
  const ini = corpo.slice(0, 5).toString('latin1');
  if (String(extensao).toLowerCase() === 'pdf') return ini === '%PDF-';
  return !/^\s*[{<]/.test(corpo.slice(0, 64).toString('latin1'));
}

// ── Extração local (pdftotext e pdfinfo) ──────────────────────────────────
function rodar(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, saida: String(stdout || '') });
    });
  });
}

async function extrairPdf(caminho) {
  const [t, i] = await Promise.all([
    rodar('pdftotext', ['-layout', '-enc', 'UTF-8', caminho, '-']),
    rodar('pdfinfo', ['-isodates', caminho]),
  ]);
  const meta = {};
  i.saida.split('\n').forEach((l) => {
    const m = l.match(/^([A-Za-z ]+):\s*(.*)$/);
    if (m) meta[m[1].trim()] = m[2].trim();
  });
  return { ok: t.ok || i.ok, texto: t.saida, meta };
}

function legivel(texto) {
  return (String(texto || '').match(/[A-Za-z0-9]/g) || []).length >= 40;
}

// ── Leitores de campos no texto ───────────────────────────────────────────
function soDigitos(s) { return String(s || '').replace(/\D/g, ''); }

function valoresNoTexto(texto) {
  const out = new Set();
  const re = /(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2})(?!\d)/g;
  let m;
  while ((m = re.exec(texto))) out.add(Number(m[1].replace(/\./g, '').replace(',', '.')));
  return [...out];
}

function datasNoTexto(texto) {
  const out = new Set();
  let m;
  const re1 = /(?<!\d)(\d{2})[/.-](\d{2})[/.-](\d{4}|\d{2})(?!\d)/g;
  while ((m = re1.exec(texto))) {
    const ano = m[3].length === 2 ? '20' + m[3] : m[3];
    const d = Number(m[1]); const mes = Number(m[2]);
    if (d >= 1 && d <= 31 && mes >= 1 && mes <= 12) out.add(`${ano}-${m[2]}-${m[1]}`);
  }
  const re2 = /(?<!\d)(20\d{2})-(\d{2})-(\d{2})(?!\d)/g;
  while ((m = re2.exec(texto))) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  return [...out];
}

function cnpjValido(c) {
  const d = soDigitos(c);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = (n) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = pesos.reduce((a, p, i) => a + p * Number(d[i]), 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

// CNPJ formatado (00.000.000/0000-00) ou 14 dígitos logo depois da palavra CNPJ.
function cnpjsNoTexto(texto) {
  const out = new Set();
  let m;
  const re1 = /(?<!\d)(\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2})(?!\d)/g;
  while ((m = re1.exec(texto))) if (cnpjValido(m[1])) out.add(soDigitos(m[1]));
  const re2 = /CNPJ[^0-9]{0,20}(\d{14})(?!\d)/gi;
  while ((m = re2.exec(texto))) if (cnpjValido(m[1])) out.add(m[1]);
  return [...out];
}

// Linha digitável ou código de barras para os 44 dígitos do código de barras.
function codigoBarras44(s) {
  const d = soDigitos(s);
  if (d.length === 44) return d;
  if (d.length === 47) { // boleto bancário
    return d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  }
  if (d.length === 48) { // arrecadação (concessionária, imposto): tira o DV de cada bloco
    return d.slice(0, 11) + d.slice(12, 23) + d.slice(24, 35) + d.slice(36, 47);
  }
  return '';
}

function linhasNoTexto(texto) {
  const out = new Set();
  let m;
  const bancario = /(?<!\d)(\d{5}[.\s]?\d{5}\s+\d{5}[.\s]?\d{6}\s+\d{5}[.\s]?\d{6}\s+\d\s+\d{14})(?!\d)/g;
  while ((m = bancario.exec(texto))) out.add(codigoBarras44(m[1]));
  const arrec = /(?<!\d)(\d{11}[\s-]?\d\s+\d{11}[\s-]?\d\s+\d{11}[\s-]?\d\s+\d{11}[\s-]?\d)(?!\d)/g;
  while ((m = arrec.exec(texto))) out.add(codigoBarras44(m[1]));
  const corrido = /(?<!\d)(\d{44}|\d{47,48})(?!\d)/g;
  while ((m = corrido.exec(texto))) { const c = codigoBarras44(m[1]); if (c) out.add(c); }
  out.delete('');
  return [...out];
}

// ── Classificação e conferência ───────────────────────────────────────────
function etiquetaDoAnexo(a) {
  const nomes = [a.st_nomeabreviadoetiqueta_eti].concat((a.etiquetas || []).map((e) => e.st_nomeabreviadoetiqueta_eti));
  return nomes.filter(Boolean)[0] || '';
}

function tipoDoAnexo(a, texto) {
  const et = etiquetaDoAnexo(a).toLowerCase();
  if (et.includes('comprovante')) return 'comprovante';
  if (et.includes('pgto')) return 'boleto';
  if (et.includes('fiscal')) return 'nota';
  if (/or[cç]amento/.test(et)) return 'outro';
  const t = String(texto || '').toLowerCase();
  if (/nota fiscal|nfs-?e|danfe|tomador/.test(t)) return 'nota';
  if (/comprovante|transa[cç][aã]o efetuada|pagamento efetuado|autentica[cç][aã]o/.test(t)) return 'comprovante';
  if (/linha digit[aá]vel|benefici[aá]rio|vencimento/.test(t)) return 'boleto';
  return 'sem_etiqueta';
}

function isoDeMDY(s) { // MM/DD/AAAA do Superlógica
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : '';
}

function dataMeta(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(/([+-]\d{2})$/, '$1:00'));
  return isNaN(d) ? null : d;
}

function fmtValor(n) { return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function maisProximo(lista, alvo, dist) {
  let melhor = null; let dm = Infinity;
  lista.forEach((x) => { const d = dist(x, alvo); if (d < dm) { dm = d; melhor = x; } });
  return melhor;
}

// Confere um anexo já extraído. parcelas: linhas da despesa no período.
// cnpjCond: CNPJ do condomínio (dígitos). outros: Map cnpj -> nome dos demais.
function conferirAnexo({ anexo, texto, meta, parcelas, cnpjCond, outros }) {
  const tipo = tipoDoAnexo(anexo, texto);
  const achados = [];
  const ok = legivel(texto);
  // Metadados valem mesmo para PDF escaneado.
  if (meta) {
    const prod = [meta.Producer, meta.Creator].filter(Boolean).join(' | ');
    if (prod && EDITORES.test(prod)) achados.push({ tipo: 'pdf_editor', motivo: `PDF gerado por editor: ${prod}` });
    const c = dataMeta(meta.CreationDate); const m = dataMeta(meta.ModDate);
    if (c && m && (m - c) / 1000 > MODIFICACAO_TOLERANCIA_S) {
      achados.push({ tipo: 'pdf_modificado', motivo: `modificado depois de criado (criação ${meta.CreationDate}, modificação ${meta.ModDate})` });
    }
  }
  if (!ok) return { tipo, legivel: false, achados };

  const valoresDesp = [...new Set(parcelas.map((p) => Number(p.vl_valor_pdes)).filter((v) => v > 0))];
  const datasDesp = [...new Set(parcelas.map((p) => isoDeMDY(p.dt_liquidacao_pdes)).filter(Boolean))];
  const codDesp = [...new Set(parcelas.map((p) => codigoBarras44(p.st_codigobarras_pdes)).filter(Boolean))];
  const valores = valoresNoTexto(texto);
  const datas = datasNoTexto(texto);
  const cnpjs = cnpjsNoTexto(texto);

  // CNPJ de outro condomínio da carteira (vale para qualquer tipo de anexo).
  const deOutro = cnpjs.filter((c) => c !== cnpjCond && outros.has(c));
  if (deOutro.length && !cnpjs.includes(cnpjCond)) {
    achados.push({ tipo: 'cnpj_outro_condominio', motivo: `traz o CNPJ de ${deOutro.map((c) => outros.get(c)).join(', ')} e não o do condomínio` });
  }

  if (tipo === 'comprovante') {
    if (valoresDesp.length && !valores.some((v) => valoresDesp.some((d) => Math.abs(v - d) < 0.005))) {
      const prox = maisProximo(valores, valoresDesp[0], (a, b) => Math.abs(a - b));
      achados.push({ tipo: 'comprovante_valor', motivo: `valor da despesa R$ ${valoresDesp.map(fmtValor).join(' ou ')} não aparece no comprovante${prox != null ? ` (mais próximo R$ ${fmtValor(prox)})` : ' (nenhum valor lido)'}` });
    }
    if (datasDesp.length && datas.length && !datas.some((d) => datasDesp.includes(d))) {
      const alvo = Date.parse(datasDesp[0]);
      const prox = maisProximo(datas, alvo, (a, b) => Math.abs(Date.parse(a) - b));
      achados.push({ tipo: 'comprovante_data', motivo: `liquidação ${datasDesp.join(' ou ')} não aparece no comprovante (mais próxima ${prox})` });
    }
    if (cnpjCond && cnpjs.length && !cnpjs.includes(cnpjCond) && !deOutro.length) {
      achados.push({ tipo: 'comprovante_cnpj_pagador', motivo: `CNPJ do condomínio não aparece; CNPJs no comprovante: ${cnpjs.join(', ')}` });
    }
  }
  if (tipo === 'boleto') {
    const linhas = linhasNoTexto(texto);
    if (codDesp.length && linhas.length && !linhas.some((l) => codDesp.includes(l))) {
      achados.push({ tipo: 'boleto_linha', motivo: `linha digitável do boleto (${linhas[0]}) diferente da lançada (${codDesp[0]})` });
    }
  }
  if (tipo === 'nota') {
    if (cnpjCond && cnpjs.length && !cnpjs.includes(cnpjCond) && !deOutro.length) {
      achados.push({ tipo: 'nota_tomador', motivo: `CNPJ do condomínio não aparece como tomador; CNPJs na nota: ${cnpjs.join(', ')}` });
    }
  }
  return { tipo, legivel: true, achados, lidos: { valores: valores.length, datas: datas.length, cnpjs: cnpjs.length } };
}

module.exports = {
  baixarAnexo, corpoValido, extrairPdf, legivel, conferirAnexo,
  valoresNoTexto, datasNoTexto, cnpjsNoTexto, cnpjValido, codigoBarras44, linhasNoTexto, tipoDoAnexo, EDITORES,
};
