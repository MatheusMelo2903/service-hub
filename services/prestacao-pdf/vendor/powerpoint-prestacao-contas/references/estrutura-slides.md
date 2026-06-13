# Estrutura de Slides

Dimensões: 13.333 x 7.5 polegadas (16:9, slide_layouts[6] BLANK). Tudo gerado pelo `template_prestacao.py` a partir do CONFIG.

## Sequência (gerada dinamicamente)

| Ordem | Slide | Condição |
|-------|-------|----------|
| 1 | Capa | sempre |
| (opc) | Divisor de Bloco | se `blocos` não vazio |
| 2 | Visão Geral | sempre |
| 3 | Evolução Mensal | só se houver série mensal |
| 4 | Patrimônio | sempre (gráfico se mensal, barras antes/depois se não) |
| 5 | Superávit Mensal | só se houver série mensal |
| 6 | Origem da Receita | sempre |
| 7 | Estrutura de Despesas | sempre |
| 8..(7+K) | Detalhamentos | UM POR CATEGORIA (K categorias = K slides) |
| N | Encerramento | sempre |
| (opc) | Capa de Certidões | se `certidoes` não vazio |
| (opc) | Certidão 1..M | um por certidão |

## Regra de detalhamentos (crítica)

Um slide por categoria de despesa, na ordem do maior para o menor valor. 10 categorias = 10 slides, 20 = 20, 6 = 6. Nunca agrupar, cortar ou completar. As subcategorias/lançamentos dentro de cada slide também vêm do relatório, do maior para o menor.

## Card de detalhamento (esquerda)

Card navy 5.2 x 4.75: marca âmbar no topo, "TOTAL DO GRUPO", valor 34pt, "% DA DESPESA DO PERÍODO", linha azul, descrição 1-3 linhas, "DISTRIBUIÇÃO MENSAL" + mini-gráfico de barras brancas (só se houver série mensal). Sem série mensal, o card mostra só o resumo textual.

## Tabela de lançamentos (direita)

Cabeçalho navy "LANÇAMENTOS DO PERÍODO / VALOR", linhas com fundo alternado, altura adaptativa ao número de itens (≤12: 10/11pt; 13-16: 9/10pt; 17+: 8/9pt), faixa total navy na base.

## Nota de alerta âmbar (opcional por categoria)

Caixa clara abaixo do card quando um mês destoa da média ou há explicação relevante. Definida em `detalhes[categoria]["nota"]`. Antecipa perguntas da assembleia.

## Período sem série mensal

Quando o relatório for consolidado (W015A sem mês a mês), `receitas_mes`/`despesas_mes` ficam None:
- Evolução Mensal e Superávit Mensal são omitidos automaticamente.
- Patrimônio e Encerramento usam barras comparativas antes/depois (saldo inicial vs final) em vez de linha mensal.
- A faixa âmbar da Visão Geral troca o pilar "MESES POSITIVOS" por "SALDO EM CAIXA / +X%".
- Nunca fabricar série mensal. Se o relatório trouxer lançamentos datados, usar essas datas para distribuição real; onde não houver base, manter comparativo.

## Blocos

Quando o período tiver sub-períodos distintos, inserir divisores navy "BLOCO 01/02" com badge âmbar, título do sub-período e nota. Útil para anos de transição (ex: Maçonaria, com bloco de estruturação e bloco estabilizado).

## Certidões

Capa de seção navy + um slide por certidão: print do documento à esquerda, dados à direita (órgão, validade, identificação) e caixa verde de status. Imagens em `certidoes[i]["img"]`.
