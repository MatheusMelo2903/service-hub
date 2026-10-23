'use strict';
// Juros e atrasos: leitura dos dados de um condomínio num mês. Superlógica SÓ por GET
// (despesas/index, auditoria/index, conciliacao/index e caixa/index), no máximo 2 chamadas ao
// mesmo tempo, e o que vem do Supabase (entrada de documentos, registros, decisões, retornos do banco).
// Nada aqui grava no Superlógica: o cliente recebido só é usado com get().
const J = require('./juros');
const U = require('./regras/util');
const painel = require('./painel');
const conc = require('./conciliacao');

const ACOES_LIDAS = new Set(['despesas/index', 'auditoria/index', 'conciliacao/index', 'caixa/index']);
const MAX_CONTAS = 6;
const MAX_SALDOS = 30;
const MAX_DIAS_AUDITORIA = 70;
const txt = (v, n) => String(v == null ? '' : v).slice(0, n || 200);
const sl = (iso) => iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4);

// Só os campos que o dossiê usa (nada de chave Pix, conta, agência ou CPF de pessoa física).
function enxugar(d) {
  return {
    id_despesa_des: txt(d.id_despesa_des, 20), id_parcela_pdes: txt(d.id_parcela_pdes, 20), id_condominio_cond: txt(d.id_condominio_cond, 12),
    st_fantasia_cond: txt(d.st_fantasia_cond), st_nome_con: txt(d.st_nome_con), st_fantasia_con: txt(d.st_fantasia_con),
    st_cpf_con: String(d.st_cpf_con || '').replace(/\D/g, '').length === 14 ? txt(d.st_cpf_con, 30) : '',
    st_documento_des: txt(d.st_documento_des, 60), dt_geracao_des: txt(d.dt_geracao_des, 30), dt_vencimento_pdes: txt(d.dt_vencimento_pdes, 30),
    dt_liquidacao_pdes: txt(d.dt_liquidacao_pdes, 30), fl_liquidado_pdes: txt(d.fl_liquidado_pdes, 3), vl_valor_pdes: txt(d.vl_valor_pdes, 30),
    vl_valorbruto_pdes: txt(d.vl_valorbruto_pdes, 30), vl_juros_pdes: txt(d.vl_juros_pdes, 30), vl_multa_pdes: txt(d.vl_multa_pdes, 30), vl_desconto_pdes: txt(d.vl_desconto_pdes, 30),
    st_codigobarras_pdes: txt(d.st_codigobarras_pdes, 80), id_forma_pag: txt(d.id_forma_pag, 4), id_contabanco_cb: txt(d.id_contabanco_cb, 12),
    fl_remessastatus_pdes: txt(d.fl_remessastatus_pdes, 10),
    arquivos: (Array.isArray(d.arquivos) ? d.arquivos : []).filter(Boolean).map((a) => ({
      st_nomeabreviadoetiqueta_eti: txt(a.st_nomeabreviadoetiqueta_eti, 40), fl_excluido_arq: txt(a.fl_excluido_arq, 3), dt_envio_arq: txt(a.dt_envio_arq, 30),
    })),
  };
}

// Cliente só de leitura: qualquer ação fora da lista recusa (proteção a mais além do GET).
function soLeitura(cliente, chamadas) {
  return {
    get(acao, params) {
      if (!ACOES_LIDAS.has(acao)) return Promise.reject(new Error('acao_nao_permitida'));
      if (chamadas) chamadas.push(acao);
      return cliente.get(acao, params);
    },
  };
}

// Lê o mês de um condomínio. retornos: pagamentos do banco já guardados (ajudam a achar os casos).
// Devolve o "bruto" que J.montarCasos usa, mais as falhas de leitura.
async function carregar({ cliente, fila, id, competencia, hoje, retornos, entradas }) {
  const c = J.competencia(competencia);
  if (!c) { const e = new Error('competencia_invalida'); e.status = 400; throw e; }
  if (c.inicio > hoje) { const e = new Error('competencia_futura'); e.status = 400; throw e; }
  const chamadas = [];
  const cl = soLeitura(cliente, chamadas);
  const falhas = [];
  const fim = c.fim < hoje ? c.fim : hoje;
  const doCond = (d) => String(d.id_condominio_cond || '') === String(id);
  const [pagas, pend] = await Promise.all([
    painel.janela(cl, fila, 'despesas/index', { idCondominio: id, status: 'liquidadas', comStatus: 'liquidadas', filtrarpor: 'liquidacao' }, c.inicio, fim, falhas),
    painel.janela(cl, fila, 'despesas/index', { idCondominio: id, comStatus: 'pendentes' }, c.inicio, fim, falhas),
  ]);
  const parcelas = pagas.concat(pend).filter(doCond).map(enxugar);

  // Extrato importado das contas das parcelas do mês (um pedido por conta e mês do calendário).
  const contas = [...new Set(parcelas.map((p) => p.id_contabanco_cb).filter((x) => /^\d+$/.test(x)))].slice(0, MAX_CONTAS);
  const iniExt = U.maisDias(c.inicio, -40);
  const meses = conc.mesesDoPeriodo(iniExt, fim);
  const extrato = [];
  let contasSemExtrato = 0;
  await Promise.all(contas.map(async (conta) => {
    try {
      const partes = await Promise.all(meses.map(async (mes) => {
        const cc = conc.competencia(mes);
        const ate = cc.fim > hoje ? hoje : cc.fim;
        const j = await fila(() => cl.get('conciliacao/index', { idCondominio: id, idConta: conta, dtInicio: sl(cc.inicio), dtFim: sl(ate) }));
        return conc.normalizarConciliacao(j, conta, cc.inicio, ate);
      }));
      const junto = conc.juntarMeses(partes, iniExt, fim);
      if (junto.descartada || !junto.banco.length) { contasSemExtrato++; return; }
      junto.banco.filter((b) => !b.desconsiderado).forEach((b) => extrato.push({ id_conta: conta, data: b.data, centavos: b.valor, descricao: b.descricao }));
    } catch (e) { contasSemExtrato++; falhas.push('extrato da conta ' + conta + ' (' + ((e && e.motivo) || 'sem resposta') + ')'); }
  }));

  // Casos do mês sem auditoria e sem saldo: definem o que ainda precisa ser lido.
  const previa = J.montarCasos({ parcelas, extrato, retornos, entradas }, { competencia: c.rotulo, hoje });
  const casos = previa.casos;
  const norm = new Map(parcelas.map((p) => [String(p.id_parcela_pdes), J.normalizarParcela(p)]));

  // Auditoria: do lançamento mais antigo dos casos até o fim do mês (ou só os dias que importam).
  let auditoria = [];
  if (casos.length) {
    const datas = [];
    casos.forEach((k) => { const p = norm.get(String(k.id_parcela)); [p && p.lancamento, k.datas.vencimento, k.datas.pagamento, p && p.liquidacao].forEach((d) => { if (d && d <= hoje) datas.push(d); }); });
    datas.sort();
    const ini = datas[0];
    const ate = datas[datas.length - 1] > fim ? datas[datas.length - 1] : fim;
    let janelas;
    if (ini && U.dias(ini, ate) <= MAX_DIAS_AUDITORIA) janelas = [[ini, ate]];
    else janelas = [...new Set(datas)].slice(-MAX_DIAS_AUDITORIA).map((d) => [d, d]);
    const ls = await Promise.all(janelas.map(([a, b]) => painel.janela(cl, fila, 'auditoria/index', { idCondominio: id }, a, b, falhas)));
    const despesasDosCasos = new Set(casos.map((k) => String(k.id_despesa)));
    auditoria = painel.enxugarAuditoria([].concat(...ls)).filter((r) => {
      const m = String(r.st_texto_aud || '').match(/despesa\s?#(\d+)/i);
      return m && despesasDosCasos.has(m[1]);
    });
  }

  // Saldo de abertura da conta no dia do vencimento (caixa/index com idContaBancaria).
  const saldos = {};
  const pedidos = new Map();
  casos.forEach((k) => {
    const vu = J.vencimentoUtil(k.datas.vencimento);
    if (!vu || vu > hoje) return;
    const chave = (k.conta || 'total') + '|' + vu;
    if (!pedidos.has(chave)) pedidos.set(chave, { conta: k.conta, data: vu });
  });
  await Promise.all([...pedidos.entries()].slice(0, MAX_SALDOS).map(async ([chave, q]) => {
    try {
      const params = { idCondominio: id, dtInicio: sl(q.data), dtFim: sl(q.data) };
      if (q.conta) params.idContaBancaria = q.conta;
      const j = await fila(() => cl.get('caixa/index', params));
      const linha = Array.isArray(j) ? j.find((x) => x && x.saldoinicialconta !== undefined) : null;
      saldos[chave] = linha && Number.isFinite(Number(linha.saldoinicialconta)) ? Number(linha.saldoinicialconta) : null;
    } catch (e) { saldos[chave] = null; }
  }));

  return {
    id: String(id), competencia: c.rotulo, gerado_em: new Date().toISOString(), hoje,
    nome: (parcelas.find((p) => p.st_fantasia_cond) || {}).st_fantasia_cond || '',
    parcelas, extrato, auditoria, saldos, falhas,
    leitura: { contas: contas.length, contas_sem_extrato: contasSemExtrato, linhas_extrato: extrato.length, linhas_auditoria: auditoria.length, saldos: Object.keys(saldos).length, chamadas: chamadas.length },
    _chamadas: chamadas,
  };
}

module.exports = { carregar, enxugar, soLeitura, ACOES_LIDAS };
