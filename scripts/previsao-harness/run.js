#!/usr/bin/env node
/*
 * Harness de validacao do Modo A (planilha pronta) da Previsao Orcamentaria.
 * Roda a funcao REAL parsePlanilhaPronta (extraida ao vivo do previsao-modulo.html
 * por extrai-motor.js) contra as 5 planilhas fonte e compara o resultado, campo a
 * campo, contra os modelos_exemplo/*.json (numeros de aceitacao ja validados).
 *
 * Por que existe: antes deste harness, a unica forma de saber se o parser
 * acertava um condominio era abrir o navegador e conferir na mao. Isso automatiza
 * a checagem e vira regressao pros proximos gaps do Modo A.
 *
 * Nada sai do disco local: le as planilhas fonte e os modelos direto da pasta
 * do Matheus, nao envia nada pra rede nem grava dado de cliente em lugar nenhum.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vm = require('vm');
const XLSX = require('xlsx');
const { criarContexto } = require('./shims');

const DIR_HARNESS = __dirname;
const MOTOR_PATH = path.join(DIR_HARNESS, 'motor-extraido.js');
const FIXTURES_DIR = '/Users/matheusmelo/Downloads/projeto_previsao_orcamentaria 3/planilhas_fonte';
const MODELOS_DIR = '/Users/matheusmelo/Downloads/projeto_previsao_orcamentaria 3/modelos_exemplo';

const CASOS = [
  { xlsx: 'viamar.xlsx', modelo: 'viamar_model.json', apelido: 'Via Mar' },
  { xlsx: 'verde2.xlsx', modelo: 'verde_model.json', apelido: 'Reserva Verde' },
  { xlsx: 'serra.xlsx', modelo: 'serra_model.json', apelido: 'Serra' },
  { xlsx: 'camaras2.xlsx', modelo: 'camaras_model.json', apelido: 'Camaras' },
  { xlsx: 'caminhos.xlsx', modelo: 'caminho_model.json', apelido: 'Caminho' },
];

// Trunca (nao arredonda) o percentual pra 2 casas — mesma convencao da funcao
// pctt() da auditoria em previsao-modulo.html (Math.trunc(v*10000)/100).
function pctTrunc(v) {
  return Math.trunc((v || 0) * 10000) / 100;
}

function proximo(a, b, tol) {
  return Math.abs((a || 0) - (b || 0)) <= tol;
}

function fmtBRL(v) {
  return 'R$ ' + (v == null ? '—' : Number(v).toFixed(2));
}

function fmtPct(v) {
  return pctTrunc(v).toFixed(2) + '%';
}

// Compara duas listas de tipos de fracao (taxaAtual/taxaNova/fracao) item a
// item, na ordem em que cada lista vem (dentro de uma torre, ou na lista flat
// quando nao ha torre, a ordem e sempre por taxaNova desc — ver buildTipos).
function compararListaTipos(esperados, obtidos) {
  esperados = esperados || [];
  obtidos = obtidos || [];
  if (esperados.length !== obtidos.length) {
    return { ok: false, divergencias: [`quantidade diferente: esperado ${esperados.length}, obtido ${obtidos.length}`] };
  }
  const divergencias = [];
  for (let i = 0; i < esperados.length; i++) {
    const e = esperados[i], o = obtidos[i] || {};
    const fracaoOk = proximo(e.fracao, o.fracao, 1e-6);
    const atualOk = proximo(e.taxaAtual, o.taxaAtual, 0.01);
    const novaOk = proximo(e.taxaNova, o.taxaNova, 0.01);
    if (!fracaoOk || !atualOk || !novaOk) {
      divergencias.push(
        `#${i} ${e.tipo || ''}: esperado fracao=${e.fracao} taxaAtual=${e.taxaAtual} taxaNova=${e.taxaNova} | ` +
        `obtido fracao=${o.fracao} taxaAtual=${o.taxaAtual} taxaNova=${o.taxaNova}`
      );
    }
  }
  return { ok: divergencias.length === 0, divergencias };
}

// Quando o condominio tem torres (ex.: Via Mar), o modelo guarda a ordem
// por torre (rateioTorres), nao a lista "flat" global — a lista flat do
// modelo vem ordenada globalmente por taxaNova, enquanto o motor concatena
// torre a torre (cada torre ordenada por taxaNova dentro dela mesma). Por
// isso comparamos rateioTorres quando ele existe nos dois lados, e a lista
// flat (r.rateio.tipos) apenas quando nao ha torre.
function compararTipos(esperado, obtidoM) {
  if (Array.isArray(esperado.rateioTorres)) {
    const torresObtidas = obtidoM.rateioTorres || [];
    if (esperado.rateioTorres.length !== torresObtidas.length) {
      return { ok: false, detalhe: `torres diferentes: esperado ${esperado.rateioTorres.length}, obtido ${torresObtidas.length}` };
    }
    const divergenciasTotais = [];
    let totalTipos = 0;
    for (let i = 0; i < esperado.rateioTorres.length; i++) {
      const tE = esperado.rateioTorres[i];
      const tO = torresObtidas[i] || { torre: '(ausente)', tipos: [] };
      totalTipos += tE.tipos.length;
      if (tE.torre !== tO.torre) divergenciasTotais.push(`torre #${i}: esperado "${tE.torre}", obtido "${tO.torre}"`);
      const cmp = compararListaTipos(tE.tipos, tO.tipos);
      if (!cmp.ok) divergenciasTotais.push(`${tE.torre}: ${cmp.divergencias.slice(0, 2).join(' ; ')}`);
    }
    if (divergenciasTotais.length) {
      return { ok: false, detalhe: `${divergenciasTotais.length} torre(s) com divergencia — ${divergenciasTotais.slice(0, 3).join(' | ')}` };
    }
    return { ok: true, detalhe: `${totalTipos}/${totalTipos} tipos batendo (${esperado.rateioTorres.length} torres)` };
  }
  const cmp = compararListaTipos(esperado.r.rateio.tipos, obtidoM.r.rateio.tipos);
  if (!cmp.ok) {
    return { ok: false, detalhe: `${cmp.divergencias.length} divergentes — ${cmp.divergencias.slice(0, 3).join(' ; ')}` };
  }
  return { ok: true, detalhe: `${esperado.r.rateio.tipos.length}/${esperado.r.rateio.tipos.length} tipos batendo` };
}

// Monta a linha-resumo de um campo pra tabela impressa no terminal.
function linhaCampo(nome, esperadoTxt, obtidoTxt, ok) {
  return { campo: nome, esperado: esperadoTxt, obtido: obtidoTxt, resultado: ok ? 'PASSA' : 'FALHA' };
}

// Roda a comparacao de UM caso (uma planilha fonte contra um modelo) e devolve
// as linhas da tabela + um booleano geral pra alimentar o resumo final.
function validarCaso(caso, contexto) {
  const caminhoXlsx = path.join(FIXTURES_DIR, caso.xlsx);
  const caminhoModelo = path.join(MODELOS_DIR, caso.modelo);
  const esperado = JSON.parse(fs.readFileSync(caminhoModelo, 'utf8'));

  const wb = XLSX.readFile(caminhoXlsx);
  const sheet = contexto.pickSheet(wb, XLSX);
  const M = contexto.parsePlanilhaPronta(sheet.rows, {});

  const linhas = [];

  linhas.push(linhaCampo('headlinePct', fmtPct(esperado.headlinePct), fmtPct(M.headlinePct),
    pctTrunc(esperado.headlinePct) === pctTrunc(M.headlinePct)));

  linhas.push(linhaCampo('impactoMensalCond', fmtBRL(esperado.impactoMensalCond), fmtBRL(M.impactoMensalCond),
    proximo(esperado.impactoMensalCond, M.impactoMensalCond, 0.01)));

  linhas.push(linhaCampo('r.totalBase', fmtBRL(esperado.r.totalBase), fmtBRL(M.r.totalBase),
    proximo(esperado.r.totalBase, M.r.totalBase, 0.01)));

  linhas.push(linhaCampo('r.totalPrev', fmtBRL(esperado.r.totalPrev), fmtBRL(M.r.totalPrev),
    proximo(esperado.r.totalPrev, M.r.totalPrev, 0.01)));

  linhas.push(linhaCampo('r.mensal', fmtBRL(esperado.r.mensal), fmtBRL(M.r.mensal),
    proximo(esperado.r.mensal, M.r.mensal, 0.01)));

  const totalTiposEsperado = Array.isArray(esperado.rateioTorres)
    ? esperado.rateioTorres.reduce((s, t) => s + t.tipos.length, 0)
    : (esperado.r.rateio.tipos || []).length;
  const tiposCmp = compararTipos(esperado, M);
  linhas.push(linhaCampo(`tipos (${totalTiposEsperado} itens)`, tiposCmp.ok ? tiposCmp.detalhe : 'todos batendo', tiposCmp.detalhe, tiposCmp.ok));

  const catsOk = JSON.stringify(esperado.cats) === JSON.stringify(M.cats);
  linhas.push(linhaCampo('cats', JSON.stringify(esperado.cats), JSON.stringify(M.cats), catsOk));

  const geralOk = linhas.every(l => l.resultado === 'PASSA');
  return { caso, linhas, geralOk, M };
}

// Imprime a tabela de um fixture formatada com colunas alinhadas.
function imprimirTabela(titulo, linhas) {
  console.log(`\n=== ${titulo} ===`);
  const larguraCampo = Math.max(...linhas.map(l => l.campo.length), 5);
  for (const l of linhas) {
    const marca = l.resultado === 'PASSA' ? 'PASSA' : 'FALHA';
    console.log(`${l.campo.padEnd(larguraCampo)} | esperado: ${l.esperado}`);
    console.log(`${''.padEnd(larguraCampo)} | obtido:   ${l.obtido}  [${marca}]`);
  }
}

function main() {
  // Sempre regenera o motor a partir do HTML — garante que o harness nunca
  // testa uma copia velha esquecida no disco.
  execFileSync('node', [path.join(DIR_HARNESS, 'extrai-motor.js')], { stdio: 'inherit' });
  execFileSync('node', ['--check', MOTOR_PATH], { stdio: 'inherit' });

  const codigoMotor = fs.readFileSync(MOTOR_PATH, 'utf8');

  const resumo = [];
  for (const caso of CASOS) {
    const contexto = criarContexto(); // contexto novo por fixture — sem vazamento de estado
    new vm.Script(codigoMotor, { filename: 'motor-extraido.js' }).runInContext(contexto);
    const resultado = validarCaso(caso, contexto);
    imprimirTabela(`${caso.xlsx} (${caso.apelido})`, resultado.linhas);
    resumo.push({ fixture: caso.xlsx, ok: resultado.geralOk });
  }

  console.log('\n=== RESUMO ===');
  for (const r of resumo) console.log(`${r.fixture.padEnd(16)} ${r.ok ? 'PASSA' : 'FALHA'}`);

  const falhas = resumo.filter(r => !r.ok).length;
  console.log(`\n${resumo.length - falhas}/${resumo.length} fixtures batendo.`);
  process.exitCode = falhas ? 1 : 0;
}

main();
