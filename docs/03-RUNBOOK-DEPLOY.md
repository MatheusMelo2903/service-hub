# 03 — Runbook de Deploy

> Procedimentos Railway, push to main, monitoramento.

**Status:** placeholder (preencher após próximo deploy de produção real)

## Fluxo padrão

1. Commit local com mensagem semântica
2. `git push origin main`
3. Railway detecta push, faz deploy automático (~1min)
4. Validar:
   - `curl -I https://service-hub-production.up.railway.app` → 200
   - Abrir rota afetada no browser
   - `validator-v2` se houver mudança visual

## Hot rollback

```bash
git revert HEAD
git push origin main
# Railway redeploya na versão anterior
```

## Logs

```bash
railway logs --service [SERVICE_ID]
# ou via Railway dashboard
```

## ENVs

```bash
# listar nomes (NUNCA dumpar valor cru — vide memory)
railway variables --service [SERVICE_ID] | awk '{print $1}'

# setar (sempre via $VAR, nunca valor literal)
railway variables --service [SERVICE_ID] --set NOME=$VALOR
```

## Em caso de incidente

1. Conferir Railway status: https://status.railway.app
2. Conferir Supabase status (se afetar tracker): https://status.supabase.com
3. Conferir Anthropic status (se afetar atas/relatórios): https://status.anthropic.com
4. Se for código: revert + push
5. Se for env: ver `.claude/skills/ops/SKILL.md`

## Métricas que valem a pena olhar (TODO)

- Tempo de deploy médio
- Taxa de erro 5xx por dia
- Uso de CPU/RAM no Railway
- Quota Anthropic (tokens/mês)
- Rate limit Superlógica
