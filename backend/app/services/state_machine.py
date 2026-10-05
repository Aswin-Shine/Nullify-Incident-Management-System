"""Work Item State Machine: State design pattern.

Each state knows which state may follow it, and what must be true in the database to enter it:
  OPEN -> INVESTIGATING -> RESOLVED -> CLOSED   (entering CLOSED needs an RCA record)
"""
from __future__ import annotations
from abc import ABC, abstractmethod

from sqlalchemy import exists

from app.db.postgres import RCARecord


class InvalidTransitionError(Exception):
    pass


class WorkItemState(ABC):
    guard_message = ""  # the reason to give when entry_conditions rejects the change

    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def next_state(self) -> "WorkItemState | None":
        """The one state this state may move to, or None for a terminal state."""

    def transition_to(self, new_status: str) -> "WorkItemState":
        """The target state object if `new_status` is an allowed next state, else InvalidTransitionError."""
        nxt = self.next_state()
        if nxt is not None and nxt.name() == new_status:
            return nxt
        raise InvalidTransitionError(f"Cannot go from {self.name()} → {new_status}")

    def entry_conditions(self, wi_id: str) -> list:
        """SQL WHERE clauses that must hold for a work item to enter this state (none by default)."""
        return []


class OpenState(WorkItemState):
    def name(self) -> str:
        return "OPEN"

    def next_state(self) -> WorkItemState:
        return InvestigatingState()


class InvestigatingState(WorkItemState):
    def name(self) -> str:
        return "INVESTIGATING"

    def next_state(self) -> WorkItemState:
        return ResolvedState()


class ResolvedState(WorkItemState):
    def name(self) -> str:
        return "RESOLVED"

    def next_state(self) -> WorkItemState:
        return ClosedState()


class ClosedState(WorkItemState):
    guard_message = "Cannot CLOSE: RCA record missing."

    def name(self) -> str:
        return "CLOSED"

    def next_state(self) -> None:
        return None

    def transition_to(self, new_status: str) -> WorkItemState:
        raise InvalidTransitionError("Work item is already CLOSED. No further transitions allowed.")

    def entry_conditions(self, wi_id: str) -> list:
        return [exists().where(RCARecord.work_item_id == wi_id)]


_STATE_MAP: dict[str, WorkItemState] = {
    "OPEN": OpenState(),
    "INVESTIGATING": InvestigatingState(),
    "RESOLVED": ResolvedState(),
    "CLOSED": ClosedState(),
}


def get_state(status: str) -> WorkItemState:
    state = _STATE_MAP.get(status)
    if not state:
        raise ValueError(f"Unknown status: {status}")
    return state

