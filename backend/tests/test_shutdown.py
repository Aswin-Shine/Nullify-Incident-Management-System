"""Graceful shutdown: drain the queue, never silently lose an accepted (202) signal."""
import asyncio
import json
import glob
import os

import pytest
from sqlalchemy import func, select
from unittest.mock import AsyncMock, patch

from app.core.config import get_settings
from app.db.postgres import AsyncSessionLocal, Signal
from app.services import ingestion

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]


def sig(component="CACHE_SHUTDOWN"):
    return {"component_id": component, "signal_type": "ERROR", "message": "boom",
            "severity": "HIGH", "metadata": {}, "timestamp": None}


def lake_lines(component):
    lines = []  # the lake keeps one folder per UTC day
    for path in sorted(glob.glob(os.path.join(get_settings().lake_dir, "*", f"{component}.jsonl"))):
        with open(path) as f:
            lines += [json.loads(line) for line in f.read().splitlines()]
    return lines


@pytest.fixture(autouse=True)
async def isolated_pipeline(monkeypatch):
    # Other tests post signals without running the lifespan, so "accepting" must be restored.
    monkeypatch.setattr(ingestion, "_accepting", True)
    yield
    await ingestion.stop_ingestion_workers(timeout=0)


async def test_graceful_stop_drains_every_queued_signal():
    await ingestion.start_ingestion_workers(2)
    for _ in range(30):
        assert await ingestion.enqueue_signal(sig())

    spilled = await ingestion.stop_ingestion_workers(timeout=10)

    assert spilled == 0
    async with AsyncSessionLocal() as db:
        assert (await db.execute(select(func.count()).select_from(Signal))).scalar_one() == 30
    assert not ingestion.accepting()


async def test_drain_timeout_spills_in_flight_and_queued_signals_to_lake():
    """Regression for B-08: shutdown used to drop whatever was still queued, audit log included."""
    async def hang(batch):
        await asyncio.sleep(60)

    with patch("app.services.ingestion.process_batch", side_effect=hang):
        await ingestion.start_ingestion_workers(1)
        for _ in range(3):
            await ingestion.enqueue_signal(sig("CACHE_SPILL"))
        await asyncio.sleep(0.05)  # the worker picks them up as one batch and hangs on it

        spilled = await ingestion.stop_ingestion_workers(timeout=0.2)

    assert spilled == 3
    lines = lake_lines("CACHE_SPILL")
    assert len(lines) == 3
    assert all(line["work_item_id"] is None for line in lines)
    assert all(line["received_at"] for line in lines)  # replay-lake dedupes on it


async def test_shutdown_spills_signal_stuck_in_outage_with_null_id(monkeypatch):
    from sqlalchemy.exc import OperationalError
    monkeypatch.setattr(ingestion, "_db_down", False)  # restored at teardown, the worker leaves it open
    monkeypatch.setattr(ingestion.settings, "db_retry_base_delay", 0.001)
    monkeypatch.setattr(ingestion, "OUTAGE_BACKOFF", (0.01,))
    down = OperationalError("stmt", {}, Exception("db down"))
    with patch("app.services.ingestion.upsert_active_work_item", side_effect=down):
        await ingestion.start_ingestion_workers(1)
        await ingestion.enqueue_signal(sig("CACHE_STUCK"))
        await asyncio.sleep(0.1)  # the worker is now looping on the outage
        assert not ingestion.db_available()

        spilled = await ingestion.stop_ingestion_workers(timeout=0.1)

    assert spilled == 1
    [line] = lake_lines("CACHE_STUCK")
    assert line["work_item_id"] is None


async def test_ingest_returns_503_while_shutting_down(client, make_headers):
    headers = await make_headers("sre")
    await ingestion.start_ingestion_workers(1)
    await ingestion.stop_ingestion_workers(timeout=1)

    r = await client.post("/api/signals", json=sig(), headers=headers)

    assert r.status_code == 503


async def test_shutdown_drains_webhooks_after_ingestion():
    """The ingest drain can still open incidents and spawn pages, so the webhook drain must come after it."""
    from app import main
    order = []

    async def step(name, result=None):
        order.append(name)
        return result

    with patch.object(main, "init_redis", AsyncMock()), patch.object(main, "close_redis", AsyncMock()), \
         patch.object(main.manager, "start", AsyncMock()), patch.object(main.manager, "stop", AsyncMock()), \
         patch.object(main, "start_ingestion_workers", AsyncMock()), \
         patch.object(main.metrics, "refresh_loop", AsyncMock()), \
         patch.object(main.retention, "retention_loop", AsyncMock()), \
         patch.object(main, "stop_ingestion_workers", lambda timeout: step("ingestion", 0)), \
         patch.object(main.webhooks, "drain", lambda timeout: step("webhooks", 0)):
        async with main.lifespan(main.app):
            pass

    assert order == ["ingestion", "webhooks"]
