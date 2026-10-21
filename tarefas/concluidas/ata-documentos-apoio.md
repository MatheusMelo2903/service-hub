# T01 Documentos da assembleia na geração da ata (20/10/2026)

## O que foi feito

1. Aba Atas: card novo "Documentos da assembleia" (um ou mais PDFs: apresentação, prestação de contas, orçamentos, propostas). O texto é extraído no navegador com pdf.js. PDF escaneado (quase sem texto por página) vai como PDF para o servidor, que lê com o Claude. Limites: 6 documentos, 3 escaneados, 8MB por escaneado, 80 mil caracteres por documento.
2. Servidor (/api/atas/gerar): aceita `documentos` (validação antes de gastar API, 400 documentos_invalidos). Antes da geração: leitura dos escaneados (em paralelo) e uma CONFERÊNCIA transcrição x documento que lista divergências de valor, empresa e nome. Teto próprio de 4 chamadas de apoio, separado do teto do motor (7).
3. Regras DOC no system (anexadas no fim, sem reordenar nada): documento é fonte prioritária para números, empresas e nomes; divergência usa a forma do documento com [conferir: transcrição dizia X]; documento nunca cria fato da reunião (apresentação, voto, aprovação).
4. Âncoras determinísticas (anti invenção):
   a. a linha da conferência só segue se o lado "documento" existir de fato no texto do documento;
   b. o marcador [conferir: ...] só fica na ata se o dado logo antes dele existir no documento (validarMarcadoresConferir); o conteúdo é limpo para a forma curta;
   c. a correção cirúrgica não usa valor da fala que a conferência provou divergente;
   d. lacuna determinística não reinsere o valor falado divergente;
   e. aviso "valores que vieram só dos documentos" para o revisor.
5. Gate de saída (gateDeSaida, trazido do branch feat/ata-gate-saida, que nunca tinha ido para a dev): fonte passa a ser a mensagem do usuário (dados, edital, participantes, transcrição) + contexto da administradora + documentos. Correções de falso positivo vistas na primeira ata real: tratamento e cargo (Sra., Secretária, Mesa Diretora) não são nome; gatilho "cia." com fronteira de palavra; abertura no início da frase não vira objeto de voto quando a frase tem outro nome. Harness do gate 45/45.
6. Prompt caching: cache_control só no system das auditorias de bloco (onde o mesmo system se repete). Medido: a auditoria do bloco 2 lê ~20 mil tokens do cache.

## Testes

Harness: scripts/ata-harness/docs-apoio-harness.mjs (dados do cliente fora do repo, em /Users/matheusmelo/v8s/EXECUCAO/testes/T01/fixture.json). Unitários: conferir-unit-test.cjs 5/5, gate 45/45, cirúrgica 21/21, consolidação 59/59. Casos de erro da rota 4/4 + 401.
Casablanca AGO 16/06/2026 com a prestação JUN25 a MAI26 gerada pelo botão "Puxar os dados do Superlógica": ver diário em /Users/matheusmelo/v8s/EXECUCAO/diario/2026-10-20_2030_T01.md.

## Limitações conhecidas

1. O gate ainda marca alguns substantivos comuns capitalizados que não estão na fonte; a lista cresce sob ata real (cauda visível, nunca silenciosa).
2. "Copiar pro Service Hub IA" (atalho externo) não leva os documentos.
3. Trocar de condomínio sem "Limpar tudo" mantém os documentos anexados (mesmo comportamento do edital hoje). A T07 vai amarrar isso ao seletor de condomínio.
