# -*- coding: utf-8 -*-
"""Mensagens de erro para o OPERADOR, em português, nomeando arquivo e números.

Regra de privacidade (decisão de produto 2026-07-09): estas mensagens PODEM
conter valores financeiros do próprio condomínio. Elas vão SÓ na resposta HTTP,
exibidas ao operador autenticado que subiu o arquivo segundos antes. NUNCA são
logadas em stdout/stderr. O log usa apenas a categoria (slug), sem número.

São duas naturezas de problema, e esta camada só compõe texto para ambas:
- Número que não fecha dentro de um arquivo (bloqueia sempre).
- Divergência entre fontes: se é diferença de janela, o texto explica e sugere
  reexportar na mesma janela; se é o mesmo período com totais diferentes, nomeia
  os valores. A DECISÃO de bloquear/perguntar é do pipeline, não daqui.
"""
from __future__ import annotations

FECHO_CONFERIR = "Confira o relatório no Superlógica antes de gerar."


def brl(v: float) -> str:
    """Formata em real brasileiro, sempre positivo (o sinal vem da frase)."""
    s = f"{abs(round(v, 2)):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return "R$ " + s


def _dif(a: float, b: float) -> str:
    return brl(abs(round(a - b, 2)))


# ── Número que não fecha dentro de um arquivo (classe B) ─────────────────────

def msg_caixa(fonte: str, esperado: float, saldo_final: float) -> str:
    return (f"O {fonte} não fecha o caixa: saldo anterior mais receitas menos "
            f"despesas dá {brl(esperado)}, mas o saldo final informado é "
            f"{brl(saldo_final)}. Diferença de {_dif(esperado, saldo_final)}.")


def msg_soma(fonte: str, o_que: str, soma: float, total: float) -> str:
    """o_que: 'as receitas', 'as categorias de despesa', 'os lançamentos de X'."""
    return (f"No {fonte}, {o_que} somam {brl(soma)}, mas o total informado é "
            f"{brl(total)}. Diferença de {_dif(soma, total)}.")


def msg_mov(fonte: str, mov: float, esperado: float) -> str:
    return (f"No {fonte}, o movimento líquido informado é {brl(mov)}, mas "
            f"receitas menos despesas dá {brl(esperado)}. "
            f"Diferença de {_dif(mov, esperado)}.")


def juntar_problemas(problemas: list[str]) -> str:
    """Une as frases de inconsistência e fecha com a instrução ao operador."""
    return " ".join(problemas) + " " + FECHO_CONFERIR


# ── Divergência entre fontes (classe C) ──────────────────────────────────────

def _data_chave(d: str) -> tuple:
    # "DD/MM/YYYY" -> (ano, mes, dia) comparável. Blindado: data vazia ou fora
    # do formato (cabeçalho não reconhecido que ainda assim parseou) devolve
    # (0,0,0) em vez de estourar int("") — o que jogaria um ValueError técnico
    # em inglês no ramo genérico e sabotaria a mensagem PT desta entrega.
    try:
        return (int(d[6:10]), int(d[3:5]), int(d[0:2]))
    except (ValueError, TypeError, IndexError):
        return (0, 0, 0)


def _juntar_nomes(nomes: list[str]) -> str:
    if len(nomes) == 1:
        return nomes[0]
    if len(nomes) == 2:
        return nomes[0] + " e " + nomes[1]
    return ", ".join(nomes[:-1]) + " e " + nomes[-1]


def msg_janela_diferente(janelas: list, saldo_dif: float | None = None) -> str:
    """janelas: lista de (fonte, data_inicial, data_final) em DD/MM/YYYY.
    Explica que as janelas divergem e sugere reexportar a de janela maior."""
    grupos: dict = {}
    ordem: list = []
    for fonte, di, df in janelas:
        chave = (di, df)
        if chave not in grupos:
            grupos[chave] = []
            ordem.append(chave)
        grupos[chave].append(fonte)

    partes = []
    for (di, df) in ordem:
        nomes = grupos[(di, df)]
        verbo = "cobre" if len(nomes) == 1 else "cobrem"
        partes.append(f"{_juntar_nomes(nomes)} {verbo} {di} a {df}")
    msg = "Os arquivos cobrem janelas diferentes. " + ". ".join(partes) + "."

    if saldo_dif is not None:
        msg += (f" O saldo final difere em {brl(saldo_dif)}, "
                "compatível com a diferença de janela.")

    maior = max(janelas, key=lambda t: _data_chave(t[2]))
    msg += (f" Reexporte o {maior[0]} na mesma janela dos outros, "
            "ou gere apenas com os relatórios da mesma janela.")
    return msg


def msg_mesma_janela_divergencia(di: str, df: str, totais: list) -> str:
    """totais: lista de (fonte, receita_total, despesa_total). Mesmo período,
    números diferentes entre relatórios: nomeia os valores de cada fonte."""
    rec = "; ".join(f"{f} {brl(r)}" for f, r, _ in totais)
    desp = "; ".join(f"{f} {brl(d)}" for f, _, d in totais)
    return (f"As fontes cobrem o mesmo período ({di} a {df}), mas os totais "
            f"divergem entre os relatórios. Receitas: {rec}. Despesas: {desp}. "
            + FECHO_CONFERIR)
