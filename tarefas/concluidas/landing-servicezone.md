# Tarefa: Landing page ServiceZone

## Objetivo
Criar landing page de entrada do Service Hub com identidade ServiceZone. Substitui a tela atual que abre direto no sistema. A landing fica antes do sistema: usuário chega no domínio, vê a landing, clica em Entrar e vai pro Hub atual.

## Contexto
- Etapa 1 do projeto landing + login
- Identidade: ServiceZone (casa com domínio servicezone.com.br)
- Público: só funcionários do Grupo Service / V8S no futuro
- Etapa 2 (login real com Supabase) virá depois, não nesta tarefa

## Estrutura da página
1. Header fixo no topo: logo GS à esquerda, nome "ServiceZone" ao lado
2. Hero ocupando viewport: título forte, subtítulo curto, dois botões lado a lado
3. Seção curta abaixo do hero: 2 ou 3 linhas explicando o que é a plataforma
4. Rodapé simples: CNPJ do Grupo Service, copyright, ano corrente

## Identidade visual
- Fundo: #0A0F1A (escuro)
- Azul corporativo: #2B7DC8 (botão primário, detalhes da logo, links)
- Texto principal: branco ou cinza muito claro
- Texto secundário: cinza médio
- Logo GS: SVG puro inline, recriada (não pode ser imagem PNG/JPG)
- Tipografia: sans-serif moderna (system font stack ou Inter via Google Fonts)
- Estilo geral: profissional, sóbrio, corporativo com toque tech
- Inspiração: gruposervice-es.com.br, mas em fundo escuro

## Conteúdo dos textos
- Título do hero: a definir pelo arquiteto, algo direto tipo "Plataforma operacional do Grupo Service"
- Subtítulo: 1 linha curta complementando
- Botão primário: "Entrar"
- Botão secundário: "Criar conta"
- Seção sobre: 2 a 3 linhas dizendo o que é (centraliza operação, integra sistemas, controla acesso por permissão)
- Rodapé: CNPJ do Grupo Service (perguntar a Matheus se não estiver no código atual), "© 2026 Grupo Service. Todos os direitos reservados."

## Comportamento dos botões
- "Entrar": redireciona pro sistema atual (a tela que hoje aparece quando alguém abre o domínio)
- "Criar conta": sem função nesta etapa. Pode ser um botão visual que não faz nada ou abre um modal vazio. Não bloquear, não desabilitar.

## Estrutura de arquivos
- A landing precisa virar a página inicial do site
- O sistema atual (4253 linhas em public/index.html) precisa continuar acessível, só não pode mais ser a primeira tela
- Decisão de implementação fica com o arquiteto: pode ser landing.html como home + index.html renomeado, ou rota nova no server.js, ou outra solução. Avaliar o que é menos invasivo no código existente.

## Regras absolutas
- NUNCA usar hífen ou traço em texto visível ao usuário
- Nome correto da empresa: Grupo Service (nunca abreviar como Service ou GS no texto)
- V8S e Grupo Service são empresas separadas, não misturar
- Português brasileiro

## Critérios de aceite
- Acessar a URL de produção mostra a landing, não o sistema antigo
- Logo GS renderiza corretamente em SVG, não usa arquivo de imagem externo
- Botão Entrar leva ao sistema atual sem perder nada do que funciona hoje
- Layout responsivo: funciona em desktop e mobile sem quebrar
- Nenhum texto visível tem hífen
- Lighthouse com pontuação acessível (sem erros graves de contraste ou semântica)
- Deploy no Railway funciona sem erro
- Sistema antigo continua 100% funcional após a mudança

## Riscos a antecipar
- Risco 1: quebrar o caminho atual de quem já usa o domínio direto. Mitigação: testar fluxo completo (landing → Entrar → sistema) antes do commit.
- Risco 2: o sistema atual ter referências hardcoded a "/" como home. Mitigação: validador precisa confirmar que nenhuma rota interna do Hub quebrou.
- Risco 3: SVG da logo ficar feio ou desproporcional. Mitigação: arquiteto desenha a estrutura do SVG no plano antes do programador implementar.
- Risco 4: deploy no Railway dar erro de roteamento por mudança de arquivo principal. Mitigação: auditor checa server.js, validador testa em produção após push.

## Subagente para começar
Arquiteto. Antes de qualquer linha de código, quero ver:
1. Estratégia escolhida pra separar landing do sistema (renomear arquivos? nova rota? subdomínio?)
2. Mockup textual do layout (onde fica cada elemento)
3. Estrutura do SVG da logo GS (proporções, cores, traços)
4. Lista de arquivos que vão ser criados ou alterados
