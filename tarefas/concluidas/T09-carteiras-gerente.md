# TAREFA: T09 Carteiras do gerente

## O que foi pedido
Ler condominiogrupos/index do Superlógica (Carteira A, Carteira B...). Vincular usuário do Hub a carteira (campo no perfil, editável pelo GESTOR). Listas e seletor filtram pela carteira do usuário; GESTOR vê tudo.

## O que foi feito
1. Servidor lê os grupos do Superlógica (superlogica/carteiras.js, cache de 10 min): hoje são CARTEIRA A (Graziela), CARTEIRA B (Rosigleyde), #1 Matriz (filial), CONDOMÍNIO SERRA e CONDOMÍNIOS VITÓRIA. Qualquer grupo pode ser escolhido como carteira (inclusive os por cidade).
2. Campo novo profiles.carteiras (lista de grupos). Migration 008 aplicada só no Supabase de teste. Sem a migration (produção hoje) nada quebra: todo mundo vê todos e a tela avisa que o campo não existe.
3. Rotas: GET /api/carteiras (GESTOR), GET /api/carteiras/minha (usuário logado), GET /api/admin/usuarios/carteiras e PUT /api/admin/usuarios/:id/carteiras (GESTOR; confere se a carteira existe no Superlógica; GESTOR não tem carteira). Usuário comum e GERENTE não conseguem mudar carteira (nem pela API nem pelo Supabase direto, a RLS só deixa o GESTOR editar perfis).
4. Configurações, tela de usuários: o GESTOR marca a carteira na janela "Editar permissões"; a lista mostra a carteira de cada um ("todos os condomínios" quando vazia).
5. Seletor de condomínio (todas as abas) e busca da Ficha do Condomínio mostram só os condomínios da carteira. A lista aparece na hora e a carteira se aplica quando chega (até 8 s; se falhar, mostra todos). Condomínio ativo fora da carteira gera aviso para trocar.

## Decisões
1. Usuário sem carteira vê todos (como hoje), para não esconder nada de quem já usa.
2. É filtro de tela, não barreira de acesso: as rotas do Superlógica continuam aceitando qualquer condomínio para quem tem módulo liberado. Bloquear de verdade exige checar a carteira em cada rota (tarefa futura, se você quiser).

## Testes (dados reais, ambiente dev local)
Grupos lidos do Superlógica; Carteira A tem 36 códigos (30 cadastrados no Hub), Carteira B 35 (27 no Hub, inclui o Casablanca), as duas juntas 57. PUT com lista inválida, carteira inexistente e id inválido recusados; PUT válido gravou [4] no usuário OPERACIONAL de teste e foi desfeito (voltou a vazio). Sem login: 401.

## O que o Matheus precisa validar
1. Configurações, Usuários, Editar permissões de um usuário OPERACIONAL: marcar CARTEIRA A e salvar.
2. Entrar com esse usuário e abrir o seletor: devem aparecer só os condomínios da Carteira A. Desmarcar depois, se quiser voltar ao normal.
3. Dizer se a carteira deve virar bloqueio de acesso de verdade (hoje só esconde da lista).
