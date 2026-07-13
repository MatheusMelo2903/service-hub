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
from .detector import detectar_tipo
from .pipeline import converter_pdf, gerar_deck, orquestrar, orquestrar_multi_fonte
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
        caminhos_e_tipos = []
        total_bytes = 0
        LIMITE_TOTAL = 50 * 1024 * 1024  # defesa em profundidade: o proxy ja limita 50MB
        for i, up in enumerate(arquivos):
            if not (up.filename or "").lower().endswith(".pdf"):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={"erro": "arquivo_nao_pdf", "arquivo": up.filename,
                            "mensagem": (f"O arquivo {up.filename} não é um PDF. "
                                         "Envie os relatórios do Superlógica em PDF "
                                         "(W011A, W015A, W016A ou W015P)."),
                            "acao": "revisao_humana"})
            conteudo = await up.read()
            total_bytes += len(conteudo)
            if total_bytes > LIMITE_TOTAL:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail={"erro": "upload_muito_grande", "limite_mb": 50,
                            "mensagem": ("Os arquivos somam mais de 50 MB. "
                                         "Envie menos relatórios por vez.")})
            destino = os.path.join(tmpdir, f"relatorio_{i:02d}.pdf")
            with open(destino, "wb") as f:
                f.write(conteudo)
            caminhos.append(destino)

        # Detecta o tipo de cada arquivo enviado.
        # Arquivo desconhecido dispara 422 imediato (nunca gera deck com dado duvidoso).
        fontes_detectadas = {"W011A": False, "W015A": False,
                             "W016A": False, "W015P": False}
        for cam in caminhos:
            tipo = detectar_tipo(cam)
            if tipo == "DESCONHECIDO":
                _log("tipo_desconhecido", arquivo=os.path.basename(cam))
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={"erro": "tipo_desconhecido",
                            "arquivo": os.path.basename(cam),
                            "mensagem": (
                                f"O arquivo {os.path.basename(cam)} não foi "
                                "reconhecido como um relatório do Superlógica "
                                "(W011A, W015A, W016A ou W015P). Confira o arquivo "
                                "antes de gerar."),
                            "acao": "revisao_humana"})
            caminhos_e_tipos.append((cam, tipo))
            fontes_detectadas[tipo] = True

        # Roteamento: todos W016A → fluxo legado (multi-período por W016A).
        # Qualquer W011A, W015A ou W015P → fluxo multi-fonte (único período).
        todos_w016a = all(t == "W016A" for _, t in caminhos_e_tipos)
        serie_mensal_ativa = False
        avisos_reconciliacao: list = []

        # 1) Parse deterministico + orquestracao.
        try:
            if todos_w016a:
                configs, capa = orquestrar(caminhos, prosa=ProsaDeterministica())
            else:
                configs, capa, serie_mensal_ativa, avisos_reconciliacao = \
                    orquestrar_multi_fonte(caminhos_e_tipos, prosa=ProsaDeterministica())
        except ValueError as e:
            motivo = str(e)
            # A mensagem carrega valores financeiros do condomínio e vai SÓ na
            # resposta HTTP, exibida ao operador (dado dele, que ele subiu). O log
            # recebe apenas a categoria, nunca o número (regra 2026-07-09).
            if motivo.startswith("reconciliacao_bloqueante"):
                _log("reconciliacao_bloqueante")
                mensagem = motivo[len("reconciliacao_bloqueante: "):]
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={"erro": "reconciliacao_bloqueante",
                            "mensagem": mensagem,
                            "acao": "revisao_humana"})
            _log("relatorio_invalido")
            # Mensagem integral (sem truncar): os parsers já a compõem em
            # português, nomeando arquivo e números.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"erro": "relatorio_invalido", "mensagem": motivo,
                        "acao": "revisao_humana"})

        # 2) Deck + auditoria visual obrigatoria. Reprovou -> nao entrega.
        pptx_path = os.path.join(tmpdir, "prestacao.pptx")
        try:
            gerar_deck(configs, pptx_path, capa=capa)
        except RuntimeError as e:
            # Detalhe da auditoria pode nomear a categoria que estourou o slide;
            # não loga (defesa de cifra), mensagem genérica ao operador.
            _log("auditoria_reprovou")
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"erro": "auditoria_reprovou",
                        "mensagem": ("A conferência final do deck não passou "
                                     "(uma tabela pode ter estourado o slide). "
                                     "Tente novamente; se persistir, avise o suporte."),
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
             pdf_kb=len(pdf_bytes) // 1024,
             serie_mensal=serie_mensal_ativa,
             avisos=len(avisos_reconciliacao))
        return {
            "pptx_b64": base64.b64encode(pptx_bytes).decode("ascii"),
            "pdf_b64": base64.b64encode(pdf_bytes).decode("ascii"),
            "blocos": len(configs),
            "duracao_ms": duracao_ms,
            "fontes_detectadas": fontes_detectadas,
            "serie_mensal_ativa": serie_mensal_ativa,
            "avisos_reconciliacao": avisos_reconciliacao,
            # Texto claro do aviso (qual fonte, qual período, qual base). None
            # quando não há divergência ou no fluxo legado de fonte única.
            "reconciliacao_resumo": (configs[0].get("_reconciliacao_resumo")
                                     if configs else None),
        }
    except HTTPException:
        raise
    except Exception:
        traceback.print_exc()  # stderr -> log interno Railway
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"erro": "geracao_falhou",
                    "mensagem": ("Falha inesperada ao gerar a prestação. "
                                 "Tente novamente; se persistir, avise o suporte."),
                    "acao": "revisao_humana"})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
