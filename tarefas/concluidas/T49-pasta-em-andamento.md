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
(preenchido ao fim da integração)

## Testes
scripts/teste-trabalhos.js: 23 certos (isolamento por pessoa, carteira, limites, assinatura do arquivo, expiração, teto).
