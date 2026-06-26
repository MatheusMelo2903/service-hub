# TAREFA (FUTURO, sob demanda): suporte a W011A classe Loja Maconica

## Status: NAO bloqueante. Sem demanda atual. Escopada de fora em 2026-06-26.

## O que e
A "AUGUSTA E RESPEITAVEL LOJA SIMBOLICA" (Loja Maconica) gera um W011A com estrutura
de DOIS NIVEIS, diferente do W011A de condominio:
- Super-grupos: "Despesas Ordinarias", "Despesas Extraordinarias", "Despesas Financeiras"
  que CONTEM sub-grupos.
- Sub-grupos com cabecalho em title-case (nao CAIXA ALTA) e fora do MAPA_CATEGORIA
  (ex "Grande Loja Maconica", "Contabilidade", "Hospitalaria", "Per capta",
  "Despesas do Veneravel Mestre").
- Subtotais aninhados: "Total de Despesas Ordinarias" e um super-total que soma varios
  sub-grupos, alem dos sub-totais de cada sub-grupo.

O parser do Service Hub foi construido para a taxonomia de CONDOMINIO (cabecalhos
CAIXA ALTA no MAPA_CATEGORIA, um nivel). Na Loja, nenhum cabecalho e reconhecido e a
soma de grupos da zero.

## Decisao (2026-06-26)
Caminho 2: escopar a Loja de fora por ora. O parser DETECTA a classe Loja pelo sinal
estrutural "Ordinarias/Extraordinarias" (condominio nunca tem) e cai em 422 ESPECIFICO:
"estrutura hierarquica de dois niveis nao suportada (classe Loja Maconica:
super-grupos Ordinarias/Extraordinarias)". Nunca um 422 generico, pra o Matheus saber
na hora que e o caso da hierarquia e abrir sessao dedicada, nao achar que e bug.

O que importava da Augusta (nome de condominio extenso, fragmento de categoria) JA foi
capturado no Passo 1 da robustez (rodape por repeticao + fragmento por continuacao).

## Quando precisar processar a Loja (sessao dedicada)
- Decidir qual nivel da hierarquia vira "categoria" no deck (sub-grupos ou super-grupos).
- Parsing hierarquico: distinguir super-total (Ordinarias) de sub-total (Grande Loja).
- Cabecalhos title-case fora do MAPA: reconhecer grupo por "Total de <nome>" estrutural,
  nao por CAIXA ALTA + MAPA.
- Manter Praia Dourada e Quattro byte-identicos (taxonomia condominio intacta).

## Fixture
tests/fixtures_local/w011a_augusta_*.pdf (gitignored, dado real de exemplo).
