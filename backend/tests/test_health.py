"""Health: /health reports dependencies and returns 503 when degraded; /health/live is liveness only."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.exc import OperationalError

from app.db.postgres import get_db
from app.main import app
from app.services import ingestion

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]


class _BrokenSession:
    async def execute(self, *args, **kwargs):
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))


async def _broken_db():
    yield _BrokenSession()


@pytest.fixture
def postgres_down():
    app.dependency_overrides[get_db] = _broken_db
    yield
    app.dependency_overrides.pop(get_db, None)


def redis_down():
    return patch("app.db.cache.health_check", new_callable=AsyncMock, return_value=False)


async def test_healthy_returns_200(client):
    r = await client.get("/health")

    assert r.status_code == 200
    assert r.json()["status"] == "ok"


async def test_redis_down_returns_503(client, make_headers):
    """Regression for B-26: /health always said 200."""
    headers = await make_headers("viewer")  # the detail is for signed-in users; anonymous callers get the status
    with redis_down():
        r = await client.get("/health", headers=headers)

    assert r.status_code == 503
    assert r.json()["redis"] == "error"


async def test_postgres_down_returns_503(client, postgres_down):
    r = await client.get("/health")

    assert r.status_code == 503
    assert r.json() == {"status": "degraded"}  # no DB, so no token check: the detail stays private


async def test_saturated_queue_returns_503(client, make_headers):
    headers = await make_headers("viewer")
    nearly_full = asyncio.Queue(maxsize=10)
    for i in range(9):
        nearly_full.put_nowait(i)

    with patch("app.routers.health._queue", nearly_full):
        r = await client.get("/health", headers=headers)

    assert r.status_code == 503
    assert r.json()["queue"] == "saturated"


async def test_not_accepting_during_shutdown_returns_503(client, make_headers, monkeypatch):
    headers = await make_headers("viewer")
    monkeypatch.setattr(ingestion, "_accepting", False)

    r = await client.get("/health", headers=headers)

    assert r.status_code == 503
    assert r.json()["accepting"] is False


async def test_liveness_ignores_dependencies(client, postgres_down):
    with redis_down():
        r = await client.get("/health/live")

    assert r.status_code == 200
