"""Hash determinístico de entidade para o diff incremental (nosso, sem delta nativo).

raw_hash = sha256 do JSON canônico (chaves ordenadas, sem espaços). Mesma entrada
sempre gera o mesmo hash, então o diff de Fase 3 só atualiza o que mudou de fato.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any


def raw_hash(obj: Any) -> str:
    """sha256 hex do payload canonicalizado. Estável entre execuções."""
    canon = json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(canon.encode('utf-8')).hexdigest()
