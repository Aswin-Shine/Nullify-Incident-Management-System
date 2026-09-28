"""API keys: shown once, stored only as a hash, rotation kills the old key."""
import hashlib

import pytest
from sqlalchemy import select

from app.db.postgres import AsyncSessionLocal, User

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]

SIG = {"component_id": "CACHE_KEY", "signal_type": "ERROR", "message": "boom"}


async def test_api_key_is_shown_once_and_stored_hashed(client, make_headers):
    """Regression for S-10: keys were plaintext in the DB and listed to admins."""
    headers = await make_headers("sre")

    r = await client.post("/api/auth/api-key", headers=headers)
    assert r.status_code == 200
    key = r.json()["api_key"]

    assert (await client.post("/api/signals", json=SIG, headers={"X-API-Key": key})).status_code == 202
    me = (await client.get("/api/auth/me", headers=headers)).json()
    assert "api_key" not in me
    assert "api_key" not in User.__table__.columns
    async with AsyncSessionLocal() as db:
        stored = (await db.execute(select(User.api_key_hash).where(User.id == me["id"]))).scalar_one()
    assert stored == hashlib.sha256(key.encode()).hexdigest()


async def test_rotating_key_revokes_the_old_one(client, make_headers):
    headers = await make_headers("sre")
    old = (await client.post("/api/auth/api-key", headers=headers)).json()["api_key"]
    new = (await client.post("/api/auth/api-key", headers=headers)).json()["api_key"]

    assert new != old
    assert (await client.get("/api/auth/me", headers={"X-API-Key": old})).status_code == 401
    assert (await client.get("/api/auth/me", headers={"X-API-Key": new})).status_code == 200
