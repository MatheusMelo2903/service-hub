-- Migration 014: cópia do financeiro do Superlógica (T24, conector do auditor financeiro).
-- Data: 2026-10-21
-- Aplicada SÓ no Supabase de TESTE (ledgyprytkuvgtbunsck). PROD pendente autorização explícita.
-- IDEMPOTENTE. Não apaga nada.
--
-- Quem lê e grava é só o servidor (service_role): o módulo financeiro/ copia do Superlógica
-- (somente GET) para estas tabelas. RLS ligado e SEM policy: o navegador nunca acessa direto.
-- Dados sensíveis ficam fora de propósito: tokens, segredos, agência e número das contas,
-- CPF de fornecedor pessoa física e nome do morador nas cobranças não são guardados.
-- Ficam fora os cadastros que não são condomínio: 143, 144, 145, 160 e 162.

CREATE TABLE IF NOT EXISTS public.fin_condominios (
  id_condominio         INT         PRIMARY KEY,
  nome                  TEXT,
  fantasia              TEXT,
  ultima_sincronizacao  TIMESTAMPTZ,
  sincronizado_de       DATE,
  sincronizado_ate      DATE,
  sync_tipos            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fin_contas (
  id_conta          INT         PRIMARY KEY,
  id_condominio     INT         NOT NULL,
  descricao         TEXT,
  principal         BOOLEAN     NOT NULL DEFAULT false,
  banco             TEXT,
  id_banco          INT,
  id_tipo           INT,
  saldo             NUMERIC(16,2),
  dt_abertura       DATE,
  dt_fechamento     DATE,
  dt_bloqueio       DATE,
  visto_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_contas_cond_idx ON public.fin_contas(id_condominio);

CREATE TABLE IF NOT EXISTS public.fin_despesas (
  id_despesa        BIGINT      PRIMARY KEY,
  id_condominio     INT         NOT NULL,
  id_fornecedor     BIGINT,
  fornecedor        TEXT,
  fornecedor_cnpj   TEXT,
  documento         TEXT,
  id_tipo_doc       INT,
  serie_nota        TEXT,
  dt_despesa        DATE,
  dt_geracao        DATE,
  recorrente        BOOLEAN,
  id_conta          INT,
  apropriacao       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  visto_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_despesas_cond_idx ON public.fin_despesas(id_condominio);
CREATE INDEX IF NOT EXISTS fin_despesas_forn_idx ON public.fin_despesas(id_fornecedor);

CREATE TABLE IF NOT EXISTS public.fin_parcelas (
  id_parcela          BIGINT      PRIMARY KEY,
  id_despesa          BIGINT      NOT NULL,
  id_condominio       INT         NOT NULL,
  liquidada           BOOLEAN     NOT NULL DEFAULT false,
  dt_vencimento       DATE,
  dt_liquidacao       DATE,
  dt_previsao_credito DATE,
  valor               NUMERIC(16,2),
  valor_bruto         NUMERIC(16,2),
  juros               NUMERIC(16,2),
  multa               NUMERIC(16,2),
  desconto            NUMERIC(16,2),
  codigo_barras       TEXT,
  id_forma_pag        INT,
  remessa_status      TEXT,
  complemento         TEXT,
  num_anexos          INT         NOT NULL DEFAULT 0,
  documentos_pendentes JSONB      NOT NULL DEFAULT '[]'::jsonb,
  visto_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_parcelas_cond_venc_idx ON public.fin_parcelas(id_condominio, dt_vencimento);
CREATE INDEX IF NOT EXISTS fin_parcelas_cond_liq_idx ON public.fin_parcelas(id_condominio, dt_liquidacao);
CREATE INDEX IF NOT EXISTS fin_parcelas_desp_idx ON public.fin_parcelas(id_despesa);
CREATE INDEX IF NOT EXISTS fin_parcelas_barras_idx ON public.fin_parcelas(codigo_barras) WHERE codigo_barras IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.fin_anexos (
  id_arquivo        BIGINT      NOT NULL,
  id_despesa        BIGINT      NOT NULL,
  id_condominio     INT         NOT NULL,
  etiqueta          TEXT,
  nome              TEXT,
  extensao          TEXT,
  tamanho           BIGINT,
  hash              TEXT,
  dt_envio          DATE,
  id_responsavel    BIGINT,
  visto_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id_arquivo, id_despesa)
);
CREATE INDEX IF NOT EXISTS fin_anexos_desp_idx ON public.fin_anexos(id_despesa);
CREATE INDEX IF NOT EXISTS fin_anexos_hash_idx ON public.fin_anexos(hash) WHERE hash IS NOT NULL;

-- Movimento do caixa. chave = "m:<id_contabanco_mov>" ou, quando o Superlógica não manda o id
-- (linhas agregadas de receita), "h:<resumo>#<ordem>".
CREATE TABLE IF NOT EXISTS public.fin_movimentos (
  chave             TEXT        PRIMARY KEY,
  id_movimento      BIGINT,
  id_conta          INT         NOT NULL,
  id_condominio     INT,
  dt_data           DATE        NOT NULL,
  dc                TEXT,
  valor             NUMERIC(16,2),
  descricao         TEXT,
  origem            INT,
  documento         TEXT,
  id_despesa        BIGINT,
  id_parcela        BIGINT,
  id_forma_pag      INT,
  num_anexos        INT,
  fitid             TEXT,
  remessa_status    TEXT,
  visto_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_mov_conta_data_idx ON public.fin_movimentos(id_conta, dt_data);
CREATE INDEX IF NOT EXISTS fin_mov_cond_data_idx ON public.fin_movimentos(id_condominio, dt_data);
CREATE INDEX IF NOT EXISTS fin_mov_parcela_idx ON public.fin_movimentos(id_parcela) WHERE id_parcela IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.fin_cobrancas (
  id_recebimento    BIGINT      PRIMARY KEY,
  id_condominio     INT         NOT NULL,
  id_unidade        BIGINT,
  unidade           TEXT,
  bloco             TEXT,
  id_conta          INT,
  status            TEXT,
  dt_vencimento     DATE,
  dt_competencia    DATE,
  dt_geracao        DATE,
  dt_liquidacao     DATE,
  vl_emitido        NUMERIC(16,2),
  vl_total          NUMERIC(16,2),
  remessa_status    TEXT,
  id_lote           TEXT,
  parcelamento      TEXT,
  visto_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_cobr_cond_venc_idx ON public.fin_cobrancas(id_condominio, dt_vencimento);
CREATE INDEX IF NOT EXISTS fin_cobr_unidade_idx ON public.fin_cobrancas(id_unidade, dt_vencimento);

-- Auditoria do Superlógica: só as linhas do financeiro (despesa, parcela, arquivo, apropriação,
-- extrato, fornecedor e conta bancária). id_despesa, id_parcela e id_arquivo saem do texto.
CREATE TABLE IF NOT EXISTS public.fin_auditoria_sl (
  id_auditoria      BIGINT      PRIMARY KEY,
  dt_data           TIMESTAMPTZ NOT NULL,
  id_usuario        INT,
  usuario           TEXT,
  sistema           BOOLEAN     NOT NULL DEFAULT false,
  id_condominio     INT,
  condominio_texto  TEXT,
  texto             TEXT,
  id_despesa        BIGINT,
  id_parcela        BIGINT,
  id_arquivo        BIGINT,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_aud_data_idx ON public.fin_auditoria_sl(dt_data);
CREATE INDEX IF NOT EXISTS fin_aud_desp_idx ON public.fin_auditoria_sl(id_despesa) WHERE id_despesa IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_aud_parc_idx ON public.fin_auditoria_sl(id_parcela) WHERE id_parcela IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_aud_arq_idx ON public.fin_auditoria_sl(id_arquivo) WHERE id_arquivo IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_aud_usu_data_idx ON public.fin_auditoria_sl(id_usuario, dt_data);

CREATE TABLE IF NOT EXISTS public.fin_sync_log (
  id                BIGSERIAL   PRIMARY KEY,
  execucao          UUID        NOT NULL,
  origem            TEXT        NOT NULL DEFAULT 'script',
  usuario           UUID,
  tipo              TEXT        NOT NULL,
  janela_inicio     DATE,
  janela_fim        DATE,
  id_condominio     INT,
  status            TEXT        NOT NULL CHECK (status IN ('ok', 'erro', 'inicio', 'fim')),
  itens             INT,
  gravados          INT,
  duracao_ms        INT,
  erro              TEXT,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_sync_exec_idx ON public.fin_sync_log(execucao);
CREATE INDEX IF NOT EXISTS fin_sync_tipo_idx ON public.fin_sync_log(tipo, janela_inicio, status);

ALTER TABLE public.fin_condominios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_contas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_despesas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_parcelas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_anexos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_movimentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_cobrancas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_auditoria_sl ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_sync_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.fin_condominios, public.fin_contas, public.fin_despesas, public.fin_parcelas,
  public.fin_anexos, public.fin_movimentos, public.fin_cobrancas, public.fin_auditoria_sl,
  public.fin_sync_log FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.fin_sync_log_id_seq FROM anon, authenticated;
