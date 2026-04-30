# Service Hub

SPA HTML único para gestão condominial. Hospedado no Railway, dados no Supabase.

## Stack

- **Frontend**: `public/index.html` (~4000 linhas). HTML + CSS + JS inline. Sem framework.
- **Backend**: `server.js` (Express). Serve o estático e expõe endpoints de proxy para APIs externas.
- **DB**: Supabase (REST via `supaFetch` no frontend, URL e key publishable hardcoded no HTML).
- **Deploy**: Railway (auto-deploy ao push em `main`).

## Dev setup

```bash
git clone https://github.com/MatheusMelo2903/service-hub.git
cd service-hub
npm install
export ANTHROPIC_KEY="sk-ant-..."
export ASSEMBLYAI_KEY="..."
export OPENAI_KEY="..."
npm start
# http://localhost:3000
```

Servir via `python3 -m http.server` só funciona pra revisão visual — os endpoints `/api/*` precisam do Express.

## Env vars (Railway Variables)

| Variável | Usada por |
|---|---|
| `ANTHROPIC_KEY` | `/api/claude/messages` (Demandas de Cliente, extração de texto) |
| `ASSEMBLYAI_KEY` | `/api/assemblyai/*` (Atas Condominiais, transcrição) |
| `OPENAI_KEY` | `/api/config` (exposta no cliente) |

## Endpoints do proxy (`server.js`)

- `GET  /api/config` → retorna `{openai}` pro cliente
- `POST /api/assemblyai/upload` — upload de áudio
- `POST /api/assemblyai/transcript` — inicia transcrição
- `GET  /api/assemblyai/transcript/:id` — polling de status
- `POST /api/claude/messages` — proxy para `api.anthropic.com/v1/messages` (adicionado na Etapa 1)

## Schema Supabase (tabelas principais)

- `condominios(id, nome, sindico, criado_em)`
- `demandas(id, num, prio, status, titulo, sit, acao, resp, prazo, metrica, tipo, condominio_id, origem_texto_bruto, processado_em, fonte)`
  - `tipo`: `'demanda'` ou `'prioridade'`
  - `origem_texto_bruto`, `processado_em`, `fonte`: adicionados na Etapa 1 via `MIGRATION_ETAPA1.sql`
- `laudos(...)` e `historico(...)` — vinculados ao `condominios.id`

Rodar migrations manualmente no Supabase Studio → SQL Editor.

## Módulos

Cada módulo tem um item na sidebar e um `div.panel` com id `panel-<slug>`. Registrados em `PAGE_META` e renderizados via `showPanel(name)`. Overrides específicos no final do `<script>` via padrão `_origShowPanel`.

| Módulo | Status | Prefix JS |
|---|---|---|
| Dashboard | ok | — |
| Importar Despesas / Unidades (Superlógica) | ok (Proprietário + Inquilino + Dependente desde 2026-04-30) | — |
| Boletos / Conciliação / NF | em breve | — |
| Condomínios | ok | `cp*` |
| Atas Condominiais | ok | — |
| Leitura de Consumo (medidores via IA) | ok | — |
| Tarefas | em breve | — |
| **Demandas de Cliente** | **em 3 etapas** | `dc*` |
| Configurações | ok | — |

## Demandas de Cliente — roadmap

- **Etapa 1 (PR #1)**: Caixa de Entrada funcional. Texto solto → Claude Sonnet 4.6 → cards editáveis → INSERT em `demandas` com `fonte='ia-caixa-entrada'`. Outras 3 tabs como placeholder "Em construção — Etapa 2/3".
- **Etapa 2**: Painel consolidado + aba Clientes.
- **Etapa 3**: Geradores (atas/laudos/relatórios a partir das demandas).

## Convenções

- UI e comentários em português.
- Nomes de função por módulo recebem prefixo: `cp*` (condomínios), `dc*` (demandas de cliente).
- Tabs reusam `setTab(el, tabId)` existente — basta usar IDs começando com `tab-`.
- `supaFetch(path, options)` devolve `null` em erro **e** em sucesso com `return=minimal`. Não dá pra distinguir falha por item.
- Commits em `main` historicamente com mensagens terse. Features novas vão por PR.

## Importação unificada de unidades

Suporte a múltiplos tipos de pessoa por unidade implementado em 2026-04-30.

- Planilha de 26 colunas (A a Z), 1 linha por pessoa, agrupada por Unidade+Bloco no parser
- Tipo de pessoa na coluna A: `Proprietário`, `Inquilino` ou `Dependente`
- API exige data em formato americano (`mm/dd/aaaa`) e UF como código numérico (8=ES, 25=SP, 19=RJ, 11=MG, 5=BA)
- `ID_TIPORESP_TRES` e `ID_LABEL_TRES` definem o tipo no payload: 2 = Proprietário, 7 = Inquilino, 4 = Dependente
- Endpoint único para todos os tipos: `POST /v2/condor/unidades/post?ID_CONDOMINIO_COND={id}`
- Fluxo por unidade: POST vazio cria a unidade, PUT popula Proprietário, N POSTs sequenciais adicionam Inquilinos e Dependentes
- Campos opcionais vazios são omitidos do payload (helper `omitirVazios`)
- Detector automático `detectarFormatoPlanilhaUnificada` preserva compatibilidade com o formato antigo de 30+ colunas
- Validado em produção em 2026-04-30 com status 200 para Inquilino e Dependente no cond 167, unidade A-0202

## Update Log

- 2026-04-30 | Feature Inquilino e Dependente validada localmente com unidade real 1102 A2 (Villagio Residencial), pronta pra produção. Detector de formato de planilha + parser unificado de 26 colunas + 2 builders de payload (Inquilino tipoResp 7, Dependente tipoResp 4) + 7 helpers de conversão (data BR para US, UF para codigo numerico, genero, tipo telefone, recebe cobranca, omitir vazios). 8 subagentes aprovaram.

## Observações conhecidas (não corrigir sem contexto)

- `public/index.html:3005` chama `api.anthropic.com/v1/messages` direto do browser (Leitura de Consumo), expondo key no cliente. Candidato a migrar pro proxy.
- `status='aberta'` usado em Demandas de Cliente diverge dos valores existentes na tabela (`Pendente`, `Em andamento`, `Concluído`, `Aguardando síndico`).
