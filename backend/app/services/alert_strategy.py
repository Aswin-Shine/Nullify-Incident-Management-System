"""Alerting Strategy — Strategy design pattern.

Each ComponentType maps to an AlertStrategy that decides priority and notification text.
"""
from __future__ import annotations
from abc import ABC, abstractmethod


class AlertStrategy(ABC):
    @abstractmethod
    def priority(self) -> str: ...

    @abstractmethod
    def notify(self, component: str, message: str) -> str: ...


class RDBMSAlertStrategy(AlertStrategy):
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
    def priority(self) -> str:
        return "P1"

    def notify(self, component: str, message: str) -> str:
        return f"[P1 HIGH] Async queue failure on {component}: {message}. Check consumer lag."


class APIAlertStrategy(AlertStrategy):
    def priority(self) -> str:
        return "P1"

    def notify(self, component: str, message: str) -> str:
        return f"[P1 HIGH] API failure on {component}: {message}. Check error rate & latency."


class MCPAlertStrategy(AlertStrategy):
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


def get_alert_strategy(component_id: str) -> AlertStrategy:
    """Resolve strategy from component_id prefix (e.g. CACHE_CLUSTER_01 → Cache)."""
    upper = component_id.upper()
    for key, cls in _COMPONENT_STRATEGY_MAP.items():
        if upper.startswith(key):
            return cls()
    return DefaultAlertStrategy()
