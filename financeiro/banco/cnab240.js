'use strict';
// Leitor do arquivo de RETORNO de pagamentos CNAB 240 (FEBRABAN e guia do Sicoob) e conferência
// pagamento x despesa do Superlógica por código de barras ou linha digitável, valor e data.
// Posições em testes/T36/documentacao.md. Sem rede; números de conta saem só com o final.

const C = require('./comum');

const OCORRENCIAS = {
  '00': 'Pagamento efetivado',
  BD: 'Incluído e agendado',
  PD: 'Pendente de assinatura',
  AJ: 'Rejeitado: estrutura do arquivo',
  BF: 'Rejeitado por falta de assinatura',
  BS: 'Em análise de segurança',
  '01': 'Saldo insuficiente',
  '02': 'Cancelado pelo pagador',
  AN: 'Pix: tipo de conta do favorecido inválido',
  AP: 'Pix: data de lançamento inválida',
  PA: 'Pix não efetivado',
  PC: 'Pix: conta do recebedor inválida ou bloqueada',
  PE: 'Pix: transação não suportada na conta',
  PG: 'Pix: CPF ou CNPJ do recebedor incorreto',
  PH: 'Pix: rejeitado pelo recebedor',
  PI: 'Pix: ISPB inválido',
  PJ: 'Pix: chave não cadastrada',
  PK: 'Pix: QR Code inválido ou vencido',
  ZJ: 'Pix: limite de pagamentos parciais excedido',
};
const FORMAS = { '01': 'Crédito em conta', '05': 'Crédito em poupança', '11': 'Concessionária ou tributo com código de barras', '41': 'TED outra titularidade', '43': 'TED mesma titularidade', '30': 'Título do próprio banco', '31': 'Título de outro banco', '45': 'Pix transferência', '47': 'Pix QR Code' };

const campo = (r, ini, fim) => r.slice(ini - 1, fim); // posições do manual (1 a 240)
const txt = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function ocorrencias(s) {
  const bruto = String(s || '').replace(/\s+$/, '');
  const lista = [];
  for (let i = 0; i < bruto.length; i += 2) {
    const c = bruto.slice(i, i + 2).trim();
    if (c) lista.push({ codigo: c, texto: OCORRENCIAS[c] || 'Código ' + c + ' (ver manual do banco)' });
  }
  return lista;
}

// lerRetornoPagamento(texto) -> { arquivo, lotes, pagamentos, avisos, erros }
function lerRetornoPagamento(texto) {
  const linhas = String(texto || '').split(/\n/).map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  const avisos = []; const erros = [];
  const out = { arquivo: null, lotes: [], pagamentos: [], avisos, erros };
  if (!linhas.length) { erros.push('arquivo vazio'); return out; }
  let lote = null;
  let ultimo = null;
  let regsArquivo = 0;
  linhas.forEach((l, idx) => {
    const n = idx + 1;
    if (l.length !== 240) avisos.push('linha ' + n + ' com ' + l.length + ' posições (esperado 240)');
    if (l.length > 240) { erros.push('linha ' + n + ' maior que 240 posições; ignorada'); return; }
    const r = l.padEnd(240, ' ');
    regsArquivo++;
    const tipo = r[7];
    if (tipo === '0') {
      out.arquivo = {
        banco: campo(r, 1, 3), cnpj_empresa: C.soDigitos(campo(r, 19, 32)) || null, convenio: txt(campo(r, 33, 52)) || null,
        conta_final: C.finalConta(campo(r, 59, 70)), empresa: txt(campo(r, 73, 102)), nome_banco: txt(campo(r, 103, 132)),
        retorno: campo(r, 143, 143) === '2', data_geracao: C.dataCnab(campo(r, 144, 151)), nsa: parseInt(campo(r, 158, 163), 10) || null,
        versao: campo(r, 164, 166).trim(),
      };
      if (!out.arquivo.retorno) avisos.push('o arquivo é de remessa (enviado ao banco), não de retorno; nada nele confirma pagamento');
    } else if (tipo === '1') {
      if (lote) avisos.push('lote ' + lote.numero + ' sem trailer antes do lote seguinte');
      lote = { numero: campo(r, 4, 7), operacao: campo(r, 9, 9), servico: campo(r, 10, 11), forma: campo(r, 12, 13), forma_texto: FORMAS[campo(r, 12, 13)] || null, versao: campo(r, 14, 16).trim(), registros: 0, soma_centavos: 0, trailer: null };
      out.lotes.push(lote);
    } else if (tipo === '3') {
      if (!lote) { erros.push('linha ' + n + ' detalhe fora de lote'); return; }
      lote.registros++;
      const seg = r[13];
      const base = { lote: lote.numero, seq: parseInt(campo(r, 9, 13), 10), segmento: seg, forma: lote.forma, tipo_movimento: campo(r, 15, 15), instrucao: campo(r, 16, 17), linha: n };
      if (seg === 'A') {
        const p = { ...base, favorecido: txt(campo(r, 44, 73)), banco_favorecido: campo(r, 21, 23), conta_favorecido_final: C.finalConta(campo(r, 30, 41)),
          seu_numero: txt(campo(r, 74, 93)) || null, data_pagamento: C.dataCnab(campo(r, 94, 101)), valor_centavos: C.centavosCnab(campo(r, 120, 134)),
          nosso_numero: txt(campo(r, 135, 154)) || null, data_real: C.dataCnab(campo(r, 155, 162)), valor_real_centavos: C.centavosCnab(campo(r, 163, 177)),
          codigo_barras: null, ocorrencias: ocorrencias(campo(r, 231, 240)) };
        fechar(p); out.pagamentos.push(p); ultimo = p; lote.soma_centavos += p.valor_centavos || 0;
      } else if (seg === 'J' && campo(r, 18, 19) === '52' && !C.codigoBarrasValido(C.soDigitos(campo(r, 18, 61)))) {
        const alvo = ultimo && ultimo.segmento === 'J' && ultimo.lote === lote.numero ? ultimo : null;
        if (!alvo) { avisos.push('linha ' + n + ' J52 sem segmento J antes'); return; }
        alvo.pagador_doc = C.soDigitos(campo(r, 21, 35)) || null;
        alvo.pagador_nome = txt(campo(r, 36, 75)) || null;
        alvo.beneficiario_doc = C.soDigitos(campo(r, 77, 91)) || null;
        alvo.beneficiario_nome = txt(campo(r, 92, 131)) || null;
        ajustarDoc(alvo, 'pagador_doc', campo(r, 20, 20));
        ajustarDoc(alvo, 'beneficiario_doc', campo(r, 76, 76));
      } else if (seg === 'J') {
        const cb = C.soDigitos(campo(r, 18, 61));
        const p = { ...base, codigo_barras: cb.length === 44 ? cb : null, codigo_barras_valido: cb.length === 44 ? C.codigoBarrasValido(cb) : false,
          favorecido: txt(campo(r, 62, 91)), vencimento: C.dataCnab(campo(r, 92, 99)), valor_titulo_centavos: C.centavosCnab(campo(r, 100, 114)),
          desconto_centavos: C.centavosCnab(campo(r, 115, 129)), acrescimo_centavos: C.centavosCnab(campo(r, 130, 144)),
          data_pagamento: C.dataCnab(campo(r, 145, 152)), valor_centavos: C.centavosCnab(campo(r, 153, 167)),
          seu_numero: txt(campo(r, 183, 202)) || null, nosso_numero: txt(campo(r, 203, 222)) || null, ocorrencias: ocorrencias(campo(r, 231, 240)) };
        if (p.codigo_barras && !p.codigo_barras_valido) avisos.push('linha ' + n + ' código de barras com dígito verificador inválido');
        fechar(p); out.pagamentos.push(p); ultimo = p; lote.soma_centavos += p.valor_centavos || 0;
      } else if (seg === 'O') {
        const cb = C.soDigitos(campo(r, 18, 61));
        const p = { ...base, codigo_barras: cb.length === 44 ? cb : null, codigo_barras_valido: cb.length === 44 ? C.codigoBarrasValido(cb) : false,
          favorecido: txt(campo(r, 62, 91)), vencimento: C.dataCnab(campo(r, 92, 99)), data_pagamento: C.dataCnab(campo(r, 100, 107)),
          valor_centavos: C.centavosCnab(campo(r, 108, 122)), seu_numero: txt(campo(r, 123, 142)) || null, nosso_numero: txt(campo(r, 143, 162)) || null,
          ocorrencias: ocorrencias(campo(r, 231, 240)) };
        fechar(p); out.pagamentos.push(p); ultimo = p; lote.soma_centavos += p.valor_centavos || 0;
      } else if (seg === 'N') {
        const p = { ...base, codigo_barras: null, seu_numero: txt(campo(r, 18, 37)) || null, nosso_numero: txt(campo(r, 38, 57)) || null,
          favorecido: txt(campo(r, 58, 87)), data_pagamento: C.dataCnab(campo(r, 88, 95)), valor_centavos: C.centavosCnab(campo(r, 96, 110)),
          ocorrencias: ocorrencias(campo(r, 231, 240)) };
        fechar(p); out.pagamentos.push(p); ultimo = p; lote.soma_centavos += p.valor_centavos || 0;
      } else {
        // B (dados do favorecido), Z (autenticação) e outros: não mudam valor nem data.
      }
    } else if (tipo === '5') {
      if (!lote) { erros.push('linha ' + n + ' trailer de lote sem lote'); return; }
      lote.trailer = { registros: parseInt(campo(r, 18, 23), 10), soma_centavos: C.centavosCnab(campo(r, 24, 41)), ocorrencias: ocorrencias(campo(r, 231, 240)) };
      // A soma do trailer conta os valores informados no lote; conferir com o que foi lido.
      if (lote.trailer.soma_centavos !== null && lote.trailer.soma_centavos !== lote.soma_centavos) avisos.push('lote ' + lote.numero + ': soma do trailer ' + C.fmtBRL(lote.trailer.soma_centavos) + ' diferente da soma lida ' + C.fmtBRL(lote.soma_centavos));
      if (Number.isInteger(lote.trailer.registros) && lote.trailer.registros !== lote.registros + 2) avisos.push('lote ' + lote.numero + ': trailer informa ' + lote.trailer.registros + ' registros, lidos ' + (lote.registros + 2));
      lote = null;
    } else if (tipo === '9') {
      const tot = parseInt(campo(r, 24, 29), 10);
      if (Number.isInteger(tot) && tot !== regsArquivo) avisos.push('trailer do arquivo informa ' + tot + ' registros, lidos ' + regsArquivo);
    } else {
      avisos.push('linha ' + n + ' com tipo de registro desconhecido');
    }
  });
  if (!out.arquivo) erros.push('arquivo sem header (não parece CNAB 240)');
  if (lote) avisos.push('lote ' + lote.numero + ' sem trailer');
  // Remessa não confirma nada: nenhum pagamento conta como efetivado, agendado ou rejeitado.
  if (!out.arquivo || !out.arquivo.retorno) out.pagamentos.forEach((p) => { p.efetivado = false; p.agendado = false; p.rejeitado = false; });
  return out;
}

function ajustarDoc(p, k, tipoInsc) {
  const d = p[k];
  if (!d) return;
  // Campo de 15 posições com zeros à esquerda: CPF fica com 11, CNPJ com 14.
  p[k] = tipoInsc === '1' ? d.slice(-11) : d.slice(-14);
  if (/^0+$/.test(p[k])) p[k] = null;
}

// Situação pela ocorrência (00 efetivado); arquivo de remessa é zerado no fim da leitura.
function fechar(p) {
  const cods = p.ocorrencias.map((o) => o.codigo);
  p.efetivado = cods.includes('00');
  p.agendado = !p.efetivado && cods.includes('BD');
  p.rejeitado = !p.efetivado && !p.agendado && cods.length > 0 && !cods.includes('PD') && !cods.includes('BS');
  // Valor e data que de fato saíram da conta: os "reais" do segmento A quando vierem preenchidos.
  p.valor_pago_centavos = p.valor_real_centavos ? p.valor_real_centavos : p.valor_centavos;
  p.data_efetiva = p.data_real || p.data_pagamento || null;
  p.linha_digitavel = p.codigo_barras ? C.linhaDigitavel(p.codigo_barras) : null;
}

// ── Conferência pagamento x despesa ─────────────────────────────────────
// Despesa no formato bruto do Superlógica (vl_valor_pdes, dt_liquidacao_pdes, st_codigobarras_pdes...)
// ou no formato fin_parcelas (valor, dt_liquidacao, codigo_barras, liquidada).
function despesaParaConferir(d) {
  const bruto = d.vl_valor_pdes !== undefined || d.id_parcela_pdes !== undefined;
  const cb = C.codigoBarras(bruto ? d.st_codigobarras_pdes : d.codigo_barras);
  return {
    id_parcela: Number(bruto ? d.id_parcela_pdes : d.id_parcela) || null,
    id_despesa: Number(bruto ? d.id_despesa_des : d.id_despesa) || null,
    id_condominio: Number(bruto ? d.id_condominio_cond : d.id_condominio) || null,
    fornecedor: txt(bruto ? d.st_nome_con : d.fornecedor) || null,
    fornecedor_doc: C.soDigitos(bruto ? (d.st_cpf_con || d.st_cnpj_con) : d.fornecedor_cnpj) || null,
    documento: txt(bruto ? d.st_documento_des : d.documento) || null,
    valor_centavos: C.centavos(bruto ? d.vl_valor_pdes : d.valor),
    vencimento: C.dataQualquer(bruto ? d.dt_vencimento_pdes : d.dt_vencimento),
    liquidacao: C.dataQualquer(bruto ? d.dt_liquidacao_pdes : d.dt_liquidacao),
    liquidada: bruto ? (String(d.fl_liquidado_pdes) === '1' || !!C.dataQualquer(d.dt_liquidacao_pdes)) : (d.liquidada === true || /^(1|true|sim)$/i.test(String(d.liquidada || '')) || (d.liquidada === undefined && !!d.dt_liquidacao)),
    codigo_barras: cb,
  };
}

// conferirPagamentos(retorno ou lista de pagamentos, despesas, { toleranciaDias, cnpjCondominio })
// Casamento em fases sobre TODOS os pagamentos (a ordem do arquivo não muda o resultado):
//   1) código de barras igual; 2) seu número só numérico igual ao id da parcela (ou, se não houver,
//   ao id da despesa); 3) só para efetivados: valor exato e data em até toleranciaDias, se for único.
// Não efetivados só casam pelas fases 1 e 2, para não acusar baixa errada em despesa de outro boleto.
function conferirPagamentos(retornoOuLista, despesas, opcoes) {
  const o = { toleranciaDias: 5, ...(opcoes || {}) };
  const pags = Array.isArray(retornoOuLista) ? retornoOuLista : (retornoOuLista && retornoOuLista.pagamentos) || [];
  const desp = (despesas || []).map(despesaParaConferir);
  const usadas = new Set();
  const casou = new Map(); // índice do pagamento -> { idx, como } | { ambiguo, como }
  const cnpjCond = C.soDigitos(o.cnpjCondominio) || null;
  const livres = (fn) => desp.map((d, i) => [d, i]).filter(([d, i]) => !usadas.has(i) && fn(d));
  const pendentes = (fn) => pags.map((p, i) => [p, i]).filter(([p, i]) => !casou.has(i) && fn(p));

  // Fase 1: código de barras.
  for (const [p, i] of pendentes((x) => !!x.codigo_barras)) {
    let iguais = livres((d) => d.codigo_barras === p.codigo_barras);
    if (iguais.length > 1) {
      const mesmoValor = iguais.filter(([d]) => d.valor_centavos === p.valor_pago_centavos || d.valor_centavos === p.valor_titulo_centavos);
      if (mesmoValor.length === 1) iguais = mesmoValor;
    }
    if (iguais.length === 1) { usadas.add(iguais[0][1]); casou.set(i, { idx: iguais[0][1], como: 'codigo_barras' }); }
    else if (iguais.length > 1) casou.set(i, { ambiguo: iguais.map(([d]) => d.id_parcela), como: 'codigo_barras' });
  }
  // Fase 2: seu número inteiramente numérico.
  for (const [p, i] of pendentes((x) => /^\d+$/.test(String(x.seu_numero || '').trim()))) {
    const sn = String(p.seu_numero).trim().replace(/^0+/, '');
    if (!sn) continue;
    let iguais = livres((d) => String(d.id_parcela) === sn);
    let como = 'seu_numero_parcela';
    if (!iguais.length) { iguais = livres((d) => String(d.id_despesa) === sn); como = 'seu_numero_despesa'; }
    if (iguais.length === 1) { usadas.add(iguais[0][1]); casou.set(i, { idx: iguais[0][1], como }); }
    else if (iguais.length > 1) casou.set(i, { ambiguo: iguais.map(([d]) => d.id_parcela), como });
  }
  // Fase 3: valor e data, só efetivados.
  for (const [p, i] of pendentes((x) => x.efetivado)) {
    const cands = livres((d) => {
      if (d.valor_centavos === null) return false;
      if (d.valor_centavos !== p.valor_pago_centavos && d.valor_centavos !== p.valor_titulo_centavos) return false;
      const dist = C.diasEntre(d.liquidacao || d.vencimento, p.data_efetiva);
      return dist !== null && Math.abs(dist) <= o.toleranciaDias;
    });
    if (cands.length === 1) { usadas.add(cands[0][1]); casou.set(i, { idx: cands[0][1], como: 'valor_e_data' }); }
    else if (cands.length > 1) casou.set(i, { ambiguo: cands.map(([d]) => d.id_parcela), como: 'valor_e_data' });
  }

  const resultados = pags.map((p, i) => {
    const ref = refPagamento(p);
    const a = casou.get(i) || null;
    if (!p.efetivado) {
      const d = a && !a.ambiguo ? desp[a.idx] : null;
      const situacao = p.agendado ? 'agendado' : p.rejeitado ? 'rejeitado' : 'pendente';
      const achados = [];
      if (d && d.liquidada && situacao !== 'agendado') achados.push({ tipo: 'baixa_sem_pagamento', detalhe: 'Despesa baixada no sistema, mas o banco não efetivou (' + (p.ocorrencias.map((x) => x.texto).join('; ') || 'sem ocorrência') + ').' });
      return { ...ref, situacao, gravidade: achados.length ? 'alta' : null, casou_por: a ? a.como : null, despesa: d, achados };
    }
    if (!a) return { ...ref, situacao: 'pago_sem_despesa', gravidade: 'alta', achados: [], detalhe: 'Pago no banco e sem despesa correspondente no sistema.' };
    if (a.ambiguo) return { ...ref, situacao: 'ambiguo', gravidade: 'media', casou_por: a.como, parcelas_candidatas: a.ambiguo, achados: [], detalhe: 'Mais de uma despesa possível; conferir à mão.' };
    const d = desp[a.idx];
    const achados = [];
    const dif = (p.valor_pago_centavos || 0) - (d.valor_centavos || 0);
    if (d.valor_centavos === null) achados.push({ tipo: 'sem_valor_no_sistema', detalhe: 'Despesa sem valor lançado.' });
    else if (dif !== 0) {
      achados.push({ tipo: dif > 0 ? 'pago_a_maior' : 'pago_a_menor', diferenca_centavos: dif,
        detalhe: dif > 0 ? 'Banco pagou ' + C.fmtBRL(dif) + ' a mais que o lançado (juros ou multa não registrados).' : 'Banco pagou ' + C.fmtBRL(-dif) + ' a menos que o lançado (desconto ou pagamento parcial).' });
    }
    if (!d.liquidada) achados.push({ tipo: 'sem_baixa', detalhe: 'Pago no banco em ' + p.data_efetiva + ' e sem baixa no sistema.' });
    else if (d.liquidacao && p.data_efetiva && d.liquidacao !== p.data_efetiva) achados.push({ tipo: 'data_baixa_diferente', dias: C.diasEntre(p.data_efetiva, d.liquidacao), detalhe: 'Baixa no sistema em ' + d.liquidacao + ', pagamento real em ' + p.data_efetiva + '.' });
    if (a.como !== 'codigo_barras' && p.codigo_barras) {
      if (d.codigo_barras && p.codigo_barras !== d.codigo_barras) achados.push({ tipo: 'codigo_barras_diferente', detalhe: 'Código de barras pago é diferente do lançado na despesa (boleto trocado ou de outro condomínio).' });
      else if (!d.codigo_barras) achados.push({ tipo: 'sem_codigo_no_sistema', detalhe: 'Pago com código de barras e a despesa não tem código lançado; casou só por ' + (a.como === 'valor_e_data' ? 'valor e data' : 'seu número') + '.' });
    }
    if (p.beneficiario_doc && d.fornecedor_doc && p.beneficiario_doc !== d.fornecedor_doc) achados.push({ tipo: 'beneficiario_diferente', detalhe: 'CNPJ do beneficiário no banco diferente do fornecedor da despesa.' });
    if (cnpjCond && p.pagador_doc && p.pagador_doc !== cnpjCond) achados.push({ tipo: 'pagador_diferente', detalhe: 'CNPJ do pagador no banco diferente do condomínio.' });
    const grave = achados.some((x) => ['codigo_barras_diferente', 'beneficiario_diferente', 'pagador_diferente', 'pago_a_menor'].includes(x.tipo));
    return { ...ref, situacao: achados.length ? 'divergente' : 'confere', gravidade: achados.length ? (grave ? 'alta' : 'media') : null, casou_por: a.como, despesa: d, achados };
  });
  const efetivos = pags.filter((p) => p.efetivado);
  const resumo = { pagamentos: pags.length, efetivados: efetivos.length, confere: 0, divergente: 0, pago_sem_despesa: 0, ambiguo: 0, agendado: 0, rejeitado: 0, pendente: 0, total_pago_centavos: efetivos.reduce((s, p) => s + (p.valor_pago_centavos || 0), 0) };
  resultados.forEach((r) => { resumo[r.situacao] = (resumo[r.situacao] || 0) + 1; });
  resumo.despesas_sem_pagamento_no_arquivo = desp.length - usadas.size;
  return { resumo, resultados };
}

function refPagamento(p) {
  return { lote: p.lote, seq: p.seq, linha: p.linha, segmento: p.segmento, favorecido: p.favorecido, valor_pago_centavos: p.valor_pago_centavos, data_efetiva: p.data_efetiva, linha_digitavel: p.linha_digitavel, ocorrencias: p.ocorrencias };
}

module.exports = { lerRetornoPagamento, conferirPagamentos, despesaParaConferir, OCORRENCIAS, FORMAS };
