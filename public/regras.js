// Comunicados e Multas (painel unificado, id regras): troca de abas internas do painel. Cada parte
// (notificações e multas, comunicados, consulta, documentos, mandatos, importação) monta a própria
// tela no seu contêiner e escuta o evento 'regras-aba' para carregar só quando aparece. O servidor
// confere a permissão em cada rota; aqui só decide o que mostrar.
var REGRAS_ABAS = ['notificacao', 'comunicados', 'consulta', 'acervo', 'mandatos', 'importar'];
// Ação do módulo "regras" que cada aba exige (GESTOR vê tudo; importar é só do GESTOR).
// A aba comunicados não é do módulo regras: segue a permissão do antigo painel de comunicados.
var REGRAS_ACAO_ABA = { notificacao: 'notificar', consulta: 'consultar', acervo: 'ver', mandatos: 'ver', importar: null };
var regrasAbaAtual = 'notificacao';

function regrasPode(acao) {
  if (window.USER_ROLE === 'GESTOR') return true;
  if (!acao) return false;
  var m = window.USER_PERMS && window.USER_PERMS.regras;
  return !!(m && m.visivel === true && Array.isArray(m.acoes) && m.acoes.indexOf(acao) >= 0);
}

// Uma aba está liberada? Comunicados usa a regra de comunicados.js (cargo GESTOR ou GERENTE).
function regrasPodeAba(nome) {
  if (nome === 'comunicados') return typeof comunicadosPode === 'function' ? comunicadosPode() : window.USER_ROLE === 'GESTOR';
  return regrasPode(REGRAS_ACAO_ABA[nome]);
}

function regrasPrimeiraAba() {
  for (var i = 0; i < REGRAS_ABAS.length; i++) if (regrasPodeAba(REGRAS_ABAS[i])) return REGRAS_ABAS[i];
  return null;
}

// Mostra só as abas que o usuário pode usar; se a atual sumiu, vai para a primeira liberada.
function regrasAplicarVisibilidade() {
  REGRAS_ABAS.forEach(function (nome) {
    var tab = document.getElementById('regras-tab-' + nome);
    if (tab) tab.style.display = regrasPodeAba(nome) ? '' : 'none';
  });
  var primeira = regrasPrimeiraAba();
  if (!regrasPodeAba(regrasAbaAtual) && primeira) regrasAba(primeira);
}

function regrasAba(nome) {
  if (REGRAS_ABAS.indexOf(nome) < 0) return;
  regrasAbaAtual = nome;
  REGRAS_ABAS.forEach(function (n) {
    var tab = document.getElementById('regras-tab-' + n);
    var parte = document.getElementById('regras-' + n);
    if (tab) tab.classList.toggle('active', n === nome);
    if (parte) parte.style.display = n === nome ? '' : 'none';
  });
  // Elementos fora do contêiner da aba (como a dica de Notificações e multas) seguem a aba também.
  document.querySelectorAll('#panel-regras [data-regras-aba]').forEach(function (el) {
    el.style.display = el.getAttribute('data-regras-aba') === nome ? '' : 'none';
  });
  try { window.dispatchEvent(new CustomEvent('regras-aba', { detail: nome })); } catch (e) { /* navegador antigo: as partes carregam no próprio clique */ }
}

// Ao abrir o painel, confere as abas e escolhe a aba: showPanel('comunicados') (alertas, links,
// tela lembrada do sistema antigo) cai na aba Comunicados; showPanel('regras') abre na primeira
// aba liberada para a pessoa. Depois avisa a parte visível (para carregar os dados).
(function () {
  var original = window.showPanel;
  if (typeof original !== 'function') return;
  window.showPanel = function (nome) {
    var r = original.apply(this, arguments);
    var painel = document.getElementById('panel-regras');
    if (painel && painel.classList.contains('active')) {
      regrasAplicarVisibilidade();
      var alvo = (nome === 'comunicados' && regrasPodeAba('comunicados')) ? 'comunicados' : regrasPrimeiraAba();
      regrasAba(alvo || regrasAbaAtual);
    }
    return r;
  };
})();
