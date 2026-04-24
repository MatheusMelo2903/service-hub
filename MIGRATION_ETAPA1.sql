-- Etapa 1 — Demandas de Cliente
-- Rodar no Supabase Studio (SQL Editor) antes de usar a Caixa de Entrada.
-- As colunas são IF NOT EXISTS, então rodar de novo é seguro.

ALTER TABLE demandas ADD COLUMN IF NOT EXISTS origem_texto_bruto TEXT;
ALTER TABLE demandas ADD COLUMN IF NOT EXISTS processado_em TIMESTAMPTZ;
ALTER TABLE demandas ADD COLUMN IF NOT EXISTS fonte TEXT;
