'use strict';
// Boletos do mês (frente de execução do financeiro da Condomínio Service). Lógica e leitura do
// Superlógica; as rotas ficam em financeiro/boletos-mes-rotas.js e toda gravação passa antes pela
// política única (servico/escrita-superlogica.js). Partes:
//   1. Calendário de geração: dia de vencimento de cada condomínio (condominios/get), data limite
//      para o lote estar pronto (10 dias antes do vencimento; o boleto sai de 7 a 10 dias antes) e
//      aviso de atraso, com a situação do lote do mês (cobranca/index, primeira página).
//   2. Composição do mês: leitura (arrecadacoes/index com dtInicio e dtFim do mês; sem o dtFim a
//      leitura ignora a data e mostra o mês corrente da arrecadação), conferência dos itens novos (taxa
//      extra, parcelas, item de uma unidade) e o corpo do arrecadacoes/put. O put sempre cria um
//      item novo; com FL_QUANDO_ARRECADAR 1 ou 2 o DT_FIM_COT vai sempre explícito.
//   3. Conferência ANTES de gerar: simulação do relatório 074A (render=json, só leitura) comparada
//      com os 3 meses anteriores, leituras de consumo e itens da composição.
//   4. Remessa: pendências (remessa/pendente) e leitura da resposta do remessa/gerar (só o arquivo,
//      o envio ao banco é sempre da pessoa).
//   5. Régua de cobrança: só os campos de prazo do email (a leitura devolve chaves sensíveis da
//      empresa, que nunca saem do servidor) e o padrão do dono.
//   6. Trocas manuais da forma de recebimento (PJBank) lidas da auditoria: só leitura e aviso.
// Nunca chama arrecadacoes/processar (gera boletos reais e encosta no PJBank).

const crypto = require('crypto');
const T27 = require('./boletos');

const NAO_CONDOMINIOS = T27.NAO_CONDOMINIOS;
const ID_TESTE = '167';
const ANTECEDENCIA_LOTE = 10;   // lote pronto pelo menos 10 dias antes do vencimento
const ENVIO_MIN = 7;            // boleto enviado de 7 a 10 dias antes do vencimento
const PERTO_DO_LIMITE = 3;      // faltando 3 dias ou menos para a data limite: aviso
const FATOR_ALTO = 1.5;
const FATOR_BAIXO = 0.5;
const MAX_ITENS = 30;           // itens novos por gravação
const MAX_VALOR = 1000000;
const POR_PAGINA = 50;
const REGUA_PADRAO = { antes: 7, no_dia: 0, depois: 3 };
const RETORNO_AUTO_PARTE = 0.8; // 80% das pagas baixadas sem arquivo de retorno = retorno automático
const RETORNO_AUTO_MINIMO = 5;

const doisDig = (n) => String(n).padStart(2, '0');
const limpar = (v) => String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const semAcento = (s) => limpar(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const cent = (v) => Math.round(Number(v) * 100) / 100;
const reais = (v) => 'R$ ' + cent(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v == null ? '' : v).replace(/[^\d,.\-]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
  const n = Number(s);
  return isFinite(n) ? n : 0;
}
// Datas: o Superlógica manda MM/DD/AAAA; o relatório em json vem como na tela (DD/MM/AAAA).
function isoDeSL(v) { const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? m[3] + '-' + doisDig(m[1]) + '-' + doisDig(m[2]) : ''; }
function isoDeBR(v) { const m = String(v || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? m[3] + '-' + doisDig(m[2]) + '-' + doisDig(m[1]) : ''; }
const sl = (iso) => iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4);
const br = (iso) => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '');
const brCurto = (iso) => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '');
function maisDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dias(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

function competencia(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const ano = +m[1], mes = +m[2];
  if (mes < 1 || mes > 12 || ano < 2020 || ano > 2100) return null;
  return { ano, mes, chave: m[0], rotulo: doisDig(mes) + '/' + ano };
}
function somarMeses(c, n) {
  const t = c.ano * 12 + (c.mes - 1) + n;
  return competencia(Math.floor(t / 12) + '-' + doisDig((t % 12) + 1));
}
const ultimoDia = (c) => new Date(Date.UTC(c.ano, c.mes, 0)).getUTCDate();
const inicioMes = (c) => c.chave + '-01';
const fimMes = (c) => c.chave + '-' + doisDig(ultimoDia(c));
// Vencimento do mês: o dia do cadastro, ou o último dia quando o mês é curto (dia 31 em fevereiro).
function vencimentoEm(c, dia) { return c.chave + '-' + doisDig(Math.min(dia, ultimoDia(c))); }

// ── 1. Calendário ─────────────────────────────────────────────────────────

// Próximo vencimento a partir de hoje (inclusive): o do mês de hoje, ou o do mês seguinte.
function proximoVencimento(dia, hoje) {
  const c = competencia(hoje.slice(0, 7));
  const v = vencimentoEm(c, dia);
  if (v >= hoje) return { comp: c, vencimento: v };
  const p = somarMeses(c, 1);
  return { comp: p, vencimento: vencimentoEm(p, dia) };
}

// Condomínios do Superlógica com o dia de vencimento (uma chamada para todos).
function enxugarCondominio(c) {
  const id = String((c && c.id_condominio_cond) || '');
  const dia = parseInt(c && c.dt_diavencimento_cond, 10);
  return {
    id, nome: limpar(c.st_fantasia_cond || c.st_nome_cond) || ('Condomínio ' + id),
    dia: dia >= 1 && dia <= 31 ? dia : null,
    implantacao: String(c.fl_status_implantacao) === '0',
    teste: id === ID_TESTE,
  };
}
// Só os cadastros ativos (mesma leitura da sincronização dos condomínios); a Virtual Service nunca entra.
async function lerCondominios(cliente) {
  const lista = [];
  for (let pg = 1; pg <= 5; pg++) {
    const j = await cliente.get('condominios/get', { id: -1, somenteCondominiosAtivos: 1, itensPorPagina: 500, pagina: pg });
    const l = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
    lista.push(...l);
    if (l.length < 500) break;
  }
  return lista.filter((c) => c && String(c.fl_ativo_cond || '1') !== '0' && !/\bVIRTUAL SERVICE\b/i.test(String(c.st_nome_cond || '') + ' ' + String(c.st_fantasia_cond || '')))
    .map(enxugarCondominio).filter((c) => /^[1-9]\d{0,8}$/.test(c.id) && !NAO_CONDOMINIOS.has(c.id));
}

// Lote mensal do mês de vencimento: cobranças com id de lote negativo (-AAAAMM). Uma página basta
// para saber se o lote existe e quando foi gerado (o lote é a maior parte das cobranças do mês).
function resumirLote(rows) {
  const lista = Array.isArray(rows) ? rows : [];
  const lote = lista.filter((r) => Number(r && r.id_lote_recb) < 0);
  const geracoes = lote.map((r) => isoDeSL(r.dt_geracao_recb)).filter(Boolean).sort();
  return { gerado: lote.length > 0, boletos_lidos: lote.length, gerado_em: geracoes[0] || '', avulsos: lista.length - lote.length, pagina_cheia: lista.length >= POR_PAGINA };
}
async function loteDoMes(cliente, id, c) {
  const j = await cliente.get('cobranca/index', { idCondominio: id, status: 'validos', dtInicio: sl(inicioMes(c)), dtFim: sl(fimMes(c)), apenasColunasPrincipais: 1, itensPorPagina: POR_PAGINA, pagina: 1 });
  if (!Array.isArray(j)) { const e = new Error('resposta_sem_lista'); e.status = 502; throw e; }
  return resumirLote(j);
}

// Situação de um condomínio no calendário. Texto pronto para a tela, sem hífen nem travessão.
function situacaoCalendario(cond, vencimento, lote, hoje) {
  if (!cond.dia) return { estado: 'sem_dia', gravidade: 'media', texto: 'Sem dia de vencimento no cadastro do Superlógica.' };
  const limite = maisDias(vencimento, -ANTECEDENCIA_LOTE);
  const envioAte = maisDias(vencimento, -ENVIO_MIN);
  const base = { limite, envio_de: limite, envio_ate: envioAte };
  if (lote && lote.erro) return Object.assign(base, { estado: 'sem_leitura', gravidade: 'media', texto: 'Não foi possível ler os boletos deste mês agora.' });
  if (lote && lote.gerado) {
    const antes = lote.gerado_em ? dias(lote.gerado_em, vencimento) : null;
    if (antes != null && antes < ENVIO_MIN) return Object.assign(base, { estado: 'gerado_tarde', gravidade: 'alta', antecedencia: antes, texto: 'Lote gerado em ' + brCurto(lote.gerado_em) + ', só ' + antes + ' dias antes do vencimento.' });
    if (antes != null && antes < ANTECEDENCIA_LOTE) return Object.assign(base, { estado: 'gerado_em_cima', gravidade: 'media', antecedencia: antes, texto: 'Lote gerado em ' + brCurto(lote.gerado_em) + ', ' + antes + ' dias antes do vencimento (o padrão é pelo menos 10).' });
    return Object.assign(base, { estado: 'gerado', gravidade: 'ok', antecedencia: antes, texto: 'Lote gerado' + (lote.gerado_em ? ' em ' + brCurto(lote.gerado_em) + (antes != null ? ', ' + antes + ' dias antes do vencimento' : '') : '') + '.' });
  }
  if (lote && lote.gerado === false && lote.anterior === false) return Object.assign(base, { estado: 'sem_lote_mensal', gravidade: 'baixa', texto: 'Sem lote mensal neste mês nem no anterior: confira se este cadastro emite boleto pelo Superlógica.' });
  const faltam = dias(hoje, limite);
  if (hoje > vencimento) return Object.assign(base, { estado: 'vencido_sem_lote', gravidade: 'alta', atraso: -faltam, texto: 'O vencimento de ' + brCurto(vencimento) + ' passou e o lote não foi achado.' });
  if (faltam < 0) {
    const tarde = hoje > envioAte;
    return Object.assign(base, { estado: 'atrasado', gravidade: 'alta', atraso: -faltam,
      texto: 'Atrasado ' + (-faltam) + (-faltam === 1 ? ' dia' : ' dias') + ': o lote devia estar pronto até ' + brCurto(limite) + '.' + (tarde ? ' O boleto já não chega 7 dias antes do vencimento.' : '') });
  }
  if (faltam <= PERTO_DO_LIMITE) return Object.assign(base, { estado: 'perto', gravidade: 'media', faltam, texto: faltam === 0 ? 'Hoje é o último dia para o lote ficar pronto.' : 'Faltam ' + faltam + (faltam === 1 ? ' dia' : ' dias') + ' para a data limite (' + brCurto(limite) + ').' });
  return Object.assign(base, { estado: 'no_prazo', gravidade: 'ok', faltam, texto: 'Lote pronto até ' + brCurto(limite) + '. Faltam ' + faltam + ' dias.' });
}

const PESO_CAL = { alta: 0, media: 1, ok: 2, baixa: 3 };
// Linhas do calendário. lotes: Map id -> resumo do lote (ou { erro }). comp: competência fixa (opcional).
function montarCalendario(conds, lotes, hoje, comp) {
  const linhas = conds.map((c) => {
    const alvo = c.dia ? (comp ? { comp, vencimento: vencimentoEm(comp, c.dia) } : proximoVencimento(c.dia, hoje)) : null;
    const lote = lotes.get(c.id) || null;
    const s = situacaoCalendario(c, alvo ? alvo.vencimento : '', lote, hoje);
    return Object.assign({ id_condominio: c.id, condominio: c.nome, teste: c.teste, implantacao: c.implantacao, dia_vencimento: c.dia,
      competencia: alvo ? alvo.comp.chave : '', vencimento: alvo ? alvo.vencimento : '' }, s, lote && !lote.erro ? { boletos_lidos: lote.boletos_lidos, gerado_em: lote.gerado_em } : {});
  });
  linhas.sort((a, b) => (PESO_CAL[a.gravidade] - PESO_CAL[b.gravidade]) || String(a.limite || '9').localeCompare(String(b.limite || '9')) || a.condominio.localeCompare(b.condominio, 'pt-BR'));
  const conta = (f) => linhas.filter(f).length;
  return {
    hoje, regra: 'Lote pronto pelo menos ' + ANTECEDENCIA_LOTE + ' dias antes do vencimento; boleto enviado de ' + ENVIO_MIN + ' a ' + ANTECEDENCIA_LOTE + ' dias antes.',
    resumo: { condominios: linhas.length, gerados: conta((l) => /^gerado/.test(l.estado)), atrasados: conta((l) => l.estado === 'atrasado' || l.estado === 'vencido_sem_lote'),
      perto: conta((l) => l.estado === 'perto'), no_prazo: conta((l) => l.estado === 'no_prazo'), gerados_em_cima: conta((l) => l.estado === 'gerado_em_cima' || l.estado === 'gerado_tarde') },
    linhas,
  };
}

// ── 2. Composição do mês ──────────────────────────────────────────────────

function normalizarComposicao(x) {
  const bloco = limpar(x.st_bloco_uni), uni = limpar(x.st_unidade_uni);
  const nome = limpar(x.st_descricao_cont || x.st_nome_cot);
  return {
    id: String(x.id_composicao_cot || ''),
    conta: limpar(x.st_conta_cont),
    nome,
    complemento: limpar(x.st_complemento_cot).slice(0, 120),
    valor: cent(num(x.vl_valor_cot)),
    boleto: String(x.fl_tipocob_cot) === '2' ? 'extra' : 'normal',
    quem: /^\d+$/.test(String(x.id_unidade_uni || '')) ? 'unidade' : (/^\d+$/.test(String(x.id_grupo_ug || '')) ? 'grupo' : 'todas'),
    id_unidade: /^\d+$/.test(String(x.id_unidade_uni || '')) ? String(x.id_unidade_uni) : '',
    unidade: (bloco ? bloco + ' ' : '') + uni,
    inicio: isoDeSL(x.dt_inicio_cot),
    fim: isoDeSL(x.dt_fim_cot),
    fracao: limpar(x.st_fracao_cot),
    rateio: limpar(x.st_rateio_cot),
    tipo: T27.tipoItem(nome, x.st_complemento_cot),
  };
}
async function lerComposicoes(cliente, id, c) {
  const j = await cliente.get('arrecadacoes/index', { idCondominio: id, ID_CONDOMINIO_COND: id, tipoCobranca: 'ordinarias', somenteComposicoesTipos: 1,
    comReceitasAvulsasAgrupadas: 1, daCamada0DaArrecadacao: 1, dtInicio: sl(inicioMes(c)), dtFim: sl(fimMes(c)) });
  if (!Array.isArray(j)) { const e = new Error('resposta_sem_lista'); e.status = 502; throw e; }
  return j.filter((x) => x && /^\d+$/.test(String(x.id_composicao_cot || '')) && String(x.id_condominio_cond || id) === String(id)).map(normalizarComposicao);
}

// Contas bancárias do condomínio, só id e descrição (a leitura traz chaves da conta que nunca saem daqui).
async function lerContas(cliente, id) {
  const j = await cliente.get('contabancos/index', { idCondominio: id });
  const lista = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
  return lista.filter((x) => x && /^\d+$/.test(String(x.id_contabanco_cb || '')) && (!x.id_condominio_cond || String(x.id_condominio_cond) === String(id)))
    .map((x) => ({ id: String(x.id_contabanco_cb), descricao: limpar(x.st_descricao_cb).slice(0, 80) || ('Conta ' + x.id_contabanco_cb), tipo: String(x.id_tipocontabanco_tcb || '') }));
}

// Unidades do condomínio (id e texto), para conferir que o item de uma unidade é deste condomínio.
async function lerUnidades(cliente, id) {
  const out = new Map();
  for (let pg = 1; pg <= 40; pg++) {
    const j = await cliente.get('unidades/index', { idCondominio: id, exibirDadosDosContatos: 0, itensPorPagina: POR_PAGINA, pagina: pg });
    if (!Array.isArray(j)) { const e = new Error('resposta_sem_lista'); e.status = 502; throw e; }
    j.forEach((u) => { if (u && /^\d+$/.test(String(u.id_unidade_uni || '')) && (!u.id_condominio_cond || String(u.id_condominio_cond) === String(id))) out.set(String(u.id_unidade_uni), (limpar(u.st_bloco_uni) ? limpar(u.st_bloco_uni) + ' ' : '') + limpar(u.st_unidade_uni)); });
    if (j.length < POR_PAGINA) break;
  }
  return out;
}

const TIPOS_ITEM = { taxa_extra: 'Taxa extra para todas as unidades', item_unidade: 'Item para uma unidade' };
const RX_TEXTO = /^[^<>{}\\]{1,60}$/;
const RX_CONTA = /^\d{1,2}(\.\d{1,4}){1,4}$/;
// Confere um item pedido pela tela. Devolve { item } normalizado ou { erro }.
function validarItem(b, contas) {
  const o = b && typeof b === 'object' ? b : {};
  const tipo = String(o.tipo || '');
  if (!TIPOS_ITEM[tipo]) return { erro: 'Tipo de item inválido.' };
  const conta = String(o.conta || '1.9').trim();
  if (!RX_CONTA.test(conta) || !/^1\./.test(conta)) return { erro: 'Conta de receita inválida (use uma conta do grupo 1, por exemplo 1.9).' };
  const complemento = String(o.complemento == null ? '' : o.complemento).replace(/\s+/g, ' ').trim();
  if (!RX_TEXTO.test(complemento)) return { erro: 'Escreva a descrição do item (até 60 letras, sem < >).' };
  const valor = cent(num(o.valor));
  if (!(valor > 0) || valor > MAX_VALOR) return { erro: 'Valor inválido.' };
  const meses = parseInt(o.meses, 10);
  if (!(meses >= 1 && meses <= 60)) return { erro: 'Número de meses inválido (de 1 a 60).' };
  const boleto = o.boleto === 'extra' ? 'extra' : 'normal';
  const idConta = String(o.id_conta || '');
  if (!contas.some((c) => c.id === idConta)) return { erro: 'Escolha a conta bancária do condomínio.' };
  const item = { tipo, conta, complemento, valor, meses, boleto, id_conta: idConta };
  if (tipo === 'item_unidade') {
    const u = String(o.id_unidade || '');
    if (!/^[1-9]\d{0,9}$/.test(u)) return { erro: 'Escolha a unidade.' };
    item.id_unidade = u;
  }
  return { item };
}
const chaveTexto = (s) => semAcento(s).replace(/[^a-z0-9]+/g, ' ').trim();
// Itens novos contra a composição atual do mês e entre si: duplicado trava.
function conferirItensNovos(novos, atuais) {
  const avisos = [];
  novos.forEach((n, k) => {
    const igual = atuais.find((a) => a.conta === n.conta && (chaveTexto(a.complemento) === chaveTexto(n.complemento) || (Math.abs(a.valor - n.valor) < 0.005 && !a.complemento))
      && (n.tipo === 'item_unidade' ? a.id_unidade === n.id_unidade : a.quem === 'todas'));
    if (igual) avisos.push({ indice: k, tipo: 'item_duplicado', gravidade: 'alta', texto: 'Já existe na composição do mês: ' + (igual.nome || igual.conta) + (igual.complemento ? ' ' + igual.complemento : '') + ' de ' + reais(igual.valor) + ' (item ' + igual.id + ').' });
    const repetido = novos.findIndex((m, j) => j < k && m.conta === n.conta && chaveTexto(m.complemento) === chaveTexto(n.complemento) && (m.id_unidade || '') === (n.id_unidade || ''));
    if (repetido >= 0) avisos.push({ indice: k, tipo: 'item_duplicado', gravidade: 'alta', texto: 'Igual ao item ' + (repetido + 1) + ' desta lista.' });
  });
  return avisos;
}
// Corpo do arrecadacoes/put (campos da tela, conferidos no 167 em 23/10/2026).
function corpoComposicao(id, c, item) {
  const fim = somarMeses(c, item.meses - 1);
  const corpo = {
    ID_CONDOMINIO_COND: String(id), FL_QUANDO_ARRECADAR: item.meses === 1 ? 1 : 2, DT_INICIO_COT: sl(inicioMes(c)), DT_FIM_COT: sl(fimMes(fim)),
    FL_TIPOCOB_COT: item.boleto === 'extra' ? 2 : 1, FL_QUEM_SERA_COBRADO: item.tipo === 'item_unidade' ? 0 : 2, FL_QUAL_VALOR_SERA_ARRECADADO: 0,
    ST_CONTA_CONT: item.conta, ID_CONTABANCO_CB: item.id_conta, VL_VALOR_COT: item.valor.toFixed(2), ST_COMPLEMENTO_COT: item.complemento,
    FL_EXIBIRPARCELA_COT: item.meses > 1 ? 1 : 0, salvar: 'Salvar',
  };
  if (item.tipo === 'item_unidade') corpo.ID_UNIDADE_UNI = item.id_unidade;
  return corpo;
}
function descreverItem(item, c) {
  const fim = somarMeses(c, item.meses - 1);
  return (item.tipo === 'item_unidade' ? 'Unidade ' + item.id_unidade + ': ' : 'Todas as unidades: ') + item.complemento + ' (' + item.conta + '), ' + reais(item.valor)
    + (item.meses === 1 ? ' só em ' + c.rotulo : ' por mês de ' + c.rotulo + ' a ' + fim.rotulo + ' (' + item.meses + ' parcelas)') + (item.boleto === 'extra' ? ', no boleto extra' : '');
}
// Resposta do Superlógica: erro pode vir com HTTP 200 ou 206; vale o status do corpo.
function corpoOk(r) {
  const j = r && r.json;
  const item = Array.isArray(j) ? j[0] : (j && Array.isArray(j.data) && j.multipleresponse ? j.data[0] : j);
  const ok = !!r && r.status >= 200 && r.status < 300 && !!item && typeof item === 'object' && String(item.status) === '200';
  return { ok, item, msg: item && item.msg ? limpar(item.msg).slice(0, 200) : (r && r.status ? 'HTTP ' + r.status : 'sem resposta') };
}

// ── 3. Conferência antes de gerar ─────────────────────────────────────────

// Relatório 074A (simulação das arrecadações) em json: [{ tipo:'tabela', colunas, linhas, totais }].
function lerTabela074A(j) {
  const t = (Array.isArray(j) ? j : [j]).find((x) => x && x.tipo === 'tabela' && Array.isArray(x.colunas));
  if (!t) return null;
  const cols = t.colunas.map((c) => semAcento(c));
  const iU = cols.findIndex((c) => /unidade/.test(c));
  const iT = cols.findIndex((c) => /total|valor/.test(c));
  const iV = cols.findIndex((c) => /vencimento/.test(c));
  const linhas = (Array.isArray(t.linhas) ? t.linhas : []).filter(Array.isArray).map((l) => ({
    unidade: limpar(l[iU >= 0 ? iU : 0]).slice(0, 60), vencimento: iV >= 0 ? isoDeBR(l[iV]) : '', total: cent(num(l[iT >= 0 ? iT : l.length - 1])),
  })).filter((l) => l.unidade && !/^total/i.test(l.unidade));
  return { colunas: t.colunas.map(limpar), linhas };
}
async function lerSimulacao(cliente, id) {
  const j = await cliente.get('relatorios/id/074A', { ID_CONDOMINIO_COND: id, render: 'json' });
  const t = lerTabela074A(j);
  if (!t) { const e = new Error('simulacao_formato'); e.status = 502; throw e; }
  return t;
}

// Unidade pelo texto: "A 101", "101/A" e "101 - A" viram a mesma chave.
function chaveUnidade(txt) {
  return semAcento(txt).replace(/\b(bloco|bl|torre|apto|apt|ap|unidade|casa|sala|loja|lote)\b\.?/g, ' ').split(/[^a-z0-9]+/).filter(Boolean)
    .map((p) => p.replace(/^0+(?=\d)/, '')).sort().join(' ');
}

// Cobranças válidas do mês (para o histórico), página a página, até 2.000.
async function puxarCobrancas(cliente, id, c) {
  const jan = T27.janela({ ano: c.ano, mes: c.mes });
  const out = [];
  for (let pg = 1; pg <= 40; pg++) {
    const j = await cliente.get('cobranca/index', { idCondominio: id, status: 'validos', dtInicio: jan.dtInicio, dtFim: jan.dtFim, comDadosDasApropriacoes: 1,
      comDadosDasContasEReceitas: 1, comDadosDasUnidades: 1, itensPorPagina: POR_PAGINA, pagina: pg });
    if (!Array.isArray(j)) { const e = new Error('resposta_sem_lista'); e.status = 502; throw e; }
    j.forEach((x) => out.push(T27.normalizar(x)));
    if (j.length < POR_PAGINA) break;
  }
  return { competencia: c.chave, cobrancas: out };
}

// Análise pura da conferência antes de gerar.
// e: { comp, hoje, vencimento, simulacao, composicoes, historico: [{ competencia, cobrancas }], leituras: { agua, gas } }
function conferirAntes(e) {
  const alertas = [];
  const add = (a) => alertas.push(a);
  const sim = e.simulacao || { linhas: [] };
  const hist = (e.historico || []).map((h) => ({ competencia: h.competencia, mapa: T27.porUnidade(h.cobrancas || []) }));
  // Histórico por chave do texto da unidade.
  const porChave = new Map();
  hist.forEach((h, k) => h.mapa.forEach((u) => {
    const ch = chaveUnidade(u.unidade);
    if (!ch) return;
    if (!porChave.has(ch)) porChave.set(ch, { unidade: u.unidade, totais: new Array(hist.length).fill(null) });
    porChave.get(ch).totais[k] = cent((porChave.get(ch).totais[k] || 0) + u.total);
  }));
  const simPorChave = new Map();
  sim.linhas.forEach((l) => { const ch = chaveUnidade(l.unidade); const a = simPorChave.get(ch); simPorChave.set(ch, a ? { unidade: l.unidade, total: cent(a.total + l.total), n: a.n + 1 } : { unidade: l.unidade, total: l.total, n: 1 }); });

  // Prazo.
  if (e.vencimento && e.hoje) {
    const faltam = dias(e.hoje, e.vencimento);
    const limite = maisDias(e.vencimento, -ANTECEDENCIA_LOTE);
    if (faltam < ENVIO_MIN) add({ tipo: 'prazo', gravidade: 'alta', unidade: 'Todas', texto: 'Faltam ' + faltam + ' dias para o vencimento (' + br(e.vencimento) + '): o boleto não chega com 7 dias de antecedência.' });
    else if (e.hoje > limite) add({ tipo: 'prazo', gravidade: 'media', unidade: 'Todas', texto: 'A data limite para o lote era ' + br(limite) + '. Gere hoje para o boleto sair pelo menos 7 dias antes.' });
  }

  if (!sim.linhas.length) {
    add({ tipo: 'simulacao_vazia', gravidade: 'alta', unidade: 'Todas', texto: 'A simulação do Superlógica (relatório 074A) veio sem nenhuma unidade. Confira a composição e simule pela tela antes de gerar.' });
  } else {
    simPorChave.forEach((s, ch) => {
      const h = porChave.get(ch);
      if (s.n > 1) add({ tipo: 'boleto_em_dobro', gravidade: 'alta', unidade: s.unidade, texto: s.n + ' boletos simulados para a mesma unidade.' });
      const passados = h ? h.totais.filter((v) => v != null) : [];
      if (!passados.length) { if (hist.length) add({ tipo: 'unidade_nova', gravidade: 'baixa', unidade: s.unidade, texto: 'Unidade sem boleto nos ' + hist.length + ' meses anteriores. Confira se é nova.' }); return; }
      const media = cent(passados.reduce((a, b) => a + b, 0) / passados.length);
      if (!(s.total > 0)) add({ tipo: 'valor_zerado', gravidade: 'alta', unidade: s.unidade, texto: 'Boleto simulado com valor zero; a média era ' + reais(media) + '.' });
      else if (media > 0 && (s.total > FATOR_ALTO * media || s.total < FATOR_BAIXO * media)) {
        add({ tipo: 'valor_fora_padrao', gravidade: 'alta', unidade: s.unidade, valor: s.total, referencia: media,
          texto: (s.total > media ? 'Muito maior' : 'Muito menor') + ' que a média: ' + reais(s.total) + ' contra ' + reais(media) + ' nos ' + passados.length + ' meses anteriores (' + (s.total / media).toFixed(2).replace('.', ',') + ' vez).' });
      }
    });
    porChave.forEach((h, ch) => {
      if (simPorChave.has(ch)) return;
      const meses = h.totais.filter((v) => v != null).length;
      if (!meses) return;
      add({ tipo: 'sem_boleto', gravidade: meses === hist.length ? 'alta' : 'media', unidade: h.unidade, texto: 'Sem boleto na simulação; teve boleto em ' + meses + ' dos ' + hist.length + ' meses anteriores.' });
    });
  }

  // Leituras de consumo (água e gás) do mês de leitura.
  const comp = e.composicoes || [];
  ['agua', 'gas'].forEach((k) => {
    const lista = e.leituras && e.leituras[k];
    if (!Array.isArray(lista) || !lista.length) return;
    const nome = k === 'agua' ? 'água' : 'gás';
    const comHist = lista.filter((u) => u.anterior != null);
    const lancadas = comHist.filter((u) => u.atual != null);
    if (comHist.length && !lancadas.length) {
      add({ tipo: 'leitura_faltando', gravidade: 'alta', unidade: 'Todas', texto: 'Nenhuma leitura de ' + nome + ' lançada no mês (' + comHist.length + ' unidades tinham leitura no mês anterior).' });
    } else {
      comHist.filter((u) => u.atual == null).forEach((u) => add({ tipo: 'leitura_faltando', gravidade: 'alta', unidade: (u.bloco ? u.bloco + ' ' : '') + u.unidade, texto: 'Leitura de ' + nome + ' não lançada (anterior ' + u.anterior + ').' }));
      lancadas.filter((u) => u.atual === u.anterior || (u.anterior > 0 && u.atual === 0)).forEach((u) => add({ tipo: 'leitura_zerada', gravidade: 'media', unidade: (u.bloco ? u.bloco + ' ' : '') + u.unidade,
        texto: 'Leitura de ' + nome + ' ' + (u.atual === 0 ? 'zerada' : 'igual à anterior (consumo zero)') + ': ' + u.atual + '.' }));
    }
    if (lancadas.length && !comp.some((x) => x.tipo === 'leitura')) add({ tipo: 'consumo_fora', gravidade: 'alta', unidade: 'Todas', texto: 'Há leituras de ' + nome + ' no mês, mas nenhum item de consumo na composição.' });
  });

  // Itens da composição: duplicados e taxa extra fora do período.
  const ini = inicioMes(e.comp), fim = fimMes(e.comp);
  comp.forEach((a, i) => {
    const dup = comp.findIndex((b, j) => j < i && b.conta === a.conta && b.quem === a.quem && b.id_unidade === a.id_unidade
      && (chaveTexto(b.complemento) === chaveTexto(a.complemento)) && Math.abs(b.valor - a.valor) < 0.005);
    if (dup >= 0) add({ tipo: 'item_duplicado', gravidade: 'alta', unidade: a.quem === 'unidade' ? a.unidade || ('unidade ' + a.id_unidade) : 'Todas', texto: 'Item repetido na composição: ' + a.nome + (a.complemento ? ' ' + a.complemento : '') + ' ' + reais(a.valor) + ' (itens ' + comp[dup].id + ' e ' + a.id + ').' });
    if (a.tipo !== 'extra') return;
    const p = T27.parcela(a.complemento);
    if ((a.fim && a.fim < ini) || (a.inicio && a.inicio > fim)) add({ tipo: 'extra_fora_periodo', gravidade: 'alta', unidade: 'Todas', texto: a.nome + ' (item ' + a.id + ') vale de ' + br(a.inicio) + ' a ' + br(a.fim) + ', fora de ' + e.comp.rotulo + '.' });
    else if (p && p.n > p.de) add({ tipo: 'extra_fora_periodo', gravidade: 'alta', unidade: 'Todas', texto: a.nome + ' (item ' + a.id + ') com parcela ' + p.n + '/' + p.de + ': passou do número de parcelas.' });
    else if (!a.fim) add({ tipo: 'extra_sem_fim', gravidade: 'media', unidade: 'Todas', texto: a.nome + (a.complemento ? ' ' + a.complemento : '') + ' (item ' + a.id + ') não tem data de fim: vai cobrar todo mês. Confira se foi aprovado assim.' });
  });

  const PESO = { alta: 0, media: 1, baixa: 2 };
  alertas.sort((a, b) => (PESO[a.gravidade] - PESO[b.gravidade]) || (a.unidade === 'Todas' ? -1 : b.unidade === 'Todas' ? 1 : 0) || String(a.unidade).localeCompare(String(b.unidade), 'pt-BR', { numeric: true }));
  const graves = alertas.filter((a) => a.gravidade === 'alta').length;
  const porTipo = {};
  alertas.forEach((a) => { porTipo[a.tipo] = (porTipo[a.tipo] || 0) + 1; });
  return {
    competencia: e.comp.chave, vencimento: e.vencimento || '', pode_gerar: graves === 0,
    resumo: { unidades_simuladas: simPorChave.size, total_simulado: cent(sim.linhas.reduce((s, l) => s + l.total, 0)), composicoes: comp.length,
      meses_comparados: hist.map((h) => h.competencia), alertas: alertas.length, graves, por_tipo: porTipo },
    conferir: listaConferir(alertas, comp, e),
    alertas,
  };
}
// Lista curta "o que conferir" antes de clicar em gerar no Superlógica.
function listaConferir(alertas, comp, e) {
  const l = [];
  const n = (t) => alertas.filter((a) => a.tipo === t).length;
  if (n('prazo')) l.push('Prazo: ' + alertas.find((a) => a.tipo === 'prazo').texto);
  if (n('simulacao_vazia')) l.push('A simulação veio vazia: confira a composição e simule pela tela do Superlógica.');
  if (n('valor_fora_padrao') || n('valor_zerado')) l.push((n('valor_fora_padrao') + n('valor_zerado')) + ' unidade(s) com valor muito diferente da média: abra o boleto simulado de cada uma.');
  if (n('sem_boleto')) l.push(n('sem_boleto') + ' unidade(s) sem boleto na simulação: confira se a unidade foi vendida, desativada ou ficou de fora.');
  if (n('boleto_em_dobro')) l.push(n('boleto_em_dobro') + ' unidade(s) com mais de um boleto simulado.');
  if (n('leitura_faltando') || n('leitura_zerada')) l.push((n('leitura_faltando') + n('leitura_zerada')) + ' leitura(s) faltando ou zerada(s): confira na tela de Leitura de Consumo antes de gerar.');
  if (n('consumo_fora')) l.push('Item de consumo fora da composição: confira o item de água ou gás.');
  if (n('item_duplicado')) l.push(n('item_duplicado') + ' item(ns) repetido(s) na composição: exclua o que sobrou.');
  if (n('extra_fora_periodo') || n('extra_sem_fim')) l.push('Taxa extra fora do período ou sem data de fim: confira com a ata da assembleia.');
  const extras = comp.filter((a) => a.tipo === 'extra');
  if (extras.length) l.push('Taxas extras do mês (' + extras.length + '): ' + extras.slice(0, 5).map((a) => a.nome + (a.complemento ? ' ' + a.complemento : '') + ' ' + reais(a.valor)).join('; ') + (extras.length > 5 ? '; e outras' : '') + '. Confira com o aprovado.');
  l.push('Forma de recebimento e conta bancária: confira antes de gerar (veja o aviso de trocas do PJBank nesta tela).');
  l.push('Depois de gerar no Superlógica, rode a conferência dos boletos gerados (abaixo) antes de enviar.');
  return l;
}

// ── 4. Remessa ────────────────────────────────────────────────────────────

// remessa/pendente agrupado por conta. A forma exata com boletos pendentes ainda não foi vista
// (no 167 vem vazia): lê qualquer objeto com id_contabanco_cb e soma o que parecer quantidade.
function lerPendentesRemessa(j) {
  const out = new Map();
  const visitar = (x, nivel) => {
    if (nivel > 4 || x == null) return;
    if (Array.isArray(x)) { x.forEach((y) => visitar(y, nivel + 1)); return; }
    if (typeof x !== 'object') return;
    const conta = String(x.id_contabanco_cb || x.ID_CONTABANCO_CB || '');
    if (/^\d+$/.test(conta)) {
      const a = out.get(conta) || { id_conta: conta, conta: limpar(x.st_descricao_cb || x.st_conta_cb).slice(0, 80), quantidade: 0 };
      const q = ['quantidade', 'total', 'qtd', 'count', 'nm_recebimentos', 'recebimentos', 'contagem'].map((k) => x[k]).find((v) => v != null && /^\d+$/.test(String(v)));
      a.quantidade += q != null ? Number(q) : 1;
      out.set(conta, a);
      return;
    }
    Object.values(x).forEach((y) => { if (y && typeof y === 'object') visitar(y, nivel + 1); });
  };
  visitar(j, 0);
  return [...out.values()];
}
async function lerRemessaPendente(cliente, id) {
  let j;
  try { j = await cliente.get('remessa/pendente', { ID_CONDOMINIO_COND: id, contarRecebimentos: 1, agruparPorFormaDePagamento: 1, agrupadoPorConta: 1 }); }
  catch (e) { if (e && e.status === 206) j = e.corpo; else throw e; } // 206 vazio = nada pendente
  return lerPendentesRemessa(j);
}
const RX_LINK_SL = /^https:\/\/[a-z0-9.-]+\.superlogica\.(net|com)\//i;
function pareceCnab(t) {
  const linhas = String(t || '').split(/\r?\n/).filter((l) => l.length);
  if (linhas.length < 2) return null;
  const tam = linhas[0].length;
  if (!(tam === 240 || tam === 400) || !linhas.every((l) => l.length === tam)) return null;
  return { formato: 'CNAB ' + tam, linhas: linhas.length };
}
// Resposta do remessa/gerar: arquivo (texto CNAB), link para baixar no Superlógica, ou "nada a gerar".
function lerRespostaRemessa(r) {
  const texto = typeof r.texto === 'string' ? r.texto : '';
  const cnabCru = pareceCnab(texto);
  if (cnabCru) return { ok: true, arquivo: texto, formato: cnabCru.formato, linhas: cnabCru.linhas };
  const c = corpoOk(r);
  const msg = c.msg || '';
  if (/n[aã]o h[aá] remessas?/i.test(msg)) return { ok: false, nada: true, msg };
  let arquivo = null, link = null, formato = null, linhas = 0, idRemessa = null;
  const visitar = (x, nivel) => {
    if (nivel > 5 || x == null || (arquivo && link)) return;
    if (typeof x === 'string') {
      const cn = pareceCnab(x);
      if (cn && !arquivo) { arquivo = x; formato = cn.formato; linhas = cn.linhas; }
      else if (RX_LINK_SL.test(x) && !link) link = x;
      return;
    }
    if (typeof x !== 'object') return;
    if (!idRemessa && /^\d+$/.test(String(x.id_remessa_rem || ''))) idRemessa = String(x.id_remessa_rem);
    Object.values(x).forEach((y) => visitar(y, nivel + 1));
  };
  visitar(r.json, 0);
  if (!c.ok && !arquivo && !link) return { ok: false, msg: msg || 'O Superlógica não gerou a remessa.' };
  return { ok: true, arquivo, formato, linhas, link, id_remessa: idRemessa, msg };
}

// ── 5. Régua de cobrança ──────────────────────────────────────────────────

const ORD = ['primeira', 'segunda', 'terceira', 'quarta'];
// Só estes campos saem do servidor. Todo o resto da leitura (423 chaves, com chaves da empresa) fica aqui.
const CAMPOS_REGUA = [].concat(
  ...ORD.map((o) => ['fl_' + o + 'notificacao_email', 'nm_dias' + o + 'notificacao_email']),
  ...['primeira', 'segunda'].map((o) => ['fl_' + o + 'notificacao_sms', 'nm_dias' + o + 'notificacao_sms']),
  ['implantacao_pendente', 'fl_status_implantacao']
);
function hashOutras(obj) {
  const ks = Object.keys(obj || {}).filter((k) => !CAMPOS_REGUA.includes(k)).sort();
  return { qtd: ks.length, porChave: new Map(ks.map((k) => [k, crypto.createHash('sha256').update(String(obj[k])).digest('hex').slice(0, 16)])) };
}
// Lê a régua. Devolve { campos (só a lista acima), _outras (só no servidor) }.
async function lerRegua(cliente, id) {
  const j = await cliente.get('notificacaoautomatica/index', { ID_CONDOMINIO_COND: id, idCondominio: id });
  const o = Array.isArray(j) ? j[0] : (j && Array.isArray(j.data) ? j.data[0] : j);
  if (!o || typeof o !== 'object' || !('fl_primeiranotificacao_email' in o)) { const e = new Error('regua_formato'); e.status = 502; throw e; }
  const campos = {};
  CAMPOS_REGUA.forEach((k) => { campos[k] = o[k] == null ? '' : String(o[k]).slice(0, 12); });
  return { campos, _outras: hashOutras(o) };
}
const NOME_ENVIO = { primeira: '1º email', segunda: '2º email', terceira: '3º email', quarta: '4º email' };
function quando(d) { const n = parseInt(d, 10); if (!isFinite(n)) return 'sem prazo'; return n < 0 ? (-n) + (n === -1 ? ' dia' : ' dias') + ' antes do vencimento' : n === 0 ? 'no dia do vencimento' : n + (n === 1 ? ' dia' : ' dias') + ' depois do vencimento'; }
// Régua para a tela: envios de email e SMS, e o selo "Desativada" com a causa provável.
function descreverRegua(campos) {
  const envios = ORD.map((o) => ({ envio: NOME_ENVIO[o], canal: 'email', ligado: campos['fl_' + o + 'notificacao_email'] === '1', dias: parseInt(campos['nm_dias' + o + 'notificacao_email'], 10), quando: quando(campos['nm_dias' + o + 'notificacao_email']) }));
  ['primeira', 'segunda'].forEach((o, k) => envios.push({ envio: (k + 1) + 'º SMS', canal: 'sms', ligado: campos['fl_' + o + 'notificacao_sms'] === '1', dias: parseInt(campos['nm_dias' + o + 'notificacao_sms'], 10), quando: quando(campos['nm_dias' + o + 'notificacao_sms']) }));
  const pendente = campos.implantacao_pendente === '1' || campos.fl_status_implantacao === '0';
  return { envios, desativada: pendente,
    causa: pendente ? 'O condomínio ainda está em implantação no Superlógica (implantacao_pendente). Enquanto a implantação e o envio de boletos não forem concluídos, a régua aparece como Desativada e não envia, mesmo com os prazos configurados.' : '' };
}
// Retorno automático: pelo menos 80% das cobranças pagas no mês anterior baixadas sem arquivo de
// retorno subido à mão (PJBank faz isso sozinho). Sem pagas suficientes, fica desconhecido (não ativo).
function retornoAutomatico(rows) {
  const pagas = (Array.isArray(rows) ? rows : []).filter((r) => r && String(r.fl_status_recb) === '3');
  const semArquivo = pagas.filter((r) => !limpar(r.st_arqret_recb)).length;
  const parte = pagas.length ? semArquivo / pagas.length : 0;
  const ativo = pagas.length >= RETORNO_AUTO_MINIMO && parte >= RETORNO_AUTO_PARTE;
  return { ativo, conhecido: pagas.length >= RETORNO_AUTO_MINIMO, pagas: pagas.length, sem_arquivo: semArquivo, por_arquivo: pagas.length - semArquivo,
    texto: pagas.length < RETORNO_AUTO_MINIMO ? 'Poucas cobranças pagas no mês anterior para saber se o retorno é automático: o aviso de atraso fica desligado.'
      : ativo ? 'Retorno automático ativo: ' + semArquivo + ' de ' + pagas.length + ' pagas baixadas sem arquivo de retorno.'
        : 'Retorno feito à mão: ' + (pagas.length - semArquivo) + ' de ' + pagas.length + ' pagas baixadas por arquivo de retorno. O aviso de atraso fica desligado para não cobrar quem já pagou.' };
}
async function lerRetornoAutomatico(cliente, id, hoje) {
  const c = somarMeses(competencia(hoje.slice(0, 7)), -1);
  const rows = [];
  for (let pg = 1; pg <= 4; pg++) {
    const j = await cliente.get('cobranca/index', { idCondominio: id, status: 'validos', dtInicio: sl(inicioMes(c)), dtFim: sl(fimMes(c)), apenasColunasPrincipais: 1, itensPorPagina: POR_PAGINA, pagina: pg });
    if (!Array.isArray(j)) break;
    rows.push(...j);
    if (j.length < POR_PAGINA) break;
  }
  return Object.assign(retornoAutomatico(rows), { competencia: c.chave });
}
// Corpo do putnotificacaoemail com o padrão do dono. O 4º email continua como está quando o retorno
// é automático e é desligado quando não é (também cobra depois do vencimento).
function corpoReguaPadrao(id, campos, retornoAtivo) {
  const quartaDias = Math.abs(parseInt(campos.nm_diasquartanotificacao_email, 10) || 20);
  return {
    ID_CONDOMINIO_COND: String(id),
    FL_PRIMEIRANOTIFICACAO_EMAIL: 1, NM_DIASPRIMEIRANOTIFICACAO_EMAIL: REGUA_PADRAO.antes, PERIODOPRIMEIRANOTEMAIL: -1,
    FL_SEGUNDANOTIFICACAO_EMAIL: 1, NM_DIASSEGUNDANOTIFICACAO_EMAIL: REGUA_PADRAO.no_dia, PERIODOSEGUNDANOTEMAIL: 0,
    FL_TERCEIRANOTIFICACAO_EMAIL: retornoAtivo ? 1 : 0, NM_DIASTERCEIRANOTIFICACAO_EMAIL: REGUA_PADRAO.depois, PERIODOTERCEIRANOTEMAIL: 1,
    FL_QUARTANOTIFICACAO_EMAIL: retornoAtivo && campos.fl_quartanotificacao_email === '1' ? 1 : 0, NM_DIASQUARTANOTIFICACAO_EMAIL: quartaDias,
  };
}
// Corpo que regrava a régua como estava (para desfazer no condomínio de teste).
function corpoReguaDe(id, campos) {
  const c = { ID_CONDOMINIO_COND: String(id) };
  ['primeira', 'segunda', 'terceira'].forEach((o) => {
    const d = parseInt(campos['nm_dias' + o + 'notificacao_email'], 10) || 0;
    const O = o.toUpperCase();
    c['FL_' + O + 'NOTIFICACAO_EMAIL'] = campos['fl_' + o + 'notificacao_email'] === '1' ? 1 : 0;
    c['NM_DIAS' + O + 'NOTIFICACAO_EMAIL'] = Math.abs(d);
    c['PERIODO' + O + 'NOTEMAIL'] = d < 0 ? -1 : d === 0 ? 0 : 1;
  });
  c.FL_QUARTANOTIFICACAO_EMAIL = campos.fl_quartanotificacao_email === '1' ? 1 : 0;
  c.NM_DIASQUARTANOTIFICACAO_EMAIL = Math.abs(parseInt(campos.nm_diasquartanotificacao_email, 10) || 0);
  return c;
}
// Campos esperados na releitura depois de gravar o corpo (os dias "antes" voltam negativos).
function esperadoRegua(corpo) {
  const out = {};
  ['primeira', 'segunda', 'terceira'].forEach((o) => {
    const O = o.toUpperCase();
    out['fl_' + o + 'notificacao_email'] = String(corpo['FL_' + O + 'NOTIFICACAO_EMAIL']);
    const d = Number(corpo['NM_DIAS' + O + 'NOTIFICACAO_EMAIL']);
    out['nm_dias' + o + 'notificacao_email'] = String(corpo['PERIODO' + O + 'NOTEMAIL'] === -1 ? -d : d);
  });
  out.fl_quartanotificacao_email = String(corpo.FL_QUARTANOTIFICACAO_EMAIL);
  out.nm_diasquartanotificacao_email = String(corpo.NM_DIASQUARTANOTIFICACAO_EMAIL);
  return out;
}
// Compara a releitura com o esperado e conta outras chaves que mudaram (sem dizer quais nem o valor).
function conferirRegua(antes, depois, corpo) {
  const esp = esperadoRegua(corpo);
  const diferentes = Object.keys(esp).filter((k) => Number(depois.campos[k]) !== Number(esp[k]));
  let outras = 0;
  if (antes._outras && depois._outras) depois._outras.porChave.forEach((h, k) => { if (antes._outras.porChave.get(k) !== h) outras++; });
  return { ok: diferentes.length === 0, diferentes, outras_chaves_mudaram: outras };
}
function diffRegua(campos, corpo) {
  const esp = esperadoRegua(corpo);
  return Object.keys(esp).filter((k) => Number(campos[k]) !== Number(esp[k]) && !(k.startsWith('nm_') && esp[k.replace('nm_dias', 'fl_')] === '0' && campos[k.replace('nm_dias', 'fl_')] !== '1'))
    .map((k) => ({ campo: k, agora: campos[k], depois: esp[k] }));
}

// ── 6. Trocas da forma de recebimento (PJBank) ────────────────────────────

const RX_FORMA = /Forma de recebimento\s*#(\d+)\s*(.*?)\s*alterada de (.+?) para (.+?)(?:\.\s*\((PJBank)\))?\.?\s*$/i;
const RX_FORMA_PARA = /Forma de recebimento\s*#(\d+)\s*alterada para (.+?)\.?\s*$/i;
const RX_PRINCIPAL = /Forma de recebimento\s*#(\d+)\s*(.*?)\s*definida como forma principal/i;
// Linha da auditoria para evento. Linhas de detalhe ("alterada. AMBIENTE DE PRODUÇÃO de ...") ficam fora.
function eventoForma(r) {
  const t = limpar(r && r.st_texto_aud);
  if (!/Forma de recebimento/i.test(t)) return null;
  const quandoIso = (() => { const m = String(r.dt_data_aud || '').match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2})/); return m ? m[3] + '-' + m[1] + '-' + m[2] + ' ' + m[4] : ''; })();
  const base = { quando: quandoIso, quem: limpar(r.st_apelido_usu).slice(0, 60) || 'sem nome' };
  let m = t.match(RX_FORMA);
  if (m) return Object.assign(base, { tipo: 'estado', forma: '#' + m[1], descricao: m[2].slice(0, 60), de: m[3].slice(0, 40), para: m[4].replace(/\.$/, '').slice(0, 40), pjbank: !!m[5] });
  m = t.match(RX_FORMA_PARA);
  if (m) return Object.assign(base, { tipo: 'estado', forma: '#' + m[1], descricao: '', de: '', para: m[2].slice(0, 40), pjbank: false });
  m = t.match(RX_PRINCIPAL);
  if (m) return Object.assign(base, { tipo: 'principal', forma: '#' + m[1], descricao: m[2].slice(0, 60) });
  return null;
}
// Lê a auditoria do condomínio de 7 em 7 dias e guarda só as linhas da forma de recebimento dele.
async function lerTrocasForma(cliente, id, inicio, fim) {
  const eventos = [];
  const falhas = [];
  for (let a = inicio; a <= fim; a = maisDias(a, 7)) {
    const b = maisDias(a, 6) < fim ? maisDias(a, 6) : fim;
    let j = null;
    try { j = await cliente.get('auditoria/index', { idCondominio: id, dtInicio: sl(a), dtFim: sl(b) }); } catch (e) { falhas.push(br(a) + ' a ' + br(b)); continue; }
    if (!Array.isArray(j)) { falhas.push(br(a) + ' a ' + br(b)); continue; }
    for (const r of j) {
      if (!r || String(r.st_sql_aud) !== String(id)) continue;
      const ev = eventoForma(r);
      if (ev) eventos.push(ev);
    }
  }
  return { eventos, falhas };
}
function resumoTrocas(eventos, inicio, fim) {
  const lista = eventos.slice().sort((a, b) => b.quando.localeCompare(a.quando));
  const estados = lista.filter((e) => e.tipo === 'estado');
  const diasCom = [...new Set(estados.map((e) => e.quando.slice(0, 10)))].sort();
  const meses = [...new Set(diasCom.map((d) => d.slice(0, 7)))].sort();
  const quem = {};
  estados.forEach((e) => { quem[e.quem] = (quem[e.quem] || 0) + 1; });
  const mensal = meses.length >= 2;
  const pj = estados.some((e) => e.pjbank || /conting/i.test(e.de + e.para));
  const texto = !estados.length ? 'Nenhuma troca da forma de recebimento de ' + br(inicio) + ' a ' + br(fim) + '.'
    : 'Forma de recebimento trocada à mão em ' + diasCom.length + (diasCom.length === 1 ? ' dia' : ' dias') + ' (' + meses.map((m) => m.slice(5, 7) + '/' + m.slice(0, 4)).join(', ') + '), última em '
      + br(estados[0].quando.slice(0, 10)) + ' por ' + estados[0].quem + '.' + (mensal ? ' Acontece todo mês: entender o motivo com a equipe antes de automatizar a geração deste condomínio.' : '');
  return { periodo: { inicio, fim }, trocas: estados.length, dias_com_troca: diasCom, meses_com_troca: meses, todo_mes: mensal, pjbank: pj, por_pessoa: quem,
    ultima: estados[0] || null, texto, eventos: lista.slice(0, 200) };
}

module.exports = {
  NAO_CONDOMINIOS, ID_TESTE, ANTECEDENCIA_LOTE, ENVIO_MIN, REGUA_PADRAO, TIPOS_ITEM, MAX_ITENS, CAMPOS_REGUA,
  competencia, somarMeses, inicioMes, fimMes, vencimentoEm, proximoVencimento, maisDias, dias, hojeSP, br, sl,
  lerCondominios, enxugarCondominio, resumirLote, loteDoMes, situacaoCalendario, montarCalendario,
  normalizarComposicao, lerComposicoes, lerContas, lerUnidades, validarItem, conferirItensNovos, corpoComposicao, descreverItem, corpoOk,
  lerTabela074A, lerSimulacao, chaveUnidade, puxarCobrancas, conferirAntes,
  lerPendentesRemessa, lerRemessaPendente, pareceCnab, lerRespostaRemessa,
  lerRegua, descreverRegua, retornoAutomatico, lerRetornoAutomatico, corpoReguaPadrao, corpoReguaDe, esperadoRegua, conferirRegua, diffRegua,
  eventoForma, lerTrocasForma, resumoTrocas,
};
