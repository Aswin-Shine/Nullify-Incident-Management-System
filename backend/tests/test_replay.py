"""replay-lake: store lake lines that never reached Postgres (work_item_id null), e.g. after an outage or a spill."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.cli import main, replay_lake
from app.core.config import get_settings
from app.db.nosql import append_signal
from app.db.postgres import AsyncSessionLocal, Signal, WorkItem

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]

TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")


@pytest.fixture(autouse=True)
def own_lake(tmp_path, monkeypatch):
    """The session lake holds other tests' null lines; replay must see only this test's."""
    monkeypatch.setattr(get_settings(), "lake_dir", str(tmp_path))


def lost(component="RDBMS_REPLAY", minutes_ago=30, **extra):
    """A lake line as process_signal or _spill writes it when the signal never got an incident."""
    received = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return {"component_id": component, "signal_type": "ERROR", "message": "conn refused", "severity": "HIGH",
            "metadata": {}, "timestamp": (received - timedelta(seconds=5)).isoformat(),
            "received_at": received.isoformat(), "work_item_id": None, **extra}


async def counts():
    async with AsyncSessionLocal() as db:
        signals = (await db.execute(select(func.count()).select_from(Signal))).scalar_one()
        items = (await db.execute(select(WorkItem))).scalars().all()
    return signals, items


async def test_replay_persists_null_lines_with_original_times():
    line = lost()
    await append_signal(line)

    result = await replay_lake(TODAY)

    assert result["replayed"] == 1
    async with AsyncSessionLocal() as db:
        [s] = (await db.execute(select(Signal))).scalars().all()
        [wi] = (await db.execute(select(WorkItem))).scalars().all()
    assert s.received_at == datetime.fromisoformat(line["received_at"])
    assert s.occurred_at == datetime.fromisoformat(line["timestamp"])
    assert wi.start_time == s.occurred_at  # MTTR counts from when it broke, not from the replay


async def test_replay_is_idempotent():
    await append_signal(lost(minutes_ago=30))
    await append_signal(lost(minutes_ago=29))

    first = await replay_lake(TODAY)
    second = await replay_lake(TODAY)

    assert first["replayed"] == 2
    assert (second["replayed"], second["skipped"]) == (0, 2)
    signals, [wi] = await counts()
    assert (signals, wi.signal_count) == (2, 2)


async def test_replay_keeps_distinct_signals_received_in_the_same_microsecond():
    """Found live: 4 worker processes stamp a burst's signals with equal received_at; each must still replay."""
    twin = lost()
    await append_signal({**twin, "signal_id": "a" * 32})
    await append_signal({**twin, "signal_id": "b" * 32})

    first = await replay_lake(TODAY)
    second = await replay_lake(TODAY)

    assert first["replayed"] == 2
    assert (second["replayed"], second["skipped"]) == (0, 2)
    signals, [wi] = await counts()
    assert (signals, wi.signal_count) == (2, 2)


async def test_replay_opens_incident_and_notifies(mock_webhooks):
    await append_signal(lost("RDBMS_PAGED"))

    await replay_lake(TODAY)

    _, [wi] = await counts()
    assert wi.component == "RDBMS_PAGED"
    mock_webhooks["created"].assert_called_once()


async def test_replay_skips_lines_that_already_have_an_incident():
    await append_signal(lost(work_item_id="already-linked"))

    result = await replay_lake(TODAY)

    assert result["replayed"] == 0
    assert await counts() == (0, [])


async def test_replay_dry_run_changes_nothing():
    await append_signal(lost())

    result = await replay_lake(TODAY, dry_run=True)

    assert result["to_replay"] == 1
    assert await counts() == (0, [])


async def test_replay_ignores_days_before_since():
    await append_signal(lost())
    tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")

    assert (await replay_lake(tomorrow))["replayed"] == 0


async def test_cli_rejects_a_bad_since_date():
    with pytest.raises(SystemExit):
        main(["replay-lake", "--since", "07-10-2026"])
