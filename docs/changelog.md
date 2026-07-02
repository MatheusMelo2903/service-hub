# Changelog — Service Hub

---

## [2026-06-24] — Prestação Entrega 1: contraste projeção + ícone mono + seletor de formato

- Contraste da tabela de lançamentos no slide de detalhamento melhorado para projeção em parede: 3 tokens novos (`C_ROW_BAND`, `C_ROW_ALT`, `C_INK`) com bandas azuis em todas as linhas e texto escurecido. Demais slides intactos. 28/28 testes seguem passando.
- Ícone da aba Prestação de Contas trocado de 📊 (emoji colorido) para ▤ (monocromático), alinhando com o padrão visual das demais abas.
- Seletor de formato de saída adicionado à interface: radio group com opções Ambos / Somente PDF / Somente PowerPoint (default Ambos). `prestacaoGerarServico` lê o radio e baixa apenas o formato escolhido (`querPdf`/`querPptx`). Backend inalterado.
- Arquivo `tarefas/em-andamento/prestacao-botao-refinar-ia.md` criado registrando a Entrega 2 (botão Refinar prestação com IA), pendente de plano do arquiteto.

**Status:** Deployado no dev (prestacao-pdf `ed3fea8b` SUCCESS + service-hub `15df9825` SUCCESS). Aguarda teste de legibilidade na parede pelo Matheus antes de subir para produção.

**Arquivos modificados:** `public/index.html`, `public/prestacao.js`, `services/prestacao-pdf/vendor/powerpoint-prestacao-contas/scripts/template_prestacao.py`

**Arquivo criado:** `tarefas/em-andamento/prestacao-botao-refinar-ia.md`

**Commit:** `6b2d888` — branch `dev`

**Implementado por:** subagente programador (Claude Opus 4.8)

**Pendência registrada (achado do auditor, não bloqueante):** remover `console.log` com dados financeiros em `public/prestacao.js` (~linha 2100, função `prestacaoGerarClientSide`) antes de ir para produção com dados reais.

---

## [2026-06-23] — Prestação multi-fonte W011A/W015A/W016A + série mensal real

- Adicionado detector de tipo de PDF por conteúdo (`detector.py`): identifica cada arquivo como W011A, W015A ou W016A sem depender do nome do arquivo.
- Implementado `parser_w011a.py` (matriz mensal de receitas e despesas por categoria) e `parser_w015a.py` (consolidado comparativo do período), com reagrupamento de números quebrados e preservação de receita negativa como redutor.
- `pipeline.py` ganhou `montar_config_multi_fonte` e `orquestrar_multi_fonte`: reconciliação entre fontes (aviso em divergência >= 1%, bloqueio >= 5%), degradação elegante (1, 2 ou 3 arquivos), série mensal real de Evolução de despesas e Superávit mensal derivados exclusivamente do W011A.
- Frontend (`public/prestacao.js`, `public/index.html`) atualizado para envio multi-arquivo, aviso opcional na dropzone do W011A/W015A, e exibição dos campos `fontes_detectadas`, `serie_mensal_ativa` e `avisos_reconciliacao` retornados pelo microserviço.
- 28/28 testes sintéticos passando (`tests/test_multi_fonte.py`). Dados reais de condomínio não entram no git (fixtures locais gitignored).
- Correção de rota descoberta nos PDFs reais: W011A é matriz mensal de receitas E despesas (não despesa-only); W015A é consolidado comparativo (não extrato bancário); W016A é conferência opcional (não obrigatório); Superávit mensal calculado do W011A.

**Arquivos modificados:** `public/index.html`, `public/prestacao.js`, `services/prestacao-pdf/app/main.py`, `services/prestacao-pdf/app/pipeline.py`, `.gitignore`

**Arquivos criados:** `services/prestacao-pdf/app/detector.py`, `services/prestacao-pdf/app/parser_w011a.py`, `services/prestacao-pdf/app/parser_w015a.py`, `services/prestacao-pdf/tests/test_multi_fonte.py`

**Commit:** `69ec74b` — branch `dev`

**Implementado por:** subagente programador (Claude Opus 4.8)

**Follow-ups conhecidos (registrados, não implementar agora):**
- Deduplicar helpers `_e_caixa_alta`, `_nome_para_config`, `_rotulos_periodo` duplicados entre módulos (fazer antes da próxima feature que toque esses arquivos).
- Remover `console.log` de dados financeiros no fallback offline (`public/prestacao.js`).
- Bug 422 do parser W016A já registrado em tarefa separada (`prestacao-parser-422-debug.md`).

---

## [2026-06-23] — Prestação prosa rica (Bloco A + download PDF/PPTX)

- Engine de prestação passou a gerar prosa rica determinística com 3 moldes de texto para o Bloco A (introdução, análise financeira e conclusão).
- Download de PDF e PPTX robustecido, com fallback e tratamento de erro no frontend.
- Padrão W016A consolidado como fonte de verdade dos totais auditados.

**Commit:** `ad2439c` — branch `dev`

**Implementado por:** subagente programador

---

## [2026-05-28] — Ata fidelidade v3

- Adicionadas regras de fidelidade (FID 1 a 5) no system prompt do gerador de atas.
- Segundo passe de auditoria (Sonnet 4.6, max_tokens 16k) integrado à rota `/api/atas/gerar`.
- Teste real Happy Days: 3/4 critérios passaram. Critério 2 "Wellington (Eriton)" ficou no backlog.

**Commit:** `8cec7de` — branch `feat/ata-fidelidade-v3`

**Implementado por:** subagente programador
