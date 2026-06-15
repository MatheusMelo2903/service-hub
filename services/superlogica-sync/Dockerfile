FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# INTERNAL_API_SECRET, SUPERLOGICA_*, SUPABASE_* vêm via ENV do Railway (nunca em arquivo).

# Não rodar como root (prática padrão; Railway já isola o container).
RUN adduser --disabled-password --gecos "" --no-create-home appuser \
 && chown -R appuser:appuser /app
USER appuser

# Cron puro: o container roda o sync e morre. Não há HTTP server permanente no Railway.
CMD ["python", "-m", "app.sync"]
