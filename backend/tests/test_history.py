"""Incident history: every change writes a work_item_events row in the same transaction."""
import asyncio
import os
import sys

import pytest
from sqlalchemy import text, update

from app.core.security import create_access_token
from app.db.postgres import AsyncSessionLocal, WorkItem
from app.services.ingestion import process_signal

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RCA = {
    "incident_start": "2026-01-01T10:00:00Z",
    "incident_end": "2026-01-01T12:00:00Z",
    "root_cause_category": "Infrastructure Failure",
    "fix_applied": "Restarted the primary",
    "prevention_steps": "Automated failover",
}


def sig(component="RDBMS_PRIMARY"):
    return {"component_id": component, "signal_type": "ERROR", "message": "down",
            "severity": "CRITICAL", "metadata": {}, "timestamp": None}


async def sre(make_user, role="sre"):
    """A user plus Bearer headers."""
    user = await make_user(role)
    token = create_access_token({"sub": user["id"], "role": role, "tv": 0})
    return user, {"Authorization": f"Bearer {token}"}


async def events(wi_id):
    """(kind, actor_id, from_value, to_value) rows, oldest first. Raw SQL: only committed data is visible."""
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(text(
            "SELECT kind, actor_id, from_value, to_value FROM work_item_events "
            "WHERE work_item_id = :id ORDER BY created_at, id"), {"id": wi_id})).all()
    return [tuple(r) for r in rows]


async def set_status(wi_id, status):
    async with AsyncSessionLocal() as db:
        await db.execute(update(WorkItem).where(WorkItem.id == wi_id).values(status=status))
        await db.commit()


async def test_new_incident_has_one_created_event_with_no_actor_and_later_signals_add_none():
    wi_id = await process_signal(sig("RDBMS_PRIMARY"))
    await process_signal(sig("RDBMS_PRIMARY"))
    await process_signal(sig("RDBMS_PRIMARY"))

    assert await events(wi_id) == [("created", None, None, "P0")]


async def test_status_change_records_from_to_and_the_actor(client, make_user):
    user, headers = await sre(make_user)
    wi_id = await process_signal(sig())

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=headers)

    assert r.status_code == 200
    # Starting the investigation also claims the unowned incident, in the same transaction.
    assert (await events(wi_id))[1:] == [
        ("status", user["id"], "OPEN", "INVESTIGATING"),
        ("assigned", user["id"], None, user["username"]),
    ]


async def test_a_lost_race_records_no_status_event(client, make_user):
    """The 409 path must leave no event behind, so the event cannot be outside the transaction."""
    _, headers = await sre(make_user)
    wi_id = await process_signal(sig())

    async with AsyncSessionLocal() as other:
        await other.execute(update(WorkItem).where(WorkItem.id == wi_id).values(status="INVESTIGATING"))
        request = asyncio.create_task(client.patch(
            f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=headers))
        await asyncio.sleep(0.3)  # our request validated against OPEN and now waits on the row lock
        await other.commit()

    assert (await request).status_code == 409
    assert [e for e in await events(wi_id) if e[0] == "status"] == []


async def test_closing_without_an_rca_records_no_event(client, make_user):
    _, headers = await sre(make_user)
    wi_id = await process_signal(sig())
    await set_status(wi_id, "RESOLVED")

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "CLOSED"}, headers=headers)

    assert r.status_code == 422
    assert [e for e in await events(wi_id) if e[0] == "status"] == []


async def test_assign_then_unassign_records_both_with_usernames(client, make_user):
    caller, headers = await sre(make_user)
    bob = await make_user("sre")
    wi_id = await process_signal(sig())

    await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": bob["id"]}, headers=headers)
    await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": bob["id"]}, headers=headers)  # no change
    await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": None}, headers=headers)

    assert (await events(wi_id))[1:] == [
        ("assigned", caller["id"], None, bob["username"]),
        ("assigned", caller["id"], bob["username"], None),
    ]


async def test_submitting_an_rca_records_rca_submitted(client, make_user):
    user, headers = await sre(make_user)
    wi_id = await process_signal(sig())
    await set_status(wi_id, "RESOLVED")

    r = await client.post(f"/api/work-items/{wi_id}/rca", json=RCA, headers=headers)

    assert r.status_code == 200
    assert (await events(wi_id))[1:] == [("rca_submitted", user["id"], None, None)]


async def test_history_endpoint_lists_events_oldest_first_with_actor_username(client, make_user):
    user, headers = await sre(make_user)
    wi_id = await process_signal(sig())
    await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=headers)
    await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "RESOLVED", "note": "Failed over"}, headers=headers)

    r = await client.get(f"/api/work-items/{wi_id}/history", headers=headers)

    assert r.status_code == 200
    body = r.json()
    assert [(e["kind"], e["from_value"], e["to_value"], e["actor_username"]) for e in body] == [
        ("created", None, "P0", None),
        ("status", "OPEN", "INVESTIGATING", user["username"]),
        ("assigned", None, user["username"], user["username"]),
        ("status", "INVESTIGATING", "RESOLVED", user["username"]),
    ]
    assert all(e["id"] and e["created_at"] for e in body)
    assert [e["created_at"] for e in body] == sorted(e["created_at"] for e in body)


async def test_history_is_404_for_an_unknown_incident_and_401_without_auth(client, make_user):
    _, headers = await sre(make_user, "viewer")
    wi_id = await process_signal(sig())

    assert (await client.get("/api/work-items/nope/history", headers=headers)).status_code == 404
    assert (await client.get(f"/api/work-items/{wi_id}/history")).status_code == 401


async def _alembic(*args):
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "alembic", *args, cwd=BACKEND_DIR,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    assert proc.returncode == 0, out.decode()


async def _has_table():
    async with AsyncSessionLocal() as db:
        return (await db.execute(text("SELECT to_regclass('public.work_item_events')"))).scalar() is not None


async def test_migration_0004_round_trips():
    assert await _has_table()
    try:
        await _alembic("downgrade", "0003")
        assert not await _has_table()
    finally:
        await _alembic("upgrade", "head")
    assert await _has_table()
