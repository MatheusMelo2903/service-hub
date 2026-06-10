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


class ProsaDeterministica:
    """Prosa factual mínima, sem invenção: só nomes e números já validados."""

    def aplicar(self, config: dict) -> dict:
        for cat, total, pct in config["despesas_cat"]:
            det = config["detalhes"][cat]
            if not det.get("descricao"):
                top = det["lancamentos"][0]
                det["descricao"] = (
                    f"Total de {fmt_brl(total)} no período. Maior item: "
                    f"{top[0]}, com {fmt_brl(top[1])}."
                )
        if not config.get("receita_insight"):
            nome, valor, pct = config["receitas_cat"][0]
            config["receita_insight"] = (
                f"{nome} responde por {str(pct).replace('.', ',')}% da arrecadação do período."
            )
            config["receita_insight_pct"] = f"{str(pct).replace('.', ',')}%"
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
