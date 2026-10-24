-- Migration 030: balancete digital e fechamento do mês feitos pelo sistema.
-- 1. fin_balancete_modelo: o modelo de cada condomínio (comentários do R&D na ordem, conta, etiqueta
--    e de onde vem o documento). Aprendido dos comentários dos últimos meses; a pessoa pode conferir.
-- 2. fin_balancete_documento: documentos que precisam chegar ao Hub (extrato do banco, garantidora,
--    francesinha, certidões). O arquivo fica no bucket privado balancete-digital.
-- 3. fin_balancete_montagem: o que o sistema gravou no R&D (um registro por comentário do modelo e
--    mês), com o id do anexo e do comentário: nunca grava duas vezes sem reler.
-- 4. fin_balancete_fechamento_log: quem fechou e reabriu o mês, quando, datas e motivo.
-- 5. fin_balancete_situacao: última situação calculada (etapa, travas com causa e quem age, prazo),
--    para o painel não ler o Superlógica de novo.
-- Só o servidor lê e grava (service_role): RLS ligado e nenhuma policy para anon ou authenticated.

create table if not exists public.fin_balancete_modelo (
  id_superlogica    integer primary key,
  id_planoconta     integer,
  itens             jsonb not null default '[]'::jsonb,   -- [{chave, ordem, titulo, conta, etiqueta_id, etiqueta_nome, fonte}]
  as_vezes          jsonb not null default '[]'::jsonb,   -- comentários que só aparecem em alguns meses
  meses_lidos       jsonb not null default '[]'::jsonb,
  avisos            jsonb not null default '[]'::jsonb,
  origem            text not null default 'aprendido' check (origem in ('aprendido', 'confirmado')),
  confirmado        boolean not null default false,
  confirmado_por_email text,
  confirmado_em     timestamptz,
  aprendido_em      timestamptz,
  atualizado_em     timestamptz not null default now()
);
alter table public.fin_balancete_modelo enable row level security;
revoke all on public.fin_balancete_modelo from anon, authenticated;

create table if not exists public.fin_balancete_documento (
  id_superlogica    integer not null,
  competencia       text not null check (competencia ~ '^[0-9]{4}-[0-9]{2}$'),
  chave_item        text not null check (chave_item ~ '^[a-z0-9_]{1,60}$'),
  nome              text,
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes             integer not null check (bytes > 0 and bytes <= 15728640),
  caminho           text not null,
  origem            text not null default 'tela' check (origem in ('tela', 'email', 'banco')),
  enviado_por_email text,
  recebido_em       timestamptz not null default now(),
  primary key (id_superlogica, competencia, chave_item)
);
alter table public.fin_balancete_documento enable row level security;
revoke all on public.fin_balancete_documento from anon, authenticated;

create table if not exists public.fin_balancete_montagem (
  id_superlogica    integer not null,
  competencia       text not null check (competencia ~ '^[0-9]{4}-[0-9]{2}$'),
  chave_item        text not null,
  titulo            text,
  conta             text,
  etiqueta_id       integer,
  fonte             text,
  estado            text not null check (estado in ('pendente', 'gravado', 'ja_existia', 'incerto', 'falhou', 'falta_documento', 'aguardar')),
  id_arquivo        bigint,
  id_comentario     bigint,
  visibilidade      integer,
  alerta            text,
  msg               text,
  por               text,
  atualizado_em     timestamptz not null default now(),
  primary key (id_superlogica, competencia, chave_item)
);
alter table public.fin_balancete_montagem enable row level security;
revoke all on public.fin_balancete_montagem from anon, authenticated;

create table if not exists public.fin_balancete_fechamento_log (
  id                bigserial primary key,
  id_superlogica    integer not null,
  competencia       text not null check (competencia ~ '^[0-9]{4}-[0-9]{2}$'),
  acao              text not null check (acao in ('fechar', 'reabrir')),
  data_anterior     text,           -- AAAA-MM-DD; vazio = nunca fechado
  data_nova         text,           -- AAAA-MM-DD; vazio = nunca fechado; null = não conferido
  motivo            text,           -- obrigatório para reabrir (a rota confere)
  ok                boolean not null default false,
  incerto           boolean not null default false,
  msg               text,
  por               uuid,
  por_email         text,
  em                timestamptz not null default now(),
  check (acao <> 'reabrir' or length(coalesce(motivo, '')) >= 10)
);
create index if not exists fin_balancete_fechamento_log_cond_idx on public.fin_balancete_fechamento_log (id_superlogica, competencia);
alter table public.fin_balancete_fechamento_log enable row level security;
revoke all on public.fin_balancete_fechamento_log from anon, authenticated;

create table if not exists public.fin_balancete_situacao (
  id_superlogica    integer not null,
  competencia       text not null check (competencia ~ '^[0-9]{4}-[0-9]{2}$'),
  nome              text,
  etapa             text not null check (etapa in ('extrato', 'conciliacao', 'comprovantes', 'montagem', 'conferencia', 'pronto_publicar', 'publicado')),
  travas            jsonb not null default '[]'::jsonb,   -- [{etapa, causa, quem}]
  prazo             jsonb,
  publicado         boolean not null default false,
  fechado_ate       text,
  conferencia       jsonb,                                -- { impressao, ok, problemas } do último 900A
  calculado_em      timestamptz not null default now(),
  primary key (id_superlogica, competencia)
);
create index if not exists fin_balancete_situacao_comp_idx on public.fin_balancete_situacao (competencia, etapa);
alter table public.fin_balancete_situacao enable row level security;
revoke all on public.fin_balancete_situacao from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('balancete-digital', 'balancete-digital', false, 15728640, '{application/pdf}')
on conflict (id) do nothing;
