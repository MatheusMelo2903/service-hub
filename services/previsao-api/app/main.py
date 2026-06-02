"""FastAPI — Microservico de Extracao de Previsao Orcamentaria.

Recebe PDFs W011A (despesas 12 meses) e W045A (fracoes ideais) do Superlogica
via multipart/form-data e retorna JSON estruturado com 8 grupos canonicos.

Endpoints:
    GET  /healthz         — health check sem auth
    POST /extrair-pdfs    — extracao com autenticacao X-Internal-Secret

Autenticacao: Bearer via X-Internal-Secret validado com hmac.compare_digest.
Timeout do Service Hub para este servico: 120s.
"""
from __future__ import annotations

import time
from io import BytesIO

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, status

from .auth import verificar_secret
from .parser import identificar_tipo_pdf, montar_response, parsear_w011a, parsear_w045a
from .schemas import PrevisaoResponse

_VERSAO = '1.1.0'

app = FastAPI(
    title='Previsão Orçamentária API',
    version=_VERSAO,
    docs_url=None,     # desabilita Swagger em producao
    redoc_url=None,
)


@app.get('/healthz')
async def healthz():
    """Health check sem autenticacao — usado pelo Railway e load balancer."""
    return {'status': 'ok', 'versao': _VERSAO}


@app.post('/extrair-pdfs', response_model=PrevisaoResponse)
async def extrair_pdfs(
    w011a: UploadFile = File(...),
    w045a: UploadFile | None = File(default=None),
    _: None = Depends(verificar_secret),
) -> PrevisaoResponse:
    """Extrai dados de previsao orcamentaria a partir dos PDFs do Superlogica.

    w011a: PDF W011A obrigatorio (demonstrativo de despesas 12 meses).
    w045a: PDF W045A opcional (fracoes ideais das unidades).

    Retorna PrevisaoResponse com 8 grupos canonicos + subcategorias.
    """
    inicio = time.perf_counter()

    try:
        # Le os bytes do W011A e valida o tipo
        bytes_w011a = await w011a.read()
        tipo_w011a = identificar_tipo_pdf(BytesIO(bytes_w011a))
        if tipo_w011a != 'W011A':
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    'erro': 'pdf_invalido',
                    'detalhe': f'Esperado W011A, recebido {tipo_w011a}',
                },
            )

        # Processa W011A
        dados_w011 = parsear_w011a(BytesIO(bytes_w011a))

        # Processa W045A se fornecido
        dados_w045: list[dict] = []
        if w045a is not None:
            bytes_w045a = await w045a.read()
            tipo_w045a = identificar_tipo_pdf(BytesIO(bytes_w045a))
            if tipo_w045a != 'W045A':
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={
                        'erro': 'pdf_invalido',
                        'detalhe': f'Esperado W045A, recebido {tipo_w045a}',
                    },
                )
            dados_w045 = parsear_w045a(BytesIO(bytes_w045a))

        duracao_ms = int((time.perf_counter() - inicio) * 1000)
        return montar_response(dados_w011, dados_w045, duracao_ms)

    except HTTPException:
        raise
    except Exception:
        import traceback
        # Stack completo vai pro stderr (logs internos do Railway).
        # Cliente recebe apenas mensagem genérica pra não vazar caminhos ou módulos internos.
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={'erro': 'extracao_falhou'},
        )
