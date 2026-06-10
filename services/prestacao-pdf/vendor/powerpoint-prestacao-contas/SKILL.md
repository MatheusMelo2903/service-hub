---
name: powerpoint-prestacao-contas
description: Cria apresentações de prestação de contas condominiais/associativas em PowerPoint, com design premium e narrativa executiva. Acionar sempre que Matheus mencionar prestação de contas, apresentação financeira de condomínio, balanço anual ou semestral, demonstrativo em assembleia, ou quando enviar um relatório W011A/W015A do Superlógica pedindo pra "transformar em apresentação", "fazer slides", "montar prestação". Também acionar quando ele pedir para "atualizar a prestação de contas", "refazer com novos números" ou mencionar qualquer cliente de condomínio ou associação precisando de apresentação da gestão financeira de um período.
---

# PowerPoint Prestação de Contas

Gera apresentações de prestação de contas de alta qualidade a partir de um relatório do Superlógica (W011A/W015A). O molde visual e a arquitetura de slides são FIXOS e definidos por duas referências aprovadas. Só os dados mudam de um cliente para outro.

## Referências de base (o molde, nunca muda)

Duas apresentações aprovadas definem o padrão definitivo de estrutura, arquitetura e estética:

1. **Condomínio Residencial Reserva Verde** (semestral, Out/2025 a Mar/2026) — fluxo padrão de período único.
2. **Associação Maçônica Cidade de Vitória** (Mai/2024 a Dez/2025) — fluxo com blocos de sub-período e seção de certidões negativas.

`references/referencias-aprovadas.md` descreve slide a slide as duas. Toda geração deve reproduzir essa mesma identidade visual, paleta, tipografia e sequência de slides. **A arquitetura e a estética não mudam jamais.** O que muda é apenas o conteúdo, extraído fielmente do relatório de cada cliente.

## Princípio central: data-driven com fidelidade extrema

- **Tudo vem do relatório.** Número de categorias, subcategorias, lançamentos, fontes de receita, meses, período, nome e rodapé saem do input. Nada é fixo no código.
- **Um slide de detalhamento por categoria de despesa, sempre.** 10 categorias no relatório = 10 slides. 20 = 20. 6 = 6. Sem agrupar, sem cortar, sem completar.
- **Fidelidade extrema.** O documento sai fiel ao relatório. Só pode ser modificado por instrução explícita do Matheus. Nunca inventar, estimar ou arredondar dado que não está no relatório.
- **Extração direta do Superlógica.** O fluxo assume que o Matheus envia o PDF/planilha (W011A/W015A) e a skill extrai tudo de lá.

## Fluxo obrigatório

### 1. Extrair os dados do relatório

Ler o W011A/W015A e extrair:
- **Nome e tipo do cliente** (condomínio ou associação) — capa e rodapé
- **Período** real (data inicial e final) e número de meses — calculado, nunca assumido
- **Saldo anterior** e **saldo final**
- **Receitas por categoria** com valores (todas as que existirem)
- **Despesas por categoria** com valores (todas as que existirem)
- **Subcategorias / lançamentos** de cada categoria de despesa
- **Série mensal** de receita e despesa, quando o relatório trouxer
- **CNPJ** quando for associação/entidade — rodapé
- **Certidões negativas** quando o cliente enviar os PDFs — seção opcional

### 2. Tratar a série mensal com fidelidade

- **Relatório com mês a mês (W011A detalhado):** reconstruir a série mensal fielmente, valor por valor. Os gráficos de evolução, superávit mensal e os mini-gráficos de distribuição usam esses números reais.
- **Relatório consolidado sem mês a mês (W015A consolidado):** derivar o comparativo a partir do que existe (saldo inicial, saldo final, totais), sem inventar valores mensais. Quando o relatório trouxer lançamentos datados (referências de competência, parcelas), usar essas datas para montar a distribuição real. Onde não houver base, manter visão comparativa (antes/depois) em vez de fabricar uma curva mensal. Em nenhuma hipótese inventar números só para preencher um gráfico.

### 3. Validar consistência

```
Saldo Anterior + Receita Total − Despesa Total == Saldo Final
Soma das categorias de receita == Receita Total
Soma das categorias de despesa == Despesa Total
Cada conjunto de subcategorias == total da sua categoria
```
Se qualquer uma falhar, parar e mostrar a inconsistência. Nunca completar dado ausente.

### 4. Gerar a apresentação

Usar `scripts/template_prestacao.py`. Todo o conteúdo vai num único bloco CONFIG no topo (dicionário Python), que é a única parte que muda por cliente. O corpo do script percorre as listas do CONFIG e gera quantos slides forem necessários: um por categoria de despesa, um por certidão, divisores por bloco. Ver `references/estrutura-slides.md` e `references/design-system.md`.

**Sequência fixa (o molde):**
1. Capa (navy, círculos, logo Grupo Service, período no subtítulo)
2. Visão Geral (5 KPIs + faixa âmbar com 3 pilares)
3. Evolução Mensal (receita x despesa + 3 médias) — só com série mensal real
4. Patrimônio (gráfico do saldo + crescimento + saldo inicial/final/superávit)
5. Superávit Mensal (barras + meses positivos + superávit) — só com série mensal real
6. Origem da Receita (total + lista de TODAS as fontes + faixa de insight)
7. Estrutura de Despesas (verde→azul→cinza, TODAS as categorias presentes)
8+. Detalhamentos — UM SLIDE POR CATEGORIA, sempre (card navy + tabela + mini-gráfico + nota âmbar opcional)
N. Encerramento "O período em números" (gráfico + linha de partida tracejada + mini-barras + cards)

**Blocos (quando o período tiver sub-períodos distintos):** inserir divisores ("BLOCO 01", "BLOCO 02") em navy e repetir visão geral + evolução por bloco. Padrão da Maçonaria.

**Certidões (quando o cliente enviar os PDFs):** capa de seção "Certidões Negativas" + um slide por certidão (print à esquerda, dados à direita). Padrão da Maçonaria.

### 5. Auditoria visual OBRIGATÓRIA (antes do PDF)

Depois de gerar o PPTX e ANTES de converter para PDF, rodar o auditor visual.
Pega texto saindo do slide, caixas sobrepostas (uma linha em cima da outra) e
cortes. Passo obrigatório — nunca entregar PDF sem auditoria limpa.

```bash
python3 /mnt/skills/user/powerpoint-prestacao-contas/scripts/auditar_apresentacao.py arquivo.pptx
```

- "AUDITORIA OK" → seguir para o PDF.
- Com problemas → NÃO entregar. Corrigir a causa no gerador (tabela com itens
  demais → reduzir altura/fonte ou paginar; texto longo → encurtar ou ampliar a
  caixa), regenerar e auditar de novo até zerar. Em dúvida, rasterizar o PDF e
  olhar o slide citado. O auditor é calibrado p/ baixo ruído (sobreposição só
  acima de ~35%; formas decorativas que saem da borda são ignoradas).

### 6. Converter pra PDF (só após auditoria limpa)

```bash
libreoffice --headless --convert-to pdf arquivo.pptx
```
O PDF é o que vai pro WhatsApp.

### 7. Entregar via present_files

PDF primeiro, PPTX depois.

## Princípios de design (fixos, valem para todo cliente)

- **Fundo branco** nos slides internos. **Navy #0A1733** só em capa, divisores de bloco, capa de certidões e encerramento.
- **Logo Grupo Service** no canto superior direito da capa e da capa de certidões. Arquivo em `assets/logo_service_white.png`.
- **Calibri.** Títulos 34pt bold navy + palavra de destaque em azul médio.
- **Acentuação correta** em todo texto. Não remover acentos do português.
- **Rodapé institucional** em todo slide interno: nome do cliente + período (e CNPJ quando associação).
- **Âmbar #E88B1A** só em destaques-chave. Máximo 3 cores de destaque por slide.
- **Sem vermelho em categoria de despesa.** Escala verde→azul→cinza, gerada dinamicamente para N categorias.
- **Sem traços longos (—) em texto corrido.**
- **Período e nome sempre dinâmicos.** Labels tipo "6 meses", "DO PERÍODO", "EXERCÍCIO OUT/2025 a MAR/2026" derivam do CONFIG.

## Princípios de conteúdo (fixos)

- **Um slide por categoria de despesa**, na ordem do maior para o menor valor.
- Dentro de cada detalhamento, listar as subcategorias/lançamentos reais daquela categoria, do maior para o menor.
- **Mini-gráfico de distribuição mensal** no card quando houver série mensal; sem ela, card só com resumo.
- **Nota de alerta âmbar** quando um mês destoa ou há explicação relevante (pico de água, parcela de IPTU, transferência registrada como despesa). Antecipa perguntas da assembleia.
- **Números BR**: R$ 1.234,56. Percentuais com vírgula.

## Arquivos de referência

- `scripts/template_prestacao.py` — Código data-driven via bloco CONFIG. Ponto de partida obrigatório.
- `assets/logo_service_white.png` — Logo Grupo Service.
- `references/referencias-aprovadas.md` — Descrição slide a slide das duas referências (o molde).
- `references/estrutura-slides.md` — Estrutura, blocos, certidões e tratamento sem série mensal.
- `references/design-system.md` — Paleta, tipografia, componentes, formatação BR.
- `references/exemplos-aprendizados.md` — Iterações, preferências e armadilhas técnicas.

## Erros a evitar

1. **Não mudar a arquitetura nem a estética.** O molde das duas referências é fixo.
2. **Não inventar dados.** Sem base no relatório, não fabricar.
3. **Não agrupar nem cortar categorias.** Um slide por categoria, sempre.
4. **Não remover acentos.**
5. **Não hardcodar período, nome ou número de categorias.** Tudo vem do CONFIG.
6. **Não usar badge competindo com o título.** Frase-ponte no subtítulo.
7. **Não usar fonte > 50pt em número.**
8. **Não mostrar lançamento zerado** em categoria de lançamento direto.
9. **Não esquecer de converter pra PDF.**
10. **Não usar vermelho/laranja como cor de categoria de despesa.**
