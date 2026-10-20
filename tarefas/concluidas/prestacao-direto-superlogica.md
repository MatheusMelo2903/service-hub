# Prestação direto do Superlógica e sincronização de condomínios

Data: 20/10/2026. Branch: feat/gestao-usuarios (também em dev). Sem deploy ainda (Railway com builds pausados).

## O que mudou

1. Botão "Puxar os dados do Superlógica" na aba Prestação de Contas. Com o condomínio cadastrado e o período escolhido, o servidor busca no Superlógica e gera a prestação sem nenhum PDF. Os PDFs continuam como alternativa ("Gerar com os PDFs anexados").
2. A aba usa o condomínio escolhido no seletor do topo (ao abrir e a cada troca).
3. Sincronização de condomínios: cria no Hub os condomínios ativos do Superlógica que faltam. Roda 1 minuto depois do servidor subir, todo dia às 6h (Brasília) e pelo botão "Atualizar agora" em Configurações. Nunca altera nem apaga linha existente. Linha do Hub sem código do Superlógica com nome igual não é duplicada: aparece como "sem código, preencher". Empresas (LTDA), Grupo Service e lojas maçônicas ficam fora; outros códigos podem ser excluídos com SYNC_CONDOMINIOS_IGNORAR. SYNC_CONDOMINIOS=off desliga a rotina automática.

## Como funciona a puxada

superlogica-dados.js busca, só com GET, em paralelo (6 por vez):
balancetes/index mês a mês (rubricas do plano de contas), caixa/index no dia 1 do período e no dia 1 do mês seguinte (saldo inicial e conferência do final) e despesas/index liquidadas, paginadas (descrição de cada lançamento e rateio por conta). Só os campos usados saem do servidor do Hub (nenhum dado de fornecedor).

O microserviço (app/v13_superlogica.py, rota /v13/de-superlogica) monta o mesmo dados.json da skill e o rascunho com a função da própria skill. Daí em diante o fluxo é o mesmo (curadoria em lotes, montar.py, auditoria). Conferências: cada mês fecha receitas e despesas, saldo calculado bate com o caixa, cada rubrica marcada exato ou diverge.

## Validação (local, chaves e créditos reais do ambiente de teste)

Conferido contra os PDFs W011A detalhados: saldos inicial e final, receitas e despesas mês a mês idênticos em Bosque dos Ipês, Lara Hoffman e Vista de Porto Canoa.

| Condomínio | Rubricas PDF | Rubricas Superlógica | Conciliadas | Tempo total | Páginas |
|---|---|---|---|---|---|
| Bosque dos Ipês | 277 | 89 | 88 (a outra é tarifa bancária, sem lançamento) | 102s (antes 135s) | 34 (antes 68) |
| Lara Hoffman | 110 | 52 | 51 | 78s | 26 |

A puxada leva de 3 a 6 segundos. O que diminui é o número de rubricas: o W011A detalhado quebrava a mesma conta em várias ("Seguro Condominial 1 de 6", "Plano Odontológico Ref. 05/2026"); o balancete agrupa pelo plano de contas. Custo da curadoria do Bosque caiu de cerca de US$ 0,60 para cerca de US$ 0,26.

## Pendências

1. Deploy no dev do service-hub e do prestacao-pdf quando o Railway voltar.
2. Reserva dos Camarás na produção está sem id_superlogica (código 49): preencher no cadastro.
3. Superlógica tem dois cadastros Villaggio Laranjeiras residencial (169 e 170); o 169 vai entrar como linha nova. Excluir com SYNC_CONDOMINIOS_IGNORAR=169 se for cadastro antigo.
4. Rubricas que vêm só de lançamento bancário (tarifas, IRRF) ficam com o texto automático.
