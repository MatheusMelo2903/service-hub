# -*- coding: utf-8 -*-
"""Motor de layouts da apresentação de assembleia (PPTX e PDF).

A IA do Hub monta só o ROTEIRO (um JSON com a lista de slides, contrato em
servico/apresentacao/guia.md). Aqui cada slide do roteiro é desenhado sem IA,
na identidade da prestação de contas: primitivas e paleta do gerador aprovado
(vendor/skill_v13/scripts/gerador.py, que não é alterado) e os componentes da
AGE da Fazenda Barão do Império montada à mão e aprovada (capa com chamadas,
orientações, pauta em grade com etiqueta, divisor com número gigante e barra de
progresso, cartões com chip de status, barras, passos, votação, logo do cliente).

Regras que valem para todo slide, porque o roteiro vem de uma IA:
  tipo desconhecido ou campo faltando vira aviso em português, nunca exceção;
  texto medido com a métrica real das fontes (Poppins e Inter) com 10% de folga,
  porque o LibreOffice quebra a linha antes do que a conta exata diz;
  blocos encadeados: cada bloco começa abaixo da altura MEDIDA do anterior;
  texto que não cabe reduz a letra até 14pt e, se ainda não couber, continua
  em outro slide com "(continuação)" no título.

Depois de montar, a auditoria visual da skill (auditar_apresentacao.py) procura
sobreposição e texto saindo do slide; o que sobrar vira aviso. Por último uma
varredura troca hífen e travessão usados como pontuação por vírgula.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import re
import subprocess
import sys
import unicodedata
import uuid
import zipfile
from pathlib import Path

import numpy as np
from lxml import etree
from PIL import Image, ImageOps
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE, MSO_SHAPE_TYPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.opc.package import Part
from pptx.opc.packuri import PackURI
from pptx.util import Emu, Inches, Pt

from .v13 import SCRIPTS, ErroPrestacao

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import gerador as G  # noqa: E402  (primitivas e paleta do padrão aprovado)
import auditar_apresentacao as AUD  # noqa: E402  (auditoria visual da skill)

from .certidoes_deck import _garante_fontes, _recortar_margem  # noqa: E402

# ── medidas da página (iguais às do gerador) ──
SW, SH = 13.333, 7.5
X0, W = 0.5, 12.33           # margem esquerda e largura útil
BASE = 6.92                  # limite de baixo do conteúdo (rodapé começa em 7.02)
GAP = 0.18                   # espaço padrão entre cartões
MIN_PT = 14                  # nada abaixo disso no conteúdo
FOLGA = 0.90                 # 10% de folga na largura medida (o LibreOffice quebra antes)

MAX_FOTO_PX = 1800
DPI_DOC = 160
MAX_PAG_DOC = 4
MAX_SLIDES_SAIDA = 160       # trava de segurança do arquivo final
LINHAS_TABELA = 12

MSG_ENCERRAMENTO = ("A sua participação é essencial para o bom funcionamento e andamento do "
                    "nosso condomínio. Agradecemos a presença de todos!")

# Espaçamento de linha fixo (em múltiplos do corpo). Com o espaçamento fixo a
# altura medida é a desenhada, no LibreOffice e no PowerPoint.
FATOR = {True: 1.28, False: 1.24}

# Cores além da paleta do gerador, vindas da AGE aprovada.
AMBAR = G.rgb('F2B84B')         # pendência, deliberação
NUM_BG = G.rgb('302B31')        # número gigante do divisor (quase o fundo)
PAINEL_CLARO = G.rgb('F4F5F7')  # fundo de imagem com texto embutido (documento, planta, print)
CLARO_RGB = (244, 245, 247)
VIOLETA = G.rgb('8E9BF5')
CICLO = [G.GS_AZUL_CLA, G.AMBER, G.GREEN, AMBAR, VIOLETA, G.rgb('2DD4BF')]

ETIQUETAS = {'APRESENTAÇÃO': G.GS_AZUL_CLA, 'DEFINIÇÃO': G.AMBER, 'VOTAÇÃO': G.GREEN,
             'DELIBERAÇÃO': AMBAR, 'ABERTO': G.TXT3, 'ELEIÇÃO': VIOLETA, 'INFORMATIVO': G.GS_AZUL_CLA}
SIGLAS = {'AGE': 'Assembleia Geral Extraordinária', 'AGO': 'Assembleia Geral Ordinária',
          'AGOE': 'Assembleia Geral Ordinária e Extraordinária'}
MARCA = 'Contábil Service    •    Condomínio Service    •    RH Service'


class ErroConversao(Exception):
    """Falha do LibreOffice ao gerar o PDF (erro do servidor, não da entrada)."""


# ───────────────────────── texto e números ─────────────────────────

_TRACO = re.compile(r'\s+[\-–—]+\s+|(?<=\D)[–—](?=\D)|^[–—]|[–—]$')


def _sem_traco(t: str) -> str:
    """Troca hífen e travessão usados como pontuação por vírgula. Hífen dentro de
    palavra, CNPJ, CEP, datas e números fica como está."""
    t = re.sub(r'^\s*[\-–—••]+\s+', '', t)          # marcador de lista no começo
    t = _TRACO.sub(', ', t)
    t = re.sub(r'\s+,', ',', t)
    t = re.sub(r',\s*,', ',', t)
    t = re.sub(r'^,\s*', '', t)
    return re.sub(r',\s*$', '', t)


def _limpa(v) -> str:
    if v is None or isinstance(v, (dict, list, tuple, bool)):
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    t = str(v).replace('\r', '').replace('\t', ' ').strip()
    t = re.sub(r'[ ]+', ' ', t)
    return _sem_traco(t).strip()


def _lista(v) -> list[str]:
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, (list, tuple)):
        return []
    return [t for t in (_limpa(x) for x in v) if t]


def _num(v):
    """Número de um campo de valor: aceita 1234.5, "1234.5" ou "R$ 1.234,50"."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    t = str(v).replace('R$', '').replace(' ', '').replace(' ', '').strip()
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


def _brl(v) -> str:
    return ('-' if v < 0 else '') + G.brl(abs(v))


def _valor_txt(v) -> str:
    """Valor para exibir: número vira R$ formatado; texto passa como veio."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return _brl(float(v))
    return _limpa(v)


def _inteiro(v):
    n = _num(v)
    if n is None or n <= 0:
        return None
    return int(round(n))


def _nb(t: str) -> str:
    """R$ e valor nunca separados na quebra de linha."""
    return (t or '').replace('R$ ', 'R$ ')


def _sem_acento(t: str) -> str:
    return unicodedata.normalize('NFKD', t or '').encode('ascii', 'ignore').decode().lower()


# ───────────────────────── medida de texto ─────────────────────────

def larg(t, size, bold=False) -> float:
    return G.largura(t, size, bold)


def lh(size, bold=False) -> float:
    return size * FATOR[bool(bold)] / 72


def linhas(t: str, size, w, bold=False) -> int:
    """Linhas que o texto ocupa na largura w, com 10% de folga."""
    if not t:
        return 0
    lim = w * FOLGA
    esp = larg(' ', size, bold)
    tot = 0
    for par in t.split('\n'):
        lin, cur = 1, 0.0
        for pal in par.split(' '):
            if not pal:
                continue
            lp = larg(pal, size, bold)
            if cur == 0:
                cur = lp
            elif cur + esp + lp <= lim:
                cur += esp + lp
            else:
                lin += 1
                cur = lp
        tot += lin
    return tot


def alt(t: str, size, w, bold=False) -> float:
    return linhas(t, size, w, bold) * lh(size, bold)


def alt_paras(paras, size, w, bold=False, espaco=0.0) -> float:
    if not paras:
        return 0.0
    return sum(alt(p, size, w, bold) for p in paras) + espaco * (len(paras) - 1)


def cabe_linha(t, size, w, bold=True) -> bool:
    return larg(t, size, bold) <= w * 0.94


def ajusta(t, w, size, bold=True, minimo=MIN_PT) -> int:
    while size > minimo and not cabe_linha(t, size, w, bold):
        size -= 1
    return size


def _maior_que_cabe(tamanhos, cabe):
    for t in tamanhos:
        if cabe(t):
            return t
    return None


def caixa(s, x, y, w, h, paras, size, cor=G.TXT, bold=False, align=PP_ALIGN.LEFT,
          anchor=MSO_ANCHOR.TOP, espaco=0.0):
    """Caixa de texto com espaçamento de linha fixo. Cada item de paras é um parágrafo:
    texto simples, ou lista de partes (texto, tamanho, negrito, cor)."""
    tb = s.shapes.add_textbox(Inches(x), Inches(y), Inches(max(w, 0.1)), Inches(max(h, 0.1)))
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
        p.line_spacing = Pt(maior * FATOR[any(pp[2] for pp in partes)])
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


def forma(s, tipo, x, y, w, h, fill=None, line=None, peso=2.0, corner=None):
    sh = s.shapes.add_shape(tipo, Inches(x), Inches(y), Inches(w), Inches(h))
    if corner is not None:
        sh.adjustments[0] = corner
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


def oval(s, x, y, d, fill=None, line=None, peso=2.0):
    return forma(s, MSO_SHAPE.OVAL, x, y, d, d, fill, line, peso)


def contorno(s, x, y, w, h, cor, peso=2.0, corner=0.06):
    return forma(s, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h, None, cor, peso, corner)


def cartao(s, x, y, w, h, fill=G.CARD, corner=0.06):
    """Retângulo arredondado com o canto proporcional ao lado menor (não vira pílula)."""
    return G.rect(s, x, y, w, h, fill, True, min(corner, 0.12 / max(min(w, h), 0.1)))


def chip(s, x, y, t, cor, size=12, h=0.3, txtcor=None):
    """Etiqueta em pílula. Devolve a largura."""
    w = largura_chip(t, size)
    G.rect(s, x, y, w, h, cor, True, 0.5)
    G.text(s, x, y, w, h, t, size, txtcor or G.DARKTXT, True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
    return w


def largura_chip(t, size=12):
    return larg(t, size, True) / 0.92 + 0.3


def marcador(s, x, y, size, cor, bold=False):
    """Quadradinho de lista alinhado ao meio da primeira linha."""
    q = 0.1
    G.rect(s, x, y + lh(size, bold) / 2 - q / 2, q, q, cor, True, 0.25)


def tit_desc(s, x, y, w, t, ts, d, ds, tc=G.TXT, dc=G.TXT2, gap=0.12, align=PP_ALIGN.LEFT) -> float:
    """Título e descrição encadeados: a descrição começa abaixo da altura MEDIDA do título."""
    # Os dois numa caixa só, em parágrafos: o LibreOffice encadeia a descrição logo
    # abaixo do título como ele realmente quebrou, sem vão quando a medida sobra.
    partes = ([[(t, ts, True, tc)]] if t else []) + ([[(d, ds, False, dc)]] if d else [])
    if not partes:
        return y
    h = alt_tit_desc(t, ts, d, ds, w, gap)
    tb = caixa(s, x, y, w, h, partes, ts, align=align)
    if t and d:
        tb.text_frame.paragraphs[1].space_before = Pt(gap * 72)
    return y + h


def alt_tit_desc(t, ts, d, ds, w, gap=0.12) -> float:
    return (alt(t, ts, w, True) if t else 0) + (gap if t and d else 0) + (alt(d, ds, w) if d else 0)


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
    """Distribui blocos de altura conhecida em páginas, em ordem, sem estourar disp,
    e equilibra para a última página não ficar com um bloco só."""
    pags, cur, acc = [], [], 0.0
    for i, h in enumerate(alturas):
        extra = h + (gap if cur else 0)
        if cur and (acc + extra > disp or (max_itens and len(cur) >= max_itens)):
            pags.append(cur)
            cur, acc, extra = [], 0.0, h
        cur.append(i)
        acc += extra
    if cur:
        pags.append(cur)
    while len(pags) >= 2 and len(pags[-2]) > len(pags[-1]) + 1:
        nova = [pags[-2][-1]] + pags[-1]
        if sum(alturas[i] for i in nova) + gap * (len(nova) - 1) > disp or (max_itens and len(nova) > max_itens):
            break
        pags[-2].pop()
        pags[-1] = nova
    return pags


def _grade(n) -> list[int]:
    """Quantos cartões em cada linha da grade."""
    if n <= 3:
        return [n]
    if n == 4:
        return [2, 2]
    if n <= 6:
        return [3, n - 3]
    if n <= 8:
        return [4, n - 4]
    return [3, 3, n - 6]


def _cor_status(st: str):
    t = _sem_acento(st)
    if any(k in t for k in ('conclu', 'entreg', 'aprovad', 'realizad', 'pago', 'finaliz', 'regular', 'resolvid')):
        return G.GREEN
    if any(k in t for k in ('critic', 'urgent', 'atrasad', 'reprovad', 'risco', 'vencid', 'irregular')):
        return G.RED
    if any(k in t for k in ('pendent', 'orcament', 'aguard', 'negocia', 'solicitad', 'definir', 'analise', 'previst')):
        return AMBAR
    return G.GS_AZUL_CLA


# ───────────────────────── imagens ─────────────────────────

def _parece_grafico(im: Image.Image) -> bool:
    """Imagem com texto embutido (documento, planta, print): muito fundo claro e liso.
    Essas entram inteiras sobre painel claro; foto comum é recortada no centro."""
    p = np.asarray(im.convert('RGB').resize((96, 96)), dtype=np.int16)
    mx, mn = p.max(axis=2), p.min(axis=2)
    return float(((mn > 222) & (mx - mn < 22)).mean()) > 0.32


class Imagem:
    """Imagem pronta para o slide. "rotulo" vira o nome da forma no PPTX ("foto:f3",
    "doc:d1:p2"), para o modo atualizar achar a imagem original só com o arquivo."""

    def __init__(self, caminho, tam, grafico, rotulo=None):
        self.caminho, self.tam, self.grafico, self.rotulo = caminho, tam, grafico, rotulo


def _nomear(forma, rotulo):
    if rotulo:
        forma.name = str(rotulo)[:120]
    return forma


def _carregar(dado: bytes, pasta: str, nome: str) -> Imagem:
    im = Image.open(io.BytesIO(dado))
    im.load()
    caminho = os.path.join(pasta, nome + '.jpg')
    # JPEG já no tamanho e sem giro (foto do navegador ou tirada de uma apresentação gerada
    # aqui): vai como veio, sem comprimir de novo a cada atualização.
    if (im.format == 'JPEG' and im.mode == 'RGB' and max(im.size) <= MAX_FOTO_PX
            and im.getexif().get(0x0112, 1) == 1):
        with open(caminho, 'wb') as f:
            f.write(dado)
        return Imagem(caminho, im.size, _parece_grafico(im))
    im = ImageOps.exif_transpose(im)
    rgba = im.convert('RGBA')
    transparente = rgba.getchannel('A').getextrema()[0] < 250
    if transparente:
        # PNG transparente: composto sobre fundo claro antes de ir para o slide escuro.
        fundo = Image.new('RGBA', rgba.size, CLARO_RGB + (255,))
        fundo.alpha_composite(rgba)
        im = fundo.convert('RGB')
    else:
        im = im.convert('RGB')
    im.thumbnail((MAX_FOTO_PX, MAX_FOTO_PX), Image.LANCZOS)
    grafico = transparente or _parece_grafico(im)
    im.save(caminho, 'JPEG', quality=85, optimize=True)
    return Imagem(caminho, im.size, grafico)


def por_imagem(s, img: Imagem, x, y, w, h, inteira=None, foco=(0.5, 0.5)):
    """Foto comum: recorte central na proporção do quadro (preenche, sem distorcer).
    Imagem com texto embutido: inteira, centralizada sobre painel claro.
    O recorte é feito pela moldura da própria imagem (recorte do PowerPoint), então o
    arquivo guarda a foto inteira e o modo atualizar consegue recuperar a original."""
    inteira = img.grafico if inteira is None else inteira
    if inteira:
        cartao(s, x, y, w, h, PAINEL_CLARO, 0.03)
        pad = min(0.12, w * 0.04, h * 0.04)
        iw, ih = img.tam
        esc = min((w - 2 * pad) / iw, (h - 2 * pad) / ih)
        pw, ph = iw * esc, ih * esc
        _nomear(s.shapes.add_picture(img.caminho, Inches(x + (w - pw) / 2), Inches(y + (h - ph) / 2), Inches(pw), Inches(ph)), img.rotulo)
        return
    iw, ih = img.tam
    ar = w / h
    esq = dir_ = cima = baixo = 0.0
    if iw / ih > ar:
        nw = int(ih * ar)
        x0 = int((iw - nw) * foco[0])
        esq, dir_ = x0 / iw, (iw - x0 - nw) / iw
    else:
        nh = int(iw / ar)
        y0 = int((ih - nh) * foco[1])
        cima, baixo = y0 / ih, (ih - y0 - nh) / ih
    pic = s.shapes.add_picture(img.caminho, Inches(x), Inches(y), Inches(w), Inches(h))
    pic.crop_left, pic.crop_right, pic.crop_top, pic.crop_bottom = esq, dir_, cima, baixo
    _nomear(pic, img.rotulo)


class Logo:
    """Logo do cliente: fundo liso removido por distância de cor (chroma key), recortada
    no conteúdo e composta sobre a cor do lugar onde entra. Logo escura demais para o
    grafite ganha uma placa clara atrás, para não sumir."""

    def __init__(self, dado: bytes, pasta: str):
        im = Image.open(io.BytesIO(dado))
        im.load()
        im = ImageOps.exif_transpose(im).convert('RGBA')
        im.thumbnail((1400, 1400), Image.LANCZOS)
        a = np.asarray(im).astype(np.float32)
        if (a[..., 3] < 250).mean() < 0.02:
            # Sem transparência: se a borda for lisa, a cor dela é o fundo e sai.
            borda = np.concatenate([a[0, :, :3], a[-1, :, :3], a[:, 0, :3], a[:, -1, :3]])
            fundo = np.median(borda, axis=0)
            if (np.sqrt(((borda - fundo) ** 2).sum(axis=1)) < 40).mean() > 0.85:
                dist = np.sqrt(((a[..., :3] - fundo) ** 2).sum(axis=2))
                a[..., 3] = np.clip((dist - 28) / (70 - 28), 0, 1) * 255
                im = Image.fromarray(a.astype(np.uint8), 'RGBA')
        bb = im.getchannel('A').point(lambda v: 255 if v > 10 else 0).getbbox()
        if bb:
            folga = int(max(im.size) * 0.02)
            im = im.crop((max(0, bb[0] - folga), max(0, bb[1] - folga),
                          min(im.width, bb[2] + folga), min(im.height, bb[3] + folga)))
        self.im = im
        px = np.asarray(im).astype(np.float32)
        vis = px[..., 3] > 128
        lum = (0.2126 * px[..., 0] + 0.7152 * px[..., 1] + 0.0722 * px[..., 2])[vis]
        # Contraste com o grafite: logo quase toda escura precisa de placa clara.
        self.placa = bool(lum.size) and float(np.percentile(lum, 75)) < 105
        self.pasta = pasta
        self._cache = {}

    @property
    def proporcao(self):
        return self.im.width / max(1, self.im.height)

    def png(self, cor) -> str:
        chave = str(cor)
        if chave not in self._cache:
            base = CLARO_RGB if self.placa else (cor[0], cor[1], cor[2])
            fundo = Image.new('RGBA', self.im.size, base + (255,))
            fundo.alpha_composite(self.im)
            caminho = os.path.join(self.pasta, f'logo_cliente_{len(self._cache)}.png')
            fundo.convert('RGB').save(caminho, optimize=True)
            self._cache[chave] = caminho
        return self._cache[chave]

    def desenhar(self, s, x, y, maxw, maxh, cor_fundo=G.BG, alinhar='esq'):
        """Desenha no maior tamanho que cabe em maxw x maxh. Devolve (x, y, w, h)."""
        pad = min(maxh, maxw) * 0.12 if self.placa else 0.0
        w = min(maxw - 2 * pad, (maxh - 2 * pad) * self.proporcao)
        h = w / self.proporcao
        tw, th = w + 2 * pad, h + 2 * pad
        if alinhar == 'centro':
            x = x + (maxw - tw) / 2
        elif alinhar == 'dir':
            x = x + maxw - tw
        y = y + (maxh - th) / 2
        if self.placa:
            cartao(s, x, y, tw, th, PAINEL_CLARO, 0.1)
        _nomear(s.shapes.add_picture(self.png(cor_fundo), Inches(x + pad), Inches(y + pad), Inches(w), Inches(h)), 'logo_cliente')
        return x, y, tw, th


# ───────────────────────── contexto da montagem ─────────────────────────

class Ctx:
    def __init__(self, fotos, documentos, pasta, logo=None, paginas=None, graficos=None):
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = Inches(SW), Inches(SH)
        self.layout = self.prs.slide_layouts[6]
        self.fotos = fotos or {}
        self.documentos = documentos or {}
        # Modo atualizar: páginas de documento já desenhadas, tiradas da apresentação anterior
        # ({id: {"total": n, "paginas": {p: bytes}}}), e o jeito como cada foto foi mostrada
        # (inteira ou recortada), para os slides antigos saírem iguais.
        self.paginas_prontas = paginas or {}
        self.graficos = graficos or {}
        self.pasta = pasta
        self.logo: Logo | None = logo
        self.avisos: list[str] = []
        self.rodape = 'Grupo Service'
        self.capa: dict = {}
        self.total_itens = 0
        self.etiquetas: dict = {}
        self.titulos_pauta: dict = {}
        self._fotos_ok: dict = {}
        self._docs_ok: dict = {}
        self._avisados: set = set()
        self.slide_atual = 0     # posição no roteiro, para os avisos

    def aviso(self, msg: str):
        txt = f'Slide {self.slide_atual} do roteiro: {msg}' if self.slide_atual else msg
        if txt not in self._avisados:
            self._avisados.add(txt)
            self.avisos.append(txt)

    def novo(self, rodape=True):
        s = self.prs.slides.add_slide(self.layout)
        bg = s.background.fill
        bg.solid()
        bg.fore_color.rgb = G.BG
        if rodape:
            self._rodape(s, len(self.prs.slides))
        return s

    def _rodape(self, s, n):
        """Logo do cliente discreta à esquerda, texto, logo do Grupo Service e número à direita."""
        x = 0.5
        if self.logo:
            _, _, lw, _ = self.logo.desenhar(s, 0.5, 7.0, 1.5, 0.38)
            x = 0.5 + lw + 0.22
        size = 12
        while size > 10 and larg(self.rodape, size) > (10.7 - x) * 0.95:
            size -= 1
        G.text(s, x, 7.1, 10.7 - x, 0.3, self.rodape, size, G.TXT3)
        s.shapes.add_picture(G.LOGO_GS, Inches(11.05), Inches(7.04), height=Inches(0.32))
        G.text(s, 12.35, 7.1, 0.48, 0.3, str(n), 12, G.TXT3, align=PP_ALIGN.RIGHT)

    def remover_desde(self, n):
        lst = self.prs.slides._sldIdLst
        for sid in list(lst)[n:]:
            self.prs.part.drop_rel(sid.rId)
            lst.remove(sid)

    # ── fotos ──
    def foto(self, fid) -> Imagem | None:
        fid = _limpa(fid)
        if fid in self._fotos_ok:
            return self._fotos_ok[fid]
        dado = self.fotos.get(fid)
        r = None
        if not dado:
            self.aviso(f'a foto "{fid}" não foi enviada; ficou de fora.')
        else:
            try:
                nome = 'foto_%03d_%s' % (len(self._fotos_ok), re.sub(r'[^A-Za-z0-9_]', '_', fid)[:40])
                r = _carregar(dado, self.pasta, nome)
                r.rotulo = f'foto:{fid}'
                if isinstance(self.graficos.get(fid), bool):
                    r.grafico = self.graficos[fid]
            except Exception:
                self.aviso(f'a foto "{fid}" não é uma imagem válida; ficou de fora.')
        self._fotos_ok[fid] = r
        return r

    # ── documentos ──
    def doc_paginas(self, did):
        did = _limpa(did)
        if did in self._docs_ok:
            return self._docs_ok[did]
        dado = self.documentos.get(did)
        pronta = self.paginas_prontas.get(did)
        if not dado and pronta and pronta.get('paginas'):
            total = _inteiro(pronta.get('total')) or max(pronta['paginas'])
            self._docs_ok[did] = (None, max(total, max(pronta['paginas'])), {})
            return self._docs_ok[did]
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

    def doc_pagina(self, did, pag) -> Imagem | None:
        info = self.doc_paginas(did)
        if not info:
            return None
        caminho, n, cache = info
        if pag in cache:
            return cache[pag]
        if caminho is None:
            cache[pag] = self._pagina_pronta(did, pag)
            return cache[pag]
        base = caminho[:-4] + f'_p{pag}'
        r = None
        try:
            proc = subprocess.run(['pdftoppm', '-r', str(DPI_DOC), '-f', str(pag), '-l', str(pag), '-png',
                                   '-singlefile', caminho, base], capture_output=True, timeout=90)
            if proc.returncode == 0 and os.path.exists(base + '.png'):
                im = _recortar_margem(Image.open(base + '.png').convert('RGB'))
                if im.width >= 40 and im.height >= 40:
                    im.thumbnail((MAX_FOTO_PX, MAX_FOTO_PX), Image.LANCZOS)
                    destino = base + '.jpg'
                    im.save(destino, 'JPEG', quality=88, optimize=True)
                    r = Imagem(destino, im.size, True, f'doc:{_limpa(did)}:p{pag}')
        except Exception:
            r = None
        if r is None:
            self.aviso(f'a página {pag} do documento "{_limpa(did)}" não pôde ser convertida; ficou de fora.')
        cache[pag] = r
        return r

    def _pagina_pronta(self, did, pag) -> Imagem | None:
        """Página já desenhada numa apresentação anterior (sem o PDF): entra como veio."""
        did = _limpa(did)
        dado = (self.paginas_prontas.get(did) or {}).get('paginas', {}).get(pag)
        if not dado:
            self.aviso(f'a página {pag} do documento "{did}" não está na apresentação anterior; ficou de fora.')
            return None
        try:
            im = Image.open(io.BytesIO(dado))
            im.load()
            destino = os.path.join(self.pasta, 'pronta_%s_p%d.jpg' % (re.sub(r'[^A-Za-z0-9_]', '_', did)[:40], pag))
            if im.format == 'JPEG' and im.mode == 'RGB' and max(im.size) <= MAX_FOTO_PX:
                with open(destino, 'wb') as f:
                    f.write(dado)
            else:
                im = im.convert('RGB')
                im.thumbnail((MAX_FOTO_PX, MAX_FOTO_PX), Image.LANCZOS)
                im.save(destino, 'JPEG', quality=88, optimize=True)
            return Imagem(destino, im.size, True, f'doc:{did}:p{pag}')
        except Exception:
            self.aviso(f'a página {pag} do documento "{did}" não pôde ser lida; ficou de fora.')
            return None


# ───────────────────────── cabeçalho e faixas ─────────────────────────

def _numero_item(sl):
    n = sl.get('numero') if isinstance(sl, dict) else None
    if isinstance(n, bool) or n is None or n == '':
        return None
    if isinstance(n, float) and n.is_integer():
        n = int(n)
    return _limpa(n) or None


def _kicker(ctx, sl, extra=None) -> str:
    num = _numero_item(sl)
    partes = []
    if num:
        curto = ctx.titulos_pauta.get(num, '')
        partes.append(f'ITEM {num}' + (f'  •  {curto.upper()}' if curto and len(curto) <= 38 else ' DA PAUTA'))
    if extra:
        partes.append(extra)
    return '  •  '.join(partes)


def cabecalho(ctx, s, sl, titulo, sub=None, cont=False, w=W, kicker=None) -> float:
    """Kicker (item da pauta), título com a última palavra em azul e traço azul.
    Título longo reduz até 24pt numa linha; se não couber, quebra em até 2 linhas.
    Devolve a altura onde o conteúdo começa (encadeada na altura medida)."""
    k = kicker if kicker is not None else _kicker(ctx, sl)
    if k:
        G.text(s, X0, 0.3, w, 0.35, k, ajusta(k, w, 14, True, 11), G.GS_AZUL_CLA, True)
    titulo = _nb(_limpa(titulo) or 'Sem título')
    suf = ' (continuação)' if cont else ''
    full = titulo + suf
    size = 34
    while size > 24 and not cabe_linha(full, size, w):
        size -= 1
    if cabe_linha(full, size, w):
        nl = 1
    else:
        size = 28
        while size > 18 and linhas(full, size, w, True) > 2:
            size -= 1
        nl = min(2, linhas(full, size, w, True))
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
        ts = 17 if linhas(sub, 17, w) <= 2 else 15
        hs = min(alt(sub, ts, w), 2 * lh(ts))
        caixa(s, X0, y_traco + 0.1, w, hs, sub, ts, G.TXT2)
        return y_traco + 0.1 + hs + 0.3
    return y_traco + 0.4


def _tam_faixa(texto, tw):
    return _maior_que_cabe([17, 16, 15, 14], lambda t: linhas(texto, t, tw) <= 2) or 14


def _faixa_obs(s, y, texto, cor=G.AMBER, rotulo='OBSERVAÇÃO', x=X0, w=W):
    """Faixa de observação no pé do conteúdo. Devolve a altura usada."""
    texto = _nb(texto)
    lr = larg(rotulo + '   ', 14, True) / 0.92
    tw = w - 0.5 - lr
    size = _tam_faixa(texto, tw)
    h = max(0.6, alt(texto, size, tw) + 0.28)
    cartao(s, x, y, w, h, G.CARD2)
    G.rect(s, x, y, 0.1, h, cor)
    G.text(s, x + 0.28, y, lr, h, rotulo, 14, cor, True, anchor=MSO_ANCHOR.MIDDLE)
    caixa(s, x + 0.28 + lr, y, tw, h, texto, size, G.TXT2, anchor=MSO_ANCHOR.MIDDLE)
    return h


def _alt_obs(texto, w=W, rotulo='OBSERVAÇÃO'):
    if not texto:
        return 0.0
    texto = _nb(texto)
    tw = w - 0.5 - larg(rotulo + '   ', 14, True) / 0.92
    return max(0.6, alt(texto, _tam_faixa(texto, tw), tw) + 0.28)


# ───────────────────────── capa, orientações, pauta, divisor, encerramento ─────────────────────────

def s_capa(ctx, sl):
    s = ctx.novo(rodape=False)
    sigla = _limpa(sl.get('sigla')).upper()
    nome = _limpa(sl.get('assembleia'))
    if not nome and sigla in SIGLAS:
        nome = SIGLAS[sigla]
    if not sigla and nome:
        sigla = ''.join(p[0] for p in nome.split() if p[:1].isupper())[:5]
    cond = _nb(_limpa(sl.get('condominio'))) or '[conferir]'
    data = _limpa(sl.get('data'))
    if not _limpa(sl.get('condominio')):
        ctx.aviso('a capa veio sem o nome do condomínio.')
    if not data:
        ctx.aviso('a capa veio sem a data da assembleia.')
    chamadas = _lista(sl.get('chamadas'))
    hora, local = _limpa(sl.get('hora')), _limpa(sl.get('local'))
    wl = 7.4
    detalhes = list(chamadas)
    if hora and not chamadas:
        junto = f'{hora}    •    {local}' if local else hora
        if local and not cabe_linha(junto, 17, wl, False):
            detalhes += [hora, local]
        else:
            detalhes.append(junto)
    elif local:
        detalhes.append(local)

    G.rect(s, 0, 0, SW, 0.083, G.GS_AZUL)
    s.shapes.add_picture(G.LOGO_GS, Inches(0.94), Inches(0.72), height=Inches(0.85))
    kick = (nome or 'Apresentação em assembleia').upper()
    tk = ajusta(kick, wl, 18, True, 13)
    pal = cond.split(' ')
    if len(pal) >= 3:
        t1, t2 = pal[0] + ' ', ' '.join(pal[1:])
    elif len(pal) == 2:
        t1, t2 = pal[0] + ' ', pal[1]
    else:
        t1, t2 = '', cond

    def altura(tn):
        h = lh(tk, True) + 0.15 + alt(cond, tn, wl, True) + 0.25 + 0.3
        if data:
            h += lh(28, True) + 0.1
        return h + sum(alt(d, 17, wl) + 0.04 for d in detalhes)
    disp = 6.25 - 2.0
    tn = _maior_que_cabe(range(52, 25, -2), lambda t: linhas(cond, t, wl, True) <= 2 and altura(t) <= disp) or 24
    # Bloco da esquerda encadeado de cima para baixo, centrado entre o logo e a linha da marca.
    y = 2.0 + max(0, (disp - altura(tn)) / 2)
    G.text(s, 0.94, y, wl, lh(tk, True), kick, tk, G.GS_AZUL_CLA, True)
    y += lh(tk, True) + 0.15
    hn = alt(cond, tn, wl, True)
    caixa(s, 0.94, y, wl, hn, [[(t1, tn, True, G.TXT), (t2, tn, True, G.GS_AZUL_CLA)]], tn, bold=True)
    y += hn + 0.25
    G.hline(s, 0.94, y, 1.9, G.GS_AZUL, 4)
    y += 0.3
    if data:
        G.text(s, 0.94, y, wl, lh(28, True), data, ajusta(data, wl, 28, True, 20), G.TXT, True)
        y += lh(28, True) + 0.1
    for d in detalhes:
        hd = alt(d, 17, wl)
        caixa(s, 0.94, y, wl, hd, d, 17, G.TXT2)
        y += hd + 0.04
    G.rect(s, 0.94, 6.45, 11.45, 0.012, G.LINE)
    G.text(s, 0.94, 6.62, 11.45, 0.4, MARCA, 15, G.TXT3)

    # Cartão da direita: logo do cliente em destaque (quando houver) e a sigla grande.
    x, w = 8.75, 3.64
    sg = sigla or 'AG'
    if ctx.logo:
        yc, hc = 0.72, 5.45
        cartao(s, x, yc, w, hc)
        ctx.logo.desenhar(s, x + 0.35, yc + 0.35, w - 0.7, 2.35, G.CARD, 'centro')
        G.rect(s, x + 0.35, yc + 3.0, w - 0.7, 0.012, G.LINE)
        G.text(s, x + 0.35, yc + 3.25, w - 0.6, 0.3, 'ASSEMBLEIA', 14, G.TXT3, True)
        tsg = ajusta(sg, w - 0.7, 72, True, 36)
        G.text(s, x + 0.35, yc + 3.6, w - 0.6, lh(tsg, True), sg, tsg, G.AMBER, True)
    else:
        yc, hc = 2.0, 2.6
        cartao(s, x, yc, w, hc)
        G.rect(s, x, yc, 0.12, hc, G.GS_AZUL)
        G.text(s, x + 0.4, yc + 0.32, w - 0.6, 0.3, 'ASSEMBLEIA', 14, G.TXT3, True)
        tsg = ajusta(sg, w - 0.7, 80, True, 36)
        G.text(s, x + 0.4, yc + 0.72, w - 0.6, lh(tsg, True), sg, tsg, G.AMBER, True)


def s_orientacoes(ctx, sl):
    blocos = []
    for b in (sl.get('blocos') or []) if isinstance(sl.get('blocos'), list) else []:
        if isinstance(b, dict):
            t = _limpa(b.get('titulo')).upper()
            tops = [_nb(x) for x in _lista(b.get('topicos') or b.get('texto'))]
            if t or tops:
                blocos.append((t, tops))
    if not blocos:
        ctx.aviso('orientações sem blocos; slide ignorado.')
        return
    grupos = [blocos[i:i + 4] for i in range(0, len(blocos), 4)]
    for gi, grupo in enumerate(grupos):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Como funciona esta assembleia',
                      sl.get('subtitulo') if gi == 0 else None, cont=gi > 0,
                      kicker='ABERTURA  •  ORIENTAÇÕES DO EDITAL')
        filas = [len(grupo)] if len(grupo) <= 3 else [2, len(grupo) - 2]
        nl = len(filas)
        hc = (BASE - y - 0.22 * (nl - 1)) / nl
        k = 0
        for fi, nf in enumerate(filas):
            cw = (W - 0.25 * (nf - 1)) / nf
            tw = cw - 0.95
            cards = grupo[k:k + nf]

            def h_card(t):
                return max(0.78 + sum(alt(x, t, tw) + 0.16 for x in tp) + 0.15 for _, tp in cards)
            ts = _maior_que_cabe(range(19, MIN_PT - 1, -1), lambda t: h_card(t) <= hc) or MIN_PT
            for j, (t, tops) in enumerate(cards):
                cor = CICLO[(k + j) % len(CICLO)]
                x = X0 + j * (cw + 0.25)
                yy = y + fi * (hc + 0.22)
                cartao(s, x, yy, cw, hc)
                G.rect(s, x, yy, 0.12, hc, cor)
                G.text(s, x + 0.4, yy + 0.25, cw - 0.6, 0.35, t, ajusta(t, cw - 0.6, 15, True, 12), cor, True)
                ty = yy + 0.78
                for it in tops:
                    ht = alt(it, ts, tw)
                    if ty + ht > yy + hc - 0.05:
                        ctx.aviso('orientações com texto demais; parte dos tópicos ficou de fora.')
                        break
                    marcador(s, x + 0.4, ty, ts, cor)
                    caixa(s, x + 0.7, ty, tw, ht, it, ts, G.TXT)
                    ty += ht + 0.16
            k += nf


def _itens_pauta(sl):
    itens = []
    for it in (sl.get('itens') or []) if isinstance(sl.get('itens'), list) else []:
        if isinstance(it, dict):
            t = _nb(_limpa(it.get('titulo') or it.get('texto')))
            if t:
                itens.append((t, _limpa(it.get('etiqueta')).upper(), _nb(_limpa(it.get('subtitulo')))))
        else:
            t = _nb(_limpa(it))
            if t:
                itens.append((t, '', ''))
    return itens


def s_pauta(ctx, sl):
    itens = _itens_pauta(sl)
    if not itens:
        ctx.aviso('pauta sem itens; slide ignorado.')
        return
    if len(itens) >= 4 and all(len(t) <= 70 for t, _, _ in itens):
        _pauta_grade(ctx, sl, itens)
    else:
        _pauta_lista(ctx, sl, itens)


def _pauta_grade(ctx, sl, itens):
    """Grade de cartões: número grande na cor da etiqueta, título, subtítulo e chip."""
    pags = [itens[i:i + 9] for i in range(0, len(itens), 9)]
    base_num = 0
    for pi, grupo in enumerate(pags):
        s = ctx.novo()
        sub = f'{len(itens)} itens, apresentados na ordem do edital' if pi == 0 else None
        y = cabecalho(ctx, s, None, 'Pauta da assembleia', sub, cont=pi > 0, kicker='ORDEM DO DIA')
        n = len(grupo)
        ncol = 2 if n <= 4 else 3
        nlin = math.ceil(n / ncol)
        cw = (W - 0.2 * (ncol - 1)) / ncol
        hc = min(1.75, (BASE - y - 0.18 * (nlin - 1)) / nlin)
        tw = cw - 1.45

        def h_txt(t, tt, e, sb):
            return alt(tt, t, tw, True) + (0.06 + alt(sb, 15, tw) if sb else 0) + (0.4 if e else 0)
        ts = _maior_que_cabe(range(20, MIN_PT - 1, -1),
                             lambda t: all(h_txt(t, tt, e, sb) + 0.3 <= hc for tt, e, sb in grupo)) or MIN_PT
        for i, (tt, e, sb) in enumerate(grupo):
            x = X0 + (i % ncol) * (cw + 0.2)
            yy = y + (i // ncol) * (hc + 0.18)
            cor = ETIQUETAS.get(e, G.GS_AZUL_CLA)
            cartao(s, x, yy, cw, hc)
            G.text(s, x + 0.25, yy, 1.05, hc, f'{base_num + i + 1:02d}', 36, cor, True, anchor=MSO_ANCHOR.MIDDLE)
            ty = yy + (hc - h_txt(ts, tt, e, sb)) / 2
            ty = tit_desc(s, x + 1.25, ty, tw, tt, ts, sb, 15, gap=0.06)
            if e:
                chip(s, x + 1.25, ty + 0.12, e, cor, 11, 0.28)
        base_num += len(grupo)


def _pauta_lista(ctx, sl, itens):
    """Lista numerada para itens longos (redação do edital), com a etiqueta à direita."""
    wchip = max([largura_chip(e, 11) for _, e, _ in itens if e] or [0])
    tw = W - 1.35 - (wchip + 0.35 if wchip else 0)
    topo = 1.75
    disp = BASE - topo

    def alturas(t):
        return [max(0.8, alt(i, t, tw) + (0.06 + alt(sb, 15, tw) if sb else 0) + 0.36) for i, _, sb in itens]
    size = _maior_que_cabe(range(22, 15, -1), lambda t: sum(alturas(t)) + 0.16 * (len(itens) - 1) <= disp) or 17
    hs = alturas(size)
    pags = _agrupar(hs, disp, 0.16)
    for pi, idxs in enumerate(pags):
        s = ctx.novo()
        cabecalho(ctx, s, None, 'Pauta da assembleia', cont=pi > 0, kicker='ORDEM DO DIA')
        tot = sum(hs[i] for i in idxs) + 0.16 * (len(idxs) - 1)
        y = topo + ((disp - tot) * 0.3 if (len(pags) == 1 and tot < disp * 0.7) else 0)
        for i in idxs:
            h = hs[i]
            t, e, sb = itens[i]
            cor = ETIQUETAS.get(e, G.GS_AZUL)
            cartao(s, X0, y, W, h)
            d = 0.62
            yq = y + (h - d) / 2 if h < 1.4 else y + 0.18
            G.rect(s, X0 + 0.2, yq, d, d, cor, True, 0.18)
            G.text(s, X0 + 0.2, yq, d, d, str(i + 1), 22, G.TXT if cor in (G.GS_AZUL, G.TXT3) else G.DARKTXT, True,
                   PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
            partes = [[(t, size, False, G.TXT)]] + ([[(sb, 15, False, G.TXT3)]] if sb else [])
            caixa(s, X0 + 1.1, y, tw, h, partes, size, anchor=MSO_ANCHOR.MIDDLE, espaco=0.06)
            if e:
                chip(s, X0 + W - 0.25 - largura_chip(e, 11), y + (h - 0.28) / 2, e, cor, 11, 0.28)
            y += h + 0.16


def s_item(ctx, sl):
    num = _numero_item(sl)
    titulo = _nb(_limpa(sl.get('titulo')))
    if not titulo:
        ctx.aviso('divisor de item sem título; usei só o número.')
        titulo = f'Item {num}' if num else 'Item da pauta'
    sub = _nb(_limpa(sl.get('subtitulo')))
    etiq = _limpa(sl.get('etiqueta')).upper() or (ctx.etiquetas.get(num, '') if num else '')
    apres = _nb(_limpa(sl.get('apresentador')))
    s = ctx.novo()
    G.rect(s, 0, 0, SW, 0.083, G.GS_AZUL)
    eh_n = bool(num and num.isdigit())
    numtxt = f'{int(num):02d}' if eh_n else (num or '')
    if numtxt:
        tg = ajusta(numtxt, 6.3, 330, True, 120)
        tb = G.text(s, 6.6, 0.45, 6.6, 5.7, numtxt, tg, NUM_BG, True, PP_ALIGN.RIGHT)
        tb.name = 'decor_numero_gigante'
    M = ctx.total_itens
    kick = f'PAUTA  •  ITEM {num} DE {M}' if (eh_n and M >= int(num)) else (f'PAUTA  •  ITEM {num}' if num else 'PAUTA')
    tw = 8.8
    hs_ = alt(sub, 20, 7.8) if sub else 0
    ha = lh(16) if apres else 0
    disp_t = 5.95 - 1.2 - 0.5 - 0.55 - (hs_ + 0.1 if sub else 0) - (ha + 0.15 if apres else 0)
    tam = _maior_que_cabe(range(46, 23, -2), lambda t: linhas(titulo, t, tw, True) <= 4 and alt(titulo, t, tw, True) <= disp_t)
    if tam is None:
        tam = _maior_que_cabe(range(23, MIN_PT - 1, -1), lambda t: alt(titulo, t, tw, True) <= disp_t) or MIN_PT
    ht = alt(titulo, tam, tw, True)
    bloco = 0.5 + ht + 0.5 + (hs_ + 0.1 if sub else 0) + (ha + 0.15 if apres else 0)
    y = max(1.1, 3.55 - bloco / 2)
    G.text(s, 0.8, y, 8, 0.4, kick, 16, G.GS_AZUL_CLA, True)
    y += 0.5
    caixa(s, 0.8, y, tw, ht, titulo, tam, G.TXT, True)
    y += ht + 0.2
    G.hline(s, 0.8, y, 1.75, G.GS_AZUL, 4)
    y += 0.3
    if sub:
        caixa(s, 0.8, y, 7.8, hs_, sub, 20, G.TXT2)
        y += hs_ + 0.1
    if apres:
        G.text(s, 0.8, y + 0.05, 7.8, ha, f'Apresentação: {apres}', 16, G.TXT3)
    # Barra de progresso da pauta: feito em azul claro, atual em azul, por vir em cinza.
    if eh_n and M >= int(num) and M > 1:
        n = int(num)
        seg = min(0.5, (8.0 - 0.12 * (M - 1)) / M)
        for i in range(M):
            cor = G.GS_AZUL if i + 1 == n else (G.GS_AZUL_CLA if i + 1 < n else G.LINE)
            G.rect(s, 0.8 + i * (seg + 0.12), 6.25, seg, 0.09, cor, True, 0.5)
    if etiq:
        G.text(s, 0.8, 6.45, 6, 0.3, etiq, 13, ETIQUETAS.get(etiq, G.TXT3), True)


def s_encerramento(ctx, sl):
    msg = _nb(_limpa(sl.get('mensagem'))) or MSG_ENCERRAMENTO
    s = ctx.novo()
    G.rect(s, 0, 0, SW, 0.083, G.GS_AZUL)
    frases = re.split(r'(?<=[.!?])\s+', msg)
    t1, t2 = ' '.join(frases[:-1]), frases[-1]
    nome = _limpa(ctx.capa.get('assembleia')) or SIGLAS.get(_limpa(ctx.capa.get('sigla')).upper(), '')
    linha_sub = '    •    '.join(t for t in (nome, _limpa(ctx.capa.get('data'))) if t)
    if ctx.logo:
        # Logo do cliente forte no alto, mensagem centralizada embaixo.
        ctx.logo.desenhar(s, 3.5, 0.65, 6.33, 2.3, G.BG, 'centro')
        tw = 11.0
        tam = _maior_que_cabe(range(36, 19, -2), lambda t: alt(msg, t, tw, True) <= 2.3) or 20
        hm = alt(msg, tam, tw, True)
        y = 3.3
        partes = ([(t1 + ' ', tam, True, G.TXT)] if t1 else []) + [(t2, tam, True, G.GS_AZUL_CLA)]
        caixa(s, (SW - tw) / 2, y, tw, hm, [partes], tam, bold=True, align=PP_ALIGN.CENTER)
        y += hm + 0.3
        G.hline(s, SW / 2 - 0.48, y, SW / 2 + 0.48, G.GS_AZUL, 4)
        if linha_sub:
            G.text(s, 0.5, y + 0.25, W, 0.45, linha_sub, ajusta(linha_sub, W, 18, False, 14), G.TXT2, align=PP_ALIGN.CENTER)
        return
    s.shapes.add_picture(G.LOGO_GS, Inches(0.94), Inches(0.72), height=Inches(0.85))
    G.text(s, 0.94, 2.1, 9, 0.45, 'ENCERRAMENTO', 18, G.GS_AZUL_CLA, True)
    tw = 11.45
    tam = _maior_que_cabe(range(40, 19, -2), lambda t: alt(msg, t, tw, True) <= 2.9)
    if tam is None:
        tam = _maior_que_cabe(range(19, MIN_PT - 1, -1), lambda t: alt(msg, t, tw, True) <= 3.3) or MIN_PT
    hm = alt(msg, tam, tw, True)
    partes = ([(t1 + ' ', tam, True, G.TXT)] if t1 else []) + [(t2, tam, True, G.GS_AZUL_CLA)]
    caixa(s, 0.94, 2.65, tw, hm, [partes], tam, bold=True)
    y = 2.65 + hm + 0.3
    G.hline(s, 0.94, y, 1.9, G.GS_AZUL, 4)
    if linha_sub and y + 0.75 < 6.3:
        G.text(s, 0.94, y + 0.25, tw, 0.45, linha_sub, 18, G.TXT2)
    G.rect(s, 0.94, 6.45, 11.45, 0.012, G.LINE)
    G.text(s, 0.94, 6.55, 11.45, 0.4, MARCA, 15, G.TXT3)


# ───────────────────────── texto, tópicos, colunas ─────────────────────────

def s_texto(ctx, sl):
    paras = [_nb(p) for p in _lista(sl.get('paragrafos') or sl.get('texto'))]
    destaque = _nb(_limpa(sl.get('destaque')))
    if not paras and not destaque:
        ctx.aviso('slide de texto sem parágrafos; slide ignorado.')
        return
    sub = sl.get('subtitulo')
    tx, tw = X0 + 0.4, W - 0.6
    topo = 2.05 if sub else 1.75
    disp = BASE - topo
    esp = 0.22

    def h_dest(t):
        return (alt(destaque, t + 2, tw - 0.9, True) + 0.5) if destaque else 0.0

    size = _maior_que_cabe(range(26, MIN_PT - 1, -1),
                           lambda t: alt_paras(paras, t, tw, False, esp) + (h_dest(t) + 0.35 if destaque else 0) <= disp)
    if size is not None:
        pags = [paras]
    else:
        size = 18
        pedacos = []
        for p in paras:
            pedacos += _dividir_texto(p, size, tw, disp - 0.3)
        hs = [alt(p, size, tw) for p in pedacos]
        pags = [[pedacos[i] for i in g] for g in _agrupar(hs, disp, esp)]
        if destaque and alt_paras(pags[-1], size, tw, False, esp) + h_dest(size) + 0.35 > disp:
            pags.append([])
    for pi, pg in enumerate(pags):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo'), sub if pi == 0 else None, cont=pi > 0)
        tot = (alt_paras(pg, size, tw, False, esp) + 0.35 if pg else 0) + (h_dest(size) if destaque and pi == len(pags) - 1 else 0)
        if tot < (BASE - y) * 0.6:
            y += (BASE - y - tot) * 0.3
        if pg:
            hp = alt_paras(pg, size, tw, False, esp)
            G.rect(s, X0, y + 0.06, 0.06, max(0.1, hp - 0.12), G.GS_AZUL)
            caixa(s, tx, y, tw, hp, pg, size, G.TXT, espaco=esp)
            y += hp + 0.35
        if destaque and pi == len(pags) - 1:
            hd = h_dest(size)
            cartao(s, X0, y, W, hd, G.CARD2)
            G.rect(s, X0, y, 0.12, hd, G.AMBER)
            caixa(s, X0 + 0.45, y, tw - 0.9, hd, destaque, size + 2, G.AMBER, True, anchor=MSO_ANCHOR.MIDDLE)


def _alt_card_topico(t, size, w):
    return max(0.82, alt(t, size, w - 0.85) + 0.42)


def _cartoes_topicos(s, topicos, x, y, w, size, cor=G.GS_AZUL_CLA, gap=0.16, extra=0.0):
    tw = w - 0.85
    for t in topicos:
        h = _alt_card_topico(t, size, w) + extra
        cartao(s, x, y, w, h)
        G.rect(s, x, y, 0.1, h, cor)
        ht = alt(t, size, tw)
        ty = y + (h - ht) / 2
        marcador(s, x + 0.35, ty, size, cor)
        caixa(s, x + 0.62, ty, tw, ht, t, size, G.TXT)
        y += h + gap
    return y


def _alt_topicos(topicos, w, size, gap=0.16):
    return sum(_alt_card_topico(t, size, w) for t in topicos) + gap * max(0, len(topicos) - 1)


def s_topicos(ctx, sl):
    tops = [_nb(t) for t in _lista(sl.get('topicos') or sl.get('itens'))]
    if not tops:
        ctx.aviso('slide de tópicos sem tópicos; slide ignorado.')
        return
    sub = sl.get('subtitulo')
    topo = 2.05 if sub else 1.75
    disp = BASE - topo
    size = _maior_que_cabe(range(26, MIN_PT - 1, -1), lambda t: _alt_topicos(tops, W, t) <= disp)
    if size is not None and len(tops) <= 7:
        pags = [list(range(len(tops)))]
    else:
        size = size or 18
        pags = _agrupar([_alt_card_topico(t, size, W) for t in tops], disp, 0.16, 7)
    for pi, idxs in enumerate(pags):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo'), sub if pi == 0 else None, cont=pi > 0)
        pg = [tops[i] for i in idxs]
        # Poucos tópicos: cartões mais altos e mais espaçados, sem deixar meio slide vazio.
        sobra = (BASE - y) * 0.82 - _alt_topicos(pg, W, size)
        extra = max(0.0, min(0.45, sobra / len(pg)))
        _cartoes_topicos(s, pg, X0, y, W, size, gap=0.16 + extra * 0.4, extra=extra)


def s_colunas(ctx, sl):
    cols = []
    for c in (sl.get('colunas') or []) if isinstance(sl.get('colunas'), list) else []:
        if isinstance(c, dict):
            cols.append((_nb(_limpa(c.get('nome'))) or 'Opção', [_nb(t) for t in _lista(c.get('topicos'))]))
        elif _limpa(c):
            cols.append((_nb(_limpa(c)), []))
    if not cols:
        ctx.aviso('slide de colunas sem colunas; slide ignorado.')
        return
    if len(cols) > 3:
        ctx.aviso('mais de 3 colunas; o restante foi para outro slide.')
    grupos = [cols[i:i + 3] for i in range(0, len(cols), 3)]
    sub = sl.get('subtitulo')
    for gi, grupo in enumerate(grupos):
        n = len(grupo)
        cw = (W - GAP * (n - 1)) / n
        tw = cw - 0.9
        topo = 2.05 if sub else 1.75
        disp = BASE - topo

        def tnome(t):
            # Nome da coluna numa linha só quando couber reduzindo até o corpo dos tópicos.
            return _maior_que_cabe(range(t + 4, t - 1, -1), lambda z: all(linhas(nm, z, cw - 0.6, True) <= 1 for nm, _ in grupo)) or t + 4

        def hn_(t):
            return max(alt(nm, tnome(t), cw - 0.6, True) for nm, _ in grupo)

        def h_col(t, tops):
            return 0.3 + hn_(t) + 0.3 + sum(alt(x, t, tw) + 0.18 for x in tops) + 0.2

        size = _maior_que_cabe(range(22, MIN_PT - 1, -1), lambda t: max(h_col(t, tp) for _, tp in grupo) <= disp)
        paginas = [grupo]
        if size is None:
            size = 16
            paginas, restos = [], [(nm, list(tp)) for nm, tp in grupo]
            while any(tp for _, tp in restos):
                pagina = []
                for nm, tp in restos:
                    pega = []
                    while tp and h_col(size, pega + [tp[0]]) <= disp:
                        pega.append(tp.pop(0))
                    if not pega and tp:
                        pega.append(tp.pop(0))
                    pagina.append((nm, pega))
                paginas.append(pagina)
        for pi, pagina in enumerate(paginas):
            s = ctx.novo()
            y = cabecalho(ctx, s, sl, sl.get('titulo'), sub if (pi == 0 and gi == 0) else None, cont=(pi + gi) > 0)
            hmax = max(h_col(size, tp) for _, tp in pagina)
            hcard = min(BASE - y, max(hmax + 0.3, min(BASE - y, 3.2)))
            hn = hn_(size)
            for k, (nm, tp) in enumerate(pagina):
                x = X0 + k * (cw + GAP)
                cor = CICLO[(gi * 3 + k) % len(CICLO)]
                cartao(s, x, y, cw, hcard, corner=0.04)
                G.rect(s, x, y, cw, 0.1, cor)
                caixa(s, x + 0.3, y + 0.3, cw - 0.6, alt(nm, tnome(size), cw - 0.6, True), nm, tnome(size), cor, True)
                yy = y + 0.3 + hn + 0.3        # todas as colunas começam na mesma altura
                for t in tp:
                    ht = alt(t, size, tw)
                    marcador(s, x + 0.32, yy, size, cor)
                    caixa(s, x + 0.6, yy, tw, ht, t, size, G.TXT2)
                    yy += ht + 0.18


# ───────────────────────── orçamento e comparativo ─────────────────────────

def _painel_valores(ctx, s, rx, ry, rw, fim, total, comps, blocos, tam_total=34):
    """Coluna de valores do orçamento: total em destaque, mão de obra e materiais,
    depois pagamento, prazo e observação. Medido para nunca passar de fim."""
    if total is not None:
        cartao(s, rx, ry, rw, 1.5, G.AMBER, 0.08)
        G.text(s, rx + 0.3, ry + 0.18, rw - 0.5, 0.3, 'VALOR TOTAL', 14, G.DARKTXT, True)
        vt = _brl(total)
        tv = ajusta(vt, rw - 0.5, tam_total, True, 18)
        G.text(s, rx + 0.3, ry + 0.55, rw - 0.5, lh(tv, True), vt, tv, G.DARKTXT, True)
        ry += 1.5 + 0.16
    if comps:
        lado = rw >= 4.6 and len(comps) == 2
        cw = (rw - 0.16) / 2 if lado else rw
        for k, (rot, v) in enumerate(comps):
            x = rx + (k * (cw + 0.16) if lado else 0)
            y = ry if lado else ry + k * (1.05 + 0.16)
            cor = G.GS_AZUL_CLA if k == 0 else G.GREEN
            cartao(s, x, y, cw, 1.05, corner=0.08)
            G.rect(s, x, y, 0.1, 1.05, cor)
            G.text(s, x + 0.3, y + 0.14, cw - 0.45, 0.3, rot, 14, G.TXT3, True)
            vv = _brl(v)
            tv = ajusta(vv, cw - 0.45, 24, True, 16)
            G.text(s, x + 0.3, y + 0.46, cw - 0.45, lh(tv, True), vv, tv, cor, True)
        ry += (1.05 + 0.16) * (1 if lado else len(comps))
    tws = rw - 0.5
    blocos = list(blocos)

    def hb(t, bl):
        return [0.46 + alt(_nb(v), t, tws, r != 'OBSERVAÇÃO') + 0.18 for r, v in bl]
    tb = None
    while blocos:
        restante = fim - ry
        tb = _maior_que_cabe(range(18, MIN_PT - 1, -1), lambda t: sum(hb(t, blocos)) + 0.16 * (len(blocos) - 1) <= restante)
        if tb:
            break
        r, _ = blocos.pop()
        ctx.aviso(f'o campo {r.lower()} do orçamento não coube no slide; ficou de fora.')
    for (r, v), h in zip(blocos, hb(tb, blocos) if blocos else []):
        cartao(s, rx, ry, rw, h)
        G.rect(s, rx, ry, 0.1, h, G.GS_AZUL)
        G.text(s, rx + 0.3, ry + 0.14, rw - 0.5, 0.3, r, 13, G.TXT3, True)
        caixa(s, rx + 0.3, ry + 0.46, tws, h - 0.5, _nb(v), tb, G.TXT, r != 'OBSERVAÇÃO')
        ry += h + 0.16
    return ry


def _alt_painel(total, comps, blocos, rw, t=MIN_PT):
    h = (1.5 + 0.16 if total is not None else 0)
    if comps:
        h += (1.05 + 0.16) * (1 if (rw >= 4.6 and len(comps) == 2) else len(comps))
    return h + sum(0.46 + alt(_nb(v), t, rw - 0.5, r != 'OBSERVAÇÃO') + 0.18 + 0.16 for r, v in blocos)


def _larg_valor(itens, size):
    return min(2.6, max(1.6, max([larg(_brl(v), size + 1, True) / 0.92 for _, v in itens if v is not None] or [1.4]) + 0.1))


def _alturas_itens(itens, lw, size):
    dw = lw - _larg_valor(itens, size) - 0.6
    return [max(0.6, alt(d, size, dw) + 0.26) for d, _ in itens]


def _tabela_itens(s, itens, idxs, alturas, x, y, lw, size, cont_depois):
    vw = _larg_valor(itens, size)
    dw = lw - vw - 0.6
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
            G.text(s, x + lw - vw - 0.25, yy, vw, h, _brl(v), ajusta(_brl(v), vw, size + 1, True, MIN_PT),
                   G.TXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
        yy += h
    if cont_depois:
        G.text(s, x + 0.25, yy + 0.12, lw, 0.35, 'continua no próximo slide  ›', 16, G.TXT3)
    return yy


def s_orcamento(ctx, sl):
    itens = []
    for it in (sl.get('itens') or []) if isinstance(sl.get('itens'), list) else []:
        if isinstance(it, dict):
            d = _nb(_limpa(it.get('descricao') or it.get('item')))
            v = _num(it.get('valor'))
            if d or v is not None:
                itens.append((d or 'Item', v))
        elif _limpa(it):
            itens.append((_nb(_limpa(it)), None))
    mo, mat = _num(sl.get('mao_de_obra')), _num(sl.get('materiais'))
    comps = [(r, v) for r, v in (('MÃO DE OBRA', mo), ('MATERIAIS', mat)) if v is not None]
    total = _num(sl.get('total'))
    soma = sum(v for _, v in itens if v is not None)
    tit = _limpa(sl.get('titulo')) or 'Orçamento'
    if total is None:
        if any(v is not None for _, v in itens):
            total = soma
        elif comps:
            total = sum(v for _, v in comps)
    elif itens and all(v is not None for _, v in itens) and abs(total - soma) > 0.05:
        ctx.aviso(f'no orçamento "{tit}" o total informado ({_brl(total)}) não bate com a soma dos itens ({_brl(soma)}). Confira.')
    elif len(comps) == 2 and not itens and abs(total - mo - mat) > 0.05:
        ctx.aviso(f'no orçamento "{tit}" mão de obra mais materiais ({_brl(mo + mat)}) não bate com o total ({_brl(total)}). Confira.')
    img = None
    if _limpa(sl.get('documento')):
        info = ctx.doc_paginas(sl.get('documento'))
        if info:
            pg = _inteiro(sl.get('pagina')) or 1
            if pg > info[1]:
                ctx.aviso(f'a página {pg} não existe no documento "{_limpa(sl.get("documento"))}" (ele tem {info[1]}); usei a página 1.')
                pg = 1
            img = ctx.doc_pagina(sl.get('documento'), pg)
    if not itens and total is None and not img:
        ctx.aviso('orçamento sem itens, sem valores e sem documento; slide ignorado.')
        return
    forn = _nb(_limpa(sl.get('fornecedor')))
    blocos = [(r, t) for r, t in (('PAGAMENTO', _limpa(sl.get('pagamento'))), ('PRAZO', _limpa(sl.get('prazo'))),
                                  ('OBSERVAÇÃO', _limpa(sl.get('observacao')))) if t]
    titulo = sl.get('titulo') or 'Orçamento'
    sub = forn or None

    if img:
        # Página do orçamento à esquerda (inteira, sobre painel claro) e os valores à direita.
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, sub)
        dw_ = 5.2 if img.tam[1] >= img.tam[0] * 0.9 else 6.6
        por_imagem(s, img, X0, y, dw_, BASE - y, inteira=True)
        rx = X0 + dw_ + 0.3
        rw = X0 + W - rx
        if itens:
            sobra = BASE - y - _alt_painel(total, comps, blocos, rw)
            sz = _maior_que_cabe(range(17, MIN_PT - 1, -1), lambda t: sum(_alturas_itens(itens, rw, t)) + 0.65 <= sobra)
            if sz:
                yy = _tabela_itens(s, itens, list(range(len(itens))), _alturas_itens(itens, rw, sz), rx, y, rw, sz, False)
                _painel_valores(ctx, s, rx, yy + 0.2, rw, BASE, total, comps, blocos)
                return
            _painel_valores(ctx, s, rx, y, rw, BASE, total, comps, blocos)
            _orcamento_tabela(ctx, sl, itens, total, [], [], titulo, sub, cont_inicial=True)
            return
        _painel_valores(ctx, s, rx, y, rw, BASE, total, comps, blocos, 40)
        return

    if not itens:
        # Sem itens: cartões grandes com os valores e, embaixo, pagamento, prazo e observação.
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, sub)
        cards = ([('VALOR TOTAL', total, G.AMBER)] if total is not None else []) + \
                [(r, v, G.GS_AZUL_CLA if r == 'MÃO DE OBRA' else G.GREEN) for r, v in comps]
        n = len(cards)
        cw = (W - GAP * (n - 1)) / n
        hc = 2.0
        for k, (r, v, cor) in enumerate(cards):
            x = X0 + k * (cw + GAP)
            dest = r == 'VALOR TOTAL'
            cartao(s, x, y, cw, hc, cor if dest else G.CARD)
            if not dest:
                G.rect(s, x, y, 0.12, hc, cor)
            G.text(s, x + 0.4, y + 0.3, cw - 0.6, 0.3, r, 14, G.DARKTXT if dest else G.TXT3, True)
            vv = _brl(v)
            tv = ajusta(vv, cw - 0.7, 40, True, 18)
            G.text(s, x + 0.4, y + 0.78, cw - 0.6, lh(tv, True), vv, tv, G.DARKTXT if dest else cor, True)
        yb = y + hc + GAP
        if blocos:
            nb = len(blocos)
            bw = (W - GAP * (nb - 1)) / nb
            tws = bw - 0.7
            disp = BASE - yb
            tb = _maior_que_cabe(range(22, MIN_PT - 1, -1),
                                 lambda t: max(0.7 + alt(_nb(v), t, tws, r != 'OBSERVAÇÃO') for r, v in blocos) + 0.25 <= disp) or MIN_PT
            hb = min(disp, max(0.7 + alt(_nb(v), tb, tws, r != 'OBSERVAÇÃO') for r, v in blocos) + 0.35)
            for k, (r, v) in enumerate(blocos):
                x = X0 + k * (bw + GAP)
                cartao(s, x, yb, bw, hb)
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
    disp = BASE - topo - 0.55
    size = _maior_que_cabe(range(19, MIN_PT - 1, -1),
                           lambda t: len(itens) <= LINHAS_TABELA and sum(_alturas_itens(itens, lw, t)) <= disp) or 16
    alturas = _alturas_itens(itens, lw, size)
    pags = _agrupar(alturas, disp, 0.0, LINHAS_TABELA)
    if len(pags) > 1:
        pags = _agrupar(alturas, disp - 0.45, 0.0, LINHAS_TABELA)
    for pi, idxs in enumerate(pags):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, sub, cont=cont_inicial or pi > 0)
        _tabela_itens(s, itens, idxs, alturas, X0, y, lw, size, pi < len(pags) - 1)
        _painel_valores(ctx, s, rx, y, rw, BASE, total, comps, blocos)


def s_comparativo(ctx, sl):
    ops = []
    for o in (sl.get('opcoes') or []) if isinstance(sl.get('opcoes'), list) else []:
        if isinstance(o, dict):
            ops.append({'nome': _nb(_limpa(o.get('nome'))) or f'Opção {len(ops) + 1}', 'valor': _num(o.get('valor')),
                        'resumo': [_nb(t) for t in _lista(o.get('resumo'))], 'pagamento': _nb(_limpa(o.get('pagamento')))})
    if not ops:
        ctx.aviso('comparativo sem opções; slide ignorado.')
        return
    if len(ops) == 1:
        ctx.aviso('comparativo com uma opção só; não há o que comparar, mas o slide foi mantido.')
    vals = [o['valor'] for o in ops if o['valor'] is not None]
    menor = min(vals) if len(vals) >= 2 else None
    media = sum(vals) / len(vals) if (sl.get('mostrar_media') and len(vals) >= 2) else None
    if sl.get('mostrar_media') and media is None:
        ctx.aviso('o comparativo pediu a média, mas tem menos de dois valores; média não mostrada.')
    obs = _limpa(sl.get('observacao'))
    if len(ops) > 6:
        ctx.aviso('mais de 6 opções no comparativo; o restante foi para outro slide.')
    grupos = [ops[i:i + 6] for i in range(0, len(ops), 6)]
    sub = sl.get('subtitulo')
    for gi, grupo in enumerate(grupos):
        s = ctx.novo()
        wt = 8.3 if media is not None else W
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Comparativo', sub if gi == 0 else None, cont=gi > 0, w=wt)
        if media is not None:
            # Média dos orçamentos no canto, como o total da categoria no detalhamento da prestação.
            mx, mw = 9.0, 3.83
            cartao(s, mx, 0.32, mw, 1.45, G.GS_AZUL, 0.08)
            G.text(s, mx + 0.3, 0.44, mw - 0.5, 0.3, f'MÉDIA DOS {len(vals)} ORÇAMENTOS', 13, G.TXT, True)
            vm = _brl(media)
            tv = ajusta(vm, mw - 0.5, 28, True, 18)
            G.text(s, mx + 0.3, 0.76, mw - 0.5, lh(tv, True), vm, tv, G.TXT, True)
            if menor is not None and media > menor:
                G.text(s, mx + 0.3, 1.36, mw - 0.5, 0.3, f'menor valor {G.pct((media - menor) / media * 100)} abaixo', 13, G.TXT2)
            y = max(y, 1.95)
        ho = _alt_obs(obs) if (obs and gi == len(grupos) - 1) else 0
        fim = BASE - (ho + 0.2 if ho else 0)
        filas = [len(grupo)] if len(grupo) <= 4 else [3, len(grupo) - 3]
        compacto = len(filas) > 1
        gap_v = 0.34
        y_card = y + 0.28
        hcard = (fim - y_card - gap_v * (len(filas) - 1)) / len(filas)
        cw = (W - GAP * (max(filas) - 1)) / max(filas)
        tw = cw - 0.6
        tn_max, tv_max = (18, 26) if compacto else (22, 34)
        nl_nome = 1 if compacto else 2
        # Compacto (5 e 6 opções): a diferença vai na linha do valor e o resumo vira uma linha corrida.
        fixo = (0.26 + lh(tn_max, True) + 0.04 + lh(tv_max, True) + 0.1 + 0.14 if compacto else
                0.3 + lh(tn_max, True) * nl_nome + 0.08 + lh(tv_max, True) + 0.32 + 0.3)

        def h_cont(o, t):
            if compacto:
                h = fixo + (alt('  ·  '.join(o['resumo']), t, tw) if o['resumo'] else 0)
            else:
                h = fixo + sum(alt(x, t, tw - 0.3) + 0.12 for x in o['resumo'])
            return h + (0.45 + alt(o['pagamento'], t, tw) if o['pagamento'] else 0)
        ts = _maior_que_cabe(range(18, MIN_PT - 1, -1), lambda t: all(h_cont(o, t) <= hcard for o in grupo))
        mostra_resumo = ts is not None
        if ts is not None and not compacto:
            livre = hcard
            hcard = min(hcard, max(max(h_cont(o, ts) for o in grupo) + 0.8, 3.4))
            y_card += (livre - hcard) * 0.3
        if ts is None:
            ts = MIN_PT
            if any(o['resumo'] for o in grupo):
                ctx.aviso('o resumo das opções do comparativo não coube nos cartões; ficou de fora.')
        k = 0
        for fi, nfila in enumerate(filas):
            x0 = X0 + (W - (cw * nfila + GAP * (nfila - 1))) / 2
            yc = y_card + fi * (hcard + gap_v)
            for j in range(nfila):
                o = grupo[k]
                k += 1
                x = x0 + j * (cw + GAP)
                eh_menor = menor is not None and o['valor'] is not None and abs(o['valor'] - menor) < 0.005
                cartao(s, x, yc, cw, hcard, G.CARD2 if eh_menor else G.CARD, 0.05)
                if eh_menor:
                    contorno(s, x, yc, cw, hcard, G.AMBER, 2.5, min(0.05, 0.12 / hcard))
                    sw_ = largura_chip('MENOR VALOR', 13) + 0.1
                    G.rect(s, x + (cw - sw_) / 2, yc - 0.22, sw_, 0.42, G.AMBER, True, 0.5)
                    G.text(s, x + (cw - sw_) / 2, yc - 0.22, sw_, 0.42, 'MENOR VALOR', 13, G.DARKTXT, True,
                           PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
                else:
                    G.rect(s, x, yc, cw, 0.08, G.GS_AZUL)
                yy = yc + (0.26 if compacto else 0.3)
                tn = _maior_que_cabe(range(tn_max, 13, -1), lambda t: linhas(o['nome'], t, tw, True) <= nl_nome) or MIN_PT
                hn = lh(tn, True) * min(nl_nome, linhas(o['nome'], tn, tw, True))
                caixa(s, x + 0.3, yy, tw, hn, o['nome'], tn, G.TXT, True)
                yy += max(hn, lh(tn_max, True)) + (0.04 if compacto else 0.08)
                if compacto:
                    cor_v = G.AMBER if eh_menor else G.GS_AZUL_CLA
                    if o['valor'] is not None:
                        v = _brl(o['valor'])
                        dtx = ''
                        if menor is not None and not eh_menor:
                            dtx = '+' + G.pct((o['valor'] - menor) / menor * 100 if menor else 0)
                        wd = larg(dtx, 15, True) / 0.92 + 0.1 if dtx else 0
                        G.text(s, x + 0.3, yy, tw - wd, lh(tv_max, True), v, ajusta(v, tw - wd, tv_max, True, 16), cor_v, True)
                        if dtx:
                            G.text(s, x + 0.3 + tw - wd, yy, wd, lh(tv_max, True), dtx, 15, G.TXT3, True,
                                   PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
                    else:
                        G.text(s, x + 0.3, yy, tw, lh(tv_max, True), 'Valor não informado', 16, G.TXT3, True)
                    yy += lh(tv_max, True) + 0.1
                    if mostra_resumo and o['resumo']:
                        rz = '  ·  '.join(o['resumo'])
                        caixa(s, x + 0.3, yy, tw, alt(rz, ts, tw), rz, ts, G.TXT2)
                        yy += alt(rz, ts, tw)
                    if o['pagamento']:
                        hp = alt(o['pagamento'], ts, tw)
                        yb = max(yy + 0.05, yc + hcard - hp - 0.5)
                        G.text(s, x + 0.3, yb, tw, 0.3, 'PAGAMENTO', 13, G.TXT3, True)
                        caixa(s, x + 0.3, yb + 0.3, tw, hp, o['pagamento'], ts, G.TXT)
                    continue
                if o['valor'] is not None:
                    v = _brl(o['valor'])
                    G.text(s, x + 0.3, yy, tw, lh(tv_max, True), v, ajusta(v, tw, tv_max, True, 18),
                           G.AMBER if eh_menor else G.GS_AZUL_CLA, True)
                    yy += lh(tv_max, True)
                    if menor is not None and not eh_menor:
                        dif = o['valor'] - menor
                        tx = f'{_brl(dif)} acima ({G.pct(dif / menor * 100 if menor else 0)})'
                        G.text(s, x + 0.3, yy, tw, 0.3, tx, ajusta(tx, tw, 14, False, 11), G.TXT3)
                    elif eh_menor:
                        G.text(s, x + 0.3, yy, tw, 0.3, 'Proposta mais barata', 14, G.AMBER)
                else:
                    G.text(s, x + 0.3, yy, tw, lh(tv_max, True), 'Valor não informado', 18, G.TXT3, True)
                    yy += lh(tv_max, True)
                yy += 0.32
                if (o['resumo'] and mostra_resumo) or o['pagamento']:
                    G.rect(s, x + 0.3, yy, tw, 0.015, G.LINE)
                yy += 0.18
                if mostra_resumo:
                    for t in o['resumo']:
                        ht = alt(t, ts, tw - 0.3)
                        marcador(s, x + 0.3, yy, ts, G.AMBER if eh_menor else G.GS_AZUL_CLA)
                        caixa(s, x + 0.58, yy, tw - 0.3, ht, t, ts, G.TXT2)
                        yy += ht + 0.12
                if o['pagamento']:
                    hp = alt(o['pagamento'], ts, tw)
                    yb = max(yy + 0.05, yc + hcard - hp - 0.5)
                    G.text(s, x + 0.3, yb, tw, 0.3, 'PAGAMENTO', 13, G.TXT3, True)
                    caixa(s, x + 0.3, yb + 0.3, tw, hp, o['pagamento'], ts, G.TXT)
        if ho:
            _faixa_obs(s, BASE - ho, obs)


# ───────────────────────── tabela, números, barras ─────────────────────────

def _eh_numero(t: str) -> bool:
    return bool(t) and bool(re.fullmatch(r'[R$\s\d.,%()+x×/\- ]*\d[R$\s\d.,%()+x×/\- ]*', t))


def s_tabela(ctx, sl):
    def cel(c):
        return _nb(_valor_txt(c))
    cols = _lista(sl.get('colunas'))
    linhas_ = []
    for ln in (sl.get('linhas') or []) if isinstance(sl.get('linhas'), list) else []:
        if isinstance(ln, (list, tuple)):
            linhas_.append([cel(c) for c in ln])
        elif isinstance(ln, dict):
            linhas_.append([cel(v) for v in ln.values()])
    if not linhas_:
        ctx.aviso('tabela sem linhas; slide ignorado.')
        return
    tot = sl.get('total')
    total = [cel(c) for c in tot] if isinstance(tot, (list, tuple)) and tot else None
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
    todas = linhas_ + ([total] if total else [])
    numcol = [all(_eh_numero(r[c]) or not r[c] for r in todas) and any(r[c] for r in linhas_) for c in range(nc)]
    if nc > 1:
        numcol[0] = False

    def larguras(t):
        nat = [max([larg(cols[c].upper(), 14, True)] + [larg(r[c], t, numcol[c] or r is total) for r in todas]) / 0.9 + 0.55
               for c in range(nc)]
        if sum(nat) <= W:
            livres = [c for c in range(nc) if not numcol[c]] or list(range(nc))
            extra = W - sum(nat)
            for c in livres:
                nat[c] += extra / len(livres)
            return nat
        fixos = sum(nat[c] for c in range(nc) if numcol[c])
        livres = [c for c in range(nc) if not numcol[c]]
        if not livres or fixos > W * 0.75:
            return [W / nc] * nc
        soma_l = sum(nat[c] for c in livres)
        return [nat[c] if numcol[c] else max(1.3, (W - fixos) * nat[c] / soma_l) for c in range(nc)]

    topo = 2.05 if sub else 1.75
    ho = _alt_obs(obs)

    paginada = len(linhas_) > LINHAS_TABELA
    # Paginada: linhas divididas por igual entre os slides (25 linhas viram 9, 8 e 8) e mais baixas.
    n_pags = math.ceil(len(linhas_) / LINHAS_TABELA)
    por_pag = math.ceil(len(linhas_) / n_pags)
    hmin = 0.46 if paginada else max(0.62, min(0.92, (BASE - topo) * 0.55 / max(1, len(linhas_))))

    def alturas(t, ws):
        return [max(hmin, max(alt(r[c], t, ws[c] - 0.5, numcol[c]) for c in range(nc)) + 0.26) for r in linhas_]

    def h_total(t, ws):
        return max(0.66, max(alt(total[c], t, ws[c] - 0.5, True) for c in range(nc)) + 0.28) if total else 0

    def h_cab(ws):
        return max(0.52, max(alt(cols[c].upper(), 14, ws[c] - 0.5, True) for c in range(nc)) + 0.22)

    def cabe(t):
        ws = larguras(t)
        hs_ = alturas(t, ws)
        extra = (h_total(t, ws) + 0.1 if total else 0) + (ho + 0.25 if ho else 0)
        if not paginada:
            return h_cab(ws) + sum(hs_) + extra <= BASE - topo
        # a página mais alta tem que caber com a linha "continua"; a última, com total e observação
        blocos = [hs_[i:i + por_pag] for i in range(0, len(hs_), por_pag)]
        return (max(sum(b) for b in blocos[:-1]) + 0.45 <= BASE - topo - h_cab(ws) and
                sum(blocos[-1]) + extra <= BASE - topo - h_cab(ws))

    size = _maior_que_cabe(range(22 if not paginada else 18, MIN_PT - 1, -1), cabe)
    ws = larguras(size or MIN_PT)
    hs = alturas(size or MIN_PT, ws)
    hc = h_cab(ws)
    disp = BASE - topo - hc
    if size is not None:
        pags = [list(range(i, min(i + por_pag, len(linhas_)))) for i in range(0, len(linhas_), por_pag)]
    else:
        size = MIN_PT
        pags = _agrupar(hs, disp - 0.45, 0.0, LINHAS_TABELA)
    fim_extra = (h_total(size, ws) + 0.1 if total else 0) + (ho + 0.25 if ho else 0)
    if sum(hs[i] for i in pags[-1]) + fim_extra > disp:
        if len(pags[-1]) > 1:
            pags.append([pags[-1].pop()])
        else:
            pags.append([])
    for pi, idxs in enumerate(pags):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Tabela', sub if pi == 0 else None, cont=pi > 0)
        x = X0
        cartao(s, X0, y, W, hc, G.GS_AZUL, 0.12)
        for c in range(nc):
            caixa(s, x + 0.25, y, ws[c] - 0.5, hc, cols[c].upper(), 14, G.TXT, True,
                  PP_ALIGN.RIGHT if numcol[c] else PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
            x += ws[c]
        yy = y + hc
        for k, i in enumerate(idxs):
            r = linhas_[i]
            if k % 2 == 1:
                G.rect(s, X0, yy, W, hs[i], G.CARD)
            x = X0
            for c in range(nc):
                caixa(s, x + 0.25, yy, ws[c] - 0.5, hs[i], r[c], size, G.TXT if c == 0 or numcol[c] else G.TXT2,
                      numcol[c], PP_ALIGN.RIGHT if numcol[c] else PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
                x += ws[c]
            yy += hs[i]
        G.rect(s, X0, yy, W, 0.02, G.LINE)
        if pi == len(pags) - 1:
            if total:
                ht = h_total(size, ws)
                yy += 0.1
                cartao(s, X0, yy, W, ht, G.AMBER, 0.12)
                x = X0
                for c in range(nc):
                    caixa(s, x + 0.25, yy, ws[c] - 0.5, ht, total[c].upper() if c == 0 else total[c], size, G.DARKTXT,
                          True, PP_ALIGN.RIGHT if numcol[c] else PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
                    x += ws[c]
                yy += ht
            if obs:
                _faixa_obs(s, yy + 0.25, obs)
        else:
            G.text(s, X0 + 0.25, yy + 0.12, W, 0.35, 'continua no próximo slide  ›', 16, G.TXT3)


def s_numeros(ctx, sl):
    cards = []
    for c in (sl.get('cards') or []) if isinstance(sl.get('cards'), list) else []:
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
    cores = [G.AMBER, G.GS_AZUL_CLA, G.GREEN, VIOLETA]
    for gi, grupo in enumerate(grupos):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo'), sub if gi == 0 else None, cont=gi > 0)
        filas = _grade(len(grupo))
        maxc = max(filas)
        cw = (W - GAP * (maxc - 1)) / maxc
        disp = BASE - y
        vsize = min(ajusta(v, cw - 0.75, 44 if maxc <= 3 else 34, True, 18) for _, v, _ in grupo)
        hr = max(min(alt(r, 14, cw - 0.75, True), 2 * lh(14, True)) for r, _, _ in grupo)
        hsub = max([min(alt(sb, 16, cw - 0.75), 2 * lh(16)) for _, _, sb in grupo if sb] or [0])
        hneed = 0.35 + hr + 0.18 + lh(vsize, True) + (0.15 + hsub if hsub else 0) + 0.35
        h = min(max(hneed, 2.5 if len(filas) == 1 else 2.0), (disp - GAP * (len(filas) - 1)) / len(filas))
        bloco = h * len(filas) + GAP * (len(filas) - 1)
        y0 = y + max(0, (disp - bloco) * 0.4)
        k = 0
        for fi, nf in enumerate(filas):
            xs = X0 + (W - (cw * nf + GAP * (nf - 1))) / 2
            for j in range(nf):
                rot, v, sb = grupo[k]
                cor = cores[k % len(cores)]
                k += 1
                x = xs + j * (cw + GAP)
                yy = y0 + fi * (h + GAP)
                cartao(s, x, yy, cw, h)
                G.rect(s, x, yy, 0.12, h, cor)
                yt = yy + max(0.35, (h - (hneed - 0.7)) / 2)
                caixa(s, x + 0.42, yt, cw - 0.75, hr, rot, 14, G.TXT3, True)
                vy = yt + hr + 0.18
                G.text(s, x + 0.42, vy, cw - 0.6, lh(vsize, True), v, vsize, cor, True)
                if sb:
                    ts = 16 if linhas(sb, 16, cw - 0.75) <= 2 else MIN_PT
                    caixa(s, x + 0.42, vy + lh(vsize, True) + 0.15, cw - 0.75, min(alt(sb, ts, cw - 0.75), 2 * lh(ts)),
                          sb, ts, G.TXT2)


def s_barras(ctx, sl):
    itens = []
    for it in (sl.get('itens') or []) if isinstance(sl.get('itens'), list) else []:
        if isinstance(it, dict):
            nm, v = _nb(_limpa(it.get('nome') or it.get('rotulo'))), _num(it.get('valor'))
            if nm and v is not None:
                itens.append((nm, v))
            elif nm:
                ctx.aviso(f'o item "{nm}" das barras veio sem valor; ficou de fora.')
    if not itens:
        ctx.aviso('slide de barras sem itens com valor; slide ignorado.')
        return
    pct_on = bool(sl.get('mostrar_percentual'))
    total = sum(v for _, v in itens)
    nota = _limpa(sl.get('nota'))
    sub = sl.get('subtitulo')
    pags = [itens[i:i + 10] for i in range(0, len(itens), 10)]
    maxv = max(abs(v) for _, v in itens) or 1
    cores = G.cat_colors(max(len(itens), 2))
    for pi, lst in enumerate(pags):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo'), sub if pi == 0 else None, cont=pi > 0)
        ho = _alt_obs(nota, rotulo='NOTA') if (nota and pi == len(pags) - 1) else 0
        disp = BASE - y - (ho + 0.25 if ho else 0)
        n = len(lst)
        rh = min(0.75, disp / n)
        x0, w = X0 + 0.1, W - 0.2
        val_w = max(larg(G.brl_acc(v), 19, True) for _, v in lst) / 0.92 + 0.15
        pct_w = 1.25 if pct_on else 0
        nome_max = w - val_w - pct_w - 3.0
        fs = _maior_que_cabe(range(19, MIN_PT - 1, -1),
                             lambda t: all(alt(nm, t, min(4.8, nome_max), True) <= rh - 0.06 for nm, _ in lst)) or MIN_PT
        name_w = min(4.8, nome_max, max(larg(nm, fs, True) for nm, _ in lst) / 0.9 + 0.3)
        bar_x = x0 + name_w
        bar_w = w - name_w - val_w - pct_w - 0.3
        for i, (nm, v) in enumerate(lst):
            yy = y + i * rh
            if i % 2 == 0:
                G.rect(s, x0 - 0.1, yy, w + 0.2, rh, G.CARD)
            caixa(s, x0 + 0.1, yy, name_w - 0.2, rh, nm, fs, G.TXT, True, anchor=MSO_ANCHOR.MIDDLE)
            cor = cores[pi * 10 + i] if v >= 0 else G.RED
            G.rect(s, bar_x, yy + rh * 0.3, max(0.06, bar_w * abs(v) / maxv), rh * 0.4, cor, True, 0.3)
            vt = G.brl_acc(v)
            G.text(s, bar_x + bar_w + 0.15, yy, val_w, rh, vt, ajusta(vt, val_w, fs, True, MIN_PT),
                   G.RED if v < 0 else G.TXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
            if pct_on and total:
                pv = v / total * 100
                G.text(s, x0 + w - pct_w, yy, pct_w, rh, ('(' + G.pct(abs(pv)) + ')') if pv < 0 else G.pct(pv), fs,
                       cor, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
        if ho:
            _faixa_obs(s, BASE - ho, nota, rotulo='NOTA')


# ───────────────────────── cartões, passos, pontos ─────────────────────────

def s_cards(ctx, sl):
    cards = []
    for c in (sl.get('cards') or []) if isinstance(sl.get('cards'), list) else []:
        if isinstance(c, dict):
            t, d = _nb(_limpa(c.get('titulo'))), _nb(_limpa(c.get('texto')))
            if t or d:
                cards.append((t, d, _limpa(c.get('rotulo')).upper(), _limpa(c.get('status')).upper()))
    if not cards:
        ctx.aviso('slide de cartões sem cartões; slide ignorado.')
        return
    grupos = [cards[i:i + 8] for i in range(0, len(cards), 8)]
    sub = sl.get('subtitulo')
    for gi, grupo in enumerate(grupos):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo'), sub if gi == 0 else None, cont=gi > 0)
        filas = _grade(len(grupo))
        maxc = max(filas)
        cw = (W - 0.2 * (maxc - 1)) / maxc
        tw = cw - 0.6
        hc_max = (BASE - y - 0.2 * (len(filas) - 1)) / len(filas)
        h_topo = 0.62 if any(r or st for _, _, r, st in grupo) else 0.25

        def h_card(t, card):
            return h_topo + 0.1 + alt_tit_desc(card[0], t + 4, card[1], t, tw, 0.14) + 0.3
        ts = _maior_que_cabe(range(18, MIN_PT - 1, -1), lambda t: all(h_card(t, c) <= hc_max for c in grupo))
        if ts is None:
            ts = MIN_PT
            ctx.aviso('texto demais nos cartões; resuma a descrição para caber.')
        hc = min(hc_max, max(max(h_card(ts, c) for c in grupo) + 0.2, min(hc_max, 2.0)))
        bloco = hc * len(filas) + 0.2 * (len(filas) - 1)
        y0 = y + max(0, (BASE - y - bloco) * 0.25)
        k = 0
        for fi, nf in enumerate(filas):
            xs = X0 + (W - (cw * nf + 0.2 * (nf - 1))) / 2
            for j in range(nf):
                tt, d, rot, st = grupo[k]
                cor = _cor_status(st) if st else CICLO[k % len(CICLO)]
                k += 1
                x = xs + j * (cw + 0.2)
                yy = y0 + fi * (hc + 0.2)
                cartao(s, x, yy, cw, hc)
                G.rect(s, x, yy, cw, 0.08, cor)
                wchip = 0
                if st:
                    while largura_chip(st, 11) > cw * 0.6 and ' ' in st:
                        st = st.rsplit(' ', 1)[0]
                    wchip = largura_chip(st, 11)
                    chip(s, x + cw - 0.25 - wchip, yy + 0.24, st, cor, 11, 0.28)
                if rot:
                    wr = cw - 0.55 - (wchip + 0.15 if wchip else 0)
                    G.text(s, x + 0.3, yy + 0.27, wr, 0.3, rot, ajusta(rot, wr, 14, True, 10), cor, True)
                tit_desc(s, x + 0.3, yy + h_topo + 0.1, tw, tt, ts + 4, d, ts, gap=0.14)


def s_passos(ctx, sl):
    passos = []
    for p in (sl.get('passos') or []) if isinstance(sl.get('passos'), list) else []:
        if isinstance(p, dict):
            t, d = _nb(_limpa(p.get('titulo'))), _nb(_limpa(p.get('texto')))
            if t or d:
                passos.append((t, d))
        elif _limpa(p):
            passos.append((_nb(_limpa(p)), ''))
    if not passos:
        ctx.aviso('slide de passos sem etapas; slide ignorado.')
        return
    npags = math.ceil(len(passos) / 6)
    base_n, extra = divmod(len(passos), npags)
    k0 = 0
    sub = sl.get('subtitulo')
    for pi in range(npags):
        q = base_n + (1 if pi < extra else 0)
        grupo = passos[k0:k0 + q]
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo'), sub if pi == 0 else None, cont=pi > 0)
        n = len(grupo)
        cw = (W - 0.2 * (n - 1)) / n
        tw = cw - 0.5
        d = 0.9 if n <= 4 else 0.75
        disp = BASE - y - d - 0.35
        ts = _maior_que_cabe(range(17, MIN_PT - 1, -1),
                             lambda t: max(alt_tit_desc(tt, t + 3, dd, t, tw) for tt, dd in grupo) + 0.55 <= disp) or MIN_PT
        hc = min(disp, max(max(alt_tit_desc(tt, ts + 3, dd, ts, tw) for tt, dd in grupo) + 0.6, 2.4))
        yc = y + max(0, (BASE - y - (d + 0.35 + hc)) * 0.35)
        if n > 1:
            G.hline(s, X0 + cw / 2, yc + d / 2, X0 + (n - 1) * (cw + 0.2) + cw / 2, G.LINE, 3)
        for i, (tt, dd) in enumerate(grupo):
            x = X0 + i * (cw + 0.2)
            cor = CICLO[(k0 + i) % len(CICLO)]
            oval(s, x + cw / 2 - d / 2, yc, d, cor)
            G.text(s, x + cw / 2 - d / 2, yc, d, d, str(k0 + i + 1), 28 if d > 0.8 else 24, G.DARKTXT, True,
                   PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
            cartao(s, x, yc + d + 0.35, cw, hc)
            G.rect(s, x, yc + d + 0.35, cw, 0.07, cor)
            tit_desc(s, x + 0.25, yc + d + 0.35 + 0.3, tw, tt, ts + 3, dd, ts, align=PP_ALIGN.CENTER)
        k0 += q


def s_pontos(ctx, sl):
    pts = []
    for p in (sl.get('pontos') or []) if isinstance(sl.get('pontos'), list) else []:
        if isinstance(p, dict):
            t = _nb(_limpa(p.get('texto') or p.get('titulo')))
            if t:
                pts.append((t, _limpa(p.get('origem')).upper()))
        elif _limpa(p):
            pts.append((_nb(_limpa(p)), ''))
    if not pts:
        ctx.aviso('slide de pontos sem pontos; slide ignorado.')
        return
    grupos = [pts[i:i + 8] for i in range(0, len(pts), 8)]
    sub = sl.get('subtitulo')
    for gi, grupo in enumerate(grupos):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Pontos levantados nesta assembleia',
                      sub if gi == 0 else None, cont=gi > 0, kicker=_kicker(ctx, sl, 'PARA DELIBERAÇÃO'))
        ncol = 1 if len(grupo) <= 3 else 2
        nlin = math.ceil(len(grupo) / ncol)
        cw = (W - 0.2 * (ncol - 1)) / ncol
        hc_max = (BASE - y - 0.2 * (nlin - 1)) / nlin
        tw = cw - 0.7
        ts = _maior_que_cabe(range(22, MIN_PT - 1, -1),
                             lambda t: max(0.62 + alt(tx, t, tw, True) + 0.3 for tx, _ in grupo) <= hc_max) or MIN_PT
        hc = min(hc_max, max(max(0.62 + alt(tx, ts, tw, True) + 0.3 for tx, _ in grupo) + 0.1, 1.2))
        for i, (tx, org) in enumerate(grupo):
            x = X0 + (i % ncol) * (cw + 0.2)
            yy = y + (i // ncol) * (hc + 0.2)
            cor = CICLO[i % len(CICLO)]
            cartao(s, x, yy, cw, hc)
            G.rect(s, x, yy, 0.12, hc, cor)
            G.text(s, x + 0.4, yy + 0.24, 2.0, 0.3, f'PONTO {gi * 8 + i + 1}', 13, cor, True)
            if org:
                chip(s, x + cw - 0.25 - largura_chip(org, 11), yy + 0.22, org, G.CARD2, 11, 0.3, G.TXT2)
            caixa(s, x + 0.4, yy + 0.62, tw, alt(tx, ts, tw, True), tx, ts, G.TXT, True)


# ───────────────────────── fotos e documentos ─────────────────────────

def _galeria(s, fotos, x0, y0, w, h):
    """Grade automática: 1 grande; 2 lado a lado; 3; 4 em 2x2; 5 e 6 em 3x2. Legenda embaixo."""
    filas = {1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3]}[len(fotos)]
    gap = 0.18
    hl = (h - gap * (len(filas) - 1)) / len(filas)
    maxc = max(filas)
    cw = (w - gap * (maxc - 1)) / maxc
    k = 0
    for li, nf in enumerate(filas):
        xs = x0 + (w - (cw * nf + gap * (nf - 1))) / 2
        yl = y0 + li * (hl + gap)
        tl = 16 if len(filas) == 1 and nf <= 2 else 15
        hleg = max([min(alt(lg, tl, cw - 0.4), 2 * lh(tl)) for _, lg in fotos[k:k + nf] if lg] or [0])
        for j in range(nf):
            img, leg = fotos[k + j]
            x = xs + j * (cw + gap)
            ha = hl - (hleg + 0.24 if hleg else 0)
            por_imagem(s, img, x, yl, cw, ha)
            if hleg:
                G.rect(s, x, yl + ha, cw, hleg + 0.24, G.CARD)
            if leg:
                caixa(s, x + 0.2, yl + ha + 0.12, cw - 0.4, hleg, leg, tl, G.TXT2, align=PP_ALIGN.CENTER)
        k += nf


def s_fotos(ctx, sl):
    itens = []
    for f in (sl.get('fotos') or []) if isinstance(sl.get('fotos'), list) else []:
        fid, leg = (f.get('id'), f.get('legenda')) if isinstance(f, dict) else (f, None)
        if not _limpa(fid):
            continue
        img = ctx.foto(fid)
        if img:
            itens.append((img, _nb(_limpa(leg))))
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
        _galeria(s, grupo, X0, y, W, BASE - y)


def s_foto_texto(ctx, sl):
    img = ctx.foto(sl.get('foto')) if _limpa(sl.get('foto')) else None
    if not _limpa(sl.get('foto')):
        ctx.aviso('slide de foto com texto sem foto indicada.')
    tops = [_nb(t) for t in _lista(sl.get('topicos'))]
    valor = _nb(_valor_txt(sl.get('valor'))) if sl.get('valor') not in (None, '') else ''
    if not img and not tops and not valor:
        ctx.aviso('slide de foto com texto vazio; slide ignorado.')
        return
    s = ctx.novo()
    y = cabecalho(ctx, s, sl, sl.get('titulo'), sl.get('subtitulo'))
    tx = X0
    if img:
        por_imagem(s, img, X0, y, 6.3, BASE - y)
        tx = X0 + 6.6
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
        cartao(s, tx, yv, tw, hv, G.AMBER, 0.08)
        G.text(s, tx + 0.35, yv + 0.2, tw - 0.6, 0.3, 'VALOR', 14, G.DARKTXT, True)
        tv = ajusta(valor, tw - 0.6, 36, True, 18)
        G.text(s, tx + 0.35, yv + 0.55, tw - 0.6, lh(tv, True), valor, tv, G.DARKTXT, True)


def s_antes_depois(ctx, sl):
    ra = ctx.foto(sl.get('antes')) if _limpa(sl.get('antes')) else None
    rd = ctx.foto(sl.get('depois')) if _limpa(sl.get('depois')) else None
    if not _limpa(sl.get('antes')) or not _limpa(sl.get('depois')):
        ctx.aviso('antes e depois sem uma das fotos indicadas.')
    if not ra and not rd:
        ctx.aviso('antes e depois sem nenhuma foto disponível; slide ignorado.')
        return
    tops = [_nb(t) for t in _lista(sl.get('topicos'))]
    s = ctx.novo()
    y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Antes e depois', sl.get('subtitulo'))
    hb = 0
    if tops:
        ncol = 2 if len(tops) > 1 else 1
        cw_t = (W - 0.8 - 0.4 * (ncol - 1)) / ncol
        por = math.ceil(len(tops) / ncol)
        cols_ = [tops[i * por:(i + 1) * por] for i in range(ncol)]

        def h_tops(t):
            return max(sum(alt(x, t, cw_t - 0.3) + 0.1 for x in c) for c in cols_) + 0.4
        tsz = _maior_que_cabe(range(20, MIN_PT - 1, -1), lambda t: h_tops(t) <= 1.9) or MIN_PT
        hb = min(h_tops(tsz), 2.2)
    hf = BASE - y - (hb + GAP if hb else 0)
    fw = (W - 0.3) / 2
    for k, (r, rot) in enumerate(((ra, 'ANTES'), (rd, 'DEPOIS'))):
        x = X0 + k * (fw + 0.3)
        if r:
            por_imagem(s, r, x, y, fw, hf)
        else:
            cartao(s, x, y, fw, hf, corner=0.03)
            G.text(s, x, y, fw, hf, 'Foto não enviada', 18, G.TXT3, True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
        sw_ = larg(rot, 16, True) / 0.92 + 0.45
        G.rect(s, x + 0.22, y + 0.22, sw_, 0.48, G.AMBER if rot == 'DEPOIS' else G.BG, True, 0.5)
        G.text(s, x + 0.22, y + 0.22, sw_, 0.48, rot, 16, G.DARKTXT if rot == 'DEPOIS' else G.TXT, True,
               PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
    if hb:
        yb = BASE - hb
        cartao(s, X0, yb, W, hb)
        G.rect(s, X0, yb, 0.12, hb, G.AMBER)
        for ci, col in enumerate(cols_):
            xx = X0 + 0.45 + ci * (cw_t + 0.4)
            yy = yb + 0.2
            for t in col:
                ht = alt(t, tsz, cw_t - 0.3)
                if yy + ht > BASE - 0.1:
                    break
                marcador(s, xx, yy, tsz, G.AMBER)
                caixa(s, xx + 0.28, yy, cw_t - 0.3, ht, t, tsz, G.TXT)
                yy += ht + 0.1


def s_documento(ctx, sl):
    did = sl.get('documento')
    if not _limpa(did):
        ctx.aviso('slide de documento sem o id do documento; slide ignorado.')
        return
    info = ctx.doc_paginas(did)
    if not info:
        return
    total = info[1]
    pags = sl.get('paginas')
    if pags in (None, '', []):
        pags = [sl.get('pagina') or 1]
    if not isinstance(pags, (list, tuple)):
        pags = [pags]
    validas = []
    for p in pags:
        n = _inteiro(p)
        if n is None or n > total:
            ctx.aviso(f'a página {_limpa(p) or "?"} não existe no documento "{_limpa(did)}" (ele tem {total} página{"s" if total > 1 else ""}).')
            continue
        if n not in validas:
            validas.append(n)
    if len(validas) > MAX_PAG_DOC:
        ctx.aviso(f'documento "{_limpa(did)}": entraram só as {MAX_PAG_DOC} primeiras páginas pedidas.')
        validas = validas[:MAX_PAG_DOC]
    nota = 'Documento na íntegra ao lado, como foi apresentado ao condomínio.'
    for p in validas:
        img = ctx.doc_pagina(did, p)
        if not img:
            continue
        s = ctx.novo()
        if img.tam[1] >= img.tam[0] * 0.9:
            y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Documento', sl.get('subtitulo'), w=6.3)
            cartao(s, X0, y, 6.3, 1.25)
            G.rect(s, X0, y, 0.12, 1.25, G.GS_AZUL)
            G.text(s, X0 + 0.4, y + 0.18, 5.6, 0.3, 'PÁGINA DO DOCUMENTO', 14, G.TXT3, True)
            G.text(s, X0 + 0.4, y + 0.52, 5.6, lh(28, True), f'{p} de {total}', 28, G.GS_AZUL_CLA, True)
            caixa(s, X0, y + 1.55, 6.3, alt(nota, 16, 6.3), nota, 16, G.TXT3)
            # Página inteira à direita, no maior tamanho que cabe, sobre papel branco.
            ax0, ax1, ay0, ay1 = 7.15, 12.83, 0.3, 6.95
            pad = 0.08
            mw, mh = ax1 - ax0 - 2 * pad, ay1 - ay0 - 2 * pad
            esc = min(mw / img.tam[0], mh / img.tam[1])
            w, h = img.tam[0] * esc, img.tam[1] * esc
            fx, fy = ax1 - (w + 2 * pad), ay0 + (mh - h) / 2
            cartao(s, fx, fy, w + 2 * pad, h + 2 * pad, G.rgb('FFFFFF'), 0.02)
            _nomear(s.shapes.add_picture(img.caminho, Inches(fx + pad), Inches(fy + pad), Inches(w), Inches(h)), img.rotulo)
        else:
            y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Documento', f'Página {p} de {total}')
            por_imagem(s, img, X0, y, W, BASE - y, inteira=True)


# ───────────────────────── regimento, custeio, votação, eleição, tempo ─────────────────────────

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
        return (alt(just, t, W - 0.75) + 0.72) if just else 0

    def disp_col(t, com_just=True):
        return BASE - topo - (h_just(t) + 0.2 if (just and com_just) else 0) - 0.95

    size = _maior_que_cabe(range(22, MIN_PT - 1, -1),
                           lambda t: max(alt(atual or 'x', t, tw), alt(prop, t, tw, True)) <= disp_col(t))
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
        y = cabecalho(ctx, s, sl, titulo, art or None, cont=pi > 0, kicker=_kicker(ctx, sl, 'REGIMENTO INTERNO'))
        hj = h_just(size) if (just and pi == len(pares) - 1) else 0
        yj = y
        if ta is not None or tp is not None:
            livre = BASE - y - (hj + 0.2 if hj else 0)
            cont = max(alt(ta or 'x', size, tw), alt(tp or '', size, tw, True))
            hc = min(livre, max(cont + 1.25, livre * 0.82))
            cartao(s, X0, y, cw, hc, corner=0.04)
            G.text(s, X0 + 0.35, y + 0.28, tw, 0.3, 'TEXTO ATUAL', 14, G.TXT3, True)
            if ta:
                caixa(s, X0 + 0.35, y + 0.75, tw, alt(ta, size, tw), ta, size, G.TXT2)
            elif ta == '':
                caixa(s, X0 + 0.35, y + 0.75, tw, lh(size), 'Texto inexistente hoje', size, G.TXT3)
                G.text(s, X0 + 0.35, y + 0.75 + lh(size) + 0.12, tw, 0.6, 'O artigo é novo e passa a valer se aprovado.', 15, G.TXT3)
            xp = X0 + cw + 0.3
            cartao(s, xp, y, cw, hc, G.GS_AZUL, 0.04)
            G.text(s, xp + 0.35, y + 0.28, tw, 0.3, 'PROPOSTA', 14, G.TXT, True)
            if tp:
                caixa(s, xp + 0.35, y + 0.75, tw, alt(tp, size, tw, True), tp, size, G.TXT, True)
            yj = y + hc + 0.2
        if hj:
            cartao(s, X0, yj, W, hj, G.CARD2, 0.08)
            G.rect(s, X0, yj, 0.12, hj, G.AMBER)
            G.text(s, X0 + 0.4, yj + 0.18, 4, 0.3, 'JUSTIFICATIVA', 14, G.AMBER, True)
            caixa(s, X0 + 0.4, yj + 0.52, W - 0.75, alt(just, size, W - 0.75), just, size, G.TXT2)


def s_custeio(ctx, sl):
    total = _num(sl.get('valor_total'))
    unid = _inteiro(sl.get('unidades'))
    ops = []
    for o in (sl.get('opcoes') or []) if isinstance(sl.get('opcoes'), list) else []:
        if isinstance(o, dict):
            ops.append((_limpa(o.get('nome')) or f'Opção {len(ops) + 1}', _inteiro(o.get('parcelas')) or 1,
                        _num(o.get('valor_parcela')), _nb(_limpa(o.get('observacao')))))
    if total is None and not ops:
        ctx.aviso('forma de custeio sem valor total e sem opções; slide ignorado.')
        return
    if total is not None and unid:
        por_un = total / unid
        for nome, p, v, _ in ops:
            if v is not None and abs(p * v - por_un) > max(0.05 * p, por_un * 0.02):
                ctx.aviso(f'custeio: {nome} soma {_brl(p * v)} por unidade, mas o rateio dá {_brl(por_un)}. Confira.')
    obs = _limpa(sl.get('observacao'))
    ho = _alt_obs(obs)
    grupos = [ops[i:i + 4] for i in range(0, len(ops), 4)] or [[]]
    cores = [G.GREEN, G.GS_AZUL_CLA, G.AMBER, VIOLETA, AMBAR, G.rgb('2DD4BF')] * 4
    for gi, grupo in enumerate(grupos):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Forma de custeio', sl.get('subtitulo') if gi == 0 else None, cont=gi > 0)
        fim = BASE - (ho + 0.25 if ho else 0)
        lw = 4.35
        ly = y
        if total is not None:
            cartao(s, X0, ly, lw, 1.75, G.AMBER, 0.07)
            G.text(s, X0 + 0.35, ly + 0.22, lw - 0.6, 0.3, 'VALOR TOTAL', 14, G.DARKTXT, True)
            vt = _brl(total)
            tv = ajusta(vt, lw - 0.6, 36, True, 18)
            G.text(s, X0 + 0.35, ly + 0.62, lw - 0.6, lh(tv, True), vt, tv, G.DARKTXT, True)
            ly += 1.75 + GAP
        if unid:
            hcard = min(1.95, fim - ly)
            cartao(s, X0, ly, lw, hcard, corner=0.07)
            G.rect(s, X0, ly, 0.12, hcard, G.GS_AZUL_CLA)
            G.text(s, X0 + 0.35, ly + 0.22, lw - 0.6, 0.3, 'POR UNIDADE', 14, G.TXT3, True)
            if total is not None:
                vu = _brl(total / unid)
                tv = ajusta(vu, lw - 0.6, 34, True, 18)
                G.text(s, X0 + 0.35, ly + 0.58, lw - 0.6, lh(tv, True), vu, tv, G.GS_AZUL_CLA, True)
            G.text(s, X0 + 0.35, ly + hcard - 0.5, lw - 0.6, 0.35, f'rateio entre {unid} unidades', 16, G.TXT2)
        tem_esq = total is not None or unid
        ox = X0 + lw + 0.3 if tem_esq else X0
        ow = X0 + W - ox
        if grupo:
            n = len(grupo)
            hop = min(1.55, (fim - y - GAP * (n - 1)) / n)
            for k, (nome, p, v, ob) in enumerate(grupo):
                yy = y + k * (hop + GAP)
                cor = cores[gi * 4 + k]
                cartao(s, ox, yy, ow, hop, corner=0.08)
                G.rect(s, ox, yy, 0.12, hop, cor)
                G.text(s, ox + 0.38, yy + 0.18, 3.5, 0.3, nome.upper(), 14, G.TXT3, True)
                if v is not None:
                    parc = f'{p}x  {_brl(v)}' if p > 1 else f'Parcela única de {_brl(v)}'
                    tt = _brl(p * v)
                    rot_t = 'TOTAL POR UNIDADE' if unid else 'TOTAL'
                    wt = max(larg(tt, 24, True), larg(rot_t, 14, True)) / 0.92 + 0.1
                    tp_ = ajusta(parc, ow - 0.75 - wt - 0.3, 30, True, 18)
                    G.text(s, ox + 0.38, yy + 0.52, ow - wt - 0.9, lh(tp_, True), parc, tp_, G.TXT, True)
                    G.text(s, ox + ow - wt - 0.3, yy + 0.18, wt, 0.3, rot_t, 14, G.TXT3, True, PP_ALIGN.RIGHT)
                    G.text(s, ox + ow - wt - 0.3, yy + 0.52, wt, lh(24, True), tt, 24, cor, True, PP_ALIGN.RIGHT)
                    if ob and hop >= 1.3:
                        G.text(s, ox + 0.38, yy + hop - 0.42, ow - 0.75, 0.3, ob, 14, G.TXT2)
                else:
                    G.text(s, ox + 0.38, yy + 0.52, ow - 0.75, 0.6, f'{p} parcela{"s" if p > 1 else ""}', 26, G.TXT, True)
        elif tem_esq:
            cartao(s, ox, y, ow, 1.0, corner=0.08)
            G.text(s, ox + 0.38, y, ow - 0.75, 1.0, 'Forma de pagamento a definir na assembleia.', 18, G.TXT2,
                   anchor=MSO_ANCHOR.MIDDLE)
        if ho:
            _faixa_obs(s, BASE - ho, obs)


def _cor_voto(op: str, k: int):
    t = _sem_acento(op)
    if t.startswith(('nao', 'contra', 'reprova', 'rejeita')):
        return G.RED
    if t.startswith('absten'):
        return G.TXT3
    if t.startswith(('a favor', 'aprova', 'sim', 'favoravel', 'concordo')):
        return G.GREEN
    return [G.GS_AZUL_CLA, G.AMBER, AMBAR, VIOLETA][k % 4]


def s_votacao(ctx, sl):
    perg = _nb(_limpa(sl.get('pergunta')))
    ops = _lista(sl.get('opcoes')) or ['A favor', 'Contra', 'Abstenção']
    if not perg:
        ctx.aviso('votação sem pergunta; usei o título do slide.')
        perg = _nb(_limpa(sl.get('titulo'))) or 'Deliberação'
    if len(ops) > 6:
        ctx.aviso('votação com mais de 6 opções; só as 6 primeiras entraram.')
        ops = ops[:6]
    regra = _nb(_limpa(sl.get('regra')))
    obs = _limpa(sl.get('observacao'))
    s = ctx.novo()
    y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Votação', sl.get('subtitulo'), kicker=_kicker(ctx, sl, 'VOTAÇÃO'))
    ho = _alt_obs(obs)
    tw_r = W - 0.7
    tr = (_maior_que_cabe([17, 16, 15, 14], lambda t: linhas(regra, t, tw_r) <= 3) or 14) if regra else 0
    hr = (alt(regra, tr, tw_r) + 0.62) if regra else 0
    nl_op = 1 if len(ops) <= 4 else 2
    hop = 1.25 if nl_op == 1 else 0.95
    h_ops = 0.42 + nl_op * hop + (nl_op - 1) * GAP
    rodape_h = (hr + 0.2 if hr else 0) + (ho + 0.2 if ho else 0)
    disp_q = BASE - y - h_ops - 0.3 - rodape_h
    tw = W - 0.9
    tq = _maior_que_cabe(range(28, MIN_PT - 1, -1), lambda t: alt(perg, t, tw, True) + 0.85 <= disp_q) or MIN_PT
    hq = min(disp_q, max(1.5, alt(perg, tq, tw, True) + 0.9))
    cartao(s, X0, y, W, hq)
    G.rect(s, X0, y, 0.12, hq, G.GREEN)
    G.text(s, X0 + 0.42, y + 0.22, 6, 0.3, 'O QUE SERÁ VOTADO', 14, G.GREEN, True)
    caixa(s, X0 + 0.42, y + 0.6, tw, alt(perg, tq, tw, True), perg, tq, G.TXT, True)
    yo = y + hq + 0.3
    G.text(s, X0, yo, 6, 0.3, 'OPÇÕES DE VOTO', 14, G.TXT3, True)
    yo += 0.42
    por = len(ops) if nl_op == 1 else math.ceil(len(ops) / 2)
    cw = (W - GAP * (por - 1)) / por
    for k, op in enumerate(ops):
        li, co = divmod(k, por)
        x = X0 + co * (cw + GAP)
        yy = yo + li * (hop + GAP)
        cor = _cor_voto(op, k)
        cartao(s, x, yy, cw, hop)
        G.rect(s, x, yy, cw, 0.08, cor)
        txt = op.upper()
        to = _maior_que_cabe(range(28, MIN_PT - 1, -1),
                             lambda t: linhas(txt, t, cw - 0.4, True) <= 2 and alt(txt, t, cw - 0.4, True) <= hop - 0.2) or MIN_PT
        caixa(s, x + 0.2, yy + 0.04, cw - 0.4, hop - 0.04, txt, to, cor, True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
    yb = BASE - rodape_h + 0.2
    if hr:
        cartao(s, X0, yb, W, hr, G.CARD2, 0.1)
        G.text(s, X0 + 0.35, yb + 0.16, 6, 0.3, 'REGRA DE VOTAÇÃO', 13, G.TXT3, True)
        caixa(s, X0 + 0.35, yb + 0.46, tw_r, alt(regra, tr, tw_r), regra, tr, G.TXT2)
    if ho:
        _faixa_obs(s, BASE - ho, obs)


def s_eleicao(ctx, sl):
    cargos = []
    for c in (sl.get('cargos') or []) if isinstance(sl.get('cargos'), list) else []:
        if isinstance(c, dict) and _limpa(c.get('cargo')):
            cargos.append({'cargo': _nb(_limpa(c.get('cargo'))), 'mandato': _nb(_limpa(c.get('mandato'))),
                           'cand': [_nb(t) for t in _lista(c.get('candidatos'))], 'obs': _nb(_limpa(c.get('observacao')))})
        elif isinstance(c, str) and _limpa(c):
            cargos.append({'cargo': _nb(_limpa(c)), 'mandato': '', 'cand': [], 'obs': ''})
    if not cargos:
        ctx.aviso('eleição sem cargos; slide ignorado.')
        return
    titulo = sl.get('titulo') or 'Eleição'
    kick = _kicker(ctx, sl, 'ELEIÇÃO')
    if len(cargos) == 1:
        c = cargos[0]
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, sl.get('subtitulo'), kicker=kick)
        tw = W - 0.8
        tc = _maior_que_cabe(range(34, 19, -1), lambda t: linhas(c['cargo'], t, tw, True) <= 2) or 20
        hc = alt(c['cargo'], tc, tw, True) + 0.85
        cartao(s, X0, y, W, hc)
        G.rect(s, X0, y, 0.12, hc, G.AMBER)
        G.text(s, X0 + 0.4, y + 0.22, 4, 0.3, 'CARGO EM ELEIÇÃO', 14, G.TXT3, True)
        caixa(s, X0 + 0.4, y + 0.56, tw, alt(c['cargo'], tc, tw, True), c['cargo'], tc, G.TXT, True)
        yy = y + hc + GAP
        cards = [(r, v) for r, v in (('MANDATO', c['mandato']), ('OBSERVAÇÃO', c['obs'])) if v]
        if cards:
            n = len(cards)
            cw = (W - GAP * (n - 1)) / n
            hrow = max(0.75 + alt(v, 24, cw - 0.75, True) + 0.3 for _, v in cards)
            for k, (r, v) in enumerate(cards):
                x = X0 + k * (cw + GAP)
                cartao(s, x, yy, cw, hrow)
                G.rect(s, x, yy, 0.12, hrow, G.GS_AZUL_CLA if r == 'MANDATO' else G.GREEN)
                G.text(s, x + 0.4, yy + 0.24, cw - 0.6, 0.3, r, 14, G.TXT3, True)
                caixa(s, x + 0.4, yy + 0.65, cw - 0.75, alt(v, 24, cw - 0.75, True), v, 24,
                      G.GS_AZUL_CLA if r == 'MANDATO' else G.TXT, True)
            yy += hrow + GAP
        if c['cand']:
            col = 2 if len(c['cand']) > 4 else 1
            por = math.ceil(len(c['cand']) / col)
            hcand = min(BASE - yy, 0.75 + por * (lh(20, True) + 0.1) + 0.2)
            cartao(s, X0, yy, W, hcand, G.CARD2)
            G.text(s, X0 + 0.4, yy + 0.22, 4, 0.3, 'CANDIDATOS', 14, G.AMBER, True)
            for k, nm in enumerate(c['cand']):
                cc, li = divmod(k, por)
                G.text(s, X0 + 0.4 + cc * 6.1, yy + 0.65 + li * (lh(20, True) + 0.1), 5.8, lh(20, True), nm,
                       ajusta(nm, 5.8, 20, True, MIN_PT), G.TXT, True)
        else:
            cartao(s, X0, yy, W, 0.75, G.CARD2)
            G.text(s, X0 + 0.4, yy, W - 0.8, 0.75, 'Candidaturas apresentadas na própria assembleia.', 17, G.TXT2,
                   anchor=MSO_ANCHOR.MIDDLE)
        return
    tw_esq = 5.6
    tw_dir = W - tw_esq - 1.2

    def h_cargo(c, t):
        esq = alt(c['cargo'], t + 2, tw_esq, True) + (0.12 + alt('Mandato: ' + c['mandato'], t - 2, tw_esq) if c['mandato'] else 0)
        cand = ', '.join(c['cand']) if c['cand'] else 'Candidaturas na assembleia'
        dir_ = 0.4 + alt(cand, t, tw_dir, True) + (0.12 + alt(c['obs'], t - 3, tw_dir) if c['obs'] else 0)
        return max(esq, dir_) + 0.5

    disp = BASE - 1.75
    size = _maior_que_cabe(range(20, 16, -1), lambda t: sum(h_cargo(c, t) for c in cargos) + GAP * (len(cargos) - 1) <= disp) or 17
    hs = [h_cargo(c, size) for c in cargos]
    for pi, idxs in enumerate(_agrupar(hs, disp, GAP)):
        s = ctx.novo()
        y = cabecalho(ctx, s, sl, titulo, None, cont=pi > 0, kicker=kick)
        for i in idxs:
            c, h = cargos[i], hs[i]
            cartao(s, X0, y, W, h)
            G.rect(s, X0, y, 0.12, h, G.AMBER)
            hc = alt(c['cargo'], size + 2, tw_esq, True)
            caixa(s, X0 + 0.4, y + 0.25, tw_esq, hc, c['cargo'], size + 2, G.TXT, True)
            if c['mandato']:
                m = f'Mandato: {c["mandato"]}'
                caixa(s, X0 + 0.4, y + 0.25 + hc + 0.12, tw_esq, alt(m, size - 2, tw_esq), m, size - 2, G.GS_AZUL_CLA)
            xd = X0 + tw_esq + 0.8
            G.text(s, xd, y + 0.25, tw_dir, 0.3, 'CANDIDATOS', 14, G.TXT3, True)
            cand = ', '.join(c['cand']) if c['cand'] else 'Candidaturas na assembleia'
            hcd = alt(cand, size, tw_dir, True)
            caixa(s, xd, y + 0.6, tw_dir, hcd, cand, size, G.TXT if c['cand'] else G.TXT2, True)
            if c['obs']:
                caixa(s, xd, y + 0.6 + hcd + 0.12, tw_dir, alt(c['obs'], size - 3, tw_dir), c['obs'], size - 3, G.AMBER)
            y += h + GAP


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
        y = cabecalho(ctx, s, sl, sl.get('titulo') or 'Linha do tempo', sl.get('subtitulo') if pi == 0 else None, cont=pi > 0)
        if len(grupo) <= 4:
            _tempo_horizontal(s, grupo, y)
        else:
            _tempo_vertical(s, grupo, y)


def _tempo_horizontal(s, grupo, y):
    """Linha horizontal com marcadores e um cartão por evento embaixo."""
    n = len(grupo)
    cw = (W - GAP * (n - 1)) / n
    yl = y + 0.5
    if n > 1:
        G.rect(s, X0 + cw / 2, yl - 0.03, W - cw, 0.06, G.GS_AZUL)
    tw = cw - 0.6
    hc = BASE - (yl + 0.55)

    def h_ev(t, ev):
        d, ti, tx = ev
        return 0.3 + (lh(16, True) + 0.1 if d else 0) + alt_tit_desc(ti, t + 3, tx, t, tw, 0.15) + 0.3
    ts = _maior_que_cabe(range(19, MIN_PT - 1, -1), lambda t: all(h_ev(t, e) <= hc for e in grupo)) or MIN_PT
    hreal = min(hc, max(max(h_ev(ts, e) for e in grupo) + 0.3, 2.2))
    for i, (d, ti, tx) in enumerate(grupo):
        x = X0 + i * (cw + GAP)
        cx = x + cw / 2
        ult = i == n - 1
        oval(s, cx - 0.22, yl - 0.22, 0.44, G.AMBER if ult else G.BG, G.AMBER if ult else G.GS_AZUL_CLA, 3)
        G.rect(s, cx - 0.015, yl + 0.22, 0.03, 0.33, G.LINE)
        yc = yl + 0.55
        cartao(s, x, yc, cw, hreal)
        G.rect(s, x, yc, cw, 0.08, G.AMBER if ult else G.GS_AZUL_CLA)
        yy = yc + 0.3
        if d:
            G.text(s, x + 0.3, yy, tw, lh(16, True), d.upper(), ajusta(d.upper(), tw, 16, True, MIN_PT),
                   G.AMBER if ult else G.GS_AZUL_CLA, True)
            yy += lh(16, True) + 0.1
        tit_desc(s, x + 0.3, yy, tw, ti, ts + 3, tx, ts, gap=0.15)


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
        oval(s, cxl - 0.18, yy + h / 2 - 0.18, 0.36, G.AMBER if ult else G.BG, G.AMBER if ult else G.GS_AZUL_CLA, 3)
        cartao(s, xd, yy, X0 + W - xd, h)
        if d:
            G.text(s, xd + 0.25, yy, wd - 0.2, h, d.upper(), ajusta(d.upper(), wd - 0.3, 17, True, MIN_PT),
                   G.AMBER if ult else G.GS_AZUL_CLA, True, anchor=MSO_ANCHOR.MIDDLE)
        partes = ([[(ti, ts + 2, True, G.TXT)]] if ti else []) + ([[(tx, ts - 1, False, G.TXT2)]] if tx else [])
        if partes:
            caixa(s, xt, yy, tw, h, partes, ts, anchor=MSO_ANCHOR.MIDDLE, espaco=0.06)
        yy += h + 0.12


TIPOS = {
    'capa': s_capa, 'orientacoes': s_orientacoes, 'pauta': s_pauta, 'item': s_item, 'texto': s_texto,
    'topicos': s_topicos, 'colunas': s_colunas, 'orcamento': s_orcamento, 'comparativo': s_comparativo,
    'tabela': s_tabela, 'numeros': s_numeros, 'barras': s_barras, 'cards': s_cards, 'passos': s_passos,
    'pontos': s_pontos, 'fotos': s_fotos, 'foto_texto': s_foto_texto, 'antes_depois': s_antes_depois,
    'documento': s_documento, 'regimento': s_regimento, 'custeio': s_custeio, 'votacao': s_votacao,
    'eleicao': s_eleicao, 'linha_do_tempo': s_linha_do_tempo, 'encerramento': s_encerramento,
}
SINONIMOS = {'cartoes': 'cards', 'galeria': 'fotos', 'linha_tempo': 'linha_do_tempo', 'cronograma': 'linha_do_tempo',
             'etapas': 'passos', 'orientacao': 'orientacoes', 'divisor': 'item'}


def _tipo(v) -> str:
    t = re.sub(r'[\s\-]+', '_', _sem_acento(str(v or '')).strip())
    return SINONIMOS.get(t, t)


# ───────────────────────── varredura final e auditoria ─────────────────────────

def varrer_tracos(prs) -> int:
    """Troca hífen e travessão usados como pontuação por vírgula em todo texto dos slides."""
    trocas = 0
    for slide in prs.slides:
        for sh in slide.shapes:
            if not sh.has_text_frame:
                continue
            for p in sh.text_frame.paragraphs:
                for r in p.runs:
                    if r.text and _TRACO.search(r.text):
                        r.text = re.sub(r'\s+,', ',', _TRACO.sub(', ', r.text))
                        trocas += 1
    return trocas


def auditar(pptx_path: str, pasta: str) -> list[str]:
    """Auditoria visual da skill (sobreposição de textos e texto saindo do slide).
    Elementos decorativos marcados com nome "decor_" (o número gigante do divisor,
    que fica atrás do título de propósito) saem da cópia auditada."""
    try:
        prs = Presentation(pptx_path)
        for slide in prs.slides:
            for sh in list(slide.shapes):
                if (sh.name or '').startswith('decor_'):
                    sh._element.getparent().remove(sh._element)
        copia = os.path.join(pasta, 'auditoria.pptx')
        prs.save(copia)
        problemas, _ = AUD.auditar(copia)
    except Exception as e:  # auditoria nunca derruba a entrega
        print(f'[prestacao-pdf] apresentacao_auditoria_falhou erro={type(e).__name__}', file=sys.stderr, flush=True)
        return []
    nomes = {'overflow': 'texto saindo da área do slide', 'sobreposicao': 'textos sobrepostos',
             'grafico_coberto': 'gráfico coberto por outro elemento'}
    return [f'Página {p["slide"]} da apresentação: {nomes.get(p["tipo"], p["tipo"])} ({p.get("texto", "")}). Confira.'
            for p in problemas]


# ───────────────────────── montagem ─────────────────────────

def desenhar(roteiro: dict, fotos: dict, documentos: dict, pasta: str, logo_cliente: bytes | None = None):
    """Monta só o PPTX. Devolve (Presentation, avisos)."""
    ctx = _desenhar(roteiro, fotos, documentos, pasta, logo_cliente)
    return ctx.prs, ctx.avisos


def _desenhar(roteiro, fotos, documentos, pasta, logo_cliente=None, paginas=None, graficos=None) -> Ctx:
    logo, avisos_logo = None, []
    if logo_cliente:
        try:
            logo = Logo(logo_cliente, pasta)
        except Exception:
            avisos_logo.append('A logo do cliente não é uma imagem válida; a apresentação saiu sem ela.')
    ctx = Ctx(fotos, documentos, pasta, logo, paginas, graficos)
    ctx.avisos.extend(avisos_logo)
    slides = roteiro.get('slides') if isinstance(roteiro, dict) else None
    if not isinstance(slides, list) or not slides:
        raise ErroPrestacao('O roteiro não tem slides.')
    validos = [sl for sl in slides if isinstance(sl, dict)]
    capa = next((sl for sl in validos if _tipo(sl.get('tipo')) == 'capa'), None)
    if capa:
        ctx.capa = capa
        ctx.rodape = '  ·  '.join(['Grupo Service'] + [t for t in (_limpa(capa.get('condominio')), _limpa(capa.get('data'))) if t])
    else:
        ctx.aviso('o roteiro não tem capa; o rodapé saiu sem o nome do condomínio e a data.')
    # Pauta: total de itens (M do "item N de M"), etiquetas e títulos curtos para os cabeçalhos.
    pauta = next((sl for sl in validos if _tipo(sl.get('tipo')) == 'pauta'), None)
    if pauta:
        for i, (t, e, _) in enumerate(_itens_pauta(pauta), start=1):
            ctx.titulos_pauta[str(i)] = t
            if e:
                ctx.etiquetas[str(i)] = e
    nums = [int(n) for n in (_numero_item(sl) for sl in validos if _tipo(sl.get('tipo')) == 'item') if n and n.isdigit()]
    ctx.total_itens = max([len(ctx.titulos_pauta)] + nums)
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
    varrer_tracos(ctx.prs)
    return ctx


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


def montar(roteiro: dict, fotos: dict, documentos: dict, pasta: str, logo_cliente: bytes | None = None,
           paginas: dict | None = None, graficos: dict | None = None):
    """Devolve (bytes_pptx, bytes_pdf, avisos, n_slides). Os avisos do próprio roteiro
    (campo "avisos" no topo, escritos pela IA) vêm primeiro, depois os do motor e os da auditoria.
    paginas e graficos só vêm no modo atualizar (ver Ctx). O roteiro usado vai dentro do PPTX."""
    os.makedirs(pasta, exist_ok=True)
    avisos = [f'Roteiro: {a}' for a in _lista(roteiro.get('avisos'))] if isinstance(roteiro, dict) else []
    ctx = _desenhar(roteiro, fotos or {}, documentos or {}, pasta, logo_cliente, paginas, graficos)
    avisos += ctx.avisos
    embutir(ctx, roteiro, logo_cliente)
    prs = ctx.prs
    pptx_path = os.path.join(pasta, 'apresentacao.pptx')
    prs.save(pptx_path)
    avisos += auditar(pptx_path, pasta)
    pdf = converter_pdf(pptx_path, pasta)
    return Path(pptx_path).read_bytes(), pdf, avisos, len(prs.slides)


# ───────────────────────── apresentação autossuficiente (modo atualizar) ─────────────────────────
# O PPTX leva dentro, numa parte de dados do próprio pacote (customXml, que o PowerPoint guarda
# ao salvar), o roteiro usado, quantas páginas cada documento tinha, como cada foto foi mostrada,
# a logo original do cliente e uma impressão dos textos. As imagens ficam nas formas com nome
# rastreável ("foto:f3", "doc:d1:p2", "logo_cliente"). Com só o arquivo dá para refazer tudo.

NS_AP = 'urn:servicezone:apresentacao:1'
CT_ITEM_PROPS = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml'
MAX_META = 40 * 1024 * 1024        # parte de dados (roteiro e logo)
MAX_DESCOMPACTADO = 400 * 1024 * 1024
MAX_IMAGEM_LIDA = 30 * 1024 * 1024
_RE_DOC = re.compile(r'^doc:(.+):p(\d{1,4})$')


class SemRoteiro(Exception):
    """PPTX que não foi gerado pelo sistema (ou gerado antes do modo atualizar)."""


def impressao_textos(prs) -> str:
    """Impressão dos textos de todos os slides: se mudar, alguém editou o arquivo à mão."""
    partes = []
    for slide in prs.slides:
        partes.append('\x1f'.join(sh.text_frame.text for sh in _formas(slide.shapes) if sh.has_text_frame))
    return hashlib.sha1('\x1e'.join(partes).encode('utf-8')).hexdigest()


def _formas(shapes):
    for sh in shapes:
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from _formas(sh.shapes)
        else:
            yield sh


def embutir(ctx: Ctx, roteiro: dict, logo_cliente: bytes | None):

    rot = {k: v for k, v in roteiro.items() if k != 'avisos'}
    meta = {
        'versao': 1, 'roteiro': rot,
        'documentos': {d: {'paginas': info[1]} for d, info in ctx._docs_ok.items() if info},
        'fotos': {f: {'grafico': bool(im.grafico)} for f, im in ctx._fotos_ok.items() if im},
        'logo_cliente_b64': base64.b64encode(logo_cliente).decode('ascii') if (logo_cliente and ctx.logo) else None,
        'impressao': impressao_textos(ctx.prs),
    }
    raiz = etree.Element(f'{{{NS_AP}}}apresentacao', nsmap={'ap': NS_AP})
    raiz.set('versao', '1')
    # ensure_ascii: o texto fica só com caracteres que o XML aceita.
    raiz.text = json.dumps(meta, ensure_ascii=True)
    usados = {str(p.partname) for p in ctx.prs.part.package.iter_parts()}
    n = 1
    while f'/customXml/item{n}.xml' in usados:
        n += 1
    pacote = ctx.prs.part.package
    item = Part.load(PackURI(f'/customXml/item{n}.xml'), 'application/xml', pacote,
                     etree.tostring(raiz, xml_declaration=True, encoding='UTF-8', standalone=True))
    props = ('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
             f'<ds:datastoreItem ds:itemID="{{{str(uuid.uuid4()).upper()}}}" '
             'xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml">'
             f'<ds:schemaRefs><ds:schemaRef ds:uri="{NS_AP}"/></ds:schemaRefs></ds:datastoreItem>').encode('utf-8')
    item_props = Part.load(PackURI(f'/customXml/itemProps{n}.xml'), CT_ITEM_PROPS, pacote, props)
    item.relate_to(item_props, RT.CUSTOM_XML_PROPS)
    ctx.prs.part.relate_to(item, RT.CUSTOM_XML)


def ler(dado: bytes) -> dict:
    """Do PPTX gerado aqui: roteiro, fotos, páginas de documento e logo originais.
    Levanta SemRoteiro se o arquivo não for uma apresentação do sistema."""

    try:
        zf = zipfile.ZipFile(io.BytesIO(dado))
        infos = zf.infolist()
    except Exception:
        raise SemRoteiro('arquivo não é um PowerPoint')
    if sum(i.file_size for i in infos) > MAX_DESCOMPACTADO:
        raise SemRoteiro('arquivo grande demais depois de aberto')
    meta = None
    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True)
    for info in infos:
        if not re.fullmatch(r'customXml/item\d+\.xml', info.filename) or info.file_size > MAX_META:
            continue
        try:
            raiz = etree.fromstring(zf.read(info), parser)
            if raiz.tag == f'{{{NS_AP}}}apresentacao':
                meta = json.loads(raiz.text or '')
                break
        except Exception:
            continue
    rot = meta.get('roteiro') if isinstance(meta, dict) else None
    if not isinstance(rot, dict) or not isinstance(rot.get('slides'), list) or not rot['slides']:
        raise SemRoteiro('sem roteiro')
    try:
        prs = Presentation(io.BytesIO(dado))
    except Exception:
        raise SemRoteiro('o PowerPoint não abre')

    fotos, paginas, logo_forma = {}, {}, None
    for slide in prs.slides:
        for sh in _formas(slide.shapes):
            if sh.shape_type != MSO_SHAPE_TYPE.PICTURE:
                continue
            nome = sh.name or ''
            if not (nome.startswith('foto:') or nome.startswith('doc:') or nome == 'logo_cliente'):
                continue
            try:
                blob = sh.image.blob
            except Exception:
                continue
            if not blob or len(blob) > MAX_IMAGEM_LIDA:
                continue
            if nome.startswith('foto:'):
                fotos.setdefault(nome[5:], blob)
            elif nome == 'logo_cliente':
                logo_forma = logo_forma or blob
            else:
                m = _RE_DOC.match(nome)
                if m:
                    paginas.setdefault((m.group(1), int(m.group(2))), blob)
    docs = meta.get('documentos') if isinstance(meta.get('documentos'), dict) else {}
    grafs = meta.get('fotos') if isinstance(meta.get('fotos'), dict) else {}
    b64 = lambda b: base64.b64encode(b).decode('ascii')  # noqa: E731
    logo = meta.get('logo_cliente_b64') if isinstance(meta.get('logo_cliente_b64'), str) else None
    if logo is None and logo_forma:
        logo = b64(logo_forma)
    total_de = lambda d, p: (_inteiro((docs.get(d) or {}).get('paginas')) if isinstance(docs.get(d), dict) else None) or p  # noqa: E731
    return {
        'roteiro': rot,
        'fotos': [dict({'id': f, 'b64': b64(b)}, **({'grafico': grafs[f]['grafico']} if isinstance(grafs.get(f), dict)
                                                     and isinstance(grafs[f].get('grafico'), bool) else {}))
                  for f, b in fotos.items()],
        'documentos_paginas': [{'id': d, 'pagina': p, 'total': total_de(d, p), 'b64': b64(b)}
                               for (d, p), b in sorted(paginas.items())],
        'logo_cliente_b64': logo,
        'alterada': bool(meta.get('impressao')) and meta.get('impressao') != impressao_textos(prs),
    }
