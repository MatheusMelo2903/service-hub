'use strict';
// Carga do financeiro do Superlógica para o Supabase de TESTE (tabelas fin_*).
// Uso (variáveis do dev, sem ver as chaves):
//   cd /Users/matheusmelo/v8s/service-hub && railway run --service service-hub --environment dev -- \
//     node <worktree>/scripts/fin-sync.js --inicio 2026-04-01 --fim 2026-10-21 [--tipos a,b] [--cond 136] [--retomar <execucao>]
// Nunca imprime credenciais. Só GET no Superlógica.
const path = require('path');
const fin = require(path.join(__dirname, '..', 'financeiro'));

function arg(nome, padrao) {
  const i = process.argv.indexOf('--' + nome);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

async function main() {
  const cred = {
    base: (process.env.SUPERLOGICA_API_BASE || 'https://api.superlogica.net').replace(/\/+$/, ''),
    appToken: process.env.SUPERLOGICA_APP_TOKEN || '',
    accessToken: process.env.SUPERLOGICA_ACCESS_TOKEN || '',
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseChave: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
  const faltam = ['appToken', 'accessToken', 'supabaseUrl', 'supabaseChave'].filter((k) => !cred[k]);
  if (faltam.length) { console.log('variaveis ausentes: ' + faltam.join(', ')); process.exit(2); }

  const opcoes = {
    inicio: arg('inicio', '2026-04-01'),
    fim: arg('fim', fin.util.hojeBR()),
    tipos: arg('tipos', '') ? arg('tipos').split(',') : null,
    idCondominio: arg('cond', null),
  };
  const retomar = arg('retomar', null);
  if (retomar) {
    if (!/^[0-9a-f-]{36}$/.test(retomar)) { console.log('execucao invalida'); process.exit(2); }
    const { criarBanco } = require(path.join(__dirname, '..', 'financeiro', 'banco'));
    const banco = criarBanco({ url: cred.supabaseUrl, chave: cred.supabaseChave });
    // --retomar-tipos a,b: pula só as janelas feitas destes tipos (os outros rodam de novo)
    const soTipos = arg('retomar-tipos', '') ? arg('retomar-tipos').split(',') : null;
    const feitas = [];
    for (let off = 0; off < 200000; off += 1000) { // o PostgREST devolve no máximo 1000 por vez
      const pg = await banco.ler('fin_sync_log?select=tipo,janela_inicio,janela_fim,id_condominio&status=eq.ok&execucao=eq.' + retomar + '&order=id&limit=1000&offset=' + off);
      feitas.push(...pg);
      if (pg.length < 1000) break;
    }
    opcoes.pular = new Set(feitas.filter((f) => !soTipos || soTipos.includes(f.tipo))
      .map((f) => [f.tipo, f.janela_inicio, f.janela_fim, f.id_condominio || ''].join('|')));
    console.log('retomando: ' + opcoes.pular.size + ' janelas ja feitas serao puladas');
  }
  const log = (m) => console.log(new Date().toISOString().slice(11, 19) + ' ' + m);
  const { promessa } = await fin.sincronizar(cred, opcoes, { log, origem: 'script' });
  const r = await promessa;
  process.exit(r.janelas_erro ? 1 : 0);
}

main().catch((e) => { console.log('falhou: ' + (e && e.message)); process.exit(3); });
