"""Fixes from the 2026-10-04 security review: who may ingest, where API keys work, sockets and sessions that outlive
revocation, and the smaller leaks (Redis password in logs, /health detail, Slack markup, deleted users' names)."""
import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select, update

from app.core.config import get_settings
from app.core.security import create_access_token
from app.db.postgres import AsyncSessionLocal, User, WorkItem
from app.services.ingestion import process_signal

SIG = {"component_id": "CACHE_SEC", "signal_type": "ERROR", "message": "boom"}
NGINX = Path(__file__).resolve().parents[2] / "frontend" / "nginx.conf"


def bearer(user, tv=0):
    return {"Authorization": f"Bearer {create_access_token({'sub': user['id'], 'role': user['role'], 'tv': tv})}"}


async def api_key_for(client, user):
    return (await client.post("/api/auth/api-key", headers=bearer(user))).json()["api_key"]


# -- Who may ingest, and where API keys work ------------------------------------

@pytest.mark.usefixtures("clean_state")
async def test_a_viewer_cannot_send_signals(client, make_headers):
    viewer = await make_headers("viewer")

    assert (await client.post("/api/signals", json=SIG, headers=viewer)).status_code == 403
    assert (await client.post("/api/signals/batch", json=[SIG], headers=viewer)).status_code == 403


@pytest.mark.usefixtures("clean_state")
async def test_a_viewers_api_key_cannot_send_signals_either(client, make_user):
    viewer = await make_user("viewer")
    key = await api_key_for(client, viewer)

    assert (await client.post("/api/signals", json=SIG, headers={"X-API-Key": key})).status_code == 403


@pytest.mark.usefixtures("clean_state")
async def test_an_api_key_works_on_the_signal_routes_only(client, make_user):
    admin = await make_user("admin")
    key = {"X-API-Key": await api_key_for(client, admin)}
    wi_id = await process_signal({**SIG, "component_id": "CACHE_KEYED"})

    assert (await client.post("/api/signals", json=SIG, headers=key)).status_code == 202
    assert (await client.post("/api/signals/batch", json=[SIG], headers=key)).status_code == 202
    assert (await client.get("/api/auth/me", headers=key)).status_code == 401
    assert (await client.get("/api/work-items", headers=key)).status_code == 401
    assert (await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=key)).status_code == 401
    assert (await client.get("/api/auth/accounts", headers=key)).status_code == 401
    assert (await client.post("/api/auth/api-key", headers=key)).status_code == 401  # a key cannot mint its successor


@pytest.mark.usefixtures("clean_state")
async def test_a_batch_costs_one_unit_per_signal(client, make_headers, monkeypatch):
    monkeypatch.setattr(get_settings(), "rate_limit_ingest_per_sec", 10)
    alice, bob = await make_headers("sre"), await make_headers("sre")

    with patch("app.core.rate_limit._now", return_value=1_000_000.2):
        too_big = await client.post("/api/signals/batch", json=[SIG] * 11, headers=alice)
        fits = await client.post("/api/signals/batch", json=[SIG] * 10, headers=bob)

    assert too_big.status_code == 429
    assert fits.status_code == 202


# -- Sessions and accounts -----------------------------------------------------

@pytest.mark.usefixtures("clean_state")
async def test_refresh_does_not_extend_the_session(client, make_user):
    user = await make_user()
    await client.post("/api/auth/login", json={"username": user["username"], "password": user["password"]})
    cookie = client.cookies.get("nullify_refresh")

    r = await client.post("/api/auth/refresh", headers={"X-Requested-With": "nullify"})

    assert r.status_code == 200
    assert "set-cookie" not in r.headers
    assert client.cookies.get("nullify_refresh") == cookie
    assert (await client.get("/api/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})).status_code == 200


@pytest.mark.usefixtures("clean_state")
async def test_a_deleted_account_cannot_be_reactivated(client, make_user):
    admin, sre = await make_user("admin"), await make_user("sre")
    assert (await client.delete(f"/api/auth/users/{sre['id']}", headers=bearer(admin))).status_code == 204

    r = await client.patch(f"/api/auth/users/{sre['id']}", json={"is_active": True, "password": "a-brand-new-password"},
                           headers=bearer(admin))

    assert r.status_code == 404
    async with AsyncSessionLocal() as db:
        assert (await db.execute(select(User.is_active).where(User.id == sre["id"]))).scalar_one() is False


@pytest.mark.usefixtures("clean_state")
async def test_deleting_a_user_removes_their_name_from_assignment_history(client, make_user):
    admin, sre = await make_user("admin"), await make_user("sre")
    wi_id = await process_signal({**SIG, "component_id": "CACHE_NAMED"})
    await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": sre["id"]}, headers=bearer(admin))

    assert (await client.delete(f"/api/auth/users/{sre['id']}", headers=bearer(admin))).status_code == 204

    events = (await client.get(f"/api/work-items/{wi_id}/history", headers=bearer(admin))).json()
    names = [v for e in events if e["kind"] == "assigned" for v in (e["from_value"], e["to_value"])]
    assert sre["username"] not in names
    assert names.count("Deleted user") == 2  # assigned to them, then unassigned from them


@pytest.mark.usefixtures("clean_state")
@pytest.mark.parametrize("body", [
    {"username": "u" * 65, "password": "whatever-password"},
    {"username": "someone", "password": "p" * 129},
])
async def test_oversized_login_fields_are_refused_before_hashing(client, body):
    with patch("app.routers.auth.verify_password") as verify:
        r = await client.post("/api/auth/login", json=body)
    assert r.status_code == 422
    verify.assert_not_called()


@pytest.mark.usefixtures("clean_state")
async def test_new_passwords_over_72_bytes_are_refused(client, make_user):
    """bcrypt ignores everything after 72 bytes, so a longer password would not mean what the user typed."""
    admin = await make_user("admin")
    long_pw = "é" * 37  # 37 characters, 74 bytes

    r = await client.post("/api/auth/users", json={"username": "longpw", "email": "l@example.com", "password": long_pw,
                                                   "role": "sre"}, headers=bearer(admin))

    assert r.status_code == 422
    assert "72 bytes" in r.text


# -- WebSocket: revocation, stalled sends, early deaths --------------------------

class IdleSocket:
    """An authenticated browser tab that sends nothing after its auth message."""
    headers: dict = {}

    def __init__(self, token, fail_auth_ok=False):
        self.token, self.fail_auth_ok = token, fail_auth_ok
        self.closed_with, self.sent = [], []

    async def accept(self):
        pass

    async def receive_json(self):
        return {"type": "auth", "token": self.token}

    async def send_json(self, data):
        if self.fail_auth_ok:
            raise RuntimeError("client went away")
        self.sent.append(data)

    async def receive_text(self):
        await asyncio.Event().wait()

    async def close(self, code=1000):
        self.closed_with.append(code)


@pytest.mark.usefixtures("clean_state")
@pytest.mark.parametrize("change", [{"token_version": 1}, {"is_active": False}])
async def test_a_revoked_users_socket_is_closed_at_the_next_check(make_user, change):
    from app.routers.ws import websocket_endpoint
    from app.services.ws_manager import manager

    user = await make_user("sre")
    ws = IdleSocket(create_access_token({"sub": user["id"], "role": "sre", "tv": 0}))
    with patch("app.routers.ws.WS_RECHECK_SECONDS", 0.05):
        task = asyncio.create_task(websocket_endpoint(ws))
        await asyncio.sleep(0.15)
        assert ws.sent == [{"event": "auth_ok"}] and ws.closed_with == []  # still allowed: stays open

        async with AsyncSessionLocal() as db:
            await db.execute(update(User).where(User.id == user["id"]).values(**change))
            await db.commit()
        await asyncio.wait_for(task, 2)

    assert ws.closed_with == [1008]
    assert ws not in manager._connections


@pytest.mark.usefixtures("clean_state")
async def test_a_socket_that_dies_before_auth_ok_is_not_left_registered(make_user):
    from app.routers.ws import websocket_endpoint
    from app.services.ws_manager import manager

    user = await make_user("sre")
    ws = IdleSocket(create_access_token({"sub": user["id"], "role": "sre", "tv": 0}), fail_auth_ok=True)

    await asyncio.wait_for(websocket_endpoint(ws), 2)

    assert ws not in manager._connections


class StallingSocket:
    def __init__(self):
        self.closed_with = []

    async def send_text(self, text):
        await asyncio.Event().wait()

    async def close(self, code=1000):
        self.closed_with.append(code)


async def test_a_stalled_socket_is_closed_so_the_browser_reconnects():
    """It used to be dropped from the broadcast list only: the tab kept showing "Live" and never updated again."""
    from app.services.ws_manager import ConnectionManager

    manager = ConnectionManager()
    ws = StallingSocket()
    await manager.register(ws)
    with patch("app.services.ws_manager.SEND_TIMEOUT", 0.05):
        await asyncio.wait_for(manager._send_local('{"event": "x"}'), 1)

    assert ws.closed_with == [1011]
    assert manager._connections == []


# -- Smaller leaks -----------------------------------------------------------------

@pytest.mark.usefixtures("clean_state")
async def test_health_tells_anonymous_callers_only_the_status(client, make_headers):
    anon = await client.get("/health")
    signed_in = await client.get("/health", headers=await make_headers("viewer"))

    assert anon.json() == {"status": "ok"}
    assert {"postgres", "redis", "queue_depth", "queue_capacity"} <= signed_in.json().keys()


@pytest.mark.usefixtures("clean_state")
async def test_health_with_an_expired_token_asks_for_a_refresh(client, make_user):
    """The health bar sends its token; a 401 (not the bare status) makes the client refresh and get the detail back."""
    user = await make_user("sre")
    stale = bearer(user, tv=7)  # revoked or expired: either way user_from_access_token says no

    assert (await client.get("/health", headers=stale)).status_code == 401


async def test_the_redis_password_is_not_logged(monkeypatch, caplog):
    from app.db import cache

    monkeypatch.setattr(get_settings(), "redis_password", "s3cret-redis-pw")
    fake = SimpleNamespace(ping=AsyncMock())
    with patch("app.db.cache.aioredis.from_url", return_value=fake), caplog.at_level(logging.INFO):
        await cache.init_redis()

    assert "Redis connected" in caplog.text
    assert "s3cret-redis-pw" not in caplog.text


@pytest.mark.usefixtures("clean_state")
async def test_a_ten_year_old_signal_time_is_clamped_to_a_day_before_receipt():
    old = (datetime.now(timezone.utc) - timedelta(days=3650)).isoformat()
    before = datetime.now(timezone.utc)

    wi_id = await process_signal({**SIG, "component_id": "CACHE_OLD", "timestamp": old})

    async with AsyncSessionLocal() as db:
        start = (await db.execute(select(WorkItem.start_time).where(WorkItem.id == wi_id))).scalar_one()
    assert before - timedelta(hours=24, seconds=5) <= start <= datetime.now(timezone.utc) - timedelta(hours=23, minutes=59)


async def test_slack_text_escapes_producer_markup():
    from app.services import webhooks

    sent = {}

    class FakeClient:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def post(self, url, json):
            sent.update(json)
            return SimpleNamespace(status_code=200)

    with patch.object(webhooks.settings, "slack_webhook_url", "https://hooks.example/x"), \
         patch("app.services.webhooks.httpx.AsyncClient", FakeClient):
        await webhooks._slack_notify({"id": "abcdefgh12", "priority": "P1", "component": "DB_<!here>",
                                      "title": "DB - <https://evil.example|click> & go"}, "created")

    attachment = sent["attachments"][0]
    assert "<https://evil" not in attachment["text"] and "&lt;https://evil.example|click&gt; &amp; go" in attachment["text"]
    assert attachment["fields"][0]["value"] == "DB_&lt;!here&gt;"


# -- nginx: the backend's per-IP limits trust what nginx forwards -----------------

@pytest.mark.skipif(not NGINX.exists(), reason="frontend/nginx.conf not in this checkout")
def test_nginx_overwrites_forwarded_for_and_keeps_security_headers_on_assets():
    conf = NGINX.read_text()
    forwarded = re.findall(r"X-Forwarded-For\s+(\S+);", conf)
    assert forwarded and all(v == "$remote_addr" for v in forwarded), forwarded  # never append the client's value
    assert re.search(r"^\s*server_tokens\s+off;", conf, re.M)
    assets = re.search(r"location ~\* \\\.\(js[^{]*\{(.*?)\}", conf, re.S).group(1)
    assert "add_header" not in assets  # an add_header here would drop the server-level CSP for JS, CSS and fonts


# -- Audit run 1: API-key revocation, httpx log leak, chatty revoked socket ------

SIGNAL = {"component_id": "CACHE_KEY", "signal_type": "ERROR", "message": "boom"}


@pytest.mark.usefixtures("clean_state")
@pytest.mark.parametrize("recovery", ["password_change", "admin_reset", "deactivate"])
async def test_api_key_does_not_survive_account_recovery(client, make_user, recovery):
    user, admin = await make_user("sre"), await make_user("admin")
    key = await api_key_for(client, user)
    assert (await client.post("/api/signals", json=SIGNAL, headers={"X-API-Key": key})).status_code == 202

    if recovery == "password_change":
        r = await client.post("/api/auth/password", headers=bearer(user),
                              json={"current_password": user["password"], "new_password": "A-brand-new-pass-77"})
    elif recovery == "admin_reset":
        r = await client.patch(f"/api/auth/users/{user['id']}", headers=bearer(admin),
                               json={"password": "A-brand-new-pass-77"})
    else:
        r = await client.patch(f"/api/auth/users/{user['id']}", headers=bearer(admin), json={"is_active": False})
        await client.patch(f"/api/auth/users/{user['id']}", headers=bearer(admin), json={"is_active": True})
    assert r.status_code == 200

    assert (await client.post("/api/signals", json=SIGNAL, headers={"X-API-Key": key})).status_code == 401


def test_httpx_request_urls_are_not_logged():
    import logging
    from app.core.logging import setup_logging

    setup_logging()
    assert not logging.getLogger("httpx").isEnabledFor(logging.INFO)
    assert not logging.getLogger("httpcore").isEnabledFor(logging.INFO)


class ChattySocket(IdleSocket):
    """A revoked user's modified client: sends a frame every few ms, so the old idle timeout never fired."""

    async def receive_text(self):
        await asyncio.sleep(0.01)
        return "x"


@pytest.mark.usefixtures("clean_state")
async def test_a_chatty_revoked_socket_is_still_closed_at_the_deadline(make_user):
    from app.routers.ws import websocket_endpoint
    from app.services.ws_manager import manager

    user = await make_user("sre")
    ws = ChattySocket(create_access_token({"sub": user["id"], "role": "sre", "tv": 0}))
    async with AsyncSessionLocal() as db:
        await db.execute(update(User).where(User.id == user["id"]).values(is_active=False))
        await db.commit()
    with patch("app.routers.ws.WS_RECHECK_SECONDS", 0.1):
        await asyncio.wait_for(websocket_endpoint(ws), 2)

    assert ws.closed_with == [1008]
    assert ws not in manager._connections
