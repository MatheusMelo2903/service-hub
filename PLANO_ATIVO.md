# PLANO_ATIVO — Service Hub

**Sprint:** 27/05 a 09/06/2026 (14 dias)
**Tech lead:** Mateus · **Produto:** Matheus
**Status:** Ativo · gerado com base no alinhamento de 27/05

---

## Decisões fechadas neste alinhamento

| Decisão | Resposta |
|---------|----------|
| Fase 1 — atacar primeiro | Tarefa 1.1 — Seletor de condomínio (4h, bloqueador) |
| Fase 2 — documento premium | Tarefa 2.1 — Prestação de contas (PDF nível agência) |
| Tabela de % reajuste | Não existe ainda — Matheus levanta esta semana |
| Marco da virada (~mês 8) | Depende do ritmo — reavaliar ao fim da Fase 1 |
| Teto de custo mensal IA | Sem limite definido — reavaliar quando Fase 3 aproximar |
| Balancete digital | Ambos: consolidado dos 87 + seletor individual |
| Quem constrói a base nova | Mateus sozinho |

---

## Semana 1 (27/05 a 02/06) — Desbloquear a Fase 1

### 🔴 Tarefa 1.1 — Seletor de condomínio com ID
**Responsável:** Mateus | **Esforço:** 4h | **Dependência:** nenhuma

O seletor substitui a digitação manual do identificador. É o bloqueador de 1.4 e 1.5.

- Dropdown com nome + ID dos condomínios
- Grava a escolha na sessão
- Importação de unidades funciona a partir do seletor
- Testar com condomínio 167 (critério de aceite)

**Critério de pronto:** seletor lista, grava e a importação funciona a partir dele.

---

### 🟡 Tarefa 1.2 — Higiene de deploy (já parcialmente feita)
**Responsável:** Mateus | **Esforço:** 1h | **Dependência:** nenhuma

Verificar se o hook de secrets (2B) está funcionando em commits reais.
Se não estiver, corrigir o CLAUDE_TOOL_INPUT antes de prosseguir.

---

### 🟡 Matheus — Levantar tabela de percentuais por rubrica
**Responsável:** Matheus | **Prazo:** até 02/06

Sem isso a Tarefa 2.2 (previsão orçamentária) não pode começar.
Formato esperado: rubrica + % de reajuste + fonte (dissídio, IPCA, etc).

---

### 🟡 Convidar User 2 do Grupo Service
**Responsável:** Matheus | **Prazo:** antes de segunda (02/06)

- Definir quem é o User 2
- Definir role (GERENTE ou OPERACIONAL)
- Definir permissões por módulo
- Matheus convida via Hub prod → Configurações → Gestão de Usuários

---

## Semana 2 (03/06 a 09/06) — Primeira entrega de negócio

### 🔴 Tarefa 1.4 — Painel de inadimplência + IA
**Responsável:** Mateus | **Esforço:** 22–31h | **Dependência:** 1.1

O primeiro entregável que gera retorno financeiro real.

- Default: consolidado dos 87 condomínios (ranking por inadimplência)
- Seletor opcional: detalhe individual de um condomínio
- IA analisa atraso + histórico → ação recomendada + probabilidade de recuperação
- Validar contra Buritis: 54 unidades, R$127.818,80
- Sonnet 4.6 via proxy (não Haiku — qualidade é o critério)

**Critério de pronto:** painel mostra Buritis no topo com R$127k e ação recomendada pela IA.

---

### 🟡 Tarefa 1.5 — Conciliação bancária automática (início)
**Responsável:** Mateus | **Esforço:** 25h | **Dependência:** nenhuma (paralelo com 1.4)

Pode rodar em paralelo com 1.4 se sobrar tempo na semana 2.
- Upload do arquivo do banco
- Cruzamento por valor e data contra as cobranças
- Painel de conformes, divergências e não localizados

---

## Entrega 1.1 — Pendências de segurança (quando houver tempo)

Não bloqueiam segunda, mas precisam ser feitas antes de mais usuários entrarem:

- [ ] RLS no hub_progresso (tracker ainda é anônimo)
- [ ] Leaked password protection (Studio → Auth → Policies)
- [ ] OTP expiry < 1h (Studio → Auth → Email)
- [ ] Deletar user temp `mateus-teste@servicehub.local`

---

## Fases futuras — não tocar agora

| Fase | O que é | Quando |
|------|---------|--------|
| 2.1 | Prestação de contas (PDF nível agência) | Mês 3–4 |
| 2.2 | Previsão orçamentária | Após tabela de % do Matheus |
| 2.4 | Base nova (login + multiusuário) | Mês 4–5 |
| 3.1 | Multi-tenant | Mês 8+ |
| 3.2 | Permissão granular por módulo | Entrega 2 (após Fase 1) |

---

## Regras de trabalho (do handoff Matheus)

- main é produção protegida — branch → PR → Mateus aprova → merge
- Push via terminal, nunca GitHub web
- Edições GitHub web só pelo Safari
- Tokens nunca hardcoded
- Verificar secrets antes de cada commit
- Manter index.html abaixo de 7000 linhas (~6800 agora)
- Nenhuma lib nova sem aprovação
- Datas DD/MM/AAAA, valores em R$
- Supabase: sempre `sb_secret_` (New API Keys — eyJ legacy não funciona)

---

## Checklist de fechamento do sprint (09/06)

- [ ] Tarefa 1.1 concluída e testada em prod
- [ ] Tarefa 1.4 entregue (painel Buritis funcionando)
- [ ] Tabela de % do Matheus entregue
- [ ] User 2 convidado e configurado
- [ ] MISSION_CONTROL.md atualizado
- [ ] Tracker atualizado (f0t9 concluído, f1t1 concluído, f1t2 em andamento ou concluído)
