-- 2026-06-11 — Frente B (superlogica-sync) — Migração 008 de 010
-- Camada A: tabela NOVA `unidades` (espelho local das unidades da Superlógica).
--
-- Origem dos dados: GET /unidades?idCondominio=X (REST v2 condor), só leitura.
-- A carga é full read por condomínio + diff por raw_hash (sem delta nativo).
--
-- FLAG DE REVIEW (decidir antes de aplicar):
--   (a) id_unidade_uni é BIGINT, não INT. O id da Superlógica pode passar de
--       2,1 bi (limite int4) numa carteira grande; BIGINT evita overflow.
--   (b) Índice único com NULLS NOT DISTINCT (Postgres 15+, Supabase roda 15+):
--       garante que bloco vazio/nulo não fure a idempotência do upsert.
--   Se preferir INT ou índice clássico, avise que eu troco.
--
-- IDEMPOTENTE. APLICAR EM DEV PRIMEIRO.

CREATE TABLE IF NOT EXISTS public.unidades (
  id_unidade_uni  bigint      PRIMARY KEY,                  -- id da Superlógica (chave de origem)
  condominio_id   uuid        NOT NULL
                  REFERENCES public.condominios(id) ON DELETE CASCADE,
  st_unidade_uni  text,                                     -- número/identificação da unidade
  st_bloco_uni    text,                                     -- bloco (pode ser nulo/vazio)
  raw_hash        text,                                     -- hash do payload cru (diff incremental)
  synced_at       timestamptz                               -- última sincronização desta unidade
);

-- Chave natural para idempotência do upsert (condominio + unidade + bloco).
-- NULLS NOT DISTINCT trata bloco NULL como valor comparável, evitando duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS unidades_natural_key_uidx
  ON public.unidades (condominio_id, st_unidade_uni, st_bloco_uni)
  NULLS NOT DISTINCT;

-- Acesso por condomínio (seletor do Hub, sync por condomínio).
CREATE INDEX IF NOT EXISTS unidades_condominio_id_idx
  ON public.unidades (condominio_id);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Escrita real vem do serviço superlogica-sync via service_role (bypassa RLS).
-- As policies abaixo governam o acesso do FRONTEND (JWT do usuário):
--   - SELECT liberado a qualquer usuário logado (o seletor do Hub precisa ler).
--   - Escrita restrita a GESTOR, lendo o role direto do JWT
--     (auth.jwt()->'app_metadata'->>'role'), SEM subquery (evita recursão).
ALTER TABLE public.unidades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_select" ON public.unidades;
CREATE POLICY "authenticated_select" ON public.unidades
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "gestor_escreve" ON public.unidades;
CREATE POLICY "gestor_escreve" ON public.unidades
  FOR ALL TO authenticated
  USING      (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR')
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR');

-- VALIDAÇÃO:
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public' AND tablename='unidades';        -- rowsecurity = true
-- SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname='public' AND tablename='unidades';        -- 2 policies
