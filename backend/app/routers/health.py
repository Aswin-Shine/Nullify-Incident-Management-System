"""Health + observability endpoints."""
from __future__ import annotations
from fastapi import APIRouter
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

from app.db.postgres import get_db
from app.db import cache
from app.services.ingestion import _queue

router = APIRouter(tags=["observability"])


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    # Probe Postgres
    db_ok = False
    try:
        await db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        pass

    # Probe Redis
    redis_ok = await cache.health_check()

    status = "ok" if (db_ok and redis_ok) else "degraded"
    return {
        "status": status,
        "postgres": "ok" if db_ok else "error",
        "redis": "ok" if redis_ok else "error",
        "queue_depth": _queue.qsize(),
        "queue_capacity": _queue.maxsize,
    }


@router.get("/api/timeseries")
async def timeseries(
    component: str | None = None,
    limit: int = 60,
    db: AsyncSession = Depends(get_db),
):
    if component:
        result = await db.execute(
            text("SELECT bucket, component, signal_count FROM timeseries_agg WHERE component = :c ORDER BY bucket DESC LIMIT :l"),
            {"c": component, "l": limit},
        )
    else:
        result = await db.execute(
            text("SELECT bucket, component, signal_count FROM timeseries_agg ORDER BY bucket DESC LIMIT :l"),
            {"l": limit},
        )
    return [dict(r._mapping) for r in result.all()]