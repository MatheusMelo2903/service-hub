// R4 pago sem comprovante, R5 pago sem nota fiscal, R6 vencida sem baixa, R8 lançamento e anexo tardios.
'use strict';
const U = require('./util');
const A = require('./alerta');
const { unicas } = require('./duplicidade');

const liquidada = (it) => String(it.fl_liquidado_pdes || '') === '1' || !!U.data(it.dt_liquidacao_pdes);

// R4a: parcela paga sem arquivo com etiqueta Comprovante. Débito automático fica com gravidade baixa (o extrato comprova).
function r4SemComprovante(itens, ctx) {
  return unicas(itens).filter((it) => liquidada(it) && !U.temEtiqueta(it, 'Comprovante')).map((it) => {
    const da = String(it.id_forma_pag) === '7';
    const qtd = (it.arquivos || []).length;
    return A.deItem('R4', 'R4_SEM_COMPROVANTE', da ? 'baixa' : (U.valor(it.vl_valor_pdes) >= 1000 ? 'alta' : 'media'), it, ctx, {
      detalhe: (qtd ? qtd + ' anexo(s), nenhum como Comprovante' : 'Sem nenhum anexo') + (da ? '; débito automático' : ''),
    });
  });
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
  const hoje = (opcoes && opcoes.hoje) || new Date().toISOString().slice(0, 10);
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
      let pior = null;
      for (const a of it.arquivos || []) {
        if (!a || String(a.fl_excluido_arq || '') === '1') continue;
        const et = U.norm(a.st_nomeabreviadoetiqueta_eti);
        if (!['COMPROVANTE', 'DOC. FISCAL', 'DOC. PGTO'].includes(et)) continue;
        const d = U.dias(liq, U.data(a.dt_envio_arq));
        if (d !== null && d > 30 && (!pior || d > pior.d)) pior = { d, et: a.st_nomeabreviadoetiqueta_eti, envio: U.data(a.dt_envio_arq) };
      }
      if (pior) {
        // Nota ou boleto tardio pesa mais que comprovante tardio (comprovante costuma subir em lote depois).
        const comp = U.norm(pior.et) === 'COMPROVANTE';
        const gravA = comp ? (pior.d > 90 ? 'media' : 'baixa') : (pior.d > 90 ? 'alta' : 'media');
        out.push(A.deItem('R8', 'R8_ANEXO_TARDIO', gravA, it, ctx, {
          dias_atraso: pior.d, dt_anexo: pior.envio, detalhe: pior.et + ' anexado ' + pior.d + ' dias depois do pagamento',
        }));
      }
      const dp = U.dias(venc, liq);
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
