# Divergências deliberadas — engine vs deck de referência do Naturale

A engine de prestação de contas reproduz o template da skill, mas diverge de
propósito do deck manual de referência nos pontos abaixo. Em todos eles o
valor da engine é derivável linha a linha do W016A; o do deck manual não.
Rastreabilidade pra quando o Matheus comparar com um deck montado à mão.

> Política vigente (decisão de produto, 2026-06): **fidelidade total** —
> todas as rubricas distintas de cada categoria de despesa são nomeadas,
> maior→menor, após o agrupamento legítimo por rubrica repetida, competência
> e parcela. Sem teto e sem "as N maiores"; o que não cabe num slide é
> paginado em "(continuação)". "Demais" só existe na lista de Origem da
> Receita (cauda curta do molde da skill).

## Correções de valor (o deck manual continha erro)

1. **Serviços (bloco anual):** Segurança Eletrônica R$ 2.242,50
   (= 300,00 + 549,50 + 549,50 + 549,50 + 294,00). No deck manual, as linhas
   da categoria somavam R$ 0,40 a menos que o total. A validação de soma de
   lançamentos (nova) pega isso em toda geração.
2. **Financeiras (bloco anual):** Devoluções e Reembolsos de Reservas
   R$ 310,54 (= 31,05 + 62,11 + 93,16 + 62,11 + 62,11). O deck manual
   imprimia 410,54 e 49,99 (R$ 100,00 trocados entre linhas). Com fidelidade
   total, assinatura de e-mail (99,99) e cotas de capital (50,00) aparecem
   como rubricas próprias.
3. **Serviços (bloco de transição):** Elétrico R$ 3.754,64 e Serralheria
   R$ 3.500,00, somas exatas das linhas do W016A. O deck manual mostrava
   4.314,64 e 4.200,00 (R$ 1.260,00 deslocados entre rubricas, compensados
   em Manutenção e na cauda para fechar o total).
4. **Receitas (bloco de transição):** Demais Receitas com 2,8%
   (15.290,28 / 550.871,89 = 2,776%). O deck manual arredondava 2,7%.

## Correções de ordem

5. **Maior→menor estrita em toda lista.** O deck manual tinha a Taxa Extra
   AGE (18,3%) na 4ª posição das receitas da transição e três inversões nas
   tabelas de lançamentos.

## Diferenças de agrupamento e granularidade (regras determinísticas)

6. **Competência e parcela:** rubrica repetida vira uma linha — mão de obra
   da transição em "(3 competências)" (deck manual: 3 linhas), parcelas do
   contêiner fundidas (4.340,00; deck manual: 2 linhas), reembolsos de
   reserva fundidos (76,00 na transição; deck manual: 2 linhas).
7. **Rótulo de competências é contado do relatório:** mão de obra anual =
   "(11 competências + ajustes)" — o W016A não tem competência 12/2025
   (encerramento e novo contrato no meio do exercício). O deck manual dizia
   "12 competências".
8. **Fidelidade total na granularidade:** todos os prestadores de ISS
   nomeados (deck manual lumpava em "ISS sobre NFs de prestadores"); as 32
   rubricas de Serviços do bloco anual nomeadas em dois slides paginados
   (deck manual: 19 nomeadas + "Demais"); Portão (97,81) e Interfone (89,91)
   separados; Alimentação e Lanche (3.036,86) e Padaria (1.029,49) separados.

Os totais de categoria, totais gerais e saldos são idênticos em todos os
casos; as quatro igualdades de consistência passam, e a soma das linhas de
cada categoria fecha exatamente com o total — inclusive através de páginas.
