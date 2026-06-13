# Aprendizados e Iterações

## Evolução até o molde atual

- **v7 a v10:** construção do design (cards, faixa âmbar, detalhamento card+tabela, encerramento com 2 linhas). Documentado nas versões anteriores.
- **v11 (atual) — data-driven + 2 referências:** o molde virou totalmente parametrizado. Validado contra os dois PDFs aprovados (Reserva Verde semestral e Maçonaria multi-bloco com certidões). Tudo passou para o bloco CONFIG; o corpo do script gera N categorias, N fontes, blocos e certidões automaticamente.

## Decisões travadas com o Matheus (não reabrir)

- **Um slide por categoria, sempre.** 10 categorias = 10 slides. Sem agrupar, cortar ou completar.
- **Fidelidade extrema ao relatório.** O documento sai fiel ao W011A/W015A. Só muda por instrução explícita. Nunca inventar/estimar.
- **Extração direta do Superlógica.** O fluxo assume PDF/planilha do W011A/W015A como entrada.
- **Logo Grupo Service na capa** (aprovado, inclusive em material de cliente externo).
- **Período flexível.** Nunca assumir 12 meses nem "2025". Tudo derivado.

## Preferências (sempre / nunca)

Sempre: números BR (vírgula decimal), percentuais com vírgula, conversão final pra PDF, fundo branco interno, rodapé institucional, acentuação correta.

Nunca: traços longos em texto corrido, emoji sem pedir, vermelho/laranja em categoria de despesa, badge competindo com título, lançamento zerado em categoria de lançamento direto.

## Como gerar para um novo condomínio

1. Receber o W011A/W015A.
2. Extrair tudo para o bloco CONFIG do `template_prestacao.py`: identificação, período, saldos, série mensal (se houver), receitas_cat, despesas_cat, detalhes por categoria, blocos e certidões (se houver).
3. Rodar o script. As validações de consistência param a execução se algo não bater.
4. Converter pra PDF e revisar visualmente (capa, visão geral, estrutura, 1-2 detalhamentos, encerramento).
5. Entregar PDF + PPTX.

## Armadilhas técnicas

- **Vírgula vira ponto em thumbnail de baixa resolução** do LibreOffice. É render, não bug. No PPTX/PDF reais aparece vírgula.
- **Gráfico some no WhatsApp se enviar PPTX.** Sempre PDF.
- **Aritmética Emu:** converter pra emu uma vez, fazer aritmética em int, voltar com `Emu(int_value)`.
- **Altura de linha adaptativa:** `line_h = max((4.30" - 0.55") / n, 0.26")`. Fonte adaptativa por nº de itens.
- **cat_colors(n)** interpola para qualquer N de categorias; não depende de lista fixa.
- **Sem série mensal:** o script omite Evolução e Superávit Mensal e usa barras comparativas. Não forçar gráfico mensal.

## Validações obrigatórias (no script, param se falhar)

```python
assert abs(SALDO_ANT + REC_TOTAL - DESP_TOTAL - saldo_final) < 1.0
assert abs(sum(receitas_cat) - REC_TOTAL) < 1.0
assert abs(sum(despesas_cat) - DESP_TOTAL) < 1.0
# e conferir cada conjunto de subcategorias contra o total da categoria
```
Se falhar: parar, mostrar a inconsistência, não gerar. Preferível perguntar a inventar.
