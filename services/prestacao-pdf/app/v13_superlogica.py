# -*- coding: utf-8 -*-
"""Prestacao v13 a partir dos dados puxados do Superlogica (sem PDF).

O Hub busca no Superlogica, mes a mes, o balancete do plano de contas, o saldo
do caixa e as despesas liquidadas, e manda tudo cru para ca. Este modulo monta o
MESMO dados.json que o extrair.py da skill monta a partir do W011A detalhado, e o
rascunho sai da propria funcao da skill. Dai para frente o fluxo e identico
(curadoria, montar.py, auditoria).

Conferencias (iguais as do extrair.py, param a geracao se nao fecharem):
  - em cada mes, a soma das rubricas fecha com o total de receitas e de despesas
  - o saldo calculado no fim do periodo bate com o saldo do caixa no dia seguinte
  - em cada rubrica, a soma dos lancamentos e comparada com o total (status
    'exato' ou 'diverge', que decide se o texto pode afirmar a soma)
"""
from __future__ import annotations

import re
from collections import OrderedDict, defaultdict

TOL = 0.02


class ErroDados(Exception):
    """Mensagem pronta para o usuario."""


def _meses_entre(a: str, b: str) -> list[str]:
    y, m = map(int, a.split("-")); y2, m2 = map(int, b.split("-")); out = []
    while (y, m) <= (y2, m2):
        out.append("%04d-%02d" % (y, m)); m += 1
        if m == 13: y += 1; m = 1
    return out


_ABR = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]


def _rotulo_mes(k: str) -> str:
    y, m = k.split("-"); return f"{_ABR[int(m) - 1]}/{y[2:]}"


def _norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _cents(v: float) -> int:
    return int(round(v * 100))


def _mes_da_data(s: str) -> str | None:
    """'09/08/2026 00:00:00' (MM/DD/AAAA) ou '2026-09-08 ...' -> '2026-09'."""
    s = (s or "").strip()
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s)
    if m: return "%s-%s" % (m.group(3), m.group(1))
    m = re.match(r"(\d{4})-(\d{2})-\d{2}", s)
    if m: return "%s-%s" % (m.group(1), m.group(2))
    return None


def _linhas_balancete(bruto) -> list[dict]:
    """O balancete vem como [{'itens': [[linha], [linha], ...]}]."""
    out = []
    for bloco in bruto or []:
        for grupo in (bloco or {}).get("itens") or []:
            for linha in grupo or []:
                if isinstance(linha, dict) and linha.get("conta"):
                    out.append(linha)
    return out


def _chave_conta(c: str):
    return tuple(int(p) if p.isdigit() else 0 for p in c.split("."))


def _ler_mes(bruto, mes: str):
    """Receitas e despesas de um mes, folha por folha do plano de contas.
    Folha = linha com campo 'itens' (as linhas de grupo vem sem ele).
    Despesa fica na categoria de nivel 2 (2.x), como no W011A."""
    linhas = _linhas_balancete(bruto)
    por_conta = {l["conta"].strip(): l for l in linhas}
    tot_rec = _num(por_conta.get("1", {}).get("valor"))
    tot_desp = _num(por_conta.get("2", {}).get("valor"))
    rec, desp, ordem = OrderedDict(), OrderedDict(), {}
    for l in sorted(linhas, key=lambda x: _chave_conta(x["conta"].strip())):
        conta = l["conta"].strip()
        if l.get("itens") is None:
            continue
        nome = _norm(l.get("descricao"))
        v = _num(l.get("valor"))
        partes = conta.split(".")
        if partes[0] == "1" and len(partes) >= 2:
            rec[nome] = rec.get(nome, 0.0) + v
        elif partes[0] == "2" and len(partes) >= 3:
            cat_l = por_conta.get(".".join(partes[:2]))
            cat = _norm(cat_l.get("descricao")) if cat_l else "OUTRAS DESPESAS"
            desp.setdefault(cat, OrderedDict())
            desp[cat][nome] = desp[cat].get(nome, 0.0) + v
            ordem[(cat, nome)] = conta
    if abs(sum(rec.values()) - tot_rec) > TOL:
        raise ErroDados(f"Os números do Superlógica não fecharam: receitas de {_rotulo_mes(mes)}.")
    soma_desp = sum(v for c in desp.values() for v in c.values())
    if abs(soma_desp - tot_desp) > TOL:
        raise ErroDados(f"Os números do Superlógica não fecharam: despesas de {_rotulo_mes(mes)}.")
    return rec, desp, tot_rec, tot_desp, ordem


def _itens_das_despesas(despesas: list, periodo: list[str], conta_para_cat: dict, nome_por_conta: dict):
    """Cada parcela liquidada no periodo vira um item por apropriacao, no mesmo
    formato de nome do W011A detalhado ('<rubrica> <complemento> (parc x/y)').
    O valor da parcela e dividido pela fracao de cada apropriacao (ultima leva
    o resto, para nao perder centavo)."""
    itens = defaultdict(list)
    vistos = set()
    per = set(periodo)
    for d in despesas or []:
        chave = d.get("id_parcela_pdes") or (d.get("id_despesa_des"), d.get("st_complemento_pdes"), d.get("dt_liquidacao_pdes"))
        if chave in vistos:
            continue
        vistos.add(chave)
        if str(d.get("fl_liquidado_pdes") or "") != "1":
            continue
        if _mes_da_data(d.get("dt_liquidacao_pdes")) not in per:
            continue
        total = _cents(_num(d.get("vl_valor_pdes")))
        aps = [a for a in (d.get("apropriacao") or []) if isinstance(a, dict)]
        if not aps or not total:
            continue
        fr = [_num(a.get("vl_valor_apro")) for a in aps]
        soma_fr = sum(fr) or 1.0
        partes, acum = [], 0
        for i, f in enumerate(fr):
            v = total - acum if i == len(fr) - 1 else int(round(total * f / soma_fr))
            acum += v; partes.append(v)
        parc = _norm(d.get("st_complemento_pdes"))
        mparc = re.match(r"(\d+)\s+de\s+(\d+)", parc)
        for a, v in zip(aps, partes):
            conta = _norm(a.get("st_conta_cont"))
            cat = conta_para_cat.get(".".join(conta.split(".")[:2]))
            rub = nome_por_conta.get(conta) or _norm(a.get("st_descricao_cont"))
            if not cat or not conta.startswith("2."):
                continue
            nome = _norm(f"{rub} {a.get('st_complemento_apro') or ''}")
            if mparc:
                nome += f" (parc {mparc.group(1)}/{mparc.group(2)})"
            itens[(cat, rub)].append((nome, v / 100.0, _mes_da_data(d.get("dt_liquidacao_pdes"))))
    return itens


def de_superlogica(bruto: dict) -> dict:
    """Entrada da rota /v13/de-superlogica: dados + rascunho no formato da skill."""
    from . import v13
    import importlib.util
    if not isinstance(bruto, dict) or not re.match(r"^\d{4}-\d{2}$", str(bruto.get("inicio") or "")) \
            or not re.match(r"^\d{4}-\d{2}$", str(bruto.get("fim") or "")) or bruto["inicio"] > bruto["fim"]:
        raise ErroDados("Período inválido.")
    spec = importlib.util.spec_from_file_location("extrair_skill", v13.SCRIPTS / "extrair.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    dados = montar_dados(bruto, mod)
    v13._desambiguar(dados)
    # Números que assustam (déficit, mês negativo, uso de reserva) já saem investigados,
    # para a curadoria escrever a explicação junto com as observações do usuário.
    from . import justificativas
    try:
        dados["sinais"] = justificativas.analisar(dados)
    except Exception:  # explicação nunca derruba a prestação
        dados["sinais"] = {"ha_alerta": False}
    import json
    rascunho = json.loads(json.dumps(mod.rascunho(dados), ensure_ascii=False))
    return {"dados": dados, "rascunho": rascunho}


def _contas_validas(contas, s_ini: float, s_fim: float, n: int):
    """Saldo de cada conta (vindo do Hub). Só vale se a soma das contas bater com o caixa
    no início e no fim; senão a prestação segue sem esse detalhe (nunca mostra conta que não fecha)."""
    if not isinstance(contas, list) or not contas:
        return None
    lst = []
    for c in contas:
        if not isinstance(c, dict):
            return None
        try:
            ini, fim = round(float(c.get("ini")), 2), round(float(c.get("fim")), 2)
        except (TypeError, ValueError):
            return None
        sal = c.get("saldos")
        if not (isinstance(sal, list) and len(sal) == n + 1 and all(isinstance(v, (int, float)) for v in sal)):
            sal = None
        lst.append({"nome": _norm(c.get("nome")) or "Conta", "ini": ini, "fim": fim, "saldos": sal})
    if abs(sum(c["ini"] for c in lst) - s_ini) > 1 or abs(sum(c["fim"] for c in lst) - s_fim) > 1:
        return None
    return lst


def montar_dados(bruto: dict, extrair_mod) -> dict:
    """bruto = {condominio:{nome,fantasia}, inicio, fim, balancetes:{AAAA-MM: json},
    saldo_inicial, saldo_final_ref (ou None), despesas:[...]}."""
    inicio, fim = bruto.get("inicio"), bruto.get("fim")
    periodo = _meses_entre(inicio, fim)
    bal = bruto.get("balancetes") or {}
    falta = [m for m in periodo if m not in bal]
    if falta:
        raise ErroDados("Faltaram meses na consulta ao Superlógica: " + ", ".join(_rotulo_mes(m) for m in falta) + ".")

    rec = defaultdict(lambda: defaultdict(float))
    desp = OrderedDict()
    conta_rub, rec_m, desp_m = {}, [], []
    for mes in periodo:
        r, d, tr, td, ordem = _ler_mes(bal[mes], mes)
        rec_m.append(round(tr, 2)); desp_m.append(round(td, 2))
        for k, v in r.items(): rec[k][mes] += v
        for c, rubs in d.items():
            dc = desp.setdefault(c, OrderedDict())
            for k, v in rubs.items():
                dc.setdefault(k, defaultdict(float))[mes] += v
        conta_rub.update(ordem)

    serie = lambda dd: [round(dd.get(m, 0.0), 2) for m in periodo]
    s_ini = round(_num(bruto.get("saldo_inicial")), 2)
    saldos, s = [], s_ini
    for r_, d_ in zip(rec_m, desp_m):
        s = round(s + r_ - d_, 2); saldos.append(s)
    ref = bruto.get("saldo_final_ref")
    if ref is not None and abs(saldos[-1] - _num(ref)) > TOL:
        raise ErroDados("O saldo calculado no fim do período (%s) não bate com o saldo do caixa no Superlógica (%s)."
                        % (f"{saldos[-1]:,.2f}", f"{_num(ref):,.2f}"))

    receitas = [{"nome": k, "serie": serie(v), "total": round(sum(serie(v)), 2)} for k, v in rec.items()]
    receitas = [r for r in receitas if abs(r["total"]) > 0.004]
    categorias = []
    for c, rubs in desp.items():
        rl = [{"nome": k, "serie": serie(v), "total": round(sum(serie(v)), 2), "itens": [], "status": "sem_detalhe"}
              for k, v in rubs.items()]
        rl = [r for r in rl if abs(r["total"]) > 0.004]
        if rl:
            categorias.append({"nome": c, "total": round(sum(r["total"] for r in rl), 2), "rubricas": rl})
    if abs(sum(r["total"] for r in receitas) - sum(rec_m)) > TOL:
        raise ErroDados("Os números do Superlógica não fecharam: total de receitas do período.")
    if abs(sum(c["total"] for c in categorias) - sum(desp_m)) > TOL:
        raise ErroDados("Os números do Superlógica não fecharam: total de despesas do período.")

    # Itens de cada rubrica a partir das despesas liquidadas.
    conta_para_cat, nome_por_conta = {}, {}
    for (cat, rub), conta in conta_rub.items():
        conta_para_cat[".".join(conta.split(".")[:2])] = cat
        nome_por_conta[conta] = rub
    itens = _itens_das_despesas(bruto.get("despesas") or [], periodo, conta_para_cat, nome_por_conta)
    for c in categorias:
        for r in c["rubricas"]:
            lst3 = itens.get((c["nome"], r["nome"]), [])
            lst = [(nm, v) for nm, v, _ in lst3]
            soma = round(sum(v for _, v in lst), 2)
            if lst:
                r["status"] = "exato" if abs(soma - r["total"]) < TOL else f"diverge ({soma:.2f})"
                r["itens"] = extrair_mod._agrupa(lst, r["nome"])
                # Maiores itens de cada mês: explicam o mês em que a rubrica fugiu do normal.
                por_mes = defaultdict(list)
                for nm, v, mes in lst3:
                    por_mes[mes].append((nm, v))
                r["itens_mes"] = {m: [(g["rotulo"], g["valor"]) for g in extrair_mod._agrupa(l, r["nome"])[:3]]
                                  for m, l in por_mes.items() if m}

    cond = bruto.get("condominio") or {}
    nome = _norm(cond.get("fantasia") or cond.get("nome") or "")
    contas = _contas_validas(bruto.get("contas"), s_ini, saldos[-1], len(periodo))
    return dict(condominio=nome, modo="detalhado", fonte_itens="superlogica", periodo=periodo, contas=contas,
                meses_label=[_rotulo_mes(m) for m in periodo], saldo_anterior=s_ini, saldo_final=saldos[-1],
                receitas_mes=rec_m, despesas_mes=desp_m, saldo_fim_mes=saldos,
                receitas=sorted(receitas, key=lambda r: -r["total"]),
                categorias=sorted(categorias, key=lambda c: -c["total"]))
