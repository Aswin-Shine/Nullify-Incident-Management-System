"""Retention retries a failed run within the day (the claim used to be taken before the work)."""
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from app.core.config import get_settings
from app.services import retention

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]


@pytest.fixture(autouse=True)
def own_lake(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "lake_dir", str(tmp_path))


async def test_a_failed_run_is_retried_on_the_next_try():
    now = datetime.now(timezone.utc)
    with patch.object(retention, "_drop_lake_days", side_effect=OSError("disk")):
        with pytest.raises(OSError):
            await retention.purge(now)

    assert await retention.purge(now) is not None  # the next hourly try runs it


async def test_a_finished_day_is_not_run_again():
    now = datetime.now(timezone.utc)

    assert await retention.purge(now) is not None
    assert await retention.purge(now) is None
