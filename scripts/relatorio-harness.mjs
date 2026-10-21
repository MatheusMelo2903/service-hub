// Harness T13: relatório mensal do síndico (só leitura). Rodar com servidor local:
//   railway run --service service-hub --environment dev -- env BASE=http://localhost:3921 COND=136 node scripts/relatorio-harness.mjs
const BASE = process.env.BASE || 'http://localhost:3921';
const H = { Authorization: 'Bearer ' + (process.env.INTERNAL_API_SECRET || '') };
const COND = process.env.COND || '167';
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '  -> ' + d); } };
const get = async (p, h) => { const r = await fetch(BASE + p, { headers: h || H }); return { s: r.status, j: await r.json().catch(() => ({})) }; };

let r = await get('/api/condominio/abc/relatorio-mensal');
check('id inválido 400', r.s === 400, r.s);
r = await get('/api/condominio/' + COND + '/relatorio-mensal?mes=2099-01');
check('mês futuro 400', r.s === 400, r.s);
r = await get('/api/condominio/' + COND + '/relatorio-mensal?mes=2026-13');
check('mês 13 400', r.s === 400, r.s);
r = await get('/api/condominio/' + COND + '/relatorio-mensal', {});
check('sem auth 401', r.s === 401, r.s);
r = await get('/api/condominio/' + COND + '/relatorio-mensal' + (process.env.MES ? '?mes=' + process.env.MES : ''));
check('relatório 200', r.s === 200, JSON.stringify(r.j).slice(0, 200));
const d = r.j;
const dem = d.demonstrativo || {};
const somaRec = Math.round((dem.receitas || []).reduce((s, x) => s + x.valor, 0) * 100) / 100;
const somaDesp = Math.round((dem.despesas || []).reduce((s, x) => s + x.valor, 0) * 100) / 100;
console.log('    mês', d.mes, 'fechado', d.mes_fechado, 'saldo ini', d.saldo_inicio_mes, 'fim', d.saldo_fim_mes, 'receitas', dem.total_receitas, '(soma', somaRec + ') despesas', dem.total_despesas, '(soma', somaDesp + ')');
console.log('    contas', d.contas && d.contas.contas.length, 'inad', d.inadimplencia && d.inadimplencia.total_corrigido, 'a vencer', d.a_vencer_30_dias && d.a_vencer_30_dias.quantidade, 'alertas', d.alertas && d.alertas.length, 'falhas', JSON.stringify(d.falhas), 'cond', d.condominio && d.condominio.nome);
check('soma das receitas bate com o total', Math.abs(somaRec - (dem.total_receitas || 0)) < 0.05, somaRec + ' x ' + dem.total_receitas);
check('soma dos grupos de despesa bate com o total', Math.abs(somaDesp - (dem.total_despesas || 0)) < 0.05, somaDesp + ' x ' + dem.total_despesas);
if (d.mes_fechado && d.saldo_inicio_mes != null && d.saldo_fim_mes != null) {
  const esperado = Math.round((d.saldo_inicio_mes + dem.total_receitas - dem.total_despesas) * 100) / 100;
  console.log('    saldo ini + receitas - despesas =', esperado, 'x saldo fim', d.saldo_fim_mes, '(diferença pode vir de transferências e estornos)');
}
check('sem dado sensível (CPF, token, responsável da unidade) no JSON', !/st_token|st_secret|cpf|senha|responsavel|st_sacado/i.test(JSON.stringify(d)), 'achou campo sensível');
r = await get('/api/condominio/' + COND + '/relatorio-mensal?mes=2026-01');
check('janeiro (mês fechado de outro ano) 200', r.s === 200 && r.j.mes === '2026-01' && r.j.mes_fechado === true, r.s + ' ' + r.j.mes);
const agora = new Date(Date.now() - 3 * 3600 * 1000);
const mesAtual = agora.getUTCFullYear() + '-' + String(agora.getUTCMonth() + 1).padStart(2, '0');
r = await get('/api/condominio/' + COND + '/relatorio-mensal?mes=' + mesAtual);
check('mês em andamento marcado como não fechado', r.s === 200 && r.j.mes_fechado === false && r.j.saldo_fim_mes === null, r.s + ' ' + r.j.mes_fechado);
console.log('\n===== RESULTADO: ' + ok + ' PASS, ' + fail + ' FAIL =====');
