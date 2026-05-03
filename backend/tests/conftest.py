"""Test fixtures — in-memory SQLite for integration tests."""
import asyncio
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from unittest.mock import AsyncMock, patch

# Use SQLite for tests (no Postgres needed)
TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def test_engine():
    engine = create_async_engine(TEST_DB_URL, echo=False)
    from app.db.postgres import Base
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(test_engine):
    Session = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as session:
        yield session
        await session.rollback()


@pytest_asyncio.fixture
async def client():
    """HTTP test client with mocked DB + Redis."""
    from app.main import app
    from app.db.postgres import get_db

    # Mock Redis
    mock_cache = {}

    async def fake_set(key, value, ttl=300): mock_cache[key] = value
    async def fake_get(key): return mock_cache.get(key)
    async def fake_del(key): mock_cache.pop(key, None)
    async def fake_del_pattern(pattern): pass
    async def fake_health(): return True

    with patch("app.db.cache.set_val", side_effect=fake_set), \
         patch("app.db.cache.get_val", side_effect=fake_get), \
         patch("app.db.cache.delete_val", side_effect=fake_del), \
         patch("app.db.cache.delete_pattern", side_effect=fake_del_pattern), \
         patch("app.db.cache.health_check", side_effect=fake_health), \
         patch("app.db.cache.init_redis", new_callable=AsyncMock), \
         patch("app.db.cache.close_redis", new_callable=AsyncMock):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            yield ac