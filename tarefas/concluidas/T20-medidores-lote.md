# T20 Leitura de medidores em lote

Branch feat/medidores-lote, criada a partir de feat/seguranca (aa43fa6). Integra depois da segurança, com rebase sobre a dev.

## O que faz
Aba Leitura de Consumo: o leiturista escolhe o tipo (Água ou Gás), o mês (atual ou os dois anteriores) e o dia, e envia várias fotos de uma vez.
1. Cada foto é reduzida no navegador (lado maior 1200 px, JPG) e vai para /api/processar/medidor (rota interna da segurança: permissão leitura_consumo, limite por hora, auditoria). Volta a leitura (inteiros e decimais), a unidade e o bloco escritos na foto, o número de série e se há mais de um medidor. Sem unidade na foto, o nome do arquivo vale como pista (101A.jpg).
2. /api/consumo/:id/unidades lê o consumo/index do mês (última leitura, leitura já lançada no mês, média) e /api/consumo/:id/conferir casa a foto com a unidade e marca suspeitas: leitura menor que a anterior, consumo acima de 3 vezes a média, unidade não achada ou ambígua, foto ilegível, mais de um medidor na foto, leitura já lançada no mês, duas fotos na mesma unidade.
3. Tela de conferência editável: unidade (lista do condomínio), leitura, anterior, consumo, média, situação. Linha com suspeita vem desmarcada.
4. /api/consumo/:id/lancar grava uma unidade por vez no Superlógica (consumo/put: POST para leitura nova, PUT para trocar a do mês), guarda a foto como arquivo de medição de consumo (arquivos, tipo 11) e confere relendo o consumo/index. Refaz a conferência no servidor: leitura já lançada exige substituir; menor que a anterior ou salto exigem que o leiturista tenha visto a suspeita.

## Travas
Lançamento só nos condomínios de CONSUMO_LANCAMENTO_LIBERADO (padrão: só o 167). Fora disso, 423 antes de qualquer gravação; a conferência funciona.
Permissão leitura_consumo (lançar exige a ação "ler"), carteira, limite de 600 lançamentos por hora, um lançamento por condomínio de cada vez, auditoria consumo_lancado.
Nenhum texto de tela cita IA nem fornecedor (scripts/conferir-textos-publicos.js limpo).

## Testes (21/10/2026)
scripts/teste-consumo-lote.js: 44 ok.
Local com as variáveis do dev: 4 fotos (3 geradas e 1 real com dois medidores) lidas certo; 999 TESTE HUB casada pela etiqueta; condomínio 2 só leitura com as suspeitas certas; lançamento no 2 recusado 423; no 167 unidade 41565: leitura 123,45 lançada com foto (arquivo 656808) e conferida, repetição sem substituir recusada 409, troca para 123,5 com PUT conferida.

## Para o Matheus
Modelo da leitura: o rápido trocou algarismos nas fotos de teste; ficou o padrão (mais caro, estimativa de R$ 2 a 3 por 100 fotos contra R$ 1 aprovado). MEDIDOR_MODELO troca sem mexer no código.
Apagar no 167: leitura de água de outubro/2026 da unidade 41565 (123,5) e o arquivo 656808.
Liberar o lançamento num condomínio real: CONSUMO_LANCAMENTO_LIBERADO com os códigos.
