# Log de mudanças — Service Hub

Registro cronológico de tarefas concluídas. Entrada mais recente no topo.

---

## 2026-04-27 — Otimização do fluxo de subagentes

- Promove arquiteto, programador, revisor, auditor-seguranca, validador para Opus (documentador, professor, estrategista permanecem em Sonnet)
- Programador ganha regra obrigatória de leitura de arquivos em blocos (menos de 1500 linhas: ler inteiro; 1500 a 5000: blocos de 200; mais de 5000: blocos de 500; nunca ler 5 a 20 linhas sem contexto; busca pontual via grep mais bloco de 50 linhas ao redor)
- Documentador ganha checklist de auto-validação obrigatória com 5 passos numerados no final do system prompt
- CLAUDE.md: fluxo paralelizado (revisor e auditor-seguranca rodam no mesmo turno com dois Agent tool uses simultâneos), nota sobre leitura em blocos em "Padrões de código", seção nova "Cache de contexto" explicando que o caching é automático e que ordem de seções importa
- Backups .bak em ~/.claude/agents/ ficam até validação da próxima tarefa pelo Matheus

Arquivos alterados: `CLAUDE.md`, `~/.claude/agents/arquiteto.md`, `~/.claude/agents/programador.md`, `~/.claude/agents/revisor.md`, `~/.claude/agents/auditor-seguranca.md`, `~/.claude/agents/validador.md`, `~/.claude/agents/documentador.md`
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
