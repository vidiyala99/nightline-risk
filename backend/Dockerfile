# FastAPI backend image for Fly.io (replaces Railway/nixpacks).
# Build context is backend/ (where fly.toml lives). Mirrors the Railway start
# command: uvicorn app.main:app.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# psycopg2-binary / pillow / reportlab / chromadb / bcrypt all ship manylinux
# wheels, so no apt build chain is needed on slim. If a future dep needs to
# compile, add: RUN apt-get update && apt-get install -y --no-install-recommends
# build-essential libpq-dev && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Fly routes to this internal port (see fly.toml [http_service].internal_port).
# Fly does not inject $PORT, so default to 8080.
EXPOSE 8080
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
