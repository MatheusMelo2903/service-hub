# T36 conector do banco preparado (frente N, 21/10/2026)

Branch feat/financeiro-banco, a partir de origin/dev. Sem migration, sem gravação no Superlógica, sem rede nos testes.

## O que entrou
1. financeiro/banco/sicoob.js: cliente da API do Sicoob (token OAuth com certificado do condomínio, extrato e saldo da conta corrente, extrato e saldo da poupança, DDA). Desligado e sem erro enquanto faltar SICOOB_CLIENT_ID, SICOOB_CERT_PFX_BASE64 ou SICOOB_CERT_SENHA. Credencial só por variável de ambiente, guardada fora do objeto (WeakMap), nunca em log, erro ou resposta. Só os hosts auth.sicoob.com.br e api.sicoob.com.br; só GET na API (o único POST é o do token). Caminhos e escopos numa tabela única (ROTAS), marcados [a confirmar] onde a documentação pública não confirmou.
2. financeiro/banco/extrato.js: normaliza a resposta da API, lê o extrato CNAB 240 do Sicoob (segmento E), confere saldo anterior mais créditos menos débitos igual ao saldo atual, gera OFX 1.02 (o arquivo que a equipe importa no Superlógica), itens da conciliação e itens no formato do OFX da T35 (paraItensT35, conferido com o leitor da T35). Recusa extrato que não fecha.
3. financeiro/banco/cnab240.js: leitor do retorno de pagamentos CNAB 240 (segmentos A, J, J52, O e N, trailers conferidos) e conferência pagamento x despesa por código de barras ou linha digitável, seu número, valor e data. Aponta: pago a maior (juros ou multa não registrados), pago a menor, sem baixa no sistema, data da baixa diferente da real, código de barras trocado, beneficiário diferente do fornecedor, pagador diferente do condomínio, pago sem despesa, baixa sem pagamento (rejeitado no banco), ambíguo.
4. financeiro/banco/dda.js: interface do DDA pronta (formato a definir com o banco) e cruzamento DDA x despesas (sem despesa, valor diferente, pagador diferente).
5. financeiro/banco/comum.js: centavos inteiros, datas, conversão linha digitável e código de barras (boleto 47 e arrecadação 48), dígitos verificadores, fator de vencimento com a virada de 22/02/2025.
6. Rota GET /api/financeiro/banco/status (requireAuth e requireGestor): diz se o conector está ligado e o nome das variáveis que faltam; não chama o banco.
7. scripts/teste-financeiro-banco.js: 19 testes com arquivos montados a partir dos layouts (nenhum .ret, .rem ou .ofx real no Mac).

## Revisões
Três revisões por agente separado (EXECUCAO/testes/T36/revisao-1.md a revisao-3.md). Todos os GRAVE e MÉDIOS corrigidos; o MÉDIO da revisão 3 (rejeitado em uma fase tomando despesa de pagamento casado em fase seguinte) foi corrigido com teste nas duas ordens.
Ficaram como menores conhecidos: texto "12.345" sem vírgula é lido como 12,35 (ambíguo; a API manda número com ponto decimal); a fase de valor e data pode variar com a ordem quando há empate, mas nunca marca "confere" falso.

## Para o Matheus validar
Depois da liberação do banco: pôr as três variáveis no ambiente dev pela Railway (ele mesmo), abrir /api/financeiro/banco/status como GESTOR e ver "ligado". Primeira puxada real de extrato só em uma conta e conferir com o extrato do internet banking.
