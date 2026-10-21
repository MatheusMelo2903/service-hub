'use strict';
// Converte as linhas do Superlógica nas linhas das tabelas fin_*.
// Só os campos que o auditor usa. Fora de propósito: tokens, segredos, agência e
// número de conta, CPF de pessoa física e nome de morador.
const crypto = require('crypto');
const { dataISO, dataHoraISO, num, int, txt } = require('./util');

function condominio(c) {
  return {
    id_condominio: int(c.id_condominio_cond),
    nome: txt(c.st_nome_cond, 200),
    fantasia: txt(c.st_fantasia_cond, 200),
  };
}

function conta(c) {
  return {
    id_conta: int(c.id_contabanco_cb),
    id_condominio: int(c.id_condominio_cond),
    descricao: txt(c.st_descricao_cb, 200),
    principal: String(c.fl_principal_cb) === '1',
    banco: txt(c.st_nome_banc, 100),
    id_banco: int(c.id_banco_banc),
    id_tipo: int(c.id_tipocontabanco_tcb),
    saldo: num(c.vl_saldo_cb),
    dt_abertura: dataISO(c.dt_dataabertura_cb),
    dt_fechamento: dataISO(c.dt_datafechamento_cb),
    dt_bloqueio: dataISO(c.dt_bloquearlancamentos_cb),
  };
}

// CNPJ só com 14 dígitos; CPF (pessoa física) não é guardado.
function cnpj(v) {
  const s = String(v || '').replace(/\D/g, '');
  return s.length === 14 ? s : null;
}

function despesa(d) {
  return {
    id_despesa: int(d.id_despesa_des),
    id_condominio: int(d.id_condominio_cond),
    id_fornecedor: int(d.id_contato_con),
    fornecedor: txt(d.st_nome_con, 200),
    fornecedor_cnpj: cnpj(d.st_cpf_con),
    documento: txt(d.st_documento_des, 100),
    id_tipo_doc: int(d.id_tipo_doc),
    serie_nota: txt(d.st_serienota_des, 50),
    dt_despesa: dataISO(d.dt_despesa_des),
    dt_geracao: dataISO(d.dt_geracao_des),
    recorrente: d.fl_recorrente_des === undefined ? null : String(d.fl_recorrente_des) === '1',
    id_conta: int(d.id_contabanco_cb),
    apropriacao: (Array.isArray(d.apropriacao) ? d.apropriacao : []).slice(0, 30).map((a) => ({
      conta: txt(a.st_conta_cont, 30),
      descricao: txt(a.st_descricao_cont, 120),
      complemento: txt(a.st_complemento_apro, 200),
      valor: num(a.vl_valor_apro),
    })),
  };
}

function parcela(d) {
  const arquivos = Array.isArray(d.arquivos) ? d.arquivos : [];
  const barras = String(d.st_codigobarras_pdes || '').replace(/\D/g, '');
  return {
    id_parcela: int(d.id_parcela_pdes),
    id_despesa: int(d.id_despesa_des),
    id_condominio: int(d.id_condominio_cond),
    liquidada: String(d.fl_liquidado_pdes) === '1',
    dt_vencimento: dataISO(d.dt_vencimento_pdes),
    dt_liquidacao: dataISO(d.dt_liquidacao_pdes),
    dt_previsao_credito: dataISO(d.dt_previsaocredito_pdes),
    valor: num(d.vl_valor_pdes),
    valor_bruto: num(d.vl_valorbruto_pdes),
    juros: num(d.vl_juros_pdes),
    multa: num(d.vl_multa_pdes),
    desconto: num(d.vl_desconto_pdes),
    codigo_barras: barras || null,
    id_forma_pag: int(d.id_forma_pag),
    remessa_status: txt(d.fl_remessastatus_pdes, 10),
    complemento: txt(d.st_complemento_pdes, 300),
    num_anexos: arquivos.filter((a) => !String(a.fl_excluido_arq || '').trim()).length,
    documentos_pendentes: (Array.isArray(d.documentos_pendentes) ? d.documentos_pendentes : []).slice(0, 10).map((p) => ({
      descricao: txt(p.descricao, 120), id_etiqueta: int(p.id_etiqueta_eti),
    })),
  };
}

function anexos(d) {
  const idDesp = int(d.id_despesa_des);
  const idCond = int(d.id_condominio_cond);
  return (Array.isArray(d.arquivos) ? d.arquivos : [])
    .filter((a) => int(a.id_arquivo_arq) && !String(a.fl_excluido_arq || '').trim())
    .map((a) => ({
      id_arquivo: int(a.id_arquivo_arq),
      id_despesa: int(a.id_despesa_des) || idDesp,
      id_condominio: idCond,
      etiqueta: txt(a.st_nomeabreviadoetiqueta_eti, 60),
      nome: txt(a.st_nome_arq, 200),
      extensao: txt(a.st_extensao_arq, 10),
      tamanho: int(a.nm_tamanho_arq),
      hash: txt(a.st_hash_arq, 80),
      dt_envio: dataISO(a.dt_envio_arq),
      id_responsavel: int(a.id_responsavel_arq),
    }));
}

// Movimentos de uma resposta de caixa/index. Linhas de saldo (saldoinicialconta) saem.
// contaParaCond: Map id_conta -> id_condominio. Linha sem id ganha chave por resumo e ordem.
function movimentos(lista, contaParaCond) {
  const out = [];
  const ordem = new Map();
  (Array.isArray(lista) ? lista : []).forEach((m) => {
    if (!m || m.saldoinicialconta !== undefined) return;
    const idConta = int(m.id_contabanco_cb);
    const data = dataISO(m.dt_data_mov);
    if (!idConta || !data) return;
    const idMov = int(m.id_contabanco_mov);
    let chave;
    if (idMov) chave = 'm:' + idMov;
    else {
      const resumo = [idConta, data, m.fl_dc_mov, m.vl_valor_mov, m.st_descricao_mov, m.fl_origem_mov, m.st_documento_mov].join('|');
      const h = crypto.createHash('sha1').update(resumo).digest('hex').slice(0, 20);
      const k = (ordem.get(h) || 0) + 1;
      ordem.set(h, k);
      chave = 'h:' + h + '#' + k;
    }
    out.push({
      chave,
      id_movimento: idMov,
      id_conta: idConta,
      id_condominio: contaParaCond.get(idConta) || null,
      dt_data: data,
      dc: txt(m.fl_dc_mov, 2),
      valor: num(m.vl_valor_mov),
      descricao: txt(m.st_descricao_mov, 200),
      origem: int(m.fl_origem_mov),
      documento: txt(m.st_documento_mov, 60),
      id_despesa: int(m.id_despesa_des),
      id_parcela: int(m.id_parcela_pdes),
      id_forma_pag: int(m.id_forma_pag),
      num_anexos: int(m.num_anexos),
      fitid: txt(m.st_fitid_mov, 100),
      remessa_status: txt(m.fl_remessastatus_mov, 10),
    });
  });
  return out;
}

function cobranca(c) {
  return {
    id_recebimento: int(c.id_recebimento_recb),
    id_condominio: int(c.id_condominio_cond),
    id_unidade: int(c.id_unidade_uni),
    unidade: txt(c.st_unidade_uni, 40),
    bloco: txt(c.st_bloco_uni, 40),
    id_conta: int(c.id_contabanco_cb),
    status: txt(c.fl_status_recb, 5),
    dt_vencimento: dataISO(c.dt_vencimento_recb),
    dt_competencia: dataISO(c.dt_competencia_recb),
    dt_geracao: dataISO(c.dt_geracao_recb),
    dt_liquidacao: dataISO(c.dt_liquidacao_recb),
    vl_emitido: num(c.vl_emitido_recb),
    vl_total: num(c.vl_total_recb),
    remessa_status: txt(c.fl_remessastatus_recb, 10),
    id_lote: txt(c.id_lote_recb, 30),
    parcelamento: txt(c.fl_parcelamento_recb, 10),
  };
}

// Auditoria: só o que é do financeiro de despesas (cobrança, receita e push ficam fora).
const AUD_FIN = /despesa|parcela|arquivo|apropria[cç][aã]o|extrato|fornecedor|conta banc[aá]ria|cheque|transfer[eê]ncia/i;
// Fora: push, arquivo de retorno de cobrança (.RET) e arquivos do PJBank; e, para caber no
// banco (cerca de 2 mil linhas por dia a menos), a criação de despesa, parcela e apropriação
// (já vem da própria despesa) e o "Adicionado extrato" (a data do extrato sai do caixa).
const AUD_FORA = /notifica[cç][aãõo]+e?s? de push|fila de push|agendamento de envio de push|PJBank do condom[ií]nio|\.RET\b|arquivo retorno|adicionado extrato|^despesa\s*#?\s*\d+\s+criada|^parcela\s*#?\s*\d+\s+da despesa\s*#?\s*\d+\s+criada|^apropria[cç][aã]o\s+#?\d+\s+da despesa\s+#?\d+\s+inserida/i;
function auditoriaRelevante(a) {
  const t = String((a && a.st_texto_aud) || '');
  if (!AUD_FIN.test(t) || AUD_FORA.test(t)) return false;
  // conta alterada só no "próximo nosso número" (acontece a cada boleto): ruído
  const campos = t.match(/\b(?:ST|FL|NM|DT|VL|ID)_[A-Z0-9_]+\b/gi) || [];
  if (/conta banc[aá]ria.*alterad/i.test(t) && campos.length && campos.every((c) => /^ST_PROXIMONN_CB$/i.test(c))) return false;
  return true;
}
// Texto guardado sem CPF, CNPJ, agência, conta ou valor de campo alterado em conta
// bancária (pode ser token). Os ids de despesa, parcela e arquivo saem antes, do original.
function mascararTexto(t) {
  let s = String(t || '');
  // "Conta bancária X alterada. ST_TOKEN_CB de A para B": fica só o nome dos campos.
  const alt = s.match(/^(.*?conta banc[aá]ria.*?alterad[ao]\.?)/i);
  if (alt) {
    const campos = [...new Set((s.slice(alt[1].length).match(/\b(?:ST|FL|NM|DT|VL|ID)_[A-Z0-9_]+\b/gi) || []).map((c) => c.toUpperCase()))];
    s = alt[1] + (campos.length ? ' Campos: ' + campos.join(', ') : '');
  }
  return s
    .replace(/\d{3}\.\d{3}\.\d{3}-\d{2}/g, '[cpf]')
    .replace(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g, '[cnpj]')
    .replace(/\((?=[^)]*\d)[\d\s.\/-]+\)/g, '(...)')
    .replace(/\d[\d.\/-]{7,}\d/g, (m) => (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(m) || m.replace(/\D/g, '').length < 8 ? m : '[num]'));
}
function idDoTexto(t, re) {
  const m = t.match(re);
  return m ? int(m[1]) : null;
}
const chaveFantasia = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
// fantasiaParaCond: Map nome fantasia (chaveFantasia) -> id_condominio, ou 0 quando o
// nome é de mais de um cadastro. O sync decide o que fazer com nome ambíguo ou desconhecido.
function auditoria(a, fantasiaParaCond) {
  const t = String(a.st_texto_aud || '');
  const fant = chaveFantasia(a.st_fantasia_cond);
  return {
    id_auditoria: int(a.id_auditoria_aud),
    dt_data: dataHoraISO(a.dt_data_aud),
    id_usuario: int(a.id_usuario_usu),
    usuario: txt(a.st_apelido_usu, 120),
    sistema: t.startsWith('[SUDO]'),
    id_condominio: fant ? fantasiaParaCond.get(fant) || null : null,
    condominio_texto: txt(a.st_fantasia_cond, 200),
    texto: txt(mascararTexto(t), 1000),
    id_despesa: idDoTexto(t, /despesa\s*#?\s*(\d+)/i),
    id_parcela: idDoTexto(t, /parcela\s*#?\s*(\d+)/i),
    id_arquivo: idDoTexto(t, /arquivo\s*#\s*(\d+)/i),
  };
}

module.exports = { condominio, conta, despesa, parcela, anexos, movimentos, cobranca, auditoria, auditoriaRelevante, cnpj, mascararTexto, chaveFantasia };
