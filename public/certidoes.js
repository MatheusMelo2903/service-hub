// ─────────────────────────────────────────────────────────────────────────
// T50: certidões negativas e outros documentos da Prestação de Contas.
//
// Duas partes:
// 1. Painel de certidões de um condomínio (window.Certidoes.montarPainel). Lê o que está
//    guardado no servidor (servico/certidoes.js), mostra a situação de cada tipo, busca
//    sozinho os tipos automáticos que faltam ou venceram, e para os outros abre o site
//    com o CNPJ copiado. A pessoa arrasta o PDF baixado no campo (ou todos de uma vez na
//    área geral, e o servidor descobre qual é qual). As certidões ficam guardadas no
//    condomínio: a válida entra sozinha nas próximas prestações, sem emitir de novo.
// 2. Integração com a prestação (public/prestacao.js): caixa "Incluir certidões
//    negativas" no card 2, "Outros documentos" (atas, contratos, laudos) que vão no
//    trabalho da pasta Em andamento, título " (aguardando certidões)" enquanto falta
//    alguma válida, e "Baixar tudo" em um .zip montado no navegador.
//
// Nada aqui gera a prestação de novo: certidões e documentos são arquivos separados.
// Estado das certidões fica em memória por condomínio (estados[idSL]); os painéis são
// só vistas desse estado, então redesenhar ou mudar o painel de lugar não perde nada.
// ─────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  var SUFIXO_AGUARDANDO = ' (aguardando certidões)';
  var DIAS_AVISO = 15;              // mesmo prazo do alerta do Dashboard
  var MAX_CERTIDAO = 10 * 1024 * 1024;
  var MAX_DOC = 40 * 1024 * 1024;   // teto do servidor por arquivo do trabalho
  var MAX_DOCS = 18;                // 20 arquivos por trabalho, menos PDF e PowerPoint
  var URL_VALIDA_MS = 8 * 60 * 1000; // link do servidor vale 10 minutos; renova antes
  var INDISPONIVEL = 'As certidões ainda não estão disponíveis neste ambiente. Tente de novo mais tarde.';

  // Mensagens para os códigos do servidor, usadas quando ele não manda o detalhe.
  var ERROS = {
    tipo_nao_identificado: 'Não deu para saber qual certidão é esse PDF. Arraste no campo da certidão certa.',
    cnpj_diferente: 'Esse PDF é de outro CNPJ, não deste condomínio.',
    sem_texto: 'Não deu para ler esse PDF (parece imagem escaneada). Baixe a certidão original no site.',
    tipo_diferente: 'Esse PDF é de outra certidão, não deste campo.',
    formato_invalido: 'Envie a certidão em PDF.',
    sem_cnpj_cadastro: 'O condomínio está sem CNPJ no cadastro do Superlógica.',
    manual: 'Esta certidão precisa ser emitida no site. Use Emitir e arraste o PDF aqui.',
    falhou: 'O site da certidão não respondeu agora. Tente Buscar de novo ou use Emitir.',
    aguarde: 'Esta certidão acabou de ser buscada. Tente de novo em instantes.'
  };

  // ── utilidades ──
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function aviso(m, t) { if (typeof toast === 'function') toast(m, t || 'info'); }
  function soDig(s) { return String(s || '').replace(/\D/g, ''); }
  function fmtCnpj(s) {
    var d = soDig(s);
    if (d.length !== 14) return String(s || '');
    return d.slice(0, 2) + '.' + d.slice(2, 5) + '.' + d.slice(5, 8) + '/' + d.slice(8, 12) + '-' + d.slice(12);
  }
  function dataBr(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }
  // Dias de hoje até a data (AAAA-MM-DD), pela data local, sem fuso.
  function diasAte(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return null;
    var h = new Date(); h.setHours(0, 0, 0, 0);
    var v = new Date(+m[1], +m[2] - 1, +m[3]);
    return Math.round((v.getTime() - h.getTime()) / 86400000);
  }
  function tamanho(b) {
    if (!b && b !== 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }
  function ehPdf(f) { return !!f && (/\.pdf$/i.test(f.name || '') || f.type === 'application/pdf'); }
  // Nome seguro para arquivo baixado (sem caracteres que o sistema operacional recusa).
  function nomeArquivoSeguro(s) {
    return String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'arquivo';
  }

  // Chamada ao servidor com mensagem de erro já pronta para a tela.
  async function chamar(url, op) {
    var r;
    try { r = await (window.apiAuthFetch ? window.apiAuthFetch(url, op || {}) : fetch(url, op || {})); }
    catch (e) { var semRede = new Error('Sem conexão com o servidor agora.'); semRede.status = 0; throw semRede; }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      // 404 da rota: o servidor desta versão ainda não tem as certidões.
      var indisponivel = r.status === 404 && (!j.erro || j.erro === 'rota não encontrada');
      var msg = indisponivel ? INDISPONIVEL : (j.detalhe || ERROS[j.erro] || ('O servidor respondeu com erro ' + r.status + '.'));
      var e = new Error(msg);
      e.status = r.status; e.codigo = j.erro || ''; e.indisponivel = indisponivel;
      throw e;
    }
    return j;
  }

  // ── estilos (só desta parte; não mexe no index.html) ──
  function garantirEstilo() {
    if (document.getElementById('cert-estilo')) return;
    var st = document.createElement('style');
    st.id = 'cert-estilo';
    st.textContent = [
      '.cert-bloco{margin-top:18px;padding-top:16px;border-top:1px solid var(--border)}',
      '.cert-chk{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer}',
      '.cert-chk input{accent-color:var(--gs-blue);width:16px;height:16px;cursor:pointer}',
      '.cert-painel{margin-top:12px}',
      '.cert-topo{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px;background:var(--gs-blue-light,#EBF5FB);border-radius:10px}',
      '.cert-cnpj-rot{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}',
      '.cert-cnpj-num{font-family:var(--mono);font-size:19px;font-weight:700;color:var(--gs-blue);letter-spacing:.5px}',
      '.cert-cnpj-nome{font-size:12px;color:var(--muted)}',
      '.cert-topo-acoes{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.cert-linha{display:grid;grid-template-columns:minmax(170px,1.3fr) minmax(150px,1fr) auto;gap:10px;align-items:center;padding:10px 8px;border-top:1px solid var(--border);border-radius:8px;transition:background .15s}',
      '.cert-linha.sobre{background:var(--gs-blue-light,#EBF5FB);outline:1.5px dashed var(--gs-blue)}',
      '.cert-nome{font-weight:600;font-size:13px}',
      '.cert-det{font-size:11px;color:var(--muted);margin-top:2px}',
      '.cert-sit{font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px}',
      '.cert-sit::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}',
      '.cert-sit.ok{color:var(--success)}.cert-sit.warn{color:var(--warning)}.cert-sit.err{color:var(--danger)}.cert-sit.wait{color:var(--muted)}',
      '.cert-alerta{font-size:11px;color:var(--danger);margin-top:2px}',
      '.cert-acoes{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
      '.cert-acoes .btn,.cert-mini{font-size:11px;padding:5px 10px}',
      '.cert-enviar{position:relative;overflow:hidden;cursor:pointer}',
      '.cert-enviar input,.cert-drop input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}',
      '.cert-msg{grid-column:1/-1;font-size:11px;color:var(--danger)}',
      '.cert-drop{position:relative;border:1.5px dashed var(--border2,var(--border));border-radius:10px;padding:16px;text-align:center;font-size:13px;color:var(--muted);cursor:pointer;margin-top:12px;transition:all .15s}',
      '.cert-drop.sobre,.cert-drop:hover{border-color:var(--gs-blue);color:var(--gs-blue);background:var(--gs-blue-light,#EBF5FB)}',
      '.cert-drop small{display:block;font-size:11px;margin-top:2px}',
      '.cert-res{font-size:11px;margin-top:6px;display:flex;flex-direction:column;gap:3px}',
      '.cert-res .ok{color:var(--success)}.cert-res .err{color:var(--danger)}.cert-res .wait{color:var(--muted)}',
      '.cert-sec{font-size:13px;font-weight:600;margin:18px 0 2px}',
      '.cert-doc{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;font-size:12px;margin-top:6px}',
      '.cert-doc-nome{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cert-doc-est{color:var(--muted);font-size:11px;white-space:nowrap}',
      '.cert-resumo{font-size:12px;margin-top:8px}',
      '.cert-resumo .warn{color:var(--warning);font-weight:600}.cert-resumo .ok{color:var(--success);font-weight:600}',
      '@media (max-width:700px){.cert-linha{grid-template-columns:1fr}.cert-acoes{justify-content:flex-start}.cert-topo-acoes{margin-left:0}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // ════════════════════════════════════════════════════════════════════
  // PARTE 1: ESTADO E PAINEL DE CERTIDÕES DE UM CONDOMÍNIO
  // ════════════════════════════════════════════════════════════════════
  var estados = {};   // idSL -> estado
  var tentadas = {};  // 'idSL|tipo' -> já buscou sozinho nesta página (não repete em loop)

  function estadoDe(idSL) {
    var k = String(idSL);
    if (!estados[k]) estados[k] = { idSL: k, carregando: null, erro: null, indisponivel: false, dados: null, em: 0, buscando: {}, enviando: {}, msgs: {}, geral: [], autoRodando: false, views: [] };
    return estados[k];
  }

  // Situação de uma certidão para a tela e para o "aguardando".
  // valida e vencendo contam como válidas; sem validade lida também (pede para conferir).
  function situacao(c) {
    if (!c) return { estado: 'faltando', cls: 'err', texto: 'Faltando' };
    var d = c.validade ? diasAte(c.validade) : null;
    if (c.vencida || (d !== null && d < 0)) return { estado: 'vencida', cls: 'err', texto: 'Vencida em ' + dataBr(c.validade) };
    if (d === null) return { estado: 'sem_validade', cls: 'warn', texto: 'Guardada, confira a validade' };
    if (d <= DIAS_AVISO) return { estado: 'vencendo', cls: 'warn', texto: d === 0 ? 'Vence hoje' : 'Vence em ' + d + (d === 1 ? ' dia' : ' dias') + ' (' + dataBr(c.validade) + ')' };
    return { estado: 'valida', cls: 'ok', texto: 'Válida até ' + dataBr(c.validade) };
  }
  function ehValida(estado) { return estado === 'valida' || estado === 'vencendo' || estado === 'sem_validade'; }

  function certDoTipo(est, tipo) {
    var l = (est.dados && est.dados.certidoes) || [];
    for (var i = 0; i < l.length; i++) if (l[i].tipo === tipo) return l[i];
    return null;
  }
  function nomeDoTipo(est, tipo) {
    var l = (est.dados && est.dados.tipos) || [];
    for (var i = 0; i < l.length; i++) if (l[i].tipo === tipo) return l[i].nome;
    return tipo;
  }
  function aplicarCertidao(est, c) {
    if (!est.dados || !c || !c.tipo) return;
    c._em = Date.now();
    est.dados.certidoes = (est.dados.certidoes || []).filter(function (x) { return x.tipo !== c.tipo; });
    est.dados.certidoes.push(c);
  }

  // Resumo para o título "aguardando" e para o card da prestação guardada.
  function resumoDe(tipos, certidoes) {
    var porTipo = {};
    (certidoes || []).forEach(function (c) { porTipo[c.tipo] = c; });
    var lista = (tipos || []).map(function (t) {
      var c = porTipo[t.tipo] || null;
      return { tipo: t.tipo, nome: t.nome, estado: situacao(c).estado, validade: (c && c.validade) || null, situacao: (c && c.situacao) || null, tem: !!c };
    });
    var faltando = lista.filter(function (x) { return !ehValida(x.estado); });
    return {
      tipos: lista,
      faltando: faltando.map(function (x) { return x.nome; }),
      validas: lista.length - faltando.length,
      total: lista.length,
      completo: lista.length > 0 && !faltando.length
    };
  }
  function resumo(idSL) {
    var est = estados[String(idSL)];
    return est && est.dados ? resumoDe(est.dados.tipos, est.dados.certidoes) : null;
  }

  // Lê do servidor. forcar: relê mesmo com dados (links novos dos PDFs).
  function carregar(idSL, forcar) {
    var est = estadoDe(idSL);
    if (est.carregando) return est.carregando;
    if (est.dados && !forcar) return Promise.resolve(est.dados);
    est.carregando = (async function () {
      try {
        var j = await chamar('/api/certidoes/' + encodeURIComponent(est.idSL), { cache: 'no-store' });
        var agora = Date.now();
        (j.certidoes || []).forEach(function (c) { c._em = agora; });
        j.tipos = j.tipos || [];
        j.certidoes = j.certidoes || [];
        est.dados = j; est.em = agora; est.erro = null; est.indisponivel = false;
        return j;
      } catch (e) {
        if (!est.dados) { est.erro = e.message; est.indisponivel = !!e.indisponivel; }
        throw e;
      } finally {
        est.carregando = null;
        notificar(est.idSL);
      }
    })();
    return est.carregando;
  }

  // Avisa as vistas do condomínio e a prestação (título, card guardado).
  function notificar(idSL) {
    var est = estadoDe(idSL);
    est.views = est.views.filter(function (v) { return v.container.isConnected && v.container._certView === v; });
    est.views.forEach(desenharPainel);
    est.views.forEach(function (v) {
      if (typeof v.opcoes.aoMudar === 'function') { try { v.opcoes.aoMudar(resumo(idSL)); } catch (e) { /* vista externa */ } }
    });
    aoMudarCertidoes(String(idSL));
  }

  // Busca sozinho, um por vez, os automáticos que faltam ou venceram (uma vez por página).
  async function autoBuscar(idSL) {
    var est = estadoDe(idSL);
    if (est.autoRodando || !est.dados) return;
    est.autoRodando = true;
    try {
      var tipos = est.dados.tipos.filter(function (t) {
        if (!t.automatica || tentadas[est.idSL + '|' + t.tipo]) return false;
        return !ehValida(situacao(certDoTipo(est, t.tipo)).estado);
      });
      for (var i = 0; i < tipos.length; i++) {
        tentadas[est.idSL + '|' + tipos[i].tipo] = true;
        await buscar(est.idSL, tipos[i].tipo, true);
      }
    } finally { est.autoRodando = false; }
  }

  async function buscar(idSL, tipo, sozinho) {
    var est = estadoDe(idSL);
    if (est.buscando[tipo]) return;
    est.buscando[tipo] = true; est.msgs[tipo] = '';
    notificar(est.idSL);
    try {
      var j = await chamar('/api/certidoes/' + encodeURIComponent(est.idSL) + '/buscar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: tipo }) });
      aplicarCertidao(est, j.certidao);
      if (!sozinho) aviso(nomeDoTipo(est, tipo) + ': certidão buscada e guardada.', 'ok');
    } catch (e) {
      est.msgs[tipo] = e.indisponivel ? 'A busca automática ainda não está disponível. Use Emitir.' : e.message;
    } finally {
      est.buscando[tipo] = false;
      notificar(est.idSL);
    }
  }

  // Manda o PDF ao servidor. tipo 'auto' deixa o servidor descobrir qual certidão é.
  async function enviarCertidao(idSL, tipo, file) {
    if (!ehPdf(file)) throw new Error('Envie a certidão em PDF.');
    if (file.size > MAX_CERTIDAO) throw new Error('O PDF passa de 10 MB.');
    var j = await chamar('/api/certidoes/' + encodeURIComponent(idSL) + '/arquivo?tipo=' + encodeURIComponent(tipo) + '&nome=' + encodeURIComponent(file.name || 'certidao.pdf'),
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    if (!j || !j.certidao) throw new Error('O servidor não devolveu a certidão.');
    return j.certidao;
  }

  async function enviarNoCampo(idSL, tipo, files) {
    var est = estadoDe(idSL);
    var lista = Array.prototype.slice.call(files || []);
    if (!lista.length || est.enviando[tipo]) return;
    if (lista.length > 1) aviso('Neste campo vai um PDF. Para vários de uma vez, use a área "Arraste aqui todas as certidões".', 'warn');
    est.enviando[tipo] = true; est.msgs[tipo] = '';
    notificar(est.idSL);
    try {
      var c = await enviarCertidao(est.idSL, tipo, lista[0]);
      aplicarCertidao(est, c);
      aviso(nomeDoTipo(est, c.tipo) + ': certidão guardada.', 'ok');
    } catch (e) {
      est.msgs[tipo] = e.message;
    } finally {
      est.enviando[tipo] = false;
      notificar(est.idSL);
    }
  }

  // Área geral: cada PDF vai com tipo=auto, um por vez, e a lista mostra para onde foi.
  async function enviarGeral(idSL, files) {
    var est = estadoDe(idSL);
    var lista = Array.prototype.slice.call(files || []);
    if (!lista.length) return;
    var itens = lista.map(function (f) { return { nome: f.name || 'arquivo', estado: 'wait', msg: 'na fila' }; });
    est.geral = itens.concat(est.geral).slice(0, 12);
    notificar(est.idSL);
    for (var i = 0; i < lista.length; i++) {
      itens[i].msg = 'enviando...';
      notificar(est.idSL);
      try {
        var c = await enviarCertidao(est.idSL, 'auto', lista[i]);
        aplicarCertidao(est, c);
        itens[i].estado = 'ok'; itens[i].msg = 'foi para ' + nomeDoTipo(est, c.tipo);
      } catch (e) {
        itens[i].estado = 'err'; itens[i].msg = e.message;
      }
      notificar(est.idSL);
    }
  }

  async function remover(idSL, tipo) {
    var est = estadoDe(idSL);
    if (!confirm('Remover a certidão ' + nomeDoTipo(est, tipo) + ' guardada deste condomínio? Ela sai também das próximas prestações.')) return;
    try {
      await chamar('/api/certidoes/' + encodeURIComponent(est.idSL) + '/' + encodeURIComponent(tipo), { method: 'DELETE' });
      if (est.dados) est.dados.certidoes = est.dados.certidoes.filter(function (x) { return x.tipo !== tipo; });
      est.msgs[tipo] = '';
      notificar(est.idSL);
    } catch (e) {
      aviso('Não foi possível remover: ' + e.message, 'err');
    }
  }

  // Link do PDF guardado (renova a lista se o link já está perto de vencer).
  async function urlCertidao(idSL, tipo) {
    var est = estadoDe(idSL);
    var c = certDoTipo(est, tipo);
    if (!c || !c.url || Date.now() - (c._em || est.em) > URL_VALIDA_MS) {
      await carregar(est.idSL, true);
      c = certDoTipo(est, tipo);
    }
    if (!c || !c.url) throw new Error('o PDF desta certidão não está disponível agora');
    return c.url;
  }

  // Abre a aba na hora do clique (o navegador não bloqueia) e põe o endereço depois.
  function abrirDepois(promessaUrl) {
    var w = window.open('about:blank', '_blank');
    promessaUrl.then(function (url) {
      if (w && !w.closed) w.location.href = url; else window.open(url, '_blank');
    }, function (e) {
      if (w && !w.closed) w.close();
      aviso('Não foi possível abrir: ' + (e && e.message ? e.message : e) + '.', 'err');
    });
  }

  // Copia o CNPJ só com os dígitos. Começa dentro do clique (exigência do navegador).
  function copiarTexto(txt) {
    function antigo() {
      try {
        var ta = document.createElement('textarea');
        ta.value = txt; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(txt).then(function () { return true; }, function () { return antigo(); });
      }
    } catch (e) { /* cai no modo antigo */ }
    return Promise.resolve(antigo());
  }
  function copiarCnpj(est, mostrar) {
    var dig = soDig(est.dados && est.dados.cnpj);
    if (dig.length !== 14) {
      aviso('Este condomínio está sem CNPJ no cadastro do Superlógica. Confira o cadastro.', 'warn');
      return Promise.resolve(false);
    }
    return copiarTexto(dig).then(function (ok) {
      if (mostrar) aviso(ok ? 'CNPJ copiado: é só colar no campo do site.' : 'Não deu para copiar. O CNPJ é ' + dig + '.', ok ? 'ok' : 'warn');
      return ok;
    });
  }
  function abrirAba(link) {
    var w = window.open(link, '_blank');
    if (w) { try { w.opener = null; } catch (e) { /* outra origem */ } }
    return !!w;
  }

  function emitir(idSL, tipo) {
    var est = estadoDe(idSL);
    var t = (est.dados && est.dados.tipos || []).find(function (x) { return x.tipo === tipo; });
    if (!t) return;
    copiarCnpj(est, true);
    if (!t.link) { aviso('Não há site cadastrado para ' + t.nome + '. Emita no site da prefeitura e arraste o PDF aqui.', 'warn'); return; }
    if (!abrirAba(t.link)) aviso('O navegador bloqueou a nova aba. Libere as janelas pop up deste site e clique de novo.', 'warn');
  }

  // Abre de uma vez os sites que faltam (manuais, e automáticos cuja busca falhou).
  function abrirTodos(idSL) {
    var est = estadoDe(idSL);
    if (!est.dados) return;
    var alvo = est.dados.tipos.filter(function (t) {
      if (!t.link || ehValida(situacao(certDoTipo(est, t.tipo)).estado)) return false;
      return !t.automatica || (!est.buscando[t.tipo] && !!est.msgs[t.tipo]);
    });
    if (!alvo.length) { aviso('Nenhum site para abrir: as certidões que dependem de site já estão válidas.', 'info'); return; }
    copiarCnpj(est, false);
    var bloqueadas = 0;
    alvo.forEach(function (t) { if (!abrirAba(t.link)) bloqueadas++; });
    if (bloqueadas) aviso('O navegador bloqueou ' + bloqueadas + ' de ' + alvo.length + ' abas. Libere as janelas pop up deste site e clique de novo.', 'warn');
    else aviso('Abri ' + alvo.length + (alvo.length === 1 ? ' site' : ' sites') + '. O CNPJ está copiado: é só colar no campo de cada site.', 'ok');
  }

  // ── desenho do painel ──
  function desenharPainel(v) {
    var c = v.container;
    var est = estadoDe(v.idSL);
    if (!est.dados) {
      if (est.erro) {
        c.innerHTML = '<div class="cert-painel"><div class="hint" style="color:' + (est.indisponivel ? 'var(--muted)' : 'var(--danger)') + '">' + esc(est.erro) + '</div>'
          + '<button type="button" class="btn btn-ghost cert-mini" data-acao="recarregar" style="margin-top:8px">Tentar de novo</button></div>';
      } else {
        c.innerHTML = '<div class="cert-painel"><div class="hint">Lendo as certidões guardadas deste condomínio...</div></div>';
      }
      return;
    }
    var d = est.dados;
    var r = resumoDe(d.tipos, d.certidoes);
    var dig = soDig(d.cnpj);
    var h = '<div class="cert-painel">';
    h += '<div class="cert-topo"><div>'
      + '<div class="cert-cnpj-rot">CNPJ do condomínio</div>'
      + (dig.length === 14 ? '<div class="cert-cnpj-num">' + esc(fmtCnpj(dig)) + '</div>' : '<div class="cert-cnpj-num" style="color:var(--danger);font-size:14px">Sem CNPJ no cadastro do Superlógica</div>')
      + (d.nome ? '<div class="cert-cnpj-nome">' + esc(d.nome) + (d.cidade ? ' · ' + esc(d.cidade) : '') + '</div>' : '')
      + '</div><div class="cert-topo-acoes">'
      + '<span style="font-size:12px;color:var(--muted)">' + r.validas + ' de ' + r.total + ' válidas</span>'
      + (dig.length === 14 ? '<button type="button" class="btn btn-ghost cert-mini" data-acao="copiar">Copiar CNPJ</button>' : '')
      + '<button type="button" class="btn btn-primary cert-mini" data-acao="todos" title="O navegador pode pedir para liberar as janelas pop up deste site">Abrir todos os sites</button>'
      + '</div></div>';
    if (d.aviso) h += '<div class="hint" style="color:var(--warning);margin-top:8px">' + esc(d.aviso) + '</div>';
    h += '<div class="hint" style="margin:8px 0 4px">Emitir copia o CNPJ e abre o site; baixe o PDF e arraste na linha da certidão. Abrir todos os sites abre várias abas: o navegador pode pedir para liberar as janelas pop up deste site.</div>';

    d.tipos.forEach(function (t) {
      var cert = certDoTipo(est, t.tipo);
      var s = situacao(cert);
      var ocupado = est.buscando[t.tipo] || est.enviando[t.tipo];
      var sitTxt = est.buscando[t.tipo] ? 'Buscando...' : (est.enviando[t.tipo] ? 'Enviando...' : s.texto);
      var sitCls = ocupado ? 'wait' : s.cls;
      var det = [];
      if (cert && cert.emitida_em) det.push('emitida em ' + dataBr(cert.emitida_em));
      if (cert && cert.origem) det.push(cert.origem === 'automatica' ? 'buscada sozinha' : 'enviada');
      if (!cert) det.push(t.automatica ? 'sai sozinha' : 'arraste o PDF aqui');
      // Positiva é documento válido, mas mostra que há débito no órgão: fica em destaque.
      var alerta = cert && cert.situacao === 'positiva' ? 'Positiva: consta pendência no órgão.' : '';
      h += '<div class="cert-linha" data-drop="tipo" data-tipo="' + esc(t.tipo) + '">'
        + '<div><div class="cert-nome">' + esc(t.nome) + '</div><div class="cert-det">' + esc(det.join(' · ')) + '</div>'
        + (cert && cert.situacao === 'positiva_com_efeito_negativa' ? '<div class="cert-det">Positiva com efeito de negativa</div>' : '')
        + (alerta ? '<div class="cert-alerta">' + esc(alerta) + '</div>' : '') + '</div>'
        + '<div class="cert-sit ' + sitCls + '">' + esc(sitTxt) + '</div>'
        + '<div class="cert-acoes">'
        + (cert ? '<button type="button" class="btn btn-ghost" data-acao="ver" data-tipo="' + esc(t.tipo) + '">Ver</button>' : '')
        + '<button type="button" class="btn btn-ghost" data-acao="emitir" data-tipo="' + esc(t.tipo) + '"' + (t.link ? '' : ' title="Sem site cadastrado para esta cidade"') + '>Emitir</button>'
        + (t.automatica ? '<button type="button" class="btn btn-ghost" data-acao="buscar" data-tipo="' + esc(t.tipo) + '"' + (ocupado ? ' disabled' : '') + '>Buscar de novo</button>' : '')
        + '<label class="btn btn-ghost cert-enviar" title="Escolher o PDF desta certidão">Enviar PDF<input type="file" accept=".pdf,application/pdf" data-arquivo="tipo" data-tipo="' + esc(t.tipo) + '"' + (ocupado ? ' disabled' : '') + '></label>'
        + (cert ? '<button type="button" class="btn btn-ghost" data-acao="remover" data-tipo="' + esc(t.tipo) + '"' + (ocupado ? ' disabled' : '') + '>Remover</button>' : '')
        + '</div>'
        + (est.msgs[t.tipo] ? '<div class="cert-msg">' + esc(est.msgs[t.tipo]) + '</div>' : '')
        + '</div>';
    });

    h += '<div class="cert-drop" data-drop="geral">Arraste aqui todas as certidões de uma vez'
      + '<small>ou clique para escolher · PDFs · cada um vai para o campo certo</small>'
      + '<input type="file" multiple accept=".pdf,application/pdf" data-arquivo="geral"></div>';
    if (est.geral.length) {
      h += '<div class="cert-res">' + est.geral.map(function (g) {
        return '<div class="' + g.estado + '">' + esc(g.nome) + ': ' + esc(g.msg) + '</div>';
      }).join('') + '<div><button type="button" class="btn btn-ghost cert-mini" data-acao="limpar-geral" style="margin-top:4px">Limpar esta lista</button></div></div>';
    }
    h += '</div>';
    c.innerHTML = h;
  }

  // Eventos por delegação: o container é ligado uma vez e o conteúdo pode ser redesenhado.
  function ligarEventos(c) {
    if (c._certLigado) return;
    c._certLigado = true;
    c.addEventListener('click', function (ev) {
      var v = c._certView; if (!v) return;
      var b = ev.target.closest && ev.target.closest('[data-acao]');
      if (!b || !c.contains(b) || b.disabled) return;
      var tipo = b.getAttribute('data-tipo');
      var acao = b.getAttribute('data-acao');
      if (acao === 'recarregar') { estadoDe(v.idSL).erro = null; desenharPainel(v); carregar(v.idSL, true).then(function () { autoBuscar(v.idSL); }, function () {}); }
      else if (acao === 'copiar') copiarCnpj(estadoDe(v.idSL), true);
      else if (acao === 'todos') abrirTodos(v.idSL);
      else if (acao === 'ver') abrirDepois(urlCertidao(v.idSL, tipo));
      else if (acao === 'emitir') emitir(v.idSL, tipo);
      else if (acao === 'buscar') buscar(v.idSL, tipo, false);
      else if (acao === 'remover') remover(v.idSL, tipo);
      else if (acao === 'limpar-geral') { estadoDe(v.idSL).geral = []; notificar(v.idSL); }
    });
    c.addEventListener('change', function (ev) {
      var v = c._certView; var inp = ev.target;
      if (!v || !inp || !inp.getAttribute || !inp.getAttribute('data-arquivo')) return;
      var files = Array.prototype.slice.call(inp.files || []);
      inp.value = '';
      if (inp.getAttribute('data-arquivo') === 'geral') enviarGeral(v.idSL, files);
      else enviarNoCampo(v.idSL, inp.getAttribute('data-tipo'), files);
    });
    ligarArrastar(c, function (alvo, files) {
      var v = c._certView; if (!v) return;
      var pdfs = files.filter(ehPdf);
      if (!pdfs.length) { aviso('Arraste arquivos em PDF.', 'warn'); return; }
      if (alvo.getAttribute('data-drop') === 'geral') enviarGeral(v.idSL, pdfs);
      else enviarNoCampo(v.idSL, alvo.getAttribute('data-tipo'), pdfs);
    });
  }

  // Arrastar e soltar em qualquer [data-drop] do container. Soltar fora de uma área
  // dentro do container não deixa o navegador abrir o PDF por cima do sistema.
  function ligarArrastar(c, aoSoltar) {
    function alvoDe(ev) { var a = ev.target.closest && ev.target.closest('[data-drop]'); return a && c.contains(a) ? a : null; }
    c.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      var a = alvoDe(ev);
      c.querySelectorAll('[data-drop].sobre').forEach(function (x) { if (x !== a) x.classList.remove('sobre'); });
      if (a) a.classList.add('sobre');
    });
    c.addEventListener('dragleave', function (ev) {
      var a = alvoDe(ev);
      if (a && !(ev.relatedTarget && a.contains(ev.relatedTarget))) a.classList.remove('sobre');
    });
    c.addEventListener('drop', function (ev) {
      ev.preventDefault();
      c.querySelectorAll('[data-drop].sobre').forEach(function (x) { x.classList.remove('sobre'); });
      var a = alvoDe(ev);
      var files = Array.prototype.slice.call((ev.dataTransfer && ev.dataTransfer.files) || []);
      if (a && files.length) aoSoltar(a, files);
    });
  }

  // API pública: monta o painel de certidões de um condomínio em um container.
  // opcoes: { autoBuscar: true (busca sozinho os automáticos que faltam), aoMudar(resumo) }
  function montarPainel(container, idSuperlogica, opcoes) {
    if (!container) return null;
    garantirEstilo();
    opcoes = opcoes || {};
    if (!/^[1-9][0-9]{0,8}$/.test(String(idSuperlogica || ''))) {
      container._certView = null;
      container.innerHTML = '<div class="cert-painel"><div class="hint">Certidões só para condomínio cadastrado no Superlógica (o CNPJ vem do cadastro).</div></div>';
      return null;
    }
    var v = { container: container, idSL: String(idSuperlogica), opcoes: opcoes };
    container._certView = v;
    ligarEventos(container);
    var est = estadoDe(v.idSL);
    est.views = est.views.filter(function (x) { return x.container !== container && x.container.isConnected; });
    est.views.push(v);
    desenharPainel(v);
    if (!est.dados && !est.erro) {
      carregar(v.idSL).then(function () { if (opcoes.autoBuscar !== false) autoBuscar(v.idSL); }, function () {});
    } else if (est.dados && opcoes.autoBuscar !== false) {
      autoBuscar(v.idSL);
    }
    return { recarregar: function () { return carregar(v.idSL, true); }, resumo: function () { return resumo(v.idSL); } };
  }

  // ════════════════════════════════════════════════════════════════════
  // PARTE 2: INTEGRAÇÃO COM A PRESTAÇÃO DE CONTAS
  // ════════════════════════════════════════════════════════════════════
  // pacote: o que vai junto da prestação desta tela.
  //   incluir: caixa "Incluir certidões negativas"
  //   docs: outros documentos { id, nome (guardado), original, bytes, blob|null, noTrabalho, url, urlEm, enviando, erro }
  //   certSalvas: certidões como estavam guardadas no trabalho (enquanto a lista do servidor não chega)
  //   aberto: painel aberto no card da prestação guardada
  var seqDoc = 0;
  var pacote = novoPacote();
  function novoPacote() { return { incluir: false, docs: [], certSalvas: [], aberto: false, cardDe: null }; }

  function temTrabalho() { return typeof prestTrabalho !== 'undefined' && !!prestTrabalho.id; }
  function emModoLivre() {
    var livre = document.getElementById('prest-modo-livre');
    return !!(livre && livre.style.display !== 'none');
  }
  // Condomínio das certidões: o da prestação guardada; sem ela, o escolhido na tela.
  function idSLDoPacote() {
    if (temTrabalho()) {
      var ctx = prestTrabalho.ctx || {};
      return ctx.modoLivre ? null : (prestTrabalho.idSLTrabalho || ctx.idSuperlogica || null);
    }
    if (emModoLivre() || typeof prestacaoState === 'undefined') return null;
    return prestacaoState.condIdSuperlogica || null;
  }

  // Resumo para o trabalho: lista do servidor se já leu; senão, o que estava guardado.
  function resumoDoPacote() {
    var idSL = idSLDoPacote();
    if (!idSL) return null;
    var r = resumo(idSL);
    if (r) return r;
    if (pacote.certSalvas.length) {
      return resumoDe(pacote.certSalvas.map(function (x) { return { tipo: x.tipo, nome: x.nome }; }),
        pacote.certSalvas.filter(function (x) { return x.tem; }).map(function (x) { return { tipo: x.tipo, validade: x.validade, situacao: x.situacao }; }));
    }
    return null;
  }

  // Campos com ordem fixa: a mesma conta vale para comparar o que já foi salvo.
  function normalizarExtras(o) {
    o = o || {};
    return {
      incluir_certidoes: !!o.incluir_certidoes,
      certidoes: (Array.isArray(o.certidoes) ? o.certidoes : []).map(function (c) {
        return { tipo: String(c.tipo || ''), nome: String(c.nome || ''), estado: String(c.estado || ''), validade: c.validade || null, situacao: c.situacao || null, tem: !!c.tem };
      }),
      outros_docs: (Array.isArray(o.outros_docs) ? o.outros_docs : []).map(function (d) {
        return { nome: String(d.nome || ''), original: String(d.original || ''), bytes: Number(d.bytes) || 0 };
      })
    };
  }

  // O que entra em dados do trabalho e o final do título. idTrabalho: só os documentos
  // que já estão anexados a esse trabalho entram na lista.
  function extrasDoTrabalho(idTrabalho) {
    var r = pacote.incluir ? resumoDoPacote() : null;
    var dados = normalizarExtras({
      incluir_certidoes: pacote.incluir,
      certidoes: r ? r.tipos : [],
      outros_docs: pacote.docs.filter(function (d) { return idTrabalho && d.noTrabalho === idTrabalho; })
    });
    return { dados: dados, sufixo: pacote.incluir && (!r || !r.completo) ? SUFIXO_AGUARDANDO : '' };
  }

  // Separa, nos dados guardados, o que é da prestação e o que é desta parte.
  function separarExtras(d) {
    var base = {};
    Object.keys(d || {}).forEach(function (k) { if (k !== 'incluir_certidoes' && k !== 'certidoes' && k !== 'outros_docs') base[k] = d[k]; });
    return { base: base, extras: normalizarExtras(d) };
  }
  function tirarSufixo(titulo) {
    var t = String(titulo || '');
    return t.slice(-SUFIXO_AGUARDANDO.length) === SUFIXO_AGUARDANDO ? t.slice(0, -SUFIXO_AGUARDANDO.length) : t;
  }

  // Pede para a prestação salvar de novo (mesmo id), sem gerar nada. Espera um pouco
  // para juntar várias mudanças seguidas em um salvamento só.
  var timerSalvar = null;
  function talvezSalvar(jaJa) {
    if (!temTrabalho() || typeof prestacaoSalvarExtras !== 'function') return;
    clearTimeout(timerSalvar);
    timerSalvar = setTimeout(function () { prestacaoSalvarExtras(); }, jaJa ? 0 : 700);
  }

  // Anexa ao trabalho os documentos que ainda não estão nele. Chamado pela fila de
  // salvamentos da prestação (public/prestacao.js, prestacaoSalvarExtras).
  async function anexarPendentes(idTrabalho) {
    // Documento que veio de outro trabalho sem o arquivo em memória fica naquele trabalho.
    pacote.docs = pacote.docs.filter(function (d) { return d.noTrabalho === idTrabalho || d.blob; });
    var pend = pacote.docs.filter(function (d) { return d.noTrabalho !== idTrabalho && d.blob && !d.enviando; });
    if (!pend.length || !window.Trabalhos) return;
    for (var i = 0; i < pend.length; i++) {
      var d = pend[i];
      d.enviando = true; d.erro = '';
      desenharPrestacao();
      try {
        await Trabalhos.anexar(idTrabalho, d.nome, d.blob);
        d.noTrabalho = idTrabalho;
        d.url = null; d.urlEm = 0;
      } catch (e) {
        d.erro = /arquivos_demais/.test(e.message) ? 'passou do limite de arquivos desta prestação' : e.message;
      }
      d.enviando = false;
    }
    desenharPrestacao();
  }

  // Nome guardado: "Doc " + nome original, sem acento, sem repetir.
  function nomeDocUnico(original) {
    var base = String(original || 'documento').replace(/\.pdf$/i, '');
    var usados = {};
    pacote.docs.forEach(function (d) { usados[d.nome.toLowerCase()] = true; });
    if (temTrabalho()) (prestTrabalho.arquivos || []).forEach(function (a) { usados[String(a.nome).toLowerCase()] = true; });
    var fazer = typeof prestacaoNomeGuardado === 'function' ? prestacaoNomeGuardado : function (b, e) { return b + '.' + e; };
    var nome = fazer('Doc ' + base, 'pdf');
    for (var n = 2; usados[nome.toLowerCase()] && n < 100; n++) nome = fazer('Doc ' + base.slice(0, 100) + ' (' + n + ')', 'pdf');
    return nome;
  }

  function adicionarDocs(files) {
    var lista = Array.prototype.slice.call(files || []);
    var recusados = [];
    lista.forEach(function (f) {
      if (!ehPdf(f)) { recusados.push(f.name + ' (não é PDF)'); return; }
      if (f.size > MAX_DOC) { recusados.push(f.name + ' (passa de 40 MB)'); return; }
      if (pacote.docs.length >= MAX_DOCS) { recusados.push(f.name + ' (limite de ' + MAX_DOCS + ' documentos)'); return; }
      pacote.docs.push({ id: ++seqDoc, nome: nomeDocUnico(f.name), original: f.name || 'documento.pdf', bytes: f.size || 0, blob: f, noTrabalho: null, url: null, urlEm: 0, enviando: false, erro: '' });
    });
    if (recusados.length) aviso('Ficaram de fora: ' + recusados.join(', ') + '.', 'warn');
    desenharPrestacao();
    if (temTrabalho()) talvezSalvar(true);
  }

  function removerDoc(id) {
    var d = pacote.docs.find(function (x) { return x.id === id; });
    if (!d) return;
    if (d.enviando) { aviso('Espere este documento terminar de subir.', 'warn'); return; }
    if (!confirm('Tirar "' + d.original + '" dos documentos desta prestação?')) return;
    pacote.docs = pacote.docs.filter(function (x) { return x.id !== id; });
    desenharPrestacao();
    if (d.noTrabalho) talvezSalvar(true);
  }

  // Link do documento guardado no trabalho (relê o trabalho se o link está velho).
  async function urlDoDoc(d) {
    if (d.url && Date.now() - d.urlEm < URL_VALIDA_MS) return d.url;
    if (!temTrabalho() || d.noTrabalho !== prestTrabalho.id || typeof prestacaoRenovarLinks !== 'function') throw new Error('o documento não está mais na pasta');
    await prestacaoRenovarLinks();
    var u = prestTrabalho.urls && prestTrabalho.urls[d.nome];
    if (!u || !u.url) throw new Error('o documento não está mais na pasta');
    d.url = u.url; d.urlEm = Date.now();
    return d.url;
  }
  async function blobDoDoc(d) {
    if (d.blob) return d.blob;
    var url = await urlDoDoc(d);
    if (window.Trabalhos && Trabalhos.baixarArquivo) return Trabalhos.baixarArquivo(url);
    var r = await fetch(url); if (!r.ok) throw new Error('arquivo indisponível'); return r.blob();
  }
  function verDoc(id) {
    var d = pacote.docs.find(function (x) { return x.id === id; });
    if (!d) return;
    if (d.blob) {
      var u = URL.createObjectURL(d.blob);
      if (!abrirAba(u)) aviso('O navegador bloqueou a nova aba. Libere as janelas pop up deste site.', 'warn');
      setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
      return;
    }
    abrirDepois(urlDoDoc(d));
  }

  function htmlOutros() {
    var docs = pacote.docs;
    var h = '<div class="cert-sec">Outros documentos <span style="font-weight:400;color:var(--muted);font-size:12px">(opcional)</span></div>'
      + '<div class="hint">Atas, contratos, laudos. Vão em arquivos separados, junto da prestação.</div>'
      + '<div class="cert-drop" data-drop="docs" style="padding:12px">Arraste aqui os PDFs<small>ou clique para escolher · vários de uma vez</small>'
      + '<input type="file" multiple accept=".pdf,application/pdf" data-docs="1"></div>';
    docs.forEach(function (d) {
      var est = d.enviando ? 'subindo...' : (d.erro ? 'não guardou: ' + d.erro : (d.noTrabalho ? 'guardado na pasta' : (temTrabalho() ? 'subindo...' : 'vai junto quando a prestação for gerada')));
      h += '<div class="cert-doc"><span class="cert-doc-nome" title="' + esc(d.original) + '">' + esc(d.original) + '</span>'
        + '<span class="cert-doc-est"' + (d.erro ? ' style="color:var(--danger)"' : '') + '>' + esc(tamanho(d.bytes)) + ' · ' + esc(est) + '</span>'
        + '<button type="button" class="btn btn-ghost cert-mini" data-doc-ver="' + d.id + '">Ver</button>'
        + '<button type="button" class="btn btn-ghost cert-mini" data-doc-remover="' + d.id + '">Remover</button></div>';
    });
    return h;
  }

  // Eventos dos blocos da prestação (caixa, documentos, botões do card guardado).
  function ligarBloco(el) {
    if (el._certBloco) return;
    el._certBloco = true;
    el.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t && t.classList && t.classList.contains('cert-incluir')) definirIncluir(t.checked);
      else if (t && t.getAttribute && t.getAttribute('data-docs')) { var f = Array.prototype.slice.call(t.files || []); t.value = ''; adicionarDocs(f); }
    });
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('[data-doc-ver],[data-doc-remover],[data-pacote]');
      if (!b || !el.contains(b) || b.disabled) return;
      if (b.hasAttribute('data-doc-ver')) verDoc(+b.getAttribute('data-doc-ver'));
      else if (b.hasAttribute('data-doc-remover')) removerDoc(+b.getAttribute('data-doc-remover'));
      else if (b.getAttribute('data-pacote') === 'abrir') abrirNoGuardado();
      else if (b.getAttribute('data-pacote') === 'fechar') { pacote.aberto = false; desenharPrestacao(); }
      else if (b.getAttribute('data-pacote') === 'zip') baixarTudo(b);
    });
    // Só a área de documentos; o painel de certidões tem a própria (ligada no container dele).
    el.addEventListener('dragover', function (ev) {
      var a = ev.target.closest && ev.target.closest('[data-drop="docs"]');
      if (!a) return;
      ev.preventDefault(); a.classList.add('sobre');
    });
    el.addEventListener('dragleave', function (ev) {
      var a = ev.target.closest && ev.target.closest('[data-drop="docs"]');
      if (a && !(ev.relatedTarget && a.contains(ev.relatedTarget))) a.classList.remove('sobre');
    });
    el.addEventListener('drop', function (ev) {
      var a = ev.target.closest && ev.target.closest('[data-drop="docs"]');
      if (!a) return;
      ev.preventDefault(); a.classList.remove('sobre');
      adicionarDocs((ev.dataTransfer && ev.dataTransfer.files) || []);
    });
  }

  function definirIncluir(v) {
    var idSL = idSLDoPacote();
    if (v && !idSL) {
      aviso('Certidões só para condomínio cadastrado no Superlógica (o CNPJ vem do cadastro).', 'warn');
      v = false;
    }
    pacote.incluir = !!v;
    if (temTrabalho() && pacote.incluir) pacote.aberto = true;
    desenharPrestacao();
    if (temTrabalho()) {
      talvezSalvar();
      if (pacote.incluir) rolarAte(document.getElementById('prest-guardado-cert'));
    }
  }
  function abrirNoGuardado() {
    pacote.aberto = true;
    if (idSLDoPacote()) pacote.incluir = true;
    desenharPrestacao();
    talvezSalvar();
  }
  function rolarAte(el) { if (el && el.scrollIntoView) { try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* navegador antigo */ } } }

  function htmlCaixa() {
    var idSL = idSLDoPacote();
    return '<label class="cert-chk"><input type="checkbox" class="cert-incluir"' + (pacote.incluir ? ' checked' : '') + (idSL ? '' : ' disabled') + '> Incluir certidões negativas</label>'
      + '<div class="hint" style="margin-top:2px">' + (idSL
        ? 'Opcional. Cada certidão vai em um arquivo separado, junto da prestação. As que já estão guardadas e válidas entram sozinhas.'
        : 'Certidões só para condomínio cadastrado no Superlógica (o CNPJ vem do cadastro).') + '</div>';
  }

  // Card 2: caixa, painel e outros documentos (antes de gerar). Depois de gerar, o
  // painel fica no card da prestação guardada e aqui só aparece a caixa.
  function blocoCard2() {
    var el = document.getElementById('prest-cert-card2');
    if (el) return el;
    var btn = document.getElementById('prest-btn-superlogica');
    var card = btn && btn.closest ? btn.closest('.card') : null;
    if (!card) return null;
    el = document.createElement('div');
    el.id = 'prest-cert-card2';
    el.className = 'cert-bloco';
    var formato = card.querySelector('.prest-formato');
    if (formato && formato.parentNode === card) card.insertBefore(el, formato.nextSibling);
    else card.appendChild(el);
    ligarBloco(el);
    return el;
  }

  var ultimoIdSLCard2 = null;
  function desenharCard2() {
    var el = blocoCard2();
    if (!el) return;
    var idSL = idSLDoPacote();
    if (!idSL && pacote.incluir && !temTrabalho()) pacote.incluir = false;
    if (temTrabalho()) {
      el.innerHTML = htmlCaixa() + '<div class="hint" style="margin-top:6px">As certidões e os outros documentos desta prestação ficam no quadro da prestação guardada, logo abaixo.</div>';
      ultimoIdSLCard2 = null;
      return;
    }
    el.innerHTML = htmlCaixa() + '<div class="cert-painel-host"></div><div class="cert-outros-host">' + htmlOutros() + '</div>';
    if (pacote.incluir && idSL) montarPainel(el.querySelector('.cert-painel-host'), idSL, {});
    ultimoIdSLCard2 = idSL;
  }

  // Card da prestação guardada: botões, o que falta e (aberto) o painel.
  function desenharGuardado() {
    var botoes = document.getElementById('prest-guardado-cert-botoes');
    var box = document.getElementById('prest-guardado-cert');
    if (!botoes || !box) return;
    ligarBloco(botoes); ligarBloco(box);
    if (!temTrabalho()) { botoes.innerHTML = ''; box.innerHTML = ''; return; }
    botoes.innerHTML = (pacote.aberto
      ? '<button type="button" class="btn btn-ghost" data-pacote="fechar" style="font-size:12px;padding:6px 12px">Fechar certidões e documentos</button>'
      : '<button type="button" class="btn btn-ghost" data-pacote="abrir" style="font-size:12px;padding:6px 12px">Incluir certidões e documentos</button>')
      + '<button type="button" class="btn btn-primary" data-pacote="zip" style="font-size:12px;padding:6px 12px" title="Prestação, certidões válidas e outros documentos em um arquivo .zip">Baixar tudo</button>';
    var h = '<div class="cert-resumo">' + htmlResumo() + '</div>';
    if (pacote.aberto) {
      h += '<div class="cert-bloco" style="margin-top:12px">' + htmlCaixa() + '<div class="cert-painel-host"></div>' + htmlOutros() + '</div>';
    }
    box.innerHTML = h;
    var idSL = idSLDoPacote();
    if (pacote.aberto && pacote.incluir && idSL) montarPainel(box.querySelector('.cert-painel-host'), idSL, {});
  }

  function htmlResumo() {
    var partes = [];
    if (pacote.incluir) {
      var r = resumoDoPacote();
      if (!r) partes.push('<span class="warn">Aguardando certidões.</span> Abra as certidões para conferir o que falta.');
      else if (r.completo) partes.push('<span class="ok">Certidões completas: ' + r.validas + ' de ' + r.total + ' válidas.</span>');
      else partes.push('<span class="warn">Aguardando certidões.</span> Falta: ' + esc(r.faltando.join(', ')) + '.');
    }
    var nDocs = pacote.docs.filter(function (d) { return d.noTrabalho; }).length;
    if (nDocs) partes.push(nDocs + (nDocs === 1 ? ' outro documento guardado.' : ' outros documentos guardados.'));
    return partes.join(' ');
  }

  function desenharPrestacao() {
    garantirEstilo();
    desenharCard2();
    desenharGuardado();
  }

  // Certidões de um condomínio mudaram: atualiza o resumo do card e salva o trabalho se for o dele.
  function aoMudarCertidoes(idSL) {
    if (String(idSLDoPacote() || '') !== idSL) return;
    if (temTrabalho()) {
      var box = document.getElementById('prest-guardado-cert');
      var res = box && box.querySelector('.cert-resumo');
      if (res) res.innerHTML = htmlResumo();
      if (pacote.incluir) talvezSalvar();
    }
  }

  // ── Baixar tudo (.zip montado no navegador) ──
  async function baixarTudo(btn) {
    if (!temTrabalho()) return;
    if (!window.JSZip) { aviso('Não foi possível montar o pacote neste navegador. Baixe os arquivos um por um.', 'err'); return; }
    var texto = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Montando...'; }
    var faltas = [];
    try {
      var zip = new window.JSZip();
      var usados = {};
      function poe(pasta, nome, blob) {
        var n = nomeArquivoSeguro(nome), base = n.replace(/\.[^.]+$/, ''), ext = (/\.[^.]+$/.exec(n) || [''])[0];
        for (var i = 2; usados[(pasta + '/' + n).toLowerCase()]; i++) n = base + ' (' + i + ')' + ext;
        usados[(pasta + '/' + n).toLowerCase()] = true;
        (pasta ? zip.folder(pasta) : zip).file(n, blob);
      }
      // Prestação (PDF e/ou PowerPoint guardados)
      var arqs = prestTrabalho.arquivos || [];
      for (var i = 0; i < arqs.length; i++) {
        try { poe('', arqs[i].nomeBaixar || arqs[i].nome, await prestacaoBlobGuardado(arqs[i].tipo)); }
        catch (e) { faltas.push(arqs[i].rotulo || arqs[i].tipo); }
      }
      // Certidões válidas
      var idSL = idSLDoPacote();
      if (pacote.incluir && idSL) {
        var est = estadoDe(idSL);
        try { await carregar(idSL, !est.dados || Date.now() - est.em > URL_VALIDA_MS); } catch (e) { faltas.push('certidões'); }
        if (est.dados) {
          for (var k = 0; k < est.dados.tipos.length; k++) {
            var t = est.dados.tipos[k];
            var c = certDoTipo(est, t.tipo);
            if (!c || !ehValida(situacao(c).estado)) continue;
            try {
              var url = await urlCertidao(idSL, t.tipo);
              var r = await fetch(url);
              if (!r.ok) throw new Error('indisponível');
              poe('Certidoes', 'Certidao ' + t.nome + '.pdf', await r.blob());
            } catch (e) { faltas.push(t.nome); }
          }
        }
      }
      // Outros documentos
      var docs = pacote.docs.filter(function (d) { return d.noTrabalho === prestTrabalho.id || d.blob; });
      for (var j = 0; j < docs.length; j++) {
        try { poe('Outros documentos', docs[j].original, await blobDoDoc(docs[j])); }
        catch (e) { faltas.push(docs[j].original); }
      }
      if (!Object.keys(usados).length) throw new Error('nenhum arquivo disponível');
      var ctx = prestTrabalho.ctx || {};
      var rot = typeof prestacaoMesRotulo === 'function' ? prestacaoMesRotulo : function (x) { return x; };
      var periodo = ctx.mesInicio && ctx.mesFim ? rot(ctx.mesInicio) + ' a ' + rot(ctx.mesFim) : (ctx.periodo || '');
      var nome = nomeArquivoSeguro('Prestacao ' + (ctx.condNome || '') + ' ' + periodo) + '.zip';
      var blob = await zip.generateAsync({ type: 'blob' });
      if (typeof prestacaoDispararDownload === 'function') prestacaoDispararDownload(URL.createObjectURL(blob), nome);
      if (faltas.length) aviso('O pacote saiu sem: ' + faltas.join(', ') + '.', 'warn');
      else aviso('Pacote baixado.', 'ok');
    } catch (e) {
      aviso('Não foi possível montar o pacote: ' + (e && e.message ? e.message : e) + '.', 'err');
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = texto; }
    }
  }

  // ── ganchos chamados por public/prestacao.js ──

  // Card da prestação guardada redesenhado (depois de gerar, salvar ou reabrir).
  function completarCardGuardado() {
    if (temTrabalho() && pacote.cardDe !== prestTrabalho.id) {
      // Acabou de gerar: o que estava aberto no card 2 passa para o card guardado.
      pacote.cardDe = prestTrabalho.id;
      pacote.aberto = pacote.incluir || pacote.docs.length > 0;
    }
    desenharPrestacao();
  }

  // A tela esqueceu a prestação guardada (ela continua na pasta). Documentos já
  // anexados ficam com ela; os que só estavam em memória continuam para a próxima.
  function aoEsquecerTrabalho() {
    clearTimeout(timerSalvar);
    pacote.docs = pacote.docs.filter(function (d) { return !d.noTrabalho; });
    pacote.certSalvas = [];
    pacote.aberto = false;
    pacote.cardDe = null;
    desenharPrestacao();
  }

  // Reaberta pela pasta Em andamento. Devolve a parte da prestação dos dados e a chave
  // do que já está salvo (para não salvar de novo sem mudança).
  function aoRestaurar(t) {
    var d = (t && t.dados) || {};
    var sep = separarExtras(d);
    var urls = {};
    (t.arquivos || []).forEach(function (f) { urls[f.nome] = f.url || null; });
    pacote = novoPacote();
    pacote.incluir = sep.extras.incluir_certidoes;
    pacote.certSalvas = sep.extras.certidoes;
    pacote.docs = sep.extras.outros_docs.filter(function (x) { return x.nome && Object.prototype.hasOwnProperty.call(urls, x.nome); }).map(function (x) {
      return { id: ++seqDoc, nome: x.nome, original: x.original || x.nome, bytes: x.bytes, blob: null, noTrabalho: t.id, url: urls[x.nome], urlEm: urls[x.nome] ? Date.now() : 0, enviando: false, erro: '' };
    });
    pacote.cardDe = t.id;
    pacote.aberto = false;
    // Lê as certidões do condomínio para o resumo (uma válida guardada depois entra sozinha).
    var idSL = t.id_superlogica && !d.modoLivre ? String(t.id_superlogica) : null;
    if (pacote.incluir && idSL) setTimeout(function () { carregar(idSL, true).catch(function () {}); }, 0);
    return { base: sep.base, chave: String(t.titulo || '') + '|' + JSON.stringify(sep.extras), tituloBase: tirarSufixo(t.titulo) };
  }

  // Limpar tudo da prestação: começa do zero.
  function limpar() {
    clearTimeout(timerSalvar);
    pacote = novoPacote();
    desenharPrestacao();
  }

  // Condomínio da tela mudou (seletor, modo livre). Redesenha se mudou o condomínio.
  function atualizar() {
    if (temTrabalho()) return;
    var idSL = idSLDoPacote();
    if (idSL === ultimoIdSLCard2 && document.getElementById('prest-cert-card2')) return;
    desenharPrestacao();
  }

  // Outro condomínio: o que estava na tela era do anterior.
  window.addEventListener('condominioAtivo:trocou', function () {
    if (typeof prestacaoState !== 'undefined' && prestacaoState.gerando) return;
    if (emModoLivre()) return; // fora do Superlógica: documentos não dependem do ativo
    pacote = novoPacote();
    ultimoIdSLCard2 = undefined;
    desenharPrestacao();
  });

  window.Certidoes = {
    montarPainel: montarPainel,
    resumo: resumo,
    carregar: carregar,
    // prestação
    extrasDoTrabalho: extrasDoTrabalho,
    anexarPendentes: anexarPendentes,
    completarCardGuardado: completarCardGuardado,
    aoEsquecerTrabalho: aoEsquecerTrabalho,
    aoRestaurar: aoRestaurar,
    limpar: limpar,
    atualizar: atualizar,
    baixarTudo: baixarTudo,
    SUFIXO_AGUARDANDO: SUFIXO_AGUARDANDO
  };

  // Primeiro desenho do card 2 (a aba pode já estar aberta).
  function iniciar() { try { desenharPrestacao(); } catch (e) { /* tela ainda não montada */ } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
