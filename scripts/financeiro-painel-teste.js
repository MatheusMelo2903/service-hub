// T31: testes do financeiro/painel.js sem rede (cliente falso). Uso: node scripts/financeiro-painel-teste.js
'use strict';
const P = require('../financeiro/painel');
let ok = 0, falhas = 0;
function t(nome, cond) { if (cond) ok++; else { falhas++; console.log('FALHOU: ' + nome); } }

(async () => {
  // Permissão do módulo
  t('gestor sempre', P.temFinanceiro({ role: 'GESTOR', permissoes: {} }, 'pre_balancete'));
  t('sem perfil nega', !P.temFinanceiro(null, 'ver'));
  t('sem módulo nega', !P.temFinanceiro({ role: 'GERENTE', permissoes: {} }, 'ver'));
  t('invisível nega', !P.temFinanceiro({ role: 'GERENTE', permissoes: { financeiro: { visivel: false, acoes: ['ver'] } } }, 'ver'));
  t('ver libera ver', P.temFinanceiro({ role: 'OPERACIONAL', permissoes: { financeiro: { visivel: true, acoes: ['ver'] } } }, 'ver'));
  t('ver não libera pré', !P.temFinanceiro({ role: 'OPERACIONAL', permissoes: { financeiro: { visivel: true, acoes: ['ver'] } } }, 'pre_balancete'));
  t('acoes não lista nega', !P.temFinanceiro({ role: 'GERENTE', permissoes: { financeiro: { visivel: true, acoes: 'ver' } } }, 'ver'));

  // Competência e datas
  t('competência ok', P.competencia('2026-09').fim === '2026-09-30');
  t('competência fevereiro', P.competencia('2028-02').fim === '2028-02-29');
  t('competência inválida', !P.competencia('2026-13') && !P.competencia('09/2026') && !P.competencia('2026-9'));
  t('quinzenas', JSON.stringify(P.quinzenas('2026-08-01', '2026-09-20')) === JSON.stringify([['2026-08-01', '2026-08-15'], ['2026-08-16', '2026-08-31'], ['2026-09-01', '2026-09-15'], ['2026-09-16', '2026-09-20']]));
  t('dias úteis', JSON.stringify(P.ultimosDiasUteis('2026-10-21', 3)) === JSON.stringify(['2026-10-16', '2026-10-19', '2026-10-20']));
  t('meses atrás', P.inicioMesesAtras('2026-01-31', 2) === '2025-11-01');

  // Link só com números
  t('link ok', /\/despesas\/id\/123\?idCondominio=136$/.test(P.linkLancamento('123', '136')));
  t('link recusa texto', P.linkLancamento('1"><script>', '136') === '' && P.linkLancamento('1', '') === '');

  // Enxugar tira campos sensíveis
  const d = P.enxugarDespesa({ id_despesa_des: '1', st_pixchave_pdes: 'x', st_contabancaria_con: '9', arquivos: [{ st_nomeabreviadoetiqueta_eti: 'Comprovante', st_hash_arq: 'h' }] });
  t('sem pix e conta', !('st_pixchave_pdes' in d) && !('st_contabancaria_con' in d) && !('st_hash_arq' in d.arquivos[0]));
  const aud = P.enxugarAuditoria([{ st_texto_aud: 'Login efetuado' }, { st_texto_aud: 'Despesa#5 criada', st_sql_aud: '136' }]);
  t('auditoria só despesa', aud.length === 1 && aud[0].st_sql_aud === '136');

  // Janela quebra ao meio quando o corpo não é lista (estouro do Superlógica)
  const chamadas = [];
  const cliente = { get: async (a, p) => { chamadas.push(p.dtInicio + '-' + p.dtFim); if (p.dtInicio === p.dtFim) return [{ id: p.dtInicio }]; return null; } };
  const falhasJ = [];
  const r = await P.janela(cliente, P.criarFila(2), 'despesas/index', {}, '2026-09-01', '2026-09-04', falhasJ);
  t('janela quebrou até 1 dia', r.length === 4 && falhasJ.length === 0);
  const cli2 = { get: async () => { const e = new Error('x'); e.status = 500; throw e; } };
  const f2 = [];
  const r2 = await P.janela(cli2, P.criarFila(2), 'despesas/index', {}, '2026-09-01', '2026-09-02', f2);
  t('erro vira falha registrada', r2.length === 0 && f2.length === 1);

  // JSON que não é lista é falha e não quebra a janela; quebras têm teto
  let n3 = 0;
  const f3 = [];
  const r3 = await P.janela({ get: async () => { n3++; return { status: 500, msg: 'erro' }; } }, P.criarFila(2), 'despesas/index', {}, '2025-01-01', '2026-04-30', f3);
  t('json de erro não quebra', r3.length === 0 && n3 === 1 && f3.length === 1);
  let n4 = 0;
  const f4 = [];
  await P.janela({ get: async () => { n4++; return null; } }, P.criarFila(2), 'despesas/index', {}, '2025-01-01', '2026-04-30', f4);
  t('teto de quebras', n4 <= 85 && f4.length >= 1);

  // R2 sem dados do outro condomínio para quem tem carteira
  const r2a = P.semOutroCondominio({ regra: 'R2', detalhe: 'Outro: CONDOMINIO X despesa 9', relacionados: ['9'] });
  t('R2 restrito', !r2a.relacionados && !/CONDOMINIO X/.test(r2a.detalhe));
  const r5a = { regra: 'R5', detalhe: 'x' };
  t('outros intactos', P.semOutroCondominio(r5a) === r5a);

  // Atualizar não apaga a base de todos
  let calls = 0;
  const painel = P.criarPainel({ cliente: () => ({ get: async () => { calls++; return []; } }), hoje: () => '2026-10-21', log: () => {} });
  const b1 = await painel.obterBase(false);
  const antes = calls;
  const b2 = await painel.obterBase(true);
  t('forçar logo depois devolve a mesma base sem reler', b1 && b2 === b1 && calls === antes);

  // Fila respeita o limite
  let ativos = 0, pico = 0;
  const fila = P.criarFila(2);
  await Promise.all(Array.from({ length: 6 }, () => fila(async () => { ativos++; pico = Math.max(pico, ativos); await new Promise((ok) => setTimeout(ok, 10)); ativos--; })));
  t('no máximo 2 ao mesmo tempo', pico === 2);

  // Pré balancete
  const base = { id_condominio_cond: '136', st_fantasia_cond: 'Casablanca', id_contato_con: '9', st_nome_con: 'Fornecedor X', st_cpf_con: '11222333000144', apropriacao: [{ st_descricao_cont: 'Manutenção' }] };
  const desp = [
    Object.assign({}, base, { id_despesa_des: '10', id_parcela_pdes: '100', st_documento_des: 'NF 55', dt_geracao_des: '09/02/2026', dt_vencimento_pdes: '09/10/2026', dt_liquidacao_pdes: '09/10/2026', fl_liquidado_pdes: '1', vl_valor_pdes: '1500.00', id_forma_pag: '0', arquivos: [] }),
    Object.assign({}, base, { id_despesa_des: '11', id_parcela_pdes: '101', st_documento_des: 'NF 56', dt_geracao_des: '09/20/2026', dt_vencimento_pdes: '09/12/2026', dt_liquidacao_pdes: '', fl_liquidado_pdes: '0', vl_valor_pdes: '300.00', id_forma_pag: '0', arquivos: [] }),
    Object.assign({}, base, { id_despesa_des: '12', id_parcela_pdes: '102', st_documento_des: 'NF 57', dt_geracao_des: '09/01/2026', dt_vencimento_pdes: '09/15/2026', dt_liquidacao_pdes: '09/15/2026', fl_liquidado_pdes: '1', vl_valor_pdes: '80.00', id_forma_pag: '0',
      arquivos: [{ st_nomeabreviadoetiqueta_eti: 'Comprovante', dt_envio_arq: '09/15/2026' }, { st_nomeabreviadoetiqueta_eti: 'Doc. Fiscal', dt_envio_arq: '09/15/2026' }] }),
  ];
  const linhas = [{ id_auditoria_aud: '1', dt_data_aud: '09/18/2026 10:00:00', id_usuario_usu: '50', st_apelido_usu: 'Analista A', st_texto_aud: 'Parcela#102 da despesa#12 alterada. Valor: de R$ 80,00 para R$ 800,00', st_sql_aud: '136', st_fantasia_cond: 'Casablanca' }];
  const pre = P.montarPreBalancete(P.competencia('2026-09'), '2026-10-21', desp.map(P.enxugarDespesa), P.enxugarAuditoria(linhas), '136');
  const g = Object.fromEntries(pre.grupos.map((x) => [x.chave, x]));
  t('pré sem comprovante', g.sem_comprovante.quantidade === 1 && g.sem_comprovante.itens[0].id_despesa === '10');
  t('pré sem nota', g.sem_nota.quantidade === 1);
  t('pré vencida', g.vencida.quantidade === 1 && g.vencida.itens[0].id_despesa === '11');
  t('pré lançamento tardio', g.lancamento_tardio.quantidade === 1 && g.lancamento_tardio.itens[0].id_despesa === '11');
  t('pré mexida', g.mexida.quantidade === 1 && g.mexida.itens[0].gravidade === 'alta');
  t('pré não fecha', pre.pode_fechar === false && pre.pendencias >= 4);
  t('pré pagas do mês', pre.parcelas_pagas === 2 && pre.valor_pago === 1580);
  t('pré link', /despesas\/id\/10\?idCondominio=136$/.test(g.sem_comprovante.itens[0].link));
  t('pré referência fim do mês', pre.referencia === '2026-10-01');
  const pre2 = P.montarPreBalancete(P.competencia('2026-09'), '2026-10-21', [P.enxugarDespesa(desp[2])], [], '136');
  t('pré limpo fecha', pre2.pode_fechar === true && pre2.pendencias === 0);

  // Resumo ordena pela gravidade e tira empresas e o condomínio de teste
  const b = { condominios: new Map([['1', { nome: 'A' }], ['2', { nome: 'B' }], ['143', { nome: 'Empresa' }], ['167', { nome: 'Teste' }]]),
    porCondominio: new Map([['1', [{ tipo: 'R5_SEM_NOTA', gravidade: 'media', valor: 10 }]], ['2', [{ tipo: 'R1_DOCUMENTO', gravidade: 'alta', valor: 99 }]], ['143', [{ tipo: 'R5_SEM_NOTA', gravidade: 'alta' }]]]),
    analistas: new Map([['2', 'Fulana']]) };
  const res = P.resumoDe(b, null);
  t('resumo ordem', res.length === 2 && res[0].id_condominio === '2' && res[0].valor_alta === 99 && res[0].analista === 'Fulana');
  t('resumo filtra ids', P.resumoDe(b, new Set(['1'])).length === 1);
  t('resumo escopo vazio', P.resumoDe(b, new Set()).length === 0);

  console.log(ok + ' ok, ' + falhas + ' falha(s)');
  process.exit(falhas ? 1 : 0);
})();
