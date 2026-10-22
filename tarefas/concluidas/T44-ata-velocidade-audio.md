# T44 Ata mais rápida e áudio que funciona em qualquer computador

Data: 22/10/2026. Direto na dev.

## Pedido do Matheus

A geração da ata demora muito; e em computador Windows o áudio grande às vezes fica carregando para sempre, sem transcrever e sem dar erro. Reduzir o tempo sem perder qualidade e fazer o áudio funcionar em qualquer sistema.

## O que mudou

Geração da ata (server.js e public/atas.js):
1. As auditorias por bloco (até 3) rodam ao mesmo tempo. O bloco 1 sai na frente e os outros 10 segundos depois, para continuarem lendo o cache do prompt (custo igual). O resultado é juntado na mesma ordem do laço antigo.
2. O servidor registra a etapa da geração (lendo a apresentação, escrevendo, conferindo, completando, revisando nomes) e o botão mostra a etapa com o tempo.

Áudio (public/atas.js e servico/audio.js):
1. Compressão no navegador só quando o computador aguenta: até 350 MB, e até 150 MB quando o navegador informa menos de 4 GB de memória.
2. Vigia: compressor que não carrega em 90 s ou fica 45 s sem avançar é encerrado e o arquivo original é enviado. Qualquer falha da compressão também cai no original.
3. Arquivo acima de 40 MB sobe em partes de 40 MB (rotas /api/audio/partes). O servidor guarda as partes em pasta temporária, junta em ordem e envia ao serviço de transcrição de servidor para servidor. Cada pedido é curto, à prova do limite de tempo da borda do Railway. Parte que falha é reenviada sozinha. Partes vencidas são apagadas em 2 horas.

## Testes

1. Compressão real de um áudio de 74 MB no Chromium: 4,5 s, saiu com 3,2 MB.
2. Compressor travado (simulado): em 90 s caiu no envio do original, com aviso na tela.
3. Envio em partes de 74 MB e de 95 MB (fora de ordem): arquivo que chega ao serviço idêntico ao original, recusas de índice inválido, de outro usuário e de tamanho acima do limite.
4. Leitura de documentos da T43: 15 de 15 seguem passando. conferir-textos-publicos: limpo.

## Pendente

Item 3 da conversa (inserção de lacunas por trecho em vez de reescrever a ata inteira) fica para depois, com comparação contra atas antigas.
