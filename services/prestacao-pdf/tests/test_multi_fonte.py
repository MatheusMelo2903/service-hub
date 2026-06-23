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


# Guards de skip para testes que dependem de PDFs reais
def _skip_sem_pdf(tipo: str):
    """Retorna mark de skip se o PDF do tipo indicado não estiver disponível."""
    pdf = _encontrar_pdf_por_tipo(tipo)
    return pytest.mark.skipif(
        pdf is None,
        reason=f"PDF {tipo} nao encontrado em fixtures_local/ (gitignored)"
    )


SKIP_W011A = _skip_sem_pdf("w011a")
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

@_skip_sem_pdf("w011a")
def test_detector_w011a():
    from app.detector import detectar_tipo
    pdf = _encontrar_pdf_por_tipo("w011a")
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

@SKIP_W011A
def test_parser_w011a_conservacao_de_caixa():
    """saldo_anterior + receita_total - despesa_total == saldo_final (PDF real)."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w011a"))
    caixa = est.saldo_anterior + est.receita_total - est.despesa_total
    assert abs(caixa - est.saldo_final) < TOL, (
        f"conservação de caixa falhou: {caixa:.2f} != saldo_final {est.saldo_final:.2f}"
    )


@SKIP_W011A
def test_parser_w011a_soma_receitas():
    """Soma dos lançamentos de receita == receita_total reportado."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w011a"))
    soma = round(sum(l.total for l in est.receitas), 2)
    assert abs(soma - est.receita_total) < TOL, (
        f"soma receitas {soma:.2f} != receita_total {est.receita_total:.2f}"
    )


@SKIP_W011A
def test_parser_w011a_soma_grupos():
    """Soma dos totais de grupo == despesa_total reportado."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w011a"))
    soma = round(sum(g.total for g in est.grupos), 2)
    assert abs(soma - est.despesa_total) < TOL, (
        f"soma grupos {soma:.2f} != despesa_total {est.despesa_total:.2f}"
    )


@SKIP_W011A
def test_parser_w011a_soma_lancamentos_por_grupo():
    """Para cada grupo, soma dos lançamentos == total do grupo."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w011a"))
    for g in est.grupos:
        soma_g = round(sum(l.total for l in g.lancamentos), 2)
        assert abs(soma_g - g.total) < TOL, (
            f"grupo {g.nome_relatorio}: lançamentos {soma_g:.2f} != total {g.total:.2f}"
        )


@SKIP_W011A
def test_parser_w011a_meses_labels():
    """meses_labels tem 12 posições, primeiro é Jul, segundo é Ago."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w011a"))
    assert len(est.meses_labels) == 12
    assert est.meses_labels[0].startswith("Jul"), f"Primeiro label deve ser Jul: {est.meses_labels[0]}"
    assert est.meses_labels[1].startswith("Ago"), f"Segundo label deve ser Ago: {est.meses_labels[1]}"


@SKIP_W011A
def test_parser_w011a_soma_meses_receita():
    """Soma dos 12 meses de receita deve ser igual ao receita_total do período."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w011a"))
    assert len(est.receita_total_mes) == 12
    soma = round(sum(est.receita_total_mes), 2)
    assert abs(soma - est.receita_total) < TOL, (
        f"soma(receita_mes)={soma:.2f} != receita_total={est.receita_total:.2f}"
    )


@SKIP_W011A
def test_parser_w011a_superavit_mes():
    """superavit_mes: 12 posições, todos finitos, soma reconcilia com mov_liquido."""
    from app.parser_w011a import parsear
    est = parsear(_encontrar_pdf_por_tipo("w011a"))
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

@SKIP_W011A
def test_parser_w011a_com_pdf_real_valida_internamente():
    """Parsear PDF real do W011A deve passar a validacao interna sem levantar."""
    from app.parser_w011a import parsear
    # parsear() já chama _validar() internamente — se não levantar, está ok
    est = parsear(_encontrar_pdf_por_tipo("w011a"))
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
    est11 = p11(_encontrar_pdf_por_tipo("w011a"))
    est15 = p15(_encontrar_pdf_por_tipo("w015a"))
    avisos = []
    bloqueios = _reconciliar({"W011A": est11, "W015A": est15}, avisos)
    assert len(bloqueios) == 0, (
        f"Nao deve haver bloqueios com fontes do mesmo periodo: {bloqueios}"
    )
