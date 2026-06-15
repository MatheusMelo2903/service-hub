"""Cliente REST v2 condor da Superlógica — SÓ LEITURA.

Achados do survey que este módulo respeita:
  - Base https://api.superlogica.net/v2/condor, headers app_token + access_token.
  - Lê por id: GET /condominios?id=X e GET /unidades?idCondominio=X&itensPorPagina=50&pagina=N.
  - Payload de condomínio é aninhado: [{ "condominio": [ {..} ] }].
  - Paginação de unidades é base 0; última página vem com menos que itensPorPagina.
  - Sem header de rate limit: ritmo conservador (~1 a 2 req/s) e PARAR no primeiro 429.

Tokens vêm SEMPRE de variável de ambiente (Railway dev). Nunca de arquivo, nunca embutido.
"""
from __future__ import annotations

import os
import time

import httpx

from .config import (
    ENV_ACCESS_TOKEN,
    ENV_APP_TOKEN,
    PAGINA_TAMANHO,
    REQ_INTERVALO_S,
    SUPERLOGICA_BASE_URL,
)


class RateLimitError(RuntimeError):
    """Levantada ao receber HTTP 429. Não insistir; parar o lote."""


class TokenAusenteError(RuntimeError):
    """Levantada quando app_token/access_token não estão no ambiente."""


def _headers() -> dict[str, str]:
    app = os.getenv(ENV_APP_TOKEN)
    access = os.getenv(ENV_ACCESS_TOKEN)
    if not app or not access:
        raise TokenAusenteError(
            f'{ENV_APP_TOKEN}/{ENV_ACCESS_TOKEN} ausentes no ambiente. '
            'Setar via Railway dev; nunca em arquivo.'
        )
    return {
        'Content-Type': 'application/json',
        'app_token': app,
        'access_token': access,
        'User-Agent': 'superlogica-sync/0.1 (read-only)',
    }


def _get(client: httpx.Client, path: str, params: dict) -> httpx.Response:
    """GET com tratamento de 429 (levanta RateLimitError)."""
    resp = client.get(
        SUPERLOGICA_BASE_URL + path,
        params=params,
        headers=_headers(),
        timeout=30.0,
    )
    if resp.status_code == 429:
        raise RateLimitError(f'429 em {path} (params={list(params.keys())})')
    return resp


def ler_condominio(
    cid: int | str,
    client: httpx.Client | None = None,
) -> tuple[int, dict | None]:
    """GET /condominios?id=cid. Retorna (status_http, registro_cru | None).

    Desaninha o payload [{ "condominio": [ {..} ] }] para o dict de campos.
    Se `client` for passado, reutiliza-o (evita abrir conexão por condomínio no
    loop do sync). Se None, cria um próprio (mantém compatibilidade com smoke).
    """
    def _executar(c: httpx.Client) -> tuple[int, dict | None]:
        resp = _get(c, '/condominios', {'id': cid})
        if resp.status_code != 200:
            return resp.status_code, None
        try:
            data = resp.json()
        except ValueError:
            return resp.status_code, None
        reg = None
        if isinstance(data, list) and data:
            bloco = data[0]
            if isinstance(bloco, dict):
                cond = bloco.get('condominio')
                if isinstance(cond, list) and cond:
                    reg = cond[0]
                else:
                    reg = bloco
        return resp.status_code, reg

    if client is not None:
        return _executar(client)
    with httpx.Client() as c:
        return _executar(c)


def ler_unidades(
    cid: int | str,
    max_paginas: int = 400,
    client: httpx.Client | None = None,
) -> list[dict]:
    """GET /unidades?idCondominio=cid paginado (base 0). Retorna lista crua.

    Para na última página (len < PAGINA_TAMANHO), em status != 200, ou no 429
    (que sobe como RateLimitError). Dorme REQ_INTERVALO_S entre páginas.
    Se `client` for passado, reutiliza-o (evita abrir conexão por condomínio no
    loop do sync). Se None, cria um próprio (mantém compatibilidade com smoke).
    """
    def _executar(c: httpx.Client) -> list[dict]:
        out: list[dict] = []
        for pg in range(max_paginas):
            resp = _get(
                c,
                '/unidades',
                {'idCondominio': cid, 'itensPorPagina': PAGINA_TAMANHO, 'pagina': pg},
            )
            if resp.status_code != 200:
                break
            try:
                lst = resp.json()
            except ValueError:
                break
            if not isinstance(lst, list) or not lst:
                break
            out.extend(lst)
            if len(lst) < PAGINA_TAMANHO:
                break
            time.sleep(REQ_INTERVALO_S)
        return out

    if client is not None:
        return _executar(client)
    out: list[dict] = []
    with httpx.Client() as c:
        return _executar(c)
