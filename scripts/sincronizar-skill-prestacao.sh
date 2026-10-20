#!/usr/bin/env bash
# Copia a skill powerpoint-prestacao-contas para dentro do Hub, para o Hub gerar
# exatamente o que a skill gera no Claude.
#   services/prestacao-pdf/vendor/skill_v13  -> scripts, fontes, logo e references (motor)
#   skills-server/prestacao-v13              -> regras da composição usadas na curadoria por IA
# Uso: scripts/sincronizar-skill-prestacao.sh /caminho/da/skill/powerpoint-prestacao-contas
set -euo pipefail

ORIGEM="${1:?informe a pasta da skill powerpoint-prestacao-contas}"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$RAIZ/services/prestacao-pdf/vendor/skill_v13"
REF="$RAIZ/skills-server/prestacao-v13"

for f in SKILL.md scripts/extrair.py scripts/montar.py scripts/gerador.py references/composicao.md; do
  [ -f "$ORIGEM/$f" ] || { echo "Arquivo esperado não encontrado na skill: $f" >&2; exit 1; }
done

rm -rf "$DEST"
mkdir -p "$DEST" "$REF"
cp -R "$ORIGEM"/SKILL.md "$ORIGEM"/scripts "$ORIGEM"/references "$ORIGEM"/assets "$DEST"/
find "$DEST" -name '__pycache__' -type d -prune -exec rm -rf {} +
cp "$ORIGEM/references/composicao.md" "$REF/"
cp "$ORIGEM/references/exemplo_composicao_buritis.json" "$REF/" 2>/dev/null || true

echo "Skill sincronizada em:"
echo "  $DEST"
echo "  $REF"
echo "Agora rode o teste do motor e faça o deploy do prestacao-pdf e do service-hub."
