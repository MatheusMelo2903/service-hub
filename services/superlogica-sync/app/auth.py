"""Autenticação do superlogica-sync — valida X-Internal-Secret (timing-safe).

Mesmo padrão dos outros microserviços do Hub (previsao-api, prestacao-pdf):
o segredo vem de INTERNAL_API_SECRET (env do Railway), validado com
hmac.compare_digest. Sem a ENV, o serviço rejeita tudo (fail-safe 503).
"""
from __future__ import annotations

import hmac
import os

from fastapi import Header, HTTPException, status

# Lido no import (não re-lê a cada request). Setado via Railway, nunca em arquivo.
INTERNAL_API_SECRET = os.getenv('INTERNAL_API_SECRET', '')


async def verificar_secret(x_internal_secret: str = Header(default='')) -> None:
    """Depends FastAPI: valida X-Internal-Secret contra INTERNAL_API_SECRET.

    503 se a ENV não estiver configurada (melhor 503 do que 200 sem auth).
    401 se o header faltar ou não bater.
    """
    if not INTERNAL_API_SECRET:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='auth_nao_configurada',
        )
    if not x_internal_secret or not hmac.compare_digest(
        x_internal_secret, INTERNAL_API_SECRET
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='secret_invalido',
        )
