// Harness T05: checagem de despesas antes do envio e alertas. Só LEITURA no Superlógica
// (a gravação real de despesa é testada pela tela, no condomínio de teste 167). Grava no
// Supabase de teste só as tabelas alertas e alertas_config.
// Rodar com o servidor local e o segredo injetado pelo railway run:
//   railway run --service service-hub --environment dev -- env BASE=http://localhost:3918 node scripts/despesas-alertas-harness.mjs
const BASE = process.env.BASE || 'http://localhost:3918';
const H = { Authorization: 'Bearer ' + (process.env.INTERNAL_API_SECRET || ''), 'Content-Type': 'application/json' };
const COND_TESTE = 167;
// Condomínio real usado SÓ para leitura (duplicata e alertas com dados reais); vem por env.
const COND_LEITURA = Number(process.env.COND_LEITURA || 0);
const DUP = process.env.DUP_JSON ? JSON.parse(process.env.DUP_JSON) : null; // { fornecedor_id, vencimento, valor }
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '  -> ' + d); } };
const req = async (m, p, b, h) => { const r = await fetch(BASE + p, { method: m, headers: h || H, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };

// Erros de entrada
let r = await req('POST', '/api/despesas/verificar', { id_superlogica: 'x', linhas: [] });
check('id inválido -> 400', r.s === 400, r.s);
r = await req('POST', '/api/despesas/verificar', { id_superlogica: COND_TESTE, linhas: [] });
check('sem linhas -> 400', r.s === 400 && r.j.erro === 'linhas_invalidas', JSON.stringify(r.j));
r = await req('POST', '/api/despesas/verificar', { id_superlogica: COND_TESTE, linhas: [{ linha: 2, fornecedor_id: 'abc', vencimento: '11/10/2026', valor: 10 }] });
check('fornecedor não numérico -> 400', r.s === 400, r.s);
r = await req('POST', '/api/despesas/verificar', { id_superlogica: COND_TESTE, linhas: [] }, { 'Content-Type': 'application/json' });
check('sem auth -> 401', r.s === 401, r.s);
r = await req('PATCH', '/api/alertas/nao-uuid', { status: 'visto' });
check('alerta id inválido -> 400', r.s === 400, r.s);
r = await req('PATCH', '/api/alertas/' + crypto.randomUUID(), { status: 'apagado' });
check('status inválido -> 400', r.s === 400, r.s);
r = await req('PUT', '/api/condominio/' + COND_TESTE + '/alertas/config', { saldo_minimo: -5 });
check('saldo negativo -> 400', r.s === 400, r.s);

// Fornecedor inexistente e repetida na planilha (condomínio de teste, só leitura)
r = await req('POST', '/api/despesas/verificar', { id_superlogica: COND_TESTE, linhas: [
  { linha: 2, fornecedor_id: '999999991', vencimento: '11/10/2026', valor: 123.45, documento: 'T1' },
  { linha: 3, fornecedor_id: '6263', vencimento: '11/10/2026', valor: 50, documento: 'NF9' },
  { linha: 4, fornecedor_id: '6263', vencimento: '11/10/2026', valor: 50, documento: 'NF9' },
] });
check('verificar 200', r.s === 200, JSON.stringify(r.j));
check('fornecedor inexistente apontado', (r.j.fornecedor_inexistente || []).some((f) => f.linha === 2), JSON.stringify(r.j.fornecedor_inexistente));
check('fornecedor existente não apontado', !(r.j.fornecedor_inexistente || []).some((f) => f.linha === 3), JSON.stringify(r.j.fornecedor_inexistente));
check('repetida na planilha (linha 4 = linha 3)', (r.j.duplicadas || []).some((d) => d.linha === 4 && d.origem === 'planilha' && d.igual_a_linha === 3), JSON.stringify(r.j.duplicadas));
check('pode_enviar false', r.j.pode_enviar === false, r.j.pode_enviar);

// Duplicata real (condomínio real, só leitura)
if (COND_LEITURA && DUP) {
  r = await req('POST', '/api/despesas/verificar', { id_superlogica: COND_LEITURA, linhas: [
    { linha: 2, fornecedor_id: DUP.fornecedor_id, vencimento: DUP.vencimento, valor: DUP.valor },
    { linha: 3, fornecedor_id: DUP.fornecedor_id, vencimento: DUP.vencimento, valor: DUP.valor + 1 },
    { linha: 4, fornecedor_id: DUP.fornecedor_id, vencimento: DUP.vencimento, valor: DUP.valor, documento: 'OUTRA-NOTA-XYZ' },
  ] });
  check('duplicata real achada (linha 2)', (r.j.duplicadas || []).some((d) => d.linha === 2 && d.origem === 'superlogica'), JSON.stringify(r.j.duplicadas));
  check('valor diferente não é duplicata (linha 3)', !(r.j.duplicadas || []).some((d) => d.linha === 3), JSON.stringify(r.j.duplicadas));
  // despesa antiga lançada SEM documento + planilha com documento = duplicata (envio antigo não mandava documento)
  check('lançada sem documento + planilha com documento = duplicata (linha 4)', (r.j.duplicadas || []).some((d) => d.linha === 4), JSON.stringify(r.j.duplicadas));
  const DOC = process.env.DOC_JSON ? JSON.parse(process.env.DOC_JSON) : null; // { fornecedor_id, vencimento, valor, documento }
  if (DOC) {
    r = await req('POST', '/api/despesas/verificar', { id_superlogica: COND_LEITURA, linhas: [
      { linha: 2, fornecedor_id: DOC.fornecedor_id, vencimento: DOC.vencimento, valor: DOC.valor, documento: DOC.documento },
      { linha: 3, fornecedor_id: DOC.fornecedor_id, vencimento: DOC.vencimento, valor: DOC.valor, documento: DOC.documento + '9' },
    ] });
    check('mesmo documento = duplicata (positivo)', (r.j.duplicadas || []).some((d) => d.linha === 2), JSON.stringify(r.j.duplicadas));
    check('os dois com documento e diferentes = não é duplicata', !(r.j.duplicadas || []).some((d) => d.linha === 3), JSON.stringify(r.j.duplicadas));
  }
  r = await req('POST', '/api/despesas/verificar', { id_superlogica: COND_TESTE, linhas: Array.from({ length: 32 }, (_, i) => ({ linha: i + 2, fornecedor_id: '6263', vencimento: '11/' + String((i % 30) + 1).padStart(2, '0') + '/2026', valor: 10 + i })).concat([{ linha: 99, fornecedor_id: '6263', vencimento: '12/31/2026', valor: 1 }, { linha: 100, fornecedor_id: '6263', vencimento: '12/30/2026', valor: 1 }]) });
  check('mais de 31 datas -> 400', r.s === 400, r.s + ' ' + JSON.stringify(r.j));
  // Alertas com dados reais
  r = await req('GET', '/api/condominio/' + COND_LEITURA + '/alertas');
  check('alertas 200 (leitura)', r.s === 200, JSON.stringify(r.j).slice(0, 200));
  const tipos = {}; (r.j.alertas || []).forEach((a) => { tipos[a.tipo] = (tipos[a.tipo] || 0) + 1; });
  console.log('    alertas por tipo:', JSON.stringify(tipos), 'falhas:', JSON.stringify(r.j.falhas));
  (r.j.alertas || []).filter((a) => a.tipo === 'recorrente_nao_lancada').forEach((a) => console.log('    recorrente:', a.titulo));
  const r2 = await req('GET', '/api/condominio/' + COND_LEITURA + '/alertas');
  check('segunda leitura devolve os MESMOS ids (chave estável)', JSON.stringify((r2.j.alertas || []).map((a) => a.id).sort()) === JSON.stringify((r.j.alertas || []).map((a) => a.id).sort()), 'ids mudaram');
  check('todo alerta tem id guardado', (r.j.alertas || []).every((a) => a.id), 'sem id');
}

// Saldo baixo no condomínio de teste (saldo 0): liga limite, aparece, marca visto, resolve, some.
r = await req('PUT', '/api/condominio/' + COND_TESTE + '/alertas/config', { saldo_minimo: 1000 });
check('config salva', r.s === 200 && r.j.saldo_minimo === 1000, JSON.stringify(r.j));
r = await req('GET', '/api/condominio/' + COND_TESTE + '/alertas');
const saldo = (r.j.alertas || []).find((a) => a.tipo === 'saldo_baixo');
check('alerta de saldo baixo aparece', !!saldo, JSON.stringify(r.j));
if (saldo) {
  let p = await req('PATCH', '/api/alertas/' + saldo.id, { status: 'visto' });
  check('marcar visto', p.s === 200 && p.j.status === 'visto', JSON.stringify(p.j));
  p = await req('PATCH', '/api/alertas/' + saldo.id, { status: 'resolvido' });
  check('marcar resolvido', p.s === 200, JSON.stringify(p.j));
  r = await req('GET', '/api/condominio/' + COND_TESTE + '/alertas');
  check('resolvido some da lista padrão', !(r.j.alertas || []).some((a) => a.id === saldo.id), JSON.stringify(r.j.alertas));
  r = await req('GET', '/api/condominio/' + COND_TESTE + '/alertas?todos=1');
  check('resolvido aparece com todos=1', (r.j.alertas || []).some((a) => a.id === saldo.id && a.status === 'resolvido'), JSON.stringify(r.j.alertas));
  p = await req('PATCH', '/api/alertas/' + saldo.id, { status: 'novo' });
  check('reabrir', p.s === 200, JSON.stringify(p.j));
}
r = await req('PUT', '/api/condominio/' + COND_TESTE + '/alertas/config', { saldo_minimo: null });
check('desligar limite', r.s === 200 && r.j.saldo_minimo === null, JSON.stringify(r.j));

console.log('\n===== RESULTADO: ' + ok + ' PASS, ' + fail + ' FAIL =====');
