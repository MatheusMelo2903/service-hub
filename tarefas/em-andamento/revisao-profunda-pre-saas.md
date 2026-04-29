# TAREFA: revisão profunda pré SaaS

## O que eu quero
Passar o estado atual do Service Hub por revisão profunda de qualidade e segurança antes de iniciar a evolução para SaaS multi usuário, pegar bugs lógicos, código duplicado, vulnerabilidades, dívida técnica e divergência de padrões que Matheus não tem como identificar visualmente.

## Por que eu quero
Antes de adicionar login, multi tenant e separação de papéis, o código atual precisa estar limpo e auditado, senão a próxima camada vai herdar problemas escondidos.

## Critério de aceite
- [ ] Zero vulnerabilidades críticas reportadas pelo auditor-seguranca
- [ ] Zero bugs críticos reportados pelo revisor
- [ ] Validador confirma 100 por cento das features atuais funcionando
- [ ] CHANGELOG.md raiz e docs/log.md atualizados no formato existente de cada um
- [ ] Deploy em produção com curl 200 em / e em /hub após o push final

## Arquivos que provavelmente vão ser mexidos
- public/index.html
- server.js
- CLAUDE.md
- CHANGELOG.md
- docs/log.md
- ~/.claude/agents/arquiteto.md
- ~/.claude/agents/programador.md

## Restrições
1. Nunca vincular Virtual Service ou V8S ao Grupo Service em comentário, doc, string de UI ou commit message.
2. Nunca usar a expressão Security Service em lugar nenhum.
3. Em todo texto gerado para Matheus ou commit message, substituir hífen por travessão ou vírgula.
4. O arquivo principal é public/index.html, single file, limite de 7000 linhas, deve permanecer assim.
5. Preservar 100 por cento das features que funcionam hoje. Se um subagente sugerir remover algo, ele precisa provar com leitura de código que aquilo é morto.
6. Usar apenas os design tokens já presentes no CSS embutido. Nenhuma cor nova, nenhuma fonte nova, nenhuma biblioteca nova sem aprovação explícita de Matheus.
7. A resposta da pergunta 33 sobre sequestro e coação no totem do gerador de atas, se existir no código, é preservada literalmente, sem reescrita.
8. Tokens do Superlógica nunca aparecem em código frontend, em commit ou em arquivo público. Eles vivem em state.config.condId, state.config.appToken e state.config.accessToken via localStorage por máquina, configurados pela aba Configurações.
9. Edição de arquivo no GitHub é sempre Safari, nunca Chrome.
10. Nenhum push é feito sem revisor e auditor-seguranca aprovados.

## Escopo de correção da revisão (decidido por Matheus em 2026-04-29)
Apenas estes 8 itens entram em correção nesta rodada. Qualquer issue adicional que revisor ou auditor encontrar fora desta lista vira sugestão registrada no relatório final mas NÃO é corrigida nesta rodada, vai para tarefa nova de outra sessão.

Da seção Observações conhecidas de service-hub.md:
1. public/index.html linha próxima a 3005 que chama api.anthropic.com/v1/messages direto do browser na Leitura de Consumo, migrar para o proxy /api/claude/messages.
2. Status aberta usado em Demandas de Cliente que diverge dos valores existentes (Pendente, Em andamento, Concluído, Aguardando síndico), padronizar para um dos valores existentes.

Da seção Issues conhecidos remanescentes de tarefas/concluidas/refatoracao-cond-global-unificacao-painel.md:
3. buildUrl com fallback direto para api.superlogica.net quando proxy vazio, próximo à linha 2507. Deve sempre exigir proxy ou retornar erro claro.
4. loadConfig XSS em c.condNome e c.condId via innerHTML próximo à linha 1818, escapar com dcEscape.
5. searchCondominio do painel Configurações, XSS idêntico ao já corrigido em searchCondominioDash, próximo à linha 2979.
6. addLog em enviarDespesas e enviarConsumo expõe dados HTTP brutos via innerHTML, escapar antes de injetar.
7. Toast global interpola msg via innerHTML, escapar.
8. cpRenderSidebar injeta c.nome via innerHTML sem dcEscape, escapar.

## Exemplos ou referências
Branch local de segurança backup-pre-merge aponta para ee1fc03 (HEAD pré merge). Restaurar com git reset --hard backup-pre-merge se algo der errado durante o pipeline. Apagar só na etapa final.

Commits criados na fase pré pipeline (2026-04-29):
- ee1fc03 feat: fração ideal validada localmente
- 4f53688 merge: reconcilia origin/main com consolidado local
- 972d0ca chore: limpeza pré pipeline de revisão profunda

Evidência de vazamento mitigado, capturada em 2026-04-29 18:43 BRT antes do mover. Os arquivos public/index.html.bak-antes-fracao e public/index.html.bak-pre-fix-uf retornavam HTTP 200 publicamente em https://service-hub-production.up.railway.app/. Após mv para backups/ e push, o catch all do server.js linha 74 devolve a landing.html (40304 bytes) com 200 para essas URLs, comportamento intencional. Validação correta é pelo tamanho do response, não pelo status code.

---

## Plano do arquiteto
[Preenchido pelo subagente arquiteto]

## Status
- [x] Tarefa escrita
- [ ] Plano feito pelo arquiteto
- [ ] Plano aprovado pelo Matheus
- [ ] Código implementado
- [ ] Código revisado
- [ ] Correções aplicadas
- [ ] Auditoria de segurança aprovada
- [ ] Validação aprovada
- [ ] Documentação atualizada
