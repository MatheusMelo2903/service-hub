// Janela "Confirmar gravação no Superlógica" (política de gravação do servidor,
// servico/escrita-superlogica.js). Toda tela que grava no Superlógica chama
// window.gravarNoSuperlogica(url, opcoes) no lugar de apiAuthFetch: no condomínio de teste a resposta
// volta direto; nos outros o servidor responde 428 com o resumo do que vai ser gravado e um token de
// uso único. Aqui a pessoa vê o resumo, com o nome do condomínio em destaque, e só então o pedido é
// reenviado com confirmacao_gravacao { id_condominio, token, nome_digitado }. Operação sensível pede
// para digitar o nome curto do condomínio. Cancelar devolve uma resposta 499 (nada gravado).
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  // Mesma regra do servidor: sem acento, minúsculas, só letras e números.
  function normalizar(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Mostra o resumo e devolve uma promessa com { nome } (confirmou) ou null (cancelou).
  function abrirJanela(j) {
    return new Promise(function (fim) {
      var r = j.resumo || {};
      var c = j.confirmacao || {};
      var anterior = document.getElementById('confirmar-gravacao');
      if (anterior) anterior.remove();
      var fundo = document.createElement('div');
      fundo.id = 'confirmar-gravacao';
      fundo.className = 'modal-overlay open';
      fundo.style.zIndex = '1000';
      fundo.setAttribute('role', 'dialog');
      fundo.setAttribute('aria-modal', 'true');
      fundo.setAttribute('aria-labelledby', 'cg-titulo');
      var linhas = (r.linhas || []).map(function (l) {
        return '<tr><td style="padding:4px 10px 4px 0;color:var(--muted);vertical-align:top;white-space:nowrap">' + esc(l.rotulo) + '</td><td style="padding:4px 0;word-break:break-word">' + esc(l.valor) + '</td></tr>';
      }).join('');
      var avisoMotivo = j.motivo && j.detalhe ? '<div style="font-size:12px;color:var(--warning);margin-bottom:10px">' + esc(j.detalhe) + '</div>' : '';
      var reforcada = c.reforcada === true && c.nome_curto;
      fundo.innerHTML = '<div class="modal" style="width:560px;max-width:95vw;max-height:90vh;overflow:auto">'
        + '<div class="modal-title" id="cg-titulo">Confirmar gravação no Superlógica</div>'
        + '<div class="modal-sub" style="margin-bottom:12px">' + esc(r.operacao || 'Gravação') + '</div>'
        + avisoMotivo
        + '<div style="border:2px solid var(--accent);border-radius:var(--radius);padding:12px 14px;margin-bottom:14px;background:var(--gs-blue-light)">'
        + '<div style="font-size:11px;font-family:var(--mono);color:var(--muted);margin-bottom:4px">CONDOMÍNIO</div>'
        + '<div style="font-size:18px;font-weight:700;color:var(--text)">' + esc(r.condominio || '') + '</div></div>'
        + (linhas ? '<table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:10px">' + linhas + '</table>' : '')
        + (r.quantidade > 1 ? '<div style="font-size:13px;margin-bottom:8px"><b>' + esc(r.quantidade) + '</b> itens serão gravados.</div>' : '')
        + (r.aviso ? '<div style="font-size:12px;color:var(--warning);margin-bottom:8px">' + esc(r.aviso) + '</div>' : '')
        + (reforcada ? '<label style="display:block;font-size:13px;margin:10px 0 6px">Operação sensível. Para confirmar, digite o nome do condomínio: <b>' + esc(c.nome_curto) + '</b></label>'
          + '<input id="cg-nome" type="text" autocomplete="off" spellcheck="false" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);font-size:14px">' : '')
        + '<div style="font-size:11px;color:var(--muted);margin-top:10px">Nada é gravado antes de você confirmar. A confirmação vale só para este pedido, por ' + esc(c.validade_min || 10) + ' minutos.</div>'
        + '<div class="modal-actions"><button type="button" class="btn btn-ghost" id="cg-cancelar">Cancelar</button>'
        + '<button type="button" class="btn btn-primary" id="cg-confirmar"' + (reforcada ? ' disabled' : '') + '>Gravar no Superlógica</button></div></div>';
      document.body.appendChild(fundo);
      var bConf = fundo.querySelector('#cg-confirmar');
      var campo = fundo.querySelector('#cg-nome');
      function fechar(v) {
        document.removeEventListener('keydown', tecla, true);
        fundo.remove();
        fim(v);
      }
      function tecla(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); fechar(null); }
        if (ev.key === 'Enter' && !bConf.disabled && document.activeElement !== fundo.querySelector('#cg-cancelar')) { ev.preventDefault(); fechar({ nome: campo ? campo.value : '' }); }
      }
      document.addEventListener('keydown', tecla, true);
      fundo.querySelector('#cg-cancelar').addEventListener('click', function () { fechar(null); });
      bConf.addEventListener('click', function () { if (!bConf.disabled) fechar({ nome: campo ? campo.value : '' }); });
      if (campo) {
        campo.addEventListener('input', function () { bConf.disabled = normalizar(campo.value) !== normalizar(c.nome_curto); });
        setTimeout(function () { campo.focus(); }, 0);
      } else setTimeout(function () { bConf.focus(); }, 0);
    });
  }

  function respostaCancelada() {
    return new Response(JSON.stringify({ erro: 'gravacao_cancelada', detalhe: 'Gravação cancelada. Nada foi gravado no Superlógica.' }), { status: 499, headers: { 'Content-Type': 'application/json' } });
  }

  // Igual ao apiAuthFetch, mas trata o 428 da política de gravação com a janela de confirmação.
  async function gravarNoSuperlogica(url, opcoes) {
    var opt = opcoes || {};
    var corpo = null;
    try { corpo = opt.body ? JSON.parse(opt.body) : {}; } catch (e) { corpo = null; }
    var r = await apiAuthFetch(url, opt);
    for (var volta = 0; volta < 4; volta++) {
      if (r.status !== 428 || !corpo || typeof corpo !== 'object') return r;
      var j = await r.clone().json().catch(function () { return null; });
      if (!j || j.erro !== 'confirmacao_necessaria' || !j.confirmacao || !j.confirmacao.token) return r;
      var escolha = await abrirJanela(j);
      if (!escolha) return respostaCancelada();
      corpo.confirmacao_gravacao = { id_condominio: j.confirmacao.id_condominio, token: j.confirmacao.token, nome_digitado: escolha.nome || undefined };
      r = await apiAuthFetch(url, Object.assign({}, opt, { body: JSON.stringify(corpo) }));
    }
    return r;
  }

  window.gravarNoSuperlogica = gravarNoSuperlogica;
  window.ConfirmarGravacao = { abrir: abrirJanela, gravar: gravarNoSuperlogica, normalizar: normalizar };
})();
