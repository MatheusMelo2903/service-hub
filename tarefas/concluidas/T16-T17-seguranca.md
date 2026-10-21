# T16 Auditoria e T17 Blindagem (21/10/2026, sessão com o Matheus)

## Pedido
1. Ninguém pode descobrir que há IA no sistema, qual fornecedor de texto ou de transcrição é usado, nem mandar pergunta livre para a IA.
2. Registro de tudo que cada pessoa faz; alertas de uso indevido; o dono vê tudo, inclusive o que quem ele liberar faz, e essa pessoa nunca vê o que o dono faz.
3. Transcrições guardadas; só quem tem transcrição livre (Matheus e, quando ele liberar, a Raiane) vê o texto; ata e prestação só de condomínio da base.
4. Trocar senha, bloquear e excluir usuário. Senha nunca é guardada nem mostrada (decisão do Matheus no chat, trocando "ver senha" por "trocar e bloquear").

## O que mudou
Servidor
1. servico/modelo.js: única saída para o serviço de texto; erros genéricos para a tela; uso de tokens por pessoa.
2. servico/processar.js: /api/processar/edital, /medidor e /unidades com pedido fixo, permissão de módulo, limite por hora e resposta conferida (nunca texto bruto).
3. servico/audio.js: /api/audio/enviar, /transcrever, /status/:id e /api/transcricoes/texto. O navegador nunca vê endereço nem código do serviço de transcrição. Toda transcrição vai para a tabela transcricoes.
4. servico/ata-mensagem.js: o pedido da ata é montado no servidor; o resultado volta sem nome de modelo, tentativas ou telemetria.
5. servico/auditoria.js e servico/rotas-seguranca.js: registro, alertas, transcrições (ver, baixar, apagar texto), uso, trocar senha, bloquear. Bloqueado cai na hora (requireAuth) e não entra (ban no login).
6. servico/ofuscar.js: JS e HTML públicos servidos sem comentários (terser, sem renomear). public/tracker.html saiu da pasta pública (era aberto sem login).
7. Rotas abertas removidas: /api/claude/messages e /api/assemblyai/*.
8. Ata, prestação e transcrição com condomínio só se ele estiver na base. Prestação por relatório confere o nome do condomínio do relatório.
9. Cadastro manual de condomínio só GESTOR e conferido no Superlógica (/api/condominios/cadastrar).
10. Lista de usuários esconde ações restritas de quem não as tem; salvar permissões mantém as restritas como estavam.
11. supabaseAdminRequest junta a resposta em Buffer (acentos de transcrição longa não corrompem).
12. Cabeçalhos que anunciam a tecnologia do servidor removidos.

Banco
1. Migration 011: tabelas auditoria e transcricoes, profiles.bloqueado, ações do dono (auditoria_total, ver_auditoria, transcricao_livre).
2. Migration 012: tira a escrita direta pelo navegador em condominios, demandas, historico, laudos, hub_progresso (aberta sem login) e profiles.

Tela
1. Aba Segurança (só com ver_auditoria ou auditoria_total).
2. Textos sem IA nem fornecedor ("Processar documento fora do padrão").
3. Sem transcrição livre: a caixa de texto some; aparece "Transcrição pronta, guardada no sistema".
4. Botão de copiar o pedido da ata para uso externo removido.
5. Aviso no login: uso exclusivo da empresa, ações registradas.
6. Gerador local antigo da prestação removido.

## Testes
scripts/conferir-textos-publicos.js: o que o navegador recebe está limpo de fornecedor, modelo e "IA".
scripts/teste-mascara-chaves.js: 20 de 20.
Servidor local com as variáveis do dev: sobe, compacta 21 arquivos, rotas antigas dão 404, novas exigem login.

## Validar
Ver STATUS.
