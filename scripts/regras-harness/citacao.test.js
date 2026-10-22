// Harness da conferência de citação: pedaços curtos entre reticências não podem montar regra falsa.
const assert = require('assert');
const c = require('../../servico/regras/citacao');
const M = require('../../servico/regras/mandatos');
const t = 'O infrator pagará multa de 20% da taxa ordinária do mês anterior, e o prazo para regularizar é de 5 dias corridos.';
let ok = 0;
const caso = (nome, f) => { f(); ok++; console.log('ok  ', nome); };
caso('número inventado entre reticências é recusado', () => assert.strictEqual(c.citacaoExiste('pagará multa de ... 50 ... da taxa ordinária', t), false));
caso('prazo inventado entre reticências é recusado', () => assert.strictEqual(c.citacaoExiste('prazo ... 30 ... dias', t), false));
caso('citação contínua curta passa', () => assert.strictEqual(c.citacaoExiste('multa de 20% da taxa', t), true));
caso('dois pedaços longos e em ordem passam', () => assert.strictEqual(c.citacaoExiste('O infrator pagará multa de 20% ... prazo para regularizar é de 5 dias', t), true));
caso('duração do mandato só dentro de um pedaço', () => {
  assert.strictEqual(M.mesesDaCitacao('mandato ... 4 ... anos'), null);
  assert.strictEqual(M.mesesDaCitacao('com mandato de dois anos, permitida a reeleição'), 24);
});
console.log(ok + ' passaram');
