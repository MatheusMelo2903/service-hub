// T21: confere as regras de quem pode mexer em quem (servico/permissoes.js).
// Uso: node scripts/teste-permissoes.js
const P = require('../servico/permissoes');

const dono = { id: 'd', role: 'GESTOR', permissoes: { configuracoes: { visivel: true, acoes: ['ver', 'auditoria_total', 'ver_auditoria'] } } };
const raiane = { id: 'r', role: 'GERENTE', pode_convidar: true, permissoes: { atas: { visivel: true, acoes: ['gerar', 'transcricao_livre'] } },
  concede: { atas: ['ver', 'transcricao_livre'], previsao: ['ver'] } };
const gerenteSemConcede = { id: 'g', role: 'GERENTE', pode_convidar: true, permissoes: {}, concede: {} };
const gestor2 = { id: 'x', role: 'GESTOR', permissoes: {} };
const op = { id: 'o', role: 'OPERACIONAL', permissoes: { atas: { visivel: true, acoes: ['gerar'] } } };
const opAuditor = { id: 'oa', role: 'OPERACIONAL', permissoes: { configuracoes: { visivel: true, acoes: ['ver_auditoria'] } } };

let ok = 0, falha = 0;
const t = (nome, cond) => { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } };

// Quem mexe em quem
t('dono edita raiane', P.podeEditarAlvo(dono, raiane).ok);
t('raiane nao edita dono', !P.podeEditarAlvo(raiane, dono).ok);
t('raiane nao edita a si mesma', !P.podeEditarAlvo(raiane, raiane).ok);
t('raiane nao edita gestor', !P.podeEditarAlvo(raiane, gestor2).ok);
t('raiane nao edita outro gerente que libera', !P.podeEditarAlvo(raiane, gerenteSemConcede).ok);
t('raiane edita operacional', P.podeEditarAlvo(raiane, op).ok);
t('raiane nao edita auditor', !P.podeEditarAlvo(raiane, opAuditor).ok);
t('gestor comum nao edita dono', !P.podeEditarAlvo(gestor2, dono).ok);
t('dono nao edita a si mesmo', !P.podeEditarAlvo(dono, dono).ok);
t('gerente sem pode_convidar nao edita', !P.podeEditarAlvo({ id: 'z', role: 'GERENTE', pode_convidar: false }, op).ok);

// O que pode mudar
const antes = op.permissoes;
t('raiane libera transcricao livre', P.conferirMudanca(raiane, antes, { atas: { visivel: true, acoes: ['gerar', 'transcricao_livre'] } }).ok);
t('raiane nao tira gerar (fora do concede)', !P.conferirMudanca(raiane, antes, { atas: { visivel: true, acoes: [] } }).ok);
t('raiane mostra previsao', P.conferirMudanca(raiane, antes, Object.assign({}, antes, { previsao: { visivel: true, acoes: [] } })).ok);
t('raiane nao da acao de previsao', !P.conferirMudanca(raiane, antes, Object.assign({}, antes, { previsao: { visivel: true, acoes: ['editar'] } })).ok);
t('raiane nao da ver_chaves', !P.conferirMudanca(raiane, antes, Object.assign({}, antes, { configuracoes: { visivel: false, acoes: ['ver_chaves'] } })).ok);
t('ninguem da auditoria_total', !P.conferirMudanca(dono, antes, Object.assign({}, antes, { configuracoes: { visivel: true, acoes: ['auditoria_total'] } })).ok);
t('dono da ver_auditoria', P.conferirMudanca(dono, antes, Object.assign({}, antes, { configuracoes: { visivel: true, acoes: ['ver_auditoria'] } })).ok);
t('gerente sem concede nao libera nada', !P.conferirMudanca(gerenteSemConcede, antes, { atas: { visivel: true, acoes: ['gerar', 'transcricao_livre'] } }).ok);
t('sem mudanca passa', P.conferirMudanca(gerenteSemConcede, antes, JSON.parse(JSON.stringify(antes))).ok);
t('adicionadas listadas', P.conferirMudanca(raiane, antes, { atas: { visivel: true, acoes: ['gerar', 'transcricao_livre'] } }).adicionadas.includes('atas.transcricao_livre'));

// Formato do concede
t('concede valido', P.concedeBemFormado({ atas: ['ver', 'transcricao_livre'] }));
t('concede com restrita recusado', !P.concedeBemFormado({ configuracoes: ['ver_chaves'] }));
t('concede lista recusado', !P.concedeBemFormado([]));
t('concede nome estranho recusado', !P.concedeBemFormado({ 'a b': ['ver'] }));

console.log(ok + '/' + (ok + falha));
process.exit(falha ? 1 : 0);
