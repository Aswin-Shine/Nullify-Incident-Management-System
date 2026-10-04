"""B-25: the State and Strategy patterns carry real behaviour (next states, entry guards, channels)."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from app.models.schemas import SignalPayload
from app.services.alert_strategy import (
    APIAlertStrategy, CacheAlertStrategy, DefaultAlertStrategy, MCPAlertStrategy,
    QueueAlertStrategy, RDBMSAlertStrategy, get_alert_strategy,
)
# Imported at module load: the autouse `mock_webhooks` fixture replaces the module attributes per test.
from app.services.webhooks import notify_incident_created as real_notify_created
from app.services.webhooks import notify_status_change as real_notify_changed
from app.services.state_machine import (
    ClosedState, InvestigatingState, OpenState, ResolvedState, get_state,
)
from app.services.ingestion import process_signal

PAGE = ("pagerduty", "slack")
SLACK_ONLY = ("slack",)


# -- State pattern -----------------------------------------------------------

def test_transition_returns_the_target_state_object():
    assert isinstance(get_state("OPEN").transition_to("INVESTIGATING"), InvestigatingState)
    assert isinstance(get_state("INVESTIGATING").transition_to("RESOLVED"), ResolvedState)
    assert isinstance(get_state("RESOLVED").transition_to("CLOSED"), ClosedState)


def test_only_closed_state_has_entry_conditions():
    assert [s.entry_conditions("wi-1") for s in (OpenState(), InvestigatingState(), ResolvedState())] == [[], [], []]
    assert len(ClosedState().entry_conditions("wi-1")) == 1
    assert ClosedState().guard_message == "Cannot CLOSE: RCA record missing."


@pytest.mark.asyncio
@pytest.mark.usefixtures("clean_state")
async def test_close_without_rca_returns_the_states_own_guard_message(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(
        {"component_id": "RDBMS_PRIMARY", "signal_type": "ERROR", "message": "down", "metadata": {}})
    for status in ("INVESTIGATING", "RESOLVED"):
        r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": status, "note": "Failed over"}, headers=headers)
        assert r.status_code == 200

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "CLOSED"}, headers=headers)

    assert r.status_code == 422
    assert r.json()["detail"] == ClosedState().guard_message


# -- Strategy pattern --------------------------------------------------------

def test_explicit_component_type_wins_over_the_name():
    assert get_alert_strategy("PRIMARY_DB", "CACHE").priority() == "P2"
    assert isinstance(get_alert_strategy("ANYTHING", "MCP"), MCPAlertStrategy)


def test_name_is_matched_by_token_not_only_by_prefix():
    assert get_alert_strategy("PRIMARY_DB").priority() == "P0"
    assert get_alert_strategy("EU-WEST-REDIS").priority() == "P2"


@pytest.mark.parametrize("component,priority", [
    ("RDBMS_PRIMARY", "P0"), ("CACHE_CLUSTER_01", "P2"), ("KAFKA_BROKER_01", "P1"),
    ("MCP_HOST_01", "P1"), ("API_GATEWAY", "P1"), ("UNKNOWN_XYZ", "P3"),
])
def test_existing_name_priorities_are_unchanged(component, priority):
    assert get_alert_strategy(component).priority() == priority


def test_strategies_declare_their_notification_channels():
    for strategy in (RDBMSAlertStrategy(), QueueAlertStrategy(), APIAlertStrategy(), MCPAlertStrategy()):
        assert strategy.channels == PAGE
    for strategy in (CacheAlertStrategy(), DefaultAlertStrategy()):
        assert strategy.channels == SLACK_ONLY


@pytest.mark.asyncio
async def test_created_incident_pages_pagerduty_only_when_the_strategy_has_that_channel():
    with patch("app.services.webhooks._pagerduty_trigger", new_callable=AsyncMock) as page, \
            patch("app.services.webhooks._slack_notify", new_callable=AsyncMock) as slack:
        await real_notify_created({"id": "1", "component": "RDBMS_PRIMARY", "priority": "P0", "title": "t"})
        assert (page.call_count, slack.call_count) == (1, 1)

        # The priority field says P0, but the component is a cache: the strategy decides.
        await real_notify_created({"id": "2", "component": "CACHE_X", "priority": "P0", "title": "t"})
        assert (page.call_count, slack.call_count) == (1, 2)

        # An explicit type beats the name.
        await real_notify_created(
            {"id": "3", "component": "PRIMARY_DB", "component_type": "CACHE", "priority": "P0", "title": "t"})
        assert (page.call_count, slack.call_count) == (1, 3)


@pytest.mark.asyncio
async def test_resolving_pages_pagerduty_only_when_the_strategy_has_that_channel():
    with patch("app.services.webhooks._pagerduty_resolve", new_callable=AsyncMock) as resolve, \
            patch("app.services.webhooks._slack_notify", new_callable=AsyncMock):
        await real_notify_changed({"id": "1", "component": "RDBMS_PRIMARY", "priority": "P0"}, "RESOLVED")
        await real_notify_changed({"id": "2", "component": "CACHE_X", "priority": "P2"}, "RESOLVED")
        assert resolve.call_count == 1


@pytest.mark.asyncio
async def test_resolving_pages_pagerduty_when_the_priority_came_from_component_type():
    """B-33: the work item does not store component_type, so the name alone said Slack only."""
    with patch("app.services.webhooks._pagerduty_resolve", new_callable=AsyncMock) as resolve, \
            patch("app.services.webhooks._slack_notify", new_callable=AsyncMock):
        await real_notify_changed({"id": "1", "component": "ORDERS_MAIN", "priority": "P0"}, "RESOLVED")
        assert resolve.call_count == 1


def test_channels_for_priority_matches_every_strategy():
    """Drift guard: status changes derive channels from the stored priority, creation from the strategy."""
    from app.services.alert_strategy import channels_for_priority
    for strategy in (RDBMSAlertStrategy(), CacheAlertStrategy(), QueueAlertStrategy(), APIAlertStrategy(),
                     MCPAlertStrategy(), DefaultAlertStrategy()):
        assert strategy.channels == channels_for_priority(strategy.priority()), type(strategy).__name__


# -- component_type on the signal payload ------------------------------------

def _payload(**extra):
    return {"component_id": "PRIMARY_DB", "signal_type": "ERROR", "message": "x", **extra}


@pytest.mark.parametrize("value", ["RDBMS", "CACHE", "QUEUE", "API", "MCP"])
def test_component_type_accepts_the_known_types(value):
    assert SignalPayload(**_payload(component_type=value)).component_type == value


def test_component_type_is_optional_and_rejects_unknown_values():
    assert SignalPayload(**_payload()).component_type is None
    with pytest.raises(ValidationError):
        SignalPayload(**_payload(component_type="TOASTER"))


@pytest.mark.asyncio
@pytest.mark.usefixtures("clean_state")
async def test_api_rejects_unknown_component_type(client, make_headers):
    r = await client.post("/api/signals", json=_payload(component_type="TOASTER"),
                          headers=await make_headers("sre"))
    assert r.status_code == 422


@pytest.mark.asyncio
@pytest.mark.usefixtures("clean_state")
async def test_component_type_sets_priority_and_reaches_the_notifier(mock_webhooks):
    from sqlalchemy import select
    from app.db.postgres import AsyncSessionLocal, WorkItem

    wi_id = await process_signal({**_payload(component_type="CACHE"), "metadata": {}})
    await asyncio.sleep(0.05)  # the notifier runs as a background task

    async with AsyncSessionLocal() as db:
        assert (await db.execute(select(WorkItem.priority).where(WorkItem.id == wi_id))).scalar_one() == "P2"
    sent = mock_webhooks["created"].call_args.args[0]
    assert sent["component_type"] == "CACHE"
