# CONCLUIDA: transporte do edital (frente A) + consolidacao de nome proprio (frente B)

Fechada em 2026-07-09. Validada pelo Matheus lendo o texto da ata gerada no dev (build 1f83f4e).
Gate de subagentes reprovou uma vez, foi corrigido, e reprovou nada na segunda rodada.
Estado: aguardando PR dev para main. NAO mergeado. Producao intocada ate a frase "sobe para producao".

## 1. Resumo do que fechou

Duas frentes na geracao de ata condominial com IA, validadas com os proprios olhos do Matheus
no ambiente de teste (dev):

- FRENTE A: o texto do edital anexado pelo dropzone agora chega inteiro na geracao. Antes, so
  cinco campos soltos eram lidos e o texto era descartado, entao o cabecalho saia com
  [CNPJ a confirmar] e [Logradouro a confirmar].
- FRENTE B: um passe de consolidacao de nome proprio que escolhe uma forma canonica entre as
  varias grafias do mesmo nome, usando so o que existe literalmente na gravacao. Junto veio a
  correcao de um bug de grounding por substring que aprovava formas degradadas de nome.

Veredito real do teste do Matheus (Casablanca no dev): cabecalho completo (CNPJ 00.197.336/0001-96,
"Rua Afonso Claudio, no 142, Valparaiso, Serra/ES", edital datado e assinado pela sindica). Nomes
firmes: Dr. Marcelo Soares, Bit Engenharia, ADN Mantas. Sumiu o "[nome a confirmar: Bit / MIT /
Adite]" do reteste anterior. Nenhuma das regressoes de corpo do teste que reprovou (Cato duplicado,
injecao no orcamento, explosao de [a confirmar]).

## 2. FRENTE A: transporte do texto do edital (commit ba35e10)

Arquivo: public/index.html, funcao processarEditalFile.

O problema em linguagem de negocio: quando o usuario anexava o edital de convocacao no dropzone,
o sistema lia o PDF so para tirar cinco informacoes soltas (condominio, data, tipo, sindico, local)
e jogava o resto do texto fora, como quem le uma carta inteira so para anotar cinco dados num
post-it e joga a carta no lixo. A geracao da ata nunca recebia a carta, so o post-it, entao quando
precisava de um CNPJ ou de um endereco que nao estava entre os cinco campos, escrevia "a confirmar"
porque nao tinha a informacao na frente. Nao era variancia do modelo, era bug de transporte: toda
ata gerada por harness (que ja punha o edital no prompt) saia com cabecalho correto.

O conserto faz o navegador extrair o texto completo do PDF com pdf.js (client side, zero API, zero
latencia de servidor) e injetar esse texto no bloco EDITAIS ANEXADOS da geracao. limparAta limpa a
variavel para nao vazar edital velho.

## 3. FRENTE B: passe de consolidacao de nome proprio (commit 08e53a2)

Arquivo: server.js. Passe aditivo em entregarAta, DEPOIS de inserirLacunasNaAta e ANTES de
corrigirPlaceholdersDeliberacao (a correcao cirurgica de valor). Cada etapa mexe numa dimensao
diferente do texto (completude, nome proprio, valor), sem sobreposicao.

O que ele faz: a transcricao de audio erra letras parecidas e registra o mesmo nome de varias
formas ("Bit Engenharia", "MIT", "Adite" sao a mesma empresa captada com erros distintos). O passe
escolhe uma forma para a ata inteira e descarta as variantes erradas, mas so pode escolher entre
formas que existem literalmente na gravacao, nunca uma forma nova inventada.

O que ele NAO promete: nao verifica se o fato esta certo, nao inventa dado. So arruma a grafia de um
nome que ja existe de varias formas. Se o nome nunca foi dito claramente em nenhum trecho, o passe
nao mexe em nada, para nunca piorar.

Etapas:
- ETAPA 1 (codigo) extrairNomesCandidatos: canal marcador "[nome a confirmar: X / Y]" e canal firme
  (nome apos gatilho de pessoa/empresa), com exclusao por glossario, CAIXA ALTA e repeticao minima 2.
- ETAPA 2 (codigo) reunirEvidencia: grounding literal contra a transcricao (fabricacao morre aqui) e
  ancora por valor (nomes ditos perto do mesmo R$).
- decidirPorCodigo: 1 forma grounded resolve por codigo (alta_codigo); 2 ou mais vao para etapa 3;
  zero nunca piora.
- ETAPA 3 (1 chamada claude-sonnet-4-6, insumo minimo: so a lista de nomes e evidencias, nunca a ata
  nem a transcricao inteira): decide a forma canonica. So aplica confianca alta.
- ETAPA 4 (codigo) aplicarConsolidacao: find and replace por fronteira de palavra, dupla checagem de
  grounding, guarda de tamanho 95%.

Fail-open: qualquer falha (teto de chamadas, rede, JSON) devolve a ata intacta, sem retry. A
telemetria consolidacao_nome so guarda contagens, zero nome e zero valor.

Arquiteto confirmou os invariantes intocados: motor de deliberacao, corrigirPlaceholdersDeliberacao,
validarAta e o teto de chamadas Anthropic. O passe reutiliza o mesmo fechamento "chamar" que aplica
o teto, entao nao abre excecao de custo.

## 4. O bug do grounding por substring (commit 1f83f4e)

Arquivo: server.js, funcao existeLiteral.

A trava de seguranca que checa "esse nome existe na gravacao?" estava fazendo busca por substring
(includes), tipo conferir pedido so pelas primeiras letras sem olhar a palavra inteira. Isso fazia o
sistema aceitar "Cato" porque a gravacao tinha "Cator", e "Cerval" porque existia "Cervalp", mesmo
sendo nomes diferentes e a forma curta sendo um pedaco cortado. A trava que deveria impedir nome
errado estava dando aval para uma versao degradada, e o passe aplicava esse pedaco como se fosse o
nome oficial na ata inteira.

Conserto: existeLiteral promovida a funcao de modulo e reescrita para exigir palavra inteira, com o
mesmo lookaround do replace da etapa 4 (grounding e replace tem que ser coerentes). "Cato" so passa
se a gravacao disser "Cato" isolado, nunca como pedaco de "Cator".

Nota sobre o Marcel: a previsao de que "Marcel" viraria falso apos esse conserto estava errada.
"Marcel" aparece 4x isolado na fala do Casablanca, entao segue grounded com fronteira de palavra. O
bug de substring explica Cato e Cerval, nao o Marcel (ver secao 7).

## 5. O gate pegou um vazamento que a propria frente A criou

Observacao registrada a pedido do Matheus, literal:

A frente A criou o vazamento do achado #1. Antes dela nao havia estado de edital para vazar. O
conserto do H1 abriu um caminho de contaminacao entre condominios. O gate de subagentes pegou. Isso
e o que o gate serve para fazer, e e por isso que ele roda antes do push, nao depois.

## 6. As cinco correcoes do gate (commit 47eb102)

Na primeira rodada do gate, arquiteto, auditor, validador e professor/estrategista deram verde, mas
o REVISOR reprovou com 1 critico e 4 moderados. Regra do CLAUDE.md: revisor ou auditor reprovando
bloqueia o PR ate o programador corrigir. Corrigidos os cinco pontos e re-rodado o gate (revisor +
auditor), os dois deram verde.

- #1 CRITICO (vazamento cross-condominio): processarEditalFile nao zerava
  _editalDropzoneTexto/_editalDropzoneNome quando o Haiku falhava (catch externo). Cenario real: usuario
  processa Edital do Condominio A com sucesso; sem clicar "Limpar tudo", anexa Edital do Condominio B;
  o Haiku falha (rede/rate limit/JSON quebrado); a variavel continua com o texto de A; ao gerar a ata
  de B, o edital de A e injetado e o prompt trata seus dados como oficiais. Conserto: zerar as duas
  variaveis no topo da funcao, antes de tudo. Trade-off de UX aceito pelo Matheus: reanexacao que falha
  perde o edital anterior de proposito. Cinco segundos de inconveniencia valem menos que uma ata com o
  CNPJ de outro condominio registrada em cartorio. Sempre que a escolha for entre inconveniencia e
  contaminacao silenciosa, a escolha e inconveniencia.
- #2: extracao pdf.js que falha agora avisa na interface (status warning + toast warn) em vez de
  mascarar com toast de sucesso, que reintroduziria o H1 sem sinal (o H1 motivou esta frente inteira).
- #3: fronteira de palavra do existeLiteral e do aplicarConsolidacao passa a bloquear digito, hifen e
  apostrofo alem de letra acentuada, mesma classe nos dois pontos. "Bit" casando em "Bit2024" e o mesmo
  bug de substring numa outra dimensao.
- #4: comentario do teto de chamadas Anthropic corrigido para contar a etapa 3 do passe (pior caso 8) e
  o fail-open no teto. Comentario mentiroso em codigo que roda ja custou uma hipotese errada nesta
  frente. Valor e logica do teto intocados.
- #5: extrai helper _escapeRegex, elimina a expressao de escape duplicada em tres pontos.

Itens 6 e 7 do revisor (Set em alvos, performance de extrairMencoesMonetarias) nao foram feitos:
nao e hora de performance nem cosmetico.

## 7. Harness de 59 casos

scripts/ata-harness/consolidacao-nome-unit-test.cjs: 59 PASS, 0 FAIL, 0 SKIP. Cobre extracao de
marcador, exclusao por glossario e CAIXA ALTA, grounding real do Casablanca, ancoragem por valor,
resolucao por codigo sem LLM, find and replace determinístico, substituicao por palavra inteira, e a
regressao permanente do bug do existeLiteral (caso 9). Os casos que dependem da transcricao real do
Casablanca rodam quando o arquivo existe na maquina, senao pulam.

scripts/ata-harness/cirurgica-unit-test.cjs: 21 PASS, 0 FAIL. Prova que o motor de deliberacao e a
correcao cirurgica ficaram intocados.

node --check server.js: limpo.

## 8. Em aberto: a proxima frente e a invencao de fato do motor fracionado

O passe de nome NAO e mais o problema. Esta provado. O risco que sobra, e o de maior gravidade, e o
MOTOR FRACIONADO (auditoria de completude por blocos + Sonnet 32k + Opus condicional, commit 6133629,
em producao desde 2026-07-08) inventando FATO. Nao e erro de nome: e orcamento errado, valor trocado,
empresa que nao existe na transcricao, placar de votacao que nao fecha. Em ata isso e o pior tipo de
erro, porque parece certo e o sindico assina em cima.

Evidencia de tres geracoes do mesmo audio (Casablanca) dando tres conjuntos de fatos diferentes:
- escreveu "Cardo Engenharia"; a transcricao diz "Cator"; "Cardo" nao existe literal (fabricacao).
- atribuiu "empresa Ceval" ao Sr. Rafael; "Ceval" nao existe literal.
- escreveu "R$ 355.000,00" para o orcamento (iv); a transcricao diz "R$ 355.200" (VALOR FIRME PERDIDO).
- tinta "[termo a confirmar: xeroilis]" numa geracao, "Sherwin-Williams" noutra, nenhuma confirmada.
- placar que nao fecha: "vinte e tres (23) votos e uma (1) abstencao" totalizando 24 depois de dizer 26.
- fatos trocados entre geracoes ("bypass do caminhao-pipa" vs "bypass do poco artesiano").

A geracao e estocastica (sem temperature fixado): o mesmo audio nao repete a saida. Nenhum passe de
NOME resolve invencao de FATO.

Trade-off central: fracionar ganhou cobertura de valor (foco por bloco), mas partiu o contexto em
pedacos que nao se checam entre si, e e ai que nasce a invencao. Um passe unico e amplo resolveria a
checagem cruzada, mas ja foi testado e diluia atencao, que foi o motivo original do fracionamento.
Voltar para ele troca um problema grave por outro.

Caminhos possiveis, sem recomendar implementar agora:
1. Passe fracionado por classe de fato (valores, empresas, votacao, datas), cada um enxergando so uma
   categoria estreita contra a transcricao inteira. Mantem o fracionamento que funciona para cobertura,
   adiciona granularidade fina. Custo: mais chamadas, mais latencia, mais manutencao. E o formato que o
   doc analise-passe-fidelidade-amplo.md ja recomenda caso algum passe seja feito.
2. Grounding determinístico de valores firmes contra a transcricao, sem IA: todo valor monetario ou
   percentual na ata precisa existir literal na fala, senao e sinalizado. Mesmo principio que resolveu
   nome proprio, aplicado a valor. Resolve o caso mais grave (R$ 355.000 vs R$ 355.200) com zero custo
   de IA. Nao resolve invencao de empresa nem fato qualitativo.
3. Fixar temperature=0 na geracao. Elimina a variancia entre geracoes (util para diagnosticar), mas nao
   garante fidelidade: o modelo pode ser deterministico e ainda inventar o mesmo fato errado sempre.

Caminhos 2 e 3 sao baratos e podem entrar juntos como camada determinística; 1 e o mais caro e mais
completo para fato qualitativo. Nao mutuamente exclusivos.

Custo de deixar como esta: o motor fracionado ja esta em producao inventando fato real em ata que vira
documento assinado pelo sindico. Esperar mais um ciclo de validacao sai mais barato que corrigir depois
de uma ata errada circular como oficial.

## 9. Em aberto (secundario): agrupamento de "Marcel" e "Marcelo Soares" nao existe

Diagnosticado, nao consertado. Nas etapas 1 e 2 do passe, "Marcel" e "Marcelo Soares" NUNCA sao
agrupados como variantes do mesmo candidato:
- Canal marcador so agrupa formas que a geracao listou dentro de um mesmo "[nome a confirmar: A / B]".
  O advogado veio como "[sobrenome a confirmar]", que extrairNomesCandidatos descarta (so "nome" conta).
- Canal firme deduplica por _normLoose; "marcel" e "marcelo soares" sao chaves distintas, e cada
  candidato firme nasce com alternativas de um unico elemento. Nao ha passo que una duas grafias
  diferentes da ata num so candidato.
- A unica ponte para a forma da transcricao e _expandirNomeCompleto, chamada so dentro da ancora por
  valor; o advogado nao tem valor em R$ colado, entao esse caminho nao o alcanca.

Consequencia: "Marcel" chega em decidirPorCodigo com exatamente uma forma grounded, resolve por codigo
como "Marcel" e nao substitui nada. A etapa 3 (LLM) nunca ve o caso. O conserto e de CODIGO
(clusterizacao de prenome curto para nome completo grounded), nao de LLM. Nao mexer na etapa 3.

## 10. Fast-follows registrados (nao fazer agora)

- Ressalva de producao: o desempate da ancora por valor usa a heuristica "aprovacao colada no gatilho"
  (server.js, _buscarAncoraPorValor). Funcionou no Casablanca (Bit), pode escolher errado em outra ata.
  Rede: confianca alta + grounding. Vigiar em producao; se aparecer nome consolidado errado, e aqui.
- Codigo morto inofensivo: o else que zera as variaveis no caso imagem (public/index.html) e redundante
  apos o reset no topo. Remover em limpeza futura, sem pressa.
- Gate de qualidade de SAIDA da ata: suite de regressao com atas de referencia congeladas, comparando
  invariantes (valores, placares, nomes, cabecalho, contagem de [a confirmar]). O gate atual (revisor +
  auditor) nao pega regressao de qualidade de geracao.
- Endpoint /version expondo o SHA rodando (railway up nao grava o commit).

## 11. Commits, arquivos, veredito do gate

Commits (na dev, entram no PR dev para main):
- ba35e10 transporte do edital (frente A), public/index.html
- 08e53a2 passe de consolidacao de nome (frente B), server.js
- 1f83f4e grounding por palavra inteira + harness, server.js + consolidacao-nome-unit-test.cjs
- 47eb102 correcoes do gate revisor (1 critico + 4 moderados), server.js + public/index.html

Diff liquido dev vs main: public/index.html, server.js e scripts/ata-harness/consolidacao-nome-unit-test.cjs.
main e um squash do bloco anterior, entao o PR lista muitos commits mas muda so a frente de ata.

Veredito do gate:
- Rodada 1: arquiteto APROVADO, auditor SEGURO, validador VERDE (59/59, 21/21), revisor REPROVADO (1 critico + 4 moderados).
- Rodada 2 (pos-correcao): revisor APROVADO, auditor SEGURO. Sem regressao nova.

## 12. O que NAO fazer

- NAO fazer merge. NAO tocar em main. Producao so muda com a frase exata "sobe para producao".
- NAO restaurar o auditarFidelidadeAta antigo (passe unico, atencao diluida).
- NAO mexer na etapa 3 do passe de nome para consertar o Marcel; e conserto de codigo (agrupamento).
- Editar arquivo no GitHub: sempre Safari, nunca Chrome.
