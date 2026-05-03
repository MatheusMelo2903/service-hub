# Tarefa: Reforço da regra de reporte intermediário no programador

## Objetivo
Garantir que o subagente programador respeite instruções explícitas de "reportar antes de aplicar" ou "confirmar antes do Edit". Hoje o programador às vezes pula esse passo e aplica código direto, eliminando a chance do Matheus interromper antes de uma mudança arriscada.

## Contexto
- Aconteceu duas vezes nas últimas tarefas (landing-servicezone e api-404-catchall)
- Funcionalmente não causou problema nessas tarefas
- Em tarefa de risco maior (delete, migration, mudança de permissão, alteração de schema) o desvio pode causar estrago irreversível
- Solução: adicionar regra explícita no system prompt do programador

## Mudança única
Editar ~/.claude/agents/programador.md, adicionando o bloco abaixo logo após a regra de leitura de arquivos em blocos:

Regra de reporte intermediário (OBRIGATÓRIA):
Quando o prompt da tarefa pedir explicitamente "reportar antes", "confirmar antes de aplicar", "me mostrar antes do Edit" ou variação equivalente, PARE após o levantamento e devolva o resultado em texto puro na resposta. Não chame Edit, Write nem qualquer ferramenta de modificação até receber confirmação explícita do orquestrador.
Pular esse passo é falha de processo, não otimização. Mesmo que a mudança pareça óbvia ou de baixo risco, o reporte existe pra dar checkpoint humano antes de ações irreversíveis ou que envolvam decisão arquitetural.

## Critérios de aceite
- Bloco adicionado em ~/.claude/agents/programador.md, na seção logo após a regra de leitura em blocos
- Frontmatter (model, name, description, tools) preservado intacto
- Demais regras do programador preservadas

## Riscos
- Risco 1: arquivo do programador fora do git, sem controle de versão. Mitigação: cp programador.md programador.md.bak antes do edit, apaga o .bak depois que a próxima tarefa real rodar bem.
- Risco 2: subagente programador não pode editar a própria definição. Já sabido. Edit aplicado pelo agente principal direto, igual fizemos na otimizacao-subagentes.

## Subagente para começar
Pula o arquiteto, é mudança trivial de copy. Aplica direto:
1. cp ~/.claude/agents/programador.md ~/.claude/agents/programador.md.bak
2. Edit pra adicionar o bloco no lugar certo
3. Mostra o resultado final pra eu conferir antes do commit
4. Auditor passa rápido pra confirmar que frontmatter e demais regras seguem intactos
5. Documentador atualiza docs/log.md e move tarefa pra concluidas

Não precisa ciclo completo de revisor + validador, é mudança só de prompt do subagente, sem código de produção.
