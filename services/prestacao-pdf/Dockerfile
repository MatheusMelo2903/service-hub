FROM python:3.12-slim

# LibreOffice (impress pra PPTX->PDF) + Carlito (substitute libre da Calibri,
# fonte do template da skill powerpoint-prestacao-contas)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-impress \
    fonts-crosextra-carlito \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY vendor/ ./vendor/

ENV PORT=8000
EXPOSE 8000

# Nao rodar como root. ATENCAO: o soffice precisa de perfil gravavel em
# runtime (appuser nao tem home) - o converter passa -env:UserInstallation
# e HOME apontando pro tmpdir da requisicao (fix herdado do previsao-pdf,
# soffice exit 77 sem isso).
RUN adduser --disabled-password --gecos "" --no-create-home appuser \
 && chown -R appuser:appuser /app
USER appuser

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
