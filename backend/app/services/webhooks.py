"""Webhook notifications: Slack + PagerDuty."""
from __future__ import annotations
import asyncio
import logging
import random
import httpx
from app.core.config import get_settings
from app.core.metrics import NOTIFICATIONS_FAILED
from app.services.alert_strategy import channels_for_priority, get_alert_strategy

logger = logging.getLogger("ims.webhooks")
settings = get_settings()

PRIORITY_EMOJI = {"P0": "🔴", "P1": "🟠", "P2": "🟡", "P3": "🟢"}
PAGERDUTY_SEVERITY = {"P0": "critical", "P1": "error", "P2": "warning", "P3": "info"}
PAGERDUTY_URL = "https://events.pagerduty.com/v2/enqueue"
RETRY_DELAYS = (0.5, 1, 2)  # backoff before attempts 2, 3 and 4
MAX_RETRY_AFTER = 10.0      # a 429's Retry-After is honoured up to this


_background: set[asyncio.Task] = set()


def spawn(coro) -> asyncio.Task:
    """Run a notification in the background. The loop holds tasks weakly, so keep one until it is done."""
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)
    return task


async def drain(timeout: float) -> int:
    """Wait up to `timeout` seconds for notifications in flight, so a deploy does not cut a page off; cancel the
    rest. Returns how many were cancelled."""
    if not _background:
        return 0
    _, pending = await asyncio.wait(set(_background), timeout=timeout)
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    return len(pending)


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=5)


def _retry_after(response: httpx.Response) -> float | None:
    try:
        return min(float(response.headers["Retry-After"]), MAX_RETRY_AFTER)
    except (KeyError, ValueError):
        return None  # absent, or an HTTP date: use the backoff


async def _post(channel: str, url: str, payload: dict) -> bool:
    """POST, retrying network errors, 429 and 5xx with backoff. Once it gives up the failure is logged and counted
    (nullify_notifications_failed_total, alerted on) and False is returned; it never raises."""
    async with _client() as client:
        for backoff in (*RETRY_DELAYS, None):
            wait = None
            try:
                r = await client.post(url, json=payload)
                if r.is_success:
                    return True
                problem = f"HTTP {r.status_code}"
                if r.status_code != 429 and r.status_code < 500:
                    break  # any other 4xx fails the same way again
                wait = _retry_after(r)
            except httpx.TransportError as e:
                problem = f"{type(e).__name__}: {e}"
            except Exception as e:  # a bad URL or payload: retrying cannot help
                problem = f"{type(e).__name__}: {e}"
                break
            if backoff is None:
                break
            await asyncio.sleep(wait if wait is not None else backoff + random.uniform(0, backoff / 2))
    logger.warning("%s notification failed after retries: %s", channel, problem)
    NOTIFICATIONS_FAILED.labels(channel=channel).inc()
    return False


def _channels(work_item: dict) -> tuple[str, ...]:
    return get_alert_strategy(work_item.get("component", ""), work_item.get("component_type")).channels


async def notify_incident_created(work_item: dict):
    """Notify the channels the component's alert strategy declares (PagerDuty pages P0/P1 only)."""
    channels = _channels(work_item)
    if "pagerduty" in channels:
        await _pagerduty_trigger(work_item)
    if "slack" in channels:
        await _slack_notify(work_item, event="created")


async def notify_status_change(work_item: dict, new_status: str):
    # The stored priority decides, not the name: the incident may have been created from a component_type.
    channels = channels_for_priority(work_item.get("priority", "P3"))
    if "slack" in channels:
        await _slack_notify(work_item, event="status_change", extra={"new_status": new_status})
    if new_status == "RESOLVED" and "pagerduty" in channels:
        await _pagerduty_resolve(work_item)


def _slack_escape(value) -> str:
    """Slack mrkdwn treats <...> as links and mentions; producer text (component, signal type) must stay plain."""
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def _slack_notify(work_item: dict, event: str, extra: dict | None = None):
    if not settings.slack_webhook_url:
        return
    priority = work_item.get("priority", "P3")
    emoji = PRIORITY_EMOJI.get(priority, "⚪")
    wi_id = work_item.get("id", "")[:8]

    if event == "created":
        text = f"{emoji} *New Incident* [{priority}] `{wi_id}` - {_slack_escape(work_item.get('title'))}"
        color = "#FF3B3B" if priority == "P0" else "#FF8C00" if priority == "P1" else "#F5C518"
    else:
        new_status = extra.get("new_status", "") if extra else ""
        text = f"📋 *Incident Updated* `{wi_id}` → `{new_status}`"
        color = "#4ADE80" if new_status == "CLOSED" else "#6366F1"

    payload = {
        "attachments": [{
            "color": color,
            "text": text,
            "fields": [
                {"title": "Component", "value": _slack_escape(work_item.get("component", "")), "short": True},
                {"title": "Priority", "value": priority, "short": True},
            ],
            "footer": "Nullify Alert",
        }]
    }
    # ponytail: a timeout Slack did apply gets posted twice; Slack webhooks have no idempotency key
    await _post("slack", settings.slack_webhook_url, payload)


async def _pagerduty_trigger(work_item: dict):
    if not settings.pagerduty_routing_key:
        return
    priority = work_item.get("priority", "P3")
    payload = {
        "routing_key": settings.pagerduty_routing_key,
        "event_action": "trigger",
        "dedup_key": work_item.get("id"),
        "payload": {
            "summary": f"[{priority}] {work_item.get('title')}",
            "source": work_item.get("component"),
            "severity": PAGERDUTY_SEVERITY.get(priority, "info"),
            "custom_details": {
                "component": work_item.get("component"),
                "description": work_item.get("description"),
            },
        },
    }
    await _post("pagerduty", PAGERDUTY_URL, payload)  # retries are safe: dedup_key is the incident id


async def _pagerduty_resolve(work_item: dict):
    if not settings.pagerduty_routing_key:
        return
    payload = {
        "routing_key": settings.pagerduty_routing_key,
        "event_action": "resolve",
        "dedup_key": work_item.get("id"),
    }
    await _post("pagerduty", PAGERDUTY_URL, payload)
