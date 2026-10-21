-- T09: carteira do usuário (grupos de condomínios do Superlógica: Carteira A, Carteira B...).
-- Lista de id_grupo_cg do Superlógica. Vazia = vê todos os condomínios. GESTOR sempre vê todos.
-- Editada só pelo GESTOR (rota PUT /api/admin/usuarios/:id/carteiras, com service_role).
-- Aplicada SÓ no Supabase de teste (ledgyprytkuvgtbunsck). Produção só com autorização do Matheus.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS carteiras integer[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.profiles.carteiras IS 'T09: ids de condominiogrupos do Superlogica que o usuario ve. Vazio = todos.';
