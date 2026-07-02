# previsao-pdf

Microservico FastAPI que gera PPTX e PDF de Previsao Orcamentaria Condominial.

Recebe o payload da Fase 3 (PrevisaoResponse) mais configuracao de rateio,
gera a apresentacao via python-pptx (fonte Carlito) e converte para PDF via
LibreOffice headless. Retorna ambos os arquivos em base64.

## Endpoints

| Metodo | Rota       | Auth              | Descricao             |
|--------|------------|-------------------|-----------------------|
| GET    | /healthz   | Nenhuma           | Health check Railway  |
| POST   | /gerar     | X-Internal-Secret | Gera PPTX + PDF       |

## ENVs obrigatorias

| Variavel           | Descricao                                    |
|--------------------|----------------------------------------------|
| INTERNAL_API_SECRET | Segredo compartilhado com server.js (HMAC)  |
| PORT               | Porta de escuta (default: 8000)              |

## Fonte Carlito vs Calibri

A apresentacao usa Carlito, substituto livre do Calibri da Microsoft.
O pacote Linux e `fonts-crosextra-carlito`, incluido no Dockerfile.
Em ambientes locais macOS, instale via Homebrew ou baixe em
https://fonts.google.com/specimen/Carlito.

## Como rodar localmente (Docker)

```bash
docker build -t previsao-pdf .
docker run -p 8000:8000 -e INTERNAL_API_SECRET=dev-secret previsao-pdf
```

## Como rodar testes (sem Docker)

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pytest tests/ -v
```

O teste do converter e mockado: nao requer LibreOffice instalado.
O teste do builder gera um Presentation real em memoria.

## Observacoes

O microservico NAO acessa Supabase. O server.js e responsavel por:
- Receber a requisicao do frontend
- Chamar POST /gerar neste microservico
- Fazer upload dos bytes (base64 decodificado) para o Supabase Storage
- Gerar signed URLs (10 min) e retornar ao frontend
- Persistir o registro em previsoes_geracoes (cache por payload_hash)
