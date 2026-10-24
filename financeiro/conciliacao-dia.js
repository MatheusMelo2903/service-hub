'use strict';
// Conciliação do dia: o que o Hub faz sozinho todo dia útil e o que deixa para a pessoa conferir.
//   1. Entrada do extrato: OFX enviado na tela (várias contas de uma vez, a conta é reconhecida pelo
//      banco, agência e conta do arquivo) ou, com o conector do Sicoob ligado, puxado do banco.
//      O Hub planeja a importação só dos dias novos (nunca o período que já está no Superlógica).
//   2. Conciliação por regras (financeiro/conciliacao-auto.js) para cada condomínio: casa o que já
//      está lançado, prepara os lançamentos de regra fixa e monta a fila "para conferir".
//   3. Gravação no Superlógica (financeiro/conciliacao-gravar.js) só depois da política única de
//      gravação autorizar: extratos primeiro, depois os lançamentos, cada item uma vez só.
//   4. Aviso diário por condomínio e analista: conta sem extrato importado desde X e linhas sem conciliar.
// Leitura no Superlógica com no máximo 2 chamadas ao mesmo tempo. Número de conta e agência ficam
// só na memória deste processo.
const crypto = require('crypto');
const A = require('./conciliacao-auto');
const G = require('./conciliacao-gravar');
const finConciliacao = require('./conciliacao');
const avisosT39 = require('./avisos');
const banco = require('./banco/index');
const C = A.C;

const MAX_ARQUIVOS = 20;
const MAX_DIAS_ARQUIVO = 62;
const TTL_CONTAS = 10 * 60 * 1000;
const DIAS_DESPESAS_ANTES = 100;   // histórico para aprender regras e casar despesas
const DIAS_DESPESAS_DEPOIS = 35;
const MAX_PAGINAS_DESPESAS = 40;
const GRAVANDO_VELHO_MS = 15 * 60 * 1000;

const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 160);
const sl = (iso) => iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4);
function hojeSP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const primeiroDiaMesAnterior = (hoje) => { let a = +hoje.slice(0, 4), m = +hoje.slice(5, 7) - 1; if (!m) { m = 12; a--; } return a + '-' + String(m).padStart(2, '0') + '-01'; };
const erro = (codigo, detalhe) => { const e = new Error(codigo); e.codigo = codigo; if (detalhe) e.detalhe = detalhe; return e; };

// o: { cliente: () => cliente GET do Superlógica, cred: () => credenciais, armazem, politica?, auditar?,
//      grupos?: () => carteiras, env?, hoje?, log?, gravador? (testes), sicoob? (testes) }
function criarConciliacaoDia(o) {
  const env = o.env || {};
  const hoje = o.hoje || hojeSP;
  const log = o.log || (() => {});
  const arm = o.armazem;
  const filaSL = finConciliacao._criarFila(2);
  const cli = { get: (a, p) => filaSL(() => o.cliente().get(a, p)) };
  const grav = o.gravador || G.criarGravador({ cred: o.cred, cliente: () => cli });
  const opcoes = () => ({ movimentacaoDireta: env.CONC_MOVIMENTACAO_DIRETA === '1', contaRendimento: /^\d+(\.\d+)+$/.test(String(env.CONC_CONTA_RENDIMENTO || '')) ? String(env.CONC_CONTA_RENDIMENTO) : null });
  let contasCache = null;
  const despesasCache = new Map();
  const travas = new Map();       // condomínio -> trabalho em andamento
  const trabalhos = new Map();    // id -> estado do trabalho (para a tela)

  // ── contas ──────────────────────────────────────────────────────────────
  async function contasTodas(forcar) {
    if (!forcar && contasCache && contasCache.ate > Date.now()) return contasCache.p;
    const p = cli.get('contabancos/index', { idCondominio: -1, exibirDadosAgencia: 1, exibirContasAtivas: 1, semContaDigital: 0 }).then((j) => {
      const l = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : null);
      if (!l) throw erro('resposta_invalida');
      return l.filter((c) => c && !c.dt_datafechamento_cb).map(A.contaInterna).filter((c) => /^\d+$/.test(c.id) && /^\d+$/.test(c.id_condominio) && !A.NAO_CONDOMINIOS.has(c.id_condominio));
    });
    contasCache = { p, ate: Date.now() + TTL_CONTAS };
    p.catch(() => { contasCache = null; });
    return p;
  }
  const comExtrato = (c) => !finConciliacao.contaSemExtrato({ id_tipocontabanco_tcb: c.tipo, st_nome_banc: c.banco });
  async function contasDe(idCond, forcar) { return (await contasTodas(forcar)).filter((c) => c.id_condominio === String(idCond)); }
  const contaTela = (c) => ({ id: c.id, id_condominio: c.id_condominio, descricao: c.descricao, banco: c.banco, final: A.finalConta(c.numero), principal: c.principal });

  // ── 1. entrada do extrato ───────────────────────────────────────────────
  // Planeja a importação de uma conta a partir das linhas (do arquivo ou do banco).
  async function planejar(conta, itens, origem, extra, usuario) {
    const dia = hoje();
    const datas = itens.map((x) => x.data).sort();
    if (!datas.length) return { situacao: 'vazio' };
    if (C.dias(datas[0], datas[datas.length - 1]) > MAX_DIAS_ARQUIVO) return { situacao: 'periodo_grande' };
    const ini = C.maisDias(datas[0], -5);
    const lido = await grav.lerExtrato(conta.id_condominio, conta.id, ini, dia);
    if (lido.descartada) return { situacao: 'leitura_descartada' };
    const hub = await arm.importacoes.listar({ id_conta: conta.id, status: ['gravando', 'gravada', 'incerta'] });
    const ultimoHub = hub.reduce((m, x) => (x.fim > m ? x.fim : m), '') || null;
    const plano = A.planejarImportacao({ itens, importados: lido.banco, ultimoHub, hoje: dia, idConta: conta.id });
    let idImportacao = null;
    if (plano.importar.length) {
      await arm.importacoes.cancelarPlanejadas(conta.id);
      const imp = await arm.importacoes.criar({
        id_condominio: Number(conta.id_condominio), id_conta: Number(conta.id), inicio: plano.inicio, fim: plano.fim, quantidade: plano.importar.length,
        itens: plano.importar.map((x) => ({ data: x.data, valor: x.valor, fitid: x.fitid, descricao: txt(x.descricao, 120), numero: txt(x.numero, 30) })),
        origem, arquivo_hash: extra.hash || null, status: 'planejada',
        detalhe: { arquivo: txt(extra.nome, 120), ja_importados: plano.ja_importados.length, faltando_no_superlogica: plano.faltando_no_superlogica.length, dias_abertos: plano.dias_abertos.length, repetidos: plano.repetidos.length, corte: plano.corte },
        criado_por: usuario && usuario.id ? usuario.id : null, criado_por_email: usuario && usuario.email ? usuario.email : null,
      });
      idImportacao = imp && imp.id;
    }
    // Linha do banco num dia que já está importado e que o Superlógica não tem: vai para a fila
    // (importar de novo sobreporia o período).
    if (plano.faltando_no_superlogica.length) {
      const agora = new Date().toISOString();
      const linhas = plano.faltando_no_superlogica.map((x) => ({
        chave: 'a' + A.chaveLinha(conta.id_condominio, conta.id, x).slice(1), id_condominio: Number(conta.id_condominio), id_conta: Number(conta.id), conta: conta.descricao,
        data: x.data, valor_centavos: x.valor, descricao: txt(x.descricao, 120), tipo: 'faltando_no_superlogica',
        motivo: 'Linha do banco num dia que já está importado no Superlógica, mas a linha não está lá. O Hub não importa de novo para não sobrepor o período.',
        sugestao: { acao: 'conferir', texto: 'Conferir o extrato importado desse dia no Superlógica (pode ter sido importado incompleto) e marcar como conferido.', pode_aceitar: true },
        status: 'pendente', visto_em: agora,
      }));
      await arm.fila.inserirNovas(linhas);
    }
    return {
      situacao: plano.importar.length ? 'planejada' : 'nada_novo', id_importacao: idImportacao,
      a_importar: plano.importar.length, inicio: plano.inicio, fim: plano.fim, ja_importados: plano.ja_importados.length,
      faltando_no_superlogica: plano.faltando_no_superlogica.length, dias_abertos: plano.dias_abertos.length, repetidos: plano.repetidos.length,
      ultimo_superlogica: plano.ultimo_superlogica, ultimo_hub: plano.ultimo_hub,
    };
  }

  // arquivos: [{ nome, texto }]; escopo: Set de condomínios que a pessoa vê (null = todos).
  async function receberOfx(arquivos, escopo, usuario) {
    if (!Array.isArray(arquivos) || !arquivos.length) throw erro('sem_arquivo');
    if (arquivos.length > MAX_ARQUIVOS) throw erro('muitos_arquivos');
    const contas = (await contasTodas()).filter((c) => comExtrato(c) && (!escopo || escopo.has(c.id_condominio)));
    const out = [];
    for (const a of arquivos) {
      const nome = txt(a && a.nome, 120) || 'arquivo';
      const base = { arquivo: nome };
      let ofx;
      try { ofx = C.lerOfx(String((a && a.texto) || '')); } catch (e) { out.push(Object.assign(base, { situacao: 'arquivo_invalido', detalhe: e.detalhe || 'O arquivo não parece um extrato OFX.' })); continue; }
      if (!ofx.itens.length) { out.push(Object.assign(base, { situacao: 'vazio', detalhe: 'O arquivo não tem movimentos.' })); continue; }
      const id = A.identificarConta(ofx, contas);
      if (id.situacao !== 'identificada') {
        out.push(Object.assign(base, { situacao: id.situacao, final_arquivo: A.finalConta(ofx.conta),
          detalhe: id.situacao === 'ambigua' ? 'Mais de uma conta da sua carteira tem esse número. Envie pela tela da conta.' : 'Nenhuma conta da sua carteira tem o banco, a agência e a conta deste arquivo.' }));
        continue;
      }
      try {
        const hash = crypto.createHash('sha256').update(String(a.texto)).digest('hex');
        const r = await planejar(id.conta, ofx.itens, 'ofx', { hash, nome }, usuario);
        out.push(Object.assign(base, { conta: contaTela(id.conta) }, r, r.situacao === 'periodo_grande' ? { detalhe: 'O arquivo tem mais de 62 dias. Baixe um período menor.' } : {}));
      } catch (e) {
        log('[conciliacao-dia] arquivo falhou: ' + (e && (e.codigo || e.message)));
        out.push(Object.assign(base, { conta: contaTela(id.conta), situacao: 'falha', detalhe: 'Não foi possível ler o extrato dessa conta no Superlógica agora.' }));
      }
    }
    return out;
  }

  // Conector do Sicoob (financeiro/banco/sicoob.js): desligado até ter as credenciais.
  function clienteBanco() { return o.sicoob || banco.sicoob.criarClienteSicoob({ env, log }); }
  function statusBanco() { try { return { ligado: !!clienteBanco().ligado }; } catch (e) { return { ligado: false }; } }
  async function puxarBanco(ids, usuario) {
    const sic = clienteBanco();
    if (!sic.ligado) return { ligado: false, contas: [] };
    const dia = hoje();
    const meses = [{ mes: +dia.slice(5, 7), ano: +dia.slice(0, 4), diaFinal: +dia.slice(8, 10) }];
    if (+dia.slice(8, 10) <= 7) { const ini = primeiroDiaMesAnterior(dia); meses.unshift({ mes: +ini.slice(5, 7), ano: +ini.slice(0, 4) }); }
    const alvo = new Set([].concat(ids || []).map(String));
    const contas = (await contasTodas()).filter((c) => c.codigo === '756' && comExtrato(c) && c.numero && alvo.has(c.id_condominio));
    const out = [];
    for (const c of contas) {
      try {
        const itens = [];
        for (const m of meses) {
          const p = { mes: m.mes, ano: m.ano, conta: c.numero };
          if (m.diaFinal) p.diaFinal = m.diaFinal;
          const resp = c.tipo === '8' ? await sic.poupancaExtrato(p) : await sic.extrato(p);
          banco.extrato.paraItensT35(banco.extrato.normalizarExtratoSicoob(resp)).forEach((x) => itens.push(x));
        }
        out.push(Object.assign({ conta: contaTela(c) }, await planejar(c, itens, 'banco', { nome: 'Sicoob' }, usuario)));
      } catch (e) {
        out.push({ conta: contaTela(c), situacao: 'falha', detalhe: e && /extrato_nao_fecha|extrato_sem_conferencia/.test(e.message) ? 'O extrato do banco não fecha com o saldo; nada foi planejado.' : 'Não foi possível ler o extrato no banco agora.' });
      }
    }
    return { ligado: true, contas: out };
  }

  // ── 2. conciliação por regras ───────────────────────────────────────────
  async function despesasJanela(idCond, forcar) {
    const dia = hoje();
    const k = idCond + '|' + dia;
    const c = despesasCache.get(k);
    if (c && !forcar && c.ate > Date.now()) return c.l;
    const out = [];
    for (let pg = 1; pg <= MAX_PAGINAS_DESPESAS; pg++) {
      const j = await cli.get('despesas/index', { idCondominio: idCond, comStatus: 'todas', dtInicio: sl(C.maisDias(dia, -DIAS_DESPESAS_ANTES)), dtFim: sl(C.maisDias(dia, DIAS_DESPESAS_DEPOIS)), itensPorPagina: 50, pagina: pg });
      if (!Array.isArray(j) || !j.length) break;
      j.forEach((d) => { if (!d.id_condominio_cond || String(d.id_condominio_cond) === String(idCond)) out.push(d); });
      if (j.length < 50) break;
    }
    despesasCache.set(k, { l: out, ate: Date.now() + 30 * 60 * 1000 });
    if (despesasCache.size > 300) despesasCache.delete(despesasCache.keys().next().value);
    return out;
  }

  // Importação incerta: relê; se todas as linhas estão no Superlógica, vira gravada.
  async function reconferirIncertas(idCond, contas) {
    const inc = await arm.importacoes.listar({ id_condominio: idCond, status: ['incerta'] });
    for (const imp of inc) {
      if (!contas.some((c) => c.id === String(imp.id_conta))) continue;
      try {
        const lido = await grav.lerExtrato(String(idCond), String(imp.id_conta), imp.inicio, imp.fim);
        if (!lido.descartada && A.faltandoNaReleitura(imp.itens, lido.banco).length === 0) {
          await arm.importacoes.trocar(imp.id, ['incerta'], { status: 'gravada', detalhe: Object.assign({}, imp.detalhe, { reconferida_em: new Date().toISOString() }) });
        }
      } catch (e) { /* fica incerta */ }
    }
  }

  async function conciliar(idCond, quem) {
    const id = String(idCond);
    if (!/^[1-9]\d{0,8}$/.test(id) || A.NAO_CONDOMINIOS.has(id)) throw erro('nao_condominio');
    const dia = hoje();
    const inicio = primeiroDiaMesAnterior(dia);
    const contas = (await contasDe(id)).filter(comExtrato);
    await reconferirIncertas(id, contas);
    const planejadas = await arm.importacoes.listar({ id_condominio: id, status: ['planejada'] });
    const entrada = [];
    const quadro = [];
    for (const k of contas) {
      let dados;
      try { dados = await grav.lerExtrato(id, k.id, inicio, dia); } catch (e) { quadro.push({ id: k.id, descricao: k.descricao, banco: k.banco, principal: k.principal, situacao: 'falha' }); continue; }
      if (dados.descartada) { quadro.push({ id: k.id, descricao: k.descricao, banco: k.banco, principal: k.principal, situacao: 'descartada' }); continue; }
      const aImportar = [].concat(...planejadas.filter((p) => String(p.id_conta) === k.id).map((p) => p.itens.map((x) => Object.assign({}, x, { desconsiderado: false, a_importar: true }))));
      const linhasBanco = dados.banco.concat(aImportar);
      const q = C.quadroConta(dados.saldos, linhasBanco, dia, dados.sistema);
      quadro.push({ id: k.id, descricao: k.descricao, banco: k.banco, principal: k.principal, situacao: q.ultimo_extrato ? 'ok' : 'sem_extrato',
        quadro: { ultimo_extrato: q.ultimo_extrato, dias_sem_extrato: q.dias_sem_extrato, movimento_baixo: q.movimento_baixo } });
      entrada.push({ id: k.id, descricao: k.descricao, tipo: k.tipo, banco: linhasBanco, sistema: dados.sistema });
    }
    const despesas = await despesasJanela(id).catch(() => []);
    const regras = A.aprenderRegras(despesas);
    const regrasHub = await arm.regras.listar(id).catch(() => []);
    const r = A.conciliarCondominio({ id_condominio: id, hoje: dia, inicio, contas: entrada, despesas, regras, regrasHub, opcoes: opcoes() });
    // Linha que a pessoa já ignorou não vira lançamento automático.
    const decididas = await arm.fila.listar({ id_condominio: id, status: ['ignorado'] });
    const ignoradas = new Set(decididas.map((x) => x.chave));
    const autos = r.automaticas.filter((a) => !(a.linhas || []).some((l) => ignoradas.has(l)));
    await arm.lancamentos.inserirNovos(autos.map((a) => ({
      chave: a.chave, id_condominio: Number(id), tipo: a.tipo, origem: 'regra', regra: a.regra, valor_centavos: a.valor, status: 'planejado', criado_por_email: quem && quem.email ? quem.email : 'conciliação automática',
      dados: { id_conta: a.id_conta, id_conta_destino: a.id_conta_destino || null, data: a.data, conta_contabil: a.conta_contabil || null, id_fornecedor: a.id_fornecedor || null, fornecedor: a.fornecedor || '',
        forma_pag: a.forma_pag || null, complemento: a.complemento || '', descricao: a.descricao || '', sinal: a.sinal || -1, linhas: a.linhas || [] },
    })));
    const agora = new Date().toISOString();
    await arm.fila.inserirNovas(r.fila.map((f) => ({
      chave: f.chave, id_condominio: Number(id), id_conta: f.id_conta ? Number(f.id_conta) : null, conta: f.conta || '', data: f.data, valor_centavos: f.valor || 0,
      descricao: txt(f.descricao, 200), tipo: f.tipo, motivo: txt(f.motivo, 600), sugestao: f.sugestao, status: 'pendente', visto_em: agora,
    })));
    await arm.fila.marcarVistas(id, r.fila.map((f) => f.chave), agora);
    await arm.fila.resolverSumidas(id, agora);
    const nome = await nomeDe(id);
    const resumo = { conciliadas: r.conciliadas, automaticas: autos.length, fila: r.fila.length, aguardando_fim_do_mes: r.aguardando, contas: quadro, inicio };
    await arm.estado.salvar({ id_condominio: Number(id), condominio: nome, ultima_conciliacao: agora, resumo, atualizado_em: agora });
    return Object.assign({ id_condominio: id, condominio: nome, em: agora }, resumo);
  }
  // Nome fantasia dos condomínios ativos (cache de 1 hora).
  let nomesCache = null;
  async function nomes() {
    if (nomesCache && nomesCache.ate > Date.now()) return nomesCache.p;
    const p = (async () => {
      const m = new Map();
      for (let pg = 1; pg <= 10; pg++) {
        const j = await cli.get('condominios/get', { id: -1, somenteCondominiosAtivos: 1, itensPorPagina: 500, pagina: pg });
        const l = Array.isArray(j) ? j : [];
        l.forEach((c) => { const k = txt(c.id_condominio_cond, 12); if (k) m.set(k, txt(c.st_fantasia_cond || c.st_nome_cond, 100)); });
        if (l.length < 500) break;
      }
      return m;
    })();
    nomesCache = { p, ate: Date.now() + 3600 * 1000 };
    p.catch(() => { nomesCache = null; });
    return p;
  }
  async function nomeDe(id) {
    try { return (await nomes()).get(String(id)) || ''; } catch (e) { return ''; }
  }
  // Carteiras do Superlógica: nome da carteira e analista (gerente) de cada condomínio.
  let gruposCache = null;
  async function gruposDe() {
    if (gruposCache && gruposCache.ate > Date.now()) return gruposCache.v;
    const l = o.grupos ? await o.grupos() : [];
    const porCond = new Map();
    (l || []).forEach((g) => (g.condominios || []).forEach((c) => {
      const k = String(c);
      if (!porCond.has(k)) porCond.set(k, []);
      porCond.get(k).push({ carteira: txt(g.nome, 80), analista: txt(g.gerente, 80) });
    }));
    const v = { porCond };
    gruposCache = { v, ate: Date.now() + 30 * 60 * 1000 };
    return v;
  }

  // ── fila: aceitar, corrigir, ignorar ────────────────────────────────────
  // dados: { acao, conta_contabil?, id_fornecedor?, id_conta_destino?, lembrar?, motivo? }
  // validarFornecedor(id) -> { id, nome } | null (lê o Superlógica).
  async function decidir(chave, dados, usuario, validarFornecedor) {
    const item = await arm.fila.pegar(String(chave || ''));
    if (!item) throw erro('item_nao_encontrado');
    if (item.status !== 'pendente') throw erro('ja_decidido');
    const sug = item.sugestao || {};
    const marca = { decidido_por: usuario && usuario.id ? usuario.id : null, decidido_por_email: usuario && usuario.email ? usuario.email : null, decidido_em: new Date().toISOString() };
    const acao = String(dados && dados.acao || '');
    const padrao = C.normDesc(item.descricao);
    const sinal = Number(item.valor_centavos) < 0 ? -1 : 1;
    if (acao === 'ignorar') {
      const ok = await arm.fila.trocar(item.chave, ['pendente'], Object.assign({ status: 'ignorado', decisao: { acao, motivo: txt(dados.motivo, 200), lembrar: !!dados.lembrar } }, marca));
      if (!ok) throw erro('ja_decidido');
      if (dados.lembrar && padrao.length >= 3) await arm.regras.salvar({ id_condominio: Number(item.id_condominio), padrao, sinal, acao: 'ignorar', ativo: true, criado_por: marca.decidido_por, criado_por_email: marca.decidido_por_email });
      return { status: 'ignorado' };
    }
    if (acao === 'aceitar') {
      if (!sug.pode_aceitar) throw erro('precisa_corrigir');
      const ok = await arm.fila.trocar(item.chave, ['pendente'], Object.assign({ status: 'conferido', decisao: { acao } }, marca));
      if (!ok) throw erro('ja_decidido');
      return { status: 'conferido' };
    }
    if (acao !== 'corrigir') throw erro('acao_invalida');
    if (!item.data || !item.valor_centavos || !item.id_conta) throw erro('nao_corrigivel');
    const valor = Math.abs(Number(item.valor_centavos));
    let lanc;
    if (dados.tipo === 'despesa') {
      if (sinal > 0) throw erro('nao_corrigivel');
      const conta = String(dados.conta_contabil || '').trim();
      const forn = String(dados.id_fornecedor || '').trim();
      if (!/^2(\.\d{1,4}){1,5}$/.test(conta)) throw erro('conta_contabil_invalida');
      if (!/^[1-9]\d{0,9}$/.test(forn)) throw erro('fornecedor_invalido');
      const f = validarFornecedor ? await validarFornecedor(forn) : { id: forn, nome: '' };
      if (!f) throw erro('fornecedor_nao_encontrado');
      lanc = { tipo: 'despesa', dados: { id_conta: String(item.id_conta), data: item.data, conta_contabil: conta, id_fornecedor: forn, fornecedor: txt(f.nome, 80), forma_pag: '7', complemento: txt(item.descricao, 60), descricao: txt(item.descricao, 120), linhas: [item.chave] } };
      if (dados.lembrar && padrao.length >= 3) await arm.regras.salvar({ id_condominio: Number(item.id_condominio), padrao, sinal, acao: 'despesa', conta_contabil: conta, id_fornecedor: Number(forn), fornecedor: txt(f.nome, 80), forma_pag: 7, ativo: true, criado_por: marca.decidido_por, criado_por_email: marca.decidido_por_email });
    } else if (dados.tipo === 'transferencia') {
      const outra = String(dados.id_conta_destino || '');
      const contas = (await contasDe(item.id_condominio)).map((c) => c.id);
      if (!contas.includes(outra) || outra === String(item.id_conta)) throw erro('conta_destino_invalida');
      const [de, para] = sinal < 0 ? [String(item.id_conta), outra] : [outra, String(item.id_conta)];
      lanc = { tipo: 'transferencia', dados: { id_conta: de, id_conta_destino: para, data: item.data, complemento: 'Transferência entre contas', descricao: txt(item.descricao, 120), linhas: [item.chave] } };
    } else throw erro('acao_invalida');
    const ok = await arm.fila.trocar(item.chave, ['pendente'], Object.assign({ status: 'corrigido', decisao: Object.assign({ acao }, lanc.dados, { tipo: lanc.tipo }) }, marca));
    if (!ok) throw erro('ja_decidido');
    const chaveL = 'c' + item.chave.slice(1);
    await arm.lancamentos.inserirNovos([{ chave: chaveL, id_condominio: Number(item.id_condominio), tipo: lanc.tipo, origem: 'fila', regra: 'corrigido', valor_centavos: valor, status: 'planejado', dados: lanc.dados, criado_por_email: marca.decidido_por_email }]);
    return { status: 'corrigido', lancamento: chaveL };
  }

  // ── 3. gravação ─────────────────────────────────────────────────────────
  // O que está pronto para gravar no condomínio (para o resumo da confirmação e o hash do conteúdo).
  async function prepararGravacao(idCond) {
    const id = String(idCond);
    const [imps, lancs, contas] = await Promise.all([
      arm.importacoes.listar({ id_condominio: id, status: ['planejada'] }),
      arm.lancamentos.listar({ id_condominio: id, status: ['planejado'] }),
      contasDe(id),
    ]);
    const nomeConta = (c) => { const k = contas.find((x) => x.id === String(c)); return k ? k.descricao : 'conta ' + c; };
    // Ordem estável: por data e tipo (o resumo da confirmação e a gravação seguem a mesma lista).
    const permitidas = lancs.filter((l) => l.tipo !== 'movimentacao' || env.CONC_MOVIMENTACAO_DIRETA === '1')
      .sort((a, b) => String((a.dados && a.dados.data) || '').localeCompare(String((b.dados && b.dados.data) || '')) || a.tipo.localeCompare(b.tipo) || a.chave.localeCompare(b.chave));
    const importacoes = imps.map((x) => ({ id: x.id, id_conta: x.id_conta, conta: nomeConta(x.id_conta), inicio: x.inicio, fim: x.fim, quantidade: x.quantidade }));
    const lancamentos = permitidas.map((l) => ({ chave: l.chave, tipo: l.tipo, valor_centavos: Number(l.valor_centavos), data: l.dados && l.dados.data, conta: nomeConta(l.dados && l.dados.id_conta) }));
    return { id_condominio: id, importacoes, lancamentos, conteudo: { imp: importacoes.map((x) => [x.id, x.inicio, x.fim, x.quantidade]), lanc: lancamentos.map((x) => [x.chave, x.tipo, x.valor_centavos]) }, resumo: A.resumoGravacao(importacoes, lancamentos) };
  }

  // Grava o que foi preparado. aut: autorização da política (concluir registra na auditoria).
  // Cada item é "pego" trocando o status no banco do Hub antes de chamar o Superlógica: dois
  // pedidos nunca gravam o mesmo item, e item que ficou "gravando" (servidor caiu) nunca é repetido.
  async function executarGravacao(preparo, aut, ctx) {
    const id = preparo.id_condominio;
    if (travas.has(id)) throw erro('gravacao_em_andamento');
    const t = { id: crypto.randomBytes(8).toString('hex'), id_condominio: id, inicio: new Date().toISOString(), estado: 'rodando', total: preparo.importacoes.length + preparo.lancamentos.length, feitos: 0, itens: [], usuario: ctx && ctx.usuario ? ctx.usuario.id || null : null };
    travas.set(id, t);
    trabalhos.set(t.id, t);
    if (trabalhos.size > 200) trabalhos.delete(trabalhos.keys().next().value);
    const quem = ctx && ctx.usuario ? { gravado_por: ctx.usuario.id || null, gravado_por_email: ctx.usuario.email || null } : {};
    const anotar = (item) => { t.itens.push(item); t.feitos++; if (ctx && ctx.auditarItem) { try { ctx.auditarItem(item); } catch (e) { /* auditoria nunca para a gravação */ } } };
    const rodar = async () => {
      const contas = await contasDe(id, true);
      for (const p of preparo.importacoes) {
        let imp;
        try { imp = await arm.importacoes.trocar(p.id, ['planejada'], { status: 'gravando' }); } catch (e) {
          if (e.codigo === 'sobreposicao') {
            await arm.importacoes.trocar(p.id, ['planejada'], { status: 'falhou', detalhe: { motivo: 'sobreposicao' } }).catch(() => {});
            anotar({ tipo: 'extrato', id: p.id, conta: p.conta, status: 'falhou', msg: 'Esse período já foi importado pelo Hub. Nada foi enviado.' });
            continue;
          }
          throw e;
        }
        if (!imp) { anotar({ tipo: 'extrato', id: p.id, conta: p.conta, status: 'pulado', msg: 'Já não estava pronto para gravar.' }); continue; }
        const conta = contas.find((c) => c.id === String(imp.id_conta) && c.id_condominio === id);
        let r;
        try { r = conta ? await grav.importarExtrato({ id_condominio: id, id_conta: String(imp.id_conta), itens: imp.itens }, conta) : { status: 'falhou', msg: 'Conta não encontrada neste condomínio. Nada foi enviado.' }; } catch (e) {
          r = { status: 'falhou', msg: 'Nada foi enviado (' + (e.codigo || 'erro') + ').' };
        }
        const st = { gravado: 'gravada', incerto: 'incerta', recusado: 'recusada', falhou: 'falhou' }[r.status] || 'incerta';
        await arm.importacoes.trocar(imp.id, ['gravando'], Object.assign({ status: st, gravado_em: st === 'gravada' ? new Date().toISOString() : null, detalhe: Object.assign({}, imp.detalhe, { resultado: { status: r.status, conferido: !!r.conferido, msg: txt(r.msg, 200) } }) }));
        anotar({ tipo: 'extrato', id: imp.id, conta: p.conta, inicio: imp.inicio, fim: imp.fim, linhas: imp.quantidade, status: r.status, conferido: !!r.conferido, msg: txt(r.msg, 200) });
      }
      for (const p of preparo.lancamentos) {
        const l = await arm.lancamentos.trocar(p.chave, ['planejado'], Object.assign({ status: 'gravando' }, quem));
        if (!l) { anotar({ tipo: p.tipo, chave: p.chave, status: 'pulado', msg: 'Já não estava pronto para gravar.' }); continue; }
        const d = Object.assign({ id_condominio: id, valor: Number(l.valor_centavos) }, l.dados);
        let r;
        try {
          if (l.tipo === 'despesa') r = await grav.lancarDespesa(d);
          else if (l.tipo === 'transferencia') r = await grav.transferir(d, contas.filter((c) => c.id_condominio === id));
          else if (l.tipo === 'movimentacao' && env.CONC_MOVIMENTACAO_DIRETA === '1') r = await grav.movimentacao(d);
          else r = { status: 'falhou', msg: 'Movimentação direta desligada. Nada foi enviado.' };
        } catch (e) { r = { status: 'falhou', msg: 'Nada foi enviado (' + (e.codigo || 'erro') + ').' }; }
        await arm.lancamentos.trocar(l.chave, ['gravando'], { status: r.status === 'gravado' ? 'gravado' : r.status === 'recusado' ? 'recusado' : r.status === 'falhou' ? 'falhou' : 'incerto',
          gravado_em: r.status === 'gravado' ? new Date().toISOString() : null,
          resultado: { conferido: !!r.conferido, id_despesa: r.id_despesa || null, id_parcela: r.id_parcela || null, id_transferencia: r.id_transferencia || null, prova: r.prova || null, msg: txt(r.msg, 200) } });
        anotar({ tipo: l.tipo, chave: l.chave, valor_centavos: Number(l.valor_centavos), data: d.data, status: r.status, conferido: !!r.conferido, msg: txt(r.msg, 200), id_superlogica: r.id_despesa || r.id_transferencia || null });
      }
    };
    const fim = async (falhaGeral) => {
      const cont = (s) => t.itens.filter((x) => x.status === s).length;
      t.estado = falhaGeral ? 'erro' : 'concluido';
      t.fim = new Date().toISOString();
      t.totais = { gravados: cont('gravado'), incertos: cont('incerto'), recusados: cont('recusado'), falhas: cont('falhou'), pulados: cont('pulado') };
      travas.delete(id);
      try { if (aut && aut.concluir) aut.concluir({ ok: !falhaGeral && !t.totais.incertos && !t.totais.recusados && !t.totais.falhas, itens: t.total, totais: t.totais }); } catch (e) { /* auditoria */ }
      try { await arm.estado.salvar({ id_condominio: Number(id), ultima_gravacao: t.fim, gravacao: { totais: t.totais, origem: (ctx && ctx.origem) || 'tela' }, atualizado_em: t.fim }); } catch (e) { /* estado é só informativo */ }
      if (!falhaGeral && (ctx && ctx.reconciliar !== false)) conciliar(id, ctx && ctx.usuario).catch(() => {});
    };
    const p = rodar().then(() => fim(false), (e) => { log('[conciliacao-dia] gravação ' + id + ' parou: ' + (e && (e.codigo || e.message))); return fim(true); });
    t.promessa = p;
    return t;
  }
  function trabalho(idT) {
    const t = trabalhos.get(String(idT || ''));
    if (!t) return null;
    const { promessa, ...resto } = t; // eslint-disable-line no-unused-vars
    return resto;
  }

  // ── 4. avisos do dia ────────────────────────────────────────────────────
  // Mesma regra de "conta sem extrato" do card Seu dia (financeiro/avisos.js, contasSemExtrato),
  // com o quadro que a conciliação do dia já leu, mais as linhas sem conciliar da fila.
  async function gerarAvisos(ids) {
    const dia = hoje();
    const limite = avisosT39.limiteDias(env.CONC_DIAS_SEM_EXTRATO || env.AVISOS_DIAS_SEM_EXTRATO);
    const estados = await arm.estado.listar(ids ? [...ids].map(String) : null);
    const g = await gruposDe().catch(() => ({ porCond: new Map() }));
    const dono = (idc) => { const l = g.porCond.get(String(idc)) || []; return { carteira: [...new Set(l.map((x) => x.carteira).filter(Boolean))].join(', '), analista: [...new Set(l.map((x) => x.analista).filter(Boolean))].join(', ') }; };
    const linhasQuadro = estados.filter((e) => e.resumo && Array.isArray(e.resumo.contas)).map((e) => ({ id_condominio: String(e.id_condominio), condominio: e.condominio || '', contas: e.resumo.contas }));
    const { contas } = avisosT39.contasSemExtrato(linhasQuadro, limite);
    const out = [];
    for (const c of contas) {
      out.push(Object.assign({ dia, id_condominio: Number(c.id_condominio), tipo: 'sem_extrato', id_conta: Number(c.conta), condominio: c.condominio, gravidade: c.gravidade,
        titulo: c.ultimo_extrato ? 'Conta sem extrato importado desde ' + A.dataBR(c.ultimo_extrato) : 'Conta sem extrato importado no período lido',
        detalhe: [c.descricao, c.banco].filter(Boolean).join(', ') + (c.dias_uteis != null ? '. ' + c.dias_uteis + ' dia(s) útil(eis) sem extrato.' : '.'), desde: c.ultimo_extrato || null, quantidade: c.dias_uteis }, dono(c.id_condominio)));
    }
    const pend = await arm.fila.listar({ id_condominio: ids ? [...ids].map(String) : undefined, status: ['pendente'] });
    const porCond = new Map();
    pend.forEach((f) => { const k = String(f.id_condominio); if (!porCond.has(k)) porCond.set(k, []); porCond.get(k).push(f); });
    const nomeEstado = new Map(estados.map((e) => [String(e.id_condominio), e.condominio || '']));
    for (const [k, l] of porCond) {
      const desde = l.map((f) => f.data).filter(Boolean).sort()[0] || null;
      const atraso = desde ? C.diasUteisEntre(desde, dia) : 0;
      out.push(Object.assign({ dia, id_condominio: Number(k), tipo: 'sem_conciliar', id_conta: 0, condominio: nomeEstado.get(k) || '', gravidade: l.length >= 20 || atraso > 5 ? 'alta' : 'media',
        titulo: l.length + ' linha(s) sem conciliar' + (desde ? ' desde ' + A.dataBR(desde) : ''), detalhe: 'Fila para conferir da Conciliação do dia.', desde, quantidade: l.length }, dono(k)));
    }
    const velho = new Date(Date.now() - GRAVANDO_VELHO_MS).toISOString();
    const inc = (await arm.lancamentos.listar({ id_condominio: ids ? [...ids].map(String) : undefined, status: ['incerto', 'gravando'] })).filter((x) => x.status === 'incerto' || (x.atualizado_em || '') < velho);
    const impInc = await arm.importacoes.listar({ status: ['incerta'] });
    const incPor = new Map();
    inc.concat(impInc.filter((x) => !ids || ids.has(String(x.id_condominio)))).forEach((x) => { const k = String(x.id_condominio); incPor.set(k, (incPor.get(k) || 0) + 1); });
    for (const [k, n] of incPor) {
      out.push(Object.assign({ dia, id_condominio: Number(k), tipo: 'gravacao_incerta', id_conta: 0, condominio: nomeEstado.get(k) || '', gravidade: 'alta',
        titulo: n + ' gravação(ões) sem confirmação do Superlógica', detalhe: 'O Hub não repete sozinho. Confira no Superlógica e marque na Conciliação do dia.', desde: null, quantidade: n }, dono(k)));
    }
    await arm.avisos.gravarDia(dia, out);
    return { dia, avisos: out.length };
  }

  // ── rotina do dia (agendada) ────────────────────────────────────────────
  // Puxa do banco (se ligado), concilia cada condomínio, grava sozinho só onde a política deixa
  // gravar sem confirmação (condomínio de teste) e gera os avisos.
  async function rodarDia(p) {
    const politica = o.politica;
    const todos = [...new Set((await contasTodas(true)).map((c) => c.id_condominio))].sort((a, b) => a - b);
    const ids = p && p.ids ? todos.filter((x) => p.ids.includes(x)) : todos;
    const rel = { inicio: new Date().toISOString(), condominios: ids.length, conciliados: 0, falhas: 0, gravados: 0 };
    if (statusBanco().ligado) await puxarBanco(ids).catch((e) => log('[conciliacao-dia] banco: ' + (e && (e.codigo || e.message))));
    for (const id of ids) {
      try { await conciliar(id, { email: 'conciliação automática' }); rel.conciliados++; } catch (e) { rel.falhas++; log('[conciliacao-dia] ' + id + ': ' + (e && (e.codigo || e.message))); }
    }
    if (politica && env.CONC_GRAVAR_SOZINHO !== '0') {
      for (const id of ids) {
        if (politica.estado('conciliacao_gravar', id).estado !== 'livre') continue;
        try {
          const prep = await prepararGravacao(id);
          if (!prep.importacoes.length && !prep.lancamentos.length) continue;
          const req = reqAgendador();
          const aut = await politica.autorizar(req, resSemTela(), { operacao: 'conciliacao_gravar', id_condominio: id, conteudo: prep.conteudo, resumo: prep.resumo, quantidade: prep.resumo.quantidade });
          if (!aut || !aut.livre) continue;
          const t = await executarGravacao(prep, aut, { origem: 'agendado', auditarItem: (item) => o.auditar && o.auditar(req, 'conciliacao_gravacao_item', Object.assign({ id_superlogica: id }, item), item.status !== 'gravado') });
          await t.promessa;
          rel.gravados += t.totais ? t.totais.gravados : 0;
        } catch (e) { log('[conciliacao-dia] gravação automática ' + id + ': ' + (e && (e.codigo || e.message))); }
      }
    }
    await gerarAvisos(null).catch((e) => log('[conciliacao-dia] avisos: ' + (e && (e.codigo || e.message))));
    rel.fim = new Date().toISOString();
    return rel;
  }
  // Pedido "de mentira" da rotina agendada: aparece na auditoria do Hub como a conciliação automática.
  function reqAgendador() {
    return { authMode: 'agendado', user: { email: 'conciliacao.automatica@hub' }, headers: { 'user-agent': 'Conciliação automática do Hub' }, socket: {}, method: 'AGENDADO', originalUrl: '/agendado/conciliacao-dia', body: {} };
  }
  function resSemTela() {
    const r = { status() { return r; }, json() { return r; }, set() { return r; } };
    return r;
  }

  return { contasTodas, contasDe, contaTela, nomeDe, receberOfx, puxarBanco, statusBanco, conciliar, decidir, prepararGravacao, executarGravacao, trabalho, gerarAvisos, rodarDia, gruposDe, travas };
}

// Agendador: dias úteis, 7h40 em Brasília (depois dos avisos das 7h), uma vez por dia.
function criarAgendador({ executar, log, hora = 7, minuto = 40 }) {
  let ultimo = '';
  let rodando = false;
  async function verificar(agora) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(agora || new Date()).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
    const dia = p.year + '-' + p.month + '-' + p.day;
    if (['Sat', 'Sun'].includes(p.weekday) || rodando || ultimo === dia) return false;
    if (Number(p.hour) < hora || (Number(p.hour) === hora && Number(p.minute) < minuto) || Number(p.hour) >= 20) return false;
    ultimo = dia; rodando = true;
    try { const r = await executar(dia); if (log) log('[conciliacao-dia] rotina do dia: ' + JSON.stringify({ conciliados: r && r.conciliados, falhas: r && r.falhas, gravados: r && r.gravados })); } catch (e) { if (log) log('[conciliacao-dia] rotina falhou: ' + (e && (e.codigo || e.message))); } finally { rodando = false; }
    return true;
  }
  return { verificar, iniciar(ms) { const t = setInterval(() => { verificar().catch(() => {}); }, ms || 60000); if (t.unref) t.unref(); return t; } };
}

module.exports = { criarConciliacaoDia, criarAgendador, primeiroDiaMesAnterior };
