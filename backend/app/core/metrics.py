"""App metrics (PRD OPS-2), scraped by Prometheus at /metrics next to the HTTP metrics of the instrumentator.

The container runs 4 uvicorn workers. With PROMETHEUS_MULTIPROC_DIR set (docker-compose.yml), every worker writes its
values to that directory and /metrics adds them up, so one scrape covers all workers. Gauges therefore say how
workers combine: `livesum` for sockets, `livemax` for the queue (the fullest one matters), `max` for values
every worker reads from the DB or config.
Without the env var (local dev, tests) this is the ordinary single-process registry.
"""
from __future__ import annotations
import asyncio
import logging

from prometheus_client import Counter, Gauge, Histogram

logger = logging.getLogger("ims.metrics")
PRIORITIES = ("P0", "P1", "P2", "P3")

SIGNALS_RECEIVED = Counter("nullify_signals_received", "Signals accepted into the ingest queue")
SIGNALS_REJECTED = Counter("nullify_signals_rejected", "Signals turned away", ["reason"])
SIGNALS_PROCESSED = Counter("nullify_signals_processed", "Signals taken off the queue", ["outcome"])
SIGNAL_PROCESSING = Histogram("nullify_signal_processing_seconds", "Time to store one signal",
                              buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5))
# The deepest worker queue, not the sum: a 429 happens when any one worker's queue is full.
QUEUE_DEPTH = Gauge("nullify_ingest_queue_depth", "Signals waiting in the deepest worker queue", multiprocess_mode="livemax")
QUEUE_CAPACITY = Gauge("nullify_ingest_queue_capacity", "Capacity of one worker's ingest queue", multiprocess_mode="max")
INCIDENTS_CREATED = Counter("nullify_incidents_created", "Incidents opened by ingestion", ["priority"])
TRANSITIONS = Counter("nullify_incident_transitions", "Status changes, by the status moved to", ["to"])
OPEN_INCIDENTS = Gauge("nullify_open_incidents", "OPEN and INVESTIGATING incidents", ["priority"], multiprocess_mode="max")
WS_CONNECTIONS = Gauge("nullify_websocket_connections", "Live dashboard WebSockets", multiprocess_mode="livesum")
DB_RETRIES = Counter("nullify_db_retries", "Retries of a DB write after a transient error")

for _p in PRIORITIES:  # every series exists from the start, so dashboards and rate() see zeros, not gaps
    INCIDENTS_CREATED.labels(priority=_p)
SIGNALS_REJECTED.labels(reason="queue_full")
for _s in ("INVESTIGATING", "RESOLVED", "CLOSED"):
    TRANSITIONS.labels(to=_s)
for _o in ("ok", "failed"):
    SIGNALS_PROCESSED.labels(outcome=_o)


async def refresh_open_incidents():
    """Set the open-incident gauge from Postgres (one GROUP BY), with 0 for priorities that have none."""
    from app.db.postgres import AsyncSessionLocal
    from app.services.work_item_service import open_counts_by_priority  # here: work_item_service imports this module

    async with AsyncSessionLocal() as db:
        counts = await open_counts_by_priority(db)
    for p in PRIORITIES:
        OPEN_INCIDENTS.labels(priority=p).set(counts.get(p, 0))


async def refresh_loop(interval: float = 30):
    """Keep the open-incident gauge current. A failed refresh keeps the last value and tries again."""
    while True:
        try:
            await refresh_open_incidents()
        except Exception as e:  # a down DB must not kill the loop; the PostgresDown alert covers it
            logger.warning("Open-incident gauge refresh failed: %s", e)
        await asyncio.sleep(interval)
