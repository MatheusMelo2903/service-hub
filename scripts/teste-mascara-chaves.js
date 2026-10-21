// T15: testa a máscara das chaves do Superlógica (funções copiadas do server.js em tempo de teste).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ini = src.indexOf('function temVerChaves');
// A partir da T18 a carteira é criada antes do proxy: o trecho termina nela.
const fimCarteira = src.indexOf('const carteiraT18', ini);
const fim = fimCarteira > 0 ? fimCarteira : src.indexOf("app.use('/api/superlogica'");
if (ini < 0 || fim < 0) throw new Error('trechos não achados no server.js');
const { temVerChaves, mascararSensiveis, campoSensivel, listaTemVerChaves } = new Function(src.slice(ini, fim) + '; return { temVerChaves, mascararSensiveis, campoSensivel, listaTemVerChaves };')();

let ok = 0, falha = 0;
function t(nome, cond) { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } }

const cond = [{ id_condominio_cond: '2', st_nome_cond: 'ALDEIA', st_token_emp: 'abc123', st_credencialpj_cond: 'x', st_chavepj_cond: 'y',
  st_accesskeybpocobranca_cond: '', st_desenho_cond: 'livre', nm_txmulta_cond: '2', sub: { SENHA_X: 's', ok: 'v' } }];
const m = mascararSensiveis(cond);
t('token mascarado', m[0].st_token_emp === '********');
t('credencial mascarada', m[0].st_credencialpj_cond === '********');
t('chave mascarada', m[0].st_chavepj_cond === '********');
t('vazio continua vazio', m[0].st_accesskeybpocobranca_cond === '');
t('campo comum intacto', m[0].st_nome_cond === 'ALDEIA' && m[0].nm_txmulta_cond === '2');
t('desenho nao confunde com senha', m[0].st_desenho_cond === 'livre');
t('aninhado mascarado', m[0].sub.SENHA_X === '********' && m[0].sub.ok === 'v');
t('original nao alterado', cond[0].st_token_emp === 'abc123');
t('numero e texto passam', mascararSensiveis(5) === 5 && mascararSensiveis('a') === 'a');
let fundo = {}; let p = fundo; for (let i = 0; i < 30; i++) { p.n = {}; p = p.n; } p.st_token_x = 'z';
t('profundidade exagerada some', !JSON.stringify(mascararSensiveis(fundo)).includes('"z"'));
t('campoSensivel', campoSensivel('ST_TOKEN_EMP') && !campoSensivel('id_unidade_uni'));
t('ver_chaves exige acao', temVerChaves({ permissoes: { configuracoes: { visivel: true, acoes: ['ver', 'ver_chaves'] } } }));
t('gestor sem acao nao ve', !temVerChaves({ role: 'GESTOR', permissoes: { configuracoes: { visivel: true, acoes: ['ver', 'editar'] } } }));
t('modulo invisivel nao ve', !temVerChaves({ permissoes: { configuracoes: { visivel: false, acoes: ['ver_chaves'] } } }));
t('perfil nulo nao ve', !temVerChaves(null));
t('camelCase accessToken', campoSensivel('accessToken') && campoSensivel('appToken') && campoSensivel('apiKey'));
t('contém token no meio', campoSensivel('st_apptoken') && campoSensivel('st_hashtoken_x'));
t('api_key', campoSensivel('api_key') && campoSensivel('st_chave_pj'));
t('campos comuns nao mascaram', !campoSensivel('st_nome_cond') && !campoSensivel('vl_total') && !campoSensivel('st_desenho_cond') && !campoSensivel('id_condominio_cond'));
t('lista com acao sem visivel', listaTemVerChaves({ configuracoes: { visivel: false, acoes: ['ver_chaves'] } }) && !listaTemVerChaves({}));

console.log(ok + ' ok, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
