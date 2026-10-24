-- Agenda do mês (cronograma da empresa): assembleias e tarefas que a equipe manda todo mês,
-- o plano de trabalho que o sistema monta (prestação, apresentação, dia das certidões,
-- pedido de material ao síndico, ata), a aprovação da gestão e a execução nas datas.
-- Detalhes em servico/agenda.js, servico/agenda-execucao.js e servico/rotas-agenda.js.
-- Aplicar SÓ no Supabase de teste. Produção só quando o Matheus mandar ("sobe para producao").
-- Só o servidor (service role) lê e grava: RLS ligada sem policy e sem grant para anon e authenticated.
-- IDEMPOTENTE.

create table if not exists public.agenda_itens (
  id uuid primary key default gen_random_uuid(),
  mes text not null check (mes ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  tipo_item text not null default 'assembleia' check (tipo_item in ('assembleia', 'tarefa')),
  id_superlogica integer,
  condominio_nome text,
  data date,
  hora text,
  tipo_assembleia text check (tipo_assembleia is null or tipo_assembleia in ('AGO', 'AGE', 'AGO_AGE')),
  descricao text,
  pauta jsonb not null default '[]'::jsonb,
  pauta_fonte text,
  edital_texto text,
  edital_nome text,
  origem text,
  avisos_leitura jsonb not null default '[]'::jsonb,
  responsavel uuid,
  criado_por uuid,
  cancelado boolean not null default false,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists agenda_itens_mes_idx on public.agenda_itens (mes, data);
create index if not exists agenda_itens_cond_idx on public.agenda_itens (id_superlogica);

create table if not exists public.agenda_tarefas (
  id uuid primary key default gen_random_uuid(),
  mes text not null check (mes ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  chave text not null,
  item_id uuid references public.agenda_itens (id) on delete cascade,
  id_superlogica integer,
  tipo text not null check (tipo in ('prestacao_contas', 'apresentacao', 'certidoes', 'pedir_material', 'previsao_orcamentaria', 'ata', 'outra')),
  titulo text,
  data_execucao date not null,
  prazo date,
  parametros jsonb not null default '{}'::jsonb,
  assinatura text,
  versao integer not null default 1,
  aprovacao text not null default 'pendente' check (aprovacao in ('pendente', 'aprovada')),
  aprovada_por uuid,
  aprovada_em timestamptz,
  status text not null default 'agendada' check (status in ('agendada', 'pendente_material', 'rodando', 'pronta_conferir', 'conferida', 'erro', 'manual', 'cancelada')),
  motivo text,
  resultado jsonb not null default '{}'::jsonb,
  travas jsonb not null default '[]'::jsonb,
  erro text,
  tentativas integer not null default 0,
  trava_ate timestamptz,
  trava_dono text,
  executada_em timestamptz,
  pronta_em timestamptz,
  conferida_por uuid,
  conferida_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (mes, chave)
);
create index if not exists agenda_tarefas_exec_idx on public.agenda_tarefas (status, aprovacao, data_execucao);
create index if not exists agenda_tarefas_item_idx on public.agenda_tarefas (item_id);

create table if not exists public.agenda_materiais (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.agenda_itens (id) on delete cascade,
  tipo text not null check (tipo in ('edital', 'documento', 'foto')),
  nome text not null,
  caminho text not null,
  mime text,
  bytes integer,
  paginas integer,
  texto text,
  enviado_por uuid,
  criado_em timestamptz not null default now()
);
create index if not exists agenda_materiais_item_idx on public.agenda_materiais (item_id);

create table if not exists public.agenda_avisos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  tarefa_id uuid references public.agenda_tarefas (id) on delete set null,
  item_id uuid references public.agenda_itens (id) on delete set null,
  id_superlogica integer,
  tipo text not null,
  texto text not null,
  mensagem text,
  lido boolean not null default false,
  criado_em timestamptz not null default now()
);
create index if not exists agenda_avisos_user_idx on public.agenda_avisos (user_id, lido, criado_em desc);

create table if not exists public.agenda_config (
  chave text primary key,
  valores jsonb not null default '{}'::jsonb,
  atualizado_por uuid,
  atualizado_em timestamptz not null default now()
);

alter table public.agenda_itens enable row level security;
alter table public.agenda_tarefas enable row level security;
alter table public.agenda_materiais enable row level security;
alter table public.agenda_avisos enable row level security;
alter table public.agenda_config enable row level security;
revoke all on public.agenda_itens from anon, authenticated;
revoke all on public.agenda_tarefas from anon, authenticated;
revoke all on public.agenda_materiais from anon, authenticated;
revoke all on public.agenda_avisos from anon, authenticated;
revoke all on public.agenda_config from anon, authenticated;

-- Bucket privado do material de cada assembleia (edital, orçamentos, fotos). Sem policy: só o servidor.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agenda', 'agenda', false, 26214400, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;
