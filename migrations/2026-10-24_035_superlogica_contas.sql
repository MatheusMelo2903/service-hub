-- Email do Superlógica de cada pessoa do Hub ("Minha conta do Superlógica"): só o email da PRÓPRIA
-- pessoa, que aparece como dica no botão "Abrir no Superlógica". O Hub NÃO guarda senha do
-- Superlógica (login direto descartado em 24/10/2026). Detalhes em servico/superlogica-conta.js.
-- Aplicar SÓ no Supabase de teste. Produção só quando o Matheus mandar ("sobe para producao").
-- Só o servidor (service role) lê e grava: RLS ligada sem policy e sem grant para anon e authenticated.
-- IDEMPOTENTE. No banco de teste que já tinha a versão com senha, o "drop column if exists" tira a coluna.

create table if not exists public.superlogica_contas (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null check (char_length(email) between 3 and 200),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.superlogica_contas drop column if exists senha_cifrada;

alter table public.superlogica_contas enable row level security;
revoke all on public.superlogica_contas from anon, authenticated;
