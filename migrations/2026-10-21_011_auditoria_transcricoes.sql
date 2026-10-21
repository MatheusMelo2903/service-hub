-- T16: auditoria, transcrições guardadas, bloqueio de usuário e ações do dono.
-- Acesso só pelo servidor (service_role), como as outras tabelas: RLS ligado e sem policy.
-- Aplicar no Supabase de teste agora; produção só junto com a subida autorizada.

CREATE TABLE IF NOT EXISTS public.auditoria (
  id bigserial PRIMARY KEY,
  criado_em timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  email text,
  papel text,
  acao text NOT NULL,
  rota text,
  metodo text,
  status integer,
  id_superlogica integer,
  ip text,
  navegador text,
  detalhe jsonb,
  suspeito boolean NOT NULL DEFAULT false,
  motivo text
);
CREATE INDEX IF NOT EXISTS auditoria_criado_em_idx ON public.auditoria (criado_em DESC);
CREATE INDEX IF NOT EXISTS auditoria_user_idx ON public.auditoria (user_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS auditoria_suspeito_idx ON public.auditoria (criado_em DESC) WHERE suspeito;
ALTER TABLE public.auditoria ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.transcricoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_em timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  email text,
  id_superlogica integer,
  condominio_nome text,
  origem text NOT NULL,            -- audio, arquivo_txt, colada, editada
  arquivo_nome text,
  servico_id text,                 -- código no serviço de transcrição (nunca vai ao navegador)
  status text NOT NULL,            -- processando, pronta, erro
  texto text,
  caracteres integer,
  duracao_seg numeric,
  usada_em_ata timestamptz,
  apagada_em timestamptz,
  apagada_por uuid
);
CREATE INDEX IF NOT EXISTS transcricoes_criado_em_idx ON public.transcricoes (criado_em DESC);
CREATE INDEX IF NOT EXISTS transcricoes_user_idx ON public.transcricoes (user_id, criado_em DESC);
ALTER TABLE public.transcricoes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS bloqueado boolean NOT NULL DEFAULT false;

-- Dono do sistema (Matheus): vê toda a auditoria, audita e transcreve livre.
UPDATE public.profiles
SET permissoes = jsonb_set(
      jsonb_set(permissoes, '{configuracoes,acoes}',
        (SELECT to_jsonb(array_agg(DISTINCT x)) FROM jsonb_array_elements_text(
          COALESCE(permissoes->'configuracoes'->'acoes', '[]'::jsonb) || '["ver_auditoria","auditoria_total"]'::jsonb) AS t(x))),
      '{atas,acoes}',
        (SELECT to_jsonb(array_agg(DISTINCT x)) FROM jsonb_array_elements_text(
          COALESCE(permissoes->'atas'->'acoes', '[]'::jsonb) || '["transcricao_livre"]'::jsonb) AS t(x)))
WHERE lower(email) = 'matheusmelorodrigues2005@outlook.com'
  AND permissoes ? 'configuracoes' AND permissoes ? 'atas';
