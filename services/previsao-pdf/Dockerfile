FROM python:3.12-slim

# LibreOffice (impress + writer pra renderizar PPTX->PDF) + Carlito (substitute libre Calibri)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-impress \
    fonts-crosextra-carlito \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY assets/ ./assets/

ENV PORT=8000
EXPOSE 8000

# Nao rodar como root - pratica padrao (Railway efemero, mas defesa em profundidade)
RUN adduser --disabled-password --gecos "" --no-create-home appuser \
 && chown -R appuser:appuser /app
USER appuser

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
