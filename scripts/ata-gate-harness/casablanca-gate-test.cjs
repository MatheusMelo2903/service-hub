// PROVA DETERMINISTICA do gate de saida (gateDeSaida) contra a fixture Casablanca.
// Chama a funcao REAL do server.js. Sem API, sem LLM, sem rede.
//   node scripts/ata-gate-harness/casablanca-gate-test.cjs   (rodar da raiz do repo)
//
// PRIVACIDADE (auditoria de segurança): NENHUM dado de cliente vive neste arquivo versionado.
// Tanto a transcricao real quanto a ATA de fixture (que carrega nome de condominio, CNPJ,
// fornecedores e valores) sao lidas de ~/Downloads/GATE-ATA-CASABLANCA, FORA do repo. Sem esses
// arquivos locais o harness nao roda (mesmo padrao do previsao-harness, que le xlsx de fora).
// Override por env: GATE_TRANSCRICAO=... e GATE_ATA_FIXTURE=...
//
// A ata de fixture (casablanca-ata-fixture.txt) e CONTROLADA: fragmentos reais das evidencias
// congeladas montados num unico documento que exercita todos os criterios de uma vez (mencao
// honesta entre colchetes IGNORADA; nome fabricado no placar CRITICO; valor fabricado SINALIZA;
// nomes e valores que existem na fonte PASSAM). Os identificadores especificos vivem no fixture
// e no manifesto gate-expected.json, ambos fora do repo. Procedencia detalhada: ver o LEIA-ME
// da pasta de evidencia (v6 e run1).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { gateDeSaida, valoresCanonicos, mencoesMonetarias } = require('../../server.js');

const DIR_EVIDENCIA = path.join(os.homedir(), 'Downloads', 'GATE-ATA-CASABLANCA');
const CAMINHO_TRANSCRICAO = process.env.GATE_TRANSCRICAO || path.join(DIR_EVIDENCIA, 'casablanca-transcricao.txt');
const CAMINHO_ATA_FIXTURE = process.env.GATE_ATA_FIXTURE || path.join(DIR_EVIDENCIA, 'casablanca-ata-fixture.txt');
const CAMINHO_ESPERADO = process.env.GATE_EXPECTED || path.join(DIR_EVIDENCIA, 'gate-expected.json');

let transcricao, ata, esperado;
try {
  transcricao = fs.readFileSync(CAMINHO_TRANSCRICAO, 'utf8');
  ata = fs.readFileSync(CAMINHO_ATA_FIXTURE, 'utf8');
  esperado = JSON.parse(fs.readFileSync(CAMINHO_ESPERADO, 'utf8'));
} catch (e) {
  console.error('\nHarness precisa da evidencia local (fora do repo). Faltou:\n  ' + e.path +
    '\nColoque transcricao, ata de fixture e gate-expected.json em ~/Downloads/GATE-ATA-CASABLANCA/' +
    ' (ou aponte por GATE_TRANSCRICAO / GATE_ATA_FIXTURE / GATE_EXPECTED).\n');
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────
let ok = 0, fail = 0;
function check(nome, cond, detalhe) {
  if (cond) { ok++; console.log('  PASS  ' + nome); }
  else { fail++; console.log('  FAIL  ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}
// Multiset de flags normalizado (tipo|severidade|trecho), ordenado, pra comparar conjuntos.
function chaveFlags(g) {
  return g.flags.map((f) => f.tipo + '|' + f.severidade + '|' + f.trecho).sort().join(' ;; ');
}
function flagsComTrecho(g, alvo) {
  return g.flags.filter((f) => f.trecho.toLowerCase().indexOf(alvo.toLowerCase()) !== -1);
}

const r = gateDeSaida(ata, transcricao);
console.log('\n===== VEREDICTO =====');
console.log('  veredicto = ' + r.gate.veredicto + '  |  marcacaoFalhou = ' + r.gate.marcacaoFalhou);
console.log('  flags (' + r.gate.flags.length + '):');
for (const f of r.gate.flags) console.log('    [' + f.severidade + '] ' + f.tipo + ' "' + f.trecho + '"  (' + f.motivo + ')');

// Criterios de aceitacao dirigidos pelo manifesto externo (esperado): sem tokens de cliente aqui.
console.log('\n===== CRITERIOS DE ACEITACAO =====');
const critico = esperado.placarCritico;
for (const nome of esperado.sinalizarNome) {
  check(nome + ' (nome fabricado) sinalizado', flagsComTrecho(r.gate, nome).length >= 1, 'nenhuma flag para ' + nome);
}
check('placar de votos para nome fabricado -> CRITICO', flagsComTrecho(r.gate, critico).some((f) => f.severidade === 'critico' && f.tipo === 'placar'), 'nenhuma flag critica de placar em ' + critico);
for (const val of esperado.sinalizarValor) {
  check('valor fabricado ' + val + ' sinalizado', flagsComTrecho(r.gate, val).length >= 1, val + ' nao sinalizado');
}
check('veredicto final = critico', r.gate.veredicto === 'critico', 'veredicto=' + r.gate.veredicto);
for (const passa of esperado.passar) {
  check(passa + ' PASSA (zero flag)', flagsComTrecho(r.gate, passa).length === 0, 'sinalizou ' + passa + ' indevidamente');
}
// marca visivel de fato presente no texto entregue (TRAVA 1: nao ha flag sem marcacao)
check('TRAVA 1: texto entregue contem a marca visivel sem ancora', new RegExp('sem âncora[^\\]]*' + critico).test(r.ata), 'ata entregue sem a marca visivel');
check('TRAVA 1: marcacaoFalhou = false (todas aplicadas)', r.gate.marcacaoFalhou === false, 'alguma marcacao nao entrou no texto');
// mencao honesta entre colchetes NAO vira flag (o gate ignora incerteza declarada)
check('mencao honesta [nome a confirmar: ...] NAO conta como afirmacao', r.gate.flags.length === esperado.flagsEsperadas, 'esperava ' + esperado.flagsEsperadas + ' flags, veio ' + r.gate.flags.length);

console.log('\n===== COBERTURA: GAPS DO REVISOR (achados 1/2/3, transcricao sintetica) =====');
// Transcricao sintetica minima (SEM dado de cliente): "Bit" ancorado, fabricacoes ausentes.
const transcSint = 'A empresa Bit ficou responsavel pela obra aprovada. Houve votacao com placas levantadas durante a assembleia.';
// Achado 2: entidade fabricada introduzida por gatilho != "empresa" (prestadora) recebe votos -> CRITICO
const g2 = gateDeSaida('Procedeu-se a votacao: a prestadora Xurupita obteve quinze (15) votos favoraveis; a empresa Bit obteve dez (10) votos.', transcSint);
check('achado 2: prestadora fabricada com votos -> CRITICO', g2.gate.flags.some((f) => f.tipo === 'placar' && f.severidade === 'critico' && /Xurupita/.test(f.trecho)), JSON.stringify(g2.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));
check('achado 2: Bit (ancorado) NAO vira flag', !g2.gate.flags.some((f) => /Bit/.test(f.trecho)), 'Bit marcado indevidamente');
// Achado 1: objeto do voto e so o nome, nao vaza por palavras minusculas depois dele
const g1 = gateDeSaida('A empresa Xurupita apresentou proposta inicial modesta e depois obteve dez (10) votos favoraveis.', transcSint);
check('achado 1: Xurupita (objeto do voto) marcado, so o nome no trecho', g1.gate.flags.some((f) => f.trecho === 'Xurupita' && f.severidade === 'critico'), JSON.stringify(g1.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));
// Achado 3: nome fabricado abrindo item de lista apos ";" sem gatilho -> marcado como nome
const g3 = gateDeSaida('Orcamentos: (i) empresa Bit, R$ 10,00; Xurupita Reformas, R$ 20,00.', transcSint);
check('achado 3: nome fabricado apos ";" sem gatilho e marcado', g3.gate.flags.some((f) => f.tipo === 'nome' && /Xurupita/.test(f.trecho)), JSON.stringify(g3.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));

console.log('\n===== COBERTURA: 2a RODADA DO REVISOR (objeto de voto abrindo frase; cabecalho ":") =====');
// R2-A: nome fabricado ABRE frase no formato "[Nome], com (N) votos" (eleicao) sem gatilho.
// Antes saia LIMPO (o filtro de inicio de frase descartava o nome antes de ligar ao placar).
const rA = gateDeSaida('Joao Silva, com doze (12) votos, foi eleito sindico. Maria Souza, com oito (8) votos, ficou como suplente.',
  'Compareceram os condominos. Joao Silva foi o unico eleito na votacao com placas levantadas.');
check('R2-A: nome fabricado que ABRE frase e recebe votos -> CRITICO', rA.gate.flags.some((f) => f.tipo === 'placar' && f.severidade === 'critico' && /Maria|Souza/.test(f.trecho)), JSON.stringify(rA.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));
check('R2-A: NAO sai limpo com nome fabricado votado', rA.gate.veredicto === 'critico', 'veredicto=' + rA.gate.veredicto);
check('R2-A: Joao Silva (ancorado) NAO vira flag', !rA.gate.flags.some((f) => /Joao|Silva/.test(f.trecho)), 'marcou nome ancorado');
// R2-B: cabecalho "ITEM N) TITULO: Palavra..." nao gera falso positivo na palavra formal apos ":".
const rB = gateDeSaida('ITEM 1) ELEICAO: Apos ampla discussao, a empresa Bit foi aprovada por unanimidade.',
  'Compareceram os condominos. A empresa Bit ficou responsavel pela obra aprovada.');
check('R2-B: cabecalho com ":" NAO marca a palavra formal seguinte (Apos)', !rB.gate.flags.some((f) => /Apos|Ampla|Discussao/i.test(f.trecho)), JSON.stringify(rB.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));
check('R2-B: veredicto limpo (nada fabricado no cabecalho)', rB.gate.veredicto === 'limpo', 'veredicto=' + rB.gate.veredicto);

console.log('\n===== COBERTURA: 3a RODADA (abreviacao com ponto; nome fabricado apos ":") =====');
// R3-A: "Ltda." (ponto seguido de espaco + minuscula) NAO parte a frase; objeto do voto continua.
const rC = gateDeSaida('Foi feita a escolha. Zurupita Ltda. obteve doze (12) votos e venceu a disputa.',
  'Foi realizada a assembleia geral com votacao por aclamacao dos condominos presentes.');
check('R3-A: nome fabricado com sufixo "Ltda." recebendo votos -> CRITICO', rC.gate.flags.some((f) => f.tipo === 'placar' && f.severidade === 'critico' && /Zurupita/.test(f.trecho)), JSON.stringify(rC.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));
check('R3-A: NAO sai limpo', rC.gate.veredicto === 'critico', 'veredicto=' + rC.gate.veredicto);
// R3-B: "S.A." nao rouba o vinculo; o voto e do Bit (ancorado), Xurupita (mencao) NAO vira critico.
const rD = gateDeSaida('A empresa Bit S.A. obteve dez (10) votos; a Xurupita tambem concorreu, mas nao venceu.',
  'A empresa Bit ficou responsavel pela obra. Houve votacao normal na assembleia.');
check('R3-B: Xurupita (mencao de derrota) NAO e acusada de voto', !rD.gate.flags.some((f) => f.tipo === 'placar' && /Xurupita/.test(f.trecho)), JSON.stringify(rD.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));
// R3-C: nome fabricado abrindo lista apos ":" sem placar -> marcado (nao escapa).
const rE = gateDeSaida('Fornecedores consultados: Zurupita Fantasma apresentou proposta e foi selecionada por unanimidade.',
  'Foram consultados fornecedores da regiao para o servico de pintura das fachadas.');
check('R3-C: nome fabricado apos ":" sem gatilho e marcado', rE.gate.flags.some((f) => /Zurupita/.test(f.trecho)), JSON.stringify(rE.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));
check('R3-C: NAO sai limpo', rE.gate.veredicto !== 'limpo', 'veredicto=' + rE.gate.veredicto);
// R3-D: abertura gramatical formal apos ":" NAO vira falso positivo (mesmo fora da transcricao).
const rF = gateDeSaida('ITEM 2) OBRAS: Considerando a urgencia, a empresa Bit foi contratada.',
  'A empresa Bit ficou responsavel pela obra aprovada na assembleia dos condominos.');
check('R3-D: abertura formal ("Considerando") apos ":" NAO e marcada', !rF.gate.flags.some((f) => /Considerando/i.test(f.trecho)), JSON.stringify(rF.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));

console.log('\n===== COBERTURA: 4a RODADA (nome fabricado que COLIDE com abertura gramatical) =====');
// R4-A: nome fabricado ("Assim", que esta em _GATE_ABERTURAS) recebendo votos NAO pode escapar.
// Antes saia LIMPO porque o filtro de abertura tirava a raiz dos DOIS pools (inclusive objeto de voto).
const rG = gateDeSaida('A empresa Assim apresentou proposta. Assim venceu com dez (10) votos e foi contratada.',
  'Foi apresentada uma proposta na assembleia, mas nenhuma empresa foi mencionada por nome.');
check('R4-A: nome fabricado que colide com abertura, recebendo votos -> CRITICO', rG.gate.flags.some((f) => f.tipo === 'placar' && f.severidade === 'critico' && /Assim/.test(f.trecho)), JSON.stringify(rG.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));
check('R4-A: NAO sai limpo', rG.gate.veredicto === 'critico', 'veredicto=' + rG.gate.veredicto);
// R4-B: mesma colisao, mencao DESCRITIVA com gatilho (sem voto) tambem nao escapa (via gatilho).
const rH = gateDeSaida('A empresa Assim apresentou proposta de manutencao e foi aprovada.',
  'Houve assembleia com varias propostas, mas nenhuma empresa foi citada pelo nome.');
check('R4-B: colisao com gatilho ("empresa Assim") descritiva e marcada', rH.gate.flags.some((f) => /Assim/.test(f.trecho)), JSON.stringify(rH.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));
// R4-C: abertura gramatical de verdade (sem gatilho) segue NAO marcada apos a mudanca.
const rI = gateDeSaida('ITEM 3) OBRAS: Considerando o exposto, a empresa Bit foi aprovada por unanimidade.',
  'A empresa Bit ficou responsavel pela obra aprovada na assembleia dos condominos.');
check('R4-C: abertura real ("Considerando") sem gatilho segue NAO marcada', !rI.gate.flags.some((f) => /Considerando/i.test(f.trecho)), JSON.stringify(rI.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));

console.log('\n===== COBERTURA: 5a RODADA (gatilho MAIUSCULO abrindo frase) =====');
// R5-A: frase abre com gatilho capitalizado ("Empresa Xurupita"), sem voto -> nome NAO escapa.
// Antes saia LIMPO porque temGatilho so olhava ANTES do run, e a palavra gatilho era o 1o token.
const rJ = gateDeSaida('Discutiu-se a manutencao predial. Empresa Xurupita apresentou o orcamento e foi aprovada por unanimidade.',
  'Houve discussao sobre manutencao predial na assembleia geral dos condominos presentes.');
check('R5-A: nome fabricado com gatilho MAIUSCULO abrindo frase e marcado', rJ.gate.flags.some((f) => /Xurupita/.test(f.trecho)), JSON.stringify(rJ.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));
check('R5-A: NAO sai limpo', rJ.gate.veredicto !== 'limpo', 'veredicto=' + rJ.gate.veredicto);
// R5-B: "Sindico Fulano" (outro gatilho maiusculo) abrindo frase tambem e pego.
const rK = gateDeSaida('A pauta seguiu. Sindico Zurupita conduziu os trabalhos e prestou contas do exercicio.',
  'A assembleia teve a conducao dos trabalhos e prestacao de contas, sem nomear o sindico na gravacao.');
check('R5-B: "Sindico Zurupita" (gatilho maiusculo) e marcado', rK.gate.flags.some((f) => /Zurupita/.test(f.trecho)), JSON.stringify(rK.gate.flags.map((f) => f.tipo + '/' + f.severidade + '/' + f.trecho)));

console.log('\n===== DETERMINISMO (10 execucoes byte a byte) =====');
const base = JSON.stringify({ ata: r.ata, gate: r.gate });
let identico = true;
for (let i = 0; i < 10; i++) {
  const ri = gateDeSaida(ata, transcricao);
  if (JSON.stringify({ ata: ri.ata, gate: ri.gate }) !== base) { identico = false; break; }
}
check('10 execucoes -> saida byte a byte identica', identico, 'houve variacao entre execucoes');

console.log('\n===== IDEMPOTENCIA: Gate(Gate(ata)) =====');
const r2 = gateDeSaida(r.ata, transcricao);
check('texto e ponto fixo (Gate(Gate(ata)).ata === Gate(ata).ata)', r2.ata === r.ata, 'texto mudou na 2a passada');
check('conjunto de flags identico', chaveFlags(r2.gate) === chaveFlags(r.gate), 'conjunto de flags mudou\n    1a: ' + chaveFlags(r.gate) + '\n    2a: ' + chaveFlags(r2.gate));
check('veredicto estavel', r2.gate.veredicto === r.gate.veredicto, r2.gate.veredicto);

console.log('\n===== TRAVA 2: diagnostico de valor NAO ganha ruido do marcador =====');
// Reproduz o diagnostico do entregarAta (canonFinal + valores_fala_faltando_final) sobre a ata
// ANTES e DEPOIS do gate. Se o marcador introduzisse ruido, os conjuntos divergiriam.
function falaFaltando(ataX) {
  const canon = valoresCanonicos(ataX);
  return [...new Set(mencoesMonetarias(transcricao).map((m) => m.canon))].filter((c) => !canon.has(c)).sort((a, b) => a - b);
}
const canonPre = [...valoresCanonicos(ata)].sort((a, b) => a - b);
const canonPos = [...valoresCanonicos(r.ata)].sort((a, b) => a - b);
const faltaPre = falaFaltando(ata);
const faltaPos = falaFaltando(r.ata);
console.log('  canon(ata) valores PRE-gate  = ' + JSON.stringify(canonPre));
console.log('  canon(ata) valores POS-gate  = ' + JSON.stringify(canonPos));
console.log('  valores_fala_faltando PRE    = ' + JSON.stringify(faltaPre));
console.log('  valores_fala_faltando POS    = ' + JSON.stringify(faltaPos));
check('conjunto de valores da ata inalterado pelo marcador', JSON.stringify(canonPre) === JSON.stringify(canonPos), 'o marcador mexeu nos valores extraidos');
check('valores_fala_faltando_final identico PRE/POS', JSON.stringify(faltaPre) === JSON.stringify(faltaPos), 'o diagnostico ganhou ruido do marcador');

console.log('\n===== RESULTADO: ' + ok + ' PASS, ' + fail + ' FAIL =====');
process.exit(fail === 0 ? 0 : 1);
