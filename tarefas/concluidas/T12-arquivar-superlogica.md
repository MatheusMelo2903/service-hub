# TAREFA: T12 Arquivar no Superlógica

## O que foi pedido
Botão para anexar a ata e a prestação geradas aos documentos do condomínio no Superlógica. Teste só no 167.

## O que foi feito
1. Aba Atas, janela "Ata gerada": botão "Arquivar no Superlógica". Abre um painel com o título já no padrão usado hoje no Superlógica ("ATA ASSEMBLEIA AGO 16.06.2026"), editável, e o botão de envio. O PDF enviado é o mesmo do "Baixar PDF".
2. Prestação de Contas: depois de gerar (PDF ou ambos), aparece o mesmo painel com "Prestação de contas <período>".
3. Servidor: POST /api/condominio/:id/documentos manda o PDF para documentos?idEmpresa=<código>&publicar=0 (vai para a lista de documentos do condomínio, a mesma onde estão as atas e prestações de hoje). Não publica para os condôminos: a equipe publica no Superlógica depois de conferir.
4. Proteções: só PDF até 15 MB; precisa do módulo Atas ou Prestação com a ação "gerar" (ou GESTOR); quem tem carteira (T09) só arquiva em condomínio da carteira; antes de enviar confere se já existe documento com o mesmo título (mostra qual e oferece "enviar mesmo assim"); sucesso só com o id do documento devolvido pelo Superlógica.

## Testes
1. Validações: código inválido, tipo errado, arquivo que não é PDF, título curto e sem login recusados.
2. Título repetido: "ATA ASSEMBLEIA AGO 16.06.2026" no Casablanca (136) devolve 409 apontando a ata de 25/08/2026, sem gravar nada.
3. Envio real no Residencial Teste (167): dois PDFs de teste ("TESTE HUB T12 APAGAR" e "TESTE HUB T12 APAGAR 2", id 647493), não publicados. Reenvio do mesmo título travou com 409.

## O que o Matheus precisa validar
1. No Residencial Teste: gerar uma ata, clicar em Arquivar no Superlógica e conferir no Superlógica o documento e o título.
2. Apagar no Superlógica os documentos de teste "TESTE HUB T12 APAGAR" e "TESTE HUB T12 APAGAR 2" do Residencial Teste.
3. Dizer se quer que o Hub já publique para os condôminos (hoje não publica, de propósito).
