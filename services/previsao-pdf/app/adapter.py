"""Adapter do payload Fase 3 (PrevisaoResponse + reajustes_aplicados) pro
dict que o Builder do builder_pptx.py espera.

Os 8 grupos canonicos do payload mapeiam pros 8 nomes esperados pelo gerador
(ORDEM_CATEGORIAS_PADRAO no builder_pptx). Cada subcategoria vira um "item"
do builder. O lancamento individual NAO entra (granularidade subcategoria
e suficiente pros cards de detalhamento).
"""
from __future__ import annotations

from typing import Any

# Mapeamento id (Fase 3) -> nome canonico esperado pelo builder.
MAPA_GRUPO_NOME: dict[str, str] = {
    'despesas-financeiras': 'Despesas Financeiras',
    'funcionarios': 'Despesa com Funcionários',
    'administrativa': 'Despesa Administrativa',
    'consumo-taxas': 'Consumo e Taxas',
    'manutencao': 'Manutenção',
    'aquisicao-materiais': 'Aquisição de Materiais',
    'equipamentos': 'Equipamentos',
    'servicos': 'Serviços',
}

MESES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']


def adaptar(payload_json: dict, config_rateio: dict) -> dict[str, Any]:
    """Converte payload Fase 3 em dict do Builder. Levanta ValueError em estrutura invalida."""
    if 'grupos' not in payload_json or not isinstance(payload_json['grupos'], list):
        raise ValueError('payload_json sem grupos')

    reajustes = payload_json.get('reajustes_aplicados') or {}

    categorias = []
    for grupo in payload_json['grupos']:
        gid = grupo.get('id', '')
        nome_canon = MAPA_GRUPO_NOME.get(gid, grupo.get('nome', gid))
        reaj = float(reajustes.get(gid, 0.0))
        previsto = float(grupo.get('total_anual', 0.0))
        # Reverso: base = previsto / (1 + reaj). Se reaj=0, base = previsto.
        base = previsto / (1.0 + reaj) if abs(reaj) >= 1e-9 else previsto

        itens = []
        for sub in (grupo.get('subcategorias') or []):
            sub_prev = float(sub.get('total_anual', 0.0))
            sub_base = sub_prev / (1.0 + reaj) if abs(reaj) >= 1e-9 else sub_prev
            itens.append({
                'nome': sub.get('nome', ''),
                'base': round(sub_base, 2),
                'previsto': round(sub_prev, 2),
                'reajuste_pct': round(reaj, 6),
            })

        categorias.append({
            'nome': nome_canon,
            'base': round(base, 2),
            'previsto': round(previsto, 2),
            'reajuste_pct': round(reaj, 6),
            'tem_reajuste': abs(reaj) >= 1e-4,
            'itens': itens,
        })

    base_anual = round(sum(c['base'] for c in categorias), 2)
    previsto = round(float(payload_json.get('total_geral', 0.0)), 2)

    apartamentos = int(config_rateio.get('apartamentos', 0))
    coberturas = int(config_rateio.get('coberturas', 0))
    fator = float(config_rateio.get('fator_cobertura', 1.5))
    unid_equiv = apartamentos + coberturas * fator

    # Distribuicao uniforme de mensal - o builder usa pra grafico mensal.
    mensal = previsto / 12.0 if previsto else 0.0

    return {
        'condominio': payload_json.get('condominio', ''),
        'base_anual': base_anual,
        'previsto': previsto,
        'fundo_reserva': float(config_rateio.get('fundo_reserva', 0.0)),
        'fundo_pct': float(config_rateio.get('fundo_pct', 0.05)),
        'apartamentos': apartamentos,
        'coberturas': coberturas,
        'fator_cobertura': fator,
        'unid_equiv': unid_equiv,
        'categorias': categorias,
        'previsao_mensal': [round(mensal, 2)] * 12,
        'meses': MESES_ABREV[:],
    }
