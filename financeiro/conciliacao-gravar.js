'use strict';
// Gravação da conciliação no Superlógica pela chave da API do Hub (rotas testadas no 167 em 23/10/2026,
// rotas_tela_167.md, seção "Teste com a chave da API"). Só é chamado depois da política única de
// gravação (servico/escrita-superlogica.js) autorizar o condomínio.
// Regras de toda gravação aqui:
//   . datas em MM/DD/AAAA e valor com ponto; o que vale é o campo status do corpo (erro vem com HTTP 200);
//   . uma tentativa só: sem resposta (o gateway corta em 60 s e o Superlógica segue gravando) o
//     resultado é "incerto" e nunca é repetido sem reler;
//   . depois de gravar, relê e confere (prova);
//   . despesa sempre com FL_DATAPAGAMENTO=3 e LANCAMENTO_VIA_CONTA_DIGITAL=0 (nada é agendado ou pago).
const https = require('https');
const crypto = require('crypto');
const A = require('./conciliacao-auto');
const finConciliacao = require('./conciliacao');

const ID = /^[1-9]\d{0,9}$/;
const sl = (iso) => iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4);
const limpar = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

// Um pedido ao Superlógica, sem repetição. Nunca registra cabeçalhos nem corpo.
function pedirPadrao({ base, appToken, accessToken }, metodo, caminho, query, corpo, tipoCorpo) {
  return new Promise((resolve) => {
    const url = new URL(base + '/v2/condor/' + caminho);
    Object.entries(query || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
    const dados = corpo || Buffer.alloc(0);
    const r = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: metodo,
      headers: { app_token: appToken, access_token: accessToken, accept: 'application/json', 'content-type': tipoCorpo || 'application/x-www-form-urlencoded', 'content-length': dados.length },
    }, (resp) => {
      const partes = [];
      resp.on('data', (c) => partes.push(c));
      resp.on('error', () => resolve({ status: 0, json: null }));
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(partes).toString('utf8').replace(/^﻿/, '')); } catch (e) { json = null; }
        resolve({ status: resp.statusCode, json });
      });
    });
    r.setTimeout(65000, () => { r.destroy(); resolve({ status: 504, json: null }); });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.end(dados);
  });
}
// Lê a resposta: { ok, recusa (o Superlógica disse que não gravou), incerto, item, msg }.
function lerResposta(r) {
  const raiz = Array.isArray(r.json) ? r.json[0] : r.json;
  const item = raiz && Array.isArray(raiz.data) && raiz.data[0] && raiz.data[0].status !== undefined ? raiz.data[0] : raiz;
  const statusCorpo = item && item.status != null ? String(item.status) : null;
  const ok = r.status >= 200 && r.status < 300 && statusCorpo === '200';
  const recusa = !ok && ((r.status >= 400 && r.status < 500) || (r.status >= 200 && r.status < 300 && statusCorpo !== null && statusCorpo !== '200'));
  return { ok, recusa, incerto: !ok && !recusa, item, msg: item && item.msg ? limpar(item.msg) : (r.status ? 'HTTP ' + r.status : 'sem resposta') };
}
const dadosDe = (item) => (item && item.data && typeof item.data === 'object' && !Array.isArray(item.data) ? item.data : (item && Array.isArray(item.data) && item.data[0]) || {});

// deps: { cred, cliente (GET), pedir? (testes) }
function criarGravador(deps) {
  const pedir = deps.pedir || pedirPadrao;
  const cred = () => (typeof deps.cred === 'function' ? deps.cred() : deps.cred);
  const cli = () => (typeof deps.cliente === 'function' ? deps.cliente() : deps.cliente);
  const exigir = (cond, contas) => {
    if (!ID.test(String(cond)) || A.NAO_CONDOMINIOS.has(String(cond))) { const e = new Error('condominio_invalido'); e.codigo = 'condominio_invalido'; throw e; }
    for (const c of contas) if (!ID.test(String(c))) { const e = new Error('conta_invalida'); e.codigo = 'conta_invalida'; throw e; }
  };

  // Extrato do Superlógica relido agora (sem cache), linhas do banco e lançamentos do período.
  async function lerExtrato(idCond, idConta, ini, fim) {
    const meses = finConciliacao.mesesDoPeriodo(ini, fim);
    const partes = [];
    for (const m of meses) {
      const c = finConciliacao.competencia(m);
      const j = await cli().get('conciliacao/index', { idCondominio: idCond, idConta, dtInicio: sl(c.inicio), dtFim: sl(c.fim) });
      partes.push(finConciliacao.normalizarConciliacao(j, idConta, c.inicio, c.fim));
    }
    return finConciliacao.juntarMeses(partes, ini, fim);
  }

  // Importa o extrato (conciliacao/put multipart) e prova relendo que cada linha entrou.
  // imp: { id_condominio, id_conta, itens: [{ data, valor, fitid, descricao, numero }] }, conta: contaInterna.
  async function importarExtrato(imp, conta) {
    exigir(imp.id_condominio, [imp.id_conta]);
    if (String(conta.id) !== String(imp.id_conta) || String(conta.id_condominio) !== String(imp.id_condominio)) { const e = new Error('conta_de_outro_condominio'); e.codigo = 'conta_de_outro_condominio'; throw e; }
    const ofx = A.montarOfx(conta, imp.itens);
    const fronteira = '----hub' + crypto.randomBytes(12).toString('hex');
    const campo = (n, v) => Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="' + n + '"\r\n\r\n' + v + '\r\n', 'utf8');
    const corpo = Buffer.concat([
      campo('MAX_FILE_SIZE', '15728640'), campo('ID_CONTABANCO_CB', String(imp.id_conta)), campo('ID_CONDOMINIO_COND', String(imp.id_condominio)), campo('salvar', '1'),
      Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="ARQUIVO"; filename="extrato_hub_' + imp.id_conta + '.ofx"\r\nContent-Type: application/x-ofx\r\n\r\n', 'utf8'),
      Buffer.from(ofx, 'latin1'), Buffer.from('\r\n--' + fronteira + '--\r\n', 'utf8'),
    ]);
    const r = lerResposta(await pedir(cred(), 'POST', 'conciliacao/put', null, corpo, 'multipart/form-data; boundary=' + fronteira));
    const ini = imp.itens.reduce((m, x) => (x.data < m ? x.data : m), imp.itens[0].data);
    const fim = imp.itens.reduce((m, x) => (x.data > m ? x.data : m), imp.itens[0].data);
    // Releitura vale mesmo quando a resposta foi recusa ou incerta: o que manda é o que está lá.
    let faltam = null;
    try { faltam = A.faltandoNaReleitura(imp.itens, (await lerExtrato(imp.id_condominio, imp.id_conta, ini, fim)).banco); } catch (e) { faltam = null; }
    if (faltam && faltam.length === 0) return { status: 'gravado', conferido: true, msg: r.msg, linhas: imp.itens.length };
    if (r.ok) return { status: faltam ? 'incerto' : 'gravado', conferido: false, msg: faltam ? 'O Superlógica aceitou, mas ' + faltam.length + ' linha(s) não apareceram na releitura.' : 'Gravado; a releitura falhou.', faltando: faltam ? faltam.length : null };
    if (r.recusa && faltam && faltam.length === imp.itens.length) return { status: 'recusado', conferido: true, msg: 'O Superlógica recusou o extrato: ' + r.msg };
    return { status: 'incerto', conferido: false, msg: 'O Superlógica não confirmou (' + r.msg + '). Nada será reenviado; confira na conciliação do Superlógica.', faltando: faltam ? faltam.length : null };
  }

  // Despesas do dia na conta: para provar a despesa criada.
  async function despesasDoDia(idCond, iso) {
    const out = [];
    for (let pg = 1; pg <= 10; pg++) {
      const j = await cli().get('despesas/index', { idCondominio: idCond, comStatus: 'todas', dtInicio: sl(iso), dtFim: sl(iso), itensPorPagina: 50, pagina: pg });
      if (!Array.isArray(j) || !j.length) break;
      out.push(...j);
      if (j.length < 50) break;
    }
    return out;
  }

  // Despesa já paga, como a tela da conciliação faz (despesas/put com liquidação na data do extrato).
  // l: { id_condominio, id_conta, data, valor (centavos, positivo), conta_contabil, id_fornecedor, forma_pag, complemento }
  async function lancarDespesa(l) {
    exigir(l.id_condominio, [l.id_conta, l.id_fornecedor]);
    if (!/^2(\.\d+)+$/.test(String(l.conta_contabil || ''))) { const e = new Error('conta_contabil_invalida'); e.codigo = 'conta_contabil_invalida'; throw e; }
    const valor = A.reais(l.valor);
    const p = new URLSearchParams();
    p.set('ID_CONDOMINIO_COND', String(l.id_condominio));
    p.set('ID_CONTABANCO_CB', String(l.id_conta));
    p.set('ID_CONTATO_CON', String(l.id_fornecedor));
    p.set('ID_FAVORECIDO_CON', String(l.id_fornecedor));
    p.set('DT_VENCIMENTOPRIMEIRAPARCELA', sl(l.data));
    p.set('ID_FORMA_PAG', /^\d{1,3}$/.test(String(l.forma_pag || '')) ? String(l.forma_pag) : '7');
    p.set('APROPRIACAO[0][ST_CONTA_CONT]', String(l.conta_contabil));
    p.set('APROPRIACAO[0][VL_VALOR_PDES]', valor);
    if (l.complemento) p.set('APROPRIACAO[0][ST_COMPLEMENTO_APRO]', String(l.complemento).slice(0, 120));
    p.set('FL_DATAPAGAMENTO', '3');
    p.set('FL_MARCAR_PARA_REMESSA', '0');
    p.set('FL_LIQUIDAR', '0');
    p.set('DT_LIQUIDACAO_PDES', sl(l.data));
    p.set('FL_NOTIFICAR_DES', '0');
    p.set('LANCAMENTO_VIA_CONTA_DIGITAL', '0');
    const r = lerResposta(await pedir(cred(), 'POST', 'despesas/put', null, Buffer.from(p.toString(), 'utf8')));
    const d = dadosDe(r.item);
    const idDespesa = ID.test(String(d.id_despesa_des || '')) ? String(d.id_despesa_des) : null;
    if (r.recusa) return { status: 'recusado', conferido: true, msg: 'O Superlógica recusou a despesa: ' + r.msg };
    let parc = null;
    try {
      const l2 = await despesasDoDia(l.id_condominio, l.data);
      parc = idDespesa ? l2.find((x) => String(x.id_despesa_des) === idDespesa) : null;
    } catch (e) { parc = null; }
    const prova = parc ? {
      valor: Math.abs(Math.abs(A.C.centavos(parc.vl_valor_pdes)) - l.valor) === 0,
      conta: String(parc.id_contabanco_cb || '') === String(l.id_conta) || !parc.id_contabanco_cb,
      paga: !!A.C.dataISO(parc.dt_liquidacao_pdes),
      condominio: String(parc.id_condominio_cond || l.id_condominio) === String(l.id_condominio),
    } : null;
    const conferido = !!prova && prova.valor && prova.conta && prova.paga && prova.condominio;
    if (r.ok || idDespesa) return { status: 'gravado', conferido, prova, id_despesa: idDespesa, id_parcela: parc ? String(parc.id_parcela_pdes || '') : null, msg: r.msg };
    return { status: 'incerto', conferido: false, msg: 'O Superlógica não confirmou a despesa (' + r.msg + '). Nada será reenviado; confira no Superlógica.' };
  }

  // Transferência entre duas contas do mesmo condomínio (Transferencias/put). A releitura pela chave
  // não mostra transferência (teste de 23/10): a prova é o código devolvido e, quando o extrato da
  // conta de origem já está importado, o lançamento de saída no dia.
  async function transferir(t, contasDoCondominio) {
    exigir(t.id_condominio, [t.id_conta, t.id_conta_destino]);
    const ids = new Set((contasDoCondominio || []).map((c) => String(c.id)));
    if (!ids.has(String(t.id_conta)) || !ids.has(String(t.id_conta_destino)) || String(t.id_conta) === String(t.id_conta_destino)) { const e = new Error('conta_de_outro_condominio'); e.codigo = 'conta_de_outro_condominio'; throw e; }
    const p = new URLSearchParams();
    p.set('ID_CONDOMINIO_COND', String(t.id_condominio));
    p.set('DT_DATA_MOV', sl(t.data));
    p.set('VL_VALOR_MOV', A.reais(t.valor));
    p.set('ID_CONTABANCO_CB', String(t.id_conta));
    p.set('ID_TRANSFERIDOPARA_MOV', String(t.id_conta_destino));
    p.set('MARCAR_PARA_IMPRESSAO', '0');
    p.set('FL_ACAO_IMPRESSAO', '1');
    p.set('ST_COMPLEMENTO_MOV', String(t.complemento || 'Transferência entre contas').slice(0, 120));
    p.set('salvar', 'Transferir');
    const r = lerResposta(await pedir(cred(), 'POST', 'Transferencias/put', null, Buffer.from(p.toString(), 'utf8')));
    const d = dadosDe(r.item);
    const idMov = ID.test(String(d.id_contabanco_mov || '')) ? String(d.id_contabanco_mov) : null;
    if (r.recusa) return { status: 'recusado', conferido: true, msg: 'O Superlógica recusou a transferência: ' + r.msg };
    if (!r.ok && !idMov) return { status: 'incerto', conferido: false, msg: 'O Superlógica não confirmou a transferência (' + r.msg + '). Nada será reenviado; confira no Superlógica.' };
    let conferido = false;
    try {
      const e = await lerExtrato(t.id_condominio, t.id_conta, t.data, t.data);
      conferido = e.sistema.some((s) => s.data === t.data && s.valor === -t.valor);
    } catch (e) { conferido = false; }
    return { status: 'gravado', conferido, id_transferencia: idMov, msg: r.msg };
  }

  // Movimentação direta (rendimento ou IR do mês). A leitura da rota quebrou no teste de 23/10;
  // a gravação fica desligada até ser testada no 167 (CONC_MOVIMENTACAO_DIRETA=1 liga).
  async function movimentacao(m) {
    exigir(m.id_condominio, [m.id_conta]);
    if (!/^\d+(\.\d+)+$/.test(String(m.conta_contabil || ''))) { const e = new Error('conta_contabil_invalida'); e.codigo = 'conta_contabil_invalida'; throw e; }
    const p = new URLSearchParams();
    p.set('ID_CONDOMINIO_COND', String(m.id_condominio));
    p.set('ID_CONTABANCO_CB', String(m.id_conta));
    p.set('DT_ENTRADA_MD', sl(m.data));
    p.set('ST_CONTA_CONT', String(m.conta_contabil));
    p.set('VL_VALOR_MD', (m.sinal < 0 ? '-' : '') + A.reais(m.valor));
    p.set('ST_COMPLEMENTO_MD', String(m.complemento || '').slice(0, 120));
    const r = lerResposta(await pedir(cred(), 'POST', 'MovimentacoesDiretas/', null, Buffer.from(p.toString(), 'utf8')));
    if (r.recusa) return { status: 'recusado', conferido: true, msg: 'O Superlógica recusou a movimentação: ' + r.msg };
    if (!r.ok) return { status: 'incerto', conferido: false, msg: 'O Superlógica não confirmou a movimentação (' + r.msg + ').' };
    let conferido = false;
    try {
      const e = await lerExtrato(m.id_condominio, m.id_conta, m.data, m.data);
      conferido = e.sistema.some((s) => s.data === m.data && Math.abs(s.valor) === m.valor);
    } catch (e) { conferido = false; }
    return { status: 'gravado', conferido, msg: r.msg };
  }

  return { importarExtrato, lancarDespesa, transferir, movimentacao, lerExtrato };
}

module.exports = { criarGravador, lerResposta, pedirPadrao };
