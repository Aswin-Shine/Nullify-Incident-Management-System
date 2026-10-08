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


async def test_redis_down_stays_ready_and_reports_it(client, make_headers):
    """Ingestion works without Redis (the limiter fails open, live updates fall back to local delivery), so a Redis
    blip must not take every replica out of a load balancer (architecture review M3). It is still reported."""
    headers = await make_headers("viewer")  # the detail is for signed-in users; anonymous callers get the status
    with redis_down():
        r = await client.get("/health", headers=headers)

    assert r.status_code == 200
    assert (r.json()["status"], r.json()["redis"]) == ("ok", "error")


async def test_postgres_down_returns_503(client, postgres_down):
    r = await client.get("/health")

    assert r.status_code == 503
    assert r.json() == {"status": "degraded"}  # no DB, so no token check: the detail stays private


async def test_saturated_queue_stays_ready_and_reports_it(client, make_headers):
    """The queue seen here is one random worker's; the 429 already pushes back. Reported, not gating."""
    headers = await make_headers("viewer")
    nearly_full = asyncio.Queue(maxsize=10)
    for i in range(9):
        nearly_full.put_nowait(i)

    with patch("app.routers.health._queue", nearly_full):
        r = await client.get("/health", headers=headers)

    assert r.status_code == 200
    assert r.json()["queue"] == "saturated"


async def test_ingest_blocked_on_the_database_returns_503(client, make_headers, monkeypatch):
    headers = await make_headers("viewer")
    monkeypatch.setattr(ingestion, "_db_down", True)

    r = await client.get("/health", headers=headers)

    assert r.status_code == 503
    assert r.json()["ingest"] == "db_down"


async def test_timeseries_leaves_out_buckets_older_than_the_window(client, make_headers):
    """It used to group the whole retained table (30 days) to draw the last hour."""
    from datetime import datetime, timedelta, timezone
    from app.db.postgres import AsyncSessionLocal, TimeseriesAgg
    headers = await make_headers("viewer")
    now = datetime.now(timezone.utc)
    recent, old = (t.strftime("%Y-%m-%dT%H:%M") for t in (now, now - timedelta(hours=2)))
    async with AsyncSessionLocal() as db:
        db.add_all([TimeseriesAgg(bucket=b, component="RDBMS_TS", signal_count=1) for b in (recent, old)])
        await db.commit()

    for params in ({"limit": 60}, {"limit": 60, "component": "RDBMS_TS"}):
        r = await client.get("/api/timeseries", params=params, headers=headers)
        assert [row["bucket"] for row in r.json()] == [recent], params


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
