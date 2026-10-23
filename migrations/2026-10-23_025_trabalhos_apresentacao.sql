-- Apresentação de assembleia: a pasta Em andamento (trabalhos_salvos) passa a aceitar o tipo
-- 'apresentacao' (roteiro guardado mais o PowerPoint e o PDF gerados).
-- Aplicar SÓ no Supabase de teste. Produção só quando o Matheus mandar ("sobe para producao").
-- IDEMPOTENTE.
alter table public.trabalhos_salvos drop constraint if exists trabalhos_salvos_tipo_check;
alter table public.trabalhos_salvos add constraint trabalhos_salvos_tipo_check
  CHECK ((tipo = ANY (ARRAY['ata'::text, 'prestacao'::text, 'previsao'::text, 'unidades'::text, 'apresentacao'::text])));
