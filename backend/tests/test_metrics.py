"""App metrics (nullify_*): what Prometheus scrapes for the dashboards and alert rules (PRD OPS-2)."""
import asyncio
from unittest.mock import patch

import pytest
from prometheus_client import REGISTRY
from sqlalchemy.exc import OperationalError

from app.core import metrics
from app.services import ingestion
from app.services.ingestion import process_signal

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]


def value(name, **labels):
    return REGISTRY.get_sample_value(name, labels) or 0.0


def sig(component="CACHE_M", severity="HIGH"):
    return {"component_id": component, "signal_type": "ERROR", "message": "down", "severity": severity, "metadata": {}}


async def test_accepted_signals_are_counted_and_the_queue_depth_follows():
    before = value("nullify_signals_received_total")
    assert await ingestion.enqueue_signal(sig())
    assert await ingestion.enqueue_signal(sig())
    assert value("nullify_signals_received_total") == before + 2
    assert value("nullify_ingest_queue_depth") == 2


async def test_a_full_queue_counts_the_dropped_signal():
    before = value("nullify_signals_rejected_total", reason="queue_full")
    with patch.object(ingestion, "_queue", asyncio.Queue(maxsize=1)):
        assert await ingestion.enqueue_signal(sig())
        assert not await ingestion.enqueue_signal(sig())
    assert value("nullify_signals_rejected_total", reason="queue_full") == before + 1


async def test_processing_counts_outcomes_times_them_and_counts_new_incidents():
    ok, failed = value("nullify_signals_processed_total", outcome="ok"), value("nullify_signals_processed_total", outcome="failed")
    timed = value("nullify_signal_processing_seconds_count")
    created = value("nullify_incidents_created_total", priority="P2")

    await process_signal(sig("CACHE_M"))  # a cache component opens a P2
    await process_signal(sig("CACHE_M"))  # the same incident: not a new one

    assert value("nullify_signals_processed_total", outcome="ok") == ok + 2
    assert value("nullify_signal_processing_seconds_count") == timed + 2
    assert value("nullify_incidents_created_total", priority="P2") == created + 1

    with patch("app.services.ingestion._persist", side_effect=OperationalError("x", {}, Exception("db down"))), \
         patch("app.services.ingestion.settings.db_retry_attempts", 1):
        await process_signal(sig("CACHE_N"))
    assert value("nullify_signals_processed_total", outcome="failed") == failed + 1


async def test_db_retries_are_counted():
    from app.db.retry import with_db_retry
    before = value("nullify_db_retries_total")
    calls = []

    async def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise OperationalError("x", {}, Exception("connection lost"))
        return "done"

    assert await with_db_retry(flaky, attempts=3, base_delay=0) == "done"
    assert value("nullify_db_retries_total") == before + 2


async def test_transitions_are_counted_by_target_status_and_a_rejected_one_is_not(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await process_signal(sig("CACHE_T"))
    before = value("nullify_incident_transitions_total", to="INVESTIGATING")
    closed = value("nullify_incident_transitions_total", to="CLOSED")

    assert (await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=headers)).status_code == 200
    assert (await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "CLOSED"}, headers=headers)).status_code in (400, 409, 422)

    assert value("nullify_incident_transitions_total", to="INVESTIGATING") == before + 1
    assert value("nullify_incident_transitions_total", to="CLOSED") == closed


async def test_open_incidents_gauge_is_refreshed_from_the_database():
    await process_signal(sig("CACHE_O1"))                        # P2
    await process_signal(sig("RDBMS_O2", severity="CRITICAL"))   # P0

    await metrics.refresh_open_incidents()

    assert value("nullify_open_incidents", priority="P0") == 1
    assert value("nullify_open_incidents", priority="P2") == 1
    assert value("nullify_open_incidents", priority="P1") == 0  # empty priorities read 0, not missing


async def test_websocket_connections_gauge_tracks_register_and_disconnect():
    from app.services.ws_manager import manager

    before = value("nullify_websocket_connections")
    ws = object()
    await manager.register(ws)
    assert value("nullify_websocket_connections") == before + 1
    await manager.disconnect(ws)
    await manager.disconnect(ws)  # a second disconnect of the same socket must not go below
    assert value("nullify_websocket_connections") == before


async def test_metrics_endpoint_exposes_every_app_metric(client):
    await metrics.refresh_open_incidents()
    body = (await client.get("/metrics")).text
    for name in ("nullify_signals_received_total", "nullify_signals_rejected_total", "nullify_signals_processed_total",
                 "nullify_signal_processing_seconds", "nullify_ingest_queue_depth", "nullify_ingest_queue_capacity",
                 "nullify_incidents_created_total", "nullify_incident_transitions_total", "nullify_open_incidents",
                 "nullify_websocket_connections", "nullify_db_retries_total"):
        assert name in body, name
