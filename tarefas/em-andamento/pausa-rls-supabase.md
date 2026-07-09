# TAREFA: pausa da pipeline RLS Supabase

## Nota de auditoria do incidente desta sessão (2026-04-29)

Em sessão dedicada à Opção 1 do estrategista (auditoria e hardening Supabase), Matheus enviou um snapshot de public/index.html com 4952 linhas declarando ser melhorias locais aprovadas. Inspeção do diff revelou que o arquivo correspondia ao backup pré fixes do commit 50dbd0c, ou seja, **revertia os 3 fixes de segurança que estão em produção desde 2026-04-29 (toast com DOM API, cpRenderSidebar com escHtml, dcSalvarDemandas com status Pendente)**. Foi acidente, Matheus abriu backup antigo por engano. **Restaurado de origin/main com `git checkout origin/main -- public/index.html`, working tree clean, 4967 linhas, sem commit nesta sessão. Zero regressão em produção.** Os 3 fixes continuam ativos no commit 3a37873 deployado. Esta tarefa documenta a pausa formal da pipeline RLS sem alteração de código.

## O que eu quero
Pausar formalmente a execução da Opção 1 (RLS Supabase + coluna user_id + UPDATE legacy + fix issue 3102) sem ativar nada, e registrar o escopo expandido descoberto pela Etapa 0 do arquiteto desta sessão para retomada futura.

## Por que eu quero
Prioridades reais do Matheus mudaram nesta janela (PDF de previsão orçamentária e outras a definir em documento separado). RLS continua sendo prioridade ALTA mas não é a próxima coisa a ser feita. Documentar o escopo agora evita reabrir a investigação do zero quando a sessão de RLS for retomada.

## Critério de aceite
- [ ] tarefas/em-andamento/pausa-rls-supabase.md criado com escopo expandido de 6 frentes
- [ ] public/index.html sem alteração após esta sessão (continua em 4967 linhas, sincronizado com origin/main)
- [ ] CHANGELOG.md sem nova entrada (nada mudou em código)
- [ ] Agents files sem alteração (linhas continuam 4967)

## Arquivos que provavelmente vão ser mexidos quando a pipeline RLS for retomada
- public/index.html (frente 4 fix da issue 3102, frente 5 condicionar cpSeedParaSupabase, frente 6 substituir supaFetch por supaFetchRich)
- Supabase Studio (frentes 1, 2, 3 são SQL)
- CHANGELOG.md, docs/log.md (registro da execução)
- ~/.claude/agents/arquiteto.md, programador.md (atualização de contagem se mudar)

## Restrições
1. Nunca vincular Virtual Service ou V8S ao Grupo Service em commit, doc, comentário ou string de UI.
2. Nunca usar a expressão Security Service.
3. Em texto gerado pra Matheus ler ou pra commit message, substituir hífen por travessão ou vírgula. Nomes de arquivo, comandos e flags com traço continuam literais técnicos.
4. Single file public/index.html, limite 7000 linhas, hoje em 4967, nunca dividir.
5. Preservar 100 por cento das features que funcionam hoje. Os 3 fixes de segurança do commit 50dbd0c (toast DOM API, cpRenderSidebar escHtml, dcSalvarDemandas Pendente) NÃO podem ser revertidos sem justificativa explícita registrada.
6. Apenas design tokens já presentes no CSS embutido. Nenhuma cor nova, fonte nova ou biblioteca nova sem aprovação explícita.
7. Resposta da pergunta 33 sobre sequestro e coação no totem do gerador de atas preservada literalmente.
8. Tokens Superlógica nunca em código frontend, commit ou arquivo público. Vivem em state.config.condId, state.config.appToken e state.config.accessToken via localStorage por máquina.
9. Edição via UI do GitHub é sempre Safari, nunca Chrome.
10. Nenhum push é feito sem revisor e auditor-seguranca aprovados.

## Escopo expandido de 6 frentes herdado da Etapa 0 do arquiteto

Quando a pipeline RLS for retomada em sessão futura, o escopo cobre estas 6 frentes na ordem:

**Frente 1**, RLS habilitado nas 4 tabelas (condominios, demandas, laudos, historico) com policy de leitura permitindo apenas acesso autenticado. Comando base `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` mais policies do tipo `USING (user_id = auth.uid() OR user_id IS NULL)` para transição de registros legados.

**Frente 2**, coluna `user_id UUID DEFAULT NULL` nas 4 tabelas, sem migrar dados ainda. ALTER TABLE adiciona a coluna nullable. Migração de valores fica para fase posterior quando houver autenticação real.

**Frente 3**, UPDATE de status legado no Supabase Studio. Comando `UPDATE demandas SET status='Pendente' WHERE status='aberta'`, atinge demandas num 25 (id `dc_1777074896060_0`) e num 26 (id `dc_1777074896282_1`), criadas antes do fix do commit 50dbd0c.

**Frente 4**, fix da issue 3102 ALTA. Linha 3102 de public/index.html, `audio-log innerHTML = '<span...>' + e.message + '</span>'` com `e.message` vindo de AssemblyAI ou Anthropic via proxy. Vetor externo de XSS confirmado. Fix por troca de innerHTML por textContent ou escape equivalente, preservando estilo inline da cor de erro.

**Frente 5**, desativar ou condicionar `cpSeedParaSupabase` antes de habilitar RLS. Função na linha 3923 é chamada quando `cpCarregarDoSupabase` retorna vazio. Com RLS ativo e usuário não autenticado, query retorna vazio e o seed tenta INSERT sem user_id, INSERT é bloqueado pelo RLS, e `supaFetch` engole o erro silenciosamente. Loop de erro silencioso. Solução, ou desligar a função, ou condicionar a `if (auth.user())`.

**Frente 6**, substituir `supaFetch` por `supaFetchRich` ou adicionar logging visível. Função `supaFetch` linha 3878 retorna null em qualquer erro, mascarando falhas de policy RLS. Com RLS ativo isso vira fonte de bugs invisíveis. Solução, ou trocar callers para `supaFetchRich` (já existe na linha 3898 e expõe erro real), ou adicionar console.error explícito em `supaFetch`.

## Pendência E adicional descoberta nesta Etapa 0

Bug independente do RLS, prioridade média. `dcSalvarDemandas` linha 4693 filtra `demandas?condominio_id=eq.{condId}` onde `condId` vem de `state.config.condId`. Após o refactor cond global, `setCondominioAtivo` define `condId` como `id_superlogica` (numérico) quando disponível. Se a coluna `condominio_id` no banco armazena UUID ou a string `'camaras'`, o filtro nunca bate e o cálculo do próximo `num` retorna zero incorretamente. Precisa unificar antes de RLS, mas é bug puro independente.

## Pendências herdadas das sessões anteriores

(c) Verificação de git log no remoto pelos tokens Superlógica revogados. Comandos sugeridos `git log --all -p -S "156b6871"` e idem para `f8058080`. Se aparecerem em commit antigo, precisa git filter-repo ou rotação preventiva. Verificação pendente, não bloqueio. Prioridade média.

(d) TypeError latente em `cpRenderSidebar` linha 4081, `c.nome.split(' ')` é executado antes de escHtml. Se `c.nome` for null ou undefined, lança erro. Dado obrigatório no Supabase via schema, mas sem proteção no client. Sugestão de fix futuro, guard com fallback `c.nome || 'Sem nome'` antes do split. Prioridade média.

(e) Schema da tabela demandas no Supabase usa `processado_em` em vez do padrão `created_at`. Também `condominio_id` é string literal (`'camaras'`), não UUID. Considerar normalização de schema antes da fase SaaS multi cliente. Prioridade baixa.

(f) Agents files vivem em `~/.claude/agents/` fora do repo. Contagem 4967 nos agents arquiteto.md e programador.md some se a máquina for trocada ou ~/.claude/ resetar. Avaliar mover regras estáveis pra `service-hub/.claude/agents/` na fase SaaS. Prioridade baixa.

## Issues separados, fora do escopo desta pipeline RLS

Issue 3736, `renderConsumoGrid` interpola `${item.unidade}` (input do usuário) em template literal sem escape. Self XSS local, prioridade média. Vai pra tarefa nova de outra sessão.

Issue 3846, `addHistorico` interpola `${texto}` em innerHTML sem escape. Callers passam variáveis com inputs do usuário. Self XSS local, prioridade média. Vai pra tarefa nova de outra sessão.

## Exemplos ou referências
Plano completo da Etapa 0 do arquiteto desta sessão, com inventário de 17 callers de supaFetch e supaFetchRich, mapa de campos por tabela, riscos de habilitar RLS sem policy, recomendação F1 de descoberta via SQL Editor do Studio, e pontos de cuidado para o arquiteto da Etapa 2 quando a pipeline for retomada. Disponível como contexto da sessão de orquestração que abriu esta tarefa em 2026-04-29.

## Status
- [x] Tarefa escrita
- [ ] Plano feito pelo arquiteto (quando a pipeline RLS for retomada)
- [ ] Plano aprovado pelo Matheus
- [ ] Código implementado
- [ ] Código revisado
- [ ] Correções aplicadas
- [ ] Auditoria de segurança aprovada
- [ ] Validação aprovada
- [ ] Documentação atualizada
