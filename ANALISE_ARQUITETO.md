# ANALISE_ARQUITETO.md — Service Hub V8S

Data: 2026-05-25
Baseado em: public/index.html (5338 linhas), server.js (75 linhas), CLAUDE.md, MIGRATION_ETAPA1.sql, MIGRATION_CONDOMINIOS_SUPERLOGICA.sql, todas as tarefas em andamento e concluídas relevantes, package.json, supabase/.temp/linked-project.json.

---

## SEÇÃO 1: Arquitetura atual em camadas

### Camada 1: Landing page pública

Arquivo: `public/landing.html` (737 linhas)
Responsabilidade: ponto de entrada público do domínio. Identidade visual ServiceZone, fundo escuro (#050810), gradiente radial duplo. Contém botão "Entrar" apontando para `/hub`. Usa fonte Inter via Google Fonts. Não tem JavaScript de negócio.

### Camada 2: Sistema operacional (frontend)

Arquivo: `public/index.html`
Tamanho atual: 5338 linhas (atualizado em 2026-04-30)
MD5: dd9df99169721ff1c834f70f8fe57004
Responsabilidade: toda a interface e toda a lógica de negócio do hub.

Estrutura interna do arquivo:
- Linhas 1 a 8: cabeçalho HTML, meta tags, imports de fontes (Google Fonts Plus Jakarta Sans + JetBrains Mono) e biblioteca XLSX (cdnjs)
- Linhas 9 a 980: bloco `<style>` com CSS embutido completo: variáveis CSS (:root), sidebar, navbar, topbar, panels, cards, tabelas, badges, botões, dropzones, logs, modais, toast, pauta items, consumo grid, etc.
- Linhas 981 a 1678: HTML estrutural dos painéis (sidebar, topbar, panels)
- Linhas 1679 a 1900: modais (gerenciar condomínio, busca/cadastro)
- Linhas 1900 a 5338: bloco `<script>` com todo o JavaScript da aplicação

### Camada 3: Backend / proxy

Arquivo: `server.js`
Tamanho: 75 linhas
Responsabilidade: servir os arquivos estáticos, expor rotas de proxy para APIs externas com chaves secretas, e controlar o roteamento de URLs.

Rotas do server.js:
- `POST /api/assemblyai/upload`: proxy de upload de arquivo de áudio para AssemblyAI. Chave ASSEMBLYAI_KEY em variável de ambiente Railway.
- `POST /api/assemblyai/transcript`: proxy para iniciar transcrição no AssemblyAI.
- `GET /api/assemblyai/transcript/:id`: proxy para polling de status da transcrição.
- `POST /api/claude/messages`: proxy para Anthropic Claude Sonnet 4.6. Chave ANTHROPIC_KEY em variável de ambiente Railway.
- `use /api`: middleware 404 para rotas de API desconhecidas, retorna JSON estruturado com log via console.warn.
- `GET /`: serve public/landing.html
- `GET /hub`: serve public/index.html
- `GET *`: catch-all redireciona para landing.html

Dependências: apenas `express ^4.18.2`. Zero outras dependências no package.json.

### Camada 4: Banco de dados (Supabase)

Projeto: `mtucxdfepkwsfnqpfydb` (nome: "Service Hub", org: cndfxoxvqrquzljyoapj)
Acesso: direto do frontend via REST, usando anon key hardcoded na linha 4247 do index.html.

Tabelas conhecidas (inferidas dos migrations e do código):
- `condominios`: id (UUID), nome, sindico, criado_em, id_superlogica (INTEGER, UNIQUE, adicionado por MIGRATION_CONDOMINIOS_SUPERLOGICA.sql), updated_at
- `demandas`: id, num, prio, status, titulo, sit, acao, resp, prazo, tipo, condominio_id, fonte, origem_texto_bruto, processado_em (os últimos 3 adicionados por MIGRATION_ETAPA1.sql)
- `laudos`: id, nome, status, tecnico, dataVistoria, dataLaudo, enviado, condominio_id
- `historico`: id, data, cor, txt, condominio_id

RLS: desligado ou sem policies adequadas (tarefa seguranca-supabase-rls.md e pausa-rls-supabase.md confirmam que nenhuma policy foi ativada até 2026-05-25).

### Camada 5: Proxies externos

**Superlógica:** `https://superlogica-proxy-production.up.railway.app` — projeto separado no Railway, serve de intermediário CORS para a API da Superlógica. Os tokens appToken e accessToken são enviados pelo frontend em cada requisição como headers HTTP (`app_token`, `access_token`) e vivem apenas em localStorage da máquina do usuário.

**AssemblyAI:** proxy via `/api/assemblyai/*` no server.js do próprio projeto.

**Anthropic:** proxy via `/api/claude/messages` no server.js do próprio projeto.

### Camada 6: Deploy / infraestrutura

Hospedagem: Railway, projeto `service-hub-production.up.railway.app`
Deploy: push direto para branch `main` no GitHub dispara build e deploy automático
CI/CD: nenhum. Zero pipeline de testes antes do deploy.
Comando de start: `node server.js` (definido em package.json scripts.start)

### Mapeamento dos painéis

Total de painéis declarados no HTML: 11

| ID do painel | Tem lógica real? | Descrição |
|---|---|---|
| panel-dashboard | Sim | Cards de stats, histórico de importações, acesso rápido, card de condomínio ativo com modal |
| panel-despesas | Sim | Upload de planilha, mapeamento de colunas, envio para Superlógica |
| panel-unidades | Sim | Upload planilha unificada (Proprietário, Inquilino, Dependente), importação em lote |
| panel-boletos | Placeholder | Mensagem "em breve" |
| panel-financeiro | Placeholder | Mensagem "em breve" (conciliação bancária) |
| panel-nf | Placeholder | Mensagem "em breve" (notas fiscais) |
| panel-condominios | Sim | Sistema completo de gestão: sidebar, abas Visão Geral / Demandas / Prioridades / Laudos / Histórico / Assinaturas / Importar / Caixa de Entrada |
| panel-tarefas | Placeholder | Mensagem "em breve" |
| panel-atas | Sim | Formulário de reunião, pauta com PDF, transcrição via AssemblyAI, geração de texto para Claude |
| panel-consumo | Sim | Upload de fotos de medidores, extração de leitura via Claude Vision, envio para Superlógica |
| panel-configuracoes | Sim | Credenciais Superlógica, seleção de condomínio padrão, URL do proxy |

Painéis com lógica real: 7 de 11
Painéis placeholder: 4 (boletos, financeiro, nf, tarefas)

### Contagem de funções JavaScript

Total de funções declaradas: ~127 (contagem via grep)

Agrupamento por domínio funcional:

**Utilitários gerais (~10):** sanitizeProxyUrl, getProxy, buildUrl, getHeaders, escHtml, sleep, dataBRtoUS, dataBRtoUSComHora, omitirVazios, toggleVisibility

**Configuração e estado (~6):** loadConfig (IIFE), saveConfig, updateStatusDot, setCondominioAtivo, getCondominioAtivo, renderBannerCondAtivo

**Navegação (~3):** showPanel, setTab, setTabByName

**Importação de despesas (~5):** buildMapper, goToMapping, validateAndPreview, renderValidatedTable, filterRows

**Importação de unidades (~18):** handleDrag, handleDragLeave, handleDrop, handleFile, processFile, detectarFormatoPlanilhaUnificada, processUnidadesDataUnificada, processUnidadesData, renderPreviewUnidades, renderPreview, clearFile, enviarUmaUnidade, pararImportacaoUnidades, buildPayloadContatoExtra, enviarContatoExtra, ufParaCodigo, generoParaCodigo, tipoTelefoneParaCodigo, recebeCobrancaParaCodigo

**Atas condominiais (~10):** audioDragOver, audioDragLeave, audioDrop, cancelarAudio, setAudioProgress, abrirPastaTranscricoes, importarTranscricao, addPauta, removePauta, anexarPdfPauta, limparAta

**Consumo de medidores (~6):** handleDropConsumo, handleFilesConsumo, fileToBase64, renderConsumoGrid, removeConsumoItem, limparConsumo

**Dashboard / busca de condomínio (~10):** atualizarDashCond, searchCondominioDash, selecionarCondominioDash, dashAbrirModalGerenciarCond, dashFecharModalGerenciarCond, dashModalSetTab, dashSalvarNovoCondominio, selecionarCondominio, limparCondominio, searchCondominio (painel Configurações)

**Supabase (~4):** supaFetch, supaFetchRich, cpCarregarDoSupabase, cpSeedParaSupabase

**Sistema de condomínios (cpXxx, ~30):** cpSalvar, cpStatusBadge, cpPrioBadge, cpCardClass, cpToggleDem, cpRenderSidebar, cpSelecionarCond, cpAtualizarBadges, cpShowTab, cpRenderDemandasIA, cpRenderVisao, cpRenderDemGrid, cpRenderLaudos, cpUploadPdf, cpVerPdf, cpFecharPdf, cpFecharPdfBtn, cpRemoverPdf, cpRenderHistorico, cpRenderAssinaturas, cpRenderImportar, cpAtualizarStatus, cpAnexarFoto, cpAplicarUpdate, cpGetCondominioAtivo

**Demandas IA / Caixa de Entrada (~5):** dcProcessarTextoIA, dcRenderizarPreview, dcEscape, dcDescartarPreview, dcSalvarDemandas

**Relatórios (~2):** gerarRelatorioSindico, gerarRelatorioInterno

**Log e UI (~5):** addLog, addHistorico, toast, statusCor, prioCor

### Mapeamento de integrações

**Superlógica (via proxy externo):** Todos os GETs e POSTs para `/v2/condor/*` passam pelo proxy externo `superlogica-proxy-production.up.railway.app`. Funções: buildUrl, enviarDespesas, enviarUnidades, enviarUmaUnidade, enviarContatoExtra, enviarConsumo, searchCondominio. Os tokens são enviados como headers HTTP em cada request.

**Supabase (direto do frontend):** supaFetch e supaFetchRich chamam `https://mtucxdfepkwsfnqpfydb.supabase.co/rest/v1/` diretamente com a anon key hardcoded na linha 4247. Sem nenhum proxy intermediário. Tabelas acessadas: condominios, demandas, laudos, historico. 21 callers de supaFetch/supaFetchRich identificados no código.

**AssemblyAI (via proxy server.js):** processarArquivoAudio chama `/api/assemblyai/upload`, `/api/assemblyai/transcript` e `/api/assemblyai/transcript/:id`. O server.js repassa para `api.assemblyai.com` com ASSEMBLYAI_KEY de variável de ambiente.

**Anthropic / Claude (via proxy server.js):** dcProcessarTextoIA (Demandas IA, modelo claude-sonnet-4-6) e processFilesConsumo (Leitura de Consumo, modelo claude-haiku-4-5-20251001) chamam `/api/claude/messages`. O server.js repassa para `api.anthropic.com` com ANTHROPIC_KEY de variável de ambiente.

### Fluxo de dados de ponta a ponta

1. Usuário acessa o domínio `service-hub-production.up.railway.app`
2. Railway encaminha para server.js (Node.js/Express, porta Railway)
3. server.js serve `public/landing.html` via rota `GET /`
4. Usuário clica "Entrar", navega para `/hub`
5. server.js serve `public/index.html` via rota `GET /hub`
6. Browser faz parse do HTML/CSS/JS (arquivo único de 5338 linhas)
7. IIFE `loadConfig` carrega tokens do localStorage
8. IIFE `restorePanel` restaura o painel ativo do localStorage
9. `DOMContentLoaded` dispara `cpCarregarDoSupabase` que busca dados do Supabase direto
10. Para ações de importação: frontend monta payload e chama proxy externo Superlógica
11. Para transcrição de áudio: frontend chama `/api/assemblyai/*` no server.js
12. Para geração de atas / leitura de consumo: frontend chama `/api/claude/messages` no server.js
13. server.js repassa com chave secreta para o provedor externo e devolve resposta ao browser

---

## SEÇÃO 2: Dívidas técnicas e riscos

### index.html com 5338 linhas

**Impacto em manutenção:** qualquer mudança num painel exige abrir e editar um arquivo de 5338 linhas. Não há como editar só o CSS, só o JS de um módulo ou só o HTML de um painel sem carregar o arquivo inteiro. O risco de edição acidental em área errada é alto.

**Impacto em parse:** o browser precisa baixar e fazer parse de um arquivo único de aproximadamente 350KB (CSS + HTML + JS juntos). Em conexão lenta ou dispositivo fraco, isso atrasa o primeiro render interativo.

**Conflitos de merge:** como há apenas um dev (Matheus via Claude Code), não há merge de branches concorrentes. Mas qualquer sessão que sobrescreva o arquivo por engano (como aconteceu em 2026-04-29 com o backup pre-fix) pode reverter mudanças de segurança. Esse risco é real e já aconteceu.

**Onboarding de dev:** se a V8S contratar um desenvolvedor humano, explicar 5338 linhas de um arquivo sem framework, sem módulos, sem testes e sem documentação inline vai levar dias. A curva de aprendizado é íngreme porque não há separação de responsabilidades visível.

**O limite de 7000 linhas** é uma regra do CLAUDE.md. A 5338 linhas, o arquivo está a 76% do limite. No ritmo atual de crescimento (cada tarefa adiciona entre 50 e 400 linhas), o limite será atingido em 3 a 10 tarefas grandes.

### Supabase: anon key hardcoded no frontend

A constante `SUPA_KEY` na linha 4247 contém a publishable key `sb_publishable_LgUqE8qdyvhh6VhLD4c4yg_zo6aWJXH`. Por design do Supabase, a anon key é projetada para ficar no frontend. Ela não é um segredo em si. O problema não é a chave estar visível: é que sem RLS ativo, qualquer pessoa que abra o devtools e copie essa chave pode fazer SELECT em todas as tabelas, ler dados de todos os condomínios e condôminos, e inserir registros.

**RLS desligado:** a tarefa `pausa-rls-supabase.md` confirma que nenhuma das 4 tabelas (condominios, demandas, laudos, historico) tem RLS ativado até esta data. Isso significa que qualquer requisição com a anon key é aceita. Não há controle por usuário, por papel ou por registro.

**supaFetch engolindo erros:** a função supaFetch na linha 4249 retorna `null` silenciosamente quando a requisição falha (`if (!res.ok) { console.error(...); return null; }`). Com RLS ativo, um bloqueio de policy retorna HTTP 403, que supaFetch transforma em `null`. Os 21 callers de supaFetch não distinguem "registro não encontrado" de "acesso bloqueado". Isso vai criar bugs invisíveis quando o RLS for ligado.

**cpSeedParaSupabase criando loop:** a função `cpSeedParaSupabase` na linha 4341 é chamada por `cpCarregarDoSupabase` (linha 4295) quando a query de condomínios retorna vazio. Com RLS ativo e usuário não autenticado, a query retorna vazio porque o RLS bloqueia, não porque não há dados. O seed então tenta inserir os dados de "Reserva dos Camarás" via POST. O INSERT também é bloqueado pelo RLS. supaFetch engole o erro. Depois, `cpCarregarDoSupabase` chama a si mesma recursivamente. O resultado é um loop de requisições bloqueadas sem mensagem de erro visível para o usuário.

### Tokens: histórico e estado atual

**AssemblyAI:** key estava hardcoded no código frontend antes de 2026-04-27. Já removida e migrada para variável de ambiente ASSEMBLYAI_KEY no Railway. Key antiga deve ser considerada comprometida.

**Superlógica:** tokens appToken e accessToken eram hardcoded em commits antigos do CLAUDE.md (tarefa `seguranca-tokens-superlogica-vazados.md` confirma o achado). Tokens foram revogados. A tarefa `pausa-rls-supabase.md` pendência (c) registra que `git log --all -p -S "156b6871"` e idem para `f8058080` ainda não foram rodados para confirmar que os tokens aparecem no histórico git. Se aparecerem, git filter-repo ou rotação preventiva é necessário.

**Rota /api/config removida:** essa rota expunha OPENAI_KEY em JSON. Removida em 2026-04-27. A variável OPENAI_KEY provavelmente ainda existe como variável Railway (service-hub.md a lista como env var), mas não é mais acessível via endpoint.

**Estado atual:** os tokens Superlógica não estão mais em nenhum arquivo do repositório. Eles vivem em localStorage da máquina, carregados via painel Configurações. ANTHROPIC_KEY e ASSEMBLYAI_KEY estão em variáveis de ambiente Railway. A anon key do Supabase está hardcoded no frontend (por design, não é vazamento).

### XSS: issues conhecidos

**Issue 3102 ALTA, ainda aberto:** função processarArquivoAudio, `e.message` vindo de APIs externas (AssemblyAI, Anthropic) interpolado em innerHTML do `audio-log`. O vetor é externo (controlado pelo provedor da API). Prioridade ALTA porque o atacante não precisa ser o próprio usuário.

**Issue 3736, aberto:** função `renderConsumoGrid` interpola `${item.unidade}` e `${item.url}` em template literal com `innerHTML`. `item.unidade` é digitado pelo usuário no campo de leitura do medidor. Self XSS local.

**Issue 3846, aberto:** função `addHistorico` interpola `${texto}` em `innerHTML`. Os callers passam strings com nomes de condomínios, datas e contadores. Self XSS local.

**Toast, cpRenderSidebar: já corrigidos.** O commit 50dbd0c corrigiu toast via DOM API e cpRenderSidebar com escHtml.

### Ausência de testes automatizados

Zero testes. Nenhum arquivo de teste no repositório. Nenhuma referência a Jest, Mocha, Playwright ou qualquer framework de teste. Toda validação é manual, feita pelo subagente validador após cada implementação. O risco é que uma regressão só seja detectada depois do push para produção.

### Ausência de CI/CD

O fluxo é: editar arquivo local, `git push origin main`, Railway detecta o push e faz deploy automático. Não há step de lint, não há step de teste, não há step de auditoria antes do deploy. A proteção existente são os subagentes (revisor + auditor) que rodam antes do commit, mas apenas se o fluxo dos 8 passos for seguido. Em commits de emergência com `git commit --no-verify`, essa proteção é contornada.

### Sem autenticação real

Qualquer pessoa que conheça a URL `https://service-hub-production.up.railway.app/hub` acessa o sistema completo sem login. Os dados de condomínios, demandas, laudos e histórico de condôminos ficam visíveis para qualquer um que tenha a URL e saiba usar o devtools para também acessar o Supabase via anon key. Do ponto de vista LGPD, dados de condôminos (nome, email, telefone, CPF implícito nas planilhas de importação) estão expostos sem controle de acesso auditável.

### Bug de condominio_id no dcSalvarDemandas

A função `dcSalvarDemandas` na linha 5064 filtra `demandas?condominio_id=eq.{condId}` onde `condId` vem de `state.config.condId`. Após o refactor de cond global, `setCondominioAtivo` define `condId` como `id_superlogica` (número inteiro) quando disponível. A coluna `condominio_id` no Supabase armazena o UUID ou a string `'camaras'` (schema divergente). O filtro nunca bate, `existentes` retorna vazio, `baseNum` começa em zero, e as demandas salvas recebem números errados. Documentado na tarefa `pausa-rls-supabase.md` como pendência independente do RLS.

### TypeError latente em cpRenderSidebar

A linha 4445 executa `c.nome.split(' ')` antes de escHtml. Se `c.nome` for `null` ou `undefined` (Supabase pode retornar nulo se o campo não for NOT NULL), o split lança TypeError e a sidebar para de renderizar. Documentado na tarefa `pausa-rls-supabase.md` pendência (d).

### Schema divergente no Supabase

A tabela `demandas` usa `processado_em` em vez de `created_at` (padrão Supabase). A coluna `condominio_id` armazena tanto UUIDs quanto a string literal `'camaras'`, que é o id hardcoded do seed. Isso torna qualquer query de join ou filtro por condomínio frágil. Documentado na tarefa `pausa-rls-supabase.md` pendência (e).

---

## SEÇÃO 3: O que falta para multiusuário

### Autenticação

O sistema não tem nenhuma camada de autenticação. O que precisa ser construído:

**Supabase Auth** já está disponível no projeto (o SDK está acessível via REST na anon key). A estratégia mais simples é login com email e senha (ou magic link por email). Cada funcionário da V8S recebe um email cadastrado. Síndicos recebem um email de acesso limitado.

**Tela de login:** uma página HTML separada (ou uma camada sobre o index.html atual) que exibe formulário de email/senha, chama `auth.signInWithPassword`, armazena o JWT retornado em memória (o Supabase Auth SDK já cuida disso), e redireciona para `/hub`.

**Session management:** o Supabase Auth retorna um JWT com validade padrão de 1 hora e um refresh token de longa duração. O SDK gerencia renovação automática. No modelo atual de HTML vanilla, isso pode ser feito com o cliente JS do Supabase carregado via CDN.

**Proteção da rota /hub:** o server.js precisa checar se o request tem um JWT válido antes de servir o index.html. A alternativa mais simples sem criar middleware de autenticação no server.js é: servir o index.html normalmente, mas o primeiro script do index.html checa se há sessão ativa no Supabase e redireciona para o login se não houver.

### Autorização

**RLS com user_id:** todas as 4 tabelas (condominios, demandas, laudos, historico) precisam de uma coluna `user_id UUID` e de uma policy do tipo `USING (user_id = auth.uid())`. Isso garante que cada usuário só vê os dados que ele criou ou que foram compartilhados com ele.

**Roles:** o modelo de papéis mínimo para o caso de uso atual da V8S:
- `admin_v8s`: acesso total a todos os condomínios e todas as funcionalidades (Matheus e Adriano)
- `operador_v8s`: acesso a importação e relatórios, sem acesso às configurações de API
- `sindico`: acesso apenas ao painel de condomínios do seu condomínio, apenas leitura

O Supabase permite implementar roles via metadata do usuário (campo `raw_user_meta_data` na tabela `auth.users`) e policies que consultam esse campo.

**Isolamento de dados por condomínio:** cada condomínio no Supabase precisa estar vinculado ao usuário que o criou ou a uma lista de usuários autorizados. A estrutura mais simples é uma tabela de relacionamento `condominio_users (condominio_id, user_id, role)` com policies que verificam a existência de uma linha nessa tabela antes de permitir acesso.

### Frontend: proteção de rotas

O index.html atual carrega tudo de uma vez. Para multiusuário, é necessário:

1. Um script de guard no topo do index.html (antes de qualquer render) que verifica `supabase.auth.getSession()`. Se não houver sessão, redireciona para `/login`.
2. O token JWT do usuário autenticado precisa ser enviado como header `Authorization: Bearer <jwt>` em todas as chamadas ao Supabase, substituindo a anon key atual. O SDK do Supabase faz isso automaticamente quando o usuário está logado.
3. Para as chamadas ao server.js (AssemblyAI, Claude), o server.js precisa validar o JWT antes de repassar para a API externa, para evitar que qualquer pessoa com a URL `/api/claude/messages` consuma a chave da Anthropic sem estar logada.

### Backend: validar JWT nas rotas do server.js

As rotas `/api/assemblyai/*` e `/api/claude/messages` não têm nenhuma autenticação hoje. Qualquer pessoa que conheça a URL pode fazer POST e consumir os créditos da AssemblyAI e da Anthropic. Para corrigir isso no server.js:

1. Extrair o header `Authorization: Bearer <jwt>` da requisição
2. Verificar a assinatura do JWT usando a chave pública do Supabase (disponível via JWKS endpoint)
3. Rejeitar com HTTP 401 se o JWT for inválido ou ausente

### Migração de dados existentes

Os registros atuais no Supabase (condomínios, demandas, laudos, histórico de "Reserva dos Camarás") não têm `user_id`. Para coexistir com o novo modelo:

- Adicionar coluna `user_id UUID DEFAULT NULL` (nullable para não quebrar registros existentes)
- Criar policy temporária que permite acesso se `user_id IS NULL OR user_id = auth.uid()`
- Rodar UPDATE para vincular os registros legados ao user_id do Matheus (admin_v8s)
- Depois remover a condição `IS NULL` das policies

Esse processo está documentado como "Frente 2" na tarefa `pausa-rls-supabase.md`.

### LGPD

Os dados de condôminos (nome, email, telefone, dados de planilhas de importação) estão sem controle de acesso auditável. Para conformidade mínima com LGPD:

- Controle de acesso por usuário autenticado (RLS + roles)
- Log de acesso: quem acessou quais dados e quando (o Supabase tem logs de API, mas não há log de negócio no sistema)
- Política de retenção: dados de condôminos removidos do Supabase quando o contrato com o condomínio terminar
- Termo de consentimento: os condôminos precisam saber que seus dados são processados

---

## SEÇÃO 4: Roadmap em ondas

### Onda 0: Fundação de segurança (prerequisito para tudo)

**Escopo:**
- Frente 1: habilitar RLS nas 4 tabelas com policy de transição `USING (user_id = auth.uid() OR user_id IS NULL)`
- Frente 2: adicionar coluna `user_id UUID DEFAULT NULL` nas 4 tabelas
- Frente 3: UPDATE de status legado `'aberta'` para `'Pendente'` no Supabase Studio
- Frente 4: fix issue 3102 ALTA (audio-log innerHTML com e.message)
- Frente 5: condicionar ou desligar cpSeedParaSupabase antes de ligar RLS
- Frente 6: substituir supaFetch por supaFetchRich ou adicionar logging explícito
- Fix do bug condominio_id em dcSalvarDemandas
- Fix do TypeError em cpRenderSidebar (c.nome nullable)
- Instalar pre-commit hook anti-token (tarefa precommit-anti-token-pausada.md)
- Fix issue 3736 e issue 3846 (XSS em renderConsumoGrid e addHistorico)

**Prerequisitos:** nenhum (essa onda é o prerequisito para todas as outras)

**Estimativa de esforço:** 3 a 4 semanas no ritmo atual (1 a 2 tarefas por semana, cada tarefa com o fluxo completo de 8 subagentes)

**Riscos:** ligar RLS sem condicionar cpSeedParaSupabase cria o loop silencioso descrito na Seção 2. A ordem das frentes importa: sempre Frente 5 antes de Frente 1.

### Onda 1: Funcionalidades operacionais

**Escopo:**
- Fix do bug 403 na busca de condomínios em Configurações
- Validação da aba Caixa de Entrada no painel Condomínios
- Conciliação bancária (panel-financeiro, hoje placeholder)
- Previsão orçamentária (mencionada como prioridade de Matheus)
- Atas melhoradas: geração automática via Claude em vez de copiar para o chat
- Relatório PDF/Word exportável diretamente do hub (hoje abre janela de impressão)

**Prerequisitos:** Onda 0 concluída (especialmente os fixes de XSS e o bug de condominio_id)

**Estimativa de esforço:** 4 a 6 semanas

**Riscos:** o painel de conciliação bancária exige entender o formato do extrato bancário dos bancos que os condomínios usam. Isso requer que Matheus forneça exemplos reais de extrato antes de qualquer linha de código.

### Onda 2: Multiusuário e SaaS

**Escopo:**
- Tela de login com Supabase Auth (email + senha)
- Proteção da rota /hub: redirect para login se não autenticado
- Validação de JWT nas rotas do server.js (AssemblyAI, Claude)
- Tabela `condominio_users` para isolamento por usuário
- Roles: admin_v8s, operador_v8s, sindico
- Policies RLS baseadas em roles
- Migração de dados legados para user_id do Matheus
- Tela de gerenciamento de usuários (admin_v8s pode criar/remover usuários)
- Onboarding de síndico: link de acesso individual com permissão limitada ao próprio condomínio

**Prerequisitos:** Onda 0 + RLS ativado e funcional, Onda 1 estável em produção

**Estimativa de esforço:** 8 a 12 semanas. Essa é a onda de maior risco técnico porque afeta autenticação, que não pode ter falha parcial.

**Riscos:** o maior risco é a fase de transição, onde o sistema precisa continuar operando para Matheus enquanto o login é construído. A estratégia é manter a URL `/hub` funcional sem login durante o desenvolvimento, e ativar o guard de autenticação apenas no final da onda, após todos os testes.

### Onda 3: Escala e qualidade de código

**Escopo:**
- Separar index.html em arquivos JS/CSS modulares com build step (Vite ou esbuild, sem framework)
- CI/CD: GitHub Actions rodando lint + auditoria de tokens antes de cada deploy
- Testes básicos: Playwright para os 3 fluxos críticos (importar despesas, importar unidades, salvar demandas)
- Monitoramento: Railway Observability ou Sentry para erros de servidor
- Avaliar mover agents files (`~/.claude/agents/`) para dentro do repo (pendência f)
- Normalização do schema Supabase: `processado_em` para `created_at`, `condominio_id` de string para UUID consistente

**Prerequisitos:** Ondas 0, 1 e 2 concluídas. O sistema deve estar estável antes de mexer na estrutura de arquivos.

**Estimativa de esforço:** 6 a 10 semanas. A separação do index.html é o item de maior esforço e risco.

**Riscos:** separar o arquivo único sem quebrar o sistema requer um build step. Isso adiciona complexidade operacional (node_modules mais pesado, comando de build antes do deploy). Railway suporta isso via nixpacks, mas o server.js precisaria mudar para servir a pasta de output do build em vez de `public/` diretamente.

---

## SEÇÃO 5: Evoluir o Hub atual vs Service Hub 2.0 do zero

### Caminho A: Evoluir o Hub atual

**Prós:**
- Código funcional validado em produção com condôminos reais. Importação de despesas, unidades, geração de atas, leitura de consumo, painel de condomínios com demandas do Reserva dos Camarás: tudo isso funcionou e entregou valor real.
- 18 tarefas concluídas representam um histórico de decisões de negócio codificadas (como o formato do payload para Inquilino e Dependente na API Superlógica, os campos obrigatórios, o tratamento de erros de cada endpoint).
- Integrações testadas: os comportamentos dos proxies da Superlógica, AssemblyAI e Anthropic foram descobertos via tentativa e erro e estão codificados nas funções.
- Zero downtime durante a evolução: o sistema continua servindo enquanto cada nova funcionalidade é adicionada.
- A stack (Node.js, HTML vanilla, Supabase) é simples o suficiente para Matheus entender o que está acontecendo quando o arquiteto explica.

**Contras:**
- 5338 linhas em um arquivo único: não tem como fazer code review significativo, não tem como fazer diff de funcionalidade, não tem como debugar com breakpoints de módulo.
- Sem framework: cada padrão de UI (tabs, modais, dropdowns, toasts) está reimplementado manualmente. Manter consistência entre 127 funções num arquivo único depende de convenção, não de estrutura.
- Sem testes: cada mudança pode quebrar algo que funcionava. O validador manual não tem como cobrir todos os casos.
- Dívida técnica acumulada: as 3 issues de XSS abertas, o bug de condominio_id, o schema divergente no Supabase, o RLS desligado, a ausência de autenticação. Cada onda de evolução vai empurrar mais dívida se não houver um plano de quitação.
- Para se tornar SaaS, o arquivo único precisaria de um build step de qualquer jeito. O CSS embutido de 970 linhas precisaria de separação. O JS de ~3400 linhas precisaria de módulos. Isso é uma refatoração de meses dentro do Caminho A.

**O que seria necessário para escalar o Caminho A:**
1. Criar um script de build (esbuild ou Vite em modo vanilha, sem framework) que concatena arquivos CSS e JS modulares em um único output
2. Reorganizar o index.html em um arquivo de estrutura HTML puro (menos de 500 linhas) que referencia os outputs do build
3. Manter o server.js servindo o output do build
4. Adicionar step de build no Railway (nixpacks detecta automaticamente se houver script `build` no package.json)
5. Esse processo pode ser feito incrementalmente, movendo um painel por vez para arquivo separado

### Caminho B: Service Hub 2.0 do zero

**Prós:**
- Arquitetura limpa desde o primeiro dia: roteamento, autenticação, autorização, testes, CI/CD podem ser projetados corretamente sem carregar as decisões do passado.
- Framework moderno (React/Vue/Svelte): componentes, estado gerenciado, hot reload, ecosistema de bibliotecas maduras.
- TypeScript: erros de tipo capturados em build, não em runtime em produção.
- Testes desde o dia 1: a estrutura modular de um framework permite escrever testes unitários e de integração de verdade.

**Contras:**
- Reescrever tudo significa jogar fora 18 tarefas concluídas de lógica de negócio. As decisões sobre os payloads da Superlógica, os formatos de data, os campos obrigatórios de cada endpoint: tudo isso teria que ser redescoberto.
- Em um projeto onde Matheus não programa e o único "dev" é o Claude Code via linha de comando, aprender a estrutura de um framework moderno (Next.js, Nuxt, SvelteKit) adiciona uma camada de complexidade que não gera valor para o usuário final imediatamente.
- Risco de nunca terminar: projetos de reescrita total tendem a ficar em desenvolvimento por meses enquanto o produto atual continua servindo usuários reais. A V8S tem condomínios reais usando o sistema agora.
- O período de transição: dois sistemas em paralelo, sincronizando dados do Supabase, decidindo quando desligar o antigo. Isso é complexidade operacional que não existe no Caminho A.

**O que seria necessário:**
1. Escolha de stack: React (Next.js) ou Vue (Nuxt) ou Svelte (SvelteKit), cada um com trade-offs
2. Configuração de TypeScript, ESLint, Prettier, Vitest/Jest, Playwright
3. Recriar os 11 painéis com a lógica de negócio das 127 funções, revalidando cada integração
4. Migração de dados: o Supabase continua o mesmo, mas as chamadas precisam ser reescritas com o cliente oficial `@supabase/supabase-js`
5. Período de transição: 2 a 4 meses onde nenhuma funcionalidade nova é entregue

### Recomendação fundamentada: Caminho A com modularização incremental

**O arquiteto recomenda o Caminho A, com ajuste estrutural planejado para a Onda 3.**

A justificativa é em 3 partes:

**Parte 1: o produto precisa continuar rodando.** A V8S tem condomínios reais usando o sistema. Matheus tem metas operacionais que dependem das funcionalidades existentes. Parar para reescrever do zero significa que nenhum valor é entregue por meses. O Caminho A permite que Onda 0 (segurança) e Onda 1 (funcionalidades) avancem imediatamente enquanto o sistema está em produção.

**Parte 2: a complexidade do Caminho B não é justificada pelo tamanho atual do problema.** O hub hoje tem 11 painéis e 127 funções. Isso é complexidade gerenciável com um build step e modularização de arquivos, sem precisar de um framework completo. A Onda 3 propõe exatamente isso: separar index.html em módulos JS com esbuild, manter o server.js, manter o Supabase. O resultado final é arquitetura limpa sem o risco da reescrita total.

**Parte 3: o único dev é o Claude Code.** Frameworks modernos (Next.js, Nuxt, SvelteKit) têm opinionated patterns que o arquiteto precisaria ensinar ao Matheus para ele validar o que está sendo construído. HTML vanilla com módulos JS é algo que Matheus consegue ler e entender quando o arquiteto explica o que está na tela. A barreira de validação é menor, o que acelera o ciclo de aprovação.

**O que a recomendação implica na prática:** executar as Ondas 0, 1 e 2 conforme descrito, com o arquivo único (respeitando o limite de 7000 linhas). Quando o sistema tiver login, RLS e pelo menos 3 clientes reais, iniciar a Onda 3 de modularização. Nesse ponto, a refatoração de estrutura terá justificativa clara (time maior, testes necessários, clientes reais dependendo de estabilidade).

O Caminho B só faria sentido se: (a) o sistema atual estivesse com bugs críticos irrecuperáveis, ou (b) a meta fosse contratar um dev humano que precisaria de um codebase convencional para trabalhar. Nenhuma das duas condições existe hoje.

---

Arquivos lidos para esta análise:
- `server.js` (75 linhas)
- `public/index.html` (5338 linhas, leitura em blocos)
- `public/landing.html` (737 linhas)
- `CLAUDE.md`
- `CHANGELOG.md` (235 linhas)
- `package.json`
- `MIGRATION_ETAPA1.sql`
- `MIGRATION_CONDOMINIOS_SUPERLOGICA.sql`
- `service-hub.md`
- `.gitignore`
- `.claude/settings.local.json`
- `supabase/.temp/linked-project.json`
- `supabase/.temp/project-ref`
- `tarefas/em-andamento/seguranca-supabase-rls.md`
- `tarefas/em-andamento/pausa-rls-supabase.md`
- `tarefas/em-andamento/bug-403-busca-condominios-configuracoes.md`
- `tarefas/em-andamento/validar-aba-caixa-de-entrada-condominios.md`
- `tarefas/em-andamento/precommit-anti-token-pausada.md`
- `tarefas/em-andamento/validar-fluxo-cli-commit-adiada.md`
