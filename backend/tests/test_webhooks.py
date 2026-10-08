"""Slack and PagerDuty delivery: retries on transient failures, a failure counter, and a drain at shutdown."""
import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from prometheus_client import REGISTRY

from app.services import webhooks

pytestmark = pytest.mark.asyncio

WI = {"id": "wi-1", "component": "RDBMS_MAIN", "priority": "P0", "title": "RDBMS_MAIN - ERROR", "description": "d"}


def failed(channel):
    return REGISTRY.get_sample_value("nullify_notifications_failed_total", {"channel": channel}) or 0.0


@pytest.fixture
def endpoint(monkeypatch):
    """Answers with the given responses in order (an exception is raised as a network error); records each call."""
    monkeypatch.setattr(webhooks.settings, "pagerduty_routing_key", "rk")
    monkeypatch.setattr(webhooks.settings, "slack_webhook_url", "https://hooks.slack.test/x")
    calls = []

    def serve(*responses):
        answers = list(responses)

        def handler(request):
            calls.append(request)
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        monkeypatch.setattr(webhooks, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        return calls

    return serve


@pytest.fixture
def sleep():
    with patch("app.services.webhooks.asyncio.sleep", new_callable=AsyncMock) as s:
        yield s


async def test_pagerduty_trigger_retries_5xx_then_succeeds(endpoint, sleep):
    calls = endpoint(httpx.Response(503), httpx.Response(502), httpx.Response(202))
    before = failed("pagerduty")

    await webhooks._pagerduty_trigger(WI)

    assert len(calls) == 3
    assert sleep.await_count == 2
    assert failed("pagerduty") == before


async def test_slack_retries_network_error_then_succeeds(endpoint, sleep):
    calls = endpoint(httpx.ConnectError("refused"), httpx.Response(200))

    await webhooks._slack_notify(WI, event="created")

    assert len(calls) == 2


async def test_4xx_is_not_retried_and_counts_failure(endpoint, sleep):
    calls = endpoint(httpx.Response(400))
    before = failed("pagerduty")

    await webhooks._pagerduty_trigger(WI)

    assert len(calls) == 1
    sleep.assert_not_awaited()
    assert failed("pagerduty") == before + 1


async def test_exhausted_retries_count_one_failure_per_channel(endpoint, sleep):
    calls = endpoint(*[httpx.Response(500)] * 4)
    before_slack, before_pd = failed("slack"), failed("pagerduty")

    await webhooks._slack_notify(WI, event="created")

    assert len(calls) == 4
    assert failed("slack") == before_slack + 1
    assert failed("pagerduty") == before_pd


async def test_429_retry_after_is_honoured_and_capped(endpoint, sleep):
    endpoint(httpx.Response(429, headers={"Retry-After": "3"}),
             httpx.Response(429, headers={"Retry-After": "600"}),
             httpx.Response(202))

    await webhooks._pagerduty_trigger(WI)

    assert [c.args[0] for c in sleep.await_args_list] == [3.0, webhooks.MAX_RETRY_AFTER]


async def test_drain_waits_for_in_flight_notification():
    done = []

    async def page():
        await asyncio.sleep(0.05)
        done.append(True)

    webhooks.spawn(page())

    assert await webhooks.drain(timeout=2) == 0
    assert done == [True]


async def test_drain_cancels_after_timeout_and_reports_count():
    task = webhooks.spawn(asyncio.sleep(30))

    assert await webhooks.drain(timeout=0.01) == 1
    assert task.cancelled()
    assert not webhooks._background
