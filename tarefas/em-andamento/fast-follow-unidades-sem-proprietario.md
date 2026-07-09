# FAST FOLLOW: Tela de confirmacao de unidades sem proprietario (resolve o M2)

Status: documentado, NAO implementado. Fast follow apos o merge do pacote atual.
NAO bloqueia o merge. Fonte: decisao do Matheus em 2026-07-08.

## DECISAO DE MERGE (Matheus, 2026-07-08): SOBE COMO ESTA

Unidades entra no merge exatamente como esta em 144a040 (roteador + 4 familias).
A tela de "sem proprietario" NAO e implementada agora; vira SESSAO DEDICADA pos-merge.

Base da decisao (tudo provado por git nesta sessao):
- Nada de unidades depois de 144a040. `git log 144a040..dev -- public/index.html` = vazio.
  Os 6 commits posteriores sao todos de ata, em outros arquivos.
- Caminho de envio (enviarUmaUnidade, buildPayloadContatoExtra, validarDocumentosW045A)
  congelado desde antes ou no proprio 144a040.
- Matheus importou um condominio real com esse exato codigo e funcionou. Escrita real observada.
- Esta tela nunca foi escrita, logo nao ha regressao possivel vinda dela.
- M2 e caminho de borda (so na edicao de papel na revisao), nao afeta o fluxo normal.
  Unidade sem dono cai no chip "Com erro" e NAO sobe. Comportamento seguro.
- Email isolado no branch email-import-unidades + stash. NAO entra no merge.

ANTES de abrir a sessao dedicada, responder as duas pendencias de teste abaixo. Sem elas,
implementar a tela e construir no escuro:
(a) o Superlogica aceita proprietario so com nome generico, sem CPF? (testar em condominio
    de TESTE, NUNCA de cliente)
(b) o reimport incremental complementa sem duplicar?

## Problema (GAP M2)

Na tela de revisao de importacao de unidades, ao mudar o papel de um contato, o campo
`_valido` NAO recalcula. Consequencias:

- Situacao A: uma unidade corrigida (ex.: o usuario promoveu alguem a proprietario numa
  unidade que estava sem dono) pode ser excluida do envio EM SILENCIO.
- Situacao B: uma unidade sem dono pode subir malformada ao Superlogica.

Acontece poucas vezes no uso real (as planilhas de cliente ja vem com proprietario
definido), por isso e fast follow e nao bloqueador de merge.

## Solucao definitiva (decidida pelo Matheus)

Antes do envio, o sistema CONTA e AVISA. Mensagem ao usuario:

"Voce vai enviar X unidades. Destas, N estao SEM proprietario. O que deseja?"

Duas opcoes:

(a) SUBIR mesmo assim: as unidades sem dono sobem com um proprietario generico, nome
    exato "PROPRIETARIO NAO INFORMADO", SEM CPF, rastreavel depois.
    Caso de uso: unidade vazia de proposito. Planilha de 500 onde 5 nao tem dono: sobem
    as 500.

(b) NAO SUBIR as sem dono: envia so as unidades com proprietario.
    Caso de uso: Quattro. A planilha "diz" 500 mas o certo eram cerca de 256; as sem dono
    NAO devem subir ainda; reimporta depois quando o dado chegar.

Isso resolve M2 + situacao A + situacao B + o caso Quattro de uma vez, sem exclusao
silenciosa: tudo passa pela confirmacao consciente do usuario, no ponto do envio.

## Pendencias de teste (fazer quando for implementar)

1. Validar no Superlogica, em condominio de TESTE (NUNCA de cliente real), se ele aceita
   proprietario so com nome generico sem CPF.
2. Confirmar que o reimport incremental COMPLEMENTA (adiciona unidades novas) sem duplicar
   nem sobrescrever as ja existentes.

## Armadilhas a respeitar (da sessao que construiu a importacao)

- NAO mexer nas fases de validacao: `validarUnidadesAgrupadas` roda no parse (por unidade
  agrupada); `validarDocumentosW045A` roda no envio (por contato). Sao fases diferentes e
  NAO intercambiaveis. Reconstruir o agrupamento na lista plana quebra a validacao de
  todas as unidades.
- NAO "corrigir" o erro de CPF/CNPJ ausente do Quattro: e dado incompleto da planilha, nao
  bug do parser. Mascarar faria subir unidade sem CPF/CNPJ ao Superlogica.

## Por que isso substitui a correcao inline do M2

A correcao inline (recalcular `_valido` ao mudar papel) esbarra na Armadilha 1: para o
caminho agrupado, a estrutura de agrupamento nao existe mais na lista plana, e reexecutar
o validador certo exigiria reconstruir o agrupamento (proibido). A tela de confirmacao
resolve o problema no ponto do envio, sem tocar as fases de validacao, e ainda cobre o
caso Quattro (planilha incompleta) que a correcao inline nao cobria.
