"""Test fixtures: real Postgres (a throwaway *_test database built by Alembic) + Redis db 15.

Postgres-only SQL (ON CONFLICT ... WHERE, conditional UPDATE ... RETURNING) is part of the
behaviour under test, so there is no SQLite fallback. Needs local Postgres + Redis reachable
with the credentials in backend/.env.
"""
import asyncio
import os
import tempfile
import uuid

# Must run before any `app` import: settings and the engine are built at import time.
os.environ["DB_NAME"] = os.environ.get("TEST_DB_NAME", "ims_test")
os.environ["REDIS_DB"] = "15"
os.environ["LAKE_DIR"] = tempfile.mkdtemp(prefix="nullify-lake-")
os.environ["OTLP_ENDPOINT"] = ""

import asyncpg
import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text
from unittest.mock import AsyncMock, patch

from app.core.config import get_settings

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TRUNCATE_ALL = """
DO $$ BEGIN
  EXECUTE (SELECT 'TRUNCATE ' || string_agg(quote_ident(tablename), ', ') || ' RESTART IDENTITY CASCADE'
           FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version');
END $$;
"""


@pytest.fixture(scope="session")
def event_loop():
    # One loop for the whole run: the app's asyncpg pool is bound to the loop that created it.
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
def test_database():
    """Drop, recreate and migrate the test database once per run."""
    s = get_settings()
    assert s.db_name.endswith("_test"), f"refusing to recreate non-test database {s.db_name!r}"

    async def recreate():
        conn = await asyncpg.connect(
            user=s.db_user, password=s.db_password, host=s.db_host, port=s.db_port, database="postgres"
        )
        try:
            await conn.execute(f'DROP DATABASE IF EXISTS "{s.db_name}" WITH (FORCE)')
            await conn.execute(f'CREATE DATABASE "{s.db_name}"')
        finally:
            await conn.close()

    asyncio.run(recreate())
    cfg = Config()  # no ini file, so alembic does not reconfigure logging
    cfg.set_main_option("script_location", os.path.join(BACKEND_DIR, "alembic"))
    command.upgrade(cfg, "head")


@pytest_asyncio.fixture
async def clean_state(test_database):
    """Empty every table and the Redis test db before each DB-backed test."""
    from app.db import cache
    from app.db.postgres import engine

    async with engine.begin() as conn:
        await conn.execute(text(TRUNCATE_ALL))
    await cache.init_redis()
    await cache._r().flushdb()
    yield
    await cache.close_redis()


@pytest.fixture(autouse=True)
def mock_webhooks():
    """No outbound Slack/PagerDuty calls in tests."""
    with patch("app.services.webhooks.notify_incident_created", new_callable=AsyncMock) as created, \
         patch("app.services.webhooks.notify_status_change", new_callable=AsyncMock) as changed:
        yield {"created": created, "changed": changed}


@pytest_asyncio.fixture
async def client(clean_state):
    from app.main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def make_headers(clean_state):
    """Factory: insert a user with the given role and return Bearer auth headers."""
    from app.core.security import create_access_token, hash_password
    from app.db.postgres import AsyncSessionLocal, User

    async def _make(role: str = "sre") -> dict:
        uid = str(uuid.uuid4())
        async with AsyncSessionLocal() as db:
            db.add(User(id=uid, username=f"u_{uid[:8]}", email=f"{uid[:8]}@ims.test",
                        hashed_password=hash_password("x"), role=role))
            await db.commit()
        return {"Authorization": f"Bearer {create_access_token({'sub': uid, 'role': role})}"}

    return _make
