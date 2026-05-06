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
    logger.info("Redis connected: %s", settings.redis_url)


async def close_redis():
    global _redis
    if _redis:
        await _redis.aclose()


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


async def delete_pattern(pattern: str):
    try:
        keys = await _r().keys(f"ims:{pattern}")
        if keys:
            await _r().delete(*keys)
    except Exception as e:
        logger.warning("Cache delete_pattern failed [%s]: %s", pattern, e)


async def get_all_with_prefix(prefix: str) -> list[Any]:
    try:
        keys = await _r().keys(f"ims:{prefix}*")
        if not keys:
            return []
        vals = await _r().mget(*keys)
        return [json.loads(v) for v in vals if v]
    except Exception as e:
        logger.warning("Cache prefix scan failed [%s]: %s", prefix, e)
        return []


async def incr(key: str, ttl: int = 60) -> int:
    r = _r()
    val = await r.incr(f"ims:{key}")
    if val == 1:
        await r.expire(f"ims:{key}", ttl)
    return val


async def health_check() -> bool:
    try:
        return await _r().ping()
    except Exception:
        return False
