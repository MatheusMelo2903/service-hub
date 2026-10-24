-- Migration 026: caixas de email do financeiro lidas pelo Hub (documentos chegando por email).
-- fin_email_caixas: cada caixa (endereço, servidor IMAP, usuário, senha CIFRADA pelo servidor com
--   a chave EMAIL_FINANCEIRO_CHAVE, finalidade, pasta, onde parou a leitura e o último aviso).
--   A senha nunca sai do servidor: a tela só recebe "senha guardada".
-- fin_email_mensagens: cada email já processado (caixa + UIDVALIDITY + UID), para nunca repetir.
-- fin_entrada ganha a origem (caixa, remetente, assunto, data, corpo resumido) e o tipo do
--   arquivo (PDF, XML da nota ou imagem), e a leitura passa a aceitar o XML.
-- Só o servidor lê e grava (service_role): RLS ligado e nenhuma policy para anon ou authenticated.
-- Aplicar SÓ no Supabase de teste até o Matheus mandar subir ("sobe para producao").
-- IDEMPOTENTE.

create table if not exists public.fin_email_caixas (
  id               uuid primary key default gen_random_uuid(),
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  criado_por       uuid,
  endereco         text not null check (length(endereco) between 3 and 200),
  servidor         text not null default 'imap.kinghost.net' check (servidor ~ '^[a-z0-9.-]{3,120}$'),
  porta            integer not null default 993 check (porta in (993, 143)),
  usuario          text not null check (length(usuario) between 1 and 200),
  senha_cifrada    text,
  finalidade       text not null default 'geral' check (finalidade in ('geral', 'carteira', 'condominio')),
  carteira         integer check (carteira is null or carteira > 0),
  analista         uuid references public.profiles(id) on delete set null,
  condominios      integer[] not null default '{}',
  pasta            text not null default 'INBOX' check (length(pasta) between 1 and 200),
  ativo            boolean not null default false,
  marcar_lido      boolean not null default false,
  ler_desde        date,
  uid_validity     text,
  ultimo_uid       bigint,
  lendo_ate        timestamptz,          -- trava da leitura (um servidor de cada vez por caixa)
  ultima_leitura   timestamptz,
  ultimo_sucesso   timestamptz,
  ultimo_erro      text,
  ultimo_erro_em   timestamptz,
  falhas_seguidas  integer not null default 0,
  lidos_total      integer not null default 0,
  ultimo_teste     jsonb
);
create unique index if not exists fin_email_caixas_endereco_uk on public.fin_email_caixas (lower(endereco), lower(pasta));
create index if not exists fin_email_caixas_ativo_idx on public.fin_email_caixas (ativo);

create table if not exists public.fin_email_mensagens (
  caixa_id      uuid not null references public.fin_email_caixas(id) on delete cascade,
  uid_validity  text not null,
  uid           bigint not null,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  message_id    text,
  remetente     text,
  assunto       text,
  recebido_em   timestamptz,
  status        text not null default 'ok' check (status in ('ok', 'sem_anexo', 'erro', 'falhou', 'ignorado')),
  tentativas    integer not null default 0,
  entradas      uuid[] not null default '{}',
  detalhe       jsonb not null default '{}'::jsonb,
  primary key (caixa_id, uid_validity, uid)
);
create index if not exists fin_email_mensagens_caixa_idx on public.fin_email_mensagens (caixa_id, criado_em desc);

alter table public.fin_entrada add column if not exists origem jsonb;
alter table public.fin_entrada add column if not exists arquivo_mime text not null default 'application/pdf';
alter table public.fin_entrada drop constraint if exists fin_entrada_arquivo_mime_check;
alter table public.fin_entrada add constraint fin_entrada_arquivo_mime_check
  check (arquivo_mime in ('application/pdf', 'application/xml', 'image/jpeg', 'image/png'));
alter table public.fin_entrada drop constraint if exists fin_entrada_leitura_check;
alter table public.fin_entrada add constraint fin_entrada_leitura_check
  check (leitura ~ '^(texto|interna|texto\+interna|nenhuma|xml)(\+xml)?$');
-- Mesma nota (chave de acesso) chegando de novo vira um item só.
create index if not exists fin_entrada_chave_idx on public.fin_entrada ((dados->>'chave_nfe')) where status <> 'descartado';
create index if not exists fin_entrada_remetente_idx on public.fin_entrada ((origem->>'remetente'), status);

alter table public.fin_email_caixas enable row level security;
alter table public.fin_email_mensagens enable row level security;
revoke all on public.fin_email_caixas from anon, authenticated;
revoke all on public.fin_email_mensagens from anon, authenticated;
