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
  const re = new RegExp('([?&])' + nome.replace(/[[\]]/g, '\\$&') + '=[^&]*', 'g');
  if (!new RegExp(re.source).test(url)) { const e = new Error('parametro_ausente_' + nome); e.codigo = 'item_inesperado'; throw e; }
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

// Campos que o código sabe mandar de volta. Item com outro campo preenchido: não grava (perderia o campo).
const CAMPOS_ITEM = ['id_relatoriousuarioselecao_rlsui', 'id_relatorioselecao_rlsu', 'st_url_rlsui', 'st_titulotexto_rlsui', 'st_subtitulotexto_rlsui', 'st_texto_rlsui', 'id_modeloorigem_rlsui', 'nm_ordenacao_rlsui'];
const decodificar = (s) => { try { return decodeURIComponent(String(s || '')); } catch (e) { return String(s || ''); } };
// Confere a releitura: mesmos itens, ordem, ids e todos os campos; a URL tem de ser a esperada.
function mesmaSelecao(depois, antes, urls) {
  return depois.titulo === antes.titulo && depois.itens.length === antes.itens.length && depois.itens.every((d, i) => {
    const a = antes.itens[i];
    return CAMPOS_ITEM.every((c) => (c === 'st_url_rlsui' ? decodificar(d[c]) === decodificar(urls[i]) : String(d[c] == null ? '' : d[c]) === String(a[c] == null ? '' : a[c])));
  });
}
async function gravarEConferir(cred, cliente, sel, urls, postarFn, idUsuario, idSelecao) {
  let r;
  try { r = await (postarFn || postar)(cred, 'relatorioselecaousuario/post', montarCorpo(sel, urls)); } catch (e) { r = { http: 0 }; }
  const item = r && (Array.isArray(r.json) ? r.json[0] : r.json);
  const aceitou = r && r.http === 200 && item && String(item.status || '200') === '200';
  // Mesmo sem resposta (tempo esgotado), o Superlógica pode ter gravado: relê sempre.
  let depois = null;
  try { depois = await lerSelecao(cliente, idUsuario, idSelecao); } catch (e) { depois = null; }
  return { aceitou, ok: !!depois && mesmaSelecao(depois, sel, urls) };
}

// Ajusta a seleção para a competência. Devolve { mudou, itens_alterados }. Se já está no mês, não grava.
// Guarda a seleção lida antes; se a gravação falhar ou a releitura vier diferente, regrava a original.
async function ajustarSelecaoParaMes({ cred, cliente, idUsuario, idSelecao, competencia, postarFn, log }) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(competencia || ''));
  if (!m) { const e = new Error('competencia_invalida'); e.codigo = 'competencia'; throw e; }
  const comp = { ano: Number(m[1]), mes: Number(m[2]) };
  const sel = await lerSelecao(cliente, idUsuario, idSelecao);
  if (!TITULO_PERMITIDO.test(sel.titulo)) { const e = new Error('selecao_nao_permitida'); e.codigo = 'selecao'; throw e; }
  const desconhecido = sel.itens.find((it) => Object.keys(it).some((k) => !CAMPOS_ITEM.includes(k) && it[k] != null && String(it[k]) !== ''));
  if (desconhecido) { const e = new Error('campo_desconhecido_no_item'); e.codigo = 'item_inesperado'; throw e; }
  const originais = sel.itens.map((it) => String(it.st_url_rlsui || ''));
  const urls = originais.map((u) => urlParaMes(u, comp));
  const alterados = urls.map((u, i) => (u !== originais[i] ? i : -1)).filter((i) => i >= 0);
  if (!alterados.length) return { mudou: false, itens_alterados: 0 };
  const g = await gravarEConferir(cred, cliente, sel, urls, postarFn, idUsuario, idSelecao);
  if (log) log('[escrita-superlogica] selecao_nova usuario=' + idUsuario + ' selecao=' + idSelecao + ' para=' + competencia + ' itens=' + alterados.length + ' aceitou=' + g.aceitou + ' conferida=' + g.ok);
  if (g.ok) return { mudou: true, itens_alterados: alterados.length };
  // Desfaz: regrava a seleção como estava e confere.
  const volta = await gravarEConferir(cred, cliente, sel, originais, postarFn, idUsuario, idSelecao);
  if (log) log('[escrita-superlogica] selecao_nova desfeita usuario=' + idUsuario + ' selecao=' + idSelecao + ' conferida=' + volta.ok);
  const e = new Error(volta.ok ? 'gravacao_falhou_desfeita' : 'gravacao_falhou_sem_desfazer');
  e.codigo = 'gravacao_diferente';
  throw e;
}

module.exports = { urlParaMes, trocarParam, codigoDe, lerSelecao, montarCorpo, ajustarSelecaoParaMes, mesmaSelecao, TITULO_PERMITIDO, CAMPOS_ITEM };
