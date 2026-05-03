# Tarefa: Cleanup emergencial dos tokens Superlógica vazados no GitHub público

## Objetivo
Remover do código e do histórico git os dois tokens Superlógica que estão expostos publicamente, girar os tokens no painel Superlógica, atualizar o proxy no Railway, e decidir a estratégia de visibilidade do repositório daqui pra frente.

## Contexto
- Repositório MatheusMelo2903/service-hub é PUBLIC
- CLAUDE.md continha os tokens reais em texto plano (revogados em 27/04/2026, agora substituídos pelo placeholder `<configurado-via-Service-Hub-Configuracoes>`)
- Tokens dão acesso ao Superlógica (dados financeiros e cadastrais de condomínios)
- Estão no histórico de vários commits, não basta apagar do main atual

## Severidade
CRÍTICA. Vazamento ativo e público. Bots de scraping varrem GitHub público continuamente atrás exatamente desse padrão. Assumir que os tokens já foram capturados.

## O que fazer (ordem obrigatória)

### Passo 1: Girar os tokens no painel Superlógica
Esta etapa é responsabilidade do Matheus, fora do escopo dos subagentes. Acessar painel Superlógica, gerar novos app_token e access_token, anotar os novos valores em local seguro (NÃO no repo).

### Passo 2: Atualizar o proxy no Railway
Atualizar as variáveis de ambiente do serviço superlogica-proxy-production no Railway com os novos tokens. Confirmar que o proxy continua respondendo após a troca.

### Passo 3: Remover os tokens do CLAUDE.md
Substituir os dois UUIDs no CLAUDE.md por placeholders explícitos tipo `<configurado-no-railway-do-proxy>`. Manter a referência conceitual de que os tokens existem, sem os valores.

### Passo 4: Limpar o histórico do git
Decisão entre duas opções:
- Opção A: deixar histórico como está e aceitar que tokens antigos estão expostos para sempre (já foram girados no passo 1, então valor histórico é zero)
- Opção B: usar git filter-repo ou BFG Repo-Cleaner pra reescrever histórico e remover os tokens

Recomendação do arquiteto fica em aberto, decidir depois de avaliar custo-benefício.

### Passo 5: Decisão de visibilidade do repo
Avaliar três caminhos:
- Manter público: aceitar que todo código vai ser público pra sempre, todas as keys obrigatoriamente em env vars do Railway, nunca em código
- Tornar privado via `gh repo edit MatheusMelo2903/service-hub --visibility private`: protege código futuro, mas histórico já vazado continua em archives e caches
- Manter público mas ativar GitHub Push Protection: bloqueio automático de tokens conhecidos antes do push (grátis pra repos públicos)

Recomendação: Push Protection ativado já + decisão sobre privado adiada pra discussão separada com Matheus.

## Critérios de aceite
- Novos tokens Superlógica gerados e anotados em local seguro fora do repo
- Variáveis SUPERLOGICA_APP_TOKEN e SUPERLOGICA_ACCESS_TOKEN atualizadas no Railway do proxy
- Proxy testado pós troca, respondendo normalmente
- CLAUDE.md sem tokens em texto plano, com placeholders no lugar
- Push Protection ativado no GitHub via gh api
- Decisão registrada sobre opção A ou B do passo 4
- Decisão registrada sobre visibilidade do repo
- Tarefa do hook anti-token retomada após esta concluir

## Riscos
- Risco 1: girar tokens sem atualizar proxy primeiro derruba todas as integrações Superlógica em produção. Mitigação: ordem rígida dos passos, atualizar proxy ANTES de revogar antigos no painel Superlógica (manter os dois válidos por janela curta de transição)
- Risco 2: filter-repo reescreve histórico e quebra clones existentes. Mitigação: como Matheus é o único dev, impacto é zero. Mas avaliar se vale o trabalho
- Risco 3: tornar repo privado quebra deploy automático Railway. Mitigação: confirmar que Railway tem token de acesso ao repo privado antes de fazer a mudança
- Risco 4: outros tokens podem estar vazados que ainda não identificamos. Mitigação: arquiteto faz varredura completa do repo e do histórico antes de propor o plano

## Subagente para começar
Arquiteto. Antes de qualquer ação irreversível, quero ver:
1. Varredura completa do CLAUDE.md, server.js, public/index.html e todo o histórico git em busca de qualquer outro padrão de token (não só Superlógica). Listar tudo que encontrar com arquivo, linha, commit
2. Confirmação de que o proxy Superlógica é o ÚNICO lugar onde os tokens são usados, ou se há mais alguma referência
3. Comando exato pro passo 2 (atualizar Railway via dashboard ou CLI)
4. Recomendação fundamentada sobre opção A ou B do passo 4
5. Recomendação fundamentada sobre visibilidade do repo
6. Reportar tudo pra mim antes de qualquer Edit, Write ou comando que mude estado
