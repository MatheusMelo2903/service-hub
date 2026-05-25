---
name: ops
description: Operações do Service Hub — rotação de secrets (Superlógica, Anthropic, internal), smoke test em produção, validação visual via Chrome MCP. Use SEMPRE que rotacionar credenciais expostas, validar mudanças em produção, ou diagnosticar comportamento da UI. Esta skill consolida runbooks operacionais; sem ela, rotações viram drift e validações viram suposição.
---

# Operações — Service Hub

> Skill adaptada da `ops` do `clinicmanager-erp` (2026-05-25). Stack do Service Hub: HTML vanilla + Express, hospedado no Railway (`eloquent-love`). Sem build step.

## Rotação de Secrets

**Comando único:** `bash scripts/rotate-secrets-sh.sh`

Cobre o secret interno automatizável. Tokens de terceiros (Anthropic, Superlógica) o script apenas lembra de rotacionar no console respectivo — não há API self-serve.

### 4 categorias de secret no projeto

| Categoria | Exemplo | Procedimento |
|---|---|---|
| **ENV simples** | `INTERNAL_API_SECRET` (hex 32B) | `openssl rand -hex 32` + setar no Railway via CLI |
| **Token API externo** | `ANTHROPIC_API_KEY` | Regenerar em console.anthropic.com → setar no Railway |
| **Tokens Superlógica** | `SUPERLOGICA_APP_TOKEN`, `SUPERLOGICA_ACCESS_TOKEN` | Regenerar no painel Superlógica → setar **no proxy** (não no Hub) → testar |
| **CLI auth** | `RAILWAY_API_TOKEN` | Regenerar em railway.app → atualizar `~/.railwayrc` local |

### Regras invioláveis na rotação

- `Railway CLI`: sempre `--set KEY=$VAR` — **NUNCA** `--set KEY=valor` (vai pro shell history)
- Após rotacionar: `history -c` imediatamente
- Tokens Superlógica vivem no `superlogica-proxy` (repo separado), **NUNCA** no Hub frontend
- Hub só conhece a URL do proxy (`https://superlogica-proxy-production.up.railway.app`) — proxy guarda os secrets

### Sintomas que disparam rotação

- Credencial exposta em log/screenshot/commit
- Suspeita de vazamento via dependência comprometida
- Funcionário com acesso saiu da equipe
- Auditoria periódica trimestral

### Onde fica cada secret

| Secret | Repo / serviço |
|---|---|
| `ANTHROPIC_API_KEY` | Railway → service-hub (Hub) |
| `INTERNAL_API_SECRET` | Railway → service-hub (Hub) |
| `SUPERLOGICA_APP_TOKEN` | Railway → superlogica-proxy |
| `SUPERLOGICA_ACCESS_TOKEN` | Railway → superlogica-proxy |
| `RAILWAY_API_TOKEN` | local `~/.railwayrc` apenas |

---

## Smoke Test em Produção

**Comando:** `bash scripts/smoke-prod.sh` (a criar — backlog)

Asserts mínimos:

1. `GET https://service-hub-production.up.railway.app/` → 200 (landing)
2. `GET .../hub` → 200 (app)
3. `GET .../tracker.html` → 200 (PWA)
4. `GET https://superlogica-proxy-production.up.railway.app/health` → 200

### Quando rodar

- Pós-deploy Railway (sempre)
- Pós-rotação de qualquer secret
- Antes de fechar PR que toca `server.js` ou `public/*`
- Diariamente em cron (TODO — backlog)

---

## Validação Visual em Produção

Validar mudança em prod sem suposição. Padrão Chrome MCP.

### Pattern correto

**NÃO confiar em `document.readyState === 'complete'`** sozinho para PWAs com cache (tracker.html via service worker). Aguardar elemento esperado existir.

**Pattern aprovado:**

```javascript
// 1. Navegar
await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

// 2. Aguardar elemento esperado (não confiar apenas em load)
await page.waitForSelector('[data-testid="hub-dashboard"]', { timeout: 10000 });

// 3. Inspecionar via evaluate_script — não DOM snapshot raw
const value = await page.evaluate(() =>
  document.querySelector('[data-testid="superlogica-status"]')?.textContent?.trim()
);
```

### Quando usar

- Confirmar deploy Railway propagou (HTML servido na versão nova)
- Validar UI de rota nova depois de mudança em `index.html`
- Confirmar fluxo Superlógica via proxy
- Validar identidade visual (Plus Jakarta Sans + JetBrains Mono)

### Anti-pattern: cliques em coordenadas

NUNCA clicar em coordenadas `(x, y)` — quebra ao primeiro CSS que mexe layout. Use seletores estáveis (`data-testid`, role, text content).

---

## Multi-aba Claude Code — coordenação

Quando há mais de uma sessão Claude Code rodando no mesmo repo:

### Regras invioláveis

- `git add` por NOME — **NUNCA** `git add -A`. Stage do arquivo errado = stage do trabalho de outra aba.
- Antes de matar processo Node desconhecido: `ps -lf` para verificar PPID. Se for de outra aba, **não matar** — perguntar ao operador.
- `git status` no início de cada commit — se aparecer arquivo modificado que você não tocou, é de outra aba. Não stage.
- **Re-verificar branch antes de cada commit** — working tree é compartilhada; outra aba pode ter feito `git checkout` em silêncio.

### Resolução de conflito de commit

Se duas abas commitaram simultaneamente em `main`:

```bash
git fetch origin main
git rev-list --left-right --count HEAD...origin/main
# Resultado "X Y": X commits locais à frente, Y atrás
# Se Y > 0: rebase
git pull --rebase origin main
```

Se o rebase tiver conflitos: parar e perguntar ao operador. Não resolver por conta — risco de descartar trabalho da outra aba.

---

## Pré-voo de sessão (checklist)

Antes de qualquer edição:

```bash
pwd                                # esperado: /Users/.../service-hub
git branch --show-current          # PARAR se não for main (ou branch esperada)
git status --short                 # detectar trabalho de outras abas
git pull --rebase origin main      # sincronizar
node --check server.js             # syntax básico (sem build no Hub)
```

ENVs críticas (sem imprimir valores):

```bash
# Local (dev) — checar via Railway CLI:
railway variables --service [SERVICE_ID] | awk '{print $1}' | grep -E "ANTHROPIC|SUPERLOGICA|INTERNAL_API"

# Esperado: 5 variáveis no Hub + 2 no proxy
```

### Comando proibido

```bash
# ❌ NUNCA — vaza ~50 secrets no transcript
railway variables --json

# ✅ filtrar antes de imprimir
railway variables --service [SERVICE_ID] | awk '{print $1}'
```
