# -*- coding: utf-8 -*-
"""Parser determinístico do W016A detalhado (Superlógica) — sem LLM.

Estratégia (validada na verificação da Fase 1):
- Extração por palavra com coordenada (x, y) via pdfplumber. O valor da linha
  é a última palavra com formato monetário, posicionada na coluna da direita
  (x acima de 78% da largura da página). Regex ingênua de linha NÃO funciona:
  descrições contêm valores no meio ("obs: R$300,00 referente troca de areia").
- Parse por seção, ancorando nos cabeçalhos do próprio relatório: "Receitas",
  "Despesas", cabeçalhos de grupo em caixa alta ("DESPESA COM PESSOAL"...),
  e fechamentos "Total de <GRUPO>". A categoria de cada lançamento vem do
  cabeçalho de grupo, NUNCA do texto da descrição (o mesmo conceito aparece
  em categorias diferentes, ex. Segurança Eletrônica em três grupos).
- Subgrupos aninhados (ex. "Obra" dentro de SERVIÇOS, com "Total de Obra"
  próprio) são atravessados: os itens pertencem ao grupo externo e o
  subtotal interno é ignorado.
- Linha sem valor que não é cabeçalho nem total é continuação da descrição
  anterior (wrap de texto do relatório).
- A soma dos itens de cada grupo é validada contra o "Total de <GRUPO>" do
  próprio relatório (tolerância R$ 0,01 acumulada em 1 centavo por item).

Saída: EstruturaW016A com identificação, período, saldos, totais, receitas
linha a linha e grupos de despesa com todos os lançamentos crus.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

import pdfplumber

RE_DINHEIRO = re.compile(r"^\(?\d{1,3}(?:\.\d{3})*,\d{2}\)?$")
RE_PERIODO = re.compile(r"De (\d{2}/\d{2}/\d{4}) até (\d{2}/\d{2}/\d{4})")
RE_SALDO = re.compile(r"^Saldo em (\d{2}/\d{2}/\d{4})$")
RE_TOTAL_GRUPO = re.compile(r"^Total de (.+)$")
RE_RODAPE = re.compile(r"Rua das Acerolas|\(27\) 3066|^\d+ de \d+$|^Condomínio Service$")
RE_CABECALHO_PAG = re.compile(r"^W016A |^Demonstrativo de Receitas|^Valor$")

# Mapa cabeçalho do W016A -> rótulo curto de categoria do deck (golden Fase 1).
# Cabeçalho desconhecido permanece com o nome do relatório (data-driven).
MAPA_CATEGORIA = {
    "DESPESAS FINANCEIRAS": "Financeiras",
    "DESPESA COM PESSOAL": "Pessoal",
    "RETENÇÕES -NOTAS FISCAIS": "Retenções",
    "RETENÇÕES - NOTAS FISCAIS": "Retenções",
    "DESPESA COM ADMINISTRATIVO": "Administrativo",
    "DESPESAS COM CONSUMO": "Consumo",
    "MANUTENÇÃO": "Manutenção",
    "AQUISIÇÃO DE MATERIAIS": "Materiais",
    "SERVIÇOS": "Serviços",
    "INVESTIMENTO-IMOBILIZADO": "Investimento",
    "TAXAS E RECOLHIMENTOS": "Taxas",
}

MESES_EXTENSO = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
                 "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]
MESES_ABREV = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN",
               "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"]


@dataclass
class Lancamento:
    descricao: str
    valor: float


@dataclass
class GrupoDespesa:
    nome_relatorio: str          # cabeçalho original do W016A
    categoria: str               # rótulo curto do deck
    lancamentos: list = field(default_factory=list)
    total: float = 0.0           # "Total de <GRUPO>" do relatório


@dataclass
class EstruturaW016A:
    cliente: str = ""
    data_inicial: str = ""
    data_final: str = ""
    n_meses: int = 0
    saldo_anterior: float = 0.0
    saldo_final: float = 0.0
    receita_total: float = 0.0
    despesa_total: float = 0.0
    mov_liquido: float = 0.0
    receitas: list = field(default_factory=list)      # [Lancamento]
    grupos: list = field(default_factory=list)        # [GrupoDespesa]


def _para_float(token: str) -> float:
    neg = token.startswith("(")
    v = float(token.strip("()").replace(".", "").replace(",", "."))
    return -v if neg else v


def _e_caixa_alta(texto: str) -> bool:
    """Cabeçalho de grupo: linha sem minúsculas (acentos contam como maiúsculas)."""
    letras = [c for c in texto if c.isalpha()]
    return bool(letras) and all(not c.islower() for c in letras)


def _linhas_da_pagina(page):
    """Reconstrói linhas (texto, valor) a partir das palavras com coordenadas."""
    palavras = page.extract_words()
    limite_valor_x = page.width * 0.78
    buckets = {}
    for w in palavras:
        chave = round(w["top"] / 3.0)
        buckets.setdefault(chave, []).append(w)
    linhas = []
    for chave in sorted(buckets):
        ws = sorted(buckets[chave], key=lambda w: w["x0"])
        ultimo = ws[-1]
        valor = None
        if RE_DINHEIRO.match(ultimo["text"]) and ultimo["x1"] >= limite_valor_x:
            valor = _para_float(ultimo["text"])
            ws = ws[:-1]
        texto = " ".join(w["text"] for w in ws).strip()
        linhas.append((texto, valor))
    return linhas


def _meses_entre(d0: str, d1: str) -> int:
    m0, a0 = int(d0[3:5]), int(d0[6:10])
    m1, a1 = int(d1[3:5]), int(d1[6:10])
    return (a1 - a0) * 12 + (m1 - m0) + 1


def parsear(caminho_pdf: str) -> EstruturaW016A:
    est = EstruturaW016A()
    secao = None          # None -> 'receitas' -> 'despesas' -> 'fim'
    grupo_atual = None
    subgrupos = []        # pilha de subgrupos aninhados (ex. "Obra")
    aguardando_saldo = None  # data do "Saldo em <data>" cuja linha de valor vem junto

    with pdfplumber.open(caminho_pdf) as pdf:
        for page in pdf.pages:
            if secao == "fim":
                break
            for texto, valor in _linhas_da_pagina(page):
                if not texto and valor is None:
                    continue
                if RE_RODAPE.search(texto):
                    continue
                if texto.startswith("Resumo Financeiro"):
                    secao = "fim"
                    break
                if texto.startswith("W016A"):
                    if not est.cliente:
                        nome = re.sub(r"^W016A\s+", "", texto)
                        est.cliente = re.sub(r"\s*\(\d+\)\s*$", "", nome).strip()
                    continue
                if RE_CABECALHO_PAG.match(texto):
                    m = RE_PERIODO.search(texto)
                    if m:
                        est.data_inicial, est.data_final = m.group(1), m.group(2)
                    continue
                m = RE_PERIODO.search(texto)
                if m and not est.data_inicial:
                    est.data_inicial, est.data_final = m.group(1), m.group(2)
                    continue

                # Saldos (inicial antes de Receitas, final depois de Despesas)
                m = RE_SALDO.match(texto)
                if m and valor is not None:
                    if secao is None:
                        est.saldo_anterior = valor
                    else:
                        est.saldo_final = valor
                        secao = "fim"
                        break
                    continue

                if texto == "Receitas":
                    secao = "receitas"
                    continue
                if texto == "Despesas":
                    secao = "despesas"
                    continue

                m = RE_TOTAL_GRUPO.match(texto)
                if m and valor is not None:
                    alvo = m.group(1).strip()
                    if alvo == "Receitas":
                        est.receita_total = valor
                    elif alvo == "Despesas":
                        est.despesa_total = valor
                        grupo_atual = None
                    elif subgrupos and alvo == subgrupos[-1]:
                        subgrupos.pop()          # subtotal interno: ignorar
                    elif grupo_atual is not None and alvo == grupo_atual.nome_relatorio:
                        grupo_atual.total = valor
                        est.grupos.append(grupo_atual)
                        grupo_atual = None
                        subgrupos = []
                    continue

                if texto.startswith("Mov. Líquido") and valor is not None:
                    est.mov_liquido = valor
                    continue

                if secao == "receitas":
                    if valor is not None:
                        est.receitas.append(Lancamento(texto, valor))
                    elif est.receitas:
                        est.receitas[-1].descricao += " " + texto
                    continue

                if secao == "despesas":
                    if valor is None:
                        if _e_caixa_alta(texto):
                            grupo_atual = GrupoDespesa(
                                nome_relatorio=texto,
                                categoria=MAPA_CATEGORIA.get(texto, texto.title()),
                            )
                            subgrupos = []
                        elif grupo_atual is not None and len(texto.split()) <= 3 and all(p[:1].isupper() for p in texto.split() if p[:1].isalpha()):
                            # palavra(s) capitalizada(s) curta(s) sem valor:
                            # subgrupo aninhado (ex. "Obra" dentro de SERVIÇOS)
                            subgrupos.append(texto)
                        elif grupo_atual is not None and grupo_atual.lancamentos:
                            grupo_atual.lancamentos[-1].descricao += " " + texto
                        continue
                    if grupo_atual is not None:
                        grupo_atual.lancamentos.append(Lancamento(texto, valor))
                    continue

    # Derivados e validações estruturais do próprio relatório
    if est.data_inicial and est.data_final:
        est.n_meses = _meses_entre(est.data_inicial, est.data_final)

    # Valores monetários são decimais exatos: as somas fecham ao centavo.
    # Tolerância fixa de R$ 0,01 só para ruído de float.
    erros = []
    if abs(est.saldo_anterior + est.receita_total - est.despesa_total - est.saldo_final) > 0.011:
        erros.append("conservacao de caixa nao fecha")
    soma_rec = sum(l.valor for l in est.receitas)
    if abs(soma_rec - est.receita_total) > 0.011:
        erros.append(f"soma receitas {soma_rec:.2f} != total {est.receita_total:.2f}")
    soma_desp = sum(g.total for g in est.grupos)
    if abs(soma_desp - est.despesa_total) > 0.011:
        erros.append(f"soma grupos {soma_desp:.2f} != total despesas {est.despesa_total:.2f}")
    for g in est.grupos:
        soma_g = sum(l.valor for l in g.lancamentos)
        if abs(soma_g - g.total) > 0.011:
            erros.append(f"grupo {g.nome_relatorio}: itens {soma_g:.2f} != total {g.total:.2f}")
    if erros:
        raise ValueError("W016A inconsistente: " + "; ".join(erros))
    return est


def rotulos_periodo(est: EstruturaW016A) -> dict:
    """Deriva os rótulos de período do CONFIG a partir das datas reais."""
    m0, a0 = int(est.data_inicial[3:5]), int(est.data_inicial[6:10])
    m1, a1 = int(est.data_final[3:5]), int(est.data_final[6:10])
    label = f"{MESES_ABREV[m0-1]}/{a0} a {MESES_ABREV[m1-1]}/{a1}"
    return {
        "periodo_label": label,
        "periodo_extenso": f"{MESES_EXTENSO[m0-1]} de {a0} a {MESES_EXTENSO[m1-1]} de {a1}",
        "exercicio_titulo": f"Exercício {label}",
        "n_meses": est.n_meses,
        "data_inicial": est.data_inicial,
        "data_final": est.data_final,
    }
