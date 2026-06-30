# Regressao W045A — Recreio das Palmeiras

Caso de teste de referencia do parser de PDF W045A (familia A1, posicional) e da
inferencia de papel, incluindo a regra textual de inquilino. Use sempre que
mexer em `marcacaoInquilino`, `qualificadorPapel`, `inferirPapeis`,
`extrairContatosW045APdf` ou nas ancoras/colunas do W045A.

## Fixture

- Documento: relatorio W045A "Contatos das unidades" do **Recreio das Palmeiras
  Condominio Clube** (administradora Setima), PDF de 62 paginas.
- O PDF **nao fica no repositorio** (dado de condomino, LGPD). Fica fora, no
  Downloads do Matheus ("Cadastro das unidades (4).pdf", identico ao (5).pdf).
- Caracteristica deste condominio: **nao usa a coluna Tipo para inquilino**. Quem
  e inquilino foi marcado escrevendo "inquilino"/"inquilina" dentro do nome, com
  Tipo Dependente ou Residente. Por isso e o melhor caso para a regra textual.

## Como rodar

```
npm i pdfjs-dist@3.11.174
node tests/regressao-w045a-recreio.js "/caminho/Cadastro das unidades (4).pdf"
```

Sem o PDF, o teste roda so os casos-limite sinteticos. Sai com codigo != 0 se
qualquer assercao falhar.

## Numeros agregados esperados

| Metrica | Valor |
|---|---|
| Contatos extraidos | 1257 |
| Unidades | 577 |
| Contatos sem nome | 0 |
| Unidades com 2+ proprietarios | 0 |

## As 7 unidades de regressao

A regra textual de inquilino deve produzir exatamente:

| Unidade | Resultado | Por que |
|---|---|---|
| **208 A** | INCERTA (vermelho) | Tres "Inquilino -": JONAS (Marido), MARIA EDUARDA (FILHA), MURILO. MURILO nao tem qualificador, entao a trava de seguranca nao resolve e a unidade cai incerta. Nunca chuta. |
| **401 B** | INCERTA (vermelho) | RAIANE (cunhada inquilino), TALYTA (cunhada do inquilino), JONATHAN (cunhado do inquilino) sao parentes; ALLAN (residente) rebaixado. Nenhum titular claro -> incerta. EDILUCIA fica dependente verde (nome sem marcacao). |
| **804 B** | INCERTA (vermelho) | Tres candidatos a inquilino sem qualificador. |
| **806 D** | RESOLVIDO (amarelo) | Um unico "Inquilino - Abraao" -> vira Inquilino; KAMILLA (residente) rebaixada a dependente. |
| **404 F** | RESOLVIDO (amarelo) | Um unico "LUANNA ... - INQUILINA" -> vira Inquilino (qualificador na continuacao do nome). |
| **406 H** | INCERTA (vermelho) | Dois "INQUILINO -" sem qualificador. |
| **503 H** | INCERTA (vermelho) | Dois "Inquilino -" sem qualificador. |

## Casos-limite da regra textual

- Pessoa chamada **Irma** que e a inquilina ("IRMA INQUILINO") -> `titular`,
  nao parente. Termos ambiguos que tambem sao nomes (Irma, Tia, Nora, Pai) so
  contam como parentesco na forma possessiva "do/da inquilino".
- "cunhada inquilino", "sogra inquilino" (sem "do/da") -> `parente` (termos
  inequivocos da lista `_PARENTESCO_DIRETO_RE`).
- "filha do inquilino", "tia do inquilino" -> `parente` (possessivo cobre
  qualquer termo antes).
- **Locatario** na coluna Tipo nao e rebaixado quando ha um parente de inquilino
  na mesma unidade (o guard cobre `inquilino` e `locatario`).
- Qualificador apos outro parentese: "JOSE (APT 302) (Esposa)" -> `titular`
  (varre todos os parenteses).
- Familia com um (Marido) e os demais (Filho)/(Filha), todos qualificados ->
  resolve sozinho (amarelo). (Marido) + (Esposa) -> incerta.

## Regras de negocio cobertas

1. "inquilino"/"inquilina" no nome qualificando a pessoa -> candidato a titular.
2. Parentesco + inquilino ("cunhada do inquilino") -> parente, vira dependente.
3. Um inquilino titular por unidade. Varios candidatos: resolve so com
   qualificador 100% claro, senao incerta. Parentes sem titular -> incerta.
   Nunca chuta o titular.
4. A marcacao textual sobrepoe a inferencia, mas nao quebra condominios que usam
   Inquilino/Locatario na coluna Tipo.
