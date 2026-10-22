# T43 Leitura completa da apresentação na ata (PDF e PowerPoint)

Data: 22/10/2026. Branch: feat/ata-leitura-apresentacao, a partir da dev.

## Pedido do Matheus

Anexar na aba Atas a apresentação da assembleia em PDF ou PowerPoint e o sistema ler tudo: texto e imagens dos slides (prints de orçamento, fotos, tabelas coladas), para a ata sair mais fiel. Até uns 60 slides. Sem conversão que mude layout ou texto. Rápido.

## Decisão

PowerPoint não é convertido para PDF. Nenhum conversor de servidor fica 100% igual ao PowerPoint, e a conversão só serviria para leitura. O arquivo .pptx é lido direto no navegador: o texto sai exato do arquivo e as imagens de cada slide vão para leitura visual. Um único campo de anexo aceita PDF e .pptx.

## Como funciona

Navegador (public/ata-leitura-docs.js, carregado antes de atas.js; usa o JSZip que já vem no pptxgen.bundle.js, sem biblioteca nova):

1. PowerPoint: texto de cada slide na ordem visual (corte XY pelo layout das formas: cartões lado a lado viram colunas lidas inteiras, rótulo e valor na mesma linha ficam juntos), tabelas com colunas separadas por barra, gráficos nativos com séries e valores, SmartArt, anotações do apresentador. Slides ocultos ficam de fora. Imagens que o slide mostra (não as do mestre e do layout) vão para leitura; ícones pequenos (menos de 2% do slide ou menos de 120 px) são ignorados; a mesma imagem repetida em vários slides é lida uma vez. EMF e WMF não abrem no navegador: o sistema avisa para anexar também o PDF.
2. PDF: texto de cada página pela camada de texto. Página que desenha imagem ou tem 8 ou mais formas (gráfico exportado, tabela desenhada) vira foto da página inteira para leitura. PDF escaneado cai no mesmo fluxo.
3. Imagens reduzidas para JPEG de até 1568 px (1280 px quando o volume aperta). Tetos: 90 imagens por documento, 160 no total, 46 MB de imagens.

Servidor (server.js):

1. normalizarDocumentosApoio aceita imagens por documento e confere tipo e assinatura de cada uma (JPEG, PNG, WEBP, GIF), tamanho e tetos.
2. lerImagensDocumento lê em blocos de 12 imagens, até 4 chamadas ao mesmo tempo, com o texto do slide junto como contexto, e encaixa o resultado logo depois do slide ou página de origem como [imagem do slide N]. Bloco que falha não derruba os outros e vira aviso na tela.
3. Regra nova DOC 6: texto de dentro da imagem vale como documento escrito; [descrição visual: ...] é só contexto, nunca fonte de número, nome ou fato.
4. Teto de chamadas de apoio passa a ser 4 mais 1 por bloco de imagens. Rota /api/atas/gerar aceita 64mb. Texto por documento 120 mil caracteres, total 180 mil.

## Testes

1. Apresentação real Happy Days (9 slides) em .pptx e em PDF: texto completo, slide 1 (imagem inteira) e páginas com imagem separadas para leitura, valores do slide 7 e do slide 8 na ordem certa de cada opção.
2. Arquivo de teste com tabela, gráfico nativo, orçamento em imagem repetido, slide oculto, ícone pequeno e anotação: tudo como esperado.
3. PDF escaneado: página vai para leitura.
4. Servidor com respostas simuladas: validação, recusas, teto de chamadas, encaixe por slide e página, falha parcial e limite de 4 chamadas paralelas (15 de 15).
5. conferir-textos-publicos: limpo.

Pendente: leitura visual real só roda no dev, com a chave do sistema.
