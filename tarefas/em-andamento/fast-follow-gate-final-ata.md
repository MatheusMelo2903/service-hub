# FAST-FOLLOW do gate final (bloco ata dev→main, 2026-07-08)

Itens levantados pelo revisor e pelo auditor de segurança no gate final. NENHUM
bloqueia o merge (o único bloqueante, dado financeiro real em doc, já foi redigido).
Registrados aqui para não se perderem. NAO corrigir agora, sem ordem do Matheus.

## Segurança (auditor)

1. **Upload de áudio sem teto de content-length** (`server.js`, `/api/assemblyai/upload`).
   `req.pipe(pr)` faz streaming sem validar tamanho no servidor. Só usuário autenticado
   abusa, mas não há proteção de custo/DoS. Ação: recusar `content-length` acima de um
   teto (ex. 2GB) e contar bytes durante o streaming para abortar request sem header.

2. **Job de ata sem ownership por jobId** (`server.js`, `GET /api/atas/gerar/status/:jobId`).
   Só exige `requireAuth`, não checa se quem consulta criou o job. `atasJobs` não guarda
   dono. Qualquer autenticado com um jobId de outro puxa a ata gerada. Mitigado por UUID v4
   (não adivinhável) e pelo gap de isolamento já conhecido ("todo logado vê tudo"). Janela
   de exposição cross-usuário de até 10 min (tempo que a ata fica em memória). Ação: amarrar
   o job ao `sub` do JWT (ou authMode) e só devolver o payload se bater. Liga com a pendência
   de isolamento de tenant.

3. **Map `atasJobs` sem cap absoluto** (`server.js`). Só limpeza por tempo (10 min pós
   conclusão), sem teto de entradas nem de jobs simultâneos por usuário. Crescimento de
   memória limitado pelo rate limit global, mas sem teto duro. Ação: `MAX_JOBS_SIMULTANEOS`
   com rejeição 429.

4. **Rate limit dedicado no `/api/atas/gerar`** (opcional). O global de 60/min por IP em
   `/api/*` já cobre; a rota é cara (até 7 chamadas Anthropic por geração). Ação: considerar
   um teto mais apertado só para ela. Baixa prioridade.

5. **Remoção de `skills-server/Previsao_Naturale_2026.xlsx` do histórico** (planilha real de
   cliente). Pendência PRÉ-EXISTENTE, já em main hoje, não introduzida por este bloco. Ação:
   `git filter-repo` (ou similar) para apagar do histórico. Disruptivo (repo já pushado),
   coordenar entre os clones.

## Privacidade / dados de cliente

8. **Scrub de nomes reais de condomínio name-only em código/docs rastreados (~15 pontos).**
   O bloqueante real (nome + valor financeiro) já foi redigido antes do merge. Sobram os
   nomes SEM valor em ~15 pontos: comentários e texto de UI funcional em
   `public/previsao-modulo.html` ("Via Mar é fundo separado" aparece na tela), apelidos de
   fixture em `scripts/previsao-harness/run.js`, cliente de referência do molde em
   `services/prestacao-pdf/vendor/...`, atas de referência em `skills-server/ata-condominial.md`,
   e menções em `CLAUDE.md`/`ANALISE_ARQUITETO.md`. A regra do Matheus TOLERA nome sem valor,
   então NÃO bloqueia. Tarefa separada, requer cuidado: alguns são texto funcional de UI e
   apelidos de harness, NÃO são edição trivial de doc. Não fazer sem escopo dedicado.

## Produto / cosmético

6. **Bug cosmético de contraste na Previsão** (contraste baixo em "Frações por unidade",
   cabeçalho "Confira antes de gerar", valores dos cards de topo). CSS puro, zero risco a
   dado. Validado como fast-follow pelo Matheus no gate visual do dev.

7. **Tela de "unidade sem proprietário"** — nunca implementada, só documentada. Caminho de
   borda aceito. Ver `fast-follow-unidades-sem-proprietario.md` (M2).

## Qualidade (revisor) — já resolvidos neste ciclo

- Comentário-cabeçalho de `corrigirPlaceholdersDeliberacao` reescrito para refletir FIX 1/2/3/4.
- `scripts/ata-harness/cirurgica-unit-test.cjs` versionado (git add feito).
