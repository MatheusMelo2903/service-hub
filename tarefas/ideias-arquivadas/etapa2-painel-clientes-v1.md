---
titulo: Etapa 2 painel de clientes v1 (arquivado)
status: arquivado
data_arquivamento: 2026-05-03
ultima_localizacao: branch etapa2-painel-clientes (a ser deletada local e remota), PR #2 (a ser fechado sem merge), MIGRATION_ETAPA2.sql ja aplicada no Supabase
---

# Etapa 2 painel de clientes v1 (arquivado)

## O que era

Painel novo na sidebar principal "Clientes" para configurar relatorio recorrente para sindico de cada condominio. Quatro campos novos por condominio:

* `sindico_telefone`
* `sindico_email`
* `frequencia_relatorio` (semanal, quinzenal ou mensal)
* `dia_atualizacao_semanal` (segunda a domingo)

A ideia era reusar o cadastro existente em `condominios` e adicionar uma aba dedicada ao gerenciamento desses dados de comunicacao do sindico.

## Status do banco

Aplicado em producao via `MIGRATION_ETAPA2.sql`. As 4 colunas foram adicionadas na tabela `condominios` do Supabase e estao vazias. Se o painel for reconstruido no futuro, o schema esta pronto. Nao precisa rodar migration de novo.

## Status do codigo

* PR #2 fechado sem merge.
* Branch local `etapa2-painel-clientes` deletada.
* Branch remota `origin/etapa2-painel-clientes` deletada.
* Codigo da etapa2 (cerca de 526 linhas adicionadas em `public/index.html`, alem do `MIGRATION_ETAPA2.sql`) descartado.

## Por que foi abandonada

Desenho feito em 24/04/2026. De la pra ca o sistema andou muito:

* Importacao de unidades em escala (1, 10 e 528 unidades validadas com Quattro Residencial Clube).
* Suporte a Inquilino e Dependente via planilha unificada de 26 colunas.
* Refatoracao de cond global com banner de condominio ativo.
* Modal de cadastro e edicao de condominio no Dashboard.
* Fracao ideal validada localmente.
* Revisao profunda de XSS na toast e no `cpRenderSidebar`.

A etapa2 saiu de uma main que nao tinha nada disso. Quando voltamos para reconciliar em 03/05/2026, o `git diff main..etapa2-painel-clientes -- public/index.html` mostrou 526 inserts e 1512 deletes. A maioria dos "deletes" era codigo novo da main que a etapa2 nao tinha (banner cond ativo, modal de cadastro, helpers de inquilino e dependente). Resolver o conflito hunk por hunk teria sido demorado e perigoso, com risco real de quebrar funcionalidades ja validadas em producao.

Decisao: descartar a etapa2 inteira. A feature de configuracao de relatorio volta a tabela quando voltar a ser prioridade, ja em cima da main atual.

## Licao aprendida

Refator antes de ter funcao estabilizada gera retrabalho. Construir funcao primeiro, refatorar depois.

A etapa2 comecou apos a Etapa 1 mas antes do bloco grande de funcionalidades de Superlogica, Inquilino/Dependente e fracao ideal. Esse bloco mexeu pesado em `public/index.html`. Branch que fica fora da main por mais de uma semana enquanto a main recebe trabalho concentrado no mesmo arquivo tem custo de reconciliacao alto.

Pratica que evita o problema:

* Se a feature pode esperar, manter na pasta `tarefas/em-andamento` como descricao em markdown e nao abrir branch.
* Se a feature comeca, mergear ou rebasear na main com frequencia (idealmente diaria).
* Se a main entra em fase de mexer pesado em arquivo compartilhado, pausar a branch e re escrever a partir do estado mais novo da main em vez de reconciliar hunk por hunk.

## O que vai ser reaproveitado

* As 4 colunas no Supabase ja estao la, prontas para uma versao 2.
* O conceito de "configuracao de relatorio por condominio" continua valido. Volta como tarefa quando a feature de Prestacao de Contas estiver estavel.

## O que nao volta

* O codigo da branch `etapa2-painel-clientes` (descartado).
* O desenho visual original do painel Clientes. UI feita em 24/04 nao reflete mais o estado do sistema.
