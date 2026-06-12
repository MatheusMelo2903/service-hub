-- 2026-06-11 — Frente B (superlogica-sync) — Migração 009 de 010
-- Camada A: tabela NOVA `pessoas` (contatos vinculados a uma unidade).
--
-- Origem: contatos embutidos no payload de /unidades (Proprietário, Inquilino,
-- Dependente). Só leitura na Superlógica. `nome` é PII; ver nota de RLS.
--
-- FLAG DE REVIEW: id_contato_con e unidade_id são BIGINT (mesmo motivo da 008:
-- ids da Superlógica + consistência com unidades.id_unidade_uni, que é bigint).
--
-- IDEMPOTENTE. APLICAR EM DEV PRIMEIRO.

CREATE TABLE IF NOT EXISTS public.pessoas (
  id_contato_con  bigint  PRIMARY KEY,                      -- id do contato na Superlógica
  unidade_id      bigint  NOT NULL
                  REFERENCES public.unidades(id_unidade_uni) ON DELETE CASCADE,
  tipo            text,                                     -- Proprietário | Inquilino | Dependente
  nome            text,                                     -- PII
  raw_hash        text                                      -- hash do payload cru (diff incremental)
);

CREATE INDEX IF NOT EXISTS pessoas_unidade_id_idx
  ON public.pessoas (unidade_id);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Mesma postura da 008. `nome` é PII: SELECT liberado a usuário logado mantém
-- a mesma exposição que o Hub já tem hoje (dados de proprietário aparecem na UI
-- sob JWT autenticado). Escrita só GESTOR; sync real entra via service_role.
ALTER TABLE public.pessoas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_select" ON public.pessoas;
CREATE POLICY "authenticated_select" ON public.pessoas
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "gestor_escreve" ON public.pessoas;
CREATE POLICY "gestor_escreve" ON public.pessoas
  FOR ALL TO authenticated
  USING      (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR')
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR');

-- VALIDAÇÃO:
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public' AND tablename='pessoas';         -- rowsecurity = true
-- SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname='public' AND tablename='pessoas';         -- 2 policies
