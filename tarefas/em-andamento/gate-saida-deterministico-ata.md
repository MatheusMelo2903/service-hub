# Gate de saída determinístico da ata (anti invenção de fato)

Frente de MAIOR esforço, sem urgência. Nasce da fixture Casablanca (evidência congelada
em ~/Downloads/GATE-ATA-CASABLANCA), onde cinco gerações do mesmo áudio produziram cinco
conjuntos de fatos diferentes, incluindo o motor afirmar que a transcrição continha "Habit"
quando não continha (zero ocorrências, confirmado por grep).

## Problema

O motor fracionado inventa fato e atribui a invenção à fonte: nome de empresa fabricado,
valor monetário trocado por outro próximo, placar que não fecha. Não se conserta com prompt
melhor nem modelo melhor: é variância do Sonnet, a mesma versão de código gera fatos diferentes
a cada rodada. O passe de consolidação de nome é um REPARADOR (precisa de dois candidatos para
escolher a forma certa) e por isso deixa passar um nome fabricado fundido numa string sem
segundo candidato. Os identificadores reais do caso que originou a frente ficam fora do repo,
na evidência congelada em ~/Downloads/GATE-ATA-CASABLANCA.

## Solução (frente atual)

Um GATE de saída DETERMINÍSTICO: função pura de (ata, transcrição), sem LLM, sem token, sem
rede. Não repara, JULGA cada afirmação verificável da ata contra o texto fonte e sinaliza a
que não tem âncora. Testa unidade a unidade (raiz distintiva do nome, valor canônico, número
de votos mais objeto votado), então pega o que o reparador não pega.

Princípio central: NUNCA blacklist de palavras suspeitas. A decisão é sempre "esse termo
existe literalmente na fonte" via existeLiteral, mencoesMonetarias e valoresCanonicos, que já
existem no server.js. Prova viva: nomes que existem na transcrição de verdade PASSAM; só o nome
fabricado (zero ocorrências) é sinalizado. Um deles só aparece hifenizado na fonte, então a
âncora aceita componente separado por hífen (ver _gateAncorado).

Política de saída aprovada: marcar visível por padrão, veredicto crítico trava o botão de
finalizar, NUNCA remoção silenciosa, NUNCA bloqueio total da ata por um token. Casa com a
regra da casa: falha visível vence contaminação silenciosa.

Encaixe: última passada dentro de entregarAta, depois de todo reparo (consolidação e
correção cirúrgica), antes de validarAta e concluir. Zero chamada Anthropic, respeita o teto
de custo. Saída viaja no payload como objeto gate (flags mais veredicto) até o polling e o
frontend.

Status: LÓGICA IMPLEMENTADA E PROVADA pela fixture (2026-07-16), 41 de 41 no harness
scripts/ata-gate-harness/casablanca-gate-test.cjs, após CINCO rodadas de revisão adversarial
(cada uma achou e teve corrigido um escape estrutural). Critério de parada aplicado, cauda
documentada. AUTORIZADO commit na feat/ata-gate-saida (Matheus, 2026-07-16). Nada para main.
Nome fabricado sinalizado, valor trocado sinalizado, voto atribuído a nome fabricado vira
crítico, e os nomes e valores que existem na fonte passam sem flag. Os identificadores reais
(condomínio, fornecedores, valores) ficam FORA do repo: harness lê transcrição e ata de fixture
de ~/Downloads/GATE-ATA-CASABLANCA (mesmo padrão do previsao-harness). Determinismo (10 execuções
byte a byte idênticas) e idempotência (Gate(Gate(ata)) ponto fixo, mesmo conjunto de flags)
provados. Travas 1 e 2 provadas. Código em server.js: SUFIXOS_NAO_DISTINTIVOS,
_gateAncorado, _gateMascararColchetes, _gateFlagsProprias, _gateRaizesDistintivas,
_gateAfirmacoesNome/Valor/Placar, gateDeSaida; encaixe em entregarAta; gate no export.
Aguardando revisor mais auditor e validação visual do Matheus antes do commit.

Dois achados da implementação: (1) nome composto hifenizado na fonte (formato "Raiz-Sufixo")
fazia falso positivo na raiz, porque existeLiteral bloqueia hífen na fronteira de propósito
(decisão anterior, do reparador). Resolvido com _gateAncorado, âncora local do gate que aceita o
hífen só do lado da fonte, sem tocar no existeLiteral compartilhado. (2) a flag crítica de voto
sai com tipo 'placar' (não 'nome') pra bater com a re-emissão da 2a passada (idempotência).

Revisão (2026-07-16) achou e corrigiu três buracos que o harness não pegava: (1) o vínculo do
placar usava regex /empresa .../gi, e o flag `i` tornava [A-Z] case-insensitive, alargando o
objeto do voto por palavras minúsculas depois do nome; (2) só reconhecia a palavra literal
"empresa", perdendo "prestadora X"/"firma X"; (3) ':' e ';' contavam como início de frase,
isentando nome fabricado que abre item de lista. Reprojetado: o placar agora liga o voto ao nome
MAIS PRÓXIMO antes da contagem (nearest-preceding), reusando os nomes já extraídos, sem regex
própria de objeto. Harness ganhou 4 testes que estressam esses gaps.

2a rodada de revisão (2026-07-16) achou dois furos mais graves, ambos alcançáveis pelo formato
que o próprio motor gera ("[Nome], com (N) votos" na eleição de síndico): (1) nome fabricado que
ABRE frase, sem gatilho, recebia votos e saía com veredicto LIMPO (o filtro de início de frase o
descartava antes de ligar ao placar); (2) vínculo por distância cega pegava o objeto do item
SEGUINTE. Reprojeto: pool de candidatos a objeto de voto separado do filtro de afirmação isolada
(_gateRootsTodos, sem filtro), vínculo por nome MAIS PRÓXIMO ANTES da contagem DENTRO DA MESMA
FRASE (_sentencaAoRedor, com '.' só sendo fim de frase se seguido de espaço, pra não quebrar em
"R$ 10.900,00"), e objeto já sinalizado por passada anterior é reconhecido por marcadorSpans
(idempotência). Harness com 6 testes de cobertura no total. 28 de 28.

## LIMITAÇÕES CONHECIDAS E CRITÉRIO DE PARADA (fechamento, 2026-07-16)

41 de 41 verde NÃO é ausência de bug. Cinco rodadas de revisão adversarial acharam escape
estrutural (nome fabricado saindo 'limpo') em suíte 100% verde, cada uma: o /gi passava em 19/19,
nome fabricado com voto passava em 23/23, Ltda./S.A. e ':' em 28/28, colisão com abertura em 34/34,
gatilho maiúsculo abrindo frase em 38/38. Todos os cinco foram CORRIGIDOS. Verde prova os casos
COBERTOS, não os não pensados.

CRITÉRIO DE PARADA adotado (Matheus, 2026-07-16): cobrir os formatos que o motor de ata DE FATO
gera, documentar o resto como limitação conhecida, e endurecer sob ata real quando um caso novo
aparecer. A partir da regra: ESCAPE ESTRUTURAL (limpo com fato fabricado em formato comum) se
corrige e roda outra rodada; CAUDA (marca a mais ou a menos, borda rara, miss VISÍVEL que o humano
vê ao revisar) se documenta e para. Parado após a 5a rodada porque o que sobra é cauda:

LIMITAÇÕES CONHECIDAS (todas são MISS VISÍVEL, nunca falha silenciosa, porque o gate só MARCA):
- FALSO NEGATIVO por colisão com abertura: entidade fabricada cuja raiz é EXATAMENTE uma palavra
  gramatical de _GATE_ABERTURAS ("Nada", "Assim", "Diante"), sem gatilho e sem voto, escapa. Corrigir
  inundaria de falso positivo todo item de ata; irresolvível determinístico. Colisão rara.
- FALSO POSITIVO em cabeçalho: _GATE_ABERTURAS não cobre toda forma verbal/adverbial ("Foi",
  "Cumpre", "Aprovou"); uma que falte, após ':' e ausente da transcrição, vira marca espúria. As
  comuns a âncora salva (são ditas no áudio). Lista cresce sob ata real.
- ANÁFORA cruzando frase ("a proposta ... obteve N votos", proposta = empresa citada antes): o nome
  fabricado ainda cai como 'suspeito' (marcado), só não vira 'critico'. Severidade degrada, não a marca.
- ABERTURA como objeto de voto numa frase sem entidade nomeada ("Procedeu-se: N votos"): falso
  'critico' visível no conector. Raro (ata real nomeia o que se vota).
- SIGLA EM CAIXA ALTA (ADN, ABM): não extraída, pra não marcar cabeçalho (ITEM/CNPJ/AGO). Ver fast follow.

APERTA SE O FRONTEND TRAVAR (próxima frente): hoje todo resíduo acima é anotação visível, o humano
decide. Quando o frontend passar a TRAVAR o finalizar em veredicto crítico, um FALSO POSITIVO deixa
de ser anotação e passa a BLOQUEAR trabalho legítimo. Nesse momento o critério aperta e esta cauda
precisa ser revisitada, especialmente o falso positivo de cabeçalho e o de abertura-como-voto.

## DECISÃO EXPLÍCITA: fail open no gate (intencional, não esquecimento)

A chamada gateDeSaida dentro de entregarAta está sob try/catch com FALHA ABERTA: se o gate
lançar por um bug futuro, a ata JÁ GERADA e PAGA é entregue sem marca, com veredicto 'erro_gate',
NUNCA descartada. Isso é DELIBERADO e é o ÚNICO ponto do sistema onde fail open é a escolha
certa, pela regra de ouro do projeto: nenhuma geração custa mais nem é jogada fora por causa de
uma etapa de validação. O gate é a última passada de conferência, não a geração; um defeito nele
não pode custar ao Matheus uma geração de Sonnet já paga. Fail CLOSED aqui seria o erro: transforma
um bug de conferência em perda de trabalho bom. Se algum dia isso for revisto, revisar com esta
razão em mente, não "consertar" achando que foi descuido.

## ENTREGA PARCIAL, explícito (decisão consciente do Matheus, 2026-07-16)

Esta frente entrega METADE: o gate marca a ata (o revisor humano VÊ o marcador no texto, ex.
[voto atribuído a nome sem âncora: 'Habit']). A OUTRA METADE, o frontend ler payload.gate e
TRAVAR o finalizar em veredicto crítico, é a PRÓXIMA frente, ainda não feita. Confirmado no
código em 2026-07-16: public/index.html NÃO lê payload.gate nem veredicto; os botões Baixar PDF
e Baixar Word (linhas ~1656-1657) funcionam independentemente do veredicto. Ou seja, hoje nada
IMPEDE finalizar uma ata com flag crítica; o marcador visível é a única barreira. Marcar já é
melhor que nada, mas a trava real depende do frontend. NÃO fechar esta frente como se o crítico
travasse o finalizar: ele ainda não trava.

## FAST FOLLOW (registrado, não nesta frente)

Três limitações conhecidas ficam como fast follow, nenhuma bloqueia a frente atual (o gate marca
sempre; o que degrada é severidade ou cobertura de um caso raro, nunca a segurança do que já pega):

1. SIGLA EM CAIXA ALTA. Nomes que são sigla pura em CAIXA ALTA (ADN, e fabricações tipo ABM/ADM que
   o LEIA-ME cita) NÃO são extraídos pelo gate, de propósito, pra não marcar todo cabeçalho (ITEM,
   CNPJ, AGO) como nome. O caso que motivou a frente não depende disso. Fabricação em sigla pura
   passaria hoje. Distinguir "ADN empresa" de "CNPJ/AGO cabeçalho" é problema de classificação com
   risco de falso positivo; NÃO amplia escopo de um gate que já funciona. Decisão do Matheus
   (2026-07-16): canal dedicado de siglas só se a necessidade aparecer numa ata real.
2. ANAFÓRICA CRUZANDO FRASE ("a proposta ... obteve N votos", proposta = empresa citada frases
   antes): não resolvível deterministicamente. Nome fabricado ainda cai como 'suspeito' (marcado),
   só não vira 'critico'.
3. VERBO ISOLADO ABRINDO FRASE ("Procedeu-se à votação: N votos", sem entidade nomeada): pode virar
   objeto de voto e, se fora da fonte, um falso 'critico'. Raro e visível (marca, não remove).

As três estão detalhadas na seção LIMITAÇÕES CONHECIDAS acima e não têm teste de harness hoje.

## 3a rodada de revisão (2026-07-16): mais dois escapes reais, corrigidos

O revisor achou, de novo em suíte verde (28/28), dois escapes: (1) sufixo com ponto ("Ltda.",
"S.A.") era tratado como fim de frase por _sentencaAoRedor, orfanava o objeto do voto e um nome
fabricado com votos saía LIMPO (e, na variante, o voto era atribuído falsamente à entidade da
oração seguinte); (2) ':' de volta como início de frase reabriu o escape de nome fabricado
abrindo item de lista ("Fornecedores consultados: Xurupita..."). Corrigido: ponto só é fim de
frase se seguido de espaço E maiúscula (abreviação comercial não parte a frase); ':' saiu do
início de frase; e a supressão de falso positivo em cabeçalho passou a ser por _GATE_ABERTURAS
(lista de aberturas gramaticais, categoria igual ao skip de conectivo e de sufixo, NÃO blacklist
de nome), não por tratar ':' como fim de frase. _GATE_GATILHO_NOME ampliado (prestador,
fornecedor, vencedor, loja, companhia, cia, síndico). Harness com 34 casos.

## 4a rodada de revisão (2026-07-16): 1 escape ESTRUTURAL corrigido, resto CAUDA

O revisor achou que o filtro _GATE_ABERTURAS vivia DENTRO de _gateRaizesDistintivas, que alimenta
OS DOIS pools. Um nome fabricado que colide com palavra de abertura (ex.: empresa "Assim") sumia
também do pool de OBJETO DE VOTO e escapava recebendo votos, veredicto LIMPO (ESTRUTURAL,
confirmado no dado). CORRIGIDO: o filtro de abertura saiu da função compartilhada e passou a valer
em _gateAfirmacoesNome SÓ quando NÃO há gatilho antes. "Considerando a urgência" (sem gatilho) é
gramática e é pulado; "empresa Assim" (com gatilho) é nome real e continua checado, inclusive como
objeto de voto. Fixtures R4-A/B/C adicionados. 38 casos no harness.

Os outros achados da 4a foram classificados CAUDA pelo critério de parada do Matheus (marca a mais
ou a menos, borda rara, miss VISÍVEL, nunca falha silenciosa porque o gate só marca):
- ANÁFORA + severidade: "empresa Turim Ltda. Diante da aprovação, a mesma obteve N votos" marca
  Turim como 'suspeito' (via gatilho) e não 'critico', porque o objeto do voto é o pronome "a
  mesma". Turim É marcado (visível), só não crítico. Raiz é anáfora, irresolvível determinístico.
- ABERTURA ANTES DE VOTO SEM ENTIDADE NOMEADA: "Procedeu-se à votação: N votos" (sem empresa) pode
  marcar a abertura como objeto de voto ('critico' falso) porque o pool de voto não filtra abertura
  de propósito (senão reabre o escape do Assim). Falso positivo VISÍVEL. Raro: ata real nomeia o
  que se vota.
- NOME REAL = ABERTURA em menção DESCRITIVA sem gatilho: uma entidade chamada exatamente como
  palavra de abertura ("Diante", "Nada"), citada sem gatilho e sem voto, não é marcada. Falso
  negativo em colisão rara.
- _GATE_ABERTURAS não cobre toda forma verbal ("Foi", "Houve", "Cumpre", "Aprovou"...): abertura
  faltando pode virar falso positivo após ':' se não estiver na transcrição. As comuns ("foi") a
  âncora salva (são ditas no áudio). Lista cresce sob ata real.
- _GATE_GATILHO_NOME não cobre "corretora", "consultoria", "assessoria": afeta só o pool isolado
  quando o nome abre frase por esses gatilhos. Impacto baixo.

## 5a rodada de revisão (2026-07-16): 1 ESTRUTURAL corrigido, 1 limitação inerente, resto CAUDA

- [ESTRUTURAL, CORRIGIDO] Frase que ABRE com o gatilho capitalizado ("Empresa Xurupita apresentou
  ...", "Síndico Zurupita conduziu...") saía LIMPO: temGatilho só olhava r.antes (antes do run), e
  a palavra gatilho era o 1o token DENTRO do run, então o run inteiro caía no descarte de início de
  frase. Confirmado no dado (controle "A empresa Xurupita" com artigo minúsculo marcava; "Empresa
  Xurupita" não). Corrigido com _GATE_GATILHO_INICIO (gatilho no começo do run também conta).
  Fixtures R5-A/B. 41 casos.
- [LIMITAÇÃO INERENTE, documentada] Entidade fabricada cuja raiz é EXATAMENTE uma palavra de
  abertura ("Fornecedores: Nada apresentou..."), sem gatilho e sem voto, escapa (limpo). Confirmado
  no dado. É limpo por formato, MAS a única forma de pegar seria tratar toda palavra de abertura
  ("Após", "Considerando", "Nada") como possível nome quando sem gatilho, o que inunda de falso
  positivo todo item de ata. Distinguir a empresa "Nada" do advérbio "nada" sem gatilho e sem voto
  é irresolvível determinístico. Colisão rara (nome real = palavra gramatical). Não é PIOR que o
  status quo pré-gate para esse token (o humano lê a ata inteira de todo jeito). Decisão do Matheus:
  tratada como CAUDA/limitação, não corrigida.
- [CAUDA] Palavra de abertura no pool de voto pode roubar o vínculo de placar de um nome em frase
  anterior e marcar o conector errado como crítico (generalização do "Procedeu-se: N votos"). Ainda
  marca (visível), não fica limpo.

NOTA ESTRUTURAL (para o próximo que mexer): este gate é um parser heurístico sobre português
livre. Tem cauda longa de casos de borda; três rodadas de revisão acharam bug real em suíte 100%
verde cada uma. _GATE_ABERTURAS e _GATE_GATILHO_NOME são listas que crescem e são a próxima
superfície provável de bug (abertura faltando vira falso positivo; nome real colidindo com
abertura vira falso negativo). Como a entrega é PARCIAL (marca, o frontend não trava), todo
resíduo dessa cauda é MISS VISÍVEL (marca a mais ou a menos que um humano vê), nunca falha
silenciosa em produção. O critério de parada proposto: cobrir os formatos que o motor de fato
gera mais a fixture, documentar o resto como limitação, e endurecer sob ata real quando aparecer.

---

## FRENTE FUTURA (não implementar agora): apresentação da assembleia como terceira fonte de verdade literal

Motivação: hoje o gate confere a ata contra a transcrição (áudio, fonte imperfeita) e o
cabeçalho contra o edital (texto literal, por isso acerta 100 por cento). A apresentação
(PPTX ou PDF) que o síndico mostra na assembleia costuma ter escritos os nomes das empresas,
os valores dos orçamentos e os itens de pauta. Anexada, ela vira uma fonte literal para o
corpo da ata, do mesmo jeito que o edital já é para o cabeçalho. Permite conferência cruzada
de até quatro fontes: edital, apresentação, transcrição, ata gerada.

Restrições de custo (decisão do Matheus, obrigatórias):
- A leitura da apresentação deve ser 100 por cento em código, extração de texto via
  biblioteca (pdfplumber ou pdf.js, que o projeto já usa), NUNCA via chamada de API ou modelo.
- Zero token gasto. A apresentação entra como texto literal para o gate, que já é código puro.
- Zero aumento no tempo de geração da ata: o gate roda depois da geração, como conferência,
  não antes nem durante.
- Opcional, nunca obrigatória: sem apresentação anexada, o gate roda só com a transcrição,
  como o desenho atual já prevê.

Dependência: essa frente depende do gate determinístico (a frente atual) estar pronto, porque
reusa a mesma maquinaria (existeLiteral, mencoesMonetarias) só que apontando para mais uma
fonte literal.

Discrepância entre apresentação e ata gerada é sinal forte de invenção. Nome que só aparece
na ata, e nem no slide nem na transcrição, é fabricação. Valor que difere do slide é erro de
leitura, não de deliberação.

Status: REGISTRADO, não iniciado. Só depois do gate atual fechado e validado.
