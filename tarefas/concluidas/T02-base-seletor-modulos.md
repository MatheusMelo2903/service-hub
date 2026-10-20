# TAREFA: T02 base seletor e módulos

## O que foi pedido
Seletor único de condomínio em todas as abas, JS de cada aba fora do index.html, rota de cadastro do condomínio no servidor e o campo de observações de volta na Prestação.

## O que foi feito

### a) Seletor único (public/condominio-seletor.js)
Componente CondSeletor: lista completa ao clicar, filtro sem acento ao digitar (primeiro quem tem palavra começando com o texto, depois quem contém; o código do Superlógica também acha), setas, Enter e Esc, código do Superlógica ao lado do nome. Lista única buscada uma vez no Supabase depois da sessão pronta.
Aplicado em: topo (no lugar do select antigo), janela Gerenciar Condomínio Ativo (aba Buscar), card do Dashboard, Configurações (antes buscava direto na API do Superlógica e gravava o código no lugar do id do Hub), banners de Importar Despesas, Importar Unidades, Boletos, Conciliação, Previsão e Leitura de Consumo (banner novo), e Prestação (com a opção fora do Superlógica).
Trocar em qualquer lugar chama setCondominioAtivo. Novidades em setCondominioAtivo:
1. Evento novo condominioAtivo:trocou (só quando o condomínio muda de fato), usado para limpar o que era do anterior: planilha de despesas, planilha/revisão/prévia/normalização de unidades, fotos de consumo, PDFs anexados na Prestação, módulo da Previsão (recarrega).
2. Troca recusada (aviso na tela) enquanto há envio em andamento: importação de unidades, envio de despesas, envio de leituras, geração da prestação.
3. state.config.condId passa a ser atualizado de verdade (a checagem usava window.state, que não existe porque state é const).
Leitura de Consumo agora envia com o código do Superlógica do condomínio ativo (antes usava state.config.condId, que ficava velho).
Aba Atas não foi mexida (T01 em andamento); fica para a T07.

### b) JS por aba
public/unidades.js, public/despesas.js, public/dashboard.js: blocos movidos sem alterar código (conferido linha a linha no commit de refactor). dashboard.js carrega antes do script inline (loadConfig chama atualizarDashCond na carga); unidades.js e despesas.js logo depois dele. A normalização via IA de unidades continua no meio do bloco das Atas no index.html (mexer ali agora conflitaria com a T01); mover na T06 ou T07.

### c) Servidor
superlogica/index.js e superlogica/cadastro.js reaproveitando o cliente de superlogica-dados.js. Rota GET /api/condominio/:idSuperlogica/cadastro (requireAuth + mesma regra de acesso ao Superlógica): nome, nome fantasia, CNPJ formatado (cai no st_cpf_cond quando o st_cnpj_cond vem vazio, caso do Casablanca), endereço, síndico atual (mandato vigente), subsíndicos e conselho. Cache de 10 minutos por condomínio. Só lista fechada de campos: o condominios/get traz chaves internas (token de cobrança, credenciais PJ) que não podem sair do servidor.
Teste real: 136 Casablanca (CNPJ 00.197.336/0001-96, síndica Maria de Fatima, 3 do conselho), 167 Residencial Teste (sem síndico), código inexistente (Superlógica responde 500; a rota devolve 502 com mensagem).

### d) Prestação
Campo "Observações (opcional)" de volta no passo 2, até 1000 caracteres, com o texto de ajuda pedido. Vai como obs nas duas rotas (/api/prestacao/v13/superlogica e /iniciar), que já aceitavam.

## O que o Matheus precisa validar
1. Trocar o condomínio pelo topo, pelo Dashboard, pela janela, por Configurações e por um banner, e ver que todos mostram o mesmo.
2. Prestação: escolher condomínio, escrever uma observação e gerar; conferir que a observação aparece.
3. Carregar uma planilha em Importar Unidades e trocar o condomínio: a planilha some com aviso.
