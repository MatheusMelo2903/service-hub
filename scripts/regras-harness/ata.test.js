// Harness da frente E (conferência da ata, mandatos e alertas). Node puro, banco e modelo falsos.
// Rodar: node scripts/regras-harness/ata.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const raiz = path.join(__dirname, '..', '..');
const { conferirAta } = require(path.join(raiz, 'servico/regras/conferencia-ata'));
const { extrairMandatos, mesesDaCitacao } = require(path.join(raiz, 'servico/regras/mandatos'));
const { gerarAlertasRegras } = require(path.join(raiz, 'servico/regras/alertas-regras'));

const ATA = 'ATA DA ASSEMBLEIA GERAL EXTRAORDINÁRIA DO CONDOMÍNIO RESIDENCIAL TESTE, realizada em 10/03/2025.\n'
  + 'Em segunda convocação, às 19h30, com a presença de 12 condôminos, foi instalada a assembleia.\n'
  + 'Item 1: alteração do regimento interno quanto ao horário da piscina, aprovada por 9 votos.\n'
  + 'Item 2: eleição. Foi eleita síndica a Sra. Maria da Silva, para mandato de dois anos, e para o conselho fiscal os Srs. João Souza, Pedro Lima e Ana Reis.';
const EDITAL = 'EDITAL DE CONVOCAÇÃO. Ficam convocados os condôminos para a assembleia do dia 10/03/2025, publicado em 05/03/2025.';
const CONVENCAO = [
  { trecho_id: 101, documento_id: 7, tipo: 'convencao', titulo_documento: 'Convenção', data_documento: '2010-01-01', rotulo: 'Art. 30', pagina: 8, rank: 1,
    texto: 'Art. 30. A alteração do regimento interno depende da aprovação de dois terços dos condôminos.' },
  { trecho_id: 102, documento_id: 7, tipo: 'convencao', titulo_documento: 'Convenção', data_documento: '2010-01-01', rotulo: 'Art. 22', pagina: 6, rank: 0.9,
    texto: 'Art. 22. As assembleias serão convocadas com antecedência mínima de 10 (dez) dias, por edital.' },
  { trecho_id: 103, documento_id: 7, tipo: 'convencao', titulo_documento: 'Convenção', data_documento: '2010-01-01', rotulo: 'Art. 40', pagina: 9, rank: 0.8,
    texto: 'Art. 40. O mandato do síndico e do conselho fiscal será de 2 (dois) anos, permitida a reeleição.' },
];

// Banco falso: guarda o que foi gravado e responde às rotas usadas.
function bancoFalso({ docs, trechos, mandatos, notificacoes } = {}) {
  const gravados = { conferencias: [], mandatos: (mandatos || []).slice() };
  const chamadas = [];
  let seq = 1;
  const fn = async (metodo, caminho, corpo) => {
    chamadas.push({ metodo, caminho, corpo });
    if (caminho.startsWith('/rest/v1/regras_documentos') && metodo === 'GET') return { status: 200, body: docs || [] };
    if (caminho === '/rest/v1/rpc/regras_buscar') return { status: 200, body: trechos || [] };
    if (caminho === '/rest/v1/regras_conferencias_ata' && metodo === 'POST') {
      const l = Object.assign({ id: seq++ }, corpo); gravados.conferencias.push(l); return { status: 201, body: [l] };
    }
    if (caminho.startsWith('/rest/v1/regras_mandatos') && metodo === 'GET') {
      const q = new URLSearchParams(caminho.split('?')[1]);
      if (q.get('cargo')) {
        const ini = q.get('inicio');
        const achou = gravados.mandatos.filter((m) => 'eq.' + m.cargo === q.get('cargo') && 'eq.' + m.nome === q.get('nome') && (ini === 'is.null' ? !m.inicio : 'eq.' + m.inicio === ini));
        return { status: 200, body: achou.slice(0, 1) };
      }
      return { status: 200, body: gravados.mandatos };
    }
    if (caminho === '/rest/v1/regras_mandatos' && metodo === 'POST') {
      const l = Object.assign({ id: seq++ }, corpo); gravados.mandatos.push(l); return { status: 201, body: [l] };
    }
    if (caminho.startsWith('/rest/v1/regras_notificacoes')) return { status: 200, body: notificacoes || [] };
    return { status: 404, body: null };
  };
  return { fn, gravados, chamadas };
}
function modeloFalso(resposta) {
  const m = { chamadas: [], fn: async (args) => { m.chamadas.push(args); return { ok: true, texto: JSON.stringify(resposta) }; } };
  return m;
}
const modelos = { modelo: (f) => 'falso_' + f };
const DOCS_COM_REGRAS = [{ id: 7, tipo: 'convencao', vigente: true }];

const testes = [];
const teste = (nome, f) => testes.push({ nome, f });

const itemBom = {
  assunto: 'quorum', gravidade: 'possivel_irregularidade',
  descricao: 'A convenção exige dois terços para alterar o regimento e a ata registra 9 votos com 12 presentes',
  trecho_ata: 'alteração do regimento interno quanto ao horário da piscina, aprovada por 9 votos',
  fundamentos: [{ trecho_id: 101, citacao: 'depende da aprovação de dois terços dos condôminos' }],
};

teste('item com trecho de ata inventado some', async () => {
  const b = bancoFalso({ docs: DOCS_COM_REGRAS, trechos: CONVENCAO });
  const m = modeloFalso({ itens: [Object.assign({}, itemBom, { trecho_ata: 'a assembleia aprovou a reforma da fachada por aclamação' })], resumo: 'x' });
  const r = await conferirAta({ banco: b.fn, chamarModelo: m.fn, modelos }, 167, { texto_ata: ATA, edital_texto: EDITAL });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.itens.length, 0);
  assert.strictEqual(r.descartados, 1);
  assert.strictEqual(r.resumo, 'Nada a apontar.');
});

teste('item com artigo inventado some', async () => {
  const b = bancoFalso({ docs: DOCS_COM_REGRAS, trechos: CONVENCAO });
  const m = modeloFalso({ itens: [
    Object.assign({}, itemBom, { fundamentos: [{ trecho_id: 101, citacao: 'depende da aprovação unânime dos condôminos' }] }),
    Object.assign({}, itemBom, { fundamentos: [{ trecho_id: 999, citacao: 'depende da aprovação de dois terços dos condôminos' }] }),
    Object.assign({}, itemBom, { fundamentos: [{ trecho_id: -9999, citacao: 'qualquer coisa do código' }] }),
  ] });
  const r = await conferirAta({ banco: b.fn, chamarModelo: m.fn, modelos }, 167, { texto_ata: ATA });
  assert.strictEqual(r.itens.length, 0);
  assert.strictEqual(r.descartados, 3);
});

teste('item bom passa (ata e edital), com Código Civil só pela lista fixa', async () => {
  const b = bancoFalso({ docs: DOCS_COM_REGRAS, trechos: CONVENCAO });
  const m = modeloFalso({ itens: [
    itemBom,
    { assunto: 'convocacao', gravidade: 'atencao', descricao: 'Edital publicado com 5 dias e a convenção pede 10 dias — conferir',
      trecho_ata: 'publicado em 05/03/2025', fundamentos: [{ trecho_id: 102, citacao: 'antecedência mínima de 10 (dez) dias' }] },
    { assunto: 'quorum', gravidade: 'atencao', descricao: 'Segunda convocação decide por maioria dos presentes',
      trecho_ata: 'Em segunda convocação, às 19h30, com a presença de 12 condôminos', fundamentos: [{ trecho_id: -1353, citacao: 'poderá deliberar por maioria dos votos dos presentes' }] },
  ] });
  const r = await conferirAta({ banco: b.fn, chamarModelo: m.fn, modelos }, 167, { texto_ata: ATA, edital_texto: EDITAL, transcricao_id: 'abc' });
  assert.strictEqual(r.itens.length, 3);
  assert.strictEqual(r.itens[0].fundamentos[0].rotulo, 'Art. 30');
  assert.strictEqual(r.itens[0].fundamentos[0].documento_id, 7);
  assert.strictEqual(r.itens[0].fundamentos[0].fonte, 'Convenção');
  assert.strictEqual(r.itens[1].trecho_origem, 'edital');
  assert.ok(!/[–—]/.test(r.itens[1].descricao), 'descrição sem travessão');
  assert.strictEqual(r.itens[2].fundamentos[0].fonte, 'Código Civil');
  assert.strictEqual(r.itens[2].fundamentos[0].documento_id, null);
  assert.strictEqual(b.gravados.conferencias.length, 1);
  assert.strictEqual(b.gravados.conferencias[0].transcricao_id, 'abc');
  assert.strictEqual(m.chamadas[0].modelo, 'falso_regras');
  assert.strictEqual(m.chamadas[0].funcao, 'regras');
});

teste('sem convenção nem regimento não chama o modelo', async () => {
  const b = bancoFalso({ docs: [{ id: 1, tipo: 'ata', vigente: true }, { id: 2, tipo: 'convencao', vigente: false }] });
  const m = modeloFalso({ itens: [itemBom] });
  const r = await conferirAta({ banco: b.fn, chamarModelo: m.fn, modelos }, 167, { texto_ata: ATA });
  assert.strictEqual(m.chamadas.length, 0);
  assert.strictEqual(r.sem_regras, true);
  assert.ok(/sem convenção e regimento cadastrados/i.test(r.aviso));
  assert.strictEqual(b.gravados.conferencias.length, 0);
});

teste('texto da ata não é alterado (o recebido é o que vai ao modelo; nada da ata volta nem é guardado)', async () => {
  const b = bancoFalso({ docs: DOCS_COM_REGRAS, trechos: CONVENCAO });
  const m = modeloFalso({ itens: [itemBom] });
  const copia = String(ATA);
  const opts = { texto_ata: ATA, edital_texto: EDITAL };
  const r = await conferirAta({ banco: b.fn, chamarModelo: m.fn, modelos }, 167, opts);
  assert.strictEqual(opts.texto_ata, copia);
  assert.ok(m.chamadas[0].content.includes('<ata>\n' + copia + '\n</ata>'), 'ata enviada inteira e igual');
  assert.strictEqual(r.ata_hash, require('crypto').createHash('sha256').update(copia).digest('hex'));
  assert.ok(!('texto_ata' in r) && !('ata' in r), 'resultado não devolve outra versão da ata');
  const gravado = JSON.stringify(b.gravados.conferencias[0]);
  assert.ok(!gravado.includes('Item 2: eleição'), 'banco não guarda a ata');
  assert.ok(!b.chamadas.some((c) => /transcricoes|atas/.test(c.caminho) && c.metodo !== 'GET'), 'nenhuma escrita em ata ou transcrição');
});

teste('mandato: fim calculado só com duração citada', async () => {
  const b = bancoFalso({ trechos: CONVENCAO });
  const m = modeloFalso({ mandatos: [
    // duração na própria ata
    { cargo: 'sindico', nome: 'Maria da Silva', inicio: null, fim: null, trecho: 'Foi eleita síndica a Sra. Maria da Silva, para mandato de dois anos',
      duracao: { trecho_id: null, citacao: 'para mandato de dois anos' } },
    // duração na convenção (trecho 103)
    { cargo: 'conselho_fiscal', nome: 'João Souza', trecho: 'para o conselho fiscal os Srs. João Souza, Pedro Lima e Ana Reis',
      duracao: { trecho_id: 103, citacao: 'O mandato do síndico e do conselho fiscal será de 2 (dois) anos' } },
    // duração inventada (citação não existe): fica sem fim
    { cargo: 'conselho_fiscal', nome: 'Pedro Lima', trecho: 'para o conselho fiscal os Srs. João Souza, Pedro Lima e Ana Reis',
      duracao: { trecho_id: 103, citacao: 'mandato de 3 anos' } },
    // sem duração: fica sem fim, mesmo com fim inventado pelo modelo
    { cargo: 'conselho_fiscal', nome: 'Ana Reis', fim: '2027-03-10', trecho: 'para o conselho fiscal os Srs. João Souza, Pedro Lima e Ana Reis' },
    // nome fora do trecho: some
    { cargo: 'subsindico', nome: 'Carlos Alberto', trecho: 'Foi eleita síndica a Sra. Maria da Silva' },
    // trecho inventado: some
    { cargo: 'sindico', nome: 'Fulano', trecho: 'Foi eleito síndico o Sr. Fulano de Tal' },
  ] });
  const deps = { banco: b.fn, chamarModelo: m.fn, modelos };
  const r = await extrairMandatos(deps, 167, { texto: ATA, data_ata: '10/03/2025', documento_id: 55 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mandatos.length, 4);
  assert.strictEqual(r.descartados, 2);
  const por = Object.fromEntries(r.mandatos.map((x) => [x.nome, x]));
  assert.strictEqual(por['Maria da Silva'].inicio, '2025-03-10');
  assert.strictEqual(por['Maria da Silva'].fim, '2027-03-10');
  assert.strictEqual(por['João Souza'].fim, '2027-03-10');
  assert.strictEqual(por['Pedro Lima'].fim, null);
  assert.strictEqual(por['Ana Reis'].fim, null);
  assert.strictEqual(por['Maria da Silva'].documento_id, 55);
  assert.strictEqual(m.chamadas[0].modelo, 'falso_regras_extracao');
  // Rodar de novo não duplica
  const r2 = await extrairMandatos(deps, 167, { texto: ATA, data_ata: '2025-03-10', documento_id: 55 });
  assert.strictEqual(r2.novos, 0);
  assert.strictEqual(b.gravados.mandatos.length, 4);
  assert.strictEqual(mesesDaCitacao('há 2 anos o prédio'), null);
  assert.strictEqual(mesesDaCitacao('mandato de 2 (dois) anos'), 24);
});

teste('alertas: mandato vencendo, mandato antigo não alerta, advertência vencida no formato certo', async () => {
  const hoje = new Date(2026, 9, 22);
  const b = bancoFalso({
    mandatos: [
      { id: 1, cargo: 'sindico', nome: 'Maria da Silva', inicio: '2024-12-01', fim: '2026-12-01', conferido: true },
      { id: 2, cargo: 'sindico', nome: 'José Antigo', inicio: '2022-12-01', fim: '2024-12-01', conferido: true },
      { id: 3, cargo: 'conselho_fiscal', nome: 'João Souza', inicio: '2024-03-10', fim: '2026-03-10', conferido: false },
      { id: 4, cargo: 'conselho_fiscal', nome: 'Ana Reis', inicio: '2024-03-10', fim: '2026-03-10', conferido: false },
      { id: 5, cargo: 'subsindico', nome: 'Sub', inicio: '2024-03-10', fim: '2026-10-30', conferido: false },
    ],
    notificacoes: [
      { id: 77, tipo: 'advertencia', status: 'registrada', unidade: '101', bloco: 'A', ocorrencia: 'Barulho após as 22h', prazo_regularizacao: '2026-10-15' },
      { id: 78, tipo: 'advertencia', status: 'regularizada', unidade: '102', prazo_regularizacao: '2026-10-01' },
    ],
  });
  const r = await gerarAlertasRegras({ banco: b.fn }, 167, hoje);
  assert.deepStrictEqual(r.falhas, []);
  const porTipo = (t) => r.alertas.filter((a) => a.tipo === t);
  const mand = porTipo('mandato_vencendo');
  assert.strictEqual(mand.length, 2, 'síndico vencendo e conselho vencido; antigo e subsíndico fora');
  const sind = mand.find((a) => a.detalhe.cargo === 'sindico');
  assert.strictEqual(sind.chave, 'mandato:sindico:2026-12-01:vencendo');
  assert.strictEqual(sind.detalhe.dias, 40);
  assert.ok(sind.titulo.includes('01/12/2026'));
  assert.ok(typeof sind.detalhe.resumo === 'string' && sind.detalhe.resumo.includes('Maria da Silva'));
  const cons = mand.find((a) => a.detalhe.cargo === 'conselho_fiscal');
  assert.strictEqual(cons.chave, 'mandato:conselho_fiscal:2026-03-10:vencido');
  assert.deepStrictEqual(cons.detalhe.nomes, ['João Souza', 'Ana Reis']);
  const adv = porTipo('advertencia_vencida');
  assert.strictEqual(adv.length, 1);
  assert.strictEqual(adv[0].chave, 'advertencia_vencida:77:2026-10-15');
  assert.ok(adv[0].detalhe.resumo.includes('multa'));
  r.alertas.forEach((a) => {
    assert.ok(a.chave && a.tipo && a.titulo && a.detalhe && a.detalhe.resumo, 'formato dos alertas');
    assert.ok(!/[–—]/.test(a.titulo + a.detalhe.resumo), 'sem travessão');
  });
  // Filtro do banco pede só advertência registrada com prazo antes de hoje
  const q = b.chamadas.find((c) => c.caminho.startsWith('/rest/v1/regras_notificacoes')).caminho;
  assert.ok(q.includes('status=eq.registrada') && q.includes('prazo_regularizacao=lt.2026-10-22'));
});

(async () => {
  let falhou = 0;
  for (const t of testes) {
    try { await t.f(); console.log('ok   ' + t.nome); } catch (e) { falhou++; console.log('FALHOU ' + t.nome + '\n  ' + (e && e.stack || e)); }
  }
  console.log('\n' + (testes.length - falhou) + '/' + testes.length + ' passaram');
  process.exit(falhou ? 1 : 0);
})();
