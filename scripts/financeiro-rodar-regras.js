// T29: roda as regras do auditor (financeiro/regras) sobre os dados puxados por financeiro-puxar.js.
// Uso: node scripts/financeiro-rodar-regras.js <pasta_dados> [AAAA-MM-DD hoje]
// Grava <pasta_dados>/alertas.json (dado real: a pasta fica fora do git). Não chama a API.
'use strict';
const fs = require('fs');
const path = require('path');
const { rodarRegras } = require('../financeiro/regras');

const DIR = process.argv[2];
if (!DIR) { console.log('informe a pasta dos dados'); process.exit(2); }
const hoje = process.argv[3] || new Date().toISOString().slice(0, 10);
const ler = (pref) => fs.readdirSync(DIR).filter((f) => f.startsWith(pref + '_') && f.endsWith('.json'))
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));

const despesas = [...ler('liq'), ...ler('pend')];
const auditoria = ler('aud');
const t0 = Date.now();
const { alertas, analistasPorCondominio } = rodarRegras({ despesas, auditoria }, { hoje });
const datasAud = [...new Set(auditoria.map((r) => String(r.dt_data_aud || '').slice(0, 10)))].sort();
fs.writeFileSync(path.join(DIR, 'alertas.json'), JSON.stringify({
  gerado_em: new Date().toISOString(), hoje, parcelas: despesas.length, linhas_auditoria: auditoria.length, dias_auditoria: datasAud,
  analistas_por_condominio: Object.fromEntries(analistasPorCondominio), alertas,
}));
const cont = {};
alertas.forEach((a) => { const k = a.tipo + ' ' + a.gravidade; cont[k] = (cont[k] || 0) + 1; });
console.log('parcelas', despesas.length, 'auditoria', auditoria.length, 'alertas', alertas.length, 'em', Date.now() - t0, 'ms');
Object.keys(cont).sort().forEach((k) => console.log(k, cont[k]));
