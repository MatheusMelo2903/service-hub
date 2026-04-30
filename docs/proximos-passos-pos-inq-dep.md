# Próximos Passos Pós Inquilino e Dependente

Data: 2026-04-30
Estado de referência: public/index.html 5338 linhas, MD5 dd9df99169721ff1c834f70f8fe57004, não commitado.

---

## PASSO 1: Limpar lixo de teste da unidade A-0202 do cond 167

O que é: apagar os contatos DEP FETCH 01, TESTE DEPENDENTE API e INQ API REST 01 (id 81343) que estão pendurados na unidade como resíduo de testes de desenvolvimento. A proprietária MILENA DA SILVA LESSA não é apagada e não corre nenhum risco.

Faz sentido fazer agora: sim. Lixo de teste em ambiente de produção é risco de confusão operacional. Quanto mais tempo fica, maior a chance de alguém ler esses registros e tomar decisão errada.

O Hub atual tem botão de apagar contato: NÃO. O módulo de unidades só faz POST (criação) e PUT (atualização). Não existe endpoint DELETE implementado no Hub nem no proxy. A operação precisa ser feita manualmente pelo painel web do Superlógica.

Trade-off: a vantagem é ambiente limpo imediatamente, sem nenhum código novo. O risco é zero desde que o Matheus confirme os IDs antes de apagar, especialmente o id 81343. Apagar pelo painel é irreversível via Hub, mas o Superlógica tem histórico de auditoria próprio.

Custo de reversão: o Superlógica em geral não oferece desfazer de deleção de contato. Se apagar o contato errado, é recadastro manual. Por isso: confirmar o id 81343 na tela do Superlógica antes de clicar em apagar.

---

## PASSO 2: Apagar LJ17 do cond 168

O que é: remover a unidade LJ17 inteira do condomínio 168.

Faz sentido fazer agora: sim, desde que seja realmente uma unidade inválida ou criada por engano. Se for uma loja real que saiu do contrato, a limpeza é operacionalmente correta.

O Hub atual tem botão de apagar unidade: NÃO. Mesmo diagnóstico do passo 1. Operação manual via painel do Superlógica.

Trade-off: limpar agora evita que futuras importações de planilha para o cond 168 encontrem LJ17 como unidade fantasma e gerem conflito ou duplicidade. O risco é apagar uma unidade que ainda tem algum vínculo financeiro ativo (cobranças em aberto, despesas lançadas). O Superlógica pode bloquear a deleção nesses casos, mas vale verificar antes.

Custo de reversão: se tiver despesas ou cobranças vinculadas, a deleção pode falhar silenciosamente ou deixar registros órfãos. Verificar no painel se LJ17 tem histórico financeiro antes de apagar.

---

## PASSO 3: Criar condomínio novo para o Residencial com 777 unidades

O que é: cadastrar o condomínio novo no Superlógica e importar as 777 unidades via o módulo de Importar Unidades do Hub.

Faz sentido fazer agora: sim, com uma condição. O Hub atual suporta completamente essa operação. A planilha unificada com Proprietário, Inquilino e Dependente está implementada e validada. O novo cliente entra direto no formato novo, sem gambiarras de legado.

O Hub tem capacidade para isso: SIM. O módulo enviarUnidades já encadeia POST de unidade + PUT de proprietário + POST sequencial para inquilino e dependente. Para 777 unidades o processo vai levar alguns minutos, mas o botão Parar já existe para controle de risco.

Trade-off: importar 777 unidades de uma vez é a operação de maior volume que o Hub já vai ter executado. O ganho é onboarding do cliente novo em minutos ao invés de horas de cadastro manual. O risco é uma planilha mal preenchida gerar 777 unidades com dados errados. O caminho certo é sempre testar com 5 a 10 unidades primeiro, validar no Superlógica, depois executar o lote completo.

Custo de reversão: apagar 777 unidades criadas por engano é trabalho manual enorme. Não existe DELETE em lote no Hub. Por isso o teste parcial antes do lote completo não é opcional, é obrigatório.

---

## ORDEM RECOMENDADA

1 primeiro, 2 segundo, 3 terceiro.

Justificativa: os passos 1 e 2 são limpeza de ambiente que não dependem de código e não têm prerequisito entre si. Podem ser feitos no mesmo acesso ao painel do Superlógica. O passo 3 é onboarding de cliente real com volume alto, o que exige ambiente limpo e atenção total. Fazer 3 antes de limpar 1 e 2 seria misturar contextos no momento mais arriscado.

Dependência entre passos: nenhuma dependência técnica entre 1 e 2. Passo 3 não depende de 1 ou 2 para funcionar, mas operacionalmente faz sentido limpar o ambiente antes de adicionar um cliente novo de grande porte.

---

## RISCOS GERAIS

Risco 1: o Hub não tem módulo de deleção. Qualquer apagamento futuro de contato ou unidade vai continuar sendo manual no painel do Superlógica. Se o volume de limpezas aumentar, isso vai virar gargalo operacional. É um gap real a endereçar na fase SaaS.

Risco 2: para o Residencial de 777 unidades, o principal risco não é técnico, é de dados. Planilha com erros de formatação, nomes duplicados ou CPF inválido vai gerar falhas em série no log. Não tem como o Hub detectar isso antes do envio porque ele confia nos dados da planilha como fonte de verdade.

Risco 3: o arquivo public/index.html não foi commitado nem deployado ainda. Enquanto isso, o Hub em produção não tem a funcionalidade de Inquilino e Dependente. Se o Matheus precisar usar o novo formato para o Residencial, precisa commitar e deployar primeiro.

---

## RECOMENDAÇÃO FINAL

Commitar e deployar o index.html atual antes de qualquer outra coisa. Depois fazer a limpeza de 1 e 2 no painel do Superlógica em sequência. Depois, com ambiente limpo e Hub atualizado em produção, iniciar o onboarding do Residencial com teste de 10 unidades antes do lote completo de 777.

Quanto ao gap de deleção no Hub: não implementar agora. O volume ainda é baixo o suficiente para fazer manual. Implementar DELETE de contato e DELETE de unidade só faz sentido quando o Matheus estiver tendo que fazer isso mais de uma vez por semana. Por enquanto, o risco de ter um botão de apagar sem confirmação robusta é maior do que o custo de fazer manual.
