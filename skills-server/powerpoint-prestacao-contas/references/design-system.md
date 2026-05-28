# Design System

## Paleta de cores (canônica)

```python
C_BG_DARK    = RGBColor(0x0A, 0x17, 0x33)  # fundo capa/encerramento
C_NAVY_DEEP  = RGBColor(0x0A, 0x24, 0x63)  # azul profundo
C_NAVY       = RGBColor(0x14, 0x3A, 0x87)  # azul títulos + card detalhamento
C_BLUE       = RGBColor(0x1E, 0x5A, 0xA8)  # azul cards
C_BLUE_MID   = RGBColor(0x2E, 0x7B, 0xC7)  # azul médio destaque
C_BLUE_LIGHT = RGBColor(0x52, 0x99, 0xDC)  # azul claro
C_BLUE_PALE  = RGBColor(0x7F, 0xB5, 0xE3)  # azul pálido labels
C_GRAY_TEXT  = RGBColor(0x3E, 0x56, 0x76)  # cinza texto corpo
C_GRAY_MUTED = RGBColor(0x8B, 0x9A, 0xB8)  # cinza legendas
C_GRAY_BG    = RGBColor(0xF7, 0xF9, 0xFC)  # cinza fundo alternado
C_GRAY_LINE  = RGBColor(0xE2, 0xE8, 0xF0)  # linhas divisórias
C_WHITE      = RGBColor(0xFF, 0xFF, 0xFF)
C_POSITIVE   = RGBColor(0x22, 0x8B, 0x54)  # verde superávit
C_NEGATIVE   = RGBColor(0xC0, 0x3B, 0x3B)  # vermelho (APENAS para série de despesas em gráfico)

# Destaque
C_AMBER       = RGBColor(0xE8, 0x8B, 0x1A)  # laranja principal (KPIs, encerramento)
C_AMBER_DEEP  = RGBColor(0xC4, 0x6E, 0x0A)  # texto sobre fundo âmbar claro
C_AMBER_LIGHT = RGBColor(0xFD, 0xE9, 0xCC)  # faixa de insight
```

## Paleta categórica (Estrutura de Despesas)

Ordem por peso (maior → menor), evitando cores quentes agressivas:
```python
CAT_COLORS = [
    RGBColor(0x1E, 0x73, 0x4A),  # verde escuro - Pessoal
    RGBColor(0x35, 0x9E, 0x66),  # verde médio - Consumo
    RGBColor(0x14, 0x3A, 0x87),  # navy - Administrativo
    RGBColor(0x1E, 0x5A, 0xA8),  # azul - Taxas
    RGBColor(0x2E, 0x7B, 0xC7),  # azul médio - Materiais
    RGBColor(0x52, 0x99, 0xDC),  # azul claro - Serviços
    RGBColor(0x5B, 0x6A, 0x88),  # cinza-azul escuro - Manutenção
    RGBColor(0x7F, 0x8F, 0xA8),  # cinza-azul - Financeiras
    RGBColor(0xA5, 0xB0, 0xC2),  # cinza claro - Retenções
]
```

## Tipografia

- Fonte única: **Calibri** (compatível com Windows/Mac/LibreOffice)
- Hierarquia:
  - Título de slide: 34pt bold, navy + palavra de destaque azul médio
  - Valor KPI grande: 26-30pt bold branco
  - Números de destaque central: 48-50pt bold
  - Label de card: 10-11pt bold (tom pálido sobre fundo escuro)
  - Corpo texto: 11-13pt regular
  - Rodapé: 9pt
  - Legenda eixo gráfico: 9pt

## Espaçamentos

- Margem lateral padrão: 0.5"
- Gap entre cards: 0.2"
- Card default: canto arredondado 0.08
- Faixas de destaque: canto arredondado 0.15-0.2
- Card de detalhamento: canto arredondado 0.04 (mais retangular, mais institucional)

## Componentes reutilizáveis

### Header de slide
```python
def add_slide_header(slide, number, section, title_main, title_accent=None, subtitle=None):
    # "01    VISÃO GERAL" em azul pálido
    # Linha curta horizontal azul médio abaixo
    # Título grande: title_main em navy + title_accent em azul médio
    # subtitle opcional em 14pt cinza escuro
```

### Rodapé institucional
```python
def add_footer(slide):
    # "ASSOCIAÇÃO [NOME] • EXERCÍCIO [ANO]" em 9pt cinza pálido, centralizado
    # Deve aparecer em TODOS os slides internos (não na capa nem encerramento)
```

### KPI Card
Padrão: retângulo arredondado colorido com:
- Label em caps 10pt bold cor branca/pálida (top 0.18-0.20")
- Valor grande 26-30pt bold branco (top 0.5-0.55")
- Subtexto 11pt pálido (top ~1.2")

## Regras de formatação BR

```python
def fmt_brl(v):
    # R$ 1.234,56 (ponto como milhar, vírgula como decimal)
    s = f"{v:,.2f}"
    return "R$ " + s.replace(",", "X").replace(".", ",").replace("X", ".")

def fmt_pct(v):
    # 17,1% (vírgula, não ponto)
    return f"{v:.1f}".replace(".", ",") + "%"
```

## Gráficos — estilização padrão

### Eixos
- Font: Calibri 9pt cor `C_GRAY_TEXT`
- Para temas escuros (slide final): trocar cor do tick label pra `C_BLUE_PALE`

### Séries
- Linha de Receitas: `C_POSITIVE` (verde), 2.5pt
- Linha de Despesas: `C_NEGATIVE` (vermelho), 2.5pt
- Linha de Saldo: `C_BLUE_MID` ou `C_AMBER` no encerramento, 2.5-4pt
- Barras de Superávit: `C_BLUE`
- Barras de Distribuição Mensal (no card detalhamento): `C_WHITE` sobre fundo navy

### Legenda
- Posição padrão: TOP
- Font: Calibri 11pt
- Em gráficos com muitas séries ou espaço apertado: BOTTOM
- Em gráficos com só 1 série: desligar legenda

### Como aplicar linha tracejada
```python
from pptx.oxml.ns import qn
spPr = series.format.line._get_or_add_ln()
prstDash = spPr.find(qn('a:prstDash'))
if prstDash is None:
    prstDash = spPr.makeelement(qn('a:prstDash'), {'val': 'dash'})
    spPr.append(prstDash)
else:
    prstDash.set('val', 'dash')
```

## Decisões de design aprendidas (regras)

1. **Fundo escuro apenas em 2 momentos:** capa e encerramento. Slides internos sempre brancos — legibilidade em projeção de sala.
2. **Laranja é um recurso escasso.** Só nos destaques principais (KPIs da visão geral, card +94,5%, frase de encerramento). Em tudo virou ruído visual.
3. **Vermelho é proibido em categorias de despesa.** Só aparece como linha de "Despesas" no gráfico de evolução mensal (contexto neutro).
4. **Frase-ponte > badge decorativo.** No lugar de caixinhas decoradas no canto, usar o subtítulo do slide pra introduzir o destaque ("O destaque do ano foi... [card com +94,5%]").
5. **3 é o limite de destaques por slide.** Mais que isso, hierarquia se perde.
6. **Mini-gráfico nos cards de detalhamento** é obrigatório — carrega a dimensão temporal que a lista estática não mostra.
