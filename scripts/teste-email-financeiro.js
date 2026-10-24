// Testes dos documentos do financeiro por EMAIL (financeiro/email-financeiro.js e
// servico/rotas-email-financeiro.js), sem rede: servidor IMAP dublado (mesma interface do
// imapflow), emails de verdade montados em MIME e lidos pelo mailparser, banco em memória no
// formato do PostgREST e Superlógica simulado.
// Uso: NODE_PATH=<repo>/node_modules node scripts/teste-email-financeiro.js
const E = require('../financeiro/entrada');
const EF = require('../financeiro/email-financeiro');
let ok = 0, falhou = 0;
function t(nome, cond) { if (cond) ok++; else { falhou++; console.log('FALHOU: ' + nome); } }

const SENHA = 'Senha#Secreta-Kinghost-9931';
const SENHA2 = 'OutraSenha!Muito$Grande77';
const CHAVE_ENV = 'chave-de-teste-com-mais-de-trinta-e-dois-caracteres-0123456789';
const ENV = { EMAIL_FINANCEIRO: 'on', EMAIL_FINANCEIRO_CHAVE: CHAVE_ENV };

// Tudo o que for escrito no console durante o teste (para conferir que a senha nunca aparece).
const saidaConsole = [];
const origLog = console.log, origWarn = console.warn, origErr = console.error;
const capturar = (f) => function () { saidaConsole.push([].slice.call(arguments).join(' ')); return f.apply(console, arguments); };
console.log = capturar(origLog); console.warn = capturar(origWarn); console.error = capturar(origErr);
const logLeitor = (m) => saidaConsole.push(m);

function cnpj(base12) {
  const dv = (b) => { const ps = b.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = b.split('').reduce((a, d, i) => a + +d * ps[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base12); return base12 + d1 + dv(base12 + d1);
}
// Chave da NF-e com o dígito calculado aqui (implementação independente da do sistema).
function chaveNfe(cnpjEmit, numero) {
  const c43 = '32' + '2610' + cnpjEmit + '55' + '001' + String(numero).padStart(9, '0') + '1' + '12345678';
  let soma = 0, peso = 2;
  for (let i = c43.length - 1; i >= 0; i--) { soma += +c43[i] * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = 11 - (soma % 11);
  return c43 + (r >= 10 ? 0 : r);
}
const C167 = cnpj('333333330001'), C136 = cnpj('444444440001'), C140 = cnpj('555555550001'), CFORN = cnpj('777777770001');
const K1 = chaveNfe(CFORN, 1234), K2 = chaveNfe(CFORN, 5678);
const fmt = E.formatarCnpj;

// ---------- arquivos de teste ----------
// PDF mínimo com texto de verdade (Helvetica), lido pelo mesmo leitor de PDF do sistema.
function pdfCom(linhas) {
  const txt = 'BT /F1 9 Tf 30 810 Td 12 TL ' + linhas.map((l) => '(' + l.replace(/[\\()]/g, '\\$&') + ') Tj T*').join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(txt, 'latin1') + ' >>\nstream\n' + txt + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const pos = [];
  objs.forEach((o, i) => { pos.push(Buffer.byteLength(out, 'latin1')); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + pos.map((p) => String(p).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}
const ENCHER = ['Documento emitido para pagamento de servicos prestados ao condominio no periodo informado abaixo',
  'Pagamento preferencialmente pelo aplicativo do banco ate a data de vencimento indicada neste documento',
  'Em caso de duvidas entre em contato com nosso atendimento comercial pelos canais informados'];
const boletoPdf = (pagador, valor, venc, extra) => pdfCom(ENCHER.concat([
  'Beneficiario Servicos Gerais Limpeza CNPJ ' + fmt(CFORN),
  pagador ? 'Pagador Condominio CNPJ ' + fmt(pagador) : 'Cliente final sem cadastro',
  'Vencimento ' + venc, 'Valor do documento R$ ' + valor, 'Numero do documento ' + (extra || 'A1'),
]));
const PDF_A = boletoPdf(C136, '350,00', '20/11/2026', 'A1');
const PDF_B = boletoPdf(null, '99,90', '21/11/2026', 'B2');
const PDF_D = boletoPdf(null, '410,00', '22/11/2026', 'D4');
const PDF_E = boletoPdf(null, '55,00', '23/11/2026', 'E5');
const danfe = (k, valor) => pdfCom(ENCHER.concat(['DANFE Documento auxiliar da nota fiscal eletronica', 'Chave de acesso ' + k.replace(/(\d{4})/g, '$1 ').trim(),
  'Emitente Servicos Gerais Limpeza CNPJ ' + fmt(CFORN), 'Destinatario Condominio CNPJ ' + fmt(C136)].concat(valor ? ['Valor total da nota R$ ' + valor] : [])));
const PDF_C = danfe(K1, '1.200,00');
const PDF_F = danfe(K2, null);
const xmlNfe = (k, valor, venc) => Buffer.from('<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe' + k + '" versao="4.00">' +
  '<ide><cUF>32</cUF><mod>55</mod><nNF>' + Number(k.slice(25, 34)) + '</nNF><dhEmi>2026-10-20T10:00:00-03:00</dhEmi></ide>' +
  '<emit><CNPJ>' + CFORN + '</CNPJ><xNome>SERVICOS GERAIS</xNome></emit><dest><CNPJ>' + C136 + '</CNPJ><xNome>CONDOMINIO</xNome></dest>' +
  '<total><ICMSTot><vNF>' + valor + '</vNF></ICMSTot></total><cobr><dup><nDup>001</nDup><dVenc>' + venc + '</dVenc><vDup>' + valor + '</vDup></dup></cobr>' +
  '</infNFe></NFe><protNFe><infProt><chNFe>' + k + '</chNFe></infProt></protNFe></nfeProc>', 'utf8');
const XML_1 = xmlNfe(K1, '1200.00', '2026-11-25');
const XML_2 = xmlNfe(K2, '777.70', '2026-11-26');
function png(largura, altura, tamanho) {
  const b = Buffer.alloc(tamanho, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(largura, 16); b.writeUInt32BE(altura, 20);
  return b;
}
function jpeg(largura, altura, tamanho) {
  const partes = [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')];
  let falta = tamanho - 200;
  while (falta > 0) { const n = Math.min(60000, falta); const s = Buffer.alloc(n + 4, 0x41); s[0] = 0xff; s[1] = 0xfe; s.writeUInt16BE(n + 2, 2); partes.push(s); falta -= n; }
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(altura, 5); sof.writeUInt16BE(largura, 7);
  partes.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(partes);
}
const LOGO = png(120, 40, 2048);
const BANNER = png(600, 90, 60 * 1024);
const FOTO = jpeg(1200, 900, 90 * 1024);

// Email MIME de verdade (lido pelo mailparser como no servidor).
function email({ de, assunto, corpo, anexos, data }) {
  const fr = 'limite' + Math.random().toString(16).slice(2);
  let s = 'From: ' + de + '\r\nTo: financeiro@condominioservice.com.br\r\nSubject: ' + assunto + '\r\nDate: ' + (data || 'Thu, 22 Oct 2026 10:00:00 -0300') +
    '\r\nMessage-ID: <' + Math.random().toString(16).slice(2) + '@teste>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="' + fr + '"\r\n\r\n';
  s += '--' + fr + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + (corpo || 'Segue em anexo.') + '\r\n';
  (anexos || []).forEach((a) => {
    s += '--' + fr + '\r\nContent-Type: ' + a.tipo + '; name="' + a.nome + '"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: ' + (a.inline ? 'inline' : 'attachment') + '; filename="' + a.nome + '"\r\n' +
      (a.inline ? 'Content-ID: <logo@assinatura>\r\n' : '') + '\r\n' + a.buf.toString('base64').replace(/(.{76})/g, '$1\r\n') + '\r\n';
  });
  return Buffer.from(s + '--' + fr + '--\r\n', 'utf8');
}
const pdfA = (nome, buf) => ({ tipo: 'application/pdf', nome, buf });

// ---------- servidor IMAP dublado (interface do imapflow) ----------
const servidorImap = { contas: {}, conexoes: 0, recusar: null, comandos: [] };
function conta(usuario, senha, pastas) { servidorImap.contas[usuario] = { senha, pastas }; }
class ImapDublado {
  constructor(op) { this.op = op; this.mailbox = null; this.lock = null; }
  on() { return this; }
  async connect() {
    servidorImap.conexoes++;
    if (servidorImap.recusar) { const e = new Error('connect ' + servidorImap.recusar); e.code = servidorImap.recusar; throw e; }
    const c = servidorImap.contas[this.op.auth.user];
    if (!c || c.senha !== this.op.auth.pass) { const e = new Error('Command failed: NO [AUTHENTICATIONFAILED] Invalid credentials for ' + this.op.auth.user + ' ' + this.op.auth.pass); e.authenticationFailed = true; throw e; }
    this.conta = c;
  }
  async getMailboxLock(pasta, o) {
    const p = this.conta.pastas[pasta];
    if (!p) { const e = new Error('Mailbox does not exist'); e.mailboxMissing = true; throw e; }
    this.pasta = p; this.readOnly = !!(o && o.readOnly);
    this.mailbox = { path: pasta, uidValidity: p.uidValidity, exists: p.msgs.length };
    servidorImap.comandos.push((this.readOnly ? 'EXAMINE ' : 'SELECT ') + pasta);
    return { release: () => {} };
  }
  async search(q) {
    const [ini] = String(q.uid).split(':');
    const uids = this.pasta.msgs.map((m) => m.uid);
    const desde = q.since ? q.since.getTime() : 0;
    let l = this.pasta.msgs.filter((m) => m.uid >= Number(ini) && m.data >= desde).map((m) => m.uid);
    // Igual ao IMAP: "N:*" com N maior que o último UID devolve o último.
    if (!l.length && uids.length && Number(ini) > Math.max(...uids)) l = [Math.max(...uids)];
    servidorImap.comandos.push('UID SEARCH ' + q.uid);
    return l;
  }
  async fetchOne(uid, q) {
    const m = this.pasta.msgs.find((x) => String(x.uid) === String(uid));
    if (!m) return false;
    servidorImap.comandos.push('UID FETCH ' + uid + (q.source ? ' BODY.PEEK[]' : ' RFC822.SIZE'));
    return q.source ? { uid: m.uid, source: m.raw } : { uid: m.uid, size: m.raw.length };
  }
  async messageFlagsAdd(uid, flags) {
    if (this.readOnly) throw new Error('pasta aberta só para leitura');
    const m = this.pasta.msgs.find((x) => String(x.uid) === String(uid));
    flags.forEach((f) => m.flags.add(f));
    servidorImap.comandos.push('UID STORE ' + uid + ' +FLAGS ' + flags.join(' '));
  }
  async logout() { servidorImap.comandos.push('LOGOUT'); }
  close() {}
}
const pasta = (uidValidity) => ({ uidValidity, msgs: [] });
function chega(p, uid, raw, dia) { p.msgs.push({ uid, raw, flags: new Set(), data: Date.parse(dia || '2026-10-22T12:00:00Z') }); }

// ---------- banco em memória no formato do PostgREST ----------
function bancoMemoria() {
  const tabelas = { fin_entrada: [], fin_email_caixas: [], fin_email_mensagens: [], profiles: [], auditoria: [] };
  const valorDe = (l, k) => { const p = k.split('->>'); let v = l[p[0]]; if (p[1]) v = v && typeof v === 'object' ? v[p[1]] : undefined; return v; };
  const txt = (v) => (v == null ? null : String(v));
  function casa(l, k, cond) {
    const v = valorDe(l, k);
    let neg = false;
    if (cond.startsWith('not.')) { neg = true; cond = cond.slice(4); }
    const i = cond.indexOf('.');
    const op = cond.slice(0, i), arg = cond.slice(i + 1);
    let r;
    if (op === 'eq') r = txt(v) === arg;
    else if (op === 'neq') r = txt(v) !== arg;
    else if (op === 'in') r = arg.replace(/^\(|\)$/g, '').split(',').includes(txt(v));
    else if (op === 'is') r = arg === 'null' ? v == null : arg === 'true' ? v === true : v === false;
    else if (op === 'lt') r = v != null && String(v) < arg;
    else if (op === 'gt') r = v != null && String(v) > arg;
    else throw new Error('operador ' + op);
    return neg ? !r : r;
  }
  function filtrar(linhas, q) {
    return linhas.filter((l) => {
      for (const [k, v] of q) {
        if (['select', 'order', 'limit'].includes(k)) continue;
        if (k === 'or') { const partes = v.replace(/^\(|\)$/g, '').split(','); if (!partes.some((p) => { const j = p.indexOf('.'); return casa(l, p.slice(0, j), p.slice(j + 1)); })) return false; continue; }
        if (!casa(l, k, v)) return false;
      }
      return true;
    });
  }
  const copia = (x) => JSON.parse(JSON.stringify(x));
  let seq = 0;
  async function banco(metodo, caminho, corpo) {
    const [rota, qs] = caminho.split('?');
    const tab = rota.replace('/rest/v1/', '');
    const q = [...new URLSearchParams(qs || '')];
    const linhas = tabelas[tab];
    if (!linhas) return { status: 404, body: null };
    const agora = new Date(Date.now() + (seq++)).toISOString();
    if (metodo === 'GET') {
      let l = filtrar(linhas, q);
      const ord = (q.find(([k]) => k === 'order') || [])[1];
      if (ord) { const [campo, dir] = ord.split('.'); l = l.slice().sort((a, b) => String(a[campo]).localeCompare(String(b[campo])) * (dir === 'desc' ? -1 : 1)); }
      const lim = Number((q.find(([k]) => k === 'limit') || [])[1] || 0);
      return { status: 200, body: copia(lim ? l.slice(0, lim) : l) };
    }
    if (metodo === 'POST') {
      const novos = (Array.isArray(corpo) ? corpo : [corpo]).map((c) => Object.assign({ criado_em: agora, atualizado_em: agora }, copia(c)));
      for (const n of novos) {
        if (tab === 'fin_entrada') {
          Object.assign(n, { id: n.id || require('crypto').randomUUID() });
          if (linhas.some((l) => l.status !== 'descartado' && l.hash_sha256 === n.hash_sha256)) return { status: 409, body: { code: '23505' } };
        }
        if (tab === 'fin_email_caixas') {
          n.id = n.id || require('crypto').randomUUID();
          if (linhas.some((l) => l.endereco.toLowerCase() === n.endereco.toLowerCase() && l.pasta.toLowerCase() === n.pasta.toLowerCase())) return { status: 409, body: { code: '23505' } };
          Object.assign(n, Object.assign({ falhas_seguidas: 0, lidos_total: 0, condominios: [] }, n));
        }
        if (tab === 'fin_email_mensagens' && linhas.some((l) => l.caixa_id === n.caixa_id && String(l.uid_validity) === String(n.uid_validity) && String(l.uid) === String(n.uid))) return { status: 409, body: { code: '23505' } };
        linhas.push(n);
      }
      return { status: 201, body: copia(novos) };
    }
    if (metodo === 'PATCH') {
      const l = filtrar(linhas, q);
      l.forEach((x) => Object.assign(x, copia(corpo)));
      return { status: 200, body: copia(l) };
    }
    if (metodo === 'DELETE') {
      const l = filtrar(linhas, q);
      tabelas[tab] = linhas.filter((x) => !l.includes(x));
      return { status: 200, body: copia(l) };
    }
    return { status: 400, body: null };
  }
  return { tabelas, banco };
}

// ---------- Superlógica simulado ----------
let slFora = false;
const cliSL = {
  async get(rota, p) {
    if (rota === 'condominios/get') {
      if (slFora) { const e = new Error('HTTP 503'); e.status = 503; throw e; }
      return p.pagina > 1 ? [] : [
        { id_condominio_cond: '167', st_fantasia_cond: 'Residencial Teste', id_planoconta_plc: '1', st_cnpj_cond: C167 },
        { id_condominio_cond: '136', st_fantasia_cond: 'Residencial Casablanca', id_planoconta_plc: '1', st_cnpj_cond: C136 },
        { id_condominio_cond: '140', st_fantasia_cond: 'Edificio Aurora', id_planoconta_plc: '1', st_cnpj_cond: C140 },
      ];
    }
    if (rota === 'fornecedores/index') return (p.pesquisa === CFORN || p.id === '10') ? [{ id_contato_con: '10', st_nome_con: 'SERVICOS GERAIS LIMPEZA', st_cgc_con: CFORN }] : [];
    if (rota === 'planocontas') return [{ st_conta_cont: '2.2', st_descricao_cont: 'Limpeza' }];
    if (rota === 'contabancos/index') return [{ id_condominio_cond: String(p.idCondominio), id_contabanco_cb: '823', fl_principal_cb: '1', st_descricao_cb: 'Conta movimento', dt_bloquearlancamentos_cb: '' }];
    return [];
  },
};

// ---------- 1. funções puras ----------
function testesPuros() {
  const id = '11111111-1111-4111-8111-111111111111';
  const c = EF.cifrar(SENHA, id, ENV);
  t('senha cifrada não contém a senha', !c.includes(SENHA) && c.startsWith('v1:'));
  t('senha abre com a mesma chave e caixa', EF.decifrar(c, id, ENV) === SENHA);
  t('senha não abre em outra caixa', EF.decifrar(c, '22222222-2222-4222-8222-222222222222', ENV) === null);
  t('senha não abre com outra chave', EF.decifrar(c, id, { EMAIL_FINANCEIRO_CHAVE: CHAVE_ENV + 'x' }) === null);
  let semChave = false; try { EF.cifrar(SENHA, id, { EMAIL_FINANCEIRO_CHAVE: 'curta' }); } catch (e) { semChave = e.code === 'sem_chave'; }
  t('chave curta ou ausente não cifra', semChave && EF.chaveDe({}) === null);
  t('leitor desligado por padrão', !EF.ligado({}) && !EF.ligado({ EMAIL_FINANCEIRO: 'off' }) && EF.ligado({ EMAIL_FINANCEIRO: 'on' }));
  t('servidores padrão da KingHost', EF.servidoresPermitidos({}).includes('imap.kinghost.net'));
  let v = EF.validarCaixa({ endereco: 'Fin@CondominioService.com.br', senha: SENHA }, null, ENV);
  t('caixa nova válida com padrões', v.ok && v.dados.servidor === 'imap.kinghost.net' && v.dados.porta === 993 && v.dados.usuario === 'fin@condominioservice.com.br' && v.dados.pasta === 'INBOX' && v.senha === SENHA && v.dados.ativo === false);
  t('caixa nova sem senha recusa', !EF.validarCaixa({ endereco: 'a@b.com.br' }, null, ENV).ok);
  t('servidor fora da lista recusa', !EF.validarCaixa({ endereco: 'a@b.com.br', senha: 'x', servidor: '127.0.0.1' }, null, ENV).ok && !EF.validarCaixa({ endereco: 'a@b.com.br', senha: 'x', servidor: 'localhost' }, null, ENV).ok);
  t('porta fora de 993 e 143 recusa', !EF.validarCaixa({ endereco: 'a@b.com.br', senha: 'x', porta: 5432 }, null, ENV).ok);
  t('por condomínio exige condomínio', !EF.validarCaixa({ endereco: 'a@b.com.br', senha: 'x', finalidade: 'condominio' }, null, ENV).ok &&
    EF.validarCaixa({ endereco: 'a@b.com.br', senha: 'x', finalidade: 'condominio', condominios: ['167', 136] }, null, ENV).dados.condominios.join() === '167,136');
  t('condomínio de fora da administração recusa', !EF.validarCaixa({ endereco: 'a@b.com.br', senha: 'x', finalidade: 'condominio', condominios: ['143'] }, null, ENV).ok);
  t('edição sem senha mantém a guardada', EF.validarCaixa({ ativo: true }, { endereco: 'a@b.com.br', servidor: 'imap.kinghost.net', porta: 993, usuario: 'a@b.com.br', pasta: 'INBOX', finalidade: 'geral', condominios: [] }, ENV).senha === null);
  const tela = EF.caixaParaTela({ id, endereco: 'a@b', senha_cifrada: c });
  t('tela só sabe que tem senha guardada', tela.senha_guardada === true && !('senha_cifrada' in tela) && !JSON.stringify(tela).includes(c));

  t('imagem: dimensões do PNG e do JPEG', EF.tipoImagem(LOGO).largura === 120 && EF.tipoImagem(FOTO).largura === 1200 && EF.tipoImagem(FOTO).altura === 900);
  const cls = EF.classificarAnexos([
    { filename: 'logo.png', contentType: 'image/png', content: LOGO, contentDisposition: 'inline', cid: 'logo' },
    { filename: 'banner.png', contentType: 'image/png', content: BANNER },
    { filename: 'foto.jpg', contentType: 'image/jpeg', content: FOTO },
    { filename: 'boleto.pdf', contentType: 'application/pdf', content: PDF_A },
    { filename: 'nota.xml', contentType: 'text/xml', content: XML_1 },
    { filename: 'outro.xml', contentType: 'text/xml', content: Buffer.from('<a>oi</a>') },
    { filename: 'planilha.xlsx', contentType: 'application/octet-stream', content: Buffer.alloc(5000) },
  ]);
  t('logo pequeno ignorado', !cls[0].usar && /pequena/.test(cls[0].motivo));
  t('imagem estreita ignorada mesmo grande', !cls[1].usar);
  t('foto grande usada', cls[2].usar && cls[2].mime === 'image/jpeg');
  t('PDF e XML da nota usados', cls[3].usar && cls[3].tipo === 'pdf' && cls[4].usar && cls[4].tipo === 'xml');
  t('XML que não é nota e outros tipos ignorados', !cls[5].usar && !cls[6].usar);
  const nx = EF.lerXmlNota(XML_1.toString());
  t('XML da NF-e lido', nx && nx.chave === K1 && nx.tomador === C136 && nx.emitente === CFORN && nx.valor === 1200 && nx.vencimento === '2026-11-25' && nx.emissao === '2026-10-20' && nx.numero === '1234');
  const cx = EF.camposDoXml(nx);
  t('XML no formato da leitura', cx.tipo === 'nota' && cx.cnpjs[0].papel === 'pagador' && cx.cnpjs[0].cnpj === C136 && cx.origem_valor === 'xml');
  t('chave da nota achada no texto com espaços', E.chaveNfeDoTexto('Chave de acesso\n' + K1.replace(/(\d{4})/g, '$1 ')) === K1);
  t('chave com dígito errado não vale', E.chaveNfeDoTexto(K1.slice(0, 43) + ((+K1[43] + 1) % 10)) === null);
  t('chave depois de outro número', E.chaveNfeDoTexto('Protocolo 123 ' + K1) === K1);
  t('resumo do corpo sem a conversa anterior', EF.resumoCorpo('Segue boleto de novembro.\n\nEm 20/10/2026 Fulano escreveu:\n> texto antigo') === 'Segue boleto de novembro.');
  const conds = [{ id: '167', nome: 'Residencial Teste' }, { id: '136', nome: 'Residencial Casablanca' }, { id: '140', nome: 'Edifício Aurora' }, { id: '141', nome: 'Aurora Park' }];
  t('nome do condomínio no assunto', (EF.sugerirCondominio({ conds, texto: 'Boleto do CONDOMÍNIO CASABLANCA outubro' }) || {}).id === '136');
  t('nome curto ou genérico não vale', EF.chaveNome('Residencial') === null && EF.chaveNome('Ed. Sol') === null);
  t('dois condomínios no texto: não escolhe', EF.sugerirCondominio({ conds, texto: 'Boletos Casablanca e Aurora' }) === null);
  t('nome mais longo ganha do contido nele', (EF.sugerirCondominio({ conds, texto: 'Boleto Aurora Park' }) || {}).id === '141');
  t('nome dentro da caixa', (EF.sugerirCondominio({ conds, candidatos: new Set(['140']), texto: 'Aurora boleto', idCaixa: null }) || {}).id === '140');
  t('remetente e caixa na ordem', EF.sugerirCondominio({ conds, texto: 'segue', idRemetente: '167', idCaixa: '136' }).por === 'remetente' && EF.sugerirCondominio({ conds, texto: 'segue', idCaixa: '136' }).por === 'caixa');
  t('erro de senha vira aviso sem o texto do servidor', EF.erroAmigavel({ authenticationFailed: true, message: 'NO ' + SENHA }) === 'O servidor recusou o usuário ou a senha.');
  t('erro de rede vira aviso', /não respondeu/.test(EF.erroAmigavel({ code: 'ETIMEDOUT' })) && /recusou a conexão/.test(EF.erroAmigavel({ code: 'ECONNREFUSED' })) && /pasta/.test(EF.erroAmigavel({ mailboxMissing: true })));
  const op = EF.criarLeitor({ banco: async () => ({ status: 200, body: [] }), abrirImap: () => null, env: ENV }).opcoesImap({ servidor: 'imap.kinghost.net', porta: 993, usuario: 'u' }, 'x');
  t('conexão com SSL na 993 e certificado conferido', op.secure === true && op.tls.servername === 'imap.kinghost.net' && op.logger === false && op.tls.rejectUnauthorized !== false);
}

// ---------- 2. leitor e rotas ----------
async function testesLeitor() {
  let express;
  try { express = require('express'); } catch (e) { console.log('AVISO: express não encontrado (use NODE_PATH)'); falhou++; return; }
  const { criarRotasEntrada } = require('../servico/rotas-entrada');
  const { criarRotasEmailFinanceiro } = require('../servico/rotas-email-financeiro');
  const mem = bancoMemoria();
  mem.tabelas.profiles.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nome: 'Analista Um', email: 'a1@example.com', role: 'OPERACIONAL', bloqueado: null });
  const eventos = [];
  const auditoria = { evento: (req, tipo, det) => eventos.push({ tipo, det: det || null }) };
  let usuario = { sub: 'gestor-1', email: 'gestor@example.com' }, papel = 'GESTOR', carteira = { todas: true };
  const internas = [];
  const processar = {
    async processarDocumentoFinanceiro(corpo) {
      internas.push(corpo.arquivo.mime);
      if (corpo.arquivo.mime === 'image/jpeg') return { status: 200, corpo: { tipo: 'boleto', valor: '88,00', vencimento: '28/11/2026', cnpj_pagador: C167, cnpj_beneficiario: CFORN } };
      return { status: 422, corpo: { erro: 'documento_ilegivel' } };
    },
  };
  const app = express();
  app.use((req, res, next) => { req.user = usuario; req.authMode = 'supabase'; next(); });
  const requireGestor = (req, res, next) => (papel === 'GESTOR' ? next() : res.status(403).json({ erro: 'acesso_negado' }));
  let liberado = '167';
  const gravados = [];
  const origLancar = E.lancar;
  E.lancar = async (cred, c, d, buf, nome, mime) => { gravados.push({ cond: d.id_superlogica, mime, nome }); return { ok: true, conferido: true, anexado: true, prova: {}, id_despesa: '9' + gravados.length, id_arquivo: '1', id_parcela: '2' }; };
  const entrada = criarRotasEntrada(app, {
    requireAuth: (req, res, next) => next(), express, banco: mem.banco, perfilDe: async () => ({ role: papel }),
    podeModulo: (p, m) => m === 'entrada_documentos', carteiraT18: { escopo: async () => carteira }, exigirLeituraSuperlogica: async () => true, superlogicaNativa: () => true,
    clienteSL: () => cliSL, credSL: () => ({}), dentroDoLimite: () => true, auditoria, processar, carteiraEstrita: async () => true,
  });
  const grupos = async () => [{ id: 5, nome: 'Carteira B', condominios: [136, 140] }, { id: 6, nome: 'Carteira C', condominios: [167] }];
  const leitorEnv = Object.assign({}, ENV);
  const leitor = EF.criarLeitor({
    banco: mem.banco, entrada, auditoria, gruposCarteiras: grupos, env: leitorEnv, log: logLeitor,
    abrirImap: (op) => new ImapDublado(op), parsear: (buf) => require('mailparser').simpleParser(buf, { skipImageLinks: true }),
    condominios: async () => [...(await E.cadastroCondominios(cliSL)).porId.values()],
  });
  criarRotasEmailFinanceiro(app, { requireAuth: (req, res, next) => next(), requireGestor, express, banco: mem.banco, leitor, auditoria, gruposCarteiras: grupos, env: leitorEnv });
  const srv = app.listen(0);
  const porta = srv.address().port;
  const respostas = [];
  const chama = async (m, url, corpo) => {
    const r = await fetch('http://127.0.0.1:' + porta + url, { method: m, headers: { 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
    const texto = await r.text();
    respostas.push(texto);
    let j = {}; try { j = JSON.parse(texto); } catch (e) { j = {}; }
    return { st: r.status, j, texto };
  };
  process.env.ENTRADA_LANCAMENTO_LIBERADO = '';
  try {
    // Caixas: 1 por condomínio (167), 2 por carteira (5: 136 e 140) marcando como lido, 3 com senha errada.
    const p1 = pasta(7n), p2 = pasta(9n), p3 = pasta(3n);
    conta('fin@condominioservice.com.br', SENHA, { INBOX: p1 });
    conta('carteirab@condominioservice.com.br', SENHA2, { INBOX: p2 });
    conta('errada@condominioservice.com.br', 'senha-certa-do-servidor', { INBOX: p3 });
    let r = await chama('POST', '/api/email-financeiro/caixas', { endereco: 'fin@condominioservice.com.br', senha: SENHA, finalidade: 'condominio', condominios: ['167'], analista: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ativo: true, ler_desde: '2026-10-01' });
    t('cria caixa', r.st === 200 && r.j.caixa && r.j.caixa.senha_guardada === true && r.j.caixa.finalidade === 'condominio');
    const id1 = r.j.caixa.id;
    t('banco guarda só a senha cifrada', mem.tabelas.fin_email_caixas[0].senha_cifrada && !JSON.stringify(mem.tabelas.fin_email_caixas).includes(SENHA));
    r = await chama('POST', '/api/email-financeiro/caixas', { endereco: 'carteirab@condominioservice.com.br', senha: SENHA2, finalidade: 'carteira', carteira: 5, ativo: true, marcar_lido: true });
    const id2 = r.j.caixa.id;
    r = await chama('POST', '/api/email-financeiro/caixas', { endereco: 'errada@condominioservice.com.br', senha: 'senha-errada', ativo: true });
    const id3 = r.j.caixa.id;
    r = await chama('POST', '/api/email-financeiro/caixas', { endereco: 'fin@condominioservice.com.br', senha: 'x' });
    t('mesma caixa e pasta duas vezes recusa', r.st === 409);
    papel = 'OPERACIONAL';
    r = await chama('GET', '/api/email-financeiro/caixas');
    const r2 = await chama('POST', '/api/email-financeiro/caixas', { endereco: 'x@condominioservice.com.br', senha: 'x' });
    t('só GESTOR vê e cadastra caixas', r.st === 403 && r2.st === 403);
    papel = 'GESTOR';
    r = await chama('GET', '/api/email-financeiro/caixas');
    t('lista de caixas sem senha', r.st === 200 && r.j.caixas.length === 3 && r.j.caixas.every((c) => !('senha_cifrada' in c) && c.senha_guardada) && r.j.ligado === true && r.j.chave_configurada === true &&
      r.j.analistas.length === 1 && r.j.carteiras.length === 2);
    r = await chama('PUT', '/api/email-financeiro/caixas/' + id1, { endereco: 'fin@condominioservice.com.br', finalidade: 'condominio', condominios: ['167'], analista: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ativo: true, ler_desde: '2026-10-01', senha: '' });
    t('editar sem senha mantém a guardada', r.st === 200 && EF.decifrar(mem.tabelas.fin_email_caixas.find((c) => c.id === id1).senha_cifrada, id1, ENV) === SENHA);
    r = await chama('POST', '/api/email-financeiro/testar', { id: id1 });
    t('testar conexão com a senha guardada', r.st === 200 && r.j.ok === true && /1|0/.test(String(r.j.mensagens)) && servidorImap.comandos.includes('EXAMINE INBOX'));
    r = await chama('POST', '/api/email-financeiro/testar', { id: id3 });
    t('testar com senha errada vira aviso', r.st === 200 && r.j.ok === false && r.j.detalhe === 'O servidor recusou o usuário ou a senha.');
    r = await chama('POST', '/api/email-financeiro/testar', { endereco: 'fin@condominioservice.com.br', senha: SENHA, pasta: 'Notas' });
    t('testar pasta que não existe vira aviso', r.st === 200 && r.j.ok === false && /pasta/.test(r.j.detalhe));
    servidorImap.recusar = 'ECONNREFUSED';
    r = await chama('POST', '/api/email-financeiro/testar', { id: id1 });
    servidorImap.recusar = null;
    t('servidor fora do ar vira aviso', r.st === 200 && r.j.ok === false && /recusou a conexão/.test(r.j.detalhe));

    // Emails da caixa 1.
    chega(p1, 3, email({ de: 'Velho <velho@fornecedor.com>', assunto: 'Antigo', anexos: [pdfA('antigo.pdf', PDF_E)] }), '2026-09-15T12:00:00Z'); // antes de "ler a partir de"
    chega(p1, 10, email({ de: 'Limpeza Ltda <cobranca@limpeza.com.br>', assunto: 'Boleto outubro', corpo: 'Segue o boleto.\n\nAtenciosamente\n--\nLimpeza Ltda', anexos: [pdfA('boleto.pdf', PDF_A), { tipo: 'image/png', nome: 'logo.png', buf: LOGO, inline: true }] }));
    chega(p1, 11, email({ de: 'Sindico <sindico@gmail.com>', assunto: 'ENC: Boleto outubro', anexos: [pdfA('boleto (1).pdf', PDF_A)] }));
    chega(p1, 12, email({ de: 'cobranca@limpeza.com.br', assunto: 'Cobrança', anexos: [pdfA('cobranca.pdf', PDF_B)] }));
    chega(p1, 13, email({ de: 'nfe@limpeza.com.br', assunto: 'NF-e 1234', anexos: [{ tipo: 'text/xml', nome: 'nfe1234.xml', buf: XML_1 }] }));
    chega(p1, 14, email({ de: 'nfe@limpeza.com.br', assunto: 'DANFE 1234', anexos: [pdfA('danfe1234.pdf', PDF_C)] }));
    chega(p1, 15, email({ de: 'porteiro@gmail.com', assunto: 'foto do boleto', anexos: [{ tipo: 'image/jpeg', nome: 'IMG_0001.jpg', buf: FOTO }] }));
    chega(p1, 16, email({ de: 'alguem@gmail.com', assunto: 'Bom dia', corpo: 'Sem anexo.' }));
    chega(p1, 17, email({ de: 'nfe@limpeza.com.br', assunto: 'NF-e 5678 com DANFE', anexos: [pdfA('danfe5678.pdf', PDF_F), { tipo: 'application/xml', nome: '5678.xml', buf: XML_2 }] }));
    // Caixa 2 (carteira B: 136 e 140).
    chega(p2, 50, email({ de: 'cobranca@limpeza.com.br', assunto: 'Boleto Residencial Casablanca novembro', anexos: [pdfA('casablanca.pdf', PDF_D)] }));
    chega(p2, 51, email({ de: 'outro@fornecedor.com', assunto: 'Boleto', anexos: [pdfA('semnome.pdf', PDF_E)] }));

    // Leitor desligado não roda.
    leitorEnv.EMAIL_FINANCEIRO = 'off';
    const antesConexoes = servidorImap.conexoes;
    const desl = await leitor.rodar();
    r = await chama('POST', '/api/email-financeiro/caixas/' + id1 + '/ler');
    const agendado = leitor.agendar(10);
    t('leitor desligado não roda nem conecta', desl.desligado === true && servidorImap.conexoes === antesConexoes && r.st === 423 && agendado === null && mem.tabelas.fin_entrada.length === 0);
    leitorEnv.EMAIL_FINANCEIRO = 'on';

    // Primeira leitura.
    const [rd1, rd2] = await Promise.all([leitor.rodar(), leitor.rodar()]);
    t('trava: uma leitura de cada vez', rd2.em_andamento === true && Array.isArray(rd1.resultados) && rd1.resultados.length === 3);
    const ent = mem.tabelas.fin_entrada;
    const por = (nome) => ent.find((l) => l.nome_arquivo === nome);
    const A = por('boleto.pdf'), B = por('cobranca.pdf'), X1 = por('nfe1234.xml'), FT = por('IMG_0001.jpg'), N2 = por('danfe5678.pdf'), D = por('casablanca.pdf'), SN = por('semnome.pdf');
    t('cria item por anexo', !!(A && B && X1 && FT && N2 && D && SN) && ent.length === 7);
    t('email antes da data escolhida não entra', !por('antigo.pdf'));
    t('item com a origem do email', A.origem && A.origem.tipo === 'email' && A.origem.caixa === 'fin@condominioservice.com.br' && A.origem.remetente === 'cobranca@limpeza.com.br' &&
      A.origem.remetente_nome === 'Limpeza Ltda' && A.origem.assunto === 'Boleto outubro' && A.origem.corpo === 'Segue o boleto. Atenciosamente' && A.origem.data === '2026-10-22T13:00:00.000Z' && A.criado_por === null);
    t('logo da assinatura ignorado', A.origem.anexos.length === 2 && A.origem.anexos.find((a) => a.nome === 'logo.png').usado === false && !por('logo.png'));
    t('condomínio pelo CNPJ do pagador (vale mais que a caixa)', A.id_superlogica === 136 && !A.dados.condominio_por && A.dados.valor === 350 && A.dados.id_fornecedor === '10');
    t('mesmo arquivo de novo vira um item só com aviso', ent.filter((l) => l.hash_sha256 === A.hash_sha256).length === 1 && A.dados.repeticoes.length === 1 &&
      A.dados.repeticoes[0].remetente === 'sindico@gmail.com' && A.alertas.some((a) => a.codigo === 'recebido_de_novo'));
    t('condomínio pela caixa sem CNPJ no documento', B.id_superlogica === 167 && B.dados.condominio_por === 'caixa' && B.alertas.some((a) => a.codigo === 'condominio_pelo_email' && a.nivel === 'grave'));
    t('XML da nota vira item com os dados do XML', X1.arquivo_mime === 'application/xml' && X1.leitura === 'xml' && X1.dados.chave_nfe === K1 && X1.id_superlogica === 136 && X1.dados.valor === 1200 && X1.dados.vencimento === '2026-11-25' && X1.tipo === 'nota');
    t('mesma nota (chave) em PDF depois vira repetição', !por('danfe1234.pdf') && X1.dados.repeticoes && X1.dados.repeticoes[0].motivo === 'mesma_nota');
    t('foto do boleto vira item pela leitura interna', FT.arquivo_mime === 'image/jpeg' && FT.leitura === 'interna' && FT.id_superlogica === 167 && internas.includes('image/jpeg'));
    t('PDF e XML da mesma nota viram um item só', N2.leitura.endsWith('+xml') && N2.dados.chave_nfe === K2 && N2.dados.valor === 777.7 && !por('5678.xml') && N2.origem.anexos.length === 2);
    t('nome do condomínio no assunto (dentro da carteira)', D.id_superlogica === 136 && D.dados.condominio_por === 'nome_no_email' && D.origem.carteira === 5);
    t('sem pista nenhuma fica sem condomínio', SN.id_superlogica === null && !SN.dados.condominio_por);
    const msgs = mem.tabelas.fin_email_mensagens;
    t('cada email guardado por UID', msgs.filter((m) => m.caixa_id === id1).length === 8 && msgs.find((m) => m.uid === 16).status === 'sem_anexo' && msgs.find((m) => m.uid === 11).entradas[0] === A.id);
    const c1 = mem.tabelas.fin_email_caixas.find((c) => c.id === id1), c2 = mem.tabelas.fin_email_caixas.find((c) => c.id === id2), c3 = mem.tabelas.fin_email_caixas.find((c) => c.id === id3);
    t('caixa guarda onde parou', c1.ultimo_uid === 17 && c1.uid_validity === '7' && !c1.ultimo_erro && c1.lendo_ate === null && c1.lidos_total === 8);
    t('senha errada vira aviso na caixa sem derrubar as outras', c3.ultimo_erro === 'O servidor recusou o usuário ou a senha.' && c3.falhas_seguidas === 1 && c2.ultimo_uid === 51);
    t('nunca apaga e só marca como lido quando pedido', p1.msgs.length === 9 && p1.msgs.every((m) => m.flags.size === 0) && p2.msgs.every((m) => m.flags.has('\\Seen')) &&
      !servidorImap.comandos.some((c) => /EXPUNGE|DELETE|MOVE|COPY/.test(c)) && servidorImap.comandos.includes('EXAMINE INBOX') && servidorImap.comandos.includes('SELECT INBOX'));

    // Segunda leitura: nada novo. Depois, a caixa "esquece" onde parou: os UIDs guardados seguram.
    await leitor.rodar();
    t('não duplica por UID', ent.length === 7 && A.dados.repeticoes.length === 1);
    c1.ultimo_uid = null;
    await leitor.rodar();
    t('não duplica pelos emails já guardados', ent.length === 7 && A.dados.repeticoes.length === 1 && X1.dados.repeticoes.length === 1 && c1.ultimo_uid === 17);

    // Falha passageira (Superlógica fora): o email fica para a próxima, sem avançar.
    chega(p1, 18, email({ de: 'cobranca@limpeza.com.br', assunto: 'Mais um', anexos: [pdfA('mais.pdf', boletoPdf(C167, '12,00', '29/11/2026', 'M1'))] }));
    E.limparCache(); slFora = true;
    await leitor.rodar();
    t('falha passageira não avança e avisa', !por('mais.pdf') && c1.ultimo_uid === 17 && /tenta de novo/.test(c1.ultimo_erro || '') && msgs.find((m) => m.uid === 18 && m.caixa_id === id1).status === 'erro');
    slFora = false; E.limparCache();
    await leitor.rodar();
    t('na próxima leitura o email entra', !!por('mais.pdf') && c1.ultimo_uid === 18 && !c1.ultimo_erro && msgs.find((m) => m.uid === 18 && m.caixa_id === id1).status === 'ok');
    // Caixa sendo lida por outro servidor: pula.
    c1.lendo_ate = new Date(Date.now() + 60000).toISOString();
    const pul = await leitor.lerCaixa(c1);
    c1.lendo_ate = null;
    t('trava no banco: caixa em leitura é pulada', pul.pulou === 'em_andamento');

    // Na entrada de documentos: origem na tela e o fluxo de sempre.
    r = await chama('GET', '/api/entrada/fila?status=rascunho');
    const naFila = (id) => (r.j.itens || []).find((x) => x.id === id) || {};
    t('fila mostra a origem e não o arquivo', r.st === 200 && naFila(A.id).origem.remetente === 'cobranca@limpeza.com.br' && !('arquivo_base64' in naFila(A.id)) && naFila(B.id).pronto_para_lote === false);
    r = await chama('GET', '/api/entrada/' + X1.id + '/pdf');
    t('XML aparece como texto puro', r.st === 200 && /<nfeProc/.test(r.texto));
    const rx = await fetch('http://127.0.0.1:' + porta + '/api/entrada/' + X1.id + '/pdf');
    t('XML servido como texto', /^text\/plain/.test(rx.headers.get('content-type')));
    // Analista com carteira: vê o documento sem condomínio da caixa da carteira dele; outro não.
    usuario = { sub: 'analista-2', email: 'a2@example.com' }; carteira = { todas: false, ids: new Set([140]), carteiras: [{ id: 5, nome: 'Carteira B' }] };
    r = await chama('GET', '/api/entrada/fila?status=rascunho');
    const ve = (r.j.itens || []).map((x) => x.id);
    t('carteira da caixa vê o documento sem condomínio', ve.includes(SN.id) && !ve.includes(A.id));
    carteira = { todas: false, ids: new Set([167]), carteiras: [{ id: 6, nome: 'Carteira C' }] };
    r = await chama('GET', '/api/entrada/fila?status=rascunho');
    t('outra carteira não vê', !(r.j.itens || []).some((x) => x.id === SN.id));
    usuario = { sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'a1@example.com' }; carteira = { todas: false, ids: new Set([999]), carteiras: [] };
    r = await chama('GET', '/api/entrada/' + B.id);
    t('carteira sem o condomínio identificado não vê, mesmo sendo o analista', r.st === 404);
    usuario = { sub: 'gestor-1', email: 'gestor@example.com' }; carteira = { todas: true };
    // Escolher o condomínio na tela tira a sugestão do email.
    r = await chama('PUT', '/api/entrada/' + B.id, { id_superlogica: '140' });
    t('condomínio escolhido na tela deixa de ser sugestão', r.st === 200 && !r.j.item.dados.condominio_por && !r.j.item.alertas.some((a) => a.codigo === 'condominio_pelo_email'));
    r = await chama('PUT', '/api/entrada/' + A.id, { complemento: 'teste' });
    t('aviso de repetição continua depois de editar', r.st === 200 && r.j.item.alertas.some((a) => a.codigo === 'recebido_de_novo'));
    // Lançamento continua com as travas: 136 fora da lista não lança; liberado lança o XML como XML.
    r = await chama('PUT', '/api/entrada/' + X1.id, { conta: '2.2', confirmar_valor: true, confirmar_vencimento: true });
    r = await chama('POST', '/api/entrada/' + X1.id + '/lancar', { confirmacao: 'LANCAR' });
    t('trava do condomínio continua valendo', r.st === 423 && gravados.length === 0);
    process.env.ENTRADA_LANCAMENTO_LIBERADO = '136';
    r = await chama('POST', '/api/entrada/' + X1.id + '/lancar', { confirmacao: 'LANCAR', aceitar_alertas: ['recebido_de_novo'] });
    t('XML da nota lançado com o próprio XML anexado', r.st === 200 && gravados.length === 1 && gravados[0].mime === 'application/xml' && gravados[0].cond === '136');
    E.lancar = origLancar;
    t('arquivo do XML com extensão .xml', E.nomeArquivoSeguro('nfe1234.xml', 'application/xml') === 'nfe1234.xml' && E.nomeArquivoSeguro('foto', 'image/jpeg') === 'foto.jpg' && E.nomeArquivoSeguro('a.pdf') === 'a.pdf');

    // Ler agora e mensagens.
    r = await chama('POST', '/api/email-financeiro/caixas/' + id1 + '/ler');
    t('ler agora com o leitor ligado', r.st === 200 && (r.j.iniciado || r.j.em_andamento));
    await new Promise((ok2) => setTimeout(ok2, 200));
    while (leitor.emAndamento()) await new Promise((ok2) => setTimeout(ok2, 100));
    r = await chama('GET', '/api/email-financeiro/caixas/' + id1 + '/mensagens');
    t('emails lidos da caixa', r.st === 200 && r.j.mensagens.length === 9 && r.j.mensagens.every((m) => !('senha_cifrada' in m)));
    r = await chama('GET', '/api/email-financeiro/caixas');
    t('aviso de falha na tela de caixas', r.j.caixas.find((c) => c.id === id3).ultimo_erro === 'O servidor recusou o usuário ou a senha.' && r.j.caixas.find((c) => c.id === id1).ultimo_teste.ok === false);
    r = await chama('POST', '/api/email-financeiro/caixas/' + id3 + '/remover', {});
    const r3 = await chama('POST', '/api/email-financeiro/caixas/' + id3 + '/remover', { confirmacao: 'REMOVER' });
    t('remover pede confirmação', r.st === 400 && r3.st === 200 && !mem.tabelas.fin_email_caixas.some((c) => c.id === id3));
    // Sem a chave de cifra: não salva senha nem lê.
    delete leitorEnv.EMAIL_FINANCEIRO_CHAVE;
    r = await chama('POST', '/api/email-financeiro/caixas', { endereco: 'nova@condominioservice.com.br', senha: 'qualquer' });
    t('sem a chave de cifra não salva', r.st === 503 && !mem.tabelas.fin_email_caixas.some((c) => c.endereco === 'nova@condominioservice.com.br'));
    const semCh = await leitor.lerCaixa(mem.tabelas.fin_email_caixas.find((c) => c.id === id1));
    t('sem a chave de cifra a leitura vira aviso', /chave de cifra/.test(semCh.erro || ''));
    leitorEnv.EMAIL_FINANCEIRO_CHAVE = CHAVE_ENV;

    // Senha nunca aparece em resposta, log, auditoria ou origem dos itens.
    const tudo = respostas.join('\n') + '\n' + saidaConsole.join('\n') + '\n' + JSON.stringify(eventos) + '\n' + JSON.stringify(mem.tabelas.fin_entrada.map((l) => [l.origem, l.dados, l.alertas])) + JSON.stringify(mem.tabelas.fin_email_mensagens);
    t('senha nunca aparece em resposta, log ou auditoria', !tudo.includes(SENHA) && !tudo.includes(SENHA2) && !tudo.includes('senha-errada') && !tudo.includes('senha-certa-do-servidor'));
    t('senha cifrada também nunca sai', !respostas.join('\n').includes(mem.tabelas.fin_email_caixas[0].senha_cifrada.split(':')[3]));
  } finally { srv.close(); E.lancar = origLancar; delete process.env.ENTRADA_LANCAMENTO_LIBERADO; }
}

(async () => {
  testesPuros();
  await testesLeitor();
  console.log = origLog;
  console.log('email financeiro: ' + ok + ' ok, ' + falhou + ' falhou');
  process.exit(falhou ? 1 : 0);
})().catch((e) => { console.log = origLog; console.log('ERRO ' + (e && e.stack)); process.exit(1); });
