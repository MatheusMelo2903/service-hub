'use strict';
// Contas a pagar: o que o Hub grava sozinho no Superlógica para pagar as contas dos condomínios.
//  1. Lançamento completo da entrada de documentos: código de barras conferido pelos dígitos,
//     chave Pix ou Pix copia e cola na despesa, parcelas, rateio por categoria (APROPRIACAO),
//     PDF anexado com etiqueta e, quando pedido, a parcela marcada para a remessa de pagamento.
//  2. Fornecedor novo (e os dados de pagamento dele) cadastrado pela API, sempre conferido antes.
//  3. Baixa (despesas/liquidar) com a data e o valor que o banco mostrou, juros e multa quando o
//     valor pago foi maior, e o comprovante do banco anexado (gerado do retorno ou do extrato,
//     nunca print de tela).
// Nada aqui envia arquivo, remessa ou pagamento ao banco: remessa e assinatura são de pessoas.
// Toda gravação passa antes pela política única (servico/escrita-superlogica.js) nas rotas
// (servico/rotas-pagar.js). Aqui ficam o formato de cada chamada e a prova relendo o Superlógica.
// Campos da API conferidos na coleção oficial e no teste com a chave no condomínio 167: datas
// MM/DD/AAAA, erro com HTTP 200 e o campo status, gateway que corta em 60 s (sem resposta é
// incerto e nunca se repete sem reler), categorias em APROPRIACAO[n].

const crypto = require('crypto');
const E = require('./entrada');
const C = require('./banco/comum');
const W = require('../servico/escrita-superlogica');

// Operações desta frente na política única. Registradas aqui para a definição ficar junto do
// código que grava; a política lê OPERACOES na hora de cada pedido. Nunca sobrescreve uma que exista.
const OPERACOES_PAGAR = {
  pagar_baixa: { rotulo: 'Baixa de despesa paga, com o comprovante do banco' },
  pagar_remessa: { rotulo: 'Marcação de despesa para a remessa de pagamento' },
  pagar_fornecedor: { rotulo: 'Cadastro de fornecedor e dados de pagamento', sensivel: true },
};
Object.keys(OPERACOES_PAGAR).forEach((k) => { if (!W.OPERACOES[k]) W.OPERACOES[k] = OPERACOES_PAGAR[k]; });

const FORMA = { boleto: 0, debito_automatico: 7, transferencia: 8, ted: 9, pix: 12, dctfweb: 13, pix_copia_cola: 14 };
const NOME_FORMA = { 0: 'Boleto', 1: 'Cheque', 2: 'Dinheiro', 3: 'Cartão de crédito', 4: 'Cartão de débito', 7: 'Débito automático', 8: 'Transferência', 9: 'Doc/Ted', 10: 'Outros', 12: 'Pix', 13: 'DCTFWeb', 14: 'Pix Copia e Cola' };
// fl_pixtipochave_pdes (medido nas despesas pagas de setembro): 1 CPF, 2 CNPJ, 3 telefone, 4 email, 5 aleatória.
const TIPO_PIX = { cpf: 1, cnpj: 2, telefone: 3, email: 4, aleatoria: 5 };
const NOME_TIPO_PIX = { cpf: 'CPF', cnpj: 'CNPJ', telefone: 'Telefone', email: 'Email', aleatoria: 'Chave aleatória' };
const ETIQUETA_COMPROVANTE = 3; // arquivos/etiquetas: 3 = Comprovante (lido no Superlógica em 23/10/2026)
const MAX_PARCELAS = 24;
const MAX_RATEIO = 20;
// Acréscimo do banco acima disto não baixa sozinho (vai para a pessoa conferir).
const ACRESCIMO_MAX_PCT = 0.1;
const ACRESCIMO_MAX_CENT = 50000;

const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const cent = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
const reais = (c) => (Math.round(c) / 100).toFixed(2);
const brl = (c) => C.fmtBRL(c);
const dataBR = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? String(iso).split('-').reverse().join('/') : '');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isoValido = (v) => ISO.test(String(v || '')) && C.dataValida(String(v));

// ---------- chave Pix ----------
function cpfValido(c) {
  c = soDig(c);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}
// Lê e confere a chave Pix. tipo (opcional) vem da tela; sem ele a chave precisa ser inequívoca
// (11 dígitos podem ser CPF ou celular: aí o tipo é obrigatório). Devolve { tipo, codigo, chave } ou { erro }.
function lerChavePix(valor, tipo) {
  const s = limpar(valor);
  if (!s) return { erro: 'Informe a chave Pix.' };
  if (s.length > 77) return { erro: 'Chave Pix longa demais.' };
  const d = soDig(s);
  const como = {
    aleatoria: () => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s.toLowerCase() : null),
    email: () => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s.toLowerCase() : null),
    cnpj: () => (d.length === 14 && E.cnpjValido(d) && /^[\d.\/\s-]+$/.test(s) ? d : null),
    cpf: () => (d.length === 11 && cpfValido(d) && /^[\d.\s-]+$/.test(s) ? d : null),
    telefone: () => {
      if (!/^\+?[\d\s()-]+$/.test(s)) return null;
      const n = s.trim().startsWith('+') ? d : (d.length === 10 || d.length === 11 ? '55' + d : d);
      return /^55[1-9]{2}9?\d{8}$/.test(n) ? '+' + n : null;
    },
  };
  if (tipo) {
    if (!como[tipo]) return { erro: 'Tipo de chave Pix inválido.' };
    const c = como[tipo]();
    return c ? { tipo, codigo: TIPO_PIX[tipo], chave: c } : { erro: 'A chave não confere com o tipo ' + NOME_TIPO_PIX[tipo] + '.' };
  }
  const achados = Object.keys(como).map((k) => [k, como[k]()]).filter(([, c]) => c);
  // "+55..." escrito com o sinal é telefone; 11 dígitos sem sinal que valem como CPF e celular: ambíguo.
  if (achados.length === 1) return { tipo: achados[0][0], codigo: TIPO_PIX[achados[0][0]], chave: achados[0][1] };
  if (s.startsWith('+')) { const tel = achados.find(([k]) => k === 'telefone'); if (tel) return { tipo: 'telefone', codigo: 3, chave: tel[1] }; }
  if (achados.length > 1) return { erro: 'Escolha o tipo da chave Pix (pode ser CPF ou telefone).' };
  return { erro: 'Chave Pix inválida (confira os dígitos).' };
}

// Pix copia e cola (BR Code): confere o CRC16 do fim e tira a chave do recebedor (campo 26, item 01)
// e o valor (campo 54). Medido no 167 em 23/10/2026: a API do Superlógica não aceita a forma "Pix Copia
// e Cola" (pede uma chave que nenhum campo enviado satisfaz); por isso o Hub lança como Pix com a chave
// tirada do código. Código dinâmico (só endereço, sem chave) não dá: fica para a tela do Superlógica.
function crc16(s) {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
// Campos TLV (id 2 dígitos, tamanho 2 dígitos, valor) de um nível do BR Code.
function camposTlv(s) {
  const out = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const id = s.slice(i, i + 2), n = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(s.slice(i + 2, i + 4)) || i + 4 + n > s.length) return null;
    out[id] = s.slice(i + 4, i + 4 + n);
    i += 4 + n;
  }
  return i === s.length ? out : null;
}
function lerPixCopiaCola(valor) {
  const s = String(valor == null ? '' : valor).replace(/[\r\n]+/g, '').trim();
  if (s.length < 30 || s.length > 600 || !/^[\x20-\x7e]+$/.test(s)) return { erro: 'Pix copia e cola inválido.' };
  if (!s.startsWith('000201') || !/0014br\.gov\.bcb\.pix/i.test(s)) return { erro: 'O texto não é um Pix copia e cola.' };
  const m = s.match(/6304([0-9A-Fa-f]{4})$/);
  if (!m || crc16(s.slice(0, -4)) !== m[1].toUpperCase()) return { erro: 'Pix copia e cola com dígito de conferência errado (copie de novo).' };
  const topo = camposTlv(s);
  if (!topo) return { erro: 'Pix copia e cola inválido.' };
  let conta = null;
  for (let id = 26; id <= 51 && !conta; id++) {
    const c = topo[String(id)] ? camposTlv(topo[String(id)]) : null;
    if (c && /^br\.gov\.bcb\.pix$/i.test(c['00'] || '')) conta = c;
  }
  if (!conta) return { erro: 'Pix copia e cola sem os dados do recebedor.' };
  const valorCent = topo['54'] && /^\d+(\.\d{1,2})?$/.test(topo['54']) ? Math.round(Number(topo['54']) * 100) : null;
  if (!conta['01']) return { erro: 'Pix copia e cola dinâmico (sem a chave do recebedor): lance este pelo Superlógica.', dinamico: true };
  return { texto: s, chave: conta['01'], valor_centavos: valorCent, recebedor: topo['59'] || null };
}

// ---------- código de barras ----------
// Linha digitável (47 ou 48) ou código de barras (44) conferido pelos dígitos. null se não confere.
function lerCodigo(valor, hojeIso) {
  const d = soDig(valor);
  if (d.length === 44) return C.codigoBarrasValido(d) ? E.acharLinha(C.linhaDigitavel(d), hojeIso) : null;
  if (d.length === 47 || d.length === 48) return E.acharLinha(d, hojeIso);
  return null;
}

// ---------- parcelas ----------
function mesmoDiaMesSeguinte(iso, n) {
  const [a, m, dia] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const fim = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  return alvo.getUTCFullYear() + '-' + String(alvo.getUTCMonth() + 1).padStart(2, '0') + '-' + String(Math.min(dia, fim)).padStart(2, '0');
}
// Divide o total em n parcelas mensais iguais (centavos que sobram vão na primeira).
function dividir(totalCent, n, primeiroVenc) {
  const base = Math.floor(totalCent / n), resto = totalCent - base * n;
  return Array.from({ length: n }, (_, i) => ({ vencimento: mesmoDiaMesSeguinte(primeiroVenc, i), valor_centavos: base + (i === 0 ? resto : 0), linha: null }));
}
// Confere as parcelas. lista: [{ vencimento, valor (reais) | valor_centavos, linha? }]. A soma tem de
// dar o total; código de barras de cada parcela conferido pelos dígitos e pelo valor que traz.
function conferirParcelas(totalCent, lista, hojeIso) {
  if (!Array.isArray(lista) || !lista.length) return { erro: 'Informe ao menos uma parcela.' };
  if (lista.length > MAX_PARCELAS) return { erro: 'No máximo ' + MAX_PARCELAS + ' parcelas.' };
  const out = []; const linhas = new Set();
  let soma = 0, anterior = '';
  for (let i = 0; i < lista.length; i++) {
    const p = lista[i] || {};
    const v = p.valor_centavos != null ? Number(p.valor_centavos) : cent(p.valor);
    if (!Number.isInteger(v) || v <= 0) return { erro: 'Valor inválido na parcela ' + (i + 1) + '.' };
    if (!isoValido(p.vencimento)) return { erro: 'Vencimento inválido na parcela ' + (i + 1) + '.' };
    if (p.vencimento < anterior) return { erro: 'Os vencimentos das parcelas precisam estar em ordem.' };
    anterior = p.vencimento;
    let linha = null;
    if (p.linha) {
      const l = lerCodigo(p.linha, hojeIso);
      if (!l) return { erro: 'Código de barras da parcela ' + (i + 1) + ' não confere (dígitos).' };
      if (l.valor && Math.round(l.valor * 100) !== v) return { erro: 'O código de barras da parcela ' + (i + 1) + ' traz ' + brl(Math.round(l.valor * 100)) + ', diferente do valor da parcela.' };
      if (linhas.has(l.linha)) return { erro: 'O mesmo código de barras aparece em duas parcelas.' };
      linhas.add(l.linha); linha = l.linha;
    }
    soma += v;
    out.push({ vencimento: p.vencimento, valor_centavos: v, linha });
  }
  if (soma !== totalCent) return { erro: 'A soma das parcelas (' + brl(soma) + ') é diferente do valor do documento (' + brl(totalCent) + ').' };
  return { ok: out };
}

// ---------- rateio por categoria ----------
// itens: [{ conta, valor | valor_centavos, complemento? }]; contas: plano do condomínio [{ conta, nome }].
function conferirRateio(totalCent, itens, contas) {
  if (!Array.isArray(itens) || !itens.length) return { erro: 'Escolha ao menos uma categoria.' };
  if (itens.length > MAX_RATEIO) return { erro: 'No máximo ' + MAX_RATEIO + ' categorias.' };
  const plano = new Map((contas || []).map((c) => [String(c.conta), c.nome]));
  const vistos = new Set(); const out = [];
  let soma = 0;
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i] || {};
    const conta = String(it.conta || '');
    if (!plano.has(conta)) return { erro: 'A categoria ' + (conta || '(vazia)') + ' não existe no plano de contas deste condomínio.' };
    const v = it.valor_centavos != null ? Number(it.valor_centavos) : cent(it.valor);
    if (!Number.isInteger(v) || v <= 0) return { erro: 'Valor inválido na categoria ' + conta + '.' };
    const comp = it.complemento ? limpar(it.complemento).slice(0, 200) : null;
    const k = conta + '|' + (comp || '');
    if (vistos.has(k)) return { erro: 'A categoria ' + conta + ' aparece duas vezes com o mesmo complemento.' };
    vistos.add(k); soma += v;
    out.push({ conta, nome: plano.get(conta), valor_centavos: v, complemento: comp });
  }
  if (soma !== totalCent) return { erro: 'A soma das categorias (' + brl(soma) + ') é diferente do valor do documento (' + brl(totalCent) + ').' };
  return { ok: out };
}

// Confere o pacote "lançamento completo" guardado no rascunho (dados.pagar) contra o documento.
// Devolve { ok: { parcelas, rateio, pix, copia_cola, remessa, forma } } ou { erro }.
function conferirPacote(dados, pagar, contas, hojeIso) {
  const p = pagar || {};
  const total = cent(dados.valor);
  if (!total || total <= 0) return { erro: 'O documento está sem valor.' };
  const forma = Number(dados.forma_pag == null ? 0 : dados.forma_pag);
  let parcelas;
  if (Array.isArray(p.parcelas) && p.parcelas.length) parcelas = p.parcelas;
  else parcelas = [{ vencimento: dados.vencimento, valor_centavos: total, linha: dados.linha || null }];
  const cp = conferirParcelas(total, parcelas, hojeIso);
  if (cp.erro) return cp;
  if (cp.ok.length === 1 && !cp.ok[0].linha && dados.linha) cp.ok[0].linha = dados.linha;
  const rateio = Array.isArray(p.rateio) && p.rateio.length ? p.rateio : (dados.conta ? [{ conta: dados.conta, valor_centavos: total, complemento: dados.complemento || null }] : []);
  const cr = conferirRateio(total, rateio, contas);
  if (cr.erro) return cr;
  let pix = null, copiaCola = null;
  if (p.pix && p.pix.chave) { const k = lerChavePix(p.pix.chave, p.pix.tipo || null); if (k.erro) return k; pix = { tipo: k.tipo, codigo: k.codigo, chave: k.chave }; }
  if (p.copia_cola) {
    const k = lerPixCopiaCola(p.copia_cola);
    if (k.erro) return k;
    if (cp.ok.length > 1) return { erro: 'Pix copia e cola vale para uma parcela só.' };
    if (k.valor_centavos && k.valor_centavos !== cp.ok[0].valor_centavos) return { erro: 'O Pix copia e cola traz ' + brl(k.valor_centavos) + ', diferente do valor do documento.' };
    const ch = lerChavePix(k.chave);
    if (ch.erro) return { erro: 'A chave dentro do Pix copia e cola não confere: ' + ch.erro };
    if (pix && pix.chave !== ch.chave) return { erro: 'A chave Pix informada é diferente da chave dentro do Pix copia e cola.' };
    pix = { tipo: ch.tipo, codigo: ch.codigo, chave: ch.chave };
    copiaCola = k.texto;
  }
  // Copia e cola entra como Pix com a chave do código (a forma "copia e cola" a API não aceita).
  const formaFinal = forma === FORMA.pix_copia_cola ? FORMA.pix : forma;
  if (formaFinal === FORMA.pix && !pix) return { erro: 'Forma Pix: informe a chave Pix do fornecedor ou cole o Pix copia e cola.' };
  if (pix && formaFinal !== FORMA.pix) return { erro: 'Chave Pix informada: escolha a forma de pagamento Pix.' };
  if ((formaFinal === FORMA.boleto || formaFinal === FORMA.dctfweb) && cp.ok.some((x) => !x.linha) && p.remessa) return { erro: 'Para marcar a remessa, cada parcela do boleto precisa do código de barras.' };
  const remessa = !!p.remessa;
  if (remessa && ![FORMA.boleto, FORMA.pix, FORMA.ted, FORMA.transferencia, FORMA.dctfweb].includes(formaFinal)) return { erro: 'Essa forma de pagamento não vai na remessa (' + (NOME_FORMA[formaFinal] || formaFinal) + ').' };
  if (remessa && cp.ok.some((x) => x.vencimento < hojeIso)) return { erro: 'Parcela vencida não vai para a remessa.' };
  return { ok: { parcelas: cp.ok, rateio: cr.ok, pix, copia_cola: copiaCola, remessa, forma: formaFinal } };
}

// ---------- transporte ----------
// cred.pedir (só nos testes) troca a chamada de rede; sem ele vale o transporte da entrada.
function pedir(cred, metodo, caminho, query, corpo, tipo) {
  if (cred && typeof cred.pedir === 'function') return cred.pedir(metodo, caminho, query, corpo, tipo);
  return E.pedir(cred, metodo, caminho, query, corpo, tipo);
}
const form = (o) => Buffer.from(new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString(), 'utf8');
// Só é recusa clara quando o Superlógica respondeu dizendo que não gravou (status do corpo
// diferente de 200) ou HTTP 4xx. O resto (sem resposta, 5xx, corpo estranho) pode ter gravado.
function resultado(r) {
  const c = E.corpoOk(r);
  const statusCorpo = c.item && c.item.status != null ? String(c.item.status) : null;
  const recusa = !c.ok && ((r.status >= 400 && r.status < 500) || (r.status >= 200 && r.status < 300 && statusCorpo && statusCorpo !== '200'));
  return { ok: c.ok, recusa, incerto: !c.ok && !recusa, msg: c.msg, dados: c.item && c.item.data && typeof c.item.data === 'object' ? c.item.data : {} };
}

// Envia um arquivo para o Superlógica (anexo de despesa, tipo 9, responsável o fornecedor).
async function enviarArquivo(cred, idFornecedor, buf, nome, mime) {
  const tipo = E.EXTENSAO[mime] ? mime : 'application/pdf';
  const fronteira = '----hub' + crypto.randomBytes(12).toString('hex');
  const campo = (n, v) => Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="' + n + '"\r\n\r\n' + v + '\r\n', 'utf8');
  const corpo = Buffer.concat([
    campo('ID_RESPONSAVEL_ARQ', String(idFornecedor)), campo('FL_TIPO_ARQ', '9'),
    Buffer.from('--' + fronteira + '\r\nContent-Disposition: form-data; name="ARQUIVO"; filename="' + E.nomeArquivoSeguro(nome, tipo) + '"\r\nContent-Type: ' + tipo + '\r\n\r\n', 'utf8'),
    buf, Buffer.from('\r\n--' + fronteira + '--\r\n', 'utf8'),
  ]);
  const r = resultado(await pedir(cred, 'POST', 'arquivos/', null, corpo, 'multipart/form-data; boundary=' + fronteira));
  const id = /^\d+$/.test(String(r.dados.id_arquivo_arq || '')) ? String(r.dados.id_arquivo_arq) : null;
  return { id: r.ok ? id : null, msg: r.msg };
}
async function etiquetar(cred, idArquivo, idEtiqueta) {
  return resultado(await pedir(cred, 'PUT', 'arquivos/adicionaretiqueta', null, form({ idDocumento: idArquivo, idEtiqueta }))).ok;
}

// Parcelas de uma despesa relidas pelo período dos vencimentos (todas as situações).
async function parcelasDaDespesa(cliente, idCond, idDespesa, ini, fim) {
  const l = await E.paginas(cliente, 'despesas/index', { idCondominio: idCond, comStatus: 'todas', dtInicio: E.isoParaSL(ini), dtFim: E.isoParaSL(fim) }, 20);
  return l.filter((p) => String(p.id_despesa_des) === String(idDespesa))
    .sort((a, b) => String(E.slParaIso(a.dt_vencimento_pdes)).localeCompare(String(E.slParaIso(b.dt_vencimento_pdes))));
}
async function parcelaAtual(cliente, idCond, idParcela, vencIso) {
  const l = await E.paginas(cliente, 'despesas/index', { idCondominio: idCond, comStatus: 'todas', dtInicio: E.isoParaSL(vencIso), dtFim: E.isoParaSL(vencIso) }, 10);
  return l.find((p) => String(p.id_parcela_pdes) === String(idParcela)) || null;
}

// ---------- 1. lançamento completo ----------
// Corpo do POST despesas/ com parcelas, rateio, código de barras e Pix.
// d: { id_superlogica, id_fornecedor, nome_fornecedor, forma, tipo, documento, emissao, bloqueio_contas,
//      id_contabanco, id_arquivo, parcelas:[{vencimento, valor_centavos, linha}], rateio:[{conta, valor_centavos, complemento}], pix }
function corpoDespesaCompleta(d) {
  const o = {
    ID_CONDOMINIO_COND: d.id_superlogica, ID_CONTATO_CON: d.id_fornecedor, ST_NOME_CON: d.nome_fornecedor || undefined,
    ID_FORMA_PAG: d.forma == null ? 0 : d.forma, ID_TIPO_DOC: E.TIPOS_DOC_SL[d.tipo] || undefined,
    ST_DOCUMENTO_DES: d.documento ? String(d.documento).slice(0, 25) : undefined,
    // Emissão dentro de mês fechado não vai: o Superlógica usa a data de hoje.
    DT_DESPESA_DES: d.emissao && !(d.bloqueio_contas && d.emissao <= d.bloqueio_contas) ? E.isoParaSL(d.emissao) : undefined,
    ID_CONTABANCO_CB: d.id_contabanco || undefined,
    DT_VENCIMENTOPRIMEIRAPARCELA: E.isoParaSL(d.parcelas[0].vencimento),
    FL_ACAO_IMPRESSAO: 1,
  };
  d.rateio.forEach((r, i) => {
    o['APROPRIACAO[' + i + '][ST_CONTA_CONT]'] = r.conta;
    o['APROPRIACAO[' + i + '][VL_VALOR_PDES]'] = reais(r.valor_centavos);
    if (r.complemento) o['APROPRIACAO[' + i + '][ST_COMPLEMENTO_APRO]'] = r.complemento;
  });
  // Sempre pelas parcelas (DESPESA_PARCELA[n]): medido no 167, é o único jeito de a chave Pix ficar
  // gravada (no topo do corpo a API recusa com "Chave BR Code inválida"); código de barras também vale ali.
  o.NM_PARCELAS = d.parcelas.length;
  d.parcelas.forEach((p, i) => {
    const k = 'DESPESA_PARCELA[' + i + ']';
    o[k + '[DT_VENCIMENTO_PDES]'] = E.isoParaSL(p.vencimento);
    o[k + '[VL_VALOR_PDES]'] = reais(p.valor_centavos);
    if (p.linha) o[k + '[ST_CODIGOBARRAS_PDES]'] = p.linha;
    if (d.pix) { o[k + '[FL_PIXTIPOCHAVE_PDES]'] = d.pix.codigo; o[k + '[ST_PIXCHAVE_PDES]'] = d.pix.chave; }
  });
  if (d.id_arquivo) o['ARQUIVOS[0][ID_ARQUIVO_ARQ]'] = d.id_arquivo;
  return o;
}
// Prova de uma parcela relida contra o que foi pedido.
function provaParcela(parc, pedida, d) {
  const cb = soDig(parc.st_codigobarras_pdes);
  return {
    valor: cent(parc.vl_valor_pdes) === pedida.valor_centavos,
    vencimento: E.slParaIso(parc.dt_vencimento_pdes) === pedida.vencimento,
    fornecedor: String(parc.id_contato_con) === String(d.id_fornecedor),
    condominio: String(parc.id_condominio_cond) === String(d.id_superlogica),
    codigo_barras: pedida.linha ? (cb === pedida.linha || cb === E.barrasDaLinha(pedida.linha)) : true,
    pix: d.pix ? limpar(parc.st_pixchave_pdes) === d.pix.chave && String(parc.fl_pixtipochave_pdes) === String(d.pix.codigo) : true,
  };
}
// vl_valor_apro é a fração da categoria na despesa (medido no 167: R$ 0,30 de R$ 0,50 volta 0,6; o mesmo
// em todas as parcelas). Confere a fração vezes o total contra o valor pedido, com 1 centavo de folga.
function provaRateio(parc, rateio) {
  const a = Array.isArray(parc.apropriacao) ? parc.apropriacao : [];
  if (a.length !== rateio.length) return false;
  const total = rateio.reduce((s, r) => s + r.valor_centavos, 0);
  return rateio.every((r) => a.some((x) => String(x.st_conta_cont) === r.conta && Math.abs(Number(x.vl_valor_apro) * total - r.valor_centavos) <= 1));
}

// Lança a despesa completa: arquivo, despesa com parcelas e rateio, anexo e etiqueta, prova relendo
// cada parcela e, se pedido, a marcação da remessa (uma parcela por vez, provada relendo).
// Devolve { ok, incerto, msg, id_despesa, id_arquivo, parcelas:[{id_parcela, vencimento, prova, remessa}], conferido }.
async function lancarCompleto(cred, cliente, d, arquivo, nome, mime, hojeIso) {
  const arq = await enviarArquivo(cred, d.id_fornecedor, arquivo, nome, mime);
  if (!arq.id) return { ok: false, incerto: false, msg: 'O Superlógica recusou o arquivo: ' + arq.msg };
  const r = resultado(await pedir(cred, 'POST', 'despesas/', null, form(corpoDespesaCompleta(Object.assign({}, d, { id_arquivo: arq.id })))));
  const idDespesa = /^\d+$/.test(String(r.dados.id_despesa_des || '')) ? String(r.dados.id_despesa_des) : null;
  if (!r.ok || !idDespesa) return { ok: false, incerto: !r.recusa, msg: r.recusa ? 'O Superlógica recusou a despesa: ' + r.msg : 'O Superlógica não respondeu.', id_arquivo: arq.id };
  const ini = d.parcelas[0].vencimento, fim = d.parcelas[d.parcelas.length - 1].vencimento;
  let lidas = [];
  try { lidas = await parcelasDaDespesa(cliente, d.id_superlogica, idDespesa, ini, fim); } catch (e) { lidas = []; }
  const temAnexo = (p) => Array.isArray(p.arquivos) && p.arquivos.some((a) => String(a.id_arquivo_arq) === arq.id);
  if (lidas[0] && !temAnexo(lidas[0])) {
    const ra = resultado(await pedir(cred, 'POST', 'despesas/anexar', { ID_DESPESA_DES: idDespesa, ID_PARCELA_PDES: lidas[0].id_parcela_pdes, 'ARQUIVOS[0][ID_ARQUIVO_ARQ]': arq.id }, null));
    if (ra.ok) { try { lidas = await parcelasDaDespesa(cliente, d.id_superlogica, idDespesa, ini, fim); } catch (e) { /* fica a leitura anterior */ } }
  }
  const anexado = !!(lidas[0] && temAnexo(lidas[0]));
  const ETQ = { nota: 2, boleto: 1, fatura: 1, guia: 1 };
  const etiqueta = anexado && ETQ[d.tipo] ? await etiquetar(cred, arq.id, ETQ[d.tipo]) : null;
  const parcelas = d.parcelas.map((p, i) => {
    const parc = lidas.length === d.parcelas.length ? lidas[i] : lidas.find((x) => E.slParaIso(x.dt_vencimento_pdes) === p.vencimento && cent(x.vl_valor_pdes) === p.valor_centavos);
    return { vencimento: p.vencimento, valor_centavos: p.valor_centavos, id_parcela: parc ? String(parc.id_parcela_pdes) : null, prova: parc ? provaParcela(parc, p, d) : null, bruto: parc || null };
  });
  const rateioOk = !!(lidas[0] && provaRateio(lidas[0], d.rateio));
  const conferido = lidas.length === d.parcelas.length && parcelas.every((p) => p.prova && Object.values(p.prova).every(Boolean)) && rateioOk;
  // Remessa: só com a despesa provada (nunca marca algo que não se conseguiu reler).
  if (d.remessa && conferido) {
    for (const p of parcelas) p.remessa = await marcarRemessa(cred, cliente, p.bruto, hojeIso);
  }
  parcelas.forEach((p) => { delete p.bruto; });
  return { ok: true, incerto: false, conferido, rateio: rateioOk, anexado, etiqueta, id_despesa: idDespesa, id_arquivo: arq.id, parcelas, msg: r.msg };
}

// ---------- remessa ----------
const naRemessa = (p) => ['1', '2', '3', '4'].includes(String(p && p.fl_remessastatus_pdes != null ? p.fl_remessastatus_pdes : '').trim());
const liquidada = (p) => String(p.fl_liquidado_pdes) === '1' || !!E.slParaIso(p.dt_liquidacao_pdes);
// Pode ir para a remessa? Devolve null (pode) ou o motivo.
function motivoSemRemessa(p, hojeIso) {
  if (!p) return 'Parcela não encontrada no Superlógica.';
  if (liquidada(p)) return 'Parcela já baixada.';
  if (naRemessa(p)) return 'Parcela já está marcada para a remessa.';
  const forma = Number(p.id_forma_pag);
  if (forma === FORMA.debito_automatico) return 'Débito automático não vai na remessa.';
  if ([FORMA.boleto, FORMA.dctfweb].includes(forma) && !lerCodigo(p.st_codigobarras_pdes, hojeIso)) return 'Parcela sem código de barras válido.';
  if (forma === FORMA.pix && !limpar(p.st_pixchave_pdes)) return 'Parcela de Pix sem chave Pix.';
  if (forma === FORMA.pix_copia_cola && !limpar(p.st_pixqrcode_pdes)) return 'Parcela sem o Pix copia e cola.';
  if (![FORMA.boleto, FORMA.pix, FORMA.pix_copia_cola, FORMA.ted, FORMA.transferencia, FORMA.dctfweb].includes(forma)) return 'Essa forma de pagamento não vai na remessa.';
  if (!p.id_contabanco_cb) return 'Parcela sem conta bancária.';
  if (E.slParaIso(p.dt_vencimento_pdes) < hojeIso) return 'Parcela vencida.';
  return null;
}
// Marca a parcela para a remessa (despesas/post com FL_REMESSASTATUS_PDES=1) e prova relendo.
// Não gera nem envia o arquivo: isso continua sendo feito por uma pessoa no Superlógica e no banco.
// Medido no 167: Pix só vai para a remessa com a chave cadastrada nos dados de pagamento do fornecedor
// (sem ela o Superlógica recusa com "Dados de pagamento do favorecido não foi informado").
async function marcarRemessa(cred, cliente, parcAntes, hojeIso) {
  if (!parcAntes) return { ok: false, incerto: false, msg: motivoSemRemessa(null, hojeIso) };
  // Relê a parcela logo antes de gravar (como a baixa): entre a leitura da tela e a confirmação ela
  // pode ter sido baixada ou marcada por outra pessoa. Sem conseguir reler, não grava.
  let parc = null;
  try { parc = await parcelaAtual(cliente, parcAntes.id_condominio_cond, parcAntes.id_parcela_pdes, E.slParaIso(parcAntes.dt_vencimento_pdes)); } catch (e) {
    return { ok: false, incerto: false, msg: 'Não deu para ler a parcela no Superlógica agora. Nada foi gravado.' };
  }
  const motivo = motivoSemRemessa(parc, hojeIso);
  if (motivo) return { ok: false, incerto: false, msg: motivo + ' Nada foi gravado.' };
  const r = resultado(await pedir(cred, 'PUT', 'despesas/post', null, form({ ID_PARCELA_PDES: parc.id_parcela_pdes, FL_REMESSASTATUS_PDES: 1, ID_CONDOMINIO_COND: parc.id_condominio_cond, ID_DESPESA_DES: parc.id_despesa_des })));
  let lida = null;
  try { lida = await parcelaAtual(cliente, parc.id_condominio_cond, parc.id_parcela_pdes, E.slParaIso(parc.dt_vencimento_pdes)); } catch (e) { lida = null; }
  const provado = !!(lida && naRemessa(lida));
  if (provado) return { ok: true, incerto: false, conferido: true };
  if (r.recusa) return { ok: false, incerto: false, msg: 'O Superlógica recusou a marcação: ' + r.msg };
  return { ok: false, incerto: !lida, msg: lida ? 'O Superlógica respondeu, mas a parcela não ficou marcada.' : 'Não deu para reler a parcela; confira no Superlógica.' };
}

// ---------- 2. fornecedor ----------
// f: { cnpj, nome, fantasia, email, telefone, cep, endereco, numero, bairro, cidade, estado,
//      forma, banco:{ banco, agencia, conta, tipo_conta }, pix:{ codigo, chave } }
function corpoFornecedor(idCond, f) {
  const o = {
    ID_CONDOMINIO_COND: idCond, ST_CPF_CON: soDig(f.cnpj), ST_NOME_CON: limpar(f.nome).slice(0, 120), ST_FANTASIA_CON: f.fantasia ? limpar(f.fantasia).slice(0, 120) : undefined,
    ST_EMAIL_CON: f.email || undefined, ST_TELEFONE_CON: f.telefone ? soDig(f.telefone) : undefined, ST_CEP_CON: f.cep ? soDig(f.cep) : undefined,
    ST_ENDERECO_CON: f.endereco || undefined, ST_NUMEROENDERECO_CON: f.numero || undefined, ST_BAIRRO_CON: f.bairro || undefined,
    ST_CIDADE_CON: f.cidade || undefined, ST_ESTADO_CON: f.estado || undefined, ID_TIPOCONTATO_TCON: 0,
    ID_FORMA_PAG: f.forma != null ? f.forma : undefined,
  };
  if (f.banco) Object.assign(o, { ST_BANCO_CON: f.banco.banco, ST_AGENCIA_CON: f.banco.agencia, ST_CONTABANCARIA_CON: f.banco.conta, FL_TIPOCONTA_CON: f.banco.tipo_conta == null ? 0 : f.banco.tipo_conta });
  if (f.pix) Object.assign(o, { 'FAVORECIDO_PIX[0][FL_TIPOCHAVE_PIX]': f.pix.codigo, 'FAVORECIDO_PIX[0][ST_CHAVE_PIX]': f.pix.chave });
  return o;
}
// Confere o pedido de fornecedor novo. Devolve { ok: f } ou { erro }.
function conferirFornecedor(b) {
  const x = b || {};
  const doc = soDig(x.cnpj);
  if (!(doc.length === 14 ? E.cnpjValido(doc) : doc.length === 11 && cpfValido(doc))) return { erro: 'CNPJ ou CPF inválido.' };
  const nome = limpar(x.nome);
  if (nome.length < 3 || nome.length > 120) return { erro: 'Informe o nome do fornecedor (razão social).' };
  const f = { cnpj: doc, nome, fantasia: x.fantasia ? limpar(x.fantasia).slice(0, 120) : null };
  ['email', 'telefone', 'cep', 'endereco', 'numero', 'bairro', 'cidade'].forEach((k) => { if (x[k]) f[k] = limpar(x[k]).slice(0, 120); });
  if (x.estado) { if (!/^[A-Za-z]{2}$/.test(limpar(x.estado))) return { erro: 'Estado com 2 letras (ES).' }; f.estado = limpar(x.estado).toUpperCase(); }
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) return { erro: 'Email inválido.' };
  if (x.pix && x.pix.chave) { const k = lerChavePix(x.pix.chave, x.pix.tipo || null); if (k.erro) return k; f.pix = { tipo: k.tipo, codigo: k.codigo, chave: k.chave }; }
  if (x.banco && (x.banco.banco || x.banco.agencia || x.banco.conta)) {
    const bb = { banco: soDig(x.banco.banco), agencia: limpar(x.banco.agencia), conta: limpar(x.banco.conta), tipo_conta: Number(x.banco.tipo_conta || 0) };
    if (!/^\d{3}$/.test(bb.banco) || !/^\d{1,6}(-?[\dXx])?$/.test(bb.agencia) || !/^\d{1,15}-?[\dXx]$/.test(bb.conta) || ![0, 1].includes(bb.tipo_conta)) return { erro: 'Dados bancários inválidos (banco com 3 dígitos, agência e conta com dígito).' };
    f.banco = bb;
  }
  return { ok: f };
}
// Cadastra o fornecedor (nunca duplica: confere pelo CNPJ antes e relê depois).
// Devolve { ok, incerto, ja_existia, id, nome, msg }.
async function cadastrarFornecedor(cred, cliente, idCond, f) {
  E.limparCache(['forn:' + f.cnpj]);
  const antes = await E.fornecedorPorCnpj(cliente, f.cnpj);
  if (antes) return { ok: true, ja_existia: true, id: antes.id, nome: antes.nome };
  const r = resultado(await pedir(cred, 'POST', 'fornecedores/', null, form(corpoFornecedor(idCond, f))));
  E.limparCache(['forn:' + f.cnpj]);
  let depois = null;
  try { depois = await E.fornecedorPorCnpj(cliente, f.cnpj); } catch (e) { depois = null; }
  if (depois) {
    const comPix = f.pix ? await pixDoFornecedor(cliente, depois.id).catch(() => null) : null;
    return { ok: true, ja_existia: false, id: depois.id, nome: depois.nome, pix_gravado: f.pix ? !!(comPix && comPix.some((p) => limpar(p.st_chave_pix) === f.pix.chave)) : null };
  }
  if (r.recusa) return { ok: false, incerto: false, msg: 'O Superlógica recusou o cadastro: ' + r.msg };
  return { ok: false, incerto: true, msg: 'O Superlógica não confirmou o cadastro. Confira lá pelo CNPJ antes de tentar de novo.' };
}
async function pixDoFornecedor(cliente, id) {
  const l = await cliente.get('fornecedores/index', { contatosDoTipo: 'fornecedores', id, itensPorPagina: 5, pagina: 1 });
  const f = (Array.isArray(l) ? l : []).find((x) => String(x.id_contato_con) === String(id));
  return f && Array.isArray(f.favorecido_pix) ? f.favorecido_pix : [];
}

// ---------- 3. baixa ----------
// Decide o que fazer com um pagamento conferido contra a despesa (resultado de cnab240.conferirPagamentos
// ou do extrato). Devolve { acao: 'baixar' | 'conferir' | 'nada', motivo, juros_centavos, multa_centavos }.
function decidirBaixa(c) {
  if (!c) return { acao: 'nada', motivo: 'sem dados' };
  if (c.situacao === 'agendado' || c.situacao === 'pendente') return { acao: 'nada', motivo: 'Agendado ou pendente de assinatura no banco: ainda não foi pago.' };
  if (c.situacao === 'rejeitado') return { acao: 'conferir', motivo: 'O banco rejeitou o pagamento (' + (c.ocorrencias || []).map((o) => o.texto).join('; ') + '). Nada foi baixado.' };
  if (c.situacao === 'pago_sem_despesa') return { acao: 'conferir', motivo: 'Pago no banco sem despesa correspondente no Superlógica.' };
  if (c.situacao === 'ambiguo') return { acao: 'conferir', motivo: 'Mais de uma despesa possível para este pagamento.' };
  const d = c.despesa;
  if (!d) return { acao: 'nada', motivo: 'sem despesa' };
  const tipos = (c.achados || []).map((a) => a.tipo);
  if (d.liquidada) {
    if (tipos.includes('data_baixa_diferente')) return { acao: 'conferir', motivo: 'Já baixada no Superlógica com data diferente da do banco.' };
    return { acao: 'nada', motivo: 'Já baixada.' };
  }
  const graves = ['codigo_barras_diferente', 'beneficiario_diferente', 'pagador_diferente', 'pago_a_menor', 'sem_valor_no_sistema'];
  const g = tipos.find((t) => graves.includes(t));
  if (g) return { acao: 'conferir', motivo: (c.achados.find((a) => a.tipo === g) || {}).detalhe || g };
  if (tipos.includes('sem_codigo_no_sistema')) return { acao: 'conferir', motivo: 'A despesa não tem código de barras e o pagamento casou só por valor e data.' };
  const acrescimo = Math.max(0, (c.valor_pago_centavos || 0) - (d.valor_centavos || 0));
  if (acrescimo > 0 && (acrescimo > ACRESCIMO_MAX_CENT || acrescimo > (d.valor_centavos || 0) * ACRESCIMO_MAX_PCT)) {
    return { acao: 'conferir', motivo: 'Pago ' + brl(acrescimo) + ' acima do lançado: acréscimo alto, confira antes de baixar.', juros_centavos: acrescimo, multa_centavos: 0 };
  }
  // O banco não separa juros de multa: o acréscimo inteiro entra como juros e o caso aparece em Juros e atrasos.
  return { acao: 'baixar', motivo: acrescimo ? 'Pago com acréscimo de ' + brl(acrescimo) + ' (lançado como juros).' : 'Pago no valor lançado.', juros_centavos: acrescimo, multa_centavos: 0 };
}

// Corpo do despesas/liquidar (formato da coleção oficial).
function corpoLiquidar(parc, b) {
  return {
    ID_DESPESA_DES: parc.id_despesa_des, ID_PARCELA_PDES: parc.id_parcela_pdes, ID_CONTATO_CON: parc.id_contato_con, ST_NOME_CON: limpar(parc.st_nome_con) || undefined,
    DT_LIQUIDACAO_PDES: E.isoParaSL(b.data), ID_FORMA_PAG: parc.id_forma_pag == null || parc.id_forma_pag === '' ? 0 : parc.id_forma_pag, ID_CONTABANCO_CB: parc.id_contabanco_cb,
    VL_VALOR_PDES: reais(cent(parc.vl_valor_pdes)), CHECK_LIQUIDAR_TODOS_CH: 0, EMITIR_RECIBO: 0, VL_DESCONTO_PDES: '0.00',
    VL_MULTA_PDES: reais(b.multa_centavos || 0), VL_JUROS_PDES: reais(b.juros_centavos || 0), VL_PAGO: reais(b.valor_pago_centavos),
    ID_CONDOMINIO_COND: parc.id_condominio_cond, 'ARQUIVOS[0][ID_ARQUIVO_ARQ]': b.id_arquivo || undefined,
  };
}
// Dá a baixa: relê a parcela, envia o comprovante, liquida com data e valor reais e prova relendo.
// b: { id_condominio, id_parcela, vencimento, data, valor_pago_centavos, juros_centavos, multa_centavos,
//      comprovante: Buffer (PDF), nome_comprovante, bloqueio? }
// Devolve { ok, incerto, msg, id_arquivo, prova, ja_baixada }.
async function darBaixa(cred, cliente, b) {
  let parc = null;
  try { parc = await parcelaAtual(cliente, b.id_condominio, b.id_parcela, b.vencimento); } catch (e) {
    return { ok: false, incerto: false, msg: 'Não deu para ler a parcela no Superlógica agora. Nada foi gravado.' };
  }
  if (!parc) return { ok: false, incerto: false, msg: 'A parcela não foi encontrada no Superlógica. Nada foi gravado.' };
  if (liquidada(parc)) return { ok: false, incerto: false, ja_baixada: true, msg: 'A parcela já estava baixada no Superlógica (em ' + dataBR(E.slParaIso(parc.dt_liquidacao_pdes)) + '). Nada foi gravado.' };
  const valor = cent(parc.vl_valor_pdes);
  if (b.valor_pago_centavos !== valor + (b.juros_centavos || 0) + (b.multa_centavos || 0)) return { ok: false, incerto: false, msg: 'Valor pago diferente do valor da parcela mais juros e multa. Nada foi gravado.' };
  if (!isoValido(b.data) || b.data > b.hoje) return { ok: false, incerto: false, msg: 'Data do pagamento inválida. Nada foi gravado.' };
  if (b.bloqueio && b.data <= b.bloqueio) return { ok: false, incerto: false, msg: 'O mês do pagamento já está fechado no Superlógica. Nada foi gravado.' };
  if (!parc.id_contabanco_cb) return { ok: false, incerto: false, msg: 'A parcela está sem conta bancária no Superlógica. Nada foi gravado.' };
  const arq = await enviarArquivo(cred, parc.id_contato_con, b.comprovante, b.nome_comprovante || 'comprovante-banco.pdf', 'application/pdf');
  if (!arq.id) return { ok: false, incerto: false, msg: 'O Superlógica recusou o comprovante: ' + arq.msg + '. Nada foi baixado.' };
  const r = resultado(await pedir(cred, 'PUT', 'despesas/liquidar', null, form(corpoLiquidar(parc, Object.assign({}, b, { id_arquivo: arq.id })))));
  let lida = null;
  try { lida = await parcelaAtual(cliente, b.id_condominio, b.id_parcela, b.vencimento); } catch (e) { lida = null; }
  if (!lida || !liquidada(lida)) {
    if (r.recusa && lida) return { ok: false, incerto: false, id_arquivo: arq.id, msg: 'O Superlógica recusou a baixa: ' + r.msg };
    return { ok: false, incerto: true, id_arquivo: arq.id, msg: 'O Superlógica não confirmou a baixa. Confira lá antes de qualquer coisa.' };
  }
  const temAnexo = (p) => Array.isArray(p.arquivos) && p.arquivos.some((a) => String(a.id_arquivo_arq) === arq.id);
  if (!temAnexo(lida)) {
    const ra = resultado(await pedir(cred, 'POST', 'despesas/anexar', { ID_DESPESA_DES: parc.id_despesa_des, ID_PARCELA_PDES: parc.id_parcela_pdes, 'ARQUIVOS[0][ID_ARQUIVO_ARQ]': arq.id }, null));
    if (ra.ok) { try { lida = (await parcelaAtual(cliente, b.id_condominio, b.id_parcela, b.vencimento)) || lida; } catch (e) { /* fica a leitura anterior */ } }
  }
  const anexado = temAnexo(lida);
  const etiqueta = anexado ? await etiquetar(cred, arq.id, ETIQUETA_COMPROVANTE) : null;
  const prova = {
    data: E.slParaIso(lida.dt_liquidacao_pdes) === b.data,
    juros: Math.abs((cent(lida.vl_juros_pdes) || 0) - (b.juros_centavos || 0)) <= 1,
    multa: Math.abs((cent(lida.vl_multa_pdes) || 0) - (b.multa_centavos || 0)) <= 1,
    comprovante: anexado,
  };
  return { ok: true, incerto: false, conferido: Object.values(prova).every(Boolean), prova, etiqueta, id_arquivo: arq.id, msg: r.msg };
}

// ---------- comprovante do banco ----------
// PDF de texto simples (sem biblioteca nova): os dados do registro do banco, como vieram, para
// anexar na baixa. Não é print de tela e nada nele é digitado por pessoa.
function pdfTexto(titulo, linhas) {
  const lat = (s) => Buffer.from(String(s).normalize('NFC').replace(/[^\x20-\x7e\xa0-\xff]/g, '?'), 'latin1').toString('latin1');
  const esc = (s) => lat(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const quebrar = (s) => { const out = []; let t = String(s); while (t.length > 95) { out.push(t.slice(0, 95)); t = t.slice(95); } out.push(t); return out; };
  const todas = [].concat(...linhas.map(quebrar)).slice(0, 60);
  let y = 800;
  let conteudo = 'BT /F1 14 Tf 50 ' + y + ' Td (' + esc(titulo) + ') Tj ET\n';
  y -= 28;
  for (const l of todas) { conteudo += 'BT /F1 10 Tf 50 ' + y + ' Td (' + esc(l) + ') Tj ET\n'; y -= 14; }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Length ' + Buffer.byteLength(conteudo, 'latin1') + ' >>\nstream\n' + conteudo + 'endstream',
  ];
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const pos = [];
  objs.forEach((o, i) => { pos.push(Buffer.byteLength(pdf, 'latin1')); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + pos.map((p) => String(p).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}
// Comprovante a partir do registro do retorno CNAB 240 (linha de fin_juros_banco).
function comprovanteRetorno(cond, l) {
  const cods = (Array.isArray(l.ocorrencias) ? l.ocorrencias : []).map((o) => o.codigo + ' ' + o.texto).join('; ');
  const linhas = [
    'Condomínio: ' + (cond || ''),
    'Favorecido no banco: ' + (l.favorecido || ''),
    'Data do pagamento: ' + dataBR(l.data_real || l.data_pagamento),
    'Valor pago: ' + brl(l.valor_real_centavos != null ? Number(l.valor_real_centavos) : Number(l.valor_centavos)),
    l.valor_titulo_centavos != null ? 'Valor do título: ' + brl(Number(l.valor_titulo_centavos)) : null,
    l.vencimento ? 'Vencimento do título: ' + dataBR(l.vencimento) : null,
    l.codigo_barras ? 'Código de barras: ' + l.codigo_barras : null,
    l.seu_numero ? 'Seu número: ' + l.seu_numero : null,
    l.nosso_numero ? 'Nosso número: ' + l.nosso_numero : null,
    'Ocorrência do banco: ' + (cods || ''),
    'Arquivo de retorno de ' + dataBR(l.data_arquivo) + ', lote ' + (l.lote || '') + ', registro ' + (l.seq != null ? l.seq : '') + ', segmento ' + (l.segmento || ''),
    'Impressão digital do arquivo de retorno (SHA 256): ' + (l.arquivo_hash || ''),
    '',
    'Dados copiados do arquivo de retorno enviado pelo banco. Nenhum valor foi digitado.',
  ].filter((x) => x != null);
  return pdfTexto('Comprovante de pagamento pelo retorno do banco', linhas);
}
// Comprovante a partir da linha do extrato importado no Superlógica (débito automático).
function comprovanteExtrato(cond, conta, x) {
  return pdfTexto('Comprovante de débito pelo extrato bancário', [
    'Condomínio: ' + (cond || ''),
    'Conta: ' + (conta || ''),
    'Data do débito: ' + dataBR(x.data),
    'Valor debitado: ' + brl(Math.abs(Number(x.valor))),
    'Descrição no extrato: ' + (x.descricao || ''),
    x.fitid ? 'Identificador da transação no extrato: ' + x.fitid : null,
    x.numero ? 'Número do documento no extrato: ' + x.numero : null,
    '',
    'Dados copiados do extrato do banco importado no Superlógica. Nenhum valor foi digitado.',
  ].filter((v) => v != null));
}

// ---------- ligação com a entrada de documentos ----------
// Linhas do pacote para o resumo da confirmação (servico/rotas-entrada.js).
function linhasDoPacote(pg) {
  if (!pg || typeof pg !== 'object') return [];
  const l = [];
  if (Array.isArray(pg.parcelas) && pg.parcelas.length > 1) l.push({ rotulo: 'Parcelas', valor: pg.parcelas.map((p) => dataBR(p.vencimento) + ' ' + brl(p.valor_centavos)).join('; ') });
  if (Array.isArray(pg.rateio) && pg.rateio.length > 1) l.push({ rotulo: 'Rateio', valor: pg.rateio.map((r) => r.conta + ' ' + brl(r.valor_centavos)).join('; ') });
  if (pg.pix) l.push({ rotulo: 'Chave Pix', valor: (NOME_TIPO_PIX[pg.pix.tipo] || '') + ' ' + pg.pix.chave });
  if (pg.remessa) l.push({ rotulo: 'Remessa', valor: 'Marcar para a remessa de pagamento (o arquivo e a assinatura continuam com as pessoas)' });
  return l;
}
// Lança o rascunho com o pacote completo. Confere tudo de novo (o valor do documento pode ter mudado
// depois do pacote) e devolve no formato de entrada.lancar (para a rota registrar igual).
async function lancarDaEntrada(cred, cliente, d, contas, arquivo, nome, mime, hojeIso) {
  const c = conferirPacote(d, d.pagar, contas, hojeIso);
  if (c.erro) return { ok: false, incerto: false, msg: 'Lançamento completo não confere: ' + c.erro };
  const r = await lancarCompleto(cred, cliente, Object.assign({}, d, c.ok), arquivo, nome, mime, hojeIso);
  if (!r.ok) return r;
  const p0 = r.parcelas[0] || {};
  return { ok: true, conferido: r.conferido, anexado: r.anexado, etiqueta: r.etiqueta, id_despesa: r.id_despesa, id_parcela: p0.id_parcela || null, id_arquivo: r.id_arquivo,
    prova: Object.assign({}, p0.prova || {}, { rateio: r.rateio, parcelas: r.parcelas.length }), codigo_barras_gravado: p0.prova ? p0.prova.codigo_barras : null,
    parcelas: r.parcelas.map((p) => ({ id_parcela: p.id_parcela, vencimento: p.vencimento, valor_centavos: p.valor_centavos, remessa: p.remessa ? !!p.remessa.ok : null })),
    remessa: c.ok.remessa ? r.parcelas.every((p) => p.remessa && p.remessa.ok) : null, msg: r.msg };
}

module.exports = {
  OPERACOES_PAGAR, FORMA, NOME_FORMA, TIPO_PIX, NOME_TIPO_PIX, ETIQUETA_COMPROVANTE, MAX_PARCELAS,
  cpfValido, lerChavePix, crc16, lerPixCopiaCola, lerCodigo, dividir, conferirParcelas, conferirRateio, conferirPacote,
  corpoDespesaCompleta, provaParcela, lancarCompleto, motivoSemRemessa, naRemessa, liquidada, marcarRemessa,
  corpoFornecedor, conferirFornecedor, cadastrarFornecedor, decidirBaixa, corpoLiquidar, darBaixa,
  linhasDoPacote, lancarDaEntrada, camposTlv, provaRateio, pdfTexto, comprovanteRetorno, comprovanteExtrato, parcelaAtual, parcelasDaDespesa, cent, brl, dataBR, resultado, form,
};
