'use strict';
// Conferência dos boletos antes de enviar (T27). Só leitura: todas as chamadas são GET.
//
// Para um condomínio e uma competência (mês de vencimento), lê no Superlógica as cobranças
// do mês e as dos 3 meses anteriores (cobranca/index, status=validos, paginado de 50 em 50,
// no máximo 3 chamadas ao mesmo tempo) e aponta, por unidade:
//   valor_fora_padrao   total do mês acima de 1,5 vez ou abaixo de metade da média dos meses anteriores
//   sem_boleto          unidade que tinha boleto nos meses anteriores e não tem no mês
//   boleto_em_dobro     duas ou mais cobranças normais na mesma unidade no mês
//   leitura_faltando    item de leitura (água, gás) que havia antes e não veio
//   leitura_zerada      item de leitura que veio com valor zero
//   rateio_sumiu        rateio extra que estava no mês anterior e não veio
//   rateio_apareceu     rateio extra novo no mês
//   parcela_repetida    rateio parcelado com o mesmo número de parcela do mês anterior
// Parcelas de acordo e cobranças canceladas ficam fora da comparação.
// Não grava nada e não devolve dados pessoais (nome, CPF, email, senha): só unidade, valores e itens.

const POR_PAGINA = 50;          // limite da API (51 ou mais dá HTTP 400)
const MAX_PAGINAS = 40;         // trava: 2.000 cobranças por mês
const SIMULTANEAS = 3;          // regra da noite: no máximo 3 chamadas ao mesmo tempo
const MESES_HISTORICO = 3;
const FATOR_ALTO = 1.5;
const FATOR_BAIXO = 0.5;
const PARTE_RELEVANTE = 0.5;    // rateio ou leitura "do condomínio": em pelo menos metade das unidades
const LEITURA_PEQUENA = 5;      // abaixo de R$ 5 no mês anterior, a falta pode ser consumo zero

const doisDig = (n) => String(n).padStart(2, '0');
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const cent = (v) => Math.round(v * 100) / 100;
const semAcento = (s) => limpar(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const reais = (v) => 'R$ ' + cent(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// "10/10/2026 00:00:00" (MM/DD/AAAA) para "2026-10-10"
function dataISO(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? m[3] + '-' + doisDig(m[1]) + '-' + doisDig(m[2]) : '';
}

function competenciaValida(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const ano = +m[1], mes = +m[2];
  if (mes < 1 || mes > 12 || ano < 2000 || ano > 2100) return null;
  return { ano, mes };
}
function rotulo(c) { return c.ano + '-' + doisDig(c.mes); }
function mesesAnteriores(c, n) {
  const out = [];
  let ano = c.ano, mes = c.mes;
  for (let i = 0; i < n; i++) { mes--; if (mes === 0) { mes = 12; ano--; } out.push({ ano, mes }); }
  return out;
}
function janela(c) {
  const ultimo = new Date(c.ano, c.mes, 0).getDate();
  return { dtInicio: doisDig(c.mes) + '/01/' + c.ano, dtFim: doisDig(c.mes) + '/' + doisDig(ultimo) + '/' + c.ano };
}

// Tipo do item da composição do boleto, pelo nome da conta de receita.
function tipoItem(descricao, complemento) {
  const d = semAcento(descricao);
  if (/^(multa|juros|correcao|honorario|atualizacao|desconto|isencao|credito|abatimento)/.test(d)) return 'encargo';
  if (/acordo/.test(d)) return 'acordo';
  if (/(consumo|leitura|medicao|hidrometro)/.test(d)) return 'leitura';
  if (/(agua|gas)/.test(d) && !/(comum|fixa|fixo|parcela|rateio|taxa|reuso|botij)/.test(d)) return 'leitura';
  if (/fundo de reserva/.test(d)) return 'base';
  if (/(rateio|extra|chamada|obra|melhoria|benfeitoria|reforma|pintura|decimo|13|contribuicao|investimento|seguro anual)/.test(d)) return 'extra';
  if (/parc\.?\s*\d+\s*\/\s*\d+/i.test(String(complemento || ''))) return 'extra';
  if (/(churrasq|salao|festa|tag|controle|chave|reserva|mudanca|cartao|adesivo|segunda via|2a via|advertencia)/.test(d)) return 'eventual';
  return 'base';
}

function parcela(complemento) {
  const m = String(complemento || '').match(/parc\.?\s*(\d+)\s*\/\s*(\d+)/i);
  return m ? { n: +m[1], de: +m[2] } : null;
}

// Cobrança do Superlógica no formato enxuto usado na conferência (sem dado pessoal).
function normalizar(c) {
  const itens = (Array.isArray(c.receita_apropriacao) ? c.receita_apropriacao : []).map((r) => {
    const descricao = limpar(r.st_descricao_cont);
    const complemento = limpar(r.st_complemento_rec);
    return {
      conta: limpar(r.st_conta_cont) || semAcento(descricao),
      descricao,
      complemento: complemento.slice(0, 80),
      valor: cent(num(r.vl_valor_reca != null && r.vl_valor_reca !== '' ? r.vl_valor_reca : r.vl_valor_rec)),
      tipo: tipoItem(descricao, complemento),
    };
  });
  const bloco = limpar(c.st_bloco_uni);
  const unidade = limpar(c.st_unidade_uni);
  const acordo = /acordo/i.test(String(c.st_label_recb || '')) || num(c.id_acordo_recb) > 0 || itens.some((i) => i.tipo === 'acordo');
  return {
    id: String(c.id_recebimento_recb || ''),
    unidade_id: String(c.id_unidade_uni || ''),
    unidade: (bloco ? bloco + ' ' : '') + unidade,
    vencimento: dataISO(c.dt_vencimento_recb),
    competencia: dataISO(c.dt_competencia_recb),
    valor: cent(num(c.vl_emitido_recb)),
    status: String(c.fl_status_recb) === '0' ? 'pendente' : String(c.fl_status_recb) === '3' ? 'liquidada' : 'outro',
    cancelada: !!limpar(c.dt_cancelamento_recb),
    acordo,
    itens,
  };
}

// Executa tarefas com no máximo n ao mesmo tempo.
async function emParalelo(tarefas, n) {
  const out = new Array(tarefas.length);
  let i = 0;
  async function trab() { while (i < tarefas.length) { const k = i++; out[k] = await tarefas[k](); } }
  await Promise.all(Array.from({ length: Math.min(n, tarefas.length) }, trab));
  return out;
}

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Uma página; corpo que não é lista (estouro de memória vem como HTML com HTTP 200) é erro.
async function pagina(cliente, params) {
  // O cliente já repete erro de servidor e 429; aqui só repete o corpo que não é lista.
  for (let t = 0; t < 3; t++) {
    const j = await cliente.get('cobranca/index', params);
    if (Array.isArray(j)) return j;
    if (t === 2) { const e = new Error('superlogica_resposta_invalida'); e.status = 502; throw e; }
    await espera(2000);
  }
  return [];
}

// Todas as cobranças válidas com vencimento no mês, página a página.
async function puxarMes(cliente, idCondominio, comp) {
  const jan = janela(comp);
  const base = {
    idCondominio, status: 'validos', dtInicio: jan.dtInicio, dtFim: jan.dtFim,
    comDadosDasApropriacoes: 1, comDadosDasContasEReceitas: 1, comDadosDasUnidades: 1,
    itensPorPagina: POR_PAGINA,
  };
  const out = [];
  let cortado = false;
  for (let pg = 1; pg <= MAX_PAGINAS; pg++) {
    const j = await pagina(cliente, Object.assign({}, base, { pagina: pg }));
    j.forEach((c) => out.push(normalizar(c)));
    if (j.length < POR_PAGINA) break;
    if (pg === MAX_PAGINAS) cortado = true;
  }
  return { competencia: rotulo(comp), cobrancas: out, cortado };
}

// Junta as cobranças normais de um mês por unidade.
function porUnidade(cobrancas) {
  const m = new Map();
  cobrancas.forEach((c) => {
    if (c.cancelada || c.acordo || !c.unidade_id) return;
    if (!m.has(c.unidade_id)) m.set(c.unidade_id, { unidade: c.unidade, boletos: [], total: 0, itens: new Map() });
    const u = m.get(c.unidade_id);
    u.boletos.push(c);
    u.total = cent(u.total + c.valor);
    c.itens.forEach((i) => {
      const atual = u.itens.get(i.conta) || { conta: i.conta, descricao: i.descricao, tipo: i.tipo, valor: 0, complementos: [] };
      atual.valor = cent(atual.valor + i.valor);
      if (i.complemento) atual.complementos.push(i.complemento);
      u.itens.set(i.conta, atual);
    });
  });
  return m;
}

// Contas de um tipo presentes no mês e em quantas unidades (com valor diferente de zero).
function contasDoMes(mapa, tipo) {
  const out = new Map();
  mapa.forEach((u) => u.itens.forEach((i) => {
    if (i.tipo !== tipo || !i.valor) return;
    const a = out.get(i.conta) || { conta: i.conta, descricao: i.descricao, unidades: 0, valor: 0, complementos: [] };
    a.unidades++;
    a.valor = cent(a.valor + i.valor);
    a.complementos.push(...i.complementos);
    out.set(i.conta, a);
  }));
  return out;
}

// Itens que mais explicam a diferença entre o mês e o mês anterior da unidade.
function maioresDiferencas(atual, anterior, n) {
  const contas = new Set([...(atual ? atual.itens.keys() : []), ...(anterior ? anterior.itens.keys() : [])]);
  const difs = [];
  contas.forEach((k) => {
    const a = atual && atual.itens.get(k);
    const b = anterior && anterior.itens.get(k);
    const d = cent((a ? a.valor : 0) - (b ? b.valor : 0));
    if (Math.abs(d) >= 0.01) difs.push({ item: (a || b).descricao, antes: b ? b.valor : 0, agora: a ? a.valor : 0, diferenca: d });
  });
  return difs.sort((x, y) => Math.abs(y.diferenca) - Math.abs(x.diferenca)).slice(0, n);
}

const PESO = { alta: 0, media: 1, baixa: 2 };

// Análise pura: recebe os meses já puxados (o primeiro é a competência conferida).
function conferir(meses) {
  const [mesAtual, ...hist] = meses;
  const atual = porUnidade(mesAtual.cobrancas);
  const anteriores = hist.map((h) => porUnidade(h.cobrancas));
  const ultimo = anteriores[0] || new Map();
  const alertas = [];
  const add = (a) => alertas.push(a);

  const unidades = new Map();
  [atual, ...anteriores].forEach((m) => m.forEach((u, id) => { if (!unidades.has(id)) unidades.set(id, u.unidade); }));

  // Rateios e leituras no condomínio inteiro (comparando com o mês anterior).
  const extrasAgora = contasDoMes(atual, 'extra');
  const extrasAntes = contasDoMes(ultimo, 'extra');
  const leiturasAgora = contasDoMes(atual, 'leitura');
  const leiturasAntes = contasDoMes(ultimo, 'leitura');
  const nAtual = atual.size;
  const nUltimo = ultimo.size;
  const leituraGeralFaltando = new Set();
  const extraGeralSumiu = new Set();

  if (nAtual) {
    leiturasAntes.forEach((l, conta) => {
      if (l.unidades < PARTE_RELEVANTE * nUltimo) return;
      const agora = leiturasAgora.get(conta);
      if (!agora) {
        leituraGeralFaltando.add(conta);
        add({ tipo: 'leitura_faltando', gravidade: 'alta', unidade: 'Todas', unidade_id: '',
          titulo: l.descricao + ' não veio em nenhum boleto',
          detalhe: 'No mês anterior estava em ' + l.unidades + ' unidades (' + reais(l.valor) + '). Confira se a leitura foi lançada antes de enviar.',
          valor: 0, referencia: l.valor });
      }
    });
    extrasAntes.forEach((e, conta) => {
      if (e.unidades < PARTE_RELEVANTE * nUltimo || extrasAgora.has(conta)) return;
      extraGeralSumiu.add(conta);
      const p = e.complementos.map(parcela).filter(Boolean);
      const ultimaParcela = p.length && p.every((x) => x.n === x.de);
      add({ tipo: 'rateio_sumiu', gravidade: ultimaParcela ? 'baixa' : 'alta', unidade: 'Todas', unidade_id: '',
        titulo: e.descricao + ' não veio neste mês',
        detalhe: 'No mês anterior estava em ' + e.unidades + ' unidades (' + reais(e.valor) + ')' +
          (ultimaParcela ? ', e era a última parcela: provavelmente terminou.' : '. Confira se o rateio terminou ou se faltou lançar.'),
        valor: 0, referencia: e.valor });
    });
    extrasAgora.forEach((e, conta) => {
      if (extrasAntes.has(conta) || anteriores.some((m) => contasDoMes(m, 'extra').has(conta))) return;
      add({ tipo: 'rateio_apareceu', gravidade: e.unidades >= PARTE_RELEVANTE * nAtual ? 'media' : 'baixa', unidade: e.unidades >= PARTE_RELEVANTE * nAtual ? 'Todas' : e.unidades + ' unidades', unidade_id: '',
        titulo: e.descricao + ' é novo neste mês',
        detalhe: 'Entrou em ' + e.unidades + ' unidades (' + reais(e.valor) + ') e não estava nos ' + hist.length + ' meses anteriores. Confira se foi aprovado e se o valor bate.',
        valor: e.valor, referencia: 0 });
    });
  }

  unidades.forEach((nome, id) => {
    const u = atual.get(id);
    const passados = anteriores.map((m) => m.get(id)).filter(Boolean);
    const ant = ultimo.get(id) || passados[0];

    if (!u) {
      if (!passados.length || !nAtual) return;
      const todos = passados.length === anteriores.length;
      add({ tipo: 'sem_boleto', gravidade: todos ? 'alta' : 'media', unidade: nome, unidade_id: id,
        titulo: 'Sem boleto neste mês',
        detalhe: 'Teve boleto em ' + passados.length + ' dos ' + anteriores.length + ' meses anteriores (último ' + reais(passados[0].total) + ').',
        valor: 0, referencia: passados[0].total });
      return;
    }

    if (u.boletos.length > 1) {
      const comBase = u.boletos.filter((b) => b.itens.some((i) => i.tipo === 'base'));
      add({ tipo: 'boleto_em_dobro', gravidade: comBase.length > 1 ? 'alta' : 'media', unidade: nome, unidade_id: id,
        titulo: u.boletos.length + ' boletos no mesmo mês',
        detalhe: u.boletos.map((b) => 'nº ' + b.id + ' de ' + reais(b.valor) + ' vence ' + b.vencimento.split('-').reverse().join('/')).join('; ') +
          (comBase.length > 1 ? '. Mais de um traz a taxa do condomínio.' : '. Pode ser cobrança avulsa; confira.'),
        valor: u.total, referencia: 0, boletos: u.boletos.map((b) => b.id) });
    }

    if (passados.length) {
      const media = cent(passados.reduce((s, p) => s + p.total, 0) / passados.length);
      if (media > 0 && (u.total > FATOR_ALTO * media || u.total < FATOR_BAIXO * media)) {
        const alto = u.total > media;
        const difs = maioresDiferencas(u, ant, 3);
        add({ tipo: 'valor_fora_padrao', gravidade: 'alta', unidade: nome, unidade_id: id,
          titulo: (alto ? 'Valor acima' : 'Valor abaixo') + ' do padrão da unidade',
          detalhe: reais(u.total) + ' contra média de ' + reais(media) + ' nos ' + passados.length + ' meses anteriores (' +
            (u.total / media).toFixed(2).replace('.', ',') + ' vez).' +
            (difs.length ? ' Maiores diferenças: ' + difs.map((d) => d.item + ' ' + reais(d.antes) + ' para ' + reais(d.agora)).join('; ') + '.' : ''),
          valor: u.total, referencia: media, diferencas: difs });
      }
    }

    // Leitura por unidade (quando o condomínio inteiro não está sem a leitura).
    if (ant) {
      ant.itens.forEach((i, conta) => {
        if (i.tipo !== 'leitura' || !(i.valor > 0) || leituraGeralFaltando.has(conta)) return;
        const agora = u.itens.get(conta);
        if (!agora) {
          const pequeno = i.valor < LEITURA_PEQUENA;
          add({ tipo: 'leitura_faltando', gravidade: pequeno ? 'media' : 'alta', unidade: nome, unidade_id: id,
            titulo: i.descricao + ' faltando',
            detalhe: 'No mês anterior veio ' + reais(i.valor) + '; neste mês o item não está no boleto.' +
              (pequeno ? ' O consumo era pequeno: pode ter sido zero neste mês; confira a leitura.' : ' Confira se a leitura foi lançada.'),
            valor: 0, referencia: i.valor });
        } else if (!(agora.valor > 0)) {
          add({ tipo: 'leitura_zerada', gravidade: 'media', unidade: nome, unidade_id: id,
            titulo: i.descricao + ' zerada',
            detalhe: 'No mês anterior veio ' + reais(i.valor) + '; neste mês veio ' + reais(agora.valor) + '. Confira a leitura.',
            valor: agora.valor, referencia: i.valor });
        }
      });
      // Rateio extra por unidade: a maioria tem e esta unidade tinha no mês anterior e não tem agora.
      ant.itens.forEach((i, conta) => {
        if (i.tipo !== 'extra' || !(i.valor > 0) || extraGeralSumiu.has(conta)) return;
        const geral = extrasAgora.get(conta);
        if (!geral || u.itens.has(conta)) return;
        add({ tipo: 'rateio_sumiu', gravidade: 'media', unidade: nome, unidade_id: id,
          titulo: i.descricao + ' não veio para esta unidade',
          detalhe: 'No mês anterior veio ' + reais(i.valor) + ' e neste mês está em ' + geral.unidades + ' outras unidades.',
          valor: 0, referencia: i.valor });
      });
      // Parcela repetida do rateio.
      u.itens.forEach((i, conta) => {
        if (i.tipo !== 'extra') return;
        const b = ant.itens.get(conta);
        if (!b) return;
        const pa = i.complementos.map(parcela).filter(Boolean)[0];
        const pb = b.complementos.map(parcela).filter(Boolean)[0];
        if (pa && pb && pa.n === pb.n && pa.de === pb.de) {
          add({ tipo: 'parcela_repetida', gravidade: 'media', unidade: nome, unidade_id: id,
            titulo: i.descricao + ' com a mesma parcela do mês anterior',
            detalhe: 'Parcela ' + pa.n + '/' + pa.de + ' nos dois meses.',
            valor: i.valor, referencia: b.valor });
        }
      });
    }
  });

  alertas.sort((a, b) => (PESO[a.gravidade] - PESO[b.gravidade]) || (a.unidade === 'Todas' ? -1 : b.unidade === 'Todas' ? 1 : 0) ||
    String(a.unidade).localeCompare(String(b.unidade), 'pt-BR', { numeric: true }) || a.tipo.localeCompare(b.tipo));

  const normais = mesAtual.cobrancas.filter((c) => !c.cancelada && !c.acordo);
  const porTipo = {};
  alertas.forEach((a) => { porTipo[a.tipo] = (porTipo[a.tipo] || 0) + 1; });
  return {
    competencia: mesAtual.competencia,
    meses_comparados: hist.map((h) => h.competencia),
    resumo: {
      boletos: normais.length,
      unidades_com_boleto: nAtual,
      pendentes: normais.filter((c) => c.status === 'pendente').length,
      liquidados: normais.filter((c) => c.status === 'liquidada').length,
      acordos_fora: mesAtual.cobrancas.filter((c) => c.acordo && !c.cancelada).length,
      valor_total: cent(normais.reduce((s, c) => s + c.valor, 0)),
      unidades_meses_anteriores: hist.map((h, k) => ({ competencia: h.competencia, unidades: anteriores[k].size })),
      alertas: alertas.length,
      alertas_por_tipo: porTipo,
    },
    avisos: meses.filter((m) => m.cortado).map((m) => 'O mês ' + m.competencia + ' tem mais de ' + (MAX_PAGINAS * POR_PAGINA) + ' cobranças; a leitura foi cortada.'),
    alertas,
  };
}

// Puxa a competência e os 3 meses anteriores e confere.
async function conferirBoletos(cliente, idCondominio, competencia) {
  const comp = competenciaValida(competencia);
  if (!comp) { const e = new Error('competencia_invalida'); e.status = 400; throw e; }
  const lista = [comp, ...mesesAnteriores(comp, MESES_HISTORICO)];
  const meses = await emParalelo(lista.map((c) => () => puxarMes(cliente, idCondominio, c)), SIMULTANEAS);
  const r = conferir(meses);
  r.condominio = String(idCondominio);
  r.gerado_em = new Date().toISOString();
  if (!r.resumo.boletos) r.avisos.push('Nenhum boleto com vencimento em ' + r.competencia + ' encontrado. Se os boletos ainda não foram gerados, gere antes de conferir.');
  return r;
}

// Cadastros de empresas que não são condomínios (fora de toda análise do financeiro).
const NAO_CONDOMINIOS = new Set(['143', '144', '145', '160', '162']);

module.exports = { NAO_CONDOMINIOS, conferirBoletos, conferir, normalizar, tipoItem, parcela, competenciaValida, mesesAnteriores, janela, porUnidade };
