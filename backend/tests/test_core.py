"""Unit tests — state machine, RCA validation, alert strategy."""
import pytest
from app.models.schemas import RCASubmit
from app.services.state_machine import validate_transition, InvalidTransitionError
from app.services.alert_strategy import get_alert_strategy


# ── State machine ──────────────────────────────────────────────────────────

def test_open_to_investigating():
    validate_transition("OPEN", "INVESTIGATING")

def test_investigating_to_resolved():
    validate_transition("INVESTIGATING", "RESOLVED")

def test_resolved_to_closed():
    validate_transition("RESOLVED", "CLOSED")

def test_invalid_open_to_closed():
    with pytest.raises(InvalidTransitionError):
        validate_transition("OPEN", "CLOSED")

def test_invalid_open_to_resolved():
    with pytest.raises(InvalidTransitionError):
        validate_transition("OPEN", "RESOLVED")

def test_invalid_closed_transition():
    with pytest.raises(InvalidTransitionError):
        validate_transition("CLOSED", "OPEN")

def test_invalid_backwards():
    with pytest.raises(InvalidTransitionError):
        validate_transition("RESOLVED", "OPEN")

# ── RCA validation ─────────────────────────────────────────────────────────

def test_rca_valid():
    rca = RCASubmit(
        incident_start="2024-01-01T10:00:00Z",
        incident_end="2024-01-01T12:00:00Z",
        root_cause_category="Infrastructure Failure",
        fix_applied="Restarted the DB replica",
        prevention_steps="Added automated failover",
    )
    assert rca.root_cause_category == "Infrastructure Failure"

def test_rca_invalid_category():
    with pytest.raises(Exception):
        RCASubmit(
            incident_start="2024-01-01T10:00:00Z",
            incident_end="2024-01-01T12:00:00Z",
            root_cause_category="MADE_UP",
            fix_applied="Fixed", prevention_steps="Monitor",
        )

def test_rca_empty_fix():
    with pytest.raises(Exception):
        RCASubmit(
            incident_start="2024-01-01T10:00:00Z",
            incident_end="2024-01-01T12:00:00Z",
            root_cause_category="Human Error",
            fix_applied="   ", prevention_steps="Better processes",
        )

def test_rca_empty_prevention():
    with pytest.raises(Exception):
        RCASubmit(
            incident_start="2024-01-01T10:00:00Z",
            incident_end="2024-01-01T12:00:00Z",
            root_cause_category="Human Error",
            fix_applied="Fixed", prevention_steps="",
        )

# ── Alert strategy ─────────────────────────────────────────────────────────

def test_rdbms_p0():
    assert get_alert_strategy("RDBMS_PRIMARY").priority() == "P0"

def test_cache_p2():
    assert get_alert_strategy("CACHE_CLUSTER_01").priority() == "P2"

def test_kafka_p1():
    assert get_alert_strategy("KAFKA_BROKER_01").priority() == "P1"

def test_mcp_p1():
    assert get_alert_strategy("MCP_HOST_01").priority() == "P1"

def test_default_p3():
    assert get_alert_strategy("UNKNOWN_XYZ").priority() == "P3"

# ── SLA deadline ───────────────────────────────────────────────────────────

def test_sla_minutes_p0():
    from app.services.work_item_service import SLA_MINUTES
    assert SLA_MINUTES["P0"] == 15

def test_sla_minutes_p1():
    from app.services.work_item_service import SLA_MINUTES
    assert SLA_MINUTES["P1"] == 60