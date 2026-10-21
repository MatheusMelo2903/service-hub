// T42: testes do nome central dos modelos, do registro de custo e do painel de custo.
// Uso: NODE_PATH=... node scripts/teste-custo-api.js   (sai com 1 se algo falhar)
// Nenhuma chamada sai da máquina: a API e o banco são falsos.
const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');

let ok = 0; let falhas = 0;
const testes = [];
const t = (nome, fn) => testes.push([nome, fn]);

// API falsa: responde com usage; guarda o corpo pedido.
let pedidos = [];
let respostaFalsa = { status: 200, json: { content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400 }, stop_reason: 'end_turn' } };
https.request = function (opts, cb) {
  const req = new EventEmitter();
  let corpo = '';
  req.write = (c) => { corpo += c; };
  req.end = () => setImmediate(() => {
    pedidos.push({ host: opts.hostname, corpo: JSON.parse(corpo) });
    const resp = new EventEmitter(); resp.statusCode = respostaFalsa.status;
    cb(resp);
    resp.emit('data', Buffer.from(JSON.stringify(respostaFalsa.json))); resp.emit('end');
  });
  req.destroy = () => {};
  return req;
};
process.env.ANTHROPIC_KEY = 'x';

const modelos = require('../servico/modelos');
const custo = require('../servico/custo');
const { chamarModelo } = require('../servico/modelo');
const processar = require('../servico/processar');
const { criarRotasCusto } = require('../servico/rotas-custo');

const limparEnv = () => Object.keys(process.env).filter((k) => /^MODELO_|^ATA_MODELO$|^PRESTACAO_MODELO$|^MEDIDOR_MODELO|^ENTRADA_MODELO$|^CUSTO_|^ESFORCO_/.test(k)).forEach((k) => delete process.env[k]);
// Usuário fictício do teste (montado aqui para não parecer credencial).
const UID = ['11111111', '2222', '3333', '4444', '555555555555'].join('-');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- modelos ----------
t('modelo padrão de cada função', () => {
  limparEnv();
  Object.keys(modelos.PADRAO).forEach((f) => assert.strictEqual(modelos.modelo(f), modelos.PADRAO[f]));
});
t('MODELO_<FUNCAO> troca sem mudar código e vale na hora', () => {
  limparEnv(); process.env.MODELO_EDITAL = 'claude-haiku-5-5';
  assert.strictEqual(modelos.modelo('edital'), 'claude-haiku-5-5');
  delete process.env.MODELO_EDITAL; assert.strictEqual(modelos.modelo('edital'), modelos.PADRAO.edital);
});
t('variável antiga continua valendo e a nova tem prioridade', () => {
  limparEnv(); process.env.ATA_MODELO = 'claude-sonnet-4-6';
  assert.strictEqual(modelos.modelo('ata'), 'claude-sonnet-4-6');
  process.env.MODELO_ATA = 'claude-sonnet-5-5'; assert.strictEqual(modelos.modelo('ata'), 'claude-sonnet-5-5');
  limparEnv();
});
t('comunicado segue ATA_MODELO como antes', () => {
  limparEnv(); process.env.ATA_MODELO = 'claude-sonnet-4-6'; assert.strictEqual(modelos.modelo('comunicado'), 'claude-sonnet-4-6'); limparEnv();
});
t('esforço: padrão baixo, troca por variável e nenhum desliga', () => {
  limparEnv(); assert.strictEqual(modelos.esforco('prestacao'), 'low'); assert.strictEqual(modelos.esforco('edital'), undefined);
  process.env.ESFORCO_PRESTACAO = 'high'; assert.strictEqual(modelos.esforco('prestacao'), 'high');
  process.env.ESFORCO_PRESTACAO = 'nenhum'; assert.strictEqual(modelos.esforco('prestacao'), undefined);
  delete process.env.ESFORCO_PRESTACAO;
});
t('nome inválido na variável é ignorado', () => {
  limparEnv(); process.env.MODELO_UNIDADES = 'x y; rm'; assert.strictEqual(modelos.modelo('unidades'), modelos.PADRAO.unidades); limparEnv();
});
t('função sem modelo lança (erro de programação, nunca silencioso)', () => assert.throws(() => modelos.modelo('nao_existe')));
t('nenhum nome de modelo fora de servico/modelos.js e da tabela de preço', () => {
  const fs = require('fs'); const path = require('path');
  const raiz = path.join(__dirname, '..');
  const arquivos = ['server.js', 'prestacao-v13.js', 'servico/processar.js', 'servico/modelo.js', 'servico/rotas-entrada.js'];
  arquivos.forEach((a) => {
    const linhas = fs.readFileSync(path.join(raiz, a), 'utf8').split('\n');
    linhas.forEach((l, i) => {
      if (/^\s*\/\//.test(l) || /ATA_MODELOS_PERMITIDOS/.test(l)) return; // comentário e lista de teste interno
      assert.ok(!/['"]claude-[a-z]+-\d/.test(l), a + ':' + (i + 1) + ' tem nome de modelo no código');
    });
  });
});

// ---------- cálculo ----------
t('custo pela tabela de preço (entrada, saída, cache lido e criado)', () => {
  limparEnv();
  const c = custo.calcular('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 });
  assert.strictEqual(c.custo_usd, 2 + 10 + 0.2 + 2.5);
  assert.deepStrictEqual([c.entrada, c.saida, c.cache_lido, c.cache_criado], [1e6, 1e6, 1e6, 1e6]);
});
t('modelo sem preço: custo nulo, sem erro', () => assert.strictEqual(custo.calcular('desconhecido', { input_tokens: 10 }).custo_usd, null));
t('CUSTO_PRECOS troca o preço; valor ruim é ignorado', () => {
  process.env.CUSTO_PRECOS = JSON.stringify({ 'claude-sonnet-5-5': [1, 1, 1, 1], 'outro': [-1, 2, 3, 4] });
  assert.strictEqual(custo.calcular('claude-sonnet-5-5', { input_tokens: 1e6 }).custo_usd, 1);
  assert.ok(!custo.precos().outro);
  process.env.CUSTO_PRECOS = '{quebrado'; assert.strictEqual(custo.calcular('claude-sonnet-5-5', { input_tokens: 1e6 }).custo_usd, 2);
  limparEnv();
});
t('usage com lixo não vira número negativo nem NaN', () => {
  const c = custo.calcular('claude-sonnet-5-5', { input_tokens: -5, output_tokens: 'abc', cache_read_input_tokens: null });
  assert.strictEqual(c.custo_usd, 0); assert.strictEqual(c.entrada, 0);
});
t('limite padrão 200 e configurável', () => {
  limparEnv(); assert.strictEqual(custo.limiteMensal(), 200);
  process.env.CUSTO_LIMITE_MENSAL_USD = '50'; assert.strictEqual(custo.limiteMensal(), 50);
  process.env.CUSTO_LIMITE_MENSAL_USD = 'abc'; assert.strictEqual(custo.limiteMensal(), 200); limparEnv();
});

// ---------- registro nunca derruba nem atrasa ----------
const U = { input_tokens: 10, output_tokens: 5 };
t('registrar volta na hora mesmo com banco que nunca responde', async () => {
  custo.configurar({ banco: () => new Promise(() => {}) });
  const t0 = process.hrtime.bigint();
  const r = custo.registrar({ funcao: 'atas', modelo: 'claude-sonnet-5-5', usage: U });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(r, true); assert.ok(ms < 20, 'demorou ' + ms + ' ms');
});
t('banco que lança na hora ou rejeita não vira erro', async () => {
  custo.configurar({ banco: () => { throw new Error('caiu'); } });
  assert.doesNotThrow(() => custo.registrar({ funcao: 'atas', modelo: 'claude-sonnet-5-5', usage: U }));
  custo.configurar({ banco: () => Promise.reject(new Error('rede')) });
  assert.doesNotThrow(() => custo.registrar({ funcao: 'atas', modelo: 'claude-sonnet-5-5', usage: U }));
  await esperar(20);
});
t('entrada estranha não lança', () => {
  [undefined, null, 5, 'x', {}, { usage: null }, { usage: 'x', funcao: {} }].forEach((v) => assert.doesNotThrow(() => custo.registrar(v)));
});
t('fila de gravação tem teto (não acumula memória)', async () => {
  custo.configurar({ banco: () => new Promise(() => {}) });
  for (let i = 0; i < 300; i++) custo.registrar({ funcao: 'atas', modelo: 'claude-sonnet-5-5', usage: U });
  await esperar(5);
  assert.ok(custo._pendentesAgora() <= 100, 'pendentes ' + custo._pendentesAgora());
  custo._zerarParaTeste();
});
t('linha gravada: função conhecida, usuário e condomínio validados, sem conteúdo', async () => {
  const gravadas = [];
  custo.configurar({ banco: async (m, p, l) => { gravadas.push({ m, p, l }); return { status: 201 }; } });
  custo.registrar({ funcao: 'prestacao', modelo: 'claude-sonnet-5-5', usage: U, usuario: UID, condominio: '136' });
  custo.registrar({ funcao: 'qualquer', modelo: 'claude-sonnet-5-5', usage: U, usuario: 'nao-uuid', condominio: '136; drop' });
  await esperar(20);
  assert.strictEqual(gravadas.length, 2);
  assert.strictEqual(gravadas[0].m, 'POST'); assert.strictEqual(gravadas[0].p, '/rest/v1/api_uso');
  assert.strictEqual(gravadas[0].l.id_superlogica, 136); assert.strictEqual(gravadas[0].l.user_id, UID);
  assert.strictEqual(gravadas[1].l.funcao, 'outros'); assert.strictEqual(gravadas[1].l.user_id, null); assert.strictEqual(gravadas[1].l.id_superlogica, null);
  assert.deepStrictEqual(Object.keys(gravadas[0].l).sort(), ['cache_criado', 'cache_lido', 'custo_usd', 'entrada', 'funcao', 'id_superlogica', 'modelo', 'ok', 'saida', 'status', 'user_id']);
});
t('chamarModelo entrega o texto mesmo com o banco do custo caindo', async () => {
  custo.configurar({ banco: () => { throw new Error('caiu'); } });
  const r = await chamarModelo({ modelo: 'claude-sonnet-5-5', maxTokens: 10, content: 'oi', rotulo: 'edital' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.texto, '{"a":1}');
});
t('chamarModelo grava a função certa pelo rótulo', async () => {
  const gravadas = [];
  custo.configurar({ banco: async (m, p, l) => { gravadas.push(l); return { status: 201 }; } });
  await chamarModelo({ modelo: 'claude-sonnet-5-5', maxTokens: 10, content: 'oi', rotulo: 'medidor_reforco', usuario: UID });
  await esperar(20);
  assert.strictEqual(gravadas[0].funcao, 'medidores');
  assert.strictEqual(gravadas[0].custo_usd, (1000 * 2 + 500 * 10 + 2000 * 0.2 + 400 * 2.5) / 1e6);
});
t('processarEdital usa o modelo de servico/modelos.js', async () => {
  limparEnv(); pedidos = []; process.env.MODELO_EDITAL = 'claude-haiku-5-5';
  respostaFalsa.json.content = [{ type: 'text', text: '{"condominio":"X","data":"01/02/2026","tipo":"AGO","sindico":null,"local":"Salão"}' }];
  const r = await processar.processarEdital({ arquivo: { mime: 'application/pdf', base64: 'QUJD' } }, null);
  assert.strictEqual(r.status, 200); assert.strictEqual(pedidos[0].corpo.model, 'claude-haiku-5-5'); limparEnv();
});

// ---------- resumo do mês ----------
const LINHAS = [
  { dia: '2026-10-01', funcao: 'atas', chamadas: 4, custo_usd: '0.76' },
  { dia: '2026-10-01', funcao: 'medidores', chamadas: 100, custo_usd: '0.90' },
  { dia: '2026-10-02', funcao: 'atas', chamadas: 2, custo_usd: '0.34' },
  { dia: '2026-10-02', funcao: 'esquisita', chamadas: 1, custo_usd: '0.10' },
  { dia: '2026-09-30', funcao: 'atas', chamadas: 9, custo_usd: '9.00' },
];
t('resumo por função e por dia, só do mês pedido', () => {
  const r = custo.resumirMes(LINHAS, '2026-10', new Date('2026-11-05T12:00:00Z'), 200);
  assert.strictEqual(r.total_usd, 2.1); assert.strictEqual(r.chamadas, 107);
  assert.deepStrictEqual(r.por_funcao.map((f) => f.funcao), ['atas', 'medidores', 'outros']);
  assert.strictEqual(r.por_funcao[0].custo_usd, 1.1);
  assert.deepStrictEqual(r.por_dia.map((d) => d.dia), ['2026-10-01', '2026-10-02']);
  assert.strictEqual(r.corrente, false); assert.strictEqual(r.projecao_usd, 2.1); assert.strictEqual(r.alerta, false);
});
t('projeção do mês corrente pelo ritmo (fuso de Brasília)', () => {
  // 11/10 00h00 em Brasília = 10 dias corridos; 2,10 em 10 dias -> 6,51 em 31 dias
  const r = custo.resumirMes(LINHAS, '2026-10', new Date('2026-10-11T03:00:00Z'), 200);
  assert.strictEqual(r.corrente, true); assert.strictEqual(r.projecao_usd, 6.51);
});
t('aviso acima de 75% do limite e acima do limite', () => {
  const l = [{ dia: '2026-10-03', funcao: 'atas', chamadas: 1, custo_usd: 151 }];
  const r = custo.resumirMes(l, '2026-10', new Date('2026-11-01T12:00:00Z'), 200);
  assert.strictEqual(r.alerta, true); assert.strictEqual(r.percentual_limite, 75.5); assert.ok(/75%/.test(r.avisos[0]));
  const r2 = custo.resumirMes([{ dia: '2026-10-03', funcao: 'atas', chamadas: 1, custo_usd: 250 }], '2026-10', new Date('2026-11-01T12:00:00Z'), 200);
  assert.ok(/passou do limite/.test(r2.avisos[0]));
  const r3 = custo.resumirMes([{ dia: '2026-10-01', funcao: 'atas', chamadas: 1, custo_usd: 50 }], '2026-10', new Date('2026-10-03T15:00:00Z'), 200);
  assert.strictEqual(r3.alerta, false); assert.ok(r3.avisos.some((a) => /ritmo/.test(a)));
});
t('mês futuro e lista vazia', () => {
  const r = custo.resumirMes([], '2026-12', new Date('2026-10-21T12:00:00Z'), 200);
  assert.strictEqual(r.total_usd, 0); assert.strictEqual(r.projecao_usd, 0); assert.deepStrictEqual(r.por_funcao, []);
});

// ---------- rota do painel: só o dono ----------
function montarRota(nivel, banco) {
  const app = { rotas: {}, get(c, ...h) { this.rotas[c] = h; } };
  const eventos = [];
  criarRotasCusto(app, { requireAuth: (req, res, next) => next(), banco, auditoria: { nivel: async () => { if (nivel instanceof Error) throw nivel; return nivel; }, evento: (...a) => eventos.push(a) } });
  return { app, eventos };
}
async function chamarRota(app, query) {
  const res = { st: 200, corpo: null, status(s) { this.st = s; return this; }, json(o) { this.corpo = o; return this; }, set() { return this; } };
  const [auth, h] = app.rotas['/api/custo/resumo'];
  await new Promise((r) => auth({}, res, r));
  await h({ query: query || {} }, res);
  return res;
}
const bancoOk = async () => ({ status: 200, body: LINHAS });
t('dono vê o resumo, sem nome de modelo nem fornecedor', async () => {
  const { app } = montarRota('dono', bancoOk);
  const r = await chamarRota(app, { mes: '2026-10' });
  assert.strictEqual(r.st, 200); assert.strictEqual(r.corpo.total_usd, 2.1);
  assert.ok(!/claude|sonnet|haiku|opus|anthropic|modelo/i.test(JSON.stringify(r.corpo)));
});
t('auditor, sem nível e erro na checagem recebem 403 e ficam no registro', async () => {
  for (const n of ['auditor', null, new Error('x')]) {
    const { app, eventos } = montarRota(n, bancoOk);
    const r = await chamarRota(app, { mes: '2026-10' });
    assert.strictEqual(r.st, 403); assert.strictEqual(eventos[0][1], 'custo_negado');
  }
});
t('mês inválido cai no mês corrente; banco caído dá 500 sem detalhe técnico', async () => {
  let pedido = '';
  const { app } = montarRota('dono', async (m, p, corpo) => { pedido = m + ' ' + p + ' ' + JSON.stringify(corpo); return { status: 200, body: [] }; });
  await chamarRota(app, { mes: '2026-13' });
  assert.ok(/^POST \/rest\/v1\/rpc\/api_uso_resumo \{"de":"\d{4}-\d{2}-01","ate":"\d{4}-\d{2}-\d{2}"\}$/.test(pedido), pedido);
  await chamarRota(app, { mes: '2026-02' });
  assert.ok(pedido.includes('"de":"2026-02-01","ate":"2026-02-28"'), pedido);
  const { app: app2 } = montarRota('dono', async () => { throw new Error('rede'); });
  const r = await chamarRota(app2, { mes: '2026-10' });
  assert.strictEqual(r.st, 500); assert.ok(!/rede/.test(JSON.stringify(r.corpo)));
});

// ---------- motor da ata: registro não derruba ----------
t('chamarAnthropicAta entrega o texto com o banco do custo caindo e grava a função', async () => {
  const srv = require('../server');
  custo.configurar({ banco: () => { throw new Error('caiu'); } });
  respostaFalsa.json.content = [{ type: 'text', text: 'ATA' }];
  pedidos = [];
  const r = await srv.chamarAnthropicAta('modelo_da_ata', 100, 'sys', 'msg', false, { funcao: 'atas' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.texto, 'ATA');
  assert.strictEqual(pedidos[0].corpo.model, modelos.modelo('ata'), 'marcador virou o modelo da ata');
  const gravadas = [];
  custo.configurar({ banco: async (m, p, l) => { gravadas.push(l); return { status: 201 }; } });
  await srv.chamarAnthropicAta('claude-sonnet-5-5', 100, 'sys', 'msg', false, { funcao: 'comunicados', condominio: '167' });
  await esperar(20);
  assert.strictEqual(gravadas[0].funcao, 'comunicados'); assert.strictEqual(gravadas[0].id_superlogica, 167);
});

(async () => {
  for (const [nome, fn] of testes) {
    try { await fn(); ok++; } catch (e) { falhas++; console.log('FALHOU: ' + nome + ': ' + e.message); }
  }
  console.log('teste-custo-api: ' + ok + ' ok, ' + falhas + ' falha(s)');
  process.exit(falhas ? 1 : 0);
})();
