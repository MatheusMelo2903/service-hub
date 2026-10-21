# T27 Conferência dos boletos antes de enviar

Branch feat/financeiro-boletos (a partir de origin/dev bc80e66). Só leitura no Superlógica; sem migration; sem gravação.

## O que entrou
1. financeiro/boletos.js: para um condomínio e uma competência (mês de vencimento), lê cobranca/index (status=validos, comDadosDasApropriacoes, comDadosDasContasEReceitas, comDadosDasUnidades) do mês e dos 3 anteriores, de 50 em 50, no máximo 3 chamadas ao mesmo tempo. Corpo que não é lista (estouro de memória do Superlógica vem como HTML com HTTP 200) é tratado como erro.
2. Alertas por unidade: valor fora do padrão (acima de 1,5 vez ou abaixo de metade da média dos meses anteriores, com os itens que mais mudaram), sem boleto no mês, boleto em dobro, leitura de água ou gás faltando ou zerada, rateio extra que sumiu ou apareceu, parcela de rateio repetida. Leitura ou rateio que some do condomínio inteiro vira um alerta só ("Todas").
3. Parcelas de acordo e canceladas ficam fora. Cadastros 143, 144, 145, 160 e 162 recusados.
4. Rota GET /api/financeiro/boletos/:idSuperlogica?competencia=AAAA-MM[&forcar=1] (login, acesso ao Superlógica e carteira, como a aba Cobrança), cache de 5 minutos.
5. tests/financeiro-boletos.test.js com dados fictícios para todos os tipos de alerta.

## Teste com dados reais (21/10, só GET)
Competência 2026-10: Casablanca 136 (192 boletos, 2 alertas), Enseada 137 (288, 10: água individual faltando e valores fora), 170 (763 boletos em 30 s, 9 alertas), 156 (320, nenhum). 2026-11 ainda sem boletos gerados: aviso correto. Competência inválida, id inválido e cadastro que não é condomínio: 400. Sem login: 401.

## Falta
Tela na aba Financeiro (T26) para listar por condomínio. Integrar depois da segurança, junto do financeiro.
