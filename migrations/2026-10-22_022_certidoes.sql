-- T50: certidões negativas do condomínio (Prestação de Contas). Uma por tipo e condomínio.
-- Aplicar SÓ no Supabase de teste. Produção só quando o Matheus mandar ("sobe para producao").
-- Só o servidor (service role) lê e grava: RLS ligada sem policy e sem grant para anon e authenticated.

create table if not exists public.certidoes_condominio (
  id uuid primary key default gen_random_uuid(),
  id_superlogica integer not null,
  tipo text not null check (tipo in ('federal', 'estadual', 'municipal', 'trabalhista', 'fgts', 'falencia')),
  situacao text,
  emitida_em date,
  validade date,
  arquivo_nome text,
  caminho text,
  origem text,
  cnpj text,
  user_id uuid,
  atualizado_em timestamptz not null default now(),
  unique (id_superlogica, tipo)
);

-- Alertas do Dashboard filtram por validade (vencendo em até 15 dias ou vencida).
create index if not exists certidoes_condominio_validade_idx on public.certidoes_condominio (validade);

alter table public.certidoes_condominio enable row level security;
revoke all on public.certidoes_condominio from anon, authenticated;

-- Bucket privado dos PDFs (<id_superlogica>/<tipo>.pdf). Sem policy: só o servidor acessa.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('certidoes', 'certidoes', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;
