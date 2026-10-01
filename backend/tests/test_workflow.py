"""Workflow: race-free transitions, MTTR per spec, RCA immutability, side effects after commit."""
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import func, select, update

from app.db.postgres import AsyncSessionLocal, RCARecord, User, WorkItem
from app.models.schemas import WorkItemCreate
from app.services.ingestion import process_signal
from app.services.state_machine import InvalidTransitionError
from app.services.work_item_service import ConflictError, create_work_item, transition_status

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]

RCA = {
    "incident_start": "2026-01-01T10:00:00Z",
    "incident_end": "2026-01-01T12:00:00Z",
    "root_cause_category": "Infrastructure Failure",
    "fix_applied": "Restarted the primary",
    "prevention_steps": "Automated failover",
}


def sig(component="RDBMS_PRIMARY", ts=None):
    return {"component_id": component, "signal_type": "ERROR", "message": "down",
            "severity": "CRITICAL", "metadata": {}, "timestamp": ts}


async def set_status(wi_id, status):
    async with AsyncSessionLocal() as db:
        await db.execute(update(WorkItem).where(WorkItem.id == wi_id).values(status=status))
        await db.commit()


async def committed(column, wi_id):
    """Read a value in a fresh session: only committed data is visible."""
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(column).where(WorkItem.id == wi_id))).scalar_one()


async def test_concurrent_identical_transitions_exactly_one_wins():
    wi_id = await process_signal(sig())

    async def attempt():
        async with AsyncSessionLocal() as db:
            try:
                await transition_status(wi_id, "INVESTIGATING", db)
                await db.commit()
                return "ok"
            except (ConflictError, InvalidTransitionError):
                return "rejected"

    # Hold the row so all five read OPEN and queue on the lock; otherwise the first attempt
    # finishes before the others have even connected and the race never happens.
    async with AsyncSessionLocal() as blocker:
        await blocker.execute(select(WorkItem.id).where(WorkItem.id == wi_id).with_for_update())
        attempts = [asyncio.create_task(attempt()) for _ in range(5)]
        await asyncio.sleep(0.5)
        await blocker.rollback()
    results = await asyncio.gather(*attempts)

    assert results.count("ok") == 1
    assert results.count("rejected") == 4


async def test_transition_validated_against_stale_status_returns_409(client, make_headers):
    """Regression for B-07: the write never re-checked the status it validated against."""
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())

    async with AsyncSessionLocal() as other:
        # Another request moves the item first and holds the row until it commits.
        await other.execute(update(WorkItem).where(WorkItem.id == wi_id).values(status="INVESTIGATING"))
        request = asyncio.create_task(client.patch(
            f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=headers))
        await asyncio.sleep(0.3)  # our request reads OPEN, validates, then blocks on the row lock
        await other.commit()

    r = await request
    assert r.status_code == 409


async def test_status_transitions_do_not_set_mttr(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())

    for status in ("INVESTIGATING", "RESOLVED"):
        r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": status}, headers=headers)
        assert r.status_code == 200

    assert r.json()["end_time"] is None
    assert r.json()["mttr_seconds"] is None


async def test_mttr_runs_from_first_signal_to_rca_submission(client, make_headers):
    """Regression for B-05: MTTR was measured to the RESOLVED/CLOSED click instead."""
    headers = await make_headers("sre")
    first_signal = datetime.now(timezone.utc) - timedelta(hours=2)
    wi_id = await process_signal(sig(ts=first_signal))
    await set_status(wi_id, "RESOLVED")

    r = await client.post(f"/api/work-items/{wi_id}/rca", json=RCA, headers=headers)
    assert r.status_code == 200
    submitted_at = datetime.fromisoformat(r.json()["submitted_at"])

    wi = (await client.get(f"/api/work-items/{wi_id}", headers=headers)).json()
    assert datetime.fromisoformat(wi["end_time"]) == submitted_at
    assert wi["mttr_seconds"] == int((submitted_at - first_signal).total_seconds())


async def test_rca_is_immutable_after_close(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    await set_status(wi_id, "RESOLVED")
    assert (await client.post(f"/api/work-items/{wi_id}/rca", json=RCA, headers=headers)).status_code == 200
    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "CLOSED"}, headers=headers)
    assert r.status_code == 200

    r = await client.post(f"/api/work-items/{wi_id}/rca", json={**RCA, "fix_applied": "rewritten"}, headers=headers)

    assert r.status_code == 409


async def test_status_change_side_effects_run_after_commit(client, make_headers):
    """Regression for B-09/B-28: broadcast and cache invalidation ran before the commit."""
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    seen = []

    async def spy(*args, **kwargs):
        seen.append(await committed(WorkItem.status, wi_id))

    with patch("app.routers.work_items.manager.broadcast", side_effect=spy), \
         patch("app.db.cache.delete_val", side_effect=spy):
        r = await client.patch(f"/api/work-items/{wi_id}/status",
                               json={"new_status": "INVESTIGATING"}, headers=headers)

    assert r.status_code == 200
    assert seen and set(seen) == {"INVESTIGATING"}


async def test_rca_submission_broadcasts_after_commit(client, make_headers):
    """Also covers B-20: the rca_submitted event had been dropped."""
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    await set_status(wi_id, "RESOLVED")
    events = []

    async def spy(event):
        async with AsyncSessionLocal() as db:
            rca_rows = (await db.execute(
                select(func.count()).select_from(RCARecord).where(RCARecord.work_item_id == wi_id))).scalar_one()
        events.append((event["event"], rca_rows))

    with patch("app.routers.work_items.manager.broadcast", side_effect=spy):
        r = await client.post(f"/api/work-items/{wi_id}/rca", json=RCA, headers=headers)

    assert r.status_code == 200
    assert events == [("rca_submitted", 1)]


async def test_assignment_broadcasts_after_commit(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    async with AsyncSessionLocal() as db:
        assignee = (await db.execute(select(User.id))).scalar_one()
    seen = []

    async def spy(*args, **kwargs):
        seen.append(await committed(WorkItem.assignee_id, wi_id))

    with patch("app.routers.work_items.manager.broadcast", side_effect=spy):
        r = await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": assignee}, headers=headers)

    assert r.status_code == 200
    assert seen == [assignee]


async def test_unassign_clears_the_assignee_and_the_cache(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    async with AsyncSessionLocal() as db:
        assignee = (await db.execute(select(User.id))).scalar_one()
    await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": assignee}, headers=headers)
    assert (await client.get(f"/api/work-items/{wi_id}", headers=headers)).json()["assignee_id"] == assignee

    r = await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": None}, headers=headers)

    assert r.status_code == 200
    assert r.json()["assignee_id"] is None
    assert (await client.get(f"/api/work-items/{wi_id}", headers=headers)).json()["assignee_id"] is None


async def test_sla_stats_open_by_priority_excludes_resolved_and_closed(client, make_headers):
    headers = await make_headers("sre")
    async with AsyncSessionLocal() as db:
        ids = {
            "open_p0": await create_work_item(WorkItemCreate(component="A1", priority="P0", title="a"), db),
            "resolved_p0": await create_work_item(WorkItemCreate(component="A2", priority="P0", title="b"), db),
            "investigating_p1": await create_work_item(WorkItemCreate(component="A3", priority="P1", title="c"), db),
            "closed_p2": await create_work_item(WorkItemCreate(component="A4", priority="P2", title="d"), db),
        }
        await db.commit()
    await set_status(ids["resolved_p0"], "RESOLVED")
    await set_status(ids["investigating_p1"], "INVESTIGATING")
    await set_status(ids["closed_p2"], "CLOSED")

    r = await client.get("/api/work-items/analytics/sla", headers=headers)

    assert r.status_code == 200
    assert r.json()["open_by_priority"] == {"P0": 1, "P1": 1, "P2": 0, "P3": 0}


# -- B-18: keyset pagination, B-09: list cache without KEYS ------------------

async def make_items(priorities):
    """One work item per priority, created in order with distinct created_at."""
    ids = []
    async with AsyncSessionLocal() as db:
        for i, p in enumerate(priorities):
            ids.append(await create_work_item(WorkItemCreate(component=f"C{i}", priority=p, title=f"t{i}"), db))
            await db.commit()
    return ids


async def walk(client, headers, **params):
    """Follow next_cursor to the end. Returns the pages (each a list of ids) and every cursor seen."""
    pages, cursors, cursor = [], [], None
    while True:
        q = {**params, **({"cursor": cursor} if cursor else {})}
        r = await client.get("/api/work-items", params=q, headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()
        pages.append([i["id"] for i in body["items"]])
        cursor = body["next_cursor"]
        if cursor is None:
            return pages, cursors
        cursors.append(cursor)


async def test_list_is_paginated_by_keyset_without_overlap_or_gaps(client, make_headers):
    headers = await make_headers("viewer")
    ids = await make_items(["P1", "P0", "P2", "P0", "P1"])

    pages, cursors = await walk(client, headers, limit=2)

    assert [len(p) for p in pages] == [2, 2, 1]
    flat = [i for p in pages for i in p]
    assert len(set(flat)) == 5 and set(flat) == set(ids)
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(select(WorkItem.id, WorkItem.priority, WorkItem.created_at))).all()
    newest_first = sorted(rows, key=lambda r: (r.created_at, r.id), reverse=True)
    assert flat == [r.id for r in sorted(newest_first, key=lambda r: r.priority)]  # stable: priority, then newest
    assert all(isinstance(c, str) and c for c in cursors)


async def test_limit_is_clamped_and_a_bad_cursor_is_422(client, make_headers):
    headers = await make_headers("viewer")
    await make_items(["P0", "P1", "P2"])

    low = await client.get("/api/work-items", params={"limit": 0}, headers=headers)
    high = await client.get("/api/work-items", params={"limit": 99999}, headers=headers)
    garbage = await client.get("/api/work-items", params={"cursor": "not-a-cursor"}, headers=headers)
    bad_json = await client.get("/api/work-items", params={"cursor": "e30"}, headers=headers)  # base64 of {}

    assert len(low.json()["items"]) == 1 and low.json()["next_cursor"] is not None
    assert high.status_code == 200 and len(high.json()["items"]) == 3 and high.json()["next_cursor"] is None
    assert garbage.status_code == 422
    assert bad_json.status_code == 422


async def test_status_filter_and_pagination_work_together(client, make_headers):
    headers = await make_headers("viewer")
    ids = await make_items(["P0", "P1", "P2", "P3"])
    await set_status(ids[0], "INVESTIGATING")
    await set_status(ids[2], "INVESTIGATING")
    await set_status(ids[3], "INVESTIGATING")

    pages, _ = await walk(client, headers, status="INVESTIGATING", limit=2)

    assert [len(p) for p in pages] == [2, 1]
    assert {i for p in pages for i in p} == {ids[0], ids[2], ids[3]}


async def test_list_cache_is_invalidated_without_scanning_redis_keys(client, make_headers):
    from app.db import cache

    headers = await make_headers("viewer")
    assert (await client.get("/api/work-items", headers=headers)).json()["items"] == []  # primes the cache
    with patch.object(cache._r(), "keys", new_callable=AsyncMock) as keys:
        wi_id = await process_signal(sig("CACHE_FRESH"))
        r = await client.get("/api/work-items", headers=headers)

    assert [i["id"] for i in r.json()["items"]] == [wi_id]
    keys.assert_not_called()
    assert not hasattr(cache, "delete_pattern") and not hasattr(cache, "get_all_with_prefix")
