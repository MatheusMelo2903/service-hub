# Tarefa: Remover token AssemblyAI exposto no frontend

## Status
- [x] Concluída em 2026-04-27 (consolidada na tarefa seguranca-tokens-expostos)

## Contexto
Achado durante a análise da tarefa "Landing page ServiceZone" em 2026-04-27.

## Descrição do problema
No arquivo `public/index.html`, linha 2971, existe uma chave de API da AssemblyAI hardcoded e visível para qualquer pessoa que abrir o código fonte do site no navegador:

```javascript
const ASSEMBLYAI_KEY_DIRECT = 'ca39770f7b1d490e8330b0cda616948a';
```

Isso é um problema de segurança igual ao que já foi tratado com os tokens do Superlógica: tokens nunca podem aparecer em código frontend, em commit, ou em arquivo público. A regra está documentada no CLAUDE.md.

## Risco
Qualquer visitante do domínio pode pegar essa chave abrindo o inspetor do navegador e usar a conta da AssemblyAI da V8S. Possível consumo indevido, custos não controlados, e bloqueio da conta por uso abusivo.

## Objetivo
Mover a chave para variável de ambiente no Railway e fazer o frontend chamar via proxy, igual ao padrão já adotado para os tokens do Superlógica.

## Critérios de aceite
- [x] A string `ca39770f7b1d490e8330b0cda616948a` não aparece mais em nenhum arquivo do repositório
- [x] A funcionalidade que usa AssemblyAI continua funcionando após a mudança
- [x] Variável de ambiente configurada no Railway com nome claro (sugestão: `ASSEMBLYAI_KEY`)
- [x] Endpoint proxy criado no `server.js` que recebe a requisição do frontend e chama a AssemblyAI no backend
- [ ] Histórico do Git pode continuar contendo a chave (já está vazada), mas o time deve revogar a chave atual e gerar nova após a correção (pendência Matheus)

## Subagente para começar
Auditor de segurança primeiro, para mapear todos os pontos do código que usam a constante. Depois arquiteto para decidir o desenho do proxy.

## Prioridade
Média. Não bloqueia entrega da landing, mas precisa entrar na fila assim que a landing for ao ar.

## Achado registrado por
Subagente arquiteto durante o planejamento da tarefa landing-servicezone em 2026-04-27.
