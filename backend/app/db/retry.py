"""Retry for DB writes: transient errors (lost connection, failover, deadlock) only.

Constraint violations and bugs are never retried; they would fail the same way again.
"""
from __future__ import annotations
import asyncio
import logging
import random
from typing import Awaitable, Callable, TypeVar

from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError

from app.core.metrics import DB_RETRIES

logger = logging.getLogger("ims.retry")
T = TypeVar("T")

# 40001 serialization failure, 40P01 deadlock, 57P01/57P02/57P03 server shutting down or starting
_TRANSIENT_SQLSTATES = {"40001", "40P01", "57P01", "57P02", "57P03"}


def is_transient(exc: BaseException) -> bool:
    if isinstance(exc, (OperationalError, InterfaceError, ConnectionError, TimeoutError)):
        return True
    if isinstance(exc, DBAPIError):
        if exc.connection_invalidated:
            return True
        code = getattr(exc.orig, "sqlstate", None) or getattr(exc.orig, "pgcode", None) or ""
        return code in _TRANSIENT_SQLSTATES or code.startswith("08")  # 08xxx: connection exceptions
    return False


async def with_db_retry(fn: Callable[[], Awaitable[T]], *, attempts: int, base_delay: float) -> T:
    """Run `fn` (one whole transaction) up to `attempts` times with exponential backoff.

    `fn` must open its own session so a failed attempt rolls back completely before the next.
    """
    for attempt in range(1, attempts + 1):
        try:
            return await fn()
        except Exception as exc:
            if attempt == attempts or not is_transient(exc):
                raise
            delay = base_delay * 2 ** (attempt - 1) + random.uniform(0, base_delay / 2)
            logger.warning("Transient DB error (attempt %d/%d), retrying in %.2fs: %s",
                           attempt, attempts, delay, exc)
            DB_RETRIES.inc()
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")
