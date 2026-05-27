-- 2026-05-26 — Extensões de schema pra suportar seed mockup de dev
--
-- Adiciona colunas necessárias pros cenários de teste (Buritis, Praia Dourada,
-- Solar Palmeiras, Vila Nova, Residencial Vitória) e marca registros mockup
-- com flag `mockup BOOLEAN` pra reset seletivo (DELETE WHERE mockup=true).
--
-- Aplicado em DEV (ledgyprytkuvgtbunsck) em 2026-05-26.
-- PROD pendente — Matheus aplica via Studio quando convergir.
-- ----------------------------------------------------------------------

ALTER TABLE public.condominios
  ADD COLUMN IF NOT EXISTS unidades_total INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inadimplencia_valor NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inadimplencia_qtd INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS endereco TEXT,
  ADD COLUMN IF NOT EXISTS cnpj TEXT,
  ADD COLUMN IF NOT EXISTS proposito_teste TEXT,
  ADD COLUMN IF NOT EXISTS mockup BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.demandas
  ADD COLUMN IF NOT EXISTS condominio_id UUID REFERENCES public.condominios(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS titulo TEXT,
  ADD COLUMN IF NOT EXISTS categoria TEXT,
  ADD COLUMN IF NOT EXISTS prioridade TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'aberta',
  ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS mockup BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.laudos
  ADD COLUMN IF NOT EXISTS condominio_id UUID REFERENCES public.condominios(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS unidade TEXT,
  ADD COLUMN IF NOT EXISTS tipo TEXT,
  ADD COLUMN IF NOT EXISTS consumo_m3 NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS data_leitura DATE,
  ADD COLUMN IF NOT EXISTS mockup BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.historico
  ADD COLUMN IF NOT EXISTS condominio_id UUID REFERENCES public.condominios(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS evento TEXT,
  ADD COLUMN IF NOT EXISTS descricao TEXT,
  ADD COLUMN IF NOT EXISTS mockup BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS demandas_condominio_idx ON public.demandas(condominio_id);
CREATE INDEX IF NOT EXISTS laudos_condominio_idx ON public.laudos(condominio_id);
CREATE INDEX IF NOT EXISTS historico_condominio_idx ON public.historico(condominio_id);
CREATE INDEX IF NOT EXISTS condominios_mockup_idx ON public.condominios(mockup);
