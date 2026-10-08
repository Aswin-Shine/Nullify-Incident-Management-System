"""Code-review fixes (2026-10-04) and the production basics: 404s, a stale detail cache, racing assigns,
case-insensitive accounts, the SLA breach rate, encoded DB/Redis passwords, dead workers' metric files,
lake lines written twice on shutdown, and signal retention."""
import asyncio
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.engine import make_url

from app.core.config import Settings, get_settings
from app.core.security import create_access_token
from app.db.postgres import AsyncSessionLocal, Signal, TimeseriesAgg, WorkItem, WorkItemEvent
from app.services import ingestion, work_item_service
from app.services.ingestion import process_signal
from app.services.work_item_service import ConflictError

UNKNOWN = "00000000-0000-0000-0000-000000000000"


def sig(component="CACHE_RV", **extra):
    return {"component_id": component, "signal_type": "ERROR", "message": "down", "severity": "HIGH", "metadata": {}, **extra}


def bearer(user):
    return {"Authorization": f"Bearer {create_access_token({'sub': user['id'], 'role': user['role'], 'tv': 0})}"}


async def set_cols(wi_id, **values):
    async with AsyncSessionLocal() as db:
        await db.execute(update(WorkItem).where(WorkItem.id == wi_id).values(**values))
        await db.commit()


# -- 404 for an unknown incident ----------------------------------------------------

@pytest.mark.usefixtures("clean_state")
async def test_every_route_answers_404_for_an_unknown_incident(client, make_headers):
    h = await make_headers("sre")
    rca = {"incident_start": "2026-01-01T10:00:00Z", "incident_end": "2026-01-01T11:00:00Z",
           "root_cause_category": "Infrastructure Failure", "fix_applied": "x", "prevention_steps": "y"}
    calls = [
        client.patch(f"/api/work-items/{UNKNOWN}/status", json={"new_status": "INVESTIGATING"}, headers=h),
        client.patch(f"/api/work-items/{UNKNOWN}/assign", json={"assignee_id": None}, headers=h),
        client.post(f"/api/work-items/{UNKNOWN}/rca", json=rca, headers=h),
        client.post(f"/api/work-items/{UNKNOWN}/comments", json={"body": "hi"}, headers=h),
        client.get(f"/api/work-items/{UNKNOWN}/comments", headers=h),
    ]
    assert [(await c).status_code for c in calls] == [404] * 5


# -- The detail cache cannot be refilled with data from before a write ----------------

@pytest.mark.usefixtures("clean_state")
async def test_a_slow_read_cannot_cache_the_status_from_before_a_transition(make_user):
    sre = await make_user("sre")
    wi_id = await process_signal(sig("CACHE_STALE"))
    real_set = work_item_service.cache.set_val
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused_set(key, value, ttl=60):
        reached.set()
        await release.wait()
        await real_set(key, value, ttl=ttl)

    with patch.object(work_item_service.cache, "set_val", paused_set):
        async with AsyncSessionLocal() as db:
            slow = asyncio.create_task(work_item_service.get_work_item(wi_id, db))
            await reached.wait()  # the slow read has OPEN in hand
            async with AsyncSessionLocal() as db2:
                await work_item_service.transition_status(wi_id, "INVESTIGATING", db2, sre["id"])
            release.set()
            assert (await slow).status == "OPEN"

    async with AsyncSessionLocal() as db:
        assert (await work_item_service.get_work_item(wi_id, db)).status == "INVESTIGATING"


# -- Assigning: no changes to a closed incident, no lost concurrent change -------------

@pytest.mark.usefixtures("clean_state")
async def test_a_closed_incident_cannot_be_reassigned(client, make_user):
    sre = await make_user("sre")
    wi_id = await process_signal(sig("CACHE_DONE"))
    await set_cols(wi_id, status="CLOSED")

    r = await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": sre["id"]}, headers=bearer(sre))

    assert r.status_code == 409


@pytest.mark.usefixtures("clean_state")
async def test_two_racing_assigns_give_one_winner_and_one_conflict(make_user):
    a, b = await make_user("sre"), await make_user("sre")
    wi_id = await process_signal(sig("CACHE_RACE"))

    async def assign(user):
        async with AsyncSessionLocal() as db:
            return await work_item_service.assign_work_item(wi_id, user["id"], db, user["id"])

    async with AsyncSessionLocal() as locker:  # both contenders read "unassigned", then queue on the row lock
        await locker.execute(select(WorkItem).where(WorkItem.id == wi_id).with_for_update())
        tasks = [asyncio.create_task(assign(a)), asyncio.create_task(assign(b))]
        await asyncio.sleep(0.3)
        await locker.commit()
    results = await asyncio.gather(*tasks, return_exceptions=True)

    assert sorted(type(r).__name__ for r in results) == ["ConflictError", "WorkItemResponse"]
    async with AsyncSessionLocal() as db:
        events = (await db.execute(select(func.count()).select_from(WorkItemEvent)
                                   .where(WorkItemEvent.work_item_id == wi_id, WorkItemEvent.kind == "assigned"))).scalar()
    assert events == 1


@pytest.mark.usefixtures("clean_state")
async def test_the_assign_route_maps_a_lost_race_to_409(client, make_user):
    sre = await make_user("sre")
    wi_id = await process_signal(sig("CACHE_RACE2"))
    with patch.object(work_item_service, "assign_work_item", side_effect=ConflictError("changed meanwhile")):
        r = await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": sre["id"]}, headers=bearer(sre))
    assert r.status_code == 409


# -- Accounts: names and emails are unique regardless of case ------------------------

@pytest.mark.usefixtures("clean_state")
@pytest.mark.parametrize("second", [
    {"username": "Alice", "email": "other@example.com"},
    {"username": "someone", "email": "ALICE@example.com"},
])
async def test_a_name_or_email_that_differs_only_in_case_is_taken(client, make_user, second):
    admin = await make_user("admin")
    first = {"username": "alice", "email": "alice@example.com", "password": "a-long-enough-password", "role": "sre"}
    assert (await client.post("/api/auth/users", json=first, headers=bearer(admin))).status_code == 201

    r = await client.post("/api/auth/users", json={**first, **second}, headers=bearer(admin))

    assert r.status_code == 400


@pytest.mark.usefixtures("clean_state")
async def test_two_concurrent_creates_of_one_name_give_400_not_500():
    from app.models.schemas import UserCreate
    from app.services.user_service import create_account

    data = UserCreate(username="twin", email="twin@example.com", password="a-long-enough-password", role="sre")

    async def create():
        async with AsyncSessionLocal() as db:
            return await create_account(db, data, created_by="test")

    results = await asyncio.gather(create(), create(), return_exceptions=True)

    assert sorted(type(r).__name__ for r in results) == ["User", "ValueError"]


# -- SLA breach rate ------------------------------------------------------------------

@pytest.mark.usefixtures("clean_state")
async def test_sla_breach_rate_counts_incidents_resolved_late():
    now = datetime.now(timezone.utc)
    ids = [await process_signal(sig(f"CACHE_SLA{i}")) for i in range(4)]
    await set_cols(ids[0], status="RESOLVED", sla_deadline=now - timedelta(hours=2), resolved_at=now - timedelta(hours=1))
    await set_cols(ids[1], status="CLOSED", sla_deadline=now - timedelta(hours=2), resolved_at=now - timedelta(hours=1))
    await set_cols(ids[2], status="RESOLVED", sla_deadline=now - timedelta(hours=1), resolved_at=now - timedelta(hours=2))
    await set_cols(ids[3], status="OPEN", sla_deadline=now - timedelta(minutes=5))

    async with AsyncSessionLocal() as db:
        stats = await work_item_service.get_sla_stats(db)

    assert (stats.breached, stats.total, stats.breach_rate_pct) == (3, 4, 75.0)


# -- Passwords with URL characters ------------------------------------------------------

def test_db_and_redis_passwords_are_url_encoded():
    from urllib.parse import unquote, urlparse

    s = Settings(db_password="p@ss/w:rd%", redis_password="r@d/s:x", db_host="db.internal", redis_host="cache.internal")

    for url in (s.database_url, s.database_url_sync):
        parsed = make_url(url)
        assert (parsed.password, parsed.host) == ("p@ss/w:rd%", "db.internal")
    r = urlparse(s.redis_url)
    assert (unquote(r.password), r.hostname) == ("r@d/s:x", "cache.internal")


# -- Metric files of dead workers ------------------------------------------------------

def test_a_dead_workers_live_gauge_is_no_longer_counted(tmp_path):
    from prometheus_client import CollectorRegistry
    from prometheus_client.multiprocess import MultiProcessCollector

    from app.core.metrics import forget_dead_workers

    # A worker that registered 5 sockets and then died (its process is gone, its file stays).
    child = "from prometheus_client import Gauge; Gauge('ws', 'x', multiprocess_mode='livesum').set(5)"
    subprocess.run([sys.executable, "-c", child], env={**os.environ, "PROMETHEUS_MULTIPROC_DIR": str(tmp_path)}, check=True)

    def total():
        registry = CollectorRegistry()
        MultiProcessCollector(registry, path=str(tmp_path))
        return registry.get_sample_value("ws") or 0

    assert total() == 5
    forget_dead_workers(str(tmp_path))
    assert total() == 0


# -- Shutdown: a signal is written to the lake once ----------------------------------------

@pytest.mark.usefixtures("clean_state")
async def test_a_signal_cancelled_during_its_lake_write_is_not_spilled_again(monkeypatch):
    lines = []

    async def append_then_cancel(component, records):  # the worker's batched lake write
        lines.extend(records)
        raise asyncio.CancelledError  # the worker is cancelled while the write is in flight

    async def spill_write(record):  # a second write would come from the spill
        lines.append(record)

    monkeypatch.setattr(ingestion, "append_signals", append_then_cancel)
    monkeypatch.setattr(ingestion, "append_signal", spill_write)
    await ingestion._queue.put(sig("CACHE_ONCE"))
    worker = asyncio.create_task(ingestion._worker())
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(worker, 5)

    assert len(lines) == 1


@pytest.mark.usefixtures("clean_state")
async def test_a_signal_cancelled_after_its_commit_is_spilled_with_its_incident(monkeypatch):
    lines = []

    async def record_line(record):
        lines.append(record)

    async def cancelled(*a, **k):
        raise asyncio.CancelledError

    monkeypatch.setattr(ingestion, "append_signal", record_line)
    monkeypatch.setattr(ingestion.manager, "broadcast", cancelled)
    await ingestion._queue.put(sig("CACHE_SPILL"))
    worker = asyncio.create_task(ingestion._worker())
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(worker, 5)

    async with AsyncSessionLocal() as db:
        wi_id = (await db.execute(select(WorkItem.id).where(WorkItem.component == "CACHE_SPILL"))).scalar_one()
    assert [line["work_item_id"] for line in lines] == [wi_id]
    assert not any(k.startswith("_") for k in lines[0])


# -- Retention -------------------------------------------------------------------------------

@pytest.mark.usefixtures("clean_state")
async def test_retention_removes_raw_signals_and_lake_days_older_than_the_window(tmp_path, monkeypatch):
    from app.services import retention

    monkeypatch.setattr(get_settings(), "lake_dir", str(tmp_path))
    monkeypatch.setattr(get_settings(), "retention_days", 30)
    now = datetime.now(timezone.utc)
    wi_id = await process_signal(sig("CACHE_OLDDATA"))
    async with AsyncSessionLocal() as db:
        await db.execute(update(Signal).where(Signal.work_item_id == wi_id).values(received_at=now - timedelta(days=31)))
        db.add(TimeseriesAgg(bucket=(now - timedelta(days=31)).strftime("%Y-%m-%dT%H:%M"), component="OLD", signal_count=1))
        await db.commit()
    await process_signal(sig("CACHE_OLDDATA"))  # a fresh signal on the same incident stays
    old_day = tmp_path / (now - timedelta(days=31)).strftime("%Y-%m-%d")
    old_day.mkdir()
    (old_day / "X.jsonl").write_text("{}\n")

    result = await retention.purge(now)

    assert result == {"signals": 1, "timeseries": 1, "lake_days": 1}
    async with AsyncSessionLocal() as db:
        assert (await db.execute(select(func.count()).select_from(Signal).where(Signal.work_item_id == wi_id))).scalar() == 1
        assert (await db.execute(select(func.count()).select_from(WorkItem).where(WorkItem.id == wi_id))).scalar() == 1
    assert not old_day.exists()
    assert (tmp_path / now.strftime("%Y-%m-%d")).exists()


@pytest.mark.usefixtures("clean_state")
async def test_retention_runs_once_a_day_across_workers(tmp_path, monkeypatch):
    from app.services import retention

    monkeypatch.setattr(get_settings(), "lake_dir", str(tmp_path))
    now = datetime.now(timezone.utc)

    first, second = await asyncio.gather(retention.purge(now), retention.purge(now))

    assert sorted([first is None, second is None]) == [False, True]


@pytest.mark.usefixtures("clean_state")
async def test_the_lake_is_split_into_one_folder_per_day(tmp_path, monkeypatch):
    from app.db import nosql

    monkeypatch.setattr(get_settings(), "lake_dir", str(tmp_path))
    await nosql.append_signal({"component_id": "CACHE_DAY", "message": "x"})

    assert (tmp_path / datetime.now(timezone.utc).strftime("%Y-%m-%d") / "CACHE_DAY.jsonl").exists()
