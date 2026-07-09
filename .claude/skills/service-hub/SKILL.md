---
name: service-hub
description: >
  Master project skill for the Service Hub — Grupo Service / Virtual Service's internal operations
  dashboard. Use this skill whenever Matheus mentions Service Hub, asks to add a feature, fix a bug,
  build a new panel, change the UI, improve a module, automate a flow, or work on anything related
  to the Hub's HTML/CSS/JS codebase. Also trigger when discussing the Hub's integration with
  Superlógica, Claude in Chrome automation targeting the Hub, AI features inside the Hub (ata
  generator, report generation), or when Matheus sends a new version of the Hub file
  (Hoje_atualizado_pp.html or similar). This is the single source of truth for Service Hub context —
  always read it before touching the project, and always update it after discovering something new.
---

# Service Hub — Master Project Skill

> **⚠ Nota de estado (atualizada 2026-05-25):**
> Esta skill foi originalmente escrita referenciando `Hoje_atualizado_pp.html`. O **repo atual** (https://github.com/MatheusMelo2903/service-hub) usa:
> - `public/index.html` (~5338 linhas) — app principal (`/hub`)
> - `public/landing.html` — landing pública (`/`)
> - `public/tracker.html` — PWA Supabase (`/tracker.html`)
> - `server.js` (Express) — rotas explícitas
>
> Onde a skill diz `Hoje_atualizado_pp.html`, **traduzir para `public/index.html`** (mesma arquitetura: single-file vanilla HTML+CSS+JS). Demais convenções (módulos, design system, panel navigation) permanecem válidas.

**What is Service Hub?** A single-file HTML web app (`public/index.html`) that serves as
Virtual Service / Grupo Service's internal operations command center — managing multiple
condominiums, integrating with Superlógica ERP, and leveraging Claude AI for automation.

**Primary user:** Matheus (co-founder, operations lead).

---

## How to Use This Skill

When working on the Hub, follow this order:

1. **Read this skill first** — understand which module you're touching and its conventions
2. **Check cross-referenced skills** — most modules delegate to a specialist skill
3. **Respect the design system** — use existing CSS tokens, never introduce new colors or fonts
4. **Update the Update Log** (Section 9) after every session where you discover something new

---

## 1. Architecture at a Glance

| Property | Value |
|---|---|
| **File** | `Hoje_atualizado_pp.html` (single-file app) |
| **Stack** | Vanilla HTML + CSS + JavaScript — no framework |
| **Libraries** | SheetJS (`xlsx`) for spreadsheet parsing |
| **Fonts** | Plus Jakarta Sans (UI) · JetBrains Mono (data/mono) |
| **Layout** | Sidebar (220px, dark) + Main area (flex-1) |
| **ERP** | Superlógica — via REST API or browser-session injection |
| **AI** | Anthropic `/v1/messages` (Claude Sonnet) for Atas |
| **Automation** | Claude in Chrome extension (JS injection preferred) |

**Panel navigation pattern:**
```js
showPanel('panel-id')  // hides all .panel, activates target, updates topbar title
```

---

## 2. Module Map

### Principal
| Panel ID | Label | Notes |
|---|---|---|
| `dashboard` | Dashboard | Overview + quick-start action buttons |

### Superlógica ERP Integration
| Panel ID | Label | Notes |
|---|---|---|
| `despesas` | Despesas | Bulk expense import → see `superlogica-importar-despesas` skill |
| `unidades` | Unidades | Bulk unit import via xlsx drop · planilha unificada 26 colunas A-Z (Seção 3.5) |
| `boletos` | Boletos | Billing slips — UI exists, logic TBD |
| `financeiro` | Financeiro | Financial panel — UI exists, logic TBD |
| `nf` | NF | Nota fiscal / tax invoice — UI exists, logic TBD |

### Gestão (Operations Management)
| Panel ID | Label | Notes |
|---|---|---|
| `condominios` | Condomínios | Main CRM — full detail in Section 3 |
| `atas` | Atas | AI meeting-minutes generator — detail in Section 4 |
| `consumo` | Consumo | Utility meter photo + reading tracker |
| `tarefas` | Tarefas | Internal task management — UI exists, logic TBD |
| `configuracoes` | Configurações | API tokens, credentials, app settings |

---

## 3. Condomínios Panel — Full Detail

This is the most complex module. It acts as a lightweight CRM where each condominium has its own
workspace with tabs, data, and report generation.

### Data Model
```js
{
  nome: string,
  sindico: string,
  demandas: [{ num, titulo, sit, prio, status, resp, prazo, acao, fotoAntes, fotoDepois }],
  prioridades: [ /* same shape as demandas */ ],
  laudos: [{ nome, status, tecnico, data_laudo, enviado }],
  historico: [{ data, txt }],
  assinaturas: []
}
```

### Tabs
| Tab | Function |
|---|---|
| 📊 Visão Geral | Summary KPIs for the active condo |
| 🔴 Prioridades | High-priority demands |
| 📋 Demandas | Full demand list |
| 📄 Laudos | Technical inspections/reports |
| 📅 Histórico | Activity log |
| ✍️ Assinaturas | Signature collection |
| 📄 Relatório Síndico | Printable report for the building manager |
| 🔒 Relatório Interno | Confidential internal report |
| ⬆️ Importar Update | Bulk update import from spreadsheet |

### Status & Priority Values
```
Status:   Concluído · Em andamento · Pendente · Aguardando retorno · Aguardando sistema
Priority: alta · média / media · baixa
Colors:   alta=#ef4444 (red) · média=#f59e0b (amber) · baixa=#22c55e (green)
```

### Report Generation Rules
Both `gerarRelatorioSindico()` and `gerarRelatorioInterno()` work the same way:
- Open a new `window`, write formatted HTML, call `window.print()` on load
- **Always deduplicate** demands by title with a `Set` before rendering (items can exist in both
  `demandas` and `prioridades` arrays simultaneously)
- Síndico report: clean/professional — completed · in-progress · pending + laudos + recent history
- Internal report: adds an ⚠️ alert block for items where `resp.toLowerCase().includes('matheus')`
  AND `status === 'Pendente'`; stamped INTERNO — never share with síndico or third parties

### CRM Functions (`cp*` prefix)
```js
cpGetCondominioAtivo()            // returns active condo object (or null if none selected)
cpAbrirModal() / cpFecharModal()  // open/close Add Condominium modal
cpSalvarCondominio()              // saves new condo to the list
cpShowTab(tabName, btn)           // switches active tab within condo panel
cpGerarApresentacao()             // generates a presentation (Gamma MCP or pptx skill)
```

---

## 3.5 Painel Unidades — Formato Unificado (26 colunas A-Z)

O painel `Importar Unidades` usa um ROTEADOR DE ESTRUTURA que classifica a planilha em uma de
várias famílias e delega ao parser certo. O ponto de entrada é `detectarLinhaCabecalho(allRows)`
(acha o cabeçalho real, ora na linha 0, ora na linha 3) seguido de `detectarFamiliaPlanilha(headers)`,
testado do mais estrito ao mais genérico:

```
unificado (26 colunas A a Z)        → processUnidadesDataUnificada
w045a-contatos (coluna Tipo)        → corrigirDeslocamentoW045A + parseW045AContatos + inferirPapeis + validarDocumentosW045A
quattro (35 colunas Superlógica)    → processUnidadesData + validarUnidadesAgrupadas
proponentes (1º/2º/3º Proponente)   → processFamiliaProponentes
plana (1 linha = 1 unidade)         → processFamiliaPlana
nada bateu                          → orienta usar "Normalizar via IA"
```

As 4 famílias de planilha crua (plana, proponentes, w045a, quattro) desaguam TODAS na mesma tela de
revisão (`abrirRevisao`), com contagem unificada origem→unidades→pessoas e chip "Com erro (N)". A IA
só produz a planilha de 26 colunas e entrega para o mesmo funil; quem conta e valida é o código, a
partir das linhas reais. Duas leituras de apoio obrigatórias: `normalizarCelula(v)` lê número longo
(CNPJ, telefone, RG, CEP, unidade) com os dígitos completos, sem notação científica (senão CNPJ de PJ
como banco/imobiliária/SPE viraria `6.22329E+13` e seria perdido); e a assinatura de conteúdo
(`isCPF`/`isCNPJ`/`isEmail`/`isUF`/`isCEP`/`isFracao`) valida cada coluna por conteúdo. Regra dura:
CPF de 11 dígitos vai na coluna G, CNPJ de 14 na H, e um nunca reprova o outro (PJ como proprietário
é legítimo e tem que passar). Harness de prova em `scripts/import-unidades-harness/` roda o motor real
contra 7 amostras reais (7/7).

### MARCO OURO da importação (referência, em produção)
Estado de referência que importa TUDO certo de uma vez, validado em produção em 30/04/2026 (unidade
1102 A2 do Villaggio Residencial, status 200 com ids reais da API):
- **Fração** da unidade com valor certo, via `NM_FRACAO_UNI` no PUT do proprietário (commit `ee1fc03`, 2026-04-29).
- **Nome, CPF e celular** de PROPRIETÁRIO, DEPENDENTE e INQUILINO, cada papel com seu próprio documento
  e contato, sem se misturar (commit `014d72f`, 2026-04-30).

Como o payload separa os papéis sem misturar:
- Proprietário: contato do POST vazio + PUT com `FL_PROPRIETARIO_CON=1`, `ST_NOME_CON`, `ST_CPF_CON`,
  `ST_TELEFONE_CON` (celular) e a `NM_FRACAO_UNI` no nível raiz da unidade.
- Dependente: POST próprio via `buildPayloadContatoExtra` com `ID_TIPORESP_TRES=4`, `ID_TIPOCONTATO_TCON=1`,
  e seu próprio nome/CPF/celular.
- Inquilino: idem, com `ID_TIPORESP_TRES=7`.

O motor novo (roteador + 4 famílias) reproduz esse marco campo a campo: cada parser desagua em
`unidadesAgrupadasParaContatos` → `contatoParaLinha26` → `processUnidadesDataUnificada` → o mesmo
`prop_*` / `contatos_extras[]` do marco, e o caminho de envio (`enviarUmaUnidade`,
`buildPayloadContatoExtra`) é byte a byte idêntico ao de produção. Panorama completo em
`tarefas/concluidas/panorama-import-unidades.md`.

### Cabeçalho exato (formato unificado)
```
A=Tipo  B=Unidade  C=Bloco  D=Fração  E=Metragem  F=Nome
G=CPF   H=CNPJ     I=RG     J=Data Nascimento  K=Gênero  L=Email
M=DDI   N=Telefone O=Tipo Telefone  P=CEP  Q=Endereço  R=Número
S=Complemento  T=Bairro  U=Cidade  V=Estado  W=Data Entrada
X=Data Saída  Y=Recebe Cobrança  Z=Observação
```

### Regras de preenchimento por coluna
| Col | Campo | Valores aceitos / Observação |
|---|---|---|
| A | Tipo | `Proprietário` · `Inquilino` · `Dependente` (uma linha por pessoa) |
| B | Unidade | Número/código da unidade (ex: `A00001`, `0201`, `COM005`) |
| C | Bloco | Nome do bloco/torre (ex: `A1`, `Torre A`, `COM1`) — opcional |
| D | Fração | Aceita `0.135753` ou `0,135753`. Zero/vazio → omitido |
| G/H | CPF/CNPJ | Só dígitos. CPF=11 dígitos, CNPJ=14. Preencher só um dos dois |
| J | Data Nascimento | Formato `dd/mm/aaaa` (converte interno pra `mm/dd/aaaa`) |
| K | Gênero | `M` → 1 · `F` → 2 · vazio/outro → 0 |
| M | DDI | Padrão `55`. Só preencher se houver telefone |
| N | Telefone | Só dígitos com DDD (ex: `27998148653`). Sem `+`, sem espaços |
| O | Tipo Telefone | `1`=fixo · `2`=celular · `3`=comercial. Default celular |
| P | CEP | Só dígitos. Aceita `29042753` ou `29042-753` |
| V | Estado | Sigla 2 letras (`ES`, `SP`, `RJ`...) — converte para código numérico via `UF_CODIGOS` |
| W | Data Entrada | Inquilino sem data → default hoje. Format `dd/mm/aaaa` |
| Y | Recebe Cobrança | `Sim`/`S` → 2 · `Não`/`N` → 1 · vazio → campo omitido |

### Comportamento de agrupamento
- Linhas com mesma combinação `Unidade + Bloco` são agrupadas como UMA unidade no Superlógica
- Cada grupo deve ter exatamente **1 Proprietário** (linhas duplicadas viram aviso e são descartadas)
- Inquilinos têm `ID_TIPORESP_TRES=7`, Dependentes têm `ID_TIPORESP_TRES=4`
- Endereço, CEP, telefone do Proprietário viram dados de cobrança da unidade
- Inquilinos/Dependentes mantêm seus próprios endereços e contatos

### Limpeza automática aplicada
Valores tratados como vazio: `nan`, `0`, `0.0`, `CEP INVÁLIDO`, `Cep Inválido`, `INVÁLIDO`.
Telefones: todos os caracteres não-numéricos removidos antes de enviar.

### Cross-reference
Para o fluxo real de POST + PUT na API Superlógica que esta planilha alimenta, ver:
- `importar-unidades-superlogica-via-api` — fluxo definitivo de 2 chamadas por unidade
- `superlogica-importar-unidades-api` — variação com debug em campo (528 unidades Quattro)

---

## 4. Atas Panel — Meeting Minutes Generator

### Flow
1. User fills in: condo name, date (DD/MM/AAAA), meeting type, síndico name, location, agenda items
2. User provides transcript via: audio import (.mp3/.mp4/.m4a/.wav/.ogg/.webm/.flac/.aac) or
   paste/import a pre-made `.txt` transcript
3. Hub calls Anthropic `/v1/messages` (Claude Sonnet) with transcript + metadata
4. Result renders in a scrollable monospace result box

**Cross-reference:** See `ata-condominial` skill for the exact tone, structure, and legal
formatting required for Brazilian condominium meeting minutes.

### RÉGUA REALISTA — critério OFICIAL de qualidade do motor de ata (aprovado 2026-07-08)

Substitui o critério antigo "Enseada 14/14 idêntico sempre". A ata é documento formal
apoiado em fala humana, então a barra é realista, não mecânica:

1. **Valor CLARO na fala** → consertado/inserido DETERMINISTICAMENTE por código
   (`corrigirPlaceholdersDeliberacao` no `server.js`), sempre presente. Nunca perder valor
   claro. Fecha o bug de garbling.
2. **Valor GENUINAMENTE ambíguo** (pessoa fala e se corrige, inaudível, conflito real) →
   marcado `[a confirmar]` para revisão humana, NUNCA chutado. Marcar `[a confirmar]` num
   valor que o próprio áudio deixou confuso é comportamento CORRETO, não bug.
3. **Ruído** (hipotéticos, exemplos, propostas rejeitadas, arredondamentos de fala) → fora
   da ata, como o gabarito humano faz.

**Critério de "pronto":** valores-alvo consertados de forma CONSISTENTE entre rodadas +
conflitos reais marcados `[a confirmar]` de forma PREVISÍVEL (não viram valor inventado).
Percentual e medida seguem fora da contagem. Detalhe completo em
`tarefas/em-andamento/roadmap-velocidade-ata.md` (seção RÉGUA REALISTA + REGRA DE FERRO).

**Nota de config (2026-07-08):** a chamada Anthropic da ata NÃO usa `temperature` explícito
(usa o default da API), para manter o estilo de ata já validado pela interface. O reteste
mostrou que `temperature: 0` NÃO trouxe determinismo de valor (Enseada variou 14/13/12
mesmo assim); a consistência vem da correção cirúrgica + auditoria fracionada, não da
temperatura.

---

## 5. Design System — Quick Reference

Always use these tokens. Never hardcode hex colors or introduce new fonts.

### Brand Colors
| Token | Hex | Use |
|---|---|---|
| `--gs-dark` | `#3A3A3A` | Sidebar background |
| `--gs-blue` | `#3B9AC7` | Primary accent (CTA buttons, active states) |
| `--gs-blue-light` | `#EBF5FB` | Active chip background |
| `--gs-blue-mid` | `#D0EAF6` | Active tab border |
| `--bg` | `#F4F6F9` | Page background |
| `--bg2` | `#FFFFFF` | Card / panel background |
| `--bg3` | `#EEF1F6` | Input / stat card background |
| `--success` | `#2DAE72` | Completed / online |
| `--danger` | `#E03A3A` | Error / remove |
| `--warning` | `#E09A20` | Pending / warning |
| `--text` | `#1E2533` | Primary text |
| `--muted` | `#8892A4` | Labels, placeholders |

### Key Component Classes
```
Buttons:  .btn-primary · .btn-ghost · .btn-danger
Badges:   .badge-ok · .badge-warn · .badge-err · .badge-send
Chips:    .chip / .chip.active
Tabs:     .tab / .tab.active
Layout:   .stat-card · .card · .dropzone · .log-wrap · .toast · .modal-overlay
```

### Layout Rules
- Sidebar: 220px fixed · Main: flex-1 · Topbar: 60px · Content padding: 28px
- Stats grid: 4 cols → 2 cols on ≤900px · Dashboard grid: 2fr 1fr → 1 col on ≤900px
- Custom scrollbar: 6px, transparent track, `--border2` thumb

---

## 6. Superlógica Integration

Two modes — always prefer B when Claude in Chrome is active:

**A) REST API** (no browser needed)
- Requires `app_token` + `access_token` from Configurações panel
- Base URL: `api.superlogica.net/v2/condor/`
- Gateway: Sensedia — has time restrictions and rate-limit quirks
- See `superlogica-api-rest` skill

**B) Browser-session injection** (preferred)
- User must be logged into `condominioes.superlogica.net`
- Inject JavaScript directly into Handsontable grids
- Faster, no token auth issues, no Sensedia restrictions
- See `superlogica-navegacao` skill

---

## 7. Claude in Chrome Automation

When automating the Hub via the Chrome extension:

- Prefer `javascript_tool` (JS injection) over physical clicks
- Use `find` to locate elements by natural language
- Use `read_page` (accessibility tree) to understand current state before acting
- Use `tabs_context_mcp` to confirm you're on the correct tab

See `browser-chrome-operacao` skill for full patterns, known failure modes, and the proven
operation order.

---

## 8. Pending / Known Gaps

Panels with UI but undocumented logic — fill these in as you implement them:

| Panel | Gap |
|---|---|
| `panel-boletos` | Billing slips flow not yet analyzed |
| `panel-financeiro` | Financial overview logic not yet analyzed |
| `panel-nf` | Nota fiscal flow not yet analyzed |
| `panel-tarefas` | Internal task board logic not yet analyzed |
| `cpGerarApresentacao()` | Suspected: Gamma MCP or pptx skill — not confirmed |
| Assinaturas tab | Signature collection workflow not yet fully visible |

---

## 9. Update Log

> Add new rows at the TOP when you discover something new.
> Format: `YYYY-MM-DD | What was discovered or changed`

| Date | Update |
|---|---|
| 2026-05-18 | Documentado formato unificado de 26 colunas A-Z aceito pelo painel Unidades (Seção 3.5) — heurística de detecção, regras por coluna, agrupamento Proprietário+Inquilino+Dependente, conversões automáticas (UF→código, gênero→1/2/0, telefone só dígitos) |
| 2026-04-24 | Skill restructured with YAML frontmatter, imperative instructions, cross-reference map |
| 2026-04-24 | Skill created from `Hoje_atualizado_pp.html` analysis — all visible modules documented |

---

## 10. Cross-Reference Map

| Need | Go to |
|---|---|
| Import expenses into Superlógica | `superlogica-importar-despesas` |
| Import units into Superlógica | `superlogica-importar-unidades` or `superlogica-importar-unidades-api` |
| Superlógica REST API calls | `superlogica-api-rest` |
| Superlógica browser navigation | `superlogica-navegacao` |
| Chrome browser automation | `browser-chrome-operacao` |
| Meeting minutes formatting | `ata-condominial` |
| Follow-up / tracking reports | `relatorio-acompanhamento` |
| PowerPoint / slides output | `powerpoint-prestacao-contas` or `pptx` skill |
| Word document output | `docx` skill |
| PDF output | `pdf` skill |
| Gamma presentation | Gamma MCP |
| CEO / strategic decisions | `ceo-executivo` |

---

## 11. Integrações — Padrão MasterClinic (adicionado 2026-05-25)

> Bloco novo importando o padrão `integracoes` do MasterClinic: tabela de endpoints corretos vs deprecated, armadilhas críticas, auth detalhado e DevTools JS pattern. Material extraído principalmente de `superlogica-navegacao/SKILL.md` (do mesmo zip).

### 11.1 Superlógica — Endpoints corretos vs deprecated

Base: `https://condominioes.superlogica.net/condor/atual/` — `atual` = condomínio ativo na sessão.

| Dado | Endpoint correto | NÃO usar |
|---|---|---|
| Condomínio ativo | POST `/condominios/get` | `/condominios/index` (404) · `/condominio/index` (500) |
| Cobranças pendentes | `/cobranca/index?status=pendentes&apenasColunasPrincipais=1&dtInicio=...&dtFim=...&limit=999` | `/cobrancas/...` (404) |
| Cobranças liquidadas | `/cobranca/index?status=liquidadas&filtrarpor=liquidacao&dtInicio=...&dtFim=...&limit=999` | — |
| Despesas pendentes | `/despesas/index?comStatus=pendentes&dtInicio=...&dtFim=...&limit=999` | — |
| Despesas pagas | `/despesas/index?status=liquidadas&comStatus=liquidadas&filtrarpor=liquidacao&...&limit=999` | — |
| Unidades | `/unidades/index?limit=999` | — |
| Contas bancárias | `/contabancos/index?exibirDadosAgencia=1&...&semContaDigital=0` | `/contabancos/index` sem flags (dados parciais) |
| Inadimplência | `/inadimplencia/index?limit=999&comValoresAtualizados=1` | sem `comValoresAtualizados` (valores zerados) |
| Plano de contas | `/planocontas/index?limit=999&exibirZerados=0` | — |
| Fornecedores | `/fornecedores/index?contatosDoTipo=fornecedores&limit=999` | — |
| Sindicos histórico | `/sindicos/index?comStatus=todos&limit=50` | sem `comStatus=todos` (só atuais) |
| Régua de cobrança | `/notificacaoautomatica/index` | — |
| Assembleias | `/assembleiasv2/index?limit=50` | `/assembleias/index` (versão antiga) |
| Apps | navegação (clique) | `/apps/index?id=X` via fetch (500) |

### 11.2 Armadilhas críticas

**Troca de condomínio:** clique JS pode falhar silenciosamente.
```js
// ❌ Erro frequente: assumir que clique trocou
document.querySelector('.condominios-topo').click();
// imediatamente fazer fetch — pode pegar o condomínio ANTERIOR

// ✅ Pattern correto: aguardar + verificar
await new Promise(r => setTimeout(r, 400));
jQuery('#NOME_LICENCA').val('NOME_PARCIAL').trigger('input');
await new Promise(r => setTimeout(r, 1200));
const item = [...document.querySelectorAll('.ui-autocomplete .ui-menu-item a')]
  .find(el => el.innerText.includes('NOME_COMPLETO'));
item.click();

// Confirmar troca antes de prosseguir
const ativo = await fetch('/condor/atual/condominios/get')
  .then(r=>r.json()).then(d=>d.data?.[0]?.st_nome_cond);
if (!ativo.includes('NOME_ESPERADO')) throw new Error('Troca falhou');
```

**Filtros opcionais que mudam payload:** vários endpoints retornam dados parciais sem flags específicas. Exemplo `inadimplencia` sem `comValoresAtualizados=1` retorna zeros. Sempre incluir flags conhecidas, mesmo redundantes.

**Apps via URL params:** apps Superlógica abrem via navegação (clique no menu), nunca via `fetch /apps/index?id=X` (sempre 500). Para automação, navegar e capturar resposta.

### 11.3 Auth Superlógica — sempre via proxy

```
Hub frontend → superlogica-proxy → Superlógica
```

| Camada | Token / método | Onde mora |
|---|---|---|
| Hub → proxy | sem token (proxy é público mas só responde do domínio Hub) | — |
| proxy → Superlógica | `app_token` + `access_token` (Basic auth equivalente) | Railway env do `superlogica-proxy` |
| Sessão browser (Chrome MCP) | cookie `condor_atual_*` + JWT em `window.__tokenManager__.tokens` | navegador do operador |

**Inviolável:** tokens nunca aparecem no `public/index.html`, nem em comentários, nem em commits. Único caminho front→ERP é via proxy.

**URL proxy:** `https://superlogica-proxy-production.up.railway.app`

### 11.4 DevTools JS pattern — quando API insuficiente

Algumas operações não têm endpoint REST e exigem navegação. Pattern aprovado (Chrome MCP / Claude in Chrome):

```javascript
// 1. Capturar JWT da sessão atual (caso precise chamar outra API)
const token = window.__tokenManager__?.tokens?.accessToken;

// 2. Preferir fetch interno (mesma origem, herda cookie + headers)
const data = await fetch('/condor/atual/cobranca/index?status=pendentes&limit=999', {
  credentials: 'same-origin'
}).then(r => r.json());

// 3. Para mutações via UI (clicar botão, abrir modal), usar seletores estáveis
//    NUNCA coordenadas (x,y) — quebra ao primeiro CSS que mexer
const btn = document.querySelector('[data-action="emitir-boleto"]');
if (!btn) throw new Error('Botão não encontrado — UI mudou');
btn.click();

// 4. Aguardar resposta antes de prosseguir (não confiar em load only)
await new Promise(r => setTimeout(r, 800));
const toast = document.querySelector('.toast-success');
if (!toast) throw new Error('Operação não confirmada — possivelmente falhou');
```

**Skills relacionadas** (mesmo zip Matheus, ler quando precisar):
- `superlogica-navegacao` — mapa completo de URLs, padrões por porte
- `superlogica-api-rest` — endpoints REST detalhados
- `superlogica-api-operacao` — operações via API
- `browser-chrome-operacao` — base para Chrome automation

---

## 12. Cross-Reference (continuação)

Atualizado em 2026-05-25 com refs Service Hub:

| Need | Go to |
|---|---|
| Pasta direcional Service Hub | `MISSION_CONTROL.md`, `PROJECT_CONTEXT.md`, `PLANO_ATIVO.md` (raiz do repo) |
| Subagentes (architect, implementer, etc) | `.claude/agents/` |
| Rotação de secrets (Superlógica, Anthropic) | `.claude/skills/ops/SKILL.md` + `scripts/rotate-secrets-sh.sh` |
| Frontend design distintivo | `.claude/skills/frontend-design/SKILL.md` |
| Auditoria das skills MC adaptadas | `AUDITORIA_SKILLS_MC_PARA_SH.md` |
