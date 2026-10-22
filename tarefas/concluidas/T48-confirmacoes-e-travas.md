# T48 Confirmações e travas antes de gravar no Superlógica

Data: 22/10/2026. Direto na dev. Origem: teste geral do dev e manual do sistema.

## O que mudou
1. Importar Unidades: "Enviar unidades" pede confirmação com condomínio, código e quantidade de unidades. O botão fica desligado sem condomínio (igual ao de despesas).
2. Importar Despesas: "Enviar para Superlógica" pede confirmação com quantidade, total em R$, condomínio e código.
3. Cobrança, 2ª via: confirmação com unidade e data; no servidor, só nos condomínios de COBRANCA_SEGUNDA_VIA_LIBERADA (padrão só o 167), resposta 423 nos demais.
4. Balancete digital: geração do 900A liberada por padrão só no 167. Victoria Bay (94) volta pela variável BALANCETE_GERACAO_LIBERADA depois da validação.

## Testes
scripts/teste-balancete.js 74 certos (inclui 94 sem variável recusado); teste-carteira-alertas 175 ok; harnesses da ata passando.

## Antes de produção
Conferir no banco de produção as migrações 007 a 020 (alertas, carteiras, módulos e prazos, auditoria, financeiro, entrada, avisos, fechamento, custo, regras). Revisar permissões de quem não é GESTOR no mesmo dia.
