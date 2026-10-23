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


# Rótulo de item que fala de pessoa (férias, salário, rescisão): o nome do funcionário
# nunca vai para o slide. Fica só o tipo da despesa e as datas, quando houver.
PESSOAL_ITEM = re.compile(r"FERIAS|SALARI|13[ºO°]?\s*SAL|DECIMO|RESCIS|DEMISS|ADIANTAMENTO|AVISO PREVIO|HORA EXTRA|"
                          r"PRO\s*LABORE|BONIFICA|GRATIFICA", re.I)
# Tipo da despesa que fica no lugar do nome (a ordem decide: "adiantamento salarial" é adiantamento).
_TIPO_PESSOAL = [
    (r"FERIAS", "férias"), (r"13[ºO°]?\s*SAL|DECIMO", "13º salário"), (r"RESCIS|DEMISS", "rescisão"),
    (r"AVISO PREVIO", "aviso prévio"), (r"ADIANTAMENTO", "adiantamento salarial"), (r"HORA EXTRA", "horas extras"),
    (r"PRO\s*LABORE", "pró labore"), (r"BONIFICA", "bonificação"), (r"GRATIFICA", "gratificação"), (r"SALARI", "salário"),
]
_PREFIXO_REF = re.compile(r"^\s*(?:ref(?:erente)?\.?\s*[-:\u2010-\u2015]\s*(?:(?:a|ao|à|aos|às|as)\s+)?|"
                          r"ref(?:erente)?\.?(?:\s+(?:a|ao|à|aos|às|as))?\s+|ref\.\s*)", re.I)
_DATA = r"\d{1,2}/\d{2}(?:/\d{2,4})?"
_DATAS = re.compile(rf"\d{{1,2}}(?:/\d{{2}}(?:/\d{{2,4}})?)?\s*(?:a|à|até)\s*{_DATA}|{_DATA}")


def sem_hifen(t: str) -> str:
    """Regra do Matheus: nada de hífen ou travessão como pontuação no texto do slide.
    ' - ' vira vírgula; hífen que junta dois nomes vira ' e ' (Eletrodoméstico-Eletroeletrônico,
    DARF INSS- CRF); hífen de palavra composta vira espaço (guarda-corpo)."""
    t = re.sub(r"\b([Ee])-mail", r"\1mail", str(t or ""))
    t = re.sub(r"\s+[-\u2010-\u2015\u2212]+\s+", ", ", t)
    t = re.sub(r"(?<=[A-Za-zÀ-ÿ])\s*[-\u2010-\u2015\u2212]\s*(?=[A-ZÀ-Þ])", " e ", t)
    t = re.sub(r"[-\u2010-\u2015\u2212]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _tipo_pessoal(texto: str) -> str:
    t = _sem_acento(texto)
    for rx, nome in _TIPO_PESSOAL:
        if re.search(rx, t):
            return nome
    return "despesa com pessoal"


# Palavras comuns com inicial maiúscula em rótulo de despesa de pessoal. Qualquer outra
# palavra assim (Vando, Karlla, Gonçalves) é tratada como nome de pessoa.
_COMUNS = set("""FERIAS SALARIO SALARIOS DECIMO TERCEIRO RESCISAO DEMISSAO ADIANTAMENTO AVISO PREVIO HORA HORAS
EXTRA EXTRAS PRO LABORE BONIFICACAO GRATIFICACAO PARCELA PARCELAS REFERENTE REF PAGAMENTO COMPETENCIA MES MESES
SERVICO SERVICOS ADMINISTRATIVO ADMINISTRATIVA ADMINISTRACAO APOIO COBERTURA PLANO SAUDE AJUDA CUSTO VALE
FUNCIONARIO FUNCIONARIOS FUNCIONARIA EQUIPE PORTEIRO PORTEIROS PORTARIA ZELADOR ZELADORA ZELADORIA LIMPEZA
JARDINEIRO JARDINAGEM AUXILIAR SINDICO SUBSINDICO MANUTENCAO FOLGUISTA FOLGA FOLGAS PERIODO PROPORCIONAL ABONO
CONSTITUCIONAL TERCO INSS FGTS IRRF DARF JANEIRO FEVEREIRO MARCO ABRIL MAIO JUNHO JULHO AGOSTO SETEMBRO OUTUBRO
NOVEMBRO DEZEMBRO JAN FEV MAR ABR MAI JUN JUL AGO SET OUT NOV DEZ PRIMEIRA SEGUNDA TERCEIRA QUARTA ULTIMA
REFORMA OBRA CONDOMINIO COMBINADOS CONTRATADOS CONTRATADO ACORDO MULTA SALDO DIFERENCA RETROATIVO DISSIDIO
NOTURNO ADICIONAL INSALUBRIDADE PERICULOSIDADE BENEFICIO BENEFICIOS ALIMENTACAO TRANSPORTE CESTA NATAL DOS DAS
COM PARA SOBRE PELO PELA MENSAL ANUAL QUINZENA DIAS RECIBO NOTA FISCAL PAGTO PGTO TOTAL VALOR""".split())


def _tem_nome(s: str) -> bool:
    return any(_sem_acento(w) not in _COMUNS for w in re.findall(r"\b[A-ZÀ-Ý][a-zà-ÿ]{2,}\b", s))


def limpa_rotulo(rot: str, rubrica: str = "") -> str:
    """Rótulo do lançamento pronto para a frase: sem 'Ref.', 'Ref. a', 'Referente a',
    sem nome de funcionário em férias, salário e afins ('férias da equipe (datas)') e sem hífen."""
    s = re.sub(r"\s+", " ", str(rot or "")).strip()
    for _ in range(2):
        s = _PREFIXO_REF.sub("", s).strip()
    if s and PESSOAL_ITEM.search(_sem_acento(rubrica + " " + s)) and _tem_nome(s):
        datas = _DATAS.findall(s)
        base = _tipo_pessoal(s) if PESSOAL_ITEM.search(_sem_acento(s)) else _tipo_pessoal(rubrica)
        s = f"{base} da equipe" + (f" ({re.sub(r'\s*(?:à|até)\s*', ' a ', datas[0])})" if datas else "")
    s = sem_hifen(s).strip(" .,;:")
    if s.count("(") > s.count(")"):
        s += ")"
    return s


_ITEM_VALOR = re.compile(r"^(.*?)(\s\(\d+ (?:lançamentos?|competências?)[^)]*\))? (R\$ [\d.]+,\d{2})$")
_VALORES = re.compile(r"R\$ [\d.]+,\d{2}")


def limpa_composicao(texto: str, rubrica: str = "") -> str:
    """Texto de composição da rubrica ('rótulo R$ x · rótulo R$ y') com cada rótulo limpo
    como em limpa_rotulo. Os valores não mudam: se a sequência de 'R$' sair diferente
    (texto fora do padrão), devolve o original, para a conferência de soma ('fecha')
    continuar valendo exatamente como antes."""
    if not isinstance(texto, str) or not texto.strip():
        return texto
    partes = []
    for it in texto.split(" · "):
        m = _ITEM_VALOR.match(it.strip())
        if m:
            rot = m.group(1).strip()
            limpo = rot if rot.lower().startswith("lançamentos sem descrição") else (limpa_rotulo(rot, rubrica) or rot)
            partes.append(f"{limpo}{m.group(2) or ''} {m.group(3)}")
        else:
            # Frase sem valor no fim ('Lançamentos do período ({n} meses)', 'Também: ...'): só
            # prefixo e hífen; o nome só sai em rótulo de item, onde se sabe o que é.
            partes.append(sem_hifen(_PREFIXO_REF.sub("", it.strip())))
    novo = " · ".join(partes)
    if _VALORES.findall(novo) != _VALORES.findall(texto):
        return texto
    return novo


def cortar(t: str, limite: int) -> str:
    """Corta no fim da última frase (ou item) que cabe no limite do slide."""
    t = re.sub(r"\s+", " ", str(t or "")).strip()
    if len(t) <= limite:
        return t
    parte = t[:limite]
    ponto = "." if t.endswith(".") else ""
    i = parte.rfind(". ")
    if i >= 20:
        return parte[:i + 1]
    for sep in ("; ", ", "):
        i = parte.rfind(sep)
        if i >= 20:
            return parte[:i].rstrip(" ,;") + ponto
    return parte.rsplit(" ", 1)[0].rstrip(" ,;:") + ponto


LIMITES = {"resumo": 240, "caixa": 90, "meses": 80, "rubricas": 160, "contas": 220}


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
                    "categoria": nome_c, "rubrica": nome_r, "nome": _nome(sem_hifen(nome_r)), "mes": meses[i], "indice": i,
                    "valor": round(v, 2), "excesso": round(exc, 2), "normal": round(base, 2), "tipo": tipo,
                    "itens": [{"rotulo": _nome(limpa_rotulo(x[0], nome_r)), "valor": round(float(x[1]), 2)} for x in itens_mes[:3]],
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


def _meses_txt(ms: list) -> str:
    """'fev/26, abr/26' ou, com muitos meses, 'entre fev/26 e ago/26' (sem lista enganosa cortada)."""
    if len(ms) <= 3:
        return ", ".join(ms)
    return f"entre {ms[0]} e {ms[-1]}"


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
    nm = lambda g: sem_hifen(g["nome"]).lower()

    def lista_grupos(gs, n=2):
        return " e ".join(f"{nm(g)} ({_brl_curto(g['valor'])}, {g['periodo']})" for g in gs[:n])

    out = {}

    def causa_de(n):
        if grupos:
            return ("despesas fora da rotina: " if n > 1 and len(grupos) > 1 else "despesa fora da rotina: ") + lista_grupos(grupos, n)
        if sazon:
            return "despesas sazonais: " + lista_grupos(sazon, n)
        if s.get("quedas_arrecadacao"):
            return "meses com arrecadação abaixo da média"
        return ""
    causa = causa_de(2)
    fonte = ""
    if reservas:
        r0 = reservas[0]
        fonte = f"{r0['nome']} ({_brl_curto(r0['ini'])} para {_brl_curto(r0['fim'])})"

    if s["resultado"] < 0:
        abre_n = lambda n: ("O déficit veio de " + causa_de(n) + ".") if causa else "As despesas do período superaram a arrecadação."
        abre = abre_n(2)
        def sem_n(pl):
            if grupos and s["cobertura_sem_nao_recorrentes"] >= 98:
                return f"Sem {'elas' if pl else 'ela'}, a receita cobriria " + str(round(s["cobertura_sem_nao_recorrentes"])) + "% das despesas."
            return ""

        def pago_n(pl):
            if fonte:
                return (f"{'Foram pagas' if pl else 'Foi paga'} com recursos guardados: saíram "
                        f"{_brl_curto(reservas[0]['total_saidas'])} do {fonte}.")
            if s.get("caixa_cobriu"):
                return "A diferença foi paga com o saldo que o condomínio já tinha guardado."
            return ""
        pl2 = len(grupos) > 1 or (not grupos and len(sazon) > 1)
        # De onde saiu o dinheiro vale mais que a cobertura sem as despesas: some primeiro o "sem elas".
        for partes in ((abre, sem_n(pl2), pago_n(pl2)), (abre, pago_n(pl2)),
                       (abre_n(1), sem_n(False), pago_n(False)), (abre_n(1), pago_n(False))):
            txt = " ".join(p for p in partes if p)
            if len(txt) <= LIMITES["resumo"]:
                break
        out["resumo"] = txt
        curta = nm(grupos[0]) if grupos else (nm(sazon[0]) if sazon else "despesas acima da arrecadação")
        out["caixa"] = (f"Uso planejado de reserva: {curta}" if fonte else f"Caixa usado para {curta}")
    elif s["meses_negativos"]:
        com = [m for m in s["meses_negativos"] if m["motivos"]]
        out["resumo"] = "O período fechou positivo. " + (
            "Meses negativos pontuais: " + "; ".join(f"{m['mes']}, {m['motivos'][0][:1].lower() + m['motivos'][0][1:]}" for m in com[:2]) + "."
            if com else "Os meses negativos foram compensados pelos demais.")
        if s.get("saldo_final", 0) < s.get("saldo_inicial", 0) and fonte:
            out["caixa"] = f"Uso de reserva: saíram {_brl_curto(reservas[0]['total_saidas'])} do {reservas[0]['nome']}"
    out["meses"] = {m["mes"]: sem_hifen(", ".join(m["motivos"][:2])) for m in s["meses_negativos"] if m["motivos"]}
    out["rubricas"] = {}
    for g in grupos + sazon:
        k = g["categoria"] + "|" + g["rubrica"]
        o_que = "; ".join(i["rotulo"][:1].lower() + i["rotulo"][1:] for i in g["itens"][:2] if i["rotulo"])
        out["rubricas"][k] = (("Despesa sazonal" if g["tipo"] == "sazonal" else "Fora da rotina")
                              + f" em {g['periodo']}" + (f": {o_que}" if o_que else "") + ".")
    if reservas:
        out["contas"] = "; ".join(f"{c['nome']}: saíram {_brl_curto(c['total_saidas'])} " +
                                  ("em " if len(c["saidas"]) <= 3 else "") + _meses_txt([x["mes"] for x in c["saidas"]])
                                  for c in reservas[:2]) + "."
    # Mesmos limites da curadoria, para o slide nunca receber texto maior que o previsto.
    for k in ("resumo", "caixa", "contas"):
        if out.get(k):
            out[k] = cortar(sem_hifen(out[k]), LIMITES[k])
    for k in ("meses", "rubricas"):
        out[k] = {c: cortar(sem_hifen(v), LIMITES[k]) for c, v in out[k].items() if v}
    return out
