# Aprendizados e Iterações

Registro das iterações que levaram ao template atual. Útil pra evitar refazer erros.

## Iterações (v7 → v10)

### v7 — Base original (Gamma/manual)
- Design limpo com tipografia serifada nos títulos
- Cards horizontais com ícone + label + valor
- Rodapé institucional consistente
- **Problema:** estrutura resumida demais, sem detalhamento por categoria
- **Aprendizado:** o design visual era ótimo, vale preservar como DNA

### v8 — Primeira reconstrução
- Incorporadas melhorias da apresentação de referência: 5 KPIs na visão geral, linha de saldo acumulado no gráfico, médias mensais, slides de detalhamento
- **Problema:** cards de detalhamento muito carregados, gráficos confusos com múltiplas séries
- **Aprendizado:** densidade de informação ≠ riqueza de detalhe. Mais nem sempre é melhor.

### v9 — Enfatizando destaques
- Adicionado laranja âmbar como cor de destaque
- Faixa 121%/17,1% na visão geral, badge "+94,5%" no patrimônio
- Cores de categoria em gradiente quente→frio (vermelho a azul)
- **Problema:** vermelho e laranja nas categorias passavam mensagem negativa sobre gastos legítimos
- **Problema:** KPIs laterais (maior mês, menor mês, média) + faixa de análise = excesso de informação
- **Aprendizado:** categorias de despesa não devem ser vermelhas. "Gasto" ≠ "ruim".

### v10 — Versão final
- Detalhamentos voltaram ao template v7 (card esquerdo + tabela direita)
- Paleta de categorias mudou pra verde→azul→cinza
- Frase-ponte substituiu badge no patrimônio
- Slide novo "Superávit Mensal" adicionado
- Encerramento refeito com painel antes/depois, 2 linhas no gráfico (atual + ponto de partida tracejado), mini-gráfico de 2 barras verticais comparativas
- **Aprovado pelo usuário** como template definitivo

## Preferências do usuário (Matheus)

### Sempre
- Números em padrão brasileiro (vírgula decimal, ponto milhar)
- Percentuais com vírgula (17,1% não 17.1%)
- Conversão final pra PDF (WhatsApp quebra gráficos do PPTX)
- Fundo branco em slides internos
- Rodapé institucional presente

### Nunca
- Traços longos (—) em textos corridos, considera "cara de IA"
- Emoji sem ele pedir
- Vermelho como cor de categoria de despesa
- Badge decorativo competindo com título
- Texto zerado em tabelas de lançamento (filtrar meses sem movimento nas categorias menores)

## Decisões de estrutura (discutidas e validadas)

### Por que detalhamento misto (mês a mês + subcategoria)?
Discutimos: mês a mês em TUDO vira enxurrada de zeros e repetições. Subcategoria em TUDO perde a dimensão temporal. A solução é híbrida:
- **Pessoal**: mês a mês (1 item × 12 = estabilidade visual)
- **Consumo/Materiais/Serviços/Manutenção/Admin**: subcategoria (o gráfico à esquerda carrega o tempo)
- **Taxas/Financeiras/Retenções**: mês a mês filtrando zeros

### Por que superávit mensal ganhou slide próprio?
A v7 tinha esse slide e ele conta uma história importante: não basta olhar o superávit anual, tem que saber se a associação operou no azul na maioria dos meses. "8 de 12 meses positivos" comunica saúde operacional.

### Por que 2 linhas no gráfico final?
A linha única do saldo já era bonita, mas "+94,5%" é abstrato. Ao adicionar a linha tracejada na altura do saldo inicial, o crescimento fica **visual**: você vê o "gap" entre ponto de partida e ponto de chegada.

### Por que 2 barras verticais no canto superior direito do encerramento?
As linhas no gráfico mostram a jornada. As barras mostram o **delta**. São duas leituras complementares da mesma verdade: "dobrou".

## Armadilhas técnicas

### LibreOffice renderiza vírgula como ponto em thumbnails de baixa resolução
- No preview pequeno, "17,1%" pode parecer "17.1%". Não é bug do código, é render.
- No PowerPoint real e no PDF final, aparece corretamente com vírgula.
- **Verificar o XML do PPTX** se tiver dúvida: `unzip -p arquivo.pptx ppt/slides/slide2.xml | grep -oE '[0-9]+[,.][0-9]+%'`

### Gráficos perdem no WhatsApp se enviar PPTX
- Gráficos nativos são XML dinâmico, WhatsApp não renderiza.
- Converter sempre pra PDF antes de enviar.
- Comando: `libreoffice --headless --convert-to pdf arquivo.pptx`

### Row height adaptativo em tabelas
- Espaço disponível: ~4.30" (até o footer TOTAL reservado em 0.55")
- Calcular `line_h_emu = max((available - reserve) / n, 0.26")`
- Font size também adaptativo: ≤12 itens = 10/11pt, 13-16 = 9/10pt, 17+ = 8/9pt

### Aritmética com Emu
- `Inches(0.5).emu` retorna int. `Inches(0.5) - Inches(0.1)` funciona mas `(Inches(0.5) - 1000).emu` quebra.
- Melhor converter pra emu **uma vez** e fazer aritmética em int, depois voltar pra Emu: `Emu(int_value)`

## Validações obrigatórias antes de gerar

```python
# 1. Conservação de caixa
assert abs(SALDO_ANTERIOR + RECEITA_TOTAL - DESPESA_TOTAL - SALDO_FINAL) < 0.02

# 2. Soma das categorias de receita
assert abs(sum(v for _, v, _ in RECEITAS_CAT) - RECEITA_TOTAL) < 0.02

# 3. Soma das categorias de despesa
assert abs(sum(v for _, v, _ in DESPESAS_CAT) - DESPESA_TOTAL) < 0.02

# 4. Cada subcategoria bate com o total da categoria
# (ex: soma de Energia+Gás+Água+Internet == Consumo total)
```

Se alguma falhar: **parar, mostrar a inconsistência, não gerar**. Preferível perguntar a inventar.
