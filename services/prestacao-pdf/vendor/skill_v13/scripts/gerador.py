# -*- coding: utf-8 -*-
"""
Gerador da prestacao de contas, padrao v13 (projetor + identidade Grupo Service).
NAO alterar paleta, fontes, tamanhos ou layout: e o molde aprovado em 20/10/2026.

Mesma sequencia do molde (capa, visao geral, evolucao, patrimonio, resultado
mensal, origem da receita, estrutura de despesas, detalhamentos, encerramento),
com tres mudancas:
  1. Tema escuro de alto contraste em todos os slides (texto branco sobre navy
     quase preto), pensado para projetor fraco em sala clara.
  2. Tipografia de leitura a distancia: nada abaixo de 14pt, numeros grandes.
  3. Detalhamento por rubrica com a COMPOSICAO de cada uma (o que foi comprado
     ou contratado), vinda do relatorio detalhado W015A.
"""
import re, os
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION
from pptx.oxml.ns import qn

MES_UP = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ']

def rgb(h): h = h.lstrip('#'); return RGBColor(int(h[0:2],16), int(h[2:4],16), int(h[4:6],16))

# ---------------- PALETA (fundo escuro, alto contraste) ----------------
# Identidade Grupo Service, modo Impacto em todos os slides (grafite profundo),
# com as cores de destaque da prestacao mantidas para leitura no projetor.
BG      = rgb('262227')   # grafite profundo da marca
CARD    = rgb('332E34')   # cartoes
CARD2   = rgb('3E383F')   # cartao realce
LINE    = rgb('4F484F')
TXT     = rgb('FFFFFF')
TXT2    = rgb('E4DFE3')   # texto de apoio
TXT3    = rgb('B5ADB3')   # rotulos
GS_AZUL = rgb('2E8CBC')   # azul Grupo Service
GS_AZUL_CLA = rgb('63ABCF')
AMBER   = rgb('4FD1F5')   # DESTAQUE: azul celeste vivo (substituiu o laranja em 20/10/2026). Nome mantido por compatibilidade
GREEN   = rgb('3EE08F')
RED     = rgb('FF7A7A')
BLUE    = GS_AZUL_CLA     # destaque de titulo = azul claro da marca
DARKTXT = rgb('262227')
FONT = "Inter"            # corpo
FONT_T = "Poppins"        # titulos e numeros (todo texto em negrito)
AQUI = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(AQUI, '..', 'assets')
LOGO_GS = os.path.join(ASSETS, 'logo_gs_branca.png')
FONTES = os.path.join(ASSETS, 'fonts')

_ANCH = ['3EE08F','2DD4BF','63ABCF','2E8CBC','5B8DEF','8E9BF5','B3A8E0','BDB5BB']
def cat_colors(n):
    a = [tuple(int(h[i:i+2],16) for i in (0,2,4)) for h in _ANCH]
    if n <= 1: return [RGBColor(*a[0])]
    out = []
    for i in range(n):
        pos = i/(n-1)*(len(a)-1); lo = int(pos); hi = min(lo+1, len(a)-1); f = pos-lo
        out.append(RGBColor(*[int(a[lo][k]+(a[hi][k]-a[lo][k])*f) for k in range(3)]))
    return out

# ---------------- FORMATACAO BR ----------------
def brl(v):  return "R$ " + f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
def brl0(v): return "R$ " + f"{v:,.0f}".replace(",", ".")
def brl_acc(v): return "(" + brl(abs(v)) + ")" if v < 0 else brl(v)
def pct(v):  return f"{v:.1f}".replace(".", ",") + "%"
def pct_sig(v): return ("+" if v >= 0 else "-") + f"{abs(v):.1f}".replace(".", ",") + "%"

# ---------------- PRIMITIVAS ----------------
prs = None; BLANK = None; CFG = None; PAG = [0]

def rect(s, x, y, w, h, fill, rounded=False, corner=0.06, line=None):
    sh = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE,
                            Inches(x), Inches(y), Inches(w), Inches(h))
    if rounded: sh.adjustments[0] = corner
    sh.fill.solid(); sh.fill.fore_color.rgb = fill
    if line is None: sh.line.fill.background()
    else: sh.line.color.rgb = line; sh.line.width = Pt(1)
    sh.shadow.inherit = False
    return sh

def text(s, x, y, w, h, t, size, color=TXT, bold=False, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h)); tf = tb.text_frame
    tf.word_wrap = True; tf.vertical_anchor = anchor
    for m in ('margin_left','margin_right','margin_top','margin_bottom'): setattr(tf, m, Emu(0))
    p = tf.paragraphs[0]; p.alignment = align
    r = p.add_run(); r.text = t
    r.font.name = FONT_T if bold else FONT; r.font.size = Pt(size); r.font.bold = bold; r.font.color.rgb = color
    return tb

def runs(s, x, y, w, h, parts, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h)); tf = tb.text_frame
    tf.word_wrap = True; tf.vertical_anchor = anchor
    for m in ('margin_left','margin_right','margin_top','margin_bottom'): setattr(tf, m, Emu(0))
    p = tf.paragraphs[0]; p.alignment = align
    for t, size, bold, color in parts:
        r = p.add_run(); r.text = t
        r.font.name = FONT_T if bold else FONT; r.font.size = Pt(size); r.font.bold = bold; r.font.color.rgb = color
    return tb

def txt_sobre(c):
    l = 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]
    return DARKTXT if l > 140 else TXT

def ajusta(t, w, size, bold=True, minimo=16):
    while size > minimo and largura(t, size, bold) > w * 0.96: size -= 1
    return size

def hline(s, x1, y, x2, color, weight=1.5):
    ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y), Inches(x2), Inches(y))
    ln.line.color.rgb = color; ln.line.width = Pt(weight)

def novo_slide():
    s = prs.slides.add_slide(BLANK)
    bg = s.background.fill; bg.solid(); bg.fore_color.rgb = BG
    PAG[0] += 1
    return s

def rodape(s):
    t = f"{CFG['rodape']}    •    EXERCÍCIO {CFG['periodo_label']}"
    text(s, 0.5, 7.1, 9.0, 0.3, t, 12, TXT3)
    s.shapes.add_picture(LOGO_GS, Inches(11.05), Inches(7.04), height=Inches(0.32))
    text(s, 12.35, 7.1, 0.48, 0.3, str(PAG[0]), 12, TXT3, align=PP_ALIGN.RIGHT)

def cabecalho(s, secao, t1, t2=None, sub=None):
    text(s, 0.5, 0.3, 9.5, 0.35, secao, 14, GS_AZUL_CLA, True)
    parts = [(t1, 34, True, TXT)]
    if t2: parts.append((" " + t2, 34, True, BLUE))
    runs(s, 0.5, 0.6, 12.3, 0.75, parts)
    hline(s, 0.5, 1.35, 1.05, GS_AZUL, 3)
    if sub: text(s, 0.5, 1.45, 12.3, 0.45, sub, 17, TXT2)

def estilo_grafico(ch, size=14):
    ch.font.name = FONT; ch.font.size = Pt(size); ch.font.color.rgb = TXT2
    for ax in (ch.category_axis, ch.value_axis):
        try:
            ax.tick_labels.font.size = Pt(size); ax.tick_labels.font.color.rgb = TXT2
            ax.tick_labels.font.name = FONT
            ax.format.line.color.rgb = LINE
        except Exception: pass
    try:
        ch.value_axis.has_major_gridlines = True
        ch.value_axis.major_gridlines.format.line.color.rgb = rgb('22365A')
        ch.value_axis.major_gridlines.format.line.width = Pt(0.75)
        ch.value_axis.tick_labels.number_format = '0,"k"'
        ch.value_axis.tick_labels.number_format_is_linked = False
    except Exception: pass

def kpi(s, x, y, w, h, label, valor, sub, cor, vsize=38):
    rect(s, x, y, w, h, CARD, True, 0.06)
    rect(s, x, y, 0.12, h, cor)
    text(s, x+0.35, y+0.18, w-0.5, 0.35, label, 14, TXT3, True)
    text(s, x+0.35, y+0.55, w-0.5, 0.7, valor, ajusta(valor, w-0.5, vsize), cor, True)
    if sub: text(s, x+0.35, y+h-0.42, w-0.5, 0.33, sub, 16, TXT2)

# ---------------- DERIVADOS E VALIDACAO ----------------
def derivar(c):
    d = {}
    d['rec'] = c['receita_total']; d['desp'] = c['despesa_total']
    d['res'] = d['rec'] - d['desp']; d['ini'] = c['saldo_anterior']; d['fim'] = c['saldo_final']
    d['cob'] = d['rec']/d['desp']*100; d['marg'] = d['res']/d['rec']*100
    d['cresc'] = (d['fim']-d['ini'])/d['ini']*100
    d['sup'] = [r-x for r, x in zip(c['receitas_mes'], c['despesas_mes'])]
    d['pos'] = sum(1 for v in d['sup'] if v > 0)
    T = 0.02
    assert abs(d['ini'] + d['res'] + c.get('ajuste_saldo', 0) - d['fim']) < T, "caixa"
    assert abs(sum(v for _, v in c['receitas_cat']) - d['rec']) < T, "soma receitas"
    assert abs(sum(cat['total'] for cat in c['despesas']) - d['desp']) < T, "soma despesas"
    assert abs(sum(c['receitas_mes']) - d['rec']) < T and abs(sum(c['despesas_mes']) - d['desp']) < T, "serie"
    assert abs(c['saldo_fim_mes'][-1] - d['fim']) < T, "saldo final"
    for cat in c['despesas']:
        s_ = sum(r['valor'] for r in cat['rubricas'])
        assert abs(s_ - cat['total']) < T, f"rubricas de {cat['nome']}: {s_:.2f} x {cat['total']:.2f}"
        for r in cat['rubricas']:
            if r.get('fecha'):
                vals = [float(v.replace('.', '').replace(',', '.')) for v in re.findall(r'R\$ ([\d.]+,\d{2})', r['comp'])]
                assert abs(sum(vals) - r['valor']) < T, f"composicao de {r['nome']}: {sum(vals):.2f} x {r['valor']:.2f}"
    return d

# ---------------- SLIDES ----------------
def s_capa():
    s = novo_slide()
    rect(s, 0, 0, 13.333, 0.083, GS_AZUL)                       # barra azul de 8px do modo Impacto
    s.shapes.add_picture(LOGO_GS, Inches(0.94), Inches(0.75), height=Inches(0.95))
    text(s, 0.94, 2.35, 8, 0.45, "PRESTAÇÃO DE CONTAS", 18, GS_AZUL_CLA, True)
    runs(s, 0.94, 2.8, 7.6, 1.0, [(CFG['cliente_linha1'] + " ", 54, True, TXT), (CFG['cliente_linha2'], 54, True, GS_AZUL_CLA)])
    hline(s, 0.94, 4.05, 1.9, GS_AZUL, 4)
    text(s, 0.94, 4.3, 7.6, 0.6, CFG['exercicio_titulo'], 28, TXT, True)
    text(s, 0.94, 4.95, 7.6, 0.5, CFG['periodo_extenso'] + "\nApresentação em Assembleia", 19, TXT2)
    rect(s, 0.94, 6.45, 11.45, 0.012, LINE)
    text(s, 0.94, 6.62, 11.45, 0.4, "Contábil Service    •    Condomínio Service    •    RH Service", 15, TXT3)
    # bloco de destaque (split): onde o caixa terminou
    D = derivar(CFG)
    x, y, w, h = 8.75, 2.35, 3.64, 2.85
    rect(s, x, y, w, h, CARD, True, 0.06); rect(s, x, y, 0.12, h, GS_AZUL)
    text(s, x+0.38, y+0.25, w-0.55, 0.3, f"SALDO EM CAIXA EM {CFG['data_final']}", 12, TXT3, True)
    v = brl(D['fim'])
    text(s, x+0.38, y+0.6, w-0.55, 0.6, v, ajusta(v, w-0.55, 28), GS_AZUL_CLA, True)
    text(s, x+0.38, y+1.3, w-0.55, 0.3, "CRESCIMENTO NO PERÍODO", 12, TXT3, True)
    text(s, x+0.38, y+1.62, w-0.55, 0.7, pct_sig(D['cresc']), 40, AMBER, True)
    text(s, x+0.38, y+2.35, w-0.55, 0.35, f"de {brl0(D['ini'])} para {brl0(D['fim'])}", 13, TXT2)

def s_visao(D):
    s = novo_slide()
    cabecalho(s, "01  •  VISÃO GERAL", "Resultado consolidado", "do exercício")
    w3 = (12.33 - 0.4)/3; y1 = 1.75; h = 1.6
    for i, (l, v, sb, c) in enumerate([
            ("SALDO INICIAL", brl(D['ini']), f"em {CFG['data_inicial']}", BLUE),
            ("RECEITA TOTAL", brl(D['rec']), f"{CFG['n_meses']} meses", GREEN),
            ("DESPESA TOTAL", brl(D['desp']), f"{CFG['n_meses']} meses", TXT2)]):
        kpi(s, 0.5 + i*(w3+0.2), y1, w3, h, l, v, sb, c, 34)
    w2 = (12.33 - 0.2)/2; y2 = y1 + h + 0.2
    lab = "SUPERÁVIT DO PERÍODO" if D['res'] >= 0 else "DÉFICIT DO PERÍODO"
    kpi(s, 0.5, y2, w2, h, lab, brl(abs(D['res'])), f"{'Margem' if D['res']>=0 else 'Déficit'} de {pct(abs(D['marg']))} sobre a receita",
        GREEN if D['res'] >= 0 else RED, 36)
    kpi(s, 0.5+w2+0.2, y2, w2, h, "SALDO FINAL", brl(D['fim']), f"em caixa em {CFG['data_final']}", AMBER, 36)
    y3 = y2 + h + 0.2; hb = 6.9 - y3
    rect(s, 0.5, y3, 12.33, hb, AMBER, True, 0.08)
    pw = 12.33/3
    pil = [("RECEITA COBRIU", pct(D['cob']), "da despesa"),
           ("O CAIXA CRESCEU" if D['cresc'] >= 0 else "O CAIXA VARIOU", pct_sig(D['cresc']), "no período"),
           ("MESES POSITIVOS", f"{D['pos']} de {CFG['n_meses']}", "com superávit")]
    for i, (a, b, c) in enumerate(pil):
        x = 0.5 + i*pw
        text(s, x, y3+0.14, pw, 0.35, a, 14, DARKTXT, True, PP_ALIGN.CENTER)
        text(s, x, y3+0.42, pw, 0.7, b, 36, DARKTXT, True, PP_ALIGN.CENTER)
        if i < 2:
            ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x+pw), Inches(y3+0.2), Inches(x+pw), Inches(y3+hb-0.2))
            ln.line.color.rgb = DARKTXT; ln.line.width = Pt(1)
    rodape(s)

def s_evolucao(D):
    s = novo_slide()
    cabecalho(s, "02  •  EVOLUÇÃO MENSAL", "Receitas e despesas", "mês a mês")
    runs(s, 0.5, 1.5, 8, 0.4, [("■ ", 20, True, GREEN), ("Receitas     ", 18, True, TXT),
                                ("■ ", 20, True, BLUE), ("Despesas", 18, True, TXT)])
    cd = CategoryChartData(); cd.categories = CFG['meses_label']
    cd.add_series("Receitas", CFG['receitas_mes']); cd.add_series("Despesas", CFG['despesas_mes'])
    gx = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.4), Inches(1.95), Inches(12.5), Inches(3.75), cd)
    ch = gx.chart; ch.has_title = False; ch.has_legend = False
    for i, c in enumerate((GREEN, BLUE)):
        sr = ch.plots[0].series[i]; sr.format.fill.solid(); sr.format.fill.fore_color.rgb = c; sr.format.line.fill.background()
    ch.plots[0].gap_width = 60
    estilo_grafico(ch, 15)
    n = CFG['n_meses']; mr = D['rec']/n; md = D['desp']/n
    w3 = (12.33-0.4)/3
    for i, (l, v, c) in enumerate([("MÉDIA MENSAL DE RECEITA", brl(mr), GREEN), ("MÉDIA MENSAL DE DESPESA", brl(md), BLUE),
                                   ("SOBRA MÉDIA MENSAL" if mr >= md else "DÉFICIT MÉDIO MENSAL", brl(abs(mr-md)), AMBER)]):
        x = 0.5 + i*(w3+0.2)
        rect(s, x, 5.85, w3, 1.1, CARD, True, 0.08); rect(s, x, 5.85, 0.12, 1.1, c)
        text(s, x+0.35, 5.95, w3-0.5, 0.3, l, 13, TXT3, True)
        text(s, x+0.35, 6.27, w3-0.5, 0.6, v, ajusta(v, w3-0.5, 26), c, True)
    rodape(s)

def s_patrimonio(D):
    s = novo_slide()
    cabecalho(s, "03  •  PATRIMÔNIO", "Evolução do saldo", "em caixa",
              f"De {brl(D['ini'])} em {CFG['data_inicial']} para {brl(D['fim'])} em {CFG['data_final']}")
    cd = CategoryChartData(); cd.categories = CFG['meses_label']; cd.add_series("Saldo", CFG['saldo_fim_mes'])
    gx = s.shapes.add_chart(XL_CHART_TYPE.LINE_MARKERS, Inches(0.4), Inches(2.05), Inches(8.4), Inches(4.85), cd)
    ch = gx.chart; ch.has_title = False; ch.has_legend = False
    sr = ch.plots[0].series[0]; sr.format.line.color.rgb = AMBER; sr.format.line.width = Pt(5)
    sr.smooth = False
    try:
        sr.marker.style = 8; sr.marker.size = 9
        sr.marker.format.fill.solid(); sr.marker.format.fill.fore_color.rgb = AMBER
        sr.marker.format.line.color.rgb = AMBER
    except Exception: pass
    estilo_grafico(ch, 15)
    ch.category_axis.tick_labels.font.size = Pt(13)
    x = 9.1; w = 3.73
    rect(s, x, 2.05, w, 1.85, AMBER, True, 0.08)
    text(s, x+0.3, 2.2, w-0.5, 0.35, "CRESCIMENTO NO PERÍODO" if D['cresc'] >= 0 else "VARIAÇÃO NO PERÍODO", 14, DARKTXT, True)
    text(s, x+0.3, 2.6, w-0.5, 1.0, pct_sig(D['cresc']), 46, DARKTXT, True)
    for i, (l, v, c) in enumerate([(f"SALDO INICIAL ({CFG['meses_label'][0].upper()})", brl(D['ini']), BLUE),
                                   (f"SALDO FINAL ({CFG['meses_label'][-1].upper()})", brl(D['fim']), AMBER),
                                   ("SUPERÁVIT DO PERÍODO" if D['res'] >= 0 else "DÉFICIT DO PERÍODO", brl(abs(D['res'])), GREEN if D['res'] >= 0 else RED)]):
        y = 4.1 + i*0.95
        rect(s, x, y, w, 0.85, CARD, True, 0.08); rect(s, x, y, 0.1, 0.85, c)
        text(s, x+0.3, y+0.08, w-0.4, 0.3, l, 12, TXT3, True)
        text(s, x+0.3, y+0.36, w-0.4, 0.45, v, ajusta(v, w-0.4, 22), c, True)
    rodape(s)

def s_resultado(D):
    s = novo_slide()
    cabecalho(s, "04  •  RESULTADO LÍQUIDO", "Resultado", "de cada mês", "Receitas menos despesas, mês a mês")
    cd = CategoryChartData(); cd.categories = CFG['meses_label']; cd.add_series("Resultado", D['sup'])
    gx = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.4), Inches(2.05), Inches(8.4), Inches(4.85), cd)
    ch = gx.chart; ch.has_title = False; ch.has_legend = False
    sr = ch.plots[0].series[0]; sr.format.fill.solid(); sr.format.fill.fore_color.rgb = GREEN; sr.format.line.fill.background()
    sr.invert_if_negative = False
    for idx, v in enumerate(D['sup']):
        if v < 0:
            pt = sr.points[idx]; pt.format.fill.solid(); pt.format.fill.fore_color.rgb = RED
    ch.plots[0].gap_width = 50
    estilo_grafico(ch, 15)
    ch.category_axis.tick_labels.font.size = Pt(13)
    from pptx.enum.chart import XL_TICK_LABEL_POSITION
    ch.category_axis.tick_label_position = XL_TICK_LABEL_POSITION.LOW
    x = 9.1; w = 3.73
    rect(s, x, 2.05, w, 2.3, CARD, True, 0.08); rect(s, x, 2.05, 0.12, 2.3, GREEN)
    text(s, x+0.35, 2.2, w-0.5, 0.35, "MESES POSITIVOS", 16, TXT3, True)
    runs(s, x+0.35, 2.55, w-0.5, 1.4, [(str(D['pos']), 72, True, GREEN), (f" de {CFG['n_meses']}", 28, True, TXT)])
    rect(s, x, 4.55, w, 2.35, CARD, True, 0.08); rect(s, x, 4.55, 0.12, 2.35, AMBER)
    text(s, x+0.35, 4.7, w-0.5, 0.35, "SUPERÁVIT DO PERÍODO" if D['res'] >= 0 else "DÉFICIT DO PERÍODO", 16, TXT3, True)
    text(s, x+0.35, 5.08, w-0.5, 0.6, brl(abs(D['res'])), ajusta(brl(abs(D['res'])), w-0.5, 28), AMBER, True)
    neg = [CFG['meses_label'][i] for i, v in enumerate(D['sup']) if v < 0]
    nt = (f"Único mês negativo: {neg[0]}" if len(neg) == 1 else (f"Meses negativos: {', '.join(neg)}" if neg else "Todos os meses positivos"))
    text(s, x+0.35, 5.8, w-0.5, 0.9, nt, 17, TXT2)
    rodape(s)

def _barras(s, lst, x0, y0, w, h, maxv=None, fsize=19, show_pct=True, total=None):
    n = len(lst); cols = cat_colors(n)
    maxv = maxv or max(abs(v) for _, v in lst)
    rh = h / n
    name_w = 4.9; val_w = 2.7; pct_w = 1.2
    bar_x = x0 + name_w; bar_w = w - name_w - val_w - (pct_w if show_pct else 0) - 0.2
    for i, (nome, v) in enumerate(lst):
        y = y0 + i*rh
        if i % 2 == 0: rect(s, x0-0.1, y, w+0.2, rh, CARD)
        text(s, x0+0.05, y, name_w-0.15, rh, nome, fsize, TXT, True, anchor=MSO_ANCHOR.MIDDLE)
        bl = max(0.06, bar_w*abs(v)/maxv)
        rect(s, bar_x, y+rh*0.28, bl, rh*0.44, cols[i] if v >= 0 else RED, True, 0.3)
        text(s, bar_x+bar_w+0.1, y, val_w, rh, brl_acc(v), fsize, TXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
        if show_pct:
            pv = v/total*100
            text(s, x0+w-pct_w, y, pct_w, rh, ("(" + pct(abs(pv)) + ")") if pv < 0 else pct(pv), fsize, cols[i] if v >= 0 else RED, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)

def s_receita(D, top=9):
    s = novo_slide()
    lst = CFG['receitas_cat']
    cabecalho(s, "05  •  ORIGEM DA RECEITA", "De onde veio", "a arrecadação",
              f"Total arrecadado: {brl(D['rec'])}    •    {len(lst)} fontes de receita")
    principais = lst[:top]; resto = lst[top:]
    show = principais + ([(f"Demais {len(resto)} fontes (próximo slide)", sum(v for _, v in resto))] if resto else [])
    _barras(s, show, 0.6, 2.05, 12.13, 4.25, maxv=max(v for _, v in show), fsize=17, total=D['rec'])
    if CFG.get('receita_insight'):
        rect(s, 0.5, 6.4, 12.33, 0.55, CARD2, True, 0.15)
        text(s, 0.75, 6.4, 11.9, 0.55, CFG['receita_insight'], 15, AMBER, True, anchor=MSO_ANCHOR.MIDDLE)
    rodape(s)
    return resto

def s_receita_todas(D):
    todas = CFG['receitas_cat']; POR = 40           # ate 20 linhas por coluna
    paginas = [todas[i:i+POR] for i in range(0, len(todas), POR)]
    for pi, lst in enumerate(paginas):
        s = novo_slide()
        t2 = "de receita" + (f" ({pi+1}/{len(paginas)})" if len(paginas) > 1 else "")
        cabecalho(s, "05  •  ORIGEM DA RECEITA", "Todas as fontes", t2,
                  "Lista completa do relatório, da maior para a menor. Valores entre parênteses reduzem a receita.")
        half = -(-len(lst)//2); y0 = 2.0; rh = min(0.42, 4.95/max(half, 1))
        for col in range(2):
            part = lst[col*half:(col+1)*half]; x = 0.5 + col*6.27
            for i, (nome, v) in enumerate(part):
                y = y0 + i*rh
                if i % 2 == 0: rect(s, x, y, 6.07, rh, CARD)
                text(s, x+0.12, y, 3.9, rh, nome, 15, TXT, False, anchor=MSO_ANCHOR.MIDDLE)
                text(s, x+3.7, y, 2.25, rh, brl_acc(v), 15, RED if v < 0 else TXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
        rodape(s)

def s_estrutura(D):
    s = novo_slide()
    lst = [(c['curto'], c['total']) for c in CFG['despesas']]
    cabecalho(s, "06  •  ESTRUTURA DE DESPESAS", "Como a despesa", "foi distribuída",
              f"Total gasto: {brl(D['desp'])}    •    {len(lst)} categorias, cada uma detalhada a seguir")
    _barras(s, lst, 0.6, 2.05, 12.13, 4.85, fsize=18, total=D['desp'])
    rodape(s)

# ---------- DETALHAMENTO ----------
# Medicao real da quebra de linha com a metrica das fontes da marca (Poppins Bold
# para nomes e valores, Inter para a composicao). Sem isso a paginacao ou estoura a caixa ou desperdica meio slide.
from PIL import ImageFont
_FT = {}
def _font(size, bold):
    k = (size, bold)
    if k not in _FT:
        arq = os.path.join(FONTES, 'Poppins-Bold.ttf' if bold else 'Inter-Regular.otf')
        _FT[k] = ImageFont.truetype(arq, size * 4)
    return _FT[k]
def largura(t, size, bold=False):
    return _font(size, bold).getlength(t) / 4 / 72      # polegadas
def n_linhas(t, size, w, bold=False):
    if not t: return 0
    lin = 1; cur = 0.0; esp = largura(' ', size, bold)
    for pal in t.split(' '):
        lp = largura(pal, size, bold)
        if cur == 0: cur = lp
        elif cur + esp + lp <= w * 0.97: cur += esp + lp
        else: lin += 1; cur = lp
    return lin

NOME_PT, COMP_PT = 19, 15
H_NOME, H_LIN, PAD, GAP = 0.44, 0.255, 0.09, 0.08
W_FULL, W_HALF = 12.33, 6.115
def _nb(t): return (t or '').replace('R$ ', 'R$\u00a0')
def _h_rub(r, w):
    return H_NOME + n_linhas(_nb(r.get('comp', '')).replace(' · ', '  ·  '), COMP_PT, w - 0.45) * H_LIN + PAD
def _cabe_meia(r):
    return (n_linhas(_nb(r.get('comp', '')).replace(' · ', '  ·  '), COMP_PT, W_HALF - 0.45) <= 1 and
            largura(r['nome'], NOME_PT, True) + largura(brl(r['valor']), NOME_PT, True) + 0.4 < W_HALF - 0.45)

def _blocos(rubs):
    """Linha cheia para rubrica com composicao longa; rubricas curtas em sequencia
    vao lado a lado (ordem de leitura esquerda para direita preservada)."""
    bl = []; i = 0
    while i < len(rubs):
        r = rubs[i]
        if _cabe_meia(r) and i + 1 < len(rubs) and _cabe_meia(rubs[i+1]):
            h = max(_h_rub(r, W_HALF), _h_rub(rubs[i+1], W_HALF))
            bl.append(([r, rubs[i+1]], h)); i += 2
        else:
            bl.append(([r], _h_rub(r, W_FULL))); i += 1
    return bl

def _paginar(bl, disp1, dispN, reserva_fim, reserva_cont):
    """Enche cada slide; so reequilibra as duas ultimas paginas quando a ultima
    ficaria quase vazia (regra do molde: nunca slide cheio seguido de orfao)."""
    alt = [h + GAP for _, h in bl]
    if sum(alt) <= disp1 - reserva_fim:
        return [list(bl)]
    pags = []; cur = []; acc = 0.0
    for b, h in zip(bl, alt):
        lim = (disp1 if not pags else dispN) - reserva_cont
        if cur and acc + h > lim: pags.append(cur); cur = []; acc = 0.0
        cur.append(b); acc += h
    pags.append(cur)
    soma = lambda pg: sum(h + GAP for _, h in pg)
    if soma(pags[-1]) > dispN - reserva_fim:          # ultima nao comporta a faixa de total
        pags.append([pags[-1].pop()])
    while len(pags) >= 2 and len(pags[-2]) > 1 and soma(pags[-1]) < 0.45 * dispN:
        mov = pags[-2][-1]
        if soma(pags[-1]) + mov[1] + GAP > dispN - reserva_fim: break
        if soma(pags[-1]) + mov[1] + GAP > soma(pags[-2]) - mov[1] - GAP: break
        pags[-1].insert(0, pags[-2].pop())
    return pags

def _desenha_rub(s, r, x, y, w, h, cor):
    rect(s, x, y, w, h, CARD, True, 0.05)
    rect(s, x, y, 0.1, h, cor)
    vw = largura(brl(r['valor']), NOME_PT, True) + 0.15
    text(s, x+0.3, y+0.06, w-0.45-vw, 0.38, r['nome'], NOME_PT, TXT, True)
    text(s, x+w-0.15-vw, y+0.06, vw, 0.38, brl(r['valor']), NOME_PT, TXT, True, PP_ALIGN.RIGHT)
    comp = r.get('comp')
    if comp:
        parts = []
        itens = comp.split(' · ')
        for k, it in enumerate(itens):
            m = re.match(r'^(.*?) (R\$ [\d.]+,\d{2})$', it)
            if m:
                parts.append((_nb(m.group(1)) + ' ', COMP_PT, False, TXT2)); parts.append((_nb(m.group(2)), COMP_PT, True, TXT))
            else:
                parts.append((_nb(it), COMP_PT, False, TXT2))
            if k < len(itens) - 1: parts.append(("  ·  ", COMP_PT, True, cor))
        runs(s, x+0.3, y+0.44, w-0.45, h-0.48, parts)

def s_detalhe(cat, idx, ncat, D):
    nota = cat.get('nota')
    TOP, BASE = 2.05, 6.95
    disp1 = BASE - (TOP + (0.6 if nota else 0)); dispN = BASE - TOP
    pags = _paginar(_blocos(cat['rubricas']), disp1, dispN, reserva_fim=0.62, reserva_cont=0.38)
    cor = cat_colors(ncat)[idx]
    pc = cat['total']/D['desp']*100
    for pi, pag in enumerate(pags):
        s = novo_slide()
        sec = f"07  •  DETALHAMENTO {idx+1} DE {ncat}" + (f"  •  PARTE {pi+1} DE {len(pags)}" if len(pags) > 1 else "")
        text(s, 0.5, 0.3, 8.5, 0.35, sec, 14, GS_AZUL_CLA, True)
        runs(s, 0.5, 0.6, 8.4, 0.75, [(cat['t1'], 32, True, TXT), (" " + cat['t2'], 32, True, cor)])
        hline(s, 0.5, 1.33, 1.05, GS_AZUL, 3)
        rect(s, 9.0, 0.32, 3.83, 1.45, CARD, True, 0.08); rect(s, 9.0, 0.32, 0.12, 1.45, cor)
        text(s, 9.3, 0.42, 3.4, 0.3, "TOTAL DA CATEGORIA", 14, TXT3, True)
        text(s, 9.3, 0.72, 3.4, 0.6, brl(cat['total']), ajusta(brl(cat['total']), 3.4, 28), TXT, True)
        text(s, 9.3, 1.34, 3.4, 0.35, f"{pct(pc)} da despesa total", 16, cor, True)
        text(s, 0.5, 1.45, 8.4, 0.4, cat['desc'], 16, TXT2)
        y = TOP
        if nota and pi == 0:
            rect(s, 0.5, TOP - 0.05, 12.33, 0.5, CARD2, True, 0.15)
            runs(s, 0.72, TOP - 0.05, 11.9, 0.5, [("ATENÇÃO   ", 13, True, AMBER), (nota, 15, False, AMBER)], anchor=MSO_ANCHOR.MIDDLE)
            y = TOP + 0.6
        for rubs, h in pag:
            if len(rubs) == 1:
                _desenha_rub(s, rubs[0], 0.5, y, W_FULL, h, cor)
            else:
                _desenha_rub(s, rubs[0], 0.5, y, W_HALF, h, cor)
                _desenha_rub(s, rubs[1], 0.5 + W_HALF + 0.1, y, W_HALF, h, cor)
            y += h + GAP
        if pi == len(pags) - 1:
            rect(s, 0.5, y+0.02, 12.33, 0.52, cor, True, 0.12)
            tc = txt_sobre(cor)
            text(s, 0.8, y+0.02, 8.5, 0.52, f"TOTAL  {cat['curto'].upper()}", 18, tc, True, anchor=MSO_ANCHOR.MIDDLE)
            text(s, 9.3, y+0.02, 3.3, 0.52, brl(cat['total']), 20, tc, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
        else:
            text(s, 0.8, y+0.02, 11, 0.35, "continua no próximo slide  ›", 16, TXT3)
        rodape(s)

def s_encerramento(D):
    s = novo_slide()
    rect(s, 0, 0, 13.333, 0.083, GS_AZUL)
    text(s, 0.5, 0.3, 9.5, 0.35, "ENCERRAMENTO  •  BALANÇO DO PERÍODO", 14, GS_AZUL_CLA, True)
    runs(s, 0.5, 0.6, 12.3, 0.75, [("O período em ", 34, True, TXT), ("números", 34, True, AMBER)])
    hline(s, 0.5, 1.35, 1.05, GS_AZUL, 3)
    text(s, 0.5, 1.45, 12.3, 0.45, f"Como o caixa evoluiu de {CFG['periodo_label']}", 17, TXT2)
    cd = CategoryChartData(); cd.categories = CFG['meses_label']
    cd.add_series("Saldo", CFG['saldo_fim_mes']); cd.add_series("Partida", [D['ini']]*CFG['n_meses'])
    rect(s, 0.5, 2.0, 7.9, 4.9, CARD, True, 0.04)
    runs(s, 0.8, 2.12, 7.4, 0.4, [("━ ", 18, True, AMBER), ("Saldo no fim de cada mês     ", 16, False, TXT2),
                                  ("┅ ", 18, True, BLUE), ("Ponto de partida", 16, False, TXT2)])
    gx = s.shapes.add_chart(XL_CHART_TYPE.LINE, Inches(0.6), Inches(2.55), Inches(7.7), Inches(4.25), cd)
    ch = gx.chart; ch.has_title = False; ch.has_legend = False
    s1 = ch.plots[0].series[0]; s1.format.line.color.rgb = AMBER; s1.format.line.width = Pt(5)
    s2 = ch.plots[0].series[1]; s2.format.line.color.rgb = BLUE; s2.format.line.width = Pt(2)
    ln = s2.format.line._get_or_add_ln(); pd = ln.find(qn('a:prstDash'))
    if pd is None: pd = ln.makeelement(qn('a:prstDash'), {'val': 'dash'}); ln.append(pd)
    estilo_grafico(ch, 14)
    ch.category_axis.tick_labels.font.size = Pt(11)
    x = 8.6; w = 4.23
    rect(s, x, 2.0, w, 1.55, CARD, True, 0.08); rect(s, x, 2.0, 0.12, 1.55, GREEN)
    text(s, x+0.35, 2.12, w-0.5, 0.3, "RESULTADO DO EXERCÍCIO" if D['res'] >= 0 else "DÉFICIT DO EXERCÍCIO", 13, TXT3, True)
    text(s, x+0.35, 2.48, w-0.5, 0.6, brl(abs(D['res'])), ajusta(brl(abs(D['res'])), w-0.5, 30), GREEN if D['res'] >= 0 else RED, True)
    text(s, x+0.35, 3.08, w-0.5, 0.35, "receita acima da despesa" if D['res'] >= 0 else "despesa acima da receita", 16, TXT2)
    rect(s, x, 3.7, w, 1.55, AMBER, True, 0.08)
    text(s, x+0.35, 3.82, w-0.5, 0.3, "O CAIXA CRESCEU" if D['cresc'] >= 0 else "O CAIXA ENCERROU EM", 13, DARKTXT, True)
    text(s, x+0.35, 4.15, w-0.5, 0.9, pct_sig(D['cresc']) if D['cresc'] >= 0 else brl(D['fim']), 46, DARKTXT, True)
    rect(s, x, 5.4, w, 1.5, CARD, True, 0.08); rect(s, x, 5.4, 0.12, 1.5, BLUE)
    text(s, x+0.35, 5.52, w-0.5, 0.3, f"RECEITA COBRIU {pct(D['cob'])} DA DESPESA", 13, TXT3, True)
    runs(s, x+0.35, 5.88, w-0.5, 0.7, [(f"{D['pos']} de {CFG['n_meses']} meses", 26, True, BLUE), ("  positivos", 17, False, TXT2)])
    rodape(s)

def montar(cfg, saida):
    global prs, BLANK, CFG
    CFG = cfg; PAG[0] = 0
    D = derivar(cfg)
    prs = Presentation(); prs.slide_width = Inches(13.333); prs.slide_height = Inches(7.5)
    BLANK = prs.slide_layouts[6]
    s_capa(); s_visao(D); s_evolucao(D); s_patrimonio(D); s_resultado(D)
    resto = s_receita(D)
    if resto: s_receita_todas(D)
    s_estrutura(D)
    for i, cat in enumerate(cfg['despesas']):
        s_detalhe(cat, i, len(cfg['despesas']), D)
    s_encerramento(D)
    prs.save(saida)
    return saida
