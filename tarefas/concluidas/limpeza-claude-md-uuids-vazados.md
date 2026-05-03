# Tarefa: Limpeza dos UUIDs vazados no CLAUDE.md

## Objetivo
Remover todos os UUIDs antigos vazados do CLAUDE.md e da tarefa em andamento, substituindo por placeholder explícito.

## Contexto
- Em 27/04/2026, o Matheus girou os tokens Superlógica em produção (gerou novo token Service Hub V8S, configurou no localStorage via aba Configurações do Service Hub, revogou os 3 tokens antigos no painel Superlógica).
- Conexão Superlógica validada com "Conexão OK".
- Resta o cleanup técnico do repo: os UUIDs antigos ainda aparecem em texto plano em arquivos commitados.

## Critérios
1. Localizar TODAS as ocorrências dos UUIDs `156b6871`, `1492a3e1`, `81be8caf` no CLAUDE.md (não confiar em linhas específicas, buscar pelos prefixos).
2. Substituir cada ocorrência pelo placeholder `<configurado-via-Service-Hub-Configuracoes>`.
3. Mover `tarefas/em-andamento/seguranca-tokens-superlogica-vazados.md` para `tarefas/concluidas/`, conferindo se o corpo da tarefa não contém os UUIDs em texto plano. Se contiver, substituir pelo mesmo placeholder.
4. Documentador atualiza changelog: data 28/04/2026, vazamento de tokens Superlógica neutralizado, 3 tokens revogados no painel, novo token "Service Hub V8S" em uso via localStorage.

## Critério de aceite (auditor)
- `grep -rE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" CLAUDE.md` retorna zero.
- Mesmo grep recursivo em `tarefas/` retorna zero.

## Fluxo
Arquiteto → Matheus aprova → programador → revisor + auditor em paralelo → documentador.

Pula o validador (não toca código de produção).
