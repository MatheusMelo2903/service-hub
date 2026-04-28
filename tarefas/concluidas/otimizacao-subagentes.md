# Tarefa: Otimização do fluxo de subagentes (Tarefa A do roadmap)

## Status
- [x] Concluída em 2026-04-27

## Objetivo
Acelerar o ciclo de cada tarefa sem perder qualidade. Hoje cada tarefa passa por arquiteto, programador, revisor, auditor, validador e documentador em sequência. Algumas etapas podem rodar em paralelo, alguns subagentes desperdiçam contexto, e o documentador às vezes deixa passar inconsistências.

## Contexto
- Fluxo atual está em CLAUDE.md, seção "Fluxo de trabalho obrigatório"
- Subagentes definidos em ~/.claude/agents/ ou similar (confirmar com arquiteto)
- Modelos atuais: todos em Opus exceto o que vier a mudar nesta tarefa
- A entrega é configuração e regra escrita, não funcionalidade do produto

## Mudança 1: Paralelização revisor + auditor de segurança

Hoje a ordem é programador → revisor → auditor → validador. Revisor e auditor podem rodar EM PARALELO, porque um olha qualidade de código e o outro olha tokens/segurança. São análises independentes.

Solução exigida:
- Atualizar a seção "Fluxo de trabalho obrigatório" do CLAUDE.md
- Deixar explícito que revisor e auditor de segurança rodam em paralelo após o programador
- Validador continua sendo o gargalo final, depois dos dois
- Esclarecer que se um dos dois reprovar, o programador corrige antes do validador

## Mudança 2: Programador lê arquivos em blocos otimizados

Hoje o programador às vezes lê 5 a 20 linhas via sed/grep e perde contexto, ou lê o arquivo inteiro mesmo quando é gigante. Definir regra clara:

- Arquivo com menos de 1500 linhas: ler INTEIRO de uma vez
- Arquivo entre 1500 e 5000 linhas: ler em blocos de 200 linhas
- Arquivo com mais de 5000 linhas: ler em blocos de 500 linhas
- NUNCA ler trechos de 5 a 20 linhas via sed isolado, isso só serve pra confirmar pontos específicos depois de ter contexto

Solução exigida:
- Adicionar essa regra no CLAUDE.md numa seção própria pro programador
- OU adicionar essa regra na definição do subagente programador (qual for mais consistente com o resto do projeto)

## Mudança 3: Documentador em Sonnet COM auto-validação obrigatória

Documentador hoje roda em Opus (caro). Tarefa de documentação é mais simples e Sonnet dá conta. MAS, pra evitar inconsistências (data errada, item esquecido), o Sonnet precisa rodar uma auto-validação no final:

- Executar `git diff --stat HEAD~1` e comparar com o changelog que ele acabou de escrever
- Reler a tarefa original e confirmar que todos os itens marcados como concluídos foram cumpridos
- Confirmar data via `date +%Y-%m-%d` e usar essa data no changelog
- Se achar inconsistência, CORRIGIR antes de declarar concluído. Não declarar concluído com erro.

Solução exigida:
- Mudar modelo do documentador pra Sonnet
- Atualizar a definição do subagente documentador com a checklist de auto-validação obrigatória no final do prompt

## Mudança 4: Cache de contexto no CLAUDE.md

CLAUDE.md é carregado em toda invocação. Se for grande, custa tokens repetidos. Onde for suportado, ativar cache_control pra esse arquivo.

Solução exigida:
- Verificar se settings.json do Claude Code suporta cache do CLAUDE.md
- Configurar pra que o conteúdo do CLAUDE.md seja cacheado nos subagentes
- Documentar a configuração pra futura referência

## O que NÃO mudar
- Arquiteto, programador, revisor, auditor de segurança, validador continuam em Opus
- A ordem geral do fluxo permanece, só com paralelização adicionada
- Nenhuma alteração no código do Service Hub (server.js, public/index.html, public/landing.html)
- Outras seções do CLAUDE.md que não sejam relacionadas ao fluxo

## Critérios de aceite
- CLAUDE.md atualizado com a nova ordem (revisor + auditor paralelos)
- CLAUDE.md ou definição do programador atualizada com a regra de leitura em blocos
- Subagente documentador rodando em Sonnet, com auto-validação obrigatória no prompt
- Cache de contexto configurado para CLAUDE.md, se suportado pelo harness
- Próxima tarefa que rodar consegue testar na prática se o ganho é real

## Riscos
- Risco 1: paralelizar revisor e auditor pode confundir o orquestrador. Mitigação: arquiteto detalhar como invocar os dois em paralelo (multiple Agent tool uses no mesmo turno).
- Risco 2: Sonnet documentador pode passar erro mesmo com auto-validação. Mitigação: prompt do documentador deve ter passos explícitos numerados.
- Risco 3: cache de contexto não suportado em alguma rota do harness. Mitigação: tentar configurar, se não der, documentar que ficou pendente.
- Risco 4: regra de blocos pode não ser cumprida pelo subagente em alguns casos. Mitigação: deixar a regra muito explícita, sem ambiguidade.

## Subagente para começar
Arquiteto. Antes de qualquer alteração, quero ver:
1. Onde cada definição mora (CLAUDE.md, ~/.claude/agents/*.md, settings.json) e o formato exato de cada uma
2. Como instruir paralelização entre revisor e auditor de forma que o Claude orquestrador entenda
3. Estrutura exata da seção que vai entrar no CLAUDE.md para a regra de blocos do programador
4. Texto da auto-validação obrigatória do documentador, com passos numerados
5. Como configurar cache_control no settings.json do Claude Code, se for o caminho
6. Lista de arquivos a criar/alterar, com caminhos absolutos
