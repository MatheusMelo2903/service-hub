# Decisões e aprendizados

## Decisões travadas com Matheus (não reabrir)
- v13, 20/10/2026: o fundo branco com cinza apagado não aparecia no projetor. O padrão passou a ser fundo escuro, contraste alto e letra grande em todos os slides.
- Identidade Grupo Service em modo escuro (grafite, Poppins, Inter, logo branca), mantendo as cores vivas da prestação.
- Laranja trocado por azul celeste #4FD1F5: o laranja "quebrava" a identidade.
- Com relatório detalhado, cada rubrica mostra o que foi gasto, igual ao detalhado. Sem ele, modo simples, mesmo visual.
- O visual é um só para todos os condomínios. Só o conteúdo muda.
- O minigráfico mensal saiu dos detalhamentos para a lista caber com letra grande.
- Sempre PDF e PPTX, PDF primeiro.

## Armadilhas
- W011A tem no máximo 12 meses. Período maior exige dois W011A; os meses repetidos são conferidos.
- O W015A compara duas janelas que raramente são o período pedido. Com coluna diferente do período, um mesmo valor pode ter sido pago fora (ex.: kit play brinquedão de R$ 23.000,00 pago em ago/26 não entrava numa prestação até jul/26). Por isso o extrator usa a coluna exata quando existe e só tenta separar quando não existe.
- Linhas de descrição longas quebram no PDF do Superlógica; o extrator junta a continuação que começa na coluna zero.
- Cabeçalhos de categoria às vezes vêm sem recuo (ex.: "RETENÇÕES -NOTAS FISCAIS"); o extrator usa os nomes das linhas "Total de ..." para reconhecer.
- Saldos com muitos dígitos quebram em duas linhas ("1.044.751," e "40"); o extrator remonta.
- Tarifa bancária, desconto e pagamento a maior aparecem negativos dentro das receitas no Superlógica: mostrar entre parênteses, nunca esconder.
- Poppins é larga: valores longos passam por `ajusta()`. Não aumentar tamanhos sem testar `R$ 1.000.000,00`.
