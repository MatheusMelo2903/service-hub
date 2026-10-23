// T37: quem vê os itens Financeiro, Boletos, Conciliação e Entrada de documentos no menu.
// Lê podeAbrirPainel do public/index.html e roda com perfis de exemplo (falha fechada).
// Uso: node scripts/teste-menu-financeiro.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ini = html.indexOf('var PAINEL_MODULOS');
const fim = html.indexOf('function aplicarVisibilidadePaineisFinanceiros');
if (ini < 0 || fim < 0) { console.log('FALHOU: trecho de podeAbrirPainel não encontrado'); process.exit(1); }
const codigo = html.slice(ini, fim);

function rodar(role, perms) {
  const ctx = { window: { USER_ROLE: role, USER_PERMS: perms } };
  vm.createContext(ctx);
  vm.runInContext(codigo + '\nthis.r = { fincontrole: podeAbrirPainel("fincontrole"), boletos: podeAbrirPainel("boletos"), conciliacao: podeAbrirPainel("conciliacao"), entrada: podeAbrirPainel("entrada"), dashboard: podeAbrirPainel("dashboard"), alias: PAINEL_ALIAS };', ctx);
  return ctx.r;
}
let ok = 0, falha = 0;
const t = (nome, cond) => { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } };
const v = (acoes) => ({ visivel: true, acoes: acoes || ['ver'] });

// Raiane (OPERACIONAL, só Atas e Prestação): nenhum item financeiro.
const raiane = rodar('OPERACIONAL', { atas: v(['ver', 'gerar']), prestacao_contas: v(['ver', 'gerar']), dashboard: v() });
t('raiane sem Financeiro', !raiane.fincontrole);
t('raiane sem Boletos', !raiane.boletos);
t('raiane sem Conciliação', !raiane.conciliacao);
t('raiane sem Entrada', !raiane.entrada);
t('raiane vê Dashboard', raiane.dashboard);

// Sem permissões carregadas (ou erro ao ler o perfil): nada aparece.
const nulo = rodar('OPERACIONAL', null);
t('sem perfil: nada', !nulo.fincontrole && !nulo.boletos && !nulo.conciliacao && !nulo.entrada);
const gestorSemPerfil = rodar('GESTOR', null);
t('GESTOR antes de carregar o perfil: nada', !gestorSemPerfil.fincontrole && !gestorSemPerfil.entrada);

// GESTOR vê tudo, mesmo sem as chaves novas no perfil (o servidor faz igual).
const gestor = rodar('GESTOR', { dashboard: v() });
t('GESTOR vê os quatro', gestor.fincontrole && gestor.boletos && gestor.conciliacao && gestor.entrada);

// Boletos e Conciliação exigem o módulo do item E o financeiro.
const soBoletos = rodar('GERENTE', { boletos: v(), conciliacao: v() });
t('boletos sem financeiro: não', !soBoletos.boletos && !soBoletos.conciliacao && !soBoletos.fincontrole);
const soFin = rodar('GERENTE', { financeiro: v(['ver', 'pre_balancete']) });
t('financeiro sem boletos: só o painel', soFin.fincontrole && !soFin.boletos && !soFin.conciliacao && !soFin.entrada);
const tudo = rodar('OPERACIONAL', { financeiro: v(), boletos: v(), conciliacao: v(), entrada_documentos: v(['ver', 'lancar']) });
t('com todos os módulos: os quatro', tudo.fincontrole && tudo.boletos && tudo.conciliacao && tudo.entrada);
const escondido = rodar('OPERACIONAL', { financeiro: { visivel: false, acoes: ['ver'] }, boletos: v(), entrada_documentos: { visivel: true, acoes: [] } });
t('visivel false ou sem ver: não', !escondido.fincontrole && !escondido.boletos && !escondido.entrada);
const notas = rodar('OPERACIONAL', { notas_fiscais: v() });
t('notas_fiscais antigo não abre a Entrada', !notas.entrada);

// Nomes antigos guardados no navegador.
t('alias financeiro vira conciliacao', gestor.alias.financeiro === 'conciliacao');
t('alias nf vira entrada', gestor.alias.nf === 'entrada');

// Textos do menu e títulos.
t('menu sem Notas Fiscais', !/>\s*<span class="nav-icon">[^<]*<\/span> Notas Fiscais/.test(html));
t('menu com Entrada de documentos', html.includes("showPanel('entrada')") && html.includes('</span> Entrada de documentos'));
const menu = html.slice(html.indexOf('<nav class="nav">'), html.indexOf('</nav>'));
t('nenhum item em breve no menu (Tarefas saiu em 23/10/2026)', !(menu.match(/em breve/g) || []).length);
t('sem tela vazia de Notas Fiscais', !html.includes('id="panel-nf"') && !html.includes('Conciliação bancária'));

console.log(ok + ' ok, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
