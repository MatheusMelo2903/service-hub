---
name: powerpoint-prestacao-contas
description: Cria a apresentação de prestação de contas de condomínio ou associação (PDF e PowerPoint) no padrão aprovado do Grupo Service, fundo grafite, letras grandes para projetor e cada despesa detalhada item a item. Acionar sempre que Matheus mencionar prestação de contas, apresentação financeira, balanço do período, demonstrativo para assembleia, ou enviar relatórios do Superlógica (W011A, W015A) pedindo para montar, gerar, refazer ou atualizar a prestação de qualquer condomínio.
---

# Prestação de Contas (padrão v13, aprovado em 20/10/2026)

Gera a prestação de contas a partir dos relatórios do Superlógica. O visual, as fontes, os tamanhos, as cores e a sequência de slides são FIXOS e moram no código (`scripts/gerador.py`). De um condomínio para outro muda só o conteúdo, que sai inteiro dos relatórios. Não existe outro molde: toda prestação sai neste.

Referência aprovada: Condomínio Buritis, Ago/2025 a Set/2026, 35 slides (`references/referencia-aprovada.md` e `references/exemplo_composicao_buritis.json`).

## Dois modos, decididos pelos arquivos recebidos

| Arquivos recebidos | Modo | O que sai |
|---|---|---|
| Só W011A padrão (rubricas mês a mês) | SIMPLES | Mesmo visual. Cada categoria com suas rubricas e valores, sem abrir os itens |
| W011A padrão + relatório detalhado (W015A comparativo ou W011A "Detalhado") | DETALHADO | Mesmo visual. Cada rubrica aberta com o que foi gasto, igual ao detalhado |

O script decide sozinho e informa o modo. A maior parte das prestações virá no modo detalhado, mas o simples continua valendo quando só houver o W011A padrão. Nunca inventar detalhamento sem relatório detalhado.

## Fluxo obrigatório

### 1. Período e arquivos
Período = o que Matheus disser (ex.: "agosto de 2025 até setembro de 2026"). Sem indicação, usar os meses do W011A. O W011A é obrigatório: é dele que sai a série mês a mês. Período maior que 12 meses precisa de mais de um W011A (ex.: um começando em Ago/2025 e outro em Out/2025); o script junta e confere os meses repetidos.

### 2. Extrair e cruzar
```bash
S=<pasta da skill>/scripts
python3 $S/extrair.py --inicio 2025-08 --fim 2026-09 --saida dados.json --rascunho rascunho.json arquivo1.pdf arquivo2.pdf ...
```
O script identifica cada relatório, junta os meses, recorta o período, confere receitas, despesas e saldos e, no modo detalhado, liga cada item à sua rubrica. Ele para com erro quando algo não fecha.

- "Faltam meses no W011A": pedir a Matheus o W011A que cubra esses meses. Nunca fabricar mês.
- Itens: a fonte ideal é o W015A cuja primeira coluna é exatamente o período (`w015a_exato`) ou um W011A detalhado que cubra o período inteiro. Se só houver W015A com coluna maior que o período, o script tenta separar o que caiu fora (`w015a_janela`) e lista as rubricas sem conciliação exata. Nesse caso, pedir o W015A com as datas exatas do período antes de seguir; se não for possível, tratar essas rubricas com cuidado na curadoria.

### 3. Curadoria da composição (modo detalhado)
Copiar `rascunho.json` para `composicao.json` e reescrever o texto de cada rubrica seguindo `references/composicao.md` (leitura obrigatória). O rascunho já traz os itens de cada rubrica com valor e sempre fecha com o total; a curadoria deixa legível para o morador: junta parcelas, corrige grafia, troca abreviações e resume compras repetidas. Usar o exemplo do Buritis como régua de estilo. No modo simples, `composicao.json` só precisa do bloco `cliente`.

Estrutura de `composicao.json` em `references/fluxo-e-arquivos.md`.

### 4. Montar, auditar e converter
```bash
python3 $S/montar.py dados.json composicao.json --saida "Nome - Prestação de Contas MMMAA a MMMAA.pptx" --pdf
```
Gera o PPTX, roda a auditoria visual e só converte para PDF com auditoria limpa. Valida de novo: soma das rubricas, saldos e, quando a composição cita valores (`"fecha": true`), que a soma deles bate com o total da rubrica.

### 5. Conferência visual
Rasterizar o PDF e olhar capa, visão geral, dois detalhamentos e encerramento antes de entregar.

### 6. Entrega
PDF primeiro (é o que vai para projetor e WhatsApp, já leva as fontes), PPTX depois. Na conversa: tabela curta com saldo inicial, receitas, despesas, resultado e saldo final, e uma linha sobre meses negativos ou ponto de atenção.

## O que é fixo (garantia do padrão)

Tudo abaixo está no código e não muda por condomínio. Detalhes em `references/design-system.md` e `references/estrutura-slides.md`.

- Identidade Grupo Service em modo escuro: fundo grafite `#262227`, logo branca do grupo na capa e no rodapé de todo slide, barra azul `#2E8CBC` no topo da capa e do encerramento.
- Destaque em azul celeste `#4FD1F5` (substituiu o laranja). Verde `#3EE08F` para superávit, vermelho só para resultado negativo. Categorias em escala verde, turquesa, azuis e lilás.
- Poppins nos títulos e números, Inter no texto. Conteúdo com no mínimo 15pt; só rótulos pequenos e rodapé ficam entre 12 e 14pt.
- Sequência: capa, visão geral, evolução mensal, patrimônio, resultado mensal, origem da receita, todas as fontes de receita, estrutura de despesas, um detalhamento por categoria (paginado), encerramento.
- Detalhamento: cada rubrica em cartão com nome e valor; composição embaixo; rubricas curtas lado a lado; total da categoria na última página.

Nunca editar paleta, fontes, tamanhos ou geometria em `gerador.py` para um cliente específico. Mudança de padrão só com pedido explícito de Matheus, e aí vale para todos.

## Regras de conteúdo

- Tudo vem dos relatórios. Nunca inventar, estimar ou arredondar valor.
- Uma categoria por detalhamento, da maior para a menor; rubricas da maior para a menor; nenhuma rubrica cortada ou agrupada em "outros".
- Rótulos seguem o sinal: superávit ou déficit, caixa cresceu ou caixa encerrou em.
- Sem hífen ou travessão em nenhum texto gerado.
- Grupo Service nunca aparece ligado à Virtual Service.

## Arquivos

- `scripts/extrair.py`: lê W011A padrão, W011A detalhado e W015A; junta, recorta, cruza e valida.
- `scripts/montar.py`: lê dados e composição, aplica padrões de categoria, gera, audita e converte.
- `scripts/gerador.py`: o molde visual. Não editar por cliente.
- `scripts/auditar_apresentacao.py`: auditoria de sobreposição e texto saindo do slide.
- `assets/logo_gs_branca.png`, `assets/fonts/`: logo e fontes da marca (instaladas automaticamente para o PDF).
- `references/composicao.md`: como escrever a composição de cada rubrica.
- `references/fluxo-e-arquivos.md`: formatos de `dados.json` e `composicao.json`.
- `references/design-system.md`, `references/estrutura-slides.md`: o padrão visual.
- `references/referencia-aprovada.md`, `references/exemplo_composicao_buritis.json`: o deck aprovado e sua curadoria.
- `references/aprendizados.md`: decisões travadas e armadilhas.
