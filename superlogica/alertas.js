// Importar Despesas (checagens antes do envio) e alertas operacionais por condomínio (T05).
// Tudo GET no Superlógica. A gravação de despesa continua no fluxo atual da tela; aqui só
// se confere: duplicata (mesmo fornecedor, valor, vencimento e documento) e fornecedor
// existente. Alertas: contas a pagar em 7 dias, saldo baixo na conta principal e despesas
// recorrentes que já deviam ter sido lançadas e não foram.

const consulta = require('./consulta');

const POR_PAGINA = 50;
const MAX_LINHAS = 500;            // linhas por verificação
const MAX_DATAS = 31;              // datas de vencimento distintas por verificação
const MAX_FORNECEDORES = 50;       // fornecedores distintos por verificação
const MAX_PAG_DATA = 10;           // páginas de 50 por data (500 parcelas num dia)
// Cache curto das leituras da checagem (validar e enviar repetem as mesmas consultas).
const _cacheLeitura = new Map();   // chave -> { ate, v }
async function lerComCache(chave, fn) {
  const c = _cacheLeitura.get(chave);
  if (c && c.ate > Date.now()) return c.v;
  const v = await fn();
  _cacheLeitura.set(chave, { ate: Date.now() + 3 * 60 * 1000, v });
  if (_cacheLeitura.size > 2000) _cacheLeitura.delete(_cacheLeitura.keys().next().value);
  return v;
}
const doisDig = (n) => String(n).padStart(2, '0');
const dataSL = (d) => doisDig(d.getMonth() + 1) + '/' + doisDig(d.getDate()) + '/' + d.getFullYear(); // MM/DD/AAAA
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const cent = (v) => Math.round(v * 100) / 100;
// "MM/DD/AAAA ..." -> "DD/MM/AAAA"
function dataBR(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? doisDig(m[2]) + '/' + doisDig(m[1]) + '/' + m[3] : '';
}
// "MM/DD/AAAA ..." -> "MM/DD/AAAA" (só a data)
function soData(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? doisDig(m[1]) + '/' + doisDig(m[2]) + '/' + m[3] : '';
}
// documento comparável: sem espaço, sem zero à esquerda, minúsculo
function docNorm(v) { return limpar(v).toLowerCase().replace(/\s+/g, '').replace(/^0+(?=\d)/, ''); }

// No máximo n consultas ao mesmo tempo (o Superlógica limita requisições).
async function emParalelo(itens, n, fn) {
  let i = 0;
  async function trab() { while (i < itens.length) { const k = i++; await fn(itens[k]); } }
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trab));
}

// estrito: chegou no teto de páginas com página cheia = pode haver mais; lança erro (a checagem
// de duplicata nunca pode liberar envio com a leitura cortada).
async function todasPaginas(cliente, rota, params, maxPaginas, estrito) {
  const out = [];
  for (let pg = 1; pg <= maxPaginas; pg++) {
    const j = await cliente.get(rota, Object.assign({}, params, { itensPorPagina: POR_PAGINA, pagina: pg }));
    if (!Array.isArray(j) || !j.length) break;
    j.forEach((x) => out.push(x));
    if (j.length < POR_PAGINA) break;
    if (pg === maxPaginas && estrito) { const e = new Error('leitura_cortada'); e.cortada = true; throw e; }
  }
  return out;
}

// Normaliza e valida as linhas que a tela mandou. Nunca lança.
// linha: { linha, fornecedor_id, vencimento: 'MM/DD/AAAA', valor, documento }
function normalizarLinhas(lista) {
  if (!Array.isArray(lista)) return { erro: 'linhas deve ser uma lista' };
  if (!lista.length) return { erro: 'nenhuma linha para verificar' };
  if (lista.length > MAX_LINHAS) return { erro: 'no máximo ' + MAX_LINHAS + ' linhas por envio' };
  const linhas = [];
  for (const l of lista) {
    const forn = String(l && l.fornecedor_id || '').trim();
    const venc = soData(l && l.vencimento);
    const valor = cent(num(l && l.valor));
    if (!/^[1-9][0-9]{0,9}$/.test(forn) || !venc || !(valor > 0)) return { erro: 'linha ' + (l && l.linha) + ' inválida' };
    linhas.push({ linha: Number(l.linha) || 0, fornecedor_id: forn, vencimento: venc, valor, documento: limpar(l.documento).slice(0, 40) });
  }
  if (new Set(linhas.map((l) => l.vencimento)).size > MAX_DATAS) return { erro: 'no máximo ' + MAX_DATAS + ' datas de vencimento diferentes por envio; divida a planilha' };
  if (new Set(linhas.map((l) => l.fornecedor_id)).size > MAX_FORNECEDORES) return { erro: 'no máximo ' + MAX_FORNECEDORES + ' fornecedores diferentes por envio; divida a planilha' };
  return { linhas };
}

// Duplicata: no Superlógica já existe despesa no MESMO condomínio com o mesmo fornecedor,
// o mesmo valor e o mesmo vencimento; se a linha tem documento, o documento também precisa
// bater (documento diferente = outra nota, não é duplicata). Também aponta duplicata DENTRO
// da própria planilha. Fornecedor: o código precisa existir no cadastro de fornecedores.
async function verificarImportacao(cliente, id, linhas) {
  // 1) despesas já lançadas, por data de vencimento (uma consulta por data)
  const datas = [...new Set(linhas.map((l) => l.vencimento))];
  const porData = new Map();
  await emParalelo(datas, 4, async (dt) => {
    // filtro padrão do despesas/index é o VENCIMENTO (inclui as já pagas daquele vencimento)
    const itens = await lerComCache('desp:' + id + ':' + dt, () =>
      todasPaginas(cliente, 'despesas/index', { idCondominio: id, comStatus: 'todas', dtInicio: dt, dtFim: dt }, MAX_PAG_DATA, true));
    porData.set(dt, itens);
  });
  // 2) fornecedores (um GET por código distinto)
  const ids = [...new Set(linhas.map((l) => l.fornecedor_id))];
  const fornecedores = new Map();
  await emParalelo(ids, 4, async (fid) => {
    let j = [];
    // O Superlógica responde 404 quando o código de fornecedor não existe: é "não achou", não falha.
    j = await lerComCache('forn:' + fid, async () => {
      try { return await cliente.get('fornecedores/index', { contatosDoTipo: 'fornecedores', id: fid, itensPorPagina: 5, pagina: 1 }); }
      catch (e) { if (e && e.status === 404) return []; throw e; }
    });
    const achou = (Array.isArray(j) ? j : []).find((f) => String(f.id_contato_con) === fid);
    fornecedores.set(fid, achou ? (limpar(achou.st_nome_con) || limpar(achou.st_fantasia_con)) : null);
  });

  const duplicadas = [];
  const fornecedorInexistente = [];
  const vistas = new Map();
  for (const l of linhas) {
    if (fornecedores.get(l.fornecedor_id) == null) fornecedorInexistente.push({ linha: l.linha, fornecedor_id: l.fornecedor_id });
    const iguais = (porData.get(l.vencimento) || []).filter((d) =>
      String(d.id_contato_con) === l.fornecedor_id &&
      Math.abs(cent(num(d.vl_valor_pdes)) - l.valor) < 0.005 &&
      // documento só diferencia quando OS DOIS lados têm documento (o envio antigo não mandava
      // documento, então despesa já lançada sem documento + planilha com documento = duplicata).
      (!l.documento || !docNorm(d.st_documento_des) || docNorm(d.st_documento_des) === docNorm(l.documento)));
    if (iguais.length) {
      const d = iguais[0];
      duplicadas.push({
        linha: l.linha, origem: 'superlogica', id_despesa: Number(d.id_despesa_des) || null,
        fornecedor: limpar(d.st_nome_con), vencimento: dataBR(d.dt_vencimento_pdes), valor: cent(num(d.vl_valor_pdes)),
        documento: limpar(d.st_documento_des), paga: String(d.fl_liquidado_pdes) === '1',
      });
      continue;
    }
    const chave = [l.fornecedor_id, l.vencimento, l.valor.toFixed(2), docNorm(l.documento)].join('|');
    if (vistas.has(chave)) duplicadas.push({ linha: l.linha, origem: 'planilha', igual_a_linha: vistas.get(chave) });
    else vistas.set(chave, l.linha);
  }
  return {
    linhas: linhas.length,
    duplicadas,
    fornecedor_inexistente: fornecedorInexistente,
    fornecedores: Object.fromEntries([...fornecedores].map(([k, v]) => [k, v])),
    pode_enviar: !duplicadas.length && !fornecedorInexistente.length,
  };
}

// Alertas calculados agora no Superlógica. Cada um tem chave ESTÁVEL (o mesmo fato gera a
// mesma chave), para a tela guardar visto/resolvido sem repetir o aviso.
// cfg: { saldo_minimo } (null = alerta de saldo desligado)
async function calcularAlertas(cliente, id, hoje, cfg) {
  const h = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const em7 = new Date(h); em7.setDate(h.getDate() + 7);
  const ha60 = new Date(h); ha60.setDate(h.getDate() - 60);
  const isoHoje = h.getFullYear() + doisDig(h.getMonth() + 1) + doisDig(h.getDate());
  const alertas = [];
  const falhas = [];

  const em31 = new Date(h); em31.setDate(h.getDate() + 31);
  const [vencer, contas, recorr, lancadas] = await Promise.all([
    todasPaginas(cliente, 'despesas/index', { idCondominio: id, comStatus: 'pendentes', dtInicio: dataSL(h), dtFim: dataSL(em7) }, 6).catch(() => { falhas.push('contas a vencer'); return []; }),
    consulta.contas(cliente, id).catch(() => { falhas.push('saldo'); return null; }),
    // Medido na API real: numa janela longa o despesasrecorrente omite recorrências que aparecem
    // na janela do mês. Por isso consulta mês a mês (mês passado e o mês atual até hoje).
    Promise.all([
      [new Date(h.getFullYear(), h.getMonth() - 1, 1), new Date(h.getFullYear(), h.getMonth(), 0)],
      [new Date(h.getFullYear(), h.getMonth(), 1), h],
    ].map(([i, f]) => todasPaginas(cliente, 'despesas/despesasrecorrente', { idCondominio: id, dtInicio: dataSL(i), dtFim: dataSL(f) }, 6)))
      .then((ls) => [].concat(...ls)).catch(() => { falhas.push('recorrentes'); return []; }),
    todasPaginas(cliente, 'despesas/index', { idCondominio: id, comStatus: 'todas', dtInicio: dataSL(ha60), dtFim: dataSL(em31) }, 20).catch(() => null),
  ]);
  // vencimentos já lançados por fornecedor (AAAAMMDD), para não alertar recorrente que já existe
  const lancPorForn = new Map();
  (lancadas || []).forEach((d) => {
    const m = String(d.dt_vencimento_pdes || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return;
    const k = String(d.id_contato_con);
    if (!lancPorForn.has(k)) lancPorForn.set(k, []);
    lancPorForn.get(k).push(new Date(+m[3], +m[1] - 1, +m[2]).getTime());
  });

  // 1) contas a pagar vencendo em até 7 dias (uma por parcela)
  vencer.filter((d) => String(d.fl_liquidado_pdes) !== '1').forEach((d) => {
    const apro = Array.isArray(d.apropriacao) ? d.apropriacao : [];
    alertas.push({
      chave: 'vencer:' + (d.id_parcela_pdes || d.id_despesa_des) + ':' + soData(d.dt_vencimento_pdes),
      tipo: 'conta_a_vencer',
      titulo: 'Conta a pagar vence em ' + dataBR(d.dt_vencimento_pdes) + ': ' + (limpar(d.st_nome_con) || 'fornecedor'),
      detalhe: {
        fornecedor: limpar(d.st_nome_con), vencimento: dataBR(d.dt_vencimento_pdes), valor: cent(num(d.vl_valor_pdes)),
        descricao: apro.map((a) => limpar(a.st_descricao_cont)).filter(Boolean).join(', '),
      },
    });
  });

  // 2) saldo baixo na conta principal (limite configurado por condomínio)
  const minimo = cfg && cfg.saldo_minimo != null ? num(cfg.saldo_minimo) : null;
  if (lancadas === null) falhas.push('despesas lançadas (recorrentes não conferidas)');
  if (contas && minimo != null && minimo > 0) {
    const principal = contas.contas.find((c) => c.principal) || contas.contas[0];
    if (principal && principal.saldo < minimo) {
      alertas.push({
        // por mês: resolvido some até o mês seguinte, se o saldo continuar baixo volta
        chave: 'saldo:' + String(principal.conta || principal.descricao).replace(/[^A-Za-z0-9._-]/g, '') + ':' + isoHoje.slice(0, 6),
        tipo: 'saldo_baixo',
        titulo: 'Saldo da conta principal abaixo do limite',
        detalhe: { conta: principal.descricao, banco: principal.banco, saldo: principal.saldo, limite: cent(minimo) },
      });
    }
  }

  // 3) recorrentes não lançadas: a próxima geração prevista (campo ordenacao, AAAAMMDD) já
  // passou e a despesa do período ainda não existe.
  const vistosRec = new Set();
  recorr.forEach((r) => {
    const prox = String(r.ordenacao || '').slice(0, 8);
    if (vistosRec.has(r.id_despesa_des + ':' + prox)) return;
    vistosRec.add(r.id_despesa_des + ':' + prox);
    if (!/^\d{8}$/.test(prox) || prox > isoHoje) return;
    if (lancadas === null) return; // sem a lista de lançadas não dá para afirmar que falta (não inventa)
    const tProx = new Date(+prox.slice(0, 4), +prox.slice(4, 6) - 1, +prox.slice(6, 8)).getTime();
    const jaTem = (lancPorForn.get(String(r.id_contato_con)) || []).some((t) => Math.abs(t - tProx) <= 10 * 86400000);
    if (jaTem) return;
    const proxBR = prox.slice(6, 8) + '/' + prox.slice(4, 6) + '/' + prox.slice(0, 4);
    alertas.push({
      chave: 'recorrente:' + r.id_despesa_des + ':' + prox,
      tipo: 'recorrente_nao_lancada',
      titulo: 'Despesa recorrente não lançada: ' + (limpar(r.st_nome_con) || 'fornecedor') + ' (prevista para ' + proxBR + ')',
      detalhe: { fornecedor: limpar(r.st_nome_con), prevista_para: proxBR, ultimo_vencimento: dataBR(r.dt_vencimento_pdes), valor_ultimo: cent(num(r.vl_total)) },
    });
  });

  return { alertas, falhas, saldo_minimo: minimo };
}

module.exports = { normalizarLinhas, verificarImportacao, calcularAlertas, MAX_LINHAS };
