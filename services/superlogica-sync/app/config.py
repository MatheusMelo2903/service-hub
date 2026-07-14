"""Configuração do superlogica-sync — leitura de ambiente, ZERO segredo embutido.

Todos os valores vêm de variáveis de ambiente do Railway (env dev nesta frente).
Este módulo NÃO contém nenhum token, nem fallback com valor real. Em dev, o
Mateus seta as variáveis no Railway; o código só lê os nomes.

Variáveis esperadas (setadas no Railway dev, nunca em arquivo):
    SUPERLOGICA_APP_TOKEN       — app_token da REST v2 condor (só leitura)
    SUPERLOGICA_ACCESS_TOKEN    — access_token da REST v2 condor
    SUPABASE_URL                — URL do projeto Supabase DEV (ledgyprytkuvgtbunsck)
    SUPABASE_SERVICE_ROLE_KEY   — service_role do Supabase DEV (escrita server side)
    INTERNAL_API_SECRET         — segredo compartilhado com o server.js do Hub
"""
from __future__ import annotations

import os

# Base da REST v2 condor (achado do survey; só leitura nesta frente inteira).
SUPERLOGICA_BASE_URL = 'https://api.superlogica.net/v2/condor'

# Ritmo seguro observado no survey: sem header de rate limit, ~1 a 2 req/s,
# lote 50, parar no primeiro 429. Constantes ficam aqui para a lógica futura.
REQ_INTERVALO_S = 0.7          # ~1,4 req/s sequencial
PAGINA_TAMANHO = 50            # itensPorPagina no /unidades (paginação base 0)

# Nomes das variáveis de ambiente (lidos sob demanda; valores nunca logados).
ENV_APP_TOKEN = 'SUPERLOGICA_APP_TOKEN'
ENV_ACCESS_TOKEN = 'SUPERLOGICA_ACCESS_TOKEN'
ENV_SUPABASE_URL = 'SUPABASE_URL'
ENV_SUPABASE_SERVICE_ROLE = 'SUPABASE_SERVICE_ROLE_KEY'
ENV_INTERNAL_SECRET = 'INTERNAL_API_SECRET'


def env_presente() -> dict[str, bool]:
    """Retorna quais variáveis estão setadas (bool), SEM expor valor nenhum.

    Usado pelo /healthz para o operador conferir o setup no Railway dev sem
    vazar segredo. True = a variável existe e não está vazia.
    """
    return {
        'app_token': bool(os.getenv(ENV_APP_TOKEN)),
        'access_token': bool(os.getenv(ENV_ACCESS_TOKEN)),
        'supabase_url': bool(os.getenv(ENV_SUPABASE_URL)),
        'service_role': bool(os.getenv(ENV_SUPABASE_SERVICE_ROLE)),
        'internal_secret': bool(os.getenv(ENV_INTERNAL_SECRET)),
    }
