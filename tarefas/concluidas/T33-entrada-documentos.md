# T33 Entrada de documentos (substitui o Paybox)

Aba "Entrada de Documentos" (menu depois do Financeiro), módulo entrada_documentos com as ações ver e lancar, encaixado no catálogo pelo mesmo padrão do financeiro.js e do carteira-modulos.js (GESTOR sempre vê; delegável pelo modal de permissões).

## Fluxo
1. O analista sobe vários PDFs (até 10 MB cada, dois de cada vez).
2. Servidor (POST /api/entrada/ler): texto do PDF com pdfjs-dist (dependência nova, 3.11.174); se faltar o essencial (texto vazio, sem valor ou sem CNPJ de condomínio), leitura interna pela mesma rotina de processar (servico/processar.js, processarDocumentoFinanceiro), com limite por hora (entrada_ler 300, entrada_interna 120) e auditoria. Nada na tela cita como a leitura é feita.
3. Campos: tipo (boleto, nota, guia, fatura, comprovante, outro), CNPJs com papel (pagador ou beneficiário pelo rótulo), valor, vencimento, emissão, linha digitável (só vale se os dígitos conferem; valor e vencimento saem dela), número do documento (inclusive pela chave de acesso da NFS-e nacional e da NF-e).
4. Condomínio pelo CNPJ do pagador ou tomador (CNPJ em mais de um cadastro nunca escolhe sozinho), respeitando a carteira; fornecedor pelo CNPJ (fornecedores/index pesquisa); categoria sugerida pelo último lançamento do fornecedor no condomínio.
5. Conferência no Superlógica (só GET): duplicidade no condomínio (mesma linha, mesmo documento do mesmo fornecedor, mesmo fornecedor e valor com vencimento a até 10 dias, janela de 45 dias), boleto já lançado em outro condomínio (linha nas parcelas de todos os condomínios a 1 dia do vencimento), documento com CNPJ de outro condomínio, mesmo arquivo ou mesma linha já na fila.
6. Rascunho editável na tabela fin_entrada (migration 015, só no banco de teste ledgyprytkuvgtbunsck).
7. Lançar (POST /api/entrada/:id/lancar, ação lancar): trava no servidor (sem ENTRADA_LIBERADA só o 167; ENTRADA_LIBERADA=todos ou lista de códigos), carteira conferida sem folga, conferência refeita sem cache, alertas GRAVE precisam ser marcados na tela, rascunho vira "incerto" antes de gravar (nunca lança duas vezes), arquivo enviado (arquivos/, tipo 9, responsável o fornecedor), despesa criada (despesas/ com ARQUIVOS[0]), anexar de novo se não ficou (despesas/anexar), etiqueta Doc. Fiscal ou Doc. Pgto, prova relendo a despesa.

## Arquivos
financeiro/entrada.js, servico/rotas-entrada.js, servico/processar.js (leitura interna), server.js (uma chamada), public/entrada-documentos.js, public/index.html (painel e script), migrations/2026-10-21_015_fin_entrada.sql, scripts/teste-entrada.js (44 testes), scripts/entrada-amostra.js (taxa de leitura), package.json (pdfjs-dist).

## Testes
Taxa de leitura e testes das rotas em EXECUCAO/testes/T33/resultado.md. Lançamento de teste no 167: despesa 307497, arquivo 657306 (apagar).

## Pendente
Email próprio para receber documentos. Teste da gravação do código de barras e da etiqueta com um boleto real do 167.
