// R4 pago sem comprovante, R5 pago sem nota fiscal, R6 vencida sem baixa, R8 lançamento e anexo tardios.
'use strict';
const U = require('./util');
const A = require('./alerta');
const { unicas } = require('./duplicidade');

const liquidada = (it) => String(it.fl_liquidado_pdes || '') === '1' || !!U.data(it.dt_liquidacao_pdes);

// R4a: parcela paga sem comprovante. Os arquivos ficam na despesa (todas as parcelas trazem a mesma lista):
// conta os comprovantes da despesa contra as parcelas pagas; as pagas por último além dessa conta ficam sem comprovante.
// Débito automático fica com gravidade baixa (o extrato comprova).
function r4SemComprovante(itens, ctx) {
  const porDesp = new Map();
  for (const it of unicas(itens)) {
    if (!liquidada(it)) continue;
    const k = String(it.id_despesa_des);
    if (!porDesp.has(k)) porDesp.set(k, []);
    porDesp.get(k).push(it);
  }
  const out = [];
  for (const pagas of porDesp.values()) {
    const comp = (pagas[0].arquivos || []).filter((a) => a && String(a.fl_excluido_arq || '') !== '1' && U.norm(a.st_nomeabreviadoetiqueta_eti) === 'COMPROVANTE').length;
    if (comp >= pagas.length) continue;
    pagas.sort((a, b) => String(U.data(a.dt_liquidacao_pdes)).localeCompare(String(U.data(b.dt_liquidacao_pdes))) || String(a.id_parcela_pdes).localeCompare(String(b.id_parcela_pdes)));
    for (const it of pagas.slice(comp)) {
      const da = String(it.id_forma_pag) === '7';
      const qtd = (it.arquivos || []).length;
      out.push(A.deItem('R4', 'R4_SEM_COMPROVANTE', da ? 'baixa' : (U.valor(it.vl_valor_pdes) >= 1000 ? 'alta' : 'media'), it, ctx, {
        detalhe: (comp ? 'Despesa com ' + pagas.length + ' parcelas pagas e só ' + comp + ' comprovante(s)' : (qtd ? qtd + ' anexo(s), nenhum como Comprovante' : 'Sem nenhum anexo')) + (da ? '; débito automático' : ''),
      }));
    }
  }
  return out;
}

// R5: parcela paga sem Doc. Fiscal, fora concessionárias, impostos, débito automático e folha ou repasses.
function r5SemNota(itens, ctx) {
  const out = [];
  for (const it of unicas(itens)) {
    if (!liquidada(it) || U.temEtiqueta(it, 'Doc. Fiscal')) continue;
    if (U.categoria(it) !== 'comum') continue;
    const pend = (it.documentos_pendentes || []).some((p) => /fiscal/i.test(p && p.descricao));
    out.push(A.deItem('R5', 'R5_SEM_NOTA', U.valor(it.vl_valor_pdes) >= 1000 ? 'alta' : 'media', it, ctx, {
      detalhe: 'Sem arquivo com etiqueta Doc. Fiscal' + (pend ? ' (o Superlógica marca documento fiscal pendente)' : '') + '; conta: ' + (U.contasDe(it).join(', ') || '[sem apropriação]'),
    }));
  }
  return out;
}

// R6: parcela pendente com vencimento antes de hoje.
function r6Vencida(itens, ctx, opcoes) {
  const hoje = (opcoes && opcoes.hoje) || U.hojeSP();
  const out = [];
  for (const it of unicas(itens)) {
    if (liquidada(it)) continue;
    const v = U.data(it.dt_vencimento_pdes);
    const atraso = U.dias(v, hoje);
    if (atraso === null || atraso < 1) continue;
    out.push(A.deItem('R6', 'R6_VENCIDA', atraso > 30 ? 'alta' : (atraso > 5 ? 'media' : 'baixa'), it, ctx, {
      dias_atraso: atraso, detalhe: 'Vencida há ' + atraso + ' dias sem baixa',
    }));
  }
  return out;
}

// R8a: despesa lançada (dt_geracao_des) depois do vencimento da parcela. Débito automático fica fora.
// R8b: anexo (Comprovante, Doc. Fiscal ou Doc. Pgto) enviado mais de 30 dias depois do pagamento.
// R8c: paga depois do vencimento sem juros nem multa registrados (dt_liquidacao é pouco confiável: baixa em lote).
function r8Tardios(itens, ctx) {
  const out = [];
  for (const it of unicas(itens)) {
    const da = String(it.id_forma_pag) === '7';
    const venc = U.data(it.dt_vencimento_pdes), lanc = U.data(it.dt_geracao_des), liq = U.data(it.dt_liquidacao_pdes);
    const dl = U.dias(venc, lanc);
    if (!da && dl !== null && dl >= 1) {
      out.push(A.deItem('R8', 'R8_LANCAMENTO_TARDIO', dl > 30 ? 'alta' : (dl > 5 ? 'media' : 'baixa'), it, ctx, {
        dias_atraso: dl, detalhe: 'Lançada ' + dl + ' dias depois do vencimento',
      }));
    }
    if (liquidada(it) && liq) {
      // Arquivos são da despesa: por etiqueta vale o primeiro envio (reenvio ou anexo de outra parcela não conta como atraso).
      const primeiro = new Map();
      for (const a of it.arquivos || []) {
        if (!a || String(a.fl_excluido_arq || '') === '1') continue;
        const et = U.norm(a.st_nomeabreviadoetiqueta_eti);
        const envio = U.data(a.dt_envio_arq);
        if (!['COMPROVANTE', 'DOC. FISCAL', 'DOC. PGTO'].includes(et) || !envio) continue;
        if (!primeiro.has(et) || envio < primeiro.get(et).envio) primeiro.set(et, { envio, et: a.st_nomeabreviadoetiqueta_eti });
      }
      let pior = null;
      for (const x of primeiro.values()) {
        const d = U.dias(liq, x.envio);
        if (d !== null && d > 30 && (!pior || d > pior.d)) pior = { d, et: x.et, envio: x.envio };
      }
      if (pior) {
        // Nota ou boleto tardio pesa mais que comprovante tardio (comprovante costuma subir em lote depois).
        const comp = U.norm(pior.et) === 'COMPROVANTE';
        const gravA = comp ? (pior.d > 90 ? 'media' : 'baixa') : (pior.d > 90 ? 'alta' : 'media');
        out.push(A.deItem('R8', 'R8_ANEXO_TARDIO', gravA, it, ctx, {
          dias_atraso: pior.d, dt_anexo: pior.envio, detalhe: pior.et + ' anexado ' + pior.d + ' dias depois do pagamento',
        }));
      }
      // Vencimento em fim de semana pago no dia útil seguinte não é atraso.
      let dp = U.dias(venc, liq);
      if (dp !== null && dp >= 1 && dp <= 2) { const wd = new Date(venc + 'T12:00:00Z').getUTCDay(); if ((wd === 6 && dp <= 2) || (wd === 0 && dp <= 1)) dp = 0; }
      const encargos = U.valor(it.vl_juros_pdes) + U.valor(it.vl_multa_pdes);
      if (!da && dp !== null && dp >= 1 && encargos === 0) {
        out.push(A.deItem('R8', 'R8_PAGO_ATRASO', dp > 5 ? 'media' : 'baixa', it, ctx, {
          dias_atraso: dp, detalhe: 'Paga ' + dp + ' dias depois do vencimento, sem juros ou multa registrados (conferir se houve encargo no boleto)',
        }));
      }
    }
  }
  return out;
}

module.exports = { r4SemComprovante, r5SemNota, r6Vencida, r8Tardios, liquidada };
