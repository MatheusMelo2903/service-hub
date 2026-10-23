# -*- coding: utf-8 -*-
"""Motor de layouts da apresentação de assembleia (PPTX e PDF).

A IA do Hub monta só o ROTEIRO (um JSON com a lista de slides, contrato em
servico/apresentacao/guia.md). Aqui cada slide do roteiro é desenhado sem IA,
na mesma identidade da prestação de contas: primitivas e paleta do gerador
aprovado (vendor/skill_v13/scripts/gerador.py), que não é alterado.

Como o roteiro vem de uma IA, nada aqui pode quebrar a geração:
  tipo desconhecido ou campo faltando vira aviso em português e o slide é pulado
  ou desenhado com um padrão; texto que não cabe reduz a letra até 14pt e, se
  ainda assim não couber, continua em outro slide com "(continuação)" no título.

A altura do texto é medida com a métrica das fontes da marca (G.largura) e cada
parágrafo sai com espaçamento de linha fixo, então a conta bate com o que o
LibreOffice e o PowerPoint desenham.
"""
from __future__ import annotations

import io
import math
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

from PIL import Image, ImageOps
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

from .v13 import SCRIPTS, ErroPrestacao

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import gerador as G  # noqa: E402  (primitivas e paleta do padrão aprovado)

from .certidoes_deck import _garante_fontes, _recortar_margem  # noqa: E402

# ── medidas da página (iguais às do gerador) ──
SW, SH = 13.333, 7.5
X0, W = 0.5, 12.33           # margem esquerda e largura útil
BASE = 6.92                  # limite de baixo do conteúdo (rodapé começa em 7.04)
GAP = 0.18                   # espaço padrão entre cartões
MIN_PT = 14                  # nada abaixo disso no conteúdo

MAX_FOTO_PX = 1800
DPI_DOC = 160
MAX_PAG_DOC = 4
MAX_SLIDES_SAIDA = 160       # trava de segurança do arquivo final
LINHAS_TABELA = 12

MSG_ENCERRAMENTO = ("A sua participação é essencial para o bom funcionamento e andamento do "
                    "nosso condomínio. Agradecemos a presença de todos!")

# Espaçamento de linha fixo (em múltiplos do corpo). Poppins tem ascendente alto;
# Inter é mais compacta. Com o espaçamento fixo a altura medida é a desenhada.
FATOR = {True: 1.30, False: 1.24}

CORES_CARTAO = [G.AMBER, G.GS_AZUL_CLA, G.GREEN, G.rgb('8E9BF5')]
SIGLAS = {'AGE': 'Assembleia Geral Extraordinária', 'AGO': 'Assembleia Geral Ordinária',
          'AGOE': 'Assembleia Geral Ordinária e Extraordinária'}


class ErroConversao(Exception):
    """Falha do LibreOffice ao gerar o PDF (erro do servidor, não da entrada)."""


# ───────────────────────── utilidades de dados ─────────────────────────

_TRACO = re.compile(r'\s+[\-–—]+\s+|—|–')


def _limpa(v) -> str:
    """Texto seguro para o slide: sem hífen ou travessão como pontuação (regra da casa)."""
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    t = str(v).replace('\r', '').strip()
    t = re.sub(r'^[\-–—••]+\s*', '', t)          # marcador de lista colado no começo
    t = _TRACO.sub(', ', t)
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r',\s*,', ',', t)
    return t.strip()


def _lista(v) -> list[str]:
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, (list, tuple)):
        return []
    return [t for t in (_limpa(x) for x in v if not isinstance(x, (dict, list))) if t]


def _num(v):
    """Número de um campo de valor: aceita 1234.5, "1234.5" ou "R$ 1.234,50"."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    t = str(v).replace('R$', '').replace(' ', '').strip()
    if not t:
        return None
    if re.fullmatch(r'-?[\d.]+,\d{1,2}', t):
        t = t.replace('.', '').replace(',', '.')
    elif re.fullmatch(r'-?\d{1,3}(\.\d{3})+', t):
        t = t.replace('.', '')
    try:
        n = float(t)
        return n if math.isfinite(n) else None
    except ValueError:
        return None


def _valor_txt(v) -> str:
    """Valor para exibir: número vira R$ formatado; texto passa como veio."""
    n = _num(v) if not isinstance(v, str) or re.fullmatch(r'\s*-?[\d.,]+\s*', v or '') else None
    if n is not None:
        return G.brl(n)
    return _limpa(v)


def _inteiro(v):
    n = _num(v)
    if n is None or n <= 0:
        return None
    return int(round(n))


def _nb(t: str) -> str:
    """R$ e valor nunca separados na quebra de linha."""
    return (t or '').replace('R$ ', 'R$ ')


# ───────────────────────── medida de texto ─────────────────────────

def lh(size, bold=False) -> float:
    return size * FATOR[bool(bold)] / 72


def linhas(t: str, size, w, bold=False) -> int:
    if not t:
        return 0
    return sum(max(1, G.n_linhas(seg, size, w, bold)) if seg.strip() else 1 for seg in t.split('\n'))


def alt(t: str, size, w, bold=False) -> float:
    return linhas(t, size, w, bold) * lh(size, bold)


def alt_paras(paras, size, w, bold=False, espaco=0.0) -> float:
    if not paras:
        return 0.0
    return sum(alt(p, size, w, bold) for p in paras) + espaco * (len(paras) - 1)


def cabe_linha(t, size, w, bold=True) -> bool:
    return G.largura(t, size, bold) <= w * 0.96


def ajusta(t, w, size, bold=True, minimo=MIN_PT) -> int:
    return G.ajusta(t, w, size, bold, minimo)


def caixa(s, x, y, w, h, paras, size, cor=G.TXT, bold=False, align=PP_ALIGN.LEFT,
          anchor=MSO_ANCHOR.TOP, espaco=0.0):
    """Caixa de texto com espaçamento de linha fixo. Cada item de paras é um parágrafo:
    texto simples, ou lista de partes (texto, tamanho, negrito, cor)."""
    tb = s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(max(h, 0.1)))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    for m in ('margin_left', 'margin_right', 'margin_top', 'margin_bottom'):
        setattr(tf, m, Emu(0))
    if isinstance(paras, str):
        paras = paras.split('\n')
    for i, ptxt in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        partes = ptxt if isinstance(ptxt, list) else [(ptxt, size, bold, cor)]
        maior = max((pp[1] for pp in partes), default=size)
        algum_negrito = any(pp[2] for pp in partes)
        p.line_spacing = Pt(maior * FATOR[algum_negrito])
        if i and espaco:
            p.space_before = Pt(espaco * 72)
        for t, sz, b, c in partes:
            r = p.add_run()
            r.text = t
            r.font.name = G.FONT_T if b else G.FONT
            r.font.size = Pt(sz)
            r.font.bold = b
            r.font.color.rgb = c
    return tb


def oval(s, x, y, d, fill=None, line=None, peso=2.0):
    sh = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(y), Inches(d), Inches(d))
    if fill is None:
        sh.fill.background()
    else:
        sh.fill.solid()
        sh.fill.fore_color.rgb = fill
    if line is None:
        sh.line.fill.background()
    else:
        sh.line.color.rgb = line
        sh.line.width = Pt(peso)
    sh.shadow.inherit = False
    return sh


def contorno(s, x, y, w, h, cor, peso=2.0, corner=0.06):
    sh = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    sh.adjustments[0] = corner
    sh.fill.background()
    sh.line.color.rgb = cor
    sh.line.width = Pt(peso)
    sh.shadow.inherit = False
    return sh


def _maior_que_cabe(tamanhos, cabe):
    for t in tamanhos:
        if cabe(t):
            return t
    return None


def _dividir_texto(t: str, size, w, hmax, bold=False) -> list[str]:
    """Quebra um texto longo em pedaços que cabem em hmax, por frase e, se uma frase
    sozinha não couber, por palavra."""
    frases = [f for f in re.split(r'(?<=[.!?;:])\s+', t) if f]
    unidades = []
    for f in frases:
        if alt(f, size, w, bold) <= hmax:
            unidades.append(f)
            continue
        cur = ''
        for pal in f.split(' '):
            tent = (cur + ' ' + pal).strip()
            if cur and alt(tent, size, w, bold) > hmax:
                unidades.append(cur)
                cur = pal
            else:
                cur = tent
        if cur:
            unidades.append(cur)
    pedacos, cur = [], ''
    for u in unidades:
        tent = (cur + ' ' + u).strip()
        if cur and alt(tent, size, w, bold) > hmax:
            pedacos.append(cur)
            cur = u
        else:
            cur = tent
    if cur:
        pedacos.append(cur)
    return pedacos or ['']


def _agrupar(alturas, disp, gap=GAP, max_itens=None) -> list[list[int]]:
    """Distribui blocos de altura conhecida em páginas, em ordem, sem estourar disp.
    Evita deixar a última página com um só bloco quando dá para equilibrar."""
    pags, cur, acc = [], [], 0.0
    for i, h in enumerate(alturas):
        extra = h + (gap if cur else 0)
        if cur and (acc + extra > disp or (max_itens and len(cur) >= max_itens)):
            pags.append(cur)
            cur, acc = [], 0.0
            extra = h
        cur.append(i)
        acc += extra
    if cur:
        pags.append(cur)
    # equilíbrio simples: puxa itens da penúltima para a última enquanto couber e ficar mais parelho
    while len(pags) >= 2 and len(pags[-2]) > len(pags[-1]) + 1:
        mov = pags[-2][-1]
        nova = [mov] + pags[-1]
        h_nova = sum(alturas[i] for i in nova) + gap * (len(nova) - 1)
        if h_nova > disp or (max_itens and len(nova) > max_itens):
            break
        pags[-2].pop()
        pags[-1] = nova
    return pags


# ───────────────────────── contexto da montagem ─────────────────────────

class Ctx:
    def __init__(self, fotos, documentos, pasta):
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = Inches(SW), Inches(SH)
        self.layout = self.prs.slide_layouts[6]
        self.fotos = fotos or {}
        self.documentos = documentos or {}
        self.pasta = pasta
        self.avisos: list[str] = []
        self.rodape = 'Grupo Service'
        self.total_itens = 0
        self._fotos_ok: dict = {}
        self._docs_ok: dict = {}
        self._avisados: set = set()
        self.slide_atual = 0     # posição no roteiro, para os avisos

    def aviso(self, msg: str):
        txt = f'Slide {self.slide_atual} do roteiro: {msg}' if self.slide_atual else msg
        if txt not in self._avisados:
            self._avisados.add(txt)
            self.avisos.append(txt)

    # slide novo com fundo e rodapé
    def novo(self, rodape=True):
        s = self.prs.slides.add_slide(self.layout)
        bg = s.background.fill
        bg.solid()
        bg.fore_color.rgb = G.BG
        if rodape:
            n = len(self.prs.slides)
            G.text(s, 0.5, 7.1, 9.6, 0.3, self.rodape, 12, G.TXT3)
            s.shapes.add_picture(G.LOGO_GS, Inches(11.05), Inches(7.04), height=Inches(0.32))
            G.text(s, 12.35, 7.1, 0.48, 0.3, str(n), 12, G.TXT3, align=PP_ALIGN.RIGHT)
        return s

    def remover_desde(self, n):
        lst = self.prs.slides._sldIdLst
        for sid in list(lst)[n:]:
            self.prs.part.drop_rel(sid.rId)
            lst.remove(sid)

    # ── fotos ──
    def foto(self, fid):
        """Caminho do JPEG reduzido (máx. 1800 px, qualidade 85) e o tamanho, ou None."""
        fid = _limpa(fid)
        if fid in self._fotos_ok:
            return self._fotos_ok[fid]
        dado = self.fotos.get(fid)
        if not dado:
            self.aviso(f'a foto "{fid}" não foi enviada; ficou de fora.')
            self._fotos_ok[fid] = None
            return None
        try:
            im = Image.open(io.BytesIO(dado))
            im = ImageOps.exif_transpose(im)
            if im.mode in ('RGBA', 'LA', 'P'):
                im = im.convert('RGBA')
                fundo = Image.new('RGB', im.size, (51, 46, 52))
                fundo.paste(im, mask=im.split()[-1])
                im = fundo
            else:
                im = im.convert('RGB')
            im.thumbnail((MAX_FOTO_PX, MAX_FOTO_PX), Image.LANCZOS)
            nome = re.sub(r'[^A-Za-z0-9_]', '_', fid)[:40] or 'foto'
            caminho = os.path.join(self.pasta, f'foto_{len(self._fotos_ok):03d}_{nome}.jpg')
            im.save(caminho, 'JPEG', quality=85, optimize=True)
            r = (caminho, im.size)
        except Exception:
            self.aviso(f'a foto "{fid}" não é uma imagem válida; ficou de fora.')
            r = None
        self._fotos_ok[fid] = r
        return r

    # ── documentos ──
    def doc_paginas(self, did):
        did = _limpa(did)
        if did in self._docs_ok:
            return self._docs_ok[did]
        dado = self.documentos.get(did)
        if not dado:
            self.aviso(f'o documento "{did}" não foi enviado; ficou de fora.')
            self._docs_ok[did] = None
            return None
        nome = re.sub(r'[^A-Za-z0-9_]', '_', did)[:40] or 'doc'
        caminho = os.path.join(self.pasta, f'doc_{len(self._docs_ok):02d}_{nome}.pdf')
        with open(caminho, 'wb') as f:
            f.write(dado)
        n = 0
        try:
            out = subprocess.run(['pdfinfo', caminho], capture_output=True, text=True, timeout=30).stdout
            m = re.search(r'Pages:\s+(\d+)', out)
            n = int(m.group(1)) if m else 0
        except Exception:
            n = 0
        if not n:
            self.aviso(f'o documento "{did}" não pôde ser lido como PDF; ficou de fora.')
            self._docs_ok[did] = None
            return None
        self._docs_ok[did] = (caminho, n, {})
        return self._docs_ok[did]

    def doc_pagina(self, did, pag):
        info = self.doc_paginas(did)
        if not info:
            return None
        caminho, n, cache = info
        if pag in cache:
            return cache[pag]
        base = caminho[:-4] + f'_p{pag}'
        r = None
        try:
            proc = subprocess.run(['pdftoppm', '-r', str(DPI_DOC), '-f', str(pag), '-l', str(pag), '-png',
                                   '-singlefile', caminho, base], capture_output=True, timeout=90)
            if proc.returncode == 0 and os.path.exists(base + '.png'):
                im = _recortar_margem(Image.open(base + '.png').convert('RGB'))
                if im.width >= 40 and im.height >= 40:
                    destino = base + '.jpg'
                    im.save(destino, 'JPEG', quality=88, optimize=True)
                    r = (destino, im.size)
        except Exception:
            r = None
        if r is None:
            self.aviso(f'a página {pag} do documento "{_limpa(did)}" não pôde ser convertida; ficou de fora.')
        cache[pag] = r
        return r


# ───────────────────────── peças comuns ─────────────────────────

def _numero_item(sl):
    n = sl.get('numero')
    if isinstance(n, bool) or n is None or n == '':
        return None
    if isinstance(n, float) and n.is_integer():
        n = int(n)
    t = _limpa(n)
    return t or None


def cabecalho(ctx, s, sl, titulo, sub=None, cont=False, w=W, kicker=None) -> float:
    """Kicker (ITEM n DA PAUTA), título com a última palavra em azul e traço azul.
    Título longo reduz até 24pt numa linha; se não couber, quebra em até 3 linhas.
    Devolve a altura onde o conteúdo começa."""
    num = _numero_item(sl) if sl is not None else None
    k = kicker if kicker is not None else (f'ITEM {num} DA PAUTA' if num else '')
    if k:
        G.text(s, X0, 0.3, w, 0.35, k, 14, G.GS_AZUL_CLA, True)
    titulo = _nb(_limpa(titulo) or 'Sem título')
    suf = ' (continuação)' if cont else ''
    full = titulo + suf
    size = 34
    while size > 24 and not cabe_linha(full, size, w):
        size -= 1
    if cabe_linha(full, size, w):
        nl = 1
    else:
        size = 30
        while size > 20 and linhas(full, size, w, True) > 2:
            size -= 1
        nl = linhas(full, size, w, True)
    pal = titulo.split(' ')
    t1, t2 = (' '.join(pal[:-1]) + ' ', pal[-1]) if len(pal) >= 2 else (titulo, '')
    partes = [(t1, size, True, G.TXT)]
    if t2:
        partes.append((t2, size, True, G.BLUE))
    if suf:
        partes.append((suf, size, True, G.TXT3))
    caixa(s, X0, 0.6, w, nl * lh(size, True) + 0.05, [partes], size, bold=True)
    y_traco = max(1.35, 0.6 + nl * lh(size, True) + 0.1)
    G.hline(s, X0, y_traco, X0 + 0.55, G.GS_AZUL, 3)
    if sub:
        sub = _nb(_limpa(sub))
        hs = min(alt(sub, 17, w), 2 * lh(17))
        caixa(s, X0, y_traco + 0.1, w, hs, sub, 17, G.TXT2)
        return y_traco + 0.1 + hs + 0.28
    return y_traco + 0.4


def _faixa_obs(s, y, texto, cor=G.AMBER, rotulo='OBSERVAÇÃO', x=X0, w=W):
    """Faixa de observação no pé do conteúdo. Devolve a altura usada."""
    texto = _nb(texto)
    tw = w - 0.5 - G.largura(rotulo + '   ', 14, True)
    size = _maior_que_cabe([17, 16, 15, 14], lambda t: linhas(texto, t, tw) <= 2) or 14
    h = max(0.58, alt(texto, size, tw) + 0.26)
    G.rect(s, x, y, w, h, G.CARD2, True, 0.12)
    G.text(s, x + 0.25, y, 2.5, h, rotulo, 14, cor, True, anchor=MSO_ANCHOR.MIDDLE)
    caixa(s, x + 0.25 + G.largura(rotulo + '   ', 14, True), y, tw, h, texto, size, G.TXT2, anchor=MSO_ANCHOR.MIDDLE)
    return h


def _alt_obs(texto, w=W):
    if not texto:
        return 0.0
    texto = _nb(texto)
    tw = w - 0.5 - G.largura('OBSERVAÇÃO   ', 14, True)
    size = _maior_que_cabe([17, 16, 15, 14], lambda t: linhas(texto, t, tw) <= 2) or 14
    return max(0.58, alt(texto, size, tw) + 0.26)


def _encaixar_imagem(s, caminho, tam, x, y, w, h, fundo=None, pad=0.0):
    """Imagem inteira (sem distorcer nem cortar) centralizada na área."""
    if fundo is not None:
        G.rect(s, x, y, w, h, fundo, True, 0.03)
    iw, ih = tam
    mw, mh = w - 2 * pad, h - 2 * pad
    esc = min(mw / iw, mh / ih)
    pw, ph = iw * esc, ih * esc
    px, py = x + pad + (mw - pw) / 2, y + pad + (mh - ph) / 2
    s.shapes.add_picture(caminho, Inches(px), Inches(py), Inches(pw), Inches(ph))
    return px, py, pw, ph


# ───────────────────────── tipos de slide ─────────────────────────

def s_capa(ctx, sl):
    s = ctx.novo(rodape=False)
    sigla = _limpa(sl.get('sigla')).upper()
    nome = _limpa(sl.get('assembleia'))
    if not nome and sigla in SIGLAS:
        nome = SIGLAS[sigla]
    if not sigla and nome:
        sigla = ''.join(p[0] for p in nome.split() if p[:1].isupper())[:5]
    cond = _limpa(sl.get('condominio')) or '[conferir]'
    data = _limpa(sl.get('data'))
    if not _limpa(sl.get('condominio')):
        ctx.aviso('a capa veio sem o nome do condomínio.')
    if not data:
        ctx.aviso('a capa veio sem a data da assembleia.')

    G.rect(s, 0, 0, SW, 0.083, G.GS_AZUL)
    s.shapes.add_picture(G.LOGO_GS, Inches(0.94), Inches(0.75), height=Inches(0.95))
    G.text(s, 0.94, 2.35, 7.6, 0.45, 'APRESENTAÇÃO EM ASSEMBLEIA', 18, G.GS_AZUL_CLA, True)
    # Nome do condomínio: primeira palavra branca e o resto em azul claro, como a prestação.
    pal = cond.split(' ')
    t1, t2 = (pal[0] + ' ', ' '.join(pal[1:])) if len(pal) >= 2 else ('', cond)
    wn = 7.5
    tam = _maior_que_cabe(range(54, 31, -2), lambda t: linhas(cond, t, wn, True) <= 2) or 32
    nl = linhas(cond, tam, wn, True)
    if nl > 2:
        tam = _maior_que_cabe(range(30, 19, -2), lambda t: linhas(cond, t, wn, True) <= 2) or 20
        nl = linhas(cond, tam, wn, True)
    y = 2.85
    caixa(s, 0.94, y, wn, nl * lh(tam, True), [[(t1, tam, True, G.TXT), (t2, tam, True, G.GS_AZUL_CLA)]], tam, bold=True)
    y += nl * lh(tam, True) + 0.22
    G.hline(s, 0.94, y, 1.9, G.GS_AZUL, 4)
    y += 0.3
    if data:
        caixa(s, 0.94, y, wn, lh(28, True), data, ajusta(data, wn, 28, True, 20), G.TXT, True)
        y += lh(28, True) + 0.08
    det = '    •    '.join(t for t in (_limpa(sl.get('hora')), _limpa(sl.get('local'))) if t)
    if det:
        caixa(s, 0.94, y, wn, alt(det, 19, wn), det, 19, G.TXT2)
    G.rect(s, 0.94, 6.45, 11.45, 0.012, G.LINE)
    G.text(s, 0.94, 6.62, 11.45, 0.4, 'Contábil Service    •    Condomínio Service    •    RH Service', 15, G.TXT3)

    # Cartão de destaque à direita: a sigla grande e o nome por extenso.
    x, yc, w, h = 8.75, 2.35, 3.64, 3.55
    G.rect(s, x, yc, w, h, G.CARD, True, 0.06)
    G.rect(s, x, yc, 0.12, h, G.GS_AZUL)
    G.text(s, x + 0.38, yc + 0.28, w - 0.6, 0.3, 'ASSEMBLEIA', 14, G.TXT3, True)
    sg = sigla or 'AG'
    G.text(s, x + 0.38, yc + 0.62, w - 0.6, 1.3, sg, ajusta(sg, w - 0.6, 80, True, 40), G.AMBER, True)
    if nome:
        tn = _maior_que_cabe([19, 18, 17, 16, 15, 14], lambda t: linhas(nome, t, w - 0.6) <= 3) or 14
        caixa(s, x + 0.38, yc + 2.0, w - 0.6, 1.3, nome, tn, G.TXT2)


def s_pauta(ctx, sl):
    itens = _lista(sl.get('itens'))
    if not itens:
        ctx.aviso('pauta sem itens; slide ignorado.')
        return
    ctx.total_itens = max(ctx.total_itens, len(itens))
    tw = W - 1.35
    topo = 1.75
    disp = BASE - topo

    def alturas(t):
        return [max(0.78, alt(_nb(i), t, tw) + 0.34) for i in itens]

    size = _maior_que_cabe([22, 21, 20, 19, 18, 17, 16],
                           lambda t: sum(alturas(t)) + 0.16 * (len(itens) - 1) <= disp) or 18
    hs = alturas(size)
    pags = _agrupar(hs, disp, 0.16)
    for pi, idxs in enumerate(pags):
        s = ctx.novo()
        cabecalho(ctx, s, None, 'Itens da pauta', cont=pi > 0, kicker='ORDEM DO DIA')
        y = topo
        # Pouco texto: centraliza o bloco na altura para não sobrar vazio embaixo.
        tot = sum(hs[i] for i in idxs) + 0.16 * (len(idxs) - 1)
        if pi == 0 and len(pags) == 1 and tot < disp * 0.7:
            y = topo + (disp - tot) * 0.3
        for i in idxs:
            h = hs[i]
            G.rect(s, X0, y, W, h, G.CARD, True, 0.08)
            d = 0.62
            G.rect(s, X0 + 0.2, y + (h - d) / 2 if h < 1.3 else y + 0.17, d, d, G.GS_AZUL, True, 0.18)
            G.text(s, X0 + 0.2, (y + (h - d) / 2) if h < 1.3 else y + 0.17, d, d, str(i + 1), 22, G.TXT, True,
                   PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
            caixa(s, X0 + 1.1, y, tw, h, _nb(itens[i]), size, G.TXT, anchor=MSO_ANCHOR.MIDDLE)
            y += h + 0.16


def s_item(ctx, sl):
    num = _numero_item(sl)
    titulo = _nb(_limpa(sl.get('titulo')))
    if not titulo:
        ctx.aviso('divisor de item sem título; usei só o número.')
    s = ctx.novo()
    G.rect(s, 0, 0, SW, 0.083, G.GS_AZUL)
    rot = num or ''
    numtxt = f'{int(rot):02d}' if rot.isdigit() else (rot or '•')
    tam_n = ajusta(numtxt, 3.3, 150, True, 60)
    G.text(s, 0.6, 1.9, 3.5, 3.0, numtxt, tam_n, G.AMBER, True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
    G.text(s, 0.6, 4.95, 3.5, 0.4, 'ITEM DA PAUTA', 14, G.TXT3, True, PP_ALIGN.CENTER)
    linha = s.shapes.add_connector(1, Inches(4.45), Inches(2.0), Inches(4.45), Inches(5.3))
    linha.line.color.rgb = G.GS_AZUL
    linha.line.width = Pt(3)
    tw = 7.85
    kick = f'ITEM {rot} DE {ctx.total_itens}' if rot.isdigit() and ctx.total_itens >= int(rot) else (f'ITEM {rot}' if rot else 'ITEM DA PAUTA')
    tam = _maior_que_cabe(range(36, 19, -2), lambda t: alt(titulo, t, tw, True) <= 3.2) or 20
    if alt(titulo, tam, tw, True) > 3.6:
        tam = _maior_que_cabe(range(19, MIN_PT - 1, -1), lambda t: alt(titulo, t, tw, True) <= 3.8) or MIN_PT
    ht = alt(titulo, tam, tw, True)
    bloco = 0.5 + ht
    y = 3.65 - bloco / 2
    G.text(s, 4.95, y, tw, 0.35, kick, 16, G.GS_AZUL_CLA, True)
    caixa(s, 4.95, y + 0.5, tw, ht + 0.1, titulo, tam, G.TXT, True)


def s_texto(ctx, sl):
    titulo = sl.get('titulo')
    paras = _lista(sl.get('paragrafos') or sl.get('texto'))
    destaque = _limpa(sl.get('destaque'))
    if not paras and not destaque:
        ctx.aviso('slide de texto sem parágrafos; slide ignorado.')
        return
    sub = sl.get('subtitulo')
    paras = [_nb(p) for p in paras]
    tx, tw = X0 + 0.35, W - 0.6
    topo = 2.05 if sub else 1.75
    disp = BASE - topo
    esp = 0.22

    def h_dest(t):
        return (alt(_nb(destaque), t + 2, tw - 0.9, True) + 0.5) if destaque else 0.0

    def cabe(t):
        return alt_paras(paras, t, tw, False, esp) + (h_dest(t) + 0.3 if destaque else 0) <= disp

    size = _maior_que_cabe(range(26, MIN_PT - 1, -1), cabe)
    if size is not None:
        pags = [paras]
    else:
        size = 18
        pedacos = []
        for p in paras:
            pedacos += _dividir_texto(p, size, tw, disp - 0.3)
        hs = [alt(p, size, tw) for p in pedacos]
        pags = [[pedacos[i] for i in g] for g in _agrupar(hs, disp - h_dest(size) * 0, esp)]
        if destaque and alt_paras(pags[-1], size, tw, False, esp) + h_dest(size) + 0.3 > disp:
            pags.append([])
    for pi, pg in enumerate(pags):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, sub if pi == 0 else None, cont=pi > 0)
        if pg:
            hp = alt_paras(pg, size, tw, False, esp)
            G.rect(s, X0, y + 0.05, 0.06, hp - 0.1 if hp > 0.2 else hp, G.GS_AZUL)
            caixa(s, tx, y, tw, hp + 0.1, pg, size, G.TXT, espaco=esp)
            y += hp + 0.35
        if destaque and pi == len(pags) - 1:
            td = size + 2
            hd = h_dest(size)
            G.rect(s, X0, y, W, hd, G.CARD2, True, 0.1)
            G.rect(s, X0, y, 0.12, hd, G.AMBER)
            caixa(s, X0 + 0.45, y, tw - 0.9, hd, _nb(destaque), td, G.AMBER, True, anchor=MSO_ANCHOR.MIDDLE)


def _cartoes_topicos(s, topicos, x, y, w, size, cor=G.GS_AZUL_CLA, gap=0.16):
    tw = w - 0.75
    for t in topicos:
        h = alt(t, size, tw) + 0.38
        G.rect(s, x, y, w, h, G.CARD, True, min(0.08, 0.3 / h))
        G.rect(s, x, y, 0.1, h, cor)
        q = 0.13
        G.rect(s, x + 0.33, y + 0.19 + lh(size) / 2 - q / 2, q, q, cor, True, 0.25)
        caixa(s, x + 0.6, y + 0.19, tw, h - 0.3, t, size, G.TXT)
        y += h + gap
    return y


def _alt_topicos(topicos, w, size, gap=0.16):
    tw = w - 0.75
    return sum(alt(t, size, tw) + 0.38 for t in topicos) + gap * max(0, len(topicos) - 1)


def s_topicos(ctx, sl):
    tops = [_nb(t) for t in _lista(sl.get('topicos') or sl.get('itens'))]
    if not tops:
        ctx.aviso('slide de tópicos sem tópicos; slide ignorado.')
        return
    sub = sl.get('subtitulo')
    topo = 2.05 if sub else 1.75
    disp = BASE - topo
    size = _maior_que_cabe(range(26, MIN_PT - 1, -1), lambda t: _alt_topicos(tops, W, t) <= disp)
    if size is not None:
        pags = [list(range(len(tops)))]
    else:
        size = 18
        hs = [alt(t, size, W - 0.75) + 0.38 for t in tops]
        pags = _agrupar(hs, disp, 0.16)
    for pi, idxs in enumerate(pags):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo'), sub if pi == 0 else None, cont=pi > 0)
        _cartoes_topicos(s, [tops[i] for i in idxs], X0, y, W, size)


def s_colunas(ctx, sl):
    cols = []
    for c in (sl.get('colunas') or []):
        if isinstance(c, dict):
            cols.append((_limpa(c.get('nome')) or 'Opção', [_nb(t) for t in _lista(c.get('topicos'))]))
        elif isinstance(c, str) and _limpa(c):
            cols.append((_limpa(c), []))
    if not cols:
        ctx.aviso('slide de colunas sem colunas; slide ignorado.')
        return
    grupos = [cols[i:i + 3] for i in range(0, len(cols), 3)]
    if len(cols) > 3:
        ctx.aviso('mais de 3 colunas; o restante foi para outro slide.')
    cores = G.cat_colors(max(len(cols), 2))
    sub = sl.get('subtitulo')
    for gi, grupo in enumerate(grupos):
        n = len(grupo)
        cw = (W - GAP * (n - 1)) / n
        topo = 2.05 if sub else 1.75
        disp = BASE - topo

        def h_col(t, nome, tops):
            return 0.3 + alt(nome, t + 4, cw - 0.6, True) + 0.25 + _alt_topicos(tops, cw - 0.5, t, 0.12) + 0.3 if tops else \
                0.3 + alt(nome, t + 4, cw - 0.6, True) + 0.3

        size = _maior_que_cabe(range(22, MIN_PT - 1, -1),
                               lambda t: max(h_col(t, nm, tp) for nm, tp in grupo) <= disp)
        partes = [[(nm, tp) for nm, tp in grupo]]
        if size is None:
            # quebra os tópicos de todas as colunas na mesma altura de página
            size = 16
            partes, restos = [], [(nm, list(tp)) for nm, tp in grupo]
            while any(tp for _, tp in restos):
                pagina = []
                for nm, tp in restos:
                    pega = []
                    while tp and h_col(size, nm, pega + [tp[0]]) <= disp:
                        pega.append(tp.pop(0))
                    if not pega and tp:
                        pega.append(tp.pop(0))
                    pagina.append((nm, pega))
                partes.append(pagina)
                restos = [(nm, tp) for nm, tp in restos]
        for pi, pagina in enumerate(partes):
            s = ctx.novo()
            y = cabecalho(ctx, s, sl, sl.get('titulo'), sub if (pi == 0 and gi == 0) else None, cont=(pi + gi) > 0)
            hmax = max(h_col(size, nm, tp) for nm, tp in pagina)
            hcard = max(hmax, min(disp, hmax + 0.6))
            for k, (nm, tp) in enumerate(pagina):
                x = X0 + k * (cw + GAP)
                cor = cores[gi * 3 + k]
                G.rect(s, x, y, cw, hcard, G.CARD, True, 0.04)
                G.rect(s, x, y, cw, 0.1, cor)
                hn = alt(nm, size + 4, cw - 0.6, True)
                caixa(s, x + 0.3, y + 0.3, cw - 0.6, hn, nm, size + 4, cor if cor != G.GREEN else G.GREEN, True)
                yy = y + 0.3 + hn + 0.25
                tw = cw - 0.85
                for t in tp:
                    q = 0.11
                    G.rect(s, x + 0.32, yy + lh(size) / 2 - q / 2, q, q, cor, True, 0.25)
                    caixa(s, x + 0.58, yy, tw, alt(t, size, tw), t, size, G.TXT2)
                    yy += alt(t, size, tw) + 0.18


def _painel_valores(s, rx, ry, rw, fim, total, comps, blocos, tam_total=34):
    """Coluna de valores do orçamento: total em destaque, mão de obra e materiais,
    depois pagamento, prazo e observação. Tudo medido para não passar de fim."""
    if total is not None:
        G.rect(s, rx, ry, rw, 1.55, G.AMBER, True, 0.08)
        G.text(s, rx + 0.3, ry + 0.18, rw - 0.5, 0.3, 'VALOR TOTAL', 14, G.DARKTXT, True)
        vt = G.brl(total)
        G.text(s, rx + 0.3, ry + 0.55, rw - 0.5, 0.8, vt, ajusta(vt, rw - 0.5, tam_total, True, 18), G.DARKTXT, True)
        ry += 1.55 + 0.16
    if comps:
        n = len(comps)
        lado = rw >= 4.6 and n == 2
        cw = (rw - 0.16) / 2 if lado else rw
        for k, (rot, v) in enumerate(comps):
            x = rx + (k * (cw + 0.16) if lado else 0)
            y = ry if lado else ry + k * (1.12 + 0.16)
            G.rect(s, x, y, cw, 1.12, G.CARD, True, 0.08)
            G.rect(s, x, y, 0.1, 1.12, G.GS_AZUL_CLA if k == 0 else G.GREEN)
            G.text(s, x + 0.3, y + 0.15, cw - 0.45, 0.3, rot, 14, G.TXT3, True)
            vv = G.brl(v)
            G.text(s, x + 0.3, y + 0.48, cw - 0.45, 0.5, vv, ajusta(vv, cw - 0.45, 24, True, 16),
                   G.GS_AZUL_CLA if k == 0 else G.GREEN, True)
        ry += (1.12 + 0.16) * (1 if lado else n)
    restante = fim - ry
    if blocos and restante > 0.8:
        tws = rw - 0.5

        def hb(t):
            return [0.62 + alt(_nb(v), t, tws, r != 'OBSERVAÇÃO') + 0.2 for r, v in blocos]
        tb = _maior_que_cabe(range(18, MIN_PT - 1, -1),
                             lambda t: sum(hb(t)) + 0.16 * (len(blocos) - 1) <= restante) or MIN_PT
        for (r, v), h in zip(blocos, hb(tb)):
            h = min(h, fim - ry)
            if h < 0.6:
                break
            G.rect(s, rx, ry, rw, h, G.CARD, True, min(0.06, 0.3 / h))
            G.rect(s, rx, ry, 0.1, h, G.GS_AZUL)
            G.text(s, rx + 0.3, ry + 0.16, rw - 0.5, 0.3, r, 14, G.TXT3, True)
            caixa(s, rx + 0.3, ry + 0.52, tws, h - 0.55, _nb(v), tb, G.TXT, r != 'OBSERVAÇÃO')
            ry += h + 0.16
    return ry


def _alt_painel(total, comps, blocos, rw, t=MIN_PT):
    h = (1.55 + 0.16 if total is not None else 0)
    if comps:
        h += (1.12 + 0.16) * (1 if (rw >= 4.6 and len(comps) == 2) else len(comps))
    h += sum(0.62 + alt(_nb(v), t, rw - 0.5, r != 'OBSERVAÇÃO') + 0.2 + 0.16 for r, v in blocos)
    return h


def _tabela_itens(s, itens, idxs, alturas, x, y, lw, size, cont_depois):
    vw = min(2.3, max(1.6, max([G.largura(G.brl(v), size + 1, True) for _, v in itens if v is not None] or [1.4]) + 0.3))
    dw = lw - vw - 0.55
    G.text(s, x + 0.25, y, dw, 0.3, 'O QUE ESTÁ INCLUÍDO', 14, G.TXT3, True)
    G.text(s, x + lw - vw - 0.25, y, vw, 0.3, 'VALOR', 14, G.TXT3, True, PP_ALIGN.RIGHT)
    yy = y + 0.42
    G.rect(s, x, yy - 0.06, lw, 0.02, G.LINE)
    for k, i in enumerate(idxs):
        d, v = itens[i]
        h = alturas[i]
        if k % 2 == 0:
            G.rect(s, x, yy, lw, h, G.CARD)
        caixa(s, x + 0.25, yy, dw, h, d, size, G.TXT, anchor=MSO_ANCHOR.MIDDLE)
        if v is not None:
            G.text(s, x + lw - vw - 0.25, yy, vw, h, G.brl(v), ajusta(G.brl(v), vw, size + 1, True, MIN_PT),
                   G.TXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
        yy += h
    if cont_depois:
        G.text(s, x + 0.25, yy + 0.12, lw, 0.35, 'continua no próximo slide  ›', 16, G.TXT3)
    return yy


def _alturas_itens(itens, lw, size):
    vw = min(2.3, max(1.6, max([G.largura(G.brl(v), size + 1, True) for _, v in itens if v is not None] or [1.4]) + 0.3))
    dw = lw - vw - 0.55
    return [max(0.58, alt(d, size, dw) + 0.24) for d, _ in itens]


def s_orcamento(ctx, sl):
    itens = []
    for it in (sl.get('itens') or []) if isinstance(sl.get('itens'), list) else []:
        if isinstance(it, dict):
            d = _nb(_limpa(it.get('descricao') or it.get('item')))
            v = _num(it.get('valor'))
            if d or v is not None:
                itens.append((d or 'Item', v))
        elif isinstance(it, str) and _limpa(it):
            itens.append((_nb(_limpa(it)), None))
    mo, mat = _num(sl.get('mao_de_obra')), _num(sl.get('materiais'))
    comps = [(r, v) for r, v in (('MÃO DE OBRA', mo), ('MATERIAIS', mat)) if v is not None]
    total = _num(sl.get('total'))
    soma = sum(v for _, v in itens if v is not None)
    titulo_av = _limpa(sl.get('titulo')) or 'Orçamento'
    if total is None:
        if any(v is not None for _, v in itens):
            total = soma
        elif comps:
            total = sum(v for _, v in comps)
    elif itens and all(v is not None for _, v in itens) and abs(total - soma) > 0.05:
        ctx.aviso(f'no orçamento "{titulo_av}" o total informado ({G.brl(total)}) não bate com a soma dos itens ({G.brl(soma)}). Confira.')
    elif comps and len(comps) == 2 and abs(total - mo - mat) > 0.05 and not itens:
        ctx.aviso(f'no orçamento "{titulo_av}" mão de obra mais materiais ({G.brl(mo + mat)}) não bate com o total ({G.brl(total)}). Confira.')
    # página do orçamento (opcional)
    img = None
    if sl.get('documento'):
        info = ctx.doc_paginas(sl.get('documento'))
        if info:
            pg = _inteiro(sl.get('pagina')) or 1
            if pg > info[1]:
                ctx.aviso(f'a página {pg} não existe no documento "{_limpa(sl.get("documento"))}" (ele tem {info[1]} página{"s" if info[1] > 1 else ""}); usei a página 1.')
                pg = 1
            img = ctx.doc_pagina(sl.get('documento'), pg)
    if not itens and total is None and not img:
        ctx.aviso('orçamento sem itens, sem valores e sem documento; slide ignorado.')
        return
    forn = _limpa(sl.get('fornecedor'))
    blocos = [(r, t) for r, t in (('PAGAMENTO', _limpa(sl.get('pagamento'))), ('PRAZO', _limpa(sl.get('prazo'))),
                                  ('OBSERVAÇÃO', _limpa(sl.get('observacao')))) if t]
    titulo = sl.get('titulo') or 'Orçamento'
    sub = forn or None

    if img:
        # Página do orçamento à esquerda, valores à direita (itens só se couberem ali).
        caminho, tam = img
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, sub)
        retrato = tam[1] >= tam[0] * 0.9
        dw_ = 5.0 if retrato else 6.6
        G.rect(s, X0, y, dw_, BASE - y, G.rgb('FFFFFF'), True, 0.02)
        _encaixar_imagem(s, caminho, tam, X0, y, dw_, BASE - y, pad=0.08)
        rx = X0 + dw_ + 0.3
        rw = X0 + W - rx
        h_p = _alt_painel(total, comps, blocos, rw)
        sobra = BASE - y - h_p
        if itens:
            sz = _maior_que_cabe(range(17, MIN_PT - 1, -1),
                                 lambda t: sum(_alturas_itens(itens, rw, t)) + 0.6 <= sobra)
            if sz:
                hs_ = _alturas_itens(itens, rw, sz)
                yy = _tabela_itens(s, itens, list(range(len(itens))), hs_, rx, y, rw, sz, False)
                _painel_valores(s, rx, yy + 0.2, rw, BASE, total, comps, blocos)
                return
            _painel_valores(s, rx, y, rw, BASE, total, comps, blocos)
            # itens que não couberam ao lado do documento: seguem nos slides de tabela
            sl = dict(sl, documento=None, total=total, pagamento=None, prazo=None, observacao=None,
                      mao_de_obra=None, materiais=None)
            _orcamento_tabela(ctx, sl, itens, total, [], [], titulo, sub, cont_inicial=True)
            return
        _painel_valores(s, rx, y, rw, BASE, total, comps, blocos, 40)
        return

    if not itens:
        # Sem itens: cartões grandes com os valores, lado a lado.
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, sub)
        cards = ([('VALOR TOTAL', total, G.AMBER)] if total is not None else []) + \
                [(r, v, G.GS_AZUL_CLA if r == 'MÃO DE OBRA' else G.GREEN) for r, v in comps]
        n = len(cards)
        cw = (W - GAP * (n - 1)) / n
        hc = 2.0
        for k, (r, v, cor) in enumerate(cards):
            x = X0 + k * (cw + GAP)
            destaque = r == 'VALOR TOTAL'
            G.rect(s, x, y, cw, hc, cor if destaque else G.CARD, True, 0.06)
            if not destaque:
                G.rect(s, x, y, 0.12, hc, cor)
            G.text(s, x + 0.38, y + 0.3, cw - 0.6, 0.3, r, 14, G.DARKTXT if destaque else G.TXT3, True)
            vv = G.brl(v)
            G.text(s, x + 0.38, y + 0.75, cw - 0.6, 0.9, vv, ajusta(vv, cw - 0.6, 40, True, 18),
                   G.DARKTXT if destaque else cor, True)
        yb = y + hc + GAP
        if blocos:
            nb = len(blocos)
            bw = (W - GAP * (nb - 1)) / nb
            tws = bw - 0.6
            hb = BASE - yb
            tb = _maior_que_cabe(range(22, MIN_PT - 1, -1),
                                 lambda t: max(0.7 + alt(_nb(v), t, tws, r != 'OBSERVAÇÃO') for r, v in blocos) <= hb) or MIN_PT
            hb = min(hb, max(0.7 + alt(_nb(v), tb, tws, r != 'OBSERVAÇÃO') for r, v in blocos) + 0.5)
            for k, (r, v) in enumerate(blocos):
                x = X0 + k * (bw + GAP)
                G.rect(s, x, yb, bw, hb, G.CARD, True, 0.06)
                G.rect(s, x, yb, 0.1, hb, G.GS_AZUL)
                G.text(s, x + 0.35, yb + 0.25, tws, 0.3, r, 14, G.TXT3, True)
                caixa(s, x + 0.35, yb + 0.65, tws, hb - 0.75, _nb(v), tb, G.TXT, r != 'OBSERVAÇÃO')
        return

    _orcamento_tabela(ctx, sl, itens, total, comps, blocos, titulo, sub)


def _orcamento_tabela(ctx, sl, itens, total, comps, blocos, titulo, sub, cont_inicial=False):
    rx = 9.05
    rw = W + X0 - rx
    lw = rx - X0 - 0.3
    topo = 2.05 if sub else 1.75
    disp = BASE - topo - 0.55   # 0.55 da linha de rótulos da tabela
    size = _maior_que_cabe(range(19, MIN_PT - 1, -1),
                           lambda t: len(itens) <= LINHAS_TABELA and sum(_alturas_itens(itens, lw, t)) <= disp) or 16
    alturas = _alturas_itens(itens, lw, size)
    pags = _agrupar(alturas, disp - 0.4, 0.0, LINHAS_TABELA)
    if len(pags) == 1:
        pags = _agrupar(alturas, disp, 0.0, LINHAS_TABELA)
    for pi, idxs in enumerate(pags):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, sub, cont=cont_inicial or pi > 0)
        _tabela_itens(s, itens, idxs, alturas, X0, y, lw, size, pi < len(pags) - 1)
        # painel da direita repete em todas as páginas para orientar a plateia
        _painel_valores(s, rx, y, rw, BASE, total, comps, blocos)


def _layout_comparativo(n):
    """Cartões por linha: até 4 numa linha; 5 e 6 em duas linhas de 3."""
    return [n] if n <= 4 else [3, n - 3]


def s_comparativo(ctx, sl):
    ops = []
    for o in (sl.get('opcoes') or []) if isinstance(sl.get('opcoes'), list) else []:
        if not isinstance(o, dict):
            continue
        nome = _nb(_limpa(o.get('nome'))) or f'Opção {len(ops) + 1}'
        ops.append({'nome': nome, 'valor': _num(o.get('valor')), 'resumo': [_nb(t) for t in _lista(o.get('resumo'))],
                    'pagamento': _nb(_limpa(o.get('pagamento')))})
    if not ops:
        ctx.aviso('comparativo sem opções; slide ignorado.')
        return
    if len(ops) == 1:
        ctx.aviso('comparativo com uma opção só; não há o que comparar, mas o slide foi mantido.')
    vals = [o['valor'] for o in ops if o['valor'] is not None]
    menor = min(vals) if len(vals) >= 2 else None
    media = sum(vals) / len(vals) if (sl.get('mostrar_media') and len(vals) >= 2) else None
    if sl.get('mostrar_media') and media is None:
        ctx.aviso('comparativo pediu a média, mas há menos de dois valores; média não mostrada.')
    obs = _limpa(sl.get('observacao'))
    grupos = [ops[i:i + 6] for i in range(0, len(ops), 6)]
    if len(ops) > 6:
        ctx.aviso('mais de 6 opções no comparativo; o restante foi para outro slide.')
    sub = sl.get('subtitulo')
    for gi, grupo in enumerate(grupos):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Comparativo', sub if gi == 0 else None, cont=gi > 0)
        ultima = gi == len(grupos) - 1
        ho = _alt_obs(obs) if (obs and ultima) else 0
        hm = 0.95 if (media is not None and ultima) else 0
        fim = BASE - (ho + 0.18 if ho else 0) - (hm + 0.18 if hm else 0)
        filas = _layout_comparativo(len(grupo))
        compacto = len(filas) > 1
        gap_v = 0.45
        y_card = y + 0.3                      # espaço do selo de menor valor
        hcard = (fim - y_card - gap_v * (len(filas) - 1)) / len(filas)
        maxcol = max(filas)
        cw = (W - GAP * (maxcol - 1)) / maxcol
        tw = cw - 0.6
        tn_max, tv_max = (19, 28) if compacto else (22, 34)
        h_nome = lh(tn_max, True) * (1 if compacto else 2)
        fixo = 0.3 + h_nome + 0.1 + lh(tv_max, True) + 0.32 + 0.3

        def h_conteudo(o, t):
            h = fixo + _alt_topicos_simples(o['resumo'], tw - 0.3, t)
            if o['pagamento']:
                h += 0.45 + alt(o['pagamento'], t, tw)
            return h
        ts = _maior_que_cabe(range(18, MIN_PT - 1, -1), lambda t: all(h_conteudo(o, t) <= hcard for o in grupo)) or MIN_PT
        k = 0
        for fi, nfila in enumerate(filas):
            larg = cw * nfila + GAP * (nfila - 1)
            x0 = X0 + (W - larg) / 2
            yc = y_card + fi * (hcard + gap_v)
            for j in range(nfila):
                o = grupo[k]
                k += 1
                x = x0 + j * (cw + GAP)
                eh_menor = menor is not None and o['valor'] is not None and abs(o['valor'] - menor) < 0.005
                G.rect(s, x, yc, cw, hcard, G.CARD2 if eh_menor else G.CARD, True, 0.05)
                if eh_menor:
                    contorno(s, x, yc, cw, hcard, G.AMBER, 2.5, 0.05)
                    sw_ = G.largura('MENOR VALOR', 14, True) + 0.5
                    G.rect(s, x + (cw - sw_) / 2, yc - 0.23, sw_, 0.46, G.AMBER, True, 0.5)
                    G.text(s, x + (cw - sw_) / 2, yc - 0.23, sw_, 0.46, 'MENOR VALOR', 14, G.DARKTXT, True,
                           PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
                else:
                    G.rect(s, x, yc, cw, 0.1, G.GS_AZUL)
                yy = yc + 0.32
                nl_max = 1 if compacto else 2
                tn = _maior_que_cabe(range(tn_max, 13, -1), lambda t: linhas(o['nome'], t, tw, True) <= nl_max) or MIN_PT
                caixa(s, x + 0.3, yy, tw, h_nome, o['nome'], tn, G.TXT, True)
                yy += max(lh(tn, True) * min(nl_max, linhas(o['nome'], tn, tw, True)), lh(tn_max, True)) + 0.1
                if o['valor'] is not None:
                    v = G.brl(o['valor'])
                    G.text(s, x + 0.3, yy, tw, lh(tv_max, True), v, ajusta(v, tw, tv_max, True, 18),
                           G.AMBER if eh_menor else G.GS_AZUL_CLA, True)
                    yy += lh(tv_max, True)
                    if menor is not None and not eh_menor:
                        dif = o['valor'] - menor
                        pc = dif / menor * 100 if menor else 0
                        G.text(s, x + 0.3, yy, tw, 0.3, f'{G.brl(dif)} acima ({G.pct(pc)})', 14, G.TXT3)
                    elif eh_menor:
                        G.text(s, x + 0.3, yy, tw, 0.3, 'Proposta mais barata', 14, G.AMBER)
                else:
                    G.text(s, x + 0.3, yy, tw, lh(tv_max, True), 'Valor não informado', 18, G.TXT3, True)
                    yy += lh(tv_max, True)
                yy += 0.32
                if o['resumo'] or o['pagamento']:
                    G.rect(s, x + 0.3, yy, tw, 0.015, G.LINE)
                yy += 0.18
                for t in o['resumo']:
                    q = 0.1
                    G.rect(s, x + 0.32, yy + lh(ts) / 2 - q / 2, q, q, G.AMBER if eh_menor else G.GS_AZUL_CLA, True, 0.25)
                    ht = alt(t, ts, tw - 0.3)
                    caixa(s, x + 0.58, yy, tw - 0.3, ht, t, ts, G.TXT2)
                    yy += ht + 0.12
                if o['pagamento']:
                    hp = alt(o['pagamento'], ts, tw)
                    yb = max(yy + 0.05, yc + hcard - hp - 0.55)
                    G.text(s, x + 0.3, yb, tw, 0.3, 'PAGAMENTO', 14, G.TXT3, True)
                    caixa(s, x + 0.3, yb + 0.32, tw, hp, o['pagamento'], ts, G.TXT)
        yb = fim + 0.18
        if hm:
            G.rect(s, X0, yb, W, hm, G.GS_AZUL, True, 0.12)
            rot = f'MÉDIA DOS {len(vals)} ORÇAMENTOS'
            G.text(s, X0 + 0.4, yb, 7.5, hm, rot, 16, G.TXT, True, anchor=MSO_ANCHOR.MIDDLE)
            vm = G.brl(media)
            G.text(s, X0 + W - 4.4, yb, 4.0, hm, vm, 28, G.TXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
            if menor is not None and media > menor:
                eco = f'O menor valor fica {G.pct((media - menor) / media * 100)} abaixo da média'
                G.text(s, X0 + 0.4 + G.largura(rot, 16, True) + 0.5, yb, W - 5.3 - G.largura(rot, 16, True), hm,
                       eco, 15, G.TXT2, anchor=MSO_ANCHOR.MIDDLE)
            yb += hm + 0.18
        if ho:
            _faixa_obs(s, BASE - ho, obs)


def _alt_topicos_simples(tops, w, size):
    return sum(alt(t, size, w) + 0.12 for t in tops)


def _eh_numero(t: str) -> bool:
    return bool(t) and bool(re.fullmatch(r'[R$\s\d.,%()+x×/]*\d[R$\s\d.,%()+x×/]*', t))


def s_tabela(ctx, sl):
    cols = _lista(sl.get('colunas'))
    linhas_ = []
    for ln in (sl.get('linhas') or []):
        if isinstance(ln, (list, tuple)):
            linhas_.append([_nb(_valor_txt(c) if isinstance(c, (int, float)) and not isinstance(c, bool) else _limpa(c))
                            for c in ln])
        elif isinstance(ln, dict):
            linhas_.append([_nb(_limpa(v)) for v in ln.values()])
    if not linhas_ and not cols:
        ctx.aviso('tabela sem linhas; slide ignorado.')
        return
    tot = sl.get('total')
    total = [_nb(_valor_txt(c) if isinstance(c, (int, float)) and not isinstance(c, bool) else _limpa(c))
             for c in tot] if isinstance(tot, (list, tuple)) else None
    nc = max([len(cols)] + [len(r) for r in linhas_] + ([len(total)] if total else []))
    if nc > 8:
        ctx.aviso('tabela com mais de 8 colunas; só as 8 primeiras entraram.')
        nc = 8
    cols = (cols + [''] * nc)[:nc]
    linhas_ = [(r + [''] * nc)[:nc] for r in linhas_]
    if total:
        total = (total + [''] * nc)[:nc]
    obs = _limpa(sl.get('observacao'))
    sub = sl.get('subtitulo')
    numcol = [all(_eh_numero(r[c]) or not r[c] for r in linhas_ + ([total] if total else [])) and
              any(r[c] for r in linhas_) for c in range(nc)]
    numcol[0] = False if nc > 1 else numcol[0]

    def larguras(t):
        pad = 0.5
        nat = [max([G.largura(cols[c], 14, True)] + [G.largura(r[c], t, numcol[c]) for r in linhas_ + ([total] if total else [])]) + pad
               for c in range(nc)]
        if sum(nat) <= W:
            extra = W - sum(nat)
            txt = [c for c in range(nc) if not numcol[c]] or [0]
            for c in txt:
                nat[c] += extra / len(txt)
            return nat
        fixos = sum(nat[c] for c in range(nc) if numcol[c])
        livres = [c for c in range(nc) if not numcol[c]]
        if not livres or fixos > W * 0.7:
            return [W / nc] * nc
        resto = W - fixos
        soma_l = sum(nat[c] for c in livres)
        return [nat[c] if numcol[c] else max(1.2, resto * nat[c] / soma_l) for c in range(nc)]

    topo = 2.05 if sub else 1.75
    ho = _alt_obs(obs)

    def alturas(t, ws):
        return [max(0.56, max(alt(r[c], t, ws[c] - 0.5, numcol[c]) for c in range(nc)) + 0.24) for r in linhas_]

    def h_total(t, ws):
        return max(0.62, max(alt(total[c], t, ws[c] - 0.5, True) for c in range(nc)) + 0.26) if total else 0

    def h_cab(ws):
        return max(0.52, max(alt(cols[c], 14, ws[c] - 0.5, True) for c in range(nc)) + 0.22)

    def cabe(t):
        ws = larguras(t)
        h = h_cab(ws) + sum(alturas(t, ws)) + h_total(t, ws) + (ho + 0.2 if ho else 0)
        return len(linhas_) <= LINHAS_TABELA and h <= BASE - topo

    size = _maior_que_cabe(range(20, MIN_PT - 1, -1), cabe) or 16
    ws = larguras(size)
    hs = alturas(size, ws)
    hc = h_cab(ws)
    disp = BASE - topo - hc
    pags = _agrupar(hs, disp - 0.4, 0.0, LINHAS_TABELA) if linhas_ else [[]]
    # a última página precisa comportar o total e a observação
    if len(pags) and (sum(hs[i] for i in pags[-1]) + h_total(size, ws) + (ho + 0.2 if ho else 0) > disp):
        if len(pags[-1]) > 1:
            pags.append([pags[-1].pop()])
        else:
            pags.append([])
    for pi, idxs in enumerate(pags):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Tabela', sub if pi == 0 else None, cont=pi > 0)
        x = X0
        G.rect(s, X0, y, W, hc, G.GS_AZUL, True, 0.12)
        for c in range(nc):
            al = PP_ALIGN.RIGHT if numcol[c] else PP_ALIGN.LEFT
            caixa(s, x + 0.25, y, ws[c] - 0.5, hc, cols[c].upper(), 14, G.TXT, True, al, MSO_ANCHOR.MIDDLE)
            x += ws[c]
        yy = y + hc
        for k, i in enumerate(idxs):
            r = linhas_[i]
            if k % 2 == 1:
                G.rect(s, X0, yy, W, hs[i], G.CARD)
            x = X0
            for c in range(nc):
                al = PP_ALIGN.RIGHT if numcol[c] else PP_ALIGN.LEFT
                caixa(s, x + 0.25, yy, ws[c] - 0.5, hs[i], r[c], size, G.TXT if c == 0 or numcol[c] else G.TXT2,
                      numcol[c], al, MSO_ANCHOR.MIDDLE)
                x += ws[c]
            yy += hs[i]
        G.rect(s, X0, yy, W, 0.02, G.LINE)
        if pi == len(pags) - 1:
            if total:
                ht = h_total(size, ws)
                yy += 0.1
                G.rect(s, X0, yy, W, ht, G.AMBER, True, 0.12)
                x = X0
                for c in range(nc):
                    al = PP_ALIGN.RIGHT if numcol[c] else PP_ALIGN.LEFT
                    caixa(s, x + 0.25, yy, ws[c] - 0.5, ht, total[c].upper() if c == 0 else total[c], size, G.DARKTXT,
                          True, al, MSO_ANCHOR.MIDDLE)
                    x += ws[c]
                yy += ht
            if obs:
                _faixa_obs(s, max(yy + 0.25, BASE - ho) if BASE - ho - yy > 1.2 else yy + 0.25, obs)
        else:
            G.text(s, X0 + 0.25, yy + 0.12, W, 0.35, 'continua no próximo slide  ›', 16, G.TXT3)


def s_numeros(ctx, sl):
    cards = []
    for c in (sl.get('cards') or []):
        if isinstance(c, dict):
            v = _valor_txt(c.get('valor'))
            r = _limpa(c.get('rotulo'))
            if v or r:
                cards.append((r.upper(), _nb(v) or '[conferir]', _nb(_limpa(c.get('sub')))))
    if not cards:
        ctx.aviso('slide de números sem cartões; slide ignorado.')
        return
    grupos = [cards[i:i + 8] for i in range(0, len(cards), 8)]
    sub = sl.get('subtitulo')
    for gi, grupo in enumerate(grupos):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo'), sub if gi == 0 else None, cont=gi > 0)
        n = len(grupo)
        por_linha = n if n <= 4 else math.ceil(n / 2)
        nlin = math.ceil(n / por_linha)
        cw = (W - GAP * (por_linha - 1)) / por_linha
        disp = BASE - y
        h = min(2.6, (disp - GAP * (nlin - 1)) / nlin)
        bloco = h * nlin + GAP * (nlin - 1)
        y0 = y + max(0, (disp - bloco) * 0.35)
        vsize = min(ajusta(v, cw - 0.6, 44 if por_linha <= 3 else 36, True, 18) for _, v, _ in grupo)
        for k, (rot, v, sb) in enumerate(grupo):
            li, co = divmod(k, por_linha)
            x = X0 + co * (cw + GAP)
            yy = y0 + li * (h + GAP)
            cor = CORES_CARTAO[k % len(CORES_CARTAO)]
            G.rect(s, x, yy, cw, h, G.CARD, True, 0.06)
            G.rect(s, x, yy, 0.12, h, cor)
            hr = min(alt(rot, 14, cw - 0.6, True), 2 * lh(14, True))
            caixa(s, x + 0.38, yy + 0.3, cw - 0.6, hr, rot, 14, G.TXT3, True)
            vy = yy + 0.3 + hr + 0.2
            G.text(s, x + 0.38, vy, cw - 0.6, lh(vsize, True), v, vsize, cor, True)
            if sb:
                ts = 16 if linhas(sb, 16, cw - 0.6) <= 2 else MIN_PT
                hs_ = min(alt(sb, ts, cw - 0.6), yy + h - (vy + lh(vsize, True)) - 0.15)
                caixa(s, x + 0.38, yy + h - 0.25 - hs_, cw - 0.6, hs_, sb, ts, G.TXT2)


def _grade(n):
    """Linhas da grade de fotos: quantas fotos em cada linha."""
    return {1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3]}[n]


def _desenha_fotos(ctx, s, fotos, x0, y0, w, h):
    linhas_g = _grade(len(fotos))
    gap = 0.2
    hl = (h - gap * (len(linhas_g) - 1)) / len(linhas_g)
    k = 0
    for li, nlin in enumerate(linhas_g):
        cw = (w - gap * (max(linhas_g) - 1)) / max(linhas_g)
        larg = cw * nlin + gap * (nlin - 1)
        xs = x0 + (w - larg) / 2
        yl = y0 + li * (hl + gap)
        legs = [fotos[k + j][2] for j in range(nlin)]
        tl = 16 if max(len(linhas_g), 1) == 1 and nlin <= 2 else 15
        hleg = max([min(alt(lg, tl, cw - 0.4), 2 * lh(tl)) for lg in legs if lg] or [0])
        for j in range(nlin):
            caminho, tam, leg = fotos[k + j]
            x = xs + j * (cw + gap)
            G.rect(s, x, yl, cw, hl, G.CARD, True, 0.03)
            ha = hl - (hleg + 0.3 if hleg else 0)
            _encaixar_imagem(s, caminho, tam, x, yl, cw, ha, pad=0.1)
            if leg:
                caixa(s, x + 0.2, yl + ha + 0.02, cw - 0.4, hleg + 0.1, leg, tl, G.TXT2, align=PP_ALIGN.CENTER)
        k += nlin


def s_fotos(ctx, sl):
    itens = []
    for f in (sl.get('fotos') or []):
        fid, leg = (f.get('id'), f.get('legenda')) if isinstance(f, dict) else (f, None)
        if not fid:
            continue
        r = ctx.foto(fid)
        if r:
            itens.append((r[0], r[1], _nb(_limpa(leg))))
    if not itens:
        ctx.aviso('slide de fotos sem nenhuma foto disponível; slide ignorado.')
        return
    npags = math.ceil(len(itens) / 6)
    base_n, extra = divmod(len(itens), npags)
    sub = sl.get('subtitulo')
    k = 0
    for pi in range(npags):
        q = base_n + (1 if pi < extra else 0)
        grupo = itens[k:k + q]
        k += q
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Fotos', sub if pi == 0 else None, cont=pi > 0)
        _desenha_fotos(ctx, s, grupo, X0, y, W, BASE - y)


def s_foto_texto(ctx, sl):
    r = ctx.foto(sl.get('foto')) if sl.get('foto') else None
    if not sl.get('foto'):
        ctx.aviso('slide de foto com texto sem foto indicada.')
    tops = [_nb(t) for t in _lista(sl.get('topicos'))]
    valor = _nb(_valor_txt(sl.get('valor'))) if sl.get('valor') not in (None, '') else ''
    if not r and not tops and not valor:
        ctx.aviso('slide de foto com texto vazio; slide ignorado.')
        return
    s = ctx.novo()
    y = cabecalho(ctx, s, sl, sl.get('titulo'), sl.get('subtitulo'))
    if r:
        fx, fw = X0, 6.3
        _encaixar_imagem(s, r[0], r[1], fx, y, fw, BASE - y, fundo=G.CARD, pad=0.12)
        tx = fx + fw + 0.3
    else:
        tx = X0
    tw = X0 + W - tx
    hv = 1.5 if valor else 0
    disp = BASE - y - (hv + 0.2 if valor else 0)
    size = _maior_que_cabe(range(22, MIN_PT - 1, -1), lambda t: _alt_topicos(tops, tw, t) <= disp) or MIN_PT
    if _alt_topicos(tops, tw, size) > disp:
        ctx.aviso('os tópicos do slide de foto não couberam inteiros; resuma o texto.')
        while tops and _alt_topicos(tops, tw, size) > disp:
            tops = tops[:-1]
    _cartoes_topicos(s, tops, tx, y, tw, size)
    if valor:
        yv = BASE - hv
        G.rect(s, tx, yv, tw, hv, G.AMBER, True, 0.08)
        G.text(s, tx + 0.35, yv + 0.2, tw - 0.6, 0.3, 'VALOR', 14, G.DARKTXT, True)
        G.text(s, tx + 0.35, yv + 0.55, tw - 0.6, 0.8, valor, ajusta(valor, tw - 0.6, 36, True, 18), G.DARKTXT, True)


def s_documento(ctx, sl):
    did = sl.get('documento')
    if not did:
        ctx.aviso('slide de documento sem o id do documento; slide ignorado.')
        return
    info = ctx.doc_paginas(did)
    if not info:
        return
    _, total, _ = info
    pags = sl.get('paginas')
    if pags in (None, '', []):
        pags = [1]
    if not isinstance(pags, (list, tuple)):
        pags = [pags]
    validas = []
    for p in pags:
        n = _inteiro(p)
        if n is None or n > total:
            ctx.aviso(f'a página {_limpa(p)} não existe no documento "{_limpa(did)}" (ele tem {total} página{"s" if total > 1 else ""}).')
            continue
        if n not in validas:
            validas.append(n)
    if len(validas) > MAX_PAG_DOC:
        ctx.aviso(f'documento "{_limpa(did)}": entraram só as {MAX_PAG_DOC} primeiras páginas pedidas.')
        validas = validas[:MAX_PAG_DOC]
    imgs = [(p, ctx.doc_pagina(did, p)) for p in validas]
    imgs = [(p, r) for p, r in imgs if r]
    for k, (p, (caminho, tam)) in enumerate(imgs):
        s = ctx.novo()
        retrato = tam[1] >= tam[0] * 0.9
        if retrato:
            area_x0, area_x1, area_y0, area_y1 = 7.15, 12.83, 0.3, 6.95
            y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Documento', sl.get('subtitulo'), cont=False, w=6.3)
            yy = y + 0.1
            G.rect(s, X0, yy, 6.3, 1.25, G.CARD, True, 0.06)
            G.rect(s, X0, yy, 0.12, 1.25, G.GS_AZUL)
            G.text(s, X0 + 0.38, yy + 0.18, 5.6, 0.3, 'PÁGINA DO DOCUMENTO', 14, G.TXT3, True)
            G.text(s, X0 + 0.38, yy + 0.52, 5.6, 0.6, f'{p} de {total}', 28, G.GS_AZUL_CLA, True)
            caixa(s, X0, yy + 1.55, 6.3, 0.9, 'Documento na íntegra ao lado, como foi apresentado ao condomínio.', 16, G.TXT3)
            pad = 0.08
            mw, mh = area_x1 - area_x0 - 2 * pad, area_y1 - area_y0 - 2 * pad
            esc = min(mw / tam[0], mh / tam[1])
            w, h = tam[0] * esc, tam[1] * esc
            fx = area_x1 - (w + 2 * pad)
            fy = area_y0 + (mh - h) / 2
            G.rect(s, fx, fy, w + 2 * pad, h + 2 * pad, G.rgb('FFFFFF'), True, 0.02)
            s.shapes.add_picture(caminho, Inches(fx + pad), Inches(fy + pad), Inches(w), Inches(h))
        else:
            sub = f'Página {p} de {total}'
            y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Documento', sub, cont=False)
            _encaixar_imagem(s, caminho, tam, X0, y, W, BASE - y, fundo=G.rgb('FFFFFF'), pad=0.08)


def s_regimento(ctx, sl):
    atual_raw = sl.get('texto_atual')
    atual = _nb(_limpa(atual_raw)) if atual_raw not in (None, '', 'null') else ''
    prop = _nb(_limpa(sl.get('proposta')))
    if not prop:
        ctx.aviso('alteração de regimento sem a proposta; slide ignorado.')
        return
    just = _nb(_limpa(sl.get('justificativa')))
    art = _limpa(sl.get('artigo'))
    titulo = sl.get('titulo') or 'Regimento interno'
    cw = (W - 0.3) / 2
    tw = cw - 0.7
    topo = 2.05 if art else 1.75

    def h_just(t):
        return (alt(just, t, W - 0.7) + 0.72) if just else 0

    def disp_col(t, com_just=True):
        return BASE - topo - (h_just(t) + 0.2 if (just and com_just) else 0) - 0.95

    def cabe(t):
        return max(alt(atual or 'x', t, tw), alt(prop, t, tw, True)) <= disp_col(t)

    size = _maior_que_cabe(range(22, MIN_PT - 1, -1), cabe)
    if size is not None:
        pares = [(atual, prop)]
    else:
        size = 17
        hmax = disp_col(size, False)
        pa = _dividir_texto(atual, size, tw, hmax) if atual else ['']
        pp = _dividir_texto(prop, size, tw, hmax, True)
        n = max(len(pa), len(pp))
        pares = [(pa[i] if i < len(pa) else None, pp[i] if i < len(pp) else None) for i in range(n)]
        if just and max(alt(pares[-1][0] or '', size, tw), alt(pares[-1][1] or '', size, tw, True)) > disp_col(size):
            pares.append((None, None))
    for pi, (ta, tp) in enumerate(pares):
        s = ctx.novo()
        sub = art + (' (atual e proposta)' if False else '') if art else None
        y = cabecalho(ctx, s, sl, titulo, sub, cont=pi > 0, kicker=(f'ITEM {_numero_item(sl)} DA PAUTA  •  REGIMENTO INTERNO'
                                                                    if _numero_item(sl) else 'REGIMENTO INTERNO'))
        ultima = pi == len(pares) - 1
        hj = h_just(size) if (just and ultima) else 0
        if ta is not None or tp is not None:
            hc = BASE - y - (hj + 0.2 if hj else 0)
            # TEXTO ATUAL
            G.rect(s, X0, y, cw, hc, G.CARD, True, 0.04)
            G.text(s, X0 + 0.35, y + 0.28, tw, 0.3, 'TEXTO ATUAL', 14, G.TXT3, True)
            if ta is None:
                pass
            elif ta:
                caixa(s, X0 + 0.35, y + 0.75, tw, hc - 0.9, ta, size, G.TXT2)
            else:
                caixa(s, X0 + 0.35, y + 0.75, tw, hc - 0.9, 'Texto inexistente hoje', size, G.TXT3)
                G.text(s, X0 + 0.35, y + 0.75 + lh(size) + 0.12, tw, 0.6,
                       'O artigo é novo e passa a valer se aprovado.', 15, G.TXT3)
            # PROPOSTA em destaque azul
            xp = X0 + cw + 0.3
            G.rect(s, xp, y, cw, hc, G.GS_AZUL, True, 0.04)
            G.text(s, xp + 0.35, y + 0.28, tw, 0.3, 'PROPOSTA', 14, G.TXT, True)
            sw_ = G.largura('PROPOSTA', 14, True)
            G.rect(s, xp + 0.35 + sw_ + 0.15, y + 0.39, 0.09, 0.09, G.TXT, True, 0.5)
            if tp:
                caixa(s, xp + 0.35, y + 0.75, tw, hc - 0.9, tp, size, G.TXT, True)
        else:
            hj = h_just(size)
        if hj:
            yj = BASE - hj if (ta is not None or tp is not None) else y
            G.rect(s, X0, yj, W, hj, G.CARD2, True, 0.08)
            G.rect(s, X0, yj, 0.12, hj, G.AMBER)
            G.text(s, X0 + 0.38, yj + 0.18, 4, 0.3, 'JUSTIFICATIVA', 14, G.AMBER, True)
            caixa(s, X0 + 0.38, yj + 0.52, W - 0.7, hj - 0.6, just, size, G.TXT2)


def s_custeio(ctx, sl):
    total = _num(sl.get('valor_total'))
    unid = _inteiro(sl.get('unidades'))
    ops = []
    for o in (sl.get('opcoes') or []):
        if not isinstance(o, dict):
            continue
        p = _inteiro(o.get('parcelas')) or 1
        v = _num(o.get('valor_parcela'))
        ops.append((_limpa(o.get('nome')) or f'Opção {len(ops) + 1}', p, v, _nb(_limpa(o.get('observacao')))))
    if total is None and not ops:
        ctx.aviso('forma de custeio sem valor total e sem opções; slide ignorado.')
        return
    obs = _limpa(sl.get('observacao'))
    ho = _alt_obs(obs)
    grupos = [ops[i:i + 4] for i in range(0, len(ops), 4)] or [[]]
    for gi, grupo in enumerate(grupos):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Forma de custeio', sl.get('subtitulo') if gi == 0 else None, cont=gi > 0)
        fim = BASE - (ho + 0.2 if ho else 0)
        lw = 4.35
        ly = y
        if total is not None:
            hcard = 1.75
            G.rect(s, X0, ly, lw, hcard, G.AMBER, True, 0.07)
            G.text(s, X0 + 0.35, ly + 0.22, lw - 0.6, 0.3, 'VALOR TOTAL', 14, G.DARKTXT, True)
            vt = G.brl(total)
            G.text(s, X0 + 0.35, ly + 0.62, lw - 0.6, 0.8, vt, ajusta(vt, lw - 0.6, 36, True, 18), G.DARKTXT, True)
            ly += hcard + GAP
        if unid:
            hcard = min(2.1, fim - ly)
            G.rect(s, X0, ly, lw, hcard, G.CARD, True, 0.07)
            G.rect(s, X0, ly, 0.12, hcard, G.GS_AZUL_CLA)
            G.text(s, X0 + 0.35, ly + 0.22, lw - 0.6, 0.3, 'POR UNIDADE', 14, G.TXT3, True)
            if total is not None:
                vu = G.brl(total / unid)
                G.text(s, X0 + 0.35, ly + 0.6, lw - 0.6, 0.7, vu, ajusta(vu, lw - 0.6, 34, True, 18), G.GS_AZUL_CLA, True)
            caixa(s, X0 + 0.35, ly + hcard - 0.62, lw - 0.6, 0.4,
                  f'rateio entre {unid} unidades', 16, G.TXT2)
        # opções à direita (ou largura toda se não houver coluna da esquerda)
        tem_esq = total is not None or unid
        ox = X0 + lw + 0.3 if tem_esq else X0
        ow = X0 + W - ox
        if grupo:
            n = len(grupo)
            hop = min(1.55, (fim - y - GAP * (n - 1)) / n)
            for k, (nome, p, v, ob) in enumerate(grupo):
                yy = y + k * (hop + GAP)
                cor = G.cat_colors(max(len(ops), 2))[gi * 4 + k]
                G.rect(s, ox, yy, ow, hop, G.CARD, True, 0.08)
                G.rect(s, ox, yy, 0.12, hop, cor)
                G.text(s, ox + 0.38, yy + 0.16, 3.5, 0.3, nome.upper(), 14, G.TXT3, True)
                if v is not None:
                    parc = f'{p}x  {G.brl(v)}' if p > 1 else f'Parcela única de {G.brl(v)}'
                    tt = G.brl(p * v)
                    rot_t = 'TOTAL POR UNIDADE' if unid else 'TOTAL'
                    wt = max(G.largura(tt, 24, True), G.largura(rot_t, 14, True)) + 0.2
                    tp = ajusta(parc, ow - 0.75 - wt - 0.3, 30, True, 18)
                    G.text(s, ox + 0.38, yy + 0.5, ow - wt - 0.9, lh(tp, True), parc, tp, G.TXT, True)
                    G.text(s, ox + ow - wt - 0.3, yy + 0.16, wt, 0.3, rot_t, 14, G.TXT3, True, PP_ALIGN.RIGHT)
                    G.text(s, ox + ow - wt - 0.3, yy + 0.5, wt, lh(24, True), tt, 24, cor, True, PP_ALIGN.RIGHT)
                    if ob and hop >= 1.3:
                        G.text(s, ox + 0.38, yy + hop - 0.42, ow - 0.75, 0.3, ob, 14, G.TXT2)
                else:
                    G.text(s, ox + 0.38, yy + 0.5, ow - 0.75, 0.6, f'{p} parcela{"s" if p > 1 else ""}', 26, G.TXT, True)
        elif tem_esq:
            G.rect(s, ox, y, ow, 1.0, G.CARD, True, 0.08)
            G.text(s, ox + 0.38, y, ow - 0.75, 1.0, 'Forma de pagamento a definir na assembleia.', 18, G.TXT2,
                   anchor=MSO_ANCHOR.MIDDLE)
        if ho:
            _faixa_obs(s, BASE - ho, obs)


def s_votacao(ctx, sl):
    perg = _nb(_limpa(sl.get('pergunta')))
    ops = _lista(sl.get('opcoes')) or ['Aprovar', 'Não aprovar']
    if not perg:
        ctx.aviso('votação sem pergunta; usei o título do slide.')
        perg = _nb(_limpa(sl.get('titulo'))) or 'Deliberação'
    obs = _limpa(sl.get('observacao'))
    s = ctx.novo()
    y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Deliberação', sl.get('subtitulo'))
    ho = _alt_obs(obs)
    ops = ops[:6]
    nl_op = 1 if len(ops) <= 3 else 2
    hop = 1.05
    h_ops = nl_op * hop + (nl_op - 1) * GAP
    disp_q = BASE - y - h_ops - 0.35 - (ho + 0.2 if ho else 0)
    tw = W - 1.0
    tq = _maior_que_cabe(range(32, MIN_PT - 1, -1), lambda t: alt(perg, t, tw, True) + 0.85 <= disp_q) or MIN_PT
    hq = min(disp_q, max(1.9, alt(perg, tq, tw, True) + 0.95))
    G.rect(s, X0, y, W, hq, G.CARD, True, 0.05)
    G.rect(s, X0, y, 0.12, hq, G.AMBER)
    G.text(s, X0 + 0.45, y + 0.25, 4, 0.3, 'EM VOTAÇÃO', 14, G.AMBER, True)
    caixa(s, X0 + 0.45, y + 0.6, tw, hq - 0.75, perg, tq, G.TXT, True)
    yo = y + hq + 0.35
    por = len(ops) if nl_op == 1 else math.ceil(len(ops) / 2)
    cw = (W - GAP * (por - 1)) / por
    for k, op in enumerate(ops):
        li, co = divmod(k, por)
        x = X0 + co * (cw + GAP)
        yy = yo + li * (hop + GAP)
        G.rect(s, x, yy, cw, hop, G.CARD2, True, 0.1)
        d = 0.42
        oval(s, x + 0.35, yy + (hop - d) / 2, d, None, G.GS_AZUL_CLA, 2.5)
        letra = chr(65 + k)
        G.text(s, x + 0.35, yy + (hop - d) / 2, d, d, letra, 15, G.GS_AZUL_CLA, True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
        to = _maior_que_cabe(range(26, MIN_PT - 1, -1), lambda t: linhas(op, t, cw - 1.2, True) <= 2 and alt(op, t, cw - 1.2, True) <= hop - 0.2) or MIN_PT
        caixa(s, x + 1.0, yy, cw - 1.2, hop, op, to, G.TXT, True, anchor=MSO_ANCHOR.MIDDLE)
    if ho:
        _faixa_obs(s, BASE - ho, obs)


def s_eleicao(ctx, sl):
    cargos = []
    for c in (sl.get('cargos') or []):
        if isinstance(c, dict) and _limpa(c.get('cargo')):
            cargos.append({'cargo': _nb(_limpa(c.get('cargo'))), 'mandato': _nb(_limpa(c.get('mandato'))),
                           'cand': [_nb(t) for t in _lista(c.get('candidatos'))], 'obs': _nb(_limpa(c.get('observacao')))})
        elif isinstance(c, str) and _limpa(c):
            cargos.append({'cargo': _nb(_limpa(c)), 'mandato': '', 'cand': [], 'obs': ''})
    if not cargos:
        ctx.aviso('eleição sem cargos; slide ignorado.')
        return
    titulo = sl.get('titulo') or 'Eleição'
    if len(cargos) == 1:
        c = cargos[0]
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, sl.get('subtitulo'))
        tw = W - 0.8
        tc = _maior_que_cabe(range(34, 19, -1), lambda t: linhas(c['cargo'], t, tw, True) <= 2) or 20
        hc = alt(c['cargo'], tc, tw, True) + 0.85
        G.rect(s, X0, y, W, hc, G.CARD, True, 0.06)
        G.rect(s, X0, y, 0.12, hc, G.AMBER)
        G.text(s, X0 + 0.4, y + 0.22, 4, 0.3, 'CARGO EM ELEIÇÃO', 14, G.TXT3, True)
        caixa(s, X0 + 0.4, y + 0.56, tw, hc - 0.6, c['cargo'], tc, G.TXT, True)
        yy = y + hc + GAP
        cartoes = [(r, v) for r, v in (('MANDATO', c['mandato']), ('OBSERVAÇÃO', c['obs'])) if v]
        disp = BASE - yy
        hcand = 0
        if c['cand']:
            tcd = 20
            col = 2 if len(c['cand']) > 4 else 1
            hcand = 0.75 + math.ceil(len(c['cand']) / col) * (lh(tcd, True) + 0.1) + 0.2
        hrow = 0
        if cartoes:
            n = len(cartoes)
            cw = (W - GAP * (n - 1)) / n
            tv = 24
            hrow = max(0.7 + alt(v, tv, cw - 0.7, True) + 0.3 for _, v in cartoes)
            if hcand == 0:
                hrow = max(hrow, min(disp, 2.0))
            for k, (r, v) in enumerate(cartoes):
                x = X0 + k * (cw + GAP)
                G.rect(s, x, yy, cw, hrow, G.CARD, True, 0.06)
                G.rect(s, x, yy, 0.12, hrow, G.GS_AZUL_CLA if r == 'MANDATO' else G.GREEN)
                G.text(s, x + 0.38, yy + 0.24, cw - 0.6, 0.3, r, 14, G.TXT3, True)
                tvv = _maior_que_cabe(range(26, MIN_PT - 1, -1), lambda t: alt(v, t, cw - 0.7, True) <= hrow - 0.95) or MIN_PT
                caixa(s, x + 0.38, yy + 0.65, cw - 0.7, hrow - 0.75, v, tvv,
                      G.GS_AZUL_CLA if r == 'MANDATO' else G.TXT, True)
            yy += hrow + GAP
        if c['cand']:
            hcand = min(hcand, BASE - yy)
            G.rect(s, X0, yy, W, hcand, G.CARD2, True, 0.06)
            G.text(s, X0 + 0.4, yy + 0.22, 4, 0.3, 'CANDIDATOS', 14, G.AMBER, True)
            col = 2 if len(c['cand']) > 4 else 1
            por = math.ceil(len(c['cand']) / col)
            for k, nm in enumerate(c['cand']):
                cc, li = divmod(k, por)
                G.text(s, X0 + 0.4 + cc * 6.1, yy + 0.65 + li * (lh(20, True) + 0.1), 5.8, lh(20, True), nm,
                       ajusta(nm, 5.8, 20, True, MIN_PT), G.TXT, True)
        if not cartoes and not c['cand']:
            caixa(s, X0, yy + 0.2, W, 0.5, 'Candidaturas apresentadas na própria assembleia.', 18, G.TXT2)
        return
    # vários cargos: uma linha por cargo
    tw_esq = 5.6
    tw_dir = W - tw_esq - 1.2

    def h_cargo(c, t):
        esq = alt(c['cargo'], t + 2, tw_esq, True) + (0.12 + alt(c['mandato'], t - 2, tw_esq) if c['mandato'] else 0)
        cand = ', '.join(c['cand']) if c['cand'] else 'Candidaturas na assembleia'
        dir_ = 0.4 + alt(cand, t, tw_dir, True) + (0.12 + alt(c['obs'], t - 3, tw_dir) if c['obs'] else 0)
        return max(esq, dir_) + 0.5

    topo = 1.75
    disp = BASE - topo
    size = _maior_que_cabe(range(20, 16, -1), lambda t: sum(h_cargo(c, t) for c in cargos) + GAP * (len(cargos) - 1) <= disp) or 17
    hs = [h_cargo(c, size) for c in cargos]
    pags = _agrupar(hs, disp, GAP)
    for pi, idxs in enumerate(pags):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, None, cont=pi > 0)
        for i in idxs:
            c, h = cargos[i], hs[i]
            G.rect(s, X0, y, W, h, G.CARD, True, 0.06)
            G.rect(s, X0, y, 0.12, h, G.AMBER)
            hc = alt(c['cargo'], size + 2, tw_esq, True)
            caixa(s, X0 + 0.4, y + 0.25, tw_esq, hc, c['cargo'], size + 2, G.TXT, True)
            if c['mandato']:
                caixa(s, X0 + 0.4, y + 0.25 + hc + 0.12, tw_esq, h, f'Mandato: {c["mandato"]}', size - 2, G.GS_AZUL_CLA)
            xd = X0 + tw_esq + 0.8
            G.text(s, xd, y + 0.25, tw_dir, 0.3, 'CANDIDATOS', 14, G.TXT3, True)
            cand = ', '.join(c['cand']) if c['cand'] else 'Candidaturas na assembleia'
            hcd = alt(cand, size, tw_dir, True)
            caixa(s, xd, y + 0.6, tw_dir, hcd, cand, size, G.TXT if c['cand'] else G.TXT2, True)
            if c['obs']:
                caixa(s, xd, y + 0.6 + hcd + 0.12, tw_dir, h, c['obs'], size - 3, G.AMBER)
            y += h + GAP


def s_antes_depois(ctx, sl):
    ra = ctx.foto(sl.get('antes')) if sl.get('antes') else None
    rd = ctx.foto(sl.get('depois')) if sl.get('depois') else None
    if not sl.get('antes') or not sl.get('depois'):
        ctx.aviso('antes e depois sem uma das fotos indicadas.')
    if not ra and not rd:
        ctx.aviso('antes e depois sem nenhuma foto disponível; slide ignorado.')
        return
    tops = [_nb(t) for t in _lista(sl.get('topicos'))]
    s = ctx.novo()
    y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Antes e depois', sl.get('subtitulo'))
    # tópicos numa faixa embaixo, em até duas colunas
    hb = 0
    tsz = 18
    if tops:
        ncol = 2 if len(tops) > 1 else 1
        cw_t = (W - 0.6 - 0.4 * (ncol - 1)) / ncol
        por = math.ceil(len(tops) / ncol)

        def h_tops(t):
            cols_ = [tops[i * por:(i + 1) * por] for i in range(ncol)]
            return max(sum(alt(x, t, cw_t - 0.3) + 0.1 for x in c) for c in cols_) + 0.4
        tsz = _maior_que_cabe(range(20, MIN_PT - 1, -1), lambda t: h_tops(t) <= 1.9) or MIN_PT
        hb = min(h_tops(tsz), 2.2)
    hf = BASE - y - (hb + GAP if hb else 0)
    fw = (W - 0.3) / 2
    for k, (r, rot, cor) in enumerate(((ra, 'ANTES', G.TXT3), (rd, 'DEPOIS', G.AMBER))):
        x = X0 + k * (fw + 0.3)
        G.rect(s, x, y, fw, hf, G.CARD, True, 0.03)
        if r:
            _encaixar_imagem(s, r[0], r[1], x, y, fw, hf, pad=0.1)
        else:
            G.text(s, x, y, fw, hf, 'Foto não enviada', 18, G.TXT3, True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
        sw_ = G.largura(rot, 16, True) + 0.5
        G.rect(s, x + 0.22, y + 0.22, sw_, 0.48, cor if rot == 'DEPOIS' else G.BG, True, 0.5)
        G.text(s, x + 0.22, y + 0.22, sw_, 0.48, rot, 16, G.DARKTXT if rot == 'DEPOIS' else G.TXT, True,
               PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
    if hb:
        yb = BASE - hb
        G.rect(s, X0, yb, W, hb, G.CARD, True, min(0.08, 0.3 / hb))
        G.rect(s, X0, yb, 0.12, hb, G.AMBER)
        cols_ = [tops[i * por:(i + 1) * por] for i in range(ncol)]
        for ci, col in enumerate(cols_):
            xx = X0 + 0.4 + ci * (cw_t + 0.4)
            yy = yb + 0.2
            for t in col:
                ht = alt(t, tsz, cw_t - 0.3)
                if yy + ht > BASE - 0.1:
                    break
                q = 0.1
                G.rect(s, xx, yy + lh(tsz) / 2 - q / 2, q, q, G.AMBER, True, 0.25)
                caixa(s, xx + 0.28, yy, cw_t - 0.3, ht, t, tsz, G.TXT)
                yy += ht + 0.1


def s_linha_do_tempo(ctx, sl):
    evs = []
    for e in (sl.get('eventos') or []) if isinstance(sl.get('eventos'), list) else []:
        if isinstance(e, dict):
            d, t, x = _nb(_limpa(e.get('data'))), _nb(_limpa(e.get('titulo'))), _nb(_limpa(e.get('texto')))
            if d or t or x:
                evs.append((d, t, x))
    if not evs:
        ctx.aviso('linha do tempo sem eventos; slide ignorado.')
        return
    npags = math.ceil(len(evs) / 6)
    base_n, extra = divmod(len(evs), npags)
    k = 0
    for pi in range(npags):
        q = base_n + (1 if pi < extra else 0)
        grupo = evs[k:k + q]
        k += q
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Linha do tempo', sl.get('subtitulo') if pi == 0 else None,
                      cont=pi > 0)
        n = len(grupo)
        if n <= 4:
            _tempo_horizontal(s, grupo, y)
        else:
            _tempo_vertical(s, grupo, y)


def _tempo_horizontal(s, grupo, y):
    """Linha horizontal com marcadores e um cartão por evento embaixo."""
    n = len(grupo)
    cw = (W - GAP * (n - 1)) / n
    yl = y + 0.55
    G.rect(s, X0 + cw / 2, yl - 0.03, W - cw, 0.06, G.GS_AZUL)
    tw = cw - 0.6
    hc = BASE - (yl + 0.55)

    def h_ev(t, ev):
        d, ti, tx = ev
        return 0.3 + (lh(16, True) + 0.1 if d else 0) + (alt(ti, t + 3, tw, True) + 0.15 if ti else 0) + \
            (alt(tx, t, tw) if tx else 0) + 0.3
    ts = _maior_que_cabe(range(19, MIN_PT - 1, -1), lambda t: all(h_ev(t, e) <= hc for e in grupo)) or MIN_PT
    hreal = min(hc, max(h_ev(ts, e) for e in grupo) + 0.3)
    for i, (d, ti, tx) in enumerate(grupo):
        x = X0 + i * (cw + GAP)
        cx = x + cw / 2
        ult = i == n - 1
        oval(s, cx - 0.22, yl - 0.22, 0.44, G.AMBER if ult else G.BG, G.AMBER if ult else G.GS_AZUL_CLA, 3)
        # haste do marcador até o cartão
        G.rect(s, cx - 0.015, yl + 0.22, 0.03, 0.33, G.LINE)
        yc = yl + 0.55
        G.rect(s, x, yc, cw, hreal, G.CARD, True, min(0.06, 0.3 / hreal))
        G.rect(s, x, yc, cw, 0.08, G.AMBER if ult else G.GS_AZUL_CLA)
        yy = yc + 0.3
        if d:
            G.text(s, x + 0.3, yy, tw, lh(16, True), d.upper(), ajusta(d.upper(), tw, 16, True, MIN_PT),
                   G.AMBER if ult else G.GS_AZUL_CLA, True)
            yy += lh(16, True) + 0.1
        if ti:
            ht = alt(ti, ts + 3, tw, True)
            caixa(s, x + 0.3, yy, tw, ht, ti, ts + 3, G.TXT, True)
            yy += ht + 0.15
        if tx:
            caixa(s, x + 0.3, yy, tw, alt(tx, ts, tw), tx, ts, G.TXT2)


def _tempo_vertical(s, grupo, y):
    """Linha vertical à esquerda, data e evento em cada linha (5 ou 6 eventos)."""
    n = len(grupo)
    disp = BASE - y
    xd, wd = X0 + 0.9, 2.3
    xt = xd + wd + 0.3
    tw = X0 + W - xt - 0.3

    def h_ev(t, ev):
        _, ti, tx = ev
        return max(lh(t + 2, True), (alt(ti, t + 2, tw, True) if ti else 0) + (0.06 + alt(tx, t - 1, tw) if tx else 0)) + 0.3
    ts = _maior_que_cabe(range(19, MIN_PT, -1), lambda t: sum(h_ev(t, e) for e in grupo) + 0.12 * (n - 1) <= disp) or MIN_PT + 1
    hs = [h_ev(ts, e) for e in grupo]
    tot = sum(hs) + 0.12 * (n - 1)
    yy = y + max(0, (disp - tot) / 2)
    cxl = X0 + 0.35
    G.rect(s, cxl - 0.03, yy + hs[0] / 2, 0.06, tot - hs[0] / 2 - hs[-1] / 2, G.GS_AZUL)
    for i, ((d, ti, tx), h) in enumerate(zip(grupo, hs)):
        ult = i == n - 1
        cy = yy + h / 2
        oval(s, cxl - 0.18, cy - 0.18, 0.36, G.AMBER if ult else G.BG, G.AMBER if ult else G.GS_AZUL_CLA, 3)
        G.rect(s, xd, yy, X0 + W - xd, h, G.CARD, True, min(0.08, 0.3 / h))
        if d:
            G.text(s, xd + 0.25, yy, wd - 0.2, h, d.upper(), ajusta(d.upper(), wd - 0.3, 17, True, MIN_PT),
                   G.AMBER if ult else G.GS_AZUL_CLA, True, anchor=MSO_ANCHOR.MIDDLE)
        partes = []
        if ti:
            partes.append([(ti, ts + 2, True, G.TXT)])
        if tx:
            partes.append([(tx, ts - 1, False, G.TXT2)])
        if partes:
            caixa(s, xt, yy, tw, h, partes, ts, anchor=MSO_ANCHOR.MIDDLE, espaco=0.06)
        yy += h + 0.12


def s_encerramento(ctx, sl):
    msg = _nb(_limpa(sl.get('mensagem'))) or MSG_ENCERRAMENTO
    s = ctx.novo()
    G.rect(s, 0, 0, SW, 0.083, G.GS_AZUL)
    s.shapes.add_picture(G.LOGO_GS, Inches(0.94), Inches(0.75), height=Inches(0.95))
    G.text(s, 0.94, 2.3, 9, 0.45, 'ENCERRAMENTO', 18, G.GS_AZUL_CLA, True)
    # Última frase em azul claro, como a palavra de destaque dos títulos.
    frases = re.split(r'(?<=[.!?])\s+', msg)
    t1 = ' '.join(frases[:-1])
    t2 = frases[-1]
    tw = 11.45
    tam = _maior_que_cabe(range(40, 19, -2), lambda t: alt(msg, t, tw, True) <= 3.0) or 20
    if alt(msg, tam, tw, True) > 3.3:
        tam = _maior_que_cabe(range(19, MIN_PT - 1, -1), lambda t: alt(msg, t, tw, True) <= 3.4) or MIN_PT
    partes = ([(t1 + ' ', tam, True, G.TXT)] if t1 else []) + [(t2, tam, True, G.GS_AZUL_CLA)]
    hm = alt(msg, tam, tw, True)
    caixa(s, 0.94, 2.85, tw, hm + 0.1, [partes], tam, bold=True)
    G.hline(s, 0.94, 2.85 + hm + 0.3, 1.9, G.GS_AZUL, 4)
    G.rect(s, 0.94, 6.45, 11.45, 0.012, G.LINE)
    G.text(s, 0.94, 6.62, 11.45, 0.4, 'Contábil Service    •    Condomínio Service    •    RH Service', 15, G.TXT3)


TIPOS = {
    'capa': s_capa, 'pauta': s_pauta, 'item': s_item, 'texto': s_texto, 'topicos': s_topicos,
    'colunas': s_colunas, 'orcamento': s_orcamento, 'comparativo': s_comparativo, 'tabela': s_tabela,
    'numeros': s_numeros, 'fotos': s_fotos, 'foto_texto': s_foto_texto, 'documento': s_documento,
    'regimento': s_regimento, 'custeio': s_custeio, 'votacao': s_votacao, 'eleicao': s_eleicao,
    'antes_depois': s_antes_depois, 'linha_do_tempo': s_linha_do_tempo,
    'encerramento': s_encerramento,
}


def _tipo(v) -> str:
    t = unicodedata.normalize('NFKD', str(v or '')).encode('ascii', 'ignore').decode().strip().lower()
    return re.sub(r'[\s\-]+', '_', t)


# ───────────────────────── montagem ─────────────────────────

def desenhar(roteiro: dict, fotos: dict, documentos: dict, pasta: str):
    """Monta só o PPTX. Devolve (Presentation, avisos)."""
    ctx = Ctx(fotos, documentos, pasta)
    slides = roteiro.get('slides') if isinstance(roteiro, dict) else None
    if not isinstance(slides, list) or not slides:
        raise ErroPrestacao('O roteiro não tem slides.')
    capa = next((sl for sl in slides if isinstance(sl, dict) and _tipo(sl.get('tipo')) == 'capa'), None)
    if capa:
        partes = ['Grupo Service'] + [t for t in (_limpa(capa.get('condominio')), _limpa(capa.get('data'))) if t]
        ctx.rodape = '  ·  '.join(partes)
    else:
        ctx.aviso('o roteiro não tem capa; o rodapé saiu sem o nome do condomínio e a data.')
    pauta = next((sl for sl in slides if isinstance(sl, dict) and _tipo(sl.get('tipo')) == 'pauta'), None)
    if pauta:
        ctx.total_itens = len(_lista(pauta.get('itens')))
    for i, sl in enumerate(slides, start=1):
        ctx.slide_atual = i
        if len(ctx.prs.slides) >= MAX_SLIDES_SAIDA:
            ctx.aviso(f'a apresentação passou de {MAX_SLIDES_SAIDA} slides; o restante do roteiro ficou de fora.')
            break
        if not isinstance(sl, dict):
            ctx.aviso('item do roteiro não é um slide válido; ignorado.')
            continue
        tipo = _tipo(sl.get('tipo'))
        fn = TIPOS.get(tipo)
        if fn is None:
            ctx.aviso(f'tipo "{_limpa(sl.get("tipo")) or "vazio"}" não existe; slide ignorado.')
            continue
        antes = len(ctx.prs.slides)
        try:
            fn(ctx, sl)
        except Exception as e:  # o roteiro vem de IA: um slide ruim nunca derruba a apresentação
            ctx.remover_desde(antes)
            print(f'[prestacao-pdf] apresentacao_slide_falhou tipo={tipo} pos={i} erro={type(e).__name__}: {str(e)[:200]}',
                  file=sys.stderr, flush=True)
            ctx.aviso(f'o slide do tipo "{tipo}" não pôde ser desenhado com os dados recebidos; ficou de fora.')
    ctx.slide_atual = 0
    if not len(ctx.prs.slides):
        raise ErroPrestacao('Nenhum slide do roteiro pôde ser desenhado.')
    return ctx.prs, ctx.avisos


def converter_pdf(pptx_path: str, pasta: str) -> bytes:
    _garante_fontes(pasta)
    env = dict(os.environ, HOME=pasta)
    try:
        subprocess.run(['soffice', '--headless', f'-env:UserInstallation=file://{pasta}/lo', '--convert-to', 'pdf',
                        '--outdir', pasta, pptx_path], cwd=pasta, capture_output=True, timeout=300, env=env)
    except subprocess.TimeoutExpired:
        raise ErroConversao('A conversão para PDF demorou mais que o limite.')
    pdf = os.path.splitext(pptx_path)[0] + '.pdf'
    if not os.path.exists(pdf):
        raise ErroConversao('Não foi possível converter a apresentação em PDF.')
    return Path(pdf).read_bytes()


def montar(roteiro: dict, fotos: dict, documentos: dict, pasta: str):
    """Devolve (bytes_pptx, bytes_pdf, avisos, n_slides)."""
    os.makedirs(pasta, exist_ok=True)
    prs, avisos = desenhar(roteiro, fotos or {}, documentos or {}, pasta)
    pptx_path = os.path.join(pasta, 'apresentacao.pptx')
    prs.save(pptx_path)
    pdf = converter_pdf(pptx_path, pasta)
    return Path(pptx_path).read_bytes(), pdf, avisos, len(prs.slides)
