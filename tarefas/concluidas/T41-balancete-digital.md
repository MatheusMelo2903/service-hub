# T41 Balancete digital (21/10/2026)

## O que entrou
1. financeiro/balancete.js: conferência automática do PDF do 900A (prestação de contas) gerado no Superlógica.
   Lista os 900A do mês (impressoes/index), baixa o PDF (documentos/download, que redireciona para o
   armazenamento do Superlógica; só segue para https em superlogica.com ou superlogica.net), lê as páginas
   num processo separado (financeiro/balancete-pdf-worker.js, pdfjs, teto de memória e de tempo) e confere:
   mês em todas as capas e cabeçalhos (011A: 11 meses antes até o mês; 015G e 060B anuais terminando no mês),
   itens da seleção na ordem, comprovantes do 061A (parcela por parcela) contra as despesas liquidadas no mês
   (despesas/index), páginas em branco (anexo sem imagem, página sem conteúdo), páginas repetidas e campos do
   modelo sem preencher (ex.: %administradora.nome%).
2. Geração do 900A sem publicar (pedirGeracao): mesma chamada que a tela faz no Visualizar (relatorios/id/900A
   com render=pdf e getId=1), pela API v2 com o token do Hub. Só para condomínio de BALANCETE_GERACAO_LIBERADA
   (padrão 94 e 167; ids 143, 144, 145, 160 e 162 nunca). Seleção: BALANCETE_SELECAO (padrão usuario:1, a
   "Prestação de contas na Web NOVA teste Hub"). O gateway corta em 60 s (504) e o Superlógica termina em cerca
   de 3 minutos: o pedido é disparado uma vez (trava de 15 minutos por condomínio e mês) e a tela acompanha a lista.
   Nunca chama impressoes/post (compartilhar) nem impressoes/email. Publicar para os condôminos fica no Superlógica.
3. financeiro/balancete-rotas.js (ligado no server.js): GESTOR com módulo financeiro e acesso ao Superlógica.
   GET /api/financeiro/balancete/:id/impressoes?competencia=AAAA-MM
   GET /api/financeiro/balancete/:id/conferencia?competencia=AAAA-MM&impressao=<id>[&repetir=1] (202 enquanto roda)
   POST /api/financeiro/balancete/:id/gerar { competencia } (só liberado; auditoria balancete_gerar)
4. public/balancete.js: cartão "Balancete digital (900A)" na aba Financeiro, só GESTOR, sobre o condomínio do topo.
5. scripts/balancete-conferir.js (linha de comando, mesmo código) e scripts/teste-balancete.js (45 testes; 47 com PDFs reais).

## Medidas reais (Victoria Bay, setembro de 2026)
900A de 585 páginas e 231 MB: download em cerca de 8 s, leitura em 47 s com 775 MB de memória no Mac; conferência
completa em 55 s. Resultado: mês certo em todas as seções, 35 de 35 itens, 90 de 90 parcelas pagas no mês com
comprovante no PDF, nenhuma página em branco ou repetida; carta com %administradora.nome% sem preencher.

## Para o Matheus validar
Abrir Financeiro como GESTOR, escolher Victoria Bay no topo, mês 2026-09, Listar 900A do mês, Conferir a 647731.
Antes do deploy: conferir se o serviço no Railway tem memória para o leitor (cerca de 800 MB por conferência; uma por vez).
