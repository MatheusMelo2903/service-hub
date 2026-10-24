-- Migration 031: Boletos do mês (financeiro/boletos-mes-rotas.js).
-- fin_boletos_itens: cada item da composição do boleto que o Hub criou no Superlógica
--   (arrecadacoes/put). Serve para o Hub só excluir o que ele mesmo criou e para o histórico.
-- fin_boletos_conferencias: resultado resumido de cada conferência antes de gerar (sem dado pessoal).
-- fin_boletos_remessas: cada geração do arquivo de remessa pelo Hub (só o resultado; o conteúdo
--   do arquivo nunca é guardado).
-- fin_boletos_regua: cada aplicação do padrão da régua (só os campos de prazo, antes e depois).
-- Só o servidor lê e grava (service_role): RLS ligado e nenhuma policy para anon ou authenticated.
-- IDEMPOTENTE. Aplicar SÓ no Supabase de teste até o Matheus mandar subir.

create table if not exists public.fin_boletos_itens (
  id_composicao       bigint      primary key,
  id_superlogica      integer     not null,
  competencia         text        not null check (competencia ~ '^[0-9]{4}-[0-9]{2}$'),
  tipo                text        not null check (tipo in ('taxa_extra', 'item_unidade')),
  conta               text        not null,
  descricao           text        not null check (length(descricao) <= 120),
  valor               numeric(16,2) not null,
  meses               integer     not null check (meses between 1 and 60),
  boleto              text        not null default 'normal' check (boleto in ('normal', 'extra')),
  id_unidade          bigint,
  id_conta            bigint,
  status              text        not null check (status in ('gravado', 'incerto', 'excluido')),
  criado_por          uuid,
  criado_por_email    text,
  criado_em           timestamptz not null default now(),
  excluido_por        uuid,
  excluido_por_email  text,
  excluido_em         timestamptz
);
create index if not exists fin_boletos_itens_cond_comp_idx on public.fin_boletos_itens (id_superlogica, competencia);

create table if not exists public.fin_boletos_conferencias (
  id                  bigint      generated always as identity primary key,
  id_superlogica      integer     not null,
  competencia         text        not null check (competencia ~ '^[0-9]{4}-[0-9]{2}$'),
  pode_gerar          boolean     not null,
  graves              integer     not null default 0,
  alertas             integer     not null default 0,
  total_simulado      numeric(16,2),
  unidades_simuladas  integer,
  por_tipo            jsonb       not null default '{}'::jsonb,
  em                  timestamptz not null default now()
);
create index if not exists fin_boletos_conf_cond_idx on public.fin_boletos_conferencias (id_superlogica, competencia, em desc);

create table if not exists public.fin_boletos_remessas (
  id                  bigint      generated always as identity primary key,
  id_superlogica      integer     not null,
  id_conta            bigint      not null,
  resultado           text        not null check (resultado in ('arquivo', 'link', 'gerada', 'nada_a_gerar')),
  formato             text,
  linhas              integer,
  id_remessa          bigint,
  gerado_por          uuid,
  gerado_por_email    text,
  em                  timestamptz not null default now()
);
create index if not exists fin_boletos_rem_cond_idx on public.fin_boletos_remessas (id_superlogica, em desc);

create table if not exists public.fin_boletos_regua (
  id                    bigint      generated always as identity primary key,
  id_superlogica        integer     not null,
  antes                 jsonb       not null,
  depois                jsonb       not null,
  retorno_automatico    boolean     not null,
  ok                    boolean     not null,
  outras_chaves_mudaram integer,
  por                   uuid,
  por_email             text,
  em                    timestamptz not null default now()
);
create index if not exists fin_boletos_regua_cond_idx on public.fin_boletos_regua (id_superlogica, em desc);

alter table public.fin_boletos_itens enable row level security;
alter table public.fin_boletos_conferencias enable row level security;
alter table public.fin_boletos_remessas enable row level security;
alter table public.fin_boletos_regua enable row level security;
revoke all on public.fin_boletos_itens, public.fin_boletos_conferencias, public.fin_boletos_remessas, public.fin_boletos_regua from anon, authenticated;
revoke all on sequence public.fin_boletos_conferencias_id_seq, public.fin_boletos_remessas_id_seq, public.fin_boletos_regua_id_seq from anon, authenticated;
