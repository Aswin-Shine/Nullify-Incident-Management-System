from __future__ import annotations
import json
import logging
from typing import Any, Optional
import redis.asyncio as aioredis
from app.core.config import get_settings

logger = logging.getLogger("ims.cache")
_redis: aioredis.Redis | None = None
DEFAULT_TTL = 300


async def init_redis():
    global _redis
    settings = get_settings()
    _redis = aioredis.from_url(settings.redis_url, encoding="utf-8", decode_responses=True, max_connections=20)
    await _redis.ping()
    logger.info("Redis connected: %s:%s/%s", settings.redis_host, settings.redis_port, settings.redis_db)  # the URL has the password


async def close_redis():
    global _redis
    if _redis:
        await _redis.aclose()
        _redis = None


def _r() -> aioredis.Redis:
    if not _redis:
        raise RuntimeError("Redis not initialized")
    return _redis


async def set_val(key: str, value: Any, ttl: int = DEFAULT_TTL):
    try:
        await _r().set(f"ims:{key}", json.dumps(value), ex=ttl)
    except Exception as e:
        logger.warning("Cache set failed [%s]: %s", key, e)


async def get_val(key: str) -> Optional[Any]:
    try:
        raw = await _r().get(f"ims:{key}")
        return json.loads(raw) if raw else None
    except Exception as e:
        logger.warning("Cache get failed [%s]: %s", key, e)
        return None


async def delete_val(key: str):
    try:
        await _r().delete(f"ims:{key}")
    except Exception as e:
        logger.warning("Cache delete failed [%s]: %s", key, e)


async def bump(key: str):
    """Increment a generation counter. Readers put it in their cache keys, so a bump retires every
    key built from the old value (they expire on their own TTL) without scanning Redis."""
    try:
        await _r().incr(f"ims:{key}")
    except Exception as e:
        logger.warning("Cache bump failed [%s]: %s", key, e)


async def claim(key: str, ttl: int) -> bool:
    """True for exactly one caller until the key expires (SET NX), across every worker. False if Redis is down."""
    try:
        return bool(await _r().set(f"ims:{key}", 1, nx=True, ex=ttl))
    except Exception as e:
        logger.warning("Cache claim failed [%s]: %s", key, e)
        return False


async def incr(key: str, ttl: int = 60, amount: int = 1) -> int:
    r = _r()
    val = await r.incr(f"ims:{key}", amount)
    if val == amount:  # the first increment of this key
        await r.expire(f"ims:{key}", ttl)
    return val


async def health_check() -> bool:
    try:
        return await _r().ping()
    except Exception:
        return False
