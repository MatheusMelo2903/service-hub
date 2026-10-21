# T42 custo de API (21/10/2026)

Entrega: nome dos modelos num lugar só (servico/modelos.js), registro do custo de cada chamada (servico/custo.js, tabela api_uso da migration 019, só no Supabase de teste) e painel "Custo de processamento" só para o dono (public/custo.js, GET /api/custo/resumo).

Trocas de modelo testadas com dados reais (detalhe em EXECUCAO/testes/T42/resultado.md):
1. Leitura do edital: haiku 4.5 para haiku 5.5 (60/60 nos dois, 7 vezes mais barato).
2. Normalização de unidades: sonnet 4.6 para sonnet 5.5 esforço baixo (campos iguais ou melhores, 18% mais barato, 2,5 vezes mais rápido).
3. Prestação de contas: sonnet 4.6 para sonnet 5.5 esforço baixo (menos texto descartado, 27 a 57% mais barato, 3 vezes mais rápido).
4. Inserção de último recurso da ata: opus 4.7 mantido (sonnet 5.5 e opus 5.5 inseriram menos lacunas e apagaram valores).

Variáveis: MODELO_<FUNCAO> (ata, ata_ultimo_recurso, comunicado, edital, unidades, prestacao, medidor, medidor_reforco, entrada_documento), ESFORCO_UNIDADES e ESFORCO_PRESTACAO (low, medium, high ou nenhum), CUSTO_PRECOS (JSON com preço por milhão: entrada, saída, cache lido, cache criado), CUSTO_LIMITE_MENSAL_USD (padrão 200). As antigas ATA_MODELO, PRESTACAO_MODELO, MEDIDOR_MODELO, MEDIDOR_MODELO_REFORCO e ENTRADA_MODELO continuam valendo.

Regra do registro: volta na hora, nunca lança erro, grava em segundo plano; falha vira só log.
Testes: scripts/teste-custo-api.js. Revisão 1 em EXECUCAO/testes/T42/revisao-1.md (0 GRAVE, 2 MÉDIO corrigidos).
Produção: aplicar migrations/2026-10-21_019_api_uso.sql junto quando subir.
