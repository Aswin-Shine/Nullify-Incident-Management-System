"""Rate limiting: fixed-window counters in Redis, shared by every worker process and replica.

Fails open: if Redis is unavailable the request is allowed. Briefly losing the limiter is better
than refusing every signal in the middle of an incident.
"""
import logging
import math
import time

from fastapi import Depends, HTTPException, Request

from app.core.config import get_settings
from app.core.deps import ingest_principal
from app.db import cache
from app.db.postgres import User

logger = logging.getLogger("ims.rate_limit")


def _now() -> float:
    return time.time()


async def _hit(scope: str, key: str, limit: int, window: int, cost: int = 1) -> None:
    now = _now()
    window_id = int(now // window)
    try:
        count = await cache.incr(f"rl:{scope}:{key}:{window_id}", ttl=window * 2, amount=cost)
    except Exception as exc:
        logger.warning("Rate limiter unavailable, allowing request: %s", exc)
        return
    if count > limit:
        retry_after = max(1, math.ceil((window_id + 1) * window - now))
        raise HTTPException(429, "Rate limit exceeded", headers={"Retry-After": str(retry_after)})


async def spend_ingest(user: User, signals: int) -> None:
    """Per-principal budget counted in signals, so a batch of 500 costs 500. API keys and JWTs of one user share it."""
    await _hit("ingest", user.id, get_settings().rate_limit_ingest_per_sec, 1, cost=signals)


async def ingest_limit(user: User = Depends(ingest_principal)) -> User:
    """One signal's worth of budget, for the single-signal route."""
    await spend_ingest(user, 1)
    return user


async def auth_limit(request: Request) -> None:
    """Per client IP. Behind nginx this is the real client (uvicorn --proxy-headers)."""
    ip = request.client.host if request.client else "unknown"
    await _hit("auth", ip, get_settings().rate_limit_auth_per_min, 60)
