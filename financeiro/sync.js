'use strict';
// Sincronização do financeiro: copia do Superlógica (somente GET) para as tabelas fin_*.
// Janelas curtas por tipo (medidas na sonda T23); resposta que não é JSON (estouro de
// memória do Superlógica vem com HTTP 200 e HTML) quebra a janela ao meio até 1 dia e,
// se ainda falhar, pagina de 50 em 50. Cada janela vira uma linha em fin_sync_log.
const crypto = require('crypto');
const U = require('./util');
const M = require('./mapear');

const TIPOS = ['contas', 'despesas_liquidadas', 'despesas_pendentes', 'movimentos', 'cobrancas', 'auditoria'];
const NAO_CONDOMINIO = /\bVIRTUAL SERVICE\b/i;
const POR_CONDOMINIO = new Set(['cobrancas', 'movimentos']); // janelas por condomínio
const MAX_PAGINAS = 400;
const MAX_DIAS = 400;

function listaDe(j) {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.data)) return j.data;
  return null;
}

// Junta o período já sincronizado com o novo só quando eles se tocam ou se sobrepõem.
// Com buraco no meio, fica o período mais recente (para não dizer que o buraco foi copiado).
function juntarPeriodo(antDe, antAte, de, ate) {
  if (!antDe || !antAte) return { de, ate };
  const toca = de <= U.somaDias(antAte, 1) && ate >= U.somaDias(antDe, -1);
  if (toca) return { de: antDe < de ? antDe : de, ate: antAte > ate ? antAte : ate };
  return ate > antAte ? { de, ate } : { de: antDe, ate: antAte };
}

async function emParalelo(itens, n, fn) {
  let i = 0;
  async function trab() { while (i < itens.length) { const k = i++; await fn(itens[k], k); } }
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trab));
}

function criarSync({ cliente, banco, log = () => {}, origem = 'script', usuario = null }) {
  const execucao = crypto.randomUUID();
  const agora = () => new Date().toISOString();
  const resumo = { execucao, janelas_ok: 0, janelas_erro: 0, por_tipo: {}, erros: [] };
  const okPorTipo = {};   // tipo -> { total, ok, porCond: Map(cond -> {total, ok}) }

  async function buscar(caminho, params) {
    const j = await cliente.get(caminho, params);
    const l = listaDe(j);
    if (!l) {
      const e = new Error('resposta_nao_json');
      e.status = 200;
      throw e;
    }
    return l;
  }

  async function paginar(caminho, params, porPagina) {
    const out = [];
    for (let pg = 1; pg <= MAX_PAGINAS; pg++) {
      const l = await buscar(caminho, { ...params, itensPorPagina: porPagina, pagina: pg });
      out.push(...l);
      if (l.length < porPagina) return out;
    }
    throw new Error('paginas_demais');
  }

  // Busca uma janela; se o Superlógica não aguentar, divide ao meio até um dia e depois pagina.
  async function buscarJanela(caminho, base, ini, fim, porPagina) {
    try {
      return await buscar(caminho, { ...base, dtInicio: U.dataSL(ini), dtFim: U.dataSL(fim) });
    } catch (e) {
      if (e.status && e.status !== 200 && e.status < 500 && e.status !== 504) throw e;
      if (ini < fim) {
        const meio = U.somaDias(ini, Math.floor(U.diasEntre(ini, fim) / 2));
        log('  dividindo ' + caminho + ' ' + ini + ' a ' + fim + ' (' + e.message + ')');
        const a = await buscarJanela(caminho, base, ini, meio, porPagina);
        const b = await buscarJanela(caminho, base, U.somaDias(meio, 1), fim, porPagina);
        return a.concat(b);
      }
      log('  paginando ' + caminho + ' ' + ini + ' (' + e.message + ')');
      return paginar(caminho, { ...base, dtInicio: U.dataSL(ini), dtFim: U.dataSL(fim) }, porPagina);
    }
  }

  function contar(tipo, cond, ok) {
    const t = okPorTipo[tipo] || (okPorTipo[tipo] = { total: 0, ok: 0, porCond: new Map() });
    t.total++; if (ok) t.ok++;
    if (cond) {
      const c = t.porCond.get(cond) || { total: 0, ok: 0 };
      c.total++; if (ok) c.ok++;
      t.porCond.set(cond, c);
    }
  }

  // Roda uma janela, grava no log e nunca derruba a sincronização inteira.
  async function janela(tipo, ini, fim, cond, fn, pular) {
    const chave = [tipo, ini, fim, cond || ''].join('|');
    if (pular && pular.has(chave)) { contar(tipo, cond, true); return; }
    const t0 = Date.now();
    let itens = 0, gravados = 0, erro = null;
    try {
      const r = await fn();
      itens = r.itens; gravados = r.gravados;
    } catch (e) {
      erro = String((e && e.message) || e).slice(0, 300) + (e && e.detalhe ? ': ' + String(e.detalhe).slice(0, 300) : '');
    }
    const p = resumo.por_tipo[tipo] || (resumo.por_tipo[tipo] = { janelas: 0, erros: 0, itens: 0, gravados: 0 });
    p.janelas++; p.itens += itens; p.gravados += gravados;
    if (erro) { p.erros++; resumo.janelas_erro++; resumo.erros.push(chave + ' ' + erro); } else resumo.janelas_ok++;
    contar(tipo, cond, !erro);
    log((erro ? 'ERRO ' : 'ok   ') + tipo + ' ' + (ini || '') + ' ' + (fim || '') + (cond ? ' cond ' + cond : '') + ' itens ' + itens + ' gravados ' + gravados + ' ' + (Date.now() - t0) + 'ms' + (erro ? ' ' + erro : ''));
    await banco.inserir('fin_sync_log', {
      execucao, origem, usuario, tipo, janela_inicio: ini, janela_fim: fim, id_condominio: cond || null,
      status: erro ? 'erro' : 'ok', itens, gravados, duracao_ms: Date.now() - t0, erro,
    }).catch(() => false);
  }

  // Condomínios: ativos do Superlógica, sem os excluídos e sem a Virtual Service.
  async function carregarCondominios(listarCondominios, idUnico) {
    const todos = await listarCondominios(cliente);
    const fora = new Set(U.EXCLUIDOS);
    todos.forEach((c) => {
      if (NAO_CONDOMINIO.test(String(c.st_nome_cond || '')) || NAO_CONDOMINIO.test(String(c.st_fantasia_cond || ''))) fora.add(Number(c.id_condominio_cond));
    });
    let lista = todos.filter((c) => String(c.fl_ativo_cond || '1') !== '0').map(M.condominio)
      .filter((c) => c.id_condominio > 0 && !fora.has(c.id_condominio));
    if (idUnico) lista = lista.filter((c) => c.id_condominio === idUnico);
    // Nome fantasia -> código; 0 quando o nome é de mais de um cadastro.
    // nomesFora: nomes dos cadastros excluídos e da Virtual Service (a auditoria só traz o nome).
    const fantasia = new Map();
    const nomesFora = new Set();
    todos.forEach((c) => {
      const id = Number(c.id_condominio_cond);
      [c.st_fantasia_cond, c.st_nome_cond].map(M.chaveFantasia).filter(Boolean).forEach((f, i) => {
        if (fora.has(id)) nomesFora.add(f);
        if (i === 0) fantasia.set(f, fantasia.has(f) && fantasia.get(f) !== id ? 0 : id);
      });
    });
    return { lista, fora, fantasia, nomesFora };
  }

  // Falha antes do fim (lista de condomínios, banco): registra o fim com o erro e repassa.
  async function rodar(opcoes) {
    const t0 = Date.now();
    try { return await rodarInterno(opcoes); } catch (e) {
      if (!['periodo_invalido', 'periodo_longo', 'condominio_excluido'].includes(e && e.message)) {
        await banco.inserir('fin_sync_log', { execucao, origem, usuario, tipo: 'execucao', janela_inicio: opcoes.inicio, janela_fim: opcoes.fim, id_condominio: opcoes.idCondominio ? Number(opcoes.idCondominio) : null, status: 'fim', duracao_ms: Date.now() - t0, erro: 'falhou: ' + String((e && e.message) || e).slice(0, 200) }).catch(() => false);
      }
      throw e;
    }
  }

  // opcoes: { inicio, fim (AAAA-MM-DD), tipos[], idCondominio, listarCondominios, pular (Set) }
  async function rodarInterno(opcoes) {
    const { inicio, fim, listarCondominios, pular } = opcoes;
    const tipos = (opcoes.tipos && opcoes.tipos.length ? opcoes.tipos : TIPOS).filter((t) => TIPOS.includes(t));
    const idUnico = opcoes.idCondominio ? Number(opcoes.idCondominio) : null;
    if (!U.ehISO(inicio) || !U.ehISO(fim) || inicio > fim) throw new Error('periodo_invalido');
    if (U.diasEntre(inicio, fim) > MAX_DIAS) throw new Error('periodo_longo');
    if (idUnico && U.excluido(idUnico)) throw new Error('condominio_excluido');
    const cid = idUnico ? String(idUnico) : '-1';
    const t0 = Date.now();
    await banco.inserir('fin_sync_log', { execucao, origem, usuario, tipo: 'execucao', janela_inicio: inicio, janela_fim: fim, id_condominio: idUnico, status: 'inicio' }).catch(() => false);
    log('execucao ' + execucao + ' de ' + inicio + ' a ' + fim + ' cond ' + cid + ' tipos ' + tipos.join(','));

    const conds = await carregarCondominios(listarCondominios, idUnico);
    if (idUnico && !conds.lista.length) throw new Error('condominio_nao_encontrado');
    const valido = (id) => id > 0 && !conds.fora.has(id) && (!idUnico || id === idUnico);
    const marca = () => ({ visto_em: agora(), atualizado_em: agora() });
    log('condominios: ' + conds.lista.length);

    // Contas: sempre carregadas (o caixa precisa do mapa conta -> condomínio).
    const contaParaCond = new Map();
    const contaFora = new Set();
    let contasOk = false;
    await janela('contas', null, null, idUnico, async () => {
      const l = await buscar('contabancos/index', { idCondominio: cid, exibirContasAtivas: 1, semContaDigital: 0 });
      const todas = l.map(M.conta).filter((c) => c.id_conta);
      todas.forEach((c) => { if (!valido(c.id_condominio)) contaFora.add(c.id_conta); });
      const linhas = todas.filter((c) => valido(c.id_condominio));
      linhas.forEach((c) => contaParaCond.set(c.id_conta, c.id_condominio));
      contasOk = true;
      const g = tipos.includes('contas') ? await banco.upsert('fin_contas', linhas.map((c) => ({ ...c, ...marca() })), 'id_conta') : 0;
      return { itens: l.length, gravados: g };
    }, null);

    // Despesas: a mesma resposta alimenta despesas, parcelas e anexos.
    // despesaParaCond e despesaFora ajudam a auditoria (linhas sem nome de condomínio).
    const despesaParaCond = new Map();
    const despesaFora = new Set();
    async function gravarDespesas(l) {
      l.forEach((d) => {
        const idd = Number(d.id_despesa_des), idc = Number(d.id_condominio_cond);
        if (!(idd > 0)) return;
        if (conds.fora.has(idc)) despesaFora.add(idd); else if (idc > 0) despesaParaCond.set(idd, idc);
      });
      const ok = l.filter((d) => valido(Number(d.id_condominio_cond)) && Number(d.id_parcela_pdes) > 0 && Number(d.id_despesa_des) > 0);
      const m = marca();
      await banco.upsert('fin_despesas', ok.map((d) => ({ ...M.despesa(d), ...m })), 'id_despesa');
      const g = await banco.upsert('fin_parcelas', ok.map((d) => ({ ...M.parcela(d), ...m })), 'id_parcela');
      const anex = [].concat(...ok.map(M.anexos)).map((a) => ({ ...a, ...m }));
      await banco.upsert('fin_anexos', anex, 'id_arquivo,id_despesa');
      return { itens: l.length, gravados: g };
    }
    if (tipos.includes('despesas_liquidadas')) {
      for (const [a, b] of U.janelasQuinzena(inicio, fim)) {
        await janela('despesas_liquidadas', a, b, idUnico, async () => gravarDespesas(await buscarJanela('despesas/index',
          { idCondominio: cid, status: 'liquidadas', comStatus: 'liquidadas', filtrarpor: 'liquidacao' }, a, b, 50)), pular);
      }
    }
    // Pendentes: também os 12 meses antes do início (vencida sem baixa antiga continua aberta).
    if (tipos.includes('despesas_pendentes')) {
      for (const [a, b] of U.janelasMes(U.somaDias(inicio, -365), fim)) {
        await janela('despesas_pendentes', a, b, idUnico, async () => gravarDespesas(await buscarJanela('despesas/index',
          { idCondominio: cid, comStatus: 'pendentes' }, a, b, 50)), pular);
      }
    }

    // Caixa: por condomínio, mês e CONTA (sem idContaBancaria o Superlógica traz só a conta
    // principal; no -1 não há garantia de trazer todas). Só contas ativas dos condomínios válidos.
    if (tipos.includes('movimentos')) {
      const contasPorCond = new Map();
      contaParaCond.forEach((idc, idConta) => {
        if (!contasPorCond.has(idc)) contasPorCond.set(idc, []);
        contasPorCond.get(idc).push(idConta);
      });
      const trabalhos = [];
      conds.lista.forEach((c) => U.janelasMes(inicio, fim).forEach(([a, b]) => trabalhos.push([c.id_condominio, a, b])));
      if (!contasOk) trabalhos.length = 0;
      if (!contasOk) await janela('movimentos', inicio, fim, idUnico, async () => { throw new Error('contas_indisponiveis'); }, null);
      await emParalelo(trabalhos, 4, async ([idc, a, b]) => {
        await janela('movimentos', a, b, idc, async () => {
          let itens = 0;
          const linhas = [];
          for (const idConta of contasPorCond.get(idc) || []) {
            const l = await buscarJanela('caixa/index', { idCondominio: idc, idContaBancaria: idConta }, a, b, 50);
            itens += l.length;
            // descarta linha de outra conta (resposta fora do pedido) e fora da janela
            M.movimentos(l, contaParaCond)
              .filter((x) => x.id_conta === idConta && x.dt_data >= a && x.dt_data <= b)
              .forEach((x) => linhas.push({ ...x, id_condominio: idc, ...marca() }));
          }
          return { itens, gravados: await banco.upsert('fin_movimentos', linhas, 'chave') };
        }, pular);
      });
    }

    // Cobranças: por condomínio e mês, paginado (no -1 o Superlógica estoura a memória).
    if (tipos.includes('cobrancas')) {
      const trabalhos = [];
      conds.lista.forEach((c) => U.janelasMes(inicio, fim).forEach(([a, b]) => {
        trabalhos.push([c.id_condominio, a, b]);
      }));
      await emParalelo(trabalhos, 4, async ([idc, a, b]) => {
        await janela('cobrancas', a, b, idc, async () => {
          const base = { idCondominio: idc, apenasColunasPrincipais: 1, dtInicio: U.dataSL(a), dtFim: U.dataSL(b) };
          const pend = await paginar('cobranca/index', { ...base, status: 'pendentes' }, 50);
          const liq = await paginar('cobranca/index', { ...base, status: 'liquidadas', filtrarpor: 'liquidacao' }, 50);
          const linhas = pend.concat(liq).map(M.cobranca)
            .filter((x) => x.id_recebimento && (!x.id_condominio || x.id_condominio === idc))
            .map((x) => ({ ...x, id_condominio: idc, ...marca() }));
          return { itens: pend.length + liq.length, gravados: await banco.upsert('fin_cobrancas', linhas, 'id_recebimento') };
        }, pular);
      });
    }

    // Auditoria: um dia por chamada; só as linhas do financeiro de despesas.
    // Sempre com -1: com um código só o Superlógica não filtra e ainda tira o nome do
    // condomínio (medido em 21/10). O condomínio sai do nome fantasia de cada linha.
    if (tipos.includes('auditoria')) {
      await emParalelo(U.janelasDias(inicio, fim, 1), 2, async ([a, b]) => {
        await janela('auditoria', a, b, idUnico, async () => {
          const l = await buscarJanela('auditoria/index', { idCondominio: '-1' }, a, b, 100);
          const linhas = [];
          l.filter(M.auditoriaRelevante).forEach((bruta) => {
            const x = M.auditoria(bruta, conds.fantasia);
            if (!x.id_auditoria || !x.dt_data) return;
            const nome = M.chaveFantasia(bruta.st_fantasia_cond);
            if (nome) {
              // nome de cadastro excluído ou da Virtual Service: fora; nome desconhecido
              // (cadastro inativo ou fora da lista): fora, porque não dá para saber de quem é
              if (conds.nomesFora.has(nome) || NAO_CONDOMINIO.test(nome)) return;
              if (!conds.fantasia.has(nome)) {
                resumo.nomes_desconhecidos = resumo.nomes_desconhecidos || {};
                resumo.nomes_desconhecidos[nome] = (resumo.nomes_desconhecidos[nome] || 0) + 1;
                return;
              }
            }
            if (x.id_despesa && despesaFora.has(x.id_despesa)) return;
            if (!x.id_condominio && x.id_despesa && despesaParaCond.has(x.id_despesa)) x.id_condominio = despesaParaCond.get(x.id_despesa);
            if (x.id_condominio && conds.fora.has(x.id_condominio)) return;
            if (idUnico && x.id_condominio !== idUnico) return;
            linhas.push(x);
          });
          return { itens: l.length, gravados: await banco.upsert('fin_auditoria_sl', linhas, 'id_auditoria') };
        }, pular);
      });
    }

    await gravarDatasCondominios(conds.lista, tipos, inicio, fim, idUnico);
    resumo.duracao_s = Math.round((Date.now() - t0) / 1000);
    await banco.inserir('fin_sync_log', { execucao, origem, usuario, tipo: 'execucao', janela_inicio: inicio, janela_fim: fim, id_condominio: idUnico, status: 'fim', itens: resumo.janelas_ok + resumo.janelas_erro, duracao_ms: Date.now() - t0, erro: resumo.janelas_erro ? resumo.janelas_erro + ' janelas com erro' : null }).catch(() => false);
    log('fim: ' + JSON.stringify({ ...resumo, erros: resumo.erros.slice(0, 20) }));
    return resumo;
  }

  // Data da última sincronização por condomínio: um tipo só conta como sincronizado
  // para o condomínio quando todas as janelas dele deram certo.
  async function gravarDatasCondominios(lista, tipos, inicio, fim, idUnico) {
    if (!lista.length) return;
    let atuais = [];
    try {
      atuais = await banco.ler('fin_condominios?select=id_condominio,sync_tipos,sincronizado_de,sincronizado_ate,ultima_sincronizacao'
        + (idUnico ? '&id_condominio=eq.' + idUnico : ''));
    } catch (e) { log('aviso: não leu fin_condominios (' + e.message + ')'); }
    const porId = new Map((atuais || []).map((c) => [c.id_condominio, c]));
    const em = agora();
    const linhas = lista.map((c) => {
      const ant = porId.get(c.id_condominio) || {};
      const st = { ...(ant.sync_tipos || {}) };
      let algum = false, todos = true;
      tipos.forEach((t) => {
        const r = okPorTipo[t];
        if (!r) return;
        const pc = r.porCond.get(c.id_condominio);
        // tipos da carteira inteira (-1) valem para todos; cobranças valem por condomínio
        const ok = POR_CONDOMINIO.has(t) ? !!pc && pc.ok === pc.total : r.ok === r.total;
        if (ok) {
          const antT = st[t] || {};
          st[t] = { em, ...juntarPeriodo(antT.de, antT.ate, inicio, fim) };
          algum = true;
        } else todos = false;
      });
      // O período do condomínio só anda quando todos os tipos rodaram e deram certo.
      const completo = algum && todos && TIPOS.every((t) => tipos.includes(t));
      const p = completo ? juntarPeriodo(ant.sincronizado_de, ant.sincronizado_ate, inicio, fim) : { de: ant.sincronizado_de || null, ate: ant.sincronizado_ate || null };
      return {
        ...c,
        sync_tipos: st,
        ultima_sincronizacao: algum ? em : (ant.ultima_sincronizacao || null),
        sincronizado_de: p.de,
        sincronizado_ate: p.ate,
        atualizado_em: em,
      };
    });
    await banco.upsert('fin_condominios', linhas, 'id_condominio');
  }

  return { rodar, execucao };
}

module.exports = { criarSync, TIPOS, listaDe };
