# TAREFA: Prestação de Contas — série mensal (Evolução + Superávit)

> Registrada em 2026-06-23 como a próxima feature da Tarefa 2 (Prestação de Contas),
> logo após a entrega "prestacao-bloco-a-prosa-rica" (commit `ad2439c`).
> NÃO INICIADA. Só planejamento por enquanto. Matheus vai primeiro testar a prosa de hoje.

## O que eu quero
Fazer a engine de prestação gerar os slides temporais (Evolução mensal e Superávit
mensal), que hoje saem vazios porque o W016A é consolidado e não tem quebra mês a mês.
A engine passa a aceitar de 1 a 3 relatórios e degrada com elegância: com só o W016A
funciona como hoje; com W016A + W011A destrava a Evolução de despesas; com W016A +
W011A + W015A destrava também o Superávit mensal. Na prática o Matheus vai sempre subir
2 ou 3 arquivos, mas o sistema nunca pode quebrar se vier só o W016A.

## Por que eu quero
A série mensal é o que falta para a engine alcançar o padrão ouro da skill
`powerpoint-prestacao-contas`, que monta esses gráficos a partir do W011A
("Mensais por categoria (do W011A)", ver `template_prestacao.py`). Sem o dado mensal,
dois slides do molde ficam degradados. A fonte existe e o Matheus já exporta esses
relatórios; é decisão de fonte de dado, agora travada.

## Decisão de fonte de dado (travada por Matheus em 2026-06-23)
- W016A (obrigatório): consolidado do período, fonte de verdade dos totais auditados.
- W011A (opcional): "Demonstrativo de Despesas dos últimos 12 meses", lançamentos
  datados → matriz de despesa mensal por categoria → slide de Evolução.
- W015A (opcional): extrato bancário com receitas e saldos mensais → receita mensal →
  slide de Superávit mensal (receita menos despesa por mês).
- Já existe parser de W011A reutilizável em
  `skills-server/previsao-orcamentaria/scripts/parser_superlogica.py`.

## Três partes (escopo da feature)
1. **Ingestão e detecção do tipo de cada relatório.** Receber 1 a 3 PDFs, identificar
   cada um como W016A, W011A ou W015A pelo conteúdo (não confiar só no nome do arquivo),
   e rotear cada um para o parser certo. Frontend e backend precisam aceitar múltiplos
   arquivos com tipos distintos no mesmo envio.
2. **Reconciliação de números entre as fontes.** Conferir se os totais batem entre
   W016A, W011A e W015A (ex: soma da despesa mensal do W011A bate com o total de despesa
   do W016A; receita do W015A bate com a do W016A). Se NÃO baterem, AVISAR de forma clara
   (degradar para revisão humana / aviso no deck) em vez de gerar um deck com números
   incoerentes entre o consolidado e os gráficos mensais.
3. **Degradação elegante + aviso opcional na dropzone.** Com só o W016A, gerar o deck
   atual sem os slides temporais, sem erro. O aviso opcional "para incluir gráficos de
   Evolução mensal adicione o W011A (e o W015A para o Superávit)" SÓ entra na dropzone
   (e no fallback) JUNTO desta feature, nunca antes — texto e capacidade andam juntos
   (regra travada para não prometer o que a engine ainda não faz).

## Critério de aceite
- [ ] Subir só W016A: deck gera como hoje, sem slides temporais, sem erro.
- [ ] Subir W016A + W011A: slide de Evolução de despesas vem preenchido com a série mensal real.
- [ ] Subir W016A + W011A + W015A: slide de Superávit mensal vem preenchido (receita menos despesa por mês).
- [ ] Tipos detectados pelo conteúdo, não pelo nome do arquivo.
- [ ] Quando os totais não baterem entre as fontes, o sistema avisa em vez de gerar deck incoerente.
- [ ] Dropzone passa a mostrar o aviso opcional do W011A/W015A (e só agora).
- [ ] Mini gráfico de distribuição mensal por card de categoria deixa de ser `serie_mensal=None` quando há W011A.

## Arquivos que provavelmente vão ser mexidos
Não sei tudo, arquiteto descobre. Candidatos: `public/prestacao.js` e `public/index.html`
(upload multi tipo + aviso dropzone), `server.js` (proxy aceitar 1 a 3 arquivos),
microserviço `services/prestacao-pdf/app/` (novo parser/adapter de W011A e W015A,
reconciliação, `pipeline.py` para alimentar `serie_mensal`/receita mensal no template),
e reuso do parser de W011A da skill de previsão.

## Restrições
- NÃO mexer no parser do W016A agora (tem bug 422 separado já registrado: parser perde
  despesas em certos layouts; ver tarefa de debug do parser).
- Manter a engine 100% determinística (sem IA por geração), igual à prosa de hoje.
- Não promover nada para produção sem autorização explícita do Matheus.
- O aviso da dropzone não entra antes da capacidade existir.

## Exemplos ou referências
- Skill padrão ouro: `skills-server/powerpoint-prestacao-contas/scripts/template_prestacao.py`
  (vetores "Mensais por categoria (do W011A)").
- Parser W011A reutilizável: `skills-server/previsao-orcamentaria/scripts/parser_superlogica.py`.
- Entrega anterior: `prestacao-bloco-a-prosa-rica` (commit `ad2439c`).

---

## Plano do arquiteto
[A preencher quando o Matheus mandar iniciar.]

## Status
- [x] Tarefa escrita
- [ ] Plano feito pelo arquiteto
- [ ] Plano aprovado pelo Matheus
- [ ] Código implementado
- [ ] Código revisado
- [ ] Correções aplicadas
- [ ] Auditoria de segurança aprovada
- [ ] Validação aprovada
- [ ] Documentação atualizada
