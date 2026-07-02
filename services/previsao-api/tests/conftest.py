"""Fixtures de teste para o microservico Previsao Orcamentaria.

A fixture mocks_gerados (scope=session) executa os scripts de geracao
uma unica vez antes de qualquer teste. Salva os PDFs em /tmp para reuso.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

# Caminhos canonicos dos mocks — importados pelos modulos de teste
MOCK_W011A_PATH = '/tmp/sh_previsao_mock_w011a.pdf'
MOCK_W045A_PATH = '/tmp/sh_previsao_mock_w045a.pdf'

_SCRIPTS_DIR = Path(__file__).parent.parent / 'scripts'


@pytest.fixture(scope='session')
def mocks_gerados():
    """Gera os PDFs mockados antes de qualquer teste da sessao.

    Usa subprocess para executar os scripts de geracao com o Python atual,
    garantindo que as dependencias (reportlab) estejam disponiveis.
    """
    script_w011a = _SCRIPTS_DIR / 'gerar_mock_w011a.py'
    script_w045a = _SCRIPTS_DIR / 'gerar_mock_w045a.py'

    resultado_w011a = subprocess.run(
        [sys.executable, str(script_w011a), '--saida', MOCK_W011A_PATH],
        capture_output=True, text=True,
    )
    assert resultado_w011a.returncode == 0, (
        f'Falha ao gerar mock W011A:\n{resultado_w011a.stderr}'
    )

    resultado_w045a = subprocess.run(
        [sys.executable, str(script_w045a), '--saida', MOCK_W045A_PATH],
        capture_output=True, text=True,
    )
    assert resultado_w045a.returncode == 0, (
        f'Falha ao gerar mock W045A:\n{resultado_w045a.stderr}'
    )

    assert Path(MOCK_W011A_PATH).exists(), f'Mock W011A nao gerado em {MOCK_W011A_PATH}'
    assert Path(MOCK_W045A_PATH).exists(), f'Mock W045A nao gerado em {MOCK_W045A_PATH}'

    yield {
        'w011a': MOCK_W011A_PATH,
        'w045a': MOCK_W045A_PATH,
    }
