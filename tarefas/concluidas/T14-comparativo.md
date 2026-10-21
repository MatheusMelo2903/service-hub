# TAREFA: T14 Comparativo entre condomínios

## O que foi pedido
Comparativo entre condomínios: custo por unidade (água, energia, pessoal) e preço pago por fornecedor.

## O que foi feito
Aba nova "Comparativo" (menu Gestão), JS em public/comparativo.js, servidor em superlogica/comparativo.js. Só leitura.
1. Escolha: meus condomínios (já filtrados pela carteira, T09) ou, para o GESTOR, qualquer carteira do Superlógica. Acima de 30 condomínios pede confirmação.
2. Custo por unidade por mês nos últimos 12 meses fechados: despesa total, pessoal (categoria de pessoal do plano de contas), água e esgoto, energia e gás (contas da categoria de consumo). Um balancete do período inteiro por condomínio (uma chamada) e a quantidade de unidades. Em vermelho os 25% mais caros de cada coluna, em verde os 25% mais baratos.
3. Fornecedores em comum: o mesmo fornecedor (CNPJ, ou nome quando não há CNPJ) pago em dois ou mais condomínios carregados, com média por mês e por unidade em cada um (até 20 condomínios).
Categoria de consumo achada pelas contas de água, energia e gás (não só pelo nome); quando o plano de contas não tem a categoria, a tela diz "não identificado" em vez de "sem". Fornecedores: parcelas repetidas contam uma vez; pessoa física, folha e tributos ficam de fora.
Rotas GET /api/comparativo/condominio/:id e .../fornecedores, cache de 6 horas, mesma regra de acesso e de carteira da cobrança.

## Testes com dados reais (out/2025 a set/2026)
Casablanca 136: 192 unidades, R$ 391,89 por unidade por mês; pessoal R$ 156,13; água R$ 40,04; energia R$ 6,08. Aldeia Manguinhos (2): 63 unidades, R$ 1.348,59; pessoal R$ 418,37; água R$ 176,83; energia R$ 42,86; gás R$ 41,43. Fornecedores lidos (68 e 93). Residencial Teste 167 sem despesas no período.

## Observação
Energia Solar do Casablanca está na categoria de investimento (financiamento), então não entra em energia. Água vem da conta "Esgoto" no Casablanca e "Água-Esgoto" no Aldeia: o filtro pega os dois.

## O que o Matheus precisa validar
Carregar uma carteira e conferir um ou dois condomínios com o balancete do Superlógica; comparar fornecedores.
