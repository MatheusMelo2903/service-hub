# -*- coding: utf-8 -*-
"""Parser determinístico do layout "Demonstrativo de Receitas e Despesas por
Período" do Superlógica (tipo interno W015P).

Por que um parser separado e não uma extensão do W011A/W015A:
- Este layout é uma MATRIZ MENSAL em paisagem (842x595): uma coluna por mês
  (N dinâmico: 3, 6 ou 12), mais Total e Média. Diferente do W011A (que tem
  corte de data, coluna derivada por subtração e saldo bancário) e do W015A
  (retrato, comparativo de dois períodos com coluna de variação).
- Não traz o código "W0xxA" no texto nem saldo bancário: só RECEITAS,
  DESPESAS e a linha RESULTADO Por Período (receita menos despesa por mês).
- A linha de GRUPO já vem com os valores (não há "Total de <cat>" fechando o
  grupo no fim), o que simplifica a máquina de estados em relação ao W011A.

Contrato para o pipeline (montar_config_multi_fonte): expõe os mesmos campos
que EstruturaW011A usa para a série mensal (meses_labels, receita_total_mes,
despesa_total_mes, saldo_anterior_mes, superavit_mes), com despesas já em
sinal positivo (igual ao contrato de _despesas_de_w011a). Como não há saldo
real, saldo_anterior=0 e saldo_final=resultado acumulado do período (mesma
convenção que o deck aprovado no Cowork usou: "partindo do início do período").
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field

import pdfplumber

# Regex monetário BR: aceita negativo e parênteses. Idêntico em intenção ao
# dos outros parsers; redefinido localmente para não acoplar módulos (mesma
# convenção que parser_w015a já adota em relação ao parser_w016a).
RE_DINHEIRO = re.compile(r"^-?\(?\d{1,3}(?:\.\d{3})*,\d{2}\)?$")

# Código do plano de contas. Item (3 segmentos) checado ANTES de grupo
# (2 segmentos) porque "1.01.01" também começa com "1.01".
RE_CODIGO_ITEM = re.compile(r"^(\d\.\d{2}\.\d{2})\s*-\s*(.+)$")
RE_CODIGO_GRUPO = re.compile(r"^(\d\.\d{2})\s*-\s*(.+)$")

# "Período: Janeiro / 2025 a Dezembro / 2025" (mês por extenso, com barra).
RE_PERIODO = re.compile(
    r"Per[ií]odo:\s*(\w+)\s*/\s*(\d{4})\s*a\s*(\w+)\s*/\s*(\d{4})",
    re.IGNORECASE,
)

# Cabeçalho/rodapé repetido em toda página do relatório (título, linha de
# período, rodapé de administradora, paginação). Sem esses filtros, uma linha
# de ruído sem valores seria colada na descrição do último lançamento.
RE_TIMESTAMP = re.compile(r"\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}:\d{2}")
RE_RUIDO = re.compile(
    r"^(Demonstrativo de|Per[ií]odo:|Administra[çc][aã]o de Condom|P[áa]g\.)",
    re.IGNORECASE,
)

MESES_EXTENSO_NUM = {
    "janeiro": 1, "fevereiro": 2, "março": 3, "marco": 3, "abril": 4,
    "maio": 5, "junho": 6, "julho": 7, "agosto": 8, "setembro": 9,
    "outubro": 10, "novembro": 11, "dezembro": 12,
}
MESES_ABREV = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
               "Jul", "Ago", "Set", "Out", "Nov", "Dez"]

# Nomes de grupo deste layout diferem em grafia dos outros parsers. Mapeia para
# o nome canônico usado em pipeline.TITULOS onde há equivalente; o que não
# casar cai no fallback (label.title()) com aviso em stderr, sem travar.
MAPA_CATEGORIA_W015P = {
    "DESPESAS COM PESSOAL": "Pessoal",
    "DESPESA COM PESSOAL": "Pessoal",
    "CONSUMO": "Consumo",
    "DESPESAS ADMINISTRATIVAS": "Administrativo",
    "DESPESA COM ADMINISTRATIVO": "Administrativo",
    "MANUTENÇÃO PREDIAL": "Manutenção",
    "MANUTENÇÃO": "Manutenção",
    "MANUTENÇÃO PERIÓDICA": "Manutenção Periódica",
    "SERVIÇOS": "Serviços",
    "AQUISIÇÃO DE MATERIAIS": "Materiais",
    "AQUISIÇÕES": "Aquisições",
    "IMPOSTOS": "Impostos",
    "CONSERVAÇÃO": "Conservação",
    "DESPESAS BANCÁRIAS": "Despesas Bancárias",
    "OBRA": "Obra",
    "OUTROS": "Outros",
}


def _e_ruido(label: str) -> bool:
    """True para linhas de cabeçalho/rodapé/paginação repetidas em toda página,
    que não podem ser coladas como continuação de descrição de lançamento."""
    if RE_RUIDO.match(label):
        return True
    if RE_TIMESTAMP.search(label):
        return True
    if "Administração de Condomínios" in label or "Administracao de Condominios" in label:
        return True
    # Linha de cabeçalho de colunas (anos + Total + Média).
    if "Total" in label and "Média" in label:
        return True
    return False


def _para_float(token: str) -> float:
    """Converte string monetária BR para float. (val) ou -val viram negativo."""
    neg = token.startswith("(") or token.startswith("-")
    limpo = token.strip("()").lstrip("-").replace(".", "").replace(",", ".")
    return -float(limpo) if neg else float(limpo)


@dataclass
class LancamentoW015P:
    descricao: str
    codigo: str
    total: float                                   # sinal já normalizado
    serie_mes: list = field(default_factory=list)  # N valores mensais


@dataclass
class GrupoW015P:
    categoria: str                                 # nome canônico p/ o deck
    codigo: str
    total: float = 0.0                             # despesa em sinal POSITIVO
    total_mes: list = field(default_factory=list)
    lancamentos: list = field(default_factory=list)


@dataclass
class EstruturaW015P:
    condominio: str = ""
    condominio_id: str = ""                         # não existe neste layout
    data_inicial: str = ""                          # "01/MM/AAAA"
    data_final: str = ""                            # "30/MM/AAAA"
    meses_labels: list = field(default_factory=list)  # ["Jan/2025", ...] (N)
    n_meses: int = 0
    # Receitas (achatadas no nível de item, igual ao W011A)
    receitas: list = field(default_factory=list)      # [LancamentoW015P]
    receita_total: float = 0.0
    receita_total_mes: list = field(default_factory=list)
    # Despesas (nível de grupo/categoria, sinal positivo)
    grupos: list = field(default_factory=list)        # [GrupoW015P]
    despesa_total: float = 0.0
    despesa_total_mes: list = field(default_factory=list)
    # Saldo SINTÉTICO (relatório não traz saldo bancário) — ver docstring.
    saldo_anterior: float = 0.0
    saldo_anterior_mes: list = field(default_factory=list)
    saldo_final: float = 0.0
    mov_liquido: float = 0.0
    superavit_mes: list = field(default_factory=list)  # RESULTADO Por Período


def _extrair_condominio(page) -> str:
    """Nome do condomínio: tokens do topo (top<30) à esquerda do título
    corrido "Demonstrativo de Receitas" (que fica em x0>=600)."""
    esquerda = [w for w in page.extract_words()
                if w["top"] < 30 and w["x0"] < 600]
    esquerda.sort(key=lambda w: w["x0"])
    return " ".join(w["text"] for w in esquerda).strip()


def _extrair_periodo(texto_pag1: str) -> tuple[int, int, int, int]:
    """(mes_ini, ano_ini, mes_fim, ano_fim) a partir da linha 'Período: ...'."""
    m = RE_PERIODO.search(texto_pag1)
    if not m:
        raise ValueError("w015p: linha de período não encontrada no cabeçalho")
    mes_ini = MESES_EXTENSO_NUM.get(m.group(1).lower())
    mes_fim = MESES_EXTENSO_NUM.get(m.group(3).lower())
    if not mes_ini or not mes_fim:
        raise ValueError(f"w015p: mês por extenso não reconhecido em '{m.group(0)}'")
    return mes_ini, int(m.group(2)), mes_fim, int(m.group(4))


def _gerar_labels(mes_ini: int, ano_ini: int, n: int) -> list:
    """Gera N rótulos 'Mmm/AAAA' sequenciais a partir do mês/ano inicial.
    Suporta período que cruza o ano (ex: Abr/2025 a Mar/2026)."""
    labels = []
    m, a = mes_ini, ano_ini
    for _ in range(n):
        labels.append(f"{MESES_ABREV[m - 1]}/{a}")
        m += 1
        if m > 12:
            m = 1
            a += 1
    return labels


def _linhas_da_pagina(page) -> list:
    """Agrupa tokens por linha (top) e devolve (label, [valores_float]).

    label = tokens não monetários juntos; valores = tokens monetários ordenados
    por x (esquerda p/ direita), preservando a ordem das colunas mensais.
    """
    palavras = page.extract_words()
    buckets: dict[int, list] = {}
    for w in palavras:
        buckets.setdefault(round(w["top"] / 3.0), []).append(w)

    linhas = []
    for chave in sorted(buckets):
        ws = sorted(buckets[chave], key=lambda w: w["x0"])
        label_parts = []
        valores = []  # (x0, valor)
        for w in ws:
            t = w["text"]
            if RE_DINHEIRO.match(t):
                valores.append((w["x0"], _para_float(t)))
            else:
                label_parts.append(t)
        valores.sort(key=lambda x: x[0])
        linhas.append((" ".join(label_parts).strip(), [v for _, v in valores]))
    return linhas


def _fatiar(valores: list, n: int) -> tuple[list, float | None]:
    """De uma linha com N+2 valores (N meses + Total + Média), devolve
    (serie_mensal[:N], total). Tolera linhas com contagem inesperada:
    usa os N primeiros como série e o (N+1)-ésimo como total quando existir."""
    serie = valores[:n]
    total = valores[n] if len(valores) > n else (sum(serie) if serie else None)
    # Completa com zeros se a linha vier curta (defensivo; não deve ocorrer
    # porque o relatório imprime 0,00 explícito em toda célula vazia).
    if len(serie) < n:
        serie = serie + [0.0] * (n - len(serie))
    return serie, total


def parsear(caminho_pdf: str) -> EstruturaW015P:
    """Parseia o PDF 'Demonstrativo por Período' e devolve EstruturaW015P."""
    est = EstruturaW015P()

    with pdfplumber.open(caminho_pdf) as pdf:
        pag1_texto = pdf.pages[0].extract_text() or ""
        est.condominio = _extrair_condominio(pdf.pages[0])
        m0, a0, m1, a1 = _extrair_periodo(pag1_texto)
        est.data_inicial = f"01/{m0:02d}/{a0}"
        est.data_final = f"30/{m1:02d}/{a1}"
        n = (a1 - a0) * 12 + (m1 - m0) + 1
        est.n_meses = n
        est.meses_labels = _gerar_labels(m0, a0, n)

        secao = None                # None | 'rec' | 'desp' | 'result'
        grupo_atual: GrupoW015P | None = None
        ultimo_lanc: LancamentoW015P | None = None

        for page in pdf.pages:
            for label, valores in _linhas_da_pagina(page):
                up = label.upper()

                # Transições de seção (linha só com o nome em CAIXA ALTA;
                # pode vir grudada com os nomes de mês do cabeçalho).
                if up.startswith("RECEITAS"):
                    secao = "rec"
                    grupo_atual = None
                    ultimo_lanc = None
                    continue
                if up.startswith("DESPESAS"):
                    secao = "desp"
                    grupo_atual = None
                    ultimo_lanc = None
                    continue
                if up.startswith("RESULTADO"):
                    secao = "result"
                    ultimo_lanc = None
                    continue

                # Ruído de página (título/período/rodapé) nunca vira dado nem
                # continuação de descrição.
                if _e_ruido(label):
                    continue

                # Totais explícitos das seções (fonte primária dos totais).
                if up.startswith("TOTAL DE RECEITAS"):
                    serie, total = _fatiar(valores, n)
                    est.receita_total_mes = [round(v, 2) for v in serie]
                    est.receita_total = round(total or 0.0, 2)
                    continue
                if up.startswith("TOTAL DE DESPESAS"):
                    serie, total = _fatiar(valores, n)
                    est.despesa_total_mes = [round(abs(v), 2) for v in serie]
                    est.despesa_total = round(abs(total or 0.0), 2)
                    continue

                # Linha RESULTADO Por Período → superávit mensal (mantém sinal).
                if secao == "result" and up.startswith("POR PERÍODO"):
                    serie, _ = _fatiar(valores, n)
                    est.superavit_mes = [round(v, 2) for v in serie]
                    continue

                # Item do plano de contas (3 segmentos).
                mi = RE_CODIGO_ITEM.match(label)
                if mi and secao in ("rec", "desp"):
                    codigo, desc = mi.group(1), mi.group(2).strip()
                    serie, total = _fatiar(valores, n)
                    if secao == "rec":
                        # Receitas: achatadas no nível de item, mantêm sinal
                        # (redutores como Desconto/Tarifa vêm negativos).
                        lanc = LancamentoW015P(desc, codigo, round(total or 0.0, 2),
                                               [round(v, 2) for v in serie])
                        est.receitas.append(lanc)
                        ultimo_lanc = lanc
                    elif grupo_atual is not None:
                        # Despesas: sinal positivo (abs uma única vez aqui).
                        lanc = LancamentoW015P(desc, codigo, round(abs(total or 0.0), 2),
                                               [round(abs(v), 2) for v in serie])
                        grupo_atual.lancamentos.append(lanc)
                        ultimo_lanc = lanc
                    continue

                # Grupo do plano de contas (2 segmentos).
                mg = RE_CODIGO_GRUPO.match(label)
                if mg and secao in ("rec", "desp"):
                    codigo, nome = mg.group(1), mg.group(2).strip()
                    if secao == "desp":
                        # Grupo de despesa já traz os valores da linha = total.
                        serie, total = _fatiar(valores, n)
                        cat = MAPA_CATEGORIA_W015P.get(nome.upper())
                        if cat is None:
                            cat = nome.title()
                            print(f"[w015p] categoria não mapeada: {nome!r} "
                                  f"(usando título genérico {cat!r})",
                                  file=sys.stderr)
                        grupo_atual = GrupoW015P(
                            categoria=cat, codigo=codigo,
                            total=round(abs(total or 0.0), 2),
                            total_mes=[round(abs(v), 2) for v in serie],
                        )
                        est.grupos.append(grupo_atual)
                        ultimo_lanc = None
                    # Grupos de receita (1.01/1.02/1.03) são subtotais: descarta
                    # (as receitas são consumidas item a item, igual ao W011A).
                    continue

                # Linha sem código e sem valores = continuação de descrição.
                if not valores and label and ultimo_lanc is not None:
                    ultimo_lanc.descricao = (ultimo_lanc.descricao + " " + label).strip()

    _finalizar_saldo(est, n)
    _validar(est)
    return est


def _finalizar_saldo(est: EstruturaW015P, n: int) -> None:
    """Sintetiza o saldo (relatório não traz saldo bancário) de forma coerente
    com a trava de conservação de caixa do template: saldo_anterior=0 e
    saldo_final=resultado acumulado. Série de saldo = soma corrida do superávit
    a partir de zero (mesma leitura 'partindo do início do período')."""
    if not est.superavit_mes:
        # Sem linha RESULTADO: deriva superávit de receita menos despesa por mês.
        rec = est.receita_total_mes or [0.0] * n
        desp = est.despesa_total_mes or [0.0] * n
        est.superavit_mes = [round(rec[i] - desp[i], 2) for i in range(n)]

    saldo_ant = []
    acumulado = 0.0
    for i in range(n):
        saldo_ant.append(round(acumulado, 2))
        acumulado += est.superavit_mes[i]
    est.saldo_anterior_mes = saldo_ant
    est.saldo_anterior = 0.0
    est.saldo_final = round(est.receita_total - est.despesa_total, 2)
    est.mov_liquido = est.saldo_final


def _validar(est: EstruturaW015P) -> None:
    """Sanidade interna. As somas que alimentam a trava de conservação de caixa
    do template (receitas e despesas) são BLOQUEANTES: divergência levanta
    ValueError, que o endpoint converte em 422 com revisão humana, em vez de
    deixar quebrar mais tarde como 500 cru no assert do template. O superávit é
    apenas cross-check (aviso em stderr), pois não alimenta assert duro."""
    tol = 1.00
    soma_rec = round(sum(l.total for l in est.receitas), 2)
    if abs(soma_rec - est.receita_total) > tol:
        raise ValueError(
            f"w015p: soma das receitas por item ({soma_rec}) nao fecha com o "
            f"Total de RECEITAS ({est.receita_total}); possivel coluna/linha "
            f"nao lida no PDF"
        )
    soma_desp = round(sum(g.total for g in est.grupos), 2)
    if abs(soma_desp - est.despesa_total) > tol:
        raise ValueError(
            f"w015p: soma dos grupos de despesa ({soma_desp}) nao fecha com o "
            f"Total de DESPESAS ({est.despesa_total}); possivel coluna/linha "
            f"nao lida no PDF"
        )
    resultado = round(est.receita_total - est.despesa_total, 2)
    soma_super = round(sum(est.superavit_mes), 2)
    if abs(soma_super - resultado) > tol:
        print(f"[w015p] AVISO: superávit acumulado ({soma_super}) difere de "
              f"receita menos despesa ({resultado})", file=sys.stderr)
