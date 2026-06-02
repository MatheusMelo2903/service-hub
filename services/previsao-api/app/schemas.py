"""Schemas Pydantic v2 para a resposta da API de Previsao Orcamentaria.

Estes modelos definem o contrato de saida do endpoint POST /extrair-pdfs.
Toda mudanca de schema requer atualizacao da versao em main.py (PARSER_VERSAO).
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class Lancamento(BaseModel):
    data: str   # DD/MM/AAAA
    descricao: str
    valor: float


class Subcategoria(BaseModel):
    id: str
    nome: str
    descritivo: str
    total_anual: float
    rateio: Literal['fracao-ideal', 'uso-real']
    lancamentos: list[Lancamento]


class Grupo(BaseModel):
    id: str
    nome: str
    ordem: int
    descritivo: str
    total_anual: float
    total_mensal: float
    peso_pct: float   # 0.0 a 1.0 — fracao do total_geral
    subcategorias: list[Subcategoria]


class ItemForaGrupo(BaseModel):
    data: str
    descricao: str
    valor: float
    motivo: Literal['divida-especifica', 'obra-extraordinaria', 'nao-classificado']


class Fracao(BaseModel):
    unidade: str
    fracao: float


class Metadados(BaseModel):
    parser_versao: str
    extraido_em: str   # ISO-8601 com timezone UTC
    duracao_ms: int


class PrevisaoResponse(BaseModel):
    condominio: str
    periodo: str
    total_geral: float
    total_mensal_medio: float
    moeda: Literal['BRL'] = 'BRL'
    grupos: list[Grupo]
    itens_fora_grupo: list[ItemForaGrupo]
    fracoes: list[Fracao]
    avisos: list[str]
    metadados: Metadados
