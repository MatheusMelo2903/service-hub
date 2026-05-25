# PROJECT CONTEXT — Service Hub

> Stack, ENVs, URLs. Sem secrets.

---

## Identidade

- **Nome:** Service Hub
- **Dono:** Matheus (V8S / Grupo Service co-founder)
- **Repo:** https://github.com/MatheusMelo2903/service-hub (público)
- **Railway project codename:** `eloquent-love`
- **Domínios:**
  - Produção: https://service-hub-production.up.railway.app
  - Landing: https://service-hub-production.up.railway.app/
  - App: https://service-hub-production.up.railway.app/hub
  - Tracker PWA: https://service-hub-production.up.railway.app/tracker.html

---

## Stack

```
HTML único (index.html — 5338 linhas) + CSS/JS embutido
Express.js (server.js) — serve estáticos + rotas
Sem framework (vanilla)
Bibliotecas:
  - SheetJS (xlsx) — parsing de planilhas
  - Supabase JS v2 — tracker.html
Railway — hospedagem
GitHub — deploy via push
```

## Integrações ativas

| Sistema | Como | Auth |
|---|---|---|
| Superlógica ERP | via proxy intermediário | `app_token` + `access_token` (proxy guarda) |
| Anthropic Claude | direto `/v1/messages` | `ANTHROPIC_API_KEY` |
| Supabase (tracker) | client-side anon key | anon JWT (público) |

## Proxy Superlógica

- URL: https://superlogica-proxy-production.up.railway.app
- Repo: https://github.com/MatheusMelo2903/superlogica-proxy
- Razão: CORS + esconder tokens do frontend

---

## ENVs (nomes apenas — nunca valores)

| Variável | Onde mora | Função |
|---|---|---|
| `ANTHROPIC_API_KEY` | Railway (Hub) | gerar atas, relatórios |
| `SUPERLOGICA_APP_TOKEN` | Railway (proxy) | auth Superlógica |
| `SUPERLOGICA_ACCESS_TOKEN` | Railway (proxy) | auth Superlógica |
| `INTERNAL_API_SECRET` | Railway (Hub) | endpoints internos |
| `RAILWAY_API_TOKEN` | local dev | Railway CLI |

Para rotação ver `.claude/skills/ops/SKILL.md` + `scripts/rotate-secrets-sh.sh`.

---

## Estrutura de rotas (Express)

```
GET /            → public/landing.html
GET /hub         → public/index.html (app principal)
GET /tracker.html → public/tracker.html (PWA Supabase)
GET /<arquivo>   → public/* (estáticos, com index: false)
GET *            → redirect → /
```

`server.js` usa `express.static({ index: false })` com rotas explícitas.

---

## Quem trabalha aqui

- **Mateus** — product owner, gestor V8S, não programa
- **Matheus de Melo** — comercial / planejamento
- **Sócio dev (Adriano)** — backend / V8S
- **Claude Code** — implementação, audit, validação

---

## Convencões de código (do CLAUDE.md)

- HTML: kebab-case (`modal-cliente`)
- JS: camelCase (`carregarUnidades`); CONSTANTES em UPPER_CASE
- Comentários em português, explicando POR QUÊ
- Sem libs novas sem aprovação do Matheus
- Edição GitHub: sempre Safari, nunca Chrome
- Tokens NUNCA no frontend

---

## Referências cruzadas

| Pra entender... | Ler |
|---|---|
| Visão produto | `PANORAMA_ESTRATEGICO.md` |
| Sprint atual | `MISSION_CONTROL.md` |
| Roadmap 14 dias | `PLANO_ATIVO.md` |
| Auditoria atual | `AUDITORIA_PROJETO.md` |
| Audit das skills MC | `AUDITORIA_SKILLS_MC_PARA_SH.md` |
| Skills MC reutilizáveis | `.claude/skills/` |
| Subagentes | `.claude/agents/` |
| Runbook deploy | `docs/03-RUNBOOK-DEPLOY.md` |
| Skill master service-hub | `.claude/skills/service-hub/SKILL.md` |
