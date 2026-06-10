# -*- coding: utf-8 -*-
"""FastAPI — Microserviço de Prestação de Contas (PPTX + PDF).

Recebe os W016A detalhados (um por sub-período), parseia deterministicamente,
monta o deck pela skill vendorizada, audita e converte. Sem acesso ao
Supabase: o server.js faz proxy autenticado e devolve o blob ao Hub.

Endpoints:
    GET  /healthz   - health check sem auth
    POST /gerar     - multipart com 1+ PDFs W016A -> { pptx_b64, pdf_b64, ... }

Degradação graciosa (decisão de produto pra primeira semana com revisão
humana): NUNCA entregar slide quebrado. Relatório em formato inesperado,
blocos não contíguos ou auditoria visual reprovada retornam 422 com o motivo
estruturado e acao="revisao_humana". Log claro no stderr (Railway).

Autenticação: X-Internal-Secret validado com hmac.compare_digest.
Timeout sugerido no proxy: 240s (LibreOffice frio chega a 60-90s).
"""
from __future__ import annotations

import base64
import os
import shutil
import sys
import tempfile
import time
import traceback

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, status

from .auth import verificar_secret
from .pipeline import converter_pdf, gerar_deck, orquestrar
from .prosa import ProsaDeterministica

_VERSAO = "1.0.0"

app = FastAPI(title="Prestacao PDF API", version=_VERSAO,
              docs_url=None, redoc_url=None)


def _log(evento: str, **campos):
    detalhes = " ".join(f"{k}={v}" for k, v in campos.items())
    print(f"[prestacao-pdf] {evento} {detalhes}", file=sys.stderr, flush=True)


@app.get("/healthz")
async def healthz():
    """Health check sem autenticação - usado pelo Railway."""
    return {"status": "ok", "versao": _VERSAO}


@app.post("/gerar")
async def gerar(
    arquivos: list[UploadFile] = File(...),
    _: None = Depends(verificar_secret),
):
    """Gera o deck a partir de 1+ W016A. Retorna PPTX e PDF em base64."""
    inicio = time.perf_counter()
    tmpdir = tempfile.mkdtemp(prefix="prestacao_")
    try:
        caminhos = []
        for i, up in enumerate(arquivos):
            if not (up.filename or "").lower().endswith(".pdf"):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={"erro": "arquivo_nao_pdf", "arquivo": up.filename,
                            "acao": "revisao_humana"})
            destino = os.path.join(tmpdir, f"w016a_{i:02d}.pdf")
            with open(destino, "wb") as f:
                f.write(await up.read())
            caminhos.append(destino)

        # 1) Parse deterministico + orquestracao (um bloco por demonstrativo).
        #    ValueError aqui = relatorio fora do formato ou blocos nao
        #    contiguos -> falha explicita, nunca deck improvisado.
        try:
            configs, capa = orquestrar(caminhos, prosa=ProsaDeterministica())
        except ValueError as e:
            _log("relatorio_invalido", motivo=str(e)[:300])
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"erro": "relatorio_invalido", "detalhe": str(e)[:300],
                        "acao": "revisao_humana"})

        # 2) Deck + auditoria visual obrigatoria. Reprovou -> nao entrega.
        pptx_path = os.path.join(tmpdir, "prestacao.pptx")
        try:
            gerar_deck(configs, pptx_path, capa=capa)
        except RuntimeError as e:
            _log("auditoria_reprovou", motivo=str(e)[:500])
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"erro": "auditoria_reprovou", "detalhe": str(e)[:500],
                        "acao": "revisao_humana"})

        # 3) PDF via LibreOffice headless.
        pdf_path = converter_pdf(pptx_path, tmpdir,
                                 soffice=os.environ.get("SOFFICE_BIN", "libreoffice"))

        with open(pptx_path, "rb") as f:
            pptx_bytes = f.read()
        with open(pdf_path, "rb") as f:
            pdf_bytes = f.read()

        duracao_ms = int((time.perf_counter() - inicio) * 1000)
        _log("gerado", blocos=len(configs), duracao_ms=duracao_ms,
             pdf_kb=len(pdf_bytes) // 1024)
        return {
            "pptx_b64": base64.b64encode(pptx_bytes).decode("ascii"),
            "pdf_b64": base64.b64encode(pdf_bytes).decode("ascii"),
            "blocos": len(configs),
            "duracao_ms": duracao_ms,
        }
    except HTTPException:
        raise
    except Exception:
        traceback.print_exc()  # stderr -> log interno Railway
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"erro": "geracao_falhou", "acao": "revisao_humana"})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
