# TAREFA: Botao "Refinar prestacao" (IA so em texto)

## O que eu quero
Adicionar um SEGUNDO botao na aba Prestacao de Contas, chamado "Refinar prestacao",
ao lado do atual "Gerar prestacao de contas". O botao atual continua 100% deterministico
(prosa rica que ja existe), sem custo de IA, e resolve 90% dos casos. O botao "Refinar"
aciona IA so quando o Matheus quiser, para dar acabamento extra nos textos curatoriais
(descricoes mais ricas, notas de destaque).

## Por que eu quero
O deterministico resolve a maioria, mas em assembleias importantes o Matheus quer um
acabamento de texto superior sem pagar IA em toda geracao. Refinamento vira opcional e manual.

## Critério de aceite
- [ ] Botao "Gerar prestacao de contas" permanece identico, deterministico, sem IA, sem custo.
- [ ] Botao "Refinar prestacao" novo, separado, dispara IA so sob clique explicito.
- [ ] CONTRATO INVIOLAVEL: a IA escreve SO texto (descricoes, notas). NUNCA toca em numero.
      Todos os valores continuam deterministicos e auditados pela engine atual.
- [ ] A IA recebe apenas os campos de texto/curatoriais, nunca a fonte numerica de verdade.
- [ ] Falha/instabilidade da IA degrada para o texto deterministico, nunca quebra a geracao.

## Arquivos que provavelmente vão ser mexidos
Nao sei ao certo, arquiteto descobre. Candidatos: public/prestacao.js (novo botao + fluxo),
public/index.html (UI do botao), services/prestacao-pdf (se o refino rodar no microservico),
e definicao de onde a chave de IA vive (provavelmente backend, nunca frontend).

## Restrições
- IA NUNCA automatica: so sob clique. Custo so quando o Matheus decide.
- IA NUNCA toca numero. Separacao fisica entre o que e numerico (deterministico) e textual (refinavel).
- Nao mexer na engine de numeros nem nos parsers ja validados.
- Chave de IA nunca no frontend, sempre via backend/proxy (regra de seguranca do projeto).

## Exemplos ou referências
Memoria do projeto: prestacao_botao_refinar_ia. Decisao registrada em 2026-06-24 junto da
Entrega 1 (contraste, icone, escolha de formato).

---

## Plano do arquiteto
PENDENTE. Esta e uma feature maior com decisao de arquitetura. O Matheus quer o subagente
arquiteto planejando PRIMEIRO e ele aprovando o plano ANTES de qualquer linha de codigo.
Nao implementar ate o plano ser aprovado.

## Status
- [x] Tarefa escrita
- [ ] Plano feito pelo arquiteto
- [ ] Plano aprovado pelo Matheus
- [ ] Código implementado
- [ ] Código revisado
- [ ] Correções aplicadas
- [ ] Auditoria de segurança aprovada
- [ ] Validação aprovada
- [ ] Documentação atualizada
