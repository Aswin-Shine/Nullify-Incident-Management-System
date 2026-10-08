"""The schema the code runs against is the one Alembic built (architecture review M5)."""
from unittest.mock import AsyncMock, patch

import pytest
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext

from app.db.postgres import Base, engine, schema_revisions

pytestmark = pytest.mark.asyncio


async def test_the_test_database_is_at_the_code_head():
    current, head = await schema_revisions()

    assert current == head is not None


async def test_startup_refuses_a_database_behind_the_code():
    from app import main
    with patch.object(main, "schema_revisions", AsyncMock(return_value=("0008", "0009"))), \
         patch.object(main, "init_redis", AsyncMock()) as redis:
        with pytest.raises(RuntimeError, match="alembic upgrade head"):
            async with main.lifespan(main.app):
                pass

    redis.assert_not_awaited()  # it stops before starting anything


async def test_models_match_the_migrations():
    """An autogenerate diff of the ORM models against a DB built by the migrations must be empty."""
    async with engine.connect() as conn:
        diff = await conn.run_sync(lambda c: compare_metadata(MigrationContext.configure(c), Base.metadata))

    assert diff == []
