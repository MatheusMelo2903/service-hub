-- Migration: tabela condominios ganha id_superlogica e updated_at
-- Rodar no Supabase Studio (SQL Editor) ANTES do deploy do Service Hub.
-- Idempotente: pode rodar mais de uma vez sem efeito colateral.
--
-- Contexto: a tarefa "selecao-condominio-id-manual" passou a exigir que
-- cada condomínio tenha um id_superlogica numerico inteiro positivo, usado
-- na importacao de despesas e unidades. updated_at e populada explicitamente
-- pelo PATCH de edicao no frontend.
--
-- Decisao registrada: a coluna "ativo" do plano original NAO entra no banco.
-- A selecao de condomínio ativo para importacao fica em localStorage por
-- maquina, evitando que selecionar em um PC mude a tela de outro colega.

ALTER TABLE condominios ADD COLUMN IF NOT EXISTS id_superlogica INTEGER;
ALTER TABLE condominios ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Constraint UNIQUE sobre id_superlogica.
-- PostgreSQL permite multiplos NULL em UNIQUE por padrao, entao condomínios
-- antigos que ainda nao tem ID ficam todos com NULL sem conflitar entre si.
-- Apenas valores duplicados nao nulos disparam erro 409, tratado no frontend.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'condominios_id_superlogica_unique'
  ) THEN
    ALTER TABLE condominios
    ADD CONSTRAINT condominios_id_superlogica_unique UNIQUE (id_superlogica);
  END IF;
END $$;
