# -*- coding: utf-8 -*-
"""Explicação dos números que assustam na prestação de contas (pedido do Matheus, 23/10/2026).

Déficit no período, caixa caindo, mês negativo ou receita que não cobriu a despesa não podem
aparecer "secos" no começo da apresentação: o morador lê como má gestão ou previsão errada
antes de chegar ao detalhamento. Este módulo investiga, só com os números do próprio período
(sem IA e sem inventar nada), o que causou cada número negativo:

  - despesa não recorrente: rubrica que num mês ficou muito acima do normal dela (obra,
    compra, reparo, rescisão, ação judicial) ou que só aparece em poucos meses;
  - despesa sazonal: 13º salário, férias, IPTU, seguro anual, dissídio;
  - queda de arrecadação: receita do mês bem abaixo da mediana (inadimplência, atraso);
  - caixa acumulado: o déficit foi pago com o saldo que o condomínio já tinha guardado.

Devolve os sinais (para a curadoria escrever com as palavras certas, junto com as
observações do usuário) e textos prontos em linguagem simples, usados quando a curadoria
não escrever nada. Os textos citam só valores e nomes que estão nos dados.
"""
from __future__ import annotations

import re
import unicodedata
from statistics import median

MES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

SAZONAL = re.compile(r"13[ºO°]?\s*SAL|DECIMO TERCEIRO|FERIAS|IPTU|SEGURO|DISSIDIO|ABONO|PLR", re.I)
NAO_RECORRENTE = re.compile(
    r"OBRA|REFORMA|BENFEITORIA|INVESTIMENTO|IMOBILIZADO|EQUIPAMENTO|AQUISI|COMPRA|INSTALA|"
    r"RESCIS|INDENIZ|JUDICIAL|PROCESSO|ACORDO|CUSTAS|HONORARIOS ADVOCAT|PROJETO|PINTURA|"
    r"IMPERMEABILIZ|FACHADA|MODERNIZ|SUBSTITUI|TROCA|REPARO|CONSERTO|EMERGENC|LAUDO|PERICIA|AUDITORIA",
    re.I)


def _sem_acento(s: str) -> str:
    return unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().upper()


def _brl(v: float) -> str:
    return "R$ " + f"{abs(v):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _brl_curto(v: float) -> str:
    v = abs(v)
    if v >= 1_000_000:
        x = f"{v/1_000_000:.1f}".replace(".", ",")
        return "R$ " + x + (" milhão" if v < 2_000_000 else " milhões")
    if v >= 10_000:
        return "R$ " + f"{v/1000:,.0f}".replace(",", ".") + " mil"
    return _brl(v)


def _nome(s: str) -> str:
    """Rubrica em caixa alta do sistema vira nome legível: 'MANUTENÇÃO ELEVADOR' -> 'Manutenção elevador'."""
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    if not s:
        return s
    s = s.lower()
    return s[0].upper() + s[1:]


def _rot_mes(chave: str, label: str | None = None) -> str:
    if re.match(r"^\d{4}-\d{2}$", str(chave or "")):
        y, m = chave.split("-")
        return f"{MES_CURTO[int(m) - 1]}/{y[2:]}"
    return str(label or chave)


def analisar(dados: dict) -> dict:
    """dados no formato do dados.json da skill (de_superlogica ou extrair)."""
    periodo = list(dados.get("periodo") or [])
    labels = list(dados.get("meses_label") or periodo)
    rec = [float(v or 0) for v in dados.get("receitas_mes") or []]
    desp = [float(v or 0) for v in dados.get("despesas_mes") or []]
    n = min(len(rec), len(desp))
    if not n:
        return {"ha_alerta": False}
    rec, desp = rec[:n], desp[:n]
    meses = [_rot_mes(periodo[i] if i < len(periodo) else "", labels[i] if i < len(labels) else str(i + 1)) for i in range(n)]
    sup = [r - d for r, d in zip(rec, desp)]
    R, Dt = sum(rec), sum(desp)
    res = R - Dt
    ini = float(dados.get("saldo_anterior") or 0)
    fim = float(dados.get("saldo_final") or (ini + res))
    media_desp = Dt / n if n else 0.0
    med_rec = median(rec) if rec else 0.0

    # 1. Despesas fora do normal: o excesso de cada rubrica sobre a mediana dela no mês.
    picos = []
    for cat in dados.get("categorias") or []:
        for r in cat.get("rubricas") or []:
            serie = [float(v or 0) for v in (r.get("serie") or [])][:n]
            if len(serie) < n:
                serie += [0.0] * (n - len(serie))
            nome_r, nome_c = r.get("nome", ""), cat.get("nome", "")
            chave = _sem_acento(nome_r + " " + nome_c)
            ativos = sum(1 for v in serie if abs(v) > 0.004)
            base = median(serie)
            sazonal = bool(SAZONAL.search(chave))
            pontual = ativos <= max(2, n // 3)
            for i, v in enumerate(serie):
                exc = v - base
                if exc <= max(0.04 * media_desp, 800.0):
                    continue
                if not (v >= 1.8 * max(base, 1.0) or (pontual and NAO_RECORRENTE.search(chave))):
                    continue
                tipo = "sazonal" if sazonal else "nao_recorrente"
                itens_mes = (r.get("itens_mes") or {}).get(periodo[i] if i < len(periodo) else "", [])
                picos.append({
                    "categoria": nome_c, "rubrica": nome_r, "nome": _nome(nome_r), "mes": meses[i], "indice": i,
                    "valor": round(v, 2), "excesso": round(exc, 2), "normal": round(base, 2), "tipo": tipo,
                    "itens": [{"rotulo": _nome(x[0]), "valor": round(float(x[1]), 2)} for x in itens_mes[:3]],
                })
    picos.sort(key=lambda p: -p["excesso"])
    extra = round(sum(p["excesso"] for p in picos if p["tipo"] == "nao_recorrente"), 2)
    sazon = round(sum(p["excesso"] for p in picos if p["tipo"] == "sazonal"), 2)

    # 2. Meses negativos e o que puxou cada um.
    meses_neg = []
    for i, v in enumerate(sup):
        if v >= 0:
            continue
        motivos = []
        for p in [p for p in picos if p["indice"] == i][:2]:
            motivos.append(("despesa sazonal: " if p["tipo"] == "sazonal" else "") + f"{p['nome']} ({_brl_curto(p['valor'])})")
        if med_rec > 0 and rec[i] < 0.85 * med_rec:
            motivos.append(f"arrecadação {round((1 - rec[i] / med_rec) * 100):d}% abaixo da média")
        meses_neg.append({"mes": meses[i], "indice": i, "resultado": round(v, 2), "motivos": motivos})

    # 3. Quedas de arrecadação no período.
    quedas = [{"mes": meses[i], "receita": round(rec[i], 2), "mediana": round(med_rec, 2)}
              for i in range(n) if med_rec > 0 and rec[i] < 0.85 * med_rec]

    cob = (R / Dt * 100) if Dt else 0.0
    desp_sem = Dt - extra
    cob_sem = (R / desp_sem * 100) if desp_sem > 0 else 0.0
    ha_alerta = res < 0 or bool(meses_neg) or fim < ini

    sinais = {
        "ha_alerta": ha_alerta, "resultado": round(res, 2), "cobertura": round(cob, 1),
        "despesas_nao_recorrentes": [p for p in picos if p["tipo"] == "nao_recorrente"][:8],
        "despesas_sazonais": [p for p in picos if p["tipo"] == "sazonal"][:4],
        "grupos": _agrupar(picos, meses),
        "total_nao_recorrente": extra, "total_sazonal": sazon,
        "cobertura_sem_nao_recorrentes": round(cob_sem, 1),
        "resultado_sem_nao_recorrentes": round(res + extra, 2),
        "meses_negativos": meses_neg, "quedas_arrecadacao": quedas,
        "saldo_inicial": round(ini, 2), "saldo_final": round(fim, 2),
        "caixa_cobriu": res < 0 and fim > 0,
        "contas": _movimento_contas(dados.get("contas"), meses),
    }
    sinais["textos"] = textos_padrao(sinais)
    return sinais


RESERVA = re.compile(r"FUNDO|RESERVA|POUPAN|APLICA|CAPITAL|TAXA|OBRA|INVEST|PROVIS|FERIAS|TRABALH|13", re.I)


def _movimento_contas(contas, meses: list) -> list:
    """Para cada conta: saldo no início e no fim, e os meses em que saiu ou entrou dinheiro
    além do rendimento. Conta de reserva (fundo, poupança, aplicação) é marcada, porque o uso
    dela é o que o morador precisa entender quando o caixa cai."""
    out = []
    for c in contas or []:
        ini, fim = float(c.get("ini") or 0), float(c.get("fim") or 0)
        sal = c.get("saldos")
        saidas, entradas = [], []
        if isinstance(sal, list) and len(sal) == len(meses) + 1:
            for i in range(len(meses)):
                d = float(sal[i + 1]) - float(sal[i])
                limite = max(300.0, 0.01 * max(abs(float(sal[i])), 1.0))
                if d < -limite:
                    saidas.append({"mes": meses[i], "valor": round(-d, 2)})
                elif d > limite:
                    entradas.append({"mes": meses[i], "valor": round(d, 2)})
        out.append({
            "nome": _nome(c.get("nome")) if c.get("nome") else "Conta", "nome_original": c.get("nome"),
            "reserva": bool(RESERVA.search(_sem_acento(c.get("nome")))),
            "ini": round(ini, 2), "fim": round(fim, 2), "variacao": round(fim - ini, 2),
            "saidas": saidas, "entradas": entradas,
            "total_saidas": round(sum(x["valor"] for x in saidas), 2),
        })
    return out


def _agrupar(picos: list, meses: list) -> list:
    """Junta os meses fora do normal da mesma rubrica: 'reforma do salão, abr a ago/26, R$ 213 mil'."""
    grupos = {}
    for p in picos:
        g = grupos.setdefault((p["categoria"], p["rubrica"]), {
            "categoria": p["categoria"], "rubrica": p["rubrica"], "nome": p["nome"], "tipo": p["tipo"],
            "meses": [], "valor": 0.0, "excesso": 0.0, "itens": []})
        g["meses"].append(p["mes"]); g["valor"] += p["valor"]; g["excesso"] += p["excesso"]
        for it in p["itens"]:
            if it["rotulo"] and it["rotulo"] not in [x["rotulo"] for x in g["itens"]] and len(g["itens"]) < 6:
                g["itens"].append(it)
    lst = sorted(grupos.values(), key=lambda g: -g["excesso"])
    for g in lst:
        ordem = [m for m in meses if m in g["meses"]]
        g["periodo"] = ordem[0] if len(ordem) == 1 else f"{ordem[0].split('/')[0]} a {ordem[-1]}"
        g["valor"] = round(g["valor"], 2); g["excesso"] = round(g["excesso"], 2)
    return lst[:6]


def textos_padrao(s: dict) -> dict:
    """Frases curtas para os slides, só com fatos dos dados (nomes das rubricas, meses, valores e
    contas). A curadoria pode reescrever com mais naturalidade e com as observações do usuário;
    estas ficam como base quando ela não escrever. Vazio quando não há o que explicar."""
    if not s.get("ha_alerta"):
        return {}
    grupos = [g for g in (s.get("grupos") or []) if g["tipo"] == "nao_recorrente"]
    sazon = [g for g in (s.get("grupos") or []) if g["tipo"] == "sazonal"]
    reservas = [c for c in (s.get("contas") or []) if c["reserva"] and c["total_saidas"] > 0]
    reservas.sort(key=lambda c: -c["total_saidas"])

    def lista_grupos(gs, n=2):
        return " e ".join(f"{g['nome'].lower()} ({_brl_curto(g['valor'])}, {g['periodo']})" for g in gs[:n])

    out = {}
    causa = ""
    if grupos:
        causa = "despesas fora da rotina: " + lista_grupos(grupos)
    elif sazon:
        causa = "despesas sazonais: " + lista_grupos(sazon)
    elif s.get("quedas_arrecadacao"):
        causa = "meses com arrecadação abaixo da média"
    fonte = ""
    if reservas:
        r0 = reservas[0]
        fonte = f"{r0['nome']} ({_brl_curto(r0['ini'])} para {_brl_curto(r0['fim'])})"

    if s["resultado"] < 0:
        partes = [("O déficit veio de " + causa + ".") if causa else "As despesas do período superaram a arrecadação."]
        if grupos and s["cobertura_sem_nao_recorrentes"] >= 98:
            partes.append("Sem elas, a receita cobriria " + str(round(s["cobertura_sem_nao_recorrentes"])) + "% das despesas.")
        if fonte:
            partes.append(f"Foram pagas com recursos guardados: saíram {_brl_curto(reservas[0]['total_saidas'])} do {fonte}.")
        elif s.get("caixa_cobriu"):
            partes.append("A diferença foi paga com o saldo que o condomínio já tinha guardado.")
        out["resumo"] = " ".join(partes)
        curta = grupos[0]["nome"].lower() if grupos else (sazon[0]["nome"].lower() if sazon else "despesas acima da arrecadação")
        out["caixa"] = (f"Uso planejado de reserva: {curta}" if fonte else f"Caixa usado para {curta}")
    elif s["meses_negativos"]:
        com = [m for m in s["meses_negativos"] if m["motivos"]]
        out["resumo"] = "O período fechou positivo. " + (
            "Meses negativos pontuais: " + "; ".join(f"{m['mes']}, {m['motivos'][0]}" for m in com[:2]) + "."
            if com else "Os meses negativos foram compensados pelos demais.")
    out["meses"] = {m["mes"]: ", ".join(m["motivos"][:2]) for m in s["meses_negativos"] if m["motivos"]}
    out["rubricas"] = {}
    for g in grupos + sazon:
        k = g["categoria"] + "|" + g["rubrica"]
        o_que = ", ".join(i["rotulo"] for i in g["itens"][:2] if i["rotulo"])
        out["rubricas"][k] = (("Despesa sazonal" if g["tipo"] == "sazonal" else "Fora da rotina")
                              + f" em {g['periodo']}" + (f": {o_que}" if o_que else "") + ".")[:160]
    if reservas:
        out["contas"] = "; ".join(f"{c['nome']}: saíram {_brl_curto(c['total_saidas'])} em " +
                                  ", ".join(x['mes'] for x in c['saidas'][:4]) for c in reservas[:2]) + "."
    return out
