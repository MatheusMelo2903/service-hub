# T13 Relatório mensal do síndico em PDF (20/10/2026)

## O que foi feito

1. Rota GET /api/condominio/:id/relatorio-mensal?mes=AAAA-MM (padrão: último mês fechado). Só leitura no Superlógica, mesma regra de acesso da Ficha. Junta: saldo do caixa no início e no fim do mês (caixa/index), receitas por conta e despesas por grupo e conta do mês (balancetes/index, o mesmo demonstrativo da prestação), saldo por conta hoje, inadimplência hoje (10 maiores débitos, só unidade e valor), contas a pagar em 30 dias, vencidas não pagas e alertas em aberto da T05 (os marcados como resolvidos ficam de fora). Cada parte falha sozinha e sai como "não disponível"; nada é estimado. Cache de 10 minutos.
2. Card "Relatório mensal do síndico (PDF)" no topo da Ficha do Condomínio, com o mês e "Baixar PDF". O PDF é montado no navegador (jsPDF com a fonte Arimo da ata, acentos corretos), A4, com cabeçalho do cadastro (nome, CNPJ, síndico, endereço) e numeração de páginas.

## Testes

scripts/relatorio-harness.mjs 10/10 (inclui janeiro e mês em andamento) com o Casablanca, setembro de 2026: soma das receitas e dos grupos de despesa bate com os totais do Superlógica, e saldo inicial + receitas menos despesas = saldo final (R$ 272.330,56). Sem CPF nem chave no JSON. PDF conferido no Chrome do dev (ver diário).
