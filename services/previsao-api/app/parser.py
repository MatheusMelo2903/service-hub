"""Parser dos relatorios W011A e W045A do Superlogica para a API FastAPI.

Adaptado do skill standalone parser_superlogica.py (nao tocar o original).
Diferencas principais:
  - Aceita BytesIO alem de caminho de arquivo (necessario para UploadFile).
  - Usa os 8 grupos canonicos + subcategorias do modulo categorias.py.
  - 'Utilidades' (energia/agua/telefonia areas comuns) vira subcategoria com
    rateio='uso-real', saindo de PADROES_FORA_GRUPO do skill original.
  - montar_response retorna PrevisaoResponse (Pydantic), nao dict.
"""
from __future__ import annotations

import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

import pdfplumber

from .categorias import GRUPOS, SUBCATEGORIAS, classificar_subcategoria
from .schemas import (
    Fracao,
    Grupo,
    ItemForaGrupo,
    Lancamento,
    Metadados,
    PrevisaoResponse,
    Subcategoria,
)

PARSER_VERSAO = '1.1.0'

# ─── Marcadores de identificacao de tipo ─────────────────────────────────

_MARCADORES_W011A = [
    'w011a', 'demonstrativo de despesas', 'despesas - ultimos 12',
    'despesas dos ultimos 12', 'despesas mensais por categoria',
    'lancamentos do periodo',
    # Com acento (pdfplumber pode extrair com acento)
    'despesas - últimos 12', 'lançamentos do período',
]
_MARCADORES_W045A = [
    'w045a', 'fracao ideal', 'fracoes ideais', 'rateio por fracao',
    'rateio por fracao',
    # Com acento
    'fração ideal', 'frações ideais', 'rateio por fração',
]

# ─── Helpers de parsing ──────────────────────────────────────────────────

_RE_VALOR_BRL = re.compile(r'(-?\d{1,3}(?:\.\d{3})*,\d{2})')
_RE_DATA_BR = re.compile(r'(\d{2}/\d{2}/\d{4})')
_RE_PERIODO = re.compile(
    r'((?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/\d{4})\s*(?:a|até|–|-)\s*'
    r'((?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/\d{4})',
    re.IGNORECASE,
)


def _parse_valor(texto: str) -> float | None:
    """Converte string BR ("1.234,56") em float. Retorna None se invalido."""
    if not texto:
        return None
    s = texto.strip().replace(' ', '')
    m = _RE_VALOR_BRL.search(s)
    if not m:
        return None
    return float(m.group(1).replace('.', '').replace(',', '.'))


def _abrir_pdf(arquivo: str | BytesIO) -> pdfplumber.PDF:
    """Abre PDF a partir de caminho ou BytesIO. Abstrai a diferenca pro parser."""
    if isinstance(arquivo, (str, bytes)):
        return pdfplumber.open(arquivo)
    # BytesIO ou file-like object
    return pdfplumber.open(arquivo)


# ─── Identificacao de tipo ────────────────────────────────────────────────

def identificar_tipo_pdf(arquivo: str | BytesIO) -> str:
    """Identifica se o PDF e W011A, W045A ou DESCONHECIDO pelo conteudo.

    Aceita tanto caminho de arquivo (str) quanto BytesIO (necessario para
    UploadFile do FastAPI). Le as 3 primeiras paginas por performance.
    """
    try:
        with _abrir_pdf(arquivo) as pdf:
            paginas_consideradas = pdf.pages[:3]
            texto = '\n'.join(
                (p.extract_text() or '') for p in paginas_consideradas
            ).lower()
    except Exception as e:
        print(f'[parser] falha ao abrir PDF: {e}', file=sys.stderr)
        return 'DESCONHECIDO'

    if any(m in texto for m in _MARCADORES_W011A):
        return 'W011A'
    if any(m in texto for m in _MARCADORES_W045A):
        return 'W045A'
    return 'DESCONHECIDO'


# ─── W011A ───────────────────────────────────────────────────────────────

def parsear_w011a(arquivo: str | BytesIO) -> dict[str, Any]:
    """Extrai lancamentos do W011A e os classifica nos grupos canonicos.

    Para cada lancamento:
      - Chama classificar_subcategoria(descricao) de categorias.py.
      - Se retornou id_subcat -> acumula em subcategorias_extraidas.
      - Se retornou motivo fora-grupo -> acumula em itens_fora_grupo.

    Retorna dict com:
        condominio, periodo, subcategorias_extraidas, itens_fora_grupo,
        nao_classificados, avisos.
    """
    condominio = ''
    periodo = ''
    lancamentos_raw: list[dict] = []

    with _abrir_pdf(arquivo) as pdf:
        for pagina in pdf.pages:
            t = pagina.extract_text() or ''
            for linha in t.split('\n'):
                ls = linha.strip()
                if not ls:
                    continue

                # Captura nome do condominio na primeira ocorrencia
                if not condominio:
                    m = re.match(
                        r'condom[iíi]nio[:\s]+(.+)$',
                        ls, re.IGNORECASE,
                    )
                    if m:
                        condominio = m.group(1).strip()

                # Captura periodo (ex: "Mai/2025 a Abr/2026")
                if not periodo:
                    m = _RE_PERIODO.search(ls)
                    if m:
                        periodo = f'{m.group(1)} a {m.group(2)}'

                # Heuristica: linha de lancamento tem data + descricao + valor BRL no fim
                m_data = _RE_DATA_BR.search(ls)
                m_valor = _RE_VALOR_BRL.search(ls)
                if m_data and m_valor and m_data.start() < m_valor.start():
                    descricao = ls[m_data.end():m_valor.start()].strip()
                    # Remove residuo "R$" do fim da descricao
                    descricao = re.sub(r'\s*(?:R\$|\$)\s*$', '', descricao).strip()
                    if descricao:
                        valor = _parse_valor(m_valor.group(1))
                        if valor is not None:
                            lancamentos_raw.append({
                                'data': m_data.group(1),
                                'descricao': descricao,
                                'valor': valor,
                            })

    # Classsificacao: distribui lancamentos entre subcategorias e fora-grupo
    # subcategorias_extraidas: id_subcat -> list[dict(data, descricao, valor)]
    subcategorias_extraidas: dict[str, list[dict]] = defaultdict(list)
    itens_fora_grupo: list[dict] = []
    nao_classificados: list[dict] = []

    for lanc in lancamentos_raw:
        id_subcat, motivo = classificar_subcategoria(lanc['descricao'])
        if id_subcat is not None:
            # Classificado em uma subcategoria
            subcategorias_extraidas[id_subcat].append(lanc)
        elif motivo == 'nao-classificado':
            nao_classificados.append(lanc)
        else:
            # divida-especifica ou obra-extraordinaria
            itens_fora_grupo.append({**lanc, 'motivo': motivo})

    # Monta avisos de itens nao-classificados (amostra de ate 5 descricoes)
    avisos: list[str] = []
    if nao_classificados:
        amostra = ', '.join(
            sorted({l['descricao'] for l in nao_classificados})[:5]
        )
        avisos.append(
            f'{len(nao_classificados)} lancamento(s) nao classificado(s) — '
            f'amostra: {amostra}. Atualize KEYWORDS_POR_SUBCAT em categorias.py.'
        )

    return {
        'condominio': condominio or '[a confirmar]',
        'periodo': periodo or '[a confirmar]',
        'subcategorias_extraidas': dict(subcategorias_extraidas),
        'itens_fora_grupo': itens_fora_grupo,
        'nao_classificados': nao_classificados,
        'avisos': avisos,
    }


# ─── W045A ───────────────────────────────────────────────────────────────

_RE_FRACAO = re.compile(r'(\d+[.,]\d{3,8})')


def parsear_w045a(arquivo: str | BytesIO) -> list[dict[str, Any]]:
    """Extrai pares (unidade, fracao) do W045A.

    Valida que a soma fecha em 1.0 com tolerancia 0.001. Loga warning no
    stderr mas devolve a lista mesmo assim (para inspecao manual).
    """
    unidades: list[dict] = []
    with _abrir_pdf(arquivo) as pdf:
        for pagina in pdf.pages:
            for linha in (pagina.extract_text() or '').split('\n'):
                ls = linha.strip()
                if not ls:
                    continue
                # Linha tipica: "Apto 0101-1   0.038462"  ou  "0101   0,038462"
                m = _RE_FRACAO.search(ls)
                if not m:
                    continue
                fracao_str = m.group(1).replace(',', '.')
                try:
                    fracao = float(fracao_str)
                except ValueError:
                    continue
                # Filtro de sanidade: fracoes de unidade ficam entre 0.0001 e 0.5
                if not (0.0001 <= fracao <= 0.5):
                    continue
                unidade = ls[:m.start()].strip()
                if not unidade:
                    continue
                unidades.append({'unidade': unidade, 'fracao': fracao})

    soma = sum(u['fracao'] for u in unidades)
    if abs(soma - 1.0) > 0.001:
        print(
            f'[parser] soma das fracoes = {soma:.6f} (esperado 1.0 ± 0.001). '
            'Verifique o PDF ou ajuste o filtro em parsear_w045a.',
            file=sys.stderr,
        )
    return unidades


# ─── Montagem da resposta ─────────────────────────────────────────────────

def montar_response(
    dados_w011: dict[str, Any],
    dados_w045: list[dict[str, Any]],
    duracao_ms: int,
) -> PrevisaoResponse:
    """Monta PrevisaoResponse a partir dos dados extraidos dos PDFs.

    Para cada um dos 8 GRUPOS canonicos:
      - Busca subcategorias que pertencem ao grupo via SUBCATEGORIAS[id]['grupo_id'].
      - Grupos sem subcategorias detectadas no PDF recebem 1 subcategoria espelho
        (mesmo id/nome do grupo, lancamentos=[], total=0) — schema uniforme.
      - Consumo e Taxas pode ter ate 3 subcategorias reais; se nenhuma detectada,
        recebe espelho do grupo.

    total_geral = soma de total_anual dos grupos (NAO inclui itens_fora_grupo).
    """
    subcat_extraidas = dados_w011.get('subcategorias_extraidas', {})

    # Calcula total_geral antecipado para peso_pct (dois passes necessarios)
    # 1o passo: soma todos os lancamentos classificados em subcategorias
    total_geral_calc = 0.0
    for id_subcat, lancamentos in subcat_extraidas.items():
        total_geral_calc += sum(l['valor'] for l in lancamentos)

    grupos_montados: list[Grupo] = []

    for defn_grupo in GRUPOS:
        id_grupo = defn_grupo['id']

        # Coleta subcategorias que pertencem a este grupo
        subcats_do_grupo: list[Subcategoria] = []

        for id_subcat, meta in SUBCATEGORIAS.items():
            if meta['grupo_id'] != id_grupo:
                continue

            lancamentos_subcat = subcat_extraidas.get(id_subcat, [])
            if not lancamentos_subcat:
                # Subcategoria sem lancamentos: nao inclui (sera coberta pelo espelho se grupo vazio)
                # Excecao: Consumo e Taxas pode ter 0 subcategorias reais -> espelho cobre
                continue

            total_subcat = round(sum(l['valor'] for l in lancamentos_subcat), 2)
            subcats_do_grupo.append(
                Subcategoria(
                    id=id_subcat,
                    nome=meta['nome'],
                    descritivo=meta['descritivo'],
                    total_anual=total_subcat,
                    rateio=meta['rateio'],
                    lancamentos=[
                        Lancamento(
                            data=l['data'],
                            descricao=l['descricao'],
                            valor=l['valor'],
                        )
                        for l in lancamentos_subcat
                    ],
                )
            )

        # Se nenhuma subcategoria real detectada para este grupo: cria espelho
        if not subcats_do_grupo:
            if id_grupo == 'consumo-taxas':
                # Caso explícito: consumo-taxas vazio recebe espelho com fracao-ideal.
                # Utilidades só faz sentido com rateio uso-real se houver lançamentos
                # de utilidade detectados; sem lançamentos, fracao-ideal é o default
                # semântico correto para o grupo agregado.
                espelho = Subcategoria(
                    id='consumo-taxas',
                    nome='Consumo e Taxas',
                    descritivo=defn_grupo['descritivo'],
                    total_anual=0.0,
                    rateio='fracao-ideal',
                    lancamentos=[],
                )
            else:
                # Subcategoria espelho: mesmo id/nome do grupo, lancamentos vazios
                meta_esp = SUBCATEGORIAS.get(id_grupo)
                if meta_esp:
                    espelho = Subcategoria(
                        id=id_grupo,
                        nome=meta_esp['nome'],
                        descritivo=meta_esp['descritivo'],
                        total_anual=0.0,
                        rateio=meta_esp['rateio'],
                        lancamentos=[],
                    )
                else:
                    # Grupo sem meta (nao deveria ocorrer, mas fallback seguro)
                    espelho = Subcategoria(
                        id=id_grupo,
                        nome=defn_grupo['nome'],
                        descritivo=defn_grupo['descritivo'],
                        total_anual=0.0,
                        rateio='fracao-ideal',
                        lancamentos=[],
                    )
            subcats_do_grupo = [espelho]

        total_anual_grupo = round(sum(s.total_anual for s in subcats_do_grupo), 2)
        total_mensal_grupo = round(total_anual_grupo / 12, 2)
        peso_pct = round(total_anual_grupo / total_geral_calc, 6) if total_geral_calc else 0.0

        grupos_montados.append(
            Grupo(
                id=id_grupo,
                nome=defn_grupo['nome'],
                ordem=defn_grupo['ordem'],
                descritivo=defn_grupo['descritivo'],
                total_anual=total_anual_grupo,
                total_mensal=total_mensal_grupo,
                peso_pct=peso_pct,
                subcategorias=subcats_do_grupo,
            )
        )

    total_geral = round(sum(g.total_anual for g in grupos_montados), 2)
    total_mensal_medio = round(total_geral / 12, 2)

    # Monta itens fora do grupo
    itens_fora: list[ItemForaGrupo] = [
        ItemForaGrupo(
            data=i['data'],
            descricao=i['descricao'],
            valor=i['valor'],
            motivo=i['motivo'],
        )
        for i in dados_w011.get('itens_fora_grupo', [])
    ]

    # Adiciona nao-classificados como fora-grupo com motivo='nao-classificado'
    for nc in dados_w011.get('nao_classificados', []):
        itens_fora.append(
            ItemForaGrupo(
                data=nc['data'],
                descricao=nc['descricao'],
                valor=nc['valor'],
                motivo='nao-classificado',
            )
        )

    # Monta fracoes do W045A
    fracoes: list[Fracao] = [
        Fracao(unidade=u['unidade'], fracao=u['fracao'])
        for u in dados_w045
    ]

    return PrevisaoResponse(
        condominio=dados_w011.get('condominio', '[a confirmar]'),
        periodo=dados_w011.get('periodo', '[a confirmar]'),
        total_geral=total_geral,
        total_mensal_medio=total_mensal_medio,
        moeda='BRL',
        grupos=grupos_montados,
        itens_fora_grupo=itens_fora,
        fracoes=fracoes,
        avisos=dados_w011.get('avisos', []),
        metadados=Metadados(
            parser_versao=PARSER_VERSAO,
            extraido_em=datetime.now(timezone.utc).isoformat(),
            duracao_ms=duracao_ms,
        ),
    )
