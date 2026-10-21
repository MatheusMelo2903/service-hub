// Teste das regras do auditor financeiro (T25). Uso: node scripts/financeiro-regras-teste.js [pasta com JSON reais da T23]
// Casos sintéticos no formato da API + verificação com os JSON reais (fora do git), se a pasta existir.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rodarRegras, util: U, duplicidade: D } = require('../financeiro/regras');

let ok = 0, falhas = 0;
function caso(nome, fn) {
  try { fn(); ok++; console.log('ok   ' + nome); } catch (e) { falhas++; console.log('FALHA ' + nome + ': ' + e.message); }
}
let seq = 1000;
// Parcela no formato do despesas/index.
function p(o = {}) {
  const id = ++seq;
  return {
    id_condominio_cond: '10', st_fantasia_cond: 'COND TESTE', id_despesa_des: String(id), id_parcela_pdes: String(id + 50000),
    id_contato_con: '500', st_nome_con: 'FORNECEDOR COMUM LTDA', st_cpf_con: '11222333000144', st_documento_des: '',
    st_codigobarras_pdes: '', dt_geracao_des: '05/01/2026 00:00:00', dt_vencimento_pdes: '05/10/2026 00:00:00',
    dt_liquidacao_pdes: '05/10/2026 00:00:00', fl_liquidado_pdes: '1', vl_valor_pdes: '100.00', vl_juros_pdes: '0.00', vl_multa_pdes: '0.00',
    id_forma_pag: '0', apropriacao: [{ st_descricao_cont: ' Serviço Manutenção' }],
    arquivos: [{ st_nomeabreviadoetiqueta_eti: 'Comprovante', dt_envio_arq: '05/10/2026' }, { st_nomeabreviadoetiqueta_eti: 'Doc. Fiscal', dt_envio_arq: '05/02/2026' }],
    documentos_pendentes: [], ...o,
  };
}
const rodar = (despesas, auditoria = [], regras) => rodarRegras({ despesas, auditoria }, { hoje: '2026-10-21', regras }).alertas;
const de = (al, tipo) => al.filter((a) => a.tipo === tipo);
const CAMPOS = ['regra', 'tipo', 'gravidade', 'id_condominio', 'condominio', 'analista', 'fornecedor', 'documento', 'valor', 'id_despesa', 'id_parcela', 'detalhe'];

// ---------- R1 ----------
caso('R1a mesmo documento do mesmo fornecedor em despesas diferentes: alta', () => {
  const al = de(rodar([p({ st_documento_des: 'NF 4521' }), p({ st_documento_des: '4521', dt_vencimento_pdes: '05/20/2026' })], [], ['R1']), 'R1_DOCUMENTO');
  assert.strictEqual(al.length, 2); assert.ok(al.every((a) => a.gravidade === 'alta'));
  assert.ok(CAMPOS.every((c) => c in al[0]), 'campos do alerta');
});
caso('R1a parcelas da mesma despesa não são duplicidade', () => {
  const a = p({ st_documento_des: '77' }); const b = { ...a, id_parcela_pdes: '999999', dt_vencimento_pdes: '06/10/2026' };
  assert.strictEqual(rodar([a, b], [], ['R1']).length, 0);
});
caso('R1a mesmo código de barras no mesmo condomínio', () => {
  const cb = '7569'.repeat(11) + '1'; // código de barras fictício (47 dígitos)
  const al = de(rodar([p({ st_codigobarras_pdes: cb }), p({ st_codigobarras_pdes: cb, id_contato_con: '9', st_cpf_con: '' })], [], ['R1']), 'R1_DOCUMENTO');
  assert.strictEqual(al.length, 2);
});
caso('R1a concessionária com o mesmo número de UC não é duplicidade', () => {
  const o = { st_nome_con: 'ESCELSA', st_documento_des: 'UC: 0.002.434.053.054-65', apropriacao: [{ st_descricao_cont: 'Energia' }] };
  assert.strictEqual(rodar([p(o), p({ ...o, dt_vencimento_pdes: '06/10/2026' })], [], ['R1']).length, 0);
});
caso('R1a mesmo documento com valores diferentes: baixa', () => {
  const al = rodar([p({ st_documento_des: '63' }), p({ st_documento_des: '63', vl_valor_pdes: '250.00' })], [], ['R1']);
  assert.ok(al.length === 2 && al.every((a) => a.gravidade === 'baixa'));
});
caso('R1b mesmo fornecedor e valor em 4 dias: alerta', () => {
  assert.strictEqual(de(rodar([p(), p({ dt_vencimento_pdes: '05/14/2026' })], [], ['R1']), 'R1_FORNECEDOR_VALOR').length, 2);
});
caso('R1b mais de 10 dias: sem alerta', () => {
  assert.strictEqual(rodar([p(), p({ dt_vencimento_pdes: '05/25/2026' })], [], ['R1']).length, 0);
});
caso('R1b ESCELSA R$ 39,48 em várias unidades consumidoras: sem alerta', () => {
  const o = { st_nome_con: 'ESCELSA', st_cpf_con: '28152650000171', vl_valor_pdes: '39.48', apropriacao: [{ st_descricao_cont: ' Energia' }] };
  assert.strictEqual(rodar([p(o), p(o), p({ ...o, dt_vencimento_pdes: '05/12/2026' })], [], ['R1']).length, 0);
});
caso('R1b diarista e lista branca: sem alerta', () => {
  assert.strictEqual(rodar([p({ st_nome_con: 'MARIA DIARISTA' }), p({ st_nome_con: 'MARIA DIARISTA', dt_vencimento_pdes: '05/12/2026' })], [], ['R1']).length, 0);
  const al = rodarRegras({ despesas: [p({ id_contato_con: '777' }), p({ id_contato_con: '777', st_cpf_con: '', dt_vencimento_pdes: '05/12/2026' })] }, { hoje: '2026-10-21', regras: ['R1'], listaBranca: ['777', '11222333000144'] }).alertas;
  assert.strictEqual(al.length, 0);
});
caso('R1b prestador semanal (mesmo valor toda semana): sem alerta', () => {
  const v = ['05/04/2026', '05/11/2026', '05/18/2026', '05/25/2026'].map((d) => p({ id_contato_con: '321', st_cpf_con: '', dt_vencimento_pdes: d }));
  assert.strictEqual(rodar(v, [], ['R1']).length, 0);
});
caso('R1b documentos diferentes preenchidos: sem alerta', () => {
  assert.strictEqual(rodar([p({ st_documento_des: '10' }), p({ st_documento_des: '11', dt_vencimento_pdes: '05/12/2026' })], [], ['R1']).length, 0);
});
caso('R1b folha, imposto e débito automático ficam fora', () => {
  const casos = [{ st_nome_con: 'FOLHA DE PAGTO', apropriacao: [{ st_descricao_cont: 'Salários Funcionários' }] }, { st_nome_con: 'PM SERRA', apropriacao: [{ st_descricao_cont: 'ISS' }] }, { id_forma_pag: '7' }];
  for (const o of casos) assert.strictEqual(rodar([p(o), p({ ...o, dt_vencimento_pdes: '05/11/2026' })], [], ['R1']).length, 0, JSON.stringify(o));
});

// ---------- R2 e exclusões ----------
caso('R2 mesmo código de barras em dois condomínios: alta', () => {
  const cb = '8467'.repeat(11); // código de barras fictício (44 dígitos)
  const al = de(rodar([p({ st_codigobarras_pdes: cb }), p({ st_codigobarras_pdes: cb, id_condominio_cond: '20', st_fantasia_cond: 'OUTRO' })], [], ['R2']), 'R2_CONDOMINIO_TROCADO');
  assert.strictEqual(al.length, 2); assert.ok(al.every((a) => a.gravidade === 'alta'));
});
caso('R2 mesma nota do mesmo fornecedor em dois condomínios: media', () => {
  const al = rodar([p({ st_documento_des: '2642' }), p({ st_documento_des: '2642', id_condominio_cond: '20' })], [], ['R2']);
  assert.ok(al.length === 2 && al.every((a) => a.gravidade === 'media'));
});
caso('Condomínios excluídos (143, 144, 145, 160, 162) e teste 167 ficam fora', () => {
  for (const id of ['143', '144', '145', '160', '162', '167']) {
    const al = rodar([p({ id_condominio_cond: id, st_documento_des: '1' }), p({ id_condominio_cond: id, st_documento_des: '1', arquivos: [] }), p({ id_condominio_cond: id, fl_liquidado_pdes: '0', dt_liquidacao_pdes: '' })]);
    assert.strictEqual(al.length, 0, 'id ' + id);
  }
});

// ---------- R4, R5, R6, R8 ----------
caso('R4 paga sem comprovante; débito automático baixa; com comprovante nada', () => {
  const al = de(rodar([p({ arquivos: [] }), p({ arquivos: [], id_forma_pag: '7' }), p()], [], ['R4']), 'R4_SEM_COMPROVANTE');
  assert.strictEqual(al.length, 2); assert.ok(al.some((a) => a.gravidade === 'baixa'));
});
caso('R4 anexo marcado como excluído não conta como comprovante', () => {
  const al = rodar([p({ arquivos: [{ st_nomeabreviadoetiqueta_eti: 'Comprovante', fl_excluido_arq: '1' }, { st_nomeabreviadoetiqueta_eti: 'Doc. Fiscal' }] })], [], ['R4']);
  assert.strictEqual(al.length, 1);
});
caso('R5 sem nota: comum entra; concessionária, imposto, débito automático e folha não', () => {
  const semNF = [{ st_nomeabreviadoetiqueta_eti: 'Comprovante', dt_envio_arq: '05/10/2026' }];
  const al = rodar([
    p({ arquivos: semNF }),
    p({ arquivos: semNF, st_nome_con: 'COMPANHIA ESPIRITO SANTENSE DE SANEAMENTO CESAN', apropriacao: [{ st_descricao_cont: 'Água-Esgoto' }] }),
    p({ arquivos: semNF, st_nome_con: 'RECEITA FEDERAL', apropriacao: [{ st_descricao_cont: 'DARF INSS' }] }),
    p({ arquivos: semNF, id_forma_pag: '7' }),
    p({ arquivos: semNF, st_nome_con: 'FOLHA DE PAGTO', apropriacao: [{ st_descricao_cont: 'Salários Funcionários' }] }),
  ], [], ['R5']);
  assert.strictEqual(al.length, 1); assert.strictEqual(al[0].fornecedor, 'FORNECEDOR COMUM LTDA');
});
caso('R6 vencida sem baixa; a vencer não', () => {
  const pend = { fl_liquidado_pdes: '0', dt_liquidacao_pdes: '' };
  const al = rodar([p({ ...pend, dt_vencimento_pdes: '09/01/2026' }), p({ ...pend, dt_vencimento_pdes: '10/25/2026' }), p({ ...pend, dt_vencimento_pdes: '10/21/2026' })], [], ['R6']);
  assert.strictEqual(al.length, 1); assert.strictEqual(al[0].gravidade, 'alta'); assert.strictEqual(al[0].dias_atraso, 50);
});
caso('R8 lançamento tardio, anexo tardio e paga com atraso sem juros', () => {
  const al = rodar([p({ dt_geracao_des: '05/20/2026', dt_vencimento_pdes: '05/10/2026', dt_liquidacao_pdes: '05/12/2026',
    arquivos: [{ st_nomeabreviadoetiqueta_eti: 'Doc. Fiscal', dt_envio_arq: '07/01/2026' }, { st_nomeabreviadoetiqueta_eti: 'Comprovante', dt_envio_arq: '05/12/2026' }] })], [], ['R8']);
  const tipos = al.map((a) => a.tipo).sort();
  assert.deepStrictEqual(tipos, ['R8_ANEXO_TARDIO', 'R8_LANCAMENTO_TARDIO', 'R8_PAGO_ATRASO']);
  assert.strictEqual(al.find((a) => a.tipo === 'R8_ANEXO_TARDIO').dias_atraso, 50);
});
caso('R8 com juros registrados não é pago com atraso sem juros', () => {
  const al = rodar([p({ dt_liquidacao_pdes: '05/15/2026', vl_juros_pdes: '1.20' })], [], ['R8']);
  assert.strictEqual(de(al, 'R8_PAGO_ATRASO').length, 0);
});

// ---------- Auditoria: R4b, R9 e analista ----------
const linha = (texto, o = {}) => ({ id_auditoria_aud: String(++seq), dt_data_aud: '10/15/2026 10:00:00', id_usuario_usu: '102', st_apelido_usu: 'Analista A', st_sql_aud: '10', st_fantasia_cond: 'COND TESTE', st_texto_aud: texto, ...o });
caso('R4b anexo removido de despesa paga, sem troca: alta; com troca no mesmo dia: media', () => {
  const d1 = p({ dt_liquidacao_pdes: '10/01/2026' }); const d2 = p({ dt_liquidacao_pdes: '10/01/2026' });
  const aud = [linha('Arquivo#1 removido da despesa#' + d1.id_despesa_des + '.', { st_sql_aud: '-1' }), linha('Arquivo#2 removido da despesa#' + d2.id_despesa_des + '.'), linha('Arquivo#3 vinculado a despesa#' + d2.id_despesa_des + '.')];
  const al = de(rodar([d1, d2], aud, ['R4']), 'R4_ANEXO_REMOVIDO');
  assert.strictEqual(al.length, 2);
  assert.strictEqual(al.find((a) => a.id_despesa === d1.id_despesa_des).gravidade, 'alta');
  assert.strictEqual(al.find((a) => a.id_despesa === d2.id_despesa_des).gravidade, 'media');
  assert.strictEqual(al[0].id_condominio, '10'); assert.strictEqual(al[0].usuario, 'Analista A');
});
caso('R4b anexo removido antes do pagamento vira R9 remoção de anexo', () => {
  const d = p({ dt_liquidacao_pdes: '10/20/2026' });
  const al = rodar([d], [linha('Arquivo#9 removido da despesa#' + d.id_despesa_des + '.')], ['R4', 'R9']).filter((a) => a.regra === 'R9' || a.tipo === 'R4_ANEXO_REMOVIDO');
  assert.strictEqual(al.length, 1); assert.strictEqual(al[0].mexida, 'Remoção de anexo');
});
caso('R9 valor e vencimento no mesmo texto: dois eventos com valores certos', () => {
  const al = rodar([], [linha('Parcela#334996 da despesa#306120  alterada. Valor: de R$ 4143,26 para R$ 5592,54.Vencimento: de 19/10/2026 para 20/10/2026.')], ['R9']);
  assert.strictEqual(al.length, 2);
  const v = al.find((a) => a.mexida === 'Alteração de valor');
  assert.strictEqual(v.gravidade, 'alta'); assert.ok(v.detalhe.includes('4.143,26') && v.detalhe.includes('5.592,54'), v.detalhe);
  assert.strictEqual(v.valor, 5592.54);
  assert.strictEqual(al.find((a) => a.mexida === 'Alteração de vencimento').gravidade, 'baixa');
});
caso('R9 estorno, exclusão, cancelamento e troca de fornecedor', () => {
  const al = rodar([], [
    linha('Parcela#332974 da despesa#304209 estornada. Valor R$ 1677,00 venc. 20/10/2026.'),
    linha('Parcela#336213 da despesa#307139  excluída. Valor R$ 59,80 venc. 11/11/2026.'),
    linha('O pagamento da parcela#336213 da despesa#307139 foi cancelado.'),
    linha('Despesa#307122 alterada. Contato: de GV PETROS para NS COMERCIO DE PARAFUSOS LTDA ME. Consumo total de  para 0;'),
    linha('[SUDO] Parcela#1 da despesa#2 estornada. Valor R$ 10,00 venc. 20/10/2026.'),
  ], ['R9']);
  assert.deepStrictEqual(al.map((a) => a.mexida).sort(), ['Estorno', 'Exclusão de parcela', 'Pagamento cancelado', 'Troca de fornecedor']);
  assert.strictEqual(al.find((a) => a.mexida === 'Estorno').gravidade, 'alta');
  assert.strictEqual(al.find((a) => a.mexida === 'Troca de fornecedor').gravidade, 'alta');
});
caso('R9 exclusão pelo mesmo usuário no dia em que lançou: baixa (provável correção)', () => {
  const al = rodar([], [linha('Despesa#555 criada.'), linha('Despesa#555 excluída.', { dt_data_aud: '10/15/2026 10:05:00' })], ['R9']);
  assert.strictEqual(al.length, 1); assert.strictEqual(al[0].gravidade, 'baixa');
});
caso('Analista: último usuário na despesa; sem isso, quem mais lançou no condomínio', () => {
  const d1 = p({ arquivos: [] }); const d2 = p({ arquivos: [] });
  const aud = [linha('Despesa#' + d1.id_despesa_des + ' criada.', { st_apelido_usu: 'Daiane' }), linha('Despesa#' + d1.id_despesa_des + ' alterada.', { st_apelido_usu: 'Kely', dt_data_aud: '10/16/2026 09:00:00' }),
    linha('Despesa#888 criada.', { st_apelido_usu: 'Daiane' }), linha('Despesa#889 criada.', { st_apelido_usu: 'Sistema', id_usuario_usu: '999996' })];
  const al = de(rodar([d1, d2], aud, ['R4']), 'R4_SEM_COMPROVANTE');
  assert.strictEqual(al.find((a) => a.id_despesa === d1.id_despesa_des).analista, 'Kely');
  const a2 = al.find((a) => a.id_despesa === d2.id_despesa_des);
  assert.strictEqual(a2.analista, 'Daiane'); assert.strictEqual(a2.analista_origem, 'quem mais lançou no condomínio');
});
caso('Utilitários: datas e valores', () => {
  assert.strictEqual(U.data('05/20/2026 00:00:00'), '2026-05-20'); assert.strictEqual(U.data('2026-10-09 00:00:00'), '2026-10-09');
  assert.strictEqual(U.valorBR('4.143,26'), 4143.26); assert.strictEqual(U.dataBR('19/10/2026'), '2026-10-19');
  assert.strictEqual(U.documento({ st_documento_des: 'NF 00123' }), '123'); assert.strictEqual(U.documento({ st_documento_des: 'S/N' }), '');
  assert.strictEqual(D.recorrente([{ dt_vencimento_pdes: '05/01/2026' }, { dt_vencimento_pdes: '05/08/2026' }, { dt_vencimento_pdes: '05/15/2026' }]), true);
});

// ---------- Dados reais da T23 (fora do git) ----------
const REAIS = process.argv[2] || '/Users/matheusmelo/v8s/EXECUCAO/testes/T23/saida';
const ARQ_DESP = path.join(REAIS, 'cobr_04_a_desp_liq_mes_cm1.json');   // liquidadas 01 a 15/09, carteira inteira
const ARQ_PEND = path.join(REAIS, 'falta_02_b_desp_pend_abr_out_cm1.json');
const ARQ_AUD = path.join(REAIS, 'falta_08_f_aud_dia_util_cm1.json');    // auditoria 20/10
if (fs.existsSync(ARQ_DESP) && fs.existsSync(ARQ_AUD)) {
  const desp = JSON.parse(fs.readFileSync(ARQ_DESP, 'utf8'));
  const pend = fs.existsSync(ARQ_PEND) ? JSON.parse(fs.readFileSync(ARQ_PEND, 'utf8')) : [];
  const audR = JSON.parse(fs.readFileSync(ARQ_AUD, 'utf8'));
  const t0 = Date.now();
  const al = rodar([...desp, ...pend], audR);
  const ms = Date.now() - t0;
  caso('Reais: roda em menos de 10 s e todo alerta tem os campos', () => {
    assert.ok(ms < 10000, ms + ' ms');
    assert.ok(al.length > 0);
    for (const a of al) for (const c of CAMPOS) assert.ok(c in a, c + ' faltando em ' + a.tipo);
    assert.ok(al.every((a) => ['alta', 'media', 'baixa'].includes(a.gravidade)));
  });
  caso('Reais: nenhum alerta dos ids excluídos nem do 167', () => {
    assert.ok(al.every((a) => !['143', '144', '145', '160', '162', '167'].includes(String(a.id_condominio))));
  });
  caso('Reais: ESCELSA nunca aparece na R1 por fornecedor e valor', () => {
    assert.strictEqual(al.filter((a) => a.tipo === 'R1_FORNECEDOR_VALOR' && /ESCELSA|EDP/.test(a.fornecedor)).length, 0);
  });
  caso('Reais: R5 não traz concessionária, imposto nem débito automático', () => {
    const r5 = al.filter((a) => a.tipo === 'R5_SEM_NOTA');
    assert.ok(r5.length > 0);
    assert.ok(r5.every((a) => a.forma_pagamento !== '7' && !/ESCELSA|CESAN|RECEITA FEDERAL|FOLHA DE PAGTO/.test(a.fornecedor)));
  });
  caso('Reais: R9 e R4b só com eventos de despesa e com usuário', () => {
    const r9 = al.filter((a) => a.regra === 'R9' || a.tipo === 'R4_ANEXO_REMOVIDO');
    assert.ok(r9.length > 0);
    assert.ok(r9.every((a) => a.usuario && a.quando && /despesa/i.test(a.texto_auditoria)));
  });
  const cont = {}; al.forEach((a) => { cont[a.tipo] = (cont[a.tipo] || 0) + 1; });
  console.log('reais: ' + desp.length + ' liquidadas, ' + pend.length + ' pendentes, ' + audR.length + ' linhas de auditoria, ' + al.length + ' alertas em ' + ms + ' ms', JSON.stringify(cont));
} else {
  console.log('aviso: JSON reais da T23 não encontrados em ' + REAIS + ' (casos reais pulados)');
}

console.log('\n' + ok + ' ok, ' + falhas + ' falhas');
process.exit(falhas ? 1 : 0);
