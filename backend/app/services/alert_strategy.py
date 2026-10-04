"""Alerting Strategy: Strategy design pattern.

Each component type maps to an AlertStrategy that decides priority, notification text and which
channels are notified (PagerDuty pages only for P0/P1).
"""
from __future__ import annotations
import re
from abc import ABC, abstractmethod

PAGE_AND_SLACK = ("pagerduty", "slack")
SLACK_ONLY = ("slack",)


def channels_for_priority(priority: str) -> tuple[str, ...]:
    """Channels for a stored priority: every strategy pairs P0/P1 with paging and P2/P3 with Slack only.
    Used for status changes, where the work item has a priority but not the signal's component_type."""
    return PAGE_AND_SLACK if priority in ("P0", "P1") else SLACK_ONLY


class AlertStrategy(ABC):
    channels: tuple[str, ...] = SLACK_ONLY

    @abstractmethod
    def priority(self) -> str: ...

    @abstractmethod
    def notify(self, component: str, message: str) -> str: ...


class RDBMSAlertStrategy(AlertStrategy):
    channels = PAGE_AND_SLACK

    def priority(self) -> str:
        return "P0"

    def notify(self, component: str, message: str) -> str:
        return f"[P0 CRITICAL] RDBMS failure on {component}: {message}. Immediate DBA escalation required."


class CacheAlertStrategy(AlertStrategy):
    def priority(self) -> str:
        return "P2"

    def notify(self, component: str, message: str) -> str:
        return f"[P2 MEDIUM] Cache failure on {component}: {message}. Monitor hit-rate degradation."


class QueueAlertStrategy(AlertStrategy):
    channels = PAGE_AND_SLACK

    def priority(self) -> str:
        return "P1"

    def notify(self, component: str, message: str) -> str:
        return f"[P1 HIGH] Async queue failure on {component}: {message}. Check consumer lag."


class APIAlertStrategy(AlertStrategy):
    channels = PAGE_AND_SLACK

    def priority(self) -> str:
        return "P1"

    def notify(self, component: str, message: str) -> str:
        return f"[P1 HIGH] API failure on {component}: {message}. Check error rate & latency."


class MCPAlertStrategy(AlertStrategy):
    channels = PAGE_AND_SLACK

    def priority(self) -> str:
        return "P1"

    def notify(self, component: str, message: str) -> str:
        return f"[P1 HIGH] MCP Host failure on {component}: {message}. Check agent orchestration."


class DefaultAlertStrategy(AlertStrategy):
    def priority(self) -> str:
        return "P3"

    def notify(self, component: str, message: str) -> str:
        return f"[P3 LOW] Failure on {component}: {message}."


_COMPONENT_STRATEGY_MAP: dict[str, type[AlertStrategy]] = {
    "RDBMS": RDBMSAlertStrategy,
    "DB": RDBMSAlertStrategy,
    "POSTGRES": RDBMSAlertStrategy,
    "MYSQL": RDBMSAlertStrategy,
    "CACHE": CacheAlertStrategy,
    "REDIS": CacheAlertStrategy,
    "MEMCACHED": CacheAlertStrategy,
    "QUEUE": QueueAlertStrategy,
    "KAFKA": QueueAlertStrategy,
    "RABBITMQ": QueueAlertStrategy,
    "SQS": QueueAlertStrategy,
    "API": APIAlertStrategy,
    "SERVICE": APIAlertStrategy,
    "MCP": MCPAlertStrategy,
}


def get_alert_strategy(component_id: str, component_type: str | None = None) -> AlertStrategy:
    """An explicit component type (RDBMS, CACHE, QUEUE, API, MCP) wins; otherwise the first name token
    that is a known key (PRIMARY_DB -> DB -> RDBMS, CACHE_CLUSTER_01 -> CACHE)."""
    tokens = ([component_type.upper()] if component_type else []) + re.split(r"[_.-]", component_id.upper())
    for token in tokens:
        if token in _COMPONENT_STRATEGY_MAP:
            return _COMPONENT_STRATEGY_MAP[token]()
    return DefaultAlertStrategy()
