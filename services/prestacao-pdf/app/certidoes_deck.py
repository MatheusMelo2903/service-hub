# -*- coding: utf-8 -*-
"""Certidões negativas dentro da prestação de contas (PDF e PowerPoint).

A prestação é gerada antes e as certidões costumam chegar depois. Por isso aqui não
se monta a prestação de novo: os slides das certidões são acrescentados ao final da
apresentação já gerada, um slide por certidão (certidão com mais de uma página ganha
um slide por página), com a página da certidão em alta resolução ao lado da situação,
da emissão e da validade.

  PowerPoint: os slides entram no fim do próprio arquivo gerado.
  PDF: os mesmos slides são montados numa apresentação só com eles, convertidos pelo
       LibreOffice e colados no fim do PDF gerado (pdfunite). O PDF da prestação não é
       convertido de novo, então fica idêntico ao que saiu na geração.

Visual: as primitivas e a paleta do gerador da skill (vendor/skill_v13/scripts/gerador.py),
sem alterar o gerador. O rodapé copia o texto do rodapé da própria apresentação.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops
from pptx import Presentation
from pptx.util import Inches

from .v13 import SCRIPTS, ErroPrestacao

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import gerador as G  # noqa: E402  (primitivas e paleta do padrão aprovado)

DPI = 220                 # nitidez para ler o texto da certidão ampliando o PDF
MAX_PAGINAS = 3           # por certidão; certidão maior que isso é exceção, entra o começo
MAX_CERTIDOES = 10
ORDEM = ['federal', 'estadual', 'municipal', 'trabalhista', 'fgts', 'falencia']

# Título (palavra de destaque em azul) e órgão emissor de cada tipo.
TITULOS = {
    'federal': ('Federal', 'Receita Federal e Procuradoria Geral da Fazenda Nacional'),
    'estadual': ('Estadual', 'Secretaria da Fazenda do Espírito Santo'),
    'municipal': ('Municipal', 'Prefeitura Municipal'),
    'trabalhista': ('Trabalhista', 'Tribunal Superior do Trabalho'),
    'fgts': ('do FGTS', 'Caixa Econômica Federal'),
    'falencia': ('de Falência', 'Tribunal de Justiça do Espírito Santo, falência e recuperação judicial'),
}
SITUACOES = {
    'negativa': ('NEGATIVA', 'Nada consta contra o condomínio.', G.GREEN),
    'positiva_com_efeito_negativa': ('POSITIVA COM EFEITO DE NEGATIVA',
                                     'Há pendência suspensa; vale como certidão negativa.', G.GREEN),
    'positiva': ('POSITIVA', 'Consta pendência em nome do condomínio.', G.RED),
}


def _data_br(iso) -> str:
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', str(iso or ''))
    return f'{m.group(3)}/{m.group(2)}/{m.group(1)}' if m else 'ver documento'


def _rodar(args: list[str], cwd: str, timeout: int = 120) -> subprocess.CompletedProcess:
    env = dict(os.environ, HOME=cwd)  # soffice precisa de perfil gravável
    try:
        return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise ErroPrestacao('A montagem das certidões demorou mais que o limite. Tente de novo.')


def _garante_fontes(pasta: str) -> None:
    """O LibreOffice precisa de Poppins e Inter para o PDF sair igual ao resto."""
    out = subprocess.run(['fc-list'], capture_output=True, text=True).stdout
    if 'Poppins' in out and 'Inter' in out:
        return
    dst = os.path.join(pasta, '.fonts')
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(G.FONTES):
        shutil.copy(os.path.join(G.FONTES, f), dst)
    subprocess.run(['fc-cache', '-f', dst], capture_output=True, env=dict(os.environ, HOME=pasta))


# ── páginas da certidão em imagem ──

def _recortar_margem(img: Image.Image) -> Image.Image:
    """Tira a margem branca da página (com uma folga) para o texto ficar maior no slide."""
    cinza = img.convert('L')
    fundo = Image.new('L', cinza.size, 255)
    diff = ImageChops.difference(cinza, fundo).point(lambda v: 255 if v > 24 else 0)
    caixa = diff.getbbox()
    if not caixa:
        return img
    folga = int(min(img.size) * 0.025)
    x0, y0, x1, y1 = caixa
    return img.crop((max(0, x0 - folga), max(0, y0 - folga),
                     min(img.width, x1 + folga), min(img.height, y1 + folga)))


def _paginas_em_imagem(pdf: bytes, pasta: str, n: int) -> list[str]:
    base = os.path.join(pasta, f'cert_{n:02d}')
    with open(base + '.pdf', 'wb') as f:
        f.write(pdf)
    proc = _rodar(['pdftoppm', '-r', str(DPI), '-png', '-l', str(MAX_PAGINAS), base + '.pdf', base], pasta, 90)
    paginas = sorted(p for p in os.listdir(pasta) if p.startswith(f'cert_{n:02d}-') and p.endswith('.png'))
    if proc.returncode != 0 or not paginas:
        raise ErroPrestacao('Uma das certidões não pôde ser lida como PDF. Envie a certidão de novo no painel.')
    saida = []
    for i, nome in enumerate(paginas):
        img = _recortar_margem(Image.open(os.path.join(pasta, nome)).convert('RGB'))
        # Página em branco (a segunda página de algumas certidões é só o rodapé do site): fica de fora.
        if img.width < 40 or img.height < 40:
            continue
        destino = os.path.join(pasta, f'cert_{n:02d}_p{i + 1}.png')
        img.save(destino, optimize=True)
        saida.append(destino)
    if not saida:
        raise ErroPrestacao('Uma das certidões está em branco. Envie a certidão de novo no painel.')
    return saida


# ── rodapé e número de páginas da apresentação gerada ──

_EH_RODAPE = re.compile(r'•\s+EXERCÍCIO\s')


def _rodape_do_pptx(prs: Presentation) -> str:
    for slide in reversed(list(prs.slides)):
        for sh in slide.shapes:
            # O rodapé é "<CONDOMÍNIO>    •    EXERCÍCIO <período>"; o encerramento também tem
            # "RESULTADO DO EXERCÍCIO", por isso a conferência do separador.
            if sh.has_text_frame and _EH_RODAPE.search(sh.text_frame.text):
                return sh.text_frame.text.strip()
    return ''


def _rodape_do_pdf(pdf_path: str, pasta: str) -> tuple[str, int]:
    info = _rodar(['pdfinfo', pdf_path], pasta, 30).stdout
    m = re.search(r'Pages:\s+(\d+)', info)
    paginas = int(m.group(1)) if m else 0
    texto = ''
    if paginas:
        texto = _rodar(['pdftotext', '-layout', '-f', str(paginas), '-l', str(paginas), pdf_path, '-'], pasta, 30).stdout
    for linha in texto.splitlines():
        if _EH_RODAPE.search(linha):
            # "<CONDOMÍNIO>    •    EXERCÍCIO <período>   12" -> sem o número da página no fim
            return re.sub(r'\s+\d+\s*$', '', linha.strip()), paginas
    return '', paginas


# ── slide de uma página de certidão ──

def _slide(prs: Presentation, cert: dict, img_path: str, pag: int, pag_tot: int,
           k: int, n: int, rodape: str, numero: int) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    bg = s.background.fill
    bg.solid()
    bg.fore_color.rgb = G.BG

    tipo = cert.get('tipo')
    destaque, orgao = TITULOS.get(tipo, (cert.get('nome') or 'Negativa', ''))
    if tipo == 'municipal':
        m = re.search(r'\(([^)]+)\)', cert.get('nome') or '')
        if m:
            orgao = 'Prefeitura Municipal de ' + m.group(1).strip()

    # Coluna da esquerda: título e dados da certidão.
    kicker = f'ANEXO  •  CERTIDÃO {k} DE {n}' + (f'  •  PÁGINA {pag} DE {pag_tot}' if pag_tot > 1 else '')
    G.text(s, 0.5, 0.3, 6.9, 0.35, kicker, 14, G.GS_AZUL_CLA, True)
    G.runs(s, 0.5, 0.6, 6.9, 0.75, [('Certidão ', 34, True, G.TXT), (destaque, 34, True, G.BLUE)])
    G.hline(s, 0.5, 1.35, 1.05, G.GS_AZUL, 3)
    G.text(s, 0.5, 1.5, 6.9, 0.75, orgao, 17, G.TXT2)

    rot, sub, cor = SITUACOES.get(cert.get('situacao'), ('VER DOCUMENTO', 'Situação conforme o documento ao lado.', G.AMBER))
    if tipo == 'fgts' and cert.get('situacao') == 'negativa':
        rot, sub = 'REGULAR', 'O condomínio está regular perante o FGTS.'
    y = 2.45
    G.rect(s, 0.5, y, 6.9, 1.6, G.CARD, True, 0.06)
    G.rect(s, 0.5, y, 0.12, 1.6, cor)
    G.text(s, 0.85, y + 0.18, 6.4, 0.35, 'SITUAÇÃO', 14, G.TXT3, True)
    G.text(s, 0.85, y + 0.52, 6.4, 0.6, rot, G.ajusta(rot, 6.4, 30, True, 18), cor, True)
    G.text(s, 0.85, y + 1.12, 6.4, 0.35, sub, 16, G.TXT2)

    y = 4.25
    for i, (lab, val, c) in enumerate((('EMITIDA EM', _data_br(cert.get('emitida_em')), G.TXT),
                                       ('VÁLIDA ATÉ', _data_br(cert.get('validade')), G.AMBER))):
        x = 0.5 + i * 3.55
        G.rect(s, x, y, 3.35, 1.35, G.CARD, True, 0.06)
        G.rect(s, x, y, 0.12, 1.35, c if c is not G.TXT else G.GS_AZUL)
        G.text(s, x + 0.35, y + 0.18, 2.9, 0.35, lab, 14, G.TXT3, True)
        G.text(s, x + 0.35, y + 0.6, 2.9, 0.55, val, G.ajusta(val, 2.9, 28, True, 14), c, True)

    G.text(s, 0.5, 5.9, 6.9, 0.9,
           'Documento oficial na íntegra ao lado. A autenticidade pode ser conferida no site do órgão emissor.',
           15, G.TXT3)

    # Coluna da direita: a página da certidão no maior tamanho que cabe, sobre um cartão branco.
    with Image.open(img_path) as im:
        iw, ih = im.size
    area_x0, area_x1, area_y0, area_y1 = 7.75, 12.83, 0.3, 6.95
    pad = 0.08
    max_w, max_h = area_x1 - area_x0 - 2 * pad, area_y1 - area_y0 - 2 * pad
    escala = min(max_w / iw, max_h / ih)
    w, h = iw * escala, ih * escala
    fx = area_x1 - (w + 2 * pad)
    fy = area_y0 + (max_h - h) / 2
    G.rect(s, fx, fy, w + 2 * pad, h + 2 * pad, G.rgb('FFFFFF'), True, 0.02)
    s.shapes.add_picture(img_path, Inches(fx + pad), Inches(fy + pad), Inches(w), Inches(h))

    # Rodapé igual ao da apresentação.
    if rodape:
        G.text(s, 0.5, 7.1, 9.0, 0.3, rodape, 12, G.TXT3)
    s.shapes.add_picture(G.LOGO_GS, Inches(11.05), Inches(7.04), height=Inches(0.32))
    G.text(s, 12.35, 7.1, 0.48, 0.3, str(numero), 12, G.TXT3, align=G.PP_ALIGN.RIGHT)


def _desenhar(prs: Presentation, certs: list[dict], imagens: list[list[str]], rodape: str, primeiro: int) -> int:
    numero = primeiro
    for k, (cert, pags) in enumerate(zip(certs, imagens), start=1):
        for p, img in enumerate(pags, start=1):
            _slide(prs, cert, img, p, len(pags), k, len(certs), rodape, numero)
            numero += 1
    return numero - primeiro


def anexar(pptx: bytes | None, pdf: bytes | None, certidoes: list[dict], pasta: str) -> dict:
    """Devolve { pptx, pdf, slides } com os slides das certidões no fim de cada arquivo recebido."""
    if not pptx and not pdf:
        raise ErroPrestacao('Envie o PDF ou o PowerPoint da prestação.')
    certs = [c for c in certidoes if isinstance(c, dict) and c.get('pdf')][:MAX_CERTIDOES]
    if not certs:
        raise ErroPrestacao('Nenhuma certidão válida para incluir.')
    certs.sort(key=lambda c: ORDEM.index(c.get('tipo')) if c.get('tipo') in ORDEM else len(ORDEM))
    imagens = [_paginas_em_imagem(c['pdf'], pasta, i) for i, c in enumerate(certs)]

    rodape, paginas = '', 0
    prs_orig = None
    if pptx:
        prs_orig = Presentation(io.BytesIO(pptx))
        rodape, paginas = _rodape_do_pptx(prs_orig), len(prs_orig.slides)
    pdf_path = None
    if pdf:
        pdf_path = os.path.join(pasta, 'prestacao.pdf')
        with open(pdf_path, 'wb') as f:
            f.write(pdf)
        r_pdf, p_pdf = _rodape_do_pdf(pdf_path, pasta)
        rodape = rodape or r_pdf
        paginas = paginas or p_pdf

    saida = {'pptx': None, 'pdf': None, 'slides': 0}
    if prs_orig is not None:
        saida['slides'] = _desenhar(prs_orig, certs, imagens, rodape, paginas + 1)
        buf = io.BytesIO()
        prs_orig.save(buf)
        saida['pptx'] = buf.getvalue()

    if pdf_path:
        so = Presentation()
        so.slide_width, so.slide_height = Inches(13.333), Inches(7.5)
        saida['slides'] = _desenhar(so, certs, imagens, rodape, paginas + 1)
        so_path = os.path.join(pasta, 'certidoes.pptx')
        so.save(so_path)
        _garante_fontes(pasta)
        _rodar(['soffice', '--headless', f'-env:UserInstallation=file://{pasta}/lo', '--convert-to', 'pdf',
                '--outdir', pasta, so_path], pasta, 240)
        so_pdf = os.path.join(pasta, 'certidoes.pdf')
        if not os.path.exists(so_pdf):
            raise ErroPrestacao('Não foi possível converter os slides das certidões em PDF. Tente de novo.')
        final = os.path.join(pasta, 'prestacao_com_certidoes.pdf')
        proc = _rodar(['pdfunite', pdf_path, so_pdf, final], pasta, 60)
        if proc.returncode != 0 or not os.path.exists(final):
            raise ErroPrestacao('Não foi possível juntar as certidões ao PDF da prestação. Tente de novo.')
        saida['pdf'] = Path(final).read_bytes()
    return saida
