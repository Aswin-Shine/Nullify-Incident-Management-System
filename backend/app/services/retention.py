"""Raw-signal retention: once a day, drop signal rows, timeseries buckets and lake day-folders older than
RETENTION_DAYS. Incidents, their history, comments and RCAs are the record and are never deleted.

Every worker runs the loop; a Redis key per day lets only the first one do the work.
"""
from __future__ import annotations
import asyncio
import logging
import os
import shutil
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from app.core.config import get_settings
from app.db import cache
from app.db.nosql import DAY_DIR
from app.db.postgres import AsyncSessionLocal, Signal, TimeseriesAgg

logger = logging.getLogger("ims.retention")
BATCH = 10_000  # rows per DELETE, so one run never holds a long lock on a busy table


def _drop_lake_days(lake_dir: str, before_day: str) -> int:
    if not os.path.isdir(lake_dir):
        return 0
    old = [d for d in os.listdir(lake_dir) if DAY_DIR.match(d) and d < before_day]
    for d in old:
        shutil.rmtree(os.path.join(lake_dir, d))
    return len(old)


async def purge(now: datetime | None = None) -> dict | None:
    """Delete what is past the window. None when retention is off, another worker is running it, or it already
    finished today. The day is marked done only after a successful run, so a failed run is retried next hour."""
    s = get_settings()
    now = now or datetime.now(timezone.utc)
    done = f"retention:done:{now:%Y-%m-%d}"
    if s.retention_days <= 0 or not await cache.claim("retention:lock", ttl=3600):
        return None
    try:
        if await cache.get_val(done):  # checked under the lock: a worker that just finished set it before releasing
            return None
        result = await _run(s, now)
        await cache.set_val(done, 1, ttl=2 * 86400)
        return result
    finally:
        await cache.delete_val("retention:lock")


async def _run(s, now: datetime) -> dict:
    cutoff = now - timedelta(days=s.retention_days)
    signals = 0
    async with AsyncSessionLocal() as db:
        while True:
            batch = select(Signal.id).where(Signal.received_at < cutoff).limit(BATCH).scalar_subquery()
            n = (await db.execute(delete(Signal).where(Signal.id.in_(batch)))).rowcount
            await db.commit()
            signals += n
            if n < BATCH:
                break
        timeseries = (await db.execute(
            delete(TimeseriesAgg).where(TimeseriesAgg.bucket < cutoff.strftime("%Y-%m-%dT%H:%M"))
        )).rowcount
        await db.commit()
    lake_days = await asyncio.to_thread(_drop_lake_days, s.lake_dir, f"{cutoff:%Y-%m-%d}")
    result = {"signals": signals, "timeseries": timeseries, "lake_days": lake_days}
    logger.info("Retention (%d days): removed %s", s.retention_days, result)
    return result


async def retention_loop(interval: float = 3600):
    """Try hourly; the per-day key makes it run once a day. A failure is logged and retried next hour."""
    while True:
        try:
            await purge()
        except Exception as e:
            logger.warning("Retention run failed: %s", e)
        await asyncio.sleep(interval)
