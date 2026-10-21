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

console.log('\n===== RESULTADO: ' + ok + ' PASS, ' + fail + ' FAIL =====');
process.exit(fail ? 1 : 0);
