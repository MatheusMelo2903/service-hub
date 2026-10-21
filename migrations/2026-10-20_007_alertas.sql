-- Migration: alertas operacionais por condomínio (T05) e configuração de alerta.
-- Data: 2026-10-20
-- Aplicada SÓ no Supabase de TESTE (ledgyprytkuvgtbunsck). PROD pendente autorização explícita.
-- IDEMPOTENTE.
--
-- O servidor (service_role) é quem lê e grava: calcula os alertas no Superlógica, guarda
-- cada um pela chave estável e o usuário marca visto ou resolvido pela tela. RLS ligado e
-- SEM policy para authenticated: o navegador nunca acessa estas tabelas direto.

CREATE TABLE IF NOT EXISTS public.alertas (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  id_superlogica  INT         NOT NULL,
  chave           TEXT        NOT NULL,
  tipo            TEXT        NOT NULL,
  titulo          TEXT        NOT NULL,
  detalhe         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'novo' CHECK (status IN ('novo', 'visto', 'resolvido')),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por  UUID        REFERENCES auth.users(id),
  UNIQUE (id_superlogica, chave)
);

CREATE INDEX IF NOT EXISTS alertas_cond_status_idx ON public.alertas(id_superlogica, status);

ALTER TABLE public.alertas ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.alertas_config (
  id_superlogica  INT         PRIMARY KEY,
  saldo_minimo    NUMERIC(14,2),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por  UUID        REFERENCES auth.users(id)
);

ALTER TABLE public.alertas_config ENABLE ROW LEVEL SECURITY;
