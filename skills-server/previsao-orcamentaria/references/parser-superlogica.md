# Parser W011A / W045A do Superlógica

Documenta o `scripts/parser_superlogica.py` desta skill. Lê os relatórios PDF
do Superlógica, identifica o tipo pelo conteúdo, extrai os dados e gera a
planilha de previsão orçamentária no mesmo formato da referência
`skills-server/Previsao_Naturale_2026.xlsx`.

## Tipos de PDF que o parser lê

### W011A — Demonstrativo de Despesas (últimos 12 meses)

Estrutura esperada do PDF:

- Cabeçalho com nome do condomínio e período (formato `Mai/2025 a Abr/2026`).
- Lançamentos um por linha no formato `DD/MM/AAAA  Descrição  R$ 1.234,56`.
- Subtotais por categoria e total geral no rodapé.

O parser usa heurística regex para detectar lançamentos:

- Linha precisa ter uma data `DD/MM/AAAA` antes do valor.
- Valor precisa estar no padrão BR `1.234,56` (com vírgula decimal).
- A descrição é o trecho entre data e valor, sanitizada para tirar `R$` residual.

Subtotais e totais do próprio PDF são ignorados (não têm data).

### W045A — Fração Ideal

Estrutura esperada do PDF:

- Uma linha por unidade no formato `Apto 0101    0.004226` (a fração pode usar
  vírgula ou ponto decimal).
- Soma de todas as frações precisa fechar em `1.0 ± 0.001`.

Filtro de sanidade: frações entre `0.0001` e `0.5` por unidade. Acima disso
provavelmente é cabeçalho de tabela ou número avulso.

## Identificação automática

```python
from parser_superlogica import identificar_tipo_pdf
identificar_tipo_pdf('arquivo.pdf')   # 'W011A' | 'W045A' | 'DESCONHECIDO'
```

A identificação não depende do nome do arquivo. Procura nas 3 primeiras páginas
por marcadores textuais (`W011A`, `Demonstrativo de Despesas`, `Fração Ideal`,
etc). Atualizar `_MARCADORES_W011A` e `_MARCADORES_W045A` no topo do parser se
o Superlógica trocar o cabeçalho.

## Mapeamento de categorias

As 9 categorias canônicas são as mesmas da Onda 1 do gerador de prestação de
contas, garantindo consistência entre prestação de contas e previsão
orçamentária:

1. Despesas Financeiras
2. Despesa com Funcionários
3. Retenções Fiscais
4. Despesa Administrativa
5. Manutenção
6. Aquisição de Materiais
7. Serviços
8. Investimento e Equipamentos
9. Taxas e Recolhimentos

Cada item do W011A é mapeado para uma categoria via `CATEGORIA_KEYWORDS` (no
topo do parser). Match por substring lower case. Quando nenhum padrão casa, o
item cai em `Outros` e o parser emite warning no `stderr` listando a amostra
para o operador adicionar a chave faltante.

## Itens fora do rateio

Definidos em `PADROES_FORA_RATEIO`. Cobrem:

- Energia, Água, Telefone, Internet, Gás Individual: rateados por uso real,
  não pela taxa condominial padrão.
- Empréstimo Energia Solar: financiamento, dívida específica.
- Materiais Obras-Melhorias: obra extraordinária, fora do orçamento operacional.

Quando o parser detecta um desses padrões na descrição, o item vai para a aba
`Notas (Por Fora)` em vez da categoria normal.

## Fundo de Reserva

Default: 5% sobre o total operacional (`_FUNDO_RESERVA_PCT` no parser). Pode
ser ajustado por exercício editando a constante.

## Fator de Cobertura

Coberturas pagam taxa 1,5x maior que apartamentos padrão por convenção
(`_FATOR_COBERTURA`). O parser atual não distingue tipo de unidade no W045A —
todas viram apartamentos. Quando o Superlógica diferenciar, ajustar
`parsear_w045a`.

## Como rodar

### Identificar tipo

```bash
python3 parser_superlogica.py --identificar arquivo.pdf
# imprime: W011A, W045A ou DESCONHECIDO
```

### Gerar planilha completa

```bash
python3 parser_superlogica.py \
  --w011a w011a.pdf \
  --w045a w045a.pdf \
  --saida previsao_2026.xlsx
```

`--w045a` é opcional. Sem ele, o resumo usa modo "Igualdade" em vez de
"Fração Ideal", e a aba `Frações` fica só com cabeçalho.

### Gerar mock para teste

```bash
python3 gerar_mock_w011a.py --saida /tmp/mock_w011a.pdf
```

Cria um W011A com 5 categorias x 3 lançamentos cada, útil para validar o
parser sem precisar de PDF real do Superlógica.

## Estrutura do XLSX gerado

6 abas, no mesmo layout da `Previsao_Naturale_2026.xlsx`:

| Aba | Conteúdo |
|---|---|
| Reajustes | Painel de reajuste por categoria e por item. Operador edita os percentuais |
| Previsao Anual | Itens agrupados por categoria, com subtotais e total geral |
| Previsao Mensal | Mesma lista + 12 colunas mensais + total |
| Resumo Assembleia | Despesa operacional, fundo de reserva, total a ratear, modo de cálculo, taxa mensal por unidade, custo por categoria |
| Frações | Lista de unidades com fração e taxa mensal calculada |
| Notas (Por Fora) | Itens fora do rateio (Energia, Empréstimo, etc) |

## O que fazer quando o Superlógica mudar o layout

1. Rodar `identificar_tipo_pdf` no PDF novo. Se voltar `DESCONHECIDO`, atualizar
   os marcadores `_MARCADORES_W011A` ou `_MARCADORES_W045A` com a string nova
   que o Superlógica passou a usar no cabeçalho.
2. Rodar `parsear_w011a` no PDF novo e olhar o `stderr`. Se aparecer warning
   `N lançamentos não mapeados (amostra: ...)`, adicionar as palavras chave em
   `CATEGORIA_KEYWORDS`.
3. Se os totais não bateram com o PDF, conferir se o regex `_RE_VALOR_BRL`
   ainda casa com o formato dos valores (Superlógica pode trocar `R$ 1.234,56`
   por `1.234,56 BRL` ou similar).
4. Se a soma das frações do W045A não fechar em 1.0, conferir se o regex
   `_RE_FRACAO` continua casando com o formato e se o filtro de sanidade
   (`0.0001 <= fracao <= 0.5`) ainda faz sentido (ex: coberturas grandes podem
   ter fração maior).

## Limitações conhecidas

- O regex de fração não diferencia "Apto" de "Cobertura" no W045A. Todas as
  unidades viram apartamentos no resumo. Pra reativar coberturas, parsear a
  primeira coluna do W045A e classificar por palavra chave.
- Reajustes são gravados como valores fixos no XLSX, não como fórmulas que
  referenciam a aba `Reajustes`. Quando o operador edita o percentual na aba
  Reajustes, os outros valores não recalculam automaticamente. Solução
  pretendida: substituir os valores escritos em `_aba_previsao_anual` e
  `_aba_previsao_mensal` por fórmulas que olham a tabela de reajuste por item.
- Não trata moeda diferente de BRL nem PDFs com tabelas em coluna estrita
  (apenas extração de texto linha a linha).
