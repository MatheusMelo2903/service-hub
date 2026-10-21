-- T03: ação prestacao_contas.ajustar_estrutura ("Ajustar estrutura" na prestação de contas).
-- GESTOR recebe pelo trigger; os outros perfis recebem pela tela de permissões.
-- Aplicada SÓ no Supabase de teste (ledgyprytkuvgtbunsck). Produção só com autorização do Matheus.

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
        "prestacao_contas":   {"visivel": true, "acoes": ["ver", "gerar", "ajustar_estrutura"]},
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

-- GESTOR já cadastrado: o trigger só roda em INSERT ou troca de role.
UPDATE public.profiles
SET permissoes = jsonb_set(permissoes, '{prestacao_contas,acoes}',
                           COALESCE(permissoes->'prestacao_contas'->'acoes', '[]'::jsonb) || '["ajustar_estrutura"]'::jsonb)
WHERE role = 'GESTOR'
  AND permissoes ? 'prestacao_contas'
  AND NOT (COALESCE(permissoes->'prestacao_contas'->'acoes', '[]'::jsonb) ? 'ajustar_estrutura');
