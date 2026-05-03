# Tarefa: Remover tokens expostos no frontend

## Status
- [x] Concluída em 2026-04-27

## Objetivo
Eliminar duas brechas críticas de segurança: a chave AssemblyAI hardcoded no frontend e a rota /api/config que expõe a OPENAI_KEY publicamente. Ambas permitem que qualquer pessoa visite a URL pública e capture credenciais.

## Contexto
- Achados registrados em tarefas/em-andamento/auditor-token-assemblyai.md e tarefas/em-andamento/auditor-rota-api-config.md
- Ao final desta tarefa, essas duas tarefas devem ser fechadas (movidas pra concluidas)
- Sistema em produção em https://service-hub-production.up.railway.app/

## Brecha 1: ASSEMBLYAI_KEY_DIRECT no index.html
Em public/index.html, linha aproximada 2971, existe a constante:
const ASSEMBLYAI_KEY_DIRECT = 'REDACTED_ASSEMBLYAI_TOKEN_ROTACIONADO';

Essa chave é visível no código fonte do navegador. Qualquer pessoa pega.

Solução exigida:
- Remover completamente a constante do frontend
- Mover o token pra variável de ambiente no Railway (ASSEMBLYAI_KEY)
- Criar rota proxy no server.js que recebe a requisição do frontend, adiciona a chave do env, e encaminha pra AssemblyAI
- Frontend passa a chamar essa rota proxy ao invés da AssemblyAI direto
- Conferir que toda funcionalidade que usava a chave continua funcionando

## Brecha 2: /api/config vazando OPENAI_KEY
Em server.js, linhas 14 a 16 aproximadamente, existe a rota:
app.get('/api/config', (req, res) => {
  res.json({ openaiKey: process.env.OPENAI_KEY });
});

Essa rota é pública e devolve a chave OpenAI em JSON. Severidade alta.

Solução exigida:
- Apagar completamente a rota /api/config
- Identificar quem no frontend chama essa rota (provavelmente fetch para /api/config)
- Substituir cada uso por chamada a uma rota proxy no backend (ex: /api/openai/chat) que o backend executa internamente com a chave do env, sem nunca devolver a chave pro frontend
- Conferir que toda funcionalidade que usava a OpenAI continua funcionando

## Princípio geral
Nenhuma chave de API deve sair do servidor. Se o frontend precisa do resultado de uma chamada (transcrição AssemblyAI, resposta OpenAI etc), o backend faz a chamada e devolve apenas o resultado, nunca a chave.

## Variáveis de ambiente necessárias
Confirmar que existem no Railway (ou avisar pra Matheus configurar):
- ASSEMBLYAI_KEY (mover do hardcode pro env)
- OPENAI_KEY (já existe, só precisa parar de ser exposta)
- ANTHROPIC_KEY (já existe, conferir se também não está exposta)

## O que NÃO mudar
- Comportamento das funcionalidades pro usuário final (transcrição, IA, etc devem continuar funcionando igual)
- Nada da landing.html (essa tarefa não toca em landing)
- Estrutura de rotas / e /hub

## Critérios de aceite
- [x] Buscar por "ASSEMBLYAI_KEY_DIRECT" no public/index.html não retorna nada
- [x] Buscar por "OPENAI_KEY" no public/index.html não retorna nada
- [x] Buscar por "/api/config" como rota pública no server.js não retorna nada
- [x] curl https://service-hub-production.up.railway.app/api/config retorna 404 ou similar
- [x] Funcionalidades de IA (transcrição, chat) continuam funcionando
- [x] Sistema antigo em /hub não quebra

## Riscos
- Risco 1: quebrar funcionalidade existente que dependia da chave hardcoded. Mitigação: validador testar todas as features de IA antes do deploy.
- Risco 2: faltar variável de ambiente no Railway. Mitigação: avisar Matheus antes do push pra ele configurar no painel.
- Risco 3: chamadas pendentes em outras partes do código que esquecemos. Mitigação: grep exaustivo por OPENAI, ASSEMBLYAI, ANTHROPIC em todo o repositório.
- Risco 4: revogação dos tokens expostos não é parte desta tarefa, mas Matheus deve revogar e gerar novos depois do deploy (a chave atual pode já ter sido capturada).

## Subagente para começar
Arquiteto. Antes de qualquer linha de código, quero ver:
1. Mapa completo de onde cada chave aparece no repositório (grep total)
2. Estratégia de rotas proxy a criar (nomes, métodos, payloads esperados)
3. Lista de variáveis de ambiente necessárias e quais já existem no Railway
4. Plano de fallback se alguma rota proxy falhar (não pode quebrar produção)

## Pendências pós-deploy (responsabilidade do Matheus)
- Revogar a chave AssemblyAI vazada (REDACTED_ASSEMBLYAI_TOKEN_ROTACIONADO) no painel da AssemblyAI e gerar nova
- Atualizar ASSEMBLYAI_KEY no Railway com a chave nova
- Opcionalmente: remover OPENAI_KEY do Railway (não é mais usada por nenhuma rota)
