-- Migration 032: Contas a pagar (financeiro/pagar*.js, servico/rotas-pagar.js).
-- fin_pagar_baixas: cada pagamento achado no retorno do banco ou no extrato e o que o Hub fez com ele
--   (baixou sozinho, ficou para conferir, foi recusado). Uma baixa ativa por parcela no máximo: o índice
--   único parcial impede baixar a mesma parcela duas vezes pelo Hub.
-- fin_pagar_envios: registro de que a parcela foi enviada para a assinatura do síndico (ou do síndico e
--   do subsíndico). Junto com a marcação da remessa, é o que tira a parcela do aviso de prazo.
-- fin_pagar_esperadas: contas esperadas (aprendidas dos últimos 6 meses) que a pessoa mandou ignorar.
-- fin_pagar_fornecedores: pedido de fornecedor novo, com a conferência de quem aprovou e de quem
--   confirmou a chave Pix ou a conta por telefone antes de gravar no Superlógica.
-- Só o servidor lê e grava (service_role): RLS ligado e nenhuma policy para anon ou authenticated.
-- Nenhum número de conta inteiro nem senha aqui; chave Pix só a do fornecedor, para conferir.
-- IDEMPOTENTE. Aplicar SÓ no Supabase de teste até o Matheus mandar subir.

create table if not exists public.fin_pagar_baixas (
  id                     bigint      generated always as identity primary key,
  id_superlogica         integer     not null,
  origem                 text        not null check (origem in ('retorno', 'extrato')),
  origem_ref             text        not null check (length(origem_ref) <= 120),
  id_parcela             bigint,
  id_despesa             bigint,
  situacao               text        not null check (situacao in ('pronta', 'gravando', 'baixada', 'incerto', 'conferir', 'recusada', 'descartada')),
  motivo                 text        check (motivo is null or length(motivo) <= 500),
  fornecedor             text,
  vencimento             date,
  data_pagamento         date,
  valor_parcela          numeric(16,2),
  valor_pago             numeric(16,2),
  juros                  numeric(16,2) not null default 0,
  multa                  numeric(16,2) not null default 0,
  id_arquivo             bigint,
  analista               text,
  lancado_por            uuid,
  lancado_por_email      text,
  baixado_por            text,
  baixado_por_id         uuid,
  baixado_em             timestamptz,
  descartado_por_email   text,
  detalhe                jsonb       not null default '{}'::jsonb,
  criado_em              timestamptz not null default now(),
  atualizado_em          timestamptz not null default now(),
  unique (origem, origem_ref)
);
create unique index if not exists fin_pagar_baixas_parcela_ativa_idx on public.fin_pagar_baixas (id_parcela)
  where id_parcela is not null and situacao in ('pronta', 'gravando', 'baixada', 'incerto');
create index if not exists fin_pagar_baixas_cond_idx on public.fin_pagar_baixas (id_superlogica, situacao);
create index if not exists fin_pagar_baixas_analista_idx on public.fin_pagar_baixas (analista, situacao);

create table if not exists public.fin_pagar_envios (
  id_parcela             bigint      primary key,
  id_superlogica         integer     not null,
  id_despesa             bigint,
  para                   text        not null check (para in ('síndico', 'síndico e subsíndico')),
  observacao             text        check (observacao is null or length(observacao) <= 300),
  enviado_em             timestamptz not null default now(),
  enviado_por            uuid,
  enviado_por_email      text
);
create index if not exists fin_pagar_envios_cond_idx on public.fin_pagar_envios (id_superlogica);

create table if not exists public.fin_pagar_esperadas (
  id_superlogica         integer     not null,
  chave                  text        not null check (chave ~ '^f[0-9]{1,15}$'),
  ignorada               boolean     not null default false,
  motivo                 text        check (motivo is null or length(motivo) <= 300),
  por                    uuid,
  por_email              text,
  em                     timestamptz not null default now(),
  primary key (id_superlogica, chave)
);

create table if not exists public.fin_pagar_fornecedores (
  id                     uuid        primary key default gen_random_uuid(),
  id_superlogica         integer     not null,
  entrada                uuid,
  cnpj                   text        not null check (cnpj ~ '^[0-9]{11}([0-9]{3})?$'),
  dados                  jsonb       not null,
  situacao               text        not null check (situacao in ('pendente', 'gravando', 'gravado', 'incerto', 'recusado', 'cancelado')),
  motivo                 text        check (motivo is null or length(motivo) <= 500),
  pedido_por             uuid,
  pedido_por_email       text,
  pedido_em              timestamptz not null default now(),
  aprovado_por           uuid,
  aprovado_por_email     text,
  aprovado_em            timestamptz,
  pagamento_confirmado_como text     check (pagamento_confirmado_como is null or length(pagamento_confirmado_como) <= 300),
  id_contato             bigint,
  atualizado_em          timestamptz not null default now()
);
create unique index if not exists fin_pagar_fornecedores_cnpj_aberto_idx on public.fin_pagar_fornecedores (cnpj)
  where situacao in ('pendente', 'gravando', 'incerto');

alter table public.fin_pagar_baixas enable row level security;
alter table public.fin_pagar_envios enable row level security;
alter table public.fin_pagar_esperadas enable row level security;
alter table public.fin_pagar_fornecedores enable row level security;
revoke all on public.fin_pagar_baixas, public.fin_pagar_envios, public.fin_pagar_esperadas, public.fin_pagar_fornecedores from anon, authenticated;
revoke all on sequence public.fin_pagar_baixas_id_seq from anon, authenticated;
