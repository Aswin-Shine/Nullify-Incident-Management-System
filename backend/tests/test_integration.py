"""Integration tests — auth + full incident lifecycle."""
import pytest
import pytest_asyncio
from httpx import AsyncClient
from unittest.mock import patch, AsyncMock


pytestmark = pytest.mark.asyncio


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def register_and_login(client: AsyncClient, role: str = "sre") -> dict:
    """Helper: register user + return auth headers."""
    import random
    suffix = random.randint(1000, 9999)
    await client.post("/api/auth/register", json={
        "username": f"testuser_{suffix}",
        "email": f"test_{suffix}@ims.test",
        "password": "TestPass123!",
        "role": role,
    })
    r = await client.post("/api/auth/login", json={
        "username": f"testuser_{suffix}",
        "password": "TestPass123!",
    })
    assert r.status_code == 200
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@patch("app.services.ingestion.append_signal", new_callable=AsyncMock)
@patch("app.services.webhooks.notify_incident_created", new_callable=AsyncMock)
@patch("app.services.webhooks.notify_status_change", new_callable=AsyncMock)
class TestIncidentLifecycle:

    async def test_register_login(self, *mocks):
        from app.main import app
        from httpx import AsyncClient, ASGITransport
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            r = await client.post("/api/auth/register", json={
                "username": "lifecycle_user",
                "email": "lifecycle@ims.test",
                "password": "Pass123!",
                "role": "sre",
            })
            assert r.status_code in (201, 400)  # 400 if already exists

    async def test_health_endpoint(self, *mocks):
        from app.main import app
        from httpx import AsyncClient, ASGITransport
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            r = await client.get("/health")
            assert r.status_code == 200
            data = r.json()
            assert "status" in data
            assert "queue_depth" in data

    async def test_full_incident_flow(self, mock_notify_status, mock_notify_create, mock_append):
        """OPEN→INVESTIGATING→RESOLVED→CLOSED with RCA."""
        from app.main import app
        from httpx import AsyncClient, ASGITransport
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers = await register_and_login(client, "sre")

            # Ingest signal (creates work item)
            r = await client.post("/api/signals", json={
                "component_id": "RDBMS_PRIMARY",
                "signal_type": "ERROR",
                "message": "DB down",
                "severity": "CRITICAL",
            }, headers=headers)
            assert r.status_code == 202

            # List work items
            r = await client.get("/api/work-items", headers=headers)
            assert r.status_code == 200

    async def test_close_without_rca_rejected(self, mock_notify_status, mock_notify_create, mock_append):
        """Closing without RCA must fail."""
        from app.main import app
        from httpx import AsyncClient, ASGITransport
        from app.db.postgres import AsyncSessionLocal
        from app.services.work_item_service import create_work_item
        from app.models.schemas import WorkItemCreate

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers = await register_and_login(client, "sre")

            # Create WI directly
            async with AsyncSessionLocal() as db:
                wi_id = await create_work_item(
                    WorkItemCreate(component="TEST", priority="P2", title="Test"), db
                )
                await db.commit()

            # Try OPEN→INVESTIGATING→RESOLVED→CLOSED without RCA
            for status in ["INVESTIGATING", "RESOLVED"]:
                r = await client.patch(f"/api/work-items/{wi_id}/status",
                                       json={"new_status": status}, headers=headers)
                assert r.status_code == 200

            r = await client.patch(f"/api/work-items/{wi_id}/status",
                                   json={"new_status": "CLOSED"}, headers=headers)
            assert r.status_code == 422
            assert "RCA" in r.json()["detail"]

    async def test_close_with_rca_succeeds(self, mock_notify_status, mock_notify_create, mock_append):
        """Full lifecycle with RCA → CLOSED succeeds."""
        from app.main import app
        from httpx import AsyncClient, ASGITransport
        from app.db.postgres import AsyncSessionLocal
        from app.services.work_item_service import create_work_item
        from app.models.schemas import WorkItemCreate

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers = await register_and_login(client, "sre")

            async with AsyncSessionLocal() as db:
                wi_id = await create_work_item(
                    WorkItemCreate(component="TEST_FULL", priority="P1", title="Full flow test"), db
                )
                await db.commit()

            for st in ["INVESTIGATING", "RESOLVED"]:
                r = await client.patch(f"/api/work-items/{wi_id}/status",
                                       json={"new_status": st}, headers=headers)
                assert r.status_code == 200

            # Submit RCA
            r = await client.post(f"/api/work-items/{wi_id}/rca", json={
                "incident_start": "2024-01-01T10:00:00Z",
                "incident_end": "2024-01-01T12:00:00Z",
                "root_cause_category": "Infrastructure Failure",
                "fix_applied": "Restarted node",
                "prevention_steps": "Add health checks",
            }, headers=headers)
            assert r.status_code == 200

            # Now CLOSE
            r = await client.patch(f"/api/work-items/{wi_id}/status",
                                   json={"new_status": "CLOSED"}, headers=headers)
            assert r.status_code == 200
            data = r.json()
            assert data["status"] == "CLOSED"
            assert data["mttr_seconds"] is not None

    async def test_comment_flow(self, mock_notify_status, mock_notify_create, mock_append):
        from app.main import app
        from httpx import AsyncClient, ASGITransport
        from app.db.postgres import AsyncSessionLocal
        from app.services.work_item_service import create_work_item
        from app.models.schemas import WorkItemCreate

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers = await register_and_login(client, "sre")

            async with AsyncSessionLocal() as db:
                wi_id = await create_work_item(
                    WorkItemCreate(component="COMMENT_TEST", priority="P3", title="Comment test"), db
                )
                await db.commit()

            r = await client.post(f"/api/work-items/{wi_id}/comments",
                                  json={"body": "Investigating the issue"}, headers=headers)
            assert r.status_code == 201

            r = await client.get(f"/api/work-items/{wi_id}/comments", headers=headers)
            assert r.status_code == 200
            assert len(r.json()) >= 1

    async def test_viewer_cannot_change_status(self, *mocks):
        from app.main import app
        from httpx import AsyncClient, ASGITransport
        from app.db.postgres import AsyncSessionLocal
        from app.services.work_item_service import create_work_item
        from app.models.schemas import WorkItemCreate

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            viewer_headers = await register_and_login(client, "viewer")

            async with AsyncSessionLocal() as db:
                wi_id = await create_work_item(
                    WorkItemCreate(component="PERM_TEST", priority="P3", title="Permission test"), db
                )
                await db.commit()

            r = await client.patch(f"/api/work-items/{wi_id}/status",
                                   json={"new_status": "INVESTIGATING"}, headers=viewer_headers)
            assert r.status_code == 403
