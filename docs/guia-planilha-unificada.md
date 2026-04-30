# Guia da Planilha Unificada de Moradores

**Última atualização: 30/04/2026**

---

## O que mudou

Antes, a planilha de importação do Superlógica aceitava só um tipo de pessoa por linha, no formato antigo que a própria API usa. Agora a planilha unificada aceita Proprietário, Inquilino e Dependente na mesma planilha, todos associados à mesma unidade. Você monta tudo em um único arquivo e importa de uma vez.

---

## Estrutura da planilha: 26 colunas (A até Z)

| Coluna | Campo | O que colocar |
|--------|-------|---------------|
| A | Tipo | `Proprietario`, `Inquilino` ou `Dependente` (sem acento, sem cedilha) |
| B | Unidade | Ex: `0202`, `101`, `502` |
| C | Bloco | Ex: `TORRE A`, `Bloco B`, `A` |
| D | Fração | Somente na linha do Proprietário. Use ponto decimal. Ex: `0.135753` |
| E | Metragem | Somente na linha do Proprietário. Ex: `82.5` |
| F | Nome | Nome completo |
| G | CPF | Somente dígitos, sem ponto ou traço. Ex: `15990067747` |
| H | CNPJ | Somente dígitos. Deixe vazio se não tiver |
| I | RG | Número do RG |
| J | Data Nascimento | Formato `dd/mm/aaaa`. Ex: `15/03/1990` |
| K | Gênero | `M`, `F` ou vazio |
| L | Email | Ex: `pessoa@email.com` |
| M | DDI | Código do país. Deixe `55` para Brasil |
| N | Telefone | Somente dígitos. Ex: `27999998888` |
| O | Tipo Telefone | `1` = fixo, `2` = celular, `3` = comercial. Padrão: `2` |
| P | CEP | Somente dígitos. Ex: `29060150` |
| Q | Endereço | Nome da rua |
| R | Número | Número do endereço |
| S | Complemento | Apto, casa, etc. Pode deixar vazio |
| T | Bairro | Nome do bairro |
| U | Cidade | Nome da cidade |
| V | Estado | Sigla UF. Ex: `ES`, `SP`, `RJ`, `MG`, `BA` |
| W | Data Entrada | Formato `dd/mm/aaaa`. Para Inquilino, padrão é a data de hoje |
| X | Data Saída | Deixe vazio normalmente |
| Y | Recebe Cobrança | `Sim` ou `Não` |
| Z | Observações | Somente na linha do Proprietário |

---

## Regras de preenchimento

**Uma linha por pessoa.** Se uma unidade tem 1 Proprietário, 1 Inquilino e 2 Dependentes, são 4 linhas.

**Unidade é identificada pelo par Unidade + Bloco.** Se você colocar `0202` e `TORRE A` nas quatro linhas, o sistema entende que são todos da mesma unidade.

**A linha do Proprietário carrega os dados da unidade.** Fração, Metragem e Observações só fazem sentido nessa linha. Nas linhas de Inquilino e Dependente, esses campos ficam vazios.

**Campos vazios são simplesmente ignorados.** O sistema não envia campo em branco para a API, então não tem risco de apagar dado existente por esquecer de preencher algo.

**CPF de Dependente pode ficar vazio.** A API aceita.

**Se você colocar dois Proprietários para a mesma unidade**, o sistema usa só o primeiro e avisa no log. Não quebra, mas avisa.

**Estados aceitos atualmente:** ES, SP, RJ, MG, BA. Se você colocar outro, o sistema avisa via notificação na tela e segue sem enviar o estado.

---

## Exemplo: unidade A-0202, condomínio 167

1 Proprietário + 1 Inquilino + 1 Dependente.

```
A           | B    | C       | D         | E    | F              | G           | H | I       | J          | K | L                    | M  | N           | O | P        | Q                  | R  | S    | T       | U       | V  | W          | X | Y   | Z
Proprietario| 0202 | TORRE A | 0.135753  | 82.5 | Carlos Andrade | 15990067747 |   | 1234567 | 10/05/1978 | M | carlos@email.com     | 55 | 27988887777 | 2 | 29060150 | Rua das Palmeiras  | 45 |      | Jardins | Vitoria | ES |            |   | Sim | Fracao correta conf escritura
Inquilino   | 0202 | TORRE A |           |      | Paula Souza    | 98700011122 |   |         | 22/11/1991 | F | paula@email.com      | 55 | 27977776666 | 2 |          |                    |    |      |         |         |    | 01/02/2026 |   | Sim |
Dependente  | 0202 | TORRE A |           |      | Lucas Souza    |             |   |         | 14/07/2015 | M |                      |    |             |   |          |                    |    |      |         |         |    |            |   | Não |
```

---

## Como o sistema processa a planilha

1. Ao importar, o sistema detecta automaticamente se é o formato antigo do Superlógica ou o novo formato unificado de 26 colunas. Você não precisa fazer nada diferente.

2. O sistema agrupa as linhas por Unidade + Bloco e processa cada unidade em sequência.

3. Para cada unidade, a ordem é sempre: cria a unidade vazia, cadastra o Proprietário, depois cadastra cada Inquilino, depois cada Dependente.

4. O log na tela mostra o progresso. Você vai ver algo como: `POST 1/1 OK / PUT 1/1 OK / Inq 1 ok / Dep 2 ok`.

---

## Pontos de atenção antes de importar

- Coluna A: precisa estar escrito exatamente `Proprietario`, `Inquilino` ou `Dependente`. Sem acento, sem cedilha, sem espaço sobrando.
- Datas: sempre `dd/mm/aaaa`. O sistema converte internamente para o formato que a API exige.
- Recebe Cobrança: `Sim` vira o código 2 na API, `Não` vira o código 1. Se deixar vazio, vai como `Não`.
- Telefone e CPF: somente dígitos. Sem ponto, traço ou parêntese.

---

## Status de validação

Os payloads gerados por essa importação foram validados em 30/04/2026 com dados reais do condomínio 167. Inquilino e Dependente passaram com status 200 na API do Superlógica. O formato está correto e em produção.
