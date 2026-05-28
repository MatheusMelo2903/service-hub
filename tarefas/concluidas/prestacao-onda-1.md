# TAREFA: prestação de contas onda 1

## O que eu quero
Corrigir o gerador JS de prestação de contas do Hub para igualar a skill de referência (skills-server/powerpoint-prestacao-contas/) na primeira camada de qualidade: UTF-8 nos textos, nomes curados a partir do CAPS bruto do Superlógica, agrupamento de subcategorias em 9 grupos canônicos (resolvendo o bug dos 49 slides), descrições curatoriais por grupo.

## Por que eu quero
O Hub gerava 49 slides com texto sem acento e descrições genéricas tipo "Maior categoria do exercício". A skill de referência produz 17 slides curados. As 3 ondas (1, 2, 3) levam o Hub para o mesmo padrão. A Onda 1 sana o que torna o deck inaceitável; Ondas 2 e 3 ficam em PRs separados.

## Critério de aceite
- [x] index.html abaixo do teto do CLAUDE.md
- [x] 9 grupos canônicos na ordem PRESTACAO_GRUPOS_ORDEM
- [x] 17 slides no deck de teste mockado
- [x] Zero textos com CAPS sem acento (VISAO, EVOLUCAO, etc)
- [x] Zero CAPS bruto do Superlógica como nome de slide
- [x] Descrições curatoriais por grupo (substitui "Maior categoria do exercício")
- [x] Subagentes obrigatórios acionados antes do push

## Arquivos mexidos
- public/index.html (refactor preparatório): bloco JS de prestação (1713 linhas) extraído. De 7228 para 5518 linhas. Carregamento via tag script src antes do body
- public/prestacao.js (novo, ~1955 linhas após Onda 1 + polimento): gerador completo
- skills-server/powerpoint-prestacao-contas/ (versionado): SKILL.md, references/, scripts/template_prestacao.py, assets/
- outputs/test-prestacao-mock.js (novo): teste mock com 6 critérios

## Restrições respeitadas
- Sem hífen ou travessão em texto visível ao usuário (a regra do projeto)
- index.html caiu para 5518 linhas (abaixo do teto histórico de 7000)
- Sem push direto em main
- Commits semânticos
- Skill de referência versionada como solicitado

## Fluxo executado
Os 5 subagentes obrigatórios foram acionados antes do push:

### arquiteto (claude-sonnet-4-6)
APROVADO arquiteturalmente. 3 sugestões aplicadas no commit ebffe89:
1. console.warn no fallback de prestacaoGetGrupo (telemetria de cobertura do dicionário)
2. Remoção da função morta prestacaoSlideDetalhamentoCategoria (99 linhas órfãs)
3. Dedup dos comentários de prestacaoConsolidar*

### revisor
APROVADO. Dívida de acentos herdada aplicada no commit ebffe89: Deficit, Media Receita/Despesa/Economia, Retracao, Inicio, Mes. 5 outras observações registradas como dívida para Ondas 2 e 3.

### auditor segurança
APROVADO. 1 vulnerabilidade baixa não bloqueante: console.log em prestacaoGerar pode vazar JSON da prestação no DevTools. Pendência para multi tenant futuro.

### validador
APROVADO. node --check OK em public/prestacao.js, server.js, public/auth-bootstrap.js e JS extraído de index.html. Teste mock 6/6.

### documentador
Este arquivo. MISSION_CONTROL e PLANO_ATIVO a atualizar.

## Teste de regressão
outputs/test-prestacao-mock.js carrega public/prestacao.js em node via indirect eval com stubs de PptxGenJS, document, window, supaFetch, apiAuthFetch, toast. Roda prestacaoMontarPptx contra dados realísticos (template_prestacao.py exercício 2025: 19 subcategorias detalhadas distribuídas pelos 9 grupos canônicos).

Veredicto: 6/6 critérios passaram
- 9 grupos consolidados na ordem canônica
- 17 slides gerados (1 capa + 6 analíticos + 9 detalhamentos + 1 encerramento)
- Zero CAPS sem acento
- Zero CAPS bruto Superlógica como nome
- 3 descrições curatoriais presentes
- Zero descrições genéricas

## Pendências registradas para Ondas 2 e 3
1. Cap de 9 grupos canônicos em prestacaoAgruparDespesas: hoje grupos extras (subcategoria não mapeada) viram bucket próprio. A Onda 2 pode introduzir "Outras despesas" como bucket agregado quando passa do 10º grupo
2. Descrições por grupo contextualizadas com valor e percentual do exercício (PRESTACAO_DESCRICOES_GRUPO hoje é texto fixo por grupo, não específico por exercício)
3. Estrutura mista de detalhamento conforme estrutura-slides.md linhas 86 a 88:
   - Pessoal: mês a mês (12 linhas, mostra estabilidade do contrato)
   - Consumo/Materiais/Serviços/Manutenção/Administrativo: subcategoria anual (atual)
   - Taxas/Financeiras/Retenções: mês a mês filtrando zeros
4. Cores do slide Estrutura de Despesas fixas por categoria, não indexadas por ranking de valor
5. console.log do JSON da prestação silenciado por flag dev (segurança multi tenant futuro)
6. Onda 2 (visual premium): faixa laranja com 3 pilares na Visão Geral, mini gráfico de barras brancas nos cards de detalhamento, tira ANTES x DEPOIS no encerramento, linha simples sem marcadores nos gráficos LINE, faixa âmbar de insight no Origem da Receita
7. Onda 3 (polimento): sublabels dos KPIs da Visão Geral, subtítulo do Patrimônio e Encerramento, "MESES POSITIVOS X de 12" em vez de "X / 12", "Apresentação em Assembleia" em vez de "Apresentado em" data, alertas de pico reduzidos

## Limitações atuais
- Validação visual real do .pptx gerado depende do navegador (PptxGenJS é browser only) — o teste mock só conta slides e textos, não renderiza
- Lara Hoffman segue pendente (também não havia transcrição/dados de teste)
- O fluxo arquiteto/revisor/auditor/validador foi executado via Agent tool com subagent_type=general-purpose e prompts que carregam cada papel via .claude/agents/*.md (não é Agent tool nativo do Service Hub)

## Status
- [x] Tarefa escrita
- [x] Plano feito pelo arquiteto (no chat antes da execução)
- [x] Plano aprovado pelo Matheus (resposta às 4 perguntas críticas)
- [x] Código implementado
- [x] Código revisado (subagente reviewer)
- [x] Correções aplicadas (commit ebffe89)
- [x] Auditoria de segurança aprovada
- [x] Validação aprovada (teste mock 6/6)
- [x] Documentação atualizada (este arquivo)
- [ ] Onda 2 (visual premium) — PR separado em sessão futura
- [ ] Onda 3 (polimento) — PR separado em sessão futura
