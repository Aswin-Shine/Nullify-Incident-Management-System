"""Signal ingestion pipeline — asyncio.Queue backpressure + Postgres + debounce."""
from __future__ import annotations
import asyncio
import logging
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from app.core.config import get_settings
from app.db import cache
from app.db.nosql import append_signal
from app.db.postgres import AsyncSessionLocal, WorkItem, TimeseriesAgg
from app.models.schemas import WorkItemCreate
from app.services.alert_strategy import get_alert_strategy
from app.services import webhooks

logger = logging.getLogger("ims.ingestion")
settings = get_settings()

_queue: asyncio.Queue = asyncio.Queue(maxsize=settings.queue_max_size)

_debounce_counts: dict[str, int] = defaultdict(int)
_debounce_window_start: dict[str, float] = {}
_debounce_work_item: dict[str, str] = {}
_debounce_lock = asyncio.Lock()

_processed_count = 0
_last_metric_time = time.monotonic()


async def enqueue_signal(signal: dict) -> bool:
    try:
        _queue.put_nowait(signal)
        return True
    except asyncio.QueueFull:
        logger.warning("Queue full — signal dropped for %s", signal.get("component_id"))
        return False


async def _get_or_create_work_item(component_id: str, signal: dict) -> str | None:
    async with _debounce_lock:
        now = time.monotonic()
        window_start = _debounce_window_start.get(component_id, now)

        if now - window_start > settings.debounce_window_seconds:
            _debounce_counts[component_id] = 0
            _debounce_window_start[component_id] = now
            _debounce_work_item.pop(component_id, None)

        _debounce_counts[component_id] += 1

        if component_id in _debounce_work_item:
            return _debounce_work_item[component_id]

        count = _debounce_counts[component_id]
        if count == 1 or count >= settings.debounce_threshold:
            strategy = get_alert_strategy(component_id)
            wi_data = WorkItemCreate(
                component=component_id,
                priority=strategy.priority(),
                title=f"{component_id} — {signal.get('signal_type', 'FAILURE')}",
                description=strategy.notify(component_id, signal.get("message", "")),
            )
            async with AsyncSessionLocal() as db:
                wi_id = str(uuid.uuid4())
                from datetime import timedelta
                from app.services.work_item_service import SLA_MINUTES
                ts = datetime.now(timezone.utc)
                sla = ts + timedelta(minutes=SLA_MINUTES.get(wi_data.priority, 1440))
                wi = WorkItem(
                    id=wi_id, component=wi_data.component, priority=wi_data.priority,
                    status="OPEN", title=wi_data.title, description=wi_data.description,
                    start_time=ts, sla_deadline=sla, created_at=ts, updated_at=ts,
                )
                db.add(wi)
                await db.commit()

            # Fire webhook async (don't block worker)
            asyncio.create_task(webhooks.notify_incident_created(
                {"id": wi_id, "component": component_id, "priority": wi_data.priority,
                 "title": wi_data.title, "description": wi_data.description}
            ))

            _debounce_work_item[component_id] = wi_id
            logger.info("Work item %s created for %s (count=%d)", wi_id, component_id, count)
            return wi_id
        return None


async def _worker():
    global _processed_count
    while True:
        try:
            signal: dict = await asyncio.wait_for(_queue.get(), timeout=1.0)
        except asyncio.TimeoutError:
            continue
        except Exception:
            continue

        try:
            await append_signal(signal)
            cid = signal.get("component_id", "UNKNOWN")
            await _get_or_create_work_item(cid, signal)

            bucket = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
            async with AsyncSessionLocal() as db:
                from sqlalchemy.dialects.postgresql import insert as pg_insert
                stmt = pg_insert(TimeseriesAgg).values(
                    bucket=bucket, component=cid, signal_count=1
                ).on_conflict_do_update(
                    index_elements=["bucket", "component"],
                    set_={"signal_count": TimeseriesAgg.signal_count + 1}
                )
                # fallback: use raw upsert via execute
                await db.execute(
                    __import__("sqlalchemy").text(
                        "INSERT INTO timeseries_agg (bucket, component, signal_count) VALUES (:b, :c, 1) "
                        "ON CONFLICT DO NOTHING"
                    ),
                    {"b": bucket, "c": cid}
                )
                await db.commit()

            _processed_count += 1
        except Exception as exc:
            logger.error("Worker error: %s", exc, exc_info=True)
        finally:
            _queue.task_done()


async def _metrics_printer():
    global _processed_count, _last_metric_time
    while True:
        await asyncio.sleep(5)
        now = time.monotonic()
        elapsed = now - _last_metric_time
        rate = _processed_count / elapsed if elapsed > 0 else 0
        logger.info("📊 THROUGHPUT: %.1f sig/sec | q=%d/%d | total=%d",
                    rate, _queue.qsize(), _queue.maxsize, _processed_count)
        _processed_count = 0
        _last_metric_time = now


async def start_ingestion_workers(num_workers: int | None = None):
    n = num_workers or settings.ingestion_workers
    for _ in range(n):
        asyncio.create_task(_worker())
    asyncio.create_task(_metrics_printer())
    logger.info("Ingestion pipeline started (%d workers)", n)