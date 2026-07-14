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
4. **Sem cifra em log** (`montar`, fim da função): o vendor tinha uma linha de
   diagnóstico `print(f"... superavit={SUPERAVIT:.2f} saldofim={SALDO_FIM:.2f}")`
   que imprimia valor financeiro real do condomínio em stdout a cada geração.
   Era divergência local do vendor, não herdada da skill. Removida (regra de
   privacidade 2026-07-09). A skill upstream foi conferida em 2026-07-13 e não
   tem esse print nem qualquer outro caminho de cifra em stdout, então não há
   nada a sincronizar de volta.

## Gate de qualidade

`auditar_apresentacao.py` roda no PPTX **antes** de qualquer conversão a PDF.
Só converter com "AUDITORIA OK".

## Fixtures de teste (PDF de cliente real, FORA do repo)

Os PDFs de prestação são dado financeiro de cliente real e **nunca** entram no
repositório. Motivo: uma pasta gitignored dentro do repo é um convite a alguém
commitar dado de cliente por engano um dia. Uma variável de ambiente apontando
para fora do repo não tem esse caminho.

Há dois mecanismos de fixture, cada um para um conjunto de testes:

1. `tests/fixtures_local/` (pasta gitignored dentro do repo). O grosso dos testes
   de parser varre essa pasta por tipo de PDF (`w011a*.pdf`, `w015a*.pdf`,
   `w015p*.pdf`) e dá `skip` quando a pasta ou o arquivo não está lá. Os números
   de referência de PDF real também moram aqui, em JSON: `w011a_referencia.json`
   (Frente 1, Praia Dourada, Buritis) e `w015p_referencia.json`. Nenhuma cifra
   real vive no código dos testes; ela é lida desses JSONs.

2. `PRESTACAO_FIXTURES_DIR` (pasta fora do repo). Só os três testes da Frente 1
   (`saldo_anterior` do W011A) leem PDF por aqui, por nome fixo: `gardenia-w011a.pdf`
   e `buritis-w011a.pdf`. Sem a variável ou sem o arquivo, `skip`.

Rodar a suite com os dois mecanismos ativos (exemplo):

```
PRESTACAO_FIXTURES_DIR=~/Downloads/GATE-PRESTACAO-GARDENIA \
  PYTHONPATH=. python3 -m pytest tests/ -q
```

`tests/fixtures_local/` está no `.gitignore` (`.gitignore:47`): nem PDF nem JSON
de referência entram no repo. PDF de prestação é dado de cliente real e nunca
entra no repositório, nem em `fixtures_local/` nem no código.
