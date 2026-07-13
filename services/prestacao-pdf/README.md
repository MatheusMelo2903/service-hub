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
4. **Remoção de cifra em log** (`montar`, fim da função): a linha de diagnóstico
   `print(f"... superavit={SUPERAVIT:.2f} saldofim={SALDO_FIM:.2f}")` imprimia
   valor financeiro real do condomínio em stdout a cada geração bem-sucedida.
   Removida (regra de privacidade 2026-07-09: cifra só na resposta, nunca em
   log). **Sincronizar de volta na skill upstream do Matheus.**

## Gate de qualidade

`auditar_apresentacao.py` roda no PPTX **antes** de qualquer conversão a PDF.
Só converter com "AUDITORIA OK".

## Fixtures de teste (PDF de cliente real, FORA do repo)

Os PDFs de prestação são dado financeiro de cliente real e **nunca** entram no
repositório. Motivo: uma pasta gitignored dentro do repo é um convite a alguém
commitar dado de cliente por engano um dia. Uma variável de ambiente apontando
para fora do repo não tem esse caminho.

Convenção dos testes de parser que leem PDF real:

- O teste lê a pasta de fixtures da variável `PRESTACAO_FIXTURES_DIR`. Se ela não
  existir (ou o arquivo não estiver lá), o teste é `skip`, como o resto do harness.
- Nomes de arquivo esperados nessa pasta:

  | Arquivo | Uso |
  |---|---|
  | `gardenia-w011a.pdf` | W011A com meses zerados no início do exercício (regressão do saldo_anterior) |
  | `gardenia-w015a.pdf` | W015A com janela deslocada (mês corrente arrastado) |
  | `gardenia-w016a.pdf` | W016A do mesmo período, conferência |
  | `buritis-w011a.pdf` | W011A sem meses zerados, saldo de abertura não nulo |

Rodar o harness apontando para a pasta local (exemplo):

```
PRESTACAO_FIXTURES_DIR=~/Downloads/GATE-PRESTACAO-GARDENIA \
  python3 -m pytest tests/test_multi_fonte.py -q
```

`tests/fixtures_local/` continua no `.gitignore` (`.gitignore:47`) mesmo não sendo
mais usado pela convenção nova, como defesa em profundidade.
