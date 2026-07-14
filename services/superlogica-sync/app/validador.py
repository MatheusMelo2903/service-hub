"""Validador de id_superlogica — distingue id real de id inválido.

Achado do survey: GET /condominios?id=X retorna 200 (real) vs 403/null (inválido).
Usado pela faxina da Fase 5 (reportar ids do Supabase que não existem na carteira).
"""
from __future__ import annotations

from .superlogica import ler_condominio


def validar_id(cid: int | str) -> dict:
    """Classifica um id_superlogica. NÃO escreve nada.

    Retorna {'id', 'valido': bool, 'status': http}. valido=True só com 200 + registro.
    """
    status, reg = ler_condominio(cid)
    return {
        'id': cid,
        'valido': bool(status == 200 and reg),
        'status': status,
    }
