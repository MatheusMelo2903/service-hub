---
name: tracker-updater
description: Atualiza status de tarefas do tracker do Service Hub (Fase 0-4, 25 tarefas) diretamente na tabela hub_progresso do Supabase prod.
---

# Tracker Updater

Skill pra marcar tarefas como `pendente`, `em_andamento` ou `concluido` na tabela `public.hub_progresso` do Supabase prod (`mtucxdfepkwsfnqpfydb`), que alimenta o PWA do tracker em `public/tracker.html` (servido em `/tracker.html` no domínio do Hub).

## Quando usar

- Mateus pede pra marcar uma tarefa como concluída/iniciada.
- Mateus muda de fase ou termina um bloco de entrega.
- Code conclui uma feature que está mapeada como tarefa no tracker.

## Como usar

1. **Identificar o ID da tarefa** consultando a tabela abaixo.
2. **Executar UPDATE** via MCP Supabase ou Studio:

```sql
UPDATE public.hub_progresso
SET status = '<novo_status>',          -- 'pendente' | 'em_andamento' | 'concluido'
    atualizado_por = '<quem>',          -- 'Claude Code' | 'Mateus' | 'Matheus de Melo'
    atualizado_em = NOW()
WHERE id = '<id_tarefa>';
```

3. **Confirmar no PWA** abrindo `https://service-hub-production.up.railway.app/tracker.html` — atualiza em tempo real via Supabase Realtime (se ligado) ou no próximo refresh.

## Estrutura dos IDs

Padrão `f<fase>t<numero>`. 5 fases × 5 tarefas (Fase 0 tem 10).

### Fase 0 — Fundação técnica (BLINDAGEM já entregue)
| ID | Tarefa | Responsável |
|---|---|---|
| `f0t1` | RLS ligado + policies (banco protegido) | Mateus |
| `f0t2` | ES256/JWKS — IA destravada em prod | Mateus |
| `f0t3` | Login obrigatório (Supabase Auth) | Mateus |
| `f0t4` | Proxies /api fechados (Bearer JWT) | Mateus |
| `f0t5` | Dev separado de prod (Railway + Supabase) | Mateus |
| `f0t6` | Feature 1 — Edital autopreenche reunião | Mateus |
| `f0t7` | Feature 2 — Gerar ata in-Hub (Arial, padrão Ata 1) | Mateus |
| `f0t8` | Feature 3 — Normalizador 26 colunas (PDF + xlsx) | Mateus |
| `f0t9` | Sistema de usuários GESTOR/GERENTE/OPERACIONAL | Mateus |
| `f0t10` | Mascarar Claude → Service Hub IA na UI | Mateus |

### Fase 1 — Inadimplência + conciliação (próxima)
| ID | Tarefa | Responsável |
|---|---|---|
| `f1t1` | Seletor de condomínio com ID (bloqueador) | Mateus |
| `f1t2` | Painel inadimplência + IA (Buritis R$127k) | Mateus |
| `f1t3` | Conciliação bancária automática | Mateus |
| `f1t4` | Gerador de acordos com IA | Mateus |
| `f1t5` | PANORAMA_ESTRATEGICO alinhado (produto + visão) | Ambos |

### Fase 2 — Prestação + previsão
| ID | Tarefa | Responsável |
|---|---|---|
| `f2t1` | Prestação de contas automática (PDF nível agência) | Mateus |
| `f2t2` | Previsão orçamentária automática | Mateus |
| `f2t3` | Multiusuário sem conflito (colisão de edição) | Mateus |
| `f2t4` | Tabela de percentuais por rubrica | Matheus de Melo |
| `f2t5` | Marco da virada — sistema atual aposentado (~mês 8) | Ambos |

### Fase 3 — Multi-tenant + portal
| ID | Tarefa | Responsável |
|---|---|---|
| `f3t1` | Isolamento por empresa (multi-tenant) | Mateus |
| `f3t2` | Permissão granular por módulo (Entrega 2) | Mateus |
| `f3t3` | Portal do condômino (2ª via boleto, chamado) | Mateus |
| `f3t4` | Agentes autônomos + score inadimplência (IA) | Mateus |
| `f3t5` | Fechar 2 a 3 clientes pagantes | Matheus de Melo |

### Fase 4 — Venda + due diligence
| ID | Tarefa | Responsável |
|---|---|---|
| `f4t1` | Onboarding self-service (cliente entra sem ajuda) | Mateus |
| `f4t2` | MRR, churn, CAC — métricas de venda prontas | Ambos |
| `f4t3` | Documentar código para due diligence | Mateus |
| `f4t4` | Material de venda + case Grupo Service | Matheus de Melo |
| `f4t5` | Vender a solução | Ambos |

## Seed automático

Ao abrir o tracker (`public/tracker.html`), a função `seed()` insere QUALQUER ID da tabela acima que ainda não exista em `hub_progresso` com status `pendente`. Pra resetar o tracker, basta `DELETE FROM hub_progresso WHERE id LIKE 'f%t%'` e abrir o PWA — todas as tarefas voltam a aparecer como pendentes.

## Acesso à tabela

- **MCP Supabase prod** (`mtucxdfepkwsfnqpfydb`): só Matheus tem (org `matheusmelo2903`). Meu MCP (mateusmcunha) acessa só dev (`ledgyprytkuvgtbunsck`).
- **Studio**: https://supabase.com/dashboard/project/mtucxdfepkwsfnqpfydb/sql
- **REST anon**: bloqueado por RLS (após Entrega 1.2 — quando hub_progresso receber RLS authenticated_full_access).

Por enquanto a tabela está com `acesso_publico` (sem RLS) — é dívida técnica da Entrega 1.1.

## Status válidos

| Status | Cor no PWA | Significado |
|---|---|---|
| `pendente` | cinza | Ainda não começou |
| `em_andamento` | azul/âmbar | Trabalho ativo |
| `concluido` | verde | Entregue |

## Campos obrigatórios

A tabela `hub_progresso` tem: `id`, `fase`, `etapa`, `titulo`, `responsavel`, `status`, `atualizado_por`, `atualizado_em`.

O seed do PWA preenche `fase`, `etapa`, `titulo`, `responsavel` automaticamente. Pra UPDATE manual, só `status` + `atualizado_por` + `atualizado_em` são necessários.

## Exemplo: marcar várias tarefas concluídas de uma vez

```sql
UPDATE public.hub_progresso
SET status = 'concluido',
    atualizado_por = 'Claude Code',
    atualizado_em = NOW()
WHERE id IN ('f0t1','f0t2','f0t3','f0t4','f0t5','f0t6','f0t7','f0t8','f0t10');
```

## Exemplo: resetar e re-seedar uma fase inteira

```sql
DELETE FROM public.hub_progresso WHERE id LIKE 'f0t%';
-- Depois abrir o PWA: as 10 tarefas da Fase 0 voltam como pendentes
```
