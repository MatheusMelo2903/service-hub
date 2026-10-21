// ============================================================
// Conciliação (T35): funções puras usadas no servidor (financeiro/conciliacao.js) e na tela
// (comparação do arquivo OFX antes de importar). Sem rede, sem gravação.
// Valores em centavos (inteiros) e datas AAAA-MM-DD para não ter erro de arredondamento.
// ============================================================
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.ConciliacaoCasar = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── utilitários ─────────────────────────────────────────────
  function centavos(v) {
    if (typeof v === 'number') return Math.round(v * 100);
    var s = String(v == null ? '' : v).trim();
    if (!s) return 0;
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    var n = Number(s);
    return isFinite(n) ? Math.round(n * 100) : 0;
  }
  // MM/DD/AAAA (Superlógica), AAAA-MM-DD, AAAAMMDD (OFX) ou DD/MM/AAAA com dia > 12 não entra: a API usa MM/DD.
  function dataISO(v) {
    var s = String(v == null ? '' : v).trim();
    var m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return m[3] + '-' + m[1] + '-' + m[2];
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return '';
  }
  function diaNum(iso) { return Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000); }
  function dias(a, b) { return diaNum(b) - diaNum(a); }
  function maisDias(iso, n) { return new Date((diaNum(iso) + n) * 86400000).toISOString().slice(0, 10); }
  function diaUtil(iso) { var w = new Date(diaNum(iso) * 86400000).getUTCDay(); return w !== 0 && w !== 6; }
  function diasUteisEntre(depoisDe, ate) { // dias úteis em (depoisDe, ate]
    var n = 0;
    for (var d = maisDias(depoisDe, 1); d <= ate; d = maisDias(d, 1)) if (diaUtil(d)) n++;
    return n;
  }
  function semAcento(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  // Descrição sem números e sem pontuação, para juntar o mesmo tipo de item do extrato.
  function normDesc(s) {
    return semAcento(s).toUpperCase().replace(/\(\d+\)/g, ' ').replace(/[^A-Z ]+/g, ' ').replace(/\b[A-Z]\b(?: \b[A-Z]\b)+/g, function (x) { return x.replace(/ /g, ''); })
      .replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  var sinal = function (v) { return v < 0 ? -1 : 1; };
  var soma = function (l) { return l.reduce(function (s, x) { return s + x.valor; }, 0); };

  // Subconjunto de "lista" (no máximo 24 itens) que soma "alvo"; null se não houver.
  function subconjunto(lista, alvo) {
    if (!lista.length || lista.length > 24) return null;
    var estados = new Map([[0, null]]);
    for (var i = 0; i < lista.length; i++) {
      var novos = [];
      estados.forEach(function (_, s) { var t = s + lista[i].valor; if (!estados.has(t)) novos.push([t, [s, i]]); });
      for (var k = 0; k < novos.length; k++) estados.set(novos[k][0], novos[k][1]);
      if (estados.has(alvo) && alvo !== 0) break;
      if (estados.size > 6000) return null;
    }
    if (alvo === 0 || !estados.has(alvo)) return null;
    var out = [], s2 = alvo;
    while (s2 !== 0) { var p = estados.get(s2); out.push(lista[p[1]]); s2 = p[0]; }
    return out;
  }

  // Rendimento e imposto de aplicação/poupança: o banco lança por dia, o sistema uma vez no mês.
  var RX_REND_BANCO = /JUROS|CORRE[CÇ][AÃ]O MONET|RENDIMENTO|REMUNERA[CÇ]|RENDE F|I\.?\s?R\.?\s?R\.?\s?F|IMPOSTO DE RENDA|\bIR\b.*(APL|POUP|FIN)/i;
  var RX_REND_SISTEMA = /RENDIMENTO|IRRF|I\.R\.R\.F|IMPOSTO DE RENDA|JUROS (DE|S\/) ?(APLICA|POUPAN)/i;

  // ── casamento sistema x banco ──────────────────────────────
  // sistema: [{data, valor, descricao, origem?}], banco: [{data, valor, descricao, desconsiderado?}]
  // Devolve pares (exato, grupo, rendimento, data, valor), divergências e o que sobrou de cada lado.
  function casar(sistema, banco, op) {
    op = op || {};
    var tolDias = op.toleranciaDias == null ? 5 : op.toleranciaDias;
    var S = sistema.map(function (x, i) { return Object.assign({ _i: i, _usado: false }, x); });
    var B = banco.map(function (x, i) { return Object.assign({ _i: i, _usado: false }, x); });
    var ativos = B.filter(function (b) { return !b.desconsiderado; });
    var pares = [], divergencias = [];
    var livre = function (x) { return !x._usado; };
    var usar = function (l) { l.forEach(function (x) { x._usado = true; }); };

    // 1. mesmo dia e mesmo valor
    var porChave = new Map();
    ativos.forEach(function (b) { var k = b.data + '|' + b.valor; if (!porChave.has(k)) porChave.set(k, []); porChave.get(k).push(b); });
    S.forEach(function (s) {
      var l = porChave.get(s.data + '|' + s.valor);
      var b = l && l.find(livre);
      if (b) { usar([s, b]); pares.push({ tipo: 'exato', sistema: [s], banco: [b] }); }
    });

    // 2. mesmo dia e mesmo sinal: um lançamento que junta vários itens do banco (ou o contrário)
    var grupos = new Map();
    var agrupar = function (lado) {
      return function (x) {
        if (x._usado) return;
        var k = x.data + '|' + sinal(x.valor);
        if (!grupos.has(k)) grupos.set(k, { s: [], b: [] });
        grupos.get(k)[lado].push(x);
      };
    };
    S.forEach(agrupar('s'));
    ativos.forEach(agrupar('b'));
    grupos.forEach(function (g) {
      if (!g.s.length || !g.b.length) return;
      if (soma(g.s) === soma(g.b)) { usar(g.s.concat(g.b)); pares.push({ tipo: 'grupo', sistema: g.s, banco: g.b }); return; }
      g.s.slice().sort(function (a, b) { return Math.abs(b.valor) - Math.abs(a.valor); }).forEach(function (s) {
        if (s._usado) return;
        var sub = subconjunto(g.b.filter(livre), s.valor);
        if (sub && sub.length > 1) { usar([s].concat(sub)); pares.push({ tipo: 'grupo', sistema: [s], banco: sub }); }
      });
      g.b.slice().sort(function (a, b) { return Math.abs(b.valor) - Math.abs(a.valor); }).forEach(function (b) {
        if (b._usado) return;
        var sub = subconjunto(g.s.filter(livre), b.valor);
        if (sub && sub.length > 1) { usar([b].concat(sub)); pares.push({ tipo: 'grupo', sistema: sub, banco: [b] }); }
      });
    });

    // 2b. o dia inteiro fecha: lançamento com composição de valores positivos e negativos
    // (ex.: recebimento de cobrança com tarifa, fundo e rateios) contra os créditos do banco.
    var porDia = new Map();
    var porDiaLado = function (lado) { return function (x) { if (x._usado) return; if (!porDia.has(x.data)) porDia.set(x.data, { s: [], b: [] }); porDia.get(x.data)[lado].push(x); }; };
    S.forEach(porDiaLado('s'));
    ativos.forEach(porDiaLado('b'));
    porDia.forEach(function (g) {
      if (g.s.length && g.b.length && soma(g.s) === soma(g.b)) { usar(g.s.concat(g.b)); pares.push({ tipo: 'grupo', sistema: g.s, banco: g.b }); }
    });

    // 3. rendimento do mês: soma dos itens diários do banco contra o lançamento mensal do sistema
    var meses = new Map();
    S.forEach(function (s) { if (livre(s) && (s.origem === '3' || RX_REND_SISTEMA.test(s.descricao || ''))) { var m = s.data.slice(0, 7); if (!meses.has(m)) meses.set(m, { s: [], b: [] }); meses.get(m).s.push(s); } });
    ativos.forEach(function (b) { if (livre(b) && RX_REND_BANCO.test(b.descricao || '')) { var m = b.data.slice(0, 7); if (!meses.has(m)) meses.set(m, { s: [], b: [] }); meses.get(m).b.push(b); } });
    meses.forEach(function (g, mes) {
      if (!g.b.length) return;
      if (!g.s.length) {
        if (op.mesFechado && op.mesFechado(mes)) { usar(g.b); divergencias.push({ tipo: 'rendimento_sem_lancamento', mes: mes, banco: soma(g.b), sistema: 0, itens_banco: g.b.length }); }
        return; // mês aberto: o sistema lança o rendimento no fim do mês
      }
      usar(g.s.concat(g.b));
      if (soma(g.s) === soma(g.b)) pares.push({ tipo: 'rendimento', sistema: g.s, banco: g.b });
      else divergencias.push({ tipo: 'rendimento_diferente', mes: mes, banco: soma(g.b), sistema: soma(g.s), itens_banco: g.b.length });
    });

    // 4. mesmo valor em outro dia (data real diferente da baixa)
    S.forEach(function (s) {
      if (s._usado) return;
      var melhor = null;
      ativos.forEach(function (b) {
        if (b._usado || b.valor !== s.valor) return;
        var d = dias(s.data, b.data);
        if (Math.abs(d) <= tolDias && (!melhor || Math.abs(d) < Math.abs(melhor.d))) melhor = { b: b, d: d };
      });
      if (melhor) { usar([s, melhor.b]); pares.push({ tipo: 'data', sistema: [s], banco: [melhor.b], dias: melhor.d }); }
    });

    // 4b. estorno: débito e crédito de mesmo valor em até 3 dias, no mesmo lado, só quando a
    // descrição fala em estorno ou devolução, ou é a mesma (revisão 1, M1).
    var estornar = function (L, lado) {
      L.forEach(function (x) {
        if (x._usado) return;
        var y = L.find(function (z) {
          if (z === x || z._usado || z.valor !== -x.valor || Math.abs(dias(x.data, z.data)) > 3) return false;
          if (/ESTORN|DEVOL/i.test(semAcento((x.descricao || '') + ' ' + (z.descricao || '')))) return true;
          return lado === 's' && normDesc(x.descricao) === normDesc(z.descricao); // no banco, mesma descrição genérica não basta
        });
        if (y) { usar([x, y]); pares.push({ tipo: 'estorno', sistema: lado === 's' ? [x, y] : [], banco: lado === 'b' ? [x, y] : [] }); }
      });
    };
    estornar(ativos, 'b');
    estornar(S, 's');

    // 5. grupo em dias vizinhos (vários itens do banco em até 3 dias somando um lançamento)
    S.forEach(function (s) {
      if (s._usado) return;
      var viz = ativos.filter(function (b) { return livre(b) && sinal(b.valor) === sinal(s.valor) && Math.abs(dias(s.data, b.data)) <= 3; });
      var sub = viz.length > 1 ? subconjunto(viz, s.valor) : null;
      if (sub && sub.length > 1) { usar([s].concat(sub)); pares.push({ tipo: 'grupo', sistema: [s], banco: sub }); }
    });

    // 6. valor diferente perto da data (juros, multa ou desconto não registrados)
    var cand = [];
    S.forEach(function (s) {
      if (s._usado) return;
      ativos.forEach(function (b) {
        if (b._usado || sinal(b.valor) !== sinal(s.valor)) return;
        var d = dias(s.data, b.data);
        var dif = Math.abs(b.valor) - Math.abs(s.valor);
        var lim = Math.min(Math.max(Math.round(Math.abs(s.valor) * 0.15), 100), 100000); // 15%, no mínimo R$ 1 e no máximo R$ 1.000
        if (Math.abs(d) <= 3 && dif !== 0 && Math.abs(dif) <= lim) cand.push({ s: s, b: b, d: d, dif: dif });
      });
    });
    cand.sort(function (x, y) { return Math.abs(x.dif) - Math.abs(y.dif) || Math.abs(x.d) - Math.abs(y.d); });
    cand.forEach(function (c) {
      if (c.s._usado || c.b._usado) return;
      usar([c.s, c.b]);
      pares.push({ tipo: 'valor', sistema: [c.s], banco: [c.b], dias: c.d, diferenca: c.dif });
    });

    // 7. lançado no sistema, mas o item do extrato foi marcado para desconsiderar
    S.forEach(function (s) {
      if (s._usado) return;
      var b = null;
      B.forEach(function (x) {
        if (!x.desconsiderado || x._usado || x.valor !== s.valor || x.data.slice(0, 7) !== s.data.slice(0, 7)) return;
        if (!b || Math.abs(dias(s.data, x.data)) < Math.abs(dias(s.data, b.data))) b = x;
      });
      if (b) { usar([s, b]); divergencias.push({ tipo: 'lancado_e_desconsiderado', data: s.data, valor: s.valor, sistema: s, banco: b }); }
    });
    // 7b. um lançamento do mês igual à soma das tarifas desconsideradas do mês (tarifa lançada de uma vez)
    S.forEach(function (s) {
      if (s._usado || s.valor >= 0) return;
      var desc = B.filter(function (x) { return x.desconsiderado && !x._usado && x.valor < 0 && x.data.slice(0, 7) === s.data.slice(0, 7); });
      if (desc.length > 1 && soma(desc) === s.valor) {
        usar([s].concat(desc));
        divergencias.push({ tipo: 'tarifas_desconsideradas_lancadas_no_mes', mes: s.data.slice(0, 7), data: s.data, valor: s.valor, banco: soma(desc), sistema: s.valor, itens_banco: desc.length, descricao: s.descricao, descricao_banco: desc[0].descricao, bancos: desc });
      }
    });

    var limpa = function (x) { var o = Object.assign({}, x); delete o._i; delete o._usado; return o; };
    return {
      pares: pares.map(function (p) { return Object.assign({}, p, { sistema: p.sistema.map(limpa), banco: p.banco.map(limpa) }); }),
      divergencias: divergencias.map(function (d) {
        var o = Object.assign({}, d);
        if (o.sistema && o.sistema._i != null) o.sistema = limpa(o.sistema);
        if (o.banco && o.banco._i != null) o.banco = limpa(o.banco);
        if (o.bancos) o.bancos = o.bancos.map(limpa);
        return o;
      }),
      desconsideradosLivres: B.filter(function (b) { return b.desconsiderado && livre(b); }).map(limpa),
      soBanco: ativos.filter(livre).map(limpa),
      soSistema: S.filter(livre).map(limpa),
      desconsiderados: B.filter(function (b) { return b.desconsiderado; }).length,
    };
  }

  // ── quadro de uma conta ────────────────────────────────────
  // saldos: [{data, sistema, banco}] (fim do dia), banco: itens do extrato. hoje: AAAA-MM-DD.
  // sistema (opcional): lançamentos da conta. Depois do último extrato, se o sistema só lançou
  // rendimento ou imposto da poupança até o fim do mês, o saldo do fim do mês é que vale.
  function quadroConta(saldos, banco, hoje, sistema) {
    var ultimo = banco.reduce(function (m, b) { return b.data > m ? b.data : m; }, '');
    var ontem = maisDias(hoje, -1);
    var ordenados = saldos.slice().sort(function (a, b) { return a.data < b.data ? -1 : 1; });
    var validos = ordenados.filter(function (s) { return ultimo && s.data <= ultimo; });
    var dif = validos.filter(function (s) { return s.sistema !== s.banco; });
    var fim = validos[validos.length - 1];
    if (ultimo && sistema) {
      var fimMes = maisDias(maisDias(ultimo.slice(0, 8) + '28', 4).slice(0, 8) + '01', -1);
      var depois = sistema.filter(function (s) { return s.data > ultimo && s.data <= fimMes; });
      var soRendimento = depois.length && depois.every(function (s) { return s.origem === '3' || RX_REND_SISTEMA.test(s.descricao || ''); });
      if (soRendimento) {
        var ateFim = ordenados.filter(function (s) { return s.data > ultimo && s.data <= fimMes; });
        if (ateFim.length) fim = ateFim[ateFim.length - 1];
      }
    }
    return {
      movimento_baixo: banco.length < 15, // conta de pouco movimento: o último item pode ser antigo sem faltar extrato
      ultimo_extrato: ultimo || null,
      dias_sem_extrato: ultimo ? diasUteisEntre(ultimo, ontem) : null,
      dias_saldo_diferente: dif.length,
      diferenca_saldo: fim ? fim.sistema - fim.banco : null,
      saldo_sistema: fim ? fim.sistema : null,
      saldo_banco: fim ? fim.banco : null,
      data_saldo: fim ? fim.data : null,
    };
  }

  // Bloqueio de lançamentos: o mês anterior tem que estar bloqueado depois de conciliado.
  function bloqueio(dtBloqueio, hoje) {
    var bloq = dataISO(dtBloqueio);
    var refFim = maisDias(hoje.slice(0, 8) + '01', -1); // último dia do mês anterior
    if (bloq && bloq >= refFim) return { bloqueado_ate: bloq, sem_bloqueio: false, meses_abertos: 0 };
    var meses = null;
    if (bloq) {
      var a = +bloq.slice(0, 4) * 12 + +bloq.slice(5, 7);
      var b = +refFim.slice(0, 4) * 12 + +refFim.slice(5, 7);
      var fimDoMes = maisDias(bloq, 1).slice(8, 10) === '01';
      meses = Math.max(1, b - a + (fimDoMes ? 0 : 1)); // meses do bloqueio até o mês anterior ainda abertos
    }
    return { bloqueado_ate: bloq || null, sem_bloqueio: true, meses_abertos: bloq ? meses : null, mes_referencia: refFim.slice(0, 7) };
  }

  // ── regras automáticas sugeridas pelo histórico ────────────
  var CATEGORIAS = [
    { rx: /CESAN/, nome: 'Água (CESAN)' },
    { rx: /\bEDP\b|ESCELSA/, nome: 'Energia (EDP)' },
    { rx: /PJ ?BANK|REPASSE/, nome: 'Repasse PJBank' },
    { rx: /I ?R ?R ?F|IMPOSTO DE RENDA/, nome: 'Imposto de renda sobre rendimento' },
    { rx: /JUROS|CORRECAO MONET|RENDIMENTO|REMUNERAC|RENDE F/, nome: 'Rendimento de aplicação ou poupança' },
    { rx: /TARIFA|TAR |CESTA|PACOTE|MENSALIDADE|MANUT ?CONTA/, nome: 'Tarifa bancária' },
    { rx: /(TRANSF|TED|DEB ?TRANS|CRED.*TRANSF).*(POUP|FUNDO|RESERVA|APLIC|MSM TIT|MESMA TIT|CC)|APLICACAO|RESGATE/, nome: 'Transferência entre contas do condomínio (fundo, poupança, aplicação)' },
    { rx: /LIQUIDACAO COBRANCA|CRED.*COBRANCA|LIQ.*BOLETO/, nome: 'Recebimento de boletos' },
  ];
  function categoria(desc) { var n = normDesc(desc); for (var i = 0; i < CATEGORIAS.length; i++) if (CATEGORIAS[i].rx.test(n)) return CATEGORIAS[i].nome; return ''; }
  var GENERICO = /^(PIX (EMITIDO|RECEBIDO|ENVIADO)|TRANSF ?REALIZADA|TRANSF ?RECEBIDA|DEB ?TIT ?COMPE|DEB PAGAMENTO DE BOLETO|PAGAMENTO DE BOLETO|DEBITO PAGAMENTO SALARIO|TED|DOC|CREDITO PIX|PIX)/;

  // historico: [{descricao, valor, data, desconsiderado, situacao: 'com_lancamento'|'sem_lancamento'|'desconsiderado', descricao_sistema?}]
  function sugerirRegras(historico, op) {
    op = op || {};
    var minVezes = op.minVezes || 3;
    var g = new Map();
    historico.forEach(function (h) {
      var n = normDesc(h.descricao);
      if (!n) return;
      var k = n + '|' + sinal(h.valor);
      if (!g.has(k)) g.set(k, { padrao: n, exemplo: h.descricao, sinal: sinal(h.valor), itens: [] });
      g.get(k).itens.push(h);
    });
    var out = [];
    g.forEach(function (x) {
      var l = x.itens;
      if (l.length < minVezes) return;
      var meses = new Set(l.map(function (h) { return h.data.slice(0, 7); }));
      if (meses.size < 2) return;
      var cont = { com_lancamento: 0, sem_lancamento: 0, desconsiderado: 0 };
      var desc = new Map();
      l.forEach(function (h) { cont[h.situacao] = (cont[h.situacao] || 0) + 1; if (h.descricao_sistema) { var d = String(h.descricao_sistema).replace(/\s*\(\d+\)\s*$/, '').trim(); desc.set(d, (desc.get(d) || 0) + 1); } });
      var top = null; desc.forEach(function (n, d) { if (!top || n > top.n) top = { d: d, n: n }; });
      var cat = categoria(x.exemplo);
      var valores = l.map(function (h) { return Math.abs(h.valor); }).sort(function (a, b) { return a - b; });
      var fixo = valores[0] === valores[valores.length - 1];
      var total = l.length;
      var sugestao = '', acao = '';
      if (cont.desconsiderado / total >= 0.6) { acao = 'desconsiderar'; sugestao = 'Desconsiderar automaticamente na conciliação (hoje já é desconsiderado em ' + cont.desconsiderado + ' de ' + total + ').'; }
      else if (top && top.n / total >= 0.6 && !GENERICO.test(x.padrao)) { acao = 'lancar'; sugestao = 'Lançar automaticamente como "' + top.d + '"' + (cat ? ' (' + cat + ')' : '') + ': foi assim em ' + top.n + ' de ' + total + '.'; }
      else if (top && top.n / total >= 0.6 && cat) { acao = 'lancar'; sugestao = 'Lançar automaticamente como "' + top.d + '" (' + cat + ').'; }
      else if (cat && cont.sem_lancamento / total >= 0.5) { acao = 'criar'; sugestao = 'Criar regra para lançar como ' + cat + ': ficou sem lançamento em ' + cont.sem_lancamento + ' de ' + total + '.'; }
      else if (cat === 'Recebimento de boletos' || !cat) return;
      else { acao = 'conferir'; sugestao = 'Item recorrente de ' + cat + ': conferir se já tem regra.'; }
      out.push({
        padrao: x.padrao, exemplo: String(x.exemplo).slice(0, 80), tipo: x.sinal < 0 ? 'saida' : 'entrada', categoria: cat,
        vezes: total, meses: meses.size, valor_min: valores[0], valor_max: valores[valores.length - 1], valor_tipico: valores[Math.floor(valores.length / 2)], valor_fixo: fixo,
        situacao: cont, lancamento_mais_comum: top ? top.d : '', acao: acao, sugestao: sugestao,
      });
    });
    var peso = { desconsiderar: 1, lancar: 2, criar: 3, conferir: 0 };
    out.sort(function (a, b) { return (peso[b.acao] - peso[a.acao]) || b.vezes - a.vezes; });
    return out.slice(0, op.max || 40);
  }

  // ── arquivo OFX ────────────────────────────────────────────
  var MAX_OFX_ITENS = 5000;
  function lerOfx(texto) {
    var t = String(texto || '');
    if (!/<OFX>/i.test(t) || !/<STMTTRN>/i.test(t) && !/<BANKTRANLIST>/i.test(t)) { var e = new Error('arquivo_invalido'); e.detalhe = 'O arquivo não parece um extrato OFX.'; throw e; }
    var tag = function (bloco, nome) { var m = bloco.match(new RegExp('<' + nome + '>\\s*([^<\\r\\n]*)', 'i')); return m ? m[1].trim() : ''; };
    var blocos = t.split(/<STMTTRN>/i).slice(1).map(function (b) { return b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]; });
    if (blocos.length > MAX_OFX_ITENS) { var e2 = new Error('arquivo_grande'); e2.detalhe = 'O arquivo tem mais de ' + MAX_OFX_ITENS + ' itens.'; throw e2; }
    var itens = [];
    blocos.forEach(function (b) {
      var data = dataISO(tag(b, 'DTPOSTED'));
      if (!data) return;
      itens.push({ data: data, valor: centavos(tag(b, 'TRNAMT')), fitid: tag(b, 'FITID').slice(0, 60), descricao: (tag(b, 'MEMO') || tag(b, 'NAME')).slice(0, 120), tipo: tag(b, 'TRNTYPE').slice(0, 20), numero: (tag(b, 'CHECKNUM') || tag(b, 'REFNUM')).slice(0, 30) });
    });
    var datas = itens.map(function (x) { return x.data; }).sort();
    return {
      banco: tag(t, 'BANKID'), agencia: tag(t, 'BRANCHID'), conta: tag(t, 'ACCTID'),
      inicio: dataISO(tag(t, 'DTSTART')) || datas[0] || null, fim: dataISO(tag(t, 'DTEND')) || datas[datas.length - 1] || null,
      saldo_final: tag(t, 'BALAMT') ? centavos(tag(t, 'BALAMT')) : null,
      itens: itens,
    };
  }

  // Compara o OFX com o que já está importado no Superlógica e com os lançamentos da conta.
  // importados: itens do extrato no Superlógica; sistema: lançamentos da conta.
  function compararOfx(ofx, importados, sistema) {
    var datas = ofx.itens.map(function (x) { return x.data; }).sort();
    var ini = datas[0], fim = datas[datas.length - 1];
    if (!ini) return { inicio: null, fim: null, total: 0, ja_importados: [], novos_com_lancamento: [], novos_sem_lancamento: [], so_no_superlogica: [], repetidos_no_arquivo: [] };
    var noPeriodo = function (x) { return x.data >= ini && x.data <= fim; };
    var imp = importados.filter(noPeriodo).map(function (x) { return Object.assign({ _usado: false }, x); });
    var vistos = new Map(), repetidos = [];
    ofx.itens.forEach(function (x) { if (!x.fitid) return; if (vistos.has(x.fitid)) repetidos.push(x); else vistos.set(x.fitid, x); });
    var ja = [], novos = [];
    ofx.itens.forEach(function (x) {
      var m = (x.fitid && imp.find(function (i) { return !i._usado && i.fitid && i.fitid === x.fitid; }))
        || imp.find(function (i) { return !i._usado && i.data === x.data && i.valor === x.valor; });
      if (m) { m._usado = true; ja.push(x); } else novos.push(x);
    });
    var soSL = imp.filter(function (i) { return !i._usado; }).map(function (i) { var o = Object.assign({}, i); delete o._usado; return o; });
    // Lançamentos ainda livres: tira os que já casam com o extrato importado.
    var sisPeriodo = sistema.filter(function (x) { return x.data >= maisDias(ini, -5) && x.data <= maisDias(fim, 5); });
    var base = casar(sisPeriodo, importados.filter(noPeriodo), {});
    var r = casar(base.soSistema, novos.map(function (x) { return Object.assign({}, x, { desconsiderado: false }); }), {});
    var comLanc = [];
    r.pares.forEach(function (p) { p.banco.forEach(function (b) { comLanc.push(Object.assign({}, b, { tipo_par: p.tipo, lancamento: p.sistema.map(function (s) { return s.descricao; }).join('; ').slice(0, 160) })); }); });
    return {
      inicio: ini, fim: fim, total: ofx.itens.length,
      ja_importados: ja, novos_com_lancamento: comLanc, novos_sem_lancamento: r.soBanco,
      so_no_superlogica: soSL, repetidos_no_arquivo: repetidos,
    };
  }

  return {
    centavos: centavos, dataISO: dataISO, dias: dias, maisDias: maisDias, diaUtil: diaUtil, diasUteisEntre: diasUteisEntre,
    normDesc: normDesc, subconjunto: subconjunto, casar: casar, quadroConta: quadroConta, bloqueio: bloqueio,
    categoria: categoria, sugerirRegras: sugerirRegras, lerOfx: lerOfx, compararOfx: compararOfx,
  };
});
