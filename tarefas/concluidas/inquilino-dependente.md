# Inquilino e Dependente via API Superlógica

Aberta em 2026-04-30 pelo Matheus.

## Objetivo

Estender o módulo Importar Unidades pra suportar 3 tipos de pessoa por unidade
(Proprietário, Inquilino, Dependente) usando o endpoint POST
`/v2/condor/unidades/post?ID_CONDOMINIO_COND={id}` da API REST do Superlógica
via proxy Railway. Validação cruzada da API já passou (status 200, ids reais
recebidos em 2026-04-30) e o caminho 1 está confirmado: NÃO mudar a
arquitetura do Hub, basta estender `enviarUmaUnidade`.

## Não pode quebrar

- Fluxo atual de POST + PUT que cria unidade vazia + popula Proprietário
- Fração ideal no nível raiz do PUT (`NM_FRACAO_UNI`)
- Concorrência: 10 unidades simultâneas com `Promise.allSettled`,
  `BATCH=10`, sleep 100ms entre lotes
- Helpers reaproveitados: `apiPost`, `getProxy`, `sleep`, `addLog`,
  `buildUrl`, `getHeaders`
- Parser antigo continua funcionando (planilha do Superlógica com 30+
  colunas, formato atual)

## Escopo

1. Detector de formato de planilha (antigo vs novo)
2. Parser da planilha unificada (26 colunas, 1 linha por pessoa)
3. Helpers: `omitirVazios`, `dataBRtoUS`, `ufParaCodigo`
4. Builders: `buildPayloadInquilino`, `buildPayloadDependente`
5. Integração no `enviarUmaUnidade`: depois do PUT do Proprietário
   sucesso, agrupa Inquilinos+Dependentes da mesma unidade e dispara
   chamadas individuais sequenciais via apiPost
6. Contadores e log: incluir contagem de inquilinos e dependentes
   por unidade

## Restrições

- NÃO commitar, NÃO push, NÃO deploy
- NÃO mexer em POST de unidade vazia nem no PUT do Proprietário
- NÃO usar hífen narrativo em texto que for gerado em UI/log/comentário
- Tokens NUNCA em código frontend, sempre via proxy
- Edição apenas de `public/index.html` local

## Estado de partida

- Arquivo: `public/index.html`
- MD5: `624ca565464a9e2dfb150d6c768def2f`
- Linhas: 4967 / Bytes: 295721
- Backup blindado: `~/Downloads/service-hub_BACKUP_20260430_143856.html`
- Função alvo: `enviarUmaUnidade` (linhas 2691 a 2787)
- Parser atual: `processUnidadesData` (linhas 2253 a 2347)
- Loader: `processFile` (linhas 2196 a 2235)

## Roteiro de teste manual (Matheus)

Cond 167, ID_UNIDADE_UNI 35700 (A-0202 TORRE A). Subir planilha unificada
com 1 unidade: 1 Proprietário + 1 Inquilino + 1 Dependente. Validar na
tela do Superlógica que os 3 aparecem corretos.

## Dados validados em produção (2026-04-30)

- Inquilino: status 200, msg "A-0202 TORRE A - Sucesso", id_unidade_uni
  35700, id_inquilino_con 81343
- Dependente: status 200, id_contato_con 81326 e 81343
- Tipo do contato definido APENAS por ID_TIPORESP_TRES e ID_LABEL_TRES:
  Proprietário=2, Inquilino=7, Dependente=4
- Datas em formato AMERICANO m/d/Y (ex: 04/30/2026), com sufixo
  ` 00:00:00` em DT_ENTRADA_RES e sem hora em DT_NASCIMENTO_CON
- Estado é código numérico (8=ES, 25=SP, 19=RJ, 11=MG, 5=BA), descobrir
  os outros via GET /condominios/get conforme aparecerem
- CPF de Dependente pode ser vazio
- Campos vazios são OMITIDOS (não enviar string vazia em opcional)

## Passagem pelos 8 subagentes

Sequência: arquiteto → programador → revisor + auditor (paralelo) →
validador → documentador → professor → estrategista. Log consolidado em
`docs/sessoes/session_inquilino_dependente_20260430.md`.

## Validação local

- Data: 2026-04-30
- Planilha: `teste_unidade_real_1102_A2.xlsx`
- Cond: 167 (Residencial Teste)
- Unidade: 1102 A2 (Villagio Residencial)
- Resultado do log:
  - POST OK
  - PUT OK
  - INQ OK
  - DEP OK
  - RES inq 1 ok dep 1 ok
- Pessoas cadastradas:
  - Proprietária: Paloma
  - Inquilino: André
  - Dependente: Renata
- Conclusão: feature pronta pra produção, sem erro em nenhum passo.

## Conclusão

- Status: CONCLUÍDA
- Data de conclusão: 2026-04-30
- MD5 final: `dd9df99169721ff1c834f70f8fe57004`
- Linhas finais: 5338 (partiu de 4967, +371 linhas)
- Subagentes que passaram (8 de 8):
  1. Arquiteto: APROVOU o plano de implementação
  2. Programador: implementou em 3 rodadas (V1, V2 com correções, V3 com ajuste de ressalva)
  3. Revisor: APROVADO em V3 após 1 ressalva resolvida
  4. Auditor de segurança: APROVADO na V2 com zero violações novas e zero tokens vazados
  5. Validador: APROVADO 47/47 checks, payload byte a byte conforme payload validado em produção
  6. Documentador: documentação atualizada em CLAUDE.md, CHANGELOG.md, docs/log.md, service-hub.md
  7. Professor: participou da sessão (passagem confirmada)
  8. Estrategista: participou da sessão (passagem confirmada)
