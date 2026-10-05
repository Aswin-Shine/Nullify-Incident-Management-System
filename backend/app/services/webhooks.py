"""Webhook notifications: Slack + PagerDuty."""
from __future__ import annotations
import asyncio
import logging
import httpx
from app.core.config import get_settings
from app.services.alert_strategy import channels_for_priority, get_alert_strategy

logger = logging.getLogger("ims.webhooks")
settings = get_settings()

PRIORITY_EMOJI = {"P0": "🔴", "P1": "🟠", "P2": "🟡", "P3": "🟢"}
PAGERDUTY_SEVERITY = {"P0": "critical", "P1": "error", "P2": "warning", "P3": "info"}


_background: set[asyncio.Task] = set()


def spawn(coro) -> asyncio.Task:
    """Run a notification in the background. The loop holds tasks weakly, so keep one until it is done."""
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)
    return task


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
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post(settings.slack_webhook_url, json=payload)
            if r.status_code != 200:
                logger.warning("Slack webhook returned %d", r.status_code)
    except Exception as e:
        logger.warning("Slack notify failed: %s", e)


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
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post("https://events.pagerduty.com/v2/enqueue", json=payload)
            if r.status_code not in (200, 202):
                logger.warning("PagerDuty trigger returned %d", r.status_code)
    except Exception as e:
        logger.warning("PagerDuty trigger failed: %s", e)


async def _pagerduty_resolve(work_item: dict):
    if not settings.pagerduty_routing_key:
        return
    payload = {
        "routing_key": settings.pagerduty_routing_key,
        "event_action": "resolve",
        "dedup_key": work_item.get("id"),
    }
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post("https://events.pagerduty.com/v2/enqueue", json=payload)
    except Exception as e:
        logger.warning("PagerDuty resolve failed: %s", e)
