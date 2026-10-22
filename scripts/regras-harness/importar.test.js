// Harness da frente A (importação do CondGPT): node puro, banco falso em memória que entende
// o pedaço do PostgREST que o importador usa (eq, neq, like com *, is.null, limit, offset).
// Rodar: node scripts/regras-harness/importar.test.js

const assert = require('assert');
const path = require('path');
const I = require(path.join(__dirname, '../../servico/regras/importar-condgpt'));
const { criarRotasImportar } = require(path.join(__dirname, '../../servico/regras/rotas-importar'));

let falhas = 0, passou = 0;
async function teste(nome, fn) {
  try { await fn(); passou++; console.log('ok   ' + nome); } catch (e) { falhas++; console.log('FALHA ' + nome + '\n      ' + (e && e.stack || e).split('\n').slice(0, 3).join('\n      ')); }
}

// Banco falso: tabelas em memória e índices únicos da migration 020.
function bancoFalso() {
  const tabelas = { regras_documentos: [], regras_trechos: [], regras_notificacoes: [], regras_mapa_condgpt: [] };
  let seq = 1;
  const chamadas = [];
  const casa = (v, op, alvo) => {
    if (op === 'eq') return String(v) === alvo;
    if (op === 'neq') return String(v) !== alvo;
    if (op === 'is') return alvo === 'null' ? v == null : String(v) === alvo;
    if (op === 'like') {
      const re = new RegExp('^' + alvo.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's');
      return v != null && re.test(String(v));
    }
    throw new Error('operador não suportado: ' + op);
  };
  function filtrar(linhas, params) {
    let out = linhas.filter((l) => [...params.entries()].every(([k, v]) => {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) return true;
      const i = v.indexOf('.');
      return casa(l[k], v.slice(0, i), v.slice(i + 1));
    }));
    const off = Number(params.get('offset') || 0);
    const lim = params.get('limit') ? Number(params.get('limit')) : 1000;
    return out.slice(off, off + lim);
  }
  function unicoViolado(tab, linha) {
    const t = tabelas[tab];
    if (tab === 'regras_documentos' && linha.hash_texto) return t.some((x) => x.id_superlogica === linha.id_superlogica && x.tipo === linha.tipo && x.hash_texto === linha.hash_texto);
    if (tab === 'regras_notificacoes' && linha.origem_id) return t.some((x) => x.origem === linha.origem && x.origem_id === linha.origem_id);
    if (tab === 'regras_mapa_condgpt') return t.some((x) => x.slug === linha.slug);
    return false;
  }
  async function banco(metodo, caminho, corpo) {
    chamadas.push(metodo + ' ' + caminho.split('?')[0]);
    const u = new URL('http://x' + caminho);
    const tab = u.pathname.replace('/rest/v1/', '');
    if (!tabelas[tab]) return { status: 404, body: null };
    const p = u.searchParams;
    if (metodo === 'GET') return { status: 200, body: filtrar(tabelas[tab], p).map((l) => Object.assign({}, l)) };
    if (metodo === 'POST') {
      const lista = Array.isArray(corpo) ? corpo : [corpo];
      for (const l of lista) if (unicoViolado(tab, l)) return { status: 409, body: { code: '23505' } };
      const criadas = lista.map((l) => {
        const row = Object.assign({ id: seq++ }, l);
        if (tab === 'regras_documentos' && row.vigente === undefined) row.vigente = true;
        if (tab === 'regras_mapa_condgpt') delete row.id;
        tabelas[tab].push(row);
        return Object.assign({}, row);
      });
      return { status: 201, body: criadas };
    }
    if (metodo === 'PATCH') {
      const alvo = filtrar(tabelas[tab], p);
      alvo.forEach((l) => {
        const real = tabelas[tab].find((x) => x === l || (x.id != null ? x.id === l.id : x.slug === l.slug));
        Object.assign(real, corpo);
      });
      return { status: 200, body: alvo };
    }
    if (metodo === 'DELETE') {
      const alvo = new Set(filtrar(tabelas[tab], p).map((l) => l.id));
      tabelas[tab] = tabelas[tab].filter((l) => !alvo.has(l.id));
      return { status: 200, body: [] };
    }
    return { status: 405, body: null };
  }
  return { banco, tabelas, chamadas };
}

const REGIMENTO_V1 = 'REGIMENTO INTERNO\nArt. 1 Este regimento vale para todos.\nArt. 2 Silêncio depois das 22h.\nArt. 3 Multa de uma taxa.\nAprovado em assembleia de 10 de março de 2015.';
const REGIMENTO_V2 = 'REGIMENTO INTERNO\nArt. 1 Este regimento vale para todos os moradores.\nArt. 2 Silêncio depois das 23h.\nArt. 3 Multa de duas taxas.';
const CONVENCAO = 'CONVENÇÃO DE CONDOMÍNIO\nArt. 1 O condomínio se rege por esta convenção.\nArt. 2 Assembleia ordinária uma vez por ano.\nArt. 3 Quórum de metade mais um.';
const ATA = 'ATA DA ASSEMBLEIA GERAL ORDINÁRIA\nAos vinte e sete dias de novembro de 2024 reuniram se os condôminos para eleição do síndico. Ficou aprovada a prestação de contas.';

function blocoExemplo() {
  return {
    label: 'Residencial Teste',
    dados: { nome: 'Residencial Teste', inscricao: '11222333000144' },
    docs: [
      { id: 10, tipo: 'Regimento interno', nome: 'Regimento interno', texto: REGIMENTO_V1, created_at: '2023-01-05 10:00:00', url_download: 'https://condominio.condgpt.app/arquivos?path=resteste/aaa-111.pdf' },
      { id: 11, tipo: 'Regimento interno', nome: 'Regimento interno', texto: REGIMENTO_V2, created_at: '2024-06-01 10:00:00', url_download: 'https://condominio.condgpt.app/arquivos?path=resteste/bbb-222.pdf' },
      { id: 12, tipo: 'Convenção', nome: 'Convenção', texto: CONVENCAO, created_at: '2023-01-05 10:00:00', arquivo_pdf: 'resteste/ccc-333.pdf' },
      { id: 13, tipo: 'Atas', nome: '2024-11-27 (AGO)', texto: ATA, resumo: 'Eleição do síndico.', created_at: '2024-12-01 10:00:00', url_download: 'https://condominio.condgpt.app/arquivos?path=resteste/ddd-444.pdf' },
      { id: 14, tipo: 'Atas', nome: '2024-11-27 (AGO) (2)', texto: ATA + '\nSegunda via.', created_at: '2024-12-02 10:00:00', url_download: 'https://condominio.condgpt.app/arquivos?path=outrocond/eee-555.pdf' },
    ],
    notif: [
      { id: 501, unidade: '206 1', tipo_formatted: 'Advertência', ocorrencia: '<p>Barulho &agrave;s 2h</p>', texto: '<p>Prezado cond&ocirc;mino,</p><p>Notificamos&nbsp;que<br>o Art. 2&ordm; foi descumprido.</p>', rascunho: 1, created_at: '2024-05-10 09:00:00' },
      { id: 502, unidade: '602', tipo_formatted: 'Multa', ocorrencia: 'Vaga ocupada', texto: '<div>Multa aplicada.</div>', rascunho: 0, created_at: '2024-05-11 09:00:00' },
    ],
    com: [{ id: 7, titulo: 'Limpeza da caixa', texto: '<p>Dia 10 sem &aacute;gua.</p>', created_at: '2024-02-01 08:00:00' }],
    atas: [
      { id: 90, nome: 'AGO novembro', texto_final: 'Aos 27 dias do mês de novembro de 2024 reuniram se...', status: 'finalizada', created_at: '2024-11-28' },
      { id: 91, nome: 'AGE março', texto_final: 'Aos 5 dias do mês de março de 2025, em assembleia extraordinária, os condôminos...', status: 'finalizada', created_at: '2025-03-06' },
      { id: 92, nome: 'rascunho', texto_final: '', status: 'gravando', created_at: '2025-04-01' },
    ],
  };
}

(async () => {
  await teste('tipos do CondGPT', () => {
    assert.strictEqual(I.mapearTipo('Atas'), 'ata');
    assert.strictEqual(I.mapearTipo('Convenção'), 'convencao');
    assert.strictEqual(I.mapearTipo('Regimento interno'), 'regimento');
    assert.strictEqual(I.mapearTipo('Planta'), null);
  });

  await teste('data pelo nome da ata', () => {
    assert.strictEqual(I.dataDoNome('2024-11-27 (AGO)'), '2024-11-27');
    assert.strictEqual(I.dataDoNome('2024-11-27 (AGO) (2)'), '2024-11-27');
    assert.strictEqual(I.dataDoNome('2024-02-31 (AGE)'), null);
    assert.strictEqual(I.dataDoNome('Convenção'), null);
    assert.strictEqual(I.tituloDocumento('ata', '2024-11-27 (AGO) (2)'), 'Ata AGO de 27/11/2024 (2)');
    assert.strictEqual(I.tituloDocumento('ata', '2024-11-27 (AGO)'), 'Ata AGO de 27/11/2024');
    assert.strictEqual(I.tituloDocumento('convencao', 'Convenção'), 'Convenção');
  });

  await teste('convenção e regimento sem data, a não ser que o texto deixe claro', () => {
    assert.strictEqual(I.dataDaNorma(CONVENCAO), null);
    assert.strictEqual(I.dataDaNorma(REGIMENTO_V1), '2015-03-10');
    assert.strictEqual(I.dataDaNorma('Aprovado em 10/03/2015.\nArt. 1 x\nAprovada a alteração em 05/06/2019.'), null, 'duas datas diferentes não é claro');
    assert.strictEqual(I.dataAtaGerada({ nome: 'AGO', texto_final: 'Aos 27 dias do mês de novembro de 2024 reuniram' }), '2024-11-27');
  });

  await teste('notificação: HTML vira texto, unidade e bloco separados', () => {
    const n = I.converterNotificacao(blocoExemplo().notif[0], 'resteste', 77, null);
    assert.strictEqual(n.tipo, 'advertencia');
    assert.strictEqual(n.unidade, '206');
    assert.strictEqual(n.bloco, '1');
    assert.strictEqual(n.status, 'rascunho');
    assert.strictEqual(n.origem, 'condgpt');
    assert.strictEqual(n.origem_id, 'condgpt:resteste:501');
    assert.strictEqual(n.ocorrencia, 'Barulho às 2h');
    assert.strictEqual(n.texto, 'Prezado condômino,\n\nNotificamos que\no Art. 2º foi descumprido.');
    assert.ok(!/[<>]/.test(n.texto));
    const m = I.converterNotificacao(blocoExemplo().notif[1], 'resteste', 77, null);
    assert.strictEqual(m.tipo, 'multa');
    assert.strictEqual(m.status, 'registrada');
    assert.deepStrictEqual(I.separarUnidade('603 potira'), { unidade: '603', bloco: 'potira', original: '603 potira' });
    assert.deepStrictEqual(I.separarUnidade('1104 1'), { unidade: '1104', bloco: '1', original: '1104 1' });
    assert.deepStrictEqual(I.separarUnidade('Bloco B apto 101'), { unidade: '101', bloco: 'B', original: 'Bloco B apto 101' });
    assert.deepStrictEqual(I.separarUnidade('loja térrea'), { unidade: 'loja térrea', bloco: null, original: 'loja térrea' });
  });

  await teste('mapa pelo CNPJ: viladeitaunas ignorado, sem correspondência e manual mantido', () => {
    const conds = [
      { slug: 'viladeitaunas', label: 'Vila de Itaúnas', cnpj: '24.902.992/0001-00' },
      { slug: 'spazioviladeitaunas', label: 'Spazio Vila de Itaúnas', cnpj: '61404163000124' },
      { slug: 'semnada', label: 'Sem Nada', cnpj: '99999999000199' },
      { slug: 'manual1', label: 'Manual', cnpj: '' },
    ];
    const sl = [
      { id_condominio_cond: '150', st_nome_cond: 'CONDOMINIO SPAZIO VILA DE ITAUNAS', st_cnpj_cond: '61.404.163/0001-24' },
      { id_condominio_cond: '1', st_nome_cond: 'ADMINISTRADORA', st_cnpj_cond: '24.902.992/0001-00' },
      { id_condominio_cond: '88', st_nome_cond: 'MANUAL', st_cnpj_cond: '' },
    ];
    const mapa = I.montarMapa(conds, sl, [{ slug: 'manual1', id_superlogica: 88, observacao: 'informado manualmente por x' }]);
    const por = Object.fromEntries(mapa.map((m) => [m.slug, m]));
    assert.strictEqual(por.viladeitaunas.situacao, 'ignorado');
    assert.strictEqual(por.viladeitaunas.id_superlogica, null);
    assert.strictEqual(por.spazioviladeitaunas.id_superlogica, 150);
    assert.strictEqual(por.spazioviladeitaunas.situacao, 'ok');
    assert.strictEqual(por.semnada.situacao, 'sem_correspondencia');
    assert.strictEqual(por.manual1.situacao, 'manual');
    assert.strictEqual(por.manual1.id_superlogica, 88);
  });

  const F = bancoFalso();
  const ctx = { slug: 'resteste', idSL: 77, cnpj: '11222333000144', criadoPor: null };
  let r1;
  await teste('importação de um condomínio', async () => {
    r1 = await I.importarCondominio(F.banco, ctx, blocoExemplo());
    assert.strictEqual(r1.documentos.novos, 5);
    assert.strictEqual(r1.notificacoes.novos, 2);
    assert.strictEqual(r1.comunicados.novos, 1);
    const docs = F.tabelas.regras_documentos;
    const com = docs.find((d) => d.tipo === 'outro');
    assert.strictEqual(com.titulo, 'Comunicado: Limpeza da caixa');
    assert.strictEqual(com.texto, 'Dia 10 sem água.');
    const ata = docs.find((d) => d.tipo === 'ata' && d.titulo === 'Ata AGO de 27/11/2024');
    assert.strictEqual(ata.data_documento, '2024-11-27');
    assert.strictEqual(ata.resumo, 'Eleição do síndico.');
    assert.ok(/condgpt_pdf:resteste\/ddd-444\.pdf/.test(ata.observacao));
    assert.ok(F.tabelas.regras_trechos.length > 0, 'trechos gravados');
    // PDF de outro condomínio no caminho não é aceito.
    assert.ok(!r1.pdfs.some((p) => /outrocond/.test(p.path)));
    assert.strictEqual(r1.pdfs.length, 4);
  });

  await teste('ata gerada no CondGPT só entra se não houver ata na mesma data', () => {
    const geradas = F.tabelas.regras_documentos.filter((d) => /ata gerada no CondGPT/.test(d.observacao || ''));
    assert.strictEqual(geradas.length, 1);
    assert.strictEqual(geradas[0].data_documento, '2025-03-05');
    assert.strictEqual(r1.atas_geradas.mesma_data, 1);
    assert.strictEqual(r1.atas_geradas.sem_texto, 1);
  });

  await teste('duas versões do regimento: vigente só a mais recente, observação nas duas', () => {
    const regs = F.tabelas.regras_documentos.filter((d) => d.tipo === 'regimento');
    assert.strictEqual(regs.length, 2);
    const nova = regs.find((d) => /23h/.test(d.texto));
    const velha = regs.find((d) => /22h/.test(d.texto));
    assert.strictEqual(nova.vigente, true);
    assert.strictEqual(velha.vigente, false);
    regs.forEach((d) => assert.ok(/duas versões no CondGPT, conferir qual vale/.test(d.observacao)));
    assert.strictEqual(velha.data_documento, '2015-03-10');
    const conv = F.tabelas.regras_documentos.find((d) => d.tipo === 'convencao');
    assert.strictEqual(conv.vigente, true);
    assert.ok(!/duas versões/.test(conv.observacao || ''));
  });

  await teste('idempotência: rodar de novo não duplica nada', async () => {
    const antes = { d: F.tabelas.regras_documentos.length, n: F.tabelas.regras_notificacoes.length, t: F.tabelas.regras_trechos.length };
    const r2 = await I.importarCondominio(F.banco, ctx, blocoExemplo());
    assert.strictEqual(F.tabelas.regras_documentos.length, antes.d);
    assert.strictEqual(F.tabelas.regras_notificacoes.length, antes.n);
    assert.strictEqual(F.tabelas.regras_trechos.length, antes.t);
    assert.strictEqual(r2.documentos.novos, 0);
    assert.strictEqual(r2.notificacoes.novos, 0);
    assert.strictEqual(r2.notificacoes.duplicados, 2);
    assert.strictEqual(r2.comunicados.novos, 0);
    assert.strictEqual(r2.atas_geradas.novos, 0);
    // PDFs ainda não copiados voltam para a fila (a fila ignora os que já estão nela).
    assert.strictEqual(r2.pdfs.length, 4);
  });

  await teste('exportação posterior com regimento novo tira a vigência do antigo', async () => {
    const G = bancoFalso();
    const c2 = { slug: 'resteste', idSL: 78, cnpj: null, criadoPor: null };
    await I.importarCondominio(G.banco, c2, { docs: [blocoExemplo().docs[0]] });
    await I.importarCondominio(G.banco, c2, { docs: [Object.assign({}, blocoExemplo().docs[1], { url_download: 'https://condominio.condgpt.app/arquivos?path=resteste/zzz-9.pdf' })] });
    const regs = G.tabelas.regras_documentos.filter((d) => d.tipo === 'regimento');
    assert.strictEqual(regs.length, 2);
    assert.deepStrictEqual(regs.map((d) => d.vigente), [false, true]);
  });

  await teste('cópia de PDF: recusa conteúdo que não é PDF e grava o que é', async () => {
    assert.strictEqual(I.conferirPdf(Buffer.from('<html>erro</html>')).ok, false);
    assert.strictEqual(I.conferirPdf(Buffer.from('%PDF-1.7 ...')).ok, true);
    const enviados = [];
    const fila = I.criarFilaPdf({
      banco: F.banco, esperaMs: 0,
      storageUpload: async (bucket, caminho, buf) => { enviados.push(bucket + '/' + caminho); return {}; },
      baixar: async (p) => (/ddd-444/.test(p) ? Buffer.from('<html>AccessDenied</html>') : Buffer.from('%PDF-1.4 conteudo')),
    });
    const n = fila.enfileirar(r1.pdfs.concat(r1.pdfs));
    assert.strictEqual(n, 4, 'mesmo documento não entra duas vezes na fila');
    await fila.ocioso();
    const s = fila.status();
    assert.strictEqual(s.copiados, 3);
    assert.strictEqual(s.falhas, 1);
    assert.ok(/não é PDF/.test(s.ultimas_falhas[0].motivo));
    assert.ok(enviados.every((e) => /^regras\/77\/\d+\.pdf$/.test(e)));
    const ata = F.tabelas.regras_documentos.find((d) => /ddd-444/.test(d.observacao || ''));
    assert.strictEqual(ata.arquivo_path, undefined);
    const comPdf = F.tabelas.regras_documentos.filter((d) => d.arquivo_path);
    assert.strictEqual(comPdf.length, 3);
    comPdf.forEach((d) => assert.strictEqual(d.arquivo_path, '77/' + d.id + '.pdf'));
    // Retomar acha só o que ficou sem PDF.
    const pend = await I.pendentesPdf(F.banco);
    assert.strictEqual(pend.length, 1);
    assert.strictEqual(pend[0].path, 'resteste/ddd-444.pdf');
  });

  await teste('download só segue https para o CondGPT e o S3', async () => {
    await assert.rejects(I.baixarUrl('http://condominio.condgpt.app/arquivos?path=a/b.pdf'), /não permitido/);
    await assert.rejects(I.baixarUrl('https://169.254.169.254/latest/meta-data'), /não permitido/);
    await assert.rejects(I.baixarUrl('https://exemplo.com/x.pdf'), /não permitido/);
  });

  // Rotas com app e deps falsos (sem rede).
  function appFalso() {
    const rotas = {};
    const reg = (m) => (caminho, ...fns) => { rotas[m + ' ' + caminho] = fns; };
    return { rotas, get: reg('GET'), post: reg('POST'), put: reg('PUT') };
  }
  async function chamar(app, chave, req) {
    const fns = app.rotas[chave];
    const res = { st: 200, j: null, headersSent: false, set() { return res; }, status(s) { res.st = s; return res; }, json(j) { res.j = j; res.headersSent = true; return res; } };
    req.params = req.params || {}; req.headers = {}; req.originalUrl = chave.split(' ')[1];
    let i = 0;
    const next = async () => { const f = fns[i++]; if (f) await f(req, res, next); };
    await next();
    // O express não espera o next(): aguarda a resposta sair (até 3 s).
    for (let t = 0; t < 300 && !res.headersSent; t++) await new Promise((ok) => setTimeout(ok, 10));
    return res;
  }
  await teste('rotas: só GESTOR, viladeitaunas recusado, importação pela rota', async () => {
    const G = bancoFalso();
    const eventos = [];
    const app = appFalso();
    criarRotasImportar(app, {
      requireAuth: (req, res, next) => next(), express: { json: () => (req, res, next) => next() }, banco: G.banco,
      perfilDe: async (req) => ({ role: req.papel }), exigirCarteira: async () => true, exigirLeituraSuperlogica: async () => true,
      clienteSL: () => ({ get: async () => [{ id_condominio_cond: '77', st_nome_cond: 'RESIDENCIAL TESTE', st_cnpj_cond: '11.222.333/0001-44' }] }),
      auditoria: { evento: (req, acao, det) => eventos.push(acao) }, storageUpload: async () => ({}), baixarPdf: async () => Buffer.from('%PDF-1.4 x'),
    });
    const negado = await chamar(app, 'POST /api/regras/importar/mapa', { papel: 'GERENTE', body: { condominios: [{ slug: 'resteste', cnpj: '11222333000144' }] } });
    assert.strictEqual(negado.st, 403);
    const mapa = await chamar(app, 'POST /api/regras/importar/mapa', { papel: 'GESTOR', body: { condominios: [{ slug: 'resteste', label: 'Residencial Teste', cnpj: '11222333000144' }, { slug: 'viladeitaunas', label: 'Vila', cnpj: '24902992000100' }] } });
    assert.strictEqual(mapa.st, 200);
    assert.strictEqual(mapa.j.mapa.find((m) => m.slug === 'resteste').id_superlogica, 77);
    assert.strictEqual(G.tabelas.regras_mapa_condgpt.length, 2);
    const vila = await chamar(app, 'POST /api/regras/importar/condominio', { papel: 'GESTOR', body: { slug: 'viladeitaunas', bloco: { docs: [] } } });
    assert.strictEqual(vila.st, 400);
    const ok = await chamar(app, 'POST /api/regras/importar/condominio', { papel: 'GESTOR', body: { slug: 'resteste', bloco: blocoExemplo() } });
    assert.strictEqual(ok.st, 200, JSON.stringify(ok.j));
    assert.strictEqual(ok.j.documentos.novos, 5);
    assert.ok(eventos.includes('regras_importar_condgpt'));
    const errado = await chamar(app, 'POST /api/regras/importar/condominio', { papel: 'GESTOR', body: { slug: 'resteste', bloco: Object.assign(blocoExemplo(), { dados: { inscricao: '00000000000191' } }) } });
    assert.strictEqual(errado.st, 400);
    assert.strictEqual(errado.j.erro, 'cnpj_diferente');
    const manual = await chamar(app, 'PUT /api/regras/importar/mapa/:slug', { papel: 'GESTOR', params: { slug: 'resteste' }, body: { id_superlogica: '77' } });
    assert.strictEqual(manual.st, 200);
    assert.strictEqual(manual.j.situacao, 'manual');
    const st = await chamar(app, 'GET /api/regras/importar/status', { papel: 'GESTOR' });
    assert.ok(st.j.total >= 1);
  });

  console.log('\n' + passou + ' passaram, ' + falhas + ' falharam');
  process.exit(falhas ? 1 : 0);
})();
