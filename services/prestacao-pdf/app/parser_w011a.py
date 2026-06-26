# -*- coding: utf-8 -*-
"""Parser determinístico do W011A (Demonstrativo Mensal) do Superlógica.

Estratégia (baseada no proto validado e calibrada contra o PDF real):
- O W011A é em paisagem (842x595). Dois formatos suportados:
    ANO CHEIO (13 colunas):
      col0  = "Jul/2025-Jun/2026" (total período, coluna ESQUERDA)
      col1..11 = Ago/2025 a Jun/2026 (11 meses explícitos)
      col12 = "Total do período" (coluna DIREITA - autoritativa, use ESTE)
      Coluna Jul/2025 NAO existe no PDF: é derivada como (col12 - soma(col1..11)).
    PERIODO CURTO (ex: trimestre, 5 colunas):
      col0..N-2 = meses explícitos (todos presentes no PDF)
      col N-1 = "Total do período"
      Sem derivação: todos os meses já estão explícitos.
- Números grandes quebram em dois tokens: "1.293.772," + "27". Reagrupados
  pelo _reagrupar_tokens_quebrados antes da atribuição de coluna.
- "Total de <CATEGORIA>" pode ter o nome da categoria continuando na linha
  SEGUINTE do PDF (ex: "Total de" + linha seguinte "INVESTIMENTO-IMOBILIZADO").
  A lógica de parse mantém uma "fila" de "Total de" pendente sem nome.
- Colunas detectadas por clusterização de x-centers de tokens monetários na
  página 1 (gap > 12 px separa clusters).
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
# Número esperado de colunas no ano cheio — mantido para compatibilidade e documentação
N_COLUNAS = 13
# Gap mínimo em pixels para separar clusters de colunas
GAP_COLUNA = 12
# Regex para cabeçalho de período curto: "Comparativo de Abr/2026 com os próximos 2 meses"
# Cobre tanto "próximos" (com acento) quanto "proximos" (sem acento) para robustez
RE_PERIODO_CURTO = re.compile(
    r"Comparativo de (\w+)/(\d{4}) com os pr[oó]ximos (\d+) m[eê]s",
    re.IGNORECASE,
)


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


def _detectar_formato(cols: list, n_meses_header: int) -> tuple[int, bool]:
    """Detecta o formato do relatório (ano cheio vs. período curto) a partir dos
    clusters de coluna e do número de meses declarado no cabeçalho.

    Retorna (idx_total, deriva_primeiro):
    - idx_total: índice da coluna "Total do período" em cells (último cluster)
    - deriva_primeiro: True quando o primeiro mês não tem coluna própria e deve
      ser derivado por subtração (caso do ano cheio W011A padrão)

    Guard 422: levanta ValueError se o layout for malformado (poucos clusters ou
    discrepância impossível entre colunas e meses declarados).
    """
    if len(cols) < 3:
        # Menos de 3 clusters implica que não é um W011A válido (mínimo: 1 mês
        # explícito + 1 coluna de período completo + pelo menos o próprio total)
        raise ValueError(
            f"W011A malformado: apenas {len(cols)} cluster(s) de coluna detectado(s); "
            "esperado ao menos 3 (1 mês + período + total)"
        )

    idx_total = len(cols) - 1
    # n_explicitas = número de colunas numéricas entre a col0 e o total
    n_explicitas = len(cols) - 2

    diferenca = n_meses_header - n_explicitas
    if diferenca not in (0, 1):
        # 0 = todos os meses estão presentes (período curto)
        # 1 = falta o primeiro mês (derivado por subtração, caso ano cheio)
        raise ValueError(
            f"W011A malformado: cabeçalho declara {n_meses_header} meses "
            f"mas há {n_explicitas} colunas explícitas "
            f"(diferença {diferenca} fora do esperado 0 ou 1)"
        )

    deriva_primeiro = diferenca == 1
    return idx_total, deriva_primeiro


def _total_de_cells(cells: list, idx_total: int) -> float | None:
    """Retorna o valor do total do período de uma linha de cells.

    Primeiro tenta cells[idx_total] (posição autoritativa). Se for None, usa
    o fallback do último valor não-nulo da linha — mesmo comportamento que o
    bloco 'Saldo Final' já usava originalmente (linha ~491 do parser inicial).
    Retorna None se não encontrar nenhum valor.
    """
    val = cells[idx_total] if idx_total < len(cells) else None
    if val is not None:
        return val
    # Fallback: último valor não-nulo para casos onde o PDF quebra a atribuição
    vals_nao_nulos = [(i, v) for i, v in enumerate(cells) if v is not None]
    if vals_nao_nulos:
        return vals_nao_nulos[-1][1]
    return None


def _detectar_cut_date(
    matrix_lancamentos: list[list],
    saldo_anterior_cells: list,
    idx_total: int,
    deriva_primeiro: bool,
) -> int | None:
    """Detecta o índice de corte (primeira coluna de projeção futura) em PDFs cortados.

    PDFs cortados (ex: "26/12/2025 até 26/06/2026 com os próximos 11 meses") têm
    colunas de projeção futura após o corte. Dois sinais identificam essas colunas:

    Sinal 1 — Movimento zero: soma abs de todos os lançamentos não-saldo para a
    coluna j. Projeção futura tem movimento=0 porque nenhum lançamento foi realizado.

    Sinal 2 — Saldo em platô: saldo_anterior em j == saldo_anterior em j+1 == ...
    até idx_total-1. O saldo não avança quando não há movimento.

    Corte = menor j (1 <= j < idx_total) onde AMBOS os sinais concordam, e não
    existe coluna k > j com movimento > 0 (run final de zeros até idx_total-1).

    Guard: período curto (deriva_primeiro=False, poucas colunas) não tem projeção
    e não deve disparar corte mesmo que alguma coluna seja zero por acaso.

    Retorna o índice inteiro de corte (primeira coluna de projeção) ou None se o
    PDF está fechado (sem projeção futura).

    Levanta ValueError (422) se os dois sinais discordam — saldo muda depois do
    zero de movimento, ou movimento reaparece após o platô de saldo. Sinal ambíguo
    não deve ser adivinhand; é melhor 422 com revisão humana.
    """
    # Período curto (Quattro/trimestre): sem projeção por definição.
    # idx_total = len(cols)-1; colunas explícitas = idx_total-1.
    # Para período curto com <5 colunas explícitas, não tenta detectar corte.
    n_explicitas = idx_total - 1  # exclui col0 e col_total
    if not deriva_primeiro and n_explicitas <= 5:
        return None

    # Calcula movimento abs por coluna j (excluindo col0 e col_total).
    # Usa TODAS as linhas da matrix (lançamentos e subtotais), exceto saldo_anterior
    # que é tratado separadamente pelo Sinal 2.
    mov_por_col: list[float] = []
    for j in range(1, idx_total):
        total_j = 0.0
        for cells in matrix_lancamentos:
            v = cells[j] if j < len(cells) else None
            if v is not None:
                total_j += abs(v)
        mov_por_col.append(total_j)

    # Sinal 1: índices j (base 1 na lista, absolutos j+1 nas cells) com mov=0
    # Encontra o run final de zeros (sem col de mov>0 depois deles).
    # "Run final" = desde o primeiro j no tail contínuo de zeros até idx_total-1.
    run_final_inicio: int | None = None
    for k in range(len(mov_por_col) - 1, -1, -1):
        if mov_por_col[k] == 0.0:
            run_final_inicio = k
        else:
            break
    # Se não há run de zeros, o PDF está fechado (sem projeção).
    if run_final_inicio is None:
        return None

    # Sinal 2: detecta onde o platô do saldo_anterior começa.
    # Platô = sequência de valores iguais até o final (excluindo col_total).
    plato_inicio: int | None = None
    if saldo_anterior_cells is not None and len(saldo_anterior_cells) > idx_total:
        val_plato = saldo_anterior_cells[idx_total - 1]
        if val_plato is not None:
            for k in range(idx_total - 2, 0, -1):
                if saldo_anterior_cells[k] is not None and abs(saldo_anterior_cells[k] - val_plato) < 0.02:
                    plato_inicio = k
                else:
                    break

    # Corte = início do run final de zeros (índice absoluto na cells = run_final_inicio+1).
    corte_idx = run_final_inicio + 1  # converte de índice em mov_por_col para índice em cells

    # Valida coerência entre os dois sinais.
    if plato_inicio is not None:
        # Sinal 2 disponível: o platô deve começar no mesmo ponto ou antes do corte.
        # Tolerância de 1 coluna para casos onde o saldo final do último mês real
        # já coincide com o platô (ex: Augusta: col6 saldo final = col7 saldo ant).
        if abs(plato_inicio - corte_idx) > 1:
            raise ValueError(
                f"W011A cut-date ambíguo: movimento zera na coluna {corte_idx} "
                f"mas platô do saldo começa na coluna {plato_inicio}. "
                "Revisão manual necessária."
            )

    return corte_idx


def _serie_n(total_periodo: float, cells: list, idx_total: int,
             deriva_primeiro: bool) -> list:
    """Monta a série mensal completa com N meses para qualquer formato do W011A.

    Se deriva_primeiro=True (ano cheio): o primeiro mês não tem coluna e é
    calculado como total - soma(meses explícitos), idêntico ao _serie_12 original.
    Se deriva_primeiro=False (período curto): todos os meses estão em cells[1:idx_total]
    e são retornados diretamente sem inventar mês extra.

    O caminho deriva_primeiro=True reutiliza _serie_12 internamente para garantir
    resultado bit-idêntico ao comportamento anterior no ano cheio.
    """
    cols_explicitas = cells[1:idx_total]
    if deriva_primeiro:
        # Delega para _serie_12 que usa a mesma lógica de derivação do Jul
        # — mantém exatamente o mesmo cálculo para não-regressão do ano cheio
        return _serie_12(total_periodo, cols_explicitas)
    else:
        # Período curto: todos os meses já estão presentes, sem derivação
        return [v if v is not None else 0.0 for v in cols_explicitas]


def _serie_n_cortada(cells: list, idx_total: int, deriva_primeiro: bool,
                     idx_corte: int | None) -> tuple[list, float]:
    """Monta a série de meses REAIS aplicando o corte quando detectado.

    Diferente de _serie_n, esta função calcula o total como sum(serie_real)
    em vez de usar cells[idx_total]. Isso garante que total e série sejam sempre
    coerentes, mesmo em PDFs cortados onde cells[idx_total] inclui projeção futura.

    Retorna (serie_real, total_real) onde:
    - serie_real: lista de valores mensais apenas para meses reais (sem projeção)
    - total_real: sum(serie_real), autoritativo para _validar e o pipeline

    Se idx_corte é None (PDF fechado), comporta-se como _serie_n com total da coluna.
    """
    if idx_corte is None:
        # PDF fechado: comportamento original idêntico ao _serie_n
        col_total = cells[idx_total] if idx_total < len(cells) else None
        if col_total is None:
            vals = [(i, v) for i, v in enumerate(cells) if v is not None]
            col_total = vals[-1][1] if vals else 0.0
        serie = _serie_n(col_total, cells, idx_total, deriva_primeiro)
        return serie, round(col_total, 2)

    # PDF cortado: extrai apenas os meses reais (cells[1:idx_corte]).
    # col0 é o agregado da janela real (não é mês individual — confirmado no Passo 0).
    # idx_corte é a primeira coluna de projeção, então meses reais = cells[1:idx_corte].
    meses_reais = [cells[j] if j < len(cells) and cells[j] is not None else 0.0
                   for j in range(1, idx_corte)]
    total_real = round(sum(meses_reais), 2)
    return meses_reais, total_real


MESES_ABREV_PT = {
    "Jan": "01", "Fev": "02", "Mar": "03", "Abr": "04",
    "Mai": "05", "Jun": "06", "Jul": "07", "Ago": "08",
    "Set": "09", "Out": "10", "Nov": "11", "Dez": "12",
}


def _extrair_periodo_cabecalho(texto: str):
    """Extrai data_inicial e data_final do cabeçalho do W011A.

    Suporta dois formatos:
    1. Ano cheio: "Comparativo de Jul/2025 até Jun/2026"
       (formato original, mantido intacto como primeira tentativa)
    2. Período curto: "Comparativo de Abr/2026 com os próximos 2 meses"
       (K meses adicionais; data_final = mes_inicial + K meses, com rollover de ano)
    Retorna (None, None) se nenhum formato bater.
    """
    # Primeira tentativa: formato "ate" (ano cheio padrão — inalterado)
    m = re.search(r"Comparativo de (\w+)/(\d{4}) até (\w+)/(\d{4})", texto)
    if m:
        num_ini = MESES_ABREV_PT.get(m.group(1), "01")
        ano_ini = m.group(2)
        num_fim = MESES_ABREV_PT.get(m.group(3), "12")
        ano_fim = m.group(4)
        data_inicial = f"01/{num_ini}/{ano_ini}"
        data_final = f"30/{num_fim}/{ano_fim}"
        return data_inicial, data_final

    # Segunda tentativa: formato "com os proximos K meses" (período curto)
    m2 = RE_PERIODO_CURTO.search(texto)
    if m2:
        mes_ini_nome = m2.group(1).capitalize()
        ano_ini = int(m2.group(2))
        k = int(m2.group(3))
        num_ini_str = MESES_ABREV_PT.get(mes_ini_nome, "01")
        num_ini = int(num_ini_str)
        # Calcula o mês final: mes_inicial + K meses (com rollover de ano)
        num_fim = num_ini + k
        ano_fim = ano_ini
        while num_fim > 12:
            num_fim -= 12
            ano_fim += 1
        data_inicial = f"01/{num_ini:02d}/{ano_ini}"
        data_final = f"30/{num_fim:02d}/{ano_fim}"
        return data_inicial, data_final

    return None, None


def _extrair_labels_meses(texto_pag1: str, n_meses: int = 12) -> list:
    """Extrai os labels de meses do cabeçalho do W011A.

    Dois caminhos:
    1. Ano cheio (n_meses=12): procura a linha que contém "Ago/" (coluna de
       cabeçalho do PDF padrão), extrai os 11 meses explícitos e prefixa Jul
       derivado. Caminho original mantido inalterado.
    2. Período curto (n_meses != 12): extrai N meses do cabeçalho "Comparativo
       de MES/ANO com os próximos K meses" calculando a sequência de meses.
       Não depende de linha "Ago/" que não existe no período curto.
    O fallback genérico gera n_meses labels (parametrizado por n_meses).
    """
    # Caminho 1: ano cheio — mantido literalmente intacto para não-regressão
    if n_meses == 12:
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
        # Fallback ano cheio se extração falhar (comportamento original)
        return ["Jul"] + [f"Mês{i}" for i in range(1, 12)]

    # Caminho 2: período curto — extrai N meses a partir do cabeçalho "com os proximos"
    m2 = RE_PERIODO_CURTO.search(texto_pag1)
    if m2:
        mes_ini_nome = m2.group(1).capitalize()
        ano_ini = int(m2.group(2))
        # Constrói a lista de N meses em sequência a partir do mês inicial
        MESES_NUM_PARA_NOME = {v: k for k, v in MESES_ABREV_PT.items()}
        num_ini = int(MESES_ABREV_PT.get(mes_ini_nome, "01"))
        labels = []
        for i in range(n_meses):
            num = (num_ini - 1 + i) % 12 + 1
            ano = ano_ini + (num_ini - 1 + i) // 12
            nome = MESES_NUM_PARA_NOME.get(f"{num:02d}", f"M{num:02d}")
            labels.append(f"{nome}/{ano}")
        return labels

    # Fallback genérico: gera n_meses labels com placeholder
    return [f"Mês{i}" for i in range(1, n_meses + 1)]


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


def _coletar_rodape_repetido(pdf) -> set:
    """Detecta rodapé de forma estrutural, sem contar palavras.

    O rodapé do W011A (nome do condomínio ou da administradora) se repete
    IDÊNTICO em toda página, na zona inferior. Linhas que aparecem em 2+ páginas
    nessa zona são rodapé. Cobre nomes de qualquer tamanho, inclusive 3 palavras
    (ex PRAIA DO LEBLON) que a heurística antiga de contar palavras deixava passar.
    """
    contagem: dict = {}
    for page in pdf.pages:
        zona = page.height - 80  # zona de rodapé, abaixo do conteúdo financeiro
        baixo = [w for w in page.extract_words() if w["top"] > zona]
        linhas: dict = {}
        for w in baixo:
            linhas.setdefault(round(w["top"] / 3.0), []).append(w)
        # Conta cada texto uma vez por página (set), para que repetir entre
        # páginas seja o sinal, não repetir dentro da mesma página.
        textos_pagina = set()
        for k in linhas:
            txt = " ".join(w["text"] for w in sorted(linhas[k], key=lambda x: x["x0"])).strip()
            if txt:
                textos_pagina.add(txt)
        for txt in textos_pagina:
            contagem[txt] = contagem.get(txt, 0) + 1
    return {txt for txt, n in contagem.items() if n >= 2}


def _e_fragmento_continuacao(label: str, grupo_atual, grupos: list) -> bool:
    """Fragmento de nome de categoria quebrado em duas linhas.

    Quando o nome de uma categoria (ou da linha "Total de") quebra em duas linhas,
    o sufixo fica sozinho numa linha CAIXA ALTA (ex "FISCAIS" após "RETENÇÕES
    -NOTAS FISCAIS", "ADMINISTRATIVO" após "DESPESA COM ADMINISTRATIVO"). Isso é
    continuação do nome anterior, NÃO abre grupo novo. Estrutural: a linha é o
    sufixo em palavras do nome de um grupo recém-aberto ou recém-fechado.
    """
    palavras = label.split()
    candidatos = []
    if grupo_atual is not None:
        candidatos.append(grupo_atual.nome_relatorio)
    if grupos:
        candidatos.append(grupos[-1].nome_relatorio)
    for nome in candidatos:
        pn = nome.split()
        if 0 < len(palavras) < len(pn) and pn[-len(palavras):] == palavras:
            return True
    return False


def parsear(caminho_pdf: str) -> EstruturaW011A:
    """Parseia um PDF W011A e retorna EstruturaW011A completa e validada.

    Fluxo por página:
    1. Clusteriza colunas na página 1 (reutilizadas nas demais).
    2. Detecta o formato (ano cheio vs. período curto) via _detectar_formato,
       propagando idx_total e deriva_primeiro como variáveis locais — sem global.
    3. Agrupa palavras por linha, exclui rodapé.
    4. Processa linha a linha mantendo estado: secao, grupo_atual,
       total_pendente (para casos de "Total de" cujo nome vem na linha seguinte).
       Durante o parse, guarda cells_brutas de todos os lançamentos para detectar
       corte na fase de pós-processamento.
    5. Pós-processamento: detecta cut_date, recalcula séries e totais com meses reais.
    6. Calcula superavit_mes e valida reconciliação.

    Sobre PDFs cortados ("26/12/2025 até 26/06/2026 com os próximos 11 meses"):
    O cabeçalho anuncia N meses futuros que ainda não aconteceram. A coluna Total do
    período inclui projeção. O pós-processamento detecta onde o movimento zera
    (sinais de corte) e trunca as séries para apenas os meses reais confirmados.
    Todos os .total passam a ser sum(serie_real) em vez de cells[idx_total].
    """
    est = EstruturaW011A()
    cols: list[float] = []
    secao = None          # None | 'receitas' | 'despesas' | 'fim'
    grupo_atual: GrupoW011A | None = None
    # Quando encontramos "Total de" sem nome na mesma linha (nome vem depois),
    # guardamos o valor col12 para usar quando o nome chegar na próxima linha.
    total_pendente_valor: float | None = None
    total_pendente_serie: list | None = None
    total_pendente_cells: list | None = None  # cells brutas do total pendente
    # Formato detectado na página 1 — propagado para todas as páginas
    idx_total: int = N_COLUNAS - 1    # padrão ano cheio (12); substituído na pg1
    deriva_primeiro: bool = True       # padrão ano cheio; substituído na pg1
    n_meses: int = 12                  # padrão ano cheio; substituído na pg1

    # Coleta para detecção de cut_date: lista de cells de todos os lançamentos
    # (excluindo linhas de saldo, total de receitas/despesas, mov, saldo final).
    # Usada em _detectar_cut_date para calcular movimento abs por coluna.
    _matrix_lancamentos: list[list] = []
    # cells brutas do Saldo anterior (para verificar platô no sinal 2 do cut_date).
    _saldo_ant_cells: list | None = None

    # Mapeamento de cada LancamentoW011A para suas cells brutas do PDF.
    # Necessário para recalcular série e total após detecção de corte (pós-proc).
    _cells_por_lancamento: dict[int, list] = {}  # id(lancamento) -> cells
    _cells_por_grupo: dict[int, list] = {}        # id(grupo) -> cells do "Total de"
    _cells_receita_total: list | None = None
    _cells_despesa_total: list | None = None
    _cells_mov_liquido: list | None = None
    _cells_saldo_final: list | None = None

    with pdfplumber.open(caminho_pdf) as pdf:
        # Rodapé detectado por repetição estrutural (uma passada prévia),
        # substitui a heurística antiga de contar palavras.
        rodape_set = _coletar_rodape_repetido(pdf)
        for pi, page in enumerate(pdf.pages):
            if secao == "fim":
                break
            words = page.extract_words()

            # Calibra colunas na página 1 e reutiliza nas demais.
            # Detecta o formato (ano cheio ou período curto) uma única vez na pg1
            # e propaga idx_total / deriva_primeiro / n_meses para o restante.
            if pi == 0:
                cols = _clusterizar_colunas(page)
                texto_pag1 = page.extract_text() or ""
                # Extrai número de meses declarado no cabeçalho para _detectar_formato
                n_meses_header = 12  # assume ano cheio como padrão
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
                        # Detecta formato período curto pelo cabeçalho "com os proximos K meses"
                        m_curto = RE_PERIODO_CURTO.search(linha)
                        if m_curto:
                            k = int(m_curto.group(3))
                            # K meses adicionais + o mês inicial = K+1 meses totais
                            n_meses_header = k + 1
                # Detecta idx_total e deriva_primeiro a partir dos clusters e do cabeçalho
                idx_total, deriva_primeiro = _detectar_formato(cols, n_meses_header)
                n_meses = n_meses_header
                est.meses_labels = _extrair_labels_meses(texto_pag1, n_meses)

            # No ano cheio revalida se cols mudou de página (comportamento original).
            # No período curto aceita qualquer número de clusters consistente com
            # idx_total já calculado — não força N_COLUNAS=13.
            if not cols or (deriva_primeiro and len(cols) != N_COLUNAS):
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
                        # Complementa e fecha o grupo atual com o valor pendente.
                        # [0.0] * n_meses cobre tanto 12 (ano cheio) quanto N (curto)
                        if grupo_atual is not None:
                            grupo_atual.total = total_pendente_valor
                            grupo_atual.total_mes = total_pendente_serie or [0.0] * n_meses
                            est.grupos.append(grupo_atual)
                            # Guarda cells brutas para pós-processamento de corte
                            if total_pendente_cells is not None:
                                _cells_por_grupo[id(grupo_atual)] = total_pendente_cells
                            grupo_atual = None
                        total_pendente_valor = None
                        total_pendente_serie = None
                        total_pendente_cells = None
                        # Esta linha era o nome complementar — não abre novo grupo
                        continue
                    # Sem total pendente: verifica se é rodapé disfarçado ou
                    # cabeçalho de seção legítimo.
                    # "PRAIA DOURADA" e textos de 1-2 palavras que não estão
                    # no mapa de categoria conhecida são rodapés do PDF.
                    if label not in MAPA_CATEGORIA and secao == "despesas":
                        # Tratamento ESTRUTURAL (sem contar palavras). Uma linha
                        # CAIXA ALTA sem valores fora do mapa é uma de três coisas:
                        # 1) Rodapé (nome do condomínio/administradora): repete
                        #    idêntico em 2+ páginas. Cobre nomes de 3+ palavras
                        #    (ex PRAIA DO LEBLON) que a heurística antiga deixava
                        #    virar grupo falso.
                        if label in rodape_set:
                            continue
                        # 2) Fragmento de nome quebrado em duas linhas: sufixo do
                        #    nome de um grupo recém-aberto ou fechado (ex FISCAIS
                        #    após RETENÇÕES -NOTAS FISCAIS). Continuação, não abre.
                        if _e_fragmento_continuacao(label, grupo_atual, est.grupos):
                            continue
                        # 3) Categoria desconhecida legítima (Opção B): abre com o
                        #    nome real e avisa para enriquecer o MAPA_CATEGORIA depois.
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
                    # Guarda cells brutas para detecção do platô (sinal 2 do cut_date)
                    _saldo_ant_cells = cells
                    if deriva_primeiro:
                        # ANO CHEIO: lógica posicional INTACTA (EMENDA crítica do Matheus).
                        # col0 = saldo abertura Jul (real, não derivado).
                        # cells[1:12] = saldos de abertura Ago..Jun (11 aberturas contíguas).
                        # None -> 0.0 para manter 12 posições fixas sem compactar.
                        serie_11 = [v if v is not None else 0.0 for v in cells[1:12]]
                        est.saldo_anterior_mes = [col0 or 0.0] + serie_11
                    else:
                        # PERIODO CURTO: as N aberturas de saldo estão espalhadas nas
                        # cells como não-nulos em posições não necessariamente contíguas.
                        # Ex trimestre: cells=[117196.81, None, 115041.63, 138596.76, None]
                        # -> compactar por não-nulos em ordem de índice -> 3 valores.
                        # Não usar lógica posicional: cells[1:N] não são todos válidos.
                        vals_ord = [v for v in cells[:idx_total] if v is not None]
                        # Se col0 não estava em vals_ord já, garante que col0 é o primeiro
                        # (caso raro onde col0 é None mas havia valor anterior do período)
                        if not vals_ord and col0 is not None:
                            vals_ord = [col0]
                        # Guard de alinhamento: a compactação deve produzir exatamente
                        # n_meses valores — um saldo de abertura para cada mês do período.
                        # Se não alinhar, o zip em pipeline.py truncaria silenciosamente
                        # e o mini-gráfico de saldo ficaria desalinhado no deck.
                        # Melhor 422 com revisão humana do que deck silenciosamente errado.
                        if len(vals_ord) != n_meses:
                            raise ValueError(
                                f"saldo anterior nao alinha com periodo: "
                                f"{len(vals_ord)} valores para {n_meses} meses"
                            )
                        est.saldo_anterior_mes = vals_ord
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
                    # _total_de_cells usa idx_total (não hardcoded 12), com fallback
                    # para o último valor não-nulo igual ao bloco Saldo Final original
                    col_total = _total_de_cells(cells, idx_total)
                    if col_total is not None:
                        est.receita_total = col_total
                        est.receita_total_mes = _serie_n(col_total, cells, idx_total, deriva_primeiro)
                        _cells_receita_total = cells  # guarda para pós-processamento
                    else:
                        # Total ausente em linha obrigatória após fallback -> 422
                        raise ValueError(
                            "W011A malformado: 'Total de Receitas' sem valor de total"
                        )
                    continue

                # Total de Despesas
                if label.startswith("Total de Despesas"):
                    col_total = _total_de_cells(cells, idx_total)
                    if col_total is not None:
                        est.despesa_total = col_total
                        est.despesa_total_mes = _serie_n(col_total, cells, idx_total, deriva_primeiro)
                        _cells_despesa_total = cells  # guarda para pós-processamento
                    else:
                        # Total ausente em linha obrigatória após fallback -> 422
                        raise ValueError(
                            "W011A malformado: 'Total de Despesas' sem valor de total"
                        )
                    continue

                # Mov. Líquido
                if label.startswith("Mov. Líquido"):
                    col_total = _total_de_cells(cells, idx_total)
                    if col_total is not None:
                        est.mov_liquido = col_total
                        _cells_mov_liquido = cells  # guarda para pós-processamento
                    continue

                # Saldo Final — pode ter tokens quebrados misturados no label.
                # Usa _total_de_cells que encapsula o mesmo fallback que o bloco
                # original tinha (último valor não-nulo quando idx_total é None).
                if label.startswith("Saldo Final"):
                    col_total = _total_de_cells(cells, idx_total)
                    if col_total is not None:
                        est.saldo_final = col_total
                        _cells_saldo_final = cells  # guarda para pós-processamento
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
                    col_total = _total_de_cells(cells, idx_total)
                    if col_total is not None and grupo_atual is not None:
                        serie = _serie_n(col_total, cells, idx_total, deriva_primeiro)
                        grupo_atual.total = col_total
                        grupo_atual.total_mes = serie
                        est.grupos.append(grupo_atual)
                        # Guarda cells brutas para pós-processamento
                        _cells_por_grupo[id(grupo_atual)] = cells
                        grupo_atual = None
                        # total_pendente sinaliza que a linha seguinte é complemento
                        # de nome (não abre novo grupo) — consumed em CAIXA ALTA acima.
                        total_pendente_valor = col_total
                        total_pendente_serie = serie
                        total_pendente_cells = cells
                    continue

                m_total = re.match(r"^Total de (.+)$", label)
                if m_total and secao == "despesas":
                    nome_total = m_total.group(1).strip()
                    col_total = _total_de_cells(cells, idx_total)

                    # Caso (b) com nome na linha: fecha o grupo se o nome bate.
                    fechou = False
                    if col_total is not None and grupo_atual is not None:
                        nome_grupo = grupo_atual.nome_relatorio
                        if (nome_grupo == nome_total or
                                nome_grupo.startswith(nome_total[:8]) or
                                nome_total.startswith(nome_grupo[:8])):
                            grupo_atual.total = col_total
                            grupo_atual.total_mes = _serie_n(col_total, cells, idx_total, deriva_primeiro)
                            est.grupos.append(grupo_atual)
                            # Guarda cells brutas para pós-processamento
                            _cells_por_grupo[id(grupo_atual)] = cells
                            grupo_atual = None
                            # Grupo fechado de forma definitiva — não há complemento pendente.
                            total_pendente_valor = None
                            total_pendente_serie = None
                            total_pendente_cells = None
                            fechou = True

                    if not fechou and col_total is not None:
                        # Nome truncado e não casou: guarda pendente para linha seguinte
                        # (sem fechar o grupo ainda — a linha CAIXA ALTA consumirá).
                        total_pendente_valor = col_total
                        total_pendente_serie = _serie_n(col_total, cells, idx_total, deriva_primeiro)
                        total_pendente_cells = cells
                    continue

                # Seção de Receitas
                if secao == "receitas" and label:
                    col_total = _total_de_cells(cells, idx_total)
                    if col_total is not None:
                        serie = _serie_n(col_total, cells, idx_total, deriva_primeiro)
                        lanc = LancamentoW011A(label, col_total, serie)
                        est.receitas.append(lanc)
                        # Guarda cells brutas e acumula na matrix para cut_date
                        _cells_por_lancamento[id(lanc)] = cells
                        _matrix_lancamentos.append(cells)
                    elif est.receitas:
                        est.receitas[-1].descricao += " " + label
                    continue

                # Seção de Despesas: lançamento dentro do grupo atual
                if secao == "despesas" and grupo_atual is not None and label:
                    col_total = _total_de_cells(cells, idx_total)
                    if col_total is not None:
                        serie = _serie_n(col_total, cells, idx_total, deriva_primeiro)
                        lanc = LancamentoW011A(label, col_total, serie)
                        grupo_atual.lancamentos.append(lanc)
                        # Guarda cells brutas e acumula na matrix para cut_date
                        _cells_por_lancamento[id(lanc)] = cells
                        _matrix_lancamentos.append(cells)
                    elif grupo_atual.lancamentos:
                        grupo_atual.lancamentos[-1].descricao += " " + label
                    continue

    # ── Pós-processamento: detecta cut_date e recalcula séries e totais ──────
    #
    # _detectar_cut_date usa os dois sinais (movimento zero + platô de saldo)
    # para encontrar a primeira coluna de projeção futura. Retorna None se o PDF
    # está fechado (sem projeção). Para PDFs fechados, nada muda: o código abaixo
    # é um no-op e os totais/séries permanecem exatamente como calculados acima.
    idx_corte = _detectar_cut_date(
        _matrix_lancamentos, _saldo_ant_cells, idx_total, deriva_primeiro
    )

    if idx_corte is not None:
        # PDF cortado: recalcula séries usando apenas meses reais (col1..idx_corte-1).
        # Todos os .total passam a ser sum(serie_real) — coerente com _validar().
        # meses_labels: trunca para apenas os meses reais (sem projeção futura).
        # Para PDFs com cabeçalho "26/12/25 até 26/06/26", os labels do PDF são
        # col1..col_total-1. Queremos col1..idx_corte-1 (excluindo projeção).
        n_meses_reais = idx_corte - 1  # cols 1..idx_corte-1 = idx_corte-1 meses
        est.meses_labels = est.meses_labels[:n_meses_reais]

        # Recalcula saldo_anterior_mes: apenas os valores de col1..idx_corte-1.
        # (col0 é a janela total, não um mês; col1..idx_corte-1 são os meses reais)
        if _saldo_ant_cells is not None:
            est.saldo_anterior = _saldo_ant_cells[0] or 0.0
            est.saldo_anterior_mes = [
                _saldo_ant_cells[j] if j < len(_saldo_ant_cells) and _saldo_ant_cells[j] is not None else 0.0
                for j in range(1, idx_corte)
            ]

        # Recalcula saldo_final: usa col0 das cells (valor real da janela completa).
        # col0 do Saldo Final = saldo acumulado ao longo de toda a janela real.
        if _cells_saldo_final is not None and _cells_saldo_final[0] is not None:
            est.saldo_final = _cells_saldo_final[0]

        # Recalcula cada lançamento de receita com meses reais e total=sum(serie)
        for lanc in est.receitas:
            cells_lanc = _cells_por_lancamento.get(id(lanc))
            if cells_lanc is not None:
                serie, total = _serie_n_cortada(cells_lanc, idx_total, deriva_primeiro, idx_corte)
                lanc.serie_mes = serie
                lanc.total = total

        # Recalcula cada lançamento de despesa e cada grupo com meses reais
        for g in est.grupos:
            soma_g = 0.0
            for lanc in g.lancamentos:
                cells_lanc = _cells_por_lancamento.get(id(lanc))
                if cells_lanc is not None:
                    serie, total = _serie_n_cortada(cells_lanc, idx_total, deriva_primeiro, idx_corte)
                    lanc.serie_mes = serie
                    lanc.total = total
                soma_g += lanc.total
            # total do grupo = sum(lançamentos recalculados), serie = soma por mês
            g.total = round(soma_g, 2)
            if g.lancamentos and g.lancamentos[0].serie_mes:
                g.total_mes = [
                    round(sum(lanc.serie_mes[i] for lanc in g.lancamentos), 2)
                    for i in range(len(g.lancamentos[0].serie_mes))
                ]

        # Recalcula receita_total e receita_total_mes como sum dos lançamentos reais
        if est.receitas:
            est.receita_total = round(sum(l.total for l in est.receitas), 2)
            if est.receitas[0].serie_mes:
                est.receita_total_mes = [
                    round(sum(l.serie_mes[i] for l in est.receitas), 2)
                    for i in range(len(est.receitas[0].serie_mes))
                ]

        # Recalcula despesa_total e despesa_total_mes como sum dos grupos reais
        if est.grupos:
            est.despesa_total = round(sum(g.total for g in est.grupos), 2)
            if est.grupos[0].total_mes:
                est.despesa_total_mes = [
                    round(sum(g.total_mes[i] for g in est.grupos), 2)
                    for i in range(len(est.grupos[0].total_mes))
                ]

        # Recalcula mov_liquido da janela real: col0 da linha Mov. Líquido.
        # col0 contém o movimento realizado na janela (26/dez até o corte),
        # sem incluir a projeção futura que está em col_total.
        if _cells_mov_liquido is not None and _cells_mov_liquido[0] is not None:
            est.mov_liquido = _cells_mov_liquido[0]
        else:
            # Fallback: recalcula como receita_total - despesa_total (ambos já reais)
            est.mov_liquido = round(est.receita_total - est.despesa_total, 2)

    # Calcula superávit mensal (independente de corte ou não)
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
