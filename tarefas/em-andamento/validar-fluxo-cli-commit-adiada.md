# Tarefa: Validar fluxo de commit via CLI sem Safari (ADIADA)

> **Adiada em 28/04/2026. Aguardando implementação do roadmap de produtividade (Nível 0 e 1) antes de executar.**

## Objetivo
Testar o fluxo de commit completo via terminal sem passar pelo Safari, com checagem de deploy via Railway CLI.

## Critérios
1. Dentro de `~/v8s/service-hub`, fazer uma alteração trivial: adicionar uma linha no final do CLAUDE.md tipo `[teste fluxo CLI 28/04]`.
2. Rodar: `git status`, `git diff`.
3. Pedir aprovação do Matheus antes de commitar.
4. Após aprovação: `git add CLAUDE.md`, `git commit -m "test: validar fluxo CLI sem Safari"`, `git push origin main`.
5. Rodar `railway logs --deployment` por 30 segundos pra confirmar deploy.
6. Após confirmar deploy, fazer outro commit removendo a linha de teste e push.

## Critério de aceite
- Deploy do Railway concluiu sem erro, log mostra "Deployment successful" ou equivalente.

## Fluxo completo
Arquiteto → Matheus aprova → programador → revisor + auditor em paralelo → validador → documentador.

## Dependência
Requer as tarefas `instalar-gh-railway-cli.md` e `aliases-zsh-cli.md` concluídas antes.
