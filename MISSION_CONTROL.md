# 🛰️ MISSION CONTROL — Service Hub

> Arquivo gerenciado pelo agente. Atualizar ao fim de cada task ou fase.

**Última atualização:** 2026-06-24
**Branch padrão:** main
**Repo:** https://github.com/MatheusMelo2903/service-hub
**Deploy:** Railway (`eloquent-love`) · https://service-hub-production.up.railway.app

---

## 🚀 SPRINT ATIVA — 2026-05-27 a 2026-06-09 (14 dias)

**Plano completo:** `PLANO_ATIVO.md`
**Status:** 🟢 Em execução

### Entregas extras desta sprint (fora do plano original)
| Task | Status | Entrega |
|---|---|---|
| ata-fidelidade-v3 — regras de fidelidade no system prompt + segundo passe de auditoria | ✅ | branch `feat/ata-fidelidade-v3` · commit `8cec7de` (server.js +92/-4) · teste Happy Days 3/4 passou · doc em `tarefas/concluidas/ata-fidelidade-v3.md` |
| prestacao-bloco-a-prosa-rica — prosa rica deterministica (3 moldes) + Bloco A com download robusto PDF/PPTX e padrao W016A | ✅ | commit `ad2439c` · 3 arquivos (+222/-18 linhas) · revisor, auditor e validador aprovados · 2026-06-23 · deploy dev (service-hub `49083866` + prestacao-pdf `31257000`) |
| prestacao-serie-mensal — ingestão multi-fonte W011A/W015A/W016A + série mensal real + reconciliação entre fontes | ✅ | commit `69ec74b` · 9 arquivos (+2083/-16 linhas) · detector.py + parser_w011a.py + parser_w015a.py novos · 28/28 testes · revisor, auditor e validador aprovados · 2026-06-23 · deploy dev pendente (aguarda Matheus testar) |
| **prestacao-entrega-1** — contraste projeção + ícone mono + seletor de formato de saída | 🟡 **no dev, aguardando teste prático** | commit `6b2d888` · 4 arquivos (+98/-8 linhas) · revisor, auditor e validador aprovados · 2026-06-24 · deploy dev (prestacao-pdf `ed3fea8b` + service-hub `15df9825` SUCCESS) · aguarda Matheus testar legibilidade na parede antes de produção |
| **prestacao-entrega-2** — botão Refinar prestação com IA (somente texto) | 🔴 **pendente de plano do arquiteto** | tarefa em `tarefas/em-andamento/prestacao-botao-refinar-ia.md` · aguarda arquiteto planejar antes de implementar |

### Feature da Tarefa 2 — aguardando validação do Matheus
🟡 **prestacao-serie-mensal** — implementada, deploy dev pendente. Commit `69ec74b`. Aguarda Matheus testar no dev. Correção de rota: W011A é matriz de receitas E despesas (não só despesas); W016A é opcional; Superávit calculado do W011A. Doc: `tarefas/em-andamento/prestacao-serie-mensal.md`.

🟡 **prestacao-entrega-1** — contraste projeção + ícone mono + seletor de formato. Commit `6b2d888`. Deploy dev SUCCESS (prestacao-pdf `ed3fea8b` + service-hub `15df9825`). Aguarda Matheus testar legibilidade na parede antes de produção. Pendência pré-produção: remover `console.log` com dados financeiros em `public/prestacao.js` (~linha 2100, função `prestacaoGerarClientSide`) — achado do auditor, não bloqueante na dev.

### Próxima tarefa
🔴 **1.1 — Seletor de condomínio com ID** (4h, bloqueador da Fase 1)
- Substitui a digitação manual do identificador
- Bloqueador das tarefas 1.4 e 1.5
- Critério de aceite: testar com condomínio 167

### Demais tarefas da Semana 1 (27/05–02/06)
- 🟡 1.2 — Higiene de deploy (1h)
- 🟡 Matheus — Levantar tabela de % por rubrica (até 02/06)
- 🟡 Matheus — Convidar User 2 do Grupo Service (até 02/06)

---

## SPRINT 2026-05-26/27 — Sistema de usuários (Fase 0)

**Status:** 🟢 **FECHADA**

| Task | Status | Entrega |
|---|---|---|
| f0t1 — migration profiles + roles + RLS + triggers | ✅ | `2026-05-26_002_profiles_roles.sql` aplicada em prod |
| f0t2 — backend rotas /api/admin/usuarios + requireGestor | ✅ | server.js + middleware GoTrue |
| f0t3 — frontend aba Usuários + modais convidar/permissões | ✅ | index.html (Configurações) |
| f0t4 — seed dev + botão Reset (RPC + proteção backend) | ✅ | scripts/seed-dev.sql + RPC |
| f0t5 — JWT Supabase via ES256/JWKS | ✅ | fix root cause do 401 em /api/* |
| f0t9 — GESTOR/GERENTE/OPERACIONAL em prod + smoke E2E | ✅ | Matheus logando, permissões aplicando |

**Ambientes:**
- Prod (`mtucxdfepkwsfnqpfydb`): GESTOR criado, SERVICE_ROLE_KEY rotacionada no Railway
- Dev (`ledgyprytkuvgtbunsck`): migrado da org pessoal → Grupo Service, schema sincronizado, deploy ativo

---

## SPRINT 2026-05-25/26 — Entrega 1 (Blindagem de Segurança)

**Status:** 🟢 **FECHADA**

| Fase | Status | Entrega |
|---|---|---|
| A — revogar sessão vazada + reset MCP | ✅ | refresh_tokens revoked=true via SQL (GoTrue), user 6e6f9c4e revogado |
| B — login no Hub (Supabase Auth) em dev | ✅ | commits `844f087..504e460` em `dev` + botão Sair |
| C — smoke local + validação visual em prod | ✅ | gate aparece anônimo, login funciona, listagem condomínios OK, logout volta gate |
| D — merge dev → main + ENVs Railway + deploy | ✅ | merge `f15f4ac` em main, ENVs setadas, deploy SUCCESS |
| E — DROP policies public (via Matheus MCP) | ✅ | migration `2026_05_25_002_close_public_policies` aplicada |

### Smoke anônimo pós-Fase E (validação RLS)

| Tabela | curl anon | Resultado |
|---|---|---|
| condominios | GET ?select=id&limit=1 | `[]` 200 ✅ bloqueado |
| demandas | idem | `[]` 200 ✅ bloqueado |
| historico | idem | `[]` 200 ✅ bloqueado |
| laudos | idem | `[]` 200 ✅ bloqueado |
| hub_progresso | idem | 3 rows 200 ✅ intacta (tracker PWA) |

### Achados importantes

- User `matheusmelorodrigues2005@outlook.com` foi **recriado** durante reset de senha: id antigo `6e6f9c4e-a01d-4be6-899e-5be2eb7c01bd` → id novo `5c36d543-...`. `access_level: total` foi restaurado no novo user.
- Advisor de segurança: 4 alertas RLS críticos sumiram. Resta apenas hub_progresso (intencional).

---

## 🟡 Pendências da Entrega 1.1

| Item | Prioridade | Notas |
|---|---|---|
| **SUPABASE_JWT_SECRET no Railway** | ✅ | resolvido em prod + dev |
| **hub_progresso ainda com acesso_publico** | 🟡 média | Tracker PWA standalone — migrar pra login Supabase, ligar RLS |
| **Leaked password protection desligado** | 🟡 média | Studio: Authentication > Policies / Password Settings |
| **OTP expiry > 1h** | 🟡 média | Reduzir pra <1h via Authentication > Email |
| **User temp `mateus-teste@servicehub.local`** | 🟢 baixa | Deletar via Studio depois de garantir que User 1 real loga |
| **User 2** | 🟢 baixa | Matheus convida pelo Studio quando definir |

---

## SPRINT 2026-05-25 — Pasta direcional + skills MC (anterior, fechada)

**Status:** 🟢 5 fases entregues · 6 commits no SH + 1 PR no MC

### Checklist da sessão (5 fases do protocolo)

| Fase | Status | Entrega | Commit |
|---|---|---|---|
| 1 — validator-v2 no MC | ✅ | `feat/validator-v2` branch + [PR #9](https://github.com/mateusmeloc/clinicmanager-erp/pull/9) | MC `792f0b3` |
| 2 — Estrutura direcional SH | ✅ | 18 arquivos (.md raiz + .claude + docs + tarefas + .gitignore) | SH `7245520` |
| 3 — frontend-design + 7 subagentes | ✅ | architect, implementer, reviewer, security-auditor, validator, validator-v2, documenter + frontend-design | SH `038f83b` |
| 4 — ops adaptado + script rotação | ✅ | `.claude/skills/ops/SKILL.md` + `scripts/rotate-secrets-sh.sh` (+x) | SH `db274da` |
| 5 — Upgrade skill service-hub | ✅ | SKILL.md com 4 blocos padrão integracoes (endpoints + armadilhas + auth + DevTools) | SH `60501f7` |
| Final — MISSION_CONTROL preenchido | ✅ | este arquivo | SH (próximo commit) |

### Verificação end-to-end

- ✅ MC: `feat/validator-v2` branch + PR #9 abertos pra `hq` (não main, conforme memória)
- ✅ SH: 6 arquivos `.md` raiz + 3 em `docs/` + 7 agents + 3 skills locais
- ✅ SH: `.gitignore` atualizado com `.claude/SESSION_LOG.md`, `.claude/settings.local.json`, `docs/handoffs/*`
- ✅ SH: CLAUDE.md original (100 linhas) intacto + seção "Pasta direcional" appended
- ✅ Nenhum secret vazado em commits
- ✅ Script `rotate-secrets-sh.sh` é executável (`chmod +x`)

---

## 🟡 Pendente (próximas sessões)

| Item | Próximo passo | Prioridade |
|---|---|---|
| **PANORAMA_ESTRATEGICO.md** | sessão de produto com Matheus — preencher 4 seções (o que é, problema, visão 3-5 anos, jornada) | 🔴 alta |
| **PLANO_ATIVO.md** | ✅ resolvido — sprint 27/05–09/06 definida | — |
| **CLAUDE.md ampliado** | adicionar regras V8S específicas, armadilhas conhecidas, padrão Anthropic tool use | 🟡 média |
| **Auditoria técnica completa** | expandir AUDITORIA_PROJETO.md — npm audit, lighthouse, rotas Express vs links | 🟡 média |
| **Importar 19 skills restantes do zip Matheus** | superlogica-api-rest, ata-condominial, etc → `.claude/skills/` | 🟡 média |
| **Skill global `~/.claude/skills/service-hub/`** | protocolo de sessão tipo masterclinic | 🟡 média |
| **Limpar resíduos do repo** | `tracker-pwa.html`, `service-hub.md`, `service-hub-tracker.html`, `MIGRATION_*.sql` | 🟢 baixa |
| **MR do PR #9 (validator-v2)** | revisão + merge na hq do MC | 🟡 média |

---

## 🔴 Bloqueador crítico

Nenhum.

---

## 🟠 Pendências críticas pré-piloto

| Item | Origem | Próximo passo | Prioridade |
|---|---|---|---|
| **Rate limit dedicado em `/api/atas/gerar`** | Dívida pré-existente agravada por `ata-fidelidade-v3` (segundo passe dobra custo Anthropic; quadruplica no fallback Opus) | Rate limit por session (ex. 10 req/min por sub do JWT) em rotas de IA antes do piloto com mais de 1 usuário gerando ata simultaneamente | 🔴 alta |
| **Feature flag `ENABLE_ATA_AUDIT`** | Arquiteto registrou como dívida em `ata-fidelidade-v3` | Permitir desligar o segundo passe via ENV se rate limit Anthropic apertar em produção | 🟡 média |
| **Timeout próprio do segundo passe** | Arquiteto registrou como dívida em `ata-fidelidade-v3` | Reduzir de 120s default para 60s na chamada de auditoria | 🟡 média |

---

## 🟡 Backlog de iteração — ata fidelidade

| Item | Origem | Próximo passo |
|---|---|---|
| **Critério 2 Happy Days — "Wellington (Eriton)"** | Teste 2026-05-28 (3/4 critérios) | Reforçar FID 3 com exemplo concreto do caso Happy Days no system prompt OU adicionar regra "qualquer variação do nome do síndico → registrar TODAS entre parênteses". Refazer teste depois. |
| **Lara Hoffman não testado** | Transcrição não estava no repo nem em `~/Downloads/` em 2026-05-28 | Quando Matheus passar o arquivo, rodar o mesmo pipeline (`outputs/run-teste-happy-days.sh` adaptado) e validar com `outputs/validar-fidelidade-v3.js` |
| **Consolidar `REGRAS_ANTI_ERRO` e `REGRAS_FIDELIDADE_TRANSCRICAO`** | Arquiteto apontou sobreposição semântica entre anti-invenção e FID 1/2/3 | Refatorar em uma única constante coesa na próxima iteração |

---

## 📋 Próxima sessão — sugestão de pauta

1. **Tarefa 1.1 — Seletor de condomínio** (4h)
   - Dropdown nome + ID, persistir na sessão
   - Integrar com importação de unidades
   - Critério: testar com condomínio 167

2. **Tarefa 1.2 — Higiene de deploy** (1h)
   - Verificar se hook de secrets (2B) funciona em commit real

3. **Alinhamento de produto com Matheus** (1h)
   - Preencher PANORAMA_ESTRATEGICO.md (4 seções)

---

## Log de atividade

- **2026-07-07** — Previsão Orçamentária, Modo A: 3 gaps corrigidos + 1 hardening em `public/previsao-modulo.html`. Gap A (regex da linha de TAXA reconhece todos os rótulos, corrige reajuste 0,00% falso do Reserva Verde), Gap B camada 1 (total a ratear ancorado na linha de TAXA em vez de somado das categorias, Reserva Verde vai de R$ 188.083 falso para R$ 138.224 correto), Gap C (cor do texto ilegível na prévia da planilha) e hardening da Guarda 2 (bloqueia taxa base zero e linha de TAXA duplicada divergente). Harness Node novo em `scripts/previsao-harness/` valida `parsePlanilhaPronta` real do HTML contra 5 planilhas reais (5/5 batendo). Revisor e auditor de segurança aprovaram. Commits `a427f10..7d7cb7e`. Doc em `tarefas/concluidas/previsao-modo-a-gap-abc.md`. Pendências: Gap B camada 2 (decisão do Matheus), validação visual no dev (aguarda push) e remoção de `skills-server/Previsao_Naturale_2026.xlsx` (planilha real de cliente no git).
- **2026-06-24** — Prestação Entrega 1 commitada e enviada para dev. 3 ajustes visuais/UX: (1) contraste da tabela de lançamentos no slide de detalhamento melhorado para projeção em parede (3 tokens C_ROW_BAND/C_ROW_ALT/C_INK, bandas azuis, texto escurecido, 28/28 testes ok); (2) ícone da aba trocado para ▤ monocromático; (3) seletor de formato de saída Ambos/Somente PDF/Somente PowerPoint adicionado (frontend-only, backend inalterado). Deploy dev SUCCESS (prestacao-pdf `ed3fea8b` + service-hub `15df9825`). Commit `6b2d888`, push origin/dev. Aguarda teste prático do Matheus antes de produção. Pendência pré-produção registrada: remover console.log financeiro em `prestacao.js` ~linha 2100. Entrega 2 (botão Refinar com IA) registrada em `tarefas/em-andamento/prestacao-botao-refinar-ia.md`, aguarda plano do arquiteto.
- **2026-06-23** — Tarefa `prestacao-serie-mensal` implementada e deployada na dev. Engine de prestação passa a aceitar 1 a 3 PDFs (W011A + W015A + W016A), detecta tipo por conteúdo, reconcilia totais entre fontes (aviso >= 1%, bloqueio >= 5%) e gera série mensal real de Evolução de despesas e Superávit mensal. Correção de rota descoberta nos PDFs reais: W011A é matriz de receitas E despesas; W016A é opcional; Superávit calculado inteiramente do W011A. 28/28 testes. Commit `69ec74b`, 9 arquivos (+2083/-16 linhas). Dados reais de condomínio não entram no git. Deploy dev pendente (aguarda Matheus testar). Follow-ups registrados: dedup de helpers, console.log financeiro no fallback, bug 422 W016A em tarefa separada.
- **2026-05-28** — Tarefa `ata-fidelidade-v3` concluída. Adicionadas regras de fidelidade (FID 1–5) no system prompt do gerador de atas + segundo passe de auditoria (Sonnet 4.6, max_tokens 16k, re-validado com `validarAta`). Teste real Happy Days: 3/4 critérios passaram (critério 2 "Wellington (Eriton)" falhou — backlog). Lara Hoffman pendente (arquivo não disponível). Dívida agravada: rate limit dedicado em `/api/atas/gerar` virou pendência crítica pré-piloto. Branch `feat/ata-fidelidade-v3`, commit `8cec7de` (server.js +92/-4). Doc em `tarefas/concluidas/ata-fidelidade-v3.md`. Commit e push pendentes (Claude principal fará).
- **2026-05-27** — Sistema de usuários Fase 0 fechada E2E. Migração dev→Grupo Service org (consolidou prod `mtucxdfepkwsfnqpfydb` + dev `ledgyprytkuvgtbunsck`). Merge `main→dev` fast-forward + deploy dev validado (login + aba Usuários OK). PLANO_ATIVO sprint 27/05–09/06 definido.
- **2026-05-25** — Sessão de bootstrap (5 fases + final). Pasta direcional criada do zero espelhando padrão `clinicmanager-erp`. Skills MC adaptadas: frontend-design (literal), ops (Superlógica), service-hub (com padrão integracoes). 6 subagentes copiados + validator-v2 novo. 6 commits SH `aa4de04..(próximo)`; 1 PR MC #9.

---

## Referência rápida

- Sprint atual: este arquivo · plano detalhado em `PLANO_ATIVO.md`
- Visão produto: `PANORAMA_ESTRATEGICO.md`
- Stack/ENVs: `PROJECT_CONTEXT.md`
- Audit skills MC: `AUDITORIA_SKILLS_MC_PARA_SH.md`
- Próxima sessão: `.claude/CONTINUACAO.md`
