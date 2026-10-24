// Documentos do financeiro chegando por EMAIL: o Hub lê as caixas de email do financeiro (IMAP),
// baixa os anexos (PDF, XML da nota e fotos) e cria um item na entrada de documentos (T33) para
// cada documento, com a origem (caixa, remetente, assunto, data e corpo resumido). Daí em diante é
// o fluxo de sempre: leitura, sugestão do lançamento, conferência e gravação com as travas.
//
// Regras deste arquivo:
// - A senha da caixa fica CIFRADA no banco (AES 256 GCM, chave EMAIL_FINANCEIRO_CHAVE do ambiente)
//   e só é aberta aqui, na hora de conectar. Nunca vai para a tela, para o log ou para o banco aberta.
// - Nunca apaga, move nem expurga email no servidor. Marca como lido só se a caixa pedir.
// - Cada email processado fica guardado por caixa + UIDVALIDITY + UID (fin_email_mensagens) e a
//   caixa guarda até onde leu: o mesmo email nunca vira item duas vezes.
// - Mesmo arquivo (hash) ou mesma nota (chave de acesso) chegando de novo vira um item só, com aviso.
// - Leitor desligado por padrão (EMAIL_FINANCEIRO=on liga) e com trava: uma leitura de cada vez.
// Funções puras testadas em scripts/teste-email-financeiro.js (com servidor IMAP dublado).

const crypto = require('crypto');
const E = require('./entrada');

const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGEM_BYTES = 7 * 1024 * 1024;
const IMAGEM_MIN_BYTES = 40 * 1024;      // menor que isso é assinatura, logo ou ícone
const IMAGEM_MIN_LADO = 400;             // foto de boleto tem pelo menos 400 pixels no menor lado
const IMAGEM_INLINE_MIN_BYTES = 150 * 1024; // imagem dentro do corpo (assinatura) só conta se for grande
const MAX_POR_RODADA = 25;               // emails por caixa em cada leitura (o resto fica para a próxima)
const MAX_TENTATIVAS = 3;
const TRAVA_MS = 15 * 60 * 1000;
const SERVIDORES_PADRAO = ['imap.kinghost.net', 'imap.uni5.net', 'imap.condominioservice.com.br'];

const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// ---------- ligado ou desligado ----------
function ligado(env) { return String((env || process.env).EMAIL_FINANCEIRO || 'off').trim().toLowerCase() === 'on'; }
// Servidores IMAP que podem ser cadastrados (evita o servidor conectar em endereço interno).
function servidoresPermitidos(env) {
  const v = String((env || process.env).EMAIL_FINANCEIRO_SERVIDORES || '').trim();
  const l = v ? v.split(/[\s,;]+/) : SERVIDORES_PADRAO;
  return [...new Set(l.map((x) => x.toLowerCase()).filter((x) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x)))];
}

// ---------- senha cifrada ----------
// A chave vem do ambiente (pelo menos 32 caracteres; gerar com "openssl rand -base64 48").
// O id da caixa entra como dado autenticado: a senha de uma caixa não abre em outra.
function chaveDe(env) {
  const s = String((env || process.env).EMAIL_FINANCEIRO_CHAVE || '');
  if (s.length < 32) return null;
  return crypto.createHash('sha256').update('hub-email-financeiro:' + s).digest();
}
function cifrar(texto, idCaixa, env) {
  const k = chaveDe(env);
  if (!k) { const e = new Error('sem_chave'); e.code = 'sem_chave'; throw e; }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from('caixa:' + idCaixa, 'utf8'));
  const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return 'v1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + ct.toString('base64');
}
function decifrar(valor, idCaixa, env) {
  const k = chaveDe(env);
  const p = String(valor || '').split(':');
  if (!k || p.length !== 4 || p[0] !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(p[1], 'base64'));
    d.setAAD(Buffer.from('caixa:' + idCaixa, 'utf8'));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

// ---------- cadastro da caixa ----------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>"']{1,100}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
// Confere e normaliza o que veio da tela. atual: a caixa já gravada (edição) ou null (nova).
// Devolve { ok: true, dados, senha } (senha só quando foi digitada) ou { ok: false, detalhe }.
function validarCaixa(b, atual, env) {
  const x = b || {};
  const ruim = (detalhe) => ({ ok: false, detalhe });
  const o = {};
  const pega = (k) => (x[k] !== undefined ? x[k] : atual ? atual[k] : undefined);
  const endereco = limpar(pega('endereco')).toLowerCase();
  if (!EMAIL.test(endereco) || endereco.length > 200) return ruim('Endereço de email inválido.');
  o.endereco = endereco;
  const servidor = limpar(pega('servidor') || 'imap.kinghost.net').toLowerCase();
  if (!servidoresPermitidos(env).includes(servidor)) return ruim('Servidor não permitido. Use um destes: ' + servidoresPermitidos(env).join(', ') + '.');
  o.servidor = servidor;
  const porta = Number(pega('porta') == null || pega('porta') === '' ? 993 : pega('porta'));
  if (![993, 143].includes(porta)) return ruim('Porta inválida: use 993 (SSL) ou 143 (com STARTTLS).');
  o.porta = porta;
  const usuario = limpar(pega('usuario') || endereco);
  if (!usuario || usuario.length > 200 || /[\r\n]/.test(usuario)) return ruim('Usuário inválido.');
  o.usuario = usuario;
  const finalidade = String(pega('finalidade') || 'geral');
  if (!['geral', 'carteira', 'condominio'].includes(finalidade)) return ruim('Finalidade inválida.');
  o.finalidade = finalidade;
  const carteira = pega('carteira');
  o.carteira = carteira == null || carteira === '' ? null : Number(carteira);
  if (o.carteira != null && !(Number.isInteger(o.carteira) && o.carteira > 0 && o.carteira < 1e9)) return ruim('Carteira inválida.');
  if (finalidade === 'carteira' && !o.carteira) return ruim('Escolha a carteira desta caixa.');
  const analista = pega('analista');
  o.analista = analista ? String(analista) : null;
  if (o.analista && !UUID.test(o.analista)) return ruim('Analista inválido.');
  const conds = pega('condominios');
  const lista = Array.isArray(conds) ? conds : String(conds || '').split(/[\s,;]+/);
  o.condominios = [...new Set(lista.map((v) => String(v).trim()).filter(Boolean))];
  if (o.condominios.some((v) => !/^[1-9]\d{0,8}$/.test(v) || E.NAO_CONDOMINIOS.has(v)) || o.condominios.length > 200) return ruim('Lista de condomínios inválida.');
  o.condominios = o.condominios.map(Number);
  if (finalidade === 'condominio' && !o.condominios.length) return ruim('Escolha pelo menos um condomínio desta caixa.');
  const pasta = limpar(pega('pasta') || 'INBOX');
  if (pasta.length > 200 || /[\r\n"\\*%]/.test(pasta)) return ruim('Pasta inválida.');
  o.pasta = pasta;
  o.ativo = pega('ativo') === true;
  o.marcar_lido = pega('marcar_lido') === true;
  const desde = pega('ler_desde');
  o.ler_desde = desde ? String(desde).slice(0, 10) : null;
  if (o.ler_desde && !E.brParaIso(o.ler_desde.split('-').reverse().join('/'))) return ruim('Data inválida em "ler a partir de".');
  let senha = null;
  if (typeof x.senha === 'string' && x.senha !== '') {
    if (x.senha.length > 300 || /[\r\n]/.test(x.senha)) return ruim('Senha inválida.');
    senha = x.senha;
  }
  if (!atual && !senha) return ruim('Informe a senha da caixa.');
  return { ok: true, dados: o, senha };
}
// O que a tela vê da caixa: nunca a senha (nem cifrada), só se tem senha guardada.
function caixaParaTela(c) {
  if (!c) return null;
  const campos = ['id', 'criado_em', 'atualizado_em', 'endereco', 'servidor', 'porta', 'usuario', 'finalidade', 'carteira', 'analista', 'condominios', 'pasta', 'ativo',
    'marcar_lido', 'ler_desde', 'ultimo_uid', 'ultima_leitura', 'ultimo_sucesso', 'ultimo_erro', 'ultimo_erro_em', 'falhas_seguidas', 'lidos_total', 'ultimo_teste'];
  const o = {};
  campos.forEach((k) => { o[k] = c[k] === undefined ? null : c[k]; });
  o.senha_guardada = !!c.senha_cifrada;
  o.lendo = !!(c.lendo_ate && Date.parse(c.lendo_ate) > Date.now());
  return o;
}

// ---------- mensagens de erro (nunca o texto cru do servidor) ----------
function erroAmigavel(e) {
  const c = String((e && e.code) || '');
  if (e && e.authenticationFailed) return 'O servidor recusou o usuário ou a senha.';
  if (e && (e.mailboxMissing || /NONEXISTENT/i.test(String(e.serverResponseCode || '')))) return 'A pasta informada não existe nesta caixa.';
  if (/^(ENOTFOUND|EAI_AGAIN)$/.test(c)) return 'Servidor de email não encontrado. Confira o endereço do servidor.';
  if (c === 'ECONNREFUSED') return 'O servidor recusou a conexão nessa porta.';
  if (/TIMEOUT|TIMEDOUT/i.test(c) || c === 'tempo') return 'O servidor de email não respondeu a tempo.';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i.test(c)) return 'O certificado do servidor não confere com o endereço. Use imap.kinghost.net.';
  if (c === 'sem_chave') return 'A chave de cifra das senhas não está configurada no servidor.';
  if (c === 'senha_ilegivel') return 'Não deu para abrir a senha guardada. Salve a senha da caixa de novo.';
  if (/^(ECONNRESET|EPIPE|NoConnection|ClosedAfterConnect)$/i.test(c)) return 'A conexão com o servidor de email caiu.';
  return 'Não foi possível ler a caixa agora.';
}
// Código curto para o log (nunca mensagem do servidor, que pode repetir o usuário).
function codigoErro(e) { return String((e && (e.authenticationFailed ? 'auth' : e.code)) || 'erro').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'erro'; }

// ---------- anexos ----------
// Largura e altura de JPEG e PNG pelo cabeçalho (sem biblioteca de imagem). null se não der.
function tipoImagem(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return { mime: 'image/png', largura: buf.readUInt32BE(16), altura: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const tam = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: 'image/jpeg', altura: buf.readUInt16BE(i + 5), largura: buf.readUInt16BE(i + 7) };
      if (tam < 2) break;
      i += 2 + tam;
    }
    return { mime: 'image/jpeg', largura: null, altura: null };
  }
  return null;
}
const NOTA_XML = /<(?:\w+:)?(nfeProc|NFe|infNFe|CompNfse|Nfse|NFSe|infNFSe|DPS)\b/;
// Decide o que fazer com cada anexo do email. Devolve a lista com tipo (pdf, xml, imagem),
// usar (true/false) e o motivo de ignorar, para aparecer na origem do item.
function classificarAnexos(lista) {
  return (Array.isArray(lista) ? lista : []).map((a) => {
    const buf = Buffer.isBuffer(a && a.content) ? a.content : Buffer.alloc(0);
    const nome = limpar((a && a.filename) || '').replace(/[\r\n\t]/g, ' ').slice(0, 150) || 'anexo';
    const ct = String((a && a.contentType) || '').toLowerCase();
    const base = { nome, tamanho: buf.length, buf };
    if (E.ehPdf(buf)) {
      if (buf.length > E.MAX_PDF_BYTES) return Object.assign(base, { tipo: 'pdf', usar: false, motivo: 'PDF maior que 10 MB' });
      return Object.assign(base, { tipo: 'pdf', mime: 'application/pdf', usar: true });
    }
    if (/\.xml$/i.test(nome) || /xml/.test(ct)) {
      if (buf.length > MAX_XML_BYTES) return Object.assign(base, { tipo: 'xml', usar: false, motivo: 'XML maior que 2 MB' });
      const texto = buf.toString('utf8').replace(/^\uFEFF/, '');
      if (!NOTA_XML.test(texto)) return Object.assign(base, { tipo: 'xml', usar: false, motivo: 'XML que não é nota fiscal' });
      return Object.assign(base, { tipo: 'xml', mime: 'application/xml', usar: true, texto });
    }
    const img = tipoImagem(buf);
    if (img) {
      const inline = (a && (a.contentDisposition === 'inline' || a.related === true || a.cid)) && !/attachment/i.test(String((a && a.contentDisposition) || ''));
      const lado = img.largura && img.altura ? Math.min(img.largura, img.altura) : null;
      if (buf.length > MAX_IMAGEM_BYTES) return Object.assign(base, { tipo: 'imagem', usar: false, motivo: 'imagem maior que 7 MB' });
      if (buf.length < IMAGEM_MIN_BYTES || (lado != null && lado < IMAGEM_MIN_LADO) || (inline && buf.length < IMAGEM_INLINE_MIN_BYTES)) {
        return Object.assign(base, { tipo: 'imagem', usar: false, motivo: 'imagem pequena (assinatura ou logo)' });
      }
      return Object.assign(base, { tipo: 'imagem', mime: img.mime, usar: true });
    }
    return Object.assign(base, { tipo: 'outro', usar: false, motivo: 'tipo de arquivo não lido' });
  });
}

// ---------- XML da nota ----------
// Expressões com limite de tamanho e sem varredura repetida: XML vem de fora (remetente qualquer)
// e não pode travar o servidor com um arquivo montado para isso.
function tag(xml, nome) {
  const m = String(xml || '').match(new RegExp('<(?:\\w{1,20}:)?' + nome + '(?:\\s[^<>]{0,500})?>([^<]{0,200})</(?:\\w{1,20}:)?' + nome + '>', 'i'));
  return m ? m[1].trim() : null;
}
// Conteúdo do primeiro bloco <nome>...</nome>: acha a abertura e depois o fechamento (uma passada).
function bloco(xml, nome) {
  const x = String(xml || '');
  const ab = new RegExp('<(?:\\w{1,20}:)?' + nome + '(?:\\s[^<>]{0,500})?>', 'i').exec(x);
  if (!ab) return null;
  const ini = ab.index + ab[0].length;
  const fe = new RegExp('</(?:\\w{1,20}:)?' + nome + '>', 'i').exec(x.slice(ini, ini + 200000));
  return fe ? x.slice(ini, ini + fe.index) : null;
}
const docDoBloco = (b) => (b ? soDig(tag(b, 'CNPJ') || tag(b, 'Cnpj') || '') : '');
const numeroXml = (v) => { const n = Number(String(v || '').replace(',', '.')); return isFinite(n) && n > 0 && n < 1e9 ? Math.round(n * 100) / 100 : null; };
const dataXml = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? E.brParaIso(m[3] + '/' + m[2] + '/' + m[1]) : null; };
// Lê o XML da NF-e (modelo 55 ou 65) ou da NFS-e (padrão nacional ou ABRASF) só com expressões
// (sem leitor de XML: nada de entidade externa). Devolve null quando não é nota.
function lerXmlNota(texto) {
  const x = String(texto || '');
  if (!NOTA_XML.test(x)) return null;
  const ch = (x.match(/<(?:\w+:)?chNFe>\s*(\d{44})\s*</) || x.match(/Id="NFe(\d{44})"/) || [])[1] || null;
  const chave = ch && E.chaveNfeValida(ch) ? ch : null;
  const ehNfe = !!chave || /<(?:\w+:)?infNFe\b/.test(x);
  let emitente, tomador, valor, numero, emissao, vencimento = null;
  if (ehNfe) {
    emitente = docDoBloco(bloco(x, 'emit'));
    tomador = docDoBloco(bloco(x, 'dest'));
    valor = numeroXml(tag(bloco(x, 'ICMSTot') || '', 'vNF'));
    const fat = bloco(x, 'fat');
    const liq = fat ? numeroXml(tag(fat, 'vLiq')) : null;
    if (liq) valor = liq;
    numero = tag(bloco(x, 'ide') || '', 'nNF');
    emissao = dataXml(tag(bloco(x, 'ide') || '', 'dhEmi') || tag(bloco(x, 'ide') || '', 'dEmi'));
    const dup = bloco(x, 'dup');
    if (dup) vencimento = dataXml(tag(dup, 'dVenc'));
  } else {
    emitente = docDoBloco(bloco(x, 'prest') || bloco(x, 'emit') || bloco(x, 'PrestadorServico') || bloco(x, 'Prestador'));
    tomador = docDoBloco(bloco(x, 'toma') || bloco(x, 'TomadorServico') || bloco(x, 'Tomador'));
    valor = numeroXml(tag(x, 'vLiq') || tag(x, 'ValorLiquidoNfse') || tag(x, 'vServ') || tag(x, 'ValorServicos'));
    numero = tag(x, 'nNFSe') || tag(x, 'Numero');
    emissao = dataXml(tag(x, 'dhEmi') || tag(x, 'DataEmissao') || tag(x, 'dhProc'));
  }
  return {
    modelo: ehNfe ? 'nfe' : 'nfse', chave, numero: numero ? String(numero).replace(/^0+(?=\d)/, '').slice(0, 25) : null,
    emitente: E.cnpjValido(emitente) ? emitente : null, tomador: E.cnpjValido(tomador) ? tomador : null, valor, emissao, vencimento,
  };
}
// No formato de lerCampos (financeiro/entrada.js): tomador é o pagador, emitente o beneficiário.
function camposDoXml(info) {
  const cnpjs = [];
  if (info.tomador) cnpjs.push({ cnpj: info.tomador, papel: 'pagador', ordem: 0 });
  if (info.emitente && info.emitente !== info.tomador) cnpjs.push({ cnpj: info.emitente, papel: 'beneficiario', ordem: cnpjs.length });
  return { tipo: 'nota', valor: info.valor, origem_valor: info.valor ? 'xml' : null, vencimento: info.vencimento, origem_vencimento: info.vencimento ? 'xml' : null,
    emissao: info.emissao, documento: info.numero, linha: null, barras: null, especie_linha: null, cnpjs };
}
// PDF (DANFE) com o XML da mesma nota: o XML completa o que o PDF não trouxe e manda nos CNPJs;
// valor e vencimento da linha digitável conferida continuam valendo (boleto junto da nota).
function juntarComXml(pdf, xml) {
  if (!pdf) return xml;
  const o = E.juntarLeituras(xml, pdf, false);
  if (pdf.origem_valor === 'linha') { o.valor = pdf.valor; o.origem_valor = 'linha'; }
  if (pdf.origem_vencimento === 'linha') { o.vencimento = pdf.vencimento; o.origem_vencimento = 'linha'; }
  if (pdf.especie_linha) o.tipo = pdf.tipo;
  return o;
}
// Qual XML do email é do PDF lido: a chave aparece no texto, ou é o único PDF com o único XML.
function xmlDoPdf(xmls, textoPdf, parUnico) {
  const livres = (xmls || []).filter((x) => x && x.info && !x.usado);
  const dig = soDig(textoPdf);
  const porChave = livres.find((x) => x.info.chave && dig.includes(x.info.chave));
  if (porChave) return porChave;
  return parUnico && livres.length === 1 ? livres[0] : null;
}

// ---------- texto do email ----------
// Texto do HTML do email (quando não veio parte em texto). Corta script, style e head numa passada
// só (indexOf), sem expressão que volte atrás: HTML de fora não trava o servidor.
function semBlocos(h) {
  const baixo = h.toLowerCase();
  const re = /<(script|style|head)\b/g;
  let out = '', i = 0, m;
  while ((m = re.exec(baixo))) {
    out += h.slice(i, m.index) + ' ';
    const fe = baixo.indexOf('</' + m[1], re.lastIndex);
    if (fe < 0) return out;
    const gt = baixo.indexOf('>', fe);
    i = gt < 0 ? h.length : gt + 1;
    re.lastIndex = i;
  }
  return out + h.slice(i);
}
function htmlParaTexto(html) {
  return semBlocos(String(html || '').slice(0, 300000)).replace(/<br\s{0,5}\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^<>]{0,2000}>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}
// Corpo sem a conversa anterior (linhas citadas, "Em ... escreveu:") e sem a assinatura, até 500 caracteres.
function resumoCorpo(texto) {
  const linhas = String(texto || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of linhas) {
    if (/^\s*>/.test(l)) continue;
    if (/^--\s*$/.test(l) || /^\s*(Em .{4,120}escreveu:|On .{4,120}wrote:|-{2,}\s*Mensagem original|De:\s.+|From:\s.+)\s*$/i.test(l)) break;
    out.push(l);
  }
  return limpar(out.join(' ')).slice(0, 500);
}
// Origem guardada no item da entrada (só o necessário para conferir de onde veio).
function montarOrigem(caixa, uidValidity, uid, parsed, anexos) {
  const p = parsed || {};
  const de = (p.from && Array.isArray(p.from.value) && p.from.value[0]) || {};
  const data = p.date instanceof Date && !isNaN(p.date) ? p.date.toISOString() : null;
  return {
    tipo: 'email', caixa_id: caixa.id, caixa: caixa.endereco, uid: String(uid), uid_validity: String(uidValidity),
    message_id: limpar(p.messageId).slice(0, 200) || null,
    remetente: limpar(de.address).toLowerCase().slice(0, 200) || null, remetente_nome: limpar(de.name).slice(0, 120) || null,
    assunto: limpar(p.subject).slice(0, 200) || null, data,
    corpo: resumoCorpo(p.text || htmlParaTexto(p.html)) || null,
    analista: caixa.analista || null, carteira: caixa.carteira || null, finalidade: caixa.finalidade || 'geral',
    anexos: (anexos || []).slice(0, 30).map((a) => ({ nome: a.nome, tipo: a.tipo, tamanho: a.tamanho, usado: !!a.usar, motivo: a.motivo || null })),
  };
}

// ---------- condomínio pelo email ----------
const GENERICAS = new Set(['condominio', 'condominios', 'cond', 'edificio', 'ed', 'residencial', 'res', 'resid', 'associacao', 'assoc', 'conjunto', 'do', 'da', 'de', 'dos', 'das', 'e', 'o', 'a', 'em', 'no', 'na', 'spe', 'ltda']);
function normalizar(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function semGenericas(s) { return normalizar(s).split(' ').filter((w) => w && !GENERICAS.has(w)).join(' '); }
// Chave do nome do condomínio para procurar no assunto e no corpo. Nome curto ou genérico demais
// não vale (daria condomínio errado).
function chaveNome(nome) {
  const k = semGenericas(nome);
  const ws = k.split(' ').filter(Boolean);
  if (!ws.length || !ws.some((w) => w.length >= 4 && /[a-z]/.test(w))) return null;
  if (ws.length === 1 && ws[0].length < 6) return null;
  return k.length >= 5 ? k : null;
}
// Sugere o condomínio quando o documento não tem CNPJ de condomínio. Ordem: nome citado no email
// (só um condomínio pode casar; o nome mais longo ganha de um contido nele), remetente com
// lançamentos anteriores em um só condomínio, e a caixa ligada a um só condomínio. candidatos:
// condomínios da caixa ou da carteira dela (Set de códigos em texto) ou null (todos).
function sugerirCondominio({ conds, candidatos, texto, idRemetente, idCaixa }) {
  const lista = (conds || []).filter((c) => c && c.id && (!candidatos || candidatos.has(String(c.id))));
  const t = ' ' + semGenericas(texto) + ' ';
  let achados = lista.map((c) => ({ c, k: chaveNome(c.nome) })).filter((x) => x.k && t.includes(' ' + x.k + ' '));
  achados = achados.filter((x) => !achados.some((y) => y !== x && y.k.length > x.k.length && (' ' + y.k + ' ').includes(' ' + x.k + ' ')));
  const ids = [...new Set(achados.map((x) => String(x.c.id)))];
  if (ids.length === 1) return { id: ids[0], por: 'nome_no_email' };
  const existe = (id) => id && lista.some((c) => String(c.id) === String(id));
  if (ids.length === 0 && existe(idRemetente)) return { id: String(idRemetente), por: 'remetente' };
  if (ids.length === 0 && existe(idCaixa)) return { id: String(idCaixa), por: 'caixa' };
  return null;
}

// ---------- leitor ----------
// d: { banco, entrada (criarRascunho, acharRepetido, registrarRepeticao), abrirImap(opcoes) -> cliente
// no formato do imapflow, parsear(buf) -> email no formato do mailparser, condominios() -> [{id,nome}],
// gruposCarteiras() -> [{id, condominios}], auditoria, env, log }.
function criarLeitor(d) {
  const env = () => d.env || process.env;
  const log = d.log || ((m) => console.log(m));
  let rodando = false;
  const agoraIso = () => new Date().toISOString();
  const REQ = { authMode: 'sistema', user: { sub: null, email: null }, headers: {}, socket: {}, method: 'SISTEMA', originalUrl: '/sistema/email-financeiro' };

  // Abre a conexão. A senha só existe aqui, dentro das opções do cliente IMAP.
  function opcoesImap(c, senha) {
    return {
      host: c.servidor, port: Number(c.porta), secure: Number(c.porta) === 993, doSTARTTLS: Number(c.porta) === 143,
      auth: { user: c.usuario, pass: senha }, logger: false, emitLogs: false, disableAutoIdle: true,
      connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 120000, maxLiteralSize: MAX_EMAIL_BYTES + 1024 * 1024,
      tls: { servername: c.servidor, minVersion: 'TLSv1.2' },
    };
  }
  async function conectar(c, senha) {
    const cli = d.abrirImap(opcoesImap(c, senha));
    if (cli && typeof cli.on === 'function') cli.on('error', (e) => log('[email-financeiro] conexão: ' + codigoErro(e)));
    await cli.connect();
    return cli;
  }
  function fechar(cli) { try { if (cli && typeof cli.close === 'function') cli.close(); } catch (e) { /* já fechada */ } }
  const comTempo = (p, ms) => Promise.race([p, new Promise((_, nao) => setTimeout(() => { const e = new Error('tempo'); e.code = 'tempo'; nao(e); }, ms).unref())]);

  // Testa usuário, senha e pasta sem ler nada (pasta aberta só para leitura).
  async function testar(c, senha) {
    let cli = null;
    try {
      cli = await comTempo(conectar(c, senha), 30000);
      const trava = await comTempo(cli.getMailboxLock(c.pasta || 'INBOX', { readOnly: true }), 20000);
      const total = cli.mailbox && cli.mailbox.exists != null ? Number(cli.mailbox.exists) : null;
      try { trava.release(); } catch (e) { /* nada */ }
      try { await comTempo(cli.logout(), 5000); } catch (e) { /* nada */ }
      return { ok: true, em: agoraIso(), mensagens: total, detalhe: 'Conectou. A pasta ' + (c.pasta || 'INBOX') + ' tem ' + (total == null ? 'emails' : total + ' email(s)') + '.' };
    } catch (e) {
      log('[email-financeiro] teste da caixa ' + (c.id || 'nova') + ' falhou: ' + codigoErro(e));
      return { ok: false, em: agoraIso(), detalhe: erroAmigavel(e) };
    } finally { fechar(cli); }
  }

  async function patchCaixa(id, campos, filtroExtra) {
    return d.banco('PATCH', '/rest/v1/fin_email_caixas?id=eq.' + id + (filtroExtra || '') + '&select=id', Object.assign({ atualizado_em: agoraIso() }, campos));
  }
  async function mensagemFeita(caixaId, uv, uid) {
    const r = await d.banco('GET', '/rest/v1/fin_email_mensagens?select=status,tentativas&caixa_id=eq.' + caixaId + '&uid_validity=eq.' + encodeURIComponent(uv) + '&uid=eq.' + uid + '&limit=1');
    if (r.status !== 200) throw Object.assign(new Error('banco_' + r.status), { code: 'banco' });
    return Array.isArray(r.body) && r.body[0] ? r.body[0] : null;
  }
  async function gravarMensagem(caixaId, uv, uid, campos, existe) {
    const corpo = Object.assign({ atualizado_em: agoraIso() }, campos);
    if (existe) return d.banco('PATCH', '/rest/v1/fin_email_mensagens?caixa_id=eq.' + caixaId + '&uid_validity=eq.' + encodeURIComponent(uv) + '&uid=eq.' + uid, corpo);
    return d.banco('POST', '/rest/v1/fin_email_mensagens', Object.assign({ caixa_id: caixaId, uid_validity: uv, uid }, corpo));
  }
  // Remetente com lançamentos anteriores em um só condomínio.
  async function condominioDoRemetente(remetente) {
    if (!remetente) return null;
    const r = await d.banco('GET', '/rest/v1/fin_entrada?select=id_superlogica&status=eq.lancado&origem->>remetente=eq.' + encodeURIComponent(remetente) + '&limit=50');
    if (r.status !== 200 || !Array.isArray(r.body)) return null;
    const ids = [...new Set(r.body.map((x) => x.id_superlogica).filter(Boolean).map(String))];
    return ids.length === 1 ? ids[0] : null;
  }
  async function candidatosDaCaixa(c) {
    if (c.finalidade === 'condominio' && Array.isArray(c.condominios) && c.condominios.length) return new Set(c.condominios.map(String));
    if (c.finalidade === 'carteira' && c.carteira && d.gruposCarteiras) {
      try {
        const g = (await d.gruposCarteiras()).find((x) => Number(x.id) === Number(c.carteira));
        if (g && Array.isArray(g.condominios) && g.condominios.length) return new Set(g.condominios.map(String));
      } catch (e) { /* sem a carteira, procura em todos */ }
    }
    return null;
  }

  // Um email: cada documento vira um item (ou uma repetição de item que já existe).
  async function processarMensagem(c, uv, uid, parsed) {
    const anexos = classificarAnexos(parsed && parsed.attachments);
    const origem = montarOrigem(c, uv, uid, parsed, anexos);
    const usar = anexos.filter((a) => a.usar);
    if (!usar.length) return { status: 'sem_anexo', entradas: [], repetidos: 0, origem };
    let sugestao;
    const sugerir = async () => {
      if (sugestao !== undefined) return sugestao;
      const candidatos = await candidatosDaCaixa(c);
      const idCaixa = c.finalidade === 'condominio' && Array.isArray(c.condominios) && c.condominios.length === 1 ? String(c.condominios[0]) : null;
      let conds = [];
      try { conds = await d.condominios(); } catch (e) { conds = []; }
      const texto = (origem.assunto || '') + ' ' + String((parsed && (parsed.text || htmlParaTexto(parsed.html))) || '').slice(0, 4000);
      sugestao = sugerirCondominio({ conds, candidatos, texto, idRemetente: await condominioDoRemetente(origem.remetente).catch(() => null), idCaixa });
      return sugestao;
    };
    const xmls = usar.filter((a) => a.tipo === 'xml').map((a) => Object.assign(a, { info: lerXmlNota(a.texto) })).filter((a) => a.info);
    const pdfs = usar.filter((a) => a.tipo === 'pdf');
    const imagens = usar.filter((a) => a.tipo === 'imagem');
    const entradas = [];
    let repetidos = 0;
    // Repetição de verdade só conta quando é outro email (a nova tentativa do mesmo email não conta).
    const repetir = async (linha, motivo) => { entradas.push(linha.id); if (await d.entrada.registrarRepeticao(linha, origem, motivo)) repetidos++; };
    // Documento: confere o mesmo arquivo antes de ler; a mesma nota é conferida na leitura.
    const um = async (doc, extra) => {
      const hash = E.hashDe(doc.buf);
      const ja = await d.entrada.acharRepetido({ hash });
      if (ja) return repetir(ja, 'mesmo_arquivo');
      if (extra && extra.chave) {
        const jc = await d.entrada.acharRepetido({ chave: extra.chave });
        if (jc) return repetir(jc, 'mesma_nota');
      }
      const r = await d.entrada.criarRascunho(Object.assign({ buf: doc.buf, nome: doc.nome, mime: doc.mime, esc: null, usuario: null, req: REQ, origem, sugerir, deduplicarChave: true }, extra || {}));
      if (r.xmlUsado) r.xmlUsado.usado = true;
      if (r.repetidoDe) return repetir(r.repetidoDe, 'mesma_nota');
      if (r.conflito) { const j2 = await d.entrada.acharRepetido({ hash }); if (j2) return repetir(j2, 'mesmo_arquivo'); throw new Error('conflito'); }
      entradas.push(r.linha.id);
    };
    for (const p of pdfs) await um(p, { xmls, parUnico: pdfs.length === 1 && xmls.length === 1 });
    for (const x of xmls.filter((y) => !y.usado)) await um(x, { xml: x, chave: x.info.chave });
    for (const i of imagens) await um(i, null);
    return { status: 'ok', entradas, repetidos, origem };
  }

  // Lê uma caixa: emails novos por UID, um de cada vez. Falha passageira para a caixa sem avançar
  // (tenta de novo na próxima leitura, até 3 vezes por email); nunca derruba o servidor.
  async function lerCaixa(c) {
    const resumo = { caixa: c.id, novos: 0, itens: 0, repetidos: 0, erro: null };
    const tr = await patchCaixa(c.id, { lendo_ate: new Date(Date.now() + TRAVA_MS).toISOString() }, '&or=(lendo_ate.is.null,lendo_ate.lt.' + encodeURIComponent(agoraIso()) + ')');
    if (tr.status !== 200 || !Array.isArray(tr.body) || !tr.body[0]) return Object.assign(resumo, { pulou: 'em_andamento' });
    let cli = null, trava = null, cursor = null, uv = null, avisoEmail = null;
    try {
      if (!c.senha_cifrada) throw Object.assign(new Error('sem senha'), { code: 'senha_ilegivel' });
      if (!chaveDe(env())) throw Object.assign(new Error('sem chave'), { code: 'sem_chave' });
      const senha = decifrar(c.senha_cifrada, c.id, env());
      if (senha == null) throw Object.assign(new Error('senha'), { code: 'senha_ilegivel' });
      cli = await comTempo(conectar(c, senha), 30000);
      trava = await comTempo(cli.getMailboxLock(c.pasta || 'INBOX', { readOnly: !c.marcar_lido }), 20000);
      uv = String(cli.mailbox && cli.mailbox.uidValidity != null ? cli.mailbox.uidValidity : '0');
      const mesmaValidade = c.uid_validity && String(c.uid_validity) === uv;
      const ultimo = mesmaValidade ? Number(c.ultimo_uid || 0) : 0;
      cursor = ultimo;
      // Primeira leitura: a partir da data escolhida. UIDVALIDITY mudou (caixa recriada): só os
      // dois últimos dias antes da última leitura boa (o mesmo arquivo de novo vira repetição).
      let desde = c.ler_desde || null;
      if (c.uid_validity && !mesmaValidade) desde = c.ultimo_sucesso ? new Date(Date.parse(c.ultimo_sucesso) - 2 * 86400000).toISOString().slice(0, 10) : c.ler_desde || null;
      const busca = { uid: (ultimo + 1) + ':*' };
      if (desde) busca.since = new Date(desde + 'T00:00:00-03:00');
      const achados = (await comTempo(cli.search(busca, { uid: true }), 60000)) || [];
      const uids = [...new Set(achados.map(Number))].filter((u) => u > ultimo).sort((a, b) => a - b).slice(0, MAX_POR_RODADA);
      for (const uid of uids) {
        const feita = await mensagemFeita(c.id, uv, uid);
        if (feita && feita.status !== 'erro') { cursor = uid; continue; }
        const info = await comTempo(cli.fetchOne(String(uid), { uid: true, size: true }, { uid: true }), 60000);
        if (!info) { cursor = uid; continue; }
        if (Number(info.size) > MAX_EMAIL_BYTES) {
          await gravarMensagem(c.id, uv, uid, { status: 'ignorado', detalhe: { motivo: 'email maior que 25 MB' } }, !!feita);
          avisoEmail = 'Um email maior que 25 MB foi pulado.';
          cursor = uid; continue;
        }
        let r;
        try {
          const m = await comTempo(cli.fetchOne(String(uid), { uid: true, source: true }, { uid: true }), 120000);
          const parsed = await d.parsear(m && m.source);
          r = await processarMensagem(c, uv, uid, parsed);
        } catch (e) {
          const tentativas = (feita ? Number(feita.tentativas) || 0 : 0) + 1;
          const falhou = tentativas >= MAX_TENTATIVAS;
          await gravarMensagem(c.id, uv, uid, { status: falhou ? 'falhou' : 'erro', tentativas, detalhe: { erro: codigoErro(e) } }, !!feita).catch(() => null);
          log('[email-financeiro] email ' + uid + ' da caixa ' + c.id + ' não foi lido (' + codigoErro(e) + ', tentativa ' + tentativas + ')');
          if (!falhou) { avisoEmail = 'Um email não pôde ser lido agora; o Hub tenta de novo na próxima leitura.'; break; }
          avisoEmail = 'Um email não pôde ser lido depois de ' + MAX_TENTATIVAS + ' tentativas e foi pulado.';
          cursor = uid; continue;
        }
        await gravarMensagem(c.id, uv, uid, { status: r.status, tentativas: (feita ? Number(feita.tentativas) || 0 : 0) + 1, entradas: r.entradas,
          message_id: r.origem.message_id, remetente: r.origem.remetente, assunto: r.origem.assunto, recebido_em: r.origem.data,
          detalhe: { repetidos: r.repetidos, anexos: r.origem.anexos.length } }, !!feita);
        if (c.marcar_lido) { try { await comTempo(cli.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }), 30000); } catch (e) { log('[email-financeiro] não marcou como lido: ' + codigoErro(e)); } }
        if (r.entradas.length && d.auditoria) d.auditoria.evento(REQ, 'email_documentos', { caixa: c.id, itens: r.entradas.length, repetidos: r.repetidos });
        cursor = uid; resumo.novos++; resumo.itens += r.entradas.length - r.repetidos; resumo.repetidos += r.repetidos;
      }
      try { trava.release(); } catch (e) { /* nada */ }
      trava = null;
      try { await comTempo(cli.logout(), 5000); } catch (e) { /* nada */ }
      await patchCaixa(c.id, { uid_validity: uv, ultimo_uid: cursor, ultima_leitura: agoraIso(), ultimo_sucesso: agoraIso(), ultimo_erro: avisoEmail, ultimo_erro_em: avisoEmail ? agoraIso() : null,
        falhas_seguidas: 0, lidos_total: (Number(c.lidos_total) || 0) + resumo.novos, lendo_ate: null });
      resumo.aviso = avisoEmail;
    } catch (e) {
      resumo.erro = erroAmigavel(e);
      log('[email-financeiro] leitura da caixa ' + c.id + ' falhou: ' + codigoErro(e));
      const campos = { ultima_leitura: agoraIso(), ultimo_erro: resumo.erro, ultimo_erro_em: agoraIso(), falhas_seguidas: (Number(c.falhas_seguidas) || 0) + 1, lendo_ate: null };
      if (uv && cursor != null) Object.assign(campos, { uid_validity: uv, ultimo_uid: cursor });
      await patchCaixa(c.id, campos).catch(() => null);
    } finally {
      if (trava) { try { trava.release(); } catch (e) { /* nada */ } }
      fechar(cli);
    }
    return resumo;
  }

  async function caixasAtivas(id) {
    const r = await d.banco('GET', '/rest/v1/fin_email_caixas?select=*&ativo=eq.true' + (id ? '&id=eq.' + id : '') + '&order=criado_em.asc&limit=50');
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('banco_' + r.status);
    return r.body;
  }
  // Uma leitura de todas as caixas ativas (ou de uma). Trava: se já está lendo, não começa outra.
  async function rodar(id) {
    if (!ligado(env())) return { desligado: true };
    if (rodando) return { em_andamento: true };
    rodando = true;
    const resultados = [];
    try {
      for (const c of await caixasAtivas(id)) {
        try { resultados.push(await lerCaixa(c)); } catch (e) { log('[email-financeiro] caixa ' + c.id + ': ' + codigoErro(e)); }
      }
    } catch (e) { log('[email-financeiro] não deu para listar as caixas: ' + codigoErro(e)); return { erro: true, resultados }; }
    finally { rodando = false; }
    return { resultados };
  }
  // A cada 5 minutos, só com EMAIL_FINANCEIRO=on. Primeira leitura 2 minutos depois de ligar.
  function agendar(ms) {
    if (!ligado(env())) { log('[email-financeiro] leitor desligado (EMAIL_FINANCEIRO=off)'); return null; }
    const passo = ms || 5 * 60 * 1000;
    const t1 = setTimeout(() => { rodar().catch(() => null); }, Math.min(passo, 2 * 60 * 1000));
    const t2 = setInterval(() => { rodar().catch(() => null); }, passo);
    if (t1.unref) t1.unref();
    if (t2.unref) t2.unref();
    log('[email-financeiro] leitor ligado, a cada ' + Math.round(passo / 60000) + ' minuto(s)');
    return { parar: () => { clearTimeout(t1); clearInterval(t2); } };
  }
  return { rodar, lerCaixa, testar, agendar, processarMensagem, emAndamento: () => rodando, opcoesImap };
}

module.exports = {
  MAX_EMAIL_BYTES, IMAGEM_MIN_BYTES, IMAGEM_MIN_LADO, SERVIDORES_PADRAO,
  ligado, servidoresPermitidos, chaveDe, cifrar, decifrar, validarCaixa, caixaParaTela, erroAmigavel, codigoErro,
  tipoImagem, classificarAnexos, lerXmlNota, camposDoXml, juntarComXml, xmlDoPdf, htmlParaTexto, resumoCorpo, montarOrigem,
  normalizar, chaveNome, sugerirCondominio, criarLeitor,
};
