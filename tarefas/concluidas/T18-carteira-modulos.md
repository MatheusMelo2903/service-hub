# T18 carteira com bloqueio real, módulos das abas, prazos de manutenção e água e luz

Branch feat/carteira-modulos (worktree carteira-modulos), feita sobre a dev bc80e66. Integração e deploy ficam para a sessão de integração.

## O que mudou

1. Carteira com bloqueio de verdade (superlogica/carteira.js, montado no server.js antes do proxy e das rotas)
   * Rotas com o condomínio no caminho (/api/condominio/:id/..., /api/cobranca/condominio/:id..., /api/comparativo/condominio/:id...) e com id_superlogica no corpo (ata, prestação pelo Superlógica, conferência de despesas, comunicado, multa): condomínio fora da carteira recebe 403 fora_da_carteira.
   * PATCH /api/alertas/:id confere a carteira pelo condomínio do alerta.
   * Proxy /api/superlogica, só para quem tem carteira: condomínio da query (idCondominio, ID_CONDOMINIO_COND, id_condominio_cond, condominioAtual, id em condominios/...) ou do corpo (formulário, JSON, multipart, inclusive dentro de colchetes como COBRANCAS[0][ID_CONDOMINIO_COND]) fora da carteira recebe 403; gravação sem condomínio recebe 403; listas gerais (id=-1) voltam só com os condomínios da carteira; arquivo que não é JSON só sai quando a chamada citou um condomínio da carteira.
   * Busca global de unidades (/api/unidades/busca) volta filtrada no servidor.
   * Vê todos: GESTOR, acesso interno, quem não tem carteira e quem tem a ação nova configuracoes.todas_carteiras ("ver todas as carteiras", ação normal que o GESTOR dá pela tela de permissões; precisa de Configurações visível, mesmo padrão do ver_chaves).
   * Mais fechado que antes: carteira que não existe mais no Superlógica não vê nenhum condomínio; falha ao conferir a carteira recusa com 503 em vez de liberar.
   * /api/carteiras/minha usa a mesma regra (o seletor mostra exatamente o que o servidor libera). Arquivar no Superlógica passou a usar a mesma regra.
   * Cache de 60 s por usuário; trocar a carteira na tela limpa na hora; mudar permissões vale em até 1 minuto.

2. Módulos novos nas permissões: ficha_condominio (ver), cobranca (ver, segunda_via), comparativo (ver)
   * Front: public/carteira-modulos.js acrescenta ao MODULOS_CATALOGO e ao PANEL_TO_MODULO, esconde a aba de quem não tem e volta para o Dashboard se a aba lembrada não é permitida. GESTOR sempre vê.
   * Servidor: as rotas dessas abas recusam com 403 modulo_sem_acesso (relatório mensal do síndico conta como Ficha). A 2ª via agora exige a ação segunda_via (antes era pelo cargo GESTOR ou GERENTE).
   * Migration 010 (aplicada só no Supabase de teste): trigger do GESTOR com todas as ações de antes (inclusive ajustar_estrutura) mais os módulos novos e todas_carteiras, sem ver_chaves; GESTOR existente recebeu os módulos sem perder nada (conferido: ver_chaves, ver_auditoria, auditoria_total e transcricao_livre do Matheus continuam); os outros perfis ficaram com os três módulos desligados.

3. Prazos das manutenções editáveis (superlogica/prazos-manutencao.js)
   * Tabela nova config_geral (chave prazos_manutencao), padrão 180, 365, 180 e 45 dias. GET e PUT /api/alertas/prazos-manutencao; PUT só GESTOR, 7 a 1825 dias por tipo.
   * Card "Prazos das manutenções periódicas" em Configurações (só GESTOR). O cálculo dos alertas usa os valores do banco; mudar o prazo recalcula (entra na chave do cache).

4. Água e luz fora do alerta de pagamento sem nota fiscal (alertas-operacionais.js, ehContaConcessionaria)
   * Fica de fora quando o fornecedor é concessionária (CESAN, EDP, ESCELSA e as principais do país, ou "distribuição de energia", "companhia ... de saneamento") ou quando todas as contas da despesa são de consumo puro (Energia, Esgoto, Água-Esgoto, Energia Elétrica, Luz).
   * Continuam no alerta: Energia Solar (financiamento), manutenção de poço, material de bomba, serviço elétrico, caixa d'água, gás e empresas de "saneamento ambiental".

5. Nome do tipo de leitura no alerta de consumo
   * O consumo/index não traz o nome. A leitura cobrada aponta para a receita do boleto; a conta dessa receita (cobranca/index) dá o nome. Conferido em 3 condomínios: tipo 1 = Gás (conta 1.6), tipo 2 = Água Individual (conta 1.8). Lido por condomínio, sem número fixo no código; sem receita para conferir fica "consumo (tipo N)". A chave do alerta não mudou (visto e resolvido continuam).

## Testes

* scripts/teste-carteira-alertas.js (sem rede): 84 ok, 0 falha. Sobe um app de teste com a guarda e confere rotas, corpo, proxy (query, formulário, colchetes, JSON, PDF), busca, módulos, todas_carteiras, carteira apagada, falha de leitura, filtros de água e luz, prazos e nome do tipo de leitura.
* Dados reais por railway run, só leitura no Superlógica:
  * server.js local como acesso interno: prazos lidos do banco, PUT inválido recusado, cadastro 136 e proxy funcionando.
  * Alertas reais (2 Aldeia Manguinhos, 136 Casablanca, 10, 8): sem falhas; consumo com "Consumo de água" e "Consumo de gás"; nenhuma concessionária nas listas de sem nota.
  * Pagamentos sem nota de ago a out: Casablanca 54 para 9, condomínio 8 de 78 para 17, condomínio 10 de 11 para 5 (tirados só CESAN, ESCELSA e EDP).
  * Carteira real: perfil OPERACIONAL de teste com CARTEIRA A simulada em memória: 36 condomínios; condominios/get id=-1 de 91 para 31, todos da carteira; busca "maria" de 50 para 31; com todas_carteiras vê todos.
* Não testado: login real de um usuário com carteira pela tela (fica para a integração no Chrome).

## Para validar na integração

* Marcar CARTEIRA A no OPERACIONAL de teste e dar Ficha do Condomínio: abrir um condomínio da carteira (abre) e chamar um de fora (403); Dashboard e Importar continuam funcionando nos condomínios da carteira.
* Dar "todas carteiras" (Configurações) e ver todos os condomínios de novo.
* Configurações, card de prazos: mudar dedetização, salvar e ver o alerta do Dashboard mudar; voltar ao padrão.
* Conflito esperado com a sessão de segurança (T16, T17, T21): ela mexe em MODULOS_CATALOGO, nas permissões e no proxy. Aqui o index.html só ganhou uma linha (script carteira-modulos.js) e o server.js um bloco antes do proxy. A delegação de permissões da T21 (profiles.concede) precisa conhecer os módulos novos e todas_carteiras.
* Produção: migrations 008 e 010 precisam subir juntas com o código. Ao subir, quem não é GESTOR (hoje a Raiane) deixa de ver Ficha, Cobrança e Comparativo até o GESTOR liberar; a 2ª via passa a depender da ação segunda_via.
