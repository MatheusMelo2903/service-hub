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

Diagnóstico após segunda passada de validação (greps mecânicos em 2026-04-29):

| Item | Estado real | Ação |
|---|---|---|
| 1. Anthropic direto no browser | grep `api.anthropic.com` zero matches. Caller real linha 3694 usa `/api/claude/messages` via proxy | Apenas documentar como já corrigido |
| 2. Status `aberta` em Demandas | grep retorna 1 match único na linha 4693 em `dcSalvarDemandas`. Zero filtros, conditionals ou queries dependem do valor | **Trocar literal `'aberta'` por `'Pendente'`** |
| 3. buildUrl fallback api.superlogica.net | grep 2 matches, ambos em comentários explicando para NÃO usar (linhas 2649 e 2916). Função retorna null e callers checam | Documentar como já corrigido |
| 4. loadConfig XSS condNome/condId | grep `innerHTML.*c\.(condNome\|condId)` zero matches. loadConfig usa `document.createTextNode` na linha 1952 | Documentar como já corrigido |
| 5. searchCondominio Configurações | linha 3385 a 3402 usa DOM API (`createElement`, `textContent`, `dataset`, `addEventListener`). Comentário explícito "para evitar XSS" | Documentar como já corrigido |
| 6. addLog dados HTTP via innerHTML | linha 3834 já aplica `escHtml(now), escHtml(type), escHtml(msg)` | Documentar como já corrigido |
| 7. Toast global interpola msg via innerHTML | linha 3855 usa template literal com `${msg}` direto. Mais de 60 callers. Lista B (callers com `${variável}`) tem cerca de 30 itens, **nenhum com tag HTML intencional** (grep `toast\(.*<[a-z]+` zero matches) | **Reescrever toast com DOM API + textContent** |
| 8. cpRenderSidebar c.nome via innerHTML | linha 4065 a 4072 interpola `c.nome` (string livre do Supabase), `c.id` (UUID) e `iniciais` (derivado de c.nome). `c.id` entra dentro de `onclick="cpSelecionarCond('${c.id}')"`, contexto de atributo com aspas simples | **Escapar c.nome, c.id e iniciais** |

### Estratégia de implementação na ordem

Primeiro item 7 (toast, maior superfície). Depois item 8 (cpRenderSidebar, vetor via Supabase). Por último item 2 (bug lógico isolado).

### Mudanças propostas item a item

**Item 7, toast linha 3850 a 3857.** Reescrever a função usando DOM API. Substituir `t.innerHTML = template` por construção via `createElement` + `textContent`. Estrutura mantida: span do ícone com cor variável conforme `type`, texto da mensagem como nó de texto. Preservar classe CSS `.toast`, comportamento do `setTimeout` para remoção e o append ao `toast-wrap`. Antes de commitar, varrer `toast(` no arquivo inteiro e confirmar que nenhum caller passa HTML intencional (já validado em segunda passada).

**Item 8, cpRenderSidebar linha 4062 a 4073.** Decisão técnica explicitada: a função `dcEscape` (linha 4658) escapa apenas `&`, `<`, `>`, `"`. NÃO escapa apóstrofo. Como `c.id` entra dentro de `onclick="cpSelecionarCond('${c.id}')"`, contexto de atributo HTML com aspas simples internas, escape de apóstrofo é obrigatório. **Usar `escHtml` (linha 3820) que já escapa apóstrofo**, em `c.nome`, `c.id` e `iniciais`. Razão da escolha: `escHtml` é a função canônica deste arquivo e já cobre todos os caracteres perigosos. Padrão alternativo seria reescrever com DOM API + dataset.id + addEventListener (igual searchCondominio fez), mas isso é mais invasivo. A escolha deve ficar registrada no commit message ou em comentário do bloco corrigido. Iniciais herdam o risco porque derivam de `c.nome.split(' ')`, então também precisam escape.

**Item 2, dcSalvarDemandas linha 4693.** Trocar literal `status: 'aberta'` por `status: 'Pendente'`. Operação de uma linha. Sem dependência com filtros ou renders existentes (validado por grep).

### Pendência registrada (para CHANGELOG e relatório final)

Registros antigos no Supabase com `status='aberta'` continuam existindo após a troca do default. Vão para a seção Pendências do CHANGELOG.md desta rodada com a linha exata para Matheus rodar manualmente:
```sql
UPDATE demandas SET status='Pendente' WHERE status='aberta';
```
A pendência fica rastreada para evitar que o sistema conviva indefinidamente com dois valores de status no banco.

### Issues novos descobertos fora dos 8 itens em escopo (vão para o relatório final, NÃO corrigidos nesta rodada)

| Local | Conteúdo | Vetor de risco | Prioridade |
|---|---|---|---|
| Linha 3102, audio-log innerHTML | `'<span style="color:var(--danger)">' + e.message + '</span>'` | **e.message vem de APIs externas (AssemblyAI, Anthropic)**, não de input local. Risco real de XSS via response controlado pelo provedor | **ALTA** |
| Linha 3736, renderConsumoGrid | `${item.url}` data URL local, `${item.unidade}` input do usuário atual | Self XSS local, atacante ataca a si próprio | Média |
| Linha 3846, addHistorico | `${texto}` interpolado, callers passam variáveis com inputs do usuário (cond, data, integers) | Self XSS local | Média |

### Riscos identificados e mitigação

1. Toast com DOM API quebra caller que passa HTML intencional. Mitigação, varredura confirmou zero callers com tag HTML intencional.
2. Trocar `aberta` por `Pendente` deixa registros antigos inconsistentes. Mitigação, pendência registrada no CHANGELOG.
3. cpRenderSidebar é chamada em vários pontos (cpCarregarDoSupabase 4932, cpSelecionarCond 4095, override de showPanel 4723). Mudança é interna, não afeta assinatura. Sem regressão.

### Critério objetivo de pronto

**Item 2:** `dcSalvarDemandas` grava `status: 'Pendente'`. Nova demanda no Supabase tem `status='Pendente'` verificável via console.

**Item 7:** Função `toast` não usa `innerHTML` para interpolar `msg`. Teste manual no console, `toast('<img src=x onerror=alert(1)>', 'err')` exibe texto literal sem executar. Visual idêntico (ícone, cor, layout).

**Item 8:** `cpRenderSidebar` aplica `escHtml` em `c.nome`, `c.id` e `iniciais`. Teste manual, criar condomínio com nome `<b>teste</b>` no Supabase, sidebar exibe texto literal sem negrito.

**Itens 1, 3, 4, 5, 6:** Documentar no relatório final como verificado em 2026-04-29 e já corrigido em commits anteriores, com referência às linhas atuais que demonstram a correção.

### Pontos de cuidado para o programador

1. Toast com DOM API. Criar `span` do ícone com `textContent = icons[type] || ''` e nó de texto separado para `msg`. Não usar `innerHTML` em parte alguma da função. Estilos inline preservados.
2. cpRenderSidebar com escHtml. Substituir `c.nome`, `c.id` e `iniciais` pelas versões escapadas no template. Não alterar estrutura, classes CSS nem chamada do `onclick`. **Registrar a decisão de usar escHtml em vez de dcEscape no commit message**, conforme orientação de Matheus.
3. Varredura de `toast(` antes de commitar. Reconfirmar que nenhum caller passa HTML intencional. Se encontrar algum, parar e reportar.
4. Registros legados com `status='aberta'`. Documentar no CHANGELOG com SQL sugerido. Não executar nada no Supabase.

## Status
- [x] Tarefa escrita
- [x] Plano feito pelo arquiteto
- [x] Plano aprovado pelo Matheus
- [ ] Código implementado
- [ ] Código revisado
- [ ] Correções aplicadas
- [ ] Auditoria de segurança aprovada
- [ ] Validação aprovada
- [ ] Documentação atualizada
