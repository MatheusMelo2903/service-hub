# Prestação de contas — reconciliação consciente de janela (Frente 2)

Status: DESENHO REGISTRADO. Não implementar ainda. Aguardando conclusão da Frente 1
(popular `saldo_anterior` no W011A) e o print da instrumentação que crava a célula.

## Contexto do achado (Vila Gardenia, 155)

Três arquivos do mesmo exercício, janelas diferentes:

| Fonte | Janela | Origem da diferença |
|---|---|---|
| W011A | 01/07/2025 a 30/06/2026 | exercício fecha em junho |
| W016A | 01/07/2025 a 30/06/2026 | exercício fecha em junho |
| W015A | 01/08/2025 a 30/07/2026 | atalho "últimos doze meses" arrastou o mês corrente |

O exercício contábil do Vila Gardenia fecha em **JUNHO**. O W015A vai até Jul/2026, logo
é o desalinhado. Ele nasce assim **por design do Superlógica, não por erro do operador**:
o atalho "últimos doze meses" arrasta o mês corrente. O parser vai encontrar essa
situação **o tempo todo, em todo condomínio, sempre que alguém usar o caminho rápido**.
Isso é um caso NORMAL, não uma exceção.

Consequência numérica já prevista: o `saldo_final` do W015A (78.393,15) difere do W016A
(6.507,63) em 71.885,52, que é 91,7%. Esse 91,7% **não é divergência: é o mês de julho**.
Comparar o saldo de junho com o de julho é comparar coisas incomparáveis.

## PRINCÍPIO

> Janela diferente NÃO é divergência. É metadado. O sistema lê a janela de cada arquivo
> (já lê: `data_inicial` e `data_final` saem dos parsers), entende, informa e pergunta.
>
> Número que não fecha É divergência. Bloqueia sempre, sem botão.
>
> São naturezas diferentes e hoje caem no mesmo balde.

## DESENHO

1. Ao detectar janelas divergentes entre fontes, o sistema calcula o **PERÍODO COMUM**
   (interseção das janelas).
2. **NUNCA** compara `saldo_final` entre fontes de janelas diferentes. Comparar o saldo
   de junho com o de julho é comparar coisas incomparáveis. O 91,7% previsto não é
   divergência, é o mês de julho.
3. Apresenta ao operador, com os números na tela:

   ```
   Os arquivos cobrem janelas diferentes.
   W011A: 01/07/2025 a 30/06/2026
   W016A: 01/07/2025 a 30/06/2026
   W015A: 01/08/2025 a 30/07/2026
   O W015A inclui Jul/2026, ausente nos outros dois. Período comum: 01/07/2025 a 30/06/2026.
   Vou usar o período comum e desconsiderar Jul/2026 do W015A. Confirma?
   ```

   Opções: **usar período comum** / **usar a janela maior** / **cancelar**.
4. O operador **não está aprovando um erro**. Está escolhendo entre duas leituras
   válidas do mesmo dado. Por isso este ponto tem botão e o de número que não fecha
   não tem.

## Duas naturezas, dois tratamentos (resumo)

| Natureza | Exemplo | Tratamento |
|---|---|---|
| Janela diferente (metadado) | W015A cobre Jul/2026, os outros não | Informa, calcula período comum, PERGUNTA (botão) |
| Número que não fecha (divergência) | soma de lançamentos != total; caixa não fecha | BLOQUEIA sempre, sem botão |

## Ordem de execução (não inverter)

1. **Frente 1 primeiro, sozinha:** popular `saldo_anterior` no W011A. NÃO toca em
   `_validar`. NÃO toca na reconciliação.
2. Depois do conserto da Frente 1, o Gardenia passa a dar `reconciliacao_bloqueante`
   (par W011A vs W015A, saldo 91,7%, teto de sanidade). **Isso é esperado, está
   previsto, e não é regressão.** Registrar com essas palavras no doc de conclusão da
   Frente 1.
3. **Frente 2 só depois, separada.** É ela que faz o Gardenia (e todo condomínio com o
   atalho "últimos doze meses") voltar a gerar sem bloqueio indevido.

## Princípio, reforço não negociável (Entrega 1)

Nunca existirá um botão de "gerar mesmo assim" para número que não fecha. O operador
não consegue saber, olhando a tela, se o número está errado. Se soubesse, não precisaria
do parser. Este bloqueio é a única coisa que o avisa. Prova disso é o caso (c) da Frente
1: com o `saldo_anterior` zerado, um relatório que perdeu R$ 5.000 da abertura passava.
Um botão teria gerado o deck com R$ 5.000 a menos, e ninguém saberia.

Diferença de janela é a única coisa que tem botão, porque ali o operador escolhe entre
duas leituras válidas do mesmo dado, não aprova um erro.

### Achado: o produto já tinha o botão que o princípio proíbe
Descobrimos que o produto já tinha o botão que o princípio proíbe, num caminho que
ninguém olhava (`prestacaoGerarMesmoAssim`, o "gerar mesmo com diferenças grandes" do
fluxo offline PptxGenJS). O princípio nasceu de uma decisão consciente; o botão nasceu de
uma conveniência. Conveniência acumula em silêncio. Na Entrega 1 ele caiu: a função vira
bloqueio duro que nomeia a divergência e os dois valores, e o botão fica sempre escondido.

## Estado da Entrega 1 (a mensagem que ensina)

Feito na branch (aguardando gate + PR + autorização):
- 422 devolve `mensagem` em português, integral (sem teto de 300 chars), que nomeia o
  arquivo, o número que não fecha e a diferença, ou as janelas divergentes e o que
  reexportar. Composta em `app/mensagens.py`; parsers e `orquestrar_multi_fonte` a usam.
- Log passou a conter só a categoria (slug). Número só na resposta HTTP. Fechados os três
  pontos apontados pelo auditor (`main.py`, reconciliação em `pipeline.py`) mais o
  `parser_w015p.py` e o `assert` do `agrupador.py`, que também vazavam cifra em log.
- `public/prestacao.js` exibe a mensagem num painel persistente acima do botão (toast de
  4s some antes de o operador ler) e apurou o "gerar mesmo assim".
- `server.js` e `public/index.html`: intocados.
- Aceite verificado no dado real: Gardenia pede correção nomeando as janelas e a
  diferença de R$ 71.885,52; W011A de soma quebrada mostra os dois valores e a diferença;
  nenhum log com cifra.

## Ligação com o fast follow já aberto

Conversa direto com o requisito de produto de mensagem que ensina o operador: nomear
qual arquivo cobre qual janela e o que fazer. A Frente 2 é a implementação desse
princípio no caso de janela divergente.

---

## Registros desta sessão

### Achado novo no Buritis (fast follow, não investigar agora)
O W011A do Buritis (`11ABURITIS12M.pdf`) cobre 01/08/2025 a 30/07/2026, doze meses, e o
último mês (Jul/2026) entra PARCIAL porque é o mês corrente: receita 101.417,28 contra
média de ~280.000 dos outros onze; despesa 96.359,68 contra ~250.000. O deck do Buritis
que já foi gerado e apresentado saiu com **média mensal contaminada por um mês
incompleto**. Mesma raiz do atalho "últimos doze meses" do Superlógica: o mês corrente
é arrastado. Já estava no fast follow de mensagem ao operador; agora tem número.

### Lição de método (registrada também na memória)
Duas análises de código, a do Claude e a do Matheus, previram com "alta confiança" que o
`saldo_anterior` do Buritis era zero, para explicar por que o bug estava latente. Um print
de instrumentação de dez segundos desmentiu as duas: Buritis tem `saldo_anterior =
619.550,09`. O bug não era latente por saldo zero; era latente por **ausência de meses
zerados no início**. Confirmar no dado, nunca na leitura, por mais convergente que a
leitura pareça.

### Convenção de fixtures de teste (dado de cliente real, gitignored)
Os PDFs de prestação são dado financeiro de cliente real e nunca entram no repositório
nem no código dos testes. Há dois mecanismos, ambos gitignored. O grosso dos testes de
parser varre `tests/fixtures_local/` por tipo de PDF e lê os números de referência de
JSONs ali (`w011a_referencia.json`, `w015p_referencia.json`). Os três testes da Frente 1
leem `gardenia-w011a.pdf` e `buritis-w011a.pdf` de `PRESTACAO_FIXTURES_DIR`, pasta fora
do repo. Sem o artefato correspondente, o teste dá `skip`. `tests/fixtures_local/` está
no `.gitignore` (linha 47). Documentado também no README do serviço.

### Nota para o doc de CONCLUSÃO da Frente 1 (escrever quando concluir)
Depois do conserto da Frente 1, o Gardenia deixa de dar `relatorio_invalido` e passa a
dar `reconciliacao_bloqueante` (par W011A vs W015A no saldo_final, 91,7%, teto de
sanidade). **Isso é esperado, está previsto, e não é regressão.** É exatamente o que a
Frente 2 vai destravar.
