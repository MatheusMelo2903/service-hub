# Log de mudanças — Service Hub

Registro cronológico de tarefas concluídas. Entrada mais recente no topo.

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
