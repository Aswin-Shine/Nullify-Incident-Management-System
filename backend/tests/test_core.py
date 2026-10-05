"""Unit tests: state machine, RCA validation, alert strategy."""
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError
from app.models.schemas import RCASubmit
from app.services.state_machine import get_state, InvalidTransitionError
from app.services.alert_strategy import get_alert_strategy


# ── State machine ──────────────────────────────────────────────────────────

def test_open_to_investigating():
    get_state("OPEN").transition_to("INVESTIGATING")

def test_investigating_to_resolved():
    get_state("INVESTIGATING").transition_to("RESOLVED")

def test_resolved_to_closed():
    get_state("RESOLVED").transition_to("CLOSED")

def test_invalid_open_to_closed():
    with pytest.raises(InvalidTransitionError):
        get_state("OPEN").transition_to("CLOSED")

def test_invalid_open_to_resolved():
    with pytest.raises(InvalidTransitionError):
        get_state("OPEN").transition_to("RESOLVED")

def test_invalid_closed_transition():
    with pytest.raises(InvalidTransitionError):
        get_state("CLOSED").transition_to("OPEN")

def test_invalid_backwards():
    with pytest.raises(InvalidTransitionError):
        get_state("RESOLVED").transition_to("OPEN")

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

def _rca(start, end):
    return RCASubmit(incident_start=start, incident_end=end, root_cause_category="Human Error",
                     fix_applied="Fixed", prevention_steps="Checklist")

def test_rca_end_before_start_rejected():
    with pytest.raises(ValidationError):
        _rca("2024-01-01T12:00:00Z", "2024-01-01T10:00:00Z")

def test_rca_non_datetime_rejected():
    with pytest.raises(ValidationError):
        _rca("yesterday", "2024-01-01T10:00:00Z")

def test_rca_naive_datetime_treated_as_utc():
    # The UI's datetime-local input sends no offset (F-06); until it does, naive means UTC.
    rca = _rca("2024-01-01T10:00", "2024-01-01T11:00")
    assert rca.incident_start == datetime(2024, 1, 1, 10, 0, tzinfo=timezone.utc)

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