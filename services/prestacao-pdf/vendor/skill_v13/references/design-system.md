# Design system v13 (fixo, implementado em scripts/gerador.py)

Pensado para projetor fraco em sala clara: fundo escuro, contraste alto, letra grande. Identidade Grupo Service em modo Impacto em todos os slides.

## Paleta

| Uso | Hex |
|---|---|
| Fundo de todos os slides (grafite profundo Grupo Service) | #262227 |
| Cartões | #332E34 |
| Cartão realce (faixa de atenção) | #3E383F |
| Linhas e grade de gráfico | #4F484F |
| Texto principal | #FFFFFF |
| Texto de apoio | #E4DFE3 |
| Rótulos | #B5ADB3 |
| Azul Grupo Service (barra da capa, linha sob título) | #2E8CBC |
| Azul claro Grupo Service (kicker, palavra de destaque do título) | #63ABCF |
| Destaque (faixa da visão geral, saldo final, patrimônio, avisos) | #4FD1F5 azul celeste |
| Superávit, receita, positivo | #3EE08F |
| Déficit, valor negativo | #FF7A7A |
| Texto sobre cor clara | #262227 |

Categorias e fontes de receita: escala gerada para N itens a partir de 3EE08F, 2DD4BF, 63ABCF, 2E8CBC, 5B8DEF, 8E9BF5, B3A8E0, BDB5BB. Vermelho nunca é cor de categoria. O laranja saiu em 20/10/2026 por quebrar a identidade.

## Tipografia

Poppins Bold em todo texto em negrito (títulos, números, nomes de rubrica, rótulos). Inter em texto corrido (composição, subtítulos, rodapé).

| Elemento | Tamanho |
|---|---|
| Título da capa | 54 |
| Título de slide | 34 (detalhamento 32) |
| Valores de KPI | 36, reduz sozinho até caber |
| Nome e valor da rubrica | 19 |
| Composição da rubrica | 15 |
| Barras de receita e despesa | 17 e 18 |
| Subtítulo e descrição | 16 a 17 |
| Rótulos de cartão, kicker, rodapé | 12 a 14 |

Valores longos (R$ 1.000.000,00 ou mais) usam `ajusta()`, que reduz o corpo só o necessário para caber no cartão.

## Logo
`assets/logo_gs_branca.png` (versão para fundo escuro, já recortada). Capa no canto superior esquerdo; rodapé de todo slide no canto inferior direito, ao lado do número da página. Nunca sobre azul.

## Formatação
R$ 1.234,56; percentuais com vírgula; negativos entre parênteses em listas de receita; sinal explícito em variação (+68,7%). Meses "Ago/25".

## Fontes no PDF
`montar.py` instala Poppins e Inter de `assets/fonts` se o sistema não tiver, e o PDF sai com as fontes embutidas. O PPTX só aparece igual em computador com as duas fontes; para projetar, usar o PDF.
