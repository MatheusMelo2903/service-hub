# T39 avisos do financeiro (frente P, 21/10)

Tudo dentro do Hub; nada sai por e-mail ou WhatsApp (financeiro/avisos-envio.js é o ponto de extensão, desligado).

O que entrega:
1. Conta sem extrato importado: por condomínio e conta ativa, dias úteis desde o último extrato importado no Superlógica, com a regra do quadro da T35. Limite AVISOS_DIAS_SEM_EXTRATO (padrão 2) ou limite_dias na geração sob demanda.
2. Resumo da manhã por carteira (grupos do Superlógica da T18 e T31): contas sem extrato, pendências do pré balancete do mês anterior, conciliação com diferença, boletos com alerta (mês seguinte a partir do dia 15) e vencidas sem baixa, por gravidade.
3. Erros por analista: regras da T25 cruzadas com quem lançou a despesa na auditoria (últimos 5 dias úteis e hoje) ou quem fez a mexida (R9 e anexo removido), com link para o lançamento. Vínculo usuário do Superlógica x analista do Hub (e carteira) editado só pelo GESTOR.
4. Geração às 7h dos dias úteis (America/Sao_Paulo) dentro do servidor (AVISOS_AGENDADOR=0 desliga, AVISOS_FIM_DE_SEMANA=1 inclui sábado e domingo), uma vez por dia com trava no banco; sob demanda só GESTOR (uma por vez, espera de 10 min). Resultado em fin_avisos (migration 016, só no Supabase de teste).
5. Card "Seu dia" no Dashboard: quem tem carteira e o módulo financeiro vê a carteira dele e os erros dele; GESTOR vê tudo, gera e edita vínculos; OPERACIONAL não vê nada.

Arquivos: financeiro/avisos.js, financeiro/avisos-rotas.js, financeiro/avisos-envio.js, public/avisos.js, migrations/2026-10-21_016_fin_avisos.sql, scripts/teste-avisos.js, scripts/avisos-gerar.js; uma ligação em server.js e uma linha de script em public/index.html.
Só GET no Superlógica, no máximo 2 chamadas ao mesmo tempo, teto AVISOS_MAX_CHAMADAS (padrão 4000). Ids 143, 144, 145, 160, 162 e o 167 fora.
Detalhes do teste real e da revisão em EXECUCAO/testes/T39.
