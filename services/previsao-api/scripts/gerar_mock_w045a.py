"""Gera PDF W045A mockado com 24 apartamentos + 2 coberturas, soma = 1.0.

A soma das fracoes e ajustada para garantir 1.0 exato com 6 casas decimais.
Usa apenas ASCII nos campos criticos (sem acentos) para evitar corrupcao UTF-8
no round-trip reportlab+pdfplumber — a funcao identificar_tipo_pdf usa lowercase
da extracao do pdfplumber, que pode corromper caracteres multi-byte.

Marcadores que fazem identificar_tipo_pdf retornar 'W045A':
  'w045a' no titulo + 'fracao ideal' no cabecalho da tabela.
"""
from __future__ import annotations

import argparse

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas

# 24 apartamentos com fracao ~0.038462 cada + 2 coberturas com ~0.057692 cada.
# Soma calculada: 24 * 0.038461 + 2 * 0.057692 = 0.923064 + 0.115384 = 1.038448 — incorreto.
# Usar: 22 aptos com 0.038000, 2 aptos menores com 0.036000, 2 coberturas com 0.060000.
# 22*0.038000 + 2*0.036000 + 2*0.060000 = 0.836000 + 0.072000 + 0.120000 = 1.028000 — incorreto.
# Calculo correto para 24 aptos + 2 coberturas = 26 unidades somando 1.0:
# Cobertura = 1.5x apto. Seja x = fracao apto. 24x + 2*1.5x = 1.0 -> 27x = 1.0 -> x = 0.037037
# Cobertura = 0.055556.
# Verificacao: 24 * 0.037037 + 2 * 0.055556 = 0.888888 + 0.111112 = 1.000000 ✓
# Mas acumulo de arredondamento pode desviar. Usar 25 aptos com valor fixo e ajustar o ultimo.

def _calcular_unidades() -> list[tuple[str, float]]:
    """Calcula as fracoes das 26 unidades garantindo soma = 1.0 exato."""
    unidades: list[tuple[str, float]] = []

    # Fracoes base: 24 apartamentos + 2 coberturas, fator cobertura = 1.5x apto
    # x = 1.0 / (24 + 2*1.5) = 1.0 / 27.0
    fracao_apto = round(1.0 / 27.0, 6)         # 0.037037
    fracao_cobertura = round(1.5 / 27.0, 6)    # 0.055556

    # Blocos: 101 a 401 (4 blocos, 6 aptos por bloco = 24 aptos)
    # Coberturas: 501-A e 501-B
    andares = [1, 2, 3, 4, 5, 6]
    blocos = ['A', 'B', 'C', 'D']

    for bloco in blocos:
        for andar in andares:
            nome = f'Apto {andar}0{blocos.index(bloco) + 1}{bloco}'
            unidades.append((nome, fracao_apto))

    unidades.append(('Cobertura 501-A', fracao_cobertura))
    unidades.append(('Cobertura 501-B', fracao_cobertura))

    # Ajusta a ultima unidade para fechar exatamente 1.0
    soma_atual = round(sum(u[1] for u in unidades), 6)
    diferenca = round(1.0 - soma_atual, 6)
    if abs(diferenca) > 0:
        ultima_nome, ultima_fracao = unidades[-1]
        unidades[-1] = (ultima_nome, round(ultima_fracao + diferenca, 6))

    return unidades


UNIDADES = _calcular_unidades()


def gerar_mock(caminho: str) -> None:
    """Gera o PDF W045A mockado com 26 unidades e fracoes somando 1.0."""
    c = canvas.Canvas(caminho, pagesize=A4)
    largura, altura = A4
    y = altura - 2 * cm

    # Cabecalho com marcadores que identificar_tipo_pdf reconhece
    # CRITICO: usar 'W045A' e 'Fracao Ideal' (sem acento) para evitar corrupcao UTF-8
    c.setFont('Helvetica-Bold', 14)
    c.drawString(2 * cm, y, 'W045A - Relatorio de Fracao Ideal')
    y -= 0.6 * cm
    c.setFont('Helvetica', 10)
    c.drawString(2 * cm, y, 'Condominio: Residencial Mock - Teste V8S')
    y -= 0.4 * cm
    c.drawString(2 * cm, y, 'Rateio por Fracao Ideal (fracao ideal por unidade)')
    y -= 0.8 * cm

    # Cabecalho da tabela
    c.setFont('Helvetica-Bold', 10)
    c.drawString(2 * cm, y, 'Unidade')
    c.drawString(10 * cm, y, 'Fracao')
    y -= 0.5 * cm

    c.setFont('Helvetica', 9)
    soma = 0.0
    for nome, fracao in UNIDADES:
        linha_nome = nome
        linha_fracao = f'{fracao:.6f}'
        c.drawString(2 * cm, y, linha_nome)
        c.drawString(10 * cm, y, linha_fracao)
        y -= 0.42 * cm
        soma += fracao
        if y < 3 * cm:
            c.showPage()
            y = altura - 2 * cm
            c.setFont('Helvetica', 9)

    if y < 3 * cm:
        c.showPage()
        y = altura - 2 * cm

    c.setFont('Helvetica-Bold', 10)
    c.drawString(2 * cm, y, f'Total de Unidades: {len(UNIDADES)}')
    y -= 0.4 * cm
    c.drawString(2 * cm, y, f'Soma das Fracoes: {soma:.6f}')
    c.save()
    print(f'OK: {caminho}')
    print(f'  Unidades: {len(UNIDADES)}')
    print(f'  Soma das fracoes: {soma:.6f}')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--saida', default='/tmp/sh_previsao_mock_w045a.pdf')
    args = parser.parse_args()
    gerar_mock(args.saida)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
