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

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, UploadFile, status
from starlette.concurrency import run_in_threadpool

from .auth import verificar_secret
from .detector import detectar_tipo
from .pipeline import converter_pdf, gerar_deck, orquestrar, orquestrar_multi_fonte
from .prosa import ProsaDeterministica
from . import v13
from . import v13_superlogica

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
                            "acao": "revisao_humana"})
            conteudo = await up.read()
            total_bytes += len(conteudo)
            if total_bytes > LIMITE_TOTAL:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail={"erro": "upload_muito_grande", "limite_mb": 50})
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
            # Distingue bloqueio de reconciliação de erro genérico de relatório
            if motivo.startswith("reconciliacao_bloqueante"):
                _log("reconciliacao_bloqueante", motivo=motivo[:300])
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={"erro": "reconciliacao_bloqueante",
                            "alertas": motivo.replace("reconciliacao_bloqueante: ", "").split("; "),
                            "acao": "revisao_humana"})
            _log("relatorio_invalido", motivo=motivo[:300])
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"erro": "relatorio_invalido", "detalhe": motivo[:300],
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
            detail={"erro": "geracao_falhou", "acao": "revisao_humana"})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ─────────────────────────────────────────────────────────────────────────
# MOTOR v13: o mesmo codigo da skill powerpoint-prestacao-contas (vendor/skill_v13).
# Fluxo em duas etapas, orquestrado pelo server.js:
#   /v13/extrair  PDFs + periodo -> dados e rascunho (para quando algo nao fecha)
#   /v13/montar   dados + composicao (da IA ou automatica) -> PPTX e PDF auditados
# Entre as duas o server.js pode pedir ao Claude a curadoria da composicao.
# ─────────────────────────────────────────────────────────────────────────

def _422(msg: str, erro: str = "relatorio"):
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                         detail={"erro": erro, "detalhe": msg, "acao": "revisao_humana"})


@app.post("/v13/extrair")
async def v13_extrair(
    arquivos: list[UploadFile] = File(...),
    inicio: str = Form(...),
    fim: str = Form(...),
    _: None = Depends(verificar_secret),
):
    inicio_t = time.perf_counter()
    tmpdir = tempfile.mkdtemp(prefix="prest13_")
    try:
        caminhos, total = [], 0
        for i, up in enumerate(arquivos):
            if not (up.filename or "").lower().endswith(".pdf"):
                raise _422(f"O arquivo {up.filename} não é PDF. Envie os relatórios do Superlógica em PDF.", "arquivo_nao_pdf")
            conteudo = await up.read()
            total += len(conteudo)
            if total > 50 * 1024 * 1024:
                raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                                    detail={"erro": "upload_muito_grande", "limite_mb": 50})
            destino = os.path.join(tmpdir, f"relatorio_{i:02d}.pdf")
            with open(destino, "wb") as f:
                f.write(conteudo)
            caminhos.append(destino)
        try:
            r = await run_in_threadpool(v13.extrair, caminhos, inicio, fim, tmpdir)
        except v13.ErroPrestacao as e:
            _log("v13_extrair_recusou", motivo=str(e)[:200])
            raise _422(str(e))
        _log("v13_extraido", arquivos=len(caminhos), modo=r["dados"].get("modo"),
             duracao_ms=int((time.perf_counter() - inicio_t) * 1000))
        return r
    except HTTPException:
        raise
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail={"erro": "extracao_falhou", "acao": "revisao_humana"})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.post("/v13/de-superlogica")
async def v13_de_superlogica(
    payload: dict = Body(...),
    _: None = Depends(verificar_secret),
):
    """Mesma saida do /v13/extrair, mas a partir dos dados puxados do Superlogica
    pelo Hub (balancete mes a mes, saldo do caixa e despesas liquidadas)."""
    inicio_t = time.perf_counter()
    try:
        r = await run_in_threadpool(v13_superlogica.de_superlogica, payload)
    except v13_superlogica.ErroDados as e:
        _log("v13_superlogica_recusou", motivo=str(e)[:200])
        raise _422(str(e))
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail={"erro": "extracao_falhou", "acao": "revisao_humana"})
    _log("v13_superlogica_ok", rubricas=sum(len(c["rubricas"]) for c in r["dados"]["categorias"]),
         meses=len(r["dados"]["periodo"]), duracao_ms=int((time.perf_counter() - inicio_t) * 1000))
    return r


@app.post("/v13/montar")
async def v13_montar(
    payload: dict = Body(...),
    _: None = Depends(verificar_secret),
):
    inicio_t = time.perf_counter()
    dados = payload.get("dados")
    if not isinstance(dados, dict) or not dados.get("periodo"):
        raise _422("Dados da extração ausentes.", "payload_invalido")
    rascunho = payload.get("rascunho") or {}
    nome_hub = payload.get("nome") if isinstance(payload.get("nome"), str) else None
    comp_ia = payload.get("composicao_ia")
    try:
        estrutura = v13.sanear_estrutura(payload.get("estrutura"), dados)
    except v13.ErroPrestacao as e:
        raise _422(str(e), "estrutura")
    tmpdir = tempfile.mkdtemp(prefix="prest13m_")
    aviso = None
    try:
        origem = "automatica"
        if isinstance(comp_ia, dict):
            comp = v13.completar_composicao(comp_ia, dados, rascunho, nome_hub)
            if estrutura:
                comp["estrutura"] = estrutura
            try:
                res = await run_in_threadpool(v13.montar, dados, comp, tmpdir)
                origem = "ia"
            except v13.ErroPrestacao as e:
                # A curadoria da IA nao passou na conferencia (ex.: soma citada nao bate).
                # Refaz com a composicao automatica, que sempre fecha com o total.
                _log("v13_ia_reprovada", motivo=str(e)[:200])
                aviso = "A composição revisada não passou na conferência; usei a composição automática."
                comp = None
        else:
            comp = None
        if origem == "automatica":
            comp = v13.composicao_automatica(dados, rascunho, nome_hub)
            if estrutura:
                comp["estrutura"] = estrutura
            try:
                res = await run_in_threadpool(v13.montar, dados, comp, tmpdir)
            except v13.ErroPrestacao as e:
                _log("v13_montar_recusou", motivo=str(e)[:200])
                raise _422(str(e), "montagem")
        _log("v13_gerado", origem=origem, pdf_kb=len(res["pdf"]) // 1024, estrutura=bool(estrutura),
             duracao_ms=int((time.perf_counter() - inicio_t) * 1000))
        return {
            "pptx_b64": base64.b64encode(res["pptx"]).decode("ascii"),
            "pdf_b64": base64.b64encode(res["pdf"]).decode("ascii"),
            "nome_arquivo": res["nome"],
            "composicao": origem,
            "aviso": aviso,
            "modo": dados.get("modo"),
            "estrutura_aplicada": estrutura,
            # Lista para a tela "Ajustar estrutura" (nomes e totais, nada mais).
            "estrutura_base": [
                {"nome": c["nome"], "total": round(c.get("total") or 0, 2),
                 "rubricas": [{"chave": r["nome"],
                               "nome": ((comp.get("rubricas") or {}).get(r["nome"]) or {}).get("nome") or r.get("nome_exibicao") or r["nome"],
                               "total": round(r.get("total") or 0, 2)}
                              for r in sorted(c.get("rubricas") or [], key=lambda r: -(r.get("total") or 0))]}
                for c in sorted(dados.get("categorias") or [], key=lambda c: -(c.get("total") or 0))
            ],
            "resumo": {
                "saldo_anterior": dados.get("saldo_anterior"),
                "receitas": round(sum(dados.get("receitas_mes") or []), 2),
                "despesas": round(sum(dados.get("despesas_mes") or []), 2),
                "saldo_final": dados.get("saldo_final"),
                "meses": dados.get("meses_label"),
            },
        }
    except HTTPException:
        raise
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail={"erro": "geracao_falhou", "acao": "revisao_humana"})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
