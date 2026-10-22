# T50 Certidões negativas e outros documentos na Prestação de Contas

Pedido do Matheus (22/10/2026): opção "Incluir certidões negativas" na Prestação (não obrigatória). Um campo para cada certidão, arquivos SEPARADOS (não juntar no PDF da prestação). Campo "Outros documentos" para vários PDFs que vão junto da prestação. O que der para puxar sozinho sem verificação de robô, puxa; o resto, botão "Emitir" abre o site com o CNPJ copiado (ou já preenchido se o site aceitar no link), a pessoa baixa e arrasta.

## Tipos (chave, nome na tela, link)
1. federal: "Federal (Receita e PGFN)": https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj (verificação de robô: manual)
2. estadual: "Estadual (SEFAZ ES)": https://s2-internet.sefaz.es.gov.br/certidao/cnd (a confirmar)
3. municipal: "Municipal (<cidade>)", escolhida pela cidade do endereço do condomínio:
   Serra: https://www.serra.es.gov.br/servicos#titulo (link exato a confirmar)
   Vitória: https://tributario.vitoria.es.gov.br/servicos/CertidaoNegativa/CertidaoNegativa.aspx (sem verificação na 1a tela)
   Vila Velha: https://tributacao.vilavelha.es.gov.br/tbw/loginWeb.jsp?execobj=ServicosWebSite&tab=tabCertNegCont (imagem: manual)
   Cariacica: https://sistemas.cariacica.es.gov.br/tbw/loginWeb.jsp?execobj=ServicosWebSite (verificação: manual)
4. trabalhista: "Trabalhista (TST)": https://cndt-certidao.tst.jus.br/gerarCertidao (imagem: manual)
5. fgts: "FGTS (Caixa)": https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf (SEM verificação, testado: automático)
6. falencia: "Falência e Recuperação (TJES)": https://sistemas.tjes.jus.br/certidao-negativa/emitir (sem verificação no formulário: provável automático; PJ, CNPJ, Razão Social, 1a Instância, natureza "Recuperação Judicial e Extrajudicial")

## Contrato da API (servidor, servico/certidoes.js)
Todas com requireAuth; :idSuperlogica confere a carteira (app.param já faz). Leitura do cadastro (CNPJ, nome, cidade) por superlogica/cadastro.js buscarCadastro.

GET /api/certidoes/:idSuperlogica
  { cnpj, nome, cidade, tipos: [{ tipo, nome, link, automatica }], certidoes: [{ tipo, situacao, emitida_em, validade, arquivo_nome, url, origem, atualizado_em, vencida }] }
  situacao: 'negativa' | 'positiva_com_efeito_negativa' | 'positiva' | 'desconhecida'. url = link temporário (10 min) do PDF. validade e emitida_em em AAAA-MM-DD ou null.

POST /api/certidoes/:idSuperlogica/arquivo?tipo=<tipo|auto>&nome=<arquivo.pdf>   corpo = PDF cru (application/octet-stream, até 10 MB)
  Extrai o texto (processo separado, como financeiro/entrada-pdf-worker.js), identifica o tipo (se auto), confere o CNPJ do condomínio no texto, lê situação, emissão e validade. Guarda (substitui a do mesmo tipo).
  200 { certidao: {...mesmo formato} } | 422 { erro: 'tipo_nao_identificado' | 'cnpj_diferente' | 'sem_texto' | 'tipo_diferente', detalhe }

POST /api/certidoes/:idSuperlogica/buscar  { tipo }
  Busca automática (servico/certidoes-busca.js) só para tipos automáticos; guarda como acima com origem 'automatica'.
  200 { certidao } | 409 { erro: 'manual', detalhe } | 502 { erro: 'falhou', detalhe }

DELETE /api/certidoes/:idSuperlogica/:tipo  -> { ok: true }

## Busca automática (servico/certidoes-busca.js)
module.exports = { TIPOS_AUTOMATICOS: Set, buscar: async (tipo, { cnpj, nome, cidade }) => ({ pdf: Buffer, nome_arquivo }) }  lança Error com .codigo 'manual' ou 'falhou'.
Também exporta linkPreenchido(tipo, cnpj, cidade) que devolve o link já com o CNPJ quando o site aceita, senão o link normal.

## Banco
Tabela certidoes_condominio (id_superlogica int, tipo text, situacao, emitida_em date, validade date, arquivo_nome, caminho, origem, cnpj, user_id, atualizado_em; único por id_superlogica+tipo). Bucket privado "certidoes". Migração 022, só no Supabase de teste.

## Outros documentos
Ficam no trabalho da prestação (pasta Em andamento) via Trabalhos.anexar. Teto de arquivos por trabalho sobe de 6 para 20.

## Requisitos adicionais do Matheus (20:09)
1. Incluir depois: a prestação já gerada (aberta pela pasta Em andamento ou logo após gerar) tem o botão "Incluir certidões" que abre o mesmo painel; certidões e outros documentos entram no pacote sem gerar a prestação de novo (os arquivos são separados, não precisa refazer nada).
2. Aguardando: se marcou "Incluir certidões negativas" e falta alguma, o trabalho da prestação fica na pasta com o título acrescido de " (aguardando certidões)" e o card mostra o que falta. Quando todas estiverem válidas, tira o "aguardando".
3. Reuso: certidão guardada no condomínio e ainda válida entra sozinha, sem emitir de novo. Ao abrir o painel, as automáticas faltando ou vencidas são buscadas sozinhas.
4. Alerta: certidão vencendo em até 15 dias (tipo certidao_vencendo) ou vencida (certidao_vencida) aparece no cartão "Alertas do condomínio" do Dashboard, só para condomínios que já têm certidão guardada. Gerador gerarAlertasCertidoes(banco, idSL, hoje) em servico/certidoes.js no formato de servico/regras/alertas-regras.js ({ alertas, falhas }), somado em calcularTodosAlertas no server.js; rótulo "Certidão" em public/dashboard.js (ALERTA_ROTULO).
