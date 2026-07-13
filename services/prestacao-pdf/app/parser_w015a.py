# -*- coding: utf-8 -*-
"""Parser determinístico do W015A (Consolidado com Comparativo) do Superlógica.

Estrutura do W015A:
- Retrato (595x842), 3 páginas.
- Cabeçalho: "W015A <CONDOMINIO> (<id>)" + "Comparativo de <ini> até <fim> e <mes_comp>".
- Cada linha de dados tem: label + 4 valores [total_período, mes_comp, variação, variação%].
- O parser extrai col0 (total do período) e col1 (mês comparativo) por linha.
- Coluna da direita (x > 78% da largura) com formato monetário = valor da linha.
  Mas aqui há 4 colunas: usamos posição x para identificar cada uma.
- Seções: "Saldo anterior", "Receitas", "Total de Receitas", "Despesas",
  cabeçalhos de grupo CAIXA ALTA, "Total de <CAT>", "Total de Despesas",
  "Mov. Líquido", "Saldo Final".

Reutiliza RE_DINHEIRO e _para_float do parser_w016a para manter consistência.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import pdfplumber

from . import mensagens as M

# Mesmo regex monetário do w016a para consistência
RE_DINHEIRO = re.compile(r"^-?\(?\d{1,3}(?:\.\d{3})*,\d{2}\)?$")
RE_PERIODO = re.compile(
    r"Comparativo de (\w+)/(\d{4}) até (\w+)/(\d{4}) e (\w+)/(\d{4})"
)
RE_CABECALHO_PAG = re.compile(r"^W015A |^Demonstrativo de|^Comparativo de")
# Rodapé detectado por conteúdo posicional (endereço, CEP, paginação).
# NÃO incluir texto de nome de condomínio (ex: "^PRAIA") — descartaria
# linhas legítimas em condomínios cujo nome começa com essa palavra.
# Rodapés por coordenada top já são filtrados pelo limite_rodape em _linhas_da_pagina_w015a.
RE_RODAPE = re.compile(r"Rua |Avenida |CEP\.|^\d+ de \d+$")
RE_TOTAL_GRUPO = re.compile(r"^Total de (.+)$")
RE_PCT = re.compile(r"^-?\d+,\d+%$")

MESES_ABREV_PT = {
    "Jan": ("01", "Janeiro"), "Fev": ("02", "Fevereiro"),
    "Mar": ("03", "Março"),   "Abr": ("04", "Abril"),
    "Mai": ("05", "Maio"),    "Jun": ("06", "Junho"),
    "Jul": ("07", "Julho"),   "Ago": ("08", "Agosto"),
    "Set": ("09", "Setembro"),"Out": ("10", "Outubro"),
    "Nov": ("11", "Novembro"),"Dez": ("12", "Dezembro"),
}

# Mapa idêntico ao parser_w011a para garantir mesmos rótulos canônicos
MAPA_CATEGORIA = {
    "DESPESAS FINANCEIRAS": "Financeiras",
    "DESPESA COM PESSOAL": "Pessoal",
    "RETENÇÕES -NOTAS FISCAIS": "Retenções",
    "RETENÇÕES - NOTAS FISCAIS": "Retenções",
    "DESPESA COM ADMINISTRATIVO": "Administrativo",
    "DESPESAS COM CONSUMO": "Consumo",
    "MANUTENÇÃO": "Manutenção",
    "AQUISIÇÃO DE MATERIAIS": "Materiais",
    "SERVIÇOS": "Serviços",
    "INVESTIMENTO-IMOBILIZADO": "Investimento",
    "TAXAS E RECOLHIMENTOS": "Taxas",
}


def _para_float(token: str) -> float:
    """Converte string monetária BR para float. Suporta (val) como negativo."""
    neg = token.startswith("(") or token.startswith("-")
    limpo = token.strip("()").lstrip("-").replace(".", "").replace(",", ".")
    return -float(limpo) if neg else float(limpo)


def _e_caixa_alta(texto: str) -> bool:
    letras = [c for c in texto if c.isalpha()]
    return bool(letras) and all(not c.islower() for c in letras)


@dataclass
class LancamentoW015A:
    descricao: str
    total: float       # col0: total do período
    comparativo: float  # col1: mês comparativo


@dataclass
class GrupoW015A:
    nome_relatorio: str
    categoria: str
    total: float = 0.0
    total_comp: float = 0.0
    lancamentos: list = field(default_factory=list)  # [LancamentoW015A]


@dataclass
class EstruturaW015A:
    condominio: str = ""
    condominio_id: str = ""
    data_inicial: str = ""
    data_final: str = ""
    mes_comparativo_label: str = ""   # ex: "Mai/2026"
    # Receitas
    receitas: list = field(default_factory=list)     # [LancamentoW015A]
    receita_total: float = 0.0
    receita_total_comp: float = 0.0
    # Despesas
    grupos: list = field(default_factory=list)        # [GrupoW015A]
    despesa_total: float = 0.0
    despesa_total_comp: float = 0.0
    # Saldos
    saldo_anterior: float = 0.0
    saldo_anterior_comp: float = 0.0
    saldo_final: float = 0.0
    saldo_final_comp: float = 0.0
    mov_liquido: float = 0.0


def _linhas_da_pagina_w015a(page) -> list[tuple[str, float | None, float | None]]:
    """Extrai (label, col0, col1) de cada linha da página.

    O W015A tem 4 colunas numéricas. Usa coordenada x para distinguir:
    - col0 (total período): x0 entre 38% e 60% da largura
    - col1 (mês comp): x0 entre 60% e 80% da largura
    - col2 (variação): x0 > 75% (pode ser negativo longo, às vezes flui)
    - col3 (variação%): formato com % no final

    Estratégia mais robusta: agrupa todos os tokens monetários por linha
    e os ordena por x para atribuir posição 0,1,2,3.
    """
    palavras = page.extract_words()
    # Margem de rodapé aumentada para 65px (era 50px) para excluir o nome do
    # condomínio que o Superlógica imprime como rodapé de página em top~777
    # (height=841 → limite=776), ficando abaixo do último dado útil (~740).
    # O RE_RODAPE não pode incluir o nome específico do condomínio (seria
    # hardcode de cliente); a detecção posicional é a abordagem genérica correta.
    limite_rodape = page.height - 65
    buckets: dict[int, list] = {}
    for w in palavras:
        if w["top"] > limite_rodape:
            continue
        chave = round(w["top"] / 3.0)
        buckets.setdefault(chave, []).append(w)

    linhas = []
    for chave in sorted(buckets):
        ws = sorted(buckets[chave], key=lambda w: w["x0"])
        # Separa tokens monetários e percentuais dos de texto
        label_parts = []
        valores = []  # (x0, valor_float)
        for w in ws:
            t = w["text"]
            if RE_PCT.match(t):
                # Percentual (col3): ignorar para o parser
                continue
            if RE_DINHEIRO.match(t):
                valores.append((w["x0"], _para_float(t)))
            else:
                label_parts.append(t)
        label = " ".join(label_parts).strip()
        # Ordena por x0 para garantir col0 < col1
        valores.sort(key=lambda x: x[0])
        col0 = valores[0][1] if len(valores) > 0 else None
        col1 = valores[1][1] if len(valores) > 1 else None
        linhas.append((label, col0, col1))
    return linhas


def _extrair_cabecalho(texto_pag1: str) -> tuple:
    """Extrai condomínio, data_inicial, data_final, mes_comp do cabeçalho."""
    condominio = ""
    condominio_id = ""
    data_inicial = ""
    data_final = ""
    mes_comp_label = ""

    for linha in texto_pag1.split("\n"):
        if linha.startswith("W015A"):
            id_match = re.search(r"\((\d+)\)", linha)
            condominio_id = id_match.group(1) if id_match else ""
            nome_raw = re.sub(r"^W015A\s+", "", linha)
            condominio = re.sub(r"\s*\(\d+\)\s*$", "", nome_raw).strip()
        elif linha.startswith("Comparativo"):
            m = RE_PERIODO.search(linha)
            if m:
                mes_ini, ano_ini = m.group(1), m.group(2)
                mes_fim, ano_fim = m.group(3), m.group(4)
                mes_comp_abrev, ano_comp = m.group(5), m.group(6)
                num_ini = MESES_ABREV_PT.get(mes_ini, ("01",))[0]
                num_fim = MESES_ABREV_PT.get(mes_fim, ("12",))[0]
                data_inicial = f"01/{num_ini}/{ano_ini}"
                data_final = f"30/{num_fim}/{ano_fim}"
                mes_comp_label = f"{mes_comp_abrev}/{ano_comp}"

    return condominio, condominio_id, data_inicial, data_final, mes_comp_label


def parsear(caminho_pdf: str) -> EstruturaW015A:
    """Parseia um PDF W015A e retorna EstruturaW015A completa e validada."""
    est = EstruturaW015A()
    secao = None        # None | 'receitas' | 'despesas' | 'fim'
    grupo_atual: GrupoW015A | None = None

    with pdfplumber.open(caminho_pdf) as pdf:
        for pi, page in enumerate(pdf.pages):
            if secao == "fim":
                break

            # Cabeçalho: extrai na página 1
            if pi == 0:
                texto_pag1 = page.extract_text() or ""
                (est.condominio, est.condominio_id,
                 est.data_inicial, est.data_final,
                 est.mes_comparativo_label) = _extrair_cabecalho(texto_pag1)

            linhas = _linhas_da_pagina_w015a(page)

            for label, col0, col1 in linhas:
                if not label and col0 is None:
                    continue
                # Filtra cabeçalhos e rodapés
                if RE_CABECALHO_PAG.match(label):
                    continue
                if RE_RODAPE.search(label):
                    continue
                # Linha de cabeçalho de colunas (contém "Variação")
                if "Variação" in label:
                    continue

                # Saldo anterior
                if label.startswith("Saldo anterior"):
                    if col0 is not None:
                        est.saldo_anterior = col0
                    if col1 is not None:
                        est.saldo_anterior_comp = col1
                    continue

                # Transições de seção
                if label == "Receitas" and col0 is None:
                    secao = "receitas"
                    continue
                if label == "Despesas" and col0 is None:
                    secao = "despesas"
                    continue

                # Total de Receitas
                if label.startswith("Total de Receitas"):
                    if col0 is not None:
                        est.receita_total = col0
                    if col1 is not None:
                        est.receita_total_comp = col1
                    continue

                # Total de Despesas
                if label.startswith("Total de Despesas"):
                    if col0 is not None:
                        est.despesa_total = col0
                    if col1 is not None:
                        est.despesa_total_comp = col1
                    continue

                # Mov. Líquido
                if label.startswith("Mov. Líquido"):
                    if col0 is not None:
                        est.mov_liquido = col0
                    continue

                # Saldo Final
                if label.startswith("Saldo Final"):
                    if col0 is not None:
                        est.saldo_final = col0
                    if col1 is not None:
                        est.saldo_final_comp = col1
                    secao = "fim"
                    break

                # Total de categoria
                m_total = RE_TOTAL_GRUPO.match(label)
                if m_total and secao == "despesas":
                    nome_cat = m_total.group(1).strip()
                    # col0 None aqui significa que o PDF não entregou o total do grupo —
                    # deixar passar silenciosamente geraria ValueError vago na validação.
                    # Levanta erro explícito indicando QUAL categoria falhou.
                    if col0 is None and grupo_atual is not None:
                        raise ValueError(
                            f"W015A: total da categoria '{nome_cat}' (grupo "
                            f"'{grupo_atual.nome_relatorio}') nao foi lido do PDF"
                        )
                    if col0 is not None and grupo_atual is not None:
                        if (grupo_atual.nome_relatorio == nome_cat or
                                nome_cat.startswith(grupo_atual.nome_relatorio[:8])):
                            grupo_atual.total = col0
                            grupo_atual.total_comp = col1 or 0.0
                            est.grupos.append(grupo_atual)
                            grupo_atual = None
                    continue

                # Seção de Receitas
                if secao == "receitas" and label:
                    if col0 is not None:
                        est.receitas.append(
                            LancamentoW015A(label, col0, col1 or 0.0)
                        )
                    elif est.receitas:
                        est.receitas[-1].descricao += " " + label
                    continue

                # Seção de Despesas
                if secao == "despesas":
                    if _e_caixa_alta(label) and col0 is None:
                        # Fecha grupo anterior não encerrado
                        if grupo_atual is not None:
                            est.grupos.append(grupo_atual)
                        categoria = MAPA_CATEGORIA.get(label, label.title())
                        grupo_atual = GrupoW015A(
                            nome_relatorio=label,
                            categoria=categoria,
                        )
                        continue
                    if grupo_atual is not None and label:
                        if col0 is not None:
                            grupo_atual.lancamentos.append(
                                LancamentoW015A(label, col0, col1 or 0.0)
                            )
                        elif grupo_atual.lancamentos:
                            grupo_atual.lancamentos[-1].descricao += " " + label
                    continue

    _validar(est)
    return est


def _validar(est: EstruturaW015A):
    """Valida a estrutura do W015A contra os próprios totais do relatório."""
    # Mensagens em português para o operador; a lógica de validação é idêntica.
    problemas = []
    TOL = 0.02

    # Conservação de caixa
    caixa = est.saldo_anterior + est.receita_total - est.despesa_total
    if abs(caixa - est.saldo_final) > TOL:
        problemas.append(M.msg_caixa("W015A", caixa, est.saldo_final))

    # Soma das receitas
    soma_rec = round(sum(l.total for l in est.receitas), 2)
    if abs(soma_rec - est.receita_total) > TOL:
        problemas.append(M.msg_soma("W015A", "as receitas", soma_rec, est.receita_total))

    # Soma dos grupos
    soma_desp = round(sum(g.total for g in est.grupos), 2)
    if abs(soma_desp - est.despesa_total) > TOL:
        problemas.append(
            M.msg_soma("W015A", "as categorias de despesa", soma_desp, est.despesa_total))

    if problemas:
        raise ValueError(M.juntar_problemas(problemas))
