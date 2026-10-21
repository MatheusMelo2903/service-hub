# T25 regras do auditor financeiro e T29 planilha de erros (raia G, 21/10/2026)

Branch feat/financeiro-regras, a partir de origin/dev. Sem migration, sem rota nova, sem gravação: só funções puras e scripts locais.

## Regras (financeiro/regras)
Recebem itens no formato da API do Superlógica (despesas/index liquidadas e pendentes, auditoria/index) e devolvem alertas
com regra, tipo, gravidade (alta, media, baixa), condomínio, analista (último usuário na despesa pela auditoria, ou quem mais
lançou no condomínio), fornecedor, documento, valor, datas, id da despesa e da parcela e detalhe.

1. R1 duplicidade: mesmo documento do mesmo fornecedor ou mesmo código de barras no mesmo condomínio (R1_DOCUMENTO); mesmo fornecedor e valor com vencimento a até 10 dias (R1_FORNECEDOR_VALOR), sem concessionárias (ESCELSA R$ 39,48 e outras UCs), impostos, folha, débito automático, lista branca (diaristas, opção listaBranca com id_contato ou CNPJ), prestadores semanais e pares com documentos ou códigos de barras diferentes.
2. R2 condomínio trocado: mesmo código de barras, ou mesma nota do mesmo fornecedor, em dois condomínios.
3. R4 pago sem comprovante (etiqueta Comprovante) e anexo removido de despesa já paga (auditoria; troca de arquivo no mesmo dia pesa menos).
4. R5 pago sem Doc. Fiscal, fora concessionárias, impostos, débito automático, folha, tarifas e repasses.
5. R6 pendente com vencimento antes de hoje.
6. R8 lançada depois do vencimento, anexo mais de 30 dias depois do pagamento e paga depois do vencimento sem juros registrados.
7. R9 mexidas por usuário: remoção de anexo, valor, vencimento, estorno, exclusão, pagamento cancelado, troca de fornecedor; correção no mesmo dia pelo mesmo usuário que lançou fica baixa.
Fora de tudo: ids 143, 144, 145, 160, 162 e o 167 (teste).

## Scripts
1. scripts/financeiro-puxar.js: só GET, 3 chamadas simultâneas, 2 s de pausa em 429 ou erro, quebra a janela ao meio se o Superlógica devolver corpo que não é JSON. Liquidadas por quinzena, pendentes de uma vez, auditoria dos últimos 10 dias úteis.
2. scripts/financeiro-rodar-regras.js: roda as regras sobre a pasta de dados e grava alertas.json.
3. scripts/financeiro_planilha_erros.py: monta a planilha (Resumo por tipo, condomínio e analista; uma aba por tipo; Como ler).
4. scripts/financeiro-regras-teste.js: 36 casos sintéticos e 5 com os JSON reais da T23 (41 ok).

## Resultado de 21/10 (dado real fora do git)
31.591 parcelas (pagas de 01/04 a 21/10, pendentes vencidas desde 2025 e a vencer em 60 dias) e 251.458 linhas de auditoria (07/10 a 20/10), casos em ~/Downloads/Financeiro_erros_2026-10-21.xlsx.

## Revisão 1 (testes/T25/revisao-1.md)
0 GRAVE. Corrigidos os 4 MÉDIOS (anexos por despesa na R4 e R8, pendentes futuras e antigas, condomínio -1 na R9, linha digitável e documento alterado) e os MENORES 1 a 11.
Conflito com a T24 (feat/financeiro-auditor): nenhum (arquivos diferentes; superlogica-dados.js mantém criarCliente).
Os três casos de condomínio trocado do diagnóstico (Macovit doc 41483, VIVO R$ 79,99, Vix Ocupacional R$ 132,00) aparecem.

## Para a raia B (T24)
Ligar rodarRegras às tabelas fin_* lendo as linhas no formato da API e gravando em fin_alertas (chave sugerida: tipo + id_parcela, ou id_auditoria para R9 e R4 anexo removido).

## A confirmar com o Matheus e o financeiro
Lista de contas sem nota (folha, tarifas, repasses); lista branca real de diaristas; se comprovante tardio interessa (é a maior parte do anexo tardio).
