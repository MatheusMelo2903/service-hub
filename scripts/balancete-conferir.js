// T41: conferência do 900A pela linha de comando (SÓ GET no Superlógica). Mesmo código da rota do Hub.
// Uso: cd service-hub && railway run --service service-hub --environment dev -- node scripts/balancete-conferir.js <idCondominio> <AAAA-MM> [idImpressao]
// Sem idImpressao: só lista os 900A do mês. Nunca imprime credenciais.
'use strict';
const B = require('../financeiro/balancete');
const { criarCliente } = require('../superlogica-dados');
const APP = process.env.SUPERLOGICA_APP_TOKEN, ACC = process.env.SUPERLOGICA_ACCESS_TOKEN;
if (!APP || !ACC) { console.log('credenciais ausentes'); process.exit(2); }
const base = (process.env.SUPERLOGICA_API_BASE || 'https://api.superlogica.net').replace(/\/+$/, '');
const [idCond, comp, idImp] = process.argv.slice(2);
if (!/^\d+$/.test(idCond || '') || !B.competencia(comp) || B.EXCLUIDOS.has(idCond)) { console.log('uso: <idCondominio> <AAAA-MM> [idImpressao]'); process.exit(2); }
const cred = { base, appToken: APP, accessToken: ACC };
const cliente = criarCliente(cred);
(async () => {
  const lista = await B.listarImpressoes(cliente, idCond, comp);
  console.log('900A do mês ' + comp + ': ' + JSON.stringify(lista, null, 1));
  if (!idImp) return;
  const t0 = Date.now();
  B.iniciarConferencia({ cred, cliente, idCondominio: idCond, competencia: comp, idImpressao: idImp, log: console.log });
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 5000));
    const s = B.situacaoConferencia(idImp);
    if (s.estado === 'rodando') continue;
    console.log('estado ' + s.estado + ' em ' + Math.round((Date.now() - t0) / 1000) + ' s');
    console.log(JSON.stringify(s.resultado || { erro: s.erro }, null, 1));
    break;
  }
})().catch((e) => { console.log('falhou: ' + (e && e.message)); process.exit(1); });
