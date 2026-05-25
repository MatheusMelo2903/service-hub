# AUDITORIA TÉCNICA — Service Hub

**Data:** 2026-05-25
**Tipo:** snapshot superficial (auditoria completa pendente — ver `PLANO_ATIVO.md`)

---

## Estrutura atual do repo

```
service-hub/
├── public/
│   ├── index.html       (5338 linhas — app principal Hub)
│   ├── landing.html     (landing pública /)
│   ├── tracker.html     (PWA Supabase /tracker.html)
│   └── tracker-pwa.html (RESÍDUO — checar se deve ser removido)
├── server.js            (Express + rotas explícitas)
├── package.json
├── CLAUDE.md            (100 linhas — context + regras)
├── CHANGELOG.md
├── service-hub.md       (não-padrão; checar propósito)
├── service-hub-tracker.html (não-padrão; resíduo?)
├── MIGRATION_*.sql      (2 arquivos; migrações Supabase)
├── docs/                (PDFs + .md de sessões)
└── tarefas/             (em-andamento, concluidas, ideias-arquivadas)
```

## Pontos vermelhos identificados

1. **`tracker-pwa.html` ainda presente** — foi renomeado pra `tracker.html` em commit `40d33ee`, mas pode ter sido recriado depois. Confirmar com Matheus se deve ser removido.
2. **`service-hub.md` + `service-hub-tracker.html`** — arquivos fora do padrão (não são docs/, não são public/). Origem desconhecida.
3. **`MIGRATION_*.sql` na raiz** — deveria viver em `docs/migrations/` ou `db/`.
4. **Sem `.claude/agents/` populado** — CLAUDE.md menciona arquitetos, programador, revisor, auditor, etc., mas nenhum existe (foi resolvido nesta sessão).
5. **`tarefas/` sem template recente** — existe `modelo.md` mas precisa revisão pós-protocolo.

## Saúde técnica (heurística)

| Sinal | Estado | Nota |
|---|---|---|
| Build local | ✅ HTML estático, sem build step | server.js só serve arquivos |
| Deploy Railway | ✅ ativo | https://service-hub-production.up.railway.app |
| Push → deploy | ✅ funciona | testado a sessão inteira (tracker fixes) |
| Versionamento | ✅ git + GitHub | commits semânticos |
| Secrets no front | 🔴 Supabase anon key em tracker.html | aceitável pra anon, mas auditar |
| Subagentes | 🟡 documentados, não implementados | resolvido nesta sessão |
| Skills locais | 🟡 nenhuma | resolvido nesta sessão |
| Testes | 🔴 inexistentes | backlog |
| Lint/format | 🔴 sem ESLint, sem prettier | backlog |

## Tokens e segurança

- `app_token` e `access_token` do Superlógica **NÃO** estão neste repo — ficam no proxy (repo separado `superlogica-proxy`)
- `ANTHROPIC_API_KEY` no Railway (Hub) — não está no repo
- Supabase anon key em `tracker.html` — exposta por design (anon)

## Próxima auditoria completa

Após PANORAMA fechado e PLANO_ATIVO definido, fazer:
- Auditoria de dependências (npm audit)
- Auditoria de rotas Express vs landing/index links
- Auditoria de tokens / endpoints sensíveis
- Análise de performance (Lighthouse)
- Conferir paridade com a skill `service-hub` do Matheus (que mencionou `Hoje_atualizado_pp.html` — pode haver desvio)
