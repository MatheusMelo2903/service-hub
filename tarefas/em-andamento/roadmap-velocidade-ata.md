# ROADMAP DE VELOCIDADE E QUALIDADE DA ATA

Status: backlog. NAO executar agora. Documentado para depois do merge do pacote atual
(ata + unidades + previsao). Fonte: decisoes do Matheus em 2026-07-08.

## IDEIA CENTRAL (Matheus): fazer o maximo em paralelo, nao em fila

Hoje o motor processa as etapas SEPARADAS e em FILA: transcreve o audio inteiro, depois
gera a ata, depois audita o bloco 1, o bloco 2, o bloco 3 em sequencia. A direcao do
roadmap e sobrepor tudo que e independente, em vez de esperar uma fase terminar para
comecar a proxima:

- as auditorias de bloco ao mesmo tempo (Fase 2);
- a geracao comecando enquanto a transcricao ainda roda (Fase 3);
- a propria transcricao em pedacos paralelos dentro do AssemblyAI (Fase 5).

Meta: ata normal em cerca de 3 a 4 min mantendo qualidade 14/14.

## Contexto

O motor de ata hoje roda em fases sequenciais: primeiro a transcricao (AssemblyAI),
depois a geracao fracionada (Sonnet com auditoria de completude por blocos). O reteste
mediu a geracao de uma ata de 3h em torno de 8 a 15 min.

A correcao imediata de confiabilidade (teto do polling do front elevado de 10 para 25 min)
NAO e otimizacao de velocidade: so garante que a ata longa complete pelo fluxo real sem
estourar o timeout do front (antes o front desistia aos 10 min enquanto o job do servidor
ainda completava, gastando token sem entregar). As fases abaixo sao ganhos de verdade,
para depois do merge.

## FASE 2, paralelizar auditorias de bloco (velocidade)

As N auditorias de bloco sao independentes entre si. Hoje rodam em fila (uma apos a outra).
Passar para Promise.all (todas ao mesmo tempo).

- Ganho estimado: cerca de 1 a 2 min.
- Escopo: mudanca localizada no loop de auditoria de blocos, sem reestruturar o pipeline.
- Requisito de qualidade: reteste completo depois de implementar. Ver REGRA DE FERRO.

## FASE 3, sobreposicao de transcricao e geracao (velocidade)

Comecar a processar os primeiros blocos da transcricao enquanto o AssemblyAI ainda
transcreve o resto, sobrepondo as duas fases em vez de esperar a transcricao inteira
terminar (ideia do auditor de fundo).

- Ganho estimado: cerca de 3 a 5 min (ata de 3h cai para cerca de 5 a 9 min; ata normal
  cai para cerca de 3 a 4 min).
- Natureza: reestruturacao do pipeline. Fazer como projeto proprio, com validacao completa
  de qualidade depois, no mesmo rigor do gate atual (revisor + auditor + reteste).

## FASE 4, keyterms prompting no AssemblyAI (qualidade)

Passar ao AssemblyAI a lista de termos do dominio condominial para o modelo acertar mais
nesses termos: sindico, subsindico, quorum, fundo de reserva, fundo de obras, taxa
condominial, prestacao de contas, convencao, assembleia, edital de convocacao, rateio,
inadimplencia, e nomes recorrentes de condominios.

- Ganho: qualidade e fidelidade da transcricao nesses termos, sem custo de tempo.
- Requisito: reteste (a transcricao nao pode piorar em nenhum ponto).
- Observacao: o front ja envia um keyterms_prompt basico hoje; esta fase e ampliar e
  consolidar a lista do dominio.

## FASE 5, chunking paralelo da transcricao dentro do AssemblyAI (velocidade)

Em vez de mandar o audio de 3h inteiro e esperar sequencial, dividir o audio em pedacos e
transcrever SIMULTANEAMENTE (em paralelo) no proprio AssemblyAI, remontando na ordem.

- Ganho: ataca o piso fisico da transcricao (cerca de 5 a 9 min para 3h).
- Cuidado na remontagem: as bordas dos pedacos NAO podem cortar frase ou valor no meio.
  Usar overlap, como ja fazemos na auditoria fracionada.
- Combinada com a Fase 3, e o maior ganho possivel mantendo o AssemblyAI.

## META

Ata normal em torno de 3 a 4 min mantendo qualidade 14/14.

## LIMITE FISICO reconhecido

Para ata de 3h, o piso e cerca de 5 a 9 min enquanto o AssemblyAI for a transcricao.
Trocar de servico para um mais rapido esta DESCARTADO: Deepgram e Groq foram descartados
por risco de qualidade em valores e nomes. TODA otimizacao de transcricao e DENTRO do
AssemblyAI (Fase 4 de qualidade, Fase 5 de velocidade).

## REGUA REALISTA (criterio OFICIAL de qualidade da ata, aprovado 2026-07-08)

Substitui o antigo criterio "Enseada 14/14 identico sempre". O motor de ata e um
documento formal apoiado em fala humana, entao a barra e realista, nao mecanica:

1. Valor monetario CLARO na fala: consertado/inserido DETERMINISTICAMENTE por codigo,
   sempre presente na ata. Nunca perder valor claro. (Bug de garbling resolvido pela
   correcao cirurgica corrigirPlaceholdersDeliberacao no server.js.)
2. Valor GENUINAMENTE ambiguo no audio (pessoa fala e se corrige, inaudivel, conflito
   real): marcado [a confirmar] para revisao humana, NUNCA chutado. Marcar [a confirmar]
   num valor que o proprio audio deixou confuso e comportamento CORRETO de documento
   formal, nao bug.
3. Ruido (hipoteticos, exemplos, propostas rejeitadas, arredondamentos de fala): fora da
   ata, como o gabarito humano faz.

CRITERIO DE "PRONTO" (substitui "14/14 identico sempre"): os valores-alvo consertados de
forma CONSISTENTE nas rodadas + os pontos de conflito real marcados [a confirmar] de forma
previsivel (nao viram valor inventado). Percentual e medida seguem fora da contagem.

## REGRA DE FERRO (vale para TODAS as fases)

Nenhuma otimizacao de velocidade nem de keyterms sobe sem reteste completo de qualidade,
medido pela REGUA REALISTA acima:

- valores-alvo claros consertados de forma consistente entre rodadas (Enseada e Casablanca)
- conflitos reais marcados [a confirmar] de forma previsivel, nunca chutados
- percentuais e medidas nunca viram valor monetario (critico 1 do extrator)
- valores informais capturados

Velocidade e keyterms NUNCA compram perda de fidelidade. Se um ganho de tempo ou de
keyterms custar um ponto de qualidade, o ganho e descartado.

## Ordem sugerida

1. Fase 2 (menor risco, ganho rapido, mudanca localizada).
2. Fase 4 (keyterms, ganho de qualidade, baixo risco).
3. Fase 3 (sobreposicao transcricao e geracao, reestruturacao, gate completo).
4. Fase 5 (chunking paralelo da transcricao, remontagem com overlap, gate completo).

Todas so depois do pacote atual estar em producao e estavel.
