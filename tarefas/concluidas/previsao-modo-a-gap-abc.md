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
- [x] **Gap B (camada 2)** — o consumo passou a ser excluído do panorama de
  categorias (`cats`) por comparação determinística de VALOR, não por nome de
  condomínio ou rótulo: localiza os dois totais candidatos ("TOTAL GERAL
  DESPESAS ORDINÁRIAS" = A, "...ORDINÁRIAS E CONSUMO A RATEAR" = B) e decide
  comparando a taxa declarada com A e B — taxa ≈ A (só ordinárias) exclui o
  bloco de consumo do panorama (caso Reserva Verde); taxa ≈ B (combinado) ou
  nenhum dos dois mantém o comportamento anterior (caso Reserva da Serra). Só
  age quando A e B existem e são diferentes entre si. Também exclui sempre a
  linha "Estimativa Boleto C/Variáveis (Média)" do panorama (não é categoria)
  e tira o prefixo "CONTRATOS:" do nome da categoria. Mexe só na lista de
  categorias exibida, sem tocar nos números de headlinePct/mensal/totalBase
  já corrigidos na camada 1.
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
| `943e342` | fix(previsao): Gap B camada 2 exclui consumo do panorama quando taxa é só ordinárias (regra por valor) + remove linha de estimativa de boleto |

## Tabela de aceitação do harness (5/5 batendo, inclusive `cats`)

| Condomínio | Reajuste | Mensal a ratear | `cats` | Observação |
|---|---|---|---|---|
| Via Mar | −7,19% | R$ 87.636,00 | ok | — |
| Reserva Verde | +10,25% | R$ 138.224,00 | ok | Tipo A 689,71 → 760,44; era o caso que quebrava (Gap A/B) e o único que ainda falhava em `cats` antes da camada 2 (consumo excluído do panorama) |
| Reserva da Serra | +14,78% | R$ 111.324,00 | ok | taxa combinada (ordinárias + consumo) mantém o consumo no panorama |
| Reserva dos Camarás | 0% | R$ 115.726,80 | ok | taxa mantida legítima (não é falha de parse) |
| Caminho do Mar | +11,15% | R$ 91.996,00 | ok | — |

## Arquivos modificados

- `public/previsao-modulo.html` — Gaps A, B (camadas 1 e 2), C e hardening
- `scripts/previsao-harness/` (novo) — `extrai-motor.js`, `run.js`, `shims.js`,
  `package.json`, `package-lock.json`, `node_modules` (gitignored)

## Pendências abertas (NÃO concluídas)

1. **Validação visual (validator-v2)** — pendente de deploy no dev, que
   requer autorização de push (não realizado nesta sessão de documentação).
2. **`skills-server/Previsao_Naturale_2026.xlsx`** — planilha real de cliente
   rastreada no git. Precisa de tarefa separada para remoção do histórico.

## Implementado por

subagente programador
