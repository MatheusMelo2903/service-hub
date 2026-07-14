-- 2026-06-13 — Frente B (superlogica-sync) — Migração 011
-- Monitoramento: tabela de STATUS das execuções do cron de sync.
--
-- DECISÃO: cada run do sync (cron diário) grava UMA linha aqui. Transforma
-- "o cron rodou?" numa consulta à tabela, não num palpite. Sem alerta/monitor
-- automático ainda (dead man's switch fica para a promoção a produção, depois
-- de observar o comportamento normal em dev).
--
-- Escrita: só via service_role (o serviço superlogica-sync), que bypassa RLS.
-- Leitura: usuário logado (para o tracker.html mostrar a última run).
--
-- IDEMPOTENTE. APLICAR EM DEV PRIMEIRO. Prod só com autorização explícita.

CREATE TABLE IF NOT EXISTS public.sync_status (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rodado_em      timestamptz NOT NULL DEFAULT now(),   -- carimbo da execução
  resultado      text        NOT NULL,                 -- 'ok' | 'erro'
  processados    int,                                  -- condomínios varridos
  sincronizados  int,                                  -- válidos (upsert)
  pulados        int,                                  -- inválidos (403/null/erro)
  erro_msg       text                                  -- mensagem se resultado='erro'
);

-- Índice para "última run" rápido (o tracker lê ORDER BY rodado_em DESC LIMIT 1).
CREATE INDEX IF NOT EXISTS sync_status_rodado_em_idx
  ON public.sync_status (rodado_em DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- SELECT a usuário logado (tracker); escrita real entra via service_role
-- (bypassa RLS). Mesma postura das 008/009/010.
ALTER TABLE public.sync_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_select" ON public.sync_status;
CREATE POLICY "authenticated_select" ON public.sync_status
  FOR SELECT TO authenticated
  USING (true);

-- VALIDAÇÃO:
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='sync_status' ORDER BY ordinal_position;
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public' AND tablename='sync_status';  -- rowsecurity = true
