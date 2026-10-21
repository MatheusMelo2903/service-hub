-- T42: custo de cada chamada de processamento (registro do servidor) e resumo por dia.
-- Aplicar SÓ no Supabase de teste (ledgyprytkuvgtbunsck). Produção só quando o Matheus mandar.
-- Só o servidor (service role) lê e grava: RLS ligada sem policy e sem grant para anon e authenticated.

create table if not exists public.api_uso (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  funcao text not null,
  modelo text,
  user_id uuid,
  id_superlogica integer,
  entrada integer not null default 0,
  saida integer not null default 0,
  cache_lido integer not null default 0,
  cache_criado integer not null default 0,
  custo_usd numeric(14,6),
  ok boolean not null default true,
  status integer
);

create index if not exists api_uso_criado_em_idx on public.api_uso (criado_em);
create index if not exists api_uso_funcao_idx on public.api_uso (funcao, criado_em);

alter table public.api_uso enable row level security;
revoke all on public.api_uso from anon, authenticated;

-- Resumo por dia (fuso de Brasília) e função, para o painel não ler linha por linha.
create or replace view public.api_uso_dia with (security_invoker = true) as
select (criado_em at time zone 'America/Sao_Paulo')::date as dia,
       funcao,
       count(*)::integer as chamadas,
       sum(entrada)::bigint as entrada,
       sum(saida)::bigint as saida,
       sum(cache_lido)::bigint as cache_lido,
       sum(cache_criado)::bigint as cache_criado,
       coalesce(sum(custo_usd), 0)::numeric(14,6) as custo_usd
from public.api_uso
group by 1, 2;

revoke all on public.api_uso_dia from anon, authenticated;
grant select on public.api_uso_dia to service_role;
grant select, insert on public.api_uso to service_role;
