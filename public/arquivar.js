// ============================================================
// ARQUIVAR NO SUPERLÓGICA (T12)
// Depois de gerar a ata ou a prestação de contas, um painel deixa mandar o PDF para
// os documentos do condomínio no Superlógica (sem publicar para os condôminos; quem
// publica é a equipe no Superlógica). Servidor: POST /api/condominio/:id/documentos.
// Uso: ArquivarSL.mostrar(hostId, { tipo, titulo, idSuperlogica, nomeCond, pdfBase64: async () => b64 })
// ============================================================
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function mostrar(hostId, o) {
    var host = document.getElementById(hostId);
    if (!host) return;
    host._arq = o;
    host._arqEnviando = false;
    var semCodigo = !o.idSuperlogica;
    host.style.display = 'block';
    host.innerHTML =
      '<div class="arq-sl" style="margin:12px 0;padding:12px 14px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:12px;color:var(--text)">'
      + '<div style="font-weight:700;margin-bottom:6px">Arquivar no Superlógica</div>'
      + (semCodigo
        ? '<div style="color:var(--danger)">Este condomínio não tem código do Superlógica no cadastro do Hub.</div>'
        : '<div style="color:var(--muted);margin-bottom:8px">Vai para os documentos de ' + esc(o.nomeCond || 'condomínio') + ' (código ' + esc(o.idSuperlogica) + '), sem publicar para os condôminos.</div>'
          + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
          + '<input type="text" class="arq-titulo" maxlength="120" value="' + esc(o.titulo) + '" style="flex:1;min-width:240px;padding:7px 10px;border:1px solid var(--border2);border-radius:6px;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:12px" aria-label="Título do documento no Superlógica">'
          + '<button class="btn btn-primary arq-enviar" style="font-size:12px;padding:6px 12px">Enviar para o Superlógica</button>'
          + '</div>')
      + '<div class="arq-status" style="margin-top:8px"></div>'
      + '</div>';
    var btn = host.querySelector('.arq-enviar');
    if (btn) btn.addEventListener('click', function () { enviar(host, false); });
  }

  function status(host, html, cor) {
    var el = host.querySelector('.arq-status');
    if (el) { el.style.color = cor || 'var(--muted)'; el.innerHTML = html; }
  }

  async function enviar(host, forcar) {
    var o = host._arq;
    if (!o || host._arqEnviando) return;
    var titulo = (host.querySelector('.arq-titulo') || {}).value || '';
    titulo = titulo.replace(/\s+/g, ' ').trim();
    if (titulo.length < 5) { status(host, 'Escreva um título com pelo menos 5 letras.', 'var(--danger)'); return; }
    host._arqEnviando = true;
    var btn = host.querySelector('.arq-enviar');
    if (btn) btn.disabled = true;
    status(host, 'Enviando para o Superlógica...', 'var(--gs-blue)');
    try {
      var b64 = await o.pdfBase64();
      if (!b64) throw new Error('Não consegui montar o PDF.');
      if (b64.length * 3 / 4 > 15 * 1024 * 1024) throw new Error('O PDF passa de 15 MB, limite do Superlógica.');
      // Fora do condomínio de teste o servidor pede a confirmação (confirmar-gravacao.js).
      var resp = await (window.gravarNoSuperlogica || apiAuthFetch)('/api/condominio/' + encodeURIComponent(o.idSuperlogica) + '/documentos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, o.extra || {}, { tipo: o.tipo, titulo: titulo, pdf_base64: b64, forcar: !!forcar }))
      });
      var j = await resp.json().catch(function () { return {}; });
      if (resp.status === 409) {
        var lista = (j.existentes || []).map(function (x) { return esc(x.titulo) + (x.criado_em ? ' (' + esc(x.criado_em.slice(0, 10)) + ')' : ''); }).join(', ');
        status(host, 'Já existe documento com esse título no Superlógica: ' + lista + '. Mude o título ou <button class="btn btn-ghost arq-forcar" style="font-size:11px;padding:3px 8px">enviar mesmo assim</button>', 'var(--warn,#e0a82e)');
        var bf = host.querySelector('.arq-forcar');
        if (bf) bf.addEventListener('click', function () { enviar(host, true); });
        return;
      }
      if (!resp.ok) throw new Error(j.detalhe || ('erro ' + resp.status));
      status(host, '✓ Arquivado no Superlógica como "' + esc(j.titulo) + '". '
        + (j.publicado === true ? 'Atenção: o Superlógica marcou como publicado; confira lá.' : 'Não foi publicado para os condôminos (publique no Superlógica depois de conferir).'), 'var(--success)');
      if (btn) btn.style.display = 'none';
      if (typeof toast === 'function') toast('Arquivado no Superlógica', 'ok');
    } catch (e) {
      status(host, '✕ ' + esc(e.message || e), 'var(--danger)');
    } finally {
      host._arqEnviando = false;
      if (btn) btn.disabled = false;
    }
  }

  function esconder(hostId) {
    var host = document.getElementById(hostId);
    if (host) { host.style.display = 'none'; host.innerHTML = ''; host._arq = null; }
  }

  // ArrayBuffer ou Uint8Array em base64, sem estourar a pilha em arquivo grande.
  function paraBase64(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Trocou de condomínio: o painel era do documento do condomínio anterior.
  window.addEventListener('condominioAtivo:trocou', function () { esconder('ata-arquivar'); esconder('prest-arquivar'); });

  window.ArquivarSL = { mostrar: mostrar, esconder: esconder, paraBase64: paraBase64 };
})();
