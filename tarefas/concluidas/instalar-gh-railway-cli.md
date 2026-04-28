# Tarefa: Instalar GitHub CLI e Railway CLI

## Objetivo
Instalar GitHub CLI e Railway CLI no Mac do Matheus, autenticar, linkar o projeto Service Hub no Railway e validar o fluxo CLI ponta a ponta.

## Critérios
1. Verificar se brew está instalado (`which brew`). Se não, parar e avisar o Matheus.
2. Instalar gh: `brew install gh`.
3. Instalar railway: `brew install railway` (alternativa: `npm install -g @railway/cli`).
4. Confirmar versões instaladas: `gh --version` e `railway --version`.
5. Pausar e avisar o Matheus pra rodar manualmente: `gh auth login` (escolher GitHub.com, HTTPS, sim pra autenticar git, login via browser).
6. Pausar e avisar o Matheus pra rodar manualmente: `railway login`.
7. Após confirmar autenticação, rodar dentro de `~/v8s/service-hub`: `railway link` e selecionar o projeto service-hub.
8. Validar com: `gh auth status`, `railway whoami`, `railway status`.

## O que NÃO fazer
- Nenhum commit, nenhum push nesta tarefa.
- É só infra local.

## Fluxo
Arquiteto → Matheus aprova → programador → documentador.

Pula auditor (sem código novo) e validador (sem deploy).
