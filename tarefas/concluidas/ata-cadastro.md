# T07 Ata com cadastro do condomínio (20/10/2026)

## O que foi feito

1. JS da aba Atas separado em public/atas.js (commit só de mudança de lugar, sem mudar comportamento).
2. Card "Condomínio e reunião": seletor único de condomínio. Escolher o condomínio lê /api/condominio/:id/cadastro (Superlógica) e preenche nome, CNPJ, endereço e síndico atual (campos editáveis). O edital só completa data, tipo e local (e a pauta, pelo texto). Sem código do Superlógica ou com o Superlógica fora, os campos ficam para preencher à mão ou pelo edital, como antes.
3. Lista manual de itens de pauta removida. No lugar, o card "Edital e apresentação" com "Selecionar edital" e "Adicionar PDF da apresentação" (o campo de documentos da T01).
4. Trocar de condomínio descarta a ata em andamento (transcrição, edital, documentos) e carrega o cadastro do novo: nada de um condomínio vaza para outro. "Limpar tudo" também recarrega o cabeçalho do cadastro.
5. Conferência de participantes: a geração recebe o código do condomínio; no fim, o servidor lê unidades/index com contatos e sindicos/index (cache de 10 min) e confere cada par "nome + unidade" citado na ata (Sra. X, da unidade J203) e o síndico citado. Resultado: ok, grafia parecida (K x C, Y x I...), nome não consta na unidade, unidade não encontrada. A ata NÃO é alterada: a revisão mostra um quadro "Conferir participantes" no topo (não sai no PDF nem no Word) com os nomes do cadastro daquela unidade, e os avisos contam quantos não bateram. Só para quem tem acesso aos dados do Superlógica. Falha aberta com teto de 40 s.

## Testes

scripts/ata-harness/participantes-unit-test.cjs 8/8. Conferência em dados reais (leitura) sobre a ata gerada do Casablanca na T01: síndica bate com o cadastro; "Kátia" da J203 sai como grafia parecida (no cadastro está com C). Chrome no dev: ver diário.

## Limitações

1. A conferência só pega participante citado com tratamento ou "condômino(a)" e a palavra unidade/apartamento/apto/casa/sala/lote perto do nome. Lista de presença sem unidade não é conferida.
2. Nome citado só pelo primeiro nome bate se esse primeiro nome existir entre os contatos da unidade.
