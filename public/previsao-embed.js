/* ============================================================
   Previsao Orcamentaria — ponte entre o Hub e o modulo embutido
   ------------------------------------------------------------
   Substitui o fluxo antigo (previsao.js, parser de PDF + Supabase),
   descontinuado nesta aba. Aqui o Hub:
     1) mostra o banner do condominio ativo no topo do painel;
     2) carrega o modulo aprovado (public/previsao-modulo.html) dentro de
        um iframe, SO quando a aba abre (carga sob demanda, evita puxar
        o arquivo pesado no load inicial do Hub);
     3) entrega o nome do condominio ativo ao modulo via querystring;
     4) liga o modulo a pastinha "Em andamento" (window.Trabalhos, T49).

   Guarda da previsao (T49): a previsao em andamento vai para o banco do Hub
   (por pessoa, some com Encerrar ou 7 dias sem mexer) para nao se perder ao
   recarregar, trocar de condominio ou de computador. Nunca vai para o Superlogica.

   Como a ponte funciona: o iframe e da mesma origem e sem sandbox, entao os dois
   lados se chamam direto, sem postMessage.
     Modulo -> Hub: window.parent.PrevisaoHub (definido aqui): salvar, encerrar,
       lista, abrir, condominio, avisar.
     Hub -> Modulo: iframe.contentWindow.PrevisaoPonte (definido no modulo):
       restaurar, guardarAgora, listaMudou, encerradoFora.
   Cada carga do iframe ganha um numero (?g=N). O Hub so conversa com o modulo
   cujo PrevisaoPonte.geracao bate com o numero atual, para nunca restaurar
   dentro de uma pagina velha que esta sendo trocada.
   ============================================================ */

// Caminho do modulo embutido.
var PREVISAO_MODULO_URL = '/previsao-modulo.html';

// Guarda para nao recarregar o iframe a cada abertura da aba (preservaria o
// trabalho em andamento dentro do modulo). O src e definido uma unica vez.
var previsaoIframeCarregado = false;

// Numero da carga atual do iframe e condominio para o qual ela foi aberta.
// O condominio fica preso a carga (e nao ao seletor) porque, na troca, o modulo
// ainda guarda a previsao do condominio anterior antes de recarregar.
var previsaoGeracao = 0;
var previsaoCondCarregado = null;

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
    previsaoCondCarregado = cond ? { nome: cond.nome || '', id_superlogica: cond.id_superlogica || null } : null;
    previsaoGeracao++;
    // Passa o nome so como contexto. O modulo NAO sobrescreve com isso o nome
    // que ele mesmo extrai da planilha; ver SH_CONDOMINIO_ATIVO no modulo.
    iframe.src = PREVISAO_MODULO_URL + '?g=' + previsaoGeracao + (nome ? ('&cond=' + encodeURIComponent(nome)) : '');
    previsaoIframeCarregado = true;
  }
}

/* Devolve a ponte do modulo SO se for a carga atual e ja tiver terminado de iniciar. */
function previsaoPonte() {
  try {
    var f = document.getElementById('prev-iframe');
    var p = f && f.contentWindow && f.contentWindow.PrevisaoPonte;
    if (p && p.pronto && String(p.geracao) === String(previsaoGeracao)) return p;
  } catch (e) {}
  return null;
}

/* Espera o modulo da carga atual ficar pronto. O arquivo e pesado (bibliotecas
   embutidas), entao a espera e longa; desiste com mensagem clara. */
function previsaoEsperarModulo(ms) {
  return new Promise(function (ok, falha) {
    var t0 = Date.now();
    (function tenta() {
      var p = previsaoPonte();
      if (p) return ok(p);
      if (Date.now() - t0 > ms) return falha(new Error('a tela da previsão demorou para abrir. Tente abrir de novo.'));
      setTimeout(tenta, 150);
    })();
  });
}

/* O que o modulo pode pedir ao Hub. Tudo que envolve o condominio usa o da
   carga atual (previsaoCondCarregado), lido na hora da chamada. */
window.PrevisaoHub = {
  condominio: function () { return previsaoCondCarregado; },
  salvar: function (o) {
    if (!window.Trabalhos) return Promise.reject(new Error('pasta Em andamento indisponível'));
    var c = previsaoCondCarregado;
    return Trabalhos.salvar('previsao', { id: o.id || undefined, idSuperlogica: c ? c.id_superlogica : null, titulo: o.titulo, dados: o.dados });
  },
  encerrar: function (id) {
    if (!window.Trabalhos) return Promise.resolve(false);
    return Trabalhos.encerrar(id, { perguntar: true });
  },
  // Previsoes guardadas do condominio desta carga (sem os dados pesados).
  lista: function () {
    if (!window.Trabalhos) return [];
    var c = previsaoCondCarregado;
    var alvo = c && c.id_superlogica != null ? String(c.id_superlogica) : '';
    return Trabalhos.lista().filter(function (t) {
      return t.tipo === 'previsao' && String(t.id_superlogica == null ? '' : t.id_superlogica) === alvo;
    });
  },
  abrir: function (id) { if (window.Trabalhos) return Trabalhos.abrir(id); },
  avisar: function (m, tipo) { if (typeof toast === 'function') toast(m, tipo || 'info'); }
};

/* Registra o tipo "previsao" na pastinha. A pastinha ja troca o condominio e chama
   showPanel('previsao') antes de restaurar; a troca recarrega o iframe, por isso
   restaurar espera a carga nova ficar pronta antes de entregar os dados. */
(function registrarNaPasta() {
  function registrar() {
    if (!window.Trabalhos) return false;
    Trabalhos.registrar('previsao', {
      nome: 'Previsão orçamentária',
      painel: 'previsao',
      restaurar: async function (t) {
        // Deixa rodar o previsaoInit que a troca de condominio agenda com setTimeout(0).
        await new Promise(function (r) { setTimeout(r, 0); });
        if (!previsaoIframeCarregado) previsaoInit();
        var ponte = await previsaoEsperarModulo(60000);
        ponte.restaurar(t);
      }
    });
    return true;
  }
  if (!registrar()) window.addEventListener('DOMContentLoaded', registrar);
})();

/* Mantem o banner do painel sincronizado quando o usuario troca de condominio.
   Troca de condominio (T02) recarrega o modulo, com aviso: o que estava nele era do anterior. */
(function () {
  function atualizarBanner() {
    var painel = document.getElementById('panel-previsao');
    if (painel && painel.classList.contains('active') && typeof renderBannerCondAtivo === 'function') {
      try { renderBannerCondAtivo('previsao'); } catch (e) {}
    }
  }
  window.addEventListener('condominioAtivo:changed', atualizarBanner);

  // T02: trocou de condomínio, o que estava no módulo era do anterior. Antes de
  // recarregar, guarda a previsão na pasta Em andamento (T49) para não perder.
  // Recarrega o módulo com o nome novo (agora, se a aba estiver aberta; senão na próxima abertura).
  window.addEventListener('condominioAtivo:trocou', function () {
    var iframe = document.getElementById('prev-iframe');
    if (!iframe || !previsaoIframeCarregado) return;
    var guardou = false;
    var p = previsaoPonte();
    // guardarAgora monta os dados e dispara o envio de forma sincrona; o envio
    // roda pela janela do Hub, entao sobrevive ao iframe recarregar logo abaixo.
    if (p) { try { guardou = !!p.guardarAgora(); } catch (e) { console.warn('[previsao] guardar na troca', e); } }
    previsaoIframeCarregado = false;
    if (typeof toast === 'function') toast('Previsão orçamentária reiniciada: o condomínio mudou.' + (guardou ? ' A anterior ficou na pasta Em andamento.' : ''), 'info');
    var painel = document.getElementById('panel-previsao');
    iframe.removeAttribute('src');
    if (painel && painel.classList.contains('active')) setTimeout(previsaoInit, 0);
  });

  // Pastinha releu a lista: o modulo atualiza "Previsões salvas" e percebe se a
  // previsao aberta foi encerrada em outra aba ou computador.
  window.addEventListener('trabalhos:lista', function (ev) {
    var p = previsaoPonte();
    if (p) { try { p.listaMudou(ev.detail || []); } catch (e) {} }
  });
  // Encerrada pela pastinha: o modulo solta a previsao para nao guardar de novo sozinho.
  window.addEventListener('trabalhos:encerrado', function (ev) {
    var p = previsaoPonte();
    if (p && ev.detail && ev.detail.id) { try { p.encerradoFora(ev.detail.id); } catch (e) {} }
  });
})();
