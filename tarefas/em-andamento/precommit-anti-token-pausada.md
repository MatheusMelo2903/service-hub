# Tarefa: Pré-commit hook anti-token (PAUSADA)

> **Pausada em 27/04/2026 por descoberta de vazamento ativo de tokens Superlógica no CLAUDE.md público. Retomar após cleanup (`seguranca-tokens-superlogica-vazados.md`).**

## Objetivo
Instalar um hook git local que roda antes de cada commit e bloqueia automaticamente se detectar qualquer padrão de chave de API conhecida no código sendo commitado. Última linha de defesa contra vazamento de credenciais, especialmente em commits feitos fora do fluxo dos 8 subagentes (hot fix, edição manual, correção rápida).

## Contexto
- O auditor-seguranca já checa tokens dentro do fluxo dos 8 subagentes
- Mas commits fora do fluxo (manuais, urgentes) não passam por ele
- Caso AssemblyAI ficou exposto por meses justamente por não ter checagem automática
- Hook é defensivo, não substitui o auditor, complementa

## Padrões de token a detectar
O hook deve bloquear commit se qualquer arquivo staged contiver:

1. OpenAI: `sk-[A-Za-z0-9]{40,}` ou `sk-proj-[A-Za-z0-9_-]{40,}`
2. Anthropic: `sk-ant-[A-Za-z0-9_-]{90,}`
3. AssemblyAI: hex de 32 caracteres associado a variáveis com nome contendo ASSEMBLY ou assemblyai (case insensitive)
4. Supabase service role: `sb_secret_[A-Za-z0-9_-]{30,}` (a anon publishable é OK, é projetada pro frontend)
5. Superlógica: UUIDs hardcoded em variáveis com nome contendo TOKEN ou token, exceto se estiverem em superlogica-proxy-production.up.railway.app (domínio do proxy é público)
6. Genérico: qualquer linha com `process.env` seguido de export ou de string literal longa (sinal de chave hardcoded como fallback)

## O que NÃO bloquear
- Comentários explicando que tokens vão pra .env
- Strings tipo "SEU_TOKEN_AQUI", "PLACEHOLDER", "exemplo"
- Tokens dentro de docs/log.md ou tarefas/concluidas/ (são registro histórico de achados, não vazamento ativo)
- A SUPA_KEY anon publishable hardcoded no public/index.html (já catalogada na tarefa seguranca-supabase-rls.md, é por design do Supabase)

## Estrutura técnica
- Arquivo: .git/hooks/pre-commit
- Linguagem: bash puro (zero dependência)
- Executável: chmod +x .git/hooks/pre-commit
- Comportamento ao detectar:
  - Imprime no stderr: nome do arquivo, linha, padrão detectado
  - Sai com código 1 (bloqueia commit)
  - Sugere comando pra ignorar em emergência: git commit --no-verify (mas avisa que isso anula a proteção)

## Problema do .git fora do controle de versão
Hooks em .git/hooks/ não são versionados. Se outro dev clonar o repo, o hook não vem junto. Solução: armazenar o script em scripts/git-hooks/pre-commit dentro do repo, e criar um script de instalação scripts/install-hooks.sh que copia pro .git/hooks/.

Por enquanto eu sou o único dev. Aceitamos a limitação. Mas o script fica versionado em scripts/git-hooks/pre-commit pra eu reinstalar se trocar de máquina.

## Critérios de aceite
- Arquivo scripts/git-hooks/pre-commit criado, executável, comentado em português
- Arquivo scripts/install-hooks.sh criado, copia pro .git/hooks/ e dá chmod +x
- Hook instalado em .git/hooks/pre-commit nesta máquina
- Teste 1: criar arquivo temporário com sk-test1234567890abcdefghijklmnopqrstuvwxyz1234, tentar commitar, deve bloquear
- Teste 2: criar arquivo temporário com const ASSEMBLYAI_KEY = 'ca39770f7b1d490e8330b0cda616948a', tentar commitar, deve bloquear
- Teste 3: commit normal de mudança real (ex: editar docs/log.md) deve passar
- Teste 4: o próprio commit desta tarefa deve passar pelo hook (validação ao vivo)
- Documentado no CLAUDE.md em uma seção nova "Hooks de segurança"

## Riscos
- Risco 1: falso positivo bloqueando commit legítimo. Mitigação: padrões específicos com prefixos conhecidos (sk-, sk-ant-, sb_secret_), não regex genérica.
- Risco 2: hook pesa em commits grandes. Mitigação: usar git diff --cached --name-only e grep apenas em arquivos modificados, não no repo inteiro. Limite aceitável: 2 segundos.
- Risco 3: dev futuro não saber que existe e pular com --no-verify. Mitigação: registrar no CLAUDE.md com aviso de "não pular sem motivo claro".
- Risco 4: o teste 1 e 2 vão criar arquivos com tokens em formato de teste. Garantir que esses arquivos sejam apagados após o teste e nunca commitados (mesmo bloqueados pelo hook, ficam no working tree).

## O que NÃO mudar
- Fluxo dos 8 subagentes (auditor continua existindo)
- Nenhuma rota, nenhum código de produção
- Nenhuma variável Railway

## Subagente para começar
Arquiteto. Antes de qualquer linha de código, quero ver:
1. Lista exata dos padrões regex que vai usar pra cada tipo de token, com justificativa de cada (por que esse prefixo, por que esse comprimento mínimo)
2. Estratégia de exclusão dos falsos positivos (docs/log.md, tarefas/concluidas/, comentários, placeholders)
3. Decisão sobre como tratar a SUPA_KEY anon publishable hardcoded (regra explícita pra não bloquear)
4. Plano de teste: 3 cenários de bloqueio + 2 cenários de passagem
5. Reportar a lista pra mim antes de aplicar o código (regra do programador, vale aqui também).

## Estado da pausa
Plano do arquiteto já foi aprovado em conversa, mas implementação não começou. Quando retomar, basta reaproveitar o plano (regex, exclusões, plano de teste) e seguir pro programador.
