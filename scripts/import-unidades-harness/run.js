#!/usr/bin/env node
/*
 * Harness do roteador de estrutura + parsers do painel Importar Unidades
 * (public/index.html). Roda as funcoes REAIS extraidas ao vivo do HTML
 * (extrai-motor.js) contra as 7 amostras reais do Matheus e imprime, por
 * arquivo: familia detectada, linhas na origem, unidades geradas, pessoas
 * geradas por papel (proprietario/inquilino/dependente/descartado) e linhas
 * com erro (com o motivo). Se algum numero de referencia nao bater, marca
 * FAIL.
 *
 * LGPD/tenant: as 7 planilhas reais NAO ficam neste repositorio (dados de
 * cliente). O harness le direto de ~/Downloads (ou do dir informado por
 * IMPORT_UNIDADES_FIXTURES_DIR). O .xls do Quattro precisa de conversao pra
 * .xlsx (via LibreOffice `soffice`, ja disponivel na maquina) porque o
 * pacote xlsx do Node le .xls antigo com falhas de layout; a copia
 * convertida fica na pasta scratch (fora do repo, nunca commitada).
 *
 * Os 2 PDFs W045A nao passam pelo caminho de codigo puro deste harness: se a
 * extracao tabular vier suja, o comportamento esperado do produto e cair no
 * fallback "Normalizar via IA" (ver processarPdfUnidades/extrairTextoPdf em
 * public/index.html, que dependem de pdf.js no navegador). O harness so
 * confirma que o arquivo e PDF e registra esse fallback esperado — nao e
 * FAIL, e o comportamento correto documentado no plano.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');
const vm = require('vm');
const XLSX = require('xlsx');
const { criarContexto } = require('./shims');

const DIR_HARNESS = __dirname;
const MOTOR_PATH = path.join(DIR_HARNESS, 'motor-extraido.js');
const FIXTURES_DIR = process.env.IMPORT_UNIDADES_FIXTURES_DIR || path.join(os.homedir(), 'Downloads');
const SCRATCH_DIR = process.env.IMPORT_UNIDADES_SCRATCH_DIR ||
  path.join(os.tmpdir(), 'import-unidades-harness-scratch');

// Amostras reais + numeros de referencia (ver tarefas/em-andamento/roteador-import-unidades.md,
// secao HARNESS). "esperado" e null quando o numero exato de unidades nao esta
// fechado no doc (o harness ainda assim imprime o resultado obtido).
const CASOS = [
  { arquivo: 'Cadastro moradores.xlsx', familiaEsperada: 'plana', linhasOrigemEsperada: 313 },
  { arquivo: 'CADASTRO 2º ETAPA (1).xlsx', familiaEsperada: 'proponentes', linhasOrigemEsperada: 224 },
  { arquivo: 'Cadastro das unidades - COMERCIAL (4).xlsx', familiaEsperada: 'w045a-contatos', linhasOrigemEsperada: null },
  { arquivo: 'Cadastro das unidades - RESIDENCIAL (3).xlsx', familiaEsperada: 'w045a-contatos', linhasOrigemEsperada: null },
  { arquivo: 'unidades_quattro_residencial_clube (3).xls', familiaEsperada: 'quattro', linhasOrigemEsperada: 528, precisaConversao: true },
  { arquivo: 'Cadastro de Proprietários (2).pdf', pdf: true },
  { arquivo: 'Cadastro das unidades (6).pdf', pdf: true },
];

// Converte um .xls antigo pra .xlsx via LibreOffice headless, escrevendo na
// pasta scratch (fora do repo). Reaproveita a copia se ja existir e for mais
// nova que o .xls original, pra nao rodar o soffice a cada execucao do harness.
function converterXlsParaXlsx(caminhoXls) {
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  const nomeBase = path.basename(caminhoXls, path.extname(caminhoXls));
  const caminhoXlsx = path.join(SCRATCH_DIR, nomeBase + '.xlsx');
  const precisaGerar = !fs.existsSync(caminhoXlsx) ||
    fs.statSync(caminhoXlsx).mtimeMs < fs.statSync(caminhoXls).mtimeMs;
  if (precisaGerar) {
    execFileSync('soffice', ['--headless', '--convert-to', 'xlsx', '--outdir', SCRATCH_DIR, caminhoXls], { stdio: 'pipe' });
  }
  return caminhoXlsx;
}

// Le a planilha (xlsx ja convertido se necessario) e devolve todas as linhas
// cruas. C1: mesma leitura robusta do navegador (raw:true + normalizarCelula,
// a funcao REAL extraida do proprio index.html via ctx), pra nao perder
// digitos de CNPJ/CPF/telefone/RG/CEP longos que raw:false formatava em
// notacao cientifica (root cause do PJ excluido). O harness e o navegador tem
// que ler igual.
function lerLinhasCru(ctx, caminho) {
  const wb = XLSX.readFile(caminho, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  return allRows.map((row) => (row || []).map((v) => ctx.normalizarCelula(v)));
}

// Roda o MESMO roteador que processFile usa em public/index.html: detecta
// cabecalho, classifica familia, delega ao parser certo e converte pra lista
// plana de contatos (mesmo shape usado pela tela de revisao). Devolve tambem
// os metadados de diagnostico (familia, contagens de base) pro relatorio.
function rodarRoteador(ctx, allRows) {
  const headerIdx = ctx.detectarLinhaCabecalho(allRows);
  if (headerIdx === -1) return { erroFatal: 'cabecalho nao encontrado' };
  const headers = (allRows[headerIdx] || []).map((h) => String(h || '').trim());
  const linhasRestantes = allRows.slice(headerIdx + 1);
  const familia = ctx.detectarFamiliaPlanilha(headers);
  const linhasComConteudo = ctx.linhasComConteudoReal(linhasRestantes);

  if (familia === 'w045a-contatos') {
    const linhasCorrigidas = ctx.corrigirDeslocamentoW045A(headers, linhasRestantes);
    // C2: mesma validacao de documento por contato que processFile aplica no navegador.
    const contatos = ctx.validarDocumentosW045A(ctx.inferirPapeis(ctx.parseW045AContatos(headers, linhasCorrigidas)));
    return { familia, headerIdx, linhasOrigem: linhasComConteudo.length, contatos };
  }
  if (familia === 'unificado') {
    const processed = ctx.processUnidadesDataUnificada(headers, linhasComConteudo);
    // Formato unificado nao passa pela tela de revisao (ja e o alvo interno);
    // reaproveita unidadesAgrupadasParaContatos so pra uniformizar o relatorio do harness.
    const contatos = ctx.unidadesAgrupadasParaContatos(processed, 'Unificado');
    return { familia, headerIdx, linhasOrigem: linhasComConteudo.length, contatos };
  }
  const LABEL_FAMILIA = { quattro: 'Quattro', proponentes: 'Proponentes', plana: 'Plana' };
  if (LABEL_FAMILIA[familia]) {
    const agrupado = familia === 'quattro'
      ? ctx.validarUnidadesAgrupadas(ctx.processUnidadesData(headers, linhasComConteudo), false)
      : familia === 'proponentes'
        ? ctx.processFamiliaProponentes(headers, linhasComConteudo)
        : ctx.processFamiliaPlana(headers, linhasComConteudo);
    const contatos = ctx.unidadesAgrupadasParaContatos(agrupado, LABEL_FAMILIA[familia]);
    return { familia, headerIdx, linhasOrigem: linhasComConteudo.length, contatos };
  }
  return { familia: familia || '(nao reconhecida)', headerIdx, linhasOrigem: linhasComConteudo.length, contatos: [] };
}

// Agrega a lista plana de contatos nas mesmas contagens que renderRevisao
// mostra na tela (unidades, pessoas por papel, erros com motivo).
function calcularEstatisticas(contatos) {
  const unidades = new Set();
  let nProp = 0, nInq = 0, nDep = 0, nDesc = 0, nErro = 0, nPropPJ = 0;
  const errosPorMotivo = {};
  (contatos || []).forEach((c) => {
    if (c.papel !== 'descartar') unidades.add(c.unidade + '|' + c.bloco);
    if (c.papel === 'proprietario') {
      nProp++;
      // C1/prova (b): proprietario pessoa juridica com CNPJ COMPLETO (14
      // digitos). Antes do fix raw:true, numero grande virava notacao
      // cientifica truncada e caia fora tanto de isCPF quanto de isCNPJ,
      // entao esta contagem so fica correta com o conserto aplicado.
      if (/^\d{14}$/.test(String(c.cnpj || '').replace(/\D/g, ''))) nPropPJ++;
    }
    else if (c.papel === 'inquilino') nInq++;
    else if (c.papel === 'dependente') nDep++;
    else if (c.papel === 'descartar') nDesc++;
    if (c._valido === false) {
      nErro++;
      (c._erros || ['(sem motivo)']).forEach((m) => { errosPorMotivo[m] = (errosPorMotivo[m] || 0) + 1; });
    }
  });
  return {
    unidades: unidades.size, pessoas: (contatos || []).length,
    proprietarios: nProp, proprietariosPJ: nPropPJ, inquilinos: nInq, dependentes: nDep, descartados: nDesc,
    comErro: nErro, errosPorMotivo,
  };
}

function imprimirCaso(caso, resultado) {
  console.log(`\n=== ${caso.arquivo} ===`);
  if (resultado.pdf) {
    console.log('  PDF -> Normalizar via IA (comportamento esperado, nao passa pelo caminho de codigo puro)');
    return { ok: true };
  }
  if (resultado.erroFatal) {
    console.log(`  FAIL: ${resultado.erroFatal}`);
    return { ok: false };
  }
  const stats = calcularEstatisticas(resultado.contatos);
  const familiaOk = !caso.familiaEsperada || resultado.familia === caso.familiaEsperada;
  const linhasOk = caso.linhasOrigemEsperada == null || resultado.linhasOrigem === caso.linhasOrigemEsperada;
  console.log(`  familia detectada:    ${resultado.familia}${familiaOk ? '' : `  FAIL (esperado "${caso.familiaEsperada}")`}`);
  console.log(`  linhas na origem:     ${resultado.linhasOrigem}${caso.linhasOrigemEsperada != null ? (linhasOk ? '  (bate a referencia)' : `  FAIL (esperado ${caso.linhasOrigemEsperada})`) : ''}`);
  console.log(`  unidades geradas:     ${stats.unidades}`);
  console.log(`  pessoas geradas:      ${stats.pessoas} (proprietario ${stats.proprietarios} · inquilino ${stats.inquilinos} · dependente ${stats.dependentes} · descartado ${stats.descartados})`);
  console.log(`  proprietarios PJ:     ${stats.proprietariosPJ} (CNPJ completo, 14 digitos)`);
  console.log(`  linhas com erro:      ${stats.comErro}`);
  Object.keys(stats.errosPorMotivo).forEach((motivo) => {
    console.log(`    - ${motivo}: ${stats.errosPorMotivo[motivo]}`);
  });
  return { ok: familiaOk && linhasOk };
}

function main() {
  execFileSync('node', [path.join(DIR_HARNESS, 'extrai-motor.js')], { stdio: 'inherit' });
  execFileSync('node', ['--check', MOTOR_PATH], { stdio: 'inherit' });
  const codigoMotor = fs.readFileSync(MOTOR_PATH, 'utf8');

  const resumo = [];
  for (const caso of CASOS) {
    const caminhoOriginal = path.join(FIXTURES_DIR, caso.arquivo);
    if (!fs.existsSync(caminhoOriginal)) {
      console.log(`\n=== ${caso.arquivo} ===\n  FAIL: arquivo nao encontrado em ${FIXTURES_DIR}`);
      resumo.push({ arquivo: caso.arquivo, ok: false });
      continue;
    }
    if (caso.pdf) {
      const r = imprimirCaso(caso, { pdf: true });
      resumo.push({ arquivo: caso.arquivo, ok: r.ok });
      continue;
    }
    const ctx = criarContexto(); // contexto novo por fixture — sem vazamento de estado
    new vm.Script(codigoMotor, { filename: 'motor-extraido.js' }).runInContext(ctx);

    const caminhoLeitura = caso.precisaConversao ? converterXlsParaXlsx(caminhoOriginal) : caminhoOriginal;
    const allRows = lerLinhasCru(ctx, caminhoLeitura);
    const resultado = rodarRoteador(ctx, allRows);
    const r = imprimirCaso(caso, resultado);
    resumo.push({ arquivo: caso.arquivo, ok: r.ok });
  }

  console.log('\n=== RESUMO ===');
  for (const r of resumo) console.log(`${r.arquivo.padEnd(42)} ${r.ok ? 'PASSA' : 'FAIL'}`);
  const falhas = resumo.filter((r) => !r.ok).length;
  console.log(`\n${resumo.length - falhas}/${resumo.length} amostras batendo.`);
  process.exitCode = falhas ? 1 : 0;
}

main();
