// T39: gera o resumo da manhã de verdade (só GET no Superlógica) e grava no Supabase de TESTE.
// Uso (variáveis só via railway run; nada é impresso das chaves):
//   cd /Users/matheusmelo/v8s/service-hub && railway run --service service-hub --environment dev -- \
//     node /Users/matheusmelo/v8s/worktrees/financeiro-avisos/scripts/avisos-gerar.js --listar
//   ... avisos-gerar.js --carteiras 3,7 --saida /caminho/resumo.json
// --listar só lê as carteiras (1 chamada). Sem --carteiras gera todas.
'use strict';
const fs = require('fs');
const path = require('path');
const slModulo = require(path.join(__dirname, '..', 'superlogica'));
const avisos = require(path.join(__dirname, '..', 'financeiro', 'avisos'));
const finBanco = require(path.join(__dirname, '..', 'financeiro', 'banco'));

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const cliente = slModulo.cliente({
  base: (process.env.SUPERLOGICA_API_BASE || 'https://api.superlogica.net').replace(/\/+$/, ''),
  appToken: process.env.SUPERLOGICA_APP_TOKEN || '', accessToken: process.env.SUPERLOGICA_ACCESS_TOKEN || '',
});
// Só GET: o script nunca recebe outro método.
const soLeitura = { get: (a, p) => cliente.get(a, p) };
let gruposCache = null;
const grupos = async () => (gruposCache = gruposCache || await slModulo.carteiras.lerGrupos(soLeitura));
const hora = () => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());

(async () => {
  if (!process.env.SUPERLOGICA_APP_TOKEN || !process.env.SUPERLOGICA_ACCESS_TOKEN) { console.log('Superlógica não configurado'); process.exit(2); }
  if (process.argv.includes('--listar')) {
    (await grupos()).forEach((g) => console.log([g.id, g.tipo, g.nome, g.gerente, g.quantidade].join(' | ')));
    return;
  }
  const carteiras = arg('--carteiras') ? arg('--carteiras').split(',').map(Number).filter(Boolean) : null;
  const banco = finBanco.criarBanco({ url: process.env.SUPABASE_URL, chave: process.env.SUPABASE_SERVICE_ROLE_KEY }); // recusa produção
  const servico = avisos.criarServico({ banco, cliente: () => soLeitura, grupos, log: (m) => console.log(hora() + ' ' + m), esperaSobDemanda: 0 });
  console.log(hora() + ' início, carteiras ' + (carteiras ? carteiras.join(',') : 'todas'));
  const r = await servico.iniciar({ origem: 'teste', carteiras, limiteDias: process.env.AVISOS_DIAS_SEM_EXTRATO });
  const res = await r.promessa;
  const g = res.geral;
  const resumo = {
    execucao: r.execucao, dia: g.dia, gerado_em: g.gerado_em, limite_dias: g.limite_dias, competencias: g.competencias, auditoria_dias: g.auditoria_dias,
    condominios: g.condominios, contas_sem_extrato: g.contas_sem_extrato, contas_com_falha: g.contas_com_falha,
    chamadas: g.chamadas, chamadas_recusadas: g.chamadas_recusadas, duracao_s: g.duracao_s, falhas_total: g.falhas_total, falhas: g.falhas,
    alertas_base: g.alertas_base, erros_total: g.erros.length, erros_sem_usuario: g.erros_sem_usuario,
    erros_por_usuario: g.erros.reduce((m, e) => { m[e.autor + ' #' + e.id_usuario_sl] = (m[e.autor + ' #' + e.id_usuario_sl] || 0) + 1; return m; }, {}),
    usuarios_vistos: g.usuarios.length,
    carteiras: res.carteiras.map((c) => ({ id: c.id, nome: c.nome, tipo: c.tipo, gerente: c.gerente, condominios: c.condominios, totais: c.totais, primeiros: c.itens.slice(0, 12) })),
    exemplos_erros: g.erros.slice(0, 8).map((e) => ({ autor: e.autor, papel: e.papel, tipo: e.descricao_tipo, gravidade: e.gravidade, condominio: e.condominio, valor: e.valor, link: e.link })),
  };
  if (arg('--saida')) fs.writeFileSync(arg('--saida'), JSON.stringify(resumo, null, 2));
  console.log(hora() + ' fim: ' + JSON.stringify({ condominios: g.condominios, chamadas: g.chamadas, duracao_s: g.duracao_s, falhas: g.falhas_total, erros: g.erros.length }));
})().catch((e) => { console.log('ERRO ' + (e && e.message)); process.exit(1); });
