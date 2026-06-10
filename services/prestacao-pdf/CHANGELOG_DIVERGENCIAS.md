# Divergências deliberadas — engine vs deck de referência do Naturale

A engine de prestação de contas reproduz o template da skill, mas diverge de
propósito do deck manual de referência nos pontos abaixo. Em todos eles o
valor da engine é derivável linha a linha do W016A; o do deck manual não.
Rastreabilidade pra quando o Matheus comparar com um deck montado à mão.

## Correções de valor (o deck manual continha erro)

1. **Serviços (bloco anual):** Segurança Eletrônica R$ 2.242,50
   (= 300,00 + 549,50 + 549,50 + 549,50 + 294,00) e "Demais serviços" como
   resíduo. No deck manual, 2.242,00 + 8.702,09 somavam R$ 0,40 a menos que
   o total da categoria. A validação de soma de lançamentos (nova) pega isso.
2. **Financeiras (bloco anual):** Devoluções e Reembolsos de Reservas
   R$ 310,54 (= 31,05 + 62,11 + 93,16 + 62,11 + 62,11) e assinatura de
   e-mail mais cotas de capital R$ 149,99 (= 99,99 + 50,00). O deck manual
   imprimia 410,54 e 49,99 (R$ 100,00 trocados entre as duas linhas).
3. **Serviços (bloco de transição):** Elétrico R$ 3.754,64 e Serralheria
   R$ 3.500,00, somas exatas das linhas do W016A. O deck manual mostrava
   4.314,64 e 4.200,00, valores não deriváveis do relatório (compensados
   silenciosamente em Manutenção e Demais).
4. **Receitas (bloco de transição):** Demais Receitas com 2,8%
   (15.290,28 / 550.871,89 = 2,776%). O deck manual arredondava 2,7%.

## Correções de ordem

5. **Maior→menor estrita com resíduo no fim, em toda lista.** O deck manual
   tinha a Taxa Extra AGE (18,3%) na 4ª posição das receitas da transição e
   três inversões nas tabelas de lançamentos (Seguro/Manutenção,
   Locação/Reforma, Elétrico/Comunicação Visual).

## Diferenças de agrupamento (regra determinística da skill)

6. **Pessoal (transição):** mão de obra em uma linha "(3 competências)",
   não três linhas separadas — padrão de competência da skill.
7. **Investimento (transição):** parcelas 1 e 2 do contêiner fundidas numa
   linha (R$ 4.340,00).
8. **Financeiras (transição):** reembolsos de reserva fundidos (R$ 76,00).
9. **Materiais (transição):** Portão (97,81) e Interfone (89,91) separados;
   o deck manual fundia em "Portão e Interfone" (187,72).
10. **Pessoal (anual):** Alimentação e Lanche (3.036,86) e Padaria (1.029,49)
    separados; o deck manual fundia (4.066,35).
11. **Retenções (anual):** prestadores com 0,9% ou mais do total nomeados
    (Condonal 9.033,48, ABC 2.988,21, Vitam 1.640,33 + demais 2.487,50);
    o deck manual lumpava tudo em uma linha (16.149,52).
12. **Serviços (anual):** as 19 maiores rubricas nomeadas; entra Serviço de
    Reparo (2.003,60), saem Vistoria (1.230,00) e Portão (1.418,15) pro
    resíduo, que fecha em 7.928,39 (deck manual: 8.701,99).
13. **Serviços (transição):** as 19 rubricas cabem na tabela e são todas
    nomeadas; o deck manual usava 10 + Demais.

Os totais de categoria, totais gerais e saldos são idênticos em todos os
casos; as quatro igualdades de consistência passam, e a soma das linhas de
cada slide fecha exatamente com o total da categoria.
