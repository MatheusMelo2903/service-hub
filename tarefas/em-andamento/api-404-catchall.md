# Tarefa: Catch-all do server.js retornar 404 JSON em /api/* desconhecido

## Objetivo
Hoje qualquer rota não mapeada cai no catch-all e retorna a landing.html com status 200, inclusive `/api/qualquercoisa-inexistente`. Isso confunde debug de integrações e dá impressão errada de que a rota existe. Deve diferenciar:

- `/api/<rota-desconhecida>` → 404 com `{ "erro": "rota não encontrada" }`
- Qualquer outra rota desconhecida → continua servindo a landing (comportamento atual)

## Contexto
- Achado registrado durante a auditoria da tarefa `seguranca-tokens-expostos.md` em 2026-04-27
- Auditor de segurança classificou como severidade baixa, mas afeta diagnóstico de integração
- O catch-all atual está em server.js, perto da linha 56

## Solução exigida
- Adicionar uma rota específica `app.get('/api/*', (req, res) => res.status(404).json({ erro: 'rota não encontrada' }))` ANTES do catch-all geral
- Manter o catch-all atual `app.get('*', ...)` que serve a landing
- Confirmar que rotas válidas (`/api/assemblyai/*`, `/api/claude/messages`) continuam funcionando
- Confirmar que `/api/inexistente` agora retorna 404

## Critérios de aceite
- `curl -X GET https://.../api/inexistente` retorna 404 com JSON
- `curl -X POST https://.../api/assemblyai/upload` continua respondendo (500 com body vazio, comportamento atual)
- `curl -X GET https://.../qualquerpagina` continua servindo a landing
- Rota raiz `/` continua servindo a landing
- Rota `/hub` continua servindo o sistema

## Riscos
- Risco 1: a ordem das rotas precisa ser cuidadosa. `/api/*` 404 deve vir DEPOIS das rotas válidas e ANTES do catch-all genérico.
- Risco 2: rotas POST de proxy não devem ser afetadas (o catch-all `/api/*` é GET-only? avaliar se precisa cobrir POST também).

## Subagente para começar
Arquiteto. Plano deve definir ordem exata das rotas e se faz sentido cobrir métodos além de GET.

## Prioridade
Baixa. Pega depois da Tarefa A (otimização de subagentes).

## Achado registrado por
Auditor de segurança durante auditoria da tarefa `seguranca-tokens-expostos.md`.
