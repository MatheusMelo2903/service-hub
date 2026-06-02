FROM python:3.12-slim

WORKDIR /app

# Instala dependencias de sistema necessarias para pdfplumber (pdfminer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpoppler-cpp-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Porta padrao do uvicorn. INTERNAL_API_SECRET deve ser setada via ENV no Railway.
ENV PORT=8000
EXPOSE 8000

# Não rodar como root: Railway cria container efêmero, mas é prática padrão.
RUN adduser --disabled-password --gecos "" --no-create-home appuser \
 && chown -R appuser:appuser /app
USER appuser

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
