"""Wrapper de subprocess pra LibreOffice headless converter PPTX em PDF.

Aceita caminho do PPTX, devolve caminho do PDF gerado na mesma pasta.
Timeout 120s - se LibreOffice travar (acontece em payloads complexos),
levantamos TimeoutExpired e o handler do main devolve 503 ao cliente.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def converter_para_pdf(pptx_path: str, outdir: str | None = None) -> str:
    """Converte PPTX em PDF via libreoffice --headless. Retorna o caminho do PDF.

    Levanta subprocess.TimeoutExpired apos 120s. Levanta RuntimeError se o PDF
    esperado nao aparecer (LibreOffice exit code 0 mas sem saida e sintoma de
    falha silenciosa do soffice).
    """
    if outdir is None:
        outdir = str(Path(pptx_path).parent)

    # O container roda como appuser SEM home (--no-create-home no Dockerfile).
    # Sem um perfil gravavel, o soffice morre com "cannot be started" (exit 77).
    # Damos a ele um UserInstallation dentro do tmpdir da requisicao (sempre
    # gravavel) e setamos HOME pra cache do fontconfig. Perfil isolado por
    # request tambem evita contencao de lock entre chamadas concorrentes.
    profile_dir = os.path.join(outdir, '.lo_profile')
    cmd = [
        'libreoffice',
        '--headless',
        f'-env:UserInstallation=file://{profile_dir}',
        '--convert-to', 'pdf',
        '--outdir', outdir,
        pptx_path,
    ]

    proc = subprocess.run(
        cmd,
        capture_output=True,
        timeout=120,
        check=False,
        env={**os.environ, 'HOME': outdir},
    )

    if proc.returncode != 0:
        # stderr vai pro log do Railway. NAO retornar pro cliente.
        print(f'[converter] soffice exit={proc.returncode}', file=sys.stderr)
        print(f'[converter] stderr: {proc.stderr.decode("utf-8", errors="replace")}', file=sys.stderr)
        raise RuntimeError('libreoffice_falhou')

    base = Path(pptx_path).stem
    pdf_path = Path(outdir) / f'{base}.pdf'
    if not pdf_path.exists():
        raise RuntimeError('pdf_nao_gerado')
    return str(pdf_path)
