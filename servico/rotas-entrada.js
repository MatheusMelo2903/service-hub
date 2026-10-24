// T33: rotas da entrada de documentos (substitui o Paybox). Módulo "entrada_documentos" com as
// ações ver (subir, ler, editar e descartar rascunhos) e lancar (aprovar e criar a despesa).
// Leitura no Superlógica só GET; gravação só em POST /api/entrada/:id/lancar e no lote
// (T40: POST /api/entrada/lancar-lote), com a trava do condomínio (ENTRADA_LANCAMENTO_LIBERADO,
// padrão só o 167), carteira conferida sem folga, limite por hora, auditoria e o rascunho marcado
// "incerto" antes de gravar (nunca lança duas vezes).
// T40: valor e vencimento só passam com confiança alta (linha digitável conferida) ou confirmados
// na tela; mês fechado no Superlógica recusa; fora da lista o botão gera o rascunho conferido
// (POST /api/entrada/:id/pronto) para lançar no Superlógica.
// Documentos que chegam por email (financeiro/email-financeiro.js) entram pelo mesmo caminho
// (criarRascunho, devolvido por criarRotasEntrada) com a origem guardada: caixa, remetente,
// assunto, data e corpo resumido. Mesmo arquivo ou mesma nota chegando de novo vira repetição.
// Textos de tela sem citar leitura automática por fornecedor externo.

const E = require('../financeiro/entrada');
const EF = require('../financeiro/email-financeiro');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMPOS_LISTA = 'id,criado_em,atualizado_em,criado_por,criado_por_email,status,nome_arquivo,tamanho,leitura,tipo,id_superlogica,cond_documento,dados,alertas,id_despesa,id_parcela,id_arquivo,lancado_em,resultado,origem,arquivo_mime';
const MIMES = ['application/pdf', 'application/xml', 'image/jpeg', 'image/png'];
const hojeBR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

function criarRotasEntrada(app, d) {
  const { requireAuth, express, banco, perfilDe, podeModulo, carteiraT18, exigirLeituraSuperlogica, superlogicaNativa,
    clienteSL, credSL, dentroDoLimite, auditoria, processar, carteiraEstrita } = d;
  const emCurso = new Set();

  async function exigir(req, res, acao) {
    if (req.authMode !== 'internal') {
      let p = null;
      try { p = await perfilDe(req); } catch (e) { p = null; }
      if (!podeModulo(p, 'entrada_documentos', acao)) {
        res.status(403).json({ erro: 'acesso_negado', detalhe: acao === 'lancar' ? 'Seu usuário não pode lançar despesas por aqui.' : 'Seu usuário não tem acesso a esta aba.' });
        return false;
      }
    }
    return exigirLeituraSuperlogica(req, res);
  }
  // null = vê todos; Set de códigos (texto) = só esses. Erro ao ler a carteira recusa.
  // carteiras: códigos das carteiras de quem vê (documento de email ainda sem condomínio).
  async function escopo(req, res) {
    try {
      const e = await carteiraT18.escopo(req);
      return { escopo: e.todas ? null : new Set([...(e.ids || [])].map(String)), carteiras: new Set((e.carteiras || []).map((c) => String(c && c.id != null ? c.id : c))) };
    } catch (e) {
      res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora.' });
      return null;
    }
  }
  // Documento de email ainda sem condomínio: vê quem é o analista da caixa ou tem a carteira dela.
  const daMinhaCaixa = (req, linha, cart) => {
    const o = linha.origem;
    if (!o || o.tipo !== 'email' || linha.id_superlogica != null) return false;
    return !!((o.analista && req.user && o.analista === req.user.sub) || (o.carteira != null && cart && cart.has(String(o.carteira))));
  };
  const visivel = (req, esc, linha, cart) => !esc || (req.user && linha.criado_por === req.user.sub) || (linha.id_superlogica != null && esc.has(String(linha.id_superlogica))) || daMinhaCaixa(req, linha, cart);
  // Alertas gravados trazem dados de outros condomínios e de outros rascunhos. Para quem tem
  // carteira: boleto em outro condomínio de fora da carteira vira só "outro condomínio" (sem
  // fornecedor, documento, valor, despesa); na fila, só a quantidade.
  function mascararAlertas(alertas, esc) {
    if (!Array.isArray(alertas)) return [];
    return alertas.map((a) => {
      if (!a || !Array.isArray(a.itens)) return a;
      if (a.codigo === 'na_fila') return Object.assign({}, a, { itens: esc ? [] : a.itens, quantidade: a.itens.length });
      if (a.codigo === 'outro_condominio' && esc) {
        return Object.assign({}, a, { itens: a.itens.map((x) => (x && x.id_superlogica && esc.has(String(x.id_superlogica)) ? x
          : { condominio: 'outro condomínio', vencimento: x && x.vencimento ? x.vencimento : null })) });
      }
      return a;
    });
  }
  // Esconde o condomínio que não é da carteira de quem vê (vale para itens de alerta também).
  function paraTela(linha, esc) {
    const o = Object.assign({}, linha);
    delete o.arquivo_base64; delete o.hash_sha256;
    o.alertas = mascararAlertas(o.alertas, esc);
    if (esc && o.cond_documento != null && !esc.has(String(o.cond_documento))) o.cond_documento = null;
    if (esc && o.dados && o.dados.cond_documento != null && !esc.has(String(o.dados.cond_documento))) o.dados = Object.assign({}, o.dados, { cond_documento: null });
    // T40: o que a tela precisa para o botão (lançar ou gerar rascunho) e para o lote.
    const al = Array.isArray(o.alertas) ? o.alertas : [];
    o.liberado = E.lancamentoLiberado(o.id_superlogica);
    o.confianca = E.confianca(o.dados || {});
    o.pronto_para_lote = o.status === 'rascunho' && !al.some((a) => a && (a.nivel === 'impede' || a.nivel === 'grave' || E.FORA_DO_LOTE.includes(a.codigo)));
    return o;
  }
  // Valor e vencimento que a própria linha digitável traz (conferida pelos dígitos).
  function valoresDaLinha(dados) {
    const l = dados.linha ? E.acharLinha(String(dados.linha).replace(/[^\d]/g, ''), hojeBR()) : null;
    dados.valor_linha = l && l.valor ? l.valor : null;
    dados.vencimento_linha = l && l.vencimento ? l.vencimento : null;
  }
  // Para chamar as conferências que respondem direto (carteira) sem ter um res de verdade (lote).
  function resFalso() {
    const o = { headersSent: false, st: 200, j: null };
    o.status = (s) => { o.st = s; return o; };
    o.json = (j) => { o.j = j; o.headersSent = true; return o; };
    o.set = () => o;
    return o;
  }
  const quem = (req) => (req.user && (req.user.email || req.user.sub)) || 'interno';
  async function lerLinha(id) {
    const r = await banco('GET', '/rest/v1/fin_entrada?id=eq.' + id + '&select=*');
    if (r.status !== 200) throw new Error('banco_' + r.status);
    return Array.isArray(r.body) && r.body[0] ? r.body[0] : null;
  }
  async function naFila(dados, idAtual) {
    if (!dados.linha) return [];
    const r = await banco('GET', '/rest/v1/fin_entrada?select=id,status,nome_arquivo,criado_em&status=neq.descartado&dados->>linha=eq.' + encodeURIComponent(dados.linha) + (idAtual ? '&id=neq.' + idAtual : '') + '&limit=5');
    return r.status === 200 && Array.isArray(r.body) ? r.body : [];
  }
  async function conferirDados(dados, esc, idAtual, semCache) {
    const fila = await naFila(dados, idAtual).catch(() => []);
    const c = await E.conferir(clienteSL(), dados, { escopo: esc, naFila: fila, hojeIso: hojeBR(), semCache: !!semCache });
    const rep = Array.isArray(dados.repeticoes) ? dados.repeticoes.length : 0;
    if (rep) c.alertas.push(alertaRepeticao(rep));
    if (!dados.conta && c.sugestao_conta) {
      dados.conta = c.sugestao_conta.conta; dados.nome_conta = c.sugestao_conta.nome; dados.conta_sugerida = true;
      dados.conta_sugerida_vezes = c.sugestao_conta.vezes ? c.sugestao_conta.vezes + ' de ' + c.sugestao_conta.de : null;
    }
    if (c.conta_banco) { dados.id_contabanco = c.conta_banco.id; dados.nome_contabanco = c.conta_banco.nome; dados.bloqueio_contas = c.conta_banco.bloqueio || null; }
    return c.alertas.filter((a) => !(a.codigo === 'sem_conta' && dados.conta));
  }
  function alertaRepeticao(n) {
    return { codigo: 'recebido_de_novo', nivel: 'aviso', texto: 'Este mesmo documento chegou de novo por email (' + n + (n === 1 ? ' vez' : ' vezes') + '). Ficou um item só.' };
  }
  // Documento de email que já está na fila (mesmo arquivo ou mesma nota): fica um item só, com a
  // repetição anotada. O mesmo email lido de novo (nova tentativa) não conta como repetição.
  async function registrarRepeticao(linha, origem, motivo) {
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const atual = tentativa === 0 && linha.dados && linha.atualizado_em ? linha : await lerLinha(linha.id);
      if (!atual) return false;
      const o0 = atual.origem || {};
      const mesmo = (o) => o && o.caixa_id === origem.caixa_id && String(o.uid) === String(origem.uid) && String(o.uid_validity) === String(origem.uid_validity);
      const dados = Object.assign({}, atual.dados || {});
      const reps = Array.isArray(dados.repeticoes) ? dados.repeticoes.slice() : [];
      if (mesmo(o0) || reps.some(mesmo)) return false;
      reps.push({ motivo, caixa_id: origem.caixa_id, caixa: origem.caixa, uid: origem.uid, uid_validity: origem.uid_validity, remetente: origem.remetente, assunto: origem.assunto, data: origem.data, em: new Date().toISOString() });
      dados.repeticoes = reps.slice(-20);
      const alertas = (Array.isArray(atual.alertas) ? atual.alertas : []).filter((a) => !(a && a.codigo === 'recebido_de_novo')).concat([alertaRepeticao(dados.repeticoes.length)]);
      const up = await banco('PATCH', '/rest/v1/fin_entrada?id=eq.' + atual.id + '&atualizado_em=eq.' + encodeURIComponent(atual.atualizado_em) + '&select=id', { dados, alertas, atualizado_em: new Date().toISOString() });
      if (up.status === 200 && Array.isArray(up.body) && up.body[0]) return true;
      linha = { id: atual.id }; // mudou no meio: relê e tenta de novo
    }
    throw new Error('repeticao_concorrente');
  }
  // Item que não foi descartado com o mesmo arquivo (hash) ou a mesma nota (chave de acesso).
  async function acharRepetido({ hash, chave }) {
    const filtro = hash ? '&hash_sha256=eq.' + encodeURIComponent(hash) : chave && /^\d{44}$/.test(chave) ? '&dados->>chave_nfe=eq.' + chave : null;
    if (!filtro) return null;
    const r = await banco('GET', '/rest/v1/fin_entrada?select=id,status,dados,alertas,atualizado_em,origem,id_superlogica' + filtro + '&status=neq.descartado&order=criado_em.asc&limit=1');
    if (r.status !== 200) throw new Error('banco_' + r.status);
    return Array.isArray(r.body) && r.body[0] ? r.body[0] : null;
  }

  // Lê o documento e grava o rascunho. Usado pelo envio na tela e pela leitura dos emails.
  // o: { buf, nome, mime, esc, usuario: { sub, email } ou null, req (limites e auditoria),
  //      origem (email) ou null, xmls (XMLs do mesmo email para juntar ao PDF), parUnico,
  //      xml (o próprio documento é o XML: { info }), sugerir() (condomínio pelo email),
  //      deduplicarChave (a mesma nota já na fila vira repetição) }.
  // Devolve { linha, xmlUsado } ou { repetidoDe, xmlUsado } ou { conflito: true }.
  async function criarRascunho(o) {
    const req = o.req;
    const mime = MIMES.includes(o.mime) ? o.mime : 'application/pdf';
    const cli = clienteSL();
    const mapa = await E.mapaCondominios(cli);
    let campos = null, leitura = 'nenhuma', textoPdf = '', xmlUsado = null;
    const interna = async (b64Mime) => {
      if (o.buf.length > 7.5 * 1024 * 1024) return null;
      if (!dentroDoLimite(req, 'entrada_interna', 120)) { auditoria.evento(req, 'limite_processamento', { tipo: 'entrada_interna' }, true, 'volume_alto'); return null; }
      const r = await processar.processarDocumentoFinanceiro({ arquivo: { mime: b64Mime, base64: o.buf.toString('base64') } }, o.usuario ? o.usuario.sub : null);
      return r.status === 200 ? E.camposDaLeitura(r.corpo, hojeBR()) : null;
    };
    if (mime === 'application/pdf') {
      const x = await E.extrairTexto(o.buf);
      const util = !!(x && E.textoUtil(x.texto));
      textoPdf = x ? x.texto : '';
      campos = util ? E.lerCampos(x.texto, hojeBR()) : null;
      leitura = util ? 'texto' : 'nenhuma';
      xmlUsado = o.xmls ? EF.xmlDoPdf(o.xmls, textoPdf, o.parUnico) : null;
      // Com o XML da nota junto, a leitura interna só entra se ainda faltar o essencial.
      const comXml = xmlUsado ? EF.juntarComXml(campos, EF.camposDoXml(xmlUsado.info)) : campos;
      if (E.faltaEssencial(comXml, mapa)) {
        const ci = await interna('application/pdf');
        if (ci) { campos = E.juntarLeituras(campos, ci, !campos || !campos.cnpjs.some((c) => mapa.has(c.cnpj))); leitura = util ? 'texto+interna' : 'interna'; }
      }
      if (xmlUsado) { campos = EF.juntarComXml(campos, EF.camposDoXml(xmlUsado.info)); leitura += '+xml'; }
    } else if (mime === 'application/xml') {
      if (o.xml && o.xml.info) { campos = EF.camposDoXml(o.xml.info); leitura = 'xml'; xmlUsado = o.xml; }
    } else {
      const ci = await interna(mime);
      if (ci) { campos = ci; leitura = 'interna'; }
    }
    campos = campos || { tipo: 'outro', valor: null, vencimento: null, emissao: null, documento: null, linha: null, barras: null, especie_linha: null, cnpjs: [] };
    const chave = (xmlUsado && xmlUsado.info.chave) || E.chaveNfeDoTexto(textoPdf) || null;
    if (o.deduplicarChave && chave) {
      const ja = await acharRepetido({ chave });
      if (ja) return { repetidoDe: ja, xmlUsado };
    }
    const id = await E.identificar(cli, campos, o.esc);
    const condDoc = campos.cnpjs.map((c) => mapa.get(c.cnpj)).filter(Boolean)[0];
    const dados = {
      tipo: campos.tipo, valor: campos.valor, origem_valor: campos.origem_valor,
      vencimento: campos.vencimento, origem_vencimento: campos.origem_vencimento || null, emissao: campos.emissao, documento: campos.documento, linha: campos.linha, barras: campos.barras, especie_linha: campos.especie_linha,
      cnpjs: campos.cnpjs.map((c) => ({ cnpj: E.formatarCnpj(c.cnpj), papel: c.papel, condominio: mapa.has(c.cnpj) })),
      id_superlogica: id.condominio ? id.condominio.id : null, nome_condominio: id.condominio ? id.condominio.nome : null, motivo_condominio: id.motivo_condominio,
      cond_documento: condDoc ? condDoc.id : null,
      id_fornecedor: id.fornecedor ? id.fornecedor.id : null, nome_fornecedor: id.fornecedor ? id.fornecedor.nome : null,
      cnpj_fornecedor: id.cnpj_fornecedor ? E.formatarCnpj(id.cnpj_fornecedor) : null,
      conta: null, nome_conta: null, forma_pag: campos.especie_linha ? 0 : null,
      complemento: [id.fornecedor ? id.fornecedor.nome : null, campos.documento ? 'doc ' + campos.documento : null].filter(Boolean).join(' ').slice(0, 200) || null,
    };
    if (chave) dados.chave_nfe = chave;
    if (dados.forma_pag == null) dados.forma_pag = 0;
    // Email sem CNPJ de condomínio: nome citado, remetente conhecido ou caixa (alerta grave na tela).
    if (!dados.id_superlogica && typeof o.sugerir === 'function') {
      let s = null;
      try { s = await o.sugerir(); } catch (e) { s = null; }
      const cond = s ? await E.condominioPorId(cli, s.id) : null;
      if (cond && !(o.esc && !o.esc.has(String(cond.id)))) {
        Object.assign(dados, { id_superlogica: cond.id, nome_condominio: cond.nome, condominio_por: s.por, condominio_sugerido: cond.id });
      }
    }
    valoresDaLinha(dados);
    const alertas = await conferirDados(dados, o.esc, null);
    const linha = {
      criado_por: o.usuario ? o.usuario.sub : null, criado_por_email: o.usuario ? o.usuario.email || null : null, status: 'rascunho',
      nome_arquivo: String(o.nome || 'documento').replace(/[\r\n\t]/g, ' ').slice(0, 150), hash_sha256: E.hashDe(o.buf), tamanho: o.buf.length, arquivo_base64: o.buf.toString('base64'), leitura, tipo: dados.tipo,
      id_superlogica: dados.id_superlogica ? Number(dados.id_superlogica) : null, cond_documento: condDoc ? Number(condDoc.id) : null, dados, alertas,
      arquivo_mime: mime, origem: o.origem || null,
    };
    const ins = await banco('POST', '/rest/v1/fin_entrada?select=' + CAMPOS_LISTA, linha);
    if (ins.status === 409) return { conflito: true, xmlUsado };
    if (ins.status !== 201 || !Array.isArray(ins.body) || !ins.body[0]) throw new Error('banco_' + ins.status);
    auditoria.evento(req, 'entrada_lida', { id_superlogica: dados.id_superlogica, entrada: ins.body[0].id, leitura, tipo: dados.tipo, origem: o.origem ? 'email' : 'tela', caixa: o.origem ? o.origem.caixa_id : undefined });
    return { linha: ins.body[0], xmlUsado };
  }

  function erroInterno(res, onde, e) {
    console.warn('[entrada ' + onde + '] ' + (e && e.message));
    if (!res.headersSent) res.status(502).json({ erro: 'falha', detalhe: 'Não foi possível concluir agora. Tente de novo em instantes.' });
  }

  // GET /api/entrada/fila?status=rascunho|lancado|todos
  app.get('/api/entrada/fila', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await exigir(req, res, 'ver'))) return;
    const E2 = await escopo(req, res); if (!E2) return;
    const st = String(req.query.status || 'rascunho');
    const filtro = st === 'todos' ? '&status=neq.descartado' : st === 'lancado' ? '&status=in.(lancado,incerto)' : '&status=eq.rascunho';
    try {
      const r = await banco('GET', '/rest/v1/fin_entrada?select=' + CAMPOS_LISTA + filtro + '&order=criado_em.desc&limit=300');
      if (r.status !== 200) throw new Error('banco_' + r.status);
      const lib = E.liberados();
      res.json({ itens: (r.body || []).filter((l) => visivel(req, E2.escopo, l, E2.carteiras)).map((l) => paraTela(l, E2.escopo)), so_teste: lib.length === 1 && lib[0] === '167' });
    } catch (e) { erroInterno(res, 'fila', e); }
  });

  // POST /api/entrada/ler { arquivo: { nome, base64 } } — um PDF por chamada; vira rascunho.
  app.post('/api/entrada/ler', requireAuth, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { if (await exigir(req, res, 'ver')) next(); } catch (e) { erroInterno(res, 'ler', e); }
  }, express.json({ limit: '15mb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const a = req.body && req.body.arquivo;
    if (!a || typeof a.base64 !== 'string' || a.base64.length > Math.ceil(E.MAX_PDF_BYTES / 3) * 4 + 8) return res.status(400).json({ erro: 'arquivo_invalido', detalhe: 'Envie um PDF de até 10 MB.' });
    const buf = Buffer.from(a.base64, 'base64');
    if (!E.ehPdf(buf) || buf.length > E.MAX_PDF_BYTES) return res.status(400).json({ erro: 'arquivo_invalido', detalhe: 'O arquivo precisa ser PDF (até 10 MB).' });
    const nome = String(a.nome || 'documento.pdf').replace(/[\r\n\t]/g, ' ').slice(0, 150);
    const E2 = await escopo(req, res); if (!E2) return;
    if (!dentroDoLimite(req, 'entrada_ler', 300)) {
      auditoria.evento(req, 'limite_processamento', { tipo: 'entrada_ler' }, true, 'volume_alto');
      return res.status(429).json({ erro: 'limite', detalhe: 'Muitos documentos nesta hora. Tente mais tarde.' });
    }
    const hash = E.hashDe(buf);
    try {
      const ja = await banco('GET', '/rest/v1/fin_entrada?select=' + CAMPOS_LISTA + '&hash_sha256=eq.' + hash + '&status=neq.descartado&limit=1');
      if (ja.status === 200 && ja.body && ja.body[0]) {
        if (!visivel(req, E2.escopo, ja.body[0], E2.carteiras)) return res.status(409).json({ erro: 'ja_enviado', detalhe: 'Este mesmo arquivo já foi enviado por outra pessoa.' });
        return res.json({ item: paraTela(ja.body[0], E2.escopo), repetido: true });
      }
      const r = await criarRascunho({ buf, nome, mime: 'application/pdf', esc: E2.escopo, usuario: req.user ? { sub: req.user.sub, email: req.user.email || null } : null, req, origem: null });
      if (r.conflito) return res.status(409).json({ erro: 'ja_enviado', detalhe: 'Este mesmo arquivo acabou de ser enviado.' });
      res.json({ item: paraTela(r.linha, E2.escopo) });
    } catch (e) { erroInterno(res, 'ler', e); }
  });

  // Carrega o rascunho e confere se quem chama pode vê-lo. Devolve { linha, esc } ou null (já respondeu).
  async function carregar(req, res, acao) {
    if (!UUID.test(String(req.params.id || ''))) { res.status(400).json({ erro: 'id_invalido' }); return null; }
    if (!(await exigir(req, res, acao))) return null;
    const E2 = await escopo(req, res); if (!E2) return null;
    let linha;
    try { linha = await lerLinha(req.params.id); } catch (e) { erroInterno(res, 'carregar', e); return null; }
    if (!linha || !visivel(req, E2.escopo, linha, E2.carteiras)) { res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Documento não encontrado.' }); return null; }
    return { linha, esc: E2.escopo };
  }

  app.get('/api/entrada/:id', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const c = await carregar(req, res, 'ver'); if (!c) return;
    res.json({ item: paraTela(c.linha, c.esc) });
  });

  // PDF para conferir na tela (só para quem vê o rascunho). XML da nota vai como texto puro (nunca
  // interpretado pelo navegador); foto vai como imagem.
  app.get('/api/entrada/:id/pdf', requireAuth, async (req, res) => {
    const c = await carregar(req, res, 'ver'); if (!c) return;
    const mime = MIMES.includes(c.linha.arquivo_mime) ? c.linha.arquivo_mime : 'application/pdf';
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', mime === 'application/xml' ? 'text/plain; charset=utf-8' : mime);
    res.set('Content-Disposition', 'inline; filename="documento' + (E.EXTENSAO[mime] || '.pdf') + '"');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(c.linha.arquivo_base64, 'base64'));
  });

  // GET /api/entrada/contas/:idSuperlogica — categorias de despesa do plano do condomínio.
  app.get('/api/entrada/contas/:idSuperlogica', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!/^[1-9]\d{0,8}$/.test(id)) return res.status(400).json({ erro: 'id_invalido' });
    if (!(await exigir(req, res, 'ver'))) return;
    const E2 = await escopo(req, res); if (!E2) return;
    if (E2.escopo && !E2.escopo.has(id)) return res.status(403).json({ erro: 'fora_da_carteira', detalhe: 'Esse condomínio não está na sua carteira.' });
    try {
      const cond = await E.condominioPorId(clienteSL(), id);
      if (!cond) return res.status(404).json({ erro: 'nao_encontrado', detalhe: 'Condomínio não encontrado.' });
      res.json({ id_superlogica: id, nome: cond.nome, contas: await E.contasDoPlano(clienteSL(), cond.plano) });
    } catch (e) { erroInterno(res, 'contas', e); }
  });

  // PUT /api/entrada/:id { campos editados } — refaz a conferência e salva o rascunho.
  app.put('/api/entrada/:id', requireAuth, express.json({ limit: '20kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const c = await carregar(req, res, 'ver'); if (!c) return;
    if (c.linha.status !== 'rascunho') return res.status(409).json({ erro: 'nao_editavel', detalhe: 'Só rascunho pode ser editado.' });
    const b = req.body || {};
    const dados = Object.assign({}, c.linha.dados);
    const ruim = (detalhe) => res.status(400).json({ erro: 'campo_invalido', detalhe });
    try {
      const cli = clienteSL();
      if (b.id_superlogica !== undefined) {
        // Escolhido na tela: deixa de ser sugestão do email.
        if (String(b.id_superlogica || '') !== String(dados.id_superlogica || '') || b.confirmar_condominio === true) { delete dados.condominio_por; delete dados.condominio_sugerido; }
        const id = String(b.id_superlogica || '');
        if (!id) { dados.id_superlogica = null; dados.nome_condominio = null; }
        else {
          if (!/^[1-9]\d{0,8}$/.test(id) || E.NAO_CONDOMINIOS.has(id)) return ruim('Condomínio inválido.');
          if (c.esc && !c.esc.has(id)) return res.status(403).json({ erro: 'fora_da_carteira', detalhe: 'Esse condomínio não está na sua carteira.' });
          const cond = await E.condominioPorId(cli, id);
          if (!cond) return ruim('Condomínio não encontrado no Superlógica.');
          if (String(dados.id_superlogica) !== id) { dados.conta = null; dados.nome_conta = null; dados.conta_sugerida = false; }
          dados.id_superlogica = id; dados.nome_condominio = cond.nome;
        }
      }
      if (b.id_fornecedor !== undefined) {
        if (!b.id_fornecedor) { dados.id_fornecedor = null; dados.nome_fornecedor = null; }
        else {
          const f = await E.fornecedorPorId(cli, String(b.id_fornecedor));
          if (!f) return ruim('Fornecedor não encontrado no Superlógica com esse código.');
          dados.id_fornecedor = f.id; dados.nome_fornecedor = f.nome;
        }
      }
      if (b.valor !== undefined) {
        // Só texto no formato brasileiro (1.234,56 ou 150): "150.00" é recusado, nunca vira 15000.
        const s = typeof b.valor === 'string' ? b.valor.replace(/\s|R\$/g, '') : null;
        const v = s ? (E.lerDinheiro(s) || (/^\d{1,9}$/.test(s) ? Number(s) : null)) : null;
        if (b.valor !== null && b.valor !== '' && !(v > 0 && v < 1e9)) return ruim('Valor inválido: use vírgula para os centavos (exemplo 1.234,56).');
        dados.valor = v > 0 ? v : null;
      }
      for (const k of ['vencimento', 'emissao']) {
        if (b[k] === undefined) continue;
        if (b[k] && !/^\d{4}-\d{2}-\d{2}$/.test(String(b[k]))) return ruim('Data inválida.');
        dados[k] = b[k] ? E.brParaIso(String(b[k]).split('-').reverse().join('/')) : null;
        if (b[k] && !dados[k]) return ruim('Data inválida.');
      }
      if (b.documento !== undefined) dados.documento = b.documento ? String(b.documento).replace(/[\r\n\t]/g, ' ').trim().slice(0, 25) : null;
      if (b.complemento !== undefined) dados.complemento = b.complemento ? String(b.complemento).replace(/[\r\n\t]/g, ' ').trim().slice(0, 200) : null;
      if (b.tipo !== undefined) { if (!Object.prototype.hasOwnProperty.call(E.TIPOS_DOC_SL, b.tipo) && b.tipo !== 'comprovante') return ruim('Tipo inválido.'); dados.tipo = b.tipo; }
      if (b.forma_pag !== undefined) { const fp = Number(b.forma_pag); if (![0, 1, 2, 3, 4, 7, 8, 9, 10, 12, 13, 14].includes(fp)) return ruim('Forma de pagamento inválida.'); dados.forma_pag = fp; }
      if (b.linha !== undefined) {
        if (!b.linha) { dados.linha = null; dados.barras = null; dados.especie_linha = null; dados.valor_linha = null; dados.vencimento_linha = null; }
        else {
          const l = E.acharLinha(String(b.linha).replace(/[^\d]/g, ''), hojeBR());
          if (!l) return ruim('Linha digitável inválida (os dígitos de conferência não batem).');
          dados.linha = l.linha; dados.barras = l.barras; dados.especie_linha = l.especie;
        }
      }
      valoresDaLinha(dados);
      // T40: valor e vencimento conferidos na tela. Vale o "conferi" marcado ou o valor digitado
      // diferente do lido; a confirmação fica presa ao valor (se mudar depois, perde).
      const conf = Object.assign({}, dados.confirmado || {});
      const agora = new Date().toISOString();
      const antes = c.linha.dados || {};
      if (dados.valor > 0 && (b.confirmar_valor === true || (b.valor !== undefined && dados.valor !== antes.valor))) Object.assign(conf, { valor: dados.valor, valor_por: quem(req), valor_em: agora });
      if (dados.vencimento && (b.confirmar_vencimento === true || (b.vencimento !== undefined && dados.vencimento !== antes.vencimento))) Object.assign(conf, { vencimento: dados.vencimento, vencimento_por: quem(req), vencimento_em: agora });
      dados.confirmado = conf;
      dados.pronto = null; // qualquer edição desfaz o "rascunho conferido"
      if (b.conta !== undefined) {
        if (!b.conta) { dados.conta = null; dados.nome_conta = null; }
        else {
          const cond = dados.id_superlogica ? await E.condominioPorId(cli, dados.id_superlogica) : null;
          const contas = cond ? await E.contasDoPlano(cli, cond.plano) : [];
          const achou = contas.find((x) => x.conta === String(b.conta));
          if (!achou) return ruim('Categoria não existe no plano de contas deste condomínio.');
          dados.conta = achou.conta; dados.nome_conta = achou.nome; dados.conta_sugerida = false;
        }
      }
      const alertas = await conferirDados(dados, c.esc, c.linha.id);
      const up = await banco('PATCH', '/rest/v1/fin_entrada?id=eq.' + c.linha.id + '&status=eq.rascunho&select=' + CAMPOS_LISTA,
        { dados, alertas, tipo: dados.tipo, id_superlogica: dados.id_superlogica ? Number(dados.id_superlogica) : null, atualizado_em: new Date().toISOString() });
      if (up.status !== 200 || !Array.isArray(up.body) || !up.body[0]) return res.status(409).json({ erro: 'nao_editavel', detalhe: 'O rascunho mudou enquanto você editava. Abra de novo.' });
      res.json({ item: paraTela(up.body[0], c.esc) });
    } catch (e) { erroInterno(res, 'editar', e); }
  });

  app.post('/api/entrada/:id/descartar', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const c = await carregar(req, res, 'ver'); if (!c) return;
    const up = await banco('PATCH', '/rest/v1/fin_entrada?id=eq.' + c.linha.id + '&status=eq.rascunho&select=id', { status: 'descartado', atualizado_em: new Date().toISOString() });
    if (up.status !== 200 || !Array.isArray(up.body) || !up.body[0]) return res.status(409).json({ erro: 'nao_editavel', detalhe: 'Só rascunho pode ser descartado.' });
    auditoria.evento(req, 'entrada_descartada', { id_superlogica: c.linha.id_superlogica, entrada: c.linha.id });
    res.json({ ok: true });
  });

  // T40: lança um rascunho já carregado e visível. Devolve { st, j } (quem chama responde).
  // origem: 'individual' (aceita alertas graves marcados na tela) ou 'lote' (sem graves).
  async function lancarUm(req, L, esc, aceitos, origem, manterGeral) {
    const dados = Object.assign({}, L.dados);
    let travado = false;
    if (L.status !== 'rascunho') return { st: 409, j: { erro: 'nao_editavel', detalhe: L.status === 'incerto' ? 'Este documento ficou sem confirmação do Superlógica. Confira lá antes de qualquer coisa.' : 'Este documento já foi lançado ou descartado.' } };
    const idSL = String(dados.id_superlogica || '');
    if (!/^[1-9]\d{0,8}$/.test(idSL)) return { st: 400, j: { erro: 'sem_condominio', detalhe: 'Escolha o condomínio.' } };
    // Trava antes de tudo: só os condomínios de ENTRADA_LANCAMENTO_LIBERADO (padrão só o 167).
    if (!E.lancamentoLiberado(idSL)) {
      auditoria.evento(req, 'entrada_recusada', { id_superlogica: idSL, entrada: L.id, motivo: 'lancamento_travado', origem }, true, 'condominio_nao_liberado');
      return { st: 423, j: { erro: 'lancamento_travado', detalhe: 'O lançamento direto ainda não está liberado para este condomínio. Use "Gerar rascunho" e lance no Superlógica.' } };
    }
    const rf = resFalso();
    if (!(await carteiraEstrita(req, rf, idSL))) return { st: rf.st, j: rf.j };
    if (!superlogicaNativa()) return { st: 503, j: { erro: 'superlogica_nao_configurado' } };
    if (!dentroDoLimite(req, 'entrada_lancar', 120)) {
      auditoria.evento(req, 'limite_processamento', { tipo: 'entrada_lancar', id_superlogica: idSL }, true, 'volume_alto');
      return { st: 429, j: { erro: 'limite', detalhe: 'Muitos lançamentos nesta hora. Tente mais tarde.' } };
    }
    if (emCurso.has(L.id)) return { st: 409, j: { erro: 'em_andamento', detalhe: 'Este documento já está sendo lançado.' } };
    emCurso.add(L.id);
    const cli = clienteSL();
    try {
      // Conferência refeita agora, sem cache: fornecedor, categoria, confiança, mês fechado,
      // duplicidade e outro condomínio.
      // Só o que muda com um lançamento: despesas e contas deste condomínio e o fornecedor. O lote
      // limpa a lista geral (outros condomínios) uma vez no começo (manterGeral).
      E.limparCache(['desp:' + idSL + ':', 'cb:' + idSL, 'fornid:' + dados.id_fornecedor].concat(manterGeral ? [] : ['desptodos:']));
      const f = dados.id_fornecedor ? await E.fornecedorPorId(cli, dados.id_fornecedor) : null;
      if (!f) return { st: 400, j: { erro: 'sem_fornecedor', detalhe: 'Fornecedor não encontrado no Superlógica.' } };
      const cond = await E.condominioPorId(cli, idSL);
      if (!cond) return { st: 400, j: { erro: 'sem_condominio', detalhe: 'Condomínio não encontrado no Superlógica.' } };
      const contas = await E.contasDoPlano(cli, cond.plano);
      if (!dados.conta || !contas.some((x) => x.conta === dados.conta)) return { st: 400, j: { erro: 'sem_conta', detalhe: 'Escolha uma categoria do plano de contas deste condomínio.' } };
      dados.id_contabanco = null; dados.bloqueio_contas = null;
      valoresDaLinha(dados); // confiança recalculada da linha digitável guardada, nunca do que veio antes
      const alertas = await conferirDados(dados, esc, L.id, true);
      let pode = E.podeLancar(alertas, origem === 'lote' ? [] : aceitos);
      const foraLote = origem === 'lote' ? alertas.filter((a) => E.FORA_DO_LOTE.includes(a.codigo)) : [];
      if (pode.ok && foraLote.length) pode = { ok: false, motivo: 'fora_do_lote', alertas: foraLote };
      if (!pode.ok) {
        await banco('PATCH', '/rest/v1/fin_entrada?id=eq.' + L.id + '&status=eq.rascunho', { alertas, atualizado_em: new Date().toISOString() });
        auditoria.evento(req, 'entrada_recusada', { id_superlogica: idSL, entrada: L.id, motivo: pode.motivo, origem, alertas: pode.alertas.map((a) => a.codigo) }, false);
        return { st: 409, j: { erro: pode.motivo, detalhe: pode.motivo === 'impede' ? 'Falta corrigir: ' + pode.alertas.map((a) => a.texto).join(' ')
          : origem === 'lote' ? 'Tem alerta para conferir: abra o documento e lance por ele.' : 'Confira e marque os alertas antes de lançar.', alertas: mascararAlertas(alertas, esc) } };
      }
      // Marca "incerto" antes de gravar: se algo cair no meio, ninguém lança de novo sem conferir.
      const trava = await banco('PATCH', '/rest/v1/fin_entrada?id=eq.' + L.id + '&status=eq.rascunho&select=id', { status: 'incerto', alertas, lancado_por: req.user ? req.user.sub : null, atualizado_em: new Date().toISOString() });
      if (trava.status !== 200 || !Array.isArray(trava.body) || !trava.body[0]) return { st: 409, j: { erro: 'nao_editavel', detalhe: 'Este documento mudou de situação. Abra de novo.' } };
      travado = true;
      const r = await E.lancar(credSL(), cli, Object.assign({}, dados, { id_superlogica: idSL, id_fornecedor: f.id, nome_fornecedor: f.nome, id_contabanco: dados.id_contabanco || null }),
        Buffer.from(L.arquivo_base64, 'base64'), L.nome_arquivo, L.arquivo_mime || 'application/pdf');
      const registro = Object.assign({}, r, { lancado_por_email: quem(req), origem, conta_bancaria: dados.nome_contabanco || null, confianca: E.confianca(dados), aceitos: origem === 'lote' ? [] : aceitos });
      const fim = { atualizado_em: new Date().toISOString(), resultado: registro };
      if (r.ok) Object.assign(fim, { status: 'lancado', id_despesa: r.id_despesa, id_parcela: r.id_parcela, id_arquivo: r.id_arquivo, lancado_em: new Date().toISOString(),
        dados, id_superlogica: Number(idSL), tipo: dados.tipo });
      else if (!r.incerto) Object.assign(fim, { status: 'rascunho', lancado_por: null });
      await banco('PATCH', '/rest/v1/fin_entrada?id=eq.' + L.id, fim);
      auditoria.evento(req, 'entrada_lancada', { id_superlogica: idSL, entrada: L.id, ok: r.ok, incerto: !!r.incerto, id_despesa: r.id_despesa || null, id_arquivo: r.id_arquivo || null,
        valor: dados.valor, vencimento: dados.vencimento, conferido: !!r.conferido, anexado: !!r.anexado, origem, aceitos: origem === 'lote' ? [] : aceitos }, !r.ok || !r.conferido || !r.anexado);
      console.log('[entrada] ' + quem(req) + ' lançou documento ' + L.id + ' no condomínio ' + idSL + ' (' + origem + '): ' + (r.ok ? 'ok despesa ' + r.id_despesa + (r.conferido && r.anexado ? ' conferida' : ' SEM PROVA COMPLETA') : r.incerto ? 'incerto' : 'recusado'));
      if (r.ok) return { st: 200, j: { ok: true, id_despesa: r.id_despesa, id_arquivo: r.id_arquivo, anexado: r.anexado, conferido: r.conferido, prova: r.prova, etiqueta: r.etiqueta } };
      if (r.incerto) return { st: 504, j: { erro: 'incerto', detalhe: 'O Superlógica não confirmou. Confira no Superlógica antes de tentar de novo.' } };
      return { st: 502, j: { erro: 'recusado', detalhe: r.msg } };
    } catch (e) {
      // Depois da trava, erro inesperado pode ter gravado: o rascunho fica "incerto" e a tela avisa.
      if (travado) {
        console.warn('[entrada lancar] ' + (e && e.message));
        auditoria.evento(req, 'entrada_lancada', { id_superlogica: idSL, entrada: L.id, ok: false, incerto: true, origem, erro: String(e && e.message).slice(0, 120) }, true, 'lancamento_incerto');
        return { st: 504, j: { erro: 'incerto', detalhe: 'O lançamento não foi confirmado. Confira no Superlógica antes de tentar de novo.' } };
      }
      console.warn('[entrada lancar] ' + (e && e.message));
      return { st: 502, j: { erro: 'falha', detalhe: 'Não foi possível concluir agora. Tente de novo em instantes.' } };
    } finally { emCurso.delete(L.id); }
  }

  // POST /api/entrada/:id/lancar { confirmacao: 'LANCAR', aceitar_alertas: [códigos] }
  // Cria a despesa no Superlógica com o PDF anexado. Trava: só condomínio liberado.
  app.post('/api/entrada/:id/lancar', requireAuth, express.json({ limit: '5kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    if (b.confirmacao !== 'LANCAR') return res.status(400).json({ erro: 'sem_confirmacao', detalhe: 'Confirme o lançamento na tela.' });
    const aceitos = Array.isArray(b.aceitar_alertas) ? b.aceitar_alertas.filter((x) => typeof x === 'string').map((x) => x.slice(0, 40)).slice(0, 20) : [];
    const c = await carregar(req, res, 'lancar'); if (!c) return;
    const r = await lancarUm(req, c.linha, c.esc, aceitos, 'individual');
    res.status(r.st).json(r.j);
  });

  // POST /api/entrada/lancar-lote { confirmacao: 'LANCAR_LOTE', itens: [{ id, valor, vencimento }] }
  // Vários rascunhos já conferidos, um de cada vez. Valor e vencimento vêm da lista que a pessoa
  // viu: se mudaram, o item é pulado. Alerta grave não passa no lote (abre e lança pelo documento).
  app.post('/api/entrada/lancar-lote', requireAuth, express.json({ limit: '20kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    if (b.confirmacao !== 'LANCAR_LOTE') return res.status(400).json({ erro: 'sem_confirmacao', detalhe: 'Confirme o lançamento na tela.' });
    const vistos = new Set();
    const itens = (Array.isArray(b.itens) ? b.itens : []).map((x) => (x && typeof x.id === 'string' ? Object.assign({}, x, { id: x.id.toLowerCase() }) : null))
      .filter((x) => x && UUID.test(x.id) && !vistos.has(x.id) && vistos.add(x.id));
    if (!itens.length || itens.length > 20 || itens.length !== b.itens.length) return res.status(400).json({ erro: 'lote_invalido', detalhe: 'Escolha de 1 a 20 documentos.' });
    if (!(await exigir(req, res, 'lancar'))) return;
    const E2 = await escopo(req, res); if (!E2) return;
    const resultados = [];
    const inicio = Date.now();
    E.limparCache(['desptodos:']); // a lista geral é relida uma vez por lote
    for (const it of itens) {
      // Teto de tempo: depois de 90 s não começa outro (a resposta precisa voltar antes do navegador desistir).
      if (Date.now() - inicio > 90000) { resultados.push({ id: it.id, ok: false, erro: 'nao_tentado', detalhe: 'O lote passou do tempo; este continua na fila.' }); continue; }
      let L = null;
      try { L = await lerLinha(it.id); } catch (e) { resultados.push({ id: it.id, ok: false, erro: 'falha', detalhe: 'Não deu para abrir o documento.' }); continue; }
      if (!L || !visivel(req, E2.escopo, L)) { resultados.push({ id: it.id, ok: false, erro: 'nao_encontrado', detalhe: 'Documento não encontrado.' }); continue; }
      const d = L.dados || {};
      if (!(Number(d.valor) > 0) || Math.abs(Number(d.valor) - Number(it.valor)) >= 0.005 || String(d.vencimento || '') !== String(it.vencimento || '')) {
        resultados.push({ id: it.id, ok: false, erro: 'mudou', detalhe: 'Valor ou vencimento mudou desde que a lista foi aberta. Atualize a fila.' }); continue;
      }
      const r = await lancarUm(req, L, E2.escopo, [], 'lote', true);
      resultados.push(Object.assign({ id: it.id, ok: r.st === 200, st: r.st }, r.j || {}, { alertas: undefined }));
      if (r.st === 429 || r.st === 503) break; // limite ou configuração: para o lote
    }
    auditoria.evento(req, 'entrada_lote', { pedidos: itens.length, tentados: resultados.length, lancados: resultados.filter((x) => x.ok).length });
    res.json({ resultados, pedidos: itens.length });
  });

  // POST /api/entrada/:id/pronto: condomínio fora da lista de lançamento direto: confere tudo de
  // novo e marca o rascunho como conferido, pronto para lançar no Superlógica. Nada é gravado lá.
  app.post('/api/entrada/:id/pronto', requireAuth, express.json({ limit: '5kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    const aceitos = Array.isArray(b.aceitar_alertas) ? b.aceitar_alertas.filter((x) => typeof x === 'string').map((x) => x.slice(0, 40)).slice(0, 20) : [];
    const c = await carregar(req, res, 'ver'); if (!c) return;
    if (!dentroDoLimite(req, 'entrada_pronto', 300)) return res.status(429).json({ erro: 'limite', detalhe: 'Muitas conferências nesta hora. Tente mais tarde.' });
    if (c.linha.status !== 'rascunho') return res.status(409).json({ erro: 'nao_editavel', detalhe: 'Só rascunho pode ser marcado.' });
    const dados = Object.assign({}, c.linha.dados);
    try {
      valoresDaLinha(dados);
      const alertas = await conferirDados(dados, c.esc, c.linha.id);
      // Mesma regra do lançamento: nada que impeça e alerta grave só marcado na tela.
      const pode = E.podeLancar(alertas, aceitos);
      const imp = pode.ok ? [] : pode.alertas;
      dados.pronto = imp.length ? null : { por: quem(req), em: new Date().toISOString(), aceitos: alertas.filter((a) => a.nivel === 'grave').map((a) => a.codigo) };
      const up = await banco('PATCH', '/rest/v1/fin_entrada?id=eq.' + c.linha.id + '&status=eq.rascunho&select=' + CAMPOS_LISTA, { dados, alertas, atualizado_em: new Date().toISOString() });
      if (up.status !== 200 || !Array.isArray(up.body) || !up.body[0]) return res.status(409).json({ erro: 'nao_editavel', detalhe: 'O rascunho mudou. Abra de novo.' });
      if (imp.length) return res.status(409).json({ erro: pode.motivo, detalhe: pode.motivo === 'impede' ? 'Falta corrigir: ' + imp.map((a) => a.texto).join(' ') : 'Confira e marque os alertas antes de gerar o rascunho.', item: paraTela(up.body[0], c.esc) });
      auditoria.evento(req, 'entrada_rascunho_pronto', { id_superlogica: dados.id_superlogica, entrada: c.linha.id });
      res.json({ item: paraTela(up.body[0], c.esc) });
    } catch (e) { erroInterno(res, 'pronto', e); }
  });

  return { criarRascunho, acharRepetido, registrarRepeticao };
}

module.exports = { criarRotasEntrada };
