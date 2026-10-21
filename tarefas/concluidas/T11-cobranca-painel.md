# TAREFA: T11 Painel de cobrança

## O que foi pedido
Inadimplência por carteira com último contato (historicocobranca/index), simulação de acordo (acordos/simularparcelas) e link da 2ª via (cobranca/gerarlinksegundavia) com texto pronto para WhatsApp.

## O que foi feito
Aba nova "Cobrança" (menu Gestão), JS em public/cobranca.js; servidor em superlogica/cobranca.js.
1. Escolha: meus condomínios (já filtrados pela carteira do usuário, T09), só o condomínio ativo, ou, para o GESTOR, qualquer carteira do Superlógica (/api/carteiras agora devolve também os códigos dos condomínios). Só entram condomínios que existem no Hub.
2. Tabela por condomínio, carregada 3 de cada vez: unidades em atraso, em aberto, corrigido com juros e multa, e quantas estão sem contato há mais de 90 dias. "Ver unidades": responsável, cobranças, valor corrigido e último contato do CRM de cobrança (data, canal, quem fez e a descrição, com email e telefone trocados por "o email cadastrado"). Registros automáticos ("cobrança impressa") não contam como contato.
3. Simular acordo: parcelas (1 a 60), entrada e data da 1ª parcela. Usa as composições do Superlógica (cobranca/index) e o acordos/simularparcelas com juros, multa e conta principal do condomínio. Não cria acordo. Gera o texto da proposta para copiar.
4. 2ª via: escolhe a cobrança e a data de pagamento (até 30 dias), gera o link no Superlógica e o texto para WhatsApp. Só GESTOR e GERENTE. Unidade e cobrança são conferidas no servidor contra o painel.
Rotas: GET /api/cobranca/condominio/:id, POST .../simular, POST .../segunda-via. Cache de 15 minutos por condomínio (Atualizar relê, no máximo uma vez por minuto). Quem tem carteira (e não é GESTOR) só lê e gera 2ª via dos condomínios dela, conferido no servidor. A 2ª via é chamada uma vez só, sem repetição automática, e o botão trava contra clique duplo. Acima de 30 condomínios a tela pede confirmação antes de carregar.

## Testes com dados reais (Casablanca 136)
41 unidades em atraso, R$ 506.937,09 corrigido, 4 sem contato há 90 dias; nenhum email na resposta. Simulação da unidade 203 I (2 cobranças, R$ 1.280,84): 3 parcelas de R$ 426,94/426,95/426,95 e, com entrada de R$ 100, 4 de R$ 295,21 (fecha com o total). Recusas testadas: unidade sem atraso, 99 parcelas, data inválida, cobrança de outra unidade, sem login.

## BLOQUEADO para teste [a confirmar]
A 2ª via NÃO foi gerada de verdade: o condomínio de teste 167 não tem nenhuma cobrança, e gerar o link num condomínio real pode registrar boleto atualizado no banco (regra: gravação só no 167). Para validar: o Matheus gera uma 2ª via de um boleto real pela tela (ou lança uma cobrança no 167 para eu testar).

## O que o Matheus precisa validar
1. Cobrança: carregar "Meus condomínios" e conferir os totais do Casablanca com o Superlógica.
2. Simular um acordo e comparar com a simulação feita no Superlógica.
3. Gerar uma 2ª via e conferir o link e o texto.
