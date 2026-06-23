# TAREFA: Debug do parser W016A — 422 "soma grupos != total despesas"

> Registrada em 2026-06-23. NÃO INICIADA. Tarefa separada de debug do parser.
> NÃO mexer no parser agora (decisão do Matheus); só registrado para não se perder.

## O que eu quero
Descobrir por que o parser do W016A perde despesas em certos relatórios. Achado nos
logs de runtime do microserviço `prestacao-pdf` em 2026-06-23: POSTs em `/gerar`
devolvendo 422 repetido com
`relatorio_invalido motivo=W016A inconsistente: soma grupos 144200,46 != total despesas 596051,63`.
O parser somou só ~R$ 144.200,46 de grupos contra um total de despesa declarado de
R$ 596.051,63 (capturou cerca de 1/4 das despesas).

## Por que eu quero
A validação de consistência do parser está corretamente barrando o deck incoerente
(degradação graciosa funciona), mas o relatório em si deveria gerar. Enquanto não
resolver, esse W016A específico nunca chega na geração (nem na prosa nem nos slides).

## Hipóteses iniciais (do diagnóstico de 2026-06-23)
- Acoplamento de layout: bucketing de linha por `top/3.0` e limiar de 78% de largura
  em `parser_w016a.py` podem estar perdendo grupos com leiaute diferente.
- Rodapé/cabeçalho hardcoded (`Rua das Acerolas`, `Condomínio Service`) em
  `parser_w016a.py` pode estar engolindo ou cortando linhas.
- Heurística de subgrupo permissiva (linha sem valor, até 3 palavras capitalizadas)
  empilhando como subgrupo e descartando despesas legítimas.
- Categoria/cabeçalho não reconhecido em `MAPA_CATEGORIA`.

## Critério de aceite
- [ ] Identificar exatamente quais grupos/linhas de despesa o parser está perdendo nesse W016A.
- [ ] Corrigir a captura sem quebrar os relatórios que hoje passam (regressão zero nos casos válidos).
- [ ] O W016A que dava 422 passa a gerar com somas fechando.

## Arquivos que provavelmente vão ser mexidos
`services/prestacao-pdf/app/parser_w016a.py` (e talvez `agrupador.py`). Arquiteto confirma.

## Restrições
- Não iniciar sem o Matheus enviar o W016A em questão (ou nome do condomínio/período).
- Não degradar a validação de consistência (ela é uma proteção, não o bug).
- Mudança no microserviço só vai para produção com autorização explícita.

## Exemplos ou referências
- Log do erro: `prestacao-pdf` dev, 2026-06-23, `/gerar` → 422.
- Diagnóstico de leitura da Tarefa 2 (camada microserviço) feito em 2026-06-23.

---

## Plano do arquiteto
[A preencher quando o Matheus enviar o relatório e mandar iniciar.]

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
