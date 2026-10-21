'use strict';
// Utilidades do conector do banco (T36): dinheiro em centavos inteiros, datas e código de barras.
// Sem rede e sem credencial. Valores sempre em centavos para não errar conta com ponto flutuante.

const { dataISO } = require('../util');

// "12.345,67" | "12345.67" | 12345.67 | "-10,00" -> centavos (inteiro) ou null
function centavos(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v).trim().replace(/\s|R\$/g, '');
  if (!s) return null;
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 12.345 = doze mil (milhar sem centavos)
  else s = s.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// Campo numérico CNAB com 2 decimais implícitos -> centavos (inteiro, sem passar por float).
function centavosCnab(s) {
  const d = String(s || '').trim();
  if (!d || !/^\d+$/.test(d)) return null;
  return parseInt(d, 10);
}

const reais = (c) => (c === null || c === undefined ? null : Math.round(c) / 100);
const fmtBRL = (c) => (c === null || c === undefined ? '' : (c < 0 ? '-' : '') + 'R$ ' + (Math.abs(c) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.'));

// DDMMAAAA -> AAAA-MM-DD (ou null se zerado ou inválido)
function dataCnab(s) {
  const d = String(s || '').trim();
  if (!/^\d{8}$/.test(d) || /^0+$/.test(d)) return null;
  const iso = d.slice(4, 8) + '-' + d.slice(2, 4) + '-' + d.slice(0, 2);
  return dataValida(iso) ? iso : null;
}

function dataValida(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const t = new Date(iso + 'T12:00:00Z');
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso;
}

// Aceita AAAA-MM-DD, AAAA-MM-DDTHH:MM, DD/MM/AAAA (formatoBR) e MM/DD/AAAA do Superlógica (via util.dataISO).
function dataQualquer(v, { formatoBR } = {}) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return dataValida(m[1]) ? m[1] : null;
  if (formatoBR) {
    const b = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (b) { const iso = b[3] + '-' + b[2] + '-' + b[1]; return dataValida(iso) ? iso : null; }
  }
  return dataISO(s);
}

function diasEntre(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}

const soDigitos = (v) => String(v || '').replace(/\D/g, '');

// ── Código de barras e linha digitável ──────────────────────────────────
function mod10(num) {
  let soma = 0; let peso = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    let p = Number(num[i]) * peso;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    soma += p; peso = peso === 2 ? 1 : 2;
  }
  const r = soma % 10;
  return r === 0 ? 0 : 10 - r;
}

// Módulo 11 do boleto bancário (pesos 2 a 9; resultado 0, 10 ou 11 vira 1).
function mod11Boleto(num) {
  let soma = 0; let peso = 2;
  for (let i = num.length - 1; i >= 0; i--) { soma += Number(num[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const dv = 11 - (soma % 11);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

// Módulo 11 de arrecadação (concessionária): resto 0 ou 1 vira 0, resto 10 vira 1.
function mod11Arrec(num) {
  let soma = 0; let peso = 2;
  for (let i = num.length - 1; i >= 0; i--) { soma += Number(num[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11;
  if (r === 0 || r === 1) return 0;
  if (r === 10) return 1;
  return 11 - r;
}

// Linha digitável (47 boleto, 48 arrecadação) ou código de barras (44) -> código de barras de 44.
function codigoBarras(v) {
  const d = soDigitos(v);
  if (d.length === 44) return d;
  if (d.length === 47) return d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  if (d.length === 48 && d[0] === '8') return d.slice(0, 11) + d.slice(12, 23) + d.slice(24, 35) + d.slice(36, 47);
  return null;
}

// Código de barras de 44 -> linha digitável (só dígitos).
function linhaDigitavel(cb) {
  const d = codigoBarras(cb);
  if (!d) return null;
  if (d[0] === '8') {
    const usaMod10 = d[2] === '6' || d[2] === '7';
    return [0, 11, 22, 33].map((i) => d.slice(i, i + 11)).map((b) => b + (usaMod10 ? mod10(b) : mod11Arrec(b))).join('');
  }
  const c1 = d.slice(0, 4) + d.slice(19, 24);
  const c2 = d.slice(24, 34);
  const c3 = d.slice(34, 44);
  return c1 + mod10(c1) + c2 + mod10(c2) + c3 + mod10(c3) + d[4] + d.slice(5, 19);
}

// Confere o dígito geral do código de barras (boleto: posição 5; arrecadação: posição 4).
function codigoBarrasValido(cb) {
  const d = codigoBarras(cb);
  if (!d) return false;
  if (d[0] === '8') {
    const sem = d.slice(0, 3) + d.slice(4);
    const usaMod10 = d[2] === '6' || d[2] === '7';
    return Number(d[3]) === (usaMod10 ? mod10(sem) : mod11Arrec(sem));
  }
  return Number(d[4]) === mod11Boleto(d.slice(0, 4) + d.slice(5));
}

// Valor embutido no código de barras (centavos) ou null quando o código não traz valor.
function valorDoCodigo(cb) {
  const d = codigoBarras(cb);
  if (!d) return null;
  if (d[0] === '8') return (d[2] === '6' || d[2] === '8') ? parseInt(d.slice(4, 15), 10) : null;
  return parseInt(d.slice(9, 19), 10);
}

// Vencimento pelo fator (boleto). O fator recomeçou em 1000 no dia 22/02/2025;
// escolhe a data mais próxima da referência (data do pagamento).
function vencimentoDoCodigo(cb, referenciaISO) {
  const d = codigoBarras(cb);
  if (!d || d[0] === '8') return null;
  const f = parseInt(d.slice(5, 9), 10);
  if (!f) return null;
  const somar = (base, dias) => new Date(Date.parse(base + 'T12:00:00Z') + dias * 86400000).toISOString().slice(0, 10);
  const antiga = somar('1997-10-07', f);
  const nova = f >= 1000 ? somar('2025-02-22', f - 1000) : null;
  if (!nova) return antiga;
  const ref = referenciaISO || new Date().toISOString().slice(0, 10);
  return Math.abs(diasEntre(antiga, ref)) <= Math.abs(diasEntre(nova, ref)) ? antiga : nova;
}

// Mostra só o fim de um número de conta (nunca o número inteiro em relatório ou log).
function finalConta(v) {
  const d = soDigitos(v).replace(/^0+/, '');
  return d ? '***' + d.slice(-4) : null;
}

module.exports = {
  centavos, centavosCnab, reais, fmtBRL, dataCnab, dataValida, dataQualquer, diasEntre, soDigitos,
  mod10, mod11Boleto, mod11Arrec, codigoBarras, linhaDigitavel, codigoBarrasValido, valorDoCodigo, vencimentoDoCodigo, finalConta,
};
