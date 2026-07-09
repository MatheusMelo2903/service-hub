# -*- coding: utf-8 -*-
"""Detector de tipo de relatório PDF do Superlógica.

Reconhece quatro layouts por ASSINATURA DE CONTEÚDO, não por orientação:
- W011A  — Demonstrativo comparativo mensal (paisagem, traz código no texto).
- W015A  — Consolidado com comparativo de dois períodos (retrato, código no texto).
- W016A  — Demonstrativo detalhado por período de datas (retrato, código no texto).
- W015P  — "Demonstrativo de Receitas e Despesas por Período": matriz mensal por
           plano de contas (paisagem, SEM código W0xxA no texto). Identificado
           pelo título único "por Período" e, como defesa, pela estrutura.

Ordem de decisão (da mais forte para a mais fraca):
1. Título único do W015P ("Demonstrativo ... por Período") no cabeçalho.
2. Código W0xxA na primeira linha do cabeçalho (top < 50).
3. Código W0xxA em qualquer lugar do texto da 1ª página.
4. Bateria estrutural (marcadores textuais + orientação) para PDF sem código.
5. Nenhuma assinatura casou → DESCONHECIDO, com aviso claro no stderr.

Regra que mudou: o fallback cego "paisagem vira W011A" foi removido. Um PDF
paisagem só é W011A se casar assinatura (código ou estrutura); caso contrário
retorna DESCONHECIDO, para acionar revisão humana em vez de classificar errado
em silêncio (que antes zerava a prestação sem ninguém perceber).
"""
from __future__ import annotations

import re
import sys
import traceback

import pdfplumber

# Códigos reconhecidos e sua ordem de tentativa.
CODIGOS_CONHECIDOS = ("W011A", "W015A", "W016A")

# W011A/W015P são paisagem (~842x595); W015A/W016A são retrato (~595x842).
LARGURA_PAISAGEM_MIN = 700

# Assinatura textual única do W015P (título do relatório).
RE_TITULO_W015P = re.compile(r"despesas\s+por\s+per[ií]odo", re.IGNORECASE)
# Código do plano de contas usado na bateria estrutural (ex: "1.01.01 - ...").
RE_PLANO_CONTAS = re.compile(r"^\d\.\d{2}(\.\d{2})?\s*-\s*\S", re.MULTILINE)


def _texto_cabecalho(page, linhas: int = 5) -> str:
    """Primeiras linhas do texto da página (região do título do relatório)."""
    texto = page.extract_text() or ""
    return "\n".join(texto.splitlines()[:linhas])


def _assinatura_estrutural(texto_up: str, paisagem: bool) -> str | None:
    """Palpite estrutural para PDF sem código no texto. Cada layout exige a
    combinação de marcadores + orientação que só ele apresenta."""
    tem_plano = len(RE_PLANO_CONTAS.findall(texto_up)) >= 5

    # W015P: matriz mensal com seções RECEITAS/DESPESAS em caixa alta, paisagem.
    if paisagem and tem_plano and "RECEITAS" in texto_up and "DESPESAS" in texto_up:
        return "W015P"
    # W011A: comparativo mensal em paisagem.
    if paisagem and "COMPARATIVO DE" in texto_up:
        return "W011A"
    # W015A: comparativo de dois períodos com coluna de variação, retrato.
    if not paisagem and "COMPARATIVO DE" in texto_up and "VARIAÇÃO" in texto_up:
        return "W015A"
    # W016A: demonstrativo detalhado por intervalo de datas, retrato.
    if not paisagem and "SALDO EM" in texto_up:
        return "W016A"
    return None


def detectar_tipo(caminho: str) -> str:
    """Retorna 'W011A', 'W015A', 'W016A', 'W015P' ou 'DESCONHECIDO'."""
    try:
        with pdfplumber.open(caminho) as pdf:
            if not pdf.pages:
                return "DESCONHECIDO"
            page = pdf.pages[0]
            paisagem = page.width >= LARGURA_PAISAGEM_MIN

            # 1. Título único do W015P (não tem código W0xxA no texto).
            if RE_TITULO_W015P.search(_texto_cabecalho(page)):
                return "W015P"

            # 2. Código na primeira linha do cabeçalho (top < 50).
            for w in page.extract_words():
                if w["top"] < 50:
                    for codigo in CODIGOS_CONHECIDOS:
                        if w["text"].upper() == codigo:
                            return codigo

            # 3. Código em qualquer lugar do texto da 1ª página.
            texto_up = (page.extract_text() or "").upper()
            for codigo in CODIGOS_CONHECIDOS:
                if codigo in texto_up:
                    return codigo

            # 4. Bateria estrutural (PDF sem código): marcadores + orientação.
            palpite = _assinatura_estrutural(texto_up, paisagem)
            if palpite:
                return palpite

            # 5. Nenhuma assinatura casou: não chuta. Avisa e pede revisão.
            print("[detector] nenhuma assinatura de layout reconhecida "
                  "(nem código nem estrutura); revisão humana necessária. "
                  f"orientacao={'paisagem' if paisagem else 'retrato'}",
                  file=sys.stderr)
            return "DESCONHECIDO"

    except Exception:
        print("[detector] ERRO ao detectar tipo do PDF:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return "DESCONHECIDO"
