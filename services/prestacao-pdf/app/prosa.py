# -*- coding: utf-8 -*-
"""Camada de prosa do CONFIG — separada dos números por contrato.

O agrupador entrega rótulos determinísticos e valores fechados. Esta camada
só pode REESCREVER texto (rótulos, descrição do card, nota âmbar, insight de
receita, textos de capa e divisor de bloco). Nunca toca em valor.

Implementações:
- ProsaDeterministica: textos factuais mínimos derivados dos dados. É o
  fallback sem LLM (e o default em testes).
- ProsaGolden: sobrepõe a prosa de um CONFIG de referência (golden) casando
  linhas por valor — usada na regressão da Fase 2 pra isolar a comparação
  estrutural do texto.
- A implementação LLM (via /api/claude/messages do Hub) entra na Fase 4 e
  obedece o mesmo contrato: recebe linhas cruas e propostas, devolve só texto.
"""
from __future__ import annotations


def fmt_brl(v: float) -> str:
    s = f"{v:,.2f}"
    return "R$ " + s.replace(",", "X").replace(".", ",").replace("X", ".")


def _fmt_pct_br(valor: float) -> str:
    """Formata percentual em padrão BR (vírgula decimal, sem espaço antes de %)."""
    return f"{valor:.1f}".replace(".", ",") + "%"


class ProsaDeterministica:
    """Prosa factual mínima, sem invenção: só nomes e números já validados."""

    def _descrever_categoria(self, lancamentos: list, total_cat: float) -> str:
        """Gera descrição determinística de uma categoria de despesa citando
        no máximo 3 itens pelo nome exato (sem abreviação, decisão do Matheus).
        Três moldes conforme concentração: dominância, dois equilibrados ou
        pulverizado. Guard contra total zero evita divisão por zero.
        Limite de ~160 caracteres reduz itens citados se necessário."""

        # Guard: sem lançamentos ou total zero → texto mínimo seguro
        if not lancamentos or total_cat == 0:
            return "Sem lançamentos registrados no período."

        # Ordena por valor desc (lancamentos já vem ordenado pelo agrupador,
        # mas reordena aqui para garantir independência de contrato).
        ordenados = sorted(lancamentos, key=lambda x: x[1], reverse=True)
        n = len(ordenados)

        pcts = [(rot, round(val / total_cat * 100, 1)) for rot, val in ordenados]
        p1 = pcts[0][1] if n >= 1 else 0
        p2 = pcts[1][1] if n >= 2 else 0

        # Molde 1 — Dominância: primeiro item acima de 55%
        if p1 > 55:
            txt = f"{pcts[0][0]} é o item de maior peso ({_fmt_pct_br(p1)} da categoria)"
            if n >= 2:
                txt += f", seguido por {pcts[1][0]}"
                if n >= 3:
                    txt += f" e {pcts[2][0]}"
            txt += "."
            if len(txt) <= 160:
                return txt
            # Reduz para 2 itens se estourar
            txt = f"{pcts[0][0]} é o item de maior peso ({_fmt_pct_br(p1)} da categoria)"
            if n >= 2:
                txt += f", seguido por {pcts[1][0]}"
            txt += "."
            return txt

        # Molde 2 — Dois equilibrados: primeiro entre 35%-55% e segundo acima de 20%
        if 35 <= p1 <= 55 and p2 > 20:
            soma = round(p1 + p2, 1)
            txt = (
                f"{pcts[0][0]} ({_fmt_pct_br(p1)}) e {pcts[1][0]} ({_fmt_pct_br(p2)}) "
                f"respondem juntos por {_fmt_pct_br(soma)} da categoria."
            )
            if len(txt) <= 160:
                return txt
            # Reduz: omite o segundo percentual para caber
            txt = (
                f"{pcts[0][0]} ({_fmt_pct_br(p1)}) e {pcts[1][0]} "
                f"respondem juntos por {_fmt_pct_br(soma)} da categoria."
            )
            return txt

        # Molde 3 — Demais casos: sem dominância (p1 <= 55) e sem dois equilibrados
        # (p1 < 35 ou p2 <= 20). Cobre tanto distribuição pulverizada quanto
        # concentração média (ex: p1 ~42% mas p2 baixo). "Lidera" reflete apenas
        # posição relativa, não implica dominância absoluta.
        restantes = n - 3
        txt = f"{pcts[0][0]} lidera com {_fmt_pct_br(p1)}"
        if n >= 2:
            txt += f", seguido por {pcts[1][0]}"
            if n >= 3:
                txt += f" e {pcts[2][0]}"
        if restantes > 0:
            txt += f". Os demais {restantes} itens dividem o restante."
        else:
            txt += "."
        if len(txt) <= 160:
            return txt
        # Reduz para 2 itens se estourar
        txt = f"{pcts[0][0]} lidera com {_fmt_pct_br(p1)}"
        if n >= 2:
            txt += f", seguido por {pcts[1][0]}"
        if restantes + (1 if n >= 3 else 0) > 0:
            txt += f". Os demais {n - 2} itens dividem o restante."
        else:
            txt += "."
        return txt

    def _descrever_receita(self, fontes: list, receita_total: float) -> tuple:
        """Gera insight de receita determinístico a partir da lista de fontes
        (nome, valor, pct) e do total já validado. Devolve (texto, pct_str).
        Guard contra total zero evita divisão por zero."""

        if not fontes or receita_total == 0:
            return ("Sem receitas registradas no período.", "0,0%")

        # Ordenação descendente por valor para garantir hierarquia correta
        ordenadas = sorted(fontes, key=lambda x: x[1], reverse=True)
        f1_nome, f1_val, _ = ordenadas[0]
        p1 = round(f1_val / receita_total * 100, 1)

        # Molde 1 — concentração alta: primeira fonte acima de 80%
        if p1 > 80:
            txt = f"{f1_nome} responde por {_fmt_pct_br(p1)} da arrecadação do período."
            return (txt, _fmt_pct_br(p1))

        if len(ordenadas) >= 2:
            f2_nome, f2_val, _ = ordenadas[1]
            p2 = round(f2_val / receita_total * 100, 1)
            soma12 = round(p1 + p2, 1)

            # Molde 2 — duas fontes dominantes: juntas acima de 85%.
            # pct_str usa soma12 para bater com o número citado no texto.
            if soma12 > 85:
                txt = (
                    f"{f1_nome} e {f2_nome} respondem juntas por "
                    f"{_fmt_pct_br(soma12)} da arrecadação."
                )
                return (txt, _fmt_pct_br(soma12))

            # Molde 3 — demais casos: primeira fonte lidera, cita até mais 2 nomes.
            # Quando há exatamente 2 fontes restantes (f2 e f3 são todo o restante),
            # afirma o percentual complementar. Com 4+ fontes no total, omite o
            # percentual para não implicar que só f2 e f3 cobrem o restante.
            restante = round(100 - p1, 1)
            n_fontes = len(ordenadas)
            if n_fontes >= 3:
                f3_nome = ordenadas[2][0]
                if n_fontes == 3:
                    # f2 e f3 são realmente todo o restante: seguro afirmar o %
                    txt = (
                        f"{f1_nome} ({_fmt_pct_br(p1)}) lidera a arrecadação, "
                        f"com {f2_nome} e {f3_nome} compondo os demais {_fmt_pct_br(restante)}."
                    )
                else:
                    # Há 4+ fontes: citar % seria enganoso pois outras fontes
                    # também compõem o restante além de f2 e f3.
                    txt = (
                        f"{f1_nome} ({_fmt_pct_br(p1)}) lidera a arrecadação, "
                        f"com {f2_nome}, {f3_nome} e outras fontes compondo os demais {_fmt_pct_br(restante)}."
                    )
            else:
                txt = (
                    f"{f1_nome} ({_fmt_pct_br(p1)}) lidera a arrecadação, "
                    f"com {f2_nome} compondo os demais {_fmt_pct_br(restante)}."
                )
            return (txt, _fmt_pct_br(p1))

        # Só uma fonte
        txt = f"{f1_nome} responde por {_fmt_pct_br(p1)} da arrecadação do período."
        return (txt, _fmt_pct_br(p1))

    def aplicar(self, config: dict) -> dict:
        # Gera descrição rica por categoria de despesa quando ainda não preenchida.
        # Usa nomes e percentuais derivados dos lançamentos validados pelo parser.
        for cat, total, pct in config["despesas_cat"]:
            det = config["detalhes"][cat]
            if not det.get("descricao"):
                det["descricao"] = self._descrever_categoria(
                    det["lancamentos"], total
                )

        # Gera insight de receita rico quando ainda não preenchido.
        # receita_total vem do CONFIG (já validado pelo parser W016A).
        if not config.get("receita_insight"):
            receita_total = config.get("receita_total", 0) or 0
            insight, pct_str = self._descrever_receita(
                config["receitas_cat"], receita_total
            )
            config["receita_insight"] = insight
            config["receita_insight_pct"] = pct_str

        if not config.get("bloco"):
            return config
        b = config["bloco"]
        if not b.get("nota"):
            b["nota"] = (
                f"Saldo inicial de {fmt_brl(config['saldo_anterior'])} e "
                f"encerramento em {fmt_brl(config['saldo_final'])}."
            )
        return config


class ProsaGolden:
    """Sobrepõe prosa de um CONFIG de referência. Casamento de linha por
    valor (quando único na categoria); linha sem par mantém o rótulo
    determinístico. Valores nunca mudam."""

    def __init__(self, golden: dict):
        self.g = golden

    def _overlay_linhas(self, linhas, gold_lanc):
        mapa = {}
        for rot, val in gold_lanc:
            v = round(val, 2)
            mapa[v] = None if v in mapa else rot   # ambíguo -> não sobrepõe
        return [
            (mapa.get(round(v, 2)) or rot, v)
            for rot, v in linhas
        ]

    def aplicar(self, config: dict) -> dict:
        g = self.g
        for campo in ("cliente_linha1", "cliente_linha2", "rodape",
                      "receita_insight", "receita_insight_pct"):
            if g.get(campo):
                config[campo] = g[campo]
        gold_rec = [(n, v) for n, v, _ in g["receitas_cat"]]
        config["receitas_cat"] = [
            (rot, v, p) for (rot, v), (_, _, p) in zip(
                self._overlay_linhas([(n, v) for n, v, _ in config["receitas_cat"]], gold_rec),
                config["receitas_cat"])
        ]
        for cat, _, _ in config["despesas_cat"]:
            det = config["detalhes"].get(cat)
            gdet = g["detalhes"].get(cat)
            if not det or not gdet:
                continue
            det["lancamentos"] = self._overlay_linhas(det["lancamentos"], gdet["lancamentos"])
            for campo in ("titulo1", "titulo2", "descricao", "nota"):
                if gdet.get(campo) is not None:
                    det[campo] = gdet[campo]
        if config.get("bloco") and g.get("bloco"):
            config["bloco"] = dict(g["bloco"])
        return config
