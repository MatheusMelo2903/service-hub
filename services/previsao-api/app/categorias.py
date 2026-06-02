"""Definicoes canonicas de grupos, subcategorias e keywords para classificacao.

Este modulo e a fonte de verdade do mapeamento de lancamentos do W011A
para os 8 grupos canonicos da previsao orcamentaria. Qualquer ajuste de
keyword ou novo grupo deve ser feito aqui — o parser consome este modulo.

Ordem das 8 entradas em GRUPOS segue a decisao produto de 2026-06-01 (Matheus).
"""
from __future__ import annotations

# ─── Grupos canonicos ─────────────────────────────────────────────────────

# Cada entrada: id (slug), nome legivel, ordem (1-based), descritivo curto.
GRUPOS: list[dict] = [
    {
        'id': 'despesas-financeiras',
        'nome': 'Despesas Financeiras',
        'ordem': 1,
        'descritivo': 'Tarifas bancarias, IRRF, IOF e demais custos financeiros do condominio.',
    },
    {
        'id': 'funcionarios',
        'nome': 'Despesa com Funcionarios',
        'ordem': 2,
        'descritivo': 'Mao de obra, salarios, encargos sociais, vale transporte e cesta basica.',
    },
    {
        'id': 'administrativa',
        'nome': 'Despesa Administrativa',
        'ordem': 3,
        'descritivo': 'Honorarios da administradora, correios, cartorios e despesas de escritorio.',
    },
    {
        'id': 'consumo-taxas',
        'nome': 'Consumo e Taxas',
        'ordem': 4,
        'descritivo': 'Utilidades de uso real, retencoes fiscais e taxas e recolhimentos publicos.',
    },
    {
        'id': 'manutencao',
        'nome': 'Manutencao',
        'ordem': 5,
        'descritivo': 'Contratos de manutencao preventiva e corretiva de equipamentos e areas comuns.',
    },
    {
        'id': 'aquisicao-materiais',
        'nome': 'Aquisicao de Materiais',
        'ordem': 6,
        'descritivo': 'Material de limpeza, eletrico, controle de acesso e insumos de manutencao.',
    },
    {
        'id': 'equipamentos',
        'nome': 'Equipamentos',
        'ordem': 7,
        'descritivo': 'Compra de equipamentos, eletrodomesticos, informatica e utensilios do condominio.',
    },
    {
        'id': 'servicos',
        'nome': 'Servicos',
        'ordem': 8,
        'descritivo': 'Seguro condominial, sistema de incendio, obras de melhoria e servicos contratados.',
    },
]

# ─── Subcategorias ────────────────────────────────────────────────────────

# Mapeamento: id_subcat -> {nome, descritivo, grupo_id, rateio}
# Grupos sem subdivisao natural recebem 1 subcategoria "espelho" com mesmo id/nome do grupo.
# Consumo e Taxas tem 3 subcategorias possiveis: utilidades, retencoes-fiscais, taxas-recolhimentos.
SUBCATEGORIAS: dict[str, dict] = {
    'despesas-financeiras': {
        'nome': 'Despesas Financeiras',
        'descritivo': 'Tarifas bancarias, IRRF sobre poupanca, IOF e reembolsos financeiros.',
        'grupo_id': 'despesas-financeiras',
        'rateio': 'fracao-ideal',
    },
    'funcionarios': {
        'nome': 'Despesa com Funcionarios',
        'descritivo': 'Contratos de mao de obra, salarios, encargos e beneficios trabalhistas.',
        'grupo_id': 'funcionarios',
        'rateio': 'fracao-ideal',
    },
    'administrativa': {
        'nome': 'Despesa Administrativa',
        'descritivo': 'Honorarios, correios, cartorios, multas e despesas de gestao condominial.',
        'grupo_id': 'administrativa',
        'rateio': 'fracao-ideal',
    },
    # Subcategorias de Consumo e Taxas (3 possiveis)
    'utilidades': {
        'nome': 'Utilidades',
        'descritivo': 'Energia, agua, telefonia e gas das areas comuns — rateados por uso real.',
        'grupo_id': 'consumo-taxas',
        'rateio': 'uso-real',
    },
    'retencoes-fiscais': {
        'nome': 'Retencoes Fiscais',
        'descritivo': 'ISS, DARF, IRRF folha e outras retencoes tributarias na fonte.',
        'grupo_id': 'consumo-taxas',
        'rateio': 'fracao-ideal',
    },
    'taxas-recolhimentos': {
        'nome': 'Taxas e Recolhimentos',
        'descritivo': 'IPTU, alvara de funcionamento, ART CREA e demais taxas publicas.',
        'grupo_id': 'consumo-taxas',
        'rateio': 'fracao-ideal',
    },
    'manutencao': {
        'nome': 'Manutencao',
        'descritivo': 'Contratos de manutencao de elevador, piscina, jardim e equipamentos.',
        'grupo_id': 'manutencao',
        'rateio': 'fracao-ideal',
    },
    'aquisicao-materiais': {
        'nome': 'Aquisicao de Materiais',
        'descritivo': 'Material de limpeza, eletrico, tags de controle de acesso e ferramentas.',
        'grupo_id': 'aquisicao-materiais',
        'rateio': 'fracao-ideal',
    },
    'equipamentos': {
        'nome': 'Equipamentos',
        'descritivo': 'Eletrodomesticos, informatica, maquinas e equipamentos do condominio.',
        'grupo_id': 'equipamentos',
        'rateio': 'fracao-ideal',
    },
    'servicos': {
        'nome': 'Servicos',
        'descritivo': 'Seguro condominial, sistema de incendio e servicos especializados contratados.',
        'grupo_id': 'servicos',
        'rateio': 'fracao-ideal',
    },
}

# ─── Keywords por subcategoria ────────────────────────────────────────────

# Ordem das chaves importa: match na primeira subcategoria cujas keywords casam.
# Match por substring lower-case na descricao do lancamento.
# Fonte: CATEGORIA_KEYWORDS do parser_superlogica.py (skill standalone, nao tocar).
# Excecoes documentadas no plano produto 2026-06-01:
#   - "Investimento e Equipamentos" -> keywords movidas para 'equipamentos'
#   - "Retencoes Fiscais" -> id virou 'retencoes-fiscais'
#   - "Taxas e Recolhimentos" -> id virou 'taxas-recolhimentos'
#   - "Utilidades" -> NOVA subcat com keywords de uso real (saem de PADROES_FORA_RATEIO)
# IMPORTANTE: Verificar 'taxas-recolhimentos' antes de 'retencoes-fiscais' pra evitar
# que "taxa" case em fiscal antes de checar taxas publicas.
KEYWORDS_POR_SUBCAT: dict[str, list[str]] = {
    'despesas-financeiras': [
        'tarifa banc', 'tarifas banc', 'irrf poupan', 'iof', 'reembolso',
        'cotas de capital', 'devolucao pagamento', 'taxa antecipacao',
        'taxa antecipacao',
    ],
    'funcionarios': [
        'mao de obra', 'mao de obra', 'salar', 'salar', 'encargo',
        'inss patronal', 'cesta basica', 'cesta basica', 'vale transporte',
        'alimentacao', 'alimentacao', 'padaria',
    ],
    'administrativa': [
        'honorario', 'honorario', 'cartorio', 'cartorio', 'correios',
        'material de expediente', 'custas processuais', 'multa', 'penalidade',
        'deslocamento', 'comissao de cobranca', 'comissao de cobranca',
    ],
    # Utilidades antes das outras de consumo-taxas para capturar uso-real primeiro
    'utilidades': [
        'energia', 'agua individual', 'agua individual', 'agua-esgoto',
        'agua-esgoto', 'agua e esgoto', 'agua e esgoto', 'telefone',
        'telefonia', 'internet', 'gas individual', 'gas individual',
        'cesan', 'edp', 'enel',
        # Areas comuns: agua e gas das areas comuns vao para uso-real
        'agua - areas', 'agua areas', 'gas - areas', 'gas areas',
        # Variantes com acento (pdfplumber pode extrair com ou sem acento)
        'água individual', 'água-esgoto', 'água e esgoto',
        'gás individual', 'água - areas', 'gás - areas',
    ],
    'retencoes-fiscais': [
        'iss', 'darf', 'irrf', 'pis cofins', 'csll', 'das simples',
    ],
    # taxas-recolhimentos com keywords especificas de taxas publicas
    'taxas-recolhimentos': [
        'art -', 'art–', 'conselho regional', 'alvara', 'alvara', 'iptu',
        'taxa de condominio', 'recolhimento',
    ],
    'manutencao': [
        'contrato manut', 'contrato cx.', 'manutencao elevador',
        'manutencao piscina', 'manutencao bombas', 'manutencao seguranca',
        'manutencao jardinagem', 'manutencao desinsetizac',
        'manutencao ete', 'manutencao seguranca eletroni',
        'cftv', 'fossa e esgo',
        # Variantes com acento
        'manutenção elevador', 'manutenção piscina',
        'manutenção bombas', 'manutenção segurança',
        'manutenção jardinagem', 'contrato manuten',
    ],
    'aquisicao-materiais': [
        'material', 'tags', 'ferramentas', 'materiais obras',
    ],
    'equipamentos': [
        'movel', 'movel', 'utensilio', 'utensilio', 'informatica',
        'informatica', 'eletrodom', 'maquina', 'maquina', 'equipamento',
        'container de lixo',
        # Variantes com acento
        'móvel', 'utensílio', 'informática', 'máquina',
    ],
    'servicos': [
        'seguro condom', 'servico', 'servico', 'obras-melhorias',
        'obras e melhorias', 'sistema de incendio', 'sistema de incendio',
        # Variantes com acento
        'serviço', 'sistema de incêndio',
    ],
}

# ─── Padroes fora do grupo ────────────────────────────────────────────────

# Lancamentos que NAO entram no rateio condominial padrao.
# Emprestimos: divida especifica. Obras extras: obra extraordinaria.
# Nota: energia/agua de areas comuns SAIU daqui em 2026-06-01 e virou 'utilidades'.
PADROES_FORA_GRUPO: dict[str, list[str]] = {
    'divida-especifica': [
        'empréstimo', 'emprestimo',
    ],
    'obra-extraordinaria': [
        'obras extraordinárias', 'obras extraordinarias',
        'materiais obras-melhorias',
    ],
}


def classificar_subcategoria(descricao: str) -> tuple[str | None, str]:
    """Classifica um lancamento numa subcategoria ou motivo-fora-grupo.

    Logica em 2 passos:
      1. Checa PADROES_FORA_GRUPO (retorna None + motivo como string).
      2. Checa KEYWORDS_POR_SUBCAT em ordem declarada.
      3. Se nada casar, retorna (None, 'nao-classificado').

    Retorna:
        (id_subcat, '') quando classificado em subcategoria.
        (None, motivo) quando fora de grupo ou nao classificado.
    """
    s = (descricao or '').lower()

    # Passo 1: verifica se eh item fora de grupo (divida ou obra extraordinaria)
    for motivo, keywords in PADROES_FORA_GRUPO.items():
        if any(kw in s for kw in keywords):
            return (None, motivo)

    # Passo 2: tenta casar com uma subcategoria pelo match de keywords
    for id_subcat, keywords in KEYWORDS_POR_SUBCAT.items():
        if any(kw in s for kw in keywords):
            return (id_subcat, '')

    # Passo 3: nao classificado — o parser vai gerar aviso
    return (None, 'nao-classificado')
