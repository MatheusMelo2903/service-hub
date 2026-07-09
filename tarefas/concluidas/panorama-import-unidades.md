# Panorama completo da importacao de unidades (Service Hub)

Fonte da verdade. Reconstruido em 2026-07-07 a partir do git (dev e origin/main),
das notas em tarefas/ e da skill service-hub. Tudo com evidencia de commit e linha,
sem suposicao. Read only, nada enviado a API.

## (a) Linha do tempo, com o MARCO OURO destacado

| Data | Commit | O que entrou |
|---|---|---|
| origem | 61ae576 | Service Hub.html renomeado pra public/index.html. Ja havia POST + PUT criando unidade e populando proprietario (FL_PROPRIETARIO_CON). Uma pessoa por unidade. |
| 2026-04-29 | **ee1fc03** | "fracao ideal validada localmente": a FRACAO da unidade passa a ir no PUT via NM_FRACAO_UNI (nivel raiz), com cleanFracao normalizando virgula pra ponto. |
| **2026-04-30** | **014d72f** | **MARCO OURO.** "suporte a Inquilino e Dependente via planilha unificada". enviarUmaUnidade passa a encadear POST de unidade vazia + PUT do Proprietario + N POSTs de contatos extras. Cada papel com seu proprio nome, CPF e celular. Inquilino ID_TIPORESP_TRES=7, Dependente=4, ambos ID_TIPOCONTATO_TCON=1. Parser da planilha unificada 26 colunas + 7 helpers de conversao. Corpo do commit: "Validado em producao com unidade 1102 A2 do Villagio Residencial em 30/04/2026". |
| 2026-05-18 | (skill) | Formato unificado 26 colunas A a Z documentado na skill service-hub secao 3.5. |
| 2026-05-26 | 233d4a1 | Normalizador IA: documento qualquer vira planilha 26 colunas (fallback). Nao importa direto, so produz. |
| 2026-06-29 a 07-01 | 9d04c97, 95a4672, 1852c38, 89d0e38, a7f9524 | Familia W045A tabular (Contatos das unidades) + inferencia de papel por texto + parser de PDF W045A + tela de revisao de papel + filtro por status. |
| 2026-07-07 | (working tree, sem commit) | Roteador de estrutura + 4 familias + leitura robusta de numero longo + validacao de doc no W045A + harness 7/7. Motor novo desta sessao. |

Evidencia de que o marco esta em PRODUCAO: `git merge-base --is-ancestor 014d72f origin/main` e
`ee1fc03 origin/main` retornam verdadeiro. Ambos os commits estao na main.

## O MARCO OURO em uma frase

Desde 014d72f (30/04/2026), uma unica unidade sobe com: a FRACAO no valor certo, o NOME do
proprietario, do inquilino e do dependente, e o CPF e o CELULAR de CADA um separadamente, cada
pessoa no seu proprio cadastro, sem misturar. Esse e o comportamento de referencia que o motor
novo tem que reproduzir. E reproduz (secao c).

## (b) Formato que a API aceita, campo a campo (evidencia: linha atual em public/index.html)

Endpoint: POST/PUT em `{proxy}/v2/condor/unidades/post?ID_CONDOMINIO_COND={id}`. Nunca token no
front, sempre via getProxy/getHeaders. Padrao comprovado: POST cria unidade vazia, PUT popula o
proprietario, POSTs adicionais criam os contatos extras. Um proprietario por unidade (limite do
Superlogica); todo nao-inquilino explicito vira dependente.

### PASSO 1, POST de unidade vazia (p1, enviarUmaUnidade ~linha 4855)
| Campo | Valor | Observacao |
|---|---|---|
| ID_CONDOMINIO_COND | condId | raiz |
| ST_UNIDADE_UNI | numero da unidade | raiz |
| ST_BLOCO_UNI | bloco/torre/grupo | raiz, vazio se nao houver |
| ID_TIPOCONTATO_TCON | 3 | OBRIGATORIO na raiz (aprendizado de campo) |
| FL_FORMADERECEBIMENTO_UNI | 1 | obrigatorio |

### PASSO 2, PUT do proprietario (p2, ~linha 4874)
| Campo | Valor | Observacao |
|---|---|---|
| ID_CONDOMINIO_COND, ID_UNIDADE_UNI | ids | raiz |
| **NM_FRACAO_UNI** | u.prop_fracao | **A FRACAO. Nivel raiz do PUT, ponto decimal. So envia se houver valor.** |
| contatos[0][ID_CONTATO_CON] | idContato do POST | liga o contato criado |
| contatos[0][FL_PROPRIETARIO_CON] | 1 | marca como proprietario |
| contatos[0][ST_NOME_CON] | u.prop_nome | nome do proprietario |
| contatos[0][ST_CPF_CON] | u.prop_cpf | CPF do proprietario |
| contatos[0][ST_RG_CON], ST_EMAIL_CON | u.prop_rg, u.prop_email | |
| contatos[0][ST_TELEFONE_CON] | celular do proprietario, so digitos | u.prop_cel ou u.prop_fone |
| contatos[0][ST_TELEFONE_CON2] | fixo, quando houver | |

Nota registrada no codigo (confirmarRevisao ~4497): quando o proprietario e empresa (CNPJ), o
documento da empresa NAO vai no cadastro do proprietario (a API do proprietario espera CPF). Isso
e aviso, nao erro. O CNPJ e reconhecido e separado, mas o cadastro do titular PJ nao carrega o
documento nesse campo. Comportamento herdado do marco, nao introduzido agora.

### Contatos extras: inquilino e dependente (buildPayloadContatoExtra ~linha 5131)
Um POST por contato extra. Cada um com nome, CPF e telefone PROPRIOS.
| Campo | Inquilino | Dependente |
|---|---|---|
| contatos[0][ID_TIPORESP_TRES] | 7 | 4 |
| contatos[0][ID_LABEL_TRES] | 7 | 4 |
| contatos[0][ID_TIPOCONTATO_TCON] | 1 (morador, nao proprietario) | 1 |
| contatos[0][ST_NOME_CON] | nome do inquilino | nome do dependente |
| contatos[0][ST_CPF_CON] | CPF do inquilino | CPF do dependente |
| contatos[0][ST_TELEFONE_CON] | celular do inquilino, so digitos | celular do dependente |
| contatos[0][DT_ENTRADA_RES] | data de entrada (default hoje se inquilino) | quando houver |

Aprendizados de campo cruzados (skill service-hub 3.5 + nota inquilino-dependente.md):
ID_TIPOCONTATO_TCON obrigatorio na raiz do POST; telefone so digitos; POST vazio + PUT separado;
concorrencia BATCH=10 com Promise.allSettled e sleep 100ms; validado em producao (status 200, ids
reais) em 30/04/2026; o parser antigo (Superlogica 30+ colunas) e a base do caso Quattro (528
unidades).

## (c) O motor novo reproduz o marco? Confirmado campo a campo

Caminho do motor novo ate o envio (todas as 4 familias convergem aqui):
parser da familia -> unidadesAgrupadasParaContatos (~3190) -> lista plana com um item por pessoa,
cada um com papel/cpf/cnpj/telefone/fracao proprios -> contatoParaLinha26 (~3972) -> 26 colunas ->
processUnidadesDataUnificada (~2794) -> mesmo shape prop_* / contatos_extras do marco ->
enviarUmaUnidade / buildPayloadContatoExtra (INTOCADOS, byte-identicos a origin/main).

Prova em runtime (unidade sintetica com proprietario + inquilino + dependente, cada um com CPF e
celular distintos, rodada pelo motor real via harness):

| Campo do marco | Reproduz? | Evidencia (payload gerado pelo motor novo) |
|---|---|---|
| Fracao no NM_FRACAO_UNI | SIM | prop_fracao 0,012345 vira NM_FRACAO_UNI=0.012345 (virgula para ponto) |
| Nome do proprietario | SIM | contatos[0][ST_NOME_CON]=ANA PROPRIETARIA |
| CPF do proprietario | SIM | contatos[0][ST_CPF_CON]=11111111111 |
| Celular do proprietario | SIM | contatos[0][ST_TELEFONE_CON]=27999990001 |
| Nome do inquilino | SIM | POST extra ID_TIPORESP_TRES=7, ST_NOME_CON=BENTO INQUILINO |
| CPF do inquilino | SIM | ST_CPF_CON=22222222222 (proprio, nao o do proprietario) |
| Celular do inquilino | SIM | ST_TELEFONE_CON=27999990002 (proprio) |
| Nome do dependente | SIM | POST extra ID_TIPORESP_TRES=4, ST_NOME_CON=CACO DEPENDENTE |
| CPF do dependente | SIM | ST_CPF_CON=33333333333 (proprio) |
| Celular do dependente | SIM | ST_TELEFONE_CON=27999990003 (proprio) |

Nenhum dado se mistura entre papeis: o proprietario carrega a fracao e seus dados; cada contato
extra carrega os seus. A fracao so existe no proprietario (contato extra recebe fracao vazia, por
construcao em unidadesAgrupadasParaContatos). Confirmado tambem que o send path (enviarUmaUnidade,
buildPayloadContatoExtra) e byte-identico entre origin/main (producao) e a arvore de trabalho, ou
seja, o shape final e exatamente o comprovado em producao.

## (d) O que mudou da origem ate hoje, e por que

1. Origem: uma pessoa por unidade (so proprietario), POST + PUT. Sem fracao explicita.
2. ee1fc03 (29/04): fracao ideal validada e enviada em NM_FRACAO_UNI. Motivo: cobranca correta
   depende da fracao ideal.
3. 014d72f (30/04, MARCO): 3 papeis por unidade (proprietario, inquilino, dependente), cada um com
   documento e contato proprios, via encadeamento POST vazio + PUT proprietario + N POSTs extras.
   Motivo: cadastro completo do condominio, nao so o dono.
4. Normalizador IA (26/05): documento fora do padrao vira 26 colunas por IA, mas nunca importa
   direto, so produz. Motivo: cobrir formatos ineditos sem abrir mao da contagem por codigo.
5. Familia W045A + tela de revisao (fim de junho): ler planilhas e PDFs "Contatos das unidades" e
   revisar o papel antes de enviar. Motivo: as administradoras entregam esse layout.
6. Roteador + 4 familias + leitura robusta (07/07, esta sessao): classificar qualquer planilha de
   cadastro numa das 4 estruturas e delegar ao parser certo, tudo desaguando na MESMA tela de
   revisao e contagem por codigo. Correcao critica: numero longo (CNPJ) era lido como notacao
   cientifica e truncado, excluindo proprietarios pessoa juridica; agora le com digitos completos.
   Validacao de documento tambem no caminho W045A, pra nada subir em silencio. Motivo: acabar com
   os dois bugs (contagem errada da IA e caminho direto que travava/nao filtrava), sem quebrar o
   marco. O marco continua intacto: o motor novo so alimenta o mesmo funil de envio.

Conclusao: o motor novo NAO reescreve o caminho de envio do marco. Ele so entrega, no mesmo shape
comprovado em producao, dados classificados e validados por codigo. O marco ouro de 30/04/2026
segue sendo a referencia, e esta reproduzido.
