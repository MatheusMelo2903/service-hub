# Changelog Service Hub

## 29/04/2026 Importacao de unidades validada em escala

### Adicionado
- Importacao de unidades via API Superlogica ponta a ponta
- Migracao SQL para vincular condominios ao Superlogica (id_condominio)
- Documentacao definitiva do fluxo em docs/guia-definitivo-v2-2026-04-28.pdf

### Corrigido
- PUT contatos rejeitava UF com erro 'ES nao e um valor valido'
  Causa: campo ST_ESTADO_CON nao existe na API Superlogica
  Solucao: remover o campo, manter apenas ST_UF_CON
- sanitizeProxyUrl normaliza URL do proxy Railway
- getProxy retorna URL correta independente de prefixo

### Validado
- Fase A: 1 unidade (A-0201) com nome real persistido no Superlogica
- Fase B: 10 unidades, POST 10/10 ok, PUT 10/10 ok
- Fase C: 528 unidades (Quattro Residencial Clube), POST 528/528, PUT 528/528
  405 com proprietario real, 123 com placeholder (vazios na origem)

### Pendencias documentadas (nao bloqueiam)
- Bug 403 em /v2/condor/condominios (busca em Configuracoes)
- Validar aba Caixa de Entrada no painel Condominios


---

# Changelog Service Hub

## 2026-04-28 (segunda parte) — Refatoração 4-em-1: cond global, modal Dashboard unificado, fusão Condomínios+Demandas, remoção cadastro do painel Condomínios

### Resumo
Quatro mudanças interligadas para eliminar duplicidade de seleção e simplificar navegação. Continuação direta da sessão anterior, por cima do trabalho não commitado.

### Item 1: Estado global do condomínio ativo
- `enviarDespesas` e `enviarUnidades`: toast atualizado para "Selecione um condomínio ativo no Dashboard".
- `cpSelecionarCond`: passou a sincronizar `state.config.condId`, `state.config.condNome`, `localStorage` e `atualizarDashCond`. Também sincroniza o hidden `cfg-cond-id` para que `saveConfig` posterior não apague.
- `cpCarregarDoSupabase`: ao auto-selecionar, prefere o `state.config.condId` salvo se ele existir na lista; cai no primeiro item só como fallback.
- `saveConfig`: passou a preservar `state.config.condId` quando o hidden está vazio (corrige cenário onde abrir Configurações depois de selecionar pelo Dashboard apagava a seleção).

### Item 2: Botão único no card "Condomínio Ativo" do Dashboard
- Removidos: input solto `dash-cond-search`, dropdown solto `dash-cond-dropdown`, botão `+ Novo condomínio`, modal `dash-modal-novo-cond`, listener `document.click` órfão, funções `dashAbrirModalNovoCondominio` e `dashFecharModalNovoCondominio`.
- Adicionado: botão único `btn-gerenciar-cond` que abre o modal `dash-modal-gerenciar-cond` com 2 abas (Buscar existente / Cadastrar novo) usando classes `.tabs` e `.tab` já existentes.
- Funções novas: `dashAbrirModalGerenciarCond`, `dashFecharModalGerenciarCond`, `dashModalSetTab`.
- `searchCondominioDash` e `selecionarCondominioDash` adaptadas aos novos IDs (`dash-modal-cond-search`, `dash-modal-cond-dropdown`).
- `dashSalvarNovoCondominio` adaptada (`dash-modal-nome-cond`, `dash-modal-id-superlogica`).
- `atualizarDashCond` ajusta o estado visual do botão (`btn-primary` quando sem cond, `btn-ghost` quando com cond).

### Item 3: Unificação Condomínios + Demandas de Cliente
- Removidos do menu lateral: item "Demandas de Cliente".
- Removidos: painel `panel-demandas-cliente` inteiro, `dcCarregarCondominios`, override de `showPanel` para `demandas-cliente`, entrada `'demandas-cliente'` em `PAGE_META`, `select dc-select-cond`.
- Adicionada: nova aba "Caixa de Entrada" na `cp-tabs-bar` do painel Condomínios.
- Função `cpRenderDemandasIA()` cria o HTML da Caixa de Entrada sem o select de condomínio (usa `state.config.condId` como fonte).
- `cpShowTab` trata o branch `demandas-ia` antes do guard `if (!c)`, permitindo renderizar mesmo sem cond ativo na sidebar.
- `dcProcessarTextoIA` e `dcSalvarDemandas` passaram a ler de `state.config.condId`.
- Variável `dcTextoBrutoTemp` preserva o rascunho ao trocar de aba.

### Item 4: Cadastro de condomínio removido do painel Condomínios
- Removidos: botão "+ Adicionar Condomínio", modal `cp-modal`, classes CSS `.cp-modal-overlay`, `.cp-modal-box`, `.cp-modal-field`, `.cp-modal-btns`, `.cp-btn-cancel`, `.cp-btn-ok`, `.cp-btn-novo`, funções `cpAbrirModal`, `cpFecharModal`, `cpSalvarCondominio`.

### Outras correções (rodada 2 do revisor)
- `cpAtualizarStatus`, `cpAnexarFoto`, `cpAplicarUpdate` agora usam `cpGetCondominioAtivo()` (corrigindo bug pré-existente onde `cpCondAtivo` string era tratado como objeto).
- Travessões em comentários HTML/JS substituídos por `:` ou removidos.
- `console.error` em `searchCondominioDash` removido.

### Métricas
- `public/index.html`: 4444 a 4414 linhas (-30 líquido). Diff acumulado (2 sessoes): +776 / -302.
- 2 rodadas de revisor + auditor.
- 30/30 pontos do validador aprovados.

### Decisões mantidas (P1, P2, P3, P4)
- Coluna `id_superlogica` (INTEGER) preservada no Supabase. Sem rename para `cond_id` (custo alto, benefício zero).
- Coluna `criado_em` preservada. Sem rename para `created_at`.
- `cpCondAtivo` continua como variável de foco do painel, sempre sincronizada com `state.config.condId`.
- "Caixa de Entrada" virou aba interna no painel Condomínios.

### Issues remanescentes (pré-existentes, fora de escopo)
- `buildUrl` (~linha 2507): fallback direto para `api.superlogica.net` quando `state.config.proxy` vazio.
- `loadConfig` (~linha 1818): XSS em `c.condNome`/`c.condId` via innerHTML.
- `searchCondominio` painel Configurações (~linha 2979): XSS idêntico ao corrigido em `searchCondominioDash`.
- `addLog` em `enviarDespesas`/`enviarConsumo`: dados HTTP brutos via innerHTML.
- `toast` global: `msg` interpola via innerHTML.
- `cpRenderSidebar`: injeta `c.nome` via innerHTML sem `dcEscape`.

### Arquivos modificados
- `public/index.html` (modificado, 4444 a 4414 linhas)
- `docs/log.md` (modificado)
- `tarefas/concluidas/refatoracao-cond-global-unificacao-painel.md` (movido de em-andamento)

Implementado por: subagente programador

---

## 2026-04-28 — Sessão de correção: seleção de condomínio e importação de unidades

### Resumo
Sessão de recuperação após o site ter sido travado por trabalho não commitado em `public/index.html` (+445/-24 linhas que causavam interferência cruzada entre Dashboard e painel Configurações). O trabalho problemático foi preservado em stash (`stash@{0}: sessao-correcao-2026-04-28-index-quebrado`) e o arquivo voltou ao estado limpo do commit `7a30772`. As 3 funcionalidades foram reimplementadas de forma cirúrgica seguindo o fluxo padrão (arquiteto -> programador -> revisor + auditor -> validador -> documentador), com 4 rodadas de revisor/auditor até aprovação.

### Funcionalidade 1: Seleção de condomínio no Dashboard
**Bug original**: `searchCondominioDash` chamava `selecionarCondominio` (do painel Configurações), causando interferência cruzada de listeners e travamento da tela.

**Correção**:
- `searchCondominioDash` (linha ~2826) reescrita: busca primeiro em `cpCondominios` (memória), fallback via `supaFetch` no Supabase. Sem chamadas Superlógica.
- `selecionarCondominioDash` (linha ~2903) criada: NÃO chama `selecionarCondominio`. Apenas atualiza `state.config`, `localStorage`, input do Dashboard e dispara `atualizarDashCond`.
- Event delegation no dropdown via `closest('.cond-option')` resolve o problema do `this.dataset` em filhos.
- Escape XSS via função `esc` local antes de qualquer interpolação em innerHTML.
- `loadConfig` agora restaura `dash-cond-search` ao recarregar a página.

### Funcionalidade 2: Cadastro rápido de novo condomínio
**Novo modal**: `dash-modal-novo-cond` no Dashboard (linha ~1751).

**Funções criadas**:
- `dashAbrirModalNovoCondominio` (linha ~2916)
- `dashFecharModalNovoCondominio` (linha ~2924)
- `dashSalvarNovoCondominio` (linha ~2931): valida nome e id_superlogica como inteiro positivo, POST via `supaFetch`, push em `cpCondominios` com `id_superlogica`, auto-seleciona como ativo, fecha modal, toast.

### Funcionalidade 3: Importação de unidades via API REST com colunas fixas
**Mudança em `processFile`**: header tenta linha 4 (índice 3) fixo; fallback automático por palavra "unidade" nas primeiras 10 linhas se não bater. Toast de erro se cabeçalho não encontrado.

**Reescrita `processUnidadesData`**: mapeamento por índice fixo (colunas 0, 1, 2, 3, 4, 5, 6, 7, 9, 24, 25, 26, 27, 28, 29). `cleanVal` filtra `nan`, `0`, `0.0`, `cep inválido`, `inválido`. `splitUnidade` separa bloco e número quando há espaço. `splitCidadeEstado` extrai sigla 2 letras do final.

**Mudança em `enviarUmaUnidade`**:
- PUT agora inclui 7 campos de endereço (`ST_CEP_CON`, `ST_ENDERECO_CON`, `ST_NUMERO_CON`, `ST_BAIRRO_CON`, `ST_COMPLEMENTO_CON`, `ST_CIDADE_CON`, `ST_ESTADO_CON`).
- Resposta do PUT é tratada: lê `r2.ok`, parse JSON, verifica `status: "200"`, retorna `{ok: false}` em falha.
- Função `esc` no topo da função, todas as chamadas a `addLog` escapam dados externos.

**Novo elemento**: `uni-progresso-texto` no painel-unidades, atualizado no formato `X de Y unidades importadas` durante a importação.

**Lote**: 10 unidades simultâneas com `Promise.all` + `sleep(100)` entre lotes.

### Estado da inicialização
`state.unidades` agora inicializa `processed: []`, `importing: false`, `shouldStop: false` na declaração (linha 1779).

### Métricas
- `public/index.html`: 4242 -> 4444 linhas. Diff final: +316 / -114.
- 4 rodadas de revisor + auditor até aprovação.
- 30 pontos de validação aprovados pelo validador.

### Issues conhecidos fora de escopo
Para tratar em sessão futura:
1. `loadConfig` linha ~1818 — XSS em `c.condNome` e `c.condId` via innerHTML.
2. `searchCondominio` painel Configurações linhas ~2979-3007 — XSS idêntico ao corrigido em `searchCondominioDash`.
3. `addLog` em `enviarDespesas` e `enviarConsumo` — `txt` da resposta HTTP via innerHTML sem escape.
4. `toast` global — `msg` interpola via innerHTML.

### Stash preservado
`stash@{0}: sessao-correcao-2026-04-28-index-quebrado` ainda existe localmente. Pode ser descartado depois que o Matheus validar manualmente que o site funciona.

### Arquivos modificados
- `public/index.html` (modificado, 4242 -> 4444 linhas)

Implementado por: subagente programador
