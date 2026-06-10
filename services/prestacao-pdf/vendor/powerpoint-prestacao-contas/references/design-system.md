# Design System (fixo para todo cliente)

## Paleta canônica

```python
C_BG_DARK    = RGBColor(0x0A, 0x17, 0x33)  # fundo capa/bloco/certidao/encerramento
C_NAVY_DEEP  = RGBColor(0x0A, 0x24, 0x63)
C_NAVY       = RGBColor(0x14, 0x3A, 0x87)   # titulos + card detalhamento
C_BLUE       = RGBColor(0x1E, 0x5A, 0xA8)
C_BLUE_MID   = RGBColor(0x2E, 0x7B, 0xC7)   # palavra de destaque no titulo
C_BLUE_LIGHT = RGBColor(0x52, 0x99, 0xDC)
C_BLUE_PALE  = RGBColor(0x7F, 0xB5, 0xE3)   # labels sobre fundo escuro
C_GRAY_TEXT  = RGBColor(0x3E, 0x56, 0x76)
C_GRAY_MUTED = RGBColor(0x8B, 0x9A, 0xB8)   # rodape
C_GRAY_BG    = RGBColor(0xF7, 0xF9, 0xFC)   # linha alternada
C_WHITE      = RGBColor(0xFF, 0xFF, 0xFF)
C_POSITIVE   = RGBColor(0x22, 0x8B, 0x54)   # superavit
C_NEGATIVE   = RGBColor(0xC0, 0x3B, 0x3B)   # so serie "Despesas" em grafico
C_AMBER      = RGBColor(0xE8, 0x8B, 0x1A)   # destaques-chave
C_AMBER_DEEP = RGBColor(0xC4, 0x6E, 0x0A)   # texto sobre ambar claro
C_AMBER_LIGHT= RGBColor(0xFD, 0xE9, 0xCC)   # faixa de insight / nota
```

## Categorias de despesa: cor dinâmica

A função `cat_colors(n)` gera N cores interpolando o gradiente verde→azul→cinza, para qualquer número de categorias. Maior peso recebe verde, menor recebe cinza. Nunca vermelho ou laranja em categoria de despesa.

## Tipografia

Calibri em tudo. Título de slide 34pt bold navy + palavra de destaque azul médio. Valor KPI 26-30pt. Número de destaque 38-50pt (nunca > 50pt). Labels 10-11pt. Corpo 11-13pt. Rodapé 9pt.

## Formatação BR

```python
fmt_brl(v)   -> "R$ 1.234,56"  (ponto milhar, vírgula decimal)
fmt_pct(v)   -> "17,1%"        (vírgula)
fmt_brl_int  -> "R$ 1.235"
```

## Regras fixas

1. Fundo escuro só em capa, bloco, certidão e encerramento. Internos sempre brancos.
2. Logo Grupo Service no canto superior direito da capa e capa de certidões.
3. Acentuação correta em todo texto. Calibri renderiza acentos no LibreOffice.
4. Rodapé institucional em todo slide interno: nome + (CNPJ se associação) + período.
5. Âmbar é recurso escasso: KPIs principais, crescimento, encerramento, badges de bloco.
6. Máximo 3 cores de destaque por slide.
7. Sem traço longo em texto corrido.
8. Frase-ponte no subtítulo no lugar de badge decorativo.
9. Mini-gráfico de distribuição só quando há série mensal real.
10. Linha tracejada de partida no encerramento via `prstDash val=dash`.
