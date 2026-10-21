# T35 Conciliação sem depender do banco

Branch feat/financeiro-conciliacao (a partir de origin/dev fae99ff). Só leitura no Superlógica, sem migration, sem gravação.

## O que entrou

1. public/conciliacao-casar.js: funções puras usadas no servidor e na tela. Casa lançamentos do sistema com itens do extrato importado: mesmo dia e valor, grupo no mesmo dia (um lançamento contra vários itens ou o dia inteiro com composição), estorno no banco, rendimento e IRRF da poupança pelo total do mês, mesmo valor em até 5 dias (data real diferente da baixa), grupo em dias vizinhos, valor diferente em até 3 dias (até 15%, no máximo R$ 1.000: juros, multa ou desconto não registrados), lançado e desconsiderado no extrato, tarifas desconsideradas lançadas juntas no mês. Quadro da conta, bloqueio de lançamentos, regras sugeridas pelo histórico e leitura e comparação de arquivo OFX.
2. financeiro/conciliacao.js: leitura do conciliacao/index sempre por mês do calendário (janela no meio do mês volta incompleta), conferindo a conta de cada linha (linha de outra conta descarta a leitura), contas só com campos seguros, nomes dos condomínios ativos, fila de no máximo 2 chamadas e cache de 10 min.
3. Rotas GET no server.js, todas com módulo financeiro (ver), acesso ao Superlógica e carteira com falha fechada:
   /api/financeiro/conciliacao/quadro?carteira=ID (por carteira; até 80 condomínios; responde 202 enquanto lê);
   /api/financeiro/conciliacao/condominio/:id?competencia=AAAA-MM;
   /api/financeiro/conciliacao/condominio/:id/conta/:conta/itens?inicio&fim (até 62 dias, para o OFX);
   /api/financeiro/conciliacao/condominio/:id/regras.
4. Tela: botão "Conciliação" no quadro do Financeiro (quadro da carteira) e aba "Conciliação" no condomínio (contas, itens do banco sem lançamento, lançamentos sem banco, valor diferente, data diferente, outras divergências, regras sugeridas e comparação do OFX lido no navegador, sem envio do arquivo). Arquivo public/financeiro-conciliacao.js; financeiro.js ganhou só a aba.
5. Teste scripts/financeiro-conciliacao-teste.js (22 ok).

## Validar

Na aba Financeiro, escolher a CARTEIRA B e clicar em Conciliação; abrir o Casablanca, mês 09/2026: Conta Principal com diferença de R$ 680,25 (tarifas de cobrança desconsideradas e lançadas juntas em 30/09, R$ 740,25, e débito de R$ 60,00 de 14/09 sem lançamento). Sugerir regras. Baixar um OFX da conta principal e comparar antes de importar.
