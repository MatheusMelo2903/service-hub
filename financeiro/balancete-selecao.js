'use strict';
// T41 caminho C (decisão do Matheus 21/10 15h37): antes de gerar o 900A de um mês, o Hub troca o
// mês dos itens da seleção "Prestação de contas na Web NOVA teste Hub" (MINHA SELEÇÃO do usuário
// do Matheus), porque a seleção pessoal não repassa o mês da prestação para esses relatórios:
//   037F e 037E  PERIODO=selecionar, PERIODO_INICIO = mês
//   061B         MES=selecionar, MES_INICIO = mês (extrato do banco e simulação 74A)
//   061A         PERIODO=selecionar, de 1º ao último dia do mês
//   011A         primeira coluna (REALIZADO=selecionar) 11 meses antes do mês, mais 11 colunas
//   003A e 002B  posição (POSICAOEM) no último dia do mês; na seleção da Web é "Fechamento", que segue a
//                data de fechamento do condomínio e não o mês pedido (teste de agosto saiu em 30/09)
// Só mexe nesses parâmetros; o resto de cada item fica igual. Lê a seleção (GET
// relatorioselecaousuario/index com comItems=1), grava pelo mesmo caminho da tela
// (relatorioselecaousuario/post) e lê de novo para provar que só os meses mudaram.
// Nunca toca nas seleções do condomínio (relatoriosselecao), que a equipe usa.
const https = require('https');

const TITULO_PERMITIDO = /NOVA teste Hub/i;
const sl = (ano, mes, dia) => String(mes).padStart(2, '0') + '/' + String(dia).padStart(2, '0') + '/' + ano;
function mesesAntes({ ano, mes }, n) { const t = ano * 12 + (mes - 1) - n; return { ano: Math.floor(t / 12), mes: (t % 12) + 1 }; }

// Troca o valor de um parâmetro na URL do item sem mexer nos outros (nem na ordem nem na codificação).
function trocarParam(url, nome, valor) {
  const re = new RegExp('([?&])' + nome.replace(/[[\]]/g, '\\$&') + '=[^&]*');
  if (!re.test(url)) { const e = new Error('parametro_ausente_' + nome); e.codigo = 'item_inesperado'; throw e; }
  return url.replace(re, '$1' + nome + '=' + encodeURIComponent(valor));
}
const codigoDe = (url) => (/\/id\/(\d{3}[A-Z])\b/.exec(String(url || '')) || [])[1] || '';

// Devolve a URL nova do item para a competência ({ano, mes}) ou a mesma URL se o item não muda.
function urlParaMes(url, comp) {
  const cod = codigoDe(url);
  const ini = sl(comp.ano, comp.mes, 1);
  const ultimo = new Date(Date.UTC(comp.ano, comp.mes, 0)).getUTCDate();
  if (cod === '037F' || cod === '037E') return trocarParam(trocarParam(url, 'PERIODO', 'selecionar'), 'PERIODO_INICIO', ini);
  if (cod === '061B') return trocarParam(trocarParam(url, 'MES', 'selecionar'), 'MES_INICIO', ini);
  if (cod === '061A') return trocarParam(trocarParam(trocarParam(url, 'PERIODO', 'selecionar'), 'PERIODO_INICIO', ini), 'PERIODO_FIM', sl(comp.ano, comp.mes, ultimo));
  if (cod === '003A' || cod === '002B') return trocarParam(trocarParam(url, 'POSICAOEM', 'selecionar'), 'POSICAOEM_DATA', sl(comp.ano, comp.mes, ultimo));
  if (cod === '011A') {
    const p = mesesAntes(comp, 11);
    let u = trocarParam(trocarParam(url, 'REALIZADO', 'selecionar'), 'REALIZADO_INICIO', sl(p.ano, p.mes, 1));
    u = trocarParam(trocarParam(u, 'COMPARARCOMOUTROMES', 'diversosmeses'), 'COMPARARCOMOUTROMES_QDT_MESES_ACOMPARAR', '11');
    return u;
  }
  return url;
}

// Lê a seleção pessoal com os itens (GET).
async function lerSelecao(cliente, idUsuario, idSelecao) {
  const j = await cliente.get('relatorioselecaousuario/index', { ID_USUARIO_USU: idUsuario, ID_RELATORIOSELECAO_RLSU: idSelecao, comItems: 1 });
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : null);
  const s = arr && arr.find((x) => x && String(x.id_relatorioselecao_rlsu) === String(idSelecao));
  if (!s || !Array.isArray(s.items) || !s.items.length) { const e = new Error('selecao_nao_encontrada'); e.codigo = 'selecao'; throw e; }
  return { id: String(s.id_relatorioselecao_rlsu), usuario: String(s.id_usuario_usu), titulo: String(s.st_tituloselecao_rlsu || ''),
    itens: s.items.slice().sort((a, b) => Number(a.nm_ordenacao_rlsui) - Number(b.nm_ordenacao_rlsui)) };
}

// Mesmos campos que a tela manda ao salvar (RELATORIO_SELECAO[i][...]), em formulário.
function montarCorpo(sel, urls) {
  const p = new URLSearchParams();
  p.set('ID_USUARIO_USU', sel.usuario);
  p.set('ST_TITULOSELECAO_RLSU', sel.titulo);
  p.set('ID_RELATORIOSELECAO_RLSU', sel.id);
  sel.itens.forEach((it, i) => {
    const k = (c) => 'RELATORIO_SELECAO[' + i + '][' + c + ']';
    p.set(k('ITEM_EXCLUIDO'), '');
    p.set(k('ID_RELATORIO'), codigoDe(it.st_url_rlsui));
    p.set(k('NM_ORDENACAO_RLSUI'), String(it.nm_ordenacao_rlsui));
    p.set(k('ID_RELATORIOUSUARIOSELECAO_RLSUI'), String(it.id_relatoriousuarioselecao_rlsui));
    p.set(k('ST_URL_RLSUI'), urls[i]);
    p.set(k('ST_TITULOTEXTO_RLSUI'), it.st_titulotexto_rlsui || '');
    p.set(k('ST_SUBTITULOTEXTO_RLSUI'), it.st_subtitulotexto_rlsui || '');
    p.set(k('ST_TEXTO_RLSUI'), it.st_texto_rlsui || '');
    p.set(k('ID_MODELOORIGEM_RLSUI'), it.id_modeloorigem_rlsui || '');
  });
  return p.toString();
}

function postar({ base, appToken, accessToken }, caminho, corpo) {
  return new Promise((ok) => {
    const u = new URL(base + '/v2/condor/' + caminho);
    const buf = Buffer.from(corpo, 'utf8');
    const r = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
      headers: { app_token: appToken, access_token: accessToken, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'content-length': buf.length } }, (resp) => {
      const p = []; resp.on('data', (x) => { if (p.length < 50) p.push(x); });
      resp.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(p).toString('utf8')); } catch (e) { /* não JSON */ } ok({ http: resp.statusCode, json: j }); });
    });
    r.setTimeout(60000, () => { r.destroy(); ok({ http: 0 }); });
    r.on('error', () => ok({ http: 0 }));
    r.end(buf);
  });
}

// Ajusta a seleção para a competência. Devolve { mudou, itens_alterados }. Se já está no mês, não grava.
// Depois de gravar, lê de novo e confere: mesmos itens, mesma ordem, mesmos textos; só as URLs previstas mudaram.
async function ajustarSelecaoParaMes({ cred, cliente, idUsuario, idSelecao, competencia, postarFn }) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(competencia || ''));
  if (!m) { const e = new Error('competencia_invalida'); e.codigo = 'competencia'; throw e; }
  const comp = { ano: Number(m[1]), mes: Number(m[2]) };
  const sel = await lerSelecao(cliente, idUsuario, idSelecao);
  if (!TITULO_PERMITIDO.test(sel.titulo)) { const e = new Error('selecao_nao_permitida'); e.codigo = 'selecao'; throw e; }
  const urls = sel.itens.map((it) => urlParaMes(String(it.st_url_rlsui || ''), comp));
  const alterados = sel.itens.map((it, i) => (urls[i] !== String(it.st_url_rlsui || '') ? i : -1)).filter((i) => i >= 0);
  if (!alterados.length) return { mudou: false, itens_alterados: 0 };
  const r = await (postarFn || postar)(cred, 'relatorioselecaousuario/post', montarCorpo(sel, urls));
  const item = Array.isArray(r.json) ? r.json[0] : r.json;
  if (r.http !== 200 || !item || String(item.status || '200') !== '200') { const e = new Error('gravacao_recusada_http_' + r.http); e.codigo = 'gravacao'; throw e; }
  const depois = await lerSelecao(cliente, idUsuario, idSelecao);
  const igual = depois.itens.length === sel.itens.length && depois.itens.every((d, i) => {
    const a = sel.itens[i];
    return String(d.id_relatoriousuarioselecao_rlsui) === String(a.id_relatoriousuarioselecao_rlsui) && String(d.nm_ordenacao_rlsui) === String(a.nm_ordenacao_rlsui)
      && (d.st_texto_rlsui || '') === (a.st_texto_rlsui || '') && (d.st_titulotexto_rlsui || '') === (a.st_titulotexto_rlsui || '')
      && decodeURIComponent(String(d.st_url_rlsui)) === decodeURIComponent(urls[i]);
  });
  if (!igual) { const e = new Error('conferencia_da_gravacao_falhou'); e.codigo = 'gravacao_diferente'; throw e; }
  return { mudou: true, itens_alterados: alterados.length };
}

module.exports = { urlParaMes, trocarParam, codigoDe, lerSelecao, montarCorpo, ajustarSelecaoParaMes, TITULO_PERMITIDO };
