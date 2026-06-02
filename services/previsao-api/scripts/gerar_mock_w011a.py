"""Gera PDF W011A mockado cobrindo os 8 grupos canonicos da previsao orcamentaria.

Ampliado do skill original (skills-server/previsao-orcamentaria/scripts/gerar_mock_w011a.py)
para cobrir TODOS os 8 grupos + subcategorias de Consumo e Taxas (Utilidades,
Retencoes Fiscais, Taxas e Recolhimentos) + itens_fora_grupo.

Saida padrao: /tmp/sh_previsao_mock_w011a.pdf (ou --saida).
Usa apenas ASCII em campos criticos (sem acentos) para evitar corrupcao UTF-8
no round-trip reportlab+pdfplumber.
"""
from __future__ import annotations

import argparse

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas

# Lancamentos organizados por (categoria_label, [(data, descricao_ascii, valor)])
# Descricoes em ASCII puro: pdfplumber pode corromper UTF-8 em alguns ambientes.
LANCAMENTOS: list[tuple[str, list[tuple[str, str, float]]]] = [
    # Grupo 1: Despesas Financeiras
    ('Despesas Financeiras', [
        ('10/05/2025', 'Tarifas Bancarias - Garantidora', 605.00),
        ('10/06/2025', 'Tarifas Bancarias - Garantidora', 605.00),
        ('30/06/2025', 'IRRF Poupanca', 464.77),
    ]),
    # Grupo 2: Funcionarios
    ('Despesa com Funcionarios', [
        ('05/05/2025', 'Contrato Mao de Obra Terceirizada', 49174.18),
        ('05/06/2025', 'Contrato Mao de Obra Terceirizada', 49174.18),
        ('05/07/2025', 'Contrato Mao de Obra Terceirizada', 49174.18),
        ('10/06/2025', 'Cesta Basica - Funcionarios', 1200.00),
    ]),
    # Grupo 3: Administrativa
    ('Despesa Administrativa', [
        ('01/05/2025', 'Honorarios Administradora', 3500.00),
        ('01/06/2025', 'Honorarios Administradora', 3500.00),
        ('15/05/2025', 'Correios - Correspondencias', 120.50),
        ('20/05/2025', 'Cartorio - Reconhecimento Firma', 85.00),
    ]),
    # Grupo 4: Consumo e Taxas — Subcategoria Utilidades (rateio uso-real)
    ('Consumo e Taxas - Utilidades', [
        ('10/05/2025', 'Energia - Areas Comuns', 2345.39),
        ('10/06/2025', 'Energia - Areas Comuns', 2410.00),
        ('10/07/2025', 'Energia - Areas Comuns', 2290.00),
        ('15/05/2025', 'Agua - Areas Comuns', 890.00),
        ('15/06/2025', 'Agua - Areas Comuns', 920.00),
        ('05/05/2025', 'Telefonia Portaria', 189.90),
    ]),
    # Grupo 4: Consumo e Taxas — Subcategoria Retencoes Fiscais
    ('Consumo e Taxas - Retencoes Fiscais', [
        ('05/05/2025', 'ISS Administradora', 175.00),
        ('05/06/2025', 'ISS Administradora', 175.00),
        ('20/06/2025', 'DARF IRRF Folha', 2100.00),
    ]),
    # Grupo 4: Consumo e Taxas — Subcategoria Taxas e Recolhimentos
    ('Consumo e Taxas - Taxas e Recolhimentos', [
        ('10/01/2025', 'IPTU Anual', 1850.00),
        ('15/02/2025', 'Alvara de Funcionamento', 320.00),
        ('20/03/2025', 'ART - CREA Engenheiro', 210.00),
    ]),
    # Grupo 5: Manutencao
    ('Manutencao', [
        ('15/05/2025', 'Contrato Manutencao Elevador', 1452.79),
        ('15/06/2025', 'Contrato Manutencao Elevador', 1452.79),
        ('15/05/2025', 'Contrato Manutencao Piscina', 1507.00),
        ('15/06/2025', 'Contrato Manutencao Piscina', 1507.00),
        ('20/05/2025', 'Manutencao Jardinagem', 814.58),
    ]),
    # Grupo 6: Aquisicao de Materiais
    ('Aquisicao de Materiais', [
        ('12/05/2025', 'Material de Limpeza', 1582.48),
        ('12/06/2025', 'Material de Limpeza', 1420.00),
        ('20/06/2025', 'Material Eletrico', 426.29),
        ('05/07/2025', 'Tags Controle Acesso', 287.50),
    ]),
    # Grupo 7: Equipamentos
    ('Equipamentos', [
        ('10/04/2025', 'Ferramentas Manutencao', 650.00),
        ('15/04/2025', 'Eletrodomestico Portaria', 1200.00),
    ]),
    # Grupo 8: Servicos
    ('Servicos', [
        ('25/05/2025', 'Seguro Condominial', 550.18),
        ('10/06/2025', 'Sistema de Incendio', 890.00),
    ]),
    # Itens fora do grupo (nao entram no rateio padrao)
    ('Itens Fora do Rateio', [
        ('01/06/2025', 'Emprestimo Energia Solar parcela', 7452.58),
        ('15/06/2025', 'Obras Extraordinarias Fachada', 15000.00),
    ]),
]


def _fmt_brl(v: float) -> str:
    """Formata valor float para o padrao BRL do Superlogica (R$ 1.234,56)."""
    s = f'{v:,.2f}'
    return 'R$ ' + s.replace(',', 'X').replace('.', ',').replace('X', '.')


def gerar_mock(caminho: str) -> None:
    """Gera o PDF W011A mockado com todos os grupos e lancamentos."""
    c = canvas.Canvas(caminho, pagesize=A4)
    largura, altura = A4
    y = altura - 2 * cm

    # Cabecalho com marcadores que identificar_tipo_pdf reconhece
    c.setFont('Helvetica-Bold', 14)
    c.drawString(2 * cm, y, 'W011A - Demonstrativo de Despesas')
    y -= 0.6 * cm
    c.setFont('Helvetica', 10)
    c.drawString(2 * cm, y, 'Condominio: Residencial Mock - Teste V8S')
    y -= 0.4 * cm
    c.drawString(2 * cm, y, 'Periodo: Mai/2025 a Abr/2026')
    y -= 0.4 * cm
    c.drawString(2 * cm, y, 'Lancamentos do Periodo: 12 meses')
    y -= 0.8 * cm

    total_geral = 0.0
    for categoria, itens in LANCAMENTOS:
        # Verifica espaco na pagina para o cabecalho da categoria
        if y < 4 * cm:
            c.showPage()
            y = altura - 2 * cm

        c.setFont('Helvetica-Bold', 11)
        c.drawString(2 * cm, y, categoria)
        y -= 0.5 * cm
        subtotal = 0.0
        c.setFont('Helvetica', 9)
        for data, descricao, valor in itens:
            linha = f'{data}   {descricao}   {_fmt_brl(valor)}'
            c.drawString(2.4 * cm, y, linha)
            y -= 0.42 * cm
            subtotal += valor
            if y < 3 * cm:
                c.showPage()
                y = altura - 2 * cm
                c.setFont('Helvetica', 9)

        c.setFont('Helvetica-Bold', 9)
        c.drawString(2.4 * cm, y, f'Subtotal {categoria}: {_fmt_brl(subtotal)}')
        y -= 0.7 * cm
        total_geral += subtotal

    if y < 3 * cm:
        c.showPage()
        y = altura - 2 * cm

    c.setFont('Helvetica-Bold', 12)
    c.drawString(2 * cm, y, f'TOTAL GERAL: {_fmt_brl(total_geral)}')
    c.save()
    print(f'OK: {caminho}')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--saida', default='/tmp/sh_previsao_mock_w011a.pdf')
    args = parser.parse_args()
    gerar_mock(args.saida)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
