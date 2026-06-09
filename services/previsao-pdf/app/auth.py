"""Middleware de autenticacao do microservico Previsao Orcamentaria.

Valida o header X-Internal-Secret usando hmac.compare_digest (timing-safe).
O segredo eh lido da variavel de ambiente INTERNAL_API_SECRET, que deve ser
a mesma configurada no server.js do Service Hub. Sem ela o servico rejeita tudo.
"""
from __future__ import annotations

import hmac
import os

from fastapi import Header, HTTPException, status


# Lido no import para nao re-ler a ENV a cada request (performance).
# Em prod, setar via `railway variables --set INTERNAL_API_SECRET=...`
INTERNAL_API_SECRET = os.getenv('INTERNAL_API_SECRET', '')


async def verificar_secret(x_internal_secret: str = Header(default='')) -> None:
    """Depends FastAPI: valida X-Internal-Secret contra INTERNAL_API_SECRET.

    Usa hmac.compare_digest para evitar timing attack. Levanta 503 se a ENV
    nao estiver configurada (fail-safe: melhor 503 do que 200 sem auth).
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
