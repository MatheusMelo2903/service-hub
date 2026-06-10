# -*- coding: utf-8 -*-
"""Pipeline W016A → CONFIG → deck (PPTX + auditoria + PDF).

Cada demonstrativo de entrada vira um CONFIG independente (um bloco).
Os quatro asserts de consistência rodam em duas camadas: no parser
(contra os totais do próprio relatório) e no template vendorizado
(aplicar_config valida caixa, receitas, despesas e lançamentos).
"""
from __future__ import annotations

import os
import subprocess
import sys

VENDOR = os.path.join(os.path.dirname(__file__), "..", "vendor",
                      "powerpoint-prestacao-contas", "scripts")
sys.path.insert(0, os.path.abspath(VENDOR))

from . import parser_w016a as P
from .agrupador import agrupar, MAX_LINHAS_RECEITA

# Títulos dos slides de detalhamento por categoria canônica.
TITULOS = {
    "Pessoal": ("Despesas com", "pessoal"),
    "Consumo": ("Despesas com", "consumo"),
    "Serviços": ("Serviços", "contratados"),
    "Materiais": ("Aquisição de", "materiais"),
    "Retenções": ("Retenções", "tributárias"),
    "Administrativo": ("Despesas", "administrativas"),
    "Financeiras": ("Despesas", "financeiras"),
    "Manutenção": ("Contratos de", "manutenção"),
    "Investimento": ("Investimento e", "imobilizado"),
    "Taxas": ("Taxas e", "recolhimentos"),
}

def _pct(valor: float, total: float) -> float:
    return round(valor / total * 100, 1) if total else 0.0


def montar_config(est: P.EstruturaW016A, num_bloco: str | None = None) -> dict:
    """Converte a estrutura parseada num CONFIG completo (números + rótulos
    determinísticos). A prosa entra depois, por um ProsaProvider."""
    rot = P.rotulos_periodo(est)

    nome = est.cliente.title().replace("Condominio", "Condomínio")
    partes = nome.split()
    linha1 = " ".join(partes[:2]) if len(partes) > 2 else nome
    linha2 = " ".join(partes[2:]) if len(partes) > 2 else ""

    rec_linhas = agrupar(est.receitas, est.receita_total, "Receitas",
                         MAX_LINHAS_RECEITA, "Demais Receitas")
    receitas_cat = [(l.rotulo, l.valor, _pct(l.valor, est.receita_total))
                    for l in rec_linhas]

    grupos_ordenados = sorted(est.grupos, key=lambda g: -g.total)
    despesas_cat = [(g.categoria, g.total, _pct(g.total, est.despesa_total))
                    for g in grupos_ordenados]

    detalhes = {}
    for g in grupos_ordenados:
        # Fidelidade total: todas as rubricas nomeadas; quem pagina e o template.
        linhas = agrupar(g.lancamentos, g.total, g.categoria)
        t1, t2 = TITULOS.get(g.categoria, (g.categoria, ""))
        detalhes[g.categoria] = {
            "titulo1": t1, "titulo2": t2,
            "descricao": "",
            "serie_mensal": None,          # W016A não tem matriz mensal limpa
            "lancamentos": [(l.rotulo, l.valor) for l in linhas],
            "nota": None,
            "_membros": {l.rotulo: l.membros for l in linhas},  # pra prosa/LLM
        }

    cfg = {
        "cliente_linha1": linha1,
        "cliente_linha2": linha2,
        "rodape": est.cliente.upper(),
        "cnpj": None,
        **rot,
        "saldo_anterior": est.saldo_anterior,
        "receita_total": est.receita_total,
        "despesa_total": est.despesa_total,
        "saldo_final": est.saldo_final,
        "meses_label": None, "meses_ini": None,
        "receitas_mes": None, "despesas_mes": None, "saldo_fim_mes": None,
        "receitas_cat": receitas_cat,
        "receita_insight": "", "receita_insight_pct": "",
        "despesas_cat": despesas_cat,
        "detalhes": detalhes,
        "blocos": [], "certidoes": [], "certidoes_rodape_extra": "",
    }
    if num_bloco:
        cfg["bloco"] = {
            "num": num_bloco,
            "titulo": rot["exercicio_titulo"],
            "sub": rot["periodo_extenso"],
            "nota": "",
        }
    return cfg


def gerar_deck(configs: list, saida_pptx: str, capa: dict | None = None) -> str:
    """Monta o PPTX via template vendorizado e roda o auditor visual.
    Levanta RuntimeError se a auditoria reprovar."""
    import template_prestacao as T
    import auditar_apresentacao as A

    limpos = []
    for c in configs:
        c = dict(c)
        for det in c["detalhes"].values():
            det.pop("_membros", None)
        limpos.append(c)
    T.montar(limpos, saida_pptx, capa=capa)
    problemas, _ = A.auditar(saida_pptx)
    if problemas:
        raise RuntimeError(f"auditoria reprovou: {problemas}")
    return saida_pptx


def _data_chave(d: str):
    return (int(d[6:10]), int(d[3:5]), int(d[0:2]))


def orquestrar(caminhos_pdf: list, prosa=None) -> tuple:
    """Fase 3: um bloco por demonstrativo de entrada.

    N PDFs -> N CONFIGs em ordem cronológica, com divisor de bloco quando
    N > 1 (um único demonstrativo gera deck sem divisor). Valida a
    continuidade de caixa entre blocos (saldo final de um == saldo inicial
    do seguinte) — se não fechar, os demonstrativos não são contíguos e a
    geração PARA em vez de apresentar uma sequência falsa.

    Retorna (configs, capa) prontos pro gerar_deck.
    """
    estruturas = [P.parsear(c) for c in caminhos_pdf]
    estruturas.sort(key=lambda e: _data_chave(e.data_inicial))

    for ant, seg in zip(estruturas, estruturas[1:]):
        # Sobreposição de períodos (achado da revisão): dois W016A do mesmo
        # mês podem ter saldos coincidentes e passariam só pela checagem de
        # caixa, duplicando valores no deck.
        if _data_chave(seg.data_inicial) <= _data_chave(ant.data_final):
            raise ValueError(
                "periodos sobrepostos: bloco seguinte inicia em "
                f"{seg.data_inicial}, antes do fim do anterior ({ant.data_final})")
        if abs(ant.saldo_final - seg.saldo_anterior) > 0.011:
            raise ValueError(
                "blocos nao contiguos: saldo final de "
                f"{ant.data_final} ({ant.saldo_final:.2f}) difere do saldo "
                f"inicial de {seg.data_inicial} ({seg.saldo_anterior:.2f})")

    multi = len(estruturas) > 1
    configs = []
    for i, est in enumerate(estruturas, start=1):
        num = str(i).zfill(2) if multi else None
        cfg = montar_config(est, num_bloco=num)
        if prosa is not None:
            cfg = (prosa[i - 1] if isinstance(prosa, (list, tuple)) else prosa).aplicar(cfg)
        configs.append(cfg)

    capa = None
    if multi:
        prim, ult = estruturas[0], estruturas[-1]
        r0, r1 = P.rotulos_periodo(prim), P.rotulos_periodo(ult)
        ext0 = r0["periodo_extenso"].split(" a ")[0]
        ext1 = r1["periodo_extenso"].split(" a ")[1]
        rotulos = " e ".join(
            f"Bloco {i} ({P.rotulos_periodo(e)['periodo_label']})"
            for i, e in enumerate(estruturas, start=1))
        capa = {
            "exercicio_titulo": f"Exercício de {ext0} a {ext1}",
            "periodo_extenso": (
                f"Apresentação em {len(estruturas)} blocos • {rotulos}"
                "\nApresentação em Assembleia"),
        }
    return configs, capa


def converter_pdf(pptx: str, outdir: str, soffice: str = "libreoffice") -> str:
    """PPTX -> PDF via LibreOffice headless (mesmo fix de perfil do
    previsao-pdf: UserInstallation e HOME graváveis)."""
    profile = os.path.join(outdir, ".lo_profile")
    cmd = [soffice, "--headless", f"-env:UserInstallation=file://{profile}",
           "--convert-to", "pdf", "--outdir", outdir, pptx]
    proc = subprocess.run(cmd, capture_output=True, timeout=180,
                          env={**os.environ, "HOME": outdir}, check=False)
    pdf = os.path.join(outdir, os.path.splitext(os.path.basename(pptx))[0] + ".pdf")
    if proc.returncode != 0 or not os.path.exists(pdf):
        raise RuntimeError("libreoffice_falhou: " + proc.stderr.decode()[:300])
    return pdf
