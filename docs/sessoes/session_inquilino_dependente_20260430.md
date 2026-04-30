# Sessão: Suporte a Inquilino e Dependente via API Superlógica

Data: 2026-04-30
Arquivo alterado: `/Users/matheusmelo/v8s/service-hub/public/index.html`
Backup blindado: `~/Downloads/service-hub_BACKUP_20260430_143856.html`
Status final: implementação local concluída, sem commit, sem deploy.

## Estado antes / depois

| Métrica | Antes | Depois |
|---------|-------|--------|
| Linhas | 4967 | 5338 (+371) |
| Bytes | 295721 | (verificar) |
| MD5 | 624ca565464a9e2dfb150d6c768def2f | dd9df99169721ff1c834f70f8fe57004 |

## Funções novas adicionadas

| Função | Linha início (aprox.) | Bloco |
|--------|---------------------|-------|
| detectarFormatoPlanilhaUnificada | 2264 | Helpers de parser |
| dataBRtoUS | 2275 | Helpers de parser |
| dataBRtoUSComHora | 2284 | Helpers de parser |
| ufParaCodigo | 2301 | Helpers de parser |
| generoParaCodigo | 2312 | Helpers de parser |
| tipoTelefoneParaCodigo | 2320 | Helpers de parser |
| recebeCobrancaParaCodigo | 2328 | Helpers de parser |
| omitirVazios | 2337 | Helpers de parser |
| processUnidadesDataUnificada | 2350 | Parser unificado |
| buildPayloadContatoExtra | 3205+ | Builders de payload |
| enviarContatoExtra | 3264+ | Helper de envio |

## Trilha dos 8 subagentes

### 1. Arquiteto

**Plano aprovado.** Diagrama de fluxo, posições de inserção, assinaturas de função, decisão sobre `apiPost` versus fetch direto (escolheu fetch direto pra acomodar query string ID_CONDOMINIO_COND), decisão sobre campos "vazio mas presente" (manter literalmente conforme payload validado em produção).

**Pontos críticos identificados antes do programador:** chave de agrupamento composta unidade|bloco, possibilidade de proprietário duplicado, risco de UF não mapeada cair silenciosa.

**Lacunas no plano corrigidas pelo orquestrador antes do programador:** lista incompleta de 26 colunas (faltavam CNPJ, DDI, Tipo Telefone, Data Saída), nome FL_SEXO_CON em vez de ID_SEXO_CON, nome FL_ENTREGACOBRANCA_RESP em vez de FL_RECEBECOBRANCA_CON, estrutura dupla de telefone (TELEFONES + ST_TELEFONE_CON).

### 2. Programador V1

Implementou 11 funções novas e integrou ao `enviarUmaUnidade`. Arquivo passou de 4967 para 5312 linhas. Estrutura HTML íntegra (3 scripts).

### 3. Revisor V1 — REPROVADO

1 bug crítico: `dataBRtoUS` na linha 2280 não invertia dia e mês, retornava dd/mm/yyyy quando a API exige mm/dd/yyyy.

Bugs moderados: UF inválida silenciosa (logFn=null), Proprietário duplicado sobrescrito sem aviso, comentário mentiroso sobre omitirVazios, omitirVazios dead code, detecção de cabeçalho da planilha unificada precisa aceitar "Tipo".

### 4. Auditor V1 — REPROVADO COM RESSALVAS

1 violação de hífen narrativo (em-dash) introduzida pelo diff novo na linha 2306, dentro de string de log da `ufParaCodigo`.

Resto limpo: zero tokens vazados, zero menção a Grupo Service em código novo, zero CPFs hardcoded, zero secrets de outras APIs, fluxo POST + PUT do Proprietário intocado, encodeURIComponent presente em condId.

### 5. Programador V2 — Correções aplicadas

6 correções: inversão dia/mês em dataBRtoUS, troca do em-dash por ponto na ufParaCodigo, UF silenciosa via push em array de avisos exibido por toast, Proprietário duplicado vira aviso sem sobrescrever, omitirVazios usado de fato em buildPayloadContatoExtra com campos "vazio mas presente" inseridos via .set() depois, detecção de cabeçalho aceita "Tipo" na coluna 0.

Linhas: 5337. MD5: 06adc0c162608a9bdadf45d6050f4e8d.

### 6. Revisor V2 — APROVADO COM RESSALVAS

Todas as 5 reclamações da V1 resolvidas. Nova ressalva: `ST_NUMERO_CON` ausente do payload de contato extra, descartando o número do endereço.

### 7. Auditor V2 — APROVADO

Hífen narrativo da V1 corrigido. Zero novas violações de segurança. omitirVazios real e função sem logging de dados de condômino.

### 8. Programador V3 — Ressalva resolvida

Adicionou `'contatos[0][ST_NUMERO_CON]': dados.numero || ''` no objeto opcionais da `buildPayloadContatoExtra`. Linha 3258. Linhas: 5338. MD5: dd9df99169721ff1c834f70f8fe57004.

### 9. Validador — APROVADO

47 de 47 checks passaram. Caso de teste local com planilha simulada (1 Proprietário + 1 Inquilino + 1 Dependente) gerou payloads byte a byte iguais aos validados em produção em 2026-04-30 (status 200, ids 81343 e 81326).

Confiança no envio: ALTA.

### 10. Documentador — Concluído

Atualizou: CLAUDE.md (estado atual), CHANGELOG.md (entrada de 2026-04-30), docs/log.md (entrada de 2026-04-30), service-hub.md (módulo de unidades + nova seção sobre importação unificada). Moveu tarefa de em-andamento para concluidas.

### 11. Professor — Guia escrito

`/Users/matheusmelo/v8s/service-hub/docs/guia-planilha-unificada.md` com tabela das 26 colunas, exemplo de unidade A-0202 com 1 Proprietário + 1 Inquilino + 1 Dependente, regras de preenchimento em linguagem clara para Matheus.

### 12. Estrategista — Próximos passos

`/Users/matheusmelo/v8s/service-hub/docs/proximos-passos-pos-inq-dep.md` com análise dos 3 passos pedidos: limpar lixo de teste do cond 167, apagar LJ17 do cond 168, criar Residencial com 777 unidades. Recomendação: commit/deploy primeiro, depois limpeza, depois onboarding.

## Roteiro de teste manual pendente (Matheus executa)

1. Fazer commit e push do `public/index.html` via Safari no GitHub.
2. Aguardar deploy automático no Railway.
3. Acessar https://service-hub-production.up.railway.app/hub.
4. Configurar tokens novos (faa8765c... e 0b88d525...) e cond 167 nas Configurações.
5. Subir planilha unificada com 1 unidade (A-0202 TORRE A) com 1 Proprietário + 1 Inquilino + 1 Dependente.
6. Validar na tela do Superlógica que os 3 contatos aparecem corretos.
7. Apagar manualmente os contatos de teste do cond 167 (DEP FETCH 01, TESTE DEPENDENTE API, INQ API REST 01).

## Restrições respeitadas

- Sem commit, sem push, sem deploy.
- Backup blindado preservado em ~/Downloads.
- Tokens nunca apareceram em código frontend (zero ocorrências dos 4 tokens listados).
- Sem hífen narrativo introduzido em código, log ou comentário pelo diff.
- Sem menção a Grupo Service em código novo (única ocorrência preexistente está no `<title>` da linha 6 e não faz parte do diff).
- POST de unidade vazia e PUT do Proprietário intocados.
