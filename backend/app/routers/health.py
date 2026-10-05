"""Health + observability endpoints.

/health       readiness: Postgres, Redis, queue headroom, accepting. 503 when degraded, so load
              balancers and the dashboard see it. Anonymous callers (it is public through nginx) get only
              the status; a signed-in user gets the detail for the dashboard's health bar.
/health/live  liveness: the process is up. Docker healthchecks use this, so a Redis blip does not
              get the backend restarted in a loop.
"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, Query, Security
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import bearer, get_current_active_user, user_from_access_token
from app.db import cache
from app.db.postgres import User, get_db
from app.services import ingestion
from app.services.ingestion import _queue

router = APIRouter(tags=["observability"])

QUEUE_SATURATION = 0.9


@router.get("/health/live")
async def live():
    return {"status": "ok"}


async def _postgres_ok(db: AsyncSession) -> bool:
    try:
        await db.execute(text("SELECT 1"))
        return True
    except Exception:
        try:
            await db.rollback()  # leave the session clean so get_db's commit can't turn 503 into 500
        except Exception:
            pass
        return False


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db),
                 credentials: HTTPAuthorizationCredentials | None = Security(bearer)):
    db_ok = await _postgres_ok(db)
    redis_ok = await cache.health_check()
    queue_ok = _queue.qsize() < _queue.maxsize * QUEUE_SATURATION
    accepting = ingestion.accepting()

    healthy = db_ok and redis_ok and queue_ok and accepting
    code, status = (200, "ok") if healthy else (503, "degraded")
    # Only with a working DB can the token be checked; without one the detail stays private.
    signed_in = db_ok and credentials is not None and await user_from_access_token(credentials.credentials, db)
    if db_ok and credentials is not None and not signed_in:
        raise HTTPException(401, "Session expired")  # the dashboard's client refreshes on 401 and asks again
    if not signed_in:
        return JSONResponse(status_code=code, content={"status": status})
    return JSONResponse(status_code=code, content={
        "status": status,
        "postgres": "ok" if db_ok else "error",
        "redis": "ok" if redis_ok else "error",
        "queue": "ok" if queue_ok else "saturated",
        "accepting": accepting,
        "queue_depth": _queue.qsize(),
        "queue_capacity": _queue.maxsize,
    })


@router.get("/api/timeseries")
async def timeseries(
    component: str | None = None,
    limit: int = Query(60, ge=1, le=1440),
    _: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    if component:
        result = await db.execute(
            text("SELECT bucket, component, signal_count FROM timeseries_agg WHERE component = :c ORDER BY bucket DESC LIMIT :l"),
            {"c": component, "l": limit},
        )
    else:
        result = await db.execute(
            # One row per minute: the table keeps a row per (minute, component), which would draw a bar for each.
            text("SELECT bucket, SUM(signal_count)::int AS signal_count FROM timeseries_agg GROUP BY bucket ORDER BY bucket DESC LIMIT :l"),
            {"l": limit},
        )
    return [dict(r._mapping) for r in result.all()]
