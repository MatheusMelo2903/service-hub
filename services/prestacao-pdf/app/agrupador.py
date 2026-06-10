# -*- coding: utf-8 -*-
"""Agrupador determinístico dos lançamentos do W016A — números nunca passam
pelo LLM.

Regras (calibradas contra o golden CONFIG do Naturale, Fase 2):

1. Categoria com até 20 lançamentos crus: fusão LEVE — funde apenas linhas
   cuja base normalizada é igual E cujas referências diferem só temporal ou
   serialmente (competência MM/AAAA, parcela X de Y, número de NF, datas,
   códigos longos). Referências com texto distinto (ex. "Torre 01" vs
   "Torre 02") permanecem separadas.
2. Categoria com mais de 20 crus: fusão por RADICAL — agrupa pela base
   normalizada (texto antes de "Ref."/"obs:", sem parcelas e competências).
3. Especiais determinísticos:
   - Retenções: DARF vira grupo único; ISS com competência (MM/AAAA) vira
     "ISS (competências)"; ISS sobre NF agrupa por prestador (TODOS os
     prestadores nomeados — fidelidade total, sem corte por tamanho).
   - Financeiras: linhas de devolução/reembolso de RESERVA viram um grupo
     semântico único (confirmado pelo Matheus na Fase 2).
4. FIDELIDADE TOTAL nas despesas (decisão de produto, 2026-06): TODAS as
   rubricas distintas são nomeadas, maior→menor, sem teto nem "as N
   maiores". Quando não couber no slide, o template PAGINA a categoria.
   "Demais" não é ferramenta de corte; só existe pra receitas (cauda curta
   da lista de fontes, regra própria do slide de Origem da Receita).
5. Ordenação maior→menor; resíduo de receitas sempre por último.

A soma das linhas de saída é validada contra o total da categoria. O LLM,
quando entrar (Fase 4), só poderá reescrever rótulos e propor fusões que
esta camada valida; valores nunca mudam.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

MAX_LINHAS_DESPESA = 20   # limiar de fusão: acima disso entra fusão por radical
MAX_LINHAS_RECEITA = 11   # lista de receitas comporta 11 a partir de 2,45"
# O TETO de rubricas exibidas por slide é decisão editorial e vem do chamador
# (pipeline.TETO_RUBRICAS, default 12 = fronteira da fonte 10/11pt do design
# system). Categoria que cabe inteira sob o teto é nomeada por completo.

# "Ref." sempre tem ponto no W016A; pode vir sem espaço depois ("Ref.Torre").
RE_REF_SPLIT = re.compile(r"\s*[-–]?\s*\b[Rr]efs?\.\s*(?:a\s+)?|\s+obs:\s*")
RE_COMPETENCIA = re.compile(r"\b(\d{2})/(\d{4})\b")
RE_COMPETENCIA_COLADA = re.compile(r"\b(0[1-9]|1[0-2])(20\d{2})\b")
RE_PARCELA = re.compile(
    r"[Pp]arc(?:ela)?\.?\s*(\d+)\s*(?:/|\s+de\s+)\s*(\d+)|(?<![\d/])\b(\d{1,2})\s+de\s+(\d{1,2})\b")
RE_NF = re.compile(r"\bNFs?\.?\s*°?\s*(\d+)", re.IGNORECASE)
RE_CODIGO = re.compile(r"\b[\d.\-]{7,}\b")          # instalações, contas, ARTs
RE_DATA = re.compile(r"\b\d{2}/\d{2}/\d{4}\b|\b\d{2}/\d{2}\b")
RE_ESPACOS = re.compile(r"\s{2,}")


@dataclass
class Linha:
    rotulo: str
    valor: float
    membros: list = field(default_factory=list)   # descrições cruas (pra prosa/LLM)
    residuo: bool = False


def _limpar(texto: str) -> str:
    texto = RE_ESPACOS.sub(" ", texto).strip()
    return texto.strip(" -–.,;:()").strip()


def desmontar(desc: str):
    """Separa (base normalizada, ref). A ref é tudo após 'Ref.'/'obs:'."""
    partes = RE_REF_SPLIT.split(desc, maxsplit=1)
    base = RE_PARCELA.sub(" ", partes[0])
    base = RE_COMPETENCIA.sub(" ", base)
    ref = partes[1] if len(partes) > 1 else ""
    return _limpar(base), _limpar(ref)


def essencia_ref(ref: str) -> str:
    """Reduz a ref ao que distingue PROPÓSITO: remove datas, competências,
    parcelas, números de NF e códigos longos. 'Torre 01' permanece."""
    ref = RE_NF.sub(" ", ref)
    ref = RE_PARCELA.sub(" ", ref)
    ref = RE_DATA.sub(" ", ref)
    ref = RE_COMPETENCIA.sub(" ", ref)
    ref = RE_CODIGO.sub(" ", ref)
    return _limpar(ref).lower()


def _info_temporal(descs: list) -> dict:
    comps, parcelas, nfs, extras = set(), [], set(), 0
    for d in descs:
        achou = False
        for m in RE_COMPETENCIA.finditer(d):
            comps.add((int(m.group(2)), int(m.group(1)))); achou = True
        for m in RE_COMPETENCIA_COLADA.finditer(RE_CODIGO.sub(" ", d)):
            comps.add((int(m.group(2)), int(m.group(1)))); achou = True
        for m in RE_PARCELA.finditer(d):
            x = m.group(1) or m.group(3); y = m.group(2) or m.group(4)
            if x and y and int(y) > 1:
                parcelas.append((int(x), int(y))); achou = True
        for m in RE_NF.finditer(d):
            nfs.add(m.group(1)); achou = True
        if not achou:
            extras += 1
    return {"competencias": comps, "parcelas": parcelas, "nfs": nfs, "extras": extras}


def _sufixo(info: dict, n: int = 0) -> str:
    """Parêntese do rótulo derivado dos dados reais — nunca inventado."""
    if len(info["competencias"]) >= 2:
        suf = f"{len(info['competencias'])} competências"
        if info["extras"]:
            suf += " + ajustes"
        return f" ({suf})"
    if info["parcelas"] and (n == 0 or len(info["parcelas"]) == n):
        ys = {y for _, y in info["parcelas"]}
        xs = sorted(x for x, _ in info["parcelas"])
        if len(ys) == 1:
            y = ys.pop()
            if len(xs) >= 2 and xs == list(range(xs[0], xs[0] + len(xs))):
                return f" (parcelas {xs[0]} a {xs[-1]} de {y})"
            if len(xs) == 1:
                return f" (parcela {xs[0]} de {y})"
            return f" ({len(xs)} parcelas de {y})"
        return f" ({len(xs)} parcelas)"
    if len(info["nfs"]) >= 2:
        return f" ({len(info['nfs'])} NFs)"
    return ""


def _chave_especial(categoria: str, desc: str):
    d = desc.lower()
    if categoria == "Retenções":
        if d.startswith("darf"):
            return ("DARF",)
        if d.startswith("iss"):
            if RE_COMPETENCIA.search(re.sub(r"\bNFs?\.?\s*\d+", " ", desc)):
                return ("ISS_COMP",)
            return ("ISS_NF", _limpar(desc.split("-")[-1]))
    if categoria == "Financeiras":
        if re.search(r"reembolso|devolu", d) and "reserva" in d:
            return ("RESERVAS",)
    return None


def _rotulo(chave, base: str, refs: list, info: dict, n: int) -> str:
    if chave == ("DARF",):
        return f"DARF PIS/COFINS/CSLL{_sufixo(info, 0)}"
    if chave == ("ISS_COMP",):
        return "ISS (competências)" if n > 1 else "ISS"
    if chave and chave[0] == "ISS_NF":
        suf = f" ({len(info['nfs'])} NFs)" if len(info["nfs"]) >= 2 else ""
        return f"ISS - {chave[1]}{suf}"
    if chave == ("RESERVAS",):
        return "Devoluções e Reembolsos de Reservas"
    rotulo = base
    ess = {essencia_ref(r) for r in refs if r}
    ess.discard("")
    todos_com_ref = sum(1 for r in refs if r) == n
    if len(ess) == 1 and todos_com_ref:
        return rotulo + f" ({ess.pop()})"
    return rotulo + _sufixo(info, n)


def agrupar(lancamentos, total: float, categoria: str, max_linhas: int = 0,
            rotulo_demais: str = "") -> list:
    """Retorna Linhas agregadas, maior→menor. max_linhas=0 significa sem
    teto (fidelidade total); valor positivo ativa a cauda residual (uso
    exclusivo da lista de receitas)."""
    fusao_radical = len(lancamentos) > MAX_LINHAS_DESPESA

    grupos = {}
    ordem = []
    for l in lancamentos:
        base, ref = desmontar(l.descricao)
        chave = _chave_especial(categoria, l.descricao)
        if chave is None:
            chave = ("_", base.lower()) if fusao_radical \
                else ("_", base.lower(), essencia_ref(ref))
        if chave not in grupos:
            grupos[chave] = {"chave": chave, "base": base, "refs": [],
                             "descs": [], "valor": 0.0}
            ordem.append(chave)
        g = grupos[chave]
        g["valor"] += l.valor
        g["refs"].append(ref)
        g["descs"].append(l.descricao)

    # Fusão por prefixo (só modo radical): "Material de Pintura - Tintas"
    # funde com "Material de Pintura"; o separador " - " é obrigatório, então
    # "Serviço de Reparo de Elevador" NÃO funde com "Serviço de Reparo".
    if fusao_radical:
        bases = {c[1]: c for c in ordem if c[0] == "_"}
        for chave in list(ordem):
            if chave[0] != "_":
                continue
            b = chave[1]
            while " - " in b:
                b = b.rsplit(" - ", 1)[0].strip()
                alvo = bases.get(b)
                if alvo and alvo != chave and alvo in grupos:
                    g_de, g_para = grupos[chave], grupos[alvo]
                    g_para["valor"] += g_de["valor"]
                    g_para["refs"].extend(g_de["refs"])
                    g_para["descs"].extend(g_de["descs"])
                    del grupos[chave]
                    ordem.remove(chave)
                    break

    linhas = []
    for chave in ordem:
        g = grupos[chave]
        especial = chave[0] != "_"
        info = _info_temporal(g["descs"])
        rotulo = _rotulo(chave if especial else None, g["base"], g["refs"],
                         info, len(g["descs"]))
        linhas.append(Linha(rotulo, round(g["valor"], 2), g["descs"]))

    linhas.sort(key=lambda x: -x.valor)

    # Cauda "Demais" SO para receitas (max_linhas informado): a lista de
    # Origem da Receita mantem a cauda curta do molde da skill. Despesas
    # passam sem teto (fidelidade total; o template pagina o que nao couber).
    if max_linhas and len(linhas) > max_linhas:
        nomeadas = linhas[:max_linhas - 1]
        ids = {id(l) for l in nomeadas}
        soma_nomeadas = round(sum(l.valor for l in nomeadas), 2)
        residuo = round(total - soma_nomeadas, 2)
        membros = [d for l in linhas if id(l) not in ids for d in l.membros]
        linhas = nomeadas + [Linha(rotulo_demais, residuo, membros, residuo=True)]

    # residuo sempre por ultimo, nomeadas maior->menor
    linhas = sorted([l for l in linhas if not l.residuo], key=lambda x: -x.valor) \
        + [l for l in linhas if l.residuo]

    soma = round(sum(l.valor for l in linhas), 2)
    assert abs(soma - total) < 0.011, \
        f"{categoria}: linhas somam {soma:.2f}, total e {total:.2f}"
    return linhas
