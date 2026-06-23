REGRAS DE AMBIENTE — LEIA ANTES DE QUALQUER TAREFA

Este projeto tem dois ambientes no mesmo repositorio (MatheusMelo2903/service-hub):
- Branch dev = ambiente de TESTE. Roda em service-hub-dev.up.railway.app. E onde todo desenvolvimento acontece.
- Branch main = PRODUCAO. Roda em service-hub-production.up.railway.app. E intocavel sem autorizacao explicita.

Regras absolutas:
1. No inicio de toda sessao, rode `git status` e confirme que estou na branch dev. Se nao estiver, rode `git checkout dev` e me avise antes de continuar.
2. Todo desenvolvimento, edicao e teste acontece SOMENTE na branch dev.
3. NUNCA faca commit, merge ou push para a branch main. Producao so e atualizada quando EU autorizar explicitamente com a frase "sobe para producao".
4. Quando eu autorizar subir para producao, o fluxo e: commit na dev, push da dev, e so entao merge dev para main com minha confirmacao.
5. Antes de comecar a editar, rode `git fetch` para sincronizar com o remoto e evitar conflito entre os varios clones locais.
6. Se em algum momento detectar que estou em pasta diferente de v8s/service-hub, me avise imediatamente.

Quando eu disser "estou na versao teste" ou "trabalha no dev", confirme que estamos na branch dev e prossiga normalmente nela.

# CLAUDE.md — Service Hub V8S

Este arquivo é a fonte de verdade do projeto Service Hub. Leia INTEIRO antes de qualquer tarefa.

## Sobre quem te contratou

Matheus, 24 anos, cofundador e gestor principal da Virtual Service (V8S), empresa de tecnologia em segurança eletrônica para condomínios em Vitória/ES. Sócio técnico Adriano. Família tem o Grupo Service (Contábil Service, Condomínio Service, RH Service), que é separado da V8S. NUNCA confundir Virtual Service com Grupo Service. NUNCA chamar Virtual Service de Security Service.

Matheus não programa. Ele é o product owner. Você escreve o código, ele valida o resultado e a experiência. Ele entende lógica de negócio melhor que ninguém, mas precisa que você explique decisões técnicas em português claro, sem jargão.

## Regras absolutas de comunicação

1. NUNCA usar hífen ou traço em respostas, documentos ou código gerado para apresentação.
2. NUNCA criar painéis ou widgets do zero sem antes pedir pro Matheus enviar o resumo ou copiar os dados do widget atual.
3. Quando gerar prompt para nova conversa, sempre dentro de UM ÚNICO bloco de código, sem títulos ou markdown interno.
4. Documentos Word ou PDF: sempre gerar OS DOIS no final, convertendo via LibreOffice.
5. Comunicação direta, sem floreio, sem elogio gratuito, sem repetir o que ele disse antes de responder.

## O que é o Service Hub

Plataforma operacional interna da V8S e do Grupo Service. Hoje é um arquivo HTML único hospedado no Railway, com integração ao Superlógica via API REST e proxy intermediário.

Funcionalidades atuais:
- Dashboard operacional V8S
- Integração Superlógica (importação de unidades, despesas, leitura de dados)
- Geração de atas condominiais com IA
- Geração de relatórios

Visão de longo prazo: evoluir até virar SaaS multi-usuário com login, onde funcionários da V8S e clientes acessam módulos diferentes sem ver a lógica por trás.

## Stack técnica

- Frontend: HTML único, JavaScript vanilla, CSS embutido
- Hospedagem: Railway via GitHub
- Proxy Superlógica: https://superlogica-proxy-production.up.railway.app
- URL Service Hub: https://service-hub-production.up.railway.app
- Tokens (NUNCA expor no frontend, sempre via proxy):
  - app_token: <configurado-via-Service-Hub-Configuracoes>
  - access_token: <configurado-via-Service-Hub-Configuracoes>

## Regras de segurança

- Tokens nunca aparecem em código frontend, nem em commit, nem em arquivo público.
- Antes de qualquer commit, rodar o subagente auditor-seguranca.
- Edição de arquivos no GitHub: sempre Safari, nunca Chrome.

## Padrões de código

- HTML: classes em kebab-case (ex: modal-cliente, botao-salvar)
- JavaScript: funções e variáveis em camelCase, constantes em UPPER_CASE
- Comentários em português brasileiro explicando o porquê, não o quê
- Toda função com mais de 10 linhas tem comentário no topo
- Nenhuma biblioteca externa nova sem aprovação do Matheus
- Regra de leitura de arquivos em blocos pelo programador: ver definição do subagente programador em ~/.claude/agents/programador.md.

## Fluxo de trabalho obrigatório

Toda tarefa segue esta ordem:

1. Matheus escreve tarefas/em-andamento/NOME.md com o que quer
2. Subagente arquiteto lê e devolve plano detalhado
3. Matheus aprova o plano
4. Subagente programador implementa
5. Subagente revisor E subagente auditor-seguranca rodam EM PARALELO (mesmo turno, dois Agent tool uses simultâneos). Um analisa qualidade de código; o outro analisa segurança e tokens. São análises independentes e não precisam esperar uma pela outra.
6. Se revisor OU auditor reprovar: subagente programador corrige todos os pontos levantados pelos dois antes de prosseguir. Se ambos aprovarem, pular direto para o passo 7.
7. Subagente validador testa integrações
8. Subagente documentador atualiza docs e move tarefa para concluidas

NÃO pular etapas.

Como invocar revisor e auditor em paralelo: no mesmo turno do orquestrador, dispare dois Agent tool uses simultaneamente, um apontando para o subagente revisor e outro para o subagente auditor-seguranca. Aguarde AMBOS retornarem antes de avaliar o resultado. Só prossiga para o passo 7 após ter os dois veredictos em mãos.

## O que está fora de escopo

- Mudanças visuais sem pedido explícito do Matheus
- Microsserviços, Kubernetes, GraphQL ou qualquer complexidade desnecessária
- Reescrever do zero: sempre evoluir o que existe

## Estrutura de URLs

O sistema tem duas camadas de entrada desde 2026-04-27:

- `/` — Landing page pública (public/landing.html). É o que o usuário vê ao acessar o domínio. Identidade ServiceZone, fundo escuro, hero com botões Entrar e Criar conta.
- `/hub` — Sistema operacional completo (public/index.html). É acessado pelo botão Entrar na landing ou diretamente pela URL.

O server.js usa `express.static({ index: false })` com rotas explícitas `GET /` e `GET /hub`. O catch-all redireciona para a landing.

Nunca alterar essas rotas sem checar se o botão Entrar da landing ainda aponta para `/hub`.

## Cache de contexto

O Claude Code faz prompt caching automaticamente para o conteúdo do CLAUDE.md e mensagens de sistema. Não há configuração manual a fazer no settings.json para isso. A ordem das seções neste arquivo importa: regras estáveis (que mudam pouco) ficam no topo, contexto volátil (estado do projeto, datas, IDs em uso) fica no final. Isso maximiza o reaproveitamento de cache entre turnos. Não tente reimplementar caching manual aqui — o harness já cuida.

## Estado atual do arquivo principal

Em 2026-04-30 a entrega de Inquilino e Dependente deixou public/index.html com 5338 linhas (era 4967, +371 linhas). MD5: dd9df99169721ff1c834f70f8fe57004. A função enviarUmaUnidade agora encadeia POST de unidade vazia + PUT do Proprietário + N POSTs sequenciais para contatos extras (Inquilino e Dependente), contabilizando inqOk/inqFail/depOk/depFail separadamente. Versão anterior (2026-04-29): 4967 linhas, 3 fixes de segurança em toast, cpRenderSidebar e dcSalvarDemandas.

## Quando estiver em dúvida

Perguntar ao Matheus em português direto. Uma ou duas perguntas, as mais críticas. Sem flood de perguntas.

---

## Pasta direcional (adicionada 2026-05-25)

Estrutura espelhada do MasterClinic (`clinicmanager-erp`). Sempre ler nesta ordem ao iniciar sessão:

| Quando precisar de... | Ler |
|---|---|
| Sprint atual + log de atividade | `MISSION_CONTROL.md` |
| Visão produto + DNA | `PANORAMA_ESTRATEGICO.md` |
| Roadmap 14 dias | `PLANO_ATIVO.md` |
| Stack, URLs, ENVs | `PROJECT_CONTEXT.md` |
| Snapshot técnico | `AUDITORIA_PROJETO.md` |
| Skills MC reaproveitáveis | `AUDITORIA_SKILLS_MC_PARA_SH.md` |
| Setup dev local | `docs/02-PLANO-LOCAL.md` |
| Runbook deploy | `docs/03-RUNBOOK-DEPLOY.md` |
| Última sessão (continuação) | `.claude/CONTINUACAO.md` |

### Subagentes (`.claude/agents/`)
- `architect` — planeja antes de implementar (Read/Glob/Grep only)
- `implementer` — executa o plano
- `reviewer` — revisão de qualidade
- `security-auditor` — auditoria de tokens + secrets
- `validator` — build (mudanças puras de lib/lógica)
- `validator-v2` — build + visual MCP (mudanças que afetam UI/UX)
- `documenter` — atualiza docs/mission control

### Skills locais (`.claude/skills/`)
- `frontend-design/` — UI/CSS distintivo (Anthropic oficial)
- `ops/` — rotação de secrets Superlógica + smoke tests
- `service-hub/` — master skill do Hub (do Matheus + upgrade integracoes)

### Scripts
- `scripts/rotate-secrets-sh.sh` — rotação automatizada `INTERNAL_API_SECRET`
