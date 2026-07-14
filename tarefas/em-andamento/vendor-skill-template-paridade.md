# Paridade vendor mais skill do template_prestacao.py (frente própria, não fast follow)

Status: REGISTRADO. Não fazer agora. Aberto em 2026-07-13, ao fechar a dívida do
commit c0e01e2.

## Achado
O README do prestacao-pdf tratava o vendor como "a skill mais 4 patches locais".
Ao conferir os arquivos de verdade, os dois divergiram estruturalmente, não são o
mesmo código com 4 ajustes:

- Arquiteturas de slide diferentes. A skill roda como script linear e tem
  `build_detail_v7`. O vendor foi refatorado em funções `slide_capa`,
  `slide_visao_geral`, `slide_evolucao`, `slide_patrimonio`, `slide_superavit`,
  `slide_receita`, `slide_estrutura`, `slide_detalhe`, `slide_bloco`,
  `slide_encerramento`, `slide_certidoes_capa`, `slide_certidao`, mais
  `aplicar_config` e `montar(configs)`. Os inventários de função quase não se cruzam.
- Skill com 1137 linhas, vendor com 1043. Compartilham só as funções auxiliares
  (`fmt_brl`, `add_rect`, `add_text_box` e afins).
- Divergências reais confirmadas: orquestração de blocos (`aplicar_config` mais
  `montar(configs)`) e validação por categoria só existem no vendor; o piso de
  linha da tabela aparece misturado nos dois.

## Já resolvido nesta sessão
A dívida de privacidade (o print de cifra) NÃO era divergência a reconciliar: era
artefato local do vendor, removido, e a skill nunca teve. Conferido em 2026-07-13.

## O que fica para a frente própria
Se o objetivo for paridade real vendor mais skill, é reconciliação de dois códigos
que divergiram de verdade, com escopo e gate próprios: decidir qual é a fonte da
verdade, portar orquestração e validação, e reconferir slide a slide. Não é fast
follow e não entra no fechamento do c0e01e2.
