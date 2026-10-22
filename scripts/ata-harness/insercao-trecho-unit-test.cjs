// Teste unitário da aplicação de operações da inserção por trecho (T46). Sem API.
// Rodar: node scripts/ata-harness/insercao-trecho-unit-test.cjs
const { aplicarTrechos } = require('../../server.js');
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '  -> ' + d); } };
const ATA = 'ITEM 1) ELEIÇÃO: Foi eleita a Sra. Ana. A votação foi unânime.\nITEM 2) OBRAS: Foi apresentada a proposta da Alfa Engenharia no valor de R$ 10.000,00. O item foi aprovado.\nENCERRAMENTO: Nada mais havendo a tratar.';

let r = aplicarTrechos(ATA, [{ tipo: 'inserir_apos', ancora: 'Foi apresentada a proposta da Alfa Engenharia no valor de R$ 10.000,00.', texto: ' A proposta parcelada é de 10x de R$ 1.100,00.' }]);
check('insere depois da âncora e mantém o resto igual', r.aplicadas === 1 && r.ata === ATA.replace('R$ 10.000,00.', 'R$ 10.000,00. A proposta parcelada é de 10x de R$ 1.100,00.'), r.ata);

r = aplicarTrechos(ATA, [{ tipo: 'inserir_apos', ancora: 'Foi apresentada a proposta da Alfa Engenharia no valor de R$ 10.000,00.', texto: 'Sem espaço no começo.' }]);
check('põe espaço quando o texto novo não começa com espaço', /10\.000,00\. Sem espaço/.test(r.ata), r.ata);

r = aplicarTrechos(ATA, [{ tipo: 'inserir_apos', ancora: 'Foi  apresentada a proposta  da Alfa\nEngenharia no valor de R$ 10.000,00.', texto: ' X.' }]);
check('âncora com espaços diferentes ainda casa', r.aplicadas === 1 && /10\.000,00\. X\./.test(r.ata), r.ata);

r = aplicarTrechos(ATA, [{ tipo: 'inserir_apos', ancora: 'Foi eleita', texto: ' X.' }]);
check('âncora curta demais falha', r.aplicadas === 0 && r.falhas === 1 && r.ata === ATA, r.ata);

r = aplicarTrechos(ATA + '\nITEM 3) Foi apresentada a proposta da Alfa Engenharia no valor de R$ 10.000,00.', [{ tipo: 'inserir_apos', ancora: 'Foi apresentada a proposta da Alfa Engenharia no valor de R$ 10.000,00.', texto: ' X.' }]);
check('âncora repetida (ambígua) falha sem mexer', r.aplicadas === 0 && r.falhas === 1, r.ata);

r = aplicarTrechos(ATA, [{ tipo: 'inserir_apos', ancora: 'Esta frase não existe na ata de jeito nenhum.', texto: ' X.' }]);
check('âncora inexistente falha', r.falhas === 1 && r.ata === ATA, r.ata);

r = aplicarTrechos(ATA, [{ tipo: 'substituir', de: 'Foi eleita a Sra. Ana.', para: 'Foi eleita a Sra. Ana Paula.' }]);
check('substitui trecho único', r.aplicadas === 1 && /Sra\. Ana Paula\. A votação/.test(r.ata), r.ata);

r = aplicarTrechos(ATA, [{ tipo: 'substituir', de: 'Foi apresentada a proposta da Alfa Engenharia no valor de R$ 10.000,00. O item foi aprovado.', para: 'Ok.' }]);
check('substituição que apaga texto é recusada', r.aplicadas === 0 && r.falhas === 1 && r.ata === ATA, r.ata);

r = aplicarTrechos(ATA, [
  { tipo: 'inserir_apos', ancora: 'Foi eleita a Sra. Ana. A votação foi unânime.', texto: ' Primeira.' },
  { tipo: 'inserir_apos', ancora: 'Foi apresentada a proposta da Alfa Engenharia no valor de R$ 10.000,00. O item foi aprovado.', texto: ' Segunda.' }
]);
check('várias operações em pontos diferentes', r.aplicadas === 2 && /unânime\. Primeira\./.test(r.ata) && /aprovado\. Segunda\./.test(r.ata), r.ata);

r = aplicarTrechos(ATA, 'não é lista');
check('entrada inválida não quebra', r.aplicadas === 0 && r.ata === ATA, r.ata);

console.log('\n===== RESULTADO: ' + ok + ' PASS, ' + fail + ' FAIL =====');
process.exit(fail ? 1 : 0);
