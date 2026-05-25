# Auditoria: Skills MasterClinic → Service Hub

**Data:** 2026-05-25
**Executor:** Claude Code
**Escopo:** `~/Downloads/project/.claude/skills/` — 7 skills relevantes auditadas (excluídos: 50+ recipes Google Workspace, 8 personas, 6 subagentes de workflow, família `gws-*`)

---

## Resumo

| Total | 🟢 Essenciais | 🟡 Adaptáveis | 🟠 Inspiração | 🔴 Skip |
|---|---|---|---|---|
| 7 | 2 | 2 | 2 | 1 |

## Top 3 Essenciais (trazer agora)

1. **frontend-design** — Skill oficial Anthropic (não-MC). Aplica direto em HTML vanilla. Zero rewrite. ✅ Trazida nesta sessão.
2. **ops** — Hub tem tokens Superlógica + ANTHROPIC. Runbook + regras Railway CLI são universais. ✅ Adaptada nesta sessão.
3. **produto** — Estrutura é o blueprint do PANORAMA_ESTRATEGICO. Reescrever conteúdo, manter forma. 📋 Pendente alinhamento com Matheus.

## Top 3 Adaptáveis (considerar depois)

1. **fiscal** — Arquitetura "camada de transação agnóstica + view derivada via função pura". Aplica a INSS folha, IR sobre serviços, taxa administração.
2. **integracoes** — Padrão "tabela endpoints corretos vs zumbis", armadilhas críticas, DevTools JS pattern. ✅ Incorporado à skill `service-hub` nesta sessão.
3. **ui-ux-v3** — "Paleta inviolável + regra de ouro reversa + lista de problemas sistêmicos" — só ganha valor após auditoria UX do Hub.

## Recomendação

Começar por **`produto`** (categoria 🟡 mas crítica) — sem PANORAMA decisões técnicas correm risco de estar erradas pro negócio. Em paralelo trazer `frontend-design` (zero esforço) e `ops` (segurança). Timeline: produto + frontend-design + ops na sessão de 25/05 (parcialmente concluído neste protocolo); fiscal + ui-ux-v3 entram conforme escopo evoluir.

---

## Detalhes completos

### 🟢 frontend-design

- **Origem:** Anthropic oficial (licença LICENSE.txt própria).
- **Propósito:** Criar UIs distintas, evitar "AI slop" (Inter/Roboto/cores genéricas).
- **CATEGORIA:** 🟢 ESSENCIAL
- **RAZÃO:** Skill global. Aplica a qualquer projeto frontend. Hub é HTML vanilla — frontend-design já tem instruções pra HTML/CSS/JS puro.
- **ADAPTAÇÃO:** Nenhuma. Copiar SKILL.md inteiro.
- **PRIORIDADE:** Agora. ✅ **TRAZIDA NESTA SESSÃO (Fase 3)**

### 🟢 ops

- **Origem:** MC interno.
- **Propósito:** Rotação de secrets, smoke test API, validação visual via browser.
- **CATEGORIA:** 🟢 ESSENCIAL
- **RAZÃO:** SH tem `app_token` e `access_token` do Superlógica + `ANTHROPIC_API_KEY` + `INTERNAL_API_SECRET`. Regras Railway CLI (`--set KEY=$VAR`, `history -c`) são universais.
- **ADAPTAÇÃO:** Substituir lista de secrets MC (Auth/NextAuth/API_V1/Stripe) pelos do SH. Manter estrutura "3 categorias de secret" + regras invioláveis Railway.
- **PRIORIDADE:** Agora. ✅ **ADAPTADA NESTA SESSÃO (Fase 4)** — `.claude/skills/ops/SKILL.md` + `scripts/rotate-secrets-sh.sh`

### 🟡 fiscal

- **Origem:** MC interno.
- **Propósito:** Regras NFSe, Carnê-Leão, Receita Saúde, conciliação PF/PJ.
- **CATEGORIA:** 🟡 ADAPTÁVEL
- **RAZÃO:** Conteúdo é 100% odontológico. **Arquitetura é ouro:** "camada de transação agnóstica" + "camada fiscal como view derivada" via `determinarRotaFiscal(conta, forma)`. SH tem INSS folha (zelador, porteiro), retenção IR sobre serviços (eletricista, jardineiro), taxa administração condominial.
- **ADAPTAÇÃO:** Rewrite total das regras de negócio. Manter:
  - Separação "camada origem (agnóstica)" vs "camada fiscal (derivada)"
  - Pattern `type RotaFiscal = union literal`
  - Função pura `determinarRotaFiscal(...)`
  - Tabela "Pagamento cai em | Conta | Tratamento fiscal"
- **PRIORIDADE:** Depois do MVP financeiro do Hub estar funcionando.

### 🟡 produto

- **Origem:** MC interno.
- **Propósito:** Norte estratégico. Ler antes de planejar qualquer feature.
- **CATEGORIA:** 🟡 ADAPTÁVEL
- **RAZÃO:** Conteúdo é 100% MC (clínica, Marcela, NFSe). Mas estrutura é o blueprint perfeito do PANORAMA_ESTRATEGICO.md do SH.
- **ADAPTAÇÃO:** Reescrever do zero pro contexto V8S/condomínios. Personas: síndico, gerente, administradora (V8S, Grupo Service).
- **PRIORIDADE:** Agora. 📋 PANORAMA_ESTRATEGICO.md criado como placeholder nesta sessão.

### 🟠 integracoes

- **Origem:** MC interno.
- **Propósito:** Mapa de Clinicorp/Kommo/Sheets/Anthropic/Stripe + armadilhas + auth.
- **CATEGORIA:** 🟠 INSPIRAÇÃO
- **RAZÃO:** Conteúdo MC-específico. **Padrão replicável e crítico:**
  - Tabela `Dado | Endpoint correto | Endpoint zumbi (não usar)`
  - Bloco "armadilha crítica"
  - DevTools JS pattern pra capturar token de sessão
- **ADAPTAÇÃO:** Não copiar — **incrementar** a skill `service-hub` do Matheus (que já tem mapeamento Superlógica) com esses 4 blocos estruturais.
- **PRIORIDADE:** Agora. ✅ **INCORPORADA NESTA SESSÃO (Fase 5)** — `.claude/skills/service-hub/SKILL.md`

### 🟠 ui-ux-v3

- **Origem:** MC interno.
- **Propósito:** Design system MC + 20 problemas sistêmicos da auditoria mai/26.
- **CATEGORIA:** 🟠 INSPIRAÇÃO
- **RAZÃO:** Conteúdo é 100% MC (Geist Mono, paleta MC, `<Money>` React). SH é HTML vanilla com Plus Jakarta Sans + JetBrains Mono. **O padrão é o que vale:**
  - "Paleta semântica INVIOLÁVEL" com tabela `Cor | Hex | Uso ÚNICO`
  - "Regra de ouro" no formato "se você fez X, está errado"
  - Componentes obrigatórios
  - Lista enumerada dos N problemas sistêmicos descobertos em auditoria
- **ADAPTAÇÃO:** Não copiar agora. **Disparar** quando fizer primeira auditoria UX do Hub.
- **PRIORIDADE:** Depois. Após primeira auditoria UX.

### 🔴 valyu-best-practices

- **Origem:** Valyu (terceiros).
- **Propósito:** API de search/research/AI-answer da Valyu.
- **CATEGORIA:** 🔴 SKIP
- **RAZÃO:** Domínio Valyu. SH usa Anthropic direto.
- **PRIORIDADE:** Nunca (até precisar).

---

## Bonus — Meta-padrões transversais

Olhando as 4 skills MC internas (fiscal, integracoes, ops, produto), 3 meta-padrões valeria materializar como skills genéricas reutilizáveis:

1. **"Frontmatter com triggers comportamentais"** — "Use SEMPRE que ..." + "Esta skill é/contém regras invioláveis"
2. **"Tabela inviolável + Regra de ouro reversa"** — tabela + bloco "se você fez X, está errado"
3. **"Camada agnóstica + view derivada"** — separação raw vs adapter

---

## Status de execução (sessão 2026-05-25)

| Skill | Status |
|---|---|
| frontend-design | ✅ Copiada (Fase 3) |
| ops | ✅ Adaptada (Fase 4) |
| integracoes (padrão) | ✅ Incorporada à skill service-hub (Fase 5) |
| produto | 📋 PANORAMA criado como placeholder (Fase 2); preencher com Matheus |
| fiscal | ⏳ Backlog — após MVP financeiro |
| ui-ux-v3 | ⏳ Backlog — após auditoria UX |
| valyu-best-practices | ⏭️ Skip permanente |
