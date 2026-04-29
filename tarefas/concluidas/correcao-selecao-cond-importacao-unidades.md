# TAREFA: Correção da seleção de condomínio no Dashboard e importação de unidades via API REST

## Contexto da sessão

Sessão aberta em 2026-04-28 após o site ter sido travado por trabalho não commitado em `public/index.html` (+445/-24 linhas). As alterações foram preservadas em stash (`stash@{0}: sessao-correcao-2026-04-28-index-quebrado`) e o arquivo voltou ao estado limpo do commit `7a30772`. A partir daqui, a implementação será refeita de forma cirúrgica, sem reaproveitar o código quebrado.

Os hashes `ea62f5f`, `4bbade8` e `e2c3016` mencionados no diagnóstico inicial não existem no repositório; o trabalho problemático estava todo no working tree.

## O que eu quero

Três funcionalidades independentes, em sequência, todas em `public/index.html`:

### Funcionalidade 1 — Seleção de condomínio no Dashboard

O Dashboard tem:
- Campo de busca: `id="dash-cond-search"`
- Dropdown: `id="dash-cond-dropdown"`
- Exibição do condomínio ativo: `id="dash-cond-nome"` e `id="dash-cond-id"`

Fluxo esperado:
1. Usuário digita no campo `dash-cond-search`.
2. `searchCondominioDash(query)` é chamada via `oninput`.
3. Busca primeiro em `cpCondominios` (array em memória, campo `nome`).
4. Fallback: `supaFetch('condominios?select=id,nome,id_superlogica&nome=ilike.*QUERY*')`.
5. Popula `dd.innerHTML` com divs `.cond-option` data-id data-nome.
6. Adiciona listener via event delegation no pai (UMA VEZ, usando `_listenerAdded`).
7. Ao clicar: chama `selecionarCondominioDash(id, nome)`.

`selecionarCondominioDash` deve:
- Fechar o dropdown (`classList.remove('open')` + `innerHTML = ''`).
- Preencher o input com o nome.
- Salvar `state.config.condId = id`.
- Salvar `state.config.condNome = nome`.
- `localStorage.setItem('sh_config', JSON.stringify(state.config))`.
- Chamar `atualizarDashCond()`.
- Toast de confirmação.

CRÍTICO: NÃO chamar `selecionarCondominio(id, nome)` — essa função pertence ao painel Configurações e escreve em `#cfg-cond-id` e `#cond-search-input`, causando travamento ao instanciar listeners cruzados.

### Funcionalidade 2 — Cadastro de novo condomínio

Modal: `id="dash-modal-novo-cond"` (`display:none` por padrão, `display:flex` para abrir).
Campos: `id="dash-input-nome-cond"` e `id="dash-input-id-superlogica"`.

`dashSalvarNovoCondominio()` deve:
- Validar nome e idSuperlogica (toast de erro se vazio).
- POST no Supabase tabela `condominios`:
  ```
  { nome, sindico: '', id_superlogica: idSuperlogica, criado_em: new Date().toISOString() }
  ```
- Usar a função `supaFetch` já existente no arquivo.
- Adicionar o objeto retornado em `cpCondominios` (array em memória).
- Fechar modal e limpar campos.
- Toast de sucesso.

### Funcionalidade 3 — Importação de unidades via API REST

Método EXCLUSIVO. Sem Handsontable, sem browser injection.

Painel `id="panel-unidades"`:

1. Recebe planilha XLS/XLSX via drag and drop ou input file.
2. Parseia com SheetJS (já disponível no arquivo via CDN).
3. Header na linha 4 (índice 3), colunas fixas:
   - 0: Unidade (ex: `A 0201`) — separar em num e bloco
   - 1: Grupo/Bloco (ex: `Torre A`)
   - 2: Proprietário (nome)
   - 3: CPF/CNPJ
   - 4: RG
   - 5: Email
   - 6: Fone 1
   - 7: Fone 2
   - 9: Inquilino
   - 24: CEP
   - 25: Endereço
   - 26: Número
   - 27: Bairro
   - 28: Complemento
   - 29: Cidade (ex: `Vitória ES` — separar cidade e estado)
4. Para cada unidade, fazer 2 chamadas via proxy Railway:

CHAMADA 1 — POST criar unidade vazia:
```
POST https://superlogica-proxy-production.up.railway.app/v2/condor/unidades/post
Headers: Content-Type: application/x-www-form-urlencoded, app_token, access_token
Body URLSearchParams:
  ID_CONDOMINIO_COND: state.config.condId  (OBRIGATÓRIO)
  ST_UNIDADE_UNI: numero da unidade ex 0201
  ST_BLOCO_UNI: bloco ex Torre A
  ID_TIPOCONTATO_TCON: 3   (OBRIGATÓRIO, no nível raiz, NUNCA dentro de contatos[])
  FL_FORMADERECEBIMENTO_UNI: 1   (OBRIGATÓRIO, boleto)
```
Resposta: `{ status: "200", id_unidade_uni: "33369", id_contato_con: "77547" }`.
Capturar: `idUnidade = item.id_unidade_uni` e `idContato = item.id_contato_con`.

CHAMADA 2 — PUT atualizar dados do proprietário:
```
PUT https://superlogica-proxy-production.up.railway.app/v2/condor/unidades/post
Body URLSearchParams:
  ID_CONDOMINIO_COND: condId
  ID_UNIDADE_UNI: idUnidade
  contatos[0][ID_CONTATO_CON]: idContato
  contatos[0][FL_PROPRIETARIO_CON]: 1
  contatos[0][ST_NOME_CON]: nome
  contatos[0][ST_CPF_CON]: cpf
  contatos[0][ST_RG_CON]: rg
  contatos[0][ST_EMAIL_CON]: email
  contatos[0][ST_TELEFONE_CON]: telefone só dígitos sem formatação
```

Regras críticas da API (descobertas em debug real):
- `ID_TIPOCONTATO_TCON` vai no nível raiz do POST, NUNCA dentro de `contatos[0][]`.
- NÃO enviar dados do proprietário no POST. Só no PUT.
- Telefone: só dígitos.
- Estado: sigla aceita (ES, SP, RJ).
- URLSearchParams codifica colchetes como `%5B%5D` — Superlógica aceita.
- Chamadas diretas a `api.superlogica.net` são bloqueadas por CORS no browser. SEMPRE usar proxy Railway.

Velocidade:
- Processar 10 unidades simultâneas com `Promise.all`.
- 100ms de sleep entre lotes.
- Nunca usar `await` sequencial para a chamada de cada unidade.

5. Exibir progresso em tempo real: `X de Y unidades importadas`.
6. Log de erros por unidade.
7. `condId` vem de `state.config.condId`. Se não estiver definido, bloquear importação com aviso.

Limpeza de valores inválidos antes de enviar:
- `nan`, `0`, `0.0`, `CEP INVÁLIDO`, `Cep Inválido`, `INVÁLIDO` viram string vazia.

## Por que eu quero

A importação de unidades está bloqueada. A gerente cobra a Prioridade 1. Sem isso a equipe não sobe unidade nenhuma. As tentativas anteriores travaram o site, então a abordagem agora é incremental, validada a cada bloco, e segue o fluxo padrão do projeto (arquiteto → aprovação → programador → revisor + auditor → validador → documentador).

## Critério de aceite

- [ ] Nenhum elemento `position:fixed` visível ao carregar a página.
- [ ] Todas as abas do sidebar clicáveis.
- [ ] Busca e seleção de condomínio no Dashboard funcionando (digitar, ver dropdown, clicar, ver nome no input).
- [ ] `state.config.condId` e `state.config.condNome` ficam definidos após seleção e persistem em `localStorage` (`sh_config`).
- [ ] Cadastro de novo condomínio salva no Supabase e aparece imediatamente na busca do Dashboard.
- [ ] Upload de planilha XLS/XLSX no painel `panel-unidades` funciona (drag and drop e input file).
- [ ] Importação usa `state.config.condId` corretamente; bloqueia se vazio.
- [ ] Progresso `X de Y unidades importadas` exibido em tempo real.
- [ ] Lote de 10 com `Promise.all` e 100ms de sleep entre lotes.
- [ ] Log de erros por unidade visível na UI.
- [ ] `selecionarCondominioDash` NUNCA chama `selecionarCondominio` do painel Configurações.

## Arquivos prováveis

- `public/index.html` (todas as funcionalidades).

## Restrições

- Sem hífen em texto visível ao usuário.
- Português brasileiro.
- Sem framework novo.
- Tokens Superlógica nunca hardcoded; sempre via `state.config` ou `localStorage`.
- Edição de `index.html` deve ser feita via ferramentas Edit/Write do Claude (programador). Não há mais regra de scripts python obrigatórios neste fluxo, pois o programador opera direto no arquivo. (Se o Matheus pedir explicitamente o script único de terminal, gerar.)
- Push só com autorização explícita.

## Status

- [x] Tarefa escrita.
- [x] Plano feito pelo arquiteto.
- [x] Plano aprovado pelo Matheus.
- [x] Código implementado.
- [x] Código revisado.
- [x] Auditoria de segurança aprovada.
- [x] Validação aprovada.
- [x] Documentação atualizada.

## Resumo final

- Linhas alteradas: +316 / -114.
- Total de rodadas de revisor/auditor: 4.
- Issues conhecidos fora de escopo (NÃO corrigidos nesta tarefa):
  1. `loadConfig` linha ~1818: XSS em `c.condNome` e `c.condId` injetados via innerHTML sem escape. Risco self-XSS via localStorage manipulado.
  2. `searchCondominio` painel Configurações linhas ~2979-3007: padrão XSS idêntico ao que foi corrigido em `searchCondominioDash`. Não corrigido por estar fora de escopo (tarefa proíbe mexer no painel Configurações).
  3. `addLog` em `enviarDespesas` e `enviarConsumo`: `txt` da resposta HTTP injetado em innerHTML sem escape. Mesmo padrão estrutural.
  4. `toast`: `msg` interpola via innerHTML em `e.message` de exceções em vários callers.

## Decisões aprovadas pelo Matheus em 2026-04-28

- Header da planilha: tentar índice 3 fixo. Se a coluna 0 não tiver formato esperado de unidade, fallback automático para a detecção atual por palavra "Unidade" nas primeiras 10 linhas.
- Auto-selecionar condomínio recém cadastrado: SIM. Após `dashSalvarNovoCondominio` ter sucesso, preencher `state.config.condId`, `state.config.condNome`, salvar em `localStorage` e chamar `atualizarDashCond()`.
- Ordem de implementação: Bloco A (Func 1) → Bloco B (Func 2) → Bloco C (Func 3), conforme plano do arquiteto.

## Achados do arquiteto sobre o estado atual (HEAD 7a30772)

- Markup do Dashboard com `dash-cond-search`, `dash-cond-dropdown`, `dash-cond-nome`, `dash-cond-id` JÁ EXISTE (linhas 946 a 963).
- `searchCondominioDash` JÁ EXISTE (linha 2740) mas chama `selecionarCondominio` (errado) no onclick do dropdown. ESSE É O BUG que travava o site.
- `selecionarCondominioDash` NÃO existe. Precisa ser criada.
- `dash-modal-novo-cond` e funções relacionadas NÃO existem. Precisam ser criados.
- `panel-unidades` JÁ tem dropzone, preview, tabela, barra de progresso, log e status (linha 1126).
- `enviarUnidades` (linha 2374) JÁ tem POST + PUT + lote de 10 + sleep(100) + toast de erro se sem condId. Falta só campos de endereço no PUT e progresso textual.
- `processFile` (linha 1980) detecta header automaticamente. Precisa virar header fixo na linha 4 com fallback.
- `processUnidadesData` (linha 2013) mapeia colunas por nome. Precisa virar mapeamento por índice fixo.

## Notas para o arquiteto

- Verificar se IDs `dash-cond-search`, `dash-cond-dropdown`, `dash-cond-nome`, `dash-cond-id`, `dash-modal-novo-cond`, `dash-input-nome-cond`, `dash-input-id-superlogica`, `panel-unidades` JÁ EXISTEM no `public/index.html` atual (estado HEAD `7a30772`). Se não existirem, propor a criação cirúrgica do markup mínimo necessário, sem mexer em outras seções.
- Verificar como `selecionarCondominio` do painel Configurações está implementada hoje, e mapear EXATAMENTE quais effects colaterais ela tem que NÃO devem ser disparados pelo Dashboard.
- Conferir como `supaFetch`, `state.config`, `localStorage sh_config`, `cpCondominios` e `atualizarDashCond` são usados hoje. Se alguma dessas peças não existir ainda, declarar isso no plano.
- Conferir se `panel-unidades` já tem alguma implementação de upload prévia que precise ser substituída ou complementada.
- Stash com o trabalho anterior está em `stash@{0}: sessao-correcao-2026-04-28-index-quebrado`. Pode ser consultado para extrair pedaços úteis, mas NÃO deve ser aplicado em massa.
