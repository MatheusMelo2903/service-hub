# 02 — Setup Dev Local

> Como rodar o Hub no seu Mac.

**Status:** placeholder

## Requisitos

- Node 20+
- npm
- gh CLI autenticado
- Railway CLI (se for mexer em ENVs)

## Setup

```bash
git clone git@github.com:MatheusMelo2903/service-hub.git
cd service-hub
npm install
node server.js
# abrir http://localhost:3000
```

## ENVs locais

Criar `.env` (gitignored):

```
PORT=3000
ANTHROPIC_API_KEY=...
INTERNAL_API_SECRET=...
```

Tokens Superlógica NÃO precisam estar localmente — proxy cuida em produção.

## Pra testar tracker.html localmente

Precisa do Supabase apontado em `tracker.html` (anon key pública). Funciona offline-first.

## Deploy

Push pra `main` → Railway redeploya em ~1min. Ver `03-RUNBOOK-DEPLOY.md`.
