# T52 Fluidez (sem mudar o visual)

Data: 22/10/2026. Direto na dev (commit 435f716). Pedido do Matheus: menos rolagem, listas resumidas, filtro por condomínio, carregamento mais rápido, mantendo o design atual. A prévia de redesign (artifact) foi descartada; ficou só a ideia do menu em tópicos.

## O que mudou
1. Menu em tópicos recolhíveis (public/menu-grupos.js): Principal, Financeiro, Condomínio, Administração. Itens, ids e permissões iguais; tópico sem item visível some; abrir uma tela abre o tópico dela.
2. Central de alertas (public/central-alertas.js): condomínios recolhidos, 15 por vez, tipos com 3 ou mais viram uma linha ("ESCELSA e mais 27"), Abrir todos e Recolher todos, filtro de condomínio abre os grupos que batem, cópia da última leitura em sessionStorage (por usuário).
3. Seu dia (public/avisos.js): analistas recolhidos (8 por vez), erros por tipo (5 e ver mais de 10), carteira por condomínio, cópia na sessão.
4. Alertas do condomínio (public/dashboard.js): tipo com 3 ou mais vira uma linha com Ver itens e Marcar todos como vistos; cópia por condomínio.
5. Financeiro (public/financeiro.js e financeiro/painel.js): último resultado na hora e atualização por trás; o servidor devolve a base do dia sem esperar o recálculo (só a primeira do dia espera).
6. Previsão (public/previsao-embed.js): aviso de carregando no lugar da tela em branco.

## ESCELSA repetida
Não é erro da regra: o condomínio tem uma despesa recorrente por medidor (até 28 no mesmo condomínio). Agora aparece agrupada.

## Testado no dev (Chrome)
Menu, Seu dia, Central (131 alertas do Quadra 3 viram 3 linhas), cartão de alertas, Financeiro (14 s na primeira carga depois do deploy, instantâneo depois), Previsão com aviso. Sem erros no console. Todos os testes de scripts passando.

## Pendências
1. Previsão: o módulo tem 6 MB (bibliotecas embutidas); diminuir é outra tarefa.
2. Decidir se o servidor calcula a base do Financeiro sozinho ao ligar (acaba a espera da primeira abertura, mas aumenta chamadas ao Superlógica a cada reinício).
3. Ramo de reserva wip/fluidez no GitHub não pôde ser apagado daqui (403); pode apagar pelo site.
