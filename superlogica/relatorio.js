// Relatório mensal do síndico (T13). Junta, só com leituras do Superlógica:
//  saldo do caixa no início e no fim do mês (caixa/index), receitas e despesas do mês por conta
//  (balancetes/index, o mesmo demonstrativo da prestação de contas), saldo por conta hoje,
//  inadimplência hoje, contas a pagar nos próximos 30 dias e os alertas abertos (T05).
// Nenhum número é calculado por estimativa: o que não veio do Superlógica volta como null e o
// PDF escreve "não disponível".

const consulta = require('./consulta');
const alertas = require('./alertas');

const doisDig = (n) => String(n).padStart(2, '0');
const dataSL = (y, m, d) => doisDig(m) + '/' + doisDig(d) + '/' + y;
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const cent = (v) => Math.round(v * 100) / 100;

async function saldoCaixaEm(cliente, id, y, m, d) {
  const j = await cliente.get('caixa/index', { idCondominio: id, dtInicio: dataSL(y, m, d), dtFim: dataSL(y, m, d) });
  const l = Array.isArray(j) ? j.find((x) => x && x.saldoinicialconta !== undefined) : null;
  return l ? cent(num(l.saldoinicialconta)) : null;
}

// caixa/index devolve UMA linha "Saldo anterior" com o saldo consolidado de todas as contas
// (conferido no Casablanca: saldo inicial + receitas menos despesas = saldo do dia 1 seguinte).
// Demonstrativo do mês: receitas (contas 1.x) e despesas por grupo (2.x) com as contas de cada grupo.
async function demonstrativo(cliente, id, y, m) {
  const ult = new Date(y, m, 0).getDate();
  const j = await cliente.get('balancetes/index', { idCondominio: id, dtInicio: dataSL(y, m, 1), dtFim: dataSL(y, m, ult) });
  const linhas = [];
  (Array.isArray(j) ? j : []).forEach((b) => ((b && b.itens) || []).forEach((g) => (g || []).forEach((l) => linhas.push(l))));
  const conta = (l) => limpar(l.conta);
  // Sem a linha de total no balancete devolve null (o PDF escreve "não disponível", nunca zero inventado).
  const total = (c) => { const l = linhas.find((x) => conta(x) === c); return l ? cent(num(l.valor)) : null; };
  const receitas = linhas.filter((l) => /^1\.\d+$/.test(conta(l))).map((l) => ({ conta: conta(l), descricao: limpar(l.descricao), valor: cent(num(l.valor)) }));
  const grupos = linhas.filter((l) => /^2\.\d+$/.test(conta(l))).map((g) => ({
    conta: conta(g), descricao: limpar(g.descricao), valor: cent(num(g.valor)),
    contas: linhas.filter((l) => conta(l).startsWith(conta(g) + '.') && /^\d+(\.\d+){2}$/.test(conta(l))).map((l) => ({ conta: conta(l), descricao: limpar(l.descricao), valor: cent(num(l.valor)) })),
  }));
  return { total_receitas: total('1'), total_despesas: total('2'), receitas, despesas: grupos, vazio: !linhas.length };
}

// mes = { ano, mes } ; hoje = Date (Brasília). Cada parte falha sozinha (null + aviso).
async function montarRelatorio(cliente, id, alvo, hoje, cfgAlertas) {
  const { ano, mes } = alvo;
  const prox = mes === 12 ? [ano + 1, 1] : [ano, mes + 1];
  const fimNoPassado = new Date(prox[0], prox[1] - 1, 1) <= hoje;
  const falhas = [];
  const parte = (nome, p) => p.catch(() => { falhas.push(nome); return null; });
  const [saldoIni, saldoFim, dem, contas, inad, pend, al] = await Promise.all([
    parte('saldo do início do mês', saldoCaixaEm(cliente, id, ano, mes, 1)),
    fimNoPassado ? parte('saldo do fim do mês', saldoCaixaEm(cliente, id, prox[0], prox[1], 1)) : Promise.resolve(null),
    parte('receitas e despesas do mês', demonstrativo(cliente, id, ano, mes)),
    // Mês fechado: saldo de cada conta no último dia do mês (soma = saldo do fim do mês); mês corrente: hoje.
    parte('saldo por conta', consulta.contas(cliente, id, fimNoPassado ? new Date(prox[0], prox[1] - 1, 0) : hoje)),
    parte('inadimplência', consulta.inadimplencia(cliente, id, hoje)),
    parte('contas a pagar', consulta.contasPendentes(cliente, id, hoje)),
    parte('alertas', alertas.calcularAlertas(cliente, id, hoje, cfgAlertas || {})),
  ]);
  return {
    mes: ano + '-' + doisDig(mes),
    mes_fechado: fimNoPassado,
    saldo_inicio_mes: saldoIni,
    saldo_fim_mes: saldoFim,
    demonstrativo: dem,
    contas: contas ? { total: contas.total, contas: contas.contas.map((c) => ({ descricao: c.descricao, banco: c.banco, principal: c.principal, saldo: c.saldo })) } : null,
    inadimplencia: inad ? { total_corrigido: inad.total_corrigido, total_original: inad.total_original, quantidade_unidades: inad.quantidade_unidades, maiores: inad.unidades.slice(0, 10).map((u) => ({ unidade: u.unidade, bloco: u.bloco, valor_corrigido: u.valor_corrigido, dias_atraso_maior: u.dias_atraso_maior })), truncado: inad.truncado } : null,
    a_vencer_30_dias: pend ? { quantidade: pend.a_vencer_30_dias.quantidade, total: pend.a_vencer_30_dias.total, truncado: pend.a_vencer_30_dias.truncado,
      itens: pend.a_vencer_30_dias.itens.map((c) => ({ vencimento: c.vencimento, fornecedor: c.fornecedor, descricao: c.descricao, valor: c.valor })) } : null,
    vencidas: pend ? { quantidade: pend.vencidas.quantidade, total: pend.vencidas.total, truncado: pend.vencidas.truncado } : null,
    alertas: al ? al.alertas.map((a) => ({ chave: a.chave, tipo: a.tipo, titulo: a.titulo })) : null,
    alertas_parciais: al && al.falhas && al.falhas.length ? al.falhas : null,
    falhas: falhas.concat(al && al.falhas && al.falhas.length ? ['alertas (parcial: ' + al.falhas.join(', ') + ')'] : []),
  };
}

module.exports = { montarRelatorio, demonstrativo };
