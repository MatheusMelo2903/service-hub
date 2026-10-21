# T24 conector financeiro (Superlógica para tabelas fin_*)

Data: 21/10/2026, sessão agendada raia B. Branch feat/financeiro-auditor.

## O que entrou
1. Migration 014 (migrations/2026-10-21_014_financeiro.sql), aplicada só no Supabase de teste: fin_condominios, fin_contas, fin_despesas, fin_parcelas, fin_anexos, fin_movimentos, fin_cobrancas, fin_auditoria_sl, fin_sync_log. RLS ligado sem policy; anon e authenticated sem acesso.
2. Módulo financeiro/ no servidor:
   util.js (datas MM/DD/AAAA e mistas, janelas, excluídos 143, 144, 145, 160, 162),
   mapear.js (só os campos que o auditor usa; sem token, segredo, agência, número de conta, CPF de pessoa física e nome de morador),
   banco.js (upsert em lotes de 500 pelo PostgREST; recusa qualquer projeto que não seja o de teste),
   sync.js (janelas, divisão automática quando o Superlógica estoura, log por janela),
   index.js (uma sincronização por vez, painel de situação).
3. scripts/fin-sync.js: carga por linha de comando com railway run; --retomar <execucao> pula janelas já feitas.
4. Rotas só GESTOR: POST /api/financeiro/sincronizar (até 31 dias, roda em segundo plano, devolve 202 com a execução) e GET /api/financeiro/sincronizacao (em andamento, últimas execuções e data da última sincronização por condomínio).
5. scripts/teste-financeiro.js: 10 testes sem rede.

## Janelas usadas (sonda T23)
contas: uma chamada; despesas liquidadas: quinzena por liquidação; despesas pendentes: mês; caixa: mês; cobranças: por condomínio e mês, paginado de 50 (no -1 estoura); auditoria: um dia, sempre -1.
Resposta que não é JSON (estouro com HTTP 200) divide a janela ao meio até um dia e depois pagina.

## Achados
auditoria/index com um código de condomínio não filtra e tira o nome fantasia: o conector sempre lê -1 e acha o condomínio pelo nome fantasia. Linhas sem nome fantasia ficam sem condomínio (o auditor liga pela despesa).
A auditoria guarda só linhas de despesa, parcela, arquivo, apropriação, extrato, fornecedor e conta bancária; cobrança, receita, push e retorno .RET ficam fora (cerca de 2/3 do volume).

## Limites conhecidos
A trava de uma sincronização por vez vale por processo: o script e o servidor podem rodar juntos (os upserts são idempotentes).
Nada é apagado: despesa, anexo ou cobrança que sumiu do Superlógica fica com visto_em antigo (o auditor compara visto_em).
Produção: a gravação está travada no projeto de teste; liberar exige mudar REFS_PERMITIDAS em financeiro/banco.js e aplicar a 014 em produção, com autorização do Matheus.
