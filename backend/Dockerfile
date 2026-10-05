# ============================================================
# Nullify — Backend Dockerfile (multi-stage)
# Stage 1: builder  — installs deps + compiles wheels
# Stage 2: runtime  — minimal image, no build tools
# ============================================================

# ── Stage 1: builder ────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

# System deps needed only at build time (gcc for asyncpg/bcrypt C extensions)
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        gcc \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy only requirements first — layer cache: re-run only when reqs change
COPY requirements.txt .

# Build wheels into /wheels — nothing installed on system yet
RUN pip install --upgrade pip --quiet && \
    pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt


# ── Stage 2: runtime ────────────────────────────────────────
FROM python:3.12-slim AS runtime

LABEL org.opencontainers.image.title="nullify-backend"
LABEL org.opencontainers.image.description="Nullify IMS — FastAPI backend"

# Runtime-only system deps (libpq for asyncpg)
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user — never run as root in production
RUN groupadd --gid 1001 nullify && \
    useradd  --uid 1001 --gid nullify --no-create-home --shell /bin/false nullify

WORKDIR /app

# Install pre-built wheels from builder — no gcc needed
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links /wheels /wheels/*.whl && \
    rm -rf /wheels

# Copy application code
COPY --chown=nullify:nullify . .

# Remove dev/test files from the image
RUN rm -rf tests/ locustfile.py .env.example

# Data lake directory (JSONL writes go here — mount a volume in prod)
RUN mkdir -p /app/data_lake && chown nullify:nullify /app/data_lake

USER nullify

# Expose backend port
EXPOSE 8000

# Healthcheck — hits /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health/live', timeout=4)" || exit 1

# 4 workers, no reload in production. Trusting X-Forwarded-For from any peer is safe only because the backend
# publishes no port and nginx overwrites the header with the real peer ($remote_addr). The only client message
# on /ws is the auth token, hence the 64 KB frame cap (default 16 MB).
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "4", \
     "--proxy-headers", "--forwarded-allow-ips", "*", \
     "--ws-max-size", "65536", \
     "--log-level", "info", \
     "--no-access-log"]
