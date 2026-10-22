// Teste unitário do validador de [conferir: ...] (T01). Dados sintéticos, sem cliente.
// Rodar: NODE_PATH=/Users/matheusmelo/v8s/service-hub/node_modules node scripts/ata-harness/conferir-unit-test.cjs
const { validarMarcadoresConferir } = require('../../server.js');
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '  -> ' + d); } };
const DOC = 'Orçamento Xurupita Pinturas R$ 185.200,00. Proposta Zeta Engenharia R$ 13.000,00.';

let r = validarMarcadoresConferir('(i) empresa Xurupita Pinturas [conferir: transcrição dizia "Xurupa"], no valor de R$ 185.200,00.', DOC);
check('nome que está no documento mantém o marcador', r.mantidos === 1 && /\[conferir: transcrição dizia "Xurupa"\]/.test(r.ata), r.ata);

r = validarMarcadoresConferir('cobrança de R$ 107.000,00 [conferir: transcrição dizia "107 mil"].', DOC);
check('valor fora do documento perde o marcador', r.removidos === 1 && !/conferir/.test(r.ata) && /R\$ 107\.000,00\./.test(r.ata), r.ata);

r = validarMarcadoresConferir('Zeta Engenharia, R$ 13.000,00 [conferir: transcrição dizia "13 mil"; o documento oficial registra R$ 13.000,00].', DOC);
check('explicação dentro do marcador é cortada', /\[conferir: transcrição dizia "13 mil"\]/.test(r.ata) && !/documento oficial/.test(r.ata), r.ata);

r = validarMarcadoresConferir('empresa ADN Mantas [conferir: transcrição dizia "DM Mantas"] venceu.', DOC);
check('variação da própria fala (nome fora do documento) perde o marcador', r.removidos === 1 && /empresa ADN Mantas venceu/.test(r.ata), r.ata);

r = validarMarcadoresConferir('Ata sem marcador nenhum, R$ 10,00.', '');
check('sem marcador, texto idêntico', r.ata === 'Ata sem marcador nenhum, R$ 10,00.', r.ata);

// T45: datas e prazos, e marcador uma vez só por nome
const DOC2 = 'ITEM 1 Mandato complementar até 30/06/2027. ITEM 4 Vistoria Técnica OTIS. ON Soluções em Engenharia R$ 17.386,54.';
r = validarMarcadoresConferir('mandato complementar até 30 de junho de 2027 [conferir: transcrição dizia 30 de julho de 2027], eleita a Sra. Gleice.', DOC2);
check('data igual à do documento mantém o marcador', r.mantidos === 1 && /2027 \[conferir: transcrição dizia 30 de julho de 2027\]/.test(r.ata), r.ata);

r = validarMarcadoresConferir('mandato até 31 de julho de 2027 [conferir: transcrição dizia 30 de julho].', DOC2);
check('data fora do documento perde o marcador', r.removidos === 1 && !/conferir/.test(r.ata), r.ata);

r = validarMarcadoresConferir('manutenção da OTIS [conferir: transcrição dizia ótica]. Contrato com a OTIS [conferir: transcrição dizia Odisseia]. Notas da OTIS [conferir: transcrição dizia OTC].', DOC2);
check('nome repetido: marcador só na primeira menção', r.mantidos === 1 && r.removidos === 2 && (r.ata.match(/conferir/g) || []).length === 1 && /OTIS \[conferir: transcrição dizia ótica\]/.test(r.ata), r.ata);

r = validarMarcadoresConferir('laudo da ON Soluções em Engenharia [conferir: transcrição dizia On Soluções], por R$ 17.386,54 [conferir: transcrição dizia R$17,47]; nova menção à ON Soluções em Engenharia [conferir: transcrição dizia Om].', DOC2);
check('valor sempre mantém; nome só na primeira vez', r.mantidos === 2 && r.removidos === 1, r.ata);

// T47: conta dita na fala que não fecha
r = validarMarcadoresConferir('o salário mínimo vigente é de R$ 1.621,00 e o seu triplo corresponde a R$ 4.863,00 [conferir: transcrição dizia R$ 1.863].', DOC2);
check('conta que fecha (3 x 1.621 = 4.863) mantém o marcador', r.mantidos === 1 && /R\$ 4\.863,00 \[conferir: transcrição dizia R\$ 1\.863\]/.test(r.ata), r.ata);

r = validarMarcadoresConferir('honorário de três (3) salários mínimos de R$ 1.621,00, totalizando R$ 4.863,00 [conferir: transcrição dizia R$ 1.863].', DOC2);
check('quantidade por extenso também confere', r.mantidos === 1, r.ata);

r = validarMarcadoresConferir('o salário mínimo é de R$ 1.621,00 e o triplo seria R$ 5.000,00 [conferir: transcrição dizia R$ 1.863].', DOC2);
check('conta errada do gerador volta ao que foi dito, com [valor a confirmar]', r.revertidos === 1 && /triplo seria R\$ 1\.863,00 \[valor a confirmar\]\./.test(r.ata), r.ata);

r = validarMarcadoresConferir('cobrança de R$ 107.000,00 [conferir: transcrição dizia 107 mil].', DOC2);
check('forma formal do mesmo valor perde só o marcador', r.removidos === 1 && /R\$ 107\.000,00\./.test(r.ata), r.ata);

console.log('\n===== RESULTADO: ' + ok + ' PASS, ' + fail + ' FAIL =====');
process.exit(fail ? 1 : 0);
