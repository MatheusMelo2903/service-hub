// Leitura da auditoria do Superlógica (auditoria/index): eventos de despesa, analista por despesa e por condomínio,
// R4b anexo removido depois do pagamento e R9 mexida suspeita por usuário.
'use strict';
const U = require('./util');
const A = require('./alerta');

// Usuários que não são analistas (sistema, condômino, suporte, integrações).
const USUARIOS_SISTEMA = new Set(['999996', '999997', '999998', '999999', '178']);

const PADROES = [
  ['ANEXO_REMOVIDO', /Arquivo#(\d+) removido da despesa#(\d+)/, (m) => ({ arquivo: m[1], despesa: m[2] })],
  ['VALOR_ALTERADO', /Parcela#(\d+) da despesa#(\d+)\s+alterada\..*?Valor: de R\$ ?(\d[\d.]*,\d{2}) para R\$ ?(\d[\d.]*,\d{2})/, (m) => ({ parcela: m[1], despesa: m[2], de: U.valorBR(m[3]), para: U.valorBR(m[4]) })],
  ['VENCIMENTO_ALTERADO', /Parcela#(\d+) da despesa#(\d+)\s+alterada\..*?Vencimento: de (\d{2}\/\d{2}\/\d{4}) para (\d{2}\/\d{2}\/\d{4})/, (m) => ({ parcela: m[1], despesa: m[2], de: U.dataBR(m[3]), para: U.dataBR(m[4]) })],
  ['ESTORNO', /Parcela#(\d+) da despesa#(\d+)\s+estornada\.\s*Valor R\$ ?(\d[\d.]*,\d{2})/, (m) => ({ parcela: m[1], despesa: m[2], valor: U.valorBR(m[3]) })],
  ['PARCELA_EXCLUIDA', /Parcela#(\d+) da despesa#(\d+)\s+excluída\.\s*Valor R\$ ?(\d[\d.]*,\d{2})/, (m) => ({ parcela: m[1], despesa: m[2], valor: U.valorBR(m[3]) })],
  ['DESPESA_EXCLUIDA', /^Despesa#(\d+) excluída/, (m) => ({ despesa: m[1] })],
  ['PAGAMENTO_CANCELADO', /O pagamento da parcela#(\d+) da despesa#(\d+) foi cancelado/, (m) => ({ parcela: m[1], despesa: m[2] })],
  ['FORNECEDOR_TROCADO', /Despesa#(\d+) alterada\..*?Contato: de (.*?) para (.*?)\.(?:\s|$)/, (m) => ({ despesa: m[1], de: m[2].trim(), para: m[3].trim() })],
];
const RX_DESPESA = /despesa\s?#(\d+)/i;
const RX_LANCOU = /^(Despesa#\d+ criada|Parcela#\d+ da despesa#\d+\s+criada)/;
const RX_ANEXO_FORNECEDOR = /Arquivo#(\d+) "(.*?)" removido do responsável fornecedor#(\d+)/;

function quando(r) { // "10/20/2026 23:59:53" para "2026-10-20 23:59:53"
  const d = U.data(r.dt_data_aud);
  const h = (String(r.dt_data_aud || '').match(/(\d{2}:\d{2}:\d{2})/) || [])[1] || '';
  return d ? (d + (h ? ' ' + h : '')) : '';
}

// Converte linhas da auditoria em eventos tipados. Um texto pode gerar mais de um evento (valor e vencimento juntos).
function eventos(linhas) {
  const out = [];
  for (const r of linhas || []) {
    const t = String(r.st_texto_aud || '');
    if (!t || /^\[SUDO\]/.test(t)) continue;
    const base = { id_auditoria: String(r.id_auditoria_aud || ''), quando: quando(r), id_usuario: String(r.id_usuario_usu || ''),
      usuario: String(r.st_apelido_usu || '').trim(), id_condominio: String(r.st_sql_aud || ''), condominio: String(r.st_fantasia_cond || '').trim(), texto: t };
    for (const [tipo, rx, f] of PADROES) { const m = t.match(rx); if (m) out.push({ ...base, tipo, ...f(m) }); }
  }
  return out;
}

// Nome dos arquivos removidos (a auditoria registra o nome só no evento do fornecedor).
function nomesArquivosRemovidos(linhas) {
  const m = new Map();
  for (const r of linhas || []) { const x = String(r.st_texto_aud || '').match(RX_ANEXO_FORNECEDOR); if (x) m.set(x[1], x[2]); }
  return m;
}

// Analista: último usuário que mexeu na despesa; sem isso, quem mais lançou despesas no condomínio na janela da auditoria.
function mapaAnalistas(linhas) {
  const nomesCond = new Set((linhas || []).map((r) => U.norm(r.st_fantasia_cond)).filter(Boolean));
  const naoAnalista = (nome) => nomesCond.has(U.norm(nome)) || /SINDIC|CONSELHO|CONDOMINO|PORTARIA|ZELADOR/.test(U.norm(nome));
  const porDespesa = new Map(); // id_despesa -> { quando, nome }
  const lancou = new Map();     // id_condominio -> Map(nome -> n)
  const mexeu = new Map();
  for (const r of linhas || []) {
    const id = String(r.id_usuario_usu || '');
    const nome = String(r.st_apelido_usu || '').trim();
    const t = String(r.st_texto_aud || '');
    if (!nome || USUARIOS_SISTEMA.has(id) || naoAnalista(nome) || /^\[SUDO\]/.test(t)) continue;
    const m = t.match(RX_DESPESA);
    if (!m) continue;
    const q = quando(r);
    const atual = porDespesa.get(m[1]);
    if (!atual || q >= atual.quando) porDespesa.set(m[1], { quando: q, nome });
    const c = String(r.st_sql_aud || '');
    if (!c || c === '-1') continue;
    const alvo = RX_LANCOU.test(t) ? lancou : mexeu;
    if (!alvo.has(c)) alvo.set(c, new Map());
    alvo.get(c).set(nome, (alvo.get(c).get(nome) || 0) + 1);
  }
  const maior = (mp) => [...mp.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const porCondominio = new Map();
  for (const [c, mp] of mexeu) porCondominio.set(c, maior(mp));
  for (const [c, mp] of lancou) porCondominio.set(c, maior(mp));
  return {
    porDespesa, porCondominio,
    analista(idDespesa, idCondominio) {
      const d = porDespesa.get(String(idDespesa));
      if (d) return { nome: d.nome, origem: 'último usuário na despesa' };
      const c = porCondominio.get(String(idCondominio));
      if (c) return { nome: c, origem: 'quem mais lançou no condomínio' };
      return null;
    },
  };
}

// Índice id_despesa -> parcelas (das despesas puxadas).
function indiceDespesas(itens) {
  const m = new Map();
  for (const it of itens || []) { const k = String(it.id_despesa_des || ''); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
  return m;
}

// Monta um alerta a partir de um evento, completando com a despesa quando ela foi puxada.
function deEvento(regra, tipo, gravidade, ev, despesa, ctx, extra) {
  const base = despesa || { id_despesa_des: ev.despesa, id_parcela_pdes: ev.parcela || '', id_condominio_cond: ev.id_condominio, st_fantasia_cond: ev.condominio };
  const a = A.deItem(regra, tipo, gravidade, base, ctx, extra);
  if (!a.id_condominio || a.id_condominio === '-1') a.id_condominio = ev.id_condominio;
  if (!a.condominio) a.condominio = ev.condominio;
  if (ev.parcela) a.id_parcela = ev.parcela;
  a.usuario = ev.usuario; a.quando = ev.quando; a.id_auditoria = ev.id_auditoria;
  if (ev.usuario) { a.analista = ev.usuario; a.analista_origem = 'usuário do evento na auditoria'; }
  if (!a.valor) a.valor = ev.valor || ev.para || 0;
  if (typeof a.valor !== 'number') a.valor = 0;
  a.texto_auditoria = ev.texto.slice(0, 300);
  return a;
}

const condExcluido = (id) => U.IDS_EXCLUIDOS.has(String(id)) || String(id) === U.ID_TESTE;

// R4b: anexo removido de despesa que já estava paga na data da remoção.
// R9: remoção de anexo, alteração de valor ou vencimento, estorno, exclusão, pagamento cancelado e troca de fornecedor.
function r4r9(linhas, itens, ctx) {
  const evs = eventos(linhas);
  const idx = indiceDespesas(itens);
  const nomes = nomesArquivosRemovidos(linhas);
  // Despesa lançada na janela: quem e quando (correção no mesmo dia pelo mesmo usuário é baixa).
  const criada = new Map();
  for (const r of linhas || []) { const m = String(r.st_texto_aud || '').match(/^Despesa#(\d+) criada/); if (m) criada.set(m[1], { dia: quando(r).slice(0, 10), usuario: String(r.st_apelido_usu || '').trim() }); }
  const correcao = (ev) => { const c = criada.get(String(ev.despesa)); return !!c && c.dia === ev.quando.slice(0, 10) && c.usuario === ev.usuario; };
  // Anexo novo vinculado à mesma despesa no mesmo dia: troca de arquivo, não remoção pura.
  const vinculos = new Set();
  for (const r of linhas || []) { const m = String(r.st_texto_aud || '').match(/Arquivo#\d+ vinculado a despesa#(\d+)/); if (m) vinculos.add(m[1] + '|' + quando(r).slice(0, 10)); }
  const CORRIGIVEL = new Set(['ANEXO_REMOVIDO', 'VALOR_ALTERADO', 'VENCIMENTO_ALTERADO', 'PARCELA_EXCLUIDA', 'DESPESA_EXCLUIDA']);
  const out = [];
  for (const ev of evs) {
    const parcelas = idx.get(String(ev.despesa)) || [];
    const p = (ev.parcela && parcelas.find((x) => String(x.id_parcela_pdes) === String(ev.parcela))) || parcelas[0] || null;
    const idCond = (p && p.id_condominio_cond) || ev.id_condominio;
    if (condExcluido(idCond)) continue;
    const dia = ev.quando.slice(0, 10);
    if (ev.tipo === 'ANEXO_REMOVIDO') {
      const nome = nomes.get(ev.arquivo);
      const pagas = parcelas.filter((x) => { const l = U.data(x.dt_liquidacao_pdes); return l && l <= dia; });
      const trocado = vinculos.has(String(ev.despesa) + '|' + dia);
      const nota = trocado ? '; outro arquivo foi vinculado à despesa no mesmo dia (provável troca)' : '; nenhum arquivo novo vinculado no mesmo dia';
      if (pagas.length) {
        out.push(deEvento('R4', 'R4_ANEXO_REMOVIDO', trocado ? 'media' : 'alta', ev, pagas[0], ctx, { substituido: trocado, detalhe: 'Arquivo ' + ev.arquivo + (nome ? ' "' + nome + '"' : '') + ' removido em ' + U.dataTexto(dia) + ', despesa paga em ' + U.dataTexto(U.data(pagas[0].dt_liquidacao_pdes)) + nota }));
      } else {
        const corr = correcao(ev);
        out.push(deEvento('R9', 'R9_MEXIDA', corr || trocado ? 'baixa' : 'media', ev, p, ctx, { mexida: 'Remoção de anexo', substituido: trocado, detalhe: (corr ? '(provável correção no mesmo dia) ' : '') + (trocado ? '(trocado por outro arquivo no mesmo dia) ' : '') + 'Arquivo ' + ev.arquivo + (nome ? ' "' + nome + '"' : '') + ' removido da despesa ' + ev.despesa + (p ? '' : ' (despesa fora das puxadas)') }));
      }
      continue;
    }
    let grav = 'media', mexida = '', det = '';
    if (ev.tipo === 'VALOR_ALTERADO') {
      const dif = Math.abs((ev.para || 0) - (ev.de || 0));
      grav = dif < 1 ? 'baixa' : ((ev.de && dif / ev.de > 0.2) || dif >= 500 ? 'alta' : 'media');
      mexida = 'Alteração de valor'; det = 'Valor de ' + U.moeda(ev.de) + ' para ' + U.moeda(ev.para);
    } else if (ev.tipo === 'VENCIMENTO_ALTERADO') {
      const d = Math.abs(U.dias(ev.de, ev.para) ?? 0);
      grav = d > 10 ? 'media' : 'baixa'; mexida = 'Alteração de vencimento'; det = 'Vencimento de ' + U.dataTexto(ev.de) + ' para ' + U.dataTexto(ev.para);
    } else if (ev.tipo === 'ESTORNO') {
      grav = (ev.valor || 0) >= 1000 ? 'alta' : 'media'; mexida = 'Estorno'; det = 'Parcela estornada, ' + U.moeda(ev.valor);
    } else if (ev.tipo === 'PARCELA_EXCLUIDA') { mexida = 'Exclusão de parcela'; det = 'Parcela excluída, ' + U.moeda(ev.valor); }
    else if (ev.tipo === 'DESPESA_EXCLUIDA') { mexida = 'Exclusão de despesa'; det = 'Despesa excluída'; }
    else if (ev.tipo === 'PAGAMENTO_CANCELADO') { mexida = 'Pagamento cancelado'; det = 'Pagamento da parcela cancelado'; }
    else if (ev.tipo === 'FORNECEDOR_TROCADO') { grav = 'alta'; mexida = 'Troca de fornecedor'; det = 'Fornecedor de ' + ev.de + ' para ' + ev.para; }
    if (CORRIGIVEL.has(ev.tipo) && correcao(ev)) { grav = 'baixa'; det += ' (o mesmo usuário lançou a despesa no mesmo dia: provável correção)'; }
    out.push(deEvento('R9', 'R9_MEXIDA', grav, ev, p, ctx, { mexida, detalhe: det }));
  }
  return out;
}

module.exports = { eventos, mapaAnalistas, indiceDespesas, nomesArquivosRemovidos, r4r9, USUARIOS_SISTEMA };
