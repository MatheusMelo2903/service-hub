// Testes dos Boletos do mês (financeiro/boletos-mes.js e boletos-mes-rotas.js) com o Superlógica e o
// banco dublados. Nada sai para fora. Uso: NODE_PATH=... node scripts/teste-boletos-mes.js
'use strict';
process.env.NODE_ENV = 'test';
const http = require('http');
const express = require('express');
const M = require('../financeiro/boletos-mes');
const { registrar } = require('../financeiro/boletos-mes-rotas');
const { criarPoliticaEscrita } = require('../servico/escrita-superlogica');

let ok = 0, falha = 0;
const t = (nome, cond) => { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } };

// ── 1. calendário ──
t('próximo vencimento no mês', M.proximoVencimento(25, '2026-10-23').vencimento === '2026-10-25');
t('próximo vencimento no mês seguinte', M.proximoVencimento(10, '2026-10-23').vencimento === '2026-11-10');
t('dia 31 em fevereiro', M.vencimentoEm(M.competencia('2027-02'), 31) === '2027-02-28');
const c10 = { id: '2', nome: 'Bosque', dia: 10 };
let s = M.situacaoCalendario(c10, '2026-11-10', { gerado: false }, '2026-10-23');
t('no prazo', s.estado === 'no_prazo' && s.limite === '2026-10-31' && s.faltam === 8 && !/[–—]/.test(s.texto));
s = M.situacaoCalendario(c10, '2026-11-10', { gerado: false }, '2026-10-29');
t('perto do limite', s.estado === 'perto' && s.faltam === 2);
s = M.situacaoCalendario(c10, '2026-11-10', { gerado: false }, '2026-11-02');
t('atrasado', s.estado === 'atrasado' && s.atraso === 2 && s.gravidade === 'alta');
s = M.situacaoCalendario(c10, '2026-11-10', { gerado: false }, '2026-11-05');
t('atrasado e não chega 7 dias antes', s.estado === 'atrasado' && /7 dias antes/.test(s.texto));
s = M.situacaoCalendario(c10, '2026-11-10', { gerado: true, gerado_em: '2026-11-04' }, '2026-11-05');
t('gerado tarde', s.estado === 'gerado_tarde' && s.antecedencia === 6);
s = M.situacaoCalendario(c10, '2026-11-10', { gerado: true, gerado_em: '2026-11-01' }, '2026-11-05');
t('gerado em cima', s.estado === 'gerado_em_cima');
s = M.situacaoCalendario(c10, '2026-11-10', { gerado: true, gerado_em: '2026-10-25' }, '2026-11-05');
t('gerado no prazo', s.estado === 'gerado' && s.gravidade === 'ok');
t('sem lote mensal', M.situacaoCalendario(c10, '2026-11-10', { gerado: false, anterior: false }, '2026-10-23').estado === 'sem_lote_mensal');
t('sem dia', M.situacaoCalendario({ id: '3', dia: null }, '', null, '2026-10-23').estado === 'sem_dia');
t('lote pelo id negativo', M.resumirLote([{ id_lote_recb: '-202611', dt_geracao_recb: '10/25/2026 10:00:00' }, { id_lote_recb: '0' }]).gerado_em === '2026-10-25');
t('sem lote', M.resumirLote([{ id_lote_recb: '0' }]).gerado === false);
const cal = M.montarCalendario([c10, { id: '4', nome: 'Atrasado', dia: 1 }, { id: '5', nome: 'Gerado', dia: 25 }],
  new Map([['2', { gerado: false }], ['4', { gerado: false }], ['5', { gerado: true, gerado_em: '2026-10-10', boletos_lidos: 50 }]]), '2026-10-23');
t('calendário ordena urgência', cal.linhas[0].id_condominio === '4' && cal.resumo.gerados === 1 && cal.resumo.no_prazo === 1);
t('condomínio sem dia no cadastro', M.enxugarCondominio({ id_condominio_cond: '9', st_fantasia_cond: 'X', dt_diavencimento_cond: '0' }).dia === null);

// ── 2. composição ──
const contas = [{ id: '823', descricao: 'Conta Principal' }];
t('item sem conta bancária', !!M.validarItem({ tipo: 'taxa_extra', complemento: 'Obra', valor: '10', meses: 1, id_conta: '999' }, contas).erro);
t('item com < >', !!M.validarItem({ tipo: 'taxa_extra', complemento: '<b>x</b>', valor: '10', meses: 1, id_conta: '823' }, contas).erro);
t('conta de despesa recusada', !!M.validarItem({ tipo: 'taxa_extra', conta: '2.1', complemento: 'Obra', valor: '10', meses: 1, id_conta: '823' }, contas).erro);
t('unidade obrigatória', !!M.validarItem({ tipo: 'item_unidade', complemento: 'TAG', valor: '15', meses: 1, id_conta: '823' }, contas).erro);
const v1 = M.validarItem({ tipo: 'taxa_extra', complemento: 'Pintura', valor: '1.234,50', meses: 1, id_conta: '823' }, contas).item;
t('valor em reais', v1.valor === 1234.5 && v1.conta === '1.9');
const nov = M.competencia('2026-11');
let corpo = M.corpoComposicao('167', nov, v1);
t('só o mês: FL 1 e DT_FIM explícito', corpo.FL_QUANDO_ARRECADAR === 1 && corpo.DT_INICIO_COT === '11/01/2026' && corpo.DT_FIM_COT === '11/30/2026' && corpo.VL_VALOR_COT === '1234.50' && corpo.FL_QUEM_SERA_COBRADO === 2);
const v3 = M.validarItem({ tipo: 'item_unidade', complemento: 'TAG veículo', valor: '30', meses: 3, id_conta: '823', id_unidade: '41565', boleto: 'extra' }, contas).item;
corpo = M.corpoComposicao('167', nov, v3);
t('parcelas: FL 2, fim 3 meses depois, unidade', corpo.FL_QUANDO_ARRECADAR === 2 && corpo.DT_FIM_COT === '01/31/2027' && corpo.ID_UNIDADE_UNI === '41565' && corpo.FL_QUEM_SERA_COBRADO === 0 && corpo.FL_TIPOCOB_COT === 2 && corpo.FL_EXIBIRPARCELA_COT === 1);
t('descrição sem traço', !/[–—]/.test(M.descreverItem(v3, nov)) && /3 parcelas/.test(M.descreverItem(v3, nov)));
const atuais = [M.normalizarComposicao({ id_composicao_cot: '20819', st_conta_cont: '1.9', st_descricao_cont: ' Taxa Extra', st_complemento_cot: 'PINTURA', vl_valor_cot: '3.000', dt_inicio_cot: '11/01/2026 00:00:00', dt_fim_cot: '11/30/2026 00:00:00', fl_tipocob_cot: '1' })];
let av = M.conferirItensNovos([v1, Object.assign({}, v1)], atuais);
t('duplicado com a composição e na lista', av.filter((a) => a.tipo === 'item_duplicado').length === 3);
t('normalizar composição', atuais[0].inicio === '2026-11-01' && atuais[0].tipo === 'extra' && atuais[0].quem === 'todas');
t('corpoOk erro de regra', M.corpoOk({ status: 206, json: [{ status: '500', msg: 'Composição #1 não encontrada.' }] }).ok === false);

// ── 3. conferência antes ──
const tab = M.lerTabela074A([{ tipo: 'tabela', colunas: ['Unidade/Bloco', 'Vencimento', 'Total'], linhas: [['101 / A', '10/11/2026', '1.500,00'], ['102 / A', '10/11/2026', '300,00'], ['105 / A', '10/11/2026', '300,00']], totais: [['3 cobranças', '2.100,00']] }]);
t('074A em json', tab.linhas.length === 3 && tab.linhas[0].total === 1500 && tab.linhas[0].vencimento === '2026-11-10');
t('chave da unidade', M.chaveUnidade('A 101') === M.chaveUnidade('101 / A') && M.chaveUnidade('Bloco A apto 0101') === M.chaveUnidade('101-A'));
const B = require('../financeiro/boletos');
let seqId = 1;
const cob = (u, venc, valor, itens) => B.normalizar({ id_recebimento_recb: String(seqId++), id_unidade_uni: u, st_bloco_uni: 'A', st_unidade_uni: u, dt_vencimento_recb: venc + ' 00:00:00', fl_status_recb: '3', vl_emitido_recb: String(valor),
  receita_apropriacao: (itens || [['1.1', 'Taxa de Condomínio', valor]]).map(([c, d, v]) => ({ st_conta_cont: c, st_descricao_cont: d, vl_valor_reca: String(v) })) });
const hist = ['10', '09', '08'].map((m) => ({ competencia: '2026-' + m, cobrancas: ['101', '102', '103'].map((u) => cob(u, m + '/10/2026', 300)) }));
const comps = [atuais[0], Object.assign({}, atuais[0], { id: '20820' }),
  M.normalizarComposicao({ id_composicao_cot: '7', st_conta_cont: '1.131', st_descricao_cont: 'Fundo de Obras', st_complemento_cot: 'Parc. 25/24', vl_valor_cot: '50', dt_inicio_cot: '01/01/2025 00:00:00' })];
const leit = { agua: [{ unidade: '101', bloco: 'A', anterior: 100, atual: 110 }, { unidade: '102', bloco: 'A', anterior: 50, atual: 50 }, { unidade: '103', bloco: 'A', anterior: 30, atual: null }], gas: null };
let r = M.conferirAntes({ comp: nov, hoje: '2026-10-23', vencimento: '2026-11-10', simulacao: tab, composicoes: comps, historico: hist, leituras: leit });
const tipos = (x) => x.alertas.map((a) => a.tipo);
t('valor muito maior que a média', tipos(r).includes('valor_fora_padrao') && r.alertas.find((a) => a.tipo === 'valor_fora_padrao').unidade === '101 / A');
t('unidade sem boleto', r.alertas.some((a) => a.tipo === 'sem_boleto' && /103/.test(a.unidade)));
t('unidade nova', r.alertas.some((a) => a.tipo === 'unidade_nova' && /105/.test(a.unidade)));
t('leitura faltando e zerada', tipos(r).includes('leitura_faltando') && tipos(r).includes('leitura_zerada'));
t('consumo fora da composição', tipos(r).includes('consumo_fora'));
t('item duplicado', tipos(r).includes('item_duplicado'));
t('parcela além do total', r.alertas.some((a) => a.tipo === 'extra_fora_periodo' && /25\/24/.test(a.texto)));
t('não pode gerar com grave', r.pode_gerar === false && r.conferir.length >= 4 && r.conferir.every((x) => !/[–—]/.test(x)));
r = M.conferirAntes({ comp: nov, hoje: '2026-11-05', vencimento: '2026-11-10', simulacao: { linhas: [] }, composicoes: [], historico: hist, leituras: {} });
t('simulação vazia e prazo', tipos(r).includes('simulacao_vazia') && tipos(r).includes('prazo') && !r.pode_gerar);
const limpo = M.conferirAntes({ comp: nov, hoje: '2026-10-20', vencimento: '2026-11-10', historico: hist, leituras: {}, composicoes: [],
  simulacao: { linhas: ['101', '102', '103'].map((u) => ({ unidade: 'A ' + u, total: 310 })) } });
t('tudo certo pode gerar', limpo.pode_gerar === true && limpo.alertas.length === 0);
const semFim = M.conferirAntes({ comp: nov, hoje: '2026-10-20', vencimento: '2026-11-10', historico: [], leituras: {}, simulacao: { linhas: [{ unidade: 'A 101', total: 1 }] },
  composicoes: [M.normalizarComposicao({ id_composicao_cot: '8', st_conta_cont: '1.9', st_descricao_cont: 'Taxa Extra', vl_valor_cot: '5', dt_inicio_cot: '10/01/2026 00:00:00' })] });
t('taxa extra sem fim', tipos(semFim).includes('extra_sem_fim'));

// ── 4. remessa ──
t('pendentes por conta', JSON.stringify(M.lerPendentesRemessa([[{ id_contabanco_cb: '823', st_descricao_cb: 'Conta', quantidade: '12' }]])) === JSON.stringify([{ id_conta: '823', conta: 'Conta', quantidade: 12 }]));
t('pendentes vazio', M.lerPendentesRemessa([[]]).length === 0);
const cnab = ['0'.repeat(240), '3'.repeat(240), '9'.repeat(240)].join('\r\n');
t('arquivo CNAB cru', M.lerRespostaRemessa({ status: 200, json: null, texto: cnab }).formato === 'CNAB 240');
t('nada a gerar', M.lerRespostaRemessa({ status: 206, json: [{ status: '500', msg: 'Não há remessas para serem geradas.' }] }).nada === true);
t('link do Superlógica', M.lerRespostaRemessa({ status: 200, json: [{ status: '200', msg: 'ok', data: { link: 'https://condominioes.superlogica.net/clients/x.rem' } }] }).link === 'https://condominioes.superlogica.net/clients/x.rem');
t('link de fora ignorado', !M.lerRespostaRemessa({ status: 200, json: [{ status: '200', data: { link: 'https://mal.com/x' } }] }).link);

// ── 5. régua ──
const REGUA_167 = { fl_primeiranotificacao_email: '1', nm_diasprimeiranotificacao_email: '-5', fl_segundanotificacao_email: '1', nm_diassegundanotificacao_email: '0',
  fl_terceiranotificacao_email: '1', nm_diasterceiranotificacao_email: '5', fl_quartanotificacao_email: '0', nm_diasquartanotificacao_email: '20',
  fl_primeiranotificacao_sms: '0', nm_diasprimeiranotificacao_sms: '0', fl_segundanotificacao_sms: '0', nm_diassegundanotificacao_sms: '5',
  implantacao_pendente: '1', fl_status_implantacao: '0', st_token_empresa: 'SEGREDO123', dkim_chave: 'SEGREDO456', remetente_cobrancas: 'x@y' };
const padraoAuto = M.corpoReguaPadrao('167', REGUA_167, true);
t('padrão com retorno automático', padraoAuto.NM_DIASPRIMEIRANOTIFICACAO_EMAIL === 7 && padraoAuto.PERIODOPRIMEIRANOTEMAIL === -1 && padraoAuto.FL_TERCEIRANOTIFICACAO_EMAIL === 1 && padraoAuto.NM_DIASTERCEIRANOTIFICACAO_EMAIL === 3);
const padraoMao = M.corpoReguaPadrao('167', REGUA_167, false);
t('padrão sem retorno automático: sem aviso de atraso', padraoMao.FL_TERCEIRANOTIFICACAO_EMAIL === 0 && padraoMao.FL_QUARTANOTIFICACAO_EMAIL === 0);
t('esperado depois', M.esperadoRegua(padraoAuto).nm_diasprimeiranotificacao_email === '-7');
t('regravar como estava', JSON.stringify(M.esperadoRegua(M.corpoReguaDe('167', REGUA_167))) === JSON.stringify({ fl_primeiranotificacao_email: '1', nm_diasprimeiranotificacao_email: '-5', fl_segundanotificacao_email: '1', nm_diassegundanotificacao_email: '0', fl_terceiranotificacao_email: '1', nm_diasterceiranotificacao_email: '5', fl_quartanotificacao_email: '0', nm_diasquartanotificacao_email: '20' }));
const desc = M.descreverRegua(REGUA_167);
t('selo Desativada com a causa', desc.desativada && /implantacao_pendente/.test(desc.causa) && desc.envios[0].quando === '5 dias antes do vencimento');
t('mudanças para o padrão', M.diffRegua(REGUA_167, padraoAuto).length === 2);
t('retorno automático', M.retornoAutomatico(Array.from({ length: 10 }, (x, i) => ({ fl_status_recb: '3', st_arqret_recb: i < 9 ? '' : 'CB01.RET' }))).ativo === true);
t('retorno à mão', M.retornoAutomatico(Array.from({ length: 10 }, () => ({ fl_status_recb: '3', st_arqret_recb: 'CB.RET' }))).ativo === false);
t('retorno desconhecido', M.retornoAutomatico([{ fl_status_recb: '3' }]).conhecido === false);
const txtMao = M.retornoAutomatico(Array.from({ length: 194 }, (x, i) => ({ fl_status_recb: '3', st_arqret_recb: i < 183 ? 'CB.RET' : '' }))).texto;
t('texto do retorno à mão diz o que significa', /^Baixa por arquivo de retorno: 183 de 194 pagamentos/.test(txtMao) && /não é automático neste condomínio/.test(txtMao) && !/[–—-]/.test(txtMao));

// ── 6. trocas da forma de recebimento ──
const linhasAud = [
  { dt_data_aud: '09/15/2026 17:50:03', st_sql_aud: '173', st_apelido_usu: 'Graziela', st_texto_aud: 'Forma de recebimento #316 Boleto via Conta Principal alterada de Ativo (contingência) para Ativo. (PJBank)' },
  { dt_data_aud: '09/15/2026 17:50:00', st_sql_aud: '173', st_apelido_usu: 'Graziela', st_texto_aud: 'Forma de recebimento #316 Boleto via Conta Principal definida como forma principal.' },
  { dt_data_aud: '09/15/2026 17:49:57', st_sql_aud: '173', st_apelido_usu: 'Graziela', st_texto_aud: "Forma de recebimento #316 alterada. AMBIENTE DE PRODUÇÃO de 'Desativado', DATA DE ALTERAÇÃO de '09/15/2026 11:58:42';" },
  { dt_data_aud: '08/25/2026 15:31:07', st_sql_aud: '173', st_apelido_usu: 'Andressa', st_texto_aud: 'Forma de recebimento #46 alterada para Desativado.' },
  { dt_data_aud: '10/22/2026 14:51:31', st_sql_aud: '173', st_apelido_usu: 'Diana', st_texto_aud: 'Forma de recebimento #46 Boleto via Conta Principal alterada de Desativado para Ativo (contingência)' },
];
const evs = linhasAud.map(M.eventoForma).filter(Boolean);
t('eventos lidos (detalhe fora)', evs.length === 4 && evs[0].pjbank === true && evs[0].de === 'Ativo (contingência)' && evs[0].para === 'Ativo' && evs[2].para === 'Desativado');
const rt = M.resumoTrocas(evs, '2026-08-24', '2026-10-23');
t('troca todo mês', rt.todo_mes === true && rt.meses_com_troca.length === 3 && rt.ultima.quem === 'Diana' && /todo mês/.test(rt.texto));

// ── 7. rotas com Superlógica, banco e política dublados ──
const chamadas = [];
const banco = { linhas: [], upsert: async (tab, ls) => { ls.forEach((l) => { const i = banco.linhas.findIndex((x) => x.id_composicao === l.id_composicao); if (i >= 0) banco.linhas[i] = l; else banco.linhas.push(l); }); return ls.length; },
  inserir: async () => true, ler: async (c) => (c.startsWith('fin_boletos_itens') ? banco.linhas.filter((l) => c.includes('id_superlogica=eq.' + l.id_superlogica) && (!/id_composicao=eq\./.test(c) || c.includes('id_composicao=eq.' + l.id_composicao))) : []) };
let composicoesSL = [];
let reguaSL = Object.assign({}, REGUA_167);
const respostas = {
  'condominios/get': () => [{ id_condominio_cond: '167', st_fantasia_cond: 'Residencial Teste', dt_diavencimento_cond: '10', fl_status_implantacao: '0' }, { id_condominio_cond: '2', st_fantasia_cond: 'Residencial Bosque', dt_diavencimento_cond: '5' }, { id_condominio_cond: '143', st_fantasia_cond: 'Admin' }],
  'cobranca/index': (p) => (p.apenasColunasPrincipais ? (String(p.idCondominio) === '2' ? [{ id_lote_recb: '-202611', dt_geracao_recb: '10/20/2026 10:00:00', fl_status_recb: '3', st_arqret_recb: '' }] : []) : []),
  'arrecadacoes/index': () => composicoesSL.map((x) => Object.assign({}, x)),
  'contabancos/index': (p) => (String(p.idCondominio) === '167' ? [{ id_contabanco_cb: '823', id_condominio_cond: '167', st_descricao_cb: 'Conta Principal', st_token_cb: 'SEGREDO' }] : [{ id_contabanco_cb: '900', id_condominio_cond: '2', st_descricao_cb: 'Sicoob' }]),
  'relatorios/id/074A': () => [{ tipo: 'tabela', colunas: ['Unidade/Bloco', 'Vencimento', 'Total'], linhas: [['999 / TESTE HUB', '10/11/2026', '13,00']], totais: [] }],
  'notificacaoautomatica/index': () => [Object.assign({}, reguaSL)],
  'remessa/pendente': () => [[{ id_contabanco_cb: '823', quantidade: '3' }]],
  'consumo/index': () => [],
  'unidades/index': (p) => (String(p.idCondominio) === '167' ? [{ id_unidade_uni: '41565', id_condominio_cond: '167', st_unidade_uni: '999', st_bloco_uni: 'TESTE HUB' }] : []),
  'auditoria/index': () => linhasAud.map((l) => Object.assign({}, l, { st_sql_aud: '167' })).concat([{ st_sql_aud: '-1', st_texto_aud: 'Forma de recebimento #9 alterada para Ativo.', dt_data_aud: '10/01/2026 10:00:00' }]),
};
const cliente = { get: async (a, p) => { chamadas.push(['GET', a]); const f = respostas[a]; if (!f) throw Object.assign(new Error('sem_rota ' + a), { status: 404 }); return f(p || {}); } };
let proxId = 30000;
const enviar = async (metodo, caminho, query, corpo) => {
  chamadas.push([metodo, caminho, Object.assign({}, query, corpo)]);
  if (caminho === 'arrecadacoes/put') {
    const id = String(proxId++);
    composicoesSL.push({ id_composicao_cot: id, id_condominio_cond: corpo.ID_CONDOMINIO_COND, st_conta_cont: corpo.ST_CONTA_CONT, st_descricao_cont: 'Taxa Extra', st_complemento_cot: corpo.ST_COMPLEMENTO_COT, vl_valor_cot: corpo.VL_VALOR_COT, dt_inicio_cot: corpo.DT_INICIO_COT, dt_fim_cot: corpo.DT_FIM_COT, id_unidade_uni: corpo.ID_UNIDADE_UNI || '' });
    return { status: 200, json: [{ status: '200', msg: 'Sucesso.', data: { id_composicao_cot: id } }] };
  }
  if (caminho === 'arrecadacoes/post') { composicoesSL = composicoesSL.filter((x) => x.id_composicao_cot !== String(corpo.ID_COMPOSICAO_COT)); return { status: 200, json: [{ status: '200', msg: 'Sucesso.' }] }; }
  if (caminho === 'notificacaoautomatica/putnotificacaoemail') { Object.assign(reguaSL, M.esperadoRegua(corpo)); return { status: 200, json: [{ status: '200', msg: 'Sucesso' }] }; }
  if (caminho === 'remessa/gerar') return { status: 200, json: null, texto: cnab };
  return { status: 404, json: null };
};
const env = { ESCRITA_SUPERLOGICA: 'teste' };
const auditoria = [];
const politica = criarPoliticaEscrita({ env: () => env, auditar: (req, acao, det) => auditoria.push([acao, det]), condominioDaBase: async (id) => (id === '2' ? { nome: 'Residencial Bosque' } : null) });
let perfil = { role: 'GERENTE', email: 'g@x' };
const app = express();
const sim = async () => true;
registrar({ app, express, requireAuth: (req, res, next) => { req.user = { sub: 'u1' }; next(); }, exigirFinanceiro: sim, exigirModuloItem: sim, exigirLeituraSuperlogica: sim, exigirCarteira: sim, exigirEscopo: sim,
  escopoFinanceiro: async () => null, lerPerfil: async () => perfil, clienteSL: () => cliente, cred: () => ({}), enviar, politica, banco, auditar: () => {}, hoje: () => '2026-10-23', log: () => {} });

const srv = http.createServer(app);
function pedir(metodo, url, corpo) {
  return new Promise((ok) => {
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const r = http.request({ host: '127.0.0.1', port: srv.address().port, path: url, method: metodo, headers: dados ? { 'content-type': 'application/json', 'content-length': dados.length } : {} }, (resp) => {
      const p = []; resp.on('data', (c) => p.push(c)); resp.on('end', () => { const txt = Buffer.concat(p).toString(); let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; } ok({ status: resp.statusCode, j, txt }); });
    });
    if (dados) r.write(dados);
    r.end();
  });
}

srv.listen(0, async () => {
  try {
    const item = { tipo: 'taxa_extra', complemento: 'TESTE HUB BOL', valor: '2,00', meses: 2, id_conta: '823' };
    let x = await pedir('GET', '/api/financeiro/boletos-mes/calendario');
    t('calendário responde', x.status === 200 && x.j.linhas.length === 2 && !x.j.linhas.some((l) => l.id_condominio === '143'));
    t('calendário: teste sem lote mensal', x.j.linhas.find((l) => l.id_condominio === '167').estado === 'sem_lote_mensal');
    t('calendário: Bosque gerado', x.j.linhas.find((l) => l.id_condominio === '2').estado === 'gerado_em_cima' || x.j.linhas.find((l) => l.id_condominio === '2').estado === 'gerado');
    x = await pedir('GET', '/api/financeiro/boletos-mes/167/composicao?competencia=2026-11');
    t('composição sem chave da conta', x.status === 200 && x.j.contas.length === 1 && !/SEGREDO/.test(x.txt) && x.j.gravacao.liberada === true);
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/composicao/previa', { competencia: '2026-11', itens: [item] });
    t('prévia confere', x.status === 200 && x.j.pode_gravar === true && /2 parcelas/.test(x.j.itens[0].texto));
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/composicao/gravar', { competencia: '2026-11', itens: [item] });
    t('grava no 167 sem confirmação e confere', x.status === 200 && x.j.ok === true && x.j.resultados[0].conferido === true);
    const put = chamadas.find((c) => c[1] === 'arrecadacoes/put');
    t('put com DT_FIM explícito', put && put[2].FL_QUANDO_ARRECADAR === 2 && put[2].DT_FIM_COT === '12/31/2026' && put[2].ID_CONDOMINIO_COND === '167');
    t('registro do item no banco', banco.linhas.length === 1 && banco.linhas[0].status === 'gravado');
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/composicao/gravar', { competencia: '2026-11', itens: [item] });
    t('mesmo item de novo: duplicado trava', x.status === 409 && x.j.erro === 'conferencia_reprovada');
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/composicao/excluir', { competencia: '2026-11', id_composicao: '12345' });
    t('não exclui item que não é do Hub', x.status === 404);
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/composicao/excluir', { competencia: '2026-11', id_composicao: String(banco.linhas[0].id_composicao) });
    t('exclui item do Hub e confere', x.status === 200 && x.j.ok === true && composicoesSL.length === 0 && banco.linhas[0].status === 'excluido');
    const post = chamadas.find((c) => c[1] === 'arrecadacoes/post');
    t('exclusão com DT_FIM do item', post && post[2].FL_EXCLUIR_ARRECADACAO === 1 && post[2].DT_FIM_COT === '12/31/2026');

    // Fora do teste: modo teste bloqueia; modo confirmação pede confirmação reforçada.
    const antesEnv = chamadas.length;
    x = await pedir('POST', '/api/financeiro/boletos-mes/2/composicao/gravar', { competencia: '2026-11', itens: [Object.assign({}, item, { id_conta: '900' })] });
    t('fora do teste bloqueia (423)', x.status === 423 && !chamadas.slice(antesEnv).some((c) => c[0] !== 'GET'));
    env.ESCRITA_SUPERLOGICA = 'confirmacao';
    x = await pedir('POST', '/api/financeiro/boletos-mes/2/composicao/gravar', { competencia: '2026-11', itens: [Object.assign({}, item, { id_conta: '900' })] });
    t('confirmação reforçada pedida (428)', x.status === 428 && x.j.confirmacao.reforcada === true && x.j.confirmacao.nome_curto === 'Bosque' && !chamadas.slice(antesEnv).some((c) => c[0] !== 'GET'));
    const tok = x.j.confirmacao;
    x = await pedir('POST', '/api/financeiro/boletos-mes/2/composicao/gravar', { competencia: '2026-11', itens: [Object.assign({}, item, { id_conta: '900' })], confirmacao_gravacao: { token: tok.token, id_condominio: tok.id_condominio, nome_digitado: 'bosque' } });
    t('confirmado grava', x.status === 200 && x.j.ok === true);
    x = await pedir('POST', '/api/financeiro/boletos-mes/2/composicao/gravar', { competencia: '2026-11', itens: [Object.assign({}, item, { id_conta: '900', complemento: 'Outro' })], confirmacao_gravacao: { token: tok.token, id_condominio: tok.id_condominio, nome_digitado: 'bosque' } });
    t('token não serve de novo', x.status === 409 || x.status === 428);
    env.ESCRITA_SUPERLOGICA = 'teste';
    composicoesSL = [];

    x = await pedir('POST', '/api/financeiro/boletos-mes/167/composicao/previa', { competencia: '2026-11', itens: [{ tipo: 'item_unidade', complemento: 'TAG', valor: '15', meses: 1, id_conta: '823', id_unidade: '55555' }] });
    t('unidade de outro condomínio recusada', x.status === 400 && x.j.erro === 'unidade_de_outro_condominio');
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/composicao/previa', { competencia: '2026-11', itens: [{ tipo: 'item_unidade', complemento: 'TAG', valor: '15', meses: 1, id_conta: '823', id_unidade: '41565' }] });
    t('unidade do condomínio aceita', x.status === 200 && x.j.pode_gravar === true);
    perfil = { role: 'OPERACIONAL', email: 'o@x', permissoes: {} };
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/composicao/gravar', { competencia: '2026-11', itens: [item] });
    t('analista sem a ação não grava', x.status === 403);
    perfil = { role: 'OPERACIONAL', email: 'o@x', permissoes: { boletos: { visivel: true, acoes: ['ver', 'preparar'] } } };
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/composicao/previa', { competencia: '2026-11', itens: [item] });
    t('analista vê a prévia', x.status === 200);
    perfil = { role: 'GERENTE', email: 'g@x' };

    x = await pedir('GET', '/api/financeiro/boletos-mes/167/conferencia-antes?competencia=2026-11');
    t('conferência antes responde', x.status === 200 && x.j.resumo.unidades_simuladas === 1 && Array.isArray(x.j.conferir));

    x = await pedir('GET', '/api/financeiro/boletos-mes/167/regua');
    t('régua sem chaves sensíveis', x.status === 200 && !/SEGREDO|st_token|dkim|remetente/.test(x.txt) && x.j.atual.desativada === true && x.j.padrao.mudancas.length > 0);
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/regua/aplicar', {});
    const pr = chamadas.find((c) => c[1] === 'notificacaoautomatica/putnotificacaoemail');
    t('régua aplicada e conferida', x.status === 200 && x.j.ok === true && pr && pr[2].NM_DIASPRIMEIRANOTIFICACAO_EMAIL === 7 && reguaSL.nm_diasprimeiranotificacao_email === '-7');
    t('sem retorno automático, sem aviso de atraso', pr[2].FL_TERCEIRANOTIFICACAO_EMAIL === 0);
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/regua/aplicar', {});
    t('já no padrão não grava', x.status === 200 && x.j.sem_mudanca === true);

    x = await pedir('GET', '/api/financeiro/boletos-mes/167/remessa');
    t('remessa pendente', x.status === 200 && x.j.pendentes[0].quantidade === 3);
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/remessa/gerar', { id_conta: '900' });
    t('conta de outro condomínio recusada', x.status === 400 && !chamadas.some((c) => c[1] === 'remessa/gerar'));
    x = await pedir('POST', '/api/financeiro/boletos-mes/167/remessa/gerar', { id_conta: '823' });
    t('remessa gerada com o arquivo', x.status === 200 && x.j.arquivo === cnab && /^remessa_167_823_20261023\.rem$/.test(x.j.nome));

    x = await pedir('GET', '/api/financeiro/boletos-mes/167/pjbank');
    t('trocas do PJBank lidas (só do condomínio)', x.status === 200 && x.j.trocas > 0 && !x.j.eventos.some((e) => e.forma === '#9'));

    x = await pedir('GET', '/api/financeiro/boletos-mes/143/regua');
    t('cadastro que não é condomínio', x.status === 400);

    t('nunca chama arrecadacoes/processar', !chamadas.some((c) => /processar/.test(c[1])));
    t('auditoria registrou gravações', auditoria.some((a) => a[0] === 'gravacao_superlogica') && auditoria.some((a) => a[0] === 'gravacao_recusada'));
  } catch (e) { t('exceção: ' + e.stack, false); }
  srv.close();
  console.log(ok + ' ok, ' + falha + ' falha(s)');
  process.exit(falha ? 1 : 0);
});
