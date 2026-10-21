'use strict';
// Utilidades do conector financeiro: datas do Superlógica, números e janelas de período.

// Cadastros que não são condomínio: ficam fora de toda cópia e análise.
const EXCLUIDOS = new Set([143, 144, 145, 160, 162]);
const excluido = (id) => EXCLUIDOS.has(Number(id));

const dois = (n) => String(n).padStart(2, '0');

// Aceita "10/01/2026", "10/01/2026 00:00:00" (MM/DD/AAAA) e "2026-10-09 00:00:00".
// Devolve "AAAA-MM-DD" ou null.
function dataISO(v) {
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return valida(+m[3], +m[1], +m[2]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return valida(+m[1], +m[2], +m[3]);
  return null;
}
function valida(y, mo, d) {
  if (!(y > 1900 && y < 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return y + '-' + dois(mo) + '-' + dois(d);
}

// Data e hora da auditoria ("10/20/2026 17:52:25", horário de Brasília) em ISO com fuso.
function dataHoraISO(v) {
  const s = String(v == null ? '' : v).trim();
  const d = dataISO(s);
  if (!d) return null;
  const h = s.match(/(\d{2}):(\d{2}):(\d{2})/);
  return d + 'T' + (h ? h[1] + ':' + h[2] + ':' + h[3] : '00:00:00') + '-03:00';
}

// "AAAA-MM-DD" -> "MM/DD/AAAA" (formato que a API recebe).
function dataSL(iso) {
  const [y, m, d] = iso.split('-');
  return m + '/' + d + '/' + y;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function int(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}
function txt(v, max = 500) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : null;
}

function somaDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.getUTCFullYear() + '-' + dois(dt.getUTCMonth() + 1) + '-' + dois(dt.getUTCDate());
}
function diasEntre(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

// Quebra [inicio, fim] em janelas de até n dias (n=1: um dia por janela).
function janelasDias(inicio, fim, n) {
  const out = [];
  let a = inicio;
  while (a <= fim) {
    let b = somaDias(a, n - 1);
    if (b > fim) b = fim;
    out.push([a, b]);
    a = somaDias(b, 1);
  }
  return out;
}
// Quebra por quinzena do calendário (1 a 15 e 16 ao fim do mês).
function janelasQuinzena(inicio, fim) {
  const out = [];
  let a = inicio;
  while (a <= fim) {
    const [y, m, d] = a.split('-').map(Number);
    const ult = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let b = d <= 15 ? y + '-' + dois(m) + '-15' : y + '-' + dois(m) + '-' + dois(ult);
    if (b > fim) b = fim;
    out.push([a, b]);
    a = somaDias(b, 1);
  }
  return out;
}
// Quebra por mês do calendário.
function janelasMes(inicio, fim) {
  const out = [];
  let a = inicio;
  while (a <= fim) {
    const [y, m] = a.split('-').map(Number);
    let b = y + '-' + dois(m) + '-' + dois(new Date(Date.UTC(y, m, 0)).getUTCDate());
    if (b > fim) b = fim;
    out.push([a, b]);
    a = somaDias(b, 1);
  }
  return out;
}

function hojeBR() {
  const d = new Date(Date.now() - 3 * 3600000);
  return d.getUTCFullYear() + '-' + dois(d.getUTCMonth() + 1) + '-' + dois(d.getUTCDate());
}

const ehISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dataISO(s) === s;

module.exports = {
  EXCLUIDOS, excluido, dataISO, dataHoraISO, dataSL, num, int, txt,
  somaDias, diasEntre, janelasDias, janelasQuinzena, janelasMes, hojeBR, ehISO,
};
