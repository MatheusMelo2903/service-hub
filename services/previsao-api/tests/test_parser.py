"""Testes unitarios do parser do microservico Previsao Orcamentaria.

Nao testa o endpoint HTTP — testa as funcoes do parser diretamente.
Todos os testes dependem da fixture mocks_gerados (scope=session) do conftest.py,
que gera os PDFs mockados antes de qualquer teste.
"""
from __future__ import annotations

from io import BytesIO

import pytest

from tests.conftest import MOCK_W011A_PATH, MOCK_W045A_PATH

# Importa funcoes do parser (caminhos relativos ao pacote)
from app.parser import identificar_tipo_pdf, montar_response, parsear_w011a, parsear_w045a


# ─── Helpers ─────────────────────────────────────────────────────────────

def _carregar_w011a(mocks_gerados) -> tuple[dict, object]:
    """Carrega e parseia o W011A, retorna (dados_w011, response)."""
    bytes_pdf = open(MOCK_W011A_PATH, 'rb').read()
    dados = parsear_w011a(BytesIO(bytes_pdf))
    response = montar_response(dados, [], duracao_ms=100)
    return dados, response


def _carregar_w045a(mocks_gerados) -> list[dict]:
    """Carrega e parseia o W045A."""
    return parsear_w045a(BytesIO(open(MOCK_W045A_PATH, 'rb').read()))


# ─── Testes de identificacao de tipo ────────────────────────────────────

def test_identificar_tipo_w011a(mocks_gerados):
    """W011A deve ser identificado como 'W011A'."""
    tipo = identificar_tipo_pdf(MOCK_W011A_PATH)
    assert tipo == 'W011A', f'Esperado W011A, recebido {tipo}'


def test_identificar_tipo_w045a(mocks_gerados):
    """W045A deve ser identificado como 'W045A'."""
    tipo = identificar_tipo_pdf(MOCK_W045A_PATH)
    assert tipo == 'W045A', f'Esperado W045A, recebido {tipo}'


# ─── Testes de schema (8 grupos) ─────────────────────────────────────────

def test_w011a_retorna_8_grupos(mocks_gerados):
    """Response deve sempre ter exatamente 8 grupos canonicos."""
    _, response = _carregar_w011a(mocks_gerados)
    assert len(response.grupos) == 8
    ids = {g.id for g in response.grupos}
    assert ids == {
        'despesas-financeiras', 'funcionarios', 'administrativa',
        'consumo-taxas', 'manutencao', 'aquisicao-materiais',
        'equipamentos', 'servicos',
    }


def test_grupos_em_ordem_correta(mocks_gerados):
    """Grupos devem estar na ordem do produto (1 a 8)."""
    _, response = _carregar_w011a(mocks_gerados)
    ordens = [g.ordem for g in response.grupos]
    assert ordens == sorted(ordens), 'Grupos fora de ordem'
    assert ordens == list(range(1, 9))


# ─── Testes de Consumo e Taxas ────────────────────────────────────────────

def test_consumo_e_taxas_tem_3_subcategorias(mocks_gerados):
    """Consumo e Taxas deve ter as 3 subcategorias: utilidades, retencoes-fiscais, taxas-recolhimentos."""
    _, response = _carregar_w011a(mocks_gerados)
    consumo = next(g for g in response.grupos if g.id == 'consumo-taxas')
    subcat_ids = {s.id for s in consumo.subcategorias}
    assert 'utilidades' in subcat_ids, f'Subcategoria utilidades ausente em {subcat_ids}'
    assert 'retencoes-fiscais' in subcat_ids, f'Subcategoria retencoes-fiscais ausente em {subcat_ids}'
    assert 'taxas-recolhimentos' in subcat_ids, f'Subcategoria taxas-recolhimentos ausente em {subcat_ids}'


def test_utilidades_tem_rateio_uso_real(mocks_gerados):
    """Subcategoria Utilidades deve ter rateio='uso-real'."""
    _, response = _carregar_w011a(mocks_gerados)
    utilidades = next(
        (s for g in response.grupos for s in g.subcategorias if s.id == 'utilidades'),
        None,
    )
    assert utilidades is not None, 'Subcategoria utilidades nao encontrada'
    assert utilidades.rateio == 'uso-real', f'Esperado uso-real, recebido {utilidades.rateio}'


def test_subcategorias_fracao_ideal_tem_rateio_correto(mocks_gerados):
    """Todas as subcategorias exceto utilidades devem ter rateio='fracao-ideal'."""
    _, response = _carregar_w011a(mocks_gerados)
    for grupo in response.grupos:
        for subcat in grupo.subcategorias:
            if subcat.id == 'utilidades':
                continue
            assert subcat.rateio == 'fracao-ideal', (
                f'Subcat {subcat.id} tem rateio={subcat.rateio}, esperado fracao-ideal'
            )


# ─── Testes de totais e pesos ─────────────────────────────────────────────

def test_total_geral_bate_com_soma_dos_grupos(mocks_gerados):
    """total_geral deve ser igual a soma dos total_anual de todos os grupos."""
    _, response = _carregar_w011a(mocks_gerados)
    soma_grupos = round(sum(g.total_anual for g in response.grupos), 2)
    assert response.total_geral == soma_grupos, (
        f'total_geral={response.total_geral} != soma_grupos={soma_grupos}'
    )


def test_total_mensal_medio_correto(mocks_gerados):
    """total_mensal_medio deve ser total_geral / 12."""
    _, response = _carregar_w011a(mocks_gerados)
    esperado = round(response.total_geral / 12, 2)
    assert response.total_mensal_medio == esperado


def test_peso_pct_soma_proximo_de_1(mocks_gerados):
    """Soma dos peso_pct de todos os grupos deve ser proximo de 1.0."""
    _, response = _carregar_w011a(mocks_gerados)
    if response.total_geral > 0:
        soma_pesos = sum(g.peso_pct for g in response.grupos)
        assert abs(soma_pesos - 1.0) < 0.01, (
            f'Soma dos pesos = {soma_pesos}, esperado ~1.0'
        )


def test_grupos_sem_dados_tem_subcat_espelho(mocks_gerados):
    """Grupos sem lancamentos devem ter 1 subcategoria espelho com lancamentos=[]."""
    _, response = _carregar_w011a(mocks_gerados)
    for grupo in response.grupos:
        if grupo.total_anual == 0.0:
            assert len(grupo.subcategorias) == 1, (
                f'Grupo {grupo.id} sem dados deve ter 1 subcat espelho, '
                f'tem {len(grupo.subcategorias)}'
            )
            assert grupo.subcategorias[0].lancamentos == [], (
                f'Subcat espelho de {grupo.id} deve ter lancamentos=[]'
            )


# ─── Testes de itens fora do grupo ───────────────────────────────────────

def test_emprestimo_vai_para_fora_grupo(mocks_gerados):
    """Lancamentos com 'emprestimo' devem ter motivo='divida-especifica'."""
    _, response = _carregar_w011a(mocks_gerados)
    motivos = {i.motivo for i in response.itens_fora_grupo}
    assert 'divida-especifica' in motivos, (
        f'Motivo divida-especifica ausente. Motivos encontrados: {motivos}'
    )


def test_obras_extraordinarias_vai_para_fora_grupo(mocks_gerados):
    """Lancamentos com 'obras extraordinarias' devem ter motivo='obra-extraordinaria'."""
    _, response = _carregar_w011a(mocks_gerados)
    motivos = {i.motivo for i in response.itens_fora_grupo}
    assert 'obra-extraordinaria' in motivos, (
        f'Motivo obra-extraordinaria ausente. Motivos encontrados: {motivos}'
    )


# ─── Testes W045A ────────────────────────────────────────────────────────

def test_w045a_soma_fracoes_proximo_de_1(mocks_gerados):
    """Soma das fracoes do W045A deve ser 1.0 com tolerancia 0.001."""
    fracoes = _carregar_w045a(mocks_gerados)
    assert len(fracoes) > 0, 'W045A nao extraiu nenhuma fracao'
    soma = sum(f['fracao'] for f in fracoes)
    assert abs(soma - 1.0) < 0.001, f'Soma das fracoes = {soma:.6f}, esperado 1.0 ± 0.001'


def test_w045a_tem_26_unidades(mocks_gerados):
    """W045A mockado deve ter 26 unidades (24 aptos + 2 coberturas)."""
    fracoes = _carregar_w045a(mocks_gerados)
    assert len(fracoes) == 26, f'Esperado 26 unidades, encontrado {len(fracoes)}'


def test_w045a_fracoes_entre_limites(mocks_gerados):
    """Todas as fracoes devem estar entre 0.0001 e 0.5 (filtro de sanidade)."""
    fracoes = _carregar_w045a(mocks_gerados)
    for u in fracoes:
        assert 0.0001 <= u['fracao'] <= 0.5, (
            f"Fracao fora dos limites: {u['unidade']} = {u['fracao']}"
        )


# ─── Teste: espelho consumo-taxas quando subcategorias vazias ─────────────

def test_espelho_consumo_taxas_vazio():
    """Quando não há lançamentos de Consumo e Taxas, o espelho deve usar fracao-ideal.

    Monta dados_w011 com subcategorias_extraidas vazio e chama montar_response
    diretamente. Verifica que consumo-taxas tem 1 subcategoria espelho com
    id='consumo-taxas', rateio='fracao-ideal' e total_anual=0.
    """
    dados_w011 = {
        'condominio': 'Cond. Teste',
        'periodo': 'Jan/2025 a Dez/2025',
        'subcategorias_extraidas': {},  # nenhum lançamento classificado
        'itens_fora_grupo': [],
        'nao_classificados': [],
        'avisos': [],
    }
    response = montar_response(dados_w011, [], duracao_ms=0)

    consumo = next((g for g in response.grupos if g.id == 'consumo-taxas'), None)
    assert consumo is not None, 'Grupo consumo-taxas ausente na resposta'
    assert len(consumo.subcategorias) == 1, (
        f'Esperado 1 subcategoria espelho, encontrado {len(consumo.subcategorias)}'
    )
    esp = consumo.subcategorias[0]
    assert esp.id == 'consumo-taxas', f'id do espelho incorreto: {esp.id}'
    assert esp.rateio == 'fracao-ideal', (
        f'Espelho vazio deve usar fracao-ideal, recebeu {esp.rateio}'
    )
    assert esp.total_anual == 0.0, f'Espelho vazio deve ter total=0, recebeu {esp.total_anual}'
    assert esp.lancamentos == [], 'Espelho vazio deve ter lancamentos=[]'


# ─── Testes de metadados ──────────────────────────────────────────────────

def test_metadados_versao_correta(mocks_gerados):
    """Metadados devem ter parser_versao='1.1.0'."""
    _, response = _carregar_w011a(mocks_gerados)
    assert response.metadados.parser_versao == '1.1.0'


def test_metadados_extraido_em_tem_timezone(mocks_gerados):
    """extraido_em deve ser ISO-8601 com timezone ('+00:00' ou 'Z')."""
    _, response = _carregar_w011a(mocks_gerados)
    extraido = response.metadados.extraido_em
    assert '+' in extraido or extraido.endswith('Z'), (
        f'extraido_em sem timezone: {extraido}'
    )


def test_moeda_sempre_brl(mocks_gerados):
    """Campo moeda deve sempre ser 'BRL'."""
    _, response = _carregar_w011a(mocks_gerados)
    assert response.moeda == 'BRL'
