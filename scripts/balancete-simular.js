'use strict';
// Simulação do balancete digital num condomínio real, SÓ LEITURA. Nada é gravado no Superlógica e
// nada vai para morador: a trava de https e o cliente só de leitura abortam qualquer gravação.
// Uso (credenciais pelas variáveis do Railway, nunca impressas):
//   node scripts/balancete-simular.js buscar                 acha Buritis, Victoria Bay e 900A publicados
//   node scripts/balancete-simular.js 94:2026-09 94:2026-08  simula
//   opções: --pdf confere o PDF do 900A da equipe; --sem-travas só compara o R&D; --brutos lista os
//   comentários lidos; --todas-contas lê também as notas por conta; --json devolve os dados.
const S = require('../financeiro/balancete-simulacao');
S.travarHttps((motivo) => { console.log('ABORTADO: ' + motivo); process.exit(2); });
const slDados = require('../superlogica-dados');
const D = require('../financeiro/balancete-digital');
const B = require('../financeiro/balancete');
const fechamento = require('../financeiro/fechamento');
const { criarConciliacao } = require('../financeiro/conciliacao');
const { criarPainel } = require('../financeiro/painel');
const finBoletos = require('../financeiro/boletos');

const base = (process.env.SUPERLOGICA_API_BASE || 'https://api.superlogica.net').replace(/\/+$/, '');
const cred = { base, appToken: process.env.SUPERLOGICA_APP_TOKEN || '', accessToken: process.env.SUPERLOGICA_ACCESS_TOKEN || '' };
if (!cred.appToken || !cred.accessToken) { console.log('Sem as chaves do Superlógica no ambiente.'); process.exit(1); }
const cli = S.clienteSoLeitura(slDados.criarCliente(cred), (m) => { console.log('ABORTADO: ' + m); process.exit(2); });
const args = process.argv.slice(2);
const comPdf = args.includes('--pdf');

async function nomes() {
  const out = new Map();
  for (let pg = 1; pg <= 10; pg++) {
    const j = await cli.get('condominios/get', { id: -1, somenteCondominiosAtivos: 1, apenasColunasPrincipais: 1, itensPorPagina: 50, pagina: pg });
    const arr = Array.isArray(j) ? j : [];
    arr.forEach((c) => out.set(String(c.id_condominio_cond), String(c.st_fantasia_cond || c.st_nome_cond || '').trim()));
    if (arr.length < 50) break;
  }
  return out;
}

async function buscar() {
  const n = await nomes();
  const alvo = [...n.entries()].filter(([, nome]) => /buritis|victoria|vit[oó]ria bay/i.test(nome));
  console.log('Achados: ' + JSON.stringify(alvo));
  for (const [id, nome] of alvo) {
    for (const comp of ['2026-08', '2026-09']) {
      try { const l = await B.listarImpressoes(cli, id, comp); console.log(id + ' ' + nome + ' ' + comp + ': ' + JSON.stringify(l.filter((x) => x.da_competencia).map((x) => ({ id: x.id, publicado: x.publicado, criado: x.criado_em, titulo: x.titulo.slice(0, 50) })))); }
      catch (e) { console.log(id + ' ' + comp + ' erro ' + e.message); }
    }
  }
}

// Travas do dia 1 seguinte: checklist da T38 (conciliação, extrato, pré balancete, boletos; anexos
// não são lidos aqui), soma contra o caixa, fechamento, 900A e o documento que precisaria chegar.
async function travas(id, c, dia1, modelo) {
  const conc = criarConciliacao({ cliente: () => cli, hoje: () => dia1 });
  const painel = criarPainel({ cliente: () => cli, hoje: () => dia1, log: () => {} });
  const err = (p) => p.then((v) => v, (e) => ({ erro: (e && e.message) || 'falha' }));
  const [cc, pre, bol, soma, fech, imps] = await Promise.all([
    err(conc.condominio(id, c.chave, false)), err(painel.preBalancete(id, c.chave, false)), err(finBoletos.conferirBoletos(cli, id, c.chave)),
    err(D.conferirSoma(cli, id, c.chave)), err(D.dataFechamento(cli, id)), err(B.listarImpressoes(cli, id, c.chave)),
  ]);
  const anexos = { resultado: { pode_fechar: true, resumo: {} } }; // não conferidos na simulação (ver nota)
  const f = fechamento.montarFechamento({ comp: { rotulo: c.chave, inicio: c.inicio, fim: c.fim }, hoje: dia1, pre: pre.erro ? null : pre, conc: cc.erro ? null : cc, boletos: bol.erro ? null : bol, anexos, marcas: {} });
  const lista = Array.isArray(imps) ? imps.filter((x) => x.da_competencia) : [];
  // No dia 1 só existiam os 900A criados até ele, e nada estava publicado ainda.
  const ateDia1 = lista.filter((x) => { const iso = D.slParaIso(x.criado_em); return iso && iso <= dia1; }).map((x) => Object.assign({}, x, { publicado: false }));
  let conferencia = null;
  // 900A que a equipe gerou: o publicado, ou o mais novo com o título padrão (os testes do Hub ficam de fora).
  const daEquipe = lista.filter((x) => x.publicado || /^900A - Presta[cç][aã]o de contas na Web$/i.test(x.titulo)).sort((a, b) => (b.publicado - a.publicado) || Number(b.id) - Number(a.id));
  const pub = daEquipe[0];
  if (comPdf && pub) {
    B.iniciarConferencia({ cred, cliente: cli, idCondominio: id, competencia: c.chave, idImpressao: pub.id, log: () => {} });
    for (let t = 0; t < 120; t++) {
      const s = B.situacaoConferencia(id, c.chave, pub.id);
      if (s && s.estado === 'pronto') { const r = s.resultado; conferencia = { impressao: pub.id, ok: r.ok, problemas: r.problemas, resumo: [
        r.total_paginas + ' páginas', 'mês fora: ' + r.mes_fora.length, 'itens faltando: ' + r.itens.faltando.length, 'pagas sem comprovante no PDF: ' + r.comprovantes.sem_comprovante_no_pdf.length,
        'páginas em branco: ' + r.paginas_em_branco.length, 'repetidas: ' + r.paginas_repetidas.length].join(', ') }; break; }
      if (s && s.estado === 'erro') { conferencia = { impressao: pub.id, ok: false, problemas: 0, resumo: 'não foi possível ler o PDF (' + s.erro + ')' }; break; }
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
  const sit = D.montarSituacao({ comp: c.chave, hoje: dia1, fechamento: f, pre: pre.erro ? null : pre, soma: soma.erro ? null : soma, modelo: { plano: '0', itens: modelo.itens },
    documentos: new Set(), montagem: {}, gravacao: 'livre', fechadoAte: fech.erro ? null : fech.iso, impressoes: ateDia1, conferencia: null });
  const notas = ['Números lidos hoje: correções feitas pela equipe depois do dia 1 já aparecem corrigidas.', 'Anexos das despesas não conferidos na simulação.', 'Fechamento lido hoje: ' + (fech.erro ? 'não lido' : (D.isoBR(fech.iso) || 'nunca fechado')) + '.'];
  if (cc.erro) notas.push('Conciliação não lida: ' + cc.erro);
  if (pre.erro) notas.push('Pré balancete não lido: ' + pre.erro);
  if (pub) notas.push('900A da equipe: impressão ' + pub.id + ' criada em ' + pub.criado_em + (pub.publicado ? ', publicada' : ', não marcada como publicada no Superlógica') + '.');
  return { etapa: sit.etapa, etapa_nome: sit.etapa_nome, travas: sit.travas, avisos: sit.avisos || [], soma: soma.erro ? null : soma, conferencia_900a: conferencia, notas };
}

(async () => {
  if (args[0] === 'buscar') { await buscar(); process.exit(0); }
  const n = await nomes().catch(() => new Map());
  const pares = args.filter((a) => /^\d+:\d{4}-\d{2}$/.test(a));
  const todos = [];
  for (const p of pares) {
    const [id, comp] = p.split(':');
    if (D.NAO_CONDOMINIOS.has(id)) { console.log(id + ': não é condomínio'); continue; }
    const r = await S.simular({ cliente: cli, travas: args.includes('--sem-travas') ? null : travas }, id, comp, { brutos: args.includes('--brutos'), todasContas: args.includes('--todas-contas') });
    todos.push(r);
    console.log('\n' + S.relatorio(r, n.get(id)));
    if (args.includes('--json')) console.log(JSON.stringify({ modelo: r.modelo, comparacao: r.comparacao, comentarios_por_mes: r.comentarios_por_mes, contas_lidas: r.contas_lidas }));
    if (r.brutos) console.log('BRUTOS ' + JSON.stringify(Object.fromEntries(Object.entries(r.brutos.porMes).concat([[comp, r.brutos.doMes]]).map(([m, l]) => [m, l.map((x) => { const c = D.lerComentario(x); return [c.id, c.conta, c.titulo, c.arquivos.map((a) => a.etiqueta_nome || a.etiqueta_id).join('+')]; })]))));
  }
  const ac = todos.map((r) => r.comparacao.acerto).filter((x) => x != null);
  if (ac.length) console.log('\nAcerto médio: ' + Math.round(ac.reduce((s, x) => s + x, 0) / ac.length) + '% em ' + ac.length + ' simulação(ões). Chamadas de leitura: ' + cli.chamadas() + '.');
  process.exit(0);
})().catch((e) => { console.log('ERRO ' + (e && e.message)); process.exit(1); });
