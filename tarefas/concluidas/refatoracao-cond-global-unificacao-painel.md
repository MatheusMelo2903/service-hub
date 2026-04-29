# TAREFA: Refatoração 4-em-1: estado global do condomínio, modal Dashboard unificado, fusão Condomínios+Demandas, remoção do cadastro do painel Condomínios

## Contexto

Continuação direta da sessão anterior (`correcao-selecao-cond-importacao-unidades.md`), por cima do trabalho ainda não commitado em `public/index.html` (4444 linhas).

A sessão anterior introduziu:
- Card `Condomínio Ativo` no Dashboard com `dash-cond-search` + `dash-cond-dropdown` + `dash-cond-nome` + `dash-cond-id`.
- Funções `searchCondominioDash` (busca em `cpCondominios` + fallback `supaFetch`) e `selecionarCondominioDash` (atualiza `state.config.condId` e `condNome`, persiste em `localStorage`).
- Modal `dash-modal-novo-cond` com botão `+ Novo condomínio` no card do Dashboard (cadastro rápido + auto-seleção).
- `processFile` com `headerIdx=3` + fallback, `processUnidadesData` com colunas fixas, PUT com endereço.
- Estado `state.unidades` com `processed`, `importing`, `shouldStop`.

A coluna do Supabase em uso para o ID Superlógica é `id_superlogica` (INTEGER, NULLABLE, UNIQUE), criada pela `MIGRATION_CONDOMINIOS_SUPERLOGICA.sql`. O spec desta tarefa pede `cond_id` (text). Decisão pendente do Matheus (ver Perguntas críticas).

## Itens

### Item 1 — Estado global do condomínio ativo

`state.config.condId` e `state.config.condNome` devem ser respeitados por TODAS as funções que falam com Superlógica via proxy: importar despesas, importar unidades, qualquer outro endpoint Superlógica.

Auditoria a fazer:
- Quais funções chamam o proxy hoje? (Provavelmente: `enviarDespesas`, `enviarUnidades`, `enviarUmaUnidade`, e quaisquer leitura do tipo `apiGet` que use `condId`.)
- Cada uma delas hoje pega o ID de onde? (Pode ser `state.config.condId`, pode ser `cfg-cond-id` hidden, pode ser variável local.)
- Padronizar: TODAS leem de `state.config.condId`. Se vazio, bloquear com toast claro.

### Item 2 — Botão único no card "Condomínio Ativo" do Dashboard

Hoje existem dois mecanismos no card: (a) campo de busca `dash-cond-search`, (b) botão `+ Novo condomínio`. O spec novo unifica em UM botão que abre UM modal com dois fluxos:

- Aba/seção "Buscar existente": campo de busca + dropdown que reusa a lógica atual de `searchCondominioDash` + `selecionarCondominioDash`.
- Aba/seção "Cadastrar novo": campos Nome e ID Superlógica, reusa `dashSalvarNovoCondominio` (que já auto-seleciona).

Decisão do Matheus na sessão anterior: ao cadastrar, o sistema auto-seleciona o novo condomínio como ativo.

O spec novo pede botão "visualmente integrado ao card, esteticamente elegante". Detalhamento estético fica a cargo do arquiteto/programador conforme padrão visual do arquivo (CSS já tem `.btn`, `.btn-primary`, `.btn-ghost`).

O campo `dash-cond-search` solto fora do modal pode ser removido OU mantido como atalho dentro do card. O spec não é explícito. Sugestão: remover do card e deixar tudo dentro do modal único, mais limpo.

### Item 3 — Unificar abas "Condomínios" e "Demandas de Cliente"

Hoje:
- `panel-condominios` (linha ~1194): sidebar com lista de condomínios + área principal com demandas, relatórios, laudos, histórico, assinaturas. Namespace `cp*`. Usa `cpCondominios` em memória + `cpCondAtivo` para o cond selecionado DENTRO do painel.
- `panel-demandas-cliente` (linha ~1431): preview e salvamento de demandas. Namespace `dc*`. Usa `dcDemandasPreview`. Tem campo de busca de condomínio próprio (a remover).

O sidebar do menu lateral hoje tem item para Condomínios e item para Demandas de Cliente. O spec pede:
- Manter SOMENTE "Condomínios" no menu lateral.
- Remover "Demandas de Cliente" do menu lateral.
- O painel unificado mantém a sidebar de condomínios à esquerda + área principal com TUDO que existe hoje nos dois painéis: demandas, relatórios, histórico, laudos, assinaturas.

A funcionalidade de preview/salvar demandas (que vivia em `panel-demandas-cliente`) deve ser acessível como aba interna dentro do painel Condomínios, ou como seção embutida no detalhe do condomínio selecionado.

O campo de busca de condomínio dentro do painel Demandas (selecionar) é REMOVIDO. A seleção global vem de `state.config.condId`.

Pergunta crítica para o arquiteto: hoje `cpCondAtivo` (cond ativo DENTRO do painel) e `state.config.condId` (cond ativo GLOBAL) são variáveis separadas. O spec quer que `state.config.condId` seja a fonte única. Mas a sidebar do painel Condomínios tem clique em cada condomínio para ver detalhes — isso troca o `cpCondAtivo` apenas ou troca também o GLOBAL?

Sugestão: clicar em um condomínio na sidebar do painel passa a ser um "espiar" local (`cpCondAtivo`) sem mexer no global, OU passa a ser equivalente a selecionar o global. O Matheus precisa decidir.

### Item 4 — Remover cadastro de condomínio da aba Condomínios

Botão "Adicionar Condomínio" do painel Condomínios (provavelmente acionado por `cpAbrirModal()` ou similar) é removido junto com seu modal e funções de salvar. A criação de condomínio no sistema fica EXCLUSIVAMENTE no Dashboard (Item 2).

Auditoria a fazer:
- Identificar o botão e o modal `cp-modal` do painel Condomínios.
- Identificar funções `cpAbrirModal`, `cpFecharModal`, `cpSalvarCondominio` (ou nomes equivalentes).
- Remover botão, markup do modal e funções não usadas.
- Confirmar que nenhuma outra parte do código depende dessas funções.

## Por que

1. Coerência: o usuário não deve precisar selecionar o mesmo condomínio em 3 lugares diferentes.
2. UX: cadastrar e selecionar passa por UM caminho só (Dashboard).
3. Manutenção: menos abas duplicadas, menos código morto.

## Critério de aceite

- [ ] `state.config.condId` é a fonte única de cond ativo. Importar despesas, importar unidades e qualquer chamada Superlógica usa esse valor.
- [ ] Toast claro quando o usuário tenta usar fluxo Superlógica sem cond ativo.
- [ ] Card "Condomínio Ativo" no Dashboard tem UM botão que abre um modal com dois fluxos (buscar e cadastrar). Sem campo de busca solto fora do modal.
- [ ] No modal: aba Buscar usa cpCondominios + supaFetch; aba Cadastrar valida nome e ID Superlógica obrigatórios e auto-seleciona.
- [ ] Aba "Demandas de Cliente" some do menu lateral.
- [ ] Aba "Condomínios" passa a ter o conteúdo dos dois painéis: sidebar + demandas + relatórios + laudos + histórico + assinaturas.
- [ ] Campo de busca de condomínio DENTRO do painel Demandas é removido.
- [ ] Botão "Adicionar Condomínio" do painel Condomínios é removido.
- [ ] Modal e funções de cadastro do painel Condomínios são removidos.
- [ ] Nenhuma funcionalidade existente quebra: dashboard, importar despesas, importar unidades, geração de atas, demandas que ainda existem.
- [ ] Validador aprova 30 de 30 pontos.

## Restrições

- Sem hífen em texto visível ou comentário de código.
- Português brasileiro nos textos.
- Tokens Superlógica nunca hardcoded.
- Edição feita pelo programador via Edit/Write.
- Push e commit manuais.
- Toda alteração no Supabase via terminal (SQL ou API REST direta).
- Nunca chamar `api.superlogica.net` direto. Sempre via proxy Railway.

## Perguntas críticas para o arquiteto / Matheus

**Pergunta 1 — `cond_id` vs `id_superlogica`**: hoje a coluna no Supabase é `id_superlogica` (INTEGER). O spec novo pede `cond_id` (text). 3 caminhos:
- (a) Renomear `id_superlogica` para `cond_id` e mudar tipo INTEGER para TEXT. Atualizar 5 pontos no código que usam `id_superlogica`. Migrar dados existentes (poucos).
- (b) Manter `id_superlogica` no banco, usar como alias `cond_id` no código (não recomendado, gera dívida).
- (c) Criar coluna `cond_id` paralela e deprecar `id_superlogica`. Pior opção.

**Pergunta 2 — `criado_em` vs `created_at`**: hoje a coluna é `criado_em`. O spec pede `created_at`. Renomear ou manter?

**Pergunta 3 — Unificação do painel: `cpCondAtivo` continua existindo?** Quando o usuário clica em um condomínio na sidebar do painel Condomínios, ele está só "espiando" outro condomínio (sem mudar o global) ou está mudando o global `state.config.condId`?

**Pergunta 4 — Posição dos sub-conteúdos no painel unificado**: as funcionalidades que vinham de Demandas de Cliente (preview de demandas geradas por IA, save em batch) viram uma aba/sub-seção dentro do detalhe do condomínio? Ou viram um botão no header do painel?

## Status

- [x] Tarefa escrita
- [x] Plano feito pelo arquiteto
- [x] Plano aprovado pelo Matheus
- [x] Código implementado
- [x] Código revisado
- [x] Auditoria de segurança aprovada
- [x] Validação aprovada
- [x] Documentação atualizada

## Resumo final

- Linhas no diff total: +776 / -302 (inclui a sessão anterior não commitada + esta sessão). Resultado líquido em `public/index.html`: 4444 a 4414 linhas (-30 líquido).
- Rodadas de revisor/auditor: 2 (aprovação na rodada 2).
- Decisões mantidas: P1 coluna `id_superlogica` (INTEGER) preservada no Supabase, sem rename para `cond_id`; P2 coluna `criado_em` preservada, sem rename para `created_at`; P3 `cpCondAtivo` continua como variável de foco do painel, sincronizada com `state.config.condId` mas sem alterar o global a cada clique na sidebar; P4 Demandas de Cliente virou aba interna "Caixa de Entrada" no painel Condomínios.
- Issues conhecidos remanescentes (pré-existentes, não introduzidos por esta tarefa): `buildUrl` fallback direto para `api.superlogica.net` quando proxy vazio (~linha 2507); `loadConfig` XSS em `c.condNome`/`c.condId` via innerHTML (~linha 1818); `searchCondominio` painel Configurações XSS idêntico ao corrigido em `searchCondominioDash` (~linha 2979); `addLog` em `enviarDespesas`/`enviarConsumo` expõe dados HTTP brutos via innerHTML; `toast` global interpola `msg` via innerHTML; `cpRenderSidebar` injeta `c.nome` via innerHTML sem `dcEscape`.

## Notas para o arquiteto

- Releia o `public/index.html` integralmente nas regiões: `panel-condominios` (1194 a 1419), `panel-demandas-cliente` (1431 a 1506), todas as funções `cp*` (3460 a 4030 aprox), todas as funções `dc*` (4020 a fim).
- Mapeie EXPLICITAMENTE: quem tem botão "Adicionar Condomínio" hoje, qual o modal acionado, qual a função de save. Isso pode estar quebrado já que a sessão anterior mudou o cadastro pra Dashboard.
- Veja `MIGRATION_CONDOMINIOS_SUPERLOGICA.sql` na raiz para a definição atual da coluna `id_superlogica`.
- Inventarie todas as chamadas Superlógica via proxy no arquivo (busque por `superlogica-proxy` e `state.config.proxy` e `apiGet`/`apiPost`). Para cada uma, identifique de onde vem o `condId`.
- Decida se faz sentido manter o campo de busca solto no card do Dashboard como "atalho rápido" ou se vai SÓ pelo modal. Recomende uma das opções no plano com justificativa.
