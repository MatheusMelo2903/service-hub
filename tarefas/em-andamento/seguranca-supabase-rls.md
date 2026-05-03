# Tarefa: Revisar Row Level Security do Supabase antes da Etapa 2

## Contexto
Achado durante o planejamento da tarefa `seguranca-tokens-expostos.md` em 2026-04-27.

## Descrição do achado
No arquivo `public/index.html`, linhas 3244 e 3245, existem hardcoded:

```javascript
const SUPA_URL = 'https://mtucxdfepkwsfnqpfydb.supabase.co';
const SUPA_KEY = 'sb_publishable_LgUqE8qdyvhh6VhLD4c4yg_zo6aWJXH';
```

A chave é do tipo `publishable` (também chamada de anon key), que por design do Supabase é projetada para ficar no frontend. Diferente de chaves secretas, ela NÃO é considerada vazamento de credencial em si.

## Por que isso ainda merece atenção
A segurança real do banco depende da configuração de Row Level Security (RLS) nas tabelas. Se o RLS estiver desligado em alguma tabela, qualquer pessoa que tenha a anon key (que está no frontend) consegue ler ou escrever os dados de qualquer condômino.

Antes da Etapa 2 (login real com Supabase, autenticação por usuário), é obrigatório:

1. Listar todas as tabelas do projeto Supabase em uso
2. Verificar se cada tabela tem RLS ativado
3. Verificar se as policies permitem apenas o que é necessário (princípio do menor privilégio)
4. Especialmente: nenhuma tabela com dados de condôminos pode ter SELECT ou INSERT públicos sem authenticated user

## Risco se não tratar
Sem RLS bem configurado, a anon key no frontend permite que qualquer pessoa que abra o devtools do navegador acesse a base inteira. Em sistema com dados de condôminos isso é GDPR/LGPD risco direto.

## Critérios de aceite
- Todas as tabelas Supabase em uso têm RLS ativado
- Policies revisadas e documentadas
- Nenhuma tabela permite operações não autenticadas além das estritamente necessárias
- Documentar o que cada policy faz e por quê

## Subagente para começar
Auditor de segurança, depois arquiteto se houver mudanças complexas de schema. O Matheus precisa fornecer acesso ao painel do Supabase ou listagem das tabelas e policies atuais.

## Prioridade
Média no curto prazo, ALTA antes de iniciar a Etapa 2 (login com Supabase).

## Achado registrado por
Subagente arquiteto durante planejamento da tarefa `seguranca-tokens-expostos.md` em 2026-04-27.
