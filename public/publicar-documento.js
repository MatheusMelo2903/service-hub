// ============================================================
// PUBLICAR PELO HUB (prestação de contas arquivada e balancete 900A)
// PublicarSL.painel(host, opcoes) desenha a escolha "Publicar sem avisar os moradores" (padrão) ou
// "Publicar e avisar os moradores", o botão que publica pelo Hub e, como segunda opção, o botão
// Abrir no Superlógica. Com o documento já publicado, oferece retirar a publicação (corrigir erro).
// A gravação passa pela janela de confirmação (confirmar-gravacao.js): fora do condomínio de teste a
// pessoa vê o resumo, com o aviso em destaque, e digita o nome do condomínio.
// opcoes: { url, corpo, publicado, idSuperlogica, nomeCond, aoTerminar(j) }
// ============================================================
(function () {
  var seq = 0;
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  // Desenha o painel conforme o documento está publicado ou não.
  function painel(host, o) {
    if (!host) return;
    o = o || {};
    var nome = 'pub-aviso-' + (++seq);
    if (o.publicado) {
      host.innerHTML = '<div class="pub-sl" style="margin-top:10px;padding:10px 12px;border:1px solid var(--border2);border-radius:8px;font-size:12px">'
        + '<b>Publicado para os condôminos.</b>'
        + '<div style="margin-top:6px"><button type="button" class="btn btn-ghost pub-tirar" style="font-size:12px;padding:5px 10px">Retirar a publicação</button>'
        + ' <span class="hint">Só para corrigir uma publicação errada.</span></div>'
        + '<div class="pub-status" style="margin-top:6px"></div></div>';
      var bt = host.querySelector('.pub-tirar');
      var confirmar = false;
      bt.addEventListener('click', function () {
        if (!confirmar) { confirmar = true; bt.textContent = 'Clique de novo para retirar'; return; }
        enviar(host, o, 'despublicar', false, bt);
      });
      return;
    }
    host.innerHTML = '<div class="pub-sl" style="margin-top:10px;padding:10px 12px;border:1px solid var(--border2);border-radius:8px;font-size:12px">'
      + '<b>Publicar para os condôminos</b>'
      + '<div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">'
      + '<label style="cursor:pointer"><input type="radio" name="' + nome + '" value="nao" checked> Publicar sem avisar os moradores</label>'
      + '<label style="cursor:pointer"><input type="radio" name="' + nome + '" value="sim"> Publicar e avisar os moradores (o Superlógica manda o aviso)</label></div>'
      + '<button type="button" class="btn btn-primary pub-ir" style="font-size:12px;padding:6px 12px;margin-top:8px">Publicar sem avisar os moradores</button>'
      + '<div class="pub-status" style="margin-top:6px"></div>'
      + '<div class="pub-alt"></div></div>';
    var b = host.querySelector('.pub-ir');
    var avisar = function () { var r = host.querySelector('input[name="' + nome + '"]:checked'); return !!(r && r.value === 'sim'); };
    host.querySelectorAll('input[name="' + nome + '"]').forEach(function (r) {
      r.addEventListener('change', function () { b.textContent = avisar() ? 'Publicar e avisar os moradores' : 'Publicar sem avisar os moradores'; });
    });
    b.addEventListener('click', function () { enviar(host, o, 'publicar', avisar(), b); });
    if (window.AbrirSuperlogica) {
      AbrirSuperlogica.botao(host.querySelector('.pub-alt'), { rotulo: 'Ou abrir no Superlógica e publicar lá', destino: 'documentos', idSuperlogica: o.idSuperlogica, nomeCond: o.nomeCond, passos: AbrirSuperlogica.PASSOS_PUBLICAR });
    }
  }

  // Manda o pedido pela janela de confirmação e mostra o resultado.
  async function enviar(host, o, acao, avisar, botao) {
    var st = host.querySelector('.pub-status');
    function falar(t, cor) { if (st) { st.style.color = cor || 'var(--muted)'; st.textContent = t; } }
    botao.disabled = true;
    falar(acao === 'publicar' ? 'Publicando e conferindo no Superlógica...' : 'Retirando a publicação e conferindo...');
    try {
      var r = await (window.gravarNoSuperlogica || apiAuthFetch)(o.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, o.corpo || {}, { acao: acao, avisar: acao === 'publicar' ? avisar : false })) });
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 499) { falar(j.detalhe || 'Cancelado. Nada foi publicado.'); botao.disabled = false; return; }
      if (r.status === 202) { falar(j.detalhe || 'Sem confirmação ainda.', 'var(--warning)'); return; }
      if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
      if (typeof window.toast === 'function') window.toast(acao === 'publicar' ? 'Publicado' : 'Publicação retirada', 'ok');
      painel(host, Object.assign({}, o, { publicado: acao === 'publicar' }));
      var st2 = host.querySelector('.pub-status');
      if (st2) { st2.style.color = 'var(--success)'; st2.textContent = j.detalhe || 'Feito.'; }
      if (typeof o.aoTerminar === 'function') o.aoTerminar(j);
    } catch (e) {
      falar(e.message || String(e), 'var(--danger)');
      botao.disabled = false;
    }
  }

  window.PublicarSL = { painel: painel };
})();
