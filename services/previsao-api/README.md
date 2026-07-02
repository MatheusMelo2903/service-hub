# Previsão Orçamentária API

Microserviço FastAPI que extrai dados dos PDFs W011A (despesas 12 meses) e W045A
(frações ideais) do Superlógica e retorna JSON estruturado com 8 grupos canônicos.

## Como rodar local

```bash
cd services/previsao-api

# Criar ambiente virtual
python3 -m venv .venv
source .venv/bin/activate

# Instalar dependências
pip install -r requirements.txt

# Gerar PDFs de teste
python scripts/gerar_mock_w011a.py --saida /tmp/sh_previsao_mock_w011a.pdf
python scripts/gerar_mock_w045a.py --saida /tmp/sh_previsao_mock_w045a.pdf

# Rodar testes
pytest tests/ -v

# Subir o servidor
INTERNAL_API_SECRET=test123 uvicorn app.main:app --port 8000

# Testar extração
curl -s -X POST http://localhost:8000/extrair-pdfs \
  -H "X-Internal-Secret: test123" \
  -F "w011a=@/tmp/sh_previsao_mock_w011a.pdf" \
  -F "w045a=@/tmp/sh_previsao_mock_w045a.pdf" | python -m json.tool | head -80
```

## Variáveis de Ambiente

| ENV | Obrigatória | Descrição |
|---|---|---|
| `INTERNAL_API_SECRET` | Sim | Segredo compartilhado com o server.js do Service Hub |
| `PORT` | Não | Porta do uvicorn (default: 8000) |

## Endpoints

- `GET /healthz` — health check sem auth
- `POST /extrair-pdfs` — extração com `X-Internal-Secret` no header

## Proxy no Service Hub

O server.js expõe `/api/previsao/extrair-pdfs` que faz proxy autenticado
para este microserviço. Configurar `PREVISAO_API_URL` no Railway apontando
para a URL deste serviço.
