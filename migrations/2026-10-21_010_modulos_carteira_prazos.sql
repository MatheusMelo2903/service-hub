-- T18: módulos novos (Ficha do Condomínio, Cobrança, Comparativo), ação "ver todas as
-- carteiras" (configuracoes.todas_carteiras) e prazos das manutenções periódicas no banco.
-- Aplicada SÓ no Supabase de teste (ledgyprytkuvgtbunsck). Produção só com autorização do Matheus.
-- IDEMPOTENTE.
--
-- 1. Trigger do GESTOR: SOMA às permissões que o perfil já tem as ações do cargo (as de antes,
--    inclusive ajustar_estrutura, os módulos novos e todas_carteiras). Nunca tira nada: ações
--    dadas a uma pessoa por outras migrations (ver_chaves, ver_auditoria, auditoria_total,
--    transcricao_livre) continuam depois de qualquer UPDATE de role (revisão 1 da T18, item 5).

CREATE OR REPLACE FUNCTION public.set_gestor_permissoes_totais()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
  $$;

-- 2. GESTOR já cadastrado (o trigger só roda em INSERT ou troca de role): soma os módulos
--    novos e todas_carteiras sem tirar nada do que já tem (ver_chaves, ver_auditoria etc.).
UPDATE public.profiles
SET permissoes = permissoes
  || jsonb_build_object(
       'ficha_condominio', '{"visivel": true, "acoes": ["ver"]}'::jsonb,
       'cobranca',         '{"visivel": true, "acoes": ["ver", "segunda_via"]}'::jsonb,
       'comparativo',      '{"visivel": true, "acoes": ["ver"]}'::jsonb)
  || CASE WHEN permissoes ? 'configuracoes' THEN jsonb_build_object('configuracoes', jsonb_set(
       permissoes->'configuracoes', '{acoes}',
       (SELECT to_jsonb(array_agg(DISTINCT x ORDER BY x)) FROM jsonb_array_elements_text(
         COALESCE(permissoes->'configuracoes'->'acoes', '[]'::jsonb) || '["todas_carteiras"]'::jsonb) AS t(x))))
     ELSE '{}'::jsonb END
WHERE role = 'GESTOR';

-- 3. Os outros perfis: módulos novos nascem desligados (só deixa explícito; quem já tem a chave
--    não muda).
UPDATE public.profiles
SET permissoes = jsonb_build_object(
       'ficha_condominio', '{"visivel": false, "acoes": []}'::jsonb,
       'cobranca',         '{"visivel": false, "acoes": []}'::jsonb,
       'comparativo',      '{"visivel": false, "acoes": []}'::jsonb) || permissoes
WHERE role <> 'GESTOR';

ALTER TABLE public.profiles ALTER COLUMN permissoes SET DEFAULT '{
  "atas": {"acoes": [], "visivel": false}, "boletos": {"acoes": [], "visivel": false},
  "tarefas": {"acoes": [], "visivel": false}, "dashboard": {"acoes": [], "visivel": true},
  "conciliacao": {"acoes": [], "visivel": false}, "configuracoes": {"acoes": [], "visivel": false},
  "notas_fiscais": {"acoes": [], "visivel": false}, "leitura_consumo": {"acoes": [], "visivel": false},
  "prestacao_contas": {"acoes": [], "visivel": false}, "importar_despesas": {"acoes": [], "visivel": false},
  "importar_unidades": {"acoes": [], "visivel": false}, "ficha_condominio": {"acoes": [], "visivel": false},
  "cobranca": {"acoes": [], "visivel": false}, "comparativo": {"acoes": [], "visivel": false}
}'::jsonb;

-- 4. Configuração geral do sistema (uma linha por chave). Só o servidor lê e grava
--    (service_role): RLS ligado e sem policy para authenticated.
CREATE TABLE IF NOT EXISTS public.config_geral (
  chave           TEXT        PRIMARY KEY,
  valor           JSONB       NOT NULL,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por  UUID        REFERENCES auth.users(id)
);
ALTER TABLE public.config_geral ENABLE ROW LEVEL SECURITY;

-- Prazos confirmados pelo Matheus em 21/10/2026 (dias): os mesmos que estavam fixos no código.
INSERT INTO public.config_geral (chave, valor)
VALUES ('prazos_manutencao', '{"dedetizacao": 180, "extintores": 365, "caixa_dagua": 180, "elevador": 45}'::jsonb)
ON CONFLICT (chave) DO NOTHING;
