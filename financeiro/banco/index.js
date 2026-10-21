'use strict';
// Conector do banco (T36): ponto único para o servidor. Hoje só a rota de status usa;
// os leitores ficam prontos para a conciliação (T35) e para a conferência de pagamentos.
const sicoob = require('./sicoob');
const extrato = require('./extrato');
const cnab240 = require('./cnab240');
const dda = require('./dda');

// Status sem rede e sem nenhum valor de credencial: só se está ligado e o nome do que falta.
function statusConector(env) {
  return {
    sicoob: sicoob.status(env),
    leitores: {
      retorno_pagamento_cnab240: 'pronto',
      extrato_cnab240: 'pronto',
      extrato_ofx: 'pronto',
      dda: 'interface pronta; formato a definir com o banco',
    },
    conferencias: ['pagamento x despesa (código de barras, valor e data)', 'saldo do extrato', 'DDA x despesas'],
  };
}

module.exports = { statusConector, sicoob, extrato, cnab240, dda };
