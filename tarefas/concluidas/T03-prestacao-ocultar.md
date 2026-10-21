# TAREFA: T03 Ajustar estrutura da prestação

## O que foi pedido
Função "Ajustar estrutura" na prestação, só para quem tem a ação prestacao_contas.ajustar_estrutura: ocultar categoria, ocultar rubrica, juntar rubricas, renomear. Números nunca mudam.

## O que foi feito
1. Motor da skill (vendor/skill_v13/scripts): bloco opcional "estrutura" no composicao.json, aplicado em montar.py (aplicar_estrutura). Categoria oculta fica no gráfico da distribuição e nos totais com a nota "(não detalhado nesta apresentação)" e sem slide de detalhamento (a numeração "DETALHAMENTO i DE n" conta só as detalhadas). Rubrica oculta fica com nome e valor e o texto "Não detalhado nesta apresentação.". Juntar só dentro da mesma categoria: uma linha com a soma, a série somada e o texto "Reúne: A, B.". Renomear rubrica e categoria. O montar.py recusa se o total de alguma categoria mudar. SKILL.md documenta o bloco.
2. Microserviço (app/v13.py e main.py): /v13/montar aceita "estrutura", valida contra os dados (só nomes que existem, juntar só na mesma categoria, nomes até 80 caracteres e sem travessão) e devolve "estrutura_base" (categorias e rubricas com totais) para a tela.
3. Hub (prestacao-v13.js e server.js): a geração guarda no servidor os números e a composição por 15 minutos; rota POST /api/prestacao/v13/ajustar/:jobId monta de novo com os ajustes, sem Superlógica e sem IA. Só GESTOR ou quem tem a ação ajustar_estrutura (conferido no servidor).
4. Tela da Prestação: card "Ajustar estrutura" aparece depois de gerar, com cada categoria e rubrica (marcar ocultar, editar nome, marcar e juntar), e o botão "Gerar de novo com os ajustes". A troca de condomínio esconde o card.
5. Permissões: ação ajustar_estrutura no MODULOS_CATALOGO (tela de permissões mostra "ajustar estrutura"); migration 2026-10-20_007 aplicada SÓ no Supabase de teste (trigger do GESTOR e os dois GESTOR existentes atualizados).
6. Skill atualizada para subir no Claude: ~/Downloads/powerpoint-prestacao-contas-T03-ajustar-estrutura.zip.

## Testes
Casablanca 136, jun/2025 a mai/2026 (dados reais, modo detalhado). Motor com e sem ajuste: auditoria visual passou nos dois. Ponta a ponta local (Hub e microserviço locais): geração, ajuste (ocultar Despesas Financeiras, ocultar Obras e Melhorias, juntar Jardinagem com Serviços Prestados, renomear) e PDF gerado; ajuste inválido, job inexistente e sem login recusados. PDFs de conferência em ~/Downloads/T03-teste-*.pdf.

## Pendência
Produção: a migration precisa ser aplicada no Supabase de produção quando subir (só com autorização).

## O que o Matheus precisa validar
1. Gerar a prestação do Casablanca, abrir "Ajustar estrutura", ocultar uma categoria e uma rubrica, juntar duas e renomear uma; gerar de novo e conferir que os totais são os mesmos.
2. Subir o zip da skill no Claude.
