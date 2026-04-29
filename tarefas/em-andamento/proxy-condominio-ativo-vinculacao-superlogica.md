# Tarefa: Proxy CORS + Cadastro de Condomínios + Estado Ativo + Vinculação Superlógica Completa

Data: 2026-04-28
Solicitante: Matheus

## Contexto

O Service Hub tem uma aba de Configurações com três seções: tokens Superlógica (app_token + access_token), condomínio padrão para importação, e URL do proxy CORS. O proxy oficial é `superlogica-proxy-production.up.railway.app`. Sem ele, chamadas diretas a `api.superlogica.net` falham por CORS no browser.

Existem dois bugs e uma arquitetura faltando.

## Bug 1 — Falha ao salvar condomínio

Ao preencher Nome + ID Superlógica e clicar em "Salvar e selecionar", aparece toast de erro.

Investigar:
- Rota POST de salvar condomínio no `server.js`
- Se a falha é no Supabase (insert rejeitado, schema, RLS) ou no proxy
- Schema mínimo da tabela `condominios`: `nome` (string, obrigatório), `id_superlogica` (integer, obrigatório), `criado_em` (timestamp default now())
- Se a tabela não existe, criar via migration
- Se houver RLS bloqueando, criar policy permissiva
- Após salvar, retornar `{ id, nome, id_superlogica }` completo

## Bug 2 — Condomínio ativo não aparece no Dashboard nem nas abas

Criar funções utilitárias globais:
- `getCondominioAtivo()` lê do localStorage
- `setCondominioAtivo(obj)` grava no localStorage
- Chave: `condominioAtivo` — formato: `{ id, nome, id_superlogica }`
- Ao salvar ou selecionar condomínio: chamar `setCondominioAtivo` imediatamente
- Ao carregar qualquer módulo: chamar `getCondominioAtivo` e renderizar contexto

## Arquitetura do Condomínio Ativo — Regra Central

### Módulos que enviam dados ao Superlógica (vinculação obrigatória):
- Importar Despesas
- Importar Unidades
- Boletos, Conciliação, Notas Fiscais, Leitura de Consumo (quando implementados)

Comportamento obrigatório:
- Banner azul fixo no topo: "Enviando para Superlógica — Condomínio: [NOME] | ID: [ID_SUPERLOGICA]"
- Sem condomínio selecionado: banner laranja "Nenhum condomínio selecionado..." + botão desabilitado
- Após sucesso: confirmação explícita "Dados enviados com sucesso ao Superlógica para o condomínio [NOME] (ID: [ID_SUPERLOGICA])"
- NUNCA hardcodar `id_superlogica` — sempre ler de `getCondominioAtivo().id_superlogica`
- TODAS as chamadas Superlógica passam pelo proxy lido do localStorage

### Módulos internos (não enviam ao Superlógica):
- Dashboard, Condomínios/Demandas, Atas Condominiais, Tarefas

Comportamento:
- Exibir discretamente no topo: "Contexto: [NOME]"
- Sem selecionado: mensagem neutra, sem bloquear

## Verificação obrigatória do proxy

1. Buscar TODAS as chamadas HTTP ao Superlógica (fetch, axios, XHR) no código
2. Para cada chamada, verificar se a URL começa com o proxy ou com `api.superlogica.net` direto
3. Corrigir qualquer chamada que não usa o proxy
4. Formato esperado: `[PROXY_URL]/[endpoint_superlogica]` — confirmar como o proxy monta a URL
5. Confirmar proxy online com chamada de teste e log no console

## Status da API no Dashboard

Já existe indicador visual:
- Verde "API OK" — última chamada bem sucedida
- Vermelho "API com erro" — falha
Garantir que reflete a realidade.

## Ordem de execução

1. Ler `server.js` completo e `public/index.html` completo
2. Verificar TODAS as chamadas ao Superlógica e confirmar passagem pelo proxy
3. Corrigir chamadas que não usam proxy
4. Verificar schema Supabase da tabela condominios — criar ou corrigir
5. Corrigir Bug 1 — insert do condomínio sem erro
6. Implementar `getCondominioAtivo` / `setCondominioAtivo` globais
7. Corrigir Bug 2 — Dashboard e módulos lendo e exibindo o condomínio ativo
8. Aplicar banner azul com confirmação nos módulos que enviam ao Superlógica
9. Aplicar contexto leve nos módulos internos
10. Garantir que `id_superlogica` correto vai em todas as chamadas
11. Commit: `fix: proxy cors + cadastro condominios + estado ativo + vinculacao superlogica completa`
12. Confirmar `localhost:3000` funcionando

## Critério de aceite

Matheus consegue: selecionar um condomínio, ir em qualquer módulo de importação, executar a ação, e ter certeza visual e técnica de que os dados foram para o condomínio certo no Superlógica via API.

## Atualização 2026-04-28 — pacote consolidado de 4 problemas

Após executar o Passo 1 (diagnóstico), o erro real do Supabase apareceu:
`Erro Supabase 400: null value in column "id" of relation "condominios" violates not-null constraint`.

Matheus consolidou 4 problemas em uma única rodada:

1. **Erro 23502 ao salvar condomínio** — coluna `id` é NOT NULL sem default. Solução: gerar `crypto.randomUUID()` no JS antes do insert. Sem migration.
2. **Card CONDOMÍNIO ATIVO no Dashboard não atualiza** — após salvar, toast verde aparece mas card continua com travessão.
3. **Nenhum painel da seção SUPERLÓGICA mostra cond ativo** — banner persistente obrigatório (gs-blue-light com cond ativo, danger sem). Botão "Trocar" abre modal `cadastrarNovoCond`. Botões de ação desabilitados sem cond ativo.
4. **Bug em Configurações > Buscar** — input `167` retorna `Erro: The string did not match the expected pattern`. Investigar regex/payload da chamada à API Superlógica.

Decisões aprovadas pelo Matheus:

- Persistência do ativo: opção A (localStorage + window.condominioAtivo, sincronização em cpCarregarDoSupabase)
- UUID gerado no cliente antes do insert
- Banner aplica em Importar Unidades, Importar Despesas, Boletos, Conciliação
- Funções globais `getCondominioAtivo()` / `setCondominioAtivo(obj)` (sem prefixo `cp`)
- Comentário no topo do arquivo documentando que `cp*` é do painel Condomínios apenas
