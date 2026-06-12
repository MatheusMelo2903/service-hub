-- 2026-06-11 — Frente B (superlogica-sync) — Migração 010 de 010
-- Camada B: tabela NOVA `condominio_contexto` (briefing .md por condomínio).
--
-- DECISÃO TRAVADA: a Camada B é COLUNA numa tabela com content_hash, NÃO arquivo
-- no Storage. O .md é gerado deterministicamente da Camada A (template, ZERO IA,
-- custo zero) e só regenerado quando o content_hash muda.
--
-- 1 linha por condomínio (PK = condominio_id), por isso PK é também a FK.
--
-- IDEMPOTENTE. APLICAR EM DEV PRIMEIRO.

CREATE TABLE IF NOT EXISTS public.condominio_contexto (
  condominio_id  uuid  PRIMARY KEY
                 REFERENCES public.condominios(id) ON DELETE CASCADE,
  md             text,                                      -- briefing markdown determinístico
  content_hash   text,                                      -- hash do md; regenera só se mudar
  gerado_em      timestamptz                                -- carimbo da última geração
);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Mesma postura das 008/009. SELECT a usuário logado; escrita só GESTOR.
-- Geração real entra via service_role (bypassa RLS).
ALTER TABLE public.condominio_contexto ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_select" ON public.condominio_contexto;
CREATE POLICY "authenticated_select" ON public.condominio_contexto
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "gestor_escreve" ON public.condominio_contexto;
CREATE POLICY "gestor_escreve" ON public.condominio_contexto
  FOR ALL TO authenticated
  USING      (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR')
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR');

-- VALIDAÇÃO:
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public' AND tablename='condominio_contexto';  -- true
-- SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname='public' AND tablename='condominio_contexto';  -- 2 policies
