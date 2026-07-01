/* ============================================================
   Previsao Orcamentaria — ponte entre o Hub e o modulo embutido
   ------------------------------------------------------------
   Substitui o fluxo antigo (previsao.js, parser de PDF + Supabase),
   descontinuado nesta aba. Aqui o Hub apenas:
     1) mostra o banner do condominio ativo no topo do painel;
     2) carrega o modulo aprovado (public/previsao-modulo.html) dentro de
        um iframe, SO quando a aba abre (carga sob demanda, evita puxar
        o arquivo pesado no load inicial do Hub);
     3) entrega o nome do condominio ativo ao modulo via querystring.

   O modulo roda 100% no navegador, em memoria. Nenhuma planilha
   financeira de cliente sai do navegador (sem servidor, sem banco).
   ============================================================ */

// Caminho do modulo embutido. Sem persistencia em servidor por decisao de privacidade.
var PREVISAO_MODULO_URL = '/previsao-modulo.html';

// Guarda para nao recarregar o iframe a cada abertura da aba (preservaria o
// trabalho em andamento dentro do modulo). O src e definido uma unica vez.
var previsaoIframeCarregado = false;

/* previsaoInit: chamada pelo Hub (showPanel) toda vez que a aba abre.
   Atualiza o banner e garante o iframe carregado uma unica vez. */
function previsaoInit() {
  // Banner do condominio ativo (mesma funcao usada pelos demais paineis)
  if (typeof renderBannerCondAtivo === 'function') {
    try { renderBannerCondAtivo('previsao'); } catch (e) { console.warn('[previsao] banner', e); }
  }

  var iframe = document.getElementById('prev-iframe');
  if (!iframe) return;

  if (!previsaoIframeCarregado) {
    var cond = (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : null;
    var nome = (cond && cond.nome) ? cond.nome : '';
    // Passa o nome so como contexto. O modulo NAO sobrescreve com isso o nome
    // que ele mesmo extrai da planilha; ver SH_CONDOMINIO_ATIVO no modulo.
    iframe.src = PREVISAO_MODULO_URL + (nome ? ('?cond=' + encodeURIComponent(nome)) : '');
    previsaoIframeCarregado = true;
  }
}

/* Mantem o banner do painel sincronizado quando o usuario troca de condominio.
   Nao recarrega o iframe de proposito, para nao perder trabalho em andamento. */
(function () {
  function atualizarBanner() {
    var painel = document.getElementById('panel-previsao');
    if (painel && painel.classList.contains('active') && typeof renderBannerCondAtivo === 'function') {
      try { renderBannerCondAtivo('previsao'); } catch (e) {}
    }
  }
  window.addEventListener('condominioAtivo:changed', atualizarBanner);
})();
