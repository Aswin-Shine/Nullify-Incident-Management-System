"""Ingestion: debounce into one active incident, linked signals, timeseries, lake audit.

Debounce rule: every signal for a component joins that component's single OPEN/INVESTIGATING
Work Item; once it is RESOLVED the next signal opens a new one. No signal is dropped.
"""
import asyncio
import json
import glob
import os
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError, OperationalError

from app.core.config import get_settings
from app.db.postgres import AsyncSessionLocal, Signal, TimeseriesAgg, WorkItem
from app.services.ingestion import process_signal

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]


def sig(component="CACHE_CLUSTER_01", ts=None, **extra):
    return {"component_id": component, "signal_type": "ERROR", "message": "boom",
            "severity": "HIGH", "metadata": {}, "timestamp": ts, **extra}


async def all_work_items():
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(WorkItem).order_by(WorkItem.created_at))).scalars().all()


async def set_status(wi_id, status):
    async with AsyncSessionLocal() as db:
        await db.execute(update(WorkItem).where(WorkItem.id == wi_id).values(status=status))
        await db.commit()


def lake_lines(component):
    lines = []  # the lake keeps one folder per UTC day
    for path in sorted(glob.glob(os.path.join(get_settings().lake_dir, "*", f"{component}.jsonl"))):
        with open(path) as f:
            lines += [json.loads(line) for line in f.read().splitlines()]
    return lines


@pytest.mark.parametrize("component,priority", [("RDBMS_PRIMARY", "P0"), ("CACHE_CLUSTER_01", "P2")])
async def test_first_signal_opens_work_item_with_strategy_priority(component, priority):
    wi_id = await process_signal(sig(component))

    [wi] = await all_work_items()
    assert (wi.id, wi.component, wi.status, wi.priority, wi.signal_count) == \
           (wi_id, component, "OPEN", priority, 1)


async def test_100_signals_same_component_make_one_work_item():
    ids = {await process_signal(sig()) for _ in range(100)}

    [wi] = await all_work_items()
    assert ids == {wi.id}
    assert wi.signal_count == 100


async def test_100_concurrent_signals_make_exactly_one_work_item():
    # Each call uses its own session/connection, like separate workers or processes.
    ids = await asyncio.gather(*(process_signal(sig()) for _ in range(100)))

    [wi] = await all_work_items()
    assert set(ids) == {wi.id}
    assert wi.signal_count == 100


async def test_signal_after_resolve_opens_new_work_item():
    """Regression for B-00: the old in-memory window never expired."""
    first = await process_signal(sig())
    await process_signal(sig())
    await set_status(first, "RESOLVED")

    second = await process_signal(sig())

    assert second != first
    old, new = await all_work_items()
    assert (old.id, old.status, old.signal_count) == (first, "RESOLVED", 2)
    assert (new.id, new.status, new.signal_count) == (second, "OPEN", 1)


async def test_every_signal_is_stored_and_linked():
    ids = {await process_signal(sig()) for _ in range(20)}

    async with AsyncSessionLocal() as db:
        linked = (await db.execute(select(Signal.work_item_id))).scalars().all()
    assert len(ids) == 1
    assert linked == [ids.pop()] * 20


async def test_signals_endpoint_returns_only_that_incidents_signals(client, make_headers):
    """Regression for B-12: the endpoint used to return the component's whole history."""
    headers = await make_headers("viewer")
    old = None
    for _ in range(3):
        old = await process_signal(sig(message="old outage"))
    await set_status(old, "RESOLVED")
    new = await process_signal(sig(message="new outage"))

    r = await client.get(f"/api/work-items/{old}/signals", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 3
    assert {s["message"] for s in body} == {"old outage"}
    assert {s["work_item_id"] for s in body} == {old}

    r = await client.get(f"/api/work-items/{new}/signals", headers=headers)
    assert [s["message"] for s in r.json()] == ["new outage"]


async def test_start_time_is_earliest_signal_and_future_timestamps_are_clamped():
    t0 = datetime.now(timezone.utc) - timedelta(minutes=10)
    await process_signal(sig(ts=t0 + timedelta(minutes=5)))
    await process_signal(sig(ts=t0.isoformat()))  # happened first, arrived late, as an ISO string
    await process_signal(sig(ts=datetime.now(timezone.utc) + timedelta(days=1)))  # producer clock skew

    [wi] = await all_work_items()
    assert wi.start_time == t0
    assert wi.last_signal_at <= datetime.now(timezone.utc)


async def test_timeseries_counts_accumulate_per_bucket_and_component():
    """Regression for B-04: counts were stuck at 1 (one row per signal)."""
    ts = datetime.now(timezone.utc).replace(second=30, microsecond=0) - timedelta(minutes=1)
    for _ in range(5):
        await process_signal(sig("CACHE_A", ts=ts))
    for _ in range(2):
        await process_signal(sig("QUEUE_B", ts=ts))

    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(TimeseriesAgg.component, func.count(), func.sum(TimeseriesAgg.signal_count))
            .group_by(TimeseriesAgg.component)
        )).all()
    assert sorted(tuple(r) for r in rows) == [("CACHE_A", 1, 5), ("QUEUE_B", 1, 2)]


async def test_timeseries_endpoint_sums_components_per_minute_and_filters_by_component(client, make_headers):
    """Regression: with no component the API returned one row per (minute, component), so the chart drew a bar for each."""
    headers = await make_headers("viewer")
    base = datetime.now(timezone.utc).replace(second=30, microsecond=0)
    older, newer = base - timedelta(minutes=2), base - timedelta(minutes=1)
    fmt = lambda t: t.strftime("%Y-%m-%dT%H:%M")
    for _ in range(3):
        await process_signal(sig("CACHE_A", ts=older))
    for _ in range(2):
        await process_signal(sig("QUEUE_B", ts=older))
    await process_signal(sig("CACHE_A", ts=newer))

    r = await client.get("/api/timeseries", headers=headers)
    assert r.status_code == 200
    assert r.json() == [{"bucket": fmt(newer), "signal_count": 1}, {"bucket": fmt(older), "signal_count": 5}]

    r = await client.get("/api/timeseries?component=CACHE_A", headers=headers)
    assert r.json() == [
        {"bucket": fmt(newer), "component": "CACHE_A", "signal_count": 1},
        {"bucket": fmt(older), "component": "CACHE_A", "signal_count": 3},
    ]


async def test_alert_fires_once_per_new_incident_not_per_signal(mock_webhooks):
    for _ in range(10):
        await process_signal(sig("RDBMS_PRIMARY"))
    await asyncio.sleep(0)  # the webhook runs as a background task

    assert mock_webhooks["created"].call_count == 1


async def test_raw_signal_goes_to_lake_under_settings_dir_with_work_item_id():
    """Regression for B-02: the lake ignored settings.lake_dir."""
    wi_id = await process_signal(sig("CACHE_LAKE"))

    [line] = lake_lines("CACHE_LAKE")
    assert line["work_item_id"] == wi_id
    assert line["message"] == "boom"


async def test_new_incident_visible_in_cached_list_immediately(client, make_headers):
    """Regression for B-09: ingestion-created incidents never invalidated the list cache."""
    headers = await make_headers("viewer")
    r = await client.get("/api/work-items", headers=headers)
    assert r.json()["items"] == []  # primes the Redis list cache

    wi_id = await process_signal(sig())

    r = await client.get("/api/work-items", headers=headers)
    assert [w["id"] for w in r.json()["items"]] == [wi_id]


def _upsert_failing(times, exc):
    """Wrap the real upsert so the first `times` calls fail with `exc`."""
    from app.services.work_item_service import upsert_active_work_item as real
    calls = []

    async def upsert(*args, **kwargs):
        calls.append(1)
        if len(calls) <= times:
            raise exc
        return await real(*args, **kwargs)
    return upsert, calls


async def test_transient_db_error_is_retried_without_double_counting():
    """Regression for B-11: a Postgres blip used to drop the signal's incident and timeseries."""
    upsert, calls = _upsert_failing(2, OperationalError("stmt", {}, Exception("connection reset")))
    with patch("app.services.ingestion.upsert_active_work_item", side_effect=upsert):
        wi_id = await process_signal(sig("CACHE_RETRY"))

    assert len(calls) == 3
    [wi] = await all_work_items()
    assert (wi.id, wi.signal_count) == (wi_id, 1)  # failed attempts rolled back fully
    async with AsyncSessionLocal() as db:
        assert (await db.execute(select(func.count()).select_from(Signal))).scalar_one() == 1
    [line] = lake_lines("CACHE_RETRY")
    assert line["work_item_id"] == wi_id


async def test_retries_give_up_and_audit_log_keeps_signal():
    upsert, calls = _upsert_failing(99, OperationalError("stmt", {}, Exception("db down")))
    with patch("app.services.ingestion.upsert_active_work_item", side_effect=upsert):
        assert await process_signal(sig("CACHE_RETRY_DOWN")) is None

    assert len(calls) == get_settings().db_retry_attempts
    [line] = lake_lines("CACHE_RETRY_DOWN")
    assert line["work_item_id"] is None


async def test_integrity_error_is_not_retried():
    upsert, calls = _upsert_failing(99, IntegrityError("stmt", {}, Exception("duplicate")))
    with patch("app.services.ingestion.upsert_active_work_item", side_effect=upsert):
        assert await process_signal(sig("CACHE_INTEGRITY")) is None

    assert len(calls) == 1


async def test_db_failure_still_writes_audit_log_and_does_not_raise():
    with patch("app.services.ingestion.upsert_active_work_item", side_effect=RuntimeError("db down")):
        assert await process_signal(sig("CACHE_DB_DOWN")) is None

    [line] = lake_lines("CACHE_DB_DOWN")
    assert line["work_item_id"] is None


async def test_new_incident_broadcasts_work_item_created_once():
    with patch("app.services.ingestion.manager.broadcast", new_callable=AsyncMock) as broadcast:
        wi_id = await process_signal(sig("RDBMS_PRIMARY"))
        await process_signal(sig("RDBMS_PRIMARY"))
        await process_signal(sig("CACHE_OTHER"))

    created = [c.args[0] for c in broadcast.call_args_list if c.args[0]["event"] == "work_item_created"]
    assert len(created) == 2  # one per incident, not per signal
    assert created[0] == {"event": "work_item_created", "id": wi_id, "component": "RDBMS_PRIMARY", "priority": "P0"}
    assert created[1]["component"] == "CACHE_OTHER" and created[1]["priority"] == "P2"


async def test_created_event_is_broadcast_after_commit():
    seen = []

    async def spy(event):
        seen.append(len(await all_work_items()))  # a fresh session sees only committed rows

    with patch("app.services.ingestion.manager.broadcast", side_effect=spy):
        await process_signal(sig("RDBMS_PRIMARY"))

    assert seen == [1, 1]  # work_item_created, then signal_ingested: both after the commit


# -- B-32: the signal is announced once it is saved, and the detail cache follows it ------------

async def test_detail_cache_is_dropped_when_a_signal_joins_an_existing_incident(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    assert (await client.get(f"/api/work-items/{wi_id}", headers=headers)).json()["signal_count"] == 1  # primes the cache

    await process_signal(sig())

    assert (await client.get(f"/api/work-items/{wi_id}", headers=headers)).json()["signal_count"] == 2


async def test_each_saved_signal_is_broadcast_with_its_incident_id():
    wi_id = await process_signal(sig("RDBMS_PRIMARY"))
    with patch("app.services.ingestion.manager.broadcast", new_callable=AsyncMock) as broadcast:
        await process_signal(sig("RDBMS_PRIMARY"))

    broadcast.assert_awaited_once_with({"event": "signal_ingested", "id": wi_id, "component": "RDBMS_PRIMARY"})


async def test_posting_a_signal_does_not_broadcast_before_it_is_saved(client, make_headers):
    with patch("app.services.ws_manager.manager.broadcast", new_callable=AsyncMock) as broadcast:
        r = await client.post("/api/signals", json={"component_id": "CACHE_Q", "signal_type": "ERROR", "message": "x"},
                              headers=await make_headers("sre"))

    assert r.status_code == 202
    broadcast.assert_not_awaited()


async def test_batch_signals_carry_the_source_ip(client, make_headers):
    with patch("app.routers.signals.ingestion.enqueue_signal", new_callable=AsyncMock, return_value=True) as enqueue:
        r = await client.post("/api/signals/batch",
                              json=[{"component_id": "CACHE_Q", "signal_type": "ERROR", "message": "x"}],
                              headers=await make_headers("sre"))

    assert r.status_code == 202
    assert enqueue.call_args.args[0]["source_ip"]
