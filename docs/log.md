# Log de mudanças — Service Hub

Registro cronológico de tarefas concluídas. Entrada mais recente no topo.

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
