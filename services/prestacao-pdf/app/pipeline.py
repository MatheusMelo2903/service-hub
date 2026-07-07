# -*- coding: utf-8 -*-
"""Pipeline multi-fonte (W011A/W015A/W016A/W015P) → CONFIG → deck (PPTX + auditoria + PDF).

Mantém o fluxo legado W016A intacto (orquestrar/montar_config).
Adiciona fluxo multi-fonte via montar_config_multi_fonte/orquestrar_multi_fonte.

Prioridade de dados por campo:
- Receitas e despesas: W011A se presente, senão W015A, senão W016A, senão W015P.
- Séries mensais: W011A ou W015P (W015A e W016A não têm).
- Reconciliação: quando >1 fonte, compara totais. Aviso acima de TOLER_AVISO;
  só bloqueia acima de TOLER_SANIDADE (diferença grosseira, provável arquivo
  trocado). W016A nunca bloqueia (conferência); saldo ausente (W015P) não entra
  na comparação de saldo.
"""
from __future__ import annotations

import os
import subprocess
import sys

VENDOR = os.path.join(os.path.dirname(__file__), "..", "vendor",
                      "powerpoint-prestacao-contas", "scripts")
sys.path.insert(0, os.path.abspath(VENDOR))

from . import parser_w016a as P
from . import parser_w011a as P11
from . import parser_w015a as P15
from . import parser_w015p as P15P
from .agrupador import agrupar, MAX_LINHAS_RECEITA
from collections import namedtuple

# Adaptador duck-type para o agrupador: converte lançamentos dos parsers
# multi-fonte (campo 'total') para o formato esperado por agrupar() (campo 'valor').
_LancAdapt = namedtuple("_LancAdapt", ["descricao", "valor"])

# Tolerâncias de reconciliação entre fontes.
# Aviso: diferença > 1% nos totais de período (exibe nota âmbar no deck, NÃO trava).
# Sanidade: só bloqueia acima de 30%, que indica arquivo trocado (condomínio ou
# período errado), não divergência legítima entre relatórios do mesmo período.
# Entre 1% e 30% é sempre aviso âmbar. Decisão de produto: a prestação é gerada
# a partir de UMA fonte por prioridade; a reconciliação é conferência, não trava.
TOLER_AVISO_PCT = 1.0
TOLER_SANIDADE_PCT = 30.0

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

    # Rubricas negativas na seção de receita (descontos, estornos, tarifas) são
    # REDUTORES, não fontes. Vão para uma linha própria "Descontos e Estornos",
    # claramente rotulada, em vez de poluir a Origem da Receita com uma linha de
    # receita negativa (lê pessimamente numa assembleia). A receita total no
    # topo permanece líquida (já abatido o redutor); só a composição exibida
    # separa o bruto positivo do redutor — a soma das linhas continua = total.
    redutores = [l for l in est.receitas if l.valor < 0]
    positivas = [l for l in est.receitas if l.valor >= 0]
    soma_redutores = round(sum(l.valor for l in redutores), 2)
    soma_positivas = round(sum(l.valor for l in positivas), 2)
    # Capacidade do slide é fixa (11 linhas): reserva uma pro redutor quando há.
    max_pos = MAX_LINHAS_RECEITA - 1 if redutores else MAX_LINHAS_RECEITA
    rec_linhas = agrupar(positivas, soma_positivas, "Receitas",
                         max_pos, "Demais Receitas")
    receitas_cat = [(l.rotulo, l.valor, _pct(l.valor, est.receita_total))
                    for l in rec_linhas]
    if redutores:
        receitas_cat.append(
            ("Descontos e Estornos", soma_redutores,
             _pct(soma_redutores, est.receita_total)))

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


def _rotulos_periodo_w011a(est: P11.EstruturaW011A) -> dict:
    """Deriva rótulos de período de uma EstruturaW011A no mesmo formato do W016A."""
    MESES_EXTENSO = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
                     "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]
    MESES_ABREV = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN",
                   "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"]
    m0 = int(est.data_inicial[3:5])
    a0 = int(est.data_inicial[6:10])
    m1 = int(est.data_final[3:5])
    a1 = int(est.data_final[6:10])
    label = f"{MESES_ABREV[m0-1]}/{a0} a {MESES_ABREV[m1-1]}/{a1}"
    n_meses = (a1 - a0) * 12 + (m1 - m0) + 1
    return {
        "periodo_label": label,
        "periodo_extenso": f"{MESES_EXTENSO[m0-1]} de {a0} a {MESES_EXTENSO[m1-1]} de {a1}",
        "exercicio_titulo": f"Exercício {label}",
        "n_meses": n_meses,
        "data_inicial": est.data_inicial,
        "data_final": est.data_final,
    }


def _rotulos_periodo_w015a(est: P15.EstruturaW015A) -> dict:
    """Deriva rótulos de período de uma EstruturaW015A."""
    MESES_EXTENSO = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
                     "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]
    MESES_ABREV = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN",
                   "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"]
    m0 = int(est.data_inicial[3:5])
    a0 = int(est.data_inicial[6:10])
    m1 = int(est.data_final[3:5])
    a1 = int(est.data_final[6:10])
    label = f"{MESES_ABREV[m0-1]}/{a0} a {MESES_ABREV[m1-1]}/{a1}"
    n_meses = (a1 - a0) * 12 + (m1 - m0) + 1
    return {
        "periodo_label": label,
        "periodo_extenso": f"{MESES_EXTENSO[m0-1]} de {a0} a {MESES_EXTENSO[m1-1]} de {a1}",
        "exercicio_titulo": f"Exercício {label}",
        "n_meses": n_meses,
        "data_inicial": est.data_inicial,
        "data_final": est.data_final,
    }


def _rotulos_periodo_w015p(est: "P15P.EstruturaW015P") -> dict:
    """Deriva rótulos de período de uma EstruturaW015P (mesmo formato do W011A).
    Período detectado das colunas mensais do relatório, nunca fixo."""
    MESES_EXTENSO = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
                     "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]
    MESES_ABREV = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN",
                   "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"]
    m0 = int(est.data_inicial[3:5])
    a0 = int(est.data_inicial[6:10])
    m1 = int(est.data_final[3:5])
    a1 = int(est.data_final[6:10])
    label = f"{MESES_ABREV[m0-1]}/{a0} a {MESES_ABREV[m1-1]}/{a1}"
    n_meses = (a1 - a0) * 12 + (m1 - m0) + 1
    return {
        "periodo_label": label,
        "periodo_extenso": f"{MESES_EXTENSO[m0-1]} de {a0} a {MESES_EXTENSO[m1-1]} de {a1}",
        "exercicio_titulo": f"Exercício {label}",
        "n_meses": n_meses,
        "data_inicial": est.data_inicial,
        "data_final": est.data_final,
    }


def _reconciliar(fontes: dict, avisos: list) -> list:
    """Compara totais de período entre as fontes presentes.

    Retorna lista de bloqueios (só diferença grosseira >= TOLER_SANIDADE_PCT,
    fora das exceções abaixo). Popula `avisos` com divergências entre 1% e o
    teto de sanidade — âmbar, não trava.

    Campos comparados: receita_total, despesa_total, saldo_final.

    Exceções que NUNCA bloqueiam (no máximo viram aviso):
    - Qualquer par envolvendo W016A (relatório de conferência).
    - Campo saldo_final quando uma das fontes não tem saldo bancário real
      (ex: W015P, "Demonstrativo por Período", que só tem resultado de fluxo).
      Nesse caso o campo saldo_final é ignorado por completo (nem aviso).
    """
    # Extrai totais por fonte presente. _tem_saldo_real distingue fontes com
    # saldo bancário (W011A/W015A/W016A) de fontes de fluxo sem saldo (W015P).
    totais: dict[str, dict] = {}
    especs = [
        ("W011A", fontes.get("W011A"), True),
        ("W015A", fontes.get("W015A"), True),
        ("W016A", fontes.get("W016A"), True),
        ("W015P", fontes.get("W015P"), False),
    ]
    for nome, est, tem_saldo in especs:
        if est:
            totais[nome] = {
                "receita_total": est.receita_total,
                "despesa_total": est.despesa_total,
                "saldo_final": est.saldo_final,
                "_tem_saldo_real": tem_saldo,
            }

    if len(totais) < 2:
        return []

    bloqueios = []
    pares = [(a, b) for i, a in enumerate(totais) for b in list(totais)[i+1:]]
    for fa, fb in pares:
        envolve_w16 = "W016A" in (fa, fb)
        for campo in ("receita_total", "despesa_total", "saldo_final"):
            # Saldo só é comparável se AMBAS as fontes têm saldo bancário real.
            if campo == "saldo_final" and not (
                totais[fa]["_tem_saldo_real"] and totais[fb]["_tem_saldo_real"]
            ):
                continue
            va = totais[fa][campo]
            vb = totais[fb][campo]
            # Ambos ~zero: sem diferença relevante. Evita percentual inflado por
            # divisão por valor ínfimo (ex: 0.001 vs 0.002 = 100%).
            if abs(va) < 0.01 and abs(vb) < 0.01:
                continue
            ref = max(abs(va), abs(vb))
            diff_abs = abs(va - vb)
            diff_pct = diff_abs / ref * 100
            msg = (
                f"{campo}: {fa}={va:.2f} vs {fb}={vb:.2f} "
                f"(diferença {diff_pct:.2f}%)"
            )
            # W016A nunca bloqueia; acima do teto de sanidade bloqueia; entre o
            # aviso e o teto, âmbar. Log de auditoria detalhado em stderr.
            bloqueia = (diff_pct >= TOLER_SANIDADE_PCT) and not envolve_w16
            if diff_pct >= TOLER_AVISO_PCT:
                limiar = ("SANIDADE(bloqueio)" if bloqueia
                          else "AVISO(nao bloqueia)")
                print(f"[reconciliacao] {campo} {fa} vs {fb}: "
                      f"{fa}={va:.2f} {fb}={vb:.2f} | "
                      f"delta_abs=R${diff_abs:.2f} delta_pct={diff_pct:.2f}% | "
                      f"limiar aviso={TOLER_AVISO_PCT}% sanidade={TOLER_SANIDADE_PCT}% "
                      f"| {limiar}"
                      + (" | W016A: nunca bloqueia" if envolve_w16 and diff_pct >= TOLER_SANIDADE_PCT else ""),
                      file=sys.stderr)
            if bloqueia:
                bloqueios.append(msg)
            elif diff_pct >= TOLER_AVISO_PCT:
                avisos.append(msg)

    return bloqueios


def _nome_para_config(condominio: str) -> tuple[str, str]:
    """Formata o nome do condomínio em duas linhas para o CONFIG."""
    nome = condominio.title().replace("Condominio", "Condomínio")
    partes = nome.split()
    linha1 = " ".join(partes[:2]) if len(partes) > 2 else nome
    linha2 = " ".join(partes[2:]) if len(partes) > 2 else ""
    return linha1, linha2


def _receitas_de_w011a(est11: P11.EstruturaW011A) -> tuple:
    """Monta receitas_cat a partir do W011A.
    Converte LancamentoW011A (campo 'total') para o duck-type que o agrupador
    espera (campo 'valor') via _LancAdapt."""
    redutores = [l for l in est11.receitas if l.total < 0]
    positivas = [l for l in est11.receitas if l.total >= 0]
    soma_red = round(sum(l.total for l in redutores), 2)
    soma_pos = round(sum(l.total for l in positivas), 2)
    max_pos = MAX_LINHAS_RECEITA - 1 if redutores else MAX_LINHAS_RECEITA
    lanc_pos = [_LancAdapt(l.descricao, l.total) for l in positivas]
    rec_linhas = agrupar(lanc_pos, soma_pos, "Receitas", max_pos, "Demais Receitas")
    receitas_cat = [
        (l.rotulo, l.valor, _pct(l.valor, est11.receita_total))
        for l in rec_linhas
    ]
    if redutores:
        receitas_cat.append(
            ("Descontos e Estornos", soma_red, _pct(soma_red, est11.receita_total))
        )
    return receitas_cat


def _receitas_de_w015a(est15: P15.EstruturaW015A) -> list:
    """Monta receitas_cat a partir do W015A.
    Mesma lógica do W011A; usa _LancAdapt para adaptar campo 'total' → 'valor'."""
    redutores = [l for l in est15.receitas if l.total < 0]
    positivas = [l for l in est15.receitas if l.total >= 0]
    soma_red = round(sum(l.total for l in redutores), 2)
    soma_pos = round(sum(l.total for l in positivas), 2)
    max_pos = MAX_LINHAS_RECEITA - 1 if redutores else MAX_LINHAS_RECEITA
    lanc_pos = [_LancAdapt(l.descricao, l.total) for l in positivas]
    rec_linhas = agrupar(lanc_pos, soma_pos, "Receitas", max_pos, "Demais Receitas")
    receitas_cat = [
        (l.rotulo, l.valor, _pct(l.valor, est15.receita_total))
        for l in rec_linhas
    ]
    if redutores:
        receitas_cat.append(
            ("Descontos e Estornos", soma_red, _pct(soma_red, est15.receita_total))
        )
    return receitas_cat


def _despesas_de_w011a(est11: P11.EstruturaW011A) -> tuple[list, dict]:
    """Monta despesas_cat e detalhes a partir do W011A, com séries mensais.
    Inclui serie_mensal por categoria (exclusivo do W011A — 12 valores mensais)."""
    grupos_ord = sorted(est11.grupos, key=lambda g: -g.total)
    despesas_cat = [
        (g.categoria, g.total, _pct(g.total, est11.despesa_total))
        for g in grupos_ord
    ]
    detalhes = {}
    for g in grupos_ord:
        lancs = [_LancAdapt(l.descricao, l.total) for l in g.lancamentos]
        linhas = agrupar(lancs, g.total, g.categoria)
        t1, t2 = TITULOS.get(g.categoria, (g.categoria, ""))
        detalhes[g.categoria] = {
            "titulo1": t1, "titulo2": t2,
            "descricao": "",
            "serie_mensal": g.total_mes,   # série mensal por categoria
            "lancamentos": [(l.rotulo, l.valor) for l in linhas],
            "nota": None,
            "_membros": {l.rotulo: l.membros for l in linhas},
        }
    return despesas_cat, detalhes


def _despesas_de_w015a(est15: P15.EstruturaW015A) -> tuple[list, dict]:
    """Monta despesas_cat e detalhes a partir do W015A (sem séries mensais).
    serie_mensal=None pois W015A não tem breakdown mensal por categoria."""
    grupos_ord = sorted(est15.grupos, key=lambda g: -g.total)
    despesas_cat = [
        (g.categoria, g.total, _pct(g.total, est15.despesa_total))
        for g in grupos_ord
    ]
    detalhes = {}
    for g in grupos_ord:
        lancs = [_LancAdapt(l.descricao, l.total) for l in g.lancamentos]
        linhas = agrupar(lancs, g.total, g.categoria)
        t1, t2 = TITULOS.get(g.categoria, (g.categoria, ""))
        detalhes[g.categoria] = {
            "titulo1": t1, "titulo2": t2,
            "descricao": "",
            "serie_mensal": None,
            "lancamentos": [(l.rotulo, l.valor) for l in linhas],
            "nota": None,
            "_membros": {l.rotulo: l.membros for l in linhas},
        }
    return despesas_cat, detalhes


def _receitas_de_w015p(est15p) -> list:
    """Monta receitas_cat a partir do W015P (Demonstrativo por Período).
    Mesma lógica do W011A: achata no nível de item, redutores negativos viram
    a linha 'Descontos e Estornos'. Usa _LancAdapt (campo total → valor)."""
    redutores = [l for l in est15p.receitas if l.total < 0]
    positivas = [l for l in est15p.receitas if l.total >= 0]
    soma_red = round(sum(l.total for l in redutores), 2)
    soma_pos = round(sum(l.total for l in positivas), 2)
    max_pos = MAX_LINHAS_RECEITA - 1 if redutores else MAX_LINHAS_RECEITA
    lanc_pos = [_LancAdapt(l.descricao, l.total) for l in positivas]
    rec_linhas = agrupar(lanc_pos, soma_pos, "Receitas", max_pos, "Demais Receitas")
    receitas_cat = [
        (l.rotulo, l.valor, _pct(l.valor, est15p.receita_total))
        for l in rec_linhas
    ]
    if redutores:
        receitas_cat.append(
            ("Descontos e Estornos", soma_red, _pct(soma_red, est15p.receita_total))
        )
    return receitas_cat


def _despesas_de_w015p(est15p) -> tuple[list, dict]:
    """Monta despesas_cat e detalhes a partir do W015P, com séries mensais por
    categoria (o W015P tem matriz mensal como o W011A). Despesas já em sinal
    positivo (o parser normalizou o negativo do relatório uma única vez)."""
    grupos_ord = sorted(est15p.grupos, key=lambda g: -g.total)
    despesas_cat = [
        (g.categoria, g.total, _pct(g.total, est15p.despesa_total))
        for g in grupos_ord
    ]
    detalhes = {}
    for g in grupos_ord:
        lancs = [_LancAdapt(l.descricao, l.total) for l in g.lancamentos]
        linhas = agrupar(lancs, g.total, g.categoria)
        t1, t2 = TITULOS.get(g.categoria, (g.categoria, ""))
        detalhes[g.categoria] = {
            "titulo1": t1, "titulo2": t2,
            "descricao": "",
            "serie_mensal": g.total_mes,   # série mensal por categoria
            "lancamentos": [(l.rotulo, l.valor) for l in linhas],
            "nota": None,
            "_membros": {l.rotulo: l.membros for l in linhas},
        }
    return despesas_cat, detalhes


def montar_config_multi_fonte(
    est11: P11.EstruturaW011A | None,
    est15: P15.EstruturaW015A | None,
    est16: P.EstruturaW016A | None,
    avisos_reconciliacao: list,
    num_bloco: str | None = None,
    est15p: "P15P.EstruturaW015P | None" = None,
) -> dict:
    """Monta CONFIG a partir das fontes disponíveis (W011A/W015A/W016A/W015P).

    Prioridade dos campos:
    - Identificação e totais: W011A > W015A > W016A > W015P
    - Receitas e despesas detalhadas: W011A > W015A > W016A > W015P
    - Séries mensais: W011A ou W015P (None se nenhuma das duas)
    - Saldo anterior/final: W011A > W015A > W016A > W015P

    O W015P fica por último na prioridade de totais/saldo por ser a única fonte
    sem saldo bancário real: só vira primário quando é a única fonte disponível.

    Reconciliação: já realizada antes desta chamada (avisos_reconciliacao
    é preenchido pelo orquestrador antes de montar o CONFIG).
    """
    # Fonte de identificação e totais (prioridade W011A > W015A > W016A > W015P)
    if est11:
        condominio = est11.condominio
        rot = _rotulos_periodo_w011a(est11)
        receita_total = est11.receita_total
        despesa_total = est11.despesa_total
        saldo_anterior = est11.saldo_anterior
        saldo_final = est11.saldo_final
    elif est15:
        condominio = est15.condominio
        rot = _rotulos_periodo_w015a(est15)
        receita_total = est15.receita_total
        despesa_total = est15.despesa_total
        saldo_anterior = est15.saldo_anterior
        saldo_final = est15.saldo_final
    elif est16:
        condominio = est16.cliente
        rot = P.rotulos_periodo(est16)
        receita_total = est16.receita_total
        despesa_total = est16.despesa_total
        saldo_anterior = est16.saldo_anterior
        saldo_final = est16.saldo_final
    elif est15p:
        condominio = est15p.condominio
        rot = _rotulos_periodo_w015p(est15p)
        receita_total = est15p.receita_total
        despesa_total = est15p.despesa_total
        saldo_anterior = est15p.saldo_anterior      # 0.0 sintético
        saldo_final = est15p.saldo_final            # resultado acumulado
    else:
        raise ValueError("montar_config_multi_fonte: nenhuma fonte disponível")

    linha1, linha2 = _nome_para_config(condominio)

    # Quando a única fonte é W016A, montar_config() é chamado uma vez aqui
    # e o resultado é reutilizado abaixo para receitas e despesas — evita
    # calcular o mesmo CONFIG duas vezes para o mesmo objeto.
    cfg_16_cache: dict | None = None
    if not est11 and not est15 and est16:
        cfg_16_cache = montar_config(est16)

    # Receitas detalhadas: prioridade W011A > W015A > W016A > W015P
    if est11:
        receitas_cat = _receitas_de_w011a(est11)
    elif est15:
        receitas_cat = _receitas_de_w015a(est15)
    elif est16:
        # Fallback W016A: usa o cache calculado acima
        receitas_cat = cfg_16_cache["receitas_cat"]
    else:
        receitas_cat = _receitas_de_w015p(est15p)

    # Despesas detalhadas: prioridade W011A > W015A > W016A > W015P
    if est11:
        despesas_cat, detalhes = _despesas_de_w011a(est11)
    elif est15:
        despesas_cat, detalhes = _despesas_de_w015a(est15)
    elif est16:
        despesas_cat = cfg_16_cache["despesas_cat"]
        detalhes = cfg_16_cache["detalhes"]
    else:
        despesas_cat, detalhes = _despesas_de_w015p(est15p)

    # Séries mensais: W011A, ou W015P SOMENTE quando ele também é a fonte
    # primária de totais/saldo (nenhum W011A/W015A/W016A presente). Isso evita
    # misturar saldo bancário real (de W015A/W016A) com a série de saldo
    # sintética do W015P no mesmo slide, o que faria o gráfico não bater com o
    # card de saldo final.
    if est11:
        fonte_mensal = est11
    elif est15p and not est15 and not est16:
        fonte_mensal = est15p
    else:
        fonte_mensal = None
    tem_mensal = fonte_mensal is not None
    if tem_mensal:
        # O template usa meses_label (abreviado), meses_ini (inicial única),
        # receitas_mes, despesas_mes e saldo_fim_mes.
        # saldo_fim_mes = saldo_anterior do mês SEGUINTE = saldo_anterior_mes[1:]
        # com o saldo_final como último elemento.
        meses_label = fonte_mensal.meses_labels   # ["Jul/2025", ..., "Jun/2026"]
        meses_ini = [m[:3] for m in meses_label]  # ["Jul", ..., "Jun"]
        receitas_mes = fonte_mensal.receita_total_mes
        despesas_mes = fonte_mensal.despesa_total_mes
        # Saldo fim de cada mês = saldo anterior do mês seguinte.
        # saldo_anterior_mes[i] = saldo no INÍCIO do mês i (sintético no W015P).
        # saldo_fim_mes[i] = saldo_anterior_mes[i] + superavit_mes[i]
        saldo_fim_mes = [
            round(saldo + superav, 2)
            for saldo, superav in zip(fonte_mensal.saldo_anterior_mes,
                                      fonte_mensal.superavit_mes)
        ]
    else:
        meses_label = None
        meses_ini = None
        receitas_mes = None
        despesas_mes = None
        saldo_fim_mes = None

    # Nota âmbar de reconciliação quando há avisos
    nota_reconciliacao = None
    if avisos_reconciliacao:
        nota_reconciliacao = (
            "Atenção: diferença entre fontes detectada. " +
            "; ".join(avisos_reconciliacao[:2])
        )

    cfg = {
        "cliente_linha1": linha1,
        "cliente_linha2": linha2,
        "rodape": condominio.upper(),
        "cnpj": None,
        **rot,
        "saldo_anterior": saldo_anterior,
        "receita_total": receita_total,
        "despesa_total": despesa_total,
        "saldo_final": saldo_final,
        "meses_label": meses_label,
        "meses_ini": meses_ini,
        "receitas_mes": receitas_mes,
        "despesas_mes": despesas_mes,
        "saldo_fim_mes": saldo_fim_mes,
        "receitas_cat": receitas_cat,
        "receita_insight": "", "receita_insight_pct": "",
        "despesas_cat": despesas_cat,
        "detalhes": detalhes,
        "blocos": [], "certidoes": [], "certidoes_rodape_extra": "",
        # Metadados para o endpoint (não usados pelo template)
        "_serie_mensal_ativa": tem_mensal,
        "_nota_reconciliacao": nota_reconciliacao,
    }
    if num_bloco:
        cfg["bloco"] = {
            "num": num_bloco,
            "titulo": rot["exercicio_titulo"],
            "sub": rot["periodo_extenso"],
            "nota": nota_reconciliacao or "",
        }
    return cfg


def orquestrar_multi_fonte(
    caminhos_e_tipos: list[tuple[str, str]],
    prosa=None,
) -> tuple[list, dict | None, bool, list]:
    """Orquestra o pipeline multi-fonte.

    caminhos_e_tipos: lista de (caminho_pdf, tipo) onde tipo é 'W011A'/'W015A'/'W016A'.
    prosa: ProsaProvider ou None.

    Retorna (configs, capa, serie_mensal_ativa, avisos_reconciliacao).
    Cada conjunto de fontes (mesma data/período) gera 1 CONFIG.
    Esta função assume que todos os arquivos fornecidos pertencem ao MESMO
    período (um deck = um período = 1 CONFIG). Para múltiplos períodos
    com W016A, use orquestrar().

    Levanta ValueError para bloqueio de reconciliação (só diferença grosseira
    acima do teto de sanidade; ver _reconciliar).
    """
    # Parseia cada arquivo pelo tipo detectado
    est11: P11.EstruturaW011A | None = None
    est15: P15.EstruturaW015A | None = None
    est16: P.EstruturaW016A | None = None
    est15p: "P15P.EstruturaW015P | None" = None

    for caminho, tipo in caminhos_e_tipos:
        if tipo == "W011A":
            est11 = P11.parsear(caminho)
        elif tipo == "W015A":
            est15 = P15.parsear(caminho)
        elif tipo == "W016A":
            est16 = P.parsear(caminho)
        elif tipo == "W015P":
            est15p = P15P.parsear(caminho)

    # Reconciliação entre fontes disponíveis
    avisos: list = []
    fontes = {}
    if est11:
        fontes["W011A"] = est11
    if est15:
        fontes["W015A"] = est15
    if est16:
        fontes["W016A"] = est16
    if est15p:
        fontes["W015P"] = est15p

    bloqueios = _reconciliar(fontes, avisos)
    if bloqueios:
        raise ValueError(
            "reconciliacao_bloqueante: " + "; ".join(bloqueios)
        )

    cfg = montar_config_multi_fonte(est11, est15, est16, avisos, est15p=est15p)
    if prosa is not None:
        cfg = prosa.aplicar(cfg)

    serie_mensal_ativa = (est11 is not None) or (est15p is not None)
    return [cfg], None, serie_mensal_ativa, avisos


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
