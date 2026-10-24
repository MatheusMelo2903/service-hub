'use strict';
// ─────────────────────────────────────────────────────────────────────────
// Simulação do balancete digital, SÓ LEITURA (pedido do Matheus, 24/10/2026): num mês que a equipe
// já fez e publicou, o sistema aprende o modelo com os meses ANTERIORES (nunca com o próprio mês),
// monta o plano do que colocaria no Demonstrativo R&D e compara item por item com o que a equipe
// colocou. Calcula também as travas e a conferência do 900A como se fosse o dia 1 do mês seguinte.
// Nada é gravado no Superlógica e nada vai para morador: o cliente só aceita GET de leitura e a trava
// de https recusa qualquer outro método ou rota de gravação (aborta).
// ─────────────────────────────────────────────────────────────────────────
const https = require('https');
const D = require('./balancete-digital');

// Rotas de gravação conhecidas (e as que criam alguma coisa mesmo sendo GET, como relatorios/id,
// que gera uma impressão). Qualquer uma delas aborta a simulação.
const ROTA_GRAVACAO = /(^|\/)(put|post|delete|fecharmes|estornar|processar|adicionaretiqueta|removeetiqueta|putarquivos|enviar|email|gerar|publicar|anexar|liquidar|update|desativar|importar)(\/|$|\?)|impressoes\/post|comentarios\/put|arquivos\/put|(^|\/)relatorios\/id\//i;
function rotaDeGravacao(caminho) { return ROTA_GRAVACAO.test(String(caminho || '').replace(/^\/?v2\/condor\//, '')); }

// Trava de https para o processo inteiro: só GET e nunca rota de gravação. aoTentar recebe o motivo
// (o script aborta o processo). Devolve a função que desfaz a trava (para os testes).
function travarHttps(aoTentar) {
  const original = https.request;
  https.request = function (opcoes, cb) {
    const metodo = String((opcoes && opcoes.method) || 'GET').toUpperCase();
    const caminho = String((opcoes && opcoes.path) || '').split('?')[0];
    if (metodo !== 'GET' || rotaDeGravacao(caminho)) {
      const motivo = 'gravação recusada na simulação: ' + metodo + ' ' + caminho;
      if (aoTentar) aoTentar(motivo);
      throw Object.assign(new Error(motivo), { codigo: 'so_leitura' });
    }
    return original.apply(this, arguments);
  };
  return () => { https.request = original; };
}
// Cliente só de leitura por cima do cliente do Hub (cliente.get). Conta as chamadas.
function clienteSoLeitura(base, aoTentar) {
  let chamadas = 0;
  return {
    async get(rota, q) {
      if (rotaDeGravacao(rota)) { const m = 'gravação recusada na simulação: ' + rota; if (aoTentar) aoTentar(m); throw Object.assign(new Error(m), { codigo: 'so_leitura' }); }
      chamadas++;
      return base.get(rota, q);
    },
    chamadas: () => chamadas,
  };
}

// Fila simples: no máximo n chamadas ao mesmo tempo.
async function emParalelo(tarefas, n) {
  const out = new Array(tarefas.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tarefas.length) }, async () => { while (i < tarefas.length) { const k = i++; out[k] = await tarefas[k](); } }));
  return out;
}

// Contas do demonstrativo de um mês (receitas e despesas até o 3º nível), onde os comentários ficam.
async function contasDoMes(cliente, id, comp) {
  const c = D.competencia(comp);
  const j = await cliente.get('balancetes/index', { idCondominio: id, dtInicio: String(c.mes).padStart(2, '0') + '/01/' + c.ano, dtFim: String(c.mes).padStart(2, '0') + '/' + c.ultimoDia + '/' + c.ano });
  const contas = [];
  (Array.isArray(j) ? j : []).forEach((b) => ((b && b.itens) || []).forEach((g) => (g || []).forEach((x) => { const s = String((x && x.conta) || '').trim(); if (/^\d+(\.\d+){0,2}$/.test(s)) contas.push(s); })));
  return contas;
}
// Comentários do mês em todas as contas (só os do próprio mês, pelo identificador "<cond>_<plano>_<conta>/AAAAMM").
async function comentariosDoMesTodo(cliente, id, comp, contas) {
  const listas = await emParalelo(contas.map((conta) => async () => { try { return await D.comentariosDoMes(cliente, id, comp, conta); } catch (e) { return []; } }), 3);
  const vistos = new Set();
  const out = [];
  listas.forEach((l) => l.forEach((x) => {
    const c = D.lerComentario(x);
    if (!c || !c.id || vistos.has(c.id) || (c.referencia && c.referencia !== comp)) return;
    vistos.add(c.id);
    out.push(x);
  }));
  // Ordem do R&D: o balão do Demonstrativo primeiro, depois as contas (como no demonstrativo) e,
  // dentro de cada lugar, o comentário mais antigo primeiro (a ordem em que a equipe criou).
  const ordemConta = new Map(contas.map((k, i) => [k, i]));
  ordemConta.set(D.OBJETO_RD, -1);
  return out.sort((a, b) => {
    const ca = D.lerComentario(a), cb = D.lerComentario(b);
    return (ordemConta.get(ca.conta) ?? 999) - (ordemConta.get(cb.conta) ?? 999) || Number(ca.id) - Number(cb.id);
  });
}

// Semelhança entre dois títulos (palavras em comum), de 0 a 1.
function semelhanca(a, b) {
  const pa = new Set(D.chaveTitulo(a).split(' ').filter((x) => x.length > 1));
  const pb = new Set(D.chaveTitulo(b).split(' ').filter((x) => x.length > 1));
  if (!pa.size || !pb.size) return 0;
  let n = 0; pa.forEach((x) => { if (pb.has(x)) n++; });
  return n / Math.max(pa.size, pb.size);
}
const fonteChave = (f) => (f ? f.tipo + ':' + (f.codigo || f.grupo || '') : '');

// Compara o plano (itens do modelo) com o que a equipe colocou no mês (comentários lidos).
// Pareia por título igual; depois mesma origem do documento e mesma conta; depois título parecido.
function comparar(plano, reaisBrutos) {
  const reais = reaisBrutos.map(D.lerComentario).filter((c) => c && c.titulo);
  const livres = new Set(reais.map((_, i) => i));
  const pares = [];
  const sobrouPlano = [];
  const etiquetaReal = (r) => { const a = r.arquivos.find((x) => x.etiqueta_id) || r.arquivos[0]; return a ? { id: a.etiqueta_id, nome: a.etiqueta_nome } : { id: null, nome: '' }; };
  const tentar = (p, criterio) => {
    for (const i of livres) {
      const r = reais[i];
      if (criterio(p, r)) { livres.delete(i); return i; }
    }
    return -1;
  };
  const passo = [
    (p, r) => D.chaveTitulo(p.titulo) === D.chaveTitulo(r.titulo),
    (p, r) => fonteChave(p.fonte) === fonteChave(D.classificarDocumento(r.titulo)) && p.fonte.confianca !== 'baixa' && p.conta === r.conta,
    (p, r) => semelhanca(p.titulo, r.titulo) >= 0.6,
  ];
  const pendentes = plano.slice();
  const casados = new Map();
  for (const criterio of passo) {
    for (const p of pendentes) {
      if (casados.has(p.chave)) continue;
      const i = tentar(p, criterio);
      if (i >= 0) casados.set(p.chave, i);
    }
  }
  plano.forEach((p, k) => {
    if (!casados.has(p.chave)) { sobrouPlano.push({ titulo: p.titulo, conta: p.conta, etiqueta: p.etiqueta_nome || p.etiqueta_id || '', documento: p.fonte.descricao }); return; }
    const i = casados.get(p.chave);
    const r = reais[i];
    const e = etiquetaReal(r);
    pares.push({ ordem_plano: k + 1, ordem_real: i + 1, plano: p, real: r, etiqueta_real: e });
  });
  // Ordem: posição relativa entre os itens que casaram (no plano e na equipe).
  const porReal = pares.slice().sort((a, b) => a.ordem_real - b.ordem_real);
  porReal.forEach((x, k) => { x.pos_real = k; });
  pares.forEach((x, k) => { x.pos_plano = k; });
  const itens = pares.map((x) => {
    const dif = [];
    if (x.plano.conta && x.real.conta && x.plano.conta !== x.real.conta) dif.push('conta ' + x.plano.conta + ' no plano, ' + x.real.conta + ' na equipe');
    if ((x.plano.etiqueta_id || null) !== (x.etiqueta_real.id || null)) dif.push('etiqueta ' + (x.plano.etiqueta_nome || x.plano.etiqueta_id || 'nenhuma') + ' no plano, ' + (x.etiqueta_real.nome || x.etiqueta_real.id || 'nenhuma') + ' na equipe');
    if (x.pos_plano !== x.pos_real) dif.push('ordem ' + (x.pos_plano + 1) + 'º no plano, ' + (x.pos_real + 1) + 'º na equipe');
    if (!x.real.arquivos.length) dif.push('a equipe não anexou documento');
    return { titulo_plano: x.plano.titulo, titulo_equipe: x.real.titulo, conta: x.real.conta, etiqueta: x.etiqueta_real.nome || x.etiqueta_real.id || '', documento: x.plano.fonte.descricao,
      anexos_equipe: x.real.arquivos.length, anexos_tipicos: x.plano.anexos_por_mes || 0, diferencas: dif };
  });
  const faltou = [...livres].map((i) => ({ titulo: reais[i].titulo, conta: reais[i].conta, etiqueta: etiquetaReal(reais[i]).nome || '', anexos: reais[i].arquivos.length }));
  const exatos = itens.filter((x) => !x.diferencas.length).length;
  const universo = reais.length + sobrouPlano.length;
  return {
    reais: reais.length, plano: plano.length, casados: itens.length, exatos,
    acerto: universo ? Math.round((exatos / universo) * 100) : null,
    cobertura: reais.length ? Math.round((itens.length / reais.length) * 100) : null,
    bateu: itens.filter((x) => !x.diferencas.length), com_diferenca: itens.filter((x) => x.diferencas.length), faltou_no_plano: faltou, a_mais_no_plano: sobrouPlano,
  };
}

// Simulação completa de um condomínio e mês. deps: { cliente (só leitura), cred, comPdf, log,
// conciliacao, painel, boletos (funções do Hub; opcionais) }. Devolve o resultado e o relatório.
async function simular(deps, idCond, comp, opcoes) {
  const o = opcoes || {};
  const c = D.competencia(comp);
  if (!c) throw new Error('competencia_invalida');
  const cli = deps.cliente;
  const dia1 = D.somarMeses(c, 1).inicio;
  const meses = [1, 2, 3].map((k) => D.somarMeses(c, -k).chave).reverse();
  // Primeiro só o balão do Demonstrativo R&D (onde a equipe põe). Se não houver nada lá em nenhum
  // mês, lê também as notas por conta (contas de todos os meses, na ordem do demonstrativo).
  let lista = [D.OBJETO_RD];
  const ler = async () => {
    const pm = {};
    for (const m of meses) pm[m] = await comentariosDoMesTodo(cli, idCond, m, lista);
    return { pm, doMes: await comentariosDoMesTodo(cli, idCond, c.chave, lista) };
  };
  let lidos = await ler();
  if (o.todasContas || (!lidos.doMes.length && Object.values(lidos.pm).every((l) => !l.length))) {
    const contas = [];
    for (const m of [c.chave].concat(meses)) { try { (await contasDoMes(cli, idCond, m)).forEach((k) => { if (!contas.includes(k)) contas.push(k); }); } catch (e) { /* mês sem demonstrativo */ } }
    lista = [D.OBJETO_RD].concat(contas.slice(0, o.maxContas || 80));
    lidos = await ler();
  }
  const porMes = lidos.pm;
  const doMes = lidos.doMes;
  let etiquetas = [];
  try { etiquetas = await D.etiquetasDoSuperlogica(cli); } catch (e) { etiquetas = []; }
  const modelo = D.aprenderModelo(porMes, {});
  modelo.itens.forEach((i) => { if (!i.etiqueta_id && i.etiqueta_nome) { const e = etiquetas.find((x) => x.nome.toLowerCase() === i.etiqueta_nome.toLowerCase()); if (e) i.etiqueta_id = e.id; } });
  const cmp = comparar(modelo.itens, doMes);

  // Travas como se fosse o dia 1 seguinte (os números são lidos hoje: o que a equipe corrigiu depois
  // do dia 1 já aparece corrigido).
  const travas = { calculado: false };
  if (deps.travas) {
    try { Object.assign(travas, await deps.travas(idCond, c, dia1, modelo)); travas.calculado = true; } catch (e) { travas.erro = String(e && e.message).slice(0, 120); }
  }
  return { condominio: idCond, competencia: c.chave, dia_simulado: dia1, meses_aprendidos: meses, contas_lidas: lista.length, comentarios_por_mes: Object.fromEntries(meses.map((m) => [m, porMes[m].length]).concat([[c.chave, doMes.length]])),
    modelo: { itens: modelo.itens.map((i) => ({ ordem: i.ordem, titulo: i.titulo, conta: i.conta, etiqueta: i.etiqueta_nome || i.etiqueta_id || '', documento: i.fonte.descricao, meses: i.meses, anexos_por_mes: i.anexos_por_mes })), as_vezes: modelo.as_vezes.map((i) => i.titulo + ' (' + i.meses + ' mês)'), avisos: modelo.avisos, visibilidade_equipe: modelo.visibilidade_equipe },
    comparacao: cmp, travas, chamadas: cli.chamadas ? cli.chamadas() : null, brutos: o.brutos ? { porMes, doMes } : undefined };
}

// Relatório curto em português (sem hífen como pontuação).
function relatorio(r, nome) {
  const c = r.comparacao;
  const l = [];
  l.push((nome || ('Condomínio ' + r.condominio)) + ', ' + r.competencia.slice(5) + '/' + r.competencia.slice(0, 4) + ' (aprendido com ' + r.meses_aprendidos.map((m) => m.slice(5) + '/' + m.slice(0, 4)).join(', ') + ')');
  if (r.modelo.itens.length) l.push('Plano: ' + r.modelo.itens.map((i) => i.ordem + '. ' + i.titulo + ' [' + (i.etiqueta || 'sem etiqueta') + '; ' + i.documento + (i.anexos_por_mes > 1 ? '; ' + i.anexos_por_mes + ' anexos' : '') + ']').join(' | '));
  l.push('Comentários da equipe no mês: ' + c.reais + '. Plano do sistema: ' + c.plano + '. Casaram: ' + c.casados + ', iguais em tudo: ' + c.exatos + '.');
  l.push('Acerto: ' + (c.acerto == null ? 'sem base' : c.acerto + '%') + ' (iguais em tudo sobre o total). Cobertura: ' + (c.cobertura == null ? 'sem base' : c.cobertura + '%') + ' dos comentários da equipe.');
  if (c.com_diferenca.length) l.push('Com diferença: ' + c.com_diferenca.map((x) => '"' + x.titulo_equipe + '" (' + x.diferencas.join('; ') + ')').join(' | '));
  if (c.faltou_no_plano.length) l.push('Faltou no plano: ' + c.faltou_no_plano.map((x) => '"' + x.titulo + '" em ' + x.conta).join(' | '));
  if (c.a_mais_no_plano.length) l.push('A mais no plano: ' + c.a_mais_no_plano.map((x) => '"' + x.titulo + '" em ' + x.conta).join(' | '));
  if (r.modelo.visibilidade_equipe === 1) l.push('A equipe deixa os comentários visíveis para o condômino; o sistema grava invisível (decisão pendente).');
  if (r.modelo.as_vezes.length) l.push('Só às vezes nos meses anteriores (fora do plano): ' + r.modelo.as_vezes.join(', '));
  const t = r.travas;
  if (t.calculado) {
    l.push('No dia ' + r.dia_simulado.split('-').reverse().join('/') + ': etapa ' + t.etapa_nome + ', ' + t.travas.length + ' trava(s).');
    t.travas.slice(0, 8).forEach((x) => l.push('  ' + x.causa + ' Quem age: ' + x.quem));
    if (t.travas.length > 8) l.push('  Mais ' + (t.travas.length - 8) + ' trava(s).');
    (t.avisos || []).forEach((x) => l.push('Aviso: ' + x));
    if (t.conferencia_900a) l.push('Conferência do 900A da equipe (' + t.conferencia_900a.impressao + '): ' + (t.conferencia_900a.ok ? 'sem problemas' : t.conferencia_900a.problemas + ' ponto(s)') + (t.conferencia_900a.resumo ? ': ' + t.conferencia_900a.resumo : ''));
    (t.notas || []).forEach((x) => l.push('Nota: ' + x));
  } else if (t.erro) l.push('Travas não calculadas: ' + t.erro);
  return l.join('\n');
}

module.exports = { ROTA_GRAVACAO, rotaDeGravacao, travarHttps, clienteSoLeitura, contasDoMes, comentariosDoMesTodo, semelhanca, comparar, simular, relatorio };
