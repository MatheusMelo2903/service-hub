# -*- coding: utf-8 -*-
"""Imagens EMF e WMF dos PowerPoints da apresentação de assembleia (rota /v13/imagens/converter).

O navegador não abre EMF nem WMF (formato vetorial do Windows, comum quando alguém cola uma
tabela do Excel ou um print no PowerPoint). Até 23/10/2026 essas imagens eram descartadas e,
no teste da AGE da Fazenda Barão do Império, os números da prestação de contas sumiram junto.
Aqui cada imagem vira JPEG:
  1. confere que o arquivo é mesmo EMF ou WMF (pela assinatura do começo do arquivo), para
     nunca entregar outro tipo de arquivo ao LibreOffice;
  2. converte todas numa chamada só do LibreOffice (EMF/WMF para PDF) e desenha o PDF em
     200 dpi com o pdftoppm; sem pdftoppm, pede PNG direto ao LibreOffice; o que o LibreOffice
     não abrir tenta pelo inkscape, se existir no container;
  3. corta a borda branca (o LibreOffice põe a imagem numa página A4) e devolve a versão de
     1600px (JPEG 0.85) e a miniatura de 384px (JPEG 0.7) usada na triagem barata.
Falha numa imagem não derruba as outras: ela volta com ok=False e o motivo.
"""
from __future__ import annotations

import base64
import io
import os
import shutil
import subprocess

from PIL import Image, ImageChops

MAX_IMAGENS = 20
MAX_BYTES = 10 * 1024 * 1024
LADO = 1600
LADO_MINI = 384
DPI = 200
FORMATOS = ("emf", "wmf")


class ErroEntrada(Exception):
    """Pedido inválido (mensagem pronta para o Hub)."""


def formato_real(dado: bytes) -> str | None:
    """'emf', 'wmf' ou None pela assinatura do arquivo (não confia na extensão)."""
    if len(dado) >= 44 and dado[:4] == b"\x01\x00\x00\x00" and dado[40:44] == b" EMF":
        return "emf"
    if dado[:4] == b"\xd7\xcd\xc6\x9a":  # WMF com cabeçalho "placeable"
        return "wmf"
    if len(dado) >= 18 and dado[:4] in (b"\x01\x00\x09\x00", b"\x02\x00\x09\x00"):
        return "wmf"
    return None


def _ler_pedido(itens) -> list[dict]:
    if not isinstance(itens, list) or not itens:
        raise ErroEntrada("Envie a lista de imagens.")
    if len(itens) > MAX_IMAGENS:
        raise ErroEntrada(f"No máximo {MAX_IMAGENS} imagens por pedido; vieram {len(itens)}.")
    out = []
    for i, it in enumerate(itens):
        if not isinstance(it, dict) or not isinstance(it.get("b64"), str):
            raise ErroEntrada(f"A imagem {i + 1} veio sem conteúdo.")
        iid = str(it.get("id") or i + 1)[:40]
        if len(it["b64"]) > (MAX_BYTES // 3 + 1) * 4:
            out.append({"id": iid, "erro": "grande demais"})
            continue
        try:
            dado = base64.b64decode(it["b64"], validate=True)
        except Exception:
            out.append({"id": iid, "erro": "conteúdo inválido"})
            continue
        fmt = formato_real(dado)
        if fmt is None or fmt != str(it.get("formato") or fmt).lower():
            out.append({"id": iid, "erro": "não é EMF nem WMF"})
            continue
        out.append({"id": iid, "dado": dado, "formato": fmt})
    return out


def _rodar(cmd: list[str], tmpdir: str, timeout: int) -> bool:
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout,
                              env={**os.environ, "HOME": tmpdir}, check=False)
        return proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _cortar_e_reduzir(caminho_png: str) -> dict | None:
    """PNG da página -> JPEG 1600 e miniatura 384, sem a borda branca."""
    with Image.open(caminho_png) as im:
        im.load()
        rgba = im.convert("RGBA")
    fundo = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    fundo.alpha_composite(rgba)
    rgb = fundo.convert("RGB")
    dif = ImageChops.difference(rgb, Image.new("RGB", rgb.size, (255, 255, 255))).convert("L")
    caixa = dif.point(lambda v: 255 if v > 12 else 0).getbbox()
    if not caixa:
        return None
    x0, y0, x1, y1 = caixa
    folga = max(4, int(0.02 * max(x1 - x0, y1 - y0)))
    rgb = rgb.crop((max(0, x0 - folga), max(0, y0 - folga), min(rgb.width, x1 + folga), min(rgb.height, y1 + folga)))

    def jpeg(img: Image.Image, lado: int, qualidade: int) -> str:
        k = min(1.0, lado / max(img.width, img.height))
        if k < 1.0:
            img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=qualidade, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii")

    grande = jpeg(rgb, LADO, 85)
    k = min(1.0, LADO / max(rgb.width, rgb.height))
    return {"b64": grande, "b64_mini": jpeg(rgb, LADO_MINI, 70),
            "largura": max(1, round(rgb.width * k)), "altura": max(1, round(rgb.height * k))}


def converter(itens, tmpdir: str, soffice: str | None = None) -> list[dict]:
    """[{id, formato, b64}] -> [{id, ok, b64?, b64_mini?, largura?, altura?, motivo?}] na mesma ordem."""
    pedido = _ler_pedido(itens)
    soffice = soffice or os.environ.get("SOFFICE_BIN", "libreoffice")
    entrada = os.path.join(tmpdir, "entrada")
    saida = os.path.join(tmpdir, "saida")
    os.makedirs(entrada, exist_ok=True)
    os.makedirs(saida, exist_ok=True)
    arquivos = {}
    for i, p in enumerate(pedido):
        if "dado" not in p:
            continue
        cam = os.path.join(entrada, f"img_{i:02d}.{p['formato']}")
        with open(cam, "wb") as f:
            f.write(p["dado"])
        arquivos[i] = cam

    pdftoppm = shutil.which("pdftoppm")
    perfil = f"-env:UserInstallation=file://{os.path.join(tmpdir, '.lo_profile')}"
    if arquivos and shutil.which(soffice):
        alvo = "pdf" if pdftoppm else "png"
        # Uma chamada só para todas: o LibreOffice frio leva segundos para abrir.
        _rodar([soffice, "--headless", perfil, "--convert-to", alvo, "--outdir", saida] + list(arquivos.values()), tmpdir, 150)
    inkscape = shutil.which("inkscape")

    resultado = []
    for i, p in enumerate(pedido):
        if "dado" not in p:
            resultado.append({"id": p["id"], "ok": False, "motivo": p.get("erro") or "inválida"})
            continue
        base = os.path.join(saida, f"img_{i:02d}")
        png = None
        if pdftoppm and os.path.exists(base + ".pdf"):
            if _rodar([pdftoppm, "-r", str(DPI), "-png", "-singlefile", "-f", "1", "-l", "1", base + ".pdf", base], tmpdir, 60) \
                    and os.path.exists(base + ".png"):
                png = base + ".png"
        elif os.path.exists(base + ".png"):
            png = base + ".png"
        if png is None and inkscape:
            if _rodar([inkscape, arquivos[i], "--export-type=png", f"--export-dpi={DPI}", f"--export-filename={base}_ink.png"], tmpdir, 60) \
                    and os.path.exists(base + "_ink.png"):
                png = base + "_ink.png"
        if png is None:
            resultado.append({"id": p["id"], "ok": False, "motivo": "não converteu"})
            continue
        try:
            r = _cortar_e_reduzir(png)
        except Exception:
            r = None
        if not r:
            resultado.append({"id": p["id"], "ok": False, "motivo": "imagem em branco"})
            continue
        resultado.append({"id": p["id"], "ok": True, **r})
    return resultado
