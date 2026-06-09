-- Migration: previsoes_geracoes - historico de geracoes de PPTX/PDF.
-- Data: 2026-06-02
-- Aplicar EM DEV primeiro. PROD pendente autorizacao explicita.
-- N geracoes por rascunho (uma linha por chamada de /gerar).
-- IDEMPOTENTE.

CREATE TABLE IF NOT EXISTS public.previsoes_geracoes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  previsao_id  UUID        NOT NULL REFERENCES public.previsoes_orcamentarias(id) ON DELETE CASCADE,
  payload_hash TEXT        NOT NULL,
  pdf_url      TEXT,
  pptx_url     TEXT,
  gerado_por   UUID        NOT NULL REFERENCES auth.users(id),
  gerado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  duracao_ms   INT
);

CREATE INDEX IF NOT EXISTS geracoes_previsao_em_idx
  ON public.previsoes_geracoes(previsao_id, gerado_em DESC);

CREATE INDEX IF NOT EXISTS geracoes_hash_idx
  ON public.previsoes_geracoes(payload_hash);

ALTER TABLE public.previsoes_geracoes ENABLE ROW LEVEL SECURITY;

-- SELECT: GESTOR/GERENTE veem todas; OPERACIONAL ve so as que gerou.
DROP POLICY IF EXISTS "geracao_select" ON public.previsoes_geracoes;
CREATE POLICY "geracao_select" ON public.previsoes_geracoes
  FOR SELECT TO authenticated
  USING (
    COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') IN ('GESTOR', 'GERENTE')
    OR gerado_por = auth.uid()
  );

-- INSERT: server.js insere via service_role (bypassa RLS); policy de fallback.
DROP POLICY IF EXISTS "geracao_insert" ON public.previsoes_geracoes;
CREATE POLICY "geracao_insert" ON public.previsoes_geracoes
  FOR INSERT TO authenticated
  WITH CHECK (gerado_por = auth.uid());

-- DELETE: somente GESTOR (registros de auditoria nao devem sumir).
DROP POLICY IF EXISTS "geracao_delete" ON public.previsoes_geracoes;
CREATE POLICY "geracao_delete" ON public.previsoes_geracoes
  FOR DELETE TO authenticated
  USING (
    COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR'
  );
