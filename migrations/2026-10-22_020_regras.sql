-- Regras do condomínio (substituição do CondGPT): acervo de convenção, regimento e atas,
-- trechos por artigo com busca em português, notificações com histórico, mandatos,
-- conferência de ata (só aviso) e FAQ.
-- Aplicar SÓ no Supabase de teste (ledgyprytkuvgtbunsck). Produção só quando o Matheus mandar.
-- Só o servidor (service role) lê e grava: RLS ligada sem policy e sem grant para anon e authenticated.

create extension if not exists unaccent with schema extensions;

-- Busca em português sem acento ("convencao" acha "convenção").
do $$ begin
  if not exists (select 1 from pg_ts_config where cfgname = 'pt_regras') then
    create text search configuration public.pt_regras (copy = pg_catalog.portuguese);
    alter text search configuration public.pt_regras
      alter mapping for hword, hword_part, word with extensions.unaccent, portuguese_stem;
  end if;
end $$;

-- Documento do acervo (um PDF). tipo: convencao, regimento, ata, regulamento, outro.
-- vigente: a versão que vale (convenção e regimento antigos ficam como histórico).
create table if not exists public.regras_documentos (
  id bigint generated always as identity primary key,
  id_superlogica integer,
  condgpt_slug text,
  cnpj text,
  tipo text not null check (tipo in ('convencao', 'regimento', 'ata', 'regulamento', 'outro')),
  titulo text not null,
  data_documento date,
  vigente boolean not null default true,
  origem text not null default 'upload' check (origem in ('condgpt', 'upload', 'ata_hub')),
  arquivo_path text,
  arquivo_bytes integer,
  hash_texto text,
  texto text,
  resumo text,
  observacao text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  criado_por uuid
);
create index if not exists regras_doc_cond_idx on public.regras_documentos (id_superlogica, tipo, vigente);
create index if not exists regras_doc_slug_idx on public.regras_documentos (condgpt_slug);
create unique index if not exists regras_doc_hash_uidx on public.regras_documentos (id_superlogica, tipo, hash_texto) where hash_texto is not null;

-- Trecho citável (um artigo, parágrafo grande ou bloco de ata). rotulo: "Art. 44", "Capítulo III".
create table if not exists public.regras_trechos (
  id bigint generated always as identity primary key,
  documento_id bigint not null references public.regras_documentos (id) on delete cascade,
  id_superlogica integer,
  ordem integer not null,
  rotulo text,
  titulo text,
  texto text not null,
  pagina integer,
  tsv tsvector generated always as (to_tsvector('public.pt_regras'::regconfig, coalesce(rotulo, '') || ' ' || coalesce(titulo, '') || ' ' || texto)) stored
);
create index if not exists regras_trechos_doc_idx on public.regras_trechos (documento_id, ordem);
create index if not exists regras_trechos_cond_idx on public.regras_trechos (id_superlogica);
create index if not exists regras_trechos_tsv_idx on public.regras_trechos using gin (tsv);

-- Notificação (advertência ou multa) por unidade: histórico e reincidência.
-- status: rascunho, registrada (ocorrência no Superlógica), regularizada, convertida_multa, cancelada.
create table if not exists public.regras_notificacoes (
  id bigint generated always as identity primary key,
  id_superlogica integer not null,
  id_unidade integer,
  unidade text,
  bloco text,
  destinatario text,
  tipo text not null check (tipo in ('advertencia', 'multa')),
  data_fato date,
  ocorrencia text,
  texto text,
  fundamentos jsonb not null default '[]'::jsonb,
  valor numeric(12, 2),
  regra_valor text,
  prazo_regularizacao date,
  status text not null default 'rascunho' check (status in ('rascunho', 'registrada', 'regularizada', 'convertida_multa', 'cancelada')),
  id_ocorrencia_sl text,
  id_cobranca_sl text,
  origem text not null default 'hub' check (origem in ('hub', 'condgpt')),
  origem_id text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  criado_por uuid
);
create index if not exists regras_notif_cond_idx on public.regras_notificacoes (id_superlogica, criado_em desc);
create index if not exists regras_notif_unid_idx on public.regras_notificacoes (id_superlogica, id_unidade, criado_em desc);
create index if not exists regras_notif_unidtxt_idx on public.regras_notificacoes (id_superlogica, unidade);
create unique index if not exists regras_notif_origem_uidx on public.regras_notificacoes (origem, origem_id) where origem_id is not null;

-- Mandato tirado de ata (síndico, subsíndico, conselho). Base do alerta de vencimento.
create table if not exists public.regras_mandatos (
  id bigint generated always as identity primary key,
  id_superlogica integer not null,
  cargo text not null,
  nome text,
  inicio date,
  fim date,
  documento_id bigint references public.regras_documentos (id) on delete set null,
  trecho text,
  conferido boolean not null default false,
  criado_em timestamptz not null default now()
);
create index if not exists regras_mandatos_cond_idx on public.regras_mandatos (id_superlogica, fim);

-- Conferência da ata contra as regras (quórum, prazo de edital, competência). Só aviso:
-- nunca altera o texto da ata.
create table if not exists public.regras_conferencias_ata (
  id bigint generated always as identity primary key,
  id_superlogica integer not null,
  transcricao_id text,
  itens jsonb not null default '[]'::jsonb,
  resumo text,
  criado_em timestamptz not null default now(),
  criado_por uuid
);
create index if not exists regras_conf_ata_cond_idx on public.regras_conferencias_ata (id_superlogica, criado_em desc);

-- FAQ automático por condomínio (cada resposta com os trechos que a sustentam).
create table if not exists public.regras_faq (
  id bigint generated always as identity primary key,
  id_superlogica integer not null,
  tema text,
  pergunta text not null,
  resposta text not null,
  fundamentos jsonb not null default '[]'::jsonb,
  atualizado_em timestamptz not null default now()
);
create index if not exists regras_faq_cond_idx on public.regras_faq (id_superlogica);

-- Ligação identificador do CondGPT, CNPJ e código do Superlógica (usada na importação).
create table if not exists public.regras_mapa_condgpt (
  slug text primary key,
  nome text,
  cnpj text,
  id_superlogica integer,
  observacao text
);

-- Busca de trechos. p_id null = todos os condomínios (comparação). Primeiro tenta todas as
-- palavras; se nada vier, aceita qualquer palavra. p_tipos null = todos os tipos.
create or replace function public.regras_buscar(p_id integer, p_consulta text, p_tipos text[] default null, p_limite integer default 12, p_so_vigentes boolean default true)
returns table (trecho_id bigint, documento_id bigint, id_superlogica integer, tipo text, titulo_documento text, data_documento date, vigente boolean, rotulo text, titulo text, texto text, pagina integer, ordem integer, rank real)
language plpgsql stable
set search_path = public, extensions, pg_catalog
as $$
declare
  q tsquery;
  qor tsquery;
  n integer;
begin
  q := websearch_to_tsquery('public.pt_regras'::regconfig, coalesce(p_consulta, ''));
  return query
    select t.id, d.id, d.id_superlogica, d.tipo, d.titulo, d.data_documento, d.vigente, t.rotulo, t.titulo, t.texto, t.pagina, t.ordem, ts_rank_cd(t.tsv, q)
    from regras_trechos t join regras_documentos d on d.id = t.documento_id
    where (p_id is null or d.id_superlogica = p_id)
      and (p_tipos is null or d.tipo = any (p_tipos))
      and (not p_so_vigentes or d.vigente or d.tipo = 'ata')
      and t.tsv @@ q
    order by ts_rank_cd(t.tsv, q) desc, d.data_documento desc nulls last
    limit least(greatest(coalesce(p_limite, 12), 1), 60);
  get diagnostics n = row_count;
  if n > 0 then return; end if;
  select string_agg(quote_literal(w), ' | ')::text into p_consulta
    from unnest(tsvector_to_array(to_tsvector('public.pt_regras'::regconfig, coalesce(p_consulta, '')))) as w;
  if p_consulta is null then return; end if;
  qor := to_tsquery('public.pt_regras'::regconfig, p_consulta);
  return query
    select t.id, d.id, d.id_superlogica, d.tipo, d.titulo, d.data_documento, d.vigente, t.rotulo, t.titulo, t.texto, t.pagina, t.ordem, ts_rank_cd(t.tsv, qor)
    from regras_trechos t join regras_documentos d on d.id = t.documento_id
    where (p_id is null or d.id_superlogica = p_id)
      and (p_tipos is null or d.tipo = any (p_tipos))
      and (not p_so_vigentes or d.vigente or d.tipo = 'ata')
      and t.tsv @@ qor
    order by ts_rank_cd(t.tsv, qor) desc, d.data_documento desc nulls last
    limit least(greatest(coalesce(p_limite, 12), 1), 60);
end $$;

alter table public.regras_documentos enable row level security;
alter table public.regras_trechos enable row level security;
alter table public.regras_notificacoes enable row level security;
alter table public.regras_mandatos enable row level security;
alter table public.regras_conferencias_ata enable row level security;
alter table public.regras_faq enable row level security;
alter table public.regras_mapa_condgpt enable row level security;
revoke all on public.regras_documentos, public.regras_trechos, public.regras_notificacoes, public.regras_mandatos,
  public.regras_conferencias_ata, public.regras_faq, public.regras_mapa_condgpt from anon, authenticated;
revoke execute on function public.regras_buscar(integer, text, text[], integer, boolean) from public, anon, authenticated;
grant execute on function public.regras_buscar(integer, text, text[], integer, boolean) to service_role;

-- PDFs do acervo: bucket privado, só o servidor (service role) lê e grava.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('regras', 'regras', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;
