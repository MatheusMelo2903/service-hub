# TAREFA: ata fidelidade v3

## O que eu quero
Elevar a confiabilidade do gerador de atas do Service Hub para igualar ou superar a skill ata condominial em fidelidade factual, corrigindo três classes de erro identificadas em teste real (Happy Days Manguinhos e Lara Hoffman): números inventados ou trocados, nomes próprios completados por chute, e fatos relevantes da transcrição omitidos.

## Por que eu quero
A ata gerada pelo Hub estava de excelente qualidade formal mas preenchia lacunas da transcrição com palpite plausível em vez de marcar a confirmar, e omitia fatos relevantes (composição da arrecadação, meses de superávit, renegociação com CESAN). A skill ata condominial faz o oposto e foi o padrão a perseguir.

## Critério de aceite
- [x] System prompt do gerador ganha bloco de regras de fidelidade com prioridade máxima sobre fluência
- [x] Etapa de auto revisão (segundo passe na API) compara a ata gerada com a transcrição e substitui por a confirmar tudo que a transcrição não sustenta
- [x] Verificado que não existia etapa anterior de resumo ou truncamento da transcrição (frontend já enviava transcrição inteira)
- [x] Teste Happy Days passa em 3 dos 4 pontos do passo 5 (votos do CF, administradora sem invenção, fatos do exercício)
- [ ] Critério 2 do passo 5 falhou: ata saiu como "Eriton" apenas, não "Wellington (Eriton)" — fica registrado como limitação atual; ver seção limitações

## Arquivos mexidos
- server.js (+92 linhas)
  - REGRAS_FIDELIDADE_TRANSCRICAO: nova constante com as 5 regras de fidelidade
  - PROMPT_AUDITORIA: nova constante com instrução para o segundo passe
  - auditarFidelidadeAta(ataGerada, userMessageOriginal): nova função que faz chamada Sonnet 4.6 (max_tokens 16000) e devolve a ata corrigida ou null em caso de falha
  - entregarAtaAuditada helper local dentro do endpoint, encadeado nas 3 tentativas existentes, re-validando a saída do segundo passe com validarAta para preservar invariante "toda ata entregue ao frontend passou por validarAta"
  - System prompt assembly (linha 508) passa a concatenar + REGRAS_FIDELIDADE_TRANSCRICAO

Arquivos NÃO mexidos:
- public/index.html: o frontend já enviava a transcrição inteira sem truncar nem resumir (linha 4617 do gerarAtaIA postada via POST /api/atas/gerar)
- skills-server/ata-condominial.md: o padrão visual da skill manteve intocado; a regra FID 5 da fidelidade traz exceção explícita para travessões em endereço, linha de cargo das assinaturas e título de anexo

## Restrições respeitadas
- Sem hífen ou travessão no corpo da ata exceto literais técnicos e exceções da SKILL.md (endereço, assinatura, anexo)
- Edições só em server.js, sem mexer no HTML único do Hub que já está em ~7230 linhas
- Não toquei na chamada existente do frontend, nenhuma quebra de interface
- Push só via Terminal, não pelo browser

## Plano e revisão
Antes do commit foram acionados 4 subagentes em paralelo conforme fluxo CLAUDE.md:

### validator
node --check em server.js, auth-bootstrap.js e JS extraído de public/index.html: 0 erros. Pronto para commit.

### security auditor
APROVADO: nenhum dado pessoal novo em log; nenhum endpoint, parâmetro ou middleware novo; ANTHROPIC_KEY reusada via wrapper existente sem novo ponto de leitura; auditMessage nunca serializado fora.
Observação não bloqueante: o segundo passe dobra (ou quadruplica no fallback Opus) o custo Anthropic por geração. Rate limit dedicado em /api/atas/gerar é dívida pré-existente, agravada por essa mudança. Sugerido item para sprint próximo: rate limit por session (ex. 10 req/min por sub do JWT) em rotas de IA.

### architect
APROVADO com 2 ajustes obrigatórios (aplicados):
1. max_tokens da auditoria reduzido de 20000 para 16000, alinhado com a regra do reviewer.md.
2. Auditoria re-validada com validarAta antes de devolver, preservando invariante existente.
Dívidas registradas:
- Feature flag ENABLE_ATA_AUDIT para desligar rápido em produção se rate limit apertar (não aplicada agora)
- Timeout próprio mais curto para o segundo passe (60s em vez do default 120s, não aplicada agora)
- Consolidar REGRAS_ANTI_ERRO e REGRAS_FIDELIDADE_TRANSCRICAO em iteração futura (sobreposição semântica entre anti-invenção e FID 1, FID 2, FID 3)

### reviewer
APROVADO em consistência de marcador "[a confirmar]", modelo claude-sonnet-4-6 coerente, exceções de travessão claras, e fallback seguro em caso de erro do segundo passe.
REPROVADO em max_tokens 20000 e em auditoria sem revalidação. AMBOS corrigidos no commit final antes do push.

## Teste de regressão
Rodado outputs/run-teste-happy-days.sh com transcrição real (~/Downloads/Transcrição - happy days.txt, 29033 chars):

- HTTP 200 em 174s, ata 14924 chars
- modelo_usado claude-sonnet-4-6, fallback false
- 1 tentativa, validação ok
- auditoria aplicada (segundo passe rodou e validarAta aprovou)

Validador outputs/validar-fidelidade-v3.js rodado sobre a ata gerada, com os 4 pontos do passo 5:

| Critério | Resultado | Detalhe |
|---|---|---|
| 1. Votos do Conselho Fiscal idênticos | passou | Dari=19, Dani=21, Pabllo=7, Paulo=18, par legítimo Eriton/Débora=23 cada (cédulas distintas), sem replicação espúria entre Dari e Dani |
| 2. Wellington (Eriton) preservado em corpo e assinatura | falhou | Ata saiu como "Eriton [sobrenome a confirmar]" apenas, sem Wellington. Wellington aparece 1 vez na transcrição (provavelmente ruído de transcrição automática); modelo escolheu a forma mais frequente. FID 3 manda registrar AMBOS, mas o segundo passe não pegou |
| 3. Administradora sem sobrenomes inventados | passou | "Sr. Cheinori [sobrenome a confirmar]" presente; sem Pabodo, sem Porfilho |
| 4. Fatos do exercício: 762 mil + meses superávit + CESAN | passou | "R$ 762.000,00", "cinco (5) apresentaram resultado mensal positivo", CESAN mencionado |

Resultado: 3 dos 4 critérios passaram.

## Limitações atuais
- Critério 2 do passo 5 falhou no teste Happy Days. A transcrição automática tem ambiguidade real (Wellington aparece 1x, Eriton aparece muitas vezes). O modelo, mesmo com FID 3 nova, decidiu adotar a forma mais frequente em vez de registrar "Wellington (Eriton)". Caminhos para iteração: (i) reforçar FID 3 dando exemplo concreto do caso Happy Days no system prompt; (ii) adicionar regra explícita "quando há QUALQUER variação do nome do síndico na transcrição, registrar TODAS entre parênteses"; (iii) refazer teste com mesma versão do código para ver se é falha consistente ou flake.
- Teste do Lara Hoffman ficou pendente: transcrição não existia no repo nem em ~/Downloads/. Quando Matheus passar o arquivo, rodar mesmo pipeline.
- Rate limit dedicado em /api/atas/gerar continua dívida pré-existente, agravada pela duplicação de chamadas por geração. Abrir tarefa separada.

## Mudanças no fluxo do endpoint
Antes (server.js):
```
generate → validar → res.json(ata)
```
Depois:
```
generate → validar → auditar → re-validar → res.json(ata final ou original)
```
Sem mudança de interface: o payload do frontend continua igual, e ganha um campo opcional auditoria com valor "aplicada", "falhou_usou_original" ou "rejeitada_validacao_usou_original" para observabilidade.

## Status
- [x] Tarefa escrita
- [x] Plano feito pelo arquiteto (acionado em paralelo com os outros)
- [x] Plano aprovado pelo Matheus (resposta no chat ao plano técnico)
- [x] Código implementado
- [x] Código revisado (subagente reviewer)
- [x] Correções aplicadas (max_tokens 16k e re-validação)
- [x] Auditoria de segurança aprovada (subagente security-auditor)
- [x] Validação aprovada (subagente validator)
- [x] Documentação atualizada (este arquivo)
- [ ] Lara Hoffman testado (pendente do arquivo)
- [ ] Critério 2 Happy Days resolvido (a iterar)
