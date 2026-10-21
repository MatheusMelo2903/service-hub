-- Migration 015: fila da entrada de documentos (T33, substitui o Paybox).
-- Cada PDF que o analista sobe vira um rascunho com o que foi lido; ao aprovar, o servidor cria
-- a despesa no Superlógica com o PDF anexado e guarda aqui o resultado.
-- Só o servidor lê e grava (service_role): RLS ligado e nenhuma policy para anon ou authenticated.
-- Aplicar SÓ no Supabase de teste (ledgyprytkuvgtbunsck) até o Matheus mandar subir.

create table if not exists public.fin_entrada (
  id              uuid primary key default gen_random_uuid(),
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  criado_por      uuid,
  criado_por_email text,
  status          text not null default 'rascunho' check (status in ('rascunho', 'lancado', 'descartado', 'incerto')),
  nome_arquivo    text not null,
  hash_sha256     text not null,
  tamanho         integer not null,
  arquivo_base64  text not null,
  leitura         text not null check (leitura in ('texto', 'interna', 'texto+interna', 'nenhuma')),
  tipo            text,
  id_superlogica  integer,
  cond_documento  integer,           -- condomínio achado pelo CNPJ do documento (pode diferir do escolhido)
  dados           jsonb not null default '{}'::jsonb,  -- campos lidos e editados
  alertas         jsonb not null default '[]'::jsonb,
  id_despesa      text,
  id_parcela      text,
  id_arquivo      text,
  lancado_em      timestamptz,
  lancado_por     uuid,
  resultado       jsonb
);

create index if not exists fin_entrada_status_idx on public.fin_entrada (status, criado_em desc);
create index if not exists fin_entrada_cond_idx on public.fin_entrada (id_superlogica, status);
create index if not exists fin_entrada_linha_idx on public.fin_entrada ((dados->>'linha')) where status <> 'descartado';
-- O mesmo arquivo não entra duas vezes na fila (descartado pode voltar).
create unique index if not exists fin_entrada_hash_uk on public.fin_entrada (hash_sha256) where status <> 'descartado';

alter table public.fin_entrada enable row level security;
revoke all on public.fin_entrada from anon, authenticated;
