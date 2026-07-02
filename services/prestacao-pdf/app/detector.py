# -*- coding: utf-8 -*-
"""Detector de tipo de relatório PDF do Superlógica.

Estratégia: lê o texto da primeira página e busca o código do relatório
("W011A", "W015A", "W016A") no início. Os três são "Demonstrativo de
Receitas e Despesas", então o texto de título não serve para distinguir —
só o código na primeira palavra do cabeçalho é suficiente.
Fallback por estrutura quando o código não aparece na posição esperada.
"""
from __future__ import annotations

import re
import sys
import traceback

import pdfplumber

# Códigos reconhecidos e sua ordem de tentativa no fallback.
CODIGOS_CONHECIDOS = ("W011A", "W015A", "W016A")

# W011A é paisagem (~842x595), W015A e W016A são retrato (~595x842).
# Essa heurística só é usada como fallback quando o código não está no texto.
LARGURA_PAISAGEM_MIN = 700


def detectar_tipo(caminho: str) -> str:
    """Retorna 'W011A', 'W015A', 'W016A' ou 'DESCONHECIDO'.

    Prioridade:
    1. Código na primeira linha do cabeçalho (x0 < 60, top < 50).
    2. Qualquer ocorrência do código no texto da 1ª página.
    3. Heurística de orientação (paisagem → W011A, retrato → W016A).
    """
    try:
        with pdfplumber.open(caminho) as pdf:
            if not pdf.pages:
                return "DESCONHECIDO"
            page = pdf.pages[0]
            largura = page.width

            # Tenta localizar o código nas palavras do cabeçalho (primeiras
            # palavras com top < 50 são tipicamente o nome do relatório).
            palavras = page.extract_words()
            for w in palavras:
                if w["top"] < 50:
                    for codigo in CODIGOS_CONHECIDOS:
                        if w["text"].upper() == codigo:
                            return codigo

            # Fallback: busca no texto completo da página
            texto = (page.extract_text() or "").upper()
            for codigo in CODIGOS_CONHECIDOS:
                if codigo in texto:
                    return codigo

            # Fallback por orientação: W011A é o único em paisagem
            if largura >= LARGURA_PAISAGEM_MIN:
                return "W011A"
            # Retrato sem código reconhecível: não temos como distinguir
            # W015A de W016A de forma confiável sem o código — retorna
            # DESCONHECIDO para acionar revisão humana.
            return "DESCONHECIDO"

    except Exception:
        # Loga o traceback no stderr para diagnóstico no Railway —
        # engolir silenciosamente dificulta rastrear falhas de PDF corrompido.
        print("[detector] ERRO ao detectar tipo do PDF:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return "DESCONHECIDO"
