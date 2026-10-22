// Regras do Condomínio: troca de abas internas do painel. Cada parte (consulta, notificações,
// documentos, mandatos, importação) monta a própria tela no seu contêiner e escuta o evento
// 'regras-aba' para carregar só quando aparece. O servidor confere a permissão em cada rota;
// aqui só decide o que mostrar.
var REGRAS_ABAS = ['consulta', 'notificacao', 'acervo', 'mandatos', 'importar'];
// Ação do módulo "regras" que cada aba exige (GESTOR vê tudo; importar é só do GESTOR).
var REGRAS_ACAO_ABA = { consulta: 'consultar', notificacao: 'notificar', acervo: 'ver', mandatos: 'ver', importar: null };
var regrasAbaAtual = 'consulta';

function regrasPode(acao) {
  if (window.USER_ROLE === 'GESTOR') return true;
  if (!acao) return false;
  var m = window.USER_PERMS && window.USER_PERMS.regras;
  return !!(m && m.visivel === true && Array.isArray(m.acoes) && m.acoes.indexOf(acao) >= 0);
}

// Mostra só as abas que o usuário pode usar; se a atual sumiu, vai para a primeira liberada.
function regrasAplicarVisibilidade() {
  var primeira = null;
  REGRAS_ABAS.forEach(function (nome) {
    var ok = regrasPode(REGRAS_ACAO_ABA[nome]);
    var tab = document.getElementById('regras-tab-' + nome);
    if (tab) tab.style.display = ok ? '' : 'none';
    if (ok && !primeira) primeira = nome;
  });
  if (!regrasPode(REGRAS_ACAO_ABA[regrasAbaAtual]) && primeira) regrasAba(primeira);
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
  try { window.dispatchEvent(new CustomEvent('regras-aba', { detail: nome })); } catch (e) { /* navegador antigo: as partes carregam no próprio clique */ }
}

// Ao abrir o painel, confere as abas e avisa a parte visível (para carregar os dados).
(function () {
  var original = window.showPanel;
  if (typeof original !== 'function') return;
  window.showPanel = function (nome) {
    var r = original.apply(this, arguments);
    var painel = document.getElementById('panel-regras');
    if (painel && painel.classList.contains('active')) {
      regrasAplicarVisibilidade();
      regrasAba(regrasAbaAtual);
    }
    return r;
  };
})();
