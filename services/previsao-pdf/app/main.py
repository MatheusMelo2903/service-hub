"""FastAPI - Microservico de Geracao de Apresentacao (PPTX + PDF).

Recebe payload de previsao (Fase 3) + config de rateio, gera PPTX via
python-pptx (Carlito), converte para PDF via libreoffice headless,
retorna ambos como base64 ao server.js. Sem acesso ao Supabase.

Endpoints:
    GET  /healthz      - health check sem auth
    POST /gerar        - gera PPTX + PDF, retorna base64

Autenticacao: X-Internal-Secret validado com hmac.compare_digest.
Timeout do server.js para este servico: 180s.
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.responses import JSONResponse

from .adapter import adaptar
from .auth import verificar_secret
from .builder_pptx import Builder, calcular_taxas
from .schemas import GerarRequest, GerarResponse

_VERSAO = '1.0.0'
LOGO_PATH = str(Path(__file__).resolve().parent.parent / 'assets' / 'logo_service_white.png')

app = FastAPI(
    title='Previsao PDF API',
    version=_VERSAO,
    docs_url=None,
    redoc_url=None,
)


@app.get('/healthz')
async def healthz():
    """Health check sem autenticacao - usado pelo Railway."""
    return {'status': 'ok', 'versao': _VERSAO}


@app.post('/gerar', response_model=GerarResponse)
async def gerar(
    req: GerarRequest,
    _: None = Depends(verificar_secret),
) -> GerarResponse:
    """Gera PPTX + PDF a partir do payload. Retorna ambos em base64."""
    inicio = time.perf_counter()
    tmpdir = tempfile.mkdtemp(prefix='previsao_pdf_')
    pptx_path = os.path.join(tmpdir, f'{req.previsao_id}.pptx')
    pdf_path = None

    try:
        # 1) Adapter
        dados = adaptar(req.payload_json, req.config_rateio.model_dump())
        taxas = calcular_taxas(dados)

        # 2) Builder PPTX
        builder = Builder(dados, taxas, logo_path=LOGO_PATH)
        prs = builder.build()
        prs.save(pptx_path)

        # 3) Conversor PDF (subprocess libreoffice)
        from .converter import converter_para_pdf
        pdf_path = converter_para_pdf(pptx_path, outdir=tmpdir)

        # 4) Read bytes + base64
        with open(pptx_path, 'rb') as f:
            pptx_bytes = f.read()
        with open(pdf_path, 'rb') as f:
            pdf_bytes = f.read()

        duracao_ms = int((time.perf_counter() - inicio) * 1000)

        return GerarResponse(
            pptx_b64=base64.b64encode(pptx_bytes).decode('ascii'),
            pdf_b64=base64.b64encode(pdf_bytes).decode('ascii'),
            duracao_ms=duracao_ms,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={'erro': 'payload_invalido', 'detalhe': str(e)[:200]},
        )
    except Exception:
        traceback.print_exc()  # stderr -> log interno Railway
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={'erro': 'geracao_falhou'},
        )
    finally:
        # Limpa arquivos temporarios mesmo em caso de erro
        for p in (pptx_path, pdf_path):
            if p and os.path.exists(p):
                try:
                    os.unlink(p)
                except OSError:
                    pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass
