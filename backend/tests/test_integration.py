"""Integration tests: full incident lifecycle through the API."""
import pytest

from app.db.postgres import AsyncSessionLocal
from app.models.schemas import WorkItemCreate
from app.services.work_item_service import create_work_item

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]

RCA = {
    "incident_start": "2024-01-01T10:00:00Z",
    "incident_end": "2024-01-01T12:00:00Z",
    "root_cause_category": "Infrastructure Failure",
    "fix_applied": "Restarted node",
    "prevention_steps": "Add health checks",
}


async def new_work_item(component: str, priority: str = "P2") -> str:
    async with AsyncSessionLocal() as db:
        wi_id = await create_work_item(WorkItemCreate(component=component, priority=priority, title=component), db)
        await db.commit()
    return wi_id


async def move(client, headers, wi_id, *statuses):
    for status in statuses:
        r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": status}, headers=headers)
        assert r.status_code == 200, r.text


async def test_health_endpoint(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert "status" in r.json()
    assert "queue_depth" in r.json()


async def test_full_incident_flow(client, make_headers):
    headers = await make_headers("sre")
    r = await client.post("/api/signals", json={
        "component_id": "RDBMS_PRIMARY", "signal_type": "ERROR", "message": "DB down", "severity": "CRITICAL",
    }, headers=headers)
    assert r.status_code == 202

    r = await client.get("/api/work-items", headers=headers)
    assert r.status_code == 200


async def test_close_without_rca_rejected(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await new_work_item("TEST")
    await move(client, headers, wi_id, "INVESTIGATING", "RESOLVED")

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "CLOSED"}, headers=headers)
    assert r.status_code == 422
    assert "RCA" in r.json()["detail"]


async def test_close_with_rca_succeeds(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await new_work_item("TEST_FULL", "P1")
    await move(client, headers, wi_id, "INVESTIGATING", "RESOLVED")

    r = await client.post(f"/api/work-items/{wi_id}/rca", json=RCA, headers=headers)
    assert r.status_code == 200
    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "CLOSED"}, headers=headers)
    assert r.status_code == 200
    assert r.json()["status"] == "CLOSED"
    assert r.json()["mttr_seconds"] is not None


async def test_comment_flow(client, make_headers):
    headers = await make_headers("sre")
    wi_id = await new_work_item("COMMENT_TEST", "P3")

    r = await client.post(f"/api/work-items/{wi_id}/comments", json={"body": "Investigating the issue"}, headers=headers)
    assert r.status_code == 201
    r = await client.get(f"/api/work-items/{wi_id}/comments", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) >= 1


async def test_viewer_cannot_change_status(client, make_headers):
    viewer = await make_headers("viewer")
    wi_id = await new_work_item("PERM_TEST", "P3")

    r = await client.patch(f"/api/work-items/{wi_id}/status", json={"new_status": "INVESTIGATING"}, headers=viewer)
    assert r.status_code == 403
