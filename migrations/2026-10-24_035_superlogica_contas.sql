-- Conta do Superlógica de cada pessoa do Hub ("Minha conta do Superlógica"): email e senha da
-- PRÓPRIA pessoa, usados pelo botão "Abrir no Superlógica". A senha fica cifrada pelo servidor
-- (AES 256 GCM, chave SUPERLOGICA_CRED_CHAVE, id da pessoa como dado autenticado) e nunca volta
-- para a tela. Detalhes em servico/superlogica-conta.js.
-- Aplicar SÓ no Supabase de teste. Produção só quando o Matheus mandar ("sobe para producao").
-- Só o servidor (service role) lê e grava: RLS ligada sem policy e sem grant para anon e authenticated.
-- IDEMPOTENTE.

create table if not exists public.superlogica_contas (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null check (char_length(email) between 3 and 200),
  senha_cifrada text not null check (senha_cifrada like 'v1:%'),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

alter table public.superlogica_contas enable row level security;
revoke all on public.superlogica_contas from anon, authenticated;
