# T51 Central de alertas

Pedido do Matheus (22/10/2026 21:18):
1. Uma "Central de alertas" no menu Principal (logo abaixo do Dashboard), mostrando a CARTEIRA TODA de uma vez (todos os condomínios que a pessoa pode ver), com filtro por condomínio.
2. Separada por área, com contador em cada uma:
   Financeiro: conta_a_vencer, saldo_baixo, recorrente_nao_lancada, sem_nota_fiscal (Dashboard) e os alertas do painel Financeiro (pago sem comprovante, pago sem nota, vencida sem baixa, duplicidade, lançada depois do vencimento, anexo atrasado, paga depois do vencimento sem juros, mexida suspeita).
   Operacional: manutencao_atrasada, consumo_fora_padrao.
   Documentos e jurídico: certidao_vencendo, certidao_vencida, mandato_vencendo, advertencia_vencida.
   Segurança: alertas de uso (só para quem já vê a aba Segurança).
3. Filtros: área, tipo, condomínio, gravidade (alta, média, baixa), situação (novo, visto, resolvido).
4. "Meus alertas" (preferência POR PESSOA): liga e desliga cada tipo, e "Pausar todos". Desligado: some do Dashboard (Alertas do condomínio e Seu dia), do painel Financeiro e da contagem principal da Central; NÃO é apagado e continua sendo gerado. Na Central há "Silenciados (N)": clicando, vê os silenciados.
5. Quem pode silenciar: só quem tem a ação nova "silenciar" do módulo novo "Central de alertas" (GESTOR sempre; para os outros só se o dono liberar em Configurações). OPERACIONAL e quem não tem a ação NÃO vê "Meus alertas" e o servidor recusa gravar preferência (403). Para quem não pode silenciar, todos os alertas aparecem sempre.
6. Nada por email. Só dentro do Hub.

## Contrato da API
GET /api/central-alertas?carteira=<meus|nome da carteira>&forcar=0|1
  { gerado_em, condominios: [{ id_superlogica, nome }], areas: [{ area, nome, total, alta, media, baixa, silenciados }], alertas: [{ origem: 'condominio'|'financeiro'|'seguranca', area, tipo, rotulo, gravidade, id_superlogica, condominio, titulo, resumo, status, alerta_id, link, data, silenciado }], falhas: [] }
  A origem 'condominio' usa a tabela alertas (já gravada quando o cartão do Dashboard é aberto) MAIS um cálculo em segundo plano da carteira com fila e teto (um condomínio por vez), guardado em cache; a origem 'financeiro' reaproveita o cálculo da carteira do painel Financeiro (financeiro/painel.js) e só entra para quem tem o módulo Financeiro; 'seguranca' só para quem já tem ver_auditoria ou auditoria_total.
GET /api/alertas/preferencias -> { pode_silenciar, silenciados: [tipos], pausado: bool, tipos: [{ tipo, rotulo, area }] }
PUT /api/alertas/preferencias { silenciados, pausado } -> 403 sem a ação silenciar.
Os endpoints existentes de alertas (Dashboard /api/condominio/:id/alertas, Seu dia, painel Financeiro) passam a devolver em cada alerta silenciado:true para quem silenciou; a TELA esconde os silenciados (com contador "N silenciados").
Mudar situação (visto, resolvido, reabrir) segue a rota PATCH /api/alertas/:id que já existe (alertas de origem condomínio). Alertas do Financeiro não têm situação gravada hoje: na Central aparecem como "novo" sem botões de situação.

## Banco
Migração 023: tabela alertas_preferencias (user_id uuid pk, silenciados text[] not null default '{}', pausado boolean not null default false, atualizado_em timestamptz). RLS ligada sem policy, revoke de anon e authenticated. Aplicar só no Supabase de teste.
Permissão: módulo central_alertas (ações ver, silenciar) no catálogo de módulos e na tabela de permissões da tela de Configurações; ver liberado para todos por padrão (como Dashboard), silenciar só GESTOR por padrão.

## Entregue (22/10/2026 21:40, dev deploy 2ce96012)
Servidor servico/central-alertas.js, tela public/central-alertas.js, silenciados nos cartões (dashboard.js, avisos.js, financeiro.js), migração 023 aplicada no teste. Testado no Chrome: Central abre com 87 condomínios, áreas Financeiro, Operacional, Documentos e jurídico, Segurança; silenciar Consumo moveu 46 alertas para "Silenciados (46)"; preferência restaurada depois.
Decisão: silenciar é ação liberável pelo dono (GESTOR sempre); OPERACIONAL só se o dono liberar.
