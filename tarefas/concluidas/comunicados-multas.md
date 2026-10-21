# T10 Comunicados e multas (20/10/2026)

## O que foi feito

1. Aba nova "Comunicados e Multas" (menu Gestão, só GESTOR e GERENTE; o servidor confere de novo).
2. Comunicado: tipo (geral ou multa recebida pelo condomínio), assunto e detalhes; "Gerar texto no padrão" (IA, regras: sem hífen, sem inventar, o que faltar vira [a confirmar]); título e texto editáveis com prévia; para quem (só deste condomínio), canal, marcar para notificar. Publicar só com a caixa de confirmação marcada e sem [a confirmar] no texto. O servidor monta o HTML a partir do texto revisado (escapado).
3. Disparo de notificações: a API (comunicados/notificarcomunicado) não recebe condomínio; dispara os pendentes de TODOS os condomínios da licença. Por isso a rota está TRAVADA (HTTP 423) até a decisão do Matheus (variável COMUNICADOS_DISPARO_LIBERADO=1). O comunicado publicado com "notificar" fica na fila do Superlógica.
4. Multa ou ocorrência na unidade: unidade do condomínio (lista do Superlógica), data, tipo (com multa ou advertência), texto no padrão, notificar (não, proprietário, inquilino), email, carta (vai para as impressões do Superlógica) e cobrança opcional (valor, vencimento, conta categoria, conta bancária). O servidor confere que a unidade e a conta bancária são do condomínio antes de gravar.
5. Cobrança da multa TRAVADA (HTTP 423, antes de gravar qualquer coisa) até validar num condomínio com CNPJ (variável MULTA_COBRANCA_LIBERADA=1). O botão de disparo saiu da tela enquanto o disparo estiver travado.
6. Segurança: destinos "de todos os condomínios" (4, 5, 6) recusados; toda gravação exige o campo de confirmação; datas MM/DD/AAAA validadas; log de cada gravação (quem, condomínio, resultado), sem conteúdo; título sem < >; [a confirmar] recusado também no servidor; datas reais (sem 31/02, ano atual mais ou menos 1, vencimento não no passado); o mesmo comunicado não publica de novo em 10 minutos; a confirmação desmarca a cada mudança e o rótulo mostra o que vai ser gravado; multa parcial (carta ou cobrança falhou) volta como parcial e o formulário é limpo para não duplicar; sem resposta do Superlógica vira "resultado incerto, confira antes de repetir"; a IA recebe só unidade e bloco, sem nome do morador.

## Testes (gravações só no condomínio 167)

scripts/comunicados-harness.mjs 17/17 (após a revisão): destino global recusado, sem confirmação recusado, disparo travado, 401, data trocada recusada, unidade de outro condomínio recusada antes de gravar, rascunho gerado sem hífen. No 167: comunicado "TESTE HUB T10 ignorar" publicado sem notificar; ocorrências 19150, 19151 e 19152 registradas sem notificar; cartas 647486, 647488 e 647490 geradas; o mesmo comunicado de novo foi recusado. Cobrança: o Superlógica recusou no 167 porque o condomínio de teste não tem CNPJ ("CPF/CNPJ inválido" no facilitador); a tela mostra esse motivo. Não deu para validar a cobrança criada.

## Pendências

1. Decidir se libera o disparo global de notificações pela API.
2. Validar a cobrança da multa num condomínio de teste com CNPJ (ou cadastrar CNPJ no 167).
