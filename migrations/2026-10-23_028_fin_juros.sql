-- Migration 028: Juros e atrasos (dossiê por caso) dentro do Financeiro.
-- fin_juros_casos: um caso por parcela (chave p<id_parcela>) com o registro manual (envio para
--   assinatura e assinatura do síndico), a decisão de quem paga (só GESTOR e GERENTE), o dossiê
--   guardado no momento da decisão e o aviso de ressarcir o condomínio quando a administradora paga.
-- fin_juros_historico: cada registro, decisão e ressarcimento (antes e depois), nunca apagado.
-- fin_juros_banco: pagamentos lidos do arquivo de retorno CNAB 240 que a equipe envia (até o
--   conector do banco existir). Sem número de conta: só o final, como no leitor.
-- Só o servidor lê e grava (service_role): RLS ligado e nenhuma policy para anon ou authenticated.
-- Nada aqui grava no Superlógica. IDEMPOTENTE. Aplicar SÓ no Supabase de teste até o Matheus mandar subir.

create table if not exists public.fin_juros_casos (
  chave                  text        primary key check (chave ~ '^p[0-9]{1,15}$'),
  id_superlogica         integer     not null,
  competencia            text        not null check (competencia ~ '^[0-9]{4}-[0-9]{2}$'),
  id_parcela             bigint      not null,
  id_despesa             bigint,
  situacao               text,
  causa_sugerida         text,
  valor_encargos         numeric(16,2),
  -- registro manual (qualquer pessoa com o condomínio na carteira)
  enviado_assinatura_em  date,
  assinado_em            date,
  assinado_por           text        check (assinado_por is null or assinado_por in ('síndico', 'síndico e subsíndico')),
  registrado_por         uuid,
  registrado_por_email   text,
  registrado_em          timestamptz,
  -- decisão (só GESTOR e GERENTE)
  quem_paga              text        check (quem_paga is null or quem_paga in ('condominio', 'administradora', 'fornecedor', 'a_apurar')),
  justificativa          text        check (justificativa is null or length(justificativa) <= 1000),
  decidido_por           uuid,
  decidido_por_email     text,
  decidido_em            timestamptz,
  snapshot               jsonb,
  -- aviso de ressarcir o condomínio (decisão: administradora)
  ressarcimento          text        check (ressarcimento is null or ressarcimento in ('pendente', 'feito')),
  ressarcimento_valor    numeric(16,2),
  ressarcido_em          timestamptz,
  ressarcido_por         uuid,
  ressarcido_por_email   text,
  ressarcido_obs         text        check (ressarcido_obs is null or length(ressarcido_obs) <= 500),
  criado_em              timestamptz not null default now(),
  atualizado_em          timestamptz not null default now()
);
create index if not exists fin_juros_casos_cond_comp_idx on public.fin_juros_casos (id_superlogica, competencia);
create index if not exists fin_juros_casos_comp_idx on public.fin_juros_casos (competencia);
create index if not exists fin_juros_casos_ressarcir_idx on public.fin_juros_casos (ressarcimento) where ressarcimento = 'pendente';

create table if not exists public.fin_juros_historico (
  id          bigint      generated always as identity primary key,
  chave       text        not null,
  id_superlogica integer  not null,
  acao        text        not null check (acao in ('registro', 'decisao', 'ressarcimento')),
  antes       jsonb,
  depois      jsonb,
  por         uuid,
  por_email   text,
  em          timestamptz not null default now()
);
create index if not exists fin_juros_hist_chave_idx on public.fin_juros_historico (chave, em desc);

create table if not exists public.fin_juros_banco (
  id                    bigint      generated always as identity primary key,
  id_superlogica        integer     not null,
  arquivo_hash          text        not null,
  data_arquivo          date,
  lote                  text,
  seq                   integer,
  segmento              text,
  codigo_barras         text,
  seu_numero            text,
  nosso_numero          text,
  favorecido            text,
  vencimento            date,
  data_pagamento        date,
  data_real             date,
  valor_centavos        bigint,
  valor_real_centavos   bigint,
  valor_titulo_centavos bigint,
  ocorrencias           jsonb       not null default '[]'::jsonb,
  enviado_por           uuid,
  enviado_por_email     text,
  enviado_em            timestamptz not null default now(),
  unique (arquivo_hash, lote, seq)
);
create index if not exists fin_juros_banco_cond_idx on public.fin_juros_banco (id_superlogica, data_pagamento);

alter table public.fin_juros_casos enable row level security;
alter table public.fin_juros_historico enable row level security;
alter table public.fin_juros_banco enable row level security;
revoke all on public.fin_juros_casos, public.fin_juros_historico, public.fin_juros_banco from anon, authenticated;
revoke all on sequence public.fin_juros_historico_id_seq, public.fin_juros_banco_id_seq from anon, authenticated;
