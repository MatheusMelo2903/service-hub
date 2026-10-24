'use strict';
// Contas a pagar, parte de prazo (sem gravar nada no Superlógica):
//  1. Contas esperadas por condomínio: dos últimos 6 meses de despesas o Hub aprende quem cobra todo
//     mês (contratos e concessionárias), quantas contas, quanto e em que dia vence, e avisa quando a
//     conta do mês ainda não chegou ("conta da EDP do Buritis ainda não chegou e vence em 3 dias").
//  2. Prazo: parcela que vai vencer sem estar lançada, ou lançada e ainda não enviada para a
//     assinatura do síndico (marcada para a remessa, ou envio registrado no Hub). Regra da casa:
//     lançar com antecedência mínima de 2 dias úteis.
// Funções puras: recebem as parcelas lidas (despesas/index) e devolvem a lista de avisos.

const E = require('./entrada');
const U = require('./regras/util');

const ANTECEDENCIA_UTEIS = 2;
const MESES_HISTORICO = 6;
const MIN_MESES = 4;          // presente em pelo menos 4 dos 6 meses
const MIN_MESES_RECENTES = 2; // e em pelo menos 2 dos 3 últimos
const JANELA_DIAS = 12;       // a conta do mês casa com a esperada até 12 dias antes ou depois
const AVISO_DIAS = 10;        // avisa a partir de 10 dias antes do vencimento esperado
const VARIACAO = 0.15;        // valor fora da faixa: 15% acima ou abaixo da mediana

const slIso = (v) => E.slParaIso(v);
const cent = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : null);
const maisDias = U.maisDias;
const diasEntre = (a, b) => U.dias(a, b); // b menos a
const mesDe = (iso) => iso.slice(0, 7);
function mesesAntes(mes, n) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 - n, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
const mediana = (l) => { const s = l.slice().sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2)) : null; };

// ---------- dias úteis ----------
// Feriados nacionais (fixos e os que dependem da Páscoa). Feriado estadual ou municipal não entra:
// a conta de dias úteis fica do lado seguro (pode contar um dia útil a mais, nunca a menos de aviso).
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return ano + '-' + String(mes).padStart(2, '0') + '-' + String(dia).padStart(2, '0');
}
const _feriados = new Map();
function feriados(ano) {
  if (_feriados.has(ano)) return _feriados.get(ano);
  const p = pascoa(ano);
  const s = new Set(['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map((x) => ano + '-' + x)
    .concat([maisDias(p, -48), maisDias(p, -47), maisDias(p, -2), maisDias(p, 60)])); // carnaval (2 dias), sexta santa, Corpus Christi
  _feriados.set(ano, s);
  return s;
}
function diaUtil(iso) {
  const wd = new Date(iso + 'T12:00:00Z').getUTCDay();
  return wd !== 0 && wd !== 6 && !feriados(Number(iso.slice(0, 4))).has(iso);
}
// Dias úteis de hoje (exclusive) até a data (inclusive). Data passada: negativo (conta os úteis atrás).
function diasUteisAte(hoje, alvo) {
  if (alvo === hoje) return 0;
  let n = 0, d = hoje;
  const passo = alvo > hoje ? 1 : -1;
  for (let i = 0; i < 400 && d !== alvo; i++) { d = maisDias(d, passo); if (diaUtil(d)) n += passo; }
  return n;
}
// Último dia útil para lançar com a antecedência mínima (2 dias úteis antes do vencimento).
function limiteParaLancar(venc) {
  let d = venc, n = 0;
  while (n < ANTECEDENCIA_UTEIS) { d = maisDias(d, -1); if (diaUtil(d)) n++; }
  return d;
}

// ---------- contas esperadas ----------
function tipoDaConta(p) {
  const c = U.categoria(p);
  if (c === 'concessionaria' || c === 'debito_automatico') return 'concessionária';
  if (c === 'imposto') return 'imposto ou guia';
  if (c === 'sem_nota') return 'folha, tarifa ou repasse';
  return 'contrato';
}
const nomeDe = (p) => String(p.st_nome_con || p.st_fantasia_con || '').replace(/\s+/g, ' ').trim();
// Aprende o que cada fornecedor cobra todo mês. parcelas: despesas/index (comStatus=todas) do
// condomínio, com vencimento dos 6 meses fechados anteriores até o mês seguinte ao de hoje.
// Devolve a lista de contas esperadas: { chave, id_fornecedor, fornecedor, tipo, quantidade, dias[],
// valor_mediano, valor_min, valor_max, meses, conta, forma }.
function aprender(parcelas, hoje) {
  const mesHoje = mesDe(hoje);
  const meses = Array.from({ length: MESES_HISTORICO }, (_, i) => mesesAntes(mesHoje, MESES_HISTORICO - i));
  const recentes = new Set(meses.slice(-3));
  const porForn = new Map();
  for (const p of parcelas || []) {
    const v = slIso(p.dt_vencimento_pdes);
    const id = String(p.id_contato_con || '');
    if (!v || !id || !meses.includes(mesDe(v))) continue;
    if (!porForn.has(id)) porForn.set(id, { amostra: p, porMes: new Map() });
    const g = porForn.get(id);
    if (!g.porMes.has(mesDe(v))) g.porMes.set(mesDe(v), []);
    g.porMes.get(mesDe(v)).push({ dia: Number(v.slice(8, 10)), valor: cent(p.vl_valor_pdes), conta: ((p.apropriacao || [])[0] || {}).st_conta_cont || null, forma: String(p.id_forma_pag || ''), id_despesa: String(p.id_despesa_des) });
  }
  const out = [];
  for (const [id, g] of porForn) {
    // Uma despesa conta uma vez por mês (parcelas da mesma despesa no mesmo mês não viram duas contas).
    const mesesCom = [...g.porMes.keys()];
    if (mesesCom.length < MIN_MESES || mesesCom.filter((m) => recentes.has(m)).length < MIN_MESES_RECENTES) continue;
    const contagens = mesesCom.map((m) => new Set(g.porMes.get(m).map((x) => x.id_despesa)).size);
    const quantidade = Math.max(1, mediana(contagens));
    const dias = [];
    for (let k = 0; k < quantidade; k++) {
      const ds = mesesCom.map((m) => g.porMes.get(m).map((x) => x.dia).sort((a, b) => a - b)[k]).filter((x) => x != null);
      if (ds.length) dias.push(mediana(ds));
    }
    const valores = [].concat(...mesesCom.map((m) => g.porMes.get(m).map((x) => x.valor))).filter((x) => x != null && x > 0);
    const contas = [].concat(...mesesCom.map((m) => g.porMes.get(m).map((x) => x.conta))).filter(Boolean);
    const formas = [].concat(...mesesCom.map((m) => g.porMes.get(m).map((x) => x.forma)));
    const maisComum = (l) => { const c = new Map(); l.forEach((x) => c.set(x, (c.get(x) || 0) + 1)); return [...c].sort((a, b) => b[1] - a[1])[0]; };
    out.push({
      chave: 'f' + id, id_fornecedor: id, fornecedor: nomeDe(g.amostra), tipo: tipoDaConta(g.amostra), quantidade, dias: dias.sort((a, b) => a - b),
      valor_mediano: mediana(valores), valor_min: valores.length ? Math.min(...valores) : null, valor_max: valores.length ? Math.max(...valores) : null,
      meses: mesesCom.length, conta: contas.length ? maisComum(contas)[0] : null, forma: formas.length ? Number(maisComum(formas)[0]) : null,
    });
  }
  return out.sort((a, b) => a.dias[0] - b.dias[0] || a.fornecedor.localeCompare(b.fornecedor));
}
function dataNoMes(mes, dia) {
  const [a, m] = mes.split('-').map(Number);
  const fim = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return mes + '-' + String(Math.min(dia, fim)).padStart(2, '0');
}
function textoPrazo(dias) {
  if (dias === 0) return 'vence hoje';
  if (dias === 1) return 'vence amanhã';
  if (dias > 1) return 'vence em ' + dias + ' dias';
  return dias === -1 ? 'venceu ontem' : 'venceu há ' + (-dias) + ' dias';
}
// Confere as contas esperadas contra o que já foi lançado. Devolve os avisos das que não chegaram
// (vencimento esperado de 10 dias à frente até 5 dias atrás) e das que chegaram com valor fora do normal
// (vencimento do último mês).
// ignoradas: Set de chaves que a pessoa mandou ignorar.
function contasQueFaltam(esperadas, parcelas, hoje, nomeCond, ignoradas) {
  const avisos = [];
  const lancadas = (parcelas || []).map((p) => ({ p, v: slIso(p.dt_vencimento_pdes), id: String(p.id_contato_con || ''), valor: cent(p.vl_valor_pdes), desp: String(p.id_despesa_des) })).filter((x) => x.v);
  for (const e of esperadas) {
    if (ignoradas && ignoradas.has(e.chave)) continue;
    const usadas = new Set();
    for (const mes of [mesesAntes(mesDe(hoje), 1), mesDe(hoje), mesesAntes(mesDe(hoje), -1)]) {
      for (const dia of e.dias) {
        const venc = dataNoMes(mes, dia);
        const dist = diasEntre(hoje, venc);
        // Até 31 dias atrás confere o valor da conta que chegou; "não chegou" só até 5 dias depois do vencimento.
        if (dist > AVISO_DIAS || dist < -31) continue;
        const achou = lancadas.find((x) => x.id === e.id_fornecedor && !usadas.has(x.desp) && Math.abs(diasEntre(venc, x.v)) <= JANELA_DIAS);
        if (achou) {
          usadas.add(achou.desp);
          if (e.valor_mediano && achou.valor && Math.abs(achou.valor - e.valor_mediano) > e.valor_mediano * VARIACAO && e.tipo !== 'folha, tarifa ou repasse') {
            avisos.push({ codigo: 'valor_fora_do_normal', nivel: 'atencao', chave: e.chave, fornecedor: e.fornecedor, vencimento: achou.v, id_despesa: achou.desp, valor: achou.valor, valor_mediano: e.valor_mediano,
              texto: 'Conta de ' + e.fornecedor + (nomeCond ? ' do ' + nomeCond : '') + ' chegou com ' + U.moeda(achou.valor / 100) + ', fora do normal (costuma ser ' + U.moeda(e.valor_mediano / 100) + ').' });
          }
          continue;
        }
        if (dist < -5) continue;
        const uteis = diasUteisAte(hoje, venc);
        const nivel = dist < 0 ? 'vencida' : uteis <= ANTECEDENCIA_UTEIS ? 'urgente' : 'atencao';
        avisos.push({ codigo: 'conta_nao_chegou', nivel, chave: e.chave, id_fornecedor: e.id_fornecedor, fornecedor: e.fornecedor, tipo: e.tipo, vencimento: venc, dias: dist, dias_uteis: uteis,
          valor_mediano: e.valor_mediano, conta: e.conta, limite_lancar: limiteParaLancar(venc),
          texto: 'Conta de ' + e.fornecedor + (nomeCond ? ' do ' + nomeCond : '') + ' ainda não chegou e ' + textoPrazo(dist) + ' (dia ' + venc.split('-').reverse().join('/') + ').' });
      }
    }
  }
  return avisos;
}

// ---------- prazo das parcelas lançadas ----------
// enviadas: Map id_parcela -> registro de envio para assinatura (fin_pagar_envios).
// Devolve os avisos das parcelas em aberto que vencem em até 5 dias úteis (ou já venceram há até 10
// dias) e ainda não foram para a assinatura, e das que foram lançadas sem a antecedência mínima.
function prazos(parcelas, hoje, enviadas, nomeCond) {
  const avisos = [];
  for (const p of parcelas || []) {
    const v = slIso(p.dt_vencimento_pdes);
    if (!v || String(p.fl_liquidado_pdes) === '1' || slIso(p.dt_liquidacao_pdes)) continue;
    const dist = diasEntre(hoje, v);
    if (dist < -10) continue;
    const uteis = diasUteisAte(hoje, v);
    if (uteis > 5) continue;
    const forma = Number(p.id_forma_pag);
    const debito = forma === 7;
    const remessa = ['1', '2', '3', '4'].includes(String(p.fl_remessastatus_pdes == null ? '' : p.fl_remessastatus_pdes).trim());
    const envio = enviadas && enviadas.get(String(p.id_parcela_pdes));
    const base = { id_parcela: String(p.id_parcela_pdes), id_despesa: String(p.id_despesa_des), fornecedor: nomeDe(p), vencimento: v, dias: dist, dias_uteis: uteis, valor: cent(p.vl_valor_pdes), forma,
      remessa, enviado: envio ? { em: envio.enviado_em, para: envio.para, por: envio.enviado_por_email } : null, tem_codigo: !!E.acharLinha(String(p.st_codigobarras_pdes || '').replace(/\D/g, ''), hoje), tem_pix: !!String(p.st_pixchave_pdes || '').trim() };
    if (dist < 0) {
      avisos.push(Object.assign(base, { codigo: 'vencida_em_aberto', nivel: 'vencida', texto: base.fornecedor + (nomeCond ? ' (' + nomeCond + ')' : '') + ': ' + textoPrazo(dist) + ' e está em aberto. Se foi paga, a baixa entra pelo retorno do banco; se não, veja Juros e atrasos.' }));
      continue;
    }
    if (debito || remessa || envio) continue;
    avisos.push(Object.assign(base, { codigo: 'sem_envio_assinatura', nivel: uteis <= ANTECEDENCIA_UTEIS ? 'urgente' : 'atencao',
      texto: base.fornecedor + (nomeCond ? ' (' + nomeCond + ')' : '') + ': ' + textoPrazo(dist) + ' (' + (uteis === 1 ? '1 dia útil' : uteis + ' dias úteis') + ') e ainda não foi enviada para a assinatura do síndico.' }));
  }
  return avisos.sort((a, b) => a.vencimento.localeCompare(b.vencimento));
}
// Parcelas lançadas sem a antecedência mínima (gerada a menos de 2 dias úteis do vencimento),
// no mês de hoje. Serve para o quadro por analista.
function lancadasEmCimaDoPrazo(parcelas, hoje) {
  const mes = mesDe(hoje);
  return (parcelas || []).filter((p) => {
    const v = slIso(p.dt_vencimento_pdes), g = slIso(p.dt_geracao_des);
    if (!v || !g || mesDe(g) !== mes || Number(p.id_forma_pag) === 7) return false;
    return diasUteisAte(g, v) < ANTECEDENCIA_UTEIS;
  }).map((p) => ({ id_parcela: String(p.id_parcela_pdes), id_despesa: String(p.id_despesa_des), fornecedor: nomeDe(p), lancada: slIso(p.dt_geracao_des), vencimento: slIso(p.dt_vencimento_pdes) }));
}

module.exports = { ANTECEDENCIA_UTEIS, pascoa, feriados, diaUtil, diasUteisAte, limiteParaLancar, aprender, contasQueFaltam, prazos, lancadasEmCimaDoPrazo, mesesAntes, dataNoMes, textoPrazo };
