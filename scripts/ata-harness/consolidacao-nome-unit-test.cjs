// Teste unitario DETERMINISTICO do passe de consolidacao de nome proprio (etapas 1, 2 e 4,
// CODIGO PURO, sem LLM — a etapa 3 nao existe ainda e nao e testada aqui). Chama as funcoes
// reais do server.js direto, sem rede, sem API. Padrao do cirurgica-unit-test.cjs.
//   node scripts/ata-harness/consolidacao-nome-unit-test.cjs   (rodar da raiz do repo)
//
// Um dos casos (3, 4 e 6) le a transcricao REAL do Casablanca em runtime, de um caminho fora
// do repo (dado de cliente, nunca commitado). Se o arquivo nao existir na maquina, esses
// casos sao pulados com aviso claro (o restante do teste roda normal).
const path = require('path');
const fs = require('fs');
const {
  extrairNomesCandidatos,
  reunirEvidencia,
  decidirPorCodigo,
  aplicarConsolidacao,
  existeLiteral
} = require('../../server.js');

let ok = 0, fail = 0, pulados = 0;
function check(nome, cond, detalhe) {
  if (cond) { ok++; console.log(`  PASS  ${nome}`); }
  else { fail++; console.log(`  FAIL  ${nome}  -> ${detalhe}`); }
}
function skip(nome, motivo) {
  pulados++;
  console.log(`  SKIP  ${nome}  -> ${motivo}`);
}

const CAMINHO_TRANSCRICAO_REAL = '/Users/matheusmelo/Downloads/RETESTE ATA 2026-07-08/casablanca-transcricao.txt';
let transcricaoReal = null;
try {
  transcricaoReal = fs.readFileSync(CAMINHO_TRANSCRICAO_REAL, 'utf8');
} catch (e) {
  console.log(`\nAVISO: transcricao real do Casablanca nao encontrada em ${CAMINHO_TRANSCRICAO_REAL}.`);
  console.log('Os casos que dependem dela (3, 4 e 6) serao PULADOS nesta maquina. Sem log de conteudo.');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n===== CASO 1: extracao de marcador (canal MARCADOR) =====');
// ─────────────────────────────────────────────────────────────────────────
const ata1a = 'O contrato foi debatido e ficou definido como [nome a confirmar: Alfa Engenharia / Beta Engenharia / Gama Engenharia] para a execucao do servico, no valor total de R$47.500. O condomino Carlos [sobrenome a confirmar] participou ativamente da reuniao.';
const cand1a = extrairNomesCandidatos(ata1a, '');
console.log('  candidatos:', JSON.stringify(cand1a));
const marcador1a = cand1a.find((c) => c.tipo === 'marcador');
check('1a: achou 1 candidato tipo marcador (nao conta o [sobrenome a confirmar])', cand1a.filter((c) => c.tipo === 'marcador').length === 1, 'achou ' + cand1a.filter((c) => c.tipo === 'marcador').length);
check('1a: separou as 3 alternativas', marcador1a && marcador1a.alternativas.length === 3, JSON.stringify(marcador1a && marcador1a.alternativas));
check('1a: alternativas corretas', marcador1a && JSON.stringify(marcador1a.alternativas) === JSON.stringify(['Alfa Engenharia', 'Beta Engenharia', 'Gama Engenharia']), JSON.stringify(marcador1a && marcador1a.alternativas));
check('1a: valorAncora achou o valor sintetico (47500)', marcador1a && marcador1a.valorAncora === 47500, 'valorAncora=' + (marcador1a && marcador1a.valorAncora));
check('1a: nao gerou candidato pro "[sobrenome a confirmar]"', !cand1a.some((c) => c.textoOriginal.toLowerCase().includes('sobrenome')), 'gerou candidato de sobrenome indevidamente');

const ata1b = 'Ficou definido que a vencedora foi [nome a confirmar: Habit Engenharia] para o servico de reforma, no valor de R$47.500.';
const cand1b = extrairNomesCandidatos(ata1b, '');
console.log('  candidatos:', JSON.stringify(cand1b));
check('1b: achou 1 alternativa (marcador com 1 nome so)', cand1b.length === 1 && cand1b[0].alternativas.length === 1 && cand1b[0].alternativas[0] === 'Habit Engenharia', JSON.stringify(cand1b));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n===== CASO 2: extracao de nome FIRME + exclusao por glossario/CAIXA ALTA/falta de gatilho =====');
// ─────────────────────────────────────────────────────────────────────────
// Glossario SINTETICO (nao e o GLOSSARIO_MD real): so pra provar a exclusao (a).
const GLOSSARIO_SINTETICO = 'Termos comuns do condominio: Fundo de Reserva, Assembleia Geral.';
// Ata SINTETICA com os 2 candidatos que DEVEM entrar (Zebra Engenharia, Joao da Silva, cada
// um 2x) e os 4 termos que NAO podem virar candidato, cada um por um motivo diferente:
//   Fundo de Reserva      -> tem gatilho "empresa" (2x) MAS bate no glossario sintetico
//   Torre L               -> nunca tem gatilho de pessoa/empresa antes (so "da Torre L")
//   ASSEMBLEIA GERAL ORD. -> tem gatilho "empresa" (2x) MAS e' CAIXA ALTA inteira
//   Codigo de Processo Civil -> nunca tem gatilho de pessoa/empresa antes (so "o Codigo...")
const ata2 = [
  'Foi aprovada a contratacao da empresa Zebra Engenharia para o servico de pintura das fachadas.',
  'A empresa Zebra Engenharia ficara responsavel pela obra a partir do proximo mes.',
  'O Sr. Joao da Silva foi eleito conselheiro fiscal para o proximo mandato.',
  'O Sr. Joao da Silva ficara responsavel por acompanhar as obras contratadas.',
  'Ficou definido que o Fundo de Reserva sera utilizado para cobrir despesas extras da reforma.',
  'Chegou a ser cotada a empresa Fundo de Reserva para o mesmo servico, mas a proposta foi descartada.',
  'Reforcou-se novamente que a empresa Fundo de Reserva nao seria contratada pelo condominio.',
  'Os moradores da Torre L relataram problemas recorrentes na fiacao eletrica do predio.',
  'Novamente os moradores da Torre L cobraram uma solucao definitiva para o problema.',
  'Segundo consta na ASSEMBLEIA GERAL ORDINARIA, ficam registradas as decisoes acima.',
  'Foi cotada tambem a empresa ASSEMBLEIA GERAL ORDINARIA LTDA para o mesmo servico, sem sucesso.',
  'Mais uma vez a empresa ASSEMBLEIA GERAL ORDINARIA LTDA nao foi selecionada pelo condominio.',
  'Eventual litigio decorrente desta ata seguira o rito do Codigo de Processo Civil.',
  'Em caso de omissao, aplica-se subsidiariamente o Codigo de Processo Civil vigente.'
].join(' ');
const cand2 = extrairNomesCandidatos(ata2, GLOSSARIO_SINTETICO);
console.log('  candidatos:', JSON.stringify(cand2));
const nomes2 = cand2.map((c) => c.textoOriginal);
check('2: capturou "Zebra Engenharia"', nomes2.includes('Zebra Engenharia'), JSON.stringify(nomes2));
check('2: capturou "Joao da Silva"', nomes2.includes('Joao da Silva'), JSON.stringify(nomes2));
check('2: NAO capturou nenhum termo do glossario/CAIXA ALTA/sem gatilho', cand2.length === 2, 'candidatos=' + JSON.stringify(nomes2) + ' (esperado so Zebra Engenharia e Joao da Silva)');
check('2: "Fundo de Reserva" excluido (glossario, mesmo com gatilho e repeticao)', !nomes2.some((n) => n.toLowerCase().includes('fundo de reserva')), 'vazou Fundo de Reserva');
check('2: "Torre L" excluido (falta de gatilho de pessoa/empresa)', !nomes2.some((n) => n.toLowerCase().includes('torre')), 'vazou Torre L');
check('2: "ASSEMBLEIA GERAL ORDINARIA" excluido (CAIXA ALTA, mesmo com gatilho e repeticao)', !nomes2.some((n) => n.toUpperCase() === n && n.length > 3), 'vazou termo em caixa alta');
check('2: "Codigo de Processo Civil" excluido (falta de gatilho de pessoa/empresa)', !nomes2.some((n) => n.toLowerCase().includes('processo civil')), 'vazou Codigo de Processo Civil');

// ─────────────────────────────────────────────────────────────────────────
console.log('\n===== CASO 3: grounding contra a transcricao REAL do Casablanca =====');
// ─────────────────────────────────────────────────────────────────────────
if (!transcricaoReal) {
  skip('3: grounding real (Bit/MIT/Adite/ADN Mantas/DM Mantas existem; Habit/ABM Montas/ADM Manta nao)', 'transcricao real ausente nesta maquina');
} else {
  const termos = ['Habit', 'ABM Montas', 'ADM Manta', 'Bit', 'MIT', 'Adite', 'ADN Mantas', 'DM Mantas'];
  const candidatosTermos = termos.map((t) => ({ tipo: 'marcador', textoOriginal: '[nome a confirmar: ' + t + ']', alternativas: [t], valorAncora: null, idx: 0 }));
  const enriquecidos3 = reunirEvidencia(candidatosTermos, transcricaoReal);
  const resultado3 = {};
  termos.forEach((t, i) => { resultado3[t] = enriquecidos3[i].groundedAlternativas.length > 0; });
  console.log('  grounded? ' + JSON.stringify(resultado3));
  check('3: "Habit" NAO grounded (fabricado)', resultado3['Habit'] === false, 'grounded indevidamente');
  check('3: "ABM Montas" NAO grounded (fabricado)', resultado3['ABM Montas'] === false, 'grounded indevidamente');
  check('3: "ADM Manta" NAO grounded (fabricado)', resultado3['ADM Manta'] === false, 'grounded indevidamente');
  check('3: "Bit" grounded', resultado3['Bit'] === true, 'nao grounded');
  check('3: "MIT" grounded', resultado3['MIT'] === true, 'nao grounded');
  check('3: "Adite" grounded', resultado3['Adite'] === true, 'nao grounded');
  check('3: "ADN Mantas" grounded', resultado3['ADN Mantas'] === true, 'nao grounded');
  check('3: "DM Mantas" grounded', resultado3['DM Mantas'] === true, 'nao grounded');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n===== CASO 4: grounding negativo (Ceval x Valp) contra a transcricao REAL =====');
// ─────────────────────────────────────────────────────────────────────────
if (!transcricaoReal) {
  skip('4: Ceval descartado, Valp mantido', 'transcricao real ausente nesta maquina');
} else {
  // "Valp Manutencao" (2 palavras) nao existe LITERALMENTE contigua na fala (o audio diz
  // "Valp, Cervalp Manutencao" com um nome no meio) — por isso o alternativo aqui e' "Valp"
  // (1 palavra), que EXISTE de fato. Grounding e' literal, nunca aproximado.
  const candidato4 = { tipo: 'marcador', textoOriginal: '[nome a confirmar: Ceval / Valp]', alternativas: ['Ceval', 'Valp'], valorAncora: null, idx: 0 };
  const enriquecido4 = reunirEvidencia([candidato4], transcricaoReal)[0];
  console.log('  groundedAlternativas:', JSON.stringify(enriquecido4.groundedAlternativas));
  check('4: "Ceval" descartado (nao existe na transcricao)', !enriquecido4.groundedAlternativas.includes('Ceval'), 'sobreviveu ao grounding');
  check('4: "Valp" mantido (existe na transcricao)', enriquecido4.groundedAlternativas.includes('Valp'), 'nao sobreviveu ao grounding');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n===== CASO 5: ancora por VALOR (SINTETICO, sem dado real de cliente) =====');
// ─────────────────────────────────────────────────────────────────────────
const candidato5 = { tipo: 'marcador', textoOriginal: '[nome a confirmar]', alternativas: [], valorAncora: 999999, idx: 0 };
const transcricaoSintetica5 = 'Apos a apresentacao dos orcamentos, foi aprovada a empresa TesteCorp no valor de R$ 999.999,00 para o servico de pintura das fachadas.';
const enriquecido5 = reunirEvidencia([candidato5], transcricaoSintetica5)[0];
console.log('  ancoraNomes:', JSON.stringify(enriquecido5.ancoraNomes), ' formasGrounded:', JSON.stringify(enriquecido5.formasGrounded));
check('5: ancora trouxe "TesteCorp"', enriquecido5.ancoraNomes.includes('TesteCorp'), 'nao achou TesteCorp');
check('5: formasGrounded tem exatamente 1 forma', enriquecido5.formasGrounded.length === 1, 'formasGrounded=' + JSON.stringify(enriquecido5.formasGrounded));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n===== CASO 6 (CRITERIO DE ACEITE 1): "Habit" perto do valor do Bit resolve por CODIGO, sem LLM =====');
// ─────────────────────────────────────────────────────────────────────────
if (!transcricaoReal) {
  skip('6: caso Bit resolve por codigo', 'transcricao real ausente nesta maquina');
} else {
  // Extrai o valor associado ao Bit DA TRANSCRICAO em runtime, para nao hardcodar valor real
  // de cliente no arquivo commitado. A ancora liga o marcador a esse valor.
  const mBitVal = transcricaoReal.match(/empresa Bit no valor de R\$\s*([\d.]+)/i) || transcricaoReal.match(/Bit Engenharia\s*R\$\s*([\d.]+)/i);
  const bitVal = mBitVal ? mBitVal[1] : '';
  const ata6 = 'Ficou definida a contratacao para o servico de impermeabilizacao da caixa dagua, sendo a vencedora [nome a confirmar: Habit Engenharia], pelo valor de R$' + bitVal + '.';
  const candidatos6 = extrairNomesCandidatos(ata6, '');
  console.log('  candidatos (etapa 1):', JSON.stringify(candidatos6));
  const enriquecidos6 = reunirEvidencia(candidatos6, transcricaoReal);
  console.log('  enriquecidos (etapa 2): groundedAlternativas=' + JSON.stringify(enriquecidos6[0].groundedAlternativas) + ' ancoraNomes=' + JSON.stringify(enriquecidos6[0].ancoraNomes) + ' formasGrounded=' + JSON.stringify(enriquecidos6[0].formasGrounded));
  const { decisoesCodigo, pendentesLLM } = decidirPorCodigo(enriquecidos6);
  console.log('  decisao por codigo:', JSON.stringify(decisoesCodigo), ' pendentesLLM.length=' + pendentesLLM.length);
  check('6: "Habit Engenharia" descartado do grounding (fabricado)', enriquecidos6[0].groundedAlternativas.length === 0, JSON.stringify(enriquecidos6[0].groundedAlternativas));
  check('6: ancora recuperou exatamente 1 forma ("Bit Engenharia")', enriquecidos6[0].formasGrounded.length === 1 && enriquecidos6[0].formasGrounded[0] === 'Bit Engenharia', JSON.stringify(enriquecidos6[0].formasGrounded));
  check('6: resolveu POR CODIGO (sem LLM)', decisoesCodigo.length === 1 && pendentesLLM.length === 0, 'decisoesCodigo=' + decisoesCodigo.length + ' pendentesLLM=' + pendentesLLM.length);
  check('6: forma_canonica = "Bit Engenharia"', decisoesCodigo[0] && decisoesCodigo[0].forma_canonica === 'Bit Engenharia', JSON.stringify(decisoesCodigo[0]));
  check('6: confianca = "alta_codigo"', decisoesCodigo[0] && decisoesCodigo[0].confianca === 'alta_codigo', JSON.stringify(decisoesCodigo[0]));
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n===== CASO 7: find and replace determinístico (etapa 4, aplicarConsolidacao) =====');
// ─────────────────────────────────────────────────────────────────────────
// 7a: decisao ALTA com 2 variantes (Ceval, Valp Manutencao) -> ambas viram "Cervalp Manutencao".
// Passa uma transcricao SINTETICA (dupla checagem) que contem a forma_canonica de fato.
const ata7a = 'Segundo a assembleia, a proposta de Ceval foi analisada, e posteriormente confirmou-se que Valp Manutencao seria a executora dos servicos de manutencao geral do condominio.';
const transcricaoSintetica7 = 'Ficou definido que a proposta da empresa Cervalp Manutencao foi a vencedora da cotacao para os servicos gerais.';
const decisao7a = { forma_canonica: 'Cervalp Manutencao', variantes: ['Ceval', 'Valp Manutencao'], confianca: 'alta' };
const r7a = aplicarConsolidacao(ata7a, [decisao7a], transcricaoSintetica7);
console.log('  7a ata resultante:', r7a.ata);
console.log('  7a aplicados:', JSON.stringify(r7a.aplicados), ' pulados:', JSON.stringify(r7a.pulados));
check('7a: nao restou "Ceval"', !r7a.ata.includes('Ceval'), 'sobrou Ceval');
check('7a: nao restou "Valp Manutencao"', !r7a.ata.includes('Valp Manutencao'), 'sobrou Valp Manutencao');
check('7a: as duas grafias viraram "Cervalp Manutencao" (aparece 2x)', (r7a.ata.match(/Cervalp Manutencao/g) || []).length === 2, r7a.ata);
check('7a: reportou 1 aplicado', r7a.aplicados.length === 1, JSON.stringify(r7a.aplicados));

// 7b: confianca 'media' NAO aplica (fica como esta).
const ata7b = 'A empresa Ceval apresentou proposta para o servico.';
const decisao7b = { forma_canonica: 'Cervalp Manutencao', variantes: ['Ceval'], confianca: 'media' };
const r7b = aplicarConsolidacao(ata7b, [decisao7b], transcricaoSintetica7);
console.log('  7b ata resultante:', r7b.ata);
console.log('  7b aplicados:', JSON.stringify(r7b.aplicados), ' pulados:', JSON.stringify(r7b.pulados));
check('7b: confianca media NAO aplica', r7b.ata === ata7b && r7b.aplicados.length === 0, 'aplicou indevidamente: ' + r7b.ata);
check('7b: reportou pulado por confianca insuficiente', r7b.pulados.some((p) => p.motivo === 'confianca_insuficiente'), JSON.stringify(r7b.pulados));

// 7c: dupla checagem de grounding — forma_canonica FABRICADA (nao existe na transcricao
// passada) rejeita a decisao inteira, mesmo com confianca alta e alvo existente na ata.
const ata7c = 'A empresa Ceval apresentou proposta para o servico de manutencao geral.';
const decisao7c = { forma_canonica: 'Empresa Fantasma Inventada', variantes: ['Ceval'], confianca: 'alta' };
const r7c = aplicarConsolidacao(ata7c, [decisao7c], transcricaoSintetica7);
console.log('  7c ata resultante:', r7c.ata);
console.log('  7c pulados:', JSON.stringify(r7c.pulados));
check('7c: forma_canonica fabricada rejeitada (dupla checagem)', r7c.ata === ata7c && r7c.aplicados.length === 0, 'aplicou forma fabricada indevidamente: ' + r7c.ata);
check('7c: reportou pulado por forma nao grounded', r7c.pulados.some((p) => p.motivo === 'forma_nao_grounded'), JSON.stringify(r7c.pulados));

// 7d: GUARDA DE TAMANHO — decisao que reduziria a ata pra bem menos de 95% do tamanho de
// entrada e' rejeitada inteira, mesmo com confianca alta e sem checagem de transcricao.
const textoGrandeGuarda = 'Texto extenso demais que ocupa a maior parte da ata pra simular uma substituicao que reduziria o documento pra bem menos de noventa e cinco por cento do tamanho original, o que a guarda de tamanho deve impedir de qualquer forma.';
const ata7d = textoGrandeGuarda + ' Fim da ata.';
const decisao7d = { textoOriginal: textoGrandeGuarda, forma_canonica: 'X', confianca: 'alta' };
const r7d = aplicarConsolidacao(ata7d, [decisao7d]);
console.log('  7d tamanho entrada=' + ata7d.length + ' tamanho saida=' + r7d.ata.length);
console.log('  7d pulados:', JSON.stringify(r7d.pulados));
check('7d: guarda de tamanho rejeitou a decisao (ata ficaria menor que 95%)', r7d.ata === ata7d && r7d.aplicados.length === 0, 'aplicou indevidamente, reduzindo a ata');
check('7d: reportou pulado por guarda de tamanho', r7d.pulados.some((p) => p.motivo === 'guarda_tamanho'), JSON.stringify(r7d.pulados));

// ─────────────────────────────────────────────────────────────────────────
console.log('\n===== CASO 8: substituicao por PALAVRA INTEIRA (nao corromper nome maior) =====');
// ─────────────────────────────────────────────────────────────────────────
// Caso do advogado: "Marcel" (apelido) vira "Marcelo Soares", MAS as ocorrencias que ja sao
// "Marcelo Soares" nao podem virar "Marcelo Soareso Soares". "Marcel" e substring de "Marcelo".
const ata8 = 'O Dr. Marcel orientou os presentes. Depois o Dr. Marcel esclareceu duvidas. O advogado se identificou como Marcelo Soares no item 1.';
const decisao8 = { textoOriginal: 'Marcel', forma_canonica: 'Marcelo Soares', variantes: ['Marcel'], confianca: 'alta' };
const r8 = aplicarConsolidacao(ata8, [decisao8]);
console.log('  saida:', JSON.stringify(r8.ata));
check('8: "Dr. Marcel" virou "Dr. Marcelo Soares"', /Dr\. Marcelo Soares orientou/.test(r8.ata), r8.ata);
check('8: NAO corrompeu o "Marcelo Soares" que ja existia', !r8.ata.includes('Marcelo Soareso') && !/Marcelo Soares Soares/.test(r8.ata), r8.ata);
check('8: sobrou exatamente 3 "Marcelo Soares", zero "Marcel " solto', (r8.ata.match(/Marcelo Soares/g) || []).length === 3 && !/Marcel(?![oa])/.test(r8.ata.replace(/Marcelo Soares/g, '')), r8.ata);

// ─────────────────────────────────────────────────────────────────────────
console.log('\n===== CASO 9: grounding por FRONTEIRA DE PALAVRA (regressao do bug existeLiteral) =====');
// ─────────────────────────────────────────────────────────────────────────
// BUG (2026-07-09): existeLiteral usava transcricaoNorm.includes(alvo), que casava SUBSTRING.
// "Cato" passava por existir dentro de "Cator", "Cerval" dentro de "Cervalp", "Marcel" dentro
// de "Marcelo". Formas degradadas eram aprovadas como grounded e o passe as aplicava como
// forma_canonica. O conserto exige o alvo como PALAVRA INTEIRA. Este caso trava esse conserto.

// 9a: fixture SINTETICO (sempre roda, portavel, sem dado de cliente). Contem "Cator Engenharia",
// "Cervalp Manutencao" e "Marcelo Soares", mas NENHUM "Cato"/"Cerval"/"Marcel" isolado.
const fxSint = 'Na assembleia foi aprovada a empresa Cator Engenharia por R$225.571. Tambem citaram a Cervalp Manutencao e o advogado Marcelo Soares. A proposta da Bit Engenharia e da ADN Mantas foi debatida.';
check('9a: "Cato" NAO grounded (so existe dentro de "Cator")', existeLiteral('Cato', fxSint) === false, 'grounded indevidamente por substring');
check('9a: "Cerval" NAO grounded (so existe dentro de "Cervalp")', existeLiteral('Cerval', fxSint) === false, 'grounded indevidamente por substring');
check('9a: "Marcel" NAO grounded quando so existe dentro de "Marcelo"', existeLiteral('Marcel', fxSint) === false, 'grounded indevidamente por substring');
check('9a: "Cator" grounded (palavra inteira)', existeLiteral('Cator', fxSint) === true, 'palavra real rejeitada');
check('9a: "Cervalp" grounded (palavra inteira)', existeLiteral('Cervalp', fxSint) === true, 'palavra real rejeitada');
check('9a: "Marcelo Soares" grounded (nome composto, fronteira so nas pontas)', existeLiteral('Marcelo Soares', fxSint) === true, 'nome composto rejeitado');
check('9a: "Bit" grounded (controle)', existeLiteral('Bit', fxSint) === true, 'controle falhou');
check('9a: "ADN" grounded (controle)', existeLiteral('ADN', fxSint) === true, 'controle falhou');

// 9b: transcricao REAL do Casablanca (skip se ausente). Os 8 casos do handoff. ATENCAO ao Marcel:
// a previsao inicial era "Marcel vira false apos o conserto"; a transcricao real DESMENTE isso —
// "Marcel" aparece 4x como PALAVRA isolada na fala, entao continua grounded (true). O bug de
// substring nunca explicou o Marcel; o Cato e o Cerval sim. Esperado correto abaixo.
if (transcricaoReal) {
  check('9b: real "Cato" NAO grounded', existeLiteral('Cato', transcricaoReal) === false, 'grounded por "Cator"');
  check('9b: real "Cerval" NAO grounded', existeLiteral('Cerval', transcricaoReal) === false, 'grounded por "Cervalp"');
  check('9b: real "Marcel" grounded (palavra isolada 4x na fala, NAO e o bug)', existeLiteral('Marcel', transcricaoReal) === true, 'Marcel deveria seguir grounded');
  check('9b: real "Cator" grounded', existeLiteral('Cator', transcricaoReal) === true, 'palavra real rejeitada');
  check('9b: real "Cervalp" grounded', existeLiteral('Cervalp', transcricaoReal) === true, 'palavra real rejeitada');
  check('9b: real "Marcelo Soares" grounded', existeLiteral('Marcelo Soares', transcricaoReal) === true, 'nome composto rejeitado');
  check('9b: real "Bit" grounded', existeLiteral('Bit', transcricaoReal) === true, 'controle falhou');
  check('9b: real "ADN" grounded', existeLiteral('ADN', transcricaoReal) === true, 'controle falhou');
} else {
  skip('9b: 8 casos contra transcricao real do Casablanca', 'transcricao real ausente nesta maquina');
}

console.log(`\n==================\nRESULTADO: ${ok} PASS, ${fail} FAIL, ${pulados} SKIP`);
process.exit(fail > 0 ? 1 : 0);
