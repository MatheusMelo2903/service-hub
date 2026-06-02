-- Migration: previsoes_orcamentarias + RLS por role + cache hash
-- Data: 2026-06-02
-- Aplicar EM DEV primeiro (ledgyprytkuvgtbunsck). PROD pendente autorização explícita.
--
-- Entrega 1 (esta migration): tabela de rascunhos de previsão orçamentária.
-- Cache por hash MD5 (payload_hash TEXT) evita escrita desnecessária no banco
-- quando o usuário salva sem ter alterado nada.
-- RLS Opção C: OPERACIONAL vê só os seus; GESTOR/GERENTE veem todos.
--
-- IDEMPOTENTE — pode rodar 2x sem efeito colateral.

CREATE TABLE IF NOT EXISTS public.previsoes_orcamentarias (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  condominio_id    UUID NOT NULL REFERENCES public.condominios(id) ON DELETE CASCADE,
  ano_referencia   INT  NOT NULL CHECK (ano_referencia BETWEEN 2000 AND 2100),
  periodo          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'rascunho'
                     CHECK (status IN ('rascunho', 'publicado', 'arquivado')),
  payload_json     JSONB NOT NULL,
  payload_hash     TEXT NOT NULL,
  criado_por       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.previsoes_orcamentarias
  DROP CONSTRAINT IF EXISTS uq_previsao_rascunho_por_cond_ano;
ALTER TABLE public.previsoes_orcamentarias
  ADD CONSTRAINT uq_previsao_rascunho_por_cond_ano
    UNIQUE (condominio_id, ano_referencia, status)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS previsoes_cond_ano_status_idx
  ON public.previsoes_orcamentarias(condominio_id, ano_referencia, status);
CREATE INDEX IF NOT EXISTS previsoes_criado_por_idx
  ON public.previsoes_orcamentarias(criado_por);
CREATE INDEX IF NOT EXISTS previsoes_hash_idx
  ON public.previsoes_orcamentarias(payload_hash);

CREATE OR REPLACE FUNCTION public.set_previsao_atualizado_em()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_previsao_atualizado_em ON public.previsoes_orcamentarias;
CREATE TRIGGER trigger_previsao_atualizado_em
  BEFORE UPDATE ON public.previsoes_orcamentarias
  FOR EACH ROW EXECUTE FUNCTION public.set_previsao_atualizado_em();

ALTER TABLE public.previsoes_orcamentarias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "previsao_select" ON public.previsoes_orcamentarias;
CREATE POLICY "previsao_select" ON public.previsoes_orcamentarias
  FOR SELECT TO authenticated
  USING (
    COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') IN ('GESTOR', 'GERENTE')
    OR criado_por = auth.uid()
  );

COMMENT ON POLICY "previsao_select" ON public.previsoes_orcamentarias IS
  'Entrega 1 (2026-06-02): GESTOR/GERENTE veem todas as previsões; ' ||
  'OPERACIONAL vê apenas as que ele criou. ' ||
  'Padrão Opção C — sem tenant_id, controle por role do JWT app_metadata.';

DROP POLICY IF EXISTS "previsao_insert" ON public.previsoes_orcamentarias;
CREATE POLICY "previsao_insert" ON public.previsoes_orcamentarias
  FOR INSERT TO authenticated
  WITH CHECK (criado_por = auth.uid());

COMMENT ON POLICY "previsao_insert" ON public.previsoes_orcamentarias IS
  'Qualquer usuário autenticado pode inserir, mas só com criado_por = auth.uid().';

DROP POLICY IF EXISTS "previsao_update" ON public.previsoes_orcamentarias;
CREATE POLICY "previsao_update" ON public.previsoes_orcamentarias
  FOR UPDATE TO authenticated
  USING (
    COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') IN ('GESTOR', 'GERENTE')
    OR criado_por = auth.uid()
  )
  WITH CHECK (
    COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') IN ('GESTOR', 'GERENTE')
    OR criado_por = auth.uid()
  );

DROP POLICY IF EXISTS "previsao_delete" ON public.previsoes_orcamentarias;
CREATE POLICY "previsao_delete" ON public.previsoes_orcamentarias
  FOR DELETE TO authenticated
  USING (
    COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR'
  );

COMMENT ON POLICY "previsao_delete" ON public.previsoes_orcamentarias IS
  'Somente GESTOR pode deletar rascunhos. GERENTE e OPERACIONAL não deletam.';
