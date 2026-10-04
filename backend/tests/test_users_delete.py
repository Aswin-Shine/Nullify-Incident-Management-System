"""Admins delete accounts: the person can never sign in again and their name is freed, but the incident record
keeps everything they did, labelled "Deleted user" (comments, history, the owner of finished incidents)."""
from unittest.mock import patch

import pytest
from sqlalchemy import select, update

from app.core.security import create_access_token
from app.db.postgres import AsyncSessionLocal, User, WorkItem
from app.services.ingestion import process_signal

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]


def sig(component):
    return {"component_id": component, "signal_type": "ERROR", "message": "down", "severity": "HIGH", "metadata": {}}


def bearer(user):
    return {"Authorization": f"Bearer {create_access_token({'sub': user['id'], 'role': user['role'], 'tv': 0})}"}


async def set_owner(wi_id, user_id, status):
    async with AsyncSessionLocal() as db:
        await db.execute(update(WorkItem).where(WorkItem.id == wi_id).values(assignee_id=user_id, status=status))
        await db.commit()


async def test_a_deleted_user_cannot_sign_in_and_disappears_from_the_lists(client, make_user):
    admin, sre = await make_user("admin"), await make_user("sre")
    old_token = bearer(sre)

    r = await client.delete(f"/api/auth/users/{sre['id']}", headers=bearer(admin))

    assert r.status_code == 204
    login = await client.post("/api/auth/login", json={"username": sre["username"], "password": sre["password"]})
    assert login.status_code == 401
    assert (await client.get("/api/work-items", headers=old_token)).status_code == 401
    accounts = (await client.get("/api/auth/accounts", headers=bearer(admin))).json()
    assert sre["id"] not in [a["id"] for a in accounts]
    pickable = (await client.get("/api/auth/users", headers=bearer(admin))).json()
    assert sre["id"] not in [u["id"] for u in pickable]


async def test_active_incidents_are_unassigned_and_finished_ones_keep_their_owner(client, make_user):
    admin, sre = await make_user("admin"), await make_user("sre")
    active = await process_signal(sig("CACHE_A"))
    finished = await process_signal(sig("CACHE_B"))
    await set_owner(active, sre["id"], "INVESTIGATING")
    await set_owner(finished, sre["id"], "RESOLVED")

    assert (await client.delete(f"/api/auth/users/{sre['id']}", headers=bearer(admin))).status_code == 204

    wi = (await client.get(f"/api/work-items/{active}", headers=bearer(admin))).json()
    assert wi["assignee_id"] is None
    events = (await client.get(f"/api/work-items/{active}/history", headers=bearer(admin))).json()
    assert events[-1]["kind"] == "assigned"
    assert events[-1]["to_value"] is None
    assert events[-1]["actor_username"] == admin["username"]
    done = (await client.get(f"/api/work-items/{finished}", headers=bearer(admin))).json()
    assert done["assignee_id"] == sre["id"]
    assert done["assignee_username"] == "Deleted user"


async def test_their_comments_and_history_stay_labelled_deleted_user(client, make_user):
    admin, sre = await make_user("admin"), await make_user("sre")
    wi_id = await process_signal(sig("CACHE_C"))
    assert (await client.post(f"/api/work-items/{wi_id}/comments", json={"body": "looking"}, headers=bearer(sre))).status_code == 201
    assert (await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=bearer(sre))).status_code == 200

    assert (await client.delete(f"/api/auth/users/{sre['id']}", headers=bearer(admin))).status_code == 204

    comments = (await client.get(f"/api/work-items/{wi_id}/comments", headers=bearer(admin))).json()
    assert [(c["body"], c["author_username"]) for c in comments] == [("looking", "Deleted user")]
    events = (await client.get(f"/api/work-items/{wi_id}/history", headers=bearer(admin))).json()
    assert ("status", "Deleted user") in [(e["kind"], e["actor_username"]) for e in events]


async def test_the_username_and_email_can_be_reused_at_once(client, make_user):
    admin, sre = await make_user("admin"), await make_user("sre")
    async with AsyncSessionLocal() as db:
        email = (await db.execute(select(User.email).where(User.id == sre["id"]))).scalar_one()

    assert (await client.delete(f"/api/auth/users/{sre['id']}", headers=bearer(admin))).status_code == 204

    again = await client.post("/api/auth/users", headers=bearer(admin), json={
        "username": sre["username"], "email": email, "password": "a-new-long-password", "role": "sre"})
    assert again.status_code == 201


async def test_guards_self_non_admin_unknown_and_twice(client, make_user):
    admin, sre, other = await make_user("admin"), await make_user("sre"), await make_user("viewer")

    assert (await client.delete(f"/api/auth/users/{admin['id']}", headers=bearer(admin))).status_code == 400
    assert (await client.delete(f"/api/auth/users/{other['id']}", headers=bearer(sre))).status_code == 403
    assert (await client.delete("/api/auth/users/no-such-user", headers=bearer(admin))).status_code == 404
    assert (await client.delete(f"/api/auth/users/{other['id']}", headers=bearer(admin))).status_code == 204
    assert (await client.delete(f"/api/auth/users/{other['id']}", headers=bearer(admin))).status_code == 404


async def test_side_effects_run_after_the_commit(client, make_user):
    admin, sre = await make_user("admin"), await make_user("sre")
    wi_id = await process_signal(sig("CACHE_D"))
    await set_owner(wi_id, sre["id"], "INVESTIGATING")
    seen = []

    async def check(*_args, **_kwargs):
        async with AsyncSessionLocal() as db:  # a fresh session only sees committed data
            seen.append((await db.execute(select(WorkItem.assignee_id).where(WorkItem.id == wi_id))).scalar_one())

    with patch("app.routers.auth.invalidate_cache", side_effect=check), patch("app.routers.auth.ws_manager.broadcast", side_effect=check):
        assert (await client.delete(f"/api/auth/users/{sre['id']}", headers=bearer(admin))).status_code == 204

    assert seen and all(v is None for v in seen)
