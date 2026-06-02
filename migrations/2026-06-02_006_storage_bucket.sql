-- Storage bucket: previsao-arquivos
-- Aplicar EM DEV primeiro. PROD pendente autorizacao explicita.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'previsao-arquivos',
  'previsao-arquivos',
  false,
  52428800,
  ARRAY[
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: server.js usa service_role (bypassa). Policies defensivas pra
-- caso alguem tente acesso direto via Supabase JS.

DROP POLICY IF EXISTS "storage_geracao_select" ON storage.objects;
CREATE POLICY "storage_geracao_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'previsao-arquivos'
    AND COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') IN ('GESTOR', 'GERENTE')
  );

-- INSERT/UPDATE/DELETE: apenas via service_role (server.js). Sem policies = bloqueia clientes diretos.
