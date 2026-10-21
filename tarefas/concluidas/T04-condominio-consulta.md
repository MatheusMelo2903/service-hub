# TAREFA: T04 Ficha do Condomínio (consulta)

## O que foi pedido
Aba de consulta do condomínio (saldo por conta, despesas do mês, contas a vencer, síndico e conselho, dados cadastrais, inadimplência), busca global de unidades e auditoria cadastral. Só leitura.

## O que foi feito
Aba nova "Ficha do Condomínio" (menu Gestão), JS em public/condominio.js, seletor único no banner do topo da aba. Recarrega sozinha ao trocar o condomínio.
1. Busca em todos os condomínios (unidades/index com idCondominio=-1 e exibirDadosDosContatos=1): nome, CPF/CNPJ ou número. Mostra condomínio, unidade, proprietário e contatos com o papel (sem CPF, email ou telefone). Botão "Abrir ficha" troca o condomínio ativo. Testado com CPF (1 resultado), nome sem acento "Jaqueline Marcia" (1) e "204 A" (31).
2. Dados cadastrais: rota de cadastro da T02 (nome, CNPJ, endereço, síndico, subsíndico, conselho).
3. Saldo por conta (contabancos/index, vl_saldo_cb), contas ativas, com total.
4. Contas a pagar: vencidas e não pagas nos últimos 12 meses e a vencer nos próximos 30 dias (despesas/index pendentes).
5. Despesas pagas no mês, com seletor de mês (despesas/index liquidadas, paginado).
6. Inadimplência hoje por unidade (inadimplencia/index, 50 por página): cobranças, mais antiga, valor em aberto e corrigido com juros e multa, marca de jurídico.
7. Auditoria: proprietário sem CPF/CNPJ, sem email ou sem telefone, e soma da fração ideal (detecta escala 1 ou 100; avisa quando não fecha 100% e lista unidades sem fração). Roda pelo botão "Conferir agora".

Servidor: superlogica/consulta.js e rotas GET /api/condominio/:id/ficha?mes=AAAA-MM, /api/condominio/:id/auditoria, /api/unidades/busca?q=. Mesma regra de acesso das outras rotas do Superlógica; cada parte da ficha falha sozinha; cache de 5 min (ficha), 10 min (auditoria), 2 min (busca). Só campos escolhidos (contabancos traz st_token_cb e st_secret_cb, que não saem).

Teste com dados reais: Casablanca 136 (6 contas, total R$ 117.871,32; 2 vencidas; 3 a vencer; 41 unidades em atraso; 192 unidades, fração fecha 100%, 28 sem email, 105 sem telefone). Residencial Teste 167: auditoria de 454 unidades em 13 s, fração soma 99,3161% com 17 unidades sem fração.

## Observação
A aba não tem módulo próprio na tela de permissões (exigiria migration no trigger). Aparece para todos; os dados só vêm para quem já tem acesso a algum módulo do Superlógica. Criar o módulo junto com a T03.

## O que o Matheus precisa validar
1. Abrir Ficha do Condomínio no Casablanca e conferir saldos, contas a pagar e inadimplência com o Superlógica.
2. Buscar um morador pelo nome e pelo CPF.
3. Conferir agora a auditoria do Residencial Teste (fração não fecha 100%).
