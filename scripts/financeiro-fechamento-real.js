'use strict';
// T38: teste real do Fechamento do mês, só GET no Superlógica, com os mesmos módulos das rotas.
// Uso (variáveis do dev pelo railway run, nunca impressas):
//   railway run --service service-hub --environment dev -- node scripts/financeiro-fechamento-real.js \
//     --saida /pasta/fora/do/git --condominios 136,94,114,21,137 --competencia 2026-09 [--interna 120]
// Um condomínio de cada vez. Leitura interna de escaneado com teto (--interna, padrão 120).
const fs = require('fs');
const path = require('path');
const slModulo = require('../superlogica');
const finPainel = require('../financeiro/painel');
const finConc = require('../financeiro/conciliacao');
const finBoletos = require('../financeiro/boletos');
const anexosConf = require('../financeiro/anexos-conferencia');
const fechamento = require('../financeiro/fechamento');
const { criarBanco } = require('../financeiro/banco');
const processar = require('../servico/processar');

const arg = (n, p) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : p; };
const SAIDA = arg('saida');
const IDS = String(arg('condominios', '')).split(',').filter((x) => /^\d+$/.test(x) && !anexosConf.NAO_CONDOMINIOS.has(x));
const COMP = arg('competencia', '2026-09');
const TETO_INTERNA = Number(arg('interna', '120'));
if (!SAIDA || !IDS.length) { console.error('faltam --saida e --condominios'); process.exit(2); }
fs.mkdirSync(SAIDA, { recursive: true });
const cred = { base: (process.env.SUPERLOGICA_API_BASE || 'https://api.superlogica.net').replace(/\/+$/, ''), appToken: process.env.SUPERLOGICA_APP_TOKEN || '', accessToken: process.env.SUPERLOGICA_ACCESS_TOKEN || '' };
if (!cred.appToken || !cred.accessToken) { console.error('chaves do Superlógica ausentes'); process.exit(2); }
const cliente = () => slModulo.cliente(cred);
const log = (...a) => console.log(new Date(Date.now() - 3 * 3600000).toISOString().slice(11, 19), ...a);
let banco = null;
try { banco = criarBanco({ url: process.env.SUPABASE_URL, chave: process.env.SUPABASE_SERVICE_ROLE_KEY }); log('cache no banco de teste: ligado'); } catch (e) { log('cache no banco: desligado (' + e.message + ')'); }
const hoje = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const painel = finPainel.criarPainel({ cliente, hoje });
const conc = finConc.criarConciliacao({ cliente, hoje });
const anexos = anexosConf.criarConferenciaAnexos({ cliente, cred: () => cred, banco: () => banco, linkDe: finPainel.linkLancamento, log: (m) => log(m) });
let internas = 0;
const ctx = {
  lerInterna: (arquivo) => processar.processarDocumentoFinanceiro({ arquivo }, null),
  podeInterna: () => (internas < TETO_INTERNA ? (++internas, true) : false),
  auditar: () => {},
};
const semErro = (p) => Promise.resolve().then(() => p()).then((v) => v, (e) => ({ erro: (e && e.message) || 'falha' }));

(async () => {
  const resumo = [];
  for (const id of IDS) {
    const t0 = Date.now();
    log('condominio', id, 'inicio');
    const [pre, cc, bol] = await Promise.all([
      semErro(() => painel.preBalancete(id, COMP, false)), semErro(() => conc.condominio(id, COMP, false)),
      semErro(() => finBoletos.conferirBoletos(cliente(), id, COMP)),
    ]);
    let anx = null;
    for (let i = 0; i < 400; i++) {
      try { anx = await anexos.aguardar(id, COMP, ctx, 15000); } catch (e) { anx = { erro: e.message }; break; }
      if (!anx.calculando) break;
      log('  anexos', anx.feitos, 'de', anx.total);
    }
    const f = fechamento.montarFechamento({ comp: anexosConf.competencia(COMP), hoje: hoje(), pre, conc: cc, boletos: bol, anexos: anx, marcas: {} });
    f.condominio = id; f.nome = (cc && cc.nome) || (pre && pre.nome) || '';
    const r = anx && anx.resultado ? anx.resultado : null;
    fs.writeFileSync(path.join(SAIDA, 'fechamento-' + id + '.json'), JSON.stringify({ fechamento: f, anexos: r, pre, boletos_resumo: bol && bol.resumo, conciliacao: cc }, null, 1));
    resumo.push({ id, nome: f.nome, status: f.status, pronto: f.pronto, itens: f.itens.map((x) => ({ chave: x.chave, situacao: x.situacao, trava: x.trava, detalhe: x.detalhe })),
      anexos: r && r.resumo, segundos: Math.round((Date.now() - t0) / 1000) });
    log('condominio', id, f.nome, '->', f.status, 'em', Math.round((Date.now() - t0) / 1000), 's; internas usadas', internas);
  }
  fs.writeFileSync(path.join(SAIDA, 'resumo.json'), JSON.stringify(resumo, null, 1));
  log('FIM');
  process.exit(0);
})().catch((e) => { console.error('ERRO', e && e.message); process.exit(1); });
