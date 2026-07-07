/*
 * Shims minimos de DOM/window para o motor extraido rodar fora do navegador.
 * Por que: parsePlanilhaPronta em si nao toca DOM, mas o arquivo concatenado
 * (motor-extraido.js) tem trechos de topo (fora de funcao) que referenciam
 * window/location/document — ex.: "window.SH_CONDOMINIO_ATIVO = new URLSearchParams
 * (location.search)..." e "window.addEventListener('DOMContentLoaded', boot)".
 * Sem esses shims o vm.Script falha antes de expor parsePlanilhaPronta.
 */
const vm = require('vm');

// Cria um contexto vm novo por chamada — evita que estado de uma fixture vaze pra outra.
function criarContexto() {
  const contexto = {
    console,
    URLSearchParams,
    location: { search: '' },
    document: { getElementById: () => null },
    addEventListener: () => {}, // usado como window.addEventListener(...)
  };
  contexto.window = contexto; // no navegador, window aponta pro proprio escopo global
  vm.createContext(contexto);
  return contexto;
}

module.exports = { criarContexto };
