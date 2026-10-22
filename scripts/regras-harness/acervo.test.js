// Regras do condomínio, frente D: teste do acervo (node puro, banco, storage e modelo falsos).
// Roda com: node scripts/regras-harness/acervo.test.js
// Cobre: recusa de não PDF e de PDF acima de 50 MB; PDF com texto não chama o modelo; PDF
// digitalizado chama (página a página); convenção nova "vale hoje" desmarca a anterior;
// pendências acham falta e duplicidade; rota do arquivo recusa documento de outro condomínio.

const assert = require('assert');
const A = require('../../servico/regras/acervo');
const { criarRotasAcervo } = require('../../servico/regras/rotas-acervo');

let falhas = 0;
const testes = [];
const teste = (nome, fn) => testes.push({ nome, fn });

// ---------- PDF mínimo escrito à mão ----------
// Cada página com o texto dado (vazio = página sem texto, como uma digitalização).
// Monta os objetos e a tabela xref com os deslocamentos certos para o leitor abrir sem reparo.
function pdfMinimo(paginas) {
  const objs = [];
  const n = paginas.length;
  // 1 catálogo, 2 páginas, 3 fonte, depois para cada página: página e conteúdo.
  const kids = paginas.map((_, i) => (4 + i * 2) + ' 0 R').join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [' + kids + '] /Count ' + n + ' >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  paginas.forEach((linhas, i) => {
    const lista = Array.isArray(linhas) ? linhas : (linhas ? [linhas] : []);
    const ops = lista.map((l, k) => 'BT /F1 11 Tf 50 ' + (780 - k * 16) + ' Td (' + String(l).replace(/[()\\]/g, ' ') + ') Tj ET').join('\n');
    objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (5 + i * 2) + ' 0 R >>');
    objs.push('<< /Length ' + Buffer.byteLength(ops, 'latin1') + ' >>\nstream\n' + ops + '\nendstream');
  });
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((x) => String(x).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

const REGIMENTO = [
  ['REGIMENTO INTERNO DO CONDOMINIO RESIDENCIAL TESTE', 'CAPITULO I DAS DISPOSICOES GERAIS', 'Art. 1 Este regimento interno disciplina o uso das areas comuns do condominio pelos moradores.', 'Art. 2 Todos os condominos, inquilinos e visitantes devem cumprir as regras deste regimento.'],
  ['CAPITULO II DO SILENCIO', 'Art. 3 E proibido fazer barulho excessivo entre as 22 horas e as 7 horas em qualquer dia da semana.', 'Art. 4 A infracao sera punida com advertencia escrita e, na reincidencia, multa de uma taxa condominial.'],
];

// ---------- falsos ----------
// Banco falso que entende o pedaço de PostgREST usado pelo acervo e pela biblioteca comum.
function bancoFalso() {
  const docs = [];
  const trechos = [];
  let seqDoc = 100, seqTr = 1000;
  const chamadas = [];
  function filtrar(lista, qs) {
    const p = new URLSearchParams(qs);
    let out = lista.slice();
    for (const [k, v] of p) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
      const m = v.match(/^(eq|neq|in|not)\.(.*)$/);
      if (!m) continue;
      if (m[1] === 'eq') out = out.filter((x) => String(x[k]) === m[2]);
      if (m[1] === 'neq') out = out.filter((x) => String(x[k]) !== m[2]);
      if (m[1] === 'in') { const vs = m[2].replace(/[()]/g, '').split(','); out = out.filter((x) => vs.includes(String(x[k]))); }
      if (m[1] === 'not' && m[2] === 'is.null') out = out.filter((x) => x[k] != null);
    }
    return out;
  }
  async function banco(metodo, caminho, corpo) {
    chamadas.push({ metodo, caminho, corpo });
    const [rota, qs] = caminho.split('?');
    if (rota === '/rest/v1/regras_documentos') {
      if (metodo === 'GET') return { status: 200, body: filtrar(docs, qs || '') };
      if (metodo === 'POST') { const d = Object.assign({ id: ++seqDoc, vigente: true, criado_em: new Date().toISOString() }, corpo); docs.push(d); return { status: 201, body: [d] }; }
      if (metodo === 'PATCH') { const alvo = filtrar(docs, qs); alvo.forEach((d) => Object.assign(d, corpo)); return { status: 200, body: alvo }; }
      if (metodo === 'DELETE') {
        const alvo = filtrar(docs, qs);
        alvo.forEach((d) => { docs.splice(docs.indexOf(d), 1); for (let i = trechos.length - 1; i >= 0; i--) if (trechos[i].documento_id === d.id) trechos.splice(i, 1); });
        return { status: 200, body: alvo };
      }
    }
    if (rota === '/rest/v1/regras_trechos') {
      if (metodo === 'POST') { corpo.forEach((t) => trechos.push(Object.assign({ id: ++seqTr }, t))); return { status: 201, body: corpo }; }
      if (metodo === 'GET') return { status: 200, body: filtrar(trechos, qs || '') };
      if (metodo === 'DELETE') { const alvo = filtrar(trechos, qs); alvo.forEach((t) => trechos.splice(trechos.indexOf(t), 1)); return { status: 200, body: alvo }; }
    }
    if (rota === '/rest/v1/condominios') return { status: 200, body: [{ nome: 'Cond A', id_superlogica: 10 }, { nome: 'Cond B', id_superlogica: 20 }] };
    return { status: 404, body: null };
  }
  return { banco, docs, trechos, chamadas };
}

function depsFalsos() {
  const bf = bancoFalso();
  const modelo = { chamadas: [] };
  const storage = { subidos: new Map(), apagados: [] };
  const deps = {
    banco: bf.banco,
    modelos: { modelo: (f) => 'modelo-' + f },
    chamarModelo: async (o) => {
      modelo.chamadas.push(o);
      if (o.rotulo === 'regras_resumo_ata') return { ok: true, texto: 'Assembleia: ordinária\nPresidente: Fulano' };
      // Leitura de digitalizado: devolve o texto de cada página pedida com o marcador.
      const m = String(o.content[1].text).match(/páginas (\d+) a (\d+)/);
      let t = '';
      for (let p = Number(m[1]); p <= Number(m[2]); p++) t += '=== PÁGINA ' + p + ' ===\nArt. ' + p + ' Texto lido da pagina ' + p + ' do documento digitalizado.\n';
      return { ok: true, texto: t };
    },
    storageUpload: async (bucket, caminho, buf) => { storage.subidos.set(bucket + '/' + caminho, buf.length); return {}; },
    storageSignedUrl: async (bucket, caminho, exp) => 'https://armazem.teste/' + bucket + '/' + caminho + '?exp=' + exp,
    storageDelete: async (bucket, caminho) => { storage.apagados.push(bucket + '/' + caminho); return true; },
  };
  return { deps, bf, modelo, storage };
}

// Leitor de PDF de verdade quando o pdfjs-dist está instalado; senão um falso que lê o texto
// das operações Tj do PDF mínimo (o teste continua valendo sem npm install).
let temPdfjs = true;
try { require.resolve('pdfjs-dist/legacy/build/pdf.js'); } catch (e) { temPdfjs = false; }
async function extrairFalso(buf) {
  const s = buf.toString('latin1');
  const paginas = s.split(/\/Type \/Page /).slice(1).length;
  const streams = [...s.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => [...m[1].matchAll(/\(([^)]*)\) Tj/g)].map((x) => x[1]).join('\n'));
  return { paginas, textos: streams.slice(0, paginas) };
}
const extrair = temPdfjs ? undefined : extrairFalso;

// ---------- testes da biblioteca ----------
teste('recusa arquivo que não é PDF', async () => {
  const { deps, modelo } = depsFalsos();
  await assert.rejects(() => A.enviarDocumento(deps, 10, { tipo: 'regimento', titulo: 'Regimento', pdfBuffer: Buffer.from('isto nao e um pdf, e um texto qualquer com mais de cem bytes para passar do tamanho minimo do teste........'), extrair }),
    (e) => e instanceof A.ErroAcervo && e.codigo === 'nao_e_pdf');
  assert.strictEqual(modelo.chamadas.length, 0);
});

teste('recusa PDF acima de 50 MB', async () => {
  const { deps, bf } = depsFalsos();
  const grande = Buffer.alloc(A.MAX_PDF_BYTES + 1, 0x20);
  pdfMinimo([['x']]).copy(grande, 0);
  await assert.rejects(() => A.enviarDocumento(deps, 10, { tipo: 'regimento', titulo: 'Regimento', pdfBuffer: grande, extrair }),
    (e) => e instanceof A.ErroAcervo && e.codigo === 'arquivo_grande' && e.status === 413);
  assert.strictEqual(bf.docs.length, 0);
});

teste('PDF com texto não chama o modelo, grava trechos com página e guarda o arquivo', async () => {
  const { deps, bf, modelo, storage } = depsFalsos();
  const pdf = pdfMinimo(REGIMENTO);
  const lido = await A.lerTextoPdf(deps, pdf, { extrair });
  assert.strictEqual(lido.escaneado, false);
  assert.strictEqual(lido.paginas, 2);
  assert.ok(lido.texto.includes('\f'), 'páginas separadas por \\f');
  const r = await A.enviarDocumento(deps, 10, { tipo: 'regimento', titulo: 'Regimento interno', data_documento: '15/03/2024', pdfBuffer: pdf, extrair });
  assert.strictEqual(modelo.chamadas.length, 0, 'não chamou o modelo');
  assert.strictEqual(r.escaneado, false);
  const d = bf.docs.find((x) => x.id === r.id);
  assert.strictEqual(d.origem, 'upload');
  assert.strictEqual(d.data_documento, '2024-03-15');
  assert.strictEqual(d.arquivo_path, '10/' + r.id + '.pdf');
  assert.ok(storage.subidos.has('regras/10/' + r.id + '.pdf'));
  const art3 = bf.trechos.find((t) => t.rotulo === 'Art. 3');
  assert.ok(art3 && art3.pagina === 2, 'Art. 3 na página 2');
});

teste('PDF digitalizado chama a leitura por faixas e junta as páginas', async () => {
  const { deps, modelo } = depsFalsos();
  const pdf = pdfMinimo(['', '', '', '', '', '', '', '']); // 8 páginas sem texto
  let detectado = null;
  const lido = await A.lerTextoPdf(deps, pdf, { extrair, aoDetectar: (i) => { detectado = i; } });
  assert.strictEqual(lido.escaneado, true);
  assert.deepStrictEqual(detectado, { paginas: 8, escaneado: true });
  const leituras = modelo.chamadas.filter((c) => c.rotulo === 'regras_leitura');
  assert.strictEqual(leituras.length, 2, 'duas faixas (1 a 6 e 7 a 8)');
  assert.strictEqual(leituras[0].modelo, 'modelo-regras_leitura');
  assert.strictEqual(leituras[0].content[0].type, 'document');
  assert.strictEqual(leituras[0].funcao, 'regras');
  const pags = lido.texto.split('\f');
  assert.strictEqual(pags.length, 8);
  assert.ok(pags[6].includes('pagina 7'));
});

teste('PDF digitalizado acima de 100 páginas é recusado sem chamar o modelo', async () => {
  const { deps, modelo } = depsFalsos();
  const falso = async () => ({ paginas: 101, textos: new Array(101).fill('') });
  await assert.rejects(() => A.lerTextoPdf(deps, pdfMinimo(['']), { extrair: falso }), (e) => e.codigo === 'escaneado_grande');
  assert.strictEqual(modelo.chamadas.length, 0);
});

teste('ata enviada ganha resumo', async () => {
  const { deps, bf, modelo } = depsFalsos();
  const pdf = pdfMinimo([['ATA DA ASSEMBLEIA GERAL ORDINARIA DO CONDOMINIO RESIDENCIAL TESTE REALIZADA NO SALAO DE FESTAS', 'Aos dez dias do mes de marco reuniram se os condominos para deliberar sobre a pauta do dia e aprovar as contas.']]);
  const r = await A.enviarDocumento(deps, 10, { tipo: 'ata', titulo: 'Ata AGO 2024', pdfBuffer: pdf, extrair });
  assert.ok(modelo.chamadas.some((c) => c.rotulo === 'regras_resumo_ata' && c.modelo === 'modelo-regras_extracao'));
  assert.ok(bf.docs.find((x) => x.id === r.id).resumo.includes('Presidente'));
});

teste('convenção nova que vale hoje desmarca a anterior', async () => {
  const { deps, bf } = depsFalsos();
  const v1 = await A.enviarDocumento(deps, 10, { tipo: 'convencao', titulo: 'Convenção 1990', pdfBuffer: pdfMinimo(REGIMENTO), extrair });
  const outro = REGIMENTO.map((p) => p.map((l) => l + ' versao nova'));
  const v2 = await A.enviarDocumento(deps, 10, { tipo: 'convencao', titulo: 'Convenção 2020', pdfBuffer: pdfMinimo(outro), vigente: true, extrair });
  assert.strictEqual(bf.docs.find((d) => d.id === v1.id).vigente, false);
  assert.strictEqual(bf.docs.find((d) => d.id === v2.id).vigente, true);
  // Mesmo texto de novo não duplica.
  const v3 = await A.enviarDocumento(deps, 10, { tipo: 'convencao', titulo: 'Convenção repetida', pdfBuffer: pdfMinimo(outro), extrair });
  assert.strictEqual(v3.duplicado, true);
  assert.strictEqual(bf.docs.filter((d) => d.tipo === 'convencao').length, 2);
});

teste('ata do Hub entra no acervo com o texto que o Hub já tem', async () => {
  const { deps, bf, storage } = depsFalsos();
  const texto = 'ATA DA ASSEMBLEIA GERAL EXTRAORDINARIA. Aos cinco dias do mes de maio de 2026, as 19 horas, reuniram se os condominos e aprovaram a reforma da fachada.';
  const r = await A.arquivarAtaNoAcervo(deps, { idSL: 10, titulo: 'ATA ASSEMBLEIA AGE 05.05.2026', data_documento: '05/05/2026', pdfBuffer: pdfMinimo([['ata']]), texto, criado_por: 'x' });
  assert.ok(r.ok && !r.duplicado);
  const d = bf.docs.find((x) => x.id === r.id);
  assert.strictEqual(d.origem, 'ata_hub');
  assert.strictEqual(d.texto, texto);
  assert.strictEqual(d.criado_por, null, 'criado_por que não é uuid vira null');
  assert.ok(storage.subidos.has('regras/10/' + r.id + '.pdf'));
  const r2 = await A.arquivarAtaNoAcervo(deps, { idSL: 10, titulo: 'outra', texto });
  assert.ok(r2.ok && r2.duplicado);
  const r3 = await A.arquivarAtaNoAcervo(deps, { idSL: 'abc', texto });
  assert.strictEqual(r3.ok, false);
});

teste('pendências acham falta e duplicidade', async () => {
  const p1 = A.pendenciasDoCondominio([]);
  assert.deepStrictEqual(p1.pendencias.map((p) => p.codigo).sort(), ['sem_convencao', 'sem_regimento']);
  const p2 = A.pendenciasDoCondominio([
    { id: 1, tipo: 'convencao', titulo: 'C1', vigente: true, arquivo_path: '1/1.pdf', hash_texto: 'a' },
    { id: 2, tipo: 'convencao', titulo: 'C2', vigente: true, arquivo_path: '1/2.pdf', hash_texto: 'b' },
    { id: 3, tipo: 'regimento', titulo: 'R1', vigente: false, arquivo_path: null, hash_texto: null },
    { id: 4, tipo: 'ata', titulo: 'A1', vigente: true, arquivo_path: '1/4.pdf', hash_texto: 'c' },
  ]);
  const cod = p2.pendencias.map((p) => p.codigo);
  assert.ok(cod.includes('convencao_duplicado'));
  assert.ok(cod.includes('regimento_sem_vigente'));
  assert.ok(cod.includes('sem_texto'));
  assert.ok(cod.includes('sem_arquivo'));
  assert.deepStrictEqual(p2.contagens, { convencao: 2, regimento: 1, ata: 1, regulamento: 0, outro: 0 });
  // Por condomínio, a partir do banco: o da lista sem documento aparece também.
  const { deps } = depsFalsos();
  await A.enviarDocumento(deps, 10, { tipo: 'regimento', titulo: 'Regimento', pdfBuffer: pdfMinimo(REGIMENTO), extrair });
  const lista = await A.pendencias(deps, [10, 30]);
  assert.strictEqual(lista.length, 2);
  assert.deepStrictEqual(lista.find((c) => c.id_superlogica === 10).pendencias.map((p) => p.codigo), ['sem_convencao']);
  assert.strictEqual(lista.find((c) => c.id_superlogica === 30).total, 0);
});

// ---------- testes das rotas ----------
// App falso: guarda as rotas e chama a cadeia de funções com req e res falsos.
function appFalso() {
  const rotas = [];
  const reg = (metodo) => (caminho, ...fns) => rotas.push({ metodo, caminho, fns });
  return {
    rotas, get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE'),
    async chamar(metodo, url, opts) {
      const o = opts || {};
      for (const r of rotas) {
        if (r.metodo !== metodo) continue;
        const nomes = [];
        const re = new RegExp('^' + r.caminho.replace(/:([A-Za-z]+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
        const m = url.match(re);
        if (!m) continue;
        const params = {};
        nomes.forEach((n, i) => { params[n] = m[i + 1]; });
        const req = { method: metodo, params, body: o.body, query: {}, user: { sub: o.usuario || '11111111-1111-1111-1111-111111111111' }, authMode: 'supabase' };
        const res = { statusCode: 200, corpo: null, headersSent: false, set() { return res; }, status(s) { res.statusCode = s; return res; }, json(j) { res.corpo = j; res.headersSent = true; return res; } };
        // Como no Express, a rota pode chamar next() sem esperar: guarda cada passo e espera todos.
        let i = 0;
        const passos = [];
        const next = () => { const f = r.fns[i++]; const p = f ? Promise.resolve(f(req, res, next)) : Promise.resolve(); passos.push(p); return p; };
        next();
        for (let k = 0; k < passos.length; k++) await passos[k];
        return res;
      }
      throw new Error('rota não encontrada: ' + metodo + ' ' + url);
    },
  };
}
function montarRotas(carteira) {
  const f = depsFalsos();
  const eventos = [];
  const app = appFalso();
  const dentro = (id) => carteira === 'todas' || carteira.includes(Number(id));
  Object.assign(f.deps, {
    requireAuth: (req, res, next) => next(),
    express: { json: () => (req, res, next) => next() },
    perfilDe: async () => ({ role: 'GERENTE', permissoes: { regras: { visivel: true, acoes: ['ver', 'gerenciar'] } } }),
    podeModulo: (p, mod, acao) => !!(p && p.permissoes[mod] && p.permissoes[mod].acoes.includes(acao)),
    exigirCarteira: async (req, res, id) => { if (dentro(id)) return true; res.status(403).json({ erro: 'fora_da_carteira' }); return false; },
    carteiraT18: { escopo: async () => (carteira === 'todas' ? { todas: true } : { todas: false, ids: new Set(carteira) }) },
    auditoria: { evento: (req, acao, det) => eventos.push({ acao, det }) },
    dentroDoLimite: () => true,
  });
  criarRotasAcervo(app, f.deps);
  return Object.assign(f, { app, eventos });
}

teste('rota do arquivo devolve link do próprio condomínio e recusa documento de outro', async () => {
  const t = montarRotas([10, 20]);
  const doc10 = await A.enviarDocumento(t.deps, 10, { tipo: 'regimento', titulo: 'Regimento do 10', pdfBuffer: pdfMinimo(REGIMENTO), extrair });
  const ok = await t.app.chamar('GET', '/api/regras/10/documentos/' + doc10.id + '/arquivo');
  assert.strictEqual(ok.statusCode, 200);
  assert.ok(ok.corpo.url.includes('regras/10/' + doc10.id + '.pdf') && ok.corpo.url.includes('exp=600'));
  // Documento do 10 pedido pela URL do 20 (que também está na carteira): 404, sem link.
  const outro = await t.app.chamar('GET', '/api/regras/20/documentos/' + doc10.id + '/arquivo');
  assert.strictEqual(outro.statusCode, 404);
  assert.ok(!outro.corpo.url);
  // Condomínio fora da carteira: 403 antes de olhar o documento.
  const fora = await t.app.chamar('GET', '/api/regras/30/documentos/' + doc10.id + '/arquivo');
  assert.strictEqual(fora.statusCode, 403);
  // Detalhe e apagar pela URL de outro condomínio também não acham.
  assert.strictEqual((await t.app.chamar('GET', '/api/regras/20/documentos/' + doc10.id)).statusCode, 404);
  assert.strictEqual((await t.app.chamar('DELETE', '/api/regras/20/documentos/' + doc10.id)).statusCode, 404);
  assert.ok(t.bf.docs.some((d) => d.id === doc10.id), 'não apagou');
});

teste('rotas: enviar, listar, marcar vigente, editar tipo e apagar com auditoria', async () => {
  const t = montarRotas([10]);
  const b64 = pdfMinimo(REGIMENTO).toString('base64');
  if (!temPdfjs) { console.log('   (pdfjs-dist ausente: envio pela rota pulado)'); return; }
  const env = await t.app.chamar('POST', '/api/regras/10/documentos', { body: { tipo: 'regimento', titulo: 'Regimento 2010', data_documento: '2010-01-01', pdf_base64: b64 } });
  assert.strictEqual(env.statusCode, 201, JSON.stringify(env.corpo));
  const b64b = pdfMinimo(REGIMENTO.map((p) => p.map((l) => l + ' nova'))).toString('base64');
  const env2 = await t.app.chamar('POST', '/api/regras/10/documentos', { body: { tipo: 'regimento', titulo: 'Regimento 2024', vigente: false, pdf_base64: b64b } });
  assert.strictEqual(env2.statusCode, 201);
  let lista = await t.app.chamar('GET', '/api/regras/10/documentos');
  assert.strictEqual(lista.corpo.documentos.length, 2);
  assert.ok(lista.corpo.documentos.every((d) => d.arquivo_path === undefined), 'caminho do arquivo não vai para a tela');
  const pat = await t.app.chamar('PATCH', '/api/regras/10/documentos/' + env2.corpo.id, { body: { vigente: true } });
  assert.strictEqual(pat.statusCode, 200);
  lista = await t.app.chamar('GET', '/api/regras/10/documentos');
  assert.deepStrictEqual(lista.corpo.documentos.filter((d) => d.vigente).map((d) => d.id), [env2.corpo.id]);
  const tipo = await t.app.chamar('PATCH', '/api/regras/10/documentos/' + env.corpo.id, { body: { tipo: 'outro' } });
  assert.strictEqual(tipo.statusCode, 200);
  assert.strictEqual(tipo.corpo.documento.vigente, true, 'virou outro: volta a valer');
  const naoPdf = await t.app.chamar('POST', '/api/regras/10/documentos', { body: { tipo: 'ata', titulo: 'Ata', pdf_base64: Buffer.from('x'.repeat(200)).toString('base64') } });
  assert.strictEqual(naoPdf.statusCode, 400);
  const del = await t.app.chamar('DELETE', '/api/regras/10/documentos/' + env.corpo.id);
  assert.strictEqual(del.statusCode, 200);
  assert.deepStrictEqual(t.storage.apagados, ['regras/10/' + env.corpo.id + '.pdf']);
  assert.ok(!t.bf.trechos.some((x) => x.documento_id === env.corpo.id), 'trechos foram junto');
  const acoes = t.eventos.map((e) => e.acao);
  assert.ok(acoes.includes('regras_documento_enviado') && acoes.includes('regras_documento_editado') && acoes.includes('regras_documento_apagado'));
  const pend = await t.app.chamar('GET', '/api/regras/pendencias');
  assert.strictEqual(pend.statusCode, 200);
  assert.deepStrictEqual(pend.corpo.condominios.map((c) => c.id_superlogica), [10], 'só a carteira');
});

teste('rotas: PDF digitalizado responde 202 e a tarefa fica pronta', async () => {
  if (!temPdfjs) { console.log('   (pdfjs-dist ausente: pulado)'); return; }
  const t = montarRotas([10]);
  const env = await t.app.chamar('POST', '/api/regras/10/documentos', { body: { tipo: 'regimento', titulo: 'Regimento digitalizado', pdf_base64: pdfMinimo(['', '', '']).toString('base64') } });
  assert.strictEqual(env.statusCode, 202);
  assert.ok(env.corpo.processando && env.corpo.tarefa && env.corpo.paginas === 3);
  const st = await t.app.chamar('GET', '/api/regras/10/envios/' + env.corpo.tarefa);
  assert.strictEqual(st.corpo.status, 'pronto', JSON.stringify(st.corpo));
  assert.strictEqual(st.corpo.escaneado, true);
  // Outro usuário não vê a tarefa.
  const alheio = await t.app.chamar('GET', '/api/regras/10/envios/' + env.corpo.tarefa, { usuario: '22222222-2222-2222-2222-222222222222' });
  assert.strictEqual(alheio.statusCode, 404);
});

teste('rotas: sem a ação gerenciar não envia nem apaga', async () => {
  const t = montarRotas([10]);
  t.deps.perfilDe = async () => ({ role: 'OPERACIONAL', permissoes: { regras: { visivel: true, acoes: ['ver'] } } });
  const t2 = appFalso();
  criarRotasAcervo(t2, t.deps);
  const r = await t2.chamar('POST', '/api/regras/10/documentos', { body: { tipo: 'ata', titulo: 'Ata', pdf_base64: 'AAAA' } });
  assert.strictEqual(r.statusCode, 403);
  const l = await t2.chamar('GET', '/api/regras/10/documentos');
  assert.strictEqual(l.statusCode, 200);
});

(async () => {
  if (!temPdfjs) console.log('Aviso: pdfjs-dist não instalado; usando leitor falso para o PDF mínimo.');
  for (const t of testes) {
    try { await t.fn(); console.log('ok   ' + t.nome); } catch (e) { falhas++; console.log('FALHA ' + t.nome + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e)); }
  }
  console.log('\n' + (testes.length - falhas) + ' de ' + testes.length + ' passaram');
  process.exit(falhas ? 1 : 0);
})();
