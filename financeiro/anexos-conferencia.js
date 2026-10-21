'use strict';
// ─────────────────────────────────────────────────────────────────────────
// T38: conferência dos anexos das despesas pagas no mês, dentro do pré balancete.
// Usa as regras da T32 (financeiro/anexos.js): comprovante bate valor e data, pagador ou
// tomador é o condomínio pelo CNPJ, CNPJ de outro condomínio, linha digitável, PDF de editor,
// modificado ou que passou por site de juntar. Escaneado: leitura interna com limite por hora e
// auditoria (como na entrada de documentos); sem leitura, fica só listado.
//
// Cache por arquivo (id do arquivo + hash): o que já foi lido não é baixado nem lido de novo
// (memória e, no ambiente de teste, tabela fin_anexo_leitura). Só GET no Superlógica, no
// máximo 2 chamadas ao mesmo tempo e teto de downloads por hora. A conferência de um
// condomínio e mês roda em segundo plano; a rota devolve o andamento até terminar.
// ─────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const an = require('./anexos');

const SIMULTANEAS = 2;                 // chamadas ao Superlógica (lista e downloads) ao mesmo tempo
const PDF_SIMULTANEOS = 2;             // leituras de PDF ao mesmo tempo
const PDF_TEMPO_MS = 15000;
const PDF_MEMORIA_BYTES = 400 * 1024 * 1024;
const MAX_BYTES = 15 * 1024 * 1024;    // anexo maior que isso não é baixado (fica listado)
const MAX_BYTES_INTERNA = 7 * 1024 * 1024;
const MAX_TEXTO = 20000;
const MAX_CACHE = 6000;
const TTL_RESULTADO = 10 * 60 * 1000;
const MAX_PAGINAS_DESPESAS = 40;
const NAO_CONDOMINIOS = new Set(['143', '144', '145', '160', '162']);
// Fora da comparação de "CNPJ de outro condomínio": cadastros que não são condomínio e o 167 de teste.
const FORA_COMPARACAO = new Set([...NAO_CONDOMINIOS, '167']);
const limiteHora = (nome, padrao) => { const n = Number(process.env[nome]); return n > 0 ? n : padrao; };
const DOWNLOADS_HORA = () => limiteHora('ANEXOS_DOWNLOADS_HORA', 2000);
const INTERNA_HORA = () => limiteHora('ANEXOS_INTERNA_HORA', 300);

// Gravidade de cada achado na tela (alta e média pedem conferência; baixa só informa).
const ACHADOS = {
  cnpj_outro_condominio: { gravidade: 'alta', titulo: 'CNPJ de outro condomínio no documento' },
  comprovante_cnpj_pagador: { gravidade: 'alta', titulo: 'Comprovante sem o condomínio como pagador' },
  nota_tomador: { gravidade: 'media', titulo: 'Nota sem o condomínio como tomador' },
  comprovante_valor: { gravidade: 'media', titulo: 'Comprovante não bate o valor pago' },
  comprovante_data: { gravidade: 'media', titulo: 'Comprovante não bate a data da baixa' },
  boleto_linha: { gravidade: 'media', titulo: 'Linha digitável diferente da lançada' },
  pdf_editor: { gravidade: 'media', titulo: 'PDF gerado por editor' },
  pdf_modificado: { gravidade: 'media', titulo: 'PDF modificado depois de criado' },
  pdf_compactado: { gravidade: 'baixa', titulo: 'PDF passou por site de juntar ou compactar' },
  comprovante_data_parcela_incerta: { gravidade: 'baixa', titulo: 'Data do comprovante incerta (parcelas iguais)' },
};

// ── fila e contadores ─────────────────────────────────────────────────────
function criarFila(n) {
  let ativos = 0;
  const espera = [];
  const proximo = () => {
    if (ativos >= n || !espera.length) return;
    ativos++;
    const { fn, ok, falha } = espera.shift();
    Promise.resolve().then(fn).then(ok, falha).finally(() => { ativos--; proximo(); });
  };
  return (fn) => new Promise((ok, falha) => { espera.push({ fn, ok, falha }); proximo(); });
}
// Contador por hora corrida (teto global, vale para todos os usuários juntos).
function criarContadorHora(teto) {
  let ate = 0, n = 0;
  return () => {
    const agora = Date.now();
    if (agora > ate) { ate = agora + 3600000; n = 0; }
    if (n >= teto()) return false;
    n++;
    return true;
  };
}

// ── leitura do PDF num processo separado (mesmo desenho da T33) ───────────
let _pdfEmCurso = 0;
function memoriaDe(pid) {
  return new Promise((ok) => {
    fs.readFile('/proc/' + pid + '/statm', 'utf8', (e, t) => {
      if (!e) return ok(Number(String(t).split(' ')[1]) * 4096 || 0);
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 }, (e2, out) => ok(e2 ? 0 : (Number(String(out).trim()) || 0) * 1024));
    });
  });
}
async function extrairPdf(buf) {
  for (let t = 0; _pdfEmCurso >= PDF_SIMULTANEOS; t++) {
    if (t > 600) return null;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  _pdfEmCurso++;
  return new Promise((resolve) => {
    let fim = false, filho = null, relogio = null, vigia = null, medindo = false, tamanho = 0;
    const partes = [];
    const acabar = (v) => {
      if (fim) return;
      fim = true; _pdfEmCurso--;
      clearTimeout(relogio); clearInterval(vigia);
      try { if (filho && filho.exitCode === null) filho.kill('SIGKILL'); } catch (e) { /* nada */ }
      resolve(v);
    };
    try {
      filho = spawn(process.execPath, [path.join(__dirname, 'anexos-pdf-worker.js'), '6'], { stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH || '', NODE_PATH: process.env.NODE_PATH || '', NODE_ENV: process.env.NODE_ENV || '' } }); // sem os segredos do servidor
    } catch (e) { fim = true; _pdfEmCurso--; return resolve(null); }
    relogio = setTimeout(() => acabar(null), PDF_TEMPO_MS);
    vigia = setInterval(async () => {
      if (medindo || fim) return;
      medindo = true;
      const m = await memoriaDe(filho.pid);
      medindo = false;
      if (m > PDF_MEMORIA_BYTES) acabar(null);
    }, 100);
    filho.stdout.on('data', (c) => { tamanho += c.length; if (tamanho > 2 * 1024 * 1024) return acabar(null); partes.push(c); });
    filho.on('error', () => acabar(null));
    filho.on('close', () => {
      let m = null;
      try { m = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (e) { m = null; }
      acabar(m && m.ok ? { texto: String(m.texto || ''), meta: m.meta || {} } : null);
    });
    filho.stdin.on('error', () => acabar(null));
    filho.stdin.end(buf);
  });
}

// ── leitura interna (escaneado) para texto que as regras da T32 entendem ──
const fmtCnpj = (c) => { const d = String(c || '').replace(/\D/g, ''); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : ''; };
function textoDaInterna(j) {
  if (!j || typeof j !== 'object') return '';
  const pal = { comprovante: 'Comprovante de pagamento', nota: 'Nota fiscal', boleto: 'Linha digitável', guia: 'Guia', fatura: 'Fatura' };
  const l = [];
  if (pal[j.tipo]) l.push(pal[j.tipo]);
  // O primeiro CNPJ é o do emitente (beneficiário), como no texto do documento.
  if (fmtCnpj(j.cnpj_beneficiario)) l.push('Beneficiário CNPJ ' + fmtCnpj(j.cnpj_beneficiario));
  if (fmtCnpj(j.cnpj_pagador)) l.push('Pagador CNPJ ' + fmtCnpj(j.cnpj_pagador));
  if (j.valor) l.push('Valor ' + String(j.valor).replace(/[^\d.,]/g, ''));
  if (j.vencimento) l.push('Data ' + j.vencimento);
  if (j.emissao) l.push('Emissão ' + j.emissao);
  const d = String(j.linha_digitavel || '').replace(/\D/g, '');
  if (d.length >= 44) l.push(d);
  if (j.numero_documento) l.push('Documento ' + String(j.numero_documento).slice(0, 30));
  return l.join('\n');
}
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const extDe = (a) => String(a.st_extensao_arq || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
const chaveDe = (a) => String(a.id_arquivo_arq) + ':' + String(a.st_hash_arq || '');
const reais = (v) => Math.round((Number(v) || 0) * 100) / 100;
const slData = (iso) => iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4);
const fimDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
function competencia(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const ano = +m[1], mes = +m[2];
  if (mes < 1 || mes > 12 || ano < 2020 || ano > 2100) return null;
  return { rotulo: m[1] + '-' + m[2], inicio: m[1] + '-' + m[2] + '-01', fim: fimDoMes(ano, mes) };
}
function anexoValido(a) {
  return a && /^\d+$/.test(String(a.id_arquivo_arq || '')) && !(a.fl_excluido_arq && String(a.fl_excluido_arq) !== '0');
}

// Despesas pagas do condomínio no mês (paginado de 50 em 50, só GET).
async function despesasPagas(cliente, fila, idCond, c) {
  const todas = [];
  for (let pg = 1; pg <= MAX_PAGINAS_DESPESAS; pg++) {
    const j = await fila(() => cliente.get('despesas/index', { status: 'liquidadas', comStatus: 'liquidadas', filtrarpor: 'liquidacao',
      dtInicio: slData(c.inicio), dtFim: slData(c.fim), idCondominio: idCond, itensPorPagina: 50, pagina: pg }));
    const lista = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : null);
    if (!lista) { const e = new Error('despesas_sem_lista'); e.status = 502; throw e; }
    todas.push(...lista);
    if (lista.length < 50) return { despesas: todas.filter((d) => String(d.id_condominio_cond) === String(idCond)), cortado: false };
  }
  return { despesas: todas.filter((d) => String(d.id_condominio_cond) === String(idCond)), cortado: true };
}

// ── resultado por despesa (função pura, testada em scripts/financeiro-fechamento-teste.js) ──
// itens: [{ idDesp, parcelas, anexo, reg }] com reg = { leitura, texto, meta, motivo }.
function montarResultado({ idCond, comp, itens, despesas, cnpjCond, outros, nomesOutros, cortado, linkDe }) {
  const porDesp = new Map();
  despesas.forEach((d) => { const k = String(d.id_despesa_des); if (!porDesp.has(k)) porDesp.set(k, { parcelas: [], itens: [] }); porDesp.get(k).parcelas.push(d); });
  itens.forEach((it) => { const g = porDesp.get(String(it.idDesp)); if (g) g.itens.push(it); });
  const resumo = { despesas: porDesp.size, sem_anexo: 0, anexos: 0, lidos_texto: 0, lidos_interna: 0, escaneados_nao_lidos: 0, outros_formatos: 0, falhas: 0,
    despesas_com_achado: 0, achados: 0, para_conferir: 0, so_informativo: 0, por_tipo: {} };
  const lista = [];
  const escaneados = [];
  porDesp.forEach((g, idDesp) => {
    const p0 = g.parcelas[0];
    if (!g.itens.length) { resumo.sem_anexo++; return; }
    const achados = [];
    const res = g.itens.map((it) => {
      resumo.anexos++;
      const r = it.reg || { leitura: 'falha' };
      const nome = String(it.anexo.st_nome_arq || ('arquivo ' + it.anexo.id_arquivo_arq)).slice(0, 120);
      if (r.leitura === 'texto') resumo.lidos_texto++;
      else if (r.leitura === 'interna') resumo.lidos_interna++;
      else if (r.leitura === 'escaneado') { resumo.escaneados_nao_lidos++; escaneados.push({ id_despesa: idDesp, fornecedor: String(p0.st_nome_con || ''), arquivo: nome, link: linkDe(idDesp) }); }
      else if (r.leitura === 'nao_pdf') resumo.outros_formatos++;
      else { resumo.falhas++; return null; }
      if (r.leitura === 'nao_pdf') return { tipo: an.tipoDoAnexo(it.anexo, ''), legivel: false, achados: [] };
      const c = an.conferirAnexo({ anexo: it.anexo, texto: r.texto || '', meta: r.meta || {}, parcelas: g.parcelas, cnpjCond, outros });
      c.achados.forEach((a) => achados.push(Object.assign({ arquivo: nome, leitura: r.leitura }, a)));
      return c;
    });
    an.conferirDespesa(g.parcelas, res).forEach((a) => achados.push(Object.assign({ arquivo: '' }, a)));
    if (!achados.length) return;
    const tela = achados.map((a) => {
      const def = ACHADOS[a.tipo] || { gravidade: 'media', titulo: a.tipo };
      resumo.achados++;
      resumo.por_tipo[a.tipo] = (resumo.por_tipo[a.tipo] || 0) + 1;
      if (def.gravidade === 'baixa') resumo.so_informativo++; else resumo.para_conferir++;
      // CNPJ de outro condomínio: guarda os nomes à parte (quem só vê a própria carteira recebe sem eles).
      const outro = a.tipo === 'cnpj_outro_condominio';
      return { tipo: a.tipo, titulo: def.titulo, gravidade: def.gravidade, motivo: String(a.motivo || '').slice(0, 300), arquivo: a.arquivo, leitura: a.leitura || '', outro_condominio: outro || undefined };
    });
    resumo.despesas_com_achado++;
    const peso = { alta: 3, media: 2, baixa: 1 };
    tela.sort((x, y) => peso[y.gravidade] - peso[x.gravidade]);
    lista.push({ id_despesa: idDesp, fornecedor: String(p0.st_nome_con || '').slice(0, 120), documento: String(p0.st_documento_des || '').slice(0, 40),
      valor: reais(g.parcelas.reduce((s, p) => s + (Number(p.vl_valor_pdes) || 0), 0)),
      liquidacao: [...new Set(g.parcelas.map((p) => String(p.dt_liquidacao_pdes || '').slice(0, 10)))].join(' '), link: linkDe(idDesp), achados: tela,
      gravidade: tela[0].gravidade });
  });
  const peso = { alta: 3, media: 2, baixa: 1 };
  lista.sort((a, b) => peso[b.gravidade] - peso[a.gravidade] || b.valor - a.valor);
  return { condominio: String(idCond), competencia: comp.rotulo, resumo, despesas: lista, escaneados: escaneados.slice(0, 300),
    pode_fechar: resumo.para_conferir === 0 && resumo.falhas === 0 && !cortado, cortado: !!cortado, nomes_outros: nomesOutros || undefined };
}
// Quem só vê a própria carteira não recebe o nome do outro condomínio.
function paraTela(r, restrito) {
  const o = Object.assign({}, r);
  delete o.nomes_outros;
  if (!restrito) return o;
  o.despesas = r.despesas.map((d) => Object.assign({}, d, { achados: d.achados.map((a) => (a.outro_condominio
    ? Object.assign({}, a, { motivo: 'O documento traz o CNPJ de outro condomínio e não o deste. Peça ao gestor para conferir.' }) : a)) }));
  return o;
}

// ── serviço com estado ────────────────────────────────────────────────────
// opcoes: { cliente: () => cliente GET do Superlógica, cred: () => { base, appToken, accessToken },
//   banco: () => banco fin_* do teste ou null (financeiro/banco.js), linkDe: (idDesp, idCond) => url, log }
// ctx de cada pedido: { lerInterna(arquivo) -> { status, corpo }, podeInterna() -> bool (limite do
//   usuário), auditar(acao, detalhe, suspeito, motivo) }
function criarConferenciaAnexos(opcoes) {
  const fila = criarFila(SIMULTANEAS);
  const downloadOk = criarContadorHora(DOWNLOADS_HORA);
  const internaOk = criarContadorHora(INTERNA_HORA);
  const log = opcoes.log || ((m) => console.warn(m));
  const memoria = new Map(); // chave -> registro
  const trabalhos = new Map(); // id|competencia -> { promessa, feitos, total, inicio, resultado, ate, erro, criado }
  let cadastro = null; // { ate, v }
  const banco = () => { try { return opcoes.banco ? opcoes.banco() : null; } catch (e) { return null; } };

  async function lerCadastro() {
    if (cadastro && cadastro.ate > Date.now()) return cadastro.v;
    const conds = [];
    for (let pg = 1; pg <= 5; pg++) {
      const j = await fila(() => opcoes.cliente().get('condominios/get', { id: -1, somenteCondominiosAtivos: 1, itensPorPagina: 500, pagina: pg }));
      if (!Array.isArray(j) || !j.length) break;
      conds.push(...j);
      if (j.length < 500) break;
    }
    if (!conds.length) { const e = new Error('cadastro_vazio'); e.status = 502; throw e; }
    const cnpjDe = new Map(); const outros = new Map();
    conds.forEach((c) => {
      const id = String(c.id_condominio_cond);
      const doc = String(c.st_cpf_cond || c.st_cnpj_cond || '').replace(/\D/g, ''); // o CNPJ vem em st_cpf_cond
      if (doc.length !== 14) return;
      cnpjDe.set(id, doc);
      if (!FORA_COMPARACAO.has(id)) outros.set(doc, String(c.st_fantasia_cond || c.st_nome_cond || '').trim());
    });
    cadastro = { ate: Date.now() + 6 * 3600000, v: { cnpjDe, outros } };
    return cadastro.v;
  }

  function guardar(chave, reg) {
    memoria.delete(chave);
    memoria.set(chave, reg);
    if (memoria.size > MAX_CACHE) memoria.delete(memoria.keys().next().value);
  }
  // Busca no cache: memória e depois o banco (em lotes de 40 chaves).
  async function doCache(chaves) {
    const out = new Map();
    const faltam = [];
    chaves.forEach((k) => { if (memoria.has(k)) out.set(k, memoria.get(k)); else faltam.push(k); });
    const b = banco();
    if (!b || !faltam.length) return out;
    for (let i = 0; i < faltam.length; i += 40) {
      const lote = faltam.slice(i, i + 40).map((k) => '"' + encodeURIComponent(k.replace(/"/g, '')) + '"').join(',');
      try {
        const linhas = await b.ler('fin_anexo_leitura?select=chave,leitura,texto,meta,extensao&chave=in.(' + lote + ')');
        (linhas || []).forEach((l) => { const reg = { leitura: l.leitura, texto: l.texto || '', meta: l.meta || {}, extensao: l.extensao || '' }; out.set(l.chave, reg); guardar(l.chave, reg); });
      } catch (e) { log('[anexos] cache do banco indisponível: ' + (e && e.message)); return out; }
    }
    return out;
  }
  async function gravarCache(linhas) {
    const b = banco();
    if (!b || !linhas.length) return;
    try { await b.upsert('fin_anexo_leitura', linhas, 'chave'); } catch (e) { log('[anexos] gravar cache falhou: ' + (e && e.message)); }
  }

  // Baixa (até 3 tentativas, pausa de 2 s em 429 ou erro do servidor). null = não deu.
  async function baixar(a) {
    for (let t = 1; t <= 3; t++) {
      const r = await fila(() => an.baixarAnexo(opcoes.cred(), a));
      if (r.status === 200 && an.corpoValido(r.corpo, extDe(a))) return r.corpo;
      if (r.status === 200 || (r.status >= 400 && r.status < 500 && r.status !== 429)) return null;
      await new Promise((ok) => setTimeout(ok, 2000 * t));
    }
    return null;
  }
  // Lê um anexo. antigo: o que o cache tinha (escaneado ainda sem leitura interna).
  // Devolve { reg, novo } (novo = vai para o cache do banco) ; reg.temporario = não guardar.
  async function lerArquivo(a, idCond, ctx, antigo) {
    const ext = extDe(a);
    if (!MIME[ext]) return { reg: { leitura: 'nao_pdf', extensao: ext, meta: {} } };
    if (Number(a.nm_tamanho_arq) > MAX_BYTES) return { reg: { leitura: 'falha', motivo: 'arquivo grande demais', temporario: true } };
    if (!downloadOk()) { ctx.estado.limite_downloads = true; return { reg: { leitura: 'falha', motivo: 'limite de downloads por hora', temporario: true } }; }
    const buf = await baixar(a);
    if (!buf) return { reg: { leitura: 'falha', motivo: 'não foi possível baixar', temporario: true } };
    let meta = antigo && antigo.meta ? Object.assign({}, antigo.meta) : {};
    if (ext === 'pdf' && !antigo) {
      const x = await extrairPdf(buf);
      if (x) meta = x.meta || {};
      if (x && an.legivel(x.texto)) return { reg: { leitura: 'texto', texto: x.texto.slice(0, MAX_TEXTO), meta, extensao: ext }, novo: true };
    }
    // Escaneado ou imagem: leitura interna, com o limite do usuário, o teto geral e auditoria.
    delete meta.interna_tentada;
    if (!ctx.lerInterna || buf.length > MAX_BYTES_INTERNA) return { reg: { leitura: 'escaneado', meta, extensao: ext }, novo: !antigo };
    if (!ctx.podeInterna()) {
      if (!ctx.estado.avisou_limite) { ctx.estado.avisou_limite = true; ctx.auditar('limite_processamento', { tipo: 'anexo_interna', id_superlogica: idCond }, true, 'volume_alto'); }
      ctx.estado.limite_interna = true;
      return { reg: { leitura: 'escaneado', meta, extensao: ext }, novo: !antigo };
    }
    if (!internaOk()) { ctx.estado.limite_interna = true; return { reg: { leitura: 'escaneado', meta, extensao: ext }, novo: !antigo }; }
    ctx.auditar('anexo_lido_interno', { id_superlogica: idCond, id_arquivo: String(a.id_arquivo_arq) });
    let rr = null;
    try { rr = await ctx.lerInterna({ mime: MIME[ext], base64: buf.toString('base64') }); } catch (e) { rr = null; }
    const t = rr && rr.status === 200 ? textoDaInterna(rr.corpo) : '';
    if (t) return { reg: { leitura: 'interna', texto: t, meta, extensao: ext }, novo: true };
    // Erro passageiro da leitura interna (sem resposta, 5xx): tenta de novo outro dia. Ilegível: não tenta mais.
    if (!rr || rr.status >= 500) return { reg: { leitura: 'escaneado', meta, extensao: ext }, novo: !antigo };
    return { reg: { leitura: 'escaneado', meta: Object.assign(meta, { interna_tentada: true }), extensao: ext }, novo: true };
  }

  async function rodar(idCond, c, ctx, t) {
    const [cad, lido] = await Promise.all([lerCadastro(), despesasPagas(opcoes.cliente(), fila, idCond, c)]);
    const itens = [];
    const vistos = new Set();
    lido.despesas.forEach((p) => (Array.isArray(p.arquivos) ? p.arquivos : []).forEach((a) => {
      if (!anexoValido(a)) return;
      const k = String(p.id_despesa_des) + '|' + a.id_arquivo_arq;
      if (vistos.has(k)) return;
      vistos.add(k);
      itens.push({ idDesp: String(p.id_despesa_des), anexo: a });
    }));
    t.total = itens.length;
    const cache = await doCache([...new Set(itens.map((it) => chaveDe(it.anexo)))]);
    const novos = [];
    const emCurso = new Map(); // mesmo arquivo em duas despesas: lê uma vez
    const leitor = criarFila(3);
    await Promise.all(itens.map(async (it) => {
      const k = chaveDe(it.anexo);
      const antes = cache.get(k);
      const precisa = !antes || (antes.leitura === 'escaneado' && !(antes.meta && antes.meta.interna_tentada) && ctx.lerInterna && !ctx.estado.limite_interna);
      if (!precisa) { it.reg = antes; t.feitos++; return; }
      // No máximo 3 arquivos em leitura (baixado e esperando o leitor) por conferência: segura a memória.
      if (!emCurso.has(k)) emCurso.set(k, leitor(() => lerArquivo(it.anexo, idCond, ctx, antes || null)));
      const r = await emCurso.get(k);
      it.reg = r.reg;
      if (!r.reg.temporario) {
        guardar(k, r.reg);
        if (r.novo && !novos.some((n) => n.chave === k)) {
          novos.push({ chave: k, id_arquivo: Number(it.anexo.id_arquivo_arq), id_superlogica: Number(idCond), extensao: r.reg.extensao || extDe(it.anexo),
            leitura: r.reg.leitura, texto: r.reg.texto || null, meta: r.reg.meta || {}, lido_em: new Date().toISOString() });
        }
      }
      t.feitos++;
      if (novos.length >= 50) { const lote = novos.splice(0, novos.length); await gravarCache(lote); }
    }));
    await gravarCache(novos);
    const r = montarResultado({ idCond, comp: c, itens, despesas: lido.despesas, cnpjCond: cad.cnpjDe.get(String(idCond)) || '', outros: cad.outros,
      cortado: lido.cortado, linkDe: (idDesp) => (opcoes.linkDe ? opcoes.linkDe(idDesp, idCond) : '') });
    r.gerado_em = new Date().toISOString();
    r.sem_cnpj_cadastro = !cad.cnpjDe.get(String(idCond));
    r.limite_interna = !!ctx.estado.limite_interna;
    r.limite_downloads = !!ctx.estado.limite_downloads;
    return r;
  }

  // Estado da conferência: { pronto, resultado } ou { calculando, feitos, total }.
  // forcar: lê de novo a lista de despesas (os arquivos já lidos continuam no cache), no máximo 1 vez por minuto.
  function estado(idCond, comp, ctx, forcar) {
    const c = competencia(comp);
    if (!c) { const e = new Error('competencia_invalida'); e.status = 400; throw e; }
    if (NAO_CONDOMINIOS.has(String(idCond))) { const e = new Error('nao_condominio'); e.status = 400; throw e; }
    const k = String(idCond) + '|' + c.rotulo;
    let t = trabalhos.get(k);
    const velho = t && t.resultado && t.ate < Date.now();
    const pedeForcar = forcar && t && (t.resultado || t.erro) && Date.now() - t.criado > 60000;
    const errou = t && t.erro && Date.now() - t.criado > 60000;
    if (!t || velho || pedeForcar || errou) {
      const ctx2 = Object.assign({ podeInterna: () => false, auditar: () => {} }, ctx || {}, { estado: {} });
      t = { feitos: 0, total: 0, inicio: new Date().toISOString(), criado: Date.now(), resultado: null, erro: null, ate: 0 };
      t.promessa = rodar(String(idCond), c, ctx2, t).then((r) => { t.resultado = r; t.ate = Date.now() + TTL_RESULTADO; },
        (e) => { t.erro = e; log('[anexos] ' + k + ' falhou: ' + (e && e.message)); });
      trabalhos.set(k, t);
      if (trabalhos.size > 300) trabalhos.delete(trabalhos.keys().next().value);
    }
    if (t.resultado) return { pronto: true, resultado: t.resultado };
    if (t.erro) { const e = new Error('falha_anexos'); e.status = 502; throw e; }
    return { calculando: true, feitos: t.feitos, total: t.total, desde: t.inicio };
  }
  // Espera até ms pelo resultado (usado pelo fechamento e pelos testes).
  async function aguardar(idCond, comp, ctx, ms) {
    const s = estado(idCond, comp, ctx, false);
    if (s.pronto) return s;
    const t = trabalhos.get(String(idCond) + '|' + competencia(comp).rotulo);
    await Promise.race([t.promessa, new Promise((ok) => setTimeout(ok, ms))]);
    return estado(idCond, comp, ctx, false);
  }
  // Só o que já está pronto, sem disparar leitura (quadro da carteira).
  function pronto(idCond, comp) {
    const t = trabalhos.get(String(idCond) + '|' + comp);
    return t && t.resultado ? t.resultado : null;
  }
  return { estado, aguardar, pronto, lerCadastro, _memoria: memoria };
}

module.exports = { criarConferenciaAnexos, montarResultado, paraTela, textoDaInterna, competencia, ACHADOS, NAO_CONDOMINIOS, criarContadorHora };
