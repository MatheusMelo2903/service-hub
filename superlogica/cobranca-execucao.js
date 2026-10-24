'use strict';
// Execução da cobrança pelo Hub (frente cobrança, acordos e cadastro). Lógica e chamadas ao
// Superlógica; as rotas, travas e a política de gravação ficam em servico/rotas-cobranca-execucao.js.
//
// O que grava no Superlógica (sempre pela política única, servico/escrita-superlogica.js):
//  1. Acordo à vista: acordos/put (campos da coleção oficial: COBS_ORIGEM, RECEITA_APROPRIACAO,
//     PARCELAS) e acordos/desfazer. Antes de gravar o Hub confere: unidade em atraso, sem acordo
//     aberto e sem processo; valor das composições igual ao débito atualizado da inadimplência;
//     honorário e taxas dentro da política do condomínio; simulação com uma parcela igual ao total.
//     Avisa quando a instrução do boleto de acordo é "não receber após o vencimento".
//  2. Contato de cobrança no CRM: historicocobranca/ (FL_VIA_API=1), com identificador do Hub.
//  3. Status financeiro da unidade (o que guia a régua): unidades/post com FL_STATUSFIN_UNI.
//  4. Cadastro: unidades/post (contatos e segundo sacado) e contatos/delete (saída).
// Depois de cada gravação o Hub relê e compara. Sem resposta do Superlógica (queda ou 504) o
// resultado é incerto e nada é repetido.
// Nenhuma função aqui manda mensagem a condômino (nem email, nem SMS, nem WhatsApp).
//
// sl: { ler(rota, params) -> json (com repetição), gravar(metodo, rota, campos) -> { status, json } }.

const crypto = require('crypto');

const POR_PAGINA = 50;
const STATUS_FIN = { 0: 'nenhuma notificação', 1: 'primeira notificação', 2: 'segunda notificação', 3: 'terceira notificação', 10: 'jurídico' };
const CANAIS = { 1: 'telefone', 2: 'email', 3: 'SMS', 4: 'carta', 5: 'presencial', 6: 'aplicativo de mensagem', 7: 'outros' };
const RESULTADOS = { 1: 'Efetivo', 2: 'Acordo', 3: 'Pago', 4: 'Promessa', 5: 'Não efetivo', 6: 'Não concorda', 7: 'Retornar contato', 8: 'Sem contato', 9: 'Telefone errado', 10: 'Não atende', 11: 'Ocupado', 12: 'Outros' };
const MOTIVOS = { 1: 'Problema financeiro', 2: 'Não recebeu cobrança', 3: 'Não concorda com cobrança', 10: 'Outros' };
const DIA = 86400000;
const RECENTE_DIAS = 120;

const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;
const doisDig = (n) => String(n).padStart(2, '0');
const dataSL = (d) => doisDig(d.getMonth() + 1) + '/' + doisDig(d.getDate()) + '/' + d.getFullYear();
const dataBR = (d) => (d ? doisDig(d.getDate()) + '/' + doisDig(d.getMonth() + 1) + '/' + d.getFullYear() : '');
const brl = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function lerDataSL(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(+m[3], +m[1] - 1, +m[2]);
  return isNaN(d) ? null : d;
}
const diasEntre = (a, b) => Math.round((b - a) / DIA);
function erro(codigo, status, extra) { const e = new Error(codigo); e.status = status || 422; Object.assign(e, extra || {}); return e; }

// Listagem paginada (o Superlógica entrega no máximo 50 por página). Marca cortado no teto.
async function paginas(sl, rota, params, max) {
  const out = [];
  for (let pg = 1; pg <= max; pg++) {
    const j = await sl.ler(rota, Object.assign({}, params, { itensPorPagina: POR_PAGINA, pagina: pg }));
    if (!Array.isArray(j) || !j.length) break;
    j.forEach((x) => out.push(x));
    if (j.length < POR_PAGINA) break;
    if (pg === max) out.cortado = true;
  }
  return out;
}

// O Superlógica responde erro com HTTP 200 ou 206: decide pelo status do corpo.
function corpoOk(r) {
  const item = Array.isArray(r && r.json) ? r.json[0] : (r && r.json);
  const ok = !!r && r.status >= 200 && r.status < 300 && !!item && typeof item === 'object' && String(item.status) === '200';
  return { ok, item, msg: item && item.msg ? limpar(item.msg).slice(0, 200) : (r && r.status ? 'HTTP ' + r.status : 'sem resposta') };
}
const semResposta = (r) => !r || !r.status || r.status === 504;

// ── Dados pessoais: só o necessário sai do servidor ──────────────────────────────────────────
function mascararCpf(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 14 ? '**.***.***/****-' + d.slice(12) : '***.***.***-' + d.slice(-2);
}
function mascararTelefone(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d ? '(**) ****' + d.slice(-4) : '';
}
function mascararEmail(v) {
  const s = limpar(v).toLowerCase();
  const m = s.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m) return s ? '***' : '';
  return m[1].slice(0, 1) + '***@' + m[2];
}
// Texto livre sem email, telefone ou CPF (vai para o CRM e para a tela).
function semDadosPessoais(t, max) {
  return limpar(t).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?\(?\d[\d\s().\/-]{6,}\d/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '[número]' : m)).slice(0, max || 500);
}
function cpfValido(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 11) {
    if (/^(\d)\1+$/.test(d)) return false;
    const dig = (n) => { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return dig(9) === +d[9] && dig(10) === +d[10];
  }
  if (d.length === 14) {
    if (/^(\d)\1+$/.test(d)) return false;
    const calc = (n) => { const p = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let s = 0; for (let i = 0; i < n; i++) s += +d[i] * p[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return calc(12) === +d[12] && calc(13) === +d[13];
  }
  return false;
}
const emailValido = (v) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(limpar(v));
const telefoneValido = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 10 || d.length === 11; };

// ── Leituras ───────────────────────────────────────────────────────────────────────────────
// Configuração do condomínio só com o que a cobrança usa (a resposta inteira mistura chaves da
// licença e nunca vai para a tela).
async function lerConfig(sl, id) {
  const j = await sl.ler('configuracoes', { idCondominio: id });
  const o = (Array.isArray(j) ? j[0] : j) || {};
  const n = (k) => (limpar(o[k]) === '' ? null : num(o[k]));
  return {
    juros: n('nm_txjuros_cond'), multa: n('nm_txmulta_cond'),
    juros_acordo: n('nm_txjurosacordo_cond'), multa_acordo: n('nm_txmultaacordo_cond'),
    honorarios_pct: n('nm_txhonorario_cond'),
    instrucao_acordo: limpar(o.instrucao_cobranca_acordo1), instrucao_boleto: limpar(o.instrucao_cobranca1),
    conta_honorario: limpar(o.conta_receitas_honorario), conta_acordo: limpar(o.conta_receitas_acordo), conta_custo: limpar(o.conta_receitas_custoacordo),
    nao_separar: limpar(o.acordo_naosepararcomposicao),
    regua_por: limpar(o.regua_notificacao_por),
    dias_carta1: n('nm_diasprimeiranotificacao_carta'), dias_carta2: n('nm_diassegundanotificacao_carta'), dias_judicial: n('nm_diasnotificacaojudicial_judicial'),
    carta1: limpar(o.fl_primeiranotificacao_carta) === '1', carta2: limpar(o.fl_segundanotificacao_carta) === '1', judicial: limpar(o.fl_notificacaojudicial_judicial) === '1',
  };
}

async function contaPrincipal(sl, id) {
  const contas = await sl.ler('contabancos/index', { idCondominio: id, exibirContasAtivas: 1 });
  const lista = Array.isArray(contas) ? contas.filter((x) => !limpar(x.dt_datafechamento_cb) && String(x.id_condominio_cond || id) === String(id)) : [];
  const c = lista.find((x) => String(x.fl_principal_cb) === '1') || lista[0];
  if (!c) throw erro('sem_conta');
  return { id: String(c.id_contabanco_cb), descricao: limpar(c.st_descricao_cb), indisponibiliza_acordo: String(c.fl_remessaindisponibilizaracordo_cb) === '1', dias_indisponibiliza_acordo: limpar(c.nm_diasremessaindisponibilizaracordo_cb) };
}

// Uma cobrança da inadimplência com os encargos do dia (campos da coleção oficial).
function recDaInadimplencia(rc, hoje) {
  const enc = Array.isArray(rc.encargos) && rc.encargos[0] ? rc.encargos[0] : {};
  const det = enc.detalhes || {};
  const venc = lerDataSL(rc.dt_vencimento_recb);
  const valor = num(rc.vl_total_recb || rc.vl_emitido_recb);
  return {
    id: limpar(rc.id_recebimento_recb), vencimento: venc, valor: cent(valor),
    corrigido: cent(enc.valorcorrigido != null && limpar(enc.valorcorrigido) !== '' ? num(enc.valorcorrigido) : valor),
    dias: enc.diasatraso != null && limpar(enc.diasatraso) !== '' ? num(enc.diasatraso) : (venc ? Math.max(0, diasEntre(venc, hoje)) : 0),
    juros: cent(num(det.juros)), multa: cent(num(det.multa)), atualizacao: cent(num(det.atualizacaomonetaria)),
    honorarios: cent(num(det.honorarios)), desconto: cent(num(det.desconto)), custos: cent(num(det.outros_custos)),
    id_acordo: limpar(rc.id_acordo_recb), id_processo: limpar(rc.id_processo_proc), rotulo: limpar(rc.st_label_recb),
  };
}

// Inadimplência do condomínio na data, por unidade (nome do responsável só para a tela interna).
async function inadimplencia(sl, id, hoje) {
  const lista = await paginas(sl, 'inadimplencia/index', { idCondominio: id, posicaoEm: dataSL(hoje), comValoresAtualizados: 1, apenasResumoInad: 0 }, 20);
  const unidades = lista.map((u) => ({
    id_unidade: limpar(u.id_unidade_uni),
    unidade: limpar(u.st_unidade_uni) + (limpar(u.st_bloco_uni) ? ' ' + limpar(u.st_bloco_uni) : ''),
    responsavel: limpar(u.st_sacado_uni),
    status_fin: limpar(u.fl_statusfin_uni),
    juridico: num(u.saldo_juridico) > 0,
    recs: (Array.isArray(u.recebimento) ? u.recebimento : []).map((rc) => recDaInadimplencia(rc, hoje)).filter((r) => r.id),
  })).filter((u) => u.id_unidade);
  return { unidades, cortado: !!lista.cortado };
}

// Acordos da unidade nos últimos 5 anos, com as parcelas e as cobranças de origem.
// fl_tipo_acoi 10 = cobrança de origem, 11 = parcela do acordo. Parcela paga: liquidação preenchida
// ou status 3.
async function acordosDaUnidade(sl, id, idUnidade, hoje) {
  const ini = new Date(hoje.getFullYear() - 5, hoje.getMonth(), hoje.getDate());
  const lista = await paginas(sl, 'Acordos', { idCondominio: id, dtInicio: dataSL(ini), dtFim: dataSL(hoje), exibirDadosDasParcelas: 1 }, 40);
  return lista.filter((a) => limpar(a.id_unidade_uni) === String(idUnidade)).map((a) => {
    const recs = Array.isArray(a.recebimento) ? a.recebimento : [];
    const tipo = (r) => limpar(r.acordo_item && r.acordo_item[0] && r.acordo_item[0].fl_tipo_acoi);
    const parcelas = recs.filter((r) => tipo(r) === '11');
    const paga = (r) => !!limpar(r.dt_liquidacao_recb) || limpar(r.fl_status_recb) === '3';
    return {
      id: limpar(a.id_acordo_aco), data: lerDataSL(a.dt_acordo_aco), desfeito: lerDataSL(a.dt_desfeito_aco),
      condominio: limpar(a.id_condominio_cond), escritorio: !!limpar(a.id_escritorio_esc),
      origem: recs.filter((r) => tipo(r) === '10').map((r) => limpar(r.id_recebimento_recb)),
      parcelas: parcelas.map((r) => ({ id: limpar(r.id_recebimento_recb), vencimento: lerDataSL(r.dt_vencimento_recb), valor: cent(num(r.vl_total_recb)), paga: paga(r) })),
    };
  }).filter((a) => a.id);
}
const acordoAberto = (a) => !a.desfeito && a.parcelas.some((p) => !p.paga);

// Composições das cobranças escolhidas (o que vai para RECEITA_APROPRIACAO).
async function composicoes(sl, id, idUnidade, ids, hoje) {
  const p = { apenasColunasPrincipais: 1, semProcesso: 0, comValoresAtualizados: 1, status: 2, id: idUnidade,
    comHonorarios: 1, somenteComposicoesAcordo: 1, comDadosDasContasEReceitas: 1, comComposicoes: 1, dtAtualizacao: dataSL(hoje), idCondominio: id };
  ids.forEach((r, i) => { p['ids[' + i + ']'] = r; });
  const comp = await sl.ler('cobranca/index', p);
  const apro = (Array.isArray(comp) && comp[0] && Array.isArray(comp[0].receita_apropriacao)) ? comp[0].receita_apropriacao : [];
  return apro.map((a) => ({ conta: limpar(a.st_conta_cont), descricao: limpar(a.st_descricao_cont), complemento: limpar(a.st_complemento_rec), valor: cent(num(a.total_receita)) }))
    .filter((a) => a.conta);
}
// Conta de natureza despesa (começa com 2) entra subtraindo no total do acordo (regra da API).
const totalComposicoes = (apro) => cent(apro.reduce((s, a) => s + (a.conta.startsWith('2') ? -a.valor : a.valor), 0));

// ── Política de acordo ─────────────────────────────────────────────────────────────────────
// Campos guardados no Hub pela gestão (tabela cob_politica_acordo). Valida antes de gravar.
function validarPolitica(b) {
  const p = b || {};
  const out = {
    juros_pct: num(p.juros_pct), multa_pct: num(p.multa_pct), honorarios_pct: num(p.honorarios_pct),
    desconto_max_pct: num(p.desconto_max_pct), teto_automatico: cent(num(p.teto_automatico)),
    prazo_max_dias: Math.round(num(p.prazo_max_dias == null || p.prazo_max_dias === '' ? 10 : p.prazo_max_dias)),
    parcelas_max: Math.round(num(p.parcelas_max == null || p.parcelas_max === '' ? 1 : p.parcelas_max)),
    aprovada_sindico: p.aprovada_sindico === true,
    observacao: semDadosPessoais(p.observacao, 500),
  };
  const erros = [];
  if (!(out.juros_pct >= 0 && out.juros_pct <= 1)) erros.push('Juros entre 0% e 1% ao mês.');
  if (!(out.multa_pct >= 0 && out.multa_pct <= 2)) erros.push('Multa entre 0% e 2%.');
  if (!(out.honorarios_pct >= 0 && out.honorarios_pct <= 20)) erros.push('Honorários entre 0% e 20%.');
  if (!(out.desconto_max_pct >= 0 && out.desconto_max_pct <= 100)) erros.push('Desconto máximo entre 0% e 100% dos juros e da multa.');
  if (!(out.teto_automatico >= 0 && out.teto_automatico <= 1000000)) erros.push('Teto inválido.');
  if (!(out.prazo_max_dias >= 1 && out.prazo_max_dias <= 30)) erros.push('Prazo para pagar o acordo entre 1 e 30 dias.');
  if (!(out.parcelas_max >= 1 && out.parcelas_max <= 60)) erros.push('Parcelas entre 1 e 60.');
  return { politica: out, erros };
}

// "Não receber após o vencimento" na instrução do boleto de acordo (provável causa dos acordos
// desfeitos e refeitos no mesmo dia). Devolve o aviso ou null.
function avisoNaoReceber(instrucao) {
  const t = limpar(instrucao);
  if (!t) return null;
  const n = t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (/NAO\s+RECEBER\s+(APOS|DEPOIS\s+D[OE])\s+(O\s+)?(VENCIMENTO|VENCTO)/.test(n)) {
    return { codigo: 'nao_receber_apos_vencimento', grave: true, instrucao: t,
      texto: 'O boleto deste acordo sai com a instrução "' + t + '". Se o morador pagar um dia depois, o banco recusa e o acordo vai ter de ser desfeito e refeito. Combine a data com o morador ou peça para trocar a instrução por um prazo de tolerância.' };
  }
  const m = n.match(/NAO\s+RECEBER\s+APOS\s+(\d{1,3})\s+DIAS/);
  if (m) return { codigo: 'nao_receber_apos_dias', grave: false, instrucao: t, dias: +m[1], texto: 'O boleto deste acordo não é recebido ' + m[1] + ' dias depois do vencimento (instrução "' + t + '").' };
  return null;
}

// ── Acordo à vista ─────────────────────────────────────────────────────────────────────────
// Confere tudo e monta o plano do acordo, sem gravar. Devolve { ok, bloqueios, avisos, plano, sensivel }.
// bloqueio: { codigo, texto }. Sem política cadastrada, o Hub não monta acordo.
async function prepararAcordo(sl, { id, idUnidade, vencimento, hoje, politica }) {
  const bloqueios = []; const avisos = [];
  const bloq = (codigo, texto) => bloqueios.push({ codigo, texto });
  if (!politica) bloq('sem_politica', 'Este condomínio ainda não tem política de acordo cadastrada no Hub. A gestão cadastra antes.');
  const prazo = (politica && politica.prazo_max_dias) || 10;
  if (!vencimento || vencimento < hoje || diasEntre(hoje, vencimento) > prazo) bloq('vencimento_fora_do_prazo', 'O vencimento do acordo precisa ser entre hoje e ' + prazo + ' dias.');
  if (bloqueios.length) return { ok: false, bloqueios, avisos, plano: null };

  const inad = await inadimplencia(sl, id, hoje);
  const u = inad.unidades.find((x) => x.id_unidade === String(idUnidade));
  if (!u) { bloq('unidade_sem_atraso', 'Essa unidade não tem cobrança vencida neste condomínio.'); return { ok: false, bloqueios, avisos, plano: null }; }
  const vencidas = u.recs.filter((r) => r.vencimento && r.vencimento < hoje);
  const deAcordo = u.recs.filter((r) => r.id_acordo);
  const origem = vencidas.filter((r) => !r.id_acordo);
  if (deAcordo.length) bloq('acordo_quebrado', 'A unidade tem parcela de acordo em aberto (acordo ' + [...new Set(deAcordo.map((r) => r.id_acordo))].join(', ') + '). Desfaça esse acordo antes de fazer outro.');
  if (u.juridico || u.recs.some((r) => r.id_processo)) bloq('juridico', 'A unidade tem processo ou saldo no jurídico. O acordo é com o escritório.');
  if (!origem.length && !deAcordo.length) bloq('sem_cobranca', 'Não há cobrança vencida fora de acordo para negociar.');

  const [acordos, config, conta] = await Promise.all([acordosDaUnidade(sl, id, idUnidade, hoje), lerConfig(sl, id), contaPrincipal(sl, id)]);
  const abertos = acordos.filter(acordoAberto);
  if (abertos.length && !deAcordo.length) bloq('acordo_aberto', 'A unidade já tem acordo em andamento (acordo ' + abertos.map((a) => a.id).join(', ') + ').');
  if (bloqueios.length) return { ok: false, bloqueios, avisos, plano: null, unidade: u.unidade };

  // Taxas: o débito é calculado pelo Superlógica com as taxas do condomínio; precisam ser as da política.
  const jurosCond = config.juros_acordo != null ? config.juros_acordo : config.juros;
  const multaCond = config.multa_acordo != null ? config.multa_acordo : config.multa;
  if (jurosCond != null && Math.abs(jurosCond - politica.juros_pct) > 0.001) bloq('juros_diferente', 'Juros do acordo no Superlógica (' + jurosCond + '%) diferente da política (' + politica.juros_pct + '%).');
  if (multaCond != null && Math.abs(multaCond - politica.multa_pct) > 0.001) bloq('multa_diferente', 'Multa do acordo no Superlógica (' + multaCond + '%) diferente da política (' + politica.multa_pct + '%).');

  const apro = await composicoes(sl, id, idUnidade, origem.map((r) => r.id), hoje);
  if (!apro.length) { bloq('sem_composicao', 'O Superlógica não devolveu a composição dessas cobranças.'); return { ok: false, bloqueios, avisos, plano: null, unidade: u.unidade }; }
  const total = totalComposicoes(apro);
  const debito = cent(origem.reduce((s, r) => s + r.corrigido, 0));
  const ehHonor = (a) => (config.conta_honorario && a.conta === config.conta_honorario) || /honor/i.test(a.descricao);
  const honor = cent(apro.filter(ehHonor).reduce((s, a) => s + a.valor, 0));
  const tol = cent(0.01 * Math.max(2, origem.length));
  // O valor corrigido da inadimplência pode vir com ou sem os honorários; os dois casos batem.
  if (!(Math.abs(total - debito) <= tol || Math.abs(total - honor - debito) <= tol)) {
    bloq('valor_nao_confere', 'O total do acordo (' + brl(total) + ') não bate com o débito atualizado da unidade (' + brl(debito) + (honor ? ' mais ' + brl(honor) + ' de honorários' : '') + ').');
  }
  const base = cent(total - honor);
  const honorPct = base > 0 ? Math.round((honor / base) * 10000) / 100 : 0;
  if (honor > 0.009 && !(politica.honorarios_pct > 0)) bloq('honorario_fora_da_politica', 'O Superlógica colocou ' + brl(honor) + ' de honorários, mas a política deste condomínio não tem honorários.');
  else if (honor > 0.009 && honorPct > politica.honorarios_pct + 0.1) bloq('honorario_fora_da_politica', 'Honorários de ' + honorPct + '% passam da política (' + politica.honorarios_pct + '%).');
  else if (politica.honorarios_pct > 0 && honorPct < politica.honorarios_pct - 0.1) avisos.push({ codigo: 'honorario_menor', grave: false, texto: 'Honorários de ' + honorPct + '% ficaram abaixo da política (' + politica.honorarios_pct + '%). Confira no Superlógica se o condomínio cobra honorários de todas as cobranças.' });
  if (config.honorarios_pct != null && Math.abs(config.honorarios_pct - politica.honorarios_pct) > 0.001) avisos.push({ codigo: 'honorario_cadastro', grave: false, texto: 'O cadastro do condomínio no Superlógica tem honorários de ' + config.honorarios_pct + '% e a política do Hub tem ' + politica.honorarios_pct + '%.' });
  if (bloqueios.length) return { ok: false, bloqueios, avisos, plano: null, unidade: u.unidade };

  // Simulação com uma parcela no vencimento escolhido, encargos da política e desconto zero.
  const q = simulacaoCampos({ id, idUnidade, apro, total, vencimento, hoje, conta: conta.id, politica });
  const sim = await sl.ler('acordos/simularparcelas', q);
  const parcelas = (Array.isArray(sim) ? sim : []).map((p) => ({ vencimento: lerDataSL(p.vencimento), valor: cent(num(p.valor)), observacao: limpar(p.observacao) }));
  if (parcelas.length !== 1 || Math.abs(parcelas[0].valor - total) > 0.01) {
    bloq('simulacao_diferente', 'A simulação do Superlógica não devolveu uma parcela única de ' + brl(total) + '.');
    return { ok: false, bloqueios, avisos, plano: null, unidade: u.unidade };
  }
  const aviso = avisoNaoReceber(config.instrucao_acordo);
  if (aviso) avisos.push(aviso);
  const sensivel = politica.teto_automatico > 0 && total > politica.teto_automatico;
  if (sensivel) avisos.push({ codigo: 'acima_do_teto', grave: false, texto: 'O valor passa do teto da política (' + brl(politica.teto_automatico) + '): a gravação pede a confirmação reforçada.' });

  const plano = {
    id_unidade: u.id_unidade, unidade: u.unidade, responsavel: u.responsavel,
    vencimento: dataSL(vencimento), total, debito, honorarios: honor, honorarios_pct: honorPct,
    origem: origem.map((r) => ({ id: r.id, vencimento: dataSL(r.vencimento), valor: r.valor, corrigido: r.corrigido, juros: r.juros, multa: r.multa, atualizacao: r.atualizacao, honorarios: r.honorarios, desconto: r.desconto, custos: r.custos })),
    apropriacoes: apro, conta: conta.id, nao_separar: config.nao_separar,
    parcela: { vencimento: dataSL(parcelas[0].vencimento || vencimento), valor: parcelas[0].valor, observacao: parcelas[0].observacao || 'Parcela 1 de 1' },
    juros_pct: politica.juros_pct, multa_pct: politica.multa_pct, data_acordo: dataSL(hoje),
    aviso_nao_receber: !!(aviso && aviso.grave),
  };
  return { ok: true, bloqueios, avisos, plano, sensivel, unidade: u.unidade };
}

// Campos comuns da simulação e da criação (mesmos nomes da tela e da coleção oficial).
function simulacaoCampos({ id, idUnidade, apro, total, vencimento, hoje, conta, politica }) {
  const q = {
    TOTAL_RECEITAAPRO: total.toFixed(2), PRIORIZARHONORARIOS: 0, SIMULA_TOTAL: total.toFixed(2), SIMULA_ENTRADA: 0,
    NM_PARCELA_ACO: 1, FL_EMITIR_RECIBO: 0, DT_PRIMEIRA_PARCELA: typeof vencimento === 'string' ? vencimento : dataSL(vencimento),
    'ENTRADA[0][VALOR]': 0, 'ENTRADA[0][ID_FORMAPAGAMENTO_RECB]': '', 'ENTRADA[0][VENCIMENTO]': '',
    // Encargos do boleto do acordo pela política, sem desconto de pontualidade (hoje zerado à mão).
    ALTERAR_ENCARGOS: 1, NM_TXJUROS_COND: politica.juros_pct, NM_TXMULTA_COND: politica.multa_pct, NM_TXDESCONTO_RECB: 0,
    ID_FORMA_RECB: 1, ID_CONTABANCO_CB: conta, DT_ACORDO_ACO: typeof hoje === 'string' ? hoje : dataSL(hoje),
    ID_IMPRESSAO_FIMP: '', TIPO_ACORDO: 0, ID_UNIDADE_UNI: idUnidade, ID_CONDOMINIO_COND: id,
  };
  apro.forEach((a, i) => {
    q['RECEITA_APROPRIACAO[' + i + '][ST_CONTA_CONT]'] = a.conta;
    q['RECEITA_APROPRIACAO[' + i + '][ST_DESCRICAO_CONT]'] = a.conta + '  ' + a.descricao;
    q['RECEITA_APROPRIACAO[' + i + '][ST_COMPLEMENTO_REC]'] = a.complemento;
    q['RECEITA_APROPRIACAO[' + i + '][VL_VALOR_REC]'] = a.valor.toFixed(2);
    q['RECEITA_APROPRIACAO[' + i + '][APROPRIARPRIMEIRO]'] = 0;
  });
  return q;
}

// Corpo do acordos/put a partir do plano conferido (função pura, testada sem rede).
function camposAcordo(id, plano) {
  const q = simulacaoCampos({ id, idUnidade: plano.id_unidade, apro: plano.apropriacoes, total: plano.total, vencimento: plano.vencimento,
    hoje: plano.data_acordo, conta: plano.conta, politica: { juros_pct: plano.juros_pct, multa_pct: plano.multa_pct } });
  q['PARCELAS[0][VENCIMENTO]'] = plano.parcela.vencimento;
  q['PARCELAS[0][VALOR]'] = plano.parcela.valor.toFixed(2);
  q['PARCELAS[0][OBSERVACAO]'] = plano.parcela.observacao;
  q.ID_CONTA_BANCO = plano.conta;
  q.VL_PRIMEIRA_PARCELA = '';
  if (plano.nao_separar !== '') q.naosepararcomposicao = plano.nao_separar;
  plano.origem.forEach((r, i) => {
    q['COBS_ORIGEM[' + i + '][ID_RECEBIMENTO_RECB]'] = r.id;
    q['COBS_ORIGEM[' + i + '][VL_ACORDOJUROS_RECB]'] = r.juros.toFixed(2);
    q['COBS_ORIGEM[' + i + '][VL_ACORDOMULTA_RECB]'] = r.multa.toFixed(2);
    q['COBS_ORIGEM[' + i + '][VL_ACORDOATUALIZACAO_RECB]'] = r.atualizacao.toFixed(2);
    q['COBS_ORIGEM[' + i + '][VL_ACORDOHONORARIOS_RECB]'] = r.honorarios.toFixed(2);
    q['COBS_ORIGEM[' + i + '][VL_ACORDODESCONTO_RECB]'] = r.desconto.toFixed(2);
    q['COBS_ORIGEM[' + i + '][VL_ACORDOCUSTOS_RECB]'] = r.custos.toFixed(2);
  });
  return q;
}

// Grava o acordo (uma chamada só, sem repetir) e relê para conferir. Devolve
// { ok, incerto?, id_acordo?, conferido, divergencias, msg }.
async function emitirAcordo(sl, id, plano, hoje) {
  const r = await sl.gravar('POST', 'acordos/put', camposAcordo(id, plano));
  if (semResposta(r)) return { ok: false, incerto: true, msg: 'O Superlógica não respondeu. O acordo pode ter sido criado: confira no Superlógica antes de tentar de novo.' };
  const c = corpoOk(r);
  if (!c.ok) return { ok: false, msg: c.msg };
  const dados = Array.isArray(c.item.data) ? c.item.data : [];
  const idAcordo = limpar(dados[0] && (dados[0].idacordo || dados[0].id_acordo_aco)) || null;
  return Object.assign({ ok: true, id_acordo: idAcordo, msg: c.msg }, await conferirAcordo(sl, id, plano, idAcordo, hoje));
}
// Releitura: o acordo existe na unidade, com todas as cobranças escolhidas e uma parcela do total.
async function conferirAcordo(sl, id, plano, idAcordo, hoje) {
  const divergencias = [];
  let acordos = [];
  try { acordos = await acordosDaUnidade(sl, id, plano.id_unidade, hoje); } catch (e) { return { conferido: false, divergencias: ['Não foi possível reler os acordos da unidade agora.'] }; }
  const a = idAcordo ? acordos.find((x) => x.id === idAcordo) : acordos.filter((x) => !x.desfeito).sort((x, y) => (y.data || 0) - (x.data || 0))[0];
  if (!a) return { conferido: false, divergencias: ['O acordo não apareceu na releitura da unidade.'] };
  const faltam = plano.origem.map((r) => r.id).filter((x) => !a.origem.includes(x));
  if (faltam.length) divergencias.push('Cobranças que não entraram no acordo: ' + faltam.join(', ') + '.');
  if (a.parcelas.length !== 1) divergencias.push('O acordo tem ' + a.parcelas.length + ' parcelas (esperado 1).');
  const soma = cent(a.parcelas.reduce((s, p) => s + p.valor, 0));
  if (Math.abs(soma - plano.total) > 0.01) divergencias.push('Soma das parcelas ' + brl(soma) + ' diferente do total conferido ' + brl(plano.total) + '.');
  return { conferido: true, id_acordo: a.id, divergencias, parcela: a.parcelas[0] ? { id: a.parcelas[0].id, vencimento: dataBR(a.parcelas[0].vencimento), valor: a.parcelas[0].valor } : null };
}

// Confere se o acordo pode ser desfeito: é da unidade e do condomínio, não foi desfeito e
// nenhuma parcela foi paga.
async function prepararDesfazer(sl, { id, idUnidade, idAcordo, hoje }) {
  const acordos = await acordosDaUnidade(sl, id, idUnidade, hoje);
  const a = acordos.find((x) => x.id === String(idAcordo));
  const bloqueios = [];
  if (!a) bloqueios.push({ codigo: 'acordo_nao_encontrado', texto: 'Esse acordo não é desta unidade.' });
  else {
    if (a.condominio && a.condominio !== String(id)) bloqueios.push({ codigo: 'acordo_de_outro_condominio', texto: 'Esse acordo é de outro condomínio.' });
    if (a.desfeito) bloqueios.push({ codigo: 'ja_desfeito', texto: 'Esse acordo já foi desfeito em ' + dataBR(a.desfeito) + '.' });
    if (a.parcelas.some((p) => p.paga)) bloqueios.push({ codigo: 'parcela_paga', texto: 'O acordo tem parcela paga. Desfazer só pelo Superlógica, com a gestão.' });
  }
  return { ok: !bloqueios.length, bloqueios, acordo: a ? { id: a.id, data: dataBR(a.data), parcelas: a.parcelas.length, total: cent(a.parcelas.reduce((s, p) => s + p.valor, 0)), origem: a.origem, escritorio: a.escritorio } : null };
}
async function desfazerAcordo(sl, id, idUnidade, acordo, hoje) {
  const r = await sl.gravar('PUT', 'acordos/desfazer', { ID_ACORDO_ACO: acordo.id, ID_CONDOMINIO_COND: id, ID_UNIDADE_UNI: idUnidade });
  if (semResposta(r)) return { ok: false, incerto: true, msg: 'O Superlógica não respondeu. Confira no Superlógica se o acordo foi desfeito antes de tentar de novo.' };
  const c = corpoOk(r);
  if (!c.ok) return { ok: false, msg: c.msg };
  let conferido = false; const divergencias = [];
  try {
    const depois = (await acordosDaUnidade(sl, id, idUnidade, hoje)).find((x) => x.id === acordo.id);
    conferido = true;
    if (depois && !depois.desfeito) divergencias.push('Na releitura o acordo ainda aparece ativo.');
    const inad = await inadimplencia(sl, id, hoje);
    const u = inad.unidades.find((x) => x.id_unidade === String(idUnidade));
    const voltaram = u ? u.recs.filter((x) => acordo.origem.includes(x.id) && !x.id_acordo).length : 0;
    if (voltaram < acordo.origem.length) divergencias.push('Voltaram para a inadimplência ' + voltaram + ' de ' + acordo.origem.length + ' cobranças de origem.');
  } catch (e) { divergencias.push('Não foi possível reler a unidade agora.'); }
  return { ok: true, msg: c.msg, conferido, divergencias };
}

// ── Contato de cobrança no CRM ─────────────────────────────────────────────────────────────
function validarContato(b) {
  const c = b || {};
  const canal = parseInt(c.canal, 10); const resultado = parseInt(c.resultado, 10);
  const motivo = c.motivo == null || c.motivo === '' ? null : parseInt(c.motivo, 10);
  const tipo = parseInt(c.tipo == null ? 1 : c.tipo, 10);
  const descricao = semDadosPessoais(c.descricao, 500);
  const erros = [];
  if (!CANAIS[canal]) erros.push('Canal inválido.');
  if (!RESULTADOS[resultado]) erros.push('Resultado inválido.');
  if (motivo != null && !MOTIVOS[motivo]) erros.push('Motivo inválido.');
  if (tipo !== 1 && tipo !== 2) erros.push('Tipo de atendimento inválido.');
  if (descricao.length < 5) erros.push('Descreva o contato (pelo menos 5 letras).');
  return { contato: { canal, resultado, motivo, tipo, descricao }, erros };
}
async function unidadeDoCondominio(sl, id, idUnidade) {
  let j;
  try { j = await sl.ler('unidades/index', { idCondominio: id, id: idUnidade, exibirDadosDosContatos: 1 }); } catch (e) {
    // Unidade de outro condomínio ou inexistente: o Superlógica responde 500 "Unidade não encontrada." (visto no 167).
    const msg = e && e.corpo && (Array.isArray(e.corpo) ? e.corpo[0] && e.corpo[0].msg : e.corpo.msg);
    if ((e && e.status && e.status < 500) || /unidade n[aã]o encontrada/i.test(String(msg || ''))) return null;
    throw e;
  }
  const u = (Array.isArray(j) ? j : [j]).find((x) => x && limpar(x.id_unidade_uni) === String(idUnidade) && limpar(x.id_condominio_cond) === String(id));
  return u || null;
}
// Grava o contato e relê pelo identificador do Hub. agora: Date no horário de Brasília.
async function registrarContato(sl, id, idUnidade, c, agora) {
  const ident = 'HUB' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const campos = {
    ID_CONDOMINIO_COND: id, ID_UNIDADE_UNI: idUnidade, DT_DATA_HATE: dataSL(agora), DT_HORA_HATE: doisDig(agora.getHours()) + ':' + doisDig(agora.getMinutes()),
    FL_CANALCOMUNICACAO_HATE: c.canal, ID_TIPORESULTADO_ATEND: c.resultado, ST_DESCRICAORESULTADO_ATEND: RESULTADOS[c.resultado],
    ST_DESCRICAO_HATE: c.descricao, FL_TIPOATENDIMENTO_HATE: c.tipo, FL_AGENDAR_CONTATO: 0, ST_IDENTIFICADOREXTERNO_HATE: ident, FL_VIA_API: 1,
  };
  if (c.motivo != null) campos.FL_MOTIVOINADIMPLENCIA_HATE = c.motivo;
  const r = await sl.gravar('POST', 'historicocobranca/', campos);
  if (semResposta(r)) return { ok: false, incerto: true, identificador: ident, msg: 'O Superlógica não respondeu. Confira no CRM antes de registrar de novo.' };
  const ok = corpoOk(r);
  if (!ok.ok) return { ok: false, msg: ok.msg };
  // A resposta do Superlógica traz o registro gravado (id, condomínio, unidade, descrição): é a
  // conferência principal. No 167 a listagem historicocobranca/index não mostrou o registro novo
  // (23/10/2026), por isso a releitura pela lista é só o plano B.
  const dado = Array.isArray(ok.item.data) ? ok.item.data[0] : ok.item.data;
  let idHist = limpar(dado && (dado.id_historico_hate || dado.ID_HISTORICO_HATE)) || null;
  let conferido = !!(dado && idHist && limpar(dado.id_condominio_cond) === String(id) && limpar(dado.id_unidade_uni) === String(idUnidade)
    && (!limpar(dado.st_descricao_hate) || limpar(dado.st_descricao_hate) === c.descricao));
  if (conferido) return { ok: true, id_historico: idHist, identificador: ident, conferido, msg: ok.msg };
  try {
    // idEmpresa filtra o condomínio (idCondominio é ignorado por esta rota: visto no 167 em 23/10/2026).
    // Mesmo assim só vale registro do próprio condomínio e da unidade.
    const amanha = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1);
    const lista = (await paginas(sl, 'historicocobranca/index', { idEmpresa: id, dtInicio: dataSL(agora), dtFim: dataSL(amanha) }, 10))
      .filter((h) => !limpar(h.id_condominio_cond) || limpar(h.id_condominio_cond) === String(id));
    const achou = lista.find((h) => limpar(h.st_identificadorexterno_hate) === ident)
      || lista.find((h) => limpar(h.id_unidade_uni) === String(idUnidade) && limpar(h.st_descricao_hate) === c.descricao);
    if (achou) { conferido = true; idHist = limpar(achou.id_historico_hate) || idHist; }
  } catch (e) { /* releitura falhou: devolve sem conferência */ }
  return { ok: true, id_historico: idHist, identificador: ident, conferido, msg: ok.msg };
}

// ── Status financeiro (régua) ──────────────────────────────────────────────────────────────
const rotuloStatus = (s) => STATUS_FIN[String(s === '' || s == null ? 0 : s)] || ('código ' + s);
// Status que a unidade deveria ter hoje, pela régua do condomínio (dias das cartas e do aviso
// judicial). Jurídico e processo não mudam pelo Hub. Devolve { esperado, maior_atraso, manter, motivo }.
function statusEsperado(u, regua, hoje) {
  const atual = String(u.status_fin === '' || u.status_fin == null ? 0 : u.status_fin);
  if (atual === '10' || u.juridico || (u.recs || []).some((r) => r.id_processo)) return { esperado: atual, manter: true, motivo: 'jurídico ou processo: decisão do escritório' };
  const vencidas = (u.recs || []).filter((r) => r.vencimento && r.vencimento < hoje);
  const maior = vencidas.reduce((m, r) => Math.max(m, diasEntre(r.vencimento, hoje)), 0);
  const c1 = regua.dias_carta1 || 30; const c2 = regua.dias_carta2 || 60; const j = regua.dias_judicial || 90;
  let esperado = '0'; let motivo = 'sem cobrança vencida';
  if (maior >= j) { esperado = '3'; motivo = 'atraso de ' + maior + ' dias (aviso judicial aos ' + j + ')'; }
  else if (maior >= c2) { esperado = '2'; motivo = 'atraso de ' + maior + ' dias (segunda carta aos ' + c2 + ')'; }
  else if (maior >= c1) { esperado = '1'; motivo = 'atraso de ' + maior + ' dias (primeira carta aos ' + c1 + ')'; }
  else if (maior > 0) motivo = 'atraso de ' + maior + ' dias, antes da primeira carta';
  return { esperado, maior_atraso: maior, manter: false, motivo };
}
// Todas as unidades do condomínio com o status gravado (paginado).
async function lerUnidades(sl, id) {
  const lista = await paginas(sl, 'unidades/index', { idCondominio: id }, 60);
  return { unidades: lista.map((u) => ({ id_unidade: limpar(u.id_unidade_uni), unidade: limpar(u.st_unidade_uni) + (limpar(u.st_bloco_uni) ? ' ' + limpar(u.st_bloco_uni) : ''), status_fin: limpar(u.fl_statusfin_uni) }))
    .filter((u) => u.id_unidade), cortado: !!lista.cortado };
}
// Divergências entre o status gravado e o esperado. "baixar" é o caso comum (pagou ou fez acordo
// e continua marcado); "subir" pede conferência porque a régua pode mandar carta.
async function analisarStatus(sl, id, hoje) {
  const [uni, inad, config] = await Promise.all([lerUnidades(sl, id), inadimplencia(sl, id, hoje), lerConfig(sl, id)]);
  const porId = new Map(inad.unidades.map((u) => [u.id_unidade, u]));
  const divergencias = [];
  uni.unidades.forEach((u) => {
    const i = porId.get(u.id_unidade) || { recs: [], juridico: false };
    const e = statusEsperado({ status_fin: u.status_fin, recs: i.recs, juridico: i.juridico }, config, hoje);
    const atual = String(u.status_fin === '' ? 0 : u.status_fin);
    if (e.manter || e.esperado === atual) return;
    divergencias.push({ id_unidade: u.id_unidade, unidade: u.unidade, de: atual, de_rotulo: rotuloStatus(atual), para: e.esperado, para_rotulo: rotuloStatus(e.esperado),
      direcao: Number(e.esperado) < Number(atual) ? 'baixar' : 'subir', motivo: e.motivo, maior_atraso: e.maior_atraso || 0 });
  });
  divergencias.sort((a, b) => (a.direcao === b.direcao ? a.unidade.localeCompare(b.unidade, 'pt-BR', { numeric: true }) : a.direcao === 'baixar' ? -1 : 1));
  return {
    regua_por_status: config.regua_por === 'status_financeiro', regua: { dias_carta1: config.dias_carta1 || 30, dias_carta2: config.dias_carta2 || 60, dias_judicial: config.dias_judicial || 90, carta1: config.carta1, carta2: config.carta2, judicial: config.judicial },
    quantidade_unidades: uni.unidades.length, divergencias, cortado: uni.cortado || inad.cortado,
  };
}
// Confere de novo uma correção (o status atual tem de ser o "de" e o esperado tem de ser o "para").
// base: { inad, config } já lidos (a rota guarda por alguns minutos para o lote não reler tudo a
// cada unidade); o status da unidade é sempre lido na hora.
async function conferirCorrecaoStatus(sl, id, item, hoje, base) {
  const u = await unidadeDoCondominio(sl, id, item.id_unidade);
  if (!u) return { ok: false, codigo: 'unidade_nao_encontrada', texto: 'Unidade não encontrada neste condomínio.' };
  const atual = String(limpar(u.fl_statusfin_uni) === '' ? 0 : limpar(u.fl_statusfin_uni));
  if (atual !== String(item.de)) return { ok: false, codigo: 'status_mudou', texto: 'O status da unidade mudou para ' + rotuloStatus(atual) + ' desde a análise. Analise de novo.' };
  const [inad, config] = base ? [base.inad, base.config] : await Promise.all([inadimplencia(sl, id, hoje), lerConfig(sl, id)]);
  const i = inad.unidades.find((x) => x.id_unidade === String(item.id_unidade)) || { recs: [], juridico: false };
  const e = statusEsperado({ status_fin: atual, recs: i.recs, juridico: i.juridico }, config, hoje);
  if (e.manter || e.esperado !== String(item.para)) return { ok: false, codigo: 'correcao_mudou', texto: 'A correção esperada mudou (' + (e.manter ? 'jurídico' : rotuloStatus(e.esperado)) + '). Analise de novo.' };
  return { ok: true, unidade: limpar(u.st_unidade_uni) + (limpar(u.st_bloco_uni) ? ' ' + limpar(u.st_bloco_uni) : ''), direcao: Number(item.para) < Number(atual) ? 'baixar' : 'subir', motivo: e.motivo };
}
async function gravarStatus(sl, id, item) {
  const r = await sl.gravar('PUT', 'unidades/post', { ID_CONDOMINIO_COND: id, ID_UNIDADE_UNI: item.id_unidade, FL_STATUSFIN_UNI: item.para });
  if (semResposta(r)) return { ok: false, incerto: true, msg: 'O Superlógica não respondeu. Confira a unidade antes de tentar de novo.' };
  const c = corpoOk(r);
  if (!c.ok) return { ok: false, msg: c.msg };
  let conferido = false; let lido = null;
  try { const u = await unidadeDoCondominio(sl, id, item.id_unidade); lido = u ? String(limpar(u.fl_statusfin_uni) === '' ? 0 : limpar(u.fl_statusfin_uni)) : null; conferido = lido === String(item.para); } catch (e) { /* sem releitura */ }
  return { ok: true, conferido, lido, msg: c.msg };
}

// ── Cadastro da unidade ────────────────────────────────────────────────────────────────────
// Papéis que o Hub grava (ID_LABEL_TRES = tipo de responsável; ID_TIPORESP_TRES = que cobrança
// recebe: 1 normal e extra, 2 só extra, 4 nenhuma, 7 só normal). Testado no 167 em 23/10/2026:
// proprietário 2/1 com FL_PROPRIETARIO_CON=1 (o sacado da unidade passa a ser ele), dependente 4/4.
// O Superlógica recusa inquilino recebendo extra ("Não é permitido que inquilino receba cobranças
// extras"): o responsável financeiro é o inquilino que recebe a cobrança normal (7/7) e o dono passa
// a receber só as extras (tiporesp 2). Inquilino comum não recebe cobrança (7/4).
const PAPEIS = {
  proprietario: { rotulo: 'Proprietário', label: '2', tiporesp: '1', proprietario: true },
  inquilino: { rotulo: 'Inquilino', label: '7', tiporesp: '4' },
  responsavel_financeiro: { rotulo: 'Responsável financeiro', label: '7', tiporesp: '7' },
  dependente: { rotulo: 'Dependente', label: '4', tiporesp: '4' },
};
const TIPOS_CADASTRO = ['contato_atualizar', 'contato_incluir', 'contato_sair', 'segundo_sacado', 'troca_proprietario'];

// Contatos da unidade como o Hub mostra: CPF e telefone mascarados, email mascarado.
function contatosDaUnidade(u) {
  return (Array.isArray(u && u.contatos) ? u.contatos : []).map((c) => ({
    id_contato: limpar(c.id_contato_con), nome: limpar(c.st_nome_con), papel: limpar(c.st_nometiporesp_tres),
    label: limpar(c.id_label_tres), tiporesp: limpar(c.id_tiporesp_tres), proprietario: limpar(c.fl_proprietario_con) === '1' || /propriet/i.test(limpar(c.st_nometiporesp_tres)),
    cpf: mascararCpf(c.st_cpf_con), email: mascararEmail(c.st_email_con), telefone: mascararTelefone(c.st_telefone_con || c.st_fax_con),
    entrada: dataBR(lerDataSL(c.dt_entrada_res)), saida: dataBR(lerDataSL(c.dt_saida_res)),
  })).filter((c) => c.id_contato);
}
function fichaUnidade(u) {
  return { id_unidade: limpar(u.id_unidade_uni), unidade: limpar(u.st_unidade_uni) + (limpar(u.st_bloco_uni) ? ' ' + limpar(u.st_bloco_uni) : ''),
    sacado: limpar(u.st_sacado_uni), segundo_sacado: limpar(u.st_sacado2_uni), status_fin: rotuloStatus(limpar(u.fl_statusfin_uni)), contatos: contatosDaUnidade(u) };
}
const dataISO = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return null; const d = new Date(+m[1], +m[2] - 1, +m[3]); return d.getMonth() === +m[2] - 1 ? d : null; };
function validarPessoa(p, erros, obrigatorioCpf) {
  const nome = limpar(p && p.nome).toUpperCase();
  const cpf = String((p && p.cpf) || '').replace(/\D/g, '');
  const email = limpar(p && p.email).toLowerCase();
  const telefone = String((p && p.telefone) || '').replace(/\D/g, '');
  if (nome.split(' ').filter(Boolean).length < 2 || nome.length > 120 || /[<>]/.test(nome)) erros.push('Nome completo (nome e sobrenome).');
  if ((cpf || obrigatorioCpf) && !cpfValido(cpf)) erros.push('CPF ou CNPJ inválido.');
  if (email && !emailValido(email)) erros.push('Email inválido.');
  if (telefone && !telefoneValido(telefone)) erros.push('Telefone com DDD (10 ou 11 números).');
  return { nome, cpf, email, telefone };
}

// Confere o pedido de cadastro contra a unidade lida do Superlógica e monta o antes e depois.
// historico: alterações anteriores do Hub nesta unidade (para o segundo sacado que vai e volta).
// Devolve { ok, erros, avisos, sensivel, antes, depois, passos } (passos = gravações em ordem).
function conferirCadastro(u, pedido, { hoje, historico }) {
  const tipo = pedido && pedido.tipo;
  const d = (pedido && pedido.dados) || {};
  const erros = []; const avisos = []; const passos = [];
  const ficha = fichaUnidade(u);
  const idU = ficha.id_unidade; const idC = limpar(u.id_condominio_cond);
  const contatoBruto = (idc) => (Array.isArray(u.contatos) ? u.contatos : []).find((c) => limpar(c.id_contato_con) === String(idc));
  let sensivel = false; let antes = null; let depois = null;
  if (!TIPOS_CADASTRO.includes(tipo)) return { ok: false, erros: ['Tipo de alteração inválido.'], avisos, sensivel, antes, depois, passos };
  const entrada = d.entrada ? dataISO(d.entrada) : hoje;
  if (d.entrada && (!entrada || entrada > new Date(hoje.getTime() + 60 * DIA) || entrada < new Date(hoje.getFullYear() - 30, 0, 1))) erros.push('Data de entrada inválida.');

  if (tipo === 'contato_atualizar') {
    const c = contatoBruto(d.id_contato);
    if (!c) erros.push('Contato não encontrado nesta unidade.');
    const email = limpar(d.email).toLowerCase(); const tel = String(d.telefone || '').replace(/\D/g, '');
    if (!email && !tel) erros.push('Informe o email ou o telefone novo.');
    if (email && !emailValido(email)) erros.push('Email inválido.');
    if (tel && !telefoneValido(tel)) erros.push('Telefone com DDD (10 ou 11 números).');
    if (c && !erros.length) {
      if (email && email === limpar(c.st_email_con).toLowerCase()) erros.push('O email informado é igual ao do cadastro.');
      if (tel && tel === String(c.st_telefone_con || '').replace(/\D/g, '')) erros.push('O telefone informado é igual ao do cadastro.');
      const ehDono = limpar(c.fl_proprietario_con) === '1' || /propriet/i.test(limpar(c.st_nometiporesp_tres));
      // Troca de email do dono muda para onde vão os boletos: confirmação reforçada.
      if (email && ehDono) { sensivel = true; avisos.push({ codigo: 'email_do_dono', texto: 'Troca do email do proprietário: os boletos passam a ir para o email novo.' }); }
      antes = { contato: limpar(c.st_nome_con), email: email ? mascararEmail(c.st_email_con) : undefined, telefone: tel ? mascararTelefone(c.st_telefone_con) : undefined };
      depois = { contato: limpar(c.st_nome_con), email: email ? mascararEmail(email) : undefined, telefone: tel ? mascararTelefone(tel) : undefined };
      const campos = { ID_CONDOMINIO_COND: idC, ID_UNIDADE_UNI: idU, 'contatos[0][ID_CONTATO_CON]': limpar(c.id_contato_con), 'contatos[0][ST_NOME_CON]': limpar(c.st_nome_con) };
      if (email) campos['contatos[0][ST_EMAIL_CON]'] = email;
      if (tel) campos['contatos[0][ST_TELEFONE_CON]'] = tel;
      passos.push({ metodo: 'PUT', rota: 'unidades/post', campos, confere: { id_contato: limpar(c.id_contato_con), email: email || undefined, telefone: tel || undefined } });
    }
  } else if (tipo === 'contato_incluir' || tipo === 'troca_proprietario') {
    const papel = tipo === 'troca_proprietario' ? 'proprietario' : d.papel;
    const P = PAPEIS[papel];
    if (!P) erros.push('Papel inválido.');
    if (tipo === 'contato_incluir' && papel === 'proprietario') erros.push('Para trocar o proprietário use "Troca de proprietário".');
    const pessoa = validarPessoa(d, erros, papel === 'proprietario' || papel === 'responsavel_financeiro');
    const jaTem = (Array.isArray(u.contatos) ? u.contatos : []).find((c) => pessoa.cpf && String(c.st_cpf_con || '').replace(/\D/g, '') === pessoa.cpf);
    if (jaTem && tipo === 'contato_incluir') erros.push('Essa pessoa já está nesta unidade.');
    let antigo = null;
    if (tipo === 'troca_proprietario') {
      sensivel = true;
      antigo = contatoBruto(d.id_contato_antigo);
      if (!antigo) erros.push('Escolha o proprietário que sai.');
      else if (!(limpar(antigo.fl_proprietario_con) === '1' || /propriet/i.test(limpar(antigo.st_nometiporesp_tres)))) erros.push('O contato escolhido não é o proprietário.');
      if (antigo && entrada && lerDataSL(antigo.dt_entrada_res) && entrada < lerDataSL(antigo.dt_entrada_res)) erros.push('A entrada do novo proprietário é antes da entrada do atual.');
      if (!d.documento_conferido) erros.push('Confirme que a escritura ou o contrato de compra e venda foi conferido.');
    }
    const donos = (Array.isArray(u.contatos) ? u.contatos : []).filter((c) => limpar(c.fl_proprietario_con) === '1' || /propriet/i.test(limpar(c.st_nometiporesp_tres)));
    if (papel === 'responsavel_financeiro') {
      sensivel = true;
      if (!donos.length) erros.push('A unidade não tem proprietário cadastrado.');
      avisos.push({ codigo: 'responsavel_financeiro', texto: 'O responsável financeiro passa a receber a cobrança normal da unidade; o proprietário fica só com as cobranças extras.' });
    }
    if (P && !erros.length) {
      antes = antigo ? { proprietario: limpar(antigo.st_nome_con), cpf: mascararCpf(antigo.st_cpf_con) } : { contatos: ficha.contatos.length };
      depois = { papel: P.rotulo, nome: pessoa.nome, cpf: mascararCpf(pessoa.cpf), email: mascararEmail(pessoa.email), telefone: mascararTelefone(pessoa.telefone), entrada: dataBR(entrada) };
      const campos = {
        ID_CONDOMINIO_COND: idC, ID_UNIDADE_UNI: idU, 'contatos[0][ID_UNIDADE_UNI]': idU,
        'contatos[0][ID_CONTATO_CON]': '', 'contatos[0][ST_NOME_CON]': pessoa.nome,
        'contatos[0][ID_TIPORESP_TRES]': P.tiporesp, 'contatos[0][ID_LABEL_TRES]': P.label, 'contatos[0][ID_TIPOCONTATO_TCON]': '1',
        'contatos[0][DT_ENTRADA_RES]': dataSL(entrada) + ' 00:00:00',
      };
      if (P.proprietario) campos['contatos[0][FL_PROPRIETARIO_CON]'] = '1';
      if (pessoa.cpf) campos['contatos[0][ST_CPF_CON]'] = pessoa.cpf;
      if (pessoa.email) campos['contatos[0][ST_EMAIL_CON]'] = pessoa.email;
      if (pessoa.telefone) campos['contatos[0][ST_TELEFONE_CON]'] = pessoa.telefone;
      passos.push({ metodo: 'PUT', rota: 'unidades/post', campos, confere: { novo: { nome: pessoa.nome, cpf: pessoa.cpf } } });
      if (antigo) passos.push({ metodo: 'POST', rota: 'contatos/delete?idUnidade=' + encodeURIComponent(idU) + '&idCondominio=' + encodeURIComponent(idC) + '&idContato=' + encodeURIComponent(limpar(antigo.id_contato_con)), campos: {}, confere: { saiu: limpar(antigo.id_contato_con) } });
      // Responsável financeiro: o dono que recebia tudo passa a receber só as extras.
      if (papel === 'responsavel_financeiro') {
        donos.filter((c) => limpar(c.id_tiporesp_tres) === '1' || limpar(c.id_tiporesp_tres) === '7').forEach((c) => {
          passos.push({ metodo: 'PUT', rota: 'unidades/post', campos: { ID_CONDOMINIO_COND: idC, ID_UNIDADE_UNI: idU, 'contatos[0][ID_CONTATO_CON]': limpar(c.id_contato_con), 'contatos[0][ST_NOME_CON]': limpar(c.st_nome_con), 'contatos[0][ID_TIPORESP_TRES]': '2' },
            confere: { id_contato: limpar(c.id_contato_con), tiporesp: '2' } });
        });
        antes = { proprietario_recebe: donos.map((c) => limpar(c.st_nome_con) + ' (' + (limpar(c.id_tiporesp_tres) === '2' ? 'só extras' : 'todas as cobranças') + ')').join(', ') };
      }
    }
  } else if (tipo === 'contato_sair') {
    const c = contatoBruto(d.id_contato);
    if (!c) erros.push('Contato não encontrado nesta unidade.');
    else {
      const ehDono = limpar(c.fl_proprietario_con) === '1' || /propriet/i.test(limpar(c.st_nometiporesp_tres));
      if (ehDono) erros.push('O proprietário não sai sozinho: use "Troca de proprietário".');
      antes = { contato: limpar(c.st_nome_con), papel: limpar(c.st_nometiporesp_tres) };
      depois = { contato: limpar(c.st_nome_con), situacao: 'retirado da unidade' };
      if (!erros.length) passos.push({ metodo: 'POST', rota: 'contatos/delete?idUnidade=' + encodeURIComponent(idU) + '&idCondominio=' + encodeURIComponent(idC) + '&idContato=' + encodeURIComponent(limpar(c.id_contato_con)), campos: {}, confere: { saiu: limpar(c.id_contato_con) } });
      // Saiu o responsável financeiro (inquilino que recebia a cobrança normal): o dono que estava
      // só com as extras volta a receber tudo. O Superlógica também mexe no segundo sacado nessa
      // troca (visto no 167), o que explica parte do "vai e volta" do segundo sacado.
      if (!erros.length && limpar(c.id_label_tres) === '7' && limpar(c.id_tiporesp_tres) === '7') {
        sensivel = true;
        (Array.isArray(u.contatos) ? u.contatos : []).filter((x) => (limpar(x.fl_proprietario_con) === '1' || /propriet/i.test(limpar(x.st_nometiporesp_tres))) && limpar(x.id_tiporesp_tres) === '2').forEach((x) => {
          passos.push({ metodo: 'PUT', rota: 'unidades/post', campos: { ID_CONDOMINIO_COND: idC, ID_UNIDADE_UNI: idU, 'contatos[0][ID_CONTATO_CON]': limpar(x.id_contato_con), 'contatos[0][ST_NOME_CON]': limpar(x.st_nome_con), 'contatos[0][ID_TIPORESP_TRES]': '1' },
            confere: { id_contato: limpar(x.id_contato_con), tiporesp: '1' } });
          avisos.push({ codigo: 'dono_volta_a_receber', texto: limpar(x.st_nome_con) + ' volta a receber todas as cobranças da unidade.' });
        });
      }
    }
  } else if (tipo === 'segundo_sacado') {
    const novo = limpar(d.nome).toUpperCase();
    if (novo.length > 120 || /[<>]/.test(novo)) erros.push('Nome do segundo sacado inválido.');
    if (novo === ficha.segundo_sacado.toUpperCase()) erros.push('O segundo sacado já é esse.');
    // Vai e volta: o mesmo nome já foi tirado ou posto nos últimos 90 dias pelo Hub.
    const recentes = (historico || []).filter((h) => h.tipo === 'segundo_sacado' && h.em && (hoje - new Date(h.em)) < 90 * DIA);
    const jaFoi = recentes.some((h) => h.antes && limpar(h.antes.segundo_sacado).toUpperCase() === novo);
    if (recentes.length >= 2 || jaFoi) {
      sensivel = true;
      avisos.push({ codigo: 'vai_e_volta', texto: 'O segundo sacado desta unidade já mudou ' + recentes.length + ' vezes em 90 dias' + (jaFoi ? ' e este nome já esteve aqui' : '') + '. Se for para emitir um boleto em nome de outra pessoa, confira com a gestão antes.' });
    }
    antes = { segundo_sacado: ficha.segundo_sacado };
    depois = { segundo_sacado: novo };
    if (!erros.length) passos.push({ metodo: 'PUT', rota: 'unidades/post', campos: { ID_CONDOMINIO_COND: idC, ID_UNIDADE_UNI: idU, ST_SACADO2_UNI: novo }, confere: { segundo_sacado: novo } });
  }
  return { ok: !erros.length && passos.length > 0, erros, avisos, sensivel, antes, depois, passos };
}

// Grava os passos em ordem; para no primeiro que falhar. Relê a unidade e confere campo a campo.
async function gravarCadastro(sl, id, idUnidade, passos) {
  const feitos = [];
  for (const p of passos) {
    const r = await sl.gravar(p.metodo, p.rota, p.campos);
    if (semResposta(r)) return { ok: false, incerto: true, feitos, msg: 'O Superlógica não respondeu no passo ' + (feitos.length + 1) + '. Confira a unidade antes de tentar de novo.' };
    const c = corpoOk(r);
    if (!c.ok) return { ok: false, parcial: feitos.length > 0, feitos, msg: c.msg };
    feitos.push(p.rota.split('?')[0]);
  }
  const divergencias = []; let conferido = false;
  try {
    const u = await unidadeDoCondominio(sl, id, idUnidade);
    conferido = !!u;
    const cs = (u && Array.isArray(u.contatos)) ? u.contatos : [];
    passos.forEach((p) => {
      const f = p.confere || {};
      if (f.id_contato) {
        const c = cs.find((x) => limpar(x.id_contato_con) === f.id_contato);
        if (!c) divergencias.push('Contato não encontrado na releitura.');
        else {
          if (f.email && limpar(c.st_email_con).toLowerCase() !== f.email) divergencias.push('O email não ficou gravado como pedido.');
          if (f.telefone && String(c.st_telefone_con || '').replace(/\D/g, '') !== f.telefone) divergencias.push('O telefone não ficou gravado como pedido.');
          if (f.tiporesp && limpar(c.id_tiporesp_tres) !== f.tiporesp) divergencias.push('O tipo de cobrança do contato não ficou como pedido.');
        }
      }
      if (f.novo && !cs.some((x) => limpar(x.st_nome_con).toUpperCase() === f.novo.nome && (!f.novo.cpf || String(x.st_cpf_con || '').replace(/\D/g, '') === f.novo.cpf))) divergencias.push('A pessoa incluída não apareceu na releitura.');
      if (f.saiu && cs.some((x) => limpar(x.id_contato_con) === f.saiu && !limpar(x.dt_saida_res))) divergencias.push('O contato retirado ainda aparece na unidade.');
      if (f.segundo_sacado !== undefined && u && limpar(u.st_sacado2_uni).toUpperCase() !== f.segundo_sacado) divergencias.push('O segundo sacado não ficou gravado como pedido.');
    });
  } catch (e) { divergencias.push('Não foi possível reler a unidade agora.'); }
  return { ok: true, feitos, conferido, divergencias };
}

// ── Relatório de inadimplência ─────────────────────────────────────────────────────────────
// Para o síndico: unidade, valores, faixa de atraso e situação (acordo, jurídico). Sem nome.
// Para o escritório: o mesmo com o nome do responsável (para a cobrança), nunca CPF, email ou
// telefone (o escritório tem login próprio no Superlógica). Recente = cobrança mais antiga em
// aberto com até 120 dias; antiga = mais de 120 dias.
function faixa(d) { return d <= 30 ? 'até 30 dias' : d <= 60 ? '31 a 60 dias' : d <= 90 ? '61 a 90 dias' : d <= 120 ? '91 a 120 dias' : d <= 365 ? '121 dias a 1 ano' : 'mais de 1 ano'; }
function montarRelatorio(inad, { hoje, destino, nome }) {
  const linhas = inad.unidades.map((u) => {
    const vencidas = u.recs.filter((r) => r.vencimento && r.vencimento < hoje);
    if (!vencidas.length) return null;
    const maior = vencidas.reduce((m, r) => Math.max(m, diasEntre(r.vencimento, hoje)), 0);
    const maisAntiga = vencidas.reduce((m, r) => (!m || r.vencimento < m ? r.vencimento : m), null);
    const l = {
      unidade: u.unidade, cobrancas: vencidas.length, valor_original: cent(vencidas.reduce((s, r) => s + r.valor, 0)),
      valor_atualizado: cent(vencidas.reduce((s, r) => s + r.corrigido, 0)), mais_antiga: dataBR(maisAntiga), dias: maior, faixa: faixa(maior),
      situacao: u.juridico || vencidas.some((r) => r.id_processo) ? 'jurídico' : vencidas.some((r) => r.id_acordo) ? 'acordo com parcela vencida' : 'em aberto',
      grupo: maior <= RECENTE_DIAS ? 'recente' : 'antiga',
    };
    if (destino === 'escritorio') l.responsavel = u.responsavel;
    return l;
  }).filter(Boolean).sort((a, b) => b.valor_atualizado - a.valor_atualizado);
  const soma = (ls) => ({ unidades: ls.length, cobrancas: ls.reduce((s, l) => s + l.cobrancas, 0), valor_original: cent(ls.reduce((s, l) => s + l.valor_original, 0)), valor_atualizado: cent(ls.reduce((s, l) => s + l.valor_atualizado, 0)) });
  const recente = linhas.filter((l) => l.grupo === 'recente'); const antiga = linhas.filter((l) => l.grupo === 'antiga');
  const faixas = {};
  linhas.forEach((l) => { const f = faixas[l.faixa] || (faixas[l.faixa] = { unidades: 0, valor_atualizado: 0 }); f.unidades++; f.valor_atualizado = cent(f.valor_atualizado + l.valor_atualizado); });
  return {
    condominio: nome || '', destino: destino === 'escritorio' ? 'escritorio' : 'sindico', posicao_em: dataBR(hoje), corte_recente_dias: RECENTE_DIAS,
    total: soma(linhas), recente: Object.assign(soma(recente), { linhas: recente }), antiga: Object.assign(soma(antiga), { linhas: antiga }),
    faixas, cortado: !!inad.cortado,
  };
}

module.exports = {
  STATUS_FIN, CANAIS, RESULTADOS, MOTIVOS, PAPEIS, TIPOS_CADASTRO, RECENTE_DIAS,
  dataSL, dataBR, lerDataSL, brl, mascararCpf, mascararTelefone, mascararEmail, semDadosPessoais, cpfValido,
  lerConfig, inadimplencia, acordosDaUnidade, acordoAberto, validarPolitica, avisoNaoReceber,
  prepararAcordo, camposAcordo, emitirAcordo, conferirAcordo, prepararDesfazer, desfazerAcordo,
  validarContato, unidadeDoCondominio, registrarContato,
  statusEsperado, rotuloStatus, lerUnidades, analisarStatus, conferirCorrecaoStatus, gravarStatus,
  fichaUnidade, conferirCadastro, gravarCadastro, montarRelatorio,
};
