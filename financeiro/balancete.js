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
const { spawn } = require('child_process');

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
  if (ano < 2015 || ano > 2100 || mes < 1 || mes > 12) return null;
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
  const reAbrev = /\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\s*(?:\/|de)\s*(\d{4})\b/gi;
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
  const out = { pagina: p.pagina, imagens: Number(p.imagens) || 0, desenhos: Number(p.desenhos) || 0, chars: ls.join(' ').length };
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
function conferirMesSecao(s, comp) {
  const citados = mesesCitados(s.filtro);
  if (!citados.length) return null; // sem período no cabeçalho (carta, parecer): nada a conferir
  if (s.codigo === '011A') {
    const ini = somarMeses(comp, -11);
    const primeira = citados[0];
    const m = /pr[oó]ximos\s+(\d+)\s+meses/i.exec(s.filtro);
    const qtd = m ? Number(m[1]) : 0;
    if (primeira === ini.chave && qtd === 11) return null;
    const ultima = primeira && qtd ? somarMeses(competencia(primeira), qtd) : null;
    return { esperado: ini.rotulo + ' a ' + comp.rotulo, achado: (competencia(primeira) || {}).rotulo + (ultima ? ' a ' + ultima.rotulo : '') };
  }
  if (ANUAIS.has(s.codigo)) {
    const ultimo = citados.slice().sort().pop();
    if (ultimo === comp.chave) return null;
    return { esperado: 'até ' + comp.rotulo, achado: 'até ' + ((competencia(ultimo) || {}).rotulo || ultimo) };
  }
  const fora = [...new Set(citados.filter((c) => c !== comp.chave))];
  if (!fora.length) return null;
  return { esperado: comp.rotulo, achado: fora.map((c) => (competencia(c) || {}).rotulo || c).join(', ') };
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
      if (p.tipo === 'vazia' && !p.imagens && p.desenhos < 3) emBranco.push({ pagina: p.pagina, motivo: 'página sem conteúdo' });
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
// devolve os itens de uma seleção pessoal; para seleção do condomínio, itensDaSelecao lê da API.
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
  const itens = conferirItens(secoes, opcoes.esperados || ITENS_NOVA);
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
// "10/21/2026 14:52:59" -> Date (horário de Brasília)
function dataSL(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], (+m[4] || 0) + 3, +m[5] || 0, +m[6] || 0)) : null;
}

// Impressões do 900A de um mês: geradas do 1º dia do mês da prestação até hoje (no máximo 6 páginas de 50).
async function listarImpressoes(cliente, idCondominio, comp, agora) {
  const c = competencia(comp);
  if (!c) throw Object.assign(new Error('competencia_invalida'), { codigo: 'competencia' });
  const ini = new Date(Date.UTC(c.ano, c.mes - 1, 1));
  const fim = agora || new Date();
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

// Baixa o PDF de uma impressão para um arquivo temporário. documentos/download devolve 302 para o
// armazenamento do Superlógica; só segue para https em *.superlogica.com ou *.superlogica.net, sem as chaves.
const MAX_PDF = Number(process.env.BALANCETE_PDF_MAX_MB || 600) * 1024 * 1024;
const HOST_ARMAZENAMENTO = /(^|\.)superlogica\.(com|net)$/i;
function baixarImpressao({ base, appToken, accessToken }, id, destino) {
  if (!/^\d{1,12}$/.test(String(id))) return Promise.reject(Object.assign(new Error('id_invalido'), { codigo: 'id' }));
  const pedir = (url, headers, saltos) => new Promise((ok, falha) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !HOST_ARMAZENAMENTO.test(u.hostname)) return falha(Object.assign(new Error('destino_nao_permitido'), { status: 502 }));
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && saltos > 0) {
        resp.resume();
        return pedir(new URL(resp.headers.location, url).toString(), {}, saltos - 1).then(ok, falha);
      }
      if (resp.statusCode !== 200) { resp.resume(); return falha(Object.assign(new Error('download_http_' + resp.statusCode), { status: resp.statusCode === 404 ? 404 : 502 })); }
      let n = 0;
      const w = fs.createWriteStream(destino, { mode: 0o600 });
      resp.on('data', (c) => { n += c.length; if (n > MAX_PDF) { resp.destroy(); w.destroy(); falha(Object.assign(new Error('pdf_grande_demais'), { status: 413 })); } });
      resp.pipe(w);
      w.on('finish', () => ok({ bytes: n }));
      w.on('error', (e) => falha(e));
      resp.on('error', (e) => falha(e));
    });
    r.setTimeout(300000, () => r.destroy(new Error('tempo_esgotado')));
    r.on('error', (e) => falha(Object.assign(e, { status: e.status || 504 })));
    r.end();
  });
  return pedir(base + '/v2/condor/documentos/download?id=' + encodeURIComponent(id), { app_token: appToken, access_token: accessToken }, 3);
}

// Lê o PDF num processo separado com teto de memória e de tempo; devolve as páginas.
function lerPdf(caminho, { tempoMs = 10 * 60 * 1000, memoriaMb = 1536 } = {}) {
  return new Promise((ok, falha) => {
    const filho = spawn(process.execPath, ['--max-old-space-size=' + memoriaMb, path.join(__dirname, 'balancete-pdf-worker.js'), caminho], { stdio: ['ignore', 'pipe', 'ignore'] });
    const paginas = [];
    let resto = '', fim = null, erro = null;
    const relogio = setTimeout(() => { erro = 'tempo_esgotado'; filho.kill('SIGKILL'); }, tempoMs);
    filho.stdout.on('data', (c) => {
      resto += c.toString('utf8');
      let i;
      while ((i = resto.indexOf('\n')) >= 0) {
        const l = resto.slice(0, i); resto = resto.slice(i + 1);
        try { const o = JSON.parse(l); if (o.pagina) paginas.push(o); else if (o.fim) fim = o; else if (o.erro) erro = o.erro; } catch (e) { /* linha quebrada */ }
      }
    });
    filho.on('close', () => {
      clearTimeout(relogio);
      if (erro || !fim) return falha(Object.assign(new Error(erro || 'leitura_incompleta'), { codigo: 'leitura' }));
      ok({ paginas, total: fim.paginas, lidas: fim.lidas });
    });
  });
}

// ── geração do 900A (sem publicar) ─────────────────────────────────────────
// Só para condomínio da lista BALANCETE_GERACAO_LIBERADA (padrão: Victoria Bay 94 e Residencial
// Teste 167). Pede pela API v2 o mesmo que a tela pede ao clicar em Visualizar: relatorios/id/900A
// com render=pdf e getId=1 (cria a impressão só para a administração, sem publicar e sem e-mail).
// O Superlógica leva cerca de 3 minutos num 900A grande e o gateway corta em 60 s (HTTP 504), então
// o pedido é disparado uma vez e a tela acompanha a lista de impressões.
// Nunca chama impressoes/post (compartilhar) nem impressoes/email.
function liberadosGeracao() {
  const v = process.env.BALANCETE_GERACAO_LIBERADA;
  const lista = (v == null || v === '' ? '94,167' : v).split(',').map((x) => x.trim()).filter((x) => /^\d{1,9}$/.test(x) && !EXCLUIDOS.has(x));
  return new Set(lista);
}
// Seleção usada na geração: "usuario:<id>" (MINHA SELEÇÃO) ou "condominio:<id>" (seleção do condomínio).
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
  const id = String(idCondominio);
  if (!liberadosGeracao().has(id)) return Promise.reject(Object.assign(new Error('geracao_nao_liberada'), { codigo: 'nao_liberado' }));
  const chave = id + '|' + c.chave;
  const ultimo = pedidosGeracao.get(chave);
  if (ultimo && Date.now() - ultimo < TRAVA_GERACAO_MS) return Promise.reject(Object.assign(new Error('geracao_em_andamento'), { codigo: 'em_andamento', desde: new Date(ultimo).toISOString() }));
  pedidosGeracao.set(chave, Date.now());
  const q = Object.assign({ ID_CONDOMINIO_COND: id }, selecaoGeracao(), {
    DT_PADRAO_REL: String(c.mes).padStart(2, '0') + '/01/' + c.ano, NAO_PULAR_PAGINA_ENTRE_RELATORIOS: '0', NAO_EXIBIR_LINK_ANEXOS: '0', render: 'pdf', getId: '1',
  });
  const u = new URL(base + '/v2/condor/relatorios/id/900A');
  Object.entries(q).forEach(([k, v]) => u.searchParams.set(k, v));
  return new Promise((ok) => {
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { app_token: appToken, access_token: accessToken, accept: 'application/json' } }, (resp) => {
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
const EXCLUIDOS = new Set(['143', '144', '145', '160', '162']);
const resultados = new Map(); // id da impressão -> { estado, inicio, fim, resultado, erro, id_condominio, competencia }
const VALIDADE_MS = 6 * 60 * 60 * 1000;
let emAndamento = null;
function situacaoConferencia(idImpressao) {
  const r = resultados.get(String(idImpressao));
  if (r && r.estado !== 'rodando' && Date.now() - r.fim > VALIDADE_MS) { resultados.delete(String(idImpressao)); return null; }
  return r || null;
}
// cred: { base, appToken, accessToken }; cliente: cliente GET (superlogica-dados.criarCliente)
function iniciarConferencia({ cred, cliente, idCondominio, competencia: comp, idImpressao, log, forcar }) {
  const id = String(idImpressao);
  const atual = situacaoConferencia(id);
  if (atual && (atual.estado === 'rodando' || (atual.estado === 'pronto' && !forcar))) return atual;
  if (emAndamento) return { estado: 'ocupado', detalhe: 'Outra conferência está rodando (impressão ' + emAndamento + ').' };
  const reg = { estado: 'rodando', inicio: Date.now(), id_condominio: String(idCondominio), competencia: comp, id_impressao: id };
  resultados.set(id, reg);
  emAndamento = id;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'balancete-'));
  const arq = path.join(tmp, 'impressao.pdf');
  (async () => {
    const lista = await listarImpressoes(cliente, idCondominio, comp);
    const imp = lista.find((x) => x.id === id);
    if (!imp) throw Object.assign(new Error('impressao_nao_encontrada'), { codigo: 'nao_encontrada' });
    const [baixado, despesas] = await Promise.all([baixarImpressao(cred, id, arq), despesasLiquidadas(cliente, idCondominio, comp)]);
    const lido = await lerPdf(arq);
    const resultado = conferir(lido.paginas, { competencia: comp, despesas });
    resultado.impressao = imp;
    resultado.bytes = baixado.bytes;
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
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  });
  return reg;
}

module.exports = {
  competencia, somarMeses, mesesCitados, classificarPagina, montarSecoes, conferirMesSecao, conferirItens, conferirComprovantes,
  conferirPaginas, camposNaoPreenchidos, marcarRepetidas, conferir, resumirSecoes, ITENS_NOVA, EXCLUIDOS,
  listarImpressoes, despesasLiquidadas, baixarImpressao, lerPdf, liberadosGeracao, selecaoGeracao, pedirGeracao,
  iniciarConferencia, situacaoConferencia, dataSL,
};
