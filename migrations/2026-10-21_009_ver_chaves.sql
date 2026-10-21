-- T15: ação configuracoes.ver_chaves (ver as chaves internas do Superlógica que o proxy mascara).
-- Não vem com o cargo GESTOR (o trigger set_gestor_permissoes_totais não muda). É dada a uma
-- pessoa; pelo sistema, só quem já tem pode liberar para outra. Por decisão do Matheus em
-- 20/10/2026, começa só com ele.
-- Aplicar no Supabase de teste agora; produção só junto com a subida autorizada.

UPDATE public.profiles
SET permissoes = jsonb_set(permissoes, '{configuracoes,acoes}',
                           COALESCE(permissoes->'configuracoes'->'acoes', '[]'::jsonb) || '["ver_chaves"]'::jsonb)
WHERE lower(email) = 'matheusmelorodrigues2005@outlook.com'
  AND permissoes ? 'configuracoes'
  AND NOT (COALESCE(permissoes->'configuracoes'->'acoes', '[]'::jsonb) ? 'ver_chaves');
