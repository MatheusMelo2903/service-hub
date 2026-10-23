-- T51: Central de alertas. "Meus alertas" (preferência por pessoa) e o módulo central_alertas.
-- Aplicar SÓ no Supabase de teste. Produção só quando o Matheus mandar ("sobe para producao").
-- IDEMPOTENTE.
-- Só o servidor (service role) lê e grava: RLS ligada sem policy e sem grant para anon e authenticated.

-- 1. Preferência de cada pessoa: tipos silenciados e "Pausar todos". Silenciar não apaga nem
--    para de gerar alerta: o servidor só marca silenciado nas respostas e a tela esconde.
create table if not exists public.alertas_preferencias (
  user_id uuid primary key,
  silenciados text[] not null default '{}',
  pausado boolean not null default false,
  atualizado_em timestamptz not null default now()
);

alter table public.alertas_preferencias enable row level security;
revoke all on public.alertas_preferencias from anon, authenticated;

-- 2. Módulo central_alertas nas permissões. "ver" liberado para todos (como o Dashboard): sem
--    isso, a primeira edição de permissões de uma pessoa gravaria o módulo desmarcado.
--    GESTOR também ganha "silenciar". Quem já tem a chave não muda.
update public.profiles
set permissoes = jsonb_build_object('central_alertas', '{"visivel": true, "acoes": ["ver", "silenciar"]}'::jsonb) || permissoes
where role = 'GESTOR' and not (permissoes ? 'central_alertas');

update public.profiles
set permissoes = jsonb_build_object('central_alertas', '{"visivel": true, "acoes": ["ver"]}'::jsonb) || permissoes
where role <> 'GESTOR' and not (permissoes ? 'central_alertas');

-- 3. Perfis novos já nascem com a Central visível (mesmo padrão da migration 010 mais o módulo novo).
alter table public.profiles alter column permissoes set default '{
  "atas": {"acoes": [], "visivel": false}, "boletos": {"acoes": [], "visivel": false},
  "tarefas": {"acoes": [], "visivel": false}, "dashboard": {"acoes": [], "visivel": true},
  "conciliacao": {"acoes": [], "visivel": false}, "configuracoes": {"acoes": [], "visivel": false},
  "notas_fiscais": {"acoes": [], "visivel": false}, "leitura_consumo": {"acoes": [], "visivel": false},
  "prestacao_contas": {"acoes": [], "visivel": false}, "importar_despesas": {"acoes": [], "visivel": false},
  "importar_unidades": {"acoes": [], "visivel": false}, "ficha_condominio": {"acoes": [], "visivel": false},
  "cobranca": {"acoes": [], "visivel": false}, "comparativo": {"acoes": [], "visivel": false},
  "central_alertas": {"acoes": ["ver"], "visivel": true}
}'::jsonb;
