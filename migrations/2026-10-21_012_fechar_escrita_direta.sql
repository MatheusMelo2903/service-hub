-- T16: fecha a escrita direta no banco pelo navegador. Achado na revisão de segurança:
-- qualquer usuário logado podia criar, mudar ou apagar condomínios (e com isso furar a
-- regra "ata e prestação só de condomínio da base"); demandas, histórico e laudos também;
-- hub_progresso aceitava escrita até sem login. Um GESTOR podia se dar qualquer ação
-- editando o próprio perfil pelo navegador. Tudo isso passa a ser só pelo servidor.
-- Leitura que o sistema usa continua (lista de condomínios e o próprio perfil).

DROP POLICY IF EXISTS authenticated_full_access ON public.condominios;
DROP POLICY IF EXISTS authenticated_select ON public.condominios;
CREATE POLICY authenticated_select ON public.condominios FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS authenticated_full_access ON public.demandas;
DROP POLICY IF EXISTS authenticated_full_access ON public.historico;
DROP POLICY IF EXISTS authenticated_full_access ON public.laudos;
DROP POLICY IF EXISTS acesso_publico ON public.hub_progresso;

DROP POLICY IF EXISTS gestor_edita_todos ON public.profiles;
DROP POLICY IF EXISTS gestor_insere ON public.profiles;
DROP POLICY IF EXISTS gestor_deleta ON public.profiles;
