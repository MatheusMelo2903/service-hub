# Composição de cada rubrica (modo detalhado)

A composição é a linha embaixo de cada rubrica que responde à pergunta do morador: "o que foi gasto aqui?". Era o que o modelo antigo do escritório trazia entre parênteses ("Material Elétrico (fusíveis, led, conduíte...)"), agora com valores quando faz sentido. Régua de estilo: `exemplo_composicao_buritis.json`.

Ponto de partida: `rascunho.json`, gerado por `extrair.py`, com os itens de cada rubrica do maior para o menor e o valor de cada um. A curadoria só reescreve. Nunca acrescenta item, valor, data ou fornecedor que não esteja no relatório.

## Os três tipos de rubrica

### 1. Contrato ou conta recorrente
Itens iguais todo mês, sem descrição própria (mão de obra, elevador, água, energia, honorários, impostos retidos).
Texto: o que é, mais o número de meses entre parênteses, usando `{n}`. O montador troca `{n}` pela quantidade de meses com lançamento.
Inclua o que foge do normal, com valor: retroativo, 13º, item avulso.
- "Equipe terceirizada, {n} competências, mais retroativo de R$ 14.708,71 pago em dez/25"
- "{n} meses de R$ 6.700,00 mais o 13º honorário pago em dez/25"
- "Contas de luz das áreas comuns: clube, torres A a E, garagem, playground, administração, churrasqueira, estética e bar ({n} meses)"
`"fecha": false` (o texto não lista todos os valores).

### 2. Compras ou serviços distintos (até uns 10 itens diferentes)
Lista "descrição R$ valor", separada por " · ", do maior para o menor. Com `"fecha": true` o montador confere que a soma dos valores citados bate com o total da rubrica.
- Juntar parcelas do mesmo item: "1 de 3, 2 de 3, 3 de 3" vira um item "(3 parcelas)" ou "em 4 parcelas" com a soma.
- Juntar descrições iguais ou quase iguais ("Manut nível co2..." e "Manutenção nivel CO2...") somando os valores.
- Lançamento sem descrição dentro de uma rubrica com itens descritos: "material elétrico diverso R$ 823,55", "serviço em aparelhos R$ 1.120,00".
- Exemplo: "TV para o salão de festas R$ 2.390,00 · bancos R$ 2.022,00 · cadeiras e mesas da piscina R$ 2.016,98 · cadeiras R$ 1.438,70 · tênis de mesa para o salão de jogos e rede de futebol da quadra R$ 859,80"

### 3. Compras repetidas de consumo (muitas notas "e outros")
Limpeza, construção e ferramentas, pintura, decoração de Natal: dezenas de notas parecidas. Valor por nota não diz nada ao morador.
Texto: "N compras no período:" mais a lista de produtos que aparecem nas descrições, sem repetir. Pode destacar as 1 ou 2 maiores com valor. `"fecha": false`.
- "42 compras no período: detergente, saco de lixo, cloro, alvejante, álcool, multiuso, desinfetantes (Altex e Detex), sabonete, papel toalha, papel higiênico, panos de limpeza e microfibra, palha de aço, esponja, rodo, luvas, aromatizante, dispenser de papel e lixeira com pedal"

## Escrita
- Português correto e acentuado. Corrigir a grafia do sistema: "Frrezer" vira freezer, "Scao lixo" vira saco de lixo, "hidraúçicos" vira hidráulicos, "estintor" vira extintor.
- Trocar abreviações: Manut vira manutenção, Subst vira troca, inst vira instalação.
- Minúscula depois do primeiro item; sem ponto final; nenhum hífen ou travessão (usar vírgula, "e" ou " · ").
- Meses abreviados em minúsculo: dez/25, jul/26.
- Curto. A rubrica tem 2 a 4 linhas no máximo; o que passar disso vira lista de produtos (tipo 3).
- Nome da rubrica: o do Superlógica, com grafia arrumada só quando necessário (`montar.py` já conhece os casos comuns; para outros, usar `"nome"` na rubrica).

## Notas de categoria (faixa "ATENÇÃO")
No máximo uma por categoria, só quando antecipa pergunta de assembleia, sempre com números do relatório:
- custo repassado na receita: "Água e gás são rateados e voltam na receita: Água Comum R$ ... e Gás R$ ..."
- custeio próprio: "As atividades esportivas são custeadas pela receita própria delas, R$ ... no período"
- compra que explica pico: "Placa e inversor do elevador (R$ 36.660,00) ... são as maiores compras"
- verba de seguro: "R$ ... em serviços foram pagos com a verba do seguro (indenização de R$ ... recebida em jul/26)"

## Rubricas sinalizadas pelo extrator
Status diferente de `exato` ou `resolvido` (só acontece com W015A de coluna maior que o período): os itens podem incluir algo pago fora do período. Preferir pedir o W015A com as datas exatas. Sem isso, escrever a composição sem valores (`"fecha": false`) e só com itens que aparecem também no período.
