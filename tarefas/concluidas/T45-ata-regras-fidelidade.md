# T45 Ata: regras de fidelidade a partir da conferência da Happy Days

Data: 22/10/2026. Direto na dev.

## Origem

Conferência da ata da AGO Happy Days Manguinhos (21/10/2026) contra a transcrição e a apresentação: nota 8 de 10. Deliberações certas e valores da apresentação certos, mas: brincadeira sobre assinatura da ata registrada como divisão de honorário; valor de exemplo ("hoje é de R$ 4.000 e pouco") gravado como honorário atual; argumento do lado contrário atribuído a quem defendia; data do documento (30/06/2027) diferente da fala (30 de julho) sem marcador; opção parcelada do slide e "Italínea" de fora; item 5 dado como "não aprovado" sem votação; marcadores demais ([a confirmar] em número claro, [conferir] repetido 5 vezes para OTIS, "Supremo Tribunal Federal" marcado como nome sem fonte).

## Causas encontradas

1. A lacuna automática de valor dizia "confira se entra em algum item" para todo valor dito, sem contexto. A inserção usou isso para gravar o valor de exemplo como honorário atual.
2. Não havia regra contra conversa paralela, nem sobre o contexto do número, nem sobre atribuição de fala em debate.
3. O validador de [conferir] só reconhecia valor e nome; data perdia o marcador. Nome com conectivo ("ON Soluções em Engenharia") não era reconhecido.
4. O gate não conhecia palavras de instituição por extenso (o áudio diz "STF").

## O que mudou (server.js)

1. Regras novas no fim das regras de fidelidade: FID 11 (conversa paralela e brincadeira não viram fato), FID 12 (contexto do número antes de ligar a um campo), FID 13 (cada argumento com quem disse), FID 14 (número claro sem marcador), FID 15 (aprovado, rejeitado, não deliberado ou retirado, exatos).
2. Regras dos documentos: DOC 4A (todas as condições da proposta tratada: à vista, parcelado, totais, valor por unidade), DOC 4B (nome da empresa na forma do documento), DOC 4C (data e prazo seguem a DOC 2), DOC 4D (marcador de nome só na primeira menção). A conferência áudio x documento passa a listar datas.
3. Auditoria de completude e inserção: não tratam conversa paralela como lacuna, mantêm o sentido de exemplo, apontam atribuição trocada. A lacuna automática de valor agora pede para inserir só no sentido exato da fala.
4. Validador de [conferir]: aceita data (30/06/2027 = 30 de junho de 2027), lê nome com conectivo, e deixa o marcador de nome só na primeira menção (valor continua marcado sempre).
5. Gate: palavras de instituição e termos jurídicos por extenso não são nome próprio (Supremo, Superior, Constituição, Súmula, Ministério Público e outros).

## Testes

1. conferir-unit-test: 9 de 9 (4 casos novos: data mantida, data fora do documento removida, OTIS marcado uma vez, valor sempre e nome uma vez).
2. Demais harnesses da ata: 21, 36 e 19 passando.
3. Gate na ata real da Happy Days: antes marcava "Supremo"; agora não marca.

## Pendente

Validar com nova geração da ata da Happy Days no dev e comparar com a anterior.
