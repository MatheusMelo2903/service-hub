"""FastAPI — superlogica-sync (Frente B).

Serviço de sincronização Superlógica -> Supabase. Só LEITURA na Superlógica.
CRON PURO no Railway: o container executa `python -m app.sync` e morre.
Não há HTTP server permanente em produção/dev no Railway.

O app FastAPI + /healthz existe SOMENTE como utilitário local para conferir ENVs
sem vazar valores (rodar `uvicorn app.main:app` manualmente em dev; não é
iniciado pelo Railway).

Endpoints (uso local/dev):
    GET /healthz   — health check sem auth; reporta presença das ENVs (sem valor)

Decisões travadas:
    - Serviço no Railway (projeto eloquent-love), separado do proxy.
    - TUDO em DEV nesta frente. Não toca prod.
    - Token da Superlógica e service_role vêm de ENV do Railway, nunca de arquivo.
"""
from __future__ import annotations

from fastapi import FastAPI

from .config import env_presente

_VERSAO = '1.0.0'

app = FastAPI(
    title='Superlógica Sync',
    version=_VERSAO,
    docs_url=None,     # sem Swagger em produção
    redoc_url=None,
)


@app.get('/healthz')
async def healthz():
    """Health check sem autenticação — utilitário LOCAL apenas (não roda no Railway).

    Reporta quais variáveis de ambiente estão setadas (bool, sem valor),
    para o operador conferir o setup em dev sem vazar segredo.
    """
    return {
        'status': 'ok',
        'servico': 'superlogica-sync',
        'versao': _VERSAO,
        'env': env_presente(),
    }
