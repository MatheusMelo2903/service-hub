-- T49: trabalhos em andamento (pastinha "Em andamento": ata e prestação geradas e outros).
-- Aplicar SÓ no Supabase de teste. Produção só quando o Matheus mandar ("sobe para producao").
-- Só o servidor (service role) lê e grava: RLS ligada sem policy e sem grant para anon e authenticated.

create table if not exists public.trabalhos_salvos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  tipo text not null check (tipo in ('ata', 'prestacao', 'previsao', 'unidades')),
  id_superlogica integer,
  titulo text not null,
  dados jsonb not null default '{}'::jsonb,
  arquivos jsonb not null default '[]'::jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  expira_em timestamptz not null default (now() + interval '7 days')
);

create index if not exists trabalhos_salvos_user_idx on public.trabalhos_salvos (user_id, atualizado_em desc);
create index if not exists trabalhos_salvos_expira_idx on public.trabalhos_salvos (expira_em);

alter table public.trabalhos_salvos enable row level security;
revoke all on public.trabalhos_salvos from anon, authenticated;

-- Bucket privado dos arquivos gerados (PDF e PowerPoint). Sem policy: só o servidor acessa.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trabalhos', 'trabalhos', false, 41943040, array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
])
on conflict (id) do nothing;
