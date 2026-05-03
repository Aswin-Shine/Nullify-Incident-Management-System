"""Work Item State Machine — State design pattern.

Valid transitions:
  OPEN → INVESTIGATING
  INVESTIGATING → RESOLVED
  RESOLVED → CLOSED  (blocked if RCA missing)
"""
from __future__ import annotations
from abc import ABC, abstractmethod


class InvalidTransitionError(Exception):
    pass


class WorkItemState(ABC):
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def transition_to(self, new_status: str) -> "WorkItemState": ...


class OpenState(WorkItemState):
    def name(self) -> str:
        return "OPEN"

    def transition_to(self, new_status: str) -> WorkItemState:
        if new_status == "INVESTIGATING":
            return InvestigatingState()
        raise InvalidTransitionError(f"Cannot go from OPEN → {new_status}")


class InvestigatingState(WorkItemState):
    def name(self) -> str:
        return "INVESTIGATING"

    def transition_to(self, new_status: str) -> WorkItemState:
        if new_status == "RESOLVED":
            return ResolvedState()
        raise InvalidTransitionError(f"Cannot go from INVESTIGATING → {new_status}")


class ResolvedState(WorkItemState):
    def name(self) -> str:
        return "RESOLVED"

    def transition_to(self, new_status: str) -> WorkItemState:
        if new_status == "CLOSED":
            return ClosedState()
        raise InvalidTransitionError(f"Cannot go from RESOLVED → {new_status}")


class ClosedState(WorkItemState):
    def name(self) -> str:
        return "CLOSED"

    def transition_to(self, new_status: str) -> WorkItemState:
        raise InvalidTransitionError("Work item is already CLOSED. No further transitions allowed.")


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


def validate_transition(current_status: str, new_status: str) -> None:
    """Raises InvalidTransitionError if transition not allowed."""
    state = get_state(current_status)
    state.transition_to(new_status)  # throws if invalid
