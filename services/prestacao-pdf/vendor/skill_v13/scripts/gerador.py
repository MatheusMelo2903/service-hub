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

def var_caixa(D):
    """Variação do caixa: em % quando o saldo inicial é positivo e o número faz
    sentido; em reais quando o saldo inicial é zero, negativo ou muito pequeno
    (condomínio novo), porque aí a porcentagem fica absurda ou divide por zero."""
    if D['cresc_pct']:
        return pct_sig(D['cresc'])
    return ("+" if D['fim'] - D['ini'] >= 0 else "-") + brl(abs(D['fim'] - D['ini']))

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

# ---------------- EXPLICACOES (numeros que assustam) ----------------
# Deficit, caixa caindo e mes negativo saem JA explicados no mesmo slide (pedido do
# Matheus, 23/10/2026). Tudo aqui so roda quando o CFG traz 'explicacoes'; sem elas
# os slides sao exatamente os do molde.
def _exp():
    return (CFG or {}).get('explicacoes') or {}

def brl_mil(v):
    v = abs(v)
    if v >= 1_000_000: return "R$ " + f"{v/1_000_000:.1f}".replace(".", ",") + (" milhão" if v < 2_000_000 else " milhões")
    if v >= 10_000: return "R$ " + f"{v/1000:,.0f}".replace(",", ".") + " mil"
    return brl(v)

def _alt(t, size, w, bold=False):
    """Altura (pol.) do texto quebrado na largura w: metrica real da fonte com 10% de
    folga na largura e a altura de linha de cada fonte no LibreOffice (Poppins 1,4; Inter 1,22)."""
    return n_linhas(_nb(t), size, w * 0.90, bold) * size * (1.4 if bold else 1.22) / 72

def _cabe(t, w, h, maxi, mini=14, bold=False):
    size = maxi
    while size > mini and _alt(t, size, w, bold) > h: size -= 1
    return size

def _quedas_contas():
    """Contas que mais cairam, ate explicar 75% da queda do caixa (no maximo duas)."""
    contas = (CFG or {}).get('contas') or []
    cai = sorted([c for c in contas if c['fim'] < c['ini'] - 0.004], key=lambda c: c['fim'] - c['ini'])
    tot = sum(c['ini'] - c['fim'] for c in cai); out = []; acc = 0.0
    for c in cai[:2]:
        out.append(c); acc += c['ini'] - c['fim']
        if tot and acc >= 0.75 * tot: break
    return out

def _mov_conta(c):
    return f"{c['nome']} de {brl_mil(c['ini'])} para {brl_mil(c['fim'])}"

# ---------------- DERIVADOS E VALIDACAO ----------------
def derivar(c):
    d = {}
    d['rec'] = c['receita_total']; d['desp'] = c['despesa_total']
    d['res'] = d['rec'] - d['desp']; d['ini'] = c['saldo_anterior']; d['fim'] = c['saldo_final']
    d['cob'] = d['rec']/d['desp']*100; d['marg'] = d['res']/d['rec']*100
    # Sinal sempre o da variação (abs no divisor); sem saldo inicial, só o sinal.
    d['cresc'] = (d['fim']-d['ini'])/abs(d['ini'])*100 if d['ini'] else (1.0 if d['fim'] >= d['ini'] else -1.0)
    d['cresc_pct'] = d['ini'] > 0 and abs(d['cresc']) < 1000
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
    # Nome longo: a letra diminui até caber numa linha (mínimo 32, que em duas linhas
    # ainda cabe antes do traço azul). Antes quebrava e encavalava no "Exercício".
    tam = ajusta(CFG['cliente_linha1'] + " " + CFG['cliente_linha2'], 7.6, 54, True, 32)
    runs(s, 0.94, 2.8, 7.6, 1.0, [(CFG['cliente_linha1'] + " ", tam, True, TXT), (CFG['cliente_linha2'], tam, True, GS_AZUL_CLA)])
    hline(s, 0.94, 4.05, 1.9, GS_AZUL, 4)
    text(s, 0.94, 4.3, 7.6, 0.6, CFG['exercicio_titulo'], 28, TXT, True)
    text(s, 0.94, 4.95, 7.6, 0.5, CFG['periodo_extenso'] + "\nApresentação em Assembleia", 19, TXT2)
    rect(s, 0.94, 6.45, 11.45, 0.012, LINE)
    text(s, 0.94, 6.62, 11.45, 0.4, "Contábil Service    •    Condomínio Service    •    RH Service", 15, TXT3)
    # bloco de destaque (split): onde o caixa terminou
    D = derivar(CFG)
    if _exp().get('caixa'):
        return _capa_explicada(s, D)
    x, y, w, h = 8.75, 2.35, 3.64, 2.85
    rect(s, x, y, w, h, CARD, True, 0.06); rect(s, x, y, 0.12, h, GS_AZUL)
    text(s, x+0.38, y+0.25, w-0.55, 0.3, f"SALDO EM CAIXA EM {CFG['data_final']}", 12, TXT3, True)
    v = brl(D['fim'])
    text(s, x+0.38, y+0.6, w-0.55, 0.6, v, ajusta(v, w-0.55, 28), GS_AZUL_CLA, True)
    text(s, x+0.38, y+1.3, w-0.55, 0.3, "CRESCIMENTO NO PERÍODO", 12, TXT3, True)
    text(s, x+0.38, y+1.62, w-0.55, 0.7, var_caixa(D), ajusta(var_caixa(D), w-0.55, 40), AMBER, True)
    text(s, x+0.38, y+2.35, w-0.55, 0.35, f"de {brl0(D['ini'])} para {brl0(D['fim'])}", 13, TXT2)

def _capa_explicada(s, D):
    """Bloco da direita com a variacao do caixa ja explicada embaixo do numero."""
    cx = _exp()['caixa']
    x, y, w = 8.75, 2.35, 3.64; tw = w - 0.55
    tam = _cabe(cx, tw, 6.3 - y - 3.0, 16, 14)
    he = _alt(cx, tam, tw)
    h = 2.8 + he + 0.22
    rect(s, x, y, w, h, CARD, True, 0.06); rect(s, x, y, 0.12, h, GS_AZUL)
    text(s, x+0.38, y+0.25, tw, 0.3, f"SALDO EM CAIXA EM {CFG['data_final']}", 12, TXT3, True)
    v = brl(D['fim'])
    text(s, x+0.38, y+0.6, tw, 0.6, v, ajusta(v, tw, 28), GS_AZUL_CLA, True)
    text(s, x+0.38, y+1.3, tw, 0.3, "CRESCIMENTO NO PERÍODO" if D['fim'] >= D['ini'] else "VARIAÇÃO NO PERÍODO", 12, TXT3, True)
    text(s, x+0.38, y+1.62, tw, 0.7, var_caixa(D), ajusta(var_caixa(D), tw, 40), AMBER, True)
    text(s, x+0.38, y+2.35, tw, 0.3, f"de {brl0(D['ini'])} para {brl0(D['fim'])}", 13, TXT2)
    rect(s, x+0.38, y+2.7, 0.5, 0.025, AMBER)
    text(s, x+0.38, y+2.8, tw, he + 0.05, _nb(cx), tam, TXT)

def _kpi_c(s, x, y, w, h, label, valor, sub, cor, vsize=30):
    """KPI compacto do slide de visao geral explicado (mesmo desenho, alturas menores)."""
    rect(s, x, y, w, h, CARD, True, 0.06)
    rect(s, x, y, 0.12, h, cor)
    text(s, x+0.32, y+0.14, w-0.45, 0.3, label, 14, TXT3, True)
    text(s, x+0.32, y+0.44, w-0.45, 0.55, valor, ajusta(valor, w-0.45, vsize), cor, True)
    if sub: text(s, x+0.32, y+h-0.4, w-0.45, 0.3, sub, 15, TXT2)

def _visao_explicada(D, exp):
    s = novo_slide()
    cabecalho(s, "01  •  VISÃO GERAL", "Resultado consolidado", "do exercício")
    # Linha 1: os quatro numeros do caixa (saldo final sobe para ca e abre espaco para a explicacao).
    w4 = (12.33 - 0.6)/4; y1 = 1.75; h1 = 1.32
    for i, (l, v, sb, c) in enumerate([
            ("SALDO INICIAL", brl(D['ini']), f"em {CFG['data_inicial']}", BLUE),
            ("RECEITA TOTAL", brl(D['rec']), f"{CFG['n_meses']} meses", GREEN),
            ("DESPESA TOTAL", brl(D['desp']), f"{CFG['n_meses']} meses", TXT2),
            ("SALDO FINAL", brl(D['fim']), f"em {CFG['data_final']}", AMBER)]):
        _kpi_c(s, 0.5 + i*(w4+0.2), y1, w4, h1, l, v, sb, c, 30)
    # Linha 2: resultado com a explicacao curta + faixa "por que" com o resumo.
    y2 = y1 + h1 + 0.18; wl = 4.0; wr = 12.33 - wl - 0.2; xr = 0.5 + wl + 0.2
    hb = 1.55                                   # faixa dos pilares: valor + nota de duas linhas
    hmax = 6.9 - hb - 0.18 - y2
    cx = exp.get('caixa') or f"{'Margem' if D['res']>=0 else 'Déficit'} de {pct(abs(D['marg']))} sobre a receita"
    t_cx = _cabe(cx, wl-0.5, hmax-1.15, 17, 14); h_cx = _alt(cx, t_cx, wl-0.5)
    rs = exp['resumo']
    t_rs = _cabe(rs, wr-0.6, hmax-0.72, 20, 14); h_rs = _alt(rs, t_rs, wr-0.6)
    h2 = hmax
    neg = D['res'] < 0
    cor = GREEN if not neg else RED
    rect(s, 0.5, y2, wl, h2, CARD, True, 0.06); rect(s, 0.5, y2, 0.12, h2, cor)
    text(s, 0.82, y2+0.16, wl-0.5, 0.3, "SUPERÁVIT DO PERÍODO" if not neg else "DÉFICIT DO PERÍODO", 14, TXT3, True)
    v = brl(abs(D['res']))
    text(s, 0.82, y2+0.44, wl-0.5, 0.55, v, ajusta(v, wl-0.5, 30), cor, True)
    text(s, 0.82, y2+1.0, wl-0.5, h_cx+0.05, _nb(cx), t_cx, TXT2)
    rect(s, xr, y2, wr, h2, CARD2, True, 0.06); rect(s, xr, y2, 0.12, h2, AMBER)
    tit = ("POR QUE O RESULTADO FICOU NEGATIVO" if neg else
           "POR QUE O CAIXA CAIU" if D['fim'] < D['ini'] else "POR QUE HOUVE MESES NEGATIVOS")
    text(s, xr+0.35, y2+0.16, wr-0.6, 0.3, tit, 14, AMBER, True)
    text(s, xr+0.35, y2+0.56, wr-0.6, h_rs+0.05, _nb(rs), t_rs, TXT)
    # Linha 3: os tres pilares, mais compactos; o do caixa com o que explica a variacao.
    y3 = y2 + h2 + 0.18
    rect(s, 0.5, y3, 12.33, hb, AMBER, True, 0.08)
    pw = 12.33/3
    qc = _quedas_contas() if D['fim'] < D['ini'] else []
    nota = (", ".join(_mov_conta(c) for c in qc[:1]) if qc else f"de {brl_mil(D['ini'])} para {brl_mil(D['fim'])}")
    pil = [("RECEITA COBRIU", pct(D['cob']), None),
           ("O CAIXA CRESCEU" if D['cresc'] >= 0 else "O CAIXA VARIOU", var_caixa(D), nota),
           ("MESES POSITIVOS", f"{D['pos']} de {CFG['n_meses']}", None)]
    for i, (a, b, c) in enumerate(pil):
        x = 0.5 + i*pw
        text(s, x, y3+0.12, pw, 0.3, a, 14, DARKTXT, True, PP_ALIGN.CENTER)
        text(s, x, y3+0.38, pw, 0.6, b, ajusta(b, pw - 0.3, 32), DARKTXT, True, PP_ALIGN.CENTER)
        if c:
            tn = _cabe(c, pw-0.4, hb-1.02, 15, 14)
            text(s, x+0.2, y3+0.92, pw-0.4, hb-1.0, _nb(c), tn, DARKTXT, False, PP_ALIGN.CENTER)
        if i < 2:
            ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x+pw), Inches(y3+0.2), Inches(x+pw), Inches(y3+hb-0.2))
            ln.line.color.rgb = DARKTXT; ln.line.width = Pt(1)
    rodape(s)

def s_visao(D):
    if _exp().get('resumo'):
        return _visao_explicada(D, _exp())
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
           ("O CAIXA CRESCEU" if D['cresc'] >= 0 else "O CAIXA VARIOU", var_caixa(D), "no período"),
           ("MESES POSITIVOS", f"{D['pos']} de {CFG['n_meses']}", "com superávit")]
    for i, (a, b, c) in enumerate(pil):
        x = 0.5 + i*pw
        text(s, x, y3+0.14, pw, 0.35, a, 14, DARKTXT, True, PP_ALIGN.CENTER)
        text(s, x, y3+0.42, pw, 0.7, b, ajusta(b, pw - 0.3, 36), DARKTXT, True, PP_ALIGN.CENTER)
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

def _faixa_patrimonio(s, D):
    """Embaixo do grafico: o que explica o caixa e de qual conta saiu o dinheiro.
    Devolve a altura do grafico que sobra (0 = sem faixa, grafico do molde)."""
    exp = _exp(); cx = exp.get('caixa')
    qc = _quedas_contas() if D['fim'] < D['ini'] else []
    if not (cx or qc):
        return 4.85
    w = 8.4 - 0.55
    h_cx = _alt(cx, 18, w) if cx else 0
    contas_t = "    •    ".join(_mov_conta(c) for c in qc)
    h_ct = _alt(contas_t, 17, w, True) if qc else 0
    hb = 0.5 + h_cx + (0.08 if cx and qc else 0) + h_ct + 0.18
    yb = 6.9 - hb
    rect(s, 0.5, yb, 8.3, hb, CARD2, True, 0.08); rect(s, 0.5, yb, 0.1, hb, AMBER)
    text(s, 0.8, yb+0.14, w, 0.3, "DE ONDE SAIU O DINHEIRO" if D['fim'] < D['ini'] else "O QUE EXPLICA O SALDO", 13, AMBER, True)
    y = yb + 0.5
    if cx:
        text(s, 0.8, y, w, h_cx + 0.04, _nb(cx), 18, TXT); y += h_cx + 0.08
    if qc:
        text(s, 0.8, y, w, h_ct + 0.04, _nb(contas_t), 17, AMBER, True)
    return yb - 0.15 - 2.05

def s_patrimonio(D):
    s = novo_slide()
    cabecalho(s, "03  •  PATRIMÔNIO", "Evolução do saldo", "em caixa",
              f"De {brl(D['ini'])} em {CFG['data_inicial']} para {brl(D['fim'])} em {CFG['data_final']}")
    hg = _faixa_patrimonio(s, D) if _exp() else 4.85
    cd = CategoryChartData(); cd.categories = CFG['meses_label']; cd.add_series("Saldo", CFG['saldo_fim_mes'])
    gx = s.shapes.add_chart(XL_CHART_TYPE.LINE_MARKERS, Inches(0.4), Inches(2.05), Inches(8.4), Inches(hg), cd)
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
    text(s, x+0.3, 2.6, w-0.5, 1.0, var_caixa(D), ajusta(var_caixa(D), w-0.5, 46), DARKTXT, True)
    for i, (l, v, c) in enumerate([(f"SALDO INICIAL ({CFG['meses_label'][0].upper()})", brl(D['ini']), BLUE),
                                   (f"SALDO FINAL ({CFG['meses_label'][-1].upper()})", brl(D['fim']), AMBER),
                                   ("SUPERÁVIT DO PERÍODO" if D['res'] >= 0 else "DÉFICIT DO PERÍODO", brl(abs(D['res'])), GREEN if D['res'] >= 0 else RED)]):
        y = 4.1 + i*0.95
        rect(s, x, y, w, 0.85, CARD, True, 0.08); rect(s, x, y, 0.1, 0.85, c)
        text(s, x+0.3, y+0.08, w-0.4, 0.3, l, 12, TXT3, True)
        text(s, x+0.3, y+0.36, w-0.4, 0.45, v, ajusta(v, w-0.4, 22), c, True)
    rodape(s)

def s_contas(D):
    """Onde esta o dinheiro: saldo de cada conta no inicio e no fim; o total fecha com a capa."""
    contas = CFG.get('contas') or []
    if not contas: return
    assert abs(sum(c['ini'] for c in contas) - D['ini']) < 0.02 and abs(sum(c['fim'] for c in contas) - D['fim']) < 0.02, "contas x caixa"
    s = novo_slide()
    cabecalho(s, "03  •  PATRIMÔNIO", "Onde está", "o dinheiro",
              "Saldo de cada conta no início e no fim do período. A soma é o saldo em caixa.")
    frase = _exp().get('contas')
    wf = 12.33 - 0.7
    h_fr = _alt(frase, 17, wf) if frase else 0
    hf = (0.5 + h_fr + 0.18) if frase else 0
    base = 6.9 - (hf + 0.15 if frase else 0)
    n = len(contas) + 2
    rh = max(0.34, min(0.52, (base - 2.0) / n))
    fs = 17 if rh >= 0.44 else 15
    cols = [(0.5, 5.0, "CONTA", PP_ALIGN.LEFT), (5.5, 2.35, "SALDO EM " + CFG['data_inicial'], PP_ALIGN.RIGHT),
            (7.85, 2.35, "SALDO EM " + CFG['data_final'], PP_ALIGN.RIGHT), (10.2, 2.48, "VARIAÇÃO", PP_ALIGN.RIGHT)]
    y = 2.0
    rect(s, 0.5, y, 12.33, rh, CARD2)
    for x, w, t, al in cols:
        text(s, x + (0.25 if al == PP_ALIGN.LEFT else 0), y, w - 0.25, rh, t, 13, TXT3, True, al, MSO_ANCHOR.MIDDLE)
    def var_t(v): return ("+" + brl(v)) if v > 0.004 else ("(" + brl(abs(v)) + ")" if v < -0.004 else brl(0))
    wv3 = 2.48 - 0.25
    for i, c in enumerate(contas):
        y = 2.0 + (i+1)*rh
        if i % 2 == 1: rect(s, 0.5, y, 12.33, rh, CARD)
        v = c['fim'] - c['ini']
        text(s, 0.75, y, 4.75, rh, c['nome'], fs, TXT, False, anchor=MSO_ANCHOR.MIDDLE)
        text(s, 5.5, y, 2.1, rh, brl_acc(c['ini']), fs, TXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
        text(s, 7.85, y, 2.1, rh, brl_acc(c['fim']), fs, TXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
        text(s, 10.2, y, wv3, rh, var_t(v), fs, RED if v < -0.004 else (GREEN if v > 0.004 else TXT2), True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
    y = 2.0 + (len(contas)+1)*rh + 0.04
    rect(s, 0.5, y, 12.33, rh, AMBER, True, 0.12)
    text(s, 0.75, y, 4.75, rh, "TOTAL EM CAIXA", fs, DARKTXT, True, anchor=MSO_ANCHOR.MIDDLE)
    text(s, 5.5, y, 2.1, rh, brl_acc(D['ini']), fs, DARKTXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
    text(s, 7.85, y, 2.1, rh, brl_acc(D['fim']), fs, DARKTXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
    text(s, 10.2, y, wv3, rh, var_t(D['fim'] - D['ini']), fs, DARKTXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
    if frase:
        yf = 6.9 - hf
        rect(s, 0.5, yf, 12.33, hf, CARD2, True, 0.08); rect(s, 0.5, yf, 0.1, hf, AMBER)
        text(s, 0.85, yf+0.14, wf, 0.3, "MOVIMENTO DAS RESERVAS", 13, AMBER, True)
        text(s, 0.85, yf+0.5, wf, h_fr+0.04, _nb(frase), 17, TXT)
    rodape(s)

def _lista_meses(D):
    """Meses negativos com o motivo de cada um (texto 'meses' da explicacao)."""
    em = _exp().get('meses') or {}
    import unicodedata
    def chave(lab):  # 'NOV/2025', 'Nov/25' ou 'nov/25' -> 'nov/25'
        l = unicodedata.normalize('NFKD', str(lab)).lower()
        m = re.match(r'^([a-z]{3})\w*/(\d{2,4})$', l)
        return f"{m.group(1)}/{m.group(2)[-2:]}" if m else l
    em_n = {chave(k): v for k, v in em.items()}
    neg = [(CFG['meses_label'][i], v, em_n.get(chave(CFG['meses_label'][i]))) for i, v in enumerate(D['sup']) if v < 0]
    return neg if any(t for _, _, t in neg) else []

def s_resultado(D):
    lst = _lista_meses(D) if _exp() else []
    if lst:
        return _resultado_explicado(D, lst)
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

def _grafico_resultado(s, D, hg, wg=8.4):
    cd = CategoryChartData(); cd.categories = CFG['meses_label']; cd.add_series("Resultado", D['sup'])
    gx = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.4), Inches(2.05), Inches(wg), Inches(hg), cd)
    ch = gx.chart; ch.has_title = False; ch.has_legend = False
    sr = ch.plots[0].series[0]; sr.format.fill.solid(); sr.format.fill.fore_color.rgb = GREEN; sr.format.line.fill.background()
    sr.invert_if_negative = False
    for idx, v in enumerate(D['sup']):
        if v < 0:
            pt = sr.points[idx]; pt.format.fill.solid(); pt.format.fill.fore_color.rgb = RED
    ch.plots[0].gap_width = 50
    estilo_grafico(ch, 14)
    ch.category_axis.tick_labels.font.size = Pt(13)
    from pptx.enum.chart import XL_TICK_LABEL_POSITION
    ch.category_axis.tick_label_position = XL_TICK_LABEL_POSITION.LOW

def _resultado_explicado(D, lst):
    """Grafico de largura cheia e mais baixo; embaixo, cada mes negativo com o que pesou
    nele. Mes negativo sem motivo identificado vai numa linha so, sem inventar causa."""
    s = novo_slide()
    cabecalho(s, "04  •  RESULTADO LÍQUIDO", "Resultado", "de cada mês",
              f"Receitas menos despesas, mês a mês    •    {D['pos']} de {CFG['n_meses']} meses positivos")
    xl, wl = 0.5, 12.33
    wm, wv = 1.1, 2.05
    wt = wl - 0.24 - wm - wv - 0.3
    com = [x for x in lst if x[2]]; sem = [x for x in lst if not x[2]]
    for fs in (16, 15, 14):
        alts = [max(0.34, _alt(t, fs, wt) + 0.1) for _, _, t in com]
        h_sem = 0.36 if sem else 0
        hl = 0.4 + sum(alts) + h_sem
        if 4.85 - hl - 0.1 >= 1.85: break
    vis = list(zip(com, alts))
    while len(vis) > 1 and 4.85 - (0.4 + sum(a for _, a in vis) + (0.36 if (sem or len(vis) < len(com)) else 0)) - 0.1 < 1.7:
        sem.append(vis.pop()[0])                       # o que nao cabe vai para a linha de baixo
    if sem: sem.sort(key=lambda x: CFG['meses_label'].index(x[0]))
    h_sem = 0.36 if sem else 0
    hl = 0.4 + sum(a for _, a in vis) + h_sem
    hg = 4.85 - hl - 0.1
    _grafico_resultado(s, D, hg, 12.5)
    y = 2.05 + hg + 0.1
    text(s, xl, y, wl, 0.32, "MESES NEGATIVOS E O QUE PESOU EM CADA UM", 13, AMBER, True)
    y += 0.4
    for i, ((mes, v, t), a) in enumerate(vis):
        if i % 2 == 0: rect(s, xl, y, wl, a, CARD)
        text(s, xl+0.12, y, wm, a, mes, fs, RED, True, anchor=MSO_ANCHOR.MIDDLE)
        text(s, xl+0.12+wm, y, wv, a, brl_acc(v), fs, TXT, True, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)
        text(s, xl+0.12+wm+wv+0.3, y, wt, a, _nb(t), fs, TXT2, anchor=MSO_ANCHOR.MIDDLE)
        y += a
    if sem:
        partes = [f"{m} {brl_acc(v)}" for m, v, _ in sem]
        frase = ("Também negativo: " if len(sem) == 1 else "Também negativos: ") + ", ".join(partes[:-1]) + (" e " if len(partes) > 1 else "") + partes[-1] + "."
        text(s, xl+0.12, y+0.05, wl-0.2, 0.3, _nb(frase), 14 if fs < 16 else 15, TXT3)
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
        if '\n' in nome:
            n1, n2 = nome.split('\n', 1)
            tb = runs(s, x0+0.05, y, name_w-0.15, rh, [(n1, min(fsize, 15), True, TXT)], anchor=MSO_ANCHOR.MIDDLE)
            p2 = tb.text_frame.add_paragraph(); r2 = p2.add_run(); r2.text = n2
            r2.font.name = FONT; r2.font.size = Pt(11); r2.font.bold = False; r2.font.color.rgb = TXT2
        else:
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
    # Categoria oculta no Hub: fica no grafico e nos totais, sem slide de detalhamento.
    lst = [(c['curto'] + ('\n(não detalhado nesta apresentação)' if c.get('oculta') else ''), c['total']) for c in CFG['despesas']]
    nd = sum(1 for c in CFG['despesas'] if not c.get('oculta'))
    sub = (f"{len(lst)} categorias, cada uma detalhada a seguir" if nd == len(lst)
           else f"{len(lst)} categorias, nenhuma detalhada nesta apresentação" if nd == 0
           else f"{len(lst)} categorias, {nd} detalhada{'s' if nd != 1 else ''} a seguir")
    cabecalho(s, "06  •  ESTRUTURA DE DESPESAS", "Como a despesa", "foi distribuída",
              f"Total gasto: {brl(D['desp'])}    •    {sub}")
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
DEST_PT = 15
def _h_dest(r, w):
    """Linha de destaque (azul celeste) da rubrica que explica o deficit; 0 sem destaque."""
    d = r.get('destaque')
    return (0.06 + n_linhas(_nb('▸ ' + d), DEST_PT, (w - 0.45) * 0.90) * H_LIN) if d else 0
def _h_rub(r, w):
    return H_NOME + n_linhas(_nb(r.get('comp', '')).replace(' · ', '  ·  '), COMP_PT, w - 0.45) * H_LIN + PAD + _h_dest(r, w)
def _cabe_meia(r):
    if r.get('destaque'): return False
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
        hd = _h_dest(r, w)
        runs(s, x+0.3, y+0.44, w-0.45, h-0.48-hd, parts)
    if r.get('destaque'):
        hd = _h_dest(r, w)
        yd = y + h - PAD - hd + 0.06
        runs(s, x+0.3, yd, w-0.45, hd - 0.06, [("▸ ", DEST_PT, True, AMBER), (_nb(r['destaque']), DEST_PT, False, AMBER)])

def s_detalhe(cat, idx, ncat, D, num=None, ntot=None):
    nota = cat.get('nota')
    TOP, BASE = 2.05, 6.95
    disp1 = BASE - (TOP + (0.6 if nota else 0)); dispN = BASE - TOP
    pags = _paginar(_blocos(cat['rubricas']), disp1, dispN, reserva_fim=0.62, reserva_cont=0.38)
    cor = cat_colors(ncat)[idx]
    pc = cat['total']/D['desp']*100
    for pi, pag in enumerate(pags):
        s = novo_slide()
        sec = f"07  •  DETALHAMENTO {(idx if num is None else num)+1} DE {ncat if ntot is None else ntot}" + (f"  •  PARTE {pi+1} DE {len(pags)}" if len(pags) > 1 else "")
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
    # Valor em reais (caixa que caiu) não cabe a 46: ajusta à largura do cartão.
    v_cx = var_caixa(D) if D['cresc'] >= 0 else brl(D['fim'])
    text(s, x+0.35, 4.15, w-0.5, 0.9, v_cx, ajusta(v_cx, w-0.5, 46), DARKTXT, True)
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
    s_capa(); s_visao(D); s_evolucao(D); s_patrimonio(D)
    if cfg.get('explicacoes') and cfg.get('contas'): s_contas(D)
    s_resultado(D)
    resto = s_receita(D)
    if resto: s_receita_todas(D)
    s_estrutura(D)
    # Numeracao "DETALHAMENTO i DE n" conta so as detalhadas; a cor segue a posicao no grafico.
    vis = [(i, cat) for i, cat in enumerate(cfg['despesas']) if not cat.get('oculta')]
    for k, (i, cat) in enumerate(vis):
        s_detalhe(cat, i, len(cfg['despesas']), D, k, len(vis))
    s_encerramento(D)
    prs.save(saida)
    return saida
