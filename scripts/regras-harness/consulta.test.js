// Harness da frente B (consulta, comparação e FAQ das regras). Node puro, sem rede:
// banco falso (responde regras_buscar e regras_faq em memória) e modelo falso (devolve o JSON
// que cada caso precisa). Rodar: node scripts/regras-harness/consulta.test.js

const assert = require('assert');
const path = require('path');
const raiz = path.join(__dirname, '..', '..');
const consulta = require(path.join(raiz, 'servico/regras/consulta'));
const faq = require(path.join(raiz, 'servico/regras/faq'));
const { extrairJson } = require(path.join(raiz, 'servico/modelo'));

// Acervo de teste: dois condomínios com regimento e uma ata que muda o horário de obras.
const TRECHOS = [
  { trecho_id: 11, documento_id: 1, id_superlogica: 100, tipo: 'regimento', titulo_documento: 'Regimento Interno', data_documento: '2019-03-01', rotulo: 'Art. 44', texto: 'Art. 44. As obras e reformas nas unidades somente poderão ser realizadas de segunda a sexta feira, das 8h às 17h.', pagina: 7, rank: 0.9 },
  { trecho_id: 12, documento_id: 2, id_superlogica: 100, tipo: 'ata', titulo_documento: 'Ata AGE', data_documento: '2025-06-10', rotulo: 'Trecho 3', texto: 'Aprovada por maioria a alteração do horário de obras, que passa a ser das 9h às 16h, de segunda a sexta feira.', pagina: 2, rank: 0.8 },
  { trecho_id: 13, documento_id: 1, id_superlogica: 100, tipo: 'regimento', titulo_documento: 'Regimento Interno', data_documento: '2019-03-01', rotulo: 'Art. 20', texto: 'Art. 20. É permitida a permanência de animais domésticos de pequeno porte, desde que não perturbem o sossego.', pagina: 4, rank: 0.5 },
  { trecho_id: 21, documento_id: 5, id_superlogica: 200, tipo: 'regimento', titulo_documento: 'Regimento', data_documento: '2021-01-01', rotulo: 'Art. 9', texto: 'Art. 9. O horário de silêncio vai das 22h às 7h.', pagina: 1, rank: 0.7 },
];

// Banco falso: guarda as chamadas e simula a tabela regras_faq.
function bancoFalso(opts) {
  const o = opts || {};
  const faqTab = (o.faq || []).slice();
  let seq = 1000;
  const chamadas = [];
  const fn = async (metodo, caminho, corpo) => {
    chamadas.push({ metodo, caminho, corpo });
    if (caminho === '/rest/v1/rpc/regras_buscar') {
      const lista = TRECHOS.filter((t) => corpo.p_id == null || t.id_superlogica === corpo.p_id);
      return { status: 200, body: o.vazio ? [] : lista };
    }
    if (metodo === 'POST' && caminho === '/rest/v1/regras_faq') {
      const linhas = corpo.map((l) => Object.assign({ id: ++seq }, l));
      faqTab.push(...linhas);
      return { status: 201, body: linhas };
    }
    if (metodo === 'DELETE' && caminho.startsWith('/rest/v1/regras_faq?')) {
      const m = caminho.match(/id_superlogica=eq\.(\d+)&id=not\.in\.\(([\d,]+)\)/);
      const fica = new Set(m[2].split(',').map(Number));
      for (let i = faqTab.length - 1; i >= 0; i--) if (faqTab[i].id_superlogica === Number(m[1]) && !fica.has(faqTab[i].id)) faqTab.splice(i, 1);
      return { status: 200, body: [] };
    }
    if (metodo === 'GET' && caminho.startsWith('/rest/v1/regras_faq?')) {
      const id = Number(caminho.match(/id_superlogica=eq\.(\d+)/)[1]);
      return { status: 200, body: faqTab.filter((l) => l.id_superlogica === id) };
    }
    return { status: 404, body: null };
  };
  fn.chamadas = chamadas;
  fn.faq = faqTab;
  return fn;
}

// Modelo falso: a chamada de buscas devolve sinônimos; a de resposta devolve o que o caso pede.
function modeloFalso(resposta, opts) {
  const o = opts || {};
  const chamadas = [];
  const fn = async (args) => {
    chamadas.push(args);
    if (args.rotulo === 'regras_buscas') {
      if (o.buscasFalham) return { ok: false, status: 502 };
      return { ok: true, texto: '{"buscas": ["obras e reformas", "horário de obras"]}' };
    }
    const r = typeof resposta === 'function' ? resposta(args) : resposta;
    return { ok: true, texto: JSON.stringify(r) };
  };
  fn.chamadas = chamadas;
  return fn;
}
const modelos = { modelo: (f) => 'modelo-' + f };
const deps = (banco, chamarModelo) => ({ banco, chamarModelo, modelos, extrairJson });

const casos = [];
const caso = (nome, f) => casos.push({ nome, f });

caso('gerarBuscas inclui a pergunta e os sinônimos; falha fica só com a pergunta', async () => {
  const b = await consulta.gerarBuscas(deps(bancoFalso(), modeloFalso({})), 'pode fazer obra no sábado?');
  assert.deepStrictEqual(b, ['pode fazer obra no sábado?', 'obras e reformas', 'horário de obras']);
  const b2 = await consulta.gerarBuscas(deps(bancoFalso(), modeloFalso({}, { buscasFalham: true })), 'pode fazer obra?');
  assert.deepStrictEqual(b2, ['pode fazer obra?']);
});

caso('citação inventada é recusada e vira "não encontrei"', async () => {
  const m = modeloFalso({ resposta: 'Pode fazer obra no sábado, conforme o Art. 44.', fundamentos: [{ trecho_id: 11, citacao: 'obras são permitidas aos sábados das 8h às 12h' }, { trecho_id: 999, citacao: 'qualquer coisa' }], conflito: '', nao_encontrado: false });
  const r = await consulta.responder(deps(bancoFalso(), m), 100, 'pode fazer obra no sábado?');
  assert.strictEqual(r.nao_encontrado, true);
  assert.strictEqual(r.resposta, consulta.NAO_ENCONTREI);
  assert.strictEqual(r.fundamentos.length, 0);
  assert.strictEqual(r.recusados_qtd, 2);
});

caso('citação certa aparece com o rótulo do acervo, não o do modelo; conflito passa', async () => {
  const m = modeloFalso({
    resposta: 'Pelo Art. 44 do regimento as obras vão das 8h às 17h, mas a ata de 10/06/2025 mudou para das 9h às 16h. Ver também o Art. 99 — sem fonte.',
    fundamentos: [
      { trecho_id: 11, citacao: 'As obras e reformas nas unidades somente poderão ser realizadas de segunda a sexta feira', rotulo: 'Art. 1', documento: 'Inventado' },
      { trecho_id: '12', citacao: 'passa a ser das 9h às 16h' },
    ],
    conflito: 'A ata de 10/06/2025 alterou o horário do Art. 44 do regimento.',
    nao_encontrado: false,
  });
  const r = await consulta.responder(deps(bancoFalso(), m), 100, 'qual o horário de obras?');
  assert.strictEqual(r.nao_encontrado, false);
  assert.strictEqual(r.fundamentos.length, 2);
  assert.strictEqual(r.fundamentos[0].rotulo, 'Art. 44');
  assert.strictEqual(r.fundamentos[0].documento, 'Regimento Interno');
  assert.strictEqual(r.fundamentos[0].tipo, 'regimento');
  assert.strictEqual(r.fundamentos[0].pagina, 7);
  assert.strictEqual(r.fundamentos[0].documento_id, 1);
  assert.strictEqual(r.fundamentos[1].tipo, 'ata');
  assert.strictEqual(r.fundamentos[1].data, '2025-06-10');
  assert.ok(/ata de 10\/06\/2025 alterou/.test(r.conflito));
  // artigo sem fundamento vira [a confirmar]; travessão sai do texto
  assert.ok(r.resposta.includes('Art. 44'));
  assert.ok(!r.resposta.includes('Art. 99'), r.resposta);
  assert.ok(r.resposta.includes('[a confirmar]'));
  assert.ok(!/[–—]/.test(r.resposta + r.conflito));
  // a resposta não leva nada do processamento
  assert.deepStrictEqual(Object.keys(r).sort(), ['conflito', 'fundamentos', 'nao_encontrado', 'recusados_qtd', 'resposta']);
});

caso('acervo vazio responde "não encontrei" sem chamar a resposta', async () => {
  const m = modeloFalso(() => { throw new Error('não devia chamar'); });
  const r = await consulta.responder(deps(bancoFalso({ vazio: true }), m), 100, 'pode churrasco?');
  assert.strictEqual(r.nao_encontrado, true);
  assert.ok(m.chamadas.every((c) => c.rotulo === 'regras_buscas'));
});

caso('comparação marca condomínio sem fundamento e recusa trecho de outro condomínio', async () => {
  const m = modeloFalso({ linhas: [
    { id_superlogica: 100, resumo: 'Obras de segunda a sexta, das 8h às 17h (Art. 44).', fundamentos: [{ trecho_id: 11, citacao: 'das 8h às 17h' }] },
    // usa trecho do condomínio 100 para o 200: tem de ser recusado
    { id_superlogica: 200, resumo: 'Igual ao outro.', fundamentos: [{ trecho_id: 11, citacao: 'das 8h às 17h' }] },
  ] });
  const r = await consulta.comparar(deps(bancoFalso(), m), [100, '200', 300], 'qual o horário de obras?', { nomes: { 100: 'Cond A', 200: 'Cond B' } });
  assert.strictEqual(r.linhas.length, 3);
  assert.strictEqual(r.linhas[0].nao_encontrado, false);
  assert.strictEqual(r.linhas[0].nome, 'Cond A');
  assert.strictEqual(r.linhas[0].fundamentos[0].rotulo, 'Art. 44');
  assert.strictEqual(r.linhas[1].nao_encontrado, true);
  assert.strictEqual(r.linhas[1].resumo, consulta.NAO_ENCONTRADO_ACERVO);
  assert.strictEqual(r.linhas[2].nao_encontrado, true); // sem trecho nenhum (300)
  assert.strictEqual(r.recusados_qtd, 1);
  const chamadaComp = m.chamadas.find((c) => c.rotulo === 'regras_comparar');
  assert.ok(!/condominio id="300"/.test(chamadaComp.content)); // condomínio sem trecho não vai
});

caso('comparação limita a 40 condomínios', async () => {
  const ids = Array.from({ length: 55 }, (x, i) => i + 1);
  const banco = bancoFalso();
  const m = modeloFalso({ linhas: [] });
  const r = await consulta.comparar(deps(banco, m), ids, 'horário de silêncio');
  assert.strictEqual(r.linhas.length, 40);
});

caso('FAQ só grava tema com fundamento e troca o antigo', async () => {
  // Só os temas de obras e de animais têm citação certa; os outros vêm inventados.
  const m = modeloFalso((args) => {
    if (/obras e reformas/.test(args.content.split('Pergunta:')[1])) return { resposta: 'De segunda a sexta (Art. 44).', fundamentos: [{ trecho_id: 11, citacao: 'de segunda a sexta feira, das 8h às 17h' }], conflito: 'A ata de 10/06/2025 mudou o horário.', nao_encontrado: false };
    if (/animais/.test(args.content.split('Pergunta:')[1])) return { resposta: 'Pequeno porte é permitido (Art. 20).', fundamentos: [{ trecho_id: 13, citacao: 'animais domésticos de pequeno porte' }], conflito: '', nao_encontrado: false };
    return { resposta: 'Pode tudo.', fundamentos: [{ trecho_id: 11, citacao: 'texto que não existe no acervo' }], conflito: '', nao_encontrado: false };
  });
  const banco = bancoFalso({ faq: [{ id: 1, id_superlogica: 100, tema: 'Antigo', pergunta: 'x', resposta: 'y', fundamentos: [] }, { id: 2, id_superlogica: 200, tema: 'Outro cond', pergunta: 'x', resposta: 'y', fundamentos: [] }] });
  const r = await faq.gerarFaq(deps(banco, m), 100);
  assert.strictEqual(r.gravados, 2);
  assert.strictEqual(r.sem_fundamento.length, faq.TEMAS.length - 2);
  // FAQ não gasta a chamada de buscas (as buscas de cada tema já vêm prontas)
  assert.ok(m.chamadas.every((c) => c.rotulo === 'regras_consulta'));
  const lista = await faq.listarFaq({ banco }, 100);
  assert.deepStrictEqual(lista.map((l) => l.tema), ['Obras e reformas', 'Animais']);
  assert.ok(/mudou o horário/.test(lista[0].conflito));
  assert.ok(lista[0].fundamentos.every((f) => f.citacao && f.rotulo === 'Art. 44'));
  assert.ok(banco.faq.some((l) => l.id_superlogica === 200)); // outro condomínio intocado
  assert.ok(!banco.faq.some((l) => l.tema === 'Antigo'));
});

caso('FAQ sem nenhum fundamento não apaga o antigo', async () => {
  const m = modeloFalso({ resposta: 'x', fundamentos: [], conflito: '', nao_encontrado: true });
  const banco = bancoFalso({ faq: [{ id: 1, id_superlogica: 100, tema: 'Antigo', pergunta: 'x', resposta: 'y', fundamentos: [] }] });
  const r = await faq.gerarFaq(deps(banco, m), 100);
  assert.strictEqual(r.gravados, 0);
  assert.ok(banco.faq.some((l) => l.tema === 'Antigo'));
  assert.ok(!banco.chamadas.some((c) => c.metodo === 'DELETE'));
});

caso('travarArtigos aceita artigo de lei citado dentro do trecho conferido', () => {
  const t = consulta.travarArtigos('Conforme o art. 1.336 do Código Civil e o Art. 12-A.', [{ rotulo: 'Art. 12-A', citacao: 'nos termos do art. 1.336 do Código Civil' }]);
  assert.strictEqual(t, 'Conforme o art. 1.336 do Código Civil e o Art. 12-A.');
  assert.strictEqual(consulta.travarArtigos('Art. 12', [{ rotulo: 'Art. 12-A', citacao: 'x' }]), '[a confirmar]');
});

(async () => {
  let falhas = 0;
  const avisoOriginal = console.warn;
  console.warn = () => {}; // os avisos de recusa são esperados nos casos
  for (const c of casos) {
    try { await c.f(); avisoOriginal('ok   ' + c.nome); } catch (e) { falhas++; avisoOriginal('FALHA ' + c.nome + '\n  ' + (e && e.stack)); }
  }
  console.warn = avisoOriginal;
  console.log('\n' + (casos.length - falhas) + '/' + casos.length + ' casos passaram');
  process.exit(falhas ? 1 : 0);
})();
