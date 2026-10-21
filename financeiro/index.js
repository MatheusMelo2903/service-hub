'use strict';
// Módulo financeiro (servidor): cópia do Superlógica para as tabelas fin_* do Supabase.
// Só leitura no Superlógica (GET pelo cliente de superlogica-dados.js, com retry).
// Gravação só no Supabase de TESTE enquanto a produção não for autorizada (banco.js).
const slDados = require('../superlogica-dados');
const { criarBanco } = require('./banco');
const { criarSync, TIPOS } = require('./sync');
const U = require('./util');

let emAndamento = null; // uma sincronização por vez neste processo

function situacao() {
  return emAndamento ? { rodando: true, execucao: emAndamento.execucao, desde: emAndamento.desde, opcoes: emAndamento.opcoes } : { rodando: false };
}

// cred: { base, appToken, accessToken, supabaseUrl, supabaseChave }
// opcoes: { inicio, fim, tipos, idCondominio, pular }
async function sincronizar(cred, opcoes, { log, origem, usuario } = {}) {
  if (emAndamento) { const e = new Error('sincronizacao_em_andamento'); e.execucao = emAndamento.execucao; throw e; }
  const banco = criarBanco({ url: cred.supabaseUrl, chave: cred.supabaseChave });
  const cliente = slDados.criarCliente({ base: cred.base, appToken: cred.appToken, accessToken: cred.accessToken });
  const s = criarSync({ cliente, banco, log: log || (() => {}), origem: origem || 'script', usuario: usuario || null });
  emAndamento = { execucao: s.execucao, desde: new Date().toISOString(), opcoes: { inicio: opcoes.inicio, fim: opcoes.fim, tipos: opcoes.tipos || TIPOS, idCondominio: opcoes.idCondominio || null } };
  const promessa = s.rodar({ ...opcoes, listarCondominios: slDados.listarCondominiosSuperlogica })
    .finally(() => { emAndamento = null; });
  return { execucao: s.execucao, promessa };
}

// Últimas execuções e data da última sincronização por condomínio (para a tela e para a rota).
async function painel(cred) {
  const banco = criarBanco({ url: cred.supabaseUrl, chave: cred.supabaseChave });
  const [execucoes, condominios] = await Promise.all([
    banco.ler('fin_sync_log?select=execucao,origem,tipo,status,janela_inicio,janela_fim,id_condominio,itens,gravados,duracao_ms,criado_em&tipo=eq.execucao&order=id.desc&limit=20'),
    banco.ler('fin_condominios?select=id_condominio,fantasia,ultima_sincronizacao,sincronizado_de,sincronizado_ate,sync_tipos&order=id_condominio'),
  ]);
  return { situacao: situacao(), execucoes, condominios };
}

module.exports = { sincronizar, painel, situacao, TIPOS, util: U };
