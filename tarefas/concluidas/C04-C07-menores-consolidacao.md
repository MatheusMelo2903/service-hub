# C04 a C07: menores da noite (consolidação 21/10 06h17)

Branch fix/menores-consolidacao, a partir de origin/dev 3dd42dd.

C04 carteira (menores 1 e 2 de testes/T18/revisao-menores-2.md): superlogica/carteira.js aceita como bandeira só somenteCondominiosAtivos e exibirCondominiosInativos (lista exata); outro nome que cita condomínio conta como código. public/condominio-seletor.js: 500 ou 502 em /api/carteiras/minha vira carteira indisponível (lista vazia e aviso); 401 e 403 como antes.

C05 aba Financeiro (menores 1 a 3 de testes/T31/revisao-2.md): financeiro/painel.js não troca a base boa por um recálculo em que metade ou mais das janelas principais falhou; depois de um erro espera 2 minutos antes de recalcular; forçar na virada do dia não mostra a base de ontem.

C06 Cobrança (menor da T30): texto da simulação com plural certo e a conta "Acordos" mostrada como "Valor principal".

C07 seletor (menor da T30): nome fantasia que é só uma palavra genérica (Residencial, Condomínio, Edifício) usa o nome do condomínio. O 167 no banco de teste continua "Residencial" até alguém renomear, porque a sincronização só insere os que faltam.

Testes: carteira 175, painel 38, permissões 32/32, máscara 20, consumo 51, financeiro 11, textos limpo, teste da base em EXECUCAO/testes/C05/teste-base.js (4 ok).
Revisão curta separada: testes/C05/revisao-1.md (APTA; 1 MÉDIO corrigido em 67eeed0).
