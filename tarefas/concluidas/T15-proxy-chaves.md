# T15 Bloqueio das chaves do Superlógica no proxy (20 e 21/10/2026)

Pedido do Matheus: ninguém além dele vê chave, token ou senha que venha do Superlógica; ele escolhe quem mais pode ver.

## O que mudou
1. O proxy /api/superlogica lê a resposta e troca por asteriscos o valor de todo campo com nome de chave (token, credencial, senha, secret, accesskey, apikey, chave, key, certificado, hash), em qualquer endpoint.
2. PDF e imagem passam direto. Planilha, zip e outros arquivos só saem para quem vê as chaves (o front não usa nenhum).
3. Ação nova configuracoes.ver_chaves. Não vem com o cargo GESTOR. Pelo sistema, só quem já tem pode dar ou tirar (tela e servidor). Migration 009 dá a ação só ao Matheus.
4. Cache de permissão do proxy é limpo ao salvar permissões, cargo ou excluir usuário.

## O que foi achado aberto antes (conferido com dados reais, só nomes de campos)
condominios/get: st_token_emp (11 de 91 condomínios), st_credencialpj_cond (21), st_chavepj_cond, st_accesskeybpocobranca_cond.
unidades/index: st_senha_site_uni (senha do morador no site).
contabancos/index: st_token_cb, st_secret_cb, st_accesskeypj_cb, st_tokencartao_cb, st_credencialpjbank_cb, st_chavepjbank_cb, st_chavepix_cb.
fornecedores/index e sindicos/index: st_chave_con, st_tokentemporario_con, st_chavegruvi_con, st_chavegruvi_sin.
Tudo isso agora sai com asteriscos para quem não tem ver_chaves.

## Testes
scripts/teste-mascara-chaves.js: 20 de 20.
Revisão por agente separado: sem grave confirmado; pontos adotados: só PDF e imagem passam direto, BOM, content type, camelCase, regra de dar e tirar, cache.

## Validar
Entrar com um usuário sem ver_chaves e abrir a Ficha ou Contas: nada quebra.
Escrita aberta pelo proxy (POST, PUT, DELETE para quem tem qualquer módulo) continua como antes; entra na T16 (auditoria).
