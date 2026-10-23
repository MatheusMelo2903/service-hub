// ============================================================
// AJUDA NA TELA: um pequeno "?" ao lado dos títulos e botões importantes de cada tela.
// Ao passar o mouse, tocar ou focar com o teclado, abre um balão escuro explicando o que
// aquilo faz. Só acrescenta o ícone; não muda o visual nem o comportamento de mais nada.
// O catálogo AJUDA diz onde cada ícone entra (seletor CSS) e o texto do balão. Telas e
// partes criadas depois por outros scripts recebem o ícone sozinhas: o documento é
// observado (com espera curta para juntar várias mudanças) e o que já tem ícone é pulado.
// Carregado por último no index.html, depois de menu-grupos.js.
// ============================================================
(function () {
  'use strict';

  // onde: 'dentro' (no fim do próprio alvo, o padrão), 'depois' (logo depois do alvo, para
  // botões), 'titulo' (no título do cartão que contém o alvo) e 'anterior' (dentro do
  // elemento que vem antes do alvo). todos: true põe o ícone em todos os alvos achados.
  var AJUDA = {
    // Topo
    emAndamento: {
      alvo: '#trab-botao', onde: 'depois', assunto: 'Em andamento',
      texto: 'Guarda os trabalhos longos que você começou (atas, prestações, previsões e revisões de unidades) para não perder ao fechar a janela, recarregar ou trocar de computador. Clique em Abrir para continuar de onde parou. O trabalho só sai daqui quando você clica em Encerrar ou depois de 7 dias sem mexer.'
    },

    // Dashboard
    dashCondAtivo: {
      alvo: '#dash-cond-seletor', onde: 'anterior', assunto: 'Condomínio ativo',
      texto: 'Escolha aqui o condomínio em que você vai trabalhar. A troca vale para o Hub inteiro: o seletor do topo e as outras telas passam a usar o mesmo condomínio. Cadastrar novo condomínio só traz para o Hub um condomínio que já existe no Superlógica, pelo código dele.'
    },
    dashSeuDia: {
      alvo: '#avisos-seu-dia .card-title', assunto: 'Seu dia',
      texto: 'Resumo da manhã da sua carteira, por gravidade: contas sem extrato, pré balancete, conciliação, contas vencidas e boletos, além dos erros achados nos lançamentos feitos por você. Ele sai sozinho às 7h dos dias úteis. Aqui é só consulta; nada é alterado no Superlógica.'
    },
    dashAlertas: {
      alvo: '#alertas-card .card-title', assunto: 'Alertas do condomínio',
      texto: 'Avisos do condomínio ativo: contas a vencer, saldo baixo, despesas recorrentes ainda não lançadas, despesas sem nota fiscal, certidões e mandatos vencendo, entre outros. Atualizar lê tudo de novo e ver resolvidos mostra também os que já foram resolvidos.'
    },
    dashSaldoMin: {
      alvo: '#alertas-saldo-min', onde: 'depois', assunto: 'Saldo mínimo',
      texto: 'Valor mínimo de saldo para o condomínio ativo. Quando o saldo ficar abaixo dele, aparece o alerta de saldo baixo. Clique em Salvar limite para gravar; para desligar, apague o valor e salve.'
    },

    // Central de alertas
    caTitulo: {
      alvo: '#panel-centralalertas .card-title', assunto: 'Alertas da carteira',
      texto: 'Todos os alertas da sua carteira numa tela só, separados por área, como Financeiro, Operacional e Documentos e jurídico. Clique em uma área para ver só ela e use os filtros de tipo, condomínio, gravidade e situação (novo, visto, resolvido).'
    },
    caMeus: {
      alvo: '#ca-meus', onde: 'depois', assunto: 'Meus alertas',
      texto: 'Escolha quais alertas você quer ver: por tipo, por área inteira ou pausando todos. Desligar só esconde para você; o alerta continua sendo gerado e aparece para o resto da equipe.'
    },
    caSilenciados: {
      alvo: '#ca-silenciados', onde: 'depois', assunto: 'Silenciados',
      texto: 'Mostra, apagados, os alertas que você desligou em Meus alertas. Serve para conferir o que está escondido sem precisar ligar de novo.'
    },

    // Financeiro
    finQuadro: {
      alvo: '#panel-fincontrole .card-title', assunto: 'Quadro da carteira',
      texto: 'Cada condomínio da carteira com a quantidade de alertas por gravidade, o valor em alta e os principais problemas, do mais grave para o menos grave. Clique em um condomínio para ver os alertas dele, o pré balancete e o fechamento do mês. Só consulta: nada é alterado no Superlógica.'
    },
    finPre: {
      alvo: '[data-fin-aba="pre"]', onde: 'depois', assunto: 'Pré balancete',
      texto: 'Mostra o que impede fechar o mês escolhido: despesas pagas sem comprovante ou sem nota, vencidas sem baixa, lançadas depois do vencimento e mudanças suspeitas. Itens de gravidade baixa ficam só para conferir.'
    },
    finFechamento: {
      alvo: '[data-fin-aba="fechamento"]', onde: 'depois', assunto: 'Fechamento do mês',
      texto: 'Lista do que precisa estar certo antes de gerar o balancete: conciliação do mês com diferença zero, extrato até o último dia útil, pré balancete sem pendência, boletos e anexos conferidos. Cada item mostra onde resolver.'
    },

    // Boletos
    bolTitulo: {
      alvo: '#panel-boletos .card-title', assunto: 'Conferência dos boletos',
      texto: 'Confere os boletos do condomínio ativo no mês de vencimento escolhido, comparando cada unidade com os 3 meses anteriores. Use depois de gerar os boletos e antes de enviar aos condôminos.'
    },
    bolConferir: {
      alvo: '#fin-bol-conferir', onde: 'depois', assunto: 'Conferir boletos',
      texto: 'Lê os boletos no Superlógica e lista só o que fugiu do padrão, por gravidade. Não altera nem envia nenhum boleto.'
    },

    // Conciliação
    concTitulo: {
      alvo: '#panel-conciliacao .card-title', assunto: 'Conciliação da carteira',
      texto: 'Para cada condomínio e conta da carteira: último dia com extrato, dias sem extrato, dias não conciliados e diferença de saldo. Usa o extrato que a equipe já importou no Superlógica, dos últimos 75 dias. Clique em um condomínio para ver o detalhe.'
    },
    concAtivo: {
      alvo: '#panel-conciliacao button[onclick="finConcAbrirAtivo()"]', onde: 'depois', assunto: 'Condomínio ativo na conciliação',
      texto: 'Abre direto a conciliação do condomínio escolhido no topo: itens do banco sem lançamento, lançamentos sem saída no banco, valores diferentes e regras automáticas sugeridas.'
    },
    concOfx: {
      alvo: '#fin-conc-ofx-comparar', onde: 'depois', assunto: 'Comparar arquivo OFX',
      texto: 'Compara o arquivo OFX baixado do banco com o que já está no Superlógica, antes de importar: mostra o que já foi importado, o que é novo e se o novo já tem lançamento. O arquivo é lido aqui na tela e não é enviado a lugar nenhum.'
    },

    // Entrada de documentos
    entTitulo: {
      alvo: '#panel-entrada .card-title', assunto: 'Entrada de documentos',
      texto: 'Suba boletos, notas e guias em PDF, vários de uma vez. O Hub lê os dados, acha o condomínio e o fornecedor pelo CNPJ e confere no Superlógica se já existe lançamento parecido. Cada documento vira um rascunho na Fila.'
    },
    entFila: {
      alvo: '#ent-fila', onde: 'titulo', assunto: 'Fila',
      texto: 'Rascunhos são os documentos lidos que ainda precisam ser conferidos; Lançados são os que já viraram despesa. Clique em um item para conferir e corrigir os dados antes de lançar.'
    },
    entLancar: {
      alvo: '#ent-lancar', onde: 'depois', assunto: 'Lançar documento',
      texto: 'Lança a despesa no Superlógica com o PDF anexado, depois que você confere os dados. Os itens em amarelo precisam ser resolvidos antes.'
    },

    // Apresentação de assembleia
    aprTitulo: {
      alvo: '#panel-apresentacao .card-title', assunto: 'Apresentação de assembleia',
      texto: 'Monta os slides da assembleia na ordem da pauta do edital, com os orçamentos, comparativos, forma de custeio e fotos. Anexe o edital, os documentos e as fotos, escreva o que você precisa e clique em Gerar. No fim saem o PowerPoint e o PDF, com a lista do que conferir antes de apresentar.'
    },
    aprEdital: {
      alvo: '#apr-titulo-edital', assunto: 'Edital',
      texto: 'O PDF do edital de convocação (ou o texto colado). Dele saem os itens da pauta, na mesma ordem e com a mesma redação. Os itens encontrados aparecem logo abaixo para você conferir.'
    },
    aprDocs: {
      alvo: '#apr-titulo-docs', assunto: 'Documentos',
      texto: 'Orçamentos, projetos, laudos e outras apresentações em PDF ou PowerPoint. O texto e as imagens de cada página são lidos aqui na tela. As imagens úteis viram fotos que podem entrar nos slides; logos e ícones repetidos ficam de fora. Até 30 documentos, 25 MB cada.'
    },
    aprFotos: {
      alvo: '#apr-titulo-fotos', assunto: 'Fotos',
      texto: 'Fotos da situação atual, do que se propõe, de produtos ou de obras. Escreva embaixo de cada foto a que ela se refere (ex.: situação atual do playground): é isso que diz em qual item da pauta ela entra.'
    },
    aprPedido: {
      alvo: '#apr-titulo-pedido', assunto: 'O que você precisa',
      texto: 'Diga com suas palavras o que a apresentação precisa ter: a data, o que destacar, a forma de pagamento, o que tirar. Quanto mais claro, menos ajuste depois.'
    },
    aprGerar: {
      alvo: '#apr-gerar', onde: 'depois', assunto: 'Gerar apresentação',
      texto: 'Confere as imagens dos documentos, monta o roteiro e desenha os slides. Leva alguns minutos. No fim baixa o PowerPoint e o PDF e guarda os dois na pasta Em andamento.'
    },

    // Cobrança
    cobTitulo: {
      alvo: '#panel-cobranca .card-title', assunto: 'Inadimplência por carteira',
      texto: 'Inadimplência de cada condomínio da carteira: unidades em atraso, valor em aberto, valor corrigido com juros e multa e quantas estão sem contato há 90 dias. Clique em Ver unidades para abrir o detalhe de um condomínio.'
    },
    cobUnidades: {
      alvo: '#cob-unidades .card-title', assunto: 'Unidades em atraso',
      texto: 'Cada unidade em atraso mostra o último contato registrado na cobrança do Superlógica. Simular acordo calcula as parcelas e monta um texto pronto para enviar, sem criar o acordo. A 2ª via gera um boleto atualizado no Superlógica e só aparece para quem tem essa permissão.'
    },

    // Importar Despesas
    despCarregar: {
      alvo: '#tab-upload .card-title', assunto: 'Carregar planilha de despesas',
      texto: 'Primeiro passo: escolha a planilha de despesas (.xlsx, .xls ou .csv) do condomínio ativo. Depois você liga as colunas aos campos, confere os dados e só então envia.'
    },
    despMapear: {
      alvo: '#tab-mapeamento .card-title', assunto: 'Mapear colunas',
      texto: 'Diga qual coluna da sua planilha corresponde a cada campo do Superlógica. Em seguida clique em Validar dados para ver o que está certo e o que tem erro.'
    },
    despEnviar: {
      alvo: '#btn-enviar', onde: 'depois', assunto: 'Enviar despesas',
      texto: 'Lança no Superlógica só as linhas válidas, no condomínio ativo. Antes de gravar, o Hub pede a sua confirmação e confere de novo duplicidades e fornecedores; se achar algum problema, trava o envio inteiro.'
    },

    // Importar Unidades
    uniNormalizar: {
      alvo: '#panel-unidades .card-title', assunto: 'Documento fora do padrão',
      texto: 'Opcional. Transforma um documento fora do padrão (PDF, Word, planilha, texto ou foto) na planilha de 26 colunas do Superlógica e marca o que ficou em dúvida para você corrigir. Nada vai para o Superlógica sem a sua confirmação.'
    },
    uniRevisao: {
      alvo: '#revisao-unidades .card-title', assunto: 'Revisão de papéis',
      texto: 'Confira quem é Proprietário, Inquilino ou Dependente em cada linha antes de importar. Linhas marcadas como Descartar não são enviadas.'
    },
    uniEnviar: {
      alvo: '#btn-enviar-uni', onde: 'depois', assunto: 'Enviar unidades',
      texto: 'Cria no Superlógica as unidades da prévia, com proprietários, inquilinos e dependentes, no condomínio ativo. O Hub pede a sua confirmação antes de gravar, e o botão Parar interrompe no meio.'
    },

    // Ficha do Condomínio
    fichaRelatorio: {
      alvo: '#rel-btn', onde: 'titulo', assunto: 'Relatório mensal do síndico',
      texto: 'Gera um PDF para o síndico com o mês escolhido: saldo do mês, saldo por conta, receitas e despesas, inadimplência, contas a pagar em 30 dias e alertas em aberto. Tudo é lido do Superlógica; o que não vier aparece como não disponível.'
    },
    fichaBusca: {
      alvo: '#ficha-busca', onde: 'titulo', assunto: 'Buscar unidade',
      texto: 'Procura uma unidade em todos os condomínios pelo nome, CPF ou CNPJ, ou pelo número da unidade. Você só vê resultados dos condomínios da sua carteira.'
    },
    fichaAuditoria: {
      alvo: '#ficha-btn-auditoria', onde: 'titulo', assunto: 'Auditoria do cadastro',
      texto: 'Confere o cadastro das unidades do condomínio ativo: quem está sem CPF ou CNPJ, sem email ou sem telefone, e se a soma das frações ideais fecha 100%. Só mostra; não corrige nada no Superlógica.'
    },

    // Prestação de Contas
    prestGerar: {
      alvo: '#prest-btn-superlogica', onde: 'titulo', assunto: 'Gerar a prestação',
      texto: 'Puxa do Superlógica os dados do período escolhido e gera a prestação de contas em PDF, PowerPoint ou os dois. O trabalho fica guardado na pasta Em andamento. Nada é publicado para os condôminos.'
    },
    prestObservacoes: {
      alvo: '#prest-observacoes', onde: 'anterior', assunto: 'Observações da prestação',
      texto: 'Opcional. Use para explicar ou dar ênfase aos números. Se houve déficit, obra, compra fora da previsão ou uso do fundo de reserva, explique aqui o motivo, que ele aparece na apresentação junto do número. Exemplo: a reforma do salão foi aprovada na assembleia de março e paga com o fundo de reserva.'
    },
    prestCertidoes: {
      alvo: '#panel-prestacao .cert-chk', todos: true, assunto: 'Certidões negativas',
      texto: 'Junta as certidões negativas do condomínio à prestação, cada uma em um arquivo separado. As já guardadas e válidas entram sozinhas; as que faltam o Hub tenta buscar, e para as outras abre o site com o CNPJ copiado para você baixar o PDF e arrastar aqui.'
    },
    prestOutros: {
      alvo: '#panel-prestacao .cert-sec', todos: true, assunto: 'Outros documentos',
      texto: 'Opcional. Junte atas, contratos, laudos ou outros PDFs à prestação. Eles vão em arquivos separados e ficam guardados com o trabalho na pasta Em andamento.'
    },

    // Previsão Orçamentária (a tela é um módulo embutido; o ícone fica na faixa do condomínio)
    prevModulo: {
      alvo: '#banner-cond-previsao .banner-cond-rotulo', assunto: 'Previsão Orçamentária',
      texto: 'Monta a previsão orçamentária do condomínio escolhido aqui: importe os relatórios ou a planilha final, confira os valores e gere a apresentação. O trabalho fica guardado na pasta Em andamento e nada é enviado ao Superlógica.'
    },

    // Atas
    ataDocs: {
      alvo: '#ata-docs-card .card-title', assunto: 'Edital e apresentação',
      texto: 'Anexe o edital para o Hub completar a data, o local, o tipo da assembleia e a pauta. Se quiser, anexe também a apresentação, a prestação ou os orçamentos mostrados na reunião, em PDF ou PowerPoint, para a ata usar os números e nomes certos.'
    },
    ataTranscricao: {
      alvo: '#ata-transcricao', onde: 'titulo', assunto: 'Transcrição da reunião',
      texto: 'Envie o áudio da reunião para o Hub transcrever, ou importe um arquivo .txt com a transcrição pronta. O texto aparece no campo abaixo e pode ser corrigido antes de gerar a ata.'
    },
    ataGerar: {
      alvo: '#btn-gerar-ata', onde: 'depois', assunto: 'Gerar ata',
      texto: 'Monta o texto da ata com os dados do condomínio, o edital, a transcrição e os participantes. A ata abre para revisão e pode ser baixada em PDF ou Word; campos com [a confirmar] precisam ser preenchidos por você. Arquivar no Superlógica é um passo separado.'
    },

    // Comunicados e Multas (uma ajuda por aba interna)
    regNotificacao: {
      alvo: '#regras-notificacao .card-title', assunto: 'Notificações e multas',
      texto: 'Escolha a unidade e conte o que aconteceu: o Hub sugere advertência ou multa conforme as regras do condomínio e monta a carta citando só o que foi conferido nos documentos. Registrar no Superlógica só acontece com a confirmação marcada na tela.'
    },
    regComunicados: {
      alvo: '#regras-comunicados .card-title', assunto: 'Comunicados',
      texto: 'Escreva o assunto e os detalhes e o Hub monta o texto do comunicado no padrão, para você revisar na prévia. Publicar no Superlógica só acontece depois que você marca a confirmação.'
    },
    regConsulta: {
      alvo: '#regras-consulta .card-title', assunto: 'Consultar regras',
      texto: 'Pergunte sobre a convenção e o regimento do condomínio ativo. Toda resposta mostra o artigo e o trecho conferido nos documentos; quando não acha, o Hub diz que não achou. Também dá para comparar condomínios e ver as perguntas frequentes.'
    },
    regDocumentos: {
      alvo: '#ra-titulo', assunto: 'Documentos',
      texto: 'Convenção, regimento, regulamentos e atas do condomínio ativo, separados por ano. O selo vale hoje mostra a versão em vigor; aqui você abre o PDF, vê os artigos e envia documento novo.'
    },
    regMandatos: {
      alvo: '#regras-mandatos .card-title', assunto: 'Mandatos',
      texto: 'Mandatos de síndico e conselho tirados das atas, com a data de fim e a situação. Você pode ler de novo as atas guardadas, marcar como conferido e corrigir o nome ou a data de fim.'
    },

    // Comparativo
    cmpTitulo: {
      alvo: '#panel-comparativo .card-title', assunto: 'Custo por unidade',
      texto: 'Compara o custo por unidade dos condomínios da carteira, mês a mês, nos últimos 12 meses fechados: total, pessoal, água, energia e gás. Só consulta.'
    },
    cmpFornecedores: {
      alvo: '#panel-comparativo button[onclick="comparativoFornecedores()"]', onde: 'depois', assunto: 'Comparar fornecedores',
      texto: 'Mostra os fornecedores pagos em dois ou mais dos condomínios carregados, com a média por mês e por unidade em cada um. Ajuda a ver quem paga mais pelo mesmo serviço.'
    },

    // Leitura de Consumo
    conFotos: {
      alvo: '#panel-consumo .card-title', assunto: 'Fotos dos medidores',
      texto: 'Envie de uma vez as fotos dos medidores de água ou gás do condomínio ativo. O Hub lê o número e a unidade em cada foto e compara com a última leitura do Superlógica. Dica: fotografe a etiqueta da unidade junto ou dê à foto o nome da unidade.'
    },
    conConferencia: {
      alvo: '#consumo-results .card-title', assunto: 'Conferência das leituras',
      texto: 'Confira cada leitura antes de lançar. As que têm suspeita (menor que a anterior, salto alto, já lançada) não vêm marcadas: você decide depois de olhar a foto.'
    },
    conLancar: {
      alvo: '#btn-lancar-consumo', onde: 'depois', assunto: 'Lançar leituras',
      texto: 'Grava no Superlógica apenas as leituras marcadas, junto com a foto, depois que você confirma.'
    },

    // Configurações
    cfgUsuarios: {
      alvo: '#card-usuarios-admin .card-title', assunto: 'Gestão de usuários',
      texto: 'Lista quem tem acesso ao Hub, com o cargo e quantos módulos cada pessoa vê. Aqui você edita permissões, bloqueia ou remove um usuário. O cargo GESTOR tem acesso total e não pode ser alterado.'
    },
    cfgConvidar: {
      alvo: '#card-usuarios-admin button[onclick="abrirModalConvidar()"]', onde: 'depois', assunto: 'Convidar usuário',
      texto: 'Manda um email para a pessoa criar a senha e entrar no Hub como OPERACIONAL ou GERENTE. Depois, ajuste o que ela pode ver em Editar permissões.'
    },
    cfgPermissoes: {
      alvo: '#perms-titulo', assunto: 'Permissões',
      texto: 'Marque os módulos que a pessoa vê e o que ela pode fazer em cada um, e a carteira de condomínios dela (sem nenhuma marcada, ela vê todos). Nada muda até você clicar em Salvar permissões.'
    }
  };
  window.AJUDA = AJUDA;

  var MARGEM = 8;      // distância mínima da borda da tela
  var ESPERA = 150;    // espera para juntar várias mudanças da tela antes de procurar alvos
  var FECHAR_EM = 160; // tempo para o mouse sair do ícone e chegar ao balão sem fechar

  // 1. Estilo próprio (prefixo aj). Seletores reforçados para não herdar o estilo de botão
  // de quem recebe o ícone (por exemplo a faixa do condomínio ativo).
  (function estilo() {
    if (document.getElementById('aj-estilo')) return;
    var st = document.createElement('style');
    st.id = 'aj-estilo';
    st.textContent = [
      'button.aj-btn.aj-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:16px;height:16px;min-width:0;margin:0 0 0 6px;padding:0;border:1px solid #CDD4DE;border-radius:50%;background:#EEF1F6;color:#8892A4;font:700 10px/1 var(--sans, sans-serif);text-transform:none;letter-spacing:0;vertical-align:middle;cursor:help;opacity:1;box-shadow:none;transition:color .15s,background-color .15s,border-color .15s}',
      'button.aj-btn.aj-btn::before{content:"?"}',
      // Área de toque maior que o desenho, para acertar o dedo no celular.
      'button.aj-btn.aj-btn::after{content:"";position:absolute;inset:-7px}',
      'button.aj-btn.aj-btn:hover,button.aj-btn.aj-btn.aj-aberto{background:var(--gs-blue, #3B9AC7);border-color:var(--gs-blue, #3B9AC7);color:#fff;opacity:1}',
      'button.aj-btn.aj-btn:focus-visible{outline:2px solid var(--gs-blue, #3B9AC7);outline-offset:2px}',
      'button.aj-btn.aj-btn[hidden]{display:none}',
      '#aj-camada{position:fixed;top:0;left:0;width:0;height:0;z-index:10050}',
      '.aj-balao{position:fixed;top:0;left:0;box-sizing:border-box;width:max-content;max-width:min(320px, calc(100vw - 16px));padding:10px 12px;border-radius:8px;background:#15191F;color:#fff;font:400 14px/1.45 var(--sans, sans-serif);text-align:left;text-transform:none;letter-spacing:normal;white-space:normal;overflow-wrap:break-word;box-shadow:0 8px 24px rgba(0,0,0,.22);opacity:0;transition:opacity .12s ease}',
      '.aj-balao.aj-visivel{opacity:1}',
      '.aj-balao[hidden]{display:none}',
      // Setinha apontando para o ícone (embaixo quando o balão abre por cima).
      '.aj-balao::before{content:"";position:absolute;left:var(--aj-seta, 16px);top:-5px;width:10px;height:10px;margin-left:-5px;background:#15191F;transform:rotate(45deg)}',
      '.aj-balao.aj-acima::before{top:auto;bottom:-5px}',
      '@media (prefers-reduced-motion: reduce){button.aj-btn.aj-btn,.aj-balao{transition:none}}'
    ].join('\n');
    document.head.appendChild(st);
  })();

  // Camada onde ficam os balões, fora dos cartões (assim nenhum corte de rolagem esconde o balão).
  function camada() {
    var c = document.getElementById('aj-camada');
    if (!c) {
      c = document.createElement('div');
      c.id = 'aj-camada';
      document.body.appendChild(c);
    }
    return c;
  }

  // 2. Abrir, fechar e posicionar. Só um balão aberto por vez.
  var atual = null;        // { btn, balao, fixo }
  var timerFechar = null;
  var seq = 0;
  var mouseSobre = false;  // mouse em cima do ícone ou do balão aberto

  function cancelarFechar() { if (timerFechar) { clearTimeout(timerFechar); timerFechar = null; } }

  function posicionar() {
    if (!atual) return;
    var btn = atual.btn, b = atual.balao;
    if (!btn.isConnected) { fechar(); return; }
    var r = btn.getBoundingClientRect();
    var vw = document.documentElement.clientWidth || window.innerWidth;
    var vh = document.documentElement.clientHeight || window.innerHeight;
    var w = b.offsetWidth, h = b.offsetHeight;
    var centro = r.left + r.width / 2;
    // Começa um pouco à esquerda do ícone e é empurrado para dentro da tela se precisar.
    var left = Math.max(MARGEM, Math.min(centro - 16, vw - w - MARGEM));
    var top = r.bottom + 8;
    var acima = false;
    if (top + h > vh - MARGEM && r.top - 8 - h >= MARGEM) { top = r.top - 8 - h; acima = true; }
    b.style.left = Math.round(left) + 'px';
    b.style.top = Math.round(top) + 'px';
    b.style.setProperty('--aj-seta', Math.round(Math.max(10, Math.min(w - 10, centro - left))) + 'px');
    b.classList.toggle('aj-acima', acima);
  }

  function abrir(btn, fixo) {
    cancelarFechar();
    var b = document.getElementById(btn.getAttribute('aria-describedby'));
    if (!b) return;
    if (atual && atual.btn === btn) { if (fixo) atual.fixo = true; return; }
    fechar();
    atual = { btn: btn, balao: b, fixo: !!fixo };
    btn.classList.add('aj-aberto');
    b.hidden = false;
    posicionar();
    // Um quadro depois, para a transição de opacidade acontecer (sem efeito com movimento reduzido).
    requestAnimationFrame(function () { if (atual && atual.balao === b) b.classList.add('aj-visivel'); });
  }

  function fechar() {
    cancelarFechar();
    if (!atual) return;
    atual.btn.classList.remove('aj-aberto');
    atual.balao.classList.remove('aj-visivel');
    atual.balao.hidden = true;
    atual = null;
  }

  function fecharDepois() {
    if (!atual || atual.fixo) return;
    cancelarFechar();
    timerFechar = setTimeout(fechar, FECHAR_EM);
  }

  // 3. O ícone: botão de verdade (teclado e leitor de tela), descrito pelo próprio balão.
  function criarIcone(chave, item) {
    var id = 'aj-balao-' + chave + '-' + (++seq);
    var b = document.createElement('div');
    b.className = 'aj-balao';
    b.id = id;
    b.setAttribute('role', 'tooltip');
    b.hidden = true;
    b.textContent = item.texto;
    b.addEventListener('mouseenter', function () { mouseSobre = true; cancelarFechar(); });
    b.addEventListener('mouseleave', function () { mouseSobre = false; fecharDepois(); });
    camada().appendChild(b);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aj-btn';
    btn.setAttribute('data-aj', chave);
    btn.setAttribute('aria-label', 'Ajuda: ' + (item.assunto || chave));
    btn.setAttribute('aria-describedby', id);
    btn.addEventListener('mouseenter', function () { mouseSobre = true; abrir(btn, false); });
    btn.addEventListener('mouseleave', function () { mouseSobre = false; fecharDepois(); });
    btn.addEventListener('focus', function () { abrir(btn, false); });
    // Saiu com o teclado: fecha. Se o mouse ainda está em cima, quem fecha é a saída do mouse.
    btn.addEventListener('blur', function () { if (atual && atual.btn === btn && !mouseSobre) fechar(); });
    btn.addEventListener('click', function (ev) {
      // Não deixa o clique abrir ou fechar o que está em volta (resumo recolhível, rótulo de caixa).
      ev.preventDefault();
      if (atual && atual.btn === btn && atual.fixo) fechar();
      else abrir(btn, true);
    });
    return btn;
  }

  // 4. Aplica os ícones nos alvos que existem agora.
  function anfitrioes(item) {
    var achados;
    try { achados = item.todos ? Array.prototype.slice.call(document.querySelectorAll(item.alvo)) : [document.querySelector(item.alvo)]; }
    catch (e) { return []; }
    return achados.filter(Boolean).map(function (el) {
      if (item.onde === 'titulo') {
        var card = el.closest ? el.closest('.card') : null;
        return card ? { el: card.querySelector('.card-title'), modo: 'dentro' } : null;
      }
      if (item.onde === 'anterior') return { el: el.previousElementSibling, modo: 'dentro' };
      return { el: el, modo: item.onde === 'depois' ? 'depois' : 'dentro' };
    }).filter(function (x) { return x && x.el; });
  }

  function iconeDe(alvo, modo, chave) {
    if (modo === 'depois') {
      var prox = alvo.nextElementSibling;
      return prox && prox.classList.contains('aj-btn') && prox.getAttribute('data-aj') === chave ? prox : null;
    }
    for (var i = 0; i < alvo.children.length; i++) {
      var f = alvo.children[i];
      if (f.classList.contains('aj-btn') && f.getAttribute('data-aj') === chave) return f;
    }
    return null;
  }

  // Ícone que fica ao lado de um botão escondido some junto com ele.
  function escondido(el) {
    if (el.hidden) return true;
    var d = el.style && el.style.display;
    if (d === 'none') return true;
    try { return window.getComputedStyle(el).display === 'none'; } catch (e) { return false; }
  }

  var aplicando = false;
  function aplicar() {
    aplicando = true;
    try {
      Object.keys(AJUDA).forEach(function (chave) {
        var item = AJUDA[chave];
        anfitrioes(item).forEach(function (a) {
          var icone = iconeDe(a.el, a.modo, chave);
          if (!icone) {
            icone = criarIcone(chave, item);
            if (a.modo === 'depois') a.el.insertAdjacentElement('afterend', icone);
            else a.el.appendChild(icone);
          }
          if (a.modo === 'depois') {
            var esc = escondido(a.el);
            if (icone.hidden !== esc) icone.hidden = esc;
          }
        });
      });
      // Balões de ícones que saíram da tela (a parte foi redesenhada) vão embora também.
      var c = document.getElementById('aj-camada');
      if (c) Array.prototype.slice.call(c.children).forEach(function (b) {
        if (!document.querySelector('.aj-btn[aria-describedby="' + b.id + '"]')) {
          if (atual && atual.balao === b) atual = null;
          b.remove();
        }
      });
      if (atual && (!atual.btn.isConnected || atual.btn.hidden)) fechar();
    } finally {
      if (observador) observador.takeRecords();
      aplicando = false;
    }
  }

  // 5. Observa a tela: outros scripts criam e redesenham partes o tempo todo.
  var timerAplicar = null;
  function agendar() {
    if (timerAplicar) return;
    timerAplicar = setTimeout(function () { timerAplicar = null; aplicar(); }, ESPERA);
  }
  function ehNosso(n) {
    return n && n.nodeType === 1 && (n.classList.contains('aj-btn') || n.classList.contains('aj-balao') || n.id === 'aj-camada');
  }
  function importa(m) {
    var t = m.target;
    if (t && t.nodeType !== 1) t = t.parentNode;
    if (!t || ehNosso(t) || (t.closest && t.closest('#aj-camada'))) return false;
    if (m.type === 'childList') {
      var nos = Array.prototype.slice.call(m.addedNodes).concat(Array.prototype.slice.call(m.removedNodes));
      return nos.some(function (n) { return n.nodeType === 1 && !ehNosso(n); });
    }
    return true;
  }
  var observador = new MutationObserver(function (lista) {
    if (aplicando) return;
    for (var i = 0; i < lista.length; i++) if (importa(lista[i])) { agendar(); return; }
  });

  function iniciar() {
    aplicar();
    observador.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden'] });
  }

  // 6. Fechar: Esc, clique fora, rolagem e mudança de tamanho reposicionam.
  document.addEventListener('keydown', function (ev) {
    if ((ev.key === 'Escape' || ev.key === 'Esc') && atual) {
      ev.stopPropagation();
      fechar();
    }
  }, true);
  // pointerdown (e não click) para o toque fora também fechar no celular.
  document.addEventListener('pointerdown', function (ev) {
    if (!atual) return;
    var t = ev.target;
    if (t && t.closest && (t.closest('.aj-btn') || t.closest('.aj-balao'))) return;
    fechar();
  });
  var quadro = null;
  function reposicionar() {
    if (!atual || quadro) return;
    quadro = requestAnimationFrame(function () { quadro = null; posicionar(); });
  }
  window.addEventListener('scroll', reposicionar, true);
  window.addEventListener('resize', reposicionar);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
