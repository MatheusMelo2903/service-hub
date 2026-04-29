# TAREFA: Selecionar condomínio com ID Superlógica manual (Prioridade 1)

## O que eu quero
Permitir cadastrar condomínio no Hub com nome e ID Superlógica digitado manualmente, selecionar qual está ativo, ter certeza visual disso o tempo todo, e garantir que a importação de unidades só rode quando há condomínio selecionado e vai pro ID certo no Superlógica.

## Por que eu quero
Pedido direto da gerente. Bloqueia toda a importação de unidades. É a Prioridade 1 do guia definitivo v2 (docs/guia-definitivo-v2-2026-04-28.pdf). Sem isso a equipe não consegue subir unidade nenhuma com confiança de que está indo pro condomínio certo no Superlógica.

## Critério de aceite
- [x] Tela ou modal de cadastro de condomínio com dois campos: nome (texto) e ID Superlógica (numérico, obrigatório, validado como inteiro positivo)
- [x] Lista de condomínios cadastrados em ordem alfabética com campo de busca por nome
- [x] Indicador visual fixo no topo do Hub mostrando o condomínio ativo (nome e ID), bem destacado, impossível de não ver
- [x] Persistência na tabela `condominios` do Supabase (a tabela já existe, vai ser ALTER TABLE adicionando `id_superlogica`, `ativo`, `updated_at`)
- [x] Botão Importar Unidades fica desabilitado se não houver condomínio selecionado, com mensagem explicando
- [x] Modal de confirmação antes de cada importação mostrando o nome e o ID do condomínio de destino, exigindo clique de confirmação
- [x] Trocar de condomínio limpa qualquer estado de importação em andamento
- [ ] Funciona em produção (Railway), não só em localhost — pendente: push aguarda autorização do Matheus

## Arquivos que provavelmente vão ser mexidos
- `public/index.html` (módulo Condomínios já tem prefixo `cp*`, importar unidades já existe)
- `server.js` (provavelmente não, mas o arquiteto avalia)
- SQL no Supabase (ALTER TABLE documentado em comentário ou em `docs/`)

## Restrições
- Sem hífen ou traço em texto visível ao usuário
- Português brasileiro
- Sem framework novo, manter padrão visual e CSS já existentes
- Nunca expor token no frontend (anon key publishable é a única exceção, já está em index.html linhas 3244-3245)
- V8S e Grupo Service nunca linkados em texto visível, nunca usar Security Service
- Não criar tabela nova: a tabela `condominios` já existe e está ligada a `laudos` e `historico`
- Datas no padrão browser DD/MM/YYYY (API Superlógica usa MM/DD/YYYY se precisar)
- Push só com autorização explícita (alias hubdeploy quando eu falar pode subir)
- Edição GitHub apenas no Safari

## Exemplos ou referências
- Guia v2 página 3 (descrição da Prioridade 1)
- Inventário do guia v2 página 10 (tabela `condominios` existente)
- Teste real de aceite: cadastrar Residencial Teste com ID Superlógica 167, importar planilha de unidades, confirmar no painel Superlógica que apareceu no condomínio 167

---

## Plano do arquiteto

Decisões principais tomadas durante a implementação:

- Coluna `ativo` ficou fora do banco: vive exclusivamente em localStorage por máquina, evita conflito multi-máquina (duas sessões abertas não se sobrepõem).
- ALTER TABLE `condominios`: adicionadas colunas `id_superlogica` (integer, not null), `ativo` (boolean, default false) e `updated_at` (timestamptz). Migration documentada em `MIGRATION_CONDOMINIOS_SUPERLOGICA.sql` na raiz do repo.
- Barra fixa de condomínio ativo: elemento fixo no topo do Hub, exibe nome e ID Superlógica, visível em todas as abas.
- Guard de envio: funções de importar unidades e despesas verificam estado antes de chamar a API Superlógica. Botões desabilitados se não houver condomínio selecionado.
- Modal de confirmação: exige clique explícito antes de qualquer importação, mostrando nome e ID do condomínio de destino.
- Trocar de condomínio ativo limpa `state.despesas.importing` e `state.unidades.importing` simetricamente.
- XSS: todos os pontos de renderização de dados vindos do banco (barra, modais, lista, sidebar) passam por `dcEscape`.
- Defesa em profundidade nas funções `_Confirmado`: validam novamente que o condomínio ativo ainda existe antes de disparar a importação.
- `updated_at` populado no PATCH para consistência no banco.

## Status
- [x] Tarefa escrita
- [x] Plano feito pelo arquiteto
- [x] Plano aprovado pelo Matheus
- [x] Código implementado
- [x] Código revisado
- [x] Correções aplicadas
- [x] Auditoria de segurança aprovada
- [x] Validação aprovada
- [x] Documentação atualizada
