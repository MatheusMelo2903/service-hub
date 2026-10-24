-- Migration 029: conciliação automática do dia (extrato no Superlógica, regras, fila para conferir e avisos).
-- fin_conc_importacoes: cada extrato que o Hub planejou ou gravou no Superlógica, por conta e período.
--   Trava no banco: duas importações gravando, gravadas ou incertas da mesma conta nunca se sobrepõem
--   (o Superlógica bloqueia a conciliação com período sobreposto e 62% dos extratos eram apagados e
--   importados de novo). As linhas guardadas são só data, valor, código e descrição do banco.
--   Número de conta e agência não são guardados.
-- fin_conc_fila: o que não casou, com a sugestão e o motivo; a pessoa aceita, corrige ou ignora.
-- fin_conc_lancamentos: cada lançamento que o Hub vai fazer ou fez (despesa já paga, transferência,
--   movimentação direta). A chave é estável: o mesmo lançamento nunca é gravado duas vezes.
-- fin_conc_regras: regras ensinadas pela equipe na fila ("usar nas próximas").
-- fin_conc_avisos: aviso diário por condomínio (conta sem extrato importado, linhas sem conciliar).
-- fin_conc_estado: última conciliação e última gravação de cada condomínio.
-- Só o servidor lê e grava (service_role): RLS ligado e nenhuma policy para anon ou authenticated.
-- IDEMPOTENTE. Aplicar SÓ no Supabase de teste até o Matheus mandar subir.

create extension if not exists btree_gist;

create table if not exists public.fin_conc_importacoes (
  id                bigint      generated always as identity primary key,
  id_condominio     integer     not null,
  id_conta          integer     not null,
  inicio            date        not null,
  fim               date        not null,
  quantidade        integer     not null default 0,
  itens             jsonb       not null default '[]'::jsonb,
  origem            text        not null check (origem in ('ofx', 'banco')),
  arquivo_hash      text,
  status            text        not null default 'planejada' check (status in ('planejada', 'gravando', 'gravada', 'incerta', 'falhou', 'recusada', 'cancelada')),
  detalhe           jsonb       not null default '{}'::jsonb,
  criado_por        uuid,
  criado_por_email  text,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),
  gravado_em        timestamptz,
  check (fim >= inicio)
);
do $$ begin
  alter table public.fin_conc_importacoes add constraint fin_conc_importacoes_sem_sobreposicao
    exclude using gist (id_conta with =, daterange(inicio, fim, '[]') with &&) where (status in ('gravando', 'gravada', 'incerta'));
exception when duplicate_object or duplicate_table then null; end $$;
create index if not exists fin_conc_imp_cond_idx on public.fin_conc_importacoes (id_condominio, status);
create index if not exists fin_conc_imp_conta_idx on public.fin_conc_importacoes (id_conta, fim desc);

create table if not exists public.fin_conc_fila (
  chave              text        primary key check (length(chave) between 10 and 64),
  id_condominio      integer     not null,
  id_conta           integer,
  conta              text,
  data               date,
  valor_centavos     bigint      not null default 0,
  descricao          text        check (descricao is null or length(descricao) <= 200),
  tipo               text        not null,
  motivo             text        check (motivo is null or length(motivo) <= 600),
  sugestao           jsonb,
  status             text        not null default 'pendente' check (status in ('pendente', 'aceito', 'corrigido', 'ignorado', 'conferido', 'resolvido')),
  decisao            jsonb,
  decidido_por       uuid,
  decidido_por_email text,
  decidido_em        timestamptz,
  visto_em           timestamptz,
  criado_em          timestamptz not null default now(),
  atualizado_em      timestamptz not null default now()
);
create index if not exists fin_conc_fila_cond_idx on public.fin_conc_fila (id_condominio, status, data);

create table if not exists public.fin_conc_lancamentos (
  chave              text        primary key check (length(chave) between 10 and 64),
  id_condominio      integer     not null,
  tipo               text        not null check (tipo in ('despesa', 'transferencia', 'movimentacao')),
  origem             text        not null check (origem in ('regra', 'fila')),
  regra              text,
  dados              jsonb       not null,
  valor_centavos     bigint      not null,
  status             text        not null default 'planejado' check (status in ('planejado', 'gravando', 'gravado', 'incerto', 'recusado', 'falhou', 'cancelado')),
  resultado          jsonb,
  criado_por_email   text,
  gravado_por        uuid,
  gravado_por_email  text,
  criado_em          timestamptz not null default now(),
  atualizado_em      timestamptz not null default now(),
  gravado_em         timestamptz
);
create index if not exists fin_conc_lanc_cond_idx on public.fin_conc_lancamentos (id_condominio, status);

create table if not exists public.fin_conc_regras (
  id                 bigint      generated always as identity primary key,
  id_condominio      integer     not null,
  padrao             text        not null check (length(padrao) between 3 and 80),
  sinal              smallint    not null check (sinal in (-1, 1)),
  acao               text        not null check (acao in ('despesa', 'ignorar')),
  conta_contabil     text        check (conta_contabil is null or conta_contabil ~ '^[0-9]+(\.[0-9]+)+$'),
  id_fornecedor      integer,
  fornecedor         text,
  forma_pag          integer,
  ativo              boolean     not null default true,
  criado_por         uuid,
  criado_por_email   text,
  criado_em          timestamptz not null default now(),
  unique (id_condominio, padrao, sinal)
);

create table if not exists public.fin_conc_avisos (
  dia                date        not null,
  id_condominio      integer     not null,
  tipo               text        not null check (tipo in ('sem_extrato', 'sem_conciliar', 'gravacao_incerta')),
  id_conta           integer     not null default 0,
  condominio         text,
  carteira           text,
  analista           text,
  gravidade          text        not null default 'media' check (gravidade in ('alta', 'media', 'baixa')),
  titulo             text        not null,
  detalhe            text,
  desde              date,
  quantidade         integer,
  criado_em          timestamptz not null default now(),
  primary key (dia, id_condominio, tipo, id_conta)
);

create table if not exists public.fin_conc_estado (
  id_condominio      integer     primary key,
  condominio         text,
  ultima_conciliacao timestamptz,
  resumo             jsonb,
  ultima_gravacao    timestamptz,
  gravacao           jsonb,
  atualizado_em      timestamptz not null default now()
);

alter table public.fin_conc_importacoes enable row level security;
alter table public.fin_conc_fila enable row level security;
alter table public.fin_conc_lancamentos enable row level security;
alter table public.fin_conc_regras enable row level security;
alter table public.fin_conc_avisos enable row level security;
alter table public.fin_conc_estado enable row level security;
revoke all on public.fin_conc_importacoes, public.fin_conc_fila, public.fin_conc_lancamentos, public.fin_conc_regras, public.fin_conc_avisos, public.fin_conc_estado from anon, authenticated;
