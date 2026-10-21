// Módulo de leitura do Superlógica no servidor. Reaproveita o cliente com retry e
// paralelismo de superlogica-dados.js; aqui ficam as consultas por condomínio
// usadas pelas abas (cadastro hoje; saldo, despesas e inadimplência nas próximas tarefas).

const slDados = require('../superlogica-dados');
const cadastro = require('./cadastro');

let _cliente = null;
let _chaveCliente = '';

// Um cliente por conjunto de credenciais (as chaves só existem aqui no servidor).
function cliente({ base, appToken, accessToken }) {
  const chave = base + '|' + appToken + '|' + accessToken;
  if (!_cliente || _chaveCliente !== chave) {
    _cliente = slDados.criarCliente({ base, appToken, accessToken });
    _chaveCliente = chave;
  }
  return _cliente;
}

// Código do Superlógica: inteiro positivo, no máximo 9 dígitos.
function idValido(v) {
  return /^[1-9][0-9]{0,8}$/.test(String(v || ''));
}

const consulta = require('./consulta');

module.exports = {
  cliente,
  idValido,
  consulta,
  buscarCadastro: (cli, id, opts) => cadastro.buscarCadastro(cli, id, opts),
  montarCadastro: cadastro.montarCadastro,
};
