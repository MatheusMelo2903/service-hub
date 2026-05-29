---
name: previsao-orcamentaria
description: Gera previsão orçamentária anual para condomínios em PowerPoint e PDF, com design premium navy + âmbar, narrativa executiva para assembleia de moradores e demonstração visual do impacto dos reajustes na taxa condominial. A skill é data-driven, lê a planilha e detecta automaticamente quais categorias e itens têm reajuste, gerando os slides de detalhamento dinamicamente. Aceita reajuste por percentual, valor anual absoluto ou valor mensal absoluto. Acionar SEMPRE que Matheus mencionar "previsão orçamentária", "orçamento anual do condomínio", "proposta de orçamento para 2026", "taxa condominial para o próximo ano", "reajuste da taxa", "apresentação de orçamento para assembleia" ou enviar uma planilha de previsão orçamentária pedindo para "transformar em apresentação", "fazer slides", "montar o material da assembleia de orçamento". Diferente da skill powerpoint-prestacao-contas (que retrospectiva o ano passado), esta skill projeta o ano futuro com base no realizado e nos reajustes aplicados.
---

# Previsão Orçamentária Condominial

Skill para gerar a apresentação anual de previsão orçamentária de condomínios da Virtual Service (V8S). Adaptada para projeção (não retrospectiva), com geração dinâmica de slides baseada nos reajustes que estão de fato aplicados na planilha do cliente.

## Quando usar

Apresentação de proposta de orçamento anual para assembleia de moradores. Demonstração do impacto dos reajustes na taxa condominial. Transparência sobre como a taxa foi calculada e onde foram aplicados aumentos. Qualquer material onde o cliente precisa entender quanto vai pagar a mais, por quê, e onde está o dinheiro.

Não usar para prestação de contas retrospectiva (usar `powerpoint-prestacao-contas`) ou relatório operacional mensal (usar `relatorio-acompanhamento`).

## Regra crítica sobre Fundo de Reserva

O fundo de reserva NÃO entra no rateio. Esta é a regra mais importante da skill.

A taxa condominial é calculada exclusivamente assim:

```
Taxa Apartamento = Despesa Operacional Prevista ÷ 12 meses ÷ Unidades Equivalentes
Taxa Cobertura  = Taxa Apartamento × Fator da Cobertura (geralmente 1,5)
```

O fundo de reserva existente do condomínio é uma reserva financeira já constituída que aparece na apresentação apenas como informação institucional ("reserva existente do condomínio, intocável, fora do rateio"). Nunca somar o fundo à despesa para depois ratear.

Detalhes em `references/regra-fundo-reserva.md`.

## Como a skill funciona

A skill é data-driven. Você passa a planilha do cliente e ela:

1. Lê a planilha (4 abas padrão)
2. Detecta automaticamente quais categorias têm reajuste (qualquer combinação, qualquer percentual, podendo vir de % de categoria, % por item, valor anual absoluto ou valor mensal absoluto)
3. Calcula taxas antes/depois usando a regra correta (sem fundo no rateio)
4. Gera a apresentação com slides de detalhamento para TODAS as categorias (com e sem reajuste), com layouts diferenciados

Não há hardcode de quantidade de reajustes. Pode ser zero, uma, oito, a skill se adapta.

## Como usar

```bash
python3 /mnt/skills/user/previsao-orcamentaria/scripts/gerar_previsao.py \
    /caminho/para/planilha.xlsx \
    [--condominio "Nome do Condomínio"] \
    [--output saida.pptx]
```

Depois converter para PDF com LibreOffice headless:

```bash
libreoffice --headless --convert-to pdf saida.pptx
```

## Formato esperado da planilha

A planilha tem 4 abas padrão da Virtual Service. Estrutura crítica da aba `Reajustes` (painel por item, linhas 24 a 71):

| Coluna | Conteúdo |
|--------|----------|
| B | Item |
| C | Categoria |
| D | Base Anual (fórmula que puxa de Previsao Anual) |
| E | Reajuste % do item (entrada do usuário) |
| F | Valor Anual 2026 absoluto (entrada do usuário) |
| G | Valor Mensal 2026 absoluto (entrada do usuário) |
| H | % Aplicado (calculado) |
| I | Valor Final Anual (calculado, é o que vai para Previsao Anual) |

Para cada item, o usuário preenche APENAS UMA das três entradas (E, F ou G). Prioridade: G > F > E > % da categoria (Reajustes!C11:C18).

Aba `Previsao Anual` puxa o resultado: coluna D (Reajuste %) vem de `Reajustes!H{linha}`, coluna E (Previsão 2026) vem de `Reajustes!I{linha}`, coluna F (Mensal) é `E/12`.

Aba `Resumo Assembleia` traz nome do condomínio, despesa total, fundo, apartamentos, coberturas, fator.

Categorias reconhecidas pela skill (allowlist em `ORDEM_CATEGORIAS_PADRAO`): Despesas Financeiras, Despesa com Funcionários, Despesa Administrativa, Consumo e Taxas, Manutenção, Aquisição de Materiais, Equipamentos, Serviços.

Para adicionar categoria nova: editar `ORDEM_CATEGORIAS_PADRAO`, `DESCRICOES_CATEGORIA` e `JUSTIFICATIVAS_CATEGORIA` em `scripts/gerar_previsao.py`. A skill já tem fallback genérico se a categoria nova não tiver descrição cadastrada.

## Estrutura gerada

A apresentação tem ordem fixa de 3 slides de abertura + N slides de detalhamento (variável) + 3 slides de fechamento:

| Slide | Conteúdo |
|-------|----------|
| 01 | Capa (navy, círculos decorativos, card de impacto) |
| 02 | Metodologia (4 cards numerados + fórmula sem fundo) |
| 03 | Panorama unificado 2025 vs 2026 (dois cards de total + tabela 5 colunas + card de insight) |
| 04 a N | Detalhamento COM reajuste (ordenado por peso decrescente, 4 colunas) |
| N+1 a M | Detalhamento SEM reajuste (ordenado por peso decrescente, 2 colunas, tag âmbar) |
| M+1 | Comparativo Antes x Depois |
| M+2 | Visão Geral (síntese executiva) |
| Último | Encerramento "Muito obrigado" (navy + logo grande, sem número) |

Sempre tem TODOS os 8 detalhamentos de categoria. Os COM reajuste têm 4 colunas (BASE 2025, MENSAL 2025, MENSAL 2026, PREVISTO 2026) e card âmbar de % aplicado. Os SEM reajuste têm 2 colunas (BASE 2025, MENSAL 2025) e tag "MANTIDO EM 2026 SEM REAJUSTE" no lugar do card de reajuste.

Detalhes slide a slide em `references/estrutura-slides.md`.

## Slides de detalhamento

### COM reajuste

Card navy esquerdo com nome, descrição, BASE 2025, PREVISTO 2026 e bloco "REAJUSTE APLICADO" com o % efetivo (média ponderada quando há itens com reajustes diferentes).

Tabela à direita com 4 colunas: ITEM, BASE 2025, MENSAL 2025, MENSAL 2026, PREVISTO 2026. Linhas ordenadas por valor previsto decrescente. Total âmbar no rodapé.

### SEM reajuste

Card navy esquerdo com nome, descrição, BASE 2025, MÉDIA MENSAL 2025 e tag âmbar "MANTIDO EM 2026 SEM REAJUSTE".

Tabela à direita com 2 colunas: ITEM, BASE 2025, MENSAL 2025. Mesma lógica de ordenação e total âmbar.

### Altura adaptativa da tabela (ambos os layouts)

| Itens | Altura linha | Tamanho fonte (com reajuste / sem reajuste) |
|-------|-------------|---------------------------------------------|
| ≤ 8 | 0,36" | 9,5pt / 10pt |
| 9-12 | 0,28" | 8,5pt / 9pt |
| 13-16 | 0,24" | 8pt / 8,5pt |
| 17+ | 0,20" | 7,5pt / 8pt |

Validado com Funcionários (15 itens) na tabela de 4 colunas.

## Reajustes flexíveis por item

O painel de Reajustes da planilha aceita 3 formatos de entrada por item, com prioridade Mensal > Anual > %:

- Coluna E: % do item (ex.: 0,15 para 15%). Sobrescreve a categoria.
- Coluna F: valor anual absoluto (ex.: 10000 fixa o item em R$ 10.000/ano).
- Coluna G: valor mensal absoluto (ex.: 300 fixa o item em R$ 300/mês = R$ 3.600/ano).

Se as três colunas estão vazias, o item herda o % da categoria (Reajustes!C11:C18).

Consequências para a apresentação:

- O % efetivo da categoria pode ser diferente do % nominal (média ponderada). Ex.: Funcionários com 7% nominal mas Vale Alimentação override 15% e Vale Transporte override 10% resulta em +8,26% efetivo. A skill mostra o efetivo no card lateral.
- Uma categoria pode ter % efetivo de +0,53% mesmo sem % de categoria definido, se algum item teve override. A skill detecta isso como "categoria com reajuste" e gera o slide de 4 colunas.
- Item com valor mensal/anual absoluto pode ter % aplicado enorme (ex.: Cartório R$ 58,11 → R$ 300,00 = +416%). Aparece corretamente na tabela.

## Princípios de design

Fundo branco nos slides internos, fundo navy escuro #0A1733 apenas em capa e encerramento. Tipografia Calibri em tudo, títulos 32pt bold navy + palavra de destaque em azul médio. Rodapé institucional em todos os slides internos: `PREVISÃO ORÇAMENTÁRIA 2026 • {CONDOMÍNIO} • VIRTUAL SERVICE`. Âmbar #E88B1A reservado para destaques-chave (impacto, KPIs principais, tags). Sem vermelho em despesas, paleta verde→azul→cinza. Nunca usar traços (—) em texto corrido (regra global da V8S). Números formato BR: R$ 1.234,56 (ponto milhar, vírgula decimal), percentuais 0,53%. Máximo 38pt em números grandes, 32pt em títulos. Encerramento navy escuro com logo Grupo Service centralizado grande (3,6" largura), "Muito obrigado" 60pt, tagline "Qualidade. Excelência. Transparência." 18pt.

## Princípios de conteúdo

Foco em transparência e justificativa do reajuste. Justificativas curtas e diretas (uma linha por categoria, vêm de `JUSTIFICATIVAS_CATEGORIA`). O insight do slide 3 (Panorama) é calculado dinamicamente: as 2 maiores categorias do orçamento e seu peso somado.

A ordem dos slides foi pensada para conduzir a assembleia: primeiro mostra como o cálculo é feito (Metodologia, slide 02), depois apresenta o panorama geral 2025 vs 2026 (slide 03) para o morador entender o quadro completo antes do detalhe, depois mergulha em cada categoria com reajuste, depois em cada categoria sem reajuste (para ficar claro que nem tudo subiu), e só no final mostra o comparativo das taxas e a síntese executiva, fechando com o "Muito obrigado".

## Entrega

Sempre entregar somente o PDF (não o PPTX) ao cliente. O PPTX é apenas etapa intermediária:

```bash
libreoffice --headless --convert-to pdf arquivo.pptx
```

E entregar via `present_files` apenas o `.pdf`.

## Erros a evitar

1. Somar fundo de reserva ao rateio. Fundo é informacional.
2. Inventar números. Se não está na planilha, perguntar.
3. Hardcodear categorias reajustadas. A skill é data-driven, não voltar atrás.
4. Usar fontes > 50pt em números, fica exagerado.
5. Entregar PPTX. Só PDF é entregue ao cliente.
6. Esquecer da regra de unidades equivalentes. Coberturas pagam mais via fator (1,5 padrão), então o cálculo é `apartamentos + (coberturas × fator)`.
7. Não validar somas. Sempre olhar o output do script (ele imprime base, previsto, taxas, lista de reajustes) antes de entregar.
8. Pular a leitura desta SKILL.md antes de gerar. Os erros acima já foram cometidos e custaram tempo.

## Validação antes de entregar

Após rodar o script, o terminal imprime:

```
Condomínio: Condomínio Foo
Base anual: R$ ...
Previsto:   R$ ...
Fundo:      R$ ... (5%)
Aptos: N | Coberturas: N | Fator: 1.5 | UE: ...
Taxa apto: R$ ... → R$ ... (+X,YZ%)
Categorias com reajuste: N
  • Cat A: +X,YZ% (R$ ... → R$ ...)
  • Cat B: +Y,WZ% (R$ ... → R$ ...)
  ...
```

Conferir esses números contra a planilha antes de gerar o PDF. Se houver divergência > R$ 1,00 entre a soma das categorias e o total previsto, o script imprime um AVISO em stderr.

## Arquivos da skill

- `scripts/gerar_previsao.py` — script principal data-driven, gera os 13 a 14 slides dependendo do cenário
- `references/regra-fundo-reserva.md` — explicação detalhada da regra mais importante
- `references/estrutura-slides.md` — descrição slide a slide com medidas e layout (v6)
- `references/exemplos-aprendizados.md` — aprendizados consolidados ao longo das iterações
- `assets/logo_service_white.png` — logo Grupo Service (a skill busca também em powerpoint-prestacao-contas como fallback)
