'use strict';
// ─────────────────────────────────────────────────────────────────────────
// T38: Fechamento do mês. Junta o que já existe e diz se o condomínio está pronto para gerar o
// balancete ou o que falta, item por item, com o que trava e onde resolver:
//   1. conciliação do mês com diferença zero (T35);
//   2. extrato importado até o último dia útil (T35, último dia com extrato de cada conta);
//   3. pré balancete sem pendência (T31);
//   4. boletos do mês conferidos (T27);
//   5. anexos conferidos (T32 na tela, financeiro/anexos-conferencia.js).
// Itens 3, 4 e 5 aceitam marca manual de conferido (quem e quando, tabela fin_fechamento_marca);
// a marca vale enquanto não aparecer pendência nova depois dela. Conciliação e extrato não
// aceitam marca: são números do banco. Função pura (sem chamada): testada em scripts/.
// ─────────────────────────────────────────────────────────────────────────

const ITENS_MARCAVEIS = ['pre_balancete', 'boletos', 'anexos'];
const dataBR = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; };
const brl = (v) => 'R$ ' + (Math.round(Number(v || 0) * 100) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function maisDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function diasUteisEntre(a, b) { let n = 0; for (let d = maisDias(a, 1); d <= b; d = maisDias(d, 1)) if (!fimSemana(d)) n++; return n; }
const fimSemana = (iso) => { const w = new Date(iso + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; };

// Último dia útil (segunda a sexta) que já precisa ter extrato: o último do mês; no mês corrente,
// o último antes de hoje (o extrato de hoje ainda não saiu).
function ultimoDiaUtil(c, hoje) {
  let d = c.fim < hoje ? c.fim : maisDias(hoje, -1);
  while (fimSemana(d)) d = maisDias(d, -1);
  return d < c.inicio ? null : d;
}

function item(chave, titulo, resolver) {
  return { chave, titulo, situacao: 'pendente', trava: '', detalhe: '', pode_marcar: ITENS_MARCAVEIS.includes(chave), marca: null, resolver };
}
// Chaves das pendências de cada item (revisão 1, M4): a marca guarda as chaves que a pessoa
// conferiu e só vale enquanto as pendências de agora estiverem todas entre elas.
const MAX_CHAVES = 2000;
const chavesDe = {
  pre_balancete: (pre) => [].concat(...((pre && pre.grupos) || []).map((g) => (g.itens || []).filter((a) => a.gravidade !== 'baixa')
    .map((a) => [g.chave, a.tipo || '', a.id_parcela || a.id_despesa || '', a.mexida || ''].join('|')))),
  boletos: (bol) => ((bol && bol.alertas) || []).map((a) => [a.tipo || '', a.unidade_id || a.unidade || '', a.titulo || ''].join('|')),
  anexos: (r) => {
    if (!r) return [];
    const k = [].concat(...(r.despesas || []).map((d) => (d.achados || []).filter((a) => a.gravidade !== 'baixa').map((a) => [d.id_despesa, a.tipo, a.arquivo || ''].join('|'))));
    (r.escaneados || []).forEach((x) => k.push(['escaneado', x.id_despesa, x.arquivo].join('|')));
    if (r.sem_cnpj_cadastro) k.push('sem_cnpj_cadastro');
    return k;
  },
};
function chavesPendencias(itemNome, dado) {
  const l = [...new Set((chavesDe[itemNome] ? chavesDe[itemNome](dado) : []).map(String))].sort();
  return l.length > MAX_CHAVES ? null : l;
}
function aplicarMarca(it, marca, pendenciasAgora, chavesAgora) {
  if (!it.pode_marcar || !marca || marca.ativo === false) return;
  it.marca = { por: marca.marcado_por_email || '', em: marca.marcado_em || '', observacao: marca.observacao || '', pendencias: marca.pendencias || 0 };
  if (it.situacao !== 'pendente') return;
  let vale;
  if (Array.isArray(marca.chaves) && Array.isArray(chavesAgora)) { const ja = new Set(marca.chaves.map(String)); vale = chavesAgora.every((c) => ja.has(c)); }
  else vale = (Number(marca.pendencias) || 0) >= pendenciasAgora;
  if (vale) {
    it.situacao = 'conferido';
    it.detalhe = (it.detalhe ? it.detalhe + ' ' : '') + 'Conferido à mão por ' + (marca.marcado_por_email || 'usuário') + '.';
  } else {
    it.marca.vencida = true;
    it.detalhe = (it.detalhe ? it.detalhe + ' ' : '') + 'A marca de conferido perdeu a validade: apareceram pendências novas depois dela.';
  }
}

const falhou = (x) => !x || x.erro;
const NOME_BOLETO = { valor_fora_padrao: 'valor fora do padrão', sem_boleto: 'unidade sem boleto', boleto_em_dobro: 'boleto em dobro', leitura_faltando: 'leitura faltando',
  leitura_zerada: 'leitura zerada', rateio_sumiu: 'rateio que sumiu', rateio_apareceu: 'rateio novo', parcela_repetida: 'parcela repetida' };

function itemConciliacao(conc) {
  const it = item('conciliacao', 'Conciliação do mês com diferença zero', { painel: 'conciliacao', rotulo: 'Abrir a Conciliação' });
  if (falhou(conc)) { it.situacao = 'falha'; it.trava = 'Não foi possível ler a conciliação agora.'; return it; }
  const contas = (conc.contas || []).filter((k) => k.situacao !== 'conta_caixa');
  const travas = [];
  let pendentes = 0, conferidas = 0;
  contas.forEach((k) => {
    if (k.situacao === 'falha' || k.situacao === 'descartada') { travas.push('conta ' + k.descricao + ': não foi possível ler o extrato'); return; }
    if (k.situacao !== 'ok' || !k.quadro) return;
    conferidas++;
    const dif = Number(k.quadro.diferenca_saldo) || 0;
    if (Math.abs(dif) >= 0.01) travas.push('conta ' + k.descricao + ': diferença de ' + brl(dif) + ' entre o saldo do sistema e o do banco' + (k.quadro.data_saldo ? ' em ' + dataBR(k.quadro.data_saldo) : ''));
    const t = k.totais || {};
    pendentes += (t.banco_sem_lancamento || 0) + (t.lancamento_sem_banco || 0) + (t.valor_diferente || 0);
  });
  if (!contas.length) { it.trava = 'Nenhuma conta bancária encontrada para este condomínio.'; return it; }
  if (travas.length) { it.trava = travas.join('; ') + '.'; }
  else if (!conferidas) { it.trava = 'Nenhuma conta com extrato no mês para conciliar.'; }
  else it.situacao = 'ok';
  it.detalhe = conferidas + ' conta(s) com extrato no mês' + (pendentes ? '; ' + pendentes + ' item(ns) ainda sem par (itens do banco sem lançamento, lançamentos sem banco ou valor diferente)' : '') + '.';
  return it;
}

function itemExtrato(conc, alvo) {
  const it = item('extrato', 'Extrato importado até o último dia útil' + (alvo ? ' (' + dataBR(alvo) + ')' : ''), { painel: 'conciliacao', rotulo: 'Abrir a Conciliação', externo: 'Importar o extrato no Superlógica' });
  if (falhou(conc)) { it.situacao = 'falha'; it.trava = 'Não foi possível ler os extratos agora.'; return it; }
  if (!alvo) { it.situacao = 'ok'; it.detalhe = 'O mês ainda não teve dia útil completo.'; return it; }
  const contas = (conc.contas || []).filter((k) => k.situacao !== 'conta_caixa');
  const travas = [], avisos = [];
  contas.forEach((k) => {
    const ult = k.quadro && k.quadro.ultimo_extrato;
    const poucoMov = k.quadro && k.quadro.movimento_baixo && !k.principal;
    if (k.situacao === 'falha' || k.situacao === 'descartada') { travas.push('conta ' + k.descricao + ': não foi possível ler'); return; }
    if (k.situacao === 'sem_extrato' || !ult) {
      if (k.principal) travas.push('conta ' + k.descricao + ' (principal): nenhum extrato importado no mês');
      else avisos.push('conta ' + k.descricao + ' sem movimento no mês');
      return;
    }
    if (ult >= alvo) return;
    if (poucoMov) avisos.push('conta ' + k.descricao + ' de pouco movimento, último extrato ' + dataBR(ult));
    // Conta que não é a principal, com até 2 dias úteis de diferença: pode ser só falta de movimento
    // nos últimos dias (o extrato não traz linha em dia sem lançamento). Fica como aviso.
    else if (!k.principal && diasUteisEntre(ult, alvo) <= 2) avisos.push('conta ' + k.descricao + ': último lançamento no extrato em ' + dataBR(ult) + ' (confira se faltou importar ou se não houve movimento)');
    else travas.push('conta ' + k.descricao + ': extrato só até ' + dataBR(ult));
  });
  if (!contas.length) { it.trava = 'Nenhuma conta bancária encontrada para este condomínio.'; return it; }
  if (travas.length) it.trava = travas.join('; ') + '.';
  else it.situacao = 'ok';
  if (avisos.length) it.detalhe = avisos.join('; ') + '.';
  return it;
}

function itemPre(pre, marca) {
  const it = item('pre_balancete', 'Pré balancete sem pendência', { aba: 'pre', rotulo: 'Abrir o pré balancete' });
  if (falhou(pre)) { it.situacao = 'falha'; it.trava = 'Não foi possível montar o pré balancete agora.'; return it; }
  if (pre.pode_fechar && !(pre.falhas || []).length) it.situacao = 'ok';
  else if (pre.pode_fechar) { it.trava = 'Algumas leituras do Superlógica falharam; atualize o pré balancete.'; it.pode_marcar = false; return it; }
  else it.trava = (pre.grupos || []).filter((g) => g.bloqueiam).map((g) => g.bloqueiam + ' ' + g.titulo.toLowerCase()).join('; ') + '.';
  it.detalhe = (pre.parcelas_pagas || 0) + ' parcela(s) paga(s) no mês' + (pre.para_conferir ? '; ' + pre.para_conferir + ' item(ns) de gravidade baixa só para conferir' : '') + '.';
  aplicarMarca(it, marca, pre.pendencias || 0, chavesPendencias('pre_balancete', pre));
  return it;
}

function itemBoletos(bol, marca) {
  const it = item('boletos', 'Boletos do mês conferidos', { painel: 'boletos', rotulo: 'Abrir Boletos' });
  if (falhou(bol)) { it.situacao = 'falha'; it.trava = 'Não foi possível ler os boletos agora.'; return it; }
  const r = bol.resumo || {};
  if (!r.boletos) { it.trava = 'Nenhum boleto com vencimento no mês encontrado.'; it.pode_marcar = true; aplicarMarca(it, marca, 0, []); return it; }
  if (!r.alertas) it.situacao = 'ok';
  else it.trava = r.alertas + ' ponto(s) para conferir nos boletos (' + Object.keys(r.alertas_por_tipo || {}).map((k) => (NOME_BOLETO[k] || k.replace(/_/g, ' ')) + ' ' + r.alertas_por_tipo[k]).join(', ') + ').';
  it.detalhe = r.boletos + ' boleto(s) em ' + (r.unidades_com_boleto || 0) + ' unidade(s), total ' + brl(r.valor_total) + '.';
  aplicarMarca(it, marca, r.alertas || 0, chavesPendencias('boletos', bol));
  return it;
}

function itemAnexos(anx, marca) {
  const it = item('anexos', 'Anexos das despesas conferidos', { aba: 'pre', rotulo: 'Ver a conferência dos anexos' });
  if (!anx || anx.erro) { it.situacao = 'falha'; it.trava = (anx && anx.motivo) || 'Não foi possível conferir os anexos agora.'; return it; }
  if (anx.calculando) {
    it.situacao = 'calculando';
    it.trava = 'Conferindo os anexos' + (anx.total ? ' (' + anx.feitos + ' de ' + anx.total + ')' : '') + '. A tela atualiza sozinha.';
    return it;
  }
  const r = anx.resultado || {};
  const s = r.resumo || {};
  if (r.cortado) { it.trava = 'O mês tem despesas demais para conferir de uma vez.'; it.pode_marcar = false; return it; }
  // Revisão 1, m2: escaneado só listado e cadastro sem CNPJ também pedem conferência (aceitam marca).
  if (r.pode_fechar && !s.escaneados_nao_lidos && !r.sem_cnpj_cadastro) it.situacao = 'ok';
  else {
    const partes = [];
    if (s.para_conferir) partes.push(s.para_conferir + ' achado(s) em ' + (s.despesas_para_conferir || s.despesas_com_achado) + ' despesa(s)');
    if (s.falhas) partes.push(s.falhas + ' anexo(s) que não deu para baixar ou ler (atualize para tentar de novo)');
    if (s.escaneados_nao_lidos) partes.push(s.escaneados_nao_lidos + ' escaneado(s) sem leitura para conferir à mão');
    if (r.sem_cnpj_cadastro) partes.push('cadastro do condomínio sem CNPJ no Superlógica (pagador e tomador não conferidos)');
    it.trava = partes.join('; ') + '.';
    // Falha de download ou leitura se resolve atualizando: não aceita marca.
    if (s.falhas) it.pode_marcar = false;
  }
  it.detalhe = (s.anexos || 0) + ' anexo(s) de ' + (s.despesas || 0) + ' despesa(s); ' + (s.lidos_texto || 0) + ' lidos pelo texto, ' + (s.lidos_interna || 0) + ' escaneados lidos'
    + (s.escaneados_nao_lidos ? ', ' + s.escaneados_nao_lidos + ' escaneado(s) só listado(s)' : '') + '.';
  aplicarMarca(it, marca, (s.para_conferir || 0) + (s.escaneados_nao_lidos || 0) + (r.sem_cnpj_cadastro ? 1 : 0), chavesPendencias('anexos', r));
  return it;
}

// entradas: { comp, hoje, conc, pre, boletos, anexos, marcas: { item: marca } }
function montarFechamento(e) {
  const marcas = e.marcas || {};
  const alvo = ultimoDiaUtil(e.comp, e.hoje);
  const itens = [
    itemConciliacao(e.conc), itemExtrato(e.conc, alvo), itemPre(e.pre, marcas.pre_balancete),
    itemBoletos(e.boletos, marcas.boletos), itemAnexos(e.anexos, marcas.anexos),
  ];
  const faltam = itens.filter((i) => i.situacao !== 'ok' && i.situacao !== 'conferido');
  const calculando = itens.some((i) => i.situacao === 'calculando');
  return {
    competencia: e.comp.rotulo, ultimo_dia_util: alvo, itens,
    pronto: !faltam.length, calculando,
    falta: faltam.map((i) => i.titulo),
    status: !faltam.length ? 'Pronto para gerar o balancete' : (calculando && faltam.length === 1 ? 'Conferindo os anexos' : 'Falta: ' + faltam.map((i) => i.titulo.toLowerCase()).join('; ')),
  };
}

module.exports = { montarFechamento, ultimoDiaUtil, ITENS_MARCAVEIS, aplicarMarca, chavesPendencias };
