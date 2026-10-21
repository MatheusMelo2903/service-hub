// T35: conciliação sem depender do banco. Usa o extrato que a equipe já importa no Superlógica
// (conciliacao/index por condomínio e conta, conferindo a conta de cada linha) e as contas
// (contabancos/index). Só GET no Superlógica, no máximo 2 chamadas ao mesmo tempo, cache de 10 min.
// Casamento sistema x banco, quadro e sugestões de regra em public/conciliacao-casar.js (funções puras,
// as mesmas que a tela usa para comparar o arquivo OFX antes de importar).
'use strict';
const C = require('../public/conciliacao-casar.js');

const SIMULTANEAS = 2;
const TTL = 10 * 60 * 1000;
const MARGEM_DIAS = 5;          // lê 5 dias antes e depois do mês para casar itens na virada
const DIAS_QUADRO = 75;         // o quadro olha os últimos 75 dias de cada conta
const MESES_REGRAS = 3;         // histórico para sugerir regras: os 3 meses fechados anteriores
const MAX_CONDOMINIOS_QUADRO = 80;
const MAX_ITENS_LISTA = 300;    // por lista na resposta da tela
const NAO_CONDOMINIOS = new Set(['143', '144', '145', '160', '162']);
const RX_FORA = /\bVIRTUAL SERVICE\b/i;
const RX_LINHA_SALDO = /^\s*SALDO\b/i;

// ── fila e cache ──────────────────────────────────────────────────────────
// Duas filas: a leitura de um condomínio (alta) passa na frente do quadro da carteira (baixa),
// e o total continua em n chamadas ao mesmo tempo (revisão 1, M4).
function criarFila(n) {
  let ativos = 0;
  const alta = [], baixa = [];
  const proximo = () => {
    if (ativos >= n || (!alta.length && !baixa.length)) return;
    ativos++;
    const { fn, ok, falha } = alta.length ? alta.shift() : baixa.shift();
    Promise.resolve().then(fn).then(ok, falha).finally(() => { ativos--; proximo(); });
  };
  // promover(): se ainda não começou, a leitura da fila baixa passa para a alta (revisão 2, M1).
  return (fn, prioridadeBaixa) => {
    let item = null;
    const p = new Promise((ok, falha) => { item = { fn, ok, falha }; (prioridadeBaixa ? baixa : alta).push(item); proximo(); });
    p.promover = () => { const i = baixa.indexOf(item); if (i >= 0) { baixa.splice(i, 1); alta.push(item); proximo(); } };
    return p;
  };
}
function criarCache(ttl, max) {
  const m = new Map();
  return {
    pegar(chave, fn, forcar) {
      const c = m.get(chave);
      if (c && (c.pronto ? c.ate > Date.now() : true) && !(forcar && c.pronto && Date.now() - c.criado > 60000)) return c.p;
      const p = Promise.resolve().then(fn);
      const item = { p, criado: Date.now(), ate: Date.now() + ttl, pronto: false };
      m.set(chave, item);
      p.then(() => { item.pronto = true; item.ate = Date.now() + ttl; }, () => { if (m.get(chave) === item) m.delete(chave); });
      if (m.size > max) m.delete(m.keys().next().value);
      return p;
    },
    limpar() { m.clear(); },
  };
}

// ── datas ─────────────────────────────────────────────────────────────────
const sl = (iso) => iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4); // AAAA-MM-DD para MM/DD/AAAA
const fimDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
function competencia(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const ano = +m[1], mes = +m[2];
  if (mes < 1 || mes > 12 || ano < 2020 || ano > 2100) return null;
  return { rotulo: m[1] + '-' + m[2], inicio: m[1] + '-' + m[2] + '-01', fim: fimDoMes(ano, mes) };
}
function hojeSP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function mesesAnteriores(hoje, n) { // n meses fechados antes do mês de hoje, do mais antigo ao mais novo
  const out = [];
  let ano = +hoje.slice(0, 4), mes = +hoje.slice(5, 7);
  for (let i = 0; i < n; i++) { mes--; if (!mes) { mes = 12; ano--; } out.unshift(competencia(ano + '-' + String(mes).padStart(2, '0'))); }
  return out;
}

// ── contas (só campos sem chave, token ou senha) ─────────────────────────
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 120);
// Tipo 3 é conta caixa (dinheiro em espécie): não tem extrato de banco.
function contaSemExtrato(c) {
  return String(c.id_tipocontabanco_tcb) === '3' || /CAIXINHA/i.test(String(c.st_nome_banc || ''));
}
function enxugarConta(c) {
  return {
    id: txt(c.id_contabanco_cb, 12), id_condominio: txt(c.id_condominio_cond, 12), descricao: txt(c.st_descricao_cb, 80),
    banco: txt(c.st_nome_banc, 60), tipo: txt(c.id_tipocontabanco_tcb, 3), principal: String(c.fl_principal_cb) === '1',
    bloqueio: C.dataISO(c.dt_bloquearlancamentos_cb), sem_extrato_esperado: contaSemExtrato(c),
  };
}
async function lerLista(cliente, fila, action, params) {
  const j = await fila(() => cliente.get(action, params));
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.data)) return j.data;
  const e = new Error('resposta_invalida'); e.motivo = 'resposta sem lista'; throw e;
}
async function lerContas(cliente, fila, idCondominio) {
  const l = await lerLista(cliente, fila, 'contabancos/index', { idCondominio, exibirDadosAgencia: 1, exibirContasAtivas: 1, semContaDigital: 0 });
  return l.filter((c) => c && (idCondominio === -1 || String(c.id_condominio_cond) === String(idCondominio))).map(enxugarConta).filter((c) => /^\d+$/.test(c.id));
}
async function lerNomes(cliente, fila) {
  const nomes = new Map();
  for (let pg = 1; pg <= 10; pg++) {
    const l = await lerLista(cliente, fila, 'condominios/get', { id: -1, somenteCondominiosAtivos: 1, itensPorPagina: 500, pagina: pg });
    l.forEach((c) => {
      const id = txt(c.id_condominio_cond, 12);
      const nome = txt(c.st_fantasia_cond || c.st_nome_cond, 100);
      if (id && !RX_FORA.test(nome) && !RX_FORA.test(String(c.st_nome_cond || ''))) nomes.set(id, nome);
      else if (id) nomes.set(id, null); // fora de toda análise
    });
    if (l.length < 500) break;
  }
  return nomes;
}

// ── extrato importado (conciliacao/index) ─────────────────────────────────
// A API só respeita a conta quando vem idCondominio + idConta da mesma conta; se vier linha
// de outra conta, a resposta inteira é descartada (testes/T23/resultado.md).
function normalizarConciliacao(j, idConta, ini, fim) {
  if (j === null || j === undefined) { const e = new Error('resposta_invalida'); e.motivo = 'resposta que não é JSON'; throw e; }
  const itens = Array.isArray(j) ? j : (j && Array.isArray(j.itens) ? j.itens : null);
  if (!itens) { const e = new Error('resposta_invalida'); e.motivo = 'resposta sem itens'; throw e; }
  const conta = String(idConta);
  const dentro = (d) => !!d && d >= ini && d <= fim;
  const saldos = [], banco = [], sistema = [];
  let outraConta = 0;
  for (const x of itens) {
    if (!x || typeof x !== 'object') continue;
    if (String(x.fl_saldo) === '1') {
      const d = C.dataISO(x.data);
      if (dentro(d)) saldos.push({ data: d, sistema: C.centavos(x.saldo_anterior_software), banco: C.centavos(x.saldo_anterior_banco) });
      continue;
    }
    if (x.valor_banco !== undefined && x.data_banco) {
      if (String(x.id_conta_banco) !== conta) outraConta++;
      if (RX_LINHA_SALDO.test(String(x.descricao_banco || ''))) continue; // linha de saldo do extrato, não é movimento
      const d = C.dataISO(x.data_banco);
      if (dentro(d)) banco.push({ data: d, valor: C.centavos(x.valor_banco), descricao: txt(x.descricao_banco, 120), fitid: txt(x.fitid_banco, 60), numero: txt(x.numero_banco, 30), desconsiderado: String(x.desconsiderar_lancamento_banco) === '1' });
    }
    if (x.valor_software !== undefined && x.data_software) {
      if (String(x.id_conta_software) !== conta) outraConta++;
      const d = C.dataISO(x.data_software);
      if (dentro(d)) sistema.push({ data: d, valor: C.centavos(x.valor_software), descricao: txt(x.descricao_software, 120), documento: txt(x.st_documento_software, 30), numero: txt(x.numero_software, 30), origem: txt(x.fl_origem_mov_software, 3) });
    }
  }
  if (outraConta) return { descartada: true, outra_conta: outraConta, saldos: [], banco: [], sistema: [] };
  return { descartada: false, saldos, banco, sistema };
}
// Uma chamada por mês do calendário: medido em 21/10 que janela no meio do mês ou que cruza meses
// volta incompleta (só os últimos dias, ou nada); o mês inteiro (dia 1 ao último dia, ou até hoje) volta certo.
async function lerExtratoMes(cliente, fila, idCondominio, idConta, mes, hoje, baixa, registrar) {
  const c = competencia(mes);
  const fim = c.fim > hoje ? hoje : c.fim;
  const pedido = fila(() => cliente.get('conciliacao/index', { idCondominio, idConta, dtInicio: sl(c.inicio), dtFim: sl(fim) }), baixa);
  if (registrar) registrar(pedido.promover);
  const j = await pedido;
  return normalizarConciliacao(j, idConta, c.inicio, fim);
}
function mesesDoPeriodo(ini, fim) {
  const out = [];
  let ano = +ini.slice(0, 4), mes = +ini.slice(5, 7);
  const ultimo = fim.slice(0, 7);
  for (let i = 0; i < 24; i++) {
    const r = ano + '-' + String(mes).padStart(2, '0');
    if (r > ultimo) break;
    out.push(r);
    mes++; if (mes > 12) { mes = 1; ano++; }
  }
  return out;
}
function juntarMeses(partes, ini, fim) {
  if (partes.some((p) => p.descartada)) return { descartada: true, saldos: [], banco: [], sistema: [] };
  const dentro = (x) => x.data >= ini && x.data <= fim;
  const junta = (k) => [].concat(...partes.map((p) => p[k])).filter(dentro);
  return { descartada: false, saldos: junta('saldos'), banco: junta('banco'), sistema: junta('sistema') };
}

// ── análise de uma conta num período ──────────────────────────────────────
const reais = (c) => (c == null ? null : Math.round(c) / 100);
function itemTela(x) {
  const o = { data: x.data, valor: reais(x.valor), descricao: x.descricao };
  if (x.documento) o.documento = x.documento;
  return o;
}
function analisarConta(dados, ini, fim, hoje) {
  const ate = (x) => x.data <= fim;
  const q = C.quadroConta(dados.saldos.filter(ate), dados.banco.filter(ate), hoje, dados.sistema.filter(ate));
  const limite = q.ultimo_extrato;
  const mesFechado = (mes) => C.maisDias(fimDoMes(+mes.slice(0, 4), +mes.slice(5, 7)), 1) <= (limite || '');
  const r = C.casar(dados.sistema, dados.banco, { mesFechado });
  const noPeriodo = (d) => d >= ini && d <= fim;
  // Lançamento depois do último dia de extrato ainda não tem como estar no banco: não é pendência.
  const soSistema = r.soSistema.filter((s) => noPeriodo(s.data) && limite && s.data <= limite);
  const aguardando = r.soSistema.filter((s) => noPeriodo(s.data) && (!limite || s.data > limite)).length;
  const soBanco = r.soBanco.filter((b) => noPeriodo(b.data));
  const valorDif = r.pares.filter((p) => p.tipo === 'valor' && noPeriodo(p.sistema[0].data)).map((p) => ({
    data_sistema: p.sistema[0].data, data_banco: p.banco[0].data, lancado: reais(p.sistema[0].valor), no_banco: reais(p.banco[0].valor), diferenca: reais(p.diferenca),
    descricao: p.sistema[0].descricao, descricao_banco: p.banco[0].descricao, documento: p.sistema[0].documento || '',
  }));
  const dataDif = r.pares.filter((p) => p.tipo === 'data' && noPeriodo(p.sistema[0].data)).map((p) => ({
    data_sistema: p.sistema[0].data, data_banco: p.banco[0].data, dias: p.dias, valor: reais(p.sistema[0].valor), descricao: p.sistema[0].descricao, descricao_banco: p.banco[0].descricao, documento: p.sistema[0].documento || '',
  }));
  const divergencias = r.divergencias.filter((d) => !d.mes || (d.mes >= ini.slice(0, 7) && d.mes <= fim.slice(0, 7))).map((d) => {
    if (d.tipo === 'lancado_e_desconsiderado') return { tipo: d.tipo, data: d.data, valor: reais(d.valor), descricao: d.sistema.descricao, descricao_banco: d.banco.descricao };
    return { tipo: d.tipo, mes: d.mes, data: d.data, banco: reais(d.banco), sistema: reais(d.sistema), diferenca: reais(d.sistema - d.banco), itens_banco: d.itens_banco, descricao: d.descricao || '', descricao_banco: d.descricao_banco || '' };
  }).filter((d) => d.tipo !== 'lancado_e_desconsiderado' || noPeriodo(d.data));
  const diasPendentes = new Set();
  soSistema.forEach((s) => diasPendentes.add(s.data));
  soBanco.forEach((b) => diasPendentes.add(b.data));
  valorDif.forEach((v) => diasPendentes.add(v.data_banco));
  const contagem = { exato: 0, grupo: 0, rendimento: 0, estorno: 0, data: 0, valor: 0 };
  r.pares.forEach((p) => { if (noPeriodo((p.sistema[0] || p.banco[0]).data)) contagem[p.tipo] = (contagem[p.tipo] || 0) + 1; });
  const corta = (l) => l.slice(0, MAX_ITENS_LISTA);
  return {
    quadro: {
      ultimo_extrato: q.ultimo_extrato, dias_sem_extrato: q.dias_sem_extrato, dias_saldo_diferente: q.dias_saldo_diferente,
      movimento_baixo: q.movimento_baixo, diferenca_saldo: reais(q.diferenca_saldo), saldo_sistema: reais(q.saldo_sistema), saldo_banco: reais(q.saldo_banco), data_saldo: q.data_saldo,
      dias_nao_conciliados: diasPendentes.size,
    },
    totais: {
      itens_banco: dados.banco.filter((b) => noPeriodo(b.data)).length, lancamentos: dados.sistema.filter((s) => noPeriodo(s.data)).length,
      desconsiderados: dados.banco.filter((b) => b.desconsiderado && noPeriodo(b.data)).length, casados: contagem,
      banco_sem_lancamento: soBanco.length, lancamento_sem_banco: soSistema.length, valor_diferente: valorDif.length, data_diferente: dataDif.length,
      divergencias: divergencias.length, aguardando_extrato: aguardando,
    },
    banco_sem_lancamento: corta(soBanco.map((b) => Object.assign(itemTela(b), { categoria: C.categoria(b.descricao) }))),
    lancamento_sem_banco: corta(soSistema.map(itemTela)),
    valor_diferente: corta(valorDif), data_diferente: corta(dataDif), divergencias: corta(divergencias),
    _casamento: r,
  };
}

// Histórico para sugerir regras: cada item do banco com o que aconteceu com ele.
function historicoDe(r) {
  const out = [];
  r.pares.forEach((p) => {
    const desc = p.sistema.length === 1 ? p.sistema[0].descricao : (p.tipo === 'rendimento' ? 'Rendimento ou IRRF pelo total do mês' : '');
    p.banco.forEach((b) => out.push({ descricao: b.descricao, valor: b.valor, data: b.data, situacao: 'com_lancamento', descricao_sistema: desc }));
  });
  r.soBanco.forEach((b) => out.push({ descricao: b.descricao, valor: b.valor, data: b.data, situacao: 'sem_lancamento' }));
  const desc = (b) => out.push({ descricao: b.descricao, valor: b.valor, data: b.data, situacao: 'desconsiderado' });
  r.divergencias.forEach((d) => {
    if (d.banco && d.banco.descricao) desc(d.banco);
    (d.bancos || []).forEach(desc);
  });
  (r.desconsideradosLivres || []).forEach(desc);
  return out;
}

// ── serviço com estado (fila e caches) ────────────────────────────────────
// opcoes: { cliente: () => cliente do Superlógica, hoje?: () => 'AAAA-MM-DD' }
function criarConciliacao(opcoes) {
  const fila = criarFila(SIMULTANEAS);
  const hoje = opcoes.hoje || hojeSP;
  const cache = criarCache(TTL, 2000);
  const cli = () => opcoes.cliente();

  const contasDe = (id) => cache.pegar('contas|' + id, () => lerContas(cli(), fila, id));
  const contasTodas = () => cache.pegar('contas|-1', () => lerContas(cli(), fila, -1));
  const nomes = () => cache.pegar('nomes', () => lerNomes(cli(), fila));
  const naFilaBaixa = new Map(); // chave -> promover() das leituras do quadro que ainda esperam
  const extratoMes = (idCond, idConta, mes, forcar, baixa) => {
    const dia = hoje();
    const k = ['ext', idCond, idConta, mes, dia].join('|');
    if (!baixa && naFilaBaixa.has(k)) naFilaBaixa.get(k)(); // a tela do condomínio não espera o quadro inteiro
    return cache.pegar(k, () => {
      const p = lerExtratoMes(cli(), fila, idCond, idConta, mes, dia, baixa, baixa ? (prom) => naFilaBaixa.set(k, prom) : null);
      return p.finally(() => naFilaBaixa.delete(k));
    }, forcar);
  };
  const extrato = async (idCond, idConta, ini, fim, forcar, baixa) => {
    const meses = mesesDoPeriodo(ini, fim > hoje() ? hoje() : fim);
    return juntarMeses(await Promise.all(meses.map((m) => extratoMes(idCond, idConta, m, forcar, baixa))), ini, fim);
  };

  // Uma conta: lê o período com margem, analisa e resume. Falha da conta não derruba as outras.
  async function contaNoPeriodo(idCond, conta, ini, fim, dia, forcar, baixa) {
    const base = { id: conta.id, descricao: conta.descricao, banco: conta.banco, principal: conta.principal, tipo: conta.tipo, bloqueio: C.bloqueio(conta.bloqueio, dia) };
    if (conta.sem_extrato_esperado) return Object.assign(base, { situacao: 'conta_caixa' });
    let dados;
    try { dados = await extrato(idCond, conta.id, C.maisDias(ini, -MARGEM_DIAS), C.maisDias(fim, MARGEM_DIAS) > dia ? dia : C.maisDias(fim, MARGEM_DIAS), forcar, baixa); } catch (e) {
      return Object.assign(base, { situacao: 'falha', detalhe: 'Não foi possível ler o extrato desta conta agora.' });
    }
    if (dados.descartada) return Object.assign(base, { situacao: 'descartada', detalhe: 'O Superlógica devolveu linhas de outra conta; a leitura foi descartada.' });
    if (!dados.banco.length && !dados.sistema.length) return Object.assign(base, { situacao: 'sem_extrato' });
    const a = analisarConta(dados, ini, fim, dia);
    delete a._casamento;
    return Object.assign(base, { situacao: a.quadro.ultimo_extrato ? 'ok' : 'sem_extrato' }, a);
  }

  // Detalhe de um condomínio num mês: todas as contas.
  async function condominio(idCond, comp, forcar) {
    const c = competencia(comp);
    if (!c) { const e = new Error('competencia_invalida'); e.codigo = 'competencia'; throw e; }
    const dia = hoje();
    if (c.inicio > dia) { const e = new Error('competencia_futura'); e.codigo = 'competencia'; throw e; }
    const fim = c.fim > dia ? dia : c.fim;
    const contas = await contasDe(String(idCond));
    const lista = await Promise.all(contas.map((k) => contaNoPeriodo(String(idCond), k, c.inicio, fim, dia, forcar)));
    const nm = await nomes().catch(() => new Map());
    return { condominio: String(idCond), nome: nm.get(String(idCond)) || '', competencia: c.rotulo, inicio: c.inicio, fim, gerado_em: new Date().toISOString(), contas: lista };
  }

  // Itens de uma conta (para comparar o OFX na tela): extrato importado e lançamentos do período.
  async function itensConta(idCond, idConta, ini, fim) {
    const contas = await contasDe(String(idCond));
    const conta = contas.find((k) => k.id === String(idConta));
    if (!conta) { const e = new Error('conta_nao_encontrada'); e.codigo = 'conta_nao_encontrada'; throw e; }
    const dia = hoje();
    const f = fim > dia ? dia : fim;
    const dados = await extrato(String(idCond), conta.id, C.maisDias(ini, -MARGEM_DIAS), C.maisDias(f, MARGEM_DIAS) > dia ? dia : C.maisDias(f, MARGEM_DIAS));
    if (dados.descartada) { const e = new Error('leitura_descartada'); e.status = 502; throw e; }
    return { conta: { id: conta.id, descricao: conta.descricao, banco: conta.banco }, inicio: ini, fim: f, banco: dados.banco, sistema: dados.sistema };
  }

  // Sugestões de regra pelo histórico dos 3 meses fechados anteriores, todas as contas.
  async function regras(idCond, forcar) {
    const dia = hoje();
    const meses = mesesAnteriores(dia, MESES_REGRAS);
    const ini = meses[0].inicio, fim = meses[meses.length - 1].fim;
    const contas = (await contasDe(String(idCond))).filter((k) => !k.sem_extrato_esperado);
    const hist = [];
    const porConta = [];
    await Promise.all(contas.map(async (k) => {
      try {
        const dados = await extrato(String(idCond), k.id, ini, fim, forcar);
        if (dados.descartada || !dados.banco.length) return;
        const a = analisarConta(dados, ini, fim, dia);
        const h = historicoDe(a._casamento).filter((x) => x.data >= ini && x.data <= fim);
        h.forEach((x) => hist.push(x));
        porConta.push({ id: k.id, descricao: k.descricao, itens: h.length });
      } catch (e) { porConta.push({ id: k.id, descricao: k.descricao, falha: true }); }
    }));
    const sug = C.sugerirRegras(hist).map((s) => Object.assign({}, s, { valor_min: reais(s.valor_min), valor_max: reais(s.valor_max), valor_tipico: reais(s.valor_tipico) }));
    return { condominio: String(idCond), periodo: { inicio: ini, fim }, contas: porConta, itens_analisados: hist.length, sugestoes: sug, gerado_em: new Date().toISOString() };
  }

  // Quadro de vários condomínios: últimos 75 dias de cada conta com extrato.
  async function quadro(ids, forcar) {
    const lista = [...new Set((ids || []).map(String))].filter((x) => /^\d+$/.test(x) && !NAO_CONDOMINIOS.has(x));
    if (lista.length > MAX_CONDOMINIOS_QUADRO) { const e = new Error('muitos_condominios'); e.codigo = 'muitos_condominios'; throw e; }
    const dia = hoje();
    const ini = C.maisDias(dia, -DIAS_QUADRO);
    const [todas, nm] = await Promise.all([contasTodas(), nomes().catch(() => new Map())]);
    const porCond = new Map();
    todas.forEach((k) => { if (!porCond.has(k.id_condominio)) porCond.set(k.id_condominio, []); porCond.get(k.id_condominio).push(k); });
    // Fora: cadastros que não são condomínio e, quando a lista de nomes veio, os inativos no Superlógica.
    const validos = lista.filter((id) => nm.get(id) !== null && (!nm.size || nm.has(id)));
    const linhas = await Promise.all(validos.map(async (id) => {
      const contas = porCond.get(id) || [];
      const res = await Promise.all(contas.map((k) => contaNoPeriodo(id, k, ini, dia, dia, forcar, true)));
      const resumo = res.map((r) => ({
        id: r.id, descricao: r.descricao, banco: r.banco, principal: r.principal, situacao: r.situacao, bloqueio: r.bloqueio,
        quadro: r.quadro || null, pendencias: r.totais ? (r.totais.banco_sem_lancamento + r.totais.lancamento_sem_banco + r.totais.valor_diferente + r.totais.divergencias) : 0,
      }));
      const comExtrato = resumo.filter((r) => r.situacao === 'ok');
      // Conta de pouco movimento (fundo, poupança, capital) não entra no maior atraso: o último item
      // pode ser antigo sem faltar extrato (revisão 1, M3). Sem nenhuma conta movimentada, vale o de todas.
      const movimentadas = comExtrato.filter((r) => r.principal || !r.quadro.movimento_baixo);
      const pior = (movimentadas.length ? movimentadas : comExtrato).reduce((m, r) => Math.max(m, r.quadro.dias_sem_extrato || 0), 0);
      return {
        id_condominio: id, condominio: nm.get(id) || '', contas: resumo,
        contas_com_extrato: comExtrato.length,
        contas_sem_extrato: resumo.filter((r) => r.situacao === 'sem_extrato').length,
        maior_atraso_extrato: comExtrato.length ? pior : null,
        dias_nao_conciliados: comExtrato.reduce((s, r) => s + (r.quadro.dias_nao_conciliados || 0), 0),
        contas_com_diferenca: comExtrato.filter((r) => r.quadro.diferenca_saldo).length,
        contas_sem_bloqueio: resumo.filter((r) => r.situacao !== 'conta_caixa' && r.bloqueio && r.bloqueio.sem_bloqueio).length,
        pendencias: resumo.reduce((s, r) => s + r.pendencias, 0),
        falhas: resumo.filter((r) => r.situacao === 'falha' || r.situacao === 'descartada').length,
      };
    }));
    linhas.sort((a, b) => (b.maior_atraso_extrato || 0) - (a.maior_atraso_extrato || 0) || b.pendencias - a.pendencias || a.condominio.localeCompare(b.condominio));
    return { gerado_em: new Date().toISOString(), periodo: { inicio: ini, fim: dia }, condominios: linhas, fora_da_lista: lista.length - validos.length };
  }

  // Quadro demorado: a rota espera até 20 s e depois responde "calculando" (a tela tenta de novo).
  const trabalhos = new Map();
  let forcadoRodando = false;
  function quadroComEspera(ids, forcar, esperaMs) {
    const chave = [...new Set((ids || []).map(String))].sort().join(',');
    let t = trabalhos.get(chave);
    // Atualizar (forcar): no máximo a cada 5 minutos para o mesmo conjunto e um quadro forçado por vez.
    const podeForcar = forcar && !forcadoRodando && t && t.fim && Date.now() - t.fim > 5 * 60 * 1000;
    const errou = t && t.erro && Date.now() - t.fim > 60000; // falhou: tenta de novo depois de 1 minuto
    if (!t || (t.fim && Date.now() - t.fim > TTL) || podeForcar || errou) {
      if (podeForcar) forcadoRodando = true;
      const p = quadro(ids, !!podeForcar);
      if (podeForcar) p.finally(() => { forcadoRodando = false; }).catch(() => {});
      t = { p, fim: 0, erro: null, valor: null };
      t.p.then((v) => { t.valor = v; t.fim = Date.now(); }, (e) => { t.erro = e; t.fim = Date.now(); });
      t.p.catch(() => {});
      trabalhos.set(chave, t);
      if (trabalhos.size > 50) trabalhos.delete(trabalhos.keys().next().value);
    }
    if (t.erro) return Promise.reject(t.erro);
    if (t.valor) return Promise.resolve(t.valor);
    return Promise.race([t.p, new Promise((ok) => setTimeout(() => ok(null), esperaMs == null ? 20000 : esperaMs))]);
  }

  return { condominio, itensConta, regras, quadro, quadroComEspera };
}

module.exports = {
  criarConciliacao, competencia, normalizarConciliacao, mesesDoPeriodo, juntarMeses, analisarConta, historicoDe, enxugarConta, contaSemExtrato, mesesAnteriores,
  NAO_CONDOMINIOS, MAX_CONDOMINIOS_QUADRO, C, _criarFila: criarFila,
};
