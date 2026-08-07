# CONTINUAÇÃO — próxima sessão Service Hub

> Atualizar ao final de cada sessão. Primeira coisa a ler ao abrir nova sessão.

---

## Última sessão: 2026-05-29 → 2026-06-01 (planejamento Previsão Orçamentária 4 fases)

### Estado do repo deixado

- Branch ativa: `dev` (sincronizada com origin/dev, sem ahead/behind)
- PR #25 aberto e em pé: `feat/prestacao-onda-2-3 → dev` (Ondas 2+3 da prestação prontas, 1977 linhas em `public/prestacao.js`)
- Untracked locais que NÃO devem entrar em commits da Previsão:
  - `.test/`, `outputs/` (testes da ata), `session-report-20260526-1722.html`
  - `skills-server/Previsao_Naturale_2026.xlsx` e `skills-server/previsao-orcamentaria/` (skill base do módulo novo, decidir se commita junto com a Fase 1)

### O que foi feito nesta sessão

1. Recebido prompt das 4 fases do módulo Previsão Orçamentária
2. Arquiteto leu 12 arquivos (briefing, SKILL.md, references, scripts Python, server.js, index.html, prestacao.js)
3. Plano técnico completo entregue cobrindo Fases 1 a 4
4. 3 achados críticos do arquiteto que mudaram premissas do briefing:
   - **Handsontable NÃO está carregado** no Hub. Briefing assumia que estava.
   - **3 listas de categorias canônicas divergentes** entre briefing, parser, gerador (pendência crítica abaixo)
   - **`gerar_previsao.py` usa `data_only=True`**, ignora fórmulas Excel; XLSX precisa ter valores fixos
5. Matheus respondeu 7 das 8 perguntas decisórias

### Decisões fechadas

| # | Tema | Decisão |
|---|---|---|
| A | Local microserviço | Monorepo: `services/previsao-api/` |
| B | Roteamento browser→FastAPI | Proxy via `server.js` em `/api/previsao/*` |
| C | Auth microserviço | Shared secret `INTERNAL_API_SECRET` em header `X-Internal-Secret` |
| D | Grade editável | HTML vanilla com `contenteditable` (sem Handsontable) |
| E | Entrada gerar-pdf (Fase 4) | XLSX binário (não JSON) |
| F | Entregáveis Fase 4 | PPTX + PDF, PDF em destaque |
| 5 | PPTX + PDF | Os dois disponíveis no painel interno |
| 6 | Fórmulas vs valores fixos | Valores fixos + recalculo JS no front |
| 7 | RLS tabela `previsoes_orcamentarias` | Obrigatória, mesmo padrão das outras |
| 8 | Timeout extração | 120s |
| — | Railway tier | LibreOffice só na Fase 4, decisão de tier adiada |

### PENDÊNCIA ÚNICA antes de codar Fase 1

**Lista de categorias canônicas (8 vs 9 vs nova).** Pergunta foi feita mas Matheus interrompeu antes de responder.

| Parser (9, alinhado ao briefing) | Gerador (8, o que sai no PDF hoje) |
|---|---|
| Despesas Financeiras | Despesas Financeiras |
| Despesa com Funcionários | Despesa com Funcionários |
| Retenções Fiscais (ISS, INSS, IRRF) | — |
| Despesa Administrativa | Despesa Administrativa |
| — | Consumo e Taxas (água, luz, gás) |
| Manutenção | Manutenção |
| Aquisição de Materiais | Aquisição de Materiais |
| Serviços | Serviços |
| Investimento e Equipamentos | Equipamentos |
| Taxas e Recolhimentos (IPTU, alvará) | — |

Conflito semântico real: parser separa "Retenções Fiscais" e "Taxas e Recolhimentos"; gerador junta tudo em "Consumo e Taxas" (que é outra coisa: utilities). Decisão impacta:
- Qual versão dos scripts copiar para o microserviço
- Se precisa atualizar `gerar_previsao.py` na Fase 4
- Se PDFs já entregues (Naturale 2026) ficam fora do padrão novo

### Próxima sessão deve

1. **Receber decisão de categorias** do Matheus (única pendência)
2. **Iniciar Fase 1** com o subagente implementador:
   - Criar `services/previsao-api/` (main.py, parser_superlogica.py adaptado, gerar_previsao.py adaptado, requirements.txt, Procfile, railway.toml, .python-version)
   - Adicionar proxy `/api/previsao/extrair-pdfs` no `server.js`
   - **NÃO incluir LibreOffice** nos requirements/Dockerfile da Fase 1 (vai pra Fase 4)
   - Branch: `feat/previsao-fase1-fastapi` a partir de `origin/dev`
3. **Critério de aceite Fase 1**: enviar PDFs do Naturale via curl, receber JSON estruturado + XLSX em base64 idêntico ao parser rodado localmente, em menos de 30s
4. **Rodar subagentes revisor + auditor em paralelo** antes do PR (CLAUDE.md fluxo)
5. **Abrir PR `feat/previsao-fase1-fastapi → dev`**

### Estimativa restante (pomodoros 25min)

| Fase | Esforço |
|---|---|
| Fase 1 — FastAPI + extrair-pdfs | 14 |
| Fase 2 — Frontend + grade vanilla | 20 |
| Fase 3 — Rascunhos Supabase + hash | 11 |
| Fase 4 — LibreOffice + gerar-pdf | 19 |
| Total restante | 64 (~27h) |

### Bloqueadores conhecidos

- Aguardando decisão de Matheus na pendência única (categorias)
- LibreOffice no Railway vai exigir tier Hobby (USD 5/mês) na Fase 4 ou serviço dedicado

### Armadilhas registradas pelo arquiteto (NÃO esquecer)

1. **Categoria "Outros"** do parser é descartada silenciosamente em `gerar_planilha`. Microserviço deve retornar aviso se vier não vazia.
2. **Fundo de reserva**: parser inclui no "Total a Ratear" da aba Resumo Assembleia, mas gerador exclui do rateio. Não "corrigir" sem autorização.
3. **Cold start FastAPI** sem LibreOffice: 8-15s. Com Railway free + sleep, primeiro request do dia cai.
4. **Calibri não existe no Linux** (Fase 4). Dockerfile precisa de `ttf-mscorefonts-installer`.
5. **`HOME` env var** obrigatória no container do LibreOffice ou ele falha silencioso.
6. **Versionamento**: scripts em `skills-server/` ficam intocados (CLI de referência). Microserviço usa cópias adaptadas. Se a skill mudar, alguém precisa sincronizar manualmente.
