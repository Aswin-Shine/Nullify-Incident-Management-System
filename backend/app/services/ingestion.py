"""Signal ingestion pipeline: asyncio.Queue backpressure -> workers -> Postgres + data lake.

Debounce is enforced by Postgres (partial unique index on active Work Items per component), so it
stays correct across any number of worker tasks, processes or replicas.
"""
from __future__ import annotations
import asyncio
import logging
import time
from datetime import datetime, timezone

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.core.config import get_settings
from app.db.nosql import append_signal
from app.db.postgres import AsyncSessionLocal, Signal, TimeseriesAgg
from app.db.retry import with_db_retry
from app.services import webhooks
from app.services.work_item_service import invalidate_cache, upsert_active_work_item

logger = logging.getLogger("ims.ingestion")
settings = get_settings()

# ponytail: in-process queue loses accepted signals on crash (B-08); Redis Streams in Phase 1
_queue: asyncio.Queue = asyncio.Queue(maxsize=settings.queue_max_size)

_processed_count = 0
_last_metric_time = time.monotonic()
_tasks: list[asyncio.Task] = []
_accepting = True
_spilled = 0


def accepting() -> bool:
    """False once shutdown has begun: callers should get 503, not a 202 we might not honour."""
    return _accepting


async def enqueue_signal(signal: dict) -> bool:
    try:
        _queue.put_nowait(signal)
        return True
    except asyncio.QueueFull:
        logger.warning("Queue full, signal rejected for %s", signal.get("component_id"))
        return False


def _occurred_at(raw, received: datetime) -> datetime:
    """Producer event time as aware UTC, clamped so producer clock skew can't land in the future."""
    if isinstance(raw, str):
        try:
            raw = datetime.fromisoformat(raw)
        except ValueError:
            raw = None
    if raw is None:
        return received
    if raw.tzinfo is None:
        raw = raw.replace(tzinfo=timezone.utc)
    return min(raw, received)


async def _persist(component: str, record: dict, occurred: datetime, received: datetime):
    """One transaction: attach to the active Work Item, store the linked signal, bump the timeseries."""
    async with AsyncSessionLocal() as db:
        wi = await upsert_active_work_item(
            db, component, occurred, record.get("signal_type") or "FAILURE", record.get("message") or ""
        )
        db.add(Signal(
            work_item_id=wi.id, component=component, signal_type=record.get("signal_type") or "FAILURE",
            severity=record.get("severity"), message=record.get("message") or "", payload=record,
            occurred_at=occurred, received_at=received,
        ))
        ts = pg_insert(TimeseriesAgg).values(
            bucket=occurred.strftime("%Y-%m-%dT%H:%M"), component=component, signal_count=1
        )
        await db.execute(ts.on_conflict_do_update(
            constraint="uq_ts_bucket_component", set_={"signal_count": TimeseriesAgg.signal_count + 1}
        ))
        await db.commit()
        return wi


async def process_signal(signal: dict) -> str | None:
    """Persist one signal and append it to the lake audit log. Returns its Work Item id.

    Never raises for DB failures: the raw signal still reaches the lake with work_item_id=None.
    """
    received = datetime.now(timezone.utc)
    occurred = _occurred_at(signal.get("timestamp"), received)
    component = signal.get("component_id") or "UNKNOWN"
    record = {**signal, "timestamp": occurred.isoformat(), "received_at": received.isoformat()}

    try:
        # ponytail: a commit that fails after the server applied it gets retried and counted twice;
        # per-signal idempotency keys (Phase 1, Redis Streams) close that window.
        wi = await with_db_retry(
            lambda: _persist(component, record, occurred, received),
            attempts=settings.db_retry_attempts, base_delay=settings.db_retry_base_delay,
        )
    except Exception:
        logger.exception("Signal persistence failed for %s", component)
        wi = None

    if wi is not None and wi.created:
        # Side effects only after commit: the dashboard must see the new incident, and page once.
        await invalidate_cache()
        asyncio.create_task(webhooks.notify_incident_created({
            "id": wi.id, "component": wi.component, "priority": wi.priority,
            "title": wi.title, "description": wi.description,
        }))
        logger.info("Work item %s opened for %s", wi.id, component)

    wi_id = wi.id if wi is not None else None
    await append_signal({**record, "work_item_id": wi_id})
    return wi_id


async def _spill(signal: dict):
    """Write an unprocessed signal straight to the lake audit log (no DB) during shutdown."""
    global _spilled
    _spilled += 1
    await append_signal({**signal, "work_item_id": None})


async def _worker():
    global _processed_count
    while True:
        signal = await _queue.get()
        try:
            await process_signal(signal)
            _processed_count += 1
        except asyncio.CancelledError:
            await _spill(signal)  # shutdown hit mid-signal: keep it in the audit log
            raise
        except Exception:
            logger.exception("Worker failed on signal for %s", signal.get("component_id"))
        finally:
            _queue.task_done()


async def _metrics_printer():
    global _processed_count, _last_metric_time
    while True:
        await asyncio.sleep(5)
        now = time.monotonic()
        elapsed = now - _last_metric_time
        rate = _processed_count / elapsed if elapsed > 0 else 0
        logger.info("THROUGHPUT: %.1f sig/sec | q=%d/%d | total=%d",
                    rate, _queue.qsize(), _queue.maxsize, _processed_count)
        _processed_count = 0
        _last_metric_time = now


async def start_ingestion_workers(num_workers: int | None = None):
    global _accepting
    _accepting = True
    n = num_workers or settings.ingestion_workers
    _tasks.extend(asyncio.create_task(_worker()) for _ in range(n))
    _tasks.append(asyncio.create_task(_metrics_printer()))
    logger.info("Ingestion pipeline started (%d workers)", n)


async def stop_ingestion_workers(timeout: float) -> int:
    """Stop accepting, let workers drain the queue for up to `timeout` seconds, then cancel them.

    Anything not persisted by then (in flight or still queued) is spilled to the lake audit log
    with work_item_id=None, so a signal we answered 202 for is never silently lost.
    Returns how many signals were spilled.
    """
    global _accepting, _spilled
    _accepting = False
    _spilled = 0
    if _tasks:
        try:
            await asyncio.wait_for(_queue.join(), timeout)
        except asyncio.TimeoutError:
            logger.error("Drain timed out after %.1fs with %d signals still queued", timeout, _queue.qsize())
    for task in _tasks:
        task.cancel()
    await asyncio.gather(*_tasks, return_exceptions=True)
    _tasks.clear()
    while not _queue.empty():
        await _spill(_queue.get_nowait())
        _queue.task_done()
    if _spilled:
        logger.warning("Spilled %d unprocessed signals to the data lake", _spilled)
    return _spilled
