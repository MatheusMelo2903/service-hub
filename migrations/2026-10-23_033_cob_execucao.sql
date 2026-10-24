-- Migration 033: execução da cobrança pelo Hub (acordo à vista, CRM, status financeiro e cadastro).
-- cob_politica_acordo: política de acordo de cada condomínio, cadastrada pela gestão no Hub
--   (juros, multa, honorários, desconto máximo, teto do automático, prazo e parcelas). Sem ela o
--   Hub não monta acordo.
-- cob_historico: tudo o que o Hub gravou no Superlógica por esta frente (acordo emitido e
--   desfeito, contato no CRM, status financeiro, alterações de cadastro) e as mudanças da política,
--   com o antes e o depois. CPF, email e telefone entram só mascarados. Nunca apagado.
-- Só o servidor lê e grava (service_role): RLS ligado e nenhuma policy para anon ou authenticated.
-- IDEMPOTENTE. Aplicar SÓ no Supabase de teste até o Matheus mandar subir.

create table if not exists public.cob_politica_acordo (
  id_superlogica        integer     primary key check (id_superlogica > 0),
  juros_pct             numeric(6,3) not null check (juros_pct >= 0 and juros_pct <= 1),
  multa_pct             numeric(6,3) not null check (multa_pct >= 0 and multa_pct <= 2),
  honorarios_pct        numeric(6,3) not null default 0 check (honorarios_pct >= 0 and honorarios_pct <= 20),
  desconto_max_pct      numeric(6,3) not null default 0 check (desconto_max_pct >= 0 and desconto_max_pct <= 100),
  teto_automatico       numeric(14,2) not null default 0 check (teto_automatico >= 0),
  prazo_max_dias        integer     not null default 10 check (prazo_max_dias between 1 and 30),
  parcelas_max          integer     not null default 1 check (parcelas_max between 1 and 60),
  aprovada_sindico      boolean     not null default false,
  observacao            text        check (observacao is null or length(observacao) <= 500),
  atualizado_por        uuid,
  atualizado_por_email  text,
  atualizado_em         timestamptz not null default now()
);

create table if not exists public.cob_historico (
  id              bigint      generated always as identity primary key,
  id_superlogica  integer     not null,
  id_unidade      text        check (id_unidade is null or id_unidade ~ '^[0-9]{1,12}$'),
  tipo            text        not null check (tipo in ('politica', 'acordo_emitir', 'acordo_desfazer', 'crm_contato', 'status_financeiro',
                                                       'contato_atualizar', 'contato_incluir', 'contato_sair', 'segundo_sacado', 'troca_proprietario')),
  ok              boolean     not null default false,
  incerto         boolean     not null default false,
  registro        text,
  antes           jsonb,
  depois          jsonb,
  avisos          jsonb,
  detalhe         jsonb,
  por             uuid,
  por_email       text,
  em              timestamptz not null default now()
);
create index if not exists cob_historico_cond_idx on public.cob_historico (id_superlogica, em desc);
create index if not exists cob_historico_unidade_idx on public.cob_historico (id_superlogica, id_unidade, em desc);
create index if not exists cob_historico_tipo_idx on public.cob_historico (tipo, em desc);

alter table public.cob_politica_acordo enable row level security;
alter table public.cob_historico enable row level security;
revoke all on public.cob_politica_acordo, public.cob_historico from anon, authenticated;
revoke all on sequence public.cob_historico_id_seq from anon, authenticated;
