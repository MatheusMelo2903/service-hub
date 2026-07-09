# Roteador de estrutura para Importar Unidades

## Problema
O painel Importar Unidades falha em dois pontos:
- IA (Normalizar via IA) traz numero de unidades errado (reescreve linha a linha, contagem nao bate).
- Caminho direto (codigo) traz numero certo mas da erro e nao deixa filtrar nem enviar.

## Descoberta da analise das 7 amostras reais
Nao sao cabecalhos diferentes de UM formato. Sao 4 ESTRUTURAS distintas. Logo o trabalho nao e
"trocar a deteccao da linha 2530" e sim construir um ROTEADOR DE ESTRUTURA que classifica a
planilha numa das 4 familias e delega ao parser certo.

### As 4 familias
1. Plana: 1 linha = 1 unidade = 1 pessoa. Ex: Cadastro moradores (Unidade/Pavimento/Nome/CPF-CNPJ/Telefone/Email, cabecalho linha 0). 2 Etapa cai parcialmente aqui.
2. Larga por proponentes: varias pessoas nas COLUNAS 1o/2o/3o Proponente na mesma linha. Ex: CADASTRO 2 ETAPA. Precisa desdobrar 1 linha em N pessoas, todas Proprietario/coproprietario. Cabecalho linha 0.
3. Longa com coluna Tipo: varias linhas por unidade, papel na coluna Tipo. Ex: Villaggio COMERCIAL/RESIDENCIAL + os 2 PDFs. JA e a familia W045A que abrirRevisao trata. REAPROVEITAR. Cabecalho linha 3.
4. Larga Superlogica: proprietario + inquilino em blocos de colunas na mesma linha, 35 colunas. Ex: Quattro (.xls). processUnidadesData antigo JA le por posicao. REAPROVEITAR. Cabecalho linha 3.

## Regras do plano
- NAO fazer um parser universal unico. O roteador classifica e delega. 2 das 4 familias ja existem (unificada/antigo e W045A) e devem ser reaproveitadas, nao reescritas.
- Camada de ASSINATURA DE CONTEUDO obrigatoria: no Villaggio, telefone vazio empurra as colunas pra esquerda. Validar cada coluna por conteudo (CPF 11 digitos, CNPJ 14, email tem @, UF sigla de 2 letras, CEP 8 digitos, fracao decimal 0..1), nunca confiar so na posicao.
- Separacao CPF/CNPJ por tamanho: 11 digitos vai pra coluna G (CPF), 14 vai pra H (CNPJ). Regra dura, universal (7 de 7).
- Deteccao da linha de cabecalho real e pre-requisito (ora linha 0, ora linha 3). Detectar antes de qualquer mapeamento.
- Fracao: onde nao existe, vazia, nunca trava.

## PDF (os 2 W045A) e caso fragil
Se a extracao tabular vier suja (endereco concatenado numa celula, cabecalho na ~linha 4), NAO
forcar no codigo puro. Deixar cair no botao Normalizar via IA. PDF baguncado e justamente o 5%
pra que a IA existe. Nao gastar esforco tentando fazer PDF bagunçado funcionar 100% por codigo.

## Regra de ouro (ja parcialmente no codigo)
Normalizar via IA NUNCA importa direto no Superlogica. So PRODUZ a planilha 26 colunas e entrega
ao bloco Importar Unidades, unico ponto que valida, CONTA (pelo codigo, das linhas reais) e envia.
Tanto W045A quanto IA ja desaguam em abrirRevisao -> confirmarRevisao. NAO recriar esse funil.

## Contagem + filtro na tela de revisao (consertar)
- Mostrar: total de linhas lidas na origem X unidades geradas X pessoas geradas.
- Checkbox/filtro pra desmarcar linhas com erro e enviar so as validas (hoje nao funciona).
- Avisos sem travar: linhas descartadas, unidade sem proprietario, CPF/CNPJ invalido, unidade duplicada, coluna nao identificada.
- Botao baixar XLSX unificado corrigido + botao importar via API.

## DECISOES FECHADAS (fonte de verdade, nao reabrir)
1. Todas as 4 familias passam pela MESMA tela de revisao (contagem + filtro unificados). Nenhum caminho vai direto ao envio.
2. REGRA GERAL DO MOTOR (vale pra TODAS as familias): dentro de uma mesma unidade existe EXATAMENTE 1 proprietario. O Superlogica so aceita 1 proprietario por unidade.
   - Proprietario titular (o 1o, ou o unico) -> FL_PROPRIETARIO_CON=1, recebe cobranca, telefone dele fica na unidade.
   - Todo mundo que NAO for inquilino explicito (tipo declarado) -> dependente (ID_TIPORESP_TRES=4).
   - Inquilino explicito (coluna Tipo = Inquilino) -> ID_TIPORESP_TRES=7 (comportamento atual mantido).
   - Familia 2 (proponentes): 1o Proponente = proprietario titular; 2o/3o e qualquer extra = dependente.
   - NOME PURO. Nenhuma marca. Cancelado o "(COPROPRIETARIO)" pedido antes. Nada entre parenteses, nada na observacao. So o nome da pessoa.
   - Motivo: nao existe tipo proprio de coproprietario no Superlogica; 4 (dependente) e 7 (inquilino) sao os unicos tipos extras comprovadamente aceitos (ver buildPayloadContatoExtra linha 4536 e POST/PUT do proprietario 4253/4284).
3. Linha invalida: EXCLUI do envio, mas SEMPRE aparece no chip "Com erro (N)" com o motivo visivel na linha (sem proprietario / CPF-CNPJ invalido / unidade duplicada / coluna nao identificada). Nunca descartar em silencio.

## RODADA 2 - CORRECOES (revisor reprovou, 4 bloqueadores + 4 moderados). Matheus aprovou consertar tudo.

BLOQUEADORES:
B1. Camada de assinatura de conteudo e codigo morto (assinarLinha nunca e chamada). Plugar de verdade.
    - Villaggio (familia 3 / W045A): AUTORIZADA correcao NAO DESTRUTIVA. Etapa de PRE-CORRECAO que reordena celulas deslocadas por assinatura de conteudo ANTES de parseW045AContatos, SEM tocar na logica de papel/agrupamento do parser. O parser recebe dado limpo e faz o que sempre fez. NAO reescrever parseW045AContatos.
    - Aplicar assinatura tambem nos parsers novos (plana/proponentes) pra validar coluna por conteudo.
B2. processFamiliaProponentes descarta linha com Unidade mas sem proponente em silencio (linha ~3268 `if (!pessoas.length) continue`). Nunca sumir em silencio (decisao 3). A unidade tem que entrar como item com erro "Unidade sem proprietario" e aparecer no chip.
B3. processFamiliaProponentes nunca le coluna Bloco/Grupo (ST_BLOCO_UNI sempre ''). Ler bloco por nome (bloco/grupo/empreendimento/torre). Senao unidades de blocos diferentes colidem na chave unidade+bloco e viram falso "duplicada".
B4. REGRA DE DOCUMENTO GENERALIZADA (vale pras 4 familias, nao so Quattro):
    - Validacao = "e CPF VALIDO (11 digitos) OU CNPJ VALIDO (14 digitos)". NUNCA "e CPF senao exclui".
    - Proprietario pessoa juridica (imobiliaria, SPE, construtora) e legitimo e comum, apareceu nas amostras. PJ TEM que passar.
    - Separacao por tamanho: 11 -> coluna G (CPF), 14 -> coluna H (CNPJ). Nenhum dos dois reprova o outro.
    - processUnidadesData (Quattro) poe o doc em prop_cpf seja CPF ou CNPJ. A validacao tem que aceitar 14 digitos ali tambem. Conferir que NENHUMA das 4 familias reprova PJ.

MODERADOS:
M5. validarUnidadesAgrupadas so valida proprietario; validar CPF/CNPJ de contatos_extras (dependente/inquilino) igual, com a mesma regra CPF-ou-CNPJ do B4.
M6. Contagem "linhas na origem" inconsistente: w045a usa contagem bruta, demais usam data_rows pos-filtro. Padronizar: "X linhas na origem" = mesma base pra todas as familias (linhas com conteudo real da aba, antes de filtros especificos de parser).
M7. Pre-filtro de data_rows (linha ~2515) assume coluna 0 = Unidade. Nem toda familia garante isso. Nao descartar linha por posicao fixa antes do parser da familia rodar.
M8. Falta teste automatizado contra amostras reais -> resolvido pelo HARNESS abaixo.

## HARNESS (obrigatorio nesta rodada, igual ao da Previsao)
Script Node em scripts/import-unidades-harness/ que roda o roteador + parsers contra as 7 amostras reais e imprime, POR ARQUIVO:
- nome do arquivo
- familia detectada
- linhas na origem
- unidades geradas
- pessoas geradas separadas: proprietario / inquilino / dependente
- linhas com erro (e o motivo)
Se algum numero nao bater com a planilha real, o harness acusa (exit code != 0 ou linha FAIL destacada).
LGPD/tenant: as 7 planilhas reais NAO vao pro git (memoria: nao commitar planilha de cliente). O harness LE os arquivos do diretorio de Downloads por caminho absoluto (ou de um dir configuravel via env), e as fixtures ficam no .gitignore. Extrair as funcoes puras do index.html pro Node segue o padrao de scripts/previsao-harness/.
Amostras (as 7 unicas, ver Downloads):
- Cadastro moradores.xlsx (familia 1 plana, 313)
- CADASTRO 2 ETAPA (1).xlsx (familia 2 proponentes, 224)
- Cadastro das unidades - COMERCIAL (4).xlsx (familia 3 W045A, ~248)
- Cadastro das unidades - RESIDENCIAL (3).xlsx (familia 3 W045A, ~878)
- unidades_quattro_residencial_clube (3).xls (familia 4 Quattro, 528) [precisa converter xls->xlsx ou ler via lib]
- Cadastro de Proprietarios (2).pdf (W045A PDF, 277) [se PDF sujo, cai no fallback IA - harness so registra "PDF -> IA"]
- Cadastro das unidades (6).pdf (W045A PDF, 72) [idem]

## RODADA 3 - CONSERTOS (achados na verificacao read-only, Matheus autorizou)
C1. LEITURA ROBUSTA DE CAMPO NUMERICO LONGO (root cause de PJ excluido).
    - Hoje processFile (linha ~2493-2496) le com XLSX.utils.sheet_to_json(ws,{header:1, raw:false, dateNF:'DD/MM/YYYY'}). raw:false formata numero grande como notacao cientifica: CNPJ 62232889000190 vira "6.22329E+13" -> 8 digitos -> documento perdido. 33 casos no COMERCIAL, 18 no RESIDENCIAL (51 PJ so nesses 2 arquivos: bancos, imobiliarias, LTDAs).
    - CONFIRMADO que quebra em producao tambem (mesma opcao raw:false no navegador).
    - Fix: ler mantendo os digitos completos de QUALQUER campo numerico longo (CNPJ, CPF, telefone, RG, CEP, unidade), sem notacao cientifica. Datas continuam dd/mm/aaaa. Abordagem recomendada: ler com raw:true + cellDates:true e mapear cada celula (numero inteiro -> String(n) digitos completos; Date -> dd/mm/aaaa; resto -> String). Aplicar no processFile E no harness (run.js lerLinhasCru).
    - CUIDADO: nao regredir CPF com zero a esquerda ja armazenado como texto (ex "00767920724"); raw:true preserva texto como texto. Numero sem zero a esquerda ja perdeu o zero na origem, fora do nosso alcance.
C2. VALIDACAO DE DOCUMENTO NO CAMINHO W045A (familia 3).
    - Hoje o branch w045a (processFile linha ~2526) faz corrigirDeslocamentoW045A -> parseW045AContatos -> inferirPapeis -> abrirRevisao, SEM nunca setar _valido/_erros. Documento faltando/invalido em W045A nao aparece no chip "Com erro" e subiria em silencio. Fere decisao 3 e B4.
    - Fix: validar documento (CPF 11 OU CNPJ 14, regra do B4) por contato no caminho W045A antes de abrir a revisao, marcando _erros/_valido, pra cair no chip "Com erro". Nao reescrever parseW045AContatos nem inferirPapeis; validar por cima da lista de contatos que eles produzem.
POS: re-rodar o harness e provar (a) 7/7 continuam batendo E (b) os 51 PJ agora passam com CNPJ completo (14 digitos). Incluir no output do harness uma contagem de PJ (doc 14 digitos) por arquivo pra evidenciar.

## STATUS FINAL (rodada 3, gate pre-PR)
- Auditor: SEGURO PARA COMMIT. Revisor: APROVADO.
- Harness 7/7. 51 PJ recuperados (0 notacao cientifica, CNPJ 14 digitos). CPF com zero a esquerda intacto. W045A agora acusa erro (nao sobe em silencio).
- Panorama confirmado: marco ouro commit 014d72f (2026-04-30, inquilino+dependente) + fracao ee1fc03 (2026-04-29), ambos EM PRODUCAO. Motor novo reproduz o marco campo a campo (fracao + nome/CPF/celular de prop/dependente/inquilino, sem misturar). Send path byte-identico a producao. Doc: tarefas/em-andamento/panorama-import-unidades.md.
- Preocupacao de data/fuso (UTC-3) do auditor: DERRUBADA pelo revisor (cellDates:true do SheetJS calibra getters locais; sem off-by-one).

## PENDENCIAS CONHECIDAS (nao bloqueiam o PR, registradas)
- M1: CPF/CNPJ/CEP guardado como NUMERO com mascara de zeros pode perder zero a esquerda no raw:true. Verificado: 0 ocorrencias nas 7 amostras reais. Risco latente pra arquivos futuros. CEP (o unico silencioso) nao vai pro import. Hardening futuro: pad-left condicional se doc numerico vier < 11 digitos.
- M2: ao promover alguem a Proprietario na tela de revisao, _valido nao e recalculado, entao a unidade corrigida continua excluida do envio sem aviso. Pre-existente; C2 tornou relevante pro W045A. Rodada de UX separada: revalidar dentro de mudarPapelRevisao.

## Formato alvo (nao mudar)
26 colunas A a Z: A Tipo, B Unidade, C Bloco, D Fracao, E Metragem, F Nome, G CPF, H CNPJ, I RG,
J Data Nasc, K Genero, L Email, M DDI, N Telefone, O Tipo Telefone, P CEP, Q Endereco, R Numero,
S Complemento, T Bairro, U Cidade, V Estado, W Data Entrada, X Data Saida, Y Recebe Cobranca, Z Observacao.

## Ancoras no codigo (public/index.html, 7042 linhas)
- Roteador atual (parcial): detectarFamiliaPlanilha linha 2902 (so w045a-contatos vs null).
- Dispatch no processFile: linha ~2480 (if familia === 'w045a-contatos').
- Deteccao unificado x antigo: detectarFormatoPlanilhaUnificada linha 2530.
- Parser unificado 26 col: processUnidadesDataUnificada linha 2619 (REAPROVEITAR).
- Parser antigo Superlogica: processUnidadesData linha 2749 (REAPROVEITAR p/ familia 4).
- Parser W045A: parseW045AContatos 2967 + inferirPapeis 3177 (REAPROVEITAR p/ familia 3).
- Helpers deterministicos 2520 a 2611: dataBRtoUS, UF_CODIGOS/ufParaCodigo, generoParaCodigo, tipoTelefoneParaCodigo, recebeCobrancaParaCodigo, omitirVazios (REAPROVEITAR).
- Tela de revisao: abrirRevisao 3773, renderRevisao 3800, chips 3827, confirmarRevisao 3902.
- UI: cartoes nas linhas 1242 (Normalizar IA), 1283 (Revisao papeis), 1297 (Importar), 1312 (Preview).
