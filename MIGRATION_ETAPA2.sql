-- Etapa 2 — Demandas de Cliente: campos de cliente em `condominios`
-- Rodar no Supabase Studio (SQL Editor) ou via supabase CLI.
-- Todos com IF NOT EXISTS — seguro rodar de novo.

ALTER TABLE condominios ADD COLUMN IF NOT EXISTS sindico_telefone TEXT;
ALTER TABLE condominios ADD COLUMN IF NOT EXISTS sindico_email TEXT;
ALTER TABLE condominios ADD COLUMN IF NOT EXISTS frequencia_relatorio TEXT;        -- 'semanal' | 'quinzenal' | 'mensal'
ALTER TABLE condominios ADD COLUMN IF NOT EXISTS dia_atualizacao_semanal INT;      -- 0=domingo .. 6=sábado
