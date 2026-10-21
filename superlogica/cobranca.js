// Painel de cobrança (T11). Tudo GET no Superlógica:
//  inadimplencia/index        unidades em atraso com as cobranças em aberto
//  historicocobranca/index    último contato de cobrança por unidade (CRM do Superlógica)
//  cobranca/index + acordos/simularparcelas   simulação de acordo (não cria acordo)
//  cobranca/gerarlinksegundavia               link da 2ª via (texto pronto para WhatsApp)
// Devolve só nome do responsável, unidade, valores e datas. Email e telefone do CRM não saem.

const POR_PAGINA = 50;
const doisDig = (n) => String(n).padStart(2, '0');
const dataSL = (d) => doisDig(d.getMonth() + 1) + '/' + doisDig(d.getDate()) + '/' + d.getFullYear();
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const cent = (v) => Math.round(v * 100) / 100;
function dataBR(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? doisDig(m[2]) + '/' + doisDig(m[1]) + '/' + m[3] : '';
}
function dataISO(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  return m ? m[3] + '-' + doisDig(m[1]) + '-' + doisDig(m[2]) + (m[4] ? 'T' + m[4] + ':' + m[5] : '') : '';
}
const CANAL = { 1: 'telefone', 2: 'email', 3: 'SMS', 4: 'carta', 5: 'presencial', 6: 'aplicativo de mensagem', 7: 'outros' };

async function paginas(cliente, rota, params, max) {
  const out = [];
  for (let pg = 1; pg <= max; pg++) {
    const j = await cliente.get(rota, Object.assign({}, params, { itensPorPagina: POR_PAGINA, pagina: pg }));
    if (!Array.isArray(j) || !j.length) break;
    j.forEach((x) => out.push(x));
    if (j.length < POR_PAGINA) break;
    if (pg === max) out.cortado = true;
  }
  return out;
}

// Descrição do CRM sem email e telefone (o registro automático cita o email do morador).
function semContato(t) {
  return limpar(t).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'o email cadastrado')
    .replace(/(\+?\d[\d\s().]{7,}\d)/g, 'o telefone cadastrado').slice(0, 200);
}

// Último registro do CRM por unidade nos últimos 120 dias: o último contato feito por alguém
// (telefone, email, carta...) e o último evento de qualquer tipo (inclui os automáticos).
async function ultimosContatos(cliente, id, hoje) {
  const ini = new Date(hoje); ini.setDate(hoje.getDate() - 120);
  const itens = await paginas(cliente, 'historicocobranca/index', { idEmpresa: id, dtInicio: dataSL(ini), dtFim: dataSL(hoje) }, 30);
  const porUni = new Map();
  itens.forEach((h) => {
    const uni = String(h.id_unidade_uni || '');
    if (!uni) return;
    const canal = Number(h.fl_canalcomunicacao_hate);
    const reg = {
      data: dataBR(h.dt_data_hate), _ord: dataISO(h.dt_data_hate),
      canal: CANAL[canal] || 'automático', resultado: limpar(h.st_descricaoresultado_atend),
      descricao: semContato(h.st_descricao_hate), por: limpar(h.st_apelido_usu),
    };
    const atual = porUni.get(uni) || {};
    if (!atual.qualquer || reg._ord > atual.qualquer._ord) atual.qualquer = reg;
    if (CANAL[canal] && (!atual.humano || reg._ord > atual.humano._ord)) atual.humano = reg;
    porUni.set(uni, atual);
  });
  porUni.forEach((v) => { if (v.qualquer) delete v.qualquer._ord; if (v.humano) delete v.humano._ord; });
  return { porUni, cortado: !!itens.cortado };
}

// Unidades em atraso hoje, com as cobranças em aberto e o último contato.
async function painelCondominio(cliente, id, hoje) {
  const [inad, crm] = await Promise.all([
    paginas(cliente, 'inadimplencia/index', { idCondominio: id, posicaoEm: dataSL(hoje), comValoresAtualizados: 1, apenasResumoInad: 0 }, 12),
    ultimosContatos(cliente, id, hoje).catch(() => null),
  ]);
  const unidades = inad.map((u) => {
    const recs = (Array.isArray(u.recebimento) ? u.recebimento : []).map((rc) => {
      const enc = Array.isArray(rc.encargos) && rc.encargos[0] ? rc.encargos[0] : null;
      const v = num(rc.vl_total_recb || rc.vl_emitido_recb);
      return {
        id: String(rc.id_recebimento_recb || ''), vencimento: dataBR(rc.dt_vencimento_recb), _ord: dataISO(rc.dt_vencimento_recb),
        valor: cent(v), corrigido: cent(enc && enc.valorcorrigido ? num(enc.valorcorrigido) : v), dias: enc ? num(enc.diasatraso) : 0,
        acordo: !!limpar(rc.id_acordo_recb),
      };
    }).filter((r) => r.id).sort((a, b) => (a._ord < b._ord ? -1 : 1));
    recs.forEach((r) => { delete r._ord; });
    const c = crm && crm.porUni.get(String(u.id_unidade_uni)) || {};
    return {
      id_unidade: String(u.id_unidade_uni || ''),
      unidade: limpar(u.st_unidade_uni) + (limpar(u.st_bloco_uni) ? ' ' + limpar(u.st_bloco_uni) : ''),
      responsavel: limpar(u.st_sacado_uni),
      cobrancas: recs.length,
      valor_original: cent(recs.reduce((s, r) => s + r.valor, 0)),
      valor_corrigido: cent(recs.reduce((s, r) => s + r.corrigido, 0)),
      dias_atraso_maior: recs.reduce((m, r) => Math.max(m, r.dias), 0),
      juridico: num(u.saldo_juridico) > 0,
      recebimentos: recs.slice(0, 120),
      ultimo_contato: c.humano || null,
      ultimo_evento: c.qualquer || null,
    };
  }).filter((u) => u.id_unidade).sort((a, b) => b.valor_corrigido - a.valor_corrigido);
  return {
    id_superlogica: Number(id),
    unidades,
    quantidade_unidades: unidades.length,
    total_original: cent(unidades.reduce((s, u) => s + u.valor_original, 0)),
    total_corrigido: cent(unidades.reduce((s, u) => s + u.valor_corrigido, 0)),
    sem_contato_90_dias: unidades.filter((u) => !u.ultimo_contato || diasDesde(u.ultimo_contato.data, hoje) > 90).length,
    crm_indisponivel: !crm,
    cortado: !!inad.cortado || !!(crm && crm.cortado),
  };
}
function diasDesde(br, hoje) {
  const m = String(br || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return Infinity;
  return Math.floor((hoje - new Date(+m[3], +m[2] - 1, +m[1])) / 86400000);
}

// Simulação de acordo das cobranças em aberto da unidade (não grava nada).
// opcoes: { parcelas (1 a 60), entrada (R$), primeira (Date) }
async function simularAcordo(cliente, id, idUnidade, recebimentos, opcoes, hoje) {
  if (!recebimentos.length) { const e = new Error('sem_cobrancas'); e.status = 422; throw e; }
  const p1 = { apenasColunasPrincipais: 1, semProcesso: 0, comValoresAtualizados: 1, status: 2, id: idUnidade,
    comHonorarios: 1, somenteComposicoesAcordo: 1, comDadosDasContasEReceitas: 1, comComposicoes: 1,
    dtAtualizacao: dataSL(hoje), idCondominio: id };
  recebimentos.forEach((r, i) => { p1['ids[' + i + ']'] = r; });
  const [comp, cond, contas] = await Promise.all([
    cliente.get('cobranca/index', p1),
    cliente.get('condominios/get', { id, somenteCondominiosAtivos: 0 }),
    cliente.get('contabancos/index', { idCondominio: id, exibirContasAtivas: 1 }),
  ]);
  const apro = (Array.isArray(comp) && comp[0] && Array.isArray(comp[0].receita_apropriacao)) ? comp[0].receita_apropriacao : [];
  if (!apro.length) { const e = new Error('sem_composicao'); e.status = 422; throw e; }
  const c0 = Array.isArray(cond) ? cond[0] : cond;
  const lista = Array.isArray(contas) ? contas.filter((x) => !limpar(x.dt_datafechamento_cb)) : [];
  const principal = lista.find((x) => String(x.fl_principal_cb) === '1') || lista[0];
  if (!principal) { const e = new Error('sem_conta'); e.status = 422; throw e; }
  const total = cent(apro.reduce((s, a) => s + num(a.total_receita), 0));
  const entrada = cent(Math.max(0, Math.min(num(opcoes.entrada), total)));
  const q = {
    TOTAL_RECEITAAPRO: total, PRIORIZARHONORARIOS: 0, SIMULA_TOTAL: total, SIMULA_ENTRADA: entrada,
    NM_PARCELA_ACO: opcoes.parcelas, FL_EMITIR_RECIBO: 0, DT_PRIMEIRA_PARCELA: dataSL(opcoes.primeira),
    'ENTRADA[0][VALOR]': entrada, 'ENTRADA[0][ID_FORMAPAGAMENTO_RECB]': '', 'ENTRADA[0][VENCIMENTO]': entrada > 0 ? dataSL(hoje) : '',
    'PARCELAS[0][VENCIMENTO]': '', 'PARCELAS[0][VALOR]': 0, 'PARCELAS[0][OBSERVACAO]': '',
    ALTERAR_ENCARGOS: 0, NM_TXJUROS_COND: num(c0 && c0.nm_txjuros_cond), NM_TXMULTA_COND: num(c0 && c0.nm_txmulta_cond),
    NM_TXDESCONTO_RECB: 0, ID_FORMA_RECB: 1, ID_CONTABANCO_CB: principal.id_contabanco_cb, DT_ACORDO_ACO: dataSL(hoje),
    ID_IMPRESSAO_FIMP: '', TIPO_ACORDO: 0, ID_UNIDADE_UNI: idUnidade, ID_CONDOMINIO_COND: id,
  };
  apro.forEach((a, i) => {
    q['RECEITA_APROPRIACAO[' + i + '][ST_CONTA_CONT]'] = limpar(a.st_conta_cont);
    q['RECEITA_APROPRIACAO[' + i + '][ST_DESCRICAO_CONT]'] = limpar(a.st_conta_cont) + '  ' + limpar(a.st_descricao_cont);
    q['RECEITA_APROPRIACAO[' + i + '][ST_COMPLEMENTO_REC]'] = limpar(a.st_complemento_rec);
    q['RECEITA_APROPRIACAO[' + i + '][VL_VALOR_REC]'] = num(a.total_receita);
    q['RECEITA_APROPRIACAO[' + i + '][APROPRIARPRIMEIRO]'] = 0;
  });
  const sim = await cliente.get('acordos/simularparcelas', q);
  const parcelas = (Array.isArray(sim) ? sim : []).map((p) => ({ vencimento: dataBR(p.vencimento), valor: cent(num(p.valor)), observacao: limpar(p.observacao) }));
  if (!parcelas.length) { const e = new Error('simulacao_vazia'); e.status = 422; throw e; }
  return {
    total, entrada, parcelas,
    composicao: apro.map((a) => ({ conta: limpar(a.st_descricao_cont), valor: cent(num(a.total_receita)) })),
    soma_parcelas: cent(parcelas.reduce((s, p) => s + p.valor, 0)),
  };
}

// Link da 2ª via de uma cobrança da unidade, atualizada para a data pedida.
async function linkSegundaVia(cliente, id, recebimento, vencimentoOriginal, atualizarPara) {
  const j = await cliente.get('cobranca/gerarlinksegundavia', {
    ID_CONDOMINIO_COND: id, ID_RECEBIMENTO_RECB: recebimento.id,
    DT_VENCIMENTO_RECB: vencimentoOriginal, DT_ATUALIZACAO_VENCIMENTO: dataSL(atualizarPara),
  });
  const o = Array.isArray(j) ? j[0] : j;
  const link = o && (o.link || o.url || o.st_link || (o.data && o.data.link) || (typeof o === 'string' ? o : ''));
  if (!link || !/^https:\/\//i.test(String(link))) { const e = new Error('sem_link'); e.status = 422; e.corpo = o; throw e; }
  return String(link);
}

module.exports = { painelCondominio, simularAcordo, linkSegundaVia, diasDesde, dataSL };
