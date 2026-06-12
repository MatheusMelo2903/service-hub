"""FastAPI — superlogica-sync (Frente B).

Serviço de sincronização Superlógica -> Supabase. Só LEITURA na Superlógica.
ESQUELETO (Fase 1): healthz e estrutura. A lógica de sync entra nas fases
seguintes (leitura/validação -> diff/escrita Camada A -> Camada B -> cron).

Endpoints:
    GET /healthz   — health check sem auth; reporta presença das ENVs (sem valor)

Decisões travadas:
    - Serviço NOVO no Railway (projeto eloquent-love), separado do proxy.
    - TUDO em DEV nesta frente. Não toca prod.
    - Token da Superlógica e service_role vêm de ENV do Railway, nunca de arquivo.
"""
from __future__ import annotations

from fastapi import FastAPI

from .config import env_presente

_VERSAO = '0.1.0-esqueleto'

app = FastAPI(
    title='Superlógica Sync',
    version=_VERSAO,
    docs_url=None,     # sem Swagger em produção
    redoc_url=None,
)


@app.get('/healthz')
async def healthz():
    """Health check sem autenticação — usado pelo Railway.

    Reporta quais variáveis de ambiente estão setadas (bool, sem valor),
    para o operador conferir o setup no Railway dev sem vazar segredo.
    """
    return {
        'status': 'ok',
        'servico': 'superlogica-sync',
        'versao': _VERSAO,
        'env': env_presente(),
    }
