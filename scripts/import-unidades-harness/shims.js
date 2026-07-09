/*
 * Shims minimos de DOM/window/navegador para o motor extraido de
 * public/index.html rodar fora do navegador. Por que: os parsers do painel
 * Importar Unidades em si nao tocam DOM, mas o arquivo concatenado
 * (motor-extraido.js) tem MUITO codigo de aplicacao fora de funcao isolada
 * (o resto do Service Hub inteiro: auth, prestacao, ata, despesas etc) que
 * referencia window/document/localStorage/fetch/Supabase no escopo de topo.
 * Sem esses shims o vm.Script falha antes de expor os parsers de unidades.
 * Regra de ouro: os shims sao PASSIVOS (nunca simulam dado real), servem so
 * pra o script terminar de carregar sem lancar excecao.
 */
const vm = require('vm');

// noop encadeavel: cobre padroes tipo document.getElementById(x).addEventListener(...)
function elementoFalso() {
  const el = {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    querySelector: () => elementoFalso(), querySelectorAll: () => [],
    getContext: () => null, focus() {}, blur() {}, click() {}, scrollIntoView() {},
    setAttribute() {}, getAttribute: () => null, closest: () => null,
  };
  Object.defineProperty(el, 'innerHTML', { get: () => '', set: () => {} });
  Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
  Object.defineProperty(el, 'value', { get: () => '', set: () => {} });
  return el;
}

// Cria um contexto vm novo por chamada — evita que estado de uma fixture vaze pra outra.
function criarContexto() {
  const localStorageFake = (() => {
    const store = {};
    return {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    };
  })();

  const contexto = {
    console,
    URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', href: '', pathname: '/hub', hostname: 'localhost' },
    navigator: { userAgent: 'node-harness', clipboard: { writeText: async () => {} } },
    localStorage: localStorageFake,
    sessionStorage: localStorageFake,
    document: {
      getElementById: () => elementoFalso(),
      querySelector: () => elementoFalso(),
      querySelectorAll: () => [],
      createElement: () => elementoFalso(),
      addEventListener() {}, removeEventListener() {},
      body: elementoFalso(), documentElement: elementoFalso(),
      cookie: '',
    },
    addEventListener() {}, // usado como window.addEventListener(...)
    removeEventListener() {},
    fetch: async () => { throw new Error('fetch desabilitado no harness (motor puro, sem rede)'); },
    alert() {}, confirm: () => false, prompt: () => null,
    FileReader: class { readAsArrayBuffer() {} readAsDataURL() {} },
    Blob: class { constructor() {} },
    XLSX: undefined, // o harness le as planilhas fora do vm; nenhuma funcao pura precisa de XLSX dentro do contexto
  };
  contexto.window = contexto; // no navegador, window aponta pro proprio escopo global
  vm.createContext(contexto);
  return contexto;
}

module.exports = { criarContexto };
