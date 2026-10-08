"""Signal ingestion pipeline: asyncio.Queue backpressure -> workers -> Postgres + data lake.

Workers take what is queued in batches and write one transaction per component per batch, so a storm on one
component locks its incident row once per batch instead of once per signal (architecture review H1).
Debounce is enforced by Postgres (partial unique index on active Work Items per component), so it
stays correct across any number of worker tasks, processes or replicas.
"""
from __future__ import annotations
import asyncio
import itertools
import logging
import os
import time
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone

from sqlalchemy import insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.core import metrics
from app.core.config import get_settings
from app.db.nosql import append_signal, append_signals
from app.db.postgres import AsyncSessionLocal, Signal, TimeseriesAgg
from app.db.retry import is_transient, with_db_retry
from app.services import webhooks
from app.services.work_item_service import forget_detail, invalidate_cache, record_event, upsert_active_work_item
from app.services.ws_manager import manager

logger = logging.getLogger("ims.ingestion")
settings = get_settings()

# ponytail: in-process queue loses accepted signals on crash (B-08); Redis Streams in Phase 1
_queue: asyncio.Queue = asyncio.Queue(maxsize=settings.queue_max_size)

_processed_count = 0
_last_metric_time = time.monotonic()
_tasks: list[asyncio.Task] = []
_accepting = True
_spilled = 0
_db_down = False
OUTAGE_BACKOFF = (1, 2, 4, 5)  # seconds between retry rounds while Postgres is down; the last one repeats
INGEST_BATCH_MAX = 200         # signals one worker takes off the queue at once
FLUSH_SECONDS = 1.0            # how often signal_ingested events go out
_dirty: dict[str, str] = {}    # incident id -> component, with signals since the last flush


def accepting() -> bool:
    """False once shutdown has begun: callers should get 503, not a 202 we might not honour."""
    return _accepting


def db_available() -> bool:
    """False while this process's workers are holding signals through a Postgres outage. The signal routes then
    answer 503, so producers back off instead of filling a queue that cannot drain."""
    return not _db_down


def _set_db_down(down: bool):
    global _db_down
    if down != _db_down:
        logger.log(logging.ERROR if down else logging.INFO, "Postgres %s: %s", "unavailable" if down else "is back",
                   "holding signals and refusing new ones" if down else "storing held signals")
    _db_down = down
    metrics.INGEST_DB_DOWN.set(int(down))


async def enqueue_signal(signal: dict) -> bool:
    try:
        _queue.put_nowait(signal)
    except asyncio.QueueFull:
        metrics.SIGNALS_REJECTED.labels(reason="queue_full").inc()
        logger.warning("Queue full, signal rejected for %s", signal.get("component_id"))
        return False
    metrics.SIGNALS_RECEIVED.inc()
    metrics.QUEUE_DEPTH.set(_queue.qsize())
    return True


MAX_BACKDATE = timedelta(hours=24)


def _utc(raw) -> datetime | None:
    """A datetime or ISO string as aware UTC; None when absent or unparseable."""
    if isinstance(raw, str):
        try:
            raw = datetime.fromisoformat(raw)
        except ValueError:
            return None
    if raw is None:
        return None
    return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)


def _occurred_at(raw, received: datetime) -> datetime:
    """Producer event time as aware UTC, clamped to [received - MAX_BACKDATE, received]: skew can't land in the
    future, and one signal can't drag an incident's start (and so its MTTR and SLA) back by years."""
    raw = _utc(raw)
    if raw is None:
        return received
    return max(min(raw, received), received - MAX_BACKDATE)


async def _persist(component: str, items: list[tuple[dict, datetime, datetime]]):
    """One transaction for one component's signals, given as (record, occurred, received): attach them all to the
    active Work Item with a single upsert (the hot row is locked once per batch, not once per signal), store them
    linked in one insert, and add them to their minute buckets."""
    first = items[0][0]
    occurred = [o for _, o, _ in items]
    async with AsyncSessionLocal() as db:
        wi = await upsert_active_work_item(
            db, component, min(occurred), first.get("signal_type") or "FAILURE", first.get("message") or "",
            first.get("component_type"), count=len(items), last_at=max(occurred),
        )
        if wi.created:
            record_event(db, wi.id, "created", None, None, wi.priority)
        await db.execute(insert(Signal), [{
            "work_item_id": wi.id, "component": component, "signal_type": record.get("signal_type") or "FAILURE",
            "severity": record.get("severity"), "message": record.get("message") or "", "payload": record,
            "occurred_at": o, "received_at": r,
        } for record, o, r in items])
        buckets = Counter(o.strftime("%Y-%m-%dT%H:%M") for o in occurred)
        ts = pg_insert(TimeseriesAgg).values([  # sorted: concurrent batches lock bucket rows in the same order
            {"bucket": b, "component": component, "signal_count": n} for b, n in sorted(buckets.items())
        ])
        await db.execute(ts.on_conflict_do_update(
            constraint="uq_ts_bucket_component", set_={"signal_count": TimeseriesAgg.signal_count + ts.excluded.signal_count}
        ))
        await db.commit()
        return wi


async def _persist_until_stored(component: str, items: list[tuple[dict, datetime, datetime]]):
    """`_persist` with retries, except that a transient outage never ends it: the signal is held and retried until
    Postgres is back, with the breaker open meanwhile. A non-transient error (constraint, bug) still raises.

    ponytail: a commit that fails after the server applied it gets retried and counted twice; per-signal
    idempotency keys (Phase 1, Redis Streams) close that window.
    """
    for round_ in itertools.count():
        try:
            wi = await with_db_retry(
                lambda: _persist(component, items),
                attempts=settings.db_retry_attempts, base_delay=settings.db_retry_base_delay,
            )
        except Exception as exc:
            if not is_transient(exc):
                _set_db_down(False)  # the DB answered: this signal is bad, Postgres is not down
                raise
            _set_db_down(True)
            await asyncio.sleep(OUTAGE_BACKOFF[min(round_, len(OUTAGE_BACKOFF) - 1)])
            continue
        _set_db_down(False)
        return wi


async def _after_commit(wi, component: str, component_type: str | None):
    """Side effects of a stored signal, only after its commit: the dashboard must see it, and a new incident pages once."""
    if wi.created:
        metrics.INCIDENTS_CREATED.labels(priority=wi.priority).inc()
        await invalidate_cache()
        webhooks.spawn(webhooks.notify_incident_created({
            "id": wi.id, "component": wi.component, "priority": wi.priority,
            "title": wi.title, "description": wi.description, "component_type": component_type,
        }))
        await manager.broadcast({
            "event": "work_item_created", "id": wi.id, "component": wi.component, "priority": wi.priority,
        })
        logger.info("Work item %s opened for %s", wi.id, component)
    else:
        # The cached detail (signal_count, last_signal_at) is stale now.
        # ponytail: list rows' signal_count may lag up to the 30 s list TTL (the UI does not show it);
        # bumping the list generation per signal would empty the list cache during every burst.
        await forget_detail(wi.id)
    _dirty[wi.id] = component  # announced by the next flush: one event per incident per second, not per signal


async def flush_ingested():
    """Broadcast one signal_ingested per incident that got signals since the last flush (architecture review M2:
    every dashboard refetched on every signal). New incidents are announced at once by _after_commit."""
    pending = list(_dirty.items())
    _dirty.clear()
    for wi_id, component in pending:
        await manager.broadcast({"event": "signal_ingested", "id": wi_id, "component": component})


async def _flush_loop():
    while True:
        await asyncio.sleep(FLUSH_SECONDS)
        try:
            await flush_ingested()
        except Exception:
            logger.exception("signal_ingested flush failed")


def _prepare(signal: dict) -> tuple[dict, datetime, datetime]:
    """(record, occurred, received) for one signal. A `received_at` already on it (a replayed lake line) is kept, so
    a replay stores the original times. received_at and signal_id go on the signal itself before the DB write, so a
    spill keeps them and replay-lake can tell what is already stored."""
    received = _utc(signal.get("received_at")) or datetime.now(timezone.utc)
    signal["received_at"] = received.isoformat()
    signal.setdefault("signal_id", uuid.uuid4().hex)
    occurred = _occurred_at(signal.get("timestamp"), received)
    return {**signal, "timestamp": occurred.isoformat()}, occurred, received


async def _store_group(component: str, items: list[tuple[dict, datetime, datetime]]) -> list:
    """The Work Item row of each signal, or None where it failed. A Postgres outage holds the group until the DB is
    back (see _persist_until_stored). A non-transient failure of a group retries its signals one at a time, so one
    bad signal does not take its neighbours down."""
    try:
        return [await _persist_until_stored(component, items)] * len(items)
    except Exception:
        if len(items) == 1:
            logger.exception("Signal persistence failed for %s", component)
            return [None]
    return [(await _store_group(component, [item]))[0] for item in items]


async def process_batch(signals: list[dict]) -> list[str | None]:
    """Persist signals with one transaction per component, append them to the lake audit log, and return each
    signal's Work Item id in order (None where it failed: its lake line has work_item_id=None, for replay-lake)."""
    started = time.perf_counter()
    groups: dict[str, list[tuple[dict, dict, datetime, datetime]]] = {}
    for signal in signals:
        groups.setdefault(signal.get("component_id") or "UNKNOWN", []).append((signal, *_prepare(signal)))

    for component, members in groups.items():
        rows = await _store_group(component, [(record, o, r) for _, record, o, r in members])
        ok = sum(wi is not None for wi in rows)
        metrics.SIGNALS_PROCESSED.labels(outcome="ok").inc(ok)
        metrics.SIGNALS_PROCESSED.labels(outcome="failed").inc(len(rows) - ok)
        incidents = {}  # one set of side effects per incident: the row that created it, if any
        for (signal, *_), wi in zip(members, rows):
            if wi is not None:
                signal["_work_item_id"] = wi.id  # committed: a spill after this point still names its incident
                if wi.id not in incidents or wi.created:
                    incidents[wi.id] = wi
        for wi in incidents.values():
            await _after_commit(wi, component, members[0][1].get("component_type"))
        for signal, *_ in members:
            signal["_in_lake"] = True  # before the await: a cancel mid-write must not make the worker spill it again
        await append_signals(component, [{**record, "work_item_id": wi.id if wi is not None else None}
                                         for (_, record, *_), wi in zip(members, rows)])

    elapsed = time.perf_counter() - started
    metrics.INGEST_BATCH_SIZE.observe(len(signals))
    for _ in signals:  # per signal: the time from pick-up to stored, which the dashboard's p50/p95 chart
        metrics.SIGNAL_PROCESSING.observe(elapsed)
    return [s.get("_work_item_id") for s in signals]


async def process_signal(signal: dict) -> str | None:
    """Persist one signal (a batch of one). Returns its Work Item id, or None if it failed."""
    return (await process_batch([signal]))[0]


async def _spill(signal: dict):
    """Write a signal the worker could not finish straight to the lake audit log during shutdown: with its incident
    id when the DB commit already happened, and not at all when its lake line was already being written."""
    global _spilled
    if signal.get("_in_lake"):
        return
    _spilled += 1
    clean = {k: v for k, v in signal.items() if not k.startswith("_")}
    clean.setdefault("received_at", datetime.now(timezone.utc).isoformat())  # never started: replay needs both
    clean.setdefault("signal_id", uuid.uuid4().hex)
    await append_signal({**clean, "work_item_id": signal.get("_work_item_id")})


async def already_stored(line: dict) -> bool:
    """True when the signal of a lake line is in Postgres (replay-lake's dedupe): same component and received_at
    (indexed), and the same signal_id. Several worker processes can stamp one received_at on different signals.
    A line written before signal_id existed matches on component and received_at alone."""
    received = _utc(line.get("received_at"))
    if received is None:
        return False
    query = select(Signal.id).where(Signal.component == (line.get("component_id") or "UNKNOWN"),
                                    Signal.received_at == received)
    if line.get("signal_id"):
        query = query.where(Signal.payload["signal_id"].astext == line["signal_id"])
    async with AsyncSessionLocal() as db:
        return (await db.execute(query.limit(1))).first() is not None


async def _worker():
    """Wait for a signal, then take whatever else is already queued (up to INGEST_BATCH_MAX). No timer: an idle
    signal is stored at once, and under a storm batches form by themselves."""
    global _processed_count
    while True:
        batch = [await _queue.get()]
        while len(batch) < INGEST_BATCH_MAX and not _queue.empty():
            batch.append(_queue.get_nowait())
        metrics.QUEUE_DEPTH.set(_queue.qsize())
        try:
            await process_batch(batch)
            _processed_count += len(batch)
        except asyncio.CancelledError:
            for signal in batch:  # shutdown hit mid-batch: keep what is not in the lake yet in the audit log
                await _spill(signal)
            raise
        except Exception:
            logger.exception("Worker failed on a batch of %d signals", len(batch))
        finally:
            for _ in batch:
                _queue.task_done()


def _throughput_line(processed: int, elapsed: float, depth: int, cap: int) -> str | None:
    """The log line for one interval, or None when this process was idle (nothing done, nothing queued)."""
    if processed == 0 and depth == 0:
        return None
    rate = processed / elapsed if elapsed > 0 else 0
    return f"THROUGHPUT pid={os.getpid()}: {rate:.1f} sig/sec | q={depth}/{cap} | total={processed}"


async def _metrics_printer():
    # Per process: each uvicorn worker has its own queue and counters, hence the pid in the line.
    global _processed_count, _last_metric_time
    while True:
        await asyncio.sleep(5)
        now = time.monotonic()
        line = _throughput_line(_processed_count, now - _last_metric_time, _queue.qsize(), _queue.maxsize)
        if line:
            logger.info(line)
        _processed_count = 0
        _last_metric_time = now


async def start_ingestion_workers(num_workers: int | None = None):
    global _accepting
    _accepting = True
    metrics.QUEUE_CAPACITY.set(_queue.maxsize)
    metrics.INGEST_DB_DOWN.set(int(_db_down))  # the series exists from the start
    n = num_workers or settings.ingestion_workers
    _tasks.extend(asyncio.create_task(_worker()) for _ in range(n))
    _tasks.append(asyncio.create_task(_metrics_printer()))
    _tasks.append(asyncio.create_task(_flush_loop()))
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
    try:
        await flush_ingested()  # the last second of drained signals, before the WebSocket manager stops
    except Exception:
        logger.exception("signal_ingested flush failed at shutdown")
    while not _queue.empty():
        await _spill(_queue.get_nowait())
        _queue.task_done()
    if _spilled:
        logger.warning("Spilled %d unprocessed signals to the data lake", _spilled)
    return _spilled
