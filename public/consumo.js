// Leitura de Consumo (T20): fotos de medidores em lote, conferência pelo leiturista e lançamento
// no Superlógica. A leitura da foto, o casamento com a unidade, as suspeitas e a gravação são
// feitos no servidor (/api/processar/medidor e /api/consumo/*). Aqui só a tela.
(function () {
  'use strict';
  const LEITURAS_SIMULTANEAS = 3;
  const LADO_MAX = 800; // fotos reduzidas antes de enviar (lado maior em pixels); 800 teve o melhor acerto e custo na comparação de 21/10

  const st = {
    itens: [],            // { id, nome, url, b64, status, leitura, unidade, bloco, medidor, varios, id_unidade, escolhida, conf, lancar, lancada, erro }
    unidades: [],
    info: null,           // resposta de /unidades (mes, ultimo_dia, corrente, lancamento_liberado)
    lendo: 0,
    lancando: false,
    timerConferir: null,
  };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s == null ? '' : s));
  const fmt = (n) => (n == null || n === '' ? '' : String(Math.round(Number(n) * 1000) / 1000).replace('.', ','));

  function cond() {
    const c = typeof getCondominioAtivo === 'function' ? getCondominioAtivo() : null;
    return c && c.id_superlogica ? c : null;
  }
  // Enquanto lê ou lança: trava a troca de condomínio e os filtros (tipo e mês).
  function travar() {
    const ocupado = st.lendo > 0 || st.lancando;
    window._enviandoConsumo = ocupado;
    ['consumo-tipo', 'consumo-mes', 'consumo-dia'].forEach((id) => { const el = $(id); if (el) el.disabled = ocupado; });
  }

  // Mês de referência: o atual e os dois anteriores.
  function montarMeses() {
    const sel = $('consumo-mes');
    if (!sel || sel.options.length) return;
    const nomes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    const h = new Date();
    for (let i = 0; i < 3; i++) {
      const d = new Date(h.getFullYear(), h.getMonth() - i, 1);
      const o = document.createElement('option');
      o.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      o.textContent = nomes[d.getMonth()] + ' de ' + d.getFullYear();
      sel.appendChild(o);
    }
  }
  function params() {
    return { tipo: $('consumo-tipo').value, mes: $('consumo-mes').value };
  }

  async function lerJson(resp) { try { return await resp.json(); } catch (e) { return {}; } }

  // Unidades do condomínio com a última leitura do tipo e mês escolhidos.
  async function carregarUnidades() {
    const c = cond();
    st.unidades = []; st.info = null; st.infoParams = null;
    if (!c) { avisoTopo('Selecione um condomínio com código do Superlógica.'); return false; }
    const p = params();
    const r = await apiAuthFetch('/api/consumo/' + encodeURIComponent(c.id_superlogica) + '/unidades?tipo=' + encodeURIComponent(p.tipo) + '&mes=' + encodeURIComponent(p.mes));
    const d = await lerJson(r);
    if (!r.ok) { avisoTopo(d.detalhe || 'Não foi possível ler as unidades agora.'); return false; }
    st.unidades = Array.isArray(d.unidades) ? d.unidades : [];
    st.info = d;
    st.infoParams = p; // tipo e mês com que a lista foi lida: o lançamento usa estes
    const dia = $('consumo-dia');
    dia.max = d.ultimo_dia || 31;
    if (!dia.value || Number(dia.value) > Number(dia.max)) dia.value = d.corrente ? new Date().getDate() : d.ultimo_dia;
    avisoTopo(st.unidades.length + ' unidades com leitura de ' + (d.nome_tipo || '') + ' em ' + (d.mes || '') + '.' +
      (d.lancamento_liberado ? '' : ' Lançamento travado para este condomínio pela administração: a conferência funciona normalmente.'));
    return true;
  }
  function avisoTopo(t) { const el = $('consumo-aviso'); if (el) el.textContent = t || ''; }

  // Reduz a foto (lado maior LADO_MAX) e converte para JPG: envio mais rápido e foto menor no Superlógica.
  function reduzirFoto(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, LADO_MAX / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/jpeg', 0.85).split(',')[1]);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagem')); };
      img.src = url;
    });
  }

  // Nome do arquivo como pista da unidade ("101A.jpg", "apto 302 bloco B.jpg"); nomes de câmera não valem.
  function unidadeDoNome(nome) {
    const base = String(nome || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
    if (!base || /^(img|dsc|pxl|photo|foto|whatsapp|image|screenshot|captura)/i.test(base)) return null;
    if (!/[0-9]/.test(base) || /[0-9]{6,}/.test(base)) return null;
    return base.slice(0, 40);
  }

  async function lerFoto(item) {
    try {
      item.b64 = await reduzirFoto(item.file);
    } catch (e) { item.status = 'erro'; item.leitura = ''; item.erro = 'Não foi possível abrir a imagem.'; return; }
    item.file = null;
    try {
      const r = await apiAuthFetch('/api/processar/medidor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arquivo: { mime: 'image/jpeg', base64: item.b64 } }),
      });
      const d = await lerJson(r);
      if (!r.ok) { item.status = 'erro'; item.leitura = ''; item.erro = d.detalhe || 'Não foi possível ler a foto.'; return; }
      item.leitura = d.leitura && d.leitura !== 'ilegível' ? String(d.leitura) : '';
      item.unidadeTxt = d.unidade || unidadeDoNome(item.nome) || '';
      item.blocoTxt = d.bloco || '';
      item.medidor = d.medidor || '';
      item.varios = !!d.varios_medidores;
      item.status = 'lida';
    } catch (e) { item.status = 'erro'; item.leitura = ''; item.erro = 'Falha de conexão ao ler a foto.'; }
  }

  async function processarArquivos(files) {
    if (st.lancando) { toast('Aguarde o lançamento terminar.', 'warn'); return; }
    if (!cond()) { toast('Selecione um condomínio com código do Superlógica antes de enviar as fotos.', 'err'); return; }
    $('consumo-results').style.display = 'block';
    if (!st.info) await carregarUnidades();
    const novos = files.filter((f) => /^image\/(jpeg|png|webp|gif)$/i.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name));
    if (novos.length < files.length) toast((files.length - novos.length) + ' arquivo(s) ignorado(s): envie fotos JPG, PNG ou WEBP.', 'warn');
    const fila = novos.map((file) => {
      const it = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), nome: file.name, file,
        url: URL.createObjectURL(file), status: 'lendo', leitura: '', unidadeTxt: '', blocoTxt: '', id_unidade: null, escolhida: false, conf: null, lancar: false };
      st.itens.push(it);
      return it;
    });
    render();
    st.lendo++; travar();
    toast(fila.length + ' foto(s) carregada(s). Lendo os medidores...', 'info');
    let i = 0;
    async function trab() { while (i < fila.length) { const it = fila[i++]; await lerFoto(it); render(); agendarConferir(); } }
    try { await Promise.all(Array.from({ length: Math.min(LEITURAS_SIMULTANEAS, fila.length) }, trab)); }
    finally { st.lendo--; travar(); }
    await conferir();
    toast('Leitura das fotos concluída. Confira antes de lançar.', 'ok');
  }

  function agendarConferir() {
    clearTimeout(st.timerConferir);
    st.timerConferir = setTimeout(() => { conferir(); }, 500);
  }

  // Casamento com a unidade e suspeitas, sempre pelo servidor (uma regra só).
  async function conferir() {
    const c = cond();
    const prontos = st.itens.filter((it) => it.status !== 'lendo' && !it.lancada);
    if (!c || !st.info || !prontos.length) { render(); return; }
    const p = st.infoParams || params();
    const itens = prontos.map((it) => ({ chave: it.id, unidade: it.unidadeTxt, bloco: it.blocoTxt,
      id_unidade: it.escolhida ? it.id_unidade : null, leitura: it.leitura, varios_medidores: it.varios }));
    try {
      const r = await apiAuthFetch('/api/consumo/' + encodeURIComponent(c.id_superlogica) + '/conferir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: p.tipo, mes: p.mes, itens }),
      });
      const d = await lerJson(r);
      if (!r.ok) { toast(d.detalhe || 'Não foi possível conferir agora.', 'err'); return; }
      const porChave = new Map((d.itens || []).map((o) => [o.chave, o]));
      prontos.forEach((it) => {
        const o = porChave.get(it.id);
        if (!o) return;
        const antes = it.conf;
        it.conf = o;
        if (!it.escolhida) it.id_unidade = o.id_unidade || null;
        // Marca para lançar só o que não tem suspeita; com suspeita, quem decide é o leiturista.
        if (!antes || antes.suspeitas.length !== o.suspeitas.length) it.lancar = !o.suspeitas.length && !!o.id_unidade && o.leitura != null && !it.comReferencia;
      });
    } catch (e) { toast('Falha de conexão ao conferir.', 'err'); }
    render();
    reforcar();
  }

  // Foto marcada (ilegível, menor que a anterior ou salto) é lida mais uma vez, com mais cuidado,
  // antes de ir para o leiturista. Uma vez por foto; leitura editada à mão não é relida.
  const MOTIVOS_REFORCO = ['ilegivel', 'menor_que_anterior', 'salto_alto'];
  async function reforcar() {
    if (st.reforcando || st.lancando) return;
    const alvo = st.itens.filter((it) => it.conf && it.status === 'lida' && it.b64 && !it.reforcado && !it.editada && !it.lancada &&
      it.conf.suspeitas.some((x) => MOTIVOS_REFORCO.includes(x.codigo)));
    if (!alvo.length) return;
    st.reforcando = true; st.lendo++; travar();
    alvo.forEach((it) => { it.status = 'lendo'; });
    render();
    let i = 0;
    async function trab() {
      while (i < alvo.length) {
        const it = alvo[i++];
        try {
          const r = await apiAuthFetch('/api/processar/medidor', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ arquivo: { mime: 'image/jpeg', base64: it.b64 }, reforco: true,
              contexto: it.conf && it.conf.anterior != null ? { anterior: it.conf.anterior, media: it.conf.media } : undefined }),
          });
          const d = await lerJson(r);
          if (r.ok && !it.editada) {
            if (d.leitura && d.leitura !== 'ilegível') it.leitura = String(d.leitura);
            if (!it.escolhida && d.unidade && !it.unidadeTxt) { it.unidadeTxt = d.unidade; it.blocoTxt = d.bloco || it.blocoTxt; }
            if (d.varios_medidores) it.varios = true;
            // Lida com a leitura anterior como referência: o leiturista confere a foto antes de lançar.
            if (d.com_referencia) it.comReferencia = true;
          }
        } catch (e) { /* fica a primeira leitura */ }
        it.reforcado = true; it.status = 'lida'; it.conf = null;
        render();
      }
    }
    try { await Promise.all(Array.from({ length: Math.min(LEITURAS_SIMULTANEAS, alvo.length) }, trab)); }
    finally { st.lendo--; st.reforcando = false; travar(); }
    await conferir();
  }

  function opcoesUnidade(sel) {
    return '<option value="">escolha a unidade</option>' + st.unidades.map((u) =>
      '<option value="' + u.id_unidade + '"' + (Number(sel) === u.id_unidade ? ' selected' : '') + '>' +
      esc(u.unidade + (u.bloco ? ' ' + u.bloco : '')) + '</option>').join('');
  }

  function render() {
    const corpo = $('consumo-tabela');
    if (!corpo) return;
    const liberado = !!(st.info && st.info.lancamento_liberado);
    let nSusp = 0, nMarc = 0, nLanc = 0;
    corpo.innerHTML = st.itens.map((it) => {
      const o = it.conf || { suspeitas: [], avisos: [] };
      if (it.lancada) nLanc++;
      else { if (o.suspeitas.length) nSusp++; if (it.lancar) nMarc++; }
      const situacao = it.status === 'lendo'
        ? '<span class="consumo-chip">Lendo a foto...</span>'
        : it.lancada ? '<span class="consumo-chip ok">Lançada' + (it.fotoInfo === 'guardada' ? ' com foto' : '') + '</span>'
        : (it.erro ? '<span class="consumo-chip err">' + esc(it.erro) + '</span>' : '') +
          o.suspeitas.map((s) => '<span class="consumo-chip warn">' + esc(s.texto) + '</span>').join('') +
          (o.avisos || []).map((a) => '<span class="consumo-chip">' + esc(a) + '</span>').join('') +
          (it.reforcado ? '<span class="consumo-chip' + (it.comReferencia ? ' warn' : '') + '">' + (it.comReferencia ? 'Foto lida de novo com a leitura anterior como referência: confira a foto antes de marcar' : 'Foto lida duas vezes') + '</span>' : '') +
          (!o.suspeitas.length && !it.erro && it.conf ? '<span class="consumo-chip ok">Sem suspeita</span>' : '');
      // Mês seguinte já lançado: o servidor sempre recusa, então nem deixa marcar.
      const bloqueada = o.suspeitas.some((s) => s.codigo === 'mes_seguinte_lancado');
      const trava = it.status === 'lendo' || it.lancada || st.lancando ? ' disabled' : '';
      const lido = it.unidadeTxt || it.blocoTxt ? 'Na foto: ' + [it.unidadeTxt, it.blocoTxt].filter(Boolean).join(' ') : 'Unidade não identificada na foto';
      return '<tr data-id="' + esc(it.id) + '" class="' + (o.suspeitas.length && !it.lancada ? 'suspeita' : '') + '">' +
        '<td><a href="' + esc(it.url) + '" target="_blank" rel="noopener"><img class="consumo-mini" src="' + esc(it.url) + '" alt="Foto do medidor"></a></td>' +
        '<td><div class="consumo-nome">' + esc(it.nome) + '</div><div class="consumo-sub">' + esc(lido) + (it.medidor ? '<br>Medidor ' + esc(it.medidor) : '') + '</div></td>' +
        '<td><select class="consumo-input" data-campo="unidade"' + trava + '>' + opcoesUnidade(it.id_unidade) + '</select></td>' +
        '<td><input class="consumo-input" data-campo="leitura" inputmode="decimal" value="' + esc(it.leitura) + '"' + trava + '></td>' +
        '<td class="num">' + esc(fmt(o.anterior)) + '</td><td class="num">' + esc(fmt(o.consumo)) + '</td><td class="num">' + esc(fmt(o.media)) + '</td>' +
        '<td class="consumo-situacao">' + situacao + '</td>' +
        '<td><input type="checkbox" data-campo="lancar"' + (it.lancar && !it.lancada ? ' checked' : '') + (trava || !liberado || bloqueada ? ' disabled' : '') + '></td>' +
        '<td><button class="consumo-remover" data-campo="remover" title="Tirar do lote"' + (st.lancando ? ' disabled' : '') + '>×</button></td></tr>';
    }).join('');
    $('consumo-resumo').textContent = st.itens.length + ' foto(s); ' + nSusp + ' com suspeita; ' + nMarc + ' marcada(s) para lançar' + (nLanc ? '; ' + nLanc + ' lançada(s)' : '') + '.';
    const btn = $('btn-lancar-consumo');
    btn.disabled = !liberado || !nMarc || st.lancando || st.lendo > 0;
    btn.title = liberado ? '' : 'Lançamento travado para este condomínio pela administração.';
  }

  function itemDoEvento(e) {
    const tr = e.target.closest('tr[data-id]');
    return tr ? st.itens.find((x) => x.id === tr.getAttribute('data-id')) : null;
  }
  function ligarTabela() {
    const corpo = $('consumo-tabela');
    if (!corpo || corpo._ligado) return;
    corpo._ligado = true;
    corpo.addEventListener('change', (e) => {
      const it = itemDoEvento(e); if (!it) return;
      const campo = e.target.getAttribute('data-campo');
      if (campo === 'unidade') { it.id_unidade = Number(e.target.value) || null; it.escolhida = !!it.id_unidade; it.conf = null; agendarConferir(); }
      else if (campo === 'leitura') { it.leitura = e.target.value.trim(); it.erro = ''; it.editada = true; it.conf = null; agendarConferir(); }
      else if (campo === 'lancar') { it.lancar = e.target.checked; render(); }
    });
    corpo.addEventListener('click', (e) => {
      if (e.target.getAttribute('data-campo') !== 'remover') return;
      const it = itemDoEvento(e); if (!it || st.lancando) return;
      st.itens = st.itens.filter((x) => x !== it);
      try { URL.revokeObjectURL(it.url); } catch (er) { /* nada */ }
      if (!st.itens.length) limpar(); else agendarConferir();
    });
  }

  function limpar() {
    if (st.lancando) return;
    st.itens.forEach((it) => { try { URL.revokeObjectURL(it.url); } catch (e) { /* nada */ } });
    st.itens = [];
    $('consumo-results').style.display = 'none';
    $('consumo-log-card').style.display = 'none';
    $('consumo-log').innerHTML = '';
  }

  async function lancar() {
    const c = cond();
    if (!c || !st.info || st.lancando || st.lendo) return;
    const marcadas = st.itens.filter((it) => it.lancar && !it.lancada && it.id_unidade && it.conf && it.conf.leitura != null);
    if (!marcadas.length) { toast('Marque as leituras que quer lançar.', 'err'); return; }
    const comSusp = marcadas.filter((it) => it.conf.suspeitas.length).length;
    const msg = 'Lançar ' + marcadas.length + ' leitura(s) de ' + (st.info.nome_tipo || '') + ' em ' + (st.info.mes || '') + ' no Superlógica, condomínio ' + (c.nome || c.id_superlogica) + '?' +
      (comSusp ? '\n\n' + comSusp + ' delas têm suspeita e você marcou que conferiu.' : '');
    if (!window.confirm(msg)) return;
    // Lança com o tipo e o mês da conferência; se os filtros mudaram, confere de novo antes.
    const p = st.infoParams;
    const agora = params();
    if (!p || p.tipo !== agora.tipo || p.mes !== agora.mes) { toast('O tipo ou o mês mudou: aguarde a nova conferência e tente de novo.', 'err'); mudouFiltro(); return; }
    const dia = Number($('consumo-dia').value) || null;
    const logDiv = $('consumo-log');
    $('consumo-log-card').style.display = 'block';
    st.lancando = true; travar(); render();
    // Política de gravação: fora do condomínio de teste o servidor pede a confirmação da lista inteira
    // (janela de confirmar-gravacao.js) e devolve um token que vale para cada leitura uma vez.
    let confirmacao = null;
    try {
      const gravar = window.gravarNoSuperlogica || apiAuthFetch;
      const rp = await gravar('/api/consumo/' + encodeURIComponent(c.id_superlogica) + '/previa-lote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo: p.tipo, mes: p.mes, dia, itens: marcadas.map((it) => ({ id_unidade: it.id_unidade, leitura: it.leitura, substituir: it.conf.suspeitas.some((s) => s.codigo === 'ja_lancada') })) }),
      });
      const dp = await lerJson(rp);
      if (!rp.ok) throw new Error(dp.detalhe || ('erro ' + rp.status));
      if (dp.confirmado && dp.confirmacao) confirmacao = dp.confirmacao;
    } catch (e) {
      addLog(logDiv, 'Nada lançado: ' + (e.message || e), 'err');
      st.lancando = false; travar(); render();
      return;
    }
    let ok = 0, falhas = 0;
    for (const it of marcadas) {
      const rot = (it.conf && it.conf.rotulo) || ('unidade ' + it.id_unidade);
      addLog(logDiv, rot + ': lançando ' + it.leitura + '...', 'info');
      // Só aceita a suspeita que o leiturista viu na tela; se o servidor achar outra, ele recusa.
      const cods = it.conf.suspeitas.map((s) => s.codigo);
      try {
        const r = await apiAuthFetch('/api/consumo/' + encodeURIComponent(c.id_superlogica) + '/lancar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tipo: p.tipo, mes: p.mes, dia, id_unidade: it.id_unidade, leitura: it.leitura,
            foto: it.b64 ? { mime: 'image/jpeg', base64: it.b64 } : undefined,
            substituir: cods.includes('ja_lancada'),
            aceitar_suspeitas: cods.filter((x) => x === 'menor_que_anterior' || x === 'salto_alto'),
            confirmacao: 'LANCAR', confirmacao_gravacao: confirmacao ? { id_condominio: confirmacao.id_condominio, token: confirmacao.token } : undefined }),
        });
        const d = await lerJson(r);
        if (r.status === 428) {
          falhas++;
          addLog(logDiv, 'A confirmação venceu ou mudou. Parei aqui: clique em Lançar de novo para confirmar as que faltam.', 'err');
          break;
        }
        if (r.ok && d.ok) {
          ok++; it.lancada = true; it.lancar = false; it.fotoInfo = d.foto;
          addLog(logDiv, rot + ': lançada' + (d.foto === 'guardada' ? ' com a foto' : d.foto === 'recusada' ? ' (o Superlógica não aceitou a foto)' : ''), 'ok');
        } else {
          falhas++;
          addLog(logDiv, rot + ': ' + (d.detalhe || ('erro ' + r.status)), 'err');
          if (r.status === 504) { addLog(logDiv, 'Parei para você conferir no Superlógica antes de continuar.', 'err'); break; }
        }
      } catch (e) { falhas++; addLog(logDiv, rot + ': falha de conexão', 'err'); }
      render();
      await sleep(200);
    }
    st.lancando = false; travar();
    if (typeof addHistorico === 'function') addHistorico('Consumo: ' + ok + ' leitura(s) lançada(s)' + (falhas ? ', ' + falhas + ' com erro' : ''));
    toast(falhas ? ok + ' lançada(s), ' + falhas + ' com erro.' : ok + ' leitura(s) lançada(s).', falhas ? 'warn' : 'ok');
    agendarConferir();
  }

  async function mudouFiltro() {
    if (st.lancando || st.lendo) return;
    st.itens.forEach((it) => { it.conf = null; if (!it.escolhida) it.id_unidade = null; });
    await carregarUnidades();
    await conferir();
  }

  window.handleDropConsumo = function (e) {
    e.preventDefault();
    $('dropzone-consumo').classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) processarArquivos(files);
  };
  window.handleFilesConsumo = function (e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) processarArquivos(files);
  };
  window.limparConsumo = limpar;
  window.lancarConsumo = lancar;
  window.consumoMudouFiltro = mudouFiltro;

  // Trocou de condomínio: as fotos e leituras eram do anterior.
  window.addEventListener('condominioAtivo:trocou', function () {
    st.info = null; st.unidades = [];
    avisoTopo('');
    if (!st.itens.length) return;
    limpar();
    toast('Leituras de consumo descartadas: o condomínio mudou.', 'info');
  });

  function iniciar() { montarMeses(); ligarTabela(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
