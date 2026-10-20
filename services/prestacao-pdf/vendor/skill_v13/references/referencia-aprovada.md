# Referência aprovada: Condomínio Buritis, Ago/2025 a Set/2026

Aprovada por Matheus e pela gerência (Raiane) em 20/10/2026, depois de teste em projetor ("ficou com letras grandes... melhor desse jeito").

Entrada: W011A padrão Ago/2025 a Jul/2026, W011A detalhado Out/2025 a Set/2026, W015A detalhado com coluna 01/08/25 a 30/09/26.
Comando: `extrair.py --inicio 2025-08 --fim 2026-09` (modo detalhado via w015a_exato) e `montar.py` com `exemplo_composicao_buritis.json`.

Números: saldo inicial R$ 619.550,09, receitas R$ 4.043.215,62 em 37 fontes, despesas R$ 3.617.754,43 em 10 categorias e 95 rubricas, superávit R$ 425.461,19, saldo final R$ 1.045.011,28 (+68,7%), 12 de 14 meses positivos.

35 slides: capa, visão geral, evolução, patrimônio, resultado mensal, origem da receita, todas as fontes, estrutura, 26 páginas de detalhamento (Serviços 7, Aquisição de Materiais 6, Manutenção 3, Pessoal 2, Administrativo 2, Financeiras 2, Consumo 1, Retenções 1, Investimento 1, Taxas 1), encerramento.

Teste de regressão: rodar o comando acima com os três PDFs e o JSON de exemplo deve reproduzir o deck aprovado slide a slide (mesmos textos e mesmos números nos gráficos). Foi verificado assim na criação desta versão.

O que o modelo antigo do escritório (AGE 14/08/2025) mostrava e estes relatórios não trazem: saldo por conta (corrente, fundo de reserva, cada poupança), movimentação e resgate dos fundos, inadimplência, agenda de manutenções, certidões. Só incluir se Matheus enviar o relatório correspondente e pedir.
