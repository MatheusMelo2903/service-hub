---
titulo: Painel Condominios v1 (arquivado)
status: arquivado
data_arquivamento: 2026-05-03
ultima_localizacao: public/index.html linhas 1231 a 1423 (HTML) e 4291 a 5343 (JS), commit main 014d72f
---

# Painel Condominios v1 (arquivado)

## Estrutura geral

Painel acessivel pela sidebar principal (item Condominios). Layout em duas colunas:

1. Sidebar interna a esquerda (240px) com a lista de condominios cadastrados, renderizada por `cpRenderSidebar`.
2. Area principal a direita com:
   * Topbar com nome do condominio ativo, sindico (tag), data e botao "Gerar Apresentacao".
   * Barra de abas com 10 botoes (`cp-tabs-bar`).
   * Container `cp-content` que recebe o HTML da aba ativa.

Estilo isolado por prefixo `cp-*` (cerca de 100 regras CSS injetadas dentro do proprio painel).

Estado em memoria mantido em `cpCondominios` (array global) e `cpCondAtivo` (string com id atual). Persistencia via Supabase nas tabelas `condominios`, `demandas`, `laudos`, `historico`. Funcoes de carregamento: `cpCarregarDoSupabase`, `cpSeedParaSupabase`, `cpSalvar`.

## Os 10 botoes da barra de abas

A `cp-tabs-bar` tem 10 botoes. Oito sao abas reais renderizadas por `cpShowTab`. Dois sao botoes de atalho que abrem janela nova (`window.open`) com relatorio HTML pronto para impressao.

### 1. Visao Geral (`cpShowTab('visao')`, render `cpRenderVisao`)

Mostra:
* 4 cards de estatisticas: Pendentes, Em Andamento, Concluidas, Laudos.
* Barra de progresso geral do plano de acao em porcentagem.
* Tabela "Resumo das Prioridades" (numero, demanda, prioridade, status, responsavel).
* Tabela "Laudos Tecnicos" (laudo, status, enviado ao sindico).

### 2. Prioridades (`cpShowTab('prioridades')`, render `cpRenderDemGrid`)

Mostra apenas o array `c.prioridades` como cards verticais. Cada card tem cabecalho expansivel com titulo, situacao, badges de prioridade e status, prazo e responsavel. Ao expandir mostra Acao Definida, Metrica de Conclusao, dropdown para mudar status, botoes para anexar foto Antes/Depois e galeria das fotos anexadas.

### 3. Demandas (`cpShowTab('demandas')`, render `cpRenderDemGrid`)

Mesmo render que Prioridades, mas usa o array `c.demandas` em vez de `c.prioridades`. Subtitulo cita data de criacao do condominio.

### 4. Laudos (`cpShowTab('laudos')`, render `cpRenderLaudos`)

Lista vertical de cartoes de laudos tecnicos. Cada cartao mostra:
* Nome do laudo, status, indicador de enviado ao sindico.
* Tecnico, data da vistoria, data do laudo.
* Botoes para anexar PDF, ver PDF (em iframe overlay), remover PDF.

PDFs salvos como base64 no campo `pdfData` (Supabase) com nome e tamanho.

### 5. Historico (`cpShowTab('historico')`, render `cpRenderHistorico`)

Timeline cronologica simples. Cada item: data, texto, dot colorido (verde, azul ou amarelo). Itens adicionados via `cpAplicarUpdate` quando entra um JSON com array `historico`.

### 6. Assinaturas (`cpShowTab('assinaturas')`, render `cpRenderAssinaturas`)

Estado vazio fixo. Exibe texto "Nenhuma assinatura registrada ainda". A logica de coletar e armazenar assinaturas nunca foi implementada. [a confirmar com Matheus se a ideia ainda faz sentido]

### 7. Relatorio Sindico (botao de atalho, funcao `gerarRelatorioSindico`)

Nao e aba real. Abre janela nova (`window.open`) com HTML formatado para impressao (estilos inline, cores Virtual Service, `window.print()` no `onload`). Conteudo: 4 cards de stats, barra de progresso, secao de itens concluidos com fotos antes/depois embutidas, secao em andamento, secao pendentes, tabela de laudos, tabela de historico recente.

Matheus parou de usar este botao porque continua gerando o mesmo relatorio pelo Claude.ai usando a skill `relatorio-acompanhamento`. Arquivamento sem perda.

### 8. Relatorio Interno (botao de atalho, funcao `gerarRelatorioInterno`)

Mesma estrutura do Relatorio Sindico mas com tom interno (sem informacao para sindico, com observacoes operacionais). Tambem substituido pelo fluxo via Claude.ai com a skill `relatorio-acompanhamento`. Arquivamento sem perda.

### 9. Caixa de Entrada (`cpShowTab('demandas-ia')`, render `cpRenderDemandasIA`)

Reaproveita os IDs do modulo Demandas de Cliente (`dc-texto-bruto`, `dc-btn-processar`, `dc-extraidas-container`, etc.) para permitir colar texto bruto e processar com IA dentro do painel Condominios. Esta aba nao depende de `cpCondAtivo`, usa `state.config.condId` e `state.config.condNome`.

A funcionalidade existe duplicada na area principal Demandas de Cliente da Etapa 1. Manter aqui era atalho para rodar o fluxo sem trocar de painel.

### 10. Importar Update (`cpShowTab('importar')`, render `cpRenderImportar`)

Aba para colar um JSON gerado pelo Claude (com chaves `demandas`, `historico` e `laudos`) ou enviar um arquivo `.json`. `cpProcessarImportJSON` parseia, `cpAplicarUpdate` aplica:

* Para cada item em `data.demandas`: encontra a demanda local por `id` ou `titulo`, faz `Object.assign` e PATCH em `demandas` no Supabase.
* Para cada item em `data.historico`: POST em `historico` com `condominio_id`.
* Para cada item em `data.laudos`: se ja existe (match por `nome`) faz PATCH, senao POST em `laudos`.

Era a porta de entrada manual para sincronizar status atualizados do plano de acao quando o JSON era gerado fora do sistema.

## Botao "Gerar Apresentacao" (topbar, funcao `cpGerarApresentacao`)

Botao no canto superior direito da topbar do painel, separado da barra de abas. [a confirmar com Matheus o que exatamente este botao gera: deck, pagina HTML, JSON, ou outro artefato. A funcao comeca em public/index.html linha 4864 e nao foi lida por completo neste arquivamento.]

## Por que esta sendo arquivado

Resumo: virou complexo demais, misturou gestao de demandas com geracao de relatorios, ficou confuso de usar e Matheus parou de usar.

Sintomas concretos:

* Duas formas de processar texto bruto (painel Demandas de Cliente principal e a aba Caixa de Entrada do painel Condominios) confundem o fluxo.
* Relatorio Sindico e Relatorio Interno foram substituidos pelo Claude.ai com a skill `relatorio-acompanhamento`.
* Importar Update depende de gerar um JSON manualmente em outro lugar e colar aqui, fluxo nao automatizado.
* Aba Assinaturas nunca foi implementada de fato.
* Aba Caixa de Entrada e duplicata do painel Demandas de Cliente principal.
* Visao Geral, Prioridades e Demandas mostram informacao parecida em formatos diferentes.

## Funcionalidades que valeria reaproveitar caso o painel volte a ser construido

* CSS isolado com prefixo `cp-*` funciona como modelo de namespacing dentro de um arquivo HTML grande.
* `cpRenderDemGrid` (cards expansiveis com fotos antes e depois) e bom componente de visualizacao de demanda.
* `cpUploadPdf`, `cpVerPdf` e `cpRemoverPdf` compoem um fluxo simples de anexar e visualizar PDF em base64.
* O modelo de `cpAplicarUpdate` (matching por `id` ou `titulo`, `Object.assign`, PATCH) e util quando houver fluxo automatizado de update.

## O que nao vale reaproveitar

* As 8 abas do `cpShowTab` tal como estao. A organizacao das abas e o que tornou o painel confuso.
* `gerarRelatorioSindico` e `gerarRelatorioInterno`. Substituidos pelo Claude.ai.
* Aba Caixa de Entrada como duplicata. Manter so o painel Demandas de Cliente principal.

## Pontos a confirmar antes de remover do codigo

* `cpGerarApresentacao` produz o que exatamente. [a confirmar com Matheus]
* Existe dado em producao ja salvo nas tabelas `demandas`, `laudos`, `historico` que precise ser migrado ou exportado antes da remocao do painel. [a confirmar com Matheus]
