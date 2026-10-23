-- 024: alinha o banco de PRODUÇÃO (mtucxdfepkwsfnqpfydb) com o banco de teste (ledgyprytkuvgtbunsck).
-- Aplicada em 23/10/2026 com autorização do Matheus ("pode subir para produção").
-- A produção estava com a estrutura de julho (condomínios com id em texto, demandas, laudos e
-- histórico de outro formato, sem as tabelas novas). Gerada a partir do catálogo do banco de teste.
-- Nada é apagado: as tabelas antigas vão para o schema legado_20261023 e os perfis ganham uma cópia lá.
-- Os condomínios voltam sozinhos pela sincronização diária com o Superlógica (roda ao ligar o servidor).

begin;

-- 0. Cópia de segurança do que existe hoje.
create schema if not exists legado_20261023;
revoke all on schema legado_20261023 from public, anon, authenticated;
create table if not exists legado_20261023.profiles as select * from public.profiles;
alter table public.demandas set schema legado_20261023;
alter table public.laudos set schema legado_20261023;
alter table public.historico set schema legado_20261023;
alter table public.hub_progresso set schema legado_20261023;
alter table public.condominios set schema legado_20261023;

-- 1. Extensão e busca em português sem acento.
create extension if not exists unaccent with schema extensions;
do $$ begin
  if not exists (select 1 from pg_ts_config where cfgname = 'pt_regras') then
    create text search configuration public.pt_regras (copy = pg_catalog.portuguese);
    alter text search configuration public.pt_regras
      alter mapping for hword, hword_part, word with extensions.unaccent, portuguese_stem;
  end if;
end $$;

-- 2. Sequências.
create sequence if not exists public.auditoria_id_seq;
create sequence if not exists public.fin_sync_log_id_seq;

-- 3. Tabelas (igual ao teste).
create table public.alertas (
  id uuid default gen_random_uuid() not null,
  id_superlogica integer not null,
  chave text not null,
  tipo text not null,
  titulo text not null,
  detalhe jsonb default '{}'::jsonb not null,
  status text default 'novo'::text not null,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  atualizado_por uuid
);
create table public.alertas_config (
  id_superlogica integer not null,
  saldo_minimo numeric(14,2),
  atualizado_em timestamp with time zone default now() not null,
  atualizado_por uuid
);
create table public.alertas_preferencias (
  user_id uuid not null,
  silenciados text[] default '{}'::text[] not null,
  pausado boolean default false not null,
  atualizado_em timestamp with time zone default now() not null
);
create table public.api_uso (
  id bigint generated always as identity not null,
  criado_em timestamp with time zone default now() not null,
  funcao text not null,
  modelo text,
  user_id uuid,
  id_superlogica integer,
  entrada integer default 0 not null,
  saida integer default 0 not null,
  cache_lido integer default 0 not null,
  cache_criado integer default 0 not null,
  custo_usd numeric(14,6),
  ok boolean default true not null,
  status integer
);
create table public.auditoria (
  id bigint default nextval('auditoria_id_seq'::regclass) not null,
  criado_em timestamp with time zone default now() not null,
  user_id uuid,
  email text,
  papel text,
  acao text not null,
  rota text,
  metodo text,
  status integer,
  id_superlogica integer,
  ip text,
  navegador text,
  detalhe jsonb,
  suspeito boolean default false not null,
  motivo text
);
create table public.certidoes_condominio (
  id uuid default gen_random_uuid() not null,
  id_superlogica integer not null,
  tipo text not null,
  situacao text,
  emitida_em date,
  validade date,
  arquivo_nome text,
  caminho text,
  origem text,
  cnpj text,
  user_id uuid,
  atualizado_em timestamp with time zone default now() not null
);
create table public.condominio_contexto (
  condominio_id uuid not null,
  md text,
  content_hash text,
  gerado_em timestamp with time zone
);
create table public.condominios (
  id uuid default gen_random_uuid() not null,
  nome text not null,
  id_superlogica integer,
  updated_at timestamp with time zone default now(),
  unidades_total integer default 0 not null,
  inadimplencia_valor numeric(12,2) default 0 not null,
  inadimplencia_qtd integer default 0 not null,
  endereco text,
  cnpj text,
  proposito_teste text,
  mockup boolean default false not null,
  raw_hash text,
  synced_at timestamp with time zone,
  criado_em timestamp with time zone default now() not null,
  sindico text
);
create table public.config_geral (
  chave text not null,
  valor jsonb not null,
  atualizado_em timestamp with time zone default now() not null,
  atualizado_por uuid
);
create table public.demandas (
  id uuid default gen_random_uuid() not null,
  origem_texto_bruto text,
  processado_em timestamp with time zone,
  fonte text,
  condominio_id uuid,
  titulo text,
  categoria text,
  prioridade text,
  status text default 'aberta'::text,
  criado_em timestamp with time zone default now() not null,
  mockup boolean default false not null
);
create table public.fin_anexo_leitura (
  chave text not null,
  id_arquivo bigint not null,
  id_superlogica integer,
  extensao text,
  leitura text not null,
  texto text,
  meta jsonb default '{}'::jsonb not null,
  lido_em timestamp with time zone default now() not null
);
create table public.fin_anexos (
  id_arquivo bigint not null,
  id_despesa bigint not null,
  id_condominio integer not null,
  etiqueta text,
  nome text,
  extensao text,
  tamanho bigint,
  hash text,
  dt_envio date,
  id_responsavel bigint,
  visto_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null
);
create table public.fin_auditoria_sl (
  id_auditoria bigint not null,
  dt_data timestamp with time zone not null,
  id_usuario integer,
  usuario text,
  sistema boolean default false not null,
  id_condominio integer,
  condominio_texto text,
  texto text,
  id_despesa bigint,
  id_parcela bigint,
  id_arquivo bigint,
  criado_em timestamp with time zone default now() not null
);
create table public.fin_avisos (
  dia date not null,
  chave text not null,
  origem text not null,
  gerado_em timestamp with time zone default now() not null,
  conteudo jsonb default '{}'::jsonb not null
);
create table public.fin_avisos_execucoes (
  id uuid default gen_random_uuid() not null,
  dia date not null,
  origem text not null,
  status text default 'andamento'::text not null,
  iniciado_em timestamp with time zone default now() not null,
  terminado_em timestamp with time zone,
  usuario uuid,
  parametros jsonb default '{}'::jsonb not null,
  resumo jsonb default '{}'::jsonb not null
);
create table public.fin_cobrancas (
  id_recebimento bigint not null,
  id_condominio integer not null,
  id_unidade bigint,
  unidade text,
  bloco text,
  id_conta integer,
  status text,
  dt_vencimento date,
  dt_competencia date,
  dt_geracao date,
  dt_liquidacao date,
  vl_emitido numeric(16,2),
  vl_total numeric(16,2),
  remessa_status text,
  id_lote text,
  parcelamento text,
  visto_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null
);
create table public.fin_condominios (
  id_condominio integer not null,
  nome text,
  fantasia text,
  ultima_sincronizacao timestamp with time zone,
  sincronizado_de date,
  sincronizado_ate date,
  sync_tipos jsonb default '{}'::jsonb not null,
  atualizado_em timestamp with time zone default now() not null
);
create table public.fin_contas (
  id_conta integer not null,
  id_condominio integer not null,
  descricao text,
  principal boolean default false not null,
  banco text,
  id_banco integer,
  id_tipo integer,
  saldo numeric(16,2),
  dt_abertura date,
  dt_fechamento date,
  dt_bloqueio date,
  visto_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null
);
create table public.fin_despesas (
  id_despesa bigint not null,
  id_condominio integer not null,
  id_fornecedor bigint,
  fornecedor text,
  fornecedor_cnpj text,
  documento text,
  id_tipo_doc integer,
  serie_nota text,
  dt_despesa date,
  dt_geracao date,
  recorrente boolean,
  id_conta integer,
  apropriacao jsonb default '[]'::jsonb not null,
  visto_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null
);
create table public.fin_entrada (
  id uuid default gen_random_uuid() not null,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  criado_por uuid,
  criado_por_email text,
  status text default 'rascunho'::text not null,
  nome_arquivo text not null,
  hash_sha256 text not null,
  tamanho integer not null,
  arquivo_base64 text not null,
  leitura text not null,
  tipo text,
  id_superlogica integer,
  cond_documento integer,
  dados jsonb default '{}'::jsonb not null,
  alertas jsonb default '[]'::jsonb not null,
  id_despesa text,
  id_parcela text,
  id_arquivo text,
  lancado_em timestamp with time zone,
  lancado_por uuid,
  resultado jsonb
);
create table public.fin_fechamento_marca (
  id_superlogica integer not null,
  competencia text not null,
  item text not null,
  ativo boolean default true not null,
  pendencias integer default 0 not null,
  observacao text,
  marcado_por uuid,
  marcado_por_email text,
  marcado_em timestamp with time zone default now() not null,
  chaves jsonb
);
create table public.fin_fechamento_status (
  id_superlogica integer not null,
  competencia text not null,
  pronto boolean default false not null,
  falta jsonb default '[]'::jsonb not null,
  itens jsonb default '[]'::jsonb not null,
  calculado_em timestamp with time zone default now() not null
);
create table public.fin_movimentos (
  chave text not null,
  id_movimento bigint,
  id_conta integer not null,
  id_condominio integer,
  dt_data date not null,
  dc text,
  valor numeric(16,2),
  descricao text,
  origem integer,
  documento text,
  id_despesa bigint,
  id_parcela bigint,
  id_forma_pag integer,
  num_anexos integer,
  fitid text,
  remessa_status text,
  visto_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null
);
create table public.fin_parcelas (
  id_parcela bigint not null,
  id_despesa bigint not null,
  id_condominio integer not null,
  liquidada boolean default false not null,
  dt_vencimento date,
  dt_liquidacao date,
  dt_previsao_credito date,
  valor numeric(16,2),
  valor_bruto numeric(16,2),
  juros numeric(16,2),
  multa numeric(16,2),
  desconto numeric(16,2),
  codigo_barras text,
  id_forma_pag integer,
  remessa_status text,
  complemento text,
  num_anexos integer default 0 not null,
  documentos_pendentes jsonb default '[]'::jsonb not null,
  visto_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null
);
create table public.fin_sync_log (
  id bigint default nextval('fin_sync_log_id_seq'::regclass) not null,
  execucao uuid not null,
  origem text default 'script'::text not null,
  usuario uuid,
  tipo text not null,
  janela_inicio date,
  janela_fim date,
  id_condominio integer,
  status text not null,
  itens integer,
  gravados integer,
  duracao_ms integer,
  erro text,
  criado_em timestamp with time zone default now() not null
);
create table public.fin_usuarios_superlogica (
  id_usuario_sl text not null,
  apelido text default ''::text not null,
  profile_id uuid,
  carteira integer,
  atualizado_em timestamp with time zone default now() not null,
  atualizado_por uuid
);
create table public.historico (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  condominio_id uuid,
  evento text,
  descricao text,
  mockup boolean default false not null
);
create table public.hub_progresso (
  id text not null,
  fase integer,
  etapa integer,
  titulo text,
  responsavel text,
  status text,
  atualizado_por text,
  atualizado_em timestamp with time zone default now()
);
create table public.laudos (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  condominio_id uuid,
  unidade text,
  tipo text,
  consumo_m3 numeric(10,2),
  data_leitura date,
  mockup boolean default false not null
);
create table public.pessoas (
  id_contato_con bigint not null,
  unidade_id bigint not null,
  tipo text,
  nome text,
  raw_hash text
);
create table public.previsoes_geracoes (
  id uuid default gen_random_uuid() not null,
  previsao_id uuid not null,
  payload_hash text not null,
  pdf_url text,
  pptx_url text,
  gerado_por uuid not null,
  gerado_em timestamp with time zone default now() not null,
  duracao_ms integer
);
create table public.previsoes_orcamentarias (
  id uuid default gen_random_uuid() not null,
  condominio_id uuid not null,
  ano_referencia integer not null,
  periodo text not null,
  status text default 'rascunho'::text not null,
  payload_json jsonb not null,
  payload_hash text not null,
  criado_por uuid not null,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null
);
create table public.regras_conferencias_ata (
  id bigint generated always as identity not null,
  id_superlogica integer not null,
  transcricao_id text,
  itens jsonb default '[]'::jsonb not null,
  resumo text,
  criado_em timestamp with time zone default now() not null,
  criado_por uuid
);
create table public.regras_documentos (
  id bigint generated always as identity not null,
  id_superlogica integer,
  condgpt_slug text,
  cnpj text,
  tipo text not null,
  titulo text not null,
  data_documento date,
  vigente boolean default true not null,
  origem text default 'upload'::text not null,
  arquivo_path text,
  arquivo_bytes integer,
  hash_texto text,
  texto text,
  resumo text,
  observacao text,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  criado_por uuid
);
create table public.regras_faq (
  id bigint generated always as identity not null,
  id_superlogica integer not null,
  tema text,
  pergunta text not null,
  resposta text not null,
  fundamentos jsonb default '[]'::jsonb not null,
  atualizado_em timestamp with time zone default now() not null
);
create table public.regras_mandatos (
  id bigint generated always as identity not null,
  id_superlogica integer not null,
  cargo text not null,
  nome text,
  inicio date,
  fim date,
  documento_id bigint,
  trecho text,
  conferido boolean default false not null,
  criado_em timestamp with time zone default now() not null
);
create table public.regras_mapa_condgpt (
  slug text not null,
  nome text,
  cnpj text,
  id_superlogica integer,
  observacao text
);
create table public.regras_notificacoes (
  id bigint generated always as identity not null,
  id_superlogica integer not null,
  id_unidade integer,
  unidade text,
  bloco text,
  destinatario text,
  tipo text not null,
  data_fato date,
  ocorrencia text,
  texto text,
  fundamentos jsonb default '[]'::jsonb not null,
  valor numeric(12,2),
  regra_valor text,
  prazo_regularizacao date,
  status text default 'rascunho'::text not null,
  id_ocorrencia_sl text,
  id_cobranca_sl text,
  origem text default 'hub'::text not null,
  origem_id text,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  criado_por uuid
);
create table public.regras_trechos (
  id bigint generated always as identity not null,
  documento_id bigint not null,
  id_superlogica integer,
  ordem integer not null,
  rotulo text,
  titulo text,
  texto text not null,
  pagina integer,
  tsv tsvector generated always as (to_tsvector('public.pt_regras'::regconfig, coalesce(rotulo, '') || ' ' || coalesce(titulo, '') || ' ' || texto)) stored
);
create table public.sync_status (
  id bigint generated always as identity not null,
  rodado_em timestamp with time zone default now() not null,
  resultado text not null,
  processados integer,
  sincronizados integer,
  pulados integer,
  erro_msg text
);
create table public.trabalhos_salvos (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  tipo text not null,
  id_superlogica integer,
  titulo text not null,
  dados jsonb default '{}'::jsonb not null,
  arquivos jsonb default '[]'::jsonb not null,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  expira_em timestamp with time zone default (now() + '7 days'::interval) not null
);
create table public.transcricoes (
  id uuid default gen_random_uuid() not null,
  criado_em timestamp with time zone default now() not null,
  user_id uuid,
  email text,
  id_superlogica integer,
  condominio_nome text,
  origem text not null,
  arquivo_nome text,
  servico_id text,
  status text not null,
  texto text,
  caracteres integer,
  duracao_seg numeric,
  usada_em_ata timestamp with time zone,
  apagada_em timestamp with time zone,
  apagada_por uuid
);
create table public.unidades (
  id_unidade_uni bigint not null,
  condominio_id uuid not null,
  st_unidade_uni text,
  st_bloco_uni text,
  raw_hash text,
  synced_at timestamp with time zone
);
alter sequence public.auditoria_id_seq owned by public.auditoria.id;
alter sequence public.fin_sync_log_id_seq owned by public.fin_sync_log.id;

-- 4. Perfis: mantém as pessoas e as permissões de hoje; ganha as colunas novas.
alter table public.profiles add column if not exists carteiras integer[] default '{}'::integer[] not null;
alter table public.profiles add column if not exists bloqueado boolean default false not null;
alter table public.profiles add column if not exists concede jsonb default '{}'::jsonb not null;
alter table public.profiles alter column role set default 'OPERACIONAL'::text;
alter table public.profiles alter column permissoes set default '{"atas": {"acoes": [], "visivel": false}, "boletos": {"acoes": [], "visivel": false}, "tarefas": {"acoes": [], "visivel": false}, "cobranca": {"acoes": [], "visivel": false}, "dashboard": {"acoes": [], "visivel": true}, "comparativo": {"acoes": [], "visivel": false}, "conciliacao": {"acoes": [], "visivel": false}, "configuracoes": {"acoes": [], "visivel": false}, "notas_fiscais": {"acoes": [], "visivel": false}, "central_alertas": {"acoes": ["ver"], "visivel": true}, "leitura_consumo": {"acoes": [], "visivel": false}, "ficha_condominio": {"acoes": [], "visivel": false}, "prestacao_contas": {"acoes": [], "visivel": false}, "importar_despesas": {"acoes": [], "visivel": false}, "importar_unidades": {"acoes": [], "visivel": false}}'::jsonb;
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check CHECK ((role = ANY (ARRAY['GESTOR'::text, 'GERENTE'::text, 'OPERACIONAL'::text])));
create index if not exists profiles_role_idx on public.profiles using btree (role);
-- Escrita direta do navegador fechada (como no teste): perfis só pelo servidor.
drop policy if exists gestor_deleta on public.profiles;
drop policy if exists gestor_edita_todos on public.profiles;
drop policy if exists gestor_insere on public.profiles;
drop policy if exists gestor_ve_todos on public.profiles;

-- 5. Restrições.
alter table public.alertas add constraint alertas_pkey PRIMARY KEY (id);
alter table public.alertas_config add constraint alertas_config_pkey PRIMARY KEY (id_superlogica);
alter table public.alertas_preferencias add constraint alertas_preferencias_pkey PRIMARY KEY (user_id);
alter table public.api_uso add constraint api_uso_pkey PRIMARY KEY (id);
alter table public.auditoria add constraint auditoria_pkey PRIMARY KEY (id);
alter table public.certidoes_condominio add constraint certidoes_condominio_pkey PRIMARY KEY (id);
alter table public.condominio_contexto add constraint condominio_contexto_pkey PRIMARY KEY (condominio_id);
alter table public.condominios add constraint condominios_pkey PRIMARY KEY (id);
alter table public.config_geral add constraint config_geral_pkey PRIMARY KEY (chave);
alter table public.demandas add constraint demandas_pkey PRIMARY KEY (id);
alter table public.fin_anexo_leitura add constraint fin_anexo_leitura_pkey PRIMARY KEY (chave);
alter table public.fin_anexos add constraint fin_anexos_pkey PRIMARY KEY (id_arquivo, id_despesa);
alter table public.fin_auditoria_sl add constraint fin_auditoria_sl_pkey PRIMARY KEY (id_auditoria);
alter table public.fin_avisos add constraint fin_avisos_pkey PRIMARY KEY (dia, chave);
alter table public.fin_avisos_execucoes add constraint fin_avisos_execucoes_pkey PRIMARY KEY (id);
alter table public.fin_cobrancas add constraint fin_cobrancas_pkey PRIMARY KEY (id_recebimento);
alter table public.fin_condominios add constraint fin_condominios_pkey PRIMARY KEY (id_condominio);
alter table public.fin_contas add constraint fin_contas_pkey PRIMARY KEY (id_conta);
alter table public.fin_despesas add constraint fin_despesas_pkey PRIMARY KEY (id_despesa);
alter table public.fin_entrada add constraint fin_entrada_pkey PRIMARY KEY (id);
alter table public.fin_fechamento_marca add constraint fin_fechamento_marca_pkey PRIMARY KEY (id_superlogica, competencia, item);
alter table public.fin_fechamento_status add constraint fin_fechamento_status_pkey PRIMARY KEY (id_superlogica, competencia);
alter table public.fin_movimentos add constraint fin_movimentos_pkey PRIMARY KEY (chave);
alter table public.fin_parcelas add constraint fin_parcelas_pkey PRIMARY KEY (id_parcela);
alter table public.fin_sync_log add constraint fin_sync_log_pkey PRIMARY KEY (id);
alter table public.fin_usuarios_superlogica add constraint fin_usuarios_superlogica_pkey PRIMARY KEY (id_usuario_sl);
alter table public.historico add constraint historico_pkey PRIMARY KEY (id);
alter table public.hub_progresso add constraint hub_progresso_pkey PRIMARY KEY (id);
alter table public.laudos add constraint laudos_pkey PRIMARY KEY (id);
alter table public.pessoas add constraint pessoas_pkey PRIMARY KEY (id_contato_con);
alter table public.previsoes_geracoes add constraint previsoes_geracoes_pkey PRIMARY KEY (id);
alter table public.previsoes_orcamentarias add constraint previsoes_orcamentarias_pkey PRIMARY KEY (id);
alter table public.regras_conferencias_ata add constraint regras_conferencias_ata_pkey PRIMARY KEY (id);
alter table public.regras_documentos add constraint regras_documentos_pkey PRIMARY KEY (id);
alter table public.regras_faq add constraint regras_faq_pkey PRIMARY KEY (id);
alter table public.regras_mandatos add constraint regras_mandatos_pkey PRIMARY KEY (id);
alter table public.regras_mapa_condgpt add constraint regras_mapa_condgpt_pkey PRIMARY KEY (slug);
alter table public.regras_notificacoes add constraint regras_notificacoes_pkey PRIMARY KEY (id);
alter table public.regras_trechos add constraint regras_trechos_pkey PRIMARY KEY (id);
alter table public.sync_status add constraint sync_status_pkey PRIMARY KEY (id);
alter table public.trabalhos_salvos add constraint trabalhos_salvos_pkey PRIMARY KEY (id);
alter table public.transcricoes add constraint transcricoes_pkey PRIMARY KEY (id);
alter table public.unidades add constraint unidades_pkey PRIMARY KEY (id_unidade_uni);
alter table public.alertas add constraint alertas_id_superlogica_chave_key UNIQUE (id_superlogica, chave);
alter table public.certidoes_condominio add constraint certidoes_condominio_id_superlogica_tipo_key UNIQUE (id_superlogica, tipo);
alter table public.condominios add constraint condominios_id_superlogica_key UNIQUE (id_superlogica);
alter table public.previsoes_orcamentarias add constraint uq_previsao_rascunho_por_cond_ano UNIQUE (condominio_id, ano_referencia, status) DEFERRABLE INITIALLY DEFERRED;
alter table public.alertas add constraint alertas_status_check CHECK ((status = ANY (ARRAY['novo'::text, 'visto'::text, 'resolvido'::text])));
alter table public.certidoes_condominio add constraint certidoes_condominio_tipo_check CHECK ((tipo = ANY (ARRAY['federal'::text, 'estadual'::text, 'municipal'::text, 'trabalhista'::text, 'fgts'::text, 'falencia'::text])));
alter table public.fin_anexo_leitura add constraint fin_anexo_leitura_leitura_check CHECK ((leitura = ANY (ARRAY['texto'::text, 'interna'::text, 'escaneado'::text, 'nao_pdf'::text, 'falha'::text])));
alter table public.fin_avisos add constraint fin_avisos_chave_check CHECK ((chave ~ '^(geral|sem_carteira|carteira:[0-9]{1,9})$'::text));
alter table public.fin_avisos add constraint fin_avisos_origem_check CHECK ((origem = ANY (ARRAY['agendado'::text, 'sob_demanda'::text, 'teste'::text])));
alter table public.fin_avisos_execucoes add constraint fin_avisos_execucoes_origem_check CHECK ((origem = ANY (ARRAY['agendado'::text, 'sob_demanda'::text, 'teste'::text])));
alter table public.fin_avisos_execucoes add constraint fin_avisos_execucoes_status_check CHECK ((status = ANY (ARRAY['andamento'::text, 'ok'::text, 'erro'::text])));
alter table public.fin_entrada add constraint fin_entrada_leitura_check CHECK ((leitura = ANY (ARRAY['texto'::text, 'interna'::text, 'texto+interna'::text, 'nenhuma'::text])));
alter table public.fin_entrada add constraint fin_entrada_status_check CHECK ((status = ANY (ARRAY['rascunho'::text, 'lancado'::text, 'descartado'::text, 'incerto'::text])));
alter table public.fin_fechamento_marca add constraint fin_fechamento_marca_competencia_check CHECK ((competencia ~ '^[0-9]{4}-[0-9]{2}$'::text));
alter table public.fin_fechamento_marca add constraint fin_fechamento_marca_item_check CHECK ((item = ANY (ARRAY['pre_balancete'::text, 'boletos'::text, 'anexos'::text])));
alter table public.fin_fechamento_status add constraint fin_fechamento_status_competencia_check CHECK ((competencia ~ '^[0-9]{4}-[0-9]{2}$'::text));
alter table public.fin_sync_log add constraint fin_sync_log_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'erro'::text, 'inicio'::text, 'fim'::text])));
alter table public.fin_usuarios_superlogica add constraint fin_usuarios_superlogica_carteira_check CHECK (((carteira IS NULL) OR (carteira > 0)));
alter table public.fin_usuarios_superlogica add constraint fin_usuarios_superlogica_id_usuario_sl_check CHECK ((id_usuario_sl ~ '^[0-9]{1,12}$'::text));
alter table public.previsoes_orcamentarias add constraint previsoes_orcamentarias_ano_referencia_check CHECK (((ano_referencia >= 2000) AND (ano_referencia <= 2100)));
alter table public.previsoes_orcamentarias add constraint previsoes_orcamentarias_status_check CHECK ((status = ANY (ARRAY['rascunho'::text, 'publicado'::text, 'arquivado'::text])));
alter table public.regras_documentos add constraint regras_documentos_origem_check CHECK ((origem = ANY (ARRAY['condgpt'::text, 'upload'::text, 'ata_hub'::text])));
alter table public.regras_documentos add constraint regras_documentos_tipo_check CHECK ((tipo = ANY (ARRAY['convencao'::text, 'regimento'::text, 'ata'::text, 'regulamento'::text, 'outro'::text])));
alter table public.regras_notificacoes add constraint regras_notificacoes_origem_check CHECK ((origem = ANY (ARRAY['hub'::text, 'condgpt'::text])));
alter table public.regras_notificacoes add constraint regras_notificacoes_status_check CHECK ((status = ANY (ARRAY['rascunho'::text, 'registrada'::text, 'regularizada'::text, 'convertida_multa'::text, 'cancelada'::text])));
alter table public.regras_notificacoes add constraint regras_notificacoes_tipo_check CHECK ((tipo = ANY (ARRAY['advertencia'::text, 'multa'::text])));
alter table public.trabalhos_salvos add constraint trabalhos_salvos_tipo_check CHECK ((tipo = ANY (ARRAY['ata'::text, 'prestacao'::text, 'previsao'::text, 'unidades'::text])));
alter table public.alertas add constraint alertas_atualizado_por_fkey FOREIGN KEY (atualizado_por) REFERENCES auth.users(id);
alter table public.alertas_config add constraint alertas_config_atualizado_por_fkey FOREIGN KEY (atualizado_por) REFERENCES auth.users(id);
alter table public.condominio_contexto add constraint condominio_contexto_condominio_id_fkey FOREIGN KEY (condominio_id) REFERENCES public.condominios(id) ON DELETE CASCADE;
alter table public.config_geral add constraint config_geral_atualizado_por_fkey FOREIGN KEY (atualizado_por) REFERENCES auth.users(id);
alter table public.demandas add constraint demandas_condominio_id_fkey FOREIGN KEY (condominio_id) REFERENCES public.condominios(id) ON DELETE CASCADE;
alter table public.fin_usuarios_superlogica add constraint fin_usuarios_superlogica_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
alter table public.historico add constraint historico_condominio_id_fkey FOREIGN KEY (condominio_id) REFERENCES public.condominios(id) ON DELETE CASCADE;
alter table public.laudos add constraint laudos_condominio_id_fkey FOREIGN KEY (condominio_id) REFERENCES public.condominios(id) ON DELETE CASCADE;
alter table public.pessoas add constraint pessoas_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id_unidade_uni) ON DELETE CASCADE;
alter table public.previsoes_geracoes add constraint previsoes_geracoes_gerado_por_fkey FOREIGN KEY (gerado_por) REFERENCES auth.users(id);
alter table public.previsoes_geracoes add constraint previsoes_geracoes_previsao_id_fkey FOREIGN KEY (previsao_id) REFERENCES public.previsoes_orcamentarias(id) ON DELETE CASCADE;
alter table public.previsoes_orcamentarias add constraint previsoes_orcamentarias_condominio_id_fkey FOREIGN KEY (condominio_id) REFERENCES public.condominios(id) ON DELETE CASCADE;
alter table public.previsoes_orcamentarias add constraint previsoes_orcamentarias_criado_por_fkey FOREIGN KEY (criado_por) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.regras_mandatos add constraint regras_mandatos_documento_id_fkey FOREIGN KEY (documento_id) REFERENCES public.regras_documentos(id) ON DELETE SET NULL;
alter table public.regras_trechos add constraint regras_trechos_documento_id_fkey FOREIGN KEY (documento_id) REFERENCES public.regras_documentos(id) ON DELETE CASCADE;
alter table public.unidades add constraint unidades_condominio_id_fkey FOREIGN KEY (condominio_id) REFERENCES public.condominios(id) ON DELETE CASCADE;

-- 6. Índices.
CREATE INDEX alertas_cond_status_idx ON public.alertas USING btree (id_superlogica, status);
CREATE INDEX api_uso_criado_em_idx ON public.api_uso USING btree (criado_em);
CREATE INDEX api_uso_funcao_idx ON public.api_uso USING btree (funcao, criado_em);
CREATE INDEX auditoria_criado_em_idx ON public.auditoria USING btree (criado_em DESC);
CREATE INDEX auditoria_suspeito_idx ON public.auditoria USING btree (criado_em DESC) WHERE suspeito;
CREATE INDEX auditoria_user_idx ON public.auditoria USING btree (user_id, criado_em DESC);
CREATE INDEX certidoes_condominio_validade_idx ON public.certidoes_condominio USING btree (validade);
CREATE INDEX condominios_mockup_idx ON public.condominios USING btree (mockup);
CREATE INDEX demandas_condominio_idx ON public.demandas USING btree (condominio_id);
CREATE INDEX fin_anexo_leitura_cond_idx ON public.fin_anexo_leitura USING btree (id_superlogica);
CREATE INDEX fin_anexos_desp_idx ON public.fin_anexos USING btree (id_despesa);
CREATE INDEX fin_anexos_hash_idx ON public.fin_anexos USING btree (hash) WHERE (hash IS NOT NULL);
CREATE INDEX fin_aud_arq_idx ON public.fin_auditoria_sl USING btree (id_arquivo) WHERE (id_arquivo IS NOT NULL);
CREATE INDEX fin_aud_data_idx ON public.fin_auditoria_sl USING btree (dt_data);
CREATE INDEX fin_aud_desp_idx ON public.fin_auditoria_sl USING btree (id_despesa) WHERE (id_despesa IS NOT NULL);
CREATE INDEX fin_aud_parc_idx ON public.fin_auditoria_sl USING btree (id_parcela) WHERE (id_parcela IS NOT NULL);
CREATE INDEX fin_aud_usu_data_idx ON public.fin_auditoria_sl USING btree (id_usuario, dt_data);
CREATE INDEX fin_avisos_dia_idx ON public.fin_avisos USING btree (dia DESC);
CREATE INDEX fin_avisos_exec_dia_idx ON public.fin_avisos_execucoes USING btree (iniciado_em DESC);
CREATE INDEX fin_cobr_cond_venc_idx ON public.fin_cobrancas USING btree (id_condominio, dt_vencimento);
CREATE INDEX fin_cobr_unidade_idx ON public.fin_cobrancas USING btree (id_unidade, dt_vencimento);
CREATE INDEX fin_contas_cond_idx ON public.fin_contas USING btree (id_condominio);
CREATE INDEX fin_despesas_cond_idx ON public.fin_despesas USING btree (id_condominio);
CREATE INDEX fin_despesas_forn_idx ON public.fin_despesas USING btree (id_fornecedor);
CREATE INDEX fin_entrada_cond_idx ON public.fin_entrada USING btree (id_superlogica, status);
CREATE INDEX fin_entrada_linha_idx ON public.fin_entrada USING btree (((dados ->> 'linha'::text))) WHERE (status <> 'descartado'::text);
CREATE INDEX fin_entrada_status_idx ON public.fin_entrada USING btree (status, criado_em DESC);
CREATE INDEX fin_mov_cond_data_idx ON public.fin_movimentos USING btree (id_condominio, dt_data);
CREATE INDEX fin_mov_conta_data_idx ON public.fin_movimentos USING btree (id_conta, dt_data);
CREATE INDEX fin_mov_parcela_idx ON public.fin_movimentos USING btree (id_parcela) WHERE (id_parcela IS NOT NULL);
CREATE INDEX fin_parcelas_barras_idx ON public.fin_parcelas USING btree (codigo_barras) WHERE (codigo_barras IS NOT NULL);
CREATE INDEX fin_parcelas_cond_liq_idx ON public.fin_parcelas USING btree (id_condominio, dt_liquidacao);
CREATE INDEX fin_parcelas_cond_venc_idx ON public.fin_parcelas USING btree (id_condominio, dt_vencimento);
CREATE INDEX fin_parcelas_desp_idx ON public.fin_parcelas USING btree (id_despesa);
CREATE INDEX fin_sync_exec_idx ON public.fin_sync_log USING btree (execucao);
CREATE INDEX fin_sync_tipo_idx ON public.fin_sync_log USING btree (tipo, janela_inicio, status);
CREATE INDEX fin_usuarios_sl_profile_idx ON public.fin_usuarios_superlogica USING btree (profile_id);
CREATE INDEX geracoes_hash_idx ON public.previsoes_geracoes USING btree (payload_hash);
CREATE INDEX geracoes_previsao_em_idx ON public.previsoes_geracoes USING btree (previsao_id, gerado_em DESC);
CREATE INDEX historico_condominio_idx ON public.historico USING btree (condominio_id);
CREATE INDEX laudos_condominio_idx ON public.laudos USING btree (condominio_id);
CREATE INDEX pessoas_unidade_id_idx ON public.pessoas USING btree (unidade_id);
CREATE INDEX previsoes_cond_ano_status_idx ON public.previsoes_orcamentarias USING btree (condominio_id, ano_referencia, status);
CREATE INDEX previsoes_criado_por_idx ON public.previsoes_orcamentarias USING btree (criado_por);
CREATE INDEX previsoes_hash_idx ON public.previsoes_orcamentarias USING btree (payload_hash);
CREATE INDEX regras_conf_ata_cond_idx ON public.regras_conferencias_ata USING btree (id_superlogica, criado_em DESC);
CREATE INDEX regras_doc_cond_idx ON public.regras_documentos USING btree (id_superlogica, tipo, vigente);
CREATE INDEX regras_doc_slug_idx ON public.regras_documentos USING btree (condgpt_slug);
CREATE INDEX regras_faq_cond_idx ON public.regras_faq USING btree (id_superlogica);
CREATE INDEX regras_mandatos_cond_idx ON public.regras_mandatos USING btree (id_superlogica, fim);
CREATE INDEX regras_notif_cond_idx ON public.regras_notificacoes USING btree (id_superlogica, criado_em DESC);
CREATE INDEX regras_notif_unid_idx ON public.regras_notificacoes USING btree (id_superlogica, id_unidade, criado_em DESC);
CREATE INDEX regras_notif_unidtxt_idx ON public.regras_notificacoes USING btree (id_superlogica, unidade);
CREATE INDEX regras_trechos_cond_idx ON public.regras_trechos USING btree (id_superlogica);
CREATE INDEX regras_trechos_doc_idx ON public.regras_trechos USING btree (documento_id, ordem);
CREATE INDEX regras_trechos_tsv_idx ON public.regras_trechos USING gin (tsv);
CREATE INDEX sync_status_rodado_em_idx ON public.sync_status USING btree (rodado_em DESC);
CREATE INDEX trabalhos_salvos_expira_idx ON public.trabalhos_salvos USING btree (expira_em);
CREATE INDEX trabalhos_salvos_user_idx ON public.trabalhos_salvos USING btree (user_id, atualizado_em DESC);
CREATE INDEX transcricoes_criado_em_idx ON public.transcricoes USING btree (criado_em DESC);
CREATE INDEX transcricoes_user_idx ON public.transcricoes USING btree (user_id, criado_em DESC);
CREATE INDEX unidades_condominio_id_idx ON public.unidades USING btree (condominio_id);
CREATE UNIQUE INDEX fin_avisos_exec_agendado_uk ON public.fin_avisos_execucoes USING btree (dia) WHERE (origem = 'agendado'::text);
CREATE UNIQUE INDEX fin_entrada_hash_uk ON public.fin_entrada USING btree (hash_sha256) WHERE (status <> 'descartado'::text);
CREATE UNIQUE INDEX regras_doc_hash_uidx ON public.regras_documentos USING btree (id_superlogica, tipo, hash_texto) WHERE (hash_texto IS NOT NULL);
CREATE UNIQUE INDEX regras_notif_origem_uidx ON public.regras_notificacoes USING btree (origem, origem_id) WHERE (origem_id IS NOT NULL);
CREATE UNIQUE INDEX unidades_natural_key_uidx ON public.unidades USING btree (condominio_id, st_unidade_uni, st_bloco_uni) NULLS NOT DISTINCT;

-- 7. Funções (iguais ao teste; seed_dev é só do teste e não sobe).
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  BEGIN
    INSERT INTO public.profiles (id, email, nome, role)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'nome', NEW.email),
      COALESCE(NEW.raw_app_meta_data->>'role', 'OPERACIONAL')
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
  END;
  $function$;

CREATE OR REPLACE FUNCTION public.set_gestor_permissoes_totais()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
  DECLARE
    base  jsonb;
    atual jsonb;
  BEGIN
    IF NEW.role = 'GESTOR' THEN
      NEW.pode_convidar = true;
      base := '{
        "dashboard":          {"visivel": true, "acoes": ["ver"]},
        "importar_despesas":  {"visivel": true, "acoes": ["ver", "importar"]},
        "importar_unidades":  {"visivel": true, "acoes": ["ver", "importar", "normalizar"]},
        "boletos":            {"visivel": true, "acoes": ["ver"]},
        "conciliacao":        {"visivel": true, "acoes": ["ver"]},
        "notas_fiscais":      {"visivel": true, "acoes": ["ver"]},
        "prestacao_contas":   {"visivel": true, "acoes": ["ver", "gerar", "ajustar_estrutura"]},
        "atas":               {"visivel": true, "acoes": ["ver", "gerar", "edital"]},
        "leitura_consumo":    {"visivel": true, "acoes": ["ver", "ler"]},
        "tarefas":            {"visivel": true, "acoes": ["ver"]},
        "configuracoes":      {"visivel": true, "acoes": ["ver", "editar", "convidar", "todas_carteiras"]},
        "ficha_condominio":   {"visivel": true, "acoes": ["ver"]},
        "cobranca":           {"visivel": true, "acoes": ["ver", "segunda_via"]},
        "comparativo":        {"visivel": true, "acoes": ["ver"]}
      }'::jsonb;
      atual := CASE WHEN jsonb_typeof(NEW.permissoes) = 'object' THEN NEW.permissoes ELSE '{}'::jsonb END;
      NEW.permissoes = (
        SELECT COALESCE(jsonb_object_agg(k,
          CASE
            WHEN b IS NULL THEN n
            WHEN n IS NULL OR jsonb_typeof(n) <> 'object' THEN b
            ELSE n || jsonb_build_object('visivel', true, 'acoes', (
              SELECT COALESCE(to_jsonb(array_agg(DISTINCT x ORDER BY x)), '[]'::jsonb)
              FROM jsonb_array_elements_text(
                (CASE WHEN jsonb_typeof(b->'acoes') = 'array' THEN b->'acoes' ELSE '[]'::jsonb END) ||
                (CASE WHEN jsonb_typeof(n->'acoes') = 'array' THEN n->'acoes' ELSE '[]'::jsonb END)) AS t(x)))
          END), '{}'::jsonb)
        FROM jsonb_each(base) AS bb(k, b)
        FULL JOIN jsonb_each(atual) AS nn(k, n) USING (k));
    END IF;
    NEW.atualizado_em = now();
    RETURN NEW;
  END;
  $function$;

CREATE OR REPLACE FUNCTION public.sync_role_to_metadata()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  BEGIN
    UPDATE auth.users
    SET raw_app_meta_data =
      COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', NEW.role)
    WHERE id = NEW.id;
    RETURN NEW;
  END;
  $function$;

CREATE OR REPLACE FUNCTION public.set_previsao_atualizado_em()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.api_uso_resumo(de date, ate date)
 RETURNS TABLE(dia date, funcao text, chamadas integer, custo_usd numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select (u.criado_em at time zone 'America/Sao_Paulo')::date, u.funcao, count(*)::integer, coalesce(sum(u.custo_usd), 0)::numeric(14,6)
  from public.api_uso u
  where u.criado_em >= (de::timestamp at time zone 'America/Sao_Paulo')
    and u.criado_em < ((ate + 1)::timestamp at time zone 'America/Sao_Paulo')
  group by 1, 2
  order by 1, 2;
$function$;

CREATE OR REPLACE FUNCTION public.regras_buscar(p_id integer, p_consulta text, p_tipos text[] DEFAULT NULL::text[], p_limite integer DEFAULT 12, p_so_vigentes boolean DEFAULT true)
 RETURNS TABLE(trecho_id bigint, documento_id bigint, id_superlogica integer, tipo text, titulo_documento text, data_documento date, vigente boolean, rotulo text, titulo text, texto text, pagina integer, ordem integer, rank real)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
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
end $function$;

-- 8. Visão, gatilhos.
create or replace view public.api_uso_dia as  SELECT ((criado_em AT TIME ZONE 'America/Sao_Paulo'::text))::date AS dia,
    funcao,
    (count(*))::integer AS chamadas,
    sum(entrada) AS entrada,
    sum(saida) AS saida,
    sum(cache_lido) AS cache_lido,
    sum(cache_criado) AS cache_criado,
    (COALESCE(sum(custo_usd), (0)::numeric))::numeric(14,6) AS custo_usd
   FROM api_uso
  GROUP BY (((criado_em AT TIME ZONE 'America/Sao_Paulo'::text))::date), funcao;
CREATE TRIGGER trigger_previsao_atualizado_em BEFORE UPDATE ON public.previsoes_orcamentarias FOR EACH ROW EXECUTE FUNCTION set_previsao_atualizado_em();

-- 9. Segurança das linhas (RLS) e políticas (iguais ao teste).
alter table public.alertas enable row level security;
alter table public.alertas_config enable row level security;
alter table public.alertas_preferencias enable row level security;
alter table public.api_uso enable row level security;
alter table public.auditoria enable row level security;
alter table public.certidoes_condominio enable row level security;
alter table public.condominio_contexto enable row level security;
alter table public.condominios enable row level security;
alter table public.config_geral enable row level security;
alter table public.demandas enable row level security;
alter table public.fin_anexo_leitura enable row level security;
alter table public.fin_anexos enable row level security;
alter table public.fin_auditoria_sl enable row level security;
alter table public.fin_avisos enable row level security;
alter table public.fin_avisos_execucoes enable row level security;
alter table public.fin_cobrancas enable row level security;
alter table public.fin_condominios enable row level security;
alter table public.fin_contas enable row level security;
alter table public.fin_despesas enable row level security;
alter table public.fin_entrada enable row level security;
alter table public.fin_fechamento_marca enable row level security;
alter table public.fin_fechamento_status enable row level security;
alter table public.fin_movimentos enable row level security;
alter table public.fin_parcelas enable row level security;
alter table public.fin_sync_log enable row level security;
alter table public.fin_usuarios_superlogica enable row level security;
alter table public.historico enable row level security;
alter table public.hub_progresso enable row level security;
alter table public.laudos enable row level security;
alter table public.pessoas enable row level security;
alter table public.previsoes_geracoes enable row level security;
alter table public.previsoes_orcamentarias enable row level security;
alter table public.profiles enable row level security;
alter table public.regras_conferencias_ata enable row level security;
alter table public.regras_documentos enable row level security;
alter table public.regras_faq enable row level security;
alter table public.regras_mandatos enable row level security;
alter table public.regras_mapa_condgpt enable row level security;
alter table public.regras_notificacoes enable row level security;
alter table public.regras_trechos enable row level security;
alter table public.sync_status enable row level security;
alter table public.trabalhos_salvos enable row level security;
alter table public.transcricoes enable row level security;
alter table public.unidades enable row level security;
create policy authenticated_select on public.condominio_contexto as PERMISSIVE for SELECT to authenticated using (true);
create policy authenticated_select on public.condominios as PERMISSIVE for SELECT to authenticated using (true);
create policy authenticated_select on public.pessoas as PERMISSIVE for SELECT to authenticated using (true);
create policy authenticated_select on public.sync_status as PERMISSIVE for SELECT to authenticated using (true);
create policy authenticated_select on public.unidades as PERMISSIVE for SELECT to authenticated using (true);
create policy geracao_delete on public.previsoes_geracoes as PERMISSIVE for DELETE to authenticated using ((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'GESTOR'::text));
create policy geracao_insert on public.previsoes_geracoes as PERMISSIVE for INSERT to authenticated with check ((gerado_por = auth.uid()));
create policy geracao_select on public.previsoes_geracoes as PERMISSIVE for SELECT to authenticated using (((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = ANY (ARRAY['GESTOR'::text, 'GERENTE'::text])) OR (gerado_por = auth.uid())));
create policy gestor_escreve on public.condominio_contexto as PERMISSIVE for ALL to authenticated using ((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'GESTOR'::text)) with check ((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'GESTOR'::text));
create policy gestor_escreve on public.pessoas as PERMISSIVE for ALL to authenticated using ((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'GESTOR'::text)) with check ((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'GESTOR'::text));
create policy gestor_escreve on public.unidades as PERMISSIVE for ALL to authenticated using ((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'GESTOR'::text)) with check ((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'GESTOR'::text));
create policy previsao_delete on public.previsoes_orcamentarias as PERMISSIVE for DELETE to authenticated using ((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'GESTOR'::text));
create policy previsao_insert on public.previsoes_orcamentarias as PERMISSIVE for INSERT to authenticated with check ((criado_por = auth.uid()));
create policy previsao_select on public.previsoes_orcamentarias as PERMISSIVE for SELECT to authenticated using (((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = ANY (ARRAY['GESTOR'::text, 'GERENTE'::text])) OR (criado_por = auth.uid())));
create policy previsao_update on public.previsoes_orcamentarias as PERMISSIVE for UPDATE to authenticated using (((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = ANY (ARRAY['GESTOR'::text, 'GERENTE'::text])) OR (criado_por = auth.uid()))) with check (((COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = ANY (ARRAY['GESTOR'::text, 'GERENTE'::text])) OR (criado_por = auth.uid())));

-- 10. Acessos: só o servidor lê e grava as tabelas novas (sem acesso direto do navegador).
revoke all on public.alertas_preferencias, public.api_uso, public.certidoes_condominio, public.fin_anexo_leitura, public.fin_anexos,
  public.fin_auditoria_sl, public.fin_avisos, public.fin_avisos_execucoes, public.fin_cobrancas, public.fin_condominios, public.fin_contas,
  public.fin_despesas, public.fin_entrada, public.fin_fechamento_marca, public.fin_fechamento_status, public.fin_movimentos, public.fin_parcelas,
  public.fin_sync_log, public.fin_usuarios_superlogica, public.regras_conferencias_ata, public.regras_documentos, public.regras_faq,
  public.regras_mandatos, public.regras_mapa_condgpt, public.regras_notificacoes, public.regras_trechos, public.trabalhos_salvos,
  public.api_uso_dia from anon, authenticated;
revoke all on sequence public.fin_sync_log_id_seq, public.api_uso_id_seq from anon, authenticated;
grant select on public.api_uso_dia to service_role;
grant select, insert on public.api_uso to service_role;
revoke all on function public.api_uso_resumo(date, date) from public, anon, authenticated;
grant execute on function public.api_uso_resumo(date, date) to service_role;
revoke execute on function public.regras_buscar(integer, text, text[], integer, boolean) from public, anon, authenticated;
grant execute on function public.regras_buscar(integer, text, text[], integer, boolean) to service_role;

-- 11. Armazenamento (buckets privados) e a política de leitura da previsão.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('certidoes','certidoes',false,10485760,'{application/pdf}') on conflict (id) do nothing;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('previsao-arquivos','previsao-arquivos',false,52428800,'{application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf}') on conflict (id) do nothing;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('regras','regras',false,52428800,'{application/pdf}') on conflict (id) do nothing;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('trabalhos','trabalhos',false,41943040,'{application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet}') on conflict (id) do nothing;
drop policy if exists storage_geracao_select on storage.objects;
create policy storage_geracao_select on storage.objects as PERMISSIVE for SELECT to authenticated using (((bucket_id = 'previsao-arquivos'::text) AND (COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = ANY (ARRAY['GESTOR'::text, 'GERENTE'::text]))));

commit;
