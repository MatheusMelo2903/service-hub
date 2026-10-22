# T46 e T47 Ata: inserção por trecho, 2a rodada de regras e números

Data: 22/10/2026. Direto na dev (dev = fea2538).

## T46 Inserção por trecho

Antes, para encaixar as lacunas da auditoria, o motor pedia a ata INTEIRA de novo (saída do tamanho da ata, 50 a 70 s). Agora o modelo devolve só operações em JSON (inserir depois de um trecho exato, ou trocar um trecho curto) e o código aplica (aplicarTrechos). O resto da ata fica igual byte a byte.

1. Operação sem ponto na ata: 2a rodada curta sobre a ata já atualizada, pedindo só o que falta.
2. Ainda sobrou: reescrita inteira de antes, partindo da ata já com os trechos encaixados (nada se perde). Opus de último recurso também parte dela.
3. Teto de chamadas por ata: 9. Desliga com ATA_INSERCAO_POR_TRECHO=0.

Teste real (harness scripts/ata-harness/insercao-trecho-harness.cjs, Casablanca, saídas em ~/v8s/EXECUCAO/testes/T46):
1. 10 lacunas: reescrita 52 s, trecho 20 s, mesmos valores.
2. 11 lacunas: reescrita 53 s, trecho 23 s, mesmos valores.
3. 16 lacunas: reescrita 61 s, trecho 39 s, 11 de 11 operações, mesmos valores, 99,3% do texto base intacto.
Unitário: scripts/ata-harness/insercao-trecho-unit-test.cjs (10 casos).

## T47 Regras da 2a conferência da Happy Days

1. Exemplos das regras com nomes fictícios (o gerador copiava "Eriton" e havia "Dari" e "Dani", moradores reais).
2. FID 14 vale para nomes; FID 15 também no encerramento; FID 16 quórum só com contagem explícita; FID 17 quem disse o quê.
3. Mesmo dado com números diferentes em momentos diferentes: registra os dois (decisão do Matheus). Voto e valor aprovado conflitantes seguem [a confirmar].
4. Conta dita na fala que não fecha: resultado correto com [conferir: transcrição dizia X] (decisão do Matheus). O validador confere a multiplicação (_contaFecha); se o gerador errar a conta, volta o valor dito com [valor a confirmar]. Gate respeita valor já validado.
5. Gate ignora expansão de sigla cujas iniciais batem com a sigla entre parênteses (ART, STF) e mais termos técnicos.
6. Auditoria em 2 partes a partir de 15 mil caracteres, sem a espera de 10 s.
7. Tempo de cada etapa vai no resultado e aparece num aviso ao terminar a ata.
8. Aviso de imagem não lida da T43 agora chega ao usuário (limparResultadoAta).

## Conta da API

Trava mensal subiu de US$ 50 para US$ 220, recarga automática até US$ 20 abaixo de US$ 5, aviso por e-mail em US$ 200 (decisão do Matheus, 22/10).

## Pendente

Teste do Matheus no dev com a ata da Happy Days (tempos por etapa e conferência). Produção só com "sobe para producao".
