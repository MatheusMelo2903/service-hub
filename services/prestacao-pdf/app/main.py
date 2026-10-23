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
import json
import os
import shutil
import sys
import tempfile
import time
import traceback

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from starlette.concurrency import run_in_threadpool

from .auth import verificar_secret
from .detector import detectar_tipo
from .pipeline import converter_pdf, gerar_deck, orquestrar, orquestrar_multi_fonte
from .prosa import ProsaDeterministica
from . import v13
from . import v13_superlogica
from . import certidoes_deck
from . import apresentacao

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
                if estrutura:
                    # Com ajuste de estrutura, a falha e do ajuste (ex.: nome longo nao coube):
                    # nao troca a composicao da IA pela automatica; avisa o motivo.
                    _log("v13_estrutura_reprovada", motivo=str(e)[:200])
                    raise _422("O ajuste de estrutura não coube na apresentação: " + str(e), "estrutura")
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
                if estrutura:
                    raise _422("O ajuste de estrutura não coube na apresentação: " + str(e), "estrutura")
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


# ─────────────────────────────────────────────────────────────────────────
# Certidões dentro da prestação: acrescenta um slide por certidão no fim do
# PowerPoint e do PDF já gerados (app/certidoes_deck.py). O Hub manda os arquivos
# da prestação guardada e as certidões válidas do condomínio, em base64.
# ─────────────────────────────────────────────────────────────────────────

def _b64(v, campo: str, limite_mb: int) -> bytes | None:
    if not v:
        return None
    if not isinstance(v, str):
        raise _422(f"Campo {campo} inválido.", "payload_invalido")
    try:
        dado = base64.b64decode(v, validate=True)
    except Exception:
        raise _422(f"Campo {campo} inválido.", "payload_invalido")
    if len(dado) > limite_mb * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail={"erro": "upload_muito_grande", "limite_mb": limite_mb})
    return dado


@app.post("/v13/certidoes")
async def v13_certidoes(
    payload: dict = Body(...),
    _: None = Depends(verificar_secret),
):
    inicio_t = time.perf_counter()
    pptx = _b64(payload.get("pptx_b64"), "pptx_b64", 40)
    pdf = _b64(payload.get("pdf_b64"), "pdf_b64", 40)
    if pdf is not None and pdf[:4] != b"%PDF":
        raise _422("O PDF da prestação está inválido.", "payload_invalido")
    certs = []
    for c in (payload.get("certidoes") or [])[:certidoes_deck.MAX_CERTIDOES]:
        if not isinstance(c, dict):
            continue
        dado = _b64(c.get("pdf_b64"), "certidoes.pdf_b64", 10)
        if not dado or dado[:4] != b"%PDF":
            raise _422("Uma das certidões não é PDF.", "payload_invalido")
        certs.append({k: (str(c.get(k))[:120] if c.get(k) is not None else None)
                      for k in ("tipo", "nome", "situacao", "emitida_em", "validade")} | {"pdf": dado})
    tmpdir = tempfile.mkdtemp(prefix="prestcert_")
    try:
        try:
            r = await run_in_threadpool(certidoes_deck.anexar, pptx, pdf, certs, tmpdir)
        except v13.ErroPrestacao as e:
            _log("v13_certidoes_recusou", motivo=str(e)[:200])
            raise _422(str(e), "certidoes")
        _log("v13_certidoes_ok", certidoes=len(certs), slides=r["slides"],
             duracao_ms=int((time.perf_counter() - inicio_t) * 1000))
        return {
            "pptx_b64": base64.b64encode(r["pptx"]).decode("ascii") if r["pptx"] else None,
            "pdf_b64": base64.b64encode(r["pdf"]).decode("ascii") if r["pdf"] else None,
            "slides": r["slides"],
        }
    except HTTPException:
        raise
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail={"erro": "certidoes_falhou", "acao": "revisao_humana"})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ─────────────────────────────────────────────────────────────────────────
# Apresentação de assembleia: o Hub manda o ROTEIRO (JSON montado pela IA a partir
# do edital e dos documentos), as fotos e os PDFs citados nele e, opcionalmente,
# a logo do cliente. O motor de layouts (app/apresentacao.py) desenha cada slide na
# identidade do Grupo Service e devolve PPTX, PDF e a lista de avisos.
# ─────────────────────────────────────────────────────────────────────────

AP_MAX_FOTOS = 80
AP_MAX_DOCS = 30
AP_MAX_SLIDES = 80
AP_MAX_CORPO = 160 * 1024 * 1024
AP_MAX_PAGINAS = 160
AP_MAX_LER = 90 * 1024 * 1024       # PPTX de até ~60 MB em base64


def _ap_422(detalhe: str):
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                         detail={"erro": "entrada_invalida", "detalhe": detalhe})


def _ap_b64(v, nome: str) -> bytes:
    if not isinstance(v, str) or not v:
        raise _ap_422(f"O arquivo {nome} veio vazio.")
    try:
        return base64.b64decode(v, validate=True)
    except Exception:
        raise _ap_422(f"O arquivo {nome} não está em base64 válido.")


def _ap_lista(payload: dict, campo: str, limite: int, rotulo: str) -> dict:
    itens = payload.get(campo) or []
    if not isinstance(itens, list):
        raise _ap_422(f"O campo {campo} precisa ser uma lista.")
    if len(itens) > limite:
        raise _ap_422(f"No máximo {limite} {rotulo} por apresentação; vieram {len(itens)}.")
    saida = {}
    for i, it in enumerate(itens):
        if not isinstance(it, dict) or not isinstance(it.get("id"), str) or not it["id"].strip():
            raise _ap_422(f"O item {i + 1} de {campo} precisa de id e b64.")
        fid = it["id"].strip()[:80]
        saida[fid] = _ap_b64(it.get("b64"), f'{rotulo[:-1] if rotulo.endswith("s") else rotulo} "{fid}"')
    return saida


def _ap_paginas(payload: dict) -> dict:
    """Páginas de documento já desenhadas (modo atualizar): [{id, pagina, total?, b64}]
    viram {id: {"total": n, "paginas": {pagina: bytes}}}."""
    itens = payload.get("documentos_paginas") or []
    if not isinstance(itens, list):
        raise _ap_422("O campo documentos_paginas precisa ser uma lista.")
    if len(itens) > AP_MAX_PAGINAS:
        raise _ap_422(f"No máximo {AP_MAX_PAGINAS} páginas de documento por apresentação; vieram {len(itens)}.")
    saida = {}
    for i, it in enumerate(itens):
        pag = it.get("pagina") if isinstance(it, dict) else None
        if (not isinstance(it, dict) or not isinstance(it.get("id"), str) or not it["id"].strip()
                or isinstance(pag, bool) or not isinstance(pag, int) or not 0 < pag < 5000):
            raise _ap_422(f"A página {i + 1} de documentos_paginas precisa de id, pagina e b64.")
        did = it["id"].strip()[:80]
        doc = saida.setdefault(did, {"total": None, "paginas": {}})
        tot = it.get("total")
        if isinstance(tot, int) and not isinstance(tot, bool) and 0 < tot < 5000:
            doc["total"] = max(doc["total"] or 0, tot)
        doc["paginas"][pag] = _ap_b64(it.get("b64"), f'página {pag} do documento "{did}"')
    return saida


@app.post("/v13/apresentacao/ler")
async def v13_apresentacao_ler(
    request: Request,
    _: None = Depends(verificar_secret),
):
    """Modo atualizar: devolve o roteiro, as fotos, as páginas de documento e a logo que
    estão dentro de um PPTX gerado pelo sistema. PPTX de fora: 422 sem_roteiro."""
    tam = request.headers.get("content-length")
    if tam and tam.isdigit() and int(tam) > AP_MAX_LER:
        raise _ap_422("A apresentação passou do tamanho aceito.")
    corpo = await request.body()
    if len(corpo) > AP_MAX_LER:
        raise _ap_422("A apresentação passou do tamanho aceito.")
    try:
        payload = json.loads(corpo)
    except Exception:
        raise _ap_422("O corpo do pedido não é um JSON válido.")
    corpo = None
    if not isinstance(payload, dict):
        raise _ap_422("O corpo do pedido precisa ser um objeto JSON.")
    dado = _ap_b64(payload.get("pptx_b64"), "da apresentação")
    payload = None
    try:
        r = await run_in_threadpool(apresentacao.ler, dado)
    except apresentacao.SemRoteiro as e:
        _log("v13_apresentacao_ler_sem_roteiro", motivo=str(e)[:80])
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail={"erro": "sem_roteiro", "detalhe": "Esta apresentação não foi gerada pelo sistema. Gere uma nova."})
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail={"erro": "leitura_falhou", "acao": "revisao_humana"})
    _log("v13_apresentacao_ler_ok", slides=len(r["roteiro"].get("slides") or []), fotos=len(r["fotos"]),
         paginas=len(r["documentos_paginas"]))
    return r


@app.post("/v13/apresentacao")
async def v13_apresentacao(
    request: Request,
    _: None = Depends(verificar_secret),
):
    inicio_t = time.perf_counter()
    tam = request.headers.get("content-length")
    if tam and tam.isdigit() and int(tam) > AP_MAX_CORPO:
        raise _ap_422("O pedido passou de 160 MB. Envie menos fotos ou documentos menores.")
    corpo = await request.body()
    if len(corpo) > AP_MAX_CORPO:
        raise _ap_422("O pedido passou de 160 MB. Envie menos fotos ou documentos menores.")
    try:
        payload = json.loads(corpo)
    except Exception:
        raise _ap_422("O corpo do pedido não é um JSON válido.")
    if not isinstance(payload, dict):
        raise _ap_422("O corpo do pedido precisa ser um objeto JSON.")
    roteiro = payload.get("roteiro")
    if not isinstance(roteiro, dict) or not isinstance(roteiro.get("slides"), list) or not roteiro["slides"]:
        raise _ap_422("O roteiro precisa ter a lista de slides.")
    if len(roteiro["slides"]) > AP_MAX_SLIDES:
        raise _ap_422(f"O roteiro tem {len(roteiro['slides'])} slides; o máximo é {AP_MAX_SLIDES}.")
    fotos = _ap_lista(payload, "fotos", AP_MAX_FOTOS, "fotos")
    # Modo atualizar: como cada foto antiga foi mostrada (inteira ou recortada).
    graficos = {it["id"].strip()[:80]: it["grafico"] for it in (payload.get("fotos") or [])
                if isinstance(it, dict) and isinstance(it.get("id"), str) and isinstance(it.get("grafico"), bool)}
    documentos = _ap_lista(payload, "documentos", AP_MAX_DOCS, "documentos")
    for did, dado in documentos.items():
        if dado[:4] != b"%PDF":
            raise _ap_422(f'O documento "{did}" não é PDF.')
    paginas = _ap_paginas(payload)
    logo = None
    if payload.get("logo_cliente_b64"):
        logo = _ap_b64(payload.get("logo_cliente_b64"), "logo do cliente")
    corpo = None  # libera a memória do corpo cru antes de montar
    tmpdir = tempfile.mkdtemp(prefix="apresent_")
    try:
        try:
            pptx_b, pdf_b, avisos, n = await run_in_threadpool(
                apresentacao.montar, roteiro, fotos, documentos, tmpdir, logo, paginas, graficos)
        except v13.ErroPrestacao as e:
            _log("v13_apresentacao_recusou", motivo=str(e)[:200])
            raise _ap_422(str(e))
        _log("v13_apresentacao_ok", slides=n, fotos=len(fotos),
             duracao_ms=int((time.perf_counter() - inicio_t) * 1000))
        return {
            "pptx_b64": base64.b64encode(pptx_b).decode("ascii"),
            "pdf_b64": base64.b64encode(pdf_b).decode("ascii"),
            "slides": n,
            "avisos": avisos,
        }
    except HTTPException:
        raise
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail={"erro": "apresentacao_falhou", "acao": "revisao_humana"})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
