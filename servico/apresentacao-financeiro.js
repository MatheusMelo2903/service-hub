// ─────────────────────────────────────────────────────────────────────────
// Apresentação de assembleia: item de prestação de contas com os números do Superlógica
// (23/10/2026). No teste real da AGE da Fazenda Barão do Império o item 1 (prestação de
// contas) saiu só com o divisor: os números estavam numa imagem EMF e num print.
// Quando a pauta tem item de prestação de contas e o condomínio é da base:
//   1. tira o período do texto do item ("julho a setembro de 2026" vira 2026-07 a 2026-09);
//      sem período no texto, usa os 3 meses fechados antes da data da assembleia e avisa;
//   2. puxa os dados pelo mesmo caminho da prestação de contas (puxarDadosPrestacao) e pede
//      ao motor o resumo pronto (POST /v13/apresentacao/financeiro, que usa montar_dados e
//      justificativas.analisar: conferências, sinais de déficit e textos padrão);
//   3. monta em código, sem IA, os slides do item: painel (resultado do período), gráfico
//      de colunas (receitas e despesas mês a mês), barras (de onde veio a arrecadação e para
//      onde foi o dinheiro) e tabela (as duas maiores categorias). A explicação de número
//      negativo vai no "sub" do cartão ou na "nota" do mesmo slide (até 160 caracteres);
//   4. o planejamento recebe a instrução de não criar slides financeiros a partir de prints
//      nesse item (só análise da diretoria rotulada como tal) e os slides entram logo depois
//      do divisor. Slide de números que o planejamento criar mesmo assim no item sai.
// Superlógica fora do ar, condomínio sem código ou sem permissão: segue o fluxo de antes e avisa.
// ─────────────────────────────────────────────────────────────────────────

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const NOTA_MAX = 160;
const TIMEOUT_MOTOR_MS = 120000;
const TIPOS_FINANCEIROS = new Set(['painel', 'grafico_colunas', 'barras', 'tabela', 'numeros', 'comparativo']);
const RE_PRESTACAO = /presta[çc][ãa]o\s+de\s+contas|demonstrativo|contas\s+d[oa]s?\s+(per[íi]odo|exerc[íi]cio|gest[ãa]o|trimestre|semestre|m[êe]s)|balancete|aprova[çc][ãa]o\s+das\s+contas|an[áa]lise\s+das\s+contas/i;

const sem = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const MES_TXT = '(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)';
const NOMES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesNum = (s) => NOMES_CURTOS.indexOf(sem(s).slice(0, 3)) + 1;
const chave = (y, m) => y + '-' + String(m).padStart(2, '0');
const ano = (s) => { const n = Number(s); return n < 100 ? 2000 + n : n; };
function somarMeses(y, m, d) { const t = y * 12 + (m - 1) + d; return [Math.floor(t / 12), (t % 12) + 1]; }
function mesesEntre(a, b) { const [ya, ma] = a.split('-').map(Number); const [yb, mb] = b.split('-').map(Number); return (yb - ya) * 12 + (mb - ma) + 1; }

// Primeiro item da pauta que é prestação de contas: { numero, texto } ou null.
function itemPrestacao(pauta) {
  const i = (Array.isArray(pauta) ? pauta : []).findIndex((t) => RE_PRESTACAO.test(String(t || '')));
  return i >= 0 ? { numero: i + 1, texto: String(pauta[i]) } : null;
}

// Período escrito no item: { inicio:'AAAA-MM', fim:'AAAA-MM' } ou null.
function periodoDoTexto(texto) {
  const t = sem(texto).replace(/\s+/g, ' ');
  const SEP = '\\s*(?:a|ate|ao|e|-|–)\\s*(?:o mes de\\s*)?';
  let m;
  const ok = (ini, fim) => (ini <= fim && mesesEntre(ini, fim) <= 24 ? { inicio: ini, fim } : null);
  // 01/07/2026 a 30/09/2026
  if ((m = t.match(new RegExp('(\\d{1,2})/(\\d{1,2})/(\\d{4})' + SEP + '(\\d{1,2})/(\\d{1,2})/(\\d{4})')))) return ok(chave(m[3], m[2]), chave(m[6], m[5]));
  // 07/2026 a 09/2026
  if ((m = t.match(new RegExp('\\b(\\d{1,2})/(\\d{4})' + SEP + '(\\d{1,2})/(\\d{4})')))) return ok(chave(m[2], m[1]), chave(m[4], m[3]));
  // julho, agosto e setembro de 2026
  if ((m = t.match(new RegExp('\\b(' + MES_TXT + '(?:\\s*,\\s*' + MES_TXT + ')*)\\s*,?\\s*e\\s*' + MES_TXT + '\\s*(?:de|/)\\s*(\\d{4})')))) {
    const primeiro = mesNum(m[1].split(/\s*,\s*/)[0]); const ultimo = mesNum(m[m.length - 2]); const y = ano(m[m.length - 1]);
    return ok(chave(primeiro > ultimo ? y - 1 : y, primeiro), chave(y, ultimo));
  }
  // julho a setembro de 2026 / novembro de 2025 a janeiro de 2026 / jul/26 a set/26
  if ((m = t.match(new RegExp('\\b' + MES_TXT + '\\b(?:\\s*(?:de|/)\\s*(\\d{4}|\\d{2}))?' + SEP + MES_TXT + '\\b\\s*(?:de|/)\\s*(\\d{4}|\\d{2})\\b')))) {
    const m1 = mesNum(m[1]); const m2 = mesNum(m[3]); const y2 = ano(m[4]);
    const y1 = m[2] ? ano(m[2]) : (m1 > m2 ? y2 - 1 : y2);
    return ok(chave(y1, m1), chave(y2, m2));
  }
  // 1º trimestre de 2026 / 2º semestre de 2025
  if ((m = t.match(/\b([1-4])\s*[ºo°]?\s*trimestre\s*(?:de|\/)?\s*(\d{4})/))) { const a = (Number(m[1]) - 1) * 3 + 1; return ok(chave(m[2], a), chave(m[2], a + 2)); }
  if ((m = t.match(/\b([12])\s*[ºo°]?\s*semestre\s*(?:de|\/)?\s*(\d{4})/))) { const a = m[1] === '1' ? 1 : 7; return ok(chave(m[2], a), chave(m[2], a + 5)); }
  // exercício de 2025 / ano de 2025
  if ((m = t.match(/\b(?:exercicio|ano)\s*(?:de|base)?\s*(\d{4})\b/))) return ok(chave(m[1], 1), chave(m[1], 12));
  // um mês só: setembro de 2026
  if ((m = t.match(new RegExp('\\b' + MES_TXT + '\\s*(?:de|/)\\s*(\\d{4})\\b')))) return ok(chave(m[2], mesNum(m[1])), chave(m[2], mesNum(m[1])));
  return null;
}

// Data da assembleia escrita no edital ("dia 16/10/2026", "dia 16 de outubro de 2026"): [ano, mês] ou null.
function dataAssembleia(edital) {
  const t = sem(edital).replace(/\s+/g, ' ');
  const a = t.match(/\b(?:dia|em|data)\s*:?\s*(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b/);
  const b = t.match(new RegExp('\\bdia\\s*(\\d{1,2})\\s*[ºo°]?\\s*de\\s*' + MES_TXT + '\\s*(?:de\\s*)?(\\d{4})'));
  const cands = [];
  if (a && Number(a[2]) >= 1 && Number(a[2]) <= 12) cands.push({ i: a.index, v: [ano(a[3]), Number(a[2])] });
  if (b) cands.push({ i: b.index, v: [Number(b[3]), mesNum(b[2])] });
  cands.sort((x, y) => x.i - y.i);
  return cands.length ? cands[0].v : null;
}

function rotuloPeriodo(ini, fim) {
  const [y0, m0] = ini.split('-').map(Number); const [y1, m1] = fim.split('-').map(Number);
  if (ini === fim) return MESES[m0 - 1] + ' de ' + y0;
  return y0 === y1 ? MESES[m0 - 1] + ' a ' + MESES[m1 - 1] + ' de ' + y1 : MESES[m0 - 1] + ' de ' + y0 + ' a ' + MESES[m1 - 1] + ' de ' + y1;
}

// Período do item, ou os 3 meses fechados antes da assembleia. Nunca passa do último mês
// fechado (o saldo de mês aberto ainda muda). Devolve { inicio, fim, avisos } ou { erro }.
function decidirPeriodo(item, edital, hoje) {
  const avisos = [];
  const fechado = somarMeses(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, -1);
  const ultimoFechado = chave(fechado[0], fechado[1]);
  let p = periodoDoTexto(item.texto);
  if (!p) {
    const d = dataAssembleia(edital) || [hoje.getUTCFullYear(), hoje.getUTCMonth() + 1];
    const f = somarMeses(d[0], d[1], -1); const i = somarMeses(d[0], d[1], -3);
    p = { inicio: chave(i[0], i[1]), fim: chave(f[0], f[1]) };
    avisos.push('O item ' + item.numero + ' da pauta não diz o período da prestação de contas; usei ' + rotuloPeriodo(p.inicio, p.fim) + ' (os 3 meses fechados antes da assembleia). Confira.');
  }
  if (p.inicio > ultimoFechado) return { erro: 'O período da prestação de contas (' + rotuloPeriodo(p.inicio, p.fim) + ') ainda não fechou; os números não foram puxados do sistema.' };
  if (p.fim > ultimoFechado) {
    avisos.push('O mês de ' + rotuloPeriodo(p.fim, p.fim) + ' ainda não fechou; os números da prestação de contas vão até ' + rotuloPeriodo(ultimoFechado, ultimoFechado) + '.');
    p.fim = ultimoFechado;
  }
  return { inicio: p.inicio, fim: p.fim, avisos };
}

// ── Formatação (centavos inteiros: os valores fecham no centavo) ──
const cent = (v) => Math.round(Number(v || 0) * 100);
function reaisC(c) {
  const abs = Math.abs(c);
  const txt = 'R$ ' + Math.floor(abs / 100).toLocaleString('pt-BR') + ',' + String(abs % 100).padStart(2, '0');
  return c < 0 ? '(' + txt + ')' : txt;
}
const reais = (v) => reaisC(cent(v));
const pct = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
// Frase de até 160 caracteres, cortada no fim de frase ou de palavra.
function curta(s, max) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  max = max || NOTA_MAX;
  if (s.length <= max) return s;
  const corte = s.slice(0, max);
  const ponto = corte.lastIndexOf('. ');
  if (ponto > 40) return corte.slice(0, ponto + 1);
  return corte.slice(0, corte.lastIndexOf(' ')).replace(/[,;:]$/, '') + '.';
}
const primeiraFrase = (s) => { const m = String(s || '').match(/^.*?\.(\s|$)/); return m ? m[0].trim() : String(s || ''); };
// Até 10 itens: os 9 maiores e "demais" com a soma do resto.
function top(lista, rotuloResto) {
  const ord = lista.slice().sort((a, b) => b.c - a.c);
  if (ord.length <= 10) return ord;
  const resto = ord.slice(9).reduce((s, x) => s + x.c, 0);
  return ord.slice(0, 9).concat([{ nome: rotuloResto, c: resto }]);
}
function dataFimMes(chaveMes) { const [y, m] = chaveMes.split('-').map(Number); return String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y; }

// Os slides do item, a partir do resumo do motor. Confere antes que os números fecham.
function montarSlides(resumo, numero) {
  const meses = resumo.meses || [];
  const ini = cent(resumo.saldo_inicial); const fim = cent(resumo.saldo_final);
  const rec = meses.reduce((s, m) => s + cent(m.receitas), 0); const desp = meses.reduce((s, m) => s + cent(m.despesas), 0);
  if (!meses.length || ini + rec - desp !== fim) throw new Error('numeros_nao_fecham');
  const res = rec - desp;
  const textos = resumo.textos || {};
  const periodo = resumo.rotulo_periodo || rotuloPeriodo(resumo.periodo[0], resumo.periodo[resumo.periodo.length - 1]);
  const Periodo = periodo.charAt(0).toUpperCase() + periodo.slice(1);
  const primeiro = resumo.periodo[0].split('-');
  const slides = [];

  // 1. Painel: resultado do período.
  const explicaRes = res < 0 ? curta(textos.resumo && textos.resumo.length <= NOTA_MAX ? textos.resumo : primeiraFrase(textos.resumo) || textos.caixa || 'As despesas do período superaram a arrecadação.') : 'receitas menos despesas';
  const variacao = ini > 0 && Math.abs((fim - ini) / ini) <= 3
    ? ((fim >= ini ? 'alta de ' : 'queda de ') + pct(Math.abs((fim - ini) / ini) * 100))
    : (reaisC(Math.abs(fim - ini)) + (fim >= ini ? ' a mais' : ' a menos'));
  const faixa = [
    { rotulo: 'Variação do caixa', valor: variacao },
    { rotulo: 'Despesa média por mês', valor: reaisC(Math.round(desp / meses.length)) },
  ];
  if (desp > 0) faixa.push({ rotulo: 'Arrecadação sobre despesas', valor: Math.round((rec / desp) * 100) + '%' });
  slides.push({
    tipo: 'painel', numero, titulo: 'Resultado do período', subtitulo: Periodo + ', conforme o sistema da administradora',
    cards: [
      { rotulo: 'Saldo inicial', valor: reaisC(ini), sub: 'em 01/' + primeiro[1] + '/' + primeiro[0] },
      { rotulo: 'Receitas', valor: reaisC(rec), sub: 'arrecadado no período' },
      { rotulo: 'Despesas', valor: reaisC(desp), sub: 'pago no período' },
      { rotulo: 'Resultado', valor: reaisC(res), sub: explicaRes, cor: res < 0 ? 'vermelho' : 'verde' },
      Object.assign({ rotulo: 'Saldo final', valor: reaisC(fim), sub: 'em ' + dataFimMes(resumo.periodo[resumo.periodo.length - 1]) },
        fim < 0 ? { cor: 'vermelho', sub: curta('em ' + dataFimMes(resumo.periodo[resumo.periodo.length - 1]) + '. ' + (textos.caixa || 'Caixa negativo no fim do período.')) } : {}),
    ],
    faixa,
  });

  // 2. Colunas: receitas e despesas mês a mês; negativos com a explicação no cartão.
  const negativos = meses.filter((m) => cent(m.resultado) < 0);
  let cards;
  if (negativos.length) {
    const mostrar = negativos.slice().sort((a, b) => cent(a.resultado) - cent(b.resultado)).slice(0, 3)
      .sort((a, b) => meses.indexOf(a) - meses.indexOf(b));
    cards = mostrar.map((m) => ({ rotulo: 'Resultado de ' + m.rotulo, valor: reaisC(cent(m.resultado)), sub: curta(m.explicacao || 'Despesas do mês acima da arrecadação.') }));
    cards.push({ rotulo: 'Saldo no fim do período', valor: reaisC(fim) });
  } else if (meses.length <= 4) {
    cards = meses.map((m) => ({ rotulo: 'Resultado de ' + m.rotulo, valor: reaisC(cent(m.resultado)), sub: 'saldo no fim do mês: ' + reais(m.saldo_fim) }));
  } else {
    cards = [
      { rotulo: 'Receita média por mês', valor: reaisC(Math.round(rec / meses.length)) },
      { rotulo: 'Despesa média por mês', valor: reaisC(Math.round(desp / meses.length)) },
      { rotulo: 'Saldo no fim do período', valor: reaisC(fim) },
    ];
  }
  const colunas = {
    tipo: 'grafico_colunas', numero, titulo: 'Receitas e despesas por mês', subtitulo: Periodo,
    categorias: meses.map((m) => m.rotulo),
    series: [{ nome: 'Receitas', valores: meses.map((m) => cent(m.receitas) / 100) }, { nome: 'Despesas', valores: meses.map((m) => cent(m.despesas) / 100) }],
    cards,
  };
  const naoMostrados = negativos.filter((m) => !cards.some((c) => c.rotulo === 'Resultado de ' + m.rotulo));
  if (naoMostrados.length) colunas.nota = curta('Também fecharam negativos: ' + naoMostrados.map((m) => m.rotulo + ' ' + reaisC(cent(m.resultado))).join(', ') + '.');
  slides.push(colunas);

  // 3. Barras: de onde veio a arrecadação.
  const arrec = top((resumo.arrecadacao || []).map((r) => ({ nome: r.nome, c: cent(r.total) })), 'Demais receitas');
  const notasRec = [];
  if (resumo.sinais && Array.isArray(resumo.sinais.quedas_arrecadacao) && resumo.sinais.quedas_arrecadacao.length) {
    notasRec.push('Arrecadação abaixo da média em ' + resumo.sinais.quedas_arrecadacao.slice(0, 3).join(', ') + '.');
  }
  if (arrec.some((x) => x.c < 0)) notasRec.push('Valor entre parênteses é negativo no período (estorno ou ajuste lançado no sistema).');
  notasRec.push('Total arrecadado: ' + reaisC(rec) + '.');
  slides.push(Object.assign({
    tipo: 'barras', numero, titulo: 'De onde veio a arrecadação', subtitulo: 'Receitas por rubrica, ' + periodo,
    itens: arrec.map((x) => ({ nome: x.nome, valor: x.c / 100 })), mostrar_percentual: true,
  }, { nota: curta(notasRec.join(' ')) }));

  // 4. Barras: para onde foi o dinheiro (categorias).
  const cats = resumo.categorias || [];
  const desps = top(cats.map((c) => ({ nome: c.nome, c: cent(c.total) })), 'Demais categorias');
  const foraRotina = [];
  cats.forEach((c) => (c.rubricas || []).forEach((r) => { if (r.explicacao) foraRotina.push({ c: cent(r.total), txt: r.nome + ': ' + r.explicacao.charAt(0).toLowerCase() + r.explicacao.slice(1) }); }));
  foraRotina.sort((a, b) => b.c - a.c);
  const notaDesp = foraRotina.length ? foraRotina.slice(0, 2).map((x) => x.txt.replace(/\.$/, '')).join('; ') + '.' : 'Total pago: ' + reaisC(desp) + '.';
  slides.push({
    tipo: 'barras', numero, titulo: 'Para onde foi o dinheiro', subtitulo: 'Despesas por categoria, ' + periodo,
    itens: desps.map((x) => ({ nome: x.nome, valor: x.c / 100 })), mostrar_percentual: true, nota: curta(notaDesp),
  });

  // 5. Tabelas: as duas maiores categorias, rubrica por rubrica (até 15 linhas).
  const porMes = meses.length <= 3;
  cats.slice().sort((a, b) => cent(b.total) - cent(a.total)).slice(0, 2).forEach((c) => {
    let rubs = (c.rubricas || []).map((r) => ({ nome: r.nome, c: cent(r.total), serie: (r.serie || []).map(cent), explicacao: r.explicacao }))
      .sort((a, b) => b.c - a.c);
    if (rubs.length > 15) {
      const resto = rubs.slice(14);
      rubs = rubs.slice(0, 14).concat([{ nome: 'Demais rubricas', c: resto.reduce((s, r) => s + r.c, 0), serie: meses.map((_, i) => resto.reduce((s, r) => s + (r.serie[i] || 0), 0)) }]);
    }
    const totalC = cent(c.total);
    const linhas = rubs.map((r) => (porMes ? [r.nome].concat(meses.map((_, i) => reaisC(r.serie[i] || 0)), [reaisC(r.c)])
      : [r.nome, reaisC(r.c), totalC ? Math.round((r.c / totalC) * 100) + '%' : '']));
    const totalLinha = porMes ? ['Total'].concat(meses.map((_, i) => reaisC(rubs.reduce((s, r) => s + (r.serie[i] || 0), 0))), [reaisC(totalC)]) : ['Total', reaisC(totalC), '100%'];
    const obs = rubs.filter((r) => r.explicacao).slice(0, 2).map((r) => r.nome + ': ' + r.explicacao.charAt(0).toLowerCase() + r.explicacao.slice(1).replace(/\.$/, ''));
    const neg = rubs.some((r) => r.c < 0);
    const tab = {
      tipo: 'tabela', numero, titulo: curta(c.nome, 45), subtitulo: reaisC(totalC) + ' no período, ' + (desp ? Math.round((totalC / desp) * 100) : 0) + '% das despesas',
      colunas: porMes ? ['Rubrica'].concat(meses.map((m) => m.rotulo), ['Total']) : ['Rubrica', 'Total', '% da categoria'],
      linhas, total: totalLinha,
    };
    const obsTxt = (obs.length ? obs.join('; ') + '.' : '') + (neg ? ' Valor entre parênteses é negativo no período.' : '');
    if (obsTxt.trim()) tab.observacao = curta(obsTxt.trim());
    slides.push(tab);
  });
  return slides;
}

// Instrução para o planejamento (chamada principal) quando os números vêm do sistema.
function instrucao(numero, resumo) {
  return 'PRESTAÇÃO DE CONTAS (ITEM ' + numero + ' DA PAUTA): os números de ' + resumo.rotulo_periodo + ' vêm do sistema da administradora e os slides financeiros deste item '
    + '(resultado do período, receitas e despesas por mês, arrecadação, despesas por categoria e as maiores categorias) já são montados automaticamente logo depois do divisor. '
    + 'No item ' + numero + ' NÃO crie slides de números (numeros, tabela, barras, comparativo) a partir de prints, imagens ou documentos, nem repita esses números. '
    + 'Ponha o divisor do item; se o material trouxer uma análise da diretoria ou do conselho, ela pode entrar em slide de texto ou tópicos com título começando por "Análise da diretoria", e a divergência com o sistema vai em avisos. '
    + 'Números do sistema só para referência: saldo inicial ' + reais(resumo.saldo_inicial) + ', receitas ' + reais(resumo.receitas) + ', despesas ' + reais(resumo.despesas) + ', saldo final ' + reais(resumo.saldo_final) + '.';
}

// Encaixa os slides logo depois do divisor do item e tira os slides de números que o
// planejamento tenha feito no item (menos a análise da diretoria). Devolve o roteiro novo.
function encaixar(roteiro, fin, avisos) {
  const n = fin.numero;
  const ehDiretoria = (s) => /diretoria|conselho/i.test(String(s.titulo || '') + ' ' + String(s.subtitulo || ''));
  let tirados = 0;
  const slides = roteiro.slides.filter((s) => {
    if (Number(s.numero) === n && TIPOS_FINANCEIROS.has(s.tipo) && !ehDiretoria(s)) { tirados++; return false; }
    return true;
  });
  if (tirados) avisos.push('No item ' + n + ' (prestação de contas), ' + tirados + ' slide(s) de números montados a partir do material enviado foram trocados pelos números do sistema.');
  let pos = slides.findIndex((s) => s.tipo === 'item' && Number(s.numero) === n);
  if (pos >= 0) pos += 1;
  else {
    // Sem divisor: entra antes do primeiro slide de item seguinte (ou do encerramento).
    pos = slides.findIndex((s) => (Number(s.numero) > n && s.tipo !== 'pauta') || s.tipo === 'encerramento');
    if (pos < 0) pos = slides.length;
    const tituloItem = fin.titulo || 'Prestação de contas';
    slides.splice(pos, 0, { tipo: 'item', numero: n, titulo: tituloItem });
    pos += 1;
  }
  slides.splice(pos, 0, ...fin.slides.map((s) => Object.assign({}, s)));
  return Object.assign({}, roteiro, { slides });
}

// Conferência dos tipos novos em validarRoteiro (servico/apresentacao.js). Devolve
// { slide } (ajustado), { slide, aviso } ou { fora: aviso } quando não dá para aproveitar.
function conferirSlide(s) {
  const nome = '"' + (s.titulo || s.tipo) + '"';
  if (s.tipo === 'painel') {
    const cards = (Array.isArray(s.cards) ? s.cards : []).filter((c) => c && typeof c === 'object' && c.rotulo != null && c.valor != null);
    if (cards.length < 2) return { fora: 'O painel ' + nome + ' veio sem cartões válidos e saiu da apresentação.' };
    const out = Object.assign({}, s, { cards: cards.slice(0, 6).map((c) => (c.cor && !['verde', 'vermelho'].includes(c.cor) ? Object.assign({}, c, { cor: undefined }) : c)) });
    if (Array.isArray(s.faixa)) out.faixa = s.faixa.filter((f) => f && f.rotulo != null && f.valor != null).slice(0, 3);
    else delete out.faixa;
    return { slide: out, aviso: cards.length > 6 ? 'O painel ' + nome + ' tinha mais de 6 cartões; ficaram os 6 primeiros.' : null };
  }
  if (s.tipo === 'grafico_colunas') {
    const cats = Array.isArray(s.categorias) ? s.categorias.map((c) => String(c == null ? '' : c)) : [];
    const series = (Array.isArray(s.series) ? s.series : []).filter((x) => x && Array.isArray(x.valores))
      .map((x) => ({ nome: String(x.nome || 'Série'), valores: x.valores.map(numeroDe) }));
    const boas = cats.length && series.length && series.every((x) => x.valores.length === cats.length && x.valores.every((v) => isFinite(v)));
    if (!boas) {
      if (!cats.length || !series.length) return { fora: 'O gráfico ' + nome + ' veio sem dados e saiu da apresentação.' };
      return {
        slide: { tipo: 'tabela', numero: s.numero, titulo: s.titulo || 'Valores por período', colunas: ['Período'].concat(series.map((x) => x.nome)),
          linhas: cats.map((c, i) => [c].concat(series.map((x) => (isFinite(x.valores[i]) ? reais(x.valores[i]) : '[conferir]')))) },
        aviso: 'O gráfico ' + nome + ' tinha valores inválidos e virou tabela; confira os valores.',
      };
    }
    const out = Object.assign({}, s, { categorias: cats, series });
    if (Array.isArray(s.cards)) out.cards = s.cards.filter((c) => c && c.rotulo != null && c.valor != null).slice(0, 4);
    return { slide: out };
  }
  return { slide: s };
}

// Passo completo, chamado em paralelo com a triagem das imagens. Nunca lança erro: falha
// vira aviso e o item segue com o material enviado.
// deps: { motor:{url,segredo}, puxar:(params)->bruto|null, podeUsarSuperlogica?:(userId)->bool }
async function prepararFinanceiro(args) {
  try { return await prepararFinanceiroSemProtecao(args); } catch (e) {
    console.warn('[apresentacao] financeiro: ' + (e && e.message));
    return { avisos: ['Não foi possível puxar os números da prestação de contas agora; o item seguiu com o material enviado.'] };
  }
}
async function prepararFinanceiroSemProtecao({ dados, ctx, deps, agora }) {
  const item = itemPrestacao(dados.pauta);
  if (!item) {
    if (!(dados.pauta || []).length && RE_PRESTACAO.test(dados.edital || '')) {
      return { avisos: ['O edital fala de prestação de contas, mas não achei a lista numerada da pauta; os números não foram puxados do sistema.'] };
    }
    return { avisos: [] };
  }
  const seguir = (motivo) => ({ avisos: [motivo + ' O item ' + item.numero + ' (prestação de contas) seguiu com o material enviado.'] });
  if (!ctx.cond || !ctx.cond.id) return seguir('Escolha o condomínio no topo para os números da prestação de contas virem do sistema.');
  if (!deps.puxar) return seguir('Os números do sistema não estão disponíveis neste ambiente.');
  if (!ctx.interno && deps.podeUsarSuperlogica) {
    let pode = false;
    try { pode = !!(await deps.podeUsarSuperlogica(ctx.usuario)); } catch (e) { pode = false; }
    if (!pode) return seguir('Seu usuário não tem acesso aos dados do Superlógica.');
  }
  const per = decidirPeriodo(item, dados.edital, new Date((agora || Date.now()) - 3 * 3600 * 1000));
  if (per.erro) return seguir(per.erro);
  let bruto;
  try {
    bruto = await deps.puxar({ idCondominio: ctx.cond.id, inicio: per.inicio, fim: per.fim, nome: ctx.cond.nome || '', fantasia: ctx.cond.nome || '' });
  } catch (e) {
    console.warn('[apresentacao] superlogica falhou: ' + (e && e.message));
    return seguir('O Superlógica não respondeu ao puxar os números da prestação de contas.');
  }
  let resumo = null; let detalhe = null;
  try {
    const r = await fetch(new URL('/v13/apresentacao/financeiro', deps.motor.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': deps.motor.segredo },
      body: JSON.stringify(bruto), signal: AbortSignal.timeout(TIMEOUT_MOTOR_MS),
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && Array.isArray(j.meses)) resumo = j;
    else {
      detalhe = j && j.detail && typeof j.detail.detalhe === 'string' && j.detail.detalhe.length <= 300 ? j.detail.detalhe : null;
      console.warn('[apresentacao] resumo financeiro status ' + r.status);
    }
  } catch (e) {
    console.warn('[apresentacao] resumo financeiro falhou: ' + (e && e.message));
  }
  if (!resumo) return seguir(detalhe ? 'Os números do sistema não fecharam (' + detalhe.replace(/\.$/, '') + ').' : 'Não foi possível conferir os números da prestação de contas agora.');
  let slides;
  try { slides = montarSlides(resumo, item.numero); } catch (e) { return seguir('Os números do sistema não fecharam no centavo.'); }
  return { numero: item.numero, titulo: item.texto, slides, instrucao: instrucao(item.numero, resumo), avisos: per.avisos, periodo: { inicio: per.inicio, fim: per.fim } };
}

// Modo acrescentar: a pauta vem do slide de pauta da apresentação pronta e a data da capa.
// Só puxa os números quando o item de prestação ainda não tem slide de números (o caso do
// item que saiu só com o divisor); se já tem, a apresentação fica como está.
async function prepararFinanceiroAtualizar({ antiga, dados, ctx, deps, agora }) {
  const slides = (antiga && Array.isArray(antiga.slides)) ? antiga.slides : [];
  const sPauta = slides.find((s) => s && s.tipo === 'pauta');
  const pauta = (sPauta && Array.isArray(sPauta.itens) ? sPauta.itens : []).map((it) => (typeof it === 'string' ? it : (it && it.titulo) || ''));
  const item = itemPrestacao(pauta);
  if (!item) return { avisos: [] };
  if (slides.some((s) => s && Number(s.numero) === item.numero && TIPOS_FINANCEIROS.has(s.tipo) && !/diretoria|conselho/i.test(String(s.titulo || '')))) return { avisos: [] };
  const capa = slides.find((s) => s && s.tipo === 'capa');
  const edital = capa && typeof capa.data === 'string' ? 'dia ' + capa.data : '';
  const r = await prepararFinanceiro({ dados: { pauta, edital }, ctx, deps, agora });
  return r;
}

// Depois de juntar o acréscimo os itens podem ter mudado de número: acha o item de prestação
// pelo título na pauta final e encaixa os slides nele.
function encaixarAtualizar(roteiro, fin, avisos) {
  const sPauta = roteiro.slides.find((s) => s.tipo === 'pauta');
  const textos = (sPauta && Array.isArray(sPauta.itens) ? sPauta.itens : []).map((it) => (typeof it === 'string' ? it : (it && it.titulo) || ''));
  let k = textos.findIndex((t) => t === fin.titulo);
  if (k < 0) k = textos.findIndex((t) => RE_PRESTACAO.test(t));
  const n = k >= 0 ? k + 1 : fin.numero;
  return encaixar(roteiro, Object.assign({}, fin, { numero: n, slides: fin.slides.map((s) => Object.assign({}, s, { numero: n })) }), avisos);
}

// Dependências a partir das do criarRotasApresentacao: puxarDadosPrestacao (dublê nos
// testes) ou o cliente do Superlógica com as chaves do servidor.
function dependencias(deps, motor) {
  let puxar = deps.puxarDadosPrestacao || null;
  if (!puxar && deps.superlogica && deps.superlogica.appToken && deps.superlogica.accessToken) {
    const sl = require('../superlogica-dados');
    const cliente = sl.criarCliente(deps.superlogica);
    puxar = (p) => sl.puxarDadosPrestacao(cliente, p);
  }
  return { motor, puxar, podeUsarSuperlogica: deps.podeUsarSuperlogica || null };
}

// Pedaço do registro da geração: quantas chamadas a leitura das imagens fez e se os números
// da prestação vieram do sistema (sem nenhum dado do pedido).
function logLeitura(dados, fin) {
  const l = dados.leituraInfo || {};
  return ' imagens_rapidas=' + (l.rapidas || 0) + ' chamadas_imagens=' + ((l.chamadasRapidas || 0) + (l.chamadasAlta || 0))
    + ' vetoriais=' + ((dados.vetoriais || []).length) + ' financeiro=' + (fin && fin.slides ? 'sistema' : '-');
}

// Número de um campo de valor (mesma regra de servico/apresentacao.js).
function numeroDe(v) {
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const s = v.replace(/R\$|\s/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$|^-?\d+,\d+$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return NaN;
}

module.exports = {
  itemPrestacao, periodoDoTexto, dataAssembleia, decidirPeriodo, rotuloPeriodo, montarSlides, instrucao, encaixar, conferirSlide, prepararFinanceiro,
  prepararFinanceiroAtualizar, encaixarAtualizar, dependencias, logLeitura,
  reaisC, TIPOS_FINANCEIROS, RE_PRESTACAO,
};
