"""Montagem em memória do objeto condomínio + unidades + pessoas.

Transforma os payloads crus da Superlógica nas linhas que a Camada A gravaria
(sem gravar nada na Fase 2). Calcula raw_hash por entidade. NÃO escreve no banco.

Mapeamento (campos do survey, seção 3):
  - unidade: id_unidade_uni, st_unidade_uni, st_bloco_uni
  - pessoa : proprietário embutido (id_proprietario, nome_proprietario) e,
             se a API trouxer um array `contatos`, os contatos extras
             (Inquilino, Dependente). É defensivo: usa o que existir no payload.
"""
from __future__ import annotations

from typing import Any

from .hashing import raw_hash


def _campo(d: dict, *nomes: str) -> Any:
    """Primeiro valor não vazio entre os nomes candidatos (case da Superlógica)."""
    for n in nomes:
        if isinstance(d, dict) and d.get(n) not in (None, ''):
            return d[n]
    return None


def montar_condominio(reg_cond: dict | None) -> dict:
    """Linha de condomínio que seria atualizada (raw_hash + carimbo)."""
    return {
        'raw_hash': raw_hash(reg_cond) if reg_cond else None,
        'campos_disponiveis': sorted(reg_cond.keys()) if isinstance(reg_cond, dict) else [],
    }


def montar_unidade(u: dict, condominio_id_uuid: str | None = None) -> dict:
    """Linha de unidade (chave natural + raw_hash do payload cru inteiro)."""
    return {
        'id_unidade_uni': _campo(u, 'id_unidade_uni', 'ID_UNIDADE_UNI'),
        'condominio_id': condominio_id_uuid,
        'st_unidade_uni': _campo(u, 'st_unidade_uni'),
        'st_bloco_uni': _campo(u, 'st_bloco_uni'),
        'raw_hash': raw_hash(u),
    }


def montar_pessoas(u: dict, unidade_id: Any) -> list[dict]:
    """Pessoas vinculadas à unidade. Proprietário embutido + contatos extras."""
    pessoas: list[dict] = []

    id_prop = _campo(u, 'id_proprietario')
    if id_prop is not None:
        pessoas.append({
            'id_contato_con': id_prop,
            'unidade_id': unidade_id,
            'tipo': 'Proprietário',
            'nome': _campo(u, 'nome_proprietario'),
            'raw_hash': raw_hash({
                'id': id_prop,
                'tipo': 'Proprietário',
                'nome': _campo(u, 'nome_proprietario'),
            }),
        })

    contatos = u.get('contatos')
    if isinstance(contatos, list):
        for c in contatos:
            if not isinstance(c, dict):
                continue
            id_c = _campo(c, 'id_contato_con', 'id_contato', 'ID_CONTATO_CON')
            if id_c is None or id_c == id_prop:
                continue
            pessoas.append({
                'id_contato_con': id_c,
                'unidade_id': unidade_id,
                'tipo': _campo(c, 'tipo', 'st_tipo', 'tipo_contato') or 'Contato',
                'nome': _campo(c, 'nome', 'st_nome', 'nome_contato'),
                'raw_hash': raw_hash(c),
            })

    return pessoas
