// Testes da leitura do caso contado na aba Notificações e multas (funções puras do navegador):
// achar a unidade e a data no texto livre. Sem rede: node scripts/teste-regras-caso.js
// Carrega public/regras-notificacao.js num contexto isolado com uma janela falsa e usa
// window.regrasCaso (acharUnidades, acharData).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const codigo = fs.readFileSync(path.join(__dirname, '..', 'public', 'regras-notificacao.js'), 'utf8');
const janela = { addEventListener() {} };
const ctx = vm.createContext({ window: janela, document: {}, console });
vm.runInContext(codigo, ctx, { filename: 'regras-notificacao.js' });
const RC = janela.regrasCaso;

let ok = 0, falhou = 0;
function t(nome, cond, extra) {
  if (cond) { ok++; console.log('ok   ' + nome); }
  else { falhou++; console.log('FALHOU ' + nome + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const ids = (lista) => lista.map((u) => u.id_unidade).sort((a, b) => a - b);
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Prédio com blocos.
const PREDIO = [
  { id_unidade: 1, unidade: '302', bloco: 'D', rotulo: '302 D' },
  { id_unidade: 2, unidade: '302', bloco: 'A', rotulo: '302 A' },
  { id_unidade: 3, unidade: '402', bloco: 'D', rotulo: '402 D' },
  { id_unidade: 4, unidade: '101', bloco: 'Bloco A', rotulo: '101 Bloco A' },
  { id_unidade: 5, unidade: '0102', bloco: 'Torre 2', rotulo: '0102 Torre 2' },
  { id_unidade: 6, unidade: '1302', bloco: 'D', rotulo: '1302 D' },
];
// Condomínio de casas, sem bloco.
const CASAS = [
  { id_unidade: 15, unidade: 'Casa 15', bloco: '', rotulo: 'Casa 15' },
  { id_unidade: 18, unidade: 'Casa 18', bloco: '', rotulo: 'Casa 18' },
  { id_unidade: 22, unidade: 'Casa 22', bloco: '', rotulo: 'Casa 22' },
  { id_unidade: 3, unidade: '3', bloco: '', rotulo: '3' },
  { id_unidade: 150, unidade: '150', bloco: '', rotulo: '150' },
  { id_unidade: 151, unidade: '15A', bloco: '', rotulo: '15A' },
];

// ─── Unidade ───
const casosUnidade = [
  ['exemplo da tela', 'o morador do 302 bloco D fez barulho alto depois das 22h no sábado, 18/10.', PREDIO, [1]],
  ['apto e bloco por extenso', 'Barulho no apto 302 bloco D ontem', PREDIO, [1]],
  ['número e letra com espaço', 'unidade 302 D deixou lixo no corredor', PREDIO, [1]],
  ['letra colada', 'o 302D estacionou na vaga errada', PREDIO, [1]],
  ['letra com traço', 'morador do 302-D', PREDIO, [1]],
  ['letra antes do número', 'reclamação contra o D302', PREDIO, [1]],
  ['bloco antes do número', 'bloco D, apartamento 302, som alto', PREDIO, [1]],
  ['letra minúscula', 'barulho no 302 d', PREDIO, [1]],
  ['sem bloco: as duas 302', 'barulho no 302 de madrugada', PREDIO, [1, 2]],
  ['duas unidades citadas', 'o 302 e o 402 do bloco D brigaram', PREDIO, [1, 3]],
  ['nenhuma unidade', 'barulho na garagem perto da portaria', PREDIO, []],
  ['unidade 101 A', 'unidade 101 A com vazamento', PREDIO, [4]],
  ['bloco A por extenso (A também é artigo)', 'o morador do 302 bloco A deixou o cachorro solto na área da piscina ontem', PREDIO, [2]],
  ['bloco a minúsculo', 'apto 302 bloco a com vazamento', PREDIO, [2]],
  ['torre e zero à esquerda', 'apto 0102 torre 2', PREDIO, [5]],
  ['torre sem zero', '102 torre 2 com obra fora do horário', PREDIO, [5]],
  ['1302 não vira 302', 'apto 1302 bloco D', PREDIO, [6]],
  ['casa por extenso', 'o morador da casa 15 deixou o cachorro solto', CASAS, [15]],
  ['hora, data e valor não viram casa', 'o morador da casa 15 fez barulho depois das 22h no dia 18/10, multa de R$ 150', CASAS, [15]],
  ['quantidade não vira casa', '3 cachorros soltos na casa 15', CASAS, [15]],
  ['número curto com palavra', 'barulho no 18 ontem', CASAS, [18]],
  ['letra que faz parte da unidade', 'casa 15A com som alto', CASAS, [151]],
  ['número solto curto não conta com outro forte', 'casa 22 reclamou 3 vezes do vizinho', CASAS, [22]],
];
casosUnidade.forEach(([nome, texto, lista, esperado]) => {
  const r = ids(RC.acharUnidades(texto, lista));
  t('unidade: ' + nome, igual(r, esperado), r);
});
t('unidade: lista vazia', RC.acharUnidades('apto 302', []).length === 0);
t('chave do número tira prefixo e zero', RC.chaveNumero('Apto 0302') === '302' && RC.chaveNumero('Casa 15A') === '15a' && RC.chaveNumero('Portaria') === '');
t('chave do bloco tira a palavra e o zero', RC.chaveBloco('Bloco D') === 'd' && RC.chaveBloco('Torre 02') === '2' && RC.chaveBloco('') === '');

// ─── Data (hoje: sexta feira, 23/10/2026) ───
const HOJE = new Date(2026, 9, 23);
const casosData = [
  ['dd/mm', 'barulho em 18/10', '18/10/2026', false],
  ['dd/mm/aaaa', 'barulho em 18/10/2026', '18/10/2026', false],
  ['dd/mm/aa', 'barulho em 18/10/26', '18/10/2026', false],
  ['domingo bate com 18/10', 'no domingo, 18/10, som alto', '18/10/2026', false],
  ['sábado não bate com 18/10', 'o morador do 302 bloco D fez barulho alto depois das 22h no sábado, 18/10.', '18/10/2026', true],
  ['dd/mm no futuro é do ano passado', 'aconteceu em 25/12', '25/12/2025', false],
  ['por extenso', 'no dia 18 de outubro', '18/10/2026', false],
  ['dia do mês', 'no dia 20 teve festa', '20/10/2026', false],
  ['dia do mês no futuro é do mês passado', 'no dia 28 teve festa', '28/09/2026', false],
  ['hoje', 'hoje de manhã o cachorro latiu', '23/10/2026', false],
  ['ontem', 'ontem à noite', '22/10/2026', false],
  ['anteontem', 'anteontem à noite', '21/10/2026', false],
  ['sábado', 'no sábado teve festa', '17/10/2026', false],
  ['segunda feira', 'na segunda-feira de manhã', '19/10/2026', false],
  ['sexta (hoje) vira a semana passada e pede confirmação', 'na sexta teve festa', '16/10/2026', true],
  ['ontem e dia da semana que bate', 'ontem, quinta, teve festa', '22/10/2026', false],
];
casosData.forEach(([nome, texto, data, confirmar]) => {
  const r = RC.acharData(texto, HOJE);
  t('data: ' + nome, r.data === data && r.confirmar === confirmar, r);
});
[
  ['sem data', 'barulho alto depois das 22h'],
  ['"segunda vez" não é dia da semana', 'é a segunda vez que isso acontece'],
  ['duas datas diferentes', 'barulho em 18/10 e de novo em 19/10'],
  ['data inválida', 'aconteceu em 31/02'],
  ['unidade com barra não é data', 'apto 302/D'],
].forEach(([nome, texto]) => {
  const r = RC.acharData(texto, HOJE);
  t('data vazia: ' + nome, r.data === null && r.confirmar === true && !!r.motivo, r);
});

console.log('\n' + ok + ' ok, ' + falhou + ' falha(s)');
process.exit(falhou ? 1 : 0);
