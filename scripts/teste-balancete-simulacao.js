'use strict';
// Testes da simulação só de leitura (financeiro/balancete-simulacao.js): trava de gravação e comparação
// do plano com o que a equipe colocou. Nenhuma chamada sai da máquina.
//   NODE_PATH=/home/claude/service-hub/node_modules node scripts/teste-balancete-simulacao.js
const https = require('https');
const S = require('../financeiro/balancete-simulacao');
const D = require('../financeiro/balancete-digital');
let falhas = 0, total = 0;
function t(nome, cond, extra) { total++; if (!cond) { falhas++; console.log('FALHOU: ' + nome + (extra ? ' ' + JSON.stringify(extra) : '')); } else console.log('ok: ' + nome); }

(async () => {
  // rotas de gravação recusadas
  ['comentarios/put', 'arquivos/put', 'condominios/fecharmes', 'impressoes/post', 'arquivos/adicionaretiqueta', 'despesas/delete', 'comentarios/putarquivos', 'relatorios/id/074A', 'despesas/post', '/v2/condor/arquivos/put']
    .forEach((r) => t('recusa ' + r, S.rotaDeGravacao(r)));
  ['comentarios/index', 'conciliacao/index', 'despesas/index', 'documentos/download', 'balancetes/index', 'caixa/index', 'impressoes/index', 'diagnosticos/index']
    .forEach((r) => t('aceita leitura ' + r, !S.rotaDeGravacao(r)));
  // trava de https: qualquer método que não seja GET ou rota de gravação aborta
  const original = https.request;
  let motivos = [];
  https.request = () => ({ on() {}, end() {}, setTimeout() {} });
  const desfazer = S.travarHttps((m) => motivos.push(m));
  const tenta = (op) => { try { https.request(op); return 'passou'; } catch (e) { return e.codigo; } };
  t('POST aborta', tenta({ method: 'POST', hostname: 'api.superlogica.net', path: '/v2/condor/comentarios/index' }) === 'so_leitura');
  t('PUT aborta', tenta({ method: 'PUT', hostname: 'api.superlogica.net', path: '/v2/condor/arquivos/adicionaretiqueta?idDocumento=1' }) === 'so_leitura');
  t('GET de rota de gravação aborta', tenta({ method: 'GET', hostname: 'api.superlogica.net', path: '/v2/condor/relatorios/id/900A?ID_CONDOMINIO_COND=80' }) === 'so_leitura');
  t('GET de leitura passa', tenta({ method: 'GET', hostname: 'api.superlogica.net', path: '/v2/condor/comentarios/index?ID_CONDOMINIO=80' }) === 'passou');
  t('avisa quem chamou', motivos.length === 3);
  desfazer(); https.request = original;
  // cliente só de leitura
  let tentou = null;
  const cli = S.clienteSoLeitura({ get: async () => [] }, (m) => { tentou = m; });
  t('cliente recusa rota de gravação', await cli.get('comentarios/put', {}).then(() => false, (e) => e.codigo === 'so_leitura') && /comentarios\/put/.test(tentou));
  t('cliente conta leituras', (await cli.get('comentarios/index', {}), cli.chamadas() === 1));

  // comparação do plano com o mês da equipe
  const com = (id, texto, etq) => ({ id_comentarioconteudo_comc: String(id), st_texto_comc: texto, fl_visibilidade_comc: '1', st_identificadororigem_como: '80_DIAGNOSTICO/202609', arquivos: etq ? [{ id_arquivo_arq: String(id + 100), st_nomeetiqueta_eti: '', etiquetas: [{ id_etiqueta_eti: String(etq) }] }] : [] });
  const plano = [['capa', 'Capa', 26], ['relatorio_11a', 'Relatorio 11A', 5], ['extrato_conta_corrente', 'Extrato conta corrente', 8], ['simulacao', 'Simulação', 9]]
    .map(([chave, titulo, etq], i) => ({ chave, titulo, conta: 'DIAGNOSTICO', etiqueta_id: etq, ordem: i + 1, fonte: D.classificarDocumento(titulo) }));
  const igual = S.comparar(plano, [com(1, 'Capa', 26), com(2, 'Relatorio 11A', 5), com(3, 'Extrato conta corrente', 8), com(4, 'Simulação', 9)]);
  t('tudo igual: 100%', igual.acerto === 100 && igual.exatos === 4 && igual.cobertura === 100, igual);
  const dif = S.comparar(plano, [com(1, 'Capa', 26), com(2, '11A', 5), com(3, 'Extrato conta corrente', 4), com(5, 'Garantidora', 4)]);
  t('título parecido casa (11A)', dif.casados === 3, dif);
  t('etiqueta diferente aparece', dif.com_diferenca.some((x) => /etiqueta/.test(x.diferencas.join())));
  t('o que faltou no plano', dif.faltou_no_plano.length === 1 && dif.faltou_no_plano[0].titulo === 'Garantidora');
  t('o que o plano tem a mais', dif.a_mais_no_plano.length === 1 && dif.a_mais_no_plano[0].titulo === 'Simulação');
  t('acerto conta só os iguais em tudo', dif.acerto === Math.round((2 / 5) * 100), dif.acerto);
  const ordem = S.comparar(plano, [com(1, 'Capa', 26), com(2, 'Relatorio 11A', 5), com(3, 'Simulação', 9), com(4, 'Extrato conta corrente', 8)]);
  t('ordem trocada aparece', ordem.com_diferenca.length === 2 && ordem.com_diferenca.every((x) => /ordem/.test(x.diferencas.join())));

  // simulação completa com o Superlógica dublado (só leitura): aprende dos meses anteriores
  const meses = { '202606': 1000, '202607': 2000, '202608': 3000, '202609': 4000 };
  const lidas = [];
  const dub = { async get(rota, q) {
    lidas.push(rota);
    if (rota === 'comentarios/index') {
      if (q.TIPO_OBJETO !== 'FERRAMENTA') return [{ status: '200', data: [] }];
      const ref = q.DT_REFERENCIA.slice(6) + q.DT_REFERENCIA.slice(0, 2);
      const b = meses[ref];
      if (!b) return [{ status: '200', data: [] }];
      return [{ status: '200', data: [com(b + 1, 'Capa', 26), com(b + 2, 'Relatorio 11A', 5), com(b + 3, 'Extrato conta corrente', 8), com(b + 4, 'Simulação', 9)].map((x) => Object.assign(x, { st_identificadororigem_como: '80_DIAGNOSTICO/' + ref })) }];
    }
    if (rota === 'arquivos/etiquetas') return [];
    return [];
  } };
  const r = await S.simular({ cliente: S.clienteSoLeitura(dub) }, '80', '2026-09');
  t('simulação aprende com os 3 meses anteriores', JSON.stringify(r.meses_aprendidos) === JSON.stringify(['2026-06', '2026-07', '2026-08']));
  t('simulação compara com o próprio mês: 100%', r.comparacao.acerto === 100, r.comparacao);
  t('relatório em português com o percentual', /Acerto: 100%/.test(S.relatorio(r, 'BURITIS')) && !/ - /.test(S.relatorio(r, 'BURITIS')));
  t('simulação só leu', lidas.every((x) => !S.rotaDeGravacao(x)));

  console.log('\n' + (total - falhas) + ' de ' + total + ' testes passaram');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
