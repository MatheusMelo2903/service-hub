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
  - app_token: 156b6871-1bf7-476b-8012-4424805569b8
  - access_token: f8058080-4c9a-4983-aef1-86b41e22f032

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

## Fluxo de trabalho obrigatório

Toda tarefa segue esta ordem:

1. Matheus escreve tarefas/em-andamento/NOME.md com o que quer
2. Subagente arquiteto lê e devolve plano detalhado
3. Matheus aprova o plano
4. Subagente programador implementa
5. Subagente revisor revisa
6. Subagente programador aplica correções
7. Subagente auditor-seguranca verifica
8. Subagente validador testa integrações
9. Subagente documentador atualiza docs e move tarefa para concluidas

NÃO pular etapas.

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

## Quando estiver em dúvida

Perguntar ao Matheus em português direto. Uma ou duas perguntas, as mais críticas. Sem flood de perguntas.
