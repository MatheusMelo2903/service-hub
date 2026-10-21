// Consultas de leitura por condomínio para a aba Condomínio (T04).
// Tudo GET no Superlógica. Cada função devolve só os campos que a tela usa:
// contabancos/index, despesas/index, inadimplencia/index e unidades/index trazem
// chaves internas (st_token_cb, st_secret_cb, senha do site, CPF) que não saem daqui,
// salvo quando a tela precisa e está dito na função.

const POR_PAGINA = 50;
const doisDig = (n) => String(n).padStart(2, '0');
const dataSL = (d) => doisDig(d.getMonth() + 1) + '/' + doisDig(d.getDate()) + '/' + d.getFullYear(); // MM/DD/AAAA
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const cent = (v) => Math.round(v * 100) / 100;

// "MM/DD/AAAA HH:MM:SS" -> "DD/MM/AAAA"
function dataBR(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? doisDig(m[2]) + '/' + doisDig(m[1]) + '/' + m[3] : '';
}
// "MM/DD/AAAA" -> "AAAA-MM-DD" (para ordenar)
function dataISO(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? m[3] + '-' + doisDig(m[1]) + '-' + doisDig(m[2]) : '';
}

// Busca todas as páginas (até maxPaginas) de uma rota que pagina de 50 em 50.
async function todasPaginas(cliente, rota, params, maxPaginas) {
  const out = [];
  let truncado = false;
  for (let pg = 1; pg <= maxPaginas; pg++) {
    const j = await cliente.get(rota, Object.assign({}, params, { itensPorPagina: POR_PAGINA, pagina: pg }));
    if (!Array.isArray(j) || !j.length) break;
    j.forEach((x) => out.push(x));
    if (j.length < POR_PAGINA) break;
    if (pg === maxPaginas) truncado = true;
  }
  return { itens: out, truncado };
}

// Saldo por conta bancária ativa.
async function contas(cliente, id) {
  const j = await cliente.get('contabancos/index', { idCondominio: id, exibirContasAtivas: 1, exibirDadosBanco: 1 });
  const lista = (Array.isArray(j) ? j : [])
    .filter((c) => !limpar(c.dt_datafechamento_cb))
    .map((c) => ({
      descricao: limpar(c.st_descricao_cb) || 'Conta',
      banco: limpar(c.st_nome_banc),
      conta: limpar(c.st_conta_cb),
      principal: String(c.fl_principal_cb) === '1',
      saldo: cent(num(c.vl_saldo_cb)),
    }))
    .sort((a, b) => (b.principal - a.principal) || a.descricao.localeCompare(b.descricao, 'pt-BR'));
  return { contas: lista, total: cent(lista.reduce((s, c) => s + c.saldo, 0)) };
}

function resumirDespesa(d) {
  const apro = Array.isArray(d.apropriacao) ? d.apropriacao : [];
  return {
    fornecedor: limpar(d.st_nome_con) || limpar(d.st_fantasia_con),
    descricao: apro.map((a) => limpar(a.st_descricao_cont)).filter(Boolean).join(', ') || limpar(d.st_complemento_pdes),
    complemento: limpar(d.st_complemento_pdes),
    conta: apro.length ? limpar(apro[0].st_conta_cont) : '',
    vencimento: dataBR(d.dt_vencimento_pdes),
    liquidacao: dataBR(d.dt_liquidacao_pdes),
    valor: cent(num(d.vl_valor_pdes)),
    _ord: dataISO(d.dt_liquidacao_pdes || d.dt_vencimento_pdes),
  };
}
function fecharLista(itens, truncado) {
  itens.sort((a, b) => (a._ord < b._ord ? -1 : a._ord > b._ord ? 1 : 0));
  itens.forEach((x) => { delete x._ord; });
  return { itens, quantidade: itens.length, total: cent(itens.reduce((s, x) => s + x.valor, 0)), truncado: !!truncado };
}

// Despesas liquidadas (pagas) no mês. ano e mes (1 a 12).
async function despesasMes(cliente, id, ano, mes) {
  const ini = new Date(ano, mes - 1, 1);
  const fim = new Date(ano, mes, 0);
  const r = await todasPaginas(cliente, 'despesas/index', { idCondominio: id, comStatus: 'liquidadas', dtInicio: dataSL(ini), dtFim: dataSL(fim) }, 30);
  return Object.assign({ ano, mes }, fecharLista(r.itens.map(resumirDespesa), r.truncado));
}

// Contas pendentes: vencidas (últimos 12 meses até ontem) e a vencer (hoje até 30 dias).
async function contasPendentes(cliente, id, hoje) {
  const h = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const ontem = new Date(h); ontem.setDate(h.getDate() - 1);
  const umAno = new Date(h); umAno.setFullYear(h.getFullYear() - 1);
  const em30 = new Date(h); em30.setDate(h.getDate() + 30);
  const [venc, aVencer] = await Promise.all([
    todasPaginas(cliente, 'despesas/index', { idCondominio: id, comStatus: 'pendentes', dtInicio: dataSL(umAno), dtFim: dataSL(ontem) }, 10),
    todasPaginas(cliente, 'despesas/index', { idCondominio: id, comStatus: 'pendentes', dtInicio: dataSL(h), dtFim: dataSL(em30) }, 10),
  ]);
  return {
    vencidas: fecharLista(venc.itens.map(resumirDespesa), venc.truncado),
    a_vencer_30_dias: fecharLista(aVencer.itens.map(resumirDespesa), aVencer.truncado),
  };
}

// Inadimplência por unidade na data de hoje, com valor corrigido (juros e multa).
async function inadimplencia(cliente, id, hoje) {
  const r = await todasPaginas(cliente, 'inadimplencia/index', {
    idCondominio: id, posicaoEm: dataSL(hoje), comValoresAtualizados: 1, apenasResumoInad: 0,
  }, 20);
  const unidades = r.itens.map((u) => {
    const recs = Array.isArray(u.recebimento) ? u.recebimento : [];
    let original = 0, corrigido = 0, maiorAtraso = 0, maisAntigo = '';
    recs.forEach((rc) => {
      const v = num(rc.vl_total_recb || rc.vl_emitido_recb);
      original += v;
      const enc = Array.isArray(rc.encargos) && rc.encargos[0] ? rc.encargos[0] : null;
      corrigido += enc && enc.valorcorrigido ? num(enc.valorcorrigido) : v;
      if (enc) maiorAtraso = Math.max(maiorAtraso, num(enc.diasatraso));
      const iso = dataISO(rc.dt_vencimento_recb);
      if (iso && (!maisAntigo || iso < maisAntigo)) maisAntigo = iso;
    });
    return {
      unidade: limpar(u.st_unidade_uni),
      bloco: limpar(u.st_bloco_uni),
      responsavel: limpar(u.st_sacado_uni),
      cobrancas: recs.length,
      valor_original: cent(original),
      valor_corrigido: cent(corrigido),
      dias_atraso_maior: maiorAtraso,
      vencimento_mais_antigo: maisAntigo ? maisAntigo.split('-').reverse().join('/') : '',
      juridico: num(u.saldo_juridico) > 0,
    };
  }).sort((a, b) => b.valor_corrigido - a.valor_corrigido);
  return {
    unidades,
    quantidade_unidades: unidades.length,
    total_original: cent(unidades.reduce((s, u) => s + u.valor_original, 0)),
    total_corrigido: cent(unidades.reduce((s, u) => s + u.valor_corrigido, 0)),
    truncado: r.truncado,
  };
}

// Busca global de unidades em todos os condomínios (nome, CPF/CNPJ ou número da unidade).
// Devolve nome e papel dos contatos para mostrar quem bateu; nada de CPF, email ou telefone.
async function buscarUnidades(cliente, termo) {
  const r = await todasPaginas(cliente, 'unidades/index', { idCondominio: -1, pesquisa: termo, exibirDadosDosContatos: 1 }, 3);
  const itens = r.itens.map((u) => ({
    id_superlogica: Number(u.id_condominio_cond) || null,
    condominio: limpar(u.st_fantasia_cond) || limpar(u.st_nome_cond),
    unidade: limpar(u.st_unidade_uni),
    bloco: limpar(u.st_bloco_uni),
    proprietario: limpar(u.nome_proprietario) || limpar(u.st_sacado_uni),
    contatos: (Array.isArray(u.contatos) ? u.contatos : [])
      .filter((c) => !limpar(c.dt_saida_res))
      .map((c) => ({ nome: limpar(c.st_nome_con), papel: limpar(c.st_nometiporesp_tres) }))
      .filter((c) => c.nome),
  }));
  return { termo, itens, quantidade: itens.length, truncado: r.truncado };
}

// Auditoria cadastral: unidades sem email, CPF/CNPJ ou telefone no proprietário, e a
// soma da fração ideal (o Superlógica usa escala 1 ou 100 conforme o condomínio).
async function auditoria(cliente, id) {
  const r = await todasPaginas(cliente, 'unidades/index', { idCondominio: id, exibirDadosDosContatos: 1 }, 40);
  let soma = 0;
  const pendencias = [];
  const semFracao = [];
  r.itens.forEach((u) => {
    const fr = num(u.nm_fracao_uni);
    soma += fr;
    const nomeUni = limpar(u.st_unidade_uni) + (limpar(u.st_bloco_uni) ? ' ' + limpar(u.st_bloco_uni) : '');
    if (!(fr > 0)) semFracao.push(nomeUni);
    const contatos = Array.isArray(u.contatos) ? u.contatos.filter((c) => !limpar(c.dt_saida_res)) : [];
    const prop = contatos.filter((c) => String(c.id_tiporesp_tres || c.tipo) === '1' || /propriet/i.test(c.st_nometiporesp_tres || ''));
    const doc = limpar(u.cpf_proprietario) || prop.some((c) => limpar(c.st_cpf_con) || limpar(c.st_cgc_con));
    const email = limpar(u.email_proprietario) || prop.some((c) => limpar(c.st_email_con));
    const fone = limpar(u.telefone_proprietario) || limpar(u.celular_proprietario) || prop.some((c) => limpar(c.st_telefone_con) || limpar(c.st_celular_con));
    const falta = [];
    if (!doc) falta.push('CPF/CNPJ');
    if (!email) falta.push('email');
    if (!fone) falta.push('telefone');
    if (falta.length) pendencias.push({ unidade: nomeUni, proprietario: limpar(u.nome_proprietario) || limpar(u.st_sacado_uni), falta });
  });
  soma = Math.round(soma * 1e6) / 1e6;
  // Escala: soma perto de 1 (fração em decimal) ou de 100 (em porcentagem).
  const escala = Math.abs(soma - 1) <= Math.abs(soma - 100) ? 1 : 100;
  const pct = escala === 1 ? soma * 100 : soma;
  const fracaoOk = Math.abs(pct - 100) <= 0.01;
  const contar = (campo) => pendencias.filter((p) => p.falta.includes(campo)).length;
  return {
    total_unidades: r.itens.length,
    truncado: r.truncado,
    fracao: { soma, escala, soma_percentual: Math.round(pct * 10000) / 10000, ok: fracaoOk, unidades_sem_fracao: semFracao },
    sem_cpf: contar('CPF/CNPJ'), sem_email: contar('email'), sem_telefone: contar('telefone'),
    pendencias: pendencias.sort((a, b) => a.unidade.localeCompare(b.unidade, 'pt-BR', { numeric: true })),
  };
}

// Cache simples em memória.
function criarCache(ttlMs, max) {
  const m = new Map();
  return {
    async pegar(chave, fn) {
      const c = m.get(chave);
      if (c && c.ate > Date.now()) return c.v;
      const v = await fn();
      m.set(chave, { ate: Date.now() + ttlMs, v });
      if (m.size > max) m.delete(m.keys().next().value);
      return v;
    },
  };
}

module.exports = { contas, despesasMes, contasPendentes, inadimplencia, buscarUnidades, auditoria, criarCache };
