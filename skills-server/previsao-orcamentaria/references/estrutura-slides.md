# Estrutura dos slides (v6)

A apresentação tem 3 slides fixos de abertura + N slides de detalhamento (TODAS as 8 categorias, com layouts diferenciados conforme tenham ou não reajuste) + 3 slides fixos de fechamento. Total típico: 14 slides para um condomínio padrão de 8 categorias.

## Tamanho do slide

16:9, 13,333" × 7,5" (formato widescreen padrão PowerPoint).

## Paleta

- Fundo escuro: `#0A1733` (navy bem escuro, usado em capa e encerramento)
- Navy principal: `#143A87`
- Azul médio: `#2E7BC7`
- Âmbar: `#E88B1A` (reservado para destaques principais)
- Cinza fundo: `#F7F9FC` (cards claros nos slides internos)
- Cinza texto: `#3E5676`

## Tipografia

Calibri em tudo. Hierarquia:
- Título de slide: 32pt bold, navy + palavra-âncora em azul médio
- Números grandes: 22pt (cards de total) a 28pt (taxas)
- Labels: 9 a 10pt bold uppercase
- Corpo: 10 a 14pt
- "Muito obrigado" no encerramento: 60pt bold branco

## Ordem dos slides

```
01  Capa
02  Metodologia (abertura conceitual)
03  Panorama unificado 2025 vs 2026
04 a N      Detalhamento das categorias COM reajuste (peso decrescente)
N+1 a M     Detalhamento das categorias SEM reajuste (peso decrescente)
M+1 Comparativo Antes x Depois
M+2 Visão Geral (síntese executiva)
Último      Encerramento "Muito obrigado" (sem número)
```

Para o cenário Praia Dourada com 2 categorias reajustadas e 6 sem, o resultado é 14 slides (1 + 1 + 1 + 2 + 6 + 1 + 1 + 1).

## Slide 01 — Capa

Fundo navy escuro com 2 círculos decorativos no canto direito. Logo Grupo Service no canto superior direito. "PREVISÃO ORÇAMENTÁRIA" em azul pálido. "Condomínio" branco + nome do cliente em azul claro, 54pt. Linha âmbar curta + "Exercício 2026". Card âmbar-bordado embaixo: "IMPACTO NA TAXA CONDOMINIAL" + valor de diff_apto.

Variação do texto do card de impacto:

| Impacto | Texto exibido |
|---------|---------------|
| < 0,5% | "Taxa condominial mantida" |
| 0,5% a 1,5% | "Apenas +X,YZ% na taxa" |
| ≥ 1,5% | "Reajuste de +X,YZ% na taxa" |

## Slide 02 — Metodologia (abertura conceitual)

Header "02 METODOLOGIA". 4 cards numerados (3" × 2,6" cada): BASE / REAJUSTES / FUNDO DE RESERVA / RATEIO. Box navy inferior 1,5" altura com a fórmula do rateio. "N de M" no card de Reajustes vem da contagem real.

Esse slide vem cedo na apresentação para preparar a audiência: antes de mostrar números, explica como o cálculo é feito. Ajuda a antecipar a pergunta "por que essa taxa?" e mostra desde o início que o fundo de reserva NÃO entra na conta.

## Slide 03 — Panorama unificado 2025 vs 2026

Header "03 PANORAMA". Título "Quanto o condomínio paga hoje vs vai pagar em 2026".

Layout em 3 zonas:

- Topo esquerda: 2 cards de total lado a lado (3,35" × 1,5" cada). Cinza claro com R$ realizado 2025 e mensal médio 25. Navy com R$ previsto 2026 e mensal médio 26.
- Direita: tabela de 5 colunas. CATEGORIA, MENS 25, ANUAL 25, MENS 26, ANUAL 26. Cabeçalho navy, zebra cinza claro, linha total âmbar. 8 categorias ordenadas por peso decrescente.
- Esquerda inferior: card navy de insight (6,75" × 1,95") com as 2 maiores categorias e o peso somado.

## Slides 04 a N — Detalhamento COM reajuste

Um slide por categoria com reajuste efetivo (% efetivo ≥ 0,01%), ordenadas por peso decrescente. Cada slide tem:

Header "0X DETALHAMENTO" + nome da categoria como título. Subtítulo "Reajuste de X,YZ% aplicado nesta categoria".

Card navy esquerdo (3,8" × 4,5"):
- "CATEGORIA" âmbar + nome em branco 16pt
- Descrição em azul pálido (10pt)
- BASE 2025 (label) + valor 14pt branco
- PREVISTO 2026 (label âmbar) + valor 14pt branco
- "REAJUSTE APLICADO" (label âmbar) + % em 18pt âmbar + diff em parênteses

Tabela à direita (8,28" × variável) com 4 colunas:
- ITEM (3,0" largura)
- BASE 2025 (1,32")
- MENSAL 2025 (1,32")
- MENSAL 2026 (1,32", navy bold)
- PREVISTO 2026 (1,32", navy bold, cabeçalho âmbar)

Linhas ordenadas por valor previsto decrescente. Total âmbar no rodapé com 4 valores.

## Slides N+1 a M — Detalhamento SEM reajuste

Um slide por categoria SEM reajuste, ordenadas por peso decrescente. Mesmo template do detalhamento com reajuste, mas:

Subtítulo "Categoria mantida em 2026 com base no realizado de 2025".

Card navy esquerdo:
- Sem bloco PREVISTO 2026
- BASE 2025 + MÉDIA MENSAL 2025
- Tag âmbar inferior "MANTIDO EM 2026 • SEM REAJUSTE" (botão arredondado)

Tabela à direita com 2 colunas:
- ITEM (5,0" largura)
- BASE 2025 (1,6")
- MENSAL 2025 (1,6")

Linhas ordenadas por base decrescente. Total âmbar no rodapé com 2 valores.

## Altura adaptativa da tabela (ambos os layouts)

```python
n_itens ≤ 8   → row_h = 0,36"
n_itens ≤ 12  → row_h = 0,28"
n_itens ≤ 16  → row_h = 0,24"
n_itens > 16  → row_h = 0,20"
```

Fontes:
- COM reajuste (4 colunas): 9,5 / 8,5 / 8 / 7,5pt
- SEM reajuste (2 colunas): 10 / 9 / 8,5 / 8pt

Coordenadas críticas validadas:
- `card_h = 4,5"` (altura do card navy esquerdo)
- `tx = 4,55"`, `tw = 8,28"` (tabela à direita)
- Guarda final que força o total a y=6,5" se ultrapassaria a borda

## Slide M+1 — Comparativo Antes x Depois

2 cards grandes (6" × 3,9") lado a lado. Esquerda: cinza, "Situação Atual / Base realizada em 2025", com taxa apto e cobertura ANTES. Direita: navy escuro, "Previsão 2026 com reajustes", com taxa apto e cobertura DEPOIS. Faixa âmbar no rodapé (y=6,7", altura 0,35"): "IMPACTO POR APARTAMENTO +R$ X • IMPACTO POR COBERTURA +R$ Y". Rodapé customizado em y=7,2" (não usa `footer()` padrão, pra não bater com a faixa).

## Slide M+2 — Visão Geral (síntese executiva)

Header "0X VISÃO GERAL". 3 cards superiores (4" × 1,5" cada): Despesa Total / Fundo / Mensal Média. 2 cards de taxa (6,13" × 1,3"): Taxa Apto / Taxa Cobertura, em fundo claro. Faixa âmbar inferior 1" altura com 3 blocos: Impacto% / N de M categorias / Diff R$.

Aparece no fim porque consolida tudo numa síntese para o morador levar embora. É o "summary executivo" depois do detalhe.

## Slide final — Encerramento "Muito obrigado"

Fundo navy escuro com 2 círculos decorativos. Logo Grupo Service grande centralizado (3,6" largura, 1,18" altura) em y=1,3". Linha âmbar curta (1,5") centralizada em y=3,05". "Muito obrigado" centralizado em 60pt bold branco em y=3,35". Tagline "Qualidade. Excelência. Transparência." em 18pt azul claro em y=4,85". Subtítulos discretos:
- "Previsão Orçamentária 2026 • Condomínio X" 11pt azul pálido
- "Apresentação à Assembleia de Moradores" 10pt cinza

Sem rodapé numerado. Sem header. É o slide de fechamento institucional.

## Footer institucional

Todos os slides internos (02 a M+2) usam:

```
PREVISÃO ORÇAMENTÁRIA 2026 • {CONDOMÍNIO} • VIRTUAL SERVICE
```

Posição padrão: y=7,15", centralizado, fonte 9pt cinza. O slide M+1 (Comparativo) usa y=7,2" porque a faixa âmbar fica em y=6,7" e o footer padrão colidiria.

A capa e o encerramento NÃO têm footer (têm o logo Grupo Service em vez disso, com posicionamentos diferentes).
