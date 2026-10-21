# TAREFA: T06 Normalizar via IA (aba Importar Unidades)

## O que foi pedido
Evoluir o card "Normalizar via IA": aceitar PDF, xlsx, csv, docx, imagem e PDF escaneado; converter para o layout de 26 colunas; prévia editável marcando dúvida e campo obrigatório faltando, sem inventar; cruzar com unidades/index do condomínio ativo para marcar duplicadas; importar pelo fluxo atual (POST + PUT).

## O que foi feito
1. Código do normalizador saiu do index.html para public/unidades-normalizar.js (só a parte da aba Unidades).
2. Formatos: PDF com texto, PDF escaneado, Word .docx (lido no navegador, sem biblioteca nova), planilha .xlsx .xls .ods (todas as abas), .csv .tsv .txt e foto (JPG, PNG, WEBP, GIF). Word antigo .doc e foto HEIC dão mensagem clara pedindo outro formato.
3. Imagem e PDF escaneado vão inteiros como documento ao Claude (até 7 MB). PDF com texto, planilha, Word e texto grandes vão em partes de 60 linhas, 4 ao mesmo tempo; da parte 2 em diante vai junto o começo do documento para a IA saber o que é cada coluna. Resposta cortada ou parte que falhou vira aviso na tela (nada some em silêncio).
4. A IA agora devolve uma pessoa por linha em JSON com nomes de campo. O formato antigo (CSV de 26 colunas por posição) deslocava colunas: no primeiro teste o nome caiu na coluna do CPF em todas as 522 linhas.
5. A IA marca dúvidas à parte (não vão para a Observação nem para o Superlógica). Regras sem IA marcam: falta tipo, unidade ou nome (vermelho); CPF ou CNPJ inválido, email, telefone, CEP, data, UF estranhos, unidade sem proprietário, mais de um proprietário, pessoa repetida (amarelo).
6. Prévia editável: clicar na célula e corrigir; a linha é conferida de novo ao sair. Botão de remover linha, filtros (faltando obrigatório, com dúvida, já existem, sem pendência), motivo de cada linha na coluna Situação.
7. Duplicadas: rota nova POST /api/condominio/:id/unidades/conferir (só leitura, superlogica/conferencia.js). Lê unidades/index do condomínio ativo e diz por linha se a unidade já existe (número com e sem "Apto", zeros à esquerda, bloco) e se a pessoa já está lá (CPF/CNPJ ou nome). CPF, email e telefone do cadastro existente não saem do servidor. Cache de 2 min; "Conferir de novo" lê de novo.
8. Ao abrir a revisão de papéis: linha sem obrigatório e linha cuja unidade já existe entram como Descartar (dá para mudar); linha com dúvida entra como Incerto com o motivo. Se a conferência não rodou, falhou ou ficou desatualizada por edição, a tela avisa antes de seguir. O envio continua o mesmo de antes (POST + PUT).

## Testes com dados reais
1. CSV real do Monte Verde (226 unidades): 492 nomes certos, 0 faltando, 0 inventados, 62 s.
2. Mesmos dados como PDF escaneado e como foto: 15 unidades, 34 nomes certos, 0 faltando, 0 inventados, proprietário certo em todas.
3. No dev (Chrome): Word e Excel com 30 unidades geram 67 linhas; conferência no Residencial Teste (167, 454 unidades) marcou 12 linhas como já existentes (unidades 001 a 004 batem por número); editar a unidade de uma linha tira a marca e pede nova conferência; revisão e prévia de envio montadas certo.
4. Erros da rota: código inválido, corpo sem linhas e sem login respondem 400, 400 e 401.

## Pendências
1. O envio real de 1 unidade de teste (9001) no Residencial Teste foi bloqueado pelo classificador de segurança da sessão agendada. O fluxo de envio não mudou nesta tarefa, mas o teste ponta a ponta de gravação ficou para o Matheus.
2. Planilha em que a coluna Proprietário vem vazia: a IA às vezes marca o único condômino da unidade como Proprietário, sempre com a dúvida "proprietário não identificado". Fica para o operador decidir na prévia.

## O que o Matheus precisa validar
1. No Residencial Teste, normalizar um arquivo pequeno (um Word ou uma foto de lista), conferir as marcas, corrigir uma célula, remover as que já existem e enviar 1 ou 2 unidades novas.
2. Abrir uma lista real de outra administradora em PDF e ver se as dúvidas marcadas fazem sentido.
