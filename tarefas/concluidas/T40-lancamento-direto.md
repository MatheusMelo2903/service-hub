# T40 lançamento direto pela entrada de documentos

Branch feat/financeiro-lancar a partir de origin/dev 6735bb6. Sem migration (tudo cabe em fin_entrada.dados e nas colunas que a 015 já tem).

1. Tela (public/entrada-documentos.js): ao abrir um documento aparece a despesa pronta (condomínio, fornecedor, categoria sugerida pelo histórico do fornecedor no condomínio, valor e vencimento com a origem da leitura, conta bancária principal, anexo) e um botão "Lançar R$ X". Edição rápida num bloco "Editar" (abre sozinho quando falta algo). Na fila, rascunhos prontos de condomínio liberado ganham caixa de seleção e o botão "Lançar selecionados" (até 20; o primeiro clique mostra quantidade e total, o segundo lança).
2. Travas antes de gravar (financeiro/entrada.js, conferir; refeitas sem cache no lançamento):
   * duplicidade no Superlógica (mesma linha digitável, mesmo documento do fornecedor, mesmo fornecedor e valor com vencimento a até 10 dias) e boleto já lançado em outro condomínio: alerta grave, só passa marcado na tela; no lote não passa;
   * documento com CNPJ de outro condomínio e CNPJ repetido entre cadastros: grave; CNPJ repetido nunca escolhe o condomínio sozinho (já vinha da T33);
   * valor e vencimento: confiança alta só quando batem com a linha digitável conferida pelos dígitos; senão a pessoa marca "conferi no documento" (ou digita outro valor) e a confirmação fica presa ao valor; sem isso impede;
   * mês fechado: vencimento até a maior data de bloqueio de lançamentos das contas ativas do condomínio (contabancos dt_bloquearlancamentos_cb) impede; se não der para ler o bloqueio, impede.
3. Liberação por condomínio: ENTRADA_LANCAMENTO_LIBERADO (lista de códigos; sem a variável vale só o 167; não existe "todos"; 143, 144, 145, 160 e 162 nunca). A variável antiga ENTRADA_LIBERADA deixou de valer. Fora da lista o botão vira "Gerar rascunho" (POST /api/entrada/:id/pronto: confere tudo de novo e marca o rascunho como conferido, nada vai ao Superlógica).
4. Depois de gravar: relê a despesa e confere valor, fornecedor, condomínio, vencimento e o anexo (resultado.prova); se a releitura não bater, a tela avisa para conferir no Superlógica. Registro de quem lançou: lancado_por (uuid), resultado.lancado_por_email, origem (individual ou lote), auditoria entrada_lancada e entrada_lote.
5. Rotas novas: POST /api/entrada/lancar-lote (ação lancar, confirmação LANCAR_LOTE, valor e vencimento vistos na lista precisam bater) e POST /api/entrada/:id/pronto (ação ver).
6. Testes: scripts/teste-entrada-lancar.js (travas puras, conferência com Superlógica simulado e rotas num express local com banco em memória e gravação simulada).
