# -*- coding: utf-8 -*-
"""Parser determinístico do W011A (Demonstrativo Mensal) do Superlógica.

Estratégia (baseada no proto validado e calibrada contra o PDF real):
- O W011A é em paisagem (842x595) com 13 colunas numéricas:
    col0  = "Jul/2025–Jun/2026" (total período, coluna ESQUERDA)
    col1..11 = Ago/2025 a Jun/2026 (11 meses explícitos)
    col12 = "Total do período" (coluna DIREITA — autoritativa, use ESTE)
- Coluna Jul/2025 NÃO existe no PDF: é derivada como (col12 - soma(col1..11)).
- Números grandes quebram em dois tokens: "1.293.772," + "27". Reagrupados
  pelo _reagrupar_tokens_quebrados antes da atribuição de coluna.
- "Total de <CATEGORIA>" pode ter o nome da categoria continuando na linha
  SEGUINTE do PDF (ex: "Total de" + linha seguinte "INVESTIMENTO-IMOBILIZADO").
  A lógica de parse mantém uma "fila" de "Total de" pendente sem nome.
- Colunas detectadas por clusterização de x-centers de tokens monetários na
  página 1 (gap > 12 px separa clusters). Validado: 13 clusters.
- Linhas agrupadas por round(top/3.0).
- Rodapé (top > altura - 35) é excluído.

Saída: dataclass EstruturaW011A com campos completos para o pipeline multi-fonte.
"""
from __future__ import annotations

import re
import statistics
import sys
from dataclasses import dataclass, field

import pdfplumber

# Regex monetário completo: "1.293.772,27" ou "-1.842,00" ou "0,00"
RE_MONEY = re.compile(r"^-?\d{1,3}(\.\d{3})*,\d{2}$")
# Token quebrado parte 1: "1.293.772," (vírgula no final, sem centavos)
RE_MONEY_PARCIAL = re.compile(r"^-?\d{1,3}(\.\d{3})*,$")
# Token quebrado parte 2: os dois centavos "27"
RE_CENTAVOS = re.compile(r"^\d{2}$")
# Cabeçalho de página a filtrar
RE_CABECALHO = re.compile(r"^W011A |^Demonstrativo de|^Comparativo de|^Ago/\d{4}")
# Número esperado de colunas na tabela do W011A
N_COLUNAS = 13
# Gap mínimo em pixels para separar clusters de colunas
GAP_COLUNA = 12


def _para_float(s: str) -> float:
    """Converte string monetária BR para float. Suporta negativos com sinal."""
    neg = s.startswith("-")
    limpo = s.lstrip("-").replace(".", "").replace(",", ".")
    return -float(limpo) if neg else float(limpo)


def _e_caixa_alta(texto: str) -> bool:
    """Retorna True se o texto é um cabeçalho de categoria de despesa (CAIXA
    ALTA). Acento em maiúscula conta como maiúscula."""
    letras = [c for c in texto if c.isalpha()]
    return bool(letras) and all(not c.islower() for c in letras)


def _clusterizar_colunas(page) -> list[float]:
    """Detecta os 13 x-centers das colunas a partir dos tokens monetários.

    Usa todos os tokens completos RE_MONEY — quanto mais linhas de dados,
    mais centros disponíveis para mediana robusta.
    """
    words = page.extract_words()
    centers = []
    for w in words:
        if RE_MONEY.match(w["text"]):
            centers.append((w["x0"] + w["x1"]) / 2)
    centers.sort()
    if not centers:
        return []
    cols = []
    cur = [centers[0]]
    for c in centers[1:]:
        if c - cur[-1] > GAP_COLUNA:
            cols.append(statistics.median(cur))
            cur = [c]
        else:
            cur.append(c)
    cols.append(statistics.median(cur))
    return cols


def _agrupar_palavras_por_linha(words: list, limite_rodape: float) -> dict:
    """Agrupa palavras por linha (round(top/3.0)), excluindo rodapé."""
    buckets: dict[int, list] = {}
    for w in words:
        if w["top"] > limite_rodape:
            continue
        chave = round(w["top"] / 3.0)
        buckets.setdefault(chave, []).append(w)
    return buckets


def _reagrupar_tokens_quebrados(linha_words: list) -> list:
    """Funde tokens quebrados de número grande em token único.

    O PDF do W011A quebra "1.293.772,27" em "1.293.772," + "27" (dois tokens
    em linhas top levemente diferentes mas agrupados pela mesma chave de linha).
    Detecta por adjacência: token com vírgula no final seguido de 2 dígitos.
    """
    result = []
    i = 0
    while i < len(linha_words):
        w = linha_words[i]
        if RE_MONEY_PARCIAL.match(w["text"]) and i + 1 < len(linha_words):
            prox = linha_words[i + 1]
            if RE_CENTAVOS.match(prox["text"]):
                fused = dict(w)
                fused["text"] = w["text"] + prox["text"]
                fused["x1"] = prox["x1"]
                result.append(fused)
                i += 2
                continue
        result.append(w)
        i += 1
    return result


def _atribuir_colunas(linha_words: list, cols: list[float]) -> tuple[str, list]:
    """Extrai label e N valores de uma linha, atribuindo cada token à coluna
    mais próxima pelo x-center. Tokens não monetários formam o label.

    Tokens monetários parciais dentro do label (quando o número quebrado se
    mistura com o texto da linha de Total) são filtrados do label.
    """
    linha_words = sorted(linha_words, key=lambda w: w["x0"])
    linha_words = _reagrupar_tokens_quebrados(linha_words)
    label_parts = []
    cells = [None] * len(cols)
    for w in linha_words:
        t = w["text"]
        if RE_MONEY.match(t):
            cx = (w["x0"] + w["x1"]) / 2
            ci = min(range(len(cols)), key=lambda i: abs(cols[i] - cx))
            cells[ci] = _para_float(t)
        elif RE_MONEY_PARCIAL.match(t):
            # Token de número quebrado não reagrupado (sem próximo token):
            # é um token de número que ficou no final da lista sem par.
            # Ignora do label — é ruído que aparece em linhas de total.
            pass
        else:
            label_parts.append(t)
    label = " ".join(label_parts).strip()
    return label, cells


@dataclass
class LancamentoW011A:
    descricao: str
    total: float          # col12 (Total do período)
    serie_mes: list       # [jul, ago, set, out, nov, dez, jan, fev, mar, abr, mai, jun]


@dataclass
class GrupoW011A:
    nome_relatorio: str   # cabeçalho original CAIXA ALTA
    categoria: str        # rótulo canônico do deck (pipeline.TITULOS)
    total: float = 0.0
    total_mes: list = field(default_factory=lambda: [0.0] * 12)
    lancamentos: list = field(default_factory=list)  # [LancamentoW011A]


# Mapa dos cabeçalhos CAIXA ALTA do W011A para rótulos canônicos do deck.
# Deve cobrir todos os cabeçalhos que o Superlógica pode gerar.
# Categoria não mapeada cai em label.title() com aviso (nunca silenciosa).
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


@dataclass
class EstruturaW011A:
    condominio: str = ""
    condominio_id: str = ""
    data_inicial: str = ""
    data_final: str = ""
    meses_labels: list = field(default_factory=list)         # 12 labels
    # Receitas
    receitas: list = field(default_factory=list)              # [LancamentoW011A]
    receita_total: float = 0.0
    receita_total_mes: list = field(default_factory=lambda: [0.0] * 12)
    # Despesas
    grupos: list = field(default_factory=list)                # [GrupoW011A]
    despesa_total: float = 0.0
    despesa_total_mes: list = field(default_factory=lambda: [0.0] * 12)
    # Saldos
    saldo_anterior: float = 0.0
    saldo_anterior_mes: list = field(default_factory=lambda: [0.0] * 12)
    saldo_final: float = 0.0
    mov_liquido: float = 0.0
    # Série mensal derivada (receita - despesa por mês)
    superavit_mes: list = field(default_factory=lambda: [0.0] * 12)


def _derivar_jul(total_periodo: float, serie_11: list) -> float:
    """Jul/2025 não tem coluna própria. Deriva como total - soma(Ago..Jun).

    Tolerância de R$0,02 acumulada é aceitável para arredondamento de float.
    """
    soma_11 = sum(v if v is not None else 0.0 for v in serie_11)
    return round(total_periodo - soma_11, 2)


def _serie_12(col12: float, cols_1_a_11: list) -> list:
    """Monta a série de 12 meses [jul, ago, ..., jun].
    col12 é o total do período (coluna direita). Jul é derivado."""
    serie_11 = [v if v is not None else 0.0 for v in cols_1_a_11]
    jul = _derivar_jul(col12, serie_11)
    return [jul] + serie_11


MESES_ABREV_PT = {
    "Jan": "01", "Fev": "02", "Mar": "03", "Abr": "04",
    "Mai": "05", "Jun": "06", "Jul": "07", "Ago": "08",
    "Set": "09", "Out": "10", "Nov": "11", "Dez": "12",
}


def _extrair_periodo_cabecalho(texto: str):
    """Extrai data_inicial e data_final do cabeçalho "Comparativo de X até Y"."""
    m = re.search(r"Comparativo de (\w+)/(\d{4}) até (\w+)/(\d{4})", texto)
    if not m:
        return None, None
    num_ini = MESES_ABREV_PT.get(m.group(1), "01")
    ano_ini = m.group(2)
    num_fim = MESES_ABREV_PT.get(m.group(3), "12")
    ano_fim = m.group(4)
    data_inicial = f"01/{num_ini}/{ano_ini}"
    data_final = f"30/{num_fim}/{ano_fim}"
    return data_inicial, data_final


def _extrair_labels_meses(texto_pag1: str) -> list:
    """Extrai os 11 meses explícitos das colunas e coloca Jul na frente.

    O cabeçalho do W011A tem uma linha de colunas que começa com o mês-fim
    do período (ex: "Jun/2026") seguido de: Ago Set Out Nov Dez Jan Fev Mar Abr Mai Jun.
    Procura a linha que contém "Ago/" para encontrar a linha de colunas,
    e extrai os 11 meses a partir do "Ago". Ignora "Jul" (não é coluna).
    """
    for linha in texto_pag1.split("\n"):
        if "Ago/" in linha:
            # Esta é a linha de cabeçalho das colunas
            encontrados = re.findall(
                r"((?:Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)/\d{4})",
                linha,
            )
            # Descarta Jul (não é coluna). Remove o PRIMEIRO elemento que é o
            # mês-fim do período repetido no início da linha de colunas.
            sem_jul = [m for m in encontrados if not m.startswith("Jul")]
            # sem_jul[0] = mês-fim do período (ex: "Jun/2026") — descartar
            meses_11 = sem_jul[1:] if len(sem_jul) >= 12 else sem_jul
            if len(meses_11) == 11:
                # Jul derivado: usa o ano do primeiro mês explícito (Ago)
                ano_jul = re.search(r"/(\d{4})", meses_11[0])
                jul_label = f"Jul/{ano_jul.group(1)}" if ano_jul else "Jul"
                return [jul_label] + meses_11
    # Fallback se a extração falhar
    return ["Jul"] + [f"Mês{i}" for i in range(1, 12)]


def _reagrupar_linhas_adjacentes(words: list) -> list:
    """Mescla tokens de centavos que estão em top diferente da linha principal.

    O PDF do W011A coloca às vezes os tokens "64" "57" "74" num top levemente
    maior que a linha principal (ex: top=226 vs top=214). São os centavos dos
    números quebrados "1.145.805," / "1.018.900," / "1.079.680,".
    Estratégia: ordena todos os tokens por top; para cada linha que contém
    APENAS tokens de 2 dígitos (RE_CENTAVOS), funde com a linha imediatamente
    anterior que termina com tokens RE_MONEY_PARCIAL.
    """
    if not words:
        return words

    # Agrupa todos os tokens por chave de linha (sem filtro de rodapé)
    temp: dict[int, list] = {}
    for w in words:
        chave = round(w["top"] / 3.0)
        temp.setdefault(chave, []).append(w)

    chaves_ord = sorted(temp)
    resultado = list(words)  # cópia

    for idx, chave in enumerate(chaves_ord):
        ws_linha = sorted(temp[chave], key=lambda w: w["x0"])
        textos = [w["text"] for w in ws_linha]
        # Linha que só tem tokens de 2 dígitos (centavos avulsos)
        if textos and all(RE_CENTAVOS.match(t) for t in textos):
            if idx == 0:
                continue
            chave_ant = chaves_ord[idx - 1]
            ws_ant = sorted(temp[chave_ant], key=lambda w: w["x0"])
            # Verifica se a linha anterior termina com RE_MONEY_PARCIAL
            if ws_ant and RE_MONEY_PARCIAL.match(ws_ant[-1]["text"]):
                # Funde: os tokens de centavos passam a ter o mesmo top da anterior
                top_destino = ws_ant[-1]["top"]
                for w_cent in ws_linha:
                    # Cria cópia com top ajustado para a linha anterior
                    w_novo = dict(w_cent)
                    w_novo["top"] = top_destino
                    resultado.append(w_novo)
                    # Remove o token original (não é possível remoção in-place
                    # de forma segura; usamos filter abaixo)
                # Remove os tokens originais de centavos avulsos da linha atual
                ids_avulsos = {id(w) for w in ws_linha}
                resultado = [w for w in resultado if id(w) not in ids_avulsos]
    return resultado


def parsear(caminho_pdf: str) -> EstruturaW011A:
    """Parseia um PDF W011A e retorna EstruturaW011A completa e validada.

    Fluxo por página:
    1. Clusteriza colunas na página 1 (reutilizadas nas demais).
    2. Agrupa palavras por linha, exclui rodapé.
    3. Processa linha a linha mantendo estado: secao, grupo_atual,
       total_pendente (para casos de "Total de" cujo nome vem na linha seguinte).
    4. Ao final, calcula superavit_mes e valida reconciliação.
    """
    est = EstruturaW011A()
    cols: list[float] = []
    secao = None          # None | 'receitas' | 'despesas' | 'fim'
    grupo_atual: GrupoW011A | None = None
    # Quando encontramos "Total de" sem nome na mesma linha (nome vem depois),
    # guardamos o valor col12 para usar quando o nome chegar na próxima linha.
    total_pendente_valor: float | None = None
    total_pendente_serie: list | None = None

    with pdfplumber.open(caminho_pdf) as pdf:
        for pi, page in enumerate(pdf.pages):
            if secao == "fim":
                break
            words = page.extract_words()

            # Calibra colunas na página 1 e reutiliza nas demais
            if pi == 0:
                cols = _clusterizar_colunas(page)
                texto_pag1 = page.extract_text() or ""
                for linha in texto_pag1.split("\n")[:5]:
                    if linha.startswith("W011A"):
                        id_match = re.search(r"\((\d+)\)", linha)
                        est.condominio_id = id_match.group(1) if id_match else ""
                        nome_raw = re.sub(r"^W011A\s+", "", linha)
                        est.condominio = re.sub(r"\s*\(\d+\)\s*$", "", nome_raw).strip()
                    elif linha.startswith("Comparativo"):
                        di, df = _extrair_periodo_cabecalho(linha)
                        est.data_inicial = di or ""
                        est.data_final = df or ""
                est.meses_labels = _extrair_labels_meses(texto_pag1)

            if not cols or len(cols) != N_COLUNAS:
                cols = _clusterizar_colunas(page)

            limite_rodape = page.height - 35
            # Pré-processamento: reagrupa tokens quebrados de linhas ADJACENTES.
            # O PDF pode colocar "1.145.805," em top=214 e "64" em top=226 —
            # chaves diferentes no agrupamento por round(top/3). Resolve mesclando
            # a linha de centavos sozinhos (todos os tokens com RE_CENTAVOS) com a
            # linha anterior que termina com tokens RE_MONEY_PARCIAL.
            words = _reagrupar_linhas_adjacentes(words)
            buckets = _agrupar_palavras_por_linha(words, limite_rodape)

            for chave_linha in sorted(buckets):
                if secao == "fim":
                    break
                linha_words = sorted(buckets[chave_linha], key=lambda w: w["x0"])
                label, cells = _atribuir_colunas(linha_words, cols)

                if not label and all(c is None for c in cells):
                    continue

                # Filtra cabeçalhos de página e linha de meses
                if RE_CABECALHO.match(label):
                    continue
                # Linha de label dos meses (contém abreviatura de mês)
                if re.search(r"\b(Ago|Set|Out|Nov|Dez|Jan|Fev|Mar|Abr|Mai|Jun)/\d{4}\b", label):
                    continue
                # Rodapé pelo texto (por segurança além do filtro de top)
                if re.match(r"^(Avenida|Rua) |CEP\.|^\d+ de \d+$", label):
                    continue

                # Resolve "Total de" pendente (nome do grupo veio na linha seguinte).
                # Quando temos total_pendente E a linha atual é CAIXA ALTA sem valores,
                # ela é o complemento do "Total de" anterior — não abre novo grupo.
                # Exemplos: "Total de" + "INVESTIMENTO-IMOBILIZADO"
                #           "Total de DESPESA COM" (fechou por prefixo) + "ADMINISTRATIVO"
                if _e_caixa_alta(label) and all(c is None for c in cells):
                    if total_pendente_valor is not None:
                        # Complementa e fecha o grupo atual com o valor pendente
                        if grupo_atual is not None:
                            grupo_atual.total = total_pendente_valor
                            grupo_atual.total_mes = total_pendente_serie or [0.0] * 12
                            est.grupos.append(grupo_atual)
                            grupo_atual = None
                        total_pendente_valor = None
                        total_pendente_serie = None
                        # Esta linha era o nome complementar — não abre novo grupo
                        continue
                    # Sem total pendente: verifica se é rodapé disfarçado ou
                    # cabeçalho de seção legítimo.
                    # "PRAIA DOURADA" e textos de 1-2 palavras que não estão
                    # no mapa de categoria conhecida são rodapés do PDF.
                    if label not in MAPA_CATEGORIA and secao == "despesas":
                        # Linha CAIXA ALTA desconhecida dentro da seção de despesas
                        # só pode ser um novo grupo LEGÍTIMO se aparecer no mapa.
                        # Se não bate com nenhuma categoria conhecida e não tem
                        # valores, é muito provavelmente o nome do condomínio no
                        # rodapé que escapou do filtro por top (top=531 < 560).
                        # Heurística adicional: rodapé tem ≤ 2 palavras e aparece
                        # em TODAS as páginas na mesma posição.
                        palavras_label = label.split()
                        if len(palavras_label) <= 2:
                            # Provavelmente rodapé — ignora
                            continue
                        # Mais de 2 palavras desconhecidas: abre grupo com aviso
                        print(f"[parser_w011a] AVISO: categoria não mapeada: {label!r}",
                              file=sys.stderr)
                    # Abre novo grupo de despesa
                    if secao == "despesas":
                        if grupo_atual is not None:
                            est.grupos.append(grupo_atual)
                        categoria = MAPA_CATEGORIA.get(label, label.title())
                        grupo_atual = GrupoW011A(nome_relatorio=label, categoria=categoria)
                    continue

                # Saldo anterior
                if label.startswith("Saldo anterior"):
                    col0 = cells[0]
                    if col0 is not None:
                        est.saldo_anterior = col0
                    # A série do saldo anterior usa col0 diretamente como Jul
                    # (é o saldo de abertura de Jul/2025 — não há derivação aqui).
                    # cols 1..11 = saldos de abertura de Ago/2025 a Jun/2026.
                    serie_11 = [v if v is not None else 0.0 for v in cells[1:12]]
                    est.saldo_anterior_mes = [col0 or 0.0] + serie_11
                    continue

                # Transições de seção
                if label == "Receitas" and all(c is None for c in cells):
                    secao = "receitas"
                    continue
                if label == "Despesas" and all(c is None for c in cells):
                    secao = "despesas"
                    continue

                # Total de Receitas
                if label.startswith("Total de Receitas"):
                    col12 = cells[12]
                    if col12 is not None:
                        est.receita_total = col12
                        est.receita_total_mes = _serie_12(col12, cells[1:12])
                    continue

                # Total de Despesas
                if label.startswith("Total de Despesas"):
                    col12 = cells[12]
                    if col12 is not None:
                        est.despesa_total = col12
                        est.despesa_total_mes = _serie_12(col12, cells[1:12])
                    continue

                # Mov. Líquido
                if label.startswith("Mov. Líquido"):
                    col12 = cells[12]
                    if col12 is not None:
                        est.mov_liquido = col12
                    continue

                # Saldo Final — pode ter tokens quebrados misturados no label
                if label.startswith("Saldo Final"):
                    # A linha pode ter o col12 em cells[12] ou estar quebrado.
                    # O col12 real é o último número da linha (maior x0).
                    # Filtra: entre os valores não-None em cells, o col12 (índice 12)
                    # é o autoritativo. Se não encontrado, tenta col0 que no Saldo
                    # Final aparece repetido como primeiro e último.
                    col12 = cells[12]
                    if col12 is None:
                        # Fallback: último valor não-None na lista de cells
                        vals_nao_nulos = [(i, v) for i, v in enumerate(cells) if v is not None]
                        if vals_nao_nulos:
                            col12 = vals_nao_nulos[-1][1]
                    if col12 is not None:
                        est.saldo_final = col12
                    secao = "fim"
                    break

                # Total de categoria de despesa.
                # Dois formatos possíveis no PDF:
                #   (a) "Total de" sem nome na mesma linha (nome vem na próxima linha)
                #   (b) "Total de MANUTENÇÃO" com nome completo ou truncado
                #
                # Regra determinística: um grupo é fechado e appendado EXATAMENTE
                # uma vez. total_pendente só é setado quando o grupo NÃO foi fechado
                # ainda (nome incompleto, veio truncado). Nunca seta total_pendente
                # depois de já ter appendado o grupo — isso eliminava o estado zumbi.
                if label == "Total de" and secao == "despesas":
                    # Caso (a): nome vem na próxima linha CAIXA ALTA.
                    # Fecha o grupo imediatamente se grupo_atual existe,
                    # mas guarda total_pendente para o complemento do nome.
                    col12 = cells[12]
                    if col12 is not None and grupo_atual is not None:
                        serie = _serie_12(col12, cells[1:12])
                        grupo_atual.total = col12
                        grupo_atual.total_mes = serie
                        est.grupos.append(grupo_atual)
                        grupo_atual = None
                        # total_pendente sinaliza que a linha seguinte é complemento
                        # de nome (não abre novo grupo) — consumed em CAIXA ALTA acima.
                        total_pendente_valor = col12
                        total_pendente_serie = serie
                    continue

                m_total = re.match(r"^Total de (.+)$", label)
                if m_total and secao == "despesas":
                    nome_total = m_total.group(1).strip()
                    col12 = cells[12]

                    # Caso (b) com nome na linha: fecha o grupo se o nome bate.
                    fechou = False
                    if col12 is not None and grupo_atual is not None:
                        nome_grupo = grupo_atual.nome_relatorio
                        if (nome_grupo == nome_total or
                                nome_grupo.startswith(nome_total[:8]) or
                                nome_total.startswith(nome_grupo[:8])):
                            grupo_atual.total = col12
                            grupo_atual.total_mes = _serie_12(col12, cells[1:12])
                            est.grupos.append(grupo_atual)
                            grupo_atual = None
                            # Grupo fechado de forma definitiva — não há complemento pendente.
                            total_pendente_valor = None
                            total_pendente_serie = None
                            fechou = True

                    if not fechou and col12 is not None:
                        # Nome truncado e não casou: guarda pendente para linha seguinte
                        # (sem fechar o grupo ainda — a linha CAIXA ALTA consumirá).
                        total_pendente_valor = col12
                        total_pendente_serie = _serie_12(col12, cells[1:12])
                    continue

                # Seção de Receitas
                if secao == "receitas" and label:
                    col12 = cells[12]
                    if col12 is not None:
                        serie = _serie_12(col12, cells[1:12])
                        est.receitas.append(LancamentoW011A(label, col12, serie))
                    elif est.receitas:
                        est.receitas[-1].descricao += " " + label
                    continue

                # Seção de Despesas: lançamento dentro do grupo atual
                if secao == "despesas" and grupo_atual is not None and label:
                    col12 = cells[12]
                    if col12 is not None:
                        serie = _serie_12(col12, cells[1:12])
                        grupo_atual.lancamentos.append(LancamentoW011A(label, col12, serie))
                    elif grupo_atual.lancamentos:
                        grupo_atual.lancamentos[-1].descricao += " " + label
                    continue

    # Calcula superávit mensal
    if est.receita_total_mes and est.despesa_total_mes:
        est.superavit_mes = [
            round(r - d, 2)
            for r, d in zip(est.receita_total_mes, est.despesa_total_mes)
        ]

    _validar(est)
    return est


def _validar(est: EstruturaW011A):
    """Valida a estrutura parseada contra os totais do próprio relatório.

    Tolerância: R$0,02 (arredondamento de float ao derivar Jul).
    Verificações: conservação de caixa, soma receitas, soma grupos,
    soma lançamentos por grupo, mov_liquido.
    """
    erros = []
    TOL = 0.02

    caixa = est.saldo_anterior + est.receita_total - est.despesa_total
    if abs(caixa - est.saldo_final) > TOL:
        erros.append(
            f"conservação de caixa: {caixa:.2f} != saldo_final {est.saldo_final:.2f}"
        )

    soma_rec = round(sum(l.total for l in est.receitas), 2)
    if abs(soma_rec - est.receita_total) > TOL:
        erros.append(
            f"soma receitas {soma_rec:.2f} != total {est.receita_total:.2f}"
        )

    soma_desp = round(sum(g.total for g in est.grupos), 2)
    if abs(soma_desp - est.despesa_total) > TOL:
        erros.append(
            f"soma grupos {soma_desp:.2f} != total despesas {est.despesa_total:.2f}"
        )

    for g in est.grupos:
        soma_g = round(sum(l.total for l in g.lancamentos), 2)
        if abs(soma_g - g.total) > TOL:
            erros.append(
                f"grupo {g.nome_relatorio}: lançamentos {soma_g:.2f} != total {g.total:.2f}"
            )

    mov_esperado = round(est.receita_total - est.despesa_total, 2)
    if abs(est.mov_liquido - mov_esperado) > TOL:
        erros.append(
            f"mov_liquido {est.mov_liquido:.2f} != receita-despesa {mov_esperado:.2f}"
        )

    if erros:
        raise ValueError("W011A inconsistente: " + "; ".join(erros))
