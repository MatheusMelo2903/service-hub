---
name: powerpoint-prestacao-contas
description: Cria apresentações de prestação de contas condominiais/associativas em PowerPoint, com design premium e narrativa executiva. Acionar sempre que Matheus mencionar prestação de contas, apresentação financeira de condomínio, balanço anual, demonstrativo em assembleia, ou quando enviar um relatório W011A/W015A do Superlógica pedindo pra "transformar em apresentação", "fazer slides", "montar prestação". Também acionar quando ele pedir para "atualizar a prestação de contas", "refazer com novos números" ou mencionar qualquer cliente de condomínio precisando de apresentação da gestão financeira anual.
---

# PowerPoint Prestação de Contas

Template e metodologia para gerar apresentações de prestação de contas de alta qualidade, com design premium, gráficos ricos e narrativa executiva. Refinado ao longo de múltiplas iterações com Matheus.

## Quando usar

- Prestação de contas anual de condomínios (Grupo Service, clientes externos)
- Balanço financeiro de associações maçônicas ou entidades sem fins lucrativos
- Apresentações executivas para assembleia a partir de demonstrativos do Superlógica (W011A/W015A)
- Qualquer demanda em que o input seja um PDF/planilha de receitas e despesas anuais e a saída precise ser um deck profissional

## Fluxo obrigatório

### 1. Coletar dados base

Pedir ou identificar no input:
- **Saldo anterior** (início do exercício)
- **Saldo final** (fim do exercício)
- **Receitas por categoria** com valores anuais
- **Despesas por categoria** com valores anuais
- **Receitas e despesas mês a mês** (12 meses)
- **Detalhamento por subcategoria** (ex: Consumo → Energia, Gás, Água, Internet) com valores mensais

O W011A do Superlógica contém todos esses dados. Se Matheus enviar esse PDF, extrair direto dele sem perguntar.

### 2. Validar consistência

Antes de gerar qualquer slide, rodar estas 3 validações:
```
Saldo Anterior + Receita Total − Despesa Total == Saldo Final
Soma das categorias de receita == Receita Total
Soma das categorias de despesa == Despesa Total
```
Se qualquer uma falhar, parar e mostrar a inconsistência pro usuário.

### 3. Gerar a apresentação

Usar o template em `scripts/template_prestacao.py` como base. Ver `references/estrutura-slides.md` para a estrutura completa e `references/design-system.md` para a paleta de cores e regras de formatação.

**Estrutura padrão de 17 slides:**
1. Capa (fundo escuro, círculos decorativos, título com palavra de destaque)
2. Visão Geral (5 KPIs + faixa laranja com 3 pilares: 121%, 17,1%, "quase dobrou")
3. Evolução Mensal (gráfico de 3 linhas + 3 cards de média mensal)
4. Patrimônio (gráfico do saldo + card "+X%" laranja + frase-ponte)
5. Superávit Mensal (barras + card "8 de 12 meses positivos" + superávit anual)
6. Origem da Receita (card esquerdo com total + lista lateral com 5 fontes)
7. Estrutura de Despesas (paleta verde→azul→cinza, maior peso = verde)
8–16. **Detalhamentos (9 slides)** — template v7: card azul escuro esquerdo + tabela direita
17. Encerramento "O ano em números" com 2 gráficos comparativos + tira antes/depois

### 4. Converter pra PDF

Sempre entregar PPTX **e** PDF usando LibreOffice headless:
```bash
libreoffice --headless --convert-to pdf arquivo.pptx
```
O PDF é o que vai pro WhatsApp — PPTX nativo perde os gráficos quando o WhatsApp usa preview interno.

### 5. Entregar via present_files

Sempre os dois arquivos (PDF primeiro, PPTX depois).

## Princípios de design (críticos)

- **Fundo branco** nos slides internos, **fundo azul marinho #0A1733** apenas em capa e encerramento
- **Tipografia:** Calibri, títulos 34pt bold navy + palavra de destaque em azul médio
- **Rodapé institucional** em TODOS os slides internos: "ASSOCIAÇÃO [NOME] • EXERCÍCIO [ANO]"
- **Laranja âmbar #E88B1A** é reservado para destaques-chave (crescimento, KPIs principais, encerramento). Não usar em tudo.
- **Sem vermelho em categorias de despesa** — isso passa mensagem de "gasto ruim" que não se aplica a gastos legítimos como Pessoal e Consumo. Usar escala verde→azul→cinza
- **Evitar sobrecarga de formatação** — nunca mais de 3 cores de destaque por slide
- **Evitar** bullets em prosa, preferir cards e tabelas
- **NUNCA usar traços (—)** em textos corridos. Matheus não gosta. Usar vírgulas ou frases separadas.

## Princípios de conteúdo

- **Preferir subcategorias agrupadas** para grupos com 3+ itens (Consumo, Materiais, Serviços, Manutenção, Admin). Gráfico mensal conta a história do tempo.
- **Preferir lançamento mês a mês** só para Pessoal (12 linhas, mostra estabilidade) e para grupos com 1-2 subcategorias (Taxas, Financeiras, Retenções).
- **Toda categoria tem mini-gráfico de distribuição mensal** dentro do card azul escuro à esquerda (barras brancas sobre fundo navy)
- **Números em padrão BR**: R$ 1.234,56 (ponto como separador de milhar, vírgula como decimal). Percentuais também com vírgula (17,1% e não 17.1%).

## Arquivos de referência

- `scripts/template_prestacao.py` — Código Python completo funcional para gerar a apresentação (ponto de partida, adaptar dados)
- `assets/logo_service_white.png` — Logo Grupo Service tratada (partes escuras em branco, azul preservado, fundo transparente). Inserida automaticamente no canto superior direito da capa.
- `references/estrutura-slides.md` — Descrição slide a slide com layout e medidas
- `references/design-system.md` — Paleta, tipografia, componentes reutilizáveis
- `references/exemplos-aprendizados.md` — O que funcionou e o que não funcionou ao longo das iterações

## Erros a evitar

1. **Não criar badges ou elementos decorativos no canto superior direito** competindo com o título do slide. Se quiser destacar algo, usar frase-ponte no subtítulo.
2. **Não usar fontes > 50pt em números** — parece exagerado. 32-48pt é o ponto certo.
3. **Não mostrar todos os lançamentos quando há zeros** — filtrar meses sem movimentação nas categorias de lançamento direto (Taxas, Financeiras, Retenções).
4. **Não esquecer de converter PPTX → PDF**. Matheus envia no WhatsApp, o PPTX quebra os gráficos nesse contexto.
5. **Não inventar números**. Se o dado não está no input, perguntar. Nunca estimar ou projetar.
