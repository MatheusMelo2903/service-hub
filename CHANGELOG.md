# Changelog Service Hub

## 29/04/2026 — Revisão profunda pré SaaS, 3 fixes de XSS e bug lógico, deploy aprovado

### Adicionado
- Comentários de cabeçalho explicativos em toast (justificativa do timeout 4000ms) e cpRenderSidebar (cabeçalho da função e razão do escHtml em vez de dcEscape)
- Branch local de segurança backup-pre-merge para rollback do pipeline (apagar na finalização)

### Corrigido
- Função toast (public/index.html linhas 3850 a 3866) reescrita com DOM API + document.createTextNode em vez de innerHTML, neutralizando XSS em mais de 60 callers. Varredura confirmou zero callers com tag HTML intencional.
- cpRenderSidebar (linhas 4069 a 4088) escapa c.nome, c.id e iniciais com escHtml. Decisão escHtml em vez de dcEscape porque c.id entra dentro de onclick com aspas simples internas e dcEscape não escapa apóstrofo.
- dcSalvarDemandas linha 4708 grava status 'Pendente' em vez de 'aberta'. Operação isolada, sem dependência com filtros, badges ou queries.

### Validado
- Auditor de segurança SEGURO PARA COMMIT, 7 varreduras adicionais sem crítico (tokens revogados 156b6871 e f8058080 zero matches em qualquer arquivo, public/ sem .bak, console.log não expõe app_token nem access_token)
- Revisor APROVADO sem ressalva após rodada extra de polimento (2ª passada do loop, dentro do limite de 4)
- Validador VALIDADO, 8 abas do sistema intactas, 4 cenários de dry run passaram (toast Lista A, toast Lista B com integers, cpRenderSidebar com nome e id sujos, dcSalvarDemandas com Pendente preservando todos os filtros)
- 4 testes runtime manuais executados pelo Matheus, T1 persistência localStorage OK, T2 render Condomínios OK, T3 status Pendente literal gravado no Supabase confirmado e demanda de teste apagada, T4 toast com document.createTextNode validado no DevTools Sources
- Deploy aprovado em produção, polling fechou na tentativa 5 (150s), HTTP 200 em / (40304 bytes) e em /hub (295721 bytes), marcador document.createTextNode presente no HTML servido

### Pendências
(a) Migração manual de status legado no Supabase. Rodar no Supabase Studio o comando `UPDATE demandas SET status='Pendente' WHERE status='aberta'`. Atinge especificamente as demandas com num 25 (id dc_1777074896060_0, processado_em 2026-04-24) e num 26 (id dc_1777074896282_1, processado_em 2026-04-24), criadas antes do fix. Sem isso, sistema convive com dois valores de status no banco. Prioridade média.

(b) Auditoria de RLS no Supabase. Risco residual a considerar, a publishable key sb_publishable_LgUqE8qdyvhh6VhLD4c4yg_zo6aWJXH esteve presente em public/index.html.bak-antes-fracao e public/index.html.bak-pre-fix-uf, ambos publicamente acessíveis via Railway por janela indeterminada antes do move para /backups/ na Etapa 0. Assumir que a chave pode ter sido coletada por scraper neste período. RLS no Supabase é a única defesa restante. Auditoria de policies das tabelas condominios, demandas, laudos e historico é prioridade ALTA e deve ser concluída antes da abertura do SaaS multi usuário. Localização da chave em código, public/index.html linha 3876.

(c) Verificação de git log no remoto pelos tokens revogados 156b6871 e f8058080. Comando sugerido `git log --all -p -S "156b6871"` e idem para o outro. Se aparecerem em commit antigo, vai ser preciso git filter-repo ou rotação preventiva. Verificação pendente, não bloqueio. Prioridade média.

(d) TypeError latente em cpRenderSidebar linha 4081, c.nome.split(' ') executado antes de escHtml, lança erro se c.nome for null ou undefined. Risco anterior, dado obrigatório no Supabase via schema mas sem proteção no client. Sugestão de fix futuro, guard com fallback `c.nome || 'Sem nome'` antes do split. Prioridade média.

(e) Schema da tabela demandas no Supabase usa processado_em em vez do padrão created_at. Descoberta colateral durante T3, não bloqueia, mas vale considerar normalização de schema antes da fase SaaS multi cliente. Também observa que condominio_id é string literal ('camaras'), não UUID, dado relevante pra modelagem multi cliente futura. Prioridade baixa.

### Issues novos descobertos pelo arquiteto, fora do escopo desta rodada, vão para tarefa de outra sessão
- Issue 3102 audio-log innerHTML com e.message vinda de APIs externas (AssemblyAI, Anthropic), prioridade ALTA. Vetor é externo, não self.
- Issue 3736 renderConsumoGrid com `${item.url}` data URL local e `${item.unidade}` input do usuário sem escape, prioridade média (self XSS local).
- Issue 3846 addHistorico com `${texto}` interpolado em innerHTML, prioridade média (self XSS local).

### Arquivos modificados
- `public/index.html` (modificado, 3 fixes aplicados, linha de contagem atualizada para 4967)

Implementado por: subagente programador

---

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
