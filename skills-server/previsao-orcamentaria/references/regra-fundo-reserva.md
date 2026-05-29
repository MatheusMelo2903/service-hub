# A regra do Fundo de Reserva

A regra mais importante desta skill, e a que mais gera dúvida nas assembleias.

## Como o fundo entra na conta (e como NÃO entra)

A planilha-padrão da Virtual Service tem três valores no resumo:

```
Despesa Total Anual Prevista:        R$ X
Fundo de Reserva (5%):               R$ Y = 5% de X
Total a Ratear (Despesa + Fundo):    R$ X + R$ Y
```

E logo abaixo, calcula a "Taxa Mensal por Apartamento" como:

```
Taxa = (X + Y) / 12 / Unidades Equivalentes
```

Esta conta está somando o fundo no rateio. A skill NÃO faz isso.

A skill aplica:

```
Taxa = X / 12 / Unidades Equivalentes
```

## Por quê

O fundo de reserva é uma reserva financeira já constituída do condomínio. Ele existe como uma poupança institucional para imprevistos e obras. Quando o condomínio tem fundo formado, a despesa operacional cobre a operação normal e o fundo cobre o que aparecer fora dela.

Somar o fundo no rateio é o equivalente a cobrar os condôminos para manter o fundo abastecido todo mês, o que não é a finalidade. O fundo aparece na apresentação apenas como informação institucional ("o condomínio tem R$ X de reserva, intocável, fora da taxa").

## Como explicar na assembleia

Se algum morador perguntar "mas a planilha mostra R$ 1.491 e a apresentação mostra R$ 1.420":

> A planilha traz dois cenários: com o fundo somado e sem. A taxa que cobramos é
> a versão sem o fundo, porque o fundo é uma reserva já existente do condomínio
> e não precisa ser cobrada mensalmente. A apresentação mostra a taxa real que
> entra no boleto.

## Quando reabrir essa decisão

Se em algum condomínio específico fizer sentido reconstituir o fundo (porque ele foi usado ou está abaixo do mínimo legal de 10%, por exemplo), aí entra como rubrica explícita de despesa na previsão, não como soma escondida no rateio.

Nesse caso, criar uma linha de despesa "Reconstituição do Fundo de Reserva" dentro da categoria Despesas Financeiras (ou similar), e ela vira parte da Despesa Operacional Prevista normalmente.

## O que NUNCA fazer

Somar fundo na fórmula de taxa. Apresentar a taxa "com fundo" como se fosse a oficial. Tirar o card de fundo da Visão Geral (ele aparece sim, mas como informacional). Apagar a linha "Não compõe o rateio" do slide de metodologia.
