"""Workflow: race-free transitions, MTTR per spec, RCA immutability, side effects after commit."""
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import func, select, update

from app.core.security import create_access_token
from app.db.postgres import AsyncSessionLocal, RCARecord, User, WorkItem
from app.services.ingestion import process_signal
from app.services.state_machine import InvalidTransitionError
from app.services.work_item_service import ConflictError, transition_status
from factories import create_work_item

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
        r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": status, "note": "Failed over"}, headers=headers)
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
            "open_p0": await create_work_item(db, component="A1", priority="P0", title="a"),
            "resolved_p0": await create_work_item(db, component="A2", priority="P0", title="b"),
            "investigating_p1": await create_work_item(db, component="A3", priority="P1", title="c"),
            "closed_p2": await create_work_item(db, component="A4", priority="P2", title="d"),
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
            ids.append(await create_work_item(db, component=f"C{i}", priority=p, title=f"t{i}"))
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


async def test_status_active_means_open_or_investigating(client, make_headers):
    headers = await make_headers("viewer")
    ids = await make_items(["P0", "P1", "P2", "P3"])
    await set_status(ids[1], "INVESTIGATING")
    await set_status(ids[2], "RESOLVED")
    await set_status(ids[3], "CLOSED")

    r = await client.get("/api/work-items", params={"status": "ACTIVE"}, headers=headers)

    assert r.status_code == 200
    assert {i["id"] for i in r.json()["items"]} == {ids[0], ids[1]}


async def test_list_total_counts_every_match_not_just_the_page(client, make_headers):
    headers = await make_headers("viewer")
    await make_items(["P0", "P1", "P2"])

    r = await client.get("/api/work-items", params={"limit": 2}, headers=headers)
    rest = await client.get("/api/work-items", params={"limit": 2, "cursor": r.json()["next_cursor"]}, headers=headers)

    assert r.json()["total"] == 3 and len(r.json()["items"]) == 2 and r.json()["next_cursor"] is not None
    assert rest.json()["total"] == 3  # the cursor does not shrink the count


async def test_list_total_follows_the_same_filters_as_the_rows(client, make_headers):
    headers = await make_headers("viewer")
    ids = await make_items(["P0", "P1", "P2", "P0"])
    await set_status(ids[1], "INVESTIGATING")
    await set_status(ids[2], "RESOLVED")

    active = await client.get("/api/work-items", params={"status": "ACTIVE", "limit": 1}, headers=headers)
    p0 = await client.get("/api/work-items", params={"priority": "P0"}, headers=headers)
    search = await client.get("/api/work-items", params={"q": "c1"}, headers=headers)
    none = await client.get("/api/work-items", params={"status": "CLOSED"}, headers=headers)

    assert active.json()["total"] == 3  # OPEN and INVESTIGATING only
    assert p0.json()["total"] == 2
    assert search.json()["total"] == 1
    assert none.json() == {"items": [], "next_cursor": None, "total": 0}


async def test_unknown_status_filter_is_422(client, make_headers):
    r = await client.get("/api/work-items", params={"status": "BOGUS"}, headers=await make_headers("viewer"))
    assert r.status_code == 422


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


# -- Search and filters: q, priority, assignee ---------------------------------

async def make_named(*specs):
    """Work items from (component, priority) pairs. Returns {component: id}."""
    ids = {}
    async with AsyncSessionLocal() as db:
        for component, priority in specs:
            ids[component] = await create_work_item(db, component=component, priority=priority, title=component)
            await db.commit()
    return ids


async def components(client, headers, **params):
    r = await client.get("/api/work-items", params=params, headers=headers)
    assert r.status_code == 200, r.text
    return {i["component"] for i in r.json()["items"]}


async def test_q_matches_a_component_substring_case_insensitively(client, make_headers):
    headers = await make_headers("viewer")
    await make_named(("RDBMS_PRIMARY", "P0"), ("CACHE_01", "P2"))

    assert await components(client, headers, q="rdbms") == {"RDBMS_PRIMARY"}
    assert await components(client, headers, q="Imar") == {"RDBMS_PRIMARY"}
    assert await components(client, headers, q="") == {"RDBMS_PRIMARY", "CACHE_01"}


async def test_q_wildcards_are_matched_literally(client, make_headers):
    headers = await make_headers("viewer")
    await make_named(("RDBMS_PRIMARY", "P0"), ("QUEUE01", "P2"))

    assert await components(client, headers, q="%") == set()  # a raw % would match everything
    assert await components(client, headers, q="_") == {"RDBMS_PRIMARY"}  # a raw _ would match every character
    assert await components(client, headers, q="\\") == set()


async def test_q_longer_than_64_characters_is_422(client, make_headers):
    headers = await make_headers("viewer")
    r = await client.get("/api/work-items", params={"q": "A" * 65}, headers=headers)
    assert r.status_code == 422


async def test_priority_filter_and_an_unknown_priority_is_422(client, make_headers):
    headers = await make_headers("viewer")
    await make_named(("A1", "P0"), ("A2", "P1"), ("A3", "P0"))

    assert await components(client, headers, priority="P0") == {"A1", "A3"}
    assert (await client.get("/api/work-items", params={"priority": "P9"}, headers=headers)).status_code == 422


async def test_assignee_me_and_none(client, make_user):
    me = await make_user("sre")
    other = await make_user("sre")
    headers = {"Authorization": "Bearer " + create_access_token({"sub": me["id"], "role": "sre", "tv": 0})}
    ids = await make_named(("MINE", "P1"), ("THEIRS", "P1"), ("FREE", "P1"))
    async with AsyncSessionLocal() as db:
        await db.execute(update(WorkItem).where(WorkItem.id == ids["MINE"]).values(assignee_id=me["id"]))
        await db.execute(update(WorkItem).where(WorkItem.id == ids["THEIRS"]).values(assignee_id=other["id"]))
        await db.commit()

    assert await components(client, headers, assignee="me") == {"MINE"}
    assert await components(client, headers, assignee="none") == {"FREE"}
    assert (await client.get("/api/work-items", params={"assignee": "bob"}, headers=headers)).status_code == 422


async def test_filters_combine_with_status_and_with_cursor_pages(client, make_headers):
    headers = await make_headers("viewer")
    ids = await make_named(*[(f"RDBMS_{i}", "P0") for i in range(5)], ("CACHE_X", "P0"), ("RDBMS_P1", "P1"))
    await set_status(ids["RDBMS_0"], "INVESTIGATING")
    await set_status(ids["RDBMS_1"], "INVESTIGATING")

    pages, _ = await walk(client, headers, q="rdbms", priority="P0", limit=2)

    flat = [i for p in pages for i in p]
    assert [len(p) for p in pages] == [2, 2, 1]
    assert len(set(flat)) == 5 and set(flat) == {ids[f"RDBMS_{i}"] for i in range(5)}
    assert await components(client, headers, q="rdbms", priority="P0", status="INVESTIGATING") == {"RDBMS_0", "RDBMS_1"}


async def test_different_filters_do_not_share_a_cache_entry(client, make_headers):
    headers = await make_headers("viewer")
    await make_named(("ALPHA1", "P1"), ("ZULU1", "P2"))

    assert await components(client, headers, q="alpha") == {"ALPHA1"}  # primes the cache for q=alpha
    assert await components(client, headers, q="zulu") == {"ZULU1"}
    assert await components(client, headers, priority="P2") == {"ZULU1"}
    assert await components(client, headers) == {"ALPHA1", "ZULU1"}
    assert await components(client, headers, q="alpha") == {"ALPHA1"}  # and the cached page is still right


async def test_assignee_me_cache_is_per_user(client, make_user):
    a, b = await make_user("sre"), await make_user("sre")
    hdr = lambda u: {"Authorization": "Bearer " + create_access_token({"sub": u["id"], "role": "sre", "tv": 0})}
    ids = await make_named(("FOR_A", "P1"), ("FOR_B", "P1"))
    async with AsyncSessionLocal() as db:
        await db.execute(update(WorkItem).where(WorkItem.id == ids["FOR_A"]).values(assignee_id=a["id"]))
        await db.execute(update(WorkItem).where(WorkItem.id == ids["FOR_B"]).values(assignee_id=b["id"]))
        await db.commit()

    assert await components(client, hdr(a), assignee="me") == {"FOR_A"}
    assert await components(client, hdr(b), assignee="me") == {"FOR_B"}


# -- B-34: webhooks never hold up the response -------------------------------

async def test_status_patch_does_not_wait_for_the_webhooks(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    gate = asyncio.Event()

    async def never_finishes(*args, **kwargs):
        await gate.wait()

    with patch("app.routers.work_items.webhooks.notify_status_change", new=never_finishes):
        r = await asyncio.wait_for(
            client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=headers), 2)
        gate.set()
        await asyncio.sleep(0.05)

    assert r.status_code == 200


async def test_spawn_keeps_a_reference_until_the_task_finishes():
    from app.services import webhooks
    gate = asyncio.Event()

    async def work():
        await gate.wait()

    task = webhooks.spawn(work())
    assert len(webhooks._background) == 1
    gate.set()
    await task
    await asyncio.sleep(0)
    assert len(webhooks._background) == 0


# -- Start Investigating claims an unowned incident ------------------------------

async def history_kinds(client, headers, wi_id):
    r = await client.get(f"/api/work-items/{wi_id}/history", headers=headers)
    return [(e["kind"], e["to_value"]) for e in r.json()]


async def test_investigating_claims_an_unassigned_incident_for_the_actor(client, make_user):
    me = await make_user("sre")
    headers = {"Authorization": f"Bearer {create_access_token({'sub': me['id'], 'role': 'sre', 'tv': 0})}"}
    wi_id = await process_signal(sig())

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=headers)

    assert r.status_code == 200
    assert r.json()["assignee_id"] == me["id"]
    assert r.json()["assignee_username"] == me["username"]
    events = await history_kinds(client, headers, wi_id)
    assert [k for k, _ in events] == ["created", "status", "assigned"]
    assert events[-1] == ("assigned", me["username"])


async def test_investigating_keeps_an_existing_owner_and_records_no_assignment(client, make_user):
    me, owner = await make_user("sre"), await make_user("sre")
    headers = {"Authorization": f"Bearer {create_access_token({'sub': me['id'], 'role': 'sre', 'tv': 0})}"}
    wi_id = await process_signal(sig())
    async with AsyncSessionLocal() as db:
        await db.execute(update(WorkItem).where(WorkItem.id == wi_id).values(assignee_id=owner["id"]))
        await db.commit()

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=headers)

    assert r.json()["assignee_id"] == owner["id"]
    assert [k for k, _ in await history_kinds(client, headers, wi_id)] == ["created", "status"]


async def test_resolving_an_unassigned_incident_does_not_assign_it(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    await set_status(wi_id, "INVESTIGATING")

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "RESOLVED", "note": "Failed over"}, headers=headers)

    assert r.status_code == 200
    assert r.json()["assignee_id"] is None
    assert [k for k, _ in await history_kinds(client, headers, wi_id)] == ["created", "status"]


async def test_resolving_records_resolved_at_and_closing_keeps_it(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    url = f"/api/work-items/{wi_id}/status"

    r = await client.patch(url, json={"new_status": "INVESTIGATING"}, headers=headers)
    assert r.json()["resolved_at"] is None

    before = datetime.now(timezone.utc)
    r = await client.patch(url, json={"new_status": "RESOLVED", "note": "Failed over"}, headers=headers)
    resolved_at = datetime.fromisoformat(r.json()["resolved_at"])
    assert resolved_at >= before - timedelta(seconds=1)
    assert await committed(WorkItem.resolved_at, wi_id) == resolved_at

    listed = (await client.get("/api/work-items", params={"status": "RESOLVED"}, headers=headers)).json()["items"]
    assert datetime.fromisoformat(listed[0]["resolved_at"]) == resolved_at

    assert (await client.post(f"/api/work-items/{wi_id}/rca", json=RCA, headers=headers)).status_code == 200
    r = await client.patch(url, json={"new_status": "CLOSED"}, headers=headers)
    assert datetime.fromisoformat(r.json()["resolved_at"]) == resolved_at


async def test_resolving_needs_a_note_and_a_missing_or_blank_one_changes_nothing(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    await set_status(wi_id, "INVESTIGATING")
    url = f"/api/work-items/{wi_id}/status"

    for body in ({"new_status": "RESOLVED"}, {"new_status": "RESOLVED", "note": "   "}):
        r = await client.patch(url, json=body, headers=headers)
        assert r.status_code == 422
        assert "resolution note" in r.json()["detail"]

    assert await committed(WorkItem.status, wi_id) == "INVESTIGATING"
    assert [k for k, _ in await history_kinds(client, headers, wi_id)] == ["created"]


async def test_resolution_note_is_stored_trimmed_and_returned_by_reads(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    await set_status(wi_id, "INVESTIGATING")

    r = await client.patch(f"/api/work-items/{wi_id}/status",
                           json={"new_status": "RESOLVED", "note": "  Restarted the primary, replica caught up  "}, headers=headers)

    assert r.status_code == 200
    assert r.json()["resolution_note"] == "Restarted the primary, replica caught up"
    got = (await client.get(f"/api/work-items/{wi_id}", headers=headers)).json()
    assert got["resolution_note"] == "Restarted the primary, replica caught up"
    listed = (await client.get("/api/work-items", params={"status": "RESOLVED"}, headers=headers)).json()["items"]
    assert listed[0]["resolution_note"] == "Restarted the primary, replica caught up"


async def test_a_resolution_note_over_4000_characters_is_refused(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())
    await set_status(wi_id, "INVESTIGATING")

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "RESOLVED", "note": "x" * 4001}, headers=headers)

    assert r.status_code == 422
    assert await committed(WorkItem.status, wi_id) == "INVESTIGATING"


async def test_an_invalid_move_without_a_note_is_still_a_400(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())  # OPEN: RESOLVED is not a next state

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "RESOLVED"}, headers=headers)

    assert r.status_code == 400


async def test_a_note_sent_with_another_status_is_ignored(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig())

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING", "note": "looking"}, headers=headers)

    assert r.status_code == 200
    assert r.json()["resolution_note"] is None
