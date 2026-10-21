// Comparativo entre condomínios (T14). Só leitura no Superlógica.
//  custos: balancete dos últimos 12 meses fechados numa chamada só (balancetes/index) e a
//    quantidade de unidades (consumo/index devolve todas as unidades de uma vez; se falhar,
//    unidades/index paginado). Pessoal = categoria 2.x "pessoal"; água, energia e gás = contas
//    da categoria de consumo. Valores por unidade por mês.
//  fornecedores: despesas pagas no mesmo período (despesas/index, filtro pela data do
//    pagamento), somadas por fornecedor (CNPJ/CPF quando houver, senão nome).

const POR_PAGINA = 50;
const doisDig = (n) => String(n).padStart(2, '0');
const dataSL = (d) => doisDig(d.getMonth() + 1) + '/' + doisDig(d.getDate()) + '/' + d.getFullYear();
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const cent = (v) => Math.round(v * 100) / 100;
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// Últimos n meses fechados: do 1º dia de (mês atual - n) ao último dia do mês passado.
function periodo(hoje, n) {
  const ini = new Date(hoje.getFullYear(), hoje.getMonth() - n, 1);
  const fim = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
  return { ini, fim, meses: n, rotulo: MESES[ini.getMonth()] + '/' + ini.getFullYear() + ' a ' + MESES[fim.getMonth()] + '/' + fim.getFullYear() };
}

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

async function contarUnidades(cliente, id, hoje) {
  try {
    const j = await cliente.get('consumo/index', { tipoLeitura: 1, idCondominio: id, posicaoEm: dataSL(hoje) });
    if (Array.isArray(j) && j.length) return new Set(j.filter((u) => u && u.id_unidade_uni).map((u) => String(u.id_unidade_uni))).size;
  } catch (e) { /* cai no unidades/index */ }
  const u = await paginas(cliente, 'unidades/index', { idCondominio: id }, 40);
  return new Set(u.filter((x) => x && x.id_unidade_uni).map((x) => String(x.id_unidade_uni))).size;
}

function linhasBalancete(bruto) {
  const out = [];
  (Array.isArray(bruto) ? bruto : []).forEach((b) => ((b && b.itens) || []).forEach((g) => (g || []).forEach((l) => {
    if (l && l.conta) out.push({ conta: String(l.conta).trim(), descricao: limpar(l.descricao), valor: num(l.valor), folha: l.itens !== undefined && l.itens !== null });
  })));
  return out;
}

async function custosCondominio(cliente, id, hoje, n) {
  const p = periodo(hoje, n);
  const [bal, unidades] = await Promise.all([
    cliente.get('balancetes/index', { idCondominio: id, dtInicio: dataSL(p.ini), dtFim: dataSL(p.fim) }),
    contarUnidades(cliente, id, hoje),
  ]);
  const linhas = linhasBalancete(bal);
  const porConta = new Map(linhas.map((l) => [l.conta, l]));
  const total = porConta.get('2') ? porConta.get('2').valor : 0;
  const cats = linhas.filter((l) => /^2\.\d+$/.test(l.conta));
  const catPessoal = cats.find((c) => /pessoal/.test(semAcento(c.descricao)));
  const RE_CONSUMO = /agua|esgoto|saneamento|energia|\bluz\b|\bgas\b/;
  const folhasDe = (c) => linhas.filter((l) => l.folha && l.conta.startsWith(c.conta + '.'));
  // Categoria de consumo: a que tem folhas de água, energia ou gás (não basta o nome: há planos
  // com "Material de Consumo"). Sem nenhuma, procura essas folhas em todas as categorias de
  // despesa, menos investimento (a Energia Solar financiada não é conta de energia).
  const candidatas = cats.filter((c) => !/material|investimento/.test(semAcento(c.descricao)) && folhasDe(c).some((l) => RE_CONSUMO.test(semAcento(l.descricao))));
  const catConsumo = candidatas.find((c) => /consumo|concession|servicos? publicos/.test(semAcento(c.descricao))) || candidatas[0] || null;
  const folhasConsumo = catConsumo ? folhasDe(catConsumo) : [];
  const soma = (re) => cent(folhasConsumo.filter((l) => re.test(semAcento(l.descricao))).reduce((s, l) => s + l.valor, 0));
  const v = {
    total: cent(total),
    pessoal: cent(catPessoal ? catPessoal.valor : 0),
    agua: soma(/agua|esgoto|saneamento/),
    energia: soma(/energia|\bluz\b/),
    gas: soma(/\bgas\b/),
  };
  const porUnidadeMes = {};
  Object.keys(v).forEach((k) => { porUnidadeMes[k] = unidades > 0 ? cent(v[k] / unidades / n) : null; });
  return {
    id_superlogica: Number(id), periodo: p.rotulo, meses: n, unidades,
    totais: v, por_unidade_mes: porUnidadeMes,
    contas_consumo: folhasConsumo.map((l) => ({ conta: l.descricao, valor: cent(l.valor) })),
    sem_categoria_pessoal: !catPessoal, sem_categoria_consumo: !catConsumo,
  };
}

async function fornecedoresCondominio(cliente, id, hoje, n) {
  const p = periodo(hoje, n);
  const itens = await paginas(cliente, 'despesas/index', { idCondominio: id, comStatus: 'liquidadas', filtrarpor: 'liquidacao', dtInicio: dataSL(p.ini), dtFim: dataSL(p.fim) }, 40);
  const mapa = new Map();
  const vistas = new Set();
  let ignorados = 0;
  itens.forEach((d) => {
    if (String(d.fl_liquidado_pdes) !== '1') return;
    // A paginação pode repetir parcela entre páginas: conta cada uma uma vez.
    const idp = String(d.id_parcela_pdes || '') || [d.id_despesa_des, d.st_complemento_pdes, d.dt_liquidacao_pdes, d.vl_valor_pdes].join('|');
    if (vistas.has(idp)) return;
    vistas.add(idp);
    const nome = limpar(d.st_nome_con) || limpar(d.st_fantasia_con);
    if (!nome) return;
    const doc = String(d.st_cpf_con || '').replace(/\D/g, '');
    // Comparativo é de fornecedor: pessoa física (salário, autônomo) e tributos ficam de fora.
    const contasTxt = semAcento((Array.isArray(d.apropriacao) ? d.apropriacao : []).map((a) => a.st_descricao_cont).join(' '));
    if (doc.length === 11 || /(salari|ferias|13 salario|decimo|rescis|adiantamento|inss|fgts|darf|irrf|\biss\b|\bpis\b|cofins|csll|imposto|tarifa|juros|pro.?labore|folha)/.test(contasTxt + ' ' + semAcento(nome))) { ignorados++; return; }
    const chave = doc.length === 14 ? 'cnpj:' + doc : 'nome:' + semAcento(nome).replace(/[^a-z0-9]+/g, ' ').trim();
    const apro = Array.isArray(d.apropriacao) ? d.apropriacao : [];
    const r = mapa.get(chave) || { chave, nome, cnpj: doc.length === 14 ? doc : '', total: 0, pagamentos: 0, contas: new Set() };
    r.total += num(d.vl_valor_pdes);
    r.pagamentos += 1;
    apro.forEach((a) => { if (limpar(a.st_descricao_cont)) r.contas.add(limpar(a.st_descricao_cont)); });
    mapa.set(chave, r);
  });
  const lista = [...mapa.values()].map((r) => ({
    chave: r.chave, nome: r.nome, cnpj: r.cnpj, total: cent(r.total), pagamentos: r.pagamentos,
    media_mes: cent(r.total / n), contas: [...r.contas].slice(0, 4),
  })).sort((a, b) => b.total - a.total).slice(0, 300);
  return { id_superlogica: Number(id), periodo: p.rotulo, meses: n, fornecedores: lista, cortado: !!itens.cortado || mapa.size > 300, ignorados };
}

module.exports = { custosCondominio, fornecedoresCondominio, periodo };
