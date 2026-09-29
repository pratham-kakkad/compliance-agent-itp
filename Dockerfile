# Backend image: the FastAPI app only. The SPA is built and served by its own
# service (frontend/Dockerfile, nginx), so there's no Node stage here.
FROM python:3.11-slim
WORKDIR /app

# psycopg2-binary needs libpq at runtime
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY app ./app
COPY alembic.ini ./
COPY migrations ./migrations
COPY scripts ./scripts
COPY docker-entrypoint.sh ./

RUN pip install --no-cache-dir ".[dev]" && chmod +x docker-entrypoint.sh

EXPOSE 8010 5678
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/health', timeout=4)"
ENTRYPOINT ["./docker-entrypoint.sh"]
# --proxy-headers: requests arrive through the frontend's nginx, which sets
# X-Forwarded-For / X-Forwarded-Proto.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010", "--proxy-headers", "--forwarded-allow-ips=*"]
