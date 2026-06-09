from app.adapter import MAPA_GRUPO_NOME, adaptar


def _payload_mock():
    return {
        'condominio': 'Residencial Mock',
        'periodo': 'Mai/2025 a Abr/2026',
        'total_geral': 100_000.0,
        'total_mensal_medio': 8_333.33,
        'moeda': 'BRL',
        'reajustes_aplicados': {'funcionarios': 0.05},
        'grupos': [
            {
                'id': gid, 'nome': nome, 'ordem': i + 1,
                'descritivo': '...',
                'total_anual': 12_500.0,
                'total_mensal': 1_041.67,
                'peso_pct': 0.125,
                'subcategorias': [
                    {'id': 'sub1', 'nome': 'Sub 1', 'descritivo': '', 'total_anual': 12_500.0, 'rateio': 'fracao-ideal', 'lancamentos': []},
                ],
            }
            for i, (gid, nome) in enumerate(MAPA_GRUPO_NOME.items())
        ],
        'itens_fora_grupo': [],
        'fracoes': [],
        'avisos': [],
        'metadados': {'parser_versao': '1.1.0', 'extraido_em': '2026-06-02T00:00:00Z', 'duracao_ms': 100},
    }


def _config_mock():
    return {'apartamentos': 24, 'coberturas': 2, 'fator_cobertura': 1.5, 'fundo_reserva': 0.0, 'fundo_pct': 0.05}


def test_adapter_retorna_8_categorias():
    dados = adaptar(_payload_mock(), _config_mock())
    assert len(dados['categorias']) == 8


def test_adapter_categoria_com_reajuste():
    dados = adaptar(_payload_mock(), _config_mock())
    func = next(c for c in dados['categorias'] if c['nome'] == 'Despesa com Funcionários')
    assert func['tem_reajuste'] is True
    assert func['reajuste_pct'] == 0.05
    # base = previsto / 1.05
    assert round(func['base'], 2) == round(12_500.0 / 1.05, 2)


def test_adapter_categoria_sem_reajuste():
    dados = adaptar(_payload_mock(), _config_mock())
    fin = next(c for c in dados['categorias'] if c['nome'] == 'Despesas Financeiras')
    assert fin['tem_reajuste'] is False
    assert fin['base'] == fin['previsto']


def test_adapter_unid_equiv():
    dados = adaptar(_payload_mock(), _config_mock())
    assert dados['unid_equiv'] == 24 + 2 * 1.5  # = 27


def test_adapter_subcategoria_vira_item():
    dados = adaptar(_payload_mock(), _config_mock())
    func = next(c for c in dados['categorias'] if c['nome'] == 'Despesa com Funcionários')
    assert len(func['itens']) == 1
    assert func['itens'][0]['nome'] == 'Sub 1'
