# Log de mudanças — Service Hub

Registro cronológico de tarefas concluídas. Entrada mais recente no topo.

---

## 2026-04-28 (segunda parte) — Refatoração 4-em-1: cond global, modal Dashboard unificado, fusão Condomínios+Demandas, remoção cadastro do painel Condomínios

Quatro mudanças interligadas para eliminar duplicidade de seleção e simplificar navegação. Continuação direta da sessão anterior, por cima do trabalho ainda não commitado.

- Estado global unificado: `state.config.condId` como fonte única para todas as funções que acessam o proxy Superlógica. `cpSelecionarCond` e `saveConfig` ajustados para manter sincronismo. Toast padronizado "Selecione um condomínio ativo no Dashboard" quando condId vazio.
- Modal unificado no Dashboard: campo de busca solto e botão `+ Novo condomínio` removidos do card. Substituídos por um único `btn-gerenciar-cond` que abre modal com abas "Buscar existente" e "Cadastrar novo". Funções `dashAbrirModalGerenciarCond`, `dashFecharModalGerenciarCond`, `dashModalSetTab` criadas.
- Fusão de painéis: `panel-demandas-cliente` removido do menu lateral e do DOM. Funcionalidade de preview/salvar demandas virou aba "Caixa de Entrada" dentro do painel Condomínios, lendo `state.config.condId` como fonte. Função `cpRenderDemandasIA` criada.
- Remoção do cadastro do painel Condomínios: botão, modal `cp-modal` e funções `cpAbrirModal`/`cpFecharModal`/`cpSalvarCondominio` removidos. Cadastro passa a existir exclusivamente no Dashboard.
- Correções rodada 2: `cpAtualizarStatus`, `cpAnexarFoto`, `cpAplicarUpdate` corrigidas para usar `cpGetCondominioAtivo()` em vez de tratar `cpCondAtivo` string como objeto.
- Validador: 30/30 aprovados.

Arquivos alterados: `public/index.html` (modificado, 4444 a 4414 linhas), `docs/log.md` (este arquivo), `tarefas/concluidas/refatoracao-cond-global-unificacao-painel.md` (movido de em-andamento)
Implementado por: subagente programador

---

## 2026-04-28 — Correção da seleção de condomínio no Dashboard e importação de unidades via API REST

Sessão de recuperação após o site ter sido travado por trabalho não commitado em `public/index.html`. O stash foi preservado e o arquivo revertido para o commit limpo `7a30772`. As 3 funcionalidades foram reimplementadas de forma cirúrgica com 4 rodadas de revisor/auditor até aprovação e 30 pontos de validação aprovados.

- Bug original corrigido: `searchCondominioDash` chamava `selecionarCondominio` do painel Configurações, disparando listeners cruzados e travando a tela. Função `selecionarCondominioDash` criada para isolar completamente o fluxo do Dashboard, sem nenhuma chamada à função homônima do painel Configurações.
- Cadastro rápido de novo condomínio implementado via modal `dash-modal-novo-cond` com validação de nome e id_superlogica, POST no Supabase, auto-seleção imediata e atualização do array em memória `cpCondominios`.
- Importação de unidades reescrita com mapeamento por índice fixo (header linha 4 com fallback automático), 7 campos de endereço no PUT, limpeza de valores inválidos (`nan`, `0.0`, `cep inválido`), progresso textual em tempo real (`X de Y unidades importadas`) e lotes de 10 com `Promise.all` + sleep 100ms.
- Issues XSS fora de escopo registrados no CHANGELOG.md para tratamento futuro: `loadConfig` ~1818, `searchCondominio` do painel Configurações ~2979, `addLog` em `enviarDespesas`/`enviarConsumo`, e `toast` global.

Arquivos alterados: `public/index.html` (modificado, 4242 -> 4444 linhas), `CHANGELOG.md` (criado na raiz), `tarefas/concluidas/correcao-selecao-cond-importacao-unidades.md` (movido de em-andamento)
Implementado por: subagente programador

---

## 2026-04-28 — Seleção de condomínio com ID Superlógica manual

Feature de gerenciamento de condomínio ativo implementada no `public/index.html` (445 inserções, 24 remoções). Migration SQL criada em arquivo separado para rodar no Supabase Studio antes do deploy.

- Modal de cadastro com dois campos (nome e ID Superlógica numérico com validação de inteiro positivo), lista em ordem alfabética com busca por nome, botão para definir condomínio ativo e botão para remover.
- Barra fixa no topo do Hub exibindo nome e ID Superlógica do condomínio ativo em destaque, visível em todas as abas. Se nenhum condomínio estiver ativo a barra exibe alerta pedindo seleção.
- Guard de envio aplicado nas funções de importar unidades e importar despesas: botão desabilitado sem condomínio selecionado, modal de confirmação exige clique explícito mostrando nome e ID de destino antes de qualquer chamada à API Superlógica.
- Trocar de condomínio ativo limpa `state.despesas.importing` e `state.unidades.importing` simetricamente. Defesa em profundidade nas funções `_Confirmado`: revalidam que o condomínio ainda existe antes de disparar a importação.
- XSS prevenido via `dcEscape` em 5 pontos de renderização: barra de condomínio ativo, modal de confirmação de unidades, modal de confirmação de despesas, lista de seleção e sidebar de condomínios.
- `updated_at` populado no PATCH para consistência no banco.
- Decisão de design: coluna `ativo` ficou fora do banco, vive exclusivamente em localStorage por máquina. Evita conflito de sessões simultâneas em máquinas diferentes.
- Correções aplicadas no ciclo revisor/auditor: `state.despesas.importing` tornado simétrico com unidades, XSS coberto nos 5 locais, comentário em inglês traduzido, defesa em profundidade adicionada, `updated_at` no PATCH.
- Pendência não bloqueante: `Prefer: return=representation` no PATCH não tem leitura do corpo retornado. Gasta banda desnecessariamente. Vale ajustar em tarefa futura.
- Migration SQL: `MIGRATION_CONDOMINIOS_SUPERLOGICA.sql` criado na raiz do repo. Precisa ser rodado no Supabase Studio antes do deploy em produção. Adiciona colunas `id_superlogica` (integer not null), `ativo` (boolean default false) e `updated_at` (timestamptz) à tabela `condominios` existente.

Arquivos alterados: `public/index.html` (modificado), `MIGRATION_CONDOMINIOS_SUPERLOGICA.sql` (criado), `tarefas/concluidas/selecao-condominio-id-manual.md` (movido de em-andamento)
Implementado por: subagente programador

Proximos passos para o Matheus: (1) rodar `MIGRATION_CONDOMINIOS_SUPERLOGICA.sql` no Supabase Studio, (2) testar em localhost com `npm start`, (3) autorizar push com `hubdeploy`.

---

## 2026-04-28 — Aliases zsh para Service Hub CLIs

- Bloco "Service Hub CLIs" adicionado ao final de `~/.zshrc` com 4 aliases: `hubdeploy`, `hublog`, `hubstat`, `hubvars`
- `hubdeploy` roda `git push origin main`, aguarda 5s (sleep 5 para Railway detectar o webhook), então exibe `railway logs --deployment`; não inclui `git add` pois stage é manual por decisão do Matheus
- `hubvars` usa `railway variables`, que requer o projeto já linkado (concluído na T2)
- gh aliases configurados: `hub` abre o repo no browser e `hubpr` cria PR com `--fill`
- Backup do `.zshrc` anterior preservado em `~/.zshrc.bak`; sintaxe validada com `bash -n` sem erros

Arquivos alterados: `~/.zshrc`, `~/.zshrc.bak`, `~/.config/gh/config.yml` (todos fora do repo)
Implementado por: subagente programador

---

## 2026-04-28 — Instalação e link das CLIs gh e railway

- gh CLI 2.91.0 já estava instalado em `/usr/local/bin/gh`, autenticado como `MatheusMelo2903` via keyring com scopes `repo`, `read:org`, `workflow` e `gist`
- railway CLI 4.42.1 já estava instalado em `~/.local/bin/railway`, autenticado com a conta do Matheus
- Projeto Railway `eloquent-love` linkado ao diretório `~/v8s/service-hub` via `railway link`, environment `production`, service `service-hub`
- Permite usar `railway logs`, `railway status` e `railway variables` direto do terminal sem abrir o dashboard
- Proximo passo: configurar aliases zsh (T3) e validar fluxo de commit via CLI (T4)

Arquivos alterados: nenhum (infra local, fora do repo)
Implementado por: subagente programador

---

## 2026-04-28 — Limpeza dos UUIDs vazados no CLAUDE.md

Incidente neutralizado em 27/04/2026: tokens Superlógica em texto plano em arquivos commitados foram substituídos por placeholder e os tokens originais foram revogados no painel Superlógica.

- CLAUDE.md (linhas 38 a 39): app_token e access_token substituídos pelo placeholder `<configurado-via-Service-Hub-Configuracoes>`; zero UUIDs restantes confirmado via grep recursivo
- Tarefa `seguranca-tokens-superlogica-vazados.md` também continha os valores em texto plano (linha 8): substituídos pelo mesmo placeholder e movida para `tarefas/concluidas/`
- Tarefa `limpeza-claude-md-uuids-vazados.md`: removido identificador parcial do novo token que havia sido citado como evidência na descrição da tarefa; movida para `tarefas/concluidas/`
- Estado operacional: 3 tokens antigos revogados no painel Superlógica; novo token Service Hub V8S configurado via localStorage na aba Configurações do Service Hub; conexão validada com "Conexão OK"

**Aprendizado:** briefings que descrevem credenciais não devem conter prefixos do token vivo, mesmo truncados. O auditor identificou um prefixo parcial na descrição da própria tarefa de cleanup, citado como evidência do que havia sido rotacionado. Padrão a seguir: usar `<prefixo-omitido>` ou descrição genérica como "novo token Service Hub V8S em uso via localStorage" sem identificadores. Vale tanto pra commits quanto pra arquivos de tarefa em em-andamento.

Arquivos alterados: `CLAUDE.md`, `tarefas/concluidas/seguranca-tokens-superlogica-vazados.md`, `tarefas/concluidas/limpeza-claude-md-uuids-vazados.md`
Implementado por: subagente programador

---

## 2026-04-27 — Reforço da regra de reporte intermediário no programador

- Adicionado bloco "Regra de reporte intermediário (OBRIGATÓRIA)" no system prompt do subagente programador (~/.claude/agents/programador.md), nas linhas 28 a 30, logo após a regra de leitura de arquivos em blocos
- Quando o prompt da tarefa pedir explicitamente "reportar antes", "confirmar antes de aplicar", "me mostrar antes do Edit" ou variação equivalente, o programador deve parar após o levantamento e devolver resultado em texto puro antes de chamar Edit/Write
- Motivação: o programador pulou esse passo nas tarefas landing-servicezone e api-404-catchall; em tarefa de maior risco (delete, migration, mudança de permissão) o desvio poderia causar estrago irreversível
- Backup ~/.claude/agents/programador.md.bak mantido até validação da próxima tarefa real

Arquivos alterados: `~/.claude/agents/programador.md` (fora do repo, escopo global)
Implementado por: subagente programador

---

## 2026-04-27 — Catch-all 404 JSON para /api/* desconhecido

- Adicionado middleware `app.use('/api', ...)` que retorna 404 JSON estruturado em rotas `/api/*` não mapeadas, em vez de servir a landing como o catch-all geral fazia
- Log via `console.warn` com formato JSON estruturado contendo evento, metodo, caminho, ip e timestamp
- `app.set('trust proxy', true)` adicionado no topo do server.js para o Railway repassar o IP real do cliente via `req.ip`
- `req.baseUrl + req.path` usado em vez de `req.path` solto, preservando o path completo dentro do mount `/api`
- Middleware cobre todos os métodos HTTP (não só GET), via `app.use` em vez de `app.get`

Arquivos alterados: `server.js`
Implementado por: subagente programador

---

## 2026-04-27 — Otimização do fluxo de subagentes

- Todos os 8 subagentes permanecem em Sonnet (arquiteto, programador, revisor, auditor-seguranca, validador, documentador, professor, estrategista). A promoção pra Opus de 5 deles foi tentada e revertida no mesmo dia (justificativa abaixo).
- Programador ganha regra obrigatória de leitura de arquivos em blocos (menos de 1500 linhas: ler inteiro; 1500 a 5000: blocos de 200; mais de 5000: blocos de 500; nunca ler 5 a 20 linhas sem contexto; busca pontual via grep mais bloco de 50 linhas ao redor)
- Documentador ganha checklist de auto-validação obrigatória com 5 passos numerados no final do system prompt (git diff --stat HEAD~1, reler tarefa, date +%Y-%m-%d, reler changelog, corrigir antes de mover)
- CLAUDE.md: fluxo paralelizado (revisor e auditor-seguranca rodam no mesmo turno com dois Agent tool uses simultâneos), nota sobre leitura em blocos em "Padrões de código", seção nova "Cache de contexto" explicando que o caching é automático e que ordem de seções importa
- Justificativa da reversão de Opus pra Sonnet: a meta da tarefa era ganho de tempo. Promover pra Opus iria contra essa meta sem evidência observada de ganho de qualidade nas últimas 3 tarefas, que entregaram bem em Sonnet.

Arquivos alterados: `CLAUDE.md`, `~/.claude/agents/programador.md` (regra de blocos), `~/.claude/agents/documentador.md` (auto-validação)
Implementado por: subagente programador

---

## 2026-04-27 — Remoção de tokens expostos no frontend

- Rota pública /api/config deletada (vazava OPENAI_KEY em JSON)
- Constante ASSEMBLYAI_KEY_DIRECT e lógica IS_LOCAL removidas do index.html
- Função processFilesConsumo migrada de chamada direta à API Anthropic para o proxy /api/claude/messages (estava quebrada em produção)
- Comentário em inglês traduzido para português
- Pendência pós-deploy: revogar chave AssemblyAI vazada e atualizar ASSEMBLYAI_KEY no Railway

Arquivos alterados: `server.js`, `public/index.html`
Implementado por: subagente programador

---

## 2026-04-27 — Melhorias visuais da landing ServiceZone

- Logo SVG oficial do Grupo Service substituiu a recriação amadora (com correção de bug tipográfico no path original)
- Gradiente radial duplo no fundo do body: centro azulado #0A1628 com vinheta rgba(2,4,10,0.6) nas bordas
- Glow azul difuso atrás do título do hero com filter blur 120px em rgba(43,125,200,0.15) e will-change: filter
- Canvas de partículas animadas em JS vanilla (45 desktop / 20 mobile), com prefers-reduced-motion, pausa em aba inativa via visibilitychange e debounce no resize; setTransform em vez de scale cumulativo
- Título refatorado em duas linhas: "Plataforma operacional" em peso 800 branco e "do Grupo Service" em peso 500 itálico cinza claro (rgba(255,255,255,0.70)) para não conflitar com o glow
- Espaçamento do hero refatorado de min-height 100vh para padding fixo (100px desktop / 64px mobile)

Arquivo alterado: `public/landing.html`
Implementado por: subagente programador

---

## 2026-04-27 — Landing page ServiceZone

- Criada landing pública em / com identidade ServiceZone (SVG da logo Grupo Service inline, hero, seção sobre, rodapé sem CNPJ por decisão do Matheus)
- Sistema operacional movido para /hub, continua 100% funcional
- server.js ajustado com `express.static({ index: false })` e rotas explícitas GET / e GET /hub
- index.html limpo de bloco da landing antiga embutida (CSS .lp-, HTML #landing-overlay, JS lpEntrar/lpAbrirModalCriarConta/lpFecharModalCriarConta)
- Achados de segurança registrados em tarefas separadas (em andamento): token AssemblyAI hardcoded no index.html e rota /api/config expondo OPENAI_KEY

Arquivos criados: `public/landing.html`
Arquivos alterados: `server.js`, `public/index.html`
Implementado por: subagente programador
