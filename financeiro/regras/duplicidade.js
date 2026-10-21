// R1 duplicidade e R2 condomínio trocado. Entrada: parcelas (liquidadas e pendentes) do despesas/index.
'use strict';
const U = require('./util');
const A = require('./alerta');

const JANELA_DIAS = 10;
const RX_LISTA_BRANCA = /\b(DIARISTA|FAXINEIR|FAXINA|PRESTADOR SEMANAL|SEMANAL)\b/;
const RX_DOC_NAO_NOTA = /^(UC|CONTRATO|CONT\b|INSTALACAO|CLIENTE|MATRICULA)/;
const RX_DOC_REFERENCIA = /^(\d{1,2}[\/.-]\d{2,4}|(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)[A-Z]*[\/ .-]?\d{0,4}|REF.*)$/;

// Uma parcela por id_parcela_pdes, fora os excluídos.
function unicas(itens) {
  const m = new Map();
  for (const it of itens || []) {
    if (!it || U.excluido(it)) continue;
    const k = String(it.id_parcela_pdes || '') || ('D' + it.id_despesa_des + '_' + it.dt_vencimento_pdes);
    if (!m.has(k)) m.set(k, it);
  }
  return [...m.values()];
}

// União de conjuntos para agrupar parcelas ligadas por documento ou código de barras.
function uniao(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const achar = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  return { achar, unir: (a, b) => { a = achar(a); b = achar(b); if (a !== b) p[b] = a; } };
}

function porChave(lista, chaveFn) {
  const m = new Map();
  lista.forEach((it, i) => { const k = chaveFn(it); if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(i); });
  return m;
}

function naListaBranca(it, opcoes) {
  const lb = (opcoes && opcoes.listaBranca) || [];
  const chaves = new Set(lb.map(String));
  if (chaves.has(String(it.id_contato_con)) || chaves.has(U.soDigitos(it.st_cpf_con))) return true;
  const txt = U.norm(it.st_nome_con) + ' ' + U.contasDe(it).join(' ');
  return RX_LISTA_BRANCA.test(txt);
}

function rotulo(it) {
  return 'despesa ' + it.id_despesa_des + ' (' + U.moeda(U.valor(it.vl_valor_pdes)) + ', venc. ' + U.dataTexto(U.data(it.dt_vencimento_pdes)) +
    (it.st_documento_des ? ', doc ' + String(it.st_documento_des).trim() : '') + ')';
}

// R1a: mesmo documento (do mesmo fornecedor) ou mesmo código de barras, no mesmo condomínio, em despesas diferentes.
function r1Documento(itens, ctx) {
  const lista = unicas(itens);
  const uf = uniao(lista.length);
  const ligar = (mapa) => { for (const idx of mapa.values()) for (let j = 1; j < idx.length; j++) uf.unir(idx[0], idx[j]); };
  ligar(porChave(lista, (it) => { const c = U.codigoBarras(it); return c ? it.id_condominio_cond + '|B|' + c : ''; }));
  // Concessionária usa o campo documento para a unidade consumidora (UC): só o código de barras vale para ela.
  ligar(porChave(lista, (it) => { const d = U.documento(it); return d && U.categoria(it) !== 'concessionaria' && !RX_DOC_NAO_NOTA.test(d) ? it.id_condominio_cond + '|D|' + U.fornecedorChave(it) + '|' + d : ''; }));
  const grupos = new Map();
  lista.forEach((it, i) => { const r = uf.achar(i); if (!grupos.has(r)) grupos.set(r, []); grupos.get(r).push(it); });
  const out = [];
  for (const g of grupos.values()) {
    const despesas = new Set(g.map((it) => String(it.id_despesa_des)));
    if (despesas.size < 2) continue; // parcelas da mesma despesa não são duplicidade
    const mesmoValor = new Set(g.map((it) => U.centavos(it.vl_valor_pdes))).size === 1;
    const vencs = g.map((it) => U.data(it.dt_vencimento_pdes)).filter(Boolean).sort();
    const perto = vencs.length > 1 && U.dias(vencs[0], vencs[vencs.length - 1]) <= 45;
    // Mesmo valor e perto: duplicidade provável. Mesmo valor e longe: pode ser contrato que repete o número. Valor diferente: conferir.
    const grav = mesmoValor ? (perto ? 'alta' : 'media') : 'baixa';
    const grupo = 'R1-' + g.map((it) => it.id_parcela_pdes).sort().join('-');
    for (const it of g) {
      const outros = g.filter((o) => o !== it && String(o.id_despesa_des) !== String(it.id_despesa_des));
      const porBarras = outros.some((o) => U.codigoBarras(o) && U.codigoBarras(o) === U.codigoBarras(it));
      out.push(A.deItem('R1', 'R1_DOCUMENTO', porBarras ? 'alta' : grav, it, ctx, {
        grupo, relacionados: outros.map((o) => String(o.id_despesa_des)),
        detalhe: (porBarras ? 'Mesmo código de barras' : 'Mesmo documento do mesmo fornecedor') + ' em ' + outros.map(rotulo).join('; '),
      }));
    }
  }
  return out;
}

// Prestador recorrente (semanal ou quinzenal): 3 ou mais lançamentos iguais com intervalo típico de 5 a 16 dias.
function recorrente(g) {
  const ds = [...new Set(g.map((it) => U.data(it.dt_vencimento_pdes)).filter(Boolean))].sort();
  if (ds.length < 3) return false;
  const gaps = ds.slice(1).map((d, i) => U.dias(ds[i], d)).sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  return med >= 3 && med <= 16;
}

// R1b: mesmo fornecedor e mesmo valor no mesmo condomínio com vencimentos a até 10 dias.
// Fora: concessionárias (várias unidades consumidoras, ex. ESCELSA R$ 39,48), impostos, folha e repasses,
// débito automático, lista branca (diaristas e prestadores semanais), recorrência semanal ou quinzenal,
// e pares com documentos ou códigos de barras diferentes (são contas distintas).
function r1FornecedorValor(itens, ctx, opcoes) {
  const lista = unicas(itens).filter((it) => U.categoria(it) === 'comum' && !naListaBranca(it, opcoes) && U.centavos(it.vl_valor_pdes) > 0);
  const jaR1 = new Set(((ctx && ctx.paresR1) || []));
  const grupos = porChave(lista, (it) => it.id_condominio_cond + '|' + U.fornecedorChave(it) + '|' + U.centavos(it.vl_valor_pdes));
  const out = [];
  for (const idx of grupos.values()) {
    if (idx.length < 2) continue;
    const g = idx.map((i) => lista[i]);
    const rec = recorrente(g);
    for (let a = 0; a < g.length; a++) {
      for (let b = a + 1; b < g.length; b++) {
        const x = g[a], y = g[b];
        if (String(x.id_despesa_des) === String(y.id_despesa_des)) continue;
        const d = Math.abs(U.dias(U.data(x.dt_vencimento_pdes), U.data(y.dt_vencimento_pdes)) ?? 999);
        if (d > JANELA_DIAS) continue;
        if (rec && d !== 0) continue;
        const dx = U.documento(x), dy = U.documento(y);
        if (dx && dy && dx !== dy) continue;
        const bx = U.codigoBarras(x), by = U.codigoBarras(y);
        if (bx && by && bx !== by) continue;
        if (jaR1.has(x.id_despesa_des + '|' + y.id_despesa_des) || (dx && dx === dy) || (bx && bx === by)) continue; // já é R1a
        const grupo = 'R1b-' + [x.id_parcela_pdes, y.id_parcela_pdes].sort().join('-');
        const grav = d === 0 ? 'alta' : 'media';
        out.push(A.deItem('R1', 'R1_FORNECEDOR_VALOR', grav, y, ctx, { grupo, relacionados: [String(x.id_despesa_des)], detalhe: d + ' dias de diferença no vencimento; par: ' + rotulo(x) }));
        out.push(A.deItem('R1', 'R1_FORNECEDOR_VALOR', grav, x, ctx, { grupo, relacionados: [String(y.id_despesa_des)], detalhe: d + ' dias de diferença no vencimento; par: ' + rotulo(y) }));
      }
    }
  }
  return out;
}

// R2: o mesmo código de barras, ou a mesma nota do mesmo fornecedor, lançado em dois condomínios diferentes.
function r2CondominioTrocado(itens, ctx) {
  const lista = unicas(itens);
  const out = [];
  const visto = new Set();
  const avaliar = (mapa, porBarras) => {
    for (const idx of mapa.values()) {
      const g = idx.map((i) => lista[i]);
      const conds = new Set(g.map((it) => String(it.id_condominio_cond)));
      if (conds.size < 2) continue;
      const grupo = 'R2-' + g.map((it) => it.id_parcela_pdes).sort().join('-');
      for (const it of g) {
        if (visto.has(it.id_parcela_pdes)) continue;
        visto.add(it.id_parcela_pdes);
        const outros = g.filter((o) => String(o.id_condominio_cond) !== String(it.id_condominio_cond));
        const mesmoValor = outros.some((o) => U.centavos(o.vl_valor_pdes) === U.centavos(it.vl_valor_pdes));
        out.push(A.deItem('R2', 'R2_CONDOMINIO_TROCADO', porBarras ? 'alta' : (mesmoValor ? 'media' : 'baixa'), it, ctx, {
          grupo, relacionados: outros.map((o) => String(o.id_despesa_des)),
          detalhe: (porBarras ? 'Mesmo código de barras' : 'Mesma nota do mesmo fornecedor') + ' também em ' +
            outros.map((o) => String(o.st_fantasia_cond || o.id_condominio_cond).trim() + ' ' + rotulo(o)).join('; '),
        }));
      }
    }
  };
  avaliar(porChave(lista, (it) => U.codigoBarras(it)), true);
  avaliar(porChave(lista, (it) => {
    const d = U.documento(it);
    if (!d || d.length < 3 || RX_DOC_REFERENCIA.test(d)) return '';
    const cat = U.categoria(it);
    if (cat === 'imposto' || cat === 'sem_nota') return '';
    return U.fornecedorChave(it) + '|' + d;
  }), false);
  return out;
}

module.exports = { r1Documento, r1FornecedorValor, r2CondominioTrocado, recorrente, unicas, naListaBranca };
