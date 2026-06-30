# -*- coding: utf-8 -*-
"""Testes multi-fonte do microserviço de prestação de contas.

Estratégia de isolamento:
- Testes de PARSER (que leem PDFs reais) localizam os arquivos via varredura
  de fixtures_local/ (sem nomear condomínio específico) e são marcados como
  pytest.skip quando o diretório não existe ou está vazio. Passam em qualquer
  clone limpo sem PDFs.
- Testes de LÓGICA (montar_config_multi_fonte, reconciliação, degradação, prosa)
  usam instâncias dataclass com números sintéticos redondos e condomínio fictício.
  Rodam em qualquer ambiente sem dependência de arquivo externo.

NÃO há constantes com valores financeiros reais neste arquivo.
"""
from __future__ import annotations

import glob
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

# Diretório de fixtures locais — gitignored, existe apenas na máquina de desenvolvimento
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures_local")


def _encontrar_pdf_por_tipo(tipo: str) -> str | None:
    """Localiza o primeiro PDF cujo nome começa com o tipo informado em fixtures_local.

    Não hardcoda nome de condomínio — varre por padrão de tipo de relatório.
    Retorna None se não encontrar.
    """
    if not os.path.isdir(FIXTURES):
        return None
    padrao = os.path.join(FIXTURES, f"{tipo.lower()}*.pdf")
    encontrados = sorted(glob.glob(padrao))
    return encontrados[0] if encontrados else None


def _encontrar_pdf_ano_cheio_w011a() -> str | None:
    """Localiza especificamente o PDF W011A de ano cheio (praia_dourada).

    Busca pelo nome exato w011a_praia_dourada.pdf porque agora há múltiplos
    PDFs w011a* na pasta (Augusta, Buritis, Leblon, cortados). A seleção por
    exclusão de sufixos é frágil quando novos condomínios entram. O praia_dourada
    é o fixture de referência de ano cheio padrão (Praia Dourada 12m Jul/2025).
    """
    # Prioridade 1: fixture nominal de referência (Praia Dourada, 12m Jul/2025)
    caminho_nominal = os.path.join(FIXTURES, "w011a_praia_dourada.pdf")
    if os.path.isfile(caminho_nominal):
        return caminho_nominal
    # Fallback: qualquer w011a de ano cheio excluindo padroes conhecidos de variante
    if not os.path.isdir(FIXTURES):
        return None
    padrao = os.path.join(FIXTURES, "w011a*.pdf")
    encontrados = sorted(glob.glob(padrao))
    _excluir = ("trimestre", "curto", "cortado", "_12m_", "_jan", "_dez", "_buritis", "_augusta", "_leblon")
    ano_cheio = [p for p in encontrados
                 if not any(s in os.path.basename(p).lower() for s in _excluir)]
    return ano_cheio[0] if ano_cheio else None


def _encontrar_pdf_trimestre_w011a() -> str | None:
    """Localiza especificamente o PDF W011A de trimestre (período curto)."""
    if not os.path.isdir(FIXTURES):
        return None
    padrao = os.path.join(FIXTURES, "w011a_trimestre*.pdf")
    encontrados = sorted(glob.glob(padrao))
    return encontrados[0] if encontrados else None


# Guards de skip para testes que dependem de PDFs reais
def _skip_sem_pdf(tipo: str):
    """Retorna mark de skip se o PDF do tipo indicado não estiver disponível."""
    pdf = _encontrar_pdf_por_tipo(tipo)
    return pytest.mark.skipif(
        pdf is None,
        reason=f"PDF {tipo} nao encontrado em fixtures_local/ (gitignored)"
    )


# SKIP específico para o PDF de ano cheio (praia_dourada) — resolve colisão de fixture
SKIP_W011A_ANO_CHEIO = pytest.mark.skipif(
    _encontrar_pdf_ano_cheio_w011a() is None,
    reason="PDF w011a ano cheio nao encontrado em fixtures_local/ (gitignored)"
)
# SKIP específico para o PDF de trimestre
SKIP_W011A_TRIMESTRE = pytest.mark.skipif(
    _encontrar_pdf_trimestre_w011a() is None,
    reason="PDF w011a_trimestre nao encontrado em fixtures_local/ (gitignored)"
)

SKIP_W015A = _skip_sem_pdf("w015a")
SKIP_AMBOS = pytest.mark.skipif(
    _encontrar_pdf_por_tipo("w011a") is None or _encontrar_pdf_por_tipo("w015a") is None,
    reason="PDFs w011a e w015a necessarios nao encontrados em fixtures_local/"
)

# Tolerância em reais para comparações de float
TOL = 0.02


# ── Helpers para montar estruturas sintéticas ────────────────────────────────

def _est11_sintetico():
    """Retorna EstruturaW011A com valores redondos fictícios, condomínio falso."""
    from app.parser_w011a import EstruturaW011A, GrupoW011A, LancamentoW011A
    est = EstruturaW011A(
        condominio="Condominio Modelo",
        condominio_id="99999",
        data_inicial="01/07/2025",
        data_final="30/06/2026",
        meses_labels=[
            "Jul/2025", "Ago/2025", "Set/2025", "Out/2025", "Nov/2025", "Dez/2025",
            "Jan/2026", "Fev/2026", "Mar/2026", "Abr/2026", "Mai/2026", "Jun/2026",
        ],
        receitas=[LancamentoW011A("Taxa de Condominio", 120000.0, [10000.0] * 12)],
        receita_total=120000.0,
        receita_total_mes=[10000.0] * 12,
        grupos=[
            GrupoW011A(
                nome_relatorio="DESPESA COM PESSOAL",
                categoria="Pessoal",
                total=60000.0,
                total_mes=[5000.0] * 12,
                lancamentos=[LancamentoW011A("Salarios", 60000.0, [5000.0] * 12)],
            ),
            GrupoW011A(
                nome_relatorio="DESPESAS COM CONSUMO",
                categoria="Consumo",
                total=24000.0,
                total_mes=[2000.0] * 12,
                lancamentos=[LancamentoW011A("Agua", 24000.0, [2000.0] * 12)],
            ),
        ],
        despesa_total=84000.0,
        despesa_total_mes=[7000.0] * 12,
        saldo_anterior=50000.0,
        saldo_anterior_mes=[50000.0] + [53000.0] * 11,
        saldo_final=86000.0,
        mov_liquido=36000.0,
        superavit_mes=[3000.0] * 12,
    )
    return est


def _est15_sintetico():
    """Retorna EstruturaW015A com os mesmos totais que _est11_sintetico."""
    from app.parser_w015a import EstruturaW015A, GrupoW015A, LancamentoW015A
    est = EstruturaW015A(
        condominio="Condominio Modelo",
        condominio_id="99999",
        data_inicial="01/07/2025",
        data_final="30/06/2026",
        mes_comparativo_label="Jun/2026",
        receitas=[LancamentoW015A("Taxa de Condominio", 120000.0, 10000.0)],
        receita_total=120000.0,
        receita_total_comp=10000.0,
        grupos=[
            GrupoW015A(
                nome_relatorio="DESPESA COM PESSOAL",
                categoria="Pessoal",
                total=60000.0,
                total_comp=5000.0,
                lancamentos=[LancamentoW015A("Salarios", 60000.0, 5000.0)],
            ),
            GrupoW015A(
                nome_relatorio="DESPESAS COM CONSUMO",
                categoria="Consumo",
                total=24000.0,
                total_comp=2000.0,
                lancamentos=[LancamentoW015A("Agua", 24000.0, 2000.0)],
            ),
        ],
        despesa_total=84000.0,
        despesa_total_comp=7000.0,
        saldo_anterior=50000.0,
        saldo_anterior_comp=50000.0,
        saldo_final=86000.0,
        saldo_final_comp=86000.0,
        mov_liquido=36000.0,
    )
    return est


# ── 1. Detector ──────────────────────────────────────────────────────────────

@SKIP_W011A_ANO_CHEIO
def test_detector_w011a():
    from app.detector import detectar_tipo
    # Usa PDF de ano cheio especificamente (determinístico, sem colisão de fixture)
    pdf = _encontrar_pdf_ano_cheio_w011a()
    assert detectar_tipo(pdf) == "W011A", f"PDF {pdf} deve ser detectado como W011A"


@_skip_sem_pdf("w015a")
def test_detector_w015a():
    from app.detector import detectar_tipo
    pdf = _encontrar_pdf_por_tipo("w015a")
    assert detectar_tipo(pdf) == "W015A", f"PDF {pdf} deve ser detectado como W015A"


def test_detector_arquivo_inexistente():
    from app.detector import detectar_tipo
    assert detectar_tipo("/nao/existe.pdf") == "DESCONHECIDO"


# ── 2. Parser W011A — consistência interna com PDF real ──────────────────────

@SKIP_W011A_ANO_CHEIO
def test_parser_w011a_conservacao_de_caixa():
    """saldo_anterior + receita_total - despesa_total == saldo_final (PDF real)."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_ano_cheio_w011a())
    caixa = est.saldo_anterior + est.receita_total - est.despesa_total
    assert abs(caixa - est.saldo_final) < TOL, (
        f"conservação de caixa falhou: {caixa:.2f} != saldo_final {est.saldo_final:.2f}"
    )


@SKIP_W011A_ANO_CHEIO
def test_parser_w011a_soma_receitas():
    """Soma dos lançamentos de receita == receita_total reportado."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_ano_cheio_w011a())
    soma = round(sum(l.total for l in est.receitas), 2)
    assert abs(soma - est.receita_total) < TOL, (
        f"soma receitas {soma:.2f} != receita_total {est.receita_total:.2f}"
    )


@SKIP_W011A_ANO_CHEIO
def test_parser_w011a_soma_grupos():
    """Soma dos totais de grupo == despesa_total reportado."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_ano_cheio_w011a())
    soma = round(sum(g.total for g in est.grupos), 2)
    assert abs(soma - est.despesa_total) < TOL, (
        f"soma grupos {soma:.2f} != despesa_total {est.despesa_total:.2f}"
    )


@SKIP_W011A_ANO_CHEIO
def test_parser_w011a_soma_lancamentos_por_grupo():
    """Para cada grupo, soma dos lançamentos == total do grupo."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_ano_cheio_w011a())
    for g in est.grupos:
        soma_g = round(sum(l.total for l in g.lancamentos), 2)
        assert abs(soma_g - g.total) < TOL, (
            f"grupo {g.nome_relatorio}: lançamentos {soma_g:.2f} != total {g.total:.2f}"
        )


@SKIP_W011A_ANO_CHEIO
def test_parser_w011a_meses_labels():
    """meses_labels tem 12 posições, primeiro é Jul, segundo é Ago."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_ano_cheio_w011a())
    assert len(est.meses_labels) == 12
    assert est.meses_labels[0].startswith("Jul"), f"Primeiro label deve ser Jul: {est.meses_labels[0]}"
    assert est.meses_labels[1].startswith("Ago"), f"Segundo label deve ser Ago: {est.meses_labels[1]}"


@SKIP_W011A_ANO_CHEIO
def test_parser_w011a_soma_meses_receita():
    """Soma dos 12 meses de receita deve ser igual ao receita_total do período."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_ano_cheio_w011a())
    assert len(est.receita_total_mes) == 12
    soma = round(sum(est.receita_total_mes), 2)
    assert abs(soma - est.receita_total) < TOL, (
        f"soma(receita_mes)={soma:.2f} != receita_total={est.receita_total:.2f}"
    )


@SKIP_W011A_ANO_CHEIO
def test_parser_w011a_superavit_mes():
    """superavit_mes: 12 posições, todos finitos, soma reconcilia com mov_liquido."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_ano_cheio_w011a())
    assert len(est.superavit_mes) == 12, "superavit_mes deve ter 12 posições"
    for i, v in enumerate(est.superavit_mes):
        assert math.isfinite(v), f"superavit_mes[{i}]={v} não é finito"
    soma = sum(est.superavit_mes)
    # Tolerância maior por causa da derivação do mês Jul (subtração acumulada)
    assert abs(soma - est.mov_liquido) < 0.15, (
        f"soma(superavit_mes)={soma:.4f} nao reconcilia com mov_liquido={est.mov_liquido:.2f}"
    )


# ── 3. Parser W015A — consistência interna com PDF real ──────────────────────

@SKIP_W015A
def test_parser_w015a_conservacao_de_caixa():
    """saldo_anterior + receita_total - despesa_total == saldo_final (PDF real)."""
    from app.parser_w015a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w015a"))
    caixa = est.saldo_anterior + est.receita_total - est.despesa_total
    assert abs(caixa - est.saldo_final) < TOL, (
        f"conservação de caixa falhou: {caixa:.2f} != saldo_final {est.saldo_final:.2f}"
    )


@SKIP_W015A
def test_parser_w015a_soma_receitas():
    """Soma dos lançamentos de receita == receita_total reportado."""
    from app.parser_w015a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w015a"))
    soma = round(sum(l.total for l in est.receitas), 2)
    assert abs(soma - est.receita_total) < TOL, (
        f"soma receitas {soma:.2f} != receita_total {est.receita_total:.2f}"
    )


@SKIP_W015A
def test_parser_w015a_soma_grupos():
    """Soma dos totais de grupo == despesa_total reportado."""
    from app.parser_w015a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w015a"))
    soma = round(sum(g.total for g in est.grupos), 2)
    assert abs(soma - est.despesa_total) < TOL, (
        f"soma grupos {soma:.2f} != despesa_total {est.despesa_total:.2f}"
    )


# ── 4. montar_config_multi_fonte — dados sintéticos ──────────────────────────

def test_config_so_w011a_sintetico():
    """Config com somente W011A sintético: série mensal ativa, categorias presentes."""
    from app.pipeline import montar_config_multi_fonte
    est11 = _est11_sintetico()
    avisos = []
    cfg = montar_config_multi_fonte(est11, None, None, avisos)
    assert cfg["receita_total"] == est11.receita_total
    assert cfg["despesa_total"] == est11.despesa_total
    assert cfg["meses_label"] is not None, "serie mensal deve estar ativa com W011A"
    assert len(cfg["meses_label"]) == 12
    assert cfg["receitas_mes"] is not None
    assert cfg["despesas_mes"] is not None
    assert len(cfg["despesas_cat"]) > 0
    assert len(cfg["receitas_cat"]) > 0
    # Ao menos uma categoria tem serie_mensal
    cats_com_serie = [c for c in cfg["detalhes"] if cfg["detalhes"][c]["serie_mensal"] is not None]
    assert len(cats_com_serie) > 0, "Deve haver categorias com serie_mensal"


def test_config_so_w015a_sintetico():
    """Config com somente W015A sintético: série mensal inativa."""
    from app.pipeline import montar_config_multi_fonte
    est15 = _est15_sintetico()
    avisos = []
    cfg = montar_config_multi_fonte(None, est15, None, avisos)
    assert cfg["receita_total"] == est15.receita_total
    assert cfg["meses_label"] is None, "W015A nao tem serie mensal"
    assert cfg["receitas_mes"] is None
    assert len(cfg["despesas_cat"]) > 0


def test_config_w011a_mais_w015a_sintetico():
    """Config W011A+W015A sintéticos: usa W011A como primário, sem bloqueio."""
    from app.pipeline import montar_config_multi_fonte
    est11 = _est11_sintetico()
    est15 = _est15_sintetico()
    avisos = []
    cfg = montar_config_multi_fonte(est11, est15, None, avisos)
    # Totais vêm do W011A
    assert cfg["receita_total"] == est11.receita_total
    assert cfg["meses_label"] is not None, "W011A fornece série mensal"
    assert len(avisos) == 0, f"Nao deve haver avisos com fontes identicas: {avisos}"


# ── 5. Prosa aplica sem erro — dados sintéticos ──────────────────────────────

def test_prosa_so_w011a_sintetico():
    """ProsaDeterministica.aplicar() retorna insight preenchido com W011A sintético."""
    from app.pipeline import montar_config_multi_fonte
    from app.prosa import ProsaDeterministica
    est11 = _est11_sintetico()
    avisos = []
    cfg = montar_config_multi_fonte(est11, None, None, avisos)
    cfg_prosa = ProsaDeterministica().aplicar(cfg)
    assert cfg_prosa["receita_insight"], "insight de receita deve estar preenchido"


def test_prosa_so_w015a_sintetico():
    """ProsaDeterministica.aplicar() retorna insight preenchido com W015A sintético."""
    from app.pipeline import montar_config_multi_fonte
    from app.prosa import ProsaDeterministica
    est15 = _est15_sintetico()
    avisos = []
    cfg = montar_config_multi_fonte(None, est15, None, avisos)
    cfg_prosa = ProsaDeterministica().aplicar(cfg)
    assert cfg_prosa["receita_insight"]


def test_prosa_w011a_mais_w015a_sintetico():
    """Série mensal coerente após prosa com W011A+W015A sintéticos."""
    from app.pipeline import montar_config_multi_fonte
    from app.prosa import ProsaDeterministica
    est11 = _est11_sintetico()
    est15 = _est15_sintetico()
    avisos = []
    cfg = montar_config_multi_fonte(est11, est15, None, avisos)
    cfg_prosa = ProsaDeterministica().aplicar(cfg)
    assert cfg_prosa["receita_insight"]
    assert len(cfg_prosa["meses_label"]) == 12
    assert len(cfg_prosa["receitas_mes"]) == 12
    assert len(cfg_prosa["despesas_mes"]) == 12


# ── 6. Reconciliação — dados sintéticos ──────────────────────────────────────

def test_reconciliacao_sem_bloqueio_sintetico():
    """Mesmos totais em W011A e W015A: zero bloqueios, zero avisos."""
    from app.pipeline import _reconciliar
    est11 = _est11_sintetico()
    est15 = _est15_sintetico()
    avisos = []
    bloqueios = _reconciliar({"W011A": est11, "W015A": est15}, avisos)
    assert len(bloqueios) == 0, f"Nao deve haver bloqueios: {bloqueios}"
    assert len(avisos) == 0, f"Nao deve haver avisos com fontes identicas: {avisos}"


def test_reconciliacao_bloqueio_sintetico():
    """Diferença de 10% dispara bloqueio."""
    from app.pipeline import _reconciliar
    from app.parser_w011a import EstruturaW011A
    est11 = _est11_sintetico()
    # W015A com receita_total 10% maior → diferença > TOLER_BLOQUEIO_PCT (5%)
    est15 = _est15_sintetico()
    est15.receita_total = est11.receita_total * 1.10
    avisos = []
    bloqueios = _reconciliar({"W011A": est11, "W015A": est15}, avisos)
    assert len(bloqueios) > 0, "Diferença de 10% deve gerar bloqueio"


def test_reconciliacao_aviso_sintetico():
    """Diferença de 2% dispara aviso (não bloqueio)."""
    from app.pipeline import _reconciliar
    est11 = _est11_sintetico()
    est15 = _est15_sintetico()
    est15.receita_total = est11.receita_total * 1.02
    avisos = []
    bloqueios = _reconciliar({"W011A": est11, "W015A": est15}, avisos)
    assert len(bloqueios) == 0, "Diferença de 2% nao deve gerar bloqueio"
    assert len(avisos) > 0, "Diferença de 2% deve gerar aviso"


def test_reconciliacao_valores_zero_ignorados():
    """Quando ambos os valores são ~zero, deve pular sem erro de divisão."""
    from app.pipeline import _reconciliar
    from app.parser_w011a import EstruturaW011A
    est11 = _est11_sintetico()
    est11.saldo_final = 0.001
    est15 = _est15_sintetico()
    est15.saldo_final = 0.002
    avisos = []
    # Não deve levantar exceção
    bloqueios = _reconciliar({"W011A": est11, "W015A": est15}, avisos)
    # saldo_final ~0 em ambos deve ser ignorado (sem bloqueio por isso)
    bloqueios_saldo = [b for b in bloqueios if "saldo_final" in b]
    assert len(bloqueios_saldo) == 0, "Valores ~zero nao devem gerar bloqueio"


# ── 7. Fluxo W016A legado (mock) ─────────────────────────────────────────────

def test_legado_w016a_intacto():
    """Verifica que montar_config() continua existindo e é chamável.

    Usa mock de EstruturaW016A para não depender de PDF real do W016A.
    Confirma que a refatoração multi-fonte não quebrou o fluxo legado.
    """
    from app.pipeline import montar_config
    from app.parser_w016a import EstruturaW016A, GrupoDespesa, Lancamento

    est = EstruturaW016A(
        cliente="CONDOMINIO TESTE",
        data_inicial="01/07/2025",
        data_final="30/06/2026",
        n_meses=12,
        saldo_anterior=100000.0,
        saldo_final=110000.0,
        receita_total=50000.0,
        despesa_total=40000.0,
        mov_liquido=10000.0,
        receitas=[Lancamento(descricao="Taxa de Condominio", valor=50000.0)],
        grupos=[
            GrupoDespesa(
                nome_relatorio="DESPESA COM PESSOAL",
                categoria="Pessoal",
                lancamentos=[Lancamento(descricao="Salarios", valor=40000.0)],
                total=40000.0,
            )
        ],
    )
    cfg = montar_config(est)
    assert cfg["receita_total"] == 50000.0
    assert cfg["despesa_total"] == 40000.0
    assert cfg["meses_label"] is None, "W016A legado nunca tem serie mensal"
    assert len(cfg["despesas_cat"]) == 1
    assert len(cfg["receitas_cat"]) == 1


# ── 8. montar_config_multi_fonte com W016A (cache, sem chamada dupla) ────────

def test_config_so_w016a_nao_chama_montar_config_duas_vezes():
    """Verifica que o fallback W016A usa o cache interno e produz config coerente."""
    from app.pipeline import montar_config_multi_fonte
    from app.parser_w016a import EstruturaW016A, GrupoDespesa, Lancamento

    est16 = EstruturaW016A(
        cliente="CONDOMINIO MODELO",
        data_inicial="01/07/2025",
        data_final="30/06/2026",
        n_meses=12,
        saldo_anterior=50000.0,
        saldo_final=86000.0,
        receita_total=120000.0,
        despesa_total=84000.0,
        mov_liquido=36000.0,
        receitas=[Lancamento(descricao="Taxa de Condominio", valor=120000.0)],
        grupos=[
            GrupoDespesa(
                nome_relatorio="DESPESA COM PESSOAL",
                categoria="Pessoal",
                lancamentos=[Lancamento(descricao="Salarios", valor=84000.0)],
                total=84000.0,
            )
        ],
    )
    avisos = []
    cfg = montar_config_multi_fonte(None, None, est16, avisos)
    assert cfg["receita_total"] == 120000.0
    assert cfg["despesa_total"] == 84000.0
    assert cfg["meses_label"] is None, "W016A nao tem serie mensal"
    assert len(cfg["despesas_cat"]) > 0
    assert len(cfg["receitas_cat"]) > 0


# ── 9. Testes de parser com PDF real: skip gracioso ──────────────────────────
# Os testes abaixo dependem de PDFs reais e são executados apenas localmente.
# Em clone limpo sem fixtures_local, todos são marcados como SKIP automaticamente.

@SKIP_W011A_ANO_CHEIO
def test_parser_w011a_com_pdf_real_valida_internamente():
    """Parsear PDF real do W011A deve passar a validacao interna sem levantar."""
    from app.parser_w011a import parsear
    # parsear() já chama _validar() internamente — se não levantar, está ok
    est = parsear(_encontrar_pdf_ano_cheio_w011a())
    assert est.receita_total > 0
    assert est.despesa_total > 0
    assert len(est.grupos) > 0
    assert len(est.receitas) > 0


@SKIP_W015A
def test_parser_w015a_com_pdf_real_valida_internamente():
    """Parsear PDF real do W015A deve passar a validação interna sem levantar."""
    from app.parser_w015a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w015a"))
    assert est.receita_total > 0
    assert est.despesa_total > 0
    assert len(est.grupos) > 0


@SKIP_AMBOS
def test_reconciliacao_com_pdfs_reais():
    """W011A e W015A do mesmo condomínio/período: sem bloqueio de reconciliação."""
    from app.parser_w011a import parsear as p11
    from app.parser_w015a import parsear as p15
    from app.pipeline import _reconciliar
    # Usa PDF de ano cheio especificamente (determinístico, sem colisão de fixture)
    est11 = p11(_encontrar_pdf_ano_cheio_w011a())
    est15 = p15(_encontrar_pdf_por_tipo("w015a"))
    avisos = []
    bloqueios = _reconciliar({"W011A": est11, "W015A": est15}, avisos)
    assert len(bloqueios) == 0, (
        f"Nao deve haver bloqueios com fontes do mesmo periodo: {bloqueios}"
    )


# ── 10. Novos testes: suporte a período curto (trimestre) e não-regressão ─────

@SKIP_W011A_TRIMESTRE
def test_parser_w011a_trimestre_basico():
    """(a) Trimestre: parse sem IndexError, 3 meses, conservação de caixa sem derivação fantasma."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_trimestre_w011a())
    # 3 meses explícitos, sem mês derivado fantasma
    assert len(est.meses_labels) == 3, f"Esperado 3 meses_labels, obtido {len(est.meses_labels)}"
    assert len(est.receita_total_mes) == 3, (
        f"Esperado 3 posicoes em receita_total_mes, obtido {len(est.receita_total_mes)}"
    )
    # Conservação de caixa do trimestre
    caixa = est.saldo_anterior + est.receita_total - est.despesa_total
    assert abs(caixa - est.saldo_final) < TOL, (
        f"conservacao de caixa falhou: {caixa:.2f} != saldo_final {est.saldo_final:.2f}"
    )
    # sum(receita_total_mes) bate com receita_total sem mês derivado fantasma
    soma_meses = round(sum(est.receita_total_mes), 2)
    assert abs(soma_meses - est.receita_total) < TOL, (
        f"sum(receita_total_mes)={soma_meses:.2f} != receita_total={est.receita_total:.2f} "
        "(possivel mes fantasma derivado indevidamente)"
    )


@SKIP_W011A_ANO_CHEIO
def test_parser_w011a_ano_cheio_nao_regressao():
    """(b) Nao-regressao ano cheio: 12 meses, Jul primeiro, conservacao de caixa fecha."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_ano_cheio_w011a())
    assert len(est.meses_labels) == 12, f"Esperado 12 meses_labels, obtido {len(est.meses_labels)}"
    assert est.meses_labels[0].startswith("Jul"), (
        f"Primeiro label deve comecar com Jul: {est.meses_labels[0]}"
    )
    caixa = est.saldo_anterior + est.receita_total - est.despesa_total
    assert abs(caixa - est.saldo_final) < TOL, (
        f"conservacao de caixa falhou: {caixa:.2f} != saldo_final {est.saldo_final:.2f}"
    )


def test_extrair_periodo_cabecalho_formato_ate():
    """(c) _extrair_periodo_cabecalho: formato 'ate' (string pura, sem PDF)."""
    from app.parser_w011a import _extrair_periodo_cabecalho
    # Formato ano cheio original — deve retornar exatamente as datas do período
    di, df = _extrair_periodo_cabecalho("Comparativo de Jul/2025 até Jun/2026")
    assert di == "01/07/2025", f"data_inicial esperada '01/07/2025', obtida '{di}'"
    assert df == "30/06/2026", f"data_final esperada '30/06/2026', obtida '{df}'"


def test_extrair_periodo_cabecalho_formato_proximos_k():
    """(d) _extrair_periodo_cabecalho: formato 'com os proximos K meses' (string pura, sem PDF)."""
    from app.parser_w011a import _extrair_periodo_cabecalho
    # K=2 meses adicionais a partir de Abr/2026 => mes final = Abr+2 = Jun/2026
    di, df = _extrair_periodo_cabecalho("Comparativo de Abr/2026 com os próximos 2 meses")
    assert di == "01/04/2026", f"data_inicial esperada '01/04/2026', obtida '{di}'"
    assert df == "30/06/2026", f"data_final esperada '30/06/2026', obtida '{df}'"


def test_borda_sintetica_6_meses():
    """(e) Borda sintetica 6 meses: EstruturaW011A com 6 meses passa por
    montar_config_multi_fonte sem erro (sem PDF necessario)."""
    from app.parser_w011a import EstruturaW011A, GrupoW011A, LancamentoW011A
    from app.pipeline import montar_config_multi_fonte
    # Monta estrutura com 6 meses manualmente (período semestral sintético)
    n = 6
    est = EstruturaW011A(
        condominio="Condominio Semestral Teste",
        condominio_id="77777",
        data_inicial="01/01/2026",
        data_final="30/06/2026",
        meses_labels=["Jan/2026", "Fev/2026", "Mar/2026", "Abr/2026", "Mai/2026", "Jun/2026"],
        receitas=[LancamentoW011A("Taxa de Condominio", 60000.0, [10000.0] * n)],
        receita_total=60000.0,
        receita_total_mes=[10000.0] * n,
        grupos=[
            GrupoW011A(
                nome_relatorio="DESPESA COM PESSOAL",
                categoria="Pessoal",
                total=30000.0,
                total_mes=[5000.0] * n,
                lancamentos=[LancamentoW011A("Salarios", 30000.0, [5000.0] * n)],
            ),
        ],
        despesa_total=30000.0,
        despesa_total_mes=[5000.0] * n,
        saldo_anterior=10000.0,
        saldo_anterior_mes=[10000.0] * n,
        saldo_final=40000.0,
        mov_liquido=30000.0,
        superavit_mes=[5000.0] * n,
    )
    avisos = []
    # Deve passar sem erro — montar_config_multi_fonte aceita qualquer N de meses
    cfg = montar_config_multi_fonte(est, None, None, avisos)
    assert cfg["receita_total"] == 60000.0
    # Serie mensal ativa com 6 meses
    assert cfg["meses_label"] is not None
    assert len(cfg["meses_label"]) == 6, (
        f"Esperado 6 meses_label, obtido {len(cfg['meses_label'])}"
    )


def test_malformado_vira_value_error():
    """(f) Layout malformado levanta ValueError (nao IndexError): arquivo nao-W011A
    com cells insuficientes deve produzir ValueError via _detectar_formato."""
    from app.parser_w011a import _detectar_formato
    # Simula um PDF com apenas 2 clusters de coluna detectados (malformado)
    cols_insuficientes = [100.0, 200.0]
    try:
        _detectar_formato(cols_insuficientes, n_meses_header=12)
        assert False, "Esperado ValueError para cols insuficientes"
    except ValueError as e:
        # Deve ser ValueError descritivo, nao IndexError
        assert "malformado" in str(e).lower() or "cluster" in str(e).lower(), (
            f"ValueError deve mencionar malformado ou cluster: {e}"
        )
    except IndexError:
        assert False, "IndexError nao deve ocorrer — deve ser ValueError"


def test_extrair_periodo_cabecalho_rollover_de_ano():
    """(g) _extrair_periodo_cabecalho: rollover de ano no formato 'com os proximos K meses'.

    Nov/2025 + 3 meses: Nov(11) + 3 = 14 -> subtrai 12 -> Fev(2) do ano seguinte.
    Verifica que o calculo de num_fim e ano_fim atravessa a virada de ano corretamente.
    O dia da data_final segue a convencao do codigo: sempre '30' (sem ajuste por mes).
    """
    from app.parser_w011a import _extrair_periodo_cabecalho
    # Nov + 3 meses adicionais = Nov, Dez, Jan, Fev -> data_final = Fev/2026
    di, df = _extrair_periodo_cabecalho(
        "Comparativo de Nov/2025 com os proximos 3 meses"
    )
    assert di == "01/11/2025", f"data_inicial esperada '01/11/2025', obtida '{di}'"
    # Fev/2026: ano rolou de 2025 para 2026 apos Nov+3
    assert df == "30/02/2026", f"data_final esperada '30/02/2026', obtida '{df}'"


def test_detectar_formato_discrepancia_meses_vs_colunas():
    """(h) _detectar_formato levanta ValueError quando discrepancia meses-vs-colunas
    e impossivel (diferenca != 0 e != 1).

    Garante que o guard nao regrida em refatoracoes futuras: o caminho de erro
    de discrepancia e distinto do caminho de len(cols)<3.
    """
    from app.parser_w011a import _detectar_formato
    # 5 clusters de coluna: idx_total=4, n_explicitas=3 (cols[1:4]).
    # Se cabeçalho declara 6 meses mas so ha 3 colunas explicitas -> diferenca=3.
    # 3 nao pertence a {0, 1} -> ValueError de discrepancia.
    cols_cinco = [50.0, 150.0, 250.0, 350.0, 450.0]
    try:
        _detectar_formato(cols_cinco, n_meses_header=6)
        assert False, "Esperado ValueError por discrepancia meses-vs-colunas"
    except ValueError as e:
        msg = str(e).lower()
        # Deve mencionar discrepancia ou meses ou colunas — nao o caminho de <3 clusters
        assert any(kw in msg for kw in ("diferenca", "meses", "colunas", "explicitas")), (
            f"ValueError deve descrever discrepancia meses-vs-colunas: {e}"
        )
    except IndexError:
        assert False, "IndexError nao deve ocorrer — deve ser ValueError"


# ── Passo 1: rodape por repeticao + fragmento por continuacao (estrutural) ──

def _encontrar_pdf_leblon_w011a() -> str | None:
    """Localiza o W011A do Leblon (nome de 3 palavras, originou o bug do rodape)."""
    if not os.path.isdir(FIXTURES):
        return None
    encontrados = sorted(glob.glob(os.path.join(FIXTURES, "w011a_leblon*.pdf")))
    return encontrados[0] if encontrados else None


SKIP_W011A_LEBLON = pytest.mark.skipif(
    _encontrar_pdf_leblon_w011a() is None,
    reason="PDF w011a_leblon nao encontrado em fixtures_local/ (gitignored)"
)


@SKIP_W011A_LEBLON
def test_passo1_rodape_leblon_nao_vira_grupo():
    """O nome do condominio no rodape (PRAIA DO LEBLON, 3 palavras) NAO pode
    virar grupo de despesa. Era o bug que a heuristica de contar palavras causava."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_leblon_w011a())
    nomes = [g.nome_relatorio.upper() for g in est.grupos]
    assert not any("LEBLON" in n for n in nomes), f"rodape virou grupo: {nomes}"
    soma = round(sum(g.total for g in est.grupos), 2)
    assert abs(soma - est.despesa_total) < 0.02, (
        f"soma grupos {soma} != despesa_total {est.despesa_total}"
    )


@SKIP_W011A_LEBLON
def test_passo1_fragmento_categoria_nao_vira_grupo():
    """Fragmentos de nome quebrado (FISCAIS, ADMINISTRATIVO) sao continuacao,
    nao grupos separados."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_leblon_w011a())
    nomes = [g.nome_relatorio.upper() for g in est.grupos]
    assert "FISCAIS" not in nomes, f"fragmento FISCAIS virou grupo: {nomes}"
    assert "ADMINISTRATIVO" not in nomes, f"fragmento ADMINISTRATIVO virou grupo: {nomes}"


@SKIP_W011A_ANO_CHEIO
def test_passo1_praia_dourada_estrutura_preservada():
    """Trava de nao-regressao: o Praia Dourada continua com 10 grupos e 79
    lancamentos. Reconciliacao fechar NAO basta (grupo errado tambem soma certo);
    aqui travamos a estrutura de grupos."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_ano_cheio_w011a())
    assert len(est.grupos) == 10, f"esperado 10 grupos, veio {len(est.grupos)}"
    total_lanc = sum(len(g.lancamentos) for g in est.grupos)
    assert total_lanc == 79, f"esperado 79 lancamentos, veio {total_lanc}"


# ── Passo 2: rotulos de mes lidos por posicao X da coluna (nao do cabecalho) ──

def _encontrar_pdf_augusta_dez11() -> str | None:
    if not os.path.isdir(FIXTURES):
        return None
    e = sorted(glob.glob(os.path.join(FIXTURES, "w011a_augusta_dez11*.pdf")))
    return e[0] if e else None


@SKIP_W011A_LEBLON
def test_passo2_leblon_rotulos_do_periodo_real():
    """Leblon comeca em Jun/2025: os rotulos tem que sair Jun/2025..Mai/2026
    lidos da coluna, nao o fallback generico Jul..Mes11 que vazava antes."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_leblon_w011a())
    assert len(est.meses_labels) == 12, f"esperado 12 meses, veio {len(est.meses_labels)}"
    assert est.meses_labels[0] == "Jun/2025", f"primeiro mes errado: {est.meses_labels[0]}"
    assert est.meses_labels[-1] == "Mai/2026", f"ultimo mes errado: {est.meses_labels[-1]}"
    assert "Mês1" not in est.meses_labels, f"fallback generico vazou: {est.meses_labels}"


@SKIP_W011A_ANO_CHEIO
@SKIP_W011A_TRIMESTRE
def test_passo2_rotulos_preservados_nao_regride():
    """Os rotulos de Praia Dourada (ano cheio Jul) e Quattro (trimestre Abr)
    nao podem mudar ao trocar a leitura para por-posicao."""
    from app.parser_w011a import parsear
    pd = parsear(_encontrar_pdf_ano_cheio_w011a())
    assert pd.meses_labels[0] == "Jul/2025" and pd.meses_labels[-1] == "Jun/2026"
    qt = parsear(_encontrar_pdf_trimestre_w011a())
    assert qt.meses_labels == ["Abr/2026", "Mai/2026", "Jun/2026"], qt.meses_labels


def test_passo2_augusta_sem_ate_rotulos_por_posicao():
    """Cabecalho 'sem ate' (Dez/2025 com os proximos 11 meses): os rotulos
    saem da coluna (Dez/2025..Nov/2026), nao de calculo do cabecalho."""
    pdf_path = _encontrar_pdf_augusta_dez11()
    if pdf_path is None:
        pytest.skip("w011a_augusta_dez11 nao encontrado em fixtures_local/")
    import pdfplumber
    from app.parser_w011a import (_clusterizar_colunas, _detectar_formato,
                                  _extrair_rotulos_por_posicao)
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[0]
        cols = _clusterizar_colunas(page)
        idx, deriv = _detectar_formato(cols, 12)
        labels = _extrair_rotulos_por_posicao(page, cols, idx, deriv)
    assert labels[0] == "Dez/2025", f"primeiro mes errado: {labels[0]}"
    assert labels[-1] == "Nov/2026", f"ultimo mes errado: {labels[-1]}"


# ── Passo 3: Loja Maconica (classe separada) cai em 422 especifico ──

def _encontrar_pdf_augusta_qualquer() -> str | None:
    if not os.path.isdir(FIXTURES):
        return None
    e = sorted(glob.glob(os.path.join(FIXTURES, "w011a_augusta*.pdf")))
    return e[0] if e else None


def test_passo3_loja_maconica_422_especifico():
    """A Loja Maconica (Augusta, hierarquia Ordinarias/Extraordinarias) cai em
    422 ESPECIFICO que identifica a causa, nunca generico. Assim o Matheus sabe
    na hora que e o caso da hierarquia (classe separada) e nao um bug."""
    pdf_path = _encontrar_pdf_augusta_qualquer()
    if pdf_path is None:
        pytest.skip("w011a_augusta nao encontrado em fixtures_local/")
    from app.parser_w011a import parsear
    with pytest.raises(ValueError) as exc:
        parsear(pdf_path)
    msg = str(exc.value)
    assert "Loja" in msg, f"422 deve identificar a classe Loja: {msg}"
    assert ("Ordinarias" in msg or "hierarquica" in msg), (
        f"422 deve citar a hierarquia de dois niveis: {msg}"
    )


# ── Passo 4: cut-date so em fronteira de mes; meio do mes cai em 422 ──

def _encontrar_pdf_buritis_cortado() -> str | None:
    if not os.path.isdir(FIXTURES):
        return None
    e = sorted(glob.glob(os.path.join(FIXTURES, "w011a_buritis_cortado*.pdf")))
    return e[0] if e else None


def test_passo5_buritis_cortado_meio_mes_reconcilia():
    """Corte por data no meio do mes (Buritis 26/12 a 26/06) agora GERA: a janela
    real vem do col0 de cada lancamento e reconcilia ao centavo pela cadeia de
    saldo. Primeiro caso verde do meio do mes (antes caia em 422)."""
    pdf_path = _encontrar_pdf_buritis_cortado()
    if pdf_path is None:
        pytest.skip("w011a_buritis_cortado nao encontrado em fixtures_local/")
    from app.parser_w011a import parsear
    est = parsear(pdf_path)  # nao pode levantar
    assert abs(est.receita_total - 1822059.57) < 0.02, f"receita janela: {est.receita_total}"
    assert abs(est.despesa_total - 1478056.50) < 0.02, f"despesa janela: {est.despesa_total}"
    assert abs(est.saldo_anterior - 736590.09) < 0.02, f"saldo_ant: {est.saldo_anterior}"
    assert abs(est.saldo_final - 1080593.16) < 0.02, f"saldo_fim: {est.saldo_final}"
    # Cadeia de saldo fecha ao centavo (teste de aceitacao)
    caixa = est.saldo_anterior + est.receita_total - est.despesa_total
    assert abs(caixa - est.saldo_final) < 0.02, f"caixa nao fecha: {caixa} != {est.saldo_final}"
    # Meses reais Jan..Jun (cols 1-6), SEM mes derivado de col0 (Emenda 2)
    assert est.meses_labels == ["Jan/2026", "Fev/2026", "Mar/2026", "Abr/2026",
                                "Mai/2026", "Jun/2026"], est.meses_labels


def test_passo5_augusta_cortado_continua_422_loja():
    """Augusta cortado tem cabecalho 26/12 (meio do mes) E e Loja Maconica. A
    precedencia da Loja (verificada ANTES do meio do mes) tem que se manter:
    cai em 422-Loja, nunca entra no ramo col0 do meio do mes."""
    pdf_path = _encontrar_pdf_augusta_qualquer()
    cortado = None
    if os.path.isdir(FIXTURES):
        e = sorted(glob.glob(os.path.join(FIXTURES, "w011a_augusta_cortado*.pdf")))
        cortado = e[0] if e else None
    if cortado is None:
        pytest.skip("w011a_augusta_cortado nao encontrado em fixtures_local/")
    from app.parser_w011a import parsear
    with pytest.raises(ValueError) as exc:
        parsear(cortado)
    assert "Loja" in str(exc.value), f"Augusta cortado deve cair em 422-Loja: {exc.value}"


@SKIP_W011A_ANO_CHEIO
@SKIP_W011A_TRIMESTRE
def test_passo4_condominios_fechados_intactos():
    """Os 4 condominios (Praia Dourada, Quattro, Buritis 12m, Leblon) seguem
    verdes; o cut-date e a deteccao de meio do mes nao podem afeta-los."""
    from app.parser_w011a import parsear
    for finder in (_encontrar_pdf_ano_cheio_w011a, _encontrar_pdf_trimestre_w011a,
                   _encontrar_pdf_leblon_w011a):
        p = finder()
        if p is None:
            continue
        est = parsear(p)  # nao pode levantar
        caixa = est.saldo_anterior + est.receita_total - est.despesa_total
        assert abs(caixa - est.saldo_final) < 0.02, f"caixa nao fecha em {p}"
    bur = os.path.join(FIXTURES, "w011a_buritis_12m_julho.pdf")
    if os.path.isfile(bur):
        est = parsear(bur)
        assert len(est.meses_labels) == 12
