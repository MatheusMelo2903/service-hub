-- Migration 016 (T39): avisos do financeiro dentro do Hub.
-- fin_avisos: resultado do resumo da manhã de cada dia (uma linha "geral" e uma por carteira).
-- fin_avisos_execucoes: cada geração (agendada às 7h ou sob demanda pelo GESTOR).
-- fin_usuarios_superlogica: vínculo do usuário do Superlógica (quem lança) com o analista do Hub
-- e com a carteira, editado só pelo GESTOR.
-- Só o servidor lê e grava (service_role): RLS ligado e nenhuma policy para anon ou authenticated.
-- Aplicar SÓ no Supabase de teste (ledgyprytkuvgtbunsck) até o Matheus mandar subir.

create table if not exists public.fin_avisos (
  dia         date        not null,
  chave       text        not null check (chave ~ '^(geral|sem_carteira|carteira:[0-9]{1,9})$'),
  origem      text        not null check (origem in ('agendado', 'sob_demanda', 'teste')),
  gerado_em   timestamptz not null default now(),
  conteudo    jsonb       not null default '{}'::jsonb,
  primary key (dia, chave)
);
create index if not exists fin_avisos_dia_idx on public.fin_avisos (dia desc);

create table if not exists public.fin_avisos_execucoes (
  id            uuid        primary key default gen_random_uuid(),
  dia           date        not null,
  origem        text        not null check (origem in ('agendado', 'sob_demanda', 'teste')),
  status        text        not null default 'andamento' check (status in ('andamento', 'ok', 'erro')),
  iniciado_em   timestamptz not null default now(),
  terminado_em  timestamptz,
  usuario       uuid,
  parametros    jsonb       not null default '{}'::jsonb,
  resumo        jsonb       not null default '{}'::jsonb
);
-- A geração agendada roda uma vez por dia (protege contra reinício do servidor no meio da manhã).
-- Se o servidor reiniciar no meio, a próxima tentativa retoma a mesma linha (financeiro/avisos.js).
create unique index if not exists fin_avisos_exec_agendado_uk on public.fin_avisos_execucoes (dia) where origem = 'agendado';
create index if not exists fin_avisos_exec_dia_idx on public.fin_avisos_execucoes (iniciado_em desc);

create table if not exists public.fin_usuarios_superlogica (
  id_usuario_sl  text        primary key check (id_usuario_sl ~ '^[0-9]{1,12}$'),
  apelido        text        not null default '',
  profile_id     uuid        references public.profiles(id) on delete set null,
  carteira       integer     check (carteira is null or carteira > 0),
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create index if not exists fin_usuarios_sl_profile_idx on public.fin_usuarios_superlogica (profile_id);

alter table public.fin_avisos enable row level security;
alter table public.fin_avisos_execucoes enable row level security;
alter table public.fin_usuarios_superlogica enable row level security;
revoke all on public.fin_avisos from anon, authenticated;
revoke all on public.fin_avisos_execucoes from anon, authenticated;
revoke all on public.fin_usuarios_superlogica from anon, authenticated;
