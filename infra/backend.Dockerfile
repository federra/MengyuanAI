FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.12.7
COPY services/backend/pyproject.toml services/backend/uv.lock ./services/backend/
COPY services/backend/src ./services/backend/src
RUN uv sync --project services/backend --frozen --no-dev
COPY services/backend/alembic.ini ./services/backend/
COPY services/backend/migrations ./services/backend/migrations
ENV PATH="/app/services/backend/.venv/bin:$PATH"
ENV SHORTFILM_STORAGE_ROOT=/data/media
CMD ["uvicorn", "shortfilm.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
