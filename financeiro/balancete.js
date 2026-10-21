'use strict';
// T41 Balancete digital: conferência automática do PDF do 900A (prestação de contas) gerado no
// Superlógica. Só leitura: lista as impressões (impressoes/index), baixa o PDF da impressão
// (documentos/download, que redireciona para o armazenamento do Superlógica), lê as páginas num
// processo separado (balancete-pdf-worker.js) e confere:
//   1. mês: capas e cabeçalhos de cada relatório no mês da prestação (011A: 11 meses antes até o mês);
//   2. itens: cada relatório da seleção aparece (na ordem) no PDF;
//   3. comprovantes: parcelas do 061A contra as despesas liquidadas no mês (despesas/index);
//   4. páginas em branco e repetidas.
// Gerar o 900A (gerarImpressao) é separado e só roda para condomínio liberado em
// BALANCETE_GERACAO_LIBERADA. Publicar para os condôminos NUNCA é feito aqui: fica com clique humano.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, execFile } = require('child_process');

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const limpar = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// Algumas capas saem com acento quebrado ("GRÃ•FICOS" no lugar de "GRÁFICOS"): a chave do título
// fica só com as letras sem acento, que saem iguais nos dois casos ("GRFICOS").
const chaveTitulo = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

// 'AAAA-MM' -> { ano, mes, chave, rotulo:'Set/2026' } ou null.
function competencia(str) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const ano = Number(m[1]), mes = Number(m[2]);
  if (ano < 2000 || ano > 2100 || mes < 1 || mes > 12) return null;
  return { ano, mes, chave: m[1] + '-' + m[2], rotulo: MESES[mes - 1] + '/' + ano };
}
function somarMeses(c, n) {
  const t = c.ano * 12 + (c.mes - 1) + n;
  const ano = Math.floor(t / 12), mes = (t % 12) + 1;
  return competencia(ano + '-' + String(mes).padStart(2, '0'));
}
const chaveDe = (ano, mes) => ano + '-' + String(mes).padStart(2, '0');

// Meses citados num trecho: "Set/2026", "Setembro/2026", "Setembro de 2026", "01/09/2026".
// Ignora o que vem depois de "competência" (o 003A cita a competência do boleto, que é outro mês).
function mesesCitados(trecho) {
  const t = semAcento(String(trecho || '')).replace(/com competencia em .*$/i, '');
  const out = [];
  const reAbrev = /\b(jan|janeiro|fev|fevereiro|mar|marco|abr|abril|mai|maio|jun|junho|jul|julho|ago|agosto|set|setembro|out|outubro|nov|novembro|dez|dezembro)\s*(?:\/|de)\s*(\d{4})\b/gi;
  let m;
  while ((m = reAbrev.exec(t))) {
    const i = MESES.findIndex((x) => semAcento(x).toLowerCase() === m[1].slice(0, 3).toLowerCase());
    if (i >= 0) out.push(chaveDe(Number(m[2]), i + 1));
  }
  const reData = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;
  while ((m = reData.exec(t))) {
    const mes = Number(m[2]);
    if (mes >= 1 && mes <= 12) out.push(chaveDe(Number(m[3]), mes));
  }
  return out;
}

// ── classificação das páginas ─────────────────────────────────────────────
// Relatório: 1ª linha "W020A VICTORIA BAY (94)", 2ª o nome, 3ª o filtro (período).
// Capa (035C): "VICTORIA BAY" / "TÍTULO" / "Set/2026 (01/09/2026 até 30/09/2026)", sem código.
// 015E (balancete com aprovação): sem código; começa com "Condomínio:" e tem "Balancete:".
const RX_CABECALHO = /^W?(\d{3}[A-Z])\b/;
const RX_RODAPE = /^\s*\d+\s+de\s+\d+\s*$/;
const RX_PERIODO_CAPA = /\(\d{2}\/\d{2}\/\d{4}\s+at[eé]\s+\d{2}\/\d{2}\/\d{4}\)/;
function linhas(texto) { return String(texto || '').split('\n').map(limpar).filter(Boolean); }

function classificarPagina(p) {
  const ls = linhas(p.texto);
  const out = { pagina: p.pagina, imagens: Number(p.imagens) || 0, desenhos: Number(p.desenhos) || 0, chars: ls.join(' ').length, erro: !!p.erro };
  const m = ls.length ? RX_CABECALHO.exec(ls[0]) : null;
  if (m && ls.length >= 2) {
    out.tipo = 'relatorio';
    out.codigo = m[1];
    out.titulo = (ls[1] || '').slice(0, 120);
    out.filtro = (ls[2] && !RX_RODAPE.test(ls[2]) ? ls[2] : '').slice(0, 300);
    const corpo = ls.slice(3).filter((l) => !RX_RODAPE.test(l) && l !== out.filtro && l !== out.titulo && !/^Vit[oó]ria \/ ES$/i.test(l));
    out.corpo = corpo.join(' ').length;
    const parc = /Parcela\s+(\d+)/i.exec(out.filtro);
    if (parc) out.parcela = parc[1];
    const mov = /Movimenta[cç][aã]o Direta\s+(\d+)/i.exec(out.filtro);
    if (mov) out.movimentacao = mov[1];
    return out;
  }
  const capa = ls.length >= 2 && ls.length <= 6 && RX_PERIODO_CAPA.test(ls.join(' ')) && out.chars < 300;
  if (capa) {
    out.tipo = 'capa';
    out.codigo = '035C';
    const iPer = ls.findIndex((l) => RX_PERIODO_CAPA.test(l));
    out.titulo = (ls[iPer - 1] || ls[1] || '').slice(0, 120);
    out.filtro = ls[iPer].slice(0, 120);
    out.corpo = 0;
    return out;
  }
  if (ls.length && /^Condom[ií]nio:/i.test(ls[0]) && ls.some((l) => /^Balancete:/i.test(l))) {
    out.tipo = 'relatorio';
    out.codigo = '015E';
    out.titulo = 'Balancete com aprovação';
    out.filtro = (ls.find((l) => /^Balancete:/i.test(l)) || '').slice(0, 200);
    out.corpo = out.chars;
    return out;
  }
  out.tipo = ls.length ? 'continuacao' : 'vazia';
  out.corpo = out.chars;
  return out;
}

// Agrupa páginas seguidas do mesmo relatório (mesmo código e mesmo filtro; capa sempre sozinha;
// página de continuação sem cabeçalho entra no relatório anterior).
function montarSecoes(paginas) {
  const secoes = [];
  let atual = null;
  for (const p of paginas) {
    const c = classificarPagina(p);
    const mesma = atual && c.tipo !== 'capa' && (c.tipo === 'continuacao' || c.tipo === 'vazia'
      || (c.tipo === 'relatorio' && c.codigo === atual.codigo && c.filtro === atual.filtro));
    if (mesma) { atual.fim = c.pagina; atual.paginas.push(c); continue; }
    atual = { codigo: c.codigo || '', tipo: c.tipo, titulo: c.titulo || '', filtro: c.filtro || '', inicio: c.pagina, fim: c.pagina, paginas: [c] };
    if (c.parcela) atual.parcela = c.parcela;
    if (c.movimentacao) atual.movimentacao = c.movimentacao;
    secoes.push(atual);
  }
  return secoes;
}

// ── regras do mês por relatório ───────────────────────────────────────────
// 011A: primeira coluna 11 meses antes do mês da prestação ("Comparativo de Out/2025 com os próximos 11 meses").
// 015G e 060B: anuais, terminam no mês da prestação. Os demais: só o mês da prestação.
// Relatórios de posição (003A, 002B, 060B) citam o último dia do mês; 020A cita "saldo em" do mês
// anterior no corpo, mas o corpo não entra: só o cabeçalho (filtro) é conferido.
const ANUAIS = new Set(['015G', '060B']);
const rot = (chave) => (competencia(chave) || {}).rotulo || String(chave || '?');
function conferirMesSecao(s, comp) {
  const citados = mesesCitados(s.filtro).filter((c) => competencia(c));
  if (!citados.length) return null; // sem período no cabeçalho (carta, parecer): nada a conferir
  if (s.codigo === '011A') {
    const ini = somarMeses(comp, -11) || { chave: '', rotulo: '?' };
    const primeira = citados[0];
    const m = /pr[oó]ximos\s+(\d+)\s+meses/i.exec(s.filtro);
    const qtd = m ? Number(m[1]) : 0;
    if (primeira === ini.chave && qtd === 11) return null;
    const ultima = primeira && qtd && competencia(primeira) ? somarMeses(competencia(primeira), qtd) : null;
    return { esperado: ini.rotulo + ' a ' + comp.rotulo, achado: rot(primeira) + (ultima ? ' a ' + ultima.rotulo : '') };
  }
  if (ANUAIS.has(s.codigo)) {
    const ultimo = citados.slice().sort().pop();
    if (ultimo === comp.chave) return null;
    return { esperado: 'até ' + comp.rotulo, achado: 'até ' + rot(ultimo) };
  }
  const fora = [...new Set(citados.filter((c) => c !== comp.chave))];
  if (!fora.length) return null;
  return { esperado: comp.rotulo, achado: fora.map(rot).join(', ') };
}

// Itens esperados: lista de códigos na ordem da seleção (capas como '035C' com o título).
// Confere presença e ordem pela sequência das seções (cada parcela do 061A é uma seção só).
function conferirItens(secoes, esperados) {
  const achadas = [];
  for (const s of secoes) {
    const chave = s.codigo === '035C' ? '035C ' + chaveTitulo(s.titulo) : s.codigo;
    if (!achadas.length || achadas[achadas.length - 1].chave !== chave) achadas.push({ chave, inicio: s.inicio, fim: s.fim });
    else achadas[achadas.length - 1].fim = s.fim;
  }
  const faltando = [];
  const presentes = [];
  let i = 0;
  for (const e of esperados) {
    const chave = e.codigo === '035C' && e.titulo ? '035C ' + chaveTitulo(e.titulo) : e.codigo;
    const casa = (a) => a.chave === chave || (e.codigo === '035C' && !e.titulo && a.chave.startsWith('035C'));
    let j = i;
    while (j < achadas.length && !casa(achadas[j])) j++;
    if (j < achadas.length) { presentes.push({ item: e.rotulo || chave, paginas: achadas[j].inicio + ' a ' + achadas[j].fim }); i = j + 1; }
    else faltando.push(e.rotulo || chave);
  }
  return { esperados: esperados.length, presentes, faltando };
}

// Comprovantes: cada parcela do 061A contra as despesas liquidadas no mês.
// despesas: [{ id_parcela, id_despesa, fornecedor, valor, liquidacao, arquivos }]
function conferirComprovantes(secoes, despesas) {
  const blocos = secoes.filter((s) => s.codigo === '061A');
  const porParcela = new Map();
  const movimentacoes = [];
  for (const s of blocos) {
    if (s.parcela) {
      const l = porParcela.get(s.parcela) || [];
      l.push(s.inicio + ' a ' + s.fim);
      porParcela.set(s.parcela, l);
    } else if (s.movimentacao) movimentacoes.push(s.movimentacao);
  }
  const paginasComprovantes = blocos.reduce((n, s) => n + (s.fim - s.inicio + 1), 0);
  const liq = new Map();
  for (const d of despesas || []) if (d && d.id_parcela) liq.set(String(d.id_parcela), d);
  const semComprovanteNoPdf = [];
  for (const [id, d] of liq) {
    if (!porParcela.has(id)) semComprovanteNoPdf.push({ parcela: id, despesa: d.id_despesa, fornecedor: d.fornecedor, valor: d.valor, liquidacao: d.liquidacao, anexos: d.arquivos });
  }
  const foraDoMes = [...porParcela.keys()].filter((id) => !liq.has(id)).map((id) => ({ parcela: id, paginas: porParcela.get(id).join(', ') }));
  const repetidas = [...porParcela.entries()].filter(([, l]) => l.length > 1).map(([id, l]) => ({ parcela: id, paginas: l.join(', ') }));
  return {
    parcelas_no_pdf: porParcela.size, paginas: paginasComprovantes, movimentacoes_diretas: movimentacoes.length,
    despesas_liquidadas: liq.size, sem_comprovante_no_pdf: semComprovanteNoPdf, no_pdf_sem_liquidacao_no_mes: foraDoMes, parcela_repetida: repetidas,
  };
}

// Página em branco: sem conteúdo além do cabeçalho e rodapé e sem imagem.
// Anexo (061A e 061B) sem imagem: o documento não entrou. Página repetida: mesmo texto
// (sem o rodapé "N de M") com conteúdo de verdade em duas páginas.
function conferirPaginas(secoes) {
  const emBranco = [];
  const repetidas = [];
  for (const s of secoes) {
    for (const p of s.paginas) {
      const anexo = (s.codigo === '061A' || s.codigo === '061B') && (p.corpo || 0) < 20;
      if (p.erro) emBranco.push({ pagina: p.pagina, motivo: 'página que o leitor não conseguiu ler' });
      else if (p.tipo === 'vazia' && !p.imagens && p.desenhos < 3) emBranco.push({ pagina: p.pagina, motivo: 'página sem conteúdo' });
      else if (anexo && !p.imagens) emBranco.push({ pagina: p.pagina, motivo: 'anexo sem imagem (' + s.codigo + ')' });
      else if (p.tipo === 'relatorio' && s.codigo !== '061A' && s.codigo !== '061B' && (p.corpo || 0) < 5 && !p.imagens && p.desenhos < 10) emBranco.push({ pagina: p.pagina, motivo: 'relatório sem conteúdo (' + s.codigo + ')' });
    }
  }
  return { em_branco: emBranco, repetidas };
}
// Campo do modelo que não foi preenchido (ex.: "%administradora.nome%" na carta).
function camposNaoPreenchidos(paginasBrutas) {
  const out = [];
  for (const p of paginasBrutas) {
    const achados = String(p.texto || '').match(/%[a-z_]+(?:\.[a-z_]+)*%/gi);
    if (achados) out.push({ pagina: p.pagina, campos: [...new Set(achados)].slice(0, 5).join(', ') });
  }
  return out;
}
function marcarRepetidas(paginasBrutas, resultado) {
  const vistos = new Map();
  for (const p of paginasBrutas) {
    const corpo = linhas(p.texto).filter((l) => !RX_RODAPE.test(l)).join('\n');
    if (corpo.length < 300) continue;
    const ant = vistos.get(corpo);
    if (ant) resultado.repetidas.push({ pagina: p.pagina, igual_a: ant });
    else vistos.set(corpo, p.pagina);
  }
  return resultado;
}

// Itens da seleção "Prestação de contas na Web NOVA teste Hub" (T28 e T41), na ordem. A API não
// devolve os itens de uma seleção pessoal; para as seleções do condomínio, itensEsperados lê da API.
const ITENS_NOVA = [
  ['035F', 'Carta'], ['035A', 'Parecer'], ['035C', 'Capa', 'BALANCETE RESUMIDO'], ['015E', 'Balancete com aprovação'],
  ['035C', 'Capa', 'BALANCETE ANALITICO'], ['020A', 'Demonstrativo analítico'], ['035C', 'Capa', 'BALANCETE COMPARATIVO'],
  ['011A', 'Demonstrativo anual (12 meses)'], ['035C', 'Capa', 'GRÁFICOS'], ['037F', 'Distribuição das receitas'],
  ['037E', 'Distribuição das despesas'], ['015G', 'Receitas x despesas'], ['060B', 'Inadimplência anual'],
  ['035C', 'Capa', 'EXTRATO'], ['061B', 'Extrato do banco'], ['035C', 'Capa', 'EXTRATO POUPANÇA'], ['018B', 'Movimentação das contas'],
  ['035C', 'Capa', 'TAXA DE CONDOMINIO'], ['004A', 'Composição das cobranças'], ['035C', 'Capa', 'RECEITAS: TAXA DE ACORDO'],
  ['004A', 'Composição das cobranças (acordos)'], ['035C', 'Capa', 'RECEITAS: DATA CRÉDITO'], ['065A', 'Receitas por data de crédito'],
  ['035C', 'Capa', 'RECEITAS: LIQUIDOS PJBANK'], ['006C', 'Receitas liquidadas por condômino'], ['035C', 'Capa', 'OUTRAS RECEITAS'],
  ['053C', 'Movimentação direta crédito'], ['035C', 'Capa', 'TÍTULOS EMITIDOS NO MÊS'], ['061B', 'Simulação das arrecadações'],
  ['035C', 'Capa', 'TAXAS EM ABERTO MENSAL'], ['003A', 'Inadimplência horizontal'], ['035C', 'Capa', 'TAXAS EM ABERTO ACUMULADO'],
  ['002B', 'Inadimplência'], ['035C', 'Capa', 'DESPESAS'], ['061A', 'Comprovantes de despesas'],
].map(([codigo, nome, titulo]) => ({ codigo, titulo: titulo || '', rotulo: codigo + ' ' + nome + (titulo ? ' ' + titulo : '') }));

// Conferência completa a partir das páginas lidas. opcoes: { competencia:'AAAA-MM', esperados, despesas }
function conferir(paginas, opcoes) {
  const comp = competencia(opcoes.competencia);
  if (!comp) throw Object.assign(new Error('competencia_invalida'), { codigo: 'competencia' });
  const secoes = montarSecoes(paginas);
  const foraDoMes = [];
  for (const s of secoes) {
    const r = conferirMesSecao(s, comp);
    if (!r) continue;
    const ult = foraDoMes[foraDoMes.length - 1];
    // Comprovantes (061A) fora do mês viram uma linha só, com a lista das páginas.
    if (s.codigo === '061A' && ult && ult.codigo === '061A' && ult.achado === r.achado) { ult.paginas += ', ' + s.inicio; continue; }
    foraDoMes.push(Object.assign({ codigo: s.codigo, titulo: s.titulo, paginas: s.inicio === s.fim ? String(s.inicio) : s.inicio + ' a ' + s.fim }, r));
  }
  const itens = Array.isArray(opcoes.esperados) ? conferirItens(secoes, opcoes.esperados) : { esperados: 0, presentes: [], faltando: [], nao_conferido: 'Seleção desconhecida: itens não conferidos.' };
  const comprovantes = conferirComprovantes(secoes, opcoes.despesas || []);
  const pags = marcarRepetidas(paginas, conferirPaginas(secoes));
  const campos = camposNaoPreenchidos(paginas);
  const problemas = foraDoMes.length + itens.faltando.length + comprovantes.sem_comprovante_no_pdf.length
    + comprovantes.no_pdf_sem_liquidacao_no_mes.length + comprovantes.parcela_repetida.length + pags.em_branco.length + pags.repetidas.length + campos.length;
  return {
    competencia: comp.chave, mes: comp.rotulo, total_paginas: paginas.length, ok: problemas === 0, problemas,
    mes_fora: foraDoMes, itens, comprovantes, paginas_em_branco: pags.em_branco, paginas_repetidas: pags.repetidas, campos_nao_preenchidos: campos,
    secoes: resumirSecoes(secoes),
  };
}
// Resumo das seções para a tela (as 061A viram uma linha só com a contagem de parcelas).
function resumirSecoes(secoes) {
  const out = [];
  for (const s of secoes) {
    const ult = out[out.length - 1];
    if (s.codigo === '061A' && ult && ult.codigo === '061A') { ult.fim = s.fim; ult.parcelas += (s.parcela || s.movimentacao) ? 1 : 0; continue; }
    out.push({ codigo: s.codigo, titulo: s.titulo, filtro: s.filtro.slice(0, 120), inicio: s.inicio, fim: s.fim, parcelas: s.codigo === '061A' ? 1 : undefined });
  }
  return out.map((s) => Object.assign(s, { paginas: s.fim - s.inicio + 1 }));
}

// ── Superlógica (só GET) ──────────────────────────────────────────────────
const sl = (d) => String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0') + '/' + d.getUTCFullYear();
const RX_900A = /^900A\b/;
// Mês corrente no horário de Brasília ('AAAA-MM').
function mesAtualBrasilia(agora) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(agora || new Date());
  return p.find((x) => x.type === 'year').value + '-' + p.find((x) => x.type === 'month').value;
}

// Impressões do 900A de um mês: geradas do 1º dia do mês da prestação até hoje (no máximo 6 páginas de 50).
async function listarImpressoes(cliente, idCondominio, comp, agora) {
  const c = competencia(comp);
  if (!c) throw Object.assign(new Error('competencia_invalida'), { codigo: 'competencia' });
  const ini = new Date(Date.UTC(c.ano, c.mes - 1, 1));
  const fim = new Date((agora || new Date()).getTime() + 24 * 3600 * 1000);
  if (ini > fim) throw Object.assign(new Error('competencia_futura'), { codigo: 'competencia' });
  const out = [];
  for (let pg = 1; pg <= 6; pg++) {
    const j = await cliente.get('impressoes/index', { idCondominio, dtInicio: sl(ini), dtFim: sl(fim), itensPorPagina: 50, pagina: pg });
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : null);
    if (!arr) break;
    for (const d of arr) {
      if (!d || String(d.id_empresa_emp) !== String(idCondominio) || !RX_900A.test(String(d.st_titulo_fimp || ''))) continue;
      const mesDesc = /M[eê]s\s+(\d{2})\/(\d{4})/i.exec(String(d.st_descricao_fimp || ''));
      const daComp = mesDesc ? (mesDesc[2] + '-' + mesDesc[1]) === c.chave : false;
      out.push({
        id: String(d.id_impressao_fimp), titulo: limpar(d.st_titulo_fimp).slice(0, 120), criado_em: limpar(d.dt_criacao_fimp),
        descricao: limpar(d.st_descricao_fimp).slice(0, 60), da_competencia: daComp,
        publicado: String(d.fl_publicadopara_impr || '') !== '' && String(d.fl_publicadopara_impr) !== '0',
        usuario: limpar(d.st_nome_usu).slice(0, 80),
      });
    }
    if (arr.length < 50) break;
  }
  return out.sort((a, b) => Number(b.id) - Number(a.id));
}

// Despesas liquidadas no mês (uma linha por parcela), paginado de 50 em 50.
async function despesasLiquidadas(cliente, idCondominio, comp) {
  const c = competencia(comp);
  const ini = new Date(Date.UTC(c.ano, c.mes - 1, 1));
  const fim = new Date(Date.UTC(c.ano, c.mes, 0));
  const out = [];
  for (let pg = 1; pg <= 60; pg++) {
    const j = await cliente.get('despesas/index', { idCondominio, status: 'liquidadas', comStatus: 'liquidadas', filtrarpor: 'liquidacao', dtInicio: sl(ini), dtFim: sl(fim), itensPorPagina: 50, pagina: pg });
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : null);
    if (!arr) throw Object.assign(new Error('despesas_ilegiveis'), { status: 502 });
    for (const d of arr) {
      if (!d || !d.id_parcela_pdes || String(d.id_condominio_cond || idCondominio) !== String(idCondominio)) continue;
      const arquivos = (Array.isArray(d.arquivos) ? d.arquivos : []).filter((a) => a && String(a.fl_excluido_arq || '0') !== '1').length;
      out.push({ id_parcela: String(d.id_parcela_pdes), id_despesa: String(d.id_despesa_des || ''), fornecedor: limpar(d.st_nome_con || d.st_fantasia_con).slice(0, 80),
        valor: Number(d.vl_valor_pdes) || 0, liquidacao: limpar(d.dt_liquidacao_pdes).slice(0, 10), arquivos });
    }
    if (arr.length < 50) break;
  }
  return out;
}

// Itens esperados conforme a seleção que gerou a impressão (pelo título "900A - <nome da seleção>").
// Seleção NOVA (pessoal, a API não devolve os itens): ITENS_NOVA. Seleções fixas do condomínio:
// lidas em relatoriosselecao/index. Seleção desconhecida: null (itens não conferidos).
const SELECOES_FIXAS = { 'prestacao de contas': '1', 'prestacao de contas resumida': '2', 'prestacao de contas anual': '3', 'prestacao de contas na web': '4', 'prestacao de contas no boleto': '5', 'prestacao de contas da administracao': '11' };
async function itensEsperados(cliente, idCondominio, titulo) {
  const nome = semAcento(String(titulo || '').replace(/^900A\s*-?\s*/i, '')).toLowerCase().replace(/\s+/g, ' ').trim();
  if (/nova teste hub/.test(nome)) return ITENS_NOVA;
  if (!nome) return /^usuario:1$/.test(String(process.env.BALANCETE_SELECAO || 'usuario:1')) ? ITENS_NOVA : null;
  const idSel = SELECOES_FIXAS[nome];
  if (!idSel) return null;
  const j = await cliente.get('relatoriosselecao/index', { ID_EMPRESA_RLS: idCondominio, ID_SELECAO_RLS: idSel });
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : null);
  if (!arr || !arr.length) return null;
  return arr.slice().sort((a, b) => Number(a.nm_ordenacao_rls) - Number(b.nm_ordenacao_rls)).map((x) => {
    const u = String(x.st_url_rls || '');
    const cod = (/\/id\/(\d{3}[A-Z])/.exec(u) || [])[1] || '';
    let tit = '';
    try { tit = cod === '035C' ? (new URL(u, 'https://x.superlogica.net').searchParams.get('TITULO') || '') : ''; } catch (e) { tit = ''; }
    return { codigo: cod, titulo: tit, rotulo: cod + (tit ? ' Capa ' + tit : '') };
  }).filter((x) => x.codigo);
}

// Baixa o PDF de uma impressão para um arquivo temporário. documentos/download devolve 302 para o
// armazenamento do Superlógica; só segue para https em *.superlogica.com ou *.superlogica.net, e as
// chaves vão só no primeiro pedido (api.superlogica.net). Teto de tamanho e de tempo total.
const MAX_PDF = Math.min(600, Math.max(10, Number(process.env.BALANCETE_PDF_MAX_MB) || 400)) * 1024 * 1024;
const TEMPO_DOWNLOAD_MS = 8 * 60 * 1000;
const HOST_ARMAZENAMENTO = /(^|\.)superlogica\.(com|net)$/i;
function baixarImpressao({ base, appToken, accessToken }, id, destino) {
  if (!/^\d{1,12}$/.test(String(id))) return Promise.reject(Object.assign(new Error('id_invalido'), { codigo: 'id' }));
  return new Promise((ok, falha) => {
    let acabou = false, req = null, escrita = null;
    const fim = (e, v) => {
      if (acabou) return;
      acabou = true; clearTimeout(prazo);
      if (e) { try { if (req) req.destroy(); } catch (x) { /* nada */ } try { if (escrita) escrita.destroy(); } catch (x) { /* nada */ } }
      // Só resolve depois que o arquivo fechou: quem chama pode apagar a pasta sem escrita pendente.
      const fechar = (cb) => (escrita && !escrita.closed ? escrita.once('close', cb) : cb());
      fechar(() => (e ? falha(e) : ok(v)));
    };
    const prazo = setTimeout(() => fim(Object.assign(new Error('tempo_esgotado'), { status: 504 })), TEMPO_DOWNLOAD_MS);
    const pedir = (url, headers, saltos) => {
      let u;
      try { u = new URL(url); } catch (e) { return fim(Object.assign(new Error('destino_invalido'), { status: 502 })); }
      if (u.protocol !== 'https:' || !HOST_ARMAZENAMENTO.test(u.hostname)) return fim(Object.assign(new Error('destino_nao_permitido'), { status: 502 }));
      req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', headers }, (resp) => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && saltos > 0) {
          resp.resume();
          return pedir(new URL(resp.headers.location, url).toString(), {}, saltos - 1);
        }
        if (resp.statusCode !== 200) { resp.resume(); return fim(Object.assign(new Error('download_http_' + resp.statusCode), { status: resp.statusCode === 404 ? 404 : 502 })); }
        if (Number(resp.headers['content-length']) > MAX_PDF) { resp.resume(); return fim(Object.assign(new Error('pdf_grande_demais'), { codigo: 'pdf_grande_demais' })); }
        let n = 0;
        escrita = fs.createWriteStream(destino, { mode: 0o600 });
        resp.on('data', (c) => { n += c.length; if (n > MAX_PDF) fim(Object.assign(new Error('pdf_grande_demais'), { codigo: 'pdf_grande_demais' })); });
        resp.on('error', (e) => fim(e));
        escrita.on('error', (e) => fim(e));
        escrita.on('finish', () => fim(null, { bytes: n }));
        resp.pipe(escrita);
      });
      req.setTimeout(120000, () => fim(Object.assign(new Error('sem_resposta'), { status: 504 })));
      req.on('error', (e) => fim(Object.assign(e, { status: e.status || 504 })));
      req.end();
    };
    pedir(base + '/v2/condor/documentos/download?id=' + encodeURIComponent(id), { app_token: appToken, access_token: accessToken }, 3);
  });
}

// Memória do processo filho (Linux: /proc; Mac: ps).
function memoriaDe(pid) {
  return new Promise((ok) => {
    fs.readFile('/proc/' + pid + '/statm', 'utf8', (e, t) => {
      if (!e) return ok(Number(String(t).split(' ')[1]) * 4096 || 0);
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 }, (e2, out) => ok(e2 ? 0 : (Number(String(out).trim()) || 0) * 1024));
    });
  });
}
// Lê o PDF num processo separado, sem os segredos do servidor no ambiente, com teto de memória
// medido de fora (o PDF fica fora do heap do V8) e de tempo. Mata o filho se o servidor sair.
const MEMORIA_LEITOR = Math.max(300, Number(process.env.BALANCETE_LEITOR_MAX_MB) || 1200) * 1024 * 1024;
const filhosVivos = new Set();
process.once('exit', () => { for (const f of filhosVivos) { try { f.kill('SIGKILL'); } catch (e) { /* nada */ } } });
function lerPdf(caminho, { tempoMs = 10 * 60 * 1000 } = {}) {
  return new Promise((ok, falha) => {
    let filho;
    try {
      filho = spawn(process.execPath, [path.join(__dirname, 'balancete-pdf-worker.js'), caminho, String(MAX_PDF)], {
        stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH || '', NODE_PATH: process.env.NODE_PATH || '', NODE_ENV: process.env.NODE_ENV || '' },
      });
    } catch (e) { return falha(Object.assign(new Error('leitor_nao_subiu'), { codigo: 'leitura' })); }
    filhosVivos.add(filho);
    const paginas = [];
    let resto = '', fimLeitura = null, erro = null, acabou = false, medindo = false;
    const acabar = (motivo) => {
      if (motivo && !erro) erro = motivo;
      try { if (filho.exitCode === null) filho.kill('SIGKILL'); } catch (e) { /* nada */ }
    };
    const relogio = setTimeout(() => acabar('tempo_esgotado'), tempoMs);
    const vigia = setInterval(async () => {
      if (medindo || acabou) return;
      medindo = true;
      const m = await memoriaDe(filho.pid);
      medindo = false;
      if (m > MEMORIA_LEITOR) acabar('memoria');
    }, 500);
    filho.stdout.on('data', (c) => {
      resto += c.toString('utf8');
      if (resto.length > 50 * 1024 * 1024) return acabar('saida_grande');
      let i;
      while ((i = resto.indexOf('\n')) >= 0) {
        const l = resto.slice(0, i); resto = resto.slice(i + 1);
        try { const o = JSON.parse(l); if (o.pagina) paginas.push(o); else if (o.fim) fimLeitura = o; else if (o.erro) erro = erro || o.erro; } catch (e) { /* linha quebrada */ }
      }
    });
    const encerrar = () => {
      if (acabou) return;
      acabou = true; clearTimeout(relogio); clearInterval(vigia); filhosVivos.delete(filho);
      if (erro || !fimLeitura) return falha(Object.assign(new Error(erro || 'leitura_incompleta'), { codigo: erro === 'pdf_grande_demais' ? 'pdf_grande_demais' : 'leitura' }));
      ok({ paginas, total: fimLeitura.paginas, lidas: fimLeitura.lidas });
    };
    filho.on('error', () => { erro = erro || 'leitor_nao_subiu'; encerrar(); });
    filho.on('close', encerrar);
  });
}

// ── geração do 900A (sem publicar) ─────────────────────────────────────────
// Só para condomínio da lista BALANCETE_GERACAO_LIBERADA (padrão: Victoria Bay 94 e Residencial
// Teste 167; 143, 144, 145, 160 e 162 nunca). Pede pela API v2 o mesmo que a tela pede ao clicar em
// Visualizar: relatorios/id/900A com render=pdf e getId=1 (cria a impressão só para a administração,
// sem publicar e sem envio por email). O Superlógica leva cerca de 3 minutos num 900A grande e o
// gateway corta em 60 s (HTTP 504), então o pedido é disparado uma vez e a tela acompanha a lista.
// Nunca chama impressoes/post (compartilhar) nem impressoes/email.
const EXCLUIDOS = new Set(['143', '144', '145', '160', '162']);
function liberadosGeracao() {
  const v = process.env.BALANCETE_GERACAO_LIBERADA;
  const lista = (v == null || v === '' ? '94,167' : v).split(',').map((x) => x.trim()).filter((x) => /^\d{1,9}$/.test(x) && !EXCLUIDOS.has(x));
  return new Set(lista);
}
// Seleção usada na geração: "usuario:<id>" (MINHA SELEÇÃO) ou "condominio:<id>" (seleção do condomínio).
// O padrão (usuario:1) é a "Prestação de contas na Web NOVA teste Hub", que fica no Superlógica e
// pode ser editada lá: a conferência mostra se algo mudou.
function selecaoGeracao() {
  const m = /^(usuario|condominio):(\d{1,6})$/.exec(String(process.env.BALANCETE_SELECAO || 'usuario:1'));
  if (!m) return { ID_RELATORIOSELECAO_RLSU: '1' };
  return m[1] === 'usuario' ? { ID_RELATORIOSELECAO_RLSU: m[2] } : { ID_SELECAO_RLS: m[2] };
}
const pedidosGeracao = new Map(); // "id|AAAA-MM" -> horário do último pedido (trava de 15 minutos)
const TRAVA_GERACAO_MS = 15 * 60 * 1000;
function pedirGeracao({ base, appToken, accessToken }, idCondominio, comp) {
  const c = competencia(comp);
  if (!c) return Promise.reject(Object.assign(new Error('competencia_invalida'), { codigo: 'competencia' }));
  // Só mês já fechado: o mês corrente ainda está aberto.
  if (c.chave >= mesAtualBrasilia()) return Promise.reject(Object.assign(new Error('mes_aberto'), { codigo: 'mes_aberto' }));
  const id = String(idCondominio);
  if (!liberadosGeracao().has(id)) return Promise.reject(Object.assign(new Error('geracao_nao_liberada'), { codigo: 'nao_liberado' }));
  const agora = Date.now();
  for (const [k, t0] of pedidosGeracao) if (agora - t0 >= TRAVA_GERACAO_MS) pedidosGeracao.delete(k);
  const chave = id + '|' + c.chave;
  const ultimo = pedidosGeracao.get(chave);
  if (ultimo) return Promise.reject(Object.assign(new Error('geracao_em_andamento'), { codigo: 'em_andamento', desde: new Date(ultimo).toISOString() }));
  pedidosGeracao.set(chave, agora);
  const q = Object.assign({ ID_CONDOMINIO_COND: id }, selecaoGeracao(), {
    DT_PADRAO_REL: String(c.mes).padStart(2, '0') + '/01/' + c.ano, NAO_PULAR_PAGINA_ENTRE_RELATORIOS: '0', NAO_EXIBIR_LINK_ANEXOS: '0', render: 'pdf', getId: '1',
  });
  const u = new URL(base + '/v2/condor/relatorios/id/900A');
  Object.entries(q).forEach(([k, v]) => u.searchParams.set(k, v));
  return new Promise((ok) => {
    const r = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', headers: { app_token: appToken, access_token: accessToken, accept: 'application/json' } }, (resp) => {
      const p = []; resp.on('data', (x) => { if (p.length < 20) p.push(x); });
      resp.on('end', () => {
        let idImp = '';
        try { const j = JSON.parse(Buffer.concat(p).toString('utf8')); const it = Array.isArray(j) ? j[0] : j; idImp = String((it && (it.id_impressao || (it.data && it.data.id_impressao))) || ''); } catch (e) { /* 504 vem em texto */ }
        ok({ pedido: true, http: resp.statusCode, id_impressao: /^\d+$/.test(idImp) ? idImp : '', aguardar: !/^\d+$/.test(idImp) });
      });
    });
    // Não fica pendurado: o Superlógica continua gerando mesmo se a ligação cair.
    r.setTimeout(90000, () => { r.destroy(); ok({ pedido: true, http: 0, id_impressao: '', aguardar: true }); });
    r.on('error', () => ok({ pedido: true, http: 0, id_impressao: '', aguardar: true }));
    r.end();
  });
}

// ── conferência de uma impressão (uma por vez, resultado guardado 6 horas) ───
// Baixar e ler um 900A grande leva cerca de 1 a 2 minutos: a rota dispara e a tela pergunta de novo.
// O resultado é guardado por condomínio, mês e impressão: um pedido errado não atrapalha o certo.
const resultados = new Map(); // "cond|AAAA-MM|impressao" -> { estado, inicio, fim, resultado, erro }
const VALIDADE_MS = 6 * 60 * 60 * 1000;
let emAndamento = null;
const chaveRes = (idCondominio, comp, idImpressao) => String(idCondominio) + '|' + String(comp) + '|' + String(idImpressao);
function limparVencidos() {
  const agora = Date.now();
  for (const [k, r] of resultados) if (r.estado !== 'rodando' && agora - r.fim > VALIDADE_MS) resultados.delete(k);
}
function situacaoConferencia(idCondominio, comp, idImpressao) {
  limparVencidos();
  return resultados.get(chaveRes(idCondominio, comp, idImpressao)) || null;
}
// cred: { base, appToken, accessToken }; cliente: cliente GET (superlogica-dados.criarCliente)
function iniciarConferencia({ cred, cliente, idCondominio, competencia: comp, idImpressao, log, forcar }) {
  const id = String(idImpressao);
  const chave = chaveRes(idCondominio, comp, id);
  const atual = situacaoConferencia(idCondominio, comp, id);
  if (atual && (atual.estado === 'rodando' || (atual.estado === 'pronto' && !forcar))) return atual;
  if (emAndamento) return { estado: 'ocupado', detalhe: 'Outra conferência está rodando.' };
  const reg = { estado: 'rodando', inicio: Date.now(), id_condominio: String(idCondominio), competencia: comp, id_impressao: id };
  resultados.set(chave, reg);
  emAndamento = chave;
  let tmp = null;
  (async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'balancete-'));
    const arq = path.join(tmp, 'impressao.pdf');
    const lista = await listarImpressoes(cliente, idCondominio, comp);
    const imp = lista.find((x) => x.id === id);
    if (!imp) throw Object.assign(new Error('impressao_nao_encontrada'), { codigo: 'nao_encontrada' });
    if (!imp.da_competencia) throw Object.assign(new Error('impressao_de_outro_mes'), { codigo: 'outro_mes' });
    // Espera os dois terminarem antes de seguir ou falhar: nada fica gravando depois da limpeza.
    const [baixado, despesas, esperados] = await Promise.allSettled([baixarImpressao(cred, id, arq), despesasLiquidadas(cliente, idCondominio, comp), itensEsperados(cliente, idCondominio, imp.titulo)]);
    if (baixado.status === 'rejected') throw baixado.reason;
    if (despesas.status === 'rejected') throw despesas.reason;
    const lido = await lerPdf(arq);
    const resultado = conferir(lido.paginas, { competencia: comp, despesas: despesas.value, esperados: esperados.status === 'fulfilled' ? esperados.value : null });
    resultado.impressao = imp;
    resultado.bytes = baixado.value.bytes;
    resultado.paginas_lidas = lido.lidas;
    if (lido.lidas < lido.total) { resultado.ok = false; resultado.aviso = 'Só ' + lido.lidas + ' de ' + lido.total + ' páginas foram lidas.'; }
    return resultado;
  })().then((resultado) => {
    Object.assign(reg, { estado: 'pronto', fim: Date.now(), resultado });
  }).catch((e) => {
    Object.assign(reg, { estado: 'erro', fim: Date.now(), erro: (e && (e.codigo || e.message)) || 'falha' });
    if (log) log('[balancete] conferência ' + id + ' falhou: ' + (e && e.message));
  }).finally(() => {
    emAndamento = null;
    if (tmp) fs.rm(tmp, { recursive: true, force: true }, () => {});
  });
  return reg;
}

module.exports = {
  competencia, somarMeses, mesesCitados, classificarPagina, montarSecoes, conferirMesSecao, conferirItens, conferirComprovantes,
  conferirPaginas, camposNaoPreenchidos, marcarRepetidas, conferir, resumirSecoes, ITENS_NOVA, EXCLUIDOS, mesAtualBrasilia,
  listarImpressoes, despesasLiquidadas, itensEsperados, baixarImpressao, lerPdf, liberadosGeracao, selecaoGeracao, pedirGeracao,
  iniciarConferencia, situacaoConferencia,
};
