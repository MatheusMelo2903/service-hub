# TAREFA: T08 Alertas operacionais

## O que foi pedido
Pagamentos sem nota fiscal, manutenções periódicas atrasadas e consumo fora do padrão, usando a tabela de alertas da T05.

## O que foi feito
superlogica/alertas-operacionais.js, somado aos alertas da T05 na rota /api/condominio/:id/alertas (mesma tabela, mesmo painel do Dashboard, mesmo visto/resolvido). Só leitura no Superlógica.
1. Sem nota fiscal: despesas pagas no mês atual e nos dois anteriores (meses inteiros) sem arquivo com a etiqueta "Doc. Fiscal" (o despesas/index já traz os arquivos e etiquetas). Ficam de fora folha, encargos, impostos, tarifas e afins (lista SEM_NF no código). Um alerta por mês de pagamento, com o total e os maiores; se entrar pagamento novo sem nota no mesmo mês, o alerta volta.
2. Manutenção atrasada: último pagamento de dedetização (referência 6 meses), recarga de extintores (12 meses), limpeza de caixa d'água (6 meses) e manutenção de elevador (45 dias), com 15 dias de tolerância, no histórico de 19 meses (pela descrição da conta e complementos; o nome do fornecedor não conta). Sem nenhum pagamento no histórico, não alerta. O texto diz a referência usada e pede para conferir o contrato.
Os alertas operacionais têm teto de 25 s: se o histórico demorar (primeira abertura do dia), os alertas da T05 saem na hora e o histórico termina em segundo plano. O botão Atualizar relê o histórico.
3. Consumo fora do padrão: consumo/index (tipos de leitura 1 e 2). O Superlógica já devolve consumo do mês, média e variação. Alerta quando sobe 50% ou mais (e pelo menos 1 acima da média) ou cai 80% ou mais (com média de pelo menos 1).
Painel do Dashboard: rótulos Sem nota, Manutenção e Consumo, com o resumo vindo do servidor.

## Testes com dados reais
Casablanca 136: 3 alertas de pagamento sem nota (ago, set e out/2026; set com 19 pagamentos, R$ 17.159,96), nenhuma manutenção atrasada (dedetização 17/07/2026, caixa d'água 10/09/2026), sem leitura de consumo no Superlógica. Condomínio código 2: 5 unidades com consumo fora do padrão (ex.: unidade 037, +2692%), 1 mês sem nota. Lógica de manutenção testada também com dados montados (dedetização e extintor atrasados aparecem; elevador em dia não; empresa de dedetização prestando outro serviço não conta).

## Pontos a confirmar pelo Matheus [a confirmar]
1. Nome dos tipos de leitura 1 e 2 (água e gás?): aparecem como "leitura tipo 1/2".
2. Prazos de referência das manutenções (6, 12, 6 meses e 45 dias).
3. Contas de água, luz e telefone pagas sem a fatura anexada como "Doc. Fiscal" entram no alerta de nota fiscal (hoje entram).

## O que validar
Dashboard do Casablanca e do condomínio 2: conferir os alertas novos e marcar visto/resolvido.
