'use strict';
// T20 Leitura de medidores em lote. O leiturista manda várias fotos de um condomínio; cada foto
// passa pela rota interna de medidor (servico/processar.js) e volta com leitura, unidade e bloco.
// Aqui ficam:
//  1. a lista de unidades com a última leitura (consumo/index do mês escolhido);
//  2. o casamento da foto com a unidade e as suspeitas (conferência);
//  3. o lançamento (consumo/put), com a foto guardada no Superlógica (arquivos, tipo 11
//     "medição consumo") quando ele aceitar, e a prova de que gravou (nova leitura do consumo/index).
// Formato do consumo/index conferido em 21/10/2026 (condomínio 2 e 167): por unidade,
// leituras.mes_atual e leituras.mes_anterior (nm_ano_rsp, nm_mes_rsp, vl_valor_rsp),
// leituras.consumo (consumo_atual, media, meses, variacao; status -1 = sem histórico) e
// leituras.pre_lancamento (fotos do aplicativo de leitura).
// Tipos de leitura do Superlógica (catálogo da API): 1 gás, 2 água, 3 energia, 4 água mineral.

const https = require('https');
const crypto = require('crypto');

const TIPOS = { 1: 'Gás', 2: 'Água' };
const SALTO_VEZES_MEDIA = 3;      // consumo acima de 3 vezes a média = suspeita
const MAX_FOTO_BYTES = 15 * 1024 * 1024; // limite do Superlógica para arquivos

const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const doisDig = (n) => String(n).padStart(2, '0');

// Número do Superlógica ("1857.8000") ou digitado ("1857,8"). Vazio ou inválido: null.
function num(v) {
  const s = limpar(v);
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return isFinite(n) ? n : null;
}

// Leitura digitada ou lida da foto: só dígitos com uma vírgula ou um ponto decimal.
function lerValor(v) {
  const s = limpar(v).replace(/\s/g, '');
  if (!/^[0-9]{1,12}([.,][0-9]{1,4})?$/.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return isFinite(n) && n >= 0 ? n : null;
}

// Mês de referência "AAAA-MM" (padrão: mês atual em Brasília). posicaoEm: último dia do mês,
// ou hoje se for o mês corrente (o Superlógica devolve mes_atual = esse mês).
function mesRef(mes, hoje) {
  const h = hoje || new Date(Date.now() - 3 * 3600 * 1000);
  let ano = h.getUTCFullYear(), m = h.getUTCMonth() + 1;
  if (mes != null && mes !== '') {
    const x = String(mes).match(/^(\d{4})-(\d{2})$/);
    if (!x) return null;
    ano = +x[1]; m = +x[2];
    if (m < 1 || m > 12) return null;
    const alvo = ano * 12 + m, atual = h.getUTCFullYear() * 12 + h.getUTCMonth() + 1;
    if (alvo > atual || alvo < atual - 2) return null; // só o mês atual e os dois anteriores
  }
  const corrente = ano === h.getUTCFullYear() && m === h.getUTCMonth() + 1;
  const ultimo = new Date(Date.UTC(ano, m, 0)).getUTCDate();
  const dia = corrente ? h.getUTCDate() : ultimo;
  return { ano, mes: m, ultimoDia: ultimo, corrente, posicaoEm: doisDig(m) + '/' + doisDig(dia) + '/' + ano, rotulo: doisDig(m) + '/' + ano };
}

// ---------- Casamento da foto com a unidade ----------
const PALAVRAS_UNIDADE = /\b(apartamento|apto|apt|ap|casa|sala|loja|lote|unidade|unid|un|numero|n[oº°])\b\.?/g;
const PALAVRAS_BLOCO = /\b(bloco|bl|torre|tr|quadra|qd|edificio|ed)\b\.?/g;
function tirarZeros(s) { return s.replace(/^0+(?=[0-9a-z])/, ''); }
function chaveUnidade(s) {
  return tirarZeros(semAcento(s).toLowerCase().replace(/\b(apto|apt|ap|casa|sala|loja|lote)(?=[0-9])/g, ' ')
    .replace(PALAVRAS_UNIDADE, ' ').replace(/[^a-z0-9]/g, ''));
}
function chaveBloco(s) {
  return tirarZeros(semAcento(s).toLowerCase().replace(/\b(bloco|bl|torre|qd)(?=[0-9])/g, ' ')
    .replace(PALAVRAS_BLOCO, ' ').replace(/[^a-z0-9]/g, ''));
}

// Texto da unidade pode trazer o bloco junto ("101 bloco A", "Bl. B apto 302").
function separarBloco(unidadeTxt, blocoTxt) {
  let u = limpar(unidadeTxt), b = limpar(blocoTxt);
  const m = semAcento(u).match(/\b(bloco|bl|torre|tr|quadra|qd)\b\.?\s*([a-z0-9]{1,4})\b/i);
  if (m) {
    if (!b) b = m[2];
    u = semAcento(u).replace(m[0], ' ');
  }
  return { u, b };
}

// Devolve { id_unidade, motivo } (motivo: nao_encontrada ou ambigua quando não casou).
function casarUnidade(lista, unidadeTxt, blocoTxt) {
  const { u, b } = separarBloco(unidadeTxt, blocoTxt);
  const ku = chaveUnidade(u), kb = chaveBloco(b);
  if (!ku) return { id_unidade: null, motivo: 'nao_encontrada' };
  const comBloco = (arr) => (kb ? arr.filter((x) => chaveBloco(x.bloco) === kb) : arr);
  const decidir = (arr) => {
    if (arr.length === 1) return { id_unidade: arr[0].id_unidade, motivo: null };
    if (arr.length > 1) return { id_unidade: null, motivo: 'ambigua' };
    return null;
  };
  // 1) unidade igual (e bloco igual, se a foto disse o bloco)
  const iguais = lista.filter((x) => chaveUnidade(x.unidade) === ku);
  let r = decidir(comBloco(iguais));
  if (r) return r;
  // 2) unidade e bloco juntos no cadastro ("101A" sem bloco) ou separados na foto
  if (kb) {
    r = decidir(lista.filter((x) => chaveUnidade(x.unidade) === ku + kb || chaveUnidade(x.unidade) === kb + ku));
    if (r) return r;
  }
  // 3) foto com bloco grudado ("101A", "A101") e cadastro separado
  const g = ku.match(/^([0-9]+)([a-z]{1,2})$/) || ku.match(/^([a-z]{1,2})([0-9]+)$/);
  if (g && !kb) {
    const num1 = /^[0-9]/.test(g[1]) ? g[1] : g[2];
    const let1 = /^[0-9]/.test(g[1]) ? g[2] : g[1];
    r = decidir(lista.filter((x) => chaveUnidade(x.unidade) === tirarZeros(num1) && chaveBloco(x.bloco) === let1));
    if (r) return r;
  }
  // 4) unidade e bloco escritos juntos na foto ("999 TESTE HUB", "BLOCO A 101" já separado acima)
  if (!kb) {
    const junto = chaveUnidade(unidadeTxt);
    r = decidir(lista.filter((x) => x.bloco && (junto === chaveUnidade(x.unidade + ' ' + x.bloco) || junto === chaveUnidade(x.bloco + ' ' + x.unidade))));
    if (r) return r;
  }
  return { id_unidade: null, motivo: iguais.length > 1 ? 'ambigua' : 'nao_encontrada' };
}

// ---------- Unidades com a última leitura ----------
function doMes(l, ref) {
  return l && +l.nm_ano_rsp === ref.ano && +l.nm_mes_rsp === ref.mes;
}
// Converte o consumo/index em { id_unidade, unidade, bloco, anterior, atual, media, meses }.
// anterior: leitura do mês anterior ao de referência; atual: leitura já lançada no mês (se houver).
function montarUnidades(j, ref) {
  const out = [];
  (Array.isArray(j) ? j : []).forEach((u) => {
    if (!u || !/^\d+$/.test(String(u.id_unidade_uni || ''))) return;
    const lt = u.leituras || {};
    const ant = lt.mes_anterior || {};
    const anteriorRef = ref.mes === 1 ? { ano: ref.ano - 1, mes: 12 } : { ano: ref.ano, mes: ref.mes - 1 };
    const c = lt.consumo || {};
    const semHist = String(c.status) === '-1';
    out.push({
      id_unidade: Number(u.id_unidade_uni),
      unidade: limpar(u.st_unidade_uni),
      bloco: limpar(u.st_bloco_uni),
      anterior: doMes(ant, anteriorRef) ? num(ant.vl_valor_rsp) : null,
      atual: doMes(lt.mes_atual, ref) ? num(lt.mes_atual.vl_valor_rsp) : null,
      media: semHist ? null : num(c.media),
      meses: semHist ? 0 : (parseInt(c.meses, 10) || 0),
    });
  });
  return out.sort((a, b) => (a.bloco + ' ' + a.unidade).localeCompare(b.bloco + ' ' + b.unidade, 'pt-BR', { numeric: true }));
}

async function unidadesConsumo(cliente, id, tipo, ref) {
  let j;
  try { j = await cliente.get('consumo/index', { tipoLeitura: tipo, idCondominio: id, posicaoEm: ref.posicaoEm }); }
  catch (e) {
    // 4xx: o condomínio não usa esse tipo de leitura.
    if (e && e.status >= 400 && e.status < 500) { const x = new Error('tipo_sem_leitura'); x.semLeitura = true; throw x; }
    throw e;
  }
  if (!Array.isArray(j)) throw new Error('resposta_inesperada');
  if (j[0] && j[0].status != null && !j[0].id_unidade_uni && String(j[0].status) !== '200') {
    const x = new Error('tipo_sem_leitura'); x.semLeitura = true; throw x;
  }
  return montarUnidades(j, ref);
}

// ---------- Suspeitas ----------
const TEXTOS = {
  ilegivel: 'Foto ilegível: confira a leitura na foto.',
  varios_medidores: 'Mais de um medidor na foto: confira qual é o da unidade.',
  unidade_nao_encontrada: 'Unidade não encontrada no condomínio.',
  unidade_ambigua: 'Mais de uma unidade com esse número: escolha o bloco.',
  unidade_repetida: 'Outra foto deste lote está na mesma unidade.',
  menor_que_anterior: 'Leitura menor que a anterior.',
  salto_alto: 'Consumo acima de 3 vezes a média da unidade.',
  ja_lancada: 'Já existe leitura lançada neste mês para esta unidade.',
};
function suspeita(codigo, extra) { return { codigo, texto: TEXTOS[codigo] + (extra ? ' ' + extra : '') }; }
const fmt = (n) => String(Math.round(n * 1000) / 1000).replace('.', ',');

// itens: [{ chave, unidade, bloco, id_unidade?, leitura, varios_medidores? }]. id_unidade, quando
// vem (o leiturista escolheu na tela), vale mais que o texto lido da foto.
function conferirLote(lista, itens) {
  const porId = new Map(lista.map((u) => [u.id_unidade, u]));
  const saida = (Array.isArray(itens) ? itens : []).slice(0, 500).map((it) => {
    const o = { chave: limpar(it && it.chave).slice(0, 80), suspeitas: [], avisos: [] };
    const valor = lerValor(it && it.leitura);
    o.leitura = valor;
    let u = null;
    const idEscolhido = Number(it && it.id_unidade);
    if (idEscolhido && porId.has(idEscolhido)) u = porId.get(idEscolhido);
    else {
      const c = casarUnidade(lista, it && it.unidade, it && it.bloco);
      if (c.id_unidade) u = porId.get(c.id_unidade);
      else o.suspeitas.push(suspeita(c.motivo === 'ambigua' ? 'unidade_ambigua' : 'unidade_nao_encontrada'));
    }
    if (valor == null) o.suspeitas.push(suspeita('ilegivel'));
    if (it && it.varios_medidores) o.suspeitas.push(suspeita('varios_medidores'));
    if (u) {
      o.id_unidade = u.id_unidade;
      o.rotulo = u.unidade + (u.bloco ? ' ' + u.bloco : '');
      o.anterior = u.anterior;
      o.media = u.media;
      o.atual_lancada = u.atual;
      if (u.atual != null) o.suspeitas.push(suspeita('ja_lancada', '(' + fmt(u.atual) + ')'));
      if (valor != null && u.anterior != null) {
        o.consumo = Math.round((valor - u.anterior) * 10000) / 10000;
        if (valor < u.anterior) o.suspeitas.push(suspeita('menor_que_anterior', '(anterior ' + fmt(u.anterior) + ')'));
        else if (u.media != null && u.media > 0 && o.consumo > SALTO_VEZES_MEDIA * u.media) {
          o.suspeitas.push(suspeita('salto_alto', '(consumo ' + fmt(o.consumo) + ', média ' + fmt(u.media) + ')'));
        }
      }
      if (u.anterior == null) o.avisos.push('Sem leitura do mês anterior para comparar.');
      else if (u.media == null) o.avisos.push('Sem média de consumo para comparar.');
    }
    return o;
  });
  // Duas fotos na mesma unidade
  const conta = new Map();
  saida.forEach((o) => { if (o.id_unidade) conta.set(o.id_unidade, (conta.get(o.id_unidade) || 0) + 1); });
  saida.forEach((o) => { if (o.id_unidade && conta.get(o.id_unidade) > 1) o.suspeitas.push(suspeita('unidade_repetida')); });
  return saida;
}

// ---------- Lançamento ----------
function tipoImagem(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

// Pedido ao Superlógica com as chaves do servidor. Devolve { status, json }.
function pedir({ base, appToken, accessToken }, metodo, caminho, query, corpo, tipoCorpo) {
  return new Promise((resolve) => {
    const url = new URL(base + '/v2/condor/' + caminho);
    Object.entries(query || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
    const dados = corpo || Buffer.alloc(0);
    const r = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: metodo,
      headers: { app_token: appToken, access_token: accessToken, accept: 'application/json',
        'content-type': tipoCorpo || 'application/x-www-form-urlencoded', 'content-length': dados.length },
    }, (resp) => {
      const partes = [];
      resp.on('data', (c) => partes.push(c));
      resp.on('error', () => resolve({ status: 0, json: null }));
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(partes).toString('utf8').replace(/^﻿/, '')); } catch (e) { json = null; }
        resolve({ status: resp.statusCode, json });
      });
    });
    r.setTimeout(60000, () => { r.destroy(); resolve({ status: 504, json: null }); });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.end(dados);
  });
}
// O Superlógica pode responder erro com HTTP 200 ou 206: decide pelo status do corpo.
function corpoOk(r) {
  const item = Array.isArray(r.json) ? r.json[0] : r.json;
  const ok = r.status >= 200 && r.status < 300 && !!item && typeof item === 'object' && String(item.status) === '200';
  return { ok, item, msg: item && item.msg ? limpar(item.msg).slice(0, 200) : (r.status ? 'HTTP ' + r.status : 'sem resposta') };
}

// Guarda a foto como arquivo de medição de consumo (tipo 11) da unidade. Devolve o id do arquivo ou null.
async function guardarFoto(cred, idUnidade, buf) {
  const t = tipoImagem(buf);
  if (!t || buf.length > MAX_FOTO_BYTES) return { id: null, msg: 'foto inválida' };
  const fronteira = '----hub' + crypto.randomBytes(12).toString('hex');
  const campo = (n, v) => Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="' + n + '"\r\n\r\n' + v + '\r\n', 'utf8');
  const nome = 'leitura-' + idUnidade + '-' + Date.now() + '.' + t.ext;
  const corpo = Buffer.concat([
    campo('ID_RESPONSAVEL_ARQ', String(idUnidade)),
    campo('FL_TIPO_ARQ', '11'),
    Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="ARQUIVO"; filename="' + nome + '"\r\nContent-Type: ' + t.mime + '\r\n\r\n', 'utf8'),
    buf,
    Buffer.from('\r\n--' + fronteira + '--\r\n', 'utf8'),
  ]);
  const r = await pedir(cred, 'POST', 'arquivos/', null, corpo, 'multipart/form-data; boundary=' + fronteira);
  const c = corpoOk(r);
  const d = c.item && c.item.data && typeof c.item.data === 'object' ? c.item.data : null;
  const id = d && /^\d+$/.test(String(d.id_arquivo_arq || '')) ? String(d.id_arquivo_arq) : null;
  return { id: c.ok ? id : null, msg: c.msg };
}

// Lança a leitura de UMA unidade e confere relendo o consumo/index. u = linha de unidadesConsumo
// lida agora. Devolve { ok, incerto, msg, foto, id_arquivo, lista } (lista = unidades relidas).
async function lancarLeitura(cred, cliente, { id, tipo, ref, dia, u, valor, foto }) {
  let fotoInfo = 'sem_foto', idArquivo = null;
  if (foto) {
    const f = await guardarFoto(cred, u.id_unidade, foto);
    idArquivo = f.id;
    fotoInfo = f.id ? 'guardada' : 'recusada';
  }
  const q = {
    tipoLeitura: tipo, id_condominio_cond: id, id_unidade_uni: u.id_unidade, posicaoEm: ref.posicaoEm,
    'leituras[mes_atual][nm_ano_rsp]': ref.ano, 'leituras[mes_atual][nm_mes_rsp]': doisDig(ref.mes),
    'leituras[mes_atual][id_tipo_rec]': tipo, 'leituras[apenas_editar_medidor]': 1,
    'leituras[mes_atual][diadaleitura]': dia, novaleitura_mes_atual: String(valor),
  };
  const editar = u.atual != null;
  if (editar) {
    q['leituras[mes_anterior][vl_valor_rsp]'] = u.anterior != null ? String(u.anterior) : '';
    q['leituras[mes_atual][vl_valor_rsp]'] = String(u.atual);
  }
  if (idArquivo) q.id_arquivo_arq = idArquivo;
  const r = await pedir(cred, editar ? 'PUT' : 'POST', 'consumo/put', q, null);
  const c = corpoOk(r);
  // Prova: relê e confere que a leitura do mês ficou com o valor lançado.
  let lista = null, conferido = false;
  try {
    lista = await unidadesConsumo(cliente, id, tipo, ref);
    const nova = lista.find((x) => x.id_unidade === u.id_unidade);
    conferido = !!nova && nova.atual != null && Math.abs(nova.atual - valor) < 0.0005;
  } catch (e) { lista = null; }
  if (conferido) return { ok: true, msg: c.msg, foto: fotoInfo, id_arquivo: idArquivo, lista };
  // Sem prova: se o Superlógica disse que gravou (ou não respondeu), fica incerto; senão, falhou.
  const incerto = c.ok || r.status === 504 || r.status === 0 || lista === null;
  return { ok: false, incerto, msg: c.msg, foto: fotoInfo, id_arquivo: idArquivo, lista };
}

module.exports = {
  TIPOS, SALTO_VEZES_MEDIA, MAX_FOTO_BYTES,
  num, lerValor, mesRef, chaveUnidade, chaveBloco, casarUnidade, montarUnidades, unidadesConsumo,
  conferirLote, tipoImagem, guardarFoto, lancarLeitura,
};
