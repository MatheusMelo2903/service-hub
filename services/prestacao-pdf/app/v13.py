# -*- coding: utf-8 -*-
"""Motor v13 da prestacao de contas: o MESMO codigo da skill powerpoint-prestacao-contas.

A skill fica copiada em vendor/skill_v13 (sincronizar com
scripts/sincronizar-skill-prestacao.sh). Este modulo so chama os scripts dela:
  extrair.py  -> dados.json + rascunho.json (cruza os relatorios, para se nao fechar)
  montar.py   -> PPTX, auditoria visual e PDF

Assim o Hub gera exatamente o que a skill gera no Claude. Mudou a skill,
sincroniza a pasta e o Hub muda junto.

A composicao de cada rubrica (texto embaixo da rubrica) vem de fora (curadoria
pelo Claude feita no server.js) ou, sem ela, e montada aqui por regras
(composicao_automatica), sem nenhum custo de IA.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent / "vendor" / "skill_v13"
SCRIPTS = SKILL / "scripts"
RE_MES = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


class ErroPrestacao(Exception):
    """Erro com mensagem pronta pra mostrar ao usuario (sem traceback)."""


def _rodar(args: list[str], cwd: str, timeout: int) -> subprocess.CompletedProcess:
    # HOME gravavel: o soffice (chamado pelo montar.py) falha sem perfil de usuario.
    # PYTHONUSERBASE preserva bibliotecas instaladas com --user mesmo trocando o HOME.
    import site
    env = dict(os.environ, HOME=cwd, PYTHONDONTWRITEBYTECODE="1",
               PYTHONUSERBASE=os.environ.get("PYTHONUSERBASE") or site.getuserbase())
    try:
        return subprocess.run([sys.executable, *args], cwd=cwd, capture_output=True,
                              text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise ErroPrestacao("A geração demorou mais que o limite. Tente de novo; se repetir, avise o suporte.")


def _mensagem_erro(proc: subprocess.CompletedProcess) -> str:
    """Ultima linha util do stderr: e a mensagem do sys.exit dos scripts da skill.
    Excecao inesperada (traceback) nao vai para a tela: caminho interno e dado cru
    ficam so no log do servico."""
    stderr = proc.stderr or ""
    if "Traceback (most recent call last)" in stderr and "AssertionError" not in stderr:
        print(stderr[-3000:], file=sys.stderr)
        return "Erro interno ao processar os relatórios. Avise o suporte."
    linhas = [l.strip() for l in stderr.splitlines() if l.strip()]
    if not linhas:
        linhas = [l.strip() for l in (proc.stdout or "").splitlines() if l.strip()]
    msg = linhas[-1] if linhas else "falha sem mensagem"
    if msg.startswith("AssertionError"):
        msg = "Os números do relatório não fecharam: " + msg.split(":", 1)[-1].strip()
    return msg[:600]


def extrair(pdfs: list[str], inicio: str, fim: str, pasta: str) -> dict:
    if not RE_MES.match(inicio or "") or not RE_MES.match(fim or ""):
        raise ErroPrestacao("Informe o mês inicial e o mês final do período (AAAA-MM).")
    if inicio > fim:
        raise ErroPrestacao("O mês inicial é depois do mês final.")
    dados_p = os.path.join(pasta, "dados.json")
    rasc_p = os.path.join(pasta, "rascunho.json")
    proc = _rodar([str(SCRIPTS / "extrair.py"), "--inicio", inicio, "--fim", fim,
                   "--saida", dados_p, "--rascunho", rasc_p, *pdfs], pasta, 180)
    if proc.returncode != 0 or not os.path.exists(dados_p):
        raise ErroPrestacao(_mensagem_erro(proc))
    with open(dados_p, encoding="utf-8") as f:
        dados = json.load(f)
    with open(rasc_p, encoding="utf-8") as f:
        rascunho = json.load(f)
    if _desambiguar(dados):
        rascunho = _rascunho_da_skill(dados)
    return {"dados": dados, "rascunho": limpar_rascunho(rascunho), "log": (proc.stdout or "")[-2000:]}


def limpar_rascunho(rascunho: dict) -> dict:
    """Rótulos do rascunho sem 'Ref.', sem nome de funcionário (férias, salário) e sem
    hífen, antes de ir para a curadoria e para a composição automática. Os valores ficam
    iguais, então o 'fecha' (soma dos itens = total da rubrica) continua valendo."""
    from . import justificativas as J
    if not isinstance(rascunho, dict):
        return rascunho
    out = {}
    for nome, v in rascunho.items():
        if isinstance(v, dict) and isinstance(v.get("texto"), str) and v["texto"].strip():
            v = dict(v, texto=J.limpa_composicao(v["texto"], nome))
        out[nome] = v
    return out


def _rotulo_vazio(nome: str) -> bool:
    return not re.search(r"[A-Za-zÀ-ÿ0-9]", nome or "")


def _desambiguar(dados: dict) -> bool:
    """A composicao e indexada pelo nome da rubrica. Quando o Superlogica tem o
    mesmo nome em categorias diferentes (caso real: rubrica '-' em Aquisicao de
    Materiais e em Investimento), uma sobrescreve a outra. Aqui cada repetida
    ganha chave unica '<nome> [<categoria>]' e guarda o nome de exibicao em
    'nome_exibicao' (rubrica sem nome vira 'Outros lançamentos')."""
    contagem: dict = {}
    for c in dados.get("categorias", []):
        for r in c.get("rubricas", []):
            contagem[r["nome"]] = contagem.get(r["nome"], 0) + 1
    mudou = False
    for c in dados.get("categorias", []):
        for r in c.get("rubricas", []):
            original = r["nome"]
            if contagem[original] > 1 or _rotulo_vazio(original):
                r["nome_exibicao"] = "Outros lançamentos" if _rotulo_vazio(original) else original
                if contagem[original] > 1:
                    r["nome"] = f"{original} [{c['nome']}]"
                mudou = True
    return mudou


def _rascunho_da_skill(dados: dict) -> dict:
    """Refaz o rascunho com a propria funcao da skill, ja com as chaves unicas."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("extrair_skill", SCRIPTS / "extrair.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return json.loads(json.dumps(mod.rascunho(dados), ensure_ascii=False))


_PREFIXOS = {
    "CONDOMINIO": "Condomínio", "ASSOCIACAO": "Associação", "RESIDENCIAL": "Residencial",
    "EDIFICIO": "Edifício", "CONJUNTO": "Conjunto",
}
_MINUSCULAS = {"de", "da", "do", "das", "dos", "e", "d"}


def _sem_acento(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def _titulo(s: str) -> str:
    out = []
    for i, p in enumerate(s.split()):
        low = p.lower()
        out.append(low if (i and low in _MINUSCULAS) else low.capitalize())
    return " ".join(out)


def cliente_de(nome_relatorio: str, nome_hub: str | None = None) -> dict:
    """Capa e rodape: 'Condomínio' + 'Buritis'. Usa o nome do Hub quando houver."""
    base = (nome_hub or nome_relatorio or "").strip()
    palavras = base.split()
    linha1 = "Condomínio"
    if palavras and _sem_acento(palavras[0]).upper() in _PREFIXOS:
        linha1 = _PREFIXOS[_sem_acento(palavras[0]).upper()]
        palavras = palavras[1:]
    resto = " ".join(palavras) or base
    linha2 = resto if (nome_hub and not resto.isupper()) else _titulo(resto)
    return {"linha1": linha1, "linha2": linha2, "rodape": f"{linha1} {linha2}".upper()}


_LIMITE_TEXTO = 260   # acima disso a rubrica passa de 4 linhas no slide
_LIMITE_ITENS = 6
_PREFIXO_ITEM = re.compile(r"^(ref\.?\s*(a|ao|à|as|aos)?\s+|referente\s+(a|ao|à)\s+|compra\s+de\s+|pagamento\s+(de|da|do)\s+)+", re.I)


def _brl(v: float) -> str:
    return "R$ " + f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _limpa_rotulo(rot: str, rubrica: str = "") -> str:
    from . import justificativas as J
    s = _PREFIXO_ITEM.sub("", J.limpa_rotulo(rot, rubrica)).strip(" .,;:")
    return s[:1].lower() + s[1:] if s else ""


def _resumo_itens(itens: list, rubrica: str = "") -> str:
    """'N lançamentos no período. Maiores: A R$ x · B R$ y. Também: c, d, e'.
    Curto o bastante pra caber em 4 linhas; sem prometer a soma (fecha=False)."""
    n = sum(int(i.get("qtd") or 1) for i in itens)
    maiores = [i for i in itens if i.get("rotulo")][:2]
    partes = [f"{n} lançamentos no período"]
    if maiores:
        partes.append("maiores: " + " · ".join(f"{_limpa_rotulo(i['rotulo'], rubrica)} {_brl(i['valor'])}" for i in maiores))
    vistos, outros = {(_limpa_rotulo(i["rotulo"], rubrica)) for i in maiores}, []
    for i in itens[2:]:
        lab = _limpa_rotulo(i.get("rotulo") or "", rubrica)
        if lab and lab not in vistos and len(", ".join(outros + [lab])) < 110:
            vistos.add(lab)
            outros.append(lab)
    texto = ". ".join(partes)
    if outros:
        texto += ". Também: " + ", ".join(outros)
    if len(texto) > _LIMITE_TEXTO:
        corte = max(texto.rfind(", ", 0, _LIMITE_TEXTO), texto.rfind(" · ", 0, _LIMITE_TEXTO))
        texto = texto[:corte] if corte > 40 else texto[:_LIMITE_TEXTO].rsplit(" ", 1)[0]
    return texto


def composicao_automatica(dados: dict, rascunho: dict, nome_hub: str | None = None) -> dict:
    """Composicao por regras, sem IA. Usa o texto do rascunho da skill (itens com
    valor, do maior pro menor, fechando com o total) e, nas rubricas recorrentes
    sem descricao, escreve 'Lançamentos do período ({n} meses)'."""
    comp = {"cliente": cliente_de(dados.get("condominio", ""), nome_hub), "rubricas": {}}
    if dados.get("modo") != "detalhado":
        return comp
    rascunho = limpar_rascunho(rascunho or {})
    for cat in dados.get("categorias", []):
        for r in cat.get("rubricas", []):
            rasc = rascunho.get(r["nome"], {}) or {}
            texto = (rasc.get("texto") or "").strip()
            # So afirma que a soma fecha quando os itens conciliaram com o total da
            # rubrica; com divergencia, lista os itens sem prometer a soma.
            conciliada = r.get("status") in ("exato", "resolvido")
            if texto and (len(texto) > _LIMITE_TEXTO or len(r.get("itens") or []) > _LIMITE_ITENS):
                # Muitos itens: resume como a skill faz no tipo 3 (compras repetidas).
                comp["rubricas"][r["nome"]] = {"texto": _resumo_itens(r.get("itens") or [], r["nome"]), "fecha": False}
            elif texto:
                comp["rubricas"][r["nome"]] = {"texto": texto, "fecha": bool(rasc.get("fecha")) and conciliada}
            else:
                comp["rubricas"][r["nome"]] = {"texto": "Lançamentos do período ({n} meses)", "fecha": False}
            if r.get("nome_exibicao"):
                comp["rubricas"][r["nome"]]["nome"] = r["nome_exibicao"]
    return comp


def completar_composicao(comp_ia: dict, dados: dict, rascunho: dict, nome_hub: str | None = None) -> dict:
    """Junta a curadoria da IA com a automatica: cliente sempre pelas regras e
    qualquer rubrica que a IA nao escreveu cai no texto automatico."""
    from . import justificativas as J
    auto = composicao_automatica(dados, rascunho, nome_hub)
    comp = {"cliente": auto["cliente"], "rubricas": dict(auto["rubricas"])}
    if not isinstance(comp_ia, dict):
        return comp
    status = {r["nome"]: r.get("status") for c in dados.get("categorias", []) for r in c.get("rubricas", [])}
    for nome, v in (comp_ia.get("rubricas") or {}).items():
        if nome in comp["rubricas"] and isinstance(v, dict) and str(v.get("texto", "")).strip():
            conciliada = status.get(nome) in ("exato", "resolvido")
            # Mesma limpeza de rótulos no texto da IA (nome de funcionário nunca vai ao slide).
            item = {"texto": J.limpa_composicao(str(v["texto"]).strip(), nome), "fecha": bool(v.get("fecha")) and conciliada}
            if isinstance(v.get("nome"), str) and v["nome"].strip():
                item["nome"] = v["nome"].strip()
            elif comp["rubricas"][nome].get("nome"):
                # Sem nome da IA, mantem o de exibicao (rubrica repetida ou sem nome
                # no Superlogica nao pode aparecer como "X [Categoria]" ou "-").
                item["nome"] = comp["rubricas"][nome]["nome"]
            comp["rubricas"][nome] = item
    nomes_cat = {c["nome"] for c in dados.get("categorias", [])}
    cats = {k: {kk: vv for kk, vv in v.items() if kk in ("nota", "desc") and isinstance(vv, str)}
            for k, v in (comp_ia.get("categorias") or {}).items() if k in nomes_cat and isinstance(v, dict)}
    if cats:
        comp["categorias"] = {k: v for k, v in cats.items() if v}
    nomes_rec = {r["nome"] for r in dados.get("receitas", [])}
    rn = {k: v for k, v in (comp_ia.get("receitas_nomes") or {}).items() if k in nomes_rec and isinstance(v, str) and v.strip()}
    if rn:
        comp["receitas_nomes"] = rn
    if isinstance(comp_ia.get("receita_insight"), str) and comp_ia["receita_insight"].strip():
        comp["receita_insight"] = comp_ia["receita_insight"].strip()
    exp = sanear_explicacoes(comp_ia.get("explicacoes"), dados)
    if exp:
        comp["explicacoes"] = exp
        # Se a composicao da IA reprovar na conferencia, o main.py refaz com a automatica
        # usando o MESMO dict de dados: guardada aqui, a explicacao da curadoria continua
        # valendo nesse caminho (o montar le daqui quando a composicao nao trouxer).
        dados[_EXP_GUARDADA] = exp
    return comp


_EXP_GUARDADA = "_explicacoes_curadoria"


def _meses_dos_dados(dados: dict) -> set:
    from . import justificativas
    per = list(dados.get("periodo") or [])
    lab = list(dados.get("meses_label") or [])
    return {justificativas._rot_mes(per[i] if i < len(per) else "", lab[i] if i < len(lab) else None)
            for i in range(max(len(per), len(lab)))}


def sanear_explicacoes(exp, dados: dict) -> dict:
    """Explicacoes dos numeros que assustam (formato de justificativas.textos_padrao):
    so chaves conhecidas, meses do periodo, rubricas 'CATEGORIA|RUBRICA' que existem,
    sem hifen de pontuacao e cortadas no limite de cada campo do slide."""
    from . import justificativas as J
    if not isinstance(exp, dict):
        return {}
    limpa = lambda v, k: J.cortar(J.sem_hifen(v), J.LIMITES[k]) if isinstance(v, str) and v.strip() else ""
    out = {}
    for k in ("resumo", "caixa", "contas"):
        t = limpa(exp.get(k), k)
        if t:
            out[k] = t
    validos = {
        "meses": _meses_dos_dados(dados),
        "rubricas": {c["nome"] + "|" + r["nome"] for c in dados.get("categorias", []) for r in c.get("rubricas", [])},
    }
    for k, ok in validos.items():
        v = exp.get(k)
        if not isinstance(v, dict):
            continue
        o = {}
        for chave, texto in list(v.items())[:60]:
            t = limpa(texto, k)
            if isinstance(chave, str) and chave in ok and t:
                o[chave] = t
        if o:
            out[k] = o
    return out


def juntar_explicacoes(dados: dict, comp: dict) -> dict:
    """O que a curadoria escreveu vale; o que faltar cai no texto padrao das
    justificativas. Sem numero que assuste (sem alerta), nada: a apresentacao fica
    identica a de sempre. Os sinais sao recalculados aqui para o texto padrao sair
    sempre com a limpeza de rotulos atual (o caminho por PDF nem traz sinais)."""
    from . import justificativas as J
    try:
        sinais = J.analisar(dados)
    except Exception:  # explicacao nunca derruba a prestacao
        sinais = dados.get("sinais") if isinstance(dados.get("sinais"), dict) else {}
    if not sinais.get("ha_alerta"):
        return {}
    pad = sanear_explicacoes(sinais.get("textos") or {}, dados)
    cur = comp.get("explicacoes") if isinstance(comp.get("explicacoes"), dict) else dados.get(_EXP_GUARDADA)
    cur = sanear_explicacoes(cur, dados)
    out = {}
    for k in ("resumo", "caixa", "contas"):
        if cur.get(k) or pad.get(k):
            out[k] = cur.get(k) or pad.get(k)
    for k in ("meses", "rubricas"):
        m = dict(pad.get(k) or {})
        m.update(cur.get(k) or {})
        if m:
            out[k] = m
    return out


def _nome_limpo(v, limite: int = 80) -> str:
    # Sem hifen nem travessao nos textos do deck: " - " vira virgula, o resto vira espaco.
    s = re.sub(r"\s+[-\u2010-\u2015\u2212]\s+", ", ", str(v or ""))
    s = re.sub(r"[-\u2010-\u2015\u2212]", " ", s)
    return re.sub(r"\s+", " ", s).strip(" ,")[:limite]


def sanear_estrutura(est, dados: dict) -> dict | None:
    """Valida o "Ajustar estrutura" vindo do Hub contra os dados da extracao: so
    categorias e rubricas que existem, juntar so dentro da mesma categoria. Nada
    aqui muda numero; o montar.py confere que o total de cada categoria fica igual."""
    if not isinstance(est, dict):
        return None
    cat_de = {r["nome"]: c["nome"] for c in dados.get("categorias", []) for r in c.get("rubricas", [])}
    cats = {c["nome"] for c in dados.get("categorias", [])}
    lista = lambda v: [x for x in v if isinstance(x, str)][:500] if isinstance(v, list) else []
    out = {
        "ocultar_categorias": sorted({c for c in lista(est.get("ocultar_categorias")) if c in cats}),
        "ocultar_rubricas": sorted({r for r in lista(est.get("ocultar_rubricas")) if r in cat_de}),
        "renomear": {}, "renomear_categorias": {}, "juntar": [],
    }
    for k, v in (est.get("renomear") or {}).items() if isinstance(est.get("renomear"), dict) else []:
        if k in cat_de and _nome_limpo(v):
            out["renomear"][k] = _nome_limpo(v)
    for k, v in (est.get("renomear_categorias") or {}).items() if isinstance(est.get("renomear_categorias"), dict) else []:
        if k in cats and _nome_limpo(v, 40):
            out["renomear_categorias"][k] = _nome_limpo(v, 40)
    usadas = set()
    for g in (est.get("juntar") or [])[:100] if isinstance(est.get("juntar"), list) else []:
        if not isinstance(g, dict):
            continue
        rubs = [r for r in dict.fromkeys(lista(g.get("rubricas"))) if r in cat_de and r not in usadas]
        if len(rubs) < 2:
            continue
        if len({cat_de[r] for r in rubs}) != 1:
            raise ErroPrestacao("Só dá para juntar rubricas da mesma categoria.")
        usadas.update(rubs)
        out["juntar"].append({"rubricas": rubs, "nome": _nome_limpo(g.get("nome"))})
    if not any(out.values()):
        return None
    return out


def nome_arquivo(dados: dict, comp: dict) -> str:
    def mmaa(k):
        y, m = k.split("-")
        return ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"][int(m) - 1] + y[2:]
    per = dados.get("periodo") or []
    nome = comp["cliente"]["linha2"]
    base = f"{nome} - Prestação de Contas {mmaa(per[0])} a {mmaa(per[-1])}" if per else f"{nome} - Prestação de Contas"
    return re.sub(r'[\\/:*?"<>|]', "", base)


def montar(dados: dict, comp: dict, pasta: str) -> dict:
    comp = dict(comp)
    exp = juntar_explicacoes(dados, comp)
    if exp:
        comp["explicacoes"] = exp
    else:
        comp.pop("explicacoes", None)
    try:
        return _montar(dados, comp, pasta)
    except ErroPrestacao:
        if not exp:
            raise
        # A explicacao e um complemento: se for ela que nao coube, a prestacao sai sem ela.
        comp.pop("explicacoes", None)
        res = _montar(dados, comp, pasta)
        print("v13: prestacao gerada sem as explicacoes (nao passaram na montagem)", file=sys.stderr)
        return res


def _montar(dados: dict, comp: dict, pasta: str) -> dict:
    dados_p = os.path.join(pasta, "dados.json")
    comp_p = os.path.join(pasta, "composicao.json")
    with open(dados_p, "w", encoding="utf-8") as f:
        json.dump({k: v for k, v in dados.items() if k != _EXP_GUARDADA}, f, ensure_ascii=False)
    with open(comp_p, "w", encoding="utf-8") as f:
        json.dump(comp, f, ensure_ascii=False)
    base = nome_arquivo(dados, comp)
    pptx_p = os.path.join(pasta, "saida.pptx")
    for p in (pptx_p, os.path.join(pasta, "saida.pdf")):
        if os.path.exists(p):
            os.remove(p)
    proc = _rodar([str(SCRIPTS / "montar.py"), dados_p, comp_p, "--saida", pptx_p, "--pdf"], pasta, 420)
    pdf_p = os.path.join(pasta, "saida.pdf")
    if proc.returncode != 0 or not os.path.exists(pdf_p):
        raise ErroPrestacao(_mensagem_erro(proc))
    with open(pptx_p, "rb") as f:
        pptx = f.read()
    with open(pdf_p, "rb") as f:
        pdf = f.read()
    return {"pptx": pptx, "pdf": pdf, "nome": base}
