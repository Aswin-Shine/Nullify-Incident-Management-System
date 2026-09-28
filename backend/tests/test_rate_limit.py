"""Rate limiting: per-principal on ingestion, per-IP on auth, shared via Redis, fails open."""
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.config import get_settings

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]

SIG = {"component_id": "CACHE_RL", "signal_type": "ERROR", "message": "boom"}
BAD_LOGIN = {"username": "nobody", "password": "wrong"}


def frozen_clock():
    # Middle of a window, so the whole test lands in one fixed window.
    return patch("app.core.rate_limit._now", return_value=1_000_000.2)


async def test_ingest_limit_is_per_principal(client, make_headers, monkeypatch):
    """Regression for S-05: the limiter was configured but never enforced."""
    monkeypatch.setattr(get_settings(), "rate_limit_ingest_per_sec", 3)
    alice, bob = await make_headers("sre"), await make_headers("sre")

    with frozen_clock():
        responses = [await client.post("/api/signals", json=SIG, headers=alice) for _ in range(5)]
        bob_r = await client.post("/api/signals", json=SIG, headers=bob)
        alice_batch = await client.post("/api/signals/batch", json=[SIG], headers=alice)

    assert [r.status_code for r in responses] == [202, 202, 202, 429, 429]
    assert responses[-1].headers["Retry-After"] == "1"
    assert bob_r.status_code == 202            # own budget
    assert alice_batch.status_code == 429      # batch shares the principal's budget


async def test_login_limit_is_per_client_ip(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "rate_limit_auth_per_min", 2)
    from app.main import app

    with frozen_clock():
        codes = [(await client.post("/api/auth/login", json=BAD_LOGIN)).status_code for _ in range(3)]
        async with AsyncClient(transport=ASGITransport(app=app, client=("10.0.0.2", 5000)),
                               base_url="http://test") as other_ip:
            other = await other_ip.post("/api/auth/login", json=BAD_LOGIN)

    assert codes == [401, 401, 429]
    assert other.status_code == 401


async def test_limiter_fails_open_when_redis_is_down(client, make_headers, monkeypatch):
    monkeypatch.setattr(get_settings(), "rate_limit_ingest_per_sec", 1)
    headers = await make_headers("sre")

    with patch("app.core.rate_limit.cache.incr", side_effect=ConnectionError("redis down")):
        codes = [(await client.post("/api/signals", json=SIG, headers=headers)).status_code for _ in range(3)]

    assert codes == [202, 202, 202]


async def test_queue_full_429_tells_producer_when_to_retry(client, make_headers):
    headers = await make_headers("sre")

    with patch("app.services.ingestion.enqueue_signal", new_callable=AsyncMock, return_value=False):
        r = await client.post("/api/signals", json=SIG, headers=headers)

    assert r.status_code == 429
    assert r.headers["Retry-After"] == "1"
