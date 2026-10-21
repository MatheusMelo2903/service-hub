-- Migration 018: fechamento do mês (T38).
-- 1. fin_anexo_leitura: o que já foi lido de cada anexo de despesa (cache por arquivo, para não
--    baixar nem ler de novo). Chave: id do arquivo no Superlógica mais o hash do arquivo.
-- 2. fin_fechamento_marca: item do fechamento marcado como conferido à mão (quem e quando).
-- 3. fin_fechamento_status: último status calculado do fechamento por condomínio e mês
--    (coluna Fechamento no quadro da carteira).
-- Só o servidor lê e grava (service_role): RLS ligado e nenhuma policy para anon ou authenticated.
-- Aplicar SÓ no Supabase de teste (ledgyprytkuvgtbunsck) até o Matheus mandar subir.

create table if not exists public.fin_anexo_leitura (
  chave           text primary key,             -- <id_arquivo_arq>:<st_hash_arq>
  id_arquivo      bigint not null,
  id_superlogica  integer,
  extensao        text,
  leitura         text not null check (leitura in ('texto', 'interna', 'escaneado', 'nao_pdf', 'falha')),
  texto           text,                         -- texto útil do PDF (até 20 mil caracteres)
  meta            jsonb not null default '{}'::jsonb,  -- produtor, criador, criação e modificação do PDF
  lido_em         timestamptz not null default now()
);
create index if not exists fin_anexo_leitura_cond_idx on public.fin_anexo_leitura (id_superlogica);
alter table public.fin_anexo_leitura enable row level security;
revoke all on public.fin_anexo_leitura from anon, authenticated;

create table if not exists public.fin_fechamento_marca (
  id_superlogica  integer not null,
  competencia     text not null check (competencia ~ '^[0-9]{4}-[0-9]{2}$'),
  item            text not null check (item in ('pre_balancete', 'boletos', 'anexos')),
  ativo           boolean not null default true,
  pendencias      integer not null default 0,   -- pendências que existiam quando marcou
  chaves          jsonb,                        -- quais pendências foram conferidas (a marca só vale para elas)
  observacao      text,
  marcado_por     uuid,
  marcado_por_email text,
  marcado_em      timestamptz not null default now(),
  primary key (id_superlogica, competencia, item)
);
alter table public.fin_fechamento_marca enable row level security;
revoke all on public.fin_fechamento_marca from anon, authenticated;

create table if not exists public.fin_fechamento_status (
  id_superlogica  integer not null,
  competencia     text not null check (competencia ~ '^[0-9]{4}-[0-9]{2}$'),
  pronto          boolean not null default false,
  falta           jsonb not null default '[]'::jsonb,
  itens           jsonb not null default '[]'::jsonb,
  calculado_em    timestamptz not null default now(),
  primary key (id_superlogica, competencia)
);
alter table public.fin_fechamento_status enable row level security;
revoke all on public.fin_fechamento_status from anon, authenticated;
