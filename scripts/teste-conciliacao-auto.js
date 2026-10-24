// Testes da conciliação automática do dia, com o Superlógica dublado (sem rede):
// NODE_PATH=<repo>/node_modules node scripts/teste-conciliacao-auto.js
// Cobre: reconhecer a conta do OFX; importar só os dias novos (nunca o período já importado, nunca
// o dia de hoje); OFX recortado; regras (tarifa, transferência, CESAN, rendimento e IR, PJBank,
// regra ensinada); gravação na ordem certa com os campos testados no 167; prova relendo; item nunca
// gravado duas vezes; resposta incerta nunca repetida; trava de sobreposição; fila (aceitar, corrigir,
// ignorar); avisos; política (só 167 no teste, confirmação fora dele) e as rotas.
process.env.NODE_ENV = 'test';
const http = require('http');
const express = require('express');
const A = require('../financeiro/conciliacao-auto');
const G = require('../financeiro/conciliacao-gravar');
const D = require('../financeiro/conciliacao-dia');
const ARM = require('../financeiro/conciliacao-armazem');
const W = require('../servico/escrita-superlogica');
const C = A.C;

let ok = 0, falhou = 0;
function t(nome, cond) { if (cond) ok++; else { falhou++; console.log('FALHOU: ' + nome); } }
const slData = (iso) => iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4);
const isoDeSl = (s) => { const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? m[3] + '-' + m[1] + '-' + m[2] : null; };

// ── Superlógica dublado ───────────────────────────────────────────────────
function criarSL() {
  const s = {
    contas: [
      { id_contabanco_cb: '823', id_condominio_cond: '167', st_descricao_cb: 'Conta Principal', st_nome_banc: 'SICOOB', id_tipocontabanco_tcb: '1', fl_principal_cb: '1', st_conta_cb: '000037407-5', st_numero_agb: '3007-4' },
      { id_contabanco_cb: '824', id_condominio_cond: '167', st_descricao_cb: 'Poupança Fundo de Reserva', st_nome_banc: 'SICOOB', id_tipocontabanco_tcb: '8', fl_principal_cb: '0', st_conta_cb: '000099001-2', st_numero_agb: '3007-4' },
      { id_contabanco_cb: '909', id_condominio_cond: '167', st_descricao_cb: 'Caixinha', st_nome_banc: 'CAIXINHA', id_tipocontabanco_tcb: '3', fl_principal_cb: '0', st_conta_cb: '', st_numero_agb: '' },
      { id_contabanco_cb: '635', id_condominio_cond: '136', st_descricao_cb: 'Conta Banestes', st_nome_banc: 'BANESTES', id_tipocontabanco_tcb: '1', fl_principal_cb: '1', st_conta_cb: '12.345.678-9', st_numero_agb: '0123' },
      { id_contabanco_cb: '700', id_condominio_cond: '144', st_descricao_cb: 'Empresa', st_nome_banc: 'SICOOB', id_tipocontabanco_tcb: '1', fl_principal_cb: '1', st_conta_cb: '000055555-5', st_numero_agb: '3007-4' },
    ],
    extrato: {
      823: [
        { data: '2026-10-15', valor: 100000, descricao: 'CRED PIX JOAO', fitid: 'A1' },
        { data: '2026-10-20', valor: -5000, descricao: 'PAG BOLETO JARDINAGEM', fitid: 'A2' },
      ],
      824: [
        { data: '2026-09-05', valor: 120, descricao: 'JUROS POUPANCA', fitid: 'P1' },
        { data: '2026-09-05', valor: -20, descricao: 'IRRF POUPANCA', fitid: 'P2' },
      ],
      635: [],
    },
    sistema: { 823: [{ data: '2026-10-15', valor: 100000, descricao: 'Receita PIX' }, { data: '2026-10-20', valor: -5000, descricao: 'Jardinagem' }], 824: [], 635: [] },
    despesas: {
      167: [
        { id_despesa_des: '1', id_parcela_pdes: '11', id_condominio_cond: '167', id_contato_con: '68185', st_nome_con: 'SICOOB', vl_valor_pdes: '12.50', dt_vencimento_pdes: '08/21/2026', dt_liquidacao_pdes: '08/21/2026', id_contabanco_cb: '823', apropriacao: [{ st_conta_cont: '2.2.1', st_descricao_cont: 'Tarifas Bancárias' }] },
        { id_despesa_des: '2', id_parcela_pdes: '12', id_condominio_cond: '167', id_contato_con: '68185', st_nome_con: 'SICOOB', vl_valor_pdes: '12.50', dt_vencimento_pdes: '09/21/2026', dt_liquidacao_pdes: '09/21/2026', id_contabanco_cb: '823', apropriacao: [{ st_conta_cont: '2.2.1', st_descricao_cont: 'Tarifas Bancárias' }] },
        { id_despesa_des: '3', id_parcela_pdes: '13', id_condominio_cond: '167', id_contato_con: '555', st_nome_con: 'CESAN', vl_valor_pdes: '140.97', dt_vencimento_pdes: '10/22/2026', dt_liquidacao_pdes: '', id_contabanco_cb: '823', st_documento_des: '778899', apropriacao: [{ st_conta_cont: '2.3.1', st_descricao_cont: 'Água e esgoto' }] },
      ],
      136: [],
    },
    chamadas: [], gets: [], seq: 900000, modo: null,
  };
  const linhasConc = (idConta, ini, fim) => {
    const dentro = (d) => d >= ini && d <= fim;
    return [].concat(
      (s.extrato[idConta] || []).filter((x) => dentro(x.data)).map((x) => ({ id_conta_banco: idConta, data_banco: slData(x.data), valor_banco: (x.valor / 100).toFixed(2), descricao_banco: x.descricao, fitid_banco: x.fitid, desconsiderar_lancamento_banco: '0' })),
      (s.sistema[idConta] || []).filter((x) => dentro(x.data)).map((x) => ({ id_conta_software: idConta, data_software: slData(x.data), valor_software: (x.valor / 100).toFixed(2), descricao_software: x.descricao })),
    );
  };
  s.cliente = {
    async get(acao, p) {
      s.gets.push(acao);
      if (acao === 'contabancos/index') return s.contas;
      if (acao === 'conciliacao/index') return { itens: linhasConc(String(p.idConta), isoDeSl(p.dtInicio), isoDeSl(p.dtFim)) };
      if (acao === 'despesas/index') return Number(p.pagina) > 1 ? [] : (s.despesas[String(p.idCondominio)] || []).filter((d) => { const v = isoDeSl(d.dt_vencimento_pdes); return v >= isoDeSl(p.dtInicio) && v <= isoDeSl(p.dtFim); });
      if (acao === 'condominios/get') return [{ id_condominio_cond: '167', st_fantasia_cond: 'Residencial Teste' }, { id_condominio_cond: '136', st_fantasia_cond: 'Casablanca' }, { id_condominio_cond: '150', st_fantasia_cond: 'Novo Ainda' }];
      if (acao === 'fornecedores/index') return String(p.id) === '777' ? [{ id_contato_con: '777', st_nome_con: 'FORNECEDOR XYZ' }] : [];
      throw new Error('rota não dublada ' + acao);
    },
  };
  s.pedir = async (cred, metodo, caminho, query, corpo, tipo) => {
    s.chamadas.push({ metodo, caminho, tipo, corpo: corpo ? corpo.toString('latin1') : '' });
    const modo = s.modo; s.modo = null;
    if (modo === 'cair') return { status: 504, json: null };
    if (caminho === 'conciliacao/put') {
      const txt = corpo.toString('latin1');
      const campo = (n) => { const m = txt.match(new RegExp('name="' + n + '"\\r\\n\\r\\n([^\\r]*)')); return m ? m[1] : null; };
      const conta = campo('ID_CONTABANCO_CB');
      const ofx = C.lerOfx(txt.slice(txt.indexOf('OFXHEADER')));
      ofx.itens.forEach((x) => s.extrato[conta].push({ data: x.data, valor: x.valor, descricao: x.descricao, fitid: x.fitid }));
      if (modo === 'cair_depois') return { status: 504, json: null };
      return { status: 200, json: { status: '200', msg: 'Sucesso', data: [] } };
    }
    if (caminho === 'despesas/put') {
      const p = new URLSearchParams(corpo.toString('utf8'));
      const id = String(++s.seq);
      const v = Math.round(Number(p.get('APROPRIACAO[0][VL_VALOR_PDES]')) * 100);
      const cond = p.get('ID_CONDOMINIO_COND'), conta = p.get('ID_CONTABANCO_CB');
      s.despesas[cond].push({ id_despesa_des: id, id_parcela_pdes: id + '1', id_condominio_cond: cond, id_contato_con: p.get('ID_CONTATO_CON'), vl_valor_pdes: (v / 100).toFixed(2), dt_vencimento_pdes: p.get('DT_VENCIMENTOPRIMEIRAPARCELA'), dt_liquidacao_pdes: p.get('DT_LIQUIDACAO_PDES'), id_contabanco_cb: conta, apropriacao: [{ st_conta_cont: p.get('APROPRIACAO[0][ST_CONTA_CONT]') }] });
      s.sistema[conta].push({ data: isoDeSl(p.get('DT_LIQUIDACAO_PDES')), valor: -v, descricao: 'Despesa ' + id });
      return { status: 200, json: [{ status: '200', msg: 'ok', data: { id_despesa_des: id } }] };
    }
    if (caminho === 'Transferencias/put') {
      const p = new URLSearchParams(corpo.toString('utf8'));
      const v = Math.round(Number(p.get('VL_VALOR_MOV')) * 100), d = isoDeSl(p.get('DT_DATA_MOV'));
      s.sistema[p.get('ID_CONTABANCO_CB')].push({ data: d, valor: -v, descricao: 'Transferência' });
      s.sistema[p.get('ID_TRANSFERIDOPARA_MOV')].push({ data: d, valor: v, descricao: 'Transferência' });
      return { status: 200, json: { status: '200', msg: 'ok', data: [{ status: '200', msg: 'ok', data: { id_contabanco_mov: String(++s.seq) } }] } };
    }
    return { status: 200, json: { status: '500', msg: 'rota desconhecida' } };
  };
  return s;
}
function ofxTexto({ banco, agencia, conta, itens }) {
  const trn = itens.map((x) => '<STMTTRN>\n<TRNTYPE>' + (x.valor < 0 ? 'DEBIT' : 'CREDIT') + '\n<DTPOSTED>' + x.data.replace(/-/g, '') + '120000[-3:BRT]\n<TRNAMT>' + (x.valor / 100).toFixed(2) + '\n<FITID>' + x.fitid + '\n<MEMO>' + x.descricao + '\n</STMTTRN>').join('\n');
  return 'OFXHEADER:100\nDATA:OFXSGML\n\n<OFX>\n<BANKMSGSRSV1><STMTTRNRS><STMTRS>\n<BANKACCTFROM>\n<BANKID>' + banco + '\n<BRANCHID>' + agencia + '\n<ACCTID>' + conta + '\n</BANKACCTFROM>\n<BANKTRANLIST>\n' + trn + '\n</BANKTRANLIST>\n</STMTRS></STMTTRNRS></BANKMSGSRSV1>\n</OFX>\n';
}

(async () => {
  // ── 1. reconhecer a conta ───────────────────────────────────────────────
  const sl0 = criarSL();
  const contas = sl0.contas.map(A.contaInterna);
  t('código do banco pelo nome', A.codigoBanco({ st_nome_banc: 'SICOOB' }) === '756' && A.codigoBanco({ st_nome_banc: 'Banestes S.A.' }) === '21');
  const id1 = A.identificarConta({ banco: '0756', agencia: '3007', conta: '374075' }, contas);
  t('conta exata sem zeros e sem traço', id1.situacao === 'identificada' && id1.conta.id === '823');
  t('conta sem dígito verificador', A.identificarConta({ banco: '756', conta: '37407' }, contas).conta.id === '823');
  t('agência junto da conta no ACCTID', A.identificarConta({ banco: '756', conta: '3007374075' }, contas).conta.id === '823');
  t('banco diferente não reconhece', A.identificarConta({ banco: '001', conta: '374075' }, contas).situacao === 'nao_encontrada');
  t('conta que não existe', A.identificarConta({ banco: '756', conta: '11112222' }, contas).situacao === 'nao_encontrada');
  t('arquivo sem conta', A.identificarConta({ banco: '756', conta: '' }, contas).situacao === 'sem_conta_no_arquivo');
  const dup = contas.concat([Object.assign({}, contas[0], { id: '999', id_condominio: '150', agencia: '40001' })]);
  t('mesma conta em duas agências: desempata pela agência', A.identificarConta({ banco: '756', agencia: '3007-4', conta: '374075' }, dup).conta.id === '823');
  t('mesma conta sem agência no arquivo: ambígua', A.identificarConta({ banco: '756', conta: '374075' }, dup).situacao === 'ambigua');
  t('final da conta só com 4 dígitos', A.finalConta('000037407-5') === '4075');

  // ── 2. plano sem sobreposição ───────────────────────────────────────────
  const itensArq = [
    { data: '2026-10-18', valor: -7700, descricao: 'DEB DIVERSOS', fitid: 'B0' },
    { data: '2026-10-20', valor: -5000, descricao: 'PAG BOLETO JARDINAGEM', fitid: 'A2' },
    { data: '2026-10-21', valor: -1250, descricao: 'TARIFA PACOTE SERVICOS', fitid: 'B1' },
    { data: '2026-10-21', valor: -30000, descricao: 'TRANSF MSM TIT POUP', fitid: 'B2' },
    { data: '2026-10-22', valor: -14097, descricao: 'DEB CONV CESAN 778899', fitid: 'B3' },
    { data: '2026-10-22', valor: 250000, descricao: 'RECEBIDO DE CONDOMINOS: 5 COBRANCAS', fitid: 'B4' },
    { data: '2026-10-22', valor: 250000, descricao: 'RECEBIDO DE CONDOMINOS: 5 COBRANCAS', fitid: 'B4' },
    { data: '2026-10-23', valor: -1000, descricao: 'COMPRA HOJE', fitid: 'B5' },
  ];
  const imp823 = sl0.extrato[823].map((x) => Object.assign({}, x));
  const pl = A.planejarImportacao({ itens: itensArq, importados: imp823, ultimoHub: null, hoje: '2026-10-23', idConta: '823' });
  t('corte no último dia do Superlógica', pl.corte === '2026-10-20');
  t('importa só os dias novos e fechados', pl.importar.map((x) => x.fitid).join() === 'B1,B2,B3,B4' && pl.inicio === '2026-10-21' && pl.fim === '2026-10-22');
  t('já importado reconhecido', pl.ja_importados.length === 1 && pl.ja_importados[0].fitid === 'A2');
  t('linha num dia já importado e ausente vai para conferir', pl.faltando_no_superlogica.length === 1 && pl.faltando_no_superlogica[0].fitid === 'B0');
  t('dia de hoje fica para depois', pl.dias_abertos.length === 1);
  t('repetido no arquivo descartado', pl.repetidos.length === 1);
  const pl2 = A.planejarImportacao({ itens: itensArq, importados: imp823, ultimoHub: '2026-10-22', hoje: '2026-10-24', idConta: '823' });
  t('corte também pelo que o Hub já gravou', pl2.corte === '2026-10-22' && pl2.importar.map((x) => x.fitid).join() === 'B5');
  t('FITID estranho vira código estável', /^HUB[0-9A-F]{24}$/.test(A.fitidSeguro({ fitid: 'a b<c>', data: '2026-10-21', valor: 1 }, '823', 0)) && A.fitidSeguro({ fitid: 'x y' , data: 'd', valor: 1 }, '1', 0) === A.fitidSeguro({ fitid: 'x y', data: 'd', valor: 1 }, '1', 0));
  const ofxGerado = A.montarOfx(contas[0], pl.importar, '2026-10-23');
  const relido = C.lerOfx(ofxGerado);
  t('OFX recortado tem só as linhas novas, com a conta e o código do banco', relido.itens.length === 4 && A.semZeros(relido.conta) === '374075' && relido.banco === '756' && relido.itens[0].fitid === 'B1' && relido.itens[3].valor === 250000);
  t('releitura acha o que falta', A.faltandoNaReleitura(pl.importar, relido.itens).length === 0 && A.faltandoNaReleitura(pl.importar, relido.itens.slice(1)).length === 1);

  // ── 3. regras ───────────────────────────────────────────────────────────
  const reg = A.aprenderRegras(sl0.despesas[167]);
  t('regra de tarifa aprendida (2 vezes em 2 meses)', reg.tarifa && reg.tarifa.id_fornecedor === '68185' && reg.tarifa.conta_contabil === '2.2.1');
  t('CESAN sem histórico pago não vira regra', !reg.cesan);
  t('uma vez só não vira regra', !A.aprenderRegras(sl0.despesas[167].slice(0, 1)).tarifa);
  const linha = (data, valor, descricao, fitid) => ({ data, valor, descricao, fitid: fitid || '', desconsiderado: false });
  const ent = {
    id_condominio: '167', hoje: '2026-10-23', inicio: '2026-09-01', despesas: sl0.despesas[167], regras: reg, regrasHub: [],
    contas: [
      { id: '823', descricao: 'Conta Principal', tipo: '1', sistema: sl0.sistema[823], banco: [linha('2026-10-15', 100000, 'CRED PIX JOAO', 'A1'), linha('2026-10-20', -5000, 'PAG BOLETO', 'A2'),
        linha('2026-10-21', -1250, 'TARIFA PACOTE SERVICOS', 'B1'), linha('2026-10-21', -30000, 'TRANSF MSM TIT POUP', 'B2'), linha('2026-10-22', -14097, 'DEB CONV CESAN 778899', 'B3'),
        linha('2026-10-22', 250000, 'RECEBIDO DE CONDOMINOS: 5 COBRANCAS', 'B4'), linha('2026-10-22', -9999, 'PAGAMENTO FORNECEDOR XYZ', 'B6'), linha('2026-10-22', -4400, 'PIX ENVIADO', 'B7')] },
      { id: '824', descricao: 'Poupança', tipo: '8', sistema: [], banco: [linha('2026-09-05', 120, 'JUROS POUPANCA', 'P1'), linha('2026-09-05', -20, 'IRRF POUPANCA', 'P2'), linha('2026-10-21', 30000, 'CRED TRANSF MSM TIT', 'P3'), linha('2026-10-05', 90, 'JUROS POUPANCA', 'P4')] },
    ],
  };
  const r = A.conciliarCondominio(ent);
  const tipos = (l) => l.map((x) => x.tipo).sort().join(',');
  t('casadas com o que já estava lançado', r.conciliadas === 2);
  t('tarifa lançada pela regra', r.automaticas.some((a) => a.tipo === 'despesa' && a.regra === 'tarifa' && a.valor === 1250 && a.conta_contabil === '2.2.1' && a.id_fornecedor === '68185' && a.id_conta === '823'));
  t('transferência entre contas do condomínio', r.automaticas.some((a) => a.tipo === 'transferencia' && a.id_conta === '823' && a.id_conta_destino === '824' && a.valor === 30000 && a.data === '2026-10-21'));
  const f = (tipo) => r.fila.filter((x) => x.tipo === tipo);
  t('CESAN casa com a despesa aberta pelo documento: dar baixa', f('baixar_despesa').length === 1 && /documento/.test(f('baixar_despesa')[0].motivo) && f('baixar_despesa')[0].sugestao.id_despesa === '3');
  t('crédito do PJBank sem baixa vai para conferir', f('credito_sem_baixa').length === 1);
  t('rendimento do mês fechado sem lançamento (movimentação desligada) vai para conferir com a soma', f('rendimento_mes').length === 1 && f('rendimento_mes')[0].valor === 120);
  t('IR do mês fechado sem regra vai para conferir', f('ir_mes').length === 1 && f('ir_mes')[0].valor === -20);
  t('rendimento do mês aberto aguarda o fim do mês', r.aguardando === 1);
  t('saída sem lançamento: corrigir com conta e fornecedor', f('sem_lancamento').length === 2 && f('sem_lancamento')[0].sugestao.corrigir === 'despesa' && !f('sem_lancamento')[0].pode_aceitar);
  t('chaves únicas e estáveis', new Set(r.fila.map((x) => x.chave)).size === r.fila.length && A.conciliarCondominio(ent).fila.map((x) => x.chave).join() === r.fila.map((x) => x.chave).join());
  const r2 = A.conciliarCondominio(Object.assign({}, ent, { opcoes: { movimentacaoDireta: true, contaRendimento: '1.3.1' }, regras: Object.assign({}, reg, { ir: { id_fornecedor: '68185', conta_contabil: '2.2.9', forma_pag: '7' } }) }));
  t('com movimentação ligada o rendimento vira lançamento, e o IR com regra vira despesa', r2.automaticas.some((a) => a.tipo === 'movimentacao' && a.valor === 120 && a.data === '2026-09-30') && r2.automaticas.some((a) => a.tipo === 'despesa' && a.regra === 'ir' && a.valor === 20));
  const r3 = A.conciliarCondominio(Object.assign({}, ent, { regrasHub: [{ padrao: C.normDesc('PAGAMENTO FORNECEDOR XYZ'), sinal: -1, acao: 'despesa', conta_contabil: '2.5.1', id_fornecedor: '777' }, { padrao: C.normDesc('PIX ENVIADO'), sinal: -1, acao: 'ignorar' }] }));
  t('regra ensinada vira lançamento e regra de ignorar some da fila', r3.automaticas.some((a) => a.regra === 'aprendida' && a.id_fornecedor === '777') && !r3.fila.some((x) => x.tipo === 'sem_lancamento'));
  // CESAN com regra e sem despesa: lança; com despesa parecida já paga: não duplica
  const desCesan = [1, 2].map((i) => ({ id_despesa_des: 'c' + i, id_contato_con: '555', st_nome_con: 'CESAN', vl_valor_pdes: '130.00', dt_vencimento_pdes: '0' + (7 + i) + '/22/2026', dt_liquidacao_pdes: '0' + (7 + i) + '/22/2026', id_contabanco_cb: '823', apropriacao: [{ st_conta_cont: '2.3.1', st_descricao_cont: 'Água' }] }));
  const regC = A.aprenderRegras(desCesan);
  const soCesan = { id_condominio: '167', hoje: '2026-10-23', inicio: '2026-09-01', regras: regC, contas: [{ id: '823', descricao: 'CC', tipo: '1', sistema: [], banco: [linha('2026-10-22', -14097, 'DEB CONV CESAN', 'X1')] }] };
  t('CESAN com regra aprendida e sem despesa: lança sozinho', A.conciliarCondominio(Object.assign({}, soCesan, { despesas: desCesan })).automaticas.some((a) => a.regra === 'cesan' && a.conta_contabil === '2.3.1'));
  const paga = desCesan.concat([{ id_despesa_des: 'c9', id_contato_con: '555', st_nome_con: 'CESAN', vl_valor_pdes: '140.97', dt_vencimento_pdes: '09/30/2026', dt_liquidacao_pdes: '09/30/2026', id_contabanco_cb: '823', apropriacao: [{ st_conta_cont: '2.3.1' }] }]);
  const rDup = A.conciliarCondominio(Object.assign({}, soCesan, { despesas: paga }));
  t('CESAN com despesa igual em 35 dias: não lança (possível duplicidade)', !rDup.automaticas.length && rDup.fila.some((x) => x.tipo === 'possivel_duplicidade'));

  // ── 4. política ─────────────────────────────────────────────────────────
  t('política: 167 livre no teste', W.situacao('conciliacao_gravar', '167', null, {}).estado === 'livre');
  t('política: outro bloqueado no teste', W.situacao('conciliacao_gravar', '136', null, {}).estado === 'bloqueado');
  t('política: confirmação fora do teste e reforçada acima de 20 itens', W.situacao('conciliacao_gravar', '136', { quantidade: 3 }, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'confirmacao'
    && W.situacao('conciliacao_gravar', '136', { quantidade: 21 }, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'reforcada');
  t('política: cadastro da administração nunca', W.situacao('conciliacao_gravar', '144', null, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'bloqueado');

  // ── 5. serviço com o Superlógica dublado ────────────────────────────────
  const sl = criarSL();
  const arm = ARM.criarArmazemMemoria();
  let HOJE = '2026-10-23';
  const grav = G.criarGravador({ cred: { base: 'https://x', appToken: 'a', accessToken: 'b' }, cliente: sl.cliente, pedir: sl.pedir });
  const S = D.criarConciliacaoDia({ cliente: () => sl.cliente, armazem: arm, gravador: grav, hoje: () => HOJE, env: {}, grupos: async () => [{ id: 1, nome: 'Carteira Michele', gerente: 'Michele', condominios: [167, 136] }] });
  const arqs = [
    { nome: 'cc.ofx', texto: ofxTexto({ banco: '756', agencia: '3007', conta: '37407-5', itens: itensArq }) },
    { nome: 'poup.ofx', texto: ofxTexto({ banco: '756', agencia: '3007', conta: '99001-2', itens: [{ data: '2026-10-21', valor: 30000, descricao: 'CRED TRANSF MSM TIT', fitid: 'P3' }] }) },
    { nome: 'banestes.ofx', texto: ofxTexto({ banco: '021', agencia: '0123', conta: '123456789', itens: [{ data: '2026-10-21', valor: -9999, descricao: 'PAGAMENTO FORNECEDOR XYZ', fitid: 'Z1' }] }) },
    { nome: 'empresa.ofx', texto: ofxTexto({ banco: '756', agencia: '3007', conta: '55555-5', itens: [{ data: '2026-10-21', valor: -100, descricao: 'X', fitid: 'E1' }] }) },
    { nome: 'ruim.txt', texto: 'isto não é ofx' },
  ];
  const rec = await S.receberOfx(arqs, null, { id: null, email: 'teste@hub' });
  t('várias contas de uma vez: cada arquivo na sua conta', rec[0].situacao === 'planejada' && rec[0].conta.id === '823' && rec[0].a_importar === 4 && rec[1].conta.id === '824' && rec[2].conta.id === '635' && rec[2].conta.id_condominio === '136');
  t('conta de cadastro da administração não é reconhecida', rec[3].situacao === 'nao_encontrada');
  t('arquivo inválido avisado', rec[4].situacao === 'arquivo_invalido');
  t('tela não recebe número da conta inteiro', !JSON.stringify(rec).includes('37407') && rec[0].conta.final === '4075');
  t('linha ausente em dia já importado entrou na fila', (await arm.fila.listar({ id_condominio: '167' })).some((x) => x.tipo === 'faltando_no_superlogica'));
  const escopo136 = await S.receberOfx([arqs[0]], new Set(['136']), {});
  t('fora da carteira a conta não é reconhecida', escopo136[0].situacao === 'nao_encontrada');
  const rec2 = await S.receberOfx([arqs[0]], null, {});
  const plan823 = await arm.importacoes.listar({ id_conta: '823' });
  t('mesmo arquivo de novo substitui o plano (nunca dois planos da mesma conta)', rec2[0].situacao === 'planejada' && plan823.filter((x) => x.status === 'planejada').length === 1 && plan823.filter((x) => x.status === 'cancelada').length === 1);

  const conc = await S.conciliar('167', { email: 'teste@hub' });
  t('conciliação do condomínio: automáticas e fila', conc.automaticas === 2 && conc.fila === 4);
  t('caixinha não entra na conciliação', !conc.contas.some((c) => c.id === '909'));
  const prep = await S.prepararGravacao('167');
  t('preparo: 2 extratos e 2 lançamentos', prep.importacoes.length === 2 && prep.lancamentos.length === 2 && prep.resumo.quantidade === 4 && prep.resumo.linhas.some((l) => l.rotulo === 'Extratos'));
  let concluido = null;
  const tr = await S.executarGravacao(prep, { concluir: (x) => { concluido = x; } }, { usuario: { id: null, email: 'teste@hub' }, reconciliar: false });
  await tr.promessa;
  const ordem = sl.chamadas.map((c) => c.caminho);
  t('ordem: extratos primeiro, depois os lançamentos', ordem.slice(0, 2).join() === 'conciliacao/put,conciliacao/put' && ordem.slice(2).sort().join() === 'Transferencias/put,despesas/put');
  const up = sl.chamadas.find((c) => c.caminho === 'conciliacao/put' && /"ID_CONTABANCO_CB"\r\n\r\n823/.test(c.corpo)) || sl.chamadas[0];
  t('extrato em multipart com conta e condomínio', /multipart\/form-data/.test(up.tipo) && /name="ID_CONTABANCO_CB"\r\n\r\n823/.test(up.corpo) && /name="ID_CONDOMINIO_COND"\r\n\r\n167/.test(up.corpo) && /name="ARQUIVO"; filename=/.test(up.corpo));
  t('extrato enviado só com as linhas novas', (up.corpo.match(/<STMTTRN>/g) || []).length === 4 && !/<FITID>A2/.test(up.corpo) && !/<FITID>B5/.test(up.corpo));
  const dp = new URLSearchParams(sl.chamadas.find((c) => c.caminho === 'despesas/put').corpo);
  t('despesa já paga com os campos testados no 167', dp.get('FL_DATAPAGAMENTO') === '3' && dp.get('LANCAMENTO_VIA_CONTA_DIGITAL') === '0' && dp.get('FL_NOTIFICAR_DES') === '0' && dp.get('DT_LIQUIDACAO_PDES') === '10/21/2026'
    && dp.get('DT_VENCIMENTOPRIMEIRAPARCELA') === '10/21/2026' && dp.get('APROPRIACAO[0][VL_VALOR_PDES]') === '12.50' && dp.get('ID_FAVORECIDO_CON') === '68185' && dp.get('ID_CONTABANCO_CB') === '823');
  const tp = new URLSearchParams(sl.chamadas.find((c) => c.caminho === 'Transferencias/put').corpo);
  t('transferência com os campos testados', tp.get('ID_CONTABANCO_CB') === '823' && tp.get('ID_TRANSFERIDOPARA_MOV') === '824' && tp.get('VL_VALOR_MOV') === '300.00' && tp.get('DT_DATA_MOV') === '10/21/2026' && tp.get('ID_CONDOMINIO_COND') === '167');
  const imps = await arm.importacoes.listar({ id_condominio: '167', status: ['gravada'] });
  const lancs = await arm.lancamentos.listar({ id_condominio: '167', status: ['gravado'] });
  t('extratos gravados e provados na releitura', imps.length === 2 && imps.every((x) => x.detalhe.resultado.conferido));
  t('lançamentos gravados e provados', lancs.length === 2 && lancs.every((x) => x.resultado.conferido) && lancs.some((x) => x.resultado.id_despesa));
  t('auditoria da política recebe o total', concluido && concluido.ok === true && concluido.totais.gravados === 4);
  const n0 = sl.chamadas.length;
  const tr2 = await S.executarGravacao(prep, { concluir() {} }, { reconciliar: false });
  await tr2.promessa;
  t('mesmo preparo de novo não grava nada', sl.chamadas.length === n0 && tr2.totais.pulados === 4);
  const rec3 = await S.receberOfx([arqs[0]], null, {});
  t('mesmo arquivo depois de gravado: nada novo (nunca reimporta)', rec3[0].situacao === 'nada_novo');
  const conc2 = await S.conciliar('167', {});
  const prep2 = await S.prepararGravacao('167');
  t('depois de gravar, a conciliação casa e não planeja de novo', conc2.conciliadas > conc.conciliadas && prep2.lancamentos.length === 0 && prep2.importacoes.length === 0);

  // incerto: o gateway cortou e o Superlógica não gravou; nunca reenvia
  HOJE = '2026-10-26';
  await S.receberOfx([{ nome: 'cc2.ofx', texto: ofxTexto({ banco: '756', agencia: '3007', conta: '374075', itens: [{ data: '2026-10-23', valor: -1000, descricao: 'COMPRA', fitid: 'B5' }] }) }], null, {});
  const prep3 = await S.prepararGravacao('167');
  sl.modo = 'cair';
  const tr3 = await S.executarGravacao(prep3, { concluir() {} }, { reconciliar: false });
  await tr3.promessa;
  const inc = await arm.importacoes.listar({ id_conta: '823', status: ['incerta'] });
  t('sem resposta e sem a linha na releitura: incerta', inc.length === 1 && tr3.totais.incertos === 1);
  const rec4 = await S.receberOfx([{ nome: 'cc2.ofx', texto: ofxTexto({ banco: '756', agencia: '3007', conta: '374075', itens: [{ data: '2026-10-23', valor: -1000, descricao: 'COMPRA', fitid: 'B5' }] }) }], null, {});
  t('período incerto não é importado de novo', rec4[0].situacao === 'nada_novo');
  sl.extrato[823].push({ data: '2026-10-23', valor: -1000, descricao: 'COMPRA', fitid: 'B5' });
  await S.conciliar('167', {});
  t('incerta vira gravada quando a releitura acha as linhas', (await arm.importacoes.listar({ id_conta: '823', status: ['gravada'] })).length === 2);
  // resposta cortada mas o Superlógica gravou: a releitura prova
  await S.receberOfx([{ nome: 'p.ofx', texto: ofxTexto({ banco: '756', agencia: '3007', conta: '990012', itens: [{ data: '2026-10-23', valor: 50, descricao: 'JUROS', fitid: 'P9' }] }) }], null, {});
  sl.modo = 'cair_depois';
  const tr4 = await S.executarGravacao(await S.prepararGravacao('167'), { concluir() {} }, { reconciliar: false });
  await tr4.promessa;
  t('resposta cortada com a linha gravada: provado pela releitura', tr4.totais.gravados === 1);

  // trava de sobreposição no armazém
  const a1 = await arm.importacoes.criar({ id_condominio: 167, id_conta: 823, inicio: '2026-10-01', fim: '2026-10-05', quantidade: 1, itens: [], origem: 'ofx', status: 'planejada' });
  let sobre = null;
  try { await arm.importacoes.trocar(a1.id, ['planejada'], { status: 'gravando' }); } catch (e) { sobre = e.codigo; }
  t('trava: período que encosta em importação gravada é recusado', sobre === null);
  const a2 = await arm.importacoes.criar({ id_condominio: 167, id_conta: 823, inicio: '2026-10-04', fim: '2026-10-08', quantidade: 1, itens: [], origem: 'ofx', status: 'planejada' });
  try { await arm.importacoes.trocar(a2.id, ['planejada'], { status: 'gravando' }); } catch (e) { sobre = e.codigo; }
  t('trava: período sobreposto nunca vai para gravando', sobre === 'sobreposicao');

  // fila
  const pend = await arm.fila.listar({ id_condominio: '167', status: ['pendente'] });
  const semL = pend.find((x) => x.tipo === 'credito_sem_baixa');
  t('aceitar item de conferência', (await S.decidir(semL.chave, { acao: 'aceitar' }, { email: 'a@b' })).status === 'conferido');
  let e1 = null; try { await S.decidir(semL.chave, { acao: 'aceitar' }, {}); } catch (e) { e1 = e.codigo; }
  t('item decidido não decide de novo', e1 === 'ja_decidido');
  // condomínio 136: saída sem lançamento
  await S.conciliar('136', {});
  const p136 = (await arm.fila.listar({ id_condominio: '136', status: ['pendente'] })).find((x) => x.tipo === 'sem_lancamento');
  let e2 = null; try { await S.decidir(p136.chave, { acao: 'aceitar' }, {}); } catch (e) { e2 = e.codigo; }
  t('saída sem regra não aceita sem corrigir', e2 === 'precisa_corrigir');
  let e3 = null; try { await S.decidir(p136.chave, { acao: 'corrigir', tipo: 'despesa', conta_contabil: '2.5.1', id_fornecedor: '778' }, {}, async () => null); } catch (e) { e3 = e.codigo; }
  t('corrigir com fornecedor que não existe é recusado', e3 === 'fornecedor_nao_encontrado');
  let e4 = null; try { await S.decidir(p136.chave, { acao: 'corrigir', tipo: 'despesa', conta_contabil: '1.1', id_fornecedor: '777' }, {}, async () => ({ id: '777', nome: 'X' })); } catch (e) { e4 = e.codigo; }
  t('conta contábil de receita não serve para despesa', e4 === 'conta_contabil_invalida');
  const cr = await S.decidir(p136.chave, { acao: 'corrigir', tipo: 'despesa', conta_contabil: '2.5.1', id_fornecedor: '777', lembrar: true }, { email: 'a@b' }, async () => ({ id: '777', nome: 'FORNECEDOR XYZ' }));
  t('corrigir prepara o lançamento e guarda a regra', cr.status === 'corrigido' && (await arm.lancamentos.pegar(cr.lancamento)).status === 'planejado' && (await arm.regras.listar('136')).length === 1);
  const pIgn = (await arm.fila.listar({ id_condominio: '167', status: ['pendente'] })).find((x) => x.tipo === 'rendimento_mes');
  t('ignorar', (await S.decidir(pIgn.chave, { acao: 'ignorar', motivo: 'lançado à mão' }, {})).status === 'ignorado');
  // avisos
  await S.gerarAvisos(null);
  const av = await arm.avisos.listar(HOJE, null);
  t('aviso de linhas sem conciliar com analista', av.some((a) => a.tipo === 'sem_conciliar' && a.id_condominio === 167 && a.analista === 'Michele' && a.quantidade > 0));
  t('aviso de conta sem extrato importado desde', av.some((a) => a.tipo === 'sem_extrato' && /desde/.test(a.titulo)));

  // ── 6. rotas com a política de verdade ──────────────────────────────────
  const env = { ESCRITA_SUPERLOGICA: 'confirmacao' };
  const eventos = [];
  const politica = W.criarPoliticaEscrita({ env: () => env, auditar: (rq, acao, det) => eventos.push({ acao, det }), condominioDaBase: async (id) => ({ 167: { nome: 'Residencial Teste' }, 136: { nome: 'Condomínio Casablanca' } }[id] || null) });
  sl.contas.push({ id_contabanco_cb: '990', id_condominio_cond: '150', st_descricao_cb: 'Conta', st_nome_banc: 'SICOOB', id_tipocontabanco_tcb: '1', fl_principal_cb: '1', st_conta_cb: '1-1', st_numero_agb: '1' },
    { id_contabanco_cb: '991', id_condominio_cond: '151', st_descricao_cb: 'Conta', st_nome_banc: 'SICOOB', id_tipocontabanco_tcb: '1', fl_principal_cb: '1', st_conta_cb: '2-2', st_numero_agb: '1' });
  const app = express();
  app.use((rq, rs, nx) => { rq.user = { sub: '11111111-1111-1111-1111-111111111111', email: 'a@b' }; rq.authMode = 'supabase'; nx(); });
  const sim = async () => true;
  const R = require('../financeiro/conciliacao-auto-rotas').registrar({
    app, express, requireAuth: (rq, rs, nx) => nx(), requireGestor: (rq, rs, nx) => nx(), exigirFinanceiro: sim, exigirModuloItem: sim, exigirLeituraSuperlogica: sim, exigirCarteira: sim, exigirEscopo: sim,
    escopoFinanceiro: async () => null, gruposCarteiras: async () => [], lerPerfil: async () => ({ role: 'GESTOR' }), podeModulo: () => true, idValido: (v) => /^[1-9]\d{0,8}$/.test(v),
    cliente: () => sl.cliente, politica, auditar: (rq, acao, det) => eventos.push({ acao, det }), armazem: arm, gravador: grav, hoje: () => HOJE, env: {}, semTimer: true,
  });
  const srv = http.createServer(app).listen(0);
  const porta = srv.address().port;
  const chamar = (metodo, caminho, corpo) => new Promise((ok) => {
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const rq = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: dados ? { 'content-type': 'application/json', 'content-length': dados.length } : {} }, (rs) => {
      const p = []; rs.on('data', (c) => p.push(c)); rs.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(p).toString()); } catch (e) { j = null; } ok({ st: rs.statusCode, j }); });
    });
    rq.end(dados);
  });
  const n1 = sl.chamadas.length;
  const g1 = await chamar('POST', '/api/financeiro/conciliacao-dia/condominio/136/gravar', {});
  t('rota: fora do teste pede confirmação com o resumo', g1.st === 428 && g1.j.resumo && /Gravação da conciliação/.test(g1.j.resumo.operacao) && g1.j.resumo.condominio === 'Condomínio Casablanca' && sl.chamadas.length === n1);
  const g2 = await chamar('POST', '/api/financeiro/conciliacao-dia/condominio/136/gravar', { confirmacao_gravacao: { id_condominio: '136', token: g1.j.confirmacao.token } });
  t('rota: com a confirmação grava em segundo plano', g2.st === 202 && g2.j.trabalho);
  await R.servico.trabalho(g2.j.trabalho) && await new Promise((okk) => setTimeout(okk, 50));
  const tb = await chamar('GET', '/api/financeiro/conciliacao-dia/trabalho/' + g2.j.trabalho);
  t('rota: andamento da gravação', tb.st === 200 && tb.j.estado === 'concluido' && tb.j.totais.gravados === 2 && sl.chamadas.slice(n1).map((c) => c.caminho).join() === 'conciliacao/put,despesas/put');
  const g3 = await chamar('POST', '/api/financeiro/conciliacao-dia/condominio/136/gravar', { confirmacao_gravacao: { id_condominio: '136', token: g1.j.confirmacao.token } });
  t('rota: nada mais para gravar (e a confirmação não vale duas vezes)', (g3.st === 200 && g3.j.nada) || g3.st === 409);
  env.ESCRITA_SUPERLOGICA = 'teste';
  await S.receberOfx([{ nome: 'b2.ofx', texto: ofxTexto({ banco: '021', agencia: '0123', conta: '123456789', itens: [{ data: '2026-10-23', valor: -500, descricao: 'TARIFA', fitid: 'Z2' }] }) }], null, {});
  const g4 = await chamar('POST', '/api/financeiro/conciliacao-dia/condominio/136/gravar', {});
  t('rota: no modo teste outro condomínio é bloqueado', g4.st === 423 && g4.j.motivo === 'so_teste');
  const rs = await chamar('GET', '/api/financeiro/conciliacao-dia/resumo');
  const c150 = rs.j.condominios.find((c) => c.id_condominio === '150');
  t('rota: resumo traz condomínio ainda não conciliado, com nome', c150 && c150.conciliado === false && c150.condominio === 'Novo Ainda' && !c150.ultima_conciliacao);
  t('rota: resumo deixa fora inativo e cadastro da administração', !rs.j.condominios.some((c) => c.id_condominio === '151' || c.id_condominio === '144'));
  t('rota: conciliados vêm marcados', rs.j.condominios.find((c) => c.id_condominio === '167').conciliado === true);
  t('rota: resumo por condomínio e por analista', rs.st === 200 && rs.j.condominios.some((c) => c.id_condominio === '136' && c.extratos_prontos === 1) && Array.isArray(rs.j.por_analista));
  t('rota: resumo nunca leva número de conta', !JSON.stringify(rs.j).includes('123456789') && !JSON.stringify(rs.j).includes('37407'));
  const fl = await chamar('POST', '/api/financeiro/conciliacao-dia/condominio/167/fila/' + p136.chave, { acao: 'aceitar' });
  t('rota: item de outro condomínio não é decidido por este', fl.st === 404);
  t('auditoria registrou a gravação pela política', eventos.some((e) => e.acao === 'gravacao_superlogica' && e.det.operacao === 'conciliacao_gravar'));
  srv.close();

  // ── 7. agendador ────────────────────────────────────────────────────────
  let rodou = 0;
  const ag = D.criarAgendador({ executar: async () => { rodou++; return {}; } });
  await ag.verificar(new Date('2026-10-23T10:30:00Z')); // 7h30 em Brasília
  t('agendador: antes de 7h40 não roda', rodou === 0);
  await ag.verificar(new Date('2026-10-23T10:45:00Z'));
  await ag.verificar(new Date('2026-10-23T11:45:00Z'));
  t('agendador: roda uma vez por dia útil', rodou === 1);
  await ag.verificar(new Date('2026-10-24T11:45:00Z')); // sábado
  t('agendador: não roda no fim de semana', rodou === 1);

  // ── 8. rotina do dia grava sozinha só onde a política deixa ─────────────
  const sl2 = criarSL();
  const arm2 = ARM.criarArmazemMemoria();
  const grav2 = G.criarGravador({ cred: {}, cliente: sl2.cliente, pedir: sl2.pedir });
  const pol2 = W.criarPoliticaEscrita({ env: () => ({}), auditar: () => {}, condominioDaBase: async () => null });
  const S2 = D.criarConciliacaoDia({ cliente: () => sl2.cliente, armazem: arm2, gravador: grav2, hoje: () => '2026-10-23', env: {}, politica: pol2, grupos: async () => [] });
  await S2.receberOfx([arqs[0], arqs[2]], null, {});
  const rel = await S2.rodarDia();
  t('rotina: concilia todos e grava sozinha só no 167', rel.conciliados === 2 && rel.gravados > 0 && sl2.chamadas.every((c) => !/635|ID_CONDOMINIO_COND=136|"ID_CONDOMINIO_COND"\r\n\r\n136/.test(c.corpo)));
  t('rotina: 136 fica pronto esperando a pessoa', (await arm2.importacoes.listar({ id_condominio: '136', status: ['planejada'] })).length === 1);

  // ── 9. extrato vazio e retenção ─────────────────────────────────────────
  const slV = criarSL();
  const gV = G.criarGravador({ cred: {}, cliente: slV.cliente, pedir: slV.pedir });
  const rV = await gV.importarExtrato({ id_condominio: '167', id_conta: '823', itens: [] }, A.contaInterna(slV.contas[0]));
  t('extrato sem linhas: recusado sem enviar nada', rV.status === 'recusado' && slV.chamadas.length === 0);
  const armR = ARM.criarArmazemMemoria();
  const velho = '2025-09-01T00:00:00.000Z', novo = '2026-10-01T00:00:00.000Z';
  armR._t.imp.push({ id: 1, id_conta: 1, status: 'gravada', atualizado_em: velho }, { id: 2, id_conta: 1, status: 'incerta', atualizado_em: velho }, { id: 3, id_conta: 1, status: 'gravada', atualizado_em: novo });
  [['fa1', 'conferido', velho], ['fa2', 'pendente', velho], ['fa3', 'ignorado', novo], ['fa4', 'resolvido', velho]].forEach(([k, st, em]) => armR._t.fila.set(k, { chave: k, status: st, atualizado_em: em }));
  [['la1', 'gravado', velho], ['la2', 'incerto', velho], ['la3', 'cancelado', velho]].forEach(([k, st, em]) => armR._t.lanc.set(k, { chave: k, status: st, atualizado_em: em }));
  armR._t.avisos.push({ dia: '2025-09-01' }, { dia: '2026-10-20' });
  const SR = D.criarConciliacaoDia({ cliente: () => slV.cliente, armazem: armR, gravador: gV, env: {} });
  const ret = await SR.limparAntigos(Date.parse('2026-10-23T12:00:00Z'));
  t('retenção: apaga só o final com mais de 12 meses', ret.meses === 12 && ret.apagados.importacoes === 1 && ret.apagados.fila === 2 && ret.apagados.lancamentos === 2 && ret.apagados.avisos === 1
    && armR._t.imp.map((x) => x.id).join() === '2,3' && [...armR._t.fila.keys()].sort().join() === 'fa2,fa3' && [...armR._t.lanc.keys()].join() === 'la2');
  const SR0 = D.criarConciliacaoDia({ cliente: () => slV.cliente, armazem: armR, gravador: gV, env: { CONC_RETENCAO: '0' } });
  t('retenção desligada pela variável', (await SR0.limparAntigos()).desligada === true);
  t('rotina do dia roda a retenção', rel.retencao && rel.retencao.meses === 12);

  console.log(ok + ' ok, ' + falhou + ' falharam');
  process.exit(falhou ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
