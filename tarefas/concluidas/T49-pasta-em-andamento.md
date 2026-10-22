# T49 Pasta "Em andamento" (não perder ata, prestação, previsão e importação de unidades)

Data: 22/10/2026. Direto na dev. Pedido do Matheus: fechar a janela, trocar de aba, recarregar ou trocar de computador não pode obrigar a refazer a ata ou a prestação.

## Como funciona
1. Botão "📁 Em andamento (N)" no topo, ao lado do condomínio. Só aparece quando há trabalho guardado.
2. Cada item tem "Abrir" (troca para o condomínio do trabalho, abre a aba e devolve o resultado) e "Encerrar" (com confirmação, apaga de vez).
3. Guardado no banco do Hub por pessoa (cada um vê só os seus). Some com "Encerrar" ou 7 dias sem mexer (limpeza automática a cada 6 horas). Teto de 20 por pessoa (o mais antigo sai).
4. Arquivos gerados (PDF e PowerPoint da prestação) ficam no bucket privado "trabalhos".

## Servidor
servico/trabalhos.js: GET /api/trabalhos, GET /api/trabalhos/:id, PUT /api/trabalhos, POST /api/trabalhos/:id/arquivo, DELETE /api/trabalhos/:id. Dono pelo login, carteira conferida ao salvar, dados até 3 MB, arquivo até 40 MB com assinatura conferida (PDF ou zip), até 6 arquivos.
Migração 2026-10-22_021_trabalhos_salvos.sql aplicada só no Supabase de teste. Produção junto com as demais (007 a 021).

## Navegador
public/trabalhos.js: window.Trabalhos (registrar, salvar, anexar, encerrar, abrir, atualizar, lista, baixarArquivo) e a pastinha.

## Módulos ligados
1. Atas (public/atas.js): salva ao gerar; Fechar só esconde; botão Encerrar; reabre a revisão com texto, campos, participantes, conferência com a convenção e avisos. Transcrição só para quem tem transcrição livre. Documentos anexados não voltam (aviso).
2. Prestação (public/prestacao.js): salva ao gerar e ao gerar com ajustes; anexa PDF e PowerPoint; card Baixar de novo e Encerrar; reabre condomínio, período e Arquivar. Ajuste só até 14 minutos.
3. Previsão (previsao-modulo.html e previsao-embed.js): Salvar versão e salvamento automático por etapa; Previsões salvas lista as guardadas; troca de condomínio guarda antes.
4. Importar Unidades (unidades.js e unidades-normalizar.js): guarda prévia, revisão de papéis e pré visualização; encerra sozinho após envio sem erro.

## Pendências
1. tests/regressao-w045a-recreio.js e scripts/import-unidades-harness ainda leem as funções do index.html (que foram para unidades.js); corrigir o caminho.
2. Harness da previsão com as 5 planilhas reais só roda no Mac.
3. Teste no navegador de cada módulo.

## Testes
scripts/teste-trabalhos.js: 23 certos (isolamento por pessoa, carteira, limites, assinatura do arquivo, expiração, teto).
