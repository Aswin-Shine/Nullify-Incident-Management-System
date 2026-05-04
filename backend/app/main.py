"""Nullify — Incident Management Platform. Production entry point."""
from __future__ import annotations
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.core.config import get_settings
from app.core.logging import setup_logging
from app.db.postgres import init_db
from app.db.cache import init_redis, close_redis
from app.services.ingestion import start_ingestion_workers
from app.middleware.observability import setup_prometheus, setup_otel
from app.routers import signals, work_items, health, ws, auth

setup_logging()

import logging
logger = logging.getLogger("ims.main")
settings = get_settings()
limiter = Limiter(key_func=get_remote_address, default_limits=[settings.rate_limit_api])


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Nullify backend [env=%s]", settings.app_env)
    await init_redis()
    await init_db()
    await start_ingestion_workers()
    logger.info("Nullify ready")
    yield
    logger.info("Shutting down Nullify")
    await close_redis()


app = FastAPI(
    title="Nullify",
    version="2.0.0",
    description="Nullify — Production-grade incident management with PostgreSQL, Redis, JWT auth, Prometheus, OTel",
    lifespan=lifespan,
)

# Observability
setup_prometheus(app)
setup_otel(app)

# Rate limiting
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(auth.router)
app.include_router(signals.router)
app.include_router(work_items.router)
app.include_router(health.router)
app.include_router(ws.router)