# Changelog Service Hub

## 2026-06-30 — Refino de parentesco por ligacao ao titular + regra especial de irma/irmao

### Adicionado / Alterado
- `public/index.html`: deteccao de parentesco ligada ao titular (nao ao acento). `marcacaoInquilino` reconhece parente por possessivo "do/da inquilino" (qualquer termo antes, ex "amiga do inquilino") ou grau de parentesco adjacente a inquilino com `\s+` sem hifen (o hifen protege "IRMA - INQUILINA"). Texto normalizado remove acento, entao "irmã"/"irma" e "proprietária"/"proprietaria" caem no mesmo termo. Constantes de modulo `_PARENTESCO`, `_PARENTESCO_LIGADO_INQ_RE`, `_PARENTESCO_LIGADO_PROP_RE`, `_SO_PARENTESCO_RE`.
- `parenteDeProprietario` (Passo 8): parente do dono ("irmao da proprietaria", "amiga da proprietaria") vira Dependente, sem confundir com a propria dona ("MAYARA - PROPRIETARIA").
- `nomeSoParentesco` (Passo 9): campo so com grau de parentesco, sem nome nem ligacao, cai incerto.
- REGRA ESPECIAL de irma/irmao (Passo 10, decisao do Matheus): a palavra (com/sem acento, com/sem hifen, normalizada, `\b` nas pontas) e SEMPRE parentesco -> Dependente, sem exigir ligacao. Campo literalmente so "irma"/"irmao" -> incerto. Consequencia aceita: "Inquilino - IRMA" textual vira Dependente (a palavra vence). `ehTitularDeclarado` protege titular declarado pela coluna Tipo (Proprietario/Inquilino/Locatario chamado "Irma") nos Passos 9 e 10, para nao deixar a unidade sem titular.
- `tests/regressao-w045a-recreio.js` e `docs/REGRESSAO-W045A-RECREIO.md`: atualizados com os casos de ligacao, irma/irmao e as protecoes de titular declarado (30 casos).

### Validado
- Revisor: REPROVADO na primeira passada, corrigido e revalidado. Bloqueador (Passo 10 rebaixava inquilino declarado chamado "Irma") tratado estendendo a protecao de titular declarado a Inquilino/Locatario, mantendo a decisao do Matheus de que a marcacao textual "Inquilino - Irma" vira Dependente. Moderados corrigidos: `qualificadorPapel` sem "irma"; branch morta em `parenteDeProprietario`; Passos 9/10 sem proteger Tipo declarado.
- Auditor de seguranca: APROVADO. Bug funcional corrigido: regex literais com `\\b`/`\\s` (barra dupla) viravam dead code; trocado por `\b`/`\s` para o possessivo disparar. Sem ReDoS, sem token, sem PII em log.
- Validador: teste de regressao 100% verde. Agregado do Recreio IDENTICO ao anterior (papel 577/114/558/8, conf 1113/121/23), 7 unidades inalteradas, 1257 contatos, 0 proprietario duplicado.

### Arquivos modificados
- `public/index.html`, `tests/regressao-w045a-recreio.js`, `docs/REGRESSAO-W045A-RECREIO.md`

---

## 2026-06-30 — Regra textual de inquilino no W045A + teste de regressao do Recreio

### Adicionado
- `public/index.html`: regra geral (nao lista fixa de condominio) para condominios que NAO usam a coluna Tipo para inquilino e marcam "inquilino"/"inquilina" dentro do nome do contato. `marcacaoInquilino` classifica o nome em titular (a palavra qualifica a pessoa, ex "Inquilino - JONAS", "LUANNA - INQUILINA"), parente (construcao de parentesco, ex "cunhada do inquilino", "sogra inquilino" -> vira Dependente) ou null. `qualificadorPapel` le o qualificador entre parenteses (Marido/Esposa/Titular vs Filho/Filha/Dependente) para desempatar. O "Passo 7" de `inferirPapeis` aplica: um candidato -> Inquilino e parentes -> Dependente; varios candidatos resolve so com qualificador 100% claro (um titular e todos os demais com qualificador de dependente presente), senao INCERTA; parentes sem titular claro -> INCERTA. Nunca chuta o titular. A marcacao sobrepoe a inferencia e rebaixa inquilinos inferidos, mas preserva quem veio das colunas Tipo Inquilino/Locatario.
- `extrairContatosW045APdf`: passa a capturar a continuacao alfabetica do nome (variavel `nomeCont`), onde fica o qualificador "INQUILINO" quando o nome quebra em outra linha (ex 401 B "TALYTA PESSOA - CUNHADA DO" + "INQUILINO"; 404 F "LUANNA ..." + "INQUILINA").
- `tests/regressao-w045a-recreio.js` e `docs/REGRESSAO-W045A-RECREIO.md`: teste de regressao reexecutavel (extrai as funcoes reais de index.html) e documentacao das 7 unidades de teste (208 A, 401 B, 804 B, 806 D, 404 F, 406 H, 503 H) mais os casos-limite. O PDF nao fica no repo (LGPD); o teste pula a parte de PDF se ele nao for informado.

### Validado
- Revisor: APROVADO apos correcoes (guard de `rebaixarInferidos` que nao cobria "Locatario"; colisao do nome proprio "Irma" com o regex de parentesco direto; `qualificadorPapel` que so lia o primeiro parentese). Regex de parentesco direto reduzida a termos inequivocos e hoisted para o modulo (recomendacao do auditor).
- Auditor de seguranca: APROVADO (sem ReDoS — regex montada de termos fixos, nome so e testado nunca concatenado na regex; XSS coberto por esc; sem token; nada sai do navegador).
- Validador: teste de regressao passa 100% (11 casos-limite + 4 agregados + 7 unidades). 1257 contatos, 577 unidades, 0 proprietario duplicado, 0 nome vazio. Resultado das 7 unidades conforme aprovado pelo Matheus.

### Arquivos modificados
- `public/index.html`, `tests/regressao-w045a-recreio.js` (novo), `docs/REGRESSAO-W045A-RECREIO.md` (novo)

---

## 2026-06-30 — Importar Unidades Fase 2: parser de PDF por codigo (W045A posicional) + arquitetura codigo-primeiro

### Adicionado
- `public/index.html`: extracao de PDF 100% por codigo no navegador com `pdfjs-dist` (mesma versao 3.11.174 e CDN cdnjs ja usados pelas atas). Reconhecedor deterministico do W045A "Contatos das unidades" posicional: le o cabecalho POR ROTULO para achar a posicao X de cada coluna, reconstroi as colunas por coordenada, faz forward fill da unidade, junta telefone e endereco que quebram em varias linhas, remove o prefixo de pais "+55", separa enderecos multilinha (inclusive empresas) e corta o rodape de cada pagina. Funcoes: `carregarPdfjs`, `extrairItensPdf`, `acharAncorasW045A`, `colDeX`, `parseTelefonesW045A`, `parseEnderecoW045A`, `ehLinhaRodapeW045A`, `extrairContatosW045APdf`, `condoNomeDoTitulo`.
- `public/index.html`: arquitetura codigo-primeiro. A dropzone Importar Unidades virou porta unica e aceita PDF. `RECONHECEDORES_PDF` e um registro extensivel (preparar/extrair) onde cada layout de administradora vira um objeto novo sem reescrever o resto. `processarPdfUnidades` tenta os reconhecedores por codigo e, so se nenhum casar (ou a extracao falhar/vir vazia), oferece o fallback de IA com aviso explicito de custo (`fallbackIaPdf`, nunca automatico). IA deixa de ser o caminho principal.
- A IA (familia B) segue como rede de seguranca para PDF escaneado, layout ainda nao mapeado ou documento fora de padrao.

### Alterado
- `extrairTextoPdf` (modulo de atas) agora reusa `carregarPdfjs` em vez de carregar o pdf.js por conta propria: remove duplicacao e a race condition de dois `<script>` concorrentes.
- Removida a instrumentacao temporaria de diagnostico do caminho da IA (Prioridade 3 concluida: a causa do nome vazio era a saida da IA, resolvida pelo caminho por codigo).

### Follow-ups registrados (nao implementar antes do ciclo indicado)
- SRI (Subresource Integrity) ausente nos `<script>` de CDN: `xlsx` (linha ~8), pdf.js dinamico em `carregarPdfjs` e o worker. Versao fixada reduz o risco, mas o ideal e adicionar `integrity` (hash SHA-384 do cdnjs) + `crossorigin` nos tres pontos numa proxima sessao que toque nos scripts de CDN. Auditor classificou como moderado, nao bloqueante para ferramenta interna.
- Header de seguranca ausente no `server.js` (CSP, X-Frame-Options, X-Content-Type-Options): pre-existente, avaliar num ciclo de hardening.

### Validado
- Revisor: APROVADO apos correcoes (bloqueador de try/catch no caminho de extracao; colDeX sem limite de borda; `_pdfjsPromise` nao limpa em falha; mensagem enganosa em 0 contatos; dupla deteccao de ancoras; titulo multi-item; telefone "+55" sem espaco; corte de rodape por nome de condominio embutido em endereco).
- Auditor de seguranca: APROVADO (PDF lido 100% no navegador, dados nao saem da maquina; sem token exposto; XSS coberto por `esc()`; fallback robusto). Unico ponto: SRI (follow-up acima).
- Validador: sintaxe OK; logica validada em node no PDF real do Recreio (62 paginas): 1257 contatos, 577 unidades, 0 nomes vazios, 0 unidades com proprietario duplicado, 0 lixo de rodape; Metropole (CNPJ, endereco multilinha) perfeita; 5.4% sem cidade/bairro (degradacao graciosa em fim de pagina). Zero regressao apos as correcoes do revisor.

### Arquivos modificados
- `public/index.html`

Implementado na branch dev. pdfjs-dist nao e dependencia nova: ja era usado pelas atas, mesma versao e CDN.

---

## 2026-06-29 — Importar Unidades Fase 1: parser W045A tabular + inferencia de papel + tela de revisao

### Adicionado
- `public/index.html`: parser deterministico da familia A2 (relatorio W045A "Contatos das unidades" em planilha, ex Villaggio Laranjeiras). Forward fill da coluna Unidade (so aparece na primeira linha de cada unidade), limpeza de telefone sujo (extrai so digitos validos, remove codigo de pais 55, primeiro no campo e resto na Observacao), emails extras na Observacao, classificacao CPF (11 digitos) vs CNPJ (14 digitos). Funcoes: `detectarFamiliaPlanilha`, `splitUnidadeNumeroBloco`, `extrairTelefonesValidos`, `limparDocumento`, `anexarObs`, `parseW045AContatos`.
- `public/index.html`: motor de inferencia de papel (`inferirPapeis`, `mesmoSobrenome`). Resolve a coluna Tipo ambigua em Proprietario, Inquilino, Dependente ou Descartar com confianca alta, media ou incerta. Sinais: CNPJ dono faz residente virar inquilino; sobrenome do titular faz residente virar dependente; unidade sem proprietario elege o melhor palpite como incerto e os demais residentes caem como dependente incerto (nunca dois proprietarios por unidade). Imobiliaria descartada com contato guardado na Observacao de um contato mantido; Visitante descartado e marcado.
- `public/index.html`: tela de revisao editavel (`abrirRevisao`, `renderRevisao`, `mudarPapelRevisao`, `confirmarRevisao`, `descartarRevisao`, `corConfianca`). Cor por confianca e dropdown de papel por contato. Ao confirmar, emite linhas de 26 colunas (`contatoParaLinha26`) e reaproveita o `processUnidadesDataUnificada` ja testado. Nada sobe ao Superlogica sem o clique manual em Enviar unidades.
- `public/index.html`: Normalizador IA (familia B) ganhou botao "Revisar papeis e importar" que joga o resultado na mesma tela de revisao (`linha26ParaContato`, `abrirRevisaoFromNormalizado`).

### Follow-ups registrados (nao implementar antes do ciclo indicado)
- XSS pre-existente em `renderPreview` (`public/index.html` aprox. linhas 3515 e 3517): cabecalhos e celulas da planilha de despesas sao interpolados em template literal sem `esc()`. Fora do escopo da Fase 1 e nao agravado por ela (o caminho de unidades nao passa por essa funcao). Corrigir aplicando a mesma `esc()` de `renderPreviewUnidades`/`renderRevisao` ANTES da proxima mexida no modulo de despesas.
- Familia A1 (PDF posicional W045A) fica para a Fase 2 com `pdfjs-dist` no `server.js`, so apos a tela de revisao validada em producao de teste.
- Centralizar `esc()` numa unica utilitaria global (hoje redefinida em `renderPreviewUnidades` e `renderRevisao`): reduz risco de novas funcoes esquecerem o escape.
- LIMITACAO CONHECIDA DA PRODUCAO (descoberta ao estudar a main em 2026-06-30, NAO corrigir sem decisao do Matheus): o CNPJ do Proprietario nao e enviado ao Superlogica. O PASSO 2 (PUT do proprietario, `enviarUmaUnidade`) so manda `ST_CPF_CON`, nao tem `ST_CGC_CON`. So os contatos extras (Inquilino/Dependente, `buildPayloadContatoExtra`) enviam CNPJ via `ST_CGC_CON`. Resultado: dono pessoa juridica (Banco Daycoval, Metropole, SPE Carapina) sobe sem o documento da empresa no cadastro do proprietario.
- LIMITACAO CONHECIDA DA PRODUCAO (mesma origem, NAO corrigir sem decisao do Matheus): o Estado/UF do Proprietario nao e enviado. O PASSO 2 nao tem `ST_ESTADO_CON`; so os contatos extras mandam estado (como codigo numerico). O proprietario sobe sem UF.

### Validado
- Revisor: APROVADO (apos correcao de 2 bloqueadores: multiplos residentes sem dono geravam multiplos proprietarios; falta de comentario no topo de `renderRevisao`)
- Auditor de seguranca: APROVADO (todo dado externo da revisao passa por `esc()`, sem token exposto, sem log de dado pessoal)
- Validador: sintaxe OK; testes de logica em dados reais Villaggio Comercial (194 unidades, 248 contatos) e Residencial (777 unidades, 0 com proprietario duplicado); pipeline end to end ate o modelo de import com tipoResp correto

### Arquivos modificados
- `public/index.html`

Implementado na branch dev. Commit `9d04c97`. Fixtures usados: Recreio das Palmeiras, Alphaville Tres Praias, Villaggio Laranjeiras, Quattro Residencial.

---

## 2026-06-23 — Prosa rica deterministica + Bloco A (Prestacao de Contas)

### Adicionado
- `services/prestacao-pdf/app/prosa.py`: engine de prosa por template 100% deterministica, sem IA. Gera descricao por categoria com percentual e ordenacao por peso em tres moldes: dominancia (uma categoria acima de 50%), dois equilibrados (duas maiores somam mais de 70%) e pulverizado (demais casos). Limite de 160 caracteres por descricao. Insight de receita coerente entre texto e destaque visual.
- `public/prestacao.js`: texto da UI e do system prompt do fallback padronizado para W016A obrigatorio. Download de PDF e PPTX isolados, falha de um nao derruba o outro; decodificacao base64 via `Uint8Array.from` sem travar a thread. Estado reseta apos sucesso. Toast de erro quando a lista de condominios falha.
- `public/index.html`: ajustes de UI na aba de Prestacao de Contas alinhados ao padrao W016A.

### Follow-ups registrados (nao implementar antes do ciclo indicado)
- `console.log`/`console.error` de dados financeiros no caminho de fallback (`prestacao.js` aprox. linhas 1871, 2059, 2063): remover antes de release de producao.
- Toast do `catch` externo (`prestacao.js` aprox. linha 1952) exibe `err.message` bruto: substituir por mensagem fixa no proximo ciclo.
- Aviso opcional do W011A na dropzone entra somente junto com a feature de ingestao de serie mensal (W011A despesa mensal + W015A receita mensal), nunca antes.

### Validado
- Revisor: APROVADO
- Auditor de seguranca: APROVADO
- Validador: smoke da prosa nos 3 moldes passou

### Arquivos modificados
- `public/index.html`
- `public/prestacao.js`
- `services/prestacao-pdf/app/prosa.py`

Implementado por: subagente programador

---

## 30/04/2026 — Suporte a Inquilino e Dependente na importação de unidades

### Adicionado
- Parser unificado `processUnidadesDataUnificada`: lê planilha de 26 colunas (1 linha por pessoa), agrupa por Unidade+Bloco, separa campos do Proprietário em `prop_*` e empilha Inquilinos e Dependentes em `contatos_extras[]`
- Detector automático de formato `detectarFormatoPlanilhaUnificada`: distingue formato antigo Superlógica (30+ colunas) do novo formato unificado de 26 colunas sem quebrar importações existentes
- 9 helpers novos: `detectarFormatoPlanilhaUnificada`, `dataBRtoUS`, `dataBRtoUSComHora`, `ufParaCodigo`, `generoParaCodigo`, `tipoTelefoneParaCodigo`, `recebeCobrancaParaCodigo`, `omitirVazios`, `buildPayloadContatoExtra`
- Helper de envio `enviarContatoExtra`: POST por contato extra com tratamento de erro de rede e parse defensivo de JSON
- Integração no `enviarUmaUnidade`: após PUT do Proprietário, itera `contatos_extras` com `for...of` sequencial e contabiliza `inqOk`/`inqFail`/`depOk`/`depFail` por unidade
- Conversão automática de datas de `dd/mm/aaaa` para `mm/dd/aaaa` (formato americano exigido pela API Superlógica)
- Conversão automática de UF para código numérico (8=ES, 25=SP, 19=RJ, 11=MG, 5=BA)
- Estrutura dupla de telefone preservada: `TELEFONES[0]` + `ST_TELEFONE_CON` conforme payload validado em produção
- Avisos via toast warn quando UF não está mapeada ou Proprietário duplicado é detectado no processFile

### Validado
- Arquiteto APROVOU o plano
- Programador implementou em 3 rodadas (V1, V2 com correções, V3 com ajuste de ressalva)
- Revisor APROVOU COM RESSALVAS na V2 e APROVADO em V3 (1 ressalva resolvida)
- Auditor de segurança APROVOU na V2: zero violações novas, zero tokens vazados, zero hífens narrativos, zero menções indevidas ao Grupo Service
- Validador APROVADO 47/47 checks: payload gerado comparado byte a byte com payload validado em produção em 2026-04-30

### Métricas
- `public/index.html`: 4967 -> 5338 linhas (+371 linhas)
- MD5 final: `dd9df99169721ff1c834f70f8fe57004`
- Backup blindado preservado em `~/Downloads/service-hub_BACKUP_20260430_143856.html`

### Arquivos modificados
- `public/index.html` (modificado, 4967 a 5338 linhas)
- `tarefas/concluidas/inquilino-dependente.md` (movido de em-andamento)

### Validação local em 30/04/2026
- Planilha: `teste_unidade_real_1102_A2.xlsx`
- Cond 167 Residencial Teste, unidade 1102 A2 (Villagio Residencial)
- Pessoas: Paloma (proprietária), André (inquilino), Renata (dependente)
- Resultado do log: POST OK, PUT OK, INQ OK, DEP OK, RES inq 1 ok dep 1 ok
- Feature aprovada pra produção pelo Matheus

Implementado por: subagente programador

---

## 29/04/2026 — Revisão profunda pré SaaS, 3 fixes de XSS e bug lógico, deploy aprovado

### Adicionado
- Comentários de cabeçalho explicativos em toast (justificativa do timeout 4000ms) e cpRenderSidebar (cabeçalho da função e razão do escHtml em vez de dcEscape)
- Branch local de segurança backup-pre-merge para rollback do pipeline (apagar na finalização)

### Corrigido
- Função toast (public/index.html linhas 3850 a 3866) reescrita com DOM API + document.createTextNode em vez de innerHTML, neutralizando XSS em mais de 60 callers. Varredura confirmou zero callers com tag HTML intencional.
- cpRenderSidebar (linhas 4069 a 4088) escapa c.nome, c.id e iniciais com escHtml. Decisão escHtml em vez de dcEscape porque c.id entra dentro de onclick com aspas simples internas e dcEscape não escapa apóstrofo.
- dcSalvarDemandas linha 4708 grava status 'Pendente' em vez de 'aberta'. Operação isolada, sem dependência com filtros, badges ou queries.

### Validado
- Auditor de segurança SEGURO PARA COMMIT, 7 varreduras adicionais sem crítico (tokens revogados 156b6871 e f8058080 zero matches em qualquer arquivo, public/ sem .bak, console.log não expõe app_token nem access_token)
- Revisor APROVADO sem ressalva após rodada extra de polimento (2ª passada do loop, dentro do limite de 4)
- Validador VALIDADO, 8 abas do sistema intactas, 4 cenários de dry run passaram (toast Lista A, toast Lista B com integers, cpRenderSidebar com nome e id sujos, dcSalvarDemandas com Pendente preservando todos os filtros)
- 4 testes runtime manuais executados pelo Matheus, T1 persistência localStorage OK, T2 render Condomínios OK, T3 status Pendente literal gravado no Supabase confirmado e demanda de teste apagada, T4 toast com document.createTextNode validado no DevTools Sources
- Deploy aprovado em produção, polling fechou na tentativa 5 (150s), HTTP 200 em / (40304 bytes) e em /hub (295721 bytes), marcador document.createTextNode presente no HTML servido

### Pendências
(a) Migração manual de status legado no Supabase. Rodar no Supabase Studio o comando `UPDATE demandas SET status='Pendente' WHERE status='aberta'`. Atinge especificamente as demandas com num 25 (id dc_1777074896060_0, processado_em 2026-04-24) e num 26 (id dc_1777074896282_1, processado_em 2026-04-24), criadas antes do fix. Sem isso, sistema convive com dois valores de status no banco. Prioridade média.

(b) Auditoria de RLS no Supabase. Risco residual a considerar, a publishable key sb_publishable_LgUqE8qdyvhh6VhLD4c4yg_zo6aWJXH esteve presente em public/index.html.bak-antes-fracao e public/index.html.bak-pre-fix-uf, ambos publicamente acessíveis via Railway por janela indeterminada antes do move para /backups/ na Etapa 0. Assumir que a chave pode ter sido coletada por scraper neste período. RLS no Supabase é a única defesa restante. Auditoria de policies das tabelas condominios, demandas, laudos e historico é prioridade ALTA e deve ser concluída antes da abertura do SaaS multi usuário. Localização da chave em código, public/index.html linha 3876.

(c) Verificação de git log no remoto pelos tokens revogados 156b6871 e f8058080. Comando sugerido `git log --all -p -S "156b6871"` e idem para o outro. Se aparecerem em commit antigo, vai ser preciso git filter-repo ou rotação preventiva. Verificação pendente, não bloqueio. Prioridade média.

(d) TypeError latente em cpRenderSidebar linha 4081, c.nome.split(' ') executado antes de escHtml, lança erro se c.nome for null ou undefined. Risco anterior, dado obrigatório no Supabase via schema mas sem proteção no client. Sugestão de fix futuro, guard com fallback `c.nome || 'Sem nome'` antes do split. Prioridade média.

(e) Schema da tabela demandas no Supabase usa processado_em em vez do padrão created_at. Descoberta colateral durante T3, não bloqueia, mas vale considerar normalização de schema antes da fase SaaS multi cliente. Também observa que condominio_id é string literal ('camaras'), não UUID, dado relevante pra modelagem multi cliente futura. Prioridade baixa.

### Issues novos descobertos pelo arquiteto, fora do escopo desta rodada, vão para tarefa de outra sessão
- Issue 3102 audio-log innerHTML com e.message vinda de APIs externas (AssemblyAI, Anthropic), prioridade ALTA. Vetor é externo, não self.
- Issue 3736 renderConsumoGrid com `${item.url}` data URL local e `${item.unidade}` input do usuário sem escape, prioridade média (self XSS local).
- Issue 3846 addHistorico com `${texto}` interpolado em innerHTML, prioridade média (self XSS local).

### Arquivos modificados
- `public/index.html` (modificado, 3 fixes aplicados, linha de contagem atualizada para 4967)

Implementado por: subagente programador

---

## 29/04/2026 Importacao de unidades validada em escala

### Adicionado
- Importacao de unidades via API Superlogica ponta a ponta
- Migracao SQL para vincular condominios ao Superlogica (id_condominio)
- Documentacao definitiva do fluxo em docs/guia-definitivo-v2-2026-04-28.pdf

### Corrigido
- PUT contatos rejeitava UF com erro 'ES nao e um valor valido'
  Causa: campo ST_ESTADO_CON nao existe na API Superlogica
  Solucao: remover o campo, manter apenas ST_UF_CON
- sanitizeProxyUrl normaliza URL do proxy Railway
- getProxy retorna URL correta independente de prefixo

### Validado
- Fase A: 1 unidade (A-0201) com nome real persistido no Superlogica
- Fase B: 10 unidades, POST 10/10 ok, PUT 10/10 ok
- Fase C: 528 unidades (Quattro Residencial Clube), POST 528/528, PUT 528/528
  405 com proprietario real, 123 com placeholder (vazios na origem)

### Pendencias documentadas (nao bloqueiam)
- Bug 403 em /v2/condor/condominios (busca em Configuracoes)
- Validar aba Caixa de Entrada no painel Condominios


---

# Changelog Service Hub

## 2026-04-28 (segunda parte) — Refatoração 4-em-1: cond global, modal Dashboard unificado, fusão Condomínios+Demandas, remoção cadastro do painel Condomínios

### Resumo
Quatro mudanças interligadas para eliminar duplicidade de seleção e simplificar navegação. Continuação direta da sessão anterior, por cima do trabalho não commitado.

### Item 1: Estado global do condomínio ativo
- `enviarDespesas` e `enviarUnidades`: toast atualizado para "Selecione um condomínio ativo no Dashboard".
- `cpSelecionarCond`: passou a sincronizar `state.config.condId`, `state.config.condNome`, `localStorage` e `atualizarDashCond`. Também sincroniza o hidden `cfg-cond-id` para que `saveConfig` posterior não apague.
- `cpCarregarDoSupabase`: ao auto-selecionar, prefere o `state.config.condId` salvo se ele existir na lista; cai no primeiro item só como fallback.
- `saveConfig`: passou a preservar `state.config.condId` quando o hidden está vazio (corrige cenário onde abrir Configurações depois de selecionar pelo Dashboard apagava a seleção).

### Item 2: Botão único no card "Condomínio Ativo" do Dashboard
- Removidos: input solto `dash-cond-search`, dropdown solto `dash-cond-dropdown`, botão `+ Novo condomínio`, modal `dash-modal-novo-cond`, listener `document.click` órfão, funções `dashAbrirModalNovoCondominio` e `dashFecharModalNovoCondominio`.
- Adicionado: botão único `btn-gerenciar-cond` que abre o modal `dash-modal-gerenciar-cond` com 2 abas (Buscar existente / Cadastrar novo) usando classes `.tabs` e `.tab` já existentes.
- Funções novas: `dashAbrirModalGerenciarCond`, `dashFecharModalGerenciarCond`, `dashModalSetTab`.
- `searchCondominioDash` e `selecionarCondominioDash` adaptadas aos novos IDs (`dash-modal-cond-search`, `dash-modal-cond-dropdown`).
- `dashSalvarNovoCondominio` adaptada (`dash-modal-nome-cond`, `dash-modal-id-superlogica`).
- `atualizarDashCond` ajusta o estado visual do botão (`btn-primary` quando sem cond, `btn-ghost` quando com cond).

### Item 3: Unificação Condomínios + Demandas de Cliente
- Removidos do menu lateral: item "Demandas de Cliente".
- Removidos: painel `panel-demandas-cliente` inteiro, `dcCarregarCondominios`, override de `showPanel` para `demandas-cliente`, entrada `'demandas-cliente'` em `PAGE_META`, `select dc-select-cond`.
- Adicionada: nova aba "Caixa de Entrada" na `cp-tabs-bar` do painel Condomínios.
- Função `cpRenderDemandasIA()` cria o HTML da Caixa de Entrada sem o select de condomínio (usa `state.config.condId` como fonte).
- `cpShowTab` trata o branch `demandas-ia` antes do guard `if (!c)`, permitindo renderizar mesmo sem cond ativo na sidebar.
- `dcProcessarTextoIA` e `dcSalvarDemandas` passaram a ler de `state.config.condId`.
- Variável `dcTextoBrutoTemp` preserva o rascunho ao trocar de aba.

### Item 4: Cadastro de condomínio removido do painel Condomínios
- Removidos: botão "+ Adicionar Condomínio", modal `cp-modal`, classes CSS `.cp-modal-overlay`, `.cp-modal-box`, `.cp-modal-field`, `.cp-modal-btns`, `.cp-btn-cancel`, `.cp-btn-ok`, `.cp-btn-novo`, funções `cpAbrirModal`, `cpFecharModal`, `cpSalvarCondominio`.

### Outras correções (rodada 2 do revisor)
- `cpAtualizarStatus`, `cpAnexarFoto`, `cpAplicarUpdate` agora usam `cpGetCondominioAtivo()` (corrigindo bug pré-existente onde `cpCondAtivo` string era tratado como objeto).
- Travessões em comentários HTML/JS substituídos por `:` ou removidos.
- `console.error` em `searchCondominioDash` removido.

### Métricas
- `public/index.html`: 4444 a 4414 linhas (-30 líquido). Diff acumulado (2 sessoes): +776 / -302.
- 2 rodadas de revisor + auditor.
- 30/30 pontos do validador aprovados.

### Decisões mantidas (P1, P2, P3, P4)
- Coluna `id_superlogica` (INTEGER) preservada no Supabase. Sem rename para `cond_id` (custo alto, benefício zero).
- Coluna `criado_em` preservada. Sem rename para `created_at`.
- `cpCondAtivo` continua como variável de foco do painel, sempre sincronizada com `state.config.condId`.
- "Caixa de Entrada" virou aba interna no painel Condomínios.

### Issues remanescentes (pré-existentes, fora de escopo)
- `buildUrl` (~linha 2507): fallback direto para `api.superlogica.net` quando `state.config.proxy` vazio.
- `loadConfig` (~linha 1818): XSS em `c.condNome`/`c.condId` via innerHTML.
- `searchCondominio` painel Configurações (~linha 2979): XSS idêntico ao corrigido em `searchCondominioDash`.
- `addLog` em `enviarDespesas`/`enviarConsumo`: dados HTTP brutos via innerHTML.
- `toast` global: `msg` interpola via innerHTML.
- `cpRenderSidebar`: injeta `c.nome` via innerHTML sem `dcEscape`.

### Arquivos modificados
- `public/index.html` (modificado, 4444 a 4414 linhas)
- `docs/log.md` (modificado)
- `tarefas/concluidas/refatoracao-cond-global-unificacao-painel.md` (movido de em-andamento)

Implementado por: subagente programador

---

## 2026-04-28 — Sessão de correção: seleção de condomínio e importação de unidades

### Resumo
Sessão de recuperação após o site ter sido travado por trabalho não commitado em `public/index.html` (+445/-24 linhas que causavam interferência cruzada entre Dashboard e painel Configurações). O trabalho problemático foi preservado em stash (`stash@{0}: sessao-correcao-2026-04-28-index-quebrado`) e o arquivo voltou ao estado limpo do commit `7a30772`. As 3 funcionalidades foram reimplementadas de forma cirúrgica seguindo o fluxo padrão (arquiteto -> programador -> revisor + auditor -> validador -> documentador), com 4 rodadas de revisor/auditor até aprovação.

### Funcionalidade 1: Seleção de condomínio no Dashboard
**Bug original**: `searchCondominioDash` chamava `selecionarCondominio` (do painel Configurações), causando interferência cruzada de listeners e travamento da tela.

**Correção**:
- `searchCondominioDash` (linha ~2826) reescrita: busca primeiro em `cpCondominios` (memória), fallback via `supaFetch` no Supabase. Sem chamadas Superlógica.
- `selecionarCondominioDash` (linha ~2903) criada: NÃO chama `selecionarCondominio`. Apenas atualiza `state.config`, `localStorage`, input do Dashboard e dispara `atualizarDashCond`.
- Event delegation no dropdown via `closest('.cond-option')` resolve o problema do `this.dataset` em filhos.
- Escape XSS via função `esc` local antes de qualquer interpolação em innerHTML.
- `loadConfig` agora restaura `dash-cond-search` ao recarregar a página.

### Funcionalidade 2: Cadastro rápido de novo condomínio
**Novo modal**: `dash-modal-novo-cond` no Dashboard (linha ~1751).

**Funções criadas**:
- `dashAbrirModalNovoCondominio` (linha ~2916)
- `dashFecharModalNovoCondominio` (linha ~2924)
- `dashSalvarNovoCondominio` (linha ~2931): valida nome e id_superlogica como inteiro positivo, POST via `supaFetch`, push em `cpCondominios` com `id_superlogica`, auto-seleciona como ativo, fecha modal, toast.

### Funcionalidade 3: Importação de unidades via API REST com colunas fixas
**Mudança em `processFile`**: header tenta linha 4 (índice 3) fixo; fallback automático por palavra "unidade" nas primeiras 10 linhas se não bater. Toast de erro se cabeçalho não encontrado.

**Reescrita `processUnidadesData`**: mapeamento por índice fixo (colunas 0, 1, 2, 3, 4, 5, 6, 7, 9, 24, 25, 26, 27, 28, 29). `cleanVal` filtra `nan`, `0`, `0.0`, `cep inválido`, `inválido`. `splitUnidade` separa bloco e número quando há espaço. `splitCidadeEstado` extrai sigla 2 letras do final.

**Mudança em `enviarUmaUnidade`**:
- PUT agora inclui 7 campos de endereço (`ST_CEP_CON`, `ST_ENDERECO_CON`, `ST_NUMERO_CON`, `ST_BAIRRO_CON`, `ST_COMPLEMENTO_CON`, `ST_CIDADE_CON`, `ST_ESTADO_CON`).
- Resposta do PUT é tratada: lê `r2.ok`, parse JSON, verifica `status: "200"`, retorna `{ok: false}` em falha.
- Função `esc` no topo da função, todas as chamadas a `addLog` escapam dados externos.

**Novo elemento**: `uni-progresso-texto` no painel-unidades, atualizado no formato `X de Y unidades importadas` durante a importação.

**Lote**: 10 unidades simultâneas com `Promise.all` + `sleep(100)` entre lotes.

### Estado da inicialização
`state.unidades` agora inicializa `processed: []`, `importing: false`, `shouldStop: false` na declaração (linha 1779).

### Métricas
- `public/index.html`: 4242 -> 4444 linhas. Diff final: +316 / -114.
- 4 rodadas de revisor + auditor até aprovação.
- 30 pontos de validação aprovados pelo validador.

### Issues conhecidos fora de escopo
Para tratar em sessão futura:
1. `loadConfig` linha ~1818 — XSS em `c.condNome` e `c.condId` via innerHTML.
2. `searchCondominio` painel Configurações linhas ~2979-3007 — XSS idêntico ao corrigido em `searchCondominioDash`.
3. `addLog` em `enviarDespesas` e `enviarConsumo` — `txt` da resposta HTTP via innerHTML sem escape.
4. `toast` global — `msg` interpola via innerHTML.

### Stash preservado
`stash@{0}: sessao-correcao-2026-04-28-index-quebrado` ainda existe localmente. Pode ser descartado depois que o Matheus validar manualmente que o site funciona.

### Arquivos modificados
- `public/index.html` (modificado, 4242 -> 4444 linhas)

Implementado por: subagente programador
