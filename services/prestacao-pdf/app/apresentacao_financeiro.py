# -*- coding: utf-8 -*-
"""Resumo financeiro para o item de prestação de contas da apresentação de assembleia
(rota /v13/apresentacao/financeiro).

O Hub puxa do Superlógica os mesmos dados brutos da prestação de contas (balancete mês a mês,
saldo do caixa, despesas liquidadas e saldos das contas) e manda para cá. O caminho é o mesmo
da prestação (v13_superlogica.de_superlogica: montar_dados com as conferências que param se
os números não fecharem, e justificativas.analisar com os sinais de déficit e os textos
padrão). Daqui sai só o resumo pronto para os slides, sem IA:
  saldo inicial e final, receitas e despesas do período e por mês, saldo no fim de cada mês,
  arrecadação por rubrica, despesas por categoria com as rubricas, sinais e textos padrão.
Os valores vão em reais com 2 casas; a conta saldo inicial + receitas menos despesas = saldo
final é conferida no centavo (se não fechar, recusa: nunca entrega número que não bate).
"""
from __future__ import annotations

import re

from . import justificativas
from . import v13_superlogica
from .v13_superlogica import ErroDados

# Siglas que ficam em maiúsculas quando a rubrica do sistema vira nome legível.
SIGLAS = {"INSS", "FGTS", "IPTU", "PIS", "COFINS", "ISS", "ISSQN", "IRRF", "IR", "CSLL", "EDP", "CESAN",
          "CFTV", "TV", "PCMSO", "PPRA", "PGR", "LTCAT", "SPDA", "AVCB", "CNPJ", "CPF", "GLP", "GN", "ETE",
          "ETA", "DARF", "GPS", "RPA", "INCC", "IGPM", "IPCA", "SESMT", "EPI", "EPIS", "VT", "VA", "VR", "13º"}
LIMITE_NOTA = 160  # sub do cartão ou nota do slide
MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
CURTO = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]


def legivel(s) -> str:
    """'MANUTENÇÃO ELEVADOR - INSS' -> 'Manutenção elevador, INSS' (siglas ficam)."""
    s = justificativas.sem_hifen(re.sub(r"\s+", " ", str(s or "")).strip())
    if not s:
        return "Outros lançamentos"
    palavras = []
    for p in s.split(" "):
        limpa = re.sub(r"[^\wº]", "", p).upper()
        palavras.append(p.upper() if limpa in SIGLAS else p.lower())
    out = " ".join(palavras)
    return out[0].upper() + out[1:]


def _cents(v) -> int:
    return int(round(float(v or 0) * 100))


def _r(v) -> float:
    return round(float(v or 0) + 0.0, 2)


def _rot_curto(chave: str) -> str:
    y, m = chave.split("-")
    return f"{CURTO[int(m) - 1]}/{y[2:]}"


def _frase(s: str) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return (s[0].upper() + s[1:]) if s else s


def resumo(bruto: dict) -> dict:
    """bruto no formato do puxarDadosPrestacao do Hub. Levanta ErroDados se não fechar."""
    r = v13_superlogica.de_superlogica(bruto)
    dados = r["dados"]
    sinais = dados.get("sinais") or {"ha_alerta": False}
    textos = sinais.get("textos") or {}
    periodo = list(dados["periodo"])
    rec_m = [_r(v) for v in dados["receitas_mes"]]
    desp_m = [_r(v) for v in dados["despesas_mes"]]
    saldos = [_r(v) for v in dados["saldo_fim_mes"]]
    ini, fim = _r(dados["saldo_anterior"]), _r(dados["saldo_final"])
    tot_rec = sum(_cents(v) for v in rec_m)
    tot_desp = sum(_cents(v) for v in desp_m)
    if _cents(ini) + tot_rec - tot_desp != _cents(fim):
        raise ErroDados("Os números do período não fecharam: saldo inicial mais receitas menos despesas não dá o saldo final.")

    # Explicação de cada mês negativo: o texto padrão do justificativas (já no limite de 80
    # caracteres), senão os motivos achados nos números, senão o saldo que cobriu.
    neg = {m.get("indice"): m for m in sinais.get("meses_negativos") or []}
    txt_meses = textos.get("meses") or {}
    meses = []
    for i, chave in enumerate(periodo):
        res = (_cents(rec_m[i]) - _cents(desp_m[i])) / 100
        exp = ""
        if res < 0:
            motivos = (neg.get(i) or {}).get("motivos") or []
            exp = _frase(txt_meses.get(_rot_curto(chave)) or ", ".join(motivos[:2]))
            if not exp and saldos[i] > 0:
                exp = "Pago com o saldo que o caixa já tinha."
            exp = justificativas.cortar(justificativas.sem_hifen(exp), LIMITE_NOTA)
        meses.append({"chave": chave, "rotulo": dados["meses_label"][i], "curto": _rot_curto(chave),
                      "receitas": rec_m[i], "despesas": desp_m[i], "resultado": round(res, 2),
                      "saldo_fim": saldos[i], "explicacao": exp})

    arrecadacao = [{"nome": legivel(x["nome"]), "chave": x["nome"], "total": _r(x["total"]), "serie": [_r(v) for v in x["serie"]]}
                   for x in dados.get("receitas") or []]
    expl_rub = textos.get("rubricas") or {}
    categorias = []
    for c in dados.get("categorias") or []:
        rubs = []
        for rb in sorted(c.get("rubricas") or [], key=lambda x: -(x.get("total") or 0)):
            rubs.append({"nome": legivel(rb.get("nome_exibicao") or rb["nome"]), "chave": rb["nome"], "total": _r(rb["total"]),
                         "serie": [_r(v) for v in rb.get("serie") or []],
                         "explicacao": justificativas.cortar(str(expl_rub.get(c["nome"] + "|" + rb["nome"]) or ""), LIMITE_NOTA)})
        categorias.append({"nome": legivel(c["nome"]), "chave": c["nome"], "total": _r(c["total"]), "rubricas": rubs})

    contas = [{"nome": x.get("nome"), "reserva": bool(x.get("reserva")), "ini": _r(x.get("ini")), "fim": _r(x.get("fim")),
               "total_saidas": _r(x.get("total_saidas"))} for x in sinais.get("contas") or []]
    y0, m0 = periodo[0].split("-")
    yf, mf = periodo[-1].split("-")
    rotulo = (f"{MESES[int(m0) - 1]} de {y0}" if periodo[0] == periodo[-1] else
              f"{MESES[int(m0) - 1]} a {MESES[int(mf) - 1]} de {yf}" if y0 == yf else
              f"{MESES[int(m0) - 1]} de {y0} a {MESES[int(mf) - 1]} de {yf}")
    return {
        "condominio": dados.get("condominio") or "",
        "periodo": periodo, "rotulo_periodo": rotulo, "meses": meses,
        "saldo_inicial": ini, "saldo_final": fim,
        "receitas": round(tot_rec / 100, 2), "despesas": round(tot_desp / 100, 2),
        "resultado": round((tot_rec - tot_desp) / 100, 2),
        "arrecadacao": arrecadacao, "categorias": sorted(categorias, key=lambda c: -c["total"]),
        "contas": contas,
        "sinais": {
            "ha_alerta": bool(sinais.get("ha_alerta")),
            "cobertura": sinais.get("cobertura"),
            "total_nao_recorrente": sinais.get("total_nao_recorrente") or 0,
            "quedas_arrecadacao": [q.get("mes") for q in sinais.get("quedas_arrecadacao") or []],
            "caixa_cobriu": bool(sinais.get("caixa_cobriu")),
        },
        "textos": {k: v for k, v in textos.items() if k in ("resumo", "caixa", "contas") and isinstance(v, str)},
    }
