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
t('raiane tira gerar (ela tem gerar; repassa o que tem desde 23/10/2026)', P.conferirMudanca(raiane, antes, { atas: { visivel: true, acoes: [] } }).ok);
const raianeSoAtas = { id: 'r3', role: 'GERENTE', pode_convidar: true, permissoes: { atas: { visivel: true, acoes: ['gerar', 'edital'] } }, concede: {} };
t('raiane sem concede repassa a ação que ela tem', P.conferirMudanca(raianeSoAtas, antes, { atas: { visivel: true, acoes: ['gerar', 'edital'] } }).ok);
t('raiane sem concede não repassa ação que ela não tem', !P.conferirMudanca(raianeSoAtas, antes, { atas: { visivel: true, acoes: ['gerar', 'transcricao_livre'] } }).ok);
t('raiane sem concede não mostra módulo que ela não vê', !P.conferirMudanca(raianeSoAtas, antes, Object.assign({}, antes, { cobranca: { visivel: true, acoes: [] } })).ok);
t('quem tem ação restrita não repassa', !P.conferirMudanca({ id: 'r4', role: 'GERENTE', pode_convidar: true, permissoes: { configuracoes: { visivel: true, acoes: ['ver_chaves'] } }, concede: {} }, antes, Object.assign({}, antes, { configuracoes: { visivel: true, acoes: ['ver_chaves'] } })).ok);
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

// T18 encaixe: módulos novos no concede e todas_carteiras só pelo dono
const raiane2 = Object.assign({}, raiane, { concede: { cobranca: ['ver', 'segunda_via'], ficha_condominio: ['ver'], comparativo: ['ver'], configuracoes: ['todas_carteiras'] } });
t('raiane da cobranca segunda via', P.conferirMudanca(raiane2, antes, Object.assign({}, antes, { cobranca: { visivel: true, acoes: ['segunda_via'] } })).ok);
t('raiane mostra ficha e comparativo', P.conferirMudanca(raiane2, antes, Object.assign({}, antes, { ficha_condominio: { visivel: true, acoes: [] }, comparativo: { visivel: true, acoes: [] } })).ok);
t('raiane sem concede de cobranca nao da', !P.conferirMudanca(raiane, antes, Object.assign({}, antes, { cobranca: { visivel: true, acoes: ['segunda_via'] } })).ok);
t('raiane nao da todas_carteiras nem com concede', !P.conferirMudanca(raiane2, antes, Object.assign({}, antes, { configuracoes: { visivel: false, acoes: ['todas_carteiras'] } })).ok);
t('gestor comum nao da todas_carteiras', !P.conferirMudanca(gestor2, antes, Object.assign({}, antes, { configuracoes: { visivel: false, acoes: ['todas_carteiras'] } })).ok);
t('dono da todas_carteiras', P.conferirMudanca(dono, antes, Object.assign({}, antes, { configuracoes: { visivel: false, acoes: ['todas_carteiras'] } })).ok);
t('concede com todas_carteiras recusado', !P.concedeBemFormado({ configuracoes: ['todas_carteiras'] }));
t('raiane nao edita quem ve todas as carteiras', !P.podeEditarAlvo(raiane2, { id: 'tc', role: 'OPERACIONAL', permissoes: { configuracoes: { visivel: false, acoes: ['todas_carteiras'] } } }).ok);

// Painel da gestão (Agenda do mês): só um GESTOR dá ou tira; nunca vai no concede.
const painel = { gestao_painel: { visivel: true, acoes: ['ver'] } };
const raianePainel = Object.assign({}, raiane, { permissoes: Object.assign({}, raiane.permissoes, painel), concede: { gestao_painel: ['ver'] } });
t('dono libera o painel da gestao', P.conferirMudanca(dono, antes, Object.assign({}, antes, painel)).ok);
t('raiane com o painel nao repassa', P.conferirMudanca(raianePainel, antes, Object.assign({}, antes, painel)).motivo === 'so_gestor_concede');
t('raiane nao tira o painel de ninguem', !P.conferirMudanca(raianePainel, Object.assign({}, antes, painel), antes).ok);
t('gestor comum sem o painel nao libera', !P.conferirMudanca(gestor2, antes, Object.assign({}, antes, painel)).ok);
t('concede com o painel recusado', !P.concedeBemFormado({ gestao_painel: ['ver'] }));
t('mudanca sem o painel segue a regra de antes', P.conferirMudanca(raiane, antes, { atas: { visivel: true, acoes: ['gerar', 'transcricao_livre'] } }).ok);

console.log(ok + '/' + (ok + falha));
process.exit(falha ? 1 : 0);
