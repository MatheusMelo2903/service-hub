# -*- coding: utf-8 -*-
"""
Prestacao de Contas - TEMPLATE DATA-DRIVEN
============================================
Molde fixo (estrutura e estetica das referencias Reserva Verde e Maconaria).
Tudo o que muda por cliente esta no bloco CONFIG abaixo.
O corpo do script percorre as listas do CONFIG e gera quantos slides forem
necessarios: 1 por categoria de despesa, 1 por certidao, divisores por bloco.

Regra de ouro: nada de numero fixo de categorias/meses. Tudo vem do CONFIG,
que e extraido FIELMENTE do relatorio do Superlogica (W011A/W015A).

Como usar:
  1. Preencher o CONFIG com os dados do relatorio do cliente.
  2. python3 template_prestacao.py
  3. libreoffice --headless --convert-to pdf <saida>.pptx
"""

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.oxml.ns import qn
import os

# =====================================================================
# CONFIG - UNICA PARTE QUE MUDA POR CLIENTE (extraida do relatorio)
# =====================================================================
# Exemplo preenchido com Condominio Reserva Verde (semestral).
# Para outro cliente, substituir todos os valores por extracao fiel do W011A/W015A.

CONFIG = {
    # ---- Identificacao ----
    "cliente_linha1": "Condomínio Residencial",        # primeira linha do titulo (branco)
    "cliente_linha2": "Reserva Verde",                  # segunda linha (azul claro)
    "rodape": "CONDOMÍNIO RESIDENCIAL RESERVA VERDE",   # nome no rodape (caps)
    "cnpj": None,                                       # ex: "CNPJ 14.918.406/0001-62" ou None
    "periodo_label": "OUT/2025 a MAR/2026",             # usado em capa, rodape, KPIs
    "periodo_extenso": "Outubro de 2025 a Março de 2026",
    "exercicio_titulo": "Exercício OUT/2025 a MAR/2026",
    "n_meses": 6,
    "data_inicial": "01/10/2025",
    "data_final": "31/03/2026",

    # ---- Numeros base (validados) ----
    "saldo_anterior": 925282.75,
    "receita_total": 1194704.88,
    "despesa_total": 1130855.44,
    # superavit e saldo_final sao calculados; informar para conferir
    "saldo_final": 989132.19,

    # ---- Serie mensal (None se o relatorio nao trouxer mes a mes limpo) ----
    # labels e listas devem ter o mesmo tamanho de n_meses
    "meses_label": ["Out/25", "Nov/25", "Dez/25", "Jan/26", "Fev/26", "Mar/26"],
    "meses_ini":   ["O", "N", "D", "J", "F", "M"],
    "receitas_mes": [200063, 198344, 198578, 204977, 194204, 198538],
    "despesas_mes": [195880, 175859, 188601, 197489, 176760, 196266],
    # saldo acumulado fim de cada mes (do relatorio)
    "saldo_fim_mes": [929465, 951950, 961927, 969415, 986859, 989132],

    # ---- Receitas por categoria (todas, maior -> menor) ----
    # (nome, valor, percentual)
    "receitas_cat": [
        ("Taxa de Condomínio",        752207.88, 63.0),
        ("Água Individual",           189921.75, 15.9),
        ("Energia (rateio)",           83610.72,  7.0),
        ("Rendimentos de Aplicações",  47287.22,  4.0),
        ("Reservas de Áreas Comuns",   38441.36,  3.2),
        ("Fundo de Reserva",           37611.18,  3.1),
        ("Demais Receitas",            45624.77,  3.8),
    ],
    "receita_insight": "Taxa de Condomínio responde por 63% da arrecadação. Água e Energia rateadas somam outros 22%, formando uma base previsível.",
    "receita_insight_pct": "63%",

    # ---- Despesas por categoria (todas, maior -> menor) ----
    # (nome, valor, percentual) -- gera 1 slide de detalhamento por item desta lista
    "despesas_cat": [
        ("Pessoal",               395744.74, 35.0),
        ("Consumo",               306382.27, 27.1),
        ("Serviços",              100060.96,  8.8),
        ("Manutenção",             97811.06,  8.6),
        ("Materiais",              83842.71,  7.4),
        ("Administrativo",         66263.25,  5.9),
        ("Retenções",              64305.37,  5.7),
        ("Investimento",           11909.18,  1.1),
        ("Financeiras",             4264.43,  0.4),
        ("Taxas",                    271.47,  0.0),
    ],

    # ---- Detalhamento de cada categoria de despesa ----
    # chave = nome exato da categoria em despesas_cat
    # titulo1/titulo2 = titulo do slide (titulo2 em azul). descricao = texto do card.
    # serie_mensal = 12/N valores ou None. lancamentos = [(desc, valor), ...] maior->menor.
    # nota = texto da caixa de alerta ambar ou None.
    "detalhes": {
        "Pessoal": {
            "titulo1": "Despesas com", "titulo2": "pessoal",
            "descricao": "Maior categoria do período. Inclui o contrato de mão de obra terceirizada (portaria, ronda e limpeza) e os funcionários diretos do condomínio. Folha estável ao longo dos 6 meses.",
            "serie_mensal": [66000, 66200, 66000, 65800, 66000, 65744],
            "lancamentos": [
                ("Mão de Obra Terceirizada (portaria, ronda, limpeza)", 335157.98),
                ("Salários dos Funcionários (6 meses)", 26195.77),
                ("Vale Alimentação (6 meses)", 8712.50),
                ("Plano de Saúde", 8114.65),
                ("Demissão e Rescisões", 5454.25),
                ("13º Salário", 4023.32),
                ("FGTS (6 competências)", 3767.46),
                ("Vale Transporte (6 meses)", 1704.60),
                ("Uniformes", 1265.00),
                ("Salários Contratados", 800.00),
                ("Exames Ocupacionais", 440.00),
                ("Plano Odontológico", 109.21),
            ],
            "nota": None,
        },
        "Consumo": {
            "titulo1": "Despesas com", "titulo2": "consumo",
            "descricao": "Segunda maior categoria. Água e Esgoto representam a maior parte (69% do consumo), seguidos por Energia Elétrica das áreas comuns. Telefonia e Gás têm peso reduzido.",
            "serie_mensal": [55000, 42000, 52000, 53000, 47000, 57382],
            "lancamentos": [
                ("Água e Esgoto (fornecimento)", 211243.93),
                ("Energia Elétrica (áreas comuns)", 92287.43),
                ("Telefonia e Internet", 2093.23),
                ("Gás", 757.68),
            ],
            "nota": None,
        },
        "Serviços": {
            "titulo1": "Serviços", "titulo2": "contratados",
            "descricao": "Serviços terceirizados pontuais e recorrentes. Destaque para o Seguro Condominial (parcelas mensais), reparos de elevador e instrutor de atividade física.",
            "serie_mensal": [16000, 17000, 13000, 21000, 14000, 19060],
            "lancamentos": [
                ("Seguro Condominial (6 parcelas)", 20301.81),
                ("Reparos de Elevador", 15432.89),
                ("Atividade Física (instrutor)", 12411.23),
                ("Obras e Melhorias", 8266.75),
                ("Manutenção em geral", 5899.00),
                ("Higienização Caixa de Água", 5512.40),
                ("Recolhimento de Lixo (coleta seletiva)", 4422.06),
                ("Hidráulico e Reparo em Bombas", 4799.26),
                ("Reforma de Móveis e Utensílios", 3925.00),
                ("Consultoria e Auditoria", 3750.00),
                ("Demais serviços (ar cond., portão, etc.)", 15340.56),
            ],
            "nota": None,
        },
        "Manutenção": {
            "titulo1": "Contratos de", "titulo2": "manutenção",
            "descricao": "Contratos preventivos recorrentes que mantêm a operação do condomínio. CFTV e jardinagem lideram os custos, seguidos por elevador, piscina e fossa.",
            "serie_mensal": [20000, 19000, 17000, 19000, 11000, 11811],
            "lancamentos": [
                ("Locação e Manutenção de CFTV", 29692.50),
                ("Jardinagem (áreas verdes)", 15960.00),
                ("Elevador (contrato preventivo)", 11113.57),
                ("Piscina (contrato + adicional verão)", 9798.00),
                ("Caixa de Gordura, Fossa e Esgoto", 9669.74),
                ("Portaria Virtual e Monitoramento", 7311.75),
                ("Bombas (manutenção preventiva)", 5570.61),
                ("Extintor e Sistema de Incêndio", 3393.18),
                ("Consultoria de Engenharia", 3019.65),
                ("Academia", 2100.00),
                ("Desinsetização", 182.06),
            ],
            "nota": None,
        },
        "Materiais": {
            "titulo1": "Aquisição de", "titulo2": "materiais",
            "descricao": "Insumos e materiais para obras, manutenção e operação. Concentração em Dez/2025 por conta da compra de rodapés (obra de melhoria das áreas comuns).",
            "serie_mensal": [9000, 11000, 28000, 12000, 12000, 11842],
            "lancamentos": [
                ("Obras e Melhorias (rodapés)", 24683.24),
                ("Uso e Consumo do Condomínio", 8437.33),
                ("Construção e Ferramentas", 8370.14),
                ("Limpeza Piscina", 7934.22),
                ("Limpeza geral", 7835.02),
                ("Pintura", 6521.79),
                ("Elétrico", 6028.75),
                ("Elevador (proteção e peças)", 5413.33),
                ("Segurança Eletrônica", 3402.74),
                ("Confraternização (festa de natal)", 1456.72),
                ("Tags de Controle de Acesso", 1011.30),
                ("Demais materiais", 2748.13),
            ],
            "nota": None,
        },
        "Administrativo": {
            "titulo1": "Despesas", "titulo2": "administrativas",
            "descricao": "Gestão e governança do condomínio. Inclui a taxa da garantidora de crédito (parcelas mensais), honorários do síndico e da administradora, além de despesas pontuais.",
            "serie_mensal": [11000, 11000, 11000, 13000, 10000, 10263],
            "lancamentos": [
                ("Taxa da Garantidora de Crédito (6 parcelas)", 27087.52),
                ("Honorários Síndico", 18423.95),
                ("Honorários Administrativos (administradora)", 17851.68),
                ("Honorários Advocatícios", 1655.49),
                ("Material de Expediente", 610.16),
                ("Cartório (registro de ata)", 186.80),
                ("Certificado Digital", 180.00),
                ("Doação e Brindes (café fim de ano)", 160.00),
                ("Compra padaria (festa de natal)", 80.00),
                ("Correios", 27.65),
            ],
            "nota": None,
        },
        "Retenções": {
            "titulo1": "Retenções", "titulo2": "tributárias",
            "descricao": "Tributos retidos sobre notas fiscais de serviços. ISS sobre prestadores e DARF INSS-CRF sobre o contrato de mão de obra terceirizada.",
            "serie_mensal": [11000, 8000, 7000, 14000, 12000, 12305],
            "lancamentos": [
                ("DARF INSS-CRF", 42800.92),
                ("ISS (6 competências)", 21504.45),
            ],
            "nota": None,
        },
        "Investimento": {
            "titulo1": "Investimento e", "titulo2": "imobilizado",
            "descricao": "Aquisição de itens imobilizados. Containers de lixo (parcelados em 4 vezes), fogão da área kids, moto serra e tapeçaria das áreas comuns.",
            "serie_mensal": [2000, 500, 3000, 3500, 1000, 1909],
            "lancamentos": [
                ("Container de Lixo (4 parcelas)", 6723.34),
                ("Material de Decoração e Tapeçaria", 2241.95),
                ("Máquinas e Equipamentos (moto serra)", 1899.00),
                ("Eletrodoméstico (fogão área kids)", 1044.89),
            ],
            "nota": None,
        },
        "Financeiras": {
            "titulo1": "Despesas", "titulo2": "financeiras",
            "descricao": "Tarifas bancárias mensais (incluindo a tarifa da conta da garantidora) e IRRF retido automaticamente sobre os rendimentos da poupança.",
            "serie_mensal": [650, 650, 600, 800, 800, 764],
            "lancamentos": [
                ("Tarifas Bancárias - Garantidora (Outubro/2025)", 466.00),
                ("Tarifas Bancárias - Garantidora (Novembro/2025)", 466.00),
                ("Tarifas Bancárias - Garantidora (Dezembro/2025)", 466.00),
                ("Tarifas Bancárias - Garantidora (Janeiro/2026)", 466.00),
                ("Tarifas Bancárias - Garantidora (Fevereiro/2026)", 466.00),
                ("Tarifas Bancárias - Garantidora (Março/2026)", 466.00),
                ("Tarifas Bancárias (6 competências)", 185.10),
                ("IRRF Poupança (Outubro/2025)", 144.18),
                ("IRRF Poupança (Novembro/2025)", 153.21),
                ("IRRF Poupança (Janeiro/2026)", 302.91),
                ("IRRF Poupança (Fevereiro/2026)", 329.70),
                ("IRRF Poupança (Março/2026)", 353.33),
            ],
            "nota": None,
        },
        "Taxas": {
            "titulo1": "Taxas e", "titulo2": "recolhimentos",
            "descricao": "Taxa da Anotação de Responsabilidade Técnica (ART) junto ao Conselho Regional de Engenharia, referente ao serviço de manutenção do elevador. Lançamento único.",
            "serie_mensal": [0, 0, 0, 271.47, 0, 0],
            "lancamentos": [
                ("ART - Taxa Conselho Regional Engenharia (Elevador)", 271.47),
            ],
            "nota": None,
        },
    },

    # ---- Blocos (opcional). Lista vazia = sem divisores de bloco ----
    # cada bloco: {"num": "01", "titulo": "...", "sub": "...", "nota": "..."}
    "blocos": [],

    # ---- Certidoes (opcional). Lista vazia = sem secao de certidoes ----
    # cada certidao: {"num":"01","total":"06","titulo":"...","sub":"...",
    #                 "orgao":"...","validade":"...","ident":"...","img":"caminho.png"|None}
    "certidoes": [],
    "certidoes_rodape_extra": "",  # ex: " \u2022 AGO 25/04/2026"

    "saida": "/home/claude/Prestacao_Saida.pptx",
}

# =====================================================================
# PALETA E TIPOGRAFIA (FIXAS)
# =====================================================================
C_BG_DARK    = RGBColor(0x0A, 0x17, 0x33)
C_NAVY_DEEP  = RGBColor(0x0A, 0x24, 0x63)
C_NAVY       = RGBColor(0x14, 0x3A, 0x87)
C_BLUE       = RGBColor(0x1E, 0x5A, 0xA8)
C_BLUE_MID   = RGBColor(0x2E, 0x7B, 0xC7)
C_BLUE_LIGHT = RGBColor(0x52, 0x99, 0xDC)
C_BLUE_PALE  = RGBColor(0x7F, 0xB5, 0xE3)
C_GRAY_TEXT  = RGBColor(0x3E, 0x56, 0x76)
C_GRAY_MUTED = RGBColor(0x8B, 0x9A, 0xB8)
C_GRAY_BG    = RGBColor(0xF7, 0xF9, 0xFC)
# Tabela de lancamentos: tons calibrados para LEITURA EM PROJECAO (parede, sala
# clara). A zebra antiga (quase branco sobre branco) sumia de longe. Bandas com
# luminancia real + texto quase navy resolvem a legibilidade sem mudar layout.
C_ROW_BAND   = RGBColor(0xC5, 0xD8, 0xEE)  # linha impar: azul claro visivel
C_ROW_ALT    = RGBColor(0xE8, 0xF0, 0xF9)  # linha par: azul palido (antes era branco puro)
C_INK        = RGBColor(0x16, 0x27, 0x44)  # texto da tabela: quase navy/preto, le de longe
C_WHITE      = RGBColor(0xFF, 0xFF, 0xFF)
C_POSITIVE   = RGBColor(0x22, 0x8B, 0x54)
C_NEGATIVE   = RGBColor(0xC0, 0x3B, 0x3B)
C_AMBER       = RGBColor(0xE8, 0x8B, 0x1A)
C_AMBER_DEEP  = RGBColor(0xC4, 0x6E, 0x0A)
C_AMBER_LIGHT = RGBColor(0xFD, 0xE9, 0xCC)
FONT = "Calibri"

# Paleta de categorias verde->azul->cinza, gerada para N categorias (qualquer N)
_CAT_ANCHORS = [
    (0x1E, 0x73, 0x4A),  # verde escuro
    (0x35, 0x9E, 0x66),  # verde medio
    (0x14, 0x3A, 0x87),  # navy
    (0x1E, 0x5A, 0xA8),  # azul
    (0x2E, 0x7B, 0xC7),  # azul medio
    (0x52, 0x99, 0xDC),  # azul claro
    (0x5B, 0x6A, 0x88),  # cinza-azul escuro
    (0x7F, 0x8F, 0xA8),  # cinza-azul
    (0xA5, 0xB0, 0xC2),  # cinza claro
    (0xC2, 0xCB, 0xD8),  # cinza mais claro
]
def cat_colors(n):
    """Retorna n cores interpolando os anchors verde->azul->cinza. Funciona p/ qualquer n."""
    if n <= len(_CAT_ANCHORS):
        return [RGBColor(*_CAT_ANCHORS[i]) for i in range(n)]
    out = []
    for i in range(n):
        pos = i / (n - 1) * (len(_CAT_ANCHORS) - 1)
        lo = int(pos); hi = min(lo + 1, len(_CAT_ANCHORS) - 1); f = pos - lo
        c = tuple(int(_CAT_ANCHORS[lo][k] + (_CAT_ANCHORS[hi][k] - _CAT_ANCHORS[lo][k]) * f) for k in range(3))
        out.append(RGBColor(*c))
    return out

# =====================================================================
# HELPERS
# =====================================================================
def fmt_brl(v):
    s = f"{v:,.2f}"
    return "R$ " + s.replace(",", "X").replace(".", ",").replace("X", ".")
def fmt_brl_int(v):
    s = f"{v:,.0f}"
    return "R$ " + s.replace(",", ".")
def fmt_pct(v):
    return f"{v:.1f}".replace(".", ",") + "%"

def add_rect(slide, x, y, w, h, fill):
    sh = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    sh.fill.solid(); sh.fill.fore_color.rgb = fill
    sh.line.fill.background(); sh.shadow.inherit = False
    return sh
def add_rounded_rect(slide, x, y, w, h, fill, corner=0.05):
    sh = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h)
    sh.adjustments[0] = corner
    sh.fill.solid(); sh.fill.fore_color.rgb = fill
    sh.line.fill.background(); sh.shadow.inherit = False
    return sh
def add_oval(slide, x, y, w, h, fill):
    sh = slide.shapes.add_shape(MSO_SHAPE.OVAL, x, y, w, h)
    sh.fill.solid(); sh.fill.fore_color.rgb = fill
    sh.line.fill.background(); sh.shadow.inherit = False
    return sh
def add_text_box(slide, x, y, w, h, text, size=14, bold=False, color=C_GRAY_TEXT,
                 align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(x, y, w, h); tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = Emu(0); tf.margin_right = Emu(0); tf.margin_top = Emu(0); tf.margin_bottom = Emu(0)
    tf.vertical_anchor = anchor
    p = tf.paragraphs[0]; p.alignment = align
    r = p.add_run(); r.text = text
    r.font.name = FONT; r.font.size = Pt(size); r.font.bold = bold; r.font.color.rgb = color
    return tb
def add_multi_run(slide, x, y, w, h, runs, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(x, y, w, h); tf = tb.text_frame; tf.word_wrap = True
    tf.margin_left = Emu(0); tf.margin_right = Emu(0); tf.margin_top = Emu(0); tf.margin_bottom = Emu(0)
    tf.vertical_anchor = anchor
    p = tf.paragraphs[0]; p.alignment = align
    for text, size, bold, color in runs:
        r = p.add_run(); r.text = text
        r.font.name = FONT; r.font.size = Pt(size); r.font.bold = bold; r.font.color.rgb = color
    return tb
def add_line(slide, x1, y1, x2, y2, color, weight=1.0):
    ln = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, x1, y1, x2, y2)
    ln.line.color.rgb = color; ln.line.width = Pt(weight)
    return ln

def rodape_texto():
    base = CONFIG["rodape"]
    if CONFIG.get("cnpj"):
        base += "    \u2022    " + CONFIG["cnpj"]
    base += "    \u2022    EXERCÍCIO " + CONFIG["periodo_label"]
    return base
def add_footer(slide):
    add_text_box(slide, Inches(0.5), Inches(7.1), Inches(12.33), Inches(0.3),
                 rodape_texto(), size=9, color=C_GRAY_MUTED, align=PP_ALIGN.CENTER)
def add_header(slide, number, section, title_main, title_accent=None, subtitle=None):
    add_text_box(slide, Inches(0.5), Inches(0.4), Inches(10), Inches(0.3),
                 f"{number}    {section}", size=11, bold=True, color=C_BLUE_PALE)
    add_line(slide, Inches(0.5), Inches(0.78), Inches(1.0), Inches(0.78), C_BLUE_MID, 1.8)
    tb = slide.shapes.add_textbox(Inches(0.5), Inches(1.0), Inches(12.33), Inches(1.0))
    tf = tb.text_frame; tf.word_wrap = True; tf.margin_left = Emu(0); tf.margin_top = Emu(0)
    p = tf.paragraphs[0]
    r1 = p.add_run(); r1.text = title_main
    r1.font.name = FONT; r1.font.size = Pt(34); r1.font.bold = True; r1.font.color.rgb = C_NAVY
    if title_accent:
        r2 = p.add_run(); r2.text = " " + title_accent
        r2.font.name = FONT; r2.font.size = Pt(34); r2.font.bold = True; r2.font.color.rgb = C_BLUE_MID
    if subtitle:
        add_text_box(slide, Inches(0.5), Inches(1.95), Inches(12.33), Inches(0.4),
                     subtitle, size=14, color=C_GRAY_TEXT)
def style_axes(chart, dark=False, size=9):
    col = C_BLUE_PALE if dark else C_GRAY_TEXT
    for ax in [chart.category_axis, chart.value_axis]:
        try:
            ax.tick_labels.font.size = Pt(size)
            ax.tick_labels.font.name = FONT
            ax.tick_labels.font.color.rgb = col
        except Exception:
            pass
def find_logo():
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [os.path.join(here, "..", "assets", "logo_service_white.png"),
             os.path.join(here, "assets", "logo_service_white.png"),
             "/home/claude/logo_service_white.png"]
    for c in cands:
        if os.path.exists(c): return c
    return None

# =====================================================================
# DERIVADOS
# =====================================================================
# PATCH ORQUESTRACAO DE BLOCOS (Service Hub, 2026-06): derivados e montagem
# viraram funcoes parametrizadas para suportar N CONFIGs (um por sub-periodo)
# num mesmo deck, com capa unica e divisor + sequencia completa por bloco.
# Comportamento de CONFIG unico preservado via __main__. As funcoes de slide
# permanecem identicas ao upstream. Contribuir esta extensao de volta a skill.
SALDO_ANT = REC_TOTAL = DESP_TOTAL = SUPERAVIT = SALDO_FIM = 0.0
N = 1
COBERTURA = MARGEM = CRESC = 0.0
TEM_MENSAL = False
SUP_MES = []
MESES_POS = 0

def aplicar_config(cfg):
    """Define o CONFIG ativo e recalcula os derivados. Valida consistencia."""
    global CONFIG, SALDO_ANT, REC_TOTAL, DESP_TOTAL, SUPERAVIT, SALDO_FIM
    global N, COBERTURA, MARGEM, CRESC, TEM_MENSAL, SUP_MES, MESES_POS
    CONFIG = cfg
    SALDO_ANT = CONFIG["saldo_anterior"]
    REC_TOTAL = CONFIG["receita_total"]
    DESP_TOTAL = CONFIG["despesa_total"]
    SUPERAVIT = REC_TOTAL - DESP_TOTAL
    SALDO_FIM = SALDO_ANT + SUPERAVIT
    N = CONFIG["n_meses"]
    # Guardas de divisao por zero (achado da revisao): condominio novo pode
    # abrir o periodo com saldo zero; receita/despesa zerada ja barra no
    # parser, mas o template nao pode explodir com 500 opaco.
    COBERTURA = (REC_TOTAL / DESP_TOTAL * 100) if DESP_TOTAL else 0.0
    MARGEM = (SUPERAVIT / REC_TOTAL * 100) if REC_TOTAL else 0.0
    # Crescimento partindo de zero e indefinido: exibe 0% e os valores
    # absolutos (cards de saldo) contam a historia correta.
    CRESC = ((SALDO_FIM - SALDO_ANT) / SALDO_ANT * 100) if SALDO_ANT else 0.0
    TEM_MENSAL = bool(CONFIG.get("receitas_mes") and CONFIG.get("despesas_mes"))
    if TEM_MENSAL:
        SUP_MES = [r - d for r, d in zip(CONFIG["receitas_mes"], CONFIG["despesas_mes"])]
        MESES_POS = sum(1 for v in SUP_MES if v > 0)
    else:
        SUP_MES = []
        MESES_POS = 0

    # Validacoes (param se inconsistente). Tolerancia 0.02 alinhada com o
    # parser (0.011): a folga antiga de R$ 1,00 deixava passar furo de ate
    # R$ 0,99 sem ninguem ver (achado da revisao).
    TOL = 0.02
    assert abs(SALDO_ANT + REC_TOTAL - DESP_TOTAL - CONFIG["saldo_final"]) < TOL, "Falha: conservacao de caixa"
    assert abs(sum(v for _, v, _ in CONFIG["receitas_cat"]) - REC_TOTAL) < TOL, "Falha: soma receitas"
    assert abs(sum(v for _, v, _ in CONFIG["despesas_cat"]) - DESP_TOTAL) < TOL, "Falha: soma despesas"
    for cat, total, _ in CONFIG["despesas_cat"]:
        det = CONFIG.get("detalhes", {}).get(cat)
        if det and det.get("lancamentos"):
            soma = sum(v for _, v in det["lancamentos"])
            assert abs(soma - total) < TOL, f"Falha: soma lancamentos de {cat} ({soma:.2f} != {total:.2f})"

# =====================================================================
# DECK
# =====================================================================
prs = None
BLANK = None
LOGO = None

def dark_bg(slide):
    bg = add_rect(slide, 0, 0, prs.slide_width, prs.slide_height, C_BG_DARK)
    add_oval(slide, Inches(9.5), Inches(-2), Inches(6), Inches(6), RGBColor(0x16,0x2E,0x5E))
    add_oval(slide, Inches(10.5), Inches(4.5), Inches(4.5), Inches(4.5), RGBColor(0x13,0x28,0x54))

# ---------- CAPA ----------
def slide_capa():
    s = prs.slides.add_slide(BLANK); dark_bg(s)
    if LOGO:
        s.shapes.add_picture(LOGO, Inches(10.4), Inches(0.55), width=Inches(2.4), height=Inches(0.79))
    add_text_box(s, Inches(0.8), Inches(1.5), Inches(8), Inches(0.4), "PRESTAÇÃO DE CONTAS", 14, True, C_BLUE_PALE)
    tb = s.shapes.add_textbox(Inches(0.8), Inches(2.0), Inches(11), Inches(2.8))
    tf = tb.text_frame; tf.word_wrap = True; tf.margin_left = Emu(0)
    p1 = tf.paragraphs[0]; r1 = p1.add_run(); r1.text = CONFIG["cliente_linha1"]
    r1.font.name=FONT; r1.font.size=Pt(54); r1.font.bold=True; r1.font.color.rgb=C_WHITE
    p2 = tf.add_paragraph(); r2 = p2.add_run(); r2.text = CONFIG["cliente_linha2"]
    r2.font.name=FONT; r2.font.size=Pt(54); r2.font.bold=True; r2.font.color.rgb=C_BLUE_LIGHT
    add_line(s, Inches(0.8), Inches(5.15), Inches(2.0), Inches(5.15), C_AMBER, 3)
    add_text_box(s, Inches(0.8), Inches(5.45), Inches(11), Inches(0.4), CONFIG["exercicio_titulo"], 20, True, C_WHITE)
    # Suporta quebra de linha no subtitulo: decks multi-bloco poem
    # "Apresentação em Assembleia" em linha propria, como nas referencias.
    sub = CONFIG["periodo_extenso"]
    if "Apresentação em Assembleia" not in sub:
        sub += "  \u2022  Apresentação em Assembleia"
    suby = 5.95
    for linha in sub.split("\n"):
        add_text_box(s, Inches(0.8), Inches(suby), Inches(11), Inches(0.4),
                     linha, 13, False, C_BLUE_PALE)
        suby += 0.60

# ---------- VISAO GERAL ----------
def slide_visao_geral():
    s = prs.slides.add_slide(BLANK)
    add_header(s, "01", "VISÃO GERAL", "Resultado consolidado", "do exercício")
    ch = Inches(1.55); gap = Inches(0.2); left = Inches(0.5)
    r1y = Inches(2.2); r2y = Inches(3.95)
    cw3 = Inches((13.333-1.0-0.4)/3)
    mlbl = f"{N} meses"
    kpis = [("SALDO INICIAL", fmt_brl(SALDO_ANT), f"Em {CONFIG['data_inicial']}", C_BLUE),
            ("RECEITA TOTAL", fmt_brl(REC_TOTAL), mlbl, C_NAVY),
            ("DESPESA TOTAL", fmt_brl(DESP_TOTAL), mlbl, C_BLUE_MID)]
    x = left
    for label, val, sub, col in kpis:
        add_rounded_rect(s, x, r1y, cw3, ch, col, 0.08)
        add_text_box(s, x+Inches(0.25), r1y+Inches(0.18), cw3-Inches(0.5), Inches(0.3), label, 10, True, C_WHITE)
        add_text_box(s, x+Inches(0.25), r1y+Inches(0.5), cw3-Inches(0.5), Inches(0.7), val, 26, True, C_WHITE)
        add_text_box(s, x+Inches(0.25), r1y+Inches(1.2), cw3-Inches(0.5), Inches(0.3), sub, 11, False, C_BLUE_PALE)
        x += cw3 + gap
    cw2 = Inches((13.333-1.0-0.2)/2)
    add_rounded_rect(s, left, r2y, cw2, ch, C_POSITIVE, 0.08)
    add_text_box(s, left+Inches(0.25), r2y+Inches(0.18), cw2-Inches(0.5), Inches(0.3), "SUPERÁVIT DO PERÍODO", 10, True, C_WHITE)
    add_text_box(s, left+Inches(0.25), r2y+Inches(0.5), cw2-Inches(0.5), Inches(0.7), fmt_brl(SUPERAVIT), 30, True, C_WHITE)
    add_text_box(s, left+Inches(0.25), r2y+Inches(1.2), cw2-Inches(0.5), Inches(0.3), f"Margem de {fmt_pct(MARGEM)} sobre receitas", 11, False, C_WHITE)
    x2 = left + cw2 + gap
    add_rounded_rect(s, x2, r2y, cw2, ch, C_NAVY_DEEP, 0.08)
    add_text_box(s, x2+Inches(0.25), r2y+Inches(0.18), cw2-Inches(0.5), Inches(0.3), "SALDO FINAL", 10, True, C_WHITE)
    add_text_box(s, x2+Inches(0.25), r2y+Inches(0.5), cw2-Inches(0.5), Inches(0.7), fmt_brl(SALDO_FIM), 30, True, C_WHITE)
    add_text_box(s, x2+Inches(0.25), r2y+Inches(1.2), cw2-Inches(0.5), Inches(0.3), f"Reserva em caixa em {CONFIG['data_final']}", 11, False, C_BLUE_PALE)
    # faixa ambar 3 pilares
    dy = Inches(5.65)
    add_rounded_rect(s, left, dy, Inches(12.33), Inches(1.35), C_AMBER, 0.06)
    pw = Inches(12.33/3)
    def pilar(i, top_l, big, big_sz, bot_l):
        bx = left + pw*i
        add_text_box(s, bx+Inches(0.2), dy+Inches(0.12), pw-Inches(0.4), Inches(0.3), top_l, 10, True, C_WHITE, PP_ALIGN.CENTER)
        add_text_box(s, bx+Inches(0.2), dy+Inches(0.38), pw-Inches(0.4), Inches(0.7), big, big_sz, True, C_WHITE, PP_ALIGN.CENTER)
        add_text_box(s, bx+Inches(0.2), dy+Inches(1.08), pw-Inches(0.4), Inches(0.27), bot_l, 10, False, C_WHITE, PP_ALIGN.CENTER)
        if i < 2:
            add_line(s, left+pw*(i+1), dy+Inches(0.25), left+pw*(i+1), dy+Inches(1.1), C_WHITE, 0.8)
    pilar(0, "RECEITA COBRIU", f"{COBERTURA:.1f}".replace(".", ",")+"%", 46, "da despesa do período")
    pilar(1, "MARGEM DE", fmt_pct(MARGEM), 46, "sobre as receitas")
    if TEM_MENSAL:
        pilar(2, "MESES POSITIVOS", f"{MESES_POS} de {N}", 40, "todos com superávit" if MESES_POS==N else "com superávit")
    else:
        pilar(2, "SALDO EM CAIXA", f"+{CRESC:.0f}%", 40, f"de {fmt_brl_int(SALDO_ANT)} a {fmt_brl_int(SALDO_FIM)}")
    add_footer(s)

# ---------- EVOLUCAO MENSAL ----------
def slide_evolucao():
    if not TEM_MENSAL: return
    s = prs.slides.add_slide(BLANK)
    add_header(s, "02", "EVOLUÇÃO MENSAL", "Receitas e despesas", "mês a mês",
               subtitle="Movimentação mensal ao longo do período")
    cd = CategoryChartData(); cd.categories = CONFIG["meses_label"]
    cd.add_series("Receitas", CONFIG["receitas_mes"])
    cd.add_series("Despesas", CONFIG["despesas_mes"])
    gx = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.5), Inches(2.5), Inches(12.33), Inches(3.5), cd)
    ch = gx.chart; ch.has_title = False; ch.has_legend = True
    ch.legend.position = XL_LEGEND_POSITION.TOP; ch.legend.include_in_layout = False
    ch.legend.font.size = Pt(11); ch.legend.font.name = FONT
    pl = ch.plots[0]
    pl.series[0].format.fill.solid(); pl.series[0].format.fill.fore_color.rgb = C_POSITIVE
    pl.series[1].format.fill.solid(); pl.series[1].format.fill.fore_color.rgb = C_BLUE_MID
    for sr in pl.series: sr.format.line.fill.background()
    style_axes(ch)
    cy = Inches(6.15); cw = Inches((13.333-1.0-0.4)/3); chh = Inches(0.85)
    mr = REC_TOTAL/N; md = DESP_TOTAL/N
    cards = [("MÉDIA MENSAL DE RECEITA", fmt_brl(mr), C_POSITIVE),
             ("MÉDIA MENSAL DE DESPESA", fmt_brl(md), C_BLUE_MID),
             ("ECONOMIA MÉDIA MENSAL", fmt_brl(mr-md), C_NAVY)]
    x = Inches(0.5)
    for label, val, col in cards:
        add_rounded_rect(s, x, cy, cw, chh, col, 0.12)
        add_text_box(s, x+Inches(0.2), cy+Inches(0.08), cw-Inches(0.4), Inches(0.3), label, 9, True, C_WHITE)
        add_text_box(s, x+Inches(0.2), cy+Inches(0.35), cw-Inches(0.4), Inches(0.5), val, 18, True, C_WHITE)
        x += cw + Inches(0.2)
    add_footer(s)

# ---------- PATRIMONIO ----------
def slide_patrimonio(num="03"):
    s = prs.slides.add_slide(BLANK)
    add_header(s, num, "PATRIMÔNIO", "Evolução do saldo", "em caixa",
               subtitle="Crescimento consistente do patrimônio em caixa ao longo do período")
    if TEM_MENSAL:
        cd = CategoryChartData(); cd.categories = CONFIG["meses_label"]
        cd.add_series("Saldo", CONFIG["saldo_fim_mes"])
        gx = s.shapes.add_chart(XL_CHART_TYPE.LINE, Inches(0.5), Inches(2.6), Inches(8.3), Inches(3.9), cd)
        ch = gx.chart; ch.has_title=False; ch.has_legend=False
        sr = ch.plots[0].series[0]; sr.format.line.color.rgb = C_BLUE; sr.format.line.width = Pt(3.5)
        style_axes(ch)
    else:
        # comparativo barras antes/depois desenhado
        px, py, pw, ph = Inches(0.5), Inches(2.6), Inches(8.3), Inches(3.9)
        add_rounded_rect(s, px, py, pw, ph, RGBColor(0x12,0x22,0x48), 0.03)
        add_text_box(s, px+Inches(0.35), py+Inches(0.25), pw-Inches(0.7), Inches(0.3), "COMPARATIVO DO SALDO EM CAIXA", 11, True, C_AMBER)
        by = py + ph - Inches(0.7); mh = Inches(2.4)
        prop = (SALDO_ANT / SALDO_FIM) if SALDO_FIM else 0.0
        hi = Emu(int(mh.emu*prop)); bw = Inches(1.7); gp = Inches(1.3)
        bs = px + (pw - (bw*2+gp))/2
        b1 = add_rect(s, bs, by-hi, bw, hi, C_BLUE_MID)
        add_text_box(s, bs-Inches(0.3), by-hi-Inches(0.32), bw+Inches(0.6), Inches(0.28), fmt_brl_int(SALDO_ANT), 11, True, C_WHITE, PP_ALIGN.CENTER)
        add_text_box(s, bs-Inches(0.3), by+Inches(0.1), bw+Inches(0.6), Inches(0.25), "INÍCIO", 10, True, C_BLUE_PALE, PP_ALIGN.CENTER)
        b2x = bs+bw+gp
        add_rect(s, b2x, by-mh, bw, mh, C_AMBER)
        add_text_box(s, b2x-Inches(0.3), by-mh-Inches(0.32), bw+Inches(0.6), Inches(0.28), fmt_brl_int(SALDO_FIM), 11, True, C_WHITE, PP_ALIGN.CENTER)
        add_text_box(s, b2x-Inches(0.3), by+Inches(0.1), bw+Inches(0.6), Inches(0.25), "FIM", 10, True, C_AMBER, PP_ALIGN.CENTER)
        add_line(s, px+Inches(0.4), by, px+pw-Inches(0.4), by, C_BLUE_PALE, 0.5)
    cx = Inches(9.1); cw = Inches(3.7)
    add_rounded_rect(s, cx, Inches(2.6), cw, Inches(1.75), C_AMBER, 0.08)
    add_text_box(s, cx+Inches(0.25), Inches(2.8), cw-Inches(0.5), Inches(0.3), "CRESCIMENTO NO PERÍODO", 11, True, C_WHITE)
    add_text_box(s, cx+Inches(0.25), Inches(3.18), cw-Inches(0.5), Inches(1.1), f"+{CRESC:.1f}".replace(".", ",")+"%", 48, True, C_WHITE)
    for i,(lbl,val,col) in enumerate([
        (f"SALDO INICIAL ({CONFIG['meses_label'][0].upper()})" if TEM_MENSAL else "SALDO INICIAL", fmt_brl(SALDO_ANT), C_BLUE_LIGHT),
        (f"SALDO FINAL ({CONFIG['meses_label'][-1].upper()})" if TEM_MENSAL else "SALDO FINAL", fmt_brl(SALDO_FIM), C_BLUE_MID),
        ("DIFERENÇA / SUPERÁVIT", fmt_brl(SUPERAVIT), C_POSITIVE)]):
        yy = Inches(4.5 + i*0.75)
        add_rounded_rect(s, cx, yy, cw, Inches(0.65), col, 0.08)
        add_text_box(s, cx+Inches(0.25), yy+Inches(0.08), cw-Inches(0.5), Inches(0.22), lbl, 9, True, C_WHITE)
        add_text_box(s, cx+Inches(0.25), yy+Inches(0.3), cw-Inches(0.5), Inches(0.35), val, 15, True, C_WHITE)
    add_footer(s)

# ---------- SUPERAVIT MENSAL ----------
def slide_superavit(num="04"):
    if not TEM_MENSAL: return
    s = prs.slides.add_slide(BLANK)
    add_header(s, num, "RESULTADO LÍQUIDO", "Superávit mensal", "ao longo do período",
               subtitle="Resultado de cada mês (receitas menos despesas)")
    cd = CategoryChartData(); cd.categories = CONFIG["meses_label"]
    cd.add_series("Superávit", SUP_MES)
    gx = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.5), Inches(2.5), Inches(8.3), Inches(4.2), cd)
    ch = gx.chart; ch.has_title=False; ch.has_legend=False
    sr = ch.plots[0].series[0]; sr.format.fill.solid(); sr.format.fill.fore_color.rgb = C_BLUE; sr.format.line.fill.background()
    style_axes(ch)
    cx = Inches(9.1); cw = Inches(3.7)
    add_rounded_rect(s, cx, Inches(2.6), cw, Inches(1.9), C_POSITIVE, 0.08)
    add_text_box(s, cx+Inches(0.25), Inches(2.8), cw-Inches(0.5), Inches(0.3), "MESES POSITIVOS", 11, True, C_WHITE)
    add_multi_run(s, cx+Inches(0.25), Inches(3.2), cw-Inches(0.5), Inches(1.3),
                  [(f"{MESES_POS}", 80, True, C_WHITE), (f" de {N}", 22, False, C_WHITE)], anchor=MSO_ANCHOR.MIDDLE)
    add_rounded_rect(s, cx, Inches(4.65), cw, Inches(2.0), C_NAVY_DEEP, 0.08)
    add_text_box(s, cx+Inches(0.25), Inches(4.85), cw-Inches(0.5), Inches(0.3), "SUPERÁVIT DO PERÍODO", 11, True, C_WHITE)
    add_text_box(s, cx+Inches(0.25), Inches(5.25), cw-Inches(0.5), Inches(0.9), fmt_brl(SUPERAVIT), 26, True, C_WHITE)
    add_text_box(s, cx+Inches(0.25), Inches(6.25), cw-Inches(0.5), Inches(0.3), "Resultado positivo consolidado.", 10, False, C_BLUE_PALE)
    add_footer(s)

# ---------- ORIGEM DA RECEITA ----------
def slide_receita(num="05"):
    s = prs.slides.add_slide(BLANK)
    add_header(s, num, "ORIGEM DA RECEITA", "De onde veio", "a arrecadação",
               subtitle=f"Total: {fmt_brl(REC_TOTAL)}    \u2022    {CONFIG['periodo_extenso']}")
    add_text_box(s, Inches(0.5), Inches(2.7), Inches(4.5), Inches(0.5), fmt_brl_int(REC_TOTAL), 40, True, C_NAVY)
    add_text_box(s, Inches(0.5), Inches(3.55), Inches(4.5), Inches(0.3), "RECEITA TOTAL", 11, True, C_GRAY_MUTED)
    lst = CONFIG["receitas_cat"]; lx = Inches(5.2); lw = Inches(7.6)
    n = len(lst)
    # Calibrado pelas referencias aprovadas: avail 3.75 a partir de 2.45 faz a
    # lista terminar no maximo em 6.20, com folga para a faixa de insight em
    # 6.35 (o upstream usava 4.0/2.5 e invadia a faixa com 10+ fontes).
    avail = 3.75  # polegadas verticais p/ a lista
    rh = min(0.55, max(0.28, (avail - 0.05*(n-1)) / n))
    ly = 2.45
    for i,(fonte,val,pct) in enumerate(lst):
        y = Inches(ly + i*(rh+0.05))
        col = C_POSITIVE if i==0 else C_BLUE
        add_rounded_rect(s, lx, y, lw, Inches(rh), col, 0.15)
        add_text_box(s, lx+Inches(0.25), y+Inches(rh/2-0.13), Inches(3.6), Inches(0.26), fonte, 12 if n<=7 else 11, True, C_WHITE)
        add_text_box(s, lx+Inches(3.8), y+Inches(rh/2-0.12), Inches(2.2), Inches(0.26), fmt_brl(val), 10, False, C_WHITE)
        add_text_box(s, lx+Inches(5.9), y+Inches(rh/2-0.14), Inches(1.5), Inches(0.3), fmt_pct(pct), 13, True, C_WHITE, PP_ALIGN.RIGHT)
    if CONFIG.get("receita_insight"):
        dy = Inches(6.35)
        add_rounded_rect(s, Inches(0.5), dy, Inches(12.33), Inches(0.6), C_AMBER_LIGHT, 0.15)
        txt = CONFIG["receita_insight"]; pctk = CONFIG.get("receita_insight_pct","")
        if pctk and pctk in txt:
            a,b = txt.split(pctk,1)
            add_multi_run(s, Inches(0.8), dy+Inches(0.15), Inches(12), Inches(0.3),
                [(a,13,False,C_AMBER_DEEP),(pctk,14,True,C_AMBER_DEEP),(b,13,False,C_AMBER_DEEP)])
        else:
            add_text_box(s, Inches(0.8), dy+Inches(0.15), Inches(12), Inches(0.3), txt, 13, False, C_AMBER_DEEP)
    add_footer(s)

# ---------- ESTRUTURA DE DESPESAS ----------
def slide_estrutura(num="06"):
    s = prs.slides.add_slide(BLANK)
    lst = CONFIG["despesas_cat"]; n = len(lst)
    add_header(s, num, "ESTRUTURA DE DESPESAS", "Como a despesa", "foi distribuída",
               subtitle=f"Total: {fmt_brl(DESP_TOTAL)}    \u2022    {n} categorias")
    add_text_box(s, Inches(0.5), Inches(2.7), Inches(4.5), Inches(0.5), fmt_brl_int(DESP_TOTAL), 40, True, C_NAVY)
    add_text_box(s, Inches(0.5), Inches(3.55), Inches(4.5), Inches(0.3), "DESPESA TOTAL", 11, True, C_GRAY_MUTED)
    add_text_box(s, Inches(0.5), Inches(4.0), Inches(4.5), Inches(0.3), "Tons verdes: maior peso", 10, False, C_POSITIVE)
    add_text_box(s, Inches(0.5), Inches(4.25), Inches(4.5), Inches(0.3), "Tons azuis e cinzas: peso intermediário e menor", 10, False, C_GRAY_TEXT)
    colors = cat_colors(n)
    lx = Inches(5.2); lw = Inches(7.6)
    avail = 4.4
    rh = min(0.40, max(0.26, (avail - 0.05*(n-1)) / n))
    ly = 2.45
    fsz = 11 if n <= 11 else 10
    for i,(cat,val,pct) in enumerate(lst):
        y = Inches(ly + i*(rh+0.05))
        add_rounded_rect(s, lx, y, lw, Inches(rh), colors[i], 0.15)
        add_text_box(s, lx+Inches(0.25), y+Inches(rh/2-0.12), Inches(3.6), Inches(0.24), cat, fsz, True, C_WHITE)
        add_text_box(s, lx+Inches(3.8), y+Inches(rh/2-0.11), Inches(2.2), Inches(0.24), fmt_brl(val), 10, False, C_WHITE)
        add_text_box(s, lx+Inches(5.9), y+Inches(rh/2-0.13), Inches(1.5), Inches(0.28), fmt_pct(pct), 13, True, C_WHITE, PP_ALIGN.RIGHT)
    add_footer(s)

# ---------- DETALHAMENTO (1+ por categoria, paginado) ----------
# Fidelidade total: todas as rubricas da categoria sao exibidas. Quando a
# lista nao cabe num slide (mais de LANC_POR_PAGINA itens), a categoria e
# PAGINADA em slides consecutivos: card de resumo so no primeiro, titulo
# "(continuacao)" nos seguintes, faixa de total navy so no ultimo. Cada
# pagina passa pelo auditor individualmente.
LANC_POR_PAGINA = 20

def slide_detalhe(num, cat, total, pct):
    d = CONFIG["detalhes"].get(cat)
    if not d:
        d = {"titulo1": cat, "titulo2": "", "descricao": "", "serie_mensal": None, "lancamentos": [], "nota": None}
    lanc_total = d.get("lancamentos", [])
    paginas = [lanc_total[i:i + LANC_POR_PAGINA]
               for i in range(0, max(len(lanc_total), 1), LANC_POR_PAGINA)] or [[]]
    for idx_pag, pagina in enumerate(paginas):
        _detalhe_pagina(num, d, total, pct, pagina,
                        primeira=(idx_pag == 0), ultima=(idx_pag == len(paginas) - 1))

def _detalhe_pagina(num, d, total, pct, lanc, primeira, ultima):
    s = prs.slides.add_slide(BLANK)
    add_text_box(s, Inches(0.5), Inches(0.4), Inches(10), Inches(0.3), f"{num}    DETALHAMENTO DE DESPESAS", 11, True, C_BLUE_PALE)
    add_line(s, Inches(0.5), Inches(0.78), Inches(1.0), Inches(0.78), C_BLUE_MID, 1.8)
    tb = s.shapes.add_textbox(Inches(0.5), Inches(1.0), Inches(12.33), Inches(1.0))
    tf = tb.text_frame; tf.word_wrap=True; tf.margin_left=Emu(0); tf.margin_top=Emu(0)
    p = tf.paragraphs[0]
    r1 = p.add_run(); r1.text=d["titulo1"]; r1.font.name=FONT; r1.font.size=Pt(34); r1.font.bold=True; r1.font.color.rgb=C_NAVY
    if d.get("titulo2"):
        r2 = p.add_run(); r2.text=" "+d["titulo2"]; r2.font.name=FONT; r2.font.size=Pt(34); r2.font.bold=True; r2.font.color.rgb=C_BLUE_MID
    if not primeira:
        r3 = p.add_run(); r3.text="  (continuação)"
        r3.font.name=FONT; r3.font.size=Pt(20); r3.font.bold=False; r3.font.color.rgb=C_GRAY_MUTED
    # card esquerdo (so na primeira pagina da categoria)
    if primeira:
        cx, cy, cw, chh = Inches(0.5), Inches(2.15), Inches(5.2), Inches(4.75)
        add_rounded_rect(s, cx, cy, cw, chh, C_NAVY, 0.04)
        add_rect(s, cx+Inches(0.35), cy+Inches(0.35), Inches(0.5), Inches(0.12), C_AMBER)
        add_text_box(s, cx+Inches(0.35), cy+Inches(1.1), cw-Inches(0.7), Inches(0.3), "TOTAL DO GRUPO", 11, True, C_BLUE_PALE)
        add_text_box(s, cx+Inches(0.35), cy+Inches(1.45), cw-Inches(0.7), Inches(0.8), fmt_brl(total), 34, True, C_WHITE)
        add_text_box(s, cx+Inches(0.35), cy+Inches(2.28), cw-Inches(0.7), Inches(0.3), f"{fmt_pct(pct)} DA DESPESA DO PERÍODO", 10, True, C_BLUE_PALE)
        add_line(s, cx+Inches(0.35), cy+Inches(2.65), cx+Inches(1.35), cy+Inches(2.65), C_BLUE_LIGHT, 2)
        add_text_box(s, cx+Inches(0.35), cy+Inches(2.85), cw-Inches(0.7), Inches(1.0), d.get("descricao",""), 11, False, C_WHITE)
    sm = d.get("serie_mensal") if primeira else None
    if sm and TEM_MENSAL:
        add_text_box(s, cx+Inches(0.35), cy+Inches(3.75), cw-Inches(0.7), Inches(0.3), "DISTRIBUIÇÃO MENSAL", 10, True, C_BLUE_PALE)
        cd = CategoryChartData(); cd.categories = CONFIG["meses_ini"]; cd.add_series("M", sm)
        gx = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, cx+Inches(0.35), cy+Inches(4.05), cw-Inches(0.7), Inches(0.6), cd)
        ch = gx.chart; ch.has_title=False; ch.has_legend=False
        sr = ch.plots[0].series[0]; sr.format.fill.solid(); sr.format.fill.fore_color.rgb=C_WHITE; sr.format.line.fill.background()
        try: ch.value_axis.visible=False
        except Exception: pass
        try:
            ch.category_axis.tick_labels.font.size=Pt(7); ch.category_axis.tick_labels.font.color.rgb=C_BLUE_PALE
        except Exception: pass
    # tabela direita (recebe so os lancamentos desta pagina)
    tx, ty, tw = Inches(6.0), Inches(2.15), Inches(6.83)
    hh = Inches(0.45)
    add_rect(s, tx, ty, tw, hh, C_NAVY_DEEP)
    add_text_box(s, tx+Inches(0.3), ty+Inches(0.1), Inches(4), Inches(0.28), "LANÇAMENTOS DO PERÍODO", 10, True, C_WHITE)
    add_text_box(s, tx+tw-Inches(1.5), ty+Inches(0.1), Inches(1.2), Inches(0.28), "VALOR", 10, True, C_WHITE, PP_ALIGN.RIGHT)
    nL = max(len(lanc), 1)
    avail = Inches(4.30).emu; reserve = Inches(0.30).emu
    # Altura de linha calibrada pelas referencias aprovadas (medida nos decks
    # de referencia): teto de 0.42" (tabela curta nao estica) e piso de 0.17"
    # (fonte de 8pt para 17+ itens ja existe). Com 20 itens a 0.20" a faixa
    # de total termina exatamente na linha do rodape (7.10"). O max() puro do
    # upstream esticava tabelas curtas e estourava o slide nas longas.
    lh_emu = max(min(int((avail-reserve)/nL), Inches(0.42).emu), Inches(0.17).emu)
    lh = Emu(lh_emu)
    cur = ty + hh
    fd = 10 if nL<=12 else (9 if nL<=16 else 8)
    fv = 11 if nL<=12 else (10 if nL<=16 else 9)
    for i,(desc,val) in enumerate(lanc):
        # Banda em TODAS as linhas (nao so as impares) com tom visivel a distancia;
        # texto quase navy no lugar do cinza medio que lavava na projecao.
        add_rect(s, tx, cur, tw, lh, C_ROW_ALT if i%2==0 else C_ROW_BAND)
        add_text_box(s, tx+Inches(0.3), cur+Emu(int(lh_emu/2)-int(Inches(0.13).emu)), Inches(4.6), Inches(0.26), desc, fd, False, C_INK)
        add_text_box(s, tx+tw-Inches(1.8), cur+Emu(int(lh_emu/2)-int(Inches(0.13).emu)), Inches(1.5), Inches(0.26), fmt_brl(val), fv, True, C_NAVY_DEEP, PP_ALIGN.RIGHT)
        cur = cur + lh
    if ultima:
        add_rect(s, tx, cur+Inches(0.05), tw, Inches(0.45), C_NAVY)
        ttotal = f"TOTAL {d['titulo1'].upper()} {d.get('titulo2','').upper()}".strip()
        add_text_box(s, tx+Inches(0.3), cur+Inches(0.15), Inches(4.5), Inches(0.28), ttotal, 11, True, C_WHITE)
        add_text_box(s, tx+tw-Inches(2.0), cur+Inches(0.13), Inches(1.7), Inches(0.3), fmt_brl(total), 13, True, C_WHITE, PP_ALIGN.RIGHT)
    else:
        add_text_box(s, tx+Inches(0.3), cur+Inches(0.12), tw-Inches(0.6), Inches(0.28),
                     "continua no próximo slide", 9, False, C_GRAY_MUTED)
    # nota ambar opcional (so na primeira pagina, junto do card)
    if primeira and d.get("nota"):
        ny = Inches(6.95)
        add_rounded_rect(s, Inches(0.5), ny - Inches(0.85), Inches(5.2), Inches(0.8), C_AMBER_LIGHT, 0.08)
        add_text_box(s, Inches(0.65), ny - Inches(0.78), Inches(4.9), Inches(0.7), "\u26A0  " + d["nota"], 9, False, C_AMBER_DEEP)
    add_footer(s)

# ---------- BLOCO DIVISOR ----------
def slide_bloco(b):
    s = prs.slides.add_slide(BLANK); dark_bg(s)
    add_rounded_rect(s, Inches(0.8), Inches(1.9), Inches(2.2), Inches(0.55), C_AMBER, 0.15)
    add_text_box(s, Inches(0.8), Inches(2.03), Inches(2.2), Inches(0.3), f"BLOCO {b['num']}", 13, True, C_WHITE, PP_ALIGN.CENTER)
    add_text_box(s, Inches(0.8), Inches(2.9), Inches(11), Inches(1.0), b["titulo"], 48, True, C_WHITE)
    add_line(s, Inches(0.8), Inches(5.1), Inches(2.0), Inches(5.1), C_AMBER, 3)
    add_text_box(s, Inches(0.8), Inches(5.4), Inches(11), Inches(0.4), b.get("sub",""), 14, False, C_BLUE_PALE)
    if b.get("nota"):
        add_text_box(s, Inches(0.8), Inches(5.9), Inches(11), Inches(0.4), b["nota"], 12, False, C_AMBER)

# ---------- ENCERRAMENTO ----------
def slide_encerramento():
    s = prs.slides.add_slide(BLANK); dark_bg(s)
    add_text_box(s, Inches(0.5), Inches(0.4), Inches(10), Inches(0.3), "ENCERRAMENTO    \u2022    BALANÇO DO PERÍODO", 11, True, C_AMBER)
    add_line(s, Inches(0.5), Inches(0.78), Inches(1.0), Inches(0.78), C_AMBER, 1.8)
    tb = s.shapes.add_textbox(Inches(0.5), Inches(1.0), Inches(12.33), Inches(0.9))
    tf = tb.text_frame; tf.word_wrap=True; tf.margin_left=Emu(0); tf.margin_top=Emu(0)
    p = tf.paragraphs[0]
    r1 = p.add_run(); r1.text="O período em "; r1.font.name=FONT; r1.font.size=Pt(32); r1.font.bold=True; r1.font.color.rgb=C_WHITE
    r2 = p.add_run(); r2.text="números"; r2.font.name=FONT; r2.font.size=Pt(32); r2.font.bold=True; r2.font.color.rgb=C_AMBER
    add_text_box(s, Inches(0.5), Inches(1.85), Inches(12.33), Inches(0.35),
                 f"Como o patrimônio evoluiu de {CONFIG['periodo_label'].replace(' a ', ' a ')}", 13, False, C_BLUE_PALE)
    # painel grafico
    px, py, pw, ph = Inches(0.5), Inches(2.45), Inches(7.8), Inches(4.35)
    add_rounded_rect(s, px, py, pw, ph, RGBColor(0x12,0x22,0x48), 0.03)
    add_text_box(s, px+Inches(0.35), py+Inches(0.25), pw-Inches(0.7), Inches(0.3), "EVOLUÇÃO DO PATRIMÔNIO EM CAIXA", 11, True, C_AMBER)
    add_text_box(s, px+Inches(0.35), py+Inches(0.55), pw-Inches(0.7), Inches(0.3),
                 f"De {fmt_brl(SALDO_ANT)} para {fmt_brl(SALDO_FIM)}", 11, False, C_BLUE_PALE)
    if TEM_MENSAL:
        ly = py+Inches(0.88)
        add_rect(s, px+Inches(0.35), ly+Inches(0.08), Inches(0.2), Inches(0.06), C_AMBER)
        add_text_box(s, px+Inches(0.6), ly, Inches(2.5), Inches(0.22), "Saldo ao longo do período", 9, False, C_WHITE)
        add_rect(s, px+Inches(3.3), ly+Inches(0.08), Inches(0.2), Inches(0.06), C_BLUE_LIGHT)
        add_text_box(s, px+Inches(3.55), ly, Inches(3.0), Inches(0.22), "Ponto de partida (início)", 9, False, C_WHITE)
        cd = CategoryChartData(); cd.categories = CONFIG["meses_label"]
        cd.add_series("Saldo", CONFIG["saldo_fim_mes"])
        cd.add_series("Partida", [SALDO_ANT]*N)
        gx = s.shapes.add_chart(XL_CHART_TYPE.LINE, px+Inches(0.2), py+Inches(1.25), pw-Inches(0.4), ph-Inches(1.45), cd)
        ch = gx.chart; ch.has_title=False; ch.has_legend=False
        s1 = ch.plots[0].series[0]; s1.format.line.color.rgb=C_AMBER; s1.format.line.width=Pt(4)
        s2 = ch.plots[0].series[1]; s2.format.line.color.rgb=C_BLUE_LIGHT; s2.format.line.width=Pt(1.5)
        sp = s2.format.line._get_or_add_ln()
        pd = sp.find(qn('a:prstDash'))
        if pd is None:
            pd = sp.makeelement(qn('a:prstDash'), {'val':'dash'}); sp.append(pd)
        else: pd.set('val','dash')
        style_axes(ch, dark=True)
    else:
        by = py+ph-Inches(0.75); mh = Inches(2.4)
        prop = (SALDO_ANT/SALDO_FIM) if SALDO_FIM else 0.0
        hi = Emu(int(mh.emu*prop)); bw = Inches(1.6); gp = Inches(1.3)
        bs = px + (pw-(bw*2+gp))/2
        add_rect(s, bs, by-hi, bw, hi, C_BLUE_MID)
        add_text_box(s, bs-Inches(0.3), by-hi-Inches(0.32), bw+Inches(0.6), Inches(0.28), fmt_brl_int(SALDO_ANT), 11, True, C_WHITE, PP_ALIGN.CENTER)
        add_text_box(s, bs-Inches(0.3), by+Inches(0.1), bw+Inches(0.6), Inches(0.25), "INÍCIO", 9, True, C_BLUE_PALE, PP_ALIGN.CENTER)
        add_rect(s, bs+bw+gp, by-mh, bw, mh, C_AMBER)
        add_text_box(s, bs+bw+gp-Inches(0.3), by-mh-Inches(0.32), bw+Inches(0.6), Inches(0.28), fmt_brl_int(SALDO_FIM), 11, True, C_WHITE, PP_ALIGN.CENTER)
        add_text_box(s, bs+bw+gp-Inches(0.3), by+Inches(0.1), bw+Inches(0.6), Inches(0.25), "FIM", 9, True, C_AMBER, PP_ALIGN.CENTER)
        add_line(s, px+Inches(0.4), by, px+pw-Inches(0.4), by, C_BLUE_PALE, 0.5)
    # cards direita
    mx, mw = Inches(8.5), Inches(4.33)
    add_rounded_rect(s, mx, Inches(2.45), mw, Inches(2.1), RGBColor(0x12,0x22,0x48), 0.05)
    add_text_box(s, mx+Inches(0.25), Inches(2.6), mw-Inches(0.5), Inches(0.3), "RESULTADO DO EXERCÍCIO", 10, True, C_AMBER)
    add_text_box(s, mx+Inches(0.25), Inches(3.0), mw-Inches(0.5), Inches(0.7), fmt_brl(SUPERAVIT), 30, True, C_WHITE)
    add_text_box(s, mx+Inches(0.25), Inches(3.75), mw-Inches(0.5), Inches(0.6), "Superávit consolidado, com receita acima da despesa no período.", 11, False, C_BLUE_PALE)
    add_rounded_rect(s, mx, Inches(4.75), mw, Inches(1.05), C_AMBER, 0.06)
    add_text_box(s, mx+Inches(0.25), Inches(4.85), mw-Inches(0.5), Inches(0.22), "O CAIXA CRESCEU", 9, True, C_WHITE)
    add_text_box(s, mx+Inches(0.25), Inches(5.05), mw-Inches(0.5), Inches(0.7), f"+{CRESC:.1f}".replace(".", ",")+"%", 38, True, C_WHITE)
    add_rounded_rect(s, mx, Inches(5.9), mw, Inches(1.05), C_POSITIVE, 0.06)
    add_text_box(s, mx+Inches(0.25), Inches(6.0), mw-Inches(0.5), Inches(0.22), f"RECEITA COBRIU {COBERTURA:.1f}".replace(".", ",")+"% DA DESPESA", 9, True, C_WHITE)
    if TEM_MENSAL:
        add_multi_run(s, mx+Inches(0.25), Inches(6.28), mw-Inches(0.5), Inches(0.55),
                      [(f"{MESES_POS} de {N} meses", 26, True, C_WHITE), (" com superávit", 13, False, C_WHITE)])
    else:
        add_multi_run(s, mx+Inches(0.25), Inches(6.28), mw-Inches(0.5), Inches(0.55),
                      [("Margem de ", 13, False, C_WHITE), (fmt_pct(MARGEM), 26, True, C_WHITE), (" sobre receitas", 13, False, C_WHITE)])
    # tira antes/depois
    cyy = Inches(6.95); chh = Inches(0.4); twi = Inches(6.0)
    add_rounded_rect(s, Inches(0.5), cyy, twi, chh, RGBColor(0x2A,0x3A,0x5E), 0.2)
    add_multi_run(s, Inches(0.75), cyy+Inches(0.08), twi-Inches(0.5), Inches(0.28),
                  [("INÍCIO ", 9, True, C_BLUE_PALE), ("\u2022  Saldo em caixa: ", 10, False, C_WHITE), (fmt_brl(SALDO_ANT), 11, True, C_WHITE)])
    add_rounded_rect(s, Inches(6.83), cyy, twi, chh, C_AMBER, 0.2)
    add_multi_run(s, Inches(7.08), cyy+Inches(0.08), twi-Inches(0.5), Inches(0.28),
                  [("FIM ", 9, True, C_WHITE), ("\u2022  Saldo em caixa: ", 10, False, C_WHITE), (fmt_brl(SALDO_FIM), 11, True, C_WHITE)])

# ---------- CERTIDOES ----------
def slide_certidoes_capa():
    s = prs.slides.add_slide(BLANK); dark_bg(s)
    if LOGO:
        s.shapes.add_picture(LOGO, Inches(10.4), Inches(0.55), width=Inches(2.4), height=Inches(0.79))
    add_rounded_rect(s, Inches(0.8), Inches(1.9), Inches(2.7), Inches(0.55), C_AMBER, 0.15)
    add_text_box(s, Inches(0.8), Inches(2.03), Inches(2.7), Inches(0.3), "REGULARIDADE FISCAL", 13, True, C_WHITE, PP_ALIGN.CENTER)
    tb = s.shapes.add_textbox(Inches(0.8), Inches(2.9), Inches(11), Inches(1.0))
    tf = tb.text_frame; tf.word_wrap=True; tf.margin_left=Emu(0)
    p = tf.paragraphs[0]
    r1 = p.add_run(); r1.text="Certidões "; r1.font.name=FONT; r1.font.size=Pt(48); r1.font.bold=True; r1.font.color.rgb=C_WHITE
    r2 = p.add_run(); r2.text="Negativas"; r2.font.name=FONT; r2.font.size=Pt(48); r2.font.bold=True; r2.font.color.rgb=C_BLUE_LIGHT
    add_line(s, Inches(0.8), Inches(5.1), Inches(2.0), Inches(5.1), C_AMBER, 3)
    add_text_box(s, Inches(0.8), Inches(5.4), Inches(11.5), Inches(0.6),
                 "Documentação comprobatória da regularidade perante os órgãos federais, estaduais, municipais e trabalhistas.", 14, False, C_BLUE_PALE)

def slide_certidao(c):
    s = prs.slides.add_slide(BLANK)
    add_text_box(s, Inches(0.5), Inches(0.4), Inches(8), Inches(0.3), f"CERTIDÃO NEGATIVA {c['num']} / {c['total']}", 11, True, C_BLUE_PALE)
    add_line(s, Inches(0.5), Inches(0.78), Inches(1.0), Inches(0.78), C_BLUE_MID, 1.8)
    # print do documento a esquerda
    imgx, imgy, imgw = Inches(0.5), Inches(1.1), Inches(5.3)
    if c.get("img") and os.path.exists(c["img"]):
        try: s.shapes.add_picture(c["img"], imgx, imgy, width=imgw)
        except Exception: pass
    else:
        add_rounded_rect(s, imgx, imgy, imgw, Inches(5.5), C_GRAY_BG, 0.02)
        add_text_box(s, imgx, Inches(3.6), imgw, Inches(0.4), "[documento]", 12, False, C_GRAY_MUTED, PP_ALIGN.CENTER)
    # dados a direita
    rx = Inches(6.1)
    tb = s.shapes.add_textbox(rx, Inches(1.4), Inches(6.7), Inches(1.0))
    tf = tb.text_frame; tf.word_wrap=True; tf.margin_left=Emu(0)
    p = tf.paragraphs[0]; r = p.add_run(); r.text=c["titulo"]
    r.font.name=FONT; r.font.size=Pt(30); r.font.bold=True; r.font.color.rgb=C_NAVY
    add_text_box(s, rx, Inches(2.4), Inches(6.7), Inches(0.4), c.get("sub",""), 14, False, C_BLUE_MID)
    yy = 3.1
    for lbl,val in [("ÓRGÃO EMISSOR", c.get("orgao","")), ("VALIDADE", c.get("validade","")), ("IDENTIFICAÇÃO", c.get("ident",""))]:
        add_text_box(s, rx, Inches(yy), Inches(6.7), Inches(0.25), lbl, 10, True, C_GRAY_MUTED)
        add_text_box(s, rx, Inches(yy+0.25), Inches(6.7), Inches(0.35), val, 14, ("VALIDADE"==lbl), C_GRAY_TEXT if lbl!="VALIDADE" else C_NAVY)
        yy += 0.85
    box_y = Inches(5.7)
    add_rounded_rect(s, rx, box_y, Inches(6.7), Inches(1.0), RGBColor(0xEC,0xF6,0xEF), 0.05)
    add_text_box(s, rx+Inches(0.3), box_y+Inches(0.15), Inches(6.1), Inches(0.3), "\u2713  Nada consta em nome da associação.", 13, True, C_POSITIVE)
    add_text_box(s, rx+Inches(0.3), box_y+Inches(0.5), Inches(6.1), Inches(0.4), "Certidão verificada para apresentação nesta assembleia.", 11, False, C_GRAY_TEXT)
    rod = rodape_texto() + CONFIG.get("certidoes_rodape_extra","")
    add_text_box(s, Inches(0.5), Inches(7.1), Inches(12.33), Inches(0.3), rod, 9, C_GRAY_MUTED, PP_ALIGN.CENTER)

# =====================================================================
# MONTAGEM
# =====================================================================
def montar(configs, saida, capa=None):
    """Monta o deck a partir de uma lista de CONFIGs (um por bloco).

    configs: lista de CONFIGs completos. Com 1 item, deck identico ao
        comportamento original. Com N itens, capa unica + por bloco:
        divisor (cfg["bloco"]) + visao geral + evolucao (se serie) +
        patrimonio + superavit (se serie) + receita + estrutura +
        detalhamentos + encerramento. Numeracao reinicia a cada bloco.
    saida: caminho do PPTX gerado.
    capa: overrides opcionais p/ a capa (cliente_linha1/2, exercicio_titulo,
        periodo_extenso) quando o titulo do deck cobre o periodo completo.
    """
    global prs, BLANK, LOGO
    prs = Presentation()
    prs.slide_width = Inches(13.333); prs.slide_height = Inches(7.5)
    BLANK = prs.slide_layouts[6]
    LOGO = find_logo()

    multi = len(configs) > 1
    capa_cfg = dict(configs[0])
    if capa:
        capa_cfg.update(capa)
    aplicar_config(capa_cfg)
    slide_capa()

    for cfg in configs:
        aplicar_config(cfg)
        if multi and cfg.get("bloco"):
            slide_bloco(cfg["bloco"])
        elif not multi:
            for b in cfg.get("blocos", [])[:1]:
                slide_bloco(b)
        slide_visao_geral()
        slide_evolucao()
        slide_patrimonio("03")
        slide_superavit("04")
        slide_receita("05")
        slide_estrutura("06")
        det_num = 7
        for cat, total, pct in CONFIG["despesas_cat"]:
            slide_detalhe(str(det_num).zfill(2), cat, total, pct)
            det_num += 1
        slide_encerramento()

    certs = configs[-1].get("certidoes", [])
    if certs:
        slide_certidoes_capa()
        for c in certs:
            slide_certidao(c)

    prs.save(saida)
    print("OK", saida, "slides:", len(prs.slides))
    print(f"cobertura={COBERTURA:.1f} margem={MARGEM:.1f} cresc={CRESC:.1f} superavit={SUPERAVIT:.2f} saldofim={SALDO_FIM:.2f}")
    return saida

if __name__ == "__main__":
    montar([CONFIG], CONFIG["saida"])
