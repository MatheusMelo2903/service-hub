"""Gera um PDF W011A mockado com estrutura realística para testar o parser.

Saída padrão: /tmp/mock_w011a.pdf (ou --saida).

Inclui 5 categorias com 3 lançamentos cada, subtotais por categoria e total
geral. Texto formatado como o Superlógica emite (data DD/MM/AAAA + descrição +
valor BR R$ 1.234,56).
"""
from __future__ import annotations

import argparse

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas


LANCAMENTOS = [
    ('Despesa com Funcionários', [
        ('05/05/2025', 'Contrato Mão de Obra Terceirizada', 49174.18),
        ('05/06/2025', 'Contrato Mão de Obra Terceirizada', 49174.18),
        ('05/07/2025', 'Contrato Mão de Obra Terceirizada', 49174.18),
    ]),
    ('Despesas Financeiras', [
        ('10/05/2025', 'Tarifas Bancárias - Garantidora', 605.00),
        ('10/06/2025', 'Tarifas Bancárias - Garantidora', 605.00),
        ('30/06/2025', 'IRRF Poupança', 464.77),
    ]),
    ('Manutenção', [
        ('15/05/2025', 'Contrato Manutenção Elevador', 1452.79),
        ('15/06/2025', 'Contrato Manutenção Piscina', 1507.00),
        ('15/07/2025', 'Contrato Manutenção Jardinagem', 814.58),
    ]),
    ('Aquisição de Materiais', [
        ('12/05/2025', 'Material de Limpeza', 1582.48),
        ('20/06/2025', 'Material Elétrico', 426.29),
        ('05/07/2025', 'Tags - Controle de Acesso', 287.50),
    ]),
    ('Serviços (categoria + fora rateio)', [
        ('25/05/2025', 'Seguro Condominial', 550.18),
        ('10/06/2025', 'Energia - Áreas Comuns', 2345.39),
        ('10/06/2025', 'Empréstimo Energia Solar', 7452.58),
    ]),
]


def _fmt_brl(v: float) -> str:
    s = f'{v:,.2f}'
    return 'R$ ' + s.replace(',', 'X').replace('.', ',').replace('X', '.')


def gerar_mock(caminho: str) -> None:
    c = canvas.Canvas(caminho, pagesize=A4)
    largura, altura = A4
    y = altura - 2 * cm

    c.setFont('Helvetica-Bold', 14)
    c.drawString(2 * cm, y, 'W011A - Demonstrativo de Despesas')
    y -= 0.6 * cm
    c.setFont('Helvetica', 10)
    c.drawString(2 * cm, y, 'Condomínio: Naturale Residence Mock')
    y -= 0.4 * cm
    c.drawString(2 * cm, y, 'Período: Mai/2025 a Abr/2026')
    y -= 0.8 * cm

    total_geral = 0.0
    for categoria, itens in LANCAMENTOS:
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

    c.setFont('Helvetica-Bold', 12)
    c.drawString(2 * cm, y, f'TOTAL GERAL: {_fmt_brl(total_geral)}')
    c.save()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--saida', default='/tmp/mock_w011a.pdf')
    args = parser.parse_args()
    gerar_mock(args.saida)
    print(f'OK: {args.saida}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
