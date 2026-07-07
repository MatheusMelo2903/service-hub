# Previsão Orçamentária — Modo A — Gaps A/B/C + hardening

**Status:** ✅ Concluído
**Data:** 2026-07-07

## O que foi feito

O Modo A ("planilha pronta/final") da Previsão Orçamentária já existia em
`public/previsao-modulo.html`. Nesta rodada foram corrigidos 3 gaps de parsing/cálculo
e aplicado 1 hardening de guarda, todos validados por um harness Node que roda a
função real `parsePlanilhaPronta` extraída do HTML contra 5 planilhas reais de
condomínios diferentes.

- [x] **Gap A** — regex de leitura da linha de TAXA passou a reconhecer todos os
  rótulos usados pelos condomínios: `TAXA DE CONDOMÍNIO {ano}`,
  `TAXA DE CONDOMÍNIO POR FRAÇÃO IDEAL {ano}`, `VALOR RATEADO EM {ano}` e
  `PREVISÃO ORÇAMENTÁRIA ANO {ano}`. Antes só reconhecia 3 formatos e o Reserva
  Verde (rótulo `TAXA DE CONDOMÍNIO {ano}` sem "POR FRAÇÃO IDEAL") caía em
  reajuste 0,00% falso. Guarda adicional: separa "falha de parse" (taxa base
  não encontrada → bloqueia o deck) de "taxa mantida" legítima (0% correto,
  caso Reserva dos Camarás).
- [x] **Gap B (camada 1)** — o total a ratear passou a ser ancorado na linha de
  TAXA da própria planilha, em vez de somado a partir das categorias de
  despesa. No Reserva Verde a mensal correta é R$ 138.224 (antes vinha
  R$ 188.083 por somar também o bloco de consumo, que é rateado à parte).
- [x] **Gap C** — cor do texto (`#1E2533`) corrigida na prévia da planilha do
  Modo A, que estava ilegível (texto claro em fundo claro).
- [x] **Hardening** — a Guarda 2 passou a bloquear também taxa base = 0 (evita
  `Infinity`/`NaN` no cálculo de reajuste) e linha de TAXA duplicada do mesmo
  ano com valores divergentes (evita escolher um índice em silêncio).
- [x] **Harness** — `scripts/previsao-harness/` criado (isolado, `node_modules`
  gitignored) para validar `parsePlanilhaPronta` REAL do HTML contra
  `modelos_exemplo/*.json` de 5 condomínios.

Revisor e auditor de segurança aprovaram as mudanças.

## Commits

| Commit | Descrição |
|---|---|
| `a427f10` | test(previsao): harness Node valida `parsePlanilhaPronta` contra 5 fixtures |
| `1a5d56c` | fix(previsao): Gap A reconhece todos os rótulos de linha de TAXA + guarda parse-falho vs taxa-mantida |
| `b1a6496` | fix(previsao): Gap B camada 1 ancora total a ratear na linha de TAXA |
| `ff98d67` | fix(previsao): Gap C cor do texto na prévia da planilha do Modo A |
| `7d7cb7e` | fix(previsao): hardening da Guarda 2 (taxa base zero e linha de TAXA duplicada bloqueiam em vez de gerar valor silencioso) |

## Tabela de aceitação do harness (5/5 batendo)

| Condomínio | Reajuste | Mensal a ratear | Observação |
|---|---|---|---|
| Via Mar | −7,19% | R$ 87.636,00 | — |
| Reserva Verde | +10,25% | R$ 138.224,00 | Tipo A 689,71 → 760,44; era o caso que quebrava (Gap A/B) |
| Reserva da Serra | +14,78% | R$ 111.324,00 | — |
| Reserva dos Camarás | 0% | R$ 115.726,80 | taxa mantida legítima (não é falha de parse) |
| Caminho do Mar | +11,15% | R$ 91.996,00 | — |

## Arquivos modificados

- `public/previsao-modulo.html` — Gaps A, B (camada 1), C e hardening
- `scripts/previsao-harness/` (novo) — `extrai-motor.js`, `run.js`, `shims.js`,
  `package.json`, `package-lock.json`, `node_modules` (gitignored)

## Pendências abertas (NÃO concluídas)

1. **Gap B camada 2** — decisão pendente do Matheus sobre se o consumo deve
   aparecer ou não no panorama (campo `cats`).
2. **Validação visual (validator-v2)** — pendente de deploy no dev, que
   requer autorização de push (não realizado nesta sessão de documentação).
3. **`skills-server/Previsao_Naturale_2026.xlsx`** — planilha real de cliente
   rastreada no git. Precisa de tarefa separada para remoção do histórico.

## Implementado por

subagente programador
