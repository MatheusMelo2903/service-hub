// Harness T10: comunicados e multas. GRAVA no Superlógica SÓ no condomínio de teste 167.
// Rodar com servidor local e segredo injetado pelo railway run:
//   railway run --service service-hub --environment dev -- env BASE=http://localhost:3920 node scripts/comunicados-harness.mjs
// GRAVAR=1 faz as gravações reais no 167 (comunicado sem notificar, ocorrência, carta e cobrança).
const BASE = process.env.BASE || 'http://localhost:3920';
const H = { Authorization: 'Bearer ' + (process.env.INTERNAL_API_SECRET || ''), 'Content-Type': 'application/json' };
const TESTE = 167;
const OUTRO = Number(process.env.COND_OUTRO || 0); // condomínio real, só para ler uma unidade que NÃO é do 167
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '  -> ' + d); } };
const req = async (m, p, b, h) => { const r = await fetch(BASE + p, { method: m, headers: h || H, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };

let r = await req('POST', '/api/comunicados/publicar', { id_superlogica: TESTE, titulo: 't', texto: 'x', destinatario: 4, canal: 1, confirmacao: 'PUBLICAR' });
check('destinatário de todos os condomínios recusado', r.s === 400, r.s + JSON.stringify(r.j));
r = await req('POST', '/api/comunicados/publicar', { id_superlogica: TESTE, titulo: 't', texto: 'x', destinatario: 1, canal: 1 });
check('sem confirmação recusado', r.s === 400 && r.j.erro === 'sem_confirmacao', JSON.stringify(r.j));
r = await req('POST', '/api/comunicados/disparar', { confirmacao: 'DISPARAR' });
check('disparo global travado (423)', r.s === 423, r.s);
r = await req('POST', '/api/comunicados/publicar', { id_superlogica: TESTE }, { 'Content-Type': 'application/json' });
check('sem auth 401', r.s === 401, r.s);
r = await req('POST', '/api/multas/registrar', { id_superlogica: TESTE, id_unidade: 1, data: '10/20/2026', tipo: 3, titulo: 't', texto: 'x', notificar: 1 });
check('multa sem confirmação recusada', r.s === 400 && r.j.erro === 'sem_confirmacao', JSON.stringify(r.j));
r = await req('POST', '/api/multas/registrar', { id_superlogica: TESTE, id_unidade: 1, data: '20/10/2026', tipo: 3, titulo: 't', texto: 'x', notificar: 1, confirmacao: 'REGISTRAR' });
check('data em formato errado recusada', r.s === 400, JSON.stringify(r.j));

r = await req('POST', '/api/comunicados/publicar', { id_superlogica: TESTE, titulo: '<b>x</b>', texto: 'x', destinatario: 1, canal: 1, confirmacao: 'PUBLICAR' });
check('título com < > recusado', r.s === 400, JSON.stringify(r.j));
r = await req('POST', '/api/comunicados/publicar', { id_superlogica: TESTE, titulo: 'Aviso', texto: 'Dia [a confirmar].', destinatario: 1, canal: 1, confirmacao: 'PUBLICAR' });
check('[a confirmar] recusado no servidor', r.s === 400, JSON.stringify(r.j));
r = await req('POST', '/api/multas/registrar', { id_superlogica: TESTE, id_unidade: 1, data: '02/31/2026', tipo: 3, titulo: 't', texto: 'x', notificar: 1, confirmacao: 'REGISTRAR' });
check('data impossível 31/02 recusada', r.s === 400, JSON.stringify(r.j));
r = await req('POST', '/api/multas/registrar', { id_superlogica: TESTE, id_unidade: 1, data: '10/20/2026', tipo: 5, titulo: 't', texto: 'x', notificar: 1, confirmacao: 'REGISTRAR' });
check('tipo fora de 1 e 3 recusado', r.s === 400, JSON.stringify(r.j));
r = await req('POST', '/api/multas/registrar', { id_superlogica: TESTE, id_unidade: 1, data: '10/20/2026', tipo: 3, titulo: 't', texto: 'x', notificar: 1, cobranca: { valor: 10, vencimento: '12/10/2026', conta_categoria: '1.72', id_contabanco: 1 }, confirmacao: 'REGISTRAR' });
check('cobrança travada (423) antes de gravar', r.s === 423, r.s + JSON.stringify(r.j));
const op = await req('GET', '/api/condominio/' + TESTE + '/multa-opcoes');
check('opções do 167', op.s === 200 && Array.isArray(op.j.unidades), JSON.stringify(op.j).slice(0, 200));
console.log('    unidades 167:', (op.j.unidades || []).length, 'contas:', JSON.stringify(op.j.contas));
if (OUTRO) {
  const o2 = await req('GET', '/api/condominio/' + OUTRO + '/multa-opcoes');
  const alheia = (o2.j.unidades || [])[0];
  if (alheia) {
    r = await req('POST', '/api/multas/registrar', { id_superlogica: TESTE, id_unidade: alheia.id_unidade, data: '10/20/2026', tipo: 1, titulo: 'teste', texto: 'teste', notificar: 1, confirmacao: 'REGISTRAR' });
    check('unidade de outro condomínio recusada antes de gravar', r.s === 400 && r.j.erro === 'falha_unidade', JSON.stringify(r.j));
  }
}

r = await req('POST', '/api/comunicados/rascunho', { tipo: 'comunicado', assunto: 'Limpeza da caixa d água', detalhes: 'dia 10/11/2026 das 8h às 12h, sem água no período', condominio: 'Residencial Teste' });
check('rascunho gerado', r.s === 200 && r.j.titulo && r.j.texto, JSON.stringify(r.j).slice(0, 300));
check('rascunho sem hífen ou travessão', r.s === 200 && !/[–—]|\s-\s/.test(r.j.titulo + r.j.texto), r.j.texto);
console.log('    título:', r.j.titulo);

if (process.env.GRAVAR === '1') {
  r = await req('POST', '/api/comunicados/publicar', { id_superlogica: TESTE, titulo: 'TESTE HUB T10 ignorar', texto: 'Comunicado de teste do Service Hub.\n\nPode ignorar.', destinatario: 1, canal: 1, notificar: false, confirmacao: 'PUBLICAR' });
  check('comunicado publicado no 167 (sem notificar)', r.s === 200 && r.j.ok, JSON.stringify(r.j));
  r = await req('POST', '/api/comunicados/publicar', { id_superlogica: TESTE, titulo: 'TESTE HUB T10 ignorar', texto: 'Comunicado de teste do Service Hub.\n\nPode ignorar.', destinatario: 1, canal: 1, notificar: false, confirmacao: 'PUBLICAR' });
  check('mesmo comunicado de novo recusado (409)', r.s === 409, r.s);
  const uni = (op.j.unidades || [])[0];
  const conta = (op.j.contas || [])[0];
  if (uni && conta) {
    r = await req('POST', '/api/multas/registrar', { id_superlogica: TESTE, id_unidade: uni.id_unidade, data: '10/20/2026', tipo: 3, titulo: 'TESTE HUB T10 ignorar', texto: 'Ocorrência de teste do Service Hub.\n\nPode ignorar.', notificar: 1, email: false, carta: true,
      confirmacao: 'REGISTRAR' });
    console.log('    multa:', JSON.stringify(r.j));
    check('ocorrência registrada no 167', r.s === 200 && r.j.ocorrencia && r.j.ocorrencia.ok, JSON.stringify(r.j));
  } else console.log('    167 sem unidade ou conta para testar a multa');
}
console.log('\n===== RESULTADO: ' + ok + ' PASS, ' + fail + ' FAIL =====');
