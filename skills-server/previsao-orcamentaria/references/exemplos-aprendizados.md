# Exemplos e aprendizados consolidados

Histórico de testes e descobertas ao longo das iterações da skill.

## Casos testados em produção

### Condomínio Praia Dourada (planilha real, 47 aptos + 3 coberturas)

**Versão 1 (out/2025)** — exemplo original que motivou a skill:
3 categorias reajustadas: Administrativa +5%, Materiais +8%, Financeiras +7%. Impacto +0,69%, taxa apto R$ 1.370 → R$ 1.380. Diff por apto R$ 9,41/mês.

**Versão 2 (mai/2026)** — planilha atualizada com 7% também em Funcionários:
3 categorias reajustadas: Funcionários +7%, Administrativa +5%, Materiais +8%. Impacto +3,64%, taxa apto R$ 1.370,74 → R$ 1.420,58. Diff por apto R$ 49,84/mês. Validação: 15 itens em Funcionários cabem na tabela com row_h adaptativo.

**Versão 3 (mai/2026)** — mesmo Praia Dourada, primeira validação do painel de reajustes com 3 modos de entrada:
Funcionários 7% na categoria + Vale Alimentação 15% (% override item) + Vale Transporte 10% (% override item). Administrativa sem % de categoria + Cartório R$ 300/ano (valor anual absoluto override item). Resultado: 2 categorias com reajuste efetivo. Funcionários +8,26% (média ponderada), Administrativa +0,53%. Total R$ 877.443,07. Taxa apto R$ 1.370,74 → R$ 1.419,81 (+3,58%). Validação: a média ponderada apareceu corretamente no card e o item Cartório foi para R$ 25,00/mês na tabela de 4 colunas, com R$ 300,00 anual.

### Cenário sintético: Teste Variado (sintetizado em mai/2026)

4 categorias reajustadas: Funcionários +5%, Manutenção +10%, Consumo +12%, Serviços +6%. 60 aptos + 4 coberturas (UE = 66). Impacto +6,72%, taxa apto R$ 1.069,59 → R$ 1.141,43.

### Cenário sintético: Sem Reajuste (sintetizado em mai/2026)

0 categorias reajustadas. Impacto 0%, taxa apto R$ 1.069,59 → R$ 1.069,59. Validação: capa exibe "Taxa condominial mantida". Validação: TODOS os 8 detalhamentos viram slides "sem reajuste" (2 colunas, tag âmbar) e nenhum slide "com reajuste" é gerado.

## Decisões de design da v6

### Ordem dos slides invertida em relação a v1 a v5

A v1 colocava Visão Geral logo no slide 02 (números antes do contexto). A v6 inverte: começa com Metodologia (slide 02) para explicar como o cálculo é feito, depois Panorama (slide 03) para o quadro geral, depois detalha cada categoria, e só no final fecha com Comparativo e Visão Geral. Funciona melhor para conduzir a assembleia: o morador vê primeiro como pensamos, depois o que decidimos.

### Detalhamento de TODAS as categorias, não só as reajustadas

Antes a skill só gerava detalhamento para categorias com reajuste. A v6 gera para todas, com layouts diferenciados:
- COM reajuste: 4 colunas (BASE 25 / MENSAL 25 / MENSAL 26 / PREVISTO 26), card de % aplicado
- SEM reajuste: 2 colunas (BASE 25 / MENSAL 25), tag âmbar "MANTIDO EM 2026 • SEM REAJUSTE"

Motivo: na assembleia o morador quer saber o que tem em CADA categoria, inclusive nas que não subiram. Isso evita pergunta tipo "e na Manutenção quanto a gente gasta?" depois.

### Painel de reajustes flexível (% / anual / mensal)

A planilha agora aceita 3 formatos de entrada por item:
- E: % do item (sobrescreve categoria)
- F: valor anual absoluto
- G: valor mensal absoluto

Prioridade G > F > E > % da categoria. Motivo: muitas vezes a definição não é "X% sobre o atual" mas "vamos contratar Y por mês" ou "vai custar Z por ano". A v6 acomoda os 3 modos sem dor.

Consequência boa: o % efetivo da categoria pode ser muito diferente do % nominal, e a skill calcula sempre como média ponderada `(soma_previstos - soma_bases) / soma_bases`. Isso aparece corretamente no card de reajuste.

Consequência boa: uma categoria pode ter % efetivo de 0,53% mesmo sem % de categoria definido, se um item específico tem override absoluto. A skill detecta como "com reajuste" e gera o slide de 4 colunas.

### Slide de encerramento simplificado

A v1 a v5 tinha um slide de encerramento com barras de comparação, 3 cards e tira inferior, repetindo informação que já estava no Comparativo e na Visão Geral. A v6 substitui por um slide institucional: navy escuro, logo grande, "Muito obrigado", tagline "Qualidade. Excelência. Transparência.". Função: fechar com impacto de marca, não com mais números.

## Bugs encontrados e corrigidos

### Bug 1: heurística de categoria pegava cabeçalhos como categoria

A versão inicial do parser tinha uma heurística que pegava strings como "PREVISÃO ANUAL 2026" e instruções de uso como categorias, gerando categorias-fantasma no contador.

Correção definitiva: usar allowlist `ORDEM_CATEGORIAS_PADRAO`. Se vier categoria nova no futuro, é melhor falhar e ser adicionada explicitamente do que ter heurística que captura lixo.

### Bug 2: precisão do reajuste % por categoria

Ao calcular `(soma_prev - soma_base) / soma_base`, valores como `0.07000000000006` apareciam por aritmética float, e o slide mostrava "+7,0000000001%".

Correção: arredondar para 4 casas decimais ao calcular, e o filtro de "tem reajuste" usa `abs(reajuste_pct) >= 0.0001` em vez de `> 0` para ignorar ruído.

### Bug 3: total da tabela podia sair do slide com 15+ itens

Com row_h fixa em 0,36", a tabela de Funcionários (15 itens) ultrapassava a altura útil do slide.

Correção: altura adaptativa (4 tamanhos de linha conforme n_itens) + guarda final que força o total a y=6,5" se ultrapassaria a borda.

### Bug 4: faixa âmbar do slide Comparativo cobria o footer

Posição original da faixa: y=6,85", altura 0,5". O footer padrão é em y=7,15", mas a faixa terminava em 7,35" e cobria.

Correção: faixa âmbar em y=6,7" com altura 0,35", e o footer deste slide específico é customizado em y=7,2".

### Bug 5 (v6): fórmulas antigas em F não eram apagadas ao reformular a planilha

Quando o gerador reformulou o painel de Reajustes (de 2 colunas para 8 colunas), a fórmula antiga na coluna F (`=IF(ISNUMBER(E{n}),E{n},IF(ISNUMBER(C{cat}),C{cat},0))`) continuou no arquivo porque `ws.cell(r, c, None)` não apaga uma célula que já tem fórmula. Resultado: F retornava o % da categoria, e a fórmula I (Valor Final) interpretava como valor anual, devolvendo 0,07 em vez de 154055,98.

Correção: usar `del ws._cells[(r, col)]` explicitamente antes de recriar a célula limpa.

### Bug 6 (v6): coluna anual da tabela do Panorama quebrando em 2 linhas

Na primeira versão do slide 03 da v6, os valores anuais como "R$ 394.253,48" não cabiam em uma coluna de 0,775" e quebravam em duas linhas no PDF.

Correção: tabela alargada para 5,43" e colunas anuais com 1,01" (vs 0,78" das mensais). Validado com todos os 8 totais.

## Princípios que ficaram

- Data-driven > hardcoded: nunca mais hardcodear "3 categorias reajustadas"
- Allowlist > heurística: para detecção de categoria, melhor lista explícita
- Adaptativo > fixo: altura de linha, layout do detalhamento, ordem dos slides
- Validação no terminal: o script imprime tudo que importa antes de salvar
- Mostrar tudo: detalhamento de TODAS as categorias, não só as reajustadas
- Cálculo sempre ponderado: % efetivo é `(soma_prev - soma_base) / soma_base`, nunca média simples dos %s dos itens
- Flexibilidade no input: 3 modos de reajuste por item (% / anual / mensal) com prioridade clara

## Possíveis evoluções futuras (não implementadas)

- **Destaque visual de item com override**: hoje a tabela mostra base/previsto sem destacar quando um item específico teve reajuste diferente da categoria. Podia colorir a linha em âmbar e mostrar o % específico ao lado.
- **Anomalias mensais**: se algum mês tem despesa muito acima da média (>2 desvios), incluir nota explicativa.
- **Cenários paralelos**: rodar o mesmo cálculo com 2 ou 3 cenários de reajuste (otimista / realista / conservador) e comparar.
- **Categorias customizadas**: caso algum condomínio traga categorias fora da lista padrão, pedir antes de rodar ("Identifiquei a categoria 'Foo' que não está na lista. Como devo descrevê-la?") em vez de só ignorar.
- **Distribuição mensal**: a v6 não tem mais o slide de gráfico de barras com os 12 meses. Se voltar a fazer sentido, está no histórico de versões anteriores e pode ser reintegrado.
