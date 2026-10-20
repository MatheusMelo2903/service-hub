# Fluxo e formatos dos arquivos

## Relatórios aceitos (Superlógica)

| Relatório | Como reconhecer | Para que serve |
|---|---|---|
| W011A padrão | "Comparativo de Mmm/AAAA com os próximos 11 meses" | Série mês a mês por rubrica, saldos. Obrigatório |
| W011A detalhado | Mesmo cabeçalho com "; Detalhado" | Itens mês a mês. Cobre meses sem W011A padrão e serve de fonte de itens quando abrange o período inteiro |
| W015A detalhado | "Comparativo de ... até ... e dd/mm/aaaa até dd/mm/aaaa; Detalhado" | Itens com total de duas colunas de período. Fonte de itens quando a primeira coluna é exatamente o período |

Pedidos a Matheus, quando faltar algo:
- meses fora do W011A: "me manda o W011A começando em Mmm/AAAA"
- itens: "me manda o W015A detalhado com o período de dd/mm/aaaa até dd/mm/aaaa"

## dados.json (gerado por extrair.py, não editar)

```
condominio, modo ("simples" | "detalhado"), fonte_itens, periodo ["2025-08", ...], meses_label ["Ago/25", ...]
saldo_anterior, saldo_final, receitas_mes [...], despesas_mes [...], saldo_fim_mes [...]
receitas: [{nome, serie, total}]
categorias: [{nome, total, rubricas: [{nome, serie, total, status, itens: [{rotulo, valor, qtd}]}]}]
```

## composicao.json (escrito na curadoria)

```json
{
  "cliente": {"linha1": "Condomínio", "linha2": "Buritis", "rodape": "CONDOMÍNIO BURITIS"},
  "categorias": {
    "DESPESAS COM CONSUMO": {"nota": "Água e gás são rateados e voltam na receita: ..."},
    "MANUTENÇÃO": {"desc": "Contratos fixos de manutenção e das atividades esportivas.", "nota": "..."}
  },
  "rubricas": {
    "Material Área de Lazer": {"texto": "TV para o salão de festas R$ 2.390,00 · bancos R$ 2.022,00", "fecha": true},
    "Contrato Manutenção Elevador": {"texto": "Manutenção preventiva mensal dos elevadores ({n} meses)", "fecha": false},
    "Despesas Com Cartório": {"nome": "Cartório", "texto": "Registro de ata em cartório", "fecha": false}
  },
  "receitas_nomes": {"Subscrição de Capital - Integralização de juros": "Integralização de juros (capital)"},
  "receita_insight": "Taxa de condomínio responde por 48,3% da arrecadação. Água e gás rateados somam R$ ..."
}
```

- Chaves de `rubricas` e `categorias`: nome exato do Superlógica, como em dados.json.
- `categorias` é opcional: `montar.py` tem títulos e descrições padrão para as categorias do plano de contas do Superlógica (`CAT_PADRAO`). Usar só para nota ou ajuste.
- `cliente.linha1`: "Condomínio", "Associação", "Residencial"... `linha2`: o nome. Pegar do relatório e confirmar a grafia (o relatório vem em caixa alta).
- `receita_insight`: frase da faixa do slide de receita. Sem ela, o montador escreve a participação da maior fonte.
- Modo detalhado: toda rubrica precisa de `texto`, ou `montar.py` para com erro. Modo simples: só `cliente`.

## Nome dos arquivos de saída
"<Nome> - Prestação de Contas <MMMAA> a <MMMAA>.pdf" e ".pptx". Ex.: "Buritis - Prestação de Contas AGO25 a SET26.pdf".
