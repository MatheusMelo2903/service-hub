# Tarefa: Proteger rota /api/config que expõe OPENAI_KEY

## Status
- [x] Concluída em 2026-04-27 (consolidada na tarefa seguranca-tokens-expostos)

## Contexto
Achado durante a auditoria de segurança da tarefa "Landing page ServiceZone" em 2026-04-27.

## Descrição do problema
No arquivo `server.js`, linhas 14 a 16, existe uma rota pública sem autenticação:

```javascript
app.get('/api/config', (req, res) => {
  res.json({ openai: OPENAI_KEY });
});
```

Qualquer pessoa que acesse `https://service-hub-production.up.railway.app/api/config` recebe a chave da OpenAI da V8S em JSON. Com a landing agora pública como porta de entrada, a superfície de visitantes não autenticados aumentou.

## Risco
Vazamento da chave OpenAI permite que terceiros consumam a conta da V8S sem controle, gerando custos e podendo levar ao bloqueio da conta por uso abusivo.

## Objetivo
Eliminar a exposição da chave para o frontend. Opções a avaliar pelo arquiteto:
1. Remover a rota e mover todas as chamadas OpenAI para o backend, com endpoints proxy específicos (igual ao padrão Superlógica)
2. Restringir a rota por header interno ou origem confiável
3. Manter um endpoint público mas com rate limiting agressivo e chave de uso restrito

A opção 1 é a mais aderente ao padrão já adotado pelo projeto.

## Critérios de aceite
- [x] A chave OpenAI nunca aparece em resposta HTTP pública
- [x] Funcionalidades atuais que usam OpenAI (geração de atas, relatórios) continuam funcionando
- [x] Variável de ambiente `OPENAI_KEY` permanece apenas no Railway

## Subagente para começar
Arquiteto, para escolher a abordagem. Em seguida programador.

## Prioridade
Alta. Deve entrar imediatamente após a landing ServiceZone ir ao ar.

## Achado registrado por
Subagente auditor de segurança em 2026-04-27, durante auditoria da landing.
