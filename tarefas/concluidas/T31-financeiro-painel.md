# T31 aba Financeiro e pré balancete (frente J)

Branch feat/financeiro-painel, criada de feat/financeiro-regras (T25) com merge de feat/financeiro-boletos (T27). Sem migration, sem gravação; só GET no Superlógica.

## O que entrou
1. financeiro/painel.js: base da carteira inteira (idCondominio=-1) com despesas pagas do mês atual e dos 2 anteriores, pendentes de 01/2025 até hoje mais 60 dias e auditoria dos 3 últimos dias úteis; roda as regras da T25 (rodarRegras) e guarda 10 minutos em memória. No máximo 2 chamadas ao Superlógica ao mesmo tempo; resposta que não é JSON quebra a janela ao meio até 1 dia. Lê só os campos que as regras usam (nada de chave Pix, conta ou hash de arquivo).
2. Pré balancete por condomínio e mês: chamadas só daquele condomínio e mês; grupos sem comprovante (R4), sem nota (R5), vencida sem baixa (R6, contada até o fim do mês), lançada depois do vencimento (R8, só parcelas do mês) e mexida suspeita (R9 e anexo removido). Gravidade baixa fica "para conferir" e não impede fechar.
3. Rotas GET (server.js), todas com requireAuth, módulo financeiro conferido no servidor, leitura do Superlógica e carteira:
   GET /api/financeiro/resumo[?carteira=<id do grupo>][&forcar=1] (ação ver; quadro por condomínio ordenado pela gravidade)
   GET /api/financeiro/condominio/:id/alertas[?forcar=1] (ação ver)
   GET /api/financeiro/condominio/:id/pre-balancete?competencia=AAAA-MM[&forcar=1] (ação pre_balancete)
   GET /api/financeiro/boletos/:id?competencia=AAAA-MM (T27; passou a exigir a ação ver do módulo)
   Enquanto a base é calculada (cerca de 1 minuto), resumo e alertas respondem 202 e a tela tenta de novo sozinha. Atualizar recalcula no máximo a cada 2 minutos (base) e 1 minuto (pré balancete).
4. public/financeiro.js: item Financeiro no menu (depois de Cobrança), módulo financeiro (ver, pre_balancete) acrescentado ao MODULOS_CATALOGO pelo mesmo padrão do public/carteira-modulos.js da T18 (sem mexer no catálogo original); quadro da carteira, clique abre os alertas (filtro por gravidade e tipo, link "Abrir no Superlógica"), aba Boletos do mês e aba Pré balancete (só para quem tem a ação). index.html: um painel (panel-fincontrole) e uma linha de script.
5. scripts/financeiro-painel-teste.js: 33 testes sem rede (permissão, datas, link, campos enxutos, quebra de janela, fila de 2, pré balancete, resumo).

## Teste local com dados reais (21/10 04h00 a 04h07, porta 3931, acesso interno)
Base em 58 s: 14.070 parcelas, 9.703 linhas de auditoria, 8.969 alertas, 82 condomínios (sem 143, 144, 145, 160, 162 e 167). Casablanca 52 alertas; Victoria Bay 217; Carteira A 31 condomínios com dados. Pré balancete Casablanca 09/2026 em 8,5 s: 28 pendências (3 sem comprovante, 2 sem nota, 2 vencidas, 4 lançamentos tardios, 17 mexidas) e 6 para conferir. Boletos Casablanca 10/2026: 2 alertas (igual à T27). Erros: 401 sem login, 400 para carteira, código, 143 e mês inválidos ou futuros, 404 para carteira inexistente.
Achado: auditoria/index com idCondominio traz também as linhas de arquivo de todos os condomínios (st_sql_aud -1; 62.579 de 67.252 no Casablanca em setembro). O pré balancete não atribui essas linhas ao condomínio pedido.

## Para a integração (depois da segurança e da T18, com rebase)
1. A T18 (carteira) troca _dentroDaCarteira por carteiraT18; aqui _escopoFinanceiro lê a carteira direto. No rebase, trocar _escopoFinanceiro por carteiraT18.escopo(req) (respeita a ação todas_carteiras) e acrescentar em superlogica/carteira.js REGRAS a linha { re: /^\/financeiro\/(condominio|boletos)\/([^/]+)/ } se quiser a guarda antes da rota (o app.param idSuperlogica da T18 já confere a carteira nestas rotas).
2. Se a migration do módulo (trigger set_gestor_permissoes_totais) ganhar financeiro, o GESTOR já passa pelo cargo; os outros recebem pela tela de permissões.
3. O link "Abrir no Superlógica" usa .../clients/condor/despesas/id/<id>?idCondominio=<id> (padrão das telas de fornecedor e unidade). Conferir no Chrome na consolidação; se não abrir, ajustar SUPERLOGICA_WEB_BASE ou o caminho em linkLancamento.
4. Status do alerta (aberto, justificado, corrigido) fica para quando as tabelas fin_* da T24 entrarem.

## Validar (Matheus)
Abrir Financeiro com a Carteira A, conferir 3 alertas de alta do primeiro condomínio no Superlógica pelo link e gerar o pré balancete de setembro do Casablanca.
