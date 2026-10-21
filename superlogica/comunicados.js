// Comunicados e multas (T10). Gravações no Superlógica feitas pelo SERVIDOR, sempre depois de
// uma confirmação explícita na tela (a rota exige o campo confirmacao). Regras de segurança:
//  1. Comunicado só para o PRÓPRIO condomínio (destinatário 1, 2 ou 3). Os destinos 4, 5 e 6 do
//     Superlógica ("de todos os condomínios") são recusados aqui, sem exceção.
//  2. O disparo de notificações (comunicados/notificarcomunicado) é GLOBAL na API: dispara os
//     comunicados pendentes de TODOS os condomínios da licença. Por isso fica travado até o Matheus
//     decidir (variável COMUNICADOS_DISPARO_LIBERADO=1); a publicação não depende dele.
//  3. Ocorrência, carta e cobrança só em unidade que pertence ao condomínio informado (conferido
//     no unidades/index antes de gravar).

const https = require('https');

const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : NaN; };
// MM/DD/AAAA de verdade (recusa 02/31, DD/MM trocado e ano fora de um ano para trás ou à frente)
function _data(v) {
  const m = String(v || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[1] - 1, +m[2]);
  if (d.getFullYear() !== +m[3] || d.getMonth() !== +m[1] - 1 || d.getDate() !== +m[2]) return null;
  const ano = new Date().getFullYear();
  if (+m[3] < ano - 1 || +m[3] > ano + 1) return null;
  return d;
}
const dataOk = (v) => !!_data(v);
const temTag = (s) => /[<>]/.test(String(s || ''));
const temPendente = (s) => /\[a confirmar[^\]]*\]/i.test(String(s || ''));

// POST/PUT form-urlencoded no Superlógica com as chaves do servidor. Devolve { status, json, texto }.
function enviar({ base, appToken, accessToken }, metodo, caminho, campos) {
  return new Promise((resolve) => {
    const corpo = new URLSearchParams();
    Object.entries(campos || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) corpo.set(k, String(v)); });
    const dados = corpo.toString();
    const url = new URL(base + '/v2/condor/' + caminho);
    const r = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: metodo,
      headers: { app_token: appToken, access_token: accessToken, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(dados), accept: 'application/json' },
    }, (resp) => {
      const partes = [];
      resp.on('data', (c) => partes.push(c));
      resp.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json = null; try { json = JSON.parse(texto); } catch (e) { json = null; }
        resolve({ status: resp.statusCode, json, texto });
      });
    });
    r.setTimeout(60000, () => { r.destroy(); resolve({ status: 504, json: null, texto: '' }); });
    r.on('error', () => resolve({ status: 0, json: null, texto: '' }));
    r.write(dados); r.end();
  });
}

// O Superlógica responde [{ status:"200", msg, data }] mesmo com HTTP 206 em erro: decide pelo corpo.
function resultado(r) {
  const item = Array.isArray(r.json) ? r.json[0] : r.json;
  const ok = r.status >= 200 && r.status < 300 && item && String(item.status) === '200';
  return { ok, msg: item && item.msg ? limpar(item.msg) : (r.status ? 'HTTP ' + r.status : 'sem resposta'), data: item && item.data ? item.data : null, bruto: item };
}

// Unidades do condomínio (para escolher a unidade da multa). Só id, unidade, bloco e proprietário.
async function listarUnidades(cliente, id) {
  const out = [];
  for (let pg = 1; pg <= 30; pg++) {
    const j = await cliente.get('unidades/index', { idCondominio: id, itensPorPagina: 50, pagina: pg });
    if (!Array.isArray(j) || !j.length) break;
    j.forEach((u) => out.push({ id_unidade: Number(u.id_unidade_uni) || null, unidade: limpar(u.st_unidade_uni), bloco: limpar(u.st_bloco_uni), proprietario: limpar(u.nome_proprietario) || limpar(u.st_sacado_uni) }));
    if (j.length < 50) break;
  }
  return out.filter((u) => u.id_unidade).sort((a, b) => (a.bloco + a.unidade).localeCompare(b.bloco + b.unidade, 'pt-BR', { numeric: true }));
}

// Contas bancárias ativas (para a cobrança da multa). Só id, descrição e se é a principal.
async function listarContas(cliente, id) {
  const j = await cliente.get('contabancos/index', { idCondominio: id, exibirContasAtivas: 1 });
  return (Array.isArray(j) ? j : []).filter((c) => !limpar(c.dt_datafechamento_cb))
    .map((c) => ({ id_conta: Number(c.id_contabanco_cb) || null, descricao: limpar(c.st_descricao_cb), principal: String(c.fl_principal_cb) === '1' }))
    .filter((c) => c.id_conta);
}

function validarComunicado(b) {
  const titulo = limpar(b.titulo).slice(0, 150);
  const texto = String(b.texto || '').trim();
  const dest = Number(b.destinatario || 1);
  const canal = Number(b.canal || 1);
  if (!titulo) return { erro: 'Informe o título.' };
  if (temTag(titulo)) return { erro: 'O título não pode ter os sinais < ou >.' };
  if (temPendente(titulo) || temPendente(texto)) return { erro: 'Ainda há [a confirmar] no texto. Preencha antes de publicar.' };
  if (!texto || texto.length > 20000) return { erro: 'Texto vazio ou longo demais.' };
  if (![1, 2, 3].includes(dest)) return { erro: 'Destinatário inválido: só unidades, responsáveis ou todos DESTE condomínio.' };
  if (![1, 2, 3, 4, 5].includes(canal)) return { erro: 'Canal inválido.' };
  return { titulo, texto, dest, canal, notificar: b.notificar === true };
}

async function publicarComunicado(cred, id, c) {
  const r = await enviar(cred, 'POST', 'comunicados/', {
    ST_TITULO_COM: c.titulo, ST_TEXTO_COM: c.texto, ID_CONDOMINIO_COND: id,
    FL_DESTINATARIO_COM: c.dest, FL_CANALCOMUNICACAO_COM: c.canal, FL_NOTIFICAR_COM: c.notificar ? 1 : 0,
  });
  return resultado(r);
}

function validarMulta(b) {
  const idUni = Number(b.id_unidade);
  const tipo = Number(b.tipo || 3);
  const notificar = Number(b.notificar || 1);
  const data = String(b.data || '');
  const titulo = limpar(b.titulo).slice(0, 150);
  const texto = String(b.texto || '').trim();
  if (!(idUni > 0)) return { erro: 'Escolha a unidade.' };
  if (![1, 3].includes(tipo)) return { erro: 'Tipo de ocorrência inválido.' };
  if (![1, 2, 3].includes(notificar)) return { erro: 'Opção de notificação inválida.' };
  if (!dataOk(data)) return { erro: 'Data inválida.' };
  if (!titulo || !texto || texto.length > 20000) return { erro: 'Informe título e texto.' };
  if (temTag(titulo)) return { erro: 'O título não pode ter os sinais < ou >.' };
  if (temPendente(titulo) || temPendente(texto)) return { erro: 'Ainda há [a confirmar] no texto. Preencha antes de registrar.' };
  const m = { idUni, tipo, notificar, data, titulo, texto, email: b.email === true ? 1 : 0, carta: b.carta === true, cobranca: null };
  if (b.cobranca) {
    const v = num(b.cobranca.valor);
    const conta = limpar(b.cobranca.conta_categoria);
    const idConta = Number(b.cobranca.id_contabanco);
    if (!(v > 0 && v <= 1e6)) return { erro: 'Valor da multa inválido.' };
    const venc = _data(b.cobranca.vencimento);
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    if (!venc || venc < hoje) return { erro: 'Vencimento da cobrança inválido ou no passado.' };
    if (!/^[0-9]+(\.[0-9]+)*$/.test(conta)) return { erro: 'Conta categoria inválida (ex.: 1.9).' };
    if (!(idConta > 0)) return { erro: 'Escolha a conta bancária.' };
    m.cobranca = { valor: Math.round(v * 100) / 100, vencimento: b.cobranca.vencimento, conta, idConta, complemento: limpar(b.cobranca.complemento).replace(/[<>]/g, '').slice(0, 100) };
  }
  return m;
}

// Ocorrência na unidade, carta (opcional) e cobrança da multa (opcional). Cada passo só roda se o
// anterior deu certo; o retorno diz o que foi feito e o que não foi.
async function registrarMulta(cred, cliente, id, m) {
  // a unidade precisa ser deste condomínio
  const unidades = await listarUnidades(cliente, id);
  if (!unidades.some((u) => u.id_unidade === m.idUni)) return { ok: false, etapa: 'unidade', msg: 'A unidade não pertence a este condomínio.' };
  if (m.cobranca) {
    const contas = await listarContas(cliente, id);
    if (!contas.some((c) => c.id_conta === m.cobranca.idConta)) return { ok: false, etapa: 'conta', msg: 'A conta bancária não pertence a este condomínio.' };
  }
  const out = { ok: false, parcial: false, incerto: false, ocorrencia: null, carta: null, cobranca: null };
  const ocR = await enviar(cred, 'POST', 'ocorrencias', {
    ID_CONDOMINIO_COND: id, ID_UNIDADE_UNI: m.idUni, DT_OCORRENCIA_UOC: m.data, FL_TIPO_UOC: m.tipo,
    FL_NOTIFICAR_UOC: m.notificar, ST_TITULO_UOC: m.titulo, TX_TEXTO_UOC: m.texto, TX_OBS_UOC: m.titulo, NOTIFICAR_EMAIL: m.email,
  });
  // sem resposta (timeout ou queda): a ocorrência PODE ter sido criada. Não segue e avisa.
  if (!ocR.status || ocR.status === 504) return Object.assign(out, { incerto: true, etapa: 'ocorrencia', msg: 'Resultado incerto: o Superlógica não respondeu. Confira no Superlógica antes de tentar de novo.' });
  const oc = resultado(ocR);
  out.ocorrencia = { ok: oc.ok, msg: oc.msg, id: oc.data && (oc.data.id_ocorrencia_uoc || oc.data.ID_OCORRENCIA_UOC) || null };
  if (!oc.ok) return Object.assign(out, { etapa: 'ocorrencia', msg: oc.msg });
  if (m.carta && !out.ocorrencia.id) out.carta = { ok: false, msg: 'a ocorrência voltou sem número; gere a carta pelo Superlógica' };
  if (m.carta && out.ocorrencia.id) {
    const ca = await enviar(cred, 'POST', 'ocorrencias/imprimircarta', {
      ID_IMPRESSORA_IMPR: 'pdf', ID_OCORRENCIA_UOC: out.ocorrencia.id, ID_UNIDADE_UNI: m.idUni,
      FL_NOTIFICAR_UOC: m.notificar, ST_TITULO_UOC: m.titulo, TX_TEXTO_UOC: m.texto,
    });
    // A API devolve [{ id_impressao }]: a carta vai para a fila de impressões do Superlógica.
    const item = Array.isArray(ca.json) ? ca.json[0] : ca.json;
    const idImp = item && item.id_impressao ? String(item.id_impressao) : null;
    out.carta = idImp ? { ok: true, msg: 'carta gerada nas impressões do Superlógica', id_impressao: idImp } : { ok: false, msg: resultado(ca).msg };
  }
  if (m.cobranca) {
    const cb = resultado(await enviar(cred, 'POST', 'cobranca/', {
      ID_CONDOMINIO_COND: id, ID_UNIDADE_UNI: m.idUni, DT_VENCIMENTO_RECB: m.cobranca.vencimento,
      'RECEITA_APROPRIACAO[0][ST_CONTA_CONT]': m.cobranca.conta, 'RECEITA_APROPRIACAO[0][VL_VALOR_REC]': m.cobranca.valor.toFixed(2),
      'RECEITA_APROPRIACAO[0][ST_COMPLEMENTO_REC]': m.cobranca.complemento || m.titulo.slice(0, 100),
      VALOR_TOTAL: m.cobranca.valor.toFixed(2), ID_CONTABANCO_CB: m.cobranca.idConta,
      DT_COMPETENCIA: m.cobranca.vencimento, // a API exige; usa o mês do vencimento
    }));
    out.cobranca = { ok: cb.ok, msg: cb.msg, id: cb.data && (cb.data.id_recebimento_recb || cb.data.ID_RECEBIMENTO_RECB) || null };
  }
  // ok só quando TODOS os passos pedidos deram certo; senão é parcial (a ocorrência já existe).
  out.parcial = (out.carta && !out.carta.ok) || (out.cobranca && !out.cobranca.ok) || false;
  out.ok = !out.parcial;
  return out;
}

module.exports = { enviar, resultado, listarUnidades, listarContas, validarComunicado, publicarComunicado, validarMulta, registrarMulta };
