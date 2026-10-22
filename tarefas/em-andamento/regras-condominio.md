# Regras do condomínio (substituição do CondGPT)

Pedido do Matheus em 22/10/2026: trazer para o Hub o que a administradora usa no CondGPT
(regimento, convenção e atas de cada condomínio, notificações, comunicados) e fazer melhor,
usando o que o Hub e o Superlógica já têm. Deixar de pagar o CondGPT.

Escopo aprovado:
1. Acervo por condomínio (convenção, regimento, atas, regulamentos), com versão vigente.
2. Consulta com o artigo exato e citação literal conferida; comparação entre condomínios; FAQ automático.
3. Notificação e multa: unidade e inquilino do Superlógica, histórico e reincidência, valor calculado
   pela regra do condomínio, carta fundamentada, registro no Superlógica com a rota de multas que já existe.
4. Comunicado citando o regimento.
5. Conferência da ata contra a convenção (quórum, prazo de edital, competência): SÓ AVISO para quem
   usa o Hub. A ata é gerada exatamente como hoje; nada da conferência entra no texto da ata.
6. Mandatos extraídos das atas, com alerta de vencimento; alerta de advertência vencida sem regularizar.
7. Importação do acervo do CondGPT (57 condomínios, 1.363 documentos com texto já lido, 1.110 notificações).

## Contrato comum (todas as frentes seguem)

Banco: migration `migrations/2026-10-22_020_regras.sql`, já aplicada no Supabase de teste
(ledgyprytkuvgtbunsck). Tabelas: regras_documentos, regras_trechos (busca em português sem acento),
regras_notificacoes, regras_mandatos, regras_conferencias_ata, regras_faq, regras_mapa_condgpt.
Função de busca: `regras_buscar(p_id, p_consulta, p_tipos, p_limite, p_so_vigentes)`. Bucket privado `regras`.
Nada de migration nova sem combinar com o orquestrador.

Biblioteca comum (não reescrever, só usar; mudança aqui só pelo orquestrador):
- `servico/regras/trechos.js`: `dividirEmTrechos(texto, tipo)`.
- `servico/regras/citacao.js`: `citacaoExiste`, `conferirFundamentos(fundamentos, trechosPorId)`, `trechosParaPrompt(trechos)`.
- `servico/regras/banco.js`: `buscarTrechos`, `juntarTrechos`, `listarDocumentos`, `inserirDocumento`, `marcarVigente`, `historicoUnidade`.

Regra anti invenção: o modelo recebe trechos com id e devolve fundamentos `{ trecho_id, citacao }`;
só aparece na tela ou na carta a citação aprovada por `conferirFundamentos`. Valor, data, prazo ou
artigo que não estiver no pedido ou no trecho vira `[a confirmar]`.

Rotas: cada frente cria `servico/regras/rotas-<frente>.js` exportando `criarRotas<Frente>(app, deps)`,
no padrão de `servico/rotas-entrada.js`. NÃO editar server.js: o orquestrador liga. deps disponíveis:
`{ requireAuth, express, banco (supabaseAdminRequest), perfilDe, podeModulo, temAcao, exigirCarteira (_exigirCarteira),
carteiraT18, exigirLeituraSuperlogica, exigirEscritaSuperlogica, superlogicaNativa, clienteSL, credSL, auditoria,
dentroDoLimite, chamarModelo (servico/modelo.chamarModelo), modelos (servico/modelos), storageUpload
(supabaseStorageUpload), storageSignedUrl (supabaseStorageSignedUrl), slComunicados, slModulo, buscarCadastro }`.
Prefixo das rotas: `/api/regras/...`. Permissão: módulo `regras` com ações `ver`, `consultar`, `notificar`,
`gerenciar`; gravação no Superlógica continua exigindo GESTOR ou GERENTE (exigirEscritaSuperlogica) e
confirmação explícita. Condomínio sempre conferido na carteira (exigirCarteira). Modelos: `modelos.modelo('regras')`,
`'regras_leitura'`, `'regras_extracao'`; custo com `funcao: 'regras'`.

Tela: cada frente cria `public/regras-<frente>.js` que monta a própria interface dentro de um contêiner
que o orquestrador põe no index.html (`#regras-<frente>` dentro de `#panel-regras`). NÃO editar index.html.
Condomínio ativo: `getCondominioAtivo()`; chamadas com `apiAuthFetch`. Visual igual ao das outras abas.
Textos de tela sem citar IA, modelo ou fornecedor (regra do Matheus). Sem hífen nem travessão em texto de tela,
carta ou comunicado.

Testes: cada frente deixa um harness em `scripts/regras-harness/<frente>.test.js` (node puro, banco e
modelo falsos) e roda antes de entregar.

## Frentes

A. Importação do CondGPT. B. Consulta, comparação e FAQ. C. Notificação, multa e comunicado.
D. Acervo (lista, envio de PDF, leitura de escaneado, vigente, pendências). E. Conferência da ata, mandatos e alertas.
Integração, importação real, teste no Chrome e subida para a dev: orquestrador.
