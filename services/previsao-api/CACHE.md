# Cache de Eficiência por Hash MD5

## Por que MD5

MD5 é usado porque é rápido, determinístico e suficiente para detectar mudança
de conteúdo entre duas versões do mesmo payload. NÃO é usado para segurança
criptográfica.

## Serialização com keys ordenadas

JSON.stringify de um mesmo objeto pode produzir strings diferentes se as chaves
estiverem em ordem diferente. Solução: ordenar todas as chaves de todos os
objetos alfabeticamente antes de serializar (recursivo).

## Como o servidor usa o hash

1. Recebe payload no POST /api/previsao/salvar-rascunho.
2. Calcula MD5 do JSON serializado com keys ordenadas.
3. Busca rascunho existente (condominio_id + ano_referencia + status=rascunho).
4. Se hash armazenado == calculado: retorna 200 sem_alteracoes (sem escrita).
5. Caso contrário: insere ou atualiza, retorna o novo hash.

## Consumo futuro por IA

Comparar payload_hash é O(1). Hashes iguais => conteúdo idêntico => skip.
O campo payload_hash está no GET /api/previsao/listar pra esse fim.

## Escopo futuro

Diff entre versões, histórico por campo, delta por grupo orçamentário.
Demandam tabela de versionamento separada — fora do escopo Fase 3.
