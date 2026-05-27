-- 2026-05-26 — Sistema de usuários (roles + permissões por módulo)
--
-- Roles: GESTOR (admin total imutável) · GERENTE (configurável, pode convidar se autorizado) · OPERACIONAL (acesso mínimo)
--
-- Arquitetura:
--   - role espelhado em auth.users.raw_app_meta_data via trigger (vai pro JWT)
--   - permissões granulares por módulo em public.profiles.permissoes (JSONB)
--   - RLS valida role lendo do JWT (auth.jwt()->'app_metadata'->>'role') pra evitar recursão
--     que aconteceria se a policy fizesse SELECT na própria profiles
-- ----------------------------------------------------------------------

-- 1) Tabela profiles
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'OPERACIONAL'
    CHECK (role IN ('GESTOR', 'GERENTE', 'OPERACIONAL')),
  nome TEXT,
  email TEXT,
  pode_convidar BOOLEAN NOT NULL DEFAULT false,
  permissoes JSONB NOT NULL DEFAULT '{
    "dashboard":          {"visivel": true,  "acoes": []},
    "importar_despesas":  {"visivel": false, "acoes": []},
    "importar_unidades":  {"visivel": false, "acoes": []},
    "boletos":            {"visivel": false, "acoes": []},
    "conciliacao":        {"visivel": false, "acoes": []},
    "notas_fiscais":      {"visivel": false, "acoes": []},
    "prestacao_contas":   {"visivel": false, "acoes": []},
    "atas":               {"visivel": false, "acoes": []},
    "leitura_consumo":    {"visivel": false, "acoes": []},
    "tarefas":            {"visivel": false, "acoes": []},
    "configuracoes":      {"visivel": false, "acoes": []}
  }'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profiles_role_idx ON public.profiles(role);

-- 2) Trigger: GESTOR sempre recebe permissões totais e pode_convidar=true (imutável)
CREATE OR REPLACE FUNCTION public.set_gestor_permissoes_totais()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'GESTOR' THEN
    NEW.pode_convidar = true;
    NEW.permissoes = '{
      "dashboard":          {"visivel": true, "acoes": ["ver"]},
      "importar_despesas":  {"visivel": true, "acoes": ["ver", "importar"]},
      "importar_unidades":  {"visivel": true, "acoes": ["ver", "importar", "normalizar"]},
      "boletos":            {"visivel": true, "acoes": ["ver"]},
      "conciliacao":        {"visivel": true, "acoes": ["ver"]},
      "notas_fiscais":      {"visivel": true, "acoes": ["ver"]},
      "prestacao_contas":   {"visivel": true, "acoes": ["ver", "gerar"]},
      "atas":               {"visivel": true, "acoes": ["ver", "gerar", "edital"]},
      "leitura_consumo":    {"visivel": true, "acoes": ["ver", "ler"]},
      "tarefas":            {"visivel": true, "acoes": ["ver"]},
      "configuracoes":      {"visivel": true, "acoes": ["ver", "editar", "convidar"]}
    }'::jsonb;
  END IF;
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_gestor_permissoes ON public.profiles;
CREATE TRIGGER trigger_gestor_permissoes
  BEFORE INSERT OR UPDATE OF role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_gestor_permissoes_totais();

-- 3) Trigger: sincroniza profiles.role em auth.users.raw_app_meta_data (vai pro JWT)
CREATE OR REPLACE FUNCTION public.sync_role_to_metadata()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE auth.users
  SET raw_app_meta_data =
    COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', NEW.role)
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_sync_role ON public.profiles;
CREATE TRIGGER trigger_sync_role
  AFTER INSERT OR UPDATE OF role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_role_to_metadata();

-- 4) Trigger: cria profiles automaticamente quando user é criado em auth.users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 5) RLS — políticas via auth.jwt() pra evitar recursão self-table
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 5a) Usuário sempre vê o próprio perfil
DROP POLICY IF EXISTS "ver_proprio_perfil" ON public.profiles;
CREATE POLICY "ver_proprio_perfil" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

-- 5b) GESTOR vê todos (lê role direto do JWT, sem subquery em profiles → sem recursão)
DROP POLICY IF EXISTS "gestor_ve_todos" ON public.profiles;
CREATE POLICY "gestor_ve_todos" ON public.profiles
  FOR SELECT TO authenticated
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR');

-- 5c) GESTOR edita todos
DROP POLICY IF EXISTS "gestor_edita_todos" ON public.profiles;
CREATE POLICY "gestor_edita_todos" ON public.profiles
  FOR UPDATE TO authenticated
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR')
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR');

-- 5d) GESTOR insere
DROP POLICY IF EXISTS "gestor_insere" ON public.profiles;
CREATE POLICY "gestor_insere" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR');

-- 5e) GESTOR deleta
DROP POLICY IF EXISTS "gestor_deleta" ON public.profiles;
CREATE POLICY "gestor_deleta" ON public.profiles
  FOR DELETE TO authenticated
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'GESTOR');
