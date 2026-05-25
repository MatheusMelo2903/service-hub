#!/usr/bin/env bash
# Rotação de secrets Service Hub
# Uso: bash scripts/rotate-secrets-sh.sh [SERVICE_ID]
#
# Automatiza só INTERNAL_API_SECRET. Tokens externos (Anthropic, Superlógica)
# precisam de regeneração manual no console respectivo — o script lembra.

set -euo pipefail

SERVICE_ID="${1:-}"

if [ -z "$SERVICE_ID" ]; then
  echo "⚠️  Uso: bash scripts/rotate-secrets-sh.sh <RAILWAY_SERVICE_ID>"
  echo "    Pegue o SERVICE_ID em railway.app → settings → Service ID"
  exit 1
fi

echo "🔄 Rotação de secrets — Service Hub"
echo "Service ID: $SERVICE_ID"
echo ""

# ── 1. INTERNAL_API_SECRET (automatizável) ──────────────────────────────
echo "▶ INTERNAL_API_SECRET"
NEW_SECRET=$(openssl rand -hex 32)
echo "  ✓ Gerado novo (32B hex)"

read -rp "  Setar agora no Railway? [y/N] " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  railway variables --service "$SERVICE_ID" --set INTERNAL_API_SECRET="$NEW_SECRET" \
    && echo "  ✓ Setado no Railway"
  unset NEW_SECRET
else
  echo "  ⏭️  Pulado — secret descartado"
  unset NEW_SECRET
fi
echo ""

# ── 2. ANTHROPIC_API_KEY (manual) ────────────────────────────────────────
echo "▶ ANTHROPIC_API_KEY"
echo "  ⚠️  Manual: console.anthropic.com → Settings → API Keys"
echo "  1) Crie nova key"
echo "  2) Cole aqui:"
read -rsp "  ANTHROPIC_API_KEY=" NEW_KEY; echo ""
if [ -n "$NEW_KEY" ]; then
  railway variables --service "$SERVICE_ID" --set ANTHROPIC_API_KEY="$NEW_KEY" \
    && echo "  ✓ Setado no Railway"
  unset NEW_KEY
  echo "  ⚠️  Lembre de DELETAR a key antiga em console.anthropic.com"
else
  echo "  ⏭️  Vazio — pulado"
fi
echo ""

# ── 3. Superlógica (manual, no proxy — não no Hub) ──────────────────────
echo "▶ SUPERLOGICA tokens (app_token, access_token)"
echo "  ⚠️  Manual:"
echo "  1) Painel Superlógica → Configurações → API"
echo "  2) Gerar novo par (app_token, access_token)"
echo "  3) Setar no service 'superlogica-proxy' (NÃO no Hub):"
echo "       railway variables --service <PROXY_SERVICE_ID> --set SUPERLOGICA_APP_TOKEN=\$VAR"
echo "       railway variables --service <PROXY_SERVICE_ID> --set SUPERLOGICA_ACCESS_TOKEN=\$VAR"
echo "  4) Testar:"
echo "       curl https://superlogica-proxy-production.up.railway.app/health"
echo ""

# ── 4. Limpar history ───────────────────────────────────────────────────
echo "🧹 Limpando shell history..."
history -c 2>/dev/null || true
echo "  ✓ history -c executado (no shell atual)"
echo ""

# ── 5. Validação ────────────────────────────────────────────────────────
echo "✅ Validação:"
railway variables --service "$SERVICE_ID" | awk '{print $1}' \
  | grep -E "^(INTERNAL_API_SECRET|ANTHROPIC_API_KEY)$" \
  && echo "  ✓ Variáveis presentes no Railway"

echo ""
echo "✅ Rotação concluída."
echo ""
echo "Próximos passos manuais:"
echo "  • Trigger redeploy no Railway (push vazio ou via dashboard)"
echo "  • bash scripts/smoke-prod.sh (quando existir)"
echo "  • Atualizar MISSION_CONTROL.md com data da rotação"
