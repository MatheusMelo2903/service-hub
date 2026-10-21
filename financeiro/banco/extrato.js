'use strict';
// Extrato do banco (T36): normaliza a resposta da API do Sicoob e o extrato CNAB 240 (segmento E),
// converte para OFX (o mesmo arquivo que a equipe importa no Superlógica) e para o formato de
// itens da conciliação (T35). Tudo sem rede. Valores internos em centavos.

const crypto = require('crypto');
const C = require('./comum');

// Formato de item da conciliação (combinar com a T35 na integração; ver FORMATO_ITEM):
//   { origem, id_banco, data, tipo: 'C'|'D', valor (reais, com sinal), valor_centavos (com sinal),
//     descricao, documento, id_condominio, id_conta }
const FORMATO_ITEM = ['origem', 'id_banco', 'data', 'tipo', 'valor', 'valor_centavos', 'descricao', 'documento', 'id_condominio', 'id_conta'];

const limpa = (s, n) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 200);

function primeiro(o, nomes) {
  for (const n of nomes) if (o && o[n] !== undefined && o[n] !== null && o[n] !== '') return o[n];
  return undefined;
}

function tipoDe(t, valorCent) {
  const s = String(t || '').trim().toUpperCase();
  if (/^(C|CREDITO|CRÉDITO|CREDIT)$/.test(s)) return 'C';
  if (/^(D|DEBITO|DÉBITO|DEBIT)$/.test(s)) return 'D';
  if (valorCent !== null && valorCent < 0) return 'D';
  return valorCent === null ? null : 'C';
}

function idEstavel(partes) {
  return crypto.createHash('sha1').update(partes.join('|')).digest('hex').slice(0, 20);
}

// Conferência do extrato: saldo anterior + créditos - débitos = saldo atual (em centavos).
function conferirSaldos(ext) {
  const cred = ext.itens.filter((i) => i.tipo === 'C').reduce((s, i) => s + i.centavos, 0);
  const deb = ext.itens.filter((i) => i.tipo === 'D').reduce((s, i) => s + i.centavos, 0);
  const r = { creditos_centavos: cred, debitos_centavos: deb, fecha: null, diferenca_centavos: null };
  if (ext.saldoAnteriorCentavos !== null && ext.saldoAtualCentavos !== null) {
    r.diferenca_centavos = ext.saldoAnteriorCentavos + cred - deb - ext.saldoAtualCentavos;
    r.fecha = r.diferenca_centavos === 0;
  }
  return r;
}

// Resposta da API do Sicoob -> { saldoAnteriorCentavos, saldoAtualCentavos, itens: [{ data, tipo, centavos (positivo), descricao, documento, id }], avisos }
// Os nomes exatos dos campos estão [a confirmar]; aceita as variações mais prováveis.
function normalizarExtratoSicoob(resposta) {
  const raiz = resposta && (resposta.resultado || resposta.dados || resposta);
  const lista = (raiz && (raiz.transacoes || raiz.lancamentos || raiz.movimentos)) || (Array.isArray(raiz) ? raiz : []);
  const avisos = [];
  const itens = [];
  lista.forEach((t, i) => {
    const bruto = C.centavos(primeiro(t, ['valor', 'valorLancamento', 'vlLancamento']));
    const tipo = tipoDe(primeiro(t, ['tipo', 'tipoLancamento', 'natureza', 'creditoDebito']), bruto);
    const data = C.dataQualquer(primeiro(t, ['data', 'dataLancamento', 'dataMovimento', 'dataLote']), { formatoBR: true });
    if (bruto === null || !tipo || !data) { avisos.push('transação ' + (i + 1) + ' sem valor, tipo ou data; ignorada'); return; }
    const descricao = limpa([primeiro(t, ['descricao', 'historico', 'descricaoHistorico']), primeiro(t, ['descInfComplementar', 'complemento', 'informacaoComplementar'])].filter(Boolean).join(' '), 200);
    const documento = limpa(primeiro(t, ['numeroDocumento', 'documento', 'nrDocumento']), 40);
    itens.push({ data, tipo, centavos: Math.abs(bruto), descricao, documento, seq: i });
  });
  const ext = {
    saldoAnteriorCentavos: C.centavos(primeiro(raiz, ['saldoAnterior', 'saldoInicial'])),
    saldoAtualCentavos: C.centavos(primeiro(raiz, ['saldoAtual', 'saldoFinal'])),
    itens: comIds(itens, 'sicoob_api'),
    avisos,
  };
  ext.conferencia = conferirSaldos(ext);
  if (ext.conferencia.fecha === false) ext.avisos.push('saldo anterior mais créditos menos débitos não fecha com o saldo atual');
  return ext;
}

// Id estável por lançamento; repete-se quando o mesmo lançamento vem de novo em outra puxada
// (o sequencial entra só para separar dois lançamentos iguais no mesmo dia).
function comIds(itens, origem) {
  const vistos = new Map();
  return itens.map((i) => {
    const base = [origem, i.data, i.tipo, i.centavos, i.documento, i.descricao].join('|');
    const n = (vistos.get(base) || 0) + 1; vistos.set(base, n);
    const { seq, ...resto } = i;
    return { ...resto, id: idEstavel([base, n]) };
  });
}

// ── Extrato CNAB 240 do Sicoob (segmento E), alternativa à API ─────────────
function lerExtratoCnab240(texto) {
  const linhas = String(texto || '').split(/\r?\n/).map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  const avisos = [];
  const contas = [];
  let atual = null;
  linhas.forEach((l, n) => {
    if (l.length !== 240) avisos.push('linha ' + (n + 1) + ' com ' + l.length + ' posições (esperado 240)');
    const r = l.padEnd(240, ' ');
    const tipoReg = r[7];
    if (tipoReg === '1') {
      atual = { conta_final: C.finalConta(r.slice(58, 70)), saldoAnteriorCentavos: sinal(C.centavosCnab(r.slice(150, 168)), r[168]), dataSaldoInicial: C.dataCnab(r.slice(142, 150)), saldoAtualCentavos: null, itens: [] };
      contas.push(atual);
    } else if (tipoReg === '3' && r[13] === 'E' && atual) {
      const tipo = r[168] === 'D' ? 'D' : r[168] === 'C' ? 'C' : null;
      const cent = C.centavosCnab(r.slice(150, 168));
      const data = C.dataCnab(r.slice(142, 150));
      if (!tipo || cent === null || !data) { avisos.push('linha ' + (n + 1) + ' segmento E sem valor, tipo ou data'); return; }
      atual.itens.push({ data, tipo, centavos: cent, descricao: limpa(r.slice(176, 201), 60), documento: limpa(r.slice(201, 240), 40), categoria: r.slice(169, 172).trim(), seq: atual.itens.length });
    } else if (tipoReg === '5' && atual) {
      atual.saldoAtualCentavos = sinal(C.centavosCnab(r.slice(150, 168)), r[168]);
      atual.dataSaldoFinal = C.dataCnab(r.slice(142, 150));
    }
  });
  contas.forEach((c) => {
    c.itens = comIds(c.itens, 'cnab240');
    c.conferencia = conferirSaldos(c);
    c.avisos = c.conferencia.fecha === false ? ['saldo inicial mais créditos menos débitos não fecha com o saldo final'] : [];
  });
  return { contas, avisos };
}
const sinal = (cent, dc) => (cent === null ? null : dc === 'D' ? -cent : cent);

// ── Conversões ────────────────────────────────────────────────────────────
function paraConciliacao(ext, { idCondominio, idConta, origem } = {}) {
  return ext.itens.map((i) => ({
    origem: origem || 'banco',
    id_banco: i.id,
    data: i.data,
    tipo: i.tipo,
    valor: C.reais(i.tipo === 'D' ? -i.centavos : i.centavos),
    valor_centavos: i.tipo === 'D' ? -i.centavos : i.centavos,
    descricao: i.descricao,
    documento: i.documento || null,
    id_condominio: idCondominio === undefined ? null : idCondominio,
    id_conta: idConta === undefined ? null : idConta,
  }));
}

const ascii = (s, n) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, ' ').replace(/[<>&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const dtOfx = (iso) => iso.replace(/-/g, '') + '120000[-3:BRT]';
const valOfx = (cent) => (cent < 0 ? '-' : '') + (Math.abs(cent) / 100).toFixed(2);

// OFX 1.02 (SGML), o formato que os bancos entregam e o Superlógica importa.
// agencia e conta só entram no arquivo gerado para a pessoa importar; nunca em log.
function paraOFX(ext, { banco = '756', agencia = '', conta = '', tipoConta = 'CHECKING', geradoEm } = {}) {
  if (!ext.itens.length) throw new Error('extrato_vazio');
  const datas = ext.itens.map((i) => i.data).sort();
  const agora = geradoEm || new Date().toISOString().slice(0, 10);
  const trn = ext.itens.map((i) => [
    '<STMTTRN>',
    '<TRNTYPE>' + (i.tipo === 'D' ? 'DEBIT' : 'CREDIT'),
    '<DTPOSTED>' + dtOfx(i.data),
    '<TRNAMT>' + valOfx(i.tipo === 'D' ? -i.centavos : i.centavos),
    '<FITID>' + i.id,
    i.documento ? '<CHECKNUM>' + ascii(i.documento, 20) : null,
    '<MEMO>' + (ascii(i.descricao, 80) || 'LANCAMENTO'),
    '</STMTTRN>',
  ].filter(Boolean).join('\n')).join('\n');
  const saldo = ext.saldoAtualCentavos === null ? null : ext.saldoAtualCentavos;
  return [
    'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '',
    '<OFX>', '<SIGNONMSGSRSV1>', '<SONRS>', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>', '<DTSERVER>' + dtOfx(agora), '<LANGUAGE>POR', '</SONRS>', '</SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1>', '<STMTTRNRS>', '<TRNUID>1', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>', '<STMTRS>', '<CURDEF>BRL',
    '<BANKACCTFROM>', '<BANKID>' + C.soDigitos(banco), '<BRANCHID>' + C.soDigitos(agencia), '<ACCTID>' + C.soDigitos(conta), '<ACCTTYPE>' + tipoConta, '</BANKACCTFROM>',
    '<BANKTRANLIST>', '<DTSTART>' + dtOfx(datas[0]), '<DTEND>' + dtOfx(datas[datas.length - 1]),
    trn,
    '</BANKTRANLIST>',
    saldo === null ? null : ['<LEDGERBAL>', '<BALAMT>' + valOfx(saldo), '<DTASOF>' + dtOfx(datas[datas.length - 1]), '</LEDGERBAL>'].join('\n'),
    '</STMTRS>', '</STMTTRNRS>', '</BANKMSGSRSV1>', '</OFX>', '',
  ].filter((x) => x !== null).join('\n');
}

// Leitor simples de OFX (SGML ou XML) para conferir o que foi gerado e ler arquivos do banco.
function lerOFX(texto) {
  const s = String(texto || '');
  const tag = (bloco, nome) => { const m = bloco.match(new RegExp('<' + nome + '>([^<\\r\\n]*)', 'i')); return m ? m[1].trim() : null; };
  const itens = [];
  const re = /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi;
  let m;
  while ((m = re.exec(s))) {
    const b = m[1];
    const cent = C.centavos(tag(b, 'TRNAMT'));
    const dt = (tag(b, 'DTPOSTED') || '').slice(0, 8);
    const data = /^\d{8}$/.test(dt) ? dt.slice(0, 4) + '-' + dt.slice(4, 6) + '-' + dt.slice(6, 8) : null;
    if (cent === null || !data || !C.dataValida(data)) continue;
    itens.push({ data, tipo: cent < 0 ? 'D' : 'C', centavos: Math.abs(cent), descricao: limpa(tag(b, 'MEMO') || tag(b, 'NAME'), 200), documento: limpa(tag(b, 'CHECKNUM') || '', 40), id: tag(b, 'FITID') });
  }
  const bal = s.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]+)/i);
  return { banco: tag(s, 'BANKID'), conta_final: C.finalConta(tag(s, 'ACCTID')), saldoAnteriorCentavos: null, saldoAtualCentavos: bal ? C.centavos(bal[1].trim()) : null, itens };
}

module.exports = { normalizarExtratoSicoob, lerExtratoCnab240, paraConciliacao, paraOFX, lerOFX, conferirSaldos, FORMATO_ITEM };
