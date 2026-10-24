// Testes da execução da cobrança (superlogica/cobranca-execucao.js e servico/rotas-cobranca-execucao.js)
// com o Superlógica dublado, sem rede:
// NODE_PATH=<repo>/node_modules node scripts/teste-cobranca-execucao.js
// Cobre: aviso de "não receber após o vencimento", política, conferências do acordo (valor, honorário,
// taxas, acordo aberto, jurídico), campos do acordos/put, emissão e releitura, resultado incerto sem
// repetir, desfazer, CRM, status financeiro, cadastro (vai e volta, troca de proprietário), relatório
// sem dados pessoais, e as rotas com a política única (167 livre, outro bloqueado, confirmação, reuso).
process.env.NODE_ENV = 'test';
const http = require('http');
const express = require('express');
const X = require('../superlogica/cobranca-execucao');
const W = require('../servico/escrita-superlogica');
const R = require('../servico/rotas-cobranca-execucao');

let ok = 0, falhou = 0;
function t(nome, cond) { if (cond) ok++; else { falhou++; console.log('FALHOU: ' + nome); } }

const HOJE = new Date(2026, 9, 23);
const sl2 = (d) => String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
const diasAtras = (n) => sl2(new Date(HOJE.getTime() - n * 86400000));

// ── Superlógica dublado ──
function dublado(opcoes) {
  const o = Object.assign({ honorPct: 10, instrucao: 'NÃO RECEBER APOS VENCIMENTO.', juros: '1.00', multa: '2.00', honorCadastro: '10.00', acordoAberto: false, processo: false, parcelaAcordoVencida: false, statusUni: '1', respostaAcordo: 'ok' }, opcoes || {});
  const st = { gravacoes: [], acordos: [], historico: [], status: { 501: o.statusUni, 502: '0', 503: '3' }, sacado2: { 501: '' }, contatos: { 501: [
    { id_contato_con: '9001', st_nome_con: 'MARIA DA SILVA', st_cpf_con: '52998224725', st_email_con: 'maria@exemplo.com', st_telefone_con: '27999998888', st_nometiporesp_tres: 'Proprietário Residente', id_label_tres: '1', id_tiporesp_tres: '1', fl_proprietario_con: '1', dt_entrada_res: '01/10/2020 00:00:00', dt_saida_res: '' },
    { id_contato_con: '9002', st_nome_con: 'JOAO INQUILINO', st_cpf_con: '', st_email_con: '', st_telefone_con: '', st_nometiporesp_tres: 'Inquilino', id_label_tres: '7', id_tiporesp_tres: '7', dt_entrada_res: '03/01/2025 00:00:00', dt_saida_res: '' }] } };
  if (o.acordoAberto) st.acordos.push({ id_acordo_aco: '700', id_unidade_uni: '501', id_condominio_cond: '167', dt_acordo_aco: diasAtras(10), dt_desfeito_aco: '', recebimento: [{ acordo_item: [{ fl_tipo_acoi: '11' }], id_recebimento_recb: '8000', dt_vencimento_recb: diasAtras(-5), vl_total_recb: '100.00', fl_status_recb: '0', dt_liquidacao_recb: '' }] });
  const rec = (idr, dias, valor, juros, multa, extra) => Object.assign({ id_recebimento_recb: idr, dt_vencimento_recb: diasAtras(dias), vl_total_recb: valor.toFixed(2), vl_emitido_recb: valor.toFixed(2), id_acordo_recb: '', id_processo_proc: '', st_label_recb: '',
    encargos: [{ detalhes: { juros: juros.toFixed(2), multa: multa.toFixed(2) }, valorcorrigido: (valor + juros + multa).toFixed(2), diasatraso: String(dias) }] }, extra || {});
  const inad = () => {
    const recs501 = [rec('6001', 40, 500, 6.67, 10), rec('6002', 10, 500, 1.67, 10)];
    if (o.processo) recs501[0].id_processo_proc = '55';
    if (o.parcelaAcordoVencida) recs501.push(rec('6003', 5, 100, 0.17, 2, { id_acordo_recb: '701', st_label_recb: 'ACORDO' }));
    if (st.desfeitos && st.desfeitos.length) { /* origem volta sem acordo: já está na lista */ }
    return [
      { id_unidade_uni: '501', st_unidade_uni: '501', st_bloco_uni: 'A', st_sacado_uni: 'MARIA DA SILVA', fl_statusfin_uni: st.status[501], saldo_juridico: '0', recebimento: st.acordos.some((a) => !a.dt_desfeito_aco && a.recebimento.some((r) => r.acordo_item[0].fl_tipo_acoi === '10')) ? [] : recs501 },
      { id_unidade_uni: '503', st_unidade_uni: '503', st_bloco_uni: 'A', st_sacado_uni: 'CARLOS PEREIRA', fl_statusfin_uni: st.status[503], saldo_juridico: '0', recebimento: [rec('6101', 400, 300, 40, 6)] },
    ];
  };
  const totalOrigem = 500 + 6.67 + 10 + 500 + 1.67 + 10; // 1028.34
  const honor = Math.round(totalOrigem * o.honorPct) / 100;
  const ler = async (rota, p) => {
    if (rota === 'inadimplencia/index') return p.pagina === 1 ? inad() : [];
    if (rota === 'Acordos') return p.pagina === 1 ? st.acordos : [];
    if (rota === 'configuracoes') return [{ nm_txjuros_cond: o.juros, nm_txmulta_cond: o.multa, nm_txjurosacordo_cond: o.juros, nm_txmultaacordo_cond: o.multa, nm_txhonorario_cond: o.honorCadastro,
      instrucao_cobranca_acordo1: o.instrucao, conta_receitas_honorario: '1.86', acordo_naosepararcomposicao: '0', regua_notificacao_por: 'status_financeiro',
      nm_diasprimeiranotificacao_carta: '30', nm_diassegundanotificacao_carta: '60', nm_diasnotificacaojudicial_judicial: '90', st_token_secreto: 'NUNCA' }];
    if (rota === 'contabancos/index') return [{ id_contabanco_cb: '823', id_condominio_cond: p.idCondominio, fl_principal_cb: '1', dt_datafechamento_cb: '', st_descricao_cb: 'Conta Principal' }];
    if (rota === 'cobranca/index') return [{ receita_apropriacao: [{ st_conta_cont: '1.1', st_descricao_cont: 'Taxa condominial', total_receita: '1000.00' }, { st_conta_cont: '1.2', st_descricao_cont: 'Juros', total_receita: '8.34' },
      { st_conta_cont: '1.3', st_descricao_cont: 'Multas', total_receita: o.valorErrado ? '99.00' : '20.00' }].concat(honor ? [{ st_conta_cont: '1.86', st_descricao_cont: 'Honorários', total_receita: honor.toFixed(2) }] : []) }];
    if (rota === 'acordos/simularparcelas') return [{ vencimento: p.DT_PRIMEIRA_PARCELA, valor: p.SIMULA_TOTAL, observacao: 'Parcela 1 de 1' }];
    if (rota === 'unidades/index') {
      const todas = ['501', '502', '503'].map((u) => ({ id_unidade_uni: u, id_condominio_cond: String(p.idCondominio), st_unidade_uni: u, st_bloco_uni: 'A', st_sacado_uni: 'X', st_sacado2_uni: st.sacado2[u] || '', fl_statusfin_uni: st.status[u], contatos: st.contatos[u] || [] }));
      if (p.id) { const u = todas.find((x) => x.id_unidade_uni === String(p.id)); if (!u) { const e = new Error('superlogica_500'); e.status = 500; e.corpo = { msg: 'Unidade não encontrada.' }; throw e; } return [u]; }
      return p.pagina === 1 ? todas : [];
    }
    if (rota === 'historicocobranca/index') return p.pagina === 1 ? st.historico : [];
    throw new Error('rota não dublada: ' + rota);
  };
  const gravar = async (metodo, rota, campos) => {
    st.gravacoes.push({ metodo, rota, campos });
    if (rota === 'acordos/put') {
      if (o.respostaAcordo === 'incerto') return { status: 504, json: null };
      if (o.respostaAcordo === 'recusa') return { status: 206, json: [{ status: '500', msg: 'Erro de regra' }] };
      const ids = Object.keys(campos).filter((k) => /^COBS_ORIGEM\[\d+\]\[ID_RECEBIMENTO_RECB\]$/.test(k)).map((k) => campos[k]);
      st.acordos.push({ id_acordo_aco: '900', id_unidade_uni: campos.ID_UNIDADE_UNI, id_condominio_cond: String(campos.ID_CONDOMINIO_COND), dt_acordo_aco: sl2(HOJE), dt_desfeito_aco: '',
        recebimento: ids.map((i) => ({ acordo_item: [{ fl_tipo_acoi: '10' }], id_recebimento_recb: i })).concat([{ acordo_item: [{ fl_tipo_acoi: '11' }], id_recebimento_recb: '9100', dt_vencimento_recb: campos['PARCELAS[0][VENCIMENTO]'], vl_total_recb: campos['PARCELAS[0][VALOR]'], fl_status_recb: '0', dt_liquidacao_recb: '' }]) });
      return { status: 200, json: [{ status: '200', msg: 'Acordo realizado com sucesso.', data: [{ id_cobranca: '9100', idacordo: '900' }] }] };
    }
    if (rota === 'acordos/desfazer') { const a = st.acordos.find((x) => x.id_acordo_aco === String(campos.ID_ACORDO_ACO)); if (a) a.dt_desfeito_aco = sl2(HOJE); return { status: 200, json: [{ status: '200', msg: 'Acordo cancelado com sucesso.' }] }; }
    if (rota === 'historicocobranca/') {
      st.historico.push({ id_historico_hate: '33', id_unidade_uni: campos.ID_UNIDADE_UNI, st_descricao_hate: campos.ST_DESCRICAO_HATE, st_identificadorexterno_hate: campos.ST_IDENTIFICADOREXTERNO_HATE });
      // Como no 167: a resposta traz o registro; com o dublado 'crmSemDado' só a lista confirma.
      return { status: 200, json: [{ status: '200', msg: 'Sucesso', data: o.crmSemDado ? {} : { id_historico_hate: '34', id_condominio_cond: String(campos.ID_CONDOMINIO_COND), id_unidade_uni: String(campos.ID_UNIDADE_UNI), st_descricao_hate: campos.ST_DESCRICAO_HATE } }] };
    }
    if (rota === 'unidades/post') {
      const u = String(campos.ID_UNIDADE_UNI);
      if (campos.FL_STATUSFIN_UNI !== undefined) st.status[u] = String(campos.FL_STATUSFIN_UNI);
      if (campos.ST_SACADO2_UNI !== undefined) st.sacado2[u] = campos.ST_SACADO2_UNI;
      if (campos['contatos[0][ID_CONTATO_CON]'] === '') (st.contatos[u] = st.contatos[u] || []).push({ id_contato_con: String(9100 + st.gravacoes.length), st_nome_con: campos['contatos[0][ST_NOME_CON]'], st_cpf_con: campos['contatos[0][ST_CPF_CON]'] || '', st_email_con: campos['contatos[0][ST_EMAIL_CON]'] || '', st_telefone_con: '', st_nometiporesp_tres: campos['contatos[0][FL_PROPRIETARIO_CON]'] ? 'Proprietário' : 'Inquilino', dt_saida_res: '' });
      else if (campos['contatos[0][ID_CONTATO_CON]']) { const c = (st.contatos[u] || []).find((x) => x.id_contato_con === campos['contatos[0][ID_CONTATO_CON]']); if (c) { if (campos['contatos[0][ST_EMAIL_CON]']) c.st_email_con = campos['contatos[0][ST_EMAIL_CON]']; if (campos['contatos[0][ST_TELEFONE_CON]']) c.st_telefone_con = campos['contatos[0][ST_TELEFONE_CON]']; } }
      return { status: 200, json: [{ status: '200', msg: 'ok', data: {} }] };
    }
    if (rota.startsWith('contatos/delete')) { const q = new URLSearchParams(rota.split('?')[1]); const u = q.get('idUnidade'); st.contatos[u] = (st.contatos[u] || []).filter((c) => c.id_contato_con !== q.get('idContato')); return { status: 200, json: [{ status: '200', msg: 'ok' }] }; }
    return { status: 500, json: null };
  };
  return { sl: { ler, gravar }, st, honor, totalOrigem };
}
const POL = { juros_pct: 1, multa_pct: 2, honorarios_pct: 10, desconto_max_pct: 0, teto_automatico: 5000, prazo_max_dias: 10, parcelas_max: 1 };

(async () => {
  // ---------- 1. funções puras ----------
  t('aviso não receber após vencimento', X.avisoNaoReceber('NÃO RECEBER APOS VENCIMENTO.').grave === true && X.avisoNaoReceber('Não receber após o vencimento').codigo === 'nao_receber_apos_vencimento');
  t('aviso não receber após N dias', X.avisoNaoReceber(' NÃO RECEBER APÓS 29 DIAS.').dias === 29 && X.avisoNaoReceber(' NÃO RECEBER APÓS 29 DIAS.').grave === false);
  t('sem instrução sem aviso', X.avisoNaoReceber('') === null && X.avisoNaoReceber('Sr. caixa, receber até 30 dias') === null);
  t('política válida', X.validarPolitica({ juros_pct: 1, multa_pct: 2, honorarios_pct: 10 }).erros.length === 0 && X.validarPolitica({ juros_pct: 1, multa_pct: 2 }).politica.prazo_max_dias === 10);
  t('política recusa multa acima de 2%', X.validarPolitica({ juros_pct: 1, multa_pct: 3 }).erros.length === 1);
  t('cpf e cnpj', X.cpfValido('529.982.247-25') && !X.cpfValido('11111111111') && !X.cpfValido('52998224724') && X.cpfValido('11.222.333/0001-81'));
  t('máscaras', X.mascararCpf('52998224725') === '***.***.***-25' && X.mascararTelefone('27999998888') === '(**) ****8888' && X.mascararEmail('maria@exemplo.com') === 'm***@exemplo.com');
  t('texto sem dados pessoais', X.semDadosPessoais('ligar 27 99999-8888 ou maria@x.com cpf 529.982.247-25') === 'ligar [número] ou [email] cpf [número]');
  const regua = { dias_carta1: 30, dias_carta2: 60, dias_judicial: 90 };
  const rv = (d) => ({ vencimento: new Date(HOJE.getTime() - d * 86400000) });
  t('status esperado', X.statusEsperado({ status_fin: '1', recs: [] }, regua, HOJE).esperado === '0' && X.statusEsperado({ status_fin: '0', recs: [rv(45)] }, regua, HOJE).esperado === '1'
    && X.statusEsperado({ status_fin: '', recs: [rv(70), rv(5)] }, regua, HOJE).esperado === '2' && X.statusEsperado({ status_fin: '0', recs: [rv(95)] }, regua, HOJE).esperado === '3');
  t('jurídico não muda', X.statusEsperado({ status_fin: '10', recs: [] }, regua, HOJE).manter && X.statusEsperado({ status_fin: '1', recs: [{ vencimento: rv(40).vencimento, id_processo: '9' }] }, regua, HOJE).manter);
  t('contato valida e mascara', X.validarContato({ canal: 6, resultado: 4, tipo: 2, descricao: 'Morador prometeu pagar, tel 27999998888' }).contato.descricao.includes('[número]') && X.validarContato({ canal: 9, resultado: 4, descricao: 'abc' }).erros.length === 2);

  // ---------- 2. acordo à vista ----------
  let D = dublado();
  let p = await X.prepararAcordo(D.sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL });
  t('acordo confere', p.ok && p.plano.origem.length === 2 && Math.abs(p.plano.total - (D.totalOrigem + D.honor)) < 0.011 && p.plano.honorarios_pct === 10);
  t('aviso não receber no plano', p.avisos.some((a) => a.codigo === 'nao_receber_apos_vencimento') && p.plano.aviso_nao_receber === true);
  const q = X.camposAcordo('167', p.plano);
  t('campos acordos/put', q['COBS_ORIGEM[0][ID_RECEBIMENTO_RECB]'] === '6001' && q['COBS_ORIGEM[1][VL_ACORDOMULTA_RECB]'] === '10.00' && q.NM_PARCELA_ACO === 1 && q['PARCELAS[0][VENCIMENTO]'] === '10/28/2026'
    && q.ALTERAR_ENCARGOS === 1 && q.NM_TXDESCONTO_RECB === 0 && q.ID_CONTA_BANCO === '823' && q['RECEITA_APROPRIACAO[3][ST_CONTA_CONT]'] === '1.86' && q.ID_CONDOMINIO_COND === '167');
  t('nada gravado na preparação', D.st.gravacoes.length === 0);
  let g = await X.emitirAcordo(D.sl, '167', p.plano, HOJE);
  t('acordo emitido e conferido', g.ok && g.id_acordo === '900' && g.conferido && g.divergencias.length === 0 && D.st.gravacoes.filter((x) => x.rota === 'acordos/put').length === 1);
  p = await X.prepararAcordo(D.sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL });
  t('segunda vez: sem cobrança fora de acordo ou acordo aberto', !p.ok && p.bloqueios.some((b) => b.codigo === 'acordo_aberto' || b.codigo === 'sem_cobranca'));
  t('honorário fora da política', !(await X.prepararAcordo(dublado({ honorPct: 20 }).sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL })).ok);
  const semHonor = await X.prepararAcordo(dublado({ honorPct: 10 }).sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: Object.assign({}, POL, { honorarios_pct: 0 }) });
  t('honorário em condomínio sem honorário bloqueia', !semHonor.ok && semHonor.bloqueios.some((b) => b.codigo === 'honorario_fora_da_politica'));
  const vErr = await X.prepararAcordo(dublado({ valorErrado: true }).sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL });
  t('valor que não bate bloqueia', !vErr.ok && vErr.bloqueios[0].codigo === 'valor_nao_confere');
  t('taxa diferente da política bloqueia', (await X.prepararAcordo(dublado({ multa: '1.00' }).sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL })).bloqueios.some((b) => b.codigo === 'multa_diferente'));
  t('acordo aberto bloqueia', (await X.prepararAcordo(dublado({ acordoAberto: true }).sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL })).bloqueios.some((b) => b.codigo === 'acordo_aberto'));
  t('acordo quebrado bloqueia', (await X.prepararAcordo(dublado({ parcelaAcordoVencida: true }).sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL })).bloqueios.some((b) => b.codigo === 'acordo_quebrado'));
  t('processo bloqueia', (await X.prepararAcordo(dublado({ processo: true }).sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL })).bloqueios.some((b) => b.codigo === 'juridico'));
  t('sem política não monta', (await X.prepararAcordo(dublado().sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: null })).bloqueios[0].codigo === 'sem_politica');
  t('vencimento fora do prazo', (await X.prepararAcordo(dublado().sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 10, 30), hoje: HOJE, politica: POL })).bloqueios[0].codigo === 'vencimento_fora_do_prazo');
  const teto = await X.prepararAcordo(dublado().sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: Object.assign({}, POL, { teto_automatico: 500 }) });
  t('acima do teto é sensível', teto.ok && teto.sensivel === true);
  D = dublado({ respostaAcordo: 'incerto' });
  p = await X.prepararAcordo(D.sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL });
  g = await X.emitirAcordo(D.sl, '167', p.plano, HOJE);
  t('sem resposta: incerto e uma chamada só', !g.ok && g.incerto && D.st.gravacoes.length === 1);
  D = dublado({ respostaAcordo: 'recusa' });
  p = await X.prepararAcordo(D.sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL });
  g = await X.emitirAcordo(D.sl, '167', p.plano, HOJE);
  t('recusa do Superlógica pelo corpo', !g.ok && !g.incerto && g.msg === 'Erro de regra');

  // ---------- 3. desfazer ----------
  D = dublado();
  p = await X.prepararAcordo(D.sl, { id: '167', idUnidade: '501', vencimento: new Date(2026, 9, 28), hoje: HOJE, politica: POL });
  await X.emitirAcordo(D.sl, '167', p.plano, HOJE);
  let pd = await X.prepararDesfazer(D.sl, { id: '167', idUnidade: '501', idAcordo: '900', hoje: HOJE });
  t('desfazer confere', pd.ok && pd.acordo.origem.length === 2);
  let gd = await X.desfazerAcordo(D.sl, '167', '501', pd.acordo, HOJE);
  t('desfeito e conferido', gd.ok && gd.conferido && gd.divergencias.length === 0);
  t('desfeito não desfaz de novo', !(await X.prepararDesfazer(D.sl, { id: '167', idUnidade: '501', idAcordo: '900', hoje: HOJE })).ok);
  D.st.acordos.push({ id_acordo_aco: '901', id_unidade_uni: '501', id_condominio_cond: '167', dt_acordo_aco: diasAtras(3), dt_desfeito_aco: '', recebimento: [{ acordo_item: [{ fl_tipo_acoi: '11' }], id_recebimento_recb: '9200', dt_vencimento_recb: diasAtras(1), vl_total_recb: '50', fl_status_recb: '3', dt_liquidacao_recb: diasAtras(1) }] });
  t('parcela paga não desfaz', (await X.prepararDesfazer(D.sl, { id: '167', idUnidade: '501', idAcordo: '901', hoje: HOJE })).bloqueios.some((b) => b.codigo === 'parcela_paga'));
  t('acordo de outra unidade não desfaz', (await X.prepararDesfazer(D.sl, { id: '167', idUnidade: '502', idAcordo: '901', hoje: HOJE })).bloqueios[0].codigo === 'acordo_nao_encontrado');

  // ---------- 4. CRM ----------
  D = dublado();
  const c = X.validarContato({ canal: 6, resultado: 4, motivo: 1, tipo: 2, descricao: 'Morador pediu o boleto e prometeu pagar sexta' }).contato;
  const gc = await X.registrarContato(D.sl, '167', '501', c, new Date(2026, 9, 23, 14, 5));
  const gcCampos = D.st.gravacoes[0].campos;
  const gc2 = await X.registrarContato(dublado({ crmSemDado: true }).sl, '167', '501', c, new Date(2026, 9, 23, 14, 5));
  t('CRM sem dado na resposta confere pela lista', gc2.ok && gc2.conferido && gc2.id_historico === '33');
  t('CRM gravado e conferido pela resposta', gc.ok && gc.conferido && gc.id_historico === '34' && gcCampos.FL_VIA_API === 1 && gcCampos.DT_DATA_HATE === '10/23/2026' && gcCampos.DT_HORA_HATE === '14:05' && gcCampos.FL_AGENDAR_CONTATO === 0 && /^HUB[0-9A-F]{12}$/.test(gcCampos.ST_IDENTIFICADOREXTERNO_HATE));

  // ---------- 5. status financeiro ----------
  D = dublado({ statusUni: '1' });
  const an = await X.analisarStatus(D.sl, '167', HOJE);
  const d501 = an.divergencias.find((x) => x.id_unidade === '501');
  const d503 = an.divergencias.find((x) => x.id_unidade === '503');
  t('análise: 501 com 40 dias está certa em primeira notificação', !d501);
  t('análise: 503 com 400 dias deveria estar na terceira (já está)', !d503);
  D.st.status[501] = '3';
  const an2 = await X.analisarStatus(D.sl, '167', HOJE);
  const x501 = an2.divergencias.find((x) => x.id_unidade === '501');
  t('análise: baixar 3 para 1', x501 && x501.de === '3' && x501.para === '1' && x501.direcao === 'baixar');
  t('conferência da correção', (await X.conferirCorrecaoStatus(D.sl, '167', { id_unidade: '501', de: '3', para: '1' }, HOJE)).ok
    && (await X.conferirCorrecaoStatus(D.sl, '167', { id_unidade: '501', de: '2', para: '1' }, HOJE)).codigo === 'status_mudou'
    && (await X.conferirCorrecaoStatus(D.sl, '167', { id_unidade: '501', de: '3', para: '0' }, HOJE)).codigo === 'correcao_mudou');
  const gs = await X.gravarStatus(D.sl, '167', { id_unidade: '501', de: '3', para: '1' });
  t('status gravado e relido', gs.ok && gs.conferido && D.st.status[501] === '1' && D.st.gravacoes[0].campos.FL_STATUSFIN_UNI === '1');

  // ---------- 6. cadastro ----------
  D = dublado();
  let u = (await D.sl.ler('unidades/index', { idCondominio: '167', id: '501' }))[0];
  let cc = X.conferirCadastro(u, { tipo: 'contato_atualizar', dados: { id_contato: '9002', email: 'joao@exemplo.com' } }, { hoje: HOJE, historico: [] });
  t('atualizar email do inquilino', cc.ok && !cc.sensivel && cc.passos.length === 1 && cc.depois.email === 'j***@exemplo.com');
  let gcad = await X.gravarCadastro(D.sl, '167', '501', cc.passos);
  t('email gravado e conferido', gcad.ok && gcad.conferido && gcad.divergencias.length === 0);
  cc = X.conferirCadastro(u, { tipo: 'contato_atualizar', dados: { id_contato: '9001', email: 'nova@exemplo.com' } }, { hoje: HOJE, historico: [] });
  t('email do dono é sensível', cc.ok && cc.sensivel);
  t('dono não sai sozinho', !X.conferirCadastro(u, { tipo: 'contato_sair', dados: { id_contato: '9001' } }, { hoje: HOJE, historico: [] }).ok);
  cc = X.conferirCadastro(u, { tipo: 'contato_incluir', dados: { papel: 'inquilino', nome: 'Ana Souza Lima', cpf: '', email: 'ana@exemplo.com', telefone: '27988887777', entrada: '2026-10-20' } }, { hoje: HOJE, historico: [] });
  t('incluir inquilino', cc.ok && cc.passos[0].campos['contatos[0][ID_LABEL_TRES]'] === '7' && cc.passos[0].campos['contatos[0][DT_ENTRADA_RES]'] === '10/20/2026 00:00:00');
  cc = X.conferirCadastro(u, { tipo: 'contato_incluir', dados: { papel: 'responsavel_financeiro', nome: 'Luiz Prado Neto', cpf: '11144477735' } }, { hoje: HOJE, historico: [] });
  t('responsável financeiro: inquilino 7/7 e dono passa a só extras', cc.ok && cc.sensivel && cc.passos.length === 2 && cc.passos[0].campos['contatos[0][ID_TIPORESP_TRES]'] === '7'
    && cc.passos[1].campos['contatos[0][ID_CONTATO_CON]'] === '9001' && cc.passos[1].campos['contatos[0][ID_TIPORESP_TRES]'] === '2');
  const uRf = { id_unidade_uni: '501', id_condominio_cond: '167', contatos: [{ id_contato_con: '1', st_nome_con: 'DONO X', fl_proprietario_con: '1', id_tiporesp_tres: '2' }, { id_contato_con: '2', st_nome_con: 'RESP Y', id_label_tres: '7', id_tiporesp_tres: '7', st_nometiporesp_tres: 'Inquilino' }] };
  const sRf = X.conferirCadastro(uRf, { tipo: 'contato_sair', dados: { id_contato: '2' } }, { hoje: HOJE, historico: [] });
  t('saída do responsável financeiro devolve a cobrança ao dono', sRf.ok && sRf.sensivel && sRf.passos.length === 2 && sRf.passos[1].campos['contatos[0][ID_TIPORESP_TRES]'] === '1');
  t('inquilino comum não recebe cobrança', X.conferirCadastro(u, { tipo: 'contato_incluir', dados: { papel: 'inquilino', nome: 'Ana Souza Lima' } }, { hoje: HOJE, historico: [] }).passos[0].campos['contatos[0][ID_TIPORESP_TRES]'] === '4');
  t('CPF inválido recusa', !X.conferirCadastro(u, { tipo: 'contato_incluir', dados: { papel: 'inquilino', nome: 'Ana Souza', cpf: '123' } }, { hoje: HOJE, historico: [] }).ok);
  cc = X.conferirCadastro(u, { tipo: 'troca_proprietario', dados: { id_contato_antigo: '9001', nome: 'Pedro Alves Costa', cpf: '11144477735', entrada: '2026-10-22', documento_conferido: true } }, { hoje: HOJE, historico: [] });
  t('troca de proprietário: dois passos e sensível', cc.ok && cc.sensivel && cc.passos.length === 2 && /^contatos\/delete\?idUnidade=501&idCondominio=167&idContato=9001$/.test(cc.passos[1].rota) && cc.antes.cpf === '***.***.***-25');
  gcad = await X.gravarCadastro(D.sl, '167', '501', cc.passos);
  t('troca gravada e conferida', gcad.ok && gcad.conferido && gcad.divergencias.length === 0 && D.st.contatos[501].every((x) => x.id_contato_con !== '9001'));
  t('troca sem documento conferido recusa', !X.conferirCadastro(u, { tipo: 'troca_proprietario', dados: { id_contato_antigo: '9001', nome: 'Pedro Alves Costa', cpf: '11144477735' } }, { hoje: HOJE, historico: [] }).ok);
  const hist = [{ tipo: 'segundo_sacado', em: new Date(2026, 9, 1).toISOString(), antes: { segundo_sacado: 'RAFAEL BATISTA' } }, { tipo: 'segundo_sacado', em: new Date(2026, 9, 2).toISOString(), antes: { segundo_sacado: '' } }];
  cc = X.conferirCadastro(u, { tipo: 'segundo_sacado', dados: { nome: 'Rafael Batista' } }, { hoje: HOJE, historico: hist });
  t('segundo sacado vai e volta: aviso e sensível', cc.ok && cc.sensivel && cc.avisos.some((a) => a.codigo === 'vai_e_volta'));
  t('segundo sacado simples', X.conferirCadastro(u, { tipo: 'segundo_sacado', dados: { nome: 'Rafael Batista' } }, { hoje: HOJE, historico: [] }).sensivel === false);

  // ---------- 7. relatório ----------
  D = dublado();
  const inad = await X.inadimplencia(D.sl, '167', HOJE);
  const rs = X.montarRelatorio(inad, { hoje: HOJE, destino: 'sindico', nome: 'Residencial Teste' });
  const re = X.montarRelatorio(inad, { hoje: HOJE, destino: 'escritorio' });
  const txt = JSON.stringify(rs);
  t('relatório separa recente e antiga', rs.recente.unidades === 1 && rs.antiga.unidades === 1 && rs.antiga.linhas[0].faixa === 'mais de 1 ano' && rs.recente.linhas[0].dias === 40);
  t('relatório do síndico sem nome, CPF ou contato', !/MARIA|CARLOS|@|529982/.test(txt));
  t('relatório do escritório com nome e sem CPF ou email', re.recente.linhas[0].responsavel === 'MARIA DA SILVA' && !/@|529982|27999/.test(JSON.stringify(re)));

  // ---------- 8. rotas com a política única ----------
  let env = {};
  const eventos = [];
  const pol = W.criarPoliticaEscrita({ env: () => env, auditar: (req, acao, det) => eventos.push({ acao, det }), condominioDaBase: async (id) => ({ 167: { nome: 'Residencial Teste' }, 136: { nome: 'Condomínio Casablanca' } })[id] || null });
  const tabelas = { cob_politica_acordo: [], cob_historico: [] };
  const banco = {
    ler: async (c) => { const [tab, q] = c.split('?'); const m = (q || '').match(/id_superlogica=eq\.(\d+)/); return tabelas[tab].filter((l) => !m || String(l.id_superlogica) === m[1]); },
    upsert: async (tab, linhas) => { linhas.forEach((l) => { tabelas[tab] = tabelas[tab].filter((x) => x.id_superlogica !== l.id_superlogica).concat([l]); }); return linhas.length; },
    inserir: async (tab, l) => { tabelas[tab].push(Object.assign({ em: new Date().toISOString() }, l)); return true; },
    apagar: async (c) => { const [tab, q] = c.split('?'); const m = (q || '').match(/id_superlogica=eq\.(\d+)/); const fora = tabelas[tab].filter((l) => m && String(l.id_superlogica) === m[1]); tabelas[tab] = tabelas[tab].filter((l) => !fora.includes(l)); return fora; },
  };
  let DUB = dublado();
  const perfis = { gestor: { role: 'GESTOR', email: 'g@x' }, analista: { role: 'ANALISTA', email: 'a@x', permissoes: { cobranca: { visivel: true, acoes: ['ver'] } } },
    gerente: { role: 'GERENTE', email: 'ge@x' }, analistaPol: { role: 'ANALISTA', email: 'ap@x', permissoes: { cobranca: { visivel: true, acoes: ['ver', 'politica_acordo'] } } } };
  const app = express();
  R.registrar({ app, express, requireAuth: (req, res, next) => { req.authMode = 'supabase'; req.user = { sub: req.headers['x-usuario'] || 'gestor' }; next(); },
    lerPerfil: async (s) => perfis[s] || null, exigirLeituraSuperlogica: async () => true, exigirCarteira: async () => true, politica: pol,
    clienteSL: () => ({ get: (r, p2) => DUB.sl.ler(r, p2) }), credSL: () => ({}), gravador: (cred, m, r, c2) => DUB.sl.gravar(m, r, c2),
    banco, hoje: () => HOJE, agora: () => new Date(2026, 9, 23, 10, 0), log: () => {} });
  const srv = http.createServer(app);
  await new Promise((okk) => srv.listen(0, okk));
  const porta = srv.address().port;
  const chamar = (metodo, caminho, corpo, usuario) => new Promise((okk) => {
    const dados = corpo ? JSON.stringify(corpo) : '';
    const rq = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados), 'x-usuario': usuario || 'gestor' } }, (rs2) => {
      const ps = []; rs2.on('data', (x) => ps.push(x)); rs2.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(ps).toString()); } catch (e) { j = null; } okk({ st: rs2.statusCode, j }); });
    });
    rq.end(dados);
  });
  let r = await chamar('POST', '/api/cobranca/condominio/167/acordo/preparar', { id_unidade: '501', vencimento: '2026-10-28' });
  t('rota preparar sem política: bloqueio', r.st === 200 && r.j.ok === false && r.j.bloqueios[0].codigo === 'sem_politica');
  r = await chamar('PUT', '/api/cobranca/condominio/167/politica', POL, 'analista');
  t('analista não cadastra política', r.st === 403);
  r = await chamar('PUT', '/api/cobranca/condominio/167/politica', Object.assign({}, POL, { multa_pct: 5 }));
  t('política inválida recusada', r.st === 400);
  r = await chamar('PUT', '/api/cobranca/condominio/167/politica', POL);
  t('política gravada com histórico', r.st === 200 && tabelas.cob_politica_acordo.length === 1 && tabelas.cob_historico.some((h) => h.tipo === 'politica'));
  // remover a política: só GESTOR ou GERENTE, com histórico (depois null)
  r = await chamar('DELETE', '/api/cobranca/condominio/167/politica', null, 'analista');
  t('analista não remove política', r.st === 403 && tabelas.cob_politica_acordo.length === 1);
  r = await chamar('DELETE', '/api/cobranca/condominio/167/politica', null, 'analistaPol');
  t('ação politica_acordo sem cargo de gestão não remove', r.st === 403 && tabelas.cob_politica_acordo.length === 1);
  r = await chamar('DELETE', '/api/cobranca/condominio/167/politica', null, 'gerente');
  const hRem = tabelas.cob_historico.filter((h) => h.tipo === 'politica').pop();
  t('gerente remove política com histórico antes e depois null', r.st === 200 && r.j.removida && tabelas.cob_politica_acordo.length === 0 && hRem.depois === null && hRem.antes && hRem.antes.juros_pct === POL.juros_pct && hRem.por_email === 'ge@x');
  r = await chamar('DELETE', '/api/cobranca/condominio/167/politica', null, 'gestor');
  t('remover sem política responde 404', r.st === 404);
  r = await chamar('POST', '/api/cobranca/condominio/167/acordo/preparar', { id_unidade: '501', vencimento: '2026-10-28' });
  t('sem política depois de remover: não monta acordo', r.st === 200 && r.j.ok === false && r.j.bloqueios[0].codigo === 'sem_politica');
  r = await chamar('PUT', '/api/cobranca/condominio/167/politica', POL);
  r = await chamar('DELETE', '/api/cobranca/condominio/167/politica', null, 'gestor');
  t('gestor remove política', r.st === 200 && tabelas.cob_politica_acordo.length === 0);
  r = await chamar('PUT', '/api/cobranca/condominio/167/politica', POL);
  t('política cadastrada de novo', r.st === 200 && tabelas.cob_politica_acordo.length === 1);
  r = await chamar('POST', '/api/cobranca/condominio/167/acordo/preparar', { id_unidade: '501', vencimento: '2026-10-28' });
  t('rota preparar: plano sem CPF', r.st === 200 && r.j.ok && r.j.plano.total > 1000 && !/529982|@/.test(JSON.stringify(r.j)));
  r = await chamar('POST', '/api/cobranca/condominio/167/acordo/emitir', { id_unidade: '501', vencimento: '2026-10-28' }, 'analista');
  t('analista sem ação acordo não emite', r.st === 403 && DUB.st.gravacoes.length === 0);
  r = await chamar('POST', '/api/cobranca/condominio/167/acordo/emitir', { id_unidade: '501', vencimento: '2026-10-28' });
  t('167 emite direto (livre)', r.st === 200 && r.j.ok && r.j.id_acordo === '900' && r.j.conferido && DUB.st.gravacoes.length === 1);
  t('auditoria e histórico do acordo', eventos.some((e) => e.acao === 'gravacao_superlogica' && e.det.operacao === 'acordo_emitir' && e.det.ok) && tabelas.cob_historico.some((h) => h.tipo === 'acordo_emitir' && h.ok));
  r = await chamar('POST', '/api/cobranca/condominio/136/acordo/emitir', { id_unidade: '501', vencimento: '2026-10-28' });
  t('outro condomínio bloqueado no modo teste', r.st === 423 && r.j.motivo === 'so_teste');
  env = { ESCRITA_SUPERLOGICA: 'confirmacao' };
  DUB = dublado();
  await chamar('PUT', '/api/cobranca/condominio/136/politica', POL);
  r = await chamar('POST', '/api/cobranca/condominio/136/acordo/emitir', { id_unidade: '501', vencimento: '2026-10-28' });
  t('fora do teste pede confirmação com resumo e aviso', r.st === 428 && r.j.resumo.condominio === 'Condomínio Casablanca' && /não receber|NÃO RECEBER/i.test(r.j.resumo.aviso || '') && DUB.st.gravacoes.length === 0);
  const tok = r.j.confirmacao;
  r = await chamar('POST', '/api/cobranca/condominio/136/acordo/emitir', { id_unidade: '501', vencimento: '2026-10-29', confirmacao_gravacao: { token: tok.token, id_condominio: tok.id_condominio } });
  t('vencimento mudou depois da confirmação: pede de novo', r.st === 428 && r.j.motivo === 'conteudo_alterado' && DUB.st.gravacoes.length === 0);
  const tok2 = r.j.confirmacao;
  r = await chamar('POST', '/api/cobranca/condominio/136/acordo/emitir', { id_unidade: '501', vencimento: '2026-10-29', confirmacao_gravacao: { token: tok2.token, id_condominio: tok2.id_condominio } });
  t('confirmado grava uma vez', r.st === 200 && r.j.ok && DUB.st.gravacoes.length === 1);
  r = await chamar('POST', '/api/cobranca/condominio/136/acordo/emitir', { id_unidade: '501', vencimento: '2026-10-29', confirmacao_gravacao: { token: tok2.token, id_condominio: tok2.id_condominio } });
  t('reuso da confirmação não grava de novo', (r.st === 409 || r.st === 422) && DUB.st.gravacoes.length === 1);
  // desfazer pela rota
  r = await chamar('POST', '/api/cobranca/condominio/136/acordo/desfazer', { id_unidade: '501', id_acordo: '900' });
  t('desfazer pede confirmação', r.st === 428);
  r = await chamar('POST', '/api/cobranca/condominio/136/acordo/desfazer', { id_unidade: '501', id_acordo: '900', confirmacao_gravacao: { token: r.j.confirmacao.token, id_condominio: '136' } });
  t('desfazer confirmado', r.st === 200 && r.j.ok && DUB.st.gravacoes.filter((x) => x.rota === 'acordos/desfazer').length === 1);
  // incerto trava a unidade
  env = {};
  DUB = dublado({ respostaAcordo: 'incerto' });
  r = await chamar('POST', '/api/cobranca/condominio/167/acordo/emitir', { id_unidade: '501', vencimento: '2026-10-28' });
  t('incerto responde 504', r.st === 504 && r.j.erro === 'resultado_incerto');
  r = await chamar('POST', '/api/cobranca/condominio/167/acordo/emitir', { id_unidade: '501', vencimento: '2026-10-28' });
  t('depois do incerto a unidade fica travada', r.st === 409 && DUB.st.gravacoes.length === 1);
  // CRM pela rota
  DUB = dublado();
  r = await chamar('POST', '/api/cobranca/condominio/167/contato', { id_unidade: '501', canal: 1, resultado: 10, tipo: 1, descricao: 'Liguei e não atendeu' });
  t('CRM pela rota', r.st === 200 && r.j.ok && r.j.conferido);
  r = await chamar('POST', '/api/cobranca/condominio/167/contato', { id_unidade: '999', canal: 1, resultado: 10, tipo: 1, descricao: 'Liguei e não atendeu' });
  t('CRM em unidade de fora recusa', r.st === 404);
  // status financeiro em lote fora do teste
  env = { ESCRITA_SUPERLOGICA: 'confirmacao' };
  DUB = dublado({ statusUni: '3' });
  r = await chamar('GET', '/api/cobranca/condominio/136/status-financeiro');
  const div = r.j.divergencias.find((x) => x.id_unidade === '501');
  t('rota status mostra divergência', r.st === 200 && div && div.para === '1');
  r = await chamar('POST', '/api/cobranca/condominio/136/status-financeiro/previa', { itens: [{ id_unidade: '501', de: '3', para: '0' }] });
  t('prévia com correção que não bate recusa', r.st === 409);
  r = await chamar('POST', '/api/cobranca/condominio/136/status-financeiro/previa', { itens: [{ id_unidade: '501', de: '3', para: '1' }] });
  t('prévia pede confirmação', r.st === 428);
  r = await chamar('POST', '/api/cobranca/condominio/136/status-financeiro/previa', { itens: [{ id_unidade: '501', de: '3', para: '1' }], confirmacao_gravacao: { token: r.j.confirmacao.token, id_condominio: '136' } });
  t('prévia confirmada', r.st === 200 && r.j.confirmado);
  const tl = r.j.confirmacao;
  r = await chamar('POST', '/api/cobranca/condominio/136/status-financeiro/gravar', { id_unidade: '501', de: '3', para: '1', confirmacao_gravacao: { token: tl.token, id_condominio: '136' } });
  t('item do lote gravado', r.st === 200 && r.j.ok && r.j.conferido && DUB.st.status[501] === '1');
  r = await chamar('POST', '/api/cobranca/condominio/136/status-financeiro/gravar', { id_unidade: '501', de: '3', para: '1', confirmacao_gravacao: { token: tl.token, id_condominio: '136' } });
  t('item do lote não grava duas vezes', r.st === 409 && DUB.st.gravacoes.length === 1);
  // cadastro: troca de proprietário pede o nome digitado
  r = await chamar('POST', '/api/cobranca/condominio/136/cadastro/501/gravar', { tipo: 'troca_proprietario', dados: { id_contato_antigo: '9001', nome: 'Pedro Alves Costa', cpf: '11144477735', documento_conferido: true } });
  t('troca de proprietário pede confirmação reforçada', r.st === 428 && r.j.confirmacao.reforcada === true && r.j.confirmacao.nome_curto === 'Casablanca' && !/11144477735/.test(JSON.stringify(r.j)));
  r = await chamar('POST', '/api/cobranca/condominio/136/cadastro/501/gravar', { tipo: 'troca_proprietario', dados: { id_contato_antigo: '9001', nome: 'Pedro Alves Costa', cpf: '11144477735', documento_conferido: true }, confirmacao_gravacao: { token: r.j.confirmacao.token, id_condominio: '136', nome_digitado: 'casablanca' } });
  t('troca confirmada e histórico mascarado', r.st === 200 && r.j.ok && tabelas.cob_historico.some((h) => h.tipo === 'troca_proprietario' && h.ok && !/11144477735|52998224725/.test(JSON.stringify(h))));
  r = await chamar('GET', '/api/cobranca/condominio/136/cadastro/501');
  t('ficha mascarada', r.st === 200 && !/52998224725|27999998888|maria@exemplo/.test(JSON.stringify(r.j)) && r.j.historico.length >= 1);
  r = await chamar('GET', '/api/cobranca/condominio/136/relatorio-inadimplencia?destino=escritorio', null, 'analista');
  t('analista sem ação não vê relatório do escritório', r.st === 403);
  r = await chamar('GET', '/api/cobranca/condominio/136/relatorio-inadimplencia?destino=sindico', null, 'analista');
  t('relatório do síndico para quem vê a cobrança', r.st === 200 && r.j.destino === 'sindico' && !r.j.recente.linhas.some((l) => l.responsavel));
  env = { ESCRITA_SUPERLOGICA: 'off' };
  r = await chamar('POST', '/api/cobranca/condominio/167/contato', { id_unidade: '501', canal: 1, resultado: 10, tipo: 1, descricao: 'Liguei e não atendeu' });
  t('interruptor off bloqueia até o 167', r.st === 423 && r.j.motivo === 'escrita_desligada');
  t('operações registradas na política', ['acordo_emitir', 'acordo_desfazer', 'crm_contato', 'status_financeiro', 'cadastro_unidade'].every((k) => W.OPERACOES[k]));
  t('nenhum envio de mensagem', ![].concat(...[DUB].map((x) => x.st.gravacoes)).some((x) => /comunicados|notificar|email|sms/i.test(x.rota)));
  srv.close();

  console.log(ok + ' ok, ' + falhou + ' falharam');
  process.exit(falhou ? 1 : 0);
})().catch((e) => { console.log('ERRO', e); process.exit(1); });
