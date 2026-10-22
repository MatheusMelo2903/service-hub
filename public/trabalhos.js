// ─────────────────────────────────────────────────────────────────────────
// T49: pastinha "Em andamento". Guarda no servidor os trabalhos longos (ata gerada, prestação
// gerada, previsão, revisão de unidades) para não perder ao fechar a janela, trocar de aba,
// recarregar ou trocar de computador. Some só com "Encerrar" ou depois de 7 dias sem mexer.
//
// Uso pelos módulos:
//   Trabalhos.registrar('ata', { nome: 'Ata', painel: 'atas', restaurar: async (t) => {...} })
//   const id = await Trabalhos.salvar('ata', { id, idSuperlogica, titulo, dados })
//   await Trabalhos.anexar(id, 'Prestacao.pdf', blob)
//   await Trabalhos.encerrar(id, { perguntar: true })
//   Trabalhos.atualizar()   // relê a lista da pastinha
// restaurar(t) recebe { id, tipo, id_superlogica, titulo, dados, arquivos: [{ nome, url }] }.
// ─────────────────────────────────────────────────────────────────────────
(function () {
  var tipos = {};
  var itens = [];
  var aberto = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function aviso(m, t) { if (typeof toast === 'function') toast(m, t || 'info'); }
  async function api(url, op) {
    var r = await (window.apiAuthFetch ? window.apiAuthFetch(url, op || {}) : fetch(url, op || {}));
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.detalhe || j.erro || ('HTTP ' + r.status));
    return j;
  }
  function quando(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return 'há ' + min + ' min';
    var h = Math.round(min / 60); if (h < 24) return 'há ' + h + ' h';
    return d.toLocaleDateString('pt-BR');
  }

  // ── pastinha no topo ──
  function montar() {
    if (document.getElementById('trab-pasta')) return;
    var alvo = document.querySelector('.topbar-right');
    if (!alvo) return;
    var w = document.createElement('div');
    w.id = 'trab-pasta';
    w.style.cssText = 'position:relative;display:none;margin-right:6px';
    w.innerHTML = '<button type="button" id="trab-botao" class="btn btn-ghost" style="font-size:12px;padding:6px 10px;white-space:nowrap" title="Atas, prestações e outros trabalhos guardados até você encerrar">📁 Em andamento <span id="trab-n" style="background:var(--gs-blue);color:#fff;border-radius:9px;padding:0 6px;margin-left:4px;font-size:11px"></span></button>'
      + '<div id="trab-lista" style="display:none;position:absolute;right:0;top:calc(100% + 6px);width:380px;max-height:420px;overflow:auto;background:var(--bg2,#fff);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.12);z-index:999;padding:8px"></div>';
    alvo.insertBefore(w, alvo.firstChild);
    document.getElementById('trab-botao').addEventListener('click', function (ev) { ev.stopPropagation(); aberto = !aberto; desenhar(); });
    document.addEventListener('click', function (ev) {
      if (aberto && !(ev.target.closest && ev.target.closest('#trab-pasta'))) { aberto = false; desenhar(); }
    });
  }

  function desenhar() {
    montar();
    var w = document.getElementById('trab-pasta');
    if (!w) return;
    w.style.display = itens.length ? 'block' : 'none';
    document.getElementById('trab-n').textContent = itens.length;
    var lista = document.getElementById('trab-lista');
    lista.style.display = aberto && itens.length ? 'block' : 'none';
    if (!aberto) return;
    lista.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:4px 6px 8px">Guardados até você encerrar (ou 7 dias sem mexer).</div>'
      + itens.map(function (t) {
        var tp = tipos[t.tipo] || { nome: t.tipo };
        return '<div style="border-top:1px solid var(--border);padding:8px 6px;display:flex;gap:8px;align-items:center">'
          + '<div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(t.titulo) + '">' + esc(t.titulo) + '</div>'
          + '<div style="font-size:11px;color:var(--muted)">' + esc(tp.nome) + ' · ' + esc(quando(t.atualizado_em)) + (t.arquivos && t.arquivos.length ? ' · ' + t.arquivos.length + ' arquivo(s)' : '') + '</div></div>'
          + '<button type="button" class="btn btn-primary trab-abrir" data-id="' + esc(t.id) + '" style="font-size:11px;padding:5px 10px">Abrir</button>'
          + '<button type="button" class="btn btn-ghost trab-encerrar" data-id="' + esc(t.id) + '" style="font-size:11px;padding:5px 8px">Encerrar</button></div>';
      }).join('');
    lista.querySelectorAll('.trab-abrir').forEach(function (b) { b.onclick = function () { aberto = false; desenhar(); abrir(b.dataset.id); }; });
    lista.querySelectorAll('.trab-encerrar').forEach(function (b) { b.onclick = function () { encerrar(b.dataset.id, { perguntar: true }); }; });
  }

  async function atualizar() {
    if (!window.AUTH_TOKEN) return;
    try { itens = (await api('/api/trabalhos')).itens || []; } catch (e) { return; }
    desenhar();
    try { window.dispatchEvent(new CustomEvent('trabalhos:lista', { detail: itens })); } catch (_) {}
  }

  // Troca para o condomínio do trabalho (se preciso) e abre o painel do módulo.
  async function irPara(t, tp) {
    if (t.id_superlogica) {
      var at = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
      if (!at || String(at.id_superlogica) !== String(t.id_superlogica)) {
        var lista = (window.CondSeletor && CondSeletor.lista && CondSeletor.lista()) || [];
        var c = lista.find(function (x) { return String(x.id_superlogica) === String(t.id_superlogica); });
        if (!c) throw new Error('O condomínio deste trabalho não está na sua lista.');
        if (typeof setCondominioAtivo === 'function' && setCondominioAtivo(c) === false) throw new Error('Termine o que está em andamento antes de abrir outro condomínio.');
        await new Promise(function (r) { setTimeout(r, 400); }); // telas limpam o condomínio anterior primeiro
      }
    }
    if (tp.painel && typeof showPanel === 'function') showPanel(tp.painel);
  }

  async function abrir(id) {
    try {
      var t = await api('/api/trabalhos/' + encodeURIComponent(id));
      var tp = tipos[t.tipo];
      if (!tp || !tp.restaurar) throw new Error('Este tipo de trabalho não abre nesta tela.');
      await irPara(t, tp);
      await tp.restaurar(t);
    } catch (e) {
      aviso('Não foi possível abrir: ' + e.message, 'err');
      atualizar();
    }
  }

  async function salvar(tipo, o) {
    var j = await api('/api/trabalhos', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: o.id || undefined, tipo: tipo, id_superlogica: o.idSuperlogica || null, titulo: o.titulo, dados: o.dados }) });
    atualizar();
    return j.id;
  }

  async function anexar(id, nome, blob) {
    await api('/api/trabalhos/' + encodeURIComponent(id) + '/arquivo?nome=' + encodeURIComponent(nome), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
    atualizar();
  }

  async function encerrar(id, o) {
    o = o || {};
    if (!id) return false;
    var t = itens.find(function (x) { return x.id === id; });
    if (o.perguntar && !confirm('Encerrar "' + (t ? t.titulo : 'este trabalho') + '"? Ele sai da pasta Em andamento e não dá para reabrir.')) return false;
    try { await api('/api/trabalhos/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) { aviso('Não foi possível encerrar: ' + e.message, 'err'); return false; }
    itens = itens.filter(function (x) { return x.id !== id; });
    desenhar();
    try { window.dispatchEvent(new CustomEvent('trabalhos:encerrado', { detail: { id: id, tipo: t && t.tipo } })); } catch (_) {}
    return true;
  }

  // Baixa um arquivo guardado (link temporário) como Blob.
  async function baixarArquivo(url) {
    var r = await fetch(url);
    if (!r.ok) throw new Error('arquivo indisponível');
    return r.blob();
  }

  window.Trabalhos = {
    registrar: function (tipo, def) { tipos[tipo] = def; },
    salvar: salvar, anexar: anexar, encerrar: encerrar, abrir: abrir, atualizar: atualizar,
    lista: function () { return itens.slice(); }, baixarArquivo: baixarArquivo,
  };

  // Lê a lista quando o login termina e de tempos em tempos (outra aba pode ter encerrado).
  var tent = 0;
  (function esperarLogin() {
    if (window.AUTH_TOKEN) { atualizar(); return; }
    if (++tent < 120) setTimeout(esperarLogin, 1000);
  })();
  // A cada 5 minutos e ao voltar para a aba (outra aba pode ter encerrado). Intervalo longo para
  // não encher o registro da Segurança com leituras repetidas.
  setInterval(function () { if (!document.hidden) atualizar(); }, 5 * 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) atualizar(); });
})();
