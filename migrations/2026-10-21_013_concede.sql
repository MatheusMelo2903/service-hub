-- T21: delegação de permissões.
-- profiles.concede guarda o que cada gestor ou gerente pode liberar para outros,
-- no formato {"modulo": ["acao", ...]}; "ver" é a visibilidade do módulo.
-- Só o dono altera esse campo (pelo servidor, com service_role).
alter table public.profiles add column if not exists concede jsonb not null default '{}'::jsonb;

-- Leitura direta de todos os perfis pelo navegador deixa de existir: a lista de
-- usuários vem só pelo servidor, que esconde o que cada um não pode ver.
drop policy if exists gestor_ve_todos on public.profiles;
