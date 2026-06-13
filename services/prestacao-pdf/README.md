# prestacao-pdf — Microserviço de Prestação de Contas (PPTX + PDF)

Gera o deck de prestação de contas consumindo a skill
`powerpoint-prestacao-contas` (template data-driven + auditor visual),
nos moldes do `services/previsao-pdf` (Fase 4 da Previsão).

## Estado

- **Fase 1 (atual):** vendor da skill + extensão de orquestração de blocos
  validada contra a fonte da verdade (deck Naturale, 2 blocos, 32 slides).
- Fases 2 a 5 (parser W016A, orquestração, integração Hub, base comum):
  ver `_handoff/PROMPT_prestacao_paridade_ponta_a_ponta.md`.

## Vendor (`vendor/powerpoint-prestacao-contas/`)

Cópia da skill upstream (fonte: skill de usuário do Matheus no Claude.ai,
sincronizada via `_handoff/skill/` em 2026-06-09). **Tratar como upstream:**
sincronizar a partir da skill, nunca deixar divergir silenciosamente.

Mudanças locais sobre o upstream (candidatas a contribuição de volta):

1. **Orquestração de blocos** (`template_prestacao.py`): derivados e montagem
   viraram `aplicar_config(cfg)` + `montar(configs, saida, capa=None)` para
   suportar N CONFIGs (um por sub-período) num único deck — capa única e, por
   bloco, divisor + sequência completa com numeração reiniciada. Comportamento
   de CONFIG único preservado via `__main__`. As funções de slide permanecem
   idênticas ao upstream.
2. **Validação de lançamentos**: `aplicar_config` confere
   `soma(lancamentos[categoria]) == total da categoria` (o upstream só validava
   caixa, receitas e despesas). Pegou inconsistência real de R$ 0,40 na fonte
   da verdade do Naturale.
3. **Piso de linha da tabela de lançamentos**: 0.26" → 0.17". Com mais de 14
   lançamentos a tabela estourava o slide (auditoria reprovava). A fonte de
   8pt para 17+ itens já existia no upstream.

## Gate de qualidade

`auditar_apresentacao.py` roda no PPTX **antes** de qualquer conversão a PDF.
Só converter com "AUDITORIA OK".
