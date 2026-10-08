"""Nullify — Incident Management Platform. Production entry point."""
from __future__ import annotations
import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from app.core import metrics
from app.core.config import get_settings
from app.core.logging import setup_logging
from sqlalchemy.exc import DBAPIError
from app.db.cache import init_redis, close_redis
from app.db.postgres import schema_revisions
from app.db.retry import is_transient
from app.services import retention, webhooks
from app.services.ingestion import start_ingestion_workers, stop_ingestion_workers
from app.services.ws_manager import manager
from app.middleware.observability import setup_prometheus, setup_otel
from app.routers import signals, work_items, health, ws, auth
from app.services.work_item_service import ConflictError, NotFoundError

setup_logging()

logger = logging.getLogger("ims.main")
settings = get_settings()
WEBHOOK_DRAIN_SECONDS = 5.0


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Nullify backend [env=%s]", settings.app_env)
    current, head = await schema_revisions()  # Alembic owns the schema; never run against an older or newer one
    if current != head:
        raise RuntimeError(f"Database schema is at {current}, this code needs {head}: run `alembic upgrade head`")
    metrics.forget_dead_workers()  # a worker that crashed before this one started left its live gauges behind
    await init_redis()
    await manager.start()  # cross-worker live updates over Redis pub/sub
    await start_ingestion_workers()
    gauges = asyncio.create_task(metrics.refresh_loop())  # the open-incident gauge, every 30 s
    retention_task = asyncio.create_task(retention.retention_loop())  # raw signals older than RETENTION_DAYS, daily
    logger.info("Nullify ready")
    yield
    gauges.cancel()
    retention_task.cancel()
    logger.info("Shutting down Nullify: draining ingestion queue")
    await stop_ingestion_workers(settings.shutdown_drain_seconds)
    # After the ingest drain, which can still open incidents and page. 20 s + 5 s fits stop_grace_period (30 s).
    cut = await webhooks.drain(WEBHOOK_DRAIN_SECONDS)
    if cut:
        logger.error("Cancelled %d notifications still in flight at shutdown", cut)
    await manager.stop()
    await close_redis()


def docs_kwargs(s) -> dict:
    """Interactive docs and the OpenAPI schema map the whole API: development only."""
    if s.app_env == "production":
        return {"docs_url": None, "redoc_url": None, "openapi_url": None}
    return {"docs_url": "/docs", "redoc_url": "/redoc", "openapi_url": "/openapi.json"}


app = FastAPI(
    title="Nullify",
    version="2.0.0",
    description="Nullify: incident management with PostgreSQL, Redis, JWT auth and Prometheus",
    lifespan=lifespan,
    **docs_kwargs(settings),
)

# Observability
setup_prometheus(app)
setup_otel(app)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Service errors that mean the same on every route (each route still maps its own 400s and 422s)
@app.exception_handler(NotFoundError)
async def _not_found(_: Request, e: NotFoundError):
    return JSONResponse(status_code=404, content={"detail": str(e)})


@app.exception_handler(ConflictError)
async def _conflict(_: Request, e: ConflictError):
    return JSONResponse(status_code=409, content={"detail": str(e)})


@app.exception_handler(OSError)  # asyncpg raises socket errors (e.g. the DB host stops resolving) unwrapped
@app.exception_handler(DBAPIError)
async def _db_error(request: Request, e: Exception):
    """A Postgres outage is a 503 with Retry-After on every route (auth reads the DB first), so producers back off
    and retry instead of treating a 500 as final. Any other DB error is still a 500."""
    if is_transient(e):
        logger.warning("Database unavailable on %s %s: %s", request.method, request.url.path, getattr(e, "orig", None) or e)
        return JSONResponse(status_code=503, content={"detail": "Database unavailable, retry later."},
                            headers={"Retry-After": "5"})
    logger.error("Database error on %s %s", request.method, request.url.path, exc_info=e)
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


# Routers
app.include_router(auth.router)
app.include_router(signals.router)
app.include_router(work_items.router)
app.include_router(health.router)
app.include_router(ws.router)