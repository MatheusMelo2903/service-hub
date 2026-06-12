-- 2026-06-11 — Frente B (superlogica-sync) — Migração 007 de 010
-- Camada A: colunas de sincronização em `condominios` (ADITIVA).
--
-- DECISÕES TRAVADAS:
--   - `condominios` JÁ EXISTE em dev e prod, com os condomínios cadastrados à mão.
--   - Esta migração é PURAMENTE ADITIVA: só ADD COLUMN IF NOT EXISTS.
--   - NÃO recria a tabela, NÃO mexe em colunas existentes
--     (id uuid PK, id_superlogica, nome, sindico, criado_em, etc.).
--   - NÃO mexe no RLS existente de `condominios` (migração 001 já ligou RLS com a
--     policy `authenticated_full_access`, usada pelo seletor do Hub sob JWT do
--     usuário). Trocar essa policy quebraria o seletor para GERENTE/OPERACIONAL.
--     Por isso este arquivo NÃO toca RLS de condominios.
--
-- IDEMPOTENTE — pode rodar 2x sem efeito colateral.
-- APLICAR EM DEV PRIMEIRO. Prod só com autorização explícita.

ALTER TABLE public.condominios ADD COLUMN IF NOT EXISTS raw_hash   text;
ALTER TABLE public.condominios ADD COLUMN IF NOT EXISTS synced_at  timestamptz;

-- raw_hash  : hash determinístico do payload cru da Superlógica para o condomínio.
--             Permite o diff incremental (nosso, já que a REST v2 não tem delta).
-- synced_at : carimbo da última sincronização bem sucedida deste condomínio.

-- VALIDAÇÃO (rodar manualmente após aplicar):
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='condominios'
--   AND column_name IN ('raw_hash','synced_at');
-- Esperado: 2 linhas (text, timestamp with time zone).
