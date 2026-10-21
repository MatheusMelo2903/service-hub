// Testes do lançamento direto da entrada de documentos (T40), sem rede e sem Superlógica:
// NODE_PATH=<repo>/node_modules node scripts/teste-entrada-lancar.js
// Parte 1: travas puras (liberação, confiança, mês fechado, categoria, duplicidade) com um
// cliente do Superlógica simulado. Parte 2: as rotas num express local com banco em memória e
// a gravação simulada (E.lancar trocado), para conferir lote, recusa e registro de quem lançou.
const E = require('../financeiro/entrada');
let ok = 0, falhou = 0;
function t(nome, cond) { if (cond) ok++; else { falhou++; console.log('FALHOU: ' + nome); } }

function mod10(s) { let soma = 0, p = 2; for (let i = s.length - 1; i >= 0; i--) { let x = +s[i] * p; if (x > 9) x = Math.floor(x / 10) + (x % 10); soma += x; p = p === 2 ? 1 : 2; } const r = soma % 10; return r === 0 ? 0 : 10 - r; }
function linhaBoleto(fator, valorCent, livre) {
  const sem = '0019' + String(fator).padStart(4, '0') + String(valorCent).padStart(10, '0') + livre;
  let soma = 0, p = 2; for (let i = sem.length - 1; i >= 0; i--) { soma += +sem[i] * p; p = p === 9 ? 2 : p + 1; }
  let dv = 11 - (soma % 11); if (dv === 0 || dv === 10 || dv === 11) dv = 1;
  const b = sem.slice(0, 4) + dv + sem.slice(4);
  const c1 = b.slice(0, 4) + b.slice(19, 24), c2 = b.slice(24, 34), c3 = b.slice(34, 44);
  return c1 + mod10(c1) + c2 + mod10(c2) + c3 + mod10(c3) + b[4] + b.slice(5, 19);
}
function cnpj(base12) {
  const dv = (b) => { const ps = b.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = b.split('').reduce((a, d, i) => a + +d * ps[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base12); return base12 + d1 + dv(base12 + d1);
}
const HOJE = '2026-10-21';
const C167 = cnpj('333333330001'), C136 = cnpj('444444440001');
// Fator 1626 = 2026-11-10 (ciclo novo); R$ 250,00.
const L = linhaBoleto(1626, 25000, '9876543210987654321098765');
const lidaL = E.acharLinha(L, HOJE);

// ---------- 1. liberação por condomínio ----------
t('padrão só 167', E.liberados({}).join() === '167');
t('lista sem 167 não libera o 167', !E.lancamentoLiberado('167', { ENTRADA_LANCAMENTO_LIBERADO: '136' }) && E.lancamentoLiberado('136', { ENTRADA_LANCAMENTO_LIBERADO: '136' }));
t('ids de fora nunca', !E.lancamentoLiberado('143', { ENTRADA_LANCAMENTO_LIBERADO: '143,144,145,160,162' }) && E.liberados({ ENTRADA_LANCAMENTO_LIBERADO: '143,144,145,160,162' }).length === 0);
t('lixo na lista ignorado', E.liberados({ ENTRADA_LANCAMENTO_LIBERADO: '136; abc, 0, -1 ,140' }).join() === '136,140');
t('id inválido nunca', !E.lancamentoLiberado('', {}) && !E.lancamentoLiberado(null, {}) && !E.lancamentoLiberado('167 ', {}));

// ---------- 2. confiança de valor e vencimento ----------
t('linha de teste lida', !!lidaL && lidaL.valor === 250 && lidaL.vencimento === '2026-11-10');
let cf = E.confianca({ valor: 250, valor_linha: 250, vencimento: '2026-11-10', vencimento_linha: '2026-11-10' });
t('linha conferida: alta', cf.valor === 'alta' && cf.vencimento === 'alta');
cf = E.confianca({ valor: 251, valor_linha: 250, vencimento: '2026-11-11', vencimento_linha: '2026-11-10' });
t('diferente da linha: baixa', cf.valor === 'baixa' && cf.vencimento === 'baixa');
cf = E.confianca({ valor: 99.9, vencimento: '2026-11-05', confirmado: { valor: 99.9, vencimento: '2026-11-05' } });
t('confirmado na tela', cf.valor === 'confirmado' && cf.vencimento === 'confirmado');
cf = E.confianca({ valor: 100, vencimento: '2026-11-06', confirmado: { valor: 99.9, vencimento: '2026-11-05' } });
t('confirmação presa ao valor', cf.valor === 'baixa' && cf.vencimento === 'baixa');
const txt = 'Beneficiário X CNPJ ' + E.formatarCnpj(C136) + '\nVencimento 05/11/2026\nValor do documento R$ 10,00';
const lc = E.lerCampos(txt, HOJE);
t('vencimento do texto marca origem texto', lc.vencimento === '2026-11-05' && lc.origem_vencimento === 'texto' && lc.origem_valor === 'texto');
t('vencimento da linha marca origem linha', E.lerCampos('Boleto\n' + L, HOJE).origem_vencimento === 'linha');
t('leitura interna marca origem leitura', E.camposDaLeitura({ tipo: 'nota', valor: '5,00', vencimento: '05/11/2026' }, HOJE).origem_vencimento === 'leitura');
t('confirmar impede', !E.podeLancar([{ codigo: 'confirmar_valor', nivel: 'impede' }], ['confirmar_valor']).ok && E.IMPEDE.includes('mes_fechado'));

// ---------- 3. mês fechado (data de bloqueio das contas) ----------
t('data SL', E.dataSL('09/30/2026 00:00:00') === '2026-09-30' && E.dataSL('2026-09-30') === '2026-09-30' && E.dataSL('') === null && E.dataSL('00/00/0000') === null && E.dataSL('13/40/2026') === null);
const rc = E.resumoContas([
  { id_condominio_cond: '167', id_contabanco_cb: '900', fl_principal_cb: '0', st_descricao_cb: 'Poupança', dt_bloquearlancamentos_cb: '10/31/2026' },
  { id_condominio_cond: '167', id_contabanco_cb: '823', fl_principal_cb: '1', st_descricao_cb: 'Conta movimento', dt_bloquearlancamentos_cb: '09/30/2026' },
  { id_condominio_cond: '999', id_contabanco_cb: '1', fl_principal_cb: '1', dt_bloquearlancamentos_cb: '12/31/2026' },
], '167');
t('contas: principal e maior bloqueio do condomínio', rc.id === '823' && rc.nome === 'Conta movimento' && rc.bloqueio === '2026-10-31' && rc.quantidade === 2);

// ---------- 4. categoria pelo histórico ----------
const ap = (c) => [{ st_conta_cont: c, st_descricao_cont: 'C' + c }];
const hist = [
  { id_despesa_des: '1', id_contato_con: '10', dt_vencimento_pdes: '10/01/2026', apropriacao: ap('2.1') },
  { id_despesa_des: '2', id_contato_con: '10', dt_vencimento_pdes: '09/01/2026', apropriacao: ap('2.2') },
  { id_despesa_des: '3', id_contato_con: '10', dt_vencimento_pdes: '08/01/2026', apropriacao: ap('2.2') },
  { id_despesa_des: '3', id_contato_con: '10', dt_vencimento_pdes: '08/15/2026', apropriacao: ap('2.1') },
  { id_despesa_des: '4', id_contato_con: '11', dt_vencimento_pdes: '10/05/2026', apropriacao: ap('2.9') },
];
const sug = E.contaSugerida(hist, '10');
t('categoria mais frequente do fornecedor', sug && sug.conta === '2.1' && sug.vezes === 2 && sug.de === 3);
t('empate fica com a mais recente', E.contaSugerida(hist.slice(0, 2), '10').conta === '2.1');
t('sem histórico sem sugestão', E.contaSugerida(hist, '77') === null);

// ---------- 5. conferir com o Superlógica simulado ----------
function cliente(cfg) {
  return {
    chamadas: [],
    async get(rota, p) {
      this.chamadas.push(rota);
      if (rota === 'condominios/get') return p.pagina > 1 ? [] : [
        { id_condominio_cond: '167', st_fantasia_cond: 'Residencial Teste', id_planoconta_plc: '1', st_cnpj_cond: C167 },
        { id_condominio_cond: '73', st_fantasia_cond: 'Outro cadastro', id_planoconta_plc: '1', st_cnpj_cond: cfg.cnpjRepetido ? C167 : cnpj('555555550001') },
        { id_condominio_cond: '136', st_fantasia_cond: 'Casablanca', id_planoconta_plc: '2', st_cnpj_cond: C136 },
      ];
      if (rota === 'despesas/index') {
        if (p.pagina > 1) return [];
        if (String(p.idCondominio) === '-1') return cfg.todos || [];
        return cfg.parcelas || [];
      }
      if (rota === 'contabancos/index') {
        if (cfg.contasErro) throw new Error('HTTP 500');
        return [{ id_condominio_cond: String(p.idCondominio), id_contabanco_cb: '823', fl_principal_cb: '1', st_descricao_cb: 'Conta movimento', dt_bloquearlancamentos_cb: cfg.bloqueio || '' }];
      }
      return [];
    },
  };
}
const base = (o) => Object.assign({ id_superlogica: '167', id_fornecedor: '10', valor: 250, valor_linha: 250, vencimento: '2026-11-10', vencimento_linha: '2026-11-10', conta: '2.2', tipo: 'boleto', documento: 'X1' }, o || {});
const cods = (r) => r.alertas.map((a) => a.codigo);
(async () => {
  let r;
  E.limparCache();
  r = await E.conferir(cliente({}), base(), { hojeIso: HOJE });
  t('documento limpo sem alertas', r.alertas.length === 0 && r.conta_banco.id === '823' && E.podeLancar(r.alertas, []).ok);
  E.limparCache();
  r = await E.conferir(cliente({ bloqueio: '11/30/2026' }), base(), { hojeIso: HOJE });
  t('mês fechado recusa', cods(r).includes('mes_fechado') && !E.podeLancar(r.alertas, ['mes_fechado']).ok);
  E.limparCache();
  r = await E.conferir(cliente({ bloqueio: '11/10/2026' }), base(), { hojeIso: HOJE });
  t('vencimento no dia do bloqueio também recusa', cods(r).includes('mes_fechado'));
  E.limparCache();
  r = await E.conferir(cliente({ bloqueio: '11/09/2026' }), base(), { hojeIso: HOJE });
  t('vencimento depois do bloqueio passa', !cods(r).includes('mes_fechado'));
  E.limparCache();
  r = await E.conferir(cliente({ contasErro: true }), base(), { hojeIso: HOJE });
  t('sem conferir o bloqueio não lança', cods(r).includes('conferencia_incompleta') && !E.podeLancar(r.alertas, []).ok);
  E.limparCache();
  r = await E.conferir(cliente({}), base({ valor_linha: null, vencimento_linha: null }), { hojeIso: HOJE });
  t('valor e vencimento sem linha pedem conferência', cods(r).includes('confirmar_valor') && cods(r).includes('confirmar_vencimento') && !E.podeLancar(r.alertas, []).ok);
  E.limparCache();
  r = await E.conferir(cliente({}), base({ valor_linha: null, vencimento_linha: null, confirmado: { valor: 250, vencimento: '2026-11-10' } }), { hojeIso: HOJE });
  t('confirmados na tela passam', !cods(r).includes('confirmar_valor') && !cods(r).includes('confirmar_vencimento'));
  E.limparCache();
  const par = (o) => Object.assign({ id_despesa_des: '500', id_parcela_pdes: '600', id_condominio_cond: '167', id_contato_con: '10', st_documento_des: '', vl_valor_pdes: '250.00', dt_vencimento_pdes: '11/10/2026', st_codigobarras_pdes: '' }, o);
  r = await E.conferir(cliente({ parcelas: [par({})] }), base({ documento: null }), { hojeIso: HOJE });
  t('duplicidade mesmo fornecedor, valor e vencimento', cods(r).includes('duplicidade') && r.alertas.find((a) => a.codigo === 'duplicidade').nivel === 'grave');
  E.limparCache();
  r = await E.conferir(cliente({ parcelas: [par({ id_contato_con: '99', vl_valor_pdes: '1.00', st_codigobarras_pdes: L })] }), base({ linha: L, barras: E.barrasDaLinha(L) }), { hojeIso: HOJE });
  t('duplicidade mesma linha digitável', (r.alertas.find((a) => a.codigo === 'duplicidade') || { itens: [] }).itens[0].motivos.includes('mesma_linha'));
  E.limparCache();
  r = await E.conferir(cliente({ todos: [par({ id_condominio_cond: '136', st_fantasia_cond: 'Casablanca', st_codigobarras_pdes: L })] }), base({ linha: L, barras: E.barrasDaLinha(L) }), { hojeIso: HOJE });
  t('boleto já lançado em outro condomínio', cods(r).includes('outro_condominio'));
  E.limparCache();
  r = await E.conferir(cliente({}), base({ cond_documento: '136' }), { hojeIso: HOJE });
  t('boleto de outro condomínio pelo CNPJ', cods(r).includes('condominio_diferente_do_documento'));
  E.limparCache();
  r = await E.conferir(cliente({ cnpjRepetido: true }), base(), { hojeIso: HOJE });
  t('CNPJ repetido entre cadastros vira alerta grave', cods(r).includes('cnpj_repetido'));
  E.limparCache();
  const idt = await E.identificar(cliente({ cnpjRepetido: true }), { cnpjs: [{ cnpj: C167, papel: 'pagador', ordem: 0 }] }, null);
  t('CNPJ repetido nunca escolhe o condomínio sozinho', idt.condominio === null && idt.motivo_condominio === 'cnpj_em_mais_de_um_cadastro');
  E.limparCache();
  r = await E.conferir(cliente({ parcelas: [] }), base({ conta: null }), { hojeIso: HOJE });
  t('sem histórico perto, procura 180 dias', r.sugestao_conta === null);

  // ---------- 6. rotas com banco em memória e gravação simulada ----------
  await testeRotas();
  console.log('entrada lançar: ' + ok + ' ok, ' + falhou + ' falhou');
  process.exit(falhou ? 1 : 0);
})().catch((e) => { console.log('ERRO ' + (e && e.stack)); process.exit(1); });

// Banco em memória com só o que as rotas da entrada usam (GET, PATCH com filtro de status).
function bancoMemoria(linhas) {
  const db = new Map(linhas.map((l) => [l.id, l]));
  return {
    db,
    async banco(metodo, caminho, corpo) {
      const q = new URLSearchParams(caminho.split('?')[1] || '');
      const id = (q.get('id') || '').replace(/^eq\./, '');
      const st = q.get('status');
      if (metodo === 'GET') {
        if (q.get('dados->>linha')) {
          const lin = q.get('dados->>linha').replace(/^eq\./, ''), nao = (q.get('id') || '').replace(/^neq\./, '');
          return { status: 200, body: [...db.values()].filter((l) => l.status !== 'descartado' && l.dados.linha === lin && l.id !== nao) };
        }
        if (id) return { status: 200, body: db.has(id) ? [JSON.parse(JSON.stringify(db.get(id)))] : [] };
        return { status: 200, body: [...db.values()].map((l) => JSON.parse(JSON.stringify(l))) };
      }
      if (metodo === 'PATCH') {
        const l = db.get(id);
        if (!l || (st && st !== 'eq.' + l.status)) return { status: 200, body: [] };
        Object.assign(l, JSON.parse(JSON.stringify(corpo)));
        return { status: 200, body: [JSON.parse(JSON.stringify(l))] };
      }
      return { status: 400, body: null };
    },
  };
}
async function testeRotas() {
  let express;
  try { express = require('express'); } catch (e) { console.log('AVISO: express não encontrado (use NODE_PATH); rotas não testadas'); falhou++; return; }
  const { criarRotasEntrada } = require('../servico/rotas-entrada');
  const pdf = Buffer.from('%PDF-1.4\n' + 'x'.repeat(300)).toString('base64');
  const linha = (id, idSL, dados, extra) => Object.assign({ id, status: 'rascunho', nome_arquivo: id.slice(0, 4) + '.pdf', arquivo_base64: pdf, hash_sha256: id, criado_por: 'u1', id_superlogica: Number(idSL),
    dados: Object.assign({ id_superlogica: String(idSL), nome_condominio: 'C' + idSL, id_fornecedor: '10', valor: 250, vencimento: '2026-11-10', conta: '2.2', tipo: 'boleto' }, dados || {}), alertas: [] }, extra || {});
  const U = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const mem = bancoMemoria([
    linha(U(1), 167, { linha: L, barras: E.barrasDaLinha(L) }), linha(U(2), 167, { valor: 80, vencimento: '2026-11-12' }),
    linha(U(3), 136, { confirmado: { valor: 250, vencimento: '2026-11-10' } }), linha(U(4), 167, { valor: 90, vencimento: '2026-11-13', cond_documento: '136', confirmado: { valor: 90, vencimento: '2026-11-13' } }),
    linha(U(5), 167, { valor: 70, vencimento: '2026-11-14', confirmado: { valor: 70, vencimento: '2026-11-14' } }), linha(U(6), 167, {}, { status: 'lancado' }),
  ]);
  const gravados = [], eventos = [];
  const cli = {
    async get(rota, p) {
      if (rota === 'condominios/get') return p.pagina > 1 ? [] : [{ id_condominio_cond: '167', st_fantasia_cond: 'Residencial Teste', id_planoconta_plc: '1', st_cnpj_cond: C167 }, { id_condominio_cond: '136', st_fantasia_cond: 'Casablanca', id_planoconta_plc: '2', st_cnpj_cond: C136 }];
      if (rota === 'fornecedores/index') return [{ id_contato_con: '10', st_nome_con: 'FORNECEDOR TESTE' }];
      if (rota === 'planocontas') return [{ st_conta_cont: '2.2', st_descricao_cont: 'Outros' }];
      if (rota === 'contabancos/index') return [{ id_condominio_cond: String(p.idCondominio), id_contabanco_cb: '823', fl_principal_cb: '1', st_descricao_cb: 'Conta movimento', dt_bloquearlancamentos_cb: '09/30/2026' }];
      return [];
    },
  };
  const original = E.lancar;
  E.lancar = async (cred, c, d) => { gravados.push({ cond: d.id_superlogica, valor: d.valor, cb: d.id_contabanco }); return { ok: true, conferido: true, anexado: true, prova: { valor: true, fornecedor: true, condominio: true, vencimento: true, anexo: true }, id_despesa: String(9000 + gravados.length), id_arquivo: '1', id_parcela: '2' }; };
  const app = express();
  app.use((req, res, next) => { req.user = { sub: 'u1', email: 'analista@example.com' }; req.authMode = 'user'; next(); });
  let podeLancarModulo = true;
  criarRotasEntrada(app, {
    requireAuth: (req, res, next) => next(), express, banco: mem.banco, perfilDe: async () => ({}),
    podeModulo: (p, m, a) => m === 'entrada_documentos' && (a === 'ver' || podeLancarModulo),
    carteiraT18: { escopo: async () => ({ todas: true }) }, exigirLeituraSuperlogica: async () => true, superlogicaNativa: () => true,
    clienteSL: () => cli, credSL: () => ({}), dentroDoLimite: () => true, auditoria: { evento: (req, tipo, det) => eventos.push({ tipo, det }) }, processar: {},
    carteiraEstrita: async () => true,
  });
  const srv = app.listen(0);
  const porta = srv.address().port;
  const chama = async (m, url, corpo) => { const r = await fetch('http://127.0.0.1:' + porta + url, { method: m, headers: { 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined }); return { st: r.status, j: await r.json().catch(() => ({})) }; };
  delete process.env.ENTRADA_LANCAMENTO_LIBERADO;
  try {
    let r = await chama('GET', '/api/entrada/fila?status=rascunho');
    const it1 = (r.j.itens || []).find((x) => x.id === U(1)), it3 = (r.j.itens || []).find((x) => x.id === U(3)), it2 = (r.j.itens || []).find((x) => x.id === U(2));
    t('fila diz o que é liberado', r.st === 200 && r.j.so_teste === true && it1.liberado === true && it3.liberado === false && it2.confianca.valor === 'baixa');
    r = await chama('POST', '/api/entrada/' + U(3) + '/lancar', { confirmacao: 'LANCAR' });
    t('condomínio fora da lista: 423 e nada gravado', r.st === 423 && gravados.length === 0);
    r = await chama('POST', '/api/entrada/' + U(3) + '/pronto');
    t('fora da lista gera rascunho conferido', r.st === 200 && r.j.item.dados.pronto && r.j.item.dados.pronto.por === 'analista@example.com' && gravados.length === 0 && mem.db.get(U(3)).status === 'rascunho');
    r = await chama('POST', '/api/entrada/' + U(2) + '/lancar', { confirmacao: 'LANCAR' });
    t('valor sem confiança não lança', r.st === 409 && r.j.erro === 'impede' && /valor/.test(r.j.detalhe) && gravados.length === 0);
    r = await chama('PUT', '/api/entrada/' + U(2), { confirmar_valor: true, confirmar_vencimento: true });
    t('conferi na tela grava a confirmação', r.st === 200 && r.j.item.confianca.valor === 'confirmado' && r.j.item.dados.confirmado.valor_por === 'analista@example.com');
    r = await chama('POST', '/api/entrada/lancar-lote', { confirmacao: 'LANCAR_LOTE', itens: [{ id: U(1), valor: 250, vencimento: '2026-11-10' }, { id: U(2), valor: 80, vencimento: '2026-11-12' }, { id: U(3), valor: 250, vencimento: '2026-11-10' }, { id: U(4), valor: 90, vencimento: '2026-11-13' }, { id: U(5), valor: 71, vencimento: '2026-11-14' }, { id: U(6), valor: 250, vencimento: '2026-11-10' }] });
    const rs = (id) => (r.j.resultados || []).find((x) => x.id === id) || {};
    t('lote: liberados e conferidos lançam', r.st === 200 && rs(U(1)).ok && rs(U(2)).ok && gravados.length === 2 && gravados.every((g) => g.cond === '167' && g.cb === '823'));
    t('lote: fora da lista recusa', rs(U(3)).st === 423);
    t('lote: alerta grave não passa', rs(U(4)).st === 409 && rs(U(4)).erro === 'grave_nao_aceito' && mem.db.get(U(4)).status === 'rascunho');
    t('lote: valor mudou é pulado', rs(U(5)).erro === 'mudou');
    t('lote: já lançado recusa', rs(U(6)).st === 409);
    const l1 = mem.db.get(U(1));
    t('registro de quem lançou', l1.status === 'lancado' && l1.lancado_por === 'u1' && l1.resultado.lancado_por_email === 'analista@example.com' && l1.resultado.origem === 'lote' && l1.id_despesa);
    t('auditoria do lote', eventos.some((e) => e.tipo === 'entrada_lote' && e.det.lancados === 2) && eventos.some((e) => e.tipo === 'entrada_lancada' && e.det.origem === 'lote'));
    r = await chama('POST', '/api/entrada/' + U(1) + '/lancar', { confirmacao: 'LANCAR' });
    t('lançar de novo recusa', r.st === 409 && gravados.length === 2);
    r = await chama('POST', '/api/entrada/lancar-lote', { confirmacao: 'LANCAR_LOTE', itens: [{ id: U(5), valor: 70, vencimento: '2026-11-14' }, { id: U(5), valor: 70, vencimento: '2026-11-14' }] });
    t('lote com id repetido recusa inteiro', r.st === 400 && gravados.length === 2);
    r = await chama('POST', '/api/entrada/lancar-lote', { confirmacao: 'SIM', itens: [{ id: U(5), valor: 70, vencimento: '2026-11-14' }] });
    t('lote sem confirmação recusa', r.st === 400);
    // mês fechado: bloqueio depois do vencimento
    const getAntes = cli.get;
    cli.get = async (rota, p) => rota === 'contabancos/index' ? [{ id_condominio_cond: String(p.idCondominio), id_contabanco_cb: '823', fl_principal_cb: '1', dt_bloquearlancamentos_cb: '11/30/2026' }] : getAntes(rota, p);
    r = await chama('POST', '/api/entrada/' + U(5) + '/lancar', { confirmacao: 'LANCAR', aceitar_alertas: ['mes_fechado'] });
    t('mês fechado recusa mesmo marcando', r.st === 409 && /fechado/.test(r.j.detalhe) && gravados.length === 2);
    cli.get = getAntes;
    process.env.ENTRADA_LANCAMENTO_LIBERADO = '136';
    r = await chama('POST', '/api/entrada/' + U(5) + '/lancar', { confirmacao: 'LANCAR' });
    t('lista sem o 167 trava o 167', r.st === 423 && gravados.length === 2);
    delete process.env.ENTRADA_LANCAMENTO_LIBERADO;
    podeLancarModulo = false;
    r = await chama('POST', '/api/entrada/' + U(5) + '/lancar', { confirmacao: 'LANCAR' });
    t('sem a ação lancar: 403', r.st === 403 && gravados.length === 2);
    r = await chama('POST', '/api/entrada/lancar-lote', { confirmacao: 'LANCAR_LOTE', itens: [{ id: U(5), valor: 70, vencimento: '2026-11-14' }] });
    t('lote sem a ação lancar: 403', r.st === 403 && gravados.length === 2);
    podeLancarModulo = true;
    r = await chama('POST', '/api/entrada/' + U(5) + '/lancar', { confirmacao: 'LANCAR' });
    t('individual com tudo certo lança', r.st === 200 && r.j.conferido === true && gravados.length === 3 && mem.db.get(U(5)).resultado.origem === 'individual');
  } finally { srv.close(); E.lancar = original; }
}
