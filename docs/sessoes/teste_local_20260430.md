# Teste local da feature Inquilino e Dependente

Data: 2026-04-30
Ambiente: instância local do Service Hub apontando pra API REST do Superlógica em produção via proxy Railway.

## Contexto

A feature de suporte a Inquilino e Dependente foi implementada nesta mesma data e passou pelos 8 subagentes (arquiteto, programador, revisor, auditor de segurança, validador, documentador, professor, estrategista). Antes de subir pro GitHub e disparar o deploy automático no Railway, o Matheus rodou um teste local em produção com uma unidade real pra confirmar que o fluxo ponta a ponta funciona.

## Planilha usada

`teste_unidade_real_1102_A2.xlsx`

Formato unificado de 26 colunas (A a Z), 1 linha por pessoa, agrupada por Unidade + Bloco. Coluna A define o tipo (`Proprietario`, `Inquilino` ou `Dependente`).

## Cenário

- Condomínio: 167 (Residencial Teste, sandbox da V8S no Superlógica)
- Unidade: 1102 A2 (Villagio Residencial)
- 1 unidade nova com 3 pessoas em 3 linhas distintas

## Pessoas cadastradas

| Tipo | Nome |
|------|------|
| Proprietária | Paloma |
| Inquilino | André |
| Dependente | Renata |

## Resultado do log de importação

```
POST OK
PUT  OK
INQ  OK
DEP  OK
RES  inq 1 ok dep 1 ok
```

Os 4 passos do fluxo funcionaram em sequência:
1. POST criou a unidade vazia 1102 A2 no cond 167
2. PUT populou os dados da Paloma como proprietária
3. POST do André como Inquilino com `ID_TIPORESP_TRES=7` retornou status 200
4. POST da Renata como Dependente com `ID_TIPORESP_TRES=4` retornou status 200
5. Linha de resumo confirmou contagem por unidade

## Validação visual no painel do Superlógica

A unidade 1102 A2 do cond 167 apareceu com 3 contatos vinculados, cada um no seu papel correto (Proprietário, Inquilino, Dependente). Nenhum dos campos chegou nulo ou em formato errado. Datas em formato americano, UF como código numérico, telefone na estrutura dupla TELEFONES + ST_TELEFONE_CON.

## Conclusão

Feature aprovada localmente pelo Matheus. Próximo passo: commit e push pra branch main do GitHub. O Railway aciona deploy automático assim que detecta o push. Após o deploy ficar online com HTTP 200 em `/hub`, a feature entra em produção e fica disponível para os condomínios reais.

## Próximos passos manuais que dependem só do Matheus

1. Rodar a mesma planilha `teste_unidade_real_1102_A2.xlsx` na URL de produção depois do deploy, pra confirmar que o comportamento é idêntico ao teste local.
2. Apagar pelo painel do Superlógica os contatos antigos de teste do cond 167: DEP FETCH 01, TESTE DEPENDENTE API e INQ API REST 01.
3. Apagar pelo painel as unidades de teste eventuais (T-9999 ou T-9998 se foram subidas) e a 1102 A2 deste teste, antes de iniciar o onboarding real do Residencial com 777 unidades.
