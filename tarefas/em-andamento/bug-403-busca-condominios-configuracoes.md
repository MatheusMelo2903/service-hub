# Bug 403 na busca de condominios em Configuracoes

## Descoberto em
29/04/2026 (Etapa 2 do Service Hub, Teste 7)

## Sintoma
Endpoint /v2/condor/condominios retorna status 403 com mensagem
"Id do condominio nao informado" quando usado como busca generica
no painel Configuracoes do Service Hub.

## Reproducao
1. Abrir Service Hub
2. Ir em Configuracoes
3. Buscar por nome de condominio
4. Console do browser mostra erro 403 da API

## Hipotese
Bug no codigo do navegador (public/index.html) na construcao da query.
O endpoint /v2/condor/condominios provavelmente exige parametro de busca
explicito ou condominio_id, e o codigo atual chama sem parametros.

## Impacto
Baixo. Nao bloqueia importacao de unidades. Afeta UX da busca em
Configuracoes apenas.

## Proxima acao
Investigar codigo do navegador em public/index.html que chama
/v2/condor/condominios e adicionar parametro de busca correto.
