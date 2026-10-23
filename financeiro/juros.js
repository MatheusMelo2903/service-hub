'use strict';
// Juros e atrasos: dossiê por caso (parcela paga depois do vencimento, juros ou multa lançados,
// juros pago e não lançado, parcela vencida sem pagamento).
// Funções puras: recebem o que já foi lido (Superlógica só por GET, extrato importado, retorno
// CNAB, entrada de documentos do Hub, registros manuais) e devolvem os casos com a linha do
// tempo, a causa provável e as evidências. A causa é SUGESTÃO com regra explicável; quem decide
// quem paga é sempre uma pessoa (GESTOR ou GERENTE), e a decisão fica guardada com histórico.
const U = require('./regras/util');
const C = require('./banco/comum');
const cnab = require('./banco/cnab240');

// Prazo mínimo entre o lançamento e o vencimento para dar tempo de mandar para o banco e o
// síndico assinar: 2 dias úteis. Documento que chega depois disso já chega "em cima".
const DIAS_UTEIS_PARA_LANCAR = 2;
// Débito do extrato até 20% maior que o valor da parcela, depois do vencimento, conta como a
// mesma parcela paga com encargo (juros, multa e correção de alguns meses ficam abaixo disso).
const TETO_ENCARGO = 0.20;
const FOLGA_DIAS_EXTRATO = 5;

const QUEM_PAGA = {
  condominio: 'Condomínio',
  administradora: 'Administradora',
  fornecedor: 'Fornecedor (estorno)',
  a_apurar: 'A apurar',
};
const PODEM_DECIDIR = new Set(['GESTOR', 'GERENTE']);
const USUARIOS_SISTEMA = new Set(['999996', '999997', '999998', '999999', '178']);

const ROTULO_CAUSA = {
  pago_no_prazo_com_encargo: 'Pago no prazo e com encargo lançado',
  documento_tardio: 'Documento chegou depois do prazo',
  lancado_tarde: 'Documento chegou a tempo, mas foi lançado tarde',
  sem_saldo: 'Sem saldo na conta no vencimento',
  sem_assinatura: 'Lançado a tempo, sem assinatura do síndico até o vencimento',
  sem_causa_clara: 'Tudo a tempo e mesmo assim pago depois',
  dado_incompleto: 'Dado incompleto',
};
// Responsável que a regra sugere (a decisão é humana).
const SUGERE = {
  pago_no_prazo_com_encargo: 'a_apurar',
  documento_tardio: 'a_apurar',
  lancado_tarde: 'administradora',
  sem_saldo: 'condominio',
  sem_assinatura: 'condominio',
  sem_causa_clara: 'a_apurar',
  dado_incompleto: 'a_apurar',
};

// ── datas e valores ───────────────────────────────────────────────────────
const dia = (v) => U.data(v) || C.dataQualquer(v) || null;
const semana = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
function menosDiasUteis(iso, n) {
  let d = iso, k = 0;
  while (k < n) { d = U.maisDias(d, -1); const w = semana(d); if (w !== 0 && w !== 6) k++; }
  return d;
}
// Vencimento em sábado ou domingo vale no dia útil seguinte (mesma regra do auditor, R8).
function vencimentoUtil(iso) {
  if (!iso) return null;
  const w = semana(iso);
  return w === 6 ? U.maisDias(iso, 2) : (w === 0 ? U.maisDias(iso, 1) : iso);
}
const cent = (v) => (v === null || v === undefined || v === '' ? null : Math.round(U.valor(v) * 100));
const reais = (c) => (c === null || c === undefined ? null : Math.round(c) / 100);
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 200);
const dt = (iso) => U.dataTexto(iso);
const brl = (c) => C.fmtBRL(c);

// ── parcela do Superlógica (despesas/index) no formato do dossiê ─────────
function normalizarParcela(d) {
  const valor = cent(d.vl_valor_pdes) || 0;
  const juros = cent(d.vl_juros_pdes) || 0;
  const multa = cent(d.vl_multa_pdes) || 0;
  const desconto = cent(d.vl_desconto_pdes) || 0;
  const bruto = cent(d.vl_valorbruto_pdes);
  // O Superlógica pode guardar no valor da parcela o total já com os encargos (valor bruto +
  // juros + multa - desconto) ou só o original. Os dois casos dão o mesmo total registrado.
  const jaSomado = bruto !== null && bruto > 0 && (juros + multa) > 0 && Math.abs(valor - (bruto + juros + multa - desconto)) <= 1;
  const original = jaSomado ? bruto : valor;
  const total = jaSomado ? valor : valor + juros + multa - desconto;
  const anexos = (Array.isArray(d.arquivos) ? d.arquivos : []).filter((a) => a && String(a.fl_excluido_arq || '') !== '1')
    .map((a) => ({ etiqueta: U.norm(a.st_nomeabreviadoetiqueta_eti), envio: dia(a.dt_envio_arq) })).filter((a) => a.envio);
  const liq = dia(d.dt_liquidacao_pdes);
  return {
    id_parcela: txt(d.id_parcela_pdes, 20), id_despesa: txt(d.id_despesa_des, 20), id_condominio: txt(d.id_condominio_cond, 12),
    condominio: txt(d.st_fantasia_cond, 120), fornecedor: txt(d.st_nome_con || d.st_fantasia_con, 120), documento: txt(d.st_documento_des, 60),
    conta: txt(d.id_contabanco_cb, 12) || null, forma: txt(d.id_forma_pag, 4), debito_automatico: String(d.id_forma_pag || '') === '7',
    vencimento: dia(d.dt_vencimento_pdes), liquidacao: liq, lancamento: dia(d.dt_geracao_des),
    liquidada: String(d.fl_liquidado_pdes || '') === '1' || !!liq,
    original, juros, multa, desconto, total, codigo_barras: C.codigoBarras(d.st_codigobarras_pdes) || null,
    remessa_status: txt(d.fl_remessastatus_pdes, 10), anexos,
    _bruto: d,
  };
}

// ── auditoria do Superlógica: eventos de cada despesa ─────────────────────
function quandoAud(r) {
  const d = dia(r.dt_data_aud);
  const h = (String(r.dt_data_aud || '').match(/(\d{2}:\d{2})(:\d{2})?/) || [])[1] || '';
  return { data: d, hora: h };
}
function classificarAuditoria(t) {
  if (/^Despesa#\d+ criada/i.test(t) || /Parcela#\d+ da despesa#\d+\s+criada/i.test(t)) return 'lancamento';
  if (/cancelad|estornad|exclu[ií]d/i.test(t)) return 'mexida';
  if (/Vencimento: de/i.test(t)) return 'vencimento_alterado';
  if (/liquidad|baixad|quitad|baixa (da|de) parcela/i.test(t)) return 'baixa';
  if (/remessa|agendad|enviad[ao] (para|ao) (o )?banco|autoriza|aprovad/i.test(t)) return 'remessa';
  if (/Arquivo#\d+/i.test(t)) return 'anexo';
  return 'alteracao';
}
// linhas: auditoria/index enxuta (id_auditoria_aud, dt_data_aud, id_usuario_usu, st_apelido_usu, st_texto_aud).
// Devolve Map id_despesa -> [{ data, hora, tipo, usuario, sistema, id_parcela, texto }].
function eventosPorDespesa(linhas) {
  const m = new Map();
  for (const r of linhas || []) {
    const t = String(r.st_texto_aud || '');
    if (!t || /^\[SUDO\]/.test(t)) continue;
    const md = t.match(/despesa\s?#(\d+)/i);
    if (!md) continue;
    const q = quandoAud(r);
    if (!q.data) continue;
    const id = String(r.id_usuario_usu || '');
    const ev = { data: q.data, hora: q.hora, tipo: classificarAuditoria(t), usuario: txt(r.st_apelido_usu, 80), sistema: USUARIOS_SISTEMA.has(id),
      id_parcela: (t.match(/Parcela#(\d+)/i) || [])[1] || null, texto: txt(t, 220), id_auditoria: txt(r.id_auditoria_aud, 20) };
    if (!m.has(md[1])) m.set(md[1], []);
    m.get(md[1]).push(ev);
  }
  for (const l of m.values()) l.sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora));
  return m;
}

// ── extrato do banco (importado no Superlógica ou vindo do conector) ──────
// extrato: [{ id_conta, data, centavos (com sinal: débito negativo) | tipo + centavos, descricao }]
// Devolve Map id_parcela -> { data, centavos, descricao, como, candidatos }.
function casarExtrato(parcelas, extrato, hoje) {
  const debitos = (extrato || []).map((x, i) => {
    const c = Number(x.centavos);
    const tipo = x.tipo || (c < 0 ? 'D' : 'C');
    return { i, id_conta: String(x.id_conta || ''), data: dia(x.data), centavos: Math.abs(c), tipo, descricao: txt(x.descricao, 120) };
  }).filter((x) => x.tipo === 'D' && x.data && x.centavos > 0);
  const usados = new Set();
  const out = new Map();
  const comConta = parcelas.filter((p) => p.conta && p.vencimento && (p.liquidada || p.vencimento < hoje));
  const perto = (p, x) => Math.abs(U.dias(p.liquidacao || p.vencimento, x.data));
  // 1) valor igual ao registrado (ou ao original) na mesma conta, perto do vencimento ou da baixa.
  for (const p of comConta) {
    const ini = U.maisDias(p.vencimento, -FOLGA_DIAS_EXTRATO);
    const fim = U.maisDias(p.liquidacao && p.liquidacao > p.vencimento ? p.liquidacao : (p.liquidada ? p.vencimento : hoje), FOLGA_DIAS_EXTRATO);
    const cands = debitos.filter((x) => !usados.has(x.i) && x.id_conta === p.conta && x.data >= ini && x.data <= fim && (x.centavos === p.total || x.centavos === p.original));
    if (!cands.length) continue;
    cands.sort((a, b) => perto(p, a) - perto(p, b));
    usados.add(cands[0].i);
    out.set(p.id_parcela, { data: cands[0].data, centavos: cands[0].centavos, descricao: cands[0].descricao, como: 'valor_igual', candidatos: cands.length });
  }
  // 2) valor maior (até 20%) depois do vencimento: pago com encargo. Só com um candidato.
  for (const p of comConta) {
    if (out.has(p.id_parcela)) continue;
    const ini = U.maisDias(vencimentoUtil(p.vencimento), 1);
    const fim = U.maisDias(p.liquidacao && p.liquidacao > ini ? p.liquidacao : hoje, FOLGA_DIAS_EXTRATO);
    const cands = debitos.filter((x) => !usados.has(x.i) && x.id_conta === p.conta && x.data >= ini && x.data <= fim
      && x.centavos > p.total && x.centavos <= Math.round(p.total * (1 + TETO_ENCARGO)) + 500);
    if (cands.length === 1) {
      usados.add(cands[0].i);
      out.set(p.id_parcela, { data: cands[0].data, centavos: cands[0].centavos, descricao: cands[0].descricao, como: 'valor_maior', candidatos: 1 });
    } else if (cands.length > 1) {
      out.set(p.id_parcela, { ambiguo: true, candidatos: cands.length, como: 'valor_maior' });
    }
  }
  return out;
}

// ── retorno CNAB 240 guardado (pagamentos lidos do arquivo do banco) ─────
// retornos: [{ ...pagamento do cnab240.lerRetornoPagamento, data_arquivo }]
// Devolve Map id_parcela -> [{ situacao, data, valor_centavos, ocorrencias, data_arquivo }].
function casarRetornos(parcelas, retornos) {
  const out = new Map();
  if (!retornos || !retornos.length) return out;
  const brutos = parcelas.map((p) => p._bruto).filter(Boolean);
  const r = cnab.conferirPagamentos(retornos, brutos);
  r.resultados.forEach((x, i) => {
    const d = x.despesa;
    if (!d || !d.id_parcela) return;
    const k = String(d.id_parcela);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ situacao: x.situacao === 'confere' || x.situacao === 'divergente' ? 'efetivado' : x.situacao, data: x.data_efetiva || null,
      valor_centavos: x.valor_pago_centavos, ocorrencias: (x.ocorrencias || []).map((o) => o.codigo + ' ' + o.texto), codigos: (x.ocorrencias || []).map((o) => o.codigo),
      data_arquivo: retornos[i].data_arquivo || null });
  });
  return out;
}

// ── chegada do documento ──────────────────────────────────────────────────
// Entrada do Hub (data em que o PDF entrou na fila) vale como chegada. Sem ela, o anexo do boleto
// ou da nota no Superlógica só prova que o documento chegou ATÉ aquela data (pode ter chegado antes).
function chegadaDe(p, entradas) {
  const e = (entradas || []).filter((x) => String(x.id_despesa) === String(p.id_despesa)).map((x) => dia(x.criado_em)).filter(Boolean).sort()[0];
  if (e) return { data: e, fonte: 'hub', firme: true };
  const a = p.anexos.filter((x) => x.etiqueta === 'DOC. PGTO' || x.etiqueta === 'DOC. FISCAL').map((x) => x.envio).sort()[0];
  if (a) return { data: a, fonte: 'anexo', firme: false };
  return null;
}

// ── causa provável ────────────────────────────────────────────────────────
// Ordem das regras (a primeira que se confirma vira a sugestão; todas aparecem com a evidência):
//   0. pago no prazo e com juros ou multa lançado: conferir o lançamento (a apurar);
//   1. documento chegou depois do prazo de lançar (2 dias úteis antes do vencimento): a apurar
//      (depende de quem atrasou a entrega, síndico ou fornecedor);
//   2. documento chegou a tempo e o lançamento passou do prazo: administradora;
//   3. saldo da conta no dia do vencimento menor que a parcela (ou banco recusou por saldo): condomínio;
//   4. lançado a tempo e assinatura do síndico depois do vencimento (ou banco recusou ou deixou
//      pendente por falta de assinatura): condomínio;
//   5. tudo a tempo e pago depois: a apurar (conferir a data agendada no banco);
//   6. faltou dado para decidir: a apurar, com a lista do que falta.
function sugerirCausa(c) {
  const regras = [];
  const falta = [];
  const add = (codigo, resultado, evidencia) => regras.push({ codigo, rotulo: ROTULO_CAUSA[codigo], resultado, evidencia });
  const venc = c.datas.vencimento;
  const limite = venc ? menosDiasUteis(venc, DIAS_UTEIS_PARA_LANCAR) : null;
  const ch = c.datas.chegada ? { data: c.datas.chegada, firme: c.datas.chegada_fonte === 'hub' } : null;
  const lanc = c.datas.lancamento;
  const da = c.debito_automatico;

  if (c.situacao === 'pago_no_prazo_com_encargo') {
    add('pago_no_prazo_com_encargo', 'sim', 'Pagamento em ' + dt(c.datas.pagamento) + ', vencimento em ' + dt(venc) + ' e encargo lançado de ' + brl(c.valores.juros + c.valores.multa) + '. Conferir o lançamento ou o motivo do encargo.');
  }
  // 1 e 2: chegada e lançamento.
  if (da) {
    add('documento_tardio', 'nao', 'Débito automático: não depende de lançamento nem de assinatura.');
    add('lancado_tarde', 'nao', 'Débito automático.');
  } else if (!venc) {
    add('documento_tardio', 'sem_dado', 'Parcela sem vencimento.'); falta.push('vencimento da parcela');
  } else {
    if (!ch) {
      add('documento_tardio', 'sem_dado', 'Não há registro de quando o documento chegou (nem na entrada de documentos do Hub, nem anexo de boleto ou nota).');
      falta.push('data de chegada do documento');
    } else if (ch.firme) {
      add('documento_tardio', ch.data > limite ? 'sim' : 'nao', 'Documento entrou no Hub em ' + dt(ch.data) + '; prazo para lançar com folga: ' + dt(limite) + ' (' + DIAS_UTEIS_PARA_LANCAR + ' dias úteis antes do vencimento ' + dt(venc) + ').');
    } else if (ch.data <= limite) {
      add('documento_tardio', 'nao', 'Boleto ou nota anexado no Superlógica em ' + dt(ch.data) + ', antes do prazo de ' + dt(limite) + ': o documento já tinha chegado.');
    } else {
      add('documento_tardio', 'sem_dado', 'O anexo do boleto ou da nota é de ' + dt(ch.data) + ', depois do prazo de ' + dt(limite) + ', mas o documento pode ter chegado antes (sem registro na entrada do Hub).');
      falta.push('data de chegada do documento');
    }
    const chegouATempo = ch && ch.data <= limite;
    if (!lanc) {
      add('lancado_tarde', 'sem_dado', 'Sem a data de lançamento da despesa.'); falta.push('data de lançamento');
    } else if (chegouATempo) {
      add('lancado_tarde', lanc > limite ? 'sim' : 'nao', 'Chegou em ' + dt(ch.data) + ' e foi lançado em ' + dt(lanc) + (c.quem_lancou ? ' por ' + c.quem_lancou : '') + ' (' + U.dias(ch.data, lanc) + ' dias depois); prazo ' + dt(limite) + '.');
    } else {
      add('lancado_tarde', ch && ch.firme ? 'nao' : 'sem_dado', 'Lançado em ' + dt(lanc) + (c.quem_lancou ? ' por ' + c.quem_lancou : '') + (lanc > venc ? ' (' + U.dias(venc, lanc) + ' dias depois do vencimento)' : '') + '. ' + (ch && ch.firme ? 'O documento chegou depois do prazo.' : 'Sem saber quando o documento chegou não dá para dizer se o lançamento atrasou.'));
    }
  }
  // 3: saldo.
  const s = c.saldo_vencimento;
  const recusaSaldo = (c.banco || []).some((b) => (b.codigos || []).includes('01'));
  if (recusaSaldo) add('sem_saldo', 'sim', 'O retorno do banco recusou o pagamento por saldo insuficiente.');
  else if (s && s.valor !== null && s.valor !== undefined) {
    const falto = Math.round(s.valor * 100) < c.valores.original;
    add('sem_saldo', falto ? 'sim' : 'nao', 'Saldo de abertura da conta em ' + dt(s.data) + ': ' + brl(Math.round(s.valor * 100)) + ' (' + (s.fonte === 'conta' ? 'conta da despesa' : 'todas as contas') + '); parcela de ' + brl(c.valores.original)
      + (s.vencendo_no_dia_centavos && s.vencendo_no_dia_centavos > c.valores.original ? '; vencendo no dia nessa conta: ' + brl(s.vencendo_no_dia_centavos) : '') + '.');
  } else { add('sem_saldo', 'sem_dado', 'Saldo da conta no vencimento não disponível.'); falta.push('saldo da conta no vencimento'); }
  // 4: assinatura.
  const ass = c.registro && c.registro.assinado_em;
  const recusaAss = (c.banco || []).some((b) => (b.codigos || []).some((k) => k === 'BF' || k === 'PD'));
  if (da) add('sem_assinatura', 'nao', 'Débito automático.');
  else if (!lanc || !venc || lanc > limite) add('sem_assinatura', 'nao', 'Só se aplica quando o lançamento foi feito a tempo.');
  else if (recusaAss) add('sem_assinatura', 'sim', 'O retorno do banco mostra o pagamento pendente ou recusado por falta de assinatura.');
  else if (ass) {
    const vu = vencimentoUtil(venc);
    add('sem_assinatura', ass > vu ? 'sim' : 'nao', 'Lançado em ' + dt(lanc) + (c.registro.enviado_assinatura_em ? ', enviado para assinatura em ' + dt(c.registro.enviado_assinatura_em) : '') + ' e assinado em ' + dt(ass) + (c.registro.assinado_por ? ' (' + c.registro.assinado_por + ')' : '') + '; vencimento ' + dt(venc) + '.');
  } else {
    add('sem_assinatura', 'sem_dado', 'Lançado a tempo em ' + dt(lanc) + ', mas a data em que o síndico assinou ainda não foi registrada.');
    falta.push('data da assinatura do síndico');
  }
  const sim = regras.find((r) => r.resultado === 'sim');
  let codigo;
  if (sim) codigo = sim.codigo;
  else if (regras.some((r) => r.resultado === 'sem_dado')) codigo = 'dado_incompleto';
  else codigo = c.situacao === 'vencida_sem_pagamento' ? 'dado_incompleto' : 'sem_causa_clara';
  if (codigo === 'sem_causa_clara') add('sem_causa_clara', 'sim', 'Chegou, foi lançado e assinado a tempo e havia saldo. Conferir a data agendada no banco e a baixa.');
  if (codigo === 'dado_incompleto' && !falta.length) falta.push('pagamento ainda não feito');
  const explicacao = codigo === 'dado_incompleto' ? 'Falta: ' + falta.join(', ') + '.' : (regras.find((r) => r.codigo === codigo) || {}).evidencia || '';
  return { codigo, rotulo: ROTULO_CAUSA[codigo], responsavel_sugerido: SUGERE[codigo], responsavel_sugerido_rotulo: QUEM_PAGA[SUGERE[codigo]], explicacao, regras, falta, sugestao: true };
}

// ── linha do tempo ────────────────────────────────────────────────────────
const ORDEM_EV = { chegada: 1, lancamento: 2, envio_assinatura: 3, remessa: 4, banco: 5, assinatura: 6, vencimento: 7, mexida: 8, vencimento_alterado: 8, pagamento: 9, baixa: 10, comprovante: 11, alteracao: 12, anexo: 12, hoje: 13 };
function linhaDoTempo(c, p, evs) {
  const L = [];
  const add = (tipo, data, titulo, detalhe, fonte, extra) => { if (data) L.push(Object.assign({ tipo, data, titulo, detalhe: detalhe || '', fonte }, extra || {})); };
  if (c.datas.chegada) add('chegada', c.datas.chegada, c.datas.chegada_fonte === 'hub' ? 'Documento chegou (entrada de documentos do Hub)' : 'Boleto ou nota anexado no Superlógica',
    c.datas.chegada_fonte === 'hub' ? '' : 'O documento chegou até esta data (pode ter chegado antes).', c.datas.chegada_fonte === 'hub' ? 'Hub' : 'Superlógica (anexo)');
  const lancAud = evs.find((e) => e.tipo === 'lancamento');
  if (c.datas.lancamento) add('lancamento', c.datas.lancamento, 'Despesa lançada' + (c.quem_lancou ? ' por ' + c.quem_lancou : ''), lancAud && lancAud.hora ? 'às ' + lancAud.hora : '', 'Superlógica');
  if (c.registro && c.registro.enviado_assinatura_em) add('envio_assinatura', c.registro.enviado_assinatura_em, 'Enviado para assinatura do síndico', 'registrado à mão', 'Registro manual');
  if (p.remessa_status && !/^0?$/.test(p.remessa_status)) add('remessa', c.datas.lancamento, 'Parcela marcada para remessa ao banco', 'situação da remessa no sistema: ' + p.remessa_status + ' (sem a data exata)', 'Superlógica');
  for (const b of c.banco || []) {
    const t = b.situacao === 'efetivado' ? 'Banco efetivou o pagamento' : b.situacao === 'agendado' ? 'Banco recebeu e agendou' : b.situacao === 'rejeitado' ? 'Banco recusou' : 'Banco recebeu, pagamento pendente';
    add('banco', b.data || b.data_arquivo, t, (b.ocorrencias || []).join('; ') + (b.valor_centavos ? ' · ' + brl(b.valor_centavos) : ''), 'Retorno do banco');
  }
  if (c.registro && c.registro.assinado_em) add('assinatura', c.registro.assinado_em, 'Síndico assinou' + (c.registro.assinado_por ? ' (' + c.registro.assinado_por + ')' : ''), 'registrado à mão', 'Registro manual');
  if (c.datas.vencimento) {
    const s = c.saldo_vencimento;
    add('vencimento', c.datas.vencimento, 'Vencimento', 'valor ' + brl(c.valores.original) + (s && s.valor !== null && s.valor !== undefined ? ' · saldo de abertura ' + brl(Math.round(s.valor * 100)) : ''), 'Superlógica');
  }
  for (const e of evs) {
    if (e.tipo === 'lancamento') continue;
    if (e.id_parcela && e.id_parcela !== p.id_parcela) continue;
    if (e.tipo === 'baixa') continue; // vem no item da baixa, com quem baixou
    const titulo = { remessa: 'Registro de remessa ou aprovação', mexida: 'Alteração na parcela', vencimento_alterado: 'Vencimento alterado', anexo: 'Arquivo na despesa', alteracao: 'Alteração na despesa' }[e.tipo] || 'Registro no sistema';
    add(e.tipo, e.data, titulo + (e.usuario ? ' por ' + (e.sistema ? 'sistema' : e.usuario) : ''), e.texto, 'Auditoria do Superlógica', { hora: e.hora });
  }
  if (c.datas.pagamento) add('pagamento', c.datas.pagamento, 'Pagamento saiu da conta', (c.valores.pago !== null ? brl(c.valores.pago) : '') + (c.datas.pagamento_fonte ? ' · fonte: ' + c.datas.pagamento_fonte : '') + (c.dias_atraso > 0 ? ' · ' + c.dias_atraso + ' dia(s) depois do vencimento' : ''), c.datas.pagamento_fonte || 'Superlógica');
  if (c.datas.baixa) add('baixa', c.datas.baixa, 'Baixa no sistema' + (c.quem_baixou ? ' por ' + c.quem_baixou : ''), (c.valores.juros || c.valores.multa ? 'juros ' + brl(c.valores.juros) + ' · multa ' + brl(c.valores.multa) : 'sem juros nem multa lançados'), 'Superlógica');
  const comp = p.anexos.filter((a) => a.etiqueta === 'COMPROVANTE').map((a) => a.envio).sort()[0];
  if (comp) add('comprovante', comp, 'Comprovante anexado', '', 'Superlógica (anexo)');
  if (c.situacao === 'vencida_sem_pagamento') add('hoje', c.hoje, 'Ainda sem pagamento', c.dias_atraso + ' dia(s) de atraso', 'Hub');
  L.sort((a, b) => a.data.localeCompare(b.data) || (ORDEM_EV[a.tipo] || 50) - (ORDEM_EV[b.tipo] || 50) || String(a.hora || '').localeCompare(String(b.hora || '')));
  return L;
}

// ── detecção e montagem dos casos ─────────────────────────────────────────
function competencia(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const ano = +m[1], mes = +m[2];
  if (mes < 1 || mes > 12 || ano < 2020 || ano > 2100) return null;
  const fim = new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
  return { ano, mes, inicio: m[1] + '-' + m[2] + '-01', fim, rotulo: m[1] + '-' + m[2] };
}

// Sinais simples (sem extrato): o que o quadro da carteira usa.
// Devolve null quando a parcela não é caso no mês.
function sinaisBasicos(p, comp, hoje) {
  const noMes = (d) => !!d && d >= comp.inicio && d <= comp.fim;
  if (p.liquidada) {
    if (!noMes(p.liquidacao)) return null;
    const atraso = p.vencimento ? Math.max(0, U.dias(vencimentoUtil(p.vencimento), p.liquidacao)) : 0;
    if (atraso > 0 || p.juros > 0 || p.multa > 0) return { situacao: atraso > 0 ? 'pago_com_atraso' : 'pago_no_prazo_com_encargo', dias_atraso: atraso };
    return null;
  }
  if (noMes(p.vencimento) && p.vencimento < hoje) return { situacao: 'vencida_sem_pagamento', dias_atraso: U.dias(p.vencimento, hoje) };
  return null;
}

// dados: { parcelas: [linhas do despesas/index], extrato, retornos, auditoria, entradas, saldos, registros, historico }
// saldos: { 'conta|AAAA-MM-DD': reais, 'total|AAAA-MM-DD': reais }
// registros: Map ou objeto chave -> linha de fin_juros_casos
function montarCasos(dados, opcoes) {
  const comp = competencia(opcoes.competencia);
  if (!comp) throw new Error('competencia_invalida');
  const hoje = opcoes.hoje || U.hojeSP();
  const vistas = new Set();
  const parcelas = (dados.parcelas || []).map(normalizarParcela).filter((p) => {
    if (!p.id_parcela || vistas.has(p.id_parcela)) return false;
    vistas.add(p.id_parcela);
    return !U.IDS_EXCLUIDOS.has(String(p.id_condominio)) && String(p.id_condominio) !== U.ID_TESTE;
  });
  const ext = casarExtrato(parcelas, dados.extrato || [], hoje);
  const ret = casarRetornos(parcelas, dados.retornos || []);
  const evs = eventosPorDespesa(dados.auditoria || []);
  const regMap = dados.registros instanceof Map ? dados.registros : new Map(Object.entries(dados.registros || {}));
  const hist = dados.historico || [];
  const saldos = dados.saldos || {};
  const noMes = (d) => !!d && d >= comp.inicio && d <= comp.fim;
  // Soma do que vencia em cada dia em cada conta (evidência do saldo).
  const vencendo = new Map();
  for (const p of parcelas) if (p.conta && p.vencimento) { const k = p.conta + '|' + vencimentoUtil(p.vencimento); vencendo.set(k, (vencendo.get(k) || 0) + p.original); }
  const meta = { parcelas: parcelas.length, pagas_no_mes: 0, conferidas_no_extrato: 0, baixa_tardia_pagamento_em_dia: 0, extrato_ambiguo: 0 };
  const casos = [];
  for (const p of parcelas) {
    const e = ext.get(p.id_parcela);
    const bancos = ret.get(p.id_parcela) || [];
    const efetivoBanco = bancos.find((b) => b.situacao === 'efetivado' && b.data);
    if (e && e.ambiguo) meta.extrato_ambiguo++;
    const real = e && !e.ambiguo ? e : null;
    // Data real do pagamento: extrato, depois retorno do banco, depois a baixa do Superlógica.
    let pagamento = null, fonte = null, pago = null;
    if (real) { pagamento = real.data; fonte = 'Extrato do banco'; pago = real.centavos; }
    else if (efetivoBanco) { pagamento = efetivoBanco.data; fonte = 'Retorno do banco'; pago = efetivoBanco.valor_centavos; }
    else if (p.liquidada && p.liquidacao) { pagamento = p.liquidacao; fonte = 'Baixa no Superlógica'; pago = p.total; }
    const pagoDeFato = !!(p.liquidada || real || efetivoBanco);
    let situacao = null, atraso = 0;
    if (pagoDeFato) {
      if (!noMes(pagamento)) continue;
      meta.pagas_no_mes++;
      if (real) meta.conferidas_no_extrato++;
      atraso = p.vencimento && pagamento ? Math.max(0, U.dias(vencimentoUtil(p.vencimento), pagamento)) : 0;
      const naoLancado = pago !== null && pago - p.total > 1 ? pago - p.total : 0;
      if (atraso > 0) situacao = 'pago_com_atraso';
      else if (p.juros > 0 || p.multa > 0 || naoLancado > 0) situacao = 'pago_no_prazo_com_encargo';
      if (!situacao) {
        if (real && p.liquidacao && p.vencimento && U.dias(vencimentoUtil(p.vencimento), p.liquidacao) > 0) meta.baixa_tardia_pagamento_em_dia++;
        continue;
      }
    } else {
      if (!(noMes(p.vencimento) && p.vencimento < hoje)) continue;
      situacao = 'vencida_sem_pagamento';
      atraso = U.dias(p.vencimento, hoje);
    }
    const chave = 'p' + p.id_parcela;
    const reg = regMap.get(chave) || null;
    const pe = evs.get(String(p.id_despesa)) || [];
    const lancAud = pe.find((x) => x.tipo === 'lancamento' && !x.sistema);
    const baixaAud = pe.filter((x) => x.tipo === 'baixa' && (!x.id_parcela || x.id_parcela === p.id_parcela)).pop();
    const ch = chegadaDe(p, dados.entradas);
    const naoLancado = pagoDeFato && pago !== null && pago - p.total > 1 ? pago - p.total : 0;
    const vu = vencimentoUtil(p.vencimento);
    let saldo = null;
    if (vu) {
      const kc = p.conta ? p.conta + '|' + vu : null;
      if (kc && saldos[kc] !== undefined && saldos[kc] !== null) saldo = { data: vu, valor: Number(saldos[kc]), fonte: 'conta', vencendo_no_dia_centavos: vencendo.get(kc) || null };
      else if (saldos['total|' + vu] !== undefined && saldos['total|' + vu] !== null) saldo = { data: vu, valor: Number(saldos['total|' + vu]), fonte: 'total' };
    }
    const c = {
      chave, id_parcela: p.id_parcela, id_despesa: p.id_despesa, id_condominio: p.id_condominio, condominio: p.condominio, competencia: comp.rotulo, hoje,
      fornecedor: p.fornecedor, documento: p.documento, conta: p.conta, debito_automatico: p.debito_automatico,
      situacao, dias_atraso: atraso,
      datas: { chegada: ch ? ch.data : null, chegada_fonte: ch ? ch.fonte : null, lancamento: p.lancamento || (lancAud ? lancAud.data : null),
        vencimento: p.vencimento, pagamento, pagamento_fonte: fonte, baixa: p.liquidada ? p.liquidacao : null },
      valores: { original: p.original, juros: p.juros, multa: p.multa, juros_nao_lancado: naoLancado, encargos: p.juros + p.multa + naoLancado, pago },
      saldo_vencimento: saldo,
      quem_lancou: lancAud ? lancAud.usuario : null, quem_baixou: baixaAud ? (baixaAud.sistema ? 'sistema' : baixaAud.usuario) : null,
      banco: bancos,
      registro: reg ? { enviado_assinatura_em: reg.enviado_assinatura_em || null, assinado_em: reg.assinado_em || null, assinado_por: reg.assinado_por || null,
        registrado_por: reg.registrado_por_email || null, registrado_em: reg.registrado_em || null } : null,
      extrato: real ? { data: real.data, valor: real.centavos, descricao: real.descricao, como: real.como } : (e && e.ambiguo ? { ambiguo: true, candidatos: e.candidatos } : null),
    };
    c.sinais = [];
    if (situacao === 'pago_com_atraso') c.sinais.push({ tipo: 'pago_atrasado', texto: 'Pago ' + atraso + ' dia(s) depois do vencimento' + (fonte === 'Extrato do banco' && p.liquidacao !== pagamento ? ' (pelo extrato; a baixa no sistema diz ' + dt(p.liquidacao) + ')' : '') });
    if (p.juros > 0) c.sinais.push({ tipo: 'juros_lancado', texto: 'Juros lançado: ' + brl(p.juros) });
    if (p.multa > 0) c.sinais.push({ tipo: 'multa_lancada', texto: 'Multa lançada: ' + brl(p.multa) });
    if (naoLancado > 0) c.sinais.push({ tipo: 'juros_nao_lancado', texto: 'O banco debitou ' + brl(pago) + ', ' + brl(naoLancado) + ' a mais que o registrado no sistema: juros ou multa não lançados' });
    if (situacao === 'vencida_sem_pagamento') c.sinais.push({ tipo: 'vencida_sem_pagamento', texto: 'Vencida há ' + atraso + ' dia(s) sem pagamento' });
    if (situacao === 'pago_com_atraso' && !c.valores.encargos && !real) c.sinais.push({ tipo: 'conferir_extrato', texto: 'Sem juros registrado: conferir no extrato se o banco cobrou encargo' });
    c.linha_do_tempo = linhaDoTempo(c, p, pe);
    c.causa = sugerirCausa(c);
    c.decisao = reg && reg.quem_paga ? { quem_paga: reg.quem_paga, rotulo: QUEM_PAGA[reg.quem_paga] || reg.quem_paga, justificativa: reg.justificativa || '',
      decidido_por: reg.decidido_por_email || null, decidido_em: reg.decidido_em || null } : null;
    c.ressarcimento = reg && reg.ressarcimento ? { status: reg.ressarcimento, valor: reg.ressarcimento_valor != null ? Math.round(Number(reg.ressarcimento_valor) * 100) : c.valores.encargos,
      feito_em: reg.ressarcido_em || null, feito_por: reg.ressarcido_por_email || null, observacao: reg.ressarcido_obs || '' } : null;
    c.historico = hist.filter((h) => h.chave === chave).sort((a, b) => String(b.em).localeCompare(String(a.em)))
      .map((h) => ({ acao: h.acao, em: h.em, por: h.por_email || null, depois: h.depois || null, antes: h.antes || null }));
    casos.push(c);
  }
  casos.sort((a, b) => b.valores.encargos - a.valores.encargos || b.dias_atraso - a.dias_atraso || String(a.chave).localeCompare(String(b.chave)));
  return { competencia: comp.rotulo, casos, meta, totais: totais(casos) };
}

// Total de encargos por responsável: decidido (quem paga) ou ainda a decidir, mais a sugestão.
function totais(casos) {
  const t = { casos: casos.length, pagos_com_atraso: 0, pagos_no_prazo_com_encargo: 0, vencidas_sem_pagamento: 0, encargos: 0, juros_nao_lancado: 0,
    por_responsavel: { condominio: 0, administradora: 0, fornecedor: 0, a_apurar: 0, a_decidir: 0 }, qtd_responsavel: { condominio: 0, administradora: 0, fornecedor: 0, a_apurar: 0, a_decidir: 0 },
    sugerido: { condominio: 0, administradora: 0, a_apurar: 0 }, ressarcir_pendente: 0 };
  for (const c of casos) {
    if (c.situacao === 'pago_com_atraso') t.pagos_com_atraso++;
    else if (c.situacao === 'pago_no_prazo_com_encargo') t.pagos_no_prazo_com_encargo++;
    else t.vencidas_sem_pagamento++;
    t.encargos += c.valores.encargos;
    t.juros_nao_lancado += c.valores.juros_nao_lancado;
    const r = c.decisao ? c.decisao.quem_paga : 'a_decidir';
    t.por_responsavel[r] = (t.por_responsavel[r] || 0) + c.valores.encargos;
    t.qtd_responsavel[r] = (t.qtd_responsavel[r] || 0) + 1;
    if (!c.decisao && c.causa) t.sugerido[c.causa.responsavel_sugerido] = (t.sugerido[c.causa.responsavel_sugerido] || 0) + c.valores.encargos;
    if (c.ressarcimento && c.ressarcimento.status === 'pendente') t.ressarcir_pendente += c.ressarcimento.valor || 0;
  }
  return t;
}

// ── permissões e decisão ──────────────────────────────────────────────────
function podeDecidir(perfil, interno) { return !!interno || !!(perfil && PODEM_DECIDIR.has(perfil.role)); }

const RX_DATA = /^\d{4}-\d{2}-\d{2}$/;
function dataValidaOuVazia(v) { return v === null || v === '' || v === undefined || (RX_DATA.test(String(v)) && C.dataValida(String(v))); }
// Registro manual (quem tem o caso na carteira pode registrar): envio para assinatura e assinatura.
function validarRegistro(b, hoje) {
  const o = {};
  for (const k of ['enviado_assinatura_em', 'assinado_em']) {
    if (b[k] === undefined) continue;
    if (!dataValidaOuVazia(b[k])) return { erro: 'data_invalida', detalhe: 'Use uma data válida.' };
    if (b[k] && b[k] > hoje) return { erro: 'data_futura', detalhe: 'A data não pode ser depois de hoje.' };
    o[k] = b[k] || null;
  }
  if (b.assinado_por !== undefined) {
    const v = String(b.assinado_por || '');
    if (v && !['sindico', 'sindico_subsindico'].includes(v)) return { erro: 'assinado_por_invalido', detalhe: 'Escolha síndico ou síndico e subsíndico.' };
    o.assinado_por = v === 'sindico' ? 'síndico' : v === 'sindico_subsindico' ? 'síndico e subsíndico' : null;
  }
  if (!Object.keys(o).length) return { erro: 'nada_para_registrar', detalhe: 'Informe a data de envio ou de assinatura.' };
  if (o.enviado_assinatura_em && o.assinado_em && o.assinado_em < o.enviado_assinatura_em) return { erro: 'datas_invertidas', detalhe: 'A assinatura não pode ser antes do envio.' };
  return { ok: o };
}
function validarDecisao(b) {
  const q = String((b && b.quem_paga) || '');
  if (!QUEM_PAGA[q]) return { erro: 'quem_paga_invalido', detalhe: 'Escolha quem paga: condomínio, administradora, fornecedor ou a apurar.' };
  const j = String((b && b.justificativa) || '').replace(/\s+/g, ' ').trim();
  if (j.length < 5) return { erro: 'justificativa_curta', detalhe: 'Escreva a justificativa da decisão.' };
  if (j.length > 1000) return { erro: 'justificativa_longa', detalhe: 'A justificativa passa de 1000 caracteres.' };
  return { ok: { quem_paga: q, justificativa: j } };
}
// Linha da tabela fin_juros_casos depois da decisão. Administradora gera o aviso de ressarcir o condomínio.
function linhaDecisao(caso, anterior, dec, quem, agora) {
  const l = {
    chave: caso.chave, id_superlogica: Number(caso.id_condominio), competencia: caso.competencia, id_parcela: Number(caso.id_parcela), id_despesa: Number(caso.id_despesa) || null,
    situacao: caso.situacao, causa_sugerida: caso.causa.codigo, valor_encargos: reais(caso.valores.encargos),
    quem_paga: dec.quem_paga, justificativa: dec.justificativa, decidido_por: quem.id, decidido_por_email: quem.email, decidido_em: agora,
    snapshot: snapshot(caso), atualizado_em: agora,
  };
  if (dec.quem_paga === 'administradora') {
    const jaFeito = anterior && anterior.ressarcimento === 'feito';
    l.ressarcimento = jaFeito ? 'feito' : 'pendente';
    l.ressarcimento_valor = reais(caso.valores.encargos);
  } else { l.ressarcimento = null; l.ressarcimento_valor = null; }
  return l;
}
// Dossiê guardado junto da decisão (o Superlógica pode mudar depois).
function snapshot(c) {
  return { situacao: c.situacao, dias_atraso: c.dias_atraso, fornecedor: c.fornecedor, documento: c.documento, datas: c.datas, valores: c.valores,
    saldo_vencimento: c.saldo_vencimento, quem_lancou: c.quem_lancou, quem_baixou: c.quem_baixou, causa: c.causa, linha_do_tempo: c.linha_do_tempo, sinais: c.sinais };
}

// ── exportação do mês (planilha ou PDF para o síndico) ────────────────────
// Sem nome de funcionário: só fatos, datas, valores, causa e decisão.
const COLUNAS_EXPORTACAO = ['Fornecedor', 'Documento', 'Situação', 'Vencimento', 'Pagamento', 'Dias de atraso', 'Valor', 'Juros', 'Multa', 'Encargo não lançado', 'Total de encargos',
  'Documento chegou', 'Lançado', 'Assinado', 'Causa provável', 'Quem paga', 'Justificativa'];
const ROTULO_SITUACAO = { pago_com_atraso: 'Pago com atraso', pago_no_prazo_com_encargo: 'Pago no prazo com encargo', vencida_sem_pagamento: 'Vencida sem pagamento' };
function exportacao(casos) {
  const linhas = casos.map((c) => [c.fornecedor || '', c.documento || '', ROTULO_SITUACAO[c.situacao], dt(c.datas.vencimento), c.datas.pagamento ? dt(c.datas.pagamento) : '', c.dias_atraso,
    reais(c.valores.original), reais(c.valores.juros), reais(c.valores.multa), reais(c.valores.juros_nao_lancado), reais(c.valores.encargos),
    c.datas.chegada ? dt(c.datas.chegada) : '', c.datas.lancamento ? dt(c.datas.lancamento) : '', c.registro && c.registro.assinado_em ? dt(c.registro.assinado_em) : '',
    c.causa.rotulo + ' (sugestão)', c.decisao ? c.decisao.rotulo : 'A decidir', c.decisao ? c.decisao.justificativa : '']);
  return { colunas: COLUNAS_EXPORTACAO, linhas };
}

// ── quadro da carteira (só com os dados da base do Financeiro, sem extrato) ──
// despesas: linhas do despesas/index de todos os condomínios. decididos: linhas de fin_juros_casos do mês.
function quadro(despesas, comp, hoje, ids, decididos, nomes) {
  const c = competencia(comp);
  const por = new Map();
  const linha = (id) => {
    if (!por.has(id)) por.set(id, { id_condominio: id, condominio: (nomes && nomes.get(id)) || '', casos: 0, pagos_com_atraso: 0, vencidas_sem_pagamento: 0, encargos_lancados: 0, decididos: 0, por_responsavel: {} });
    return por.get(id);
  };
  const vistas = new Set();
  for (const d of despesas || []) {
    const p = normalizarParcela(d);
    if (!p.id_parcela || vistas.has(p.id_parcela)) continue;
    vistas.add(p.id_parcela);
    const id = String(p.id_condominio || '');
    if (!id || U.IDS_EXCLUIDOS.has(id) || id === U.ID_TESTE || (ids && !ids.has(id))) continue;
    const s = sinaisBasicos(p, c, hoje);
    if (!s) continue;
    const l = linha(id);
    if (!l.condominio && p.condominio) l.condominio = p.condominio;
    l.casos++;
    if (s.situacao === 'pago_com_atraso') l.pagos_com_atraso++;
    if (s.situacao === 'vencida_sem_pagamento') l.vencidas_sem_pagamento++;
    l.encargos_lancados += p.juros + p.multa;
  }
  for (const r of decididos || []) {
    const id = String(r.id_superlogica);
    if (ids && !ids.has(id)) continue;
    if (!r.quem_paga) continue;
    const l = linha(id);
    l.decididos++;
    l.por_responsavel[r.quem_paga] = (l.por_responsavel[r.quem_paga] || 0) + Math.round(Number(r.valor_encargos || 0) * 100);
  }
  return [...por.values()].sort((a, b) => b.encargos_lancados - a.encargos_lancados || b.casos - a.casos || String(a.condominio).localeCompare(String(b.condominio)));
}

module.exports = {
  QUEM_PAGA, ROTULO_CAUSA, SUGERE, ROTULO_SITUACAO, DIAS_UTEIS_PARA_LANCAR, PODEM_DECIDIR,
  competencia, normalizarParcela, eventosPorDespesa, casarExtrato, casarRetornos, chegadaDe, sugerirCausa, linhaDoTempo,
  montarCasos, sinaisBasicos, totais, quadro, podeDecidir, validarRegistro, validarDecisao, linhaDecisao, snapshot, exportacao,
  vencimentoUtil, menosDiasUteis,
};
