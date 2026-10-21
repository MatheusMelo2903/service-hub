# T05 Importar Despesas com checagem e alertas no Dashboard (20/10/2026)

## O que foi feito

1. Importar Despesas: campo opcional "Documento (nº da nota)" (vai como ST_DOCUMENTO_DES). Ao validar, o Hub confere no Superlógica cada linha válida: duplicata (mesmo fornecedor, valor e vencimento, e o mesmo documento quando a linha tem documento), repetida dentro da planilha, e fornecedor inexistente. Linha com problema fica bloqueada com o motivo. Logo antes de enviar, confere de novo; qualquer problema TRAVA o envio inteiro. Se a conferência falhar, nada é enviado.
2. Rota POST /api/despesas/verificar (só leitura no Superlógica: despesas/index por data de vencimento e fornecedores/index por código; 404 do fornecedor = não existe). Limites: 500 linhas, 31 datas e 50 fornecedores por envio, no máximo 4 consultas simultâneas, uma conferência por condomínio de cada vez, leitura com cache de 3 minutos. Se um vencimento tiver mais de 500 parcelas, a conferência recusa (nunca libera com leitura cortada).
3. Alertas por condomínio (GET /api/condominio/:id/alertas): contas a pagar vencendo em até 7 dias, saldo da conta principal abaixo do limite configurado, despesas recorrentes cuja ocorrência prevista (campo ordenacao do despesas/despesasrecorrente, consultado mês a mês: mês passado e mês atual) já passou e sem despesa do mesmo fornecedor lançada até 10 dias da data prevista. Cada alerta tem chave estável; o estado (novo, visto, resolvido) fica na tabela alertas. Ver alertas: quem tem acesso aos dados do Superlógica. Mudar estado e limite: só GESTOR e GERENTE. PATCH /api/alertas/:id muda o estado; PUT /api/condominio/:id/alertas/config grava o saldo mínimo (vazio ou zero desliga).
4. Migration migrations/2026-10-20_007_alertas.sql (tabelas alertas e alertas_config, RLS ligado sem policy: só o servidor acessa). Aplicada SÓ no Supabase de teste.
5. Dashboard: card "Alertas do condomínio" com Visto, Resolvido, Reabrir, ver resolvidos, limite de saldo e Atualizar; recarrega ao trocar o condomínio.

## Testes

scripts/despesas-alertas-harness.mjs: 29/29 (erros de entrada, 401, mais de 31 datas, mesmo documento é duplicata, documentos diferentes não, fornecedor inexistente, repetida na planilha, duplicata real lida de um condomínio real só em leitura, valor ou documento diferente não é duplicata, alertas reais, ciclo de saldo baixo no condomínio de teste 167). Envio real de despesa testado só no condomínio 167 (ver diário).

## Limitações

1. O alerta de recorrente depende do campo ordenacao do Superlógica (data da próxima geração); se o Superlógica mudar esse formato, o alerta some (não inventa).
2. O envio continua pelo fluxo antigo (proxy do navegador). A trava é da tela: uma chamada direta ao proxy, fora da tela, não passa pela conferência. Fechar isso exige o proxy exigir um comprovante da conferência (tarefa futura).
3. Duplicata: se a despesa já lançada não tem documento, ela bate com a linha da planilha mesmo que a planilha traga documento (o envio antigo nunca mandava documento).
