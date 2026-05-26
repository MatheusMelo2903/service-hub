# Handoff — Blindagem Entrega 1 (Service Hub)

**Data:** 2026-05-25
**Branch:** `dev` (5 commits sobre `main` `7f90bd1`)
**Status:** ✅ todo o código em dev, validado por smoke test local. AGUARDANDO Mateus pra aplicar em prod.

---

## ✅ O que foi feito em dev

| Fase | Entrega | Commit |
|---|---|---|
| 0 | Branch `dev` criada · Railway env `dev` criado | — |
| 1 | RLS + policy `authenticated_full_access` em `condominios` e `demandas` (migration SQL) | `844f087` |
| 2 | server.js: auth middleware (Bearer JWT Supabase OU INTERNAL_API_SECRET) + rate-limit 60req/min/IP + CORS configurável + `/api/config` público | `fc656dd` |
| 3 | `auth-bootstrap.js` (modal login Supabase Auth) + `index.html` usa /api/config + supaFetch com JWT do user + apiAuthFetch nas 5 chamadas `/api/*` | `c0eff54` |
| 4 | Sonnet 4.6 + Haiku 4.5 (alias sem data) + 5 menções "Claude" → "assistente" na UI | `2f1f4e5` |

## ✅ Smoke test local (rodado agora, em `PORT=4321`)

```
GET /api/config                          → 200 ✓
POST /api/claude/messages (sem token)    → 401 ✓ (auth fechando)
POST /api/claude/messages (token interno)→ 500 ✓ (passou auth, falhou por falta de ANTHROPIC_KEY local)
GET /                                    → 200 ✓ (landing pública preservada)
```

## ⚠️ Decisões importantes

1. **`hub_progresso` (tracker.html) ficou FORA da Entrega 1.** Tracker é PWA standalone com user-modal próprio; forçar login Supabase quebra UX offline. Vira Entrega 1.1 quando ajustar tracker pra login Supabase.
2. **Login só no `index.html` (Hub principal).** Landing e tracker continuam públicos.
3. **2 modos de auth no backend:** Bearer JWT (user logado) OU Bearer INTERNAL_API_SECRET (fallback). Frontend usa JWT; smoke/cron/curl pode usar INTERNAL.
4. **Zero deps novas no backend.** Rate-limit em memória, JWT verify via crypto built-in.
5. **Tracker.html não foi tocado** — segue com publishable key hardcoded e sem RLS. Aceitável temporariamente (20 tarefas internas, risco baixo).

---

## 🛑 PLANO DE MERGE — dev → main (prod)

**Eu não vou executar nada disso sem autorização explícita.** Estes são os passos quando você der "pode subir":

### Pré-requisitos (você precisa fazer ANTES do merge)

1. **Criar projeto Supabase dev** (se quiser testar antes em ambiente isolado — opcional pra Entrega 1 já que validei com smoke local)
   - Atalho: pular dev Supabase, ir direto pro prod com cuidado (risco gerenciado abaixo)

2. **No Supabase de PROD (`mtucxdfepkwsfnqpfydb`):**
   - Habilitar Supabase Auth (Authentication → Providers → Email)
   - Criar 2 usuários (Authentication → Users → Add user):
     - User 1: `email1@dominio` · senha · user_metadata `{"access_level": "total"}`
     - User 2: `email2@dominio` · senha · user_metadata `{"access_level": "restrito"}`
   - **Pegar o JWT secret:** Settings → API → JWT Secret (vai precisar pro Railway)

3. **No Railway PROD (env production do projeto eloquent-love):**
   - `railway variables --service service-hub --set SUPABASE_URL=$URL`
   - `railway variables --service service-hub --set SUPABASE_ANON_KEY=$ANON_KEY`
   - `railway variables --service service-hub --set SUPABASE_JWT_SECRET=$JWT_SECRET`
   - `railway variables --service service-hub --set INTERNAL_API_SECRET=$(openssl rand -hex 32)`
   - `railway variables --service service-hub --set CORS_ORIGINS=https://service-hub-production.up.railway.app`
   - (`ANTHROPIC_KEY` e `ASSEMBLYAI_KEY` já existem ✓)

### Ordem CRÍTICA do merge

⚠️ **Ordem importa.** Se rodar RLS antes do login estar em prod, sistema para (anon sem JWT não passa). Se setar ENVs depois do deploy, /api/config volta vazio e o login não carrega config.

```
1. Setar ENVs no Railway PROD (NÃO faz deploy ainda — só seta)
2. Aplicar SQL: migrations/2026-05-25_001_enable_rls.sql no Supabase Studio de PROD
   → Confirma RLS ligado em condominios e demandas via:
   SELECT tablename, rowsecurity FROM pg_tables
   WHERE schemaname='public' AND tablename IN ('condominios','demandas');
   → Esperado: rowsecurity = true
3. Merge dev → main (PR ou direct push — sua escolha):
   gh pr create --base main --head dev --title "feat: blindagem Entrega 1" --body "..."
   OU
   git checkout main && git merge dev && git push origin main
4. Railway redeploya automático (~1min)
5. Smoke test em prod:
   curl -I https://service-hub-production.up.railway.app/             → 200
   curl https://service-hub-production.up.railway.app/api/config      → {supabaseUrl:"...",supabaseAnonKey:"..."}
   curl -X POST .../api/claude/messages                              → 401 (sem auth)
6. Abrir https://service-hub-production.up.railway.app/hub no browser:
   - Modal de login aparece ✓
   - Logar com user 1 → entra ✓
   - Listar condomínios funciona ✓ (RLS + JWT)
   - Tentar /tracker.html → ainda funciona (não foi tocado) ✓
```

### Riscos do merge e mitigações

| Risco | Probabilidade | Mitigação |
|---|---|---|
| RLS bloqueia queries existentes | Média | Policy é `auth.role()='authenticated'` — só exige login. Se usuário logado consegue, passa. |
| /api/config retorna vazio (ENV faltando) | Alta se esquecer passo 1 | Validar com curl ANTES do merge. Se vazio, frontend mostra "Configuração ausente". |
| User 1 / User 2 não criados antes do merge | Alta se esquecer passo 2 | Sem user válido, ninguém consegue logar. Criar ANTES de mergear. |
| Rate-limit 60req/min muito agressivo | Baixa | Default OK pra 2 users; se reclamar, ajustar `RATE_LIMIT_MAX` em env (sem redeploy) |
| Tracker quebra | Baixa | Não tocado. Segue funcionando com publishable key + sem RLS. |
| Cache do browser segura JS antigo | Média | Pedir hard reload Cmd+Shift+R |

### Rollback (se algo der errado)

```bash
# Reverter código (Railway redeploya):
git revert HEAD --no-edit && git push origin main

# Reverter RLS no Supabase (rodar o bloco "ROLLBACK" da migration):
ALTER TABLE condominios DISABLE ROW LEVEL SECURITY;
ALTER TABLE demandas DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_full_access" ON condominios;
DROP POLICY IF EXISTS "authenticated_full_access" ON demandas;
```

---

## 📋 Pra você decidir antes de eu subir

1. **Pula Supabase dev?** Pode pular se aceitar risco gerenciado acima. Recomendado: pular pela urgência de segunda, validar direto em prod com hard rollback pronto.
2. **Nome "assistente" está OK?** Ou prefere "Service Hub IA"?
3. **2 users:** quais emails/senhas? Eu não crio — você cria no Supabase Studio.
4. **CORS_ORIGINS:** vai liberar só `service-hub-production.up.railway.app` ou também o domínio dev quando existir?
5. **Quem aperta o botão?** Eu posso executar os 5 passos do merge se você autorizar explicitamente, OU você executa cada passo e eu acompanho.

---

## Próximo (Entrega 2, fora dessa sessão)

- RLS policies granulares por empresa/módulo (não só "authenticated_full_access")
- Login Supabase no tracker.html + RLS em hub_progresso
- Limpar resíduos (`tracker-pwa.html`, `service-hub.md`, `service-hub-tracker.html`)
- UI de admin pra criar/gerenciar users (hoje só via Supabase Studio)
- Auditoria detalhada dos 52 `innerHTML` em index.html (XSS audit)
