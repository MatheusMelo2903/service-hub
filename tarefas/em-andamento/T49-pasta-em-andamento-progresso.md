# T49 Progresso (ponto de retomada)

Atualizado: 22/10/2026 17:57.

## Feito e no git (dev, commit 926565a)
1. Base: servico/trabalhos.js (rotas), public/trabalhos.js (pastinha e window.Trabalhos), script no index.html, migração 021 aplicada no Supabase de teste, scripts/teste-trabalhos.js (23 certos).

## Em andamento (agentes em paralelo, sem commit ainda)
1. Atas: public/atas.js (salvar ao gerar, Fechar manda para a pasta, botão Encerrar, restaurar).
2. Prestação: public/prestacao.js (salvar ao gerar, anexar PDF e PowerPoint, bloco "Baixar de novo" e Encerrar, restaurar com Arquivar).
3. Previsão: public/previsao-modulo.html e public/previsao-embed.js (Salvar versão e salvamento automático por etapa, Previsões salvas pela pasta).
4. Importar Unidades: public/unidades.js e public/unidades-normalizar.js (salvar prévia e revisão de papéis, encerrar sozinho após envio sem erro).

## Falta
1. Juntar os quatro, rodar node --check, scripts/conferir-textos-publicos.js, testes da ata e de unidades.
2. Commit e push na dev.
3. Publicar no dev pelo Mac (railway up no worktree ~/v8s/worktrees/t46-teste, serviço a4c99f8c, ambiente dev) e testar no Chrome: gerar, fechar, trocar de aba, recarregar, abrir pela pasta, encerrar.
4. Produção só com "sobe para producao", junto com as migrações 007 a 021.

## Retomada
Se a sessão cair: conferir git status na dev; arquivos modificados dos quatro módulos são o trabalho dos agentes. Rodar os checks do item 1 antes de commitar.
