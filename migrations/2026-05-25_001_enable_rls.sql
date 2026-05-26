-- Migration: Enable RLS + policies em todas as tabelas
-- Data: 2026-05-25
-- Aplicar EM DEV primeiro. Só em PROD com autorização explícita do Mateus.
--
-- Contexto:
-- Hoje publishable key + anon JWT estão expostos no frontend (index.html e
-- tracker.html). Sem RLS, qualquer pessoa com View Source pode SELECT/INSERT/
-- UPDATE/DELETE em qualquer tabela. Esta migration liga RLS e cria policies
-- mínimas que exigem usuário autenticado (Supabase Auth).
--
-- Entrega 1 (esta migration): "qualquer usuário logado tem acesso total".
-- Entrega 2 (futura): policies granulares por empresa/módulo (não escopo agora).
--
-- IDEMPOTENTE — pode rodar 2x sem efeito colateral.
-- DROP POLICY antes de recriar evita conflito em re-run.

-- ─────────────────────────────────────────────────────────────────────────
-- TABELA: condominios
-- Usada por: public/index.html (linha 3501 SELECT, 3613 POST)
-- Schema: id, nome, id_superlogica, updated_at + colunas legadas
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE condominios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_full_access" ON condominios;
CREATE POLICY "authenticated_full_access" ON condominios
  FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

COMMENT ON POLICY "authenticated_full_access" ON condominios IS
  'Entrega 1 (2026-05-25): qualquer usuário logado tem acesso total. ' ||
  'Entrega 2 substituirá por policies por empresa/módulo.';

-- ─────────────────────────────────────────────────────────────────────────
-- TABELA: hub_progresso — DELIBERADAMENTE FORA DA ENTREGA 1
-- Usada por: public/tracker.html (linha 308 TBL constant; SELECT + UPSERT)
-- Razão: tracker.html é PWA standalone com user-modal próprio (sh_user
-- localStorage). Forçar login Supabase quebra UX offline. Dados são
-- progresso de 20 tarefas internas — risco baixo.
-- Entrega 1.1 (sprint seguinte): adicionar login Supabase no tracker.html
-- e ligar RLS aqui.
-- ─────────────────────────────────────────────────────────────────────────

-- ALTER TABLE hub_progresso ENABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS "authenticated_full_access" ON hub_progresso;
-- CREATE POLICY "authenticated_full_access" ON hub_progresso
--   FOR ALL
--   USING (auth.role() = 'authenticated')
--   WITH CHECK (auth.role() = 'authenticated');

-- ─────────────────────────────────────────────────────────────────────────
-- TABELA: demandas
-- Origem: MIGRATION_ETAPA1.sql (raiz do repo, Caixa de Entrada)
-- Schema: + origem_texto_bruto, processado_em, fonte (colunas adicionadas)
-- Status atual: pode estar sendo usada por feature em desenvolvimento
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE demandas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_full_access" ON demandas;
CREATE POLICY "authenticated_full_access" ON demandas
  FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

COMMENT ON POLICY "authenticated_full_access" ON demandas IS
  'Tabela legada/em desenvolvimento. Acompanhar uso em fluxos futuros.';

-- ─────────────────────────────────────────────────────────────────────────
-- VALIDAÇÃO
-- ─────────────────────────────────────────────────────────────────────────

-- Conferir RLS ligado:
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE schemaname = 'public' AND tablename IN ('condominios', 'demandas');
-- Esperado: rowsecurity = true em todas

-- Conferir policies criadas:
-- SELECT schemaname, tablename, policyname, cmd, qual, with_check
-- FROM pg_policies WHERE schemaname = 'public';
-- Esperado: 1 policy "authenticated_full_access" em cada tabela

-- Teste manual de RLS (executar como anon, deve falhar):
-- SET request.jwt.role = 'anon';
-- SELECT * FROM condominios LIMIT 1;
-- Esperado: 0 rows (ou erro de permissão dependendo da config)

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK (em caso de necessidade)
-- ─────────────────────────────────────────────────────────────────────────

-- ALTER TABLE condominios DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE demandas DISABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS "authenticated_full_access" ON condominios;
-- DROP POLICY IF EXISTS "authenticated_full_access" ON demandas;
